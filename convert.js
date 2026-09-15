#!/usr/bin/env node
// Convert a classic-desktop-player QSP save (engine 5.7.0) into the modern
// 5.9.0 format the launcher's player understands.
//
//   node convert.js <in.sav> <out.sav> --qsp <game.qsp>
//   node convert.js <in.sav> <out.sav> --qsp <game.qsp> --json
//
// This is a THIN WRAPPER. All the format work lives in `lib/`, which is a
// byte-level core with no `fs` and no node built-ins in it — the same files run
// inside the game's webview (see `worker.js`), so converting
// an old save needs no Node.js on a player's machine. What is left here is the
// part that only makes sense on a command line: argument parsing, reading the
// two input files, the write discipline, and printing the report for a human.
//
// Rules this CLI keeps:
//   * the input .sav and the .qsp are opened READ-ONLY and never written to;
//   * it refuses to overwrite an existing output file;
//   * anything it cannot translate faithfully is an error with a sentence a
//     player can act on — it never writes a half-converted file;
//   * the output is written to a temporary file in the destination directory
//     and renamed into place, so an interrupted run leaves no partial save.
//
// Format notes and the evidence behind every rule: README.md
'use strict';

const fs = require('fs');
const path = require('path');
const { SavFormatError } = require('./lib/legacy-sav');
const { readGameBuffer } = require('./lib/qsp-game');
const { ConvertError, modPathParts, modsNote } = require('./lib/convert');
const { convertBuffer } = require('./lib/index');

const USAGE = 'usage: node convert.js <in.sav> <out.sav> --qsp <game.qsp> [--json]';

/**
 * Read a compiled game file from disk. The core takes bytes; this is the one
 * place that knows about paths. Exported because the test gates build their
 * synthetic ordinal fixtures against the real location table.
 */
function readGame(file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    throw new Error('cannot read the game file "' + file + '" (' + e.code + ')');
  }
  return readGameBuffer(buf, file);
}

function parseArgs(argv) {
  const positional = [];
  let qsp = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--qsp') {
      qsp = argv[++i];
      if (!qsp) throw new Error('--qsp needs a path to the game .qsp file');
    } else if (a === '--json') {
      json = true;
    } else if (a.startsWith('-')) {
      throw new Error('unknown option ' + a + '\n' + USAGE);
    } else {
      positional.push(a);
    }
  }
  if (positional.length !== 2) throw new Error(USAGE);
  if (!qsp) throw new Error('--qsp <game.qsp> is required: the converter needs the game file to\n' +
    'check that the save\'s location still exists and to stamp the right game checksum.\n' + USAGE);
  return { input: positional[0], output: positional[1], qsp, json };
}

/** Convert one file. Throws Error with a player-readable message on refusal. */
function convertFile({ input, output, qsp }) {
  if (!fs.existsSync(input)) throw new Error('no such save file: ' + input);
  if (fs.existsSync(output)) {
    throw new Error('refusing to overwrite an existing file: ' + output +
      '\nPick a different output name, or delete that file yourself first.');
  }
  const outDir = path.dirname(path.resolve(output));
  if (!fs.existsSync(outDir)) throw new Error('the output folder does not exist: ' + outDir);

  let bytes;
  try {
    bytes = fs.readFileSync(input);
  } catch (e) {
    if (e.code === 'EISDIR') throw new Error(input + ' is a folder, not a save file');
    throw new Error('cannot read ' + input + ' (' + (e.code || e.message) + ')');
  }
  let qspBytes;
  try {
    qspBytes = fs.readFileSync(qsp);
  } catch (e) {
    throw new Error('cannot read the game file "' + qsp + '" (' + e.code + ')');
  }

  const { outBytes, report } = convertBuffer({ savBytes: bytes, qspBytes, qspName: qsp });

  // WP-154 (B-080) — a modded playthrough is NAMED here too, so the player
  // learns before loading it why the game may come up on its title screen.
  // `lib/` reads the names out of the save; only this side, which has a
  // filesystem, can say which of them the game folder actually holds. The mod
  // files are never opened, and a name that points outside the folder is
  // reported missing rather than followed.
  const gameFolder = path.dirname(path.resolve(qsp));
  report.modsMissing = report.mods.filter((name) => {
    const parts = modPathParts(name);
    return !parts || !fs.existsSync(path.join(gameFolder, ...parts));
  });

  // Write via a temp file in the same directory so a crash cannot leave a
  // truncated .sav sitting where a player would try to load it.
  const tmp = path.join(outDir, '.' + path.basename(output) + '.tmp-' + process.pid);
  fs.writeFileSync(tmp, outBytes);
  try {
    fs.renameSync(tmp, output);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* nothing more can be done here */ }
    throw e;
  }
  return { report: Object.assign({ input, output }, report) };
}

module.exports = { convertFile, readGame };

if (require.main === module) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  let result;
  try {
    result = convertFile(args);
  } catch (e) {
    const kind = (e instanceof SavFormatError) ? 'This is not a save this converter can read'
      : (e instanceof ConvertError) ? 'This save cannot be converted'
        : 'Conversion failed';
    console.error(kind + ':\n  ' + e.message);
    process.exit(1);
  }
  const r = result.report;
  if (args.json) {
    console.log(JSON.stringify(r, null, 1));
  } else {
    console.log('converted ' + r.input + ' -> ' + r.output);
    console.log('  engine stamp   ' + r.engineVersionIn + ' -> ' + r.engineVersionOut);
    console.log('  location       ' + r.location + '  (' + r.locationSource +
      ', #' + r.locationIndexInGame + ' of ' + r.gameLocations + ')');
    console.log('  game checksum  ' + r.qstCRCIn + ' -> ' + r.qstCRCOut + '  (' + r.gameFile + ')');
    console.log('  bytes          ' + r.inputBytes + ' -> ' + r.outputBytes +
      '   lines ' + r.lineCountIn + ' -> ' + r.lineCountOut);
    console.log('  contents       ' + r.variables + ' variables, ' + r.actions +
      ' actions, ' + r.objects + ' objects');
    if (r.actions) {
      console.log('  actions        ' + r.actionCodeLinesPrepared + ' code line(s) rewritten for this engine' +
        ', attributed to #' + r.actionLocation + ' ' + r.location +
        (r.actionLocationsInFile.length ? '  (file said ' + r.actionLocationsInFile.join(', ') + ')' : ''));
    }
    const mods = modsNote(r.mods, r.modsMissing);
    if (mods) console.log('  mods           ' + mods);
    console.log('  values         ' + r.numValues + ' numbers, ' + r.strValues +
      ' strings, ' + r.undefValues + ' empty slots');
    if (r.retypeCollisions.length) {
      console.log('  NOTE: ' + r.retypeCollisions.length + ' value(s) held a number AND a string at once, ' +
        'which the modern engine cannot store. The number was kept:');
      for (const c of r.retypeCollisions) {
        console.log('        ' + c.name + (c.key ? "['" + c.key.toLowerCase() + "']" : '[' + c.slot + ']') +
          ' = ' + c.keptNumber + '   (dropped text ' + JSON.stringify(c.droppedString) + ')');
      }
    }
    if (r.paddedHoles.length) console.log('  ' + r.paddedHoles.length + ' array(s) had unwritten slots, filled in as empty');
    if (r.droppedIndices.length) console.log('  ' + r.droppedIndices.length + ' unusable array key(s) dropped');
    for (const n of r.notes) console.log('  note: ' + n);
  }
}
