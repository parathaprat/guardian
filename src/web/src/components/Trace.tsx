/**
 * The trace inspector, shared by every surface that runs an agent, so a dispatch
 * decision and an ASK answer are inspected on exactly the same terms.
 */

import { useState } from 'react';
import type { TraceStep } from '../../../shared/types';
import './Trace.css';

export function TraceInspector({ steps, live }: { steps: readonly TraceStep[]; live?: boolean }) {
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
                  {expandable && <span className="trace-caret">{isOpen ? '-' : '+'}</span>}
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
