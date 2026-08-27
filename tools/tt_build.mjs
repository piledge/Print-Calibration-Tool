/**
 * The path from source file to TT output, the same one the UI takes. Shared by
 * `gen_tt.mjs` and `tt_digest.mjs` so the command line reports the same
 * messages and values as the browser.
 */
import { readGcodeText } from './bgcode.mjs';
import { parseDocument } from '../js/settings.js';
import { buildTtPlan } from '../js/tt/layers.js';
import { generateTt } from '../js/tt/generator.js';

/**
 * @param {string} inFile  .gcode or .bgcode
 * @param {number} [from]  lowest temperature, default 180
 * @param {number} [to]    highest temperature, default 260
 * @returns {{plan:object, issues:object[], res:object|null}}
 */
export async function buildTt(inFile, from, to) {
  const text = await readGcodeText(inFile);
  const raw = text.split(/\r?\n/);
  const doc = parseDocument(text);
  const plan = buildTtPlan(raw, doc, {
    from: Number.isFinite(from) ? from : 180,
    to: Number.isFinite(to) ? to : 260,
  });
  const failed = plan.issues.some(i => i.level === 'error');
  return { plan, issues: plan.issues, res: failed ? null : generateTt(plan) };
}

/** Prints the issues; returns true if an error was among them. */
export function reportIssues(issues) {
  for (const i of issues) console.log('  [' + i.level + ' ' + i.code + '] ' + i.text);
  return issues.some(i => i.level === 'error');
}
