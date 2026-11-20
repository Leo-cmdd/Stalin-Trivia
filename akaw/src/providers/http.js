// Small fetch wrapper: JSON in, JSON out, timeouts, readable errors.
export async function request(url, { method = 'GET', headers = {}, body, timeoutMs = 60_000, raw = false } = {}) {
  const init = { method, headers: { ...headers }, signal: AbortSignal.timeout(timeoutMs) };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (!init.headers['Content-Type'] && !init.headers['content-type']) init.headers['Content-Type'] = 'application/json';
  }
  let r;
  try { r = await fetch(url, init); } catch (e) {
    throw new Error(`${new URL(url).host}: ${e.name === 'TimeoutError' ? 'timed out' : e.message}`);
  }
  if (raw) return r;
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    const msg = typeof data === 'string' ? data : JSON.stringify(data);
    const e = new Error(`${new URL(url).host} ${r.status}: ${String(msg).slice(0, 300)}`);
    e.status = r.status;
    throw e;
  }
  return data;
}

export async function download(url, headers = {}, timeoutMs = 300_000) {
  const r = await request(url, { headers, timeoutMs, raw: true });
  if (!r.ok) throw new Error(`download ${r.status} from ${new URL(url).host}`);
  return { buffer: Buffer.from(await r.arrayBuffer()), mime: (r.headers.get('content-type') || '').split(';')[0] };
}

// Collect every http(s) URL found under keys named url/uri/href, or as bare strings in arrays.
export function collectUrls(obj, out = []) {
  if (!obj) return out;
  if (typeof obj === 'string') { if (/^https?:\/\//.test(obj)) out.push(obj); return out; }
  if (Array.isArray(obj)) { for (const v of obj) collectUrls(v, out); return out; }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string' && /^(url|uri|href|output|video|image|audio)$/i.test(k) && /^https?:\/\//.test(v)) out.push(v);
      else if (typeof v === 'object') collectUrls(v, out);
    }
  }
  return [...new Set(out)];
}
