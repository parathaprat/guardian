/**
 * DISPATCH, the live console.
 *
 * Designed around one question the person on shift is actually asking:
 * *what needs me right now, and can I trust what Sentry did?*
 *
 * Everything follows from that. The queue defaults to the slice that needs a
 * human. The reasoning column leads with the decision in plain words and keeps
 * Confirm / Override permanently in reach. The two technical surfaces, the raw
 * ingest feed and the tool-call trace, are real, complete, and *collapsed by
 * default*, because they are how an engineer audits the agent, not how a
 * supervisor runs a shift.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type {
  AgentActionKind, EvidenceRef, Incident, Priority, SecurityEvent, TraceStep,
  WorldSnapshot,
} from '../../../shared/types';
import { ACTION_LABELS, EVENT_LABELS, PRIORITY_ORDER } from '../../../shared/types';
import {
  ConfidenceBar, EmptyState, Kbd, Label, OutcomeBadge, Panel, Pill, PriorityChip,
  SegmentedControl, StatusDot,
} from '../components/ui';
import { api } from '../lib/api';
import { fmtClock, fmtDuration, fmtPct, initials, relTime } from '../lib/format';
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
 * The inbox.
 *
 * "Needs you" is not "everything open". Sentry handling a P3 nuisance alarm on
 * its own is the product working, and putting it in front of a supervisor is
 * exactly the alarm fatigue this is meant to remove. It earns a human when the
 * agent has *committed a responder*, or when it is calling this a top-two
 * priority, and nobody has signed off yet.
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
                title: 'Sentry committed a responder, or called it P0/P1, and nobody has signed off yet',
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
                ? 'No open P0 or P1 incident is waiting on a human. Switch to Open to see everything Sentry is handling on its own.'
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
            title={`${sourcePlain(e.sourceKind)} · device confidence ${fmtPct(e.sensorConfidence)}`}
          >
            <span className="feed-time mono">{fmtClock(e.ts)}</span>
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
          Pick anything in the queue to see what Sentry decided, why it decided that, and to confirm or override it.
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
        <Pill title={incident.engine === 'claude' ? 'Judged by Claude' : 'Judged by the local Reasoner engine'}>
          {incident.engine === 'claude' ? 'Claude' : 'Reasoner'}
        </Pill>
      }
      bodyClassName="detail-body"
      scroll
    >
      {d ? (
        <>
          {/* The lead. Everything an operator needs to accept or reject the call,
              above the fold, in words, before a single number appears. */}
          <section className="det-lead">
            <div className="det-verdict">
              <h2 className={`display display--m det-action is-${d.action}`}>{ACTION_PLAIN[d.action]}</h2>
              <PriorityChip priority={d.priority} />
            </div>
            <p className="det-means">{ACTION_MEANS[d.action]}</p>
            <p className="det-instruction">{d.instruction}</p>
          </section>

          <section className="det-belief-wrap">
            {/* The contrast that tells the whole story: what the device claimed
                versus what the agent believes after consulting memory. */}
            <div className="det-belief">
              <div className="det-belief-cell">
                <Label>The device claimed</Label>
                <div className="det-belief-num mono">{fmtPct(e.sensorConfidence)}</div>
                <ConfidenceBar value={e.sensorConfidence} tone="neutral" />
                <span className="det-belief-note">the sensor's own confidence</span>
              </div>
              <div className="det-belief-cell is-agent">
                <Label tone="accent">Sentry believes</Label>
                <div className="det-belief-num mono">{fmtPct(pReal ?? 0)}</div>
                <ConfidenceBar value={pReal ?? 0} />
                <span className="det-belief-note">{likelihoodWord(pReal ?? 0)}</span>
              </div>
            </div>
            <p className="det-gap">{beliefGapNote(e.sensorConfidence, pReal ?? 0)}</p>
          </section>

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

          <EvidenceRail evidence={d.evidence} />
        </>
      ) : (
        <div className="det-thinking">
          <span className="status status--warn status--live">Deciding</span>
          <span className="dim">Sentry is gathering evidence on {EVENT_LABELS[e.type]} at {zone?.name ?? e.zoneId}.</span>
        </div>
      )}

      {incident.revealedTruth && <GroundTruth incident={incident} />}

      <WorkDisclosure incident={incident} />

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
   * Bars are scaled against the strongest piece of evidence *in this decision*,
   * not against an absolute ±1. Absolute scaling renders a typical set of
   * weights as four invisible stubs, which communicates nothing; relative
   * scaling answers the question actually being asked, which of these moved it
   * most, and preserves the ordering exactly.
   */
  const peak = Math.max(...ranked.map((ev) => Math.abs(ev.weight)), 0.01);

  return (
    <section className="det-section">
      <div className="det-section-head">
        <Label>What Sentry checked</Label>
        <span className="det-section-note">ranked by how much it moved the call</span>
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
        <span className="label">← stand down</span>
        <span className="sr-only">Bar length is relative to the strongest piece of evidence in this decision.</span>
        {ranked.length > EVIDENCE_PREVIEW && (
          <button type="button" className="ev-more" onClick={() => setAll((v) => !v)}>
            {all ? 'Show less' : `Show all ${ranked.length}`}
          </button>
        )}
        <span className="label">respond →</span>
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

  // Opening a section taller than the viewport otherwise leaves the operator
  // staring at step 9 of 13 with the decision scrolled away. Anchor to the
  // toggle instead, so expanding reads as expanding.
  useEffect(() => {
    if (ui.workOpen) headRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
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
        <span className="work-caret" aria-hidden>{ui.workOpen ? '−' : '+'}</span>
        <span className="work-title">Show Sentry's working</span>
        <span className="work-count mono">{live ? 'live' : `${n} step${n === 1 ? '' : 's'}`}</span>
        <Kbd>E</Kbd>
      </button>
      {ui.workOpen && <TraceInspector steps={incident.trace} live={live} />}
    </section>
  );
}

function TraceInspector({ steps, live }: { steps: TraceStep[]; live: boolean }) {
  const [open, setOpen] = useState<Set<string>>(new Set());

  const toggle = (id: string) => setOpen((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  return (
    <div className="work-body">
      <ol className="trace">
        {steps.map((s) => {
          const expandable = s.kind === 'tool_call' || s.kind === 'tool_result';
          const isOpen = open.has(s.id);
          return (
            <li key={s.id} className={`trace-step is-${s.kind}`}>
              <span className="trace-rail" aria-hidden />
              <div className="trace-body">
                <button
                  type="button"
                  className="trace-head"
                  onClick={() => expandable && toggle(s.id)}
                  disabled={!expandable}
                >
                  <span className="trace-kind label">{s.kind.replace('_', ' ')}</span>
                  <span className="trace-label truncate">{s.label}</span>
                  <span className="trace-dur mono">{s.durationMs}ms</span>
                  {expandable && <span className="trace-caret">{isOpen ? '−' : '+'}</span>}
                </button>

                {s.kind === 'thinking' && s.detail && <p className="trace-think">{s.detail}</p>}
                {s.kind === 'decision' && s.detail && <p className="trace-decide">{s.detail}</p>}
                {s.kind === 'error' && s.detail && <p className="trace-error">{s.detail}</p>}

                {expandable && isOpen && (
                  <pre className="trace-json">
                    {JSON.stringify(s.kind === 'tool_call' ? s.toolInput : s.toolResult, null, 2)}
                  </pre>
                )}
              </div>
            </li>
          );
        })}
        {live && (
          <li className="trace-step is-live">
            <span className="trace-rail" aria-hidden />
            <div className="trace-body"><span className="status status--warn status--live">Working</span></div>
          </li>
        )}
      </ol>
    </div>
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
        <span className="truth-verdict">{right ? 'Sentry was right' : 'Sentry was wrong'}</span>
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
          ? 'Confirmed. Sentry records this as agreement and learns from it.'
          : 'Override sent, and carried out for real. Your corrections are the strongest signal Sentry has.',
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
    <div className="op-bar">
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
          <span className="op-hint">Sentry learns from both.</span>
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
                <option value="">Let Sentry choose</option>
                {guards.map((g) => <option key={g.id} value={g.id}>{g.name} · {g.status.replace(/_/g, ' ')}</option>)}
              </select>
            </label>
          </div>
          <input
            className="op-note-input"
            placeholder="Why? (optional. Sentry reads this when it revises the playbook)"
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
 * Site bounds tile the unit square, so the plan has no aspect ratio of its own,
 * it takes the panel's. A fixed viewBox letterboxed it into a ribbon with dead
 * space either side, so the viewBox height is derived from the measured box.
 *
 * That has a consequence worth naming, because getting it wrong is what made
 * the labels collide: with the viewBox pinned at 100 units wide, one user unit
 * is `panelWidth / 100` pixels, so anything sized in user units grows with the
 * panel. On a 1800px window that scale is ~15px/unit; on a 2560px one it is
 * ~21px, and every glyph inflates by 40%. So the hook returns the scale too,
 * and every mark below is declared in *pixels* and converted. Strokes get
 * `non-scaling-stroke`, which does the same job natively.
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
      // Derive the scale from the viewBox actually used, exactly as `meet` does.
      // Computing it as width/100 instead silently disagrees with the renderer
      // the moment the clamp bites, and every mark comes out short by the ratio.
      setM({ h, scale: Math.min(width / 100, height / h), heightPx: height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return m;
}

/**
 * Mark sizes in CSS pixels, calibrated for a plan rendered about 400px tall and
 * then scaled with the real one. Fixed pixel sizes were legible on a laptop and
 * far too small on a 27" panel, where the map is the same handful of pixels but
 * the viewing distance is not: a plan that gets more room should use it.
 */
const MAP_BASE = {
  siteLabel: 19,
  zoneLabel: 15,
  guardLabel: 11,
  node: 22,
  guard: 14,
  pulse: 28,
  labelGap: 12,
} as const;

/** Room inside each site box: for the site code above, zone codes below. */
const MAP_INSET = { top: 0.2, bottom: 0.16, x: 0.07 } as const;

/** Zone codes land near body-text size at a typical map height, by design. */
const MAP_REF_H = 360;
const MAP_K_MIN = 0.68;
const MAP_K_MAX = 1.5;

const clampN = (lo: number, v: number, hi: number) => Math.max(lo, Math.min(hi, v));

interface Box { x: number; y: number; w: number; h: number }

/**
 * The authored site bounds stack Mercer over Northgate, which reads well in a
 * squarish panel and terribly in a wide, short strip: every zone gets crushed
 * into a third of the height while two thirds of the width goes spare. When the
 * strip is wide, lay the sites out in a row instead. This is presentation only,
 * so it belongs on the client; the bounds the server sends are untouched.
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

function SiteMap() {
  const world = useWorld();
  const incidents = useIncidents();
  const [inject, setInject] = useState<string | null>(null);
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
   * Zone centre in user units, via whichever box layout is in force.
   *
   * Zone x/y are 0..1 across the site, so a zone at y=1 sits exactly on the box
   * edge and its label renders outside the box. The inset reserves room for the
   * site code along the top and for zone codes along the bottom, which is also
   * what stops a corner zone from landing under the site label.
   */
  const at = (zone: { siteId: string; x: number; y: number }): [number, number] | null => {
    const b = boxes.get(zone.siteId);
    if (!b) return null;
    const x = MAP_INSET.x + zone.x * (1 - MAP_INSET.x * 2);
    const y = MAP_INSET.top + zone.y * (1 - MAP_INSET.top - MAP_INSET.bottom);
    return [(b.x + x * b.w) * 100, (b.y + y * b.h) * H];
  };

  return (
    <Panel
      className="dispatch-map"
      eyebrow="Site map"
      title={`${world.sites.length} sites, ${world.zones.length} zones`}
      actions={<Label>click a zone to raise an alarm</Label>}
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

        {/* Site codes paint last: drawn with the site rect, they sat *under* any
            zone node that happened to land in the corner. */}
        {world.sites.map((s) => {
          const b = boxes.get(s.id);
          if (!b) return null;
          return (
            <text
              key={`${s.id}-label`}
              x={b.x * 100 + m(10)}
              y={b.y * H + m(MAP_BASE.siteLabel + 8)}
              fontSize={m(MAP_BASE.siteLabel)}
              className="map-site-label"
            >
              {s.code}
            </text>
          );
        })}
      </svg>

      {inject && <InjectPopover zoneId={inject} onClose={() => setInject(null)} />}
    </Panel>
  );
}

const INJECTABLE = [
  'panic_button', 'person_down', 'door_forced', 'glass_break',
  'motion_detected', 'perimeter_breach', 'fire_alarm', 'tailgating',
] as const;

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
