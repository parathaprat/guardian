/**
 * Engine selection and the status readout the console header shows.
 *
 * The product is fully functional with no API key at all: `ReasonerAgent` is a
 * real expected-cost policy, not a stub. A key upgrades the judgment layer and
 * unlocks LLM-authored playbook proposals; it is never a prerequisite.
 *
 * Two hosted providers are supported and they are interchangeable. Selection is
 * by whichever key is present, with `SENTRY_PROVIDER` as an explicit override
 * for the case where both are.
 */

import type { EngineStatus, LlmEngineKind } from '../../shared/types';
import type { DispatchAgent } from '../contracts';
import { ClaudeProvider, DEFAULT_CLAUDE_MODEL } from './claude';
import { GroqProvider, DEFAULT_GROQ_MODEL } from './groq';
import { LlmAgent } from './loop';
import type { LlmProvider } from './provider';
import { ReasonerAgent } from './reasoner';

const state = {
  engine: 'reasoner' as EngineStatus['engine'],
  model: 'local-reasoner',
  effort: 'n/a',
  note: null as string | null,
  callsMade: 0,
  callsFailed: 0,
  tokensIn: 0,
  tokensOut: 0,
  cachedTokensRead: 0,
};

/** Held so the reflection pass reuses the same client and the same token counters. */
let provider: LlmProvider | null = null;

export function noteEngineCall(ok: boolean): void {
  state.callsMade += 1;
  if (!ok) state.callsFailed += 1;
}

export function engineStatus(): EngineStatus {
  return { ...state };
}

/** The active hosted provider, or null when running on the local Reasoner. */
export function activeProvider(): LlmProvider | null {
  return provider;
}

export interface ProviderChoice {
  kind: LlmEngineKind;
  apiKey: string;
  model: string;
  effort: string;
}

/**
 * Which provider the environment asks for.
 *
 * `SENTRY_PROVIDER` wins when set. Otherwise whichever key is present; with both
 * present Anthropic wins, because Opus is the stronger judgment layer and a
 * leftover Groq key should not quietly downgrade it.
 */
export function resolveProviderChoice(env: NodeJS.ProcessEnv = process.env): ProviderChoice | null {
  const anthropicKey = env.ANTHROPIC_API_KEY?.trim() ?? '';
  const groqKey = env.GROQ_API_KEY?.trim() ?? '';
  const asked = env.SENTRY_PROVIDER?.trim().toLowerCase() ?? '';
  const effort = env.SENTRY_EFFORT?.trim() || 'medium';

  const wants: LlmEngineKind | null =
    asked === 'claude' || asked === 'anthropic' ? 'claude'
    : asked === 'groq' ? 'groq'
    : anthropicKey ? 'claude'
    : groqKey ? 'groq'
    : null;

  if (wants === 'claude' && anthropicKey) {
    return {
      kind: 'claude',
      apiKey: anthropicKey,
      model: env.SENTRY_MODEL?.trim() || DEFAULT_CLAUDE_MODEL,
      effort,
    };
  }
  if (wants === 'groq' && groqKey) {
    return {
      kind: 'groq',
      apiKey: groqKey,
      model: env.GROQ_MODEL?.trim() || DEFAULT_GROQ_MODEL,
      effort,
    };
  }
  return null;
}

export function buildProvider(
  choice: ProviderChoice,
  onUsage: (u: { in: number; out: number; cacheRead: number }) => void,
): LlmProvider {
  const opts = { apiKey: choice.apiKey, model: choice.model, effort: choice.effort, onUsage };
  return choice.kind === 'claude' ? new ClaudeProvider(opts) : new GroqProvider(opts);
}

/** Human-readable reason the console is running without a hosted model. */
function coldNote(env: NodeJS.ProcessEnv): string {
  const asked = env.SENTRY_PROVIDER?.trim().toLowerCase() ?? '';
  const wanted = asked === 'groq' ? 'GROQ_API_KEY'
    : asked === 'claude' || asked === 'anthropic' ? 'ANTHROPIC_API_KEY'
    : 'ANTHROPIC_API_KEY or GROQ_API_KEY';
  return `No ${wanted} set, running the deterministic Reasoner. Every feature works; decisions come ` +
    'from an explicit expected-cost policy instead of a hosted model. Add a key to .env to upgrade.';
}

export function createAgent(): DispatchAgent {
  const choice = resolveProviderChoice();

  if (!choice) {
    provider = null;
    state.engine = 'reasoner';
    state.model = 'local-reasoner';
    state.effort = 'n/a';
    state.note = coldNote(process.env);
    return new ReasonerAgent();
  }

  provider = buildProvider(choice, (u) => {
    state.tokensIn += u.in;
    state.tokensOut += u.out;
    state.cachedTokensRead += u.cacheRead;
  });

  state.engine = choice.kind;
  state.model = choice.model;
  state.effort = choice.effort;
  state.note = null;

  return new LlmAgent({
    provider,
    onFailure: (err) => {
      state.note = `Last ${choice.kind === 'claude' ? 'Claude' : 'Groq'} call failed ` +
        `(${err instanceof Error ? err.message : String(err)}). ` +
        'That decision fell back to the local Reasoner; the console keeps running.';
    },
  });
}
