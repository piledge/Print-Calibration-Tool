/**
 * settings.js — reads a PrusaSlicer gcode file (already ASCII text) and derives
 * what the three tests need.
 *
 * Knows no DOM. Never throws: problems end up as issue entries in the result.
 */

const START_ANCHORS = [';AFTER_LAYER_CHANGE', ';LAYER_CHANGE', ';START_GCODE_END'];
const END_ANCHOR    = '; Filament-specific end gcode';

const CONFIG_RE = /^;\s*([a-z0-9_]+)\s*=\s*(.*)$/;
const WIDTH_RE  = /^;\s*perimeters extrusion width\s*=\s*([0-9.]+)\s*mm/i;
const TOOL_RE   = /^\s*T(\d+)(?:\s|$)/;
// active (not commented out) PA command in the start block
const PA_ACTIVE_RE = /^\s*(SET_PRESSURE_ADVANCE|M572|M900)\b/;
// thumbnails of the source file; the suffix also covers thumbnail_QOI/_JPG.
const THUMB_BEGIN_RE = /^;\s*thumbnail(?:_[A-Za-z0-9]+)?\s+begin\b/i;
const THUMB_END_RE   = /^;\s*thumbnail(?:_[A-Za-z0-9]+)?\s+end\b/i;
// thumbnail formats we can produce ourselves, plus guards against absurd profiles.
const THUMB_FORMATS   = ['PNG', 'QOI'];
const THUMB_MAX_PX    = 1024;
const THUMB_MAX_COUNT = 8;

/** Mandatory values: without them no pattern can be built. */
const REQUIRED = [
  'gcode_flavor', 'bed_shape', 'nozzle_diameter', 'filament_diameter',
  'layer_height', 'first_layer_height', 'perimeter_speed', 'travel_speed',
  'extrusion_multiplier', 'retract_length',
];

/* ----------------------------------------------------------------- Helpers */

/**
 * `field` is the id (or list of ids) of the control that triggered the message;
 * app.js marks that control. Messages about the file itself leave it out.
 */
export function issue(level, code, text, field) {
  return { level, code, text, field };
}

/** Raw value of a possibly per-tool setting (CSV) for one tool index. */
function toolRaw(map, key, tool) {
  const raw = map.get(key);
  if (raw === undefined) return undefined;
  if (raw.indexOf(',') === -1) return raw.trim();
  const parts = raw.split(',');
  const s = (tool < parts.length ? parts[tool] : parts[0]);
  return s === undefined ? undefined : s.trim();
}

/**
 * Length or speed, with percentages relative to `base` (PrusaSlicer allows e.g.
 * `perimeter_extrusion_width = 105%`, `first_layer_height = 75%`). `nil` and
 * the empty string mean "not set".
 */
function parseLength(raw, base) {
  if (raw === undefined || raw === null) return NaN;
  const s = String(raw).trim();
  if (s === '' || s === 'nil') return NaN;
  if (s.endsWith('%')) {
    const p = parseFloat(s);
    return (Number.isFinite(p) && Number.isFinite(base)) ? (p / 100) * base : NaN;
  }
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : NaN;
}

function num(map, key, tool, base) {
  return parseLength(toolRaw(map, key, tool), base);
}

/** First finite value > 0 from the list, otherwise `fallback`. */
function firstPositive(values, fallback) {
  for (const v of values) if (Number.isFinite(v) && v > 0) return v;
  return fallback;
}

/**
 * First *set* value from the list, otherwise `fallback`. Unlike firstPositive,
 * 0 counts as set: PrusaSlicer distinguishes `nil` ("not overridden") from `0`
 * ("set to 0"), e.g. filament_retract_length = 0 in direct-drive profiles.
 */
function firstSet(values, fallback) {
  for (const v of values) if (Number.isFinite(v)) return v;
  return fallback;
}

/* ------------------------------------------------- Parsing the document -- */

function extractConfig(lines) {
  const map = new Map();
  for (const line of lines) {
    const m = CONFIG_RE.exec(line);
    if (m) map.set(m[1], m[2]);
  }
  return map;
}

/** The width actually used, as PrusaSlicer prints it at the end of the file. */
function extractComputedWidth(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = WIDTH_RE.exec(lines[i]);
    if (m) {
      const v = parseFloat(m[1]);
      if (Number.isFinite(v) && v > 0) return v;
    }
  }
  return NaN;
}

/**
 * Removes the source file's thumbnails and puts the given new ones where the
 * first removed block was. `blocks = null` means remove only — how the PA test
 * uses it, taking over start and end block without images and hanging its own
 * in elsewhere; EM and TT pass the whole file through and swap in place.
 *
 * Matches "; thumbnail begin", "; thumbnail_QOI begin" and every other suffix
 * variant. If a non-comment line turns up before the matching "end" (truncated
 * file), skipping stops so that half the start block is not swallowed.
 *
 * @returns {string[]} a new list; `lines` is left unchanged
 */
export function replaceThumbnails(lines, blocks) {
  const out = [];
  let skipping = false;
  let at = -1;                        // where the first block was
  for (const line of lines) {
    const t = line.trim();
    if (skipping) {
      if (THUMB_END_RE.test(t)) { skipping = false; continue; }
      if (t.charAt(0) === ';') continue;
      skipping = false;               // emergency exit: block without an end
    }
    if (THUMB_BEGIN_RE.test(t)) {
      skipping = true;
      if (at < 0) at = out.length;
      continue;
    }
    out.push(line);
  }
  // Only replace, never add: if the source had no images, the profile does not
  // want any.
  if (blocks && blocks.length && at >= 0) out.splice(at, 0, ...blocks);
  return out;
}

function stripThumbnails(lines) {
  return replaceThumbnails(lines, null);
}

function findStartBlock(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (START_ANCHORS.indexOf(lines[i].trim()) !== -1) return stripThumbnails(lines.slice(0, i));
  }
  return null;
}

function findEndBlock(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === END_ANCHOR) return stripThumbnails(lines.slice(i));
  }
  return null;
}

/**
 * `thumbnails = 16x16/QOI, 313x173/QOI, 380x285/PNG` -> a list of specs. Older
 * PrusaSlicer versions write the sizes without a format and keep it separately
 * in `thumbnails_format`; both forms are supported.
 *
 * @returns {{specs:Array<{w:number,h:number,fmt:string}>, skipped:string[]}}
 */
function parseThumbnailSpecs(settings) {
  const raw = (settings.get('thumbnails') || '').trim();
  const specs = [], skipped = [];
  if (!raw) return { specs, skipped };
  const fallback = (settings.get('thumbnails_format') || 'PNG').trim().toUpperCase();

  for (const part of raw.split(',')) {
    const t = part.trim();
    if (!t) continue;
    const m = /^(\d+)\s*x\s*(\d+)(?:\s*\/\s*([A-Za-z0-9]+))?$/.exec(t);
    if (!m) { skipped.push(t); continue; }
    const w = parseInt(m[1], 10), h = parseInt(m[2], 10);
    const fmt = (m[3] || fallback).toUpperCase();
    if (THUMB_FORMATS.indexOf(fmt) === -1 ||
        !(w > 0 && h > 0) || w > THUMB_MAX_PX || h > THUMB_MAX_PX ||
        specs.length >= THUMB_MAX_COUNT) { skipped.push(t); continue; }
    specs.push({ w, h, fmt });
  }
  return { specs, skipped };
}

function findToolIndex(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = TOOL_RE.exec(lines[i]);
    if (m) return parseInt(m[1], 10);
  }
  return 0;
}

/** `0x0,250x0,250x220,0x220` -> {x:250, y:220} */
function parseBedShape(raw) {
  if (!raw) return { bed: null, error: 'bed_shape is missing.' };
  const corners = raw.split(',').map(s => s.trim());
  if (corners.length !== 4) {
    return { bed: null, error: 'Only rectangular beds are supported (bed_shape has ' + corners.length + ' corners).' };
  }
  const first = corners[0].split('x').map(Number);
  const third = corners[2].split('x').map(Number);
  if (first[0] !== 0 || first[1] !== 0) {
    return { bed: null, error: 'Beds with an origin other than 0x0 are not supported (found ' + corners[0] + ').' };
  }
  if (!Number.isFinite(third[0]) || !Number.isFinite(third[1]) || third[0] <= 0 || third[1] <= 0) {
    return { bed: null, error: 'bed_shape could not be read: ' + raw };
  }
  return { bed: { x: third[0], y: third[1] }, error: null };
}

function findExcludeObject(startLines) {
  for (let i = 0; i < startLines.length; i++) {
    if (startLines[i].indexOf('EXCLUDE_OBJECT_DEFINE') !== -1) {
      return { present: true, defineLineIndex: i };
    }
  }
  return { present: false, defineLineIndex: -1 };
}

/* ------------------------------------------------------------ Main entry -- */

/**
 * @param {string} text  the complete gcode file as ASCII
 * @returns {object} SourceDocument
 */
export function parseDocument(text) {
  const issues = [];
  const all = String(text).split(/\r?\n/);
  // ";TYPE:Custom" has to go, or Prusa's gcode viewer will not open the file.
  const lines = all.filter(l => l.trim() !== ';TYPE:Custom');

  const settings = extractConfig(lines);

  const startLines = findStartBlock(lines);
  if (startLines === null) {
    issues.push(issue('error', 'E1',
      'Start block not found: no ";LAYER_CHANGE", ";AFTER_LAYER_CHANGE", ";START_GCODE_END".'));
  }
  const endLines = findEndBlock(lines);
  if (endLines === null) {
    issues.push(issue('error', 'E2',
      'End block not found: no "; Filament-specific end gcode" (filament end gcode).'));
  }

  const missing = REQUIRED.filter(k => !settings.has(k));
  if (missing.length) {
    issues.push(issue('error', 'E3', 'Missing slicer settings: ' + missing.join(', ')));
  }

  const tool = findToolIndex(lines);
  if (tool > 0) {
    issues.push(issue('warning', 'W5',
      'Tool index T' + tool + ' detected. Only single-extruder setups are verified.'));
  }

  // --- Printer -------------------------------------------------------------
  const flavor = (settings.get('gcode_flavor') || '').trim();
  const model  = (settings.get('printer_model') || '').trim();
  // For a custom printer printer_model is empty (Voron); the preset name is
  // always there and also names the nozzle. Used for the file name only — the
  // firmware branching stays on the model.
  const preset = (settings.get('printer_settings_id') || '').trim();

  const bedRes = parseBedShape(settings.get('bed_shape'));
  if (bedRes.error && settings.has('bed_shape')) {
    issues.push(issue('error', 'E4', bedRes.error));
  }

  const relativeE      = (settings.get('use_relative_e_distances') || '0').trim() === '1';
  const firmwareRetract = (settings.get('use_firmware_retraction') || '0').trim() === '1';

  // --- Geometry ------------------------------------------------------------
  const nozzle       = num(settings, 'nozzle_diameter', tool);
  const layerHeight  = num(settings, 'layer_height', tool);
  const firstLayerHeight = firstPositive(
    [num(settings, 'first_layer_height', tool, layerHeight)], layerHeight);

  // PrusaSlicer computes extrusion-width percentages over the layer height
  // ("computed over layer height"), not over the nozzle.
  let lineWidth = num(settings, 'perimeter_extrusion_width', tool, layerHeight);
  let widthSource = 'perimeter_extrusion_width';
  if (!(Number.isFinite(lineWidth) && lineWidth > 0)) {
    const computed = extractComputedWidth(lines);
    if (Number.isFinite(computed)) {
      lineWidth = computed;
      widthSource = 'computed comment';
      issues.push(issue('warning', 'W1',
        'perimeter_extrusion_width automatic; using ' + computed.toFixed(2) +
        ' mm from the computed-width comment.'));
    } else if (Number.isFinite(nozzle) && nozzle > 0) {
      lineWidth = nozzle * 1.125;
      widthSource = 'derived from nozzle';
      issues.push(issue('warning', 'W1',
        'perimeter_extrusion_width automatic, no computed width; ' +
        'nozzle × 1.125 = ' + lineWidth.toFixed(3) + ' mm.'));
    }
  }

  if (Number.isFinite(firstLayerHeight) && Number.isFinite(layerHeight) &&
      Math.abs(firstLayerHeight - layerHeight) > 1e-9) {
    issues.push(issue('warning', 'W6',
      'first_layer_height ' + firstLayerHeight + ' mm ≠ layer_height ' + layerHeight +
      ' mm; line spacing uses layer_height.'));
  }

  // --- Material ------------------------------------------------------------
  const filamentDiameter   = num(settings, 'filament_diameter', tool);
  const extrusionMultiplier = firstPositive([num(settings, 'extrusion_multiplier', tool)], 1);
  const maxVolumetric = firstPositive([
    num(settings, 'filament_max_volumetric_speed', tool),
    num(settings, 'max_volumetric_speed', tool),
  ], 0); // 0 == unlimited

  // --- Speeds --------------------------------------------------------------
  const perimeterSpeed = num(settings, 'perimeter_speed', tool);
  const firstLayerSpeed = firstPositive(
    [num(settings, 'first_layer_speed', tool, perimeterSpeed)], perimeterSpeed);
  const travelSpeed  = num(settings, 'travel_speed', tool);
  const travelSpeedZ = firstPositive([num(settings, 'travel_speed_z', tool)], travelSpeed);

  // --- Retraction ----------------------------------------------------------
  const retractLength = firstSet([
    num(settings, 'filament_retract_length', tool),
    num(settings, 'retract_length', tool),
  ], 0);
  const retractSpeed = firstPositive([
    num(settings, 'filament_retract_speed', tool),
    num(settings, 'retract_speed', tool),
  ], 30);
  // Here 0 is not a set value but PrusaSlicer's "same as retract_speed".
  const deretractSpeed = firstPositive([
    num(settings, 'filament_deretract_speed', tool),
    num(settings, 'deretract_speed', tool),
  ], retractSpeed);
  const retractExtra = firstSet([
    num(settings, 'filament_retract_restart_extra', tool),
    num(settings, 'retract_restart_extra', tool),
  ], 0);
  const retractLift = firstSet([
    num(settings, 'filament_retract_lift', tool),
    num(settings, 'retract_lift', tool),
  ], 0);

  // --- Accelerations -------------------------------------------------------
  // The test has to run under the profile's conditions. Without setting them
  // explicitly, whatever the start macro left behind applies - on the Voron
  // 10000 mm/s^2 from CLEAN_NOZZLE instead of the profile's 3000.
  const accelPrint = firstPositive([
    num(settings, 'perimeter_acceleration', tool),
    num(settings, 'default_acceleration', tool),
    num(settings, 'machine_max_acceleration_extruding', tool),
  ], 0);
  const accelFirstLayer = firstPositive([
    num(settings, 'first_layer_acceleration', tool),
  ], accelPrint);
  const accelTravel = firstPositive([
    num(settings, 'travel_acceleration', tool),
    num(settings, 'default_acceleration', tool),
  ], accelPrint);
  // Restored after the test. Klipper's real max_accel is not in the file; the
  // profile's machine limit is the best the source offers.
  const accelRestore = firstPositive([
    num(settings, 'machine_max_acceleration_extruding', tool),
    num(settings, 'default_acceleration', tool),
  ], 0);

  // Density (g/cm3) and price (currency/kg) only for the statistics lines of
  // the output file; if missing, the original lines stay.
  const filamentDensity = num(settings, 'filament_density', tool);
  const filamentCost    = num(settings, 'filament_cost', tool);

  // --- Fan -----------------------------------------------------------------
  const fanSpeed = firstSet([num(settings, 'min_fan_speed', tool)], 0);
  const disableFanFirstLayers = firstSet([num(settings, 'disable_fan_first_layers', tool)], 0);

  // --- Temperatures (the start block is never rewritten to another one) -----
  const temperature = num(settings, 'temperature', tool);
  // Only the temperature tower needs it: if it differs, PrusaSlicer itself puts
  // a temperature command into the second layer.
  const firstLayerTemperature = num(settings, 'first_layer_temperature', tool);
  const bedTemperature = num(settings, 'bed_temperature', tool);
  const filamentName = (toolRaw(settings, 'filament_settings_id', tool) || '')
    .replace(/^"|"$/g, '').trim();

  // --- Value check ---------------------------------------------------------
  // `settings.has(key)` is not enough: `nil`, 0 or garbage pass the presence
  // check and would produce NaN/Infinity in the gcode.
  const badValues = [];
  const needPositive = [
    ['nozzle_diameter', nozzle],
    ['filament_diameter', filamentDiameter],
    ['layer_height', layerHeight],
    ['first_layer_height', firstLayerHeight],
    ['perimeter_extrusion_width', lineWidth],
    ['extrusion_multiplier', extrusionMultiplier],
    ['perimeter_speed', perimeterSpeed],
    ['first_layer_speed', firstLayerSpeed],
    ['travel_speed', travelSpeed],
    ['travel_speed_z', travelSpeedZ],
  ];
  for (const [name, v] of needPositive) {
    if (!(Number.isFinite(v) && v > 0)) badValues.push(name);
  }
  const needFinite = [
    ['retract_length', retractLength], ['retract_speed', retractSpeed],
    ['deretract_speed', deretractSpeed], ['retract_restart_extra', retractExtra],
    ['retract_lift', retractLift],
  ];
  for (const [name, v] of needFinite) {
    if (!Number.isFinite(v) || v < 0) badValues.push(name);
  }
  if (badValues.length) {
    issues.push(issue('error', 'E3',
      'Slicer settings missing or not a number: ' + badValues.join(', ') + '.'));
  }

  // --- Thumbnails ----------------------------------------------------------
  const thumbs = parseThumbnailSpecs(settings);
  if (thumbs.skipped.length) {
    issues.push(issue('warning', 'W8',
      'Thumbnails skipped (only PNG and QOI): ' + thumbs.skipped.join(', ') + '.'));
  }

  // --- Exclude-Object ------------------------------------------------------
  const excludeObject = findExcludeObject(startLines || []);

  // --- active PA command in the start block? -------------------------------
  if (startLines) {
    // There may be several (Prusa sets PA in both the printer and the filament
    // start gcode); the last one wins, so that is the one reported.
    const hits = startLines.filter(l => PA_ACTIVE_RE.test(l));
    if (hits.length) {
      const last = hits[hits.length - 1].trim();
      issues.push(issue('warning', 'W4',
        'Start block sets PA ' +
        (hits.length > 1 ? hits.length + '×, last ' : '') + '(' + last +
        '), overridden — check your range covers it.'));
    }
  }

  return {
    settings,
    // Unfiltered: the EM test passes the file through line by line and must not
    // lose ";TYPE:Custom" on the way.
    raw: all,
    startLines: startLines || [],
    endLines: endLines || [],
    printer: {
      flavor, model, preset, toolIndex: tool,
      bed: bedRes.bed,
      relativeE, firmwareRetract,
    },
    material: { filamentDiameter, extrusionMultiplier, maxVolumetric, filamentName,
                temperature, firstLayerTemperature, bedTemperature,
                density: filamentDensity, cost: filamentCost },
    geometry: { nozzle, lineWidth, widthSource, firstLayerHeight, layerHeight },
    speeds: { perimeter: perimeterSpeed, firstLayer: firstLayerSpeed,
              travel: travelSpeed, travelZ: travelSpeedZ },
    retract: { length: retractLength, speed: retractSpeed, deretractSpeed,
               extra: retractExtra, lift: retractLift },
    accel: { print: accelPrint, firstLayer: accelFirstLayer, travel: accelTravel,
             restore: accelRestore },
    fan: { speed: fanSpeed, disableFirstLayers: disableFanFirstLayers },
    excludeObject,
    thumbnails: thumbs.specs,
    issues,
  };
}

/** Rows of the "Detected slicer settings" table: what was read, and from where. */
export function describeDocument(doc) {
  const g = doc.geometry, s = doc.speeds, r = doc.retract, m = doc.material, p = doc.printer;
  const mm = v => Number.isFinite(v) ? v.toFixed(2) + ' mm' : '—';
  const mms = v => Number.isFinite(v) ? v.toFixed(0) + ' mm/s' : '—';
  const deg = v => Number.isFinite(v) ? v.toFixed(0) + ' °C' : '—';
  return [
    ['Firmware',            p.flavor || '—',                              'gcode_flavor'],
    ['Printer model',       p.model || '(not set)',                       'printer_model'],
    ['Printer preset',      p.preset || '(not set)',                      'printer_settings_id'],
    ['Bed',                 p.bed ? p.bed.x + ' × ' + p.bed.y + ' mm' : '—', 'bed_shape'],
    ['Nozzle',              mm(g.nozzle),                                 'nozzle_diameter'],
    ['Extrusion width',     mm(g.lineWidth),                              g.widthSource],
    ['First layer height',  mm(g.firstLayerHeight),                       'first_layer_height'],
    ['Layer height',        mm(g.layerHeight),                            'layer_height'],
    ['Filament diameter',   mm(m.filamentDiameter),                       'filament_diameter'],
    ['Extrusion multiplier', Number.isFinite(m.extrusionMultiplier) ? m.extrusionMultiplier.toFixed(3) : '—', 'extrusion_multiplier'],
    ['Max volumetric',      m.maxVolumetric ? m.maxVolumetric.toFixed(1) + ' mm³/s' : 'unlimited', 'filament_max_volumetric_speed'],
    ['Perimeter speed',     mms(s.perimeter),                             'perimeter_speed'],
    ['First layer speed',   mms(s.firstLayer),                            'first_layer_speed'],
    ['Travel speed',        mms(s.travel),                                'travel_speed'],
    ['Travel speed Z',      mms(s.travelZ),                               'travel_speed_z'],
    ['Retract',             mm(r.length) + ' @ ' + mms(r.speed),          'retract_length / retract_speed'],
    ['Deretract',           mm(r.length + r.extra) + ' @ ' + mms(r.deretractSpeed), 'retract_restart_extra / deretract_speed'],
    ['Z hop',               mm(r.lift),                                   'retract_lift'],
    ['Firmware retraction', p.firmwareRetract ? 'yes (G10/G11)' : 'no',   'use_firmware_retraction'],
    ['Relative E',          p.relativeE ? 'yes' : 'no',                   'use_relative_e_distances'],
    ['Fan',                 (Number.isFinite(doc.fan.speed) ? doc.fan.speed + ' %' : '—') +
                            ', off for first ' + doc.fan.disableFirstLayers
                            + (doc.fan.disableFirstLayers === 1 ? ' layer' : ' layers'),
                                                                  'min_fan_speed / disable_fan_first_layers'],
    ['Nozzle temperature',  deg(m.temperature),                           'temperature'],
    ['Bed temperature',     deg(m.bedTemperature),                        'bed_temperature'],
    ['Filament',            m.filamentName || '—',                        'filament_settings_id'],
    ['Exclude object',      doc.excludeObject.present ? 'yes, will be replaced' : 'not present', 'EXCLUDE_OBJECT_DEFINE'],
  ].map(([name, value, source]) => ({ name, value, source }));
}
