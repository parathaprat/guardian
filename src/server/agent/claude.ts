/**
 * SENTRY, the Claude judgment layer.
 *
 * A manual agentic loop rather than the SDK tool runner, because the whole point
 * of this screen is inspectability: we need to capture every thinking block and
 * every tool round-trip as a `TraceStep` and stream it to the console *as it
 * happens*, not after the turn resolves.
 *
 * Prompt-cache discipline: `TOOL_DEFS` order is frozen and `buildSystemPrompt` is
 * stable across incidents, so the tools+system prefix is cached and only the
 * per-incident tail is billed at full rate.
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  AgentDecision, EvidenceRef, TraceStep,
} from '../../shared/types';
import type { AgentContext, DispatchAgent } from '../contracts';
import { SUBMIT_TOOL_NAME, TOOL_DEFS, decisionFromSubmit, runTool } from './tools';
import { buildIncidentPrompt, buildSystemPrompt } from './prompt';
import { ReasonerAgent } from './reasoner';

const MAX_TURNS = 6;
const MAX_TOKENS = 8000;

export interface ClaudeAgentOptions {
  apiKey: string;
  model: string;
  effort: string;
  onUsage: (u: { in: number; out: number; cacheRead: number }) => void;
  onFailure: (err: unknown) => void;
}

/** The submit tool is appended last so the evidence tools keep a stable cache prefix. */
const SUBMIT_TOOL = {
  name: SUBMIT_TOOL_NAME,
  description:
    'Commit to a dispatch decision. Call this exactly once, after you have gathered enough evidence. ' +
    'This ends your turn.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: {
        type: 'string',
        enum: ['dispatch', 'escalate', 'monitor', 'suppress'],
        description: 'dispatch = send one responder; escalate = supervisor + responder; monitor = hold and re-check; suppress = auto-close as a nuisance alarm.',
      },
      priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
      severity: { type: 'integer', description: 'Expected severity 1-5 if this turns out to be real.' },
      confidence: { type: 'number', description: 'Your confidence in this decision, 0-1.' },
      false_alarm_probability: { type: 'number', description: 'Your estimate that this event is not real, 0-1.' },
      responder_id: { type: 'string', description: 'Responder id when dispatching or escalating; empty string otherwise.' },
      instruction: { type: 'string', description: 'The instruction issued to the responder or supervisor.' },
      rationale: { type: 'string', description: 'Two or three plain sentences for an ops manager. No hedging, no restating the event.' },
      recheck_after_minutes: { type: 'integer', description: 'For monitor, minutes until re-evaluation. 0 otherwise.' },
    },
    required: [
      'action', 'priority', 'severity', 'confidence', 'false_alarm_probability',
      'responder_id', 'instruction', 'rationale', 'recheck_after_minutes',
    ],
  },
} as const;

let stepSeq = 0;

function mkStep(kind: TraceStep['kind'], label: string, startedAt: number, extra: Partial<TraceStep> = {}): TraceStep {
  return {
    id: `TC-${++stepSeq}`,
    index: 0,
    kind,
    durationMs: Math.max(0, Date.now() - startedAt),
    label,
    ...extra,
  };
}

/** First sentence of the thinking text, for the collapsed trace row. */
function summarise(text: string): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  if (!clean) return 'Reasoning';
  const cut = clean.slice(0, 120);
  const stop = cut.lastIndexOf('. ');
  return (stop > 30 ? cut.slice(0, stop + 1) : cut) + (clean.length > 120 && stop <= 30 ? '…' : '');
}

export class ClaudeAgent implements DispatchAgent {
  readonly engine = 'claude' as const;

  private client: Anthropic;
  private fallback = new ReasonerAgent();
  private tools: Anthropic.Tool[];

  constructor(private opts: ClaudeAgentOptions) {
    this.client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 2 });
    this.tools = [
      ...TOOL_DEFS.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as Anthropic.Tool.InputSchema,
        ...(t.strict ? { strict: true } : {}),
      })),
      {
        name: SUBMIT_TOOL.name,
        description: SUBMIT_TOOL.description,
        strict: true,
        input_schema: SUBMIT_TOOL.input_schema as unknown as Anthropic.Tool.InputSchema,
      },
    ];
  }

  async decide(ctx: AgentContext): Promise<{ decision: AgentDecision; trace: TraceStep[]; latencyMs: number }> {
    const t0 = Date.now();
    const trace: TraceStep[] = [];
    const evidence: EvidenceRef[] = [];

    const emit = (s: TraceStep) => {
      s.index = trace.length;
      trace.push(s);
      ctx.onTraceStep?.(s);
    };

    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: buildIncidentPrompt(ctx) },
    ];

    try {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const callStart = Date.now();
        const res = await this.client.messages.create({
          model: this.opts.model,
          max_tokens: MAX_TOKENS,
          // Adaptive thinking is the only supported mode on Opus 4.8; `display`
          // must be explicit or the blocks arrive with empty text and the trace
          // inspector shows nothing.
          thinking: { type: 'adaptive', display: 'summarized' },
          output_config: { effort: this.opts.effort as Anthropic.OutputConfig['effort'] },
          system: [
            {
              type: 'text',
              text: buildSystemPrompt(ctx.world),
              cache_control: { type: 'ephemeral' },
            },
          ],
          tools: this.tools,
          messages,
        });

        this.opts.onUsage({
          in: res.usage.input_tokens ?? 0,
          out: res.usage.output_tokens ?? 0,
          cacheRead: res.usage.cache_read_input_tokens ?? 0,
        });

        if (res.stop_reason === 'refusal') {
          throw new Error('Model declined the request.');
        }

        // Surface reasoning before anything else in the turn.
        for (const block of res.content) {
          if (block.type === 'thinking' && block.thinking) {
            emit(mkStep('thinking', summarise(block.thinking), callStart, { detail: block.thinking }));
          }
        }

        const toolUses = res.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
        );

        // Thinking blocks must be echoed back unchanged for the next turn.
        messages.push({ role: 'assistant', content: res.content });

        const submit = toolUses.find((b) => b.name === SUBMIT_TOOL_NAME);
        if (submit) {
          const decision = decisionFromSubmit(
            submit.input as Record<string, unknown>, ctx, evidence,
          );
          emit(mkStep('decision', `${decision.action.toUpperCase()} · ${decision.priority}`, callStart, {
            detail: decision.rationale,
          }));
          return { decision, trace, latencyMs: Date.now() - t0 };
        }

        if (res.stop_reason !== 'tool_use' || toolUses.length === 0) {
          // No tool call and no submit, nothing more to drive the loop with.
          break;
        }

        // Execute every tool_use, then return ALL results in one user message.
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const use of toolUses) {
          const s0 = Date.now();
          emit(mkStep('tool_call', use.name, s0, { toolName: use.name, toolInput: use.input }));
          try {
            const out = await runTool(use.name, (use.input ?? {}) as Record<string, unknown>, ctx);
            evidence.push(...out.evidence);
            emit(mkStep('tool_result', out.label, s0, { toolName: use.name, toolResult: out.result }));
            results.push({
              type: 'tool_result',
              tool_use_id: use.id,
              content: JSON.stringify(out.result),
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            emit(mkStep('error', `${use.name} failed`, s0, { toolName: use.name, detail: msg }));
            results.push({
              type: 'tool_result', tool_use_id: use.id, content: msg, is_error: true,
            });
          }
        }
        messages.push({ role: 'user', content: results });
      }

      // Ran out of turns without committing.
      emit(mkStep('error', 'Turn budget exhausted, falling back to the local Reasoner', t0, {
        detail: `The model used all ${MAX_TURNS} turns without calling ${SUBMIT_TOOL_NAME}.`,
      }));
      return this.viaFallback(ctx, trace, t0);
    } catch (err) {
      this.opts.onFailure(err);
      const msg = err instanceof Error ? err.message : String(err);
      emit(mkStep('error', 'Claude call failed, falling back to the local Reasoner', t0, { detail: msg }));
      return this.viaFallback(ctx, trace, t0);
    }
  }

  /** Degrade to the deterministic engine for this one decision, preserving the trace so far. */
  private async viaFallback(
    ctx: AgentContext, trace: TraceStep[], t0: number,
  ): Promise<{ decision: AgentDecision; trace: TraceStep[]; latencyMs: number }> {
    const out = await this.fallback.decide(ctx);
    for (const s of out.trace) {
      s.index = trace.length;
      trace.push(s);
    }
    return { decision: out.decision, trace, latencyMs: Date.now() - t0 };
  }
}
