// Step runners: how each flow step gets done.
//   manual  - you attach the result on the card
//   command - any shell command (FFmpeg, Remotion, nexrender, Blender, your npm scripts)
//   claude  - Claude Code headless (claude -p) in the flow repo, with your MCP servers if you give it a config
//   n8n     - POST the card and spec to an n8n webhook; the response is the result
//   capture - built in: records the built playable in portrait and landscape (Playwright) and makes mp4 + GIF (FFmpeg)
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, SECRET_KEYS, scrub } from './config.js';
import { runCommand } from './runner.js';
import { request } from './providers/http.js';
import { capture } from './capture.js';

export const RESULT_KEYS = ['draftUrl', 'screenshots', 'buildPath', 'playLink', 'previews', 'files', 'cost', 'notes'];

// {{a.b.c}} substitution from a data object (used for prompts and job templates).
export function fillTemplate(text, data) {
  return String(text).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, key) => {
    const v = key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), data);
    if (v == null) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

export function templateData(ctx) {
  const f = ctx.spec?.fields || {};
  const flat = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v?.value ?? null]));
  return {
    card: { id: ctx.card.id, title: ctx.card.title, taskKey: ctx.card.taskKey, version: ctx.card.version, gameId: ctx.card.gameId, buildPath: ctx.card.artifacts?.buildPath, playLink: ctx.card.artifacts?.playLink, route: ctx.card.gates?.close?.route || null, previews: ctx.card.previews || [] },
    spec: ctx.spec, fields: flat, game: ctx.game, out: ctx.dir, specFile: ctx.specFile, idea: ctx.card.idea, prompt: ctx.prompt || '',
  };
}

// Deep-fill a JSON template. A string that is exactly {{key}} keeps the value's type.
export function fillJson(obj, data) {
  if (typeof obj === 'string') {
    const m = obj.match(/^\{\{\s*([\w.]+)\s*\}\}$/);
    if (m) return m[1].split('.').reduce((o, k) => (o == null ? undefined : o[k]), data);
    return fillTemplate(obj, data);
  }
  if (Array.isArray(obj)) return obj.map((v) => fillJson(v, data));
  if (obj && typeof obj === 'object') return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fillJson(v, data)]));
  return obj;
}

// Writes templated files (a nexrender job, Remotion props) into the run folder first.
// JSON templates are filled value by value, so quotes in copy never break the file.
export function writeFiles(step, ctx) {
  for (const [name, tpl] of Object.entries(step.writeFiles || {})) {
    const src = path.isAbsolute(tpl) ? tpl : path.join(ROOT, tpl);
    if (!fs.existsSync(src)) throw new Error(`writeFiles template not found: ${tpl}`);
    const text = fs.readFileSync(src, 'utf8');
    const data = templateData(ctx);
    const out = /\.json$/i.test(src) ? JSON.stringify(fillJson(JSON.parse(text), data), null, 2) : fillTemplate(text, data);
    fs.writeFileSync(path.join(ctx.dir, path.basename(name)), out);
  }
}

function readResult(dir) {
  const f = path.join(dir, 'result.json');
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

function childEnv(vars) {
  const env = { ...process.env };
  for (const k of SECRET_KEYS) delete env[k];
  for (const [k, v] of Object.entries(vars)) env[`AKAW_${k.toUpperCase()}`] = String(v ?? '');
  return env;
}

export async function runStep(name, step, ctx) {
  const runner = step?.runner || 'manual';
  if (runner === 'manual') return { runner, manual: true, code: 0 };
  writeFiles(step, ctx);
  if (runner === 'command') {
    const r = await runCommand(step.command, { cwd: step.cwd || ctx.flowRepo, vars: { spec: ctx.specFile, card: ctx.card.id, out: ctx.dir, prompt: ctx.prompt || '' }, secretValues: ctx.secretValues, timeoutMs: step.timeoutMs });
    return { runner, ...r, result: r.result || readResult(ctx.dir) };
  }
  if (runner === 'claude') return runClaude(step, ctx);
  if (runner === 'n8n') return runN8n(name, step, ctx);
  if (runner === 'capture') {
    const r = await capture(ctx.card.artifacts?.buildPath, ctx.dir, step);
    return { runner, code: r.ok ? 0 : 1, output: r.log.join('\n'), result: { screenshots: r.screenshots, previews: r.previews } };
  }
  throw new Error(`Unknown runner ${runner}`);
}

const DEFAULT_TAIL = '\n\nWhen you are done, write {{out}}/result.json with any of: draftUrl, screenshots (array), buildPath, playLink, notes. The card and Scene Spec are in {{specFile}}. Do not deploy and do not post anywhere.';

export function claudeArgs(step) {
  const args = ['-p', '--output-format', 'json', '--permission-mode', step.permissionMode || 'acceptEdits', '--no-session-persistence'];
  if (step.model) args.push('--model', step.model);
  if (step.maxBudgetUsd) args.push('--max-budget-usd', String(step.maxBudgetUsd));
  if (step.appendSystemPrompt) args.push('--append-system-prompt', step.appendSystemPrompt);
  if (step.mcpConfig) args.push('--mcp-config', step.mcpConfig);
  if (step.strictMcpConfig) args.push('--strict-mcp-config');
  if (step.allowedTools?.length) args.push('--allowedTools', step.allowedTools.join(','));
  if (step.disallowedTools?.length) args.push('--disallowedTools', step.disallowedTools.join(','));
  return args;
}

export function runClaude(step, ctx) {
  const template = step.promptFile ? fs.readFileSync(path.isAbsolute(step.promptFile) ? step.promptFile : path.join(ROOT, step.promptFile), 'utf8') : step.prompt;
  const prompt = fillTemplate(template + (step.noDefaultTail ? '' : DEFAULT_TAIL), templateData(ctx));
  const cwd = step.cwd || ctx.flowRepo || process.cwd();
  return new Promise((resolve) => {
    // The prompt goes on stdin, so list options never swallow it.
    const child = spawn(step.bin || 'claude', claudeArgs(step), { cwd: fs.existsSync(cwd) ? cwd : process.cwd(), env: childEnv({ spec: ctx.specFile, card: ctx.card.id, out: ctx.dir }) });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; if (out.length > 2_000_000) out = out.slice(-2_000_000); });
    child.stderr.on('data', (d) => { err += d; if (err.length > 100_000) err = err.slice(-100_000); });
    const timer = setTimeout(() => child.kill('SIGTERM'), step.timeoutMs || 30 * 60_000);
    child.on('error', (e) => { clearTimeout(timer); resolve({ runner: 'claude', code: -1, output: scrub(`Could not start Claude Code: ${e.message}`, ctx.secretValues), result: null }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let parsed = null;
      try { parsed = JSON.parse(out.trim().split('\n').pop()); } catch { /* not JSON */ }
      let result = readResult(ctx.dir);
      if (!result && parsed?.structured_output) result = parsed.structured_output;
      if (!result && typeof parsed?.result === 'string') { try { result = JSON.parse(parsed.result); } catch { /* prose */ } }
      const isError = code !== 0 || parsed?.is_error === true;
      resolve({
        runner: 'claude',
        code: isError ? (code || 1) : 0,
        output: scrub(`${parsed?.result ?? out}`.slice(-6000) + (err ? `\n${err.slice(-2000)}` : ''), ctx.secretValues),
        result,
        costUsd: typeof parsed?.total_cost_usd === 'number' ? parsed.total_cost_usd : null,
      });
    });
    child.stdin.end(prompt);
  });
}

export async function runN8n(name, step, ctx) {
  const headers = {};
  if (step.authHeader) headers[step.authHeader] = ctx.env[step.authEnv || 'N8N_AUTH_VALUE'] || '';
  const d = templateData(ctx);
  try {
    const data = await request(step.url, {
      method: 'POST',
      headers,
      timeoutMs: step.timeoutMs || 15 * 60_000,
      body: { source: 'akaw', event: `step.${name}`, card: d.card, spec: ctx.spec, fields: d.fields, game: ctx.game, out: ctx.dir, prompt: ctx.prompt || null, n: ctx.n || null },
    });
    const result = Array.isArray(data) ? data[0] : data;
    return { runner: 'n8n', code: 0, output: JSON.stringify(result).slice(0, 4000), result: result && typeof result === 'object' ? result : null };
  } catch (e) {
    return { runner: 'n8n', code: e.status || 1, output: scrub(e.message, ctx.secretValues), result: null };
  }
}

export function describeStep(step) {
  switch (step?.runner) {
    case 'command': return `command: ${step.command}`;
    case 'claude': return `Claude Code${step.model ? ` (${step.model})` : ''}${step.mcpConfig ? ' + MCP' : ''}${step.maxBudgetUsd ? `, max $${step.maxBudgetUsd}` : ''}`;
    case 'n8n': return `n8n: ${step.url}`;
    case 'capture': return `capture: ${(step.orientations || ['portrait', 'landscape']).join(' + ')}, ${step.seconds || 15}s, mp4 + GIF`;
    default: return 'by hand';
  }
}
