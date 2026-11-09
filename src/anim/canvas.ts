import { HEIGHT, PIXELS, Rgb, WIDTH } from './types.js';

export const BLACK: Rgb = [0, 0, 0];

/** Tiny 16x16 drawing surface used by the procedural placeholder art. */
export class Canvas {
  readonly px: Rgb[] = Array.from({ length: PIXELS }, () => BLACK);

  set(x: number, y: number, c: Rgb): void {
    if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return;
    this.px[x + WIDTH * y] = c;
  }

  rect(x: number, y: number, w: number, h: number, c: Rgb): void {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c);
  }

  /**
   * Paint ASCII art. Each char maps to a colour via `map`; '.' and ' ' are transparent.
   * Rows may have different lengths.
   */
  blit(rows: readonly string[], x: number, y: number, map: Record<string, Rgb>): void {
    rows.forEach((row, j) => {
      for (let i = 0; i < row.length; i++) {
        const ch = row[i];
        if (ch === '.' || ch === ' ') continue;
        const c = map[ch];
        if (!c) throw new Error(`no colour for '${ch}'`);
        this.set(x + i, y + j, c);
      }
    });
  }

  pixels(): Rgb[] {
    return this.px.map((c) => [c[0], c[1], c[2]] as Rgb);
  }
}
