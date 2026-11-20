// Built-in preview capture: plays the built playable in a headless browser in portrait and
// landscape, keeps a screenshot of the last frame, and turns the recording into mp4 + GIF.
// Needs Playwright (or playwright-core + your Chrome) and FFmpeg on this machine.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const VIEWPORTS = { portrait: { width: 390, height: 844 }, landscape: { width: 844, height: 390 } };

export function loadPlaywright() {
  for (const base of [import.meta.url, path.join(process.cwd(), 'noop.js')]) {
    const req = createRequire(base);
    for (const name of ['playwright', 'playwright-core']) {
      try { return req(name); } catch { /* try next */ }
    }
  }
  return null;
}

export async function hasFfmpeg(bin = 'ffmpeg') {
  try { await exec(bin, ['-version'], { timeout: 5000 }); return true; } catch { return false; }
}

function entryUrl(buildPath) {
  if (/^https?:\/\//.test(buildPath)) return buildPath;
  const st = fs.statSync(buildPath);
  const file = st.isDirectory() ? path.join(buildPath, 'index.html') : buildPath;
  if (!fs.existsSync(file)) throw new Error(`No index.html in ${buildPath}`);
  return `file://${file}`;
}

export async function capture(buildPath, outDir, opts = {}) {
  const log = [];
  const screenshots = [];
  const previews = [];
  if (!buildPath) return { ok: false, log: ['No build to capture'], screenshots, previews };
  const pw = loadPlaywright();
  if (!pw) return { ok: false, log: ['Playwright is not installed here. Run: npm i -D playwright && npx playwright install chromium (or set tools.chromePath with playwright-core).'], screenshots, previews };
  const ffmpeg = opts.ffmpeg || 'ffmpeg';
  const canEncode = await hasFfmpeg(ffmpeg);
  if (!canEncode) log.push('FFmpeg not found: keeping the raw .webm recordings only.');
  fs.mkdirSync(outDir, { recursive: true });
  const seconds = Number(opts.seconds) || 15;
  const browser = await pw.chromium.launch(opts.chromePath ? { executablePath: opts.chromePath } : {});
  try {
    const url = entryUrl(buildPath);
    for (const o of opts.orientations || ['portrait', 'landscape']) {
      const viewport = VIEWPORTS[o] || VIEWPORTS.portrait;
      const vidDir = path.join(outDir, `rec-${o}`);
      const context = await browser.newContext({ viewport, recordVideo: { dir: vidDir, size: viewport } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
      // Optional per-core autoplay hook so the recording reaches the end card.
      if (opts.autoplayScript) {
        const script = fs.readFileSync(path.isAbsolute(opts.autoplayScript) ? opts.autoplayScript : path.resolve(opts.autoplayScript), 'utf8');
        await page.evaluate(script).catch((e) => errors.push(`autoplay: ${e.message}`));
      }
      for (const tap of opts.taps || []) {
        await page.waitForTimeout(tap.atMs || 500);
        await page.mouse.click(tap.x * viewport.width, tap.y * viewport.height);
      }
      await page.waitForTimeout(seconds * 1000);
      const shot = path.join(outDir, `${o}-end.png`);
      await page.screenshot({ path: shot });
      screenshots.push(shot);
      const video = page.video();
      await context.close();
      const webm = video ? await video.path() : null;
      const entry = { orientation: o, webm, mp4: null, gif: null, errors };
      if (webm && canEncode) {
        entry.mp4 = path.join(outDir, `${o}.mp4`);
        entry.gif = path.join(outDir, `${o}.gif`);
        await exec(ffmpeg, ['-y', '-loglevel', 'error', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-movflags', '+faststart', entry.mp4], { timeout: 120_000 });
        const width = o === 'portrait' ? 270 : 480;
        await exec(ffmpeg, ['-y', '-loglevel', 'error', '-i', webm, '-vf', `fps=12,scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse`, entry.gif], { timeout: 120_000 });
      }
      if (errors.length) log.push(`${o}: ${errors.length} page error(s): ${errors[0].slice(0, 160)}`);
      previews.push(entry);
      log.push(`${o}: captured ${seconds}s${entry.mp4 ? ', mp4 + GIF' : ''}`);
    }
  } catch (e) {
    log.push(`Capture failed: ${e.message}`);
    return { ok: false, log, screenshots, previews };
  } finally {
    await browser.close();
  }
  return { ok: true, log, screenshots, previews };
}
