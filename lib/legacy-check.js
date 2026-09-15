// A line-for-line reimplementation of qsp-legacy 5.7.0's OWN acceptance gate,
// `src/game.c:404 qspCheckGameStatus` (@ 16b85ac) — the mirror image of
// `modern-check.js`, and for the same purpose: the REVERSE converter runs this
// over its own output before that output is put in place. If this says no, the
// classic player would have said "Can't load file" (QSP_ERR_CANTLOADFILE) and
// the player would be holding a save that does not open.
//
// It is deliberately a SEPARATE transcription from `reverse.js`'s writer: the
// writer was built from `qspSaveGameStatusToString` (game.c:325), this from
// `qspCheckGameStatus`, so a misreading has to occur twice in the same
// direction to survive.
//
// Three rules here have no counterpart on the modern side and every one of
// them is a way to hand a player a broken save:
//
//   * line 10 (the current location) is read with `qspReCodeGetIntVal`, i.e.
//     `qspStrToNum` with no validity check (text.c:341), so a NAME parses as 0
//     and passes the `>= 0` test. Stock qsp-legacy then stands the player in
//     location 0. That is a real divergence between classic players, not a
//     format error — see reverse.js and the README's §6.
//   * every action carries TWO more fields than a modern one, and
//     `StartLine` must be >= 0.
//   * the variable slot numbers must be STRICTLY ASCENDING and below
//     QSP_VARSCOUNT (12 800): `if (temp <= lastInd || temp >= QSP_VARSCOUNT)`.
//     The reader then drops each variable at `qspVars[thatSlot]` verbatim
//     (game.c:551), so the slot is not a hint — it is the address the engine
//     will look the variable up at.
//
// Byte-level core — takes bytes, loadable in node and in the webview.
(function (factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./codec'));
  } else {
    var g = typeof globalThis !== 'undefined' ? globalThis : self;
    var ns = g.GLSavConvert || (g.GLSavConvert = {});
    ns.legacyCheck = factory(ns.codec);
  }
}(function (codec) {
  'use strict';

  var decode = codec.decode;
  var toNum = codec.toNum;
  var readContainer = codec.readContainer;
  var VARSCOUNT = codec.VARSCOUNT;

  var GAMEMINVER = '5.7.0'; // qsp-legacy CMakeLists.txt:4 QSP_LEGACY_GAMEMIN_VER
  var VER = '5.7.0';        // qsp-legacy CMakeLists.txt:2 project(... VERSION 5.7.0)
  var MAXPLFILES = 500, MAXINCFILES = 100, MAXACTIONS = 50, MAXOBJECTS = 1000;

  /**
   * @returns { ok: true } or { ok: false, reason: string }
   */
  function checkLegacySav(input) {
    const buf = codec.toBytes(input);
    if (!buf) return { ok: false, reason: 'the save was not handed over as bytes' };
    const { lines } = readContainer(buf);
    const n = lines.length;
    const bad = (reason) => ({ ok: false, reason });

    let ind = 17;
    if (ind > n) return bad('fewer than 17 lines');
    if (lines[0] !== 'QSPSAVEDGAME') return bad('line 1 is not QSPSAVEDGAME');
    // qspStrsComp is a plain code-unit compare (text.c), same as modern's
    if (!(lines[1] >= GAMEMINVER)) return bad('engine stamp ' + JSON.stringify(lines[1]) + ' sorts below ' + GAMEMINVER);
    if (!(lines[1] <= VER)) return bad('engine stamp ' + JSON.stringify(lines[1]) + ' sorts above ' + VER);
    // The CRC test (game.c:414) is skipped whenever the game's DEBUG variable
    // is non-zero, which Girl Life sets in start.qsrc:8 — and it is read from
    // the state that is loaded AT THAT MOMENT, which no offline check can see.
    // The converter writes the target game's own CRC regardless.
    const num = (k) => toNum(decode(lines[k]));
    const selAction = num(4);
    const selObject = num(5);
    if (num(10) < 0) return bad('negative current location');
    if (num(15) < 0) return bad('negative timer interval');

    let temp = num(16);
    if (temp < 0 || temp > MAXPLFILES || (ind += temp) > n) return bad('playlist count ' + temp);
    if (ind + 1 > n) return bad('truncated at the includes count');
    temp = num(ind++);
    if (temp < 0 || temp > MAXINCFILES || (ind += temp) > n) return bad('includes count ' + temp);
    if (ind + 1 > n) return bad('truncated at the actions count');
    let count = num(ind++);
    if (count < 0 || count > MAXACTIONS) return bad('actions count ' + count);
    if (selAction >= count) return bad('selected action ' + selAction + ' >= ' + count + ' actions');
    for (let i = 0; i < count; i++) {
      if ((ind += 2) > n) return bad('truncated in action ' + i + ' header');
      if (ind + 1 > n) return bad('truncated at action ' + i + ' code length');
      const linesCount = num(ind++);
      if (linesCount < 0 || (ind + 2 * linesCount) > n) return bad('code length ' + linesCount + ' in action ' + i);
      for (let j = 0; j < linesCount; j++) {
        ++ind;
        if (num(ind++) < 0) return bad('negative line number in action ' + i);
      }
      if (ind + 1 > n) return bad('truncated at action ' + i + ' location');
      if (num(ind++) < 0) return bad('negative location in action ' + i);
      if (++ind > n) return bad('truncated at action ' + i + ' source index');
      if (ind + 1 > n) return bad('truncated at action ' + i + ' start line');
      if (num(ind++) < 0) return bad('negative start line in action ' + i);
      if (++ind > n) return bad('truncated at action ' + i + ' manage-lines flag');
    }
    if (ind + 1 > n) return bad('truncated at the objects count');
    temp = num(ind++);
    if (temp < 0 || temp > MAXOBJECTS) return bad('objects count ' + temp);
    if (selObject >= temp) return bad('selected object ' + selObject + ' >= ' + temp + ' objects');
    if ((ind += 2 * temp) > n) return bad('truncated inside the objects');
    if (ind + 1 > n) return bad('truncated at the variables count');
    count = num(ind++);
    if (count < 0) return bad('variables count ' + count);
    let lastInd = -1;
    for (let i = 0; i < count; i++) {
      if (ind + 1 > n) return bad('truncated at the slot of variable ' + i);
      temp = num(ind++);
      if (temp <= lastInd) return bad('variable ' + i + ' sits in slot ' + temp + ', which is not above the previous slot ' + lastInd);
      if (temp >= VARSCOUNT) return bad('variable ' + i + ' sits in slot ' + temp + ' (limit ' + VARSCOUNT + ')');
      lastInd = temp;
      if (++ind > n) return bad('truncated at the name of variable ' + i);
      if (ind + 1 > n) return bad('truncated at the value count of variable ' + i);
      temp = num(ind++);
      if (temp < 0 || (ind += 2 * temp) > n) return bad('value count ' + temp + ' on variable ' + i);
      if (ind + 1 > n) return bad('truncated at the index count of variable ' + i);
      temp = num(ind++);
      if (temp < 0 || (ind += 2 * temp) > n) return bad('index count ' + temp + ' on variable ' + i);
    }
    // The legacy gate itself stops here — unlike modern (game.c:493) it does
    // NOT require the walk to land on the trailing empty line. The writer
    // still emits one, because qspCodeWriteVal appends the delimiter after
    // every field (coding.c), so this is checked as a writer invariant rather
    // than as an engine rule.
    return { ok: true, endIndex: ind, lineCount: n, endsWhereExpected: ind === n - 1 && lines[n - 1] === '' };
  }

  return { checkLegacySav: checkLegacySav };
}));
