// Guardrails: rule records in four layers (team > client > game > creative, plus channel).
// A lower layer can only add or tighten. Loosening is only a recorded exception
// on one creative, with who approved it and when.
import { scanText } from './secrets.js';

export const SEVERITIES = ['warn', 'needs-signoff', 'block'];
export const CHECK_KINDS = [
  'forbidden-phrase', 'max-length', 'approved-prize', 'required-element', 'forbidden-element',
  'human-tick', 'allowed-assets', 'asset-tag-only', 'asset-flag', 'no-secrets', 'manual',
];
export const LAYERS = ['team', 'client', 'channel', 'game', 'creative'];

export function layerOf(scope) {
  return String(scope || '').split(':')[0];
}

export function scopesFor({ clientId, gameId, route, cardId } = {}) {
  const s = ['team'];
  if (clientId) s.push(`client:${clientId}`);
  if (route) for (const r of route === 'both' ? ['UA', 'RT'] : [route]) s.push(`channel:${r}`);
  if (gameId) s.push(`game:${gameId}`);
  if (cardId) s.push(`creative:${cardId}`);
  return s;
}

export function applicableRules(rules, ctx) {
  const scopes = scopesFor(ctx);
  return rules.filter((r) => (r.status || 'active') === 'active' && scopes.includes(r.scope));
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const normalize = (t) => String(t ?? '')
  .replace(/[‘’]/g, "'")
  .replace(/[“”]/g, '"');

// Phrase match, case-insensitive, on word boundaries. Code names such as cashOut or
// cash_out do not match "cash out", the way the existing copy check ignores them.
export function findPhrase(text, phrase) {
  const p = escapeRe(normalize(phrase).trim()).replace(/\s+/g, '[\\s\\u00a0]+');
  const start = /^\w/.test(phrase) ? '(?<![\\w])' : '';
  const end = /\w$/.test(phrase) ? '(?![\\w])' : '';
  const m = normalize(text).match(new RegExp(start + p + end, 'i'));
  return m ? m[0] : null;
}

function describeCheck(check = {}) {
  switch (check.kind) {
    case 'forbidden-phrase': return `Copy must not contain: ${(check.phrases || []).map((p) => `"${p}"`).join(', ')}`;
    case 'max-length': return `Round length up to ${check.seconds}s unless an exception is recorded`;
    case 'approved-prize': return 'Prize figure must be on the game\'s approved list';
    case 'required-element': return `Must carry: ${(check.elements || []).join(', ')}`;
    case 'forbidden-element': return `Must not carry: ${(check.elements || []).join(', ')}`;
    case 'human-tick': return `Extra tick at ${check.gate || 'concept_lock'} for ${[...(check.archetypes || []), check.newMechanic ? 'new mechanic' : null, check.misleadingCut ? 'misleading cut' : null].filter(Boolean).join(', ')}`;
    case 'allowed-assets': return `Kit assets must be ${(check.levels || []).join(' or ')} and approved`;
    case 'asset-tag-only': return `Assets tagged "${check.tag}" only for: ${(check.games || []).join(', ')}`;
    case 'asset-flag': return `Assets flagged ${(check.flags || []).join(', ')} are not allowed`;
    case 'no-secrets': return 'No keys, tokens or passwords in the bundle';
    case 'manual': return 'Human review';
    default: return check.kind || 'unknown';
  }
}

// subject: { copy: string[], idea?: string, lengthSeconds?, prize?, archetype?, newMechanic?,
//            misleadingCut?, elements?: string[], assets?: asset[], files?: [{path,text}], stage? }
// ctx: { clientId, gameId, route, cardId, game }
export function checkRule(rule, subject, ctx = {}) {
  const c = rule.check || { kind: 'manual' };
  const fail = (message) => ({ outcome: 'fail', message });
  const pass = (message = 'ok') => ({ outcome: 'pass', message });
  const copy = (subject.copy || []).filter(Boolean);

  switch (c.kind) {
    case 'forbidden-phrase': {
      for (const phrase of c.phrases || []) {
        for (const line of copy) {
          const hit = findPhrase(line, phrase);
          if (hit) return fail(`"${hit}" in copy: "${String(line).slice(0, 80)}"`);
        }
      }
      if (subject.idea) {
        for (const phrase of c.phrases || []) {
          const hit = findPhrase(subject.idea, phrase);
          if (hit) return { outcome: 'fail', message: `The idea mentions "${hit}". Keep it out of the copy.`, downgrade: 'warn' };
        }
      }
      return pass();
    }
    case 'max-length': {
      const len = Number(subject.lengthSeconds);
      if (!len) return { outcome: 'pass', message: 'length not set yet' };
      if (len > c.seconds) return fail(`${len}s is over the ${c.seconds}s cap`);
      if (c.softSeconds && len > c.softSeconds) return { outcome: 'pass', message: `${len}s is over ${c.softSeconds}s, allowed up to ${c.seconds}s` };
      return pass();
    }
    case 'approved-prize': {
      if (subject.prize == null || subject.prize === '') return pass('no prize figure yet');
      const list = (ctx.game?.approvedPrizes || []).map((p) => normPrize(p));
      if (!list.includes(normPrize(subject.prize))) {
        return fail(`$${normPrize(subject.prize)} is not on ${ctx.game?.name || 'the game'}'s approved prize list${list.length ? ` (${list.map((p) => `$${p}`).join(', ')})` : ' (the list is empty)'}`);
      }
      return pass();
    }
    case 'required-element': {
      if (!subject.elements) return pass('checked at QA');
      const missing = (c.elements || []).filter((e) => !subject.elements.includes(e));
      return missing.length ? fail(`Missing: ${missing.join(', ')}`) : pass();
    }
    case 'forbidden-element': {
      const present = (c.elements || []).filter((e) => (subject.elements || []).includes(e));
      return present.length ? fail(`Must not carry: ${present.join(', ')}`) : pass();
    }
    case 'human-tick': {
      const reasons = [];
      const base = subject.archetype || '';
      for (const a of c.archetypes || []) if (base === a) reasons.push(a);
      if (c.newMechanic && subject.newMechanic) reasons.push('new mechanic');
      if (c.misleadingCut && subject.misleadingCut) reasons.push('misleading cut');
      return reasons.length ? fail(`Needs an extra tick at concept lock: ${reasons.join(', ')}`) : pass();
    }
    case 'allowed-assets': {
      const bad = (subject.assets || []).filter((a) => !(c.levels || []).includes(a.level) || (a.status !== 'approved'));
      return bad.length ? fail(`Not Library/approved: ${bad.map((a) => a.name || a.id).join(', ')}`) : pass();
    }
    case 'asset-tag-only': {
      if ((c.games || []).includes(ctx.gameId)) return pass();
      const bad = (subject.assets || []).filter((a) => (a.tags || []).includes(c.tag));
      return bad.length ? fail(`"${c.tag}" asset used outside ${c.games.join(', ')}: ${bad.map((a) => a.name).join(', ')}`) : pass();
    }
    case 'asset-flag': {
      const bad = (subject.assets || []).filter((a) => (a.flags || []).some((f) => (c.flags || []).includes(f)));
      return bad.length ? fail(`Flagged assets: ${bad.map((a) => `${a.name} (${a.flags.join(', ')})`).join('; ')}`) : pass();
    }
    case 'no-secrets': {
      const hits = [];
      for (const f of subject.files || []) for (const h of scanText(f.text)) hits.push(`${h.type} in ${f.path}`);
      for (const line of copy) for (const h of scanText(line)) hits.push(`${h.type} in copy`);
      return hits.length ? fail(`Possible secret: ${hits.slice(0, 5).join('; ')}`) : pass();
    }
    case 'manual':
    default:
      return { outcome: 'manual', message: rule.rule };
  }
}

export function normPrize(p) {
  const n = Number(String(p).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? String(n) : String(p);
}

export function evaluate(rules, subject, ctx = {}) {
  const results = [];
  for (const rule of applicableRules(rules, ctx)) {
    const r = checkRule(rule, subject, ctx);
    let severity = r.downgrade || rule.severity;
    let outcome = r.outcome;
    let exception = null;
    if (outcome === 'fail' && ctx.cardId) {
      exception = (rule.exceptions || []).find((e) => e.creative === ctx.cardId);
      if (exception) outcome = 'excepted';
    }
    results.push({
      ruleId: rule.id,
      scope: rule.scope,
      layer: layerOf(rule.scope),
      severity,
      outcome,
      message: r.message,
      rule: rule.rule,
      owner: rule.owner || null,
      source: rule.source || null,
      exception,
    });
  }
  const fails = results.filter((r) => r.outcome === 'fail');
  return {
    results,
    blocked: fails.filter((r) => r.severity === 'block'),
    needsSignoff: fails.filter((r) => r.severity === 'needs-signoff'),
    warnings: fails.filter((r) => r.severity === 'warn'),
    manual: results.filter((r) => r.outcome === 'manual'),
    ok: !fails.some((r) => r.severity === 'block'),
  };
}

export function validateRule(rule, existing = []) {
  const errors = [];
  if (!rule || typeof rule !== 'object') return ['rule must be an object'];
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(rule.id || '')) errors.push('id: lowercase letters, digits and dashes');
  if (existing.some((r) => r.id === rule.id)) errors.push(`id "${rule.id}" already exists. A lower layer adds a new rule; it never replaces one.`);
  const layer = layerOf(rule.scope);
  if (!LAYERS.includes(layer)) errors.push(`scope must start with one of ${LAYERS.join(', ')}`);
  if (layer !== 'team' && !/^[a-z]+:[A-Za-z0-9-]+$/.test(rule.scope || '')) errors.push('scope looks like game:solitaire-cash');
  if (!SEVERITIES.includes(rule.severity)) errors.push(`severity must be ${SEVERITIES.join(', ')}`);
  if (!rule.rule || !String(rule.rule).trim()) errors.push('rule text is required');
  if (!CHECK_KINDS.includes(rule.check?.kind)) errors.push(`check.kind must be one of ${CHECK_KINDS.join(', ')}`);
  if (rule.overrides || rule.loosens) errors.push('A rule cannot loosen another. Record an exception on the creative instead.');
  if (rule.check?.kind === 'forbidden-phrase' && !(rule.check.phrases || []).length) errors.push('forbidden-phrase needs phrases');
  if (rule.check?.kind === 'max-length' && !(Number(rule.check.seconds) > 0)) errors.push('max-length needs seconds');
  return errors;
}

export function validateException(ex) {
  const errors = [];
  if (!ex?.creative) errors.push('creative (card id) is required');
  if (!ex?.approver) errors.push('approver is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ex?.date || '')) errors.push('date is required, as YYYY-MM-DD');
  return errors;
}

export { describeCheck };
