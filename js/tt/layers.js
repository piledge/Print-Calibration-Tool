/**
 * tt/layers.js — splits a sliced tower file into layers and bands.
 *
 * The tower is a fixed model: 21 bands, 180 °C at the bottom, 5 °C more per
 * band, 280 °C at the top. The band -> temperature mapping is therefore a
 * constant here and not part of the UI; only the band starts are detected.
 *
 * The marker is the diagonal of the layer bounding box: within a band it grows
 * with the overhang wedge and drops back at every band boundary. The diagonal
 * rather than the X extent, so detection still holds with the tower rotated on
 * the bed.
 */

import { issue } from '../settings.js';
import { MOVE_RE, codeOf, axisValue, moveE, g92E, eModeChange } from '../gcode.js';

export const BANDS = 21;
// Gap between first_layer_temperature and the lowest printed band from which
// the hint is worth showing; below it the change completes within the base.
const TEMP_GAP_WARN = 30;
const BASE_TEMP = 180;             // lowest band
const TEMP_STEP = 5;               // per band upwards

/** Temperature of the k-th band, k counted from 1. */
export function bandTemp(index) {
  return BASE_TEMP + (index - 1) * TEMP_STEP;
}

export const TEMPS = Array.from({ length: BANDS }, (_, i) => bandTemp(i + 1));

const LAYER_MARK = ';LAYER_CHANGE';
const Z_MARK = ';Z:';
const H_MARK = ';HEIGHT:';
const END_ANCHOR = '; Filament-specific end gcode';
// Sparse infill. A layer without it is closed and can serve as a top cap.
const SPARSE_MARK = ';TYPE:Internal infill';

// A drop counts as a band boundary above half the whole span. On the sample
// tower that is 17.4 of 17.9 mm — a large margin against variation inside a
// band.
const DROP_FRACTION = 0.5;

/**
 * @param {number} start  line number of the `;LAYER_CHANGE`
 * @param {number} eIn    extruder counter at the start of the layer. Needed when
 *   cutting from below: with absolute counting the retract in the layer head is
 *   an absolute value and would otherwise point nowhere.
 */
function newLayer(start, eIn) {
  return {
    z: NaN, height: NaN, start, end: start,
    minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity,
    moves: 0, diag: 0, band: 0, eIn, sparse: false,
  };
}

/**
 * One pass over the raw lines.
 *
 * @param {object} doc   SourceDocument from settings.js
 * @returns {{layers:object[], bands:object[], foot:object|null, headEnd:number,
 *            endStart:number, bandHeight:number, height:number, issues:object[]}}
 */
export function findLayers(raw, doc) {
  const issues = [];
  const layers = [];
  let cur = null;
  let headEnd = -1;
  let endStart = raw.length;
  let px = 0, py = 0;
  let absE = !doc.printer.relativeE;
  let e = 0;

  for (let i = 0; i < raw.length; i++) {
    const t = raw[i].trim();
    if (t === '') continue;

    if (t.charAt(0) === ';') {
      if (t === LAYER_MARK) {
        if (headEnd < 0) headEnd = i;
        if (cur) cur.end = i - 1;
        cur = newLayer(i, e);
        layers.push(cur);
        continue;
      }
      if (cur) {
        if (t.startsWith(Z_MARK) && !Number.isFinite(cur.z)) {
          cur.z = parseFloat(t.slice(Z_MARK.length));
        } else if (t.startsWith(H_MARK) && !Number.isFinite(cur.height)) {
          cur.height = parseFloat(t.slice(H_MARK.length));
        } else if (t === SPARSE_MARK) {
          cur.sparse = true;
        }
      }
      if (t === END_ANCHOR) endStart = i;
      continue;
    }

    const mode = eModeChange(t);
    if (mode !== null) { absE = mode; continue; }
    const g92 = g92E(t);
    if (g92 !== null) { e = g92; continue; }

    if (!MOVE_RE.test(t)) continue;
    const code = codeOf(t);
    const x = axisValue(code, 'X');
    const y = axisValue(code, 'Y');
    const nx = x === null ? px : x;
    const ny = y === null ? py : y;
    const mv = moveE(t);
    if (mv) e = absE ? mv.e : e + mv.e;
    if (cur && mv && mv.e > 0 && mv.hasXY) {
      cur.moves++;
      cur.minX = Math.min(cur.minX, px, nx);
      cur.minY = Math.min(cur.minY, py, ny);
      cur.maxX = Math.max(cur.maxX, px, nx);
      cur.maxY = Math.max(cur.maxY, py, ny);
    }
    px = nx; py = ny;
  }
  if (cur) cur.end = endStart - 1;

  // Empty layers (they occur in truncated files) are dropped, otherwise the band
  // search trips over a diagonal of 0.
  const used = layers.filter(l => l.moves > 0 && Number.isFinite(l.z));
  // All three bail-outs return the same shape: layers and markers, no bands;
  // the reason is in `issues`.
  const noTower = h => ({ layers: used, bands: [], foot: null, headEnd, endStart,
                          bandHeight: NaN, height: h, cap: null, issues });

  if (used.length < BANDS * 2) {
    issues.push(issue('error', 'E20',
      'No or too few layer markers (";LAYER_CHANGE" / ";Z:"); '
      + 'not the temperature tower.'));
    return noTower(NaN);
  }

  for (const l of used) {
    const dx = l.maxX - l.minX, dy = l.maxY - l.minY;
    l.diag = Math.sqrt(dx * dx + dy * dy);
    if (!Number.isFinite(l.height)) l.height = doc.geometry.layerHeight;
  }

  // --- Band boundaries -----------------------------------------------------
  // Span over percentiles, not min/max: the base plate is a single much wider
  // layer and would otherwise raise the threshold above every band boundary.
  const sorted = used.map(l => l.diag).sort((a, b) => a - b);
  const at = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const threshold = (at(0.95) - at(0.05)) * DROP_FRACTION;
  const starts = [0];
  for (let i = 1; i < used.length; i++) {
    if (used[i - 1].diag - used[i].diag > threshold) starts.push(i);
  }

  // The base plate is as wide as the widest band and so produces a drop like a
  // band boundary, but it is only one layer high: sections below half the usual
  // height are the foot, not a band.
  const spans = starts.map((first, k) => {
    const last = (k + 1 < starts.length ? starts[k + 1] : used.length) - 1;
    return { first, last, mm: used[last].z - (first ? used[first - 1].z : 0) };
  });
  const median = spans.map(s => s.mm).sort((a, b) => a - b)[spans.length >> 1];
  const real = spans.filter(s => s.mm >= median / 2);
  const footEnd = real.length ? real[0].first - 1 : -1;

  const height = used[used.length - 1].z;
  if (real.length !== BANDS) {
    issues.push(issue('error', 'E21',
      'Found ' + real.length + (real.length === 1 ? ' band' : ' bands')
      + ' instead of ' + BANDS + ' (height ' +
      (Number.isFinite(height) ? height.toFixed(1) : '?') + ' mm) — slice this model '
      + 'at full height.'));
    return noTower(height);
  }
  if (footEnd < 1) {
    issues.push(issue('error', 'E23',
      'Incomplete base — the 0.5 mm step on the plate needs layer height '
      + '0.5 mm or less.'));
    return noTower(height);
  }

  const bands = real.map((s, k) => {
    const { first, last } = s;
    const band = {
      index: k + 1, temp: bandTemp(k + 1),
      first, last,
      z0: used[first - 1].z,
      z1: used[last].z,
    };
    for (let i = first; i <= last; i++) used[i].band = band.index;
    return band;
  });

  // For display only, not for the mapping — the boundaries are fixed by geometry.
  const bandHeight = (height - used[footEnd].z) / BANDS;
  const foot = { first: 0, last: footEnd, z: used[footEnd].z };

  return { layers: used, bands, foot, headEnd, endStart, bandHeight, height,
           cap: findTopCap(used, bands), issues };
}

/**
 * The tower's own top cap: the run of layers at the very top that carries no
 * sparse infill any more.
 *
 * Cut the tower short and the last band ends on a layer whose middle is still
 * open. Copying these layers onto the cut closes it — all 21 bands have the
 * same shape, so the cap fits any band boundary; only Z has to be restamped.
 *
 * Null without sparse infill in the source (nothing to cover) or when the run
 * is longer than a band (then it is not a cap).
 */
function findTopCap(used, bands) {
  if (!used.some(l => l.sparse)) return null;
  let first = used.length;
  while (first > 0 && !used[first - 1].sparse) first--;
  const top = bands[bands.length - 1];
  if (first >= used.length || used.length - first > top.last - top.first) return null;
  return { first, last: used.length - 1 };
}

/**
 * Build the plan from file and input. Browser and command line take the same
 * path, otherwise they drift apart in messages and values.
 *
 * @param {object} doc                      SourceDocument from settings.js
 * @param {{from:number, to:number}} input   selected temperatures
 */
export function buildTtPlan(raw, doc, input) {
  const found = findLayers(raw, doc);
  // Of the messages from settings.js only the tool index (W5) is carried over;
  // the rest stay out of this.
  const issues = doc.issues.filter(i => i.code === 'W5').concat(found.issues);

  const from = Number.isFinite(input && input.from) ? input.from : bandTemp(1);
  const to = Number.isFinite(input && input.to) ? input.to : bandTemp(BANDS);
  if (from > to) {
    issues.push(issue('error', 'E22',
      'Lower temperature (' + from + ' °C) is above the upper one (' + to + ' °C).',
      ['tt-from', 'tt-to']));
  }

  const printed = found.bands.filter(b => b.temp >= from && b.temp <= to);
  if (found.bands.length === BANDS && printed.length === 0) {
    issues.push(issue('error', 'E22',
      'No band lies between ' + from + ' and ' + to + ' °C.',
      ['tt-from', 'tt-to']));
  }

  // The first base layer runs at first_layer_temperature; the switch happens
  // right after it, so the nozzle changes during the rest of the base. The
  // sliced `temperature` for the further layers does not matter: it is
  // overwritten anyway, and the slicer's command for it is stripped.
  const firstLayerTemp = doc.material.firstLayerTemperature;
  if (printed.length && Number.isFinite(firstLayerTemp)
      && Math.abs(firstLayerTemp - printed[0].temp) > TEMP_GAP_WARN) {
    issues.push(issue('warning', 'W30',
      'The base is printed at first_layer_temperature (' + firstLayerTemp
      + ' °C), the band above it asks for ' + printed[0].temp + ' °C. The '
      + 'temperature transition is performed straight after the first layer, '
      + 'within the base.'));
  }

  const hasError = issues.some(i => i.level === 'error');
  return Object.assign({}, found, {
    raw, doc, issues, hasError, from, to, printed,
    renderable: found.bands.length === BANDS && !hasError,
    selected: -1,
  });
}
