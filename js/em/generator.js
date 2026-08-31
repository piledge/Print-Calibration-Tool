/**
 * em/generator.js — rewrites the source file's E values per object and cuts out
 * the plates that were not selected.
 *
 * No new geometry: the output is the input with every extrusion inside an
 * object's markers multiplied by that object's factor. Retracts, deretracts and
 * everything outside the markers stay untouched.
 *
 * The one exception is travel: the slicer emits the approach to an object partly
 * before its start marker, so cutting a plate leaves half an approach behind,
 * aimed at a plate that is gone. Those points are put back on the direct line
 * (straightenTravel) -- X and Y only, on moves that place no material.
 *
 * Second exception, for the same reason: the area the printer probes before the
 * print. It is derived from the whole plate and would still cover it after a
 * cut (see the two blocks about the object declarations and about M555).
 */

import { moveE, g92E, eModeChange, rewriteStats, formatCoord as formatE,
         codeOf, axisValue, setAxis, formatDuration, parseDuration,
         rewriteProbeArea, MOVE_RE } from '../gcode.js';

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
  // Five decimals like the factors below: rounded to three, a profile of
  // 0.9825 reads as 0.983 and every factor in the map stops matching em divided
  // by it. The values written into the file were always right -- only the map
  // did not add up for anyone recomputing it.
  const L = [MAP_BEGIN, '; em profile multiplier = ' + plan.profile.toFixed(5),
    // The suffix only appears in the coarse mode, so every file made with the
    // full step keeps the line it always had -- and a checker can recompute the
    // selection from the map alone.
    '; em selected = ' + num(plan.from, 3) + ' … ' + num(plan.to, 3) + ', '
      + plan.objects.filter(o => o.printed).length + ' of ' + plan.objects.length + ' plates'
      + (plan.fine === false ? ', whole percent only' : '')];
  for (const o of plan.objects) {
    L.push('; em object ' + o.id + ' | ' + o.name +
      ' | em=' + num(o.value, 3) +
      ' | factor=' + num(o.factor, 5) +
      ' | x=' + num(o.cx, 3) +
      ' | y=' + num(o.cy, 3) +
      ' | ' + (o.printed ? 'printed' : 'removed, ' + reasonOf(o)));
  }
  L.push(MAP_END);
  // With M486 the removed objects' declarations have to stay -- the object
  // numbering hangs off them -- so each one is cancelled individually,
  // otherwise it waits in the printer's object list until the print ends.
  // Klipper needs no command: there the declaration itself is cut out.
  for (const o of plan.objects) {
    if (o.printed || plan.flavor === 'klipper') continue;
    L.push('M486 P' + o.id);
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

/**
 * Redirect a run of travel moves onto the straight line from where the head
 * really is to where it really has to go.
 *
 * The slicer emits the approach to an object partly BEFORE its start marker.
 * Cutting a plate out therefore leaves the first half of the approach behind,
 * still aimed at the plate that is gone; the head drives there and only then to
 * the next one printed. Measured on a nine-plate selection: detours up to
 * 290 mm, where the source itself never exceeds 52 mm.
 *
 * The points are not deleted but spread along the direct line, each keeping its
 * share of the original path length. That way the Z ramp of the lift, the
 * feedrates and the number of lines stay exactly as the slicer wrote them --
 * only X and Y move onto the line that leads somewhere.
 *
 * @param {string[]} out    output lines, edited in place
 * @param {{x:number, y:number}} from   position before the first point
 * @param {{i:number, x:number, y:number}[]} run  travel points, last one is the target
 * @returns {number} how many lines were rewritten
 */
function straightenTravel(out, from, run) {
  const to = run[run.length - 1];
  const pts = [from].concat(run);
  const step = [];
  let total = 0;
  for (let k = 1; k < pts.length; k++) {
    total += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y);
    step.push(total);
  }
  if (!(total > 0)) return 0;
  let fixed = 0;
  for (let k = 0; k < run.length - 1; k++) {
    const f = step[k] / total;
    const nx = Math.round((from.x + (to.x - from.x) * f) * 1000) / 1000;
    const ny = Math.round((from.y + (to.y - from.y) * f) * 1000) / 1000;
    if (nx === run[k].x && ny === run[k].y) continue;
    const line = out[run[k].i];
    const semi = line.indexOf(';');
    const code = semi < 0 ? line : line.slice(0, semi);
    const rest = semi < 0 ? '' : line.slice(semi);
    out[run[k].i] = setAxis(setAxis(code, 'X', formatE(nx)), 'Y', formatE(ny)) + rest;
    fixed++;
  }
  return fixed;
}

/** Bounding box over the objects' extrusions, null when there is none. */
function bbox(objects, printedOnly) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const o of objects) {
    if (printedOnly && !o.printed) continue;
    if (!Number.isFinite(o.minX)) continue;
    if (o.minX < x0) x0 = o.minX;
    if (o.minY < y0) y0 = o.minY;
    if (o.maxX > x1) x1 = o.maxX;
    if (o.maxY > y1) y1 = o.maxY;
  }
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
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
  // Klipper's adaptive bed mesh (KAMP, and klipper's own ADAPTIVE=1) reads the
  // EXCLUDE_OBJECT_DEFINE list, not the exclusions -- a plate that is merely
  // cancelled still gets probed. So the declaration falls with the plate, and
  // the cancel command in mapLines() becomes unnecessary.
  for (const o of objects) {
    if (!o.printed && o.defLine >= 0) drop[o.defLine] = 1;
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

  // A travel run: everything between two extruding moves. `run` collects the
  // moves inside it that carry X/Y and no E at all -- pure travel. `anchor` is
  // the position the redirect starts from: after the last retract, because a
  // wipe before it still belongs to the plate just finished. Only a run with a
  // cut in it is touched; without one the slicer's own path is still right.
  let px = null, py = null;
  let run = [], anchor = null, cutInRun = false, travelFixes = 0;
  const closeRun = () => {
    if (cutInRun && anchor && run.length >= 2) {
      travelFixes += straightenTravel(out, anchor, run);
    }
    run = [];
    cutInRun = false;
    anchor = px === null ? null : { x: px, y: py };
  };

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
      if (!keep) { dropped++; cutInRun = true; continue; }
      // A move without an E word is travel. It is collected for the redirect
      // and moves the position; anything else just passes through.
      if (MOVE_RE.test(t)) {
        const code = codeOf(t);
        const nx = axisValue(code, 'X'), ny = axisValue(code, 'Y');
        if (nx !== null || ny !== null) {
          if (anchor === null && px !== null) anchor = { x: px, y: py };
          if (nx !== null) px = nx;
          if (ny !== null) py = ny;
          if (nx !== null && ny !== null) run.push({ i: out.length, x: px, y: py });
          else run = [];      // half a coordinate cannot be redirected safely
        }
      }
      out.push(raw[i]);
      continue;
    }

    const delta = absE ? mv.e - inE : mv.e;
    const pure = !mv.hasXY && delta !== 0;    // retract or deretract
    const wasRetracted = srcRetracted;
    if (pure) srcRetracted = delta < 0;
    inE = absE ? mv.e : inE + delta;

    if (!keep) { dropped++; cutInRun = true; continue; }
    if (pure) {
      const intent = delta < 0;                    // true = retracted
      if (intent === outRetracted && intent !== wasRetracted) {
        dropped++; seams++; continue;
      }
      outRetracted = intent;
    }

    // A retract ends the plate just finished: everything after it is travel and
    // may be redirected, everything before it (the wipe) may not.
    if (pure && delta < 0) { run = []; anchor = px === null ? null : { x: px, y: py }; }
    if (mv.hasXY) {
      const code = codeOf(t);
      const nx = axisValue(code, 'X'), ny = axisValue(code, 'Y');
      if (nx !== null) px = nx;
      if (ny !== null) py = ny;
    }

    const o = owner[i] >= 0 ? objects[owner[i]] : null;
    // Only extrusion is scaled: positive delta with an XY move. Retract
    // (negative), deretract (positive without travel) and wipe (negative with
    // travel) stay as they are.
    const scaled = o && o.factor !== null && delta > 0 && mv.hasXY;
    const nd = scaled ? delta * o.factor : delta;
    if (nd > 0 && mv.hasXY) { extruded += nd; closeRun(); }

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
  // The probe area follows the plates that are left (see gcode.js).
  const bed = plan.bed && plan.bed.x > 0 && plan.bed.y > 0
    ? { x0: 0, y0: 0, x1: plan.bed.x, y1: plan.bed.y } : null;
  const probeFixes = cutting
    ? rewriteProbeArea(lines, bbox(objects, false), bbox(objects, true), bed) : 0;

  return {
    lines,
    stats: Object.assign({
      inserted: insert.length,
      changedLines: changed,
      droppedLines: dropped,
      seamFixes: seams,
      travelFixes,
      probeFixes,
      gcodeLines: lines.length,
      removed: objects.filter(o => !o.printed).length,
      active: objects.filter(o => o.printed).length,
      timeSec, silentSec,
    }, stats),
  };
}
