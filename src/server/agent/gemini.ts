/**
 * The Gemini provider, talking to Google's OpenAI-compatible `/chat/completions` endpoint rather
 * than the native API (see DECISIONS.md Decision 8). Plain `fetch`, no SDK: capability probing
 * (a 400 naming a feature switches it off) replaces a model allowlist that would rot on contact.
 */

import type {
  LlmProvider, LlmSession, LlmToolResult, LlmTurn, ProviderOptions,
} from './provider';
import { RETRY, isRetryable, sleep } from './provider';
import type { ToolDef } from './tools';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

/**
 * Thinking tokens count against `max_tokens` but are invisible in `completion_tokens`. Budget too
 * tight and the model runs out mid-call, reported as `MALFORMED_FUNCTION_CALL` (reads like a schema
 * bug, isn't one). 2000 clears the observed thinking ceiling with room to spare.
 */
const CHAT_MAX_TOKENS = 2000;
const JSON_MAX_TOKENS = 6000;

/** What one full decision call costs, measured; used only to check if the budget can afford another. */
const TYPICAL_CALL_TOKENS = 6_000;

/** Longest a waiting caller will sit on a spent token window. One window plus slack. */
const MAX_BUDGET_WAIT_MS = 70_000;

/**
 * guard[ai]n's five-step effort scale maps to Gemini's three. `low` is the default not for cost but
 * because the evidence is already gathered and weighed; `medium` just buys latency the operator feels.
 */
function toReasoningEffort(effort: string): 'low' | 'medium' | 'high' {
  switch (effort) {
    case 'medium': return 'medium';
    case 'high': case 'xhigh': case 'max': return 'high';
    default: return 'low';
  }
}

/**
 * Chosen by measurement against the free tier: it meters requests per day per model, and
 * `gemini-3.6-flash`'s 20/day is spent by the console in about a minute. Flash-lite is the tier
 * Google actually gives away, survives sustained calling, and answers in ~1.6s versus 5s.
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
    /** Opaque passthrough, required on the way back in. See `OpenAiSession.next`. */
    extra_content?: unknown;
  }>;
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
      tool_calls?: Array<{
        id: string;
        type?: string;
        function?: { name?: string; arguments?: string };
        /**
         * Carries `google.thought_signature`. Opaque, and the API rejects the
         * next turn without it. See the echo in `OpenAiSession.next`.
         */
        extra_content?: unknown;
      }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Refusals arrive as a finish reason rather than a distinct stop type. */
const REFUSAL_REASONS = new Set(['content_filter', 'safety', 'prohibited_content', 'blocklist']);

/** What the account has left in the current window, as reported by the last response. */
interface TokenBudget {
  remaining: number;
  /** Wall-clock ms at which the window refills. */
  resetAt: number;
  /** Why we stood down, kept so every subsequent refusal repeats the real reason (daily vs per-minute). */
  reason?: string;
}

/** Distinguishable so the trace can say "rate limited" rather than "failed". */
export class GeminiRateLimitError extends Error {
  constructor(message: string, readonly retryInMs: number) {
    super(message);
    this.name = 'GeminiRateLimitError';
  }
}

/**
 * No rate-limit headers on this endpoint, so a 429's error body is the only source for which
 * quota was hit and how long to wait. Per-minute and per-day exhaustion need opposite responses.
 */
interface QuotaFailure {
  perDay: boolean;
  /** The allowance, as the API states it. */
  limit: string | null;
  retryMs: number | null;
}

function parseQuota(body: string): QuotaFailure {
  const quotaId = /"quotaId"\s*:\s*"([^"]+)"/.exec(body)?.[1] ?? '';
  // Must end on a digit: the body reads "limit: 500, model: ...", and a greedy [\d,]+ swallows the comma.
  const limit = /limit:\s*(\d(?:[\d,]*\d)?)/.exec(body)?.[1] ?? null;
  const retry = /"retryDelay"\s*:\s*"([^"]+)"/.exec(body)?.[1]
    ?? /retry in ([\d.]+)s/i.exec(body)?.[1];
  return {
    perDay: /PerDay/i.test(quotaId) || /per day/i.test(body),
    limit,
    retryMs: retry ? parseDuration(retry) : null,
  };
}

/**
 * Google's `retryDelay` on a per-day quota violation is a per-minute figure; retrying on it just
 * earns another 429. Standing down properly costs nothing, the Reasoner covers every incident meanwhile.
 */
const DAILY_STAND_DOWN_MS = 15 * 60_000;

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
   * One request, with retries and one capability downgrade if the model rejects reasoning/schema
   * output. Rate limits refuse early rather than wait: blocking on a token bucket is worse than
   * answering immediately from the local policy.
   */
  async post(body: Record<string, unknown>, mode: 'chat' | 'json'): Promise<ChatResponse> {
    const maxCompletion = mode === 'chat' ? CHAT_MAX_TOKENS : JSON_MAX_TOKENS;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < RETRY.attempts; attempt++) {
      const payload: Record<string, unknown> = {
        model: this.model,
        max_tokens: maxCompletion,
        reasoning_effort: toReasoningEffort(this.effort),
        ...body,
      };
      // Dispatch decisions fail fast (the Reasoner covers them); the human-initiated reflection
      // pass has no equally good substitute, so it's allowed to wait out the window instead.
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

      // A 400 naming an opted-in feature is a capability answer: switch it off and retry.
      if (res.status === 400 && this.downgrade(text, mode)) continue;

      // 413 is the same rate limit as 429, reported as an oversized request when the
      // requested budget won't fit the window.
      if (res.status === 429 || res.status === 413) {
        const quota = parseQuota(text);
        const wait = quota.perDay
          ? DAILY_STAND_DOWN_MS
          : quota.retryMs ?? parseDuration(res.headers.get('retry-after')) ?? 60_000;

        if (!quota.perDay && mode === 'json' && wait <= MAX_BUDGET_WAIT_MS && attempt < RETRY.attempts - 1) {
          await sleep(wait + 250);
          this.budget = null;
          continue;
        }

        const allowance = quota.limit ? ` The free-tier allowance for ${this.model} is ${quota.limit}.` : '';
        const reason = quota.perDay
          ? `Gemini's daily free-tier quota is spent.${allowance} It resets at midnight Pacific. `
            + 'Slowing the simulation will not help, this is a per-day cap on requests. Every decision '
            + 'now comes from the local Reasoner, which is fully functional; switch GEMINI_MODEL or '
            + 'raise the quota in Google AI Studio to get the hosted model back.'
          : `Gemini rate limit reached.${allowance} `
            + 'Lower the simulation speed to keep the hosted model in the loop.';
        this.budget = { remaining: 0, resetAt: Date.now() + wait, reason };
        throw new GeminiRateLimitError(reason, wait);
      }

      lastError = new Error(`Gemini ${res.status}: ${errorMessage(text)}`);
      if (!isRetryable(res.status)) throw lastError;
      await sleep(RETRY.baseDelayMs * 2 ** attempt);
    }

    throw lastError ?? new Error('Gemini request failed after retries.');
  }

  /**
   * Refuse or wait when the account can't afford the call. `mayWait` callers block until the
   * window refills; everyone else throws so the caller can degrade immediately.
   */
  private async awaitBudget(estimate: number, mayWait: boolean): Promise<void> {
    const b = this.budget;
    if (!b) return;
    const remainingMs = b.resetAt - Date.now();
    if (remainingMs <= 0) { this.budget = null; return; }
    if (estimate <= b.remaining) return;

    if (mayWait && remainingMs <= MAX_BUDGET_WAIT_MS) {
      await sleep(remainingMs + 250);
      this.budget = null;
      return;
    }
    // Repeat the endpoint's own reason where we have it: a stood-down day and a
    // spent minute call for different things from the operator.
    throw new GeminiRateLimitError(
      b.reason
        ? `${b.reason} (Retrying in ${Math.ceil(remainingMs / 1000)}s.)`
        : `Gemini token budget for this window is spent (${b.remaining} left, this call needs about `
          + `${estimate}). It refills in ${Math.ceil(remainingMs / 1000)}s.`,
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

    // Echo the assistant turn stripped to accepted fields (reasoning isn't accepted back in),
    // except `extra_content`: it carries `google.thought_signature`, and Gemini 400s the next
    // turn without it. Opaque, so passed through verbatim rather than parsed.
    this.messages.push({
      role: 'assistant',
      content: msg.content ?? '',
      ...(toolCalls.length > 0
        ? {
            tool_calls: (msg.tool_calls ?? []).map((c) => ({
              id: c.id,
              type: 'function' as const,
              function: { name: c.function?.name ?? '', arguments: c.function?.arguments ?? '{}' },
              ...(c.extra_content === undefined ? {} : { extra_content: c.extra_content }),
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

/** Gemini sometimes wraps the error in a JSON array, so both `{error:{...}}` and `[{error:{...}}]` unwrap. */
function errorMessage(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    const envelope = Array.isArray(parsed) ? parsed[0] : parsed;
    const message = (envelope as { error?: { message?: string } })?.error?.message;
    return message ?? body.slice(0, 200);
  } catch {
    return body.slice(0, 200);
  }
}
