// A line-for-line reimplementation of libqsp's own acceptance gate,
// `qsp/game.c:399 qspCheckGameStatus` (5.9.0 @ 9f4f29f9) and `game.c:411`
// (5.9.5 @ tag 5.9.5), plus the container checks `qspOpenGameStatus` does
// before calling it. One walk, driven by `codec.MODERN_TARGETS` — the two
// versions differ in where the body starts, in the object/group sections and
// in the bucket bounds, not in the shape of the walk.
//
// The converter runs this over its OWN OUTPUT before that output is put in
// place. If this says no, the engine would have said "Error code: 14" at load
// time — and a save that fails to load after the player was told it converted
// is exactly the failure mode this check exists to prevent.
//
// It is deliberately a separate transcription from lib/convert.js's writer: if
// the writer misreads a rule, the reader has to misread it the same way for
// the bug to survive, and the two were written from the two ends of the
// engine's source (writer from qspSaveGameStatus, this from qspCheckGameStatus).
//
// Byte-level core — takes bytes, loadable in node and in the webview.
(function (factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./codec'));
  } else {
    var g = typeof globalThis !== 'undefined' ? globalThis : self;
    var ns = g.GLSavConvert || (g.GLSavConvert = {});
    ns.modernCheck = factory(ns.codec);
  }
}(function (codec) {
  'use strict';

  var decode = codec.decode;
  var toNum = codec.toNum;
  var readContainer = codec.readContainer;
  var MAXPLFILES = 500, MAXINCFILES = 100, MAXACTIONS = 50, MAXOBJECTS = 1000;
  var BASE_TUPLE = 0, BASE_NUM = 1, BASE_STR = 2;

  /**
   * @param input   the finished save's bytes
   * @param target  '5.9.0' (default) or '5.9.5'
   * @returns { ok: true } or { ok: false, reason: string }
   */
  function checkModernSav(input, target) {
    const spec = codec.modernTarget(target);
    if (!spec) return { ok: false, reason: 'unknown modern target ' + JSON.stringify(target) };
    const VARSBUCKETS = spec.buckets;
    const VARSMAXBUCKETSIZE = spec.maxBucketSize;
    const TYPES = spec.definedTypes;   // QSP_TYPE_DEFINED_TYPES
    const BASETYPE = spec.baseType;    // qspBaseTypeTable, in 5.9.0 base codes
    const buf = codec.toBytes(input);
    if (!buf) return { ok: false, reason: 'the save was not handed over as bytes' };
    const { lines } = readContainer(buf);
    const n = lines.length;
    const bad = (reason) => ({ ok: false, reason });

    // 5.9.0 game.c:403 opens the walk at line 16 — the four window flags sit at
    // 11..14 and the timer interval at 15, all read by absolute index. 5.9.5
    // game.c:415 opens it at 12, because those four became the single bitmask
    // on line 11 and the timer interval is the walk's own first read.
    let ind = spec.bodyStart;
    if (ind >= n) return bad('fewer than ' + (spec.bodyStart + 1) + ' lines');
    if (lines[0] !== 'QSPSAVEDGAME') return bad('line 1 is not QSPSAVEDGAME');
    // qspStrsComp / qspStrsCompare is a plain lexicographic compare (text.h:241)
    if (!(lines[1] >= spec.gameMinVer)) return bad('engine stamp ' + JSON.stringify(lines[1]) + ' sorts below ' + spec.gameMinVer);
    if (!(lines[1] <= spec.ver)) return bad('engine stamp ' + JSON.stringify(lines[1]) + ' sorts above ' + spec.ver);
    // The CRC test (game.c:408) is skipped by the engine whenever the game's
    // DEBUG variable is non-zero, which Girl Life sets in start.qsrc:8, so it is
    // not asserted here — but the converter still writes the correct value.
    const num = (k) => toNum(decode(lines[k]));
    const selAction = num(4);
    const selObject = num(5);
    if (num(spec.timerLine) < 0) return bad('negative timer interval');

    const take = () => {
      if (ind >= n) return null;
      return num(ind++);
    };
    const skip = (k) => { ind += k; return ind < n; };

    ind = spec.playlistLine;
    let count = take();
    if (count === null || !skip(0)) return bad('truncated at the playlist count');
    if (count < 0 || count > MAXPLFILES) return bad('playlist count ' + count);
    if (!skip(count)) return bad('truncated inside the playlist');

    count = take();
    if (count === null) return bad('truncated at the includes count');
    if (count < 0 || count > MAXINCFILES) return bad('includes count ' + count);
    if (!skip(count)) return bad('truncated inside the includes');

    count = take();
    if (count === null) return bad('truncated at the actions count');
    if (count < 0 || count > MAXACTIONS) return bad('actions count ' + count);
    if (selAction >= count) return bad('selected action ' + selAction + ' >= ' + count + ' actions');
    for (let i = 0; i < count; i++) {
      if (!skip(2)) return bad('truncated in action ' + i + ' header');
      const groups = take();
      if (groups === null) return bad('truncated at action ' + i + ' code length');
      if (groups < 0) return bad('negative code length in action ' + i);
      for (let j = 0; j < groups; j++) {
        if (!skip(1)) return bad('truncated in action ' + i + ' code');
        const lineNum = take();
        if (lineNum === null) return bad('truncated at an action line number');
        if (lineNum < 0) return bad('negative line number in action ' + i);
      }
      const loc = take();
      if (loc === null) return bad('truncated at action ' + i + ' location');
      if (loc < 0) return bad('negative location in action ' + i);
      if (!skip(1)) return bad('truncated at action ' + i + ' source index');
    }

    count = take();
    if (count === null) return bad('truncated at the objects count');
    if (count < 0 || count > MAXOBJECTS) return bad('objects count ' + count);
    if (selObject >= count) return bad('selected object ' + selObject + ' >= ' + count + ' objects');
    if (!skip(2 * count)) return bad('truncated inside the objects');

    if (spec.hasObjsGroups) {
      // 5.9.5 game.c:471-485 — a section 5.9.0 does not have at all.
      count = take();
      if (count === null) return bad('truncated at the object-groups count');
      if (count < 0 || count > MAXOBJECTS) return bad('object-groups count ' + count);
      for (let i = 0; i < count; i++) {
        if (!skip(3)) return bad('truncated in object group ' + i + ' header');
        const updated = take();
        if (updated === null) return bad('truncated at object group ' + i + ' updated fields');
        if (updated < 0) return bad('negative updated fields in object group ' + i);
        const objs = take();
        if (objs === null) return bad('truncated at object group ' + i + ' objects count');
        if (objs < 0 || objs > MAXOBJECTS) return bad('object group ' + i + ' holds ' + objs + ' objects');
      }
    }

    const readVariant = () => {
      if (ind >= n) return { ok: false };
      const type = num(ind++);
      if (type < 0 || type >= TYPES) return { ok: false, why: 'value type ' + type };
      switch (BASETYPE[type]) {
        case BASE_TUPLE: {
          if (ind >= n) return { ok: false };
          const items = num(ind++);
          for (let i = 0; i < items; i++) {
            const r = readVariant();
            if (!r.ok) return r;
          }
          return { ok: true };
        }
        default:
          if (ind >= n) return { ok: false };
          ind++;
          return { ok: true };
      }
    };

    for (let b = 0; b < VARSBUCKETS; b++) {
      count = take();
      if (count === null) return bad('truncated at bucket ' + b);
      if (count < 0 || count > VARSMAXBUCKETSIZE) return bad('bucket ' + b + ' holds ' + count + ' variables');
      for (let v = 0; v < count; v++) {
        if (!skip(1)) return bad('truncated at a variable name in bucket ' + b);
        const valsCount = take();
        if (valsCount === null) return bad('truncated at a value count in bucket ' + b);
        if (valsCount < 0) return bad('negative value count in bucket ' + b);
        for (let k = 0; k < valsCount; k++) {
          const r = readVariant();
          if (!r.ok) return bad('bad value in bucket ' + b + (r.why ? ' — ' + r.why : ' — truncated'));
        }
        const inds = take();
        if (inds === null) return bad('truncated at an index count in bucket ' + b);
        if (inds < 0) return bad('negative index count in bucket ' + b);
        for (let k = 0; k < inds; k++) {
          const at = take();
          if (at === null) return bad('truncated at an array index in bucket ' + b);
          if (at < 0 || at >= valsCount) return bad('array index ' + at + ' out of range (' + valsCount + ' values)');
          if (!skip(1)) return bad('truncated at an array key in bucket ' + b);
        }
      }
    }
    // game.c:488 — the last line is always empty and must fall exactly where the walk stopped
    if (ind !== n - 1) return bad('body ends at line ' + ind + ' of ' + n + ', expected ' + (n - 1));
    if (lines[n - 1] !== '') return bad('the file does not end with an empty line');
    return { ok: true };
  }

  return { checkModernSav: checkModernSav };
}));
