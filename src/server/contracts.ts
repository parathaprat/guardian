/**
 * Server-side module contracts.
 *
 * These interfaces are the seams between the simulator, the memory layer, and
 * the agent. They exist so the agent can be run against *either* the live world
 * or a replay harness with no code change, which is what makes the A/B eval
 * honest.
 */

import type {
  AgentDecision, Briefing, CalibrationCell, CalibrationLookup, CorrelationFinding, EngineKind,
  EngineStatus, EventType, Guard, Incident, LearningPoint, Metrics, PlaybookProposal, PlaybookRule, Precedent,
  Responder, ResponderCandidate, ResponderModel, Robot, SecurityEvent, SeededEvent, SimControls,
  Severity, SimTime, Site, Skill, TraceStep, Zone, ResolutionOutcome, EventTruth,
} from '@shared/types';

// ─────────────────────────────────────────────────────────────────────────────
//  WORLD
// ─────────────────────────────────────────────────────────────────────────────

export interface WorldState {
  sites: Site[];
  zones: Zone[];
  guards: Guard[];
  robots: Robot[];
  zoneById: Map<string, Zone>;
  siteById: Map<string, Site>;
  responderById: Map<string, Responder>;
}

export interface Simulator {
  readonly world: WorldState;
  /** Current simulated time. */
  now(): SimTime;
  /** Advance the world by `ms` and return every event generated in that span. */
  tick(ms: number): SeededEvent[];
  /** Generate exactly `n` events without side effects on responder state (for evals). */
  generate(n: number): SeededEvent[];
  /** Estimated travel time from a responder's current zone to `zoneId`. */
  etaMs(responderId: string, zoneId: string): number;
  /**
   * Simulate offering a dispatch. Resolves the accept/decline roll and, if
   * accepted, the arrival time, using the responder's *hidden* truth.
   */
  offerDispatch(responderId: string, incidentId: string, zoneId: string): {
    accepted: boolean;
    etaMs: number;
    reason: string;
  };
  /** Mark a responder free again. */
  releaseResponder(responderId: string): void;
  /**
   * Given the decision the agent took, compute what actually happened.
   * This is the only place ground truth is consulted for scoring.
   */
  resolve(truth: EventTruth, decision: AgentDecision, accepted: boolean | null): {
    outcome: ResolutionOutcome;
    report: string;
  };
  /** The action a perfect operator with full ground truth would have taken. */
  oraclePolicy(seeded: SeededEvent): { action: AgentDecision['action']; priority: AgentDecision['priority'] };
  reseed(seed: number): void;
}

// ─────────────────────────────────────────────────────────────────────────────
//  MEMORY
// ─────────────────────────────────────────────────────────────────────────────

export interface CalibrationStore {
  lookup(siteId: string, zoneId: string, type: EventType, ts: SimTime): CalibrationLookup;
  /** Fold one resolved observation into every backoff level. */
  observe(siteId: string, zoneId: string, type: EventType, ts: SimTime, wasReal: boolean): void;
  cells(): CalibrationCell[];
  size(): number;
  reset(): void;
}

export interface ResponderStore {
  /** Rank candidates for an incident. `explore` enables Thompson sampling. */
  rank(
    candidates: Array<{ responder: Responder; etaMs: number; skillMatch: boolean }>,
    opts: { explore: boolean; requiredSkill: Skill | null },
  ): ResponderCandidate[];
  observeOffer(responderId: string, accepted: boolean): void;
  observeArrival(responderId: string, responseMs: number): void;
  observeResolution(responderId: string, resolvedCorrectly: boolean): void;
  models(): ResponderModel[];
  get(responderId: string): ResponderModel;
  reset(): void;
}

export interface PlaybookStore {
  /** Active rules whose trigger matches this event, most specific first. */
  match(event: SecurityEvent): PlaybookRule[];
  rules(): PlaybookRule[];
  proposals(): PlaybookProposal[];
  addProposal(p: PlaybookProposal): void;
  applyProposal(proposalId: string, acceptedRuleIds: string[], rejectedRuleIds: string[]): void;
  dismissProposal(proposalId: string): void;
  setRuleStatus(ruleId: string, status: PlaybookRule['status'], reason?: string): void;
  /** Record that a rule shaped a decision. */
  noteApplied(ruleIds: string[]): void;
  /** Record ground-truth outcome + operator verdict for rules that fired. */
  noteOutcome(ruleIds: string[], correct: boolean, overridden: boolean): void;
  /** Retire rules whose precision has decayed below threshold. Returns retired ids. */
  autoRetire(now: SimTime): string[];
  reset(): void;
}

export interface PrecedentStore {
  index(incident: Incident): void;
  /** Top-k most similar resolved incidents. */
  similar(event: SecurityEvent, k: number): Precedent[];
  size(): number;
  reset(): void;
}

export interface Memory {
  calibration: CalibrationStore;
  responders: ResponderStore;
  playbook: PlaybookStore;
  precedent: PrecedentStore;
  reset(): void;
  /** Everything learned, in a form that survives a process restart. */
  snapshot(): MemorySnapshot;
  /**
   * Replace the learned state wholesale.
   *
   * Precedent is deliberately absent: it is an index over resolved incidents
   * rather than a posterior, so it is rebuilt by replaying them rather than
   * stored twice and risking the two copies disagreeing.
   */
  restore(snap: MemorySnapshot): void;
}

export interface MemorySnapshot {
  calibration: CalibrationCell[];
  responders: ResponderModel[];
  playbook: PlaybookRule[];
  proposals: PlaybookProposal[];
}

// ─────────────────────────────────────────────────────────────────────────────
//  PERSISTENCE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Durability for a running console. Write-behind, not write-through: the tick
 * loop and eval harness stay synchronous and in-memory, and what gets persisted
 * is the *result*. A crash loses whatever happened since the last write, an
 * accepted trade for a simulated world.
 *
 * `InMemoryRepository` is the default, not a test double, it is what the eval
 * harness runs on.
 */
export interface Repository {
  readonly kind: 'memory' | 'postgres';
  init(): Promise<void>;
  close(): Promise<void>;

  /** The persisted state for a seed, or null when this world is new. */
  load(seed: number): Promise<PersistedRun | null>;

  saveEvent(runId: string, event: SecurityEvent): Promise<void>;
  saveIncident(runId: string, incident: Incident): Promise<void>;
  saveMemory(runId: string, snap: MemorySnapshot): Promise<void>;
  saveBriefing(runId: string, briefing: Briefing): Promise<void>;
  saveMetrics(runId: string, metrics: Metrics, curve: LearningPoint[]): Promise<void>;
  saveControls(runId: string, controls: SimControls, engine: EngineStatus): Promise<void>;

  /** Open or reopen the run for a seed, returning its id. */
  openRun(seed: number): Promise<string>;
  /** Drop everything belonging to a run, for reseed and memory reset. */
  clearRun(runId: string): Promise<void>;
  /**
   * Drop every incident in a run that never resolved, returning how many.
   * Called once at boot: an incident still in flight when the worker stopped
   * has no persisted ground truth, so it can never settle, and would otherwise
   * resurface on the board forever.
   */
  dropStrandedIncidents(runId: string): Promise<number>;

  /**
   * Reserve an ingest idempotency key. False means it was already used, which
   * is a duplicate delivery rather than an error: at-least-once is what every
   * real alarm source gives you.
   */
  claimIngestKey(key: string, eventId: string): Promise<boolean>;
}

export interface PersistedRun {
  runId: string;
  seed: number;
  controls: SimControls | null;
  engine: EngineStatus | null;
  events: SecurityEvent[];
  incidents: Incident[];
  /** Highest incident sequence in the whole run, not just the loaded window; the
   *  id factory must resume past this or a new incident silently upserts an old one. */
  maxIncidentSeq: number;
  memory: MemorySnapshot | null;
  briefings: Briefing[];
  metrics: Metrics | null;
  curve: LearningPoint[];
}

// ─────────────────────────────────────────────────────────────────────────────
//  AGENT
// ─────────────────────────────────────────────────────────────────────────────

/** Everything the agent is allowed to see. Ground truth is deliberately absent. */
export interface AgentContext {
  event: SecurityEvent;
  world: WorldState;
  memory: Memory;
  now: SimTime;
  /** Recent events for correlation, newest last. */
  recentEvents: SecurityEvent[];
  recentIncidents: Incident[];
  /** Responder availability + ETA, supplied by the simulator. */
  candidates(requiredSkill: Skill | null): Array<{ responder: Responder; etaMs: number; skillMatch: boolean }>;
  correlate(event: SecurityEvent, windowMs: number): CorrelationFinding;
  /** Toggle the memory channels, this is what the eval harness varies. */
  useMemory: boolean;
  /**
   * Semantic precedent, when a live console has an embedding service.
   *
   * Optional, and absent in the eval harness on purpose: a network call per
   * lookup would make a two second replay a twenty minute one, and a
   * nondeterministic one would make the arms incomparable. See
   * `learn/semantic.ts`.
   */
  semantic?: {
    similar(event: SecurityEvent, k: number): Promise<Array<{ incidentId: string; similarity: number }>>;
  };
  /** Called as each trace step is produced, so the UI can stream reasoning live. */
  onTraceStep?: (step: TraceStep) => void;
}

export interface AgentResult {
  decision: AgentDecision;
  trace: TraceStep[];
  latencyMs: number;
  /**
   * The engine that actually produced this decision, which is not always the
   * engine that was asked. A hosted call that is rate-limited or that fails
   * degrades to the local Reasoner, and the incident must say so rather than
   * wear a vendor badge it did not earn.
   */
  engine: EngineKind;
}

export interface DispatchAgent {
  /** The engine this agent was configured with. */
  readonly engine: EngineKind;
  decide(ctx: AgentContext): Promise<AgentResult>;
}

// ─────────────────────────────────────────────────────────────────────────────
//  METRICS
// ─────────────────────────────────────────────────────────────────────────────

export interface MetricsInput {
  incidents: Incident[];
  /** The oracle action per event id, used for the agreement metric in evals. */
  oracle?: Map<string, AgentDecision['action']>;
}

export type ComputeMetrics = (input: MetricsInput) => Metrics;
export type ComputeLearningCurve = (incidents: Incident[], window: number) => LearningPoint[];
