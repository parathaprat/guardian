/**
 * SENTRY, the world simulator.
 *
 * Owns the only copy of ground truth in the system. Events leave here with the
 * truth attached in `SeededEvent.truth`; the dispatch pipeline is handed
 * `SeededEvent.event` and nothing else. `resolve()` is the single function that
 * consults truth for scoring, and it is called only after a decision is locked.
 *
 * Everything is driven by a seeded PRNG so the same seed produces a byte-identical
 * stream. That is the precondition for the A/B replay harness meaning anything.
 */

import type {
  AgentDecision, EventTruth, EventType, Guard, ResolutionOutcome, Responder, Robot,
  SecurityEvent, SeededEvent, Severity, SimTime, SourceKind, Skill, Zone,
} from '../../shared/types';
import { inHourRange, priorityFromSeverity } from '../../shared/types';
import type { Simulator, WorldState } from '../contracts';
import { Rng } from '../util/rng';
import { makeIdFactory } from '../util/ids';
import { buildWorld, matchRegularity, REGULARITY_WEIGHTS, REGULARITIES } from './site';

/**
 * Sim time starts at a fixed instant so runs are comparable across machines.
 *
 * 01:30 is chosen deliberately: at the default 64× a reviewer is inside the
 * 02:00–04:30 Dock D-3 nuisance window within a real minute, which is the
 * clearest demonstration of the calibration channel earning its keep.
 */
const EPOCH = Date.UTC(2026, 6, 21, 1, 30, 0);

/** Base cost of moving one hop across the zone adjacency graph. */
const HOP_MS = 55_000;
const CROSS_SITE_MS = 9 * 60_000;

/**
 * How the world actually behaves, per event type, absent a matching regularity.
 * Deliberately NOT the same table the agent reasons from (`TYPE_PROFILE` in
 * agent/tools.ts), if the agent's prior were the generator's truth, the
 * calibration channel would have nothing left to learn.
 */
interface TruthProfile {
  pReal: number;
  severity: Severity;
  skill: Skill | null;
  /** Relative arrival frequency. */
  rate: number;
  real: string;
  fake: string;
}

const TRUTH: Record<EventType, TruthProfile> = {
  motion_detected:      { pReal: 0.13, severity: 2, skill: null,             rate: 24, real: 'Confirmed person moving through the zone.', fake: 'Environmental trigger, no person present.' },
  door_propped:         { pReal: 0.45, severity: 3, skill: 'access_control', rate: 9,  real: 'Door held open with no authorised presence.', fake: 'Scheduled activity, door released normally.' },
  door_forced:          { pReal: 0.71, severity: 4, skill: 'access_control', rate: 4,  real: 'Strike plate damaged; forced entry.', fake: 'Mechanical fault, latch misaligned, not forced.' },
  glass_break:          { pReal: 0.44, severity: 4, skill: 'armed',          rate: 5,  real: 'Glazing breached.', fake: 'Acoustic false trigger.' },
  tailgating:           { pReal: 0.34, severity: 3, skill: 'access_control', rate: 10, real: 'Unbadged individual followed a credential holder in.', fake: 'Both parties badged, reader lag.' },
  loitering:            { pReal: 0.29, severity: 2, skill: 'de_escalation',  rate: 11, real: 'Individual lingering with no legitimate business.', fake: 'Passer-by dwell, moved on unaided.' },
  person_down:          { pReal: 0.88, severity: 5, skill: 'medical',        rate: 2,  real: 'Person unresponsive on the ground.', fake: 'Posture misclassified by analytics.' },
  fire_alarm:           { pReal: 0.62, severity: 5, skill: 'fire',           rate: 2,  real: 'Genuine smoke/heat activation.', fake: 'Dust or steam on the detector head.' },
  vehicle_unauthorized: { pReal: 0.41, severity: 3, skill: null,             rate: 7,  real: 'Unregistered vehicle in a controlled area.', fake: 'Vehicle on an unsynced permit list.' },
  perimeter_breach:     { pReal: 0.52, severity: 4, skill: 'armed',          rate: 6,  real: 'Fence line crossed.', fake: 'Wildlife or debris on the beam.' },
  robot_obstruction:    { pReal: 0.80, severity: 1, skill: 'technical',      rate: 5,  real: 'Robot physically blocked and unable to route.', fake: 'Transient stall, self-cleared.' },
  camera_offline:       { pReal: 0.86, severity: 2, skill: 'technical',      rate: 4,  real: 'Camera genuinely down.', fake: 'Momentary network drop, stream restored.' },
  panic_button:         { pReal: 0.79, severity: 5, skill: 'armed',          rate: 1,  real: 'Duress signal from a real person.', fake: 'Accidental activation.' },
  badge_anomaly:        { pReal: 0.35, severity: 3, skill: 'access_control', rate: 8,  real: 'Credential used outside its authorisation.', fake: 'Stale entry in the access list.' },
  package_theft:        { pReal: 0.56, severity: 2, skill: null,             rate: 6,  real: 'Item removed by someone other than the recipient.', fake: 'Legitimate collection.' },
  noise_complaint:      { pReal: 0.24, severity: 1, skill: 'de_escalation',  rate: 5,  real: 'Genuine disturbance requiring intervention.', fake: 'Ordinary building noise.' },
};

const ALL_TYPES = Object.keys(TRUTH) as EventType[];

/** Types that can plausibly originate from a patrolling robot. */
const ROBOT_TYPES: EventType[] = [
  'motion_detected', 'glass_break', 'loitering', 'robot_obstruction',
  'person_down', 'vehicle_unauthorized', 'package_theft',
];
const ACCESS_TYPES: EventType[] = ['badge_anomaly', 'tailgating', 'door_forced', 'door_propped'];
const TENANT_TYPES: EventType[] = ['noise_complaint', 'package_theft', 'person_down'];

/**
 * Arrivals per sim-hour, by hour of day. Daytime is busier in raw volume; the
 * overnight window is quieter but a far higher share of what it produces is real.
 */
/**
 * Alarms per sim-hour across the whole 3-site portfolio. A real portfolio of this
 * size runs busier than intuition suggests, the overwhelming majority of that
 * traffic is nuisance, which is precisely the problem the agent exists to solve.
 * At the default 64× this lands around one event every two seconds.
 */
function arrivalRate(hour: number): number {
  if (hour >= 7 && hour < 19) return 34;
  if (hour >= 19 && hour < 23) return 26;
  return 20;
}

/** Overnight events are likelier to be genuine, nobody is supposed to be there. */
function nightRealBoost(hour: number): number {
  return hour >= 23 || hour < 5 ? 1.45 : 1;
}

function severityOf(n: number): Severity {
  const c = Math.round(n);
  return (c < 1 ? 1 : c > 5 ? 5 : c) as Severity;
}

export class WorldSimulator implements Simulator {
  readonly world: WorldState;

  private rng: Rng;
  private clock: SimTime;
  private nextEventId = makeIdFactory('EVT');
  private nextPatternId = makeIdFactory('PTN');
  /** Events pending emission from an in-flight coordinated burst. */
  private burst: SeededEvent[] = [];
  private recent: SecurityEvent[] = [];
  private seed: number;

  constructor(seed: number, startTime: SimTime = EPOCH) {
    this.seed = seed;
    this.rng = new Rng(seed);
    this.clock = startTime;
    this.world = buildWorld(this.rng.fork('world'));
    this.rng = this.rng.fork('stream');
  }

  now(): SimTime { return this.clock; }

  reseed(seed: number): void {
    this.seed = seed;
    this.rng = new Rng(seed).fork('stream');
    this.clock = EPOCH;
    this.burst = [];
    this.recent = [];
    this.nextEventId = makeIdFactory('EVT');
    this.nextPatternId = makeIdFactory('PTN');
    for (const g of this.world.guards) {
      g.status = 'available';
      g.assignedIncidentId = null;
      g.currentZoneId = g.homeZoneId;
    }
  }

  // ── generation ────────────────────────────────────────────────────────────

  tick(ms: number): SeededEvent[] {
    const out: SeededEvent[] = [];
    const end = this.clock + ms;

    while (this.clock < end) {
      const hour = new Date(this.clock).getUTCHours();
      // Exponential inter-arrival off a per-hour Poisson rate.
      const perMs = arrivalRate(hour) / 3_600_000;
      const gap = -Math.log(1 - this.rng.next()) / perMs;
      if (this.clock + gap > end) { this.clock = end; break; }
      this.clock += gap;
      out.push(...this.emitAt(this.clock));
    }

    this.clock = end;
    this.refreshShifts();
    return out;
  }

  generate(n: number): SeededEvent[] {
    const out: SeededEvent[] = [];
    // No responder side effects and no shift churn, this is stream synthesis only.
    while (out.length < n) {
      const hour = new Date(this.clock).getUTCHours();
      const perMs = arrivalRate(hour) / 3_600_000;
      this.clock += -Math.log(1 - this.rng.next()) / perMs;
      out.push(...this.emitAt(this.clock));
    }
    return out.slice(0, n);
  }

  /** Emit whatever the world produces at `ts`, usually one event, sometimes a burst. */
  private emitAt(ts: SimTime): SeededEvent[] {
    if (this.burst.length > 0) {
      const next = this.burst.shift()!;
      next.event.ts = ts;
      this.remember(next.event);
      return [next];
    }
    // ~2.5% of arrivals open a coordinated multi-zone incident.
    if (this.rng.bool(0.025)) {
      const seq = this.buildBurst(ts);
      if (seq.length > 0) {
        this.burst = seq.slice(1);
        this.remember(seq[0]!.event);
        return [seq[0]!];
      }
    }
    const one = this.buildEvent(ts);
    this.remember(one.event);
    return [one];
  }

  private remember(e: SecurityEvent): void {
    this.recent.push(e);
    if (this.recent.length > 300) this.recent.shift();
  }

  /** Pick a zone, weighted so zones named in a regularity see their pattern often enough to learn. */
  private pickZone(): Zone {
    if (this.rng.bool(0.42)) {
      const weighted = REGULARITIES.filter((r) => r.zoneId !== null);
      if (weighted.length > 0) {
        const ws = weighted.map((r) => REGULARITY_WEIGHTS.get(r.id) ?? 1);
        const r = this.rng.weighted(weighted, ws);
        const z = this.world.zoneById.get(r.zoneId!);
        if (z) return z;
      }
    }
    return this.rng.weighted(this.world.zones, this.world.zones.map((z) => 0.5 + z.baseRisk));
  }

  private pickType(zone: Zone, hour: number): EventType {
    // If a regularity covers this zone at this hour, bias hard toward its types,
    // otherwise the pattern is too sparse for the calibration channel to find.
    const covering = REGULARITIES.filter(
      (r) => r.zoneId === zone.id && (r.hourRange === null || inHourRange(hour, r.hourRange)),
    );
    if (covering.length > 0 && this.rng.bool(0.62)) {
      return this.rng.pick(this.rng.pick(covering).types);
    }
    return this.rng.weighted(ALL_TYPES, ALL_TYPES.map((t) => TRUTH[t].rate));
  }

  private pickSource(zone: Zone, type: EventType): { kind: SourceKind; id: string; name: string } {
    const robots = this.world.robots.filter((r) => r.patrolZoneIds.includes(zone.id));
    if (ROBOT_TYPES.includes(type) && robots.length > 0 && this.rng.bool(0.62)) {
      const r = this.rng.pick(robots);
      return { kind: 'robot', id: r.id, name: r.name };
    }
    if (ACCESS_TYPES.includes(type)) {
      return { kind: 'access_control', id: `acs-${zone.code.toLowerCase()}`, name: `Reader ${zone.code}` };
    }
    if (TENANT_TYPES.includes(type) && this.rng.bool(0.35)) {
      return { kind: 'tenant_call', id: `tenant-${zone.siteId}`, name: 'Tenant line' };
    }
    if (this.rng.bool(0.12)) {
      const g = this.world.guards.find((x) => x.siteId === zone.siteId);
      if (g) return { kind: 'guard_report', id: g.id, name: g.name };
    }
    return { kind: 'fixed_sensor', id: `sen-${zone.code.toLowerCase()}`, name: `Sensor ${zone.code}` };
  }

  private buildEvent(ts: SimTime, forced?: { zone: Zone; type: EventType }): SeededEvent {
    const zone = forced?.zone ?? this.pickZone();
    const site = this.world.siteById.get(zone.siteId)!;
    const hour = new Date(ts).getUTCHours() + new Date(ts).getUTCMinutes() / 60;
    const type = forced?.type ?? this.pickType(zone, hour);
    const src = this.pickSource(zone, type);

    const base = TRUTH[type];
    const reg = matchRegularity({ siteId: site.id, zoneId: zone.id, type, hour, sourceId: src.id });

    let pReal = reg ? reg.pReal : base.pReal * nightRealBoost(hour);
    // A degraded robot camera is a property of the device, not the zone.
    const robot = src.kind === 'robot' ? (this.world.responderById.get(src.id) as Robot | undefined) : undefined;
    if (robot && robot.truth.degradedSensor === type) pReal = Math.min(pReal, 0.12);
    else if (robot) pReal *= 1 - robot.truth.falsePositiveRate * 0.5;
    pReal = Math.max(0.02, Math.min(0.97, pReal));

    const isReal = this.rng.bool(pReal);
    const severity = severityOf(
      isReal
        ? base.severity + (reg?.severityBias ?? 0) + (zone.baseRisk > 0.6 ? 1 : 0) + (this.rng.bool(0.15) ? 1 : 0)
        : 1,
    );

    // Sensor confidence is deliberately miscalibrated: it tracks signal strength,
    // not truth. The agent has to learn to discount it.
    const conf = Math.max(0.2, Math.min(0.99,
      this.rng.gauss(isReal ? 0.72 : 0.66, 0.16) + (src.kind === 'robot' ? 0.05 : 0)));

    let explanation: string;
    if (reg && !isReal) explanation = `${reg.label}, ${reg.note}`;
    else if (reg && isReal) explanation = `${base.real} Occurred inside a known pattern window (${reg.label}), but genuine.`;
    else explanation = isReal ? base.real : base.fake;

    const event: SecurityEvent = {
      id: this.nextEventId(),
      ts,
      siteId: site.id,
      zoneId: zone.id,
      type,
      sourceKind: src.kind,
      sourceId: src.id,
      description: this.describe(type, zone, src.name, src.kind),
      sensorConfidence: Math.round(conf * 100) / 100,
      metadata: {
        site: site.code,
        zone: zone.code,
        zoneKind: zone.kind,
        source: src.name,
        localHour: Math.floor(hour),
      },
    };

    return {
      event,
      truth: {
        isReal,
        trueSeverity: severity,
        requiredSkill: isReal ? base.skill : null,
        escalatesAfterMs: (severity >= 4 ? 4 : 12) * 60_000,
        explanation,
        patternId: null,
      },
    };
  }

  /** A coordinated intrusion: 3–4 genuine events walking adjacent zones. */
  private buildBurst(ts: SimTime): SeededEvent[] {
    // Bursts start at the edge of a site and work inward.
    const entryPoints = this.world.zones.filter(
      (z) => z.kind === 'perimeter' || z.kind === 'loading_dock' || z.kind === 'parking',
    );
    const start = entryPoints.length > 0 ? this.rng.pick(entryPoints) : this.pickZone();
    const path: Zone[] = [start];
    let cur = start;
    const len = this.rng.int(3, 4);
    for (let i = 1; i < len; i++) {
      const nexts = cur.adjacent
        .map((id) => this.world.zoneById.get(id))
        .filter((z): z is Zone => !!z && !path.includes(z));
      if (nexts.length === 0) break;
      cur = this.rng.pick(nexts);
      path.push(cur);
    }
    if (path.length < 3) return [];

    const patternId = this.nextPatternId();
    const types: EventType[] = ['perimeter_breach', 'motion_detected', 'door_forced', 'glass_break'];
    return path.map((zone, i) => {
      const seeded = this.buildEvent(ts + i * this.rng.int(60_000, 150_000), {
        zone,
        type: i === 0 ? 'perimeter_breach' : this.rng.pick(types),
      });
      // A burst is real by construction and escalates as it moves inward.
      seeded.truth.isReal = true;
      seeded.truth.trueSeverity = severityOf(3 + i);
      seeded.truth.patternId = patternId;
      seeded.truth.requiredSkill = 'armed';
      seeded.truth.explanation =
        `Coordinated intrusion ${patternId}: leg ${i + 1} of ${path.length} across adjacent zones. ` +
        'Individually ambiguous; the sequence is the signal.';
      seeded.event.sensorConfidence = Math.round(this.rng.float(0.55, 0.9) * 100) / 100;
      return seeded;
    });
  }

  private describe(type: EventType, zone: Zone, source: string, kind: SourceKind): string {
    const where = `${zone.name}`;
    switch (type) {
      case 'motion_detected': return `${source} reports motion in ${where}.`;
      case 'door_propped': return `${where} door held open beyond threshold; reported by ${source}.`;
      case 'door_forced': return `Forced-entry signature on ${where} door (${source}).`;
      case 'glass_break': return `Acoustic glass-break signature at ${where} (${source}).`;
      case 'tailgating': return `Two entries on one credential at ${where} (${source}).`;
      case 'loitering': return `Individual dwelling in ${where} beyond threshold (${source}).`;
      case 'person_down': return `Possible person down in ${where}, flagged by ${source}.`;
      case 'fire_alarm': return `Fire panel activation for ${where}.`;
      case 'vehicle_unauthorized': return `Unregistered vehicle in ${where} (${source}).`;
      case 'perimeter_breach': return `Perimeter beam broken at ${where} (${source}).`;
      case 'robot_obstruction': return `${source} obstructed and unable to complete its route through ${where}.`;
      case 'camera_offline': return `Camera covering ${where} stopped reporting (${source}).`;
      case 'panic_button': return `Duress activation in ${where}.`;
      case 'badge_anomaly': return `Credential used outside authorisation at ${where} (${source}).`;
      case 'package_theft': return `Package removed from ${where} by an unidentified party (${source}).`;
      case 'noise_complaint': return kind === 'tenant_call'
        ? `Tenant reports a disturbance in ${where}.`
        : `Sustained noise detected in ${where} (${source}).`;
    }
  }

  /** Force a specific scenario, used by the console's INJECT affordance. */
  injectAt(type: EventType, zoneId: string, ts: SimTime = this.clock): SeededEvent {
    const zone = this.world.zoneById.get(zoneId) ?? this.world.zones[0]!;
    const seeded = this.buildEvent(ts, { zone, type });
    this.remember(seeded.event);
    return seeded;
  }

  // ── responders ────────────────────────────────────────────────────────────

  /** BFS hop distance across the zone graph, with a penalty for crossing sites. */
  etaMs(responderId: string, zoneId: string): number {
    const r = this.world.responderById.get(responderId);
    const target = this.world.zoneById.get(zoneId);
    if (!r || !target) return CROSS_SITE_MS * 2;

    const from = this.world.zoneById.get(r.currentZoneId);
    if (!from) return CROSS_SITE_MS;

    let hops: number;
    if (from.siteId !== target.siteId) {
      hops = 4;
    } else {
      hops = Number.POSITIVE_INFINITY;
      const seen = new Set<string>([from.id]);
      let frontier: string[] = [from.id];
      for (let d = 0; d <= 8 && frontier.length > 0; d++) {
        if (frontier.includes(target.id)) { hops = d; break; }
        const next: string[] = [];
        for (const id of frontier) {
          for (const adj of this.world.zoneById.get(id)?.adjacent ?? []) {
            if (!seen.has(adj)) { seen.add(adj); next.push(adj); }
          }
        }
        frontier = next;
      }
      if (!Number.isFinite(hops)) hops = 6;
    }

    const speed = r.kind === 'guard' ? r.truth.speedFactor : 1;
    const cross = from.siteId !== target.siteId ? CROSS_SITE_MS : 0;
    return Math.round((hops * HOP_MS + cross) * speed + 30_000);
  }

  offerDispatch(responderId: string, incidentId: string, zoneId: string): {
    accepted: boolean; etaMs: number; reason: string;
  } {
    const r = this.world.responderById.get(responderId);
    const eta = this.etaMs(responderId, zoneId);
    if (!r) return { accepted: false, etaMs: eta, reason: 'Responder not on roster.' };

    if (r.kind === 'robot') {
      // Robots never decline, they get re-tasked.
      if (this.world.zoneById.has(zoneId)) r.currentZoneId = zoneId;
      r.status = 'enroute';
      return { accepted: true, etaMs: eta, reason: `${r.name} re-tasked to the zone.` };
    }

    if (r.status !== 'available') {
      return { accepted: false, etaMs: eta, reason: `${r.name} is ${r.status.replace('_', ' ')}.` };
    }

    const accepted = this.rng.bool(r.truth.acceptRate);
    if (accepted) {
      r.status = 'enroute';
      r.assignedIncidentId = incidentId;
      return { accepted: true, etaMs: eta, reason: `${r.name} acknowledged, en route.` };
    }
    // Declines are a learnable property of the guard, so give a plausible cause.
    const excuse = this.rng.pick([
      'holding a post that cannot be left unattended',
      'completing a prior call',
      'on a mandated break',
      'escorting a contractor off site',
    ]);
    return { accepted: false, etaMs: eta, reason: `${r.name} declined, ${excuse}.` };
  }

  releaseResponder(responderId: string): void {
    const r = this.world.responderById.get(responderId);
    if (!r) return;
    r.status = 'available';
    if (r.kind === 'guard') r.assignedIncidentId = null;
  }

  /** Guards drift on and off shift as sim time advances. */
  private refreshShifts(): void {
    const hour = new Date(this.clock).getUTCHours() + new Date(this.clock).getUTCMinutes() / 60;
    for (const g of this.world.guards) {
      const onShift = inHourRange(hour, g.shift);
      if (!onShift && g.status === 'available') g.status = 'off_shift';
      else if (onShift && g.status === 'off_shift') g.status = 'available';
    }
  }

  // ── scoring (the only place truth is consulted) ───────────────────────────

  resolve(truth: EventTruth, decision: AgentDecision, accepted: boolean | null): {
    outcome: ResolutionOutcome; report: string;
  } {
    const passive = decision.action === 'suppress' || decision.action === 'monitor';

    if (passive) {
      if (truth.isReal && truth.trueSeverity >= 4) {
        return {
          outcome: 'missed',
          report: `Escalated unattended. ${truth.explanation} No responder was sent.`,
        };
      }
      if (truth.isReal) {
        return {
          outcome: 'true_positive',
          report: `Genuine but low-severity; self-resolved without dispatch. ${truth.explanation}`,
        };
      }
      return { outcome: 'false_alarm', report: `No incident. ${truth.explanation}` };
    }

    if (accepted === false) {
      return {
        outcome: 'declined',
        report: 'No responder accepted the assignment; the call went uncovered.',
      };
    }

    if (!truth.isReal) {
      return {
        outcome: 'false_alarm',
        report: `Responder attended and cleared the zone. ${truth.explanation} Guard time spent on a nuisance call.`,
      };
    }

    return {
      outcome: 'true_positive',
      report: `Responder attended and confirmed the incident. ${truth.explanation}`,
    };
  }

  oraclePolicy(seeded: SeededEvent): { action: AgentDecision['action']; priority: AgentDecision['priority'] } {
    const { truth } = seeded;
    if (!truth.isReal) return { action: 'suppress', priority: 'P3' };
    if (truth.trueSeverity >= 5) return { action: 'escalate', priority: 'P0' };
    return { action: 'dispatch', priority: priorityFromSeverity(truth.trueSeverity) };
  }

  /** Recent events, truth stripped, this is what the correlate tool reads. */
  recentEvents(limit = 60): SecurityEvent[] {
    return this.recent.slice(-limit);
  }
}
