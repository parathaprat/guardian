/**
 * DISPATCH — the live console.
 *
 * Three columns: raw ingest, the prioritised queue, and the agent's reasoning.
 * The reasoning column is the widest on purpose; the whole product claim is that
 * you can see *why*, not just *what*.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentActionKind, EvidenceRef, Incident, Priority, SecurityEvent, TraceStep,
} from '../../../shared/types';
import { ACTION_LABELS, EVENT_LABELS, PRIORITY_ORDER } from '../../../shared/types';
import {
  ConfidenceBar, EmptyState, Label, OutcomeBadge, Panel, Pill, PriorityChip,
  SegmentedControl, StatusDot,
} from '../components/ui';
import { api } from '../lib/api';
import { fmtClock, fmtDuration, fmtPct, initials, relTime } from '../lib/format';
import {
  pushToast, select, useFeed, useIncidents, useSelectedIncident, useSelection,
  useSimTime, useWorld,
} from '../lib/store';
import './Dispatch.css';

const SOURCE_GLYPH: Record<SecurityEvent['sourceKind'], string> = {
  robot: '◆',
  fixed_sensor: '●',
  guard_report: '▲',
  access_control: '▮',
  tenant_call: '☏',
};

const OPEN = new Set(['triaging', 'open', 'dispatched', 'on_scene', 'escalated']);

export default function Dispatch({ overrideNonce }: { overrideNonce: number }) {
  const incidents = useIncidents();
  const selected = useSelectedIncident();
  const selectedId = useSelection();

  // Keep something selected so the detail pane is never blank once data exists.
  useEffect(() => {
    if (!selectedId && incidents.length > 0) select(incidents[0]!.id);
  }, [incidents, selectedId]);

  const queue = useMemo(() => {
    return [...incidents].sort((a, b) => {
      const ao = OPEN.has(a.status) ? 0 : 1;
      const bo = OPEN.has(b.status) ? 0 : 1;
      if (ao !== bo) return ao - bo;
      const ap = PRIORITY_ORDER[a.decision?.priority ?? 'P3'];
      const bp = PRIORITY_ORDER[b.decision?.priority ?? 'P3'];
      if (ap !== bp) return ap - bp;
      return b.createdAt - a.createdAt;
    });
  }, [incidents]);

  const openCount = incidents.filter((i) => OPEN.has(i.status)).length;

  return (
    <div className="dispatch">
      <FeedColumn />

      <Panel
        className="dispatch-queue"
        eyebrow="Incident queue"
        title={`${openCount} open`}
        actions={<Label>P0 first</Label>}
        bodyClassName="dispatch-queue-body"
        scroll
      >
        {queue.length === 0
          ? <EmptyState title="Queue empty">Nothing has been triaged yet. Incidents appear the moment the agent picks up an event.</EmptyState>
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

// ── LEFT: raw ingest ────────────────────────────────────────────────────────

function FeedColumn() {
  const feed = useFeed();
  const now = useSimTime();
  const [filter, setFilter] = useState<'all' | 'robot' | 'sensor'>('all');

  const rows = useMemo(() => feed.filter((e) => {
    if (filter === 'robot') return e.sourceKind === 'robot';
    if (filter === 'sensor') return e.sourceKind === 'fixed_sensor' || e.sourceKind === 'access_control';
    return true;
  }), [feed, filter]);

  return (
    <Panel
      className="dispatch-feed"
      eyebrow="Live ingest"
      title={`${feed.length} events`}
      actions={
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
      }
      bodyClassName="feed-body"
      scroll
    >
      {rows.length === 0
        ? <EmptyState title="No signal">The stream is idle. Press play in the header to start the world.</EmptyState>
        : rows.map((e) => (
          <article key={e.id} className="feed-row enter">
            <span className="feed-time mono">{fmtClock(e.ts)}</span>
            <span className="feed-glyph" title={e.sourceKind.replace(/_/g, ' ')}>{SOURCE_GLYPH[e.sourceKind]}</span>
            <div className="feed-main">
              <div className="feed-top">
                <span className="feed-zone mono">{String(e.metadata.zone ?? '')}</span>
                <span className="feed-label">{EVENT_LABELS[e.type]}</span>
              </div>
              <div className="feed-sub">
                <span className="label">Sensor conf</span>
                <ConfidenceBar value={e.sensorConfidence} tone="neutral" className="feed-meter" />
                <span className="mono feed-conf">{fmtPct(e.sensorConfidence)}</span>
              </div>
            </div>
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
        <span className="inc-zone mono">{String(incident.event.metadata.site ?? '')} · {String(incident.event.metadata.zone ?? '')}</span>
        <span className="inc-age mono">{relTime(incident.createdAt, now)}</span>
      </div>

      <div className="inc-title">{EVENT_LABELS[incident.event.type]}</div>

      <div className="inc-bottom">
        {triaging ? (
          <span className="status status--warn status--live">Reasoning</span>
        ) : d ? (
          <>
            <span className={`inc-action is-${d.action}`}>{ACTION_LABELS[d.action]}</span>
            <ConfidenceBar value={d.confidence} className="inc-conf" title={`Confidence ${fmtPct(d.confidence)}`} />
          </>
        ) : <span className="status status--idle">Undecided</span>}
      </div>

      {incident.dispatch && (
        <div className="inc-resp mono">
          {incident.dispatch.accepted === false ? '✕ declined · ' : '→ '}
          {incident.dispatch.responderName}
        </div>
      )}

      {incident.outcome && <div className="inc-outcome"><OutcomeBadge outcome={incident.outcome} /></div>}
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
      <Panel className="dispatch-detail" eyebrow="Agent reasoning">
        <EmptyState title="Select an incident">
          Pick anything in the queue to see the evidence the agent gathered, the tools it called, and why it decided what it did.
        </EmptyState>
      </Panel>
    );
  }

  const d = incident.decision;
  const e = incident.event;
  const zone = world.zones.find((z) => z.id === e.zoneId);

  return (
    <Panel
      className="dispatch-detail"
      eyebrow="Agent reasoning"
      title={EVENT_LABELS[e.type]}
      actions={<Pill title={`Decided by ${incident.engine}`}>{incident.engine === 'claude' ? 'Claude' : 'Reasoner'}</Pill>}
      bodyClassName="detail-body"
      scroll
    >
      <header className="det-head">
        <div className="det-meta">
          <span className="mono">{String(e.metadata.site ?? '')} · {zone?.name ?? e.zoneId}</span>
          <span className="mono muted">{fmtClock(e.ts)}</span>
          <Pill>{e.sourceKind.replace(/_/g, ' ')}</Pill>
        </div>
        <p className="det-desc">{e.description}</p>
      </header>

      {d ? (
        <>
          <section className="det-decision">
            <div className="det-verdict">
              <h2 className={`display display--m det-action is-${d.action}`}>{ACTION_LABELS[d.action]}</h2>
              <PriorityChip priority={d.priority} />
            </div>

            {/* The contrast that tells the whole story: what the device claimed
                versus what the agent believes after consulting memory. */}
            <div className="det-belief">
              <div className="det-belief-cell">
                <Label>Sensor said</Label>
                <div className="det-belief-num mono">{fmtPct(e.sensorConfidence)}</div>
                <ConfidenceBar value={e.sensorConfidence} tone="neutral" />
                <span className="det-belief-note">device confidence</span>
              </div>
              <div className="det-belief-cell is-agent">
                <Label tone="accent">Agent believes</Label>
                <div className="det-belief-num mono">{fmtPct(1 - d.falseAlarmProbability)}</div>
                <ConfidenceBar value={1 - d.falseAlarmProbability} />
                <span className="det-belief-note">P(real) after memory</span>
              </div>
              <div className="det-belief-cell">
                <Label>Confidence</Label>
                <div className="det-belief-num mono">{fmtPct(d.confidence)}</div>
                <ConfidenceBar value={d.confidence} tone="neutral" />
                <span className="det-belief-note">
                  {incident.decisionLatencyMs !== null ? `decided in ${fmtDuration(incident.decisionLatencyMs)}` : ''}
                </span>
              </div>
            </div>

            <p className="det-rationale">{d.rationale}</p>
            <p className="det-instruction mono">{d.instruction}</p>
          </section>

          <EvidenceRail evidence={d.evidence} />
        </>
      ) : (
        <div className="det-thinking">
          <span className="status status--warn status--live">Reasoning</span>
          <span className="dim">The agent is gathering evidence. Steps appear below as they happen.</span>
        </div>
      )}

      <TraceInspector steps={incident.trace} live={incident.status === 'triaging'} />

      {incident.revealedTruth && <GroundTruth incident={incident} />}

      <OperatorBar
        incident={incident}
        overriding={overriding}
        setOverriding={setOverriding}
      />
    </Panel>
  );
}

// ── Evidence attribution ────────────────────────────────────────────────────

const EVIDENCE_LABEL: Record<EvidenceRef['kind'], string> = {
  calibration: 'Calibration',
  playbook: 'Playbook',
  precedent: 'Precedent',
  responder: 'Responder',
  correlation: 'Correlation',
  policy: 'Site facts',
};

function EvidenceRail({ evidence }: { evidence: EvidenceRef[] }) {
  if (evidence.length === 0) return null;
  return (
    <section className="det-section">
      <div className="det-section-head">
        <Label>Evidence</Label>
        <span className="det-section-note">which memory moved this decision</span>
      </div>
      <ul className="ev-list">
        {evidence.map((ev, i) => {
          const pushes = ev.weight >= 0;
          const mag = Math.min(1, Math.abs(ev.weight));
          return (
            <li key={`${ev.kind}-${ev.refId}-${i}`} className="ev-row" title={ev.detail}>
              <span className="ev-kind label">{EVIDENCE_LABEL[ev.kind]}</span>
              <span className="ev-label">{ev.label}</span>
              <span className="ev-bar" aria-hidden>
                <span className="ev-bar-mid" />
                <span
                  className={`ev-bar-fill${pushes ? ' is-pos' : ' is-neg'}`}
                  style={{ width: `${mag * 50}%`, [pushes ? 'left' : 'right']: '50%' }}
                />
              </span>
              <span className="ev-weight mono">{ev.weight >= 0 ? '+' : ''}{ev.weight.toFixed(2)}</span>
            </li>
          );
        })}
      </ul>
      <div className="ev-key">
        <span className="label">← toward suppression</span>
        <span className="label">toward action →</span>
      </div>
    </section>
  );
}

// ── Trace ───────────────────────────────────────────────────────────────────

function TraceInspector({ steps, live }: { steps: TraceStep[]; live: boolean }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (live) endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [steps.length, live]);

  if (steps.length === 0 && !live) return null;

  const toggle = (id: string) => setOpen((s) => {
    const n = new Set(s);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });

  return (
    <section className="det-section">
      <div className="det-section-head">
        <Label>Reasoning trace</Label>
        <span className="det-section-note">{steps.length} step{steps.length === 1 ? '' : 's'}</span>
      </div>

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
                  <span className="trace-label">{s.label}</span>
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
      <div ref={endRef} />
    </section>
  );
}

// ── Ground truth reveal ─────────────────────────────────────────────────────

function GroundTruth({ incident }: { incident: Incident }) {
  const t = incident.revealedTruth!;
  const d = incident.decision;
  const acted = d?.action === 'dispatch' || d?.action === 'escalate';
  const right = incident.outcome === 'true_positive'
    || (incident.outcome === 'false_alarm' && !acted);

  return (
    <section className={`det-section truth${right ? ' is-right' : ' is-wrong'}`}>
      <div className="det-section-head">
        <Label>Ground truth</Label>
        <span className="truth-verdict">{right ? 'Agent was right' : 'Agent was wrong'}</span>
      </div>
      <div className="truth-grid">
        <div><Label>Was real</Label><div className="truth-val">{t.isReal ? 'Yes' : 'No'}</div></div>
        <div><Label>True severity</Label><div className="truth-val">{t.trueSeverity}</div></div>
        <div><Label>Outcome</Label><div className="truth-val">{incident.outcome && <OutcomeBadge outcome={incident.outcome} />}</div></div>
      </div>
      <p className="truth-why">{t.explanation}</p>
      {incident.dispatch?.report && <p className="truth-report mono">{incident.dispatch.report}</p>}
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
          ? 'Confirmed. Recorded as agreement and folded into the next reflection pass.'
          : 'Override recorded and executed. Overrides are the highest-weight training signal.',
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
          {incident.feedback.verdict === 'confirm' ? 'Confirmed by operator' : 'Overridden by operator'}
        </StatusDot>
        {incident.feedback.correctedAction && (
          <span className="dim">→ {ACTION_LABELS[incident.feedback.correctedAction]}</span>
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
          <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void send('confirm')}>
            Confirm
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => setOverriding(true)}>
            Override
          </button>
          <span className="op-hint label">A confirm · O override</span>
        </>
      ) : (
        <form
          className="op-form"
          onSubmit={(e) => { e.preventDefault(); void send('override'); }}
        >
          <div className="op-fields">
            <label className="op-field">
              <Label>Action</Label>
              <select value={action} onChange={(e) => setAction(e.target.value as AgentActionKind)}>
                {ACTIONS.map((a) => <option key={a} value={a}>{ACTION_LABELS[a]}</option>)}
              </select>
            </label>
            <label className="op-field">
              <Label>Priority</Label>
              <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
                {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            <label className="op-field op-field--wide">
              <Label>Responder</Label>
              <select value={responder} onChange={(e) => setResponder(e.target.value)}>
                <option value="">Let the agent choose</option>
                {guards.map((g) => <option key={g.id} value={g.id}>{g.name} · {g.status.replace(/_/g, ' ')}</option>)}
              </select>
            </label>
          </div>
          <input
            className="op-note-input"
            placeholder="Why? (optional — this text reaches the reflection agent)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="row gap2">
            <button type="submit" className="btn btn--accent" disabled={busy}>Submit override</button>
            <button type="button" className="btn btn--ghost" onClick={() => setOverriding(false)}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}

// ── Site map ────────────────────────────────────────────────────────────────

function SiteMap() {
  const world = useWorld();
  const incidents = useIncidents();
  const [inject, setInject] = useState<string | null>(null);

  const hot = useMemo(() => {
    const m = new Map<string, Priority>();
    for (const i of incidents) {
      if (!OPEN.has(i.status) || !i.decision) continue;
      const cur = m.get(i.event.zoneId);
      if (!cur || PRIORITY_ORDER[i.decision.priority] < PRIORITY_ORDER[cur]) {
        m.set(i.event.zoneId, i.decision.priority);
      }
    }
    return m;
  }, [incidents]);

  if (world.zones.length === 0) return <Panel className="dispatch-map" eyebrow="Site map" />;

  return (
    <Panel
      className="dispatch-map"
      eyebrow="Site map"
      title={`${world.sites.length} sites · ${world.zones.length} zones`}
      actions={<Label>click a zone to inject</Label>}
      bodyClassName="map-body"
    >
      <svg viewBox="0 0 100 46" className="map-svg" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Site map">
        {world.sites.map((s) => (
          <g key={s.id}>
            <rect
              x={s.bounds.x * 100} y={s.bounds.y * 46}
              width={s.bounds.w * 100} height={s.bounds.h * 46}
              className="map-site"
            />
            <text x={s.bounds.x * 100 + 1.2} y={s.bounds.y * 46 + 3} className="map-site-label">{s.code}</text>
          </g>
        ))}

        {world.zones.map((z) => {
          const site = world.sites.find((s) => s.id === z.siteId);
          if (!site) return null;
          const px = (site.bounds.x + z.x * site.bounds.w) * 100;
          const py = (site.bounds.y + z.y * site.bounds.h) * 46;
          return z.adjacent.map((aid) => {
            const a = world.zones.find((zz) => zz.id === aid);
            if (!a || a.siteId !== z.siteId || a.id < z.id) return null;
            const ax = (site.bounds.x + a.x * site.bounds.w) * 100;
            const ay = (site.bounds.y + a.y * site.bounds.h) * 46;
            return <line key={`${z.id}-${aid}`} x1={px} y1={py} x2={ax} y2={ay} className="map-link" />;
          });
        })}

        {world.zones.map((z) => {
          const site = world.sites.find((s) => s.id === z.siteId);
          if (!site) return null;
          const px = (site.bounds.x + z.x * site.bounds.w) * 100;
          const py = (site.bounds.y + z.y * site.bounds.h) * 46;
          const p = hot.get(z.id);
          return (
            <g key={z.id} className="map-zone" onClick={() => setInject(inject === z.id ? null : z.id)}>
              {p && <circle cx={px} cy={py} r={3.1} className={`map-pulse is-${p}`} />}
              <rect x={px - 1.5} y={py - 1.5} width={3} height={3} className={`map-node${p ? ` is-${p}` : ''}`} />
              <text x={px} y={py + 4.4} className="map-zone-label">{z.code}</text>
            </g>
          );
        })}

        {world.guards.filter((g) => g.status !== 'off_shift').map((g) => {
          const z = world.zones.find((zz) => zz.id === g.currentZoneId);
          const site = z && world.sites.find((s) => s.id === z.siteId);
          if (!z || !site) return null;
          const px = (site.bounds.x + z.x * site.bounds.w) * 100 + 2.2;
          const py = (site.bounds.y + z.y * site.bounds.h) * 46 - 2.2;
          return (
            <g key={g.id}>
              <circle cx={px} cy={py} r={1.7} className={`map-guard is-${g.status}`} />
              <text x={px} y={py + 0.6} className="map-guard-label">{initials(g.name)}</text>
            </g>
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
        <Label tone="ink">Inject · {zone?.code ?? zoneId}</Label>
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
                .then(() => pushToast(`Injected ${EVENT_LABELS[t]} at ${zone?.code ?? zoneId}`))
                .catch((e) => pushToast(String(e), 'error'));
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
