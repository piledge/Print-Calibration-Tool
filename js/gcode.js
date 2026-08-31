/**
 * gcode.js — helpers shared by the tests: parsing single gcode lines, time
 * formats, and rewriting the material/time figures PrusaSlicer writes into the
 * file as comments.
 */

/* --- Parsing lines ------------------------------------------------------- */

/**
 * A move command with numeric values. Deliberately only G0..G3: `M201 … E5000`
 * and `M205 … E10.00` also carry an E but mean machine limits, and `M84 E` has
 * an E with no number at all — a wider pattern would rewrite those too.
 */
export const MOVE_RE = /^G([0-3])(?![0-9])/;
const NUM = '(-?(?:\\d+(?:\\.\\d*)?|\\.\\d+))';
const E_RE  = new RegExp('(^|\\s)E' + NUM);
const XY_RE = new RegExp('(^|\\s)[XY]' + NUM);
const G92_RE = new RegExp('^G92(?![0-9])(?:.*?)(^|\\s)E' + NUM);

/**
 * The command part of a line — everything before the first semicolon. Without
 * this an `E` inside a comment would be read as a parameter and overwritten
 * (`G1 X20 Y20 F9000 ; travel, keep E2.0`).
 */
export function codeOf(line) {
  const semi = line.indexOf(';');
  return semi < 0 ? line : line.slice(0, semi);
}

/**
 * Parses a move command with an E value. `at`/`len` mark the number behind the
 * E so the generator can replace it without reassembling the whole line.
 */
export function moveE(line) {
  if (!MOVE_RE.test(line)) return null;
  const code = codeOf(line);
  const m = E_RE.exec(code);
  if (!m) return null;
  const at = m.index + m[1].length + 1;
  return { e: parseFloat(m[2]), hasXY: XY_RE.test(code), at, len: m[2].length };
}

/** M82/M83 -> true/false for "absolute E numbering", otherwise null. */
export function eModeChange(line) {
  if (/^M82(?![0-9])/i.test(line)) return true;
  if (/^M83(?![0-9])/i.test(line)) return false;
  return null;
}

/** Axis value from the command part of a line: `axisValue(code, 'Z')`. */
const AXIS_RE = {};
export function axisValue(code, letter) {
  let re = AXIS_RE[letter];
  if (!re) re = AXIS_RE[letter] = new RegExp('(^|\\s)' + letter + NUM);
  const m = re.exec(code);
  return m ? parseFloat(m[2]) : null;
}

/**
 * Replace the number behind an axis letter without rebuilding the line, so
 * spacing, feedrate and the other axes survive untouched.
 */
const AXIS_SET = {};
export function setAxis(code, letter, text) {
  let re = AXIS_SET[letter];
  if (!re) {
    re = AXIS_SET[letter] =
      new RegExp('((?:^|\\s)' + letter + ')(-?(?:\\d+(?:\\.\\d*)?|\\.\\d+))');
  }
  return code.replace(re, (m, head) => head + text);
}

/** G92 with an E value -> the new position, otherwise null. */
export function g92E(line) {
  const m = G92_RE.exec(codeOf(line));
  return m ? parseFloat(m[2]) : null;
}

/* --- Time and statistics ------------------------------------------------- */

/**
 * PrusaSlicer's number format: at most five decimals, trailing zeros dropped,
 * no leading zero before the point (".01404", "-.7", "1.24434").
 */
export function formatCoord(v) {
  if (!Number.isFinite(v)) return '0';
  let s = v.toFixed(5).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  s = s.replace(/^(-?)0\./, '$1.');
  if (s === '' || s === '-' || s === '-0') s = '0';
  return s;
}

/* --- Probe area ------------------------------------------------------------
   M555 is the rectangle Prusa firmware probes before the print. PrusaSlicer
   computes it while slicing, from the first layer's bounding box, so it is
   wrong as soon as the print changes: too large when plates are cut out of the
   EM plate, too small when the PA pattern lands somewhere else than the model
   that was sliced. Klipper has no equivalent -- there the area follows the
   EXCLUDE_OBJECT declarations, which both tests already rewrite.

   The slicer's formula is not reproduced: it is profile specific and clamps
   against the bed. Instead the margins it left around its own print are
   measured and applied to the new one. Two guards keep that honest when the
   measurement is not: a negative margin (the rectangle did not contain the
   print it belonged to, as in a truncated file) counts as zero, and the result
   never covers ground that neither the old rectangle nor the new print already
   covered. Without the second rule a nonsensical margin would grow the area
   over the whole bed. */

const M555_RE = /^M555(?=\s|$)/i;

/**
 * @param {string[]} lines  edited in place
 * @param {?object} was   {x0,y0,x1,y1} what the rectangle in the file belongs
 *   to; null when it cannot be measured, then no margins are carried over
 * @param {object} now    {x0,y0,x1,y1} what is printed instead
 * @param {?object} bounds  {x0,y0,x1,y1} the result stays inside, null = bed unknown
 * @returns {number} how many M555 lines were rewritten
 */
export function rewriteProbeArea(lines, was, now, bounds) {
  if (!now) return 0;
  const b = bounds || { x0: -Infinity, y0: -Infinity, x1: Infinity, y1: Infinity };
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    // The config block at the end of a slicer file quotes the unevaluated start
    // gcode, M555 placeholder included -- comments stay comments.
    if (t === '' || t.charAt(0) === ';' || !M555_RE.test(t)) continue;
    const semi = lines[i].indexOf(';');
    const code = semi < 0 ? lines[i] : lines[i].slice(0, semi);
    const x = axisValue(code, 'X'), y = axisValue(code, 'Y');
    const w = axisValue(code, 'W'), h = axisValue(code, 'H');
    if (x === null || y === null || !(w > 0) || !(h > 0)) continue;
    const ml = was ? Math.max(0, was.x0 - x) : 0;
    const mb = was ? Math.max(0, was.y0 - y) : 0;
    const mr = was ? Math.max(0, x + w - was.x1) : 0;
    const mt = was ? Math.max(0, y + h - was.y1) : 0;
    // Read from the inside out: the print itself, then the margin, then what
    // was covered before, then the bed -- and never so far in that the print
    // would stick out again.
    const nx0 = Math.min(now.x0, Math.max(b.x0, Math.min(x, now.x0), now.x0 - ml));
    const ny0 = Math.min(now.y0, Math.max(b.y0, Math.min(y, now.y0), now.y0 - mb));
    const nx1 = Math.max(now.x1, Math.min(b.x1, Math.max(x + w, now.x1), now.x1 + mr));
    const ny1 = Math.max(now.y1, Math.min(b.y1, Math.max(y + h, now.y1), now.y1 + mt));
    if (!(nx1 > nx0) || !(ny1 > ny0)) continue;
    let next = setAxis(code, 'X', formatCoord(nx0));
    next = setAxis(next, 'Y', formatCoord(ny0));
    next = setAxis(next, 'W', formatCoord(nx1 - nx0));
    next = setAxis(next, 'H', formatCoord(ny1 - ny0));
    if (next === code) continue;
    lines[i] = next + (semi < 0 ? '' : lines[i].slice(semi));
    n++;
  }
  return n;
}

/** Seconds -> "1h 52m 0s", exactly PrusaSlicer's notation. */
export function formatDuration(sec) {
  const t = Math.max(0, Math.round(sec));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return (h > 0 ? h + 'h ' : '') + (h > 0 || m > 0 ? m + 'm ' : '') + s + 's';
}

/**
 * Seconds -> "7 min" / "4 h 31 min" for display. `null` when the time is
 * unknown, so step 3 leaves the slot out instead of writing "NaN min". Rounded
 * to the minute: no time model here is more accurate, and the seconds of
 * `formatDuration` belong in the file, not on screen.
 */
export function formatSpan(sec) {
  if (!Number.isFinite(sec) || sec < 0) return null;
  const t = Math.round(sec / 60);
  if (t < 1) return '< 1 min';
  const h = Math.floor(t / 60), m = t % 60;
  return h > 0 ? h + ' h ' + String(m).padStart(2, '0') + ' min' : m + ' min';
}

/** "1h 9m 48s" -> seconds. NaN if there is nothing usable in it. */
export function parseDuration(text) {
  const m = /(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?/.exec(String(text).trim());
  if (!m || (!m[1] && !m[2] && !m[3])) return NaN;
  return (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
}

/**
 * Replaces the material and time figures of the source model with those of the
 * test print. Depending on the profile PrusaSlicer writes this block once or
 * twice (CORE One: also at the top of the file), so the replacement runs over
 * both the start and the end block.
 *
 * If a value cannot be computed (no density, no price), the original line is
 * kept — an old number in the file beats a NaN.
 */
export function rewriteStats(lines, stats) {
  const num = v => Number.isFinite(v) ? v : null;
  const mm = num(stats.filamentMm), cm3 = num(stats.filamentCm3);
  const g = num(stats.filamentG), cost = num(stats.filamentCost);
  const total = num(stats.timeSec), first = num(stats.firstLayerSec);
  const silent = num(stats.silentSec);

  const rules = [
    [/^(;\s*filament used \[mm\]\s*=\s*).*$/i,      mm   === null ? null : mm.toFixed(2)],
    [/^(;\s*filament used \[cm3\]\s*=\s*).*$/i,     cm3  === null ? null : cm3.toFixed(2)],
    [/^(;\s*filament used \[g\]\s*=\s*).*$/i,       g    === null ? null : g.toFixed(2)],
    [/^(;\s*total filament used \[g\]\s*=\s*).*$/i, g    === null ? null : g.toFixed(2)],
    [/^(;\s*total filament cost\s*=\s*).*$/i,       cost === null ? null : cost.toFixed(2)],
    // PrusaSlicer writes the same number in the header without "total". Not to
    // be confused with "; filament_cost", the price per kilogram from the
    // config block — that one stays.
    [/^(;\s*filament cost\s*=\s*).*$/i,             cost === null ? null : cost.toFixed(2)],
    [/^(;\s*estimated printing time \(normal mode\)\s*=\s*).*$/i,
      total === null ? null : formatDuration(total)],
    [/^(;\s*estimated printing time \(silent mode\)\s*=\s*).*$/i,
      silent === null ? null : formatDuration(silent)],
    [/^(;\s*estimated first layer printing time \(normal mode\)\s*=\s*).*$/i,
      first === null ? null : formatDuration(first)],
  ];

  return lines.map(line => {
    for (const [re, value] of rules) {
      const m = re.exec(line);
      if (m) return value === null ? line : m[1] + value;
    }
    // Progress lines: keep the percentage, recompute the remaining time.
    const p = /^(M73\s+P)(\d+)(\s+R)(\d+)\s*$/i.exec(line);
    if (p && total !== null) {
      const pct = Math.min(100, Math.max(0, +p[2]));
      return p[1] + pct + p[3] + Math.round(total * (100 - pct) / 100 / 60);
    }
    const q = /^(M73\s+Q)(\d+)(\s+S)(\d+)\s*$/i.exec(line);
    if (q && silent !== null) {
      const pct = Math.min(100, Math.max(0, +q[2]));
      return q[1] + pct + q[3] + Math.round(silent * (100 - pct) / 100 / 60);
    }
    return line;
  });
}
