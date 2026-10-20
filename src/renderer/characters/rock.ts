import type { CompanionState } from '../../shared/contracts';
import type { CharacterDefinition, CharacterPose } from '../character-runtime';

const notification = { jumpCount: 3, jumpDurationMs: 540, jumpHeight: 23 };

const neutralPose = (): CharacterPose => ({ x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 });

function getPose(state: CompanionState, epochNow: number): CharacterPose {
  const pose = neutralPose();
  // motionStartedAt is an epoch timestamp. Never subtract it from rAF's performance timestamp.
  const elapsed = Math.max(0, epochNow - state.motionStartedAt);
  if (state.motion === 'walking') {
    const cycle = elapsed / 155;
    pose.rotation = Math.sin(cycle) * 0.075;
    pose.y = -Math.abs(Math.sin(cycle)) * 3.6;
    pose.scaleX = 1 + Math.cos(cycle * 2) * 0.013;
  } else if (state.motion === 'dragged') {
    pose.rotation = Math.sin(elapsed / 170) * 0.075;
    pose.scaleX = 0.96;
    pose.scaleY = 1.045;
  } else if (state.motion === 'dropping') {
    const progress = Math.min(1, elapsed / 280);
    const bounce = Math.sin(progress * Math.PI * 3) * (1 - progress);
    pose.y = -Math.abs(bounce) * 10;
    pose.scaleX = 1 + Math.max(0, Math.sin(progress * Math.PI * 4)) * (1 - progress) * 0.055;
    pose.scaleY = 2 - pose.scaleX;
  } else if (state.motion === 'notify') {
    const duration = notification.jumpDurationMs;
    if (elapsed < notification.jumpCount * duration) {
      const progress = (elapsed % duration) / duration;
      pose.y = -Math.sin(progress * Math.PI) * notification.jumpHeight;
      pose.rotation = Math.sin(progress * Math.PI * 2) * 0.035;
    }
  } else {
    const breathing = Math.sin(epochNow / 1700) * 0.004;
    pose.scaleY = 1 + breathing;
    pose.scaleX = 1 - breathing;
  }
  return pose;
}

export const rock: CharacterDefinition = {
  id: 'rock',
  label: '돌멩이',
  notification,
  hitPolygon: [
    { x: -46, y: -6 }, { x: -47, y: -25 }, { x: -35, y: -52 },
    { x: -16, y: -66 }, { x: 12, y: -68 }, { x: 34, y: -53 },
    { x: 47, y: -26 }, { x: 46, y: -9 }, { x: 30, y: -1 }, { x: -27, y: -1 },
  ],
  getPose,
  draw(context, state, epochNow) {
    context.beginPath();
    context.moveTo(-46, -7);
    context.bezierCurveTo(-51, -17, -46, -36, -35, -51);
    context.bezierCurveTo(-27, -64, -17, -69, -2, -68);
    context.bezierCurveTo(16, -73, 29, -59, 37, -47);
    context.bezierCurveTo(46, -35, 52, -16, 45, -8);
    context.bezierCurveTo(36, 2, -33, 3, -46, -7);
    context.closePath();
    const fill = context.createLinearGradient(-20, -65, 22, 0);
    fill.addColorStop(0, '#d4d6d3');
    fill.addColorStop(0.6, '#bdc2be');
    fill.addColorStop(1, '#a8b0a9');
    context.fillStyle = fill;
    context.fill();
    context.strokeStyle = '#737f77';
    context.lineWidth = 1.7;
    context.stroke();

    context.beginPath();
    context.moveTo(-32, -44);
    context.quadraticCurveTo(-24, -58, -13, -59);
    context.strokeStyle = 'rgba(255,255,255,0.56)';
    context.lineWidth = 3;
    context.lineCap = 'round';
    context.stroke();

    context.fillStyle = 'rgba(114,127,117,0.22)';
    for (const [x, y, radius] of [[-32, -20, 1.5], [29, -15, 1.2], [20, -51, 1.2], [-15, -49, 1]]) {
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fill();
    }

    const blinking = epochNow % 5200 > 5000 && state.motion !== 'dragged';
    const eyeY = -31;
    const look = state.motion === 'walking' ? state.direction * 1.4 : 0;
    context.fillStyle = '#38453f';
    for (const eyeX of [-12, 12]) {
      context.beginPath();
      if (blinking) {
        context.roundRect(eyeX + look - 2, eyeY, 4, 1.5, 0.7);
      } else {
        context.ellipse(eyeX + look, eyeY, 2.3, state.motion === 'dragged' ? 3.8 : 3.1, 0, 0, Math.PI * 2);
      }
      context.fill();
    }
    context.beginPath();
    context.moveTo(-3, -23);
    context.quadraticCurveTo(0, -21, 3, -23);
    context.lineWidth = 1.3;
    context.strokeStyle = '#637168';
    context.stroke();

    context.fillStyle = 'rgba(183,139,126,0.28)';
    for (const x of [-23, 23]) {
      context.beginPath();
      context.ellipse(x, -24, 4.5, 2, 0, 0, Math.PI * 2);
      context.fill();
    }
  },
};
