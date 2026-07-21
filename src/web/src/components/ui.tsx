/**
 * Shared UI primitives. Thin wrappers over the vocabulary in base.css, the
 * point is that every view spells "panel", "label", "priority" the same way.
 */

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode, Ref } from 'react';
import type { Priority, ResolutionOutcome, ResponderStatus } from '../../../shared/types';
import { dismissToast, useToasts } from '../lib/store';
import './ui.css';

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

// ── text ──────────────────────────────────────────────────────────────────

export function Label({ children, className, tone = 'muted' }: {
  children: ReactNode; className?: string; tone?: 'muted' | 'ink' | 'accent';
}) {
  return (
    <span className={cx('label', tone === 'ink' && 'label--ink', tone === 'accent' && 'label--accent', className)}>
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

// ── chips ─────────────────────────────────────────────────────────────────

export function Pill({ children, tone = 'default', className, title }: {
  children: ReactNode; tone?: 'default' | 'solid' | 'accent'; className?: string; title?: string;
}) {
  return (
    <span
      title={title}
      className={cx('pill', tone === 'solid' && 'pill--solid', tone === 'accent' && 'pill--accent', className)}
    >
      {children}
    </span>
  );
}

/** Priority is ordinal, so the literal P0..P3 always ships with the colour. */
export function PriorityChip({ priority, className }: { priority: Priority; className?: string }) {
  return <span className={cx('chip-p', className)} data-p={priority}>{priority}</span>;
}

const OUTCOME_TONE: Record<ResolutionOutcome, 'good' | 'warn' | 'serious' | 'crit' | 'idle'> = {
  true_positive: 'good',
  false_alarm: 'warn',
  missed: 'crit',
  declined: 'serious',
  unresolved: 'idle',
};

const OUTCOME_TEXT: Record<ResolutionOutcome, string> = {
  true_positive: 'True positive',
  false_alarm: 'False alarm',
  missed: 'Missed',
  declined: 'Declined',
  unresolved: 'Unresolved',
};

/** Status is never colour-alone, the dot always ships with its word. */
export function StatusDot({ tone, children, live, className }: {
  tone: 'good' | 'warn' | 'serious' | 'crit' | 'idle';
  children: ReactNode; live?: boolean; className?: string;
}) {
  return (
    <span className={cx('status', `status--${tone}`, live && 'status--live', className)}>{children}</span>
  );
}

export function OutcomeBadge({ outcome }: { outcome: ResolutionOutcome }) {
  return <StatusDot tone={OUTCOME_TONE[outcome]}>{OUTCOME_TEXT[outcome]}</StatusDot>;
}

const RESPONDER_TONE: Record<ResponderStatus, 'good' | 'warn' | 'serious' | 'crit' | 'idle'> = {
  available: 'good',
  enroute: 'warn',
  on_scene: 'warn',
  busy: 'serious',
  break: 'idle',
  off_shift: 'idle',
  offline: 'crit',
};

export function ResponderStatusDot({ status }: { status: ResponderStatus }) {
  return <StatusDot tone={RESPONDER_TONE[status]}>{status.replace(/_/g, ' ')}</StatusDot>;
}

// ── surfaces ──────────────────────────────────────────────────────────────

export function Panel({ eyebrow, title, actions, children, className, bodyClassName, scroll, bodyRef }: {
  eyebrow?: ReactNode; title?: ReactNode; actions?: ReactNode; children?: ReactNode;
  className?: string; bodyClassName?: string; scroll?: boolean;
  /** For panes that must measure themselves, the site map sizes to its box. */
  bodyRef?: Ref<HTMLDivElement>;
}) {
  return (
    <section className={cx('panel', 'ui-panel', className)}>
      {(eyebrow || title || actions) && (
        <header className="panel-head">
          <div className="ui-panel-titles">
            {eyebrow && <Label>{eyebrow}</Label>}
            {title && <div className="ui-panel-title">{title}</div>}
          </div>
          {actions && <div className="row gap2">{actions}</div>}
        </header>
      )}
      <div ref={bodyRef} className={cx('panel-body', scroll && 'scroll', bodyClassName)}>{children}</div>
    </section>
  );
}

export function EmptyState({ title, children, action }: {
  title: string; children?: ReactNode; action?: ReactNode;
}) {
  return (
    <div className="ui-empty">
      <div className="ui-empty-mark" aria-hidden />
      <div className="ui-empty-title">{title}</div>
      {children && <p className="ui-empty-body">{children}</p>}
      {action && <div className="ui-empty-action">{action}</div>}
    </div>
  );
}

// ── controls ──────────────────────────────────────────────────────────────

export interface SegmentOption<T extends string | number> {
  value: T;
  label: ReactNode;
  title?: string;
  disabled?: boolean;
}

export function SegmentedControl<T extends string | number>({ options, value, onChange, className, ariaLabel }: {
  options: ReadonlyArray<SegmentOption<T>>;
  value: T;
  onChange: (v: T) => void;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <div className={cx('seg', className)} role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          title={o.title}
          disabled={o.disabled}
          aria-pressed={o.value === value}
          className={cx('seg-item', o.value === value && 'is-active')}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label, disabled, title }: {
  checked: boolean; onChange: (v: boolean) => void; label: ReactNode;
  disabled?: boolean; title?: string;
}) {
  const id = useId();
  return (
    <label className={cx('tgl', disabled && 'is-disabled')} htmlFor={id} title={title}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="tgl-track"><span className="tgl-thumb" /></span>
      <span className="tgl-label">{label}</span>
    </label>
  );
}

export function ConfidenceBar({ value, tone = 'accent', className, title }: {
  value: number; tone?: 'accent' | 'neutral'; className?: string; title?: string;
}) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <span className={cx('meter', className)} title={title} role="img" aria-label={`${Math.round(pct)}%`}>
      <i style={{ width: `${pct}%`, background: tone === 'accent' ? 'var(--accent)' : 'var(--ink-3)' }} />
    </span>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="row gap2">
      <span className="spinner" aria-hidden />
      {label && <Label>{label}</Label>}
    </span>
  );
}

// ── tooltip ───────────────────────────────────────────────────────────────

export function Tooltip({ content, children, side = 'bottom', className }: {
  content: ReactNode; children: ReactNode; side?: 'top' | 'bottom'; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const hostRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<CSSProperties>({});

  useLayoutEffect(() => {
    if (!open || !hostRef.current) return;
    const r = hostRef.current.getBoundingClientRect();
    const top = side === 'bottom' ? r.bottom + 8 : r.top - 8;
    // Keep the panel on screen without a positioning library.
    const left = Math.min(Math.max(8, r.left), window.innerWidth - 272);
    setPos({ top, left, transform: side === 'top' ? 'translateY(-100%)' : undefined });
  }, [open, side]);

  return (
    <span
      ref={hostRef}
      className={cx('tip-host', className)}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      tabIndex={0}
    >
      {children}
      {open && <span className="tip-pop" style={pos} role="tooltip">{content}</span>}
    </span>
  );
}

// ── toasts ────────────────────────────────────────────────────────────────

export function Toasts() {
  const toasts = useToasts();
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={cx('toast', `toast--${t.level}`)}>
          <span className="toast-msg">{t.message}</span>
          <button type="button" className="toast-x" onClick={() => dismissToast(t.id)} aria-label="Dismiss">×</button>
        </div>
      ))}
    </div>
  );
}

/** Confirm-once button for destructive actions (memory reset, rule retirement). */
export function ConfirmButton({ children, confirmLabel = 'Confirm?', onConfirm, className, disabled }: {
  children: ReactNode; confirmLabel?: string; onConfirm: () => void;
  className?: string; disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);

  return (
    <button
      type="button"
      disabled={disabled}
      className={cx('btn', armed ? 'btn--accent' : '', className)}
      onClick={() => {
        if (armed) { onConfirm(); setArmed(false); } else setArmed(true);
      }}
    >
      {armed ? confirmLabel : children}
    </button>
  );
}
