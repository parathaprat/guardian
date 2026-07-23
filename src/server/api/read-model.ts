/**
 * Assembles a Snapshot from storage rather than the live engine, which is
 * what keeps the API process stateless: it renders the worker's last known
 * state even while the worker is down. See DECISIONS.md (Decision 8).
 */

import { EMPTY_METRICS } from '../../shared/types';
import type { Snapshot } from '../../shared/types';
import type { Repository } from '../contracts';
import { WorldSimulator } from '../world/simulator';
import { engineStatus } from '../agent/index';

export async function readSnapshot(repo: Repository, seed: number): Promise<Snapshot> {
  const sim = new WorldSimulator(seed);
  const saved = await repo.load(seed);

  // Controls persist on a timer but incidents persist instantly, so the saved
  // clock can trail the newest incident. Clamp it forward so nothing renders
  // as happening in the future.
  const newestStamp = Math.max(
    saved?.events[0]?.ts ?? 0,
    ...(saved?.incidents ?? []).map((i) => i.resolvedAt ?? i.createdAt),
  );

  return {
    controls: saved?.controls
      ? { ...saved.controls, simTime: Math.max(saved.controls.simTime, newestStamp) }
      : {
        running: false,
        speed: 4,
        seed,
        simTime: sim.now(),
        eventsGenerated: 0,
      },
    // The worker's engine, not this process's. The API has no agent, so calling
    // `engineStatus()` here would report REASONER on a stack running Gemini.
    engine: saved?.engine ?? engineStatus(),
    world: {
      sites: sim.world.sites,
      zones: sim.world.zones,
      // Same strip as `OpsEngine.snapshot`, deliberately duplicated: a wire
      // boundary shouldn't trust another module to have sanitised for it.
      guards: sim.world.guards.map(({ truth, ...g }) => g),
      robots: sim.world.robots.map(({ truth, ...r }) => r),
    },
    // Storage already returns newest first, which is how the console renders.
    incidents: saved?.incidents ?? [],
    feed: saved?.events ?? [],
    metrics: saved?.metrics ?? EMPTY_METRICS,
    learningCurve: saved?.curve ?? [],
    calibration: saved?.memory?.calibration ?? [],
    responderModels: saved?.memory?.responders ?? [],
    playbook: saved?.memory?.playbook ?? [],
    proposals: saved?.memory?.proposals ?? [],
    // Eval runs are on demand and expensive; there is no value in persisting a
    // result whose whole point is that you just asked for it.
    lastEval: null,
    briefings: saved?.briefings ?? [],
  };
}
