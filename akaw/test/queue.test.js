import test from 'node:test';
import assert from 'node:assert/strict';
import { orderQueue, computeTier, isRunnable } from '../src/queue.js';

const base = { stage: 'brief', status: 'idle', createdAt: '2026-11-01T00:00:00Z', reviews: [] };

test('tiers, then priority, then sprint end, then longest wait; pins first', () => {
  const cards = [
    { ...base, id: 'mech', spec: { newMechanic: true } },
    { ...base, id: 'variant-low', priority: 'Low' },
    { ...base, id: 'variant-high', priority: 'High' },
    { ...base, id: 'close', stage: 'close' },
    { ...base, id: 'fix', feedbackFix: true },
    { ...base, id: 'variant-high-sprint', priority: 'High', sprintEnd: '2026-11-21' },
    { ...base, id: 'pinned', spec: { newMechanic: true }, pinned: true },
  ];
  assert.deepEqual(orderQueue(cards).map((c) => c.id), ['pinned', 'fix', 'close', 'variant-high-sprint', 'variant-high', 'variant-low', 'mech']);
  assert.equal(computeTier({ ...base, tierOverride: 'P3', feedbackFix: true }), 'P3');
});

test('run queue skips held cards, gates and waiting cards', () => {
  assert.equal(isRunnable({ ...base }), true);
  assert.equal(isRunnable({ ...base, hold: true }), false);
  assert.equal(isRunnable({ ...base, stage: 'concept_lock' }), false);
  assert.equal(isRunnable({ ...base, status: 'needs-you' }), false);
  assert.equal(isRunnable({ ...base, stage: 'reviewers' }), false);
  assert.equal(isRunnable({ ...base, stage: 'reviewers', reviews: [{}] }), true);
});
