/**
 * The vendor seam: the smallest interface a hosted model must satisfy to drive
 * the agentic loop in `loop.ts`. Keeps the local Reasoner and hosted model
 * interchangeable (see DECISIONS.md) and keeps provider-specific message
 * formats out of the loop.
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
   * True when close to a rate limit; the loop spends what's left on incidents
   * that need judgment rather than nuisance alarms. Optional: providers
   * without rate-limit headers never report pressure.
   */
  underPressure?(): boolean;
  /** Start a dispatch conversation. `tools` order is frozen for cache stability. */
  session(system: string, user: string, tools: ToolDef[]): LlmSession;
  /**
   * One-shot call constrained to a JSON schema, used by the reflection pass.
   * Throws on transport or parse failure so the caller can fall back to the
   * statistical pass.
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
