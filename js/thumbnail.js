/**
 * thumbnail.js — the thumbnail parts shared by all tests: QOI encoder, base64,
 * block format, framing, colour snapping, rasterising a single image.
 *
 * What goes into the image each test knows itself (`pa/thumbnail.js`,
 * `em/thumbnail.js`, `tt/thumbnail.js`): its own preview, without bed and grid.
 *
 * The canvas can do PNG itself, QOI it cannot: from 5.1.0 on the Prusa firmware
 * only shows QOI, hence the encoder below.
 */

import { COLOR } from './canvas.js';

const LINE_CHARS = 78;      // base64 characters per line, as PrusaSlicer does it
const BG_TOLERANCE = 16;    // up to here a pixel still counts as background

// Below this font size nothing is labelled: quantize() pulls every touched
// pixel to full brightness, which turns smaller type into a blob. Applies to
// every test that labels.
export const MIN_FONT_PX = 5;

/* --- Colours ------------------------------------------------------------- */

function rgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

const BG = rgb(COLOR.screen);
// Foreground colours only: a touched pixel is always mapped to one of these,
// never to the background (see quantize()). The same table for all tests; each
// uses the tones of its own preview from it.
const PALETTE = [rgb(COLOR.traceDim), rgb(COLOR.trace), rgb(COLOR.traceAlt)];

/* --- QOI encoder --------------------------------------------------------- */

/** RGBA buffer (w*h*4 bytes) -> QOI (https://qoiformat.org/qoi-specification.pdf). */
export function encodeQoi(rgba, w, h) {
  const n = w * h;
  // Worst case: every pixel a QOI_OP_RGBA (5 bytes), plus header and end marker.
  const out = new Uint8Array(14 + n * 5 + 8);
  let o = 0;
  const put = b => { out[o++] = b & 255; };
  const put32 = v => { put(v >>> 24); put(v >>> 16); put(v >>> 8); put(v); };

  put(0x71); put(0x6f); put(0x69); put(0x66);   // "qoif"
  put32(w); put32(h);
  put(4);   // channels — informational only, the stream carries alpha itself
  put(0);   // colour space: sRGB with linear alpha

  const index = new Uint32Array(64);            // pre-filled with {0,0,0,0}
  let pr = 0, pg = 0, pb = 0, pa = 255, run = 0;

  for (let i = 0; i < n; i++) {
    const j = i * 4;
    const r = rgba[j], g = rgba[j + 1], b = rgba[j + 2], a = rgba[j + 3];

    if (r === pr && g === pg && b === pb && a === pa) {
      run++;
      if (run === 62 || i === n - 1) { put(0xc0 | (run - 1)); run = 0; }
    } else {
      if (run > 0) { put(0xc0 | (run - 1)); run = 0; }
      const hash = (r * 3 + g * 5 + b * 7 + a * 11) & 63;
      const px = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
      if (index[hash] === px) {
        put(hash);                               // QOI_OP_INDEX
      } else {
        index[hash] = px;
        if (a === pa) {
          // Differences wrap at the byte boundary — exactly like a signed char.
          let dr = (r - pr) & 255; if (dr > 127) dr -= 256;
          let dg = (g - pg) & 255; if (dg > 127) dg -= 256;
          let db = (b - pb) & 255; if (db > 127) db -= 256;
          const drg = dr - dg, dbg = db - dg;
          if (dr >= -2 && dr <= 1 && dg >= -2 && dg <= 1 && db >= -2 && db <= 1) {
            put(0x40 | ((dr + 2) << 4) | ((dg + 2) << 2) | (db + 2));    // QOI_OP_DIFF
          } else if (dg >= -32 && dg <= 31 && drg >= -8 && drg <= 7 && dbg >= -8 && dbg <= 7) {
            put(0x80 | (dg + 32)); put(((drg + 8) << 4) | (dbg + 8));    // QOI_OP_LUMA
          } else {
            put(0xfe); put(r); put(g); put(b);                          // QOI_OP_RGB
          }
        } else {
          put(0xff); put(r); put(g); put(b); put(a);                    // QOI_OP_RGBA
        }
      }
    }
    pr = r; pg = g; pb = b; pa = a;
  }

  put(0); put(0); put(0); put(0); put(0); put(0); put(0); put(1);        // end marker
  return out.slice(0, o);
}

/* --- Base64 -------------------------------------------------------------- */

/** Bytes → base64, in chunks: otherwise fromCharCode blows the argument limit. */
export function toBase64(bytes) {
  let s = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + step, bytes.length)));
  }
  return btoa(s);
}

/* --- Block format -------------------------------------------------------- */

/**
 * A thumbnail as a gcode comment block, in the form PrusaSlicer writes and both
 * Moonraker and the Prusa firmware expect.
 *
 * The number in the header is the count of base64 characters, not of bytes —
 * Moonraker silently discards the image if it disagrees.
 */
export function thumbnailBlock(b64, w, h, fmt) {
  const tag = fmt === 'PNG' ? 'thumbnail' : 'thumbnail_' + fmt;
  const out = [';', '; ' + tag + ' begin ' + w + 'x' + h + ' ' + b64.length];
  for (let i = 0; i < b64.length; i += LINE_CHARS) {
    out.push('; ' + b64.slice(i, i + LINE_CHARS));
  }
  out.push('; ' + tag + ' end', ';');
  return out;
}

/* --- Rasterising --------------------------------------------------------- */

/**
 * Maps the segments onto w×h pixels, centred and keeping the aspect ratio.
 * Same shape as the preview transform, so that drawSegments() fits.
 */
export function fitTransform(segments, w, h) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of segments) {
    if (s.x1 < x0) x0 = s.x1; if (s.x2 < x0) x0 = s.x2;
    if (s.x1 > x1) x1 = s.x1; if (s.x2 > x1) x1 = s.x2;
    if (s.y1 < y0) y0 = s.y1; if (s.y2 < y0) y0 = s.y2;
    if (s.y1 > y1) y1 = s.y1; if (s.y2 > y1) y1 = s.y2;
  }
  if (!Number.isFinite(x0) || !Number.isFinite(y0)) return null;

  const margin = Math.min(w, h) < 64 ? 1 : 2;
  // Lower bound 1 mm: a degenerate pattern must not produce an absurd scale and
  // with it a line width of millions of pixels.
  const dx = Math.max(x1 - x0, 1), dy = Math.max(y1 - y0, 1);
  const scale = Math.min((w - 2 * margin) / dx, (h - 2 * margin) / dy);
  if (!(scale > 0)) return null;

  return {
    scale,
    offX: (w - dx * scale) / 2 - x0 * scale,
    offY: (h - dy * scale) / 2,
    bedY: y1,
  };
}

/**
 * Snap to the palette. Two reasons: antialiasing would otherwise produce
 * hundreds of tones, which multiplies the QOI size (every new tone a 4-byte
 * chunk) — and a touched pixel must never fall back to background, or the 16×16
 * icon would come out empty.
 */
export function quantize(data) {
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    data[i + 3] = 255;
    if (Math.abs(r - BG[0]) <= BG_TOLERANCE &&
        Math.abs(g - BG[1]) <= BG_TOLERANCE &&
        Math.abs(b - BG[2]) <= BG_TOLERANCE) {
      data[i] = BG[0]; data[i + 1] = BG[1]; data[i + 2] = BG[2];
      continue;
    }
    let best = PALETTE[0], bestD = Infinity;
    for (const c of PALETTE) {
      const d = (r - c[0]) * (r - c[0]) + (g - c[1]) * (g - c[1]) + (b - c[2]) * (b - c[2]);
      if (d < bestD) { bestD = d; best = c; }
    }
    data[i] = best[0]; data[i + 1] = best[1]; data[i + 2] = best[2];
  }
}

/* --- A single image ------------------------------------------------------ */

/**
 * Rasterises one image at the requested size and returns it as base64. Needs a
 * DOM; `draw` receives the context with the background already filled and
 * returns false when there is nothing to draw, so no image is produced.
 */
function renderThumbnail(spec, draw) {
  const canvas = document.createElement('canvas');
  // Deliberately without devicePixelRatio: the firmware looks for exact sizes.
  canvas.width = spec.w;
  canvas.height = spec.h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = COLOR.screen;
  ctx.fillRect(0, 0, spec.w, spec.h);
  if (draw(ctx, spec) === false) return null;

  const img = ctx.getImageData(0, 0, spec.w, spec.h);
  quantize(img.data);
  if (spec.fmt === 'QOI') return toBase64(encodeQoi(img.data, spec.w, spec.h));

  ctx.putImageData(img, 0, 0);
  const url = canvas.toDataURL('image/png');
  const comma = url.indexOf(',');
  return comma > 0 ? url.slice(comma + 1) : null;
}

/**
 * The image list of a test: one block per requested size, `specs` from
 * doc.thumbnails. `draw` paints the content; the rest is shared — checking the
 * size list, backing out without a DOM (Node has no canvas, so a command line
 * run produces no images) and wrapping it into comment blocks.
 *
 * @returns {string[]} finished comment lines, empty if nothing could be made
 */
export function renderThumbnails(specs, draw) {
  if (!Array.isArray(specs) || specs.length === 0) return [];
  if (typeof document === 'undefined') return [];
  const out = [];
  for (const spec of specs) {
    const b64 = renderThumbnail(spec, draw);
    if (b64) out.push(...thumbnailBlock(b64, spec.w, spec.h, spec.fmt));
  }
  return out;
}
