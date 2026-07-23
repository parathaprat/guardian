/**
 * BRIEFING, the shift handover note: one headline, then a ranked list, then
 * the receipts. Every claim carries the incident ids it was drawn from, and
 * citations are clickable straight through to the call on DISPATCH.
 */

import { useMemo, useState } from 'react';
import type { Briefing as BriefingNote, BriefingItem, BriefingItemKind } from '../../../shared/types';
import { ENGINE_LABELS } from '../../../shared/types';
import { EmptyState, Label, Panel, Pill, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { fmtDuration, relTime } from '../lib/format';
import { pushToast, select, useBriefings, useIncidents, useSimTime } from '../lib/store';
import './views.css';

const KIND_LABEL: Record<BriefingItemKind, string> = {
  open: 'Open work',
  change: 'Belief change',
  responder: 'Responder',
  watch: 'Watch',
};

const RANK_LABEL: Record<number, string> = {
  1: 'Act on this',
  2: 'Know about it',
  3: 'Context',
};

export default function Briefing() {
  const briefings = useBriefings();
  const incidents = useIncidents();
  const now = useSimTime();
  const [busy, setBusy] = useState(false);

  const latest = briefings[0] ?? null;
  const earlier = briefings.slice(1);
  const open = incidents.filter((i) => i.outcome === null).length;

  const write = async () => {
    setBusy(true);
    try {
      await api.brief();
    } catch (e) {
      pushToast(e instanceof Error ? e.message : 'Handover failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="view scroll">
      <header className="view-head">
        <div>
          <Label>Briefing</Label>
          <h1 className="display display--l">Hand the shift<br />over properly<span className="dot-accent" /></h1>
          <p className="view-lede">
            The note the operator taking over actually reads. Three passes run in parallel over
            open work, changed beliefs and responder models, and a fourth ranks what they found.
            Written on request, not on a timer, so it costs four model calls a shift rather than
            one per alarm.
          </p>
        </div>
        <div className="view-stats">
          <Stat label="Briefings" value={briefings.length} />
          <Stat label="Open now" value={open} accent={open > 0} />
          <Stat label="Items" value={latest?.items.length ?? 0} />
          <Stat label="Model calls" value={latest?.calls ?? 0} />
        </div>
      </header>

      <section className="view-section">
        <div className="view-section-head">
          <div>
            <Label>Latest</Label>
            <h2 className="view-h2">{latest ? 'Current handover' : 'No handover written yet'}</h2>
          </div>
          <button type="button" className="btn btn--primary" onClick={() => { void write(); }} disabled={busy}>
            {busy ? 'Writing…' : latest ? 'Write a new handover' : 'Write the handover'}
          </button>
        </div>

        {busy && !latest && (
          <Panel><div className="brief-wait"><Spinner label="Three passes, then the ranking" /></div></Panel>
        )}

        {!busy && !latest && (
          <Panel>
            <EmptyState title="Nothing handed over yet">
              Run the console for a while, then write a handover. With no incidents on record it
              will correctly tell you the shift was quiet, which is the honest answer and not a
              very interesting demonstration.
            </EmptyState>
          </Panel>
        )}

        {latest && <Note note={latest} now={now} />}
      </section>

      {earlier.length > 0 && (
        <section className="view-section">
          <div className="view-section-head">
            <div>
              <Label>Earlier</Label>
              <h2 className="view-h2">Previous handovers</h2>
            </div>
            <Pill>{earlier.length} kept</Pill>
          </div>
          <div className="brief-earlier">
            {earlier.map((b) => (
              <article key={b.id} className="brief-past">
                <div className="brief-past-head">
                  <Label tone="accent">{b.id}</Label>
                  <span className="mono muted brief-past-when">{relTime(b.createdAt, now)}</span>
                </div>
                <p className="brief-past-headline">{b.headline}</p>
                <span className="mono muted brief-past-meta">
                  {b.items.length} item(s) · {b.resolvedCovered} resolved · {b.openCovered} open
                </span>
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function Note({ note, now }: { note: BriefingNote; now: number }) {
  const incidents = useIncidents();
  // Built once per briefing, not per item, or every item rebuilds the same set.
  const incidentIds = useMemo(() => new Set(incidents.map((i) => i.id)), [incidents]);

  return (
    <>
      <Panel bodyClassName="brief-body">
        <div className="brief-meta">
          <Label tone="accent">{note.id}</Label>
          <span className="mono muted">{relTime(note.createdAt, now)}</span>
          <span className="mono muted">
            {note.degraded ? 'deterministic pass' : `${ENGINE_LABELS[note.engine]} · ${note.calls} calls`}
          </span>
          <span className="mono muted">{fmtDuration(note.latencyMs)}</span>
        </div>

        <p className="brief-headline">{note.headline}</p>

        {note.degraded && (
          <p className="brief-degraded">
            Written without a hosted model. Ranking by priority is a rule you can write down, so
            this is still useful; noticing that three of the open items are one story is not, and
            that is the part missing here.
          </p>
        )}

        {note.items.length === 0
          ? <EmptyState title="Nothing outstanding">A quiet shift is a valid handover.</EmptyState>
          : (
            <ol className="brief-items">
              {note.items.map((item, n) => (
                <Item key={`${item.kind}-${n}`} item={item} incidentIds={incidentIds} />
              ))}
            </ol>
          )}
      </Panel>
      <p className="view-caption">
        Covers <b>{note.incidentsCovered}</b> incident(s) since the last handover, of which
        {' '}<b>{note.resolvedCovered}</b> resolved and <b>{note.openCovered}</b> are still open.
        Citations are validated against real ids before the note is shown: a claim that cannot
        point at something is dropped rather than printed.
      </p>
    </>
  );
}

function Item({ item, incidentIds }: { item: BriefingItem; incidentIds: ReadonlySet<string> }) {
  const jump = (id: string) => {
    select(id);
    window.location.hash = 'dispatch';
  };

  return (
    <li className={`brief-item is-rank${item.rank}`}>
      <div className="brief-item-head">
        <span className="brief-rank label">{RANK_LABEL[item.rank] ?? 'Context'}</span>
        <Pill>{KIND_LABEL[item.kind]}</Pill>
      </div>
      <h3 className="brief-item-headline">{item.headline}</h3>
      <p className="brief-item-body">{item.body}</p>
      {item.citations.length > 0 && (
        <div className="brief-cites">
          {item.citations.map((c) => (incidentIds.has(c) ? (
            <button key={c} type="button" className="brief-cite is-link mono" onClick={() => jump(c)}>
              {c}
            </button>
          ) : (
            <span key={c} className="brief-cite mono">{c}</span>
          )))}
        </div>
      )}
    </li>
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
