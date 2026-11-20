// Which tools Akaw talks to. Non-secret choices live in akaw.config.json (gitignored;
// see akaw.config.example.json). Secrets stay in .env. Older AKAW_CMD_* env vars still work.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

export const STEP_NAMES = ['draft', 'build', 'qa', 'preview', 'export'];
export const RUNNERS = ['manual', 'command', 'claude', 'n8n', 'capture'];

export function loadAppConfig({ file, env = {} } = {}) {
  if (file === undefined) file = env.AKAW_CONFIG || path.join(ROOT, 'akaw.config.json');
  let raw = {};
  let error = null;
  if (file && fs.existsSync(file)) {
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { error = `akaw.config.json: ${e.message}`; }
  }
  const get = (k) => (env[k] ?? '').toString().trim();

  // Tracker: explicit, else Jira if its keys exist, else none.
  let tracker = raw.tracker || null;
  if (!tracker) tracker = get('JIRA_BASE_URL') ? { provider: 'jira' } : { provider: 'none' };
  if (tracker.provider === 'jira') {
    tracker = {
      jql: get('JIRA_JQL') || 'statusCategory != Done AND summary ~ "playable" ORDER BY priority DESC',
      sprintField: get('JIRA_SPRINT_FIELD') || 'customfield_10020',
      ...tracker,
    };
  }

  // Chat targets: explicit list, else Slack if its webhook exists.
  let chat = Array.isArray(raw.chat) ? raw.chat : null;
  if (!chat) chat = get('SLACK_WEBHOOK_URL') ? [{ provider: 'slack' }] : [];
  chat = chat.map((c) => ({ events: ['delivered'], ...c }));

  // Steps: explicit, else legacy env commands, else manual.
  const steps = {};
  for (const name of STEP_NAMES) {
    const legacy = get(`AKAW_CMD_${name.toUpperCase()}`);
    steps[name] = raw.steps?.[name] || (legacy ? { runner: 'command', command: legacy } : { runner: 'manual' });
  }
  const deploy = raw.steps?.deploy || { command: get('AKAW_CMD_DEPLOY') || null };

  return {
    error,
    flowRepo: raw.flowRepo || get('AKAW_FLOW_REPO') || null,
    tracker,
    chat,
    steps,
    deploy,
    generators: Array.isArray(raw.generators) ? raw.generators : [],
    tools: raw.tools || {},
  };
}

export function validateAppConfig(app) {
  const problems = [];
  for (const [name, s] of Object.entries(app.steps)) {
    if (!RUNNERS.includes(s.runner)) problems.push(`steps.${name}.runner must be one of ${RUNNERS.join(', ')}`);
    if (s.runner === 'command' && !s.command) problems.push(`steps.${name}: command runner needs "command"`);
    if (s.runner === 'n8n' && !s.url) problems.push(`steps.${name}: n8n runner needs "url"`);
    if (s.runner === 'claude' && !s.prompt && !s.promptFile) problems.push(`steps.${name}: claude runner needs "prompt" or "promptFile"`);
    if (s.runner === 'capture' && name !== 'preview') problems.push(`steps.${name}: capture runs only as the preview step`);
  }
  const ids = new Set();
  for (const g of app.generators) {
    if (!g.id) problems.push('every generator needs an "id"');
    if (ids.has(g.id)) problems.push(`duplicate generator id ${g.id}`);
    ids.add(g.id);
  }
  return problems;
}
