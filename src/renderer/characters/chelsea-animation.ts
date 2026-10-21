import { createPetFrameSelector } from './pet-animation';
export { PET_ATLAS as CHELSEA_ATLAS, traceAlphaSilhouette } from './pet-animation';
export type { PetClip as ChelseaClip, PetFrameSelection as ChelseaFrameSelection, AlphaSilhouette } from './pet-animation';

// Keep the authored Chelsea exception separate from other pets' turn sequences.
export const selectChelseaFrame = createPetFrameSelector((direction, amount) => {
  if (direction < 0) return { clip: 'turn', row: 3, column: Math.round(amount * 3) };
  // Chelsea's right three-quarter cell faces left; end with the true right profile.
  return amount < 0.3 ? { clip: 'turn', row: 3, column: 4 }
    : amount < 0.75 ? { clip: 'turn', row: 3, column: 5 }
      : { clip: 'turn', row: 2, column: 0 };
});
