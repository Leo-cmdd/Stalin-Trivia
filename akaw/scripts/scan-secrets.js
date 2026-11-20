#!/usr/bin/env node
// Scans a folder (default: this repo) for keys, tokens and passwords. Exit 1 on any finding.
import path from 'node:path';
import { ROOT, loadConfig } from '../src/config.js';
import { scanPath, registerSecretValues } from '../src/secrets.js';

const target = path.resolve(process.argv[2] || ROOT);
registerSecretValues(loadConfig().secretValues);
const findings = scanPath(target);
if (!findings.length) {
  console.log(`No secrets found in ${target}`);
  process.exit(0);
}
for (const f of findings) console.log(`${f.file}: ${f.type} (${f.preview})`);
console.log(`\n${findings.length} possible secret(s). Remove them, then rotate anything real.`);
process.exit(1);
