# sav-convert

Converts a QSP `.sav` between the **classic 5.7.0** format (Qqsp and the other
old desktop players) and the **modern libqsp 5.9** format (qspider and the
players built on it), in both directions. A browser page that runs offline,
two command-line tools, and a dependency-free JavaScript library.

**It converts the container, not the game data.** Carrying a save's variables
forward to a newer game version is the game's own job (Girl Life does it in
`saveupdater` when the save loads). This tool only makes the file open in the
other engine.

## Browser page

Open `index.html` from disk or any static host. Drop in the `.sav` and the
`.qsp` it belongs to; the page reads the save's engine stamp, says which way it
will convert, and offers the converted file. Nothing is uploaded.

## Command line

Node 18+, no dependencies:

```
node convert.js in.sav out.sav --qsp game.qsp              classic -> modern
node convert.js in.sav out.sav --qsp game.qsp --target 5.9.5   classic -> modern, for the new Qqsp
node reverse.js in.sav out.sav --qsp game.qsp              modern  -> classic (location as NAME, Qqsp 1.9)
node reverse.js in.sav out.sav --qsp game.qsp --loc-index  modern  -> classic (location as INDEX, stock 5.7.0)
```

`--json` gives a machine-readable report. Inputs are opened read-only, an
existing output is never overwritten, and a failed run leaves no file behind.

## Library

```js
const { convertBuffer, reverseConvertBuffer } = require('./lib/index');
const { outBytes, report } = convertBuffer({ savBytes, qspBytes, qspName });
// convertBuffer also takes target: '5.9.0' (default) | '5.9.5'
// reverseConvertBuffer adds locationAs: 'name' | 'index'
```

`lib/` uses no `fs`, no `Buffer`, no node built-ins: bytes in, bytes out.
`build.js` concatenates it into a browser bundle; `worker.js` is a ready Web
Worker entry. Errors are typed (`lib/errors.js`) and carry a sentence written
for a player.

## Two modern targets: 5.9.0 and 5.9.5

"Modern" is two formats, not one. libqsp **5.9.0** is what qspider and the
players built on it run; libqsp **5.9.5** is what the new Qqsp is built on, and
it changed the save layout. So the forward direction has to be told which
engine the file is for:

```js
convertBuffer({ savBytes, qspBytes, qspName })                    // 5.9.0, the default
convertBuffer({ savBytes, qspBytes, qspName, target: '5.9.5' })   // the new Qqsp
```

On the command line that is `--target 5.9.0|5.9.5` on `convert.js`. On the page
it is the **Modern player** control, which appears once a classic save is
loaded: *qSpider / launcher (5.9.0)*, the default, or *the new Qqsp (libqsp
5.9.5)*.

The reverse direction needs no such option: which layout a modern save is in
comes off its own engine stamp, exactly as the engine decides it. `reverse.js`
takes `--target` only to say what you EXPECT, and refuses when the file
disagrees.

**Why the two refuse each other.** 5.9.5's `QSP_GAMEMIN_VER` is `5.9.4`, so it
rejects a 5.9.0-stamped save on line 2 before it looks at anything else — and
5.9.0 rejects a 5.9.5 one the same way, for being newer than itself. Underneath
that stamp the layouts really are different: the value type codes shifted (a
`BOOL` was inserted at 2), the global hash table halved, the window flags became
one bitmask, the action and object records swapped fields, objects gained a
groups section, and line 3's checksum is computed by a different algorithm.
Write the wrong one and the only symptom is `Can't load file!`. The full table,
with file and line on both sides, is in [NOTES.md](NOTES.md).

`native-check/` holds the gate that proves it against the real thing: a
headless libqsp 5.9.5 host (`driver.c`) that opens a converted save and prints
the variables back out of the engine. Build the engine, then
`QSP_SRC=<libqsp-5.9.5> native-check/build.sh`, then point the gate at your own
saves — `node native-check/gate.js --corpus <folder> --qsp <game.qsp>`. Without
a driver binary it prints one line and SKIPs. Step-by-step in
[NOTES.md](NOTES.md).

## Two traps in the format (both fail silently)

1. **A modern save stores every string-array key with a `$` prefix.** The
   engine accepts a file without it and then reads every such key as empty.
2. **The location line holds a NAME in Qqsp 1.9 and an INDEX in stock 5.7.0
   players.** An index is only meaningful for the exact game file that wrote
   it, so a numeric location is resolved only when the save's `qspCRC` matches
   the target `.qsp`, never guessed.

Details, what was verified (nine real saves, full-state comparison, round
trip, game 0.9.9.2) and the known limits: [NOTES.md](NOTES.md).

## Tests

`npm test` runs the fixture-only tests (no game file, no save needed).

## Licence

MIT-0, see `LICENSE`. Extracted from the Girl Life Launcher project.
