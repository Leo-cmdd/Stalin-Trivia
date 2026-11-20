// Runs a configured flow command (draft, build, QA, export) in the flow repo.
// The child gets no Akaw secrets, and its output is scrubbed before it is logged.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SECRET_KEYS, scrub } from './config.js';

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function fillCommand(template, vars) {
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? shq(vars[k]) : m));
}

export function runCommand(template, { cwd, vars = {}, secretValues = [], timeoutMs = 15 * 60_000 } = {}) {
  return new Promise((resolve) => {
    const cmd = fillCommand(template, vars);
    const env = { ...process.env };
    for (const k of SECRET_KEYS) delete env[k];
    for (const [k, v] of Object.entries(vars)) env[`AKAW_${k.toUpperCase()}`] = String(v);
    const workdir = cwd && fs.existsSync(cwd) ? cwd : process.cwd();
    const child = spawn('sh', ['-c', cmd], { cwd: workdir, env });
    let out = '';
    const keep = (d) => { out += d.toString(); if (out.length > 200_000) out = out.slice(-200_000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, output: scrub(String(err), secretValues), cmd }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let result = null;
      const resultFile = vars.out && path.join(vars.out, 'result.json');
      if (resultFile && fs.existsSync(resultFile)) {
        try { result = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch { /* ignore */ }
      }
      resolve({ code, output: scrub(out.slice(-8000), secretValues), cmd, result });
    });
  });
}
