#!/usr/bin/env node
// Convert a MODERN QSP save back into the CLASSIC 5.7.0 format the desktop
// players understand. The mirror of `convert.js`; WP-63.
//
// Both modern layouts are read — 5.9.0 (the launcher's own player) and 5.9.5
// (the new Qqsp; WP-242). Which one a file is in comes off its own engine
// stamp, exactly as the engine decides it, so nothing has to be said on the
// command line; `--target` is only there to say what you EXPECT and be told
// when the file disagrees.
//
//   node reverse.js <in.sav> <out.sav> --qsp <game.qsp>
//   node reverse.js <in.sav> <out.sav> --qsp <game.qsp> --loc-index
//   node reverse.js <in.sav> <out.sav> --qsp <game.qsp> --json
//   node reverse.js <in.sav> <out.sav> --qsp <game.qsp> --target 5.9.5
//
// `--qsp` must point at the .qsp the CLASSIC player will open the save with.
// It is needed for three things: to prove the location the save is standing in
// still exists there, to stamp that game's checksum, and (with --loc-index) to
// resolve the location's ordinal in its table.
//
// `--loc-index` picks which spelling goes on line 10 of the save, and the two
// classic players disagree about it (see lib/reverse.js, note 1):
//   default      the location NAME  — Qqsp 1.9, the player Girl Life players
//                                     use, and the one this repo's classic
//                                     save corpus came from;
//   --loc-index  the location ORDINAL — stock QSP 5.7.0 players (the qsp.dll
//                                     bundled in the game's tools/ folder).
// Pick the wrong one and the save still LOADS with all of its state; the
// player simply starts in the wrong location. The CLI says which one it wrote.
//
// This is a THIN WRAPPER. All the format work lives in `lib/`, which is a
// byte-level core with no `fs` and no node built-ins in it. Rules this CLI
// keeps, same as the forward one:
//   * the input .sav and the .qsp are opened READ-ONLY and never written to;
//   * it refuses to overwrite an existing output file;
//   * anything it cannot translate faithfully is an error with a sentence a
//     player can act on — it never writes a half-converted file;
//   * the output is written to a temporary file in the destination directory
//     and renamed into place, so an interrupted run leaves no partial save;
//   * everything lossy is COUNTED and printed, never dropped in silence.
//
// Format notes and the evidence behind every rule: README.md §6
'use strict';

const fs = require('fs');
const path = require('path');
const { SavFormatError } = require('./lib/modern-sav');
const { ConvertError } = require('./lib/reverse');
const { reverseConvertBuffer } = require('./lib/index');

const USAGE = 'usage: node reverse.js <in.sav> <out.sav> --qsp <game.qsp> [--loc-index] [--json]\n' +
  '                       [--target 5.9.0|5.9.5]\n' +
  '  --target  the modern layout you EXPECT the input to be in. The layout is\n' +
  '            read off the save\'s own engine stamp either way; this only turns\n' +
  '            a surprise into a refusal instead of a conversion.';

function parseArgs(argv) {
  const positional = [];
  let qsp = null;
  let json = false;
  let locationAs = 'name';
  let target = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--qsp') {
      qsp = argv[++i];
      if (!qsp) throw new Error('--qsp needs a path to the game .qsp file');
    } else if (a === '--json') {
      json = true;
    } else if (a === '--target') {
      target = argv[++i];
      if (!target) throw new Error('--target needs an engine version (5.9.0 or 5.9.5)');
    } else if (a === '--loc-index') {
      locationAs = 'index';
    } else if (a.startsWith('-')) {
      throw new Error('unknown option ' + a + '\n' + USAGE);
    } else {
      positional.push(a);
    }
  }
  if (positional.length !== 2) throw new Error(USAGE);
  if (!qsp) throw new Error('--qsp <game.qsp> is required: the converter needs the game file the\n' +
    'CLASSIC player will open, to check that the save\'s location exists in it and to stamp\n' +
    'the right game checksum.\n' + USAGE);
  return { input: positional[0], output: positional[1], qsp, json, locationAs, target };
}

/** Convert one file. Throws Error with a player-readable message on refusal. */
function reverseFile({ input, output, qsp, locationAs, target }) {
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

  const { outBytes, report } = reverseConvertBuffer({ savBytes: bytes, qspBytes, qspName: qsp, locationAs });
  if (target && report.target !== target) {
    throw new Error('this save is in the ' + report.target + ' layout, not the ' + target +
      ' one you asked for (its engine stamp reads ' + report.engineVersionIn + ')');
  }

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

module.exports = { reverseFile };

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
    result = reverseFile(args);
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
    console.log('  location       ' + r.location + '  (written as the ' +
      (r.locationAs === 'index' ? 'ORDINAL ' + r.locationField + ' — stock QSP 5.7.0 players'
        : 'NAME — Qqsp 1.9') + ', #' + r.locationIndexInGame + ' of ' + r.gameLocations + ')');
    console.log('  game checksum  ' + r.qstCRCIn + ' -> ' + r.qstCRCOut + '  (' + r.gameFile + ')');
    if (r.crcChanged) {
      console.log('  NOTE: the save was made against a DIFFERENT build of the game than ' + r.gameFile +
        '.\n        The file is stamped for the game above, and Girl Life\'s own debug flag makes both\n' +
        '        engines skip the checksum test — but a save can only be as loadable as the game\n' +
        '        version it lands in allows. Open it with the version you played.');
    }
    console.log('  bytes          ' + r.inputBytes + ' -> ' + r.outputBytes +
      '   lines ' + r.lineCountIn + ' -> ' + r.lineCountOut);
    console.log('  contents       ' + r.variables + ' variables, ' + r.actions +
      ' actions, ' + r.objects + ' objects');
    console.log('  values         ' + r.numValues + ' numbers, ' + r.strValues +
      ' strings, ' + r.emptyValues + ' empty slots');
    console.log('  slots          256 blocks of 50, fullest block holds ' + r.maxBlockLoad);
    if (r.variablesIn !== r.variables) {
      console.log('  NOTE: ' + (r.variablesIn - r.variables) + ' of ' + r.variablesIn +
        ' variables did not come across:');
      for (const d of r.droppedVariables) console.log('        ' + JSON.stringify(d.name) + ' — ' + d.why);
    }
    if (r.downgradedValues.length) {
      console.log('  NOTE: ' + r.downgradedValues.length + ' value(s) had a type QSP 5.7.0 does not ' +
        'have and were written as plain text:');
      for (const d of r.downgradedValues.slice(0, 10)) {
        console.log('        ' + d.name + '[' + d.slot + '] (' + d.type + ') = ' + JSON.stringify(d.text));
      }
      if (r.downgradedValues.length > 10) console.log('        … and ' + (r.downgradedValues.length - 10) + ' more');
    }
    if (r.strippedNames.length) console.log('  ' + r.strippedNames.length + ' variable name(s) carried a "$" and were renamed without it');
    if (r.keysWithoutPrefix.length) console.log('  ' + r.keysWithoutPrefix.length + ' array key(s) had no "$" type prefix and were copied as they were');
    for (const n of r.notes) console.log('  note: ' + n);
  }
}
