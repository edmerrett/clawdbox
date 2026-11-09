#!/usr/bin/env python3
"""Render docs/sprites/<state>.gif and all-states.gif from art/anims/*.json (needs Pillow)."""
import json
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCALE = 8
STATES = ["idle", "thinking", "ultrathink", "reading", "writing", "running", "needs-you",
          "coffee", "vibing", "wave", "done", "error", "heart"]


def load(state):
    with open(os.path.join(ROOT, "art", "anims", f"{state}.json")) as fh:
        data = json.load(fh)
    frames, durations = [], []
    for f in data["frames"]:
        im = Image.new("RGB", (16, 16))
        px = im.load()
        for i, idx in enumerate(f["idx"]):
            h = f["palette"][idx].lstrip("#")
            px[i % 16, i // 16] = tuple(int(h[k:k + 2], 16) for k in (0, 2, 4))
        frames.append(im.resize((16 * SCALE, 16 * SCALE), Image.NEAREST))
        durations.append(f["ms"])
    return frames, durations


def main():
    out = os.path.join(ROOT, "docs", "sprites")
    os.makedirs(out, exist_ok=True)
    anims = {}
    for state in STATES:
        frames, durations = load(state)
        anims[state] = (frames, durations)
        frames[0].save(os.path.join(out, f"{state}.gif"), save_all=True, append_images=frames[1:],
                       duration=durations, loop=0)
    clock, total, pad, w = 50, 4000, 6, 16 * SCALE
    hero = []
    for t in range(0, total, clock):
        sheet = Image.new("RGB", (len(STATES) * (w + pad) - pad, w))
        for ci, state in enumerate(STATES):
            frames, durations = anims[state]
            tt, acc = t % sum(durations), 0
            for frame, d in zip(frames, durations, strict=True):
                acc += d
                if tt < acc:
                    sheet.paste(frame, (ci * (w + pad), 0))
                    break
        hero.append(sheet)
    hero[0].save(os.path.join(out, "all-states.gif"), save_all=True, append_images=hero[1:],
                 duration=clock, loop=0, optimize=True)
    print(f"wrote {len(STATES) + 1} gifs to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
