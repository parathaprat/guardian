/**
 * The no-database repository. Not a test double: this is what `npm run verify`
 * uses, so evals stay hermetic and fast. See DECISIONS.md Decision 8.
 */

import type {
  Briefing, EngineStatus, LearningPoint, Metrics, SecurityEvent, SimControls,
} from '../../shared/types';
import type { Incident } from '../../shared/types';
import type { MemorySnapshot, PersistedRun, Repository } from '../contracts';

export class InMemoryRepository implements Repository {
  readonly kind = 'memory' as const;

  /** Ingest keys are still tracked, so idempotency behaves the same either way. */
  private ingestKeys = new Map<string, string>();

  async init(): Promise<void> {}
  async close(): Promise<void> {}

  async load(): Promise<PersistedRun | null> {
    return null;
  }

  async openRun(seed: number): Promise<string> {
    return `mem-${seed}`;
  }

  async clearRun(): Promise<void> {
    this.ingestKeys.clear();
  }

  async dropStrandedIncidents(): Promise<number> { return 0; }

  async saveEvent(_runId: string, _event: SecurityEvent): Promise<void> {}
  async saveIncident(_runId: string, _incident: Incident): Promise<void> {}
  async saveMemory(_runId: string, _snap: MemorySnapshot): Promise<void> {}
  async saveBriefing(_runId: string, _briefing: Briefing): Promise<void> {}
  async saveMetrics(_runId: string, _m: Metrics, _c: LearningPoint[]): Promise<void> {}
  async saveControls(_runId: string, _c: SimControls, _e: EngineStatus): Promise<void> {}

  async claimIngestKey(key: string, eventId: string): Promise<boolean> {
    if (this.ingestKeys.has(key)) return false;
    this.ingestKeys.set(key, eventId);
    return true;
  }
}
