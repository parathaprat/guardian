/**
 * The Gemini provider.
 *
 * Google exposes Gemini behind an OpenAI-shaped `/chat/completions` endpoint, so
 * this talks to that rather than to the native `generateContent` API. Two
 * reasons: the free tier is the most generous of the hosted options by a wide
 * margin, which is what makes a live demo possible at all, and the compatibility
 * layer keeps the request shape identical to every other OpenAI-dialect endpoint,
 * so the same file would point at a different vendor with one URL change.
 *
 * Two deliberate choices:
 *
 *   - **`fetch`, not an SDK.** The request is one documented JSON body and the
 *     response is one documented JSON body. A dependency would buy retries,
 *     which are twenty lines here, and cost control over the exact error text
 *     that reaches the trace inspector, which is the surface this whole product
 *     is about.
 *   - **Capability probing, not a model allowlist.** Schema-constrained output
 *     is not available on every model or every compatibility layer, and a
 *     hard-coded list of which is which rots on contact. The first reflection
 *     request asks for it; a 400 that names the feature switches it off for the
 *     rest of the process and the schema is enforced by the prompt instead. No
 *     reasoning controls are sent at all: Gemini 2.5 thinks by default, and the
 *     knobs for it are the least portable part of the dialect.
 *
 * On rate limits, which are a design constraint on any free tier rather than an
 * edge case: a metered endpoint counts the *requested* completion budget against
 * its meter, not just the tokens actually produced, so unused headroom is paid
 * for in throughput. This provider reads whatever budget the endpoint reports in
 * its response headers and refuses locally when the next call cannot fit, so an
 * incident falls back to the Reasoner in a millisecond instead of stalling the
 * queue and then failing anyway. An endpoint that reports no such headers simply
 * never registers pressure, and nothing else changes.
 *
 * The same arithmetic is why `loop.ts` runs one-shot here: an agentic loop
 * re-sends the fixed prompt every turn, which turned a decision into more tokens
 * than a whole minute's allowance on the tier this was first measured against.
 */

import type {
  LlmProvider, LlmSession, LlmToolResult, LlmTurn, ProviderOptions,
} from './provider';
import { RETRY, isRetryable, sleep } from './provider';
import type { ToolDef } from './tools';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

/**
 * Completion budgets, deliberately tight. A metered endpoint charges the
 * *requested* budget rather than the tokens actually produced, so unused
 * headroom is paid for in throughput. A measured `submit_decision` payload with
 * a three-sentence rationale runs about 150 tokens, so 700 is already four times
 * what the job needs.
 */
const CHAT_MAX_TOKENS = 700;
const JSON_MAX_TOKENS = 4096;

/**
 * What one complete decision costs: the system prompt, the incident, the
 * pre-gathered evidence, the terminal tool schema and the completion budget.
 * Used only to answer "is there enough left in this window to bother".
 */
const TYPICAL_CALL_TOKENS = 5_800;   // measured: ~5,050 prompt + the completion budget

/** Longest a waiting caller will sit on a spent token window. One window plus slack. */
const MAX_BUDGET_WAIT_MS = 70_000;

/**
 * Flash rather than Pro, deliberately.
 *
 * A dispatch console is a latency surface: the operator is watching the card
 * fill in. Flash answers in about a second, has the most headroom on the free
 * tier, and the judgment being asked for here is a bounded one, since the
 * evidence has already been gathered and weighed before the model sees it.
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

interface ChatResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | null;
      /** Thought summaries, where the endpoint returns them at all. */
      reasoning?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{ id: string; type?: string; function?: { name?: string; arguments?: string } }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Refusals arrive as a finish reason rather than a distinct stop type. */
const REFUSAL_REASONS = new Set(['content_filter', 'safety', 'prohibited_content', 'blocklist']);

/**
 * What the account has left in the current per-minute window, as reported by
 * the last response. Believing the server beats guessing at a limit that
 * differs per model and per tier.
 */
interface TokenBudget {
  remaining: number;
  /** Wall-clock ms at which the window refills. */
  resetAt: number;
}

/** Distinguishable so the trace can say "rate limited" rather than "failed". */
export class GeminiRateLimitError extends Error {
  constructor(message: string, readonly retryInMs: number) {
    super(message);
    this.name = 'GeminiRateLimitError';
  }
}

/** Reset windows arrive as `7.66s`, `2m59.56s`, `120ms`, or bare seconds. */
function parseDuration(raw: string | null): number | null {
  if (!raw) return null;
  const direct = Number(raw);
  if (Number.isFinite(direct)) return direct * 1000;    // bare seconds, e.g. retry-after
  let ms = 0;
  let matched = false;
  for (const [, value, unit] of raw.matchAll(/([\d.]+)(ms|s|m|h)/g)) {
    const n = Number(value);
    if (!Number.isFinite(n)) continue;
    matched = true;
    ms += n * (unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000);
  }
  return matched ? ms : null;
}

/** Rough token estimate. Only has to be good enough to avoid a doomed request. */
function estimateTokens(body: Record<string, unknown>, maxCompletion: number): number {
  return Math.ceil(JSON.stringify(body).length / 4) + maxCompletion;
}

function toOpenAiTools(tools: ToolDef[]) {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

/** Tool arguments arrive as a JSON string, and an argument-free call sends "". */
function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw || raw.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export class GeminiProvider implements LlmProvider {
  readonly engine = 'gemini' as const;
  readonly model: string;
  readonly effort: string;

  /** Flipped off permanently if the model rejects the feature. See the header. */
  private supportsJsonSchema = true;

  /** Null until the first response tells us what this account actually has. */
  private budget: TokenBudget | null = null;

  constructor(private opts: ProviderOptions) {
    this.model = opts.model;
    this.effort = opts.effort;
  }

  /** Not enough left in this window to finish a decision on this model. */
  underPressure(): boolean {
    const b = this.budget;
    if (!b || Date.now() >= b.resetAt) return false;
    return b.remaining < TYPICAL_CALL_TOKENS;
  }

  session(system: string, user: string, tools: ToolDef[]): LlmSession {
    return new OpenAiSession(this, [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], toOpenAiTools(tools));
  }

  async json(system: string, user: string, schema: Record<string, unknown>): Promise<unknown> {
    const res = await this.post({
      messages: [
        { role: 'system', content: system },
        // Belt and braces: when the schema cannot be enforced by the API, it has
        // to be enforced by the prompt, or the reflection pass returns prose.
        {
          role: 'user',
          content: this.supportsJsonSchema
            ? user
            : `${user}\n\nReturn ONLY a JSON object matching this schema, with no prose or code fences:\n${JSON.stringify(schema)}`,
        },
      ],
      ...(this.supportsJsonSchema
        ? { response_format: { type: 'json_schema', json_schema: { name: 'sentry_response', strict: true, schema } } }
        : { response_format: { type: 'json_object' } }),
    }, 'json');

    const text = res.choices?.[0]?.message?.content ?? '';
    // Some models fence their JSON even under json_object mode.
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    return JSON.parse(cleaned);
  }

  /**
   * One request, with retries for transient failures and one capability
   * downgrade if the model rejects reasoning or schema output.
   *
   * Rate limits are handled by refusing early rather than by waiting: a
   * dispatch console that blocks a minute on a token bucket is worse than one
   * that answers immediately from the local policy and says so.
   */
  async post(body: Record<string, unknown>, mode: 'chat' | 'json'): Promise<ChatResponse> {
    const maxCompletion = mode === 'chat' ? CHAT_MAX_TOKENS : JSON_MAX_TOKENS;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < RETRY.attempts; attempt++) {
      const payload: Record<string, unknown> = {
        model: this.model,
        max_tokens: maxCompletion,
        ...body,
      };
      // Live dispatch decisions fail fast, because the queue is waiting and the
      // Reasoner answers immediately. The reflection pass is human-initiated,
      // runs behind a spinner and has no equally good substitute, so it is
      // allowed to wait out the window instead.
      await this.awaitBudget(estimateTokens(payload, maxCompletion), mode === 'json');

      let res: Response;
      try {
        res = await fetch(ENDPOINT, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.opts.apiKey}`,
          },
          body: JSON.stringify(payload),
        });
      } catch (err) {
        // Network-level failure. Worth one more try, then give up to the Reasoner.
        lastError = new Error(`Gemini request failed: ${err instanceof Error ? err.message : String(err)}`);
        await sleep(RETRY.baseDelayMs * (attempt + 1));
        continue;
      }

      this.readBudget(res.headers);

      if (res.ok) {
        const json = (await res.json()) as ChatResponse;
        this.opts.onUsage({
          in: json.usage?.prompt_tokens ?? 0,
          out: json.usage?.completion_tokens ?? 0,
          cacheRead: 0,
        });
        return json;
      }

      const text = await res.text();

      // A 400 naming a feature we opted into is a capability answer, not an
      // error: switch it off and retry immediately rather than burning the turn.
      if (res.status === 400 && this.downgrade(text, mode)) continue;

      // 429 is the documented rate limit; 413 is the same limit reported as an
      // oversized request when the *requested* budget will not fit the window.
      if (res.status === 429 || res.status === 413) {
        const wait = parseDuration(res.headers.get('retry-after'))
          ?? parseDuration(res.headers.get('x-ratelimit-reset-tokens'))
          ?? 60_000;
        this.budget = { remaining: 0, resetAt: Date.now() + wait };
        if (mode === 'json' && wait <= MAX_BUDGET_WAIT_MS && attempt < RETRY.attempts - 1) {
          await sleep(wait + 250);
          this.budget = null;
          continue;
        }
        // Per-minute and per-day exhaustion need opposite responses from the
        // operator, so the note has to say which one was hit. Slowing the world
        // down does nothing for a spent daily allowance.
        const daily = /per day|\bTPD\b|tokens per day/i.test(text);
        throw new GeminiRateLimitError(
          daily
            ? `Gemini daily quota is spent (${errorMessage(text)}). It resets in `
              + `${Math.ceil(wait / 60_000)} min. Slowing the simulation will not help; this is a `
              + 'per-day cap. Raise the quota in Google AI Studio, or keep running on the Reasoner, which is fully functional.'
            : `Gemini per-minute rate limit reached (${errorMessage(text)}). It refills in `
              + `${Math.ceil(wait / 1000)}s. Lower the simulation speed to keep the hosted model in the loop.`,
          wait,
        );
      }

      lastError = new Error(`Gemini ${res.status}: ${errorMessage(text)}`);
      if (!isRetryable(res.status)) throw lastError;
      await sleep(RETRY.baseDelayMs * 2 ** attempt);
    }

    throw lastError ?? new Error('Gemini request failed after retries.');
  }

  /**
   * Refuse, or wait, when the account demonstrably cannot afford the call.
   * `mayWait` callers block until the window refills; everyone else throws so
   * the caller can degrade immediately.
   */
  private async awaitBudget(estimate: number, mayWait: boolean): Promise<void> {
    const b = this.budget;
    if (!b) return;                                   // nothing observed yet
    const remainingMs = b.resetAt - Date.now();
    if (remainingMs <= 0) { this.budget = null; return; }   // window refilled
    if (estimate <= b.remaining) return;

    if (mayWait && remainingMs <= MAX_BUDGET_WAIT_MS) {
      await sleep(remainingMs + 250);
      this.budget = null;
      return;
    }
    throw new GeminiRateLimitError(
      `Gemini token budget for this minute is spent (${b.remaining} left, this call needs about ${estimate}). ` +
      `It refills in ${Math.ceil(remainingMs / 1000)}s. Lower the simulation speed to keep the hosted model in the loop.`,
      remainingMs,
    );
  }

  private readBudget(headers: Headers): void {
    const remaining = Number(headers.get('x-ratelimit-remaining-tokens'));
    const reset = parseDuration(headers.get('x-ratelimit-reset-tokens'));
    if (!Number.isFinite(remaining) || reset === null) return;
    this.budget = { remaining, resetAt: Date.now() + reset };
  }

  /** Returns true if a capability was switched off and the call is worth retrying. */
  private downgrade(errorText: string, mode: 'chat' | 'json'): boolean {
    const t = errorText.toLowerCase();
    if (mode === 'json' && this.supportsJsonSchema
      && (t.includes('json_schema') || t.includes('response_format') || t.includes('schema'))) {
      this.supportsJsonSchema = false;
      return true;
    }
    return false;
  }
}

class OpenAiSession implements LlmSession {
  constructor(
    private provider: GeminiProvider,
    private messages: ChatMessage[],
    private tools: ReturnType<typeof toOpenAiTools>,
  ) {}

  async next(): Promise<LlmTurn> {
    const res = await this.provider.post({
      messages: this.messages,
      tools: this.tools,
      tool_choice: 'auto',
    }, 'chat');

    const choice = res.choices?.[0];
    const msg = choice?.message ?? {};

    const toolCalls = (msg.tool_calls ?? [])
      .filter((c) => typeof c.function?.name === 'string')
      .map((c) => ({
        id: c.id,
        name: c.function!.name!,
        input: parseArgs(c.function!.arguments),
      }));

    // Echo the assistant turn back stripped to the fields the API accepts:
    // reasoning is returned but not accepted on the way back in.
    this.messages.push({
      role: 'assistant',
      content: msg.content ?? '',
      ...(toolCalls.length > 0
        ? {
            tool_calls: (msg.tool_calls ?? []).map((c) => ({
              id: c.id,
              type: 'function' as const,
              function: { name: c.function?.name ?? '', arguments: c.function?.arguments ?? '{}' },
            })),
          }
        : {}),
    });

    return {
      reasoning: [msg.reasoning, msg.reasoning_content].filter((r): r is string => Boolean(r)),
      text: msg.content ?? '',
      toolCalls,
      usage: {
        in: res.usage?.prompt_tokens ?? 0,
        out: res.usage?.completion_tokens ?? 0,
        cacheRead: 0,
      },
      refused: REFUSAL_REASONS.has((choice?.finish_reason ?? '').toLowerCase()),
    };
  }

  addToolResults(results: LlmToolResult[]): void {
    for (const r of results) {
      this.messages.push({
        role: 'tool',
        tool_call_id: r.id,
        name: r.name,
        content: r.isError ? `ERROR: ${r.content}` : r.content,
      });
    }
  }
}

/** Pull the human-readable line out of the error envelope. */
function errorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    return parsed.error?.message ?? body.slice(0, 200);
  } catch {
    return body.slice(0, 200);
  }
}
