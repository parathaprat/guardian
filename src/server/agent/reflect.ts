/**
 * SENTRY, the reflection agent.
 *
 * Reads what actually happened and drafts changes to the playbook: new rules,
 * edits to existing ones, retirements. It never applies anything, it produces a
 * `PlaybookProposal` with `status: 'pending'` that a human approves as a diff.
 *
 * That human gate is the point. Physical security is an audited, liability-bearing
 * domain; a system that silently changes its own dispatch behaviour is unshippable
 * there. A system that proposes policy in writing, with evidence, and logs who
 * approved it, is one a director of security can actually adopt.
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  CalibrationCell, EventType, Incident, PlaybookProposal, PlaybookRule, Priority,
  RuleTrigger, SimTime,
} from '../../shared/types';
import { EVENT_LABELS } from '../../shared/types';
import type { Memory, WorldState } from '../contracts';

const MIN_OBS_FOR_RULE = 6;
const NUISANCE_CEILING = 0.2;
const HOT_FLOOR = 0.85;
const PRECISION_FLOOR = 0.55;

export interface ReflectionArgs {
  incidents: Incident[];
  memory: Memory;
  world: WorldState;
  now: SimTime;
  agentEngine: 'claude' | 'reasoner';
}

let proposalSeq = 0;
let ruleSeq = 0;

function newProposalId(): string { return `PRO-${String(++proposalSeq).padStart(4, '0')}`; }
function newRuleId(): string { return `RUL-${String(++ruleSeq).padStart(4, '0')}`; }

function hourRangeOf(bucket: number | null): { start: number; end: number } | null {
  return bucket === null ? null : { start: bucket * 3, end: bucket * 3 + 3 };
}

function fmtHours(r: { start: number; end: number } | null): string {
  if (!r) return 'any hour';
  const p = (h: number) => `${String(h).padStart(2, '0')}:00`;
  return `${p(r.start)}–${p(r.end)}`;
}

function emptyStats(): PlaybookRule['stats'] {
  return { applied: 0, agreed: 0, overridden: 0, correct: 0, incorrect: 0, precision: 0 };
}

function makeRule(args: {
  now: SimTime;
  title: string;
  trigger: RuleTrigger;
  action: PlaybookRule['action'];
  priorityFloor: Priority | null;
  falseAlarmMultiplier: number;
  rationale: string;
  evidenceIncidentIds: string[];
  supersedesRuleId?: string;
}): PlaybookRule {
  return {
    id: newRuleId(),
    version: 1,
    status: 'proposed',
    title: args.title,
    trigger: args.trigger,
    action: args.action,
    priorityFloor: args.priorityFloor,
    falseAlarmMultiplier: args.falseAlarmMultiplier,
    rationale: args.rationale,
    author: 'reflection',
    evidenceIncidentIds: args.evidenceIncidentIds.slice(0, 6),
    createdAt: args.now,
    updatedAt: args.now,
    stats: emptyStats(),
    ...(args.supersedesRuleId ? { supersedesRuleId: args.supersedesRuleId } : {}),
  };
}

/** Incidents whose (zone,type) matches a cell, used to cite real evidence. */
function evidenceFor(incidents: Incident[], cell: CalibrationCell, limit = 4): string[] {
  return incidents
    .filter((i) => i.event.type === cell.type && (cell.zoneId === null || i.event.zoneId === cell.zoneId))
    .slice(-limit)
    .map((i) => i.id);
}

/**
 * The deterministic path. Also the fallback when Claude is unavailable, and the
 * path the eval harness uses so warm-up stays reproducible.
 */
function statisticalProposal(args: ReflectionArgs): PlaybookProposal {
  const { memory, world, now, incidents } = args;
  const rules: PlaybookRule[] = [];
  const retire: Array<{ ruleId: string; reason: string }> = [];

  const zoneName = (id: string | null) =>
    id ? world.zoneById.get(id)?.code ?? id : 'any zone';
  const siteCode = (id: string) => world.siteById.get(id)?.code ?? id;

  // Only look at cells with enough evidence to justify a written policy.
  const cells = memory.calibration
    .cells()
    .filter((c) => c.observations >= MIN_OBS_FOR_RULE && c.zoneId !== null)
    .sort((a, b) => b.observations - a.observations);

  const seen = new Set<string>();

  for (const c of cells) {
    const sig = `${c.zoneId}|${c.type}|${c.hourBucket ?? '*'}`;
    if (seen.has(sig)) continue;

    const trigger: RuleTrigger = {
      siteId: c.siteId,
      zoneId: c.zoneId,
      types: [c.type],
      hourRange: hourRangeOf(c.hourBucket),
      sourceIds: null,
      condition: null,
    };
    const where = `${siteCode(c.siteId)} · ${zoneName(c.zoneId)} · ${EVENT_LABELS[c.type]} · ${fmtHours(trigger.hourRange)}`;

    if (c.pReal <= NUISANCE_CEILING) {
      seen.add(sig);
      rules.push(makeRule({
        now,
        title: `Suppress ${EVENT_LABELS[c.type].toLowerCase()} at ${zoneName(c.zoneId)}, ${fmtHours(trigger.hourRange)}`,
        trigger,
        action: 'suppress',
        priorityFloor: null,
        falseAlarmMultiplier: 2.4,
        rationale:
          `${where} has resolved real only ${Math.round(c.pReal * 100)}% of the time across ` +
          `${c.observations} observations (±${Math.round(c.uncertainty * 100)}pp). Dispatching on this ` +
          `signal spends guard time and erodes trust in the alarm without a security benefit. ` +
          `Suppress it here, in this window only, the same signal outside the window keeps its normal handling.`,
        evidenceIncidentIds: evidenceFor(incidents, c),
      }));
    } else if (c.pReal >= HOT_FLOOR) {
      seen.add(sig);
      rules.push(makeRule({
        now,
        title: `Priority floor for ${EVENT_LABELS[c.type].toLowerCase()} at ${zoneName(c.zoneId)}`,
        trigger,
        action: 'dispatch',
        priorityFloor: c.pReal > 0.92 ? 'P1' : 'P2',
        falseAlarmMultiplier: 0.5,
        rationale:
          `${where} has resolved real ${Math.round(c.pReal * 100)}% of the time across ` +
          `${c.observations} observations. This is one of the most reliable signals in the portfolio ` +
          `and should not be queued behind lower-yield alarms. Floor it and always send someone.`,
        evidenceIncidentIds: evidenceFor(incidents, c),
      }));
    }
    if (rules.length >= 5) break;
  }

  // Rules that are demonstrably not working.
  for (const r of memory.playbook.rules()) {
    if (r.status !== 'active') continue;
    if (r.stats.applied >= 8 && r.stats.precision < PRECISION_FLOOR) {
      retire.push({
        ruleId: r.id,
        reason:
          `Fired ${r.stats.applied} times at ${Math.round(r.stats.precision * 100)}% precision, below the ` +
          `${Math.round(PRECISION_FLOOR * 100)}% floor. It is now costing more than it saves.`,
      });
    } else if (r.stats.overridden >= 3 && r.stats.overridden > r.stats.agreed) {
      retire.push({
        ruleId: r.id,
        reason: `Operators overrode this rule ${r.stats.overridden} times versus ${r.stats.agreed} confirmations, it does not match how this team actually dispatches.`,
      });
    }
  }

  const overrides = incidents.filter((i) => i.feedback?.verdict === 'override').length;
  const resolved = incidents.filter((i) => i.outcome !== null).length;

  const summary = rules.length === 0 && retire.length === 0
    ? `Reviewed ${resolved} resolved incidents. No cell has yet accumulated ${MIN_OBS_FOR_RULE} observations at a strong enough posterior to justify a written rule. No changes proposed, the statistics are not there yet, and guessing would be worse than waiting.`
    : `Reviewed ${resolved} resolved incidents and ${overrides} operator override${overrides === 1 ? '' : 's'}. ` +
      `Proposing ${rules.length} rule change${rules.length === 1 ? '' : 's'} and ${retire.length} retirement${retire.length === 1 ? '' : 's'}. ` +
      `Every proposal below is drawn from a calibration cell with at least ${MIN_OBS_FOR_RULE} observations, ` +
      `so each one is a pattern the system has actually watched resolve, not an inference from the event text.`;

  return {
    id: newProposalId(),
    createdAt: now,
    rules,
    retire,
    summary,
    incidentsAnalysed: resolved,
    engine: 'reasoner',
    status: 'pending',
  };
}

const PROPOSAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string', description: 'Two to four plain sentences an ops manager would read. State what changed and why.' },
    rules: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          zone_id: { type: 'string', description: 'Zone id from the digest, or empty for site-wide.' },
          site_id: { type: 'string' },
          event_type: { type: 'string' },
          hour_start: { type: 'integer', description: '0-23, or -1 for any hour.' },
          hour_end: { type: 'integer', description: '0-23, or -1 for any hour.' },
          action: { type: 'string', enum: ['dispatch', 'escalate', 'monitor', 'suppress'] },
          priority_floor: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3', 'none'] },
          false_alarm_multiplier: { type: 'number' },
          rationale: { type: 'string', description: 'Cite the observed numbers. No hedging.' },
          supersedes_rule_id: { type: 'string', description: 'Existing rule id this replaces, or empty.' },
        },
        required: ['title', 'zone_id', 'site_id', 'event_type', 'hour_start', 'hour_end',
          'action', 'priority_floor', 'false_alarm_multiplier', 'rationale', 'supersedes_rule_id'],
      },
    },
    retire: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { rule_id: { type: 'string' }, reason: { type: 'string' } },
        required: ['rule_id', 'reason'],
      },
    },
  },
  required: ['summary', 'rules', 'retire'],
};

/** A compact digest, the model reasons over statistics, not raw incident dumps. */
function buildDigest(args: ReflectionArgs): string {
  const { memory, world, incidents } = args;
  const lines: string[] = [];

  lines.push('## Calibration cells with enough evidence to write policy from');
  const cells = memory.calibration.cells()
    .filter((c) => c.observations >= 4 && c.zoneId !== null)
    .sort((a, b) => b.observations - a.observations)
    .slice(0, 24);
  for (const c of cells) {
    const z = world.zoneById.get(c.zoneId!);
    lines.push(
      `- site=${c.siteId} zone=${c.zoneId} (${z?.code ?? '?'}) type=${c.type} ` +
      `hours=${fmtHours(hourRangeOf(c.hourBucket))} pReal=${c.pReal.toFixed(2)} ` +
      `±${c.uncertainty.toFixed(2)} n=${c.observations}`,
    );
  }
  if (cells.length === 0) lines.push('- (none yet)');

  lines.push('', '## Active playbook rules and how they are performing');
  for (const r of memory.playbook.rules().filter((r) => r.status === 'active')) {
    lines.push(
      `- id=${r.id} "${r.title}" action=${r.action} applied=${r.stats.applied} ` +
      `precision=${r.stats.precision.toFixed(2)} overridden=${r.stats.overridden} agreed=${r.stats.agreed} ` +
      `author=${r.author}`,
    );
  }

  const overrides = incidents.filter((i) => i.feedback?.verdict === 'override');
  lines.push('', `## Operator overrides (${overrides.length}), the highest-value signal here`);
  for (const i of overrides.slice(-12)) {
    lines.push(
      `- ${i.event.type} at zone=${i.event.zoneId}: agent chose ${i.decision?.action ?? '?'}, ` +
      `operator chose ${i.feedback?.correctedAction ?? '?'}. outcome=${i.outcome ?? 'pending'}` +
      (i.feedback?.note ? ` note="${i.feedback.note}"` : ''),
    );
  }
  if (overrides.length === 0) lines.push('- (none)');

  lines.push('', '## Outcome mix');
  const mix: Record<string, number> = {};
  for (const i of incidents) if (i.outcome) mix[i.outcome] = (mix[i.outcome] ?? 0) + 1;
  lines.push(Object.entries(mix).map(([k, v]) => `${k}=${v}`).join(' ') || '(none)');

  return lines.join('\n');
}

const REFLECT_SYSTEM =
  'You are the reflection pass of an AI security dispatch system. You read what actually happened ' +
  'and draft changes to a written playbook that a human ops manager will approve or reject as a diff.\n\n' +
  'Rules you must follow:\n' +
  '- Propose a rule ONLY where the observed statistics support it. n < 6 is not evidence.\n' +
  '- Operator overrides outrank your own statistics: if operators keep correcting a behaviour, ' +
  'propose the change they are implicitly asking for.\n' +
  '- Prefer narrow triggers. A rule scoped to one zone and one time window is auditable; a blanket ' +
  'rule on an event type is how playbooks rot.\n' +
  '- Retire rules that are firing often at low precision, and say plainly that they are costing more ' +
  'than they save.\n' +
  '- Write rationales that cite the actual numbers. An ops manager should be able to check your work.\n' +
  '- Propose nothing if the evidence is not there. "No change" is a valid, and often correct, output.';

export async function runReflection(args: ReflectionArgs): Promise<PlaybookProposal> {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
  const resolved = args.incidents.filter((i) => i.outcome !== null);

  if (!apiKey || args.agentEngine !== 'claude') {
    return statisticalProposal(args);
  }

  try {
    const client = new Anthropic({ apiKey, maxRetries: 1 });
    const res = await client.messages.create({
      model: process.env.SENTRY_MODEL ?? 'claude-opus-4-8',
      max_tokens: 8000,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: {
        effort: 'high',
        format: { type: 'json_schema', schema: PROPOSAL_SCHEMA },
      },
      system: REFLECT_SYSTEM,
      messages: [{
        role: 'user',
        content:
          `Here is everything the dispatch system has learned since the last review.\n\n` +
          `${buildDigest(args)}\n\n` +
          `Draft playbook changes. Return JSON matching the schema.`,
      }],
    });

    const text = res.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
    const parsed = JSON.parse(text) as {
      summary: string;
      rules: Array<Record<string, unknown>>;
      retire: Array<{ rule_id: string; reason: string }>;
    };

    const known = new Set(args.memory.playbook.rules().map((r) => r.id));
    const rules: PlaybookRule[] = (parsed.rules ?? []).map((r) => {
      const hs = Number(r.hour_start);
      const he = Number(r.hour_end);
      const hourRange = Number.isFinite(hs) && hs >= 0 && Number.isFinite(he) && he >= 0
        ? { start: hs, end: he }
        : null;
      const floor = String(r.priority_floor ?? 'none');
      const supersedes = String(r.supersedes_rule_id ?? '');
      return makeRule({
        now: args.now,
        title: String(r.title ?? 'Untitled rule'),
        trigger: {
          siteId: String(r.site_id ?? '') || null,
          zoneId: String(r.zone_id ?? '') || null,
          types: [String(r.event_type) as EventType],
          hourRange,
          sourceIds: null,
          condition: null,
        },
        action: (['dispatch', 'escalate', 'monitor', 'suppress'] as const).includes(r.action as never)
          ? (r.action as PlaybookRule['action'])
          : 'monitor',
        priorityFloor: floor === 'none' ? null : (floor as Priority),
        falseAlarmMultiplier: Math.min(3, Math.max(0.1, Number(r.false_alarm_multiplier) || 1)),
        rationale: String(r.rationale ?? ''),
        evidenceIncidentIds: resolved.slice(-4).map((i) => i.id),
        ...(supersedes && known.has(supersedes) ? { supersedesRuleId: supersedes } : {}),
      });
    });

    return {
      id: newProposalId(),
      createdAt: args.now,
      rules,
      retire: (parsed.retire ?? []).filter((r) => known.has(r.rule_id))
        .map((r) => ({ ruleId: r.rule_id, reason: r.reason })),
      summary: parsed.summary ?? '',
      incidentsAnalysed: resolved.length,
      engine: 'claude',
      status: 'pending',
    };
  } catch {
    // A failed reflection must never take the console down, fall back silently
    // to the statistical pass, which is a genuine second opinion, not a stub.
    return statisticalProposal(args);
  }
}
