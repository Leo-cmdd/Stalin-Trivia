// Config: reads .env (never served to the dashboard) and exposes a safe public view.
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

// Env keys whose values are secrets: scrubbed from logs and from child process env.
export const SECRET_KEYS = ['JIRA_API_TOKEN', 'SLACK_WEBHOOK_URL', 'GOOGLE_DRIVE_TOKEN', 'GOOGLE_DRIVE_API_KEY', 'BOX_TOKEN'];

export function loadConfig({ envFile = path.join(ROOT, '.env'), env = process.env } = {}) {
  const fileEnv = fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, 'utf8')) : {};
  const get = (k, d = '') => (env[k] ?? fileEnv[k] ?? d).toString().trim();
  const cfg = {
    port: Number(get('AKAW_PORT', '4747')) || 4747,
    host: get('AKAW_HOST', '127.0.0.1'),
    dataDir: get('AKAW_DATA_DIR') || path.join(ROOT, 'data'),
    allowWrites: get('AKAW_ALLOW_WRITES') === '1',
    jira: {
      baseUrl: get('JIRA_BASE_URL').replace(/\/+$/, ''),
      email: get('JIRA_EMAIL'),
      token: get('JIRA_API_TOKEN'),
      jql: get('JIRA_JQL', 'statusCategory != Done AND summary ~ "playable" ORDER BY priority DESC'),
      sprintField: get('JIRA_SPRINT_FIELD', 'customfield_10020'),
    },
    slack: { webhookUrl: get('SLACK_WEBHOOK_URL') },
    drive: { token: get('GOOGLE_DRIVE_TOKEN'), apiKey: get('GOOGLE_DRIVE_API_KEY') },
    box: { token: get('BOX_TOKEN') },
    flow: {
      repo: get('AKAW_FLOW_REPO'),
      commands: {
        draft: get('AKAW_CMD_DRAFT'),
        build: get('AKAW_CMD_BUILD'),
        qa: get('AKAW_CMD_QA'),
        export: get('AKAW_CMD_EXPORT'),
      },
      deployCommand: get('AKAW_CMD_DEPLOY'),
    },
  };
  cfg.secretValues = SECRET_KEYS.map((k) => get(k)).filter((v) => v && v.length >= 6);
  return cfg;
}

export function integrationStatus(cfg) {
  return {
    allowWrites: cfg.allowWrites,
    jira: {
      configured: Boolean(cfg.jira.baseUrl && cfg.jira.email && cfg.jira.token),
      baseUrl: cfg.jira.baseUrl || null,
      jql: cfg.jira.jql,
      needs: ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'],
    },
    slack: { configured: Boolean(cfg.slack.webhookUrl), needs: ['SLACK_WEBHOOK_URL'] },
    drive: { configured: Boolean(cfg.drive.token || cfg.drive.apiKey), needs: ['GOOGLE_DRIVE_TOKEN or GOOGLE_DRIVE_API_KEY'] },
    box: { configured: Boolean(cfg.box.token), needs: ['BOX_TOKEN'] },
    higgsfield: { configured: false, needs: ['adapter not built yet'] },
    miro: { configured: false, needs: ['adapter not built yet'] },
    flow: {
      repo: cfg.flow.repo || null,
      commands: cfg.flow.commands,
      deployCommand: cfg.flow.deployCommand || null,
    },
  };
}

export function scrub(text, secretValues = []) {
  let s = String(text ?? '');
  for (const v of secretValues) if (v) s = s.split(v).join('***');
  return s;
}
