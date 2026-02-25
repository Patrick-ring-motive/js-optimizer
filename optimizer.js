/**
 * js-optimizer
 *
 * A modular, pass-based source optimizer built on acorn + escodegen.
 *
 * Passes (all enabled by default, each independently flag-controlled):
 *
 *   hoistLoopLength  — cache arr.length before for-loops; use !== and ++i
 *   promoteConst     — promote let/var → const where never reassigned
 *   forEachToForOf   — convert .forEach(cb) call expressions to for…of loops
 *
 * Usage:
 *   const { optimize } = require("./optimizer");
 *
 *   // All passes on (default):
 *   optimize(source);
 *
 *   // Only const promotion:
 *   optimize(source, { hoistLoopLength: false, forEachToForOf: false });
 *
 *   // Silence log output:
 *   optimize(source, { verbose: false });
 *
 * Install deps:
 *   npm install acorn acorn-walk escodegen
 */

"use strict";

const acorn     = require("acorn");
const walk      = require("acorn-walk");
const escodegen = require("escodegen");

// ─── Generic AST Helpers ─────────────────────────────────────────────────────

/**
 * Given a parent node that can contain a statement list, return that list.
 * Handles Program, BlockStatement, and SwitchCase.
 */
function getBodyArray(parent) {
  if (!parent) return null;
  if (parent.type === "Program")        return parent.body;
  if (parent.type === "BlockStatement") return parent.body;
  if (parent.type === "SwitchCase")     return parent.consequent;
  return null;
}

/**
 * Converts a non-computed MemberExpression chain to a dot-path string.
 *   node.properties → "node.properties"
 *   arr             → "arr"
 * Returns null if any part of the chain is computed (e.g. foo["bar"]).
 */
function memberExprToString(node) {
  if (node.type === "Identifier")       return node.name;
  if (node.type !== "MemberExpression") return null;
  if (node.computed)                    return null;
  const obj = memberExprToString(node.object);
  if (obj === null)                     return null;
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
  walk.simple(node, { Identifier(n) { names.add(n.name); } });
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
  const fnTypes    = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
  const blockTypes = new Set(["BlockStatement", "Program", "SwitchCase"]);
  const targets    = kind === "var" ? new Set([...fnTypes, "Program"]) : blockTypes;

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
    if (n.type === "ThisExpression")                        { found = true; return; }
    if (n.type === "Identifier" && n.name === "arguments") { found = true; return; }
    // Stop at nested non-arrow functions — their bindings are unrelated.
    if (n.type === "FunctionDeclaration" || n.type === "FunctionExpression") return;
    for (const key of Object.keys(n)) {
      if (key === "type" || key === "loc" || key === "start" || key === "end") continue;
      const child = n[key];
      if (Array.isArray(child))                              child.forEach(visit);
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
    if (loopTypes.has(n.type)) { found = true; return; }
    // Stop at nested functions — their loops are unrelated.
    if (n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression") return;
    for (const key of Object.keys(n)) {
      if (key === "type" || key === "loc" || key === "start" || key === "end") continue;
      const child = n[key];
      if (Array.isArray(child))                                    child.forEach(visit);
      else if (child && typeof child === "object" && child.type)   visit(child);
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
  const continueLabel = label ? { type: "Identifier", name: label } : null;

  function stmt(s) {
    if (!s) return s;
    switch (s.type) {

      case "ReturnStatement":
        if (!s.argument) {
          // return;  →  continue [label];
          return { type: "ContinueStatement", label: continueLabel };
        }
        // return expr;  →  { expr; continue [label]; }
        // Keeps any side-effects in the original expression.
        return {
          type: "BlockStatement",
          body: [
            { type: "ExpressionStatement", expression: s.argument },
            { type: "ContinueStatement",   label: continueLabel },
          ],
        };

      case "BlockStatement":
        return { ...s, body: s.body.map(stmt) };

      case "IfStatement":
        return { ...s, consequent: stmt(s.consequent), alternate: s.alternate ? stmt(s.alternate) : null };

      // Nested loops: returns still target the callback, so we must
      // descend — but `continue` must use a label to target the outer
      // forEach-replacement loop, not these inner loops.
      case "ForStatement":
      case "ForInStatement":
      case "ForOfStatement":
      case "WhileStatement":
      case "DoWhileStatement":
        return { ...s, body: stmt(s.body) };

      case "LabeledStatement":
        return { ...s, body: stmt(s.body) };

      case "TryStatement":
        return {
          ...s,
          block:     stmt(s.block),
          handler:   s.handler   ? { ...s.handler, body: stmt(s.handler.body) } : null,
          finalizer: s.finalizer ? stmt(s.finalizer) : null,
        };

      case "SwitchStatement":
        return {
          ...s,
          cases: s.cases.map((c) => ({ ...c, consequent: c.consequent.map(stmt) })),
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

  return { ...blockNode, body: blockNode.body.map(stmt) };
}

// ─── AST Builders ────────────────────────────────────────────────────────────

/** const <cacheName> = <lengthNode> || 0; */
function buildCacheDeclaration(cacheName, lengthNode) {
  return {
    type: "VariableDeclaration",
    kind: "const",
    declarations: [{
      type: "VariableDeclarator",
      id:   { type: "Identifier", name: cacheName },
      init: {
        type:     "LogicalExpression",
        operator: "||",
        left:     lengthNode,
        right:    { type: "Literal", value: 0, raw: "0" },
      },
    }],
  };
}

/** i !== cacheName */
function buildStrictTest(iteratorName, cacheName) {
  return {
    type:     "BinaryExpression",
    operator: "!==",
    left:     { type: "Identifier", name: iteratorName },
    right:    { type: "Identifier", name: cacheName },
  };
}

/** ++i */
function buildPrefixIncrement(iteratorName) {
  return {
    type:     "UpdateExpression",
    operator: "++",
    prefix:   true,
    argument: { type: "Identifier", name: iteratorName },
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
  const reports    = [];
  const insertions = []; // deferred: { bodyArray, index, declaration }

  walk.ancestor(ast, {
    ForStatement(node, ancestors) {

      // ── test: i {<,<=} <expr-involving-.length> ──
      // Check test and update first to learn the iterator name, then
      // validate it appears in the init.
      const test = node.test;
      if (test?.type !== "BinaryExpression")                       return;
      if (test.operator !== "<" && test.operator !== "<=")         return;
      if (test.left?.type !== "Identifier")                        return;
      if (!containsLengthAccess(test.right))                       return;

      const iteratorName = test.left.name;

      // ── update: i++ ──
      const upd = node.update;
      if (upd?.type !== "UpdateExpression")                        return;
      if (upd.operator !== "++")                                   return;
      if (upd.argument?.type !== "Identifier")                     return;
      if (upd.argument.name !== iteratorName)                      return;

      // ── init: must contain the iterator set to a numeric literal ──
      const init = node.init;
      let initLabel, initValue;

      if (init?.type === "VariableDeclaration") {
        if (init.kind !== "let" && init.kind !== "var")              return;
        // Find the declarator that matches the iterator name
        const decl = init.declarations.find(
          (d) => d.id?.type === "Identifier" && d.id.name === iteratorName
        );
        if (!decl)                                                   return;
        if (!isNumericLiteral(decl.init))                            return;
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
        if (!assign)                                                 return;
        initValue = numericValue(assign.right);
        initLabel = iteratorName;
      } else {
        return;
      }

      const arrayPath = extractLengthBasePath(test.right);

      // ── Transform ──
      // Choose cache name: plain `.length` → `arr_length`,
      // compound expression (e.g. `.length - 1`) → `arr_bound`.
      // Ensure the name doesn't collide with identifiers in the parent scope.
      const isPlainLength = test.right.type === "MemberExpression" &&
                            !test.right.computed &&
                            test.right.property?.name === "length";
      const baseName   = isPlainLength
        ? pathToCacheName(arrayPath ?? "_loop")
        : pathToBoundName(arrayPath ?? "_loop");
      const scopeNode  = ancestors[ancestors.length - 2] ?? ast;
      const cacheName  = uniqueName(baseName, collectIdentifiers(scopeNode));
      const lengthNode = test.right;           // capture before overwriting

      // Canonical case (init=0, op=<): safe to tighten to !==
      if (initValue === 0 && test.operator === "<") {
        node.test = buildStrictTest(iteratorName, cacheName);
      } else {
        node.test = { ...test, right: { type: "Identifier", name: cacheName } };
      }
      node.update = buildPrefixIncrement(iteratorName);

      // ancestors[-1] = ForStatement itself, ancestors[-2] = its parent
      const parent    = ancestors[ancestors.length - 2];
      const bodyArray = getBodyArray(parent);
      if (bodyArray) {
        const idx = bodyArray.indexOf(node);
        if (idx !== -1)
          insertions.push({ bodyArray, index: idx, declaration: buildCacheDeclaration(cacheName, lengthNode) });
      }

      const rhsLabel = escodegen.generate(lengthNode);
      reports.push(`  ✓ for(${initLabel}=${initValue}; … ${test.operator} ${rhsLabel}; …++) → uses ${cacheName}`);
    },
  });

  // Deduplicate: if the same cache name is inserted into the same block
  // more than once, only keep the first occurrence.
  const seenPerBlock = new Map(); // bodyArray → Set<cacheName>
  insertions.reverse().forEach(({ bodyArray, index, declaration }) => {
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
      if (node.kind === "const")                          return;
      if (node.kind !== "let")                             return; // skip var: promoting to const changes scope semantics
      if (node.declarations.some((d) => d.init == null)) return;

      // ancestors[-1] = this node, ancestors[-2] = its parent
      const parent = ancestors[ancestors.length - 2];
      if (parent?.type === "ForStatement" && parent.init === node) return;

      const names     = new Set(node.declarations.flatMap((d) => collectPatternNames(d.id)));
      const scopeRoot = findScopeRoot(ancestors, node.kind);
      if (!scopeRoot)                  return;
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
    type:     "MemberExpression",
    object:   { type: "Identifier", name: "Symbol" },
    property: { type: "Identifier", name: "iterator" },
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
    type:     "BinaryExpression",
    operator: "===",
    left: {
      type: "MemberExpression", computed: true,
      object:   arrayExpr,
      property: symIter,
    },
    right: {
      type: "MemberExpression", computed: true,
      object:   { type: "ArrayExpression", elements: [] },
      property: buildSymbolIterator(), // fresh node — AST nodes must not be shared
    },
  };
}

/**
 * Builds the inner const-length for loop used in the fast path:
 *
 *   const <cacheName> = <arrayExpr>.length || 0;
 *   for (let <loopVar> = 0; <loopVar> !== <cacheName>; ++<loopVar>) {
 *     const <itemParam> = <arrayExpr>[<loopVar>];   // only for single-param callbacks
 *     …body…
 *   }
 *
 * For two-param callbacks the caller passes the index param name as loopVar
 * and sets itemParam to the value param — no extra declaration is needed for
 * the index since the loop variable IS the index.
 */
function buildFastForLoop(arrayExpr, loopVar, itemParam, body, label) {
  const baseCacheName = pathToCacheName(memberExprToString(arrayExpr) ?? "_forEach");
  const cacheName     = uniqueName(baseCacheName, collectIdentifiers(body));

  // Prepend: const <itemParam> = <arrayExpr>[<loopVar>];
  const itemDecl = {
    type: "VariableDeclaration", kind: "const",
    declarations: [{
      type: "VariableDeclarator",
      id:   itemParam,
      init: {
        type: "MemberExpression", computed: true,
        object:   arrayExpr,
        property: { type: "Identifier", name: loopVar },
      },
    }],
  };

  const loopBody = { ...body, body: [itemDecl, ...body.body] };

  const forLoop = {
    type:   "ForStatement",
    init:   {
      type: "VariableDeclaration", kind: "let",
      declarations: [{
        type: "VariableDeclarator",
        id:   { type: "Identifier", name: loopVar },
        init: { type: "Literal", value: 0, raw: "0" },
      }],
    },
    test:   buildStrictTest(loopVar, cacheName),
    update: buildPrefixIncrement(loopVar),
    body:   loopBody,
  };

  // If a label is provided, wrap the for-loop so labeled continue works
  // correctly when returns inside nested loops are rewritten.
  const loopNode = label
    ? { type: "LabeledStatement", label: { type: "Identifier", name: label }, body: forLoop }
    : forLoop;

  return [
    buildCacheDeclaration(cacheName, {
      type: "MemberExpression", computed: false,
      object:   arrayExpr,
      property: { type: "Identifier", name: "length" },
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
  const reports      = [];
  const replacements = []; // deferred: { bodyArray, index, newNode }

  walk.ancestor(ast, {
    ExpressionStatement(node, ancestors) {
      const call = node.expression;

      // Shape: <expr>.forEach(<cb>)
      if (call?.type !== "CallExpression")             return;
      if (call.callee?.type !== "MemberExpression")    return;
      if (call.callee.computed)                        return;
      if (call.callee.property?.name !== "forEach")    return;
      if (call.arguments.length !== 1)                 return; // thisArg unsupported

      const cb = call.arguments[0];
      if (cb.type !== "ArrowFunctionExpression" && cb.type !== "FunctionExpression") return;
      if (cb.type === "FunctionExpression" && containsThisOrArguments(cb.body))      return;

      const params = cb.params;
      if (params.length === 0 || params.length > 2) return;

      const arrayExpr = call.callee.object;

      // Normalise expression-body arrow to block form
      const rawBody = cb.body.type === "BlockStatement"
        ? cb.body
        : { type: "BlockStatement", body: [{ type: "ExpressionStatement", expression: cb.body }] };

      // Detect whether the body contains nested loops or returns; if so we
      // need a labeled outer loop so that rewritten continue targets it.
      const hasNestedLoop = containsNestedLoop(rawBody);
      const loopLabel = hasNestedLoop ? "_forEach" : null;
      const body = rewriteReturns(rawBody, loopLabel);

      // Decide loop variable name and item binding
      let loopVar, itemParam;
      if (params.length === 1) {
        loopVar   = uniqueLoopVar(rawBody);  // collision-safe counter
        itemParam = params[0];               // const <param> = arr[_i]
      } else {
        // (item, idx) — idx IS the index, so it becomes the loop variable
        const [itemP, idxP] = params;
        loopVar   = escodegen.generate(idxP);   // e.g. "i", "idx", "index"
        itemParam = itemP;                       // const item = arr[idx]
      }

      // Fast path: const-length for loop
      const fastStatements = buildFastForLoop(arrayExpr, loopVar, itemParam, body, loopLabel);

      // Slow path: original forEach call (unchanged)
      const slowStatement = { type: "ExpressionStatement", expression: call };

      // Wrap in if/else guarded by the iterator check
      const ifNode = {
        type:       "IfStatement",
        test:       buildIteratorGuard(arrayExpr),
        consequent: { type: "BlockStatement", body: fastStatements },
        alternate:  { type: "BlockStatement", body: [slowStatement] },
      };

      // ancestors[-1] = ExpressionStatement, ancestors[-2] = its parent
      const parent    = ancestors[ancestors.length - 2];
      const bodyArray = getBodyArray(parent);
      if (!bodyArray) return;
      const idx = bodyArray.indexOf(node);
      if (idx === -1) return;

      replacements.push({ bodyArray, index: idx, newNode: ifNode });

      const arrLabel   = escodegen.generate(arrayExpr);
      const paramLabel = params.map((p) => escodegen.generate(p)).join(", ");
      reports.push(`  ✓ ${arrLabel}.forEach((${paramLabel}) => …) → guarded const-length for loop`);
    },
  });

  replacements.reverse().forEach(({ bodyArray, index, newNode }) => {
    bodyArray.splice(index, 1, newNode);
  });

  return reports;
}

// ─── Pass Registry ───────────────────────────────────────────────────────────

/**
 * Passes run in the order listed here.
 * hoistLoopLength runs before promoteConst so its injected `const …` nodes
 * are already const and the second pass simply skips them.
 */
const PASSES = [
  {
    id:          "hoistLoopLength",
    description: "Cache <expr>.length before for-loops; use !== and ++i",
    fn:          passHoistLoopLength,
  },
  {
    id:          "promoteConst",
    description: "Promote let/var → const where the binding is never reassigned",
    fn:          passPromoteConst,
  },
  {
    id:          "forEachToForLoop",
    description: "Convert .forEach(cb) to a guarded const-length for loop",
    fn:          passForEachToForLoop,
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
 *   @param {boolean} [flags.verbose=true]
 * @returns {string} Optimized JS source code.
 */
function optimize(source, flags = {}) {
  const opts = { hoistLoopLength: true, promoteConst: true, forEachToForLoop: true, verbose: true, ...flags };

  const ast     = acorn.parse(source, { ecmaVersion: 2020, sourceType: "module" });
  let   anyWork = false;

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
  return PASSES.map(({ id, description }) => ({ id, description }));
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
//
//  node optimizer.js input.js [output.js] [--no-<passId>] ...
//
//  Examples:
//    node optimizer.js src.js                        # all passes
//    node optimizer.js src.js out.js --no-promoteConst
//    node optimizer.js src.js --no-hoistLoopLength --no-forEachToForOf
//    node optimizer.js --help

if (require.main === module) {
  const fs   = require("fs");
  const path = require("path");
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help") {
    console.log("Usage:  node optimizer.js <input.js> [output.js] [--no-<pass>] ...\n");
    console.log("Available passes (all on by default):");
    listPasses().forEach(({ id, description }) =>
      console.log(`  --no-${id.padEnd(20)} ${description}`)
    );
    process.exit(args[0] === "--help" ? 0 : 1);
  }

  const positional = args.filter((a) => !a.startsWith("--"));
  const inputPath  = positional[0];
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

module.exports = { optimize, listPasses, passHoistLoopLength, passPromoteConst, passForEachToForLoop };
