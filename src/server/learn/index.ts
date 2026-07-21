/**
 * The memory layer: four independent learning channels behind one handle.
 *
 * Nothing here reads ground truth. Every store is fed only by revealed
 * outcomes, which is what makes the memory-on / memory-off eval honest.
 */

import type { SimTime } from '../../shared/types';
import type { Memory, WorldState } from '../contracts';
import { Calibration } from './calibration';
import { Playbook } from './playbook';
import { Precedent } from './precedent';
import { Responders } from './responders';

export function createMemory(world: WorldState, now: SimTime): Memory {
  const calibration = new Calibration();
  const responders = new Responders(world);
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
