/**
 * tt/result.js — the step after the print. The temperature is a slicer setting:
 * the value belongs in the filament profile the file was sliced with.
 */

function advice(doc, temp) {
  const rows = [
    { title: 'PrusaSlicer: Filament → Temperature → Other layers', code: String(temp) },
  ];
  // If the profile ran the first layer hotter, that offset is kept.
  const first = doc.material.firstLayerTemperature;
  const sliced = doc.material.temperature;
  const offset = Number.isFinite(first) && Number.isFinite(sliced) ? first - sliced : 0;
  rows.push({ title: 'PrusaSlicer: Filament → Temperature → First layer',
              code: String(temp + offset) });
  if (doc.material.filamentName) {
    rows.push({ title: 'filament profile', code: doc.material.filamentName });
  }
  rows.push({ title: 'console', code: 'M104 S' + temp });
  return rows;
}

/** The text shown in the result field and copied from there. */
export function adviceText(doc, temp) {
  const rows = advice(doc, temp);
  const width = rows.reduce((w, r) => Math.max(w, r.title.length), 0);
  return rows.map(r => r.title.padEnd(width) + '   ' + r.code).join('\n');
}
