/**
 * The Claude provider.
 *
 * Prompt-cache discipline: `TOOL_DEFS` order is frozen and `buildSystemPrompt`
 * is stable across incidents, so the tools+system prefix is cached and only the
 * per-incident tail is billed at full rate.
 *
 * Anthropic-specific detail the seam has to hide: thinking blocks are signed and
 * must be echoed back verbatim on the following turn, so the session keeps the
 * raw content array rather than a normalised copy of it.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { LlmProvider, LlmSession, LlmToolResult, LlmTurn, ProviderOptions } from './provider';
import type { ToolDef } from './tools';

const MAX_TOKENS = 8000;

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-4-8';

function toAnthropicTools(tools: ToolDef[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Tool.InputSchema,
    ...(t.strict ? { strict: true } : {}),
  }));
}

class ClaudeSession implements LlmSession {
  private messages: Anthropic.MessageParam[];

  constructor(
    private client: Anthropic,
    private opts: ProviderOptions,
    private system: string,
    user: string,
    private tools: Anthropic.Tool[],
  ) {
    this.messages = [{ role: 'user', content: user }];
  }

  async next(): Promise<LlmTurn> {
    const res = await this.client.messages.create({
      model: this.opts.model,
      max_tokens: MAX_TOKENS,
      // Adaptive thinking is the only supported mode on Opus 4.8; `display`
      // must be explicit or the blocks arrive with empty text and the trace
      // inspector shows nothing.
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: this.opts.effort as Anthropic.OutputConfig['effort'] },
      system: [{ type: 'text', text: this.system, cache_control: { type: 'ephemeral' } }],
      tools: this.tools,
      messages: this.messages,
    });

    const usage = {
      in: res.usage.input_tokens ?? 0,
      out: res.usage.output_tokens ?? 0,
      cacheRead: res.usage.cache_read_input_tokens ?? 0,
    };
    this.opts.onUsage(usage);

    // Thinking blocks must be echoed back unchanged for the next turn.
    this.messages.push({ role: 'assistant', content: res.content });

    return {
      reasoning: res.content
        .filter((b): b is Anthropic.ThinkingBlock => b.type === 'thinking')
        .map((b) => b.thinking)
        .filter((t) => t.length > 0),
      text: res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n'),
      toolCalls: res.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> })),
      usage,
      refused: res.stop_reason === 'refusal',
    };
  }

  addToolResults(results: LlmToolResult[]): void {
    this.messages.push({
      role: 'user',
      content: results.map((r): Anthropic.ToolResultBlockParam => ({
        type: 'tool_result',
        tool_use_id: r.id,
        content: r.content,
        ...(r.isError ? { is_error: true } : {}),
      })),
    });
  }
}

export class ClaudeProvider implements LlmProvider {
  readonly engine = 'claude' as const;
  readonly model: string;
  readonly effort: string;

  private client: Anthropic;
  private tools: Anthropic.Tool[] | null = null;

  constructor(private opts: ProviderOptions) {
    this.model = opts.model;
    this.effort = opts.effort;
    this.client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 2 });
  }

  session(system: string, user: string, tools: ToolDef[]): LlmSession {
    // Built once: reordering the tool block would invalidate the prompt cache
    // for every incident that follows.
    this.tools ??= toAnthropicTools(tools);
    return new ClaudeSession(this.client, this.opts, system, user, this.tools);
  }

  async json(system: string, user: string, schema: Record<string, unknown>): Promise<unknown> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: MAX_TOKENS,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'high', format: { type: 'json_schema', schema } },
      system,
      messages: [{ role: 'user', content: user }],
    });
    this.opts.onUsage({
      in: res.usage.input_tokens ?? 0,
      out: res.usage.output_tokens ?? 0,
      cacheRead: res.usage.cache_read_input_tokens ?? 0,
    });
    const text = res.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
    return JSON.parse(text);
  }
}
