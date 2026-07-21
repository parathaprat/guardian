/**
 * The console frame.
 *
 * The page itself never scrolls — this is a wall-display tool, so the shell is a
 * fixed grid and only inner panes move. Everything else here is lifecycle: the
 * SSE connection, hash routing, and the global key map.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Header, { VIEWS, type ConnectionState, type ViewId } from './components/Header';
import { Kbd, Toasts } from './components/ui';
import { api } from './lib/api';
import {
  select, toggleTheme, useConnection, useControls, useIncidents, useLiveStore,
  useReady, useSelection, useSnapshot, useTheme,
} from './lib/store';
import Dispatch from './views/Dispatch';
import Memory from './views/Memory';
import Evals from './views/Evals';
import Roster from './views/Roster';
import './App.css';

function readHash(): ViewId {
  const raw = window.location.hash.replace(/^#\/?/, '').split('?')[0] ?? '';
  return (VIEWS as string[]).includes(raw) ? (raw as ViewId) : 'dispatch';
}

const SHORTCUTS: Array<[string, string]> = [
  ['1 – 4', 'Switch view'],
  ['Space', 'Play / pause the stream'],
  ['J / K', 'Move through the incident queue'],
  ['A', 'Confirm the selected decision'],
  ['O', 'Override the selected decision'],
  ['T', 'Toggle light / dark'],
  ['?', 'This panel'],
];

export default function App() {
  useLiveStore();

  const snapshot = useSnapshot();
  const ready = useReady();
  const controls = useControls();
  const incidents = useIncidents();
  const selected = useSelection();
  const connection = useConnection();
  const theme = useTheme();

  const [view, setView] = useState<ViewId>(readHash);
  const [help, setHelp] = useState(false);
  const [overrideNonce, setOverrideNonce] = useState(0);

  // Hash routing keeps views linkable and survives a reload.
  useEffect(() => {
    const onHash = () => setView(readHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = useCallback((v: ViewId) => {
    window.location.hash = v;
    setView(v);
  }, []);

  const conn: ConnectionState =
    connection.state === 'open' ? 'live'
      : connection.state === 'closed' ? 'lost'
        : connection.state === 'reconnecting' ? 'lost' : 'connecting';

  const setRunning = useCallback((run: boolean) => {
    void (run ? api.startSim() : api.pauseSim()).catch(() => undefined);
  }, []);

  // ── keyboard ────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key >= '1' && e.key <= '4') {
        const next = VIEWS[Number(e.key) - 1];
        if (next) { e.preventDefault(); go(next); }
        return;
      }

      switch (e.key.toLowerCase()) {
        case ' ':
          e.preventDefault();
          setRunning(!(controls?.running ?? false));
          break;
        case 't':
          toggleTheme();
          break;
        case '?':
        case '/':
          e.preventDefault();
          setHelp((v) => !v);
          break;
        case 'escape':
          setHelp(false);
          break;
        case 'j':
        case 'k': {
          if (view !== 'dispatch') return;
          e.preventDefault();
          const ids = incidents.map((i) => i.id);
          if (ids.length === 0) return;
          const at = selected ? ids.indexOf(selected) : -1;
          const step = e.key.toLowerCase() === 'j' ? 1 : -1;
          const next = at === -1 ? 0 : Math.max(0, Math.min(ids.length - 1, at + step));
          select(ids[next]!);
          break;
        }
        case 'a': {
          if (view !== 'dispatch' || !selected) return;
          e.preventDefault();
          void api.feedback(selected, { verdict: 'confirm', operator: 'console' }).catch(() => undefined);
          break;
        }
        case 'o': {
          if (view !== 'dispatch' || !selected) return;
          e.preventDefault();
          setOverrideNonce((n) => n + 1);
          break;
        }
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [controls?.running, go, incidents, selected, setRunning, view]);

  const body = useMemo(() => {
    switch (view) {
      case 'memory': return <Memory />;
      case 'evals': return <Evals />;
      case 'roster': return <Roster />;
      default: return <Dispatch overrideNonce={overrideNonce} />;
    }
  }, [view, overrideNonce]);

  return (
    <div className="app">
      <Header
        snapshot={snapshot}
        controls={controls}
        connection={conn}
        active={view}
        onSetRunning={setRunning}
        onSetSpeed={(s) => { void api.setSpeed(s).catch(() => undefined); }}
        onSetSeed={(s) => { void api.setSeed(s).catch(() => undefined); }}
        theme={theme}
        onToggleTheme={toggleTheme}
        onHelp={() => setHelp(true)}
      />

      {conn === 'lost' && (
        <div className="app-banner" role="alert">
          <span className="status status--crit status--live">Stream lost</span>
          <span>Reconnecting to the dispatch server. The console is showing the last known state.</span>
        </div>
      )}

      <main className="app-body">
        {!ready ? <Booting /> : body}
      </main>

      {help && (
        <div className="help-scrim" onClick={() => setHelp(false)} role="presentation">
          <div className="help-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Keyboard shortcuts">
            <div className="panel-head">
              <span className="label">Keyboard</span>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setHelp(false)}>Close</button>
            </div>
            <div className="panel-body">
              <table className="tbl help-tbl">
                <tbody>
                  {SHORTCUTS.map(([k, d]) => (
                    <tr key={k}><td><Kbd>{k}</Kbd></td><td className="dim">{d}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      <Toasts />
    </div>
  );
}

function Booting() {
  return (
    <div className="app-boot">
      <div className="app-boot-mark" aria-hidden />
      <h1 className="display display--l">Connecting<span className="dot-accent" /></h1>
      <p className="app-boot-copy">
        Attaching to the dispatch stream. If this persists, start the API with
        {' '}<code>npm run dev:server</code>.
      </p>
    </div>
  );
}
