import { createPetSpriteLoader } from './pet-sprites';
import { selectChelseaOriginalFrame } from './chelsea-animation';
import { createChelseaWalkRig } from './chelsea-walk-rig';
import type { CompanionState } from '../../shared/contracts';
export type { PetSpriteFrame as ChelseaSpriteFrame } from './pet-sprites';

const sprites = createPetSpriteLoader(new URL('../assets/chelsea-pet.png', import.meta.url).href, selectChelseaOriginalFrame);
const walking = createChelseaWalkRig(new URL('../assets/chelsea-walk-rig.png', import.meta.url).href,
  new URL('../assets/chelsea-turn.png', import.meta.url).href);
export async function prepareChelseaSprites() { await Promise.all([sprites.prepare(), walking.prepare()]); }
export function getChelseaSpriteFrame(state: CompanionState, now: number) {
  return walking.getFrame(state, now, sprites.getFrame);
}
