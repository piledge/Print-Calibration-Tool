/**
 * Development helper for the EM test: generates the output file without a
 * browser, so the modules can be checked against real files.
 *
 *   node tools/gen_em.mjs <in.gcode|in.bgcode> <out.gcode> [from] [to]
 */
import { writeFileSync } from 'node:fs';
import { buildEm, reportIssues } from './em_build.mjs';

const [, , inFile, outFile, from, to] = process.argv;
if (!inFile || !outFile) {
  console.error('Usage: node tools/gen_em.mjs <in.gcode|in.bgcode> <out.gcode> [from] [to]');
  process.exit(2);
}

const range = (from || to) ? { from: parseFloat(from), to: parseFloat(to) } : undefined;
const { plan, issues, res } = await buildEm(inFile, undefined, range);
if (reportIssues(issues)) {
  console.error('\nERROR: nothing generated.');
  process.exit(1);
}
writeFileSync(outFile, res.lines.join('\n'));

const vals = plan.objects.filter(o => !o.skip).map(o => o.value).sort((a, b) => a - b);
console.log('--- detected ---');
console.log('  flavour       ', plan.flavor, plan.absoluteE ? '(absolute E)' : '(relative E)');
console.log('  objects       ', plan.objects.length,
  '(' + res.stats.active + ' printed, ' + res.stats.removed + ' removed)');
console.log('  range         ', plan.from.toFixed(3) + ' … ' + plan.to.toFixed(3));
console.log('  values        ', vals[0] + ' … ' + vals[vals.length - 1]);
console.log('--- generated ---');
console.log('  lines         ', res.stats.gcodeLines, '(' + res.stats.inserted + ' inserted, ' +
  res.stats.droppedLines + ' dropped, ' + res.stats.changedLines + ' E values changed)');
if (res.stats.seamFixes) console.log('  seam fixes    ', res.stats.seamFixes, 'retracts dropped');
if (Number.isFinite(res.stats.timeSec)) {
  console.log('  time          ', (res.stats.timeSec / 60).toFixed(1) + ' min');
}
console.log('  filament      ', res.stats.filamentMm.toFixed(1) + ' mm = ' +
  res.stats.filamentCm3.toFixed(2) + ' cm3');
console.log('  ->', outFile);
