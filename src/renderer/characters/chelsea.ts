import { chelseaFallback } from './chelsea-fallback';
import { getChelseaSpriteFrame, prepareChelseaSprites } from './chelsea-sprites';
import { createSpritePetCharacter } from './sprite-pet';

export const chelsea = createSpritePetCharacter('chelsea', '첼시', chelseaFallback,
  { prepare: prepareChelseaSprites, getFrame: getChelseaSpriteFrame });
