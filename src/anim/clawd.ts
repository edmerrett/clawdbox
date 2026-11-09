/**
 * Built-in Clawd sprites, traced from the "Claude Code Clawd with laptop" GIF:
 * a 12x8 orange body with stubby side arms, two square black eyes, four legs,
 * and a grey laptop. Every state is a loop that shares the same base pose so
 * switching never teleports the character.
 *
 * Replace or refine them by dropping your own art/anims/<state>.json files.
 */
import { Anim, Rgb, State, STATES } from './types.js';
import { Canvas, BLACK } from './canvas.js';

const ORANGE: Rgb = [0xd9, 0x6f, 0x4f]; // body, sampled from the GIF
const SHADE: Rgb = [0xb8, 0x55, 0x3a]; // turned-away side of the body
const GREY: Rgb = [0xa0, 0xa0, 0xa8]; // laptop
const WHITE: Rgb = [0xff, 0xff, 0xff];
const INK: Rgb = [0x60, 0x60, 0x70]; // text on the page
const CYAN: Rgb = [0x20, 0xd0, 0xf0];
const YELLOW: Rgb = [0xff, 0xcc, 0x10];
const GREEN: Rgb = [0x3c, 0xe0, 0x6e];

const PAL = { O: ORANGE, D: SHADE, G: GREY, W: WHITE, I: INK, C: CYAN, Y: YELLOW, g: GREEN, K: BLACK };

/* ---------- poses traced from the GIF (12 columns) ---------- */

/** Standing, facing you. GIF frames 0-3. */
const STAND = [
  '..OOOOOOOO..',
  '..OKOOOOKO..',
  'OOOOOOOOOOOO',
  'OOOOOOOOOOOO',
  '..OOOOOOOO..',
  '..OOOOOOOO..',
  '..O.O..O.O..',
  '..O.O..O.O..',
];

/** Crouched a row lower, left arm up, right arm down. GIF frames 4-7. */
const CROUCH = [
  '..OOOOOOOO..',
  'OOOOOOOOOO..',
  'OOOKOOOOKO..',
  '..OOOOOOOOOO',
  '..OOOOOOOOOO',
  '..OOOOOOOO..',
  '..O.O..O.O..',
];

/** Standing with eyes shut (a blink). */
const BLINK = STAND.map((r, i) => (i === 1 ? '..OOOOOOOO..' : r));

/** Standing with wide eyes. */
const WIDE = STAND.map((r, i) => (i === 1 ? '..OKKOOKKO..' : r));

/**
 * Turned to the right, body 10 wide with the shaded back on the left.
 * Arms (the "DD" on the right) are at row `arms` (3 = up, 5 = down). GIF frames 14-29.
 */
function sideways(arms: 3 | 5): string[] {
  const rows = ['DDOOOOOO..', 'DDOOOOOO..', 'DDOKOOOK..', 'DDOOOOOO..', 'DDOOOOOO..', 'DDOOOOOO..', 'D.O..O.O..'];
  rows[arms] = 'DDOOOOOODD';
  return rows;
}

/** Legs splayed for the run cycle. */
function legs(rows: string[], alt: boolean): string[] {
  const out = [...rows];
  const feet = alt ? '.O..O..O.O..' : '..O.O..O..O.';
  out[out.length - 1] = feet;
  return out;
}

/* ---------- layout ---------- */

const X = 2; // sprite left edge
const FEET = 14; // bottom row of the feet
const top = (rows: string[]) => FEET - rows.length + 1;

function frame(ms: number, draw: (c: Canvas) => void) {
  const c = new Canvas();
  draw(c);
  return { ms, pixels: c.pixels() };
}

/* ---------- states ---------- */

export function idle(): Anim {
  // stand … crouch … stand … blink, like the GIF's opening beat
  const seq: [string[], number][] = [
    [STAND, 700],
    [CROUCH, 350],
    [STAND, 500],
    [BLINK, 120],
    [STAND, 400],
  ];
  return { name: 'idle', frames: seq.map(([rows, ms]) => frame(ms, (c) => c.blit(rows, X, top(rows), PAL))) };
}

export function thinking(): Anim {
  const dots = [0, 1, 2, 3, 3];
  return {
    name: 'thinking',
    frames: dots.map((n, i) =>
      frame(i === dots.length - 1 ? 350 : 220, (c) => {
        c.blit(STAND, X, top(STAND), PAL);
        for (let k = 0; k < n; k++) c.rect(7 + k * 2, 3, 1, 1, WHITE);
      }),
    ),
  };
}

export function reading(): Anim {
  return {
    name: 'reading',
    frames: [0, 1, 2].map((s) =>
      frame(300, (c) => {
        const body = sideways(5);
        c.blit(body, 1, top(body), PAL);
        // a page held in front, lines of text scrolling
        c.rect(11, 6, 5, 8, WHITE);
        for (let line = 0; line < 3; line++) c.rect(12, 7 + ((line * 2 + s) % 6), 3, 1, INK);
      }),
    ),
  };
}

export function writing(): Anim {
  // The laptop from the GIF: a base on the ground and a lid leaning back to the right.
  const laptop = (c: Canvas, glow: boolean) => {
    c.rect(10, FEET, 3, 1, GREY); // base
    c.set(13, FEET - 1, GREY); // lid
    c.set(14, FEET - 2, GREY);
    c.set(15, FEET - 3, GREY);
    if (glow) c.set(14, FEET - 3, CYAN); // screen
  };
  const seq: [3 | 5, boolean][] = [
    [5, true],
    [3, true],
    [5, false],
    [3, true],
  ];
  return {
    name: 'writing',
    frames: seq.map(([arms, glow]) =>
      frame(130, (c) => {
        const body = sideways(arms);
        c.blit(body, 1, top(body), PAL);
        laptop(c, glow);
      }),
    ),
  };
}

export function running(): Anim {
  return {
    name: 'running',
    frames: [0, 1, 2, 3].map((i) =>
      frame(110, (c) => {
        const bob = i % 2 ? -1 : 0;
        const rows = legs(STAND, i % 2 === 1);
        c.blit(rows, X + 1, top(rows) + bob, PAL);
        // speed lines trailing on the left
        [[8, 2], [10, 1], [12, 2]].forEach(([y, len], j) => {
          if ((i + j) % 2 === 0) c.rect(0, y, len, 1, CYAN);
        });
      }),
    ),
  };
}

export function needsYou(): Anim {
  const q = ['.YYY.', 'Y...Y', '....Y', '..YY.', '..Y..', '.....', '..Y..'];
  return {
    name: 'needs-you',
    frames: [0, 1].map((i) =>
      frame(400, (c) => {
        const rows = i === 0 ? WIDE : STAND;
        c.blit(rows, X, top(rows), PAL);
        c.blit(q, 6, 0, i === 0 ? PAL : { ...PAL, Y: [0x80, 0x66, 0x08] as Rgb });
      }),
    ),
  };
}

export function clawdSprites(): Record<State, Anim> {
  const all = { idle: idle(), thinking: thinking(), reading: reading(), writing: writing(), running: running(), 'needs-you': needsYou() };
  for (const s of STATES) if (!all[s]) throw new Error(`missing sprite for ${s}`);
  return all;
}

/** Kept for callers that still use the old name. */
export const placeholders = clawdSprites;
export { GREEN };
