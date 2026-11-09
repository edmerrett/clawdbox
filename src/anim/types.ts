/** Shared animation types. The display is 16x16; pixels are row-major, index = x + 16*y. */

export const WIDTH = 16;
export const HEIGHT = 16;
export const PIXELS = WIDTH * HEIGHT;

export type Rgb = readonly [number, number, number];

export interface Frame {
  /** How long this frame is shown, in milliseconds. */
  ms: number;
  /** 256 RGB triples, row-major, top-left first. */
  pixels: Rgb[];
}

export interface Anim {
  name: string;
  frames: Frame[];
}

/** Total duration of one loop, in ms. */
export function loopMs(anim: Anim): number {
  return anim.frames.reduce((n, f) => n + f.ms, 0);
}

export const STATES = ['idle', 'thinking', 'reading', 'writing', 'running', 'needs-you'] as const;
export type State = (typeof STATES)[number];

export function isState(s: string): s is State {
  return (STATES as readonly string[]).includes(s);
}

/** Higher wins when several sessions disagree. */
export const PRIORITY: Record<State, number> = {
  idle: 0,
  thinking: 1,
  reading: 2,
  writing: 3,
  running: 4,
  'needs-you': 10,
};

/* ---------- JSON file format: art/anims/<state>.json ---------- */

export interface AnimFileFrame {
  ms: number;
  /** Palette as "#rrggbb" strings. */
  palette: string[];
  /** 256 palette indices, row-major. */
  idx: number[];
}

export interface AnimFile {
  name: string;
  frames: AnimFileFrame[];
}

export function hexToRgb(hex: string): Rgb {
  const h = hex.replace('#', '');
  if (h.length !== 6) throw new Error(`bad colour ${hex}`);
  const n = parseInt(h, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

export function rgbToHex([r, g, b]: Rgb): string {
  return '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('');
}

export function fromAnimFile(file: AnimFile): Anim {
  return {
    name: file.name,
    frames: file.frames.map((f, i) => {
      if (f.idx.length !== PIXELS) throw new Error(`${file.name} frame ${i}: expected ${PIXELS} pixels, got ${f.idx.length}`);
      const pal = f.palette.map(hexToRgb);
      return {
        ms: f.ms,
        pixels: f.idx.map((p) => {
          const c = pal[p];
          if (!c) throw new Error(`${file.name} frame ${i}: palette index ${p} out of range`);
          return c;
        }),
      };
    }),
  };
}

export function toAnimFile(anim: Anim): AnimFile {
  return {
    name: anim.name,
    frames: anim.frames.map((f) => {
      const { palette, idx } = palettize(f.pixels);
      return { ms: f.ms, palette: palette.map(rgbToHex), idx };
    }),
  };
}

/** Build a palette in first-seen order and map every pixel to an index. */
export function palettize(pixels: readonly Rgb[]): { palette: Rgb[]; idx: number[] } {
  const palette: Rgb[] = [];
  const seen = new Map<number, number>();
  const idx = pixels.map(([r, g, b]) => {
    const key = (r << 16) | (g << 8) | b;
    let i = seen.get(key);
    if (i === undefined) {
      i = palette.length;
      palette.push([r, g, b]);
      seen.set(key, i);
    }
    return i;
  });
  return { palette, idx };
}
