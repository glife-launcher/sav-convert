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
node reverse.js in.sav out.sav --qsp game.qsp              modern  -> classic (location as NAME, Qqsp 1.9)
node reverse.js in.sav out.sav --qsp game.qsp --loc-index  modern  -> classic (location as INDEX, stock 5.7.0)
```

`--json` gives a machine-readable report. Inputs are opened read-only, an
existing output is never overwritten, and a failed run leaves no file behind.

## Library

```js
const { convertBuffer, reverseConvertBuffer } = require('./lib/index');
const { outBytes, report } = convertBuffer({ savBytes, qspBytes, qspName });
// reverseConvertBuffer adds locationAs: 'name' | 'index'
```

`lib/` uses no `fs`, no `Buffer`, no node built-ins: bytes in, bytes out.
`build.js` concatenates it into a browser bundle; `worker.js` is a ready Web
Worker entry. Errors are typed (`lib/errors.js`) and carry a sentence written
for a player.

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
