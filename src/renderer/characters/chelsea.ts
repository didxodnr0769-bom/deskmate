import type { CompanionState } from '../../shared/contracts';
import type { CharacterDefinition, CharacterPose } from '../character-runtime';
import { chelseaFallback } from './chelsea-fallback';
import { getChelseaSpriteFrame, prepareChelseaSprites } from './chelsea-sprites';

function spritePose(state: CompanionState, epochNow: number): CharacterPose {
  if (!getChelseaSpriteFrame(state, epochNow)) return chelseaFallback.getPose(state, epochNow);
  const pose: CharacterPose = { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 };
  const elapsed = Math.max(0, epochNow - state.motionStartedAt);
  // Feet stay planted during the walk: limb movement is drawn in the directional frames.
  if (state.motion === 'dragged') {
    pose.rotation = Math.sin(elapsed / 230) * 0.018;
    const breath = Math.sin(elapsed / 1_700) * 0.003;
    pose.scaleX += breath; pose.scaleY -= breath;
  }
  else if (state.motion === 'dropping') {
    const progress = Math.min(1, elapsed / 280);
    const settle = Math.sin(progress * Math.PI) * (1 - progress);
    pose.scaleX = 1 + settle * 0.035;
    pose.scaleY = 1 - settle * 0.045;
  }
  return pose;
}

export const chelsea: CharacterDefinition = {
  id: 'chelsea', label: '첼시',
  notification: chelseaFallback.notification,
  hitPolygon: chelseaFallback.hitPolygon,
  prepare: prepareChelseaSprites,
  getPose: spritePose,
  getGeometry(state, epochNow) {
    const sprite = getChelseaSpriteFrame(state, epochNow);
    return sprite ? { polygons: sprite.polygons, hpY: sprite.top - 26 } : { polygons: [chelseaFallback.hitPolygon] };
  },
  draw(context, state, epochNow) {
    const sprite = getChelseaSpriteFrame(state, epochNow);
    if (!sprite) { chelseaFallback.draw(context, state, epochNow); return; }
    const { source: s, destination: d } = sprite;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(sprite.image, s.x, s.y, s.width, s.height, d.x, d.y, d.width, d.height);
  },
};
