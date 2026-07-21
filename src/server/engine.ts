/**
 * SENTRY — the live operations engine.
 *
 * Owns the running world, the memory, the agent, and the incident book, and
 * broadcasts everything as a typed `ServerEvent` stream.
 *
 * The one rule that shapes this file: the tick loop must never block on a model
 * call. Events reach the feed the instant they are generated, incidents enter
 * `triaging`, and decisions run behind a small bounded queue so an event burst
 * cannot fan out into dozens of concurrent API calls.
 */

import type {
  AgentActionKind, CorrelationFinding, EventType, Incident, LearningPoint, Metrics,
  OperatorFeedback, PlaybookProposal, PlaybookRule, Responder, RuleStatus, SecurityEvent,
  SeededEvent, ServerEvent, SimControls, SimTime, Skill, Snapshot, TraceStep,
} from '../shared/types';
import { EMPTY_METRICS } from '../shared/types';
import type { AgentContext, DispatchAgent, Memory } from './contracts';
import { WorldSimulator } from './world/simulator';
import { createMemory } from './learn/index';
import { createAgent, engineStatus, noteEngineCall } from './agent/index';
import { requiredSkillFor } from './agent/tools';
import { runReflection } from './agent/reflect';
import { computeLearningCurve, computeMetrics } from './eval/metrics';
import { runEval } from './eval/harness';
import { logIncident } from './util/eventlog';
import { makeIdFactory } from './util/ids';
import type { EvalRun } from '../shared/types';

const TICK_MS = 250;
const MAX_IN_FLIGHT = 3;
const FEED_CAP = 200;
const INCIDENT_CAP = 400;
/** Resolved incidents between automatic reflection passes. */
const REFLECT_EVERY = 25;
const RETIRE_EVERY = 20;

interface PendingResolution {
  at: SimTime;
  incidentId: string;
}

export class OpsEngine {
  private sim: WorldSimulator;
  private memory: Memory;
  private agent: DispatchAgent;

  private incidents = new Map<string, Incident>();
  private order: string[] = [];
  private feed: SecurityEvent[] = [];
  private truthById = new Map<string, SeededEvent['truth']>();

  private subscribers = new Set<(e: ServerEvent) => void>();
  private timer: NodeJS.Timeout | null = null;
  /**
   * 64× puts roughly one sim-hour into a real minute, which lands the event rate
   * at ~5–15/min — dense enough that the console feels live, slow enough that an
   * operator can actually read a decision before the next one arrives.
   */
  private speed = 64;
  private seed: number;

  private queue: SeededEvent[] = [];
  private inFlight = 0;
  private pending: PendingResolution[] = [];

  private metrics: Metrics = EMPTY_METRICS;
  private curve: LearningPoint[] = [];
  private lastEval: EvalRun | null = null;
  private proposals: PlaybookProposal[] = [];

  private nextIncidentId = makeIdFactory('INC');
  private resolvedSinceReflect = 0;
  private resolvedSinceRetire = 0;
  private reflecting = false;
  private eventsGenerated = 0;

  constructor(seed: number) {
    this.seed = seed;
    this.sim = new WorldSimulator(seed);
    this.memory = createMemory(this.sim.world, this.sim.now());
    this.agent = createAgent();
  }

  // ── subscription ──────────────────────────────────────────────────────────

  subscribe(fn: (e: ServerEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  private emit(e: ServerEvent): void {
    for (const fn of this.subscribers) {
      try { fn(e); } catch { /* a dead client must not break the loop */ }
    }
  }

  // ── transport ─────────────────────────────────────────────────────────────

  private controls(): SimControls {
    return {
      running: this.timer !== null,
      speed: this.speed,
      seed: this.seed,
      simTime: this.sim.now(),
      eventsGenerated: this.eventsGenerated,
    };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.emit({ type: 'controls', data: this.controls() });
  }

  pause(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.emit({ type: 'controls', data: this.controls() });
  }

  setSpeed(n: number): void {
    this.speed = Math.max(1, Math.min(256, Math.floor(n)));
    this.emit({ type: 'controls', data: this.controls() });
  }

  reseed(seed: number): void {
    const wasRunning = this.timer !== null;
    this.pause();
    this.seed = seed;
    this.sim = new WorldSimulator(seed);
    this.memory = createMemory(this.sim.world, this.sim.now());
    this.incidents.clear();
    this.order = [];
    this.feed = [];
    this.truthById.clear();
    this.queue = [];
    this.pending = [];
    this.proposals = [];
    this.metrics = EMPTY_METRICS;
    this.curve = [];
    this.eventsGenerated = 0;
    this.nextIncidentId = makeIdFactory('INC');
    this.emit({ type: 'snapshot', data: this.snapshot() });
    if (wasRunning) this.start();
  }

  resetMemory(): void {
    this.memory.reset();
    this.emit({ type: 'toast', data: { level: 'info', message: 'Memory wiped — the agent is learning from zero.' } });
    this.emit({ type: 'snapshot', data: this.snapshot() });
  }

  // ── the loop ──────────────────────────────────────────────────────────────

  private tick(): void {
    const seeded = this.sim.tick(TICK_MS * this.speed);
    for (const s of seeded) this.ingest(s);
    this.drainQueue();
    this.settleDue();
    if (seeded.length > 0) this.emit({ type: 'controls', data: this.controls() });
  }

  private ingest(seeded: SeededEvent): void {
    this.eventsGenerated += 1;
    // Truth is held here and never travels with the event.
    this.truthById.set(seeded.event.id, seeded.truth);

    this.feed.unshift(seeded.event);
    if (this.feed.length > FEED_CAP) this.feed.pop();
    this.emit({ type: 'event', data: seeded.event });

    const incident: Incident = {
      id: this.nextIncidentId(),
      event: seeded.event,
      createdAt: seeded.event.ts,
      status: 'triaging',
      decision: null,
      trace: [],
      decisionLatencyMs: null,
      dispatch: null,
      feedback: null,
      resolvedAt: null,
      outcome: null,
      revealedTruth: null,
      engine: this.agent.engine,
      linkedIncidentIds: [],
    };
    this.put(incident);
    this.emit({ type: 'incident', data: incident });
    this.queue.push(seeded);
  }

  private put(i: Incident): void {
    if (!this.incidents.has(i.id)) {
      this.order.unshift(i.id);
      if (this.order.length > INCIDENT_CAP) {
        const drop = this.order.pop();
        if (drop) this.incidents.delete(drop);
      }
    }
    this.incidents.set(i.id, i);
  }

  private drainQueue(): void {
    while (this.inFlight < MAX_IN_FLIGHT && this.queue.length > 0) {
      const seeded = this.queue.shift()!;
      this.inFlight += 1;
      void this.decide(seeded).finally(() => {
        this.inFlight -= 1;
      });
    }
  }

  // ── agent context ─────────────────────────────────────────────────────────

  private correlate(event: SecurityEvent, windowMs: number): CorrelationFinding {
    const since = event.ts - windowMs;
    const zone = this.sim.world.zoneById.get(event.zoneId);
    const nearby = new Set<string>([event.zoneId, ...(zone?.adjacent ?? [])]);

    const related = this.feed.filter(
      (e) => e.id !== event.id && e.ts >= since && e.ts <= event.ts && nearby.has(e.zoneId),
    );
    const zones = new Set(related.map((e) => e.zoneId));
    const relatedIncidents = this.order
      .map((id) => this.incidents.get(id)!)
      .filter((i) => related.some((e) => e.id === i.event.id))
      .map((i) => i.id);

    // Three or more signals walking adjacent zones inside the window is the
    // signature of a coordinated entry. Individually each looks ambiguous.
    const patternDetected = related.length >= 2 && zones.size >= 2;

    return {
      patternDetected,
      label: patternDetected
        ? `${related.length + 1} signals across ${zones.size + 1} adjacent zones in ${Math.round(windowMs / 60000)} minutes`
        : related.length > 0
          ? `${related.length} nearby signal${related.length === 1 ? '' : 's'} in window, but not a movement pattern`
          : 'No related activity in the window',
      relatedEventIds: related.map((e) => e.id),
      relatedIncidentIds: relatedIncidents,
      severityUplift: patternDetected ? (zones.size >= 3 ? 2 : 1) : 0,
      detail: patternDetected
        ? 'Adjacent-zone sequence within a short window. Treat as one moving incident, not several independent alarms.'
        : 'Nothing in the surrounding zones suggests this is part of a larger movement.',
    };
  }

  private candidates(skill: Skill | null): Array<{ responder: Responder; etaMs: number; skillMatch: boolean }> {
    const out: Array<{ responder: Responder; etaMs: number; skillMatch: boolean }> = [];
    for (const r of this.sim.world.responderById.values()) {
      out.push({
        responder: r,
        etaMs: 0,
        skillMatch: r.kind === 'guard' ? (skill === null || r.skills.includes(skill)) : skill === 'technical',
      });
    }
    return out;
  }

  private buildContext(event: SecurityEvent, incidentId: string): AgentContext {
    return {
      event,
      world: this.sim.world,
      memory: this.memory,
      now: this.sim.now(),
      recentEvents: this.sim.recentEvents(60),
      recentIncidents: this.order.slice(0, 40).map((id) => this.incidents.get(id)!).filter(Boolean),
      candidates: (skill) => this.candidates(skill).map((c) => ({
        ...c, etaMs: this.sim.etaMs(c.responder.id, event.zoneId),
      })),
      correlate: (e, w) => this.correlate(e, w),
      useMemory: true,
      onTraceStep: (step: TraceStep) => {
        const inc = this.incidents.get(incidentId);
        if (inc) inc.trace.push(step);
        this.emit({ type: 'trace_step', data: { incidentId, step } });
      },
    };
  }

  // ── decision + resolution ─────────────────────────────────────────────────

  private async decide(seeded: SeededEvent): Promise<void> {
    const incident = this.byEvent(seeded.event.id);
    if (!incident) return;

    try {
      // The trace is streamed via onTraceStep, so start it empty to avoid duplicates.
      incident.trace = [];
      const ctx = this.buildContext(seeded.event, incident.id);
      const { decision, latencyMs } = await this.agent.decide(ctx);
      noteEngineCall(true);

      incident.decision = decision;
      incident.decisionLatencyMs = latencyMs;
      incident.linkedIncidentIds = decision.evidence
        .filter((e) => e.kind === 'correlation')
        .flatMap(() => this.correlate(seeded.event, 15 * 60_000).relatedIncidentIds);
      incident.status = 'open';

      this.applyDecision(incident, decision.action);
    } catch (err) {
      noteEngineCall(false);
      incident.status = 'open';
      incident.trace.push({
        id: `ERR-${incident.id}`, index: incident.trace.length, kind: 'error',
        durationMs: 0, label: 'Decision failed',
        detail: err instanceof Error ? err.message : String(err),
      });
      // An undecided incident is still a real incident — hold it for a human.
      this.schedule(incident.id, 5 * 60_000);
    }

    this.emit({ type: 'incident', data: incident });
  }

  private applyDecision(incident: Incident, action: AgentActionKind): void {
    const decision = incident.decision!;

    if (action === 'dispatch' || action === 'escalate') {
      const responderId = decision.responderId
        ?? this.pickFallbackResponder(incident.event.zoneId, requiredSkillFor(incident.event.type));
      if (responderId) {
        const offer = this.sim.offerDispatch(responderId, incident.id, incident.event.zoneId);
        const responder = this.sim.world.responderById.get(responderId);
        incident.dispatch = {
          responderId,
          responderName: responder?.name ?? responderId,
          dispatchedAt: this.sim.now(),
          accepted: offer.accepted,
          acknowledgedAt: offer.accepted ? this.sim.now() : null,
          arrivedAt: null,
          responseMs: null,
          report: offer.reason,
        };
        this.memory.responders.observeOffer(responderId, offer.accepted);
        incident.status = offer.accepted ? 'dispatched' : 'open';
        this.schedule(incident.id, offer.accepted ? offer.etaMs : 30_000);
      } else {
        incident.status = 'escalated';
        this.schedule(incident.id, 60_000);
      }
      return;
    }

    if (action === 'monitor') {
      incident.status = 'open';
      this.schedule(incident.id, decision.recheckAfterMs ?? 8 * 60_000);
      return;
    }

    incident.status = 'suppressed';
    this.schedule(incident.id, 1_000);
  }

  private pickFallbackResponder(zoneId: string, skill: Skill | null): string | null {
    const ranked = this.memory.responders.rank(
      this.candidates(skill).map((c) => ({ ...c, etaMs: this.sim.etaMs(c.responder.id, zoneId) })),
      { explore: false, requiredSkill: skill },
    );
    return ranked[0]?.responderId ?? null;
  }

  private schedule(incidentId: string, afterMs: number): void {
    this.pending.push({ at: this.sim.now() + Math.max(1000, afterMs), incidentId });
  }

  private settleDue(): void {
    const now = this.sim.now();
    const due = this.pending.filter((p) => p.at <= now);
    if (due.length === 0) return;
    this.pending = this.pending.filter((p) => p.at > now);
    for (const p of due) this.settle(p.incidentId);
  }

  private settle(incidentId: string): void {
    const incident = this.incidents.get(incidentId);
    if (!incident || incident.outcome !== null || !incident.decision) return;

    const truth = this.truthById.get(incident.event.id);
    if (!truth) return;

    const accepted = incident.dispatch ? incident.dispatch.accepted : null;
    const { outcome, report } = this.sim.resolve(truth, incident.decision, accepted);

    incident.outcome = outcome;
    incident.resolvedAt = this.sim.now();
    incident.revealedTruth = truth;
    incident.status = outcome === 'false_alarm' && incident.decision.action === 'suppress'
      ? 'suppressed'
      : 'resolved';

    if (incident.dispatch && incident.dispatch.accepted) {
      const responseMs = this.sim.now() - incident.dispatch.dispatchedAt;
      incident.dispatch.arrivedAt = this.sim.now();
      incident.dispatch.responseMs = responseMs;
      incident.dispatch.report = report;
      this.memory.responders.observeArrival(incident.dispatch.responderId, responseMs);
      this.memory.responders.observeResolution(
        incident.dispatch.responderId, outcome === 'true_positive',
      );
      this.sim.releaseResponder(incident.dispatch.responderId);
    } else if (incident.dispatch) {
      incident.dispatch.report = report;
    }

    // Fold the revealed outcome into every memory channel.
    this.memory.calibration.observe(
      incident.event.siteId, incident.event.zoneId, incident.event.type,
      incident.event.ts, truth.isReal,
    );
    this.memory.precedent.index(incident);

    const firedRules = incident.decision.evidence
      .filter((e) => e.kind === 'playbook')
      .map((e) => e.refId);
    if (firedRules.length > 0) {
      const correct = outcome === 'true_positive' || (outcome === 'false_alarm' && incident.decision.action === 'suppress');
      this.memory.playbook.noteOutcome(firedRules, correct, incident.feedback?.verdict === 'override');
    }

    void logIncident(incident);
    this.emit({ type: 'incident', data: incident });

    this.resolvedSinceReflect += 1;
    this.resolvedSinceRetire += 1;
    this.afterResolution();
  }

  private afterResolution(): void {
    this.recompute();

    if (this.resolvedSinceRetire >= RETIRE_EVERY) {
      this.resolvedSinceRetire = 0;
      const retired = this.memory.playbook.autoRetire(this.sim.now());
      if (retired.length > 0) {
        this.emit({
          type: 'toast',
          data: { level: 'warn', message: `${retired.length} playbook rule(s) auto-retired for low precision.` },
        });
        this.emitPlaybook();
      }
    }

    if (this.resolvedSinceReflect >= REFLECT_EVERY && !this.reflecting) {
      this.resolvedSinceReflect = 0;
      void this.reflectNow().catch(() => undefined);
    }
  }

  private recompute(): void {
    const all = this.allIncidents();
    this.metrics = computeMetrics({ incidents: all });
    this.curve = computeLearningCurve(all, 25);
    this.emit({ type: 'metrics', data: { metrics: this.metrics, learningCurve: this.curve } });
    this.emit({
      type: 'memory',
      data: {
        calibration: this.memory.calibration.cells(),
        responderModels: this.memory.responders.models(),
      },
    });
  }

  private emitPlaybook(): void {
    this.emit({
      type: 'playbook',
      data: { playbook: this.memory.playbook.rules(), proposals: this.allProposals() },
    });
  }

  // ── operator feedback — the highest-value training signal ─────────────────

  feedback(incidentId: string, fb: OperatorFeedback): void {
    const incident = this.incidents.get(incidentId);
    if (!incident) throw new Error(`Unknown incident ${incidentId}`);

    incident.feedback = { ...fb, ts: this.sim.now() };

    const firedRules = incident.decision?.evidence.filter((e) => e.kind === 'playbook').map((e) => e.refId) ?? [];

    if (fb.verdict === 'override' && fb.correctedAction) {
      // An override is not a note — the operator's call is executed for real.
      if (incident.decision) {
        incident.decision = {
          ...incident.decision,
          action: fb.correctedAction,
          priority: fb.correctedPriority ?? incident.decision.priority,
          responderId: fb.correctedResponderId ?? incident.decision.responderId,
        };
      }
      if (incident.outcome === null) {
        this.pending = this.pending.filter((p) => p.incidentId !== incidentId);
        this.applyDecision(incident, fb.correctedAction);
      }
      if (firedRules.length > 0) this.memory.playbook.noteOutcome(firedRules, false, true);
    } else if (firedRules.length > 0) {
      this.memory.playbook.noteApplied(firedRules);
    }

    this.emit({ type: 'incident', data: incident });
    this.recompute();
    this.emitPlaybook();
  }

  // ── playbook ──────────────────────────────────────────────────────────────

  async reflectNow(): Promise<PlaybookProposal> {
    if (this.reflecting) throw new Error('A reflection pass is already running.');
    this.reflecting = true;
    try {
      const proposal = await runReflection({
        incidents: this.allIncidents().filter((i) => i.outcome !== null),
        memory: this.memory,
        world: this.sim.world,
        now: this.sim.now(),
        agentEngine: this.agent.engine,
      });
      this.memory.playbook.addProposal(proposal);
      this.proposals = this.allProposals();
      this.emitPlaybook();
      this.emit({
        type: 'toast',
        data: {
          level: 'info',
          message: proposal.rules.length + proposal.retire.length === 0
            ? 'Reflection found no change worth proposing yet.'
            : `Reflection drafted ${proposal.rules.length} rule change(s) and ${proposal.retire.length} retirement(s) — awaiting approval.`,
        },
      });
      return proposal;
    } finally {
      this.reflecting = false;
    }
  }

  applyProposal(proposalId: string, accept: string[], reject: string[]): void {
    this.memory.playbook.applyProposal(proposalId, accept, reject);
    this.emitPlaybook();
  }

  dismissProposal(proposalId: string): void {
    this.memory.playbook.dismissProposal(proposalId);
    this.emitPlaybook();
  }

  setRuleStatus(ruleId: string, status: RuleStatus): void {
    this.memory.playbook.setRuleStatus(ruleId, status, 'Operator action');
    this.emitPlaybook();
  }

  // ── injection + evals ─────────────────────────────────────────────────────

  injectEvent(type: EventType, zoneId: string): void {
    const seeded = this.sim.injectAt(type, zoneId);
    this.ingest(seeded);
    this.drainQueue();
  }

  async runEvalNow(opts: { eventCount: number; useClaude: boolean }): Promise<EvalRun> {
    const run = await runEval({
      seed: this.seed,
      eventCount: opts.eventCount,
      useClaude: opts.useClaude,
      liveMemory: this.memory,
    });
    this.lastEval = run;
    this.emit({ type: 'eval', data: run });
    return run;
  }

  // ── snapshot ──────────────────────────────────────────────────────────────

  private allIncidents(): Incident[] {
    return this.order.map((id) => this.incidents.get(id)!).filter(Boolean);
  }

  private allProposals(): PlaybookProposal[] {
    return this.memory.playbook.proposals();
  }

  private byEvent(eventId: string): Incident | undefined {
    for (const id of this.order) {
      const i = this.incidents.get(id);
      if (i && i.event.id === eventId) return i;
    }
    return undefined;
  }

  snapshot(): Snapshot {
    return {
      controls: this.controls(),
      engine: engineStatus(),
      world: {
        sites: this.sim.world.sites,
        zones: this.sim.world.zones,
        // Strip hidden reliability before it ever reaches the wire.
        guards: this.sim.world.guards.map(({ truth, ...g }) => g),
        robots: this.sim.world.robots.map(({ truth, ...r }) => r),
      },
      incidents: this.allIncidents(),
      feed: this.feed,
      metrics: this.metrics,
      learningCurve: this.curve,
      calibration: this.memory.calibration.cells(),
      responderModels: this.memory.responders.models(),
      playbook: this.memory.playbook.rules(),
      proposals: this.allProposals(),
      lastEval: this.lastEval,
    };
  }
}
