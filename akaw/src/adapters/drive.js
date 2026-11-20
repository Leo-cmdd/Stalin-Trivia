// Google Drive adapter: lists a folder (recursively) or one file from a share link.
// Needs GOOGLE_DRIVE_TOKEN (OAuth access token) or GOOGLE_DRIVE_API_KEY (link-shared files).
const FOLDER = 'application/vnd.google-apps.folder';
const FIELDS = 'id,name,mimeType,size,modifiedTime,md5Checksum,thumbnailLink,webViewLink,imageMediaMetadata(width,height),videoMediaMetadata(durationMillis,width,height)';

export function canHandle(link) {
  return /drive\.google\.com|docs\.google\.com/.test(link);
}

export function parseLink(link) {
  const m = link.match(/\/folders\/([A-Za-z0-9_-]+)/) || link.match(/\/file\/d\/([A-Za-z0-9_-]+)/) || link.match(/[?&]id=([A-Za-z0-9_-]+)/);
  if (!m) throw new Error('Could not read a Drive folder or file id from that link');
  return { id: m[1], isFolder: /\/folders\//.test(link) };
}

async function get(url, cfg) {
  const u = new URL(url);
  const headers = {};
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  else if (cfg.apiKey) u.searchParams.set('key', cfg.apiKey);
  else throw new Error('Drive is not configured: set GOOGLE_DRIVE_TOKEN or GOOGLE_DRIVE_API_KEY in .env');
  const r = await fetch(u, { headers });
  if (!r.ok) throw new Error(`Drive ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

const toFile = (f, folder) => ({
  system: 'drive',
  link: f.webViewLink || `https://drive.google.com/file/d/${f.id}/view`,
  path: null,
  fileId: f.id,
  folder,
  name: f.name,
  size: Number(f.size || 0),
  mtime: f.modifiedTime,
  mime: f.mimeType,
  checksum: f.md5Checksum ? `md5:${f.md5Checksum}` : `drive:${f.id}`,
  checksumKind: f.md5Checksum ? 'md5' : 'id-only',
  preview: {
    thumb: f.thumbnailLink || null,
    width: f.imageMediaMetadata?.width || f.videoMediaMetadata?.width || null,
    height: f.imageMediaMetadata?.height || f.videoMediaMetadata?.height || null,
    duration: f.videoMediaMetadata?.durationMillis ? Number(f.videoMediaMetadata.durationMillis) / 1000 : null,
  },
});

export async function list(link, cfg, { maxFiles = 20000 } = {}) {
  const { id, isFolder } = parseLink(link);
  const base = 'https://www.googleapis.com/drive/v3/files';
  if (!isFolder) {
    const f = await get(`${base}/${id}?fields=${encodeURIComponent(FIELDS)}&supportsAllDrives=true`, cfg);
    return { root: link, files: [toFile(f, '.')], truncated: false };
  }
  const files = [];
  const walk = async (folderId, rel) => {
    let pageToken = '';
    do {
      const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
      const data = await get(`${base}?q=${q}&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=nextPageToken,files(${encodeURIComponent(FIELDS)})${pageToken ? `&pageToken=${pageToken}` : ''}`, cfg);
      for (const f of data.files || []) {
        if (files.length >= maxFiles) return;
        if (f.mimeType === FOLDER) await walk(f.id, rel === '.' ? f.name : `${rel}/${f.name}`);
        else files.push(toFile(f, rel));
      }
      pageToken = data.nextPageToken || '';
    } while (pageToken && files.length < maxFiles);
  };
  await walk(id, '.');
  return { root: link, files, truncated: files.length >= maxFiles };
}
