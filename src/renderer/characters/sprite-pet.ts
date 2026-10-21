import type { CompanionState } from '../../shared/contracts';
import type { CharacterDefinition, CharacterPose } from '../character-runtime';
import type { PetSpriteLoader } from './pet-sprites';

export function createSpritePetCharacter(id: string, label: string, fallback: CharacterDefinition,
  sprites: PetSpriteLoader): CharacterDefinition {
  function getPose(state: CompanionState, epochNow: number): CharacterPose {
    if (!sprites.getFrame(state, epochNow)) return fallback.getPose(state, epochNow);
    const pose: CharacterPose = { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 };
    const elapsed = Math.max(0, epochNow - state.motionStartedAt);
    // Keep walking feet planted; directional frames supply the limb movement.
    if (state.motion === 'dragged') {
      pose.rotation = Math.sin(elapsed / 230) * 0.018;
      const breath = Math.sin(elapsed / 1_700) * 0.003;
      pose.scaleX += breath; pose.scaleY -= breath;
    } else if (state.motion === 'dropping') {
      const progress = Math.min(1, elapsed / 280);
      const settle = Math.sin(progress * Math.PI) * (1 - progress);
      pose.scaleX = 1 + settle * 0.035;
      pose.scaleY = 1 - settle * 0.045;
    }
    return pose;
  }
  return {
    id, label, notification: fallback.notification, hitPolygon: fallback.hitPolygon,
    prepare: sprites.prepare, getPose,
    getGeometry(state, epochNow) {
      const sprite = sprites.getFrame(state, epochNow);
      return sprite ? { polygons: sprite.polygons, hpY: sprite.top - 26 } : { polygons: [fallback.hitPolygon] };
    },
    draw(context, state, epochNow) {
      const sprite = sprites.getFrame(state, epochNow);
      if (!sprite) { fallback.draw(context, state, epochNow); return; }
      const { source: s, destination: d } = sprite;
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(sprite.image, s.x, s.y, s.width, s.height, d.x, d.y, d.width, d.height);
    },
  };
}
