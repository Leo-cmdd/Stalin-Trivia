#!/usr/bin/env node
// Akaw: local playable-ads flow generator. Run with `npm start`, open http://localhost:4747
import http from 'node:http';
import path from 'node:path';
import { ROOT, loadConfig } from './src/config.js';
import { loadAppConfig, validateAppConfig } from './src/appconfig.js';
import { Store } from './src/store.js';
import { Library } from './src/library.js';
import { Flow } from './src/flow.js';
import { createApp } from './src/api.js';
import { registerSecretValues } from './src/secrets.js';

const cfg = loadConfig();
cfg.app = loadAppConfig({ env: cfg.env });
registerSecretValues(cfg.secretValues);
const store = new Store(cfg.dataDir, path.join(ROOT, 'seed'));
const library = new Library(store, cfg);
const flow = new Flow(store, cfg, library);
const app = createApp({ store, cfg, flow, library });

if (!['127.0.0.1', 'localhost', '::1'].includes(cfg.host)) {
  console.warn(`! AKAW_HOST=${cfg.host}: the dashboard can run flow steps; keep it on 127.0.0.1.`);
}
if (cfg.app.error) console.warn(`! ${cfg.app.error}`);
for (const p of validateAppConfig(cfg.app)) console.warn(`! config: ${p}`);

http.createServer(app.handle).listen(cfg.port, cfg.host, () => {
  const on = (b) => (b ? 'on' : 'off');
  console.log(`Akaw is running → http://localhost:${cfg.port}`);
  console.log(`  data: ${cfg.dataDir}`);
  console.log(`  tracker: ${flow.trackerName} ${on(flow.trackerLive)} · chat: ${cfg.app.chat.map((c) => c.provider).join(', ') || 'none'} · writes ${cfg.allowWrites ? 'LIVE' : 'dry-run'}`);
  console.log(`  steps: ${Object.entries(cfg.app.steps).map(([k, v]) => `${k}=${v.runner}`).join(' · ')}`);
  console.log(`  generators: ${cfg.app.generators.map((g) => g.id).join(', ') || 'none'}`);
  if (cfg.app.flowRepo) console.log(`  flow repo: ${cfg.app.flowRepo}`);
});
