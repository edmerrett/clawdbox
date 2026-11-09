/**
 * Built-in Clawd sprites. The body is traced cell-for-cell from the Claude Code
 * "Clawd with laptop" GIF (12x8: wide orange body, stubby side arms, two square
 * eyes, four legs). The poses follow the official Claude Code sticker set:
 * Magnifier (reading), Skateboard (running), Lightbulb (thinking), Shiny
 * (ultrathink), Coffee and Headphones (long idle), Happy, Dizzy, Wave, Heart.
 *
 * Every state shares the same feet row so switching never teleports the
 * character. Edit the ASCII poses here and run `clawdbox sprites`, or drop
 * your own art/anims/<state>.json files (see art/README.md).
 */
import { Anim, Rgb, State, STATES } from './types.js';
import { Canvas, BLACK } from './canvas.js';

const ORANGE: Rgb = [0xd9, 0x6f, 0x4f]; // body, sampled from the GIF
const SHADE: Rgb = [0xb8, 0x55, 0x3a]; // turned-away side of the body
const GREY: Rgb = [0xa0, 0xa0, 0xa8]; // laptop, mug
const LIGHT: Rgb = [0xd8, 0xd8, 0xe0];
const WHITE: Rgb = [0xff, 0xff, 0xff];
const CYAN: Rgb = [0x20, 0xd0, 0xf0];
const YELLOW: Rgb = [0xff, 0xcc, 0x10];
const BLUE: Rgb = [0x30, 0x60, 0xe8]; // magnifier ring, headphones
const RED: Rgb = [0xf0, 0x30, 0x30];
const BROWN: Rgb = [0x6a, 0x40, 0x20]; // hat
const BAND: Rgb = [0xa0, 0x68, 0x30]; // hat band
const PLUM: Rgb = [0x70, 0x20, 0x50]; // skateboard deck

const PAL: Record<string, Rgb> = { O: ORANGE, D: SHADE, G: GREY, L: LIGHT, W: WHITE, C: CYAN, Y: YELLOW, B: BLUE, R: RED, H: BROWN, N: BAND, P: PLUM, K: BLACK };

/* ---------- body poses (12 columns) ---------- */

/** Standing, facing you. */
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

/** Crouched a row lower, left arm up, right arm down. */
const CROUCH = [
  '..OOOOOOOO..',
  'OOOOOOOOOO..',
  'OOOKOOOOKO..',
  '..OOOOOOOOOO',
  '..OOOOOOOOOO',
  '..OOOOOOOO..',
  '..O.O..O.O..',
];

/** Replace the eye row. */
function withEyes(rows: string[], eyeRow: string): string[] {
  return rows.map((r, i) => (i === 1 ? eyeRow : r));
}
const BLINK = withEyes(STAND, '..OOOOOOOO..');
const WIDE = withEyes(STAND, '..OKKOOKKO..');
/** Content, eyes closed: a flat line each. */
const CLOSED = withEyes(STAND, '..OKKOOKKO..').map((r, i) => (i === 1 ? '..OKKOOKKO..' : r));

/** Turned right, 10 wide, shaded back on the left; arms (DD) at row 3 (up) or 5 (down). */
function sideways(arms: 3 | 5): string[] {
  const rows = ['DDOOOOOO..', 'DDOOOOOO..', 'DDOKOOOK..', 'DDOOOOOO..', 'DDOOOOOO..', 'DDOOOOOO..', 'D.O..O.O..'];
  rows[arms] = 'DDOOOOOODD';
  return rows;
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
const stand = (c: Canvas, rows = STAND, dx = 0, dy = 0) => c.blit(rows, X + dx, top(rows) + dy, PAL);

/* ---------- activity states ---------- */

export function idle(): Anim {
  const seq: [string[], number][] = [
    [STAND, 700],
    [CROUCH, 350],
    [STAND, 500],
    [BLINK, 150],
    [STAND, 400],
  ];
  return { name: 'idle', frames: seq.map(([rows, ms]) => frame(ms, (c) => stand(c, rows))) };
}

/** Lightbulb above the head, flickering on. */
function bulb(c: Canvas, on: 0 | 1 | 2) {
  const glass: Rgb = on ? YELLOW : [0x50, 0x48, 0x30];
  c.blit(['.GGG.', 'GGGGG', 'GGGGG', '.GGG.', '..L..'].map((r) => r.replace(/G/g, 'g')), 9, 0, { ...PAL, g: glass, L: GREY });
  c.set(11, 4, GREY);
  if (on === 2) {
    // rays
    c.set(7, 1, WHITE);
    c.set(15, 1, WHITE);
    c.set(8, 4, WHITE);
    c.set(14, 4, WHITE);
  }
}

export function thinking(): Anim {
  const seq: (0 | 1 | 2)[] = [0, 0, 1, 2, 1, 1];
  return { name: 'thinking', frames: seq.map((on) => frame(on === 2 ? 220 : 300, (c) => { stand(c); bulb(c, on); })) };
}

/** Clawd Shiny: the body cycles through a diagonal rainbow. */
export function ultrathink(): Anim {
  const rainbow: Rgb[] = [
    [0xf0, 0x40, 0x40],
    [0xf0, 0x90, 0x20],
    [0xf0, 0xe0, 0x20],
    [0x40, 0xe0, 0x60],
    [0x30, 0x90, 0xf0],
    [0xa0, 0x50, 0xf0],
  ];
  return {
    name: 'ultrathink',
    frames: [0, 1, 2, 3, 4, 5].map((shift) =>
      frame(180, (c) => {
        stand(c);
        // recolour every orange pixel by its diagonal
        for (let y = 0; y < 16; y++)
          for (let x = 0; x < 16; x++) {
            const p = c.px[x + 16 * y];
            if (p[0] === ORANGE[0] && p[1] === ORANGE[1] && p[2] === ORANGE[2]) c.set(x, y, rainbow[(x + y + shift) % rainbow.length]);
          }
        bulb(c, shift % 3 === 0 ? 2 : 1);
      }),
    ),
  };
}

/** Clawd Magnifier: hat, one eye squinting, lens over the other eye. */
export function reading(): Anim {
  const hat = (c: Canvas) => {
    c.rect(4, 4, 8, 1, BROWN);
    c.rect(4, 5, 8, 1, BAND);
    c.rect(2, 6, 12, 1, BROWN); // brim
  };
  const lens = (c: Canvas, lx: number) => {
    // 4x4 blue ring; the eye under it appears magnified (2x2)
    c.blit(['.BB.', 'B..B', 'B..B', '.BB.'], lx, 7, PAL);
    c.rect(lx + 1, 8, 2, 2, BLACK);
    c.set(lx + 4, 11, BLUE); // handle
    c.set(lx + 5, 12, BLUE);
  };
  const body = withEyes(STAND, '..OKKOOOOO..'); // left eye squints to a line; right eye drawn by the lens
  return {
    name: 'reading',
    frames: [7, 8, 7, 7].map((lx, i) =>
      frame(i === 3 ? 500 : 320, (c) => {
        stand(c, body);
        hat(c);
        lens(c, lx);
      }),
    ),
  };
}

export function writing(): Anim {
  const laptop = (c: Canvas, glow: boolean) => {
    c.rect(10, FEET, 3, 1, GREY);
    c.set(13, FEET - 1, GREY);
    c.set(14, FEET - 2, GREY);
    c.set(15, FEET - 3, GREY);
    if (glow) c.set(14, FEET - 3, CYAN);
  };
  const seq: [3 | 5, boolean][] = [[5, true], [3, true], [5, true], [3, true], [5, true], [3, false]];
  return {
    name: 'writing',
    frames: seq.map(([arms, glow]) =>
      frame(260, (c) => {
        const body = sideways(arms);
        c.blit(body, 1, top(body), PAL);
        laptop(c, glow);
      }),
    ),
  };
}

/** Clawd Skateboard: body on a deck, wheels spinning, speed lines behind. */
export function running(): Anim {
  const body = STAND.slice(0, 6); // no legs: they're on the board
  return {
    name: 'running',
    frames: [0, 1, 2, 3].map((i) =>
      frame(180, (c) => {
        const dy = i % 2 ? -1 : 0;
        c.blit(body, X + 1, FEET - 2 - body.length + 1 + dy, PAL);
        c.rect(2, FEET - 1, 12, 1, PLUM); // deck
        const w: Rgb = i % 2 ? YELLOW : [0xa0, 0x80, 0x10];
        c.rect(4, FEET, 2, 1, w);
        c.rect(10, FEET, 2, 1, w);
        [[6, 2], [8, 1], [10, 2]].forEach(([y, len], j) => {
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
        stand(c, i === 0 ? WIDE : STAND, 0, 0);
        c.blit(q, 6, 0, i === 0 ? PAL : { ...PAL, Y: [0x80, 0x66, 0x08] as Rgb });
      }),
    ),
  };
}

/* ---------- long-idle stages ---------- */

/** Clawd Coffee: a mug in the right arm, steam drifting up. */
export function coffee(): Anim {
  const steam = [
    [[13, 7], [14, 5]],
    [[14, 7], [13, 5]],
    [[13, 6], [14, 4]],
  ];
  return {
    name: 'coffee',
    frames: steam.map((puffs, i) =>
      frame(450, (c) => {
        stand(c, i === 1 ? CLOSED : STAND, -1, 0);
        c.rect(12, 9, 3, 3, LIGHT); // mug
        c.set(15, 10, LIGHT); // handle
        c.rect(12, 9, 3, 1, GREY); // coffee surface
        for (const [x, y] of puffs) c.set(x, y, WHITE);
      }),
    ),
  };
}

/** Clawd Headphones: blue band and cups, eyes closed, head nodding. */
export function vibing(): Anim {
  return {
    name: 'vibing',
    frames: [0, 1, 2, 1].map((i) =>
      frame(300, (c) => {
        const dy = i === 2 ? 1 : i === 0 ? 0 : 0;
        stand(c, CLOSED, 0, dy);
        c.rect(4, 5 + dy, 8, 1, BLUE); // band
        c.set(3, 6 + dy, BLUE);
        c.set(12, 6 + dy, BLUE);
        c.rect(1, 7 + dy, 2, 3, BLUE); // cups
        c.rect(13, 7 + dy, 2, 3, BLUE);
        // a note floating up
        const ny = 4 - i;
        c.set(14, ny, WHITE);
        c.set(15, ny - 1, WHITE);
      }),
    ),
  };
}

/* ---------- flashes ---------- */

/** Clawd Wave: right arm up, waving. */
export function wave(): Anim {
  return {
    name: 'wave',
    frames: [0, 1, 0, 1].map((i) =>
      frame(250, (c) => {
        const rows = STAND.map((r, j) => (j === 2 || j === 3 ? r.slice(0, 10) + '..' : r)); // right arm removed
        stand(c, rows);
        // arm raised beside the head
        c.rect(12, 7, 2, 3, ORANGE);
        c.rect(12 + i, 5, 2, 2, ORANGE); // hand sways
      }),
    ),
  };
}

/** Clawd Happy: > < eyes and a little hop. */
export function done(): Anim {
  const happy = STAND.map((r) => r.replace(/K/g, 'O'));
  return {
    name: 'done',
    frames: [0, -1, 0, 0].map((dy, i) =>
      frame(i === 3 ? 400 : 220, (c) => {
        stand(c, happy, 0, dy);
        const y = top(STAND) + dy;
        // > eye
        c.set(4, y, BLACK);
        c.set(5, y + 1, BLACK);
        c.set(4, y + 2, BLACK);
        // < eye
        c.set(9, y, BLACK);
        c.set(8, y + 1, BLACK);
        c.set(9, y + 2, BLACK);
      }),
    ),
  };
}

/** Clawd Dizzy: spiral eyes, swaying. */
export function error(): Anim {
  const spiralA = ['KKK', '..K', 'KKK'];
  const spiralB = ['KKK', 'K..', 'KKK'];
  return {
    name: 'error',
    frames: [0, 1, 2, 3].map((i) =>
      frame(200, (c) => {
        const dx = i === 1 ? -1 : i === 3 ? 1 : 0;
        const noEyes = STAND.map((r) => r.replace(/K/g, 'O'));
        stand(c, noEyes, dx, 0);
        const y = top(STAND);
        c.blit(i % 2 ? spiralA : spiralB, X + dx + 2, y, PAL);
        c.blit(i % 2 ? spiralB : spiralA, X + dx + 7, y, PAL);
      }),
    ),
  };
}

/** Clawd Heart: a red heart beating above the head. */
export function heart(): Anim {
  const big = ['.RR.RR.', 'RRRRRRR', 'RRRRRRR', '.RRRRR.', '..RRR..', '...R...'];
  const small = ['.......', '.R...R.', 'RRRRRRR', '.RRRRR.', '..RRR..', '...R...'];
  return {
    name: 'heart',
    frames: [0, 1, 0, 1].map((i) =>
      frame(i ? 350 : 250, (c) => {
        stand(c, i ? STAND : WIDE);
        c.blit(i ? small : big, 5, 0, PAL);
      }),
    ),
  };
}

export function clawdSprites(): Record<State, Anim> {
  const all: Record<State, Anim> = {
    idle: idle(),
    thinking: thinking(),
    ultrathink: ultrathink(),
    reading: reading(),
    writing: writing(),
    running: running(),
    'needs-you': needsYou(),
    coffee: coffee(),
    vibing: vibing(),
    wave: wave(),
    done: done(),
    error: error(),
    heart: heart(),
  };
  for (const s of STATES) if (!all[s]) throw new Error(`missing sprite for ${s}`);
  return all;
}
