// Web Worker entry for the converter.
//
// This file is the TAIL of the browser bundle the launcher and the test stand
// serve as `themes/sav-convert.js`: the `lib/` modules are concatenated ahead
// of it, each registering itself on `self.GLSavConvert`, and this block turns
// the result into a worker that answers one message.
//
// Why a worker at all: the conversion needs the whole `.qsp` — 91 MB for Girl
// Life 0.9.9.1 — because the game's own CRC is computed over every byte of it
// and the location table has to be walked to prove the save's location still
// exists. Measured in a browser, that is far
// past a frame, so doing it on the main thread would freeze the game while a
// player watched. The worker also does the two FETCHES, so the 91 MB never
// crosses the main thread's heap at all.
//
// It is inert when the bundle is loaded as an ordinary script (the theme's
// fallback path does exactly that when a Worker cannot be constructed): the
// guard below is what a worker global has and a document does not.
//
// TWO operations since WP-66, one message shape (`msg.op`):
//   'convert' (the default, and what every pre-WP-66 caller sends)
//                                       classic .sav  -> modern .sav
//   'reverse'                           modern .sav   -> classic 5.7.0 .sav
// The reverse direction is driven from a save SLOT, whose bytes are already in
// the page's memory, so the input may arrive as `savBytes` (an ArrayBuffer,
// transferred in) instead of a `savUrl` to fetch. Only the source differs —
// the `.qsp` is fetched by the worker either way, for the same reason it
// always was: it is 91 MB and must not cross the main thread's heap.
(function () {
  'use strict';
  if (typeof self === 'undefined' || typeof document !== 'undefined') return;
  if (typeof importScripts !== 'function') return;

  var api = self.GLSavConvert;

  function fetchBytes(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
      return res.arrayBuffer();
    });
  }

  self.onmessage = function (e) {
    var msg = e.data || {};
    var id = msg.id;
    var reverse = msg.op === 'reverse';
    var t0 = Date.now();
    var timings = {};
    var savBytes = null;
    var stage = function (name) { self.postMessage({ id: id, stage: name }); };

    stage('fetch-sav');
    // Bytes handed straight over win over a URL; `Promise.resolve` keeps the
    // two sources on one chain so the stages and timings stay identical.
    (msg.savBytes ? Promise.resolve(msg.savBytes) : fetchBytes(msg.savUrl)).then(function (buf) {
      timings.fetchSav = Date.now() - t0;
      savBytes = buf;
      stage('fetch-qsp');
      var t1 = Date.now();
      return fetchBytes(msg.qspUrl).then(function (qspBuf) {
        timings.fetchQsp = Date.now() - t1;
        return qspBuf;
      });
    }).then(function (qspBytes) {
      stage('convert');
      var t2 = Date.now();
      var req = {
        savBytes: savBytes,
        qspBytes: qspBytes,
        qspName: msg.qspName || 'the game file',
      };
      if (reverse) req.locationAs = msg.locationAs;
      // WP-242: the host may ask for the 5.9.5 layout. Passed through
      // untouched — undefined means the 5.9.0 default, which is what the
      // launcher's own player reads.
      else if (msg.target) req.target = msg.target;
      var out = reverse ? api.reverseConvertBuffer(req) : api.convertBuffer(req);
      timings.convert = Date.now() - t2;
      timings.total = Date.now() - t0;
      // The bytes are TRANSFERRED, not copied: the worker has no use for them
      // afterwards and a copy of a 700 KB save per conversion is pointless.
      var buffer = out.outBytes.buffer.byteLength === out.outBytes.byteLength
        ? out.outBytes.buffer
        : out.outBytes.slice().buffer;
      self.postMessage({ id: id, ok: true, bytes: buffer, report: out.report, timings: timings }, [buffer]);
    }).catch(function (err) {
      // An Error subclass does not survive a structured clone, so the two
      // things the UI needs — the player-readable sentence and which KIND of
      // refusal it was — are sent as plain data.
      self.postMessage({
        id: id,
        ok: false,
        kind: (err && err.kind) || 'error',
        error: (err && err.message) || String(err),
        timings: timings,
      });
    });
  };
}());
