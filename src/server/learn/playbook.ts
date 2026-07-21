/**
 * CHANNEL C, the playbook.
 *
 * Versioned SOP rules. Rules arrive as proposals (from the reflection pass or
 * an operator), get promoted to `active` only on human approval, accrue live
 * precision stats, and are auto-retired when they stop paying rent.
 *
 * The two seed rules are deliberately mediocre: they are the inherited SOP the
 * system is supposed to be caught improving on.
 */

import type {
  AgentActionKind, PlaybookProposal, PlaybookRule, Priority, RuleTrigger,
  SecurityEvent, SimTime,
} from '../../shared/types';
import { hourBucketOf, inHourRange, simHourOf } from '../../shared/types';
import type { PlaybookStore } from '../contracts';

/** A rule must have fired this often before auto-retirement will consider it. */
const RETIRE_MIN_APPLIED = 8;
/** …and have this many ground-truth-scored outcomes, so we never retire on silence. */
const RETIRE_MIN_SCORED = 4;
const RETIRE_PRECISION_FLOOR = 0.55;

const STATUS_ORDER: Record<PlaybookRule['status'], number> = {
  active: 0,
  proposed: 1,
  retired: 2,
  rejected: 3,
};

function emptyStats(): PlaybookRule['stats'] {
  return { applied: 0, agreed: 0, overridden: 0, correct: 0, incorrect: 0, precision: 0 };
}

/**
 * How specific is this trigger? Drives match ordering:
 * zone+hour+source (14+) > zone+type (9) > type-only (1).
 */
function specificity(t: RuleTrigger): number {
  let s = 0;
  if (t.zoneId) s += 8;
  if (t.hourRange) s += 4;
  if (t.sourceIds && t.sourceIds.length > 0) s += 2;
  if (t.types && t.types.length > 0) s += 1;
  if (t.siteId) s += 0.5;
  if (t.condition) s += 0.25;
  return s;
}

// ── condition mini-language ─────────────────────────────────────────────────
// Supported: `<field> <op> <value>`, optionally joined by ` and `. Fields are
// event properties or `metadata.<key>`. Anything we cannot parse is treated as
// prose written for humans and does not constrain the match.

const COND_RE = /^\s*([A-Za-z_][A-Za-z0-9_.]*)\s*(>=|<=|==|!=|=|>|<)\s*(.+?)\s*$/;

function fieldOf(event: SecurityEvent, path: string): string | number | boolean | undefined {
  switch (path) {
    case 'sensorConfidence': return event.sensorConfidence;
    case 'hour': return simHourOf(event.ts);
    case 'hourBucket': return hourBucketOf(event.ts);
    case 'type': return event.type;
    case 'zoneId': return event.zoneId;
    case 'siteId': return event.siteId;
    case 'sourceId': return event.sourceId;
    case 'sourceKind': return event.sourceKind;
    default:
      if (path.startsWith('metadata.')) return event.metadata[path.slice(9)];
      return undefined;
  }
}

function clause(event: SecurityEvent, text: string): boolean {
  const m = COND_RE.exec(text);
  if (!m) return true;
  const lhs = fieldOf(event, m[1]);
  if (lhs === undefined) return true;
  const op = m[2] === '=' ? '==' : m[2];
  const rawRhs = m[3].replace(/^['"]|['"]$/g, '');

  const ln = typeof lhs === 'number' ? lhs : Number(lhs);
  const rn = Number(rawRhs);
  if (Number.isFinite(ln) && Number.isFinite(rn) && rawRhs.trim() !== '') {
    switch (op) {
      case '>': return ln > rn;
      case '<': return ln < rn;
      case '>=': return ln >= rn;
      case '<=': return ln <= rn;
      case '==': return ln === rn;
      case '!=': return ln !== rn;
      default: return true;
    }
  }

  const ls = String(lhs).toLowerCase();
  const rs = rawRhs.toLowerCase();
  if (op === '==') return ls === rs;
  if (op === '!=') return ls !== rs;
  return true;
}

function conditionHolds(event: SecurityEvent, condition: string | null): boolean {
  if (!condition) return true;
  return condition.split(/\s+and\s+/i).every((c) => clause(event, c));
}

function triggerMatches(t: RuleTrigger, event: SecurityEvent): boolean {
  if (t.siteId && t.siteId !== event.siteId) return false;
  if (t.zoneId && t.zoneId !== event.zoneId) return false;
  if (t.types && t.types.length > 0 && !t.types.includes(event.type)) return false;
  if (t.hourRange && !inHourRange(simHourOf(event.ts), t.hourRange)) return false;
  if (t.sourceIds && t.sourceIds.length > 0 && !t.sourceIds.includes(event.sourceId)) return false;
  return conditionHolds(event, t.condition);
}

function cloneRule(r: PlaybookRule): PlaybookRule {
  return {
    ...r,
    trigger: { ...r.trigger, types: [...r.trigger.types], sourceIds: r.trigger.sourceIds ? [...r.trigger.sourceIds] : null },
    evidenceIncidentIds: [...r.evidenceIncidentIds],
    stats: { ...r.stats },
  };
}

// ── seeds ───────────────────────────────────────────────────────────────────

/**
 * Two intentionally bad inherited SOPs.
 *
 * SEED-1 over-dispatches (drives false-dispatch rate up until reflection
 * narrows it). SEED-2 over-suppresses daytime robot traffic and will swallow a
 * real package theft or loiter, which is what shows up as missed criticals.
 * Both exist so `autoRetire` and the reflection pass have something to bite on.
 */
export function seedRules(now: SimTime): PlaybookRule[] {
  const mk = (
    id: string,
    title: string,
    trigger: RuleTrigger,
    action: AgentActionKind,
    priorityFloor: Priority | null,
    falseAlarmMultiplier: number,
    rationale: string,
  ): PlaybookRule => ({
    id,
    version: 1,
    status: 'active',
    title,
    trigger,
    action,
    priorityFloor,
    falseAlarmMultiplier,
    rationale,
    author: 'seed',
    evidenceIncidentIds: [],
    createdAt: now,
    updatedAt: now,
    stats: emptyStats(),
  });

  return [
    mk(
      'RULE-SEED-1',
      'Dispatch on any motion detection',
      { siteId: null, zoneId: null, types: ['motion_detected'], hourRange: null, sourceIds: null, condition: null },
      'dispatch',
      'P2',
      0.5,
      'Inherited from the previous vendor SOP: every motion hit gets a body. Blanket coverage, no zone or time discrimination.',
    ),
    mk(
      'RULE-SEED-2',
      'Daytime robot noise filter',
      {
        siteId: null,
        zoneId: null,
        types: ['motion_detected', 'loitering', 'robot_obstruction', 'package_theft'],
        hourRange: { start: 8, end: 18 },
        sourceIds: null,
        condition: 'sourceKind == robot',
      },
      'suppress',
      null,
      2.2,
      'Inherited: robot sensors were noisy during the pilot, so everything they raise in business hours is filtered. Never revisited after the fleet was upgraded.',
    ),
  ];
}

// ── store ───────────────────────────────────────────────────────────────────

export class Playbook implements PlaybookStore {
  private byId = new Map<string, PlaybookRule>();
  private proposals_: PlaybookProposal[] = [];

  constructor(private seededAt: SimTime) {
    for (const r of seedRules(seededAt)) this.byId.set(r.id, r);
  }

  match(event: SecurityEvent): PlaybookRule[] {
    return [...this.byId.values()]
      .filter((r) => r.status === 'active' && triggerMatches(r.trigger, event))
      .sort((a, b) => {
        const d = specificity(b.trigger) - specificity(a.trigger);
        if (d !== 0) return d;
        if (b.version !== a.version) return b.version - a.version;
        if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
        return a.id < b.id ? -1 : 1;
      })
      .map(cloneRule);
  }

  rules(): PlaybookRule[] {
    return [...this.byId.values()]
      .sort((a, b) => {
        const d = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
        if (d !== 0) return d;
        const s = specificity(b.trigger) - specificity(a.trigger);
        if (s !== 0) return s;
        if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
        return a.id < b.id ? -1 : 1;
      })
      .map(cloneRule);
  }

  proposals(): PlaybookProposal[] {
    return this.proposals_
      .map((p) => ({ ...p, rules: p.rules.map(cloneRule), retire: p.retire.map((r) => ({ ...r })) }))
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1));
  }

  addProposal(p: PlaybookProposal): void {
    // Proposed rules live inside the proposal until approved, `rules()` stays
    // the real SOP book, not a mix of drafts and policy.
    const stored: PlaybookProposal = {
      ...p,
      status: p.status ?? 'pending',
      rules: p.rules.map((r) => ({ ...cloneRule(r), status: 'proposed' as const })),
      retire: p.retire.map((r) => ({ ...r })),
    };
    const existing = this.proposals_.findIndex((q) => q.id === stored.id);
    if (existing >= 0) this.proposals_[existing] = stored;
    else this.proposals_.push(stored);
  }

  /**
   * Retirements listed on the proposal are applied unless their rule id was
   * explicitly rejected, so the UI can drive accept/reject with one id list.
   * `now` is optional (PlaybookStore carries no clock); we fall back to the
   * proposal's own timestamp rather than reaching for wall-clock time.
   */
  applyProposal(
    proposalId: string,
    acceptedRuleIds: string[],
    rejectedRuleIds: string[],
    now?: SimTime,
  ): void {
    const proposal = this.proposals_.find((p) => p.id === proposalId);
    if (!proposal || proposal.status !== 'pending') return;

    const ts = now ?? proposal.createdAt;
    const accepted = new Set(acceptedRuleIds);
    const rejected = new Set(rejectedRuleIds);

    for (const draft of proposal.rules) {
      if (!accepted.has(draft.id)) {
        draft.status = 'rejected';
        draft.updatedAt = ts;
        continue;
      }

      const superseded = draft.supersedesRuleId ? this.byId.get(draft.supersedesRuleId) : undefined;
      const promoted = cloneRule(draft);
      promoted.status = 'active';
      promoted.version = superseded ? superseded.version + 1 : Math.max(1, draft.version);
      promoted.updatedAt = ts;
      // A revision starts its own scorecard; inheriting the parent's precision
      // would hide whether the edit actually helped.
      promoted.stats = emptyStats();

      if (superseded) {
        superseded.status = 'retired';
        superseded.retiredReason = `Superseded by "${promoted.title}" (v${promoted.version}).`;
        superseded.updatedAt = ts;
      }

      this.byId.set(promoted.id, promoted);
      draft.status = 'active';
      draft.version = promoted.version;
      draft.updatedAt = ts;
    }

    for (const { ruleId, reason } of proposal.retire) {
      if (rejected.has(ruleId)) continue;
      this.setRuleStatus(ruleId, 'retired', reason, ts);
    }

    proposal.status = 'applied';
  }

  dismissProposal(proposalId: string): void {
    const proposal = this.proposals_.find((p) => p.id === proposalId);
    if (!proposal || proposal.status !== 'pending') return;
    proposal.status = 'dismissed';
    for (const draft of proposal.rules) draft.status = 'rejected';
  }

  setRuleStatus(ruleId: string, status: PlaybookRule['status'], reason?: string, now?: SimTime): void {
    const rule = this.byId.get(ruleId);
    if (!rule) return;
    rule.status = status;
    rule.updatedAt = now ?? rule.updatedAt;
    if (status === 'retired') rule.retiredReason = reason ?? 'Retired by operator.';
    else delete rule.retiredReason;
  }

  noteApplied(ruleIds: string[]): void {
    for (const id of ruleIds) {
      const rule = this.byId.get(id);
      if (rule) rule.stats.applied += 1;
    }
  }

  noteOutcome(ruleIds: string[], correct: boolean, overridden: boolean): void {
    for (const id of ruleIds) {
      const rule = this.byId.get(id);
      if (!rule) continue;
      if (correct) rule.stats.correct += 1;
      else rule.stats.incorrect += 1;
      if (overridden) rule.stats.overridden += 1;
      else rule.stats.agreed += 1;
      const scored = rule.stats.correct + rule.stats.incorrect;
      rule.stats.precision = scored > 0 ? Math.round((rule.stats.correct / scored) * 1e4) / 1e4 : 0;
    }
  }

  autoRetire(now: SimTime): string[] {
    const retired: string[] = [];
    for (const rule of this.byId.values()) {
      if (rule.status !== 'active') continue;
      const { applied, correct, incorrect, precision } = rule.stats;
      const scored = correct + incorrect;
      if (applied < RETIRE_MIN_APPLIED || scored < RETIRE_MIN_SCORED) continue;
      if (precision >= RETIRE_PRECISION_FLOOR) continue;
      rule.status = 'retired';
      rule.updatedAt = now;
      rule.retiredReason =
        `Auto-retired after ${applied} applications: precision ${Math.round(precision * 100)}% ` +
        `(${correct} correct / ${scored} scored) is below the ${Math.round(RETIRE_PRECISION_FLOOR * 100)}% floor.`;
      retired.push(rule.id);
    }
    return retired.sort();
  }

  reset(): void {
    this.byId.clear();
    this.proposals_ = [];
    // The inherited SOP is part of the world, not something we learned, a
    // memory wipe puts the mediocre rules back so the demo can rerun.
    for (const r of seedRules(this.seededAt)) this.byId.set(r.id, r);
  }
}
