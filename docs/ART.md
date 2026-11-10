# Art


Every sprite is a few lines of ASCII in [`src/anim/clawd.ts`](src/anim/clawd.ts); `clawdbox sprites` regenerates
the JSON. Or draw in Aseprite/LibreSprite/Piskel and run `clawdbox build-anims`; states you don't draw fall back
to the built-ins. [`art/README.md`](art/README.md) has the workflow and the rules for art that reads on LEDs
(black background, saturated colours, nothing finer than 2 px, nothing faster than 150 ms).

See also [`art/README.md`](../art/README.md) for the drawing workflow and the LED design rules.
