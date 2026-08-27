/**
 * Fingerprint of a TT output. As with the EM test the output is as large as the
 * source, so `tools/golden/` holds no full text but the key figures: band
 * table, base values, line balance, consumption and a SHA-256 over the file.
 *
 *   node tools/tt_digest.mjs <in.gcode|in.bgcode> <out.gcode> <digest.txt> [from] [to]
 */
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { buildTt, reportIssues } from './tt_build.mjs';

const [, , inFile, outFile, digestFile, fromArg, toArg] = process.argv;
if (!inFile || !outFile || !digestFile) {
  console.error('Usage: node tools/tt_digest.mjs <in> <out.gcode> <digest.txt> [from] [to]');
  process.exit(2);
}

const { plan, issues, res } = await buildTt(inFile, Number(fromArg), Number(toArg));
if (!res) { reportIssues(issues); process.exit(1); }

const body = res.lines.join('\n');
writeFileSync(outFile, body);

const p = plan.printed;
const L = [];
L.push('source        ' + basename(inFile));
L.push('range         ' + p[0].temp + ' ... ' + p[p.length - 1].temp + ' C'
  + '  (bands ' + p[0].index + '-' + p[p.length - 1].index + ')');
L.push('flavor        ' + plan.doc.printer.flavor
  + (plan.doc.printer.relativeE ? ' relative-E' : ' absolute-E'));
L.push('source tower  ' + plan.bands.length + ' bands, ' + plan.bandHeight.toFixed(3)
  + ' mm each, ' + plan.height.toFixed(2) + ' mm, ' + plan.layers.length + ' layers');
L.push('base          ' + res.stats.footHeight.toFixed(3) + ' mm, z offset '
  + (-res.stats.zOffset).toFixed(3) + ' mm');
L.push('printed       ' + res.stats.layers + ' layers, ' + res.stats.heightMm.toFixed(3) + ' mm');
L.push('lines         ' + plan.raw.length + ' -> ' + res.stats.gcodeLines);
L.push('time          ' + Math.round(res.stats.timeSec / 60) + ' min'
  + (Number.isFinite(res.stats.silentSec)
    ? ' (' + Math.round(res.stats.silentSec / 60) + ' min silent)' : ''));
L.push('filament      ' + res.stats.filamentMm.toFixed(2) + ' mm = '
  + res.stats.filamentCm3.toFixed(2) + ' cm3');
L.push('stripped temp ' + res.stats.strippedTemp);
L.push('');
L.push('band  temp  source Z            print Z             layers');
for (const b of p) {
  const f = plan.layers[b.first], l = plan.layers[b.last];
  L.push('  ' + String(b.index).padStart(2) + '  ' + b.temp + '  '
    + (f.z.toFixed(3) + '-' + l.z.toFixed(3)).padEnd(20)
    + ((f.z - res.stats.zOffset).toFixed(3) + '-'
       + (l.z - res.stats.zOffset).toFixed(3)).padEnd(20)
    + b.first + '-' + b.last);
}
L.push('');
// The inserted block verbatim: the summary of the rewrite.
const b0 = res.lines.indexOf('; >>> print_calibration_tool tt map begin');
const b1 = res.lines.indexOf('; <<< print_calibration_tool tt map end');
if (b0 >= 0 && b1 > b0) L.push(...res.lines.slice(b0, b1 + 1));
L.push('');
L.push('sha256        ' + createHash('sha256').update(body).digest('hex'));

writeFileSync(digestFile, L.join('\n') + '\n');
console.log('  ' + basename(inFile) + '  ' + p[0].temp + '-' + p[p.length - 1].temp
  + '  ->  ' + digestFile);
