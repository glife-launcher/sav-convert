// The real-engine gate for the 5.9.5 target.
//
//   node native-check/gate.js --corpus <folder of classic .sav files> \
//                             --qsp <game.qsp> [--bin <driver>] [--out <folder>]
//
// `--corpus` may be repeated. Every flag also reads an environment variable:
// CORPUS, QSP, BIN, OUT. The driver defaults to `native-check/build/qsp595-check`
// (build it with `native-check/build.sh`); without it the gate SKIPs.
//
// For every classic save in the corpus it converts with `target: '5.9.5'`,
// hands the bytes to a headless libqsp 5.9.5 (native-check/driver.c) and
// asserts two things: the ENGINE accepted the file, and every variable it
// hands back equals the value this repository's own legacy reader pulls out of
// the classic original. A converter may only claim a save loads if the engine
// that opens it says so.
//
// The assertion is made on the driver's `pre:` pass — the restored state as it
// stands BEFORE the game's own ONGLOAD runs. That is the layout's business.
// What ONGLOAD then rewrites is the game's (in Girl Life it is `saveupdater`),
// and it is printed beside it whenever the two differ, never asserted.
//
// It also feeds ONE 5.9.0 output to the same driver and requires a REFUSAL —
// that mutual unreadability is the whole premise of the second target.
//
// Saves and game files stay where you point the gate at them; the converted
// copies are written under `--out` (inside `native-check/build/`, which is
// gitignored). Nothing is ever copied into this repository.
const fs = require('fs');
const path = require('path');
const conv = require('../lib');
const legacySav = require('../lib/legacy-sav');

const USAGE = 'usage: node native-check/gate.js --corpus <dir> --qsp <game.qsp> ' +
  '[--corpus <dir> ...] [--bin <driver>] [--out <dir>]';

function parseArgs(argv) {
  const dirs = [];
  let qsp = process.env.QSP || null;
  let bin = process.env.BIN || path.join(__dirname, 'build', 'qsp595-check');
  let out = process.env.OUT || path.join(__dirname, 'build', 'out');
  if (process.env.CORPUS) dirs.push(process.env.CORPUS);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--corpus') dirs.push(argv[++i]);
    else if (a === '--qsp') qsp = argv[++i];
    else if (a === '--bin') bin = argv[++i];
    else if (a === '--out') out = argv[++i];
    else if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
    else { console.error('unknown argument ' + JSON.stringify(a) + '\n' + USAGE); process.exit(2); }
  }
  if (!dirs.length || !qsp) { console.error(USAGE); process.exit(2); }
  return { dirs, qsp, bin, out };
}

// name -> the driver's VARSPEC; a `$` name reads a string, a bare one a number.
// These are Girl Life's; point the gate at another game and edit the list.
const SPECS = [
  'money', '$pcs_nickname', 'hour', 'day',
  '$accessible_property[parents_home-name]', 'npc_fidelity[c0]', '$start_type[loc]',
];

/** What the CLASSIC file holds for one spec: the converter's own rule. */
function fromLegacy(parsed, spec) {
  const open = spec.indexOf('[');
  const rawName = open < 0 ? spec : spec.slice(0, open);
  const key = open < 0 ? null : spec.slice(open + 1, spec.lastIndexOf(']'));
  const name = rawName.replace(/^[$%#]/, '').toUpperCase();
  const v = parsed.vars.find((x) => x.name === name);
  if (!v) return 'MISSING';
  let ind = 0;
  if (key !== null) {
    const hit = v.indices.find((x) => x.key === key.toUpperCase());
    if (!hit) return 'MISSING-KEY';
    ind = hit.index;
  }
  const slot = v.values[ind];
  if (!slot) return 'MISSING';
  if (slot.num !== 0) return String(slot.num);   // a non-zero number wins
  if (slot.str !== '') return slot.str;
  return '0';
}

function run(bin, args) {
  const { spawnSync } = require('child_process');
  const r = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 1 << 26 });
  return (r.stdout || '') + (r.stderr || '');
}

function parseDriver(text) {
  const out = { vars: {}, pre: {}, raw: text };
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq), v = line.slice(eq + 1);
    if (k.startsWith('var:')) out.vars[k.slice(4)] = v;
    else if (k.startsWith('pre:')) out.pre[k.slice(4)] = v;
    else out[k] = v;
  }
  return out;
}

function main() {
  const { dirs, qsp: QSP, bin: BIN, out: OUT } = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(BIN)) {
    console.log('SKIP — no libqsp 5.9.5 driver at ' + BIN + '; build one with native-check/build.sh');
    process.exit(0);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const qspBytes = fs.readFileSync(QSP);
  const files = [];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d).sort()) {
      if (!f.endsWith('.sav')) continue;
      const p = path.join(d, f);
      try { legacySav.parseLegacySav(fs.readFileSync(p)); } catch (e) { continue; }
      files.push(p);
    }
  }
  console.log('driver: ' + BIN + '\ngame:   ' + QSP + '\nclassic saves: ' + files.length + '\n');
  if (!files.length) {
    console.log('SKIP — no classic save found in ' + dirs.join(', '));
    process.exit(0);
  }

  let failures = 0;
  let firstOut590 = null;
  for (const src of files) {
    const base = path.basename(src);
    const savBytes = fs.readFileSync(src);
    const parsed = legacySav.parseLegacySav(savBytes);
    const out595 = path.join(OUT, base.replace(/\.sav$/, '.595.sav'));
    let outBytes;
    try {
      outBytes = conv.convertBuffer({ savBytes, qspBytes, qspName: path.basename(QSP), target: '5.9.5' }).outBytes;
    } catch (e) {
      console.log('=== ' + base + '\n    FAIL — the converter refused: ' + e.message);
      failures++;
      continue;
    }
    fs.writeFileSync(out595, Buffer.from(outBytes));
    if (!firstOut590) {
      firstOut590 = path.join(OUT, base.replace(/\.sav$/, '.590.sav'));
      const r = conv.convertBuffer({ savBytes, qspBytes, qspName: path.basename(QSP) });
      fs.writeFileSync(firstOut590, Buffer.from(r.outBytes));
    }

    const d = parseDriver(run(BIN, [QSP, out595, ...SPECS]));
    console.log('=== ' + base);
    console.log('    ' + ['engine', 'open', 'error', 'ongload-error', 'loc']
      .filter((k) => d[k] !== undefined).map((k) => k + '=' + d[k]).join(' | '));
    if (d.open !== 'ok') { console.log('    FAIL — the engine refused the converted save'); failures++; continue; }
    // MISSING (no such variable) and MISSING-KEY (no such array key) are the
    // same fact from the two ends: nothing is stored under that name.
    const absent = (x) => x === 'MISSING' || x === 'MISSING-KEY';
    for (const spec of SPECS) {
      const want = fromLegacy(parsed, spec);
      const raw = d.pre[spec] === undefined ? 'MISSING' : d.pre[spec];
      const got = raw.replace(/^\d+\|/, '');
      const ok = absent(want) ? absent(got) : String(want) === String(got);
      if (!ok) failures++;
      const after = d.vars[spec] === undefined ? 'MISSING' : d.vars[spec];
      console.log('    ' + (ok ? 'ok  ' : 'FAIL') + ' ' + spec + ' engine=' + JSON.stringify(raw) +
        ' classic=' + JSON.stringify(want) +
        (after === raw ? '' : ' (after ONGLOAD: ' + JSON.stringify(after) + ')'));
    }
  }

  console.log('\n=== the premise: a 5.9.0 save handed to the 5.9.5 engine');
  const d590 = parseDriver(run(BIN, [QSP, firstOut590]));
  console.log('    ' + d590.raw.trim().split('\n').join('\n    '));
  if (d590.open !== 'refused') { console.log('    FAIL — 5.9.5 accepted a 5.9.0 save; the premise is wrong'); failures++; }

  console.log('\nVERDICT ' + (failures ? 'FAIL (' + failures + ')' : 'PASS'));
  process.exit(failures ? 1 : 0);
}

main();
