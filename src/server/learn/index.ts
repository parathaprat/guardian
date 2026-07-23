/**
 * The memory layer: four independent learning channels behind one handle.
 * Nothing here reads ground truth, every store is fed only by revealed outcomes.
 */

import type { SimTime } from '../../shared/types';
import type { Memory, MemorySnapshot, WorldState } from '../contracts';
import { Rng } from '../util/rng';
import { Calibration } from './calibration';
import { Playbook } from './playbook';
import { Precedent } from './precedent';
import { Responders } from './responders';

/**
 * `seed` makes the Thompson-sampling responder channel reproducible; without it
 * the memory-enabled eval arms would be nondeterministic while the static arm
 * stayed bit-stable. The stream is forked so responder draws never shift the
 * world's own rng stream.
 */
export function createMemory(world: WorldState, now: SimTime, seed = 0): Memory {
  const calibration = new Calibration();
  const responders = new Responders(world, new Rng(seed).fork('responders'));
  const playbook = new Playbook(now);
  const precedent = new Precedent(world);

  return {
    calibration,
    responders,
    playbook,
    precedent,
    reset() {
      calibration.reset();
      responders.reset();
      playbook.reset();
      precedent.reset();
    },

    snapshot(): MemorySnapshot {
      return {
        calibration: calibration.cells(),
        responders: responders.models(),
        playbook: playbook.rules(),
        proposals: playbook.proposals(),
      };
    },

    /** Precedent is an index over resolved incidents, not a posterior, so it is rebuilt by replay, not restored, to avoid two copies of the same facts. */
    restore(snap: MemorySnapshot) {
      calibration.restore(snap.calibration);
      responders.restore(snap.responders);
      playbook.restore(snap.playbook, snap.proposals);
      precedent.reset();
    },
  };
}
