/**
 * Single cases of the EM test that the large sample files do not show.
 *
 * The fingerprints in `tools/golden/` cover the two real printers; here are the
 * cases that do not occur there: comments on move lines, other M486 spellings,
 * a mode switch mid-stream, a profile multiplier other than 1, the cut and its
 * retract seams, thumbnail replacement, plates rebuilt solid.
 * Run: node tools/test_em.mjs
 */
import { findObjects, buildEmPlan, VALUES } from '../js/em/objects.js';
import { moveE, codeOf } from '../js/gcode.js';
import { generateEm } from '../js/em/generator.js';
import { adviceText } from '../js/em/result.js';
import { replaceThumbnails } from '../js/settings.js';
import { emThumbnailLines } from '../js/em/thumbnail.js';

let failed = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name.padEnd(46) + (detail || ''));
  if (!ok) failed++;
}

/** Minimal SourceDocument, only as much as the EM test really reads. */
function makeDoc(opts) {
  const o = opts || {};
  return {
    settings: new Map([['use_relative_e_distances', o.relativeE ? '1' : '0'],
                       ...Object.entries(o.settings || {})]),
    printer: { relativeE: !!o.relativeE, bed: { x: 250, y: 250 } },
    material: {
      extrusionMultiplier: o.profile === undefined ? 1 : o.profile,
      filamentDiameter: 1.75, density: 1.24, cost: 25, filamentName: 'Test',
    },
    issues: [],
  };
}

/**
 * The single cases work on miniature files whose values are not the 56 of the
 * real plate, so `range` is wide by default; where the cut itself is under
 * test, a narrow range is passed in.
 */
function run(raw, opts, range) {
  const doc = makeDoc(opts);
  const plan = buildEmPlan(raw, doc, range || { from: 0, to: 10 });
  const res = plan.objects.length ? generateEm(plan) : null;
  return { doc, found: plan, res, codes: plan.issues.map(i => i.code) };
}

/* --- 1) Comment on a move line ---------------------------------------------
   An E inside a comment must not be read as a parameter. In absolute mode that
   would additionally wreck both counters. */
{
  const raw = [
    'M486 S0', 'M486 AEM_Cube-0.500.stl', 'M486 S-1',
    'M486 S0',
    'G1 X10 Y10 E1.0',
    'G1 X20 Y20 F9000 ; travel to next, E2.0 halten',
    'G1 X30 Y30 E2.0',
    'M486 S-1',
  ];
  const { res } = run(raw);
  const out = res.lines.slice(-4);
  check('comment on a move line is left alone',
    out[1] === 'G1 X20 Y20 F9000 ; travel to next, E2.0 halten',
    out[1]);
  // Absolute counting: after twice 0.5 the position is 1.0. Without the comment
  // handling E2.0 would have been read as the position and the rest shifted.
  check('extrusion after the comment still scales',
    out[2] === 'G1 X30 Y30 E1', out[2]);
  check('codeOf() cuts at the first semicolon',
    codeOf('G1 X1 ; E9') === 'G1 X1 ' && moveE('G1 X1 ; E9') === null);
}

/* --- 2) M486 A"name" with quotes ----------------------------------------- */
{
  const raw = ['M486 S0', 'M486 A"EM_Cube-0.900.stl"', 'M486 S-1',
    'M486 S0', 'G1 X1 Y1 E1', 'M486 S-1'];
  const { found } = run(raw);
  check('M486 A"quoted" is unquoted',
    found.objects.length === 1 && found.objects[0].value === 0.9,
    found.objects.length ? found.objects[0].name : '(none)');
}

/* --- 3) S and A on the same line ------------------------------------------ */
{
  const raw = ['M486 S0 AEM_Cube-0.800.stl', 'M486 S-1',
    'M486 S0', 'G1 X1 Y1 E1', 'M486 S-1'];
  const { found, res } = run(raw);
  check('M486 S<id> A<name> on one line',
    found.objects.length === 1 && found.objects[0].value === 0.8
    && res.stats.changedLines === 1,
    found.objects.length ? found.objects[0].name : '(none)');
}

/* --- 4) Mode switch mid-stream ---------------------------------------------
   After M83 … M82 the absolute position must be right: the relative passage
   counts towards it. 1.0 relative with factor 0.5 gives 0.5, so the absolute
   position afterwards is 1.0 in the source and 0.5 in the output. */
{
  const raw = [
    'M486 S0', 'M486 AEM_Cube-0.500.stl', 'M486 S-1',
    'M82', 'G92 E0',
    'M486 S0',
    'G1 X10 Y10 E1.0',      // absolute: delta 1.0 -> 0.5
    'M83',
    'G1 X20 Y20 E1.0',      // relative: 1.0 -> 0.5
    'M82',
    'G1 X30 Y30 E3.0',      // absolute: delta 1.0 -> 0.5, output 1.5
    'M486 S-1',
  ];
  const { res } = run(raw);
  const moves = res.lines.filter(l => l.startsWith('G1 X'));
  check('E mode switch mid-stream keeps the chain',
    moves.join(' | ') === 'G1 X10 Y10 E.5 | G1 X20 Y20 E.5 | G1 X30 Y30 E1.5',
    moves.join(' | '));
  // The last move is absolute: 0.5 (abs) + 0.5 (rel) + 0.5 = 1.5.
  check('absolute value after the switch is continuous',
    moves[2] === 'G1 X30 Y30 E1.5', moves[2]);
}

/* --- 5) Value outside the plausible range --------------------------------- */
{
  const raw = ['M486 S0', 'M486 AEM_Cube-3.000.stl', 'M486 S-1',
    'M486 S0', 'G1 X1 Y1 E1', 'M486 S-1'];
  const { res, codes } = run(raw);
  const reason = res.lines.find(l => l.startsWith('; em object 0 '));
  check('out-of-range value gives W24 and the right reason',
    codes.indexOf('W24') !== -1 && /removed, value outside the plausible range/.test(reason || ''),
    reason);
  check('out-of-range object gets a cancel command',
    res.lines.indexOf('M486 P0') !== -1);
}

/* --- 6) Profile multiplier other than 1 ----------------------------------- */
{
  const raw = ['M486 S0', 'M486 AEM_Cube-0.855.stl', 'M486 S-1',
    'M486 S0', 'G1 X1 Y1 E1', 'M486 S-1'];
  const { doc, found, res, codes } = run(raw, { profile: 0.95 });
  const f = found.objects[0].factor;
  check('factor divides by the profile multiplier',
    Math.abs(f - 0.855 / 0.95) < 1e-12 && codes.indexOf('W21') !== -1, f.toFixed(5));
  check('scaled E follows that factor',
    res.lines[res.lines.length - 2] === 'G1 X1 Y1 E.9',
    res.lines[res.lines.length - 2]);
  check('M221 advice divides by the profile too',
    /M221 S90\.0\b/.test(adviceText(doc, 0.855, 0.95)),
    adviceText(doc, 0.855, 0.95).split('\n').pop());
}

/* --- 7) M commands carrying E stay untouched ------------------------------ */
{
  const raw = ['M486 S0', 'M486 AEM_Cube-0.500.stl', 'M486 S-1',
    'M486 S0', 'M201 X10000 Y10000 E5000', 'M205 X10.00 E10.00', 'M84 E',
    'G1 X1 Y1 E1', 'M486 S-1'];
  const { res } = run(raw);
  check('M201/M205/M84 keep their E parameters',
    res.lines.indexOf('M201 X10000 Y10000 E5000') !== -1
    && res.lines.indexOf('M205 X10.00 E10.00') !== -1
    && res.lines.indexOf('M84 E') !== -1
    && res.stats.changedLines === 1);
}

/* --- 8) Indentation is preserved ------------------------------------------ */
{
  const raw = ['M486 S0', 'M486 AEM_Cube-0.500.stl', 'M486 S-1',
    'M486 S0', '   G1 X1 Y1 E1   ', 'M486 S-1'];
  const { res } = run(raw);
  check('leading and trailing spaces survive',
    res.lines[res.lines.length - 2] === '   G1 X1 Y1 E.5   ',
    JSON.stringify(res.lines[res.lines.length - 2]));
}

/* --- 9) Unreadable name: toolpaths go, the declaration stays ----------------
   The file states exactly what is printed. The declaration has to stay -- with
   M486 the object numbers hang on it. */
{
  const raw = ['M486 S0', 'M486 AWasAuchImmer.stl', 'M486 S-1',
    'M486 S0', 'G1 X1 Y1 E1', 'G1 E-.7', 'M486 S-1'];
  const { res, codes } = run(raw);
  check('a plate with an unreadable name is cut out',
    res.lines.indexOf('G1 X1 Y1 E1') === -1 && codes.indexOf('W20') !== -1
    && codes.indexOf('E12') !== -1, res.lines.join(' | '));
  check('its declaration stays, the object numbers hang on it',
    res.lines.indexOf('M486 AWasAuchImmer.stl') !== -1);
  check('and it is cancelled on the printer',
    res.lines.indexOf('M486 P0') !== -1);
}

/* --- 10) Too few usable plates -------------------------------------------- */
{
  const raw = ['M486 S0', 'M486 AEM_Cube-0.900.stl', 'M486 S-1',
    'M486 S1', 'M486 AFremdling.stl', 'M486 S-1',
    'M486 S0', 'G1 X1 Y1 E1', 'M486 S-1',
    'M486 S1', 'G1 X5 Y5 E1', 'M486 S-1'];
  const { codes } = run(raw);
  check('a single usable plate is flagged', codes.indexOf('W28') !== -1, codes.join(','));
}

/* --- 11) E mode cannot be determined -------------------------------------- */
{
  const raw = ['M486 S0', 'M486 AEM_Cube-0.900.stl', 'M486 S-1',
    'M486 S0', 'G1 X1 Y1 E1', 'M486 S-1'];
  const doc = makeDoc();
  doc.settings = new Map();                 // neither the setting nor M82/M83
  const codes = findObjects(raw, doc).issues.map(i => i.code);
  check('missing E mode is reported', codes.indexOf('W27') !== -1, codes.join(','));
}

/* --- 12) Number format as PrusaSlicer writes it --------------------------- */
{
  const raw = ['M486 S0', 'M486 AEM_Cube-0.500.stl', 'M486 S-1',
    'M486 S0', 'G1 X1 Y1 E.02', 'G1 X2 Y2 E4', 'M486 S-1'];
  const { res } = run(raw);
  check('no leading zero, no trailing zeros',
    res.lines[res.lines.length - 3] === 'G1 X1 Y1 E.01'
    && res.lines[res.lines.length - 2] === 'G1 X2 Y2 E2',
    res.lines.slice(-3, -1).join(' | '));
}

/* --- 13) A large backward jump shows up in relative mode too -------------- */
{
  const raw = ['M486 S0', 'M486 AEM_Cube-0.500.stl', 'M486 S-1',
    'M486 S0', 'G1 X1 Y1 E1', 'G1 E-50', 'M486 S-1'];
  const { res } = run(raw, { relativeE: true });
  check('an absurd retract survives generation unchanged',
    res.lines.indexOf('G1 E-50') !== -1);
}

/* --- 13b) Names without a prefix -------------------------------------------
   Whoever creates the cubes in the slicer directly just names them after their
   value. Both spellings must work, and whatever cannot be a multiplier still
   has to be rejected. */
{
  const raw = [
    'M486 S0', 'M486 A0.850', 'M486 S-1',
    'M486 S1', 'M486 A0_855', 'M486 S-1',
    'M486 S2', 'M486 AEM_Cube-0.860.stl', 'M486 S-1',
    'M486 S3', 'M486 A12.5', 'M486 S-1',
    'M486 S4', 'M486 ACube', 'M486 S-1',
    'M486 S0', 'G1 X1 Y1 E1', 'M486 S-1',
    'M486 S1', 'G1 X2 Y2 E2', 'M486 S-1',
    'M486 S2', 'G1 X3 Y3 E3', 'M486 S-1',
    'M486 S3', 'G1 X4 Y4 E4', 'M486 S-1',
    'M486 S4', 'G1 X5 Y5 E5', 'M486 S-1',
  ];
  const { found } = run(raw);
  const val = n => { const o = found.objects.find(o => o.name === n); return o && o.value; };
  check('a bare value is a valid name', val('0.850') === 0.85, String(val('0.850')));
  check('klipper writes it with an underscore', val('0_855') === 0.855, String(val('0_855')));
  check('the old prefixed form still works', val('EM_Cube-0.860.stl') === 0.86,
    String(val('EM_Cube-0.860.stl')));
  check('a number outside the plausible range is skipped',
    found.objects.find(o => o.name === '12.5').skip === true);
  check('a name without digits is skipped',
    found.objects.find(o => o.name === 'Cube').skip === true);
}

/* --- 14) Replacing the thumbnails ------------------------------------------
   The EM output is the source file; its images have to go and the new ones take
   the same place. Everything outside the blocks stays line for line. */
{
  const raw = [
    '; generated by PrusaSlicer',
    '; thumbnail_QOI begin 16x16 8',
    '; AAAAAAAA',
    '; thumbnail_QOI end',
    'G1 X1 Y1 E1',
    '; thumbnail begin 32x32 4',
    '; BBBB',
    '; thumbnail end',
    'G1 X2 Y2 E1',
  ];
  const blocks = [';', '; thumbnail_QOI begin 16x16 4', '; CCCC', '; thumbnail_QOI end', ';'];
  const out = replaceThumbnails(raw, blocks);
  check('both source blocks are gone',
    out.filter(l => /AAAA|BBBB/.test(l)).length === 0);
  check('new block sits where the first one stood',
    out[1] === ';' && out[2] === '; thumbnail_QOI begin 16x16 4',
    out.slice(0, 3).join(' | '));
  check('everything else is untouched',
    out.filter(l => !/^;/.test(l)).join('|') === 'G1 X1 Y1 E1|G1 X2 Y2 E1');
  check('null only strips',
    replaceThumbnails(raw, null).length === 3);
  check('a file without blocks gains none',
    replaceThumbnails(['G1 X1 Y1 E1'], blocks).length === 1);
  check('a block without an end does not swallow the rest',
    replaceThumbnails(['; thumbnail begin 8x8 4', '; DDDD', 'G1 X1 Y1 E1'], null)
      .join('|') === 'G1 X1 Y1 E1');
}

/* --- 15) Without a DOM no images are produced ------------------------------
   That is why gen_em.mjs and check_em.py keep writing the same file as before;
   only the browser attaches images. */
{
  const raw = ['M486 S0', 'M486 AEM_Cube-0.500.stl', 'M486 S-1',
    'M486 S0', 'G1 X1 Y1 E1', 'M486 S-1'];
  const { found } = run(raw);
  check('no canvas, no thumbnails',
    emThumbnailLines(Object.assign({ raw }, found),
      [{ w: 16, h: 16, fmt: 'QOI' }]).length === 0);
}


/* --- 16) The cut -----------------------------------------------------------
   Three plates, two layers. The third one is printed last in every layer: its
   bracket reaches across the layer change and holds the layer's retract. If it
   is dropped, the layer change must remain -- and the retract must go, because
   the second plate has already retracted. */
function threePlates() {
  const L = [];
  for (const [id, name] of [[0, '0.900'], [1, '1.000'], [2, '1.100']]) {
    L.push('M486 S' + id, 'M486 A' + name, 'M486 S-1');
  }
  const plate = id => ['M486 S-1', 'M486 S' + id,
    'G1 E.7 F1500', 'G1 X' + (10 + id * 30) + ' Y10 E1', 'G1 E-.7 F2700',
    'G1 X' + (30 + id * 30) + ' Y10 F9000'];
  for (const z of ['0.2', '0.5']) {
    L.push(';LAYER_CHANGE', ';Z:' + z);
    L.push(...plate(0), ...plate(1));
    // The third plate without a closing retract: as in the real files that one
    // comes only with the layer change.
    L.push('M486 S-1', 'M486 S2', 'G1 E.7 F1500', 'G1 X100 Y10 E1');
  }
  L.push(';LAYER_CHANGE', ';Z:0.8', 'G1 E-.7 F2700', ';AFTER_LAYER_CHANGE');
  return L;
}

{
  const raw = threePlates();
  const { res } = run(raw, { relativeE: true }, { from: 0.9, to: 1.0 });
  const L = res.lines;
  const at = re => L.filter(x => re.test(x)).length;
  check('the removed plate prints nowhere any more',
    at(/^G1 X100 Y10/) === 0 && at(/^M486 S2$/) === 1,   // only the declaration is left
    L.filter(x => /X100|S2$/.test(x)).join(' | '));
  check('the kept plates are still there once per layer',
    at(/^G1 X10 Y10 E/) === 2 && at(/^G1 X40 Y10 E/) === 2,
    at(/^G1 X10 Y10 E/) + '/' + at(/^G1 X40 Y10 E/));
  check('every layer change survives',
    at(/^;LAYER_CHANGE$/) === raw.filter(x => x === ';LAYER_CHANGE').length,
    at(/^;LAYER_CHANGE$/) + ' of ' + raw.filter(x => x === ';LAYER_CHANGE').length);
  check('the declaration of the removed plate stays, and it is cancelled',
    L.indexOf('M486 A1.100') !== -1 && L.indexOf('M486 P2') !== -1);

  // The actual test: retract and deretract must alternate.
  const pure = [];
  for (const line of L) {
    const m = /^G1\s+E(-?(?:\d+(?:\.\d*)?|\.\d+))\s+F/.exec(line);
    if (m) pure.push(parseFloat(m[1]));
  }
  let doubled = 0;
  for (let i = 1; i < pure.length; i++) if ((pure[i] < 0) === (pure[i - 1] < 0)) doubled++;
  check('retract and deretract still alternate', doubled === 0, pure.join(' '));
  check('the doubled layer-change retract was dropped',
    res.stats.seamFixes === 1, 'seamFixes ' + res.stats.seamFixes);
  // The counter-test: a deretract the output needs must not be dropped.
  check('every extrusion is preceded by a deretract',
    (() => {
      let primed = false;
      for (const line of L) {
        const m = /^G1\s+E(-?(?:\d+(?:\.\d*)?|\.\d+))\s+F/.exec(line);
        if (m) { primed = parseFloat(m[1]) > 0; continue; }
        if (/^G1 X\d+ Y\d+ E/.test(line) && !primed) return false;
      }
      return true;
    })(), 'ein Zug extrudiert im zurueckgezogenen Zustand');
}

/* --- 16b) Any number of layers, plates of differing heights ----------------
   How many layers come out is decided by the user's layer height. Nothing in
   the tool may depend on it -- and a plate that ends earlier changes, in its
   last layers, which block is the last one. That is exactly where the seam
   sits. */
function stack(layers, tall) {
  const names = ['0.900', '1.000', '1.100'];
  const L = [];
  names.forEach((n, id) => L.push('M486 S' + id, 'M486 A' + n, 'M486 S-1'));
  for (let z = 0; z < layers; z++) {
    L.push(';LAYER_CHANGE', ';Z:' + (0.2 + z * 0.2).toFixed(1));
    // `tall` says per object up to which layer it reaches.
    const here = names.map((_, id) => id).filter(id => z < (tall ? tall[id] : layers));
    here.forEach((id, k) => {
      L.push('M486 S-1', 'M486 S' + id, 'G1 E.7 F1500',
        'G1 X' + (10 + id * 30) + ' Y' + (10 + z) + ' E1');
      // As in the real files the last block of a layer does not retract
      // itself -- the layer change does.
      if (k < here.length - 1) L.push('G1 E-.7 F2700', 'G1 X' + (30 + id * 30) + ' Y10 F9000');
    });
    L.push('G1 E-.7 F2700');          // retract of the layer change
  }
  return L;
}

function cutOk(raw, range) {
  const { res } = run(raw, { relativeE: true }, range);
  const L = res.lines;
  // Retract and deretract must alternate, and the nozzle must be primed before
  // every extrusion.
  let primed = false, doubled = 0, dry = 0, last = null;
  for (const line of L) {
    const m = /^G1\s+E(-?(?:\d+(?:\.\d*)?|\.\d+))\s+F/.exec(line);
    if (m) {
      const back = parseFloat(m[1]) < 0;
      if (last !== null && back === last) doubled++;
      last = back; primed = !back;
      continue;
    }
    if (/^G1 X\d+ Y\d+ E/.test(line) && !primed) dry++;
  }
  return { L, doubled, dry,
           layers: L.filter(x => x === ';LAYER_CHANGE').length };
}

{
  for (const n of [1, 2, 5, 40]) {
    const raw = stack(n);
    const r = cutOk(raw, { from: 0.9, to: 1.0 });      // the third one is dropped
    check(n + ' layer(s): retraction stays sane and every layer survives',
      r.doubled === 0 && r.dry === 0 && r.layers === n,
      'doppelt ' + r.doubled + ', trocken ' + r.dry + ', Schichten ' + r.layers + '/' + n);
    check(n + ' layer(s): the removed plate prints nowhere',
      r.L.filter(x => /^G1 X70 Y/.test(x)).length === 0);
    check(n + ' layer(s): the kept plates print in every layer',
      r.L.filter(x => /^G1 X10 Y/.test(x)).length === n &&
      r.L.filter(x => /^G1 X40 Y/.test(x)).length === n,
      r.L.filter(x => /^G1 X10 Y/.test(x)).length + '/' +
      r.L.filter(x => /^G1 X40 Y/.test(x)).length);
  }
}

{
  // Plates of differing heights: from layer 4 the third is gone, from layer 7
  // the second as well. The last block per layer therefore changes three times.
  const raw = stack(9, [9, 7, 4]);
  const r = cutOk(raw, { from: 0.9, to: 1.0 });
  check('plates of different heights: retraction stays sane',
    r.doubled === 0 && r.dry === 0 && r.layers === 9,
    'doppelt ' + r.doubled + ', trocken ' + r.dry + ', Schichten ' + r.layers);
  check('plates of different heights: each keeps its own number of layers',
    r.L.filter(x => /^G1 X10 Y/.test(x)).length === 9 &&
    r.L.filter(x => /^G1 X40 Y/.test(x)).length === 7 &&
    r.L.filter(x => /^G1 X70 Y/.test(x)).length === 0,
    r.L.filter(x => /^G1 X10 Y/.test(x)).length + '/' +
    r.L.filter(x => /^G1 X40 Y/.test(x)).length + '/' +
    r.L.filter(x => /^G1 X70 Y/.test(x)).length);
}

/* --- 17) Absolute counting across a cut ------------------------------------
   The output counter must not keep running over the removed moves, otherwise
   the next kept plate would feed the whole difference at once. */
{
  const raw = ['M486 S0', 'M486 A1.000', 'M486 S-1',
    'M486 S1', 'M486 A1.000', 'M486 S-1',
    'M82', 'G92 E0',
    'M486 S-1', 'M486 S0', 'G1 X10 Y10 E5', 'G1 X20 Y20 E10',
    'M486 S-1', 'M486 S1', 'G1 X30 Y30 E15', 'G1 X40 Y40 E20'];
  const { res } = run(raw, { relativeE: false }, { from: 1.0, to: 1.0 });
  // Both are named 1.000, so no factor applies -- what remains is the cut.
  const moves = res.lines.filter(l => /^G1 X/.test(l));
  check('after a cut the kept plate starts where the printer really is',
    moves.length === 4, moves.join(' | '));
}

/* --- 17b) Travel to a removed plate is put back on the direct line ---------
   The slicer emits the approach to a plate partly before its start marker, so
   cutting the plate leaves that half behind. Here the middle plate goes: the
   head must not visit its corner any more. */
{
  const decl = [];
  for (const [id, name] of [[0, '0.900'], [1, '1.000'], [2, '1.100']]) {
    decl.push('M486 S' + id, 'M486 A' + name, 'M486 S-1');
  }
  // Per plate: retract, the ramp toward it (BEFORE its marker), then its marker,
  // the last approach segment, deretract, one extrusion.
  const plate = (id, ramp) => ['G1 E-.7 F2700']
    .concat(ramp.map(p => 'G1 X' + p[0] + ' Y' + p[1] + ' F21000'))
    .concat(['M486 S-1', 'M486 S' + id,
             'G1 X' + (10 + id * 40) + ' Y10 F21000', 'G1 E.7 F1500',
             'G1 X' + (30 + id * 40) + ' Y10 E1']);
  const raw = decl.concat([';LAYER_CHANGE', ';Z:0.2'],
    plate(0, [[5, 60], [8, 40]]),
    plate(1, [[45, 80], [48, 50]]),      // ramp toward the middle plate
    plate(2, [[85, 90], [88, 60]]),
    [';LAYER_CHANGE', ';Z:0.5', 'G1 E-.7 F2700', ';AFTER_LAYER_CHANGE']);
  const { res } = run(raw, { relativeE: true }, { from: 1.05, to: 1.15 });
  const L = res.lines;
  const xy = L.filter(l => /^G1 X[\d.]+ Y[\d.]+ F21000$/.test(l))
              .map(l => l.match(/X([\d.]+) Y([\d.]+)/).slice(1, 3).map(Number));
  check('the ramp toward the removed plate no longer reaches its corner',
    !xy.some(p => Math.abs(p[0] - 45) < 1 && Math.abs(p[1] - 80) < 1),
    xy.map(p => p.join('/')).join(' '));
  check('the redirected points lie on the line to the plate really printed',
    xy.filter(p => p[1] > 60).every(p => p[0] > 40), xy.map(p => p.join('/')).join(' '));
  // The property that matters: the points are on the line, not merely nearer
  // to it. Cross product of (last - first) with (point - first) has to vanish.
  const [ax, ay] = xy[0], [bx, by] = xy[xy.length - 1];
  const off = xy.map(([x, y]) => Math.abs((bx - ax) * (y - ay) - (by - ay) * (x - ax))
                                 / Math.hypot(bx - ax, by - ay));
  check('every redirected point lies on that line',
    Math.max(...off) < 0.01, off.map(v => v.toFixed(3)).join(' '));
  check('the generator counts what it straightened',
    res.stats.travelFixes > 0, String(res.stats.travelFixes));

  // Nothing cut: not a single coordinate may move.
  const whole = run(raw, { relativeE: true }, { from: 0.85, to: 1.15 });
  check('without a cut no travel is touched',
    whole.res.stats.travelFixes === 0, String(whole.res.stats.travelFixes));
}

/* --- 17c) Coarse mode: only the whole percent values ----------------------- */
{
  const raw = fullPlate(null);
  const doc = makeDoc({});
  const whole = v => Math.round(v * 1000) % 10 === 0;

  const coarse = buildEmPlan(raw, doc, { fine: false });
  check('coarse prints half the plate',
    coarse.printed.length === VALUES.filter(whole).length,
    coarse.printed.length + ' of ' + VALUES.length);
  check('and only whole percent values',
    coarse.printed.every(o => whole(o.value)),
    coarse.printed.filter(o => !whole(o.value)).map(o => o.value).join(','));

  // The grid hangs on the value, not on where the range starts: from 0.955 the
  // 0.960 is printed, not the 0.955 itself.
  const off = buildEmPlan(raw, doc, { from: 0.955, to: 0.975, fine: false });
  check('the grid does not follow the range start',
    off.printed.map(o => o.value.toFixed(3)).join(',') === '0.960,0.970',
    off.printed.map(o => o.value.toFixed(3)).join(','));

  const none = buildEmPlan(raw, doc, { from: 0.955, to: 0.955, fine: false });
  check('a range without a whole percent value is an error',
    none.issues.some(i => i.code === 'E14' && i.level === 'error'
                          && /whole percent/.test(i.text)),
    none.issues.map(i => i.code).join(','));

  // Ticked, the plan has to be the one it always was.
  const a = buildEmPlan(raw, doc, {});
  const b = buildEmPlan(raw, doc, { fine: true });
  check('half-percent steps change nothing',
    a.printed.length === VALUES.length && b.printed.length === VALUES.length,
    a.printed.length + '/' + b.printed.length);
}

/* --- 18) An incomplete plate is an error ---------------------------------- */
function fullPlate(drop) {
  const L = [];
  const use = VALUES.filter(v => v !== drop);
  use.forEach((v, i) => L.push('M486 S' + i, 'M486 A' + v.toFixed(3), 'M486 S-1'));
  use.forEach((v, i) => L.push('M486 S-1', 'M486 S' + i,
    'G1 X' + (i + 1) + ' Y1 E' + (i + 1)));
  return L;
}
{
  const short = buildEmPlan(fullPlate(VALUES[20]), makeDoc({}), {});
  check('a plate short of the full set is refused',
    short.issues.some(i => i.code === 'E13' && i.level === 'error'),
    short.issues.map(i => i.code).join(','));
  const whole = buildEmPlan(fullPlate(null), makeDoc({}), {});
  check('the complete plate is accepted',
    !whole.issues.some(i => i.code === 'E13'),
    whole.issues.map(i => i.code).join(','));
  check('and the default range prints all of it',
    whole.printed.length === VALUES.length, String(whole.printed.length));
}

/* --- 19) Plates rebuilt solid ----------------------------------------------
   One feature type set per layer; two plates, Klipper or Marlin, absolute or
   relative E, as the real files lay out a layer head. */
function layered(types, opts) {
  const o = opts || {};
  const klipper = !!o.klipper, absolute = !o.relativeE;
  const names = ['0.950', '1.050'];
  const tag = n => n.replace('.', '_');
  const L = [];
  names.forEach((n, id) => L.push(...(klipper ? ['EXCLUDE_OBJECT_DEFINE NAME=' + tag(n)]
                                              : ['M486 S' + id, 'M486 A' + n, 'M486 S-1'])));
  let e = 0, x = 0, prevZ;
  const e1 = step => absolute ? String(Math.round((e += step) * 1e4) / 1e4) : String(step);
  // As in the real files the layer change carries the last plate's retract,
  // the stay move at the old height and, on Klipper, the end of its object.
  // The plate order and the extruded length change from layer to layer, so a
  // copied layer finds neither the E counter nor the open object it was sliced after.
  let last = null;
  types.forEach((kinds, layer) => {
    const z = String(Math.round((layer + 1) * 2) / 10);
    L.push(';LAYER_CHANGE', ';Z:' + z, ';HEIGHT:0.2', ';' + z, 'G1 E' + e1(-.7) + ' F2100');
    if (absolute) { L.push('G92 E0'); e = 0; }
    if (layer) L.push('G1 X' + x + ' Y' + (9 + layer) + ' Z' + prevZ);
    L.push('G1 X5 Y5 Z' + z);
    if (klipper && last) L.push('EXCLUDE_OBJECT_END NAME=' + tag(last));
    if (layer === 1) L.push('M106 S255');
    const ids = layer % 3 ? [0, 1] : [1, 0];
    ids.forEach((id, k) => {
      const n = names[id];
      L.push(klipper ? 'EXCLUDE_OBJECT_START NAME=' + tag(n) : 'M486 S' + id);
      L.push('G1 X' + (10 + id * 30) + ' Y10 Z' + z, 'G1 E' + e1(.7) + ' F1500');
      for (const kind of kinds.split(',')) {
        L.push(';TYPE:' + kind, 'G1 X' + (20 + id * 30) + ' Y' + (10 + layer) + ' E' + e1(1 + layer / 10));
      }
      x = 20 + id * 30;
      last = n;
      if (k === 0) L.push('G1 E' + e1(-.7) + ' F2100', klipper ? 'EXCLUDE_OBJECT_END NAME=' + tag(n) : 'M486 S-1');
    });
    prevZ = z;
  });
  L.push(klipper ? 'EXCLUDE_OBJECT_END NAME=' + tag(last) : 'M486 S-1');
  return L;
}
const SI = 'External perimeter,Solid infill', II = 'External perimeter,Internal infill';
const BR = 'External perimeter,Bridge infill', TOP = 'External perimeter,Top solid infill';
const PLATE = [SI, SI, II, II, II, II, BR, SI, SI, SI, TOP];
const layerZ = L => L.filter(l => l.startsWith(';Z:')).map(l => l.slice(3)).join(' ');
const mapLayers = L => (L.find(l => l.startsWith('; em layers = ')) || '').slice(14);
{
  const { found, res } = run(layered(Array(11).fill(SI)));
  check('a solid plate stays as sliced', found.rebuild === null && !mapLayers(res.lines));
}
for (const opts of [{}, { relativeE: true }, { klipper: true }, { klipper: true, relativeE: true }]) {
  const raw = layered(PLATE, opts);
  const { found, res } = run(raw, opts);
  const L = res.lines;
  const tag = (opts.klipper ? 'klipper' : 'marlin') + (opts.relativeE ? '/rel' : '/abs') + ': ';
  check(tag + 'bottom, two infill, bridge, pair, top', mapLayers(L) === '1 2 5 6 7 8 9 8 9 8 11',
    mapLayers(L));
  check(tag + 'heights run on as sliced', layerZ(L) === layerZ(raw), layerZ(L));
  check(tag + 'no move outside the plate height',
    L.every(l => !/^G1 .*Z(\d+\.?\d*)/.test(l) || parseFloat(/Z(\d+\.?\d*)/.exec(l)[1]) <= 2.6));
  // Every extrusion adds the same, so the E counter must climb in steps of one.
  let e = 0, bad = 0;
  for (const l of L) {
    const g92 = /^G92 E(\S+)/.exec(l);
    if (g92) { e = parseFloat(g92[1]); continue; }
    const m = /^G1 (.*)E(\S+)/.exec(l);
    if (!m) continue;
    const step = opts.relativeE ? parseFloat(m[2]) : parseFloat(m[2]) - e;
    if (!opts.relativeE) e = parseFloat(m[2]);
    const y = /Y(\d+)/.exec(m[1]);
    const want = !m[1] ? .7 : (l.includes('X20 ') ? .95 : 1.05) * (1 + (y[1] - 10) / 10);
    if (Math.abs(Math.abs(step) - want) > 1e-6) bad++;
  }
  check(tag + 'E counter consistent across the seams', bad === 0, bad + ' bad');
  // A travel below the current layer may only stay in place: anything else
  // drags the nozzle over the plate.
  let x = null, y = null, z = 0, dragged = 0;
  for (const l of L) {
    if (l.startsWith(';Z:')) z = parseFloat(l.slice(3));
    const mv = /^G1 (.*)/.exec(l);
    if (!mv) continue;
    const at = a => { const v = new RegExp(a + '(-?[\\d.]+)').exec(mv[1]); return v ? parseFloat(v[1]) : null; };
    if (at('Z') !== null && at('Z') < z - 1e-6 && ((at('X') ?? x) !== x || (at('Y') ?? y) !== y)) dragged++;
    x = at('X') ?? x; y = at('Y') ?? y;
  }
  check(tag + 'no travel across the plate below the layer', dragged === 0, dragged + ' dragged');
  if (opts.klipper) {
    let open = null, mismatched = 0;
    for (const l of L) {
      const start = /^EXCLUDE_OBJECT_START NAME=(\S+)/.exec(l);
      const end = /^EXCLUDE_OBJECT_END NAME=(\S+)/.exec(l);
      if (start) open = start[1];
      if (end) { if (end[1] !== open) mismatched++; open = null; }
    }
    check(tag + 'every object end names the open object', mismatched === 0, mismatched + ' mismatched');
  }
  check(tag + 'reported in the result', found.rebuild && found.issues.every(i => i.code !== 'W53'));
}
for (const [name, types, order] of [
  ['three bottom, five top layers', [SI, SI, SI, II, II, II, BR, SI, SI, SI, SI, TOP], '1 2 3 5 6 7 9 8 9 8 9 12'],
  ['just two infill layers', [SI, SI, II, II, BR, SI, SI, TOP], '1 2 3 4 5 6 7 8'],
]) {
  const { res } = run(layered(types));
  check(name + ': ' + order, mapLayers(res.lines) === order, mapLayers(res.lines));
}
{
  const { found } = run(layered([SI, SI, II, BR, SI, SI, TOP]));
  check('a single infill layer is refused with W53',
    found.rebuild === null && found.issues.some(i => i.code === 'W53'),
    found.issues.map(i => i.code).join(','));
}
{
  const { found } = run(layered([SI, SI, II, II, II, II, BR, SI, TOP]));
  check('three top layers are refused with W53',
    found.rebuild === null && found.issues.some(i => i.code === 'W53'),
    found.issues.map(i => i.code).join(','));
}
{
  const settings = { ironing: '1', top_solid_infill_speed: '50%', solid_infill_speed: '200%',
                     infill_speed: '100', fill_density: '15%' };
  const codes = run(layered(PLATE), { settings }).codes;
  check('ironing, top speed and sparse infill warned',
    ['W50', 'W51', 'W52'].every(c => codes.includes(c)), codes.join(','));
  const auto = run(layered(PLATE), { settings: { top_solid_infill_speed: '0', max_print_speed: '200' } }).codes;
  check('top speed 0 is auto: max_print_speed', auto.includes('W51'), auto.join(','));
  const calm = run(layered(PLATE), { settings: { top_solid_infill_speed: '60', fill_density: '30%' } }).codes;
  check('no setting warning within the limits',
    !calm.some(c => ['W50', 'W51', 'W52'].includes(c)), calm.join(','));
}

console.log('');
console.log(failed ? failed + ' check(s) failed' : 'all checks passed');
process.exit(failed ? 1 : 0);
