/**
 * SENTRY chart kit, hand-rolled inline SVG, no chart library.
 *
 * Colours are emitted as `var(--token)` rather than resolved values so a theme
 * swap costs nothing and no component ever hardcodes a hex. Scales come from
 * the validated palette in tokens.css: categorical `--series-1..3` (max three,
 * fixed order), the ordinal `--arm-1..3` ramp for the eval arms, and the
 * sequential `--seq-1..5` ramp for probability magnitude.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { EvalArmId, ResolutionOutcome } from '../../../shared/types';
import './charts.css';

// ─────────────────────────────────────────────────────────────────────────────
//  PALETTE HANDLES
// ─────────────────────────────────────────────────────────────────────────────

/** Categorical identity. Assigned in fixed order, never cycled. Three is the cap. */
export const SERIES_COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)'] as const;

/** The eval arms are ordinal (static < cold < learned), so they get the arm ramp. */
export const ARM_COLORS: Record<EvalArmId, string> = {
  static: 'var(--arm-1)',
  cold: 'var(--arm-2)',
  learned: 'var(--arm-3)',
};

const ARM_RAMP = ['var(--arm-1)', 'var(--arm-2)', 'var(--arm-3)'] as const;

/** Sequential magnitude, light → dark = low → high. */
const SEQ_RAMP = ['var(--seq-1)', 'var(--seq-2)', 'var(--seq-3)', 'var(--seq-4)', 'var(--seq-5)'] as const;
const SEQ_EMPTY = 'var(--seq-empty)';

/** Outcomes are *state*, not identity, they wear status tokens. */
export const OUTCOME_COLORS: Record<ResolutionOutcome, string> = {
  true_positive: 'var(--status-good)',
  false_alarm: 'var(--status-warn)',
  missed: 'var(--status-crit)',
  declined: 'var(--status-serious)',
  unresolved: 'var(--text-muted)',
};

export const OUTCOME_LABELS: Record<ResolutionOutcome, string> = {
  true_positive: 'True positive',
  false_alarm: 'False alarm',
  missed: 'Missed',
  declined: 'Declined',
  unresolved: 'Unresolved',
};

const OUTCOME_ORDER: ResolutionOutcome[] = [
  'true_positive', 'false_alarm', 'missed', 'declined', 'unresolved',
];

/** Build donut slices for the outcome mix, dropping empty buckets. */
export function outcomeSlices(counts: Partial<Record<ResolutionOutcome, number>>): DonutSlice[] {
  return OUTCOME_ORDER
    .map((id) => ({ id, label: OUTCOME_LABELS[id], value: counts[id] ?? 0, color: OUTCOME_COLORS[id] }))
    .filter((s) => s.value > 0);
}

// ─────────────────────────────────────────────────────────────────────────────
//  SCALE + PATH MATH
// ─────────────────────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function niceStep(range: number, round: boolean): number {
  if (range <= 0) return 1;
  const exp = Math.floor(Math.log10(range));
  const f = range / 10 ** exp;
  const nf = round
    ? (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10)
    : (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10);
  return nf * 10 ** exp;
}

/** Clean tick values covering [min,max]; the last entry is the domain max. */
function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (max <= min) return [min, min + 1];
  const step = niceStep(niceStep(max - min, false) / Math.max(1, count - 1), true);
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = start; v <= end + step * 1e-6; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

/** Column with a 4px rounded cap and a square baseline, the house bar shape. */
function barPath(x: number, y: number, w: number, h: number, radius = 4): string {
  const r = Math.max(0, Math.min(radius, w / 2, h));
  if (r < 0.5) return `M${x} ${y}h${w}v${h}h${-w}Z`;
  return `M${x} ${y + h}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}H${x + w - r}` +
    `A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h}Z`;
}

function polar(cx: number, cy: number, r: number, a: number): { x: number; y: number } {
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

function ringArc(cx: number, cy: number, rOut: number, rIn: number, a0: number, a1: number): string {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const o0 = polar(cx, cy, rOut, a0);
  const o1 = polar(cx, cy, rOut, a1);
  const i1 = polar(cx, cy, rIn, a1);
  const i0 = polar(cx, cy, rIn, a0);
  return `M${o0.x} ${o0.y}A${rOut} ${rOut} 0 ${large} 1 ${o1.x} ${o1.y}` +
    `L${i1.x} ${i1.y}A${rIn} ${rIn} 0 ${large} 0 ${i0.x} ${i0.y}Z`;
}

/** Approximate mono-glyph truncation, cheaper than measuring, close enough at 9px. */
function truncateToWidth(s: string, px: number, charPx = 5.7): string {
  const max = Math.floor(px / charPx);
  if (s.length <= max) return s;
  return max <= 1 ? '…' : `${s.slice(0, max - 1)}…`;
}

const defaultFormat = (v: number): string =>
  !Number.isFinite(v) ? '-'
    : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US')
      : Math.abs(v) >= 10 ? v.toFixed(0)
        : Number(v.toFixed(2)).toString();

// ─────────────────────────────────────────────────────────────────────────────
//  LAYOUT HOOK
// ─────────────────────────────────────────────────────────────────────────────

export interface Size {
  width: number;
  height: number;
}

/** Measures the element it is attached to. Returns 0×0 until first observation. */
export function useResizeObserver<T extends HTMLElement>(): {
  ref: React.RefObject<T | null>;
  width: number;
  height: number;
} {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = (w: number, h: number) => {
      setSize((prev) => (prev.width === w && prev.height === h ? prev : { width: w, height: h }));
    };
    if (typeof ResizeObserver === 'undefined') {
      read(el.clientWidth, el.clientHeight);
      return;
    }
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) read(Math.round(box.width), Math.round(box.height));
    });
    ro.observe(el);
    read(el.clientWidth, el.clientHeight);
    return () => ro.disconnect();
  }, []);

  return { ref, width: size.width, height: size.height };
}

// ─────────────────────────────────────────────────────────────────────────────
//  SHARED CHROME
// ─────────────────────────────────────────────────────────────────────────────

export interface TipRow {
  label: string;
  value: string;
  color?: string;
  /** `line` for line series, `swatch` for bars/areas/cells, mirrors the mark. */
  mark?: 'line' | 'swatch';
  strong?: boolean;
}

interface TipState {
  x: number;
  y: number;
  title: string;
  sub?: string;
  rows: TipRow[];
  note?: string;
}

const TIP_HALF = 96;

function ChartTip({ tip, width }: { tip: TipState | null; width: number }) {
  if (!tip) return null;
  const left = clamp(tip.x, TIP_HALF, Math.max(TIP_HALF, width - TIP_HALF));
  const style: CSSProperties = { left: `${left}px`, top: `${Math.max(0, tip.y)}px` };
  return (
    <div className="chart-tip" style={style} role="status" aria-live="polite">
      <div className="chart-tip-title">{tip.title}</div>
      {tip.sub ? <div className="chart-tip-sub">{tip.sub}</div> : null}
      {tip.rows.map((r) => (
        <div className="chart-tip-row" key={`${r.label}:${r.value}`}>
          <span
            className={r.mark === 'line' ? 'chart-tip-key chart-tip-key--line' : 'chart-tip-key'}
            style={r.color ? { background: r.color } : undefined}
          />
          <span className="chart-tip-val">{r.value}</span>
          <span className="chart-tip-label">{r.label}</span>
        </div>
      ))}
      {tip.note ? <div className="chart-tip-note">{tip.note}</div> : null}
    </div>
  );
}

export interface LegendItem {
  id: string;
  label: string;
  color: string;
  value?: string;
  mark?: 'line' | 'swatch';
}

/** Always rendered for two or more series, identity is never colour-alone. */
function ChartLegend({
  items, rows = false, onHover, activeId,
}: {
  items: LegendItem[];
  rows?: boolean;
  onHover?: (id: string | null) => void;
  activeId?: string | null;
}) {
  if (items.length === 0) return null;
  return (
    <ul className={rows ? 'chart-legend chart-legend--rows' : 'chart-legend'}>
      {items.map((it) => (
        <li
          key={it.id}
          className={activeId && activeId !== it.id ? 'chart-legend-item is-dim' : 'chart-legend-item'}
          onPointerEnter={onHover ? () => onHover(it.id) : undefined}
          onPointerLeave={onHover ? () => onHover(null) : undefined}
        >
          <span
            className={it.mark === 'line' ? 'chart-legend-key chart-legend-key--line' : 'chart-legend-key'}
            style={{ background: it.color }}
          />
          <span className="chart-legend-label">{it.label}</span>
          {it.value !== undefined ? <span className="chart-legend-value">{it.value}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function ChartEmpty({ label, height }: { label: string; height: number }) {
  return (
    <div className="chart-empty" style={{ minHeight: `${Math.max(72, height)}px` }}>
      <span className="label">{label}</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  GROUPED BARS , the eval-arm comparison
// ─────────────────────────────────────────────────────────────────────────────

export interface BarSeries {
  id: string;
  label: string;
  /** Defaults to the ordinal arm ramp (or the categorical scale when palette='series'). */
  color?: string;
}

export interface BarGroup {
  id: string;
  label: string;
  sublabel?: string;
  /** seriesId → value. Missing keys are simply not drawn. */
  values: Record<string, number>;
}

export interface GroupedBarsProps {
  groups: BarGroup[];
  /** Max three. A fourth series is a facet, not a colour. */
  series: BarSeries[];
  height?: number;
  /** Formats the direct label, the axis ticks, and the tooltip value. */
  format?: (v: number) => string;
  /** Hard domain cap, e.g. 1 for rate metrics. */
  yMax?: number;
  palette?: 'arm' | 'series';
  valueLabels?: boolean;
  title?: string;
  emptyLabel?: string;
  className?: string;
}

const BAR_GAP = 2;      // the surface gap between adjacent bars
const BAR_MAX_W = 24;

export function GroupedBars({
  groups, series, height = 220, format = defaultFormat, yMax, palette = 'arm',
  valueLabels = true, title = 'Comparison', emptyLabel = 'No comparison data yet',
  className,
}: GroupedBarsProps) {
  const { ref, width } = useResizeObserver<HTMLDivElement>();
  const [tip, setTip] = useState<TipState | null>(null);
  const [activeSeries, setActiveSeries] = useState<string | null>(null);

  const cols = useMemo(
    () => series.slice(0, 3).map((s, i) => ({
      ...s,
      color: s.color ?? (palette === 'series' ? SERIES_COLORS[i] : ARM_RAMP[i]),
    })),
    [series, palette],
  );

  const legend = cols.map<LegendItem>((s) => ({ id: s.id, label: s.label, color: s.color, mark: 'swatch' }));
  const hasData = groups.length > 0 && cols.length > 0;

  const m = { top: 22, right: 10, bottom: 30, left: 46 };
  const plotW = Math.max(0, width - m.left - m.right);
  const plotH = Math.max(0, height - m.top - m.bottom);

  const observedMax = hasData
    ? Math.max(0, ...groups.flatMap((g) => cols.map((c) => (Number.isFinite(g.values[c.id]) ? g.values[c.id] : 0))))
    : 0;
  const ticks = niceTicks(0, yMax ?? (observedMax > 0 ? observedMax : 1), 4);
  const domainMax = yMax ?? ticks[ticks.length - 1];
  const yOf = (v: number) => m.top + plotH - (clamp(v, 0, domainMax) / domainMax) * plotH;

  const bandW = hasData ? plotW / groups.length : 0;
  const innerW = bandW * 0.74;
  const barW = Math.min(BAR_MAX_W, Math.max(3, (innerW - BAR_GAP * (cols.length - 1)) / cols.length));
  const clusterW = barW * cols.length + BAR_GAP * (cols.length - 1);

  return (
    <div className={className ? `chart ${className}` : 'chart'} ref={ref}>
      {!hasData || width === 0 ? (
        <ChartEmpty label={emptyLabel} height={height} />
      ) : (
        <>
          <svg
            className="chart-svg"
            width={width}
            height={height}
            role="img"
            aria-label={title}
            onPointerLeave={() => setTip(null)}
          >
            <title>{title}</title>

            {ticks.map((t) => (
              <g key={t}>
                <line
                  className="chart-grid"
                  x1={m.left} x2={m.left + plotW}
                  y1={yOf(t)} y2={yOf(t)}
                />
                <text className="chart-axis-text" x={m.left - 8} y={yOf(t) + 3} textAnchor="end">
                  {format(t)}
                </text>
              </g>
            ))}
            <line
              className="chart-axis-line"
              x1={m.left} x2={m.left + plotW}
              y1={m.top + plotH} y2={m.top + plotH}
            />

            {groups.map((g, gi) => {
              const bandX = m.left + gi * bandW;
              const startX = bandX + (bandW - clusterW) / 2;
              return (
                <g key={g.id}>
                  {cols.map((c, ci) => {
                    const raw = g.values[c.id];
                    if (!Number.isFinite(raw)) return null;
                    const x = startX + ci * (barW + BAR_GAP);
                    const y = yOf(raw);
                    const h = m.top + plotH - y;
                    const dim = activeSeries !== null && activeSeries !== c.id;
                    return (
                      <g key={c.id}>
                        <path
                          d={barPath(x, y, barW, Math.max(h, 1))}
                          fill={c.color}
                          opacity={dim ? 0.28 : 1}
                        />
                        {valueLabels && barW >= 15 ? (
                          <text
                            className="chart-value-text"
                            x={x + barW / 2}
                            y={y - 6}
                            textAnchor="middle"
                            opacity={dim ? 0.35 : 1}
                          >
                            {format(raw)}
                          </text>
                        ) : null}
                        {/* Hit target spans the full column height plus the surface gap. */}
                        <rect
                          x={x - BAR_GAP} y={m.top} width={barW + BAR_GAP * 2} height={plotH}
                          fill="transparent"
                          tabIndex={0}
                          role="button"
                          aria-label={`${g.label}, ${c.label}, ${format(raw)}`}
                          onFocus={() => {
                            setActiveSeries(c.id);
                            setTip({ x: x + barW / 2, y: y - 14, title: g.label, rows: [{ label: c.label, value: format(raw), color: c.color, mark: 'swatch' }] });
                          }}
                          onBlur={() => { setActiveSeries(null); setTip(null); }}
                          onPointerEnter={() => {
                            setActiveSeries(c.id);
                            setTip({
                              x: x + barW / 2,
                              y: y - 14,
                              title: g.label,
                              sub: g.sublabel,
                              rows: cols
                                .filter((cc) => Number.isFinite(g.values[cc.id]))
                                .map((cc) => ({
                                  label: cc.label,
                                  value: format(g.values[cc.id]),
                                  color: cc.color,
                                  mark: 'swatch' as const,
                                  strong: cc.id === c.id,
                                })),
                            });
                          }}
                          onPointerLeave={() => { setActiveSeries(null); setTip(null); }}
                        />
                      </g>
                    );
                  })}
                  <text
                    className="chart-axis-text"
                    x={bandX + bandW / 2}
                    y={m.top + plotH + 15}
                    textAnchor="middle"
                  >
                    {truncateToWidth(g.label, bandW - 6)}
                  </text>
                  {g.sublabel ? (
                    <text
                      className="chart-axis-text chart-axis-text--faint"
                      x={bandX + bandW / 2}
                      y={m.top + plotH + 26}
                      textAnchor="middle"
                    >
                      {truncateToWidth(g.sublabel, bandW - 6)}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </svg>
          <ChartTip tip={tip} width={width} />
          {legend.length >= 2 ? (
            <ChartLegend items={legend} onHover={setActiveSeries} activeId={activeSeries} />
          ) : null}
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  LINE CHART , the learning curve
// ─────────────────────────────────────────────────────────────────────────────

export interface LinePoint {
  x: number;
  /** null breaks the line rather than interpolating across a gap. */
  y: number | null;
}

export interface LineSeriesData {
  id: string;
  label: string;
  points: LinePoint[];
  color?: string;
}

export interface LineChartProps {
  /** Max three. Series beyond the third are dropped, facet instead. */
  series: LineSeriesData[];
  height?: number;
  /** Pin the y domain to [0,1] for rate metrics. */
  clamp01?: boolean;
  yMin?: number;
  yMax?: number;
  xFormat?: (x: number) => string;
  yFormat?: (y: number) => string;
  /** A ~10% wash under the first series only, never under all of them. */
  area?: boolean;
  /** Label the final point of each series when the ends do not collide. */
  endLabels?: boolean;
  title?: string;
  emptyLabel?: string;
  className?: string;
}

export function LineChart({
  series, height = 240, clamp01 = false, yMin, yMax,
  xFormat = defaultFormat, yFormat = defaultFormat, area = true, endLabels = true,
  title = 'Trend', emptyLabel = 'Not enough history yet', className,
}: LineChartProps) {
  const { ref, width } = useResizeObserver<HTMLDivElement>();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const gid = useId().replace(/[:]/g, '');

  const lines = useMemo(
    () => series.slice(0, 3).map((s, i) => ({ ...s, color: s.color ?? SERIES_COLORS[i] })),
    [series],
  );

  const xs = useMemo(() => {
    const set = new Set<number>();
    for (const s of lines) for (const p of s.points) if (Number.isFinite(p.x)) set.add(p.x);
    return [...set].sort((a, b) => a - b);
  }, [lines]);

  const lookups = useMemo(
    () => lines.map((s) => {
      const map = new Map<number, number | null>();
      for (const p of s.points) map.set(p.x, p.y);
      return map;
    }),
    [lines],
  );

  const hasData = xs.length >= 2;
  const m = { top: 14, right: 46, bottom: 26, left: 46 };
  const plotW = Math.max(0, width - m.left - m.right);
  const plotH = Math.max(0, height - m.top - m.bottom);

  const yValues = lines.flatMap((s) => s.points.map((p) => p.y).filter((y): y is number => y !== null && Number.isFinite(y)));
  const rawMin = clamp01 ? 0 : (yMin ?? (yValues.length ? Math.min(...yValues) : 0));
  const rawMax = clamp01 ? 1 : (yMax ?? (yValues.length ? Math.max(...yValues) : 1));
  const ticks = clamp01 ? [0, 0.25, 0.5, 0.75, 1] : niceTicks(Math.min(0, rawMin), rawMax, 4);
  const dMin = clamp01 ? 0 : ticks[0];
  const dMax = clamp01 ? 1 : ticks[ticks.length - 1];

  const x0 = xs.length ? xs[0] : 0;
  const x1 = xs.length ? xs[xs.length - 1] : 1;
  const xOf = (x: number) => m.left + (x1 === x0 ? 0 : ((x - x0) / (x1 - x0)) * plotW);
  const yOf = (y: number) => m.top + plotH - ((clamp(y, dMin, dMax) - dMin) / (dMax - dMin || 1)) * plotH;

  /** Contiguous non-null runs, so a gap in the data reads as a gap. */
  const runsOf = (s: { points: LinePoint[] }): Array<Array<{ x: number; y: number }>> => {
    const runs: Array<Array<{ x: number; y: number }>> = [];
    let cur: Array<{ x: number; y: number }> = [];
    for (const p of [...s.points].sort((a, b) => a.x - b.x)) {
      if (p.y === null || !Number.isFinite(p.y)) {
        if (cur.length) runs.push(cur);
        cur = [];
      } else {
        cur.push({ x: p.x, y: p.y });
      }
    }
    if (cur.length) runs.push(cur);
    return runs;
  };

  const snapped = useMemo(() => {
    if (hoverX === null || xs.length === 0) return null;
    let best = xs[0];
    let bestD = Infinity;
    for (const x of xs) {
      const d = Math.abs(xOf(x) - hoverX);
      if (d < bestD) { bestD = d; best = x; }
    }
    return best;
    // xOf depends on width/domain, all captured on each render
  }, [hoverX, xs, width, x0, x1, plotW]);

  const onMove = useCallback((ev: ReactPointerEvent<SVGRectElement>) => {
    const host = hostRef.current;
    if (!host) return;
    const box = host.getBoundingClientRect();
    setHoverX(ev.clientX - box.left);
  }, []);

  const tip: TipState | null = snapped === null ? null : {
    x: xOf(snapped),
    y: 6,
    title: xFormat(snapped),
    rows: lines.map((s, i) => {
      const y = lookups[i].get(snapped);
      return {
        label: s.label,
        value: y === null || y === undefined ? '-' : yFormat(y),
        color: s.color,
        mark: 'line' as const,
      };
    }),
  };

  // End labels only survive when the series separate at the right edge.
  const endPoints = lines.map((s) => {
    const runs = runsOf(s);
    const last = runs[runs.length - 1];
    return last && last.length ? last[last.length - 1] : null;
  });
  const endsCollide = (() => {
    const ys = endPoints.filter((p): p is { x: number; y: number } => p !== null).map((p) => yOf(p.y));
    ys.sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i += 1) if (ys[i] - ys[i - 1] < 13) return true;
    return false;
  })();

  const legend = lines.map<LegendItem>((s) => ({ id: s.id, label: s.label, color: s.color, mark: 'line' }));

  return (
    <div
      className={className ? `chart ${className}` : 'chart'}
      ref={(node) => { ref.current = node; hostRef.current = node; }}
    >
      {!hasData || width === 0 ? (
        <ChartEmpty label={emptyLabel} height={height} />
      ) : (
        <>
          <svg className="chart-svg" width={width} height={height} role="img" aria-label={title}>
            <title>{title}</title>
            <defs>
              {lines.map((s, i) => (
                <linearGradient key={s.id} id={`${gid}-a${i}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={s.color} stopOpacity="0.16" />
                  <stop offset="100%" stopColor={s.color} stopOpacity="0.01" />
                </linearGradient>
              ))}
            </defs>

            {ticks.map((t) => (
              <g key={t}>
                <line className="chart-grid" x1={m.left} x2={m.left + plotW} y1={yOf(t)} y2={yOf(t)} />
                <text className="chart-axis-text" x={m.left - 8} y={yOf(t) + 3} textAnchor="end">
                  {yFormat(t)}
                </text>
              </g>
            ))}

            {area && lines.length > 0
              ? runsOf(lines[0]).map((run, ri) => (
                <path
                  key={`area-${ri}`}
                  d={`M${xOf(run[0].x)} ${m.top + plotH}` +
                    run.map((p) => `L${xOf(p.x)} ${yOf(p.y)}`).join('') +
                    `L${xOf(run[run.length - 1].x)} ${m.top + plotH}Z`}
                  fill={`url(#${gid}-a0)`}
                />
              ))
              : null}

            {lines.map((s, i) => runsOf(s).map((run, ri) => (
              <path
                key={`${s.id}-${ri}`}
                d={run.map((p, k) => `${k === 0 ? 'M' : 'L'}${xOf(p.x)} ${yOf(p.y)}`).join('')}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )))}

            {snapped !== null ? (
              <g>
                <line
                  className="chart-crosshair"
                  x1={xOf(snapped)} x2={xOf(snapped)}
                  y1={m.top} y2={m.top + plotH}
                />
                {lines.map((s, i) => {
                  const y = lookups[i].get(snapped);
                  if (y === null || y === undefined || !Number.isFinite(y)) return null;
                  return (
                    <circle
                      key={s.id}
                      cx={xOf(snapped)} cy={yOf(y)} r={4}
                      fill={s.color} stroke="var(--surface)" strokeWidth={2}
                    />
                  );
                })}
              </g>
            ) : null}

            {endPoints.map((p, i) => {
              if (!p) return null;
              return (
                <g key={`end-${lines[i].id}`}>
                  <circle
                    cx={xOf(p.x)} cy={yOf(p.y)} r={3.5}
                    fill={lines[i].color} stroke="var(--surface)" strokeWidth={2}
                  />
                  {endLabels && !endsCollide ? (
                    <text className="chart-value-text" x={xOf(p.x) + 8} y={yOf(p.y) + 3}>
                      {yFormat(p.y)}
                    </text>
                  ) : null}
                </g>
              );
            })}

            <line
              className="chart-axis-line"
              x1={m.left} x2={m.left + plotW} y1={m.top + plotH} y2={m.top + plotH}
            />
            <text className="chart-axis-text" x={m.left} y={m.top + plotH + 16}>{xFormat(x0)}</text>
            <text className="chart-axis-text" x={m.left + plotW} y={m.top + plotH + 16} textAnchor="end">
              {xFormat(x1)}
            </text>

            <rect
              x={m.left} y={m.top} width={plotW} height={plotH}
              fill="transparent"
              onPointerMove={onMove}
              onPointerLeave={() => setHoverX(null)}
            />
          </svg>
          <ChartTip tip={tip} width={width} />
          {legend.length >= 2 ? <ChartLegend items={legend} /> : null}
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  HEATMAP , the calibration grid
// ─────────────────────────────────────────────────────────────────────────────

export interface HeatAxisItem {
  id: string;
  label: string;
}

export interface HeatCell {
  rowId: string;
  colId: string;
  /** 0..1 magnitude. P(real) for the calibration grid. */
  value: number;
  /** Credible-interval half-width; drives the uncertainty hatch. */
  uncertainty?: number;
  observations?: number;
}

export interface HeatmapProps {
  rows: HeatAxisItem[];
  cols: HeatAxisItem[];
  cells: HeatCell[];
  cellHeight?: number;
  labelWidth?: number;
  valueFormat?: (v: number) => string;
  /** Above this half-width the cell is hatched: the number is not yet trustworthy. */
  uncertaintyThreshold?: number;
  legend?: boolean;
  legendLabel?: string;
  title?: string;
  emptyLabel?: string;
  className?: string;
  onCellClick?: (cell: HeatCell) => void;
}

function seqFill(value: number, observations: number): string {
  if (observations <= 0) return SEQ_EMPTY;
  const idx = clamp(Math.floor(clamp(value, 0, 0.9999) * SEQ_RAMP.length), 0, SEQ_RAMP.length - 1);
  return SEQ_RAMP[idx];
}

export function Heatmap({
  rows, cols, cells, cellHeight = 22, labelWidth = 104,
  valueFormat = (v) => `${Math.round(v * 100)}%`,
  uncertaintyThreshold = 0.16, legend = true, legendLabel = 'P(real)',
  title = 'Calibration grid', emptyLabel = 'No observations yet', className, onCellClick,
}: HeatmapProps) {
  const { ref, width } = useResizeObserver<HTMLDivElement>();
  const [tip, setTip] = useState<TipState | null>(null);
  const hatchId = `hatch-${useId().replace(/[:]/g, '')}`;

  const index = useMemo(() => {
    const map = new Map<string, HeatCell>();
    for (const c of cells) map.set(`${c.rowId}|${c.colId}`, c);
    return map;
  }, [cells]);

  const headerH = 16;
  const plotW = Math.max(0, width - labelWidth);
  const colW = cols.length > 0 ? plotW / cols.length : 0;
  const height = headerH + rows.length * cellHeight;
  const hasData = rows.length > 0 && cols.length > 0 && width > 0;
  const labelEvery = colW < 32 ? 2 : 1;

  return (
    <div className={className ? `chart ${className}` : 'chart'} ref={ref}>
      {!hasData ? (
        <ChartEmpty label={emptyLabel} height={120} />
      ) : (
        <>
          <svg
            className="chart-svg"
            width={width}
            height={height}
            role="img"
            aria-label={title}
            onPointerLeave={() => setTip(null)}
          >
            <title>{title}</title>
            <defs>
              <pattern id={hatchId} patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
                <line x1="0" y1="0" x2="0" y2="6" stroke="var(--surface)" strokeWidth="1.6" opacity="0.62" />
              </pattern>
            </defs>

            {cols.map((c, ci) => (
              ci % labelEvery === 0 ? (
                <text
                  key={c.id}
                  className="chart-axis-text"
                  x={labelWidth + ci * colW + colW / 2}
                  y={11}
                  textAnchor="middle"
                >
                  {truncateToWidth(c.label, colW * labelEvery - 4)}
                </text>
              ) : null
            ))}

            {rows.map((r, ri) => {
              const y = headerH + ri * cellHeight;
              return (
                <g key={r.id}>
                  <text className="chart-axis-text chart-axis-text--row" x={0} y={y + cellHeight / 2 + 3}>
                    {truncateToWidth(r.label, labelWidth - 10)}
                  </text>
                  {cols.map((c, ci) => {
                    const cell = index.get(`${r.id}|${c.id}`);
                    const obs = cell?.observations ?? 0;
                    const unc = cell?.uncertainty ?? 0;
                    const value = cell?.value ?? 0;
                    const x = labelWidth + ci * colW;
                    const w = Math.max(1, colW - 2);
                    const h = Math.max(1, cellHeight - 2);
                    const desc = obs === 0
                      ? 'no observations'
                      : `${valueFormat(value)} ±${Math.round(unc * 100)}pp · n=${obs}`;
                    return (
                      <g key={c.id}>
                        <rect
                          x={x + 1} y={y + 1} width={w} height={h}
                          fill={seqFill(value, obs)}
                        />
                        {obs > 0 && unc >= uncertaintyThreshold ? (
                          <rect x={x + 1} y={y + 1} width={w} height={h} fill={`url(#${hatchId})`} />
                        ) : null}
                        <rect
                          x={x + 1} y={y + 1} width={w} height={h}
                          fill="transparent"
                          className={onCellClick ? 'chart-cell chart-cell--action' : 'chart-cell'}
                          tabIndex={0}
                          role={onCellClick ? 'button' : 'img'}
                          aria-label={`${r.label}, ${c.label}: ${desc}`}
                          onClick={onCellClick && cell ? () => onCellClick(cell) : undefined}
                          onFocus={() => setTip({
                            x: x + colW / 2, y, title: `${r.label} · ${c.label}`,
                            rows: [{ label: legendLabel, value: obs === 0 ? '-' : valueFormat(value), color: seqFill(value, obs), mark: 'swatch' }],
                            note: obs === 0 ? 'No observations' : `±${Math.round(unc * 100)}pp · n=${obs}`,
                          })}
                          onBlur={() => setTip(null)}
                          onPointerEnter={() => setTip({
                            x: x + colW / 2, y, title: `${r.label} · ${c.label}`,
                            rows: [{ label: legendLabel, value: obs === 0 ? '-' : valueFormat(value), color: seqFill(value, obs), mark: 'swatch' }],
                            note: obs === 0 ? 'No observations' : `±${Math.round(unc * 100)}pp · n=${obs}`,
                          })}
                        />
                      </g>
                    );
                  })}
                </g>
              );
            })}
          </svg>
          <ChartTip tip={tip} width={width} />
          {legend ? (
            <div className="chart-seq-legend">
              <span className="label">{legendLabel}</span>
              <span className="chart-seq-ends">0</span>
              <span className="chart-seq-strip">
                {SEQ_RAMP.map((c, i) => (
                  <i key={c} style={{ background: c }} aria-hidden="true" title={`${i * 20}–${(i + 1) * 20}%`} />
                ))}
              </span>
              <span className="chart-seq-ends">100</span>
              <span className="chart-seq-swatch"><i style={{ background: SEQ_EMPTY }} aria-hidden="true" />no data</span>
              <span className="chart-seq-swatch chart-seq-swatch--hatch"><i aria-hidden="true" />high uncertainty</span>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  SPARKLINE
// ─────────────────────────────────────────────────────────────────────────────

export interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
  area?: boolean;
  clamp01?: boolean;
  /** Screen-reader description; also the native tooltip. */
  label?: string;
  className?: string;
}

export function Sparkline({
  values, width = 76, height = 20, color = 'var(--series-1)', area = true,
  clamp01 = false, label = 'Trend', className,
}: SparklineProps) {
  const pts = values.filter((v) => Number.isFinite(v));
  if (pts.length < 2) return <span className={className ? `spark is-empty ${className}` : 'spark is-empty'} aria-hidden="true" />;

  const lo = clamp01 ? 0 : Math.min(...pts);
  const hi = clamp01 ? 1 : Math.max(...pts);
  const span = hi - lo || 1;
  const pad = 2;
  const xOf = (i: number) => (i / (pts.length - 1)) * (width - pad * 2) + pad;
  const yOf = (v: number) => height - pad - ((v - lo) / span) * (height - pad * 2);
  const line = pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(2)} ${yOf(v).toFixed(2)}`).join('');

  return (
    <svg
      className={className ? `spark ${className}` : 'spark'}
      width={width} height={height} role="img" aria-label={label}
    >
      <title>{label}</title>
      {area ? <path d={`${line}L${xOf(pts.length - 1)} ${height}L${xOf(0)} ${height}Z`} fill={color} opacity="0.1" /> : null}
      <path d={line} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={xOf(pts.length - 1)} cy={yOf(pts[pts.length - 1])} r={2} fill={color} />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  DONUT , the outcome mix
// ─────────────────────────────────────────────────────────────────────────────

export interface DonutSlice {
  id: string;
  label: string;
  value: number;
  /** Status token, outcomes are state, not identity. */
  color: string;
}

export interface DonutProps {
  slices: DonutSlice[];
  size?: number;
  thickness?: number;
  centerLabel?: string;
  /** Defaults to the total. */
  centerValue?: string;
  format?: (v: number) => string;
  title?: string;
  emptyLabel?: string;
  className?: string;
}

export function Donut({
  slices, size = 136, thickness = 18, centerLabel = 'Resolved', centerValue,
  format = (v) => Math.round(v).toLocaleString('en-US'),
  title = 'Outcome mix', emptyLabel = 'No resolved incidents yet', className,
}: DonutProps) {
  const [active, setActive] = useState<string | null>(null);
  const [tip, setTip] = useState<TipState | null>(null);

  const data = slices.filter((s) => Number.isFinite(s.value) && s.value > 0);
  const total = data.reduce((a, s) => a + s.value, 0);
  const cx = size / 2;
  const cy = size / 2;
  const rOut = size / 2 - 1;
  const rIn = rOut - thickness;
  const rMid = (rOut + rIn) / 2;
  const pad = total > 0 && data.length > 1 ? 2 / rMid : 0; // a 2px surface gap, in radians

  let cursor = -Math.PI / 2;
  const arcs = data.map((s) => {
    const sweep = (s.value / total) * Math.PI * 2;
    const a0 = cursor + pad / 2;
    const a1 = cursor + sweep - pad / 2;
    cursor += sweep;
    return { slice: s, a0, a1, full: data.length === 1 };
  });

  const legend = data.map<LegendItem>((s) => ({
    id: s.id,
    label: s.label,
    color: s.color,
    value: `${format(s.value)} · ${Math.round((s.value / total) * 100)}%`,
    mark: 'swatch',
  }));

  return (
    <div className={className ? `chart chart--donut ${className}` : 'chart chart--donut'}>
      {total === 0 ? (
        <ChartEmpty label={emptyLabel} height={size} />
      ) : (
        <>
          <div className="chart-donut-wrap">
            <svg width={size} height={size} role="img" aria-label={title} onPointerLeave={() => { setActive(null); setTip(null); }}>
              <title>{title}</title>
              {arcs.map(({ slice, a0, a1, full }) => {
                const dim = active !== null && active !== slice.id;
                const show = () => {
                  setActive(slice.id);
                  setTip({
                    x: size / 2, y: 0, title: slice.label,
                    rows: [{ label: `of ${format(total)}`, value: `${format(slice.value)} · ${Math.round((slice.value / total) * 100)}%`, color: slice.color, mark: 'swatch' }],
                  });
                };
                const common = {
                  tabIndex: 0,
                  role: 'img',
                  'aria-label': `${slice.label}: ${format(slice.value)}, ${Math.round((slice.value / total) * 100)}%`,
                  onPointerEnter: show,
                  onFocus: show,
                  onBlur: () => { setActive(null); setTip(null); },
                  opacity: dim ? 0.32 : 1,
                };
                return full ? (
                  <circle
                    key={slice.id} cx={cx} cy={cy} r={rMid}
                    fill="none" stroke={slice.color} strokeWidth={thickness}
                    {...common}
                  />
                ) : (
                  <path key={slice.id} d={ringArc(cx, cy, rOut, rIn, a0, a1)} fill={slice.color} {...common} />
                );
              })}
              <text className="chart-donut-value" x={cx} y={cy + 1} textAnchor="middle">
                {centerValue ?? format(total)}
              </text>
              <text className="chart-donut-label" x={cx} y={cy + 15} textAnchor="middle">
                {centerLabel}
              </text>
            </svg>
            <ChartTip tip={tip} width={size} />
          </div>
          <ChartLegend items={legend} rows onHover={setActive} activeId={active} />
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  METRIC TILE
// ─────────────────────────────────────────────────────────────────────────────

export interface MetricTileProps {
  /** Mono eyebrow, e.g. "FALSE DISPATCH RATE". */
  label: string;
  value: string | number;
  unit?: string;
  /** Change vs the baseline arm, in this metric's own units. */
  delta?: number | null;
  deltaFormat?: (n: number) => string;
  /** Names the baseline, e.g. "vs static". */
  deltaLabel?: string;
  /**
   * Which direction is an improvement. Rendered as text next to the delta so
   * the reader never has to infer it from colour.
   */
  lowerIsBetter?: boolean;
  spark?: number[];
  sparkClamp01?: boolean;
  /** One hero number per screen, this is the only place `--accent` belongs. */
  hero?: boolean;
  hint?: string;
  className?: string;
  onClick?: () => void;
}

const DELTA_EPSILON = 1e-6;

export function MetricTile({
  label, value, unit, delta = null, deltaFormat, deltaLabel, lowerIsBetter,
  spark, sparkClamp01 = false, hero = false, hint, className, onClick,
}: MetricTileProps) {
  const fmtDeltaValue = deltaFormat ?? ((n: number) => `${Math.abs(n).toFixed(2)}`);
  const flat = delta === null || !Number.isFinite(delta) || Math.abs(delta) < DELTA_EPSILON;
  const good = flat || lowerIsBetter === undefined ? null : (lowerIsBetter ? delta! < 0 : delta! > 0);
  const tone = good === null ? 'is-flat' : good ? 'is-good' : 'is-bad';
  const arrow = flat ? '→' : delta! > 0 ? '↑' : '↓';
  const sparkColor = hero ? 'var(--accent)' : 'var(--series-1)';

  const body = (
    <>
      <span className="label mt-label">{label}</span>
      <span className={hero ? 'mt-value is-hero' : 'mt-value'}>
        {value}
        {unit ? <span className="mt-unit">{unit}</span> : null}
      </span>
      <span className="mt-foot">
        {delta !== null && Number.isFinite(delta) ? (
          <span className={`mt-delta ${tone}`} title={deltaLabel}>
            <span className="mt-delta-arrow" aria-hidden="true">{arrow}</span>
            {fmtDeltaValue(delta)}
            {deltaLabel ? <span className="mt-delta-base">{deltaLabel}</span> : null}
          </span>
        ) : null}
        {lowerIsBetter !== undefined ? (
          <span className="label mt-goal">{lowerIsBetter ? 'lower is better' : 'higher is better'}</span>
        ) : null}
      </span>
      {spark && spark.length > 1 ? (
        <span className="mt-spark">
          <Sparkline values={spark} width={96} height={22} color={sparkColor} clamp01={sparkClamp01} label={`${label} trend`} />
        </span>
      ) : null}
      {hint ? <span className="mt-hint">{hint}</span> : null}
    </>
  );

  const cls = ['metric-tile', hero ? 'is-hero' : '', onClick ? 'is-action' : '', className ?? '']
    .filter(Boolean).join(' ');

  return onClick
    ? <button type="button" className={cls} onClick={onClick}>{body}</button>
    : <div className={cls}>{body}</div>;
}

export type { ReactNode as ChartNode };
