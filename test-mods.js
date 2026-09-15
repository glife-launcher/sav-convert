#!/usr/bin/env node
// WP-154 (B-080) — the converter's mod list, offline.
//
//   node test-mods.js
//   SABOTAGE=1|2|3|all node test-mods.js     (must go RED)
//
// What it proves, and why each part matters:
//
//  A. the `includes` list is read at the same offset in BOTH formats — after
//     the 14 header fields and the playlist — so a modded save is named
//     whether the player brings it from the classic desktop player or made it
//     here. This is the list WP-152 found nothing of ours ever looked at: two
//     of four real player saves never left the title screen because of it.
//  B. `convertBuffer`'s report carries the names, so the "convert (old
//     format)" path can say it too.
//  C. a name that leaves the game folder — absolute, a drive letter, a `..`
//     segment — resolves to nothing, is reported missing, and is never opened.
//  D. the sentence a player reads.
//
// No `.qsp` and no corpus file are needed: the fixtures are built here, and
// the location table is a two-entry stand-in, because none of this touches the
// parts of the conversion the WP-30/WP-63 gates already cover.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseLegacySav } = require('./lib/legacy-sav');
const { parseModernSav } = require('./lib/modern-sav');
const convertLib = require('./lib/convert');

const SABOTAGE = process.env.SABOTAGE || '';
const on = (n) => SABOTAGE === String(n) || SABOTAGE === 'all';

// --- the sabotage hooks: one broken primitive each, all three must go red ---
if (on(1)) {                       // the escape check stops checking
  convertLib.modPathParts = (name) => String(name).split(/[\\/]/);
}
if (on(2)) {                       // the report forgets the list
  const real = convertLib.toModern;
  convertLib.toModern = (parsed, game) => {
    const out = real(parsed, game);
    out.report.mods = [];
    return out;
  };
}
if (on(3)) {                       // the sentence stops naming what is missing
  convertLib.modsNote = (mods) => (mods.length ? 'Modded playthrough' : null);
}

let failed = 0;
function check(what, ok, detail) {
  if (ok) return;
  failed++;
  console.log('FAIL  ' + what + (detail ? '\n      ' + detail : ''));
}

/** qspEncodeString: the ±5 shift every line below the engine stamp carries. */
function enc(text) {
  let out = '';
  for (const ch of text) {
    const u = ch.codePointAt(0);
    out += String.fromCharCode(u === 5 ? (-5 & 0xffff) : (u - 5) & 0xffff);
  }
  return out;
}

/**
 * A minimal save of either format carrying `includes`. The header, the
 * playlist and the includes list are spelled identically in both (qsp-legacy
 * game.c:319, libqsp game.c:274), so one builder serves both — what differs is
 * the engine stamp, the two extra action fields (there are no actions here)
 * and the variable section, which is empty in both.
 */
function fixture(engine, includes) {
  const modern = engine >= '5.9.0';
  const lines = ['QSPSAVEDGAME', engine];
  const body = [
    '0',        // game CRC
    '0',        // clock
    '-1', '-1', // selected action, selected object
    '', '', '', '',   // view path, input, main description, stats description
    'start',    // location
    '1', '1', '1', '1',  // window flags
    '0',        // timer interval
    '0',        // playlist count
    String(includes.length),
  ].concat(includes, [
    '0',        // actions count
    '0',        // objects count
  ]);
  // Variables: legacy writes one flat count, modern writes 1024 bucket counts.
  body.push(modern ? new Array(1024).fill('0').join('\r\n') : '0');
  for (const line of body) lines.push(line.split('\r\n').map(enc).join('\r\n'));
  lines.push('');
  const text = lines.join('\r\n');
  const bytes = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    bytes[i * 2] = text.charCodeAt(i) & 0xff;
    bytes[i * 2 + 1] = text.charCodeAt(i) >> 8;
  }
  return bytes;
}

/** A stand-in for `readGameBuffer`'s result: only these four fields are used. */
const GAME = {
  crc: 0,
  file: 'fake.qsp',
  locations: ['start', 'elsewhere'],
  byUpper: new Map([['START', 0], ['ELSEWHERE', 1]]),
};

const NAMES = [
  'mod/here.qsp',        // the one file the folder really has
  'mod/gone.qsp',
  '../passwd',
  '/etc/passwd',
  'C:\\Windows\\x.qsp',
  'mod/../passwd',
];

// --- A. both formats, same offset, same spelling ---------------------------
const legacy = parseLegacySav(fixture('5.7.0', NAMES));
check('the legacy reader lists the mods', String(legacy.includes) === String(NAMES),
  JSON.stringify(legacy.includes));
const modern = parseModernSav(fixture('5.9.0', NAMES));
check('the modern reader lists the same mods, at the same offset',
  String(modern.includes) === String(NAMES), JSON.stringify(modern.includes));
check('a save with no mods lists none',
  parseLegacySav(fixture('5.7.0', [])).includes.length === 0);

// --- B. the conversion report carries them ---------------------------------
const report = convertLib.toModern(legacy, GAME).report;
check('the conversion report carries the mod list',
  String(report.mods) === String(NAMES), JSON.stringify(report.mods));
check('a save with no mods reports an empty list',
  convertLib.toModern(parseLegacySav(fixture('5.7.0', [])), GAME).report.mods.length === 0);

// --- C. the host resolution, and the names that leave the folder ------------
// Two lines, the same two the CLI runs: the parts come from the shared rule,
// the existence question is the host's.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp154-'));
fs.mkdirSync(path.join(dir, 'mod'));
fs.writeFileSync(path.join(dir, 'mod', 'here.qsp'), 'never read');
fs.writeFileSync(path.join(dir, 'passwd'), 'never read either');
const missing = report.mods.filter((name) => {
  const parts = convertLib.modPathParts(name);
  return !parts || !fs.existsSync(path.join(dir, ...parts));
});
check('only the mod the folder really holds counts as present',
  String(missing) === String(NAMES.slice(1)), JSON.stringify(missing));
check('nothing outside the game folder resolves',
  ['../passwd', '/etc/passwd', 'C:\\x.qsp', 'mod/../passwd', '', '   ']
    .every((n) => convertLib.modPathParts(n) === null));
fs.rmSync(dir, { recursive: true, force: true });

// --- D. the sentence -------------------------------------------------------
check('no mods, no sentence', convertLib.modsNote([], []) === null);
check('all mods present reads as a quiet note',
  convertLib.modsNote(['a.qsp'], []) === 'Modded playthrough');
check('missing mods are named',
  convertLib.modsNote(NAMES, missing) ===
    'Modded playthrough — needs: mod/gone.qsp, ../passwd, /etc/passwd, ' +
    'C:\\Windows\\x.qsp, mod/../passwd (not found in the game folder)',
  convertLib.modsNote(NAMES, missing));
check('a long list is capped',
  /and 3 more/.test(convertLib.modsNote(
    new Array(9).fill('m.qsp'), new Array(9).fill('m.qsp'))));

if (failed) {
  console.log('\nRED — ' + failed + ' check(s) failed' + (SABOTAGE ? ' (SABOTAGE=' + SABOTAGE + ')' : ''));
  process.exit(1);
}
console.log('GREEN — the mod list is read in both formats, reaches the report, ' +
  'and no name escapes the game folder');
