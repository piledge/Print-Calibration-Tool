/**
 * The path from source file to EM output, the same one the UI takes. Shared by
 * `gen_em.mjs` and `em_digest.mjs` so the command line reports the same
 * messages and values as the browser.
 */
import { readGcodeText } from './bgcode.mjs';
import { parseDocument } from '../js/settings.js';
import { buildEmPlan } from '../js/em/objects.js';
import { generateEm } from '../js/em/generator.js';

/**
 * @param {string} inFile  .gcode or .bgcode
 * @param {string} [rename] "old:new" — renames an object so the skip path can
 *   be exercised without a dedicated sample file
 * @param {{from:number,to:number,fine:boolean}} [range] value range and step;
 *   if absent, the whole plate in half-percent steps
 * @returns {{plan:object, issues:object[], res:object|null}}
 *   `res` is null when an error was reported.
 */
export async function buildEm(inFile, rename, range) {
  let text = await readGcodeText(inFile);
  if (rename && rename.indexOf(':') !== -1) {
    const [from, to] = rename.split(':');
    text = text.split(from).join(to);
  }
  const raw = text.split(/\r?\n/);
  const doc = parseDocument(text);
  const plan = buildEmPlan(raw, doc, range || {});
  return { plan, issues: plan.issues,
           res: plan.hasError ? null : generateEm(plan) };
}

/** Prints the issues; returns true if an error was among them. */
export function reportIssues(issues) {
  for (const i of issues) console.log('  [' + i.level + ' ' + i.code + '] ' + i.text);
  return issues.some(i => i.level === 'error');
}
