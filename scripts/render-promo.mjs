// Render docs/promo/explainer.html frame by frame and encode an MP4 (LinkedIn) and a GIF (README).
// Usage: node scripts/render-promo.mjs [--fps 30] [--gif-width 720] [--out docs/promo] [--voice docs/promo/voice]
// With --voice, segN.m4a files are mixed in at the start times listed in that folder's timing.json.
import { readFileSync, readdirSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

// Playwright is a dev-time tool for this script only (not a project dependency). Use the
// repo's copy if present, else a global install (`npm i -g playwright` + `npx playwright install chromium`).
function loadPlaywright() {
  const req = createRequire(import.meta.url);
  const candidates = ['playwright'];
  try { candidates.push(join(execSync('npm root -g', { encoding: 'utf8' }).trim(), 'playwright')); } catch { /* no npm */ }
  for (const dir of ['/opt/node-tools/node_modules']) candidates.push(join(dir, 'playwright'));
  for (const c of candidates) { try { return req(c); } catch { /* try next */ } }
  console.error('playwright not found: npm i -g playwright && npx playwright install chromium'); process.exit(1);
}
const { chromium } = loadPlaywright();

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1]] : [])).filter((e) => e.length));
const fps = Number(args.fps ?? 30), gifWidth = Number(args['gif-width'] ?? 720), out = args.out ?? 'docs/promo';
const root = new URL('..', import.meta.url).pathname;

const sprites = Object.fromEntries(readdirSync(join(root, 'art/anims')).filter((f) => f.endsWith('.json')).map((f) => [f.replace('.json', ''), JSON.parse(readFileSync(join(root, 'art/anims', f), 'utf8'))]));
const html = readFileSync(join(root, 'docs/promo/explainer.html'), 'utf8')
  .replace('/*SPRITES*/{}/*END*/', JSON.stringify(sprites))
  .replace('/*HEADLESS*/false/*END*/', 'true');

const frames = join(tmpdir(), `clawdbox-promo-${process.pid}`);
rmSync(frames, { recursive: true, force: true }); mkdirSync(frames, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1080, height: 1080 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'load' });
const total = await page.evaluate(() => window.TOTAL);
const n = Math.ceil(total * fps);
for (let i = 0; i < n; i++) {
  await page.evaluate((t) => window.renderAt(t), i / fps);
  await page.screenshot({ path: join(frames, `f${String(i).padStart(4, '0')}.png`), clip: { x: 0, y: 0, width: 1080, height: 1080 } });
  if (i % 60 === 0) process.stdout.write(`\r${i}/${n} frames`);
}
await browser.close();
console.log(`\r${n}/${n} frames`);
// poster frame from the flow scene
writeFileSync(join(root, out, 'poster.png'), readFileSync(join(frames, `f${String(Math.round(12.2 * fps)).padStart(4, '0')}.png`)));
const ff = 'ffmpeg';
const silent = join(frames, 'silent.mp4');
execFileSync(ff, ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', join(frames, 'f%04d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', silent]);
const voiceDir = args.voice ? join(root, args.voice) : null;
if (voiceDir && existsSync(join(voiceDir, 'timing.json'))) {
  // Lay each narration segment at its start time, mix, and mux with the video.
  const timing = JSON.parse(readFileSync(join(voiceDir, 'timing.json'), 'utf8'));
  const inputs = [], filters = [];
  timing.segments.forEach((seg, i) => {
    inputs.push('-i', join(voiceDir, seg.file));
    filters.push(`[${i + 1}:a]adelay=${Math.round(seg.at * 1000)}|${Math.round(seg.at * 1000)},apad[a${i}]`);
  });
  const mix = `${filters.join(';')};${timing.segments.map((_, i) => `[a${i}]`).join('')}amix=inputs=${timing.segments.length}:normalize=0,atrim=0:${total},loudnorm=I=-16:TP=-1.5:LRA=11[aout]`;
  execFileSync(ff, ['-y', '-loglevel', 'error', '-i', silent, ...inputs, '-filter_complex', mix, '-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart', join(root, out, 'clawdbox-explainer.mp4')]);
} else {
  writeFileSync(join(root, out, 'clawdbox-explainer.mp4'), readFileSync(silent));
}
execFileSync(ff, ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', join(frames, 'f%04d.png'), '-vf', `fps=15,scale=${gifWidth}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5`, join(root, out, 'clawdbox-explainer.gif')]);
rmSync(frames, { recursive: true, force: true });
for (const f of ['clawdbox-explainer.mp4', 'clawdbox-explainer.gif', 'poster.png']) console.log(f, Math.round(readFileSync(join(root, out, f)).length / 1024), 'KB');
