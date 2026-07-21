/**
 * SENTRY — shared domain contract.
 *
 * This file is the single source of truth for every type crossing a module
 * boundary (simulator ↔ agent ↔ memory ↔ API ↔ UI). Server and browser both
 * import from here. Keep it dependency-free.
 */

// ─────────────────────────────────────────────────────────────────────────────
//  PRIMITIVES
// ─────────────────────────────────────────────────────────────────────────────

/** Simulated wall-clock, ms since epoch. The world runs on its own clock. */
export type SimTime = number;

export type Priority = 'P0' | 'P1' | 'P2' | 'P3';

/** 1 = nuisance, 5 = life-safety. */
export type Severity = 1 | 2 | 3 | 4 | 5;

export const PRIORITY_ORDER: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

export type Skill =
  | 'armed'
  | 'medical'
  | 'fire'
  | 'access_control'
  | 'k9'
  | 'de_escalation'
  | 'technical';

export type ZoneKind =
  | 'perimeter'
  | 'loading_dock'
  | 'lobby'
  | 'parking'
  | 'server_room'
  | 'retail_floor'
  | 'roof'
  | 'stairwell'
  | 'utility';

export type EventType =
  | 'motion_detected'
  | 'door_forced'
  | 'door_propped'
  | 'glass_break'
  | 'tailgating'
  | 'loitering'
  | 'person_down'
  | 'fire_alarm'
  | 'vehicle_unauthorized'
  | 'perimeter_breach'
  | 'robot_obstruction'
  | 'camera_offline'
  | 'panic_button'
  | 'badge_anomaly'
  | 'package_theft'
  | 'noise_complaint';

export const ALL_EVENT_TYPES: EventType[] = [
  'motion_detected', 'door_forced', 'door_propped', 'glass_break', 'tailgating',
  'loitering', 'person_down', 'fire_alarm', 'vehicle_unauthorized', 'perimeter_breach',
  'robot_obstruction', 'camera_offline', 'panic_button', 'badge_anomaly',
  'package_theft', 'noise_complaint',
];

export type SourceKind = 'robot' | 'fixed_sensor' | 'guard_report' | 'access_control' | 'tenant_call';

// ─────────────────────────────────────────────────────────────────────────────
//  WORLD — sites, zones, responders
// ─────────────────────────────────────────────────────────────────────────────

export interface Site {
  id: string;
  name: string;
  code: string;          // short display code, e.g. "HBV"
  address: string;
  /** Normalised 0..1 layout box for the map view. */
  bounds: { x: number; y: number; w: number; h: number };
}

export interface Zone {
  id: string;
  siteId: string;
  name: string;
  code: string;          // e.g. "D-3"
  kind: ZoneKind;
  /** Normalised 0..1 position within the site's bounds. */
  x: number;
  y: number;
  /** Zone ids reachable in one hop — used by `correlate` to detect movement. */
  adjacent: string[];
  /** Static risk weight 0..1, part of the *prior*, not the learned posterior. */
  baseRisk: number;
}

export type ResponderStatus =
  | 'available'
  | 'enroute'
  | 'on_scene'
  | 'busy'
  | 'break'
  | 'off_shift'
  | 'offline';

export interface Guard {
  kind: 'guard';
  id: string;
  name: string;
  badge: string;
  siteId: string;
  homeZoneId: string;
  skills: Skill[];
  /** Shift window in sim hours [start, end); may wrap past midnight. */
  shift: { start: number; end: number };
  status: ResponderStatus;
  currentZoneId: string;
  assignedIncidentId: string | null;
  /**
   * GROUND TRUTH — never exposed to the agent. The responder model has to
   * *learn* these from observed outcomes. Leaking these into a prompt would
   * invalidate the whole experiment.
   */
  truth: {
    acceptRate: number;      // 0..1 probability of accepting a dispatch
    speedFactor: number;     // 1.0 = nominal travel time; <1 faster
    thoroughness: number;    // 0..1 chance of correctly resolving on first pass
  };
}

export interface Robot {
  kind: 'robot';
  id: string;
  name: string;
  model: string;
  siteId: string;
  patrolZoneIds: string[];
  currentZoneId: string;
  batteryPct: number;
  status: ResponderStatus;
  /** GROUND TRUTH — sensor quality. Drives the false-alarm regularities. */
  truth: {
    falsePositiveRate: number;
    degradedSensor: EventType | null;
  };
}

export type Responder = Guard | Robot;

// ─────────────────────────────────────────────────────────────────────────────
//  EVENTS
// ─────────────────────────────────────────────────────────────────────────────

/** Hidden ground truth attached to every generated event. Stripped before the agent sees it. */
export interface EventTruth {
  isReal: boolean;
  trueSeverity: Severity;
  requiredSkill: Skill | null;
  /** ms after which an ignored real incident escalates (severity +1). */
  escalatesAfterMs: number;
  /** Human-readable reason this event is real / false — powers the "ground truth" reveal. */
  explanation: string;
  /** If this event belongs to a coordinated multi-event pattern, its id. */
  patternId: string | null;
}

/** What the agent actually sees. */
export interface SecurityEvent {
  id: string;
  ts: SimTime;
  siteId: string;
  zoneId: string;
  type: EventType;
  sourceKind: SourceKind;
  sourceId: string;             // robot id, sensor id, or guard id
  /** Raw sensor/observer text, as it would arrive over the wire. */
  description: string;
  /** Device-reported confidence 0..1 — noisy, and deliberately miscalibrated. */
  sensorConfidence: number;
  metadata: Record<string, string | number | boolean>;
}

/** Server-internal: event + its hidden truth. Never serialised to the client until resolution. */
export interface SeededEvent {
  event: SecurityEvent;
  truth: EventTruth;
}

// ─────────────────────────────────────────────────────────────────────────────
//  AGENT REASONING TRACE  (the "show its thinking" surface)
// ─────────────────────────────────────────────────────────────────────────────

export type TraceStepKind = 'thinking' | 'tool_call' | 'tool_result' | 'decision' | 'error';

export interface TraceStep {
  id: string;
  index: number;
  kind: TraceStepKind;
  /** Wall-clock ms this step took. */
  durationMs: number;
  /** For `thinking`: the summarized reasoning. For others: a one-line label. */
  label: string;
  /** Free-form detail rendered in the trace inspector. */
  detail?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
}

/** A single citation linking a decision to the memory that shaped it. */
export interface EvidenceRef {
  kind: 'calibration' | 'playbook' | 'precedent' | 'responder' | 'correlation' | 'policy';
  /** id of the memory object (rule id, incident id, calibration key, guard id…). */
  refId: string;
  label: string;
  /**
   * Signed influence on the decision, -1..1. Positive = pushed toward
   * escalation/dispatch, negative = pushed toward suppression.
   */
  weight: number;
  detail: string;
}

export type AgentActionKind = 'dispatch' | 'escalate' | 'monitor' | 'suppress';

export interface AgentDecision {
  action: AgentActionKind;
  priority: Priority;
  severity: Severity;
  /** Agent's own confidence in this decision, 0..1. */
  confidence: number;
  /** Agent's estimate that this event is a false alarm, 0..1. */
  falseAlarmProbability: number;
  /** Responder id if action === 'dispatch'. */
  responderId: string | null;
  /** Human-readable instruction issued to the responder / supervisor. */
  instruction: string;
  /** One-paragraph justification, written for an ops manager. */
  rationale: string;
  evidence: EvidenceRef[];
  /** For `monitor`: re-evaluate after this many sim-ms. */
  recheckAfterMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
//  INCIDENTS  (an event, once triaged, becomes an incident)
// ─────────────────────────────────────────────────────────────────────────────

export type IncidentStatus =
  | 'triaging'      // agent is reasoning
  | 'open'          // decided, awaiting responder / monitoring
  | 'dispatched'
  | 'on_scene'
  | 'resolved'
  | 'suppressed'
  | 'escalated';

export type ResolutionOutcome =
  | 'true_positive'       // real incident, handled
  | 'false_alarm'         // not real
  | 'missed'              // real, but agent suppressed/monitored and it escalated
  | 'declined'            // responder declined; no one went
  | 'unresolved';

export interface OperatorFeedback {
  ts: SimTime;
  operator: string;
  verdict: 'confirm' | 'override';
  /** Present when verdict === 'override'. */
  correctedAction?: AgentActionKind;
  correctedPriority?: Priority;
  correctedResponderId?: string | null;
  note?: string;
}

export interface DispatchRecord {
  responderId: string;
  responderName: string;
  dispatchedAt: SimTime;
  accepted: boolean | null;      // null while pending
  acknowledgedAt: SimTime | null;
  arrivedAt: SimTime | null;
  /** ms from dispatch to arrival. */
  responseMs: number | null;
  report: string | null;
}

export interface Incident {
  id: string;
  event: SecurityEvent;
  createdAt: SimTime;
  status: IncidentStatus;
  decision: AgentDecision | null;
  trace: TraceStep[];
  /** ms the agent took to reach a decision (the metric ops managers care about). */
  decisionLatencyMs: number | null;
  dispatch: DispatchRecord | null;
  feedback: OperatorFeedback | null;
  resolvedAt: SimTime | null;
  outcome: ResolutionOutcome | null;
  /** Revealed only after resolution — this is what the UI shows in the ledger. */
  revealedTruth: EventTruth | null;
  /** Which engine produced the decision. */
  engine: 'claude' | 'reasoner';
  /** ids of other incidents the agent correlated this with. */
  linkedIncidentIds: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
//  MEMORY — CHANNEL A: Bayesian calibration
// ─────────────────────────────────────────────────────────────────────────────

/** `${siteId}|${zoneId}|${type}|${hourBucket}` — with hierarchical backoff. */
export type CalibrationKey = string;

export interface CalibrationCell {
  key: CalibrationKey;
  siteId: string;
  zoneId: string | null;      // null => site-wide backoff level
  type: EventType;
  hourBucket: number | null;  // 0..7 (3-hour buckets), null => any-hour backoff
  /** Beta posterior over P(event is real). */
  alpha: number;
  beta: number;
  observations: number;
  lastUpdated: SimTime;
  /** Posterior mean = alpha / (alpha + beta). */
  pReal: number;
  /** 95% credible interval half-width — drives the "confidence" shading in the UI. */
  uncertainty: number;
}

export interface CalibrationLookup {
  pReal: number;
  uncertainty: number;
  observations: number;
  /** Which backoff level answered: 'exact' | 'zone_type' | 'site_type' | 'prior'. */
  level: 'exact' | 'zone_type' | 'site_type' | 'prior';
  key: CalibrationKey;
}

// ─────────────────────────────────────────────────────────────────────────────
//  MEMORY — CHANNEL B: responder model (contextual bandit)
// ─────────────────────────────────────────────────────────────────────────────

export interface ResponderModel {
  responderId: string;
  name: string;
  /** Beta posterior over P(accepts a dispatch). */
  acceptAlpha: number;
  acceptBeta: number;
  pAccept: number;
  /** Running stats on response time (ms). */
  responseCount: number;
  responseMeanMs: number;
  responseM2: number;          // Welford, for variance
  responseStdMs: number;
  /** Beta posterior over P(resolves correctly). */
  resolveAlpha: number;
  resolveBeta: number;
  pResolve: number;
  dispatches: number;
  /** Composite 0..1 used for ranking. */
  score: number;
  /** True when the model is still exploring this responder (low n). */
  exploring: boolean;
}

export interface ResponderCandidate {
  responderId: string;
  name: string;
  status: ResponderStatus;
  skills: Skill[];
  /** Estimated travel time from current zone to the incident zone (sim ms). */
  etaMs: number;
  skillMatch: boolean;
  model: ResponderModel;
  /** Thompson-sampled utility for this dispatch. */
  sampledUtility: number;
  /** Human-readable "why this one". */
  reason: string;
}

// ─────────────────────────────────────────────────────────────────────────────
//  MEMORY — CHANNEL C: the playbook (LLM-authored, human-approved SOPs)
// ─────────────────────────────────────────────────────────────────────────────

export type RuleStatus = 'proposed' | 'active' | 'rejected' | 'retired';

export interface RuleTrigger {
  siteId: string | null;
  zoneId: string | null;
  types: EventType[];
  /** Inclusive-exclusive sim-hour window, may wrap midnight. null => any time. */
  hourRange: { start: number; end: number } | null;
  sourceIds: string[] | null;
  /** Extra predicate expressed for humans; also parsed for the few supported forms. */
  condition: string | null;
}

export interface PlaybookRule {
  id: string;
  version: number;
  status: RuleStatus;
  title: string;
  trigger: RuleTrigger;
  action: AgentActionKind;
  priorityFloor: Priority | null;
  /** Multiplier applied to the calibration prior, 0.1..3. */
  falseAlarmMultiplier: number;
  rationale: string;
  author: 'reflection' | 'operator' | 'seed';
  /** Incident ids that motivated the rule. */
  evidenceIncidentIds: string[];
  createdAt: SimTime;
  updatedAt: SimTime;
  /** Live performance — drives auto-retirement. */
  stats: {
    applied: number;
    agreed: number;       // operator confirmed the decision this rule shaped
    overridden: number;
    correct: number;      // matched ground truth on resolution
    incorrect: number;
    precision: number;    // correct / (correct + incorrect)
  };
  /** Set when the rule was auto-retired, explaining why. */
  retiredReason?: string;
  /** Present on proposed edits to an existing rule. */
  supersedesRuleId?: string;
}

export interface PlaybookProposal {
  id: string;
  createdAt: SimTime;
  /** Rules the reflection pass wants to add or change. */
  rules: PlaybookRule[];
  /** Rule ids it wants to retire, with reasons. */
  retire: Array<{ ruleId: string; reason: string }>;
  /** The reflection agent's narrative — shown above the diff. */
  summary: string;
  /** How many resolved incidents this pass analysed. */
  incidentsAnalysed: number;
  engine: 'claude' | 'reasoner';
  status: 'pending' | 'applied' | 'dismissed';
}

// ─────────────────────────────────────────────────────────────────────────────
//  MEMORY — CHANNEL D: precedent retrieval
// ─────────────────────────────────────────────────────────────────────────────

export interface Precedent {
  incidentId: string;
  ts: SimTime;
  zoneCode: string;
  type: EventType;
  similarity: number;        // 0..1
  action: AgentActionKind;
  outcome: ResolutionOutcome;
  summary: string;
}

// ─────────────────────────────────────────────────────────────────────────────
//  CORRELATION
// ─────────────────────────────────────────────────────────────────────────────

export interface CorrelationFinding {
  patternDetected: boolean;
  /** e.g. "3 perimeter events across adjacent zones in 6 minutes". */
  label: string;
  relatedEventIds: string[];
  relatedIncidentIds: string[];
  /** Severity uplift the correlation justifies, 0..2. */
  severityUplift: number;
  detail: string;
}

// ─────────────────────────────────────────────────────────────────────────────
//  METRICS  ("getting smarter", made falsifiable)
// ─────────────────────────────────────────────────────────────────────────────

export interface Metrics {
  incidents: number;
  resolved: number;
  /** Dispatched a responder to something that was not real. Lower is better. */
  falseDispatchRate: number;
  /** Real severity>=4 that the agent suppressed or only monitored. Lower is better. */
  missedCriticalRate: number;
  /** Median ms from event ingest to decision. Lower is better. */
  medianDecisionLatencyMs: number;
  /** Median ms from dispatch to responder on scene, real incidents only. */
  medianResponseMs: number;
  /** Fraction of dispatches the chosen responder accepted. Higher is better. */
  responderAcceptRate: number;
  /** Fraction of decisions the operator confirmed rather than overrode. Higher is better. */
  operatorAgreementRate: number;
  /** Fraction of true alarms correctly actioned. Higher is better. */
  truePositiveActionRate: number;
  /** Composite 0..100. See docs/METRICS.md for the weighting. */
  dispatchScore: number;
}

export const EMPTY_METRICS: Metrics = {
  incidents: 0, resolved: 0, falseDispatchRate: 0, missedCriticalRate: 0,
  medianDecisionLatencyMs: 0, medianResponseMs: 0, responderAcceptRate: 0,
  operatorAgreementRate: 0, truePositiveActionRate: 0, dispatchScore: 0,
};

/** A point on the learning curve — metrics over a sliding window of incidents. */
export interface LearningPoint {
  incidentIndex: number;
  ts: SimTime;
  falseDispatchRate: number;
  missedCriticalRate: number;
  operatorAgreementRate: number;
  dispatchScore: number;
  /** Memory size at this point — shows the agent accumulating knowledge. */
  calibrationCells: number;
  activeRules: number;
}

// ─────────────────────────────────────────────────────────────────────────────
//  EVAL HARNESS
// ─────────────────────────────────────────────────────────────────────────────

export type EvalArmId = 'static' | 'cold' | 'learned';

export interface EvalArm {
  id: EvalArmId;
  label: string;
  description: string;
  metrics: Metrics;
  /** Per-incident decisions, for the drill-down table. */
  sampleDecisions: Array<{
    eventId: string;
    zoneCode: string;
    type: EventType;
    action: AgentActionKind;
    wasReal: boolean;
    correct: boolean;
  }>;
}

export interface EvalRun {
  id: string;
  createdAt: number;          // real wall-clock
  seed: number;
  eventCount: number;
  engine: 'claude' | 'reasoner';
  arms: EvalArm[];
  /** learned − static, per metric. The headline number. */
  delta: Partial<Record<keyof Metrics, number>>;
  durationMs: number;
  notes: string;
}

// ─────────────────────────────────────────────────────────────────────────────
//  API / STREAM CONTRACT
// ─────────────────────────────────────────────────────────────────────────────

export interface SimControls {
  running: boolean;
  /** Sim seconds elapsed per real second. */
  speed: number;
  seed: number;
  simTime: SimTime;
  /** Events generated so far. */
  eventsGenerated: number;
}

export interface EngineStatus {
  engine: 'claude' | 'reasoner';
  model: string;
  effort: string;
  /** Present when the key is missing or a call failed. */
  note: string | null;
  callsMade: number;
  callsFailed: number;
  /** Cumulative input/output tokens, for the cost readout. */
  tokensIn: number;
  tokensOut: number;
  cachedTokensRead: number;
}

/**
 * Responders as the client is allowed to see them. `truth` is stripped at the
 * type level, not by convention — the roster view must show what the responder
 * model has *learned*, never the hidden parameters it is learning.
 */
export type PublicGuard = Omit<Guard, 'truth'>;
export type PublicRobot = Omit<Robot, 'truth'>;

export interface WorldSnapshot {
  sites: Site[];
  zones: Zone[];
  guards: PublicGuard[];
  robots: PublicRobot[];
}

/** The full client-side view model, delivered on connect and diffed thereafter. */
export interface Snapshot {
  controls: SimControls;
  engine: EngineStatus;
  world: WorldSnapshot;
  incidents: Incident[];
  feed: SecurityEvent[];
  metrics: Metrics;
  learningCurve: LearningPoint[];
  calibration: CalibrationCell[];
  responderModels: ResponderModel[];
  playbook: PlaybookRule[];
  proposals: PlaybookProposal[];
  lastEval: EvalRun | null;
}

export type ServerEvent =
  | { type: 'snapshot'; data: Snapshot }
  | { type: 'event'; data: SecurityEvent }
  | { type: 'incident'; data: Incident }
  | { type: 'trace_step'; data: { incidentId: string; step: TraceStep } }
  | { type: 'controls'; data: SimControls }
  | { type: 'engine'; data: EngineStatus }
  | { type: 'metrics'; data: { metrics: Metrics; learningCurve: LearningPoint[] } }
  | { type: 'memory'; data: { calibration: CalibrationCell[]; responderModels: ResponderModel[] } }
  | { type: 'playbook'; data: { playbook: PlaybookRule[]; proposals: PlaybookProposal[] } }
  | { type: 'eval'; data: EvalRun }
  | { type: 'toast'; data: { level: 'info' | 'warn' | 'error'; message: string } };

// ─────────────────────────────────────────────────────────────────────────────
//  HELPERS shared by server + web
// ─────────────────────────────────────────────────────────────────────────────

export const EVENT_LABELS: Record<EventType, string> = {
  motion_detected: 'Motion detected',
  door_forced: 'Door forced',
  door_propped: 'Door propped',
  glass_break: 'Glass break',
  tailgating: 'Tailgating',
  loitering: 'Loitering',
  person_down: 'Person down',
  fire_alarm: 'Fire alarm',
  vehicle_unauthorized: 'Unauthorized vehicle',
  perimeter_breach: 'Perimeter breach',
  robot_obstruction: 'Robot obstruction',
  camera_offline: 'Camera offline',
  panic_button: 'Panic button',
  badge_anomaly: 'Badge anomaly',
  package_theft: 'Package theft',
  noise_complaint: 'Noise complaint',
};

export const ACTION_LABELS: Record<AgentActionKind, string> = {
  dispatch: 'Dispatch',
  escalate: 'Escalate',
  monitor: 'Monitor',
  suppress: 'Suppress',
};

/** 3-hour bucket index 0..7 for a sim timestamp. */
export function hourBucketOf(ts: SimTime): number {
  return Math.floor(new Date(ts).getUTCHours() / 3);
}

export function simHourOf(ts: SimTime): number {
  return new Date(ts).getUTCHours() + new Date(ts).getUTCMinutes() / 60;
}

export function calibrationKey(
  siteId: string,
  zoneId: string | null,
  type: EventType,
  hourBucket: number | null,
): CalibrationKey {
  return `${siteId}|${zoneId ?? '*'}|${type}|${hourBucket ?? '*'}`;
}

/** Does `hour` fall inside a possibly midnight-wrapping window? */
export function inHourRange(hour: number, range: { start: number; end: number }): boolean {
  const { start, end } = range;
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

export function priorityFromSeverity(sev: Severity): Priority {
  if (sev >= 5) return 'P0';
  if (sev === 4) return 'P1';
  if (sev === 3) return 'P2';
  return 'P3';
}
