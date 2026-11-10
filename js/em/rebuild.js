/**
 * em/rebuild.js — makes every plate solid whatever top shells the profile has,
 * from the sliced layers themselves: bottom, two infill layers to decouple the
 * first layer squish, the layer above them, then the two solid layers above
 * that in turn up to the top layer.
 */

import { issue } from '../settings.js';
import { MOVE_RE, codeOf, moveE, eModeChange, g92E, axisValue, setAxis,
         formatCoord } from '../gcode.js';

const LAYER_MARK = ';LAYER_CHANGE';
const Z_MARK = ';Z:';
const TYPE_MARK = ';TYPE:';
const PLAIN_SOLID = new Set(['External perimeter', 'Perimeter', 'Solid infill', 'Gap fill']);
const FAN_RE = /^M10[67](?![0-9])/i;
const XO_START = /^EXCLUDE_OBJECT_START\s+NAME\s*=\s*(\S+)/i;
const XO_END = /^EXCLUDE_OBJECT_END\b/i;
const BARE_NUM = /^;\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s*$/;

/** Each layer with what a copy of it expects to find when it starts. */
function scanLayers(raw, absoluteE) {
  const layers = [];
  let cur = null, type = null, fan = null, x = null, y = null;
  let absE = absoluteE, e = 0;
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i].trim();
    if (t === LAYER_MARK) {
      cur = { start: i, z: NaN, types: new Set(), absE, eIn: e, x, y, fan };
      layers.push(cur);
      continue;
    }
    if (t.startsWith(TYPE_MARK)) type = t.slice(TYPE_MARK.length);
    else if (cur && t.startsWith(Z_MARK) && Number.isNaN(cur.z)) cur.z = parseFloat(t.slice(Z_MARK.length));
    if (t === '' || t.charAt(0) === ';') continue;

    if (FAN_RE.test(t)) { fan = t; continue; }
    const mode = eModeChange(t);
    if (mode !== null) { absE = mode; continue; }
    const g92 = g92E(t);
    if (g92 !== null) { e = g92; continue; }
    if (!MOVE_RE.test(t)) continue;

    const mv = moveE(t);
    if (mv) {
      const delta = absE ? mv.e - e : mv.e;
      e = absE ? mv.e : e + mv.e;
      if (cur && type && delta > 0 && mv.hasXY) cur.types.add(type);
    }
    const code = codeOf(t);
    x = axisValue(code, 'X') ?? x;
    y = axisValue(code, 'Y') ?? y;
  }
  return layers;
}

const isPlainSolid = l => l.types.has('Solid infill') && [...l.types].every(t => PLAIN_SOLID.has(t));

/** Source layer index for every layer of the rebuilt plate, or a reason why not. */
function layerOrder(layers) {
  const sparse = layers.flatMap((l, i) => l.types.has('Internal infill') ? [i] : []);
  if (!sparse.length) return {};
  const first = sparse[0], last = sparse[sparse.length - 1];
  if (first === 0) return { refused: 'it has no bottom layers' };
  if (first === last) return { refused: 'it needs at least 2 infill layers' };

  const top = layers.length - 1;
  const pair = [last + 2, last + 3];
  if (!layers[top].types.has('Top solid infill')) return { refused: 'the last layer is no top surface' };
  if (pair[1] >= top) return { refused: 'it needs at least 4 top solid layers' };
  if (!pair.every(i => isPlainSolid(layers[i]))) {
    return { refused: 'the two layers above the bridge are not plain solid infill' };
  }
  const step = layers[2].z - layers[1].z;
  if (layers.slice(2).some((l, k) => !(Math.abs(l.z - layers[k + 1].z - step) < 1e-4))) {
    return { refused: 'the layer height is variable' };
  }

  const order = layers.slice(0, first).map((_, i) => i);
  order.push(last - 1, last, last + 1);
  const fill = [];
  for (let slot = top - 1; slot >= order.length; slot--) fill.unshift(pair.find(p => p % 2 === slot % 2));
  return { order: order.concat(fill, top) };
}

/** How PrusaSlicer writes a height into a comment: 0.6, not .6. */
const commentZ = z => String(Math.round(z * 1e4) / 1e4);

function shiftZ(line, t, layerZ, dz) {
  if (t.startsWith(Z_MARK)) return Z_MARK + commentZ(layerZ + dz);
  const bare = BARE_NUM.exec(t);
  if (bare) return Math.abs(parseFloat(bare[1]) - layerZ) < 1e-6 ? ';' + commentZ(layerZ + dz) : line;
  if (!MOVE_RE.test(t)) return line;
  const code = codeOf(line);
  const z = axisValue(code, 'Z');
  return z === null ? line : setAxis(code, 'Z', formatCoord(z + dz)) + line.slice(code.length);
}

const dropXY = line => codeOf(line).replace(/\s+[XY]-?[\d.]+/g, '') + line.slice(codeOf(line).length);

/**
 * `raw` rebuilt, with `layers` naming the source layer (1-based) of each layer;
 * `layers` is null when the file stays as it is.
 */
export function rebuildPlates(raw, doc) {
  const layers = scanLayers(raw, !doc.printer.relativeE);
  const { order, refused } = layerOrder(layers);
  if (!order) {
    return { raw, layers: null,
             issues: refused ? [issue('warning', 'W53', 'Plates left as sliced: ' + refused + '.')] : [] };
  }

  const out = raw.slice(0, layers[0].start);
  let fan = layers[0].fan, open = null;
  order.forEach((src, slot) => {
    const l = layers[src];
    const end = src + 1 < layers.length ? layers[src + 1].start : raw.length;
    const dz = layers[slot].z - l.z;
    // A layer that does not follow its own predecessor finds the head, the E
    // counter, the fan and the open object where another layer left them.
    const seam = slot > 0 && order[slot - 1] !== src - 1;
    if (seam && l.absE) out.push('G92 E' + formatCoord(l.eIn));
    if (seam && l.fan && l.fan !== fan) { out.push(l.fan); fan = l.fan; }
    let approaching = seam, closing = seam;

    for (let i = l.start; i < end; i++) {
      const t = raw[i].trim();
      let line = dz ? shiftZ(raw[i], t, l.z, dz) : raw[i];
      if (closing && XO_END.test(t)) {
        if (open) out.push('EXCLUDE_OBJECT_END NAME=' + open);
        open = null;
        continue;
      }
      const start = XO_START.exec(t);
      if (start) { open = start[1]; closing = false; } else if (XO_END.test(t)) open = null;
      if (FAN_RE.test(t)) fan = t;
      if (approaching && MOVE_RE.test(t)) {
        const mv = moveE(t);
        const code = codeOf(t);
        if (mv && mv.hasXY) approaching = false;
        else if (!mv && axisValue(code, 'X') === l.x && axisValue(code, 'Y') === l.y) line = dropXY(line);
      }
      out.push(line);
    }
  });
  return { raw: out, layers: order.map(i => i + 1), issues: [] };
}
