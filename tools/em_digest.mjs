import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { findObjects } from '../js/em/objects.js';
import { buildEm, reportIssues } from './em_build.mjs';

const [, , inFile, outFile, digestFile, rename, from, to, coarse] = process.argv;
if (!inFile || !outFile || !digestFile) {
  console.error('Usage: node tools/em_digest.mjs <in.gcode|in.bgcode> <out.gcode> <digest.txt> [old:new] [from] [to] [coarse]');
  process.exit(2);
}

const fine = coarse !== 'coarse';
const range = (from || to || !fine)
  ? { from: parseFloat(from), to: parseFloat(to), fine } : undefined;
const { plan, issues, res } = await buildEm(inFile, rename, range);
if (!res) { reportIssues(issues); process.exit(1); }

const body = res.lines.join('\n');
writeFileSync(outFile, body);

// Detect again on the output: the extrusion reported per object is what the
// printer really feeds, so its ratio against the input must match the factor.
const after = findObjects(body.split('\n'), plan.doc);
const byName = new Map(after.objects.map(o => [o.name, o]));

const L = [];
const pad = (s, n) => String(s).padEnd(n);
L.push('source        ' + basename(inFile)
  + (rename && rename.indexOf(':') !== -1 ? '  [renamed ' + rename + ']' : ''));
L.push('flavor        ' + plan.flavor + (plan.absoluteE ? ' absolute-E' : ' relative-E'));
L.push('profile       ' + plan.profile.toFixed(3));
L.push('range         ' + plan.from.toFixed(3) + ' … ' + plan.to.toFixed(3)
  + (plan.fine ? '' : ', whole percent only'));
L.push('objects       ' + plan.objects.length + ' (' + res.stats.active + ' printed, '
  + res.stats.removed + ' removed)');
L.push('lines         ' + plan.raw.length + ' -> ' + res.stats.gcodeLines
  + ' (+' + res.stats.inserted + ' inserted, -' + res.stats.droppedLines + ' dropped, '
  + res.stats.changedLines + ' E values changed, ' + res.stats.seamFixes + ' seam fixes)');
if (Number.isFinite(res.stats.timeSec)) {
  L.push('time          ' + Math.round(res.stats.timeSec / 60) + ' min');
}
L.push('extrusion     ' + plan.objects.reduce((a, o) => a + o.eIn, 0).toFixed(2) + ' -> '
  + after.objects.reduce((a, o) => a + o.eIn, 0).toFixed(2) + ' mm inside objects');
L.push('filament      ' + res.stats.filamentMm.toFixed(2) + ' mm = '
  + res.stats.filamentCm3.toFixed(2) + ' cm3');
L.push('sha256        ' + createHash('sha256').update(body).digest('hex'));
L.push('');
L.push('--- inserted block ---');
const mapFrom = res.lines.indexOf('; >>> print_calibration_tool em map begin');
const mapTo = res.lines.indexOf('; <<< print_calibration_tool em map end');
for (let i = mapFrom; i <= mapTo && i >= 0; i++) L.push(res.lines[i]);
L.push('');
L.push('--- flow per object ---');
L.push(pad('id', 4) + pad('name', 24) + pad('factor', 10) + pad('in [mm]', 12)
  + pad('out [mm]', 12) + 'ratio');
for (const o of plan.objects) {
  const a = byName.get(o.name);
  const ratio = a && o.eIn > 0 ? a.eIn / o.eIn : NaN;
  L.push(pad(o.id, 4) + pad(o.name, 24)
    + pad(o.factor === null ? '-' : o.factor.toFixed(5), 10)
    + pad(o.eIn.toFixed(3), 12)
    + pad(a ? a.eIn.toFixed(3) : '-', 12)
    + (Number.isFinite(ratio) ? ratio.toFixed(5) : '-'));
}
writeFileSync(digestFile, L.join('\n') + '\n');
console.log('  ' + basename(inFile) + ': ' + res.stats.gcodeLines + ' lines, '
  + res.stats.changedLines + ' E values, ' + res.stats.active + ' active objects');
