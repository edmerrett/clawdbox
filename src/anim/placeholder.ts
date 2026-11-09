/**
 * Procedural placeholder sprites: a small orange blob acting out each state.
 * These exist so the whole pipeline works before any hand-drawn art lands.
 * Replace them by dropping your own art/anims/<state>.json files (see README).
 */
import { Anim, Rgb, State, STATES } from './types.js';
import { Canvas, BLACK } from './canvas.js';

const ORANGE: Rgb = [0xda, 0x77, 0x56];
const DARK: Rgb = [0x7a, 0x34, 0x1c];
const WHITE: Rgb = [0xff, 0xff, 0xff];
const GREY: Rgb = [0x80, 0x80, 0x90];
const GREEN: Rgb = [0x3c, 0xe0, 0x6e];
const CYAN: Rgb = [0x20, 0xd0, 0xf0];
const YELLOW: Rgb = [0xff, 0xcc, 0x10];

const PAL = { O: ORANGE, D: DARK, W: WHITE, G: GREY, g: GREEN, C: CYAN, Y: YELLOW, K: BLACK };

/** 10x9 body. Eyes are "off" pixels so they read as black holes on the LEDs. */
function body(opts: { blink?: boolean; eyeShift?: number; wide?: boolean } = {}): string[] {
  const e = opts.eyeShift ?? 0;
  const eyeRow = (): string => {
    const r = 'OOOOOOOOOO'.split('');
    const l = 2 + e;
    const rr = 7 + e;
    r[l] = 'K';
    r[rr] = 'K';
    if (opts.wide) {
      r[l + 1] = 'K';
      r[rr - 1] = 'K';
    }
    return r.join('');
  };
  const eyes = opts.blink ? ['OOOOOOOOOO', 'OODOOOODOO'] : [eyeRow(), eyeRow()];
  return ['..OOOOOO..', '.OOOOOOOO.', 'OOOOOOOOOO', ...eyes, 'OOOOOOOOOO', 'OOOOOOOOOO', '.OOOOOOOO.', '..OO..OO..'];
}

const LEGS_ALT = ['..OO..OO..', '.OO....OO.'];

function frame(ms: number, draw: (c: Canvas) => void) {
  const c = new Canvas();
  draw(c);
  return { ms, pixels: c.pixels() };
}

const BODY_X = 3;
const BODY_Y = 5;

export function idle(): Anim {
  const bob = [0, -1, -1, 0, 0, 0];
  return {
    name: 'idle',
    frames: bob.map((dy, i) =>
      frame(220, (c) => {
        c.blit(body({ blink: i === 4 }), BODY_X, BODY_Y + dy, PAL);
      }),
    ),
  };
}

export function thinking(): Anim {
  const dots = [1, 2, 3, 3, 0];
  return {
    name: 'thinking',
    frames: dots.map((n) =>
      frame(260, (c) => {
        c.blit(body({ eyeShift: 1 }), BODY_X, BODY_Y, PAL);
        for (let i = 0; i < n; i++) c.rect(9 + i * 2, 2, 1, 1, WHITE);
      }),
    ),
  };
}

export function reading(): Anim {
  const scroll = [0, 1, 2];
  return {
    name: 'reading',
    frames: scroll.map((s) =>
      frame(280, (c) => {
        c.blit(body({ eyeShift: 1 }), 0, BODY_Y, PAL);
        // page
        c.rect(11, 4, 5, 8, WHITE);
        for (let line = 0; line < 3; line++) {
          const y = 5 + ((line * 2 + s) % 6);
          c.rect(12, y, 3, 1, GREY);
        }
      }),
    ),
  };
}

export function writing(): Anim {
  const frames = [];
  const cols = [1, 3, 5, 7, 9, 11];
  for (let k = 0; k <= cols.length; k++) {
    frames.push(
      frame(150, (c) => {
        c.blit(body({ eyeShift: 0 }), BODY_X, 1, PAL);
        for (let i = 0; i < Math.min(k, cols.length); i++) c.rect(cols[i], 12, 2, 1, GREEN);
        // cursor
        const cx = k < cols.length ? cols[k] : 13;
        if (k % 2 === 0) c.rect(cx, 12, 1, 2, CYAN);
      }),
    );
  }
  return { name: 'writing', frames };
}

export function running(): Anim {
  return {
    name: 'running',
    frames: [0, 1, 2, 3].map((i) =>
      frame(110, (c) => {
        const dy = i % 2 === 0 ? 0 : -1;
        const rows = body();
        rows[rows.length - 1] = LEGS_ALT[i % 2];
        c.blit(rows, BODY_X + 2, BODY_Y + dy, PAL);
        // speed lines
        const lines = [[7, 1], [9, 2], [11, 1]];
        lines.forEach(([y, len], j) => {
          const x = 1 + ((i + j) % 2);
          c.rect(x, y, len + ((i + j) % 2), 1, CYAN);
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
        c.blit(body({ wide: true }), BODY_X, 7, PAL);
        if (i === 0) c.blit(q, 6, 0, PAL);
        else c.blit(q, 6, 0, { ...PAL, Y: ORANGE });
      }),
    ),
  };
}

export function placeholders(): Record<State, Anim> {
  const all = { idle: idle(), thinking: thinking(), reading: reading(), writing: writing(), running: running(), 'needs-you': needsYou() };
  for (const s of STATES) if (!all[s]) throw new Error(`missing placeholder for ${s}`);
  return all;
}
