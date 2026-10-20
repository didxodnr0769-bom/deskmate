import type { CompanionState } from '../../shared/contracts';
import type { CharacterDefinition, CharacterPose } from '../character-runtime';

const notification = { jumpCount: 2, jumpDurationMs: 560, jumpHeight: 20 };

function getPose(state: CompanionState, epochNow: number): CharacterPose {
  const elapsed = Math.max(0, epochNow - state.motionStartedAt);
  const pose: CharacterPose = { x: 0, y: 0, rotation: 0, scaleX: state.direction, scaleY: 1 };
  if (state.motion === 'walking') {
    const stride = elapsed / 170;
    pose.y = -Math.abs(Math.sin(stride)) * 5;
    pose.rotation = Math.sin(stride) * 0.022 * state.direction;
    pose.scaleY = 1 + Math.cos(stride * 2) * 0.012;
  } else if (state.motion === 'dragged') {
    pose.rotation = Math.sin(elapsed / 210) * 0.025 * state.direction;
    pose.scaleX *= 0.97;
    pose.scaleY = 1.02;
  } else if (state.motion === 'dropping') {
    const progress = Math.min(1, elapsed / 280);
    const settle = Math.sin(progress * Math.PI) * (1 - progress);
    pose.scaleX *= 1 + settle * 0.11;
    pose.scaleY = 1 - settle * 0.12;
    pose.y = -Math.abs(Math.sin(progress * Math.PI * 2)) * (1 - progress) * 4;
  } else if (state.motion === 'notify') {
    if (elapsed < notification.jumpCount * notification.jumpDurationMs) {
      const progress = (elapsed % notification.jumpDurationMs) / notification.jumpDurationMs;
      pose.y = -Math.sin(progress * Math.PI) * notification.jumpHeight;
      pose.rotation = Math.sin(progress * Math.PI * 2) * 0.018 * state.direction;
    }
  } else {
    const breath = Math.sin(epochNow / 1450) * 0.003;
    pose.scaleX *= 1 - breath;
    pose.scaleY = 1 + breath;
  }
  return pose;
}

export const rabbit: CharacterDefinition = {
  id: 'rabbit',
  label: '크림 토끼',
  notification,
  // The ear gap stays transparent; the right-hand puff tail remains clickable.
  hitPolygon: [
    { x: -25, y: 0 }, { x: -34, y: -5 }, { x: -37, y: -16 },
    { x: -33, y: -30 }, { x: -24, y: -43 }, { x: -30, y: -58 },
    { x: -31, y: -67 }, { x: -27, y: -72 }, { x: -22, y: -71 },
    { x: -15, y: -59 }, { x: -11, y: -47 }, { x: -1, y: -47 },
    { x: 3, y: -63 }, { x: 8, y: -71 }, { x: 14, y: -72 },
    { x: 19, y: -67 }, { x: 19, y: -58 }, { x: 15, y: -43 },
    { x: 27, y: -34 }, { x: 34, y: -23 }, { x: 40, y: -23 },
    { x: 46, y: -19 }, { x: 47, y: -13 }, { x: 43, y: -7 },
    { x: 34, y: -7 }, { x: 26, y: 0 }, { x: 0, y: 1 },
  ],
  getPose,
  draw(context, state, epochNow) {
    const elapsed = Math.max(0, epochNow - state.motionStartedAt);
    context.lineJoin = 'round';
    context.lineCap = 'round';
    context.lineWidth = 1.5;
    context.strokeStyle = '#a79f8e';
    context.fillStyle = '#e5dfcf';
    context.beginPath();
    context.arc(38, -14, 8, 0, Math.PI * 2);
    context.fill();
    context.stroke();

    context.beginPath();
    context.moveTo(-25, -1);
    context.bezierCurveTo(-42, -2, -39, -27, -24, -43);
    context.bezierCurveTo(-31, -57, -35, -70, -27, -72);
    context.bezierCurveTo(-20, -75, -14, -59, -11, -47);
    context.quadraticCurveTo(-6, -49, -1, -47);
    context.bezierCurveTo(3, -61, 4, -73, 14, -72);
    context.bezierCurveTo(23, -69, 19, -54, 15, -43);
    context.bezierCurveTo(39, -32, 42, -5, 26, -1);
    context.bezierCurveTo(15, 3, -13, 3, -25, -1);
    context.closePath();
    const coat = context.createLinearGradient(-21, -69, 22, 0);
    coat.addColorStop(0, '#faf5e8');
    coat.addColorStop(0.6, '#eee8d8');
    coat.addColorStop(1, '#d7d0bf');
    context.fillStyle = coat;
    context.fill();
    context.stroke();

    context.strokeStyle = '#d7b6aa';
    context.lineWidth = 5;
    context.beginPath();
    context.moveTo(-26, -65);
    context.quadraticCurveTo(-23, -59, -19, -49);
    context.moveTo(13, -65);
    context.quadraticCurveTo(11, -58, 8, -49);
    context.stroke();
    context.lineWidth = 2.2;
    context.strokeStyle = 'rgba(255,255,255,0.8)';
    context.beginPath();
    context.moveTo(-27, -27);
    context.quadraticCurveTo(-24, -34, -20, -36);
    context.stroke();

    const blinking = epochNow % 5300 > 5120 && state.motion !== 'dragged';
    const look = state.motion === 'walking' ? 1.2 : 0;
    context.fillStyle = '#665d51';
    for (const x of [-12, 10]) {
      context.beginPath();
      if (blinking) context.roundRect(x - 2.2 + look, -30, 4.4, 1.4, 0.7);
      else context.ellipse(x + look, -30, 2.4, state.motion === 'dragged' ? 3.6 : 2.9, 0, 0, Math.PI * 2);
      context.fill();
    }
    context.fillStyle = '#c38f86';
    context.beginPath();
    context.ellipse(-1, -23, 2.4, 1.8, 0, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = '#a78c7e';
    context.lineWidth = 1.1;
    context.beginPath();
    context.moveTo(-1, -21.5);
    context.lineTo(-1, -19);
    context.moveTo(-4, -19);
    context.quadraticCurveTo(-1, -16.5, 2, -19);
    context.stroke();
    context.fillStyle = 'rgba(209,156,143,0.4)';
    for (const x of [-22, 20]) {
      context.beginPath();
      context.ellipse(x, -23, 4.4, 2.2, 0, 0, Math.PI * 2);
      context.fill();
    }

    const stride = state.motion === 'walking' ? Math.sin(elapsed / 170) * 1.6 : 0;
    for (const [x, lift] of [[-19, Math.max(0, stride)], [17, Math.max(0, -stride)]]) {
      context.beginPath();
      context.ellipse(x, -3 - lift, 10, 4, 0, 0, Math.PI * 2);
      context.fillStyle = '#e8e0cd';
      context.fill();
      context.strokeStyle = '#b3a895';
      context.lineWidth = 1;
      context.stroke();
      context.beginPath();
      context.moveTo(x - 2, -4 - lift);
      context.lineTo(x - 2, -2 - lift);
      context.moveTo(x + 2, -4 - lift);
      context.lineTo(x + 2, -2 - lift);
      context.stroke();
    }
  },
};
