/**
 * The first-run walkthrough: plain-language steps, each anchored to the real
 * control it describes. Pauses the world and owns the keyboard while open.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Kbd } from './ui';
import './Tour.css';

export interface TourStep {
  /** `data-tour` value of the element to spotlight. Omit for a centred card. */
  anchor?: string;
  title: string;
  body: string;
  /** Shown as a keycap row under the body. */
  keys?: Array<[string, string]>;
  /** Switch to this view before showing the step. */
  view?: 'dispatch' | 'memory' | 'evals' | 'roster';
}

export const TOUR_STEPS: TourStep[] = [
  {
    title: 'This is guard[ai]n',
    body:
      'Alarms arrive here from every camera, door and patrol robot across three sites. '
      + 'Guardian reads each one, decides what to do, and shows you why. Your job is to agree '
      + 'with it or correct it. Takes about a minute to learn.',
    view: 'dispatch',
  },
  {
    anchor: 'transport',
    title: 'The world runs fast, once started',
    body:
      'This is a simulation at 4 times real speed, so the agent builds up experience '
      + 'in minutes instead of months. Press space to pause or resume whenever you want to think, or '
      + 'push it to 64x to grow the memory quickly. Nothing is lost when you pause: the queue '
      + 'holds until you come back.',
    keys: [['Space', 'pause and resume']],
  },
  {
    anchor: 'queue',
    title: 'Your queue, most urgent first',
    body:
      'Every alarm Guardian has picked up. "Needs you" is the short list: it committed a '
      + 'responder, or called it top priority, and nobody has signed off yet. A quiet alarm '
      + 'it closed on its own never reaches you. That is the point.',
    keys: [['↑ ↓', 'move through the queue']],
  },
  {
    anchor: 'verdict',
    title: 'What it decided, in plain words',
    body:
      'Send a responder, escalate, keep watching, or stand down. Underneath is exactly what '
      + 'that means on the ground and the instruction going out to the responder.',
  },
  {
    anchor: 'belief',
    title: 'The number that matters',
    body:
      'On the left, how confident the device itself was. On the right, what Guardian believes '
      + 'after checking what has actually happened at this spot at this hour. When those two '
      + 'disagree, the right one is usually Guardian, because the device has no memory and it does.',
  },
  {
    anchor: 'evidence',
    title: 'Why it decided that',
    body:
      'The specific things it checked, ranked by how much each one moved the call. Bars to the '
      + 'right argued for responding, bars to the left for standing down. Nothing here is a '
      + 'guess it cannot show you.',
    keys: [['E', "show every step, including the technical trace"]],
  },
  {
    anchor: 'actions',
    title: 'Agree, or correct it',
    body:
      'Looks right confirms the call. Change it lets you override, and the override is carried '
      + 'out for real, not just logged. Guardian learns from both, and it weighs your corrections '
      + 'more heavily than anything else it sees.',
    keys: [['Enter', 'looks right'], ['O', 'change it']],
  },
  {
    anchor: 'map',
    title: 'Not every call arrives as an alarm',
    body:
      'Most of what a real control room hears is a guard on the radio, in their own words. '
      + 'Radio call turns that into a dispatch: it resolves the place they named, looks up any '
      + 'incident they referred back to, and asks you a question rather than guessing. Nothing is '
      + 'raised until you confirm it.',
  },
  {
    anchor: 'nav',
    title: 'The rest of the console',
    body:
      'Briefing writes the shift handover, ranked by what you have to act on first. Memory shows '
      + 'everything the agent has learned and lets you question it in plain English. Evals is the '
      + 'proof it is genuinely improving and not just moving numbers around. Roster is the crew, '
      + 'scored on outcomes rather than on their file.',
    keys: [['1 - 5', 'switch screens'], ['?', 'all shortcuts']],
  },
  {
    anchor: 'transport',
    title: 'Press play to start',
    body: 'Guardian is paused, so nothing runs until you say so. Hit play, or press space, whenever you are ready.',
    view: 'dispatch',
    keys: [['Space', 'play']],
  },
];

const PAD = 8;

interface Rect { top: number; left: number; width: number; height: number }

function readRect(anchor: string): Rect | null {
  const el = document.querySelector<HTMLElement>(`[data-tour="${anchor}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  // Off-screen anchors would put the spotlight somewhere the user cannot see.
  if (r.bottom < 0 || r.top > window.innerHeight) return null;
  return {
    top: Math.max(0, r.top - PAD),
    left: Math.max(0, r.left - PAD),
    width: Math.min(window.innerWidth, r.width + PAD * 2),
    height: Math.min(window.innerHeight, r.height + PAD * 2),
  };
}

export interface TourProps {
  onClose: () => void;
  /** Lets the tour drive the view so a step can point at the right screen. */
  onGoView: (v: 'dispatch' | 'memory' | 'evals' | 'roster') => void;
}

export function Tour({ onClose, onGoView }: TourProps) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const step = TOUR_STEPS[i]!;
  const last = i === TOUR_STEPS.length - 1;

  const next = useCallback(() => {
    setI((n) => (n >= TOUR_STEPS.length - 1 ? n : n + 1));
  }, []);
  const prev = useCallback(() => setI((n) => Math.max(0, n - 1)), []);

  useEffect(() => {
    if (step.view) onGoView(step.view);
  }, [step.view, onGoView]);

  // Anchors sit inside scrolling panes and layout settles a frame late, so measure on a rAF.
  useLayoutEffect(() => {
    let raf = 0;
    const measure = () => {
      setRect(step.anchor ? readRect(step.anchor) : null);
    };
    raf = requestAnimationFrame(() => {
      if (step.anchor) {
        document
          .querySelector<HTMLElement>(`[data-tour="${step.anchor}"]`)
          ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
      measure();
    });
    const t = window.setTimeout(measure, 380);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [i, step.anchor]);

  useEffect(() => {
    cardRef.current?.focus();
  }, [i]);

  // Console binds single keys, so the tour captures the keydown phase to keep them dormant.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key;
      if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
      if (k === 'ArrowRight' || k === 'Enter' || k === ' ') {
        e.preventDefault(); e.stopPropagation();
        if (last) onClose(); else next();
        return;
      }
      if (k === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); prev(); return; }
      // Everything else is swallowed so the console's shortcuts stay dormant.
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [last, next, prev, onClose]);

  const cardStyle = placeCard(rect);

  return (
    <div className="tour" role="dialog" aria-modal="true" aria-label="Getting started">
      {/* Four panels leaving a hole, rather than an SVG mask, keeps the cutout crisp at any size. */}
      {rect ? (
        <>
          <div className="tour-scrim" style={{ top: 0, left: 0, right: 0, height: rect.top }} />
          <div className="tour-scrim" style={{ top: rect.top + rect.height, left: 0, right: 0, bottom: 0 }} />
          <div className="tour-scrim" style={{ top: rect.top, left: 0, width: rect.left, height: rect.height }} />
          <div className="tour-scrim" style={{ top: rect.top, left: rect.left + rect.width, right: 0, height: rect.height }} />
          <div
            className="tour-ring"
            style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
            aria-hidden
          />
        </>
      ) : (
        <div className="tour-scrim tour-scrim--full" />
      )}

      <div className="tour-card" style={cardStyle} ref={cardRef} tabIndex={-1}>
        <div className="tour-card-head">
          <span className="label">Getting started</span>
          <span className="tour-count mono">{i + 1} / {TOUR_STEPS.length}</span>
        </div>

        <h2 className="tour-title">{step.title}</h2>
        <p className="tour-body">{step.body}</p>

        {step.keys && (
          <div className="tour-keys">
            {step.keys.map(([k, d]) => (
              <span className="tour-key" key={k}><Kbd>{k}</Kbd><span>{d}</span></span>
            ))}
          </div>
        )}

        <div className="tour-dots" aria-hidden>
          {TOUR_STEPS.map((s, n) => (
            <span key={s.title} className={`tour-dot${n === i ? ' is-on' : ''}${n < i ? ' is-done' : ''}`} />
          ))}
        </div>

        <div className="tour-foot">
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
            {last ? 'Close' : 'Skip'}
          </button>
          <div className="row gap2">
            {i > 0 && (
              <button type="button" className="btn btn--sm" onClick={prev}>Back</button>
            )}
            <button type="button" className="btn btn--primary btn--sm" onClick={() => (last ? onClose() : next())}>
              {last ? 'Start working' : 'Next'}
              <Kbd>→</Kbd>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Place the card beside the spotlight without letting it fall off screen. */
function placeCard(rect: Rect | null): React.CSSProperties {
  const W = 380;
  const H = 300;
  if (!rect) {
    return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };
  }
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const below = rect.top + rect.height + 14;
  const above = rect.top - 14 - H;
  const right = rect.left + rect.width + 14;

  // Prefer beside a tall narrow anchor, below a wide one.
  if (rect.height > vh * 0.5 && right + W < vw - 12) {
    return { top: Math.min(Math.max(12, rect.top), vh - H - 12), left: right };
  }
  if (below + H < vh - 12) {
    return { top: below, left: Math.min(Math.max(12, rect.left), vw - W - 12) };
  }
  if (above > 12) {
    return { top: above, left: Math.min(Math.max(12, rect.left), vw - W - 12) };
  }
  return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };
}
