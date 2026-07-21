# Architecture

```
                 ┌──────────────────────────────────────────────┐
                 │  WORLD SIMULATOR          (hidden ground truth)│
                 │  sites · zones · guards · robots · regularities│
                 └───────────────┬──────────────────────────────┘
                                 │ SecurityEvent   (truth stripped)
                                 ▼
┌───────────────────────────────────────────────────────────────────────┐
│  EVIDENCE ASSEMBLY                                                    │
│  check_zone_history · recall_similar · correlate · consult_playbook    │
│  get_available_responders · get_zone_context                          │
└───────────────┬───────────────────────────────────────────────────────┘
                │ evidence + EvidenceRef[] (citations)
                ▼
┌───────────────────────────────────────────────────────────────────────┐
│  JUDGMENT     Claude (Opus 4.8, adaptive thinking)  ──or──  Reasoner   │
│               → AgentDecision { action, priority, severity, pFalse,    │
│                 confidence, responder, rationale, evidence[] }         │
└───────────────┬───────────────────────────────────────────────────────┘
                │
                ▼
┌───────────────────────────────────────────────────────────────────────┐
│  ACTION       dispatch · escalate · monitor · suppress                 │
└───────────────┬───────────────────────────────────────────────────────┘
                │
                ▼
┌───────────────────────────────────────────────────────────────────────┐
│  OUTCOME      simulator reveals truth · responder accepted? resolved?  │
│               operator confirmed or overrode?                          │
└───────────────┬───────────────────────────────────────────────────────┘
                │                                          ▲
                ▼                                          │
┌───────────────────────────────────────────────────────────┴───────────┐
│  MEMORY  (four channels — this is the feedback loop)                   │
│  A  Calibration   Beta-Bernoulli P(real) per zone×type×hour, w/ backoff│
│  B  Responders    Beta posteriors + Thompson sampling over guards      │
│  C  Playbook      LLM-drafted SOP rules, human-approved, auto-retired  │
│  D  Precedent     nearest-neighbour retrieval over resolved incidents  │
└───────────────────────────────────────────────────────────────────────┘
```

## The one structural decision that matters

The pipeline is split into **evidence assembly** (deterministic, memory-driven)
and **judgment** (the LLM). Both arms of the eval share evidence assembly; only the
memory varies. That is what isolates the *learning* contribution from the
*model* contribution and makes the A/B result mean something.

It also buys three things for free:

- **Runs with no API key.** Swap the judgment layer for `ReasonerAgent` — an
  explicit expected-cost policy — and the entire product still works. A reviewer
  who can't get a key still sees everything.
- **Fast, free evals.** 400-event replays run in seconds instead of costing dollars.
- **Attribution.** Because evidence is gathered through typed tools, every decision
  carries `EvidenceRef[]` citing exactly which learned object moved it, with a
  signed weight. The UI renders that as the evidence rail — the agent doesn't just
  show its reasoning, it shows *which memory* caused the reasoning.

## Ground-truth containment

The single invariant the whole exercise rests on: **`EventTruth` never reaches the
agent.** It is carried alongside the event in `SeededEvent`, consulted only by
`Simulator.resolve()` for scoring, and attached to an `Incident` as `revealedTruth`
*after* the decision is made. The smoke test asserts this
(`scripts/smoke.mjs` §2) by scanning the wire payload for `isReal` / `trueSeverity`.

## Determinism

Everything simulated runs off a seeded PRNG (`Rng`, mulberry32-family) with
`fork(salt)` so subsystems don't consume each other's entropy. Same seed → same
event stream, byte for byte. Sim time is its own clock, never `Date.now()`.
That is the precondition for a replay harness that compares arms fairly.

`Date.now()` appears in exactly one place: measuring real wall-clock decision
latency, which is a genuine property of the agent, not of the world.

## Concurrency

The tick loop must never block on an LLM call. New events are emitted to the feed
immediately, incidents enter `triaging`, and decisions run asynchronously behind a
bounded queue (~3 in flight) so an event burst doesn't fan out into dozens of
parallel API calls. Trace steps stream to the UI over SSE as they are produced, so
the operator watches the agent think in real time rather than waiting for a verdict.

## Transport

One SSE stream (`GET /api/stream`) carrying a discriminated `ServerEvent` union.
The client fetches `/api/snapshot` once, then applies targeted patches — upsert
incident by id, append trace step, replace metrics wholesale. No polling, no
websocket dependency, no state-sync library.

## Persistence

Append-only JSONL (`data/incidents.jsonl`) for resolved incidents. Event-sourced
rather than a database because the domain *is* a log, replay is a first-class
feature, and it keeps the project to a single `npm install` with zero native
dependencies or external services.

## Why no framework

No Redux, no React Query, no chart library, no component kit. The store is ~120
lines on `useSyncExternalStore`; the charts are hand-rolled SVG. The reason is the
brand: an off-the-shelf chart library would have to be fought into Calvis's
zero-radius, mono-label, hairline aesthetic, and the fight costs more than the
charts. Hand-rolled SVG also let the palette be *validated* rather than inherited
(see `PALETTE.md`).
