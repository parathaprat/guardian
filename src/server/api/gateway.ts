/**
 * One interface, two topologies: the HTTP layer doesn't know whether the engine
 * is local (`npm run dev`) or a worker on the other side of Redis (deployed
 * stack). See DECISIONS.md Decision 8.
 */

import type {
  AskAnswer, Briefing, EvalRun, EventType, Experiment, IntakeParse, OperatorFeedback,
  PlaybookProposal, RuleStatus, SecurityEvent, ServerEvent, Snapshot,
} from '../../shared/types';
import type { OpsEngine } from '../engine';
import type { Bus } from '../bus';

export interface IntakeCommit {
  type: EventType;
  zoneId: string;
  description: string;
  sourceKind: SecurityEvent['sourceKind'];
}

export interface EngineGateway {
  snapshot(): Promise<Snapshot>;
  subscribe(fn: (e: ServerEvent) => void): () => void;

  start(): Promise<void>;
  pause(): Promise<void>;
  setSpeed(speed: number): Promise<void>;
  reseed(seed: number): Promise<void>;
  injectEvent(type: EventType, zoneId: string): Promise<void>;

  feedback(incidentId: string, fb: OperatorFeedback): Promise<void>;

  reflectNow(): Promise<PlaybookProposal>;
  applyProposal(id: string, accept: string[], reject: string[]): Promise<void>;
  dismissProposal(id: string): Promise<void>;
  setRuleStatus(ruleId: string, status: RuleStatus): Promise<void>;

  runEvalNow(opts: { eventCount: number; useLlm: boolean }): Promise<EvalRun>;
  runExperimentNow(opts: { eventCount: number; seedCount: number; useLlm: boolean }): Promise<Experiment>;
  resetMemory(): Promise<void>;

  parseIntake(transcript: string): Promise<IntakeParse>;
  intakeDispatch(input: IntakeCommit): Promise<{ incidentId: string }>;
  briefNow(): Promise<Briefing>;
  ask(question: string): Promise<AskAnswer>;
}

// ── local: the engine is right here ────────────────────────────────────────

export class LocalGateway implements EngineGateway {
  constructor(private engine: OpsEngine) {}

  async snapshot() { return this.engine.snapshot(); }
  subscribe(fn: (e: ServerEvent) => void) { return this.engine.subscribe(fn); }

  async start() { this.engine.start(); }
  async pause() { this.engine.pause(); }
  async setSpeed(speed: number) { this.engine.setSpeed(speed); }
  async reseed(seed: number) { this.engine.reseed(seed); }
  async injectEvent(type: EventType, zoneId: string) { this.engine.injectEvent(type, zoneId); }

  async feedback(incidentId: string, fb: OperatorFeedback) { this.engine.feedback(incidentId, fb); }

  async reflectNow() { return this.engine.reflectNow(); }
  async applyProposal(id: string, accept: string[], reject: string[]) {
    this.engine.applyProposal(id, accept, reject);
  }
  async dismissProposal(id: string) { this.engine.dismissProposal(id); }
  async setRuleStatus(ruleId: string, status: RuleStatus) { this.engine.setRuleStatus(ruleId, status); }

  async runEvalNow(opts: { eventCount: number; useLlm: boolean }) { return this.engine.runEvalNow(opts); }
  async runExperimentNow(opts: { eventCount: number; seedCount: number; useLlm: boolean }) {
    return this.engine.runExperimentNow(opts);
  }
  async resetMemory() { this.engine.resetMemory(); }

  async parseIntake(transcript: string) { return this.engine.parseIntake(transcript); }
  async intakeDispatch(input: IntakeCommit) {
    const incident = this.engine.intakeDispatch(
      input.type, input.zoneId, input.description, input.sourceKind,
    );
    return { incidentId: incident.id };
  }
  async briefNow() { return this.engine.briefNow(); }
  async ask(question: string) { return this.engine.ask(question); }
}

// ── remote: the engine is a worker on the bus ──────────────────────────────

/** `snapshot` reads the last persisted state instead of going over the bus, so the console still renders if the worker is restarting or wedged. */
export class RemoteGateway implements EngineGateway {
  constructor(
    private bus: Bus,
    private readSnapshot: () => Promise<Snapshot>,
  ) {}

  async snapshot() { return this.readSnapshot(); }

  subscribe(fn: (e: ServerEvent) => void) {
    return this.bus.onLocalEvent(fn);
  }

  async start() { await this.bus.call('start'); }
  async pause() { await this.bus.call('pause'); }
  async setSpeed(speed: number) { await this.bus.call('setSpeed', { speed }); }
  async reseed(seed: number) { await this.bus.call('reseed', { seed }); }
  async injectEvent(type: EventType, zoneId: string) {
    await this.bus.call('injectEvent', { type, zoneId });
  }

  async feedback(incidentId: string, fb: OperatorFeedback) {
    await this.bus.call('feedback', { incidentId, fb });
  }

  async reflectNow() { return this.bus.call<PlaybookProposal>('reflectNow'); }
  async applyProposal(id: string, accept: string[], reject: string[]) {
    await this.bus.call('applyProposal', { id, accept, reject });
  }
  async dismissProposal(id: string) { await this.bus.call('dismissProposal', { id }); }
  async setRuleStatus(ruleId: string, status: RuleStatus) {
    await this.bus.call('setRuleStatus', { ruleId, status });
  }

  async runEvalNow(opts: { eventCount: number; useLlm: boolean }) {
    return this.bus.call<EvalRun>('runEvalNow', opts);
  }
  async runExperimentNow(opts: { eventCount: number; seedCount: number; useLlm: boolean }) {
    return this.bus.call<Experiment>('runExperimentNow', opts);
  }
  async resetMemory() { await this.bus.call('resetMemory'); }

  async parseIntake(transcript: string) { return this.bus.call<IntakeParse>('parseIntake', { transcript }); }
  async intakeDispatch(input: IntakeCommit) {
    return this.bus.call<{ incidentId: string }>('intakeDispatch', input);
  }
  async briefNow() { return this.bus.call<Briefing>('briefNow'); }
  async ask(question: string) { return this.bus.call<AskAnswer>('ask', { question }); }
}

// ── worker side: the other end of RemoteGateway ────────────────────────────

type Params = Record<string, unknown>;

/** Mirrors `RemoteGateway` method for method; if the two drift, the failure is a clear "unknown command" rather than something subtle. */
export function createCommandHandler(engine: OpsEngine) {
  const local = new LocalGateway(engine);

  return async (method: string, raw: unknown): Promise<unknown> => {
    const p = (raw ?? {}) as Params;

    switch (method) {
      case 'start': return local.start();
      case 'pause': return local.pause();
      case 'setSpeed': return local.setSpeed(Number(p.speed));
      case 'reseed': return local.reseed(Number(p.seed));
      case 'injectEvent': return local.injectEvent(p.type as EventType, String(p.zoneId));

      case 'feedback': return local.feedback(String(p.incidentId), p.fb as OperatorFeedback);

      case 'reflectNow': return local.reflectNow();
      case 'applyProposal':
        return local.applyProposal(String(p.id), p.accept as string[], p.reject as string[]);
      case 'dismissProposal': return local.dismissProposal(String(p.id));
      case 'setRuleStatus': return local.setRuleStatus(String(p.ruleId), p.status as RuleStatus);

      case 'runEvalNow':
        return local.runEvalNow(p as unknown as { eventCount: number; useLlm: boolean });
      case 'runExperimentNow':
        return local.runExperimentNow(
          p as unknown as { eventCount: number; seedCount: number; useLlm: boolean },
        );
      case 'resetMemory': return local.resetMemory();

      case 'parseIntake': return local.parseIntake(String(p.transcript));
      case 'intakeDispatch': return local.intakeDispatch(p as unknown as IntakeCommit);
      case 'briefNow': return local.briefNow();
      case 'ask': return local.ask(String(p.question));

      default:
        throw new Error(`unknown command: ${method}`);
    }
  };
}
