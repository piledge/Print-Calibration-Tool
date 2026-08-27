/**
 * generator.js — turns a PatternPlan into the finished test gcode.
 * Drawing state lives in an Emitter instance, not in module variables.
 * Knows no DOM.
 */

import { GEOM, formatPa, round } from './pattern.js';
import { rewriteStats, parseDuration } from '../gcode.js';

const OBJECT_NAME = 'pa_calibration_test';

// Bounds of the part we generate ourselves; everything outside comes unchanged
// from the slicer file. They also give a checker a region to judge.
const BODY_BEGIN = '; >>> print_calibration_tool pattern begin';
const BODY_END   = '; <<< print_calibration_tool pattern end';

/* ------------------------------------------------------- Firmware switch */

/** Returns a function that turns a PA value into the matching gcode command. */
export function paCommandFactory(flavor, model, tool) {
  const t = Number(tool) || 0;
  switch ((flavor || '').trim()) {
    case 'klipper':
      return v => 'SET_PRESSURE_ADVANCE ADVANCE=' + v + (t > 0 ? ' EXTRUDER=extruder' + t : '');
    case 'reprapfirmware':
      return v => 'M572 D' + t + ' S' + v;
    case 'marlin':
      return v => 'M900 K' + v;
    case 'marlin2':
      // With input shaping Prusa moved from linear advance (M900) to pressure
      // advance (M572). The listed models are the legacy cases; everything else
      // - COREONE included - gets M572.
      return /^(XL|XL2|XL5|MK4|MINI)$/.test(model || '')
        ? v => 'M900 K' + v
        : v => 'M572 S' + v;
    default:
      return null;
  }
}

/* --------------------------------------------------------------- Emitter */

/**
 * Duration of a move with a trapezoidal profile. Standstill at both ends is
 * assumed — close to reality here, because the chevron tip is a 90-degree
 * reversal where the machine nearly stops anyway.
 *
 * Units: len in mm, v in mm/s, a in mm/s^2 (a = 0 means unlimited).
 */
function moveTime(len, v, a) {
  if (!(len > 0) || !(v > 0)) return 0;
  if (!(a > 0)) return len / v;
  const dAccel = (v * v) / (2 * a);          // distance needed to reach v
  return len >= 2 * dAccel
    ? 2 * (v / a) + (len - 2 * dAccel) / v
    : 2 * Math.sqrt(len / a);                // triangular, v is never reached
}

class Emitter {
  constructor(plan) {
    this.plan = plan;
    this.out = [];
    // One timestamp per output line, so progress can be inserted afterwards
    // without a second generator run.
    this.stamp = [];
    this.time = 0;
    this.accel = 0;
    this.accelTravel = 0;
    this.x = 0; this.y = 0; this.z = 0;
    this.retracted = false;
    this.hopped = false;
    this.eTotal = 0;
    this.retractCount = 0;
    this.unretractCount = 0;
    const d = plan.doc.material.filamentDiameter;
    this.filArea = Math.PI * Math.pow(d / 2, 2);
    this.fTravel = Math.round(plan.speeds.travel * 60);
    this.fTravelZ = Math.round(plan.speeds.travelZ * 60);
  }

  put(s) { this.out.push(s); this.stamp.push(this.time); }
  comment(s) { this.put('; ' + s); }
  addTime(len, v, a) { this.time += moveTime(len, v, a); }

  /** Cross-section "rectangle + circle" as in Ellis. */
  extrusionFor(len, h, w) {
    const area = (w - h) * h + Math.PI * Math.pow(h / 2, 2);
    return len * area / this.filArea * this.plan.doc.material.extrusionMultiplier;
  }

  drawTo(x, y, o) {
    const len = Math.hypot(x - this.x, y - this.y);
    if (len < 1e-9) return;
    // Never extrude while retracted; that way the approach needs no
    // precautionary unretract, which would leave a blob on the first line.
    if (this.retracted) this.retract('+');
    const e = round(this.extrusionFor(len, o.h, o.w), 5);
    this.eTotal += e;
    this.addTime(len, o.speed, this.accel);
    this.put('G1 X' + round(x, 4) + ' Y' + round(y, 4) +
             ' E' + e + ' F' + Math.round(o.speed * 60) + ' ; ' + o.tag);
    this.x = x; this.y = y;
  }

  moveTo(x, y, o) {
    o = o || {};
    const len = Math.hypot(x - this.x, y - this.y);
    if (len < 1e-9) return;
    const doRetract = o.retract !== false && len > GEOM.minTravelForRetract;
    if (doRetract) this.retract('-', o.hop !== false);
    this.addTime(len, this.plan.speeds.travel, this.accelTravel || this.accel);
    this.put('G0 X' + round(x, 4) + ' Y' + round(y, 4) + ' F' + this.fTravel);
    this.x = x; this.y = y;
    if (doRetract) this.retract('+');
  }

  moveToZ(z) {
    this.addTime(Math.abs(z - this.z), this.plan.speeds.travelZ, this.accel);
    this.put('G0 Z' + round(z, 3) + ' F' + this.fTravelZ);
    this.z = z;
    this.hopped = false;
  }

  retract(dir, hop) {
    const r = this.plan.doc.retract;
    const fw = this.plan.doc.printer.firmwareRetract;
    if (hop === undefined) hop = r.lift > 0;
    if (dir === '-') {
      if (!this.retracted && (r.length > 0 || fw)) {
        this.addTime(r.length, r.speed, 0);
        this.put(fw ? 'G10 ; retract'
                    : 'G1 E-' + round(r.length, 5) + ' F' + Math.round(r.speed * 60) + ' ; retract');
        this.retracted = true;
        this.retractCount++;
      }
      if (hop && !this.hopped && r.lift > 0) {
        this.addTime(r.lift, this.plan.speeds.travelZ, this.accel);
        this.put('G0 Z' + round(this.z + r.lift, 3) + ' F' + this.fTravelZ);
        this.hopped = true;
      }
    } else {
      if (this.hopped) {
        this.addTime(r.lift, this.plan.speeds.travelZ, this.accel);
        this.put('G0 Z' + round(this.z, 3) + ' F' + this.fTravelZ);
        this.hopped = false;
      }
      if (this.retracted) {
        this.addTime(r.length + r.extra, r.deretractSpeed, 0);
        this.put(fw ? 'G11 ; unretract'
                    : 'G1 E' + round(r.length + r.extra, 5) + ' F' + Math.round(r.deretractSpeed * 60) + ' ; unretract');
        this.retracted = false;
        this.unretractCount++;
      }
    }
  }

  /* ------------------------------------------------------- Drawing routines */

  /** Rectangular rings. (x,y,w,h) is the centre line of the outermost ring. */
  drawRings(x, y, w, h, perims, spacing, o) {
    for (let i = 0; i < perims; i++) {
      const ix = x + i * spacing, iy = y + i * spacing;
      const iw = w - 2 * i * spacing, ih = h - 2 * i * spacing;
      if (iw <= 0 || ih <= 0) break;
      this.moveTo(ix, iy);
      this.drawTo(ix + iw, iy, o);
      this.drawTo(ix + iw, iy + ih, o);
      this.drawTo(ix, iy + ih, o);
      this.drawTo(ix, iy, o);
    }
  }

  /**
   * 45° diagonal infill inside a rectangle, alternating back and forth (which
   * saves the return travels). Lines of the form y = x + c.
   */
  fillDiagonal(x, y, w, h, spacing, o) {
    const x0 = x, x1 = x + w, y0 = y, y1 = y + h;
    if (w <= 0 || h <= 0) return;
    const step = spacing * Math.SQRT2;
    if (!(step > 0)) return;      // otherwise the loop never terminates
    let flip = false;
    for (let c = y0 - x1 + step; c < y1 - x0 - 1e-9; c += step) {
      const xa = Math.max(x0, y0 - c);
      const xb = Math.min(x1, y1 - c);
      if (xb - xa < 1e-6) continue;
      const pa = [xa, xa + c], pb = [xb, xb + c];
      const from = flip ? pb : pa, to = flip ? pa : pb;
      this.moveTo(from[0], from[1]);
      this.drawTo(to[0], to[1], o);
      flip = !flip;
    }
  }

  /** Filled area: rings plus diagonal infill that overlaps the innermost ring. */
  drawFilledBox(x, y, w, h, perims, spacing, lineWidth, o) {
    this.drawRings(x, y, w, h, perims, spacing, o);
    const inset = (perims - 1) * spacing + lineWidth * (1 - GEOM.encroachment);
    this.fillDiagonal(x + inset, y + inset, w - 2 * inset, h - 2 * inset, spacing, o);
  }
}

/* ----------------------------------------------------------------- Glyphs */

/** Stroke font, ported from Ellis' drawNumber. Digits grow in +Y. */
const GLYPHS = {
  '0': ['bl', 'right', 'right', 'up', 'left', 'left', 'down'],
  '1': ['bl', 'right', 'right'],
  '2': ['bl', 'up', 'right', 'down', 'right', 'up'],
  '3': ['bl', 'up', 'right', 'down', 'mup', 'right', 'down'],
  '4': ['ul', 'right', 'right', 'mleft', 'down', 'left'],
  '5': ['ul', 'down', 'right', 'up', 'right', 'down'],
  '6': ['ul', 'down', 'right', 'right', 'up', 'left', 'down'],
  '7': ['bl', 'up', 'right', 'right'],
  '8': ['bl', 'right', 'right', 'up', 'left', 'left', 'down', 'mright', 'up'],
  '9': ['br', 'up', 'left', 'left', 'down', 'right', 'up'],
  '.': ['br', 'dot'],
};

function drawLabel(em, x, y, text, o) {
  const S = GEOM.glyphSegLength;
  let adv = 0;
  for (const ch of text) {
    const seg = GLYPHS[ch];
    if (!seg) continue;
    for (const cmd of seg) {
      switch (cmd) {
        case 'bl': em.moveTo(x, y + adv); break;
        case 'br': em.moveTo(x + 2 * S, y + adv); break;
        case 'ul': em.moveTo(x, y + adv + S); break;
        case 'up':    em.drawTo(em.x, em.y + S, o); break;
        case 'down':  em.drawTo(em.x, em.y - S, o); break;
        case 'right': em.drawTo(em.x + S, em.y, o); break;
        case 'left':  em.drawTo(em.x - S, em.y, o); break;
        case 'mup':    em.moveTo(em.x, em.y + S); break;
        case 'mright': em.moveTo(em.x + S, em.y); break;
        case 'mleft':  em.moveTo(em.x - S, em.y); break;
        case 'dot':    em.drawTo(em.x - GEOM.glyphDotSize, em.y, o); break;
      }
    }
    adv += (ch === '1' || ch === '.') ? GEOM.glyphNarrowSpacing : GEOM.glyphSpacing;
  }
}

/* ------------------------------------------- Progress, start/end block */

/** Inserts M73 progress lines, driven by the emitter's timestamps. */
function insertProgress(out, stamp, total, silentFactor) {
  if (!(total > 0)) return out.slice();
  const lines = [];
  let nextPct = 0;
  for (let i = 0; i < out.length; i++) {
    const pct = Math.min(100, Math.floor(stamp[i] / total * 100));
    if (pct >= nextPct) {
      const rem = Math.ceil((total - stamp[i]) / 60);
      lines.push('M73 P' + pct + ' R' + Math.max(0, rem));
      if (silentFactor > 0) {
        lines.push('M73 Q' + pct + ' S' + Math.max(0, Math.ceil(rem * silentFactor)));
      }
      nextPct = pct + 2;
    }
    lines.push(out[i]);
  }
  return lines;
}

/**
 * Replaces the object definition with the rectangle of our pattern and brackets
 * the pattern in EXCLUDE_OBJECT_START/END (decision F).
 */
function patchStartEnd(plan, stats) {
  const g = plan.geom;
  const px0 = round(g.startX, 3), py0 = round(g.startY, 3);
  const px1 = round(g.startX + g.sizeX, 3), py1 = round(g.startY + g.sizeY, 3);
  const poly = '[[' + px0 + ',' + py0 + '],[' + px1 + ',' + py0 + '],[' +
                      px1 + ',' + py1 + '],[' + px0 + ',' + py1 + ']]';
  const start = [];
  let replaced = false;
  for (const l of plan.doc.startLines) {
    if (l.indexOf('EXCLUDE_OBJECT_DEFINE') !== -1) {
      if (!replaced) {
        start.push("EXCLUDE_OBJECT_DEFINE NAME='" + OBJECT_NAME + "'" +
          ' CENTER=' + round(g.startX + g.sizeX / 2, 3) + ',' + round(g.startY + g.sizeY / 2, 3) +
          ' POLYGON=' + poly);
        replaced = true;
      }
      continue;                     // further definitions of the old model are dropped
    }
    start.push(l);
  }
  if (replaced) start.push("EXCLUDE_OBJECT_START NAME='" + OBJECT_NAME + "'");
  const startOut = stats ? rewriteStats(start, stats) : start;

  // Moonraker and Mainsail read objects_info for the cancel-object list; left
  // alone it would list the object of the source file.
  let end = plan.doc.endLines.map(l =>
    /^;\s*objects_info\s*=/.test(l)
      ? '; objects_info = {"objects":[{"name":"' + OBJECT_NAME + '","polygon":' + poly + '}]}'
      : l);
  if (stats) end = rewriteStats(end, stats);
  if (replaced) end.unshift("EXCLUDE_OBJECT_END NAME='" + OBJECT_NAME + "'");
  return { start: startOut, end, patchedExcludeObject: replaced };
}

/* ------------------------------------------------------------ Header block */

function header(plan, stats) {
  const d = plan.doc, g = plan.geom;
  const accel = plan.accel || { print: 0, firstLayer: 0, restore: 0 };
  const L = [
    '; ============================================================',
    '; Pressure Advance calibration pattern',
    '; generated by Print Calibration Tool (Ellis-style chevron pattern)',
    '; ============================================================',
    '; bed = ' + plan.bed.x + 'x' + plan.bed.y,
    '; first_layer_height = ' + plan.firstLayerHeight,
    '; layer_height = ' + plan.layerHeight,
    '; layers = ' + plan.layerCount,
    '; anchor = ' + plan.anchor,
    '; print_numbers = ' + (plan.printNumbers ? 1 : 0),
    '; pa_start = ' + formatPa(plan.paValues[0]),
    '; pa_end = ' + formatPa(plan.paValues[plan.paValues.length - 1]),
    '; pa_step = ' + formatPa(plan.input.paStep),
    '; pa_values = ' + plan.paValues.map(formatPa).join(','),
    '; relative_e = ' + (d.printer.relativeE ? 1 : 0),
    '; gcode_flavor = ' + d.printer.flavor,
    '; extrusion_width = ' + round(plan.lineWidth, 4),
    '; anchor_width = ' + round(plan.anchorLineWidth, 4),
    '; filament_diameter = ' + d.material.filamentDiameter,
    '; extrusion_multiplier = ' + d.material.extrusionMultiplier,
    '; acceleration_print = ' + Math.round(accel.print),
    '; acceleration_first_layer = ' + Math.round(accel.firstLayer),
    '; acceleration_restore = ' + Math.round(accel.restore),
    '; pattern_size = ' + round(g.sizeX, 2) + 'x' + round(g.sizeY, 2) + ' mm',
    '; pattern_origin = ' + round(g.startX, 2) + ',' + round(g.startY, 2),
    '; speed_pattern = ' + round(plan.speeds.pattern, 1) + ' mm/s',
    '; speed_first_layer = ' + round(plan.speeds.first, 1) + ' mm/s',
  ];
  if (stats && Number.isFinite(stats.timeSec)) {
    L.push('; estimated_time_s = ' + Math.round(stats.timeSec));
    L.push('; filament_mm = ' + round(stats.filamentMm, 2));
  }
  L.push('; ------------------------------------------------------------');
  return L;
}

/* ------------------------------------------------------------ Main routine */

/**
 * `lines` is the complete file, `patternLines` only the generated part — the
 * preview draws that one so the start block does not pollute it.
 */
export function generate(plan) {
  // `renderable` instead of `hasError`: a pattern that merely does not fit on
  // the bed is generated and drawn anyway (overhang in red). The download stays
  // blocked; app.js decides that via hasError.
  if (!plan.renderable) throw new Error('generate() was called on a plan that cannot be built.');

  const d = plan.doc, g = plan.geom;
  const pa = paCommandFactory(d.printer.flavor, d.printer.model, d.printer.toolIndex);
  if (!pa) throw new Error('Firmware "' + d.printer.flavor + '" is not supported.');

  const em = new Emitter(plan);
  const setPa = (v, why) => {
    em.put(pa(formatPa(v)) + ' ; ' + why);
  };

  // Set acceleration explicitly so the test runs under the profile's
  // conditions. Without it whatever the start macro left behind applies - on
  // the Voron 10000 mm/s^2 from CLEAN_NOZZLE instead of the profile's 3000.
  const isKlipper = d.printer.flavor === 'klipper';
  const accel = plan.accel || { print: 0, firstLayer: 0, travel: 0, restore: 0 };
  let lastAccel = null;
  em.accelTravel = accel.travel || 0;
  const setAccel = (v, why) => {
    const a = Math.round(v);
    if (!(a > 0) || a === lastAccel) return;
    lastAccel = a;
    em.accel = a;
    em.put((isKlipper
      ? 'SET_VELOCITY_LIMIT ACCEL=' + a
      : 'M204 P' + a + (accel.travel > 0 ? ' T' + Math.round(accel.travel) : '')) + ' ; ' + why);
  };

  const fanCommand = percent => 'M106 S' + Math.round(percent * 2.55) + ' ; fan';
  /** Centre of the three-wall group of chevron j — reference for digits and ticks. */
  const wallCenterX = j => g.patternStartX + j * g.patternPitch
                         + ((GEOM.wallCount - 1) / 2) * plan.lineSpacingAngle;

  /* --- preparation --- */
  em.put(BODY_BEGIN);
  em.put('G21 ; millimeters');
  em.put('G90 ; absolute positioning');
  em.put('M83 ; relative extrusion');
  em.put('G92 E0');
  em.put(fanCommand(plan.layers[0] ? plan.layers[0].fan : 0));
  setAccel(accel.firstLayer, 'acceleration for the test');

  /* --- approach --- */
  em.retract('-', false);
  em.moveToZ(GEOM.zLift);
  em.moveTo(g.patternStartX, g.patternStartY, { retract: false, hop: false });
  em.moveToZ(plan.firstLayerHeight);
  // deliberately no unretract: the first drawing move takes care of it

  setPa(plan.paValues[0], 'start value');
  // Mainsail/Fluidd show layer progress from this; the command belongs to
  // Klipper's print_stats and exists even without Mainsail macros.
  if (isKlipper) em.put('SET_PRINT_STATS_INFO TOTAL_LAYER=' + plan.layers.length);

  /* --- drawing steps of one layer ------------------------------------- */

  // Layer markers in PrusaSlicer's form, so gcode viewers get a layer slider.
  const openLayer = layer => {
    em.put(';LAYER_CHANGE');
    em.put(';Z:' + layer.z);
    em.put(';HEIGHT:' + round(layer.height, 3));
    if (isKlipper) em.put('SET_PRINT_STATS_INFO CURRENT_LAYER=' + layer.index);
    if (layer.index > 1) em.moveToZ(layer.z);
    // Layer 1 already has fan and acceleration from the preparation.
    if (layer.index > 1 && layer.fan !== plan.layers[layer.index - 2].fan) {
      em.put(fanCommand(layer.fan));
    }
    setAccel(layer.index === 1 ? accel.firstLayer : accel.print,
             layer.index === 1 ? 'first layer acceleration' : 'print acceleration');
  };

  const drawAnchor = layer => {
    const o = { h: layer.height, w: plan.anchorLineWidth, speed: layer.speed, tag: 'anchor' };
    em.comment('anchor ' + plan.anchor);
    if (plan.anchor === 'layer') {
      em.put(';TYPE:Solid infill');
      em.drawFilledBox(g.box.x, g.box.y, g.box.w, g.box.h,
        GEOM.anchorPerimeters, plan.lineSpacingAnchor, plan.anchorLineWidth, o);
    } else {
      em.put(';TYPE:Perimeter');
      em.drawRings(g.box.x, g.box.y, g.box.w, g.box.h,
        GEOM.anchorPerimeters, plan.lineSpacingAnchor, o);
    }
    if (g.tab) {
      em.comment('number tab');
      em.put(';TYPE:Solid infill');
      em.drawFilledBox(g.tab.x, g.tab.y, g.tab.w, g.tab.h,
        GEOM.anchorPerimeters, plan.lineSpacingAnchor, plan.anchorLineWidth,
        { h: layer.height, w: plan.anchorLineWidth, speed: layer.speed, tag: 'tab' });
    }
  };

  const drawNumbering = layer => {
    const o = { h: layer.height, w: plan.lineWidth, speed: plan.speeds.first, tag: 'glyph' };
    em.comment('pa value labels');
    em.put(';TYPE:Top solid infill');
    setPa(plan.paValues[0], 'reset for labels');
    const gy = (g.tab ? g.tab.y : g.startY + g.sizeYBase + g.tabGap) + GEOM.glyphPadding;
    for (let j = 0; j < plan.labels.length; j++) {
      if (plan.labels[j]) drawLabel(em, wallCenterX(j) - GEOM.glyphSegLength, gy, plan.labels[j], o);
    }
    if (g.tickY > 0) {
      em.comment('scale ticks');
      for (let j = 0; j < plan.paValues.length; j++) {
        const len = (j % GEOM.tickEvery === 0) ? GEOM.tickLong : GEOM.tickShort;
        em.moveTo(wallCenterX(j), g.tickY);
        em.drawTo(wallCenterX(j), g.tickY + len, o);
      }
    }
  };

  const drawChevrons = layer => {
    const o = { h: layer.height, w: plan.lineWidth, speed: layer.speed, tag: 'pattern' };
    em.put(';TYPE:External perimeter');
    for (let j = 0; j < plan.paValues.length; j++) {
      setPa(plan.paValues[j], 'pattern ' + (j + 1) + '/' + plan.paValues.length);
      const px = g.patternStartX + j * g.patternPitch;
      for (let k = 0; k < GEOM.wallCount; k++) {
        const x0 = px + k * plan.lineSpacingAngle;
        // Direction alternates per wall, keeping the hop to the next wall
        // below the retract threshold (differs from Ellis).
        const up = (k % 2) === 0;
        const yBase = up ? g.patternStartY : g.patternStartY + g.chevronHeight;
        const dy = up ? 1 : -1;
        em.moveTo(x0, yBase);
        em.drawTo(x0 + g.chevronWidth, yBase + dy * g.chevronHeight / 2, o);
        em.drawTo(x0, yBase + dy * g.chevronHeight, o);
      }
    }
  };

  /* --- layers --- */
  let firstLayerTime = 0;
  for (const layer of plan.layers) {
    if (layer.index === 2) firstLayerTime = em.time;
    openLayer(layer);
    if (layer.index === 1 && g.box) drawAnchor(layer);
    if (plan.printNumbers && layer.index === plan.numberingLayer) drawNumbering(layer);
    if (layer.role === 'pattern') drawChevrons(layer);
  }

  /* --- finish --- */
  setPa(plan.paValues[0], 'back to start value');
  em.retract('-', false);
  em.moveToZ(em.z + GEOM.zLift);
  em.put('M107 ; part fan off');
  // Klipper keeps SET_VELOCITY_LIMIT beyond the end of the print and no usual
  // PRINT_END resets it, so clean up ourselves.
  setAccel(accel.restore, 'restore machine acceleration');
  // Heaters stay on: the slicer's end block takes care of them, and cooling
  // down early could get in the way of a PRINT_END macro.

  // The pattern block extrudes relative (M83); the end block expects the
  // profile's mode back.
  em.put(d.printer.relativeE ? 'M83 ; restore relative extrusion'
                             : 'M82 ; restore absolute extrusion');
  em.put('G92 E0');
  em.put(BODY_END);

  /* --- statistics --- */
  const filamentMm = em.eTotal;
  const filamentCm3 = filamentMm * em.filArea / 1000;
  const density = plan.doc.material.density;
  const costPerKg = plan.doc.material.cost;
  const filamentG = Number.isFinite(density) && density > 0 ? filamentCm3 * density : NaN;
  const filamentCost = Number.isFinite(filamentG) && Number.isFinite(costPerKg) && costPerKg > 0
    ? filamentG / 1000 * costPerKg : NaN;

  // Silent-to-normal ratio from the source profile: we cannot model the quiet
  // mode, but its surcharge is a printer property and stays valid.
  const durLine = re => {
    for (const l of plan.doc.endLines.concat(plan.doc.startLines)) {
      const m = re.exec(l);
      if (m) return parseDuration(m[1]);
    }
    return NaN;
  };
  const origNormal = durLine(/^;\s*estimated printing time \(normal mode\)\s*=\s*(.*)$/i);
  const origSilent = durLine(/^;\s*estimated printing time \(silent mode\)\s*=\s*(.*)$/i);
  const silentFactor = (Number.isFinite(origNormal) && origNormal > 0 && Number.isFinite(origSilent))
    ? origSilent / origNormal : 0;

  const stats = {
    filamentMm, filamentCm3, filamentG, filamentCost,
    timeSec: em.time,
    firstLayerSec: firstLayerTime > 0 ? firstLayerTime : em.time,
    silentSec: silentFactor > 0 ? em.time * silentFactor : NaN,
  };

  /* --- assembly --- */
  const { start, end, patchedExcludeObject } = patchStartEnd(plan, stats);
  const head = header(plan, stats);
  // Progress only for Marlin: there M73 drives the display. Klipper does not
  // know the command and answers every line with "Unknown command".
  const wantsProgress = d.printer.flavor === 'marlin' || d.printer.flavor === 'marlin2';
  const patternLines = wantsProgress
    ? insertProgress(em.out, em.stamp, em.time, silentFactor)
    : em.out;
  // Header at the very top: visible on opening and findable without a search.
  const lines = head.concat(start, patternLines, end);

  return {
    lines, patternLines,
    // Parts for the download: thumbnails go between head and start.
    head, start, end,
    stats: {
      filamentMm, filamentCm3, filamentG, filamentCost,
      timeSec: em.time,
      gcodeLines: lines.length,
      patchedExcludeObject,
      retracts: em.retractCount,
      unretracts: em.unretractCount,
    },
  };
}
