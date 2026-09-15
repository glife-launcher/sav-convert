#!/usr/bin/env node
// Build `index.html` out of `src/page.html` and `lib/`.
//
//   node build.js            write index.html
//   node build.js --check    exit 1 if index.html is not what this would write
//
// The page is ONE file on purpose: a player opens it straight from disk, with
// no server and no build tools. So the core is inlined, in the same dependency
// order every other host of this library uses — each module registers itself on
// `self.GLSavConvert`, and `index.js` must come last.
//
// The inlined block is a plain `<script>`, so the page runs it AND can read its
// own source back with `.textContent` to build the Web Worker. One copy of the
// code, two threads.
'use strict';

const fs = require('fs');
const path = require('path');

const ORDER = [
  'lib/codec.js', 'lib/errors.js', 'lib/legacy-sav.js', 'lib/qsp-game.js',
  'lib/convert.js', 'lib/modern-check.js',
  'lib/modern-sav.js', 'lib/reverse.js', 'lib/legacy-check.js',
  'lib/index.js',
];
const MARK = '/*GL_CORE*/';

const root = __dirname;
const core = ORDER.map((rel) => fs.readFileSync(path.join(root, rel), 'utf8')).join('\n');

// A `</script>` anywhere in the core would close the tag early. None of the
// files has ever held one; this is the check that keeps it that way.
if (/<\/script/i.test(core)) {
  console.error('the core contains a </script> sequence and cannot be inlined as it is');
  process.exit(1);
}

const template = fs.readFileSync(path.join(root, 'src', 'page.html'), 'utf8');
if (template.indexOf(MARK) < 0) {
  console.error('src/page.html has no ' + MARK + ' marker');
  process.exit(1);
}
// A replacer FUNCTION, not a string: the core is full of "$" characters (the
// type prefix this format turns on), and `$&` / "$`" in a replacement string
// would splice parts of the page into the middle of the code.
const html = template.replace(MARK, () => core);
const out = path.join(root, 'index.html');

if (process.argv.includes('--check')) {
  const current = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
  if (current !== html) {
    console.error('index.html is out of date — run `node build.js`');
    process.exit(1);
  }
  console.log('index.html is up to date');
} else {
  fs.writeFileSync(out, html);
  console.log('wrote index.html (' + html.length + ' bytes, ' + ORDER.length + ' core files)');
}
