import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { Library } from '../src/library.js';
import { Flow } from '../src/flow.js';

export function tmpDir(prefix = 'akaw-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function makeEngine(envOverrides = {}) {
  const dataDir = tmpDir('akaw-data-');
  const cfg = loadConfig({ envFile: '/nonexistent', env: { AKAW_DATA_DIR: dataDir, ...envOverrides } });
  const store = new Store(dataDir, path.join(ROOT, 'seed'));
  const library = new Library(store, cfg);
  const flow = new Flow(store, cfg, library);
  return { cfg, store, library, flow, dataDir };
}

export function seed(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'seed', `${name}.json`), 'utf8'));
}
