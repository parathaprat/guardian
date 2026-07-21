/**
 * MEMORY, what the agent has learned, and the human gate on the playbook.
 *
 * The learned channels that have a home of their own, all inspectable and all
 * editable by the operator. Responder models live on Roster and precedent
 * surfaces per-decision on Dispatch; this page owns calibration and the
 * playbook, which are the two an ops manager actually reasons about. The proposal
 * diff is the most important thing on this screen: the agent drafts policy, a
 * human approves it.
 */

import { useMemo, useState } from 'react';
import type { CalibrationCell, EventType, PlaybookProposal, PlaybookRule } from '../../../shared/types';
import { ACTION_LABELS, ALL_EVENT_TYPES, ENGINE_LABELS, EVENT_LABELS } from '../../../shared/types';
import { Heatmap, type HeatCell } from '../components/charts';
import { KnowledgeGraph } from '../components/KnowledgeGraph';
import {
  ConfidenceBar, ConfirmButton, EmptyState, Label, Panel, Pill, Spinner, StatusDot,
} from '../components/ui';
import { api } from '../lib/api';
import { fmtHourBucket, fmtPct } from '../lib/format';
import {
  pushToast, useCalibration, usePlaybook, useProposals, useResponderModels, useWorld,
} from '../lib/store';
import './views.css';

export default function Memory() {
  const calibration = useCalibration();
  const playbook = usePlaybook();
  const proposals = useProposals();
  const models = useResponderModels();
  const world = useWorld();
  const [busy, setBusy] = useState(false);

  const active = playbook.filter((r) => r.status === 'active');
  const pending = proposals.filter((p) => p.status === 'pending');

  const reflect = async () => {
    setBusy(true);
    try {
      await api.reflect();
    } catch (e) {
      pushToast(e instanceof Error ? e.message : 'Reflection failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="view scroll">
      <header className="view-head">
        <div>
          <Label>Memory</Label>
          <h1 className="display display--l">Nothing here<br />was configured<span className="dot-accent" /></h1>
          <p className="view-lede">
            Every number on this page was learned from an outcome Sentry watched resolve.
            Calibration and the playbook live here; the responder models are on Roster, and
            precedent shows up as evidence on each call. The playbook still needs a human to
            sign it off.
          </p>
        </div>
        <div className="view-stats">
          <Stat label="Calibration cells" value={calibration.length} />
          <Stat label="Active rules" value={active.length} />
          <Stat label="Responder models" value={models.length} />
          <Stat label="Pending proposals" value={pending.length} accent={pending.length > 0} />
        </div>
      </header>

      <section className="view-section" data-tour="graph">
        <div className="view-section-head">
          <div>
            <Label>What it knows</Label>
            <h2 className="view-h2">The knowledge graph</h2>
          </div>
          <Pill>grows as outcomes resolve</Pill>
        </div>
        <Panel bodyClassName="kg-body">
          <KnowledgeGraph cells={calibration} world={world} />
        </Panel>
        <p className="view-caption">
          Sites and zones are the world Sentry was handed. Every connection between a place and
          an alarm type was earned from an outcome it watched resolve, so an empty graph is an
          honest one. Reset the memory and watch it rebuild itself.
        </p>
      </section>

      <CalibrationSection cells={calibration} />

      <section className="view-section">
        <div className="view-section-head">
          <div>
            <Label>Channel C · Playbook</Label>
            <h2 className="view-h2">Written policy, versioned and approved</h2>
          </div>
          <div className="row gap2">
            <ConfirmButton confirmLabel="Wipe memory?" onConfirm={() => { void api.resetMemory(); }}>
              Reset memory
            </ConfirmButton>
            <button type="button" className="btn btn--accent" disabled={busy} onClick={() => void reflect()}>
              {busy ? <Spinner label="Reflecting" /> : 'Run reflection now'}
            </button>
          </div>
        </div>

        {pending.length > 0
          ? pending.map((p) => <ProposalDiff key={p.id} proposal={p} rules={playbook} />)
          : (
            <div className="view-note">
              No pending proposals. Reflection runs automatically every 25 resolved incidents, or
              press <strong>Run reflection now</strong> to force a pass.
            </div>
          )}

        <RuleGroups rules={playbook} />
      </section>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className="stat">
      <Label>{label}</Label>
      <div className={`stat-num${accent ? ' is-accent' : ''}`}>{value}</div>
    </div>
  );
}

// ── Channel A ───────────────────────────────────────────────────────────────

function CalibrationSection({ cells }: { cells: readonly CalibrationCell[] }) {
  const world = useWorld();
  const present = useMemo(() => {
    const set = new Set<EventType>();
    for (const c of cells) set.add(c.type);
    return ALL_EVENT_TYPES.filter((t) => set.has(t));
  }, [cells]);

  const [type, setType] = useState<EventType>('motion_detected');
  const effective = present.includes(type) ? type : present[0] ?? 'motion_detected';

  const rows = useMemo(
    () => world.zones.map((z) => ({ id: z.id, label: `${z.code} · ${z.name}` })),
    [world.zones],
  );
  const cols = useMemo(
    () => Array.from({ length: 8 }, (_, i) => ({ id: String(i), label: fmtHourBucket(i) })),
    [],
  );

  const heat: HeatCell[] = useMemo(() => cells
    .filter((c) => c.type === effective && c.zoneId !== null && c.hourBucket !== null)
    .map((c) => ({
      rowId: c.zoneId!,
      colId: String(c.hourBucket),
      value: c.pReal,
      uncertainty: c.uncertainty,
      observations: c.observations,
    })), [cells, effective]);

  // The cells that have moved furthest from an uninformative prior are the ones
  // worth showing an operator.
  const movers = useMemo(() => [...cells]
    .filter((c) => c.observations >= 3 && c.zoneId !== null)
    .sort((a, b) => Math.abs(b.pReal - 0.5) * Math.log1p(b.observations)
      - Math.abs(a.pReal - 0.5) * Math.log1p(a.observations))
    .slice(0, 8), [cells]);

  return (
    <section className="view-section">
      <div className="view-section-head">
        <div>
          <Label>Channel A · Calibration</Label>
          <h2 className="view-h2">P(real) by zone and hour</h2>
        </div>
        <select
          className="view-select"
          value={effective}
          onChange={(e) => setType(e.target.value as EventType)}
        >
          {(present.length > 0 ? present : ALL_EVENT_TYPES).map((t) => (
            <option key={t} value={t}>{EVENT_LABELS[t]}</option>
          ))}
        </select>
      </div>

      <div className="mem-grid">
        <Panel eyebrow="Posterior grid" title={EVENT_LABELS[effective]}>
          {heat.length === 0
            ? <EmptyState title="No observations yet">
                This event type has not resolved anywhere yet. Let the stream run, cells fill in as incidents close.
              </EmptyState>
            : <Heatmap
                rows={rows}
                cols={cols}
                cells={heat}
                legendLabel="P(real)"
                emptyLabel="No observations"
              />}
        </Panel>

        <Panel eyebrow="Top movers" title="Furthest from the prior">
          {movers.length === 0
            ? <EmptyState title="Nothing learned yet">Cells appear once incidents start resolving.</EmptyState>
            : (
              <table className="tbl">
                <thead>
                  <tr><th>Zone</th><th>Type</th><th>Hours</th><th className="r">P(real)</th><th className="r">n</th></tr>
                </thead>
                <tbody>
                  {movers.map((c) => {
                    const z = world.zones.find((zz) => zz.id === c.zoneId);
                    return (
                      <tr key={c.key}>
                        <td className="mono">{z?.code ?? '-'}</td>
                        <td>{EVENT_LABELS[c.type]}</td>
                        <td className="mono muted">{c.hourBucket === null ? 'any' : fmtHourBucket(c.hourBucket)}</td>
                        <td className="r mono">
                          {fmtPct(c.pReal)} <span className="muted">±{Math.round(c.uncertainty * 100)}</span>
                        </td>
                        <td className="r mono">{c.observations}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
        </Panel>
      </div>
    </section>
  );
}

// ── Channel C ───────────────────────────────────────────────────────────────

function RuleGroups({ rules }: { rules: readonly PlaybookRule[] }) {
  const groups: Array<[string, PlaybookRule['status']]> = [
    ['Active', 'active'], ['Proposed', 'proposed'], ['Retired', 'retired'], ['Rejected', 'rejected'],
  ];
  return (
    <div className="rule-groups">
      {groups.map(([label, status]) => {
        const set = rules.filter((r) => r.status === status);
        if (set.length === 0) return null;
        return (
          <div key={status} className="rule-group">
            <div className="rule-group-head">
              <Label tone="ink">{label}</Label>
              <span className="muted mono">{set.length}</span>
            </div>
            {set.map((r) => <RuleCard key={r.id} rule={r} />)}
          </div>
        );
      })}
    </div>
  );
}

export function triggerText(rule: PlaybookRule, zoneCode?: string): string {
  const t = rule.trigger;
  const bits: string[] = [];
  if (zoneCode) bits.push(zoneCode);
  bits.push(t.types.map((x) => EVENT_LABELS[x]).join(', '));
  if (t.hourRange) {
    const p = (h: number) => `${String(h).padStart(2, '0')}:00`;
    bits.push(`${p(t.hourRange.start)}–${p(t.hourRange.end)}`);
  } else bits.push('any hour');
  return bits.join(' · ');
}

function RuleCard({ rule }: { rule: PlaybookRule }) {
  const world = useWorld();
  const zone = world.zones.find((z) => z.id === rule.trigger.zoneId);
  const [busy, setBusy] = useState(false);

  const setStatus = async (status: PlaybookRule['status']) => {
    setBusy(true);
    try { await api.setRuleStatus(rule.id, status); }
    catch (e) { pushToast(e instanceof Error ? e.message : 'Failed', 'error'); }
    finally { setBusy(false); }
  };

  return (
    <article className={`rule is-${rule.status}`}>
      <div className="rule-top">
        <Pill tone={rule.status === 'active' ? 'solid' : 'default'}>{rule.status}</Pill>
        <h3 className="rule-title">{rule.title}</h3>
        <Pill title={`Authored by ${rule.author}`}>{rule.author}</Pill>
        <span className="mono muted rule-ver">v{rule.version}</span>
      </div>

      <div className="rule-trigger mono">{triggerText(rule, zone?.code)}</div>

      <div className="rule-action">
        <span className="label">Then</span>
        <strong>{ACTION_LABELS[rule.action]}</strong>
        {rule.priorityFloor && <Pill>floor {rule.priorityFloor}</Pill>}
        {rule.falseAlarmMultiplier !== 1 && <Pill>×{rule.falseAlarmMultiplier} false-alarm prior</Pill>}
      </div>

      <p className="rule-why">{rule.rationale}</p>

      {rule.retiredReason && <p className="rule-retired">Retired: {rule.retiredReason}</p>}

      <div className="rule-foot">
        <div className="rule-stat"><Label>Applied</Label><span className="mono">{rule.stats.applied}</span></div>
        <div className="rule-stat">
          <Label>Precision</Label>
          <ConfidenceBar value={rule.stats.precision} className="rule-meter" />
          <span className="mono">{rule.stats.applied > 0 ? fmtPct(rule.stats.precision) : '-'}</span>
        </div>
        <div className="rule-stat"><Label>Overridden</Label><span className="mono">{rule.stats.overridden}</span></div>
        <div className="rule-actions">
          {rule.status === 'active'
            ? <button type="button" className="btn btn--sm" disabled={busy} onClick={() => void setStatus('retired')}>Retire</button>
            : rule.status === 'retired'
              ? <button type="button" className="btn btn--sm" disabled={busy} onClick={() => void setStatus('active')}>Reactivate</button>
              : null}
        </div>
      </div>
    </article>
  );
}

// ── The diff ────────────────────────────────────────────────────────────────

function ProposalDiff({ proposal, rules }: { proposal: PlaybookProposal; rules: readonly PlaybookRule[] }) {
  const world = useWorld();
  const [accepted, setAccepted] = useState<Set<string>>(() => new Set(proposal.rules.map((r) => r.id)));
  const [busy, setBusy] = useState(false);

  const toggle = (id: string) => setAccepted((s) => {
    const n = new Set(s);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });

  const apply = async () => {
    setBusy(true);
    try {
      const accept = [...accepted];
      const reject = proposal.rules.map((r) => r.id).filter((id) => !accepted.has(id));
      await api.applyProposal(proposal.id, accept, reject);
      pushToast(`Applied ${accept.length} rule change${accept.length === 1 ? '' : 's'} to the playbook.`);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : 'Apply failed', 'error');
    } finally { setBusy(false); }
  };

  const changeCount = accepted.size + proposal.retire.length;

  return (
    <article className="diff">
      <header className="diff-head">
        <div className="row gap3">
          <Label tone="accent">Proposal {proposal.id}</Label>
          <Pill>{proposal.engine === 'reasoner' ? 'Statistical' : ENGINE_LABELS[proposal.engine]}</Pill>
          <span className="muted mono">{proposal.incidentsAnalysed} incidents analysed</span>
        </div>
      </header>

      <p className="diff-summary">{proposal.summary}</p>

      {proposal.rules.map((r) => {
        const zone = world.zones.find((z) => z.id === r.trigger.zoneId);
        const supersedes = r.supersedesRuleId ? rules.find((x) => x.id === r.supersedesRuleId) : undefined;
        const on = accepted.has(r.id);
        return (
          <div key={r.id} className={`diff-row${on ? ' is-on' : ''}`}>
            <label className="diff-check">
              <input type="checkbox" checked={on} onChange={() => toggle(r.id)} />
            </label>
            <div className="diff-main">
              <div className="diff-tag">{supersedes ? '± EDIT RULE' : '+ NEW RULE'}</div>
              {supersedes && (
                <div className="diff-old">
                  <span className="diff-old-title">{supersedes.title}</span>
                  <span className="diff-old-trigger mono">{triggerText(supersedes)}</span>
                </div>
              )}
              <div className="diff-new">
                <strong>{r.title}</strong>
                <span className="mono diff-trigger">{triggerText(r, zone?.code)}</span>
                <span className="diff-then">→ {ACTION_LABELS[r.action]}{r.priorityFloor ? ` · floor ${r.priorityFloor}` : ''}</span>
              </div>
              <p className="diff-why">{r.rationale}</p>
            </div>
          </div>
        );
      })}

      {proposal.retire.map((r) => {
        const rule = rules.find((x) => x.id === r.ruleId);
        return (
          <div key={r.ruleId} className="diff-row is-retire">
            <span className="diff-check" aria-hidden />
            <div className="diff-main">
              <div className="diff-tag is-retire">- RETIRE</div>
              <div className="diff-new"><strong className="diff-strike">{rule?.title ?? r.ruleId}</strong></div>
              <p className="diff-why">{r.reason}</p>
            </div>
          </div>
        );
      })}

      <footer className="diff-foot">
        <button type="button" className="btn btn--accent" disabled={busy || changeCount === 0} onClick={() => void apply()}>
          {busy ? <Spinner /> : `Apply ${changeCount} change${changeCount === 1 ? '' : 's'}`}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => { void api.dismissProposal(proposal.id); }}
        >
          Dismiss
        </button>
        <StatusDot tone="idle">Nothing is applied until you approve it</StatusDot>
      </footer>
    </article>
  );
}
