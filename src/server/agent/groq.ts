/**
 * The Groq provider.
 *
 * Groq serves open-weight models on their own inference hardware behind an
 * OpenAI-shaped API. For this product that trade is a good one: a dispatch
 * console is a latency-sensitive surface, and a decision that lands in a second
 * rather than four changes how the screen feels to work at.
 *
 * Two deliberate choices:
 *
 *   - **`fetch`, not an SDK.** The request is one documented JSON body and the
 *     response is one documented JSON body. A dependency would buy retries,
 *     which are twenty lines here, and cost control over the exact error text
 *     that reaches the trace inspector, which is the surface this whole product
 *     is about.
 *   - **Capability probing, not a model allowlist.** Reasoning traces and
 *     schema-constrained output are not available on every model Groq hosts, and
 *     a hard-coded list of which is which rots the day they add one. Instead the
 *     first request asks for both; a 400 that names the unsupported feature
 *     switches it off for the rest of the process and the call is retried. The
 *     console degrades to fewer trace rows rather than to an error card.
 *
 * On rate limits, which are the binding constraint here rather than an edge
 * case: Groq's free tier meters tokens per minute, and it counts the requested
 * completion budget against that meter, not just the tokens actually produced.
 * A fixed prompt of roughly four thousand tokens therefore buys one or two
 * decisions a minute. This provider tracks the real budget from the response
 * headers and refuses locally when the next call cannot fit, so the incident
 * falls back to the Reasoner in a millisecond instead of stalling the queue for
 * thirty seconds and then failing anyway. Slower simulation speeds keep the
 * hosted model in the loop; 64x will outrun any free tier.
 *
 * That measurement is also why `loop.ts` runs one-shot against a metered
 * provider: a two-turn agentic decision costs more than an entire minute's
 * allowance, so it could never complete, and the tokens were being spent on
 * calls that ended in a fallback regardless.
 */

import type {
  LlmProvider, LlmSession, LlmToolResult, LlmTurn, ProviderOptions,
} from './provider';
import { RETRY, isRetryable, sleep } from './provider';
import type { ToolDef } from './tools';

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * Completion budgets, deliberately tight. Groq charges the *requested* budget
 * against the per-minute token meter, not the tokens actually produced, so an
 * 8k default would spend the entire free-tier allowance on headroom no dispatch
 * decision has ever needed. A `submit_decision` payload with a three-sentence
 * rationale plus reasoning measures well under a thousand tokens.
 */
const CHAT_MAX_TOKENS = 1200;
const JSON_MAX_TOKENS = 4096;

/**
 * What one complete decision costs: the system prompt, the incident, the
 * pre-gathered evidence, the terminal tool schema and the completion budget.
 * Used only to answer "is there enough left in this window to bother".
 */
const TYPICAL_CALL_TOKENS = 6_100;   // measured: ~4,850 prompt + the completion budget

/** Longest a waiting caller will sit on a spent token window. One window plus slack. */
const MAX_BUDGET_WAIT_MS = 70_000;

/**
 * Default because it is the strongest tool-caller Groq hosts, exposes its
 * reasoning, and honours a JSON schema, which are exactly the three things this
 * product needs from a model.
 */
export const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b';

/** SENTRY speaks Anthropic's five-step effort scale; Groq takes three. */
function toReasoningEffort(effort: string): 'low' | 'medium' | 'high' {
  switch (effort) {
    case 'low': return 'low';
    case 'high': case 'xhigh': case 'max': return 'high';
    default: return 'medium';
  }
}

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
      reasoning?: string | null;
      tool_calls?: Array<{ id: string; type?: string; function?: { name?: string; arguments?: string } }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Groq surfaces refusals as a finish reason rather than a distinct stop type. */
const REFUSAL_REASONS = new Set(['content_filter']);

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
export class GroqRateLimitError extends Error {
  constructor(message: string, readonly retryInMs: number) {
    super(message);
    this.name = 'GroqRateLimitError';
  }
}

/** Groq writes reset windows as `7.66s`, `2m59.56s`, `120ms`. */
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

function toGroqTools(tools: ToolDef[]) {
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

export class GroqProvider implements LlmProvider {
  readonly engine = 'groq' as const;
  readonly model: string;
  readonly effort: string;

  /** Flipped off permanently if the model rejects the feature. See the header. */
  private supportsReasoning = true;
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
    return new GroqSession(this, [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], toGroqTools(tools));
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
        max_completion_tokens: maxCompletion,
        ...body,
      };
      if (mode === 'chat' && this.supportsReasoning) {
        payload.reasoning_effort = toReasoningEffort(this.effort);
        payload.reasoning_format = 'parsed';
      }

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
        lastError = new Error(`Groq request failed: ${err instanceof Error ? err.message : String(err)}`);
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
        throw new GroqRateLimitError(
          daily
            ? `Groq daily token allowance is spent (${errorMessage(text)}). It resets in `
              + `${Math.ceil(wait / 60_000)} min. Slowing the simulation will not help; this is a `
              + 'per-day cap. Upgrade the Groq tier, or keep running on the Reasoner, which is fully functional.'
            : `Groq per-minute rate limit reached (${errorMessage(text)}). It refills in `
              + `${Math.ceil(wait / 1000)}s. Lower the simulation speed to keep the hosted model in the loop.`,
          wait,
        );
      }

      lastError = new Error(`Groq ${res.status}: ${errorMessage(text)}`);
      if (!isRetryable(res.status)) throw lastError;
      await sleep(RETRY.baseDelayMs * 2 ** attempt);
    }

    throw lastError ?? new Error('Groq request failed after retries.');
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
    throw new GroqRateLimitError(
      `Groq token budget for this minute is spent (${b.remaining} left, this call needs about ${estimate}). ` +
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
    if (mode === 'chat' && this.supportsReasoning && t.includes('reasoning')) {
      this.supportsReasoning = false;
      return true;
    }
    if (mode === 'json' && this.supportsJsonSchema
      && (t.includes('json_schema') || t.includes('response_format'))) {
      this.supportsJsonSchema = false;
      return true;
    }
    return false;
  }
}

class GroqSession implements LlmSession {
  constructor(
    private provider: GroqProvider,
    private messages: ChatMessage[],
    private tools: ReturnType<typeof toGroqTools>,
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
      reasoning: msg.reasoning ? [msg.reasoning] : [],
      text: msg.content ?? '',
      toolCalls,
      usage: {
        in: res.usage?.prompt_tokens ?? 0,
        out: res.usage?.completion_tokens ?? 0,
        cacheRead: 0,
      },
      refused: REFUSAL_REASONS.has(choice?.finish_reason ?? ''),
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

/** Pull the human-readable line out of Groq's error envelope. */
function errorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    return parsed.error?.message ?? body.slice(0, 200);
  } catch {
    return body.slice(0, 200);
  }
}
