/**
 * SENTRY, A/B eval harness.
 *
 * This file is the evidence behind the product claim. It is written to be
 * attacked: an event stream is generated exactly once and replayed verbatim by
 * every arm, each arm gets its own freshly-seeded simulator so no arm inherits
 * another's responder state, and the only thing that varies between arms is the
 * memory available to the judgment layer.
 *
 * Learning is *online*: each event is decided first, then resolved, and only
 * then folded back into that arm's memory. No arm ever sees an outcome before
 * it has committed to a decision, and the learned arm's pre-training stream is
 * strictly disjoint from the scored stream.
 */

import type {
  AgentDecision, CorrelationFinding, DispatchRecord, EngineKind, EvalArm, EvalArmId,
  EvalRun, EventType, EvidenceRef, Incident, IncidentStatus, ResolutionOutcome,
  Responder, ResponderStatus, SecurityEvent, SeededEvent, Severity, SimTime, Skill,
  TraceStep,
} from '../../shared/types';
import { ENGINE_LABELS, priorityFromSeverity } from '../../shared/types';
import type { AgentContext, DispatchAgent, Memory, Simulator, WorldState } from '../contracts';
import { WorldSimulator } from '../world/simulator';
import { createMemory } from '../learn/index';
import { ReasonerAgent } from '../agent/reasoner';
import { LlmAgent } from '../agent/loop';
import { buildProvider, resolveProviderChoice } from '../agent/index';
import { runReflection } from '../agent/reflect';
import { makeIdFactory } from '../util/ids';
import { actionWasCorrect, computeMetrics, metricDelta } from './metrics';

// ─────────────────────────────────────────────────────────────────────────────
//  TUNABLES
// ─────────────────────────────────────────────────────────────────────────────

/** Hosted-model arms cost money and wall-clock, so the harness refuses to run long ones. */
const LLM_EVENT_CAP = 120;
const REASONER_EVENT_CAP = 5_000;

/** Warm-up length for the learned arm when no live memory is supplied. */
const WARMUP_MIN = 60;
const WARMUP_MAX = 400;

/** Rows in the drill-down table, strided so the sample spans the whole run. */
const SAMPLE_CAP = 60;

/** How much history the correlation window and precedent lookups can see. */
const RECENT_LIMIT = 48;

/** Candidate list handed to the responder bandit. Enough to choose from, small enough to prompt. */
const MAX_CANDIDATES = 10;

const AUTORETIRE_EVERY = 25;
const YIELD_EVERY = 12;
const MONITOR_RECHECK_MS = 10 * 60_000;

const evalRunId = makeIdFactory('EVR');

// ─────────────────────────────────────────────────────────────────────────────
//  THE STATIC BASELINE  (arm 1: no memory, ever)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The rule table a real ops centre ships on day one: a fixed severity per event
 * type, a fixed action per severity band, nearest available body. It has no
 * idea that dock camera 4 cries wolf every night at 02:00, and it never will,
 * which is precisely the gap the learned arm has to prove it closes.
 */
const STATIC_SEVERITY: Record<EventType, Severity> = {
  motion_detected: 1,
  door_forced: 4,
  door_propped: 2,
  glass_break: 4,
  tailgating: 3,
  loitering: 2,
  person_down: 5,
  fire_alarm: 5,
  vehicle_unauthorized: 3,
  perimeter_breach: 4,
  robot_obstruction: 1,
  camera_offline: 2,
  panic_button: 5,
  badge_anomaly: 3,
  package_theft: 2,
  noise_complaint: 1,
};

const STATIC_SKILL: Partial<Record<EventType, Skill>> = {
  person_down: 'medical',
  fire_alarm: 'fire',
  panic_button: 'armed',
  door_forced: 'armed',
  glass_break: 'armed',
  perimeter_breach: 'armed',
  badge_anomaly: 'access_control',
  tailgating: 'access_control',
  door_propped: 'access_control',
  camera_offline: 'technical',
  robot_obstruction: 'technical',
  noise_complaint: 'de_escalation',
  loitering: 'de_escalation',
};

function staticDecide(event: SecurityEvent, world: WorldState, sim: Simulator): AgentDecision {
  const severity = STATIC_SEVERITY[event.type];
  const skill = STATIC_SKILL[event.type] ?? null;
  const priority = priorityFromSeverity(severity);

  const evidence: EvidenceRef[] = [{
    kind: 'policy',
    refId: `static:${event.type}`,
    label: `Static table: ${event.type} → severity ${severity}`,
    weight: severity >= 3 ? 0.6 : -0.4,
    detail: 'Fixed severity map, applied with no site, zone, hour or history context.',
  }];

  if (severity <= 1) {
    return {
      action: 'suppress', priority, severity,
      confidence: 0.5,
      falseAlarmProbability: clamp01(1 - event.sensorConfidence),
      responderId: null,
      instruction: 'Log only. No response under standing policy.',
      rationale: `Static policy suppresses ${event.type} regardless of location or time of day.`,
      evidence,
    };
  }

  if (severity === 2) {
    return {
      action: 'monitor', priority, severity,
      confidence: 0.5,
      falseAlarmProbability: clamp01(1 - event.sensorConfidence),
      responderId: null,
      instruction: 'Hold on camera and re-check.',
      rationale: `Static policy monitors severity-2 events; no zone- or hour-specific prior is consulted.`,
      evidence,
      recheckAfterMs: MONITOR_RECHECK_MS,
    };
  }

  const responder = staticPick(world, sim, event, skill);
  if (!responder) {
    return {
      action: 'escalate', priority, severity,
      confidence: 0.5,
      falseAlarmProbability: clamp01(1 - event.sensorConfidence),
      responderId: null,
      instruction: 'No responder available, escalate to shift supervisor.',
      rationale: 'Static policy escalates when the roster has nobody free at this site.',
      evidence,
    };
  }

  return {
    action: 'dispatch', priority, severity,
    confidence: 0.5,
    falseAlarmProbability: clamp01(1 - event.sensorConfidence),
    responderId: responder.id,
    instruction: `Respond to ${event.zoneId} and report. Severity ${severity} under standing policy.`,
    rationale: `Static policy dispatches every severity-${severity} event to the nearest available responder`
      + `${skill ? ` with the ${skill} skill` : ''}. Responder chosen on ETA alone, no acceptance or reliability history.`,
    evidence,
  };
}

function staticPick(
  world: WorldState, sim: Simulator, event: SecurityEvent, skill: Skill | null,
): Responder | null {
  const pool = dispatchPool(world, event.siteId);
  const skilled = skill === null
    ? pool
    : pool.filter((r) => r.kind === 'guard' && r.skills.includes(skill));
  const use = skilled.length > 0 ? skilled : pool;

  let best: Responder | null = null;
  let bestEta = Number.POSITIVE_INFINITY;
  for (const r of use) {
    const eta = sim.etaMs(r.id, event.zoneId);
    if (eta < bestEta) { bestEta = eta; best = r; }   // strict `<` keeps roster order on ties
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
//  SHARED CONTEXT PLUMBING
// ─────────────────────────────────────────────────────────────────────────────

const READY: ReadonlySet<ResponderStatus> = new Set<ResponderStatus>(['available']);
const BENCH: ReadonlySet<ResponderStatus> = new Set<ResponderStatus>(['available', 'break']);
const UNUSABLE: ReadonlySet<ResponderStatus> = new Set<ResponderStatus>(['off_shift', 'offline']);

/** Bodies that could plausibly be sent, preferring the incident's own site. */
function dispatchPool(world: WorldState, siteId: string): Responder[] {
  const all: Responder[] = [...world.guards, ...world.robots];
  const onSite = all.filter((r) => r.siteId === siteId);
  const scope = onSite.length > 0 ? onSite : all;

  const ready = scope.filter((r) => READY.has(r.status));
  if (ready.length > 0) return ready;
  const bench = scope.filter((r) => BENCH.has(r.status));
  if (bench.length > 0) return bench;
  return scope.filter((r) => !UNUSABLE.has(r.status));
}

function skillsOf(r: Responder): Skill[] {
  return r.kind === 'guard' ? r.skills : [];
}

/**
 * Correlation over the observable event feed only. Adjacency comes from the
 * zone graph, which the agent is allowed to know; nothing here reads truth.
 */
function makeCorrelator(
  world: WorldState,
  recentEvents: SecurityEvent[],
  recentIncidents: Incident[],
): (event: SecurityEvent, windowMs: number) => CorrelationFinding {
  return (event, windowMs) => {
    const zone = world.zoneById.get(event.zoneId);
    const near = new Set<string>([event.zoneId, ...(zone?.adjacent ?? [])]);
    const cutoff = event.ts - Math.max(0, windowMs);

    const related = recentEvents.filter(
      (e) => e.id !== event.id && e.ts >= cutoff && e.ts <= event.ts
        && e.siteId === event.siteId && near.has(e.zoneId),
    );

    if (related.length === 0) {
      return {
        patternDetected: false,
        label: 'No correlated activity',
        relatedEventIds: [],
        relatedIncidentIds: [],
        severityUplift: 0,
        detail: `No other events in ${event.zoneId} or its adjacent zones within ${Math.round(windowMs / 60_000)} min.`,
      };
    }

    const zones = new Set<string>(related.map((e) => e.zoneId));
    zones.add(event.zoneId);
    const relatedIds = new Set<string>(related.map((e) => e.id));
    const relatedIncidentIds = recentIncidents
      .filter((i) => relatedIds.has(i.event.id))
      .map((i) => i.id);

    const total = related.length + 1;
    const patternDetected = related.length >= 2;
    const severityUplift = patternDetected && zones.size >= 2 && related.length >= 3 ? 2 : patternDetected ? 1 : 0;

    const zoneCodes = [...zones].map((z) => world.zoneById.get(z)?.code ?? z);
    const types = [...new Set<string>([event.type, ...related.map((e) => e.type)])];

    return {
      patternDetected,
      label: patternDetected
        ? `${total} events across ${zones.size} adjacent zone${zones.size === 1 ? '' : 's'} in ${Math.round(windowMs / 60_000)} min`
        : `1 nearby event in ${Math.round(windowMs / 60_000)} min`,
      relatedEventIds: [...relatedIds],
      relatedIncidentIds,
      severityUplift,
      detail: `Zones ${zoneCodes.join(', ')} · types ${types.join(', ')}`,
    };
  };
}

interface ContextArgs {
  event: SecurityEvent;
  world: WorldState;
  memory: Memory;
  sim: Simulator;
  recentEvents: SecurityEvent[];
  recentIncidents: Incident[];
  /** Captures whatever the agent's last correlate() call found, for `linkedIncidentIds`. */
  sink: { finding: CorrelationFinding | null };
}

function buildContext(args: ContextArgs): AgentContext {
  const { event, world, memory, sim, recentEvents, recentIncidents, sink } = args;
  const correlate = makeCorrelator(world, recentEvents, recentIncidents);

  return {
    event,
    world,
    memory,
    now: event.ts,
    recentEvents,
    recentIncidents,
    candidates: (requiredSkill: Skill | null) =>
      dispatchPool(world, event.siteId)
        .map((responder) => ({
          responder,
          etaMs: sim.etaMs(responder.id, event.zoneId),
          skillMatch: requiredSkill === null ? true : skillsOf(responder).includes(requiredSkill),
        }))
        .sort((a, b) => (a.etaMs - b.etaMs) || a.responder.id.localeCompare(b.responder.id))
        .slice(0, MAX_CANDIDATES),
    correlate: (e, windowMs) => {
      const finding = correlate(e, windowMs);
      if (e.id === event.id) sink.finding = finding;
      return finding;
    },
    useMemory: true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  THE REPLAY LOOP
// ─────────────────────────────────────────────────────────────────────────────

interface ArmSpec {
  id: EvalArmId;
  label: string;
  description: string;
  sim: Simulator;
  /** null => the static table; the arm has no memory of any kind. */
  memory: Memory | null;
  /** null => the static table. */
  agent: DispatchAgent | null;
}

/**
 * Replay `stream` through one arm. Every event is decided, offered, resolved and
 * only then learned from (in that order) which is what makes the numbers
 * defensible as *predictions* rather than fits.
 */
async function runArm(spec: ArmSpec, stream: SeededEvent[]): Promise<Incident[]> {
  const sim = spec.sim;
  const world = sim.world;
  const nextIncidentId = makeIdFactory('EVI');

  const recentEvents: SecurityEvent[] = [];
  const recentIncidents: Incident[] = [];
  const incidents: Incident[] = [];

  for (let i = 0; i < stream.length; i++) {
    const seeded = stream[i]!;
    const event = seeded.event;
    const now: SimTime = event.ts;
    const incidentId = nextIncidentId();

    const sink: { finding: CorrelationFinding | null } = { finding: null };
    let decision: AgentDecision;
    let trace: TraceStep[] = [];
    let decisionLatencyMs: number;
    /** Which engine actually produced it; a failed hosted call degrades to the Reasoner. */
    let decidedBy: EngineKind = 'reasoner';

    if (spec.agent && spec.memory) {
      const ctx = buildContext({
        event, world, memory: spec.memory, sim, recentEvents, recentIncidents, sink,
      });
      const out = await spec.agent.decide(ctx);
      decision = out.decision;
      trace = out.trace;
      decisionLatencyMs = out.latencyMs;
      decidedBy = out.engine;
    } else {
      const t0 = Date.now();   // real wall clock: this is a latency measurement, not sim logic
      decision = staticDecide(event, world, sim);
      decisionLatencyMs = Date.now() - t0;
    }

    const ruleIds = decision.evidence
      .filter((e) => e.kind === 'playbook')
      .map((e) => e.refId);
    if (spec.memory && ruleIds.length > 0) spec.memory.playbook.noteApplied(ruleIds);

    // ── offer the dispatch, if the agent asked for one.
    let dispatch: DispatchRecord | null = null;
    let accepted: boolean | null = null;
    if (decision.action === 'dispatch' && decision.responderId) {
      const responder = world.responderById.get(decision.responderId);
      if (responder) {
        const offer = sim.offerDispatch(responder.id, incidentId, event.zoneId);
        accepted = offer.accepted;
        dispatch = {
          responderId: responder.id,
          responderName: responder.name,
          dispatchedAt: now,
          accepted,
          acknowledgedAt: accepted ? now : null,
          arrivedAt: accepted ? now + offer.etaMs : null,
          responseMs: accepted ? offer.etaMs : null,
          report: offer.reason,
        };
        spec.memory?.responders.observeOffer(responder.id, accepted);
        if (accepted) spec.memory?.responders.observeArrival(responder.id, offer.etaMs);
      } else {
        // The agent named a responder that does not exist. That is a real failure
        // mode and is scored as a dispatch nobody answered, not quietly dropped.
        accepted = false;
        dispatch = {
          responderId: decision.responderId,
          responderName: 'unknown responder',
          dispatchedAt: now,
          accepted: false,
          acknowledgedAt: null,
          arrivedAt: null,
          responseMs: null,
          report: 'Dispatch failed: responder id not on the roster.',
        };
      }
    }

    const resolution = sim.resolve(seeded.truth, decision, accepted);
    if (dispatch) dispatch.report = resolution.report;
    if (dispatch && world.responderById.has(dispatch.responderId)) {
      sim.releaseResponder(dispatch.responderId);
    }

    const incident: Incident = {
      id: incidentId,
      event,
      createdAt: now,
      status: statusFor(decision.action, resolution.outcome),
      decision,
      trace,
      decisionLatencyMs,
      dispatch,
      feedback: null,
      resolvedAt: now + (dispatch?.responseMs ?? 0),
      outcome: resolution.outcome,
      revealedTruth: seeded.truth,
      engine: decidedBy,
      linkedIncidentIds: sink.finding?.relatedIncidentIds ?? [],
    };
    incidents.push(incident);

    // ── learn, strictly after the fact.
    if (spec.memory) {
      const m = spec.memory;
      m.calibration.observe(event.siteId, event.zoneId, event.type, now, seeded.truth.isReal);
      if (dispatch?.accepted && world.responderById.has(dispatch.responderId)) {
        m.responders.observeResolution(
          dispatch.responderId,
          resolution.outcome === 'true_positive' || resolution.outcome === 'false_alarm',
        );
      }
      m.precedent.index(incident);
      if (ruleIds.length > 0) {
        m.playbook.noteOutcome(ruleIds, actionWasCorrect(decision.action, seeded.truth.isReal), false);
      }
      if ((i + 1) % AUTORETIRE_EVERY === 0) m.playbook.autoRetire(now);
    }

    recentEvents.push(event);
    if (recentEvents.length > RECENT_LIMIT) recentEvents.shift();
    recentIncidents.push(incident);
    if (recentIncidents.length > RECENT_LIMIT) recentIncidents.shift();

    if ((i + 1) % YIELD_EVERY === 0) await yieldToEventLoop();
  }

  return incidents;
}

function statusFor(action: AgentDecision['action'], outcome: ResolutionOutcome): IncidentStatus {
  if (action === 'suppress') return 'suppressed';
  if (action === 'escalate') return 'escalated';
  if (outcome === 'unresolved') return 'open';
  return 'resolved';
}

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => { setImmediate(resolve); });
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

// ─────────────────────────────────────────────────────────────────────────────
//  MEMORY CLONING  (so an eval can never mutate the live system's memory)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deep-copy the live memory's *state* onto a freshly constructed Memory built
 * against `world`.
 *
 * structuredClone would strip the prototypes and leave us with method-less
 * husks, and the stores expose no serialise/load pair, so we copy own fields and
 * re-point anything that is a world entity (guard, robot, zone, site) at the
 * eval world's instance of it, matched by id, which the id factories make
 * stable across worlds. Everything else is copied by value, so the eval and the
 * live console cannot observe each other.
 */
function cloneMemory(src: Memory, world: WorldState, now: SimTime, seed: number): Memory {
  const dst = createMemory(world, now, seed);
  const byId = worldEntityIndex(world);
  copyState(src.calibration, dst.calibration, byId);
  copyState(src.responders, dst.responders, byId);
  copyState(src.playbook, dst.playbook, byId);
  copyState(src.precedent, dst.precedent, byId);
  return dst;
}

function worldEntityIndex(world: WorldState): Map<string, object> {
  const index = new Map<string, object>();
  for (const s of world.sites) index.set(s.id, s);
  for (const z of world.zones) index.set(z.id, z);
  for (const g of world.guards) index.set(g.id, g);
  for (const r of world.robots) index.set(r.id, r);
  return index;
}

function copyState(src: object, dst: object, byId: Map<string, object>): void {
  const seen = new WeakMap<object, unknown>();

  const copy = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object') return value;
    const obj = value as object;
    if (seen.has(obj)) return seen.get(obj);

    // Re-point world entities at this world's instances rather than duplicating them.
    const id = (obj as { id?: unknown }).id;
    if (typeof id === 'string') {
      const live = byId.get(id);
      if (live !== undefined) return live;
    }

    if (value instanceof Map) {
      const out = new Map<unknown, unknown>();
      seen.set(obj, out);
      for (const [k, v] of value) out.set(copy(k), copy(v));
      return out;
    }
    if (value instanceof Set) {
      const out = new Set<unknown>();
      seen.set(obj, out);
      for (const v of value) out.add(copy(v));
      return out;
    }
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      seen.set(obj, out);
      for (const v of value) out.push(copy(v));
      return out;
    }
    if (value instanceof Date) return new Date(value.getTime());

    const out = Object.create(Object.getPrototypeOf(value)) as Record<string, unknown>;
    seen.set(obj, out);
    for (const [k, v] of Object.entries(value)) out[k] = copy(v);
    return out;
  };

  for (const [k, v] of Object.entries(src)) {
    (dst as Record<string, unknown>)[k] = copy(v);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  runEval
// ─────────────────────────────────────────────────────────────────────────────

export interface RunEvalOptions {
  seed: number;
  eventCount: number;
  /** Run the judgment layer on the configured hosted model rather than the Reasoner. */
  useLlm: boolean;
  /** The running console's memory. Cloned, never mutated. */
  liveMemory?: Memory;
}

export async function runEval(opts: RunEvalOptions): Promise<EvalRun> {
  const startedAt = Date.now();
  const caveats: string[] = [];

  const choice = opts.useLlm ? resolveProviderChoice() : null;
  const useLlm = choice !== null;
  if (opts.useLlm && !useLlm) {
    caveats.push('No GEMINI_API_KEY is set, the hosted-model request was ignored and both agent arms ran on the deterministic Reasoner.');
  }

  const cap = useLlm ? LLM_EVENT_CAP : REASONER_EVENT_CAP;
  const requested = Math.floor(opts.eventCount);
  const eventCount = Math.max(1, Math.min(Number.isFinite(requested) ? requested : 1, cap));
  if (requested > eventCount) {
    caveats.push(`Requested ${requested} events, capped at ${eventCount}${useLlm ? ' (hosted-model arms are rate- and cost-limited)' : ''}.`);
  }

  // ── 1. Generate the stream exactly once. Every arm replays this list.
  const streamSim = new WorldSimulator(opts.seed);
  const stream = streamSim.generate(eventCount);
  const world = streamSim.world;

  // The oracle stands in for the operator: an eval has no human to agree with.
  const oracle = new Map<string, AgentDecision['action']>();
  for (const seeded of stream) oracle.set(seeded.event.id, streamSim.oraclePolicy(seeded).action);

  const t0: SimTime = stream.length > 0 ? stream[0]!.event.ts : streamSim.now();

  // ── 2. Build the judgment layer. One agent instance, shared by cold and learned,
  //       so the two arms differ *only* in what memory they carry.
  let tokensIn = 0;
  let tokensOut = 0;
  let engineFailures = 0;
  const agent: DispatchAgent = choice
    ? new LlmAgent({
      provider: buildProvider(choice, (u) => { tokensIn += u.in; tokensOut += u.out; }),
      onFailure: () => { engineFailures += 1; },
    })
    : new ReasonerAgent();

  // ── 3. Arm A, static table, no memory.
  const staticSim = new WorldSimulator(opts.seed);
  const staticIncidents = await runArm({
    id: 'static',
    label: 'Static rules',
    description: 'Fixed severity table, nearest available responder. No memory of any kind.',
    sim: staticSim,
    memory: null,
    agent: null,
  }, stream);

  // ── 4. Arm B, the real agent, memory enabled but empty.
  const coldSim = new WorldSimulator(opts.seed);
  const coldMemory = createMemory(coldSim.world, t0, opts.seed);
  const coldIncidents = await runArm({
    id: 'cold',
    label: 'Agent, cold memory',
    description: `${ENGINE_LABELS[agent.engine]} judgment layer with all four memory channels enabled but empty at t=0.`,
    sim: coldSim,
    memory: coldMemory,
    agent,
  }, stream);

  // ── 5. Arm C, the real agent, memory that has already seen this building.
  const learnedSim = new WorldSimulator(opts.seed);
  let learnedMemory: Memory;
  let provenance: string;

  if (opts.liveMemory) {
    learnedMemory = cloneMemory(opts.liveMemory, learnedSim.world, t0, opts.seed);
    provenance = 'deep-cloned from the live console, so this arm reflects exactly what the running system has learned so far';
    if (opts.seed !== currentWorldSeed()) {
      caveats.push('Live memory was learned in the console\'s world. Responder ids are stable across seeds but the hidden responder traits behind them are not, so the responder channel only transfers cleanly when the eval seed matches the console seed.');
    }
  } else {
    learnedMemory = createMemory(learnedSim.world, t0, opts.seed);
    const warmCount = Math.max(WARMUP_MIN, Math.min(WARMUP_MAX, Math.round(eventCount * 0.75)));
    const warmIncidents = await warmUp(opts.seed, learnedMemory, eventCount, warmCount);
    provenance = `pre-trained on ${warmIncidents.length} warm-up events drawn from the same world and the same generator, taken strictly *after* the ${eventCount} scored events in the stream so there is no overlap with the test set`;

    // A reflection pass turns the warm-up history into playbook rules. Always the
    // Reasoner here: warm-up is about accumulating memory, not about paying for
    // the same judgment twice, and a deterministic warm-up keeps reruns comparable.
    try {
      const proposal = await runReflection({
        incidents: warmIncidents,
        memory: learnedMemory,
        world: learnedSim.world,
        now: t0,
        agentEngine: 'reasoner',
      });
      if (proposal.rules.length > 0 || proposal.retire.length > 0) {
        learnedMemory.playbook.addProposal(proposal);
        learnedMemory.playbook.applyProposal(proposal.id, proposal.rules.map((r) => r.id), []);
        caveats.push(`Warm-up auto-approved ${proposal.rules.length} reflection-authored rule(s). Production keeps a human in that loop, so the playbook channel's contribution here is an upper bound.`);
      }
    } catch (err) {
      caveats.push(`Reflection pass skipped during warm-up (${errText(err)}); the learned arm carries only its seeded playbook.`);
    }
  }

  const learnedIncidents = await runArm({
    id: 'learned',
    label: 'Agent, learned memory',
    description: `Same judgment layer as the cold arm, with memory ${provenance.split(',')[0]}.`,
    sim: learnedSim,
    memory: learnedMemory,
    agent,
  }, stream);

  // ── 6. Score.
  const sampleIndices = strideIndices(stream.length, SAMPLE_CAP);
  const arms: EvalArm[] = [
    buildArm('static', 'Static rules',
      'Fixed severity table, nearest available responder by ETA. No calibration, no responder model, no playbook, no precedent.',
      staticIncidents, oracle, world, sampleIndices),
    buildArm('cold', `Agent · cold memory`,
      `${ENGINE_LABELS[agent.engine]} judgment layer, all four memory channels enabled but empty at t=0. Learns online during the run.`,
      coldIncidents, oracle, world, sampleIndices),
    buildArm('learned', `Agent · learned memory`,
      `Identical judgment layer to the cold arm; memory ${provenance}.`,
      learnedIncidents, oracle, world, sampleIndices),
  ];

  const staticMetrics = arms[0]!.metrics;
  const learnedMetrics = arms[2]!.metrics;

  if (engineFailures > 0) {
    caveats.push(`${engineFailures} ${ENGINE_LABELS[agent.engine]} call(s) failed and fell back to the deterministic reasoner mid-run.`);
  }
  if (useLlm) {
    caveats.push(`Hosted-model arms are non-deterministic: rerunning this seed will not reproduce these numbers exactly. Token usage: ${tokensIn} in / ${tokensOut} out.`);
  }

  return {
    id: evalRunId(),
    createdAt: startedAt,
    seed: opts.seed,
    eventCount,
    engine: agent.engine,
    arms,
    delta: metricDelta(learnedMetrics, staticMetrics),
    durationMs: Date.now() - startedAt,
    notes: buildNotes({
      seed: opts.seed, eventCount, engine: agent.engine, provenance,
      liveMemory: Boolean(opts.liveMemory), caveats,
    }),
  };
}

/**
 * Train `memory` on events the scored run will never see: the same world, the
 * same generator, but the slice that comes *after* the test stream. Using a
 * different seed would build a different building, which would teach the agent
 * the wrong priors; using the same slice would be training on the test set.
 */
async function warmUp(
  seed: number, memory: Memory, skip: number, count: number,
): Promise<Incident[]> {
  const sim = new WorldSimulator(seed);
  const all = sim.generate(skip + count);
  const warmStream = all.slice(skip);
  return runArm({
    id: 'learned',
    label: 'warm-up',
    description: 'warm-up',
    sim,
    memory,
    agent: new ReasonerAgent(),
  }, warmStream);
}

function buildArm(
  id: EvalArmId,
  label: string,
  description: string,
  incidents: Incident[],
  oracle: Map<string, AgentDecision['action']>,
  world: WorldState,
  sampleIndices: number[],
): EvalArm {
  const sampleDecisions: EvalArm['sampleDecisions'] = [];
  for (const i of sampleIndices) {
    const inc = incidents[i];
    if (!inc || !inc.decision) continue;
    const wasReal = inc.revealedTruth?.isReal === true;
    sampleDecisions.push({
      eventId: inc.event.id,
      zoneCode: world.zoneById.get(inc.event.zoneId)?.code ?? inc.event.zoneId,
      type: inc.event.type,
      action: inc.decision.action,
      wasReal,
      correct: actionWasCorrect(inc.decision.action, wasReal),
    });
  }
  return { id, label, description, metrics: computeMetrics({ incidents, oracle }), sampleDecisions };
}

function strideIndices(n: number, cap: number): number[] {
  if (n <= 0) return [];
  const stride = Math.max(1, Math.ceil(n / cap));
  const out: number[] = [];
  for (let i = 0; i < n && out.length < cap; i += stride) out.push(i);
  return out;
}

function currentWorldSeed(): number {
  const raw = Number(process.env.SENTRY_SEED);
  return Number.isFinite(raw) ? raw : Number.NaN;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─────────────────────────────────────────────────────────────────────────────
//  METHODOLOGY NOTE  (rendered verbatim in the UI and the CLI)
// ─────────────────────────────────────────────────────────────────────────────

function buildNotes(args: {
  seed: number;
  eventCount: number;
  engine: EngineKind;
  provenance: string;
  liveMemory: boolean;
  caveats: string[];
}): string {
  const engineName = args.engine === 'reasoner' ? 'Reasoner (deterministic)' : ENGINE_LABELS[args.engine];
  const lines: string[] = [];

  lines.push(`HELD CONSTANT across all three arms`);
  lines.push(`• Event stream. WorldSimulator(seed=${args.seed}).generate(${args.eventCount}) is called once; every arm replays that exact list, in order, against the same hidden ground truth.`);
  lines.push(`• World, sites, zones, roster and every responder's hidden traits are rebuilt from seed ${args.seed} for each arm, so no arm inherits another arm's responder fatigue or assignments.`);
  lines.push(`• Scoring, simulator.resolve() is the only consumer of ground truth, and it is identical for every arm.`);
  lines.push(`• Agreement baseline, the oracle policy stands in for the operator, since an eval has no human to confirm or override.`);
  lines.push('');
  lines.push(`VARIED (the independent variable): the memory behind the judgment layer.`);
  lines.push(`• static , fixed severity table + nearest-ETA responder. No memory at all.`);
  lines.push(`• cold   , ${engineName} judgment layer, all four memory channels on but empty at t=0.`);
  lines.push(`• learned, the same judgment layer, memory ${args.provenance}.`);
  lines.push('');
  lines.push(`ONLINE LEARNING`);
  lines.push(`Within every arm each event is decided first, resolved second, and folded into that arm's own memory third. No arm can see an outcome before it has committed to a decision, so the cold arm also improves during the run, the learned-vs-cold gap is the value of prior experience, and the learned-vs-static gap is the headline delta.`);
  lines.push('');
  lines.push(`THREATS TO VALIDITY`);
  lines.push(`• Not paired: resolve() and offerDispatch() draw from each arm's simulator RNG, and different arms make different decisions, so accept/arrival rolls diverge between arms. responderAcceptRate and medianResponseMs carry a few points of noise; falseDispatchRate and missedCriticalRate do not depend on those rolls.`);
  lines.push(`• The simulator is the world. Every number here is a claim about SENTRY's behaviour inside a model whose regularities SENTRY was designed to find. It is evidence that the learning loop closes, not a field trial.`);
  if (args.liveMemory) {
    lines.push(`• The learned arm's memory came from the live console, which has been running its own stream. Its calibration is therefore fitted to a history this eval did not generate.`);
  }
  for (const c of args.caveats) lines.push(`• ${c}`);
  lines.push('');
  lines.push(`Full metric definitions and the dispatchScore weighting: docs/METRICS.md`);

  return lines.join('\n');
}
