import type { CompanionState } from '../../shared/contracts';
import type { CharacterDefinition, CharacterPose } from '../character-runtime';

const notification = { jumpCount: 3, jumpDurationMs: 480, jumpHeight: 16 };

function getPose(state: CompanionState, epochNow: number): CharacterPose {
  const elapsed = Math.max(0, epochNow - state.motionStartedAt);
  const pose: CharacterPose = { x: 0, y: 0, rotation: 0, scaleX: state.direction, scaleY: 1 };
  if (state.motion === 'walking') {
    const stride = elapsed / 125;
    pose.y = -Math.abs(Math.sin(stride)) * 2.5;
    pose.rotation = Math.sin(stride) * 0.025 * state.direction;
    pose.scaleY = 1 + Math.cos(stride * 2) * 0.008;
  } else if (state.motion === 'dragged') {
    pose.rotation = Math.sin(elapsed / 180) * 0.035 * state.direction;
    pose.scaleX *= 0.97;
    pose.scaleY = 1.025;
  } else if (state.motion === 'dropping') {
    const progress = Math.min(1, elapsed / 280);
    const settle = Math.sin(progress * Math.PI) * (1 - progress);
    pose.scaleX *= 1 + settle * 0.09;
    pose.scaleY = 1 - settle * 0.11;
    pose.y = -Math.sin(progress * Math.PI * 2) * (1 - progress) * 2;
  } else if (state.motion === 'notify') {
    if (elapsed < notification.jumpCount * notification.jumpDurationMs) {
      const progress = (elapsed % notification.jumpDurationMs) / notification.jumpDurationMs;
      pose.y = -Math.sin(progress * Math.PI) * notification.jumpHeight;
      pose.rotation = Math.sin(progress * Math.PI * 2) * 0.025 * state.direction;
    }
  } else {
    const breath = Math.sin(epochNow / 1550) * 0.003;
    pose.scaleX *= 1 - breath;
    pose.scaleY = 1 + breath;
  }
  return pose;
}

export const cat: CharacterDefinition = {
  id: 'cat',
  label: '검은 고양이',
  notification,
  // The tail is part of the silhouette. Mirroring the pose mirrors this click region too.
  hitPolygon: [
    { x: -33, y: -4 }, { x: -39, y: -12 }, { x: -39, y: -27 },
    { x: -32, y: -43 }, { x: -32, y: -68 }, { x: -29, y: -71 },
    { x: -13, y: -57 }, { x: 0, y: -59 }, { x: 13, y: -57 },
    { x: 28, y: -70 }, { x: 32, y: -68 }, { x: 32, y: -43 },
    { x: 38, y: -29 }, { x: 38, y: -19 }, { x: 44, y: -21 },
    { x: 44, y: -26 }, { x: 43, y: -29 }, { x: 46, y: -32 },
    { x: 50, y: -30 }, { x: 54, y: -23 }, { x: 53, y: -15 },
    { x: 47, y: -9 }, { x: 34, y: -5 }, { x: 28, y: -1 },
    { x: 0, y: 1 }, { x: -25, y: 0 },
  ],
  getPose,
  draw(context, state, epochNow) {
    const elapsed = Math.max(0, epochNow - state.motionStartedAt);
    const tailLift = state.motion === 'idle' ? Math.sin(epochNow / 650) * 0.8
      : state.motion === 'walking' ? Math.sin(elapsed / 125) * 0.65 : 0;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.lineWidth = 1.5;
    context.strokeStyle = '#414a47';
    context.beginPath();
    context.moveTo(30, -8);
    context.bezierCurveTo(45, -5, 60, -19, 49, -29 + tailLift);
    context.bezierCurveTo(45, -34 + tailLift, 40, -29, 45, -25);
    context.bezierCurveTo(49, -20, 41, -15, 32, -18);
    context.closePath();
    context.fillStyle = '#515955';
    context.fill();
    context.stroke();

    context.beginPath();
    context.moveTo(-33, -4);
    context.bezierCurveTo(-43, -7, -40, -31, -32, -43);
    context.lineTo(-32, -68);
    context.quadraticCurveTo(-32, -73, -27, -69);
    context.lineTo(-13, -57);
    context.quadraticCurveTo(0, -62, 13, -57);
    context.lineTo(27, -69);
    context.quadraticCurveTo(32, -73, 32, -68);
    context.lineTo(32, -43);
    context.bezierCurveTo(41, -30, 42, -9, 29, -3);
    context.bezierCurveTo(16, 3, -22, 3, -33, -4);
    context.closePath();
    const coat = context.createLinearGradient(-22, -69, 27, 1);
    coat.addColorStop(0, '#666e68');
    coat.addColorStop(0.55, '#515b54');
    coat.addColorStop(1, '#3e4942');
    context.fillStyle = coat;
    context.fill();
    context.stroke();

    context.fillStyle = '#a3918c';
    for (const sign of [-1, 1]) {
      context.beginPath();
      context.moveTo(sign * 28, -64);
      context.lineTo(sign * 17, -56);
      context.lineTo(sign * 28, -52);
      context.closePath();
      context.fill();
    }
    context.beginPath();
    context.moveTo(-25, -37);
    context.quadraticCurveTo(-29, -31, -28, -25);
    context.lineWidth = 2;
    context.strokeStyle = 'rgba(219,226,208,0.2)';
    context.stroke();

    const blinking = epochNow % 4900 > 4740 && state.motion !== 'dragged';
    const look = state.motion === 'walking' ? 1.4 : 0;
    context.fillStyle = '#d4d7a1';
    for (const eyeX of [-12, 12]) {
      context.beginPath();
      if (blinking) context.roundRect(eyeX - 3 + look, -37, 6, 1.5, 0.7);
      else context.ellipse(eyeX + look, -37, 3.4, state.motion === 'dragged' ? 4.2 : 3.5, 0, 0, Math.PI * 2);
      context.fill();
      if (!blinking) {
        context.beginPath();
        context.ellipse(eyeX + look + 0.2, -37, 1, 2.4, 0, 0, Math.PI * 2);
        context.fillStyle = '#35423b';
        context.fill();
        context.fillStyle = '#d4d7a1';
      }
    }
    context.fillStyle = '#bd9b94';
    context.beginPath();
    context.moveTo(-2.4, -29);
    context.quadraticCurveTo(0, -31, 2.4, -29);
    context.lineTo(0, -26.7);
    context.closePath();
    context.fill();
    context.strokeStyle = '#a3afa3';
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(-4, -24.5);
    context.quadraticCurveTo(-1.5, -23, 0, -26.7);
    context.quadraticCurveTo(1.5, -23, 4, -24.5);
    context.stroke();
    context.strokeStyle = 'rgba(199,210,193,0.4)';
    for (const sign of [-1, 1]) {
      context.beginPath();
      context.moveTo(sign * 20, -28);
      context.lineTo(sign * 29, -30);
      context.moveTo(sign * 21, -25);
      context.lineTo(sign * 30, -24);
      context.stroke();
    }

    const stride = state.motion === 'walking' ? Math.sin(elapsed / 125) * 1.5 : 0;
    for (const [x, lift] of [[-16, Math.max(0, stride)], [16, Math.max(0, -stride)]]) {
      context.beginPath();
      context.ellipse(x, -3.5 - lift, 9, 4, 0, 0, Math.PI * 2);
      context.fillStyle = '#59655a';
      context.fill();
      context.strokeStyle = '#414e43';
      context.lineWidth = 1;
      context.stroke();
      context.beginPath();
      context.moveTo(x - 2, -5 - lift);
      context.lineTo(x - 2, -2.5 - lift);
      context.moveTo(x + 2, -5 - lift);
      context.lineTo(x + 2, -2.5 - lift);
      context.stroke();
    }
  },
};
