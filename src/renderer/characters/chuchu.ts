import { chuchuFallback } from './chuchu-fallback';
import { getChuchuSpriteFrame, prepareChuchuSprites } from './chuchu-sprites';
import { createSpritePetCharacter } from './sprite-pet';

export const chuchu = createSpritePetCharacter('chuchu', '츄츄', chuchuFallback,
  { prepare: prepareChuchuSprites, getFrame: getChuchuSpriteFrame });
