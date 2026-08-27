/**
 * preview.js — draws the generated gcode as a to-scale top view.
 * No DOM access beyond the canvas that is handed in.
 */

import { COLOR, DEFAULT_BED, computeTransform, prepareCanvas, drawBed } from '../canvas.js';

// Category → bucket. anchor and tab share colour and line width, so they end
// up in the same path.
function bucketOf(cat) {
  if (cat === 'anchor' || cat === 'tab') return 'dim';
  if (cat === 'glyph') return 'glyph';
  return 'pattern';
}

// Draw order: anchor/tab, pattern, glyphs; segments leaving the bed last.
const BUCKET_ORDER = ['dim', 'pattern', 'glyph'];
const BUCKET_COLOR = { dim: COLOR.traceDim, pattern: COLOR.trace, glyph: COLOR.traceAlt };

/* --- Parser ---------------------------------------------------------------- */

// G0/G1 at the start of the line, but not G10/G17/…
const MOVE_RE = /^\s*[Gg][01](?![0-9])/;
// Axis parameters; upper and lower case allowed, exponents tolerated.
const PARAM_RE = /([XYZExyze])\s*(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
// Category marker in the trailing comment.
const CAT_RE = /\b(pattern|anchor|glyph|tab)\b/;

/**
 * Minimal gcode parser — understands only our own output. We emit relative
 * extrusion (M83), so a move extrudes exactly when E is present and > 0.
 */
export function parseGcode(lines) {
  const segments = [];
  if (!Array.isArray(lines) || lines.length === 0) return segments;

  // Modal state: axes that are not given keep their last value.
  let x = 0, y = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (typeof line !== 'string' || line.length === 0) continue;

    const semi = line.indexOf(';');
    const code = semi >= 0 ? line.slice(0, semi) : line;
    if (!MOVE_RE.test(code)) continue;   // M-codes, macros, comment lines

    let nx = x, ny = y, e = null;
    PARAM_RE.lastIndex = 0;
    let m;
    while ((m = PARAM_RE.exec(code)) !== null) {
      const v = parseFloat(m[2]);
      if (!Number.isFinite(v)) continue;
      switch (m[1]) {
        case 'X': case 'x': nx = v; break;
        case 'Y': case 'y': ny = v; break;
        case 'Z': case 'z': break;          // top view: Z is irrelevant, but must
                                            // not fall into the E branch
        default:            e = v; break;   // E
      }
    }

    // Travels (no E, E <= 0) only move the position; moves without a change of
    // place (pure priming/deretract) yield no segment.
    if (e !== null && e > 0 && (nx !== x || ny !== y)) {
      const comment = semi >= 0 ? line.slice(semi + 1) : '';
      const cm = comment ? CAT_RE.exec(comment) : null;
      segments.push({ x1: x, y1: y, x2: nx, y2: ny, cat: cm ? cm[1] : 'pattern' });
    }

    x = nx;
    y = ny;
  }

  return segments;
}

/* --- Drawing --------------------------------------------------------------- */

/** Outline of the pattern area, if plan.geom is present. */
function drawGeom(ctx, tr, geom) {
  if (!geom) return;
  const { startX, startY, sizeX, sizeY } = geom;
  if (![startX, startY, sizeX, sizeY].every(Number.isFinite)) return;
  if (!(sizeX > 0) || !(sizeY > 0)) return;

  const a = tr.toPx(startX, startY + sizeY);   // top left corner
  ctx.save();
  ctx.strokeStyle = COLOR.grid;
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 3]);
  ctx.strokeRect(Math.round(a.px) + 0.5, Math.round(a.py) + 0.5,
                 Math.round(sizeX * tr.scale), Math.round(sizeY * tr.scale));
  ctx.restore();
}

/** One collected path, one stroke(). */
function strokeBucket(ctx, segs, tr, color, widthPx) {
  if (segs.length === 0) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = widthPx;
  // Inline instead of toPx() — saves two object allocations per segment, which
  // matters at several thousand moves.
  const sc = tr.scale, ox = tr.offX, oy = tr.offY, by = tr.bedY;
  ctx.beginPath();
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    ctx.moveTo(ox + s.x1 * sc, oy + (by - s.y1) * sc);
    ctx.lineTo(ox + s.x2 * sc, oy + (by - s.y2) * sc);
  }
  ctx.stroke();
}

/** Draws bed and segments. The context must already be dpr-scaled. */
function render(ctx, segments, transform, plan) {
  if (!ctx || !transform) return;
  const p = plan || {};
  const bed = (p.bed && p.bed.x > 0 && p.bed.y > 0) ? p.bed : DEFAULT_BED;

  drawBed(ctx, transform, bed);
  if (transform.scale <= 0) return;
  drawGeom(ctx, transform, p.geom);
  drawSegments(ctx, segments, transform, p, { bed });
}

/**
 * Draws only the moves, without bed and dimensions. Also used by thumbnail.js,
 * there without the alarm colour — a preview image needs no warning.
 *
 * `opts.bed` switches the alarm check on; without it the check is skipped.
 */
export function drawSegments(ctx, segments, transform, plan, opts) {
  const p = plan || {};
  const bed = opts && opts.bed;
  const lw = Number.isFinite(p.lineWidth) && p.lineWidth > 0 ? p.lineWidth : 0.45;
  const alw = Number.isFinite(p.anchorLineWidth) && p.anchorLineWidth > 0 ? p.anchorLineWidth : lw;
  const widthMm = bucket => bucket === 'dim' ? alw : lw;
  const pxWidth = mm => Math.max(1, mm * transform.scale);

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // One path per bucket, plus one alarm path per line width.
  const buckets = { dim: [], pattern: [], glyph: [] };
  const alarm = new Map();   // mm width → segments

  const list = Array.isArray(segments) ? segments : [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (!s) continue;
    const bucket = bucketOf(s.cat);
    if (bed && outsideBed(s, bed)) {
      const w = widthMm(bucket);
      let arr = alarm.get(w);
      if (!arr) { arr = []; alarm.set(w, arr); }
      arr.push(s);
    } else {
      buckets[bucket].push(s);
    }
  }

  for (const bucket of BUCKET_ORDER) {
    strokeBucket(ctx, buckets[bucket], transform, BUCKET_COLOR[bucket], pxWidth(widthMm(bucket)));
  }
  for (const [w, segs] of alarm) {
    strokeBucket(ctx, segs, transform, COLOR.alarm, pxWidth(w));
  }
}

function outsideBed(s, bed) {
  return s.x1 < 0 || s.x1 > bed.x || s.y1 < 0 || s.y1 > bed.y ||
         s.x2 < 0 || s.x2 > bed.x || s.y2 < 0 || s.y2 > bed.y;
}

/* --- Public drawing functions ---------------------------------------------- */

// Last transform used, so a click into the image can be mapped back. Kept here
// because only here is it known how the drawing was done.
let lastTransform = null;

/** Which chevron lies under the click? -1 when nothing is drawn. */
export function pickIndex(canvas, ev, plan) {
  if (!lastTransform || !plan || !plan.paValues || plan.paValues.length === 0) return -1;
  const rect = canvas.getBoundingClientRect();
  const worldX = (ev.clientX - rect.left - lastTransform.offX) / lastTransform.scale;
  const j = Math.round((worldX - plan.geom.patternStartX) / plan.geom.patternPitch);
  return Math.min(plan.paValues.length - 1, Math.max(0, j));
}

/**
 * Draws the generated gcode onto the canvas, to scale, without modifying
 * `plan`. `lines` is only the pattern block, without header, start and end
 * block; `plan` is read for { bed, geom, lineWidth, anchorLineWidth }.
 */
export function drawPreview(canvas, lines, plan) {
  const prepared = prepareCanvas(canvas);
  if (!prepared) return;
  const p = plan || {};
  const bed = (p.bed && p.bed.x > 0 && p.bed.y > 0) ? p.bed : DEFAULT_BED;
  const transform = computeTransform(canvas, bed);
  lastTransform = transform;
  render(prepared.ctx, parseGcode(lines), transform, p);
}

/** Empty area: bed outline and grid only, no content. `bed` defaults to 250 x 250. */
export function clearPreview(canvas, bed) {
  const prepared = prepareCanvas(canvas);
  if (!prepared) return;
  const b = (bed && bed.x > 0 && bed.y > 0) ? bed : DEFAULT_BED;
  lastTransform = null;                       // without a pattern there is nothing to hit
  render(prepared.ctx, [], computeTransform(canvas, b), { bed: b });
}
