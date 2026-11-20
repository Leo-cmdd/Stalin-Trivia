// Local / mounted-volume adapter (the Lucid volume case): crawls a folder on this Mac.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SKIP = new Set(['node_modules', '.git', '.Trashes', '.Spotlight-V100', '.fseventsd', '__MACOSX']);

export function canHandle(link) {
  return path.isAbsolute(link) || link.startsWith('~/') || link.startsWith('file://');
}

export function resolvePath(link) {
  let p = link.startsWith('file://') ? decodeURIComponent(new URL(link).pathname) : link;
  if (p.startsWith('~/')) p = path.join(process.env.HOME || '', p.slice(2));
  return path.resolve(p);
}

export async function checksumFile(file, size, quickAboveBytes = 64 * 1024 * 1024) {
  if (size > quickAboveBytes) {
    // Quick fingerprint for very large renders: size + first and last 4 MB.
    const fd = await fs.promises.open(file, 'r');
    try {
      const chunk = 4 * 1024 * 1024;
      const a = Buffer.alloc(chunk); const b = Buffer.alloc(chunk);
      await fd.read(a, 0, chunk, 0);
      await fd.read(b, 0, chunk, Math.max(0, size - chunk));
      const h = crypto.createHash('sha256').update(String(size)).update(a).update(b).digest('hex');
      return { checksum: `q256:${h}`, checksumKind: 'quick' };
    } finally { await fd.close(); }
  }
  const h = crypto.createHash('sha256');
  await new Promise((res, rej) => fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', res).on('error', rej));
  return { checksum: `sha256:${h.digest('hex')}`, checksumKind: 'full' };
}

export async function list(link, { maxFiles = 20000, quickAboveBytes } = {}) {
  const root = resolvePath(link);
  if (!fs.existsSync(root)) throw new Error(`Not found on this machine: ${root}`);
  const files = [];
  const rootIsFile = fs.statSync(root).isFile();
  const base = rootIsFile ? path.dirname(root) : root;
  const walk = async (dir) => {
    let ents;
    try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      if (files.length >= maxFiles) return;
      if (ent.name.startsWith('.') || SKIP.has(ent.name)) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { await walk(p); continue; }
      if (!ent.isFile()) continue;
      files.push(await describe(p));
    }
  };
  const describe = async (p) => {
    const st = await fs.promises.stat(p);
    const sum = await checksumFile(p, st.size, quickAboveBytes);
    return {
      system: 'local',
      link: p,
      path: p,
      fileId: null,
      folder: path.relative(base, path.dirname(p)) || '.',
      name: path.basename(p),
      size: st.size,
      mtime: st.mtime.toISOString(),
      ...sum,
    };
  };
  if (rootIsFile) files.push(await describe(root));
  else await walk(root);
  return { root, files, truncated: files.length >= maxFiles };
}
