"use strict";
const {
  optimize
} = require("./optimizer");

let pass = 0,
  fail = 0;

function test(label, fn) {
  try {
    fn();
    pass++;
    console.log(`  PASS  ${label}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL  ${label}\n        ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ── Issue 1: Stateful regex hoisting ─────────────────────────────────────
// Regex with /g or /y flag has mutable .lastIndex.  Hoisting it out of a
// function makes all calls share the same instance, so the second call
// starts from a non-zero lastIndex and gives a wrong result.

test("global regex NOT hoisted from function", () => {
  const src = `
function hasMatch(str) {
  const re = /foo/g;
  return re.test(str);
}
`;
  const out = optimize(src, {
    verbose: false
  });
  // The regex should stay INSIDE the function — not be hoisted above it.
  // If hoisted, the const … = /foo/g line would appear BEFORE the function.
  const funcIdx = out.indexOf("function hasMatch");
  const regexIdx = out.indexOf("/foo/g");
  assert(regexIdx > funcIdx,
    `global regex was hoisted above function:\n${out}`);
});

test("sticky regex NOT hoisted from function", () => {
  const src = `
function hasMatch(str) {
  const re = /foo/y;
  return re.test(str);
}
`;
  const out = optimize(src, {
    verbose: false
  });
  const funcIdx = out.indexOf("function hasMatch");
  const regexIdx = out.indexOf("/foo/y");
  assert(regexIdx > funcIdx,
    `sticky regex was hoisted above function:\n${out}`);
});

test("global regex NOT hoisted from loop", () => {
  const src = `
const lines = ["foobar","baz"];
for (let i = 0; i < lines.length; i++) {
  const re = /foo/g;
  while (re.exec(lines[i])) {}
}
`;
  const out = optimize(src, {
    verbose: false
  });
  // regex should stay inside the for-loop body, not move before it
  const forIdx = out.indexOf("for ");
  const regexIdx = out.indexOf("/foo/g");
  assert(regexIdx > forIdx,
    `global regex was hoisted above loop:\n${out}`);
});

test("non-global regex STILL hoisted (regression)", () => {
  const src = `
function check(s) {
  const re = /foo/i;
  return re.test(s);
}
`;
  const out = optimize(src, {
    verbose: false
  });
  const funcIdx = out.indexOf("function check");
  const regexIdx = out.indexOf("/foo/i");
  assert(regexIdx < funcIdx,
    `non-global regex should still be hoisted:\n${out}`);
});

test("new RegExp with global flag NOT hoisted", () => {
  const src = `
function hasMatch(str) {
  const re = new RegExp("foo", "g");
  return re.test(str);
}
`;
  const out = optimize(src, {
    verbose: false
  });
  const funcIdx = out.indexOf("function hasMatch");
  const regexpIdx = out.indexOf("new RegExp");
  assert(regexpIdx > funcIdx,
    `new RegExp("foo","g") was hoisted above function:\n${out}`);
});

// ── Issue 2: var scoping in FunctionExpression forEach ────────────────────
// A FunctionExpression callback has its own scope for `var`.  Converting it
// to a for-loop leaks the `var` into the enclosing function scope.

test("forEach with FunctionExpression + var NOT converted", () => {
  const src = `
var x = "outer";
arr.forEach(function(item) {
  var x = item;
});
console.log(x);
`;
  const out = optimize(src, {
    verbose: false
  });
  // The forEach should NOT be converted because the callback is a
  // FunctionExpression whose body contains `var` declarations.
  // If it IS converted, `var x = item` would leak into outer scope.
  assert(out.includes(".forEach("),
    `forEach with FunctionExpression+var was converted (var scoping change):\n${out}`);
});

test("forEach with arrow + var IS converted (arrow has no own var scope)", () => {
  const src = `
arr.forEach((item) => {
  var x = item;
  use(x);
});
`;
  const out = optimize(src, {
    verbose: false
  });
  // Arrow functions don't create their own var scope, so var scoping is
  // unchanged by the conversion.  It should still be optimised.
  assert(!out.includes(".forEach(") || out.indexOf(".forEach(") > out.indexOf("else"),
    `forEach with arrow+var should still be converted:\n${out}`);
});

// ── Issue 3: for-await-of conversion ──────────────────────────────────────
// `for await (const x of arr)` should NOT be converted because the await
// behavior (resolving promises) is lost in an indexed for-loop.

test("for-await-of NOT converted", () => {
  const src = `
async function fetchAll(urls) {
  for await (const resp of urls) {
    console.log(resp);
  }
}
`;
  const out = optimize(src, {
    verbose: false
  });
  // Should keep `for await` — must NOT be converted to indexed loop
  assert(out.includes("for await") || out.includes("for (const resp of"),
    `for-await-of was converted to indexed loop:\n${out}`);
});

// ── Issue 4: PASSES description for promoteConst ──────────────────────────
// The PASSES registry says "let/var" but only let is promoted.

test("var declaration NOT promoted to const", () => {
  const src = `
function foo() {
  var x = 1;
  use(x);
}
`;
  const out = optimize(src, {
    verbose: false
  });
  assert(out.includes("var x"),
    `var was promoted to const:\n${out}`);
});

// ── Summary ──────────────────────────────────────────────────────────────
console.log(`\n${pass + fail} tests: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
