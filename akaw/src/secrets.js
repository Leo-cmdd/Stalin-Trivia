// Secret scanner: runs on every QA'd build, on spec text, and on the repo (npm run scan:secrets).
import fs from 'node:fs';
import path from 'node:path';

const PATTERNS = [
  ['AWS access key', /AKIA[0-9A-Z]{16}/g],
  ['Slack token', /xox[abprs]-[0-9A-Za-z-]{10,}/g],
  ['Slack webhook', /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{12,}/g],
  ['Google API key', /AIza[0-9A-Za-z_-]{35}/g],
  ['Atlassian API token', /ATATT[0-9A-Za-z_\-=]{20,}/g],
  ['GitHub token', /gh[pousr]_[A-Za-z0-9]{36,}/g],
  ['Anthropic key', /sk-ant-[A-Za-z0-9_-]{20,}/g],
  ['OpenAI-style key', /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/g],
  ['Private key block', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/g],
  ['Assigned secret', /\b(?:api[_-]?key|secret|access[_-]?token|auth[_-]?token|password|passwd)\b\s*[:=]\s*['"][A-Za-z0-9_\-/+=.]{16,}['"]/gi],
];

let extraValues = [];
export function registerSecretValues(values = []) {
  extraValues = values.filter((v) => v && v.length >= 8);
}

const mask = (s) => (s.length <= 8 ? '***' : `${s.slice(0, 4)}…${s.slice(-2)}`);

export function scanText(text) {
  const t = String(text ?? '');
  const hits = [];
  for (const [type, re] of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(t)) && hits.length < 50) hits.push({ type, index: m.index, preview: mask(m[0]) });
  }
  for (const v of extraValues) {
    const i = t.indexOf(v);
    if (i >= 0) hits.push({ type: 'Configured secret value', index: i, preview: mask(v) });
  }
  return hits;
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'data', '.next', 'dist']);
const TEXT_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|json|html?|css|md|txt|ya?ml|env|sh|py|toml|ini|cfg|xml|svg)$/i;

export function scanPath(root, { maxBytes = 2_000_000 } = {}) {
  const findings = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (!SKIP_DIRS.has(ent.name)) walk(p); continue; }
      if (ent.name === '.env' || ent.name.endsWith('.example')) continue;
      if (!TEXT_EXT.test(ent.name)) continue;
      const st = fs.statSync(p);
      if (st.size > maxBytes) continue;
      for (const h of scanText(fs.readFileSync(p, 'utf8'))) findings.push({ file: path.relative(root, p), ...h });
    }
  };
  if (fs.statSync(root).isDirectory()) walk(root);
  else for (const h of scanText(fs.readFileSync(root, 'utf8'))) findings.push({ file: path.basename(root), ...h });
  return findings;
}
