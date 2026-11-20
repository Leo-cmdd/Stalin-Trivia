// Jira Cloud: read playable cards (sync), read replies, post the exact approved comment.
// Writes only happen when AKAW_ALLOW_WRITES=1; otherwise they are recorded as dry-runs.

export function configured(cfg) {
  return Boolean(cfg.jira.baseUrl && cfg.jira.email && cfg.jira.token);
}

function headers(cfg) {
  const auth = Buffer.from(`${cfg.jira.email}:${cfg.jira.token}`).toString('base64');
  return { Authorization: `Basic ${auth}`, Accept: 'application/json', 'Content-Type': 'application/json' };
}

async function call(cfg, method, p, body) {
  if (!configured(cfg)) throw new Error('Jira is not configured: set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN in .env');
  const r = await fetch(`${cfg.jira.baseUrl}${p}`, { method, headers: headers(cfg), body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`Jira ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.status === 204 ? null : r.json();
}

// Atlassian Document Format -> plain text
export function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';
  const inner = (node.content || []).map(adfToText).join('');
  return ['paragraph', 'heading', 'listItem', 'blockquote', 'codeBlock'].includes(node.type) ? `${inner}\n` : inner;
}

export function textToAdf(text) {
  return {
    type: 'doc',
    version: 1,
    content: String(text).split('\n').map((line) => (line
      ? { type: 'paragraph', content: [{ type: 'text', text: line }] }
      : { type: 'paragraph', content: [] })),
  };
}

export async function search(cfg, jql = cfg.jira.jql, max = 200) {
  const fields = ['summary', 'priority', 'status', 'labels', 'description', 'created', cfg.jira.sprintField].join(',');
  const issues = [];
  let nextPageToken = '';
  do {
    const q = new URLSearchParams({ jql, fields, maxResults: '100' });
    if (nextPageToken) q.set('nextPageToken', nextPageToken);
    const data = await call(cfg, 'GET', `/rest/api/3/search/jql?${q}`);
    issues.push(...(data.issues || []));
    nextPageToken = data.nextPageToken || '';
  } while (nextPageToken && issues.length < max);
  return issues.map((i) => {
    const sprints = i.fields?.[cfg.jira.sprintField];
    const open = Array.isArray(sprints) ? sprints.filter((s) => s.state !== 'closed').sort((a, b) => Date.parse(a.endDate || 0) - Date.parse(b.endDate || 0))[0] : null;
    return {
      key: i.key,
      summary: i.fields?.summary || '',
      priority: i.fields?.priority?.name || null,
      status: i.fields?.status?.name || null,
      labels: i.fields?.labels || [],
      description: adfToText(i.fields?.description).trim(),
      created: i.fields?.created || null,
      sprintEnd: open?.endDate || null,
      sprintName: open?.name || null,
    };
  });
}

export async function comments(cfg, key) {
  const data = await call(cfg, 'GET', `/rest/api/3/issue/${encodeURIComponent(key)}/comment?orderBy=created&maxResults=100`);
  return (data.comments || []).map((c) => ({
    id: c.id,
    by: c.author?.displayName || 'unknown',
    at: c.created,
    text: adfToText(c.body).trim(),
  }));
}

export async function postComment(cfg, key, text) {
  const data = await call(cfg, 'POST', `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { body: textToAdf(text) });
  return { id: data?.id || null };
}
