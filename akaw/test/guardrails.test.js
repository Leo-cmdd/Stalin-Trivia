import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, findPhrase, validateRule, validateException, scopesFor } from '../src/guardrails.js';
import { seed } from './helpers.js';
const rules = seed('rules');
const games = seed('games');

const sc = games[0];
const ctx = { clientId: 'papaya', gameId: 'solitaire-cash', route: 'UA', game: sc };

test('phrase match ignores code names', () => {
  assert.ok(findPhrase('Tap to Cash Out now', 'cash out'));
  assert.equal(findPhrase('showCashOut()', 'cash out'), null);
  assert.equal(findPhrase('cash_out_btn', 'cash out'), null);
  assert.ok(findPhrase('YOU WON!', 'you won'));
  assert.ok(findPhrase('Win big — now', '—'));
});

test('copy rules block, warn and need sign-off at the right layer', () => {
  const r = evaluate(rules, { copy: ['You Won $10!', 'Cash Out today', 'Guaranteed fun', 'Sent to your PayPal'] }, ctx);
  const blocked = r.blocked.map((x) => x.ruleId).sort();
  assert.deepEqual(blocked, ['papaya-you-can-win', 'sc-no-cash-out']);
  assert.ok(r.warnings.some((x) => x.ruleId === 'papaya-copy-flags'));
  assert.ok(r.needsSignoff.some((x) => x.ruleId === 'papaya-paypal-toast'));
  // Cash out is a Solitaire Cash rule; it does not land on Mahjong Cash.
  const mj = evaluate(rules, { copy: ['Cash Out today'] }, { ...ctx, gameId: 'mahjong-cash', game: games[1] });
  assert.ok(!mj.blocked.some((x) => x.ruleId === 'sc-no-cash-out'));
});

test('the idea text only warns; copy blocks', () => {
  const r = evaluate(rules, { copy: ['You Can Win'], idea: 'the player cashes out... cash out button' }, ctx);
  assert.ok(r.ok);
  assert.ok(r.warnings.some((x) => x.ruleId === 'sc-no-cash-out'));
});

test('length cap, prize list, extra tick and RT badges', () => {
  assert.ok(evaluate(rules, { copy: [], lengthSeconds: 59 }, ctx).blocked.some((x) => x.ruleId === 'papaya-round-length'));
  assert.ok(evaluate(rules, { copy: [], lengthSeconds: 45 }, ctx).ok);
  assert.ok(evaluate(rules, { copy: [], prize: '100' }, ctx).blocked.some((x) => x.ruleId === 'team-approved-prizes'));
  assert.ok(evaluate(rules, { copy: [], archetype: 'near miss' }, ctx).needsSignoff.some((x) => x.ruleId === 'team-extra-tick'));
  assert.ok(evaluate(rules, { copy: [], elements: ['store badges', 'legal line'] }, { ...ctx, route: 'RT' }).blocked.some((x) => x.ruleId === 'rt-no-store-badges'));
});

test('an exception loosens one creative only, and needs approver and date', () => {
  const withEx = structuredClone(rules);
  withEx.find((r) => r.id === 'papaya-round-length').exceptions.push({ creative: 'AK-0001', approver: 'X', date: '2026-10-03' });
  assert.ok(evaluate(withEx, { copy: [], lengthSeconds: 59 }, { ...ctx, cardId: 'AK-0001' }).ok);
  assert.ok(!evaluate(withEx, { copy: [], lengthSeconds: 59 }, { ...ctx, cardId: 'AK-0002' }).ok);
  assert.ok(validateException({ creative: 'AK-1', approver: '' }).length);
});

test('a lower layer can only add: no replacing ids, no loosening', () => {
  assert.ok(validateRule({ id: 'sc-no-cash-out', scope: 'game:mahjong-cash', rule: 'x', severity: 'warn', check: { kind: 'manual' } }, rules).length);
  assert.ok(validateRule({ id: 'new-one', scope: 'game:x', rule: 'x', severity: 'warn', check: { kind: 'manual' }, loosens: 'papaya-round-length' }, rules).length);
  assert.deepEqual(validateRule({ id: 'new-one', scope: 'game:x', rule: 'x', severity: 'warn', check: { kind: 'manual' } }, rules), []);
  assert.deepEqual(scopesFor({ clientId: 'papaya', gameId: 'g', route: 'both', cardId: 'AK-1' }), ['team', 'client:papaya', 'channel:UA', 'channel:RT', 'game:g', 'creative:AK-1']);
});
