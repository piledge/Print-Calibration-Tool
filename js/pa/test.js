/**
 * pa/test.js — the pressure advance test as a single object.
 * app.js knows only this contract, not the internals; the step 2 controls
 * belong to the test and are wired up here.
 */

import { outputFileName } from '../reader.js';
import { formatSpan } from '../gcode.js';
import { buildPlan, formatPa } from './pattern.js';
import { generate } from './generator.js';
import { drawPreview, clearPreview, pickIndex } from './preview.js';
import { thumbnailLines } from './thumbnail.js';
import { adviceText } from './result.js';

const el = id => document.getElementById(id);

const ui = {};
function fields() {
  if (!ui.paStart) {
    ui.paStart = el('pa-start'); ui.paEnd = el('pa-end'); ui.paStep = el('pa-step');
    ui.anchor = el('anchor'); ui.layers = el('layers'); ui.printNumbers = el('print-numbers');
    ui.resetBtn = el('reset-btn');
  }
  return ui;
}

/**
 * Fixed decimals: three for the PA range, four for the increment (the internal
 * resolution). A spinner step is normalised in the input event already — the
 * change event arrives a frame later, and until then the browser's "0.001"
 * would stand in the field and flicker visibly. Typing carries inputType
 * "insertText" and is left alone until the field is left.
 */
function attachFormat(node, minDigits, allowZero) {
  const format = () => {
    const v = parseFloat(node.value);
    if (!Number.isFinite(v) || v < 0) return;
    if (v === 0 && !allowZero) return;       // increment 0: keep the error message readable
    // Go to the internal resolution (four digits), then cut trailing zeros
    // down to the minimum: pads 0.08 -> 0.080 without rounding away a finer
    // typed value (0.0225 stays 0.0225).
    let text = v.toFixed(4);
    while (text.length - text.indexOf('.') - 1 > minDigits && text.endsWith('0')) {
      text = text.slice(0, -1);
    }
    if (text !== node.value) node.value = text;
  };
  node.addEventListener('input', ev => {
    if (!ev.inputType || ev.inputType === 'insertReplacementText') format();
  });
  node.addEventListener('change', format);
  format();                                   // normalise stored values right away
}

export const paTest = {
  id: 'pa',
  legend2: 'Test parameters',
  bestLabel: 'Best line',
  panels: ['pa-template', 'pa-hint-1', 'pa-params', 'pa-hint'],
  storage: true,
  selectionInPreview: false,   // the pattern view does not depend on the selection
  emptyInfo: 'No pattern — fix the errors above.',

  wire(onChange) {
    const f = fields();
    for (const node of [f.paStart, f.paEnd, f.paStep, f.layers]) {
      node.addEventListener('input', () => onChange(false));
    }
    for (const node of [f.anchor, f.printNumbers]) {
      node.addEventListener('change', () => onChange(true));
    }
    attachFormat(f.paStart, 3, true);   // 0.025, 0.080 — finer typed values survive
    attachFormat(f.paEnd, 3, true);
    attachFormat(f.paStep, 4, false);   // 0.0025 — full internal resolution

    // Defaults sit in the HTML as value/checked, the browser keeps them in
    // defaultValue/defaultChecked — no second list that could drift apart.
    f.resetBtn.addEventListener('click', () => {
      for (const node of [f.paStart, f.paEnd, f.paStep, f.layers]) {
        node.value = node.defaultValue;
      }
      for (const option of f.anchor.options) option.selected = option.defaultSelected;
      f.printNumbers.checked = f.printNumbers.defaultChecked;
      onChange(true);
    });
  },

  readInput() {
    const f = fields();
    return {
      paStart: parseFloat(f.paStart.value),
      paEnd: parseFloat(f.paEnd.value),
      paStep: parseFloat(f.paStep.value),
      anchor: f.anchor.value,
      layers: parseInt(f.layers.value, 10),
      printNumbers: f.printNumbers.checked,
    };
  },

  applyStored(s) {
    const f = fields();
    if (typeof s.paStart === 'number') f.paStart.value = s.paStart;
    if (typeof s.paEnd === 'number') f.paEnd.value = s.paEnd;
    if (typeof s.paStep === 'number') f.paStep.value = s.paStep;
    if (typeof s.layers === 'number') f.layers.value = s.layers;
    if (['frame', 'layer', 'none'].indexOf(s.anchor) !== -1) f.anchor.value = s.anchor;
    if (typeof s.printNumbers === 'boolean') f.printNumbers.checked = s.printNumbers;
  },

  build(doc, input) { return buildPlan(doc, input); },

  generate(doc, plan) { return generate(plan); },

  render(canvas, doc, plan, out) {
    if (!out) { this.clear(canvas, doc); return this.emptyInfo; }
    drawPreview(canvas, out.patternLines, plan);
    const v = plan.paValues;
    return [
      formatPa(v[0]) + ' … ' + formatPa(v[v.length - 1]),
      v.length + (v.length === 1 ? ' value' : ' values'),
      plan.geom.sizeX.toFixed(1) + ' × ' + plan.geom.sizeY.toFixed(1) + ' mm',
      formatSpan(out.stats.timeSec),
      out.stats.filamentMm.toFixed(0) + ' mm filament ('
        + out.stats.filamentCm3.toFixed(2) + ' cm³)',
    ].filter(Boolean).join(' · ');
  },

  clear(canvas, doc) {
    clearPreview(canvas, doc && doc.printer.bed || undefined);
  },

  fileName(doc, plan) {
    const i = plan.input;
    return outputFileName(doc, 'PA', i.paStart + '-' + i.paEnd + '-' + i.paStep);
  },

  /**
   * Preview images are built only here: rasterising and encoding cost more time
   * than the whole rebuild and have no place in the live loop. On failure the
   * download goes out without them.
   */
  lines(doc, plan, out, warn) {
    let thumbs = [];
    try {
      thumbs = thumbnailLines(out.patternLines, plan, doc.thumbnails);
    } catch (e) {
      warn('W9', 'Preview images could not be generated, the file is written without them: ' + e.message);
    }
    return out.head.concat(thumbs, out.start, out.patternLines, out.end);
  },

  resultCount(plan) { return plan.paValues.length; },

  pick(canvas, ev, plan) { return pickIndex(canvas, ev, plan); },

  choiceLabel(plan, index) { return formatPa(plan.paValues[index]); },

  advice(doc, plan, index) {
    const value = plan.paValues[index];
    return {
      info: 'of ' + plan.paValues.length + '  →  line ' + (index + 1),
      text: adviceText(doc, value) || 'No advice for this firmware.',
    };
  },
};
