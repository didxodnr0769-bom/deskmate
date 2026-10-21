import { createPetSpriteLoader } from './pet-sprites';
import { selectChelseaFrame } from './chelsea-animation';
export type { PetSpriteFrame as ChelseaSpriteFrame } from './pet-sprites';

const sprites = createPetSpriteLoader(new URL('../assets/chelsea-pet.png', import.meta.url).href, selectChelseaFrame);
export const prepareChelseaSprites = sprites.prepare;
export const getChelseaSpriteFrame = sprites.getFrame;
