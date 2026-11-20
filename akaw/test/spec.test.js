import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIdea } from '../src/spec.js';
import { seed } from './helpers.js';
const games = seed('games');

test('the handoff sentence becomes the expected spec fields', () => {
  const s = parseIdea('Solitaire Cash, 30 seconds. The player clears a short Klondike board and a prize counter climbs. Winter look.', games);
  assert.equal(s.fields.game.value, 'solitaire-cash');
  assert.equal(s.fields.game.status, 'resolved');
  assert.equal(s.fields.archetype.label, 'Straight play with a seasonal skin');
  assert.equal(s.fields.archetype.status, 'to-confirm');
  assert.equal(s.fields.core.value, 'klondike');
  assert.equal(s.fields.core.status, 'resolved');
  assert.equal(s.fields.length.value, 30);
  assert.equal(s.fields.prize.status, 'asked');
  assert.equal(s.fields.winLine.value, 'You Can Win');
  assert.equal(s.fields.winLine.status, 'from-guardrails');
  assert.ok(s.questions.some((q) => q.field === 'prize'));
  assert.equal(s.complete, false);
});

test('a prize figure is never invented and must be on the approved list', () => {
  const g = structuredClone(games);
  g[0].approvedPrizes = ['50'];
  const ok = parseIdea('Solitaire Cash 30s Klondike, win $50', g);
  assert.equal(ok.fields.prize.status, 'resolved');
  const bad = parseIdea('Solitaire Cash 30s Klondike, win $5,000', g);
  assert.equal(bad.fields.prize.status, 'blocked');
  assert.equal(bad.complete, false);
});

test('no core match is asked; "new mechanic" is flagged; near miss and versus are read', () => {
  const asked = parseIdea('Mahjong Cash 30s tiles fall', games);
  assert.equal(asked.fields.core.status, 'asked');
  const flagged = parseIdea('Mahjong Cash new mechanic: tiles fall, 30s', games);
  assert.equal(flagged.fields.core.status, 'flagged');
  assert.equal(flagged.newMechanic, true);
  assert.equal(parseIdea('Solitaire Cash near miss klondike 20s', games).fields.archetype.value, 'near miss');
  assert.equal(parseIdea('Solitaire Cash klondike head to head 20s', games).fields.archetype.value, 'versus');
});

test('two games in one text asks which one (one creative per game)', () => {
  const s = parseIdea('Solitaire Cash and Mahjong Cash 30s', games);
  assert.equal(s.fields.game.status, 'asked');
});

test('overrides answer questions and RT drops store badges', () => {
  const s = parseIdea('Solitaire Cash RT klondike', games, { overrides: { length: 20, prize: '10' }, title: 'RT test' });
  assert.equal(s.fields.length.value, 20);
  assert.equal(s.fields.route.value, 'RT');
  assert.ok(!s.elements.includes('store badges'));
});
