/**
 * The agentic loop, written once for every hosted provider.
 *
 * A manual loop rather than an SDK tool runner, because the whole point of the
 * dispatch screen is inspectability: every reasoning block and every tool
 * round-trip is captured as a `TraceStep` and streamed to the console *as it
 * happens*, not after the turn resolves.
 *
 * Three invariants this file is responsible for, whichever vendor is behind it:
 *
 *   - **The loop always terminates with a decision.** Turn budget exhausted, a
 *     refusal, a 500, an expired key: all of them fall through to the local
 *     Reasoner with the partial trace preserved, so the operator sees what was
 *     attempted rather than an empty card.
 *   - **Evidence is accumulated from the tools, not from the model.** The
 *     citations under a decision are produced by `runTool`, so a model cannot
 *     invent a source it did not actually consult.
 *   - **The trace format is identical across engines.** Same step kinds, same
 *     ordering, same labels.
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
 * Is this alarm worth a scarce model call?
 *
 * Only consulted when the provider says its rate-limit window is nearly spent.
 * The rule is the same one a shift supervisor uses when short-handed: spend
 * judgment where being wrong is expensive, and let standing policy handle the
 * rest. A robot-obstruction alert at 3am does not need a large language model;
 * a person-down does.
 *
 * Note what this is *not*: it is not a confidence threshold on the model's own
 * output, which would be circular. It keys off the prior cost of being wrong,
 * which is known before any call is made.
 */
function worthTheBudget(type: Parameters<typeof isLifeSafety>[0]): boolean {
  return isLifeSafety(type) || TYPE_PROFILE[type].severity >= 4;
}

/**
 * One-shot mode: run the evidence tools here, ask the model once.
 *
 * The agentic loop is the better design when tokens are cheap: letting the agent
 * choose what to check is real behaviour, and the trace of it is worth watching.
 * It is the wrong design against a metered free tier, because the fixed prompt is
 * re-sent on every turn. Measured against one, a two-turn decision cost more than
 * an entire minute's allowance, so it could never complete, and the tokens were
 * spent anyway on a call that ended in a fallback.
 *
 * So by default the loop inverts: all six evidence tools run locally
 * (they are deterministic and free), their results go into the prompt, the six
 * tool schemas come *out* of the request, and the model is asked for the one
 * thing only it can give, which is the judgment. That is a single call at around
 * 60% of the tokens, and it fits inside one window.
 *
 * What is lost is real and worth naming: the agent no longer chooses its own
 * evidence. What is kept is everything the operator sees, since the trace still
 * shows every tool call, every result, the model's reasoning and its decision.
 */
const PREFETCH_ORDER = [
  TOOL_NAMES.zoneHistory,
  TOOL_NAMES.zoneContext,
  TOOL_NAMES.correlate,
  TOOL_NAMES.playbook,
  TOOL_NAMES.precedent,
  TOOL_NAMES.responders,
] as const;

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

    // Rate-limit triage. Failing the call and then falling back wastes both the
    // tokens and the wall-clock; deciding not to spend them is strictly better.
    const provider = this.opts.provider;
    if (provider.underPressure?.() && !worthTheBudget(ctx.event.type)) {
      emit(mkStep('error', `${ENGINE_LABELS[this.engine]} budget is nearly spent, holding it for higher-stakes alarms`, t0, {
        detail:
          `This is a ${ctx.event.type.replace(/_/g, ' ')} alarm, which the local Reasoner handles on an `
          + 'explicit expected-cost policy. The remaining hosted-model budget in this window is reserved '
          + 'for life-safety and high-severity alarms, where being wrong is expensive.',
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

        // Surface reasoning before anything else in the turn.
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

        // Execute every call, then hand back all results together.
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
        readings.push(`## ${name}\n${JSON.stringify(out.result)}`);
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
