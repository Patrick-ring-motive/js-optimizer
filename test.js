// ── test.js ──────────────────────────────────────────────────────────────────
// node optimizer.js test.js                         → all passes
// node optimizer.js test.js --no-forEachToForLoop   → skip forEach pass
// node optimizer.js --help                          → list all passes

// ════════════════════════════════════════════════════════════════════════════
// Pass 1 — hoistLoopLength
// ════════════════════════════════════════════════════════════════════════════

let items = [];


// ✓ plain identifier  (canonical: init=0, op=< → !== + ++i)
for (let i = 0; i < items.length; i++) {
  console.log(items[i]);
}

// ✓ chained member expression
for (var i = 0; i < node.properties.length; i++) {
  visit(node.properties[i]);
}

// ✗ already !== — no match
for (let k = 0; k !== data.length; k++) {
  handle(data[k]);
}

// ✓ bare assignment init (no let/var)
for (k = 0; k < data.length; k++) {
  handle(data[k]);
}

// ✓ non-zero init with <= (operator preserved, not tightened to !==)
for (let k = 1; k <= data.length; k++) {
  handle(data[k]);
}

// ✓ negative init with compound length expression (cached as data_bound)
for (let k = -1; k <= data.length - 1; k++) {
  handle(data[k]);
}

// ✓ cache name collision — user already has items_length in scope
let items_length = 99;
for (let i = 0; i < items.length; i++) {
  console.log(items_length, items[i]);
}

// ✓ multi-declarator init — iterator found among siblings
for (var sent$e = [], sent$t = 0; sent$t < arguments.length; sent$t++) {
  sent$e.push(arguments[sent$t]);
}

// ✗ stale-length bail — body mutates the array (push)
for (let i = 0; i < items.length; i++) {
  items.push(items[i] * 2);
}

// ✗ stale-length bail — body mutates the array (splice)
for (let i = 0; i < items.length; i++) {
  items.splice(i, 1);
}

// ✓ mutation is on a *different* array — still safe to cache
for (let i = 0; i < items.length; i++) {
  otherArr.push(items[i]);
}


// ════════════════════════════════════════════════════════════════════════════
// Pass 2 — promoteConst
// ════════════════════════════════════════════════════════════════════════════

let config = loadConfig();      // ✓ → const
let MAX    = 100;               // ✓ → const
let { a, b } = getCoords();    // ✓ → const  (destructuring)

let x = 0;   x = computeX();  // ✗ reassigned
let y = 1;   y++;              // ✗ updated
let uninit;  uninit = fetch(); // ✗ no initializer
var stable = 42;               // ✗ var — not promoted (hoisting semantics would change)


// ════════════════════════════════════════════════════════════════════════════
// Pass 3 — forEachToForLoop
//
// Each case becomes:
//
//   if (arr[Symbol.iterator] === [][Symbol.iterator]) {
//     const arr_length = arr.length || 0;
//     for (let _i = 0; _i !== arr_length; ++_i) {
//       if (!(_i in arr)) continue;   ← skip sparse-array holes (forEach spec)
//       const item = arr[_i];
//       …body…
//     }
//   } else {
//     arr.forEach(…);  ← original call, untouched
//   }
// ════════════════════════════════════════════════════════════════════════════

// ✓ arrow, single param
items.forEach(item => {
  console.log(item);
});

// ✓ arrow, two params — idx becomes the loop variable directly, no extra decl
items.forEach((item, idx) => {
  console.log(idx, item);
});

// ✓ expression-body arrow (normalised to block automatically)
items.forEach(item => console.log(item));

// ✓ FunctionExpression with no this/arguments
items.forEach(function(item) {
  process(item);
});

// ✓ return; in callback → continue;
items.forEach(item => {
  if (item.skip) return;
  process(item);
});

// ✓ return expr; → { expr; continue; }  (side-effects preserved)
items.forEach(item => {
  if (!item) return log("missing");
  render(item);
});

// ✓ return in nested loop → labeled continue _forEach (targets outer loop)
items.forEach(item => {
  for (let j = 0; j < item.subs.length; j++) {
    if (item.subs[j].done) return;
    process(item.subs[j]);
  }
  finalize(item);
});

// ✓ return inside nested arrow left untouched (arrow owns its own return)
items.forEach(item => {
  const mapped = item.subs.map(sub => {
    if (sub.bad) return null;
    return sub.value;
  });
  process(mapped);
});

// ✓ _i variable clash — loop var becomes _i$2
items.forEach(item => {
  const _i = getIndex();
  console.log(_i, item);
});

// ✓ cache name collision inside forEach — items_length already in callback body
items.forEach(item => {
  const items_length = item.count;
  console.log(items_length);
});

// ✗ thisArg second argument — bail (cannot replicate binding)
items.forEach(function(item) { this.process(item); }, context);

// ✗ FunctionExpression using `this` — bail
items.forEach(function(item) {
  this.count++;
});

// ✗ FunctionExpression using `arguments` — bail
items.forEach(function(item) {
  console.log(arguments.length);
});

// ✓ sparse array — hole-skipping guard emitted (if (!(_i in sparse)) continue;)
const sparse = [1, , 3];
sparse.forEach(v => {
  console.log(v);
});


// ════════════════════════════════════════════════════════════════════════════
// Pass 4 — forOfToForLoop
// ════════════════════════════════════════════════════════════════════════════

// ✓ const iteration variable
for (const item of items) {
  console.log(item);
}

// ✓ let iteration variable
for (let item of items) {
  console.log(item);
}

// ✗ destructuring — bail
for (const { name, age } of items) {
  console.log(name, age);
}

// ✗ var — bail (hoisting semantics would differ)
for (var item of items) {
  console.log(item);
}


// ════════════════════════════════════════════════════════════════════════════
// Pass 5 — hoistLoopInvariants
// ════════════════════════════════════════════════════════════════════════════

// ✓ regex literal inside loop body
for (let i = 0; i < lines.length; i++) {
  const pattern = /^#\s+(.*)$/;
  const match = lines[i].match(pattern);
  if (match) headings.push(match[1]);
}

// ✓ new RegExp with literal args
while (queue.length) {
  const re = new RegExp("\\bfoo\\b", "gi");
  process(queue.shift().replace(re, "bar"));
}

// ✗ array literal — mutable, NOT hoisted (sharing across iterations would change semantics)
for (const entry of entries) {
  const defaults = [0, 0, 0];
  merge(entry, defaults);
}

// ✓ regex hoisted; ✗ array literal NOT hoisted — tests that stmtIndex stays
//   correct when only one of two adjacent invariants is eligible for hoisting
for (let i = 0; i < items.length; i++) {
  const sep = /[,;]/;
  const defaults = [0, 0, 0];
  process(items[i].split(sep), defaults);
}

// ✗ expression uses loop variable — not invariant
for (let i = 0; i < items.length; i++) {
  const label = `item-${i}`;
  render(label, items[i]);
}

// ✗ not at top level of loop body (inside if) — bail
for (let i = 0; i < items.length; i++) {
  if (items[i].active) {
    const tag = /active/;
    mark(items[i], tag);
  }
}

// ✓ hoistable const whose name is shadowed in a nested function — rename
//   must NOT leak into the inner arrow
const re = /existing/;
for (let i = 0; i < items.length; i++) {
  const re = /^todo:/;
  const cb = (text) => { const re = /inner/; return text.match(re); };
  process(items[i].match(re), cb);
}


// ════════════════════════════════════════════════════════════════════════════
// Pass 6 — hoistFunctionInvariants
// ════════════════════════════════════════════════════════════════════════════

// ✓ regex literal inside function — hoisted before the function
function parseHeader(line) {
  const re = /^(#{1,6})\s+(.*)/;
  return line.match(re);
}

// ✓ new RegExp inside arrow function
const sanitize = (input) => {
  const dangerous = new RegExp("<script>", "gi");
  return input.replace(dangerous, "");
};

const sanitize2 = (input) => {
  const dangerous = RegExp("<script>", "gi");
  return input.replace(dangerous, "");
};

// ✗ object literal — mutable, NOT hoisted (sharing across calls would change semantics)
function getDefaults() {
  const opts = { timeout: 3000, retries: 3 };
  return { ...opts };
}

// ✗ regex uses a parameter — not invariant
function findInText(text, word) {
  const re = new RegExp(word, "gi");
  return text.match(re);
}

// ✗ non-const declaration — bail
function counter() {
  let count = 0;
  return ++count;
}
