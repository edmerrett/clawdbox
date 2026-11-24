#!/usr/bin/env python3
"""Check the Enable Themes switch drawn by `Clawdbox --snapshot-switch` (CI evidence; stdlib only).

usage: switch-colour.py <png> on|off

on:  the track is filled with the accent colour (the default macOS accent is blue)
off: no accent-coloured pixels at all
"""

import importlib.util
import os
import sys

spec = importlib.util.spec_from_file_location("panel_ascii", os.path.join(os.path.dirname(__file__), "panel-ascii.py"))
panel_ascii = importlib.util.module_from_spec(spec)
spec.loader.exec_module(panel_ascii)


def accent_pixels(path):
    w, h, bpp, rows = panel_ascii.read_png(path)
    n = 0
    for y in range(h):
        for x in range(w):
            r, g, b = rows[y][x * bpp : x * bpp + 3]
            a = rows[y][x * bpp + 3] if bpp == 4 else 255
            if a > 128 and b > 150 and b - r > 80:
                n += 1
    return n, w * h


def main():
    path, want = sys.argv[1], sys.argv[2]
    n, total = accent_pixels(path)
    print(f"{path}: {n} accent-coloured pixels of {total}")
    if want == "on" and n < 100:
        sys.exit("the switch is on but its track is not drawn in the accent colour")
    if want == "off" and n > 0:
        sys.exit("the switch is off but shows accent-coloured pixels")


if __name__ == "__main__":
    main()
