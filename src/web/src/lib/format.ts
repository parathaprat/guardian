/**
 * Display formatters. Pure, allocation-light, and safe on garbage input — these
 * run inside render, on a stream that never stops.
 */

import type { SimTime } from '../../../shared/types';

const EM_DASH = '—';

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** HH:MM:SS on the sim clock, which is always UTC. */
export function fmtClock(ts: SimTime): string {
  if (!Number.isFinite(ts)) return '--:--:--';
  const d = new Date(ts);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/** HH:MM only — for dense tables where seconds are noise. */
export function fmtClockShort(ts: SimTime): string {
  if (!Number.isFinite(ts)) return '--:--';
  const d = new Date(ts);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/** "TUE 04:12" — used when a list spans more than a day. */
export function fmtDayClock(ts: SimTime): string {
  if (!Number.isFinite(ts)) return EM_DASH;
  const d = new Date(ts);
  return `${WEEKDAYS[d.getUTCDay()]} ${fmtClockShort(ts)}`;
}

/** "412ms" · "9.4s" · "2m 10s" · "1h 04m". Negative durations are absolutised. */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms)) return EM_DASH;
  const v = Math.abs(ms);
  if (v < 1000) return `${Math.round(v)}ms`;
  if (v < 10_000) return `${(v / 1000).toFixed(1)}s`;
  if (v < 60_000) return `${Math.round(v / 1000)}s`;
  if (v < 3_600_000) {
    const m = Math.floor(v / 60_000);
    const s = Math.round((v % 60_000) / 1000);
    return s === 0 ? `${m}m` : `${m}m ${s}s`;
  }
  const h = Math.floor(v / 3_600_000);
  const m = Math.round((v % 3_600_000) / 60_000);
  return m === 0 ? `${h}h` : `${h}h ${pad2(m)}m`;
}

/** A rate in 0..1 as a percentage. Out-of-range and NaN degrade to an em dash. */
export function fmtPct(n: number, digits = 0): string {
  if (!Number.isFinite(n)) return EM_DASH;
  return `${(n * 100).toFixed(digits)}%`;
}

const UP = '↑';
const DOWN = '↓';
const FLAT = '→';

/** Direction glyph alone — for cases that colour the arrow separately from the number. */
export function deltaArrow(n: number): string {
  if (!Number.isFinite(n) || Math.abs(n) < 1e-9) return FLAT;
  return n > 0 ? UP : DOWN;
}

/** "↑1.4" · "↓0.3" · "→0.0" — signed magnitude behind a direction glyph. */
export function fmtDelta(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return EM_DASH;
  return `${deltaArrow(n)}${Math.abs(n).toFixed(digits)}`;
}

/** Same, for deltas between two 0..1 rates — reported in percentage points. */
export function fmtDeltaPct(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return EM_DASH;
  return `${deltaArrow(n)}${Math.abs(n * 100).toFixed(digits)}pp`;
}

/** "+3" / "-3" / "0" — where the sign matters but a glyph would be too loud. */
export function fmtSigned(n: number, digits = 0): string {
  if (!Number.isFinite(n)) return EM_DASH;
  const s = n.toFixed(digits);
  return n > 0 ? `+${s}` : s;
}

export function fmtNum(n: number, digits = 0): string {
  if (!Number.isFinite(n)) return EM_DASH;
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** 1,284 → "1.3K", 4,200,000 → "4.2M". For tiles where width is scarce. */
export function fmtCompact(n: number): string {
  if (!Number.isFinite(n)) return EM_DASH;
  const v = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (v < 1000) return `${sign}${Math.round(v)}`;
  if (v < 1_000_000) return `${sign}${(v / 1000).toFixed(v < 10_000 ? 1 : 0)}K`;
  return `${sign}${(v / 1_000_000).toFixed(1)}M`;
}

/** "now" · "42s ago" · "6m ago" · "in 3m". Both clocks must be the *same* clock. */
export function relTime(ts: SimTime, now: SimTime): string {
  if (!Number.isFinite(ts) || !Number.isFinite(now)) return EM_DASH;
  const diff = now - ts;
  const v = Math.abs(diff);
  if (v < 2000) return 'now';
  const unit =
    v < 60_000 ? `${Math.round(v / 1000)}s`
    : v < 3_600_000 ? `${Math.round(v / 60_000)}m`
    : v < 86_400_000 ? `${Math.round(v / 3_600_000)}h`
    : `${Math.round(v / 86_400_000)}d`;
  return diff >= 0 ? `${unit} ago` : `in ${unit}`;
}

/** snake_case, kebab-case and plain prose all collapse to Title Case. */
export function titleCase(s: string): string {
  if (!s) return '';
  return s
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

/** Up to two letters, for responder avatars. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '??';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Calibration bucket index 0..7 → "00–03". */
export function fmtHourBucket(bucket: number): string {
  if (!Number.isFinite(bucket)) return EM_DASH;
  const start = (Math.floor(bucket) * 3) % 24;
  return `${pad2(start)}–${pad2((start + 3) % 24)}`;
}

/** Trims a long free-text field to a single scannable line. */
export function clip(s: string, max = 90): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}
