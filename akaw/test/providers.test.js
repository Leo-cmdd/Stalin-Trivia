// Every provider against a local mock of its API: trackers, chat, generators, runners.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { makeEngine, tmpDir } from './helpers.js';
import { TRACKERS } from '../src/providers/trackers.js';
import { CHATS } from '../src/providers/chat.js';
import { generate } from '../src/generators.js';
import { runStep, claudeArgs, fillTemplate } from '../src/runners.js';
import { capture, loadPlaywright, hasFfmpeg } from '../src/capture.js';
import { detectTools } from '../src/toolbox.js';
import { loadAppConfig, validateAppConfig } from '../src/appconfig.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function mock() {
  const hits = [];
  let base = '';
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = body ? JSON.parse(body) : null;
      hits.push({ method: req.method, url: req.url, headers: req.headers, body: json });
      const send = (o, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      const u = req.url;
      // Jira
      if (u.startsWith('/jira/rest/api/3/search/jql')) return send({ issues: [{ key: 'MAR-1', fields: { summary: 'Solitaire Cash klondike playable 30s', priority: { name: 'High' }, description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Winter look' }] }] } } }] });
      if (u.startsWith('/jira/rest/api/3/issue/MAR-1/comment') && req.method === 'GET') return send({ comments: [{ id: '9', author: { displayName: 'Lead' }, created: new Date(Date.now() + 1000).toISOString(), body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Approved' }] }] } }] });
      if (u.startsWith('/jira/rest/api/3/issue/MAR-1/comment')) return send({ id: '10' }, 201);
      // Asana
      if (u.startsWith('/asana/projects/P1/tasks')) return send({ data: [{ gid: '111', name: 'Solitaire Cash klondike playable', notes: 'Klondike, 30s', due_on: '2026-11-28', permalink_url: 'https://app.asana.com/0/P1/111', custom_fields: [{ name: 'Priority', display_value: 'High' }] }], next_page: null });
      if (u.startsWith('/asana/tasks/111/stories') && req.method === 'GET') return send({ data: [{ gid: 's1', resource_subtype: 'comment_added', text: 'Please fix the font', created_at: new Date(Date.now() + 1000).toISOString(), created_by: { name: 'Lead' } }, { gid: 's0', resource_subtype: 'assigned', text: 'assigned' }] });
      if (u.startsWith('/asana/tasks/111/stories')) return send({ data: { gid: 's2' } }, 201);
      // Monday (GraphQL)
      if (u.startsWith('/monday')) {
        const q = json.query;
        if (q.includes('items_page')) return send({ data: { boards: [{ items_page: { cursor: null, items: [
          { id: '501', name: 'Mahjong Cash playable', url: 'https://x.monday.com/i/501', column_values: [{ text: 'Working on it', column: { title: 'Status' } }, { text: 'Critical', column: { title: 'Priority' } }] },
          { id: '502', name: 'Old one', url: null, column_values: [{ text: 'Done', column: { title: 'Status' } }] },
        ] } }] } });
        if (q.includes('updates')) return send({ data: { items: [{ updates: [{ id: 'u1', text_body: 'Looks good', created_at: new Date().toISOString(), creator: { name: 'Lead' } }] }] } });
        if (q.includes('create_update')) return send({ data: { create_update: { id: 'u2' } } });
      }
      // Chat
      if (u.startsWith('/chat/') || u.startsWith('/tg/')) return send({ ok: true });
      // fal queue
      if (u === '/fal/fal-ai/flux/dev' && req.method === 'POST') return send({ request_id: 'r1', status_url: `${base}/fal/status/r1`, response_url: `${base}/fal/resp/r1` });
      if (u === '/fal/status/r1') return send({ status: 'COMPLETED' });
      if (u === '/fal/resp/r1') return send({ images: [{ url: `${base}/files/out.png`, width: 1, height: 1 }] });
      // Replicate
      if (u === '/rep/models/black-forest-labs/flux-schnell/predictions') return send({ status: 'starting', urls: { get: `${base}/rep/p/1` } });
      if (u === '/rep/p/1') return send({ status: 'succeeded', output: [`${base}/files/out.png`] });
      // Gemini
      if (u.startsWith('/gem/models/img-model:generateContent')) return send({ candidates: [{ content: { parts: [{ text: 'ok' }, { inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } }] } }] });
      // n8n
      if (u === '/n8n/build') return send({ buildPath: '/tmp/somewhere/index.html', notes: 'built by n8n' });
      if (u === '/n8n/gen') return send({ files: [{ url: `${base}/files/out.png` }], cost: 3 });
      if (u === '/files/out.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(PNG); }
      send({ error: `no mock for ${req.method} ${u}` }, 404);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve({ server, hits, base }); }));
}

test('trackers: Jira, Asana and Monday read tasks, read replies and post the comment', async () => {
  const { server, hits, base } = await mock();
  try {
    const env = { JIRA_EMAIL: 'a@b.c', JIRA_API_TOKEN: 't', ASANA_TOKEN: 't', MONDAY_TOKEN: 't' };
    const j = { provider: 'jira', baseUrl: `${base}/jira`, jql: 'project = X' };
    const jr = await TRACKERS.jira.search(j, env);
    assert.equal(jr[0].key, 'MAR-1');
    assert.equal(jr[0].description, 'Winter look');
    assert.equal((await TRACKERS.jira.comments(j, env, 'MAR-1'))[0].text, 'Approved');
    assert.equal((await TRACKERS.jira.postComment(j, env, 'MAR-1', 'Play Now: x')).id, '10');
    assert.ok(hits.some((h) => h.headers.authorization?.startsWith('Basic ')));

    const a = { provider: 'asana', baseUrl: `${base}/asana`, projectGid: 'P1' };
    const ar = await TRACKERS.asana.search(a, env);
    assert.deepEqual([ar[0].key, ar[0].priority, ar[0].due], ['111', 'High', '2026-11-28']);
    const ac = await TRACKERS.asana.comments(a, env, '111');
    assert.equal(ac.length, 1);
    assert.equal((await TRACKERS.asana.postComment(a, env, '111', 'hi')).id, 's2');

    const m = { provider: 'monday', baseUrl: `${base}/monday`, boardId: 42 };
    const mr = await TRACKERS.monday.search(m, env);
    assert.equal(mr.length, 1, 'Done items are skipped');
    assert.deepEqual([mr[0].key, mr[0].priority], ['501', 'Highest']);
    assert.equal((await TRACKERS.monday.comments(m, env, '501'))[0].text, 'Looks good');
    assert.equal((await TRACKERS.monday.postComment(m, env, '501', 'a\nb')).id, 'u2');
    assert.ok(hits.some((h) => h.body?.variables?.body === 'a<br>b'));
  } finally { server.close(); }
});

test('chat: Slack, Teams, Discord, Google Chat, webhook and Telegram each get their own payload', async () => {
  const { server, hits, base } = await mock();
  try {
    const env = { SLACK_WEBHOOK_URL: `${base}/chat/slack`, TEAMS_WEBHOOK_URL: `${base}/chat/teams`, DISCORD_WEBHOOK_URL: `${base}/chat/discord`, GOOGLE_CHAT_WEBHOOK_URL: `${base}/chat/gchat`, CHAT_WEBHOOK_URL: `${base}/chat/n8n`, TELEGRAM_BOT_TOKEN: 'TOKEN' };
    for (const p of ['slack', 'teams', 'discord', 'googlechat', 'webhook']) await CHATS[p].post({ provider: p }, env, 'Playable ready', { event: 'delivered', card: { id: 'AK-1' } });
    await CHATS.telegram.post({ provider: 'telegram', chatId: '-100', baseUrl: `${base}/tg` }, env, 'Playable ready');
    const by = (u) => hits.find((h) => h.url === u)?.body;
    assert.equal(by('/chat/slack').text, 'Playable ready');
    assert.equal(by('/chat/teams').attachments[0].content.type, 'AdaptiveCard');
    assert.equal(by('/chat/discord').content, 'Playable ready');
    assert.equal(by('/chat/n8n').event, 'delivered');
    assert.equal(by('/tg/botTOKEN/sendMessage').chat_id, '-100');
    assert.equal(CHATS.telegram.configured({ provider: 'telegram' }, env), false, 'Telegram needs a chatId');
  } finally { server.close(); }
});

test('generators: fal, Replicate, Google AI Studio and n8n save files locally', async () => {
  const { server, base } = await mock();
  try {
    const env = { FAL_KEY: 'k', REPLICATE_API_TOKEN: 'k', GEMINI_API_KEY: 'k' };
    const ctx = (dir) => ({ env, dir, prompt: 'snowy table', n: 1, card: { id: 'AK-1', artifacts: {} }, spec: null, game: null, specFile: '' });
    const fal = await generate({ id: 'f', provider: 'fal', model: 'fal-ai/flux/dev', baseUrl: `${base}/fal`, input: { prompt: '{{prompt}}', num_images: '{{n}}' }, pollMs: 10 }, ctx(tmpDir()));
    assert.equal(fal.files.length, 1);
    assert.ok(fs.readFileSync(fal.files[0].path).equals(PNG));
    const rep = await generate({ id: 'r', provider: 'replicate', model: 'black-forest-labs/flux-schnell', baseUrl: `${base}/rep`, pollMs: 10 }, ctx(tmpDir()));
    assert.equal(rep.files.length, 1);
    const gem = await generate({ id: 'g', provider: 'gemini', model: 'img-model', baseUrl: `${base}/gem` }, ctx(tmpDir()));
    assert.ok(gem.files[0].path.endsWith('.png'));
    const n8n = await generate({ id: 'n', provider: 'n8n', url: `${base}/n8n/gen` }, ctx(tmpDir()));
    assert.equal(n8n.reportedCost, 3);
    await assert.rejects(() => generate({ id: 'x', provider: 'fal', model: 'm' }, { ...ctx(tmpDir()), env: {} }), /FAL_KEY/);
  } finally { server.close(); }
});

test('runners: n8n step returns the result; Claude Code gets the prompt on stdin with headless flags', async () => {
  const { server, base } = await mock();
  try {
    const dir = tmpDir();
    const card = { id: 'AK-9', title: 'T', idea: 'idea text', artifacts: {} };
    const r = await runStep('build', { runner: 'n8n', url: `${base}/n8n/build` }, { card, spec: null, game: null, dir, specFile: path.join(dir, 'spec.json'), env: {} });
    assert.equal(r.code, 0);
    assert.equal(r.result.buildPath, '/tmp/somewhere/index.html');

    const fake = path.join(tmpDir(), 'fake-claude.mjs');
    fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from 'node:fs';
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.AKAW_OUT + '/result.json', JSON.stringify({ buildPath: '/b/index.html', args: process.argv.slice(2), sawSpec: input.includes(process.env.AKAW_SPEC) }));
  console.log(JSON.stringify({ type: 'result', is_error: false, result: 'done', total_cost_usd: 0.12 }));
});
`);
    fs.chmodSync(fake, 0o755);
    const c = await runStep('build', { runner: 'claude', bin: fake, prompt: 'Build {{card.title}} for {{fields.game}}', allowedTools: ['Read', 'Edit', 'Bash(npm run build:*)'], maxBudgetUsd: 4 }, { card, spec: { fields: { game: { value: 'solitaire-cash' } } }, game: null, dir, specFile: path.join(dir, 'spec.json'), env: {} });
    assert.equal(c.code, 0);
    assert.equal(c.result.buildPath, '/b/index.html');
    assert.equal(c.result.sawSpec, true);
    assert.equal(c.costUsd, 0.12);
    assert.deepEqual(c.result.args.slice(0, 5), ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits']);
    assert.ok(c.result.args.includes('Read,Edit,Bash(npm run build:*)'));
    assert.equal(fillTemplate('{{card.title}} / {{fields.game}}', { card, fields: { game: 'sc' } }), 'T / sc');
    assert.ok(!claudeArgs({}).some((a) => a.includes('Build')), 'the prompt is never an argument');
  } finally { server.close(); }
});

test('flow: Asana task → card → live comment → replies; generation passes the credit hook', async () => {
  const { server, hits, base } = await mock();
  try {
    const { flow, library } = makeEngine(
      { ASANA_TOKEN: 't', FAL_KEY: 'k', AKAW_ALLOW_WRITES: '1', CHAT_WEBHOOK_URL: `${base}/chat/n8n` },
      {
        tracker: { provider: 'asana', baseUrl: `${base}/asana`, projectGid: 'P1' },
        chat: [{ provider: 'webhook', events: ['needs-you', 'delivered'] }],
        generators: [{ id: 'flux', label: 'Flux', provider: 'fal', model: 'fal-ai/flux/dev', baseUrl: `${base}/fal`, costPerOutput: 4, pollMs: 10 }],
      },
    );
    const by = 'op';
    flow.upsertGame({ id: 'solitaire-cash', name: 'Solitaire Cash', clientId: 'papaya', approvedPrizes: ['50'] }, by);
    const prev = await flow.trackerPreview(by);
    assert.equal(prev.rows[0].gameGuess, 'solitaire-cash');
    const [id] = flow.trackerImport(['111'], by);
    const card = flow.card(id);
    assert.equal(card.taskKey, '111');
    assert.equal(card.stage, 'intake');
    await flow.runCard(id, by); // questions → needs you → webhook notified
    assert.ok(hits.some((h) => h.url === '/chat/n8n' && h.body.event === 'needs-you'));
    flow.updateSpec(id, { idea: 'Solitaire Cash klondike 30s, winter look, win $50' }, by);
    await flow.runCard(id, by);
    flow.attach(id, { draftUrl: 'https://example.com/d' }, by);
    await flow.runCard(id, by);
    flow.approveGate(id, 'concept_lock', { creditCeiling: 10 }, by);
    await assert.rejects(() => flow.generateArt(id, { generatorId: 'flux', prompt: 'snow', n: 3 }, by), /Credit hook/);
    const g = await flow.generateArt(id, { generatorId: 'flux', prompt: 'snow', n: 2 }, by);
    assert.equal(card.credits.spent, 8);
    assert.equal(g.assets.length, 1, 'identical outputs collapse to one card by checksum');
    const asset = library.assets.find((x) => x.id === g.assets[0]);
    assert.equal(asset.madeWith.prompt, 'snow');
    assert.equal(asset.level, 'Project');
    assert.ok(card.kit.includes(asset.id));

    // jump to link review and post live
    flow.artDone(id, by);
    const bdir = tmpDir();
    fs.writeFileSync(path.join(bdir, 'index.html'), '<h1>You Can Win</h1>');
    flow.attach(id, { buildPath: bdir }, by);
    await flow.runCard(id, by);
    const b = flow.sealBatch(by);
    flow.markDeployed(b.id, { confirm: 'DEPLOYED' }, by);
    flow.approveGate(id, 'link_review', { playLink: 'https://play.example.com/1', comment: 'Play Now: https://play.example.com/1' }, by);
    await flow.runCard(id, by);
    assert.equal(card.posted.live, true);
    assert.ok(hits.some((h) => h.url === '/asana/tasks/111/stories' && h.method === 'POST' && h.body.data.text.includes('play.example.com')));
    await flow.runCard(id, by); // reads replies from Asana: notes → back as P0
    assert.equal(card.stage, 'intake');
    assert.equal(card.feedback[0].text, 'Please fix the font');
  } finally { server.close(); }
});

test('config: env fallbacks, explicit choices and validation', () => {
  const legacy = loadAppConfig({ file: null, env: { AKAW_CMD_BUILD: 'npm run build', SLACK_WEBHOOK_URL: 'x', JIRA_BASE_URL: 'y' } });
  assert.equal(legacy.steps.build.runner, 'command');
  assert.equal(legacy.tracker.provider, 'jira');
  assert.equal(legacy.chat[0].provider, 'slack');
  assert.equal(loadAppConfig({ file: null, env: {} }).tracker.provider, 'none');
  const bad = { ...legacy, steps: { ...legacy.steps, qa: { runner: 'n8n' }, draft: { runner: 'capture' } }, generators: [{ id: 'a' }, { id: 'a' }] };
  const problems = validateAppConfig(bad);
  assert.ok(problems.some((p) => p.includes('n8n runner needs "url"')));
  assert.ok(problems.some((p) => p.includes('capture runs only as the preview step')));
  assert.ok(problems.some((p) => p.includes('duplicate generator')));
});

test('capture: a playable plays in portrait and landscape and becomes mp4 + GIF', { skip: !loadPlaywright() && 'Playwright not installed' }, async (t) => {
  if (!(await hasFfmpeg())) return t.skip('FFmpeg not installed');
  const build = tmpDir('akaw-play-');
  fs.writeFileSync(path.join(build, 'index.html'), '<html><body style="margin:0;background:#123"><div id="b" style="width:60px;height:60px;background:#ff7a45;position:absolute"></div><script>let x=0;setInterval(()=>{x=(x+7)%300;b.style.left=x+"px";b.style.top=x/2+"px"},40)</script></body></html>');
  const out = tmpDir('akaw-cap-');
  const r = await capture(build, out, { seconds: 1.5 });
  assert.ok(r.ok, r.log.join('\n'));
  assert.equal(r.previews.length, 2);
  for (const p of r.previews) {
    assert.ok(fs.statSync(p.mp4).size > 0);
    assert.ok(fs.statSync(p.gif).size > 0);
  }
  assert.equal(r.screenshots.length, 2);
});

test('toolbox lists the production tools and what each is for', async () => {
  const tools = await detectTools(loadAppConfig({ file: null, env: {} }));
  const ids = tools.map((t) => t.id);
  for (const id of ['ffmpeg', 'claude', 'n8n', 'remotion', 'nexrender', 'aerender', 'blender', 'playwright']) assert.ok(ids.includes(id), id);
  assert.ok(tools.every((t) => t.for));
});

test('the example config loads cleanly and JSON templates survive quotes in copy', async () => {
  const { ROOT } = await import('../src/config.js');
  const { writeFiles } = await import('../src/runners.js');
  const app = loadAppConfig({ file: path.join(ROOT, 'akaw.config.example.json'), env: {} });
  assert.equal(app.error, null);
  assert.deepEqual(validateAppConfig(app), []);
  assert.equal(app.tracker.provider, 'jira');
  assert.equal(app.steps.preview.runner, 'capture');
  assert.equal(app.deploy.command, 'npm run playable:deploy -- --batch');
  const dir = tmpDir();
  writeFiles({ writeFiles: { 'job.json': 'templates/nexrender-job.json' } }, { card: { id: 'AK-1', title: 'Say "hi"', artifacts: {} }, spec: { fields: { winLine: { value: 'You Can Win' }, prize: { value: 50 } } }, game: { name: 'G' }, dir, specFile: '' });
  const job = JSON.parse(fs.readFileSync(path.join(dir, 'job.json'), 'utf8'));
  assert.equal(job.assets[2].value, 'Say "hi"');
  assert.equal(job.assets[1].value, 50);
});
