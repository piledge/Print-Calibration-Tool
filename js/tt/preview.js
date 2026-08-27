/**
 * tt/preview.js — the silhouette of the tower: one horizontal stroke per layer
 * from the left to the right edge, next to it the temperature of each band.
 *
 * Always the **whole** tower is shown, the unprinted part dimmed, so one glance
 * shows what the trimming takes away. The drawing is at the same time the
 * selection area for step 5.
 *
 * No DOM access other than the canvas passed in.
 */

import { COLOR, FONT_FAMILY, DEFAULT_BED, computeTransform, prepareCanvas, drawBed }
  from '../canvas.js';

const MARGIN = 12;
const GAP = 10;             // between tower and labels
const LABEL_PX = 11;        // font size of the temperatures on screen

let lastLayout = null;
let lastPlan = null;

export function labelOf(band) {
  return band.temp + ' °C';
}

/**
 * Scale and position. Computed in screen or image pixels, not in mm.
 *
 * @param {object} opt  {margin, onlyPrinted, labels, labelWidth} — `labelWidth`
 *   is the measured width of the widest label; the caller has to supply it,
 *   because there is no drawing context at hand here.
 */
export function towerLayout(plan, w, h, opt) {
  const o = opt || {};
  const margin = Number.isFinite(o.margin) ? o.margin : MARGIN;
  const bands = o.onlyPrinted ? plan.printed : plan.bands;
  if (!bands.length) return null;

  const first = plan.layers[bands[0].first];
  const last = plan.layers[bands[bands.length - 1].last];
  let x0 = Infinity, x1 = -Infinity;
  for (let i = bands[0].first; i <= bands[bands.length - 1].last; i++) {
    const l = plan.layers[i];
    if (l.minX < x0) x0 = l.minX;
    if (l.maxX > x1) x1 = l.maxX;
  }
  if (!Number.isFinite(x0) || x1 <= x0) return null;

  const z0 = first.z - first.height;
  const z1 = last.z;
  const labelW = o.labels ? o.labelWidth : 0;
  const labelSpace = labelW ? labelW + GAP : 0;
  const usableW = Math.max(1, w - 2 * margin - labelSpace);
  const usableH = Math.max(1, h - 2 * margin);
  const scale = Math.min(usableW / (x1 - x0), usableH / (z1 - z0));
  if (!(scale > 0)) return null;

  const totalW = (x1 - x0) * scale + labelSpace;
  const ox = (w - totalW) / 2 - x0 * scale;
  const oy = (h - (z1 - z0) * scale) / 2;

  return {
    scale, ox, oy, x0, x1, z0, z1,
    labelX: ox + x1 * scale + GAP,
    px: x => ox + x * scale,
    py: z => oy + (z1 - z) * scale,
    bands,
  };
}

/**
 * Grid as in the other two previews, only in side view: the step is the band
 * height, so the horizontal lines fall on the band boundaries. It runs over the
 * whole drawing area — the tower is a solid shape, a grid only below it would
 * not be visible.
 *
 * On screen only; the preview image stays without a grid, as in PA and EM.
 */
function drawGrid(ctx, plan, lay, w, h) {
  const step = plan.bandHeight > 0 ? plan.bandHeight : 10;

  ctx.strokeStyle = COLOR.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let z = lay.z0; lay.py(z) >= 0; z += step) {
    const y = Math.round(lay.py(z)) + 0.5;
    if (y <= h) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
  }
  for (let z = lay.z0 - step; lay.py(z) <= h; z -= step) {
    const y = Math.round(lay.py(z)) + 0.5;
    if (y >= 0) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
  }
  // Horizontal over the full width — the lines sit on the band boundaries and
  // tie every label to its band. Vertical only up to the right edge of the
  // tower, otherwise they would run through the temperatures.
  const stop = lay.px(lay.x1);
  for (let x = lay.x0; lay.px(x) <= stop + 1e-6; x += step) {
    const px = Math.round(lay.px(x)) + 0.5;
    if (px >= 0) { ctx.moveTo(px, 0); ctx.lineTo(px, h); }
  }
  for (let x = lay.x0 - step; lay.px(x) >= 0; x -= step) {
    const px = Math.round(lay.px(x)) + 0.5;
    ctx.moveTo(px, 0); ctx.lineTo(px, h);
  }
  ctx.stroke();

  // The bed the tower stands on — counterpart to the bed outline of the other
  // two previews.
  const floor = Math.round(lay.py(lay.z0)) + 0.5;
  ctx.strokeStyle = COLOR.bed;
  ctx.beginPath();
  ctx.moveTo(0, floor); ctx.lineTo(w, floor);
  ctx.stroke();

  // Dimensions in the top left corner, the same place as for the bed.
  ctx.fillStyle = COLOR.bed;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText((lay.x1 - lay.x0).toFixed(0) + ' x ' + (lay.z1 - lay.z0).toFixed(0) + ' mm', 2, 2);
}

/** The Y bounds of a band in the image. */
function bandBox(plan, lay, band) {
  const first = plan.layers[band.first], last = plan.layers[band.last];
  return { top: lay.py(last.z), bottom: lay.py(first.z - first.height) };
}

/**
 * Silhouette and labels. The context has to be scaled already.
 *
 * @param {object} opt  {labels, font, onlyPrinted, selected}
 */
export function drawTower(ctx, plan, lay, opt) {
  const o = opt || {};
  const printed = new Set(plan.printed.map(b => b.index));
  const chosen = o.selected >= 0 ? plan.printed[o.selected] : null;

  ctx.lineWidth = 1;
  for (const band of lay.bands) {
    const on = printed.has(band.index);
    if (o.onlyPrinted && !on) continue;
    ctx.strokeStyle = band === chosen ? COLOR.traceAlt : (on ? COLOR.trace : COLOR.grid);
    ctx.beginPath();
    for (let i = band.first; i <= band.last; i++) {
      const l = plan.layers[i];
      if (!Number.isFinite(l.minX) || l.maxX <= l.minX) continue;
      const y = Math.round(lay.py(l.z)) + 0.5;
      ctx.moveTo(lay.px(l.minX), y);
      ctx.lineTo(lay.px(l.maxX), y);
    }
    ctx.stroke();
  }

  if (!o.labels) return;
  ctx.font = o.font;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const band of lay.bands) {
    const on = printed.has(band.index);
    if (o.onlyPrinted && !on) continue;
    const box = bandBox(plan, lay, band);
    // The silhouette of a trimmed band may disappear into the grid, its
    // temperature may not — text needs contrast.
    ctx.fillStyle = band === chosen ? COLOR.traceAlt : (on ? COLOR.trace : COLOR.traceDim);
    ctx.fillText(labelOf(band), lay.labelX, (box.top + box.bottom) / 2);
  }
}

export function drawTowerPreview(canvas, plan) {
  const prepared = prepareCanvas(canvas);
  if (!prepared) return;
  const { ctx, w, h } = prepared;
  ctx.fillStyle = COLOR.screen;
  ctx.fillRect(0, 0, w, h);
  lastLayout = null;
  lastPlan = null;
  if (!plan || !plan.bands.length) {
    // No tower in the file: instead of a black area the same bed as with no
    // file loaded, plus the hint that this model is not for this test — like
    // the skipped tiles in the EM test.
    const bed = plan && plan.doc && plan.doc.printer.bed;
    drawSkip(ctx, canvas, bed, w, h);
    return;
  }

  const font = LABEL_PX + 'px ' + FONT_FAMILY;
  ctx.font = font;
  const labelWidth = ctx.measureText(labelOf(plan.bands[plan.bands.length - 1])).width;
  const lay = towerLayout(plan, w, h, { labels: true, labelWidth });
  if (!lay) return;
  drawGrid(ctx, plan, lay, w, h);
  drawTower(ctx, plan, lay, { labels: true, font, selected: plan.selected });
  lastLayout = lay;
  lastPlan = plan;
}

function drawSkip(ctx, canvas, bed, w, h) {
  const b = (bed && bed.x > 0 && bed.y > 0) ? bed : DEFAULT_BED;
  drawBed(ctx, computeTransform(canvas, b), b);
  ctx.font = LABEL_PX + 'px ' + FONT_FAMILY;
  ctx.fillStyle = COLOR.alarm;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('skip', w / 2, h / 2);
}

/**
 * Empty area: bed outline and grid, as in the other two tests. Without a file
 * there is no tower a side view could refer to, so the same bed is shown.
 *
 * @param {{x:number,y:number}} [bed]  optional, otherwise 250 x 250
 */
export function clearTowerPreview(canvas, bed) {
  const prepared = prepareCanvas(canvas);
  if (!prepared) return;
  lastLayout = null;
  lastPlan = null;
  const b = (bed && bed.x > 0 && bed.y > 0) ? bed : DEFAULT_BED;
  drawBed(prepared.ctx, computeTransform(canvas, b), b);
}

/**
 * Click position -> index into plan.printed, or -1 for a miss. Computed against
 * the layout drawn last, so that image and hit cannot drift apart.
 */
export function pickBand(canvas, ev, plan) {
  if (!lastLayout || lastPlan !== plan) return -1;
  const rect = canvas.getBoundingClientRect();
  const py = ev.clientY - rect.top;
  for (let i = 0; i < plan.printed.length; i++) {
    const box = bandBox(plan, lastLayout, plan.printed[i]);
    if (py >= box.top && py <= box.bottom) return i;
  }
  return -1;
}
