// Task trackers: where playable cards come from and where the review comment goes.
// One interface: configured, search, comments, postComment, url. Secrets come from .env.
import { request } from './http.js';

const PRIORITY_WORDS = ['highest', 'high', 'medium', 'low', 'lowest', 'critical', 'blocker', 'urgent'];
const normPriority = (p) => {
  const s = String(p || '').toLowerCase();
  if (s === 'urgent' || s === 'critical' || s === 'blocker') return 'Highest';
  const hit = PRIORITY_WORDS.find((w) => s.includes(w));
  return hit ? hit[0].toUpperCase() + hit.slice(1) : null;
};

// ---- Jira Cloud ------------------------------------------------------------
export function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';
  const inner = (node.content || []).map(adfToText).join('');
  return ['paragraph', 'heading', 'listItem', 'blockquote', 'codeBlock'].includes(node.type) ? `${inner}\n` : inner;
}
export function textToAdf(text) {
  return { type: 'doc', version: 1, content: String(text).split('\n').map((line) => (line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph', content: [] })) };
}

const jira = {
  name: 'Jira',
  secrets: ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'],
  base: (t, env) => (t.baseUrl || env.JIRA_BASE_URL || '').replace(/\/+$/, ''),
  configured: (t, env) => Boolean(jira.base(t, env) && env.JIRA_EMAIL && env.JIRA_API_TOKEN),
  call(t, env, method, p, body) {
    const auth = Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString('base64');
    return request(`${jira.base(t, env)}${p}`, { method, body, headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } });
  },
  async search(t, env, max = 200) {
    const sprintField = t.sprintField || 'customfield_10020';
    const fields = ['summary', 'priority', 'status', 'labels', 'description', 'created', sprintField].join(',');
    const out = [];
    let next = '';
    do {
      const q = new URLSearchParams({ jql: t.jql, fields, maxResults: '100' });
      if (next) q.set('nextPageToken', next);
      const data = await jira.call(t, env, 'GET', `/rest/api/3/search/jql?${q}`);
      for (const i of data.issues || []) {
        const sprints = i.fields?.[sprintField];
        const open = Array.isArray(sprints) ? sprints.filter((s) => s.state !== 'closed').sort((a, b) => Date.parse(a.endDate || 0) - Date.parse(b.endDate || 0))[0] : null;
        out.push({ key: i.key, summary: i.fields?.summary || '', priority: i.fields?.priority?.name || null, description: adfToText(i.fields?.description).trim(), due: open?.endDate || null, url: `${jira.base(t, env)}/browse/${i.key}` });
      }
      next = data.nextPageToken || '';
    } while (next && out.length < max);
    return out;
  },
  async comments(t, env, key) {
    const data = await jira.call(t, env, 'GET', `/rest/api/3/issue/${encodeURIComponent(key)}/comment?orderBy=created&maxResults=100`);
    return (data.comments || []).map((c) => ({ id: c.id, by: c.author?.displayName || 'unknown', at: c.created, text: adfToText(c.body).trim() }));
  },
  async postComment(t, env, key, text) {
    const data = await jira.call(t, env, 'POST', `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { body: textToAdf(text) });
    return { id: data?.id || null };
  },
  url: (t, env, key) => (jira.base(t, env) ? `${jira.base(t, env)}/browse/${key}` : null),
};

// ---- Asana -----------------------------------------------------------------
const asana = {
  name: 'Asana',
  secrets: ['ASANA_TOKEN'],
  base: (t) => (t.baseUrl || 'https://app.asana.com/api/1.0').replace(/\/+$/, ''),
  configured: (t, env) => Boolean(env.ASANA_TOKEN && t.projectGid),
  call: (t, env, method, p, body) => request(`${asana.base(t)}${p}`, { method, body, headers: { Authorization: `Bearer ${env.ASANA_TOKEN}`, Accept: 'application/json' } }),
  async search(t, env, max = 200) {
    if (!t.projectGid) throw new Error('Asana needs tracker.projectGid in akaw.config.json');
    const out = [];
    let offset = '';
    do {
      const q = new URLSearchParams({ completed_since: 'now', limit: '100', opt_fields: 'name,notes,due_on,permalink_url,custom_fields.name,custom_fields.display_value' });
      if (offset) q.set('offset', offset);
      const data = await asana.call(t, env, 'GET', `/projects/${t.projectGid}/tasks?${q}`);
      for (const task of data.data || []) {
        const pf = (task.custom_fields || []).find((f) => f.name === (t.priorityField || 'Priority'));
        out.push({ key: task.gid, summary: task.name || '', priority: normPriority(pf?.display_value), description: task.notes || '', due: task.due_on || null, url: task.permalink_url || null });
      }
      offset = data.next_page?.offset || '';
    } while (offset && out.length < max);
    return out;
  },
  async comments(t, env, key) {
    const data = await asana.call(t, env, 'GET', `/tasks/${key}/stories?opt_fields=type,resource_subtype,text,created_at,created_by.name`);
    return (data.data || []).filter((s) => s.resource_subtype === 'comment_added' || s.type === 'comment')
      .map((s) => ({ id: s.gid, by: s.created_by?.name || 'unknown', at: s.created_at, text: s.text || '' }));
  },
  async postComment(t, env, key, text) {
    const data = await asana.call(t, env, 'POST', `/tasks/${key}/stories`, { data: { text } });
    return { id: data?.data?.gid || null };
  },
  url: (t, env, key) => `https://app.asana.com/0/${t.projectGid || 0}/${key}`,
};

// ---- monday.com (GraphQL) --------------------------------------------------
const ITEM_FIELDS = 'id name url created_at column_values { id text type column { title } }';
const monday = {
  name: 'Monday',
  secrets: ['MONDAY_TOKEN'],
  configured: (t, env) => Boolean(env.MONDAY_TOKEN && t.boardId),
  async gql(t, env, query, variables) {
    const headers = { Authorization: env.MONDAY_TOKEN };
    if (t.apiVersion) headers['API-Version'] = t.apiVersion;
    const data = await request(t.baseUrl || 'https://api.monday.com/v2', { method: 'POST', headers, body: { query, variables } });
    if (data?.errors?.length || data?.error_message) throw new Error(`Monday: ${data.error_message || data.errors.map((e) => e.message).join('; ')}`);
    return data.data;
  },
  col: (item, title) => (item.column_values || []).find((c) => c.column?.title === title)?.text || null,
  async search(t, env, max = 500) {
    if (!t.boardId) throw new Error('Monday needs tracker.boardId in akaw.config.json');
    const done = (t.doneLabels || ['Done']).map((s) => s.toLowerCase());
    const out = [];
    let page = (await monday.gql(t, env, `query ($board: [ID!]) { boards(ids: $board) { items_page(limit: 100) { cursor items { ${ITEM_FIELDS} } } } }`, { board: [String(t.boardId)] })).boards?.[0]?.items_page;
    while (page) {
      for (const item of page.items || []) {
        const status = monday.col(item, t.statusColumn || 'Status');
        if (status && done.includes(status.toLowerCase())) continue;
        out.push({ key: String(item.id), summary: item.name || '', priority: normPriority(monday.col(item, t.priorityColumn || 'Priority')), description: t.descriptionColumn ? monday.col(item, t.descriptionColumn) || '' : '', due: t.dateColumn ? monday.col(item, t.dateColumn) : null, url: item.url || null });
      }
      if (!page.cursor || out.length >= max) break;
      page = (await monday.gql(t, env, `query ($cursor: String!) { next_items_page(limit: 100, cursor: $cursor) { cursor items { ${ITEM_FIELDS} } } }`, { cursor: page.cursor })).next_items_page;
    }
    return out;
  },
  async comments(t, env, key) {
    const d = await monday.gql(t, env, 'query ($ids: [ID!]) { items(ids: $ids) { updates(limit: 100) { id text_body created_at creator { name } } } }', { ids: [String(key)] });
    return (d.items?.[0]?.updates || []).map((u) => ({ id: String(u.id), by: u.creator?.name || 'unknown', at: u.created_at, text: u.text_body || '' }));
  },
  async postComment(t, env, key, text) {
    const body = String(text).split('\n').map((l) => l.replace(/&/g, '&amp;').replace(/</g, '&lt;')).join('<br>');
    const d = await monday.gql(t, env, 'mutation ($item: ID!, $body: String!) { create_update(item_id: $item, body: $body) { id } }', { item: String(key), body });
    return { id: d.create_update?.id || null };
  },
  url: () => null,
};

const none = {
  name: 'Task',
  secrets: [],
  configured: () => false,
  search: async () => { throw new Error('No task tracker set. Choose jira, asana or monday in akaw.config.json.'); },
  comments: async () => [],
  postComment: async () => { throw new Error('No task tracker set'); },
  url: () => null,
};

export const TRACKERS = { jira, asana, monday, none };

export function tracker(t) {
  const p = TRACKERS[t?.provider || 'none'];
  if (!p) throw new Error(`Unknown tracker "${t.provider}". Use ${Object.keys(TRACKERS).join(', ')}.`);
  return p;
}

// Optional filter on the summary, for boards that mix playables with other work.
export function applyFilter(rows, t) {
  if (!t.summaryFilter) return rows;
  const re = new RegExp(t.summaryFilter, 'i');
  return rows.filter((r) => re.test(r.summary));
}
