// Strict reader for a MODERN libqsp `.sav` (engine stamp 5.9.0) — the mirror
// image of `legacy-sav.js`, and the front half of the REVERSE converter.
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
  var VARSBUCKETS = codec.VARSBUCKETS;
  var VARSMAXBUCKETSIZE = codec.VARSMAXBUCKETSIZE;

  var T_TUPLE = 0, T_NUM = 1, T_STR = 2, T_CODE = 3, T_VARREF = 4, T_UNDEF = 5;
  var TYPE_NAME = ['tuple', 'number', 'string', 'code', 'variable reference', 'unset'];
  // game.c:399 BASETYPE — which branch of the writer each type went through
  var BASETYPE = [T_TUPLE, T_NUM, T_STR, T_STR, T_STR, T_STR];

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
          ', found ' + JSON.stringify(text.slice(0, 32)) + ' — this is not a 5.9.0 save body');
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
    head.showActs = int('the actions-window flag');
    head.showObjs = int('the objects-window flag');
    head.showVars = int('the stats-window flag');
    head.showInput = int('the input-window flag');
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
      var image = str();
      var desc = str();
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
    for (k = 0; k < objsCount; k++) objects.push({ image: str(), desc: str() });

    /** One variant: {type, num} | {type, str} | {type: 0, items: [...]}. */
    function readVariant(varName) {
      var at = i + 1;
      var type = int('a value type');
      if (type < 0 || type >= BASETYPE.length) {
        throw new SavFormatError('variable ' + varName + ' has a value of unknown type ' + type +
          ' on line ' + at + ' — this is not a 5.9.0 save body');
      }
      if (BASETYPE[type] === T_TUPLE) {
        var items = count('a tuple length', lines.length);
        var vals = [];
        for (var t = 0; t < items; t++) vals.push(readVariant(varName));
        return { type: type, items: vals };
      }
      if (BASETYPE[type] === T_NUM) return { type: type, num: int('a variable number') };
      return { type: type, str: str() };
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
      throw new SavFormatError('the body does not end where a 5.9.0 save should ' +
        '(stopped at line ' + i + ' of ' + lines.length + ') — the file is corrupt or ' +
        'was written by a player this converter does not know');
    }

    return {
      header: head, playlist: playlist, includes: includes,
      actions: actions, objects: objects, vars: vars, buckets: buckets,
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
