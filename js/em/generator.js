/**
 * em/generator.js — rewrites the source file's E values per object and cuts out
 * the plates that were not selected.
 *
 * No new geometry: the output is the input with every extrusion inside an
 * object's markers multiplied by that object's factor. Retracts, deretracts and
 * everything outside the markers stay untouched.
 */

import { moveE, g92E, eModeChange, rewriteStats, formatCoord as formatE,
         codeOf, axisValue, formatDuration, parseDuration, MOVE_RE } from '../gcode.js';

const MAP_BEGIN = '; >>> print_calibration_tool em map begin';
const MAP_END   = '; <<< print_calibration_tool em map end';
const M486_CANCEL = /^M486\s+S\s*-1\s*$/i;
const M73_PR = /^M73\s+P\d+\s+R\d+\s*$/i;
const M73_QS = /^M73\s+Q\d+\s+S\d+\s*$/i;
const TIME_NORMAL = /^(;\s*estimated printing time \(normal mode\)\s*=\s*).*$/i;
const TIME_SILENT = /^(;\s*estimated printing time \(silent mode\)\s*=\s*).*$/i;

/** Why a plate is not printed — for the map block. */
function reasonOf(o) {
  if (o.reason === 'range') return 'value outside the plausible range';
  if (o.skip) return 'name does not match EM_Cube-<value>';
  return 'outside the selected range';
}

function mapLines(plan) {
  const num = (v, d) => Number.isFinite(v) ? v.toFixed(d) : '-';
  const L = [MAP_BEGIN, '; em profile multiplier = ' + plan.profile.toFixed(3),
    '; em selected = ' + num(plan.from, 3) + ' … ' + num(plan.to, 3) + ', '
      + plan.objects.filter(o => o.printed).length + ' of ' + plan.objects.length + ' plates'];
  for (const o of plan.objects) {
    L.push('; em object ' + o.id + ' | ' + o.name +
      ' | em=' + num(o.value, 3) +
      ' | factor=' + num(o.factor, 5) +
      ' | x=' + num(o.cx, 3) +
      ' | y=' + num(o.cy, 3) +
      ' | ' + (o.printed ? 'printed' : 'removed, ' + reasonOf(o)));
  }
  L.push(MAP_END);
  // The removed objects' toolpaths are gone, but their declarations stay (M486
  // numbering hangs off them), so each one is cancelled individually —
  // otherwise they wait in the printer's object list until the print ends.
  for (const o of plan.objects) {
    if (o.printed) continue;
    L.push(plan.flavor === 'klipper'
      ? 'EXCLUDE_OBJECT NAME=' + o.token
      : 'M486 P' + o.id);
  }
  return L;
}

/* --- Time ------------------------------------------------------------------
   The cut is spread over the whole file, so the time cannot be assembled from
   two pieces of the progress lines as in the tower. Instead a coarse measure of
   our own -- distance over feedrate, no acceleration -- over source and output.
   Only their ratio enters the slicer's time, so the coarseness cancels out. The
   longer travel between the remaining plates is included, because the
   measurement runs on the file actually produced. */

/** Cumulative seconds per line by that measure; [n] is the total. */
function moveSeconds(lines) {
  const acc = new Float64Array(lines.length + 1);
  let f = 0, x = 0, y = 0, z = 0, sec = 0, seen = false;
  for (let i = 0; i < lines.length; i++) {
    acc[i] = sec;
    const t = lines[i].trim();
    if (!MOVE_RE.test(t)) continue;
    const code = codeOf(t);
    const nf = axisValue(code, 'F');
    if (nf !== null && nf > 0) f = nf;
    const nx = axisValue(code, 'X'), ny = axisValue(code, 'Y'), nz = axisValue(code, 'Z');
    const ax = nx === null ? x : nx, ay = ny === null ? y : ny, az = nz === null ? z : nz;
    if (seen && f > 0) {
      const dx = ax - x, dy = ay - y, dz = az - z;
      sec += Math.sqrt(dx * dx + dy * dy + dz * dz) / f * 60;
    }
    x = ax; y = ay; z = az; seen = true;
  }
  acc[lines.length] = sec;
  return acc;
}

/** The slicer's time estimate from the header, in seconds. */
function headerSeconds(lines, re) {
  for (const line of lines) {
    const m = re.exec(line);
    if (m) return parseDuration(line.slice(line.indexOf('=') + 1));
  }
  return NaN;
}

/**
 * Resets header times and progress lines. Percentage and remaining time come
 * from our own measure, so they stay consistent and monotonic.
 */
function rewriteTime(lines, acc, totalSec, silentSec) {
  const total = acc[lines.length];
  const at = i => total > 0 ? acc[i] / total : 0;
  return lines.map((line, i) => {
    for (const [re, sec] of [[TIME_NORMAL, totalSec], [TIME_SILENT, silentSec]]) {
      const m = re.exec(line);
      if (m) return Number.isFinite(sec) ? m[1] + formatDuration(sec) : line;
    }
    const p = M73_PR.exec(line.trim());
    if (p && Number.isFinite(totalSec)) {
      const done = at(i);
      return 'M73 P' + Math.round(done * 100) + ' R' + Math.round(totalSec * (1 - done) / 60);
    }
    const q = M73_QS.exec(line.trim());
    if (q && Number.isFinite(silentSec)) {
      const done = at(i);
      return 'M73 Q' + Math.round(done * 100) + ' S' + Math.round(silentSec * (1 - done) / 60);
    }
    return line;
  });
}

/** `plan` comes from buildEmPlan() in em/objects.js. */
export function generateEm(plan) {
  const raw = plan.raw;
  const objects = plan.objects;
  const owner = plan.owner;

  // --- What gets dropped ----------------------------------------------------
  // A block ends at the next marker or at the layer change, whichever comes
  // first (see objects.js). Klipper's end marker belongs to the object and goes
  // with it; "M486 S-1" belongs to none and stays.
  const drop = new Uint8Array(raw.length);
  for (const sp of plan.spans) {
    if (objects[sp.obj].printed) continue;
    for (let i = sp.mark; i < sp.stop; i++) drop[i] = 1;
    if (sp.endMark >= 0) drop[sp.endMark] = 1;
  }
  const cutting = objects.some(o => !o.printed);

  // Insertion point of the map, still in source line numbers.
  let atRaw;
  if (plan.declEnd >= 0) {
    atRaw = plan.declEnd + 1;
    while (atRaw < raw.length && M486_CANCEL.test(raw[atRaw].trim())) atRaw++;
  } else {
    atRaw = 0;
    while (atRaw < owner.length && owner[atRaw] < 0) atRaw++;
  }

  const out = [];
  let mapAt = 0;
  let absE = plan.absoluteE;
  let inE = 0, outE = 0;
  let extruded = 0, changed = 0, dropped = 0, seams = 0;
  // Retracted? Once for the source, once for the output -- as with the two E
  // counters. A move is dropped only if it would bring the output where it
  // already stands AND it would have changed something in the source. The second
  // condition is needed both ways: it keeps a move the source itself issues
  // twice (so an uncut output stays the source line for line), and it keeps a
  // deretract the output needs because the block before it was cut away.
  let srcRetracted = false, outRetracted = false;

  for (let i = 0; i < raw.length; i++) {
    if (i === atRaw) mapAt = out.length;
    const keep = drop[i] === 0;
    const t = raw[i].trim();

    if (t === '' || t.charAt(0) === ';') {
      if (keep) out.push(raw[i]); else dropped++;
      continue;
    }

    const mode = eModeChange(t);
    if (mode !== null) {
      absE = mode;
      if (keep) out.push(raw[i]); else dropped++;
      continue;
    }

    // G92 sets both counters: afterwards source and output mean the same zero
    // again. A cut-out G92 never reaches the printer, so it may only move the
    // source counter.
    const g = g92E(t);
    if (g !== null) {
      inE = g;
      if (keep) { outE = g; out.push(raw[i]); } else dropped++;
      continue;
    }

    const mv = moveE(t);
    if (!mv) {
      if (keep) out.push(raw[i]); else dropped++;
      continue;
    }

    const delta = absE ? mv.e - inE : mv.e;
    const pure = !mv.hasXY && delta !== 0;    // retract or deretract
    const wasRetracted = srcRetracted;
    if (pure) srcRetracted = delta < 0;
    inE = absE ? mv.e : inE + delta;

    if (!keep) { dropped++; continue; }
    if (pure) {
      const intent = delta < 0;                    // true = retracted
      if (intent === outRetracted && intent !== wasRetracted) {
        dropped++; seams++; continue;
      }
      outRetracted = intent;
    }

    const o = owner[i] >= 0 ? objects[owner[i]] : null;
    // Only extrusion is scaled: positive delta with an XY move. Retract
    // (negative), deretract (positive without travel) and wipe (negative with
    // travel) stay as they are.
    const scaled = o && o.factor !== null && delta > 0 && mv.hasXY;
    const nd = scaled ? delta * o.factor : delta;
    if (nd > 0 && mv.hasXY) extruded += nd;

    outE += nd;
    let text;
    if (absE) {
      text = formatE(outE);
      outE = parseFloat(text);        // pull the model onto the value written
    } else {
      text = scaled ? formatE(nd) : null;
    }
    if (text === null || text === t.slice(mv.at, mv.at + mv.len)) {
      out.push(raw[i]);
      continue;
    }
    // Replace in the raw line, not the trimmed one: whitespace has to survive
    // exactly as it arrived.
    const lead = raw[i].length - raw[i].trimStart().length;
    const at = lead + mv.at;
    out.push(raw[i].slice(0, at) + text + raw[i].slice(at + mv.len));
    changed++;
  }

  const insert = mapLines(plan);
  out.splice(mapAt, 0, ...insert);

  const m = plan.doc.material;
  const area = Math.PI * Math.pow(m.filamentDiameter / 2, 2);
  const filamentCm3 = Number.isFinite(area) ? extruded * area / 1000 : NaN;
  const filamentG = Number.isFinite(m.density) && m.density > 0 ? filamentCm3 * m.density : NaN;
  const filamentCost = Number.isFinite(filamentG) && Number.isFinite(m.cost) && m.cost > 0
    ? filamentG / 1000 * m.cost : NaN;
  const stats = { filamentMm: extruded, filamentCm3, filamentG, filamentCost };

  let lines = rewriteStats(out, stats);
  // Times are touched only when something was really cut: otherwise the
  // slicer's numbers would just be re-rounded through our own measure -- a
  // change without gain. `timeSec` reports the output time either way.
  let timeSec = headerSeconds(raw, TIME_NORMAL);
  let silentSec = headerSeconds(raw, TIME_SILENT);
  if (cutting) {
    const accSrc = moveSeconds(raw), accOut = moveSeconds(lines);
    const share = accSrc[raw.length] > 0 ? accOut[lines.length] / accSrc[raw.length] : 1;
    timeSec *= share;
    silentSec *= share;
    lines = rewriteTime(lines, accOut, timeSec, silentSec);
  }

  return {
    lines,
    stats: Object.assign({
      inserted: insert.length,
      changedLines: changed,
      droppedLines: dropped,
      seamFixes: seams,
      gcodeLines: lines.length,
      removed: objects.filter(o => !o.printed).length,
      active: objects.filter(o => o.printed).length,
      timeSec, silentSec,
    }, stats),
  };
}
