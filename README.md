<div align="center">

# SENTRY ■

**An AI dispatch agent for physical security operations.**
Watches the event stream, reasons about it, dispatches — and gets measurably better.

Built for the Calvis technical assessment.

</div>

---

## Quick start

```bash
npm install
cp .env.example .env      # optional — see below
npm run dev
```

Open **http://localhost:5173**.

That's it. No database, no Docker, no external services.

> ### It runs with no API key.
> Without `ANTHROPIC_API_KEY`, SENTRY runs its **Reasoner** engine — a real
> expected-cost decision policy, not a stub. Every feature works: the agent
> decides, the memory learns, the playbook updates, the evals run.
>
> Paste a key into `.env` and the judgment layer upgrades to **Claude Opus 4.8**
> with adaptive thinking, and the reflection agent starts authoring playbook rules
> in prose. The header pill tells you which engine is live.
>
> I made this choice deliberately: a reviewer who can't get a key still has to be
> able to evaluate the work.

```bash
npm run eval -- --seed 42 --events 400   # A/B proof, in the terminal
node scripts/smoke.mjs                   # 45-check end-to-end test
npm run build && npm start               # single-port production build
```

---

## The problem with the obvious build

The brief asks for an agent that "gets smarter over time," and leaves *smarter* to
the candidate. The path of least resistance is **events → LLM → priority score →
dashboard**, with a "memory" that appends past examples to the prompt.

That demo looks fine and proves nothing. Prompt-stuffing is unfalsifiable — you
cannot tell whether the agent improved, whether the improvement came from learning
or from the model having a good day, or whether it would survive a different event
stream. An ops manager has exactly one question — *is it actually getting better,
and how would I know?* — and that build cannot answer it.

So I optimised for **falsifiability**. Everything else followed.

## Three decisions that shaped everything

**1 · The simulator holds ground truth the agent never sees.**
Every event is generated with a hidden `EventTruth` — was it real, how severe,
why. It is consulted in exactly one function, for scoring, *after* the decision is
locked. The console reveals it afterwards and grades the call, so you watch the
agent be right and watch it be wrong. `scripts/smoke.mjs` asserts the containment
by scanning the wire payload for leaks.

**2 · Evidence assembly is split from judgment.**
`evidence → judgment → action`. Evidence is deterministic and memory-driven;
judgment is the LLM. This is what lets the eval hold the model constant and vary
*only* memory — isolating the learning contribution from the model contribution.
It also makes the no-key mode possible, makes evals free and fast, and gives every
decision an `EvidenceRef[]` citing which learned object moved it.

**3 · "Smarter" is four numbers, proven by replay.**
Fewer wasted dispatches, fewer missed criticals, faster decisions, higher operator
agreement. The harness replays an *identical seeded stream* through three arms and
reports the delta. Full definitions and threats to validity: **[docs/METRICS.md](docs/METRICS.md)**.

## How it learns

Four channels, updated only from revealed outcomes — never configured.

| | Channel | Mechanism |
|---|---|---|
| **A** | **Calibration** | Beta-Bernoulli posteriors over P(event is real) per site × zone × type × 3-hour bucket, with hierarchical backoff. Converges in tens of observations and is explainable to a non-technical operator: *"this sensor has cried wolf 23 of 25 times at this hour."* |
| **B** | **Responder model** | Per-guard Beta posteriors on accept-rate and resolution quality plus running response-time stats. Selection uses **Thompson sampling**, so the agent explores under-observed guards instead of over-trusting the one it knows. The roster labels each choice *exploring* or *exploiting*. |
| **C** | **Playbook** | A reflection agent reads recent outcomes — weighting operator overrides most heavily — and drafts changes to a versioned, human-readable SOP. The ops manager approves or rejects **per rule, as a diff**. Rules carry live precision stats and auto-retire when they decay. |
| **D** | **Precedent** | Feature-weighted nearest-neighbour over resolved incidents. The weakest channel, and weighted accordingly. |

**Channel C is the one I'd defend hardest.** Physical security is an audited,
liability-bearing domain. A black box that silently changes its dispatch behaviour
is unshippable there. A system that *proposes* policy in writing, with evidence,
and logs who approved it, is one a director of security can actually adopt.

It ships seeded with two deliberately **bad** inherited rules, so you can watch
reflection correct a wrong policy rather than only write on a blank page.

## What you're looking at

**DISPATCH** — live ingest, the prioritised queue, and the agent's reasoning. The
reasoning column is widest on purpose. Note the **sensor said / agent believes**
contrast: the device's self-reported confidence is deliberately miscalibrated in
this world, and watching the agent learn to discount it is the whole point. The
evidence rail shows *which memory* moved the decision, with signed weights. When
an incident resolves, ground truth is revealed with a right/wrong verdict.

**MEMORY** — the calibration heatmap, the responder models, and the playbook. Hit
**RUN REFLECTION NOW** to make the agent draft policy changes, then approve them
as a diff. **RESET MEMORY** wipes all four channels so you can watch it learn from zero.

**EVALS** — the A/B replay, plus the live learning curve on a sliding window.

**ROSTER** — guards and robots as learned assets. Every number was learned; the
simulator's hidden parameters are stripped server-side before the snapshot ships.

**The console is built for the person on shift**, so it opens with the decision
in plain words and the two buttons that matter, and keeps the technical surfaces
— the raw ingest feed and the tool-call trace — complete but one keystroke away.
Everything runs from the keyboard: `↑`/`↓` move the queue, `⏎` confirms, `o`
overrides, `e` shows Sentry's working, `f` shows the raw feed, `1–4` switch view,
`space` plays/pauses, `t` toggles theme, `?` lists the lot.

### Things worth trying

1. Let it run a minute at 64×, then open **MEMORY** — Dock D-3 overnight motion
   will have learned itself into a nuisance pattern (there's an HVAC vent there;
   the agent is not told).
2. **Override** a decision on DISPATCH, then **RUN REFLECTION NOW**. Overrides are
   the highest-weight training signal and reach the reflection agent directly.
3. Click a zone on the site map to **inject** a `panic_button` and watch the
   life-safety floor override the cost model.
4. **RESET MEMORY**, then run an eval, then let it run and eval again.

## Architecture

```
WORLD SIMULATOR (hidden ground truth)
      │ SecurityEvent — truth stripped
      ▼
EVIDENCE ASSEMBLY  6 tools over 4 memory channels → EvidenceRef[]
      ▼
JUDGMENT           Claude Opus 4.8  ──or──  deterministic Reasoner
      ▼
ACTION             dispatch · escalate · monitor · suppress
      ▼
OUTCOME            truth revealed · responder accepted? · operator verdict?
      └──────────────────► folded back into all four memory channels
```

Deeper notes in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**. Chart colour is
computed rather than chosen — CVD separation, chroma floor and contrast were run
through a validator, including the candidates that failed:
**[docs/PALETTE.md](docs/PALETTE.md)**.

## Design

The aesthetic is Calvis's own, taken from the live site rather than approximated:
**Metropolis** (the actual typeface, open-source under the OFL, vendored locally),
`#0D0D0D` on `#F6F6F6`, `#EA5112` rationed to the active tab / P1 / one hero
number per screen, zero border-radius, mono uppercase micro-labels at `.15em`.
There's a dark ops theme too — selected step by step, not an automatic inversion.

## Stack

TypeScript end to end. Node + Express + SSE on the server; React 19 + Vite on the
client. No database (append-only JSONL — the domain *is* a log, and replay is a
first-class feature), no state library (~120 lines on `useSyncExternalStore`), no
chart library (hand-rolled SVG, so the palette could be validated rather than
inherited). Total dependency list: the Anthropic SDK, Express, React, Vite.

## Verification

```
npm run typecheck      →  0 errors
node scripts/smoke.mjs →  45/45 checks, including ground-truth containment
npm run verify         →  typecheck + the learning claim asserted across 3 seeds
```

`npm run verify` is the one to run. It exits non-zero if the learned arm fails to
beat static on **seeds 42, 7 and 20260721** — and the same seed now gives the
same number to the digit, which it did not before ([why that took a fix](docs/METRICS.md#reproducing)).

The learning claim is deliberately *not* asserted by the smoke test: a console
eval trains its learned arm from live memory a few minutes old, over 120 events,
where beating a static table is a coin flip. Asserting it there would be a test
that fails for reasons unrelated to the code.

---

**My point of view — what I prioritised, what I deliberately skipped, what I'd
build next, and what I'd want to be challenged on — is in
[DECISIONS.md](DECISIONS.md).**
