/**
 * CHANNEL A. Bayesian calibration.
 *
 * Beta-Bernoulli posteriors over P(event is real), maintained at three
 * granularities simultaneously. Every observation folds into all three, so the
 * coarse levels stay usable as a backoff target while the fine level is still
 * data-starved.
 */

import type {
  CalibrationCell, CalibrationKey, CalibrationLookup, EventType, SimTime,
} from '../../shared/types';
import { calibrationKey, hourBucketOf } from '../../shared/types';
import type { CalibrationStore } from '../contracts';

/** Prior P(real) per type, deliberately miscalibrated so observation has to move it. */
const TYPE_PRIOR: Record<EventType, number> = {
  motion_detected: 0.14,
  door_forced: 0.58,
  door_propped: 0.34,
  glass_break: 0.46,
  tailgating: 0.30,
  loitering: 0.22,
  person_down: 0.62,
  fire_alarm: 0.26,
  vehicle_unauthorized: 0.30,
  perimeter_breach: 0.42,
  robot_obstruction: 0.48,
  camera_offline: 0.64,
  panic_button: 0.52,
  badge_anomaly: 0.34,
  package_theft: 0.38,
  noise_complaint: 0.28,
};

const FALLBACK_PRIOR = 0.35;

/**
 * Prior concentration (pseudo-count). alpha0=k·p, beta0=k·(1-p) keeps the
 * prior mean at the type prior instead of dragging it toward 0.5 like an
 * additive Beta(1,1) would; kept weak (~3) so real observations move it fast.
 */
const PRIOR_CONCENTRATION = 3.2;
/** Floor on each shape so an extreme prior can't produce a U-shaped Beta. */
const MIN_SHAPE = 0.4;

/** Minimum real observations before a backoff level is trusted to answer. */
const MIN_OBS_EXACT = 4;
const MIN_OBS_ZONE = 3;
const MIN_OBS_SITE = 1;

const Z95 = 1.96;

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

function priorFor(type: EventType): number {
  return TYPE_PRIOR[type] ?? FALLBACK_PRIOR;
}

/** Posterior mean + 95% credible half-width (normal approximation to Beta). */
function refresh(cell: CalibrationCell): void {
  const n = cell.alpha + cell.beta;
  const mean = cell.alpha / n;
  const variance = (cell.alpha * cell.beta) / (n * n * (n + 1));
  cell.pReal = round4(mean);
  cell.uncertainty = round4(Math.min(Z95 * Math.sqrt(variance), 0.5));
}

export class Calibration implements CalibrationStore {
  private map = new Map<CalibrationKey, CalibrationCell>();

  lookup(siteId: string, zoneId: string, type: EventType, ts: SimTime): CalibrationLookup {
    const bucket = hourBucketOf(ts);

    const exact = this.map.get(calibrationKey(siteId, zoneId, type, bucket));
    if (exact && exact.observations >= MIN_OBS_EXACT) return asLookup(exact, 'exact');

    const zoneType = this.map.get(calibrationKey(siteId, zoneId, type, null));
    if (zoneType && zoneType.observations >= MIN_OBS_ZONE) return asLookup(zoneType, 'zone_type');

    const siteType = this.map.get(calibrationKey(siteId, null, type, null));
    if (siteType && siteType.observations >= MIN_OBS_SITE) return asLookup(siteType, 'site_type');

    // Nothing known. Answer from the type prior without materialising a cell,
    // lookups must never pollute the grid the UI renders.
    const p = priorFor(type);
    const alpha = 1 + PRIOR_CONCENTRATION * p;
    const beta = 1 + PRIOR_CONCENTRATION * (1 - p);
    const n = alpha + beta;
    const sd = Math.sqrt((alpha * beta) / (n * n * (n + 1)));
    return {
      pReal: round4(alpha / n),
      uncertainty: round4(Math.min(Z95 * sd, 0.5)),
      observations: 0,
      level: 'prior',
      key: calibrationKey(siteId, null, type, null),
    };
  }

  observe(siteId: string, zoneId: string, type: EventType, ts: SimTime, wasReal: boolean): void {
    const bucket = hourBucketOf(ts);
    this.bump(siteId, zoneId, type, bucket, ts, wasReal);
    this.bump(siteId, zoneId, type, null, ts, wasReal);
    this.bump(siteId, null, type, null, ts, wasReal);
  }

  cells(): CalibrationCell[] {
    return [...this.map.values()]
      .map((c) => ({ ...c }))
      .sort(compareCells);
  }

  size(): number {
    return this.map.size;
  }

  reset(): void {
    this.map.clear();
  }

  /** Replace every cell. Copies on the way in so the caller cannot mutate us. */
  restore(cells: CalibrationCell[]): void {
    this.map.clear();
    for (const c of cells) this.map.set(c.key, { ...c });
  }

  private bump(
    siteId: string,
    zoneId: string | null,
    type: EventType,
    hourBucket: number | null,
    ts: SimTime,
    wasReal: boolean,
  ): void {
    const key = calibrationKey(siteId, zoneId, type, hourBucket);
    let cell = this.map.get(key);
    if (!cell) {
      const p = priorFor(type);
      cell = {
        key,
        siteId,
        zoneId,
        type,
        hourBucket,
        alpha: 1 + PRIOR_CONCENTRATION * p,
        beta: 1 + PRIOR_CONCENTRATION * (1 - p),
        observations: 0,
        lastUpdated: ts,
        pReal: 0,
        uncertainty: 0,
      };
      this.map.set(key, cell);
    }
    if (wasReal) cell.alpha += 1;
    else cell.beta += 1;
    cell.observations += 1;
    cell.lastUpdated = ts;
    refresh(cell);
  }
}

function asLookup(cell: CalibrationCell, level: CalibrationLookup['level']): CalibrationLookup {
  return {
    pReal: cell.pReal,
    uncertainty: cell.uncertainty,
    observations: cell.observations,
    level,
    key: cell.key,
  };
}

/** Stable render order: site, then zone (backoff rows last), type, hour bucket. */
function compareCells(a: CalibrationCell, b: CalibrationCell): number {
  if (a.siteId !== b.siteId) return a.siteId < b.siteId ? -1 : 1;
  const az = a.zoneId ?? '￿';
  const bz = b.zoneId ?? '￿';
  if (az !== bz) return az < bz ? -1 : 1;
  if (a.type !== b.type) return a.type < b.type ? -1 : 1;
  const ab = a.hourBucket ?? 99;
  const bb = b.hourBucket ?? 99;
  return ab - bb;
}
