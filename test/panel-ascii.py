#!/usr/bin/env python3
"""Print the digital Divoom found in a PNG as a 16x16 ASCII grid (CI evidence; stdlib only).

usage: panel-ascii.py <png> [--require-lit]

Finds the panel's dark grey body (a ~148 px square), samples the centre of each LED and
prints '#' for lit, '.' for off. Works on `Clawdbox --snapshot` output and on screenshots
of the open menu, at 1x or 2x.
"""
import struct
import sys
import zlib


def read_png(path):
    data = open(path, "rb").read()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    pos, idat, w = 8, b"", 0
    while pos < len(data):
        (n,), kind = struct.unpack(">I", data[pos : pos + 4]), data[pos + 4 : pos + 8]
        body = data[pos + 8 : pos + 8 + n]
        if kind == b"IHDR":
            w, h, depth, ctype, _, _, interlace = struct.unpack(">IIBBBBB", body)
            assert depth == 8 and interlace == 0 and ctype in (2, 6), f"unsupported PNG ({depth=}, {ctype=})"
            bpp = 4 if ctype == 6 else 3
        elif kind == b"IDAT":
            idat += body
        pos += 12 + n
    raw, stride = zlib.decompress(idat), w * bpp
    rows, prev = [], bytearray(stride)
    for y in range(h):
        f, line = raw[y * (stride + 1)], bytearray(raw[y * (stride + 1) + 1 : (y + 1) * (stride + 1)])
        for i in range(stride):
            a = line[i - bpp] if i >= bpp else 0
            b, c = prev[i], (prev[i - bpp] if i >= bpp else 0)
            if f == 1:
                line[i] = (line[i] + a) & 255
            elif f == 2:
                line[i] = (line[i] + b) & 255
            elif f == 3:
                line[i] = (line[i] + (a + b) // 2) & 255
            elif f == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        rows.append(line)
        prev = line
    return w, h, bpp, rows


def main():
    w, h, bpp, rows = read_png(sys.argv[1])

    def px(x, y):
        return tuple(rows[y][x * bpp : x * bpp + 3])

    def is_body(x, y):
        r, g, b = px(x, y)
        return 25 <= r <= 65 and abs(r - g) < 8 and abs(g - b) < 8

    def is_black(x, y):
        return sum(px(x, y)) < 30

    # A row through the body's rounded top is one grey run a little under 148 pt wide; the
    # screen's black rim sits 8-10 pt below the top edge. Take the first run that fits.
    found = None
    for y in range(h):
        x = 0
        while x < w and not found:
            if not is_body(x, y):
                x += 1
                continue
            x0 = x
            while x < w and is_body(x, y):
                x += 1
            n = x - x0
            scale = 2 if n > 200 else 1
            if not 138 * scale <= n <= 149 * scale:
                continue
            cx, top = x0 + n // 2, y
            while top > 0 and is_body(cx, top - 1):
                top -= 1
            if top + 9 * scale >= h or not is_black(cx, top + 9 * scale):
                continue
            row, left = top + 16 * scale, x0 + 3 * scale
            while left > 0 and is_body(left - 1, row):
                left -= 1
            found = (left, top, 2 * (cx - left))
        if found:
            break
    if not found:
        print(f"no panel found in {sys.argv[1]} ({w}x{h})")
        return 1
    left, y, side = found
    scale = side / 148
    lit = 0
    print(f"panel at x={left} y={y} side={side} ({w}x{h} image)")
    for r in range(16):
        line = ""
        for c in range(16):
            rgb = px(int(left + (10 + c * 8 + 4) * scale), int(y + (10 + r * 8 + 4) * scale))
            on = sum(rgb) > 120
            lit += on
            line += "#" if on else "."
        print(line)
    print(f"lit LEDs: {lit}")
    return 1 if "--require-lit" in sys.argv and lit == 0 else 0


sys.exit(main())
