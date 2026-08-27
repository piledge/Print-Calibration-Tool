#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Comparison check for the EM calibration test (extrusion multiplier).

The EM generator produces no geometry; it rewrites the E values per object in
an already sliced file. The check is therefore never against a target pattern,
always output against input.

Standard library only. See --help for usage.
Exit code 0 when no check reports FAIL, otherwise 1.
"""

import argparse
import math
import os
import re
import sys

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

FLOW_TOL = 1e-4              # relative tolerance of flow ratio against factor
FACTOR_TOL = 1e-5            # tolerance for factor == em / multiplier
CENTER_TOL = 2.0             # mm, tolerance for the bounding box center in the map
STAT_TOL = 0.01              # 1 percent tolerance for the filament statistics
MAX_E_PER_MM = 0.2           # largest plausible E per mm of travel
MAX_RETRACT = 10.0           # largest plausible backward jump (mm); applies in
                             # both E modes, a retract of this size makes no
                             # sense on any printer
MAX_E_DECIMALS = 5           # number format of PrusaSlicer
EM_MIN = 0.4                 # plausibility limits of the EM value
EM_MAX = 2.0

MAP_BEGIN = "; >>> print_calibration_tool em map begin"
MAP_END = "; <<< print_calibration_tool em map end"
NO_MAP = "no map header, nothing to compare against"

MOVE_RE = re.compile(r"^(G0|G1|G2|G3)(?![0-9])")
CONFIG_RE = re.compile(r"^;\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$")
# The statistics lines from section 6 of the specification. Cost lines are read
# along so check 5 lets them change; they are not recomputed, because the price
# per kg is not in the config block.
STAT_RE = re.compile(r"^;\s*(filament used \[mm\]|filament used \[cm3\]|"
                     r"filament used \[g\]|total filament used \[g\]|"
                     r"filament cost|total filament cost)\s*=\s*"
                     r"(-?[0-9]*\.?[0-9]+)\s*$")
NUMBER_RE = re.compile(r"^-?(?:[0-9]+\.?[0-9]*|\.[0-9]+)$")
E_TOKEN_RE = re.compile(r"(?<=\s)E-?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?=\s|$)")

# Object brackets
DEFINE_RE = re.compile(r"^EXCLUDE_OBJECT_DEFINE\s+NAME=(\S+)")
OBJ_START_RE = re.compile(r"^EXCLUDE_OBJECT_START\s+NAME=(\S+)")
OBJ_END_RE = re.compile(r"^EXCLUDE_OBJECT_END\b")
M486_S_RE = re.compile(r"^M486\s+S(-?\d+)\s*$")
M486_A_RE = re.compile(r"^M486\s+A(.*?)\s*$")

# Map header and cancel commands
MULT_RE = re.compile(r"^;\s*em profile multiplier\s*=\s*(-?[0-9]*\.?[0-9]+)\s*$")
SELECTED_RE = re.compile(r"^;\s*em selected = ([0-9.]+) … ([0-9.]+), (\d+) of (\d+) plates\s*$")
MAP_OBJ_RE = re.compile(r"^;\s*em object\s+(\d+)\s*\|\s*(.*?)\s*\|\s*em=(\S+)\s*\|"
                        r"\s*factor=(\S+)\s*\|\s*x=(\S+)\s*\|\s*y=(\S+)\s*\|"
                        r"\s*(printed|removed[^|]*)\s*$")
SKIP_NOTE_RE = re.compile(r"^;\s*print_calibration_tool:\s*skipped\b")
LAYER_RE = re.compile(r"^;LAYER_CHANGE\s*$")
M73_PR_RE = re.compile(r"^M73\s+P\d+\s+R(\d+)\s*$", re.I)
M73_ANY_RE = re.compile(r"^M73(?![0-9])", re.I)
TIME_RE = re.compile(r"^;\s*estimated printing time", re.I)
XO_END_RE = re.compile(r"^EXCLUDE_OBJECT_END\b", re.I)
# Move with E but without X/Y: retract or deretract.
RETRACT_ONLY_RE = re.compile(r"^G[0-3](?![0-9])(?![^;]*[XY]-?[\d.])[^;]*\sE-?[\d.]")
M486_P_RE = re.compile(r"^M486\s+P(-?\d+)\s*$")
EXCLUDE_OBJ_RE = re.compile(r"^EXCLUDE_OBJECT\s+NAME=(\S+)\s*$")

# In the command part a bare occurrence is enough; in comments a word boundary
# is required so base64 thumbnails do not trip the check.
DIRTY_CODE_RE = re.compile(r"(NaN|undefined|Infinity|null)")
DIRTY_COMMENT_RE = re.compile(r"\b(NaN|undefined|Infinity|null)\b")


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
# Helpers
# ---------------------------------------------------------------------------

def parse_float(text):
    """Converts a gcode number string; None if unparsable or not finite."""
    if not text:
        return None
    try:
        value = float(text)
    except (TypeError, ValueError):
        return None
    if math.isnan(value) or math.isinf(value):
        return None
    return value


def first_float(text):
    """First number of a possibly comma separated config value."""
    if text is None:
        return None
    return parse_float(text.split(",")[0].strip())


def command_part(line):
    """Command part of a line, without comment and surrounding whitespace."""
    pos = line.find(";")
    if pos >= 0:
        line = line[:pos]
    return line.strip()


def blank_e(line):
    """Replaces the E value of a move line with a placeholder.

    In absolute E mode a scaled predecessor shifts every later absolute value,
    even outside the object brackets. Compared there is therefore the line
    without its E value, plus the sequence of E deltas.
    """
    return E_TOKEN_RE.sub("E*", line)


def close_to(a, b, tol):
    """Relative comparison with an absolute lower bound."""
    if a is None or b is None:
        return False
    return abs(a - b) <= tol * max(1.0, abs(a), abs(b))


# ---------------------------------------------------------------------------
# Object and file model
# ---------------------------------------------------------------------------

class ObjectInfo:
    """A print object of the source file with the quantities measured from it."""

    def __init__(self, oid, name, token):
        self.id = oid
        self.name = name              # plain name (without quotes)
        self.token = token            # NAME token verbatim, quotes included
        self.flow = 0.0               # sum of the positive extrusion deltas
        self.blocks = 0               # number of object blocks (declaration excluded)
        self.min_x = None
        self.max_x = None
        self.min_y = None
        self.max_y = None

    def center(self):
        """Center of the bounding box of extruding moves, None when empty."""
        if self.min_x is None:
            return None
        return ((self.min_x + self.max_x) / 2.0, (self.min_y + self.max_y) / 2.0)

    def note(self, x, y):
        if x is None or y is None:
            return
        if self.min_x is None:
            self.min_x = self.max_x = x
            self.min_y = self.max_y = y
            return
        if x < self.min_x:
            self.min_x = x
        if x > self.max_x:
            self.max_x = x
        if y < self.min_y:
            self.min_y = y
        if y > self.max_y:
            self.max_y = y


class Scan:
    """A single pass over one file; collects everything needed."""

    def __init__(self, path):
        self.path = path
        with open(path, "r", errors="replace") as handle:
            self.lines = handle.read().split("\n")
        if self.lines and self.lines[-1] == "":
            self.lines.pop()

        self.config = {}
        self._read_config()
        self.flavor = (self.config.get("gcode_flavor") or "").strip().lower()
        self.multiplier = first_float(self.config.get("extrusion_multiplier"))
        self.diameter = first_float(self.config.get("filament_diameter"))
        self.density = first_float(self.config.get("filament_density"))
        relative = first_float(self.config.get("use_relative_e_distances"))
        self.absolute_e = not (relative is not None and relative >= 0.5)

        self.marlin_markers = False   # M486 seen? decides which cancel command to use
        self.objects = {}             # id -> ObjectInfo
        self.order = []               # declaration order of the ids
        self.blocks = []              # (id, start_idx, end_idx), declaration excluded
        self.inside = bytearray(len(self.lines))   # 1 = line inside an object block
        self.retracts = []            # sequence of the retract/deretract deltas
        self.extruded_mm = 0.0        # positive deltas with XY, whole file
        self.outside_deltas = []      # E deltas of the lines outside the brackets
        self.stat_lines = []          # (idx, key, value)
        self.stat_index = set()
        self.bad_numbers = []         # (line number, text) for check 9
        self.over_extrusion = []      # (line number, text)
        self.big_backsteps = []       # (line number, text)
        self.dirty = []               # (line number, text)
        self._scan()

    # -- config block -----------------------------------------------------

    def _read_config(self):
        """The ; key = value block; PrusaSlicer writes it at the end (and partly at the top)."""
        for line in self.lines:
            if not line.startswith(";"):
                continue
            match = CONFIG_RE.match(line)
            if match:
                self.config[match.group(1)] = match.group(2)

    # -- main pass --------------------------------------------------------

    def _scan(self):
        lines = self.lines
        absolute_e = self.absolute_e
        absolute_xyz = True
        in_e = 0.0
        cur_x = None
        cur_y = None
        cur = None                    # open ObjectInfo
        block_start = None            # index of the opening bracket
        block_is_decl = False
        by_name = {}

        for idx, line in enumerate(lines):
            if not line:
                continue

            if line[0] == ";":
                match = STAT_RE.match(line)
                if match:
                    value = parse_float(match.group(2))
                    self.stat_lines.append((idx, match.group(1), value))
                    self.stat_index.add(idx)
                if DIRTY_COMMENT_RE.search(line):
                    self.dirty.append((idx + 1, line[:80]))
                continue

            cmd = command_part(line)
            if not cmd:
                continue
            if DIRTY_CODE_RE.search(cmd):
                self.dirty.append((idx + 1, cmd[:80]))

            first = cmd[0]

            # -- object brackets, klipper --------------------------------
            if first == "E":
                match = DEFINE_RE.match(cmd)
                if match:
                    token = match.group(1)
                    oid = len(self.order)
                    info = ObjectInfo(oid, token.strip("'\""), token)
                    self.objects[oid] = info
                    self.order.append(oid)
                    by_name[info.name] = info
                    continue
                match = OBJ_START_RE.match(cmd)
                if match:
                    name = match.group(1).strip("'\"")
                    cur = by_name.get(name)
                    if cur is None:
                        cur = ObjectInfo(-1, name, match.group(1))
                    block_start = idx
                    block_is_decl = False
                    continue
                if OBJ_END_RE.match(cmd):
                    self._close_block(cur, block_start, idx, block_is_decl)
                    cur = None
                    block_start = None
                    continue
                continue

            # -- object brackets and E mode, marlin ----------------------
            if first == "M":
                if cmd.startswith("M486"):
                    match = M486_S_RE.match(cmd)
                    if match:
                        self.marlin_markers = True
                        number = int(match.group(1))
                        if number < 0:
                            self._close_block(cur, block_start, idx, block_is_decl)
                            cur = None
                            block_start = None
                        else:
                            cur = self.objects.get(number)
                            if cur is None:
                                cur = ObjectInfo(number, "", "")
                                self.objects[number] = cur
                            block_start = idx
                            block_is_decl = False
                        continue
                    match = M486_A_RE.match(cmd)
                    if match and cur is not None:
                        # name line: marks the declaration block
                        cur.name = match.group(1)
                        cur.token = match.group(1)
                        block_is_decl = True
                        if cur.id not in self.order:
                            self.order.append(cur.id)
                        continue
                    continue
                if cmd.startswith("M82"):
                    absolute_e = True
                elif cmd.startswith("M83"):
                    absolute_e = False
                continue

            if first != "G":
                continue

            if cmd.startswith("G92"):
                for token in cmd.split()[1:]:
                    key = token[:1]
                    if key == "E":
                        value = parse_float(token[1:])
                        if value is not None:
                            in_e = value
                    elif key == "X":
                        cur_x = parse_float(token[1:])
                    elif key == "Y":
                        cur_y = parse_float(token[1:])
                continue
            if cmd == "G90":
                absolute_xyz = True
                continue
            if cmd == "G91":
                absolute_xyz = False
                continue

            match = MOVE_RE.match(cmd)
            if not match:
                continue
            # Arcs extrude like any other move and are counted everywhere. Only
            # the over-extrusion check skips them: it measures the path as a
            # chord, which is shorter than the arc.
            is_arc = match.group(1) in ("G2", "G3")

            new_x = None
            new_y = None
            e_text = None
            for token in cmd.split()[1:]:
                key = token[:1]
                if key == "X":
                    new_x = parse_float(token[1:])
                elif key == "Y":
                    new_y = parse_float(token[1:])
                elif key == "E":
                    e_text = token[1:]

            has_xy = new_x is not None or new_y is not None
            if absolute_xyz:
                next_x = new_x if new_x is not None else cur_x
                next_y = new_y if new_y is not None else cur_y
                if cur_x is not None and cur_y is not None \
                        and next_x is not None and next_y is not None:
                    distance = math.hypot(next_x - cur_x, next_y - cur_y)
                else:
                    distance = None
            else:
                next_x = (cur_x or 0.0) + (new_x or 0.0)
                next_y = (cur_y or 0.0) + (new_y or 0.0)
                distance = math.hypot(new_x or 0.0, new_y or 0.0)

            if e_text is not None:
                value = parse_float(e_text)
                if value is None or not NUMBER_RE.match(e_text):
                    self.bad_numbers.append((idx + 1, "unparsable E: %s" % cmd[:70]))
                else:
                    decimals = len(e_text.split(".")[1]) if "." in e_text else 0
                    if decimals > MAX_E_DECIMALS:
                        self.bad_numbers.append(
                            (idx + 1, "%d decimals in E%s" % (decimals, e_text)))
                    delta = (value - in_e) if absolute_e else value
                    if absolute_e:
                        in_e = value
                    if cur is None:
                        self.outside_deltas.append(delta)
                    if delta > 0.0 and has_xy:
                        self.extruded_mm += delta
                        if cur is not None:
                            cur.flow += delta
                            cur.note(next_x, next_y)
                            if distance and not is_arc \
                                    and delta / distance > MAX_E_PER_MM:
                                self.over_extrusion.append(
                                    (idx + 1, "%.4f mm E over %.4f mm path"
                                     % (delta, distance)))
                    elif delta != 0.0:
                        self.retracts.append(delta)
                        if delta < -MAX_RETRACT:
                            self.big_backsteps.append(
                                (idx + 1, "E jumps back by %.4f mm" % delta))

            cur_x = next_x
            cur_y = next_y

    def _close_block(self, cur, block_start, end_idx, is_decl):
        """Closes an object bracket and marks its content."""
        if cur is None or block_start is None or is_decl:
            return
        cur.blocks += 1
        self.blocks.append((cur.id, block_start, end_idx))
        for pos in range(block_start + 1, end_idx):
            self.inside[pos] = 1


# ---------------------------------------------------------------------------
# Map header of the output
# ---------------------------------------------------------------------------

class MapEntry:
    """One "; em object" line of the map header."""

    def __init__(self, oid, name, em, factor, x, y, status):
        self.id = oid
        self.name = name
        self.em = em
        self.factor = factor
        self.x = x
        self.y = y
        self.printed = status.strip() == "printed"
        # "removed, name does not match ..." means: no readable value.
        self.unnamed = status.startswith("removed") and "name does not match" in status


class EmMap:
    """Map header and cancel commands of the output, plus the inserted lines."""

    def __init__(self, scan):
        self.found = False
        self.malformed = []           # (line number, text)
        self.sel_from = self.sel_to = None
        self.sel_count = self.sel_total = None
        self.multiplier = None
        self.entries = []
        self.inserted = set()         # indexes of the inserted lines
        self.skip_commands = []       # (line number, token or id)
        self.begin_idx = None
        self._parse(scan)

    def _parse(self, scan):
        lines = scan.lines
        begin = None
        for idx, line in enumerate(lines):
            if line.strip() == MAP_BEGIN:
                begin = idx
                break
        if begin is None:
            return
        self.found = True
        self.begin_idx = begin
        self.inserted.add(begin)
        idx = begin + 1
        closed = False
        while idx < len(lines):
            line = lines[idx]
            stripped = line.strip()
            self.inserted.add(idx)
            lineno = idx + 1
            idx += 1
            if stripped == MAP_END:
                closed = True
                break
            match = MULT_RE.match(line)
            if match:
                self.multiplier = parse_float(match.group(1))
                continue
            match = SELECTED_RE.match(line)
            if match:
                self.sel_from = parse_float(match.group(1))
                self.sel_to = parse_float(match.group(2))
                self.sel_count = int(match.group(3))
                self.sel_total = int(match.group(4))
                continue
            match = MAP_OBJ_RE.match(line)
            if match:
                self.entries.append(MapEntry(
                    int(match.group(1)), match.group(2),
                    parse_float(match.group(3)), parse_float(match.group(4)),
                    parse_float(match.group(5)), parse_float(match.group(6)),
                    match.group(7)))
                continue
            self.malformed.append((lineno, stripped[:70]))
        if not closed:
            self.malformed.append((begin + 1, "map end marker missing"))
            return
        # The cancel commands sit directly behind the map header.
        while idx < len(lines):
            line = lines[idx]
            if SKIP_NOTE_RE.match(line):
                self.inserted.add(idx)
                idx += 1
                continue
            cmd = command_part(line)
            match = M486_P_RE.match(cmd)
            if match:
                self.inserted.add(idx)
                self.skip_commands.append((idx + 1, int(match.group(1))))
                idx += 1
                continue
            match = EXCLUDE_OBJ_RE.match(cmd)
            if match:
                self.inserted.add(idx)
                self.skip_commands.append((idx + 1, match.group(1)))
                idx += 1
                continue
            break


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------

def check_map_header(ctx):
    """1) Map header present, well formed and internally consistent."""
    result = Result("map header")
    emmap = ctx.map
    if not emmap.found:
        return result.fail("no '%s' line in the output" % MAP_BEGIN)
    problems = list(emmap.malformed)
    begin_lineno = emmap.begin_idx + 1
    if emmap.multiplier is None:
        problems.append((begin_lineno, "no '; em profile multiplier' line"))
    elif emmap.multiplier <= 0:
        problems.append((begin_lineno,
                         "profile multiplier %.3f is not positive" % emmap.multiplier))
    if ctx.source.multiplier is not None and emmap.multiplier is not None \
            and not close_to(emmap.multiplier, ctx.source.multiplier, 1e-4):
        problems.append((begin_lineno + 1,
                         "profile multiplier %.3f differs from source %.3f"
                         % (emmap.multiplier, ctx.source.multiplier)))

    if emmap.sel_from is None:
        problems.append((begin_lineno, "no '; em selected' line"))
    else:
        printed = [e for e in emmap.entries if e.printed]
        if len(printed) != emmap.sel_count or len(emmap.entries) != emmap.sel_total:
            problems.append((begin_lineno, "'; em selected' says %d of %d, the map lists %d of %d"
                             % (emmap.sel_count, emmap.sel_total,
                                len(printed), len(emmap.entries))))
        for e in emmap.entries:
            if e.em is None:
                continue
            inside = emmap.sel_from - 1e-9 <= e.em <= emmap.sel_to + 1e-9
            if inside != e.printed:
                problems.append((0, "object %d (em=%.3f) is %s but %s the selected range"
                                 % (e.id, e.em, "printed" if e.printed else "removed",
                                    "inside" if inside else "outside")))

    ids = [entry.id for entry in emmap.entries]
    if len(ids) != len(set(ids)):
        problems.append((0, "duplicate object ids in the map"))
    if len(ids) != len(ctx.source.order):
        problems.append((0, "map lists %d objects, source has %d"
                         % (len(ids), len(ctx.source.order))))
    if ids != sorted(ids):
        problems.append((0, "object ids are not ascending"))
    if ids and ids != list(range(ids[0], ids[0] + len(ids))):
        problems.append((0, "object ids are not contiguous"))

    for entry in emmap.entries:
        info = ctx.source.objects.get(entry.id)
        if info is None:
            problems.append((0, "object %d is not present in the source" % entry.id))
            continue
        if info.name and entry.name != info.name:
            problems.append((0, "object %d name '%s' differs from source '%s'"
                             % (entry.id, entry.name, info.name)))
        if entry.unnamed:
            if entry.em is not None or entry.factor is not None:
                problems.append((0, "object %d has no readable name but carries em/factor"
                                 % entry.id))
        else:
            if entry.em is None or entry.factor is None:
                problems.append((0, "object %d has no em/factor" % entry.id))
                continue
            if not (EM_MIN <= entry.em <= EM_MAX):
                problems.append((0, "object %d em=%.3f outside %.1f..%.1f"
                                 % (entry.id, entry.em, EM_MIN, EM_MAX)))
            if emmap.multiplier:
                want = entry.em / emmap.multiplier
                if abs(want - entry.factor) > FACTOR_TOL:
                    problems.append((0, "object %d factor=%.5f but em/multiplier=%.5f"
                                     % (entry.id, entry.factor, want)))
        center = info.center()
        if entry.x is None or entry.y is None:
            problems.append((0, "object %d has no usable x/y" % entry.id))
        elif center is not None:
            cx, cy = center
            if abs(cx - entry.x) > CENTER_TOL or abs(cy - entry.y) > CENTER_TOL:
                problems.append((0, "object %d center %.3f/%.3f but measured %.3f/%.3f"
                                 % (entry.id, entry.x, entry.y, cx, cy)))

    if problems:
        return result.fail("%d problem(s) in the map header" % len(problems), problems)
    removed = sum(1 for e in emmap.entries if not e.printed)
    return result.ok("%d objects, %d printed, %d removed, multiplier %.3f"
                     % (len(emmap.entries), len(emmap.entries) - removed, removed,
                        emmap.multiplier or 0.0))


def check_object_segmentation(ctx):
    """2) The output carries exactly the blocks of the printed objects, in the
    order of the source. Declarations stay complete -- with M486 the object
    numbers hang on them."""
    result = Result("object segmentation")
    src, out = ctx.source, ctx.output
    if not ctx.map.found:
        return result.skip(NO_MAP)
    problems = []
    keep = {e.id for e in ctx.map.entries if e.printed}

    src_decl = [(i, src.objects[i].name) for i in src.order]
    out_decl = [(i, out.objects[i].name) for i in out.order]
    if src_decl != out_decl:
        problems.append((0, "object declarations differ (%d vs %d)"
                         % (len(src_decl), len(out_decl))))

    want_seq = [oid for oid, _, _ in src.blocks if oid in keep]
    out_seq = [oid for oid, _, _ in out.blocks]
    if len(want_seq) != len(out_seq):
        problems.append((0, "%d blocks of printed objects in the source, %d in the output"
                         % (len(want_seq), len(out_seq))))
    for pos, (a, b) in enumerate(zip(want_seq, out_seq)):
        if a != b:
            problems.append((0, "block %d belongs to object %s in the source "
                                "but to %s in the output" % (pos, a, b)))
            break
    for oid in src.order:
        want = src.objects[oid].blocks if oid in keep else 0
        have = out.objects[oid].blocks if oid in out.objects else 0
        if want != have:
            problems.append((0, "object %d has %d blocks in the output, expected %d"
                             % (oid, have, want)))

    if problems:
        return result.fail("%d problem(s) in the object structure" % len(problems),
                           problems)
    return result.ok("%d objects declared, %d of %d blocks kept, same order"
                     % (len(src.order), len(out_seq), len(src.blocks)))


def check_flow_per_object(ctx):
    """3) The flow ratio per object matches the factor from the map header."""
    result = Result("flow per object")
    if not ctx.map.found:
        return result.skip(NO_MAP)
    problems = []
    checked = 0
    for entry in ctx.map.entries:
        src = ctx.source.objects.get(entry.id)
        out = ctx.output.objects.get(entry.id)
        if src is None:
            continue
        if out is None:
            if entry.printed:
                problems.append((0, "object %d is printed but missing from the output"
                                 % entry.id))
            continue
        if src.flow <= 0.0:
            problems.append((0, "object %d extrudes nothing in the source" % entry.id))
            continue
        if not entry.printed:
            if out.flow > 1e-6:
                problems.append((0, "object %d was removed but still extrudes %.2f mm"
                                 % (entry.id, out.flow)))
            continue
        ratio = out.flow / src.flow
        want = entry.factor
        tol = FLOW_TOL
        if want is None:
            continue
        checked += 1
        if abs(ratio - want) > tol * max(1.0, abs(want)):
            problems.append((0, "object %d: flow ratio %.6f but factor %.6f "
                                "(%.2f -> %.2f mm)"
                             % (entry.id, ratio, want, src.flow, out.flow)))
    if problems:
        return result.fail("%d object(s) with wrong flow" % len(problems), problems)
    return result.ok("%d objects match their factor (tolerance %g)" % (checked, FLOW_TOL))


def check_retraction_untouched(ctx):
    """4) No retract/deretract value was changed, and they alternate over the
    whole file. The alternation is the actual test of the cut: if the last
    printed block of a layer is dropped, the layer change would retract a
    second time and the nozzle would run dry."""
    result = Result("retraction")
    from collections import Counter
    src, out = ctx.source.retracts, ctx.output.retracts
    problems = []

    # Values: every move of the output must occur that way in the source too.
    have = Counter(round(v, 5) for v in src)
    for pos, v in enumerate(out):
        key = round(v, 5)
        if have.get(key, 0) > 0:
            have[key] -= 1
        else:
            problems.append((0, "retract %d: %.5f mm does not occur in the source" % (pos, v)))
            if len(problems) >= 20:
                break
    if len(out) > len(src):
        problems.append((0, "%d retract/deretract moves in the output, source has only %d"
                         % (len(out), len(src))))

    # Alternation: a retract must be followed by a deretract and vice versa.
    doubled = 0
    state = None
    for v in out:
        want = v < 0
        if state is not None and state == want:
            doubled += 1
        state = want
    if doubled:
        problems.append((0, "%d retract/deretract move(s) repeat the previous state" % doubled))

    if problems:
        return result.fail("%d problem(s) with retraction" % len(problems), problems)
    return result.ok("%d of %d retract/deretract moves kept, values unchanged, alternating"
                     % (len(out), len(src)))


def check_follows_source(ctx):
    """5) The output is the source with the removed objects cut out of it:
    every line is there again, in the same order, and every missing one has a
    reason."""
    result = Result("output follows the source")
    if not ctx.map.found:
        return result.skip(NO_MAP)
    src, out = ctx.source, ctx.output
    keep = {e.id for e in ctx.map.entries if e.printed}

    # Lines belonging to a removed object -- derived from the source markers
    # independently of the generator, by the same rule: a block ends at the
    # layer change at the latest. Whatever still sits inside its bracket after
    # that (retract, temperature commands, travel to the next layer) belongs to
    # the layer and stays -- only klipper's named end marker falls with the
    # object.
    cut = bytearray(len(src.lines))
    # Start markers of a removed object fall with it. The header declarations
    # look the same ("M486 S0" / "M486 A0.850") but belong to no block and stay
    # -- with M486 the object numbers hang on them. The boundary is the last
    # declaration line.
    decl_end = -1
    for i, line in enumerate(src.lines):
        t = line.strip()
        if M486_A_RE.match(t) or DEFINE_RE.match(t):
            decl_end = i
    names = {}
    for oid in src.order:
        info = src.objects.get(oid)
        if info is not None and info.name:
            names[info.name] = oid
    for i in range(decl_end + 1, len(src.lines)):
        t = src.lines[i].strip()
        m = OBJ_START_RE.match(t)
        oid = names.get(m.group(1).strip("'\"")) if m else None
        if oid is None:
            m = M486_S_RE.match(t)
            oid = int(m.group(1)) if m and int(m.group(1)) >= 0 else None
        if oid is not None and oid not in keep:
            cut[i] = 1

    for oid, a, b in src.blocks:
        if oid in keep:
            continue
        past_layer = False
        for i in range(a, min(b + 1, len(src.lines))):
            t = src.lines[i].strip()
            if LAYER_RE.match(t):
                past_layer = True
                continue                  # the layer change always stays
            if past_layer and not XO_END_RE.match(t):
                continue
            m = M486_S_RE.match(t)
            if m and int(m.group(1)) < 0:
                continue                  # "M486 S-1" belongs to no object
            cut[i] = 1

    rest = [line for idx, line in enumerate(out.lines) if idx not in ctx.map.inserted]
    problems = []
    changed = seams = dropped = 0
    j = 0
    for idx, src_line in enumerate(src.lines):
        if cut[idx]:
            dropped += 1
            continue                      # falls with its object, as intended
        if j < len(rest) and lines_match(ctx, idx, src_line, rest[j]):
            j += 1
            continue
        # Not cut and gone anyway. The only line allowed to vanish is the one
        # retract the seam guard drops when the last block of a layer fell.
        if RETRACT_ONLY_RE.match(src_line.strip()):
            seams += 1
            continue
        changed += 1
        if len(problems) < 20:
            problems.append((idx + 1, "line dropped without reason: %r -- output has %r"
                             % (src_line[:50], (rest[j][:50] if j < len(rest) else "<end>"))))
    if j != len(rest):
        problems.append((0, "%d output line(s) have no counterpart in the source"
                         % (len(rest) - j)))
        changed += 1

    if problems:
        return result.fail("%d unexplained difference(s)" % changed, problems)
    return result.ok("%d of %d source lines kept, %d cut with their object, %d seam retract(s)"
                     % (len(rest), len(src.lines), dropped - seams, seams))


def lines_match(ctx, idx, src_line, out_line):
    """Equal, or changed only where the generator may change: E value,
    statistics, time estimate, progress."""
    if out_line == src_line:
        return True
    if idx in ctx.source.stat_index:
        return True
    a, b = src_line.strip(), out_line.strip()
    if M73_ANY_RE.match(a) and M73_ANY_RE.match(b):
        return True
    if TIME_RE.match(a) and TIME_RE.match(b):
        return True
    ba, bb = blank_e(src_line), blank_e(out_line)
    return ba == bb and ba != src_line


def check_skip_commands(ctx):
    """6) Exactly one cancel command per removed object, none otherwise. Its
    toolpaths are gone but its declaration stays -- without the command it
    would sit in the printer's object list until the end."""
    result = Result("cancel commands")
    if not ctx.map.found:
        return result.skip(NO_MAP)
    skipped = [e for e in ctx.map.entries if not e.printed]
    issued = [value for _, value in ctx.map.skip_commands]
    problems = []
    # Decide from the file's markers, not from gcode_flavor: the generator does
    # the same, and an unknown flavour would otherwise land on the klipper
    # branch.
    marlin = ctx.source.marlin_markers

    wanted = set()
    for entry in skipped:
        info = ctx.source.objects.get(entry.id)
        if marlin:
            want = entry.id
            label = "M486 P%d" % want
        else:
            want = info.token if info else None
            label = "EXCLUDE_OBJECT NAME=%s" % want
        wanted.add(want)
        count = issued.count(want)
        if count != 1:
            problems.append((0, "object %d: %d occurrences of '%s', expected 1"
                             % (entry.id, count, label)))

    for lineno, value in ctx.map.skip_commands:
        if value not in wanted:
            problems.append((lineno, "cancel command for '%s' matches no removed object"
                             % value))

    # The source file itself must not bring any cancel commands.
    stray = ctx.source_skip_commands
    if stray:
        problems.append((stray[0], "the source already contains a skip command"))

    if problems:
        return result.fail("%d problem(s) with the skip commands" % len(problems),
                           problems)
    if not skipped:
        return result.ok("nothing removed, no cancel commands emitted")
    return result.ok("%d removed object(s), one command each" % len(skipped))


def check_filament_statistics(ctx):
    """7) The filament figures match the amount actually extruded."""
    result = Result("filament statistics")
    out = ctx.output
    if not out.stat_lines:
        return result.skip("the output carries no filament statistics")
    mm = out.extruded_mm
    diameter = out.diameter or ctx.source.diameter
    density = out.density or ctx.source.density
    cm3 = None
    grams = None
    if diameter:
        cm3 = mm * math.pi * (diameter / 2.0) ** 2 / 1000.0
        if density:
            grams = cm3 * density
    expect = {
        "filament used [mm]": mm,
        "filament used [cm3]": cm3,
        "filament used [g]": grams,
        "total filament used [g]": grams,
    }
    problems = []
    checked = 0
    unchecked = set()
    for lineno, key, value in out.stat_lines:
        want = expect.get(key)
        if want is None:
            unchecked.add(key)
            continue
        if value is None:
            problems.append((lineno + 1, "%s has no numeric value" % key))
            continue
        checked += 1
        if abs(value - want) > STAT_TOL * max(1.0, abs(want)):
            problems.append((lineno + 1, "%s = %.2f but the output extrudes %.2f"
                             % (key, value, want)))
    if problems:
        return result.fail("%d filament statistic(s) do not match the output"
                           % len(problems), problems)
    if not checked:
        return result.skip("filament_diameter/filament_density missing, "
                           "cannot verify the statistics")
    info = "%d statistic line(s) match (%.2f mm extruded)" % (checked, mm)
    if unchecked:
        info += "; not recalculated: %s" % ", ".join(sorted(unchecked))
    return result.ok(info)


def check_line_accounting(ctx):
    """8) Layers stay complete; without a cut the line count is exactly the
    source's plus the inserted ones."""
    result = Result("line accounting")
    src = len(ctx.source.lines)
    out = len(ctx.output.lines)
    inserted = len(ctx.map.inserted)
    problems = []

    a = sum(1 for line in ctx.source.lines if LAYER_RE.match(line.strip()))
    b = sum(1 for line in ctx.output.lines if LAYER_RE.match(line.strip()))
    if a != b:
        problems.append((0, "%d layer changes in the source, %d in the output" % (a, b)))

    removed = sum(1 for e in ctx.map.entries if not e.printed) if ctx.map.found else 0
    if not removed and out != src + inserted:
        problems.append((0, "nothing was removed, so the output should have %d lines, not %d"
                         % (src + inserted, out)))
    if out > src + inserted:
        problems.append((0, "output has %d lines, more than source plus inserted (%d)"
                         % (out, src + inserted)))
    if problems:
        return result.fail("%d problem(s) in the line accounting" % len(problems), problems)
    return result.ok("%d -> %d lines (+%d inserted), %d layers unchanged"
                     % (src, out, inserted, a))


def check_number_sanity(ctx):
    """9) No broken numbers, no over-long number format, no over-extrusion."""
    result = Result("number sanity")
    out = ctx.output
    buckets = (out.dirty, out.bad_numbers, out.over_extrusion, out.big_backsteps)
    problems = [item for bucket in buckets for item in bucket[:10]]
    if any(buckets):
        return result.fail("%d dirty word(s), %d bad number format(s), "
                           "%d over-extrusion(s), %d backward jump(s)"
                           % tuple(len(bucket) for bucket in buckets),
                           problems)
    return result.ok("numbers clean, at most %d decimals, at most %.2f mm E per mm path"
                     % (MAX_E_DECIMALS, MAX_E_PER_MM))


def check_effectiveness(ctx):
    """10) At least one object was really rewritten."""
    result = Result("effectiveness")
    if not ctx.map.found:
        return result.skip(NO_MAP)
    candidates = [e for e in ctx.map.entries
                  if e.printed and e.factor is not None
                  and abs(e.factor - 1.0) > 1e-6]
    if not candidates:
        return result.skip("every factor is 1.0, no change to detect")
    changed = 0
    for entry in candidates:
        src = ctx.source.objects.get(entry.id)
        out = ctx.output.objects.get(entry.id)
        if src is None or out is None or src.flow <= 0.0:
            continue
        if abs(out.flow - src.flow) > 1e-6 * max(1.0, src.flow):
            changed += 1
    if not changed:
        return result.fail("%d object(s) carry a factor != 1 but no E value changed"
                           % len(candidates))
    return result.ok("%d of %d factored object(s) really changed"
                     % (changed, len(candidates)))


def check_progress(ctx):
    """11) The progress lines fall monotonically and end at zero."""
    result = Result("progress")
    rest = []
    for line in ctx.output.lines:
        m = M73_PR_RE.match(line.strip())
        if m:
            rest.append(int(m.group(1)))
    if not rest:
        return result.skip("the file carries no M73 lines")
    ups = sum(1 for i in range(1, len(rest)) if rest[i] > rest[i - 1])
    problems = []
    if ups:
        problems.append((0, "%d progress line(s) where the remaining time goes up" % ups))
    if rest[-1] != 0:
        problems.append((0, "the last progress line says R%d, expected R0" % rest[-1]))
    if problems:
        return result.fail("%d problem(s) in the progress lines" % len(problems), problems)
    return result.ok("%d progress lines, falling, ending at 0" % len(rest))


CHECKS = (
    check_map_header,
    check_object_segmentation,
    check_flow_per_object,
    check_retraction_untouched,
    check_follows_source,
    check_skip_commands,
    check_filament_statistics,
    check_line_accounting,
    check_number_sanity,
    check_effectiveness,
    check_progress,
)


# ---------------------------------------------------------------------------
# Context
# ---------------------------------------------------------------------------

class Context:
    """Bundles both files and the helper data derived from them."""

    def __init__(self, source, output):
        self.source = source
        self.output = output
        self.map = EmMap(output)
        self.source_skip_commands = []
        for idx, line in enumerate(source.lines):
            if line.startswith("M486 P") or line.startswith("EXCLUDE_OBJECT "):
                self.source_skip_commands.append(idx + 1)


def collect_statistics(ctx):
    src, out = ctx.source, ctx.output
    e_mode = "absolute" if src.absolute_e else "relative"
    ratio = out.extruded_mm / src.extruded_mm if src.extruded_mm else 0.0
    stats = [
        ("flavor", "%s, %s E" % (src.flavor or "?", e_mode)),
        ("objects", "%d declared, %d blocks" % (len(src.order), len(src.blocks))),
        ("lines", "%d source -> %d output (+%d inserted)"
         % (len(src.lines), len(out.lines), len(ctx.map.inserted))),
        ("extrusion", "%.2f mm source -> %.2f mm output (%.4fx)"
         % (src.extruded_mm, out.extruded_mm, ratio)),
        ("retract moves", "%d source / %d output"
         % (len(src.retracts), len(out.retracts))),
    ]
    if ctx.map.found:
        ok = sum(1 for e in ctx.map.entries if e.printed)
        mult = "%.3f" % ctx.map.multiplier if ctx.map.multiplier else "?"
        stats.append(("map", "%d printed, %d removed, multiplier %s"
                      % (ok, len(ctx.map.entries) - ok, mult)))
    return stats


def object_table(ctx):
    """Per-object table for the verbose output."""
    rows = [("id", "name", "em", "factor", "source mm", "output mm", "ratio")]
    entries = {e.id: e for e in ctx.map.entries}
    for oid in ctx.source.order:
        src = ctx.source.objects[oid]
        out = ctx.output.objects.get(oid)
        entry = entries.get(oid)
        em = entry.em if entry else None
        factor = entry.factor if entry else None
        out_flow = out.flow if out else 0.0
        ratio = (out.flow / src.flow) if (out and src.flow) else 0.0
        rows.append((
            str(oid),
            (src.name or "?")[:26],
            "%.3f" % em if em is not None else "-",
            "%.5f" % factor if factor is not None else "-",
            "%.2f" % src.flow,
            "%.2f" % out_flow,
            "%.5f" % ratio,
        ))
    return rows


def report(ctx, results, verbose):
    """Compact table, statistics, summary."""
    print("Source: %s (%s)" % (ctx.source.path, human_size(ctx.source.path)))
    print("Output: %s (%s)" % (ctx.output.path, human_size(ctx.output.path)))
    print("")
    width = max(len(r.name) for r in results)
    for result in results:
        print("%-4s  %-*s  %s" % (result.status, width, result.name, result.info))
        if verbose and result.status == "FAIL" and result.violations:
            for lineno, text in result.violations[:8]:
                where = "line %d" % lineno if lineno else "     -"
                print("        %s: %s" % (where, text))
            if len(result.violations) > 8:
                print("        ... %d more" % (len(result.violations) - 8))
    print("")
    print("Statistics")
    stats = collect_statistics(ctx)
    key_width = max(len(k) for k, _ in stats)
    for key, value in stats:
        print("  %-*s  %s" % (key_width, key, value))
    if verbose and ctx.source.order:
        print("")
        print("Objects")
        rows = object_table(ctx)
        widths = [max(len(cell) for cell in column) for column in zip(*rows)]
        for row in rows:
            print("  " + "  ".join("%-*s" % (width, cell)
                                   for width, cell in zip(widths, row)))
    print("")
    failed = [r for r in results if r.status == "FAIL"]
    skipped = [r for r in results if r.status == "SKIP"]
    passed = sum(1 for r in results if r.status == "PASS")
    print("Summary: %d passed, %d failed, %d skipped (of %d checks)"
          % (passed, len(failed), len(skipped), len(results)))
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
        description="Compare the output of the EM generator against its input.")
    parser.add_argument("source", help="sliced input .gcode file")
    parser.add_argument("output", help="generated EM test .gcode file")
    parser.add_argument("-v", "--verbose", action="store_true",
                        help="show violations and a per-object table")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    for path in (args.source, args.output):
        if not os.path.isfile(path):
            sys.stderr.write("error: file not found: %s\n" % path)
            return 2
    try:
        ctx = Context(Scan(args.source), Scan(args.output))
    except (OSError, IOError) as error:
        sys.stderr.write("error: cannot read file: %s\n" % error)
        return 2

    results = []
    for check in CHECKS:
        try:
            results.append(check(ctx))
        except Exception as error:                    # robustness over completeness
            broken = Result(getattr(check, "__name__", "check"))
            broken.fail("internal error: %s: %s" % (type(error).__name__, error))
            results.append(broken)
    return report(ctx, results, args.verbose)


if __name__ == "__main__":
    sys.exit(main())
