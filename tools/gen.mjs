/**
 * Development helper: generates test gcode from a slicer file without a
 * browser, so the modules can be checked against real files.
 *
 *   node tools/gen.mjs <in.gcode> <out.gcode> [paStart paEnd paStep anchor layers numbers]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseDocument, describeDocument } from '../js/settings.js';
import { buildPlan } from '../js/pa/pattern.js';
import { generate } from '../js/pa/generator.js';

const [, , inFile, outFile,
  paStart = '0', paEnd = '0.08', paStep = '0.0025',
  anchor = 'frame', layers = '5', numbers = '1'] = process.argv;

if (!inFile || !outFile) {
  console.error('Usage: node tools/gen.mjs <in.gcode> <out.gcode> [paStart paEnd paStep anchor layers numbers]');
  process.exit(2);
}

const doc = parseDocument(readFileSync(inFile, 'utf8'));
const input = {
  paStart: +paStart, paEnd: +paEnd, paStep: +paStep,
  anchor, layers: +layers, printNumbers: numbers === '1',
};
const plan = buildPlan(doc, input);

console.log('--- detected ---');
for (const r of describeDocument(doc)) {
  console.log('  ' + r.name.padEnd(22) + r.value.padEnd(26) + '(' + r.source + ')');
}
console.log('--- Plan ---');
console.log('  PA values     ', plan.paValues.length, '[' + plan.paValues.slice(0, 4).join(', ') + ' ... ' +
  plan.paValues[plan.paValues.length - 1] + ']');
console.log('  layers        ', plan.layerCount, plan.layers.map(l => l.z).join(' '));
console.log('  numbering     ', 'layer ' + plan.numberingLayer);
console.log('  size          ', plan.geom.sizeX.toFixed(2) + ' x ' + plan.geom.sizeY.toFixed(2) + ' mm');
console.log('  origin        ', plan.geom.startX.toFixed(2) + ', ' + plan.geom.startY.toFixed(2));
console.log('  fits on bed   ', plan.fitsOnBed);
for (const i of plan.issues) console.log('  [' + i.level + ' ' + i.code + '] ' + i.text);

if (plan.hasError) { console.error('\nERROR: the plan has errors, nothing generated.'); process.exit(1); }

const res = generate(plan);
writeFileSync(outFile, res.lines.join('\n') + '\n');
console.log('--- generated ---');
console.log('  lines total   ', res.stats.gcodeLines, '(pattern ' + res.patternLines.length + ')');
console.log('  Filament      ', res.stats.filamentMm.toFixed(1) + ' mm = ' + res.stats.filamentCm3.toFixed(2) + ' cm3  (extrusion only, no unretracts)');
console.log('  retract/unret ', res.stats.retracts + '/' + res.stats.unretracts);
console.log('  ExcludeObject ', res.stats.patchedExcludeObject ? 'replaced' : 'not present');
console.log('  ->', outFile);
