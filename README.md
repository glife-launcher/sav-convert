# sav-convert — QSP saves between classic 5.7.0 and modern libqsp 5.9

A **save FORMAT converter** for QSP games. It reads a `.sav` written by a
classic desktop player (QSP 5.7.0 — Qqsp and the other old players) and writes
the same save in the format modern libqsp 5.9.x expects (qspider and the
players built on it), and it does the same in reverse.

It is a browser page you can open straight from disk, two small command-line
tools, and a dependency-free library you can drop into a player of your own.
Nothing is uploaded anywhere; there is no server side.

## What it is NOT

**It does not migrate game DATA between game versions.** A save carries the
variables of the game version it was made in; bringing those forward — new
flags, renamed variables, reworked systems — is the *game's own* job, and a
game that does it (Girl Life has a `saveupdater`) runs that migration when the
save loads. This tool only changes the container the variables sit in, so that
the newer engine can open the file at all. Once it opens, the game takes over.

Two things follow from that:

* a converted save still has to be loaded with a game version that will accept
  it — converting does not make an old save younger;
* nothing here fixes a save that is broken in the game's own terms.

## Quick start

### The browser page

1. Open `index.html` — double-click it, or serve the folder from any static
   host. No build step, no install, no network.
2. Drop in the `.sav` and the `.qsp` the save belongs to.
3. The page reads the save's own engine stamp and says which way it will
   convert, before you press anything.
4. Press **Convert** and save the file it offers.

The game file is needed for three things: to prove the location the save is
standing in still exists in that game, to stamp that game's checksum, and (in
the reverse direction, for stock 5.7.0 players) to resolve the location's
ordinal. It is read, never written.

The conversion runs in a Web Worker, because the whole `.qsp` has to be walked
(the checksum covers every byte) and that is far more than one frame's worth of
work. Not every browser will start a worker from a page opened straight off the
disk; where one refuses, the page does the work on its own thread instead —
slower, and it freezes for a moment, but it works, and a converted save beats a
dead button. The page says which of the two it used.

### The command line

Node 18 or newer, no dependencies:

```
node convert.js <in.sav> <out.sav> --qsp <game.qsp>            classic -> modern
node reverse.js <in.sav> <out.sav> --qsp <game.qsp>            modern  -> classic
node reverse.js <in.sav> <out.sav> --qsp <game.qsp> --loc-index
```

Both take `--json` for a machine-readable report. Both open the inputs
read-only, refuse to overwrite an existing output file, write through a
temporary file in the destination folder, and never leave a half-converted save
behind: anything that cannot be translated faithfully is an error with a
sentence you can act on.

`--loc-index` picks how the location is spelled in a classic save; see the
second trap below.

### The library

```js
const { convertBuffer, reverseConvertBuffer } = require('./lib/index');

const { outBytes, report } = convertBuffer({
  savBytes,          // Uint8Array / ArrayBuffer — the save
  qspBytes,          // Uint8Array / ArrayBuffer — the game file
  qspName,           // only ever printed in messages, never opened
});
```

`reverseConvertBuffer` takes the same three plus `locationAs: 'name' | 'index'`.
Both return `{ outBytes, report }` or throw.

`lib/` has **no `fs`, no `Buffer`, no node built-ins** — bytes in, bytes out.
Every file is a tiny UMD: `module.exports` under node, a slot on
`self.GLSavConvert` in a browser. Concatenate `lib/` in the order `build.js`
lists and you have a browser bundle; `worker.js` is a ready-made Web Worker
entry for a host that serves the save and the game file over HTTP. That is how
one byte-for-byte tested copy of the code runs on a command line, in a launcher
and inside a game's webview at once.

Every refusal is one of five typed errors (`lib/errors.js`) carrying a sentence
written for a player and a `kind` that survives a `postMessage` out of a
worker: `sav-format`, `convert`, `already-modern`, `already-legacy`,
`game-file`.

## Two traps in the format

Both were found the hard way, and both fail **silently** if you get them wrong.

### 1. A modern save stores every string-array key with a `$` type prefix

`qspGetVarIndex` builds its lookup key as `QSP_IND_STRID` + the uppercased key
(`variant.c`; the numeric spelling is `#`). Legacy 5.7.0 stored the bare
uppercased key. So a modern file needs the prefix — and **the engine accepts a
file without it**: `qspCheckGameStatus` never looks at key text. Verified in a
running engine by stripping the `$` from a working converted save: indexed
lookups like `$access['subscription']` or `$start_type['loc']` all read back
empty while plain variables still read fine. No error, no warning, just a game
that quietly forgets half of itself.

Same family, same silence: the acceptance gate does not check that a variable
sits in the bucket its name hashes to, so a wrong-bucket variable loads and is
then simply unreachable. The test driver re-hashes every name from the raw
bytes for exactly that reason.

### 2. The location line: NAME or INDEX, and only a checksum can tell you

Stock qsp-legacy writes the location's **index** on that line (`src/game.c`).
**Qqsp 1.9 — the player most people actually use — writes the location NAME**,
like modern libqsp does. Both spellings exist in the wild.

An ordinal is only meaningful for the exact build that wrote it: insert one
location upstream and every number after it points somewhere else. So the
converter resolves a numeric location **only** when the save's `qspCRC` matches
the target `.qsp`, and refuses otherwise rather than guessing. A name needs no
such check.

In the reverse direction you have to choose, because the two classic players
disagree: `reverse.js` writes the NAME by default (Qqsp 1.9) and the ORDINAL
with `--loc-index` (stock 5.7.0 players). Pick the wrong one and the save still
loads with all of its state — the player just starts in the wrong place. The
CLI prints which one it wrote.

## Why the codecs are hand-written

A `.sav` body is ±5-shifted text, so any UTF-16 code unit can occur — **lone
surrogates included**. `TextDecoder('utf-16le')` turns those into U+FFFD, which
loses bytes that have to survive. And the WHATWG label `"latin1"` is an alias
for **windows-1252**, not a raw byte↔code-unit map, so it cannot round-trip a
single-byte save either. Both codecs in `lib/codec.js` are therefore written by
hand. Please do not "simplify" them back to `TextDecoder`.

## What was verified

Against Girl Life, whose saves span game versions 0.9.6.1 to 0.9.9.x:

* **Nine real classic saves** — four from ordinary play, five that arrived as
  attachments on bug reports — convert, pass libqsp's own acceptance gate
  (transcribed independently of the writer, in `lib/modern-check.js`), and then
  load and play in a real modern engine with the location, the money, the date
  and the character's names matching the original bytes.
* **Full state fidelity, not a spot check**: every variable name, every value
  and every array key is compared against the source. The only differences
  permitted are the value slots the converter itself reported as lossy, and
  they must be exactly those — no more, no fewer.
* **Round trip** classic → modern → classic on four saves: every header field,
  the playlist, the mod list, every action with its code lines, every object,
  every variable and every array key came back with **zero** unexplained
  differences.
* **The input is never touched**: hashed before and after, every run.
* **Adversarial inputs** — truncated files, wrong headers, a modern save
  offered to the forward direction, a location that does not exist in the
  target game, a numeric location with a mismatched checksum — are each refused
  with a readable sentence and leave no output file behind.
* Re-run against **Girl Life 0.9.9.2** (September 2026): unchanged, everything
  above still passes.

Byte-identity of the browser page against the command line is checked too: the
page and the CLI produce the same sha256 for the same inputs.

## Known limits

* **A save's stored action list belongs to the version it was made in.** QSP
  saves the on-screen actions with their code; the game's own updater does not
  touch them. So a save carried across a big version gap can show an action
  that means something different now. This reproduces in the classic player
  too — it is not a conversion artefact. (If a converted save misbehaves, the
  first diagnostic is always: load the *same* save in the classic player
  against the *same* game version, and see whether it misbehaves there as well.)
* One value slot in a legacy save can hold a number **and** a string at once.
  The modern format cannot. The number is kept, the string is dropped, and
  every such slot is named in the report.
* Long timing-driven quests carried across a version gap cannot be tested at
  scale. They are shipped as-is and known to be so.
* The reverse direction is not byte-identical to an original classic save, by
  design: slot numbers are canonical rather than in the order the runtime
  happened to create the variables. Both are valid to the engine.

## Tests

```
npm test          # node test-mods.js, and index.html is up to date
node build.js     # rebuild index.html from src/page.html and lib/
```

`test-mods.js` needs no game file and no save: it builds its fixtures in the
script. It covers the mod (`includes`) list — read at the same offset in both
formats, carried into the report, and no name that leaves the game folder ever
resolving to a path. It has sabotage hooks (`SABOTAGE=1|2|3|all`) that must
each turn it red; that is how you check the test still tests something.

The deeper gates are corpus-driven and therefore live with their corpus rather
than in this repository. To run the same checks over **your own** saves: put
your `.sav` files in a folder, convert each with `convert.js`, confirm the CLI
reports `engine gate` clean and the location you expect, then load the result
in the target player. `reverse.js` back and a diff of the two reports is the
round trip. `*.sav` and `*.qsp` are in `.gitignore` here on purpose — no game
files and no player saves belong in this repository.

## Provenance and licence

Extracted from the Girl Life Launcher project, where this code ships inside the
launcher's webview. MIT-0 (no attribution required), see `LICENSE`.
