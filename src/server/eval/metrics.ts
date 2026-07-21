/**
 * SENTRY, metric definitions.
 *
 * Every number the product uses to claim "it is getting smarter" is defined
 * here, once. See docs/METRICS.md for the prose definitions, the composite
 * weighting, and the threats to validity.
 *
 * Two invariants:
 *   1. No metric may ever return NaN or Infinity. Empty input returns
 *      EMPTY_METRICS, and every ratio goes through `ratio()`.
 *   2. Ground truth is read only from `incident.revealedTruth`, which the
 *      simulator attaches *after* resolution. Nothing here can leak into the
 *      agent, because nothing here runs before a decision is made.
 */

import type {
  AgentActionKind, Incident, LearningPoint, Metrics, ResolutionOutcome,
} from '../../shared/types';
import { EMPTY_METRICS, calibrationKey, hourBucketOf } from '../../shared/types';
import type { ComputeLearningCurve, ComputeMetrics, MetricsInput } from '../contracts';

// ─────────────────────────────────────────────────────────────────────────────
//  TUNABLES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decision-latency budget. A dispatcher who takes longer than this to make a
 * call has already lost the incident, so the latency term saturates at 0 here
 * rather than growing unboundedly negative and swamping the composite.
 */
export const LATENCY_TARGET_MS = 30_000;

/** Actions that put a human in motion, the ones a false alarm actually costs. */
const COMMITTING_ACTIONS: ReadonlySet<AgentActionKind> = new Set<AgentActionKind>(['dispatch', 'escalate']);

/** Severity at or above which a miss is unrecoverable. */
const CRITICAL_SEVERITY = 4;

/** Sliding-window width for the learning curve, in resolved incidents. */
export const DEFAULT_CURVE_WINDOW = 25;

/** The five components of `dispatchScore`. Weights sum to 1. */
export type ScoreTerm =
  | 'missedCritical'
  | 'falseDispatch'
  | 'operatorAgreement'
  | 'truePositiveAction'
  | 'latency';

export const SCORE_WEIGHTS: Record<ScoreTerm, number> = {
  missedCritical: 0.30,
  falseDispatch: 0.25,
  operatorAgreement: 0.20,
  truePositiveAction: 0.15,
  latency: 0.10,
};

/**
 * Which score terms had a non-empty denominator. A term with no data is
 * dropped and its weight redistributed across the terms that do, scoring a
 * term you have no evidence for is how benchmarks start lying.
 */
export type ScoreAvailability = Partial<Record<ScoreTerm, boolean>>;

// ─────────────────────────────────────────────────────────────────────────────
//  SMALL MATH
// ─────────────────────────────────────────────────────────────────────────────

function ratio(numerator: number, denominator: number, fallback = 0): number {
  if (denominator <= 0) return fallback;
  const r = numerator / denominator;
  return Number.isFinite(r) ? clamp01(r) : fallback;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Lower median (average of the two middle values for even n). */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

// ─────────────────────────────────────────────────────────────────────────────
//  PREDICATES  (single definition of each concept, reused by the curve)
// ─────────────────────────────────────────────────────────────────────────────

const RESOLVED_OUTCOMES: ReadonlySet<ResolutionOutcome> = new Set<ResolutionOutcome>([
  'true_positive', 'false_alarm', 'missed', 'declined', 'unresolved',
]);

/** An incident counts as scored once the simulator has revealed its outcome. */
function isResolved(inc: Incident): boolean {
  return inc.outcome !== null && RESOLVED_OUTCOMES.has(inc.outcome);
}

function isCritical(inc: Incident): boolean {
  return (inc.revealedTruth?.trueSeverity ?? 0) >= CRITICAL_SEVERITY;
}

function committed(inc: Incident): boolean {
  return inc.decision !== null && COMMITTING_ACTIONS.has(inc.decision.action);
}

/**
 * Did the agent's action match physical reality? Real ⇒ someone should have
 * gone; not real ⇒ nobody should have. Deliberately independent of the
 * simulator's own outcome label so the drill-down table stays interpretable
 * next to the `wasReal` column.
 */
export function actionWasCorrect(action: AgentActionKind, wasReal: boolean): boolean {
  return wasReal ? COMMITTING_ACTIONS.has(action) : !COMMITTING_ACTIONS.has(action);
}

// ─────────────────────────────────────────────────────────────────────────────
//  COMPOSITE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 0..100 composite. `avail` marks which terms had evidence; omitted means "all
 * five", which is the right default when re-scoring a Metrics object that has
 * already been computed.
 */
export function scoreOf(m: Metrics, avail?: ScoreAvailability): number {
  const terms: Record<ScoreTerm, number> = {
    missedCritical: 1 - clamp01(m.missedCriticalRate),
    falseDispatch: 1 - clamp01(m.falseDispatchRate),
    operatorAgreement: clamp01(m.operatorAgreementRate),
    truePositiveAction: clamp01(m.truePositiveActionRate),
    latency: clamp01(1 - m.medianDecisionLatencyMs / LATENCY_TARGET_MS),
  };

  let weighted = 0;
  let totalWeight = 0;
  for (const key of Object.keys(SCORE_WEIGHTS) as ScoreTerm[]) {
    if (avail && avail[key] === false) continue;
    weighted += SCORE_WEIGHTS[key] * terms[key];
    totalWeight += SCORE_WEIGHTS[key];
  }
  if (totalWeight <= 0) return 0;
  return round(100 * (weighted / totalWeight), 2);
}

// ─────────────────────────────────────────────────────────────────────────────
//  computeMetrics
// ─────────────────────────────────────────────────────────────────────────────

export const computeMetrics: ComputeMetrics = (input: MetricsInput): Metrics => {
  const { incidents, oracle } = input;
  if (incidents.length === 0) return { ...EMPTY_METRICS };

  const resolved = incidents.filter(isResolved);

  // ── false dispatch: of the calls that committed a responder, how many were air?
  let committedResolved = 0;
  let committedFalse = 0;

  // ── missed criticals: of the revealed life-safety events, how many did we sleep through?
  let criticals = 0;
  let criticalsMissed = 0;

  // ── true-positive action rate: of the events that were genuinely real, how many did we catch?
  let realResolved = 0;
  let realHandled = 0;

  for (const inc of resolved) {
    if (committed(inc)) {
      committedResolved += 1;
      if (inc.outcome === 'false_alarm') committedFalse += 1;
    }
    if (isCritical(inc)) {
      criticals += 1;
      if (inc.outcome === 'missed') criticalsMissed += 1;
    }
    if (inc.revealedTruth?.isReal === true) {
      realResolved += 1;
      if (inc.outcome === 'true_positive') realHandled += 1;
    }
  }

  // ── responder acceptance: only offers that got an answer count as offers.
  let offers = 0;
  let accepts = 0;
  const responseSamples: number[] = [];
  for (const inc of incidents) {
    const d = inc.dispatch;
    if (!d || d.accepted === null) continue;
    offers += 1;
    if (d.accepted) {
      accepts += 1;
      if (d.responseMs !== null && Number.isFinite(d.responseMs)) responseSamples.push(d.responseMs);
    }
  }

  // ── latency.
  const latencySamples: number[] = [];
  for (const inc of incidents) {
    if (inc.decisionLatencyMs !== null && Number.isFinite(inc.decisionLatencyMs)) {
      latencySamples.push(Math.max(0, inc.decisionLatencyMs));
    }
  }

  // ── agreement. In eval mode there is no human, so the oracle stands in.
  let agreementDen = 0;
  let agreementNum = 0;
  if (oracle && oracle.size > 0) {
    for (const inc of incidents) {
      if (!inc.decision) continue;
      const want = oracle.get(inc.event.id);
      if (want === undefined) continue;
      agreementDen += 1;
      if (inc.decision.action === want) agreementNum += 1;
    }
  } else {
    for (const inc of incidents) {
      if (!inc.feedback) continue;
      agreementDen += 1;
      if (inc.feedback.verdict === 'confirm') agreementNum += 1;
    }
  }

  const metrics: Metrics = {
    incidents: incidents.length,
    resolved: resolved.length,
    falseDispatchRate: round(ratio(committedFalse, committedResolved, 0), 4),
    missedCriticalRate: round(ratio(criticalsMissed, criticals, 0), 4),
    medianDecisionLatencyMs: Math.round(median(latencySamples)),
    medianResponseMs: Math.round(median(responseSamples)),
    responderAcceptRate: round(ratio(accepts, offers, 0), 4),
    operatorAgreementRate: round(ratio(agreementNum, agreementDen, 0), 4),
    truePositiveActionRate: round(ratio(realHandled, realResolved, 0), 4),
    dispatchScore: 0,
  };

  // "Never dispatched anything false" is a true statement even with zero
  // dispatches, so falseDispatch always counts; the degenerate do-nothing agent
  // is punished by missedCritical and truePositiveAction instead. The other
  // four terms are genuinely unmeasurable without a denominator.
  const availability: ScoreAvailability = {
    missedCritical: criticals > 0,
    falseDispatch: true,
    operatorAgreement: agreementDen > 0,
    truePositiveAction: realResolved > 0,
    latency: latencySamples.length > 0,
  };

  metrics.dispatchScore = scoreOf(metrics, availability);
  return metrics;
};

// ─────────────────────────────────────────────────────────────────────────────
//  computeLearningCurve
// ─────────────────────────────────────────────────────────────────────────────

/** Below this many samples a window is too noisy to plot at all. */
const MIN_WINDOW_SAMPLES = 5;

/** Keep the payload small enough to stream on every metrics tick. */
const MAX_CURVE_POINTS = 180;

/**
 * A *sliding* window, not a running average. A cumulative mean asymptotically
 * stops moving, which makes a genuinely improving agent look like a flat line
 * after a few hundred incidents, exactly the chart artefact that makes
 * learning claims unfalsifiable.
 *
 * `calibrationCells` and `activeRules` are reconstructed from the incidents
 * themselves (the contract signature has no access to Memory): the first is the
 * number of distinct calibration cells the observations so far would have
 * created across all three backoff levels, the second is the number of distinct
 * playbook rules cited as evidence so far. Both are monotonic proxies for
 * memory size; see docs/METRICS.md.
 */
export const computeLearningCurve: ComputeLearningCurve = (
  incidents: Incident[],
  window: number,
): LearningPoint[] => {
  const width = Math.max(1, Math.floor(window) || DEFAULT_CURVE_WINDOW);

  // Chronological by decision time, the order the agent actually experienced.
  const ordered = incidents
    .filter(isResolved)
    .sort((a, b) => (a.createdAt - b.createdAt) || a.id.localeCompare(b.id));

  const n = ordered.length;
  if (n < MIN_WINDOW_SAMPLES) return [];

  // Cumulative memory-size proxies, advanced one incident at a time.
  const cells = new Set<string>();
  const rules = new Set<string>();
  const cellCountAt: number[] = new Array(n);
  const ruleCountAt: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const inc = ordered[i]!;
    const { siteId, zoneId, type, ts } = inc.event;
    const bucket = hourBucketOf(ts);
    cells.add(calibrationKey(siteId, zoneId, type, bucket));   // exact
    cells.add(calibrationKey(siteId, zoneId, type, null));     // zone_type backoff
    cells.add(calibrationKey(siteId, null, type, null));       // site_type backoff
    for (const ev of inc.decision?.evidence ?? []) {
      if (ev.kind === 'playbook') rules.add(ev.refId);
    }
    cellCountAt[i] = cells.size;
    ruleCountAt[i] = rules.size;
  }

  const firstIndex = Math.min(width, MIN_WINDOW_SAMPLES) - 1;
  const stride = Math.max(1, Math.ceil((n - firstIndex) / MAX_CURVE_POINTS));

  const points: LearningPoint[] = [];
  const emit = (i: number): void => {
    const slice = ordered.slice(Math.max(0, i - width + 1), i + 1);
    const m = computeMetrics({ incidents: slice });
    const inc = ordered[i]!;
    points.push({
      incidentIndex: i + 1,
      ts: inc.resolvedAt ?? inc.createdAt,
      falseDispatchRate: m.falseDispatchRate,
      missedCriticalRate: m.missedCriticalRate,
      operatorAgreementRate: m.operatorAgreementRate,
      dispatchScore: m.dispatchScore,
      calibrationCells: cellCountAt[i]!,
      activeRules: ruleCountAt[i]!,
    });
  };

  for (let i = firstIndex; i < n; i += stride) emit(i);
  // Always anchor the curve on the latest data point.
  if (points.length === 0 || points[points.length - 1]!.incidentIndex !== n) emit(n - 1);

  return points;
};

/** learned − static, for every numeric field of Metrics. */
export function metricDelta(learned: Metrics, baseline: Metrics): Partial<Record<keyof Metrics, number>> {
  const out: Partial<Record<keyof Metrics, number>> = {};
  for (const key of Object.keys(learned) as Array<keyof Metrics>) {
    out[key] = round(learned[key] - baseline[key], 4);
  }
  return out;
}

/** True when a lower value of this metric is the better outcome. */
export const LOWER_IS_BETTER: ReadonlySet<keyof Metrics> = new Set<keyof Metrics>([
  'falseDispatchRate', 'missedCriticalRate', 'medianDecisionLatencyMs', 'medianResponseMs',
]);
