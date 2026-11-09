/**
 * Convert hand-drawn art into art/anims/<state>.json.
 *
 * Inputs supported:
 *  1. Aseprite / LibreSprite sheet export:  build-anims sheet.json [--out dir]
 *     (export with: aseprite -b clawd.aseprite --sheet sheet.png --data sheet.json --list-tags --format json-array)
 *     Each frame tag becomes one state; tag names must be the state names.
 *  2. A directory of PNG strips:             build-anims strips/ --fps 6 [--out dir]
 *     Each <state>.png is 16 px tall and 16*N px wide (Piskel "spritesheet" export, 1 row).
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { Anim, AnimFile, Frame, HEIGHT, Rgb, STATES, WIDTH, isState, toAnimFile } from '../anim/types.js';

interface AsepriteJson {
  frames: { filename: string; frame: { x: number; y: number; w: number; h: number }; duration: number }[] | Record<string, { frame: { x: number; y: number; w: number; h: number }; duration: number }>;
  meta: { image: string; frameTags?: { name: string; from: number; to: number; direction?: string }[] };
}

function readPng(path: string): PNG {
  return PNG.sync.read(readFileSync(path));
}

/** Copy a 16x16 region out of a PNG; transparent (alpha < 128) becomes black. */
function region(png: PNG, x0: number, y0: number): Rgb[] {
  const out: Rgb[] = [];
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const i = ((y0 + y) * png.width + (x0 + x)) * 4;
      const a = png.data[i + 3];
      out.push(a < 128 ? [0, 0, 0] : [png.data[i], png.data[i + 1], png.data[i + 2]]);
    }
  }
  return out;
}

export function fromAseprite(jsonPath: string): Anim[] {
  const meta = JSON.parse(readFileSync(jsonPath, 'utf8')) as AsepriteJson;
  const frames = Array.isArray(meta.frames) ? meta.frames : Object.values(meta.frames);
  const png = readPng(join(dirname(jsonPath), meta.meta.image));
  const tags = meta.meta.frameTags ?? [];
  if (!tags.length) throw new Error('sheet.json has no frameTags; export with --list-tags and tag each state');
  return tags.map((t) => {
    const fs: Frame[] = [];
    for (let i = t.from; i <= t.to; i++) {
      const f = frames[i];
      if (f.frame.w !== WIDTH || f.frame.h !== HEIGHT) throw new Error(`${t.name} frame ${i} is ${f.frame.w}x${f.frame.h}, expected 16x16`);
      fs.push({ ms: f.duration, pixels: region(png, f.frame.x, f.frame.y) });
    }
    if (t.direction === 'pingpong' && fs.length > 2) fs.push(...fs.slice(1, -1).reverse());
    return { name: t.name, frames: fs };
  });
}

export function fromStrips(dir: string, fps: number): Anim[] {
  const ms = Math.round(1000 / fps);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.png'))
    .map((f) => {
      const png = readPng(join(dir, f));
      if (png.height !== HEIGHT || png.width % WIDTH !== 0) throw new Error(`${f}: expected 16 px tall and a multiple of 16 wide, got ${png.width}x${png.height}`);
      const n = png.width / WIDTH;
      return { name: basename(f, '.png'), frames: Array.from({ length: n }, (_, i) => ({ ms, pixels: region(png, i * WIDTH, 0) })) };
    });
}

export function writeAnims(anims: Anim[], outDir: string): string[] {
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  for (const a of anims) {
    if (!isState(a.name)) {
      console.warn(`skipping "${a.name}": not a state (${STATES.join(', ')})`);
      continue;
    }
    const file: AnimFile = toAnimFile(a);
    const p = join(outDir, `${a.name}.json`);
    writeFileSync(p, JSON.stringify(file));
    written.push(p);
  }
  const missing = STATES.filter((s) => !anims.some((a) => a.name === s));
  if (missing.length) console.warn(`note: no art for ${missing.join(', ')} (the daemon needs all six; run "clawdbox sprites" for the rest)`);
  return written;
}

export function buildAnims(input: string, outDir: string, fps: number): string[] {
  const p = resolve(input);
  if (!existsSync(p)) throw new Error(`${input} not found`);
  const anims = statSync(p).isDirectory() ? fromStrips(p, fps) : fromAseprite(p);
  return writeAnims(anims, outDir);
}
