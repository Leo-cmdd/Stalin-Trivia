// The playable flow: 17 steps, 4 operator yeses, 1 loop back (notes return as a P0 card).
export const STAGES = [
  { id: 'intake', label: 'Task card', kind: 'agent', note: 'tracker sync' },
  { id: 'prep', label: 'Prep', kind: 'agent', note: 'cards queue' },
  { id: 'brief', label: 'Brief', kind: 'agent', note: 'Briefer: text to spec' },
  { id: 'draft', label: 'Draft', kind: 'agent', note: 'real draft + screenshots' },
  { id: 'concept_lock', label: 'Concept lock', kind: 'gate', note: 'you say yes' },
  { id: 'art', label: 'Art', kind: 'agent', note: 'generators, inside the ceiling' },
  { id: 'build', label: 'Build', kind: 'agent', note: 'Builder' },
  { id: 'qa', label: 'QA', kind: 'agent', note: 'copy layer, guardrails, secrets' },
  { id: 'batch_link', label: 'Batch link', kind: 'agent', note: 'one batch' },
  { id: 'deploy', label: 'Deploy', kind: 'gate', note: 'you run it' },
  { id: 'link_review', label: 'Link review', kind: 'gate', note: 'you say yes' },
  { id: 'post', label: 'Post to task', kind: 'agent', note: 'exact comment' },
  { id: 'reviewers', label: 'Reviewers', kind: 'external', note: 'on the task card' },
  { id: 'triage', label: 'Triage notes', kind: 'agent', note: 'whole thread' },
  { id: 'close', label: 'Close', kind: 'gate', note: 'you say yes' },
  { id: 'exports', label: 'Exports', kind: 'agent', note: 'preview, 15s 30s 59s' },
  { id: 'done', label: 'Done', kind: 'end', note: '' },
];

export const STAGE = Object.fromEntries(STAGES.map((s, i) => [s.id, { ...s, index: i }]));
export const GATES = STAGES.filter((s) => s.kind === 'gate').map((s) => s.id);

// Board layout mirrors the flow diagram: four rows.
export const BOARD_ROWS = [
  ['intake', 'prep', 'brief', 'draft', 'concept_lock'],
  ['art', 'build', 'qa', 'batch_link', 'deploy'],
  ['link_review', 'post', 'reviewers', 'close', 'exports'],
  ['triage', 'done'],
];

export const TIERS = {
  P0: 'Feedback fix',
  P1: 'Close out',
  P2: 'New variant',
  P3: 'New mechanic',
};

export const DEFAULT_LENGTHS = [15, 30, 59];

// Older data used jira / post_jira as stage ids.
export const STAGE_ALIASES = { jira: 'intake', post_jira: 'post' };

export function stagesFor(trackerName) {
  return STAGES.map((s) => (s.id === 'intake' ? { ...s, label: `${trackerName} card` } : s.id === 'post' ? { ...s, label: `Post to ${trackerName}` } : s));
}

export function stageIndex(id) {
  return STAGE[id]?.index ?? -1;
}

export function isBefore(a, b) {
  return stageIndex(a) < stageIndex(b);
}
