// The engine: moves cards through the 17 steps, stops at your four yeses,
// enforces guardrails and the credit ceiling, and records every yes in the audit log.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { STAGE, STAGES, GATES, STAGE_ALIASES, stageIndex, stagesFor } from './stages.js';
import { parseIdea, specSubject } from './spec.js';
import { evaluate, validateRule, validateException } from './guardrails.js';
import { computeTier, orderQueue, isRunnable } from './queue.js';
import { loadAppConfig } from './appconfig.js';
import { runStep, describeStep } from './runners.js';
import { tracker as trackerFor, applyFilter } from './providers/trackers.js';
import { chat as chatFor } from './providers/chat.js';
import { generate, generatorConfigured, GENERATOR_PROVIDERS } from './generators.js';

const now = () => new Date().toISOString();
const APPROVE_RE = /\b(approved?|lgtm|looks good|good to go|ok to go|ship it|go ahead)\b/i;
const NOTES_RE = /\b(but|please|fix|change|can you|could you|should|add|remove|instead|missing|wrong|swap|move)\b/i;
const TUNNEL_RE = /(trycloudflare\.com|ngrok|loca\.lt|localhost|127\.0\.0\.1|0\.0\.0\.0|\.local\b|preview)/i;
const SLUG = /^[a-z0-9][a-z0-9-]{0,40}$/;

export function classifyReview(text) {
  const t = String(text || '');
  const approves = APPROVE_RE.test(t);
  if (approves && NOTES_RE.test(t.replace(APPROVE_RE, ''))) return 'mixed';
  return approves ? 'approved' : 'notes';
}

export class Flow {
  constructor(store, cfg, library) {
    this.store = store;
    this.cfg = cfg;
    this.library = library;
    this.running = new Set();
    this.lastTaskPreview = null;
    this.app = cfg.app || loadAppConfig({ file: null, env: cfg.env || {} });
    this.trackerConf = this.app.tracker;
    this.tracker = trackerFor(this.trackerConf);
    this.migrate();
  }

  get trackerName() { return this.trackerConf.provider === 'none' ? 'Task' : this.tracker.name; }
  get trackerLive() { return this.tracker.configured(this.trackerConf, this.cfg.env || {}); }

  // Cards saved before trackers were pluggable used jiraKey / jiraPriority and jira stage ids.
  migrate() {
    let changed = false;
    for (const c of this.cards) {
      if (c.jiraKey !== undefined && c.taskKey === undefined) { c.taskKey = c.jiraKey; c.priority = c.jiraPriority ?? null; delete c.jiraKey; delete c.jiraPriority; changed = true; }
      if (STAGE_ALIASES[c.stage]) { c.stage = STAGE_ALIASES[c.stage]; changed = true; }
      for (const l of c.log || []) if (STAGE_ALIASES[l.stage]) l.stage = STAGE_ALIASES[l.stage];
      c.generations ||= [];
    }
    if (changed) this.save();
  }

  // ---- collections --------------------------------------------------------
  get cards() { return this.store.get('cards', []); }
  get games() { return this.store.get('games', []); }
  get clients() { return this.store.get('clients', []); }
  get rules() { return this.store.get('rules', []); }
  get lessons() { return this.store.get('lessons', []); }
  get batches() { return this.store.get('batches', []); }
  get settings() { return this.store.get('settings', {}); }
  get operator() { return this.settings.operator || 'operator'; }

  card(id) {
    const c = this.cards.find((x) => x.id === id);
    if (!c) throw new Error(`Card ${id} not found`);
    return c;
  }

  game(id) { return this.games.find((g) => g.id === id) || null; }
  save() { this.store.save('cards'); }

  log(card, msg, by = 'akaw') {
    card.log.push({ at: now(), stage: card.stage, by, msg });
    if (card.log.length > 300) card.log.splice(0, card.log.length - 300);
    card.updatedAt = now();
  }

  setStage(card, stage, by, msg) {
    card.stage = stage;
    card.enteredStageAt = now();
    card.waitingSince = now();
    card.status = 'idle';
    card.needs = null;
    this.log(card, msg || `→ ${STAGE[stage].label}`, by);
  }

  wait(card, status, needs) {
    card.status = status;
    card.needs = needs;
    card.waitingSince = card.waitingSince || now();
  }

  kitAssets(card) {
    const ids = new Set(card.kit || []);
    return this.library.assets.filter((a) => ids.has(a.id));
  }

  ctx(card) {
    const game = this.game(card.gameId);
    return {
      clientId: game?.clientId || card.clientId || null,
      gameId: card.gameId,
      route: card.gates?.close?.route || card.spec?.fields?.route?.value || 'UA',
      cardId: card.id,
      game,
    };
  }

  evaluateCard(card, extra = {}) {
    const subject = { ...specSubject(card.spec, this.kitAssets(card)), ...extra };
    const res = evaluate(this.rules, subject, this.ctx(card));
    card.checks = { at: now(), stage: card.stage, ...res };
    return res;
  }

  // ---- text to spec -------------------------------------------------------
  specPreview({ text, gameId, title, overrides, kit = [] }) {
    const spec = parseIdea(text, this.games, { gameId, title, overrides });
    const game = this.game(spec.gameId);
    const kitAssets = this.library.assets.filter((a) => kit.includes(a.id));
    const g = evaluate(this.rules, specSubject(spec, kitAssets), {
      clientId: game?.clientId, gameId: spec.gameId, route: spec.fields.route.value, game,
    });
    const rate = this.settings.creditUsdRate;
    return {
      spec,
      guardrails: g,
      requiredTicks: g.needsSignoff.map((r) => ({ id: r.ruleId, label: r.message })),
      credit: spec.fields.needsArt.value
        ? { needed: true, note: `Art is needed: you type one credit ceiling at concept lock${rate ? ` ($${rate} per credit)` : ' (no $ rate set, so credits show as credits)'}.` }
        : { needed: false },
    };
  }

  createCard({ title, gameId, idea = '', overrides = {}, kit = [], taskKey = null, taskUrl = null, priority = null, sprintEnd = null, stage = 'brief' }, by) {
    if (!title || !String(title).trim()) throw new Error('A card needs a title');
    if (stage === 'brief' && !gameId) throw new Error('Pick the game');
    const game = this.game(gameId);
    const card = {
      id: this.store.nextId('AK'),
      title: String(title).trim(),
      gameId: gameId || null,
      clientId: game?.clientId || null,
      idea,
      overrides,
      kit,
      taskKey,
      taskUrl,
      priority,
      sprintEnd,
      stage,
      status: 'idle',
      needs: null,
      createdAt: now(),
      updatedAt: now(),
      enteredStageAt: now(),
      waitingSince: now(),
      createdBy: by,
      pinned: false,
      hold: false,
      tierOverride: null,
      feedbackFix: false,
      version: 1,
      spec: null,
      specHistory: [],
      checks: null,
      gates: {},
      artifacts: { draftUrl: null, screenshots: [], buildPath: null, playLink: null },
      credits: { ceiling: null, spent: 0, entries: [], artDone: false },
      batchId: null,
      reviews: [],
      rounds: [],
      feedback: [],
      posted: null,
      qa: null,
      exportReceipt: null,
      commandRuns: [],
      generations: [],
      previews: [],
      log: [],
    };
    if (idea) card.spec = parseIdea(idea, this.games, { gameId, title, overrides });
    this.cards.push(card);
    this.log(card, `Card created${taskKey ? ` from ${this.trackerName} ${taskKey}` : ''}`, by);
    this.store.audit(by, 'card.create', { cardId: card.id, title: card.title, gameId, taskKey });
    this.save();
    return card;
  }

  updateSpec(id, { idea, overrides, kit, title, gameId }, by) {
    const card = this.card(id);
    if (stageIndex(card.stage) > stageIndex('concept_lock')) throw new Error('The concept is locked. Send the card back to Brief to change the spec.');
    if (card.spec) card.specHistory.push({ at: now(), by, text: card.idea, overrides: card.overrides, fields: card.spec.fields });
    if (title != null) card.title = title;
    if (gameId != null) { card.gameId = gameId; card.clientId = this.game(gameId)?.clientId || null; }
    if (idea != null) card.idea = idea;
    if (overrides) card.overrides = { ...card.overrides, ...overrides };
    if (kit) card.kit = kit;
    card.spec = parseIdea(card.idea, this.games, { gameId: card.gameId, title: card.title, overrides: card.overrides });
    if (card.spec.gameId && !card.gameId) { card.gameId = card.spec.gameId; card.clientId = card.spec.clientId; }
    if (['needs-you', 'blocked'].includes(card.status) && ['brief', 'prep', 'concept_lock'].includes(card.stage)) {
      card.status = 'idle';
      card.needs = null;
    }
    if (card.stage === 'concept_lock') this.setStage(card, 'brief', by, 'Spec edited: back to Brief');
    this.log(card, 'Spec updated', by);
    this.store.audit(by, 'spec.update', { cardId: id, fields: Object.keys(overrides || {}) });
    this.save();
    return card;
  }

  attach(id, patch, by) {
    const card = this.card(id);
    const a = card.artifacts;
    if (patch.draftUrl != null) a.draftUrl = String(patch.draftUrl).trim() || null;
    if (patch.screenshots != null) a.screenshots = (Array.isArray(patch.screenshots) ? patch.screenshots : String(patch.screenshots).split(/[\n,]+/)).map((s) => s.trim()).filter(Boolean);
    if (patch.buildPath != null) a.buildPath = String(patch.buildPath).trim() || null;
    if (patch.playLink != null) a.playLink = String(patch.playLink).trim() || null;
    if (card.status === 'needs-you' && ['draft', 'build'].includes(card.stage)) { card.status = 'idle'; card.needs = null; }
    if (card.status === 'blocked' && card.stage === 'qa' && patch.buildPath != null) { card.status = 'idle'; card.needs = null; }
    this.log(card, `Attached ${Object.keys(patch).join(', ')}`, by);
    this.store.audit(by, 'card.attach', { cardId: id, fields: Object.keys(patch) });
    this.save();
    return card;
  }

  // ---- running ------------------------------------------------------------
  async runCard(id, by) {
    const card = this.card(id);
    if (card.status === 'blocked' || card.status === 'needs-you') { card.status = 'idle'; card.needs = null; }
    return this.drive(card, by);
  }

  async runQueue(by) {
    const limit = Number(this.settings.concurrency) || 3;
    const picked = orderQueue(this.cards).filter(isRunnable).slice(0, limit);
    this.store.audit(by, 'queue.run', { cards: picked.map((c) => c.id) });
    await Promise.all(picked.map((c) => this.drive(c, by)));
    return picked.map((c) => ({ id: c.id, stage: c.stage, status: c.status, needs: c.needs }));
  }

  async drive(card, by) {
    if (this.running.has(card.id)) return card;
    this.running.add(card.id);
    const before = `${card.stage}:${card.status}:${card.needs}`;
    card.status = 'running';
    try {
      for (let i = 0; i < 25; i++) {
        const advanced = await this.step(card, by);
        if (!advanced) break;
      }
    } catch (err) {
      this.wait(card, 'blocked', `Error: ${err.message}`);
      this.log(card, `Error: ${err.message}`);
    } finally {
      this.running.delete(card.id);
      if (card.status === 'running') card.status = 'idle';
      this.save();
    }
    if (['needs-you', 'blocked'].includes(card.status) && `${card.stage}:${card.status}:${card.needs}` !== before) {
      await this.notify(card.status, card, `${card.status === 'blocked' ? 'Blocked' : 'Needs you'}: ${card.title} (${card.id}) at ${STAGE[card.stage].label}. ${card.needs || ''}`, by);
    }
    return card;
  }

  // One step. Returns true when the card moved to the next stage.
  async step(card, by) {
    const s = card.stage;
    switch (s) {
      case 'intake':
        this.setStage(card, 'prep', 'akaw', `Queued from ${this.trackerName}`);
        return true;

      case 'prep':
        if (!card.gameId && !card.spec?.gameId) { this.wait(card, 'needs-you', 'Pick the game for this card'); return false; }
        this.setStage(card, 'brief', 'akaw');
        return true;

      case 'brief': {
        if (!String(card.idea || '').trim()) { this.wait(card, 'needs-you', 'Write the idea in plain words (or paste the brief)'); return false; }
        card.spec = parseIdea(card.idea, this.games, { gameId: card.gameId, title: card.title, overrides: card.overrides });
        if (!card.gameId && card.spec.gameId) { card.gameId = card.spec.gameId; card.clientId = card.spec.clientId; }
        const g = this.evaluateCard(card);
        if (card.spec.questions.length) { this.wait(card, 'needs-you', `Answer ${card.spec.questions.length} spec question${card.spec.questions.length > 1 ? 's' : ''} (never guessed)`); return false; }
        if (!g.ok) { this.wait(card, 'blocked', `Blocked by ${g.blocked.map((r) => r.ruleId).join(', ')}`); return false; }
        this.setStage(card, 'draft', 'akaw', 'Spec complete → Draft');
        return true;
      }

      case 'draft': {
        const a = card.artifacts;
        if (!a.draftUrl && !a.screenshots.length) {
          if (this.app.steps.draft.runner === 'manual') { this.wait(card, 'needs-you', 'Attach the draft link and screenshots (or set a draft runner in akaw.config.json)'); return false; }
          const r = await this.runFlowStep(card, 'draft', by);
          if (r.code !== 0) { this.wait(card, 'blocked', `Draft step failed (${r.runner}, exit ${r.code})`); return false; }
          this.applyResult(card, r.result);
          if (!a.draftUrl && !a.screenshots.length) { this.wait(card, 'needs-you', 'The draft step ran but returned no draft link or screenshots'); return false; }
        }
        this.setStage(card, 'concept_lock', 'akaw', 'Draft ready → Concept lock');
        this.evaluateCard(card);
        this.wait(card, 'needs-you', 'Concept lock: judge the draft, tick what needs a tick, set the credit ceiling');
        return false;
      }

      case 'art': {
        if (!card.spec?.fields?.needsArt?.value) { this.setStage(card, 'build', 'akaw', 'No art needed → Build'); return true; }
        if (card.credits.artDone) { this.setStage(card, 'build', 'akaw', 'Art done → Build'); return true; }
        this.wait(card, 'needs-you', `Generate art inside the ${card.credits.ceiling ?? 0}-credit ceiling (or record credits spent elsewhere), then press Art done.`);
        return false;
      }

      case 'build': {
        if (!card.artifacts.buildPath) {
          if (this.app.steps.build.runner === 'manual') { this.wait(card, 'needs-you', 'Attach the build (a local file or folder path), or set a build runner in akaw.config.json'); return false; }
          const r = await this.runFlowStep(card, 'build', by);
          if (r.code !== 0) { this.wait(card, 'blocked', `Build step failed (${r.runner}, exit ${r.code})`); return false; }
          this.applyResult(card, r.result);
          if (!card.artifacts.buildPath) { this.wait(card, 'needs-you', 'The build step ran but returned no buildPath'); return false; }
        }
        this.setStage(card, 'qa', 'akaw', 'Built → QA');
        return true;
      }

      case 'qa': return this.qa(card, by);

      case 'batch_link': {
        let batch = this.batches.find((b) => b.status === 'open');
        if (!batch) {
          batch = { id: this.store.nextId('B'), status: 'open', cards: [], createdAt: now() };
          this.batches.unshift(batch);
        }
        if (!batch.cards.includes(card.id)) batch.cards.push(card.id);
        card.batchId = batch.id;
        this.store.save('batches');
        this.wait(card, 'waiting', `In batch ${batch.id}. Seal the batch when it is ready to deploy.`);
        this.log(card, `Joined batch ${batch.id}`);
        return false;
      }

      case 'post': {
        const text = card.gates.link_review?.comment;
        const live = this.cfg.allowWrites && this.trackerLive && card.taskKey;
        if (live) {
          const res = await this.tracker.postComment(this.trackerConf, this.cfg.env, card.taskKey, text);
          card.posted = { at: now(), id: res.id, live: true };
          this.store.audit(by, 'task.comment', { cardId: card.id, tracker: this.trackerConf.provider, taskKey: card.taskKey, commentId: res.id });
        } else {
          const why = !card.taskKey ? 'no task linked to the card' : !this.trackerLive ? `${this.trackerName} not configured` : 'AKAW_ALLOW_WRITES is off';
          card.posted = { at: now(), live: false, dryRun: true, why, text };
          this.store.audit(by, 'task.comment.dry-run', { cardId: card.id, tracker: this.trackerConf.provider, taskKey: card.taskKey, why, text });
        }
        this.setStage(card, 'reviewers', 'akaw', card.posted.live ? `Posted to ${this.trackerName} ${card.taskKey}` : `Dry-run post (${card.posted.why})`);
        this.wait(card, 'waiting', `Waiting for reviewers on the ${this.trackerName} card`);
        return false;
      }

      case 'reviewers': {
        if (!card.reviews.length && this.trackerLive && card.taskKey) await this.fetchReplies(card.id, by, false);
        if (!card.reviews.length) { this.wait(card, 'waiting', `Waiting for reviewers on the ${this.trackerName} card`); return false; }
        this.setStage(card, 'triage', 'akaw', 'Replies in → Triage');
        return true;
      }

      case 'triage': {
        const verdicts = card.reviews.map((r) => r.raw || r.verdict);
        if (verdicts.every((v) => v === 'approved')) {
          this.setStage(card, 'close', 'akaw', 'Approved → Close gate');
          this.proposeClose(card);
          return false;
        }
        if (verdicts.every((v) => v === 'notes')) { this.loopBack(card, by); return false; }
        this.wait(card, 'needs-you', 'Mixed replies: decide whether this is a feedback fix or an approval');
        return false;
      }

      case 'exports': return this.exports(card, by);

      default:
        return false;
    }
  }

  applyResult(card, result) {
    if (!result || typeof result !== 'object') return;
    const a = card.artifacts;
    if (result.draftUrl) a.draftUrl = result.draftUrl;
    if (Array.isArray(result.screenshots)) a.screenshots = result.screenshots;
    if (result.buildPath) a.buildPath = result.buildPath;
    if (result.playLink) a.playLink = result.playLink;
  }

  runDir(card, stage) {
    const dir = path.join(this.cfg.dataDir, 'runs', card.id, `${stage}-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    const specFile = path.join(dir, 'spec.json');
    fs.writeFileSync(specFile, JSON.stringify({ card: { id: card.id, title: card.title, gameId: card.gameId, taskKey: card.taskKey, kit: card.kit, version: card.version, artifacts: card.artifacts, route: card.gates?.close?.route || null, previews: card.previews || [], exportLengths: this.settings.lengths || [15, 30, 59] }, spec: card.spec, game: this.game(card.gameId), kit: this.kitAssets(card).map((a) => ({ id: a.id, name: a.name, kind: a.kind, path: a.held ? path.join(this.cfg.dataDir, 'held', a.held.key) : a.source.path || a.source.link })) }, null, 2));
    return { dir, specFile };
  }

  stepContext(card, dir, specFile, extra = {}) {
    return { card, spec: card.spec, game: this.game(card.gameId), dir, specFile, env: this.cfg.env || {}, flowRepo: this.app.flowRepo, secretValues: this.cfg.secretValues, ...extra };
  }

  async runFlowStep(card, stage, by) {
    const step = this.app.steps[stage];
    const { dir, specFile } = this.runDir(card, stage);
    this.log(card, `Running ${stage}: ${describeStep(step)}`);
    const r = await runStep(stage, step, this.stepContext(card, dir, specFile));
    card.commandRuns.push({ at: now(), stage, runner: r.runner, code: r.code, cmd: r.cmd || describeStep(step), output: String(r.output || '').slice(-3000), costUsd: r.costUsd ?? null });
    if (card.commandRuns.length > 20) card.commandRuns.shift();
    this.store.audit(by, 'flow.step', { cardId: card.id, stage, runner: r.runner, code: r.code, costUsd: r.costUsd ?? undefined });
    return r;
  }

  async qa(card, by) {
    const files = readBuildFiles(card.artifacts.buildPath);
    const builtCopy = extractCopy(files.files);
    const game = this.game(card.gameId);
    let elements = [...(card.spec?.elements || [])];
    const notes = [];
    if (elements.includes('legal line')) {
      const lines = game?.legalLines || [];
      if (!lines.length) notes.push('No legal lines on file for this game, so the legal line was not checked word for word.');
      else if (files.files.length) {
        const all = files.files.map((f) => f.text).join('\n');
        const missing = lines.filter((l) => !all.includes(l));
        if (missing.length) { elements = elements.filter((e) => e !== 'legal line'); notes.push(`Legal line missing or reworded: "${missing[0].slice(0, 60)}"`); }
      }
    }
    if (card.idea && card.idea.length > 40 && files.files.some((f) => f.text.includes(card.idea))) notes.push('The idea text appears inside the bundle. Internal spec notes must not ship.');
    if (files.note) notes.push(files.note);
    const g = this.evaluateCard(card, { copy: [...(card.spec?.copy || []), ...builtCopy], files: files.files, elements, idea: null });

    // Size against each network cap on the route.
    const route = card.spec?.fields?.route?.value || 'UA';
    const over = [];
    for (const n of this.settings.networks || []) {
      if (!n.sizeCapMB || !(n.routes || []).includes(route)) continue;
      if (files.bytes > n.sizeCapMB * 1024 * 1024) over.push(`${n.name} (${(files.bytes / 1048576).toFixed(2)} MB > ${n.sizeCapMB} MB)`);
    }
    let cmdResult = null;
    if (this.app.steps.qa.runner !== 'manual') {
      cmdResult = await this.runFlowStep(card, 'qa', by);
      if (cmdResult.code !== 0) notes.push(`Flow QA step failed (${cmdResult.runner}, exit ${cmdResult.code})`);
    }
    card.qa = { at: now(), bytes: files.bytes, filesRead: files.files.length, copyLines: builtCopy.length, notes, overCap: over, command: cmdResult ? cmdResult.code : null };
    const failed = !g.ok || over.length || (cmdResult && cmdResult.code !== 0);
    if (failed) {
      const why = [...g.blocked.map((r) => r.ruleId), ...over.map((o) => `size cap ${o}`), cmdResult?.code ? 'flow QA step' : null].filter(Boolean).join(', ');
      this.wait(card, 'blocked', `QA blocked: ${why}`);
      this.store.audit(by, 'qa.blocked', { cardId: card.id, why });
      return false;
    }
    this.setStage(card, 'batch_link', 'akaw', `QA passed (${builtCopy.length} copy lines read)`);
    return true;
  }

  async exports(card, by) {
    const route = card.gates.close?.route || 'UA';
    const routes = route === 'both' ? ['UA', 'RT'] : [route];
    const nets = (this.settings.networks || []).filter((n) => (n.routes || []).some((r) => routes.includes(r)));
    if (!nets.length) { this.wait(card, 'blocked', `No networks set for ${route}. Add them in Settings.`); return false; }
    const lengths = this.settings.lengths || [15, 30, 59];
    if (card.spec?.minLength && card.spec.minLength > Math.min(...lengths)) {
      this.wait(card, 'blocked', `This spec cannot fit ${Math.min(...lengths)}s (shortest cut ${card.spec.minLength}s). Exports stop here.`);
      return false;
    }
    const fp = fingerprint(card.artifacts.buildPath);
    const slugGame = card.gameId || 'game';
    const files = [];
    for (const n of nets) for (const len of lengths) files.push({ network: n.name, route: (n.routes || []).find((r) => routes.includes(r)), length: len, file: `${card.id}_${slugGame}_${n.name.replace(/\W+/g, '')}_${len}s.html` });
    // Preview (GIF / mp4 / end-card screenshots) for delivery, if a preview runner is set.
    if (this.app.steps.preview.runner !== 'manual' && !card.previewsDone) {
      const pr = await this.runFlowStep(card, 'preview', by);
      if (pr.code !== 0) { this.wait(card, 'blocked', `Preview step failed (${pr.runner}): ${String(pr.output || '').slice(0, 160)}`); return false; }
      card.previews = pr.result?.previews || [];
      if (pr.result?.screenshots?.length) card.artifacts.endScreenshots = pr.result.screenshots;
      card.previewsDone = true;
    }
    let cmd = null;
    if (this.app.steps.export.runner !== 'manual') {
      cmd = await this.runFlowStep(card, 'export', by);
      if (cmd.code !== 0) { this.wait(card, 'blocked', `Export step failed (${cmd.runner}, exit ${cmd.code})`); return false; }
    }
    card.exportReceipt = { at: now(), by, route, lengths, files, fingerprint: fp, produced: Boolean(cmd), previews: (card.previews || []).map((p) => ({ orientation: p.orientation, mp4: p.mp4, gif: p.gif })), note: cmd ? `Produced by the export step (${cmd.runner})` : 'Planned: no export runner set, so this lists what to export' };
    const msg = `Playable ready: ${card.title} (${card.id}${card.taskKey ? `, ${this.trackerName} ${card.taskKey}` : ''}). Route ${route}. ${files.length} exports. ${card.artifacts.playLink || ''}`.trim();
    await this.notify('delivered', card, msg, by);
    this.store.audit(by, 'exports', { cardId: card.id, route, count: files.length, fingerprint: fp });
    this.setStage(card, 'done', 'akaw', `Exported ${files.length} files → Done`);
    card.status = 'done';
    return false;
  }

  proposeClose(card) {
    const saysRT = /\bRT\b/.test(card.title);
    card.closeProposal = saysRT ? 'RT' : 'UA';
    this.wait(card, 'needs-you', `Close: confirm route (proposed ${card.closeProposal}) and exports`);
  }

  loopBack(card, by) {
    card.rounds.push({ version: card.version, reviews: card.reviews, at: now() });
    card.feedback.push(...card.reviews.filter((r) => r.verdict !== 'approved').map((r) => ({ version: card.version, by: r.by, text: r.text })));
    card.reviews = [];
    card.version += 1;
    card.feedbackFix = true;
    card.artifacts.buildPath = null;
    card.artifacts.playLink = null;
    card.batchId = null;
    card.posted = null;
    for (const g of ['deploy', 'link_review', 'close']) delete card.gates[g];
    if (card.gates.concept_lock) card.gates.concept_lock_previous = card.gates.concept_lock;
    delete card.gates.concept_lock;
    card.previewsDone = false;
    this.setStage(card, 'intake', 'akaw', `Notes → back as a P0 card (v${card.version})`);
    this.store.audit(by, 'triage.loop-back', { cardId: card.id, version: card.version });
  }

  // ---- your four yeses ----------------------------------------------------
  approveGate(id, gate, payload = {}, by) {
    const card = this.card(id);
    if (!GATES.includes(gate)) throw new Error(`Unknown gate ${gate}`);
    if (card.stage !== gate) throw new Error(`${card.id} is at ${STAGE[card.stage].label}, not ${STAGE[gate].label}`);
    if (gate === 'deploy') throw new Error('Deploy is approved per batch, after you run the deploy command');
    const record = { by, at: now(), note: payload.note || '' };

    if (gate === 'concept_lock') {
      if (card.spec?.questions?.length) throw new Error('Answer the open spec questions first');
      const g = this.evaluateCard(card);
      if (!g.ok) throw new Error(`Blocked by ${g.blocked.map((r) => r.ruleId).join(', ')}`);
      const ticks = new Set(payload.ticks || []);
      const missing = g.needsSignoff.filter((r) => !ticks.has(r.ruleId));
      if (missing.length) throw new Error(`Tick these first: ${missing.map((r) => r.message).join('; ')}`);
      if (!card.artifacts.draftUrl && !card.artifacts.screenshots.length) throw new Error('Judge it on a real draft: attach the draft first');
      if (card.spec?.fields?.needsArt?.value) {
        const ceiling = Number(payload.creditCeiling);
        if (!Number.isFinite(ceiling) || ceiling < 0 || payload.creditCeiling === '' || payload.creditCeiling == null) throw new Error('Art is needed: type one credit ceiling');
        card.credits.ceiling = ceiling;
        record.creditCeiling = ceiling;
        this.store.audit(by, 'credits.quote', { cardId: id, ceiling, usd: this.settings.creditUsdRate ? ceiling * this.settings.creditUsdRate : null });
      }
      record.ticks = [...ticks];
      record.version = card.version;
      card.gates.concept_lock = record;
      this.setStage(card, 'art', by, 'Concept locked');
    } else if (gate === 'link_review') {
      const link = String(payload.playLink || card.artifacts.playLink || '').trim();
      if (!/^https?:\/\//.test(link)) throw new Error('Add the Play Now link');
      if (TUNNEL_RE.test(link)) throw new Error('That looks like a preview or tunnel address. Use the catalogue Play Now link.');
      const comment = String(payload.comment || '').trim();
      if (!comment) throw new Error(`Write the exact ${this.trackerName} comment`);
      if (!comment.includes(link)) throw new Error('The comment must carry the play link');
      card.artifacts.playLink = link;
      record.comment = comment;
      record.playLink = link;
      card.gates.link_review = record;
      this.setStage(card, 'post', by, 'Link review approved');
    } else if (gate === 'close') {
      const route = payload.route || card.closeProposal || 'UA';
      if (!['UA', 'RT', 'both'].includes(route)) throw new Error('Route is UA, RT or both');
      if (route !== 'UA' && !/\bRT\b/.test(card.title)) throw new Error('RT is only for cards whose title says RT. New RT-adaptation cards stay UA for now.');
      record.route = route;
      card.gates.close = record;
      this.setStage(card, 'exports', by, `Close approved: ${route}`);
    }
    this.store.audit(by, `gate.${gate}`, { cardId: id, ...record, comment: record.comment ? '(exact text stored on card)' : undefined });
    this.save();
    return card;
  }

  sendBack(id, toStage, note, by) {
    const card = this.card(id);
    if (!STAGE[toStage]) throw new Error('Unknown stage');
    if (stageIndex(toStage) >= stageIndex(card.stage)) throw new Error('Send back only to an earlier stage');
    for (const g of GATES) if (stageIndex(g) >= stageIndex(toStage)) delete card.gates[g];
    if (stageIndex(toStage) <= stageIndex('build')) card.artifacts.buildPath = null;
    if (stageIndex(toStage) <= stageIndex('draft')) { card.artifacts.draftUrl = null; card.artifacts.screenshots = []; }
    if (card.batchId) {
      const b = this.batches.find((x) => x.id === card.batchId);
      if (b && b.status === 'open') { b.cards = b.cards.filter((c) => c !== id); this.store.save('batches'); }
      card.batchId = null;
    }
    this.setStage(card, toStage, by, `Sent back to ${STAGE[toStage].label}${note ? `: ${note}` : ''}`);
    this.store.audit(by, 'card.send-back', { cardId: id, to: toStage, note });
    this.save();
    return card;
  }

  // ---- batches and deploy ------------------------------------------------
  sealBatch(by) {
    const batch = this.batches.find((b) => b.status === 'open');
    if (!batch || !batch.cards.length) throw new Error('No open batch with cards');
    batch.status = 'sealed';
    batch.sealedAt = now();
    batch.sealedBy = by;
    batch.deployCommand = this.app.deploy?.command || null;
    for (const cid of batch.cards) {
      const c = this.cards.find((x) => x.id === cid);
      if (!c || c.stage !== 'batch_link') continue;
      this.setStage(c, 'deploy', by, `Batch ${batch.id} sealed`);
      this.wait(c, 'needs-you', `Deploy: run the deploy for batch ${batch.id} yourself, then confirm`);
    }
    this.store.save('batches');
    this.store.audit(by, 'batch.seal', { batchId: batch.id, cards: batch.cards });
    this.notify('batch-sealed', null, `Batch ${batch.id} sealed with ${batch.cards.length} playable(s). Deploy, then confirm in Akaw.`, by).catch(() => {});
    this.save();
    return batch;
  }

  markDeployed(batchId, { confirm }, by) {
    const batch = this.batches.find((b) => b.id === batchId);
    if (!batch) throw new Error('Batch not found');
    if (batch.status !== 'sealed') throw new Error(`Batch is ${batch.status}`);
    if (confirm !== 'DEPLOYED') throw new Error('Type DEPLOYED to confirm you ran the production deploy');
    batch.status = 'deployed';
    batch.deployedAt = now();
    batch.deployedBy = by;
    for (const cid of batch.cards) {
      const c = this.cards.find((x) => x.id === cid);
      if (!c || c.stage !== 'deploy') continue;
      c.gates.deploy = { by, at: now(), batchId };
      this.setStage(c, 'link_review', by, `Deployed in ${batchId}`);
      const link = c.artifacts.playLink || '';
      c.draftComment = `Play Now: ${link || '<play link>'}\n${c.title}${c.taskKey ? ` (${c.taskKey})` : ''}, v${c.version}. Ready for review.`;
      this.wait(c, 'needs-you', `Link review: check the play link and the exact ${this.trackerName} comment`);
    }
    this.store.save('batches');
    this.store.audit(by, 'gate.deploy', { batchId, cards: batch.cards });
    this.save();
    return batch;
  }

  // ---- reviewers, triage --------------------------------------------------
  recordReview(id, { by: reviewer, text, verdict }, by) {
    const card = this.card(id);
    if (!['reviewers', 'triage'].includes(card.stage)) throw new Error('Reviews are recorded once the link is posted');
    if (!reviewer || !text) throw new Error('Who replied, and what they wrote');
    const v = ['approved', 'notes', 'mixed'].includes(verdict) ? verdict : classifyReview(text);
    card.reviews.push({ by: reviewer, text, verdict: v === 'mixed' ? 'notes' : v, raw: v, at: now(), source: 'manual' });
    if (card.status === 'waiting' || card.status === 'needs-you') { card.status = 'idle'; card.needs = null; }
    if (card.stage === 'triage') card.stage = 'reviewers';
    this.log(card, `Review from ${reviewer}: ${v}`, by);
    this.store.audit(by, 'review.record', { cardId: id, reviewer, verdict: v });
    this.save();
    return card;
  }

  async fetchReplies(id, by, save = true) {
    const card = this.card(id);
    if (!card.taskKey) throw new Error(`No ${this.trackerName} task linked to this card`);
    const all = await this.tracker.comments(this.trackerConf, this.cfg.env, card.taskKey);
    const since = card.posted?.at ? Date.parse(card.posted.at) : 0;
    const ours = card.gates.link_review?.comment?.trim();
    const known = new Set(card.reviews.map((r) => r.commentId).filter(Boolean));
    let n = 0;
    for (const c of all) {
      if (Date.parse(c.at) < since || known.has(c.id) || (ours && c.text.trim() === ours)) continue;
      const v = classifyReview(c.text);
      card.reviews.push({ by: c.by, text: c.text, verdict: v === 'mixed' ? 'notes' : v, raw: v, at: c.at, commentId: c.id, source: this.trackerConf.provider });
      n++;
    }
    if (n) this.log(card, `${n} repl${n > 1 ? 'ies' : 'y'} read from ${this.trackerName} ${card.taskKey}`, by);
    if (save) this.save();
    return n;
  }

  resolveMixed(id, as, by) {
    const card = this.card(id);
    if (card.stage !== 'triage') throw new Error('Not in triage');
    if (as === 'approved') {
      card.reviews.forEach((r) => { r.verdict = 'approved'; r.raw = 'approved'; });
      this.setStage(card, 'close', by, 'Mixed replies treated as approval');
      this.proposeClose(card);
    } else {
      card.reviews.forEach((r) => { r.verdict = r.raw === 'approved' ? 'approved' : 'notes'; r.raw = r.verdict; });
      this.loopBack(card, by);
    }
    this.store.audit(by, 'triage.resolve', { cardId: id, as });
    this.save();
    return card;
  }

  // ---- credits ------------------------------------------------------------
  recordCredits(id, credits, note, by) {
    const card = this.card(id);
    const n = Number(credits);
    if (!(n > 0)) throw new Error('Credits must be a positive number');
    if (card.credits.ceiling == null) throw new Error('No credit ceiling: the concept lock sets it');
    if (card.credits.spent + n > card.credits.ceiling) {
      this.store.audit(by, 'credits.refused', { cardId: id, credits: n, spent: card.credits.spent, ceiling: card.credits.ceiling });
      throw new Error(`Credit hook: ${card.credits.spent} + ${n} is over the ceiling of ${card.credits.ceiling}. Send the card back to concept lock for a new yes.`);
    }
    card.credits.spent += n;
    card.credits.entries.push({ at: now(), credits: n, note: note || '', by });
    const rate = this.settings.creditUsdRate;
    this.store.audit(by, 'credits.spend', { cardId: id, credits: n, usd: rate ? +(n * rate).toFixed(2) : null, note });
    this.log(card, `${n} credits spent${note ? ` (${note})` : ''}`, by);
    this.save();
    return card;
  }

  artDone(id, by) {
    const card = this.card(id);
    if (card.stage !== 'art') throw new Error('Not at Art');
    card.credits.artDone = true;
    card.status = 'idle';
    card.needs = null;
    this.log(card, 'Art done', by);
    this.save();
    return card;
  }

  setQueue(id, { pinned, hold, tier }, by) {
    const card = this.card(id);
    if (pinned != null) card.pinned = Boolean(pinned);
    if (hold != null) card.hold = Boolean(hold);
    if (tier !== undefined) card.tierOverride = tier && ['P0', 'P1', 'P2', 'P3'].includes(tier) ? tier : null;
    this.store.audit(by, 'queue.set', { cardId: id, pinned, hold, tier });
    this.save();
    return card;
  }

  // ---- task tracker sync ----------------------------------------------
  async trackerPreview(by) {
    const rows0 = applyFilter(await this.tracker.search(this.trackerConf, this.cfg.env), this.trackerConf);
    const byKey = new Map(this.cards.filter((c) => c.taskKey).map((c) => [String(c.taskKey), c]));
    const rows = rows0.map((i) => {
      const spec = parseIdea(`${i.summary}\n${i.description || ''}`, this.games, { title: i.summary });
      return { ...i, cardId: byKey.get(String(i.key))?.id || null, gameGuess: spec.gameId, gameQuestion: spec.questions.find((q) => q.field === 'game')?.question || null };
    });
    this.lastTaskPreview = { at: now(), tracker: this.trackerConf.provider, rows };
    this.store.audit(by, 'task.sync.preview', { tracker: this.trackerConf.provider, tasks: rows.length, new: rows.filter((r) => !r.cardId).length });
    return this.lastTaskPreview;
  }

  trackerImport(keys, by) {
    if (!this.lastTaskPreview) throw new Error('Run a preview sync first');
    const made = [];
    for (const row of this.lastTaskPreview.rows) {
      if (!keys.map(String).includes(String(row.key)) || row.cardId) continue;
      const card = this.createCard({ title: row.summary, gameId: row.gameGuess, idea: row.description || row.summary, taskKey: String(row.key), taskUrl: row.url || null, priority: row.priority, sprintEnd: row.due, stage: 'intake' }, by);
      row.cardId = card.id;
      made.push(card.id);
    }
    this.store.audit(by, 'task.import', { tracker: this.trackerConf.provider, cards: made });
    return made;
  }

  // ---- chat -----------------------------------------------------------------
  async notify(event, card, text, by = 'akaw') {
    for (const t of this.app.chat) {
      if (!(t.events || ['delivered']).includes(event)) continue;
      let p;
      try { p = chatFor(t); } catch (e) { this.store.audit(by, 'chat.error', { event, error: e.message }); continue; }
      const configured = p.configured(t, this.cfg.env || {});
      if (!this.cfg.allowWrites || !configured) {
        this.store.audit(by, 'chat.post.dry-run', { provider: t.provider, event, cardId: card?.id, text, why: configured ? 'AKAW_ALLOW_WRITES is off' : `${p.name} not configured` });
        continue;
      }
      try {
        await p.post(t, this.cfg.env, text, { event, card: card ? { id: card.id, title: card.title, stage: card.stage, status: card.status, taskKey: card.taskKey, playLink: card.artifacts?.playLink } : null });
        this.store.audit(by, 'chat.post', { provider: t.provider, event, cardId: card?.id });
      } catch (e) {
        this.store.audit(by, 'chat.error', { provider: t.provider, event, cardId: card?.id, error: e.message });
      }
    }
  }

  // ---- art generation (credit hook first) -----------------------------------
  toCredits(amount, unit) {
    if (amount == null) return null;
    if ((unit || 'credits') === 'credits') return Number(amount);
    const rate = this.settings.creditUsdRate;
    return rate ? Number(amount) / rate : null;
  }

  async generateArt(id, { generatorId, prompt, n = 1, estimate = null }, by) {
    const card = this.card(id);
    if (card.stage !== 'art') throw new Error('Generate at the Art step, after the concept lock');
    const g = this.app.generators.find((x) => x.id === generatorId);
    if (!g) throw new Error(`No generator "${generatorId}" in akaw.config.json`);
    if (!generatorConfigured(g, this.cfg.env || {})) throw new Error(`${g.label || g.id} is not configured`);
    if (!String(prompt || '').trim()) throw new Error('Write the prompt');
    const count = Math.max(1, Math.min(8, Number(n) || 1));
    if ((g.unit || 'credits') === 'usd' && g.costPerOutput != null && !this.settings.creditUsdRate) throw new Error('This generator is priced in $. Set $ per credit in Settings first.');
    let est = g.costPerOutput != null ? this.toCredits(g.costPerOutput * count, g.unit) : (estimate === '' || estimate == null ? null : Number(estimate));
    if (est == null || !Number.isFinite(est)) throw new Error('No price on file for this generator: type the estimate in credits');
    if (card.credits.ceiling == null) throw new Error('No credit ceiling: the concept lock sets it');
    if (card.credits.spent + est > card.credits.ceiling) {
      this.store.audit(by, 'credits.refused', { cardId: id, generator: g.id, estimate: est, spent: card.credits.spent, ceiling: card.credits.ceiling });
      throw new Error(`Credit hook: ${card.credits.spent} + ${+est.toFixed(2)} is over the ceiling of ${card.credits.ceiling}. Send the card back to concept lock for a new yes.`);
    }
    const { dir, specFile } = this.runDir(card, `gen-${g.id}`);
    this.log(card, `Generating ${count} with ${g.label || g.id} (est. ${+est.toFixed(2)} credits)`, by);
    let res;
    try {
      res = await generate(g, this.stepContext(card, dir, specFile, { prompt, n: count }));
    } catch (e) {
      this.store.audit(by, 'generate.failed', { cardId: id, generator: g.id, error: e.message });
      this.save();
      throw e;
    }
    const actual = res.reportedCost != null ? (this.toCredits(res.reportedCost, g.unit) ?? est) : est;
    card.credits.spent = +(card.credits.spent + actual).toFixed(4);
    card.credits.entries.push({ at: now(), credits: +actual.toFixed(4), note: `${g.label || g.id}: ${res.files.length} output(s)`, by, generator: g.id });
    const assets = [];
    for (const f of res.files) {
      const a = await this.library.registerGenerated(f.path, { gameId: card.gameId, clientId: card.clientId, cardId: card.id, madeWith: { tool: g.label || g.id, provider: g.provider, model: g.model || null, prompt, credits: +(actual / Math.max(1, res.files.length)).toFixed(4), at: now(), sourceUrl: f.sourceUrl || null } }, by);
      if (!assets.includes(a.id)) assets.push(a.id);
      if (!card.kit.includes(a.id)) card.kit.push(a.id);
    }
    card.generations.push({ at: now(), by, generator: g.id, prompt, n: count, credits: +actual.toFixed(4), assets });
    if (card.credits.spent > card.credits.ceiling) this.store.audit(by, 'credits.over', { cardId: id, spent: card.credits.spent, ceiling: card.credits.ceiling });
    this.store.audit(by, 'generate', { cardId: id, generator: g.id, provider: g.provider, model: g.model, outputs: res.files.length, credits: actual, usd: this.settings.creditUsdRate ? +(actual * this.settings.creditUsdRate).toFixed(2) : null });
    this.save();
    return { card, assets };
  }

  // ---- rules, lessons, games, settings ----------------------------------
  addRule(rule, by) {
    const r = { status: 'active', exceptions: [], owner: '', source: `Added in Akaw by ${by}`, ...rule };
    const errors = validateRule(r, this.rules);
    if (errors.length) throw new Error(errors.join('; '));
    this.rules.push(r);
    this.store.save('rules');
    this.store.audit(by, 'rule.add', { ruleId: r.id, scope: r.scope, severity: r.severity });
    return r;
  }

  updateRuleMeta(id, { owner, confirmed }, by) {
    const r = this.rules.find((x) => x.id === id);
    if (!r) throw new Error('Rule not found');
    if (owner != null) r.owner = owner;
    if (confirmed) { r.confirmedBy = by; r.confirmedAt = now(); r.confirm = null; }
    this.store.save('rules');
    this.store.audit(by, 'rule.meta', { ruleId: id, owner, confirmed });
    return r;
  }

  retireRule(id, by) {
    const r = this.rules.find((x) => x.id === id);
    if (!r) throw new Error('Rule not found');
    if (r.scope === 'team') throw new Error('Team rules are changed in the team rule file, by its owner');
    r.status = 'retired';
    this.store.save('rules');
    this.store.audit(by, 'rule.retire', { ruleId: id });
    return r;
  }

  addException(ruleId, ex, by) {
    const r = this.rules.find((x) => x.id === ruleId);
    if (!r) throw new Error('Rule not found');
    const errors = validateException(ex);
    if (errors.length) throw new Error(errors.join('; '));
    const rec = { creative: ex.creative, approver: ex.approver, date: ex.date, note: ex.note || '', recordedBy: by, at: now() };
    r.exceptions = [...(r.exceptions || []), rec];
    this.store.save('rules');
    this.store.audit(by, 'rule.exception', { ruleId, ...rec });
    return r;
  }

  decideLesson(id, decision, by) {
    const l = this.lessons.find((x) => x.id === id);
    if (!l) throw new Error('Lesson not found');
    if (decision === 'adopt') {
      const rule = this.addRule({ ...l.rule, id: l.rule.id || l.id, source: `Lesson adopted by ${by}` }, by);
      l.status = 'adopted';
      l.ruleId = rule.id;
    } else {
      l.status = 'rejected';
    }
    l.decidedBy = by;
    l.decidedAt = now();
    this.store.save('lessons');
    this.store.audit(by, `lesson.${decision}`, { lessonId: id });
    return l;
  }

  upsertClient(c, by) {
    if (!SLUG.test(c.id || '')) throw new Error('Client id: lowercase letters, digits, dashes');
    if (!c.name) throw new Error('Client name is required');
    const i = this.clients.findIndex((x) => x.id === c.id);
    const rec = { ...(i >= 0 ? this.clients[i] : {}), id: c.id, name: c.name };
    if (i >= 0) this.clients[i] = rec; else this.clients.push(rec);
    this.store.save('clients');
    this.store.audit(by, 'client.upsert', { clientId: c.id });
    return rec;
  }

  upsertGame(g, by) {
    if (!SLUG.test(g.id || '')) throw new Error('Game id: lowercase letters, digits, dashes');
    if (!g.name) throw new Error('Game name is required');
    if (!this.clients.some((c) => c.id === g.clientId)) throw new Error('Pick a client');
    const i = this.games.findIndex((x) => x.id === g.id);
    const base = i >= 0 ? this.games[i] : { aliases: [], codes: [], cores: [], approvedPrizes: [], legalLines: [], requiredElements: ['legal line', 'store badges'], palette: [], fonts: [], badges: [], reviewers: [], winLine: 'You Can Win' };
    const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]+/)).map((s) => String(s).trim()).filter(Boolean);
    const rec = { ...base, ...g };
    for (const k of ['aliases', 'codes', 'approvedPrizes', 'legalLines', 'requiredElements', 'palette', 'fonts', 'badges', 'reviewers']) if (k in g) rec[k] = list(g[k]);
    if ('approvedPrizes' in g) rec.approvedPrizes = rec.approvedPrizes.map((p) => p.replace(/[$,\s]/g, ''));
    if (Array.isArray(g.cores)) rec.cores = g.cores.filter((c) => c && c.id && c.name).map((c) => ({ id: c.id, name: c.name, keywords: list(c.keywords), template: c.template || null }));
    if (i >= 0) this.games[i] = rec; else this.games.push(rec);
    this.store.save('games');
    this.store.audit(by, 'game.upsert', { gameId: g.id, fields: Object.keys(g) });
    return rec;
  }

  copyGameRules(fromGameId, toGameId, keepIds, by) {
    const src = this.rules.filter((r) => r.scope === `game:${fromGameId}` && keepIds.includes(r.id));
    const made = [];
    for (const r of src) {
      const id = `${r.id}-${toGameId}`.slice(0, 60);
      if (this.rules.some((x) => x.id === id)) continue;
      made.push(this.addRule({ ...r, id, scope: `game:${toGameId}`, exceptions: [], source: `Copied from ${r.id} (${fromGameId}) during onboarding`, owner: '' }, by));
    }
    return made;
  }

  updateSettings(patch, by) {
    const s = this.settings;
    if ('operator' in patch) s.operator = String(patch.operator || '').trim() || 'operator';
    if ('creditUsdRate' in patch) s.creditUsdRate = patch.creditUsdRate === '' || patch.creditUsdRate == null ? null : Number(patch.creditUsdRate);
    if ('concurrency' in patch) s.concurrency = Math.max(1, Math.min(6, Number(patch.concurrency) || 3));
    if (Array.isArray(patch.networks)) s.networks = patch.networks.filter((n) => n && n.name).map((n) => ({ name: String(n.name).trim(), routes: (n.routes || []).filter((r) => ['UA', 'RT'].includes(r)), sizeCapMB: n.sizeCapMB === '' || n.sizeCapMB == null ? null : Number(n.sizeCapMB) }));
    this.store.save('settings');
    this.store.audit(by, 'settings.update', { fields: Object.keys(patch) });
    return s;
  }

  // ---- views --------------------------------------------------------------
  view(card) {
    return { ...card, tier: computeTier(card), runnable: isRunnable(card) };
  }

  summary() {
    const cards = this.cards;
    const open = cards.filter((c) => c.stage !== 'done');
    const queue = orderQueue(cards).map((c) => c.id);
    return {
      stages: stagesFor(this.trackerName),
      cards: cards.map((c) => this.view(c)),
      queue,
      counts: {
        open: open.length,
        needsYou: open.filter((c) => c.status === 'needs-you').length,
        blocked: open.filter((c) => c.status === 'blocked').length,
        running: open.filter((c) => c.status === 'running').length,
        done: cards.length - open.length,
      },
      batches: this.batches.slice(0, 20),
    };
  }
}

// ---- build file helpers ----------------------------------------------------
const TEXTY = /\.(html?|js|mjs|json|css|txt|svg)$/i;

export function readBuildFiles(p, maxBytes = 8 * 1024 * 1024) {
  const out = { files: [], bytes: 0, note: null };
  if (!p) return { ...out, note: 'No build path attached' };
  if (!fs.existsSync(p)) return { ...out, note: `Build path not found on this machine: ${p}` };
  const st = fs.statSync(p);
  const take = (file) => {
    const s = fs.statSync(file);
    out.bytes += s.size;
    if (!TEXTY.test(file)) return;
    const used = out.files.reduce((n, f) => n + f.text.length, 0);
    if (used + s.size > maxBytes) { out.note = 'Large bundle: only part of it was read'; return; }
    out.files.push({ path: path.relative(st.isDirectory() ? p : path.dirname(p), file), text: fs.readFileSync(file, 'utf8') });
  };
  if (st.isFile()) {
    if (/\.zip$/i.test(p)) { out.bytes = st.size; out.note = 'Zip bundles are size-checked but not read; point the build path at the unzipped folder to check copy.'; return out; }
    take(p);
  } else {
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f); else if (e.isFile()) take(f);
      }
    };
    walk(p);
  }
  return out;
}

const LITERAL = /(["'`])((?:\\.|(?!\1)[^\\\n]){2,200})\1/g;
const CODEY = /[/{}=;#<>\\]|^\s*$|\bpx\b|^[a-z]+[A-Z]\w*$|^[\w.-]+\.(js|png|jpg|mp3|json|css|webp)$/;

export function extractCopy(files) {
  const lines = new Set();
  for (const f of files) {
    let text = f.text;
    if (/\.html?$/i.test(f.path)) {
      const scripts = [...text.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n');
      const visible = text.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, '\n');
      for (const l of visible.split('\n')) { const t = l.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim(); if (/[A-Za-z]{2,}/.test(t)) lines.add(t); }
      text = scripts;
    } else if (!/\.(js|mjs|json)$/i.test(f.path)) continue;
    for (const m of text.matchAll(LITERAL)) {
      const s = m[2].trim();
      if (!/[A-Za-z]{2,}/.test(s) || CODEY.test(s)) continue;
      if (/\s/.test(s) || /^[A-Z]{3,}!?$/.test(s) || /^[A-Z][a-z]+!?$/.test(s)) lines.add(s);
      if (lines.size > 5000) break;
    }
  }
  return [...lines];
}

export function fingerprint(p) {
  if (!p || !fs.existsSync(p)) return null;
  const h = crypto.createHash('sha256');
  const st = fs.statSync(p);
  if (st.isFile()) h.update(fs.readFileSync(p));
  else {
    const files = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (e.isFile()) files.push(f); } };
    walk(p);
    for (const f of files.sort()) h.update(path.relative(p, f)).update(fs.readFileSync(f));
  }
  return `sha256:${h.digest('hex')}`;
}
