/**
 * js-optimizer
 *
 * A modular, pass-based source optimizer built on acorn + escodegen.
 *
 * Passes (all enabled by default, each independently flag-controlled):
 *
 *   hoistLoopLength         — cache arr.length before for-loops; use !== and ++i
 *   promoteConst            — promote let → const where never reassigned
 *   forEachToForLoop        — convert .forEach(cb) to guarded const-length for loops
 *   forOfToForLoop          — convert for…of over arrays to guarded indexed for loops
 *   hoistLoopInvariants     — hoist loop-invariant declarations (regex, literals) above loops
 *   hoistFunctionInvariants — hoist invariant declarations (regex, literals) out of functions
 *
 * Usage:
 *   const { optimize } = require("./optimizer");
 *
 *   // All passes on (default):
 *   optimize(source);
 *
 *   // Only const promotion:
 *   optimize(source, { hoistLoopLength: false, forEachToForLoop: false });
 *
 *   // Silence log output:
 *   optimize(source, { verbose: false });
 *
 * Install deps:
 *   npm install acorn acorn-walk escodegen
 */

"use strict";

const acorn = require("acorn");
const walk = require("acorn-walk");
const escodegen = require("escodegen");

// ─── Generic AST Helpers ─────────────────────────────────────────────────────

/**
 * Given a parent node that can contain a statement list, return that list.
 * Handles Program, BlockStatement, and SwitchCase.
 */
function getBodyArray(parent) {
  if (!parent) return null;
  if (parent.type === "Program") return parent.body;
  if (parent.type === "BlockStatement") return parent.body;
  if (parent.type === "SwitchCase") return parent.consequent;
  return null;
}

/**
 * Converts a non-computed MemberExpression chain to a dot-path string.
 *   node.properties → "node.properties"
 *   arr             → "arr"
 * Returns null if any part of the chain is computed (e.g. foo["bar"]).
 */
function memberExprToString(node) {
  if (node.type === "Identifier") return node.name;
  if (node.type !== "MemberExpression") return null;
  if (node.computed) return null;
  const obj = memberExprToString(node.object);
  if (obj === null) return null;
  return `${obj}.${node.property.name}`;
}

/** "node.properties" → "node_properties_length",  "arr" → "arr_length" */
function pathToCacheName(dotPath) {
  return dotPath.replace(/\./g, "_") + "_length";
}

/** "node.properties" → "node_properties_bound",  "arr" → "arr_bound" */
function pathToBoundName(dotPath) {
  return dotPath.replace(/\./g, "_") + "_bound";
}

/**
 * Collect every Identifier name reachable from `node` into a Set.
 * Useful for detecting potential name collisions before injecting new bindings.
 */
function collectIdentifiers(node) {
  const names = new Set();
  walk.simple(node, {
    Identifier(n) {
      names.add(n.name);
    },
    LabeledStatement(n) {
      names.add(n.label.name);
    },
    BreakStatement(n) {
      if (n.label) names.add(n.label.name);
    },
    ContinueStatement(n) {
      if (n.label) names.add(n.label.name);
    },
  });
  return names;
}

/**
 * Given a preferred name and a Set of already-used names, return a name
 * guaranteed not to collide.  Appends $2, $3, … if needed.
 *   uniqueName("items_length", used)  →  "items_length" or "items_length$2" …
 */
function uniqueName(base, usedNames) {
  if (!usedNames.has(base)) return base;
  let n = 2;
  while (usedNames.has(`${base}$${n}`)) n++;
  return `${base}$${n}`;
}

/**
 * Deep-clone an AST node so that the clone can be placed in a different tree
 * position without sharing object references with the original.
 */
function cloneNode(node) {
  return JSON.parse(JSON.stringify(node));
}

/**
 * Rename all references to `origName` → `newName` within the given body
 * array, but stop at function/arrow boundaries when the name is re-declared
 * (as a parameter or inner binding).  This prevents accidentally renaming
 * identically-named variables in nested scopes.
 */
function scopeAwareRename(bodyArray, origName, newName) {
  function visit(n) {
    if (!n) return;
    if (n.type === "Identifier" && n.name === origName) {
      n.name = newName;
      return;
    }
    // Stop at function boundaries if they re-declare the name
    if (
      n.type === "FunctionDeclaration" ||
      n.type === "FunctionExpression" ||
      n.type === "ArrowFunctionExpression"
    ) {
      const paramNames = new Set((n.params || []).flatMap((p) => collectPatternNames(p)));
      if (paramNames.has(origName)) return; // shadowed by param — stop
      // Check for var/let/const declarations of the same name in the body
      if (n.body) {
        const innerDecls = collectDeclaredNames(n.body);
        if (innerDecls.has(origName)) return; // re-declared — stop
      }
    }
    // For shorthand properties like { x }, decouple key from value before
    // renaming so the property name is preserved: { x } → { x: newName }
    if (n.type === "Property" && n.shorthand &&
      n.value?.type === "Identifier" && n.value.name === origName) {
      n.shorthand = false;
      n.key = {
        type: "Identifier",
        name: origName
      };
    }
    for (const key of Object.keys(n)) {
      if (key === "type" || key === "loc" || key === "start" || key === "end") continue;
      // Skip non-computed member property names (not variable references)
      if (n.type === "MemberExpression" && !n.computed && key === "property") continue;
      // Skip non-computed property keys in object literals / class methods
      if ((n.type === "Property" || n.type === "MethodDefinition") && !n.computed && key === "key") continue;
      // Skip label identifiers (labels have their own namespace, not variable references)
      if ((n.type === "LabeledStatement" || n.type === "BreakStatement" || n.type === "ContinueStatement") && key === "label") continue;
      const child = n[key];
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === "object" && child.type) visit(child);
    }
  }

  bodyArray.forEach(visit);
}

/**
 * Collect names that are declared (VariableDeclaration) within a node,
 * without descending into nested functions.  Used by scopeAwareRename
 * to detect inner-scope shadowing.
 */
function collectDeclaredNames(node) {
  const names = new Set();
  if (!node || typeof node !== "object") return names;

  function visit(n) {
    if (!n || typeof n !== "object") return;
    if (n.type === "VariableDeclaration") {
      n.declarations.forEach((d) =>
        collectPatternNames(d.id).forEach((name) => names.add(name))
      );
    }
    if (
      n.type === "FunctionDeclaration" ||
      n.type === "FunctionExpression" ||
      n.type === "ArrowFunctionExpression"
    ) return;
    for (const key of Object.keys(n)) {
      if (key === "type" || key === "loc" || key === "start" || key === "end") continue;
      const child = n[key];
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === "object" && child.type) visit(child);
    }
  }

  visit(node);
  return names;
}

// ─── Numeric / Length Helpers ────────────────────────────────────────────────

/**
 * Returns true if `node` is a numeric literal, including negative literals
 * expressed as UnaryExpression(-, Literal).
 *   0, 1, -1, 42  → true
 */
function isNumericLiteral(node) {
  if (!node) return false;
  if (node.type === "Literal" && typeof node.value === "number") return true;
  if (
    node.type === "UnaryExpression" &&
    node.operator === "-" &&
    node.argument?.type === "Literal" &&
    typeof node.argument.value === "number"
  ) return true;
  return false;
}

/** Extract the numeric value from a literal or negated literal. */
function numericValue(node) {
  if (node.type === "Literal") return node.value;
  // UnaryExpression "-"
  return -node.argument.value;
}

/**
 * Returns true if `node` (the RHS of a for-loop test) contains a
 * non-computed `.length` member access somewhere in the expression tree.
 * Handles plain `arr.length` as well as `arr.length - 1`, `arr.length + 2`, etc.
 */
function containsLengthAccess(node) {
  if (!node) return false;
  if (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.property?.name === "length"
  ) return true;
  if (node.type === "BinaryExpression") {
    return containsLengthAccess(node.left) || containsLengthAccess(node.right);
  }
  return false;
}

/**
 * Extracts the dot-path of the object whose `.length` is referenced.
 * For `data.length`       → "data"
 * For `data.length - 1`   → "data"     (finds the .length in the subtree)
 * Returns null if no clean path can be determined.
 */
function extractLengthBasePath(node) {
  if (!node) return null;
  if (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.property?.name === "length"
  ) return memberExprToString(node.object);
  if (node.type === "BinaryExpression") {
    return extractLengthBasePath(node.left) ?? extractLengthBasePath(node.right);
  }
  return null;
}

// ─── Scope-Analysis Helpers ──────────────────────────────────────────────────

/**
 * Recursively collects all identifier names bound by a binding pattern.
 *   let x              → ["x"]
 *   let { a, b }       → ["a", "b"]
 *   let [p, , q]       → ["p", "q"]
 *   let { a: { b } }   → ["b"]
 *   let { x = 1 }      → ["x"]   (AssignmentPattern default)
 *   let { ...rest }    → ["rest"]
 */
function collectPatternNames(node, out = []) {
  if (!node) return out;
  switch (node.type) {
    case "Identifier":
      out.push(node.name);
      break;
    case "ObjectPattern":
      node.properties.forEach((p) =>
        collectPatternNames(p.type === "RestElement" ? p.argument : p.value, out)
      );
      break;
    case "ArrayPattern":
      node.elements.forEach((el) => collectPatternNames(el, out));
      break;
    case "AssignmentPattern":
      collectPatternNames(node.left, out);
      break;
    case "RestElement":
      collectPatternNames(node.argument, out);
      break;
  }
  return out;
}

/**
 * Returns true if any name in nameSet is the target of a mutation anywhere
 * within scopeRoot.
 *
 * Conservative re shadowing: if an inner scope re-declares "x" and then
 * assigns to it, we still report a hit. This means we skip some safe
 * promotions, but we never incorrectly promote a mutable binding.
 *
 * Mutations caught:
 *   x = 1 / x += 1 / x &&= f()   AssignmentExpression
 *   x++ / --x                      UpdateExpression
 *   for (x of …) / for (x in …)   bare (non-declaration) LHS
 */
function isReassigned(scopeRoot, nameSet) {
  let found = false;

  walk.simple(scopeRoot, {
    AssignmentExpression(node) {
      if (found) return;
      collectPatternNames(node.left).forEach((n) => {
        if (nameSet.has(n)) found = true;
      });
    },
    UpdateExpression(node) {
      if (found) return;
      if (node.argument?.type === "Identifier" && nameSet.has(node.argument.name))
        found = true;
    },
    ForOfStatement(node) {
      if (found || node.left.type === "VariableDeclaration") return;
      collectPatternNames(node.left).forEach((n) => {
        if (nameSet.has(n)) found = true;
      });
    },
    ForInStatement(node) {
      if (found || node.left.type === "VariableDeclaration") return;
      collectPatternNames(node.left).forEach((n) => {
        if (nameSet.has(n)) found = true;
      });
    },
  });

  return found;
}

/**
 * Returns the scope root node appropriate for the given declaration kind:
 *   var → nearest enclosing function or Program  (matches JS hoisting rules)
 *   let → nearest enclosing block, SwitchCase, or Program
 */
function findScopeRoot(ancestors, kind) {
  const fnTypes = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
  const blockTypes = new Set(["BlockStatement", "Program", "SwitchCase"]);
  const targets = kind === "var" ? new Set([...fnTypes, "Program"]) : blockTypes;

  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (targets.has(ancestors[i].type)) return ancestors[i];
  }
  return null;
}

// ─── forEach-Specific Helpers ────────────────────────────────────────────────

/**
 * Returns true if the subtree rooted at `node` contains a ThisExpression or a
 * reference to the `arguments` identifier, WITHOUT descending into nested
 * non-arrow function bodies (they have their own `this`/`arguments`).
 *
 * Used to decide whether a FunctionExpression forEach callback is safe to
 * lift into a for…of.  Arrow callbacks are always safe: they inherit both
 * `this` and `arguments` lexically, so those bindings survive the transform.
 */
function containsThisOrArguments(node) {
  let found = false;

  function visit(n) {
    if (!n || found) return;
    if (n.type === "ThisExpression") {
      found = true;
      return;
    }
    if (n.type === "Identifier" && n.name === "arguments") {
      found = true;
      return;
    }
    // Stop at nested non-arrow functions — their bindings are unrelated.
    if (n.type === "FunctionDeclaration" || n.type === "FunctionExpression") return;
    for (const key of Object.keys(n)) {
      if (key === "type" || key === "loc" || key === "start" || key === "end") continue;
      const child = n[key];
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === "object" && child.type) visit(child);
    }
  }

  visit(node);
  return found;
}

/**
 * Returns true if the body (a BlockStatement) contains any nested loop
 * statement (for/while/do-while/for-in/for-of).  When it does, the
 * forEach-replacement for-loop needs a label so that rewritten
 * `return` → `continue <label>` targets the outer loop correctly.
 */
function containsNestedLoop(node) {
  const loopTypes = new Set([
    "ForStatement", "ForInStatement", "ForOfStatement",
    "WhileStatement", "DoWhileStatement",
  ]);
  let found = false;

  function visit(n) {
    if (!n || found) return;
    if (loopTypes.has(n.type)) {
      found = true;
      return;
    }
    // Stop at nested functions — their loops are unrelated.
    if (n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression") return;
    for (const key of Object.keys(n)) {
      if (key === "type" || key === "loc" || key === "start" || key === "end") continue;
      const child = n[key];
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === "object" && child.type) visit(child);
    }
  }

  visit(node);
  return found;
}

/**
 * Generates a unique loop variable name (e.g. "_i", "_i$2", "_i$3", …) that
 * does not collide with any identifier already present in the given AST node.
 */
function uniqueLoopVar(bodyNode) {
  return uniqueName("_i", collectIdentifiers(bodyNode));
}

/**
 * Returns a new BlockStatement where every ReturnStatement owned by this
 * function level is replaced with a ContinueStatement (or a block that
 * first evaluates the return expression then continues).
 *
 * Semantically correct because `return` in a forEach callback means "stop
 * this iteration" — exactly what `continue` does in a for…of.
 *
 * Does NOT descend into FunctionDeclaration / FunctionExpression /
 * ArrowFunctionExpression bodies (their returns are their own). DOES
 * descend into control-flow constructs (if/switch/try/nested loops) since
 * returns inside those still target the enclosing callback.
 *
 * When a label is provided, emits `continue <label>` instead of bare
 * `continue` so the continue targets the outer forEach-replacement loop
 * even when the return was inside a nested inner loop.
 */
function rewriteReturns(blockNode, label) {
  const continueLabel = label ? {
    type: "Identifier",
    name: label
  } : null;

  function stmt(s) {
    if (!s) return s;
    switch (s.type) {

      case "ReturnStatement":
        if (!s.argument) {
          // return;  →  continue [label];
          return {
            type: "ContinueStatement",
            label: continueLabel
          };
        }
        // return expr;  →  { expr; continue [label]; }
        // Keeps any side-effects in the original expression.
        return {
          type: "BlockStatement",
            body: [{
                type: "ExpressionStatement",
                expression: s.argument
              },
              {
                type: "ContinueStatement",
                label: continueLabel
              },
            ],
        };

      case "BlockStatement":
        return {
          ...s, body: s.body.map(stmt)
        };

      case "IfStatement":
        return {
          ...s, consequent: stmt(s.consequent), alternate: s.alternate ? stmt(s.alternate) : null
        };

        // Nested loops: returns still target the callback, so we must
        // descend — but `continue` must use a label to target the outer
        // forEach-replacement loop, not these inner loops.
      case "ForStatement":
      case "ForInStatement":
      case "ForOfStatement":
      case "WhileStatement":
      case "DoWhileStatement":
        return {
          ...s, body: stmt(s.body)
        };

      case "LabeledStatement":
        return {
          ...s, body: stmt(s.body)
        };

      case "TryStatement":
        return {
          ...s,
          block: stmt(s.block),
            handler: s.handler ? {
              ...s.handler,
              body: stmt(s.handler.body)
            } : null,
            finalizer: s.finalizer ? stmt(s.finalizer) : null,
        };

      case "SwitchStatement":
        return {
          ...s,
          cases: s.cases.map((c) => ({
            ...c,
            consequent: c.consequent.map(stmt)
          })),
        };

        // Nested function bodies own their returns — leave untouched.
        // Arrow functions also own their own returns.
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        return s;

      default:
        return s;
    }
  }

  return {
    ...blockNode,
    body: blockNode.body.map(stmt)
  };
}

// ─── Array-Mutation Detection ────────────────────────────────────────────────

/**
 * Methods that mutate an array's length or element order.
 * If any of these are called on the array whose .length we're caching,
 * caching the length is unsafe (the loop might overrun or under-run).
 */
const MUTATING_METHODS = new Set([
  "push", "pop", "shift", "unshift", "splice",
  "fill", "copyWithin", "reverse", "sort",
]);

/**
 * Returns true if the array identified by `arrayPath` (a dot-separated
 * string like "arr" or "this.items") is potentially mutated inside `body`.
 *
 * Mutations detected:
 *   • arr.push(…), arr.splice(…), etc.     — mutating method calls
 *   • arr.length = …                        — direct length assignment
 *   • arr = …                               — reassignment of the identifier
 *   • arr[i] = …  is NOT flagged (doesn't change .length)
 */
function isArrayMutatedInBody(arrayPath, body) {
  let found = false;

  walk.simple(body, {
    CallExpression(node) {
      if (found) return;
      const c = node.callee;
      if (c?.type !== "MemberExpression" || c.computed) return;
      if (MUTATING_METHODS.has(c.property?.name)) {
        const objPath = memberExprToString(c.object);
        if (objPath === arrayPath) found = true;
      }
    },
    AssignmentExpression(node) {
      if (found) return;
      // arr.length = N
      if (node.left?.type === "MemberExpression" &&
        !node.left.computed &&
        node.left.property?.name === "length") {
        const objPath = memberExprToString(node.left.object);
        if (objPath === arrayPath) found = true;
      }
      // arr = newValue  (reassignment of the array itself)
      if (node.left?.type === "Identifier" && node.left.name === arrayPath) {
        found = true;
      }
    },
  });

  return found;
}

// ─── AST Builders ────────────────────────────────────────────────────────────

/** const <cacheName> = <lengthNode> || 0; */
function buildCacheDeclaration(cacheName, lengthNode) {
  return {
    type: "VariableDeclaration",
    kind: "const",
    declarations: [{
      type: "VariableDeclarator",
      id: {
        type: "Identifier",
        name: cacheName
      },
      init: {
        type: "LogicalExpression",
        operator: "||",
        left: lengthNode,
        right: {
          type: "Literal",
          value: 0,
          raw: "0"
        },
      },
    }],
  };
}

/** i !== cacheName */
function buildStrictTest(iteratorName, cacheName) {
  return {
    type: "BinaryExpression",
    operator: "!==",
    left: {
      type: "Identifier",
      name: iteratorName
    },
    right: {
      type: "Identifier",
      name: cacheName
    },
  };
}

/** ++i */
function buildPrefixIncrement(iteratorName) {
  return {
    type: "UpdateExpression",
    operator: "++",
    prefix: true,
    argument: {
      type: "Identifier",
      name: iteratorName
    },
  };
}

// ─── Pass: hoistLoopLength ───────────────────────────────────────────────────

/**
 * Matches for-loops whose test compares the iterator against an expression
 * that involves <expr>.length (possibly with arithmetic, e.g. `data.length - 1`).
 *
 * Canonical form:
 *   for (let|var i = 0; i < <expr>.length; i++)         →  !== + ++i
 *   for (i = 0;         i < <expr>.length; i++)         →  !== + ++i
 *
 * Generalised forms (operator and init preserved):
 *   for (let k = 1;  k <= data.length;     k++)         →  cache + ++k
 *   for (let k = -1; k <= data.length - 1; k++)         →  cache + ++k
 *
 * Emits:    const <cache> = <lengthExpr> || 0;
 *           for (…; i {op} <cache>; ++i) { … }
 *
 * The !== optimisation is only applied for the canonical (init=0, op=<) case.
 */
function passHoistLoopLength(ast) {
  const reports = [];
  const insertions = []; // deferred: { bodyArray, index, declaration }

  walk.ancestor(ast, {
    ForStatement(node, ancestors) {

      // ── test: i {<,<=} <expr-involving-.length> ──
      // Check test and update first to learn the iterator name, then
      // validate it appears in the init.
      const test = node.test;
      if (test?.type !== "BinaryExpression") return;
      if (test.operator !== "<" && test.operator !== "<=") return;
      if (test.left?.type !== "Identifier") return;
      if (!containsLengthAccess(test.right)) return;

      const iteratorName = test.left.name;

      // ── update: i++ ──
      const upd = node.update;
      if (upd?.type !== "UpdateExpression") return;
      if (upd.operator !== "++") return;
      if (upd.argument?.type !== "Identifier") return;
      if (upd.argument.name !== iteratorName) return;

      // ── init: must contain the iterator set to a numeric literal ──
      const init = node.init;
      let initLabel, initValue;

      if (init?.type === "VariableDeclaration") {
        if (init.kind !== "let" && init.kind !== "var") return;
        // Find the declarator that matches the iterator name
        const decl = init.declarations.find(
          (d) => d.id?.type === "Identifier" && d.id.name === iteratorName
        );
        if (!decl) return;
        if (!isNumericLiteral(decl.init)) return;
        initValue = numericValue(decl.init);
        initLabel = `${init.kind} ${iteratorName}`;
      } else if (
        init?.type === "AssignmentExpression" &&
        init.operator === "=" &&
        init.left?.type === "Identifier" &&
        init.left.name === iteratorName &&
        isNumericLiteral(init.right)
      ) {
        initValue = numericValue(init.right);
        initLabel = iteratorName;
      } else if (
        init?.type === "SequenceExpression"
      ) {
        // Handle comma expressions: (a = [], i = 0)
        const assign = init.expressions.find(
          (e) => e.type === "AssignmentExpression" &&
          e.operator === "=" &&
          e.left?.type === "Identifier" &&
          e.left.name === iteratorName &&
          isNumericLiteral(e.right)
        );
        if (!assign) return;
        initValue = numericValue(assign.right);
        initLabel = iteratorName;
      } else {
        return;
      }

      const arrayPath = extractLengthBasePath(test.right);

      // ── Safety: bail when there's no stable path for the array ──
      // This happens when the .length base is a function call (e.g. getRow().length)
      // or a computed/dynamic member (e.g. matrix[i].length). In both cases we
      // cannot verify mutation safety and the expression may not be referentially
      // stable across iterations, so caching would change observable semantics.
      if (!arrayPath) return;

      // ── Safety: bail if the array is mutated inside the loop body ──
      // Caching .length is unsafe if push/pop/splice/etc. change it mid-loop.
      if (node.body && isArrayMutatedInBody(arrayPath, node.body)) return;

      // ── Transform ──
      // Choose cache name: plain `.length` → `arr_length`,
      // compound expression (e.g. `.length - 1`) → `arr_bound`.
      // Ensure the name doesn't collide with identifiers in the parent scope.
      const isPlainLength = test.right.type === "MemberExpression" &&
        !test.right.computed &&
        test.right.property?.name === "length";
      const baseName = isPlainLength ?
        pathToCacheName(arrayPath) :
        pathToBoundName(arrayPath);
      const scopeNode = ancestors[ancestors.length - 2] ?? ast;
      const cacheName = uniqueName(baseName, collectIdentifiers(scopeNode));
      const lengthNode = test.right; // capture before overwriting

      // Canonical case (init=0, op=<): safe to tighten to !==
      if (initValue === 0 && test.operator === "<") {
        node.test = buildStrictTest(iteratorName, cacheName);
      } else {
        node.test = {
          ...test,
          right: {
            type: "Identifier",
            name: cacheName
          }
        };
      }
      node.update = buildPrefixIncrement(iteratorName);

      // ancestors[-1] = ForStatement itself, ancestors[-2] = its parent
      const parent = ancestors[ancestors.length - 2];
      const bodyArray = getBodyArray(parent);
      if (bodyArray) {
        const idx = bodyArray.indexOf(node);
        if (idx !== -1)
          insertions.push({
            bodyArray,
            index: idx,
            declaration: buildCacheDeclaration(cacheName, lengthNode)
          });
      }

      const rhsLabel = escodegen.generate(lengthNode);
      reports.push(`  ✓ for(${initLabel}=${initValue}; … ${test.operator} ${rhsLabel}; …++) → uses ${cacheName}`);
    },
  });

  // Deduplicate: if the same cache name is inserted into the same block
  // more than once, only keep the first occurrence.
  const seenPerBlock = new Map(); // bodyArray → Set<cacheName>
  insertions.reverse().forEach(({
    bodyArray,
    index,
    declaration
  }) => {
    const cacheName = declaration.declarations[0].id.name;
    if (!seenPerBlock.has(bodyArray)) seenPerBlock.set(bodyArray, new Set());
    const seen = seenPerBlock.get(bodyArray);
    if (seen.has(cacheName)) return;
    seen.add(cacheName);
    bodyArray.splice(index, 0, declaration);
  });

  return reports;
}

// ─── Pass: promoteConst ──────────────────────────────────────────────────────

/**
 * Promotes let → const for any declaration where:
 *   1. Every declarator has an initializer   (const x; is a syntax error)
 *   2. It is NOT the init slot of a for-loop (i++ would then be illegal)
 *   3. No bound name is reassigned anywhere in the declaration's scope
 *
 * Only promotes `let`, not `var`, because `var` → `const` changes hoisting
 * and block-scoping semantics (code using var across blocks would break).
 */
function passPromoteConst(ast) {
  const reports = [];

  walk.ancestor(ast, {
    VariableDeclaration(node, ancestors) {
      if (node.kind === "const") return;
      if (node.kind !== "let") return; // skip var: promoting to const changes scope semantics
      if (node.declarations.some((d) => d.init == null)) return;

      // ancestors[-1] = this node, ancestors[-2] = its parent
      const parent = ancestors[ancestors.length - 2];
      if (parent?.type === "ForStatement" && parent.init === node) return;

      const names = new Set(node.declarations.flatMap((d) => collectPatternNames(d.id)));
      const scopeRoot = findScopeRoot(ancestors, node.kind);
      if (!scopeRoot) return;
      if (isReassigned(scopeRoot, names)) return;

      const oldKind = node.kind;
      node.kind = "const";
      reports.push(`  ✓ ${oldKind.padEnd(3)} → const  (${[...names].join(", ")})`);
    },
  });

  return reports;
}

// ─── Pass: forEachToForLoop ──────────────────────────────────────────────────

/**
 * Builds the AST node for `Symbol.iterator` (a MemberExpression).
 * Extracted as a helper because we need it in two places in the guard.
 */
function buildSymbolIterator() {
  return {
    type: "MemberExpression",
    object: {
      type: "Identifier",
      name: "Symbol"
    },
    property: {
      type: "Identifier",
      name: "iterator"
    },
    computed: false,
  };
}

/**
 * Builds:  <expr>[Symbol.iterator] === [][Symbol.iterator]
 *
 * This is true only when <expr> carries the native Array iterator, meaning
 * plain arrays and subclasses that haven't overridden it.  Any object with a
 * custom iterator (Map, Set, generator, custom iterable) returns false and
 * falls through to the original forEach call.
 */
function buildIteratorGuard(arrayExpr) {
  const symIter = buildSymbolIterator();
  return {
    type: "BinaryExpression",
    operator: "===",
    left: {
      type: "MemberExpression",
      computed: true,
      object: arrayExpr,
      property: symIter,
    },
    right: {
      type: "MemberExpression",
      computed: true,
      object: {
        type: "ArrayExpression",
        elements: []
      },
      property: buildSymbolIterator(), // fresh node — AST nodes must not be shared
    },
  };
}

/**
 * Builds the inner const-length for loop used in the fast path:
 *
 *   const <cacheName> = <arrayExpr>.length || 0;
 *   for (let <loopVar> = 0; <loopVar> !== <cacheName>; ++<loopVar>) {
 *     if (!(<loopVar> in <arrayExpr>)) continue;    // only when skipHoles=true
 *     const <itemParam> = <arrayExpr>[<loopVar>];
 *     …body…
 *   }
 *
 * When skipHoles is true (forEach replacement), sparse array holes are
 * skipped to match forEach's spec behavior.  When false (for-of
 * replacement), holes are visited as undefined (matching for-of semantics).
 */
function buildFastForLoop(arrayExpr, loopVar, itemParam, body, label, skipHoles = false) {
  const baseCacheName = pathToCacheName(memberExprToString(arrayExpr) ?? "_forEach");
  const cacheName = uniqueName(baseCacheName, collectIdentifiers(body));

  // Prepend: const <itemParam> = <arrayExpr>[<loopVar>];
  const itemDecl = {
    type: "VariableDeclaration",
    kind: "const",
    declarations: [{
      type: "VariableDeclarator",
      id: itemParam,
      init: {
        type: "MemberExpression",
        computed: true,
        object: arrayExpr,
        property: {
          type: "Identifier",
          name: loopVar
        },
      },
    }],
  };

  // When skipHoles is true, prepend:  if (!(loopVar in arrayExpr)) continue;
  // This matches forEach's spec behaviour of skipping sparse-array holes.
  const holeGuard = skipHoles ?
    {
      type: "IfStatement",
      test: {
        type: "UnaryExpression",
        operator: "!",
        prefix: true,
        argument: {
          type: "BinaryExpression",
          operator: "in",
          left: {
            type: "Identifier",
            name: loopVar
          },
          right: cloneNode(arrayExpr),
        },
      },
      consequent: {
        type: "ContinueStatement",
        label: null
      },
      alternate: null,
    } :
    null;

  const bodyStmts = [
    ...(holeGuard ? [holeGuard] : []),
    itemDecl,
    ...body.body,
  ];

  const loopBody = {
    ...body,
    body: bodyStmts
  };

  const forLoop = {
    type: "ForStatement",
    init: {
      type: "VariableDeclaration",
      kind: "let",
      declarations: [{
        type: "VariableDeclarator",
        id: {
          type: "Identifier",
          name: loopVar
        },
        init: {
          type: "Literal",
          value: 0,
          raw: "0"
        },
      }],
    },
    test: buildStrictTest(loopVar, cacheName),
    update: buildPrefixIncrement(loopVar),
    body: loopBody,
  };

  // If a label is provided, wrap the for-loop so labeled continue works
  // correctly when returns inside nested loops are rewritten.
  const loopNode = label ?
    {
      type: "LabeledStatement",
      label: {
        type: "Identifier",
        name: label
      },
      body: forLoop
    } :
    forLoop;

  return [
    buildCacheDeclaration(cacheName, {
      type: "MemberExpression",
      computed: false,
      object: arrayExpr,
      property: {
        type: "Identifier",
        name: "length"
      },
    }),
    loopNode,
  ];
}

/**
 * Converts  arr.forEach(cb)  call-expression statements to a guarded block:
 *
 *   if (arr[Symbol.iterator] === [][Symbol.iterator]) {
 *     const arr_length = arr.length || 0;
 *     for (let _i = 0; _i !== arr_length; ++_i) {
 *       const item = arr[_i];
 *       …body…
 *     }
 *   } else {
 *     arr.forEach(cb);   // original call — safe fallback for custom iterables
 *   }
 *
 * Two-param callbacks  (item, idx)  use  idx  as the loop variable directly
 * (it is already the index) and only declare  const item = arr[idx]  inside.
 *
 * Bails out when:
 *   • forEach has a thisArg second argument    (binding would change)
 *   • FunctionExpression callback uses `this` or `arguments`
 *   • Callback has 0 params or 3+ params
 *
 * `return` in the callback body is rewritten to `continue` (with any return
 * expression kept as a statement so side-effects are preserved).
 */
function passForEachToForLoop(ast) {
  const reports = [];
  const replacements = []; // deferred: { bodyArray, index, newNode }

  walk.ancestor(ast, {
    ExpressionStatement(node, ancestors) {
      const call = node.expression;

      // Shape: <expr>.forEach(<cb>)
      if (call?.type !== "CallExpression") return;
      if (call.callee?.type !== "MemberExpression") return;
      if (call.callee.computed) return;
      if (call.callee.property?.name !== "forEach") return;
      if (call.arguments.length !== 1) return; // thisArg unsupported

      const cb = call.arguments[0];
      if (cb.type !== "ArrowFunctionExpression" && cb.type !== "FunctionExpression") return;
      if (cb.type === "FunctionExpression" && containsThisOrArguments(cb.body)) return;

      const params = cb.params;
      if (params.length === 0 || params.length > 2) return;
      if (params.some((p) => p.type !== "Identifier")) return;

      const arrayExpr = call.callee.object;

      // Normalise expression-body arrow to block form
      const rawBody = cb.body.type === "BlockStatement" ?
        cb.body :
        {
          type: "BlockStatement",
          body: [{
            type: "ExpressionStatement",
            expression: cb.body
          }]
        };

      // Detect whether the body contains nested loops or returns; if so we
      // need a labeled outer loop so that rewritten continue targets it.
      const hasNestedLoop = containsNestedLoop(rawBody);
      const loopLabel = hasNestedLoop ?
        uniqueName("_forEach", collectIdentifiers(rawBody)) :
        null;
      const body = rewriteReturns(rawBody, loopLabel);

      // Decide loop variable name and item binding
      let loopVar, itemParam;
      if (params.length === 1) {
        loopVar = uniqueLoopVar(rawBody); // collision-safe counter
        itemParam = params[0]; // const <param> = arr[_i]
      } else {
        // (item, idx) — idx IS the index, so it becomes the loop variable
        const [itemP, idxP] = params;
        loopVar = idxP.name;
        itemParam = itemP; // const item = arr[idx]
      }

      // Fast path: const-length for loop
      // Clone arrayExpr so the fast path has its own AST nodes — sharing
      // the same object reference across two tree positions breaks walk.
      const fastStatements = buildFastForLoop(cloneNode(arrayExpr), loopVar, itemParam, body, loopLabel, /* skipHoles */ true);

      // Slow path: original forEach call (unchanged)
      const slowStatement = {
        type: "ExpressionStatement",
        expression: call
      };

      // Wrap in if/else guarded by the iterator check
      const ifNode = {
        type: "IfStatement",
        test: buildIteratorGuard(arrayExpr),
        consequent: {
          type: "BlockStatement",
          body: fastStatements
        },
        alternate: {
          type: "BlockStatement",
          body: [slowStatement]
        },
      };

      // ancestors[-1] = ExpressionStatement, ancestors[-2] = its parent
      const parent = ancestors[ancestors.length - 2];
      const bodyArray = getBodyArray(parent);
      if (!bodyArray) return;
      const idx = bodyArray.indexOf(node);
      if (idx === -1) return;

      replacements.push({
        bodyArray,
        index: idx,
        newNode: ifNode
      });

      const arrLabel = escodegen.generate(arrayExpr);
      const paramLabel = params.map((p) => escodegen.generate(p)).join(", ");
      reports.push(`  ✓ ${arrLabel}.forEach((${paramLabel}) => …) → guarded const-length for loop`);
    },
  });

  replacements.reverse().forEach(({
    bodyArray,
    index,
    newNode
  }) => {
    bodyArray.splice(index, 1, newNode);
  });

  return reports;
}

// ─── Pass: forOfToForLoop ────────────────────────────────────────────────────

/**
 * Converts:
 *   for (const item of arr) { …body… }
 *   for (let item of arr)   { …body… }
 *
 * Into a guarded indexed for-loop (same pattern as forEachToForLoop):
 *
 *   if (arr[Symbol.iterator] === [][Symbol.iterator]) {
 *     const arr_length = arr.length || 0;
 *     for (let _i = 0; _i !== arr_length; ++_i) {
 *       const item = arr[_i];
 *       …body…
 *     }
 *   } else {
 *     for (const item of arr) { …body… }   // original — safe fallback
 *   }
 *
 * Bails out when:
 *   • Iteration variable is a destructuring pattern (complex to replicate)
 *   • Declaration kind is `var` (hoisting semantics would differ)
 *   • Loop has no declaration (bare `for (x of arr)`)
 */
function passForOfToForLoop(ast) {
  const reports = [];
  const replacements = [];

  walk.ancestor(ast, {
    ForOfStatement(node, ancestors) {
      // Must be a variable declaration (const/let), not a bare assignment
      if (node.left.type !== "VariableDeclaration") return;
      const kind = node.left.kind;
      if (kind !== "const" && kind !== "let") return;
      if (node.left.declarations.length !== 1) return;

      const decl = node.left.declarations[0];
      // Only simple identifiers — bail on destructuring
      if (decl.id.type !== "Identifier") return;

      const itemName = decl.id.name;
      const arrayExpr = node.right;
      const body = node.body.type === "BlockStatement" ?
        node.body :
        {
          type: "BlockStatement",
          body: [node.body]
        };

      const loopVar = uniqueName("_i", collectIdentifiers(body));

      // Fast path: indexed for loop
      // Clone arrayExpr so the fast path has its own AST nodes — sharing
      // the same object reference across two tree positions breaks walk.
      const fastStatements = buildFastForLoop(
        cloneNode(arrayExpr),
        loopVar, {
          type: "Identifier",
          name: itemName
        },
        body,
        null // no label needed — for-of doesn't use rewriteReturns
      );

      // Slow path: original for-of (deep clone — shallow spread would share
      // left/right child nodes with the original, which is now in the fast path)
      const slowStatement = cloneNode(node);

      const ifNode = {
        type: "IfStatement",
        test: buildIteratorGuard(arrayExpr),
        consequent: {
          type: "BlockStatement",
          body: fastStatements
        },
        alternate: {
          type: "BlockStatement",
          body: [slowStatement]
        },
      };

      const parent = ancestors[ancestors.length - 2];
      const bodyArray = getBodyArray(parent);
      if (!bodyArray) return;
      const idx = bodyArray.indexOf(node);
      if (idx === -1) return;

      replacements.push({
        bodyArray,
        index: idx,
        newNode: ifNode
      });

      const arrLabel = escodegen.generate(arrayExpr);
      reports.push(`  ✓ for (${kind} ${itemName} of ${arrLabel}) → guarded indexed for loop`);
    },
  });

  replacements.reverse().forEach(({
    bodyArray,
    index,
    newNode
  }) => {
    bodyArray.splice(index, 1, newNode);
  });

  return reports;
}

// ─── Pass: hoistLoopInvariants ───────────────────────────────────────────────

/**
 * Returns a Set of identifier names that are mutated (assigned, updated, or
 * declared) within the given AST node.
 */
function collectMutatedNames(node) {
  const mutated = new Set();

  walk.simple(node, {
    AssignmentExpression(n) {
      collectPatternNames(n.left).forEach((name) => mutated.add(name));
    },
    UpdateExpression(n) {
      if (n.argument?.type === "Identifier") mutated.add(n.argument.name);
    },
    VariableDeclaration(n) {
      n.declarations.forEach((d) =>
        collectPatternNames(d.id).forEach((name) => mutated.add(name))
      );
    },
  });

  return mutated;
}

/**
 * Returns a Set of all free identifier names referenced by an expression.
 * Does NOT descend into nested function/arrow bodies.
 */
function collectFreeIdentifiers(node) {
  const names = new Set();

  function visit(n) {
    if (!n) return;
    if (n.type === "Identifier") {
      names.add(n.name);
      return;
    }
    if (n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression") return;
    for (const key of Object.keys(n)) {
      if (key === "type" || key === "loc" || key === "start" || key === "end") continue;
      const child = n[key];
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === "object" && child.type) visit(child);
    }
  }

  visit(node);
  return names;
}

/**
 * Returns true if the expression is "pure" enough to hoist — no side-effects,
 * no dependency on mutable state other than its free identifiers (which we
 * check against the mutated-name set separately).
 *
 * Safe to hoist:
 *   • Regex literals:                /pattern/flags
 *   • new RegExp(literal, literal):  new RegExp("pat", "gi")
 *   • Literal values
 *   • Template literals with no expressions
 *
 * NOT safe (side-effects or non-deterministic):
 *   • Function calls (except RegExp constructor with literal args)
 *   • Property accesses (getters)
 *   • Assignments
 */
function isHoistableExpression(node) {
  if (!node) return false;

  switch (node.type) {
    // /pattern/flags  — always safe
    case "Literal":
      return true;

      // new RegExp("pattern", "flags")  — safe when args are literals
    case "NewExpression":
      if (node.callee?.type === "Identifier" && node.callee.name === "RegExp") {
        return node.arguments.length >= 1 &&
          node.arguments.length <= 2 &&
          node.arguments.every((a) => a.type === "Literal");
      }
      return false;

      // `template` with no interpolation
    case "TemplateLiteral":
      return node.expressions.length === 0;

      // -1, +0, !true
    case "UnaryExpression":
      return isHoistableExpression(node.argument);

      // 1 + 2, "a" + "b"
    case "BinaryExpression":
      return isHoistableExpression(node.left) && isHoistableExpression(node.right);

    default:
      return false;
  }
}

/**
 * Hoists loop-invariant variable declarations out of loop bodies.
 *
 * A declaration  `const x = <expr>;`  inside a loop body is invariant when:
 *   1. <expr> is a hoistable expression (regex, literal, etc.)
 *   2. None of <expr>'s free identifiers are mutated inside the loop body
 *   3. The declaration is at the top level of the loop body (not nested
 *      inside an if/try/etc. where it might be conditionally executed)
 *
 * The declaration is moved to just before the loop statement.
 */
function passHoistLoopInvariants(ast) {
  const reports = [];
  const operations = []; // { bodyArray, loopIndex, stmtIndex, stmt, label }

  const loopTypes = new Set([
    "ForStatement", "ForInStatement", "ForOfStatement",
    "WhileStatement", "DoWhileStatement",
  ]);

  walk.ancestor(ast, {
    VariableDeclaration(node, ancestors) {
      if (node.kind !== "const" && node.kind !== "let") return;
      if (node.declarations.length !== 1) return;
      const decl = node.declarations[0];
      if (!decl.init) return;
      if (!isHoistableExpression(decl.init)) return;

      // Check that the declaration is a DIRECT child of a loop body.
      // ancestors: [..., loopNode, BlockStatement, thisNode]
      const directParent = ancestors[ancestors.length - 2];
      let loopNode = null;
      let loopAncestorIdx = -1;

      if (directParent?.type === "BlockStatement") {
        // The block's parent must be a loop whose .body IS this block
        const blockParentIdx = ancestors.length - 3;
        const blockParent = ancestors[blockParentIdx];
        if (blockParent && loopTypes.has(blockParent.type) && blockParent.body === directParent) {
          loopNode = blockParent;
          loopAncestorIdx = blockParentIdx;
        }
        // Otherwise the decl is inside an if/try/etc. — bail
      }
      // If directParent is a loop itself (single-statement body, no block)
      // we can't hoist since we'd need to restructure — bail

      if (!loopNode) return;

      // Check that no free identifier in the init expression is mutated in the loop body
      const freeIds = collectFreeIdentifiers(decl.init);
      const mutated = collectMutatedNames(loopNode.body);
      for (const name of freeIds) {
        if (mutated.has(name)) return;
      }

      // Find the loop in its parent body array
      const loopParent = ancestors[loopAncestorIdx - 1];
      if (!loopParent) return;
      const parentBody = getBodyArray(loopParent);
      if (!parentBody) return;
      const loopIndex = parentBody.indexOf(loopNode);
      if (loopIndex === -1) return;

      // Find the statement in the loop body
      const loopBody = getBodyArray(loopNode.body);
      if (!loopBody) return;
      const stmtIndex = loopBody.indexOf(node);
      if (stmtIndex === -1) return;

      const names = collectPatternNames(decl.id);
      const exprLabel = escodegen.generate(decl.init);
      const label = exprLabel.length > 40 ? exprLabel.slice(0, 37) + "…" : exprLabel;
      operations.push({
        parentBody,
        loopIndex,
        loopBody,
        stmtIndex,
        stmt: node,
        label: `${names.join(", ")} = ${label}`
      });

      reports.push(`  ✓ hoisted: ${node.kind} ${names.join(", ")} = ${label}`);
    },
  });

  // Sort operations for safe application:
  // - Different parentBody/loopIndex: process higher loopIndex first so
  //   insertions don't shift indices of later operations.
  // - Same loopBody: process higher stmtIndex first so removals from the
  //   loop body don't shift indices of later removals.
  operations.sort((a, b) => {
    // Primary: by parentBody insertion point (higher first)
    if (a.parentBody === b.parentBody && a.loopIndex !== b.loopIndex) {
      return b.loopIndex - a.loopIndex;
    }
    // Secondary: by stmtIndex within same loop body (higher first)
    if (a.loopBody === b.loopBody) {
      return b.stmtIndex - a.stmtIndex;
    }
    return 0;
  });

  operations.forEach(({
    parentBody,
    loopIndex,
    loopBody,
    stmtIndex,
    stmt
  }) => {
    // Collision check: collect all identifiers already in the target scope
    const usedInParent = new Set();
    for (const s of parentBody) collectIdentifiers(s).forEach((n) => usedInParent.add(n));

    const decl = stmt.declarations[0];
    const origName = decl.id.name;
    const safeName = uniqueName(origName, usedInParent);

    if (safeName !== origName) {
      // Rename the declaration and all references in the loop body,
      // stopping at function boundaries that shadow the name.
      decl.id.name = safeName;
      scopeAwareRename(loopBody, origName, safeName);
    }

    loopBody.splice(stmtIndex, 1); // remove from loop body
    parentBody.splice(loopIndex, 0, stmt); // insert before loop
  });

  return reports;
}

// ─── Pass: hoistFunctionInvariants ───────────────────────────────────────────

/**
 * Hoists invariant declarations out of function bodies to the enclosing scope.
 *
 * A declaration  `const x = <expr>;`  at the top level of a function body
 * is invariant when:
 *   1. <expr> is a hoistable expression (regex literal, new RegExp with
 *      literal args, scalar literals, etc.)
 *   2. None of <expr>'s free identifiers overlap with the function's
 *      parameter names or any name mutated within the function body
 *   3. The declaration is a direct child of the function's body block
 *
 * The declaration is moved to just before the enclosing function declaration /
 * expression statement.
 *
 * This avoids re-creating identical objects (especially compiled RegExps)
 * on every function call.
 */
function passHoistFunctionInvariants(ast) {
  const reports = [];
  const operations = [];

  walk.ancestor(ast, {
    VariableDeclaration(node, ancestors) {
      if (node.kind !== "const") return;
      if (node.declarations.length !== 1) return;
      const decl = node.declarations[0];
      if (!decl.init) return;
      if (!isHoistableExpression(decl.init)) return;

      // The declaration must be a direct child of a function body block.
      // ancestors: [..., funcNode, BlockStatement, thisNode]
      // or for arrow with block: [..., arrowNode, BlockStatement, thisNode]
      const bodyBlock = ancestors[ancestors.length - 2];
      if (bodyBlock?.type !== "BlockStatement") return;

      const funcNode = ancestors[ancestors.length - 3];
      if (!funcNode) return;
      if (
        funcNode.type !== "FunctionDeclaration" &&
        funcNode.type !== "FunctionExpression" &&
        funcNode.type !== "ArrowFunctionExpression"
      ) return;
      if (funcNode.body !== bodyBlock) return;

      // Collect parameter names — the expression must not reference them
      const paramNames = new Set(funcNode.params.flatMap((p) => collectPatternNames(p)));
      const freeIds = collectFreeIdentifiers(decl.init);
      for (const name of freeIds) {
        if (paramNames.has(name)) return;
      }

      // Also check that no free id is mutated inside the function body
      const mutated = collectMutatedNames(bodyBlock);
      for (const name of freeIds) {
        if (mutated.has(name)) return;
      }

      // Find where to insert: walk up from the function node to find the
      // first ancestor that is a direct child of a body array.  That
      // ancestor is the "statement" we insert before.
      let insertParent = null;
      let insertNode = null;

      for (let i = ancestors.length - 3; i >= 0; i--) {
        const anc = ancestors[i];
        if (anc.type === "Program") {
          // Top level: the child of Program that contains the function
          const child = ancestors[i + 1];
          if (child && anc.body.includes(child)) {
            insertParent = anc.body;
            insertNode = child;
          }
          break;
        }
        if (i > 0) {
          const parentOfAnc = ancestors[i - 1];
          const body = getBodyArray(parentOfAnc);
          if (body && body.includes(anc)) {
            insertParent = body;
            insertNode = anc;
            break;
          }
        }
      }

      if (!insertParent || !insertNode) return;

      const insertIndex = insertParent.indexOf(insertNode);
      if (insertIndex === -1) return;

      // Retrieve the statement list of the function body so we can find and
      // remove the declaration by index.  bodyBlock is a confirmed BlockStatement
      // so getBodyArray always returns its .body array here.
      const funcBody = getBodyArray(bodyBlock);
      const stmtIndex = funcBody.indexOf(node);
      if (stmtIndex === -1) return;

      const names = collectPatternNames(decl.id);
      const exprLabel = escodegen.generate(decl.init);
      const label = exprLabel.length > 40 ? exprLabel.slice(0, 37) + "…" : exprLabel;

      operations.push({
        outerBody: insertParent,
        insertIndex,
        funcBody,
        stmtIndex,
        stmt: node
      });
      reports.push(`  ✓ hoisted: const ${names.join(", ")} = ${label}`);
    },
  });

  // Sort operations for safe application:
  // - Different outerBody/insertIndex: process higher insertIndex first so
  //   insertions don't shift indices of later operations.
  // - Same funcBody: process higher stmtIndex first so removals don't shift
  //   indices of later removals.
  operations.sort((a, b) => {
    if (a.outerBody === b.outerBody && a.insertIndex !== b.insertIndex) {
      return b.insertIndex - a.insertIndex;
    }
    if (a.funcBody === b.funcBody) {
      return b.stmtIndex - a.stmtIndex;
    }
    return 0;
  });

  operations.forEach(({
    outerBody,
    insertIndex,
    funcBody,
    stmtIndex,
    stmt
  }) => {
    // Collision check: collect all identifiers already in the target scope
    const usedInOuter = new Set();
    for (const s of outerBody) collectIdentifiers(s).forEach((n) => usedInOuter.add(n));

    const decl = stmt.declarations[0];
    const origName = decl.id.name;
    const safeName = uniqueName(origName, usedInOuter);

    if (safeName !== origName) {
      // Rename the declaration and all references in the function body,
      // stopping at nested functions that shadow the name.
      decl.id.name = safeName;
      scopeAwareRename(funcBody, origName, safeName);
    }

    funcBody.splice(stmtIndex, 1);
    outerBody.splice(insertIndex, 0, stmt);
  });

  return reports;
}

// ─── Pass Registry ───────────────────────────────────────────────────────────

/**
 * Passes run in the order listed here.
 * hoistLoopLength runs before promoteConst so its injected `const …` nodes
 * are already const and the second pass simply skips them.
 */
const PASSES = [{
    id: "hoistLoopLength",
    description: "Cache <expr>.length before for-loops; use !== and ++i",
    fn: passHoistLoopLength,
  },
  {
    id: "promoteConst",
    description: "Promote let → const where the binding is never reassigned",
    fn: passPromoteConst,
  },
  {
    id: "forEachToForLoop",
    description: "Convert .forEach(cb) to a guarded const-length for loop",
    fn: passForEachToForLoop,
  },
  {
    id: "forOfToForLoop",
    description: "Convert for…of over arrays to a guarded indexed for loop",
    fn: passForOfToForLoop,
  },
  {
    id: "hoistLoopInvariants",
    description: "Hoist loop-invariant declarations (regex, literals) above the loop",
    fn: passHoistLoopInvariants,
  },
  {
    id: "hoistFunctionInvariants",
    description: "Hoist invariant declarations (regex, literals) out of function bodies",
    fn: passHoistFunctionInvariants,
  },
];

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Run the optimizer on a JS source string.
 *
 * @param {string} source  - Original JS source code.
 * @param {object} [flags] - Per-pass flags + options.  All default to true.
 *   @param {boolean} [flags.hoistLoopLength=true]
 *   @param {boolean} [flags.promoteConst=true]
 *   @param {boolean} [flags.forEachToForLoop=true]
 *   @param {boolean} [flags.forOfToForLoop=true]
 *   @param {boolean} [flags.hoistLoopInvariants=true]
 *   @param {boolean} [flags.hoistFunctionInvariants=true]
 *   @param {boolean} [flags.verbose=true]
 * @returns {string} Optimized JS source code.
 */
function optimize(source, flags = {}) {
  const opts = {
    hoistLoopLength: true,
    promoteConst: true,
    forEachToForLoop: true,
    forOfToForLoop: true,
    hoistLoopInvariants: true,
    hoistFunctionInvariants: true,
    verbose: true,
    ...flags
  };

  const ast = acorn.parse(source, {
    ecmaVersion: 2020,
    sourceType: "module"
  });
  let anyWork = false;

  for (const pass of PASSES) {
    if (!opts[pass.id]) {
      if (opts.verbose) console.log(`[optimizer] ⏭  ${pass.id} — skipped`);
      continue;
    }
    const reports = pass.fn(ast);
    if (opts.verbose) {
      if (reports.length === 0) {
        console.log(`[optimizer] ✔  ${pass.id} — nothing to do`);
      } else {
        anyWork = true;
        console.log(`[optimizer] ✔  ${pass.id} (${reports.length}) — ${pass.description}`);
        reports.forEach((r) => console.log(r));
      }
    }
  }

  if (opts.verbose && !anyWork) console.log("[optimizer] Source already fully optimized.");

  return escodegen.generate(ast);
}

/** List all registered passes. */
function listPasses() {
  return PASSES.map(({
    id,
    description
  }) => ({
    id,
    description
  }));
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
//
//  node optimizer.js input.js [output.js] [--no-<passId>] ...
//
//  Examples:
//    node optimizer.js src.js                        # all passes
//    node optimizer.js src.js out.js --no-promoteConst
//    node optimizer.js src.js --no-hoistLoopLength --no-forEachToForLoop
//    node optimizer.js --help

if (require.main === module) {
  const fs = require("fs");
  const path = require("path");
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help") {
    console.log("Usage:  node optimizer.js <input.js> [output.js] [--no-<pass>] ...\n");
    console.log("Available passes (all on by default):");
    listPasses().forEach(({
        id,
        description
      }) =>
      console.log(`  --no-${id.padEnd(20)} ${description}`)
    );
    process.exit(args[0] === "--help" ? 0 : 1);
  }

  const positional = args.filter((a) => !a.startsWith("--"));
  const inputPath = positional[0];
  const outputPath = positional[1] ?? inputPath.replace(/\.js$/, ".optimized.js");

  const flags = {};
  args.filter((a) => a.startsWith("--no-")).forEach((a) => {
    const id = a.slice(5);
    if (PASSES.some((p) => p.id === id)) flags[id] = false;
    else console.warn(`[optimizer] Unknown pass: ${a}`);
  });

  const source = fs.readFileSync(inputPath, "utf8");
  const result = optimize(source, flags);
  fs.writeFileSync(outputPath, result, "utf8");
  console.log(`[optimizer] Written → ${path.resolve(outputPath)}`);
}

module.exports = {
  optimize,
  listPasses,
  passHoistLoopLength,
  passPromoteConst,
  passForEachToForLoop,
  passForOfToForLoop,
  passHoistLoopInvariants,
  passHoistFunctionInvariants,
};
