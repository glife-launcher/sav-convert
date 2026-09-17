// The converter's public entry points: bytes in, bytes out, one per direction.
//
//   convertBuffer({ savBytes, qspBytes, qspName,          classic -> modern
//                   target })                             (target: WP-242)
//   reverseConvertBuffer({ savBytes, qspBytes, qspName,   modern  -> classic
//                          locationAs })                  (WP-63)
//
// No `fs`, no paths, no node built-ins — everything above this line in the
// stack (the CLI, the launcher, the theme's Web Worker) supplies the bytes and
// decides what to do with the result. That is the point of the split: one
// byte-for-byte verified library runs unchanged in the webview, so converting
// an old save needs no Node.js on the player's machine.
//
// It throws, it never returns a half-conversion. Every throw is one of the four
// typed errors in `errors.js`, each carrying a sentence a player can act on and
// a `kind` that survives a `postMessage` out of a worker.
//
// The order of the checks is deliberate and must not be rearranged — the exact
// message an adversarial input produces is asserted by the test gates:
//   1. is it a QSP save at all (header marker only);
//   2. is it ALREADY modern — answered before the body is walked, so a modern
//      file gets "you do not need this" instead of a parse error from deep
//      inside a layout it never had;
//   3. the strict legacy walk;
//   4. the `.qsp` location table + CRC;
//   5. the rewrite;
//   6. libqsp's OWN acceptance gate over the finished bytes, transcribed
//      independently of the writer (modern-check.js) — a save that fails to
//      load after the player was told it converted is the failure mode this
//      converter exists to prevent.
(function (factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./codec'), require('./errors'), require('./legacy-sav'),
      require('./qsp-game'), require('./convert'), require('./modern-check'),
      require('./modern-sav'), require('./reverse'), require('./legacy-check')
    );
  } else {
    var g = typeof globalThis !== 'undefined' ? globalThis : self;
    var ns = g.GLSavConvert || (g.GLSavConvert = {});
    // The last three are the REVERSE direction (WP-63). They joined the
    // browser bundle in WP-66 (`SAV_CONVERT_JS` in server.rs,
    // `SAV_CONVERT_FILES` in serve.py) — but the guard below stays: a HOST
    // that assembles its own bundle and leaves them out gets one sentence
    // instead of a crash on a property of undefined.
    var api = factory(ns.codec, ns.errors, ns.legacySav, ns.qspGame, ns.convert, ns.modernCheck,
      ns.modernSav, ns.reverse, ns.legacyCheck);
    for (var k in api) if (Object.prototype.hasOwnProperty.call(api, k)) ns[k] = api[k];
  }
}(function (codec, errors, legacySav, qspGame, convert, modernCheck, modernSav, reverse, legacyCheck) {
  'use strict';

  var MODERN_VER = '5.9.0';
  var DEFAULT_TARGET = '5.9.0';

  /** Engine stamp from a QSP save, or null if the file is not one at all. */
  function readEngineStamp(bytes) {
    if (bytes.length < 4) return null;
    var ucs2 = bytes[1] === 0;
    var end = Math.min(bytes.length, ucs2 ? 128 : 64);
    var head = codec.decodeRange(bytes, ucs2, 0, end).split('\r\n');
    if (head[0] !== 'QSPSAVEDGAME') return null;
    return head.length > 1 ? head[1] : '';
  }

  /**
   * Numeric dotted-version compare; a non-numeric stamp sorts below everything.
   *
   * Numeric on purpose: the engine's own gate is a raw string compare, under
   * which "5.10.0" would sort below "5.9.0". Inheriting that would make a
   * future save look legacy and offer it for conversion.
   */
  function compareVersions(a, b) {
    var pa = String(a).split('.').map(function (x) { return parseInt(x, 10); });
    var pb = String(b).split('.').map(function (x) { return parseInt(x, 10); });
    if (pa.some(function (x) { return isNaN(x); })) return -1;
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d < 0 ? -1 : 1;
    }
    return 0;
  }

  /**
   * Convert one legacy save.
   *
   * @param opts.savBytes  the classic `.sav` (Uint8Array / Buffer / ArrayBuffer)
   * @param opts.qspBytes  the target game file's bytes
   * @param opts.qspName   what to call the game file in messages (a path or a
   *                       file name — never read, only printed)
   * @param opts.target    which modern engine to write for: '5.9.0' (default,
   *                       what qspider and therefore the launcher run) or
   *                       '5.9.5' (the new Qqsp — WP-242 / B-369). The two are
   *                       mutually unreadable: 5.9.5 refuses a 5.9.0-stamped
   *                       save outright, because its QSP_GAMEMIN_VER is 5.9.4.
   * @returns { outBytes: Uint8Array, report }
   */
  function convertBuffer(opts) {
    var o = opts || {};
    var target = o.target === undefined || o.target === null || o.target === ''
      ? DEFAULT_TARGET : String(o.target);
    if (!codec.modernTarget(target)) {
      throw new errors.ConvertError('unknown target engine "' + target +
        '" — this converter writes 5.9.0 (default) or 5.9.5.');
    }
    var savBytes = codec.toBytes(o.savBytes);
    if (!savBytes) throw new errors.SavFormatError('the save was not handed over as bytes');

    var stamp = readEngineStamp(savBytes);
    if (stamp === null) {
      throw new errors.SavFormatError('not a QSP save file — it has no "QSPSAVEDGAME" header');
    }
    if (compareVersions(stamp, MODERN_VER) >= 0) {
      throw new errors.AlreadyModernError('this save is already in the modern format (engine ' + stamp +
        ') — it does not need converting; import it directly.');
    }

    var parsed = legacySav.parseLegacySav(savBytes);
    var game = qspGame.readGameBuffer(o.qspBytes, o.qspName);
    var written = convert.toModern(parsed, game, { target: target });

    var gate = modernCheck.checkModernSav(written.buffer, target);
    if (!gate.ok) {
      throw new errors.ConvertError('the converted save would be rejected by the game engine (' +
        gate.reason + '). Nothing was written. Please report this file — it is a converter bug.');
    }

    var report = { inputBytes: savBytes.length, outputBytes: written.buffer.length, target: target };
    for (var k in written.report) {
      if (Object.prototype.hasOwnProperty.call(written.report, k)) report[k] = written.report[k];
    }
    return { outBytes: written.buffer, report: report };
  }

  /**
   * Convert one MODERN save back to the classic format (WP-63).
   *
   * Reads BOTH modern layouts: which one a file is in comes off its own engine
   * stamp, exactly as the engine decides it (modern-sav.js).
   *
   * The mirror of `convertBuffer`, same shape, same discipline: bytes in,
   * bytes out, typed refusals, and the destination engine's OWN acceptance
   * gate run over the finished file before it is handed back.
   *
   * @param opts.savBytes    the modern `.sav`
   * @param opts.qspBytes    the bytes of the .qsp the CLASSIC player will open
   * @param opts.qspName     what to call that file in messages
   * @param opts.locationAs  'name' (default, what Qqsp 1.9 reads) or 'index'
   *                         (what a stock QSP 5.7.0 player reads) — see
   *                         reverse.js, note 1
   * @returns { outBytes: Uint8Array, report }
   */
  function reverseConvertBuffer(opts) {
    if (!modernSav || !reverse || !legacyCheck) {
      throw new errors.ConvertError('the reverse converter (modern -> classic) is not part of ' +
        'this build — it runs from tools/sav-convert/reverse.js on the command line.');
    }
    var o = opts || {};
    var savBytes = codec.toBytes(o.savBytes);
    if (!savBytes) throw new errors.SavFormatError('the save was not handed over as bytes');

    var stamp = readEngineStamp(savBytes);
    if (stamp === null) {
      throw new errors.SavFormatError('not a QSP save file — it has no "QSPSAVEDGAME" header');
    }
    if (compareVersions(stamp, MODERN_VER) < 0) {
      throw new errors.AlreadyLegacyError('this save is already in the classic format (engine ' + stamp +
        ') — the classic player opens it as it is.');
    }

    var parsed = modernSav.parseModernSav(savBytes);
    var game = qspGame.readGameBuffer(o.qspBytes, o.qspName);
    var written = reverse.toLegacy(parsed, game, { locationAs: o.locationAs });

    var gate = legacyCheck.checkLegacySav(written.buffer);
    if (!gate.ok) {
      throw new errors.ConvertError('the converted save would be rejected by the classic engine (' +
        gate.reason + '). Nothing was written. Please report this file — it is a converter bug.');
    }
    if (!gate.endsWhereExpected) {
      throw new errors.ConvertError('the converted save does not end where a 5.7.0 body should ' +
        '(line ' + gate.endIndex + ' of ' + gate.lineCount + '). Nothing was written — it is a converter bug.');
    }

    var report = { inputBytes: savBytes.length, outputBytes: written.buffer.length };
    for (var k in written.report) {
      if (Object.prototype.hasOwnProperty.call(written.report, k)) report[k] = written.report[k];
    }
    return { outBytes: written.buffer, report: report };
  }

  return {
    convertBuffer: convertBuffer,
    reverseConvertBuffer: reverseConvertBuffer,
    MODERN_TARGETS: Object.keys(codec.MODERN_TARGETS),
    DEFAULT_TARGET: DEFAULT_TARGET,
    readEngineStamp: readEngineStamp,
    compareVersions: compareVersions,
    MODERN_VER: MODERN_VER,
    ConverterError: errors.ConverterError,
    SavFormatError: errors.SavFormatError,
    ConvertError: errors.ConvertError,
    AlreadyModernError: errors.AlreadyModernError,
    AlreadyLegacyError: errors.AlreadyLegacyError,
    GameFileError: errors.GameFileError,
  };
}));
