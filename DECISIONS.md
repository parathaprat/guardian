# Point of view

What I prioritized, what I deliberately didn't build, and what I'd build next.

---

## The problem with the obvious build

The brief asks for an agent that "gets smarter over time" and lets you define what
smarter means. The path of least resistance is:

> events → LLM call → priority score → dashboard, plus a "memory" that appends past
> examples to the prompt.

That demo looks fine and proves nothing. Prompt-stuffing is unfalsifiable, there is
no way to tell whether the agent improved, whether the improvement came from
learning or from the model having a good day, or whether it would survive a
different event stream. An ops manager evaluating a system like this has exactly one
question (*is it actually getting better, and how would I know?*) and that build
can't answer it.

So the thing I optimized for is **falsifiability**. Everything else followed.

---

## Decision 1: Build a world with hidden ground truth

You cannot measure a dispatch agent without knowing what the right answer was. So
the simulator generates every event *with* a hidden `EventTruth` (was it real, what
was the true severity, and why) that the agent never sees. It is consulted in exactly
one function (`Simulator.resolve`) and revealed to the UI only after the decision is
locked.

That single constraint is what makes every downstream claim checkable. It also gives
the UI its best moment: after an incident resolves, the console reveals the truth and
grades the agent's call. You watch it be right, and you watch it be wrong.

The regularities in the world are designed to be *learnable but not guessable*: an
HVAC vent that trips motion sensors at Dock D-3 between 02:00 and 04:30, a robot with
a degraded camera that cries glass-break, a loading-dock door-propped alarm that is
benign inside the delivery window and genuinely suspicious outside it. That last one
is deliberate: same zone, same event type, and only the *hour* flips the answer. It's
there to make the hour-bucketed calibration earn its place rather than look like
over-engineering.

**Trade-off I accepted:** a simulator is not reality. The regularities are ones I
invented, so the agent is learning a world I designed. I state this plainly in
`docs/METRICS.md` under threats to validity rather than hiding it. The structure
(hidden truth, replay, A/B) is what transfers; the specific numbers are synthetic.

## Decision 2: Split evidence assembly from judgment

The pipeline is `evidence assembly → judgment → action`. Evidence assembly is
deterministic and memory-driven; judgment is the LLM.

This is the highest-leverage decision in the codebase. It means the eval can hold the
judgment engine constant and vary *only* the memory, which isolates the learning
contribution. It also means the whole product runs with no API key (the `Reasoner`
engine is a real expected-cost policy, not a stub), evals cost nothing and finish in
seconds, and every decision can cite which memory object moved it.

## Decision 3: Three learning channels, not one

"It learns" is too vague to build. I split it into three mechanisms that fail
differently and are individually inspectable:

**A · Calibration (statistical).** Beta-Bernoulli posteriors over P(event is real),
keyed by site × zone × type × 3-hour bucket, with hierarchical backoff when a cell is
sparse. This is real Bayesian updating. It converges fast, it's explainable to a
non-technical operator ("this sensor has cried wolf 23 of 25 times at this hour"), and
it needs no LLM. Most of the measurable gain comes from here.

**B · Responder model (bandit).** Per-guard Beta posteriors on accept-rate and
resolution quality, plus running response-time stats, combined with ETA and skill fit.
Selection uses **Thompson sampling**, so the agent explores under-observed guards
instead of hammering the one it happens to trust. The console labels each choice
*exploring* or *exploiting*, because a dispatcher who can't tell those apart won't
trust the system. Nothing about guard reliability is configured; it is all learned
from whether they actually accepted and actually resolved it.

**C · Playbook (LLM reflection → human approval).** Periodically, a reflection agent
reads recent outcomes (weighting operator overrides most heavily) and drafts changes
to an explicit, versioned, human-readable SOP: new rules, edits to existing rules,
retirements. The ops manager sees a **diff** and approves or rejects per rule.

Channel C is the one I'd defend hardest in an interview. It is the difference between
"the AI got better, trust us" and "the AI drafted this policy change, here's the
evidence, here's the diff. Approve it?" Physical security is a liability-bearing,
audited domain. A black box that silently changes its dispatch behaviour is
unshippable there. A system that *proposes* policy in writing and logs who approved it
is a system a director of security can actually adopt. Rules also carry live
precision stats and auto-retire when they decay, so the playbook can't rot.

(There's a fourth, quieter channel: precedent retrieval over resolved incidents,
which is really just RAG and doesn't deserve equal billing.)

**Deliberately seeded with bad rules.** The playbook ships with two mediocre
inherited SOPs, so you can watch reflection *correct* an existing policy rather than
only write on a blank page. Improving from nothing is easy; improving from wrong is
the real job.

## Decision 4: Define "smarter" as four numbers, and prove it by replay

*Smarter* means: **fewer wasted dispatches, fewer missed critical incidents, faster
decisions, and higher agreement with the human operator.** Those roll into a composite
`dispatchScore`, weighted in `docs/METRICS.md` with the reasoning shown.

Missed criticals carry the heaviest weight, because in physical security they are the
only irreversible failure. A nuisance dispatch costs an hour of guard time; a missed
person-down costs something you cannot refund. Nuisance dispatches are weighted second
because guard trust is the actual scarce resource in this industry: a guard who has
been sent to nine false alarms will slow-walk the tenth.

The eval harness replays an **identical seeded event stream** through three arms:
`static` (fixed rules, no memory), `cold` (agent, empty memory), and `learned`
(agent, trained memory). It reports the delta. Same events, same hidden truth, same
judgment engine; only memory varies. Alongside it, a live learning curve over a
sliding window shows the running system improving in real time.

**I made the eval honest rather than flattering.** It uses a sliding window (a
cumulative average would flatten and look artificially smooth), it reports the arms
side by side instead of only the winning number, and `docs/METRICS.md` names the
threats to validity: simulator realism, online-learning order effects, and the fact
that the oracle is a proxy for a human operator rather than a human operator. If a
founder is going to trust a number, they should trust it *because* the caveats are
stated.

### The correction I made after building it

The first version of this reported three seeds as three numbers. I had picked those
seeds. Learning here is online, so each arm's decisions depend on the order events
arrived, which makes single-seed lift a draw from a distribution rather than a
measurement. Three favourable draws and a confident sentence is how a demo lies
without anyone intending it to.

So the headline claim now comes from `runExperiment`: the same protocol replayed
across 20 independently seeded worlds, reported as a win rate, a mean, and a **95%
confidence interval** computed with Student's t. `npm run verify` exits non-zero
unless the entire interval sits above zero, and both the CLI and the Evals screen
say *not established at this sample size* when it does not. Seeds are derived from
the base seed, so no seed can be chosen after its result is known.

Current result: **20/20 worlds, mean +9.24 points, 95% CI [7.93, 10.56]**, of which
+1.09 points is prior experience specifically (learned minus cold) and the rest is
learning that happens during the run.

Two things had to be fixed before that interval meant anything. The responder
bandit's Thompson sampler was falling back to `Math.random()`, so the static arm was
bit-stable while the two arms under test drifted between runs. And a check in the
smoke test asserted "learned beats static" on 120 events against memory a few
minutes old, where the honest answer is that it is close to a coin flip. I moved the
claim to where it is measurable rather than weakening it until it passed.

## Decision 5: Treat the UI as the product

The brief says "not a demo," so the console is built like a shipped tool: a fixed
frame where only inner panes scroll, keyboard navigation (`j`/`k` through the queue,
`a` confirm, `o` override, `space` play/pause), real empty states, tabular numerals
everywhere, and a dark ops theme alongside the light one.

The aesthetic is Calvis's own, taken from the live site rather than approximated:
**Metropolis** (the actual typeface, open-source under the OFL, vendored locally),
`#0D0D0D` on `#F6F6F6`, `#EA5112` used sparingly, zero border-radius, and mono
uppercase micro-labels at `.15em` tracking. The one visual thing I'd point at is that
orange is rationed, it marks the active tab, P1, and one hero number per screen, and
nothing else.

Chart color is **computed, not chosen**. Every scale was run through a palette
validator for CVD separation, chroma floor, lightness band and contrast; the
three-arm comparison turned out to be *ordinal* rather than categorical, so it takes
a single-hue ramp. The derivation, including the candidates that failed, is in
`docs/PALETTE.md`. Monochrome brands are where charts usually fall apart, and I'd
rather show the working than assert good taste.

## Decision 6: Boring infrastructure

One `npm install`, no database, no Docker, no external services, no native modules.
Event-sourced JSONL, a ~120-line store on `useSyncExternalStore`, hand-rolled SVG
charts. The entire dependency list is the Anthropic SDK, Express, React, and Vite.

Reviewers who cannot run something do not evaluate it. That is worth more than any
architectural elegance I could have bought with a heavier stack.

---

## What I deliberately did not build

- **Auth, tenancy, RBAC.** Real for the product, noise for the assessment.
- **Embedding-based retrieval.** Feature-weighted lexical similarity is enough at this
  corpus size and adds no dependency. Embeddings are a swap, not a redesign.
- **Fine-tuning / RLHF.** Wrong tool at this data volume. The Bayesian layer converges
  in tens of examples; a fine-tune needs thousands and would be far less inspectable.
- **A real map / floorplan import.** The SVG site map is schematic on purpose, a real
  one is integration work, not a thinking problem.
- **Multi-agent orchestration.** A single agent with good tools beats a swarm here, and
  the swarm would have made the reasoning harder to inspect, which is the point.

## What I would build next, in order

1. **Escalation chains and shift handover.** The current agent decides per event. Real
   dispatch is a state machine over time, no acknowledgement in 90 seconds escalates
   to the supervisor, then to the client contact, then to PD. Handover at shift change
   is where incidents actually get dropped.
2. **Cross-site transfer learning.** Right now every site learns alone. A hierarchical
   prior would let a newly onboarded site inherit the portfolio-level posterior for
   "loading dock motion at 03:00" and be useful on day one instead of week three. This
   is the highest-value item commercially, it directly attacks time-to-value for a
   new Calvis customer.
3. **Counterfactual replay on real history.** Point the harness at a customer's
   historical alarm log and answer "what would this agent have done last quarter?"
   before it ever touches production. That is the demo that closes enterprise deals.
4. **Calibrated abstention.** Let the agent say *I don't know* and route to a human,
   with the abstention threshold tuned against the operator's actual time budget.
   Knowing when not to decide is more valuable than being slightly more accurate.
5. **Cost-aware dispatch.** Guard hours are the real budget. Optimize against
   overtime, travel, and contractual SLA penalties, not just correctness.
6. **Reflection on the reasoning, not just outcomes.** Today reflection reads what
   happened. It should also read *why the agent said it happened* and catch
   systematically bad reasoning that got lucky.

## What I'd want to be challenged on

- The simulator is my own construction, so the agent is learning a world I authored.
  The methodology transfers; the specific lift numbers do not. I'd want to run item 3
  above against real data before believing any of them.
- `dispatchScore` weights encode my judgment about what matters in physical security.
  They're stated and adjustable, but they are opinions, not measurements. An ops
  director would likely reweight them, and the system should let them.
- Thompson sampling explores by occasionally dispatching a less-proven guard. That is
  correct in expectation and slightly wrong in the specific case. In production the
  exploration rate should be capped by incident priority; you don't explore on a P0.
- The confidence interval describes variation **between worlds in this simulator**.
  It is not a claim about variation between real buildings, and no amount of extra
  seeds would make it one. It rules out "you got lucky with the seed". It does not
  rule out "you got lucky with the world model".
- Most of the measured gain comes from calibration, which is counting with a prior
  on it. The playbook channel is the one I find most interesting commercially and
  the one contributing least to the number, because a human has to approve each
  rule. I would rather that be visible than quietly auto-approved to inflate a
  chart, but it does mean the headline lift understates what channel C could do and
  overstates how much of this needs an LLM at all.
