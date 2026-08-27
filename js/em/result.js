/**
 * em/result.js — what to do after the print. Unlike pressure advance, the
 * extrusion multiplier is not a firmware but a slicer setting: the value
 * belongs in the filament profile the file is sliced with.
 */

/** `value` is the chosen multiplier (absolute), `profile` the file's own. */
function advice(doc, value, profile) {
  const name = doc.material.filamentName;
  const rows = [
    { title: 'PrusaSlicer: Filament → Advanced → Extrusion multiplier', code: value.toFixed(3) },
  ];
  if (name) rows.push({ title: 'filament profile', code: name });
  // M221 acts on the already sliced file, which carries the profile value, so
  // the live probe has to divide it out.
  const p = Number.isFinite(profile) && profile > 0 ? profile : 1;
  rows.push({ title: 'console', code: 'M221 S' + (value / p * 100).toFixed(1) });
  return rows;
}

/** The text shown in the result box and copied from it. */
export function adviceText(doc, value, profile) {
  const rows = advice(doc, value, profile);
  const width = rows.reduce((w, r) => Math.max(w, r.title.length), 0);
  return rows.map(r => r.title.padEnd(width) + '   ' + r.code).join('\n');
}
