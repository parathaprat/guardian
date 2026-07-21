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
import { SUBMIT_TOOL_NAME, TOOL_DEFS, decisionFromSubmit, runTool } from './tools';
import { buildIncidentPrompt, buildSystemPrompt } from './prompt';
import { ReasonerAgent } from './reasoner';

const MAX_TURNS = 6;

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

    const session = this.opts.provider.session(
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
