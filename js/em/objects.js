/**
 * em/objects.js — finds the labelled objects of a slicer file and reads each
 * object's target extrusion multiplier from its name.
 *
 * All G-code parsing lives here: the generator uses the same helpers and the
 * same line -> object mapping, so the two passes cannot drift apart.
 */

import { issue } from '../settings.js';
import { MOVE_RE, codeOf, moveE, eModeChange, g92E } from '../gcode.js';

/**
 * Name scheme. The value may stand alone ("0.945") or follow the prefix
 * ("EM_Cube-0.945"); a suffix such as "_stl" is swallowed. Klipper replaces
 * everything non-alphanumeric with "_", so an underscore counts as a dot.
 *
 * The bare value is allowed because cubes can also be named directly in the
 * slicer. A digit name that cannot be a multiplier is caught by the range check.
 */
const NAME_RE = /^(?:EM_Cube[-_])?(\d+)[._](\d+)(?:[._][A-Za-z0-9]+)?$/i;

/* --- The plate -------------------------------------------------------------
   The template carries 56 plates from 0.850 to 1.125 in steps of 0.005. The
   series is fixed, like the tower's 21 bands: only then can the tool check that
   the whole plate was really sliced, and only then is the "From"/"To" selection
   predictable. */
const PLATES = 56;
const EM_BASE = 0.850, EM_STEP = 0.005;
export const VALUES = Array.from({ length: PLATES },
  (_, i) => Math.round((EM_BASE + i * EM_STEP) * 1000) / 1000);

const LAYER_MARK = ';LAYER_CHANGE';

const EM_MIN = 0.4;
const EM_MAX = 2.0;

// Per Marlin, S and A may sit on the same line; PrusaSlicer separates them,
// other slicers do not. One rule covers both, otherwise the combined form falls
// through silently and the object stays unscaled.
const M486_S  = /^M486\s+S\s*(-?\d+)\b/i;
const M486_A  = /^M486\s+(?:S\s*-?\d+\s+)?A\s*(.+?)\s*$/i;
// NAME is taken verbatim (quotes included) so the cancel command looks exactly
// like the declaration — how Klipper normalises names then does not matter.
const XO_NAME = "\\s+NAME\\s*=\\s*('[^']*'|\"[^\"]*\"|\\S+)";
const XO_DEF  = new RegExp('^EXCLUDE_OBJECT_DEFINE' + XO_NAME, 'i');
const XO_START = new RegExp('^EXCLUDE_OBJECT_START' + XO_NAME, 'i');
const XO_END  = /^EXCLUDE_OBJECT_END\b/i;
const OCTOPRINT = /^;\s*printing object\b/i;

/** Only needed here: object bounding box and flow factor. */
const NUM = '(-?(?:\\d+(?:\\.\\d*)?|\\.\\d+))';
const X_RE = new RegExp('(^|\\s)X' + NUM);
const Y_RE = new RegExp('(^|\\s)Y' + NUM);
const M221_RE = /^M221\b[^;]*?(?:^|\s)S\s*([\d.]+)/i;

function unquote(s) {
  return s.replace(/^['"]|['"]$/g, '');
}

/** Value from the object name, null if the name does not match the scheme. */
function valueFromName(name) {
  const m = NAME_RE.exec(String(name).trim());
  return m ? parseFloat(m[1] + '.' + m[2]) : null;
}

function newObject(id, name, token) {
  return {
    id, name, token,
    value: null, factor: null, skip: true, reason: 'noname',
    minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity,
    cx: NaN, cy: NaN, eIn: 0, blocks: 0,
  };
}

/**
 * One pass over the raw lines. `raw` is the unfiltered file, `doc` the
 * SourceDocument from settings.js.
 */
export function findObjects(raw, doc) {
  const em = doc.material.extrusionMultiplier;
  const profile = Number.isFinite(em) && em > 0 ? em : 1;
  const issues = [];
  const objects = [];
  const byKey = new Map();            // M486 id or Klipper name -> index
  const owner = new Int32Array(raw.length).fill(-1);
  // Every marker point in order, plus the layer changes; the individually
  // cuttable blocks are built from these below.
  const marks = [];                   // {obj, line, open, ext}
  const lcLines = [];
  let curMark = -1;                   // index into marks of the open block

  let flavor = null;
  let declEnd = -1;
  let cur = -1;                       // index into objects, -1 = outside
  let spanHasExtrusion = false;
  let curId = -1;                     // for "M486 A" without its own S
  let nextId = 0;                     // Klipper: order of the DEFINE lines
  let octoprint = false;
  let flowOverride = null;
  let sawMode = false;

  // M82/M83 in the stream beat the profile setting: that is what the printer
  // actually sees.
  const absoluteE = !doc.printer.relativeE;
  let absE = absoluteE;
  let e = 0, px = 0, py = 0;

  const openSpan = idx => {
    if (cur >= 0 && spanHasExtrusion) objects[cur].blocks++;
    cur = idx;
    spanHasExtrusion = false;
  };
  const closeSpan = () => openSpan(-1);
  // Name unquoted, token verbatim: the generator builds the cancel command from
  // the token.
  const nameObject = (idx, token) => {
    objects[idx].name = unquote(token);
    objects[idx].token = token;
  };
  // Klipper: DEFINE and START carry the same name; whichever comes first creates.
  const klipperObject = token => {
    const name = unquote(token);
    let idx = byKey.get(name);
    if (idx === undefined) {
      idx = objects.length;
      byKey.set(name, idx);
      objects.push(newObject(nextId++, name, token));
    }
    return idx;
  };

  for (let i = 0; i < raw.length; i++) {
    const t = raw[i].trim();
    if (t === '') continue;

    if (t.charAt(0) === ';') {
      if (t === LAYER_MARK) lcLines.push(i);
      else if (!octoprint && OCTOPRINT.test(t)) octoprint = true;
      continue;
    }

    // --- Object markers ----------------------------------------------------
    let m = M486_S.exec(t);
    if (m) {
      flavor = flavor || 'marlin';
      const id = parseInt(m[1], 10);
      if (id < 0) {
        closeSpan(); curId = -1; curMark = -1;
        marks.push({ obj: -1, line: i, open: false, ext: false });
        continue;
      }
      curId = id;
      let idx = byKey.get(id);
      if (idx === undefined) {
        idx = objects.length;
        byKey.set(id, idx);
        objects.push(newObject(id, '', ''));
      }
      openSpan(idx);
      curMark = marks.length;
      marks.push({ obj: idx, line: i, open: true, ext: false });
      const inline = M486_A.exec(t);
      if (inline) {
        nameObject(idx, inline[1]);
        declEnd = i;
      }
      continue;
    }
    m = M486_A.exec(t);
    if (m) {
      const idx = curId >= 0 ? byKey.get(curId) : undefined;
      if (idx !== undefined) nameObject(idx, m[1]);
      declEnd = i;
      continue;
    }
    m = XO_DEF.exec(t);
    if (m) {
      flavor = flavor || 'klipper';
      klipperObject(m[1]);
      declEnd = i;
      continue;
    }
    m = XO_START.exec(t);
    if (m) {
      flavor = flavor || 'klipper';
      const idx = klipperObject(m[1]);
      openSpan(idx);
      curMark = marks.length;
      marks.push({ obj: idx, line: i, open: true, ext: false });
      continue;
    }
    if (XO_END.test(t)) {
      marks.push({ obj: cur, line: i, open: false, ext: false });
      closeSpan(); curMark = -1;
      continue;
    }

    // --- State -------------------------------------------------------------
    const mode = eModeChange(t);
    if (mode !== null) { absE = mode; sawMode = true; continue; }
    const g92 = g92E(t);
    if (g92 !== null) { e = g92; continue; }
    if (flowOverride === null) {
      const f = M221_RE.exec(t);
      if (f) flowOverride = parseFloat(f[1]);
    }

    // --- Movement ----------------------------------------------------------
    if (!MOVE_RE.test(t)) continue;
    owner[i] = cur;

    const code = codeOf(t);
    const xm = X_RE.exec(code);
    const ym = Y_RE.exec(code);
    const nx = xm ? parseFloat(xm[2]) : px;
    const ny = ym ? parseFloat(ym[2]) : py;

    const mv = moveE(t);
    if (mv) {
      // Track through relative moves too: after a mid-stream M82 the absolute
      // position has to be right.
      const delta = absE ? mv.e - e : mv.e;
      e = absE ? mv.e : e + mv.e;
      if (delta > 0 && mv.hasXY && cur >= 0) {
        const o = objects[cur];
        o.eIn += delta;
        spanHasExtrusion = true;
        if (curMark >= 0) marks[curMark].ext = true;
        o.minX = Math.min(o.minX, px, nx);
        o.minY = Math.min(o.minY, py, ny);
        o.maxX = Math.max(o.maxX, px, nx);
        o.maxY = Math.max(o.maxY, py, ny);
      }
    }
    px = nx; py = ny;
  }
  closeSpan();

  // --- Blocks -------------------------------------------------------------
  // A block is one object within one layer: from the start marker to the next
  // marker -- or to the next ;LAYER_CHANGE, whichever comes first. The layer
  // boundary is necessary: the markers around the object printed last reach past
  // it and enclose the layer change with its retract and temperature commands.
  // Without it, cutting that object out would destroy the layer.
  const spans = [];
  let lcAt = 0;
  for (let k = 0; k < marks.length; k++) {
    const m = marks[k];
    if (!m.open || m.obj < 0 || !m.ext) continue;   // declaration, not a print block
    const close = k + 1 < marks.length ? marks[k + 1] : null;
    let stop = close ? close.line : raw.length;
    while (lcAt < lcLines.length && lcLines[lcAt] <= m.line) lcAt++;
    if (lcAt < lcLines.length && lcLines[lcAt] < stop) stop = lcLines[lcAt];
    spans.push({
      obj: m.obj, mark: m.line, stop,
      // Klipper closes with its own named marker -- that belongs to the object
      // and falls with it. M486 ends with "S-1", which stays.
      endMark: close && !close.open && close.obj === m.obj ? close.line : -1,
    });
  }

  // Objects without a single extrusion are declarations, not printed parts.
  // They drop out; owner and spans are remapped onto the remaining list.
  const remap = new Int32Array(objects.length).fill(-1);
  const real = [];
  for (let k = 0; k < objects.length; k++) {
    if (objects[k].blocks > 0) { remap[k] = real.length; real.push(objects[k]); }
  }
  for (let i = 0; i < owner.length; i++) {
    if (owner[i] >= 0) owner[i] = remap[owner[i]];
  }
  const realSpans = [];
  for (const sp of spans) {
    const o = remap[sp.obj];
    if (o >= 0) { sp.obj = o; realSpans.push(sp); }
  }
  if (!real.length) {
    issues.push(issue('error', 'E10', octoprint
      ? 'Set Print Settings → Output options → Label objects to Firmware-specific, '
        + 'not OctoPrint comments.'
      : 'No labelled objects — set Print Settings → Output options → Label objects '
        + 'to Firmware-specific.'));
    return { flavor, objects: [], owner, spans: [], declEnd, absoluteE, profile, issues };
  }
  if (real.length < 2) {
    issues.push(issue('error', 'E11',
      'Only one labelled object; the test needs at least two.'));
  }

  for (const o of real) {
    o.cx = (o.minX + o.maxX) / 2;
    o.cy = (o.minY + o.maxY) / 2;
    const v = valueFromName(o.name);
    if (v === null) { o.skip = true; o.reason = 'noname'; continue; }
    if (!(v >= EM_MIN && v <= EM_MAX)) { o.value = v; o.skip = true; o.reason = 'range'; continue; }
    o.value = v;
    o.factor = v / profile;
    o.skip = false;
    o.reason = '';
  }

  const skipped = real.filter(o => o.skip && o.reason === 'noname');
  if (skipped.length) {
    issues.push(issue('warning', 'W20', 'Skipping ' + skipped.length
      + (skipped.length === 1 ? ' object' : ' objects')
      + ' with no value in the name ("0.945" or "EM_Cube-0.945"): '
      + skipped.map(o => o.name || '(unnamed)').join(', ') + '.'));
  }
  const outOfRange = real.filter(o => o.skip && o.reason === 'range');
  if (outOfRange.length) {
    issues.push(issue('warning', 'W24', 'Values outside ' + EM_MIN.toFixed(1) + ' … ' + EM_MAX.toFixed(1)
      + ' are not plausible and are skipped: '
      + outOfRange.map(o => o.name).join(', ') + '.'));
  }
  const active = real.filter(o => !o.skip);
  if (!active.length) {
    issues.push(issue('error', 'E12',
      'No object name carries a value. Name them "0.950" or "EM_Cube-0.950".'));
  }

  // The plate has to be complete: the selection cuts, it does not replace
  // slicing. A missing value leaves a gap in the "From"/"To" series and two
  // prints stop being comparable.
  const found = new Set(active.map(o => Math.round(o.value * 1000) / 1000));
  const missing = VALUES.filter(v => !found.has(v));
  if (active.length && missing.length) {
    issues.push(issue('error', 'E13',
      'Incomplete plate: ' + missing.length + ' of ' + PLATES + ' values missing ('
      + missing.slice(0, 4).map(v => v.toFixed(3)).join(', ')
      + (missing.length > 4 ? ', …' : '') + '). Slice '
      + VALUES[0].toFixed(3) + ' … ' + VALUES[PLATES - 1].toFixed(3)
      + ', narrow here.'));
  }

  if (profile !== 1) {
    issues.push(issue('warning', 'W21', 'Filament profile multiplier is '
      + profile + '; object values are absolute and divided by '
      + profile + '.'));
  }
  if (!sawMode && !doc.settings.has('use_relative_e_distances')) {
    issues.push(issue('warning', 'W27',
      'No M82/M83, no use_relative_e_distances; E assumed absolute — relative goes wrong.'));
  }
  if (active.length === 1) {
    issues.push(issue('warning', 'W28',
      'Only one plate carries a value; a flow test needs at least two.'));
  }
  if (flowOverride !== null && Math.abs(flowOverride - 100) > 0.01) {
    issues.push(issue('warning', 'W25', 'Start gcode sets M221 S' + flowOverride
      + '; it scales every plate on top of the test values.'));
  }

  const seen = new Set();
  const dup = new Set();
  for (const o of active) {
    const k = o.value.toFixed(4);
    if (seen.has(k)) dup.add(o.value.toFixed(3)); else seen.add(k);
  }
  if (dup.size) {
    issues.push(issue('warning', 'W22', 'Two or more plates carry the same value: '
      + Array.from(dup).join(', ') + '.'));
  }

  const w = real.map(o => o.maxX - o.minX), h = real.map(o => o.maxY - o.minY);
  const wMin = Math.min(...w), wMax = Math.max(...w);
  const hMin = Math.min(...h), hMax = Math.max(...h);
  if (wMax - wMin > 0.5 || hMax - hMin > 0.5) {
    issues.push(issue('warning', 'W23', 'Object sizes differ: '
      + wMax.toFixed(1) + '×' + hMax.toFixed(1) + ' vs ' + wMin.toFixed(1) + '×' + hMin.toFixed(1)
      + ' mm — all plates must be the same cube.'));
  }

  return { flavor: flavor || 'marlin', objects: real, owner, spans: realSpans,
           declEnd, absoluteE, profile, issues };
}

/* --- Plan ------------------------------------------------------------------
   Raw lines and range become the plan that generator, preview and command line
   all use. As with the tower it lives here and not in test.js, so the command
   line cannot compute with different values than the browser. */

/** `input` is {from, to}, the selected range. */
export function buildEmPlan(raw, doc, input) {
  const found = findObjects(raw, doc);
  // Of the settings.js messages only the tool index (W5) is carried over.
  const issues = doc.issues.filter(i => i.code === 'W5').concat(found.issues);
  const bed = doc.printer.bed;
  if (!bed || !(bed.x > 0) || !(bed.y > 0)) {
    issues.push(issue('warning', 'W26',
      'Bed size unknown; the map uses 250 × 250 mm. The generated file is not affected.'));
  }

  const ordered = found.objects.filter(o => !o.skip).sort((a, b) => a.value - b.value);
  const from = Number.isFinite(input && input.from) ? input.from : VALUES[0];
  const to = Number.isFinite(input && input.to) ? input.to : VALUES[VALUES.length - 1];
  // What lies outside the range is not skipped but cut out of the file --
  // exactly like a plate with an unreadable name.
  for (const o of found.objects) {
    o.printed = !o.skip && o.value >= from - 1e-9 && o.value <= to + 1e-9;
  }
  const printed = ordered.filter(o => o.printed);
  if (from > to) {
    issues.push(issue('error', 'E14',
      'Lower value (' + from.toFixed(3) + ') is above the upper one (' + to.toFixed(3) + ').',
      ['em-from', 'em-to']));
  } else if (ordered.length && !printed.length) {
    issues.push(issue('error', 'E14',
      'No plate lies between ' + from.toFixed(3) + ' and ' + to.toFixed(3) + '.',
      ['em-from', 'em-to']));
  }

  const hasError = issues.some(i => i.level === 'error');
  return Object.assign({}, found, {
    raw, doc, issues, hasError, from, to,
    renderable: found.objects.length > 0 && !hasError,
    printed, bed, selected: -1,
  });
}
