# Metrics: what "getting smarter" means, precisely

The brief leaves "smarter" to the candidate. This is my definition, the arithmetic
behind it, and an honest account of what it does not establish.

> **Smarter = fewer wasted dispatches, fewer missed critical incidents, faster
> decisions, and higher agreement with the human operator.**

Every number below is computed in `src/server/eval/metrics.ts` and scored against
ground truth the agent never sees.

---

## The metrics

| Metric | Definition | Direction |
|---|---|---|
| **falseDispatchRate** | resolved incidents where the agent dispatched *or* escalated and the event was not real ÷ all resolved incidents where it committed a responder | lower |
| **missedCriticalRate** | outcome `missed` ÷ resolved incidents whose revealed `trueSeverity ≥ 4` | lower |
| **truePositiveActionRate** | outcome `true_positive` ÷ resolved incidents that were genuinely real | higher |
| **operatorAgreementRate** | `confirm` verdicts ÷ incidents carrying operator feedback. In eval mode there is no human, so agreement is measured against the **oracle policy** instead | higher |
| **responderAcceptRate** | accepted dispatches ÷ offered dispatches | higher |
| **medianDecisionLatencyMs** | median real wall-clock from ingest to committed decision | lower |
| **medianResponseMs** | median sim-time from dispatch to on-scene, accepted dispatches only | lower |

Only **committing** actions (`dispatch`, `escalate`) count against
`falseDispatchRate`, `monitor` and `suppress` cost no guard time, so charging
them as false dispatches would punish exactly the restraint the agent is supposed
to learn.

## The composite

`dispatchScore` is 0–100:

```
0.30 × (1 − missedCriticalRate)
0.25 × (1 − falseDispatchRate)
0.20 × operatorAgreementRate
0.15 × truePositiveActionRate
0.10 × max(0, 1 − medianDecisionLatencyMs / 30 000)
```

**Why these weights.**

- **Missed criticals carry the most weight (0.30)** because in physical security
  they are the only *irreversible* failure. A nuisance dispatch costs an hour of
  guard time; a missed person-down costs something that cannot be refunded. The
  term is not linear in severity by accident, the tail is the entire risk.
- **False dispatches are second (0.25)** because guard trust is the scarce
  resource in this industry. A guard sent to nine false alarms will slow-walk the
  tenth, which converts a nuisance problem into a safety problem. This is the
  single most common complaint from ops managers, and it is why the agent is
  allowed to `suppress` at all.
- **Operator agreement (0.20)** is the adoption term. An agent the dispatcher
  constantly overrides is not deployed, regardless of its accuracy.
- **True-positive action rate (0.15)** is deliberately *below* missed-criticals:
  correctly handling a severity-2 loiterer and correctly handling a severity-5
  panic button are not worth the same, and the composite should not pretend they are.
- **Latency (0.10)** is real but small, and it **saturates at a 30-second budget**
  rather than growing unboundedly. A dispatcher who takes longer than that has
  already lost the incident; letting the term run negative would let a fast, wrong
  agent outscore a slightly slower, right one.

**Terms with no evidence are dropped, not zeroed.** If no incident has yet
resolved with `trueSeverity ≥ 4`, the missed-critical term has an empty
denominator; its weight is redistributed across the terms that do have data.
Scoring a term you have no evidence for is how benchmarks start lying.

## The learning curve

`computeLearningCurve` uses a **sliding window** (default 25 resolved incidents),
not a cumulative average. A cumulative average necessarily flattens as n grows,
which would make any system look like it converged, including one that stopped
learning entirely. The sliding window shows the trend that is actually there.

---

## What the eval holds constant, and what it varies

`runEval` generates the event stream **once** and replays that exact list through
three arms.

**Held constant**
- The event stream, same order, same hidden ground truth, same ids.
- The world, sites, zones, roster, and every responder's hidden traits are
  rebuilt from the same seed per arm, so no arm inherits another's responder
  fatigue or in-flight assignments.
- The scoring function, `simulator.resolve()` is the only consumer of ground
  truth and is identical for every arm.
- The judgment engine, cold and learned share one agent instance.

**Varied, the independent variable**
- `static`, a fixed severity table and nearest-ETA responder. No memory at all.
- `cold`, the real agent, all four memory channels enabled but empty at t=0.
- `learned`, the same agent, memory pre-trained on a warm-up stream drawn from
  the same generator but taken strictly *after* the scored events, so the training
  set and the test set do not overlap.

**Online learning.** Within every arm each event is decided first, resolved
second, folded into that arm's memory third. No arm can see an outcome before it
has committed. This means the *cold* arm also improves during the run, so
`learned − cold` is the value of prior experience, and `learned − static` is the
headline delta.

---

## Threats to validity

Stated plainly, because a number is only worth trusting if its caveats are.

1. **The simulator is the world.** Every figure is a claim about SENTRY's
   behaviour inside a model whose regularities I authored and the agent was built
   to find. It is evidence that the learning loop closes, not a field trial.
2. **The arms are not paired.** `resolve()` and `offerDispatch()` draw from each
   arm's own RNG, and different arms make different decisions, so accept/arrival
   rolls diverge. `responderAcceptRate` and `medianResponseMs` carry a few points
   of noise. `falseDispatchRate` and `missedCriticalRate` do not depend on those
   rolls and are the metrics to read.
3. **The oracle is a proxy for a human.** In eval mode agreement is measured
   against a ground-truth-optimal policy that only ever dispatches, escalates, or
   suppresses. It has **no `monitor` action**, so any hold-and-watch decision
   scores as a disagreement even when it is operationally sensible. This
   structurally understates agreement for the agent arms relative to a
   dispatch-happy static table, a known bias I chose to leave visible rather
   than paper over by redefining the metric.
4. **Warm-up auto-approves reflection rules.** Production keeps a human in that
   loop. The playbook channel's contribution in the learned arm is therefore an
   upper bound.
5. **Order effects.** Online learning means results depend on the order events
   arrive. Different seeds give different deltas; a single run is a data point,
   not a proof. Run `npm run eval -- --seed N` across several seeds.

## Reproducing

```bash
npm run experiment                        # 20 worlds, the headline claim
npm run eval -- --seed 42 --events 400    # one world, all metrics side by side
```

## One world is not a result

Learning here is online, so each arm's decisions depend on the order events
arrived. That makes single-seed lift a draw from a distribution, and no single
draw can separate a real effect from a lucky ordering. Quoting the best of three
seeds is the most common way a demo lies without anyone intending to.

`runExperiment` replays the whole protocol across N independently seeded worlds
and reports the distribution:

| | |
|---|---|
| **Win rate** | fraction of worlds where learned beat static |
| **Mean lift** | average of learned - static, in points of dispatch score |
| **95% interval** | on that mean, using the t distribution with n-1 df |
| **Prior experience** | mean of learned - cold, isolating memory carried in |

The interval is computed with Student's t rather than the normal approximation,
because at 10 to 30 worlds the normal approximation understates the width, and
understating your own error bars is the failure this whole file exists to
prevent. Sample variance uses n-1 for the same reason.

**The interval is what licenses the claim.** If it includes zero, the CLI and the
Evals screen both say the result is not established at this sample size, and
`--assert` exits non-zero. A number is only allowed to be reported as a win when
the whole interval sits above zero.

Seeds are derived deterministically from the base seed, so an experiment
reproduces exactly and no seed can be selected after its result is known.

At the time of writing, 20 worlds of 400 events give 20/20 wins, a mean lift of
+9.24 points, and a 95% interval of [7.93, 10.56].

**The same seed gives the same numbers, to the digit.** That is a property worth
stating because it did not hold for free. The responder channel uses Thompson
sampling, and its sampler originally fell back to `Math.random()`, so the
*static* arm was bit-stable while the two arms actually under test drifted by a
few tenths between runs. Nondeterminism in the thing you are measuring, but not
in your control, is the worst possible arrangement: it makes a real regression
and a rerun indistinguishable. `createMemory` now takes the seed and forks a
dedicated stream for responder draws, so reruns are exact and the fork can never
perturb the world's own stream.

The CLI prints all three arms side by side with the per-metric delta and the full
methodology block, so the result can be pasted into a review without trusting a
screenshot.
