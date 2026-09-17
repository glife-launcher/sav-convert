// Strict reader for a MODERN libqsp `.sav` — the mirror image of
// `legacy-sav.js`, and the front half of the REVERSE converter.
//
// It reads BOTH modern layouts (WP-242): 5.9.0, and 5.9.5, which moved the
// window flags, the action and object fields, added an object-groups section,
// halved the bucket count and SHIFTED every value type code. The layout is
// chosen by the engine stamp on line 2 — the same field the engine itself
// gates on — and the result is NORMALISED to one shape, so everything
// downstream (reverse.js above all) sees one format:
//
//   * `header.showActs/showObjs/showVars/showInput` are booleans-as-ints
//     either way; a 5.9.5 file also keeps its raw `windowsDisplayState`;
//   * an action and an object always read `{image, desc}`, whatever order the
//     file stored them in (a 5.9.5 object's `Name` IS its displayed text, so
//     it lands in `desc`, and is also kept as `name`);
//   * a value's `type` is always the 5.9.0 code (TUPLE 0, NUM 1, STR 2,
//     CODE 3, VARREF 4, UNDEF 5). 5.9.5's BOOL (2) has no 5.9.0 spelling and
//     is a number underneath (bindings/qsp.h:117), so it reads as NUM with
//     `bool: true`; `rawType` keeps the code the file actually carried.
//
// Layout transcribed from libqsp @ 9f4f29f9 `qsp/game.c:274
// (qspSaveGameStatus)` and its own acceptance gate at `:399`:
//
//   [0]  "QSPSAVEDGAME"      (not encoded)
//   [1]  engine version      (not encoded)
//   ...everything below is encoded (codec.decode)...
//   [2]  qspQstCRC of the .qsp the save was made against
//   [3]  qspGetTime()        [4] selected action   [5] selected object
//   [6]  view path           [7] input text        [8] main description
//   [9]  vars description    [10] CURRENT LOCATION NAME  [11..14] window flags
//   [15] timer interval      [16] playlist count -> that many file names
//   then: includes count -> names
//   then: actions count -> per action
//         Image, Desc, linesCount, (line, lineNum)*, Location, ActIndex
//   then: objects count -> per object: Image, Desc
//   then: 1024 BUCKETS, each: count -> per variable
//         Name, valsCount, (variant)*, indsCount, (Index, Str)*
//   then: one trailing empty line.
//
// A "variant" is a TYPE line (bindings/qsp.h:87-92 — TUPLE 0, NUM 1, STR 2,
// CODE 3, VARREF 4, UNDEF 5) followed by one payload line, except a TUPLE,
// which is followed by an item count and that many nested variants
// (coding.c qspAppendEncodedVariant). Types 3/4/5 serialise through the STRING
// branch (`BASETYPE` in game.c:399), so their payload is one text line.
//
// Everything is strict, for the same reason the legacy reader is: a converter
// that guesses at a layout produces a save that loads and then behaves wrongly.
//
// Byte-level core — takes bytes (`Uint8Array`, a node `Buffer`, or an
// `ArrayBuffer`), never a path.
(function (factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./codec'), require('./errors'));
  } else {
    var g = typeof globalThis !== 'undefined' ? globalThis : self;
    var ns = g.GLSavConvert || (g.GLSavConvert = {});
    ns.modernSav = factory(ns.codec, ns.errors);
  }
}(function (codec, errors) {
  'use strict';

  var decode = codec.decode;
  var SavFormatError = errors.SavFormatError;
  var T_TUPLE = 0, T_NUM = 1, T_STR = 2, T_CODE = 3, T_VARREF = 4, T_UNDEF = 5;
  var TYPE_NAME = ['tuple', 'number', 'string', 'code', 'variable reference', 'unset'];

  /**
   * Numeric dotted-version compare. NOT the engine's own raw string compare:
   * under that one "5.10.0" would sort below "5.9.4" and a future save would
   * be read with the wrong layout. Same reasoning as index.js.
   */
  function atLeast(stamp, floor) {
    var a = String(stamp).split('.'), b = String(floor).split('.'), i, x, y;
    for (i = 0; i < Math.max(a.length, b.length); i++) {
      x = parseInt(a[i], 10); y = parseInt(b[i], 10);
      if (isNaN(x)) x = 0;
      if (isNaN(y)) y = 0;
      if (x !== y) return x > y;
    }
    return true;
  }

  /** A file type code -> the canonical (5.9.0) one, per target. */
  function canonicalType(spec, type) {
    var k;
    for (k in spec.code) {
      if (Object.prototype.hasOwnProperty.call(spec.code, k) && spec.code[k] === type) {
        return { tuple: T_TUPLE, num: T_NUM, str: T_STR, code: T_CODE, varref: T_VARREF, undef: T_UNDEF }[k];
      }
    }
    return T_NUM; // 5.9.5's BOOL — a number underneath (bindings/qsp.h:117)
  }

  function parseModernSav(input) {
    var buf = codec.toBytes(input);
    if (!buf || buf.length < 4) {
      throw new SavFormatError('the file is empty or far too small to be a QSP save');
    }
    var container = codec.readContainer(buf);
    var ucs2 = container.ucs2;
    var lines = container.lines;
    if (lines[0] !== 'QSPSAVEDGAME') {
      throw new SavFormatError('not a QSP save file — line 1 reads ' +
        JSON.stringify(String(lines[0]).slice(0, 32)) + ', expected "QSPSAVEDGAME"');
    }
    var engineVersion = lines[1];
    // The engine gates on this same field, so it is what picks the layout:
    // 5.9.5's QSP_GAMEMIN_VER is "5.9.4" (CMakeLists.txt:4), i.e. anything
    // stamped 5.9.4 or above is the new layout.
    var spec = codec.modernTarget(atLeast(engineVersion, '5.9.4') ? '5.9.5' : '5.9.0');
    var VARSBUCKETS = spec.buckets;
    var VARSMAXBUCKETSIZE = spec.maxBucketSize;
    if (lines.length < 18) {
      throw new SavFormatError('QSP save header, but only ' + lines.length +
        ' lines — the file is truncated before the body');
    }

    var i = 0;
    var raw = function () {
      if (i >= lines.length) {
        throw new SavFormatError('the save ends in the middle of its body — the file has ' +
          lines.length + ' lines and is truncated');
      }
      return lines[i++];
    };
    var str = function () { return decode(raw()); };
    var int = function (what) {
      var at = i + 1;
      var text = str();
      if (!/^-?\d+$/.test(text)) {
        throw new SavFormatError('expected ' + what + ' (a number) on line ' + at +
          ', found ' + JSON.stringify(text.slice(0, 32)) + ' — this is not a ' + spec.ver + ' save body');
      }
      return parseInt(text, 10);
    };
    var count = function (what, max) {
      var at = i + 1;
      var n = int(what);
      if (n < 0 || n > max) {
        throw new SavFormatError(what + ' on line ' + at + ' reads ' + n +
          ' — impossible for this file (limit ' + max + '); the save is corrupt');
      }
      return n;
    };

    i = 2;
    var head = {
      bytes: buf.length,
      ucs2: ucs2,
      lineCount: lines.length,
      engineVersion: engineVersion,
      qstCRC: int('the game CRC'),
      gameTime: int('the game clock'),
      selAction: int('the selected action'),
      selObject: int('the selected object'),
      viewPath: str(),
      curInput: str(),
      curDesc: str(),
      curVars: str(),
    };
    // Modern always stores the location NAME (game.c:300) — never an ordinal.
    head.location = str();
    head.target = spec.name;
    if (spec.windowStateIsBitmask) {
      // 5.9.5 game.c:551 — one qspCurWindowsDisplayState int, bits in
      // bindings/qsp.h:44-50.
      var winState = int('the windows display state');
      head.windowsDisplayState = winState;
      head.showActs = (winState & codec.WIN_ACTS) ? 1 : 0;
      head.showObjs = (winState & codec.WIN_OBJS) ? 1 : 0;
      head.showVars = (winState & codec.WIN_VARS) ? 1 : 0;
      head.showInput = (winState & codec.WIN_INPUT) ? 1 : 0;
    } else {
      head.showActs = int('the actions-window flag');
      head.showObjs = int('the objects-window flag');
      head.showVars = int('the stats-window flag');
      head.showInput = int('the input-window flag');
    }
    head.timerInterval = int('the timer interval');

    var k, l, v;
    var playlist = [];
    var plCount = count('the playlist length', 500);   // game.c:399 QSP_MAXPLFILES
    for (k = 0; k < plCount; k++) playlist.push(str());

    var includes = [];
    var incCount = count('the includes count', 100);   // QSP_MAXINCFILES
    for (k = 0; k < incCount; k++) includes.push(str());

    var actions = [];
    var actsCount = count('the actions count', 50);    // QSP_MAXACTIONS
    for (k = 0; k < actsCount; k++) {
      // 5.9.0 game.c:327-328 Image, Desc; 5.9.5 game.c:340-341 Desc, Image.
      var image, desc;
      if (spec.actionDescFirst) { desc = str(); image = str(); } else { image = str(); desc = str(); }
      var linesCount = count('an action code length', lines.length);
      var code = [];
      for (l = 0; l < linesCount; l++) code.push([str(), int('an action line number')]);
      actions.push({
        image: image,
        desc: desc,
        code: code,
        location: int('an action location'),
        actIndex: int('an action source index'),
      });
    }

    var objects = [];
    var objsCount = count('the objects count', 1000);  // QSP_MAXOBJECTS
    for (k = 0; k < objsCount; k++) {
      // 5.9.5 game.c:354-355 stores Name + Image; its Name is the displayed
      // text (objects.h:16-19 has no Desc member any more), so it is what a
      // 5.9.0 reader calls `desc`.
      if (spec.objectNameFirst) {
        var oname = str();
        objects.push({ name: oname, desc: oname, image: str() });
      } else {
        objects.push({ image: str(), desc: str() });
      }
    }

    var objsGroups = [];
    if (spec.hasObjsGroups) {
      // 5.9.5 game.c:586-594 — absent from 5.9.0 entirely.
      var groupsCount = count('the object-groups count', 1000);
      for (k = 0; k < groupsCount; k++) {
        objsGroups.push({
          name: str(), desc: str(), image: str(),
          updatedFields: int('an object group updated-fields mask'),
          objsCount: int('an object group objects count'),
        });
      }
    }

    /** One variant: {type, num} | {type, str} | {type: 0, items: [...]}. */
    function readVariant(varName) {
      var at = i + 1;
      var type = int('a value type');
      if (type < 0 || type >= spec.baseType.length) {
        throw new SavFormatError('variable ' + varName + ' has a value of unknown type ' + type +
          ' on line ' + at + ' — this is not a ' + spec.ver + ' save body');
      }
      var canon = canonicalType(spec, type);
      var extra = (canon === T_NUM && type !== spec.code.num) ? { bool: true } : null;
      if (spec.baseType[type] === T_TUPLE) {
        var items = count('a tuple length', lines.length);
        var vals = [];
        for (var t = 0; t < items; t++) vals.push(readVariant(varName));
        return { type: canon, rawType: type, items: vals };
      }
      if (spec.baseType[type] === T_NUM) {
        var vnum = { type: canon, rawType: type, num: int('a variable number') };
        if (extra) vnum.bool = true;
        return vnum;
      }
      return { type: canon, rawType: type, str: str() };
    }

    var vars = [];
    var buckets = new Array(VARSBUCKETS);
    for (var b = 0; b < VARSBUCKETS; b++) {
      var inBucket = count('the variable count of bucket ' + b, VARSMAXBUCKETSIZE);
      buckets[b] = inBucket;
      for (v = 0; v < inBucket; v++) {
        var name = str();
        var valsCount = count('a variable value count', lines.length);
        var values = [];
        for (k = 0; k < valsCount; k++) values.push(readVariant(name));
        var indsCount = count('a variable index count', lines.length);
        var indices = [];
        for (k = 0; k < indsCount; k++) indices.push({ index: int('an array index'), key: str() });
        vars.push({ bucket: b, name: name, values: values, indices: indices });
      }
    }

    // game.c:488 — the body ends exactly on the trailing empty line, and
    // game.c:493 refuses the file when it does not.
    if (i !== lines.length - 1 || lines[lines.length - 1] !== '') {
      throw new SavFormatError('the body does not end where a ' + spec.ver + ' save should ' +
        '(stopped at line ' + i + ' of ' + lines.length + ') — the file is corrupt or ' +
        'was written by a player this converter does not know');
    }

    return {
      header: head, playlist: playlist, includes: includes,
      actions: actions, objects: objects, objsGroups: objsGroups,
      vars: vars, buckets: buckets, target: spec.name,
    };
  }

  return {
    parseModernSav: parseModernSav,
    SavFormatError: SavFormatError,
    T_TUPLE: T_TUPLE, T_NUM: T_NUM, T_STR: T_STR,
    T_CODE: T_CODE, T_VARREF: T_VARREF, T_UNDEF: T_UNDEF,
    TYPE_NAME: TYPE_NAME,
  };
}));
