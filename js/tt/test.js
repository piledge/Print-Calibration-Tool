/**
 * tt/test.js — the temperature tower as one test object.
 *
 * The model is fixed (21 bands, 180 to 280 °C in steps of five), so the
 * temperatures do not come from the UI. The only setting is which section is
 * printed: the rest is cut away, the tower pulled onto the bed and given a base.
 */

import { outputFileName } from '../reader.js';
import { formatSpan } from '../gcode.js';
import { replaceThumbnails } from '../settings.js';
import { BANDS, TEMPS, buildTtPlan } from './layers.js';
import { generateTt } from './generator.js';
import { drawTowerPreview, clearTowerPreview, pickBand, labelOf } from './preview.js';
import { ttThumbnailLines } from './thumbnail.js';
import { adviceText } from './result.js';

const el = id => document.getElementById(id);

// One entry is enough: as long as file and range stay the same, so does the
// plan.
let cache = null;

/** The default is the whole tower: first band at the bottom, last at the top. */
const defaultOf = id => id === 'tt-from' ? TEMPS[0] : TEMPS[TEMPS.length - 1];

function fillSelects() {
  for (const id of ['tt-from', 'tt-to']) {
    const sel = el(id);
    if (!sel || sel.options.length) continue;
    const def = defaultOf(id);
    for (const t of TEMPS) {
      const opt = document.createElement('option');
      opt.value = String(t);
      opt.textContent = t + ' °C';
      opt.defaultSelected = t === def;   // the browser keeps this for the reset
      sel.appendChild(opt);
    }
    sel.value = String(def);
  }
}

function summarize(plan, out) {
  const n = plan.printed.length;
  // Without detected bands this is no tower, and "21 bands in the file" would
  // be wrong.
  if (!plan.bands.length) return 'no temperature tower in this file';
  if (!n) return BANDS + ' bands in the file, none of them selected';
  return [
    plan.printed[0].temp + ' … ' + plan.printed[n - 1].temp + ' °C',
    n + (n === 1 ? ' band' : ' bands'),
    out ? out.stats.heightMm.toFixed(2) + ' mm tall' : null,
    // Neither layer count nor base height: both stand in the file's map block,
    // and at 950 px the line would grow to three lines and make the preview
    // above it jump.
  ].filter(Boolean).join(' · ');
}

export const ttTest = {
  id: 'tt',
  legend2: 'Temperature range',
  bestLabel: 'Best band',
  panels: ['tt-template', 'tt-hint-1', 'tt-params', 'tt-hint'],
  storage: true,
  selectionInPreview: true,
  emptyInfo: 'Nothing to show — fix the errors above.',

  wire(onChange) {
    fillSelects();
    for (const id of ['tt-from', 'tt-to']) {
      const sel = el(id);
      if (sel) sel.addEventListener('change', () => onChange(true));
    }

    // Reset means the whole tower again. The default lives in `defaultOf` and
    // nowhere else; the browser holds it per option in `defaultSelected`.
    const btn = el('tt-reset-btn');
    if (btn) {
      btn.title = 'Back to the whole tower, ' + defaultOf('tt-from') + ' … '
        + defaultOf('tt-to') + ' °C';
      btn.addEventListener('click', () => {
        for (const id of ['tt-from', 'tt-to']) {
          const sel = el(id);
          if (sel) for (const opt of sel.options) opt.selected = opt.defaultSelected;
        }
        onChange(true);
      });
    }
  },

  readInput() {
    const num = id => {
      const sel = el(id);
      return sel ? parseInt(sel.value, 10) : NaN;
    };
    return { from: num('tt-from'), to: num('tt-to') };
  },

  applyStored(s) {
    if (!s) return;
    fillSelects();
    for (const [id, key] of [['tt-from', 'from'], ['tt-to', 'to']]) {
      const sel = el(id);
      if (sel && TEMPS.indexOf(s[key]) !== -1) sel.value = String(s[key]);
    }
  },

  build(doc, input) {
    if (cache && cache.doc === doc && cache.from === input.from && cache.to === input.to) {
      return cache.plan;
    }
    const plan = buildTtPlan(doc.raw, doc, input);
    cache = { doc, from: input.from, to: input.to, plan, out: null };
    return plan;
  },

  generate(doc, plan) {
    if (cache && cache.plan === plan && cache.out) return cache.out;
    const out = generateTt(plan);
    if (cache && cache.plan === plan) cache.out = out;
    return out;
  },

  render(canvas, doc, plan, out) {
    drawTowerPreview(canvas, plan);
    if (!out) return summarize(plan, null) + ' — see the messages above.';
    return [
      summarize(plan, out),
      formatSpan(out.stats.timeSec),
      out.stats.filamentMm.toFixed(0) + ' mm filament ('
        + out.stats.filamentCm3.toFixed(2) + ' cm³)',
    ].filter(Boolean).join(' · ');
  },

  clear(canvas, doc) {
    clearTowerPreview(canvas, doc && doc.printer.bed || undefined);
  },

  fileName(doc, plan) {
    const n = plan.printed.length;
    const detail = n ? plan.printed[0].temp + '-' + plan.printed[n - 1].temp : 'empty';
    return outputFileName(doc, 'TT', detail);
  },

  // As in the EM test: the output is the source file, so its preview images are
  // still in there and get replaced rather than inserted. Only here, because
  // rasterizing and encoding have no place in the live loop.
  lines(doc, plan, out, warn) {
    const L = out.lines;
    let blocks = [];
    try {
      blocks = ttThumbnailLines(plan, doc.thumbnails);
    } catch (e) {
      warn('W9', 'Preview images could not be generated, the file keeps the ones '
        + 'written by the slicer: ' + e.message);
    }
    return blocks.length ? replaceThumbnails(L, blocks) : L;
  },

  resultCount(plan) { return plan.printed.length; },

  pick(canvas, ev, plan) { return pickBand(canvas, ev, plan); },

  choiceLabel(plan, index) { return labelOf(plan.printed[index]); },

  advice(doc, plan, index) {
    const band = plan.printed[index];
    return {
      info: 'of ' + plan.printed.length + '  →  band ' + (index + 1),
      text: adviceText(doc, band.temp),
    };
  },
};
