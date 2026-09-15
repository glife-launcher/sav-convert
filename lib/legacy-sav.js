// Strict reader for a CLASSIC-desktop-player `.sav` (engine stamp 5.7.0).
//
// Layout transcribed from qsp-legacy 5.7.0 @ 16b85ac, `src/game.c:319`
// (`qspSaveGameStatusToString`) and its reader at `:463`:
//
//   [0]  "QSPSAVEDGAME"      (not encoded)
//   [1]  engine version      (not encoded)
//   ...everything below is encoded (codec.decode)...
//   [2]  qspQstCRC of the .qsp the save was made against
//   [3]  qspGetTime()        [4] selected action   [5] selected object
//   [6]  view path           [7] input text        [8] main description
//   [9]  vars description    [10] CURRENT LOCATION [11..14] window flags
//   [15] timer interval      [16] playlist count -> that many file names
//   then: includes count -> names
//   then: actions count -> per action
//         Image, Desc, linesCount, (line, lineNum)*,
//         Location, ActIndex, StartLine, IsManageLines      <- last two are
//                                                              LEGACY-ONLY
//   then: objects count -> per object: Image, Desc
//   then: total variable count -> per variable
//         hashSlot, Name, valsCount, (Num, Str)*, indsCount, (Index, Str)*
//   then: one trailing empty line.
//
// FIELD 10 — INDEX OR NAME.  Stock qsp-legacy writes `qspCurLoc`, an ordinal
// into the game's location table.  The player Girl Life actually ships with —
// Qqsp 1.9 (`girl life/qqspWin32_1.9 newset version/`, whose `qqsp.ini` records
// `lastGame=.../Girl Life 0.9.6.1.qsp`) — writes the location NAME there
// instead, like modern libqsp does; every file in the legacy save corpus this
// reader was built against carries a name.  Both spellings are accepted here
// and the caller is told which one it got, because resolving an ordinal against
// a DIFFERENT game version is guesswork and has to be flagged as such.
//
// The whole walk is strict: a count that does not fit, or a body that does not
// end exactly on the trailing empty line, is an error. A converter that
// guesses produces a save that loads and then behaves wrongly, which is worse
// than refusing.
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
    ns.legacySav = factory(ns.codec, ns.errors);
  }
}(function (codec, errors) {
  'use strict';

  var decode = codec.decode;
  var SavFormatError = errors.SavFormatError;

  function parseLegacySav(input) {
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
          ', found ' + JSON.stringify(text.slice(0, 32)) + ' — this is not a 5.7.0 save body');
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
    var locField = str();
    head.locationIsIndex = /^-?\d+$/.test(locField);
    head.locationField = locField;
    head.showActs = int('the actions-window flag');
    head.showObjs = int('the objects-window flag');
    head.showVars = int('the stats-window flag');
    head.showInput = int('the input-window flag');
    head.timerInterval = int('the timer interval');

    var k, l, v;
    var playlist = [];
    var plCount = count('the playlist length', 500);
    for (k = 0; k < plCount; k++) playlist.push(str());

    var includes = [];
    var incCount = count('the includes count', 100);
    for (k = 0; k < incCount; k++) includes.push(str());

    var actions = [];
    var actsCount = count('the actions count', 50); // legacy actions.h QSP_MAXACTIONS
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
        startLine: int('an action start line'),      // legacy-only
        isManageLines: int('an action manage flag'), // legacy-only
      });
    }

    var objects = [];
    var objsCount = count('the objects count', 1000);
    for (k = 0; k < objsCount; k++) objects.push({ image: str(), desc: str() });

    var vars = [];
    var varsCount = count('the variables count', 12800); // legacy variables.h QSP_VARSCOUNT
    for (k = 0; k < varsCount; k++) {
      var slot = int('a variable hash slot');
      var name = str();
      var valsCount = count('a variable value count', lines.length);
      var values = [];
      for (v = 0; v < valsCount; v++) values.push({ num: int('a variable number'), str: str() });
      var indsCount = count('a variable index count', lines.length);
      var indices = [];
      for (v = 0; v < indsCount; v++) indices.push({ index: int('an array index'), key: str() });
      vars.push({ slot: slot, name: name, values: values, indices: indices });
    }

    // legacy game.c:463 splits and walks exactly the way this function does; a
    // save that does not land exactly on the trailing empty line is not a save
    // this reader understands, and converting it would be guessing.
    if (i !== lines.length - 1 || lines[lines.length - 1] !== '') {
      throw new SavFormatError('the body does not end where a 5.7.0 save should ' +
        '(stopped at line ' + i + ' of ' + lines.length + ') — the file is corrupt or ' +
        'was written by a player this converter does not know');
    }

    return { header: head, playlist: playlist, includes: includes, actions: actions, objects: objects, vars: vars };
  }

  return { parseLegacySav: parseLegacySav, SavFormatError: SavFormatError };
}));
