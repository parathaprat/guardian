/**
 * SHIFT HANDOVER, the briefing the incoming operator reads (see DECISIONS.md Decision 7).
 * Map-reduce: three lenses (open work, belief changes, responder notes) run as independent
 * digests so one bad lens doesn't cost the others, then a single reduce call ranks the result.
 * Every citation is validated against real ids before it ships.
 */

import type {
  Briefing, BriefingItem, BriefingItemKind, EngineKind, Incident, Metrics, SimTime,
} from '../../shared/types';
import { ENGINE_LABELS, EVENT_LABELS } from '../../shared/types';
import type { Memory, WorldState } from '../contracts';
import { activeProvider } from './index';

export interface HandoverArgs {
  incidents: Incident[];
  memory: Memory;
  world: WorldState;
  metrics: Metrics;
  now: SimTime;
  /** Start of the window this briefing covers. */
  since: SimTime;
  agentEngine: EngineKind;
}

let briefingSeq = 0;
function newBriefingId(): string {
  briefingSeq += 1;
  return `BRF-${String(briefingSeq).padStart(4, '0')}`;
}

const ITEM_KINDS: BriefingItemKind[] = ['watch', 'change', 'responder', 'open'];

/** The three lenses. Each is a separate question over a separate store. */
interface Lens {
  kind: BriefingItemKind;
  label: string;
  instruction: string;
  /**
   * What a citable id looks like for this lens. The calibration pass once cited zone ids instead
   * of cell keys, so every citation was filtered out; naming the format is cheaper than loosening
   * validation.
   */
  idHint: string;
  digest(args: HandoverArgs): string;
  /** Ids this lens is allowed to cite. Anything else is dropped. */
  validIds(args: HandoverArgs): Set<string>;
  /**
   * Checked before the call is made: a lens handed an empty digest doesn't return nothing, it
   * writes about whatever else is in the prompt (e.g. shift totals), producing duplicate items.
   */
  hasContent(args: HandoverArgs): boolean;
}

const ITEMS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          headline: {
            type: 'string',
            description:
              'Under 80 characters. What the incoming operator needs to know. Use names and places, '
              + 'never ids, and never a generic phrase like "quiet shift" as an item headline.',
          },
          body: {
            type: 'string',
            description:
              'One to three sentences. Quote the actual numbers from the digest. Names and places, '
              + 'not ids.',
          },
          citations: {
            type: 'array',
            items: { type: 'string' },
            description: 'Ids from the digest that back this claim. Never invent an id.',
          },
          rank: { type: 'integer', description: '1 = act on this now, 2 = know about it, 3 = context.' },
        },
        required: ['headline', 'body', 'citations', 'rank'],
      },
    },
  },
  required: ['items'],
};

const REDUCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    headline: {
      type: 'string',
      description:
        'One sentence, under 140 characters, that an operator walking in cold should read first. '
        + 'State the single most consequential thing. If the shift was quiet, say so plainly. '
        + 'No ids: say "two doors still open at Harbor View", not "INC-000058 and INC-000057". '
        + 'The items below carry the ids.',
    },
    ranking: {
      type: 'array',
      items: { type: 'string' },
      description:
        'The item headlines you were given, reordered most urgent first. Reproduce them verbatim. '
        + 'Drop any that are not worth an operator\'s attention.',
    },
  },
  required: ['headline', 'ranking'],
};

const BASE_SYSTEM =
  'You write shift handover notes for a physical security operations centre. Your reader is the '
  + 'operator taking over in two minutes, standing up, holding a coffee.\n\n'
  + 'Rules you must follow:\n'
  + '- Lead with what they must act on. Context comes last or not at all.\n'
  + '- Cite the actual numbers from the digest. Never invent an id.\n'
  + '- Write prose for a human: use names and places, not ids. Say "Grace Lindqvist" and "Dock D-3", '
  + 'not "grd-mcr-04" and "hbv-dock-3". The ids belong in the citations field, which is rendered '
  + 'separately, and an id in a sentence is both unreadable and breaks across lines badly.\n'
  + '- Report nothing rather than padding. A handover that pads is a handover that stops being read.\n'
  + '- No hedging, no throat-clearing, no restating the question. Plain operational English.\n'
  + '- Do not recommend a dispatch. You are briefing a human, not deciding.';

const LENSES: Lens[] = [
  {
    kind: 'open',
    label: 'open work',
    instruction:
      'These incidents are still open at handover. Flag the ones that need action, and say what '
      + 'the action is. Ignore the ones that are merely waiting.',
    idHint: 'an incident id, the first field on each row, like INC-000042',
    digest: ({ incidents, world }) => {
      const open = incidents.filter((i) => i.outcome === null);
      if (open.length === 0) return '(nothing open)';
      return open.slice(-20).map((i) => {
        const z = world.zoneById.get(i.event.zoneId);
        return `- ${i.id} | ${EVENT_LABELS[i.event.type]} | zone=${z?.code ?? i.event.zoneId} `
          + `| status=${i.status} | action=${i.decision?.action ?? 'undecided'} `
          + `| priority=${i.decision?.priority ?? '?'} | responder=${i.dispatch?.responderId ?? 'none'} `
          + `| "${i.event.description}"`;
      }).join('\n');
    },
    validIds: ({ incidents }) => new Set(incidents.map((i) => i.id)),
    hasContent: ({ incidents }) => incidents.some((i) => i.outcome === null),
  },
  {
    kind: 'change',
    label: 'belief changes',
    instruction:
      'These are the places where the system changed its mind about how often an alarm is real. '
      + 'Report the ones an operator would notice in practice, and say what it means for their shift.',
    idHint:
      'a calibration cell key, the first field on each row, like "hbv|hbv-dock-3|motion_detected|1". '
      + 'A zone id on its own is not a citable id here',
    digest: ({ memory, world }) => {
      const cells = memory.calibration.cells()
        .filter((c) => c.observations >= 4 && c.zoneId !== null)
        .sort((a, b) => b.observations - a.observations)
        .slice(0, 16);
      if (cells.length === 0) return '(not enough observations yet to have changed any belief)';
      return cells.map((c) => {
        const z = world.zoneById.get(c.zoneId!);
        const prior = c.type;
        return `- ${c.key} | zone=${z?.code ?? c.zoneId} | ${prior} | pReal=${c.pReal.toFixed(2)} `
          + `+/-${c.uncertainty.toFixed(2)} | n=${c.observations}`;
      }).join('\n');
    },
    validIds: ({ memory }) => new Set(memory.calibration.cells().map((c) => c.key)),
    hasContent: ({ memory }) =>
      memory.calibration.cells().some((c) => c.observations >= 4 && c.zoneId !== null),
  },
  {
    kind: 'responder',
    label: 'responder notes',
    instruction:
      'These are the learned models of the people and robots on shift. Report only what changes how '
      + 'the incoming operator should use them. Do not list the roster back.',
    idHint: 'a responder id, the first field on each row, like grd-mcr-04',
    digest: ({ memory }) => {
      const models = memory.responders.models().filter((m) => m.dispatches > 0).slice(0, 14);
      if (models.length === 0) return '(no responder has taken a dispatch yet this window)';
      return models.map((m) =>
        `- ${m.responderId} | ${m.name} | accept=${(m.pAccept * 100).toFixed(0)}% `
        + `| resolve=${(m.pResolve * 100).toFixed(0)}% | meanResponse=${Math.round(m.responseMeanMs / 1000)}s `
        + `| n=${m.dispatches}${m.exploring ? ' | still exploring' : ''}`).join('\n');
    },
    validIds: ({ memory }) => new Set(memory.responders.models().map((m) => m.responderId)),
    hasContent: ({ memory }) => memory.responders.models().some((m) => m.dispatches > 0),
  },
];

/** Shift-level counts, computed here so both engines report the same numbers. */
function windowStats(args: HandoverArgs) {
  const covered = args.incidents.filter((i) => i.createdAt >= args.since);
  const resolved = covered.filter((i) => i.outcome !== null);
  const open = args.incidents.filter((i) => i.outcome === null);
  return { covered: covered.length, resolved: resolved.length, open: open.length };
}

function statsLine(args: HandoverArgs): string {
  const s = windowStats(args);
  const m = args.metrics;
  return `incidents=${s.covered} resolved=${s.resolved} stillOpen=${s.open} `
    + `dispatchScore=${m.dispatchScore.toFixed(1)} falseDispatchRate=${(m.falseDispatchRate * 100).toFixed(0)}% `
    + `missedCriticalRate=${(m.missedCriticalRate * 100).toFixed(0)}% `
    + `operatorAgreement=${(m.operatorAgreementRate * 100).toFixed(0)}%`;
}

/**
 * The deterministic briefing, used with no key and when the model pass fails. Unlike the intake
 * fallback this is a genuine second opinion; it just can't notice three open items are one story.
 */
function deterministicBriefing(args: HandoverArgs, note: string): Briefing {
  const s = windowStats(args);
  const items: BriefingItem[] = [];

  const open = args.incidents.filter((i) => i.outcome === null);
  const urgent = open.filter((i) => i.decision?.priority === 'P0' || i.decision?.priority === 'P1');
  if (urgent.length > 0) {
    items.push({
      kind: 'open',
      headline: `${urgent.length} high-priority incident${urgent.length === 1 ? '' : 's'} still open`,
      body: urgent.slice(0, 6).map((i) => {
        const z = args.world.zoneById.get(i.event.zoneId);
        return `${i.id} ${EVENT_LABELS[i.event.type]} at ${z?.code ?? i.event.zoneId} (${i.decision?.priority})`;
      }).join('. '),
      citations: urgent.slice(0, 6).map((i) => i.id),
      rank: 1,
    });
  }

  const quiet = open.filter((i) => !urgent.includes(i));
  if (quiet.length > 0) {
    items.push({
      kind: 'open',
      headline: `${quiet.length} lower-priority incident${quiet.length === 1 ? '' : 's'} open`,
      body: 'Monitoring or awaiting resolution. Nothing in this group is flagged urgent.',
      citations: quiet.slice(0, 8).map((i) => i.id),
      rank: 3,
    });
  }

  const confident = args.memory.calibration.cells()
    .filter((c) => c.observations >= 6 && c.zoneId !== null)
    .sort((a, b) => Math.abs(b.pReal - 0.5) - Math.abs(a.pReal - 0.5))
    .slice(0, 3);
  for (const c of confident) {
    const z = args.world.zoneById.get(c.zoneId!);
    items.push({
      kind: 'change',
      headline: `${EVENT_LABELS[c.type]} at ${z?.code ?? c.zoneId} runs ${(c.pReal * 100).toFixed(0)}% real`,
      body: `Posterior over ${c.observations} observations, +/-${c.uncertainty.toFixed(2)}.`,
      citations: [c.key],
      rank: 2,
    });
  }

  const weak = args.memory.responders.models()
    .filter((m) => m.dispatches >= 3 && m.pAccept < 0.5)
    .slice(0, 3);
  for (const m of weak) {
    items.push({
      kind: 'responder',
      headline: `${m.name} is accepting ${(m.pAccept * 100).toFixed(0)}% of dispatches`,
      body: `Over ${m.dispatches} offers. Ranking has already started routing around this.`,
      citations: [m.responderId],
      rank: 2,
    });
  }

  return {
    id: newBriefingId(),
    createdAt: args.now,
    fromTs: args.since,
    toTs: args.now,
    headline: items.length === 0
      ? 'Quiet shift. Nothing outstanding and no belief moved far enough to mention.'
      : `${s.resolved} resolved, ${s.open} still open. ${note}`,
    items,
    incidentsCovered: s.covered,
    resolvedCovered: s.resolved,
    openCovered: s.open,
    engine: 'reasoner',
    degraded: true,
    calls: 0,
    latencyMs: 0,
  };
}

/** One lens, one call. Returns [] rather than throwing so a sibling lens survives. */
async function runLens(
  lens: Lens,
  args: HandoverArgs,
  provider: NonNullable<ReturnType<typeof activeProvider>>,
): Promise<BriefingItem[]> {
  const digest = lens.digest(args);
  try {
    const parsed = (await provider.json(
      BASE_SYSTEM,
      `## Shift totals, for judging what counts as significant\n${statsLine(args)}\n\n`
      + `## Your subject: ${lens.label}\n${lens.instruction}\n\n${digest}\n\n`
      + 'Write only about the digest above. The shift totals are context for judging significance, '
      + 'not a subject: other passes cover open work, belief changes and responders, and an item '
      + 'that restates a total will be a duplicate of theirs.\n'
      + `Every item must cite at least one id from the digest, which here means ${lens.idHint}. `
      + 'An item you cannot cite will be discarded, so do not write it. Return an empty items array '
      + "if this digest holds nothing worth an operator's attention. Return JSON matching the schema.",
      ITEMS_SCHEMA,
    )) as { items: Array<Record<string, unknown>> };

    const valid = lens.validIds(args);
    return (parsed.items ?? []).slice(0, 5).map((raw) => {
      const rank = Math.round(Number(raw.rank));
      return {
        kind: lens.kind,
        headline: String(raw.headline ?? '').trim().slice(0, 120),
        body: String(raw.body ?? '').trim().slice(0, 600),
        citations: (Array.isArray(raw.citations) ? raw.citations : [])
          .filter((c): c is string => typeof c === 'string')
          .filter((c) => valid.has(c))
          .slice(0, 8),
        rank: Number.isFinite(rank) ? Math.min(3, Math.max(1, rank)) : 2,
      };
    })
      // No surviving citation means the item isn't grounded in this lens's digest, e.g. the
      // responder pass writing about open work. Dropping it enforces the lens division.
      .filter((i) => i.headline.length > 0 && i.citations.length > 0);
  } catch {
    return [];
  }
}

export async function runHandover(args: HandoverArgs): Promise<Briefing> {
  const started = Date.now();
  const provider = activeProvider();

  if (!provider || args.agentEngine === 'reasoner') {
    return deterministicBriefing(
      args,
      'Written by the deterministic pass; no hosted model is configured.',
    );
  }

  // Map: lenses run in parallel, and a lens with an empty digest is skipped rather than
  // asked, so a quiet shift costs one call instead of four.
  const live = LENSES.filter((l) => l.hasContent(args));
  const mapped = await Promise.all(live.map((l) => runLens(l, args, provider)));
  const items = mapped.flat();
  let calls = live.length;

  if (items.length === 0) {
    // No data, nothing worth saying, or a failure: the operator deserves to know which.
    return {
      ...deterministicBriefing(
        args,
        live.length === 0
          ? 'Nothing has accumulated yet for the model passes to read.'
          : `The ${ENGINE_LABELS[provider.engine]} passes found nothing worth reporting.`,
      ),
      calls,
      latencyMs: Date.now() - started,
    };
  }

  // Reduce: ranking needs to see all three lenses at once, which the map stage cannot do.
  let headline = '';
  let ordered = items;
  try {
    const parsed = (await provider.json(
      BASE_SYSTEM,
      `## Shift totals\n${statsLine(args)}\n\n`
      + '## Everything the three passes found\n'
      + items.map((i, n) => `${n + 1}. [${i.kind}] ${i.headline} :: ${i.body}`).join('\n')
      + '\n\nWrite the headline, then rank these for the operator taking over. '
      + 'Return JSON matching the schema.',
      REDUCE_SCHEMA,
    )) as { headline: string; ranking: unknown };
    calls += 1;

    headline = String(parsed.headline ?? '').trim().slice(0, 200);

    // Ranking is applied by matching headlines back to already-validated items; anything
    // rewritten or invented fails to match and keeps its map-stage position.
    const ranking = Array.isArray(parsed.ranking)
      ? parsed.ranking.filter((x): x is string => typeof x === 'string')
      : [];
    if (ranking.length > 0) {
      const pos = new Map(ranking.map((h, n) => [h.trim(), n]));
      ordered = [...items].sort((a, b) => {
        const ai = pos.get(a.headline) ?? Number.MAX_SAFE_INTEGER;
        const bi = pos.get(b.headline) ?? Number.MAX_SAFE_INTEGER;
        return ai - bi || a.rank - b.rank;
      });
    }
  } catch {
    ordered = [...items].sort((a, b) => a.rank - b.rank);
  }

  const s = windowStats(args);
  if (!headline) {
    headline = s.open === 0
      ? `${s.resolved} resolved this window, nothing left open.`
      : `${s.resolved} resolved, ${s.open} still open.`;
  }

  return {
    id: newBriefingId(),
    createdAt: args.now,
    fromTs: args.since,
    toTs: args.now,
    headline,
    items: ordered,
    incidentsCovered: s.covered,
    resolvedCovered: s.resolved,
    openCovered: s.open,
    engine: provider.engine,
    degraded: false,
    calls,
    latencyMs: Date.now() - started,
  };
}

export { ITEM_KINDS };
