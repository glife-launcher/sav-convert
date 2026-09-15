// Rewrite a parsed MODERN (libqsp 5.9.0) save into a CLASSIC (QSP 5.7.0) save.
//
// The mirror of `convert.js`. Writer transcribed from qsp-legacy @ 16b85ac
// `src/game.c:325 qspSaveGameStatusToString` and validated against
// `src/game.c:404 qspCheckGameStatus` (transcribed separately in
// `legacy-check.js`), which refuses the file outright if any bound is violated.
//
// The five substantive differences between the layouts, in the direction that
// matters here:
//
//  1. LOCATION (line 10). Modern always stores the NAME (game.c:300). Classic
//     players disagree with each other about this field, and the disagreement
//     is silent either way:
//       * stock qsp-legacy reads it as an ORDINAL into the location table
//         (game.c:492 `qspCurLoc = qspReCodeGetIntVal(strs[10])`), and
//         `qspStrToNum` returns 0 for text (text.c:341, no validity check), so
//         a name lands the player in location 0;
//       * Qqsp 1.9 — the player Girl Life players actually use, and the one
//         every save in this repo's classic corpus came from — writes the NAME
//         there, like modern does, so it must read one too.
//     So the caller CHOOSES (`locationAs`), the choice is stated in the report
//     and printed by the CLI, and either way the name must exist in the target
//     `.qsp`: a location that is gone is a hard refusal, never a guess.
//
//  2. ACTIONS gain back the two trailing fields modern has no member for:
//     `StartLine` and `IsManageLines` (game.c:377-378). Both are diagnostic —
//     `qspExecAction` (actions.c:119-125) uses them only as the code offset
//     for error line numbers — so they are written as 0 / 0, which is what an
//     action added outside a managed block carries anyway. `StartLine` must be
//     >= 0 or the classic gate refuses the file.
//
//     `Location` is REWRITTEN to the index of the location the save is
//     standing in, for the same reason `convert.js` rewrites it the other way:
//     the stored ordinal indexes the location table of the build that wrote
//     the save, and classic reads the field back into `qspRealCurLoc`
//     (actions.c:116) — diagnostic there too, but it must at least name a
//     location that exists in the target game.
//
//     The code bodies are carried across VERBATIM, still in the modern
//     engine's uppercased "prepared" form (codetools.c:548). That is safe in
//     the other direction, and unlike the forward converter this one has no
//     work to do: classic matches statement keywords against an UPPERCASED
//     COPY of the line (`qspUpperStr(uStr = qspGetNewText(s, qspStatMaxLen))`,
//     statements.c:247, and the same at :654 in `qspInitLineOfCode`), i.e. it
//     is case-INSENSITIVE where modern is case-sensitive. Proven end to end in
//     the classic oracle — see docs/reports/wp-63-reverse-converter.md §5.
//
//  3. VARIABLES move from 1024 chained buckets (libqsp variables.h:26) back
//     into ONE FLAT ARRAY of 256 blocks x 50 open-addressed slots (qsp-legacy
//     variables.h:24-25). The modern bucket number is meaningless there and is
//     dropped; the slot is recomputed with the legacy hash
//     (`codec.legacyBlockOf`, variables.c:161-165) and the block is PACKED
//     CONTIGUOUSLY from `50 * block`, because `qspVarReference` linear-probes
//     forward and STOPS at the first empty slot (variables.c:167-171) — a hole
//     makes every variable behind it unreachable, silently. More than 50
//     variables in one block is the engine's own `QSP_ERR_TOOMANYVARS` and is
//     refused here instead. Slots are emitted in ascending order because the
//     classic gate requires it (`temp <= lastInd` -> refuse, game.c:459).
//
//  4. VALUES are RE-TYPED back into legacy's Num+Str PAIR (variables.h:29-33):
//     a modern NUM becomes `(n, "")`, a modern STR becomes `(0, s)`. The pair
//     is what makes `x` and `$x` independent in classic; a modern save cannot
//     say what the other half was, so the half it does not carry is written
//     empty. That is not a loss THIS converter introduces — it is the loss the
//     forward direction already took (README §3.4) showing up on the way back.
//     CODE and VARREF values (types 3 and 4) have no legacy type; they
//     serialise through the string branch on both sides (game.c:399 BASETYPE),
//     so they are written as plain strings and every one is listed in the
//     report. A TUPLE cannot be represented at all and is a hard refusal.
//
//  5. ARRAY KEYS lose the `$` prefix: modern builds an index key as
//     QSP_IND_STRID + the uppercased key (variant.c:403-405, variant.h:25),
//     legacy stores the bare uppercased key (variables.c:198-232). Both keep
//     the table sorted and `bsearch` it, and stripping the same leading
//     character from every key preserves that order. Leave the prefix on and
//     every string-keyed array lookup in the game misses — silently, which is
//     most of Girl Life's state.
//
// Byte-level core: `toLegacy` returns a `Uint8Array`, and the module is
// loadable both by node `require` and by a plain <script>/importScripts.
(function (factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./codec'), require('./errors'), require('./modern-sav'));
  } else {
    var g = typeof globalThis !== 'undefined' ? globalThis : self;
    var ns = g.GLSavConvert || (g.GLSavConvert = {});
    ns.reverse = factory(ns.codec, ns.errors, ns.modernSav);
  }
}(function (codec, errors, modernSav) {
  'use strict';

  var encode = codec.encode;
  var writeContainer = codec.writeContainer;
  var VARSSEEK = codec.VARSSEEK;      // 50 slots per block
  var VARSCOUNT = codec.VARSCOUNT;    // 12 800 slots in total
  var ConvertError = errors.ConvertError;

  var LEGACY_VER = '5.7.0';           // qsp-legacy CMakeLists.txt:2
  var SAVEDGAMEID = 'QSPSAVEDGAME';   // qsp-legacy game.h:27
  var T_TUPLE = modernSav.T_TUPLE, T_NUM = modernSav.T_NUM;
  var T_CODE = modernSav.T_CODE, T_VARREF = modernSav.T_VARREF;

  // qsp-legacy declarations.h:88 — a name containing any of these, or starting
  // with a digit, is rejected by `qspVarReference` (variables.c:156) with
  // QSP_ERR_NOTCORRECTNAME, i.e. it can never be read back.
  var DELIMS = ' \t&\'"()[]=!<>+-/*:,{}';

  /**
   * The three primitives the falsification gate needs to be able to break, and
   * the reason they are reached through this object rather than called
   * directly: each one is a silent-failure mechanism (wrong slot, un-stripped
   * key, wrong half of the value pair), and the repo rule is that every
   * assertion must be PROVEN able to fail. `tools/theme-test/wp63-reverse.js`
   * substitutes a broken version of each and requires the gate to go red.
   * Nothing else ever touches them.
   */
  var hooks = {
    /** legacy block (0-255) for an uppercase, `$`-less variable name */
    blockOf: function (name) { return codec.legacyBlockOf(name); },
    /** modern index key ("$FOO") -> legacy index key ("FOO") */
    stripKey: function (key) { return key.charAt(0) === '$' ? key.slice(1) : key; },
    /** one modern variant -> legacy's { num, str } pair */
    valueToPair: function (val) {
      if (val.type === T_NUM) return { num: val.num, str: '' };
      return { num: 0, str: val.str };
    },
    /** what goes on line 10 */
    locationField: function (name, index, asIndex) { return asIndex ? String(index) : name; },
  };

  /**
   * @param parsed  result of modern-sav.parseModernSav
   * @param game    result of qsp-game.readGame (the .qsp the classic player will open)
   * @param opts    { locationAs: 'name' | 'index' }
   * @returns { buffer, report }
   */
  function toLegacy(parsed, game, opts) {
    const h = parsed.header;
    const options = opts || {};
    const locationAs = options.locationAs === 'index' ? 'index' : 'name';
    const notes = [];

    // ---- 1. location -------------------------------------------------------
    const location = h.location;
    const locIndex = game.byUpper.get(String(location).toUpperCase());
    if (locIndex === undefined) {
      throw new ConvertError('the save is standing in location "' + location +
        '", which does not exist in ' + game.file + '. Point --qsp at the .qsp the classic ' +
        'player will open this save with — a save cannot be moved to a game whose locations ' +
        'were renamed or removed.');
    }
    const locationField = hooks.locationField(location, locIndex, locationAs === 'index');
    if (locationAs === 'index') {
      notes.push('line 10 carries the location ORDINAL (' + locIndex + ' = "' + location +
        '"), which is what stock QSP 5.7.0 players read. Qqsp 1.9 expects the NAME there and ' +
        'will not find this location — convert without --loc-index for Qqsp.');
    } else {
      notes.push('line 10 carries the location NAME ("' + location + '"), which is what ' +
        'Qqsp 1.9 writes and reads. A stock QSP 5.7.0 player reads that field as a number, ' +
        'gets 0, and starts you in the game\'s first location instead — everything else ' +
        '(variables, actions, objects) still restores. Use --loc-index for those players.');
    }

    // ---- 2. bounds the classic engine enforces before it reads a body ------
    if (h.timerInterval < 0) {
      throw new ConvertError('the save has a negative timer interval (' + h.timerInterval +
        ') — the classic engine refuses such a file');
    }
    if (parsed.playlist.length > 500) throw new ConvertError('the save lists ' + parsed.playlist.length + ' playlist files (limit 500)');
    if (parsed.includes.length > 100) throw new ConvertError('the save lists ' + parsed.includes.length + ' included files (limit 100)');
    if (parsed.actions.length > 50) throw new ConvertError('the save holds ' + parsed.actions.length + ' actions (limit 50)');
    if (parsed.objects.length > 1000) throw new ConvertError('the save holds ' + parsed.objects.length + ' objects (limit 1000)');

    let selAction = h.selAction;
    if (selAction >= parsed.actions.length) {
      notes.push('selected action ' + selAction + ' is out of range (' + parsed.actions.length +
        ' actions) — reset to none');
      selAction = -1;
    }
    let selObject = h.selObject;
    if (selObject >= parsed.objects.length) {
      notes.push('selected object ' + selObject + ' is out of range (' + parsed.objects.length +
        ' objects) — reset to none');
      selObject = -1;
    }

    // ---- 3. re-slot + re-type the variables --------------------------------
    const blocks = [];
    for (let b = 0; b < 256; b++) blocks.push([]);
    const downgradedValues = [];   // CODE / VARREF written as plain strings
    const droppedVariables = [];   // names the classic engine could never read
    const strippedNames = [];      // a `$` that should not have been in a name
    const keysWithoutPrefix = [];  // an index key that carried no `$`
    const tupleValues = [];        // refusal material
    let numValues = 0, strValues = 0, emptyValues = 0;

    for (const v of parsed.vars) {
      let name = v.name;
      // `qspVarReference` strips one leading `$` before hashing (variables.c:155),
      // so a stored name that carries one can never be found again. The modern
      // engine strips it too, so this cannot come from a real save — but if it
      // ever does, dropping the prefix makes the variable reachable instead of
      // dead, and the change is reported.
      if (name.charAt(0) === '$') {
        strippedNames.push(name);
        name = name.slice(1);
      }
      if (name === '' || /^[0-9]/.test(name) || Array.prototype.some.call(DELIMS, (c) => name.indexOf(c) >= 0)) {
        droppedVariables.push({ name: v.name, values: v.values.length, why: 'the classic engine cannot read a variable by this name' });
        continue;
      }

      const values = [];
      for (let k = 0; k < v.values.length; k++) {
        const val = v.values[k];
        if (val.type === T_TUPLE) {
          tupleValues.push({ name: name, slot: k });
          values.push({ num: 0, str: '' });
          continue;
        }
        if (val.type === T_CODE || val.type === T_VARREF) {
          downgradedValues.push({
            name: name, slot: k,
            type: modernSav.TYPE_NAME[val.type],
            text: val.str.length > 60 ? val.str.slice(0, 57) + '…' : val.str,
          });
        }
        const pair = hooks.valueToPair(val);
        values.push(pair);
        if (pair.num !== 0) numValues++;
        else if (pair.str !== '') strValues++;
        else emptyValues++;
      }

      const indices = [];
      for (const ind of v.indices) {
        if (ind.key.charAt(0) !== '$') keysWithoutPrefix.push({ name: name, key: ind.key });
        indices.push({ index: ind.index, key: hooks.stripKey(ind.key) });
        if (ind.index < 0 || ind.index >= values.length) {
          throw new ConvertError('array key "' + ind.key + '" of ' + name + ' points at value slot ' +
            ind.index + ', but the variable has ' + values.length + ' values. The save is inconsistent; ' +
            'nothing was written.');
        }
      }

      blocks[hooks.blockOf(name)].push({ name: name, values: values, indices: indices });
    }

    if (tupleValues.length) {
      const sample = tupleValues.slice(0, 5).map((t) => t.name + '[' + t.slot + ']').join(', ');
      throw new ConvertError('this save holds ' + tupleValues.length + ' TUPLE value(s) (' + sample +
        (tupleValues.length > 5 ? ', …' : '') + '). Tuples exist only in the modern engine — ' +
        'QSP 5.7.0 has no such type, so this state cannot be carried back to the classic player. ' +
        'Nothing was written.');
    }

    const overfull = [];
    blocks.forEach((b, idx) => { if (b.length > VARSSEEK) overfull.push({ block: idx, count: b.length }); });
    if (overfull.length) {
      throw new ConvertError('the save has too many variables that hash together (' +
        overfull.map((o) => 'block ' + o.block + ': ' + o.count).join(', ') +
        '; the classic engine allows ' + VARSSEEK + ' per block and reports "too many variables" beyond that)');
    }

    // Pack each block contiguously from its first slot, in ascending slot
    // order — both properties are load-bearing (see the header note 3).
    const placed = [];
    let maxBlockLoad = 0;
    for (let b = 0; b < 256; b++) {
      const block = blocks[b];
      if (block.length > maxBlockLoad) maxBlockLoad = block.length;
      for (let k = 0; k < block.length; k++) {
        placed.push({ slot: b * VARSSEEK + k, v: block[k] });
      }
    }
    if (placed.length && placed[placed.length - 1].slot >= VARSCOUNT) {
      throw new ConvertError('the save needs a variable slot past the classic engine\'s ' + VARSCOUNT);
    }

    // ---- 4. the action list ------------------------------------------------
    const staleLocations = [...new Set(parsed.actions.map((a) => a.location))].filter((n) => n !== locIndex);

    // ---- 5. serialise (qsp-legacy game.c:325, field for field) -------------
    const out = [];
    const plain = (s) => out.push(s);
    const enc = (s) => out.push(encode(s));
    const num = (n) => out.push(encode(String(n)));

    plain(SAVEDGAMEID);
    plain(LEGACY_VER);
    num(game.crc);
    num(h.gameTime);
    num(selAction);
    num(selObject);
    enc(h.viewPath);
    enc(h.curInput);
    enc(h.curDesc);
    enc(h.curVars);
    enc(locationField);
    num(h.showActs);
    num(h.showObjs);
    num(h.showVars);
    num(h.showInput);
    num(h.timerInterval);
    num(parsed.playlist.length);
    for (const f of parsed.playlist) enc(f);
    num(parsed.includes.length);
    for (const f of parsed.includes) enc(f);
    num(parsed.actions.length);
    for (const a of parsed.actions) {
      enc(a.image);
      enc(a.desc);
      num(a.code.length);
      for (const [line, lineNum] of a.code) {
        enc(line);
        num(lineNum < 0 ? 0 : lineNum);
      }
      num(locIndex);        // Location  — see header note 2
      num(a.actIndex);      // ActIndex  — carried across, diagnostic
      num(0);               // StartLine     } legacy-only, diagnostic;
      num(0);               // IsManageLines } game.c:459 needs StartLine >= 0
    }
    num(parsed.objects.length);
    for (const o of parsed.objects) { enc(o.image); enc(o.desc); }
    num(placed.length);
    for (const p of placed) {
      num(p.slot);
      enc(p.v.name);
      num(p.v.values.length);
      for (const val of p.v.values) { num(val.num); enc(val.str); }
      num(p.v.indices.length);
      for (const ind of p.v.indices) { num(ind.index); enc(ind.key); }
    }
    out.push(''); // every field is written WITH its delimiter (coding.c
                  // qspCodeWriteVal), so the body ends on an empty line

    if (parsed.actions.length) {
      notes.push('the ' + parsed.actions.length + ' on-screen action' +
        (parsed.actions.length === 1 ? '' : 's') + ' saved with this file are attributed to "' +
        location + '" (#' + locIndex + ')' +
        (staleLocations.length ? ' — the modern file pointed them at ' + staleLocations.join(', ') : '') +
        ', and their code is kept in the uppercased form the modern engine stores. The classic ' +
        'engine matches keywords case-insensitively (statements.c:247), so they still work when ' +
        'you press them. Anything odd about them clears the moment you move.');
    }
    if (droppedVariables.length) {
      notes.push(droppedVariables.length + ' variable(s) were dropped because a QSP 5.7.0 ' +
        'engine cannot look up a name like that: ' +
        droppedVariables.slice(0, 5).map((d) => JSON.stringify(d.name)).join(', ') +
        (droppedVariables.length > 5 ? ', …' : ''));
    }

    return {
      buffer: writeContainer(out, h.ucs2),
      report: {
        engineVersionIn: h.engineVersion,
        engineVersionOut: LEGACY_VER,
        ucs2: h.ucs2,
        location,
        locationAs,
        locationField,
        locationIndexInGame: locIndex,
        qstCRCIn: h.qstCRC,
        qstCRCOut: game.crc,
        crcChanged: h.qstCRC !== game.crc,
        gameFile: game.file,
        gameLocations: game.locations.length,
        gameTime: h.gameTime,
        lineCountIn: h.lineCount,
        lineCountOut: out.length,
        actions: parsed.actions.length,
        actionLocation: locIndex,
        actionLocationsInFile: staleLocations,
        objects: parsed.objects.length,
        variablesIn: parsed.vars.length,
        variables: placed.length,
        maxBlockLoad,
        numValues, strValues, emptyValues,
        downgradedValues,
        droppedVariables,
        strippedNames,
        keysWithoutPrefix,
        notes,
      },
    };
  }

  return { toLegacy: toLegacy, hooks: hooks, ConvertError: ConvertError, LEGACY_VER: LEGACY_VER };
}));
