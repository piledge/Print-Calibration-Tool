#!/usr/bin/env python3
"""Extracts the thumbnails from a gcode file and writes them as PNG.

    python3 tools/extract_thumbnails.py PA_test.gcode -o /tmp

QOI is decoded, PNG is written out unchanged. Meant for checking whether the
generated test print really shows the pattern in its image. No third-party
packages, only zlib from the standard library.
"""

import argparse
import base64
import os
import re
import struct
import sys
import zlib

BEGIN_RE = re.compile(r"^;\s*(thumbnail(?:_[A-Za-z0-9]+)?)\s+begin\s+(\d+)x(\d+)\s+(\d+)\s*$", re.I)
END_RE = re.compile(r"^;\s*thumbnail(?:_[A-Za-z0-9]+)?\s+end\b", re.I)


def decode_qoi(data):
    """QOI -> (width, height, RGBA bytes), following the specification."""
    if data[:4] != b"qoif":
        raise ValueError("not QOI (magic %r)" % data[:4])
    width, height = struct.unpack(">II", data[4:12])
    pixels = bytearray(width * height * 4)
    index = [(0, 0, 0, 0)] * 64
    red, green, blue, alpha = 0, 0, 0, 255
    count, pos = 0, 14

    while count < width * height:
        op = data[pos]
        pos += 1
        if op == 0xFE:                                   # QOI_OP_RGB
            red, green, blue = data[pos], data[pos + 1], data[pos + 2]
            pos += 3
        elif op == 0xFF:                                 # QOI_OP_RGBA
            red, green, blue, alpha = data[pos:pos + 4]
            pos += 4
        elif op & 0xC0 == 0xC0:                          # QOI_OP_RUN
            for _ in range((op & 0x3F) + 1):
                offset = count * 4
                pixels[offset:offset + 4] = bytes((red, green, blue, alpha))
                count += 1
            continue                                     # runs do not fill the index
        elif op & 0xC0 == 0x00:                          # QOI_OP_INDEX
            red, green, blue, alpha = index[op & 0x3F]
        elif op & 0xC0 == 0x40:                          # QOI_OP_DIFF
            red = (red + ((op >> 4) & 3) - 2) & 255
            green = (green + ((op >> 2) & 3) - 2) & 255
            blue = (blue + (op & 3) - 2) & 255
        else:                                            # QOI_OP_LUMA
            dg = (op & 0x3F) - 32
            second = data[pos]
            pos += 1
            red = (red + dg + (((second >> 4) & 15) - 8)) & 255
            green = (green + dg) & 255
            blue = (blue + dg + ((second & 15) - 8)) & 255
        index[(red * 3 + green * 5 + blue * 7 + alpha * 11) % 64] = (red, green, blue, alpha)
        offset = count * 4
        pixels[offset:offset + 4] = bytes((red, green, blue, alpha))
        count += 1

    if data[pos:] != b"\x00" * 7 + b"\x01":
        raise ValueError("end marker missing or trailing data")
    return width, height, pixels


def write_png(path, width, height, rgba):
    rows = []
    for y in range(height):
        row = bytearray(b"\x00")
        for x in range(width):
            offset = (y * width + x) * 4
            row += rgba[offset:offset + 3]
        rows.append(bytes(row))

    def chunk(tag, payload):
        return (struct.pack(">I", len(payload)) + tag + payload
                + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF))

    with open(path, "wb") as handle:
        handle.write(b"\x89PNG\r\n\x1a\n")
        handle.write(chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)))
        handle.write(chunk(b"IDAT", zlib.compress(b"".join(rows), 9)))
        handle.write(chunk(b"IEND", b""))


def read_blocks(path):
    blocks, current = [], None
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            line = line.rstrip("\n")
            match = BEGIN_RE.match(line)
            if match:
                current = {"tag": match.group(1), "w": int(match.group(2)),
                           "h": int(match.group(3)), "declared": int(match.group(4)), "data": []}
                continue
            if current is None:
                continue
            if END_RE.match(line):
                current["data"] = "".join(current["data"])
                blocks.append(current)
                current = None
            elif line.startswith(";"):
                current["data"].append(line[1:].strip())
            else:
                current = None                          # block without an end
    return blocks


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("gcode")
    parser.add_argument("-o", "--out-dir", default=".")
    args = parser.parse_args()

    blocks = read_blocks(args.gcode)
    if not blocks:
        print("no thumbnails found")
        return 1

    base = os.path.splitext(os.path.basename(args.gcode))[0]
    problems = 0
    for block in blocks:
        fmt = block["tag"].partition("_")[2].upper() or "PNG"
        name = "%s_%dx%d_%s.png" % (base, block["w"], block["h"], fmt)
        target = os.path.join(args.out_dir, name)
        note = ""
        if len(block["data"]) != block["declared"]:
            note = "  WARNING: header says %d chars, block has %d" % (block["declared"], len(block["data"]))
            problems += 1
        blob = base64.b64decode(block["data"])
        try:
            if fmt == "QOI":
                width, height, rgba = decode_qoi(blob)
                write_png(target, width, height, rgba)
            else:
                with open(target, "wb") as handle:
                    handle.write(blob)
                width, height = struct.unpack(">II", blob[16:24]) if blob[:4] == b"\x89PNG" else (0, 0)
        except Exception as exc:                        # noqa: BLE001
            print("%-16s ERROR: %s" % (block["tag"], exc))
            problems += 1
            continue
        if (width, height) != (block["w"], block["h"]):
            note += "  WARNING: image is %dx%d" % (width, height)
            problems += 1
        print("%-16s %4dx%-4d %7d bytes -> %s%s" % (block["tag"], block["w"], block["h"],
                                                   len(blob), target, note))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
