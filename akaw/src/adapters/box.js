// Box adapter: lists a folder from a share or app link. Needs BOX_TOKEN.
export function canHandle(link) {
  return /(^|\.)box\.com\//.test(link);
}

export function parseLink(link) {
  const m = link.match(/\/folder\/(\d+)/);
  if (!m) throw new Error('Use a Box folder link like https://app.box.com/folder/123456');
  return { id: m[1] };
}

export async function list(link, cfg, { maxFiles = 20000 } = {}) {
  if (!cfg.token) throw new Error('Box is not configured: set BOX_TOKEN in .env');
  const { id } = parseLink(link);
  const files = [];
  const walk = async (folderId, rel) => {
    let offset = 0;
    for (;;) {
      const r = await fetch(`https://api.box.com/2.0/folders/${folderId}/items?fields=id,name,type,size,modified_at,sha1&limit=1000&offset=${offset}`, { headers: { Authorization: `Bearer ${cfg.token}` } });
      if (!r.ok) throw new Error(`Box ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const data = await r.json();
      for (const e of data.entries || []) {
        if (files.length >= maxFiles) return;
        if (e.type === 'folder') await walk(e.id, rel === '.' ? e.name : `${rel}/${e.name}`);
        else if (e.type === 'file') files.push({
          system: 'box', link: `https://app.box.com/file/${e.id}`, path: null, fileId: e.id, folder: rel,
          name: e.name, size: Number(e.size || 0), mtime: e.modified_at,
          checksum: e.sha1 ? `sha1:${e.sha1}` : `box:${e.id}`, checksumKind: e.sha1 ? 'sha1' : 'id-only',
        });
      }
      offset += (data.entries || []).length;
      if (!data.entries?.length || offset >= (data.total_count || 0)) break;
    }
  };
  await walk(id, '.');
  return { root: link, files, truncated: files.length >= maxFiles };
}
