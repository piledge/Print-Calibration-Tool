/**
 * canvas.js — drawing helpers shared by all tests: colour table, mm-to-pixel
 * mapping, pixel-density fit, and the backdrop of bed and grid.
 */

/* --- Colours ------------------------------------------------------------- */

export const COLOR = {
  screen:   '#141a12',   // --screen
  grid:     '#26401a',   // muted grid, darker than the bed outline
  bed:      '#3f6b26',   // --trace-dim
  traceDim: '#3f6b26',   // --trace-dim  → held back: anchors, what is not printed
  trace:    '#8ed14a',   // --trace      → the pattern, the printed parts
  traceAlt: '#d8c24a',   // --trace-alt  → highlighted: digits, selection
  alarm:    '#a8302a'    // alarm colour for the dark screen; the CSS --alarm is
                         // the darker variant meant for a light background
};

const MARGIN = 12;        // margin around the bed, in screen pixels
export const FONT_FAMILY = 'ui-monospace, "DejaVu Sans Mono", Consolas, monospace';
export const FONT = '10px ' + FONT_FAMILY;
export const DEFAULT_BED = { x: 250, y: 250 };

function cssSize(canvas) {
  let w = 0, h = 0;
  if (canvas && typeof canvas.getBoundingClientRect === 'function') {
    const r = canvas.getBoundingClientRect();
    if (r) { w = r.width || 0; h = r.height || 0; }
  }
  if (!(w > 0) || !(h > 0)) {
    w = (canvas && canvas.width) || 0;
    h = (canvas && canvas.height) || 0;
  }
  return { w, h };
}

/**
 * Maps world coordinates (mm, origin bottom left) to screen pixels. Y is
 * mirrored and the bed sits centred in the drawing area.
 *
 * @returns {{scale:number,offX:number,offY:number,width:number,height:number,bedY:number,toPx:Function}}
 */
export function computeTransform(canvas, bed) {
  const { w, h } = cssSize(canvas);
  const bx = bed && bed.x > 0 ? bed.x : DEFAULT_BED.x;
  const by = bed && bed.y > 0 ? bed.y : DEFAULT_BED.y;

  const usableW = w - 2 * MARGIN;
  const usableH = h - 2 * MARGIN;
  let scale = Math.min(usableW / bx, usableH / by);
  if (!Number.isFinite(scale) || scale <= 0) scale = 0;

  const offX = (w - bx * scale) / 2;          // left bed edge, in px
  const offY = (h - by * scale) / 2;          // top bed edge, in px

  return {
    scale, offX, offY, width: w, height: h, bedY: by,
    // Y points up in world space, so measure down from the top edge.
    toPx(px, py) {
      return { px: offX + px * scale, py: offY + (by - py) * scale };
    }
  };
}

/** Fits the canvas to devicePixelRatio and scales the context to match. */
export function prepareCanvas(canvas) {
  if (!canvas || typeof canvas.getContext !== 'function') return null;
  const { w, h } = cssSize(canvas);
  if (!(w > 0) || !(h > 0)) return null;

  const dpr = (typeof devicePixelRatio === 'number' && devicePixelRatio > 0) ? devicePixelRatio : 1;
  const pw = Math.max(1, Math.round(w * dpr));
  const ph = Math.max(1, Math.round(h * dpr));
  if (canvas.width !== pw) canvas.width = pw;
  if (canvas.height !== ph) canvas.height = ph;

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(pw / w, 0, 0, ph / h, 0, 0);   // from here on everything is in CSS pixels
  return { ctx, w, h };
}

const GRID_STEP = 50;     // grid spacing, in mm

/** Keeps a number short: 250 rather than 250.0. */
function fmt(v) {
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10);
}

/**
 * Background, grid, bed outline and size label.
 *
 * The label is omitted for `DEFAULT_BED`, the assumed fallback when no file is
 * loaded or `bed_shape` could not be read — a made-up number is worse than
 * none. A real 250 × 250 bed comes as its own object from `settings.js` and
 * stays labelled.
 */
export function drawBed(ctx, tr, bed) {
  ctx.fillStyle = COLOR.screen;
  ctx.fillRect(0, 0, tr.width, tr.height);
  if (tr.scale <= 0) return;

  const left = tr.offX;
  const top = tr.offY;
  const right = tr.offX + bed.x * tr.scale;
  const bottom = tr.offY + bed.y * tr.scale;

  // The half pixel keeps the 1 px line crisp.
  ctx.lineWidth = 1;
  ctx.strokeStyle = COLOR.grid;
  ctx.beginPath();
  for (let gx = GRID_STEP; gx < bed.x; gx += GRID_STEP) {
    const px = Math.round(left + gx * tr.scale) + 0.5;
    ctx.moveTo(px, top); ctx.lineTo(px, bottom);
  }
  for (let gy = GRID_STEP; gy < bed.y; gy += GRID_STEP) {
    const py = Math.round(bottom - gy * tr.scale) + 0.5;
    ctx.moveTo(left, py); ctx.lineTo(right, py);
  }
  ctx.stroke();

  ctx.strokeStyle = COLOR.bed;
  ctx.strokeRect(Math.round(left) + 0.5, Math.round(top) + 0.5,
                 Math.round(right - left), Math.round(bottom - top));

  if (bed === DEFAULT_BED) return;

  ctx.font = FONT;
  ctx.fillStyle = COLOR.bed;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`${fmt(bed.x)} x ${fmt(bed.y)} mm`, 2, 2);
}
