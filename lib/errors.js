// The converter's typed refusals.
//
// Every message a class here carries is written for a PLAYER to read, because
// both front ends put it straight on screen: the CLI prints it, and the saves
// window shows it verbatim on the row. `kind` is the machine-readable half —
// it survives a `postMessage` out of a Web Worker, where an `Error` subclass
// does not (structured clone flattens it to a plain Error).
//
//   sav-format     the input is not a save this converter can READ
//   convert        it is, but it cannot be translated faithfully
//   already-modern it does not need converting at all
//   already-legacy the same, for the REVERSE direction (modern -> classic)
//   game-file      the `.qsp` handed in is not a readable game file
//
// The first two class names (`SavFormatError`, `ConvertError`) are fixed: the
// CLI's exit-message wording is keyed on them, and the adversarial test gate
// asserts that wording. Renaming them breaks both.
(function (factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    var g = typeof globalThis !== 'undefined' ? globalThis : self;
    var ns = g.GLSavConvert || (g.GLSavConvert = {});
    ns.errors = factory();
  }
}(function () {
  'use strict';

  function ConverterError(message, kind) {
    var e = Error.call(this, message);
    this.message = e.message;
    this.name = 'ConverterError';
    this.kind = kind || 'convert';
    if (Error.captureStackTrace) Error.captureStackTrace(this, ConverterError);
    else this.stack = e.stack;
  }
  ConverterError.prototype = Object.create(Error.prototype);
  ConverterError.prototype.constructor = ConverterError;

  function subclass(name, kind) {
    function Sub(message) {
      ConverterError.call(this, message, kind);
      this.name = name;
    }
    Sub.prototype = Object.create(ConverterError.prototype);
    Sub.prototype.constructor = Sub;
    return Sub;
  }

  var SavFormatError = subclass('SavFormatError', 'sav-format');
  var ConvertError = subclass('ConvertError', 'convert');
  var AlreadyModernError = subclass('AlreadyModernError', 'already-modern');
  var AlreadyLegacyError = subclass('AlreadyLegacyError', 'already-legacy');
  var GameFileError = subclass('GameFileError', 'game-file');

  return {
    ConverterError: ConverterError,
    SavFormatError: SavFormatError,
    ConvertError: ConvertError,
    AlreadyModernError: AlreadyModernError,
    AlreadyLegacyError: AlreadyLegacyError,
    GameFileError: GameFileError,
  };
}));
