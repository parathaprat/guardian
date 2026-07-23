/**
 * The agentic loop, written once for every hosted provider.
 *
 * A manual loop, not an SDK tool runner, so every reasoning block and tool
 * round-trip streams to the console live as a `TraceStep`. Invariants: the
 * loop always falls through to the local Reasoner rather than returning
 * nothing; evidence comes only from tool results, never invented by the
 * model; trace format is identical across engines.
 */

import type { EvidenceRef, TraceStep } from '../../shared/types';
import { ENGINE_LABELS } from '../../shared/types';
import type { AgentContext, AgentResult, DispatchAgent } from '../contracts';
import type { LlmProvider, LlmToolResult } from './provider';
import {
  SUBMIT_TOOL_NAME, TOOL_DEFS, TOOL_NAMES, TYPE_PROFILE, decisionFromSubmit, isLifeSafety, runTool,
} from './tools';
import { buildIncidentPrompt, buildSystemPrompt } from './prompt';
import { ReasonerAgent } from './reasoner';

const MAX_TURNS = 6;

/**
 * Whether this alarm is worth a scarce hosted-model call. Gates proactively,
 * not just once the rate-limit window is tight, since severity 1-3 already
 * covers most alarm volume and the Reasoner handles it well on its own. Keys
 * off the prior cost of being wrong, not the model's own confidence (that
 * would be circular).
 */
function worthTheBudget(type: Parameters<typeof isLifeSafety>[0]): boolean {
  return isLifeSafety(type) || TYPE_PROFILE[type].severity >= 4;
}

/**
 * One-shot mode: run the evidence tools locally and for free, then one model
 * call for the judgment, instead of the agentic loop. Needed because on the
 * free tier the fixed prompt resends every turn, so a two-turn decision can
 * cost more than an entire minute's allowance and never complete.
 */
const PREFETCH_ORDER = [
  TOOL_NAMES.zoneHistory,
  TOOL_NAMES.zoneContext,
  TOOL_NAMES.correlate,
  TOOL_NAMES.playbook,
  TOOL_NAMES.precedent,
  TOOL_NAMES.responders,
] as const;

/**
 * Trim ranked-list tails out of a tool result before it goes into the prompt:
 * the evidence block was ~41% of every request, mostly list tails the model
 * never picks from. Truncates only (keeps a dropped-count note); the trace
 * inspector still shows the untruncated result.
 */
const LIST_CAPS: Record<string, number> = {
  options: 5,        // ranked responders
  matches: 3,        // precedent hits
  rules: 3,          // matching playbook rules
  adjacentZones: 4,
  robotsInZone: 3,
  guardsInZone: 3,
  relatedEventIds: 4,
  relatedIncidentIds: 4,
};

function compact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compact);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const cap = LIST_CAPS[k];
    out[k] = Array.isArray(v) && cap !== undefined && v.length > cap
      ? [...v.slice(0, cap).map(compact), `+${v.length - cap} more, omitted`]
      : compact(v);
  }
  return out;
}

/** `auto` picks one-shot for metered providers and the agentic loop otherwise. */
function oneShotWanted(provider: LlmProvider): boolean {
  const mode = process.env.SENTRY_EVIDENCE?.trim().toLowerCase() ?? 'auto';
  if (mode === 'oneshot' || mode === 'one-shot' || mode === 'prefetch') return true;
  if (mode === 'agentic' || mode === 'loop') return false;
  return typeof provider.underPressure === 'function';
}

let stepSeq = 0;

function mkStep(
  kind: TraceStep['kind'],
  label: string,
  startedAt: number,
  extra: Partial<TraceStep> = {},
): TraceStep {
  return {
    id: `TC-${++stepSeq}`,
    index: 0,
    kind,
    durationMs: Math.max(0, Date.now() - startedAt),
    label,
    ...extra,
  };
}

/** First sentence of the reasoning text, for the collapsed trace row. */
function summarise(text: string): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  if (!clean) return 'Reasoning';
  const cut = clean.slice(0, 120);
  const stop = cut.lastIndexOf('. ');
  return (stop > 30 ? cut.slice(0, stop + 1) : cut) + (clean.length > 120 && stop <= 30 ? '…' : '');
}

export interface LlmAgentOptions {
  provider: LlmProvider;
  onFailure: (err: unknown) => void;
}

export class LlmAgent implements DispatchAgent {
  readonly engine: LlmProvider['engine'];

  private fallback = new ReasonerAgent();

  constructor(private opts: LlmAgentOptions) {
    this.engine = opts.provider.engine;
  }

  async decide(ctx: AgentContext): Promise<AgentResult> {
    const t0 = Date.now();
    const trace: TraceStep[] = [];
    const evidence: EvidenceRef[] = [];

    const emit = (s: TraceStep) => {
      s.index = trace.length;
      trace.push(s);
      ctx.onTraceStep?.(s);
    };

    // Cost triage: routine alarms never reach the hosted model, tight rate-limit
    // window or not. Reserving it for life-safety/high-severity alarms is what
    // makes the free-tier daily allowance last a full demo session.
    const provider = this.opts.provider;
    if (!worthTheBudget(ctx.event.type)) {
      const pressured = provider.underPressure?.() ?? false;
      emit(mkStep('error', pressured
        ? `${ENGINE_LABELS[this.engine]} budget is nearly spent, holding it for higher-stakes alarms`
        : `Routine alarm, handled by the deterministic Reasoner`, t0, {
        detail:
          `This is a ${ctx.event.type.replace(/_/g, ' ')} alarm, which the local Reasoner handles on an `
          + 'explicit expected-cost policy. The hosted-model budget is reserved for life-safety and '
          + `high-severity alarms, where being wrong is expensive${pressured ? ', and the window is nearly spent besides.' : '.'}`,
      }));
      return this.viaFallback(ctx, trace, t0);
    }

    if (oneShotWanted(provider)) {
      return this.oneShot(ctx, emit, trace, evidence, t0);
    }

    const session = provider.session(
      buildSystemPrompt(ctx.world),
      buildIncidentPrompt(ctx),
      TOOL_DEFS,
    );

    try {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const callStart = Date.now();
        const res = await session.next();

        if (res.refused) throw new Error('Model declined the request.');

        for (const block of res.reasoning) {
          if (block.trim()) emit(mkStep('thinking', summarise(block), callStart, { detail: block }));
        }

        const submit = res.toolCalls.find((c) => c.name === SUBMIT_TOOL_NAME);
        if (submit) {
          const decision = decisionFromSubmit(submit.input, ctx, evidence);
          emit(mkStep('decision', `${decision.action.toUpperCase()} · ${decision.priority}`, callStart, {
            detail: decision.rationale,
          }));
          return { decision, trace, latencyMs: Date.now() - t0, engine: this.engine };
        }

        if (res.toolCalls.length === 0) {
          // Nothing to drive the loop with: no tool call and no commitment.
          break;
        }

        const results: LlmToolResult[] = [];
        for (const call of res.toolCalls) {
          const s0 = Date.now();
          emit(mkStep('tool_call', call.name, s0, { toolName: call.name, toolInput: call.input }));
          try {
            const out = await runTool(call.name, call.input, ctx);
            evidence.push(...out.evidence);
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

      emit(mkStep('error', 'Turn budget exhausted, falling back to the local Reasoner', t0, {
        detail: `The model used all ${MAX_TURNS} turns without calling ${SUBMIT_TOOL_NAME}.`,
      }));
      return this.viaFallback(ctx, trace, t0);
    } catch (err) {
      this.opts.onFailure(err);
      const msg = err instanceof Error ? err.message : String(err);
      emit(mkStep('error', `${ENGINE_LABELS[this.engine]} call failed, falling back to the local Reasoner`, t0, { detail: msg }));
      return this.viaFallback(ctx, trace, t0);
    }
  }

  /**
   * Evidence first, locally and for free, then exactly one model call for the
   * judgment. See the note on `PREFETCH_ORDER` for why this exists.
   */
  private async oneShot(
    ctx: AgentContext,
    emit: (s: TraceStep) => void,
    trace: TraceStep[],
    evidence: EvidenceRef[],
    t0: number,
  ): Promise<AgentResult> {
    const readings: string[] = [];

    for (const name of PREFETCH_ORDER) {
      const s0 = Date.now();
      emit(mkStep('tool_call', name, s0, { toolName: name }));
      try {
        const out = await runTool(name, {}, ctx);
        evidence.push(...out.evidence);
        emit(mkStep('tool_result', out.label, s0, { toolName: name, toolResult: out.result }));
        readings.push(`## ${name}\n${JSON.stringify(compact(out.result))}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emit(mkStep('error', `${name} failed`, s0, { toolName: name, detail: msg }));
      }
    }

    // Only the terminal tool is offered: the evidence tools have already run, and
    // their schemas are about 1,400 tokens we no longer have to send.
    const submitOnly = TOOL_DEFS.filter((t) => t.name === SUBMIT_TOOL_NAME);

    const prompt = `${buildIncidentPrompt(ctx)}

═══ EVIDENCE ALREADY GATHERED ═══

Every evidence tool has been run for you and the raw results are below. Do not ask for more; this
is everything available. Read it, weigh it, and call ${SUBMIT_TOOL_NAME} exactly once. That is the
only tool you have.

${readings.join('\n\n')}`;

    try {
      const session = this.opts.provider.session(buildSystemPrompt(ctx.world), prompt, submitOnly);
      const callStart = Date.now();
      const res = await session.next();

      if (res.refused) throw new Error('Model declined the request.');

      for (const block of res.reasoning) {
        if (block.trim()) emit(mkStep('thinking', summarise(block), callStart, { detail: block }));
      }

      const submit = res.toolCalls.find((c) => c.name === SUBMIT_TOOL_NAME);
      if (!submit) throw new Error(`Model returned no ${SUBMIT_TOOL_NAME} call.`);

      const decision = decisionFromSubmit(submit.input, ctx, evidence);
      emit(mkStep('decision', `${decision.action.toUpperCase()} · ${decision.priority}`, callStart, {
        detail: decision.rationale,
      }));
      return { decision, trace, latencyMs: Date.now() - t0, engine: this.engine };
    } catch (err) {
      this.opts.onFailure(err);
      const msg = err instanceof Error ? err.message : String(err);
      emit(mkStep('error', `${ENGINE_LABELS[this.engine]} call failed, falling back to the local Reasoner`, t0, { detail: msg }));
      return this.viaFallback(ctx, trace, t0);
    }
  }

  /** Degrade to the deterministic engine for this one decision, preserving the trace so far. */
  private async viaFallback(
    ctx: AgentContext, trace: TraceStep[], t0: number,
  ): Promise<AgentResult> {
    const out = await this.fallback.decide(ctx);
    for (const s of out.trace) {
      s.index = trace.length;
      trace.push(s);
    }
    // Reported as `reasoner`, because that is what decided it.
    return { decision: out.decision, trace, latencyMs: Date.now() - t0, engine: 'reasoner' };
  }
}
