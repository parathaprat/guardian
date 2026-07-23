/**
 * Engine selection and the status readout the console header shows.
 *
 * Two engines, only one needs a key: `GEMINI_API_KEY` upgrades the judgment
 * layer but is never a prerequisite (see DECISIONS.md, Decision 7).
 */

import type { EngineStatus } from '../../shared/types';
import type { DispatchAgent } from '../contracts';
import { GeminiProvider, DEFAULT_GEMINI_MODEL } from './gemini';
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
  apiKey: string;
  model: string;
  effort: string;
}

/** The hosted engine's configuration, or null when no key is set. */
export function resolveProviderChoice(env: NodeJS.ProcessEnv = process.env): ProviderChoice | null {
  const apiKey = env.GEMINI_API_KEY?.trim() ?? '';
  if (!apiKey) return null;
  return {
    apiKey,
    model: env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL,
    effort: env.SENTRY_EFFORT?.trim() || 'medium',
  };
}

export function buildProvider(
  choice: ProviderChoice,
  onUsage: (u: { in: number; out: number; cacheRead: number }) => void,
): LlmProvider {
  return new GeminiProvider({ ...choice, onUsage });
}

const COLD_NOTE =
  'No GEMINI_API_KEY set, running the deterministic Reasoner. Every feature works; decisions come ' +
  'from an explicit expected-cost policy instead of a hosted model. Add a key to .env to upgrade: ' +
  'https://aistudio.google.com/apikey';

export function createAgent(): DispatchAgent {
  const choice = resolveProviderChoice();

  if (!choice) {
    provider = null;
    state.engine = 'reasoner';
    state.model = 'local-reasoner';
    state.effort = 'n/a';
    state.note = COLD_NOTE;
    return new ReasonerAgent();
  }

  provider = buildProvider(choice, (u) => {
    state.tokensIn += u.in;
    state.tokensOut += u.out;
    state.cachedTokensRead += u.cacheRead;
  });

  state.engine = 'gemini';
  state.model = choice.model;
  state.effort = choice.effort;
  state.note = null;

  return new LlmAgent({
    provider,
    onFailure: (err) => {
      state.note = `Last Gemini call failed (${err instanceof Error ? err.message : String(err)}). ` +
        'That decision fell back to the local Reasoner; the console keeps running.';
    },
  });
}
