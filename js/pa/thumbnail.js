/**
 * pa/thumbnail.js — preview images for the test file.
 *
 * The source file's images show the sliced model and are dropped while reading
 * (settings.js). New ones showing the test pattern are drawn here, in exactly
 * the sizes and formats the slicer profile names (`; thumbnails = 16x16/QOI, …`).
 *
 * Same drawing as the step 3 preview, only without bed and grid. QOI encoder,
 * block format and framing live in `js/thumbnail.js`, the EM test needs them too.
 */

import { parseGcode, drawSegments } from './preview.js';
import { fitTransform, renderThumbnails } from '../thumbnail.js';

/**
 * `plan` supplies the line widths, `specs` come from doc.thumbnails. Returns
 * ready-made comment lines, empty if nothing could be rendered.
 */
export function thumbnailLines(patternLines, plan, specs) {
  const segments = parseGcode(patternLines);
  if (segments.length === 0) return [];
  return renderThumbnails(specs, (ctx, s) => {
    const tr = fitTransform(segments, s.w, s.h);
    if (!tr) return false;
    drawSegments(ctx, segments, tr, plan, {});       // no bed, no alarm colour
    return true;
  });
}
