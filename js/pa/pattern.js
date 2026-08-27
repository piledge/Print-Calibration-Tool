/**
 * pattern.js — derives all dimensions, the PA series, the layer list and the
 * validation results from the parsed document and the user input.
 *
 * Deliberately emits no gcode, so dimensions and bed check stay available even
 * when generation would fail. Knows no DOM.
 */

import { issue } from '../settings.js';

/** Fixed pattern geometry: not configurable, on purpose. */
export const GEOM = Object.freeze({
  cornerAngle: 90,          // interior angle at the chevron tip, degrees
  sideLength: 30,           // length of one chevron leg, mm
  wallCount: 3,             // nested walls per pattern
  patternSpacing: 2,        // gap between two patterns, mm
  anchorPerimeters: 4,      // rings of the anchor frame
  anchorWidthRatio: 1.4,    // anchor line width = nozzle × 1.4
  glyphSegLength: 2,        // digit segment length, mm
  // Counting aid: one tick per chevron along the top edge of the number tab,
  // every fifth one longer — orientation on wide patterns.
  tickShort: 1,             // tick length, mm
  tickLong: 2.5,            // every fifth tick, mm
  tickGap: 1,               // gap between digits and ticks, mm
  tickEvery: 5,             // every n-th tick is a long one
  glyphDotSize: 0.75,
  glyphSpacing: 3.0,        // advance per character
  glyphNarrowSpacing: 1.0,  // advance for '1' and '.'
  glyphPadding: 1,          // margin inside the number tab, mm
  patternFrameGap: 2,       // lateral gap pattern <-> anchor frame, mm
  bedMargin: 5,             // safety margin to the bed edge, mm
  encroachment: 1 / 3,      // overlap infill <-> innermost ring
  minTravelForRetract: 2,   // shorter travels do not retract
  zLift: 5,                 // lift at start and end, mm
  maxValues: 200,
});

const PA_SCALE = 10000;     // integer domain, 4 decimals

const SUPPORTED_FLAVORS = new Set(['klipper', 'marlin', 'marlin2', 'reprapfirmware']);

/* ---------------------------------------------------------------- PA series */

export function formatPa(v) {
  return String(Math.round(v * PA_SCALE) / PA_SCALE);
}

/**
 * Builds the PA series without float drift by counting in whole ten-thousandths.
 * A range that does not divide evenly is not an error — as many values as fit
 * are produced.
 */
function buildPaSeries(paStart, paEnd, paStep) {
  const out = { values: [], issues: [] };
  const a = Math.round(paStart * PA_SCALE);
  const b = Math.round(paEnd * PA_SCALE);
  const inc = Math.round(paStep * PA_SCALE);

  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(inc)) {
    out.issues.push(issue('error', 'E7', 'PA range contains a value that is not a number.'));
    return out;
  }
  if (inc <= 0) {
    out.issues.push(issue('error', 'E7', 'PA increment must be greater than 0 (minimum 0.0001).', 'pa-step'));
    return out;
  }
  if (b < a) {
    out.issues.push(issue('error', 'E7', 'PA end must not be smaller than PA start.', 'pa-end'));
    return out;
  }
  if (a < 0) {
    out.issues.push(issue('error', 'E7', 'PA start must not be negative.', 'pa-start'));
    return out;
  }

  const n = Math.floor((b - a) / inc) + 1;
  if (n < 2) {
    out.issues.push(issue('error', 'E7',
      'PA range yields only ' + n + ' value, at least 2 needed: lower the increment or widen it.',
      'pa-step'));
    return out;
  }
  if (n > GEOM.maxValues) {
    out.issues.push(issue('error', 'E7',
      'PA range yields ' + n + ' values, above the limit of ' + GEOM.maxValues + ' — increase the increment.',
      'pa-step'));
    return out;
  }

  for (let j = 0; j < n; j++) out.values.push((a + j * inc) / PA_SCALE);

  const last = a + (n - 1) * inc;
  if (last !== b) {
    out.issues.push(issue('warning', 'W2',
      'Increment does not divide the range evenly: last value ' +
      formatPa(last / PA_SCALE) + ', end ' + formatPa(paEnd) + ' not reached.'));
  }
  return out;
}

/* --------------------------------------------------------------- Labelling */

/** Y extent of a label (the digits grow in +Y). */
function labelExtent(text) {
  let w = 0;
  for (const c of text) {
    w += (c === '1' || c === '.') ? GEOM.glyphNarrowSpacing : GEOM.glyphSpacing;
  }
  return w;
}

/* ---------------------------------------------------------------- Main task */

/**
 * `doc` is the SourceDocument from settings.js, `input` holds
 * {paStart, paEnd, paStep, anchor:'frame'|'layer'|'none', layers, printNumbers}.
 */
export function buildPlan(doc, input) {
  const issues = doc.issues.slice();
  const g = doc.geometry;
  const bed = doc.printer.bed;

  /* --- PA series --- */
  const series = buildPaSeries(input.paStart, input.paEnd, input.paStep);
  issues.push(...series.issues);
  const paValues = series.values;

  /* --- Firmware --- */
  if (!SUPPORTED_FLAVORS.has(doc.printer.flavor)) {
    issues.push(issue('error', 'E6',
      'Unsupported gcode_flavor "' + (doc.printer.flavor || '(empty)') +
      '"; use klipper, marlin, marlin2, reprapfirmware.'));
  }

  /* --- layer count --- */
  const layerCount = Math.round(Number(input.layers));
  if (!Number.isFinite(layerCount) || layerCount < 2) {
    issues.push(issue('error', 'E8', 'At least 2 layers are required (one first layer plus one more).',
      'layers'));
  }

  /* --- base dimensions --- */
  const halfRad = (GEOM.cornerAngle / 2) * Math.PI / 180;
  const sinH = Math.sin(halfRad);
  const cosH = Math.cos(halfRad);

  const lineWidth = g.lineWidth;
  const layerHeight = g.layerHeight;
  const firstLayerHeight = g.firstLayerHeight;
  const anchorLineWidth = g.nozzle * GEOM.anchorWidthRatio;

  // Slic3r spacing: the width actually occupied is narrower than the line
  // width, because the edges of an extrusion are rounded.
  const lineSpacing = lineWidth - layerHeight * (1 - Math.PI / 4);
  // Perpendicular wall distance shall be `lineSpacing`, so the horizontal
  // offset is larger by 1/sin(alpha/2).
  const lineSpacingAngle = lineSpacing / sinH;
  const lineSpacingAnchor = anchorLineWidth - firstLayerHeight * (1 - Math.PI / 4);

  const chevronHeight = 2 * sinH * GEOM.sideLength;   // Y extent of one chevron
  const chevronWidth = cosH * GEOM.sideLength;        // X extent of one chevron
  const wallSpan = (GEOM.wallCount - 1) * lineSpacingAngle;
  const patternPitch = wallSpan + GEOM.patternSpacing + lineWidth;

  const n = paValues.length;
  const patternWidth = n > 0
    ? n * wallSpan + (n - 1) * (GEOM.patternSpacing + lineWidth) + chevronWidth
    : 0;

  /* --- labels --- */
  const labels = [];
  for (let j = 0; j < n; j++) {
    labels.push(j % 2 === 0 ? formatPa(paValues[j]) : null);   // only every other pattern
  }
  let glyphExtent = 0;
  for (const t of labels) if (t) glyphExtent = Math.max(glyphExtent, labelExtent(t));
  const printNumbers = !!input.printNumbers && glyphExtent > 0;
  const tabHeight = printNumbers
    ? glyphExtent + 2 * GEOM.glyphPadding + GEOM.tickGap + GEOM.tickLong
    : 0;

  /* --- outline ---
   * The anchor frame sits around the pattern so that the upper and lower
   * chevron endpoints land exactly on the centre line of the innermost ring.
   * That welds the ends into the frame and makes Ellis' SHRINK correction
   * unnecessary.                                                           */
  const hasAnchor = input.anchor !== 'none';
  const ringInset = hasAnchor ? (GEOM.anchorPerimeters - 1) * lineSpacingAnchor : 0;
  const insetY = hasAnchor ? ringInset + anchorLineWidth / 2 : lineWidth / 2;
  // Extra gap sideways: the chevron tip is where the result is read off and
  // must not merge with the frame. In Y contact is kept (welding, see above).
  const gapX = hasAnchor ? GEOM.patternFrameGap : 0;
  const insetX = insetY + gapX;

  // The first digit starts left of its pattern because it is centred below it.
  // Without an anchor the margin is too narrow, so the overhang is reserved on
  // both sides and the pattern stays centred.
  const glyphOverhang = printNumbers
    ? Math.max(0, GEOM.glyphSegLength - ((GEOM.wallCount - 1) / 2) * lineSpacingAngle)
    : 0;
  const padX = Math.max(0, glyphOverhang + lineWidth / 2 - insetX);

  // The number tab hangs off the anchor frame instead of standing beside it:
  // its distance is chosen so the lowest tab line sits like one more ring next
  // to the topmost frame line. Both weld together and the print comes off the
  // sheet in one piece.
  const tabPen = hasAnchor ? anchorLineWidth : lineWidth;
  const weldSpacing = hasAnchor ? lineSpacingAnchor : lineSpacing;
  // Centre-line distance shall be weldSpacing; both lines contribute half
  // their width between centre and edge, so the nominal gap goes negative.
  const tabGap = printNumbers ? weldSpacing - tabPen : 0;

  const sizeX = patternWidth + 2 * insetX + 2 * padX;
  const sizeYBase = chevronHeight + 2 * insetY;
  const sizeY = sizeYBase + (printNumbers ? tabGap + tabHeight : 0);

  /* --- placement: centred on the bed (decision I) --- */
  const originX = bed ? bed.x / 2 - sizeX / 2 : 0;
  const originY = bed ? bed.y / 2 - sizeY / 2 : 0;

  const patternStartX = originX + insetX + padX;
  const patternStartY = originY + insetY;

  const box = hasAnchor ? {
    x: originX + anchorLineWidth / 2,
    y: originY + anchorLineWidth / 2,
    w: sizeX - anchorLineWidth,
    h: sizeYBase - anchorLineWidth,
  } : null;

  // Like box: the rectangle is the centre line of the outermost ring, so inset
  // by half a line width to put the outer edge on the planned outline.
  const tab = printNumbers ? {
    x: originX + tabPen / 2,
    y: originY + sizeYBase + tabGap + tabPen / 2,
    w: sizeX - tabPen,
    h: tabHeight - tabPen,
  } : null;

  /* --- bed check (the result is displayed) --- */
  let fitsOnBed = true;
  if (bed && n > 0) {
    const m = GEOM.bedMargin;
    const overX = Math.max(0, (originX + sizeX) - (bed.x - m), m - originX);
    const overY = Math.max(0, (originY + sizeY) - (bed.y - m), m - originY);
    if (overX > 1e-9 || overY > 1e-9) {
      fitsOnBed = false;
      const parts = [];
      // centred: the missing space is twice the one-sided overhang
      if (overX > 1e-9) parts.push((2 * overX).toFixed(1) + ' mm in X');
      if (overY > 1e-9) parts.push((2 * overY).toFixed(1) + ' mm in Y');
      issues.push(issue('error', 'E5',
        'Pattern needs ' + sizeX.toFixed(1) + ' × ' + sizeY.toFixed(1) +
        ' mm, ' + (bed.x - 2 * m).toFixed(0) + ' × ' + (bed.y - 2 * m).toFixed(0) +
        ' mm usable, over by ' + parts.join(', ') +
        '. Use fewer PA values.'));
    }
  }

  /* --- speeds with volumetric limit --- */
  const clamp = (speed, h, w) => {
    if (!doc.material.maxVolumetric) return speed;
    return Math.min(speed, doc.material.maxVolumetric / (w * h));
  };
  const sPattern = clamp(doc.speeds.perimeter, layerHeight, lineWidth);
  const sFirst = clamp(doc.speeds.firstLayer, firstLayerHeight,
                       hasAnchor ? Math.max(lineWidth, anchorLineWidth) : lineWidth);
  if (sPattern < doc.speeds.perimeter - 1e-9 || sFirst < doc.speeds.firstLayer - 1e-9) {
    issues.push(issue('warning', 'W3',
      'Speed limited by volumetric flow: pattern ' + doc.speeds.perimeter.toFixed(0) + ' → ' +
      sPattern.toFixed(0) + ' mm/s, first layer ' + doc.speeds.firstLayer.toFixed(0) + ' → ' +
      sFirst.toFixed(0) + ' mm/s.'));
  }

  if (!hasAnchor) {
    issues.push(issue('warning', 'W7',
      'Without an anchor the first-layer lines can come loose; use "Anchor frame".'));
  }

  /* --- layer list (decision C: the anchor layer counts) --- */
  const layers = [];
  const count = Number.isFinite(layerCount) && layerCount >= 2 ? layerCount : 0;
  for (let i = 1; i <= count; i++) {
    const height = i === 1 ? firstLayerHeight : layerHeight;
    const z = i === 1 ? firstLayerHeight : firstLayerHeight + (i - 1) * layerHeight;
    layers.push({
      index: i,
      z: round(z, 3),
      height,
      speed: i === 1 ? sFirst : sPattern,
      // With 'layer' the first layer is anchor area, otherwise pattern already.
      role: (i === 1 && input.anchor === 'layer') ? 'anchor' : 'pattern',
      fan: i <= doc.fan.disableFirstLayers ? 0 : doc.fan.speed,
    });
  }
  // The digits need layer 1's number tab underneath, so with an anchor they
  // sit on layer 2. Without an anchor there is no tab: straight onto layer 1.
  const numberingLayer = hasAnchor ? 2 : 1;

  const errorCodes = issues.filter(i => i.level === 'error').map(i => i.code);
  const hasError = errorCodes.length > 0;
  // A pattern that merely does not fit on the bed stays computable and is
  // drawn with the overhang in red (decision D).
  const renderable = errorCodes.every(c => c === 'E5');

  return {
    doc, input,
    bed: bed || { x: 0, y: 0 },
    paValues, labels,
    layers, layerCount: count,
    numberingLayer: count >= numberingLayer ? numberingLayer : 0,
    printNumbers,
    anchor: input.anchor,
    lineWidth, anchorLineWidth, layerHeight, firstLayerHeight,
    lineSpacing, lineSpacingAngle, lineSpacingAnchor,
    speeds: { pattern: sPattern, first: sFirst,
              travel: doc.speeds.travel, travelZ: doc.speeds.travelZ },
    geom: {
      chevronHeight, chevronWidth, patternPitch,
      patternStartX, patternStartY,
      startX: originX, startY: originY, sizeX, sizeY, sizeYBase, tabGap,
      // Tick baseline: above the digits, inside the number tab.
      tickY: (printNumbers && tab)
        ? tab.y + GEOM.glyphPadding + glyphExtent + GEOM.tickGap : 0,
      box, tab,
    },
    fitsOnBed,
    accel: doc.accel,
    issues,
    hasError,
    renderable,
  };
}

export function round(v, digits) {
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}
