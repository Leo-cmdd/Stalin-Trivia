// Asset library built from links: scan, classify, dedupe by checksum, propose cards,
// review, then index (pointer only, the default) or hold (copy pinned by checksum).
import fs from 'node:fs';
import path from 'node:path';
import { listSource } from './adapters/index.js';
import { checksumFile } from './adapters/local.js';

export const KINDS = [
  'logo', 'character', 'gameplay render', 'background', 'end card', 'music', 'voice',
  'subtitle style', 'AI plate', 'playable core', 'template', 'screenshot', 'brief', 'font', 'project file', 'other',
];
export const LEVELS = ['Locked', 'Library', 'Project'];
export const STATUSES = ['candidate', 'approved', 'retired'];
export const FLAGS = ['person', 'phone', 'money', 'ai-gameplay', 'coins'];

const EXT = {
  image: /\.(png|jpe?g|webp|gif|svg|tiff?|bmp|heic)$/i,
  video: /\.(mp4|mov|webm|m4v|avi|mkv)$/i,
  audio: /\.(mp3|wav|ogg|m4a|aac|flac|aiff?)$/i,
  font: /\.(ttf|otf|woff2?)$/i,
  project: /\.(aep|aepx|psd|psb|ai|blend|prproj|fig|sketch|c4d)$/i,
  doc: /\.(md|pdf|docx?|txt|rtf|pages)$/i,
  playable: /\.(html?|zip)$/i,
  lottie: /\.json$/i,
};

const NAME_RULES = [
  ['end card', /end[\s_-]?card|endcard|\bec\b/i],
  ['logo', /logo|wordmark|brandmark/i],
  ['character', /\bchar(acter)?s?\b|mascot|avatar/i],
  ['background', /\bbg\b|background|backdrop/i],
  ['music', /music|\bsong\b|\bbgm\b|soundtrack|jingle|sting/i],
  ['voice', /\bvo\b|voice|narrat/i],
  ['subtitle style', /subtitle|caption|\bsubs?\b/i],
  ['AI plate', /\bai\b|higgsfield|seedance|plate/i],
  ['gameplay render', /gameplay|capture|render|\brec\b/i],
  ['screenshot', /screenshot|screen[\s_-]?shot|\bss\b/i],
  ['playable core', /\bcore\b/i],
  ['template', /template|\btpl\b/i],
  ['brief', /brief|spec/i],
];

export function classify(name, mime = '') {
  const n = String(name);
  let type = 'other';
  for (const [t, re] of Object.entries(EXT)) if (re.test(n)) { type = t; break; }
  if (type === 'other' && mime) {
    if (mime.startsWith('image/')) type = 'image';
    else if (mime.startsWith('video/')) type = 'video';
    else if (mime.startsWith('audio/')) type = 'audio';
  }
  let kind = null;
  // Treat _ - . as word breaks so bg_snow.png reads as "bg snow png".
  const words = n.replace(/[_\-.]+/g, ' ');
  for (const [k, re] of NAME_RULES) if (re.test(words)) { kind = k; break; }
  if (!kind) {
    kind = {
      font: 'font', project: 'project file', doc: 'brief', audio: 'music', playable: 'playable core',
      video: 'gameplay render', image: 'other', lottie: 'template',
    }[type] || 'other';
  }
  return { type, kind };
}

// Folders follow GAME_BUCKET_NNNNN (Name), for example MMC_UA_00017 (DragonBrain).
export function parseCreativeFolder(folder) {
  for (const part of String(folder || '').split('/').reverse()) {
    const m = part.match(/^([A-Z][A-Z0-9]{1,6})_([A-Z]{2,6})_(\d{3,6})(?:\s*\(([^)]+)\))?/);
    if (m) return { gameCode: m[1], bucket: m[2], creativeId: `${m[1]}_${m[2]}_${m[3]}`, creativeName: m[4] || null };
  }
  return null;
}

export class Library {
  constructor(store, cfg) {
    this.store = store;
    this.cfg = cfg;
    this.heldDir = path.join(cfg.dataDir, 'held');
  }

  get assets() { return this.store.get('assets', []); }
  get scans() { return this.store.get('scans', []); }

  byChecksum() {
    const m = new Map();
    for (const a of this.assets) if (a.source?.checksum) m.set(a.source.checksum, a);
    return m;
  }

  gameForCode(code) {
    return this.store.get('games', []).find((g) => (g.codes || []).includes(code)) || null;
  }

  async scan({ sources = [], gameId = null, clientId = null }, actor) {
    const links = sources.map((s) => String(s).trim()).filter(Boolean);
    if (!links.length) throw new Error('Paste at least one link or folder path');
    const scan = {
      id: this.store.nextId('SCAN'), at: new Date().toISOString(), by: actor, sources: links,
      gameId, clientId, status: 'proposed', errors: [], groups: [], stats: {},
    };
    const known = this.byChecksum();
    const seen = new Map();
    let total = 0; let duplicates = 0; let unnamed = 0; let alreadyKnown = 0;
    for (const link of links) {
      try {
        const { files, truncated } = await listSource(link, this.cfg);
        if (truncated) scan.errors.push({ link, error: 'Stopped at 20,000 files. Scan a smaller folder.' });
        for (const f of files) {
          total++;
          if (seen.has(f.checksum)) {
            duplicates++;
            seen.get(f.checksum).locations.push({ system: f.system, link: f.link, path: f.path, folder: f.folder });
            continue;
          }
          const { type, kind } = classify(f.name, f.mime);
          const parsed = parseCreativeFolder(f.folder);
          const codeGame = parsed ? this.gameForCode(parsed.gameCode) : null;
          if (!parsed) unnamed++;
          const existing = known.get(f.checksum);
          if (existing) alreadyKnown++;
          const proposal = {
            key: f.checksum,
            name: f.name,
            folder: f.folder,
            type,
            kind,
            size: f.size,
            mtime: f.mtime,
            source: { system: f.system, link: f.link, path: f.path, fileId: f.fileId, checksum: f.checksum, checksumKind: f.checksumKind, size: f.size, mtime: f.mtime },
            preview: f.preview || null,
            creative: parsed,
            gameId: gameId || codeGame?.id || null,
            existingId: existing?.id || null,
            locations: [],
            decision: existing ? 'known' : 'pending',
          };
          seen.set(f.checksum, proposal);
        }
      } catch (err) {
        scan.errors.push({ link, error: err.message });
      }
    }
    const groups = new Map();
    for (const p of seen.values()) {
      if (!groups.has(p.folder)) groups.set(p.folder, { folder: p.folder, creative: p.creative, items: [] });
      groups.get(p.folder).items.push(p);
    }
    scan.groups = [...groups.values()].sort((a, b) => a.folder.localeCompare(b.folder));
    scan.stats = { files: total, unique: seen.size, duplicates, unnamedFolders: unnamed, alreadyKnown };
    // Pointers of known assets are refreshed right away (moved files keep their card).
    for (const p of seen.values()) {
      if (p.existingId) this.refreshPointer(p.existingId, p.source);
    }
    this.scans.unshift(scan);
    if (this.scans.length > 50) this.scans.length = 50;
    this.store.save('scans');
    this.store.save('assets');
    this.store.audit(actor, 'scan', { scanId: scan.id, sources: links, stats: scan.stats, errors: scan.errors.length });
    return scan;
  }

  refreshPointer(assetId, source) {
    const a = this.assets.find((x) => x.id === assetId);
    if (!a) return;
    const moved = a.source.link !== source.link;
    a.source = { ...a.source, ...source, gone: false, movedFrom: moved ? a.source.link : a.source.movedFrom || null };
    a.lastSeen = new Date().toISOString();
  }

  async accept(scanId, { keys = null, folders = null, mode = 'index', level = 'Project' } = {}, actor) {
    const scan = this.scans.find((s) => s.id === scanId);
    if (!scan) throw new Error('Scan not found');
    if (level === 'Locked') throw new Error('A scan never writes to Locked.');
    const made = [];
    for (const g of scan.groups) {
      for (const p of g.items) {
        const picked = (keys && keys.includes(p.key)) || (folders && folders.includes(g.folder));
        if (!picked || p.decision !== 'pending') continue;
        const asset = await this.createAsset(p, scan, { mode, level }, actor);
        p.decision = 'accepted';
        p.assetId = asset.id;
        made.push(asset);
      }
    }
    if (scan.groups.every((g) => g.items.every((p) => p.decision !== 'pending'))) scan.status = 'reviewed';
    this.store.save('scans');
    this.store.save('assets');
    this.store.audit(actor, 'library.accept', { scanId, count: made.length, mode });
    return made;
  }

  skip(scanId, { keys = null, folders = null } = {}, actor) {
    const scan = this.scans.find((s) => s.id === scanId);
    if (!scan) throw new Error('Scan not found');
    let n = 0;
    for (const g of scan.groups) for (const p of g.items) {
      if (p.decision !== 'pending') continue;
      if ((keys && keys.includes(p.key)) || (folders && folders.includes(g.folder))) { p.decision = 'skipped'; n++; }
    }
    this.store.save('scans');
    this.store.audit(actor, 'library.skip', { scanId, count: n });
    return n;
  }

  async createAsset(p, scan, { mode, level }, actor) {
    const games = this.store.get('games', []);
    const gameId = p.gameId || scan.gameId || null;
    const game = games.find((g) => g.id === gameId);
    const sysId = p.source.fileId || p.key.split(':').pop().slice(0, 20);
    let id = `${p.source.system}:${sysId}`;
    if (this.assets.some((a) => a.id === id)) id = `${id}-${this.store.nextId('A').split('-')[1]}`;
    const asset = {
      id,
      name: p.name,
      gameIds: gameId ? [gameId] : [],
      clientIds: [scan.clientId || game?.clientId].filter(Boolean),
      kind: p.kind,
      type: p.type,
      level,
      status: 'candidate',
      replacedBy: null,
      source: { ...p.source, gone: false },
      locations: p.locations,
      held: null,
      preview: p.preview || { thumb: null },
      useFor: '',
      dont: '',
      approval: null,
      madeWith: p.kind === 'AI plate' ? { tool: null, prompt: null, credits: null } : null,
      usedBy: [],
      flags: [],
      tags: [],
      creative: p.creative,
      folder: p.folder,
      scanId: scan.id,
      createdAt: new Date().toISOString(),
      createdBy: actor,
    };
    if (mode === 'hold') await this.hold(asset);
    this.assets.push(asset);
    return asset;
  }

  async hold(asset) {
    if (asset.source.system !== 'local' || !asset.source.path) {
      throw new Error(`Holding ${asset.source.system} files is not built yet. Index it, or download it to a local folder and scan that.`);
    }
    fs.mkdirSync(this.heldDir, { recursive: true });
    const st = fs.statSync(asset.source.path);
    const { checksum } = await checksumFile(asset.source.path, st.size, Infinity);
    const key = `${checksum.replace(':', '-')}${path.extname(asset.name).toLowerCase()}`;
    const dest = path.join(this.heldDir, key);
    if (!fs.existsSync(dest)) fs.copyFileSync(asset.source.path, dest);
    asset.held = { key, checksum, at: new Date().toISOString() };
    return asset;
  }

  // A file made by a generator becomes a Project card with "made with" filled in.
  async registerGenerated(file, { gameId, clientId, cardId, madeWith }, actor) {
    const st = fs.statSync(file);
    const { checksum, checksumKind } = await checksumFile(file, st.size);
    const existing = this.assets.find((a) => a.source?.checksum === checksum);
    if (existing) {
      if (cardId && !existing.usedBy.includes(cardId)) existing.usedBy.push(cardId);
      this.store.save('assets');
      return existing;
    }
    const name = path.basename(file);
    const { type, kind } = classify(name);
    const asset = {
      id: `gen:${checksum.split(':').pop().slice(0, 16)}`,
      name,
      gameIds: gameId ? [gameId] : [],
      clientIds: clientId ? [clientId] : [],
      kind: kind === 'other' || kind === 'gameplay render' ? 'AI plate' : kind,
      type,
      level: 'Project',
      status: 'candidate',
      replacedBy: null,
      source: { system: 'local', link: file, path: file, fileId: null, checksum, checksumKind, size: st.size, mtime: st.mtime.toISOString(), gone: false },
      locations: [],
      held: null,
      preview: { thumb: null },
      useFor: '',
      dont: '',
      approval: null,
      madeWith,
      usedBy: cardId ? [cardId] : [],
      flags: [],
      tags: ['ai-generated'],
      creative: null,
      folder: path.basename(path.dirname(file)),
      scanId: null,
      createdAt: new Date().toISOString(),
      createdBy: actor,
    };
    this.assets.push(asset);
    this.store.save('assets');
    return asset;
  }

  update(id, patch, actor) {
    const a = this.assets.find((x) => x.id === id);
    if (!a) throw new Error('Asset not found');
    if (a.level === 'Locked') throw new Error('Locked assets are changed only by their owner, outside Akaw.');
    const allowed = ['name', 'kind', 'gameIds', 'clientIds', 'useFor', 'dont', 'flags', 'tags', 'madeWith'];
    for (const k of allowed) if (k in patch) a[k] = patch[k];
    if (patch.flags) a.flags = patch.flags.filter((f) => FLAGS.includes(f));
    this.store.save('assets');
    this.store.audit(actor, 'library.update', { assetId: id, fields: Object.keys(patch) });
    return a;
  }

  promote(id, { by, note }, actor) {
    const a = this.assets.find((x) => x.id === id);
    if (!a) throw new Error('Asset not found');
    if (!by) throw new Error('Name who approved it');
    if (a.level === 'Locked') throw new Error('Locked assets are not promoted.');
    a.level = 'Library';
    a.status = 'approved';
    a.approval = { by, at: new Date().toISOString(), note: note || '' };
    this.store.save('assets');
    this.store.audit(actor, 'library.promote', { assetId: id, approvedBy: by, note });
    return a;
  }

  retire(id, { replacedBy = null }, actor) {
    const a = this.assets.find((x) => x.id === id);
    if (!a) throw new Error('Asset not found');
    if (a.level === 'Locked') throw new Error('Locked assets are retired only by their owner.');
    a.status = 'retired';
    a.replacedBy = replacedBy || null;
    this.store.save('assets');
    this.store.audit(actor, 'library.retire', { assetId: id, replacedBy, touches: a.usedBy });
    return a;
  }

  // Re-scan: update pointers, flag what vanished, add new files as candidates.
  async rescan(scanId, actor) {
    const old = this.scans.find((s) => s.id === scanId);
    if (!old) throw new Error('Scan not found');
    const fresh = await this.scan({ sources: old.sources, gameId: old.gameId, clientId: old.clientId }, actor);
    const seen = new Set(fresh.groups.flatMap((g) => g.items.map((p) => p.key)));
    const gone = [];
    for (const a of this.assets) {
      if (a.scanId === scanId || old.groups.some((g) => g.items.some((p) => p.assetId === a.id))) {
        if (!seen.has(a.source.checksum) && !a.source.gone) { a.source.gone = true; gone.push(a.id); }
      }
    }
    fresh.rescanOf = scanId;
    fresh.gone = gone;
    this.store.save('assets');
    this.store.save('scans');
    return fresh;
  }

  filter(q = {}) {
    const text = (q.q || '').toLowerCase();
    return this.assets.filter((a) => (!q.gameId || a.gameIds.includes(q.gameId))
      && (!q.clientId || a.clientIds.includes(q.clientId))
      && (!q.kind || a.kind === q.kind)
      && (!q.level || a.level === q.level)
      && (!q.status || a.status === q.status)
      && (!text || `${a.name} ${a.folder} ${a.creative?.creativeId || ''} ${(a.tags || []).join(' ')}`.toLowerCase().includes(text)));
  }

  previewPath(id) {
    const a = this.assets.find((x) => x.id === id);
    if (!a) return null;
    if (a.held) {
      const p = path.join(this.heldDir, a.held.key);
      if (fs.existsSync(p)) return p;
    }
    if (a.source.system === 'local' && a.source.path && fs.existsSync(a.source.path)) return a.source.path;
    return null;
  }
}
