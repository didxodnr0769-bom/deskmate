import { createPetFrameSelector } from './pet-animation';
export { PET_ATLAS as CHUCHU_ATLAS } from './pet-animation';
export type { PetClip as ChuchuClip, PetFrameSelection as ChuchuFrameSelection } from './pet-animation';

export const selectChuchuFrame = createPetFrameSelector((direction, amount) => {
  if (direction < 0) return { clip: 'turn', row: 3, column: Math.round(amount * 3) };
  // The right three-quarter cell faces left; keep Chuchu's actual right-facing side pose.
  return { clip: 'turn', row: 3, column: amount < 0.3 ? 4 : amount < 0.75 ? 5 : 7 };
});
