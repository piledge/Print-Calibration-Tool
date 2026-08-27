/**
 * reader.js — file in, file out: reading as ASCII gcode, naming the output,
 * downloading it.
 *
 * `.bgcode` goes through Prusa's libbgcode WASM build, everything else is read
 * as text. From there on there is only one code path.
 */

const WASM_TIMEOUT_MS = 10000;

/**
 * Waits for the Emscripten init promise created in index.html. The extra
 * timeout catches aborts that trigger neither onAbort nor onerror, which would
 * leave the UI stuck in its loading state.
 */
function bgcodeModule() {
  if (typeof window === 'undefined' || !window.bgcodeReady) {
    return Promise.reject(new Error('bgcode module not loaded (vendor/bgcode.js missing?)'));
  }
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(
      'the decoder did not finish loading within ' + (WASM_TIMEOUT_MS / 1000) + ' s')), WASM_TIMEOUT_MS);
  });
  return Promise.race([window.bgcodeReady, timeout]).finally(() => clearTimeout(timer));
}

/** Error carrying a code so that app.js can classify it. */
function coded(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** @returns {Promise<{text:string, fileName:string, wasBinary:boolean}>} */
export async function readGcodeFile(file) {
  const isBinary = /\.bgcode$/i.test(file.name || '');

  if (!isBinary) {
    try {
      return { text: await file.text(), fileName: file.name, wasBinary: false };
    } catch (e) {
      throw coded('E0', 'The file could not be read: ' + (e && e.message ? e.message : String(e)));
    }
  }

  let mod;
  try {
    mod = await bgcodeModule();
  } catch (e) {
    throw coded('E9', 'The .bgcode decoder could not be loaded: ' + e.message);
  }
  if (!mod || typeof mod.bgcode2ascii_and_verify !== 'function') {
    throw coded('E9', 'The bgcode decoder is missing bgcode2ascii_and_verify().');
  }

  let text;
  try {
    const buf = await file.arrayBuffer();
    text = mod.bgcode2ascii_and_verify(buf);
  } catch (e) {
    // Emscripten throws strings, numbers or Error objects, depending on the failure.
    const msg = (e && e.message) ? e.message : String(e);
    throw coded('E9', 'Could not decode the .bgcode file: ' + msg);
  }
  if (typeof text !== 'string' || text.length === 0) {
    throw coded('E9', 'The bgcode decoder returned no data; the file may be incomplete.');
  }
  return { text, fileName: file.name, wasBinary: true };
}

/** Download name: `prefix` names the test (PA, EM, TT), `detail` its parameters. */
export function outputFileName(doc, prefix, detail) {
  const clean = s => String(s || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  const printer = clean(doc.printer.preset) || clean(doc.printer.model)
               || clean(doc.printer.flavor) || 'printer';
  const filament = clean(doc.material.filamentName) || 'filament';
  return (prefix + '_' + printer + '_' + filament + '_' + detail + '.gcode').slice(0, 120);
}

/** Offer the generated lines as a file, without a FileSaver library. */
export function downloadLines(lines, fileName) {
  const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
