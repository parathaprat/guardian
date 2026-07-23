# Architecture

## Deployment topology

```
                    ┌──────────────┐
                    │   browser    │
                    └──────┬───────┘
                           │  HTTP + SSE
                    ┌──────▼───────────────┐
                    │  api        (N of)   │  stateless: routes, SSE, ingest
                    │  no world, no clock  │
                    └───┬──────────────┬───┘
             reads      │              │  commands + event relay
          (last known)  │              │
                    ┌───▼──────┐   ┌───▼───────┐
                    │ Postgres │   │   Redis   │
                    │ +pgvector│   │  pub/sub  │
                    └───▲──────┘   └───▲───────┘
                        │              │
                    ┌───┴──────────────┴───┐
                    │  worker     (1 of)   │  the world: sim clock, agent,
                    │  owns all mutation   │  memory, decisions
                    └──────────┬───────────┘
                               │ HTTP
                    ┌──────────▼───────────┐
                    │  embed   (FastAPI)   │  sentence-transformers
                    └──────────────────────┘
```

**Exactly one process may own the world.** The tick loop advances a seeded
clock, the agent mutates learned state, and the incident book is a `Map`. Run
two of those and you do not get a scaled console, you get two consoles
disagreeing about what happened. So the worker owns all of it and the API owns
none of it, which is what makes `--scale api=3` a sensible thing to type and
`--scale worker=2` a thing the deployment contract forbids.

The API still serves a snapshot when the worker is down, because it reads the
last persisted state rather than asking. An operator mid-shift sees stale data
with a lost-stream banner instead of an empty shell.

`src/server/index.ts` runs all of it in one process and is what `npm run dev`
uses. Same routes, same handlers, one fewer moving part.

| Concern | Where |
|---|---|
| Durability behind an interface | `store/`, `Repository` in `contracts.ts` |
| Process split | `bus.ts`, `api/gateway.ts` |
| Read model for a stateless API | `api/read-model.ts` |
| Third-party alarm ingest | `api/ingest.ts` |
| Semantic precedent | `learn/semantic.ts`, `services/embed/` |

### Why the eval still runs in memory

`InMemoryRepository` is not a test double. `npm run verify` replays 20 worlds of
400 events in about **two seconds**, and it does that because the eval never
touches Postgres, never opens Redis and never calls the embedding service. A
harness that paid a round trip per incident would have quietly turned the
project's central claim into something nobody waits for.

That constraint is why persistence went in behind an interface rather than into
the stores, and why `AgentContext.semantic` is optional. The `+9.24` point lift
measures exactly what it measured before any of this existed.

## Pipeline

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
│  JUDGMENT     Gemini 3.1 Flash Lite  ─or─  deterministic Reasoner      │
│               (hosted only for life-safety / severity >= 4)            │
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
│  MEMORY  (four channels, this is the feedback loop)                   │
│  A  Calibration   Beta-Bernoulli P(real) per zone×type×hour, w/ backoff│
│  B  Responders    Beta posteriors + Thompson sampling over guards      │
│  C  Playbook      LLM-drafted SOP rules, human-approved, auto-retired  │
│  D  Precedent     nearest-neighbour retrieval over resolved incidents  │
└───────────────┬───────────────────────────────────────────────────────┘
                │ read-only
                ▼
┌───────────────────────────────────────────────────────────────────────┐
│  LANGUAGE SURFACES     (human-triggered, never on the alarm path)      │
│  Intake     free text  → structured event  → the pipeline above        │
│  Handover   memory     → map-reduce        → ranked shift briefing     │
│  Ask        question   → tool loop         → cited answer + trace      │
└───────────────────────────────────────────────────────────────────────┘
```

## Where the model sits, and why

Two placements, and the difference between them is the whole cost story.

**On the alarm path** the model is a judgment layer behind `LlmProvider`, reached
only for life-safety and severity >= 4. Everything else is the Reasoner. Volume
here is set by the world, not by a person, so this is where a metered tier dies
and where auditability matters most.

**At the language boundaries** the model is load-bearing and cheap, because a
human triggers each call. Structured events are a convenient fiction: real
operations run on radio traffic and phone calls in, and on prose out. Converting
between the two is the thing only a language model does, and nobody generates
four hundred of them an hour.

| Surface | File | Calls | Degrades to |
|---|---|---|---|
| Radio intake | `agent/intake.ts` | 1 per call | keyword matching, self-declared weak |
| Shift handover | `agent/handover.ts` | up to 4 per shift | priority ranking over open work |
| Ask | `agent/ask.ts` | 2 to 4 per question | keyword routing to one store |

Three properties hold across all three, enforced in code rather than asked for
in a prompt:

- **Ids are validated, never trusted.** A citation that does not resolve against
  the real world, ledger or store is dropped before it reaches the UI.
- **Refusal is a valid output.** Intake returns questions instead of a guess when
  a report does not support a type or a location, and the dispatch control stays
  disabled until a human closes the gap.
- **Nothing reaches ground truth.** The tools read the same stores the console
  renders, and those stores hold no `truth` field to leak.

## The one structural decision that matters

The pipeline is split into **evidence assembly** (deterministic, memory-driven)
and **judgment** (the LLM). Both arms of the eval share evidence assembly; only the
memory varies. That is what isolates the *learning* contribution from the
*model* contribution and makes the A/B result mean something.

It also buys three things for free:

- **Runs with no API key.** Swap the judgment layer for `ReasonerAgent`, an
  explicit expected-cost policy, and the entire product still works. A reviewer
  who can't get a key still sees everything.
- **Fast, free evals.** 400-event replays run in seconds instead of costing dollars.
- **Attribution.** Because evidence is gathered through typed tools, every decision
  carries `EvidenceRef[]` citing exactly which learned object moved it, with a
  signed weight. The UI renders that as the evidence rail, the agent doesn't just
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
The client fetches `/api/snapshot` once, then applies targeted patches, upsert
incident by id, append trace step, replace metrics wholesale. No polling, no
websocket dependency, no state-sync library.

## Persistence

Two layers, and they answer different questions. An append-only JSONL ledger
(`data/incidents.jsonl`) records every resolved incident regardless of which
`Repository` is configured, it is the audit trail an ops manager would ask for in
an incident review, not the store the console reads from. The `Repository`
behind `contracts.ts` is what the console actually restores from: in-memory by
default (what `npm run dev` and every eval use), Postgres when `DATABASE_URL` is
set (what the deployable stack uses). See "Why the eval still runs in memory"
above for why that split exists.

## Why no framework

No Redux, no React Query, no chart library, no component kit. The store is ~120
lines on `useSyncExternalStore`; the charts are hand-rolled SVG. The reason is the
brand: an off-the-shelf chart library would have to be fought into Calvis's
zero-radius, mono-label, hairline aesthetic, and the fight costs more than the
charts. Hand-rolled SVG also let the palette be *validated* rather than inherited.
