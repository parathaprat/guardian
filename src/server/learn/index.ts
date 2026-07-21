/**
 * The memory layer: four independent learning channels behind one handle.
 *
 * Nothing here reads ground truth. Every store is fed only by revealed
 * outcomes, which is what makes the memory-on / memory-off eval honest.
 */

import type { SimTime } from '../../shared/types';
import type { Memory, WorldState } from '../contracts';
import { Rng } from '../util/rng';
import { Calibration } from './calibration';
import { Playbook } from './playbook';
import { Precedent } from './precedent';
import { Responders } from './responders';

/**
 * `seed` makes the responder channel reproducible.
 *
 * Thompson sampling draws to decide whether to explore an under-observed
 * responder, and an unseeded draw makes every memory-enabled arm of the eval
 * irreproducible — the static arm stays bit-stable while the arms under test
 * wander, which is the worst possible place for nondeterminism to live. The
 * stream is forked, so responder draws can never shift the world's stream.
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
  };
}
