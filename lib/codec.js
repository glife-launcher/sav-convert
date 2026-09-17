// QSP wire primitives shared by the legacy reader and the modern writer.
//
// Every rule here is transcribed from engine source, not inferred:
//   * modern libqsp @ 9f4f29f9 (the commit launcher/engine-patch builds on)
//     - qsp/coding.c  qspEncodeString / qspDecodeString / qspStringToFileData
//     - qsp/text.h:23 QSP_STRSDELIM = "\r\n"
//     - qsp/coding.h:24 QSP_CODREMOV = 5
//     - qsp/game.c:83  qspCRC (NOTE the ARITHMETIC right shift — `crc` is int)
//     - qsp/variables.c:113-115 the bucket hash
//   * qsp-legacy 5.7.0 @ 16b85ac — src/coding.c qspCodeReCode, same ±5 shift
//     and the same CRLF delimiter, so the container is identical either way.
//
// This file is part of the BYTE-LEVEL CORE and must run unchanged in node and
// in the webview, so it uses `Uint8Array` and nothing else — no `Buffer`, no
// `fs`, no node built-ins. Two consequences worth stating:
//
//   * the UTF-16 codec is hand written rather than a `TextDecoder`. A `.sav`
//     body is ±5-SHIFTED text, so any code unit can appear, lone surrogates
//     included; `TextDecoder('utf-16le')` replaces those with U+FFFD, while
//     `Buffer.toString('utf16le')` (what the reference outputs were produced
//     with) passes them through. Byte-identity with those reference outputs
//     depends on the pass-through behaviour, so it is reproduced by hand.
//   * the single-byte branch is a raw byte <-> code-unit map (what
//     `latin1` means), NOT `windows-1252`, which is what the WHATWG label
//     "latin1" actually selects. The point is a byte-for-byte round trip
//     without knowing the game's codepage — see the README's caveat about
//     non-ASCII variable names in a single-byte save.
(function (factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    var g = typeof globalThis !== 'undefined' ? globalThis : self;
    var ns = g.GLSavConvert || (g.GLSavConvert = {});
    ns.codec = factory();
  }
}(function () {
  'use strict';

  var CODREMOV = 5;
  var NEG_CODREMOV = (-CODREMOV) & 0xffff;
  var VARSBUCKETS = 1024;          // libqsp 5.9.0 variables.h:26
  var VARSMAXBUCKETSIZE = 50;      // libqsp 5.9.0 variables.h:27
  var VARSSEEK = 50;               // qsp-legacy variables.h:24
  var VARSCOUNT = 256 * VARSSEEK;  // qsp-legacy variables.h:25 (12800)

  /**
   * THE MODERN TARGETS (WP-242, B-369).
   *
   * libqsp changed its save layout between 5.9.0 (what qspider and therefore
   * the launcher run) and 5.9.5 (what the game's developers are building their
   * new Qqsp on). The two are mutually unreadable — 5.9.5's `QSP_GAMEMIN_VER`
   * is "5.9.4", so it refuses a 5.9.0-stamped file before it looks at anything
   * else — so the converter has to be told which one it is writing.
   *
   * Everything below is transcribed from the two trees, never from a summary:
   * 5.9.0 = QSPFoundation/qsp @ 9f4f29f9, 5.9.5 = tag 5.9.5 (0445921b).
   *
   *   field            5.9.0                          5.9.5
   *   ver / gameMin    CMakeLists.txt:2 / :4          CMakeLists.txt:2 / :4
   *   header           4 window FLAGS at 11..14       ONE bitmask at 11
   *                    (game.c:313-316)               (game.c:328)
   *   first body line  16 (game.c:403 ind = 16)       12 (game.c:415 ind = 12)
   *   action fields    Image, Desc (game.c:327-328)   Desc, Image (game.c:340-341)
   *   object fields    Image, Desc (game.c:341-342)   Name, Image (game.c:354-355)
   *   object groups    -                              Name, Desc, Image,
   *                                                   UpdatedFields, ObjsCount
   *                                                   (game.c:357-364)
   *   buckets          1024 (variables.h:26)          512 (variables.h:17)
   *   max per bucket   50 (variables.h:27)            32 (variables.h:19)
   *   hash             7, *31 + low byte              IDENTICAL
   *                    (variables.c:112-115)          (variables.c:86-94)
   *   qspCRC (line 3)  seed 0, signed >>, extra     seed ~0, logical >>, no
   *                    ^0xD202EF8D (game.c:83-91)     extra xor, ~ on the way
   *                                                   out (game.c:74-82)
   *   type codes       TUPLE 0 NUM 1 STR 2            TUPLE 0 NUM 1 BOOL 2
   *                    CODE 3 VARREF 4 UNDEF 5        STR 3 CODE 4 VARREF 5
   *                    (bindings/qsp.h:87-92)         UNDEF 6 (bindings/qsp.h:82-88)
   *
   * Unchanged, and re-read to be sure: the container and the -5 shift
   * (coding.c), the variant encoding itself (type line, then payload; a tuple
   * is a count and that many nested variants — coding.c:340/363 in 5.9.5), the
   * `$` prefix on a string index key (5.9.0 variant.h:25 QSP_IND_STRID,
   * 5.9.5 declarations.h:63 QSP_STRTYPE, both written by
   * qspAppendVariantToIndexString), and qspCRC.
   */
  var MODERN_TARGETS = {
    '5.9.0': {
      name: '5.9.0',
      ver: '5.9.0',                 // CMakeLists.txt:2
      gameMinVer: '5.9.0',          // CMakeLists.txt:4
      buckets: 1024,                // variables.h:26
      maxBucketSize: 50,            // variables.h:27
      bodyStart: 16,                // game.c:403 `ind = 16`
      timerLine: 15,                // the four window flags occupy 11..14
      playlistLine: 16,
      windowStateIsBitmask: false,  // game.c:313-316, four flags
      actionDescFirst: false,       // game.c:327-328 Image, Desc
      objectNameFirst: false,       // game.c:341-342 Image, Desc
      hasObjsGroups: false,
      definedTypes: 6,              // QSP_TYPE_DEFINED_TYPES, bindings/qsp.h:93
      // index = the file's type code, value = its base type in 5.9.0 terms
      baseType: [0, 1, 2, 2, 2, 2], // game.c:399 / qspBaseTypeTable
      // the file's code for each CANONICAL type (see modern-sav.js)
      code: { tuple: 0, num: 1, str: 2, code: 3, varref: 4, undef: 5 },
      crc: 'qspCRC',      // game.c:83-91
    },
    '5.9.5': {
      name: '5.9.5',
      ver: '5.9.5',                 // CMakeLists.txt:2
      gameMinVer: '5.9.4',          // CMakeLists.txt:4
      buckets: 512,                 // variables.h:17 QSP_VARSGLOBALBUCKETS
      maxBucketSize: 32,            // variables.h:19 QSP_MAXVARSBUCKETSIZE
      bodyStart: 12,                // game.c:415 `ind = 12`
      timerLine: 12,                // the walk itself reads the timer interval
      playlistLine: 13,
      windowStateIsBitmask: true,   // game.c:328 qspCurWindowsDisplayState
      actionDescFirst: true,        // game.c:340-341 Desc, Image
      objectNameFirst: true,        // game.c:354-355 Name, Image
      hasObjsGroups: true,          // game.c:356-364
      definedTypes: 7,              // bindings/qsp.h:89
      // bindings/qsp.h:113-122 qspBaseTypeTable, expressed in 5.9.0 base codes:
      // TUPLE, NUM, BOOL->NUM, STR, CODE->STR, VARREF->STR, UNDEF->STR
      baseType: [0, 1, 1, 2, 2, 2, 2],
      code: { tuple: 0, num: 1, str: 3, code: 4, varref: 5, undef: 6 },
      crc: 'qspCRC595',   // game.c:74-82 — CRC-32B, a DIFFERENT number
    },
  };

  /* bindings/qsp.h:44-50, both versions — the bits of qspCurWindowsDisplayState. */
  var WIN_MAIN = 1, WIN_VARS = 2, WIN_ACTS = 4, WIN_OBJS = 8, WIN_INPUT = 16;

  /** The spec for a target name, or null when the name is not one we write. */
  function modernTarget(name) {
    if (name === undefined || name === null || name === '') return MODERN_TARGETS['5.9.0'];
    return Object.prototype.hasOwnProperty.call(MODERN_TARGETS, String(name))
      ? MODERN_TARGETS[String(name)] : null;
  }

  /** qspDecodeString: shift every code unit up by 5; -5 maps back to 5. */
  function decode(s) {
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      out += String.fromCharCode(c === NEG_CODREMOV ? CODREMOV : (c + CODREMOV) & 0xffff);
    }
    return out;
  }

  /** qspEncodeString: shift every code unit down by 5; 5 maps to -5. */
  function encode(s) {
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      out += String.fromCharCode(c === CODREMOV ? NEG_CODREMOV : (c - CODREMOV) & 0xffff);
    }
    return out;
  }

  /**
   * qspPrepareStringToExecution (libqsp codetools.c:548-577), transcribed.
   *
   * The modern engine runs this over EVERY line of code before it hands the
   * line to its statement splitter: uppercase everything that is not inside a
   * `'`/`"` string literal or a `{...}` q-string. Statement keywords are then
   * matched against an UPPERCASE table with a case-sensitive compare
   * (codetools.c:30-34 `qspStatStringCompare` -> `qspStrsNComp`), so a line
   * that skipped this step has no recognisable keywords at all.
   *
   * Why a converter needs it: an engine stores the action bodies of the live
   * action list in a save, and it stores them ALREADY PREPARED. The classic
   * 5.7 player does not prepare in place, so a classic save carries the game's
   * original lower-case source text; the modern engine re-reads those lines
   * with `qspInitLineOfCode` alone (game.c:541) and never prepares them. The
   * result is that `gt 'somewhere'` restored from a classic save is not a GOTO
   * at all — it is parsed as an expression to print, and raises "Unknown
   * action!" at the quote. Preparing the lines at conversion time is exactly
   * what the modern engine would have written itself.
   *
   * The case mapping: libqsp uses newlib's `towupper` (qsp/towupper.c), a 1:1
   * code-point map that never expands one character into two. JS's per-unit
   * `toUpperCase()` agrees with it on everything a QSP keyword or identifier
   * can be made of, and the few places it would EXPAND (`ß` -> `SS`) are
   * exactly the places `towupper` leaves alone — so an expansion is dropped
   * and the original character kept. That also keeps the string length, and
   * therefore the save's byte layout, predictable.
   */
  function prepareForExecution(line) {
    var out = '';
    var i = 0;
    var n = line.length;
    var quotsCount = 0;
    while (i < n) {
      var c = line.charAt(i);
      if (c === '{') { out += c; i++; quotsCount++; continue; }
      if (c === '}') { out += c; i++; if (quotsCount) quotsCount--; continue; }
      if (c === "'" || c === '"') {
        // Copy the literal verbatim, honouring the doubled-quote escape.
        var quot = c;
        out += c;
        i++;
        while (i < n) {
          var d = line.charAt(i);
          out += d;
          i++;
          if (d === quot) {
            if (i >= n) break;
            if (line.charAt(i) !== quot) break;
            out += line.charAt(i);
            i++;
          }
        }
        continue;
      }
      if (quotsCount) { out += c; i++; continue; } // q-strings stay untouched
      var up = c.toUpperCase();
      out += (up.length === 1 ? up : c);
      i++;
    }
    return out;
  }

  /**
   * qspStrToNum, reduced to what save/game fields hold (a decimal integer,
   * optionally signed). Anything else reads as 0, exactly like the engine's
   * "not a number" path.
   */
  function toNum(decoded) {
    var n = parseInt(decoded, 10);
    return isNaN(n) ? 0 : n;
  }

  /**
   * qspCRC (game.c:83). `crc` is a signed int there, so `crc >> 8` is an
   * arithmetic shift — JS `>>` matches; `>>>` would give a different answer.
   */
  var CRC_TABLE = (function () {
    var t = new Int32Array(256);
    for (var i = 0; i < 256; i++) {
      var c = i;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c | 0;
    }
    return t;
  }());

  function qspCRC(buf) {
    var crc = 0;
    for (var i = 0; i < buf.length; i++) {
      crc = ((CRC_TABLE[(crc & 0xff) ^ buf[i]] ^ (crc >> 8)) ^ 0xd202ef8d) | 0;
    }
    return crc;
  }

  /**
   * 5.9.5's qspCRC — a DIFFERENT number for the same bytes (WP-242).
   *
   * 5.9.0 `game.c:83-91` seeds `int crc = 0`, shifts a SIGNED int and folds an
   * extra `^ 0xD202EF8D` into every step. 5.9.5 `game.c:74-82` is plain
   * CRC-32B: `unsigned int crc = ~0`, a logical shift, no extra xor, and the
   * result complemented on the way out. Same table, different answer — for
   * Girl_Life_0.9.9.2.qsp, -651164383 against -2055507245.
   *
   * It matters: line 3 of a save is this number, and the engine compares it
   * (game.c:421-424) unless the game has set DEBUG. Girl Life does set it, so
   * a real player never sees the check — but a headless host that has not run
   * the game's start code does, and a save carrying the other engine's CRC is
   * refused with "Can't load file!" and nothing else to go on.
   */
  function qspCRC595(buf) {
    var crc = 0xffffffff;
    for (var i = 0; i < buf.length; i++) {
      crc = ((CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)) >>> 0);
    }
    return ~crc | 0;
  }

  /**
   * libqsp variables.c:112-115 (5.9.0) / variables.c:86-94 (5.9.5, as
   * `qspGetNameHash`) — bucket = (7, then *31 + low byte of each code unit,
   * unsigned 32-bit) % the bucket count. The formula is IDENTICAL in both;
   * only the modulus moved (1024 -> 512), so it is a parameter here.
   * `(unsigned char)*pos` takes the LOW byte of the QSP_CHAR, so a non-ASCII
   * name hashes on its low bytes; reproduced as-is.
   */
  function bucketOf(name, buckets) {
    var b = 7 >>> 0;
    for (var i = 0; i < name.length; i++) {
      b = (Math.imul(b, 31) + (name.charCodeAt(i) & 0xff)) >>> 0;
    }
    return b % (buckets || VARSBUCKETS);
  }

  /**
   * qsp-legacy 5.7.0's variable hash, the OTHER end of `bucketOf`.
   *
   *   /* variables.c:161-165 *\/
   *   bCode = 0;
   *   for (i = 0; uName[i]; ++i)
   *       bCode = qspRand8[bCode ^ QSP_MBTOSB(uName[i])];
   *   var = qspVars + QSP_VARSSEEK * bCode;      // 50 slots per block
   *
   * `bCode` is an `unsigned char`, so the whole hash is a byte-wide walk
   * through this substitution table; the result names a BLOCK of 50 slots in
   * the one flat 12 800-entry array, and `qspVarReference` then LINEAR-PROBES
   * forward from the first slot of that block. `QSP_MBTOSB` is `(a) % 256` in
   * the _UNICODE build (bindings/default/qsp_default.h:37) — the low byte of
   * the UTF-16 code unit, exactly like modern's `(unsigned char)*pos`.
   *
   * Two consequences the reverse writer lives by:
   *   * the probe STOPS at the first empty slot in the block (it returns that
   *     empty slot to the caller, variables.c:167-171), so a save must pack a
   *     block's variables contiguously from `50 * bCode` or everything behind
   *     the hole is unreachable;
   *   * a block holds at most 50 variables — the engine's own
   *     `QSP_ERR_TOOMANYVARS` (variables.c:182).
   *
   * The table below is qsp-legacy's `qspRand8` (variables.c:27-45) copied
   * verbatim; it is a permutation of 0..255 (the values sum to 32640).
   */
  var RAND8 = [
    12, 107, 53, 36, 133, 5, 43, 172, 50, 38, 243, 76, 143, 244, 142, 188,
    236, 105, 77, 149, 119, 104, 195, 219, 194, 113, 31, 209, 20, 170, 10, 9,
    13, 6, 211, 81, 233, 49, 54, 158, 157, 128, 37, 239, 226, 85, 238, 144,
    90, 180, 231, 41, 4, 193, 103, 0, 212, 210, 117, 208, 248, 116, 132, 70,
    200, 68, 230, 99, 61, 216, 156, 218, 7, 181, 57, 106, 167, 222, 80, 249,
    102, 168, 189, 201, 25, 206, 125, 235, 228, 205, 253, 165, 33, 131, 163, 217,
    151, 16, 191, 139, 213, 129, 65, 30, 110, 17, 78, 174, 87, 146, 196, 161,
    63, 124, 74, 24, 35, 109, 59, 150, 175, 224, 79, 245, 126, 34, 183, 48,
    89, 21, 71, 220, 225, 101, 166, 32, 27, 66, 204, 29, 148, 207, 202, 83,
    154, 40, 135, 60, 140, 120, 45, 147, 141, 56, 3, 162, 221, 73, 98, 240,
    223, 160, 242, 72, 114, 111, 127, 198, 115, 26, 118, 173, 11, 254, 130, 108,
    186, 15, 58, 96, 18, 123, 51, 190, 159, 93, 1, 100, 182, 23, 215, 152,
    2, 185, 75, 255, 171, 176, 91, 179, 22, 247, 203, 252, 197, 14, 82, 92,
    232, 42, 134, 97, 199, 46, 229, 164, 250, 121, 39, 251, 192, 122, 138, 55,
    178, 237, 169, 95, 187, 62, 69, 47, 84, 88, 44, 112, 64, 227, 86, 184,
    234, 145, 52, 246, 136, 67, 153, 214, 137, 155, 8, 241, 94, 28, 177, 19
  ];

  /** Legacy block number (0-255) for an ALREADY-UPPERCASED, `$`-less name. */
  function legacyBlockOf(name) {
    var b = 0;
    for (var i = 0; i < name.length; i++) {
      b = RAND8[(b ^ (name.charCodeAt(i) & 0xff)) & 0xff];
    }
    return b;
  }

  // --- byte <-> string, the two container encodings -------------------------

  /** Chunked so a long run never blows the argument limit of `apply`. */
  function fromCharCodes(units) {
    var CH = 0x8000;
    if (units.length <= CH) return String.fromCharCode.apply(null, units);
    var parts = [];
    for (var i = 0; i < units.length; i += CH) {
      parts.push(String.fromCharCode.apply(null, units.subarray(i, Math.min(i + CH, units.length))));
    }
    return parts.join('');
  }

  /**
   * Decode `bytes[start, end)` as the container's text.
   *
   * UTF-16LE: whole code units only — an odd trailing byte is dropped, which
   * is what `Buffer.toString('utf16le')` does and therefore what the reference
   * outputs were produced against.
   */
  function decodeRange(bytes, ucs2, start, end) {
    if (start === undefined) start = 0;
    if (end === undefined) end = bytes.length;
    if (end < start) end = start;
    if (!ucs2) return fromCharCodes(bytes.subarray(start, end));
    var n = (end - start) >> 1;
    var units = new Uint16Array(n);
    for (var i = 0; i < n; i++) {
      var p = start + i * 2;
      units[i] = bytes[p] | (bytes[p + 1] << 8);
    }
    return fromCharCodes(units);
  }

  /** True when the container is UTF-16LE, decided as both engines decide it. */
  function isUcs2(bytes) {
    return bytes.length >= 2 && bytes[1] === 0;
  }

  /**
   * Container split. UTF-16LE is detected exactly as the engines do
   * (game.c:493 / legacy game.c:497: byte 1 is 0x00), otherwise the game's
   * single-byte codepage — kept as a raw byte map so a byte-for-byte
   * round-trip is possible without knowing which codepage it was.
   */
  function readContainer(bytes) {
    var ucs2 = isUcs2(bytes);
    return { ucs2: ucs2, lines: decodeRange(bytes, ucs2, 0, bytes.length).split('\r\n') };
  }

  /** qspStringToFileData — no BOM, no terminator, just the code units. */
  function writeContainer(lines, ucs2) {
    var text = lines.join('\r\n');
    var n = text.length;
    var out;
    if (ucs2) {
      out = new Uint8Array(n * 2);
      for (var i = 0; i < n; i++) {
        var c = text.charCodeAt(i);
        out[i * 2] = c & 0xff;
        out[i * 2 + 1] = (c >>> 8) & 0xff;
      }
      return out;
    }
    out = new Uint8Array(n);
    for (var j = 0; j < n; j++) out[j] = text.charCodeAt(j) & 0xff;
    return out;
  }

  /**
   * Accept anything byte-shaped the two hosts pass in — a node `Buffer` (which
   * IS a Uint8Array), an `ArrayBuffer` from `fetch().arrayBuffer()`, or a typed
   * array view — and return a plain `Uint8Array` over the same bytes.
   */
  function toBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) return new Uint8Array(input);
    if (input && typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    return null;
  }

  return {
    CODREMOV: CODREMOV,
    VARSBUCKETS: VARSBUCKETS,
    VARSMAXBUCKETSIZE: VARSMAXBUCKETSIZE,
    MODERN_TARGETS: MODERN_TARGETS,
    modernTarget: modernTarget,
    WIN_MAIN: WIN_MAIN, WIN_VARS: WIN_VARS, WIN_ACTS: WIN_ACTS,
    WIN_OBJS: WIN_OBJS, WIN_INPUT: WIN_INPUT,
    VARSSEEK: VARSSEEK,
    VARSCOUNT: VARSCOUNT,
    decode: decode,
    encode: encode,
    prepareForExecution: prepareForExecution,
    toNum: toNum,
    qspCRC: qspCRC,
    qspCRC595: qspCRC595,
    bucketOf: bucketOf,
    legacyBlockOf: legacyBlockOf,
    isUcs2: isUcs2,
    decodeRange: decodeRange,
    readContainer: readContainer,
    writeContainer: writeContainer,
    toBytes: toBytes,
    fromCharCodes: fromCharCodes,
  };
}));
