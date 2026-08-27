/**
 * Checks the QOI encoder and the block format without a browser.
 *
 *   node tools/test_thumbnail.mjs [more-source-file.gcode ...]
 *
 * The decoder here is deliberately written independently from the QOI
 * specification and is first verified against PrusaSlicer's own thumbnails.
 * Only then does it serve as the reference for our encoder.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { encodeQoi, toBase64, thumbnailBlock, fitTransform, quantize } from '../js/thumbnail.js';
import { thumbnailLines } from '../js/pa/thumbnail.js';
import { parseDocument } from '../js/settings.js';
import { buildPlan } from '../js/pa/pattern.js';
import { generate } from '../js/pa/generator.js';
import { parseGcode } from '../js/pa/preview.js';

const VORON = 'References/avent_mount_0.4n_0.2mm_ABS_voron_1h52m.gcode';
// The sliced sample prints are not in the repository. Without them the parts
// that need a real PrusaSlicer file are skipped rather than failed; the
// encoder and block-format checks run either way.
const hasVoron = existsSync(VORON);
let skipped = 0;

let failed = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  ok    ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (detail ? '  — ' + detail : '')); }
}

/* --- independent QOI decoder ---------------------------------------------- */

function decodeQoi(bytes) {
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== 'qoif') throw new Error('magic is "' + magic + '"');
  const u32 = o => (bytes[o] << 24 | bytes[o + 1] << 16 | bytes[o + 2] << 8 | bytes[o + 3]) >>> 0;
  const w = u32(4), h = u32(8);
  if (!(w > 0 && h > 0)) throw new Error('bad size ' + w + 'x' + h);

  const px = new Uint8Array(w * h * 4);
  const index = [];
  for (let k = 0; k < 64; k++) index.push([0, 0, 0, 0]);
  let r = 0, g = 0, b = 0, a = 255, i = 0, p = 14;
  const store = () => { const o = i * 4; px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = a; i++; };

  while (i < w * h) {
    if (p >= bytes.length) throw new Error('stream ended after ' + i + ' of ' + (w * h) + ' pixels');
    const op = bytes[p++];
    if (op === 0xfe) { r = bytes[p++]; g = bytes[p++]; b = bytes[p++]; }
    else if (op === 0xff) { r = bytes[p++]; g = bytes[p++]; b = bytes[p++]; a = bytes[p++]; }
    else if ((op & 0xc0) === 0xc0) {
      const run = (op & 0x3f) + 1;
      if (i + run > w * h) throw new Error('run overruns image');
      for (let k = 0; k < run; k++) store();
      continue;                                   // runs do not fill the index
    }
    else if ((op & 0xc0) === 0x00) { const c = index[op & 0x3f]; r = c[0]; g = c[1]; b = c[2]; a = c[3]; }
    else if ((op & 0xc0) === 0x40) {
      r = (r + ((op >> 4) & 3) - 2) & 255;
      g = (g + ((op >> 2) & 3) - 2) & 255;
      b = (b + (op & 3) - 2) & 255;
    }
    else {                                        // 0x80 — QOI_OP_LUMA
      const dg = (op & 0x3f) - 32, b2 = bytes[p++];
      r = (r + dg + (((b2 >> 4) & 15) - 8)) & 255;
      g = (g + dg) & 255;
      b = (b + dg + ((b2 & 15) - 8)) & 255;
    }
    index[(r * 3 + g * 5 + b * 7 + a * 11) & 63] = [r, g, b, a];
    store();
  }

  const tail = Array.from(bytes.slice(p));
  const wanted = [0, 0, 0, 0, 0, 0, 0, 1];
  const endOk = tail.length === 8 && wanted.every((v, k) => tail[k] === v);
  return { w, h, px, endOk, trailing: tail.length - 8 };
}

/* --- 1) Decoder against PrusaSlicer's own thumbnails ---------------------- */

function readBlocks(path) {
  const lines = readFileSync(path, 'latin1').split(/\r?\n/);
  const blocks = [];
  let cur = null;
  for (const line of lines) {
    let m = /^;\s*(thumbnail(?:_[A-Za-z0-9]+)?)\s+begin\s+(\d+)x(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) { cur = { tag: m[1], w: +m[2], h: +m[3], len: +m[4], data: '' }; continue; }
    if (cur) {
      if (/^;\s*thumbnail(?:_[A-Za-z0-9]+)?\s+end\b/.test(line)) { blocks.push(cur); cur = null; continue; }
      cur.data += line.replace(/^;\s?/, '');
    }
    if (blocks.length && /^\s*[GM]\d/.test(line)) break;
  }
  return blocks;
}

console.log('1) Decoder against PrusaSlicer originals');
const blocks = hasVoron ? readBlocks(VORON) : [];
if (!hasVoron) { skipped++; console.log('  skip  no sample file: ' + VORON); }
else check('thumbnail blocks found in the reference file', blocks.length === 5, blocks.length + ' blocks');
for (const blk of blocks) {
  check('length field correct: ' + blk.tag + ' ' + blk.w + 'x' + blk.h,
        blk.data.length === blk.len, blk.data.length + ' instead of ' + blk.len);
  if (blk.tag !== 'thumbnail_QOI') continue;
  const bytes = Buffer.from(blk.data, 'base64');
  let dec;
  try { dec = decodeQoi(bytes); } catch (e) {
    check('QOI decodable: ' + blk.w + 'x' + blk.h, false, e.message);
    continue;
  }
  check('QOI decoded, dimensions match: ' + blk.w + 'x' + blk.h,
        dec.w === blk.w && dec.h === blk.h, dec.w + 'x' + dec.h);
  check('QOI end marker clean, stream fully consumed: ' + blk.w + 'x' + blk.h,
        dec.endOk && dec.trailing === 0, 'trailing=' + dec.trailing);
  const distinct = new Set();
  for (let k = 0; k < dec.px.length; k += 4) distinct.add(dec.px[k] << 16 | dec.px[k + 1] << 8 | dec.px[k + 2]);
  check('image is not one flat colour: ' + blk.w + 'x' + blk.h, distinct.size > 8, distinct.size + ' colours');
}

/* --- 2) Round trip through our encoder ------------------------------------ */

console.log('\n2) Round trip encodeQoi -> decoder');

function makeImage(w, h, fn) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = fn(x, y), o = (y * w + x) * 4;
    px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = c[3] === undefined ? 255 : c[3];
  }
  return px;
}

// deterministic pseudo-random, so failures are reproducible
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % 256; };

const cases = [
  ['flat colour 200x100 (runs > 62)', 200, 100, () => [20, 26, 18]],
  ['two colours, 1px lines (our case)', 313, 173,
    (x, y) => (x % 7 === 0 || y === 40) ? [142, 209, 74] : [20, 26, 18]],
  ['noise (forces RGB/RGBA)', 64, 64, () => [rnd(), rnd(), rnd(), rnd() > 128 ? 255 : rnd()]],
  ['gradient (forces DIFF/LUMA)', 64, 64, (x, y) => [x * 4 & 255, y * 4 & 255, (x + y) * 2 & 255]],
  ['1x1', 1, 1, () => [1, 2, 3]],
  ['1x1000 narrow', 1, 1000, (x, y) => [y & 255, 0, 0]],
  ['1000x1 wide', 1000, 1, (x) => [0, x & 255, 0]],
  ['wraparound across 0/255', 32, 32, (x, y) => [(x * 250) & 255, (y * 250) & 255, 255 - ((x * 250) & 255)]],
  ['fully transparent', 16, 16, () => [10, 20, 30, 0]],
  ['alpha alternating per pixel', 16, 16, (x, y) => [9, 9, 9, (x + y) % 2 ? 255 : 128]],
];

for (const [name, w, h, fn] of cases) {
  const src = makeImage(w, h, fn);
  const enc = encodeQoi(src, w, h);
  let dec;
  try { dec = decodeQoi(enc); } catch (e) { check(name, false, e.message); continue; }
  let diff = -1;
  for (let k = 0; k < src.length; k++) if (src[k] !== dec.px[k]) { diff = k; break; }
  check(name + '  [' + enc.length + ' B]',
        dec.w === w && dec.h === h && dec.endOk && dec.trailing === 0 && diff === -1,
        diff >= 0 ? 'first difference at byte ' + diff : ('endOk=' + dec.endOk + ' trailing=' + dec.trailing));
}

/* --- 3) Block format ------------------------------------------------------ */

console.log('\n3) Block format and Moonraker compatibility');

const img = makeImage(313, 173, (x, y) => (x % 7 === 0 || y === 40) ? [142, 209, 74] : [20, 26, 18]);
const b64 = toBase64(encodeQoi(img, 313, 173));
const lines = thumbnailBlock(b64, 313, 173, 'QOI');

check('opening line correct', lines[1] === '; thumbnail_QOI begin 313x173 ' + b64.length, lines[1]);
check('closing line correct', lines[lines.length - 2] === '; thumbnail_QOI end', lines[lines.length - 2]);
check('PNG gets no suffix', thumbnailBlock('QUJD', 32, 32, 'PNG')[1] === '; thumbnail begin 32x32 4');
check('every data line starts with "; "', lines.slice(2, -2).every(l => l.startsWith('; ')));
check('no data line longer than 78 characters', lines.slice(2, -2).every(l => l.length <= 80));
check('base64 round trips', Buffer.from(b64, 'base64').toString('base64').replace(/=+$/, '') === b64.replace(/=+$/, ''));

// Moonraker's own regex (metadata.py) applied to our block
const text = lines.join('\n') + '\n';
const mr = /(thumbnail(?:_[A-Za-z0-9]+)?) begin([;/+=\w\s]+?); \1 end/.exec(text);
check('Moonraker regex matches', !!mr);
if (mr) {
  const parts = mr[2].replace(/; /g, '').split(/\r?\n/);
  const head = parts[0].trim().split(/\s+/);
  const data = parts.slice(1, -1).join('');
  check('Moonraker reads the dimensions', head[0] === '313x173', head.join(' '));
  check('Moonraker length check passes', data.length === Number(head[1]),
        data.length + ' instead of ' + head[1]);
  check('Moonraker data decodes to exactly our image',
        Buffer.from(data, 'base64').equals(Buffer.from(b64, 'base64')));
}

/* --- 3b) Transform and quantization --------------------------------------- */

console.log('\n3b) Crop and colour snapping');

{
  const segs = [
    { x1: 100, y1: 50, x2: 190, y2: 50, cat: 'pattern' },
    { x1: 100, y1: 50, x2: 100, y2: 110, cat: 'pattern' },
    { x1: 190, y1: 110, x2: 100, y2: 110, cat: 'anchor' },
  ];
  for (const [w, h] of [[16, 16], [313, 173], [480, 240], [32, 32], [380, 285]]) {
    const tr = fitTransform(segs, w, h);
    const m = Math.min(w, h) < 64 ? 1 : 2;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const s of segs) for (const [x, y] of [[s.x1, s.y1], [s.x2, s.y2]]) {
      const px = tr.offX + x * tr.scale, py = tr.offY + (tr.bedY - y) * tr.scale;
      minX = Math.min(minX, px); maxX = Math.max(maxX, px);
      minY = Math.min(minY, py); maxY = Math.max(maxY, py);
    }
    const inside = minX >= m - 1e-6 && maxX <= w - m + 1e-6 && minY >= m - 1e-6 && maxY <= h - m + 1e-6;
    const centred = Math.abs((minX + maxX) / 2 - w / 2) < 1e-6 && Math.abs((minY + maxY) / 2 - h / 2) < 1e-6;
    const fills = Math.abs(maxX - minX - (w - 2 * m)) < 1e-6 || Math.abs(maxY - minY - (h - 2 * m)) < 1e-6;
    check('crop ' + w + 'x' + h + ' is inside the image, centred, edge to edge',
          inside && centred && fills,
          'x ' + minX.toFixed(2) + '..' + maxX.toFixed(2) + '  y ' + minY.toFixed(2) + '..' + maxY.toFixed(2));
  }
  check('a degenerate pattern gives no absurd scale',
        fitTransform([{ x1: 5, y1: 5, x2: 5, y2: 5, cat: 'pattern' }], 100, 100).scale <= 100);
  check('no segments, no transform', fitTransform([], 100, 100) === null);
}

{
  const px = new Uint8ClampedArray([
    20, 26, 18, 255,        // exactly the background
    26, 32, 24, 255,        // just off it -> background
    142, 209, 74, 255,      // pattern
    63, 107, 38, 255,       // anchor (trace-dim)
    216, 194, 74, 255,      // glyph (trace-alt)
    45, 60, 30, 128,        // faint antialiasing, semi-transparent
  ]);
  quantize(px);
  const at = i => [px[i * 4], px[i * 4 + 1], px[i * 4 + 2], px[i * 4 + 3]];
  const eq = (a, b) => a.every((v, i) => v === b[i]);
  check('background stays background', eq(at(0), [20, 26, 18, 255]));
  check('near miss snaps to background', eq(at(1), [20, 26, 18, 255]));
  check('pattern colour survives', eq(at(2), [142, 209, 74, 255]));
  check('anchor colour survives', eq(at(3), [63, 107, 38, 255]));
  check('glyph colour survives', eq(at(4), [216, 194, 74, 255]));
  check('a faint trace stays visible and turns opaque',
        !eq(at(5), [20, 26, 18, 255]) && px[23] === 255, JSON.stringify(at(5)));
  const colours = new Set();
  for (let i = 0; i < px.length; i += 4) colours.add(px[i] + ',' + px[i + 1] + ',' + px[i + 2]);
  check('at most four colours left', colours.size <= 4, colours.size + ' colours');
}

/* --- 4) Chain through to the finished file -------------------------------- */

console.log('\n4) Chain: pattern -> images -> file -> check_gcode.py');

check('without a DOM thumbnailLines returns an empty list',
      thumbnailLines(['G1 X1 Y1 E1 ; pattern'], {}, [{ w: 16, h: 16, fmt: 'QOI' }]).length === 0);

// Rasterizer for this test only: in the browser the canvas does this, here a
// 1px line suffices, because what is checked is the encoding and file format.
function raster(segments, w, h) {
  const bg = [20, 26, 18], fg = [142, 209, 74];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of segments) {
    x0 = Math.min(x0, s.x1, s.x2); x1 = Math.max(x1, s.x1, s.x2);
    y0 = Math.min(y0, s.y1, s.y2); y1 = Math.max(y1, s.y1, s.y2);
  }
  const m = Math.min(w, h) < 64 ? 1 : 2;
  const dx = Math.max(x1 - x0, 1e-6), dy = Math.max(y1 - y0, 1e-6);
  const sc = Math.min((w - 2 * m) / dx, (h - 2 * m) / dy);
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    px[i * 4] = bg[0]; px[i * 4 + 1] = bg[1]; px[i * 4 + 2] = bg[2]; px[i * 4 + 3] = 255;
  }
  const set = (x, y) => {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const o = (y * w + x) * 4;
    px[o] = fg[0]; px[o + 1] = fg[1]; px[o + 2] = fg[2];
  };
  const ox = (w - dx * sc) / 2 - x0 * sc, oy = (h - dy * sc) / 2;
  for (const s of segments) {
    const ax = ox + s.x1 * sc, ay = oy + (y1 - s.y1) * sc;
    const bx = ox + s.x2 * sc, by = oy + (y1 - s.y2) * sc;
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay))));
    for (let k = 0; k <= n; k++) set(ax + (bx - ax) * k / n, ay + (by - ay) * k / n);
  }
  return px;
}

// Minimal PNG writer, likewise only for the test.
function png(rgba, w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4, d = y * (w * 3 + 1) + 1 + x * 3;
      raw[d] = rgba[o]; raw[d + 1] = rgba[o + 1]; raw[d + 2] = rgba[o + 2];
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
                        chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Further source files (e.g. the unpacked CORE One gcode) as arguments.
const sources = process.argv.slice(2);
if (hasVoron) sources.unshift(VORON);
if (!sources.length) { skipped++; console.log('   skip  no sample file'); }

for (const source of sources) {
  console.log('   ' + source.split('/').pop());
  const doc = parseDocument(readFileSync(source, 'utf8'));
  const plan = buildPlan(doc, { paStart: 0, paEnd: 0.08, paStep: 0.005, anchor: 'frame', layers: 5, printNumbers: true });
  const result = generate(plan);
  const segments = parseGcode(result.patternLines);
  check('segments from the generated pattern', segments.length > 500, segments.length + ' segments');
  check('profile names image sizes', doc.thumbnails.length > 0, JSON.stringify(doc.thumbnails));

  const thumbBlocks = [];
  let total = 0;
  for (const spec of doc.thumbnails) {
    const rgba = raster(segments, spec.w, spec.h);
    const b64 = spec.fmt === 'QOI'
      ? toBase64(encodeQoi(rgba, spec.w, spec.h))
      : png(rgba, spec.w, spec.h).toString('base64');
    total += b64.length;
    thumbBlocks.push(...thumbnailBlock(b64, spec.w, spec.h, spec.fmt));
  }
  console.log('       ' + doc.thumbnails.map(t => t.w + 'x' + t.h + '/' + t.fmt).join(', ') +
              '  =  ' + total + ' Base64-Zeichen in ' + thumbBlocks.length + ' Zeilen');

  const out = tmpdir() + '/pa_thumb_chain.gcode';
  writeFileSync(out, result.head.concat(thumbBlocks, result.start, result.patternLines, result.end).join('\n') + '\n');
  runChecks(out);
}

function runChecks(out) {
const run = spawnSync('python3', ['tools/check_gcode.py', out, '-v'], { encoding: 'utf8' });
const summary = (run.stdout || '').split('\n').filter(l => l.startsWith('Summary')).join('');
check('check_gcode.py confirms the file  [' + summary.trim() + ']', run.status === 0,
      (run.stdout || '').split('\n').filter(l => l.startsWith('FAIL')).join(' | ') || run.stderr);
check('check 12 reports PASS', /PASS\s+thumbnails/.test(run.stdout || ''),
      (run.stdout || '').split('\n').filter(l => /thumbnails/.test(l)).join(' | '));

// Counter-test: a tampered length field must be noticed
const broken = out.replace('.gcode', '_broken.gcode');
writeFileSync(broken, readFileSync(out, 'utf8').replace(/(; thumbnail_QOI begin 313x173 )(\d+)/,
  (m, a, b) => a + (Number(b) + 1)));
const run2 = spawnSync('python3', ['tools/check_gcode.py', broken], { encoding: 'utf8' });
check('a wrong length field is caught', run2.status !== 0 && /FAIL\s+thumbnails/.test(run2.stdout || ''),
      'exit ' + run2.status);

// Counter-test: a missing image must be noticed
const missing = out.replace('.gcode', '_missing.gcode');
const lines2 = readFileSync(out, 'utf8').split('\n');
const from = lines2.findIndex(l => /^; thumbnail(_[A-Za-z0-9]+)? begin /.test(l));
const to = lines2.findIndex((l, i) => i > from && /^; thumbnail(_[A-Za-z0-9]+)? end\b/.test(l));
writeFileSync(missing, lines2.slice(0, from).concat(lines2.slice(to + 1)).join('\n'));
const run3 = spawnSync('python3', ['tools/check_gcode.py', missing], { encoding: 'utf8' });
check('a missing image is caught', run3.status !== 0 && /FAIL\s+thumbnails/.test(run3.stdout || ''),
      'exit ' + run3.status);
}

console.log('\n' + (failed === 0 ? 'all checks passed' : failed + ' check(s) failed')
  + (skipped ? '  (' + skipped + ' section(s) skipped, no sample files)' : ''));
process.exit(failed === 0 ? 0 : 1);
