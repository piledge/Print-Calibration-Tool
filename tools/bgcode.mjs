/**
 * Makes .bgcode readable for the command line tools.
 *
 * Workaround for the Emscripten glue: vendor/bgcode.js starts with
 *
 *   var Module = typeof Module != "undefined" ? Module : {}
 *
 * Outside a browser the hoisted local `var Module` already exists (holding
 * undefined) when the check runs, so the global the browser path sets in
 * index.html is never seen. Without our Module there is no
 * onRuntimeInitialized — the module then silently never initializes, with no
 * error and no abort. That is why the glue is run through `new Function` in a
 * frame that Module (and the require/__dirname Emscripten expects) is passed
 * into.
 *
 * wasmBinary is supplied because otherwise the asynchronous wasm load goes
 * nowhere and the Node process ends before anything happens.
 */
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const vendorDir = join(here, '..', 'vendor');

let modulePromise = null;

function loadBgcodeModule() {
  if (modulePromise) return modulePromise;
  modulePromise = new Promise((resolve, reject) => {
    let src, wasmBinary;
    try {
      src = readFileSync(join(vendorDir, 'bgcode.js'), 'utf8');
      wasmBinary = readFileSync(join(vendorDir, 'bgcode.wasm'));
    } catch (e) {
      reject(new Error('bgcode decoder not found in ' + vendorDir + ': ' + e.message));
      return;
    }
    const Module = {
      wasmBinary,
      onRuntimeInitialized: () => resolve(Module),
      onAbort: what => reject(new Error('bgcode decoder aborted: ' + what)),
    };
    try {
      new Function('Module', 'require', '__dirname', src)(Module, require, vendorDir);
    } catch (e) {
      reject(new Error('bgcode decoder failed to start: ' + e.message));
    }
  });
  // A failed attempt must not linger as a poisoned cache.
  modulePromise.catch(() => { modulePromise = null; });
  return modulePromise;
}

/**
 * @param {ArrayBuffer|Uint8Array|Buffer} buffer
 * @returns {Promise<string>} ASCII gcode
 */
export async function bgcodeToAscii(buffer) {
  const mod = await loadBgcodeModule();
  if (typeof mod.bgcode2ascii_and_verify !== 'function') {
    throw new Error('the bgcode decoder is missing bgcode2ascii_and_verify()');
  }
  // The wasm binding wants an ArrayBuffer; Buffer/Uint8Array are usually just a
  // window into a larger pool, so copy exactly that range.
  const arrayBuffer = ArrayBuffer.isView(buffer)
    ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    : buffer;

  let text;
  try {
    text = mod.bgcode2ascii_and_verify(arrayBuffer);
  } catch (e) {
    // Depending on the failure, Emscripten throws strings, numbers or Errors.
    throw new Error('could not decode the .bgcode data: ' + (e && e.message ? e.message : String(e)));
  }
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('the bgcode decoder returned no data. Is the file complete?');
  }
  return text;
}

/**
 * Reads a slicer file as ASCII gcode; .bgcode goes through the decoder.
 * @param {string} path
 * @returns {Promise<string>}
 */
export async function readGcodeText(path) {
  if (/\.bgcode$/i.test(path)) {
    return bgcodeToAscii(await readFile(path));
  }
  return readFile(path, 'utf8');
}
