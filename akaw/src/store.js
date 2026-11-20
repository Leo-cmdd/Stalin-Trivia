// JSON-file store: one file per collection, atomic writes, append-only audit log.
import fs from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(dir, seedDir = null) {
    this.dir = dir;
    this.seedDir = seedDir;
    this.cache = {};
    fs.mkdirSync(dir, { recursive: true });
  }

  get(name, fallback = []) {
    if (!(name in this.cache)) {
      const file = path.join(this.dir, `${name}.json`);
      if (fs.existsSync(file)) {
        this.cache[name] = JSON.parse(fs.readFileSync(file, 'utf8'));
      } else {
        const seed = this.seedDir && path.join(this.seedDir, `${name}.json`);
        this.cache[name] = seed && fs.existsSync(seed)
          ? JSON.parse(fs.readFileSync(seed, 'utf8'))
          : structuredClone(fallback);
        this.save(name);
      }
    }
    return this.cache[name];
  }

  set(name, value) {
    this.cache[name] = value;
    this.save(name);
    return value;
  }

  save(name) {
    const file = path.join(this.dir, `${name}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.cache[name], null, 2));
    fs.renameSync(tmp, file);
  }

  nextId(prefix) {
    const counters = this.get('counters', {});
    counters[prefix] = (counters[prefix] || 0) + 1;
    this.save('counters');
    return `${prefix}-${String(counters[prefix]).padStart(4, '0')}`;
  }

  audit(actor, action, details = {}) {
    const entry = { ts: new Date().toISOString(), actor: actor || 'system', action, ...details };
    fs.appendFileSync(path.join(this.dir, 'audit.jsonl'), `${JSON.stringify(entry)}\n`);
    return entry;
  }

  readAudit(limit = 300, filter = null) {
    const file = path.join(this.dir, 'audit.jsonl');
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        const e = JSON.parse(lines[i]);
        if (!filter || filter(e)) out.push(e);
      } catch { /* skip a torn line */ }
    }
    return out;
  }
}
