// Read the location-name table (and the CRC) out of a compiled `.qsp`.
//
// The converter needs this for three things:
//   1. to prove the location a legacy save is standing in still EXISTS in the
//      game the user is about to load it into,
//   2. to resolve a location INDEX to a name, for saves written by a player
//      that stores the ordinal rather than the name (stock qsp-legacy does),
//   3. to stamp the modern save with the right `qspQstCRC` (game.c:197/266).
//
// Format (libqsp qsp/game.c:168-262 `qspCheckGame` / `qspOpenGame`), CRLF-
// separated, every field after line 0 "encoded" (codec.decode):
//   new format, line 0 == "QSPGAME" (game.h:26):
//     [0] QSPGAME  [1] author/tool  [2] password  [3] locations count
//     then per location: Name, Desc, OnVisitCode, actionsCount,
//     then per action:   Image, Desc, OnPressCode
//   old format, line 0 == a plain number: that number is the location count,
//     the table starts at line 30 and every location has exactly 20 actions
//     with 2 fields each (no Image).
//
// The file is ~90 MB, so lines are located by scanning for the delimiter in
// the raw bytes and only the fields actually needed are DECODED — `skip()`
// walks a line without ever building a string for it. That laziness is what
// keeps the parse affordable in a webview, where there is no native
// `Buffer.indexOf` / `Buffer.toString` to lean on.
//
// Byte-level core — takes the bytes, never a path. The file-reading wrapper
// lives in the CLI (`tools/sav-convert/convert.js`).
(function (factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./codec'), require('./errors'));
  } else {
    var g = typeof globalThis !== 'undefined' ? globalThis : self;
    var ns = g.GLSavConvert || (g.GLSavConvert = {});
    ns.qspGame = factory(ns.codec, ns.errors);
  }
}(function (codec, errors) {
  'use strict';

  var decode = codec.decode;
  var toNum = codec.toNum;
  var qspCRC = codec.qspCRC;
  var GameFileError = errors.GameFileError;

  var MAXACTIONS = 512; // libqsp declarations.h QSP_MAXACTIONS; sanity bound only

  /** Offset of the next CRLF at or after `from`, or -1. */
  function findDelim(bytes, from, ucs2) {
    var n = bytes.length;
    var i;
    if (ucs2) {
      for (i = from; i + 3 < n; i++) {
        if (bytes[i] === 0x0d && bytes[i + 1] === 0 && bytes[i + 2] === 0x0a && bytes[i + 3] === 0) {
          return i;
        }
      }
      return -1;
    }
    for (i = from; i + 1 < n; i++) {
      if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a) return i;
    }
    return -1;
  }

  /**
   * Sequential line reader over the raw file bytes.
   *   `next()` returns the raw (still encoded) text of the next line, or null
   *            at end of data;
   *   `skip()` consumes one line without decoding it, and returns false only
   *            at end of data.
   */
  function lineCursor(bytes) {
    var ucs2 = codec.isUcs2(bytes);
    var delimLen = ucs2 ? 4 : 2;
    var pos = 0;
    var done = false;
    // Returns [start, end) of the next line's payload, or null at end of data.
    function advance() {
      if (done) return null;
      var at = pos;
      // Keep searching until the hit is aligned to a code-unit boundary —
      // the engines split on code units, not bytes.
      for (;;) {
        at = findDelim(bytes, at, ucs2);
        if (at < 0) {
          done = true;
          var tail = [pos, bytes.length];
          pos = bytes.length;
          return tail;
        }
        if (!ucs2 || ((at - pos) % 2 === 0)) break;
        at += 1;
      }
      var range = [pos, at];
      pos = at + delimLen;
      return range;
    }
    return {
      ucs2: ucs2,
      next: function () {
        var r = advance();
        return r === null ? null : codec.decodeRange(bytes, ucs2, r[0], r[1]);
      },
      skip: function () {
        return advance() !== null;
      },
    };
  }

  /**
   * Parse a compiled game file from its BYTES.
   * `name` is only used in messages (the path the caller read it from).
   * Returns { file, bytes, format, crc, locations: [name...],
   *           byUpper: Map<UPPERNAME, index> }.
   * Throws GameFileError with a plain-language message when the file is not a
   * readable game.
   */
  function readGameBuffer(input, name) {
    var file = name === undefined ? 'the game file' : name;
    var buf = codec.toBytes(input);
    if (!buf) throw new GameFileError('the game file was not handed over as bytes');
    if (buf.length < 8) throw new GameFileError('"' + file + '" is too small to be a QSP game file');

    var cur = lineCursor(buf);
    var head = [cur.next(), cur.next(), cur.next(), cur.next()];
    if (head[0] === null) throw new GameFileError('"' + file + '" has no line structure — not a QSP game file');

    var isOld = head[0] !== 'QSPGAME';
    var locsCount;
    var i, k;
    if (isOld) {
      locsCount = toNum(head[0]);          // qspStrToNum on the RAW line (game.c:174)
      if (locsCount <= 0) {
        throw new GameFileError('"' + file + '" is not a QSP game file (line 0 is ' +
          JSON.stringify(String(head[0]).slice(0, 24)) + ', expected "QSPGAME" or a location count)');
      }
    } else {
      locsCount = toNum(decode(head[3]));
      if (locsCount <= 0) throw new GameFileError('"' + file + '" declares ' + locsCount + ' locations');
    }

    // Old format: the table starts at line 30, so skip lines 4..29.
    if (isOld) for (i = 4; i < 30; i++) cur.skip();

    var locations = [];
    var byUpper = new Map();
    for (i = 0; i < locsCount; i++) {
      var rawName = cur.next();
      if (rawName === null) {
        throw new GameFileError('"' + file + '" ended after ' + i + ' of ' + locsCount +
          ' locations — the game file is truncated');
      }
      var locName = decode(rawName);
      locations.push(locName);
      var up = locName.toUpperCase();
      if (!byUpper.has(up)) byUpper.set(up, i); // qspLocIndex returns the FIRST match
      cur.skip();                                // Desc
      cur.skip();                                // OnVisit code
      var actsCount;
      if (isOld) {
        actsCount = 20;
      } else {
        var raw = cur.next();
        if (raw === null) throw new GameFileError('"' + file + '" is truncated inside location "' + locName + '"');
        actsCount = toNum(decode(raw));
        if (actsCount < 0 || actsCount > MAXACTIONS) {
          throw new GameFileError('"' + file + '" declares ' + actsCount + ' actions for location "' + locName +
            '" — the file is not a readable QSP game');
        }
      }
      var fields = actsCount * (isOld ? 2 : 3);
      for (k = 0; k < fields; k++) {
        if (!cur.skip()) throw new GameFileError('"' + file + '" is truncated inside location "' + locName + '"');
      }
    }

    return {
      file: file,
      bytes: buf.length,
      format: isOld ? 'qsp-old' : 'qsp',
      crc: qspCRC(buf),
      // WP-242: libqsp 5.9.5 computes a DIFFERENT checksum over the same bytes
      // (codec.qspCRC595), and line 3 of a save has to carry the one the
      // engine that opens it will recompute.
      crc595: codec.qspCRC595(buf),
      locations: locations,
      byUpper: byUpper,
    };
  }

  return { readGameBuffer: readGameBuffer };
}));
