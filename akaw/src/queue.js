// Queue: four tiers (P0 feedback fix, P1 close out, P2 new variant, P3 new mechanic).
// Inside a tier: task priority, then the sprint that ends first, then the longest wait.
// Pinned cards go first; held cards are skipped by Run queue.
import { STAGE } from './stages.js';

const PRIORITY_RANK = { highest: 0, blocker: 0, critical: 0, high: 1, medium: 2, low: 3, lowest: 4, trivial: 4 };
const CLOSE_OUT = new Set(['link_review', 'post', 'reviewers', 'triage', 'close', 'exports']);

export function computeTier(card) {
  if (card.tierOverride) return card.tierOverride;
  if (card.feedbackFix) return 'P0';
  if (CLOSE_OUT.has(card.stage)) return 'P1';
  if (card.spec?.newMechanic) return 'P3';
  return 'P2';
}

export function compareCards(a, b) {
  if (Boolean(b.pinned) - Boolean(a.pinned)) return Boolean(b.pinned) - Boolean(a.pinned);
  const ta = computeTier(a); const tb = computeTier(b);
  if (ta !== tb) return ta < tb ? -1 : 1;
  const pa = PRIORITY_RANK[String(a.priority || 'medium').toLowerCase()] ?? 2;
  const pb = PRIORITY_RANK[String(b.priority || 'medium').toLowerCase()] ?? 2;
  if (pa !== pb) return pa - pb;
  const sa = a.sprintEnd ? Date.parse(a.sprintEnd) : Infinity;
  const sb = b.sprintEnd ? Date.parse(b.sprintEnd) : Infinity;
  if (sa !== sb) return sa - sb;
  return Date.parse(a.waitingSince || a.createdAt) - Date.parse(b.waitingSince || b.createdAt);
}

export function orderQueue(cards) {
  return cards.filter((c) => c.stage !== 'done').sort(compareCards);
}

// A card Run queue may pick up: not held, not done, not parked at a gate,
// not waiting on you, not blocked by a rule.
export function isRunnable(card) {
  if (card.hold || card.stage === 'done') return false;
  const kind = STAGE[card.stage]?.kind;
  if (kind === 'gate' || kind === 'end') return false;
  if (kind === 'external' && !(card.reviews || []).length) return false;
  if (card.stage === 'batch_link' && card.batchId) return false;
  return !['needs-you', 'blocked', 'running'].includes(card.status);
}
