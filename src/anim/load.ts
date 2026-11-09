import { readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { Anim, AnimFile, State, STATES, fromAnimFile } from './types.js';

export type AnimSet = Record<State, Anim>;

/** Load art/anims/<state>.json for every state. Missing files are reported, not defaulted. */
export function loadAnimSet(dir: string): AnimSet {
  const files = new Map(
    readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => [basename(f, '.json'), join(dir, f)] as const),
  );
  const missing = STATES.filter((s) => !files.has(s));
  if (missing.length) {
    throw new Error(`anims dir ${dir} is missing: ${missing.join(', ')} (run "clawdbox placeholders" or "clawdbox build-anims")`);
  }
  const set = {} as AnimSet;
  for (const s of STATES) {
    const file = JSON.parse(readFileSync(files.get(s)!, 'utf8')) as AnimFile;
    set[s] = fromAnimFile({ ...file, name: s });
  }
  return set;
}
