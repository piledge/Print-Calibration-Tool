/**
 * em/preview.js — the bed map: one tile per plate, labelled with the value it
 * gets printed at. It doubles as the selection surface for step 5.
 *
 * No DOM access other than the canvas passed in.
 */

import { COLOR, FONT, DEFAULT_BED, computeTransform, prepareCanvas, drawBed } from '../canvas.js';

let lastTransform = null;
let lastPlan = null;

// What is not printed is drawn dimmed, so the cut is visible at a glance.
function drawPlate(ctx, tr, o, selected) {
  const a = tr.toPx(o.minX, o.minY);
  const b = tr.toPx(o.maxX, o.maxY);
  const x = a.px, y = b.py, w = b.px - a.px, h = a.py - b.py;
  const color = o.skip ? COLOR.alarm
    : !o.printed ? COLOR.traceDim
    : selected ? COLOR.traceAlt : COLOR.trace;

  if (selected) {
    ctx.fillStyle = COLOR.traceDim;
    ctx.fillRect(x, y, w, h);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = selected ? 2 : 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

  ctx.font = FONT;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(o.skip ? 'skip' : o.value.toFixed(3), x + w / 2, y + h / 2);
}

/** `plan` is {objects, printed, bed, selected}. */
export function drawPlates(canvas, plan) {
  const prepared = prepareCanvas(canvas);
  if (!prepared) return;
  const bed = (plan.bed && plan.bed.x > 0 && plan.bed.y > 0) ? plan.bed : DEFAULT_BED;
  const tr = computeTransform(canvas, bed);
  lastTransform = tr;
  lastPlan = plan;
  drawBed(prepared.ctx, tr, bed);
  if (!(tr.scale > 0)) return;
  const chosen = plan.selected >= 0 ? plan.printed[plan.selected] : null;
  for (const o of plan.objects) drawPlate(prepared.ctx, tr, o, o === chosen);
}

export function clearPlates(canvas, bed) {
  const prepared = prepareCanvas(canvas);
  if (!prepared) return;
  lastTransform = null;
  lastPlan = null;
  const b = (bed && bed.x > 0 && bed.y > 0) ? bed : DEFAULT_BED;
  drawBed(prepared.ctx, computeTransform(canvas, b), b);
}

/**
 * Click position -> index into plan.printed, or -1 beside; a cut-out plate
 * selects nothing. Hit testing uses the transform of the last draw, so scale
 * and framing match the image.
 */
export function pickPlate(canvas, ev, plan) {
  if (!lastTransform || lastPlan !== plan || !plan || !plan.objects.length) return -1;
  const rect = canvas.getBoundingClientRect();
  const px = ev.clientX - rect.left;
  const py = ev.clientY - rect.top;
  for (const o of plan.objects) {
    const a = lastTransform.toPx(o.minX, o.minY);
    const b = lastTransform.toPx(o.maxX, o.maxY);
    if (px >= a.px && px <= b.px && py >= b.py && py <= a.py) {
      const i = plan.printed.indexOf(o);
      if (i >= 0) return i;
    }
  }
  return -1;
}
