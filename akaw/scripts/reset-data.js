#!/usr/bin/env node
// Moves ./data aside (never deletes it) so the next start begins from the seed.
import fs from 'node:fs';
import { loadConfig } from '../src/config.js';

const { dataDir } = loadConfig();
if (!fs.existsSync(dataDir)) { console.log('Nothing to reset.'); process.exit(0); }
const dest = `${dataDir}-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
fs.renameSync(dataDir, dest);
console.log(`Moved ${dataDir} → ${dest}. Next start uses the seed.`);
