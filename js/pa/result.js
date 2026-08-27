/**
 * result.js — the step after printing: the best chevron number becomes the PA
 * value and the line to enter permanently. The live command comes from the same
 * firmware switch as the test pattern; new here is only where the value belongs.
 */

import { paCommandFactory } from './generator.js';
import { formatPa } from './pattern.js';

/** `doc` is the SourceDocument: firmware, model and tool index. */
function advice(doc, value) {
  const p = doc.printer;
  const v = formatPa(value);
  const live = paCommandFactory(p.flavor, p.model, p.toolIndex);
  const rows = [];

  if (p.flavor === 'klipper') {
    const section = p.toolIndex > 0 ? '[extruder' + p.toolIndex + ']' : '[extruder]';
    rows.push({ title: 'printer.cfg, ' + section, code: 'pressure_advance: ' + v });
    if (live) rows.push({ title: 'console', code: live(v) });
  } else if (p.flavor === 'reprapfirmware') {
    if (live) rows.push({ title: 'config.g', code: live(v) });
  } else if (live) {
    // On Marlin the permanent and the immediate line are identical, so it is
    // listed once, with the place it belongs.
    rows.push({ title: 'PrusaSlicer: Filament → Custom G-code → Start G-code', code: live(v) });
  }
  return rows;
}

/** The text shown in the result field and copied from there. */
export function adviceText(doc, value) {
  const rows = advice(doc, value);
  if (rows.length === 0) return '';
  const width = rows.reduce((w, r) => Math.max(w, r.title.length), 0);
  return rows.map(r => r.title.padEnd(width) + '   ' + r.code).join('\n');
}
