/**
 * RADIO INTAKE, unstructured report to structured event (see DECISIONS.md Decision 7).
 * The one place the hosted model is load-bearing rather than an upgrade: everything else here
 * degrades to a genuine second opinion, this degrades to keyword matching. A parse is always a
 * proposal the operator confirms, never a dispatch, and an unresolved field returns a question
 * rather than a guess.
 */

import type {
  EngineKind, EventType, Incident, IntakeParse, SourceKind,
} from '../../shared/types';
import { ALL_EVENT_TYPES, EVENT_LABELS } from '../../shared/types';
import type { WorldState } from '../contracts';
import { activeProvider } from './index';
import { TYPE_PROFILE } from './tools';

const SOURCE_KINDS: SourceKind[] = [
  'robot', 'fixed_sensor', 'guard_report', 'access_control', 'tenant_call',
];

export interface IntakeArgs {
  transcript: string;
  world: WorldState;
  /** Recent incidents, newest last. Used only to resolve back-references. */
  incidents: Incident[];
  agentEngine: EngineKind;
}

/** Enough history to resolve "last night" without paying for the whole ledger. */
const HISTORY_FOR_REFERENCES = 14;
export const MAX_TRANSCRIPT = 1200;

const INTAKE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    event_type: {
      type: 'string',
      description:
        'One of the listed event type ids, or the empty string if the report does not clearly '
        + 'indicate one. Do not guess to avoid returning empty.',
    },
    zone_id: {
      type: 'string',
      description: 'Zone id from the zone list, or empty if the location is unclear or ambiguous.',
    },
    source_kind: {
      type: 'string',
      enum: [...SOURCE_KINDS, ''],
      description: 'Who is reporting. A guard on the radio is guard_report; a tenant phoning in is tenant_call.',
    },
    description: {
      type: 'string',
      description:
        'The report rewritten as one dispatch line in plain operational English. Preserve every '
        + 'detail actually stated. Invent nothing, and do not add severity language the reporter did not use.',
    },
    confidence: {
      type: 'number',
      description: '0 to 1. How confident you are in the type and zone together, not in the wording.',
    },
    questions: {
      type: 'array',
      items: { type: 'string' },
      description:
        'What you could not resolve, phrased as a question the dispatcher should ask back over the '
        + 'radio. Empty array when the report is unambiguous.',
    },
    notes: {
      type: 'array',
      items: { type: 'string' },
      description:
        'One short line per inference, so the dispatcher can audit you. Example: '
        + '"north dock -> Z-14 (Loading Dock North), the only dock zone at this site".',
    },
    cited_incident_ids: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Incident ids from the history that you used to resolve a back-reference. Empty when the '
        + 'report stands on its own. Never cite an id that is not in the history.',
    },
  },
  required: [
    'event_type', 'zone_id', 'source_kind', 'description',
    'confidence', 'questions', 'notes', 'cited_incident_ids',
  ],
};

const INTAKE_SYSTEM =
  'You are the intake desk of a physical security operations centre. A guard, a robot operator or a '
  + 'tenant has just called something in, in their own words. Turn it into one structured dispatch '
  + 'record.\n\n'
  + 'Rules you must follow:\n'
  + '- Resolve places to a zone id from the list you are given. Match on the zone name, its code, and '
  + 'the kind of place it is. "The north dock" is a loading dock; "the back gate" is perimeter.\n'
  + '- If the caller refers to an earlier incident ("same door as last night", "that guy again"), find '
  + 'it in the history you are given and cite its id. Do not claim a reference you cannot locate.\n'
  + '- What the caller states outranks what you infer. If they name a location and it also sounds like '
  + 'an earlier incident somewhere else, use the location they named and raise the discrepancy as a '
  + 'question. A caller who says "dock three" is at dock three even if the last propped door was at '
  + 'dock one.\n'
  + '- Choose the event type by what was described, not by how alarming it sounds. A person asleep '
  + 'outside is not a person_down unless the caller described a medical state.\n'
  + '- Return an empty event_type or zone_id rather than guessing. An unresolved field plus a question '
  + 'is a good outcome; a confident wrong dispatch is not. This is a safety system.\n'
  + '- Preserve hedging. If the caller said "I think", the description says so too.\n'
  + '- Never invent detail the caller did not give: no injuries, no weapons, no counts of people.';

/**
 * Keyword matching, used when there is no API key or the model call failed. Kept deliberately
 * plain and self-reported as degraded, low confidence: it is not a real second opinion, and
 * saying so is the point.
 */
const KEYWORDS: Array<{ type: EventType; words: string[] }> = [
  { type: 'person_down', words: ['unconscious', 'not breathing', 'collapsed', 'person down', 'unresponsive', 'seizure'] },
  { type: 'fire_alarm', words: ['fire', 'smoke', 'burning', 'alarm going off'] },
  { type: 'panic_button', words: ['panic', 'duress', 'emergency button'] },
  { type: 'glass_break', words: ['glass', 'window broken', 'smashed'] },
  { type: 'door_forced', words: ['forced', 'pried', 'kicked in', 'broken into'] },
  { type: 'door_propped', words: ['propped', 'wedged', 'held open', 'door open'] },
  { type: 'tailgating', words: ['tailgat', 'followed him in', 'followed her in', 'piggyback'] },
  { type: 'badge_anomaly', words: ['badge', 'credential', 'card reader'] },
  { type: 'vehicle_unauthorized', words: ['vehicle', 'car', 'truck', 'van', 'plate'] },
  { type: 'perimeter_breach', words: ['fence', 'perimeter', 'climbed over', 'jumped the'] },
  { type: 'robot_obstruction', words: ['robot', 'unit is stuck', 'blocked'] },
  { type: 'camera_offline', words: ['camera', 'cam is down', 'no feed'] },
  { type: 'package_theft', words: ['package', 'parcel', 'delivery taken'] },
  { type: 'noise_complaint', words: ['noise', 'loud', 'music'] },
  { type: 'loitering', words: ['loitering', 'hanging around', 'been there for', 'sleeping', 'asleep'] },
  { type: 'motion_detected', words: ['movement', 'motion', 'saw someone', 'somebody'] },
];

function keywordParse(args: IntakeArgs, why: string): IntakeParse {
  const text = args.transcript.toLowerCase();
  const hit = KEYWORDS.find((k) => k.words.some((w) => text.includes(w)));

  // Zones match on code first (operators say codes), then on name words.
  let zone = args.world.zones.find((z) => text.includes(z.code.toLowerCase()));
  if (!zone) {
    zone = args.world.zones.find((z) => z.name.toLowerCase().split(/\s+/)
      .filter((w) => w.length > 3).some((w) => text.includes(w)));
  }

  const questions = ['Keyword matching only. Confirm the type and location before dispatching.'];
  if (!hit) questions.push('What kind of event is this?');
  if (!zone) questions.push('Which zone is this in?');

  return {
    transcript: args.transcript,
    type: hit?.type ?? null,
    zoneId: zone?.id ?? null,
    zoneCode: zone?.code ?? null,
    siteId: zone?.siteId ?? null,
    sourceKind: 'guard_report',
    description: args.transcript.trim().slice(0, 240),
    confidence: hit && zone ? 0.35 : 0.15,
    questions,
    notes: [why],
    citedIncidentIds: [],
    engine: 'reasoner',
    degraded: true,
    latencyMs: 0,
  };
}

/** The zone list the model resolves against. Names and kinds, because that is what callers say. */
function zoneCatalogue(world: WorldState): string {
  return world.zones.map((z) => {
    const site = world.siteById.get(z.siteId);
    return `- ${z.id} | code=${z.code} | "${z.name}" | kind=${z.kind} | site=${site?.code ?? z.siteId}`;
  }).join('\n');
}

function typeCatalogue(): string {
  return ALL_EVENT_TYPES.map((t) => `- ${t} | "${EVENT_LABELS[t]}" | ${TYPE_PROFILE[t].note}`).join('\n');
}

/** Recent incidents, only the fields a back-reference could key off. */
function historyDigest(incidents: Incident[], world: WorldState): string {
  const recent = incidents.slice(-HISTORY_FOR_REFERENCES);
  if (recent.length === 0) return '(no earlier incidents)';
  return recent.map((i) => {
    const z = world.zoneById.get(i.event.zoneId);
    const hour = new Date(i.event.ts).getUTCHours();
    return `- ${i.id} | ${i.event.type} | zone=${i.event.zoneId} (${z?.code ?? '?'}) | hour=${String(hour).padStart(2, '0')}:00 `
      + `| outcome=${i.outcome ?? 'open'} | "${i.event.description}"`;
  }).join('\n');
}

export async function parseIntake(args: IntakeArgs): Promise<IntakeParse> {
  const started = Date.now();
  const provider = activeProvider();
  const transcript = args.transcript.trim();

  if (transcript.length === 0) throw new Error('Nothing to parse.');

  if (!provider) {
    return keywordParse(args, 'No hosted model is configured, so this is keyword matching, not comprehension.');
  }

  try {
    const parsed = (await provider.json(
      INTAKE_SYSTEM,
      `## Zones at this portfolio\n${zoneCatalogue(args.world)}\n\n`
      + `## Event types you may choose from\n${typeCatalogue()}\n\n`
      + `## Recent incidents, for resolving back-references\n${historyDigest(args.incidents, args.world)}\n\n`
      + `## The call, verbatim\n"${transcript}"\n\n`
      + 'Return JSON matching the schema.',
      INTAKE_SCHEMA,
    )) as {
      event_type: string; zone_id: string; source_kind: string; description: string;
      confidence: number; questions: unknown; notes: unknown; cited_incident_ids: unknown;
    };

    // Ids are checked against the real world and ledger, so a hallucinated zone becomes an
    // unresolved field, never a dispatch to a place that doesn't exist.
    const rawType = String(parsed.event_type ?? '');
    const type = ALL_EVENT_TYPES.includes(rawType as EventType) ? (rawType as EventType) : null;

    const zone = args.world.zoneById.get(String(parsed.zone_id ?? '')) ?? null;

    const rawSource = String(parsed.source_kind ?? '');
    const sourceKind = SOURCE_KINDS.includes(rawSource as SourceKind)
      ? (rawSource as SourceKind)
      : 'guard_report';

    const knownIncidents = new Set(args.incidents.map((i) => i.id));
    const citedIncidentIds = toStrings(parsed.cited_incident_ids)
      .filter((id) => knownIncidents.has(id)).slice(0, 4);

    // A generic prompt is added only when the model left a field unresolved and asked nothing;
    // its own question, when present, names the actual candidates and is strictly better.
    const questions = toStrings(parsed.questions).slice(0, 4);
    if (!type && questions.length === 0) {
      questions.push('What kind of event is this? The report did not resolve to one.');
    }
    if (!zone && questions.length === 0) {
      questions.push('Which zone is this in? The location did not resolve.');
    }

    const confidence = clamp01(Number(parsed.confidence));

    return {
      transcript,
      type,
      zoneId: zone?.id ?? null,
      zoneCode: zone?.code ?? null,
      siteId: zone?.siteId ?? null,
      sourceKind,
      description: String(parsed.description ?? '').trim().slice(0, 240) || transcript.slice(0, 240),
      // An unresolved field caps confidence regardless of what the model claimed.
      confidence: type && zone ? confidence : Math.min(confidence, 0.4),
      questions,
      notes: toStrings(parsed.notes).slice(0, 6),
      citedIncidentIds,
      engine: provider.engine,
      degraded: false,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return {
      ...keywordParse(args, `The ${provider.engine} intake call failed, so this is keyword matching instead: ${why}`),
      latencyMs: Date.now() - started,
    };
  }
}

function toStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : [];
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5;
}
