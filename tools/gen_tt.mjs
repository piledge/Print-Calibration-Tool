/**
 * Development helper for the temperature tower: generates the output file
 * without a browser, so the modules can be checked against real files. No
 * thumbnails are produced (no canvas under Node).
 *
 *   node tools/gen_tt.mjs <in.gcode|in.bgcode> <out.gcode> [from] [to]
 */
import { writeFileSync } from 'node:fs';
import { buildTt, reportIssues } from './tt_build.mjs';

const [, , inFile, outFile, fromArg, toArg] = process.argv;
if (!inFile || !outFile) {
  console.error('Usage: node tools/gen_tt.mjs <in.gcode|in.bgcode> <out.gcode> [from] [to]');
  process.exit(2);
}

const { plan, issues, res } = await buildTt(inFile, Number(fromArg), Number(toArg));
if (reportIssues(issues) || !res) {
  console.error('\nERROR: nothing generated.');
  process.exit(1);
}
writeFileSync(outFile, res.lines.join('\n'));

const p = plan.printed;
console.log('--- detected ---');
console.log('  firmware      ', plan.doc.printer.flavor,
  plan.doc.printer.relativeE ? '(relative E)' : '(absolute E)');
console.log('  bands         ', plan.bands.length, 'x', plan.bandHeight.toFixed(3), 'mm,',
  'tower', plan.height.toFixed(2), 'mm');
console.log('  layers        ', plan.layers.length,
  '(' + plan.doc.geometry.firstLayerHeight + ' / ' + plan.doc.geometry.layerHeight + ' mm)');
console.log('--- generated ---');
console.log('  range         ', p[0].temp + ' … ' + p[p.length - 1].temp + ' °C,',
  p.length, 'bands, band', p[0].index + '-' + p[p.length - 1].index);
console.log('  tower         ', res.stats.heightMm.toFixed(2), 'mm,', res.stats.layers,
  'layers, base', res.stats.footHeight.toFixed(2), 'mm, Z offset',
  (-res.stats.zOffset).toFixed(2), 'mm');
if (res.stats.topCap) {
  console.log('  top cap       ', res.stats.topCap, 'layers copied from the top of the source');
}
console.log('  lines         ', res.stats.gcodeLines, '(source', plan.raw.length + ')');
console.log('  time          ', (res.stats.timeSec / 60).toFixed(0), 'min');
console.log('  filament      ', res.stats.filamentMm.toFixed(1) + ' mm = ' +
  res.stats.filamentCm3.toFixed(2) + ' cm3');
console.log('  ->', outFile);
