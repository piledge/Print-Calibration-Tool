#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Plausibility check for generated PA calibration gcode.

Standard library only. See --help for usage.
Exit code 0 when no check reports FAIL, otherwise 1.
"""

import argparse
import base64
import math
import os
import re
import sys

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

Z_TOL = 1e-6
PA_TOL = 1e-6
MAX_SINGLE_E = 5.0           # largest plausible E of a move without travel (mm)
MAX_E_PER_MM = 0.2           # largest plausible E per mm of travel (0.4 nozzle: ~0.05)
FILAMENT_DIAMETER = 1.75     # mm, for the volume figure
PA_SCALE = 10000             # integer domain of the PA series (4 decimal places)
MARKERS = ("pattern", "anchor", "glyph", "tab")
Z_MARKER_RE = re.compile(r"^;Z:(-?[\d.]+)$")
END_MARKER = "; Filament-specific end gcode"
# Bounds of the part produced by the generator
BODY_BEGIN = "; >>> print_calibration_tool pattern begin"
BODY_END = "; <<< print_calibration_tool pattern end"

MOVE_RE = re.compile(r"^(G0|G1|G00|G01)(?![0-9])")
PARAM_RE = re.compile(r"([XYZEF])([^\sXYZEF]*)")
# In the command part a bare occurrence is enough (e.g. "XNaN"); in comments a
# word boundary is required so base64 thumbnails do not trip the check.
DIRTY_CODE_RE = re.compile(r"(NaN|undefined|Infinity|null)")
DIRTY_COMMENT_RE = re.compile(r"\b(NaN|undefined|Infinity|null)\b")

# PA commands of the three supported firmware families
PA_PATTERNS = (
    re.compile(r"SET_PRESSURE_ADVANCE\s+ADVANCE\s*=\s*(\S+)", re.IGNORECASE),
    re.compile(r"\bM572\b[^;]*?\bS\s*(-?[\d.]+(?:[eE][-+]?\d+)?)", re.IGNORECASE),
    re.compile(r"\bM900\b[^;]*?\bK\s*(-?[\d.]+(?:[eE][-+]?\d+)?)", re.IGNORECASE),
)

# Keys the generator writes into the header comment
HEADER_KEYS = (
    "bed", "bed_shape", "first_layer_height", "layer_height", "layers",
    "estimated_time_s", "filament_mm",
    "pa_start", "pa_end", "pa_step", "pa_values", "anchor", "relative_e",
    "extrusion_width", "anchor_width", "filament_diameter", "extrusion_multiplier",
    "print_numbers", "gcode_flavor", "acceleration_print", "acceleration_first_layer",
)
HEADER_LINE_RE = re.compile(r"^;\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$")
# The two ways a printer learns which area to probe: Prusa reads M555, klipper
# the object definitions. Both describe the sliced model until the generator
# rewrites them for the pattern.
M555_RE = re.compile(r"^M555(?=\s|$)", re.I)
XO_DEFINE_RE = re.compile(r"^EXCLUDE_OBJECT_DEFINE\b(.*)$", re.I)

THUMB_BEGIN_RE  = re.compile(r"^;\s*(thumbnail(?:_[A-Za-z0-9]+)?)\s+begin\s+(\d+)x(\d+)\s+(\d+)\s*$", re.I)
THUMB_END_RE    = re.compile(r"^;\s*thumbnail(?:_[A-Za-z0-9]+)?\s+end\b", re.I)
THUMB_CONFIG_RE = re.compile(r"^;\s*thumbnails\s*=\s*(.*)$", re.I)
THUMB_FORMAT_RE = re.compile(r"^;\s*thumbnails_format\s*=\s*([A-Za-z0-9]+)\s*$", re.I)
THUMB_SPEC_RE   = re.compile(r"^(\d+)\s*x\s*(\d+)(?:\s*/\s*([A-Za-z0-9]+))?$")
GENERATED_FORMATS = ("PNG", "QOI")


# ---------------------------------------------------------------------------
# Result object
# ---------------------------------------------------------------------------

class Result:
    """Result of a single check."""

    def __init__(self, name):
        self.name = name
        self.status = "SKIP"
        self.info = ""
        self.violations = []          # list of (line number, text)

    def ok(self, info=""):
        self.status = "PASS"
        self.info = info
        return self

    def fail(self, info="", violations=None):
        self.status = "FAIL"
        self.info = info
        if violations:
            self.violations = list(violations)
        return self

    def skip(self, info=""):
        self.status = "SKIP"
        self.info = info
        return self


# ---------------------------------------------------------------------------
# Parsing helpers
# ---------------------------------------------------------------------------

def parse_float(text):
    """Converts a gcode number string; None if unparsable or not finite."""
    if text is None or text == "":
        return None
    try:
        value = float(text)
    except (TypeError, ValueError):
        return None
    if math.isnan(value) or math.isinf(value):
        return None
    return value


def strip_comment(line):
    """Splits command part and comment text (without the leading semicolon)."""
    pos = line.find(";")
    if pos < 0:
        return line.strip(), None
    return line[:pos].strip(), line[pos + 1:].strip()


class Move:
    """A parsed G0/G1 line."""

    __slots__ = ("lineno", "raw", "params", "bad", "comment")

    def __init__(self, lineno, raw, params, bad, comment):
        self.lineno = lineno
        self.raw = raw
        self.params = params      # dict letter -> float (valid values only)
        self.bad = bad            # list of (letter, raw text) of unparsable fields
        self.comment = comment

    def get(self, key):
        return self.params.get(key)

    @property
    def is_extruding(self):
        e = self.params.get("E")
        return e is not None and e > 0.0

    @property
    def has_xy(self):
        return "X" in self.params or "Y" in self.params

    @property
    def tag(self):
        """The line's comment marker, normalized (e.g. 'anchor')."""
        return (self.comment or "").strip().lower()


class Document:
    """The loaded file with everything derived from it once."""

    def __init__(self, path):
        self.path = path
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            self.lines = handle.read().splitlines()

        self.moves = []
        self.header = {}
        self.end_block_lines = []     # line numbers of the end block marker
        self.m83_lines = []
        self.m82_lines = []
        self.pa_commands = []         # (line number, value or None, raw text)
        self.body_from = None         # line numbers of the generated part
        self.body_to = None
        self.thumbnails = []          # list of dict(tag,w,h,declared,data,lineno)
        self.thumb_lines = set()      # line numbers of all thumbnail lines
        self.thumb_config = None      # raw value of "; thumbnails = ..."
        self.thumb_format = None      # old format: "; thumbnails_format = QOI"
        self._scan()
        self._scan_body_range()
        self._scan_thumbnails()

    # -- generated range ---------------------------------------------------
    def _scan_body_range(self):
        """Bounds of the generated part.

        Start and end block are taken verbatim from the slicer file (nozzle
        wipe outside the bed, purge line, PA reset in the end gcode) and must
        not distort the check of the pattern."""
        for index, raw in enumerate(self.lines, start=1):
            stripped = raw.strip()
            if stripped == BODY_BEGIN and self.body_from is None:
                self.body_from = index
            elif stripped == BODY_END:
                self.body_to = index
        if self.body_from is None or self.body_to is None or self.body_to < self.body_from:
            self.body_from, self.body_to = None, None

    # -- Thumbnails --------------------------------------------------------
    def _scan_thumbnails(self):
        """Collects the thumbnail blocks and the matching profile entry."""
        current = None
        for index, raw in enumerate(self.lines, start=1):
            stripped = raw.strip()
            match = THUMB_BEGIN_RE.match(stripped)
            if match:
                current = {"tag": match.group(1), "w": int(match.group(2)),
                           "h": int(match.group(3)), "declared": int(match.group(4)),
                           "data": [], "lineno": index, "closed": False}
                self.thumbnails.append(current)
                self.thumb_lines.add(index)
                continue
            if current is not None and not current["closed"]:
                self.thumb_lines.add(index)
                if THUMB_END_RE.match(stripped):
                    current["closed"] = True
                    current = None
                    continue
                if stripped.startswith(";"):
                    current["data"].append(stripped[1:].strip())
                    continue
                # non-comment line inside the block: broken, stop collecting
                self.thumb_lines.discard(index)
                current = None
                continue
            config = THUMB_CONFIG_RE.match(stripped)
            if config and self.thumb_config is None:
                self.thumb_config = config.group(1).strip()
                continue
            fmt = THUMB_FORMAT_RE.match(stripped)
            if fmt and self.thumb_format is None:
                self.thumb_format = fmt.group(1).upper()
        for entry in self.thumbnails:
            entry["data"] = "".join(entry["data"])

    def in_body(self, lineno):
        if self.body_from is None:
            return True               # foreign file: evaluate everything
        return self.body_from <= lineno <= self.body_to

    @property
    def body_moves(self):
        if self.body_from is None:
            return self.moves
        return [m for m in self.moves if self.body_from <= m.lineno <= self.body_to]

    @property
    def body_pa_commands(self):
        if self.body_from is None:
            return self.pa_commands
        return [c for c in self.pa_commands if self.body_from <= c[0] <= self.body_to]

    # -- header comment ----------------------------------------------------
    def _scan_header(self):
        """Reads the leading comment block as `; key = value` pairs."""
        for raw in self.lines:
            stripped = raw.strip()
            if stripped == "":
                continue
            if not stripped.startswith(";"):
                break                 # the first command ends the header
            match = HEADER_LINE_RE.match(stripped)
            if match and match.group(1) in HEADER_KEYS:
                self.header.setdefault(match.group(1), match.group(2))

    def _scan_trailing_config(self):
        """Fallback: PrusaSlicer appends its config block to the end of file.

        Only the bed size is taken from it, so the general checks also run on
        foreign files. Everything else stays SKIP.
        """
        if "bed" in self.header or "bed_shape" in self.header:
            return
        for raw in reversed(self.lines[-4000:]):
            stripped = raw.strip()
            if not stripped.startswith(";"):
                continue
            match = HEADER_LINE_RE.match(stripped)
            if match and match.group(1) == "bed_shape":
                self.header["bed_shape"] = match.group(2)
                return

    # -- main pass ---------------------------------------------------------
    def _scan(self):
        self._scan_header()
        for index, raw in enumerate(self.lines, start=1):
            code, comment = strip_comment(raw)
            stripped = raw.strip()

            if stripped == END_MARKER:
                self.end_block_lines.append(index)

            if not code:
                continue
            upper = code.upper()

            move_match = MOVE_RE.match(upper)
            if move_match:
                params = {}
                bad = []
                # G0/G1 carries no XYZEF itself, but is cut off for clarity
                for letter, value_text in PARAM_RE.findall(upper[move_match.end():]):
                    value = parse_float(value_text)
                    if value is None:
                        bad.append((letter, value_text))
                    else:
                        params[letter] = value
                self.moves.append(Move(index, raw, params, bad, comment))
                continue

            if re.match(r"^M83(?![0-9])", upper):
                self.m83_lines.append(index)
            elif re.match(r"^M82(?![0-9])", upper):
                self.m82_lines.append(index)

            for pattern in PA_PATTERNS:
                match = pattern.search(code)
                if match:
                    self.pa_commands.append((index, parse_float(match.group(1)), stripped))
                    break

        self._scan_trailing_config()

    # -- derived values ----------------------------------------------------
    @property
    def first_end_block(self):
        return self.end_block_lines[0] if self.end_block_lines else None

    @property
    def relative_mode(self):
        """Does the file work in relative mode, the way our generator writes?"""
        return bool(self.m83_lines)


def traverse(moves):
    """Walks the moves modally and yields (move, px, py, x, y, z).

    In gcode X/Y/Z persist until set again - even across pure Z moves. px/py is
    the position before the move, x/y the one after; None until the axis was
    set for the first time."""
    px = py = z = None
    for move in moves:
        new_z = move.get("Z")
        if new_z is not None:
            z = new_z
        nx, ny = move.get("X"), move.get("Y")
        x = nx if nx is not None else px
        y = ny if ny is not None else py
        yield move, px, py, x, y, z
        px, py = x, y


# ---------------------------------------------------------------------------
# Configuration (options + header comment)
# ---------------------------------------------------------------------------

class Config:
    """Resolved target values; None means 'cannot be determined' -> SKIP."""

    def __init__(self):
        self.bed = None               # (x, y)
        self.bed_source = None
        self.first_layer_height = None
        self.layer_height = None
        self.layers = None
        self.pa_values = None          # list of expected PA values
        self.anchor = None             # 'frame' | 'layer' | 'none'
        self.relative_e = None         # 0 | 1


def parse_bed(text):
    """Accepts '250x250' as well as PrusaSlicer's '0x0,250x0,250x250,0x250'."""
    if not text:
        return None
    numbers = [parse_float(part) for part in re.split(r"[,x×\s]+", text.strip()) if part]
    numbers = [n for n in numbers if n is not None]
    if len(numbers) < 2:
        return None
    return (max(numbers[0::2]), max(numbers[1::2]))


def pa_series(start, end, step):
    """PA series in the integer domain, the same way the generator builds it."""
    if start is None or end is None or step is None or step <= 0:
        return None
    a = int(round(start * PA_SCALE))
    b = int(round(end * PA_SCALE))
    inc = int(round(step * PA_SCALE))
    if inc <= 0 or b < a:
        return None
    count = (b - a) // inc + 1
    if count > 1000:
        return None
    return [(a + j * inc) / PA_SCALE for j in range(count)]


def build_config(args, doc):
    """Options beat the header comment; with neither, the value stays None."""
    cfg = Config()
    head = doc.header

    if args.bed:
        cfg.bed = parse_bed(args.bed)
        cfg.bed_source = "option"
    if cfg.bed is None and head.get("bed"):
        cfg.bed = parse_bed(head["bed"])
        cfg.bed_source = "header"
    if cfg.bed is None and head.get("bed_shape"):
        cfg.bed = parse_bed(head["bed_shape"])
        cfg.bed_source = "bed_shape"

    cfg.first_layer_height = (args.first_layer
                              if args.first_layer is not None
                              else parse_float(head.get("first_layer_height")))
    cfg.layer_height = (args.layer if args.layer is not None
                        else parse_float(head.get("layer_height")))
    if args.layers is not None:
        cfg.layers = args.layers
    else:
        raw_layers = parse_float(head.get("layers"))
        cfg.layers = int(raw_layers) if raw_layers is not None else None

    # an explicit list wins over start/end/step
    if args.pa:
        parts = [parse_float(p) for p in args.pa.split(",")]
        if len(parts) == 3 and None not in parts:
            cfg.pa_values = pa_series(*parts)
    if cfg.pa_values is None and head.get("pa_values"):
        values = [parse_float(p) for p in re.split(r"[,\s]+", head["pa_values"]) if p]
        values = [v for v in values if v is not None]
        cfg.pa_values = values or None
    if cfg.pa_values is None:
        cfg.pa_values = pa_series(parse_float(head.get("pa_start")),
                                  parse_float(head.get("pa_end")),
                                  parse_float(head.get("pa_step")))

    anchor = args.anchor or head.get("anchor")
    if anchor:
        anchor = anchor.strip().lower()
        cfg.anchor = anchor if anchor in ("frame", "layer", "none") else None

    raw_rel = parse_float(head.get("relative_e"))
    cfg.relative_e = int(raw_rel) if raw_rel is not None else None
    return cfg


# ---------------------------------------------------------------------------
# Checks -- each returns exactly one Result
# ---------------------------------------------------------------------------

def check_text_clean(doc, cfg):
    """1) No NaN/undefined/Infinity/null anywhere in the file text."""
    res = Result("text clean")
    hits = []
    for index, line in enumerate(doc.lines, start=1):
        if index in doc.thumb_lines:
            continue              # base64 is noise, a word match means nothing there
        code, comment = strip_comment(line)
        match = DIRTY_CODE_RE.search(code) if code else None
        if match is None and comment:
            match = DIRTY_COMMENT_RE.search(comment)
        if match:
            hits.append((index, "%s in: %s" % (match.group(1), line.strip()[:70])))
    if hits:
        return res.fail("%d bad token(s), first at line %d" % (len(hits), hits[0][0]), hits)
    return res.ok("no NaN/undefined/Infinity/null")


def check_numeric_fields(doc, cfg):
    """2) Every X/Y/Z/E/F in G0/G1 is a finite number."""
    res = Result("numeric fields")
    if not doc.moves:
        return res.skip("no G0/G1 lines")
    hits = []
    for move in doc.moves:
        for letter, text in move.bad:
            hits.append((move.lineno, "%s='%s' in: %s" % (letter, text, move.raw.strip()[:60])))
    if hits:
        return res.fail("%d unparsable field(s)" % len(hits), hits)
    return res.ok("%d moves, all fields finite" % len(doc.moves))


def check_bed_bounds(doc, cfg):
    """3) All X/Y within 0..bedX / 0..bedY."""
    res = Result("bed bounds")
    if cfg.bed is None:
        return res.skip("bed size unknown")
    bed_x, bed_y = cfg.bed
    hits = []
    worst = (0.0, None)               # (deviation, description)
    for move in doc.body_moves:
        for axis, limit in (("X", bed_x), ("Y", bed_y)):
            value = move.get(axis)
            if value is None:
                continue
            deviation = max(-value, value - limit)
            if deviation > 0:
                hits.append((move.lineno, "%s=%.4f outside 0..%.3f" % (axis, value, limit)))
                if deviation > worst[0]:
                    worst = (deviation, "%s=%.4f (line %d, limit %.3f)"
                             % (axis, value, move.lineno, limit))
    if hits:
        return res.fail("%d violation(s), worst %s" % (len(hits), worst[1]), hits)
    return res.ok("all X/Y within %.1fx%.1f (%s)" % (bed_x, bed_y, cfg.bed_source))


def _expected_z_levels(cfg):
    """Expected Z staircase: first_layer_height + n*layer_height."""
    return [cfg.first_layer_height + n * cfg.layer_height for n in range(cfg.layers)]


def check_z_progression(doc, cfg):
    """4) Z of the extruding moves: monotonically rising and on the staircase.

    Only heights at which material is actually extruded are judged: pure Z
    moves (z-hop on travel, lifting at start and end) are normal printer
    behaviour and must not violate the staircase."""
    res = Result("z progression")
    if cfg.first_layer_height is None or cfg.layer_height is None or cfg.layers is None:
        return res.skip("layer heights or layer count unknown")
    levels = _expected_z_levels(cfg)
    top = levels[-1]
    hits = []
    previous = None
    seen = set()
    for move, _px, _py, _x, _y, cur_z in traverse(doc.body_moves):
        if not (move.is_extruding and move.has_xy):
            continue                  # only drawing moves define the layer height
        if cur_z is None:
            continue
        if cur_z > top + Z_TOL:
            hits.append((move.lineno, "extruding above the top layer at Z=%.4f" % cur_z))
            continue
        if previous is not None and cur_z < previous - Z_TOL:
            hits.append((move.lineno, "Z drops %.4f -> %.4f" % (previous, cur_z)))
        previous = cur_z
        if not any(abs(cur_z - level) <= Z_TOL for level in levels):
            hits.append((move.lineno, "Z=%.4f matches no expected level" % cur_z))
        else:
            seen.add(round(cur_z, 6))
    if not seen and not hits:
        return res.skip("no Z values inside the pattern range")
    if hits:
        return res.fail("%d z violation(s)" % len(hits), hits)
    missing = [l for l in levels if round(l, 6) not in seen]
    if missing:
        return res.fail("%d expected level(s) never reached, e.g. %.3f"
                        % (len(missing), missing[0]),
                        [(0, "missing Z level %.3f" % l) for l in missing])
    return res.ok("%d/%d levels, %.3f..%.3f" % (len(seen), len(levels), levels[0], top))


def _pa_per_layer(doc, expected):
    """A single missing command would not show up over the whole file: the
    remaining layers still set that value. Hence per layer — every layer with
    chevrons runs the full series."""
    starts = [i for i, raw in enumerate(doc.lines, start=1)
              if doc.in_body(i) and Z_MARKER_RE.match(raw.strip())]
    if not starts:
        return []

    def layer_of(lineno):
        index = -1
        for k, start in enumerate(starts):
            if start > lineno:
                break
            index = k
        return index

    drawn = set(layer_of(m.lineno) for m in doc.body_moves if m.tag == "pattern")
    per = {}
    for lineno, value, _raw in doc.body_pa_commands:
        if value is not None:
            per.setdefault(layer_of(lineno), set()).add(round(value, 6))
    hits = []
    for layer in sorted(drawn):
        if layer < 0:
            continue
        have = per.get(layer, set())
        missing = [e for e in expected if round(e, 6) not in have]
        if missing:
            hits.append((starts[layer], "layer %d sets %d of %d values, first missing %.4f"
                         % (layer + 1, len(expected) - len(missing), len(expected), missing[0])))
    return hits


def check_pa_commands(doc, cfg):
    """5) PA values come from the expected series, are complete, end = start."""
    res = Result("pa commands")
    if cfg.pa_values is None:
        return res.skip("expected PA series unknown")
    commands = doc.body_pa_commands
    if not commands:
        return res.fail("no PA command found, %d expected values" % len(cfg.pa_values))
    hits = []
    expected = cfg.pa_values
    used = set()
    for lineno, value, raw in commands:
        if value is None:
            hits.append((lineno, "unparsable PA value: %s" % raw[:60]))
            continue
        match = next((e for e in expected if abs(e - value) <= PA_TOL), None)
        if match is None:
            hits.append((lineno, "PA=%.4f not in expected series" % value))
        else:
            used.add(round(match, 6))
    for value in expected:
        if round(value, 6) not in used:
            hits.append((0, "expected PA %.4f never set" % value))
    last_line, last_value, last_raw = commands[-1]
    if last_value is None or abs(last_value - expected[0]) > PA_TOL:
        hits.append((last_line, "last PA command does not restore %.4f: %s"
                     % (expected[0], last_raw[:60])))
    hits.extend(_pa_per_layer(doc, expected))
    if hits:
        return res.fail("%d PA issue(s) over %d command(s)" % (len(hits), len(commands)), hits)
    return res.ok("%d commands, %d/%d values, restored to %.4f"
                  % (len(commands), len(used), len(expected), expected[0]))


def extrusion_stats(doc):
    """Sum of the positive E values and largest single move (only meaningful with M83)."""
    total = 0.0
    largest = 0.0
    for move in doc.body_moves:
        e = move.get("E")
        if e is None or e <= 0:
            continue
        total += e
        if e > largest:
            largest = e
    return total, largest


def filament_volume_cm3(total_mm):
    return total_mm * math.pi * (FILAMENT_DIAMETER / 2.0) ** 2 / 1000.0


def check_extrusion(doc, cfg):
    """6) Sum of the E values plausible, no excessive E per travelled length."""
    res = Result("extrusion")
    if not doc.relative_mode:
        return res.skip("no M83, relative E sum not meaningful")
    total, largest = extrusion_stats(doc)
    volume = filament_volume_cm3(total)
    hits = []
    if total <= 0:
        hits.append((0, "total extrusion is %.4f mm" % total))
    # A fixed per-move ceiling is no good: an anchor frame around a wide pattern
    # is legitimately over 200 mm long and carries the material to match. Judged
    # is therefore E per mm of travel; only pure E moves (retract, prime) keep
    # the fixed limit.
    for move, px, py, x2, y2, _z in traverse(doc.body_moves):
        e = move.get("E")
        if e is None or e <= 0:
            continue
        length = 0.0
        if move.has_xy and px is not None and py is not None:
            length = math.hypot(x2 - px, y2 - py)
        if length > 1e-9:
            rate = e / length
            if rate > MAX_E_PER_MM:
                hits.append((move.lineno, "E=%.4f mm over %.3f mm = %.4f mm/mm > %.2f"
                             % (e, length, rate, MAX_E_PER_MM)))
        elif e > MAX_SINGLE_E:
            hits.append((move.lineno, "single E=%.4f mm without travel > %.1f mm"
                         % (e, MAX_SINGLE_E)))
    summary = "%.2f mm filament = %.3f cm3, max single E %.4f mm" % (total, volume, largest)
    if hits:
        return res.fail(summary, hits)
    return res.ok(summary)


def check_extrusion_geometry(doc, cfg):
    """6b) Target vs. actual: does every drawing move carry the E its length,
    line width and layer height require?

    Catches a systematic factor error, which a plausibility limit would not
    notice."""
    res = Result("extrusion geometry")
    need = ("extrusion_width", "anchor_width", "filament_diameter",
            "extrusion_multiplier", "first_layer_height", "layer_height")
    vals = {}
    for key in need:
        value = parse_float(doc.header.get(key, ""))
        if value is None or value <= 0:
            return res.skip("header lacks %s" % key)
        vals[key] = value
    fil_area = math.pi * (vals["filament_diameter"] / 2.0) ** 2

    hits = []
    checked = 0
    worst = 0.0
    for move, px, py, x2, y2, cur_z in traverse(doc.body_moves):
        e = move.get("E")
        marker = move.tag
        if not (e is not None and e > 0 and move.has_xy
                and px is not None and py is not None and marker in MARKERS
                and cur_z is not None):
            continue
        length = math.hypot(x2 - px, y2 - py)
        # layer 1 runs at first_layer_height, all others at layer_height
        h = (vals["first_layer_height"]
             if abs(cur_z - vals["first_layer_height"]) < 1e-6 else vals["layer_height"])
        w = vals["anchor_width"] if marker in ("anchor", "tab") else vals["extrusion_width"]
        area = (w - h) * h + math.pi * (h / 2.0) ** 2
        expect = length * area / fil_area * vals["extrusion_multiplier"]
        if expect > 0:
            checked += 1
            deviation = abs(e - expect)
            if deviation > worst:
                worst = deviation
            if deviation > max(2e-5, expect * 0.01):
                hits.append((move.lineno,
                             "E=%.5f but %.5f expected (%.3f mm at w=%.2f h=%.2f)"
                             % (e, expect, length, w, h)))

    if checked == 0:
        return res.skip("no tagged extruding moves")
    if hits:
        return res.fail("%d of %d moves off the geometric expectation" % (len(hits), checked), hits)
    return res.ok("%d moves match geometry, worst deviation %.6f mm" % (checked, worst))


def check_e_mode(doc, cfg):
    """7) M83 before the first extruding move, E mode set before the end block."""
    res = Result("e mode")
    if not doc.relative_mode:
        return res.skip("no M83 in file")
    hits = []
    first_extruding = next((m for m in doc.moves if m.is_extruding and m.has_xy), None)
    if first_extruding is None:
        return res.skip("no extruding move found")
    if doc.m83_lines[0] > first_extruding.lineno:
        hits.append((first_extruding.lineno,
                     "first extruding move precedes M83 (line %d)" % doc.m83_lines[0]))
    detail = "M83 at line %d" % doc.m83_lines[0]

    end_line = doc.first_end_block
    if cfg.relative_e is None:
        detail += ", slicer E mode unknown -> restore not checked"
    elif end_line is None:
        detail += ", no end block -> restore not checked"
    else:
        wanted = "M83" if cfg.relative_e == 1 else "M82"
        candidates = [(n, "M83") for n in doc.m83_lines if n < end_line]
        candidates += [(n, "M82") for n in doc.m82_lines if n < end_line]
        candidates.sort()
        if not candidates or candidates[-1][1] != wanted:
            found = candidates[-1][1] if candidates else "nothing"
            hits.append((end_line, "expected %s before end block, found %s" % (wanted, found)))
        else:
            detail += ", %s restored at line %d" % (wanted, candidates[-1][0])
    if hits:
        return res.fail(detail, hits)
    return res.ok(detail)


def check_retraction_balance(doc, cfg):
    """8) Pure E moves: retract and unretract must balance out."""
    res = Result("retraction balance")
    if not doc.relative_mode:
        return res.skip("no M83, retract detection unreliable")
    retracts = []
    unretracts = []
    for move in doc.body_moves:
        e = move.get("E")
        if e is None or move.has_xy or "Z" in move.params:
            continue
        if e < 0:
            retracts.append(move.lineno)
        elif e > 0:
            unretracts.append(move.lineno)
    if not retracts and not unretracts:
        return res.skip("no pure E moves found")
    difference = abs(len(retracts) - len(unretracts))
    summary = "%d retract / %d unretract" % (len(retracts), len(unretracts))
    if difference > 1:
        surplus = retracts if len(retracts) > len(unretracts) else unretracts
        return res.fail("%s, difference %d" % (summary, difference),
                        [(n, "unbalanced pure E move") for n in surplus[-5:]])
    return res.ok("%s, difference %d" % (summary, difference))


def check_structure(doc, cfg):
    """9) Exactly one end block marker, with at least one extrusion before it."""
    res = Result("structure")
    if not doc.moves:
        return res.skip("no G0/G1 lines, not a printable file")
    count = len(doc.end_block_lines)
    if count != 1:
        return res.fail("found %d '%s' marker(s), expected 1" % (count, END_MARKER),
                        [(n, "end block marker") for n in doc.end_block_lines])
    end_line = doc.end_block_lines[0]
    extruding = [m for m in doc.moves if m.is_extruding and m.lineno < end_line]
    if not extruding:
        return res.fail("no extruding move before the end block at line %d" % end_line)
    return res.ok("end block at line %d, %d extruding moves before it"
                  % (end_line, len(extruding)))


def marker_counts(doc):
    """Counts the comment markers of extruding lines."""
    counts = dict((m, 0) for m in MARKERS)
    untagged = []
    for move in doc.body_moves:
        # drawing moves only; a pure unretract carries no marker
        if not (move.is_extruding and move.has_xy):
            continue
        if move.tag in counts:
            counts[move.tag] += 1
        else:
            untagged.append(move)
    return counts, untagged


def marker_summary(counts):
    return ", ".join("%s=%d" % (name, counts[name]) for name in MARKERS)


def check_markers(doc, cfg):
    """10) Extruding lines carry a marker; anchor rule depends on the variant."""
    res = Result("comment markers")
    counts, untagged = marker_counts(doc)
    total = sum(counts.values())
    if total == 0:
        return res.skip("no pattern/anchor/glyph/tab markers -> foreign file")
    summary = marker_summary(counts)
    hits = [(m.lineno, "extruding move without marker: %s" % m.raw.strip()[:60])
            for m in untagged]
    if cfg.anchor == "none" and counts["anchor"] > 0:
        hits.append((0, "anchor=none but %d '; anchor' lines present" % counts["anchor"]))
    elif cfg.anchor in ("frame", "layer") and counts["anchor"] == 0:
        hits.append((0, "anchor=%s but no '; anchor' line present" % cfg.anchor))
    if hits:
        return res.fail("%s (%d issue(s))" % (summary, len(hits)), hits)
    return res.ok(summary)


def parse_hms(text):
    """"1h 52m 0s" -> seconds, None if nothing usable is in there."""
    match = re.search(r"(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?", text.strip())
    if not any(match.groups()):
        return None
    h, m, sec = (int(g) if g else 0 for g in match.groups())
    return h * 3600 + m * 60 + sec


def check_statistics(doc, cfg):
    """13) Consumption, remaining time and progress describe this print.

    Moonraker and the printer firmware read these values from the slicer's
    config block; if they still refer to the source model, web interface and
    display show nonsense."""
    res = Result("print statistics")
    want_mm = parse_float(doc.header.get("filament_mm", ""))
    want_time = parse_float(doc.header.get("estimated_time_s", ""))
    if want_mm is None or want_time is None:
        return res.skip("header lacks filament_mm/estimated_time_s")

    hits = []

    # Net E in the generated part: retract and unretract cancel out.
    net = 0.0
    for move in doc.body_moves:
        e = move.get("E")
        if e is not None:
            net += e
    if want_mm > 0 and abs(net - want_mm) > max(0.5, want_mm * 0.02):
        hits.append((0, "header says %.2f mm, generated part extrudes %.2f mm" % (want_mm, net)))

    seen = {"mm": 0, "time": 0}
    for index, raw in enumerate(doc.lines, start=1):
        stripped = raw.strip()
        m = re.match(r"^;\s*filament used \[mm\]\s*=\s*([-\d.,]+)\s*$", stripped, re.I)
        if m:
            seen["mm"] += 1
            value = parse_float(m.group(1).split(",")[0])
            if value is None or abs(value - want_mm) > max(0.5, want_mm * 0.005):
                hits.append((index, "filament used [mm] = %s, expected %.2f" % (m.group(1), want_mm)))
        m = re.match(r"^;\s*estimated printing time \(normal mode\)\s*=\s*(.*)$", stripped, re.I)
        if m:
            seen["time"] += 1
            value = parse_hms(m.group(1))
            if value is None or abs(value - want_time) > 1.5:
                hits.append((index, "estimated printing time = %s, expected %d s" % (m.group(1), want_time)))

    # Without this a file carrying neither line would pass as "0 filament
    # line(s)" - they were only counted above.
    if seen["mm"] == 0:
        hits.append((0, "no '; filament used [mm]' line in the file"))
    if seen["time"] == 0:
        hits.append((0, "no '; estimated printing time (normal mode)' line in the file"))

    # Progress: P rises monotonically and ends at 100
    percents = []
    for index, raw in enumerate(doc.lines, start=1):
        m = re.match(r"^M73\s+P(\d+)\s+R(\d+)\s*$", raw.strip(), re.I)
        if m:
            percents.append((index, int(m.group(1))))
    for i in range(1, len(percents)):
        if percents[i][1] < percents[i - 1][1]:
            hits.append((percents[i][0], "M73 progress goes backwards: %d after %d"
                         % (percents[i][1], percents[i - 1][1])))
            break
    if percents and percents[-1][1] != 100:
        hits.append((percents[-1][0], "last M73 is P%d, expected P100" % percents[-1][1]))

    if hits:
        return res.fail("%d problem(s)" % len(hits), hits)
    return res.ok("%.2f mm, %s, %d filament line(s), %d time line(s), %d M73"
                  % (want_mm, format_hms(want_time), seen["mm"], seen["time"], len(percents)))


def format_hms(sec):
    sec = int(round(sec))
    h, m, s = sec // 3600, (sec % 3600) // 60, sec % 60
    parts = []
    if h:
        parts.append("%dh" % h)
    if h or m:
        parts.append("%dm" % m)
    parts.append("%ds" % s)
    return " ".join(parts)


def check_layer_markers(doc, cfg):
    """14) Layer markers: one group per layer, Z matches the layer height."""
    res = Result("layer markers")
    if doc.body_from is None:
        return res.skip("no generated part")
    changes, zvalues, current_layers = [], [], []
    total_layer = None
    for index, raw in enumerate(doc.lines, start=1):
        if not doc.in_body(index):
            continue
        stripped = raw.strip()
        if stripped == ";LAYER_CHANGE":
            changes.append(index)
        m = Z_MARKER_RE.match(stripped)
        if m:
            zvalues.append((index, parse_float(m.group(1))))
        m = re.match(r"^SET_PRINT_STATS_INFO\s+TOTAL_LAYER=(\d+)", stripped)
        if m:
            total_layer = int(m.group(1))
        m = re.match(r"^SET_PRINT_STATS_INFO\s+CURRENT_LAYER=(\d+)", stripped)
        if m:
            current_layers.append(int(m.group(1)))
    if not changes:
        return res.skip("no ;LAYER_CHANGE in the generated part")

    hits = []
    if cfg.layers is not None and len(changes) != cfg.layers:
        hits.append((changes[0], "%d ;LAYER_CHANGE for %d layers" % (len(changes), cfg.layers)))
    if len(zvalues) != len(changes):
        hits.append((changes[0], "%d ;Z: for %d ;LAYER_CHANGE" % (len(zvalues), len(changes))))
    if cfg.first_layer_height is not None and cfg.layer_height is not None:
        for i, (index, z) in enumerate(zvalues):
            want = cfg.first_layer_height + i * cfg.layer_height
            if z is None or abs(z - want) > 1e-6:
                hits.append((index, ";Z:%s but layer %d is at %.3f" % (z, i + 1, want)))
    flavor = doc.header.get("gcode_flavor", "")
    if flavor == "klipper":
        if total_layer != len(changes):
            hits.append((0, "SET_PRINT_STATS_INFO TOTAL_LAYER=%s for %d layers"
                         % (total_layer, len(changes))))
        if current_layers != list(range(1, len(changes) + 1)):
            hits.append((0, "CURRENT_LAYER sequence is %s" % current_layers))
    if hits:
        return res.fail("%d problem(s)" % len(hits), hits)
    return res.ok("%d layers, z %s" % (len(changes), ", ".join("%g" % z for _, z in zvalues)))


def _spec_text(specs):
    return ", ".join("%dx%d/%s" % spec for spec in specs)


def check_thumbnails(doc, cfg):
    """12) Thumbnails: block shape, length field, format, size, completeness.

    Moonraker silently discards an image whose declared character count is
    wrong; Prusa firmware only shows exactly matching resolutions. Both are
    recomputed here rather than taken on faith.
    """
    res = Result("thumbnails")
    hits = []

    wanted = []
    if doc.thumb_config:
        for part in doc.thumb_config.split(","):
            part = part.strip()
            if not part:
                continue
            match = THUMB_SPEC_RE.match(part)
            if not match:
                continue
            # without "/FMT" the separate thumbnails_format entry applies (old format)
            fmt = (match.group(3) or doc.thumb_format or "PNG").upper()
            wanted.append((int(match.group(1)), int(match.group(2)), fmt))

    if not doc.thumbnails:
        generatable = [w for w in wanted if w[2] in GENERATED_FORMATS]
        if generatable:
            return res.skip("no thumbnails in file (%d generatable in profile)" % len(generatable))
        return res.skip("no thumbnails in file and none requested by the profile")

    found = []
    for entry in doc.thumbnails:
        label = "%s %dx%d (line %d)" % (entry["tag"], entry["w"], entry["h"], entry["lineno"])
        if not entry["closed"]:
            hits.append((entry["lineno"], "%s: block is not terminated" % label))
            continue
        if len(entry["data"]) != entry["declared"]:
            hits.append((entry["lineno"], "%s: header says %d base64 chars, block has %d"
                         % (label, entry["declared"], len(entry["data"]))))
            continue
        try:
            blob = base64.b64decode(entry["data"], validate=True)
        except Exception as exc:                      # noqa: BLE001
            hits.append((entry["lineno"], "%s: base64 does not decode (%s)" % (label, exc)))
            continue

        fmt = entry["tag"].partition("_")[2].upper() or "PNG"
        if fmt == "PNG":
            magic_ok = blob[:8] == b"\x89PNG\r\n\x1a\n" and blob[12:16] == b"IHDR"
            size = (int.from_bytes(blob[16:20], "big"), int.from_bytes(blob[20:24], "big")) if magic_ok else None
        elif fmt == "QOI":
            magic_ok = blob[:4] == b"qoif"
            size = (int.from_bytes(blob[4:8], "big"), int.from_bytes(blob[8:12], "big")) if magic_ok else None
        elif fmt == "JPG":
            magic_ok = blob[:2] == b"\xff\xd8"
            size = None
        else:
            hits.append((entry["lineno"], "%s: unknown thumbnail format" % label))
            continue

        if not magic_ok:
            hits.append((entry["lineno"], "%s: decoded data is not %s" % (label, fmt)))
            continue
        if size is not None and size != (entry["w"], entry["h"]):
            hits.append((entry["lineno"], "%s: image is %dx%d" % (label, size[0], size[1])))
            continue
        if doc.body_from is not None and entry["lineno"] > doc.body_from:
            hits.append((entry["lineno"], "%s: sits behind the pattern, should be at the top of the file" % label))
            continue
        found.append((entry["w"], entry["h"], fmt))

    # Completeness against the profile: everything generatable must be there,
    # in the profile's order, and nothing may appear twice.
    if wanted:
        expected = [w for w in wanted if w[2] in GENERATED_FORMATS]
        if found != expected:
            hits.append((0, "profile asks for %s, file has %s"
                         % (_spec_text(expected) or "nothing",
                            _spec_text(found) or "nothing")))

    if hits:
        return res.fail("%d problem(s)" % len(hits), hits)
    return res.ok("%d thumbnail(s), %s" % (len(found), _spec_text(found)))


def check_probe_area(doc, cfg):
    """15) The area the printer probes covers the whole pattern.

    Prusa firmware takes it from M555 and only extrapolates outside it; klipper
    derives it from the object definitions. Both describe the model that was
    sliced, which has nothing to do with where the pattern lands, so the
    generator rewrites whichever of the two the file carries.
    """
    res = Result("probe area")
    rect = None
    source = None
    polygons = []
    for raw in doc.lines:
        stripped = raw.strip()
        if not stripped or stripped.startswith(";"):
            continue
        match = XO_DEFINE_RE.match(stripped)
        if match:
            pairs = re.findall(r"\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]", match.group(1))
            if pairs:
                polygons.append([(float(a), float(b)) for a, b in pairs])
            continue
        if rect is not None or not M555_RE.match(stripped):
            continue
        code, _ = strip_comment(raw)
        vals = {}
        for letter, text in re.findall(r"(?:^|\s)([XYWH])(-?(?:\d+(?:\.\d*)?|\.\d+))",
                                       code.upper()):
            vals[letter] = float(text)
        if len(vals) == 4 and vals["W"] > 0 and vals["H"] > 0:
            rect = (vals["X"], vals["Y"], vals["X"] + vals["W"], vals["Y"] + vals["H"])
            source = "M555"
    # Klipper: the area follows the object definitions, and the generator leaves
    # exactly one behind -- the pattern's. A second one means a definition of the
    # sliced model survived, and the mesh would cover that too.
    if rect is None and polygons:
        if len(polygons) > 1:
            return res.fail("%d EXCLUDE_OBJECT_DEFINE, expected one for the pattern"
                            % len(polygons))
        points = polygons[0]
        rect = (min(p[0] for p in points), min(p[1] for p in points),
                max(p[0] for p in points), max(p[1] for p in points))
        source = "EXCLUDE_OBJECT_DEFINE"
    elif rect is not None and len(polygons) > 1:
        return res.fail("%d EXCLUDE_OBJECT_DEFINE, expected at most one" % len(polygons))
    if rect is None:
        return res.skip("neither M555 nor EXCLUDE_OBJECT_DEFINE in the file")

    x0 = y0 = x1 = y1 = None
    for move, px, py, nx, ny, _z in traverse(doc.body_moves):
        if not (move.is_extruding and move.has_xy):
            continue
        for ax, ay in ((px, py), (nx, ny)):
            if ax is None or ay is None:
                continue
            x0 = ax if x0 is None else min(x0, ax)
            x1 = ax if x1 is None else max(x1, ax)
            y0 = ay if y0 is None else min(y0, ay)
            y1 = ay if y1 is None else max(y1, ay)
    if x0 is None:
        return res.skip("no extruding move in the pattern")

    hits = []
    for value, limit, name in ((x0, rect[0], "left"), (y0, rect[1], "bottom")):
        if value < limit - 1e-6:
            hits.append((0, "pattern reaches %.3f mm past the %s edge of the probe area"
                         % (limit - value, name)))
    for value, limit, name in ((x1, rect[2], "right"), (y1, rect[3], "top")):
        if value > limit + 1e-6:
            hits.append((0, "pattern reaches %.3f mm past the %s edge of the probe area"
                         % (value - limit, name)))
    if cfg.bed is not None:
        bed_x, bed_y = cfg.bed
        if rect[0] < -1e-6 or rect[1] < -1e-6 or rect[2] > bed_x + 1e-6 or rect[3] > bed_y + 1e-6:
            hits.append((0, "probe area %.1f/%.1f..%.1f/%.1f leaves the bed %.1fx%.1f"
                         % (rect + (bed_x, bed_y))))
    summary = ("%s %.1f/%.1f..%.1f/%.1f, pattern %.1f/%.1f..%.1f/%.1f, margin %.2f mm"
               % ((source,) + rect + (x0, y0, x1, y1)
                  + (min(x0 - rect[0], y0 - rect[1], rect[2] - x1, rect[3] - y1),)))
    if hits:
        return res.fail(summary, hits)
    return res.ok(summary)


CHECKS = (
    check_text_clean,
    check_numeric_fields,
    check_bed_bounds,
    check_z_progression,
    check_pa_commands,
    check_extrusion,
    check_extrusion_geometry,
    check_e_mode,
    check_retraction_balance,
    check_structure,
    check_markers,
    check_thumbnails,
    check_statistics,
    check_layer_markers,
    check_probe_area,
)


# ---------------------------------------------------------------------------
# Statistics and output
# ---------------------------------------------------------------------------

def collect_statistics(doc, cfg):
    stats = []
    stats.append(("lines", "%d" % len(doc.lines)))
    if doc.body_from is not None:
        stats.append(("generated part", "lines %d..%d (slicer start/end block excluded)"
                      % (doc.body_from, doc.body_to)))
    moves = doc.body_moves
    stats.append(("G0/G1 moves", "%d" % len(moves)))

    z_values = sorted(set(round(m.get("Z"), 3) for m in moves if m.get("Z") is not None))
    if cfg.first_layer_height is not None and cfg.layer_height is not None \
            and cfg.layers is not None:
        top = _expected_z_levels(cfg)[-1]
        z_values = [z for z in z_values if z <= top + 1e-3]
    z_range = " (%.3f..%.3f)" % (z_values[0], z_values[-1]) if z_values else ""
    stats.append(("layers found", "%d%s" % (len(z_values), z_range)))

    pa_seen = sorted(set(round(v, 4) for _, v, _ in doc.body_pa_commands if v is not None))
    if pa_seen:
        stats.append(("PA values found", "%d (%.4f..%.4f)"
                      % (len(pa_seen), pa_seen[0], pa_seen[-1])))
    else:
        stats.append(("PA values found", "0"))

    if doc.relative_mode:
        total, _ = extrusion_stats(doc)
        stats.append(("filament", "%.2f mm / %.3f cm3" % (total, filament_volume_cm3(total))))
    else:
        stats.append(("filament", "n/a (absolute E)"))
    draw = prime = 0.0
    for move in moves:
        e = move.get("E")
        if e is None or e <= 0:
            continue
        if move.has_xy:
            draw += e
        else:
            prime += e
    stats.append(("  of which extruded", "%.2f mm" % draw))
    stats.append(("  of which unretract", "%.2f mm" % prime))

    counts, _ = marker_counts(doc)
    tagged = [m for m in moves if m.is_extruding and m.tag in MARKERS]
    extent_source = tagged or [m for m in moves if m.is_extruding and m.has_xy]
    xs = [m.get("X") for m in extent_source if m.get("X") is not None]
    ys = [m.get("Y") for m in extent_source if m.get("Y") is not None]
    if xs and ys:
        stats.append(("pattern extent", "X %.2f..%.2f  Y %.2f..%.2f"
                      % (min(xs), max(xs), min(ys), max(ys))))
    else:
        stats.append(("pattern extent", "n/a"))
    if sum(counts.values()):
        stats.append(("markers", marker_summary(counts)))
    return stats


def report(results, stats, doc, verbose):
    """Compact table, statistics, summary."""
    print("File: %s (%s)" % (doc.path, human_size(doc.path)))
    print("")
    width = max(len(r.name) for r in results)
    for result in results:
        print("%-4s  %-*s  %s" % (result.status, width, result.name, result.info))
        if verbose and result.status == "FAIL" and result.violations:
            for lineno, text in result.violations[:5]:
                where = "line %d" % lineno if lineno else "     -"
                print("        %s: %s" % (where, text))
            if len(result.violations) > 5:
                print("        ... %d more" % (len(result.violations) - 5))
    print("")
    print("Statistics")
    key_width = max(len(k) for k, _ in stats)
    for key, value in stats:
        print("  %-*s  %s" % (key_width, key, value))
    print("")
    failed = [r for r in results if r.status == "FAIL"]
    skipped = [r for r in results if r.status == "SKIP"]
    passed = [r for r in results if r.status == "PASS"]
    print("Summary: %d passed, %d failed, %d skipped (of %d checks)"
          % (len(passed), len(failed), len(skipped), len(results)))
    if failed:
        print("Failed:  %s" % ", ".join(r.name for r in failed))
    if skipped and not verbose:
        print("Skipped: %s" % ", ".join(r.name for r in skipped))
    return 1 if failed else 0


def human_size(path):
    try:
        size = os.path.getsize(path)
    except OSError:
        return "?"
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return "%.1f %s" % (size, unit)
        size /= 1024.0


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def build_parser():
    parser = argparse.ArgumentParser(
        description="Plausibility check for generated PA calibration g-code.")
    parser.add_argument("gcode", help="generated .gcode file")
    parser.add_argument("--bed", help="bed size, e.g. 250x250")
    parser.add_argument("--first-layer", type=float, dest="first_layer",
                        help="first layer height in mm")
    parser.add_argument("--layer", type=float, help="layer height in mm")
    parser.add_argument("--layers", type=int, help="number of layers")
    parser.add_argument("--pa", help="PA series as start,end,step, e.g. 0,0.08,0.005")
    parser.add_argument("--anchor", choices=("frame", "layer", "none"),
                        help="anchor variant used")
    parser.add_argument("-v", "--verbose", action="store_true",
                        help="show the first 5 violations of each failed check")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    if not os.path.isfile(args.gcode):
        sys.stderr.write("error: file not found: %s\n" % args.gcode)
        return 2
    try:
        doc = Document(args.gcode)
    except (OSError, IOError) as error:
        sys.stderr.write("error: cannot read file: %s\n" % error)
        return 2

    cfg = build_config(args, doc)
    results = []
    for check in CHECKS:
        try:
            results.append(check(doc, cfg))
        except Exception as error:                    # robustness over completeness
            broken = Result(check.__name__)
            broken.fail("internal error: %s: %s" % (type(error).__name__, error))
            results.append(broken)
    stats = collect_statistics(doc, cfg)
    return report(results, stats, doc, args.verbose)


if __name__ == "__main__":
    sys.exit(main())
