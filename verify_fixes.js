"use strict";
const {
  optimize
} = require("./optimizer");
const fs = require("fs");
const acorn = require("acorn");

let passed = 0,
  failed = 0;

function check(label, condition) {
  if (condition) {
    console.log("PASS:", label);
    passed++;
  } else {
    console.log("FAIL:", label);
    failed++;
  }
}

// === Round 1 fixes ===
console.log("\n--- Fix 1: Mutable literal hoisting ---");

const out1a = optimize(`
function make() {
  const acc = [];
  acc.push(1);
  return acc;
}
`, {
  verbose: false
});
check("array NOT hoisted out of function", out1a.includes("const acc = []") && !out1a.includes("acc$2"));

const out1b = optimize(`
for (let i = 0; i < items.length; i++) {
  const defaults = [0, 0, 0];
  merge(items[i], defaults);
}
`, {
  verbose: false
});
// The declaration must remain INSIDE the loop (after the `for` keyword)
const defaults1bIdx = out1b.indexOf("const defaults =");
const for1bIdx = out1b.indexOf("for (");
check("array NOT hoisted out of loop", defaults1bIdx !== -1 && for1bIdx !== -1 && defaults1bIdx > for1bIdx);

const out1c = optimize(`
for (let i = 0; i < items.length; i++) {
  const re = /pattern/;
  items[i].match(re);
}
`, {
  verbose: false
});
const reIdx = out1c.indexOf("/pattern/");
const forIdx = out1c.indexOf("for (let i");
check("regex STILL hoisted out of loop", reIdx !== -1 && forIdx !== -1 && reIdx < forIdx);

console.log("\n--- Fix 2: scopeAwareRename property keys ---");

const out2 = optimize(`
const re = /outer/;
for (let i = 0; i < items.length; i++) {
  const re = /inner/;
  const obj = { re: 1 };
  use(obj.re, re);
}
`, {
  verbose: false
});
check("object key 're' NOT renamed", out2.includes("{ re: 1 }"));
check("member access 'obj.re' NOT renamed", out2.includes("obj.re"));
check("variable 're' IS renamed to re$2", out2.includes("re$2"));

const out2b = optimize(`
const x = /outer/;
for (let i = 0; i < items.length; i++) {
  const x = /inner/;
  const obj = { x };
  use(obj);
}
`, {
  verbose: false
});
check("shorthand { x } expanded to { x: x$2 }", out2b.includes("{ x: x$2 }") || out2b.includes("{x: x$2}"));

console.log("\n--- Fix 3: forEach non-Identifier params ---");

const out3a = optimize(
  'items.forEach((item, idx = 0) => { console.log(idx, item); });', {
    verbose: false
  }
);
check("default param: bails (keeps forEach)", out3a.includes("forEach"));

const out3b = optimize(
  'items.forEach((item, [idx]) => { console.log(idx, item); });', {
    verbose: false
  }
);
check("destructuring param: bails (keeps forEach)", out3b.includes("forEach"));

const out3c = optimize(
  'items.forEach((item, idx) => { console.log(idx, item); });', {
    verbose: false
  }
);
check("normal 2-param forEach still optimized", out3c.includes("for (let idx = 0;"));

const out3d = optimize(
  'items.forEach(item => { console.log(item); });', {
    verbose: false
  }
);
check("normal 1-param forEach still optimized", out3d.includes("for (let _i = 0;"));

// === Round 2 fixes ===
console.log("\n--- Fix 4: _forEach label collision ---");

const out4 = optimize(`
items.forEach(item => {
  _forEach: for (let j = 0; j < 5; j++) {
    if (item.done) return;
    process(j);
  }
});
`, {
  verbose: false
});
const outerLabel = out4.match(/^\s*([\w$]+):\s*\n?\s*for \(let _i/m);
const innerLabel = out4.match(/_forEach:\s/);
check("outer label is NOT _forEach (collision avoided)",
  outerLabel && outerLabel[1] !== "_forEach");
const continueTarget = out4.match(/continue ([\w$]+)/);
check("continue targets the outer (non-colliding) label",
  continueTarget && outerLabel && continueTarget[1] === outerLabel[1]);

console.log("\n--- Fix 5: MethodDefinition key not renamed ---");

const out5 = optimize(`
const re = /outer/;
for (let i = 0; i < items.length; i++) {
  const re = /inner/;
  class Foo { re() { return 1; } }
  use(re, new Foo());
}
`, {
  verbose: false
});
check("MethodDefinition key 're()' preserved", out5.includes("re()"));
check("variable re renamed to re$2", out5.includes("re$2"));

console.log("\n--- Fix 6: Labels not renamed ---");

const out6 = optimize(`
const x = /outer/;
for (let i = 0; i < items.length; i++) {
  const x = /inner/;
  x: for (let j = 0; j < 5; j++) {
    if (j === 3) break x;
  }
  use(x);
}
`, {
  verbose: false
});
check("LabeledStatement label 'x:' preserved", /\bx:\s/.test(out6.replace(/x\$\d/g, "")));
check("break target 'break x' preserved", /break x;/.test(out6));
check("variable x renamed to x$2", out6.includes("x$2"));

// === E2E: test.js + qna.js ===
console.log("\n--- End-to-end ---");
for (const f of ["test.js", "qna.js"]) {
  try {
    const src = fs.readFileSync(f, "utf8");
    const result = optimize(src, {
      verbose: false
    });
    acorn.parse(result, {
      ecmaVersion: 2020,
      sourceType: "module"
    });
    check(f + " output is valid JS", true);
  } catch (e) {
    check(f + " output is valid JS (" + e.message + ")", false);
  }
}

// === Summary ===
console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
