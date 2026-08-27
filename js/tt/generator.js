/**
 * tt/generator.js — trims the tower file to the selected temperature range and
 * sets the temperature commands.
 *
 * The tower is always sliced at full height. Trimming above is a plain cut;
 * trimming below needs a Z offset and a replay of the machine state as well.
 *
 * The model's own base plate — one layer of `first_layer_height`, wider than any
 * band — always stays, and the printed range sits on top of it. Nothing on the
 * moves is recomputed: apart from Z, the temperature commands and the object
 * bracket, the body is the source line by line.
 */

import {
  MOVE_RE, codeOf, moveE, g92E, eModeChange, axisValue,
  formatCoord, formatDuration, rewriteStats,
} from '../gcode.js';

const MAP_BEGIN = '; >>> print_calibration_tool tt map begin';
const MAP_END   = '; <<< print_calibration_tool tt map end';

const OBJ_START = /^(?:EXCLUDE_OBJECT_START\b|M486\s+S\s*\d)/i;
const OBJ_END   = /^(?:EXCLUDE_OBJECT_END\b|M486\s+S\s*-\s*1\b)/i;
const XO_DEF    = /^EXCLUDE_OBJECT_DEFINE\s+NAME\s*=\s*('[^']*'|"[^"]*"|\S+)/i;
const TEMP_RE   = /^M10[49](?![0-9])/i;
const M73_ANY   = /^M73(?![0-9])/i;
const M73_PR    = /^M73\s+P(\d+)\s+R(\d+)\s*$/i;
const M73_QS    = /^M73\s+Q(\d+)\s+S(\d+)\s*$/i;
const F_RE      = /(^|\s)F(\d+(?:\.\d*)?|\.\d+)/;
const BARE_NUM  = /^;\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s*$/;

const Z_MARK = ';Z:';

// Base layers above the first one. The step in the model is 0.5 mm high: at
// 0.25 mm layer height the slicer cuts two of them out of it, at 0.3 mm only
// one. Missing ones are made up by repeating the topmost.
const MIN_MIDDLE = 2;

/** Replace the number after an axis letter without rebuilding the line. */
const AXIS_SET = {};
function setAxis(code, letter, text) {
  let re = AXIS_SET[letter];
  if (!re) {
    re = AXIS_SET[letter] =
      new RegExp('((?:^|\\s)' + letter + ')(-?(?:\\d+(?:\\.\\d*)?|\\.\\d+))');
  }
  return code.replace(re, (m, head) => head + text);
}

/**
 * Number for a comment line: PrusaSlicer writes `0.2` there, not `.2` as in the
 * move lines. Cosmetic, but the file should look like a sliced one.
 */
function formatMm(v) {
  return Number.isFinite(v) ? String(+v.toFixed(5)) : '0';
}

function splitComment(line) {
  const semi = line.indexOf(';');
  return semi < 0 ? [line, ''] : [line.slice(0, semi), line.slice(semi)];
}

/* --- Map block ------------------------------------------------------------- */

function mapLines(plan, zOffset, base, cap) {
  const L = [
    MAP_BEGIN,
    '; tt model = temperature tower, ' + plan.bands.length + ' bands, '
      + plan.bandHeight.toFixed(3) + ' mm each',
    '; tt printed = ' + plan.printed[0].temp + ' ... '
      + plan.printed[plan.printed.length - 1].temp + ' C, bands '
      + plan.printed[0].index + '-' + plan.printed[plan.printed.length - 1].index,
    '; tt base = ' + base.layers + ' layers up to Z ' + base.topZ.toFixed(3)
      + ', source layers ' + plan.foot.first + '-' + plan.foot.last
      + ', last one repeated ' + base.dup + 'x',
    '; tt z offset = ' + formatMm(-zOffset) + ' mm',
  ];
  if (cap) {
    L.push('; tt top cap = ' + (cap.last - cap.first + 1) + ' layers, source layers '
      + cap.first + '-' + cap.last);
  }
  for (const b of plan.printed) {
    const first = plan.layers[b.first], last = plan.layers[b.last];
    L.push('; tt band ' + b.index + ' | ' + b.temp + ' C'
      + ' | source Z ' + first.z.toFixed(3) + '-' + last.z.toFixed(3)
      + ' | print Z ' + (first.z - zOffset).toFixed(3) + '-' + (last.z - zOffset).toFixed(3)
      + ' | layers ' + b.first + '-' + b.last);
  }
  L.push(MAP_END);
  return L;
}

/* --- State before the cut -------------------------------------------------- */

/**
 * What the slicer set between start block and cut still applies afterwards, but
 * trimming from below drops it — so collect the last state and set it again
 * before the base.
 */
function replayLines(raw, from, to) {
  let m204 = null, m201 = null, m221 = null, feed = null;
  for (let i = from; i < to; i++) {
    const t = raw[i].trim();
    if (t === '' || t.charAt(0) === ';') continue;
    if (/^M204(?![0-9])/i.test(t)) { m204 = t; continue; }
    if (/^M201(?![0-9])/i.test(t)) { m201 = t; continue; }
    if (/^M221(?![0-9])/i.test(t)) { m221 = t; continue; }
    if (MOVE_RE.test(t)) {
      const f = F_RE.exec(codeOf(t));
      if (f) feed = f[2];
    }
  }
  const out = [];
  if (m201) out.push(m201);
  if (m204) out.push(m204);
  if (m221) out.push(m221);
  if (feed !== null) out.push('G1 F' + feed);
  return out;
}

/* --- Emit one layer --------------------------------------------------------- */

/**
 * Emit one layer, with Z shifted and nothing else.
 *
 * @param {object} ctx     {raw, out, absE, e, extruded, strippedTemp}
 * @param {number} zOff    amount by which Z drops (0 = unchanged, negative =
 *   rises, as in the repeats of the topmost base layer)
 * @param {boolean} [repeat]  a repeat: the slicer's progress lines apply to the
 *   first pass; emitting them again would make the remaining time rise.
 */
function emitLayer(ctx, l, zOff, repeat) {
  const raw = ctx.raw, out = ctx.out;

  for (let i = l.start; i <= l.end; i++) {
    const line = raw[i];
    const t = line.trim();
    if (t === '') { out.push(line); continue; }
    if (repeat && M73_ANY.test(t)) continue;

    if (t.charAt(0) === ';') {
      if (t.startsWith(Z_MARK)) {
        out.push(Z_MARK + formatMm(l.z - zOff));
      } else {
        // The slicer's `;[layer_z]`: a comment line carrying only the height.
        // Shift only the one that really names this layer's Z.
        const bare = BARE_NUM.exec(t);
        out.push(bare && Math.abs(parseFloat(bare[1]) - l.z) < 1e-6
          ? ';' + formatMm(l.z - zOff) : line);
      }
      continue;
    }

    if (OBJ_START.test(t) || OBJ_END.test(t)) continue;   // we emit our own
    if (TEMP_RE.test(t)) { ctx.strippedTemp++; continue; }

    const mode = eModeChange(t);
    if (mode !== null) { ctx.absE = mode; out.push(line); continue; }
    const g = g92E(t);
    if (g !== null) { ctx.e = g; out.push(line); continue; }

    if (!MOVE_RE.test(t)) { out.push(line); continue; }

    // Only count the extrusion, do not touch it.
    const mv = moveE(t);
    if (mv) {
      const delta = ctx.absE ? mv.e - ctx.e : mv.e;
      ctx.e = ctx.absE ? mv.e : ctx.e + mv.e;
      if (delta > 0 && mv.hasXY) ctx.extruded += delta;
    }

    const [code, comment] = splitComment(line);
    const z = zOff === 0 ? null : axisValue(code, 'Z');
    out.push(z === null ? line : setAxis(code, 'Z', formatCoord(z - zOff)) + comment);
  }
}

/* --- Entry point ------------------------------------------------------------ */

/**
 * @param {object} plan  from buildTtPlan() in tt/layers.js
 */
export function generateTt(plan) {
  const raw = plan.raw, doc = plan.doc, layers = plan.layers;
  const printed = plan.printed;
  const foot = plan.foot;
  const firstIdx = printed[0].first;
  const lastIdx = printed[printed.length - 1].last;
  const first = layers[firstIdx];
  const last = layers[lastIdx];

  // Layer height from the profile, not from `;HEIGHT:` -- that one carries
  // rounding leftovers (0.100006) and would produce odd Z values.
  const lh = doc.geometry.layerHeight > 0 ? doc.geometry.layerHeight : first.height;
  // The base always carries three layers: the first in first_layer_height, two
  // smaller ones above it; if the slicer delivers fewer, the topmost is
  // repeated. The printed range sits directly on that base — with nothing cut
  // off below, the offset is zero.
  const dup = Math.max(0, MIN_MIDDLE - (foot.last - foot.first));
  const baseTopZ = foot.z + dup * lh;
  const zOffset = first.z - (baseTopZ + lh);
  const cutBelow = firstIdx > foot.last + 1;
  const cutAbove = lastIdx < layers.length - 1;
  const trimmed = cutBelow || cutAbove;

  // Cut short above and the last band ends on an open layer, so the tower's own
  // top cap is copied onto the cut; all bands have the same shape, so it fits.
  // Only if it sits entirely above the cut and leaves at least one original
  // layer of the topmost band standing -- that layer carries the band's
  // temperature command.
  const topBandFirst = printed[printed.length - 1].first;
  const cap = cutAbove && plan.cap && plan.cap.first > lastIdx
    && plan.cap.last - plan.cap.first + 1 <= lastIdx - topBandFirst
    ? plan.cap : null;
  const capCount = cap ? cap.last - cap.first + 1 : 0;
  // The cap replaces the layers it is as long as, so it lands on their Z.
  const zOffTop = cap ? layers[cap.last].z - (last.z - zOffset) : 0;

  // --- Time from the progress lines ---------------------------------------
  const lastBefore = (re, upto) => {
    for (let i = upto; i >= 0; i--) {
      const m = re.exec(raw[i].trim());
      if (m) return parseInt(m[2], 10);
    }
    return NaN;
  };
  // Two pieces are printed: the base and the selected range. Time is dropped in
  // between, so the remaining time is the sum of the two pieces, not the
  // difference of their ends -- plus the repeats, which do not appear in the
  // slicer's numbers at all. Measured at the progress lines, so to the minute;
  // the file gives nothing finer.
  const span = re => {
    const a = lastBefore(re, layers[foot.first].start);
    const b = lastBefore(re, layers[foot.last].end);
    const c = lastBefore(re, first.start);
    const d = lastBefore(re, last.end);
    if (![a, b, c, d].every(Number.isFinite) || a < b || c < d) return null;
    const top = lastBefore(re, layers[foot.last].start);
    const repeatMin = dup && Number.isFinite(top) && top > b ? dup * (top - b) : 0;
    return { a, b, d, repeatMin, total: (a - b) + repeatMin + (c - d) };
  };
  const pr = span(M73_PR), qs = span(M73_QS);
  const totalMin = pr ? pr.total : NaN;
  const silentMin = qs ? qs.total : NaN;

  const ctx = { raw, out: [], absE: !doc.printer.relativeE, e: 0, extruded: 0, strippedTemp: 0 };
  const out = ctx.out;

  // --- Head ----------------------------------------------------------------
  for (let i = 0; i < plan.headEnd; i++) out.push(raw[i]);
  out.push(...mapLines(plan, zOffset,
    { layers: foot.last - foot.first + 1 + dup, dup, topZ: baseTopZ }, cap));

  const objName = objectToken(raw, plan.headEnd);
  out.push(doc.printer.flavor === 'klipper'
    ? 'EXCLUDE_OBJECT_START NAME=' + objName : 'M486 S0');

  // --- Base, first layer ----------------------------------------------------
  // It keeps its height and its temperature: the start block heated to
  // first_layer_temperature, and that stands until this layer is down.
  emitLayer(ctx, layers[foot.first], 0);

  // Now the switch may happen: the nozzle changes temperature while the rest of
  // the base prints and is ready at the first band -- no wait mid-print.
  out.push('; print_calibration_tool: band ' + printed[0].index + ', ' + printed[0].temp + ' C');
  out.push('M104 S' + printed[0].temp);

  // --- Base, smaller cross-section ------------------------------------------
  for (let i = foot.first + 1; i <= foot.last; i++) emitLayer(ctx, layers[i], 0);

  // Missing layers: the topmost one again, one layer height further up each
  // time. With absolute counting the E counter must be set back to the start of
  // that layer first, otherwise its retract reads the difference as extrusion.
  const top = layers[foot.last];
  for (let k = 1; k <= dup; k++) {
    if (ctx.absE) { out.push('G92 E' + formatCoord(top.eIn)); ctx.e = top.eIn; }
    emitLayer(ctx, top, -k * lh, true);
  }

  // --- Replay the state -----------------------------------------------------
  // Only when something was cut off below: then everything the slicer set
  // between base plate and cut is missing.
  if (cutBelow) {
    out.push(...replayLines(raw, layers[foot.last].end + 1, first.start));
    if (ctx.absE) {
      out.push('G92 E' + formatCoord(first.eIn));   // absolute counter at the cut
      ctx.e = first.eIn;
    }
  }

  // --- Body -----------------------------------------------------------------
  const bandStart = new Map(printed.map(b => [b.first, b]));
  for (let i = firstIdx; i <= lastIdx - capCount; i++) {
    const b = bandStart.get(i);
    if (b && b !== printed[0]) {
      out.push('; print_calibration_tool: band ' + b.index + ', ' + b.temp + ' C');
      out.push('M104 S' + b.temp);
    }
    emitLayer(ctx, layers[i], zOffset);
  }

  // --- Top cap --------------------------------------------------------------
  // With absolute counting the retract in the layer head is an absolute value
  // that belongs to the counter of the layer below it in the source. Jumping to
  // the top of the file means setting the counter there first.
  if (cap) {
    if (ctx.absE) {
      out.push('G92 E' + formatCoord(layers[cap.first].eIn)
        + ' ; print_calibration_tool: top cap');
      ctx.e = layers[cap.first].eIn;
    }
    for (let i = cap.first; i <= cap.last; i++) emitLayer(ctx, layers[i], zOffTop);
  }

  out.push(doc.printer.flavor === 'klipper'
    ? 'EXCLUDE_OBJECT_END NAME=' + objName : 'M486 S-1');

  // --- End block ------------------------------------------------------------
  for (let i = plan.endStart; i < raw.length; i++) out.push(raw[i]);

  // --- Stats ----------------------------------------------------------------
  const m = doc.material;
  const area = Math.PI * Math.pow(m.filamentDiameter / 2, 2);
  const filamentCm3 = Number.isFinite(area) ? ctx.extruded * area / 1000 : NaN;
  const filamentG = Number.isFinite(m.density) && m.density > 0 ? filamentCm3 * m.density : NaN;
  const filamentCost = Number.isFinite(filamentG) && Number.isFinite(m.cost) && m.cost > 0
    ? filamentG / 1000 * m.cost : NaN;
  const stats = { filamentMm: ctx.extruded, filamentCm3, filamentG, filamentCost,
                  timeSec: Number.isFinite(totalMin) ? totalMin * 60 : NaN,
                  silentSec: Number.isFinite(silentMin) ? silentMin * 60 : NaN };

  // rewriteStats deliberately gets no time: it would recompute the M73 lines
  // from the percentage, and here that comes from the source. The header lines
  // carrying the print time are therefore set below.
  let lines = rewriteStats(out, { filamentMm: stats.filamentMm, filamentCm3,
                                  filamentG, filamentCost });
  // Touch time and progress only when something really changed: a trim, or a
  // repeated base layer. On an unchanged tower the slicer's numbers would
  // merely be re-rounded from the percentage — a change without a gain.
  if (trimmed || (pr && pr.repeatMin) || (qs && qs.repeatMin)) {
    lines = rewriteTimes(lines, stats.timeSec, stats.silentSec);
    // Over the whole file: otherwise the lines in the start block keep naming
    // the remaining time of the untrimmed tower.
    lines = rewriteProgress(lines, pr, qs);
  }

  return {
    lines,
    stats: Object.assign({
      bands: printed.length,
      layers: (foot.last - foot.first + 1 + dup) + (lastIdx - firstIdx + 1),
      heightMm: last.z - zOffset,
      footHeight: baseTopZ,
      zOffset,
      topCap: capCount,
      strippedTemp: ctx.strippedTemp,
      gcodeLines: lines.length,
    }, stats),
  };
}

/** The NAME= value of the object declaration, verbatim including quotes. */
function objectToken(raw, headEnd) {
  for (let i = 0; i < headEnd; i++) {
    const m = XO_DEF.exec(raw[i].trim());
    if (m) return m[1];
  }
  return "'object'";
}

/**
 * Convert `M73 P<percent> R<remaining>` to the trimmed print.
 *
 * The source counts down over the whole tower, the output prints two pieces of
 * it: base plate and selected range. A line from the first piece (remaining
 * time still above the end of the plate) is computed downwards from the top,
 * one from the second piece upwards from the bottom. The percentage follows
 * from the new remaining time — the old one counts the whole tower and cannot
 * be scaled.
 */
function rewriteProgress(lines, pr, qs) {
  const fix = (m, pKey, rKey, sp) => {
    if (!sp || sp.total <= 0) return null;
    const r = parseInt(m[2], 10);
    const rest = r >= sp.b ? sp.total - (sp.a - r) : r - sp.d;
    const nr = Math.min(sp.total, Math.max(0, rest));
    const np = Math.min(100, Math.max(0, Math.round((sp.total - nr) / sp.total * 100)));
    return 'M73 ' + pKey + np + ' ' + rKey + nr;
  };
  return lines.map(line => {
    let m = M73_PR.exec(line);
    if (m) return fix(m, 'P', 'R', pr) || line;
    m = M73_QS.exec(line);
    if (m) return fix(m, 'Q', 'S', qs) || line;
    return line;
  });
}

/** The two time figures in the head and in the end block. */
function rewriteTimes(lines, totalSec, silentSec) {
  const rules = [
    [/^(;\s*estimated printing time \(normal mode\)\s*=\s*).*$/i, totalSec],
    [/^(;\s*estimated printing time \(silent mode\)\s*=\s*).*$/i, silentSec],
  ];
  return lines.map(line => {
    for (const [re, sec] of rules) {
      const m = re.exec(line);
      if (m) return Number.isFinite(sec) ? m[1] + formatDuration(sec) : line;
    }
    return line;
  });
}
