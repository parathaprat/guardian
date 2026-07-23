/**
 * The physical portfolio and its hidden structure. Topology (sites, zones,
 * adjacency, rosters, ids) is constant across seeds, REGULARITIES reference
 * concrete ids and the eval compares runs by seed. Only per-responder truth is seeded.
 */

import type {
  EventType, Guard, Robot, Site, Skill, Zone, ZoneKind,
} from '../../shared/types';
import { inHourRange } from '../../shared/types';
import type { WorldState } from '../contracts';
import type { Rng } from '../util/rng';

// ─────────────────────────────────────────────────────────────────────────────
//  SITES, bounds tile the 0..1 canvas exactly, no overlap
// ─────────────────────────────────────────────────────────────────────────────

const SITES: Site[] = [
  {
    id: 'hbv',
    name: 'Harborview Logistics Center',
    code: 'HBV',
    address: '2400 Terminal Way, Harborview District',
    bounds: { x: 0, y: 0, w: 0.52, h: 1 },
  },
  {
    id: 'mcr',
    name: 'Mercer Tower',
    code: 'MCR',
    address: '811 Mercer Street, Financial Core',
    bounds: { x: 0.52, y: 0, w: 0.48, h: 0.55 },
  },
  {
    id: 'ngt',
    name: 'Northgate Retail Plaza',
    code: 'NGT',
    address: '15 Northgate Mall Drive',
    bounds: { x: 0.52, y: 0.55, w: 0.48, h: 0.45 },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
//  ZONES, x/y are site-local 0..1, laid out as a plausible plan
// ─────────────────────────────────────────────────────────────────────────────

interface ZoneSpec {
  id: string;
  siteId: string;
  name: string;
  code: string;
  kind: ZoneKind;
  x: number;
  y: number;
  baseRisk: number;
}

const ZONE_SPECS: ZoneSpec[] = [
  { id: 'hbv-gate-north', siteId: 'hbv', name: 'North Gate', code: 'G-1', kind: 'perimeter', x: 0.50, y: 0.07, baseRisk: 0.46 },
  { id: 'hbv-perimeter-west', siteId: 'hbv', name: 'Perimeter West', code: 'PW', kind: 'perimeter', x: 0.07, y: 0.46, baseRisk: 0.58 },
  { id: 'hbv-dock-1', siteId: 'hbv', name: 'Dock D-1', code: 'D-1', kind: 'loading_dock', x: 0.30, y: 0.33, baseRisk: 0.42 },
  { id: 'hbv-dock-3', siteId: 'hbv', name: 'Dock D-3', code: 'D-3', kind: 'loading_dock', x: 0.60, y: 0.33, baseRisk: 0.38 },
  { id: 'hbv-yard-2', siteId: 'hbv', name: 'Yard Lot Y-2', code: 'Y-2', kind: 'parking', x: 0.86, y: 0.55, baseRisk: 0.52 },
  { id: 'hbv-utility-1', siteId: 'hbv', name: 'Utility Corridor U-1', code: 'U-1', kind: 'utility', x: 0.46, y: 0.62, baseRisk: 0.24 },
  { id: 'hbv-lobby-2', siteId: 'hbv', name: 'Admin Lobby L-2', code: 'L-2', kind: 'lobby', x: 0.28, y: 0.88, baseRisk: 0.22 },

  { id: 'mcr-roof-1', siteId: 'mcr', name: 'Roof R-1', code: 'R-1', kind: 'roof', x: 0.50, y: 0.08, baseRisk: 0.40 },
  { id: 'mcr-server-s2', siteId: 'mcr', name: 'Server Room S-2', code: 'S-2', kind: 'server_room', x: 0.44, y: 0.40, baseRisk: 0.66 },
  { id: 'mcr-stair-a', siteId: 'mcr', name: 'Stairwell A', code: 'SW-A', kind: 'stairwell', x: 0.76, y: 0.46, baseRisk: 0.30 },
  { id: 'mcr-lobby-1', siteId: 'mcr', name: 'Lobby L-1', code: 'L-1', kind: 'lobby', x: 0.50, y: 0.76, baseRisk: 0.30 },
  { id: 'mcr-deck-p2', siteId: 'mcr', name: 'Deck P-2', code: 'P-2', kind: 'parking', x: 0.20, y: 0.62, baseRisk: 0.46 },
  { id: 'mcr-dock-b', siteId: 'mcr', name: 'Service Dock B', code: 'SD-B', kind: 'loading_dock', x: 0.14, y: 0.92, baseRisk: 0.36 },

  { id: 'ngt-dock-c', siteId: 'ngt', name: 'Dock C-2', code: 'C-2', kind: 'loading_dock', x: 0.12, y: 0.18, baseRisk: 0.38 },
  { id: 'ngt-floor-north', siteId: 'ngt', name: 'Retail Floor North', code: 'RF-N', kind: 'retail_floor', x: 0.36, y: 0.32, baseRisk: 0.34 },
  { id: 'ngt-atrium', siteId: 'ngt', name: 'Atrium Entrance', code: 'A-1', kind: 'lobby', x: 0.56, y: 0.52, baseRisk: 0.28 },
  { id: 'ngt-floor-south', siteId: 'ngt', name: 'Retail Floor South', code: 'RF-S', kind: 'retail_floor', x: 0.36, y: 0.74, baseRisk: 0.36 },
  { id: 'ngt-lot-east', siteId: 'ngt', name: 'Lot East', code: 'PL-E', kind: 'parking', x: 0.84, y: 0.56, baseRisk: 0.48 },
];

/** Undirected physical adjacency. Wired symmetrically at build time. */
const ADJACENCY: Array<[string, string]> = [
  ['hbv-gate-north', 'hbv-perimeter-west'],
  ['hbv-gate-north', 'hbv-dock-1'],
  ['hbv-gate-north', 'hbv-dock-3'],
  ['hbv-gate-north', 'hbv-yard-2'],
  ['hbv-dock-1', 'hbv-dock-3'],
  ['hbv-dock-1', 'hbv-perimeter-west'],
  ['hbv-dock-1', 'hbv-utility-1'],
  ['hbv-dock-3', 'hbv-utility-1'],
  ['hbv-dock-3', 'hbv-yard-2'],
  ['hbv-utility-1', 'hbv-lobby-2'],
  ['hbv-perimeter-west', 'hbv-lobby-2'],

  ['mcr-roof-1', 'mcr-stair-a'],
  ['mcr-server-s2', 'mcr-stair-a'],
  ['mcr-stair-a', 'mcr-lobby-1'],
  ['mcr-stair-a', 'mcr-deck-p2'],
  ['mcr-lobby-1', 'mcr-deck-p2'],
  ['mcr-lobby-1', 'mcr-dock-b'],
  ['mcr-deck-p2', 'mcr-dock-b'],

  ['ngt-dock-c', 'ngt-floor-north'],
  ['ngt-floor-north', 'ngt-atrium'],
  ['ngt-floor-north', 'ngt-floor-south'],
  ['ngt-floor-south', 'ngt-atrium'],
  ['ngt-atrium', 'ngt-lot-east'],
  ['ngt-floor-south', 'ngt-lot-east'],
];

export const LOADING_DOCK_ZONE_IDS: string[] = ZONE_SPECS
  .filter((z) => z.kind === 'loading_dock')
  .map((z) => z.id);

/** The robot whose camera analytic is failing. Referenced by REGULARITIES. */
export const DEGRADED_ROBOT_ID = 'rbt-mcr-04';

// ─────────────────────────────────────────────────────────────────────────────
//  ROSTER
// ─────────────────────────────────────────────────────────────────────────────

interface GuardSpec {
  id: string;
  name: string;
  badge: string;
  siteId: string;
  homeZoneId: string;
  skills: Skill[];
  shift: { start: number; end: number };
  /** Nominal hidden truth; buildWorld jitters each by seed. */
  accept: number;
  speed: number;
  thorough: number;
}

const GUARD_SPECS: GuardSpec[] = [
  { id: 'grd-hbv-01', name: 'Marcus Delgado', badge: 'HBV-114', siteId: 'hbv', homeZoneId: 'hbv-dock-1', skills: ['armed', 'access_control'], shift: { start: 6, end: 14 }, accept: 0.94, speed: 0.88, thorough: 0.88 },
  { id: 'grd-hbv-02', name: 'Sofia Marchetti', badge: 'HBV-142', siteId: 'hbv', homeZoneId: 'hbv-lobby-2', skills: ['medical', 'de_escalation'], shift: { start: 6, end: 14 }, accept: 0.88, speed: 1.02, thorough: 0.91 },
  { id: 'grd-hbv-03', name: 'Priya Raman', badge: 'HBV-127', siteId: 'hbv', homeZoneId: 'hbv-lobby-2', skills: ['access_control', 'technical'], shift: { start: 14, end: 22 }, accept: 0.82, speed: 1.10, thorough: 0.84 },
  { id: 'grd-hbv-04', name: 'Rey Villanueva', badge: 'HBV-158', siteId: 'hbv', homeZoneId: 'hbv-gate-north', skills: ['armed', 'fire'], shift: { start: 14, end: 22 }, accept: 0.71, speed: 0.95, thorough: 0.76 },
  { id: 'grd-hbv-05', name: 'Dennis Okafor', badge: 'HBV-131', siteId: 'hbv', homeZoneId: 'hbv-perimeter-west', skills: ['armed', 'k9'], shift: { start: 22, end: 6 }, accept: 0.96, speed: 0.82, thorough: 0.80 },

  { id: 'grd-mcr-01', name: 'Nadia Osei', badge: 'MCR-203', siteId: 'mcr', homeZoneId: 'mcr-lobby-1', skills: ['de_escalation', 'access_control'], shift: { start: 7, end: 15 }, accept: 0.90, speed: 0.97, thorough: 0.89 },
  // Deliberately awkward: rarely takes a call and is slow when he does, but is
  // the best resolver on the roster. The bandit has to earn that trade-off.
  { id: 'grd-mcr-02', name: 'Idris Karim', badge: 'MCR-224', siteId: 'mcr', homeZoneId: 'mcr-server-s2', skills: ['technical', 'access_control'], shift: { start: 9, end: 17 }, accept: 0.58, speed: 1.28, thorough: 0.93 },
  { id: 'grd-mcr-03', name: 'Tomas Brandt', badge: 'MCR-211', siteId: 'mcr', homeZoneId: 'mcr-stair-a', skills: ['armed', 'technical'], shift: { start: 15, end: 23 }, accept: 0.86, speed: 0.90, thorough: 0.78 },
  { id: 'grd-mcr-04', name: 'Grace Lindqvist', badge: 'MCR-218', siteId: 'mcr', homeZoneId: 'mcr-lobby-1', skills: ['medical', 'fire'], shift: { start: 23, end: 7 }, accept: 0.93, speed: 0.86, thorough: 0.90 },

  { id: 'grd-ngt-01', name: 'June Ferreira', badge: 'NGT-302', siteId: 'ngt', homeZoneId: 'ngt-atrium', skills: ['de_escalation', 'medical'], shift: { start: 10, end: 18 }, accept: 0.84, speed: 1.05, thorough: 0.82 },
  { id: 'grd-ngt-02', name: 'Walter Boakye', badge: 'NGT-309', siteId: 'ngt', homeZoneId: 'ngt-floor-south', skills: ['armed', 'de_escalation'], shift: { start: 14, end: 22 }, accept: 0.77, speed: 1.18, thorough: 0.69 },
  { id: 'grd-ngt-03', name: 'Elena Vasquez', badge: 'NGT-317', siteId: 'ngt', homeZoneId: 'ngt-lot-east', skills: ['access_control', 'armed'], shift: { start: 22, end: 6 }, accept: 0.91, speed: 0.84, thorough: 0.86 },
];

interface RobotSpec {
  id: string;
  name: string;
  model: string;
  siteId: string;
  patrolZoneIds: string[];
  falsePositiveRate: number;
  degradedSensor: EventType | null;
}

const ROBOT_SPECS: RobotSpec[] = [
  { id: 'rbt-hbv-01', name: 'Ranger-01', model: 'Cobalt R2', siteId: 'hbv', patrolZoneIds: ['hbv-perimeter-west', 'hbv-gate-north', 'hbv-yard-2'], falsePositiveRate: 0.34, degradedSensor: null },
  { id: 'rbt-hbv-02', name: 'Ranger-02', model: 'Cobalt R2', siteId: 'hbv', patrolZoneIds: ['hbv-dock-1', 'hbv-dock-3', 'hbv-utility-1'], falsePositiveRate: 0.29, degradedSensor: null },
  { id: DEGRADED_ROBOT_ID, name: 'Sentinel-04', model: 'Knightscope K5', siteId: 'mcr', patrolZoneIds: ['mcr-lobby-1', 'mcr-deck-p2', 'mcr-stair-a'], falsePositiveRate: 0.64, degradedSensor: 'glass_break' },
  { id: 'rbt-mcr-05', name: 'Sentinel-05', model: 'Knightscope K5', siteId: 'mcr', patrolZoneIds: ['mcr-server-s2', 'mcr-stair-a', 'mcr-roof-1'], falsePositiveRate: 0.21, degradedSensor: null },
  { id: 'rbt-ngt-07', name: 'Vector-07', model: 'Ascento Guard', siteId: 'ngt', patrolZoneIds: ['ngt-floor-north', 'ngt-atrium', 'ngt-floor-south', 'ngt-lot-east'], falsePositiveRate: 0.41, degradedSensor: null },
];

// ─────────────────────────────────────────────────────────────────────────────
//  REGULARITIES, the latent structure the agent has to discover
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A hidden rule of the world. NEVER serialise these into a prompt, snapshot, or
 * tool result, the experiment is whether the agent can recover them from
 * resolved outcomes alone. `note` is surfaced in the UI only after resolution.
 */
export interface Regularity {
  id: string;
  label: string;
  zoneId: string | null;
  siteId: string | null;
  types: EventType[];
  hourRange: { start: number; end: number } | null;
  sourceId: string | null;
  pReal: number;
  severityBias: number;
  note: string;
}

/** Sampling weight, how heavily the generator biases the stream toward this pattern. */
type WeightedRegularity = Regularity & { weight: number };

const DOCK_NAME: Record<string, string> = Object.fromEntries(
  ZONE_SPECS.filter((z) => z.kind === 'loading_dock').map((z) => [z.id, `${z.name} (${SITES.find((s) => s.id === z.siteId)?.code ?? ''})`]),
);

/**
 * Ordered MOST SPECIFIC FIRST, `matchRegularity` takes the first hit, so a
 * zone+hour rule always beats a site-wide or global one.
 */
const SPECS: WeightedRegularity[] = [
  {
    id: 'reg_hbv_d3_hvac',
    label: 'Dock D-3 pre-dawn HVAC nuisance',
    zoneId: 'hbv-dock-3', siteId: 'hbv',
    types: ['motion_detected'],
    hourRange: { start: 2, end: 4.5 },
    sourceId: null,
    pReal: 0.08, severityBias: -1, weight: 9,
    note: 'HVAC vent cycle at Dock D-3, the rooftop unit dumps air across the aisle PIR every twenty minutes between 02:00 and 04:30. Recurring nuisance alarm.',
  },
  {
    id: 'reg_mcr_r04_glass',
    label: 'Sentinel-04 degraded glass-break analytic',
    zoneId: null, siteId: 'mcr',
    types: ['glass_break'],
    hourRange: null,
    sourceId: DEGRADED_ROBOT_ID,
    pReal: 0.12, severityBias: -1, weight: 6,
    note: 'Sentinel-04\'s forward camera housing is fogged and its acoustic gate is out of calibration; its glass-break analytic fires on lift chimes and rolling luggage.',
  },
  {
    id: 'reg_mcr_lobby_shiftchange',
    label: 'Lobby L-1 morning shift change',
    zoneId: 'mcr-lobby-1', siteId: 'mcr',
    types: ['tailgating'],
    hourRange: { start: 8, end: 9.5 },
    sourceId: null,
    pReal: 0.15, severityBias: -1, weight: 8,
    note: 'Shift-change crush in Lobby L-1, tenants hold the speedgate for colleagues between 08:00 and 09:30. Benign, and building management has signed off on it.',
  },
  // 4a/4b are the point of hour-bucketed calibration: same zone, same type, and
  // only the hour decides whether it is routine or a break-in.
  ...LOADING_DOCK_ZONE_IDS.map<WeightedRegularity>((zoneId) => ({
    id: `reg_dock_propped_delivery_${zoneId}`,
    label: `${DOCK_NAME[zoneId]} delivery-window propped door`,
    zoneId, siteId: ZONE_SPECS.find((z) => z.id === zoneId)?.siteId ?? null,
    types: ['door_propped'],
    hourRange: { start: 6, end: 8 },
    sourceId: null,
    pReal: 0.10, severityBias: -1, weight: 5,
    note: `Inbound delivery window at ${DOCK_NAME[zoneId]}, receiving chocks the roll-up door open from 06:00 to 08:00 while pallets are cross-docked.`,
  })),
  ...LOADING_DOCK_ZONE_IDS.map<WeightedRegularity>((zoneId) => ({
    id: `reg_dock_propped_offhours_${zoneId}`,
    label: `${DOCK_NAME[zoneId]} propped door outside deliveries`,
    zoneId, siteId: ZONE_SPECS.find((z) => z.id === zoneId)?.siteId ?? null,
    types: ['door_propped'],
    hourRange: { start: 8, end: 6 },
    sourceId: null,
    pReal: 0.75, severityBias: 1, weight: 3,
    note: `A dock door held open at ${DOCK_NAME[zoneId]} outside the 06:00–08:00 receiving window is someone defeating the lock, usually a contractor, occasionally not.`,
  })),
  {
    id: 'reg_mcr_s2_afterhours',
    label: 'Server Room S-2 after-hours access',
    zoneId: 'mcr-server-s2', siteId: 'mcr',
    types: ['badge_anomaly', 'door_forced'],
    hourRange: { start: 22, end: 5 },
    sourceId: null,
    pReal: 0.88, severityBias: 1, weight: 3,
    note: 'Change windows for Server Room S-2 are scheduled 10:00–16:00 only; anything touching that door after 22:00 is genuinely unauthorised.',
  },
  {
    id: 'reg_hbv_pw_wildlife',
    label: 'Perimeter West tideflat wildlife',
    zoneId: 'hbv-perimeter-west', siteId: 'hbv',
    types: ['motion_detected', 'perimeter_breach'],
    hourRange: { start: 21, end: 5 },
    sourceId: null,
    pReal: 0.22, severityBias: -1, weight: 6,
    note: 'Perimeter West faces open tideflat; raccoons and deer walk the fence line nightly and trip the taut-wire and PIR array. Night is usually a real-alarm multiplier, this zone is the exception.',
  },
  {
    id: 'reg_hbv_y2_obstruction',
    label: 'Yard Lot Y-2 robot obstruction',
    zoneId: 'hbv-yard-2', siteId: 'hbv',
    types: ['robot_obstruction'],
    hourRange: null,
    sourceId: null,
    pReal: 0.15, severityBias: -1, weight: 4,
    note: 'Pallet wrap, trailer chocks and standing water in Yard Lot Y-2 stall the patrol robot. Almost never a person blocking it.',
  },
  {
    id: 'reg_mcr_p2_afterhours_vehicle',
    label: 'Deck P-2 after-hours vehicle',
    zoneId: 'mcr-deck-p2', siteId: 'mcr',
    types: ['vehicle_unauthorized'],
    hourRange: { start: 19, end: 5 },
    sourceId: null,
    pReal: 0.72, severityBias: 1, weight: 3,
    note: 'Deck P-2 is badge-gated from 19:00; a vehicle inside it overnight tailgated the gate arm and is genuinely unauthorised.',
  },
  {
    id: 'reg_ngt_evening_theft',
    label: 'Northgate evening package theft',
    zoneId: null, siteId: 'ngt',
    types: ['package_theft'],
    hourRange: { start: 17, end: 22 },
    sourceId: null,
    pReal: 0.86, severityBias: 0, weight: 7,
    note: 'Northgate\'s organised-retail-crime window: crews work the plaza between 17:00 and close, when floor staffing thins out and the lot is full enough to disappear into.',
  },
  {
    id: 'reg_camera_maintenance',
    label: 'Overnight camera firmware push',
    zoneId: null, siteId: null,
    types: ['camera_offline'],
    hourRange: { start: 1, end: 3 },
    sourceId: null,
    pReal: 0.12, severityBias: -1, weight: 4,
    note: 'Fleet-wide camera firmware push runs 01:00–03:00 and reboots devices site by site. Streams drop for 40–90 seconds and come back on their own.',
  },
  {
    id: 'reg_life_safety',
    label: 'Life-safety signals are real',
    zoneId: null, siteId: null,
    types: ['panic_button', 'person_down', 'fire_alarm'],
    hourRange: null,
    sourceId: null,
    pReal: 0.94, severityBias: 1, weight: 5,
    note: 'Life-safety channel, a pulled panic station, a body on the floor or a panel in alarm is a person in trouble until proven otherwise.',
  },
];

export const REGULARITIES: Regularity[] = SPECS;

/** How heavily the generator oversamples each pattern. Simulator-internal. */
export const REGULARITY_WEIGHTS: ReadonlyMap<string, number> = new Map(
  SPECS.map((s) => [s.id, s.weight]),
);

/** First (most specific) regularity covering this observation, or null. */
export function matchRegularity(args: {
  siteId: string;
  zoneId: string;
  type: EventType;
  hour: number;
  sourceId: string | null;
}): Regularity | null {
  for (const r of REGULARITIES) {
    if (r.siteId !== null && r.siteId !== args.siteId) continue;
    if (r.zoneId !== null && r.zoneId !== args.zoneId) continue;
    if (r.sourceId !== null && r.sourceId !== args.sourceId) continue;
    if (!r.types.includes(args.type)) continue;
    if (r.hourRange !== null && !inHourRange(args.hour, r.hourRange)) continue;
    return r;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  BUILD
// ─────────────────────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function buildWorld(rng: Rng): WorldState {
  const adj = new Map<string, string[]>();
  for (const z of ZONE_SPECS) adj.set(z.id, []);
  for (const [a, b] of ADJACENCY) {
    adj.get(a)?.push(b);
    adj.get(b)?.push(a);
  }

  const sites: Site[] = SITES.map((s) => ({ ...s, bounds: { ...s.bounds } }));
  const zones: Zone[] = ZONE_SPECS.map((z) => ({
    id: z.id,
    siteId: z.siteId,
    name: z.name,
    code: z.code,
    kind: z.kind,
    x: z.x,
    y: z.y,
    adjacent: (adj.get(z.id) ?? []).slice(),
    baseRisk: z.baseRisk,
  }));

  const gRng = rng.fork('guards');
  const guards: Guard[] = GUARD_SPECS.map((g) => ({
    kind: 'guard',
    id: g.id,
    name: g.name,
    badge: g.badge,
    siteId: g.siteId,
    homeZoneId: g.homeZoneId,
    skills: g.skills.slice(),
    shift: { ...g.shift },
    status: 'available',
    currentZoneId: g.homeZoneId,
    assignedIncidentId: null,
    truth: {
      acceptRate: clamp(g.accept + gRng.gauss(0, 0.05), 0.25, 0.99),
      speedFactor: clamp(g.speed + gRng.gauss(0, 0.07), 0.6, 1.8),
      thoroughness: clamp(g.thorough + gRng.gauss(0, 0.05), 0.4, 0.99),
    },
  }));

  const rRng = rng.fork('robots');
  const robots: Robot[] = ROBOT_SPECS.map((r) => ({
    kind: 'robot',
    id: r.id,
    name: r.name,
    model: r.model,
    siteId: r.siteId,
    patrolZoneIds: r.patrolZoneIds.slice(),
    currentZoneId: rRng.pick(r.patrolZoneIds),
    batteryPct: rRng.int(48, 100),
    status: 'available',
    truth: {
      // The degraded unit's rate is fixed, reg_mcr_r04_glass depends on it.
      falsePositiveRate: r.degradedSensor
        ? r.falsePositiveRate
        : clamp(r.falsePositiveRate + rRng.gauss(0, 0.04), 0.08, 0.85),
      degradedSensor: r.degradedSensor,
    },
  }));

  const zoneById = new Map(zones.map((z) => [z.id, z]));
  const siteById = new Map(sites.map((s) => [s.id, s]));
  const responderById = new Map<string, Guard | Robot>();
  for (const g of guards) responderById.set(g.id, g);
  for (const r of robots) responderById.set(r.id, r);

  return { sites, zones, guards, robots, zoneById, siteById, responderById };
}
