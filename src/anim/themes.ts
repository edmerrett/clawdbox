/**
 * Themes: optional seasonal art that stands in for some of the standard sprites while
 * themes are enabled (menu bar → Enable Themes, `clawdbox themes on`, POST /themes?enabled=1).
 *
 * A theme only overrides the states it draws; everything else stays the standard Clawd.
 * The panel's states, timing and priorities never change, only what a state looks like.
 */
import { Anim, Rgb, State } from './types.js';
import { Canvas, BLACK } from './canvas.js';

export interface Theme {
  /** Stable id, used in settings and /state. */
  name: string;
  /** Shown in the menu bar. */
  label: string;
  /** The states this theme redraws. */
  sprites(): Partial<Record<State, Anim>>;
}

/* ---------- Christmas ---------- */

const ORANGE: Rgb = [0xd9, 0x6f, 0x4f];
const WHITE: Rgb = [0xff, 0xff, 0xff];
const SNOW: Rgb = [0xc8, 0xd8, 0xf0]; // falling flakes, a touch dimmer than the hat trim
const GROUND: Rgb = [0x90, 0xa8, 0xd0]; // settled snow
const SANTA: Rgb = [0xe0, 0x20, 0x20];
const PINE: Rgb = [0x10, 0x90, 0x30];
const PINE_DARK: Rgb = [0x08, 0x60, 0x20];
const TRUNK: Rgb = [0x6a, 0x40, 0x20];
const STAR: Rgb = [0xff, 0xd0, 0x10];
const STAR_DIM: Rgb = [0xa0, 0x80, 0x08];
const GIFT: Rgb = [0x30, 0x60, 0xe8];
const RIBBON: Rgb = [0xff, 0xcc, 0x10];

/** Fairy-light colours; each bulb steps through these, offset so neighbours differ. */
const LIGHTS: Rgb[] = [
  [0xff, 0x30, 0x30],
  [0xff, 0xcc, 0x10],
  [0x30, 0xa0, 0xff],
  [0xff, 0x60, 0xd0],
];

const PAL: Record<string, Rgb> = { O: ORANGE, K: BLACK, W: WHITE, R: SANTA, G: PINE, g: PINE_DARK, H: TRUNK, B: GIFT, Y: RIBBON };

/** Clawd facing you (the standard idle pose), 12 wide. */
const CLAWD = [
  '..OOOOOOOO..',
  '..OKOOOOKO..',
  'OOOOOOOOOOOO',
  'OOOOOOOOOOOO',
  '..OOOOOOOO..',
  '..OOOOOOOO..',
  '..O.O..O.O..',
  '..O.O..O.O..',
];
const CLAWD_BLINK = CLAWD.map((r, i) => (i === 1 ? '..OOOOOOOO..' : r));

/** Santa hat, sat on the head (rows 3-6); the tip flops left to a white bobble. */
const HAT = ['W.RRR.......', 'WRRRRR......', '..RRRRRR....', '..WWWWWWWW..'];

/** The tree, columns 10-15: star (drawn separately) at the top, tiers, trunk, a present. */
const TREE = [
  '....', // star rows 0-2 are drawn by `star`
  '',
  '',
  '..G...',
  '.GGG..',
  '..G...',
  '.GGG..',
  'GGGGG.',
  '.GGG..',
  'GGGGG.',
  'GgGGG.',
  'GGGGG.',
  '..H...',
  '.BYB..',
  '.BYB..',
].map((r) => r.padEnd(6, '.'));
const TREE_X = 10;

/** Fairy lights on the tree, as [x, y]; every one is on a pine pixel. */
const BULBS: [number, number][] = [
  [11, 4],
  [13, 6],
  [10, 7],
  [12, 8],
  [14, 7],
  [11, 9],
  [13, 10],
  [14, 11],
  [10, 11],
];

/** Snowflakes as [x, row at frame 0]; they fall a row a frame and wrap every 8 rows, so the loop is seamless. */
const FLAKES: [number, number][] = [
  [1, 0],
  [5, 2],
  [8, 5],
  [3, 6],
  [0, 4],
  [9, 1],
  [6, 7],
];

function star(c: Canvas, bright: boolean) {
  const s = bright ? STAR : STAR_DIM;
  c.set(12, 0, s);
  c.set(11, 1, s);
  c.set(12, 1, bright ? WHITE : s);
  c.set(13, 1, s);
  c.set(12, 2, s);
}

/** Clawd in a Santa hat beside a twinkling Christmas tree, snow falling. */
export function christmasIdle(): Anim {
  const FRAMES = 8;
  const FEET = 14;
  const clawdTop = FEET - CLAWD.length + 1;
  const frames = [];
  for (let i = 0; i < FRAMES; i++) {
    const c = new Canvas();
    // snow first: Clawd and the tree stand in front of it
    for (const [x, y0] of FLAKES) {
      for (const y of [(y0 + i) % 8, ((y0 + i) % 8) + 8]) c.set(x, y, SNOW);
    }
    c.rect(0, 15, 16, 1, GROUND);
    c.blit(i === 5 ? CLAWD_BLINK : CLAWD, 0, clawdTop, PAL);
    c.blit(HAT, 0, clawdTop - 4, PAL);
    c.blit(TREE, TREE_X, 0, PAL);
    star(c, i % 4 !== 3);
    BULBS.forEach(([x, y], j) => c.set(x, y, LIGHTS[(j + Math.floor(i / 2)) % LIGHTS.length]));
    frames.push({ ms: 250, pixels: c.pixels() });
  }
  return { name: 'idle', frames };
}

export const THEMES: Record<string, Theme> = {
  christmas: { name: 'christmas', label: 'Christmas', sprites: () => ({ idle: christmasIdle() }) },
};

/**
 * The theme shown while themes are enabled. There is one theme today; when there are
 * more, this is where one is picked (by date, or by a setting).
 */
export function activeTheme(_now: Date = new Date()): Theme {
  return THEMES.christmas;
}

/** `base` with the theme's sprites laid over it (a new record; `base` is not changed). */
export function withTheme(base: Record<State, Anim>, theme: Theme | null): Record<State, Anim> {
  if (!theme) return base;
  const over = theme.sprites();
  const out = { ...base };
  for (const [s, a] of Object.entries(over) as [State, Anim][]) out[s] = { ...a, name: s };
  return out;
}
