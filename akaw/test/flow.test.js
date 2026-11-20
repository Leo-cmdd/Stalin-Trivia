import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeEngine, tmpDir } from './helpers.js';
import { classifyReview, extractCopy } from '../src/flow.js';

const IDEA = 'Solitaire Cash, 30 seconds. The player clears a short Klondike board and a prize counter climbs. Winter look.';

function buildDir(copy) {
  const d = tmpDir('akaw-build-');
  fs.writeFileSync(path.join(d, 'index.html'), `<html><body><h1>${copy}</h1><script>const t = "Tap to play";</script></body></html>`);
  return d;
}

async function toConceptLock(flow, by = 'op') {
  flow.upsertGame({ id: 'solitaire-cash', name: 'Solitaire Cash', clientId: 'papaya', approvedPrizes: ['50'] }, by);
  const card = flow.createCard({ title: 'Winter Klondike', gameId: 'solitaire-cash', idea: IDEA }, by);
  await flow.runCard(card.id, by);
  assert.equal(card.stage, 'brief');
  assert.equal(card.status, 'needs-you');
  assert.match(card.needs, /spec question/);
  flow.updateSpec(card.id, { overrides: { prize: '50' } }, by);
  await flow.runCard(card.id, by);
  assert.equal(card.stage, 'draft');
  assert.match(card.needs, /draft/);
  flow.attach(card.id, { draftUrl: 'https://example.com/draft', screenshots: 'a.png, b.png' }, by);
  await flow.runCard(card.id, by);
  assert.equal(card.stage, 'concept_lock');
  return card;
}

test('a card goes through all 17 steps with four yeses', async () => {
  const { flow, store } = makeEngine({}, { chat: [{ provider: 'slack', events: ['delivered'] }] });
  const by = 'op';
  const card = await toConceptLock(flow);

  // Concept lock: art is needed (winter skin), so one credit ceiling is required.
  assert.throws(() => flow.approveGate(card.id, 'concept_lock', {}, by), /credit ceiling/);
  flow.approveGate(card.id, 'concept_lock', { creditCeiling: 40 }, by);
  assert.equal(card.stage, 'art');

  await flow.runCard(card.id, by);
  assert.match(card.needs, /ceiling/);
  flow.recordCredits(card.id, 30, 'bg', by);
  assert.throws(() => flow.recordCredits(card.id, 20, 'more', by), /Credit hook/);
  flow.artDone(card.id, by);

  // Build with bad copy: QA blocks on "You Won".
  flow.attach(card.id, { buildPath: buildDir('You Won!') }, by);
  await flow.runCard(card.id, by);
  assert.equal(card.stage, 'qa');
  assert.equal(card.status, 'blocked');
  assert.match(card.needs, /papaya-you-can-win/);

  // Fixed build passes QA and joins a batch.
  flow.attach(card.id, { buildPath: buildDir('You Can Win') }, by);
  await flow.runCard(card.id, by);
  assert.equal(card.stage, 'batch_link');
  assert.ok(card.batchId);

  const batch = flow.sealBatch(by);
  assert.equal(card.stage, 'deploy');
  assert.throws(() => flow.markDeployed(batch.id, { confirm: 'yes' }, by), /DEPLOYED/);
  flow.markDeployed(batch.id, { confirm: 'DEPLOYED' }, by);
  assert.equal(card.stage, 'link_review');

  assert.throws(() => flow.approveGate(card.id, 'link_review', { playLink: 'https://abc.trycloudflare.com/x', comment: 'https://abc.trycloudflare.com/x' }, by), /tunnel/);
  assert.throws(() => flow.approveGate(card.id, 'link_review', { playLink: 'https://play.example.com/p/1', comment: 'no link here' }, by), /carry the play link/);
  flow.approveGate(card.id, 'link_review', { playLink: 'https://play.example.com/p/1', comment: 'Play Now: https://play.example.com/p/1' }, by);
  assert.equal(card.stage, 'post');

  await flow.runCard(card.id, by);
  assert.equal(card.stage, 'reviewers');
  assert.equal(card.posted.dryRun, true);

  flow.recordReview(card.id, { by: 'Reviewer', text: 'Approved' }, by);
  await flow.runCard(card.id, by);
  assert.equal(card.stage, 'close');
  assert.equal(card.closeProposal, 'UA');
  assert.throws(() => flow.approveGate(card.id, 'close', { route: 'RT' }, by), /title says RT/);
  flow.approveGate(card.id, 'close', { route: 'UA' }, by);

  // No networks yet: exports stop and say so.
  await flow.runCard(card.id, by);
  assert.equal(card.status, 'blocked');
  flow.updateSettings({ networks: [{ name: 'NetA', routes: ['UA'], sizeCapMB: 5 }] }, by);
  await flow.runCard(card.id, by);
  assert.equal(card.stage, 'done');
  assert.equal(card.exportReceipt.files.length, 3);
  assert.ok(card.exportReceipt.fingerprint.startsWith('sha256:'));

  const actions = store.readAudit(500).map((e) => e.action);
  for (const a of ['gate.concept_lock', 'gate.deploy', 'gate.link_review', 'gate.close', 'credits.quote', 'credits.refused', 'task.comment.dry-run', 'chat.post.dry-run']) {
    assert.ok(actions.includes(a), `audit has ${a}`);
  }
});

test('notes come back as a P0 card; mixed replies wait for you', async () => {
  const { flow } = makeEngine();
  const by = 'op';
  const card = await toConceptLock(flow);
  flow.approveGate(card.id, 'concept_lock', { creditCeiling: 0 }, by);
  flow.artDone(card.id, by);
  flow.attach(card.id, { buildPath: buildDir('You Can Win') }, by);
  await flow.runCard(card.id, by);
  const b = flow.sealBatch(by);
  flow.markDeployed(b.id, { confirm: 'DEPLOYED' }, by);
  flow.approveGate(card.id, 'link_review', { playLink: 'https://play.example.com/p/2', comment: 'Play Now: https://play.example.com/p/2' }, by);
  await flow.runCard(card.id, by);

  flow.recordReview(card.id, { by: 'A', text: 'Approved' }, by);
  flow.recordReview(card.id, { by: 'B', text: 'Add this to the full playables list' }, by);
  await flow.runCard(card.id, by);
  assert.equal(card.stage, 'triage');
  assert.equal(card.status, 'needs-you');

  flow.resolveMixed(card.id, 'notes', by);
  assert.equal(card.stage, 'intake');
  assert.equal(card.version, 2);
  assert.equal(flow.view(card).tier, 'P0');
  assert.equal(card.feedback.length, 1);
  assert.equal(card.artifacts.buildPath, null);
});

test('extra tick: a near miss cannot pass concept lock without it', async () => {
  const { flow } = makeEngine();
  const by = 'op';
  flow.upsertGame({ id: 'solitaire-cash', name: 'Solitaire Cash', clientId: 'papaya', approvedPrizes: ['50'] }, by);
  const card = flow.createCard({ title: 'Near miss', gameId: 'solitaire-cash', idea: 'Solitaire Cash klondike near miss, 25s, win $50' }, by);
  await flow.runCard(card.id, by);
  flow.attach(card.id, { draftUrl: 'https://example.com/d' }, by);
  await flow.runCard(card.id, by);
  assert.equal(card.stage, 'concept_lock');
  assert.throws(() => flow.approveGate(card.id, 'concept_lock', {}, by), /Tick these first/);
  flow.approveGate(card.id, 'concept_lock', { ticks: ['team-extra-tick'] }, by);
  assert.equal(card.stage, 'art');
});

test('run queue moves up to three cards and skips held ones', async () => {
  const { flow } = makeEngine();
  const by = 'op';
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(flow.createCard({ title: `c${i}`, gameId: 'solitaire-cash', idea: '' }, by).id);
  flow.setQueue(ids[0], { hold: true }, by);
  const ran = await flow.runQueue(by);
  assert.equal(ran.length, 3);
  assert.ok(!ran.some((r) => r.id === ids[0]));
});

test('review classification', () => {
  assert.equal(classifyReview('Approved'), 'approved');
  assert.equal(classifyReview('LGTM'), 'approved');
  assert.equal(classifyReview('Approved, but please fix the font'), 'mixed');
  assert.equal(classifyReview('The logo is stretched'), 'notes');
});

test('copy extraction reads visible text and JS strings, not code names', () => {
  const lines = extractCopy([{ path: 'index.html', text: '<div>Win real cash</div><script>var a = "You Won!"; var b = "btnCashOut"; var c = "BRAVO";</script>' }]);
  assert.ok(lines.includes('Win real cash'));
  assert.ok(lines.includes('You Won!'));
  assert.ok(lines.includes('BRAVO'));
  assert.ok(!lines.includes('btnCashOut'));
});

test('cards saved by v0.1 (Jira-named stages and fields) migrate on start', async () => {
  const { Flow } = await import('../src/flow.js');
  const { store, library, cfg } = makeEngine();
  store.set('cards', [{ id: 'AK-0001', title: 'old', stage: 'post_jira', status: 'idle', jiraKey: 'MAR-1', jiraPriority: 'High', log: [{ stage: 'jira', msg: 'x' }], gates: {}, artifacts: {}, reviews: [] }]);
  const flow = new Flow(store, cfg, library);
  const c = flow.card('AK-0001');
  assert.deepEqual([c.stage, c.taskKey, c.priority, c.log[0].stage], ['post', 'MAR-1', 'High', 'intake']);
  assert.equal(c.jiraKey, undefined);
});
