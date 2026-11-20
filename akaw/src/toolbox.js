// Which production tools are present on this machine, and what each is for in the flow.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadPlaywright } from './capture.js';

const exec = promisify(execFile);

async function version(bin, args = ['--version']) {
  try {
    const { stdout, stderr } = await exec(bin, args, { timeout: 8000 });
    return (stdout || stderr).split('\n').find((l) => l.trim())?.trim().slice(0, 120) || 'present';
  } catch { return null; }
}

const firstExisting = (list) => list.find((p) => p && fs.existsSync(p)) || null;

function aerenderGuess() {
  const apps = '/Applications';
  if (!fs.existsSync(apps)) return null;
  const dirs = fs.readdirSync(apps).filter((d) => /^Adobe After Effects/.test(d)).sort().reverse();
  return firstExisting(dirs.map((d) => path.join(apps, d, 'aerender')));
}

export async function detectTools(app) {
  const t = app.tools || {};
  const chrome = firstExisting([t.chromePath, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']);
  const aerender = firstExisting([t.aerender]) || aerenderGuess();
  const remotionBin = t.remotionProject ? path.join(t.remotionProject, 'node_modules', '.bin', 'remotion') : null;
  const n8nUrls = [
    ...Object.values(app.steps).filter((s) => s.runner === 'n8n').map((s) => s.url),
    ...app.generators.filter((g) => g.provider === 'n8n').map((g) => g.url),
    t.n8nUrl,
  ].filter(Boolean);
  let n8n = null;
  if (n8nUrls.length) {
    const origin = new URL(n8nUrls[0]).origin;
    try { const r = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(4000) }); n8n = r.ok ? `reachable at ${origin}` : null; } catch { n8n = null; }
  }

  const rows = [
    { id: 'ffmpeg', label: 'FFmpeg', version: await version(t.ffmpeg || 'ffmpeg', ['-version']), for: 'Preview mp4 and GIF, cutdowns, resize, frame grabs, audio' },
    { id: 'playwright', label: 'Playwright', version: loadPlaywright() ? 'installed' : null, for: 'Headless play of the playable: capture, portrait and landscape checks' },
    { id: 'chrome', label: 'Chrome', version: chrome ? 'found' : null, for: 'Browser for capture when using playwright-core' },
    { id: 'claude', label: 'Claude Code', version: await version(t.claude || 'claude'), for: 'Headless steps: Briefer, Builder, new mechanic prototypes, MCP-driven generation' },
    { id: 'n8n', label: 'n8n', version: n8n, for: 'Workflows behind any step or generator (Higgsfield, delivery, uploads)', note: n8nUrls.length ? null : 'no n8n URL configured' },
    { id: 'remotion', label: 'Remotion', version: remotionBin && fs.existsSync(remotionBin) ? 'project found' : null, for: 'Code-driven video: end cards, preview videos, video variants from the spec', note: t.remotionProject ? null : 'set tools.remotionProject' },
    { id: 'nexrender', label: 'nexrender', version: await version(t.nexrender || 'nexrender-cli'), for: 'After Effects template renders from a job JSON' },
    { id: 'aerender', label: 'After Effects aerender', version: aerender ? 'found' : null, for: 'Needed by nexrender for AE renders' },
    { id: 'blender', label: 'Blender', version: await version(t.blender || 'blender', ['--version']), for: 'Parametric 3D template renders driven by a sheet' },
    { id: 'node', label: 'Node.js', version: process.version, for: 'Runs Akaw' },
  ];
  return rows.map((r) => ({ ...r, available: Boolean(r.version) }));
}
