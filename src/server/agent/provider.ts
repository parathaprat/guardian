/**
 * The vendor seam.
 *
 * SENTRY's judgment layer is an agentic loop over six evidence tools and one
 * terminal tool. None of that is vendor-specific, so none of it lives in a
 * vendor file. This module defines the smallest interface that a hosted model
 * has to satisfy to drive that loop, and `loop.ts` runs the loop against it.
 *
 * Two things made this worth abstracting rather than copying:
 *
 *   1. The trace inspector is the product. Every provider has to surface its
 *      reasoning and its tool round-trips in the same `TraceStep` shape, or the
 *      console silently degrades depending on which key is in `.env`.
 *   2. A second provider is the honest way to show the memory layer is doing the
 *      work. If the numbers hold across two different model families, the gain
 *      is coming from the Bayesian channels rather than from one vendor's
 *      idiosyncrasies.
 *
 * A provider owns its own conversation history, because message formats differ
 * in ways no lowest common denominator survives: Anthropic threads signed
 * thinking blocks back through the turn, OpenAI-shaped APIs thread tool-call ids.
 */

import type { LlmEngineKind } from '../../shared/types';
import type { ToolDef } from './tools';

export interface LlmToolCall {
  /** Provider-assigned id, echoed back with the result. */
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LlmToolResult {
  id: string;
  name: string;
  /** JSON-encoded tool output, or an error message when `isError`. */
  content: string;
  isError: boolean;
}

export interface LlmUsage {
  in: number;
  out: number;
  /** Prompt-cache hits. Zero on providers that do not report them. */
  cacheRead: number;
}

export interface LlmTurn {
  /** Reasoning blocks, in order. Empty when the model exposes none. */
  reasoning: string[];
  text: string;
  toolCalls: LlmToolCall[];
  usage: LlmUsage;
  /** The model declined outright; the loop must not retry. */
  refused: boolean;
}

/**
 * One incident's conversation. Stateful on purpose: `next()` appends the
 * assistant turn to the provider's own history so the caller never has to know
 * what that history looks like.
 */
export interface LlmSession {
  next(): Promise<LlmTurn>;
  addToolResults(results: LlmToolResult[]): void;
}

export interface LlmProvider {
  readonly engine: LlmEngineKind;
  readonly model: string;
  readonly effort: string;
  /**
   * True when the account is close enough to a rate limit that the next few
   * calls are not all going to land. The loop uses this to spend what is left on
   * the incidents that actually need judgment instead of on nuisance alarms the
   * local policy already handles correctly.
   *
   * Optional: a provider with no metered window never reports pressure.
   */
  underPressure?(): boolean;
  /** Start a dispatch conversation. `tools` order is frozen for cache stability. */
  session(system: string, user: string, tools: ToolDef[]): LlmSession;
  /**
   * One-shot call constrained to a JSON schema, used by the reflection pass.
   * Returns the parsed object; throws on transport or parse failure so the
   * caller can fall back to the statistical pass.
   */
  json(system: string, user: string, schema: Record<string, unknown>): Promise<unknown>;
}

export interface ProviderOptions {
  apiKey: string;
  model: string;
  effort: string;
  onUsage: (u: LlmUsage) => void;
}

/** Retry policy shared by both providers, for rate limits and transient 5xx. */
export const RETRY = { attempts: 3, baseDelayMs: 600 } as const;

export function isRetryable(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
