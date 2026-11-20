// Art generators for the Art step. Every call passes the credit hook first.
//   fal       - fal.ai queue API: hosts Flux, Seedance, Kling, Veo, Hailuo, Recraft and many more
//   replicate - Replicate predictions API: same idea, other catalogue
//   gemini    - Google AI Studio (Gemini API) image models
//   n8n       - your n8n workflow does the call (Higgsfield, Runway, Midjourney via a bridge, anything)
//   command   - any CLI (a Python script, ComfyUI, Blender)
//   claude    - Claude Code headless with your MCP servers (e.g. the Higgsfield MCP you already use)
import fs from 'node:fs';
import path from 'node:path';
import { request, download, collectUrls } from './providers/http.js';
import { runCommand } from './runner.js';
import { runClaude, runN8n, fillJson, templateData } from './runners.js';

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav' };
const MEDIA = /\.(png|jpe?g|webp|gif|mp4|webm|mov|mp3|wav|m4a)$/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const GENERATOR_PROVIDERS = {
  fal: { name: 'fal.ai', secretEnv: 'FAL_KEY' },
  replicate: { name: 'Replicate', secretEnv: 'REPLICATE_API_TOKEN' },
  gemini: { name: 'Google AI Studio', secretEnv: 'GEMINI_API_KEY' },
  n8n: { name: 'n8n workflow', secretEnv: null },
  command: { name: 'Command', secretEnv: null },
  claude: { name: 'Claude Code', secretEnv: null },
};

export function generatorConfigured(g, env) {
  const p = GENERATOR_PROVIDERS[g.provider];
  if (!p) return false;
  if (g.provider === 'n8n') return Boolean(g.url);
  if (g.provider === 'command') return Boolean(g.command);
  if (g.provider === 'claude') return Boolean(g.prompt || g.promptFile);
  return Boolean(env[g.secretEnv || p.secretEnv] && g.model);
}

async function callFal(g, key, input) {
  const base = (g.baseUrl || 'https://queue.fal.run').replace(/\/+$/, '');
  const headers = { Authorization: `Key ${key}` };
  const sub = await request(`${base}/${g.model}`, { method: 'POST', headers, body: input });
  if (!sub?.status_url) return sub;
  const deadline = Date.now() + (g.timeoutMs || 10 * 60_000);
  for (;;) {
    const st = await request(sub.status_url, { headers });
    if (st.status === 'COMPLETED') break;
    if (['FAILED', 'ERROR', 'CANCELLED'].includes(st.status)) throw new Error(`fal: ${st.status} ${JSON.stringify(st.error || '')}`);
    if (Date.now() > deadline) throw new Error('fal: timed out waiting for the result');
    await sleep(g.pollMs || 2000);
  }
  return request(sub.response_url, { headers });
}

async function callReplicate(g, key, input) {
  const base = (g.baseUrl || 'https://api.replicate.com/v1').replace(/\/+$/, '');
  const auth = { Authorization: `Bearer ${key}` };
  const url = g.version ? `${base}/predictions` : `${base}/models/${g.model}/predictions`;
  let p = await request(url, { method: 'POST', headers: { ...auth, Prefer: 'wait' }, body: g.version ? { version: g.version, input } : { input }, timeoutMs: 120_000 });
  const deadline = Date.now() + (g.timeoutMs || 10 * 60_000);
  while (!['succeeded', 'failed', 'canceled'].includes(p.status)) {
    if (Date.now() > deadline) throw new Error('Replicate: timed out');
    await sleep(g.pollMs || 2000);
    p = await request(p.urls.get, { headers: auth });
  }
  if (p.status !== 'succeeded') throw new Error(`Replicate: ${p.status} ${p.error || ''}`);
  return p.output;
}

async function callGemini(g, key, prompt) {
  const base = (g.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
  const data = await request(`${base}/models/${g.model}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key },
    body: { contents: [{ parts: [{ text: prompt }] }], generationConfig: g.generationConfig || { responseModalities: ['TEXT', 'IMAGE'] } },
    timeoutMs: g.timeoutMs || 180_000,
  });
  const out = [];
  for (const c of data.candidates || []) for (const part of c.content?.parts || []) {
    const inline = part.inlineData || part.inline_data;
    if (inline?.data) out.push({ base64: inline.data, mime: inline.mimeType || inline.mime_type || 'image/png' });
  }
  return out;
}

async function save(outputs, dir, startIndex = 0) {
  const files = [];
  let i = startIndex;
  for (const o of outputs) {
    let buffer; let mime = o.mime || ''; let sourceUrl = null;
    if (o.url) { const d = await download(o.url); buffer = d.buffer; mime = mime || d.mime; sourceUrl = o.url; }
    else if (o.base64) buffer = Buffer.from(o.base64, 'base64');
    else if (o.path && fs.existsSync(o.path)) { buffer = fs.readFileSync(o.path); mime = mime || ''; }
    else continue;
    const ext = EXT[mime] || (o.url || o.path || '').match(MEDIA)?.[1]?.toLowerCase() || 'bin';
    const file = path.join(dir, `gen-${String(++i).padStart(2, '0')}.${ext}`);
    fs.writeFileSync(file, buffer);
    files.push({ path: file, mime: mime || null, sourceUrl });
  }
  return files;
}

const fromResultFiles = (list = []) => list.map((f) => (typeof f === 'string' ? (/^https?:/.test(f) ? { url: f } : { path: f }) : f));

// ctx: { env, dir, prompt, n, card, spec, game, specFile, flowRepo, secretValues }
export async function generate(g, ctx) {
  const p = GENERATOR_PROVIDERS[g.provider];
  if (!p) throw new Error(`Unknown generator provider ${g.provider}`);
  fs.mkdirSync(ctx.dir, { recursive: true });
  const n = Math.max(1, Math.min(8, Number(ctx.n) || 1));
  const data = { ...templateData(ctx), prompt: ctx.prompt, n };
  const key = p.secretEnv ? ctx.env[g.secretEnv || p.secretEnv] : null;
  if (p.secretEnv && !key) throw new Error(`${p.name} is not configured: set ${g.secretEnv || p.secretEnv} in .env`);
  let files = [];
  let reportedCost = null;
  let output = '';
  const calls = g.provider === 'fal' || g.provider === 'replicate' || g.provider === 'gemini' ? (g.batch ? 1 : n) : 1;

  for (let c = 0; c < calls; c++) {
    if (g.provider === 'fal') {
      const res = await callFal(g, key, fillJson(g.input || { prompt: '{{prompt}}' }, data));
      files.push(...await save(collectUrls(res).map((url) => ({ url })), ctx.dir, files.length));
    } else if (g.provider === 'replicate') {
      const res = await callReplicate(g, key, fillJson(g.input || { prompt: '{{prompt}}' }, data));
      files.push(...await save(collectUrls(res).map((url) => ({ url })), ctx.dir, files.length));
    } else if (g.provider === 'gemini') {
      files.push(...await save(await callGemini(g, key, ctx.prompt), ctx.dir, files.length));
    } else if (g.provider === 'n8n') {
      const r = await runN8n('generate', g, { ...ctx, n });
      output = r.output;
      if (r.code !== 0) throw new Error(`n8n generator failed: ${r.output}`);
      files.push(...await save(fromResultFiles(r.result?.files), ctx.dir, files.length));
      reportedCost = r.result?.cost ?? null;
    } else if (g.provider === 'command') {
      fs.writeFileSync(path.join(ctx.dir, 'prompt.txt'), ctx.prompt);
      const before = new Set(fs.readdirSync(ctx.dir));
      const r = await runCommand(g.command, { cwd: g.cwd || ctx.flowRepo, vars: { spec: ctx.specFile, card: ctx.card.id, out: ctx.dir, prompt: path.join(ctx.dir, 'prompt.txt'), n }, secretValues: ctx.secretValues, timeoutMs: g.timeoutMs });
      output = r.output;
      if (r.code !== 0) throw new Error(`Generator command failed (exit ${r.code})`);
      const listed = r.result?.files ? fromResultFiles(r.result.files) : fs.readdirSync(ctx.dir).filter((f) => !before.has(f) && MEDIA.test(f)).map((f) => ({ path: path.join(ctx.dir, f) }));
      files.push(...listed.filter((x) => x.path && path.dirname(x.path) === ctx.dir).map((x) => ({ path: x.path, mime: null, sourceUrl: null })));
      files.push(...await save(listed.filter((x) => x.url || x.base64 || (x.path && path.dirname(x.path) !== ctx.dir)), ctx.dir, files.length));
      reportedCost = r.result?.cost ?? null;
    } else if (g.provider === 'claude') {
      const r = await runClaude({ ...g, noDefaultTail: true, prompt: `${g.prompt || ''}\n\nMake ${n} output(s). Save each file into {{out}} and write {{out}}/result.json as {"files": [paths], "cost": <credits spent or null>}.` }, { ...ctx });
      output = r.output;
      if (r.code !== 0) throw new Error(`Claude Code generator failed: ${String(r.output).slice(-300)}`);
      const listed = fromResultFiles(r.result?.files);
      files.push(...listed.filter((x) => x.path && path.dirname(x.path) === ctx.dir).map((x) => ({ path: x.path, mime: null, sourceUrl: null })));
      files.push(...await save(listed.filter((x) => !(x.path && path.dirname(x.path) === ctx.dir)), ctx.dir, files.length));
      reportedCost = r.result?.cost ?? (g.unit === 'usd' ? r.costUsd : null);
    }
  }
  return { files, reportedCost, output, calls };
}
