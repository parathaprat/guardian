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

### Two things added for the people who actually have to use it

**A first-run walkthrough.** The target user is a shift supervisor who will never
read a README. Seven steps, anchored to the real controls rather than to
screenshots of them, in the language they already use. Three details make it work
rather than annoy: it pauses the world for the duration and restores the previous
run state on exit, a step whose anchor is missing degrades to a centred card
instead of pointing at nothing, and it takes the keyboard in capture phase so the
console's own single-key shortcuts stay dormant while the arrow keys drive the
tour.

**The knowledge graph.** Every other view reports what the agent knows as
numbers. This one shows its shape. The skeleton (sites and zones) is the world it
was handed; every edge between a place and an alarm type was earned from a
resolved outcome, so it begins nearly empty and visibly fills. Colour is the
learned P(real), thickness is the evidence behind it, and dashed edges are the
hierarchical backoff standing in where a zone has no history of its own, which is
exactly the cold-start question a director of security asks first.

Layout is a hand-rolled spring solver, warm-started and re-run only when the
topology changes, so new knowledge eases into place instead of the whole graph
jumping on every update. It is deliberately not a general graph library: pinning
the three sites is what keeps the picture stable enough to read as learning
rather than as churn.

Past a few dozen edges any force-directed graph is a hairball, so it is built to
be interrogated rather than admired: hovering or tabbing to a node isolates that
neighbourhood and writes out, in a sentence, what the agent believes about that
place or that alarm type. The picture is the way in; the sentence is the answer.

I would rather it look sparse and honest than dense and decorative. Reset the
memory and it goes back to nothing, which is the point.

### The hosted judgment layer, and what a free tier taught me

The judgment layer runs on **Gemini 3.1 Flash Lite**, reached through its
OpenAI-compatible endpoint over plain `fetch`. Everything vendor-neutral (the
tools, the prompt, the loop, the `TraceStep` format) sits behind an
`LlmProvider` interface; the vendor file implements only a session that can take
a turn and hand back reasoning plus tool calls.

Keeping that seam even with one provider behind it is deliberate. The entire
repo argues that the measured gain comes from the Bayesian memory rather than
from a model having a good day, and that argument only holds if the judgment
engine is genuinely swappable, which is exactly what the eval does when it holds
the engine constant and varies only memory.

**No SDK.** One documented JSON request, one documented JSON response. A
dependency would have bought retries, which are twenty lines here, and cost
control over the exact error text that reaches the trace inspector, which is the
surface this product is about. The dependency list is now Express, React and
Vite.

**The free tier chose the model.** It meters requests per day *per model*, and
the allowance is wildly uneven: `gemini-3.6-flash` grants 20 a day, which the
console spends in a minute. I only learned that by reading a 429 body, because
this endpoint sends no rate-limit headers at all and everything worth knowing is
in the error. Flash-lite has real headroom and is three times faster on this
workload, so the cheap model won on the merits rather than as a compromise.

That also set the unit of efficiency. When the meter counts *requests*, the thing
to optimise is requests per decision, not tokens per request. One-shot mode
already makes that one. Trimming ranked-list tails out of the evidence block was
worth doing anyway: 6% fewer tokens, and p90 latency fell from 7.1s to 2.0s
because the long tail was the model reading list tails nobody needed.

**Rate limits are a design constraint, not an error path.** A metered endpoint
bills the *requested* completion budget rather than what the model produces, so
unused headroom is paid for in throughput. I measured before reacting, and the
measurement changed the architecture rather than a config value.

A decision under the agentic loop cost two turns at roughly 5,400 tokens each,
because the fixed prompt is re-sent every turn. Measured against a free tier that
was more than a whole minute's allowance, so a decision **could never complete**,
and the tokens were spent anyway on calls that ended in a fallback. The first
version of that integration got 0 of 6 decisions onto the hosted model and burned
real tokens doing it.

So the loop inverts by default. The six evidence tools are deterministic, local
and free, so they run here; their results go into the prompt, their schemas come
*out* of the request, and the model is asked once for the only thing it uniquely
provides, which is the judgment. One call instead of three. What is lost is real
and I would rather name it than bury it: the agent no longer chooses its own
evidence. What the operator sees is unchanged, since the trace still shows every
tool call, every result, the reasoning and the decision. `SENTRY_EVIDENCE=agentic`
puts the multi-turn loop back for anyone who wants to watch it.

**The bug worth writing down**, because it is the kind that wastes an afternoon
and reads like something else entirely. Tool calls started coming back as
`MALFORMED_FUNCTION_CALL`, intermittently, on a schema that had been working
against another vendor for days. It reads like a schema-dialect problem, and I
started bisecting the schema.

It was not the schema. **Thinking tokens count against `max_tokens`, and they do
not appear in `completion_tokens`.** The arithmetic gave it away: prompt 3,578
plus visible output 26, against a reported total of 4,946. Something had spent
1,342 tokens I could not see. The budget was set to 700, tuned for a decision
that measures about 150 tokens, so the model was thinking its way past the
ceiling and getting truncated mid-call. The API reports that truncation as a
malformed call.

The fix is one constant, but the lesson is the one I would want a reviewer to
take: the error message named the symptom and not the cause, and the arithmetic
in the usage block was the only thing that told the truth. The budget is now 2000
with a comment explaining why, so nobody trims it back as dead headroom.

Two smaller pieces around it. The provider reads whatever budget the endpoint
reports in its response headers and declines locally when the next call cannot
fit, so an incident degrades to the Reasoner in a millisecond rather than
stalling the queue and then failing anyway. And when the window is nearly spent,
the remainder is reserved for life-safety and high-severity alarms, keyed off the
prior cost of being wrong rather than off the model's own confidence, which would
be circular. Live decisions fail fast; the human-initiated reflection pass, which
has no equally good substitute, waits out the window instead.

And the honesty rule that falls out of it: an incident records **the engine that
actually decided it**, not the one that was configured. A hosted call that was
rate-limited and fell back to the Reasoner says Reasoner on the card. A vendor
badge a decision did not earn would corrupt every claim on the Evals screen.

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

## Decision 6: Boring infrastructure, where it counts

One `npm install`, no database, no Docker, no external services, no native modules,
to run and evaluate this. Event-sourced JSONL for the audit ledger, a ~120-line store
on `useSyncExternalStore`, hand-rolled SVG charts, no model SDK. `npm run dev` and
`npm run verify` still hit exactly that path today, nothing below changes it.

Reviewers who cannot run something do not evaluate it. That is worth more than any
architectural elegance I could have bought with a heavier stack, and it is why the
deployable shape in Decision 8 is layered on top of this rather than replacing it:
the same interface that makes persistence optional is what keeps `npm run verify`
free of a network call.

## Decision 7: Put the model where a person decides, not where an alarm fires

The obvious way to spend a second LLM investment is more of it on the alarm path,
bigger context, multi-turn reasoning per event. That is also the worst place to
spend it: highest volume, tightest latency, most audited, exactly where Decision 2
argues judgment should stay cheap and swappable.

So it went somewhere the volume is bounded by a person instead of by the world:
three features, each triggered by an operator, never by an alarm.

- **Radio intake** turns a guard's own words into a dispatch. It is the one surface
  in this codebase where removing the model removes the feature rather than
  degrading it, every other fallback here is a real second opinion, this one's is
  honest keyword matching that says so out loud. It resolves the place a caller
  named against the real world, resolves "same door as last night" against the
  ledger and cites it, and returns a question instead of a guess when the report
  does not support one. A parse is a proposal; nothing is raised until a human
  confirms it.
- **Shift handover** is map-reduce over open work, changed beliefs and responder
  models: three lenses run in parallel, a fourth ranks what they found. Any console
  can print "23 incidents, 4 open." The value is knowing which of the four will
  ruin the incoming operator's night.
- **Ask** is a real tool-using loop over the memory stores, for the ops manager who
  is not going to read a Beta posterior. Every answer carries the lookups that
  produced it, in the same trace inspector the dispatch console uses.

Two rules hold across all three, enforced in code rather than asked for in a
prompt: a citation that does not resolve against the real world or ledger is
dropped before it reaches the UI, and refusal is a valid output, not a failure
state.

**The bug worth naming**, because it looked like something else. A caller saying
"dock three" was once routed by a *back-reference* to a past incident there rather
than by what the caller actually said, because the model weighted recall over the
literal statement. What the caller states now outranks what the model infers, with
the discrepancy surfaced as a question instead of resolved silently.

## Decision 8: Made it deployable, without touching what makes it fast to evaluate

The brief is an assessment, but Calvis asked for something that could plausibly
ship, so the console became a five-service stack: Postgres with pgvector, Redis, a
FastAPI embedding service, and a stateless API split from the one worker that owns
the world. `docs/ARCHITECTURE.md` has the topology; this is why it is shaped that
way.

**The constraint that mattered most: `npm run verify` could not get slower.** It
replays 20 worlds of 400 events in about two seconds specifically because the eval
never opens a socket. Adding persistence without breaking that meant it had to go
in behind an interface, `Repository`, with two implementations: an in-memory one
that is the default and that the eval actually runs on, not a test double, and a
Postgres one a live console opts into. `AgentContext.semantic` being optional
follows the same logic, the pgvector reranking is additive, and its absence is
exactly what the eval runs on.

**Only one process may own the world.** The tick loop, the agent and the incident
book all assume single-threaded mutation, so splitting API from worker meant
deciding, explicitly, that `--scale api=3` is safe (stateless readers) and
`--scale worker=2` is not (two simulators writing one database). There is no leader
election; the deployment contract enforces the constraint by simply not scaling the
worker, an honest limitation rather than a hidden one.

**What building it surfaced was mostly about honesty under restart, not new
features.** Persistence was originally bound to the moment an incident was
created rather than to every mutation on it, so the database quietly stopped
tracking an incident the instant it got a real decision, and a restart showed
everything as still "triaging." The fix binds persistence to the same function
that already emits the incident to the UI, so the set of changes worth showing an
operator became structurally the same set as what survives a restart. Separately,
a restart used to bring back every incident that was mid-decision when the process
stopped, frozen there permanently, because an in-flight incident's hidden ground
truth is deliberately never persisted (Decision 1), so it can never resolve. A
restart now inherits what the agent learned plus the resolved history, sweeps what
was interrupted, and resumes the clock from the newest thing actually on record
rather than snapping back to day one.

A restart discarding the previous operator's unfinished queue is a deliberate
choice, not a limitation, and it is worth stating because it reads like data loss.
The alternative, restoring incomplete machine decisions and calling them still in
progress, is worse: it puts stale, un-resolvable work in front of a human and
tells them it is live.

---

## What I deliberately did not build

- **Auth, tenancy, RBAC.** Real for the product, noise for the assessment. The
  schema carries `org_id` on every table so multi-tenancy is a query away rather
  than a migration, but nothing enforces it yet.
- **Fine-tuning / RLHF.** Wrong tool at this data volume. The Bayesian layer converges
  in tens of examples; a fine-tune needs thousands and would be far less inspectable.
- **A real map / floorplan import.** The SVG site map is schematic on purpose, a real
  one is integration work, not a thinking problem.
- **Multi-agent orchestration.** A single agent with good tools beats a swarm here, and
  the swarm would have made the reasoning harder to inspect, which is the point.

## What I would build next, in order

1. **Escalation chains.** The current agent decides per event. Real dispatch is a
   state machine over time: no acknowledgement in 90 seconds escalates to the
   supervisor, then to the client contact, then to PD.
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
