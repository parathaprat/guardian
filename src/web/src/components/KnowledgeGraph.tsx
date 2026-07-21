/**
 * The agent's calibration memory, drawn.
 *
 * Every other view reports what the agent knows as numbers. This one shows the
 * *shape* of it: a graph whose skeleton (sites and zones) is fixed by the world,
 * and whose knowledge (which alarm types behave which way, where) accumulates
 * edge by edge as outcomes resolve. Start it from empty and it fills in front of
 * you. That is the whole product claim in one picture.
 *
 * Three rules kept this honest rather than decorative:
 *
 *   1. Nothing is drawn that was not learned. A zone with no resolved history is
 *      visibly dim, and an alarm type appears only once it has been observed. An
 *      empty graph is a truthful graph, not a broken one.
 *   2. Edge colour is the learned P(real) and edge weight is the number of
 *      observations behind it, so a confident belief and a guess never look the
 *      same. Both are in the legend.
 *   3. Backoff is visible. When the agent has no zone-specific history it falls
 *      back to what the site does generally, and those borrowed edges are dashed.
 *      That is the cold-start story a security director will ask about.
 *
 * Layout is a hand-rolled spring/repulsion solver, warm-started from the previous
 * positions and re-run only when the topology changes, so new knowledge eases
 * into place instead of the whole graph jumping on every update.
 *
 * Past a few dozen edges any force-directed graph turns into a hairball, so this
 * one is built to be *interrogated* rather than merely admired: hovering or
 * focusing a node isolates its neighbourhood and writes out, in words, what the
 * agent believes about that place or that alarm type. The picture is the way in;
 * the sentence is the answer.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { CalibrationCell, EventType, WorldSnapshot } from '../../../shared/types';
import { EVENT_LABELS } from '../../../shared/types';
import './KnowledgeGraph.css';

// ── model ───────────────────────────────────────────────────────────────────

type NodeKind = 'site' | 'zone' | 'type';

interface GNode {
  id: string;
  kind: NodeKind;
  label: string;
  /** Owning site, for clustering. Null on type nodes, which are shared. */
  siteId: string | null;
  observations: number;
}

interface GEdge {
  id: string;
  a: string;
  b: string;
  observations: number;
  pReal: number;
  /** Site-level knowledge standing in for a zone the agent has not seen yet. */
  backoff: boolean;
}

interface Graph {
  nodes: GNode[];
  edges: GEdge[];
  /** Structural zone-to-site links. Drawn faintly; they carry no knowledge. */
  spine: Array<{ a: string; b: string }>;
  totalObservations: number;
  learnedPairs: number;
  typesSeen: number;
}

const EMPTY_GRAPH: Graph = {
  nodes: [], edges: [], spine: [], totalObservations: 0, learnedPairs: 0, typesSeen: 0,
};

function buildGraph(cells: readonly CalibrationCell[], world: WorldSnapshot): Graph {
  if (world.sites.length === 0) return EMPTY_GRAPH;

  const nodes = new Map<string, GNode>();
  const spine: Array<{ a: string; b: string }> = [];

  for (const s of world.sites) {
    nodes.set(`site:${s.id}`, {
      id: `site:${s.id}`, kind: 'site', label: s.code, siteId: s.id, observations: 0,
    });
  }
  for (const z of world.zones) {
    nodes.set(`zone:${z.id}`, {
      id: `zone:${z.id}`, kind: 'zone', label: z.code, siteId: z.siteId, observations: 0,
    });
    spine.push({ a: `zone:${z.id}`, b: `site:${z.siteId}` });
  }

  // Hour buckets are collapsed here. The heatmap below already shows the hourly
  // structure; this view is about which places and which alarm types the agent
  // has an opinion on at all.
  const merged = new Map<string, {
    a: string; b: string; obs: number; weighted: number; backoff: boolean;
  }>();
  const typesSeen = new Set<EventType>();

  for (const c of cells) {
    if (c.observations <= 0) continue;
    const typeId = `type:${c.type}`;
    const anchor = c.zoneId ? `zone:${c.zoneId}` : `site:${c.siteId}`;
    if (!nodes.has(anchor)) continue;
    typesSeen.add(c.type);

    if (!nodes.has(typeId)) {
      nodes.set(typeId, {
        id: typeId, kind: 'type', label: EVENT_LABELS[c.type], siteId: null, observations: 0,
      });
    }

    const key = `${anchor}|${typeId}`;
    const cur = merged.get(key);
    if (cur) {
      cur.obs += c.observations;
      cur.weighted += c.pReal * c.observations;
      cur.backoff = cur.backoff && c.zoneId === null;
    } else {
      merged.set(key, {
        a: anchor, b: typeId, obs: c.observations,
        weighted: c.pReal * c.observations, backoff: c.zoneId === null,
      });
    }
  }

  const edges: GEdge[] = [];
  let total = 0;
  for (const [id, m] of merged) {
    edges.push({
      id, a: m.a, b: m.b, observations: m.obs,
      pReal: m.obs > 0 ? m.weighted / m.obs : 0.5,
      backoff: m.backoff,
    });
    total += m.obs;
    const na = nodes.get(m.a);
    const nb = nodes.get(m.b);
    if (na) na.observations += m.obs;
    if (nb) nb.observations += m.obs;
  }

  return {
    nodes: [...nodes.values()],
    edges,
    spine,
    totalObservations: total,
    learnedPairs: edges.length,
    typesSeen: typesSeen.size,
  };
}

// ── layout ──────────────────────────────────────────────────────────────────

interface Pt { x: number; y: number; vx: number; vy: number }

const REPULSION = 3900;
const SPRING = 0.035;
const SPINE_SPRING = 0.11;
const DAMPING = 0.82;
const MAX_STEP = 26;
const SETTLE_ITERATIONS = 260;
const WARM_ITERATIONS = 90;
/** Extra separation between the two nodes that both carry a written caption. */
const LABEL_SPREAD = 2.4;

/** Deterministic jitter so a reload reproduces the same picture. */
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

function runLayout(
  graph: Graph,
  prev: Map<string, Pt>,
  W: number,
  H: number,
  iterations: number,
): Map<string, Pt> {
  const pos = new Map<string, Pt>();
  const siteAnchor = new Map<string, { x: number; y: number }>();

  // Sites are pinned in a row. An unpinned graph drifts and rotates between
  // updates, which reads as instability rather than as learning.
  const sites = graph.nodes.filter((n) => n.kind === 'site');
  sites.forEach((s, i) => {
    const x = ((i + 0.5) / Math.max(1, sites.length)) * W;
    const y = H * 0.5;
    siteAnchor.set(s.id, { x, y });
    pos.set(s.id, { x, y, vx: 0, vy: 0 });
  });

  for (const n of graph.nodes) {
    if (n.kind === 'site') continue;
    const old = prev.get(n.id);
    if (old) {
      pos.set(n.id, { x: old.x, y: old.y, vx: 0, vy: 0 });
      continue;
    }
    // New nodes are seeded near where they belong so they ease in rather than
    // fly across the panel.
    const anchor = n.siteId ? siteAnchor.get(`site:${n.siteId}`) : undefined;
    const base = anchor ?? { x: W * 0.5, y: H * 0.5 };
    const a = hash01(n.id) * Math.PI * 2;
    const r = n.kind === 'zone' ? H * 0.22 : H * 0.34;
    pos.set(n.id, {
      x: base.x + Math.cos(a) * r,
      y: base.y + Math.sin(a) * r,
      vx: 0, vy: 0,
    });
  }

  const springs: Array<{ a: string; b: string; k: number; rest: number }> = [];
  for (const e of graph.edges) {
    springs.push({ a: e.a, b: e.b, k: SPRING, rest: H * 0.26 });
  }
  for (const s of graph.spine) {
    springs.push({ a: s.a, b: s.b, k: SPINE_SPRING, rest: H * 0.16 });
  }

  const ids = graph.nodes.map((n) => n.id);
  const pinned = new Set(sites.map((s) => s.id));
  // Type nodes are the ones carrying long captions, so they need more room from
  // each other than the physics would otherwise give them.
  const labelled = new Set(graph.nodes.filter((n) => n.kind === 'type').map((n) => n.id));

  for (let it = 0; it < iterations; it++) {
    // Repulsion. n is small (well under 60), so the all-pairs cost is fine and
    // a quadtree would be complexity with nothing to buy.
    for (let i = 0; i < ids.length; i++) {
      const pa = pos.get(ids[i]!)!;
      for (let j = i + 1; j < ids.length; j++) {
        const pb = pos.get(ids[j]!)!;
        let dx = pa.x - pb.x;
        let dy = pa.y - pb.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) {
          // Coincident nodes have no direction to separate along; nudge them.
          dx = (hash01(ids[i]! + ids[j]!) - 0.5) * 2;
          dy = (hash01(ids[j]! + ids[i]!) - 0.5) * 2;
          d2 = dx * dx + dy * dy || 1;
        }
        const d = Math.sqrt(d2);
        const both = labelled.has(ids[i]!) && labelled.has(ids[j]!);
        const f = (both ? REPULSION * LABEL_SPREAD : REPULSION) / d2;
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        pa.vx += fx; pa.vy += fy;
        pb.vx -= fx; pb.vy -= fy;
      }
    }

    for (const s of springs) {
      const pa = pos.get(s.a);
      const pb = pos.get(s.b);
      if (!pa || !pb) continue;
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - s.rest) * s.k;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      pa.vx += fx; pa.vy += fy;
      pb.vx -= fx; pb.vy -= fy;
    }

    for (const id of ids) {
      const p = pos.get(id)!;
      if (pinned.has(id)) { p.vx = 0; p.vy = 0; continue; }
      // Mild pull to centre keeps unconnected nodes from drifting to the edge.
      p.vx += (W * 0.5 - p.x) * 0.0016;
      p.vy += (H * 0.5 - p.y) * 0.0016;

      p.vx *= DAMPING;
      p.vy *= DAMPING;
      p.x += Math.max(-MAX_STEP, Math.min(MAX_STEP, p.vx));
      p.y += Math.max(-MAX_STEP, Math.min(MAX_STEP, p.vy));

      // Asymmetric margins: type captions are drawn above their node, and the
      // readout strip occupies the bottom of the canvas. A node parked in
      // either band gets its label clipped.
      const mx = H * 0.05;
      p.x = Math.max(mx, Math.min(W - mx, p.x));
      p.y = Math.max(H * 0.09, Math.min(H * 0.84, p.y));
    }
  }

  return pos;
}

// ── sizing ──────────────────────────────────────────────────────────────────

/** Intended on-screen sizes in CSS pixels, converted to user units on render. */
const PX = {
  siteR: 15,
  zoneR: 7,
  typeR: 9,
  siteLabel: 12,
  zoneLabel: 9,
  typeLabel: 10.5,
  edgeMax: 3.4,
} as const;

function useBoxMetrics(ref: RefObject<HTMLDivElement | null>) {
  const [m, setM] = useState({ h: 560, scale: 1 });
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width <= 0 || height <= 0) return;
      // Same discipline as the site map: derive the scale from the viewBox that
      // will actually be used, so pixel-sized marks really land at that size.
      //
      // The floor matters. On a wide panel the natural aspect gives a layout box
      // 1000 by ~190, and a spring layout in a letterbox spreads into a smear.
      // Holding a minimum height lets `meet` centre a graph-shaped graph instead.
      const h = Math.max(340, Math.min(1600, (height / width) * 1000));
      setM({ h, scale: Math.min(width / 1000, height / h) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return m;
}

/** Sequential ramp, five steps. Matches the calibration heatmap exactly. */
function seqFill(pReal: number): string {
  const i = Math.max(0, Math.min(4, Math.floor(pReal * 5)));
  return `var(--seq-${i + 1})`;
}

// ── focus ───────────────────────────────────────────────────────────────────

interface Focus {
  node: GNode;
  /** Node ids to keep lit: the node itself and everything it connects to. */
  lit: Set<string>;
  edges: GEdge[];
}

function buildFocus(graph: Graph, id: string | null): Focus | null {
  if (!id) return null;
  const node = graph.nodes.find((n) => n.id === id);
  if (!node) return null;

  const lit = new Set<string>([id]);
  const edges: GEdge[] = [];
  for (const e of graph.edges) {
    if (e.a !== id && e.b !== id) continue;
    edges.push(e);
    lit.add(e.a);
    lit.add(e.b);
  }
  // A site is the parent of its zones, so keep those lit even though the spine
  // carries no knowledge: otherwise focusing a site blanks its own building.
  if (node.kind === 'site') {
    for (const s of graph.spine) if (s.b === id) lit.add(s.a);
  } else if (node.kind === 'zone' && node.siteId) {
    lit.add(`site:${node.siteId}`);
  }
  edges.sort((x, y) => y.observations - x.observations);
  return { node, lit, edges };
}

/**
 * The focused node in a sentence. The graph shows that a belief exists; this
 * says what it is, which is the part an ops manager can act on.
 */
function focusSentence(focus: Focus, labelOf: (id: string) => string): string {
  const { node, edges } = focus;
  if (edges.length === 0) {
    return node.kind === 'type'
      ? 'No resolved outcomes for this alarm type yet.'
      : 'Nothing resolved here yet, so Sentry has no opinion about this place.';
  }
  const top = edges[0]!;
  const other = labelOf(top.a === node.id ? top.b : top.a);
  const noun = node.kind === 'type' ? 'place' : 'alarm type';
  return `${edges.length} ${noun}${edges.length === 1 ? '' : 's'} · `
    + `${focus.node.observations} outcome${focus.node.observations === 1 ? '' : 's'} folded in · `
    + `strongest: ${other}, ${Math.round(top.pReal * 100)}% turned out real over ${top.observations}`
    + (top.backoff ? ', borrowed from site history' : '');
}

// ── component ───────────────────────────────────────────────────────────────

export interface KnowledgeGraphProps {
  cells: readonly CalibrationCell[];
  world: WorldSnapshot;
}

export function KnowledgeGraph({ cells, world }: KnowledgeGraphProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const { h: H, scale } = useBoxMetrics(boxRef);
  const W = 1000;
  const u = (px: number) => px / scale;

  const graph = useMemo(() => buildGraph(cells, world), [cells, world]);

  // Re-solve only when the topology changes. Edge weights and colours update on
  // every memory event, but moving every node each time would read as noise.
  const topology = useMemo(
    () => `${graph.nodes.map((n) => n.id).sort().join()}|${graph.edges.map((e) => e.id).sort().join()}`,
    [graph],
  );

  const positions = useRef(new Map<string, Pt>());
  const solvedFor = useRef<string>('');
  const solvedH = useRef(0);
  const [, forceRender] = useState(0);

  useEffect(() => {
    if (graph.nodes.length === 0) return;
    const fresh = positions.current.size === 0 || Math.abs(solvedH.current - H) > 1;
    if (!fresh && solvedFor.current === topology) return;
    positions.current = runLayout(
      graph,
      fresh ? new Map() : positions.current,
      W, H,
      fresh ? SETTLE_ITERATIONS : WARM_ITERATIONS,
    );
    solvedFor.current = topology;
    solvedH.current = H;
    forceRender((n) => n + 1);
  }, [graph, topology, H]);

  const pos = positions.current;
  const maxEdgeObs = Math.max(...graph.edges.map((e) => e.observations), 1);
  const maxNodeObs = Math.max(...graph.nodes.map((n) => n.observations), 1);

  const at = (id: string) => pos.get(id);

  // Hover explores, click pins. Pinning matters because reading the sentence
  // means moving the pointer away from the node that produced it.
  const [hovered, setHovered] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const focus = useMemo(() => buildFocus(graph, hovered ?? pinned), [graph, hovered, pinned]);

  const labelOf = (id: string) => graph.nodes.find((n) => n.id === id)?.label ?? id;
  const dimmed = (id: string) => focus !== null && !focus.lit.has(id);

  return (
    <div className="kg">
      <div className="kg-stats">
        <Stat value={world.zones.length} label="zones mapped" />
        <Stat value={graph.typesSeen} label="alarm types seen" />
        <Stat value={graph.learnedPairs} label="learned connections" accent />
        <Stat value={graph.totalObservations} label="outcomes folded in" />
      </div>

      <div className="kg-canvas" ref={boxRef}>
        {graph.totalObservations === 0 ? (
          <div className="kg-empty">
            <span className="kg-empty-mark" aria-hidden />
            <p>
              Nothing learned yet. The sites and their zones are the world Sentry was given.
              Every connection you are about to see was earned from an outcome it watched resolve.
            </p>
          </div>
        ) : null}

        <svg
          viewBox={`0 0 ${W} ${H}`}
          className={`kg-svg${focus ? ' is-focused' : ''}`}
          preserveAspectRatio="xMidYMid meet"
          onPointerLeave={() => setHovered(null)}
          role="img"
          aria-label={`Knowledge graph: ${graph.learnedPairs} learned connections across ${world.zones.length} zones from ${graph.totalObservations} resolved outcomes`}
        >
          {/* Structure the agent was given, not knowledge it earned. */}
          {graph.spine.map((s) => {
            const a = at(s.a); const b = at(s.b);
            if (!a || !b) return null;
            return (
              <line
                key={`${s.a}-${s.b}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                className="kg-spine" vectorEffect="non-scaling-stroke"
              />
            );
          })}

          {graph.edges.map((e) => {
            const a = at(e.a); const b = at(e.b);
            if (!a || !b) return null;
            const strength = e.observations / maxEdgeObs;
            const off = focus !== null && !focus.edges.some((f) => f.id === e.id);
            return (
              <line
                key={e.id}
                x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                className={`kg-edge${e.backoff ? ' is-backoff' : ''}${off ? ' is-dim' : ''}`}
                stroke={seqFill(e.pReal)}
                strokeWidth={u(0.7 + strength * PX.edgeMax)}
                strokeOpacity={off ? 0.06 : 0.3 + strength * 0.55}
              >
                <title>
                  {`${e.observations} outcome${e.observations === 1 ? '' : 's'}, `
                    + `${Math.round(e.pReal * 100)}% turned out real`
                    + (e.backoff ? ', borrowed from site-wide history' : '')}
                </title>
              </line>
            );
          })}

          {graph.nodes.map((n) => {
            const p = at(n.id);
            if (!p) return null;
            const known = n.observations > 0;
            const grow = n.kind === 'site' ? 0 : (n.observations / maxNodeObs) * 4;
            const r = n.kind === 'site' ? PX.siteR : (n.kind === 'zone' ? PX.zoneR : PX.typeR) + grow;
            const font = n.kind === 'site' ? PX.siteLabel : n.kind === 'zone' ? PX.zoneLabel : PX.typeLabel;
            const isFocus = focus?.node.id === n.id;
            return (
              <g
                key={n.id}
                className={`kg-node is-${n.kind}${known ? ' is-known' : ''}`
                  + `${dimmed(n.id) ? ' is-dim' : ''}${isFocus ? ' is-focus' : ''}`}
                style={{ transform: `translate(${p.x}px, ${p.y}px)` }}
                tabIndex={0}
                role="button"
                aria-label={`${n.label}, ${n.observations} outcomes`}
                onPointerEnter={() => setHovered(n.id)}
                onFocus={() => setHovered(n.id)}
                onBlur={() => setHovered(null)}
                onClick={() => setPinned((cur) => (cur === n.id ? null : n.id))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setPinned((cur) => (cur === n.id ? null : n.id));
                  }
                }}
              >
                {/* Generous invisible hit target: the marks are small on purpose. */}
                <circle className="kg-hit" r={u(Math.max(r + 8, 16))} />
                <title>
                  {n.kind === 'type'
                    ? `${n.label}: ${n.observations} outcomes across the portfolio`
                    : `${n.label}: ${n.observations} outcomes`}
                </title>
                {n.kind === 'site' ? (
                  <rect x={-u(r)} y={-u(r)} width={u(r * 2)} height={u(r * 2)} vectorEffect="non-scaling-stroke" />
                ) : (
                  <circle r={u(r)} vectorEffect="non-scaling-stroke" />
                )}
                <text
                  y={n.kind === 'type' ? -u(r + 5) : u(r + font + (n.kind === 'site' ? 4 : 3))}
                  fontSize={u(font)}
                >
                  {n.label}
                </text>
              </g>
            );
          })}
        </svg>

        {focus ? (
          <div className="kg-readout" role="status">
            <span className="kg-readout-kind label">
              {focus.node.kind === 'type' ? 'Alarm type' : focus.node.kind === 'site' ? 'Site' : 'Zone'}
            </span>
            <strong className="kg-readout-name">{focus.node.label}</strong>
            <span className="kg-readout-body">{focusSentence(focus, labelOf)}</span>
          </div>
        ) : graph.totalObservations > 0 ? (
          <div className="kg-readout is-hint">
            <span className="kg-readout-body">Hover any node to isolate what Sentry has learned about it. Click to pin it.</span>
          </div>
        ) : null}
      </div>

      <div className="kg-legend">
        <span className="kg-key">
          <span className="kg-key-ramp" aria-hidden>
            {[0, 1, 2, 3, 4].map((i) => <i key={i} style={{ background: `var(--seq-${i + 1})` }} />)}
          </span>
          <span className="label">nuisance to genuine</span>
        </span>
        <span className="kg-key"><span className="kg-key-thin" aria-hidden /><span className="label">thicker means more outcomes behind it</span></span>
        <span className="kg-key"><span className="kg-key-dash" aria-hidden /><span className="label">dashed: borrowed from site history, no zone data yet</span></span>
      </div>
    </div>
  );
}

function Stat({ value, label, accent }: { value: number; label: string; accent?: boolean }) {
  return (
    <div className={`kg-stat${accent ? ' is-accent' : ''}`}>
      <div className="kg-stat-v">{value.toLocaleString('en-US')}</div>
      <div className="label">{label}</div>
    </div>
  );
}
