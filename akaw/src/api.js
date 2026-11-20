// HTTP API + static dashboard. Localhost only; every write needs the per-session token.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT } from './config.js';
import { validateAppConfig } from './appconfig.js';
import { TRACKERS } from './providers/trackers.js';
import { CHATS, CHAT_EVENTS, chat as chatFor } from './providers/chat.js';
import { GENERATOR_PROVIDERS, generatorConfigured } from './generators.js';
import { describeStep } from './runners.js';
import { detectTools } from './toolbox.js';
import { STAGES, BOARD_ROWS, TIERS } from './stages.js';
import { KINDS, LEVELS, STATUSES, FLAGS } from './library.js';
import { evaluate, describeCheck, CHECK_KINDS, SEVERITIES, LAYERS } from './guardrails.js';
import { scanText } from './secrets.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ico': 'image/x-icon',
};

export function createApp({ store, cfg, flow, library }) {
  const token = crypto.randomBytes(24).toString('hex');
  const allowedHosts = new Set([`localhost:${cfg.port}`, `127.0.0.1:${cfg.port}`, `[::1]:${cfg.port}`]);
  const actor = () => flow.operator;

  const routes = [];
  const on = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    routes.push({ method, re, keys, handler });
  };

  // ---- state --------------------------------------------------------------
  on('GET', '/api/state', () => ({
    ...flow.summary(),
    boardRows: BOARD_ROWS,
    tiers: TIERS,
    games: flow.games,
    clients: flow.clients,
    settings: flow.settings,
    providers: providerStatus(),
    library: { count: library.assets.length, kinds: KINDS, levels: LEVELS, statuses: STATUSES, flags: FLAGS },
    lastScan: library.scans[0] ? { id: library.scans[0].id, at: library.scans[0].at } : null,
    gameStats: gameStats(),
    rulesMeta: { checkKinds: CHECK_KINDS, severities: SEVERITIES, layers: LAYERS },
  }));

  function providerStatus() {
    const env = cfg.env || {};
    const t = flow.trackerConf;
    const details = { jira: { jql: t.jql }, asana: { projectGid: t.projectGid }, monday: { boardId: t.boardId } }[t.provider] || {};
    return {
      allowWrites: cfg.allowWrites,
      configError: flow.app.error,
      problems: validateAppConfig(flow.app),
      tracker: { provider: t.provider, name: flow.trackerName, configured: flow.trackerLive, needs: flow.tracker.secrets, details, options: Object.keys(TRACKERS).filter((k) => k !== 'none') },
      chat: flow.app.chat.map((c) => {
        let p = null;
        try { p = chatFor(c); } catch { /* unknown provider */ }
        return { provider: c.provider, name: p?.name || `${c.provider} (unknown)`, configured: p ? p.configured(c, env) : false, events: c.events, needs: p ? [c.secretEnv || p.secretEnv].filter(Boolean).concat(c.provider === 'telegram' ? ['chatId in config'] : []) : [] };
      }),
      chatOptions: Object.keys(CHATS),
      chatEvents: CHAT_EVENTS,
      steps: Object.fromEntries(Object.entries(flow.app.steps).map(([k, v]) => [k, { runner: v.runner, describe: describeStep(v) }])),
      deployCommand: flow.app.deploy?.command || null,
      flowRepo: flow.app.flowRepo,
      generators: flow.app.generators.map((g) => ({ id: g.id, label: g.label || g.id, provider: g.provider, providerName: GENERATOR_PROVIDERS[g.provider]?.name || g.provider, model: g.model || null, kind: g.kind || 'image', unit: g.unit || 'credits', costPerOutput: g.costPerOutput ?? null, configured: generatorConfigured(g, env), needs: GENERATOR_PROVIDERS[g.provider]?.secretEnv ? [g.secretEnv || GENERATOR_PROVIDERS[g.provider].secretEnv] : [] })),
      drive: { configured: Boolean(cfg.drive.token || cfg.drive.apiKey) },
      box: { configured: Boolean(cfg.box.token) },
    };
  }

  let toolCache = null;

  function gameStats() {
    const out = {};
    for (const g of flow.games) {
      const scopes = ['team', `client:${g.clientId}`, `game:${g.id}`];
      out[g.id] = {
        assets: library.assets.filter((a) => a.gameIds.includes(g.id)).length,
        rules: flow.rules.filter((r) => (r.status || 'active') === 'active' && scopes.includes(r.scope)).length,
        openCards: flow.cards.filter((c) => c.gameId === g.id && c.stage !== 'done').length,
        lastScan: library.scans.find((s) => s.gameId === g.id)?.at || null,
      };
    }
    return out;
  }

  // ---- cards --------------------------------------------------------------
  on('GET', '/api/cards/:id', ({ id }) => {
    const card = flow.card(id);
    const taskUrl = card.taskUrl || (card.taskKey ? flow.tracker.url(flow.trackerConf, cfg.env || {}, card.taskKey) : null);
    return { card: { ...flow.view(card), taskUrl }, kit: flow.kitAssets(card), game: flow.game(card.gameId), audit: store.readAudit(100, (e) => e.cardId === id) };
  });
  on('POST', '/api/spec/preview', (_, b) => flow.specPreview(b));
  on('POST', '/api/cards', (_, b) => flow.view(flow.createCard(b, actor())));
  on('POST', '/api/cards/:id/spec', ({ id }, b) => flow.view(flow.updateSpec(id, b, actor())));
  on('POST', '/api/cards/:id/attach', ({ id }, b) => flow.view(flow.attach(id, b, actor())));
  on('POST', '/api/cards/:id/run', async ({ id }) => flow.view(await flow.runCard(id, actor())));
  on('POST', '/api/cards/:id/gate/:gate', ({ id, gate }, b) => flow.view(flow.approveGate(id, gate, b, actor())));
  on('POST', '/api/cards/:id/send-back', ({ id }, b) => flow.view(flow.sendBack(id, b.stage, b.note, actor())));
  on('POST', '/api/cards/:id/review', ({ id }, b) => flow.view(flow.recordReview(id, b, actor())));
  on('POST', '/api/cards/:id/fetch-replies', async ({ id }) => ({ added: await flow.fetchReplies(id, actor()) }));
  on('POST', '/api/cards/:id/resolve', ({ id }, b) => flow.view(flow.resolveMixed(id, b.as, actor())));
  on('POST', '/api/cards/:id/credits', ({ id }, b) => flow.view(flow.recordCredits(id, b.credits, b.note, actor())));
  on('POST', '/api/cards/:id/art-done', ({ id }) => flow.view(flow.artDone(id, actor())));
  on('POST', '/api/cards/:id/queue', ({ id }, b) => flow.view(flow.setQueue(id, b, actor())));
  on('POST', '/api/queue/run', async () => ({ ran: await flow.runQueue(actor()) }));
  on('POST', '/api/batches/seal', () => flow.sealBatch(actor()));
  on('POST', '/api/batches/:id/deployed', ({ id }, b) => flow.markDeployed(id, b, actor()));

  // ---- task tracker, art, toolbox -----------------------------------------
  on('POST', '/api/tracker/preview', async () => flow.trackerPreview(actor()));
  on('POST', '/api/tracker/import', (_, b) => ({ created: flow.trackerImport(b.keys || [], actor()) }));
  on('POST', '/api/cards/:id/generate', async ({ id }, b) => {
    const r = await flow.generateArt(id, b, actor());
    return { card: flow.view(r.card), assets: r.assets };
  });
  on('GET', '/api/toolbox', async (_, __, q) => {
    if (!toolCache || q.get('refresh')) toolCache = { at: new Date().toISOString(), tools: await detectTools(flow.app) };
    return toolCache;
  });

  // ---- guardrails ---------------------------------------------------------
  on('GET', '/api/rules', () => ({
    rules: flow.rules.map((r) => ({ ...r, describe: describeCheck(r.check) })),
    lessons: flow.lessons,
  }));
  on('POST', '/api/rules', (_, b) => flow.addRule(b, actor()));
  on('POST', '/api/rules/check', (_, b) => {
    const game = flow.game(b.gameId);
    const copy = String(b.text || '').split('\n').filter(Boolean);
    return {
      ...evaluate(flow.rules, { copy, lengthSeconds: b.lengthSeconds, prize: b.prize, archetype: b.archetype }, { gameId: b.gameId, clientId: game?.clientId, route: b.route || 'UA', game }),
      secrets: scanText(b.text || ''),
    };
  });
  on('POST', '/api/rules/:id/meta', ({ id }, b) => flow.updateRuleMeta(id, b, actor()));
  on('POST', '/api/rules/:id/retire', ({ id }) => flow.retireRule(id, actor()));
  on('POST', '/api/rules/:id/exceptions', ({ id }, b) => flow.addException(id, b, actor()));
  on('POST', '/api/lessons/:id/:decision', ({ id, decision }) => {
    if (!['adopt', 'reject'].includes(decision)) throw new Error('adopt or reject');
    return flow.decideLesson(id, decision, actor());
  });
  on('POST', '/api/games/copy-rules', (_, b) => flow.copyGameRules(b.from, b.to, b.keep || [], actor()));

  // ---- games and clients --------------------------------------------------
  on('POST', '/api/clients', (_, b) => flow.upsertClient(b, actor()));
  on('POST', '/api/games', (_, b) => flow.upsertGame(b, actor()));

  // ---- library ------------------------------------------------------------
  on('GET', '/api/assets', (_, __, q) => {
    const list = library.filter(Object.fromEntries(q));
    const limit = Number(q.get('limit')) || 300;
    return { total: list.length, assets: list.slice(0, limit) };
  });
  on('GET', '/api/scans', () => ({ scans: library.scans.map((s) => ({ id: s.id, at: s.at, sources: s.sources, gameId: s.gameId, status: s.status, stats: s.stats, errors: s.errors })) }));
  on('GET', '/api/scans/:id', ({ id }) => {
    const s = library.scans.find((x) => x.id === id);
    if (!s) throw httpError(404, 'Scan not found');
    return s;
  });
  on('POST', '/api/scans', async (_, b) => library.scan(b, actor()));
  on('POST', '/api/scans/:id/accept', async ({ id }, b) => ({ created: (await library.accept(id, b, actor())).length }));
  on('POST', '/api/scans/:id/skip', ({ id }, b) => ({ skipped: library.skip(id, b, actor()) }));
  on('POST', '/api/scans/:id/rescan', async ({ id }) => library.rescan(id, actor()));
  on('POST', '/api/assets/:id', ({ id }, b) => library.update(decodeURIComponent(id), b, actor()));
  on('POST', '/api/assets/:id/promote', ({ id }, b) => library.promote(decodeURIComponent(id), b, actor()));
  on('POST', '/api/assets/:id/retire', ({ id }, b) => library.retire(decodeURIComponent(id), b, actor()));
  on('POST', '/api/assets/:id/hold', async ({ id }) => {
    const a = library.assets.find((x) => x.id === decodeURIComponent(id));
    if (!a) throw httpError(404, 'Asset not found');
    await library.hold(a);
    store.save('assets');
    store.audit(actor(), 'library.hold', { assetId: a.id });
    return a;
  });

  // ---- settings, audit ---------------------------------------------------
  on('POST', '/api/settings', (_, b) => flow.updateSettings(b, actor()));
  on('GET', '/api/audit', (_, __, q) => ({ entries: store.readAudit(Number(q.get('limit')) || 300) }));

  // ---- server ---------------------------------------------------------------
  async function handle(req, res) {
    try {
      if (!allowedHosts.has(req.headers.host || '')) return send(res, 403, { error: 'Akaw answers on localhost only' });
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (req.method === 'GET' && url.pathname.startsWith('/preview/')) return servePreview(res, decodeURIComponent(url.pathname.slice(9)));
      if (req.method === 'GET' && url.pathname === '/run-file') return serveRunFile(res, url.searchParams.get('p') || '');
      return serveStatic(res, url.pathname);
    } catch (err) {
      return send(res, err.status || 500, { error: err.message });
    }
  }

  async function handleApi(req, res, url) {
    if (req.method !== 'GET' && req.headers['x-akaw-token'] !== token) return send(res, 403, { error: 'Missing or wrong session token. Reload the dashboard.' });
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
      const body = req.method === 'GET' ? {} : await readJson(req);
      try {
        return send(res, 200, await r.handler(params, body, url.searchParams));
      } catch (err) {
        return send(res, err.status || 400, { error: err.message });
      }
    }
    return send(res, 404, { error: 'No such route' });
  }

  function servePreview(res, id) {
    const p = library.previewPath(id);
    if (!p) return send(res, 404, { error: 'No local preview' });
    const type = MIME[path.extname(p).toLowerCase()];
    if (!type || !/^(image|video|audio)\//.test(type)) return send(res, 415, { error: 'No preview for this type' });
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=60', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(p).pipe(res);
  }

  // Capture outputs (GIF, mp4, screenshots) under data/runs only.
  function serveRunFile(res, p) {
    const runs = path.join(cfg.dataDir, 'runs');
    const file = path.resolve(p);
    if (!file.startsWith(runs + path.sep) || !fs.existsSync(file)) return send(res, 404, { error: 'Not found' });
    const type = MIME[path.extname(file).toLowerCase()];
    if (!type || !/^(image|video)\//.test(type)) return send(res, 415, { error: 'No preview for this type' });
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=60', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(file).pipe(res);
  }

  function serveStatic(res, pathname) {
    const pub = path.join(ROOT, 'public');
    let file = path.normalize(path.join(pub, pathname === '/' ? 'index.html' : pathname));
    if (!file.startsWith(pub)) return send(res, 403, { error: 'no' });
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(pub, 'index.html');
    let body = fs.readFileSync(file);
    if (file.endsWith('index.html')) body = Buffer.from(body.toString().replace('__AKAW_TOKEN__', token));
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    });
    res.end(body);
  }

  return { handle, token };
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readJson(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(httpError(413, 'Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(httpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}
