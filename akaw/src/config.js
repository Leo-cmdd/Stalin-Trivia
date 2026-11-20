// Config: .env holds secrets (never served to the dashboard); akaw.config.json holds tool choices.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

// Env keys whose values are secrets: scrubbed from logs and removed from child process env.
export const SECRET_KEYS = [
  'JIRA_API_TOKEN', 'ASANA_TOKEN', 'MONDAY_TOKEN',
  'SLACK_WEBHOOK_URL', 'TEAMS_WEBHOOK_URL', 'DISCORD_WEBHOOK_URL', 'GOOGLE_CHAT_WEBHOOK_URL', 'CHAT_WEBHOOK_URL', 'TELEGRAM_BOT_TOKEN',
  'GOOGLE_DRIVE_TOKEN', 'GOOGLE_DRIVE_API_KEY', 'BOX_TOKEN',
  'FAL_KEY', 'REPLICATE_API_TOKEN', 'GEMINI_API_KEY', 'N8N_AUTH_VALUE',
];

export function loadConfig({ envFile = path.join(ROOT, '.env'), env = process.env, appFile } = {}) {
  const fileEnv = fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, 'utf8')) : {};
  const merged = { ...fileEnv };
  for (const [k, v] of Object.entries(env)) if (v != null && v !== '') merged[k] = String(v);
  const get = (k, d = '') => (merged[k] ?? d).toString().trim();
  const cfg = {
    port: Number(get('AKAW_PORT', '4747')) || 4747,
    host: get('AKAW_HOST', '127.0.0.1'),
    dataDir: get('AKAW_DATA_DIR') || path.join(ROOT, 'data'),
    allowWrites: get('AKAW_ALLOW_WRITES') === '1',
    env: merged,
    drive: { token: get('GOOGLE_DRIVE_TOKEN'), apiKey: get('GOOGLE_DRIVE_API_KEY') },
    box: { token: get('BOX_TOKEN') },
  };
  // Every configured secret value, plus any extra *_KEY / *_TOKEN / *_SECRET the user added.
  const extra = Object.keys(fileEnv).filter((k) => /(_KEY|_TOKEN|_SECRET|_PASSWORD|_WEBHOOK_URL)$/.test(k));
  cfg.secretKeys = [...new Set([...SECRET_KEYS, ...extra])];
  cfg.secretValues = cfg.secretKeys.map((k) => get(k)).filter((v) => v && v.length >= 6);
  cfg.appFile = appFile;
  return cfg;
}

export function scrub(text, secretValues = []) {
  let s = String(text ?? '');
  for (const v of secretValues) if (v) s = s.split(v).join('***');
  return s;
}
