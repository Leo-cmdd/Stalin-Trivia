#!/usr/bin/env node
// Akaw: local playable-ads flow generator. Run with `npm start`, open http://localhost:4747
import http from 'node:http';
import path from 'node:path';
import { ROOT, loadConfig, integrationStatus } from './src/config.js';
import { Store } from './src/store.js';
import { Library } from './src/library.js';
import { Flow } from './src/flow.js';
import { createApp } from './src/api.js';
import { registerSecretValues } from './src/secrets.js';

const cfg = loadConfig();
registerSecretValues(cfg.secretValues);
const store = new Store(cfg.dataDir, path.join(ROOT, 'seed'));
const library = new Library(store, cfg);
const flow = new Flow(store, cfg, library);
const app = createApp({ store, cfg, flow, library });

if (!['127.0.0.1', 'localhost', '::1'].includes(cfg.host)) {
  console.warn(`! AKAW_HOST=${cfg.host}: the dashboard can run flow commands; keep it on 127.0.0.1.`);
}

http.createServer(app.handle).listen(cfg.port, cfg.host, () => {
  const st = integrationStatus(cfg);
  const on = (b) => (b ? 'on' : 'off');
  console.log(`Akaw is running → http://localhost:${cfg.port}`);
  console.log(`  data: ${cfg.dataDir}`);
  console.log(`  Jira ${on(st.jira.configured)} · Slack ${on(st.slack.configured)} · Drive ${on(st.drive.configured)} · Box ${on(st.box.configured)} · writes ${cfg.allowWrites ? 'LIVE' : 'dry-run'}`);
  console.log(`  flow repo: ${cfg.flow.repo || '(not set: draft/build are attached by hand)'}`);
});
