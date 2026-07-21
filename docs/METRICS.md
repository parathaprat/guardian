# Metrics — what "getting smarter" means, precisely

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
`falseDispatchRate` — `monitor` and `suppress` cost no guard time, so charging
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
  term is not linear in severity by accident — the tail is the entire risk.
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
which would make any system look like it converged — including one that stopped
learning entirely. The sliding window shows the trend that is actually there.

---

## What the eval holds constant, and what it varies

`runEval` generates the event stream **once** and replays that exact list through
three arms.

**Held constant**
- The event stream — same order, same hidden ground truth, same ids.
- The world — sites, zones, roster, and every responder's hidden traits are
  rebuilt from the same seed per arm, so no arm inherits another's responder
  fatigue or in-flight assignments.
- The scoring function — `simulator.resolve()` is the only consumer of ground
  truth and is identical for every arm.
- The judgment engine — cold and learned share one agent instance.

**Varied — the independent variable**
- `static` — a fixed severity table and nearest-ETA responder. No memory at all.
- `cold` — the real agent, all four memory channels enabled but empty at t=0.
- `learned` — the same agent, memory pre-trained on a warm-up stream drawn from
  the same generator but taken strictly *after* the scored events, so the training
  set and the test set do not overlap.

**Online learning.** Within every arm each event is decided first, resolved
second, folded into that arm's memory third. No arm can see an outcome before it
has committed. This means the *cold* arm also improves during the run — so
`learned − cold` is the value of prior experience, and `learned − static` is the
headline delta.

---

## Threats to validity

Stated plainly, because a number is only worth trusting if its caveats are.

1. **The simulator is the world.** Every figure is a claim about SENTRY's
   behaviour inside a model whose regularities I authored and the agent was built
   to find. It is evidence that the learning loop closes — not a field trial.
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
   dispatch-happy static table — a known bias I chose to leave visible rather
   than paper over by redefining the metric.
4. **Warm-up auto-approves reflection rules.** Production keeps a human in that
   loop. The playbook channel's contribution in the learned arm is therefore an
   upper bound.
5. **Order effects.** Online learning means results depend on the order events
   arrive. Different seeds give different deltas; a single run is a data point,
   not a proof. Run `npm run eval -- --seed N` across several seeds.

## Reproducing

```bash
npm run eval -- --seed 42 --events 400
npm run eval -- --seed 7  --events 900
```

The CLI prints all three arms side by side with the per-metric delta and the full
methodology block, so the result can be pasted into a review without trusting a
screenshot.
