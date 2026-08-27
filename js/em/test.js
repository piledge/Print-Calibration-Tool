/**
 * em/test.js — the extrusion multiplier test as one object.
 *
 * The whole plate is sliced, the selection happens here: "From" and "To" narrow
 * the range, everything else is cut out of the file — as in the temperature
 * tower. The bed map in step 3 shows which plate sits where.
 */

import { outputFileName } from '../reader.js';
import { formatSpan } from '../gcode.js';
import { replaceThumbnails } from '../settings.js';
import { buildEmPlan, VALUES } from './objects.js';
import { generateEm } from './generator.js';
import { drawPlates, clearPlates, pickPlate } from './preview.js';
import { adviceText } from './result.js';
import { emThumbnailLines } from './thumbnail.js';

const el = id => document.getElementById(id);

// One entry is enough: as long as the same file and the same range are
// selected, the same plan holds.
let cache = null;

/** The default is the whole plate. */
const defaultOf = id => id === 'em-from' ? VALUES[0] : VALUES[VALUES.length - 1];

function fillSelects() {
  for (const id of ['em-from', 'em-to']) {
    const sel = el(id);
    if (!sel || sel.options.length) continue;
    const def = defaultOf(id);
    for (const v of VALUES) {
      const opt = document.createElement('option');
      opt.value = v.toFixed(3);
      opt.textContent = v.toFixed(3);
      opt.defaultSelected = v === def;   // the browser keeps this for the reset
      sel.appendChild(opt);
    }
    sel.value = def.toFixed(3);
  }
}

/** "1 object" instead of "1 objects". */
function count(n, word) {
  return n + ' ' + word + (n === 1 ? '' : 's');
}

export const emTest = {
  id: 'em',
  legend2: 'Value range',
  bestLabel: 'Best plate',
  panels: ['em-template', 'em-hint-1', 'em-plates', 'em-hint'],
  storage: true,
  selectionInPreview: true,    // the chosen tile is highlighted
  emptyInfo: 'Nothing to show — fix the errors above.',

  wire(onChange) {
    fillSelects();
    for (const id of ['em-from', 'em-to']) {
      const sel = el(id);
      if (sel) sel.addEventListener('change', () => onChange(true));
    }
    const btn = el('em-reset-btn');
    if (btn) {
      btn.title = 'Back to the whole plate, ' + defaultOf('em-from').toFixed(3) + ' … '
        + defaultOf('em-to').toFixed(3);
      btn.addEventListener('click', () => {
        for (const id of ['em-from', 'em-to']) {
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
      return sel ? parseFloat(sel.value) : NaN;
    };
    return { from: num('em-from'), to: num('em-to') };
  },

  applyStored(s) {
    if (!s) return;
    fillSelects();
    for (const [id, key] of [['em-from', 'from'], ['em-to', 'to']]) {
      const sel = el(id);
      const v = Number(s[key]);
      if (sel && VALUES.some(x => x === v)) sel.value = v.toFixed(3);
    }
  },

  build(doc, input) {
    if (cache && cache.doc === doc && cache.from === input.from && cache.to === input.to) {
      return cache.plan;
    }
    const plan = buildEmPlan(doc.raw, doc, input);
    cache = { doc, from: input.from, to: input.to, plan, out: null };
    return plan;
  },

  generate(doc, plan) {
    if (cache && cache.plan === plan && cache.out) return cache.out;
    const out = generateEm(plan);
    if (cache && cache.plan === plan) cache.out = out;
    return out;
  },

  render(canvas, doc, plan, out) {
    drawPlates(canvas, plan);
    if (!out) return count(plan.objects.length, 'object') + ' — see the messages above.';
    const o = plan.printed;
    // No dimensions: the plates are spread over the whole build plate, so the
    // enclosing area is always the same, whether one of them is printed or all.
    return [
      o.length ? o[0].value.toFixed(3) + ' … ' + o[o.length - 1].value.toFixed(3) : null,
      out.stats.removed ? o.length + ' of ' + count(plan.objects.length, 'plate')
                        : count(o.length, 'plate'),
      formatSpan(out.stats.timeSec),
      out.stats.filamentMm.toFixed(0) + ' mm filament ('
        + out.stats.filamentCm3.toFixed(2) + ' cm³)',
    ].filter(Boolean).join(' · ');
  },

  clear(canvas, doc) {
    clearPlates(canvas, doc && doc.printer.bed || undefined);
  },

  fileName(doc, plan) {
    const n = plan.printed.length;
    const detail = n
      ? n + 'x_' + plan.printed[0].value.toFixed(3) + '-' + plan.printed[n - 1].value.toFixed(3)
      : 'empty';
    return outputFileName(doc, 'EM', detail);
  },

  // downloadLines appends a line ending itself. The source file ends in a
  // newline, so splitting leaves an empty last element — it has to go here, or
  // the file gains a blank line over the template.
  //
  // Preview images are built only here: rasterising and encoding have no place
  // in the live loop. They replace rather than insert — the source file brings
  // its own. And only after generateEm(), whose map is spliced in by a raw line
  // index that would otherwise shift.
  lines(doc, plan, out, warn) {
    const L = out.lines;
    const trimmed = L.length && L[L.length - 1] === '' ? L.slice(0, -1) : L;
    let blocks = [];
    try {
      blocks = emThumbnailLines(plan, doc.thumbnails);
    } catch (e) {
      warn('W9', 'Preview images could not be generated, the file keeps the ones '
        + 'written by the slicer: ' + e.message);
    }
    return blocks.length ? replaceThumbnails(trimmed, blocks) : trimmed;
  },

  resultCount(plan) { return plan.printed.length; },

  pick(canvas, ev, plan) { return pickPlate(canvas, ev, plan); },

  choiceLabel(plan, index) { return plan.printed[index].value.toFixed(3); },

  advice(doc, plan, index) {
    const o = plan.printed[index];
    return {
      info: 'of ' + plan.printed.length + '  →  plate ' + (index + 1),
      text: adviceText(doc, o.value, plan.profile),
    };
  },
};
