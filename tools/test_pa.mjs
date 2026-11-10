/**
 * Single cases of the pressure advance test that the sample files do not show:
 * the external perimeter speed as a percentage, as 0 (auto) and missing, the
 * acceleration fallbacks, both volumetric caps, a slow pattern.
 * Works on the versioned CORE One fixture, so it also runs without References/.
 * Run: node tools/test_pa.mjs
 */
import { readFileSync } from 'node:fs';
import { parseDocument } from '../js/settings.js';
import { buildPlan } from '../js/pa/pattern.js';

const FIXTURE = readFileSync(new URL('fixtures/coreone_min.gcode', import.meta.url), 'utf8');
const INPUT = { paStart: 0, paEnd: 0.05, paStep: 0.005, anchor: 'frame', layers: 5, printNumbers: true };

let failed = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name.padEnd(50) + (detail || ''));
  if (!ok) failed++;
}

/** The fixture with settings replaced; `null` removes a setting. */
function load(overrides = {}) {
  let text = FIXTURE;
  for (const [key, value] of Object.entries(overrides)) {
    const line = new RegExp('^; ' + key + ' = .*$', 'gm');
    text = text.replace(line, value === null ? '' : '; ' + key + ' = ' + value);
  }
  const doc = parseDocument(text);
  return { doc, plan: buildPlan(doc, INPUT) };
}

const codes = plan => plan.issues.map(i => i.code);
const near = (a, b) => Math.abs(a - b) < 1e-6;

{
  const { doc, plan } = load();
  check('external speed taken as set', doc.speeds.externalPerimeter === 200 &&
    doc.speeds.externalPerimeterSource === 'external_perimeter_speed', doc.speeds.externalPerimeter);
  check('pattern runs at the external speed', plan.speeds.pattern === 200, plan.speeds.pattern);
  check('external acceleration taken as set', doc.accel.print === 2500 &&
    doc.accel.printSource === 'external_perimeter_acceleration', doc.accel.print);
  check('no warning on the fixture', !codes(plan).some(c => c === 'W3' || c === 'W10'), codes(plan).join(' '));
  check('no error on the fixture', !plan.issues.some(i => i.level === 'error'), codes(plan).join(' '));
}

{
  const { doc } = load({ external_perimeter_speed: '80%' });
  check('percentage relative to perimeter_speed', near(doc.speeds.externalPerimeter, 120),
    doc.speeds.externalPerimeter);
}

{
  const { doc, plan } = load({ external_perimeter_speed: '0' });
  check('0 is auto: max_print_speed', doc.speeds.externalPerimeter === 300 &&
    doc.speeds.externalPerimeterSource === 'max_print_speed (auto)', doc.speeds.externalPerimeter);
  const capped = 22 / (0.2 * (0.45 - 0.2 * (1 - Math.PI / 4)));
  check('auto capped by volumetric flow', near(plan.speeds.pattern, capped), plan.speeds.pattern.toFixed(2));
  check('cap reported as W3', codes(plan).includes('W3'));
}

{
  const { doc } = load({ external_perimeter_speed: '0', max_print_speed: null });
  check('auto without max_print_speed: perimeter_speed', doc.speeds.externalPerimeter === 150 &&
    doc.speeds.externalPerimeterSource === 'perimeter_speed', doc.speeds.externalPerimeter);
}

{
  const { doc, plan } = load({ external_perimeter_speed: null });
  check('missing external speed: perimeter_speed', doc.speeds.externalPerimeter === 150 &&
    doc.speeds.externalPerimeterSource === 'perimeter_speed', doc.speeds.externalPerimeter);
  check('missing external speed is no error', !plan.issues.some(i => i.level === 'error'));
}

{
  const { doc } = load({ first_layer_speed: '50%' });
  check('first layer percentage of the external speed', near(doc.speeds.firstLayer, 100),
    doc.speeds.firstLayer);
}

{
  const { doc } = load({ external_perimeter_acceleration: '0' });
  check('acceleration 0: perimeter_acceleration', doc.accel.print === 3000 &&
    doc.accel.printSource === 'perimeter_acceleration', doc.accel.print);
}

{
  const { doc } = load({ external_perimeter_acceleration: '0', perimeter_acceleration: '0',
                         default_acceleration: '4000' });
  check('both 0: default_acceleration', doc.accel.print === 4000 &&
    doc.accel.printSource === 'default_acceleration', doc.accel.print);
}

{
  const { doc } = load({ max_volumetric_speed: '10' });
  check('lower volumetric cap wins', doc.material.maxVolumetric === 10 &&
    doc.material.maxVolumetricSource === 'max_volumetric_speed', doc.material.maxVolumetric);
}

{
  const { doc, plan } = load({ filament_max_volumetric_speed: '0', external_perimeter_speed: '0' });
  check('no volumetric cap: unlimited', doc.material.maxVolumetric === 0, doc.material.maxVolumetric);
  check('unlimited leaves the speed alone', plan.speeds.pattern === 300, plan.speeds.pattern);
}

{
  const { plan } = load({ external_perimeter_speed: '50' });
  check('slow pattern reported as W10', codes(plan).includes('W10'), codes(plan).join(' '));
}

console.log('');
console.log(failed ? failed + ' check(s) failed' : 'all checks passed');
process.exit(failed ? 1 : 0);
