/**
 * Engine selection and the status readout the console header shows.
 *
 * The product is fully functional with no API key — `ReasonerAgent` is a real
 * expected-cost policy, not a stub. The key upgrades the judgment layer and
 * unlocks LLM-authored playbook proposals; it is never a prerequisite.
 */

import type { EngineStatus } from '../../shared/types';
import type { DispatchAgent } from '../contracts';
import { ClaudeAgent } from './claude';
import { ReasonerAgent } from './reasoner';

const state = {
  engine: 'reasoner' as 'claude' | 'reasoner',
  model: 'local-reasoner',
  effort: 'n/a',
  note: null as string | null,
  callsMade: 0,
  callsFailed: 0,
  tokensIn: 0,
  tokensOut: 0,
  cachedTokensRead: 0,
};

export function noteEngineCall(ok: boolean): void {
  state.callsMade += 1;
  if (!ok) state.callsFailed += 1;
}

export function engineStatus(): EngineStatus {
  return { ...state };
}

export function createAgent(): DispatchAgent {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim() ?? '';

  if (!apiKey) {
    state.engine = 'reasoner';
    state.model = 'local-reasoner';
    state.effort = 'n/a';
    state.note =
      'No ANTHROPIC_API_KEY set — running the deterministic Reasoner. Every feature works; ' +
      'decisions come from an explicit expected-cost policy instead of Claude. Add a key to .env to upgrade.';
    return new ReasonerAgent();
  }

  const model = process.env.SENTRY_MODEL?.trim() || 'claude-opus-4-8';
  const effort = process.env.SENTRY_EFFORT?.trim() || 'medium';

  state.engine = 'claude';
  state.model = model;
  state.effort = effort;
  state.note = null;

  return new ClaudeAgent({
    apiKey,
    model,
    effort,
    onUsage: (u) => {
      state.tokensIn += u.in;
      state.tokensOut += u.out;
      state.cachedTokensRead += u.cacheRead;
    },
    onFailure: (err) => {
      state.note = `Last Claude call failed (${err instanceof Error ? err.message : String(err)}). ` +
        'That decision fell back to the local Reasoner; the console keeps running.';
    },
  });
}
