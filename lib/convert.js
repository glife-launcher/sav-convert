// Rewrite a parsed legacy (5.7.0) save into a modern libqsp 5.9.0 save.
//
// Writer transcribed from libqsp @ 9f4f29f9 `qsp/game.c:274 qspSaveGameStatus`
// and validated against `qsp/game.c:399 qspCheckGameStatus`, which refuses the
// file outright if any of its bounds is violated. Every bound it checks is
// re-checked here so a rejected save is reported as a converter error with a
// sentence a player can act on, instead of "Error code: 14" at load time.
//
// The four substantive differences between the layouts:
//
//  1. LOCATION (line 10). Modern stores the name. See legacy-sav.js for why a
//     classic file may hold either; an ordinal is resolved against the target
//     `.qsp` — but only when the save's own game checksum proves that `.qsp` is
//     the build the ordinal was written for — and the resolved name is
//     validated to exist either way.
//
//  2. ACTIONS lose two trailing fields (`StartLine`, `IsManageLines`) that the
//     modern engine has no member for, and their code bodies are RE-PREPARED.
//
//     A save stores the live action list, bodies and all, and each engine
//     stores those bodies in the state its own parser left them in. The modern
//     engine prepares a line for execution (uppercase everything outside
//     string literals, codetools.c:580 -> :548) BEFORE splitting it into
//     statements, and it re-reads a saved body with `qspInitLineOfCode` alone
//     (game.c:541) — no preparation step. The classic 5.7 player does not
//     prepare in place, so its saves carry the game's original lower-case
//     source. Copied verbatim into a modern save, `gt 'pav_commercial'` is no
//     longer a GOTO: keywords are matched case-sensitively against an
//     uppercase table (codetools.c:30-34), the line falls through to "print
//     this expression", and pressing the action raises "Unknown action!"
//     (error 28) instead of moving. So every stored code line goes through
//     `codec.prepareForExecution`, which is that same preparation step —
//     the bytes the modern engine would have written itself.
//
//     `Location` is an ordinal into the location table of the game the save
//     was made with, so after a version change it points at an unrelated
//     location (measured: a 0.9.6.1 save standing in `pav_park` carries 1040,
//     which is `trFatherMisha` in 0.9.9.1, and that name is what the engine
//     then prints in an error banner). The modern engine reads it in exactly
//     two places, both diagnostic — `qspRealCurLoc` for the location name in
//     an error message (errors.c:42) and the same value handed to the frontend
//     (bindings/default/default_control.c:64) — so it is REWRITTEN to the
//     index of the location the save is standing in: still a guess, but a
//     location that exists in the target game and is the right answer for a
//     location's own actions, which is nearly all of them.
//
//  3. VARIABLES move from one flat list of 12 800 open-addressed slots
//     (legacy variables.h:24) into 1024 chained buckets (libqsp
//     variables.h:26). The bucket is recomputed with the modern hash — the old
//     `hashSlot` field is meaningless here and is dropped.
//
//  4. VALUES are RE-TYPED. Legacy holds a Num AND a Str in every slot, so `x`
//     and `$x` coexist; modern holds one tagged variant, so they cannot.
//     Rule, and the evidence for it, in the README: a non-zero Num wins,
//     otherwise a non-empty Str, otherwise the number 0. Slots where BOTH were
//     set are counted and listed in the result as `retypeCollisions` — that is
//     the only lossy step in the whole conversion, and it is lossy because the
//     destination engine cannot represent the source state, not because the
//     converter gives up.
//
//     ARRAY KEYS gain a `$` prefix: modern builds an index key as
//     QSP_IND_STRID + the uppercased key (variant.c:403-405, variant.h:25),
//     legacy stored the bare uppercased key (legacy variables.c:202). Without
//     the prefix every string-keyed array lookup in the game would miss.
//
// Byte-level core: `toModern` returns a `Uint8Array`, and the module is
// loadable both by node `require` and by a plain <script>/importScripts in the
// webview (one copy of the code, two hosts).
(function (factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./codec'), require('./errors'));
  } else {
    var g = typeof globalThis !== 'undefined' ? globalThis : self;
    var ns = g.GLSavConvert || (g.GLSavConvert = {});
    ns.convert = factory(ns.codec, ns.errors);
  }
}(function (codec, errors) {
  'use strict';

  var encode = codec.encode;
  var prepareForExecution = codec.prepareForExecution;
  var bucketOf = codec.bucketOf;
  var writeContainer = codec.writeContainer;
  var VARSBUCKETS = codec.VARSBUCKETS;
  var VARSMAXBUCKETSIZE = codec.VARSMAXBUCKETSIZE;
  var ConvertError = errors.ConvertError;

  var QSP_VER = '5.9.0';            // libqsp CMakeLists.txt:2 -> QSP_VER_STR
  var SAVEDGAMEID = 'QSPSAVEDGAME'; // libqsp game.h:27
  var T_NUM = 1, T_STR = 2, T_UNDEF = 5; // libqsp bindings/qsp.h:87-92

  /**
   * @param parsed  result of legacy-sav.parseLegacySav
   * @param game    result of qsp-game.readGame (the .qsp to target)
   * @returns { buffer, report }
   */
  function toModern(parsed, game) {
    const h = parsed.header;
    const notes = [];

    // ---- 1. location -------------------------------------------------------
    let location;
    let locationSource;
    const asName = h.locationField;
    const nameHit = game.byUpper.has(asName.toUpperCase());
    if (h.locationIsIndex && !nameHit) {
      const idx = parseInt(asName, 10);
      if (idx < 0) {
        throw new ConvertError('the save is not standing in any location (index ' + idx +
          '). It was probably written before the game finished starting up; there is nothing to restore.');
      }
      // An ordinal indexes the location table of the build the save was MADE
      // with. Both engines stamp the save with qspCRC of that build's whole .qsp
      // (legacy game.c:81/235/329, libqsp game.c:83/197 — byte-identical
      // algorithm over the same bytes), so a CRC mismatch is proof that this is
      // a different build and that the ordinal points somewhere else in it.
      // Resolving it anyway produces a save that loads and puts the player in an
      // unrelated location, with nothing on screen to say so.
      if (h.qstCRC !== game.crc) {
        throw new ConvertError('the save stores its location as a NUMBER (' + idx + '), and it was ' +
          'made against a different build of the game (the save says checksum ' + h.qstCRC +
          ', ' + game.file + ' is ' + game.crc + '). A location number only means anything ' +
          'for the exact build it was written by, so translating it would silently put you in ' +
          'the wrong place. Point --qsp at the .qsp this save was made with.');
      }
      if (idx >= game.locations.length) {
        throw new ConvertError('the save is standing in location #' + idx + ', but ' +
          game.file + ' only has ' + game.locations.length + ' locations. ' +
          'This save was made with a different version of the game and its location ' +
          'number cannot be translated. Point --qsp at the .qsp the save was made with.');
      }
      location = game.locations[idx];
      locationSource = 'index ' + idx + ' resolved against ' + game.file;
      notes.push('location came from an ORDINAL (' + idx + ' -> "' + location + '"), resolved ' +
        'against a game file whose checksum matches the one the save was written with (' +
        game.crc + '); verify the game starts you in the right place.');
    } else {
      location = asName;
      locationSource = 'name stored in the save';
      if (!nameHit) {
        throw new ConvertError('the save is standing in location "' + location +
          '", which does not exist in ' + game.file + '. This save is from a game version ' +
          'whose locations were renamed or removed, so it cannot be translated safely.');
      }
    }

    // ---- 2. bounds the modern engine enforces before it reads a body -------
    if (h.timerInterval < 0) {
      throw new ConvertError('the save has a negative timer interval (' + h.timerInterval +
        ') — the modern engine refuses such a file');
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

    // ---- 3. re-bucket + re-type the variables ------------------------------
    const buckets = Array.from({ length: VARSBUCKETS }, () => []);
    const retypeCollisions = [];
    const paddedHoles = [];
    const droppedIndices = [];
    let numValues = 0, strValues = 0, undefValues = 0;

    for (const v of parsed.vars) {
      if (v.name === '') {
        notes.push('a variable with an empty name was dropped');
        continue;
      }
      const values = v.values.map((val) => {
        if (val.num !== 0) {
          if (val.str !== '') return { type: T_NUM, num: val.num, str: val.str, collided: true };
          return { type: T_NUM, num: val.num };
        }
        if (val.str !== '') return { type: T_STR, str: val.str };
        return { type: T_NUM, num: 0 };
      });

      // Legacy hands out an index slot at creation time and only fills it on
      // write, so a key can point past the end of Values. Modern refuses that
      // (game.c:481). Pad the gap with UNDEF — which is exactly what modern does
      // for its own holes (variables.c:384) — so the key keeps working.
      let maxIdx = -1;
      for (const ind of v.indices) if (ind.index > maxIdx) maxIdx = ind.index;
      if (maxIdx >= values.length) {
        paddedHoles.push({ name: v.name, from: values.length, to: maxIdx });
        while (values.length <= maxIdx) values.push({ type: T_UNDEF, str: '' });
      }
      const indices = [];
      for (const ind of v.indices) {
        if (ind.index < 0) { droppedIndices.push({ name: v.name, key: ind.key, index: ind.index }); continue; }
        indices.push({ index: ind.index, key: '$' + ind.key });
      }

      for (let k = 0; k < values.length; k++) {
        const val = values[k];
        if (val.collided) {
          const key = indices.find((x) => x.index === k);
          retypeCollisions.push({
            name: v.name,
            slot: k,
            key: key ? key.key.slice(1) : null,
            keptNumber: val.num,
            droppedString: val.str.length > 60 ? val.str.slice(0, 57) + '…' : val.str,
          });
        }
        if (val.type === T_NUM) numValues++;
        else if (val.type === T_STR) strValues++;
        else undefValues++;
      }
      buckets[bucketOf(v.name)].push({ name: v.name, values, indices });
    }

    const overfull = [];
    buckets.forEach((b, idx) => { if (b.length > VARSMAXBUCKETSIZE) overfull.push({ bucket: idx, count: b.length }); });
    if (overfull.length) {
      throw new ConvertError('the save has too many variables that hash together (' +
        overfull.map((o) => 'bucket ' + o.bucket + ': ' + o.count).join(', ') +
        '; the modern engine allows ' + VARSMAXBUCKETSIZE + ' per bucket)');
    }

    // ---- 4. the action list ------------------------------------------------
    // Both fixes are described at the top of this file. `actionLocation` is
    // resolved through the same map the location field itself was validated
    // with, so it always names a location that exists in the target game.
    const actionLocation = game.byUpper.get(location.toUpperCase());
    const staleLocations = [...new Set(parsed.actions.map((a) => a.location))]
      .filter((n) => n !== actionLocation);
    let preparedLines = 0;

    // ---- 5. serialise (game.c:274, field for field) ------------------------
    const out = [];
    const plain = (s) => out.push(s);
    const enc = (s) => out.push(encode(s));
    const num = (n) => out.push(encode(String(n)));

    plain(SAVEDGAMEID);
    plain(QSP_VER);
    num(game.crc);
    num(h.gameTime);
    num(selAction);
    num(selObject);
    enc(h.viewPath);
    enc(h.curInput);
    enc(h.curDesc);
    enc(h.curVars);
    enc(location);
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
        const ready = prepareForExecution(line);
        if (ready !== line) preparedLines++;
        enc(ready);
        num(lineNum < 0 ? 0 : lineNum);
      }
      // game.c:445 refuses a negative location; see the header note on why the
      // stored ordinal is replaced rather than carried across.
      num(actionLocation);
      num(a.actIndex);
      // a.startLine / a.isManageLines are legacy-only and have no modern field
    }
    num(parsed.objects.length);
    for (const o of parsed.objects) { enc(o.image); enc(o.desc); }
    for (let b = 0; b < VARSBUCKETS; b++) {
      const bucket = buckets[b];
      num(bucket.length);
      for (const v of bucket) {
        enc(v.name);
        num(v.values.length);
        for (const val of v.values) {
          num(val.type);
          if (val.type === T_NUM) num(val.num);
          else enc(val.str);
        }
        num(v.indices.length);
        for (const ind of v.indices) { num(ind.index); enc(ind.key); }
      }
    }
    out.push(''); // game.c:488 — the body ends exactly on the trailing empty line

    if (parsed.actions.length) {
      notes.push('the ' + parsed.actions.length + ' on-screen action' +
        (parsed.actions.length === 1 ? '' : 's') + ' saved with this file ' +
        (preparedLines
          ? 'were rewritten in the form this engine expects (' + preparedLines +
            ' line' + (preparedLines === 1 ? '' : 's') + '), so they still work when you press them'
          : 'needed no rewriting') +
        '; they are attributed to "' + location + '" because the old file pointed them at ' +
        'a location number from its own version of the game' +
        (staleLocations.length ? ' (' + staleLocations.join(', ') + ')' : '') +
        '. Anything odd about them clears the moment you move.');
    }

    return {
      buffer: writeContainer(out, h.ucs2),
      report: {
        engineVersionIn: h.engineVersion,
        engineVersionOut: QSP_VER,
        ucs2: h.ucs2,
        location,
        locationSource,
        locationIndexInGame: game.byUpper.get(location.toUpperCase()),
        // WP-154 (B-080): the mod files this save was running with, exactly as
        // it spells them. Whether the game folder HAS them is the host's
        // question — `lib/` never touches a filesystem.
        mods: parsed.includes.slice(),
        qstCRCIn: h.qstCRC,
        qstCRCOut: game.crc,
        gameFile: game.file,
        gameLocations: game.locations.length,
        gameTime: h.gameTime,
        lineCountIn: h.lineCount,
        lineCountOut: out.length,
        actions: parsed.actions.length,
        actionCodeLinesPrepared: preparedLines,
        actionLocation,
        actionLocationsInFile: staleLocations,
        objects: parsed.objects.length,
        variables: parsed.vars.length,
        numValues, strValues, undefValues,
        retypeCollisions,
        paddedHoles,
        droppedIndices,
        notes,
      },
    };
  }

  /**
   * WP-154 (B-080) — where an `includes` entry points inside the game folder,
   * as path parts, or null when the name leaves it: an absolute path, a drive
   * letter, or any `..` segment. A host resolves the parts against the folder
   * the `.qsp` sits in; a null is reported as missing and never opened. The mod
   * files themselves are never read — only the names the save carries.
   */
  function modPathParts(name) {
    var text = String(name == null ? '' : name).trim();
    if (!text || text.length > 200 || text.indexOf('\u0000') >= 0) return null;
    var parts = text.split(/[\\/]/);
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (!part || part === '.' || part === '..' || part.indexOf(':') >= 0) return null;
    }
    return parts;
  }

  /**
   * One plain sentence for a save that carries mods, or null for one that does
   * not. No repair is offered: naming the files is the fix — what it replaces
   * is a title screen with no message at all (WP-152 finding 1).
   */
  function modsNote(mods, missing) {
    if (!mods || !mods.length) return null;
    if (!missing || !missing.length) return 'Modded playthrough';
    var shown = missing.slice(0, 6);
    if (missing.length > 6) shown.push('and ' + (missing.length - 6) + ' more');
    return 'Modded playthrough — needs: ' + shown.join(', ') + ' (not found in the game folder)';
  }

  return {
    toModern: toModern, ConvertError: ConvertError, QSP_VER: QSP_VER,
    modPathParts: modPathParts, modsNote: modsNote,
  };
}));
