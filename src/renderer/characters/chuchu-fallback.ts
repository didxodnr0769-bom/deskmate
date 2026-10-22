import type { CompanionState } from '../../shared/contracts';
import type { CharacterDefinition, CharacterPose } from '../character-runtime';

const notification = { jumpCount: 2, jumpDurationMs: 560, jumpHeight: 12 };
function getPose(state: CompanionState, epochNow: number): CharacterPose {
  const elapsed = Math.max(0, epochNow - state.motionStartedAt);
  const pose: CharacterPose = { x: 0, y: 0, rotation: 0, scaleX: state.direction, scaleY: 1 };
  if (state.motion === 'walking') {
    const stride = elapsed / 130;
    pose.y = -Math.abs(Math.sin(stride)) * 1.6;
    pose.rotation = Math.sin(stride) * 0.018 * state.direction;
  } else if (state.motion === 'dragged') {
    pose.rotation = Math.sin(elapsed / 220) * 0.025 * state.direction;
    pose.scaleX *= 0.98; pose.scaleY = 1.02;
  } else if (state.motion === 'dropping') {
    const progress = Math.min(1, elapsed / 280), settle = Math.sin(progress * Math.PI) * (1 - progress);
    pose.scaleX *= 1 + settle * 0.07; pose.scaleY = 1 - settle * 0.08;
  } else if (state.motion === 'notify') {
    if (elapsed < notification.jumpCount * notification.jumpDurationMs) {
      const progress = (elapsed % notification.jumpDurationMs) / notification.jumpDurationMs;
      pose.y = -Math.sin(progress * Math.PI) * notification.jumpHeight;
    }
  } else {
    const breath = Math.sin(epochNow / 1_700) * 0.003;
    pose.scaleX *= 1 - breath; pose.scaleY += breath;
  }
  return pose;
}

function oval(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number,
  fill: string, rotation = 0, stroke = true) {
  context.beginPath(); context.ellipse(x, y, width, height, rotation, 0, Math.PI * 2);
  context.fillStyle = fill; context.fill(); if (stroke) context.stroke();
}

/** A local white-dog drawing remains available if its packaged sprite cannot be read. */
export const chuchuFallback: CharacterDefinition = {
  id: 'chuchu', label: '츄츄', notification,
  hitPolygon: [
    { x: -25, y: 1 }, { x: -34, y: -6 }, { x: -35, y: -20 },
    { x: -30, y: -31 }, { x: -34, y: -44 }, { x: -32, y: -57 },
    { x: -27, y: -68 }, { x: -18, y: -69 }, { x: -8, y: -65 },
    { x: 8, y: -65 }, { x: 18, y: -69 }, { x: 27, y: -67 },
    { x: 32, y: -57 }, { x: 34, y: -43 }, { x: 30, y: -30 },
    { x: 32, y: -20 }, { x: 38, y: -20 }, { x: 44, y: -32 },
    { x: 50, y: -33 }, { x: 55, y: -28 }, { x: 56, y: -18 },
    { x: 50, y: -8 }, { x: 35, y: -4 }, { x: 26, y: 1 },
  ],
  getPose,
  draw(context, state, epochNow) {
    const elapsed = Math.max(0, epochNow - state.motionStartedAt);
    const tail = state.motion === 'idle' ? Math.sin(epochNow / 480) * 0.8 : 0;
    context.lineCap = 'round'; context.lineJoin = 'round';
    context.lineWidth = 1.2; context.strokeStyle = '#9da19c';
    // The feathered curled tail is distinct from both the stone and the cat.
    context.beginPath(); context.moveTo(24, -10);
    context.bezierCurveTo(44, -7, 58, -16, 54, -26 + tail);
    context.bezierCurveTo(51, -36 + tail, 42, -34, 43, -27);
    context.quadraticCurveTo(47, -22, 49, -26);
    context.bezierCurveTo(50, -17, 39, -18, 29, -20);
    context.closePath(); context.fillStyle = '#f5f3ec'; context.fill(); context.stroke();

    const coat = context.createLinearGradient(-20, -38, 20, 2);
    coat.addColorStop(0, '#fffffa'); coat.addColorStop(0.6, '#f5f3ed'); coat.addColorStop(1, '#d8dcd7');
    context.beginPath(); context.moveTo(-25, -3);
    context.bezierCurveTo(-37, -8, -33, -31, -19, -39);
    context.quadraticCurveTo(-1, -46, 20, -37);
    context.bezierCurveTo(35, -28, 37, -7, 24, -2);
    context.quadraticCurveTo(0, 3, -25, -3); context.closePath();
    context.fillStyle = coat; context.fill(); context.stroke();

    // Soft uneven ears and rounded face preserve the supplied dog's small, shaggy head.
    oval(context, -25, -50, 9, 15, '#ecece4', 0.18);
    oval(context, 25, -49, 9, 15, '#ecece4', -0.18);
    context.beginPath(); context.moveTo(-26, -54);
    context.quadraticCurveTo(-32, -67, -25, -68);
    context.quadraticCurveTo(-18, -70, -11, -59);
    context.closePath(); context.fillStyle = '#f9f7ef'; context.fill(); context.stroke();
    oval(context, -24, -60, 3.7, 5, '#e6c9c2', -0.35, false);
    oval(context, 0, -45, 26, 22, '#faf9f1');
    context.strokeStyle = 'rgba(161,164,154,0.45)'; context.lineWidth = 0.8;
    for (const [x, y, sign] of [[-23, -36, -1], [22, -36, 1], [-9, -62, -1], [8, -62, 1]]) {
      context.beginPath(); context.moveTo(x, y);
      context.quadraticCurveTo(x + sign * 5, y + 3, x + sign * 2, y + 7); context.stroke();
    }

    const blinking = epochNow % 5_100 > 4_940 && state.motion !== 'dragged';
    for (const x of [-10, 10]) {
      context.strokeStyle = '#62665e'; context.lineWidth = 1;
      if (blinking) {
        context.beginPath(); context.moveTo(x - 3.2, -46);
        context.quadraticCurveTo(x, -44.5, x + 3.2, -46); context.stroke();
      } else {
        oval(context, x, -46, 4.2, 4.8, '#242927', 0, false);
        oval(context, x - 1.1, -47.5, 1.1, 1.35, '#fffef6', 0, false);
        oval(context, x + 1.3, -43.9, 0.6, 0.7, '#828e8b', 0, false);
      }
    }
    oval(context, -6, -35, 9, 7, '#fffdf5', -0.15, false);
    oval(context, 6, -35, 9, 7, '#fffdf5', 0.15, false);
    context.beginPath(); context.moveTo(-5, -39);
    context.bezierCurveTo(-4, -44, 5, -44, 5, -39);
    context.quadraticCurveTo(1, -34, -5, -39);
    context.fillStyle = '#9c786d'; context.fill();
    oval(context, -2.8, -38.9, 1.3, 1.1, '#3a342e', 0, false);
    oval(context, 2.8, -38.9, 1.3, 1.1, '#3a342e', 0, false);
    context.strokeStyle = '#696b62'; context.lineWidth = 0.9;
    context.beginPath(); context.moveTo(0, -36); context.lineTo(0, -32);
    context.quadraticCurveTo(-3, -29, -5, -32);
    context.moveTo(0, -32); context.quadraticCurveTo(3, -29, 5, -32); context.stroke();
    if (state.motion === 'idle' && epochNow % 9_000 > 7_700) oval(context, 1, -29.8, 2.8, 2.7, '#cf9e9d', 0.2, false);

    context.strokeStyle = '#b5bbb0'; context.lineWidth = 1;
    const stride = state.motion === 'walking' ? Math.sin(elapsed / 130) * 1.3 : 0;
    for (const [x, lift] of [[-12, Math.max(0, stride)], [12, Math.max(0, -stride)]]) {
      oval(context, x, -10 - lift, 7.5, 10, '#f5f5ec', 0, false);
      oval(context, x, -3.5 - lift, 9, 4.2, '#edeae3');
      context.strokeStyle = 'rgba(173,154,148,0.55)';
      context.beginPath(); context.moveTo(x - 2, -4 - lift); context.lineTo(x - 2, -1.5 - lift);
      context.moveTo(x + 2, -4 - lift); context.lineTo(x + 2, -1.5 - lift); context.stroke();
      context.strokeStyle = '#b5bbb0';
    }
  },
};
