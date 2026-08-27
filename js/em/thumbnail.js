/**
 * em/thumbnail.js — the preview images for the EM file.
 *
 * Draws the same bed map as step 3, only without bed, grid and dimensions. The
 * framing covers the plates, not the bed.
 *
 * Skipped plates are missing: their blocks are cut out of the file, and a
 * preview image shows what comes out, not what the source held.
 */

import { COLOR, FONT_FAMILY } from '../canvas.js';
import { fitTransform, renderThumbnails, MIN_FONT_PX } from '../thumbnail.js';

const PAD_PX = 4;          // gap between tile edge and text

/** Only what really gets printed — the image shows the generated file. */
function platesOf(plan) {
  return plan.objects.filter(o => o.printed &&
    Number.isFinite(o.minX) && Number.isFinite(o.minY) &&
    o.maxX > o.minX && o.maxY > o.minY);
}

/**
 * The font size at which the value fits the tile. Measured rather than
 * computed, because glyph width depends on the font actually used.
 */
function fitFont(ctx, text, w, h) {
  ctx.font = '10px ' + FONT_FAMILY;
  const at10 = ctx.measureText(text).width;
  if (!(at10 > 0)) return 0;
  const byWidth = 10 * (w - PAD_PX) / at10;
  const byHeight = (h - PAD_PX) * 0.6;
  return Math.floor(Math.min(byWidth, byHeight));
}

/** Tile outline and value, in the same colours as the bed map. */
function drawPlates(ctx, plates, tr) {
  ctx.strokeStyle = COLOR.trace;
  ctx.fillStyle = COLOR.trace;
  ctx.lineWidth = 1;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const o of plates) {
    const x = tr.offX + o.minX * tr.scale;
    const y = tr.offY + (tr.bedY - o.maxY) * tr.scale;
    const w = (o.maxX - o.minX) * tr.scale;
    const h = (o.maxY - o.minY) * tr.scale;
    // Below three pixels an outline stops being one: the 1px stroke spills over
    // on both sides and the tiles merge into one area. One dot per plate
    // instead — that still reads as a grid.
    if (Math.round(w) < 3 || Math.round(h) < 3) {
      ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
      continue;
    }
    // Half pixels as in preview.js, otherwise the 1px stroke blurs.
    ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5,
                   Math.round(w) - 1, Math.round(h) - 1);

    const text = o.value.toFixed(3);
    const size = fitFont(ctx, text, w, h);
    if (size >= MIN_FONT_PX) {
      ctx.font = size + 'px ' + FONT_FAMILY;
      ctx.fillText(text, x + w / 2, y + h / 2);
    }
  }
}

/**
 * `plan` comes from buildEmPlan() in em/objects.js, `specs` from
 * doc.thumbnails. Returns finished comment lines, empty if nothing could be
 * drawn.
 */
export function emThumbnailLines(plan, specs) {
  const plates = platesOf(plan);
  if (plates.length === 0) return [];
  // fitTransform() works on segments; a tile's diagonal spans the same
  // bounding box as the tile itself.
  const boxes = plates.map(o => ({ x1: o.minX, y1: o.minY, x2: o.maxX, y2: o.maxY }));
  return renderThumbnails(specs, (ctx, s) => {
    const tr = fitTransform(boxes, s.w, s.h);
    if (!tr) return false;
    drawPlates(ctx, plates, tr);
    return true;
  });
}
