const items = [];
const items_length$2 = items.length || 0;
for (let i = 0; i !== items_length$2; ++i) {
  console.log(items[i]);
}
const node_properties_length = node.properties.length || 0;
for (var i = 0; i !== node_properties_length; ++i) {
  visit(node.properties[i]);
}
for (let k = 0; k !== data.length; k++) {
  handle(data[k]);
}
const data_length = data.length || 0;
for (k = 0; k !== data_length; ++k) {
  handle(data[k]);
}
const data_length$2 = data.length || 0;
for (let k = 1; k <= data_length$2; ++k) {
  handle(data[k]);
}
const data_bound = data.length - 1 || 0;
for (let k = -1; k <= data_bound; ++k) {
  handle(data[k]);
}
const items_length = 99;
const items_length$3 = items.length || 0;
for (let i = 0; i !== items_length$3; ++i) {
  console.log(items_length, items[i]);
}
const arguments_length = arguments.length || 0;
for (var sent$e = [], sent$t = 0; sent$t !== arguments_length; ++sent$t) {
  sent$e.push(arguments[sent$t]);
}
for (let i = 0; i < items.length; i++) {
  items.push(items[i] * 2);
}
for (let i = 0; i < items.length; i++) {
  items.splice(i, 1);
}
const items_length$4 = items.length || 0;
for (let i = 0; i !== items_length$4; ++i) {
  otherArr.push(items[i]);
}
const config = loadConfig();
const MAX = 100;
const {
  a,
  b
} = getCoords();
let x = 0;
x = computeX();
let y = 1;
y++;
let uninit;
uninit = fetch();
var stable = 42;
if (items[Symbol.iterator] === [][Symbol.iterator]) {
  const items_length = items.length || 0;
  for (let _i = 0; _i !== items_length; ++_i) {
    if (!(_i in items))
      continue;
    const item = items[_i];
    console.log(item);
  }
} else {
  items.forEach(item => {
    console.log(item);
  });
}
if (items[Symbol.iterator] === [][Symbol.iterator]) {
  const items_length = items.length || 0;
  for (let idx = 0; idx !== items_length; ++idx) {
    if (!(idx in items))
      continue;
    const item = items[idx];
    console.log(idx, item);
  }
} else {
  items.forEach((item, idx) => {
    console.log(idx, item);
  });
}
if (items[Symbol.iterator] === [][Symbol.iterator]) {
  const items_length = items.length || 0;
  for (let _i = 0; _i !== items_length; ++_i) {
    if (!(_i in items))
      continue;
    const item = items[_i];
    console.log(item);
  }
} else {
  items.forEach(item => console.log(item));
}
if (items[Symbol.iterator] === [][Symbol.iterator]) {
  const items_length = items.length || 0;
  for (let _i = 0; _i !== items_length; ++_i) {
    if (!(_i in items))
      continue;
    const item = items[_i];
    process(item);
  }
} else {
  items.forEach(function(item) {
    process(item);
  });
}
if (items[Symbol.iterator] === [][Symbol.iterator]) {
  const items_length = items.length || 0;
  for (let _i = 0; _i !== items_length; ++_i) {
    if (!(_i in items))
      continue;
    const item = items[_i];
    if (item.skip)
      continue;
    process(item);
  }
} else {
  items.forEach(item => {
    if (item.skip)
      return;
    process(item);
  });
}
if (items[Symbol.iterator] === [][Symbol.iterator]) {
  const items_length = items.length || 0;
  for (let _i = 0; _i !== items_length; ++_i) {
    if (!(_i in items))
      continue;
    const item = items[_i];
    if (!item) {
      log('missing');
      continue;
    }
    render(item);
  }
} else {
  items.forEach(item => {
    if (!item)
      return log('missing');
    render(item);
  });
}
if (items[Symbol.iterator] === [][Symbol.iterator]) {
  const items_length = items.length || 0;
  _forEach:
    for (let _i = 0; _i !== items_length; ++_i) {
      if (!(_i in items))
        continue;
      const item = items[_i];
      const item_subs_length = item.subs.length || 0;
      for (let j = 0; j !== item_subs_length; ++j) {
        if (item.subs[j].done)
          continue _forEach;
        process(item.subs[j]);
      }
      finalize(item);
    }
} else {
  items.forEach(item => {
    const item_subs_length = item.subs.length || 0;
    for (let j = 0; j !== item_subs_length; ++j) {
      if (item.subs[j].done)
        return;
      process(item.subs[j]);
    }
    finalize(item);
  });
}
if (items[Symbol.iterator] === [][Symbol.iterator]) {
  const items_length = items.length || 0;
  for (let _i = 0; _i !== items_length; ++_i) {
    if (!(_i in items))
      continue;
    const item = items[_i];
    const mapped = item.subs.map(sub => {
      if (sub.bad)
        return null;
      return sub.value;
    });
    process(mapped);
  }
} else {
  items.forEach(item => {
    const mapped = item.subs.map(sub => {
      if (sub.bad)
        return null;
      return sub.value;
    });
    process(mapped);
  });
}
if (items[Symbol.iterator] === [][Symbol.iterator]) {
  const items_length = items.length || 0;
  for (let _i$2 = 0; _i$2 !== items_length; ++_i$2) {
    if (!(_i$2 in items))
      continue;
    const item = items[_i$2];
    const _i = getIndex();
    console.log(_i, item);
  }
} else {
  items.forEach(item => {
    const _i = getIndex();
    console.log(_i, item);
  });
}
if (items[Symbol.iterator] === [][Symbol.iterator]) {
  const items_length$2 = items.length || 0;
  for (let _i = 0; _i !== items_length$2; ++_i) {
    if (!(_i in items))
      continue;
    const item = items[_i];
    const items_length = item.count;
    console.log(items_length);
  }
} else {
  items.forEach(item => {
    const items_length = item.count;
    console.log(items_length);
  });
}
items.forEach(function(item) {
  this.process(item);
}, context);
items.forEach(function(item) {
  this.count++;
});
items.forEach(function(item) {
  console.log(arguments.length);
});
const sparse = [
  1, ,
  3
];
if (sparse[Symbol.iterator] === [][Symbol.iterator]) {
  const sparse_length = sparse.length || 0;
  for (let _i = 0; _i !== sparse_length; ++_i) {
    if (!(_i in sparse))
      continue;
    const v = sparse[_i];
    console.log(v);
  }
} else {
  sparse.forEach(v => {
    console.log(v);
  });
}
if (items[Symbol.iterator] === [][Symbol.iterator]) {
  const items_length = items.length || 0;
  for (let _i = 0; _i !== items_length; ++_i) {
    const item = items[_i];
    console.log(item);
  }
} else {
  for (const item of items) {
    console.log(item);
  }
}
if (items[Symbol.iterator] === [][Symbol.iterator]) {
  const items_length = items.length || 0;
  for (let _i = 0; _i !== items_length; ++_i) {
    const item = items[_i];
    console.log(item);
  }
} else {
  for (let item of items) {
    console.log(item);
  }
}
for (const {
    name,
    age
  }
  of items) {
  console.log(name, age);
}
for (var item of items) {
  console.log(item);
}
const lines_length = lines.length || 0;
const pattern$2 = /^#\s+(.*)$/;
for (let i = 0; i !== lines_length; ++i) {
  const match = lines[i].match(pattern$2);
  if (match)
    headings.push(match[1]);
}
const re$2 = new RegExp('\\bfoo\\b', 'gi');
while (queue.length) {
  process(queue.shift().replace(re$2, 'bar'));
}
const sep$2 = /[,;]/;
const defaults$3 = [
  0,
  0,
  0
];
if (entries[Symbol.iterator] === [][Symbol.iterator]) {
  const entries_length = entries.length || 0;
  const defaults$2 = [
    0,
    0,
    0
  ];
  for (let _i = 0; _i !== entries_length; ++_i) {
    const entry = entries[_i];
    merge(entry, defaults$2);
  }
} else {
  const defaults$2 = [
    0,
    0,
    0
  ];
  for (const entry of entries) {
    merge(entry, defaults$2);
  }
}
const items_length$5 = items.length || 0;
for (let i = 0; i !== items_length$5; ++i) {
  process(items[i].split(sep$2), defaults$3);
}
const items_length$6 = items.length || 0;
for (let i = 0; i !== items_length$6; ++i) {
  const label = `item-${ i }`;
  render(label, items[i]);
}
const items_length$7 = items.length || 0;
for (let i = 0; i !== items_length$7; ++i) {
  if (items[i].active) {
    const tag = /active/;
    mark(items[i], tag);
  }
}
const re$3 = /^todo:/;
const re = /existing/;
const items_length$8 = items.length || 0;
for (let i = 0; i !== items_length$8; ++i) {
  const re$2 = /inner/;
  const cb = text => {
    return text.match(re$2);
  };
  process(items[i].match(re$3), cb);
}
const re$4 = /^(#{1,6})\s+(.*)/;

function parseHeader(line) {
  return line.match(re$4);
}
const dangerous$2 = new RegExp('<script>', 'gi');
const sanitize = input => {
  return input.replace(dangerous$2, '');
};
const sanitize2 = input => {
  const dangerous = RegExp('<script>', 'gi');
  return input.replace(dangerous, '');
};
const opts$2 = {
  timeout: 3000,
  retries: 3
};

function getDefaults() {
  return {
    ...opts$2
  };
}

function findInText(text, word) {
  const re = new RegExp(word, 'gi');
  return text.match(re);
}

function counter() {
  let count = 0;
  return ++count;
}
