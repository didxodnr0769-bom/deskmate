import { createPetSpriteLoader } from './pet-sprites';
import { selectChuchuFrame } from './chuchu-animation';
export type { PetSpriteFrame as ChuchuSpriteFrame } from './pet-sprites';

const sprites = createPetSpriteLoader(new URL('../assets/chuchu-pet.png', import.meta.url).href, selectChuchuFrame);
export const prepareChuchuSprites = sprites.prepare;
export const getChuchuSpriteFrame = sprites.getFrame;
