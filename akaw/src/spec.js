// Text to Scene Spec (the Briefer's front door).
// A field the text does not give is asked, never guessed.
import { normPrize } from './guardrails.js';

export const ARCHETYPES = ['straight play', 'provider payout', 'near miss', 'versus'];

const BASE_ARCHETYPE_RULES = [
  ['near miss', [/near[\s-]?miss/i, /almost (?:won|wins|win)/i, /so close/i]],
  ['versus', [/\bversus\b/i, /\bvs\.?(?=\s)/i, /head[\s-]to[\s-]head/i, /\b1v1\b/i, /against (?:a|an|another) (?:player|opponent|rival)/i]],
  ['provider payout', [/\bpayouts?\b/i, /\bprovider\b/i]],
];
const SEASONAL = /\b(winter|snow\w*|christmas|xmas|holiday|halloween|easter|summer|spring|autumn|fall|valentine'?s?|thanksgiving|new year|seasonal|hanukkah|ramadan|black friday)\b/i;
const MISLEADING = /\b(misleading|fake (?:fail|loss|lose)|fails? on purpose|fail run)\b/i;
const NEW_MECHANIC = /\b(new mechanic|new core|new game ?mode|brand new mechanic)\b/i;
const ART = /\b(ai|generated?|new art|illustrat\w*|character|mascot|new background|3d|render(?:ed)? scene)\b/i;
const LENGTH = /\b(\d{1,3})\s*(?:s|sec|secs|second|seconds)\b/i;
const PRIZE = /\$\s?(\d[\d,]*(?:\.\d{1,2})?)|\b(\d[\d,]*(?:\.\d{1,2})?)\s*(?:dollars|usd)\b/i;
const QUOTED = /"([^"\n]{2,120})"|“([^”\n]{2,120})”/g;

function findGame(text, games) {
  const t = text.toLowerCase();
  const hits = [];
  for (const g of games) {
    const names = [g.name, ...(g.aliases || [])].filter(Boolean).map((n) => n.toLowerCase());
    if (names.some((n) => t.includes(n))) hits.push(g);
  }
  return hits;
}

function findCore(text, game) {
  for (const core of game?.cores || []) {
    const keys = [core.name, ...(core.keywords || [])].filter(Boolean).map((k) => k.toLowerCase());
    if (keys.some((k) => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text))) return core;
  }
  return null;
}

// games: game profiles. opts: { gameId (picked), title, overrides: {field: value} }
export function parseIdea(text, games = [], opts = {}) {
  const idea = String(text || '').trim();
  const overrides = opts.overrides || {};
  const fields = {};
  const questions = [];
  const ask = (field, question, options) => questions.push({ field, question, options: options || null });

  // Game
  const named = findGame(idea, games);
  let game = games.find((g) => g.id === (overrides.game || opts.gameId)) || null;
  if (overrides.game && game) {
    fields.game = { value: game.id, label: game.name, status: 'confirmed' };
  } else if (game && named.length && !named.some((g) => g.id === game.id)) {
    fields.game = { value: game.id, label: game.name, status: 'to-confirm', note: `The text names ${named.map((g) => g.name).join(', ')}` };
    ask('game', `You picked ${game.name} but the text names ${named.map((g) => g.name).join(', ')}. Which game?`, games.map((g) => ({ value: g.id, label: g.name })));
  } else if (game) {
    fields.game = { value: game.id, label: game.name, status: 'resolved' };
  } else if (named.length === 1) {
    game = named[0];
    fields.game = { value: game.id, label: game.name, status: 'resolved' };
  } else {
    fields.game = { value: null, label: null, status: 'asked' };
    ask('game', named.length > 1 ? `The text names ${named.map((g) => g.name).join(' and ')}. One creative per game: which one?` : 'Which game?', games.map((g) => ({ value: g.id, label: g.name })));
  }

  // Archetype
  let base = 'straight play';
  let archetypeStatus = 'to-confirm';
  for (const [name, res] of BASE_ARCHETYPE_RULES) if (res.some((r) => r.test(idea))) { base = name; break; }
  if (/straight play/i.test(idea)) base = 'straight play';
  let skin = SEASONAL.test(idea);
  if (overrides.archetype) {
    base = String(overrides.archetype).replace(/ with a seasonal skin$/, '');
    skin = /seasonal skin/.test(overrides.archetype) || (overrides.skin ?? skin);
    archetypeStatus = 'confirmed';
  }
  const archLabel = `${base[0].toUpperCase()}${base.slice(1)}${skin ? ' with a seasonal skin' : ''}`;
  fields.archetype = { value: base, skin, label: archLabel, status: archetypeStatus, note: archetypeStatus === 'to-confirm' ? 'Read from the text. Confirm at concept lock.' : undefined };

  const misleadingCut = MISLEADING.test(idea);

  // Core and template
  let newMechanic = NEW_MECHANIC.test(idea);
  if (overrides.core) {
    if (overrides.core === '__new__') {
      newMechanic = true;
      fields.core = { value: null, label: 'New mechanic', status: 'flagged', note: 'Goes to playable-mechanic; you review the code.' };
    } else {
      const c = (game?.cores || []).find((x) => x.id === overrides.core);
      fields.core = { value: overrides.core, label: c ? `Existing ${c.name} core` : overrides.core, template: c?.template || null, status: 'confirmed' };
    }
  } else if (newMechanic) {
    fields.core = { value: null, label: 'New mechanic', status: 'flagged', note: 'No core is generated from text. Goes to playable-mechanic; you review the code.' };
  } else {
    const core = findCore(idea, game);
    if (core) fields.core = { value: core.id, label: `Existing ${core.name} core`, template: core.template || null, status: 'resolved' };
    else {
      fields.core = { value: null, label: null, status: 'asked', note: 'If no core fits, it is flagged as a new mechanic.' };
      ask('core', game ? `Which core and template for ${game.name}?` : 'Which core and template?', [
        ...(game?.cores || []).map((c) => ({ value: c.id, label: `${c.name} core` })),
        { value: '__new__', label: 'None fits: new mechanic' },
      ]);
    }
  }

  // Length
  const lm = idea.match(LENGTH);
  const lengthVal = overrides.length ? Number(overrides.length) : lm ? Number(lm[1]) : null;
  if (lengthVal) fields.length = { value: lengthVal, label: `${lengthVal}s`, status: overrides.length ? 'confirmed' : 'resolved', note: 'Exports still ship 15s, 30s and 59s.' };
  else {
    fields.length = { value: null, label: null, status: 'asked', note: 'Rounds run up to 30s, longer up to 45s.' };
    ask('length', 'How long is the round, in seconds?', [15, 30, 45].map((v) => ({ value: v, label: `${v}s` })));
  }

  // Prize figure: must be on an approved card, never invented.
  const pm = idea.match(PRIZE);
  const prizeRaw = overrides.prize ?? (pm ? (pm[1] || pm[2]) : null);
  const approved = (game?.approvedPrizes || []).map(normPrize);
  if (prizeRaw != null && prizeRaw !== '') {
    const p = normPrize(prizeRaw);
    const ok = approved.includes(p);
    fields.prize = { value: p, label: `$${p}`, status: ok ? (overrides.prize ? 'confirmed' : 'resolved') : 'blocked', note: ok ? 'On the approved list.' : 'Not on the approved list for this game.' };
  } else {
    fields.prize = { value: null, label: null, status: 'asked', note: 'Must be a figure on an approved card.' };
    ask('prize', approved.length ? 'Which prize figure? Only approved figures can be used.' : `Which prize figure? ${game ? game.name : 'This game'} has no approved figures on file yet, so add one to the game profile first.`, approved.map((p) => ({ value: p, label: `$${p}` })));
  }

  // Win line comes from the game's guardrails.
  const winLine = game?.winLine || 'You Can Win';
  fields.winLine = { value: winLine, label: `"${winLine}"`, status: 'from-guardrails' };

  // Route. RT is proposed at close only when the card title says RT.
  const titleSaysRT = /\bRT\b/.test(opts.title || '') || /\bRT\b/.test(idea);
  const route = overrides.route || (titleSaysRT ? 'RT' : 'UA');
  fields.route = { value: route, label: route, status: overrides.route ? 'confirmed' : titleSaysRT ? 'to-confirm' : 'resolved', note: titleSaysRT ? 'RT playables carry no store badges.' : undefined };

  // Art
  const needsArt = overrides.needsArt != null ? Boolean(overrides.needsArt) : ART.test(idea) || skin;
  fields.needsArt = { value: needsArt, label: needsArt ? 'Yes: one credit quote at concept lock' : 'No', status: overrides.needsArt != null ? 'confirmed' : needsArt ? 'to-confirm' : 'resolved' };

  // Copy lines: quoted text in the idea, plus the win line.
  const copy = [winLine];
  for (const m of idea.matchAll(QUOTED)) copy.push(m[1] || m[2]);

  // Elements the playable must carry, from the game profile; RT drops store badges.
  let elements = [...(game?.requiredElements || [])];
  if (route === 'RT') elements = elements.filter((e) => e !== 'store badges');

  const minLength = overrides.minLength ? Number(overrides.minLength) : null;

  return {
    text: idea,
    gameId: fields.game.value,
    clientId: game?.clientId || null,
    fields,
    questions,
    copy,
    elements,
    newMechanic,
    misleadingCut,
    minLength,
    lengths: [15, 30, 59],
    complete: !Object.values(fields).some((f) => f.status === 'asked' || f.status === 'blocked'),
  };
}

// The subject a spec presents to the guardrails.
export function specSubject(spec, assets = []) {
  return {
    copy: spec.copy,
    idea: spec.text,
    lengthSeconds: spec.fields.length?.value,
    prize: spec.fields.prize?.value,
    archetype: spec.fields.archetype?.value,
    newMechanic: spec.newMechanic,
    misleadingCut: spec.misleadingCut,
    elements: spec.elements,
    assets,
  };
}
