/**
 * DISPATCH, the live console. Built around one question: what needs me right
 * now, and can I trust what Guardian did? The queue defaults to that slice; the
 * raw ingest feed and tool-call trace are real and complete but collapsed by
 * default, they're how an engineer audits the agent, not how a shift is run.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type {
  AgentActionKind, EventType, EvidenceRef, Incident, IntakeParse, Priority, SecurityEvent,
  TraceStep, WorldSnapshot,
} from '../../../shared/types';
import {
  ACTION_LABELS, ALL_EVENT_TYPES, ENGINE_LABELS, EVENT_LABELS, PRIORITY_ORDER,
} from '../../../shared/types';
import {
  ConfidenceBar, EmptyState, Kbd, Label, OutcomeBadge, Panel, Pill, PriorityChip,
  SegmentedControl, Spinner, StatusDot,
} from '../components/ui';
import { TraceInspector } from '../components/Trace';
import { api } from '../lib/api';
import { fmtClock, fmtClockShort, fmtDuration, fmtPct, initials, relTime } from '../lib/format';
import {
  ACTION_MEANS, ACTION_PLAIN, ACTION_SHORT, EVIDENCE_PLAIN, OUTCOME_PLAIN,
  beliefGapNote, evidenceDirection, incidentHeadline, likelihoodWord, sourcePlain,
  wasRight,
} from '../lib/plain';
import {
  pushToast, select, setQueueIds, setUi, toggleUi, useFeed, useIncidents,
  useSelectedIncident, useSelection, useSimTime, useUi, useWorld,
} from '../lib/store';
import type { QueueFilter } from '../lib/store';
import './Dispatch.css';

const SOURCE_GLYPH: Record<SecurityEvent['sourceKind'], string> = {
  robot: '◆',
  fixed_sensor: '●',
  guard_report: '▲',
  access_control: '▮',
  tenant_call: '☏',
};

const OPEN = new Set(['triaging', 'open', 'dispatched', 'on_scene', 'escalated']);

/**
 * "Needs you" is not "everything open": Guardian handling a P3 alarm on its own
 * is the product working. It earns a human only once the agent has committed a
 * responder, or called it a top-two priority, and nobody has signed off yet.
 */
function needsHuman(i: Incident): boolean {
  if (!OPEN.has(i.status) || i.feedback) return false;
  const d = i.decision;
  if (!d) return false; // still reasoning, there is nothing to agree with yet
  if (d.action === 'dispatch' || d.action === 'escalate') return true;
  return d.priority === 'P0' || d.priority === 'P1';
}

export default function Dispatch({ overrideNonce }: { overrideNonce: number }) {
  const incidents = useIncidents();
  const selected = useSelectedIncident();
  const selectedId = useSelection();
  const ui = useUi();

  const counts = useMemo(() => ({
    needs: incidents.filter(needsHuman).length,
    open: incidents.filter((i) => OPEN.has(i.status)).length,
    all: incidents.length,
  }), [incidents]);

  const queue = useMemo(() => {
    const pool = incidents.filter((i) => {
      if (ui.queueFilter === 'needs') return needsHuman(i);
      if (ui.queueFilter === 'open') return OPEN.has(i.status);
      return true;
    });
    return pool.sort((a, b) => {
      const ao = OPEN.has(a.status) ? 0 : 1;
      const bo = OPEN.has(b.status) ? 0 : 1;
      if (ao !== bo) return ao - bo;
      const ap = PRIORITY_ORDER[a.decision?.priority ?? 'P3'];
      const bp = PRIORITY_ORDER[b.decision?.priority ?? 'P3'];
      if (ap !== bp) return ap - bp;
      return b.createdAt - a.createdAt;
    });
  }, [incidents, ui.queueFilter]);

  // Publish the visible ordering so j/k walk what the operator can actually see.
  useEffect(() => { setQueueIds(queue.map((i) => i.id)); }, [queue]);

  // Keep something selected, and never strand the selection outside the filter.
  useEffect(() => {
    if (queue.length === 0) return;
    if (!selectedId || !queue.some((i) => i.id === selectedId)) select(queue[0]!.id);
  }, [queue, selectedId]);

  return (
    <div className={`dispatch${ui.ingestOpen ? '' : ' is-slim'}`}>
      {ui.ingestOpen ? <FeedColumn /> : <FeedRail />}

      <Panel
        className="dispatch-queue"
        data-tour="queue"
        eyebrow="Incident queue"
        title={queueTitle(ui.queueFilter, counts)}
        actions={
          <SegmentedControl<QueueFilter>
            ariaLabel="Filter the queue"
            value={ui.queueFilter}
            onChange={(queueFilter) => setUi({ queueFilter })}
            options={[
              {
                value: 'needs',
                label: (
                  <>
                    Needs you
                    <span className={`seg-count${counts.needs > 0 ? ' is-hot' : ''}`}>{counts.needs}</span>
                  </>
                ),
                title: 'Guardian committed a responder, or called it P0/P1, and nobody has signed off yet',
              },
              { value: 'open', label: `Open ${counts.open}`, title: 'Everything not yet closed out' },
              { value: 'all', label: 'All', title: 'Including resolved and suppressed' },
            ]}
          />
        }
        bodyClassName="dispatch-queue-body"
        scroll
      >
        {queue.length === 0
          ? (
            <EmptyState title={ui.queueFilter === 'needs' ? 'Nothing needs you' : 'Queue empty'}>
              {ui.queueFilter === 'needs'
                ? 'No open P0 or P1 incident is waiting on a human. Switch to Open to see everything Guardian is handling on its own.'
                : 'Nothing has been triaged yet. Incidents appear the moment the agent picks up an event.'}
            </EmptyState>
          )
          : queue.map((i) => (
            <IncidentCard key={i.id} incident={i} active={i.id === selectedId} onSelect={() => select(i.id)} />
          ))}
      </Panel>

      <div className="dispatch-right">
        <SiteMap />
        <IncidentDetail incident={selected} overrideNonce={overrideNonce} />
      </div>
    </div>
  );
}

function queueTitle(filter: QueueFilter, counts: { needs: number; open: number; all: number }): string {
  if (filter === 'needs') return counts.needs === 0 ? 'All clear' : `${counts.needs} waiting on you`;
  if (filter === 'open') return `${counts.open} open`;
  return `${counts.all} total`;
}

// ── LEFT: raw ingest ────────────────────────────────────────────────────────

/** Collapsed state: a spine that still reports the count, so nothing feels lost. */
function FeedRail() {
  const feed = useFeed();
  return (
    <button
      type="button"
      className="feed-rail"
      onClick={() => toggleUi('ingestOpen')}
      title="Show the raw alarm feed (F)"
      aria-label="Show the raw alarm feed"
    >
      <span className="feed-rail-chevron" aria-hidden>›</span>
      <span className="feed-rail-text">Alarm feed · {feed.length}</span>
    </button>
  );
}

function FeedColumn() {
  const feed = useFeed();
  const [filter, setFilter] = useState<'all' | 'robot' | 'sensor'>('all');

  const rows = useMemo(() => feed.filter((e) => {
    if (filter === 'robot') return e.sourceKind === 'robot';
    if (filter === 'sensor') return e.sourceKind === 'fixed_sensor' || e.sourceKind === 'access_control';
    return true;
  }), [feed, filter]);

  return (
    <Panel
      className="dispatch-feed"
      eyebrow="Raw alarm feed"
      title={`${feed.length} received`}
      actions={
        <>
          <SegmentedControl
            ariaLabel="Filter feed by source"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All' },
              { value: 'robot', label: 'Bot' },
              { value: 'sensor', label: 'Sen' },
            ]}
          />
          <button
            type="button"
            className="btn btn--ghost btn--sm btn--icon"
            onClick={() => toggleUi('ingestOpen')}
            title="Hide the raw feed (F)"
            aria-label="Hide the raw alarm feed"
          >
            ‹
          </button>
        </>
      }
      bodyClassName="feed-body"
      scroll
    >
      {rows.length === 0
        ? <EmptyState title="No signal">The stream is idle. Press play in the header to start the world.</EmptyState>
        : rows.map((e) => (
          <article
            key={e.id}
            className="feed-row enter"
            title={`${fmtClock(e.ts)} · ${sourcePlain(e.sourceKind)} · device confidence ${fmtPct(e.sensorConfidence)}`}
          >
            {/* Minutes, not seconds: this column is scanned for rhythm, and the
                exact stamp is one hover away. */}
            <span className="feed-time mono">{fmtClockShort(e.ts)}</span>
            <span className="feed-glyph">{SOURCE_GLYPH[e.sourceKind]}</span>
            <span className="feed-zone mono">{String(e.metadata.zone ?? '')}</span>
            <span className="feed-label">{EVENT_LABELS[e.type]}</span>
            <ConfidenceBar value={e.sensorConfidence} tone="neutral" className="feed-meter" />
          </article>
        ))}
    </Panel>
  );
}

// ── MIDDLE: queue card ──────────────────────────────────────────────────────

function IncidentCard({ incident, active, onSelect }: {
  incident: Incident; active: boolean; onSelect: () => void;
}) {
  const now = useSimTime();
  const d = incident.decision;
  const triaging = incident.status === 'triaging';

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active}
      className={`inc-card${active ? ' is-active' : ''}${triaging ? ' is-triaging' : ''}`}
    >
      <div className="inc-top">
        {d ? <PriorityChip priority={d.priority} /> : <span className="chip-p" data-p="P3">··</span>}
        <span className="inc-title">{EVENT_LABELS[incident.event.type]}</span>
        <span className="inc-age mono">{relTime(incident.createdAt, now)}</span>
      </div>

      <div className="inc-where mono">
        {String(incident.event.metadata.site ?? '')} · {String(incident.event.metadata.zone ?? '')}
      </div>

      <div className="inc-bottom">
        {triaging ? (
          <span className="status status--warn status--live">Deciding</span>
        ) : d ? (
          <>
            <span className={`inc-action is-${d.action}`}>{ACTION_SHORT[d.action]}</span>
            {incident.dispatch && (
              <span className="inc-resp truncate">
                {incident.dispatch.accepted === false ? '✕ declined' : incident.dispatch.responderName}
              </span>
            )}
          </>
        ) : <span className="status status--idle">Undecided</span>}

        {incident.outcome
          ? <span className="inc-tail"><OutcomeBadge outcome={incident.outcome} /></span>
          : needsHuman(incident) && <span className="inc-flag" title="Waiting on your sign-off">Needs you</span>}
      </div>
    </button>
  );
}

// ── RIGHT: the agent, inspected ─────────────────────────────────────────────

function IncidentDetail({ incident, overrideNonce }: { incident: Incident | null; overrideNonce: number }) {
  const world = useWorld();
  const [overriding, setOverriding] = useState(false);

  useEffect(() => { setOverriding(false); }, [incident?.id]);
  useEffect(() => { if (overrideNonce > 0 && incident) setOverriding(true); }, [overrideNonce]);

  if (!incident) {
    return (
      <Panel className="dispatch-detail" eyebrow="The call">
        <EmptyState title="Select an incident">
          Pick anything in the queue to see what Guardian decided, why it decided that, and to confirm or override it.
        </EmptyState>
      </Panel>
    );
  }

  const d = incident.decision;
  const e = incident.event;
  const zone = world.zones.find((z) => z.id === e.zoneId);
  const pReal = d ? 1 - d.falseAlarmProbability : null;

  return (
    <Panel
      className="dispatch-detail"
      eyebrow="The call"
      title={incidentHeadline(incident, zone?.name)}
      actions={
        <Pill title={incident.engine === 'reasoner'
          ? 'Judged by the local Reasoner engine'
          : `Judged by ${ENGINE_LABELS[incident.engine]}`}
        >
          {ENGINE_LABELS[incident.engine]}
        </Pill>
      }
      bodyClassName="detail-body"
      scroll
    >
      {d ? (
        /* Everything needed to accept or reject the call, above the fold, in
           words, before a single number appears. */
        <section className="det-lead" data-tour="verdict">
          <div className="det-verdict">
            <h2 className={`det-action is-${d.action}`}>{ACTION_PLAIN[d.action]}</h2>
            <PriorityChip priority={d.priority} />
          </div>
          <p className="det-means">{ACTION_MEANS[d.action]}</p>
          <p className="det-instruction">{d.instruction}</p>
        </section>
      ) : (
        <div className="det-thinking">
          <span className="status status--warn status--live">Deciding</span>
          <span className="dim">Guardian is gathering evidence on {EVENT_LABELS[e.type]} at {zone?.name ?? e.zoneId}.</span>
        </div>
      )}

      {/* Left, the argument; right, the receipts. One column until the panel is
          wide enough that a second one beats 500px of empty margin. */}
      <div className="det-cols">
        <div className="det-col det-col--argument">
          {d && (
            <section className="det-belief-wrap" data-tour="belief">
              <div className="det-belief">
                <div className="det-belief-cell">
                  <Label>The device claimed</Label>
                  <div className="det-belief-num mono">{fmtPct(e.sensorConfidence)}</div>
                  <ConfidenceBar value={e.sensorConfidence} tone="neutral" />
                  <span className="det-belief-note">the sensor's own confidence</span>
                </div>
                <div className="det-belief-cell is-agent">
                  <Label tone="accent">Guardian believes</Label>
                  <div className="det-belief-num mono">{fmtPct(pReal ?? 0)}</div>
                  <ConfidenceBar value={pReal ?? 0} />
                  <span className="det-belief-note">{likelihoodWord(pReal ?? 0)}</span>
                </div>
              </div>
              <p className="det-gap">{beliefGapNote(e.sensorConfidence, pReal ?? 0)}</p>
            </section>
          )}

          {d && (
            <section className="det-why">
              <div className="det-section-head">
                <Label>Why</Label>
                <span className="det-section-note">
                  {incident.decisionLatencyMs !== null
                    ? `decided in ${fmtDuration(incident.decisionLatencyMs)} · ${fmtPct(d.confidence)} confidence`
                    : `${fmtPct(d.confidence)} confidence`}
                </span>
              </div>
              <p className="det-rationale">{d.rationale}</p>
            </section>
          )}

          {incident.revealedTruth && <GroundTruth incident={incident} />}
        </div>

        <div className="det-col det-col--receipts">
          {d && <EvidenceRail evidence={d.evidence} />}
          <WorkDisclosure incident={incident} />
        </div>
      </div>

      <OperatorBar
        incident={incident}
        overriding={overriding}
        setOverriding={setOverriding}
      />
    </Panel>
  );
}

// ── Evidence attribution ────────────────────────────────────────────────────

/** Enough to show the argument; the rest is one click away. */
const EVIDENCE_PREVIEW = 4;

/** Strip schema vocabulary out of text an operator reads. */
function humanize(s: string): string {
  return s.replace(/\b[a-z]+(?:_[a-z]+)+\b/g, (m) => m.replace(/_/g, ' '));
}

function EvidenceRail({ evidence }: { evidence: EvidenceRef[] }) {
  const [all, setAll] = useState(false);
  if (evidence.length === 0) return null;

  // Ranked by influence, the question is "what moved this", not "what ran".
  const ranked = [...evidence].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  const shown = all ? ranked : ranked.slice(0, EVIDENCE_PREVIEW);

  /**
   * Scaled against the strongest piece of evidence in this decision, not an
   * absolute ±1, or a typical weight set renders as four invisible stubs.
   */
  const peak = Math.max(...ranked.map((ev) => Math.abs(ev.weight)), 0.01);

  return (
    <section className="det-section" data-tour="evidence">
      <div className="det-section-head">
        <Label>What Guardian checked</Label>
        <span className="det-section-note">ranked by influence</span>
      </div>
      <ul className="ev-list">
        {shown.map((ev, i) => {
          const pushes = ev.weight >= 0;
          const mag = Math.min(1, Math.abs(ev.weight) / peak);
          return (
            <li
              key={`${ev.kind}-${ev.refId}-${i}`}
              className="ev-row"
              title={`${humanize(ev.detail)}, ${evidenceDirection(ev.weight)}`}
            >
              <span className="ev-kind label">{EVIDENCE_PLAIN[ev.kind]}</span>
              <span className="ev-label truncate">{humanize(ev.label)}</span>
              <span className="ev-bar" aria-hidden>
                <span className="ev-bar-mid" />
                <span
                  className={`ev-bar-fill${pushes ? ' is-pos' : ' is-neg'}`}
                  style={{ width: `${mag * 50}%`, [pushes ? 'left' : 'right']: '50%' }}
                />
              </span>
              <span className="sr-only">{evidenceDirection(ev.weight)}</span>
            </li>
          );
        })}
      </ul>
      <div className="ev-foot">
        {ranked.length > EVIDENCE_PREVIEW ? (
          <button type="button" className="ev-more" onClick={() => setAll((v) => !v)}>
            {all ? 'Show less' : `Show all ${ranked.length}`}
          </button>
        ) : <span />}
        <span className="sr-only">Bar length is relative to the strongest piece of evidence in this decision.</span>
        {/* Legend sits under the bars it explains, not adrift at the row ends. */}
        <span className="ev-axis" aria-hidden>
          <span className="label">← stand down</span>
          <span className="label">respond →</span>
        </span>
      </div>
    </section>
  );
}

// ── The technical layer, behind one disclosure ──────────────────────────────

/**
 * Collapsed by default. This is the difference between a console and a debug
 * view: the audit trail must be *complete and reachable*, not *always on*.
 */
function WorkDisclosure({ incident }: { incident: Incident }) {
  const ui = useUi();
  const headRef = useRef<HTMLButtonElement>(null);
  const live = incident.status === 'triaging';
  const n = incident.trace.length;

  // Scrolls the owning pane directly, not via scrollIntoView, which walks every
  // ancestor scrollport and would drag the fixed console shell off-screen.
  useEffect(() => {
    if (!ui.workOpen) return;
    const head = headRef.current;
    const pane = head?.closest<HTMLElement>('.scroll');
    if (!head || !pane) return;
    const top = head.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
    pane.scrollTo({ top, behavior: 'smooth' });
  }, [ui.workOpen]);

  if (n === 0 && !live) return null;

  return (
    <section className="det-work">
      <button
        ref={headRef}
        type="button"
        className="work-toggle"
        onClick={() => toggleUi('workOpen')}
        aria-expanded={ui.workOpen}
      >
        <span className="work-caret" aria-hidden>{ui.workOpen ? '-' : '+'}</span>
        <span className="work-title">Show Guardian's working</span>
        <span className="work-count mono">{live ? 'live' : `${n} step${n === 1 ? '' : 's'}`}</span>
        <Kbd>E</Kbd>
      </button>
      {ui.workOpen && <TraceInspector steps={incident.trace} live={live} />}
    </section>
  );
}

// ── Ground truth reveal ─────────────────────────────────────────────────────

function GroundTruth({ incident }: { incident: Incident }) {
  const t = incident.revealedTruth!;
  const right = wasRight(incident);

  return (
    <section className={`det-section truth${right ? ' is-right' : ' is-wrong'}`}>
      <div className="det-section-head">
        <Label>What actually happened</Label>
        <span className="truth-verdict">{right ? 'Guardian was right' : 'Guardian was wrong'}</span>
      </div>
      <div className="truth-line">
        <span className="truth-val">{incident.outcome ? OUTCOME_PLAIN[incident.outcome] : '-'}</span>
        <span className="dim">·</span>
        <span className="dim">true severity {t.trueSeverity} of 5</span>
      </div>
      <p className="truth-why">{t.explanation}</p>
      {incident.dispatch?.report && <p className="truth-report">“{incident.dispatch.report}”</p>}
    </section>
  );
}

// ── Operator feedback ───────────────────────────────────────────────────────

const ACTIONS: AgentActionKind[] = ['dispatch', 'escalate', 'monitor', 'suppress'];
const PRIORITIES: Priority[] = ['P0', 'P1', 'P2', 'P3'];

function OperatorBar({ incident, overriding, setOverriding }: {
  incident: Incident; overriding: boolean; setOverriding: (v: boolean) => void;
}) {
  const world = useWorld();
  const [action, setAction] = useState<AgentActionKind>(incident.decision?.action ?? 'dispatch');
  const [priority, setPriority] = useState<Priority>(incident.decision?.priority ?? 'P2');
  const [responder, setResponder] = useState<string>('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const guards = world.guards.filter((g) => g.siteId === incident.event.siteId);

  const send = async (verdict: 'confirm' | 'override') => {
    setBusy(true);
    try {
      await api.feedback(incident.id, {
        verdict,
        operator: 'console',
        ...(verdict === 'override' ? {
          correctedAction: action,
          correctedPriority: priority,
          correctedResponderId: responder || null,
          note: note || undefined,
        } : {}),
      });
      pushToast(
        verdict === 'confirm'
          ? 'Confirmed. Guardian records this as agreement and learns from it.'
          : 'Override sent, and carried out for real. Your corrections are the strongest signal Guardian has.',
        'info',
      );
      setOverriding(false);
      setNote('');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : 'Feedback failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  if (incident.feedback) {
    return (
      <div className="op-bar is-done">
        <StatusDot tone={incident.feedback.verdict === 'confirm' ? 'good' : 'warn'}>
          {incident.feedback.verdict === 'confirm' ? 'You confirmed this' : 'You overrode this'}
        </StatusDot>
        {incident.feedback.correctedAction && (
          <span className="dim">→ {ACTION_PLAIN[incident.feedback.correctedAction]}</span>
        )}
        {incident.feedback.note && <span className="op-note">“{incident.feedback.note}”</span>}
      </div>
    );
  }

  if (!incident.decision) return null;

  return (
    <div className="op-bar" data-tour="actions">
      {!overriding ? (
        <>
          <button type="button" className="btn btn--primary op-cta" disabled={busy} onClick={() => void send('confirm')}>
            Looks right
            <Kbd>⏎</Kbd>
          </button>
          <button type="button" className="btn op-cta" disabled={busy} onClick={() => setOverriding(true)}>
            Change it
            <Kbd>O</Kbd>
          </button>
          <span className="op-hint">Guardian learns from both.</span>
        </>
      ) : (
        <form
          className="op-form"
          onSubmit={(ev) => { ev.preventDefault(); void send('override'); }}
        >
          <div className="op-form-head">
            <Label tone="ink">Change this call</Label>
            <span className="op-hint">This is carried out for real, not just logged.</span>
          </div>
          <div className="op-fields">
            <label className="op-field">
              <Label>Do this instead</Label>
              <select value={action} onChange={(ev) => setAction(ev.target.value as AgentActionKind)}>
                {ACTIONS.map((a) => <option key={a} value={a}>{ACTION_PLAIN[a]} ({ACTION_LABELS[a]})</option>)}
              </select>
            </label>
            <label className="op-field">
              <Label>Priority</Label>
              <select value={priority} onChange={(ev) => setPriority(ev.target.value as Priority)}>
                {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            <label className="op-field op-field--wide">
              <Label>Who goes</Label>
              <select value={responder} onChange={(ev) => setResponder(ev.target.value)}>
                <option value="">Let Guardian choose</option>
                {guards.map((g) => <option key={g.id} value={g.id}>{g.name} · {g.status.replace(/_/g, ' ')}</option>)}
              </select>
            </label>
          </div>
          <input
            className="op-note-input"
            placeholder="Why? (optional. Guardian reads this when it revises the playbook)"
            value={note}
            onChange={(ev) => setNote(ev.target.value)}
          />
          <div className="row gap2">
            <button type="submit" className="btn btn--accent" disabled={busy}>Send correction</button>
            <button type="button" className="btn btn--ghost" onClick={() => setOverriding(false)}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}

// ── Site map ────────────────────────────────────────────────────────────────

/**
 * viewBox height derives from the measured panel box, not a fixed ratio, or the
 * plan letterboxes. A user unit scales with panel width, so marks are declared
 * in pixels and converted via the returned scale, or labels inflate and collide.
 */
function useMapMetrics(
  ref: RefObject<HTMLDivElement | null>,
): { h: number; scale: number; heightPx: number } {
  const [m, setM] = useState({ h: 46, scale: 10, heightPx: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width <= 0 || height <= 0) return;
      const h = Math.max(6, Math.min(200, (height / width) * 100));
      // Derived from the viewBox actually used, as `meet` does; width/100 alone
      // silently disagrees with the renderer once the clamp bites.
      setM({ h, scale: Math.min(width / 100, height / h), heightPx: height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return m;
}

/**
 * Mark sizes in CSS pixels, calibrated for a ~300px plan and scaled from there,
 * so a plan given more room actually uses it rather than staying laptop-sized.
 */
const MAP_BASE = {
  siteLabel: 17,
  zoneLabel: 16,
  guardLabel: 12,
  node: 24,
  guard: 15,
  pulse: 32,
  labelGap: 13,
} as const;

/**
 * Room reserved inside each site box, in CSS pixels rather than a fraction of
 * the box: the fixed stack of marks it has to fit doesn't shrink with the box,
 * so a fractional reservation clips labels at small sizes.
 */
const MAP_PAD = {
  /** The alert ring is the widest thing centred on a node, not the node. */
  top: MAP_BASE.pulse / 2 + 8,
  /** Half a node, the label gap, and the zone code itself. */
  bottom: MAP_BASE.node / 2 + MAP_BASE.labelGap + MAP_BASE.zoneLabel,
  left: MAP_BASE.pulse / 2 + 8,
  /** Guard bubbles hang up and to the right of their zone. */
  right: MAP_BASE.node * 0.75 + MAP_BASE.guard + 5,
} as const;

/**
 * The floor matters more than the ceiling: most operators see the plan near its
 * minimum height, so `MAP_K_MIN` is tuned to stay legible there, not at the max.
 */
const MAP_REF_H = 300;
const MAP_K_MIN = 0.86;
const MAP_K_MAX = 1.5;

const clampN = (lo: number, v: number, hi: number) => Math.max(lo, Math.min(hi, v));

interface Box { x: number; y: number; w: number; h: number }

/**
 * Authored site bounds stack vertically, which crushes zones in a wide, short
 * panel. Re-lay sites in a row once the panel is wide; presentation only, the
 * server's bounds are untouched.
 */
function siteBoxes(sites: WorldSnapshot['sites'], aspect: number): Map<string, Box> {
  const out = new Map<string, Box>();
  if (aspect >= 2.4 && sites.length > 1) {
    const gap = 0.018;
    const w = (1 - gap * (sites.length - 1)) / sites.length;
    sites.forEach((s, i) => out.set(s.id, { x: i * (w + gap), y: 0, w, h: 1 }));
  } else {
    for (const s of sites) out.set(s.id, s.bounds);
  }
  return out;
}

/** The smallest span worth stretching. Below it, translate rather than scale. */
const SPREAD_MIN = 0.3;

/**
 * Authored zone coordinates don't use the full 0..1 range, so each site's zones
 * are rescaled to fill their own box; tightly-clustered zones are translated
 * rather than stretched, to avoid misrepresenting adjacency. Presentation only.
 */
function siteSpreads(zones: WorldSnapshot['zones']): Map<string, { x: [number, number]; y: [number, number] }> {
  const acc = new Map<string, { x: [number, number]; y: [number, number] }>();
  for (const z of zones) {
    const cur = acc.get(z.siteId);
    if (!cur) { acc.set(z.siteId, { x: [z.x, z.x], y: [z.y, z.y] }); continue; }
    cur.x[0] = Math.min(cur.x[0], z.x); cur.x[1] = Math.max(cur.x[1], z.x);
    cur.y[0] = Math.min(cur.y[0], z.y); cur.y[1] = Math.max(cur.y[1], z.y);
  }
  return acc;
}

/** Map one axis of a zone coordinate into 0..1 given the site's own extent. */
function spread(v: number, [lo, hi]: [number, number]): number {
  const span = hi - lo;
  if (span < SPREAD_MIN) return 0.5 + (v - (lo + hi) / 2);
  return (v - lo) / span;
}

function SiteMap() {
  const world = useWorld();
  const incidents = useIncidents();
  const [inject, setInject] = useState<string | null>(null);
  const [radio, setRadio] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const { h: H, scale, heightPx } = useMapMetrics(bodyRef);

  /** px -> user units, so a mark keeps its size whatever the panel does. */
  const u = (px: number) => px / scale;
  /** Marks grow with the room the plan is given, within sane bounds. */
  const k = clampN(MAP_K_MIN, heightPx / MAP_REF_H, MAP_K_MAX);
  const m = (base: number) => u(base * k);

  const boxes = useMemo(
    () => siteBoxes(world.sites, H > 0 ? 100 / H : 1),
    [world.sites, H],
  );
  const spreads = useMemo(() => siteSpreads(world.zones), [world.zones]);

  const hot = useMemo(() => {
    const map = new Map<string, Priority>();
    for (const i of incidents) {
      if (!OPEN.has(i.status) || !i.decision) continue;
      const cur = map.get(i.event.zoneId);
      if (!cur || PRIORITY_ORDER[i.decision.priority] < PRIORITY_ORDER[cur]) {
        map.set(i.event.zoneId, i.decision.priority);
      }
    }
    return map;
  }, [incidents]);

  if (world.zones.length === 0) return <Panel className="dispatch-map" eyebrow="Site map" />;

  /**
   * Zone centre in user units: spread across the site's extent, then placed
   * inside the box minus the pixel padding marks need. `Math.max` guards the
   * degenerate case, a box smaller than its own padding gets a centred row.
   */
  const at = (zone: { siteId: string; x: number; y: number }): [number, number] | null => {
    const b = boxes.get(zone.siteId);
    if (!b) return null;
    const sp = spreads.get(zone.siteId);
    const zx = sp ? clampN(0, spread(zone.x, sp.x), 1) : zone.x;
    const zy = sp ? clampN(0, spread(zone.y, sp.y), 1) : zone.y;

    const bx = b.x * 100;
    const by = b.y * H;
    const bw = b.w * 100;
    const bh = b.h * H;

    const spanX = Math.max(0, bw - m(MAP_PAD.left) - m(MAP_PAD.right));
    const spanY = Math.max(0, bh - m(MAP_PAD.top) - m(MAP_PAD.bottom));
    return [
      bx + (spanX > 0 ? m(MAP_PAD.left) + zx * spanX : bw / 2),
      by + (spanY > 0 ? m(MAP_PAD.top) + zy * spanY : bh / 2),
    ];
  };

  return (
    <Panel
      className="dispatch-map"
      data-tour="map"
      eyebrow="Site map"
      title={`${world.sites.length} sites, ${world.zones.length} zones`}
      actions={
        <div className="map-actions">
          <Label>click a zone to raise an alarm</Label>
          <button type="button" className="btn btn--sm" onClick={() => setRadio(true)}>Radio call</button>
        </div>
      }
      bodyClassName="map-body"
      bodyRef={bodyRef}
    >
      <svg viewBox={`0 0 100 ${H}`} className="map-svg" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Site map">
        {world.sites.map((s) => {
          const b = boxes.get(s.id);
          if (!b) return null;
          return (
            <rect
              key={s.id}
              x={b.x * 100} y={b.y * H}
              width={b.w * 100} height={b.h * H}
              className="map-site"
              vectorEffect="non-scaling-stroke"
            />
          );
        })}

        {world.zones.map((z) => {
          const from = at(z);
          if (!from) return null;
          return z.adjacent.map((aid) => {
            const a = world.zones.find((zz) => zz.id === aid);
            if (!a || a.siteId !== z.siteId || a.id < z.id) return null;
            const to = at(a);
            if (!to) return null;
            return (
              <line
                key={`${z.id}-${aid}`}
                x1={from[0]} y1={from[1]} x2={to[0]} y2={to[1]}
                className="map-link"
                vectorEffect="non-scaling-stroke"
              />
            );
          });
        })}

        {world.zones.map((z) => {
          const at_ = at(z);
          if (!at_) return null;
          const [px, py] = at_;
          const p = hot.get(z.id);
          const side = m(MAP_BASE.node);
          return (
            <g key={z.id} className="map-zone" onClick={() => setInject(inject === z.id ? null : z.id)}>
              <title>{z.name}: click to raise a test alarm here</title>
              {p && (
                <circle
                  cx={px} cy={py} r={m(MAP_BASE.pulse) / 2}
                  className={`map-pulse is-${p}`}
                  vectorEffect="non-scaling-stroke"
                />
              )}
              <rect
                x={px - side / 2} y={py - side / 2}
                width={side} height={side}
                className={`map-node${p ? ` is-${p}` : ''}`}
              />
              <text
                x={px}
                y={py + side / 2 + m(MAP_BASE.labelGap)}
                fontSize={m(MAP_BASE.zoneLabel)}
                className="map-zone-label"
              >
                {z.code}
              </text>
            </g>
          );
        })}

        {world.guards.filter((g) => g.status !== 'off_shift').map((g) => {
          const z = world.zones.find((zz) => zz.id === g.currentZoneId);
          if (!z) return null;
          const at_ = at(z);
          if (!at_) return null;
          const off = m(MAP_BASE.node * 0.75);
          const px = at_[0] + off;
          const py = at_[1] - off;
          return (
            <g key={g.id}>
              <title>{g.name}, {g.status.replace(/_/g, ' ')}</title>
              <circle
                cx={px} cy={py} r={m(MAP_BASE.guard)}
                className={`map-guard is-${g.status}`}
                vectorEffect="non-scaling-stroke"
              />
              <text
                x={px} y={py + m(MAP_BASE.guardLabel * 0.36)}
                fontSize={m(MAP_BASE.guardLabel)}
                className="map-guard-label"
              >
                {initials(g.name)}
              </text>
            </g>
          );
        })}

        {/* Painted last so it sits above any zone node in the corner; top-right
            because the top-left is where a plan's first zone tends to land. */}
        {world.sites.map((s) => {
          const b = boxes.get(s.id);
          if (!b) return null;
          return (
            <text
              key={`${s.id}-label`}
              x={(b.x + b.w) * 100 - m(11)}
              y={b.y * H + m(MAP_BASE.siteLabel + 3)}
              fontSize={m(MAP_BASE.siteLabel)}
              textAnchor="end"
              className="map-site-label"
            >
              {s.code}
            </text>
          );
        })}
      </svg>

      {inject && <InjectPopover zoneId={inject} onClose={() => setInject(null)} />}
      {radio && <RadioIntake onClose={() => setRadio(false)} />}
    </Panel>
  );
}

const INJECTABLE = [
  'panic_button', 'person_down', 'door_forced', 'glass_break',
  'motion_detected', 'perimeter_breach', 'fire_alarm', 'tailgating',
] as const;

// ── Radio intake ────────────────────────────────────────────────────────────

/**
 * A guard's radio call becomes a dispatch. The parse is shown before anything
 * is raised, so a bad resolution is visible and editable rather than silent;
 * an unresolved type or zone disables dispatch rather than guessing.
 */
/**
 * Written against the real zone table in `world/site.ts`, so every sample
 * resolves. Each exercises a different path: clean resolve, back-reference, hedge.
 */
const SAMPLE_CALLS: Array<{ label: string; text: string }> = [
  {
    label: 'Medical',
    text: "Control, this is Ruiz. I'm in Stairwell A at Metro Center, there's someone collapsed on the landing between two and three. He's not responding to me. Get medical down here now.",
  },
  {
    label: 'Back-reference',
    text: "It's dock three at Harbor View again, same one as before. Door's propped open with a fire extinguisher. Third time this week.",
  },
  {
    label: 'Hedged',
    text: 'Yeah, control, I might have seen someone moving about over on Lot East. Honestly it could be nothing, could be the cleaners again. Just flagging it.',
  },
];

function RadioIntake({ onClose }: { onClose: () => void }) {
  const world = useWorld();
  const [text, setText] = useState('');
  const [parse, setParse] = useState<IntakeParse | null>(null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  // The parse is a proposal, so these hold the operator's version of it.
  const [type, setType] = useState<EventType | ''>('');
  const [zoneId, setZoneId] = useState('');
  const [description, setDescription] = useState('');

  const run = async (t: string) => {
    const trimmed = t.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setParse(null);
    try {
      const res = await api.parseIntake(trimmed);
      setParse(res);
      setType(res.type ?? '');
      setZoneId(res.zoneId ?? '');
      setDescription(res.description);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : 'Parse failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const dispatch = async () => {
    if (!type || !zoneId || !description.trim() || sending) return;
    setSending(true);
    try {
      const res = await api.intakeDispatch({
        type, zoneId, description: description.trim(), sourceKind: parse?.sourceKind ?? 'guard_report',
      });
      select(res.incidentId);
      pushToast(`${EVENT_LABELS[type]} raised from the radio call`);
      onClose();
    } catch (e) {
      pushToast(e instanceof Error ? e.message : 'Dispatch failed', 'error');
    } finally {
      setSending(false);
    }
  };

  const ready = Boolean(type) && Boolean(zoneId) && description.trim().length > 0;

  return (
    <div className="radio-scrim" role="presentation" onClick={onClose}>
      <div className="radio" role="dialog" aria-label="Radio intake" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <div className="ui-panel-titles">
            <span className="label">Radio intake</span>
            <div className="ui-panel-title">Type what you heard</div>
          </div>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>Close</button>
        </div>

        <div className="radio-body">
          <form onSubmit={(e) => { e.preventDefault(); void run(text); }}>
            <textarea
              className="radio-text"
              rows={3}
              value={text}
              maxLength={1200}
              placeholder="Control, this is Ruiz at the north dock…"
              aria-label="The call, in the caller's own words"
              onChange={(e) => setText(e.target.value)}
              disabled={busy}
            />
            <div className="radio-actions">
              <div className="radio-samples">
                {SAMPLE_CALLS.map((s) => (
                  <button
                    key={s.label}
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={busy}
                    onClick={() => { setText(s.text); void run(s.text); }}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              <button type="submit" className="btn btn--primary btn--sm" disabled={busy || text.trim().length === 0}>
                {busy ? 'Parsing…' : 'Parse the call'}
              </button>
            </div>
          </form>

          {busy && <div className="radio-wait"><Spinner label="Resolving the location and the type" /></div>}

          {parse && !busy && (
            <div className="radio-parse">
              <div className="radio-parse-head">
                <Label tone="accent">Parsed</Label>
                <span className="mono muted">
                  {parse.degraded ? 'keyword matching, no hosted model' : `${ENGINE_LABELS[parse.engine]} · ${fmtPct(parse.confidence)} confident`}
                </span>
              </div>

              <div className="radio-fields">
                <label className="radio-field">
                  <span className="label">Type</span>
                  <select value={type} onChange={(e) => setType(e.target.value as EventType | '')}>
                    <option value="">Unresolved, pick one</option>
                    {ALL_EVENT_TYPES.map((t) => <option key={t} value={t}>{EVENT_LABELS[t]}</option>)}
                  </select>
                </label>
                <label className="radio-field">
                  <span className="label">Zone</span>
                  <select value={zoneId} onChange={(e) => setZoneId(e.target.value)}>
                    <option value="">Unresolved, pick one</option>
                    {world.zones.map((z) => <option key={z.id} value={z.id}>{z.code} · {z.name}</option>)}
                  </select>
                </label>
              </div>

              <label className="radio-field radio-field--wide">
                <span className="label">Dispatch line</span>
                <input
                  type="text"
                  value={description}
                  maxLength={240}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </label>

              {parse.notes.length > 0 && (
                <ul className="radio-notes">
                  {parse.notes.map((n) => <li key={n}>{n}</li>)}
                </ul>
              )}

              {parse.citedIncidentIds.length > 0 && (
                <p className="radio-cites">
                  <span className="label">Resolved against</span>
                  {parse.citedIncidentIds.map((id) => <span key={id} className="mono radio-cite">{id}</span>)}
                </p>
              )}

              {parse.questions.length > 0 && (
                <ul className="radio-questions">
                  {parse.questions.map((q) => <li key={q}>{q}</li>)}
                </ul>
              )}

              <div className="radio-commit">
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => { void dispatch(); }}
                  disabled={!ready || sending}
                  title={ready ? undefined : 'Type and zone must both be resolved before this can be raised'}
                >
                  {sending ? 'Raising…' : 'Raise this incident'}
                </button>
                <span className="radio-commit-note">
                  Nothing is raised until you press this. Guardian then triages it exactly as it
                  would a sensor alarm.
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function InjectPopover({ zoneId, onClose }: { zoneId: string; onClose: () => void }) {
  const world = useWorld();
  const zone = world.zones.find((z) => z.id === zoneId);
  return (
    <div className="inject">
      <div className="inject-head">
        <Label tone="ink">Raise an alarm · {zone?.code ?? zoneId}</Label>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>Close</button>
      </div>
      <div className="inject-grid">
        {INJECTABLE.map((t) => (
          <button
            key={t}
            type="button"
            className="btn btn--sm"
            onClick={() => {
              void api.injectEvent(t, zoneId)
                .then(() => pushToast(`${EVENT_LABELS[t]} raised at ${zone?.code ?? zoneId}`))
                .catch((err) => pushToast(String(err), 'error'));
              onClose();
            }}
          >
            {EVENT_LABELS[t]}
          </button>
        ))}
      </div>
    </div>
  );
}
