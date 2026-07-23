/**
 * ASK, a natural-language question answered via a tool-using loop over the memory stores
 * (see DECISIONS.md Decision 7). Every tool reads the same stores the console renders and
 * emits the same `TraceStep`, so an answer arrives with its lookups attached and checkable.
 */

import type {
  AskAnswer, AskCitation, EngineKind, Incident, Metrics, TraceStep,
} from '../../shared/types';
import { ALL_EVENT_TYPES, ENGINE_LABELS } from '../../shared/types';
import type { Memory, WorldState } from '../contracts';
import { activeProvider } from './index';
import type { ToolDef } from './tools';

export interface AskArgs {
  question: string;
  incidents: Incident[];
  memory: Memory;
  world: WorldState;
  metrics: Metrics;
  agentEngine: EngineKind;
}

export const MAX_QUESTION = 400;
const MAX_TURNS = 5;
const ANSWER_TOOL = 'answer';

let stepSeq = 0;
let askSeq = 0;

function mkStep(kind: TraceStep['kind'], label: string, startedAt: number, extra: Partial<TraceStep> = {}): TraceStep {
  return { id: `AS-${++stepSeq}`, index: 0, kind, durationMs: Math.max(0, Date.now() - startedAt), label, ...extra };
}

function summarise(text: string): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  if (!clean) return 'Reasoning';
  const cut = clean.slice(0, 120);
  const stop = cut.lastIndexOf('. ');
  return (stop > 30 ? cut.slice(0, stop + 1) : cut) + (clean.length > 120 && stop <= 30 ? '…' : '');
}

const TOOLS: ToolDef[] = [
  {
    name: 'query_calibration',
    description:
      'Learned P(alarm is real) by zone, event type and time of day. This is the answer to any '
      + 'question about how often something is a false alarm. Filters are optional and combine.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        zone_code: { type: 'string', description: 'Zone code such as "D-3". Empty for all zones.' },
        event_type: { type: 'string', description: 'Event type id. Empty for all types.' },
        min_observations: { type: 'integer', description: 'Drop cells with less evidence than this. Default 3.' },
      },
      required: ['zone_code', 'event_type', 'min_observations'],
    },
  },
  {
    name: 'query_responders',
    description:
      'Guards and robots: the learned model (accept rate, resolution rate, mean response, and how '
      + 'many dispatches each rests on) joined to current duty state (status, skills, site, zone). '
      + 'Use for any question about who to send, who is reliable, or who is on shift.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name_contains: { type: 'string', description: 'Filter by name substring. Empty for the whole roster.' },
        available_only: {
          type: 'boolean',
          description: 'True to drop anyone not currently available. Use this for "who should I send right now".',
        },
        skill: {
          type: 'string',
          description:
            'Require a skill: armed, medical, fire, technical, de_escalation, access_control. '
            + 'Empty for any. A medical call needs medical.',
        },
      },
      required: ['name_contains', 'available_only', 'skill'],
    },
  },
  {
    name: 'query_playbook',
    description:
      'The written rules currently steering dispatch, with how often each fired and its precision. '
      + 'Use for "why does it always do X" questions.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        active_only: { type: 'boolean', description: 'True for active rules only.' },
      },
      required: ['active_only'],
    },
  },
  {
    name: 'query_incidents',
    description:
      'The incident ledger: what happened, what the agent decided, and how it resolved. Use to '
      + 'ground a claim in specific cases rather than aggregates.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        event_type: { type: 'string', description: 'Event type id. Empty for all.' },
        zone_code: { type: 'string', description: 'Zone code. Empty for all.' },
        outcome: {
          type: 'string',
          description: 'Filter to one outcome, "open" for unresolved, or empty for all.',
        },
        limit: { type: 'integer', description: 'Max rows, capped at 25.' },
      },
      required: ['event_type', 'zone_code', 'outcome', 'limit'],
    },
  },
  {
    name: 'query_metrics',
    description: 'Portfolio-level performance: dispatch score, false dispatch rate, missed criticals, operator agreement.',
    input_schema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
  },
  {
    name: ANSWER_TOOL,
    description:
      'Give the final answer. Call this exactly once, only after you have looked something up. '
      + 'Never call it first.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        answer: {
          type: 'string',
          description:
            'Two to five sentences of plain operational English, with the actual numbers in them. '
            + 'If the stores do not answer the question, say exactly that and say what is missing.',
        },
        citations: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', enum: ['calibration', 'responder', 'playbook', 'incident', 'metric'] },
              ref_id: { type: 'string', description: 'The id exactly as it appeared in a tool result.' },
              label: { type: 'string', description: 'Short human label, under 60 characters.' },
            },
            required: ['kind', 'ref_id', 'label'],
          },
          description: 'What you actually read to answer. Never cite something you did not look up.',
        },
      },
      required: ['answer', 'citations'],
    },
  },
];

const ASK_SYSTEM =
  'You answer questions about what an AI security dispatch system has learned, for the ops manager '
  + 'who runs it. You have read-only tools over its memory.\n\n'
  + 'Rules you must follow:\n'
  + '- Look things up before answering. You have no knowledge of this portfolio beyond the tools.\n'
  + '- Answer with the numbers, not around them. "Motion at D-3 runs 11% real over 38 observations" '
  + 'beats "motion there is often a false alarm".\n'
  + '- If the stores do not contain the answer, say so plainly and name what is missing. Never fill a '
  + 'gap with a plausible number.\n'
  + '- Distinguish what was learned from what was assumed. A cell with n=2 is not evidence and you '
  + 'should say so rather than quoting it.\n'
  + '- A higher rate on fewer observations is not better. 83% over 3 dispatches is weaker evidence '
  + 'than 78% over 30, not stronger, and recommending the first over the second is a mistake. When '
  + 'sample sizes differ, say which number you trust and why.\n'
  + '- "Right now" is a question about duty state, not just about scores. Filter to who is actually '
  + 'available and actually has the skill before ranking anyone.\n'
  + '- Be brief. The reader is busy and the charts are right there if they want depth.';

// ── tool implementations, read-only over the same stores the UI renders ───

function runAskTool(
  name: string,
  input: Record<string, unknown>,
  args: AskArgs,
): { label: string; result: unknown } {
  const { memory, world, incidents, metrics } = args;

  switch (name) {
    case 'query_calibration': {
      const zoneCode = String(input.zone_code ?? '').trim().toUpperCase();
      const type = String(input.event_type ?? '').trim();
      const minObs = Number.isFinite(Number(input.min_observations))
        ? Math.max(0, Math.floor(Number(input.min_observations)))
        : 3;
      const zone = zoneCode ? world.zones.find((z) => z.code.toUpperCase() === zoneCode) : undefined;

      const rows = memory.calibration.cells()
        .filter((c) => c.observations >= minObs)
        .filter((c) => (zone ? c.zoneId === zone.id : true))
        .filter((c) => (type ? c.type === type : true))
        .sort((a, b) => b.observations - a.observations)
        .slice(0, 30)
        .map((c) => ({
          id: c.key,
          zone: c.zoneId ? world.zoneById.get(c.zoneId)?.code ?? c.zoneId : 'site-wide',
          type: c.type,
          hourBucket: c.hourBucket === null ? 'any' : `${c.hourBucket * 3}:00-${c.hourBucket * 3 + 3}:00`,
          pReal: Number(c.pReal.toFixed(3)),
          uncertainty: Number(c.uncertainty.toFixed(3)),
          observations: c.observations,
        }));
      return { label: `${rows.length} calibration cell(s)`, result: { cells: rows } };
    }

    case 'query_responders': {
      const needle = String(input.name_contains ?? '').trim().toLowerCase();
      const availableOnly = input.available_only === true;
      const skill = String(input.skill ?? '').trim();

      // Joined to duty state: the top-scoring guard is no use if off shift or
      // already on scene. Status/skills come from the same public roster the
      // console renders, never a `truth` field.
      const duty = new Map(
        [...world.guards, ...world.robots].map((r) => [r.id, r]),
      );

      const rows = memory.responders.models()
        .filter((m) => (needle ? m.name.toLowerCase().includes(needle) : true))
        .map((m) => {
          const r = duty.get(m.responderId);
          const skills = r && 'skills' in r ? r.skills : [];
          const zone = r && 'currentZoneId' in r ? world.zoneById.get(r.currentZoneId) : undefined;
          return {
            id: m.responderId,
            name: m.name,
            status: r?.status ?? 'unknown',
            skills,
            site: r ? world.siteById.get(r.siteId)?.code ?? r.siteId : null,
            zone: zone?.code ?? null,
            pAccept: Number(m.pAccept.toFixed(3)),
            pResolve: Number(m.pResolve.toFixed(3)),
            meanResponseSec: m.responseCount > 0 ? Math.round(m.responseMeanMs / 1000) : null,
            dispatches: m.dispatches,
            stillExploring: m.exploring,
            score: Number(m.score.toFixed(3)),
          };
        })
        .filter((r) => (availableOnly ? r.status === 'available' : true))
        .filter((r) => (skill ? r.skills.includes(skill as never) : true))
        .slice(0, 30);

      const note = availableOnly || skill
        ? `filtered to ${availableOnly ? 'available' : 'any status'}${skill ? ` with skill=${skill}` : ''}`
        : 'whole roster';
      return { label: `${rows.length} responder(s), ${note}`, result: { responders: rows, filter: note } };
    }

    case 'query_playbook': {
      const activeOnly = input.active_only === true;
      const rows = memory.playbook.rules()
        .filter((r) => (activeOnly ? r.status === 'active' : true))
        .slice(0, 30)
        .map((r) => ({
          id: r.id,
          title: r.title,
          status: r.status,
          action: r.action,
          author: r.author,
          applied: r.stats.applied,
          precision: Number(r.stats.precision.toFixed(3)),
          overridden: r.stats.overridden,
        }));
      return { label: `${rows.length} playbook rule(s)`, result: { rules: rows } };
    }

    case 'query_incidents': {
      const type = String(input.event_type ?? '').trim();
      const zoneCode = String(input.zone_code ?? '').trim().toUpperCase();
      const outcome = String(input.outcome ?? '').trim();
      const limit = Number.isFinite(Number(input.limit))
        ? Math.min(25, Math.max(1, Math.floor(Number(input.limit))))
        : 12;
      const zone = zoneCode ? world.zones.find((z) => z.code.toUpperCase() === zoneCode) : undefined;

      const rows = incidents
        .filter((i) => (type ? i.event.type === type : true))
        .filter((i) => (zone ? i.event.zoneId === zone.id : true))
        .filter((i) => {
          if (!outcome) return true;
          if (outcome === 'open') return i.outcome === null;
          return i.outcome === outcome;
        })
        .slice(-limit)
        .map((i) => ({
          id: i.id,
          type: i.event.type,
          zone: world.zoneById.get(i.event.zoneId)?.code ?? i.event.zoneId,
          hour: new Date(i.event.ts).getUTCHours(),
          action: i.decision?.action ?? null,
          priority: i.decision?.priority ?? null,
          outcome: i.outcome,
          operatorVerdict: i.feedback?.verdict ?? null,
          description: i.event.description,
        }));
      return { label: `${rows.length} incident(s)`, result: { incidents: rows } };
    }

    case 'query_metrics':
      return {
        label: 'portfolio metrics',
        result: {
          id: 'metrics',
          incidents: metrics.incidents,
          resolved: metrics.resolved,
          dispatchScore: Number(metrics.dispatchScore.toFixed(1)),
          falseDispatchRate: Number(metrics.falseDispatchRate.toFixed(3)),
          missedCriticalRate: Number(metrics.missedCriticalRate.toFixed(3)),
          operatorAgreementRate: Number(metrics.operatorAgreementRate.toFixed(3)),
          responderAcceptRate: Number(metrics.responderAcceptRate.toFixed(3)),
        },
      };

    default:
      throw new Error(`unknown tool ${name}`);
  }
}

/** Ids the model is allowed to cite, gathered from the stores rather than trusted. */
function citableIds(args: AskArgs): Set<string> {
  const ids = new Set<string>(['metrics']);
  for (const c of args.memory.calibration.cells()) ids.add(c.key);
  for (const m of args.memory.responders.models()) ids.add(m.responderId);
  for (const r of args.memory.playbook.rules()) ids.add(r.id);
  for (const i of args.incidents) ids.add(i.id);
  return ids;
}

/** With no key, route by keyword to the relevant store and show the top rows: a lookup, not an answer. */
function degradedAnswer(args: AskArgs, why: string): AskAnswer {
  const q = args.question.toLowerCase();
  const wantsResponders = /who|guard|robot|respond|accept|reliable|send/.test(q);
  const wantsRules = /rule|playbook|policy|why does it|always/.test(q);

  const t0 = Date.now();
  const tool = wantsResponders ? 'query_responders' : wantsRules ? 'query_playbook' : 'query_calibration';
  const out = runAskTool(
    tool,
    tool === 'query_calibration' ? { zone_code: '', event_type: '', min_observations: 4 }
      : tool === 'query_responders' ? { name_contains: '' } : { active_only: true },
    args,
  );

  return {
    id: `ASK-${++askSeq}`,
    question: args.question,
    answer:
      `${why} Keyword routing sent this question to ${tool.replace('query_', '')}, and the top rows are `
      + 'in the trace below. Reading them is the part a hosted model would have done.',
    citations: [],
    trace: [
      mkStep('tool_call', tool, t0, { toolName: tool }),
      mkStep('tool_result', out.label, t0, { toolName: tool, toolResult: out.result }),
    ].map((s, index) => ({ ...s, index })),
    engine: 'reasoner',
    degraded: true,
    latencyMs: Date.now() - t0,
  };
}

export async function runAsk(args: AskArgs): Promise<AskAnswer> {
  const t0 = Date.now();
  const provider = activeProvider();
  const question = args.question.trim();
  if (question.length === 0) throw new Error('Nothing to ask.');

  if (!provider) {
    return degradedAnswer(args, 'No hosted model is configured, so there is nothing here to read the stores for you.');
  }

  const trace: TraceStep[] = [];
  const emit = (s: TraceStep) => { s.index = trace.length; trace.push(s); };

  const known = citableIds(args);
  const session = provider.session(
    ASK_SYSTEM,
    `## The portfolio\n`
    + `${args.world.sites.length} site(s), ${args.world.zones.length} zones, `
    + `${args.world.guards.length} guards, ${args.world.robots.length} robots, `
    + `${args.incidents.length} incidents on record.\n\n`
    + `Zone codes: ${args.world.zones.map((z) => z.code).join(', ')}\n`
    + `Event types: ${ALL_EVENT_TYPES.join(', ')}\n\n`
    + `## Question\n${question}`,
    TOOLS,
  );

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const callStart = Date.now();
      const res = await session.next();
      if (res.refused) throw new Error('Model declined the request.');

      for (const block of res.reasoning) {
        if (block.trim()) emit(mkStep('thinking', summarise(block), callStart, { detail: block }));
      }

      const final = res.toolCalls.find((c) => c.name === ANSWER_TOOL);
      if (final) {
        const answer = String(final.input.answer ?? '').trim();
        const rawCites = Array.isArray(final.input.citations) ? final.input.citations : [];
        const citations: AskCitation[] = rawCites
          .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
          .map((c) => ({
            kind: String(c.kind ?? '') as AskCitation['kind'],
            refId: String(c.ref_id ?? ''),
            label: String(c.label ?? '').slice(0, 80),
          }))
          .filter((c) => known.has(c.refId))
          .filter((c) => ['calibration', 'responder', 'playbook', 'incident', 'metric'].includes(c.kind))
          .slice(0, 10);

        emit(mkStep('decision', 'Answered', callStart, { detail: answer }));
        return {
          id: `ASK-${++askSeq}`,
          question,
          answer: answer || 'The model returned an empty answer.',
          citations,
          trace,
          engine: provider.engine,
          degraded: false,
          latencyMs: Date.now() - t0,
        };
      }

      if (res.toolCalls.length === 0) break;

      const results = [];
      for (const call of res.toolCalls) {
        const s0 = Date.now();
        emit(mkStep('tool_call', call.name, s0, { toolName: call.name, toolInput: call.input }));
        try {
          const out = runAskTool(call.name, call.input, args);
          emit(mkStep('tool_result', out.label, s0, { toolName: call.name, toolResult: out.result }));
          results.push({ id: call.id, name: call.name, content: JSON.stringify(out.result), isError: false });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          emit(mkStep('error', `${call.name} failed`, s0, { toolName: call.name, detail: msg }));
          results.push({ id: call.id, name: call.name, content: msg, isError: true });
        }
      }
      session.addToolResults(results);
    }

    // Ran out of turns without committing; say so rather than synthesising an answer.
    emit(mkStep('error', 'No answer committed within the turn budget', t0, {
      detail: `The model used all ${MAX_TURNS} turns without calling ${ANSWER_TOOL}.`,
    }));
    return {
      id: `ASK-${++askSeq}`,
      question,
      answer: `The ${ENGINE_LABELS[provider.engine]} pass looked things up but never committed to an answer. `
        + 'The lookups it did run are in the trace below.',
      citations: [],
      trace,
      engine: provider.engine,
      degraded: true,
      latencyMs: Date.now() - t0,
    };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    const fallback = degradedAnswer(args, `The ${ENGINE_LABELS[provider.engine]} pass failed (${why}).`);
    return { ...fallback, trace: [...trace, ...fallback.trace].map((s, index) => ({ ...s, index })) };
  }
}
