#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Comparison check for the temperature tower.

The TT generator produces no geometry: it trims a sliced tower file to a
temperature range, pulls it down onto the bed, puts a base underneath and the
temperature commands in between. The check is therefore output against input.

Standard library only. Exit code 0 when no check reports FAIL.
"""

import argparse
import math
import os
import re
import sys

BANDS = 21
BASE_TEMP = 180
TEMP_STEP = 5

MAP_BEGIN = "; >>> print_calibration_tool tt map begin"
END_ANCHOR = "; Filament-specific end gcode"

MOVE_RE = re.compile(r"^(G[0-3])(?![0-9])")
AXIS = {a: re.compile(r"(?:^|\s)%s(-?(?:\d+(?:\.\d*)?|\.\d+))" % a) for a in "XYZEF"}
# S as well as R: klipper reads only S and waits in both directions, marlin
# waits with S only while heating up and therefore needs R.
TEMP_RE = re.compile(r"^M10([49])(?![0-9])\s+([SR])\s*(\d+)")
ANY_TEMP_RE = re.compile(r"^M10[49](?![0-9])")
OBJ_START_RE = re.compile(r"^(?:EXCLUDE_OBJECT_START\b|M486\s+S\s*\d)")
OBJ_END_RE = re.compile(r"^(?:EXCLUDE_OBJECT_END\b|M486\s+S\s*-\s*1\b)")
FAN_RE = re.compile(r"^M10[67](?![0-9])")
M73_RE = re.compile(r"^M73\s+P(\d+)\s+R(\d+)\s*$")
M73_QS_RE = re.compile(r"^M73\s+Q(\d+)\s+S(\d+)\s*$")
MAP_BAND_RE = re.compile(
    r"^; tt band (\d+) \| (\d+) C \| source Z ([\d.]+)-([\d.]+) \| "
    r"print Z ([\d.]+)-([\d.]+) \| layers (\d+)-(\d+)$")
MAP_BASE_RE = re.compile(
    r"^; tt base = (\d+) layers up to Z ([\d.]+), source layers (\d+)-(\d+), "
    r"last one repeated (\d+)x$")
MAP_CAP_RE = re.compile(
    r"^; tt top cap = (\d+) layers, source layers (\d+)-(\d+)$")
BARE_NUM_RE = re.compile(r"^;\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s*$")
CONFIG_RE = re.compile(r"^;\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$")
# What the tool may insert behind the base plate when the bottom was cut off:
# the machine state carried over.
INSERTED_RE = re.compile(r"^(M20[14]|M221|G1\s+F[\d.]+|G92\s+E)")
# Consumption and time figures may change -- they describe the trimmed print.
# Their keys carry spaces and brackets and therefore do not match CONFIG_RE.
STAT_RE = re.compile(r"^;\s*(filament used \[\w+\]|total filament used \[\w+\]|"
                     r"filament cost|total filament cost|estimated printing time \([a-z ]+\)|"
                     r"estimated first layer printing time \([a-z ]+\))\s*=\s*(.*?)\s*$")
NUM_TOL = 1e-4


def axis(code, letter):
    m = AXIS[letter].search(code)
    return float(m.group(1)) if m else None


def code_of(line):
    i = line.find(";")
    return line if i < 0 else line[:i]


class Scan(object):
    """One file split into layers, plus whatever else is needed."""

    def __init__(self, path):
        with open(path, "r", errors="replace") as handle:
            self.lines = handle.read().split("\n")
        self.config = {}
        self.stats = {}
        self.map_begin = -1
        self.layers = []          # (start, z, height)
        self.head_end = -1
        self.end_start = len(self.lines)
        self.map = []
        cur = None
        for i, raw in enumerate(self.lines):
            t = raw.strip()
            if not t:
                continue
            if t[0] == ";":
                if t == ";LAYER_CHANGE":
                    if self.head_end < 0:
                        self.head_end = i
                    cur = {"start": i, "z": None, "height": None, "end": i}
                    self.layers.append(cur)
                elif cur is not None and t.startswith(";Z:") and cur["z"] is None:
                    cur["z"] = float(t[3:])
                elif cur is not None and t.startswith(";HEIGHT:") and cur["height"] is None:
                    cur["height"] = float(t[8:])
                elif t == END_ANCHOR:
                    self.end_start = i
                m = CONFIG_RE.match(t)
                if m and m.group(1) not in self.config:
                    self.config[m.group(1)] = m.group(2)
                m = STAT_RE.match(t)
                if m:
                    self.stats[m.group(1)] = m.group(2)
                if t == MAP_BEGIN:
                    self.map_begin = i
                if MAP_BEGIN in t or t.startswith("; tt "):
                    self.map.append(t)
                continue
            if cur is not None:
                cur["end"] = i
        for k in range(len(self.layers)):
            nxt = self.layers[k + 1]["start"] if k + 1 < len(self.layers) else self.end_start
            self.layers[k]["end"] = nxt - 1

    def num(self, key):
        try:
            return float(self.config[key])
        except (KeyError, ValueError):
            return float("nan")

    def stat(self, key):
        try:
            return float(self.stats[key])
        except (KeyError, ValueError):
            return float("nan")

    @property
    def body_start(self):
        """Start of what the tool inserted: map, machine state, temperature,
        object bracket, base."""
        return self.map_begin if self.map_begin >= 0 else self.head_end


class Result(object):
    def __init__(self, name):
        self.name = name
        self.status = "PASS"
        self.notes = []

    def fail(self, text):
        self.status = "FAIL"
        self.notes.append(text)

    def skip(self, text):
        if self.status == "PASS":
            self.status = "SKIP"
        self.notes.append(text)

    def note(self, text):
        self.notes.append(text)


class Context(object):
    def __init__(self, src, out):
        self.src = src
        self.out = out
        self.bands = []
        self.base = None
        # Copied onto the cut when the tower was cut short above; absent
        # otherwise. See "top cap" in tt/generator.js.
        self.cap = None
        for line in out.map:
            m = MAP_BAND_RE.match(line)
            if m:
                self.bands.append({
                    "index": int(m.group(1)), "temp": int(m.group(2)),
                    "sz0": float(m.group(3)), "sz1": float(m.group(4)),
                    "pz0": float(m.group(5)), "pz1": float(m.group(6)),
                    "first": int(m.group(7)), "last": int(m.group(8)),
                })
                continue
            m = MAP_BASE_RE.match(line)
            if m:
                self.base = {"layers": int(m.group(1)), "height": float(m.group(2)),
                             "first": int(m.group(3)), "last": int(m.group(4)),
                             "dup": int(m.group(5))}
                continue
            m = MAP_CAP_RE.match(line)
            if m:
                self.cap = {"layers": int(m.group(1)),
                            "first": int(m.group(2)), "last": int(m.group(3))}


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------

def check_map(ctx):
    r = Result("1 map header")
    if not ctx.bands or ctx.base is None:
        r.fail("no map header in the output")
        return r
    for b in ctx.bands:
        want = BASE_TEMP + (b["index"] - 1) * TEMP_STEP
        if b["temp"] != want:
            r.fail("band %d says %d C, the model says %d C" % (b["index"], b["temp"], want))
    idx = [b["index"] for b in ctx.bands]
    if idx != list(range(idx[0], idx[0] + len(idx))):
        r.fail("band indices are not contiguous: %s" % idx)
    if not (1 <= idx[0] and idx[-1] <= BANDS):
        r.fail("band indices outside 1..%d: %s" % (BANDS, idx))
    r.note("%d bands, %d ... %d C" % (len(ctx.bands), ctx.bands[0]["temp"], ctx.bands[-1]["temp"]))
    return r


def check_head_tail(ctx):
    """Head and end block are taken over; only the statistics lines change."""
    r = Result("2 head and end block")
    src, out = ctx.src, ctx.out
    if src.head_end < 0 or out.head_end < 0:
        r.fail("no layer markers")
        return r
    changed = 0
    if out.head_end < src.head_end:
        r.fail("output head is shorter than the source head")
        return r
    for i in range(src.head_end):
        a, b = src.lines[i], out.lines[i]
        if a == b:
            continue
        changed += 1
        if not (STAT_RE.match(b.strip()) or M73_RE.match(b.strip())
                or M73_QS_RE.match(b.strip())):
            r.fail("head line %d changed unexpectedly: %r -> %r" % (i + 1, a, b))
    src_tail = src.lines[src.end_start:]
    out_tail = out.lines[out.end_start:]
    if len(src_tail) != len(out_tail):
        r.fail("end block has %d lines instead of %d" % (len(out_tail), len(src_tail)))
    else:
        for a, b in zip(src_tail, out_tail):
            if a != b and not (STAT_RE.match(b.strip()) or M73_RE.match(b.strip())
                               or M73_QS_RE.match(b.strip())):
                r.fail("end block line changed: %r -> %r" % (a, b))
    r.note("%d head lines rewritten (statistics)" % changed)
    return r


def check_layers(ctx):
    """Z gapless, monotonic, starting at the base; step == ;HEIGHT:."""
    r = Result("3 layer stack")
    out = ctx.out
    if len(out.layers) < 2:
        r.fail("fewer than two layers")
        return r
    first_h = ctx.src.num("first_layer_height")
    layer_h = ctx.src.num("layer_height")
    z0 = out.layers[0]["z"]
    if abs(z0 - first_h) > NUM_TOL:
        r.fail("first layer sits at Z %s, first_layer_height is %s" % (z0, first_h))
    if abs(out.layers[0]["height"] - first_h) > NUM_TOL:
        r.fail("first layer is %s thick, first_layer_height is %s"
               % (out.layers[0]["height"], first_h))
    bad = 0
    for k in range(1, len(out.layers)):
        a, b = out.layers[k - 1], out.layers[k]
        if b["z"] <= a["z"]:
            r.fail("Z does not increase at layer %d: %s -> %s" % (k, a["z"], b["z"]))
            break
        if abs((b["z"] - a["z"]) - b["height"]) > 1e-3:
            bad += 1
        if abs(b["height"] - layer_h) > 1e-3:
            r.fail("layer %d is %s thick, layer_height is %s" % (k, b["height"], layer_h))
            break
    if bad:
        r.fail("%d layers where the Z step does not match ;HEIGHT:" % bad)
    r.note("%d layers, Z %s ... %s" % (len(out.layers), out.layers[0]["z"], out.layers[-1]["z"]))
    return r


def check_temperatures(ctx):
    """Exactly one M104 per band -- the lowest one between the first and the
    second base layer, so the nozzle changes over during the rest of the base;
    every other one just before the first layer of its band."""
    r = Result("4 temperature commands")
    out = ctx.out
    found = []
    for i in range(out.body_start, out.end_start):
        m = TEMP_RE.match(out.lines[i].strip())
        if m:
            found.append((i, int(m.group(1)), m.group(2), int(m.group(3))))
    want = [b["temp"] for b in ctx.bands]
    if len(found) != len(want):
        r.fail("%d commands, expected %d (one per band)" % (len(found), len(want)))
        return r
    for entry in found:
        if entry[1] != 4 or entry[2] != "S":
            r.fail("line %d is %s — every band switches with M104 S"
                   % (entry[0] + 1, out.lines[entry[0]].strip()))
            return r
    if [f[3] for f in found] != want:
        r.fail("commands say %s, the map says %s" % ([f[3] for f in found], want))
        return r
    if len(out.layers) < 2:
        r.fail("the base has no second layer")
        return r
    pos, gap = found[0][0], out.layers[1]["start"] - found[0][0]
    if not (out.layers[0]["start"] < pos < out.layers[1]["start"]):
        r.fail("the switch to %d C does not sit inside the first layer" % want[0])
    elif gap > 3:
        r.fail("the switch to %d C sits %d lines before the second layer" % (want[0], gap))
    nbase = ctx.base["layers"]
    for k, b in enumerate(ctx.bands):
        if k == 0:
            continue
        want_layer = out.layers[nbase + b["first"] - ctx.bands[0]["first"]]
        pos = found[k][0]
        if not (pos < want_layer["start"]):
            r.fail("command for %d C sits after the first layer of its band" % b["temp"])
        elif want_layer["start"] - pos > 3:
            r.fail("command for %d C sits %d lines before its layer"
                   % (b["temp"], want_layer["start"] - pos))
    r.note("M104 %s, no wait" % (want,))
    return r


def check_no_foreign_temp(ctx):
    r = Result("5 no foreign temperature commands")
    out = ctx.out
    strays = []
    for i in range(out.body_start, out.end_start):
        t = out.lines[i].strip()
        if ANY_TEMP_RE.match(t) and not TEMP_RE.match(t):
            strays.append((i + 1, t))
    if strays:
        r.fail("%d hotend temperature commands that are not ours, e.g. line %d: %s"
               % (len(strays), strays[0][0], strays[0][1]))
    r.note("body is clean")
    return r


def check_object_bracket(ctx):
    r = Result("6 object bracket")
    out = ctx.out
    starts, ends = [], []
    for i in range(out.body_start, out.end_start):
        t = out.lines[i].strip()
        if OBJ_START_RE.match(t):
            starts.append(i)
        elif OBJ_END_RE.match(t):
            ends.append(i)
    if len(starts) != 1 or len(ends) != 1:
        r.fail("%d open and %d close markers, expected one each" % (len(starts), len(ends)))
        return r
    if not (starts[0] < out.layers[0]["start"] < ends[0]):
        r.fail("the bracket does not enclose the layers")
    r.note("one bracket around %d layers" % len(out.layers))
    return r


def base_diff(a, b, offset):
    """Compares two layers; in `b` every height may be `offset` larger.
    Returns the first difference as text, None when equal."""
    if len(a) != len(b):
        return "%d against %d lines" % (len(a), len(b))
    # The slicer's height markers: ";Z:0.5" and the bare ";0.5".
    marks = (lambda t: t[3:] if t.startswith(";Z:") else None,
             lambda t: m.group(1) if (m := BARE_NUM_RE.match(t)) else None)
    for sa, sb in zip(a, b):
        ta, tb = sa.strip(), sb.strip()
        for cut in marks:
            va = cut(ta)
            if va is None:
                continue
            vb = cut(tb)
            if vb is None or abs(float(vb) - float(va) - offset) > NUM_TOL:
                return "%r became %r" % (sa, sb)
            break
        else:
            ca, cb = code_of(ta), code_of(tb)
            za = axis(ca, "Z") if MOVE_RE.match(ta) else None
            if za is None:
                if ta != tb:
                    return "%r became %r" % (sa, sb)
                continue
            zb = axis(cb, "Z") if MOVE_RE.match(tb) else None
            drop = lambda c: re.sub(r"(^|\s)Z-?[\d.]*", "", c)
            if zb is None or abs(zb - za - offset) > 1e-3 or drop(ca) != drop(cb):
                return "%r became %r" % (sa, sb)
    return None


def check_base(ctx):
    """The base is there as the slicer laid it out -- topmost layer repeated if
    need be, so there are always three."""
    r = Result("7 base")
    src, out = ctx.src, ctx.out
    if ctx.base is None or not out.layers or not src.layers:
        r.fail("no base")
        return r
    src_n = ctx.base["last"] - ctx.base["first"] + 1
    n = ctx.base["layers"]
    if n != src_n + ctx.base["dup"]:
        r.fail("the map says %d layers from %d source layers plus %d repeats"
               % (n, src_n, ctx.base["dup"]))
        return r
    if n != 3:
        r.fail("the base has %d layers, it should have 3" % n)
    lh = float(src.config.get("layer_height", 0) or 0)
    if len(out.layers) <= n:
        r.fail("nothing above the base")
        return r
    for k in range(n):
        # Repeats fall back on the topmost sliced layer.
        a_l, b_l = src.layers[min(k, src_n - 1)], out.layers[k]
        shift = (k - src_n + 1) * lh if k >= src_n else 0.0
        if abs(b_l["z"] - a_l["z"] - shift) > NUM_TOL:
            r.fail("base layer %d sits at Z %s, expected %s"
                   % (k, b_l["z"], round(a_l["z"] + shift, 5)))
            return r
        # The progress lines are recomputed for the shortened print, the moves
        # are not.
        keep = lambda t: not (OBJ_START_RE.match(t) or OBJ_END_RE.match(t)
                              or ANY_TEMP_RE.match(t) or t.startswith("; print_calibration_tool:")
                              or M73_RE.match(t) or M73_QS_RE.match(t))
        aa = [l for l in src.lines[a_l["start"]:a_l["end"] + 1] if keep(l.strip())]
        bb = [l for l in out.lines[b_l["start"]:b_l["end"] + 1] if keep(l.strip())]
        # The plate has to come first, verbatim. Behind it only what the tool
        # itself inserts when the bottom was cut off may appear.
        bad = base_diff(aa, bb[:len(aa)], shift)
        if bad:
            r.fail("base layer %d differs from the source: %s" % (k, bad))
            return r
        for extra in bb[len(aa):]:
            if not INSERTED_RE.match(extra.strip()):
                r.fail("unexpected line after the base: %r" % extra)
                return r
    r.note("%d layers, %s mm, %d repeated" % (n, ctx.base["height"], ctx.base["dup"]))
    return r


def extruded(lines, absolute):
    total = 0.0
    e = 0.0
    for raw in lines:
        t = raw.strip()
        if t.startswith("G92") and axis(code_of(t), "E") is not None:
            e = axis(code_of(t), "E")
            continue
        if not MOVE_RE.match(t):
            continue
        c = code_of(t)
        v = axis(c, "E")
        if v is None:
            continue
        delta = (v - e) if absolute else v
        if absolute:
            e = v
        if delta > 0 and (axis(c, "X") is not None or axis(c, "Y") is not None):
            total += delta
    return total


CAP_G92_RE = re.compile(r"^G92\s+E.*;\s*print_calibration_tool:\s*top cap$")


def keep_src_line(t):
    return not (OBJ_START_RE.match(t) or OBJ_END_RE.match(t) or ANY_TEMP_RE.match(t)
                or FAN_RE.match(t))


def keep_out_line(t):
    return not (t.startswith("; print_calibration_tool:") or TEMP_RE.match(t)
                or FAN_RE.match(t) or OBJ_START_RE.match(t) or OBJ_END_RE.match(t)
                or CAP_G92_RE.match(t))


def body_pieces(ctx):
    """(source layer range, output layer range) of the body, as pairs.

    Without a top cap one piece. With one the output ends with the tower's own
    topmost layers instead of those at the cut, so the mapping takes two pieces
    -- each still line for line.
    """
    src, out = ctx.src, ctx.out
    s_first, s_last = ctx.bands[0]["first"], ctx.bands[-1]["last"]
    nbase = ctx.base["layers"]
    n_out_last = len(out.layers) - 1
    cap = ctx.cap
    if not cap:
        return [((s_first, s_last), (nbase, n_out_last))]
    k = cap["layers"]
    return [((s_first, s_last - k), (nbase, n_out_last - k)),
            ((cap["first"], cap["last"]), (n_out_last - k + 1, n_out_last))]


def slice_lines(doc, a, b):
    return doc.lines[doc.layers[a]["start"]:doc.layers[b]["end"] + 1]


def check_body_vs_source(ctx):
    """Every line taken over is there again -- only Z is shifted."""
    r = Result("8 body follows the source")
    src, out = ctx.src, ctx.out
    if not ctx.bands:
        r.fail("no map")
        return r
    for (sa, sb), (oa, ob) in body_pieces(ctx):
        piece = compare_piece(r, src, out, (sa, sb), (oa, ob))
        if piece is None:
            return r
    return r


def compare_piece(r, src, out, srange, orange):
    sa, sb = srange
    oa, ob = orange
    src_lines = slice_lines(src, sa, sb)
    out_lines = slice_lines(out, oa, ob)
    offset = src.layers[sa]["z"] - out.layers[oa]["z"]

    keep_src = keep_src_line
    keep_out = keep_out_line

    a = [l for l in src_lines if keep_src(l.strip())]
    b = [l for l in out_lines if keep_out(l.strip())]
    if len(a) != len(b):
        r.fail("layers %d-%d: %d source lines against %d output lines"
               % (sa, sb, len(a), len(b)))
        return None
    zbad = xybad = 0
    for sa_l, sb_l in zip(a, b):
        ta, tb = sa_l.strip(), sb_l.strip()
        if not MOVE_RE.match(ta):
            continue
        ca, cb = code_of(ta), code_of(tb)
        if MOVE_RE.match(ta).group(1) != (MOVE_RE.match(tb).group(1) if MOVE_RE.match(tb) else ""):
            xybad += 1
            continue
        for letter in "XY":
            va, vb = axis(ca, letter), axis(cb, letter)
            if (va is None) != (vb is None) or (va is not None and abs(va - vb) > NUM_TOL):
                xybad += 1
        za, zb = axis(ca, "Z"), axis(cb, "Z")
        if (za is None) != (zb is None):
            zbad += 1
        elif za is not None and abs((za - offset) - zb) > 1e-3:
            zbad += 1
    if xybad:
        r.fail("layers %d-%d: %d moves whose X/Y changed" % (sa, sb, xybad))
    if zbad:
        r.fail("layers %d-%d: %d moves whose Z is not the source Z minus %.3f mm"
               % (sa, sb, zbad, offset))
    r.note("layers %d-%d: %d lines, Z shifted by %.3f mm" % (sa, sb, len(a), -offset))
    return True


def check_retraction(ctx):
    """Backward moves stay untouched."""
    r = Result("9 retraction untouched")
    src, out = ctx.src, ctx.out
    if not ctx.bands:
        r.fail("no map")
        return r
    absolute = ctx.absolute()

    def count(lines):
        neg = 0
        e = 0.0
        for raw in lines:
            t = raw.strip()
            if t.startswith("G92") and axis(code_of(t), "E") is not None:
                e = axis(code_of(t), "E")
                continue
            if not MOVE_RE.match(t):
                continue
            v = axis(code_of(t), "E")
            if v is None:
                continue
            delta = (v - e) if absolute else v
            if absolute:
                e = v
            if delta < 0:
                neg += 1
        return neg

    total = 0
    for (sa, sb), (oa, ob) in body_pieces(ctx):
        a = count(slice_lines(src, sa, sb))
        b = count(slice_lines(out, oa, ob))
        if a != b:
            r.fail("layers %d-%d: %d retract moves in the source, %d in the output"
                   % (sa, sb, a, b))
        total += b
    r.note("%d retract moves" % total)
    return r


def check_stats(ctx):
    r = Result("10 statistics and progress")
    out = ctx.out
    total = extruded(out.lines[out.body_start:out.end_start], ctx.absolute())
    stated = out.stat("filament used [mm]")
    if not math.isnan(stated):
        if stated <= 0 or abs(stated - total) / max(total, 1.0) > 0.01:
            r.fail("header says %.2f mm filament, the file extrudes %.2f mm" % (stated, total))
    else:
        r.skip("no filament header")
    bad = 0
    for pattern, label in ((M73_RE, "normal"), (M73_QS_RE, "silent")):
        last = None
        for line in out.lines:
            m = pattern.match(line.strip())
            if not m:
                continue
            rest = int(m.group(2))
            if last is not None and rest > last:
                bad += 1
            last = rest
        if bad:
            r.fail("%d %s-mode progress lines where the remaining time goes up" % (bad, label))
        if last not in (None, 0):
            r.fail("the last %s-mode progress line says %d minutes left" % (label, last))
    r.note("%.1f mm filament" % total)
    return r


def check_numbers(ctx):
    r = Result("11 number hygiene")
    out = ctx.out
    bad = []
    for i in range(out.body_start, out.end_start):
        t = out.lines[i].strip()
        if not MOVE_RE.match(t) and not t.startswith("M"):
            continue
        if re.search(r"NaN|Infinity|undefined|null", t):
            bad.append((i + 1, t))
        c = code_of(t)
        for letter in "XYZEF":
            m = AXIS[letter].search(c)
            if m and "." in m.group(1) and len(m.group(1).split(".")[1]) > 5:
                bad.append((i + 1, t))
                break
    if bad:
        r.fail("%d lines with unusable numbers, e.g. line %d: %s"
               % (len(bad), bad[0][0], bad[0][1]))
    r.note("clean")
    return r


Context.absolute = lambda self: self.src.config.get("use_relative_e_distances", "0").strip() != "1"

CHECKS = [check_map, check_head_tail, check_layers, check_temperatures,
          check_no_foreign_temp, check_object_bracket, check_base,
          check_body_vs_source, check_retraction, check_stats, check_numbers]


def report(results, verbose):
    failed = 0
    for res in results:
        print("%-4s %s" % (res.status, res.name))
        if res.status == "FAIL":
            failed += 1
        if verbose or res.status == "FAIL":
            for note in res.notes:
                print("       %s" % note)
    passed = sum(1 for r in results if r.status == "PASS")
    skipped = sum(1 for r in results if r.status == "SKIP")
    print("\nSummary: %d passed, %d failed, %d skipped (of %d checks)"
          % (passed, failed, skipped, len(results)))
    return 1 if failed else 0


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Compare the output of the temperature tower generator against its input.")
    parser.add_argument("source", help="sliced input .gcode file")
    parser.add_argument("output", help="generated tower .gcode file")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)
    for path in (args.source, args.output):
        if not os.path.isfile(path):
            sys.stderr.write("error: file not found: %s\n" % path)
            return 2
    ctx = Context(Scan(args.source), Scan(args.output))
    results = []
    for check in CHECKS:
        try:
            results.append(check(ctx))
        except Exception as error:
            broken = Result(getattr(check, "__name__", "check"))
            broken.fail("internal error: %s: %s" % (type(error).__name__, error))
            results.append(broken)
    return report(results, args.verbose)


if __name__ == "__main__":
    sys.exit(main())
