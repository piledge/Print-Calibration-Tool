/**
 * tt/thumbnail.js — the preview images for the tower file.
 *
 * The same silhouette as in step 3, but without frame and without the unprinted
 * bands: a preview image shows what comes out. The temperatures fill the space
 * the narrow tower leaves free beside it.
 */

import { FONT_FAMILY } from '../canvas.js';
import { renderThumbnails, MIN_FONT_PX } from '../thumbnail.js';
import { towerLayout, drawTower, labelOf } from './preview.js';

/** Font size at which all labels still fit stacked on top of each other. */
function fitFont(plan, h) {
  return Math.max(0, Math.min(12, Math.floor((h / (plan.printed.length || 1)) * 0.7)));
}

/**
 * @param {object} plan   from buildTtPlan() in tt/layers.js
 * @param {Array<{w:number,h:number,fmt:string}>} specs  from doc.thumbnails
 */
export function ttThumbnailLines(plan, specs) {
  if (!plan.printed || plan.printed.length === 0) return [];
  return renderThumbnails(specs, (ctx, s) => {
    const margin = Math.min(s.w, s.h) < 64 ? 1 : 2;
    const size = fitFont(plan, s.h - 2 * margin);
    const labels = size >= MIN_FONT_PX;
    const font = size + 'px ' + FONT_FAMILY;
    let labelWidth = 0;
    if (labels) {
      ctx.font = font;
      const widest = labelOf(plan.printed[plan.printed.length - 1]);
      labelWidth = ctx.measureText(widest).width;
    }
    const lay = towerLayout(plan, s.w, s.h, { margin, onlyPrinted: true, labels, labelWidth });
    if (!lay) return false;
    drawTower(ctx, plan, lay, { labels, font, onlyPrinted: true, selected: -1 });
    return true;
  });
}
