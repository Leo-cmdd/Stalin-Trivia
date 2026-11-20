// Akaw dashboard. Vanilla JS, no build step.
const TOKEN = document.querySelector('meta[name="akaw-token"]').content;
const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (t) => (t ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const ago = (t) => {
  if (!t) return '';
  const m = Math.round((Date.now() - Date.parse(t)) / 60000);
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
};

let S = null; // server state
const UI = {
  cardId: null,
  assetId: null,
  start: { title: '', gameId: '', idea: '', overrides: {}, kit: [], showProject: false },
  libFilters: { q: '', gameId: '', kind: '', level: '', status: '' },
  scanId: null,
  onboard: { step: 1, clientId: '', gameId: '', gameName: '', newClient: '', scanId: null, from: '', keep: [] },
};

async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', 'x-akaw-token': TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

function toast(msg, err = false) {
  const el = document.createElement('div');
  el.className = `toast${err ? ' err' : ''}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), err ? 7000 : 3200);
}

async function act(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    await refresh();
    return r;
  } catch (e) {
    toast(e.message, true);
    return null;
  }
}

const gameName = (id) => S.games.find((g) => g.id === id)?.name || id || 'no game';
const stageOf = (id) => S.stages.find((s) => s.id === id);
const statusPill = (c) => {
  const map = { 'needs-you': ['gate', 'needs you'], blocked: ['bad', 'blocked'], running: ['warn', 'running'], waiting: ['wait', 'waiting'], done: ['ok', 'done'], idle: ['', 'ready'] };
  const [cls, label] = map[c.status] || ['', c.status];
  return `<span class="pill ${cls}">${esc(label)}</span>`;
};
const statusClass = { resolved: 'ok', confirmed: 'ok', 'from-guardrails': 'ok', 'to-confirm': 'warn', asked: 'gate', flagged: 'warn', blocked: 'bad' };
const sevClass = { block: 'bad', 'needs-signoff': 'gate', warn: 'warn' };

// ---------------------------------------------------------------- routing
function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return { view: parts[0] || 'board', arg: parts[1] ? decodeURIComponent(parts[1]) : null };
}

async function refresh() {
  S = await api('GET', '/api/state');
  await render();
}

async function render() {
  const { view, arg } = route();
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === view || (view === 'game' && a.dataset.nav === 'games')));
  renderSideFoot();
  const fn = VIEWS[view] || VIEWS.board;
  const keepScroll = window.scrollY;
  const html = await fn(arg);
  if (html != null) $('#main').innerHTML = html;
  window.scrollTo(0, keepScroll);
  AFTER[view]?.(arg);
  if (UI.cardId) await renderCardDrawer(UI.cardId);
  else if (UI.assetId) await renderAssetDrawer(UI.assetId);
}

function renderSideFoot() {
  const P = S.providers;
  const p = (name, on) => `<span class="pill ${on ? 'ok' : ''}">${esc(name)} ${on ? 'on' : 'off'}</span>`;
  $('#side-foot').innerHTML = `
    <div>${P.tracker.provider === 'none' ? '<span class="pill">no tracker</span>' : p(P.tracker.name, P.tracker.configured)}</div>
    <div>${P.chat.length ? P.chat.map((c) => p(c.name.replace('Microsoft ', '').split(' (')[0], c.configured)).join(' ') : '<span class="pill">no chat</span>'}</div>
    <div><span class="pill ${P.allowWrites ? 'bad' : 'wait'}">writes ${P.allowWrites ? 'LIVE' : 'dry-run'}</span></div>
    ${P.problems.length || P.configError ? '<div><a href="#/settings" class="pill bad" style="text-decoration:none">config problem</a></div>' : ''}
    <div class="muted">You: <b>${esc(S.settings.operator)}</b></div>`;
}

const TN = () => S.providers.tracker.name;

window.addEventListener('hashchange', () => { const next = UI.openAfterNav || null; UI.openAfterNav = null; closeDrawer(); UI.cardId = next; render(); });

// ---------------------------------------------------------------- views
const VIEWS = {};
const AFTER = {};

VIEWS.board = () => {
  const cards = S.cards;
  const byStage = {};
  for (const c of cards) (byStage[c.stage] ||= []).push(c);
  const order = new Map(S.queue.map((id, i) => [id, i]));
  const kcard = (c) => `
    <button class="kcard s-${esc(c.status)}" data-act="open-card" data-id="${esc(c.id)}" title="${esc(c.needs || '')}">
      <span class="t">${c.pinned ? '📌 ' : ''}${c.hold ? '⏸ ' : ''}${esc(c.title)}</span>
      <span class="m"><span class="mono">${esc(c.id)}</span><span class="pill">${esc(c.tier)}</span>${statusPill(c)}<span>${esc(gameName(c.gameId))}</span></span>
    </button>`;
  const stageBox = (sid) => {
    const st = stageOf(sid);
    const list = (byStage[sid] || []).sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
    const shown = sid === 'done' ? list.slice(-6) : list;
    return `<section class="stage ${st.kind}">
      <div class="stage-head"><div><strong>${esc(st.label)}</strong><small>${esc(st.note)}</small></div><span class="count">${list.length || ''}</span></div>
      ${shown.map(kcard).join('')}
      ${sid === 'done' && list.length > 6 ? `<span class="muted small">+${list.length - 6} more</span>` : ''}
    </section>`;
  };
  const open = S.batches.find((b) => b.status === 'open');
  const sealed = S.batches.filter((b) => b.status === 'sealed');
  const qcards = S.queue.map((id) => cards.find((c) => c.id === id)).filter(Boolean);
  return `
    <div class="toolbar">
      <div class="row">
        <h1>Board</h1>
        <span class="chip">Open <b>${S.counts.open}</b></span>
        <span class="chip">Needs you <b>${S.counts.needsYou}</b></span>
        <span class="chip">Blocked <b>${S.counts.blocked}</b></span>
        <span class="chip">Done <b>${S.counts.done}</b></span>
      </div>
      <div class="row">
        <button data-act="tracker-preview" ${S.providers.tracker.configured ? '' : `disabled title="Set the ${esc(TN())} keys in .env and the tracker in akaw.config.json"`}>Sync ${esc(TN())} (preview)</button>
        <button data-act="seal-batch" ${open?.cards?.length ? '' : 'disabled'}>Seal batch${open?.cards?.length ? ` ${esc(open.id)} (${open.cards.length})` : ''}</button>
        <button class="primary" data-act="run-queue" title="Works queued cards ${S.settings.concurrency || 3} at a time, each until it needs you. Stops before publishing.">Run queue</button>
      </div>
    </div>
    ${sealed.map((b) => `
      <div class="callout gate" style="margin-bottom:12px">
        <b>Deploy gate · batch ${esc(b.id)}</b> · ${b.cards.length} card(s): ${b.cards.map(esc).join(', ')}.
        Run the production deploy yourself${b.deployCommand ? `: <code>${esc(b.deployCommand)}</code>` : ' (set AKAW_CMD_DEPLOY to show the command here)'}.
        <button class="gate" data-act="deployed" data-id="${esc(b.id)}" style="margin-left:8px">I ran the deploy</button>
      </div>`).join('')}
    <div class="board-wrap">
      <div>
        <div class="flow">${S.boardRows.map((row) => `<div class="flow-row">${row.map(stageBox).join('')}</div>`).join('')}</div>
        <div class="legend">
          <span><span class="dot" style="background:var(--gate)"></span>your yes</span>
          <span><span class="dot" style="background:var(--bad)"></span>blocked by a rule</span>
          <span><span class="dot" style="background:var(--wait)"></span>waiting (batch, reviewers)</span>
          <span><span class="dot" style="background:var(--accent)"></span>running</span>
          <span>Notes from reviewers come back as a P0 card at the front of the queue.</span>
        </div>
      </div>
      <aside class="panel queue">
        <h2>Queue</h2>
        <p class="muted small" style="margin-top:-6px">P0 feedback fix · P1 close out · P2 new variant · P3 new mechanic. Then task priority, sprint end or due date, longest wait.</p>
        ${qcards.length ? `<ol>${qcards.map(kcard).join('')}</ol>` : '<div class="empty">Nothing queued. <a href="#/start">Start a playable</a>.</div>'}
      </aside>
    </div>`;
};

// ---- Start a playable
VIEWS.start = () => {
  const st = UI.start;
  if (!st.gameId && S.games[0]) st.gameId = S.games[0].id;
  return `
    <div class="toolbar"><h1>Start a playable</h1><span class="muted">Type the idea. The spec and the guardrail check update as you type.</span></div>
    <div class="grid2">
      <form class="panel" data-form="start-card" id="start-form">
        <label>Game</label>
        <select name="gameId" data-live>${S.games.map((g) => `<option value="${esc(g.id)}" ${g.id === st.gameId ? 'selected' : ''}>${esc(g.name)} · ${esc(S.clients.find((c) => c.id === g.clientId)?.name || '')}</option>`).join('')}</select>
        <label>Title (put RT in the title only for RT cards)</label>
        <input name="title" value="${esc(st.title)}" placeholder="Winter Klondike prize climb" data-live>
        <label>The idea, in plain words</label>
        <textarea name="idea" rows="6" data-live placeholder="Solitaire Cash, 30 seconds. The player clears a short Klondike board and a prize counter climbs. Winter look.">${esc(st.idea)}</textarea>
        <h3>Kit from the library</h3>
        <label class="inline"><input type="checkbox" data-act="toggle-project" ${st.showProject ? 'checked' : ''}> include Project assets (needs a tick)</label>
        <div id="kit-picker" class="small muted">Loading…</div>
        <div style="margin-top:14px;display:flex;gap:8px;align-items:center">
          <button class="primary" id="start-btn" type="submit">Start</button>
          <span class="muted small" id="start-hint"></span>
        </div>
      </form>
      <div id="spec-preview"><div class="panel muted">Type an idea to see the spec.</div></div>
    </div>`;
};
AFTER.start = () => { loadKit(); previewSpec(); };

let previewTimer = null;
document.addEventListener('input', (e) => {
  if (e.target.closest('#start-form') && e.target.matches('[data-live]')) {
    const f = $('#start-form');
    UI.start.title = f.title.value;
    UI.start.idea = f.idea.value;
    if (UI.start.gameId !== f.gameId.value) { UI.start.gameId = f.gameId.value; UI.start.kit = []; loadKit(); }
    clearTimeout(previewTimer);
    previewTimer = setTimeout(previewSpec, 220);
  }
});

async function loadKit() {
  const el = $('#kit-picker');
  if (!el) return;
  const q = new URLSearchParams({ gameId: UI.start.gameId, limit: '200' });
  const { assets } = await api('GET', `/api/assets?${q}`);
  const list = assets.filter((a) => a.status !== 'retired' && (UI.start.showProject || a.level !== 'Project'));
  el.innerHTML = list.length
    ? list.map((a) => `<label class="inline"><input type="checkbox" data-act="kit-toggle" value="${esc(a.id)}" ${UI.start.kit.includes(a.id) ? 'checked' : ''}> ${esc(a.name)} <span class="pill">${esc(a.kind)}</span> <span class="pill ${a.level === 'Project' ? 'warn' : 'ok'}">${esc(a.level)}</span></label>`).join('')
    : `<div class="empty">No ${UI.start.showProject ? '' : 'Library '}assets for this game yet. <a href="#/library">Scan some links</a>.</div>`;
}

async function previewSpec() {
  const box = $('#spec-preview');
  if (!box) return;
  const st = UI.start;
  if (!st.idea.trim()) { box.innerHTML = '<div class="panel muted">Type an idea to see the spec.</div>'; updateStartButton(null); return; }
  try {
    const p = await api('POST', '/api/spec/preview', { text: st.idea, gameId: st.gameId, title: st.title, overrides: st.overrides, kit: st.kit });
    box.innerHTML = specPanel(p.spec, { questions: true, scope: 'start' }) + guardrailPanel(p.guardrails) + (p.credit.needed ? `<div class="panel callout warn">${esc(p.credit.note)}</div>` : '');
    updateStartButton(p);
  } catch (e) { box.innerHTML = `<div class="panel callout bad">${esc(e.message)}</div>`; }
}

function updateStartButton(p) {
  const btn = $('#start-btn'); const hint = $('#start-hint');
  if (!btn) return;
  if (!p) { btn.disabled = true; hint.textContent = 'Write the idea first.'; return; }
  const blocked = p.guardrails.blocked.length;
  btn.disabled = blocked > 0 || !UI.start.title.trim();
  hint.textContent = blocked ? `Blocked by ${p.guardrails.blocked.map((r) => r.ruleId).join(', ')}` : !UI.start.title.trim() ? 'Add a title.' : p.spec.questions.length ? `${p.spec.questions.length} open question(s): the card will wait at Brief until answered.` : 'Ready. Start hands it to the flow.';
}

function specPanel(spec, { questions = false, scope = 'card', cardId = '' } = {}) {
  const rows = Object.entries(spec.fields).map(([k, f]) => `
    <tr><td>${esc(fieldLabel(k))}</td><td>${esc(f.label ?? '—')}${f.note ? `<div class="muted small">${esc(f.note)}</div>` : ''}</td><td><span class="pill ${statusClass[f.status] || ''}">${esc(f.status)}</span></td></tr>`).join('');
  const qs = questions && spec.questions.length ? `
    <form data-form="answers" data-scope="${scope}" data-id="${esc(cardId)}" class="callout gate" style="margin-top:10px">
      <b>Asked, never guessed</b>
      ${spec.questions.map((q) => `<label>${esc(q.question)}</label>${q.options && q.options.length
        ? `<select name="${esc(q.field)}"><option value="">choose…</option>${q.options.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}</select>`
        : `<input name="${esc(q.field)}" placeholder="${q.field === 'prize' ? 'approved figure, e.g. 50' : ''}">`}`).join('')}
      <div style="margin-top:10px"><button class="gate" type="submit">Save answers</button></div>
    </form>` : '';
  return `<div class="panel"><h2>Scene Spec</h2><table><thead><tr><th>Field</th><th>Value</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>
    ${spec.copy?.length ? `<p class="small muted">Copy checked: ${spec.copy.map((c) => `“${esc(c)}”`).join(' · ')}</p>` : ''}
    ${qs}</div>`;
}
const fieldLabel = (k) => ({ game: 'Game', archetype: 'Archetype', core: 'Core and template', length: 'Length', prize: 'Prize figure', winLine: 'Win line', route: 'Route', needsArt: 'AI art' }[k] || k);

function guardrailPanel(g, { showAll = false } = {}) {
  if (!g) return '';
  const items = g.results.filter((r) => showAll || r.outcome !== 'pass');
  const row = (r) => `<tr>
    <td><span class="pill ${r.outcome === 'fail' ? sevClass[r.severity] : r.outcome === 'excepted' ? 'wait' : r.outcome === 'manual' ? '' : 'ok'}">${esc(r.outcome === 'fail' ? r.severity : r.outcome)}</span></td>
    <td><b class="mono">${esc(r.ruleId)}</b> <span class="muted small">${esc(r.scope)}</span><div>${esc(r.message)}</div>${r.exception ? `<div class="small muted">Exception: ${esc(r.exception.approver)}, ${esc(r.exception.date)}</div>` : ''}</td></tr>`;
  const head = g.blocked.length ? `<div class="callout bad"><b>Blocked.</b> ${g.blocked.map((r) => esc(r.ruleId)).join(', ')}</div>`
    : `<div class="callout ok"><b>No block.</b> ${g.needsSignoff.length ? `${g.needsSignoff.length} tick(s) at concept lock.` : ''} ${g.warnings.length ? `${g.warnings.length} warning(s).` : ''}</div>`;
  return `<div class="panel"><h2>Guardrails</h2>${head}
    ${items.length ? `<table style="margin-top:8px"><tbody>${items.map(row).join('')}</tbody></table>` : ''}
    <p class="small muted">${g.results.length} rules apply (team, client, channel, game). ${g.manual.length} need human review.</p></div>`;
}

// ---- Card drawer
async function renderCardDrawer(id) {
  let data;
  try { data = await api('GET', `/api/cards/${encodeURIComponent(id)}`); } catch (e) { toast(e.message, true); closeDrawer(); return; }
  const { card: c, kit, game } = data;
  const st = stageOf(c.stage);
  const idx = S.stages.findIndex((s) => s.id === c.stage);
  const earlier = S.stages.slice(0, idx).filter((s) => !['done'].includes(s.id));
  const gateRec = Object.entries(c.gates || {}).filter(([k]) => !k.endsWith('_previous'));
  $('#drawer').innerHTML = `
    <div class="drawer-head">
      <div>
        <div class="muted mono">${esc(c.id)}${c.taskKey ? ` · ${esc(TN())} ${c.taskUrl ? `<a href="${esc(c.taskUrl)}" target="_blank" rel="noopener">${esc(c.taskKey)}</a>` : esc(c.taskKey)}` : ''} · v${c.version}</div>
        <h1>${esc(c.title)}</h1>
        <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">
          <span class="pill ${st.kind === 'gate' ? 'gate' : ''}">${esc(st.label)}</span>${statusPill(c)}<span class="pill">${esc(c.tier)} · ${esc(S.tiers[c.tier])}</span><span class="pill">${esc(gameName(c.gameId))}</span>
        </div>
      </div>
      <button data-act="close-drawer" aria-label="Close">✕</button>
    </div>
    ${c.needs ? `<div class="callout ${c.status === 'blocked' ? 'bad' : c.status === 'needs-you' ? 'gate' : ''}" style="margin-bottom:12px"><b>${c.status === 'blocked' ? 'Blocked' : c.status === 'needs-you' ? 'Needs you' : 'Waiting'}:</b> ${esc(c.needs)}</div>` : ''}
    <div class="row" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
      ${['done'].includes(c.stage) || st.kind === 'gate' ? '' : `<button class="primary" data-act="run-card" data-id="${esc(c.id)}">Run</button>`}
      <button data-act="queue-set" data-id="${esc(c.id)}" data-k="pinned" data-v="${!c.pinned}">${c.pinned ? 'Unpin' : 'Pin'}</button>
      <button data-act="queue-set" data-id="${esc(c.id)}" data-k="hold" data-v="${!c.hold}">${c.hold ? 'Release hold' : 'Hold'}</button>
      <select data-act-change="retier" data-id="${esc(c.id)}" style="width:auto">
        <option value="">tier: auto (${esc(c.tier)})</option>
        ${Object.entries(S.tiers).map(([k, v]) => `<option value="${k}" ${c.tierOverride === k ? 'selected' : ''}>${k} ${esc(v)}</option>`).join('')}
      </select>
    </div>
    ${stagePanel(c)}
    ${c.spec ? specPanel(c.spec, { questions: c.stage === 'brief' || c.stage === 'prep', cardId: c.id }) : ''}
    ${['intake', 'prep', 'brief', 'draft', 'concept_lock'].includes(c.stage) ? `
      <form class="panel" data-form="edit-spec" data-id="${esc(c.id)}">
        <h2>Idea</h2>
        ${c.stage === 'prep' && !c.gameId ? `<label>Game</label><select name="gameId"><option value="">choose…</option>${S.games.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('')}</select>` : ''}
        <textarea name="idea" rows="4">${esc(c.idea)}</textarea>
        <div style="margin-top:8px"><button type="submit">Update spec</button> <span class="muted small">A new version is an edit to the text or the spec.</span></div>
      </form>` : ''}
    ${c.checks ? guardrailPanel(c.checks) : ''}
    ${c.feedback?.length ? `<div class="panel"><h2>Feedback to fix</h2>${c.feedback.map((f) => `<div class="callout warn" style="margin-bottom:6px"><b>${esc(f.by)}</b> (v${f.version}): ${esc(f.text)}</div>`).join('')}</div>` : ''}
    <div class="panel">
      <h2>Card</h2>
      <dl class="kv">
        <dt>Draft</dt><dd>${c.artifacts.draftUrl ? `<a href="${esc(c.artifacts.draftUrl)}" target="_blank" rel="noopener">${esc(c.artifacts.draftUrl)}</a>` : '—'} ${c.artifacts.screenshots.length ? `· ${c.artifacts.screenshots.length} screenshot(s)` : ''}</dd>
        <dt>Build</dt><dd class="mono">${esc(c.artifacts.buildPath || '—')}</dd>
        <dt>Play link</dt><dd>${c.artifacts.playLink ? `<a href="${esc(c.artifacts.playLink)}" target="_blank" rel="noopener">${esc(c.artifacts.playLink)}</a>` : '—'}</dd>
        <dt>Credits</dt><dd>${c.credits.ceiling == null ? 'no ceiling yet' : `${c.credits.spent} of ${c.credits.ceiling}${S.settings.creditUsdRate ? ` ($${(c.credits.spent * S.settings.creditUsdRate).toFixed(2)})` : ''}`}</dd>
        <dt>Kit</dt><dd>${kit.length ? kit.map((a) => `${esc(a.name)} <span class="pill">${esc(a.level)}</span>`).join(', ') : '—'}</dd>
        <dt>Batch</dt><dd>${esc(c.batchId || '—')}</dd>
        <dt>Priority</dt><dd>${esc(c.priority || '—')}${c.sprintEnd ? ` · sprint ends ${esc(fmtTime(c.sprintEnd))}` : ''}</dd>
        <dt>Your yeses</dt><dd>${gateRec.length ? gateRec.map(([g, r]) => `<div><b>${esc(stageOf(g)?.label || g)}</b> · ${esc(r.by)} · ${esc(fmtTime(r.at))}${r.creditCeiling != null ? ` · ceiling ${r.creditCeiling}` : ''}${r.route ? ` · ${esc(r.route)}` : ''}</div>`).join('') : '—'}</dd>
      </dl>
    </div>
    ${c.qa ? `<div class="panel"><h2>QA</h2><p class="small">${c.qa.filesRead} file(s) read, ${(c.qa.bytes / 1048576).toFixed(2)} MB, ${c.qa.copyLines} copy line(s).</p>${c.qa.notes.map((n) => `<div class="callout warn small" style="margin-bottom:4px">${esc(n)}</div>`).join('')}${c.qa.overCap.map((n) => `<div class="callout bad small">Over cap: ${esc(n)}</div>`).join('')}</div>` : ''}
    ${(c.previews || []).length ? `<div class="panel"><h2>Preview</h2><div style="display:flex;gap:12px;flex-wrap:wrap">${c.previews.map((p) => `<figure style="margin:0">${p.gif ? `<img src="/run-file?p=${encodeURIComponent(p.gif)}" alt="${esc(p.orientation)} preview" style="max-height:260px;border-radius:8px;border:1px solid var(--line)">` : '<div class="empty">no GIF</div>'}<figcaption class="small muted">${esc(p.orientation)}${p.mp4 ? ` · <a href="/run-file?p=${encodeURIComponent(p.mp4)}" target="_blank">mp4</a>` : ''}</figcaption></figure>`).join('')}</div></div>` : ''}
    ${c.exportReceipt ? `<div class="panel"><h2>Export receipt</h2><p class="small muted">${esc(c.exportReceipt.note)} · ${esc(c.exportReceipt.fingerprint || 'no fingerprint')}</p><table><thead><tr><th>Network</th><th>Route</th><th>Length</th><th>File</th></tr></thead><tbody>${c.exportReceipt.files.map((f) => `<tr><td>${esc(f.network)}</td><td>${esc(f.route)}</td><td>${f.length}s</td><td class="mono">${esc(f.file)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${c.commandRuns?.length ? `<div class="panel"><h2>Flow command runs</h2>${c.commandRuns.slice(-4).reverse().map((r) => `<div class="small"><b>${esc(r.stage)}</b> exit ${r.code} · ${esc(fmtTime(r.at))}</div><pre class="out">${esc(r.output || '(no output)')}</pre>`).join('')}</div>` : ''}
    ${earlier.length && c.stage !== 'done' ? `
      <form class="panel" data-form="send-back" data-id="${esc(c.id)}">
        <h2>Send back</h2>
        <div style="display:flex;gap:8px"><select name="stage">${earlier.map((s) => `<option value="${s.id}">${esc(s.label)}</option>`).join('')}</select><input name="note" placeholder="why"><button type="submit">Send back</button></div>
      </form>` : ''}
    <div class="panel"><h2>Log</h2><div class="log">${c.log.slice().reverse().map((l) => `<div><span class="muted">${esc(fmtTime(l.at))}</span> · <b>${esc(stageOf(l.stage)?.label || l.stage)}</b> · ${esc(l.msg)} <span class="muted">(${esc(l.by)})</span></div>`).join('')}</div></div>`;
  $('#drawer-wrap').hidden = false;
}

function stagePanel(c) {
  const id = esc(c.id);
  const rate = S.settings.creditUsdRate;
  switch (c.stage) {
    case 'draft':
      return `<form class="panel" data-form="attach" data-id="${id}"><h2>Attach the draft</h2>
        <p class="small muted">${S.providers.steps.draft.runner !== 'manual' ? `Run uses ${esc(S.providers.steps.draft.describe)}, or attach by hand:` : 'No draft runner set, so attach the real draft by hand.'}</p>
        <label>Draft link</label><input name="draftUrl" value="${esc(c.artifacts.draftUrl || '')}" placeholder="https://…">
        <label>Screenshots (paths or links, comma separated)</label><input name="screenshots" value="${esc(c.artifacts.screenshots.join(', '))}">
        <div style="margin-top:10px"><button class="primary" type="submit">Attach and run</button></div></form>`;
    case 'concept_lock': {
      const ticks = c.checks?.needsSignoff || [];
      const art = c.spec?.fields?.needsArt?.value;
      return `<form class="panel callout gate" data-form="gate" data-gate="concept_lock" data-id="${id}">
        <h2>Concept lock</h2>
        <p>Judge it on the real draft: ${c.artifacts.draftUrl ? `<a href="${esc(c.artifacts.draftUrl)}" target="_blank" rel="noopener">open draft</a>` : 'no link'} ${c.artifacts.screenshots.length ? `· screenshots: ${c.artifacts.screenshots.map(esc).join(', ')}` : ''}</p>
        ${c.gates?.concept_lock_previous ? `<p class="small muted">Previously locked by ${esc(c.gates.concept_lock_previous.by)} on ${esc(fmtTime(c.gates.concept_lock_previous.at))} (v${c.gates.concept_lock_previous.version}).</p>` : ''}
        ${ticks.length ? `<b>Ticks needed</b>${ticks.map((t) => `<label class="inline"><input type="checkbox" name="ticks" value="${esc(t.ruleId)}"> ${esc(t.message)}</label>`).join('<br>')}` : ''}
        ${art ? `<label>Credit ceiling for the Art agent (one number)</label><input name="creditCeiling" type="number" min="0" step="1" required>${rate ? `<div class="small muted">$${rate} per credit</div>` : '<div class="small muted">No $ rate set: credits show as credits.</div>'}` : '<p class="small">No AI art in this spec, so no credits.</p>'}
        <label>Note</label><input name="note">
        <div style="margin-top:10px"><button class="gate" type="submit">Yes: lock the concept</button></div></form>`;
    }
    case 'art': {
      const gens = S.providers.generators;
      const f = c.spec?.fields || {};
      const suggested = `${f.archetype?.label || ''} playable art for ${gameName(c.gameId)}. ${c.idea || ''}`.trim();
      const left = (c.credits.ceiling ?? 0) - c.credits.spent;
      return `<div class="panel"><h2>Art</h2>
        <p class="small">Ceiling ${c.credits.ceiling ?? 0} credits · spent ${+c.credits.spent.toFixed(2)} · left ${+left.toFixed(2)}. Every generation passes the credit hook first. Phones in AI footage are green screens; people are ordinary adults, 25 to 60.</p>
        ${gens.length ? `<form data-form="generate" data-id="${id}" class="callout">
          <b>Generate</b>
          <div class="grid3" style="margin-top:6px">
            <select name="generatorId">${gens.map((g) => `<option value="${esc(g.id)}" ${g.configured ? '' : 'disabled'}>${esc(g.label)} · ${esc(g.providerName)}${g.costPerOutput != null ? ` · ${g.costPerOutput} ${g.unit === 'usd' ? '$' : 'cr'}/output` : ''}${g.configured ? '' : ' (not configured)'}</option>`).join('')}</select>
            <input name="n" type="number" min="1" max="8" value="1" title="outputs">
            <input name="estimate" type="number" min="0" step="0.1" placeholder="estimate (credits), if no price on file">
          </div>
          <label>Prompt</label><textarea name="prompt" rows="3">${esc(suggested)}</textarea>
          <div style="margin-top:8px"><button class="primary" type="submit">Generate inside the ceiling</button></div>
        </form>` : '<p class="small muted">No generators set in akaw.config.json, so generate elsewhere and record the credits below.</p>'}
        ${(c.generations || []).length ? `<h3>Generated</h3>${c.generations.map((g) => `<div class="small">${esc(fmtTime(g.at))} · ${esc(g.generator)} · ${g.assets.length} file(s) · ${g.credits} cr · “${esc(g.prompt.slice(0, 90))}”</div>`).join('')}` : ''}
        <h3>Record credits spent elsewhere</h3>
        <form data-form="credits" data-id="${id}" style="display:flex;gap:8px"><input name="credits" type="number" min="1" placeholder="credits"><input name="note" placeholder="what for"><button type="submit">Record</button></form>
        ${c.credits.entries.length ? `<div class="log" style="margin-top:8px">${c.credits.entries.map((e) => `<div>${esc(fmtTime(e.at))} · ${e.credits} · ${esc(e.note)}</div>`).join('')}</div>` : ''}
        <div style="margin-top:10px"><button class="primary" data-act="art-done" data-id="${id}">Art done</button></div></div>`;
    }
    case 'build':
    case 'qa':
      return `<form class="panel" data-form="attach" data-id="${id}"><h2>${c.stage === 'qa' ? 'Fix and re-run QA' : 'Attach the build'}</h2>
        <p class="small muted">A local file or folder (the unzipped bundle). QA reads its copy, checks guardrails, secrets and size caps${S.providers.steps.qa.runner !== 'manual' ? `, then runs ${esc(S.providers.steps.qa.describe)}` : ''}.${S.providers.steps.build.runner !== 'manual' && c.stage === 'build' ? ` Run uses ${esc(S.providers.steps.build.describe)}.` : ''}</p>
        <label>Build path</label><input name="buildPath" value="${esc(c.artifacts.buildPath || '')}" placeholder="/Users/you/…/build/index.html">
        <div style="margin-top:10px"><button class="primary" type="submit">Attach and run</button></div></form>`;
    case 'batch_link':
      return `<div class="panel callout"><b>In batch ${esc(c.batchId || '…')}.</b> Cards stop here so they go out in one batch with one deploy. Seal the batch on the board.</div>`;
    case 'deploy':
      return `<div class="panel callout gate"><b>Deploy gate.</b> You run the production deploy for batch ${esc(c.batchId)}${S.providers.deployCommand ? `: <code>${esc(S.providers.deployCommand)}</code>` : ''}. Then press <b>I ran the deploy</b> on the board.</div>`;
    case 'link_review': {
      const link = c.artifacts.playLink || '';
      const draft = c.draftComment || `Play Now: ${link || '<play link>'}\n${c.title}${c.taskKey ? ` (${c.taskKey})` : ''}, v${c.version}. Ready for review.`;
      return `<form class="panel callout gate" data-form="gate" data-gate="link_review" data-id="${id}">
        <h2>Link review</h2>
        <p class="small">This exact comment posts to ${esc(TN())} under your name${S.providers.allowWrites ? '' : ' (dry-run: writes are off)'}. Use the catalogue Play Now link, never a preview or tunnel address.</p>
        <label>Play Now link</label><input name="playLink" value="${esc(link)}" placeholder="https://…">
        <label>Exact ${esc(TN())} comment</label><textarea name="comment" rows="4">${esc(draft)}</textarea>
        <div style="margin-top:10px"><button class="gate" type="submit">Yes: post this</button></div></form>`;
    }
    case 'post':
      return '<div class="panel callout">Ready to post the approved comment. Press Run.</div>';
    case 'reviewers':
    case 'triage':
      return `<div class="panel"><h2>Reviewers</h2>
        ${c.posted ? `<p class="small muted">${c.posted.live ? `Posted to ${esc(TN())} ${esc(c.taskKey)} ${esc(fmtTime(c.posted.at))}` : `Dry-run post (${esc(c.posted.why)}). Text: “${esc(c.posted.text)}”`}</p>` : ''}
        ${c.reviews.length ? c.reviews.map((r) => `<div class="callout ${r.raw === 'approved' ? 'ok' : r.raw === 'mixed' ? 'warn' : 'warn'}" style="margin-bottom:6px"><b>${esc(r.by)}</b> <span class="pill">${esc(r.raw || r.verdict)}</span> ${esc(r.text)}</div>`).join('') : '<p class="muted small">No replies yet.</p>'}
        ${c.stage === 'triage' && c.status === 'needs-you' ? `<div class="callout gate"><b>Mixed replies.</b> <button data-act="resolve" data-id="${id}" data-as="notes">Treat as feedback fix (P0)</button> <button data-act="resolve" data-id="${id}" data-as="approved">Treat as approved</button></div>` : ''}
        <form data-form="review" data-id="${id}" style="margin-top:10px">
          <div class="grid3"><input name="by" placeholder="who replied"><select name="verdict"><option value="">read it for me</option><option value="approved">approved</option><option value="notes">notes</option><option value="mixed">mixed</option></select><span></span></div>
          <textarea name="text" rows="2" placeholder="what they wrote" style="margin-top:6px"></textarea>
          <div style="margin-top:6px;display:flex;gap:8px"><button type="submit">Record reply</button>
          ${S.providers.tracker.configured && c.taskKey ? `<button type="button" data-act="fetch-replies" data-id="${id}">Read replies from ${esc(TN())}</button>` : ''}
          ${c.reviews.length && c.stage === 'reviewers' ? `<button class="primary" type="button" data-act="run-card" data-id="${id}">Triage</button>` : ''}</div>
        </form></div>`;
    case 'close': {
      const proposal = c.closeProposal || 'UA';
      const saysRT = /\bRT\b/.test(c.title);
      return `<form class="panel callout gate" data-form="gate" data-gate="close" data-id="${id}">
        <h2>Close</h2>
        <p class="small">Proposed route: <b>${esc(proposal)}</b>. ${saysRT ? 'The title says RT.' : 'RT is only proposed when the title says RT.'} Exports then ship ${(S.settings.lengths || [15, 30, 59]).map((l) => `${l}s`).join(', ')} for every network on the route, with a receipt; then Slack and Done.</p>
        ${['UA', 'RT', 'both'].map((r) => `<label class="inline"><input type="radio" name="route" value="${r}" ${r === proposal ? 'checked' : ''} ${r !== 'UA' && !saysRT ? 'disabled' : ''}> ${r}</label>`).join('')}
        <div class="small muted" style="margin-top:6px">Networks: ${(S.settings.networks || []).map((n) => `${esc(n.name)} (${(n.routes || []).join('/')})`).join(', ') || 'none set yet: add them in Settings'}</div>
        <div style="margin-top:10px"><button class="gate" type="submit">Yes: close and export</button></div></form>`;
    }
    case 'exports':
      return '<div class="panel callout">Exports run when you press Run.</div>';
    default:
      return '';
  }
}

function closeDrawer() {
  $('#drawer-wrap').hidden = true;
  UI.cardId = null;
  UI.assetId = null;
}

// ---- Library
VIEWS.library = async () => {
  const f = UI.libFilters;
  const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
  const { assets, total } = await api('GET', `/api/assets?${q}`);
  const { scans } = await api('GET', '/api/scans');
  const scan = UI.scanId ? await api('GET', `/api/scans/${UI.scanId}`).catch(() => null) : null;
  const opt = (list, cur, label) => `<option value="">${label}</option>${list.map((v) => `<option value="${esc(v.id ?? v)}" ${(v.id ?? v) === cur ? 'selected' : ''}>${esc(v.name ?? v)}</option>`).join('')}`;
  return `
    <div class="toolbar"><h1>Library</h1><span class="muted">${S.library.count} cards · index by default, hold only what a build needs</span></div>
    <form class="panel" data-form="scan">
      <h2>Scan links</h2>
      <p class="small muted">Paste one or more local folder paths, Google Drive or Box links. Each file becomes a proposed card (Project, candidate). Duplicates collapse by checksum. Folders named like <code>GAME_BUCKET_00017 (Name)</code> are read for the creative ID.</p>
      <textarea name="sources" rows="3" placeholder="/Volumes/your-volume/Art/SC_UA_00042 (Winter)&#10;https://drive.google.com/drive/folders/…"></textarea>
      <div class="grid3" style="margin-top:8px">
        <select name="gameId">${opt(S.games, '', 'game: read from folder names')}</select>
        <select name="clientId">${opt(S.clients, '', 'client: from game')}</select>
        <button class="primary" type="submit">Scan</button>
      </div>
    </form>
    ${scan ? scanReview(scan) : ''}
    ${scans.length ? `<div class="panel"><h2>Scans</h2><table><thead><tr><th>Scan</th><th>When</th><th>Sources</th><th>Files</th><th></th></tr></thead><tbody>${scans.slice(0, 8).map((s) => `<tr><td class="mono">${esc(s.id)}</td><td>${esc(fmtTime(s.at))}</td><td class="small">${s.sources.map(esc).join('<br>')}</td><td>${s.stats.unique ?? 0} unique · ${s.stats.duplicates ?? 0} dup${s.errors.length ? ` · <span class="pill bad">${s.errors.length} error</span>` : ''}</td><td><button data-act="open-scan" data-id="${esc(s.id)}">Review</button> <button data-act="rescan" data-id="${esc(s.id)}">Re-scan</button></td></tr>`).join('')}</tbody></table></div>` : ''}
    <div class="panel">
      <h2>Browse <span class="muted small">${total} match</span></h2>
      <form class="filters" data-form="lib-filters">
        <input name="q" placeholder="search name, folder, creative ID" value="${esc(f.q)}">
        <select name="gameId">${opt(S.games, f.gameId, 'all games')}</select>
        <select name="kind">${opt(S.library.kinds, f.kind, 'all kinds')}</select>
        <select name="level">${opt(S.library.levels, f.level, 'all levels')}</select>
        <select name="status">${opt(S.library.statuses, f.status, 'all statuses')}</select>
        <button type="submit">Filter</button>
      </form>
      ${assets.length ? `<div class="assets">${assets.map(assetTile).join('')}</div>` : '<div class="empty">No cards yet. Scan a folder above.</div>'}
    </div>`;
};

function thumbFor(a) {
  if (a.preview?.thumb) return `<img src="${esc(a.preview.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
  if (a.type === 'image' && a.source?.system === 'local') return `<img src="/preview/${encodeURIComponent(a.id)}" alt="" loading="lazy">`;
  return esc(a.type || a.kind);
}
const assetTile = (a) => `<button class="asset" data-act="open-asset" data-id="${esc(a.id)}">
  <div class="thumb">${thumbFor(a)}</div>
  <div class="body"><div class="n" title="${esc(a.name)}">${esc(a.name)}</div>
  <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px"><span class="pill">${esc(a.kind)}</span><span class="pill ${a.level === 'Library' ? 'ok' : a.level === 'Locked' ? 'gate' : 'warn'}">${esc(a.level)}</span><span class="pill ${a.status === 'retired' ? 'bad' : ''}">${esc(a.status)}</span>${a.held ? '<span class="pill wait">held</span>' : ''}${a.source?.gone ? '<span class="pill bad">gone</span>' : ''}</div></div>
</button>`;

function scanReview(scan) {
  const pending = scan.groups.reduce((n, g) => n + g.items.filter((p) => p.decision === 'pending').length, 0);
  return `<div class="panel">
    <div class="group-head"><h2>Review ${esc(scan.id)}</h2>
      <div style="display:flex;gap:6px">${pending ? `<button class="primary" data-act="accept-all" data-id="${esc(scan.id)}">Accept all ${pending} as indexed</button>` : ''}<button data-act="close-scan">Close</button></div></div>
    <p class="small muted">${scan.stats.files} files · ${scan.stats.unique} unique · ${scan.stats.duplicates} duplicates collapsed · ${scan.stats.alreadyKnown} already in the library · ${scan.stats.unnamedFolders} without a creative ID${scan.gone?.length ? ` · <b>${scan.gone.length} gone since last scan</b>` : ''}</p>
    ${scan.errors.map((e) => `<div class="callout bad small" style="margin-bottom:6px">${esc(e.link)}: ${esc(e.error)}</div>`).join('')}
    ${scan.groups.map((g) => {
      const pend = g.items.filter((p) => p.decision === 'pending');
      return `<div class="group">
        <div class="group-head"><div><b>${esc(g.folder)}</b> ${g.creative ? `<span class="pill gate">${esc(g.creative.creativeId)}${g.creative.creativeName ? ` · ${esc(g.creative.creativeName)}` : ''}</span>` : '<span class="pill warn">no ID: name it</span>'} <span class="muted small">${g.items.length} file(s)</span></div>
        ${pend.length ? `<div style="display:flex;gap:6px"><button data-act="accept-folder" data-id="${esc(scan.id)}" data-folder="${esc(g.folder)}" data-mode="index">Index folder</button><button data-act="accept-folder" data-id="${esc(scan.id)}" data-folder="${esc(g.folder)}" data-mode="hold">Hold folder</button><button data-act="skip-folder" data-id="${esc(scan.id)}" data-folder="${esc(g.folder)}">Skip</button></div>` : ''}</div>
        <table style="margin-top:6px"><tbody>${g.items.slice(0, 40).map((p) => `<tr><td>${esc(p.name)}${p.locations.length ? ` <span class="pill">+${p.locations.length} dup</span>` : ''}</td><td><span class="pill">${esc(p.kind)}</span></td><td class="small muted">${(p.size / 1024).toFixed(0)} KB · ${esc(p.source.checksumKind)}</td><td><span class="pill ${p.decision === 'accepted' ? 'ok' : p.decision === 'known' ? 'wait' : p.decision === 'skipped' ? '' : 'gate'}">${esc(p.decision)}</span></td></tr>`).join('')}${g.items.length > 40 ? `<tr><td colspan="4" class="muted small">+${g.items.length - 40} more</td></tr>` : ''}</tbody></table>
      </div>`;
    }).join('')}
  </div>`;
}

async function renderAssetDrawer(id) {
  const { assets } = await api('GET', `/api/assets?limit=100000`);
  const a = assets.find((x) => x.id === id);
  if (!a) { closeDrawer(); return; }
  const locked = a.level === 'Locked';
  $('#drawer').innerHTML = `
    <div class="drawer-head"><div><div class="muted mono">${esc(a.id)}</div><h1>${esc(a.name)}</h1></div><button data-act="close-drawer">✕</button></div>
    <div class="panel"><div class="thumb" style="height:220px;display:grid;place-items:center;background:var(--panel-2);border-radius:8px;overflow:hidden">${thumbFor(a)}</div></div>
    <div class="panel"><dl class="kv">
      <dt>Kind</dt><dd>${esc(a.kind)} (${esc(a.type)})</dd>
      <dt>Level</dt><dd>${esc(a.level)} · ${esc(a.status)}${a.replacedBy ? ` → use ${esc(a.replacedBy)}` : ''}</dd>
      <dt>Games</dt><dd>${a.gameIds.map((g) => esc(gameName(g))).join(', ') || '—'}</dd>
      <dt>Where it sits</dt><dd class="mono">${esc(a.source.system)} · ${esc(a.source.path || a.source.link)}${a.source.gone ? ' <span class="pill bad">gone</span>' : ''}</dd>
      <dt>Checksum</dt><dd class="mono">${esc(a.source.checksum)}</dd>
      <dt>Held</dt><dd>${a.held ? `yes · ${esc(a.held.key)}` : 'no (index only)'}</dd>
      <dt>Creative</dt><dd>${esc(a.creative?.creativeId || '—')}</dd>
      <dt>Approval</dt><dd>${a.approval ? `${esc(a.approval.by)} · ${esc(fmtTime(a.approval.at))} ${esc(a.approval.note)}` : '—'}</dd>
      <dt>Duplicates</dt><dd>${a.locations?.length || 0}</dd>
    </dl></div>
    ${locked ? '<div class="panel callout gate">Locked: used exactly as is. Only its owner changes it, outside Akaw.</div>' : `
    <form class="panel" data-form="asset-edit" data-id="${esc(a.id)}">
      <h2>Card</h2>
      <div class="grid2"><div><label>Kind</label><select name="kind">${S.library.kinds.map((k) => `<option ${k === a.kind ? 'selected' : ''}>${esc(k)}</option>`).join('')}</select></div>
      <div><label>Games</label><select name="gameIds" multiple size="3">${S.games.map((g) => `<option value="${esc(g.id)}" ${a.gameIds.includes(g.id) ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></div></div>
      <label>Use it for</label><input name="useFor" value="${esc(a.useFor)}">
      <label>Don't</label><input name="dont" value="${esc(a.dont)}">
      <label>Tags (comma separated)</label><input name="tags" value="${esc((a.tags || []).join(', '))}">
      <label>Guardrail flags (reviewer)</label>${S.library.flags.map((f) => `<label class="inline"><input type="checkbox" name="flags" value="${f}" ${(a.flags || []).includes(f) ? 'checked' : ''}> ${f}</label>`).join('')}
      <div style="margin-top:10px"><button type="submit">Save</button></div>
    </form>
    <div class="panel">
      <h2>Level</h2>
      ${a.level === 'Project' ? `<form data-form="promote" data-id="${esc(a.id)}" style="display:flex;gap:8px"><input name="by" placeholder="who approved it" required><input name="note" placeholder="where it is noted (PR, Jira)"><button class="gate" type="submit">Promote to Library</button></form>` : ''}
      ${!a.held && a.source.system === 'local' ? `<button data-act="hold-asset" data-id="${esc(a.id)}" style="margin-top:8px">Hold a copy (pinned by checksum)</button>` : ''}
      ${a.status !== 'retired' ? `<form data-form="retire" data-id="${esc(a.id)}" style="display:flex;gap:8px;margin-top:8px"><input name="replacedBy" placeholder="replaced by (asset id, optional)"><button class="danger" type="submit">Retire</button></form>` : ''}
      ${a.usedBy?.length ? `<p class="small">Used by: ${a.usedBy.map(esc).join(', ')}</p>` : ''}
    </div>`}`;
  $('#drawer-wrap').hidden = false;
}

// ---- Clients and games
VIEWS.games = () => `
  <div class="toolbar"><h1>Clients &amp; games</h1><div class="row"><a class="btn" href="#/onboard">Onboard a game</a></div></div>
  ${S.clients.map((cl) => {
    const games = S.games.filter((g) => g.clientId === cl.id);
    return `<div class="panel"><h2>${esc(cl.name)} <span class="muted small">${games.length} game(s)</span></h2>
      ${games.length ? `<div class="tiles">${games.map((g) => {
        const st = S.gameStats[g.id] || {};
        return `<a class="tile" href="#/game/${esc(g.id)}"><b>${esc(g.name)}</b><div class="stats"><span>${st.assets || 0} assets</span><span>${st.rules || 0} active rules</span><span>${st.openCards || 0} open cards</span><span>scan: ${st.lastScan ? esc(ago(st.lastScan)) + ' ago' : 'never'}</span></div></a>`;
      }).join('')}</div>` : '<div class="empty">No games yet. Onboard one through the same path.</div>'}</div>`;
  }).join('')}
  <form class="panel" data-form="client"><h2>Add a client</h2><div class="grid3"><input name="name" placeholder="Client name"><input name="id" placeholder="id (lowercase-dashes)"><button type="submit">Add client</button></div></form>`;

VIEWS.game = async (id) => {
  const g = S.games.find((x) => x.id === id);
  if (!g) return '<div class="pad">Game not found.</div>';
  const { rules } = await api('GET', '/api/rules');
  const scopes = ['team', `client:${g.clientId}`, `game:${g.id}`, 'channel:UA', 'channel:RT'];
  const applies = rules.filter((r) => (r.status || 'active') === 'active' && scopes.includes(r.scope));
  const cards = S.cards.filter((c) => c.gameId === g.id);
  const list = (v) => esc((v || []).join(', '));
  return `
    <div class="toolbar"><h1>${esc(g.name)}</h1><span class="muted">${esc(S.clients.find((c) => c.id === g.clientId)?.name)}</span></div>
    <div class="grid2">
      <form class="panel" data-form="game" data-id="${esc(g.id)}">
        <h2>Profile</h2>
        <input type="hidden" name="clientId" value="${esc(g.clientId)}">
        <label>Name</label><input name="name" value="${esc(g.name)}">
        <label>Other names in briefs (aliases)</label><input name="aliases" value="${list(g.aliases)}">
        <label>Folder codes (the GAME in GAME_BUCKET_NNNNN)</label><input name="codes" value="${list(g.codes)}" placeholder="e.g. SC">
        <label>Approved prize figures (only these can be on screen)</label><input name="approvedPrizes" value="${list(g.approvedPrizes)}" placeholder="from approved cards only">
        <label>Win line</label><input name="winLine" value="${esc(g.winLine)}">
        <label>Legal lines (exact text, one per line; checked word for word at QA)</label><textarea name="legalLines" rows="3">${esc((g.legalLines || []).join('\n'))}</textarea>
        <label>Required elements</label><input name="requiredElements" value="${list(g.requiredElements)}">
        <div class="grid2"><div><label>Palette</label><input name="palette" value="${list(g.palette)}"></div><div><label>Fonts</label><input name="fonts" value="${list(g.fonts)}"></div></div>
        <div class="grid2"><div><label>Store badges</label><input name="badges" value="${list(g.badges)}"></div><div><label>Reviewers</label><input name="reviewers" value="${list(g.reviewers)}"></div></div>
        <h3>Cores and templates</h3>
        <div id="cores">${(g.cores || []).map((c, i) => coreRow(c, i)).join('')}</div>
        <button type="button" data-act="add-core">Add core</button>
        <div style="margin-top:12px"><button class="primary" type="submit">Save profile</button></div>
      </form>
      <div>
        <div class="panel"><h2>Rules that apply <span class="muted small">${applies.length}</span></h2>
          <table><tbody>${applies.map((r) => `<tr><td><span class="pill ${sevClass[r.severity]}">${esc(r.severity)}</span></td><td><b class="mono">${esc(r.id)}</b> <span class="muted small">${esc(r.scope)}</span><div>${esc(r.rule)}</div><div class="small muted">from ${esc(r.source)}${r.owner ? ` · owner ${esc(r.owner)}` : ' · no owner'}</div>${r.confirm ? `<div class="small" style="color:var(--warn)">To confirm: ${esc(r.confirm)}</div>` : ''}</td></tr>`).join('')}</tbody></table>
          <p class="small"><a href="#/rules">Edit guardrails</a></p></div>
        <div class="panel"><h2>Library</h2><p>${S.gameStats[g.id]?.assets || 0} asset cards. <a href="#/library" data-act="lib-game" data-id="${esc(g.id)}">Browse</a></p></div>
        <div class="panel"><h2>Creatives <span class="muted small">${cards.length}</span></h2>${cards.length ? cards.map((c) => `<div><button class="link" data-act="open-card" data-id="${esc(c.id)}">${esc(c.id)} ${esc(c.title)}</button> <span class="pill">${esc(stageOf(c.stage).label)}</span></div>`).join('') : '<div class="empty">None yet.</div>'}</div>
      </div>
    </div>`;
};
const coreRow = (c, i) => `<div class="grid3" data-core="${i}" style="margin-bottom:6px"><input name="core_name_${i}" value="${esc(c.name || '')}" placeholder="Core name, e.g. Klondike"><input name="core_keywords_${i}" value="${esc((c.keywords || []).join(', '))}" placeholder="words in briefs that mean this core"><input name="core_template_${i}" value="${esc(c.template || '')}" placeholder="template (optional)"></div>`;

// ---- Onboard a game
VIEWS.onboard = async () => {
  const o = UI.onboard;
  const steps = ['Client and game', 'Paste links', 'Review cards', 'Rules', 'Reviewers'];
  const head = `<div class="toolbar"><h1>Onboard a game</h1></div><div class="steps">${steps.map((s, i) => `<span class="${o.step === i + 1 ? 'on' : ''}">${i + 1}. ${s}</span>`).join('')}</div>`;
  if (o.step === 1) {
    return `${head}<form class="panel" data-form="ob1">
      <label>Client</label><select name="clientId"><option value="">new client…</option>${S.clients.map((c) => `<option value="${esc(c.id)}" ${c.id === o.clientId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      <label>New client name (if new)</label><input name="newClient" value="${esc(o.newClient)}">
      <label>Game name</label><input name="gameName" value="${esc(o.gameName)}" required>
      <label>Closest existing game (to compare and to copy rules from)</label><select name="from"><option value="">none</option>${S.games.map((g) => `<option value="${esc(g.id)}" ${g.id === o.from ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select>
      <div style="margin-top:12px"><button class="primary" type="submit">Next</button></div></form>`;
  }
  if (o.step === 2) {
    return `${head}<form class="panel" data-form="ob2"><p>Paste the links that hold ${esc(o.gameName)}'s assets. The scan returns a starter library.</p>
      <textarea name="sources" rows="4" placeholder="local folder paths, Drive or Box links"></textarea>
      <div style="margin-top:12px;display:flex;gap:8px"><button class="primary" type="submit">Scan</button><button type="button" data-act="ob-skip">Skip for now</button></div></form>`;
  }
  if (o.step === 3) {
    const scan = o.scanId ? await api('GET', `/api/scans/${o.scanId}`).catch(() => null) : null;
    return `${head}${scan ? scanReview(scan) : '<div class="panel muted">No scan.</div>'}<div class="panel"><button class="primary" data-act="ob-next">Next: rules</button></div>`;
  }
  if (o.step === 4) {
    const { rules } = await api('GET', '/api/rules');
    const from = rules.filter((r) => r.scope === `game:${o.from}` && (r.status || 'active') === 'active');
    const inherited = rules.filter((r) => (r.status || 'active') === 'active' && ['team', `client:${o.clientId}`].includes(r.scope));
    return `${head}<form class="panel" data-form="ob4">
      <h2>Inherited (team and client)</h2><p class="small muted">Nothing is inherited silently. These apply to ${esc(o.gameName)}:</p>
      <table><tbody>${inherited.map((r) => `<tr><td class="mono">${esc(r.id)}</td><td>${esc(r.rule)}</td></tr>`).join('')}</tbody></table>
      <h2 style="margin-top:14px">From ${esc(gameName(o.from) || 'the closest game')}: keep or drop</h2>
      ${from.length ? from.map((r) => `<label class="inline"><input type="checkbox" name="keep" value="${esc(r.id)}" checked> <b class="mono">${esc(r.id)}</b> ${esc(r.rule)}</label><br>`).join('') : '<p class="muted">No game-level rules to copy.</p>'}
      <p class="small muted">Change a kept rule after onboarding on the Guardrails page. Add the game's own rules there too.</p>
      <div style="margin-top:12px"><button class="primary" type="submit">Next</button></div></form>`;
  }
  return `${head}<form class="panel" data-form="ob5"><label>Reviewers for ${esc(o.gameName)} (comma separated)</label><input name="reviewers">
    <label>Approved prize figures (from approved cards only)</label><input name="approvedPrizes">
    <div style="margin-top:12px"><button class="primary" type="submit">Finish</button></div></form>`;
};

// ---- Guardrails
VIEWS.rules = async () => {
  const { rules, lessons } = await api('GET', '/api/rules');
  const layers = [['team', 'Team'], ['client', 'Client'], ['channel', 'Channel'], ['game', 'Game or app'], ['creative', 'Creative']];
  const byLayer = (l) => rules.filter((r) => r.scope.split(':')[0] === l);
  const confirmCount = rules.filter((r) => r.confirm && (r.status || 'active') === 'active').length;
  const meta = S.rulesMeta;
  return `
    <div class="toolbar"><h1>Guardrails</h1><span class="muted">Four layers. A lower layer can only add or tighten. Loosening is an exception on one creative, with approver and date.</span></div>
    ${confirmCount ? `<div class="callout warn" style="margin-bottom:12px"><b>${confirmCount} rule(s) need your confirmation</b> (scope or owner unknown). They run as written until you confirm or change them.</div>` : ''}
    <div class="grid2">
      <div>
        ${layers.map(([l, label]) => {
          const list = byLayer(l);
          return `<div class="panel"><h2>${label} <span class="muted small">${list.length}</span></h2>${list.length ? `<table><tbody>${list.map((r) => `
            <tr style="${r.status === 'retired' ? 'opacity:.5' : ''}"><td><span class="pill ${sevClass[r.severity]}">${esc(r.severity)}</span></td>
            <td><b class="mono">${esc(r.id)}</b> <span class="muted small">${esc(r.scope)}</span>${r.status === 'retired' ? ' <span class="pill">retired</span>' : ''}
              <div>${esc(r.rule)}</div><div class="small muted">${esc(r.describe)} · from ${esc(r.source)} · ${r.owner ? `owner ${esc(r.owner)}` : 'no owner'}</div>
              ${r.confirm ? `<div class="small" style="color:var(--warn)">To confirm: ${esc(r.confirm)} <button class="link" data-act="rule-confirm" data-id="${esc(r.id)}">confirm as written</button></div>` : ''}
              ${(r.exceptions || []).map((e) => `<div class="small">Exception ${esc(e.creative)} · ${esc(e.approver)} · ${esc(e.date)} ${esc(e.note)}</div>`).join('')}
              <div class="small"><button class="link" data-act="rule-owner" data-id="${esc(r.id)}">set owner</button> · <button class="link" data-act="rule-exception" data-id="${esc(r.id)}">add exception</button>${l !== 'team' && r.status !== 'retired' ? ` · <button class="link" data-act="rule-retire" data-id="${esc(r.id)}">retire</button>` : ''}</div>
            </td></tr>`).join('')}</tbody></table>` : '<div class="empty">None.</div>'}</div>`;
        }).join('')}
      </div>
      <div>
        <form class="panel" data-form="rule-test"><h2>Test copy</h2>
          <select name="gameId">${S.games.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('')}</select>
          <textarea name="text" rows="4" placeholder="One line of copy per line" style="margin-top:6px"></textarea>
          <div class="grid3" style="margin-top:6px"><select name="route"><option>UA</option><option>RT</option></select><input name="lengthSeconds" type="number" placeholder="length s"><button type="submit">Check</button></div>
          <div id="rule-test-out"></div>
        </form>
        <form class="panel" data-form="rule-add"><h2>Add a rule</h2>
          <div class="grid2"><div><label>id</label><input name="id" placeholder="sc-no-xyz" required></div><div><label>scope</label><input name="scope" placeholder="team, client:papaya, game:solitaire-cash, channel:RT" required></div></div>
          <label>Rule, in words</label><input name="rule" required>
          <div class="grid2"><div><label>Severity</label><select name="severity">${meta.severities.map((s) => `<option>${s}</option>`).join('')}</select></div>
          <div><label>Check</label><select name="kind">${meta.checkKinds.map((k) => `<option>${k}</option>`).join('')}</select></div></div>
          <label>Phrases or elements (comma separated) / seconds for max-length</label><input name="arg">
          <div class="grid2"><div><label>Source</label><input name="source"></div><div><label>Owner</label><input name="owner"></div></div>
          <div style="margin-top:10px"><button class="primary" type="submit">Add rule</button></div></form>
        <div class="panel"><h2>Lessons</h2>${lessons.map((l) => `<div class="callout ${l.status === 'candidate' ? 'warn' : ''}" style="margin-bottom:6px"><b>${esc(l.status)}</b> · ${esc(l.text)}<div class="small muted">proposed by ${esc(l.proposedBy)}</div>${l.status === 'candidate' ? `<div style="margin-top:6px"><button data-act="lesson" data-id="${esc(l.id)}" data-d="adopt">Adopt</button> <button data-act="lesson" data-id="${esc(l.id)}" data-d="reject">Reject</button></div>` : ''}</div>`).join('') || '<div class="empty">None.</div>'}</div>
      </div>
    </div>`;
};

// ---- Audit
VIEWS.audit = async () => {
  const { entries } = await api('GET', '/api/audit?limit=400');
  return `<div class="toolbar"><h1>Audit</h1><span class="muted">Every yes, credit quote, scan, generation and post, with who and when.</span></div>
    <div class="panel"><table><thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr></thead><tbody>
    ${entries.map((e) => { const { ts, actor, action, ...rest } = e; return `<tr><td class="small">${esc(fmtTime(ts))}</td><td>${esc(actor)}</td><td><span class="pill ${action.startsWith('gate.') ? 'gate' : action.includes('dry-run') ? 'wait' : action.includes('refused') || action.includes('blocked') ? 'bad' : ''}">${esc(action)}</span></td><td class="small mono">${esc(JSON.stringify(rest)).slice(0, 300)}</td></tr>`; }).join('')}
    </tbody></table></div>`;
};

// ---- Settings
VIEWS.settings = () => {
  const s = S.settings; const P = S.providers;
  const pill = (on, yes = 'configured', no = 'off') => `<span class="pill ${on ? 'ok' : ''}">${on ? yes : no}</span>`;
  return `
    <div class="toolbar"><h1>Settings</h1></div>
    ${P.configError || P.problems.length ? `<div class="callout bad" style="margin-bottom:12px"><b>akaw.config.json</b>: ${[P.configError, ...P.problems].filter(Boolean).map(esc).join('<br>')}</div>` : ''}
    <div class="grid2">
      <div>
      <form class="panel" data-form="settings">
        <h2>Operator</h2>
        <label>Your name (every yes is recorded under it)</label><input name="operator" value="${esc(s.operator)}">
        <label>$ per credit (converts $-priced generators; empty: credits show as credits)</label><input name="creditUsdRate" type="number" step="0.0001" value="${esc(s.creditUsdRate ?? '')}">
        <label>Run queue: cards at a time</label><input name="concurrency" type="number" min="1" max="6" value="${esc(s.concurrency || 3)}">
        <h3>Networks</h3>
        <p class="small muted">Exports ship ${(s.lengths || []).join('s, ')}s for every network on the route. Set each network's size cap from its spec; QA checks the bundle against it.</p>
        <table><thead><tr><th>Network</th><th>UA</th><th>RT</th><th>Cap MB</th></tr></thead><tbody id="nets">
          ${(s.networks || []).map((n, k) => netRow(n, k)).join('')}${netRow({ name: '', routes: ['UA'], sizeCapMB: '' }, (s.networks || []).length)}
        </tbody></table>
        <div style="margin-top:12px"><button class="primary" type="submit">Save settings</button></div>
      </form>
      <div class="panel"><h2>Toolbox <button class="link small" data-act="toolbox-refresh">check again</button></h2><div id="toolbox" class="small muted">Checking this machine…</div></div>
      </div>
      <div>
        <div class="panel"><h2>Task tracker</h2>
          <p><b>${esc(P.tracker.provider === 'none' ? 'None set' : P.tracker.name)}</b> ${P.tracker.provider === 'none' ? '' : pill(P.tracker.configured)}</p>
          <p class="small muted">Options: ${P.tracker.options.map(esc).join(', ')}. Choose in akaw.config.json; keys in .env (${P.tracker.needs.map((n) => `<code>${esc(n)}</code>`).join(', ') || '—'}).</p>
          ${Object.entries(P.tracker.details).filter(([, v]) => v).map(([k, v]) => `<div class="small">${esc(k)}: <code>${esc(v)}</code></div>`).join('')}</div>
        <div class="panel"><h2>Chat</h2>
          ${P.chat.length ? `<table><tbody>${P.chat.map((c) => `<tr><td>${esc(c.name)}</td><td>${pill(c.configured)}</td><td class="small">${(c.events || []).map(esc).join(', ')}</td><td class="small mono">${c.needs.map(esc).join(', ')}</td></tr>`).join('')}</tbody></table>` : '<p class="small muted">No chat targets.</p>'}
          <p class="small muted">Options: ${P.chatOptions.map(esc).join(', ')}. Events: ${P.chatEvents.map(esc).join(', ')}. Writes are <b>${P.allowWrites ? 'LIVE' : 'dry-run'}</b> (AKAW_ALLOW_WRITES).</p></div>
        <div class="panel"><h2>Flow steps</h2><p class="small muted">Each step runs by hand, as a command, as Claude Code headless, as an n8n webhook, or (preview) as built-in capture.</p>
          <dl class="kv">${Object.entries(P.steps).map(([k, v]) => `<dt>${esc(k)}</dt><dd class="small">${esc(v.describe)}</dd>`).join('')}
          <dt>deploy</dt><dd class="small mono">${esc(P.deployCommand || 'not set')} <span class="muted">(shown, never run)</span></dd>
          <dt>flow repo</dt><dd class="small mono">${esc(P.flowRepo || 'not set')}</dd></dl></div>
        <div class="panel"><h2>Art generators</h2>
          ${P.generators.length ? `<table><tbody>${P.generators.map((g) => `<tr><td><b>${esc(g.label)}</b><div class="small muted">${esc(g.providerName)}${g.model ? ` · ${esc(g.model)}` : ''}</div></td><td>${pill(g.configured)}</td><td class="small">${g.costPerOutput != null ? `${g.costPerOutput} ${g.unit === 'usd' ? '$' : 'credits'} / output` : 'no price: estimate per run'}</td><td class="small mono">${g.needs.map(esc).join(', ')}</td></tr>`).join('')}</tbody></table>` : '<p class="small muted">None. Add fal, Replicate, Google AI Studio, n8n, a command or Claude Code in akaw.config.json.</p>'}</div>
        <div class="panel"><h2>Library sources</h2><p class="small">Local folders ${pill(true, 'always')} · Google Drive ${pill(P.drive.configured)} · Box ${pill(P.box.configured)}</p></div>
      </div>
    </div>`;
};
AFTER.settings = () => loadToolbox(false);

async function loadToolbox(refresh) {
  const el = $('#toolbox');
  if (!el) return;
  try {
    const { tools } = await api('GET', `/api/toolbox${refresh ? '?refresh=1' : ''}`);
    el.innerHTML = `<table><tbody>${tools.map((t) => `<tr><td><b>${esc(t.label)}</b></td><td><span class="pill ${t.available ? 'ok' : ''}">${t.available ? 'yes' : 'no'}</span></td><td class="small">${esc(t.for)}${t.version && t.version !== 'present' ? `<div class="muted mono">${esc(t.version)}</div>` : ''}${t.note ? `<div class="muted">${esc(t.note)}</div>` : ''}</td></tr>`).join('')}</tbody></table>`;
  } catch (e) { el.textContent = e.message; }
}
const netRow = (n, k) => `<tr><td><input name="net_name_${k}" value="${esc(n.name)}" placeholder="add network"></td><td><input type="checkbox" name="net_ua_${k}" ${(n.routes || []).includes('UA') ? 'checked' : ''}></td><td><input type="checkbox" name="net_rt_${k}" ${(n.routes || []).includes('RT') ? 'checked' : ''}></td><td><input name="net_cap_${k}" type="number" step="0.1" value="${esc(n.sizeCapMB ?? '')}" placeholder="?"></td></tr>`;

// ---------------------------------------------------------------- actions
const ACTIONS = {
  'open-card': async (el) => { UI.cardId = el.dataset.id; UI.assetId = null; await renderCardDrawer(UI.cardId); },
  'close-drawer': () => closeDrawer(),
  'close-modal': () => { $('#modal-wrap').hidden = true; },
  'run-card': (el) => act(() => api('POST', `/api/cards/${el.dataset.id}/run`)),
  'run-queue': async (el) => {
    el.disabled = true;
    const r = await act(() => api('POST', '/api/queue/run'));
    if (r) toast(r.ran.length ? `Worked ${r.ran.length} card(s): ${r.ran.map((x) => `${x.id} → ${stageOf(x.stage).label}`).join(', ')}` : 'Nothing runnable. Cards are waiting on you, held or at a gate.');
  },
  'seal-batch': () => act(() => api('POST', '/api/batches/seal'), 'Batch sealed. Run the deploy, then confirm on the board.'),
  deployed: (el) => {
    const typed = prompt(`You ran the production deploy for batch ${el.dataset.id}? Type DEPLOYED to confirm.`);
    if (typed == null) return;
    act(() => api('POST', `/api/batches/${el.dataset.id}/deployed`, { confirm: typed.trim() }), 'Deploy recorded. Cards moved to link review.');
  },
  'queue-set': (el) => act(() => api('POST', `/api/cards/${el.dataset.id}/queue`, { [el.dataset.k]: el.dataset.v === 'true' })),
  'art-done': async (el) => { if (await act(() => api('POST', `/api/cards/${el.dataset.id}/art-done`))) await act(() => api('POST', `/api/cards/${el.dataset.id}/run`)); },
  resolve: (el) => act(() => api('POST', `/api/cards/${el.dataset.id}/resolve`, { as: el.dataset.as })),
  'fetch-replies': (el) => act(() => api('POST', `/api/cards/${el.dataset.id}/fetch-replies`)).then((r) => r && toast(`${r.added} new repl(ies)`)),
  'toggle-project': (el) => { UI.start.showProject = el.checked; loadKit(); },
  'kit-toggle': (el) => {
    const k = UI.start.kit;
    if (el.checked) { if (!k.includes(el.value)) k.push(el.value); } else UI.start.kit = k.filter((x) => x !== el.value);
    previewSpec();
  },
  'toolbox-refresh': () => loadToolbox(true),
  'tracker-preview': async () => {
    try {
      const p = await api('POST', '/api/tracker/preview');
      $('#modal').innerHTML = `<div class="drawer-head"><h1>${esc(TN())} sync preview</h1><button data-act="close-modal">✕</button></div>
        <p class="muted">Read-only. Nothing enters the flow until you import. ${p.rows.length} open card(s); ${p.rows.filter((r) => !r.cardId).length} new.</p>
        <form data-form="tracker-import"><table><thead><tr><th></th><th>Task</th><th>Summary</th><th>Priority</th><th>Game</th><th>Sprint end / due</th></tr></thead><tbody>
        ${p.rows.map((r) => `<tr><td>${r.cardId ? `<span class="pill ok">${esc(r.cardId)}</span>` : `<input type="checkbox" name="keys" value="${esc(r.key)}" checked>`}</td><td class="mono">${esc(r.key)}</td><td>${esc(r.summary)}</td><td>${esc(r.priority || '')}</td><td>${r.gameGuess ? esc(gameName(r.gameGuess)) : `<span class="pill warn">${esc(r.gameQuestion ? 'ask' : '?')}</span>`}</td><td>${esc(fmtTime(r.due))}</td></tr>`).join('')}
        </tbody></table><div style="margin-top:12px"><button class="primary" type="submit">Import selected</button></div></form>`;
      $('#modal-wrap').hidden = false;
    } catch (e) { toast(e.message, true); }
  },
  'open-asset': async (el) => { UI.assetId = el.dataset.id; UI.cardId = null; await renderAssetDrawer(UI.assetId); },
  'open-scan': (el) => { UI.scanId = el.dataset.id; render(); },
  'close-scan': () => { UI.scanId = null; render(); },
  rescan: async (el) => { const s = await act(() => api('POST', `/api/scans/${el.dataset.id}/rescan`), 'Re-scanned'); if (s) { UI.scanId = s.id; render(); } },
  'accept-all': (el) => act(() => api('POST', `/api/scans/${el.dataset.id}/accept`, { folders: [...document.querySelectorAll('[data-act="accept-folder"][data-mode="index"]')].map((b) => b.dataset.folder), mode: 'index' }), 'Accepted'),
  'accept-folder': (el) => act(() => api('POST', `/api/scans/${el.dataset.id}/accept`, { folders: [el.dataset.folder], mode: el.dataset.mode }), el.dataset.mode === 'hold' ? 'Held' : 'Indexed'),
  'skip-folder': (el) => act(() => api('POST', `/api/scans/${el.dataset.id}/skip`, { folders: [el.dataset.folder] })),
  'hold-asset': (el) => act(() => api('POST', `/api/assets/${encodeURIComponent(el.dataset.id)}/hold`), 'Held'),
  'lib-game': (el) => { UI.libFilters.gameId = el.dataset.id; },
  'add-core': () => { const box = $('#cores'); const i = box.children.length; box.insertAdjacentHTML('beforeend', coreRow({}, i)); },
  'rule-confirm': (el) => act(() => api('POST', `/api/rules/${el.dataset.id}/meta`, { confirmed: true }), 'Confirmed as written'),
  'rule-owner': (el) => { const o = prompt('Owner of this rule'); if (o != null) act(() => api('POST', `/api/rules/${el.dataset.id}/meta`, { owner: o }), 'Owner set'); },
  'rule-retire': (el) => { if (confirm(`Retire ${el.dataset.id}?`)) act(() => api('POST', `/api/rules/${el.dataset.id}/retire`), 'Retired'); },
  'rule-exception': (el) => {
    const creative = prompt('Exception for which card (e.g. AK-0007)?'); if (!creative) return;
    const approver = prompt('Who approved it?'); if (!approver) return;
    const date = prompt('When (YYYY-MM-DD)?', new Date().toISOString().slice(0, 10)); if (!date) return;
    const note = prompt('Note (optional)') || '';
    act(() => api('POST', `/api/rules/${el.dataset.id}/exceptions`, { creative: creative.trim(), approver, date, note }), 'Exception recorded');
  },
  lesson: (el) => act(() => api('POST', `/api/lessons/${el.dataset.id}/${el.dataset.d}`), el.dataset.d === 'adopt' ? 'Adopted as a rule' : 'Rejected'),
  'ob-skip': () => { UI.onboard.step = 4; render(); },
  'ob-next': () => { UI.onboard.step = 4; render(); },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || !ACTIONS[el.dataset.act]) return;
  if (el.tagName === 'A' && el.dataset.act !== 'lib-game') e.preventDefault();
  if (el.type === 'checkbox') { ACTIONS[el.dataset.act](el, e); return; }
  ACTIONS[el.dataset.act](el, e);
});
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-act-change="retier"]');
  if (el) act(() => api('POST', `/api/cards/${el.dataset.id}/queue`, { tier: el.value || null }));
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeDrawer(); $('#modal-wrap').hidden = true; } });

const csv = (v) => String(v || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);

const FORMS = {
  'start-card': async (f) => {
    const st = UI.start;
    const card = await act(() => api('POST', '/api/cards', { title: st.title, gameId: st.gameId, idea: st.idea, overrides: st.overrides, kit: st.kit }));
    if (!card) return;
    await api('POST', `/api/cards/${card.id}/run`).catch(() => {});
    UI.start = { title: '', gameId: st.gameId, idea: '', overrides: {}, kit: [], showProject: false };
    toast(`${card.id} started`);
    if (route().view === 'board') { UI.cardId = card.id; await refresh(); } else { UI.openAfterNav = card.id; location.hash = '#/board'; }
  },
  answers: async (f, fd) => {
    const overrides = {};
    for (const [k, v] of fd.entries()) if (String(v).trim()) overrides[k] = String(v).trim();
    if (f.dataset.scope === 'start') {
      Object.assign(UI.start.overrides, overrides);
      if (overrides.game) { UI.start.gameId = overrides.game; render(); return; }
      previewSpec();
      return;
    }
    const body = { overrides };
    if (overrides.game) body.gameId = overrides.game;
    await act(() => api('POST', `/api/cards/${f.dataset.id}/spec`, body));
    await act(() => api('POST', `/api/cards/${f.dataset.id}/run`));
  },
  'edit-spec': async (f, fd) => {
    const body = { idea: fd.get('idea') };
    if (fd.get('gameId')) body.gameId = fd.get('gameId');
    await act(() => api('POST', `/api/cards/${f.dataset.id}/spec`, body), 'Spec updated');
  },
  attach: async (f, fd) => {
    const body = Object.fromEntries([...fd.entries()]);
    await act(() => api('POST', `/api/cards/${f.dataset.id}/attach`, body));
    await act(() => api('POST', `/api/cards/${f.dataset.id}/run`));
  },
  gate: async (f, fd) => {
    const body = { ticks: fd.getAll('ticks'), note: fd.get('note') || '' };
    for (const k of ['creditCeiling', 'playLink', 'comment', 'route']) if (fd.has(k)) body[k] = fd.get(k);
    const ok = await act(() => api('POST', `/api/cards/${f.dataset.id}/gate/${f.dataset.gate}`, body), 'Recorded your yes');
    if (ok && f.dataset.gate !== 'deploy') await act(() => api('POST', `/api/cards/${f.dataset.id}/run`));
  },
  generate: async (f, fd) => {
    const btn = f.querySelector('button[type=submit]'); btn.disabled = true; btn.textContent = 'Generating…';
    const r = await act(() => api('POST', `/api/cards/${f.dataset.id}/generate`, { generatorId: fd.get('generatorId'), prompt: fd.get('prompt'), n: fd.get('n'), estimate: fd.get('estimate') || null }));
    if (r) toast(`${r.assets.length} file(s) added to the kit as Project cards`);
    else { btn.disabled = false; btn.textContent = 'Generate inside the ceiling'; }
  },
  credits: (f, fd) => act(() => api('POST', `/api/cards/${f.dataset.id}/credits`, { credits: fd.get('credits'), note: fd.get('note') }), 'Credits recorded'),
  review: (f, fd) => act(() => api('POST', `/api/cards/${f.dataset.id}/review`, { by: fd.get('by'), text: fd.get('text'), verdict: fd.get('verdict') || undefined }), 'Reply recorded'),
  'send-back': (f, fd) => act(() => api('POST', `/api/cards/${f.dataset.id}/send-back`, { stage: fd.get('stage'), note: fd.get('note') }), 'Sent back'),
  'tracker-import': async (f, fd) => {
    const r = await act(() => api('POST', '/api/tracker/import', { keys: fd.getAll('keys') }));
    if (r) { toast(`Imported ${r.created.length} card(s)`); $('#modal-wrap').hidden = true; }
  },
  scan: async (f, fd) => {
    const btn = f.querySelector('button[type=submit]'); btn.disabled = true; btn.textContent = 'Scanning…';
    const s = await act(() => api('POST', '/api/scans', { sources: String(fd.get('sources') || '').split('\n').map((x) => x.trim()).filter(Boolean), gameId: fd.get('gameId') || null, clientId: fd.get('clientId') || null }));
    if (s) { UI.scanId = s.id; render(); } else { btn.disabled = false; btn.textContent = 'Scan'; }
  },
  'lib-filters': (f, fd) => { UI.libFilters = Object.fromEntries(['q', 'gameId', 'kind', 'level', 'status'].map((k) => [k, fd.get(k) || ''])); render(); },
  'asset-edit': (f, fd) => act(() => api('POST', `/api/assets/${encodeURIComponent(f.dataset.id)}`, { kind: fd.get('kind'), gameIds: fd.getAll('gameIds'), useFor: fd.get('useFor'), dont: fd.get('dont'), tags: csv(fd.get('tags')), flags: fd.getAll('flags') }), 'Saved'),
  promote: (f, fd) => act(() => api('POST', `/api/assets/${encodeURIComponent(f.dataset.id)}/promote`, { by: fd.get('by'), note: fd.get('note') }), 'Promoted to Library'),
  retire: (f, fd) => act(() => api('POST', `/api/assets/${encodeURIComponent(f.dataset.id)}/retire`, { replacedBy: fd.get('replacedBy') }), 'Retired'),
  client: (f, fd) => act(() => api('POST', '/api/clients', { id: fd.get('id'), name: fd.get('name') }), 'Client added'),
  game: (f, fd) => {
    const cores = [...f.querySelectorAll('[data-core]')].map((row) => {
      const i = row.dataset.core;
      const name = fd.get(`core_name_${i}`);
      return name ? { id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, keywords: csv(fd.get(`core_keywords_${i}`)), template: fd.get(`core_template_${i}`) || null } : null;
    }).filter(Boolean);
    const body = { id: f.dataset.id, clientId: fd.get('clientId'), name: fd.get('name'), winLine: fd.get('winLine'), cores };
    for (const k of ['aliases', 'codes', 'approvedPrizes', 'requiredElements', 'palette', 'fonts', 'badges', 'reviewers']) body[k] = csv(fd.get(k));
    body.legalLines = String(fd.get('legalLines') || '').split('\n').map((s) => s.trim()).filter(Boolean);
    return act(() => api('POST', '/api/games', body), 'Profile saved');
  },
  'rule-test': async (f, fd) => {
    try {
      const r = await api('POST', '/api/rules/check', { gameId: fd.get('gameId'), text: fd.get('text'), route: fd.get('route'), lengthSeconds: Number(fd.get('lengthSeconds')) || undefined });
      $('#rule-test-out').innerHTML = guardrailPanel(r) + (r.secrets.length ? `<div class="callout bad">Possible secret: ${r.secrets.map((s) => esc(s.type)).join(', ')}</div>` : '');
    } catch (e) { toast(e.message, true); }
  },
  'rule-add': (f, fd) => {
    const kind = fd.get('kind'); const arg = fd.get('arg');
    const check = { kind };
    if (kind === 'forbidden-phrase') check.phrases = csv(arg);
    if (kind === 'required-element' || kind === 'forbidden-element') check.elements = csv(arg);
    if (kind === 'max-length') check.seconds = Number(arg);
    if (kind === 'asset-flag') check.flags = csv(arg);
    if (kind === 'allowed-assets') check.levels = csv(arg).length ? csv(arg) : ['Library', 'Locked'];
    return act(() => api('POST', '/api/rules', { id: fd.get('id'), scope: fd.get('scope'), rule: fd.get('rule'), severity: fd.get('severity'), check, source: fd.get('source') || undefined, owner: fd.get('owner') || '' }), 'Rule added');
  },
  settings: (f, fd) => {
    const networks = [];
    for (let k = 0; fd.has(`net_name_${k}`); k++) {
      const name = String(fd.get(`net_name_${k}`) || '').trim();
      if (!name) continue;
      networks.push({ name, routes: [fd.get(`net_ua_${k}`) ? 'UA' : null, fd.get(`net_rt_${k}`) ? 'RT' : null].filter(Boolean), sizeCapMB: fd.get(`net_cap_${k}`) });
    }
    return act(() => api('POST', '/api/settings', { operator: fd.get('operator'), creditUsdRate: fd.get('creditUsdRate'), concurrency: fd.get('concurrency'), networks }), 'Settings saved');
  },
  ob1: async (f, fd) => {
    const o = UI.onboard;
    o.gameName = String(fd.get('gameName') || '').trim();
    o.from = fd.get('from') || '';
    o.clientId = fd.get('clientId') || '';
    o.newClient = String(fd.get('newClient') || '').trim();
    const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    try {
      if (!o.clientId) {
        if (!o.newClient) throw new Error('Pick a client or name a new one');
        o.clientId = slug(o.newClient);
        await api('POST', '/api/clients', { id: o.clientId, name: o.newClient });
      }
      if (!o.gameName) throw new Error('Name the game');
      o.gameId = slug(o.gameName);
      const from = S.games.find((g) => g.id === o.from);
      await api('POST', '/api/games', { id: o.gameId, name: o.gameName, clientId: o.clientId, requiredElements: from?.requiredElements || ['legal line', 'store badges'], winLine: from?.winLine || 'You Can Win' });
      o.step = 2;
      await refresh();
    } catch (e) { toast(e.message, true); }
  },
  ob2: async (f, fd) => {
    const sources = String(fd.get('sources') || '').split('\n').map((s) => s.trim()).filter(Boolean);
    if (!sources.length) { UI.onboard.step = 4; render(); return; }
    const s = await act(() => api('POST', '/api/scans', { sources, gameId: UI.onboard.gameId, clientId: UI.onboard.clientId }));
    if (s) { UI.onboard.scanId = s.id; UI.onboard.step = 3; render(); }
  },
  ob4: async (f, fd) => {
    const keep = fd.getAll('keep');
    if (UI.onboard.from && keep.length) await act(() => api('POST', '/api/games/copy-rules', { from: UI.onboard.from, to: UI.onboard.gameId, keep }), `Copied ${keep.length} rule(s)`);
    UI.onboard.step = 5; render();
  },
  ob5: async (f, fd) => {
    const o = UI.onboard;
    const g = S.games.find((x) => x.id === o.gameId);
    const ok = await act(() => api('POST', '/api/games', { ...g, reviewers: csv(fd.get('reviewers')), approvedPrizes: csv(fd.get('approvedPrizes')) }), `${o.gameName} onboarded`);
    if (ok) { const id = o.gameId; UI.onboard = { step: 1, clientId: '', gameId: '', gameName: '', newClient: '', scanId: null, from: '', keep: [] }; location.hash = `#/game/${id}`; }
  },
};

document.addEventListener('submit', (e) => {
  const f = e.target;
  if (!f.dataset.form || !FORMS[f.dataset.form]) return;
  e.preventDefault();
  FORMS[f.dataset.form](f, new FormData(f));
});

// Keep the board fresh while cards run.
setInterval(() => {
  const { view } = route();
  if (view === 'board' && !UI.cardId && !document.hidden && $('#modal-wrap').hidden) refresh().catch(() => {});
}, 15000);

refresh().catch((e) => { $('#main').innerHTML = `<div class="pad callout bad">Could not load Akaw: ${esc(e.message)}</div>`; });
