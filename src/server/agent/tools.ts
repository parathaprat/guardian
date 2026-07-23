/**
 * The agent's instruments: six evidence tools plus one terminal tool. Every tool returns a trace
 * `label`, a JSON `result`, and `evidence` citing what was consulted; both engines share them so
 * the trace renders identically. With `ctx.useMemory` false, memory-backed tools answer
 * "no memory available" instead of reading the stores, which is what makes the A/B eval honest.
 */

import type {
  AgentActionKind, AgentDecision, CalibrationLookup, EvidenceRef, EventType,
  Priority, ResolutionOutcome, Severity, Skill,
} from '../../shared/types';
import { ALL_EVENT_TYPES, EVENT_LABELS, PRIORITY_ORDER, priorityFromSeverity } from '../../shared/types';
import type { AgentContext } from '../contracts';

// ─────────────────────────────────────────────────────────────────────────────
//  STATIC DOMAIN KNOWLEDGE (the agent's *prior*, not its memory)
// ─────────────────────────────────────────────────────────────────────────────

export interface TypeProfile {
  /** Base P(real) before any zone/hour calibration. */
  prior: number;
  /** Base severity if the event turns out to be real. */
  severity: number;
  skill: Skill | null;
  note: string;
}

/**
 * Deliberately separate from the calibration store: this is what a competent operator knows on
 * day one, overridden by the learned posterior as evidence accumulates.
 */
export const TYPE_PROFILE: Record<EventType, TypeProfile> = {
  motion_detected:      { prior: 0.16, severity: 2, skill: null,             note: 'highest nuisance rate of any signal, wildlife, HVAC plumes, rain on lenses' },
  door_forced:          { prior: 0.62, severity: 4, skill: 'armed',          note: 'strong intrusion indicator; rarely benign outside maintenance windows' },
  door_propped:         { prior: 0.58, severity: 2, skill: 'access_control', note: 'usually policy violation rather than intrusion, but it defeats the perimeter' },
  glass_break:          { prior: 0.48, severity: 4, skill: 'armed',          note: 'acoustic sensors false on dropped pallets and thunder' },
  tailgating:           { prior: 0.44, severity: 3, skill: 'access_control', note: 'common at shift change; treat differently inside and outside those windows' },
  loitering:            { prior: 0.33, severity: 2, skill: 'de_escalation',  note: 'dwell-time heuristics fire on smokers, couriers and rideshare pickups' },
  person_down:          { prior: 0.70, severity: 5, skill: 'medical',        note: 'life-safety; the cost of being wrong is asymmetric to the point of absurdity' },
  fire_alarm:           { prior: 0.34, severity: 5, skill: 'fire',           note: 'mostly nuisance, but the one real one justifies every roll' },
  vehicle_unauthorized: { prior: 0.41, severity: 3, skill: null,             note: 'plate/permit mismatches are frequently stale-database errors' },
  perimeter_breach:     { prior: 0.50, severity: 4, skill: 'armed',          note: 'fence-line sensors correlate strongly with adjacent-zone motion when real' },
  robot_obstruction:    { prior: 0.64, severity: 1, skill: 'technical',      note: 'almost always real and almost never important' },
  camera_offline:       { prior: 0.68, severity: 2, skill: 'technical',      note: 'real, but read it as coverage loss, check what it was watching' },
  panic_button:         { prior: 0.58, severity: 5, skill: 'armed',          note: 'life-safety; pocket presses exist but are not worth the gamble' },
  badge_anomaly:        { prior: 0.45, severity: 3, skill: 'access_control', note: 'cloned-credential signal; correlate with the badge holder’s expected location' },
  package_theft:        { prior: 0.38, severity: 2, skill: null,             note: 'usually after the fact, evidence preservation matters more than speed' },
  noise_complaint:      { prior: 0.29, severity: 1, skill: 'de_escalation',  note: 'tenant-reported, subjective, and rarely a security matter' },
};

/** Never suppressed, whatever the calibration says. */
export const LIFE_SAFETY_TYPES: readonly EventType[] = ['person_down', 'fire_alarm', 'panic_button'];

export function isLifeSafety(type: EventType): boolean {
  return LIFE_SAFETY_TYPES.includes(type);
}

export function requiredSkillFor(type: EventType): Skill | null {
  return TYPE_PROFILE[type].skill;
}

// ─────────────────────────────────────────────────────────────────────────────
//  TOOL DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  strict?: boolean;
}

export const SUBMIT_TOOL_NAME = 'submit_decision';

export const TOOL_NAMES = {
  zoneHistory: 'check_zone_history',
  precedent: 'recall_similar_incidents',
  correlate: 'correlate_events',
  playbook: 'consult_playbook',
  responders: 'get_available_responders',
  zoneContext: 'get_zone_context',
} as const;

/** Order is frozen: the tool block renders before `system`, so reordering invalidates the prompt cache. */
export const TOOL_DEFS: ToolDef[] = [
  {
    name: TOOL_NAMES.zoneHistory,
    description:
      'Learned Bayesian calibration: what fraction of alerts of this type, in this zone, in this 3-hour ' +
      'window, turned out to be real once an operator resolved them. This is the single strongest signal ' +
      'you have and it beats the device-reported sensor confidence outright. Returns the posterior mean, ' +
      'the credible-interval half-width, how many resolved observations back it, and which backoff level ' +
      'answered (exact cell / zone+type / site+type / cold prior). Treat fewer than 6 observations as thin.',
    input_schema: {
      type: 'object',
      properties: {
        zone_id: { type: 'string', description: 'Zone id to look up. Defaults to the incident zone.' },
        event_type: { type: 'string', enum: ALL_EVENT_TYPES, description: 'Defaults to the incident event type.' },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.precedent,
    description:
      'Retrieve the most similar resolved incidents from the ledger, with what the agent did and what ' +
      'actually happened. Use it to check whether a decision like the one you are about to make has ' +
      'already been tried here and how it landed. An outcome of "missed" is a past under-reaction; ' +
      '"false_alarm" after a dispatch is a past over-reaction.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'How many precedents to return (1-5). Defaults to 3.' },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.correlate,
    description:
      'Look for a coordinated pattern: multiple events across adjacent zones inside a short window, ' +
      'repeated hits from one source, or a movement track. A confirmed pattern is the main reason to ' +
      'treat an individually-unremarkable alert as serious, because it is evidence a person is moving ' +
      'through the site rather than a sensor misfiring.',
    input_schema: {
      type: 'object',
      properties: {
        window_minutes: { type: 'integer', description: 'Look-back window in minutes (1-60). Defaults to 10.' },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.playbook,
    description:
      'Standing operating procedures that match this event. Rules are authored by the reflection pass ' +
      'and approved by a human supervisor, so an active rule carries real authority, but each one ' +
      'reports its live precision, and a rule below ~0.6 precision should not override fresh evidence. ' +
      'falseAlarmMultiplier above 1 means the rule believes this pattern is noisier than the raw ' +
      'calibration suggests; below 1 means it is more often real.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: TOOL_NAMES.responders,
    description:
      'Who can actually take this call, ranked. Combines simulator-supplied availability and travel time ' +
      'with the learned responder model: pAccept is the posterior probability this responder accepts a ' +
      'dispatch, learned from their own history, not asserted. Call this before any dispatch, a plan to ' +
      'dispatch nobody is an escalation in disguise.',
    input_schema: {
      type: 'object',
      properties: {
        required_skill: {
          type: 'string',
          enum: ['armed', 'medical', 'fire', 'access_control', 'k9', 'de_escalation', 'technical', 'any'],
          description: 'Skill the responder must hold. Use "any" to see everyone. Defaults to the skill implied by the event type.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.zoneContext,
    description:
      'Static facts about the zone plus live occupancy: zone kind, static base risk, adjacent zones, and ' +
      'which robots and on-shift guards are physically in the zone right now. A guard already standing in ' +
      'the zone changes the arithmetic of dispatching completely.',
    input_schema: {
      type: 'object',
      properties: {
        zone_id: { type: 'string', description: 'Zone id. Defaults to the incident zone.' },
      },
      required: [],
    },
  },
  {
    name: SUBMIT_TOOL_NAME,
    description:
      'Commit the dispatch decision. Call this exactly once, last, after you have gathered evidence. ' +
      'responder_id must be a real responder id when action is "dispatch", and the empty string otherwise. ' +
      'recheck_after_minutes only matters for "monitor", use 0 for every other action.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['dispatch', 'escalate', 'monitor', 'suppress'],
          description: 'dispatch = send a named responder. escalate = hand to the human supervisor or emergency services. monitor = hold open and re-evaluate. suppress = close as noise.',
        },
        priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'], description: 'P0 = immediate, P3 = routine.' },
        severity: { type: 'integer', description: 'Expected severity if real: 1 nuisance … 5 life-safety.' },
        confidence: { type: 'number', description: 'Your confidence in this decision, 0 to 1.' },
        false_alarm_probability: { type: 'number', description: 'Your estimate that this event is not real, 0 to 1.' },
        responder_id: { type: 'string', description: 'Responder id when dispatching; empty string otherwise.' },
        instruction: { type: 'string', description: 'The order actually issued to the responder or supervisor. One or two imperative sentences.' },
        rationale: { type: 'string', description: 'Two to three plain sentences for the ops manager on shift. Cite the number that decided it. No hedging, no restating the event.' },
        recheck_after_minutes: { type: 'integer', description: 'Minutes until re-evaluation when monitoring. 0 for other actions.' },
      },
      required: [
        'action', 'priority', 'severity', 'confidence', 'false_alarm_probability',
        'responder_id', 'instruction', 'rationale', 'recheck_after_minutes',
      ],
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
//  TOOL RESULT SHAPES  (shared with the reasoner so it can read its own tools)
// ─────────────────────────────────────────────────────────────────────────────

export interface ColdResult {
  available: false;
  reason: 'memory_disabled';
  note: string;
}

export type ZoneHistoryResult =
  | ColdResult
  | {
      available: true;
      zoneCode: string;
      eventType: EventType;
      pReal: number;
      uncertainty: number;
      observations: number;
      backoff: CalibrationLookup['level'];
      key: string;
      reading: string;
    };

export interface PrecedentMatch {
  incidentId: string;
  zoneCode: string;
  eventType: EventType;
  similarity: number;
  actionTaken: AgentActionKind;
  outcome: ResolutionOutcome;
  summary: string;
}

export type PrecedentResult = ColdResult | { available: true; matches: PrecedentMatch[]; reading: string };

export interface PlaybookMatch {
  ruleId: string;
  title: string;
  action: AgentActionKind;
  priorityFloor: Priority | null;
  falseAlarmMultiplier: number;
  precision: number;
  applied: number;
  rationale: string;
}

export type PlaybookResult = ColdResult | { available: true; rules: PlaybookMatch[]; reading: string };

export interface CorrelationResult {
  patternDetected: boolean;
  label: string;
  severityUplift: number;
  relatedEventIds: string[];
  relatedIncidentIds: string[];
  detail: string;
}

export interface ResponderOption {
  responderId: string;
  name: string;
  kind: 'guard' | 'robot';
  status: string;
  skills: Skill[];
  etaMs: number;
  etaMinutes: number;
  skillMatch: boolean;
  /** Learned P(accepts a dispatch). Null when the responder model is unavailable. */
  pAccept: number | null;
  reason: string;
}

export interface ResponderResult {
  requiredSkill: Skill | null;
  learned: boolean;
  options: ResponderOption[];
  note: string;
}

export interface ZoneContextResult {
  siteCode: string;
  siteName: string;
  zoneCode: string;
  zoneName: string;
  zoneKind: string;
  baseRisk: number;
  adjacentZones: string[];
  robotsInZone: Array<{ id: string; name: string; model: string; batteryPct: number; status: string }>;
  guardsInZone: Array<{ id: string; name: string; status: string; skills: Skill[] }>;
  localHour: number;
  reading: string;
}

export interface ToolOutcome {
  label: string;
  result: unknown;
  evidence: EvidenceRef[];
}

// ─────────────────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const COLD_NOTE =
  'No memory available, this arm runs cold. Decide from the event text, the device-reported sensor ' +
  'confidence and static site facts only. Do not assume a history you cannot see.';

function cold(): ColdResult {
  return { available: false, reason: 'memory_disabled', note: COLD_NOTE };
}

export function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

export function round(n: number, places = 3): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function minutes(ms: number): number {
  return Math.round((ms / 60_000) * 10) / 10;
}

function str(input: Record<string, unknown>, key: string): string | null {
  const v = input[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function num(input: Record<string, unknown>, key: string): number | null {
  const v = input[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function asEventType(v: string | null): EventType | null {
  return v !== null && (ALL_EVENT_TYPES as string[]).includes(v) ? (v as EventType) : null;
}

const ALL_SKILLS: readonly Skill[] = ['armed', 'medical', 'fire', 'access_control', 'k9', 'de_escalation', 'technical'];

function asSkill(v: string | null): Skill | null {
  return v !== null && (ALL_SKILLS as string[]).includes(v) ? (v as Skill) : null;
}

function zoneCodeOf(ctx: AgentContext, zoneId: string): string {
  return ctx.world.zoneById.get(zoneId)?.code ?? zoneId;
}

/** UTC is the simulator's wall clock; the whole product treats it as site-local. */
export function siteHour(ts: number): number {
  return new Date(ts).getUTCHours();
}

export function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  TOOL EXECUTION
// ─────────────────────────────────────────────────────────────────────────────

export async function runTool(
  name: string,
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<ToolOutcome> {
  switch (name) {
    case TOOL_NAMES.zoneHistory: return checkZoneHistory(input, ctx);
    case TOOL_NAMES.precedent: return recallSimilar(input, ctx);
    case TOOL_NAMES.correlate: return correlateEvents(input, ctx);
    case TOOL_NAMES.playbook: return consultPlaybook(ctx);
    case TOOL_NAMES.responders: return getResponders(input, ctx);
    case TOOL_NAMES.zoneContext: return getZoneContext(input, ctx);
    default:
      return {
        label: `unknown tool "${name}"`,
        result: { error: `No such tool: ${name}. Available: ${TOOL_DEFS.map((t) => t.name).join(', ')}.` },
        evidence: [],
      };
  }
}

function checkZoneHistory(input: Record<string, unknown>, ctx: AgentContext): ToolOutcome {
  const zoneId = str(input, 'zone_id') ?? ctx.event.zoneId;
  const type = asEventType(str(input, 'event_type')) ?? ctx.event.type;
  const zoneCode = zoneCodeOf(ctx, zoneId);

  if (!ctx.useMemory) {
    return {
      label: `${TOOL_NAMES.zoneHistory} · ${zoneCode}/${type} → no calibration (memory off)`,
      result: cold(),
      evidence: [],
    };
  }

  const lookup = ctx.memory.calibration.lookup(ctx.event.siteId, zoneId, type, ctx.now);
  const reading = readCalibration(lookup, zoneCode, type);
  const result: ZoneHistoryResult = {
    available: true,
    zoneCode,
    eventType: type,
    pReal: round(lookup.pReal),
    uncertainty: round(lookup.uncertainty),
    observations: lookup.observations,
    backoff: lookup.level,
    key: lookup.key,
    reading,
  };

  const evidence: EvidenceRef[] = [{
    kind: 'calibration',
    refId: lookup.key,
    label: `${zoneCode} · ${EVENT_LABELS[type]}, ${pct(lookup.pReal)} real over ${lookup.observations} resolved`,
    weight: round(clamp((lookup.pReal - 0.5) * 2, -1, 1)),
    detail: reading,
  }];

  return {
    label: `${TOOL_NAMES.zoneHistory} · ${zoneCode}/${type} → ${pct(lookup.pReal)} real, n=${lookup.observations} (${lookup.level})`,
    result,
    evidence,
  };
}

function readCalibration(lookup: CalibrationLookup, zoneCode: string, type: EventType): string {
  const label = EVENT_LABELS[type].toLowerCase();
  if (lookup.level === 'prior' || lookup.observations === 0) {
    return `No resolved ${label} alerts have been folded into ${zoneCode} yet, this is the cold prior, worth little.`;
  }
  const thin = lookup.observations < 6 ? ' The sample is still thin, so do not over-trust it.' : '';
  const spread = `±${pct(lookup.uncertainty)}`;
  if (lookup.level === 'exact') {
    return `${lookup.observations} resolved ${label} alerts in ${zoneCode} at this hour: ${pct(lookup.pReal)} were real (${spread}).${thin}`;
  }
  if (lookup.level === 'zone_type') {
    return `Not enough history for this hour, so backing off to ${zoneCode} across all hours: ${pct(lookup.pReal)} of ${lookup.observations} were real (${spread}).${thin}`;
  }
  return `No zone-level history, so backing off site-wide: ${pct(lookup.pReal)} of ${lookup.observations} ${label} alerts across the site were real (${spread}).${thin}`;
}

/**
 * Semantic score can only *raise* a candidate the structured matcher already found, capped at
 * `SEMANTIC_WEIGHT` of the final number. Keeps ranking explainable, and means the embedding
 * service being wrong, stale or absent degrades the ordering instead of inventing precedents.
 */
const SEMANTIC_WEIGHT = 0.35;

async function recallSimilar(input: Record<string, unknown>, ctx: AgentContext): Promise<ToolOutcome> {
  if (!ctx.useMemory) {
    return { label: `${TOOL_NAMES.precedent} · no ledger (memory off)`, result: cold(), evidence: [] };
  }
  const k = clamp(Math.round(num(input, 'limit') ?? 3), 1, 5);
  // Over-fetch so the semantic pass has candidates to reorder rather than just
  // rescoring the same k the structured matcher would have returned anyway.
  const found = ctx.memory.precedent.similar(ctx.event, ctx.semantic ? k + 3 : k);

  let semanticById: Map<string, number> | null = null;
  if (ctx.semantic) {
    try {
      const neighbours = await ctx.semantic.similar(ctx.event, k + 3);
      if (neighbours.length > 0) {
        semanticById = new Map(neighbours.map((n) => [n.incidentId, n.similarity]));
      }
    } catch {
      // An enhancement that throws must not cost the decision its precedent.
      semanticById = null;
    }
  }

  const blended = found
    .map((p) => {
      const sem = semanticById?.get(p.incidentId);
      const similarity = sem === undefined
        ? p.similarity
        : p.similarity * (1 - SEMANTIC_WEIGHT) + sem * SEMANTIC_WEIGHT;
      return { p, similarity };
    })
    .sort((a, b) => b.similarity - a.similarity || (a.p.incidentId < b.p.incidentId ? -1 : 1))
    .slice(0, k);

  const matches: PrecedentMatch[] = blended.map(({ p, similarity }) => ({
    incidentId: p.incidentId,
    zoneCode: p.zoneCode,
    eventType: p.type,
    similarity: round(similarity, 2),
    actionTaken: p.action,
    outcome: p.outcome,
    summary: p.summary,
  }));

  const reading = matches.length === 0
    ? 'Nothing comparable has been resolved yet, this is new ground.'
    : summarisePrecedents(matches);

  const evidence: EvidenceRef[] = matches.map((m) => ({
    kind: 'precedent',
    refId: m.incidentId,
    label: `${m.zoneCode} ${EVENT_LABELS[m.eventType]} → ${m.actionTaken} → ${m.outcome}`,
    weight: round(clamp(precedentWeight(m), -1, 1)),
    detail: m.summary,
  }));

  return {
    label: `${TOOL_NAMES.precedent} · ${matches.length} match${matches.length === 1 ? '' : 'es'}${matches.length ? ` (${matches.map((m) => m.outcome).join(', ')})` : ''}`,
    result: { available: true, matches, reading } satisfies PrecedentResult,
    evidence,
  };
}

function precedentWeight(m: PrecedentMatch): number {
  switch (m.outcome) {
    case 'missed': return 0.9 * m.similarity;
    case 'true_positive': return 0.6 * m.similarity;
    case 'false_alarm': return -0.7 * m.similarity;
    case 'declined': return 0.2 * m.similarity;
    case 'unresolved': return 0;
    default: return 0;
  }
}

function summarisePrecedents(matches: PrecedentMatch[]): string {
  const real = matches.filter((m) => m.outcome === 'true_positive' || m.outcome === 'missed').length;
  const fake = matches.filter((m) => m.outcome === 'false_alarm').length;
  const missed = matches.filter((m) => m.outcome === 'missed').length;
  const parts = [`${matches.length} comparable incident${matches.length === 1 ? '' : 's'}: ${real} were real, ${fake} were noise.`];
  if (missed > 0) parts.push(`${missed} of them was under-actioned and escalated afterwards, that is the failure mode to avoid here.`);
  return parts.join(' ');
}

function correlateEvents(input: Record<string, unknown>, ctx: AgentContext): ToolOutcome {
  const windowMinutes = clamp(Math.round(num(input, 'window_minutes') ?? 10), 1, 60);
  const finding = ctx.correlate(ctx.event, windowMinutes * 60_000);

  const result: CorrelationResult = {
    patternDetected: finding.patternDetected,
    label: finding.label,
    severityUplift: round(finding.severityUplift, 2),
    relatedEventIds: finding.relatedEventIds,
    relatedIncidentIds: finding.relatedIncidentIds,
    detail: finding.detail,
  };

  const evidence: EvidenceRef[] = finding.patternDetected
    ? [{
        kind: 'correlation',
        refId: finding.relatedEventIds[0] ?? ctx.event.id,
        label: finding.label,
        weight: round(clamp(0.35 + finding.severityUplift * 0.3, 0, 1)),
        detail: finding.detail,
      }]
    : [];

  return {
    label: `${TOOL_NAMES.correlate} · ${windowMinutes}m window → ${finding.patternDetected ? finding.label : 'no pattern'}`,
    result,
    evidence,
  };
}

function consultPlaybook(ctx: AgentContext): ToolOutcome {
  if (!ctx.useMemory) {
    return { label: `${TOOL_NAMES.playbook} · no SOPs loaded (memory off)`, result: cold(), evidence: [] };
  }
  const matched = ctx.memory.playbook.match(ctx.event);
  const rules: PlaybookMatch[] = matched.map((r) => ({
    ruleId: r.id,
    title: r.title,
    action: r.action,
    priorityFloor: r.priorityFloor,
    falseAlarmMultiplier: round(r.falseAlarmMultiplier, 2),
    precision: round(r.stats.precision, 2),
    applied: r.stats.applied,
    rationale: r.rationale,
  }));

  const reading = rules.length === 0
    ? 'No standing procedure covers this event, judge it on evidence.'
    : `${rules.length} rule${rules.length === 1 ? '' : 's'} match, most specific first. ${rules[0].title} says "${rules[0].action}".` +
      (rules[0].applied >= 5 && rules[0].precision < 0.6
        ? ` Note its live precision is only ${pct(rules[0].precision)} over ${rules[0].applied} applications, it is decaying.`
        : '');

  const evidence: EvidenceRef[] = rules.map((r) => ({
    kind: 'playbook',
    refId: r.ruleId,
    label: `${r.title} → ${r.action}`,
    weight: round(clamp(playbookWeight(r), -1, 1)),
    detail: r.rationale,
  }));

  return {
    label: `${TOOL_NAMES.playbook} · ${rules.length} matching rule${rules.length === 1 ? '' : 's'}${rules.length ? ` → ${rules[0].action}` : ''}`,
    result: { available: true, rules, reading } satisfies PlaybookResult,
    evidence,
  };
}

function playbookWeight(r: PlaybookMatch): number {
  const byAction = r.action === 'suppress' ? -0.55
    : r.action === 'monitor' ? -0.15
    : r.action === 'escalate' ? 0.7
    : 0.55;
  // falseAlarmMultiplier > 1 argues the pattern is noisier than calibration says.
  const byMultiplier = -(Math.log(Math.max(r.falseAlarmMultiplier, 0.1)) / Math.log(3)) * 0.4;
  const trust = r.applied >= 5 ? clamp(r.precision + 0.2, 0.4, 1) : 0.7;
  return (byAction + byMultiplier) * trust;
}

function getResponders(input: Record<string, unknown>, ctx: AgentContext): ToolOutcome {
  const asked = str(input, 'required_skill');
  const requiredSkill = asked === 'any' ? null : (asSkill(asked) ?? requiredSkillFor(ctx.event.type));
  const raw = ctx.candidates(requiredSkill);

  if (!ctx.useMemory) {
    const options: ResponderOption[] = [...raw]
      .sort((a, b) => a.etaMs - b.etaMs)
      .map((c) => ({
        responderId: c.responder.id,
        name: c.responder.name,
        kind: c.responder.kind,
        status: c.responder.status,
        skills: c.responder.kind === 'guard' ? c.responder.skills : [],
        etaMs: c.etaMs,
        etaMinutes: minutes(c.etaMs),
        skillMatch: c.skillMatch,
        pAccept: null,
        reason: `${minutes(c.etaMs)} min out${c.skillMatch ? `, holds ${requiredSkill ?? 'the needed'} skill` : ''}`,
      }));
    return {
      label: `${TOOL_NAMES.responders} · ${options.length} available, ranked by ETA only (no learned model)`,
      result: {
        requiredSkill,
        learned: false,
        options,
        note: 'Responder model unavailable, this arm runs cold, so candidates are ordered by travel time alone. ' +
          'Nothing is known about who actually accepts calls.',
      } satisfies ResponderResult,
      evidence: [],
    };
  }

  const ranked = ctx.memory.responders.rank(raw, { explore: true, requiredSkill });
  const options: ResponderOption[] = ranked.map((c) => ({
    responderId: c.responderId,
    name: c.name,
    kind: ctx.world.responderById.get(c.responderId)?.kind ?? 'guard',
    status: c.status,
    skills: c.skills,
    etaMs: c.etaMs,
    etaMinutes: minutes(c.etaMs),
    skillMatch: c.skillMatch,
    pAccept: round(c.model.pAccept),
    reason: c.reason,
  }));

  const top = options[0];
  const evidence: EvidenceRef[] = top
    ? [{
        kind: 'responder',
        refId: top.responderId,
        label: `${top.name}, ${top.etaMinutes} min out, accepts ${pct(top.pAccept ?? 0.5)} of dispatches`,
        weight: round(clamp(((top.pAccept ?? 0.5) - 0.5) * 1.2, -1, 1)),
        detail: top.reason,
      }]
    : [];

  return {
    label: `${TOOL_NAMES.responders} · ${options.length} ranked${top ? ` → ${top.name} (${top.etaMinutes}m, pAccept ${top.pAccept})` : ' → nobody available'}`,
    result: {
      requiredSkill,
      learned: true,
      options,
      note: options.length === 0
        ? 'Nobody is available with that skill. Dispatch is not on the table, escalate if this needs a body on scene.'
        : 'Ranking is Thompson-sampled over the learned acceptance and resolution posteriors, so it explores under-tested responders on purpose.',
    } satisfies ResponderResult,
    evidence,
  };
}

function getZoneContext(input: Record<string, unknown>, ctx: AgentContext): ToolOutcome {
  const zoneId = str(input, 'zone_id') ?? ctx.event.zoneId;
  const zone = ctx.world.zoneById.get(zoneId);
  if (!zone) {
    return {
      label: `${TOOL_NAMES.zoneContext} · unknown zone ${zoneId}`,
      result: { error: `No such zone: ${zoneId}` },
      evidence: [],
    };
  }
  const site = ctx.world.siteById.get(zone.siteId);
  const adjacent = zone.adjacent.map((id) => {
    const z = ctx.world.zoneById.get(id);
    return z ? `${z.code} (${z.name}, ${z.kind})` : id;
  });

  const robotsInZone = ctx.world.robots
    .filter((r) => r.currentZoneId === zoneId)
    .map((r) => ({ id: r.id, name: r.name, model: r.model, batteryPct: Math.round(r.batteryPct), status: r.status }));

  const guardsInZone = ctx.world.guards
    .filter((g) => g.currentZoneId === zoneId && g.status !== 'off_shift' && g.status !== 'offline')
    .map((g) => ({ id: g.id, name: g.name, status: g.status, skills: g.skills }));

  const hour = siteHour(ctx.now);
  const occupancy = guardsInZone.length > 0
    ? `${guardsInZone.map((g) => g.name).join(', ')} ${guardsInZone.length === 1 ? 'is' : 'are'} already in the zone.`
    : robotsInZone.length > 0
      ? `No guard in the zone; ${robotsInZone.map((r) => r.name).join(', ')} ${robotsInZone.length === 1 ? 'is' : 'are'} on patrol here.`
      : 'No guard or robot is currently in the zone.';

  const result: ZoneContextResult = {
    siteCode: site?.code ?? zone.siteId,
    siteName: site?.name ?? zone.siteId,
    zoneCode: zone.code,
    zoneName: zone.name,
    zoneKind: zone.kind,
    baseRisk: round(zone.baseRisk, 2),
    adjacentZones: adjacent,
    robotsInZone,
    guardsInZone,
    localHour: hour,
    reading: `${zone.code} is a ${zone.kind.replace(/_/g, ' ')} with static base risk ${zone.baseRisk.toFixed(2)}, ` +
      `${zone.adjacent.length} adjacent zone${zone.adjacent.length === 1 ? '' : 's'}. Local hour ${String(hour).padStart(2, '0')}:00. ${occupancy}`,
  };

  return {
    label: `${TOOL_NAMES.zoneContext} · ${zone.code} ${zone.kind}, risk ${zone.baseRisk.toFixed(2)}, ${guardsInZone.length} guard(s) present`,
    result,
    evidence: [{
      kind: 'policy',
      refId: zone.id,
      label: `${zone.code} static base risk ${zone.baseRisk.toFixed(2)} (${zone.kind})`,
      weight: round(clamp((zone.baseRisk - 0.45) * 1.4, -1, 1)),
      detail: result.reading,
    }],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  TERMINAL TOOL
// ─────────────────────────────────────────────────────────────────────────────

const ACTIONS: readonly AgentActionKind[] = ['dispatch', 'escalate', 'monitor', 'suppress'];
const PRIORITIES: readonly Priority[] = ['P0', 'P1', 'P2', 'P3'];

export function asSeverity(n: number): Severity {
  const v = clamp(Math.round(n), 1, 5);
  return (v === 1 ? 1 : v === 2 ? 2 : v === 3 ? 3 : v === 4 ? 4 : 5) satisfies Severity;
}

/**
 * Turn the model's `submit_decision` payload into a domain decision, defensively: a nonexistent
 * responder or a suppressed life-safety alarm must never reach the dispatch board.
 */
export function decisionFromSubmit(
  input: Record<string, unknown>,
  ctx: AgentContext,
  evidence: EvidenceRef[],
): AgentDecision {
  const rawAction = str(input, 'action');
  let action: AgentActionKind = ACTIONS.includes(rawAction as AgentActionKind)
    ? (rawAction as AgentActionKind)
    : 'monitor';

  const severity = asSeverity(num(input, 'severity') ?? TYPE_PROFILE[ctx.event.type].severity);
  const confidence = round(clamp(num(input, 'confidence') ?? 0.5, 0, 1));
  const falseAlarmProbability = round(clamp(num(input, 'false_alarm_probability') ?? 0.5, 0, 1));

  const rawPriority = str(input, 'priority');
  let priority: Priority = PRIORITIES.includes(rawPriority as Priority)
    ? (rawPriority as Priority)
    : priorityFromSeverity(severity);

  let instruction = (str(input, 'instruction') ?? '').trim();
  let rationale = (str(input, 'rationale') ?? '').trim();

  // Hard floor: life-safety alarms are never closed as noise, whatever the model says.
  if (action === 'suppress' && isLifeSafety(ctx.event.type)) {
    action = 'monitor';
    rationale = `${rationale} Policy blocks suppression of ${EVENT_LABELS[ctx.event.type].toLowerCase()} alarms, so this is held open for recheck instead.`.trim();
  }

  let responderId: string | null = null;
  if (action === 'dispatch') {
    const asked = str(input, 'responder_id');
    if (asked !== null && ctx.world.responderById.has(asked)) {
      responderId = asked;
    } else {
      // Rather than drop the dispatch, take the nearest body the simulator offers.
      const pool = ctx.candidates(requiredSkillFor(ctx.event.type));
      const fallbackPool = pool.length > 0 ? pool : ctx.candidates(null);
      const nearest = [...fallbackPool].sort((a, b) => a.etaMs - b.etaMs)[0];
      if (nearest) {
        responderId = nearest.responder.id;
        instruction = `${instruction} (Auto-assigned ${nearest.responder.name}, nearest available.)`.trim();
      } else {
        action = 'escalate';
        instruction = `${instruction} (No responder available, routed to the supervisor.)`.trim();
      }
    }
  }

  const floorRule = evidence.find((e) => e.kind === 'playbook' && e.weight > 0);
  if (floorRule && action === 'dispatch' && priority === 'P3' && severity >= 4) {
    priority = priorityFromSeverity(severity);
  }
  if (PRIORITY_ORDER[priority] > PRIORITY_ORDER[priorityFromSeverity(severity)] && action !== 'suppress') {
    // Never let a stated severity outrank its own priority.
    priority = priorityFromSeverity(severity);
  }

  const recheckMinutes = clamp(Math.round(num(input, 'recheck_after_minutes') ?? 0), 0, 240);
  const recheckAfterMs = action === 'monitor'
    ? (recheckMinutes > 0 ? recheckMinutes : defaultRecheckMinutes(severity)) * 60_000
    : undefined;

  if (instruction.length === 0) instruction = defaultInstruction(action, ctx, severity);
  if (rationale.length === 0) rationale = 'Decision recorded without a written rationale by the engine.';

  return {
    action,
    priority,
    severity,
    confidence,
    falseAlarmProbability,
    responderId,
    instruction,
    rationale,
    evidence,
    ...(recheckAfterMs !== undefined ? { recheckAfterMs } : {}),
  };
}

export function defaultRecheckMinutes(severity: Severity): number {
  return severity >= 4 ? 3 : severity === 3 ? 6 : 12;
}

function defaultInstruction(action: AgentActionKind, ctx: AgentContext, severity: Severity): string {
  const zoneCode = zoneCodeOf(ctx, ctx.event.zoneId);
  const label = EVENT_LABELS[ctx.event.type].toLowerCase();
  switch (action) {
    case 'dispatch':
      return `Proceed to ${zoneCode} and verify the ${label}. Report on arrival.`;
    case 'escalate':
      return `Supervisor: ${label} in ${zoneCode} at expected severity ${severity}. Needs a decision above guard authority.`;
    case 'monitor':
      return `Hold ${zoneCode} open and recheck in ${defaultRecheckMinutes(severity)} minutes. Escalate on any second signal.`;
    case 'suppress':
      return `Close the ${label} in ${zoneCode} as noise. No response.`;
    default:
      return `Hold ${zoneCode} open.`;
  }
}
