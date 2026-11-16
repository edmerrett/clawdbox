import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MOD_SPRITES_PATH, modSpritesSource } from '../src/tools/build-mod-sprites.js';

test('the Claude Code mod plays the same sprites as the panel (run `npm run mod:sprites` after changing art/anims)', () => {
  assert.equal(readFileSync(MOD_SPRITES_PATH, 'utf8'), modSpritesSource());
});
