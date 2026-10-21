import type { CompanionState } from '../../shared/contracts';
import type { CharacterDefinition, CharacterPose } from '../character-runtime';

const notification = { jumpCount: 3, jumpDurationMs: 560, jumpHeight: 18 };

function getPose(state: CompanionState, epochNow: number): CharacterPose {
  const elapsed = Math.max(0, epochNow - state.motionStartedAt);
  const pose: CharacterPose = { x: 0, y: 0, rotation: 0, scaleX: state.direction, scaleY: 1 };
  if (state.motion === 'walking') {
    const stride = elapsed / 145;
    pose.y = -Math.abs(Math.sin(stride)) * 2.8;
    pose.rotation = Math.sin(stride) * 0.021 * state.direction;
    pose.scaleY = 1 + Math.cos(stride * 2) * 0.007;
  } else if (state.motion === 'dragged') {
    pose.rotation = Math.sin(elapsed / 205) * 0.028 * state.direction;
    pose.scaleX *= 0.975;
    pose.scaleY = 1.02;
  } else if (state.motion === 'dropping') {
    const progress = Math.min(1, elapsed / 280);
    const settle = Math.sin(progress * Math.PI) * (1 - progress);
    pose.scaleX *= 1 + settle * 0.08;
    pose.scaleY = 1 - settle * 0.1;
    pose.y = -Math.abs(Math.sin(progress * Math.PI * 2)) * (1 - progress) * 2.5;
  } else if (state.motion === 'notify') {
    if (elapsed < notification.jumpCount * notification.jumpDurationMs) {
      const progress = (elapsed % notification.jumpDurationMs) / notification.jumpDurationMs;
      pose.y = -Math.sin(progress * Math.PI) * notification.jumpHeight;
      pose.rotation = Math.sin(progress * Math.PI * 2) * 0.019 * state.direction;
    }
  } else {
    const breath = Math.sin(epochNow / 1800) * 0.003;
    pose.scaleX *= 1 - breath;
    pose.scaleY = 1 + breath;
  }
  return pose;
}

function bodyPath(context: CanvasRenderingContext2D) {
  context.beginPath();
  context.moveTo(-32, -2);
  context.bezierCurveTo(-42, -1, -48, -9, -42, -15);
  context.lineTo(-47, -20);
  context.quadraticCurveTo(-45, -25, -41, -25);
  context.lineTo(-43, -31);
  context.quadraticCurveTo(-37, -36, -35, -46);
  context.lineTo(-32, -67);
  context.quadraticCurveTo(-32, -74, -27, -70);
  context.lineTo(-13, -57);
  context.quadraticCurveTo(-2, -62, 11, -57);
  context.lineTo(26, -70);
  context.quadraticCurveTo(31, -74, 32, -67);
  context.lineTo(33, -47);
  context.quadraticCurveTo(36, -38, 42, -32);
  context.lineTo(41, -25);
  context.lineTo(45, -21);
  context.lineTo(41, -16);
  context.quadraticCurveTo(46, -8, 35, -2);
  context.quadraticCurveTo(17, 4, -1, 2);
  context.quadraticCurveTo(-20, 4, -32, -2);
  context.closePath();
}

function tailPath(context: CanvasRenderingContext2D, lift: number) {
  context.beginPath();
  context.moveTo(29, -6);
  context.bezierCurveTo(43, -1, 61, -14, 58, -27 + lift);
  context.lineTo(55, -34 + lift);
  context.lineTo(51, -37 + lift);
  context.lineTo(48, -34 + lift);
  context.quadraticCurveTo(45, -31 + lift, 48, -27 + lift);
  context.bezierCurveTo(54, -19, 41, -11, 30, -16);
  context.closePath();
}

export const chelsea: CharacterDefinition = {
  id: 'chelsea',
  label: '첼시',
  notification,
  // Cheek tufts, pointed ears and the fluffy tail share the drawing's mirrored pose.
  hitPolygon: [
    { x: -32, y: -1 }, { x: -40, y: -3 }, { x: -45, y: -10 },
    { x: -42, y: -15 }, { x: -47, y: -20 }, { x: -41, y: -25 },
    { x: -43, y: -31 }, { x: -36, y: -39 }, { x: -35, y: -48 },
    { x: -32, y: -68 }, { x: -28, y: -72 }, { x: -13, y: -57 },
    { x: -2, y: -59 }, { x: 11, y: -57 }, { x: 27, y: -72 },
    { x: 32, y: -68 }, { x: 33, y: -48 }, { x: 37, y: -40 },
    { x: 42, y: -32 }, { x: 41, y: -25 }, { x: 46, y: -27 },
    { x: 48, y: -34 }, { x: 51, y: -37 }, { x: 55, y: -34 },
    { x: 59, y: -26 }, { x: 57, y: -18 }, { x: 52, y: -12 },
    { x: 43, y: -8 }, { x: 35, y: -2 }, { x: 17, y: 2 },
    { x: -17, y: 2 },
  ],
  getPose,
  draw(context, state, epochNow) {
    const elapsed = Math.max(0, epochNow - state.motionStartedAt);
    const tailLift = state.motion === 'idle' ? Math.sin(epochNow / 850) * 0.7
      : state.motion === 'walking' ? Math.sin(elapsed / 145) * 0.6 : 0;
    context.lineJoin = 'round';
    context.lineCap = 'round';
    context.lineWidth = 1.3;
    context.strokeStyle = '#7c858b';

    tailPath(context, tailLift);
    const tail = context.createLinearGradient(34, -11, 55, -35);
    tail.addColorStop(0, '#aeb5b9');
    tail.addColorStop(1, '#89939a');
    context.fillStyle = tail;
    context.fill();
    context.stroke();
    context.save();
    tailPath(context, tailLift);
    context.clip();
    context.strokeStyle = '#737e87';
    context.lineWidth = 4;
    for (const [x, y] of [[39, -10], [48, -16], [53, -25], [51, -34]]) {
      context.beginPath();
      context.moveTo(x - 4, y - 2 + tailLift);
      context.lineTo(x + 4, y + 3 + tailLift);
      context.stroke();
    }
    context.restore();

    bodyPath(context);
    const coat = context.createLinearGradient(-25, -66, 26, 1);
    coat.addColorStop(0, '#e0e3e4');
    coat.addColorStop(0.55, '#bdc4c8');
    coat.addColorStop(1, '#a4afb5');
    context.fillStyle = coat;
    context.fill();
    context.strokeStyle = '#7c878d';
    context.lineWidth = 1.3;
    context.stroke();

    context.save();
    bodyPath(context);
    context.clip();
    const face = context.createLinearGradient(0, -63, 0, -19);
    face.addColorStop(0, '#a3adb3');
    face.addColorStop(1, '#78858e');
    context.fillStyle = face;
    context.beginPath();
    context.ellipse(0, -43, 34, 23, 0, 0, Math.PI * 2);
    context.fill();

    // A pale, pointed ruff distinguishes the long coat from a smooth short-haired cat.
    context.fillStyle = '#f3f4f0';
    context.beginPath();
    context.moveTo(-22, -27);
    context.quadraticCurveTo(-11, -32, 0, -28);
    context.quadraticCurveTo(12, -31, 23, -26);
    context.quadraticCurveTo(22, -15, 29, -10);
    context.lineTo(18, -12);
    context.lineTo(21, -5);
    context.lineTo(11, -8);
    context.lineTo(7, 1);
    context.lineTo(0, -3);
    context.lineTo(-8, 1);
    context.lineTo(-12, -8);
    context.lineTo(-22, -4);
    context.lineTo(-19, -12);
    context.lineTo(-28, -11);
    context.quadraticCurveTo(-22, -19, -22, -27);
    context.closePath();
    context.fill();

    context.strokeStyle = 'rgba(102,116,127,0.65)';
    context.lineWidth = 2.4;
    context.beginPath();
    context.moveTo(-18, -59);
    context.quadraticCurveTo(-16, -52, -10, -49);
    context.moveTo(-9, -60);
    context.lineTo(-4, -51);
    context.lineTo(0, -55);
    context.lineTo(5, -50);
    context.lineTo(11, -60);
    context.moveTo(20, -58);
    context.quadraticCurveTo(16, -52, 12, -49);
    context.stroke();
    for (const sign of [-1, 1]) {
      context.beginPath();
      context.moveTo(sign * 32, -44);
      context.quadraticCurveTo(sign * 26, -42, sign * 22, -39);
      context.moveTo(sign * 33, -34);
      context.lineTo(sign * 25, -32);
      context.stroke();
    }

    // A narrow white blaze widens into two pale muzzle pads.
    context.fillStyle = '#f7f7f2';
    context.beginPath();
    context.moveTo(0, -55);
    context.bezierCurveTo(-2, -47, -4, -39, -8, -30);
    context.quadraticCurveTo(-3, -25, 0, -26);
    context.quadraticCurveTo(5, -25, 9, -30);
    context.bezierCurveTo(5, -38, 3, -47, 0, -55);
    context.closePath();
    context.fill();
    for (const x of [-6, 6]) {
      context.beginPath();
      context.ellipse(x, -25.8, 8, 5.2, 0, 0, Math.PI * 2);
      context.fill();
    }
    context.strokeStyle = 'rgba(255,255,255,0.5)';
    context.lineWidth = 1.1;
    for (const [x, y] of [[-36, -21], [-31, -16], [32, -21], [29, -15]]) {
      context.beginPath();
      context.moveTo(x, y);
      context.lineTo(x * 0.85, y + 3);
      context.stroke();
    }
    context.restore();

    context.fillStyle = '#c3b1b7';
    for (const sign of [-1, 1]) {
      context.beginPath();
      context.moveTo(sign * 28, -65);
      context.lineTo(sign * 18, -57);
      context.lineTo(sign * 29, -51);
      context.closePath();
      context.fill();
      context.strokeStyle = 'rgba(239,240,236,0.7)';
      context.lineWidth = 1.2;
      context.beginPath();
      context.moveTo(sign * 28, -67);
      context.lineTo(sign * 26, -58);
      context.stroke();
    }

    const blinking = epochNow % 5300 > 5125 && state.motion !== 'dragged';
    const look = state.motion === 'walking' ? 0.9 : 0;
    for (const eyeX of [-12, 12]) {
      context.lineWidth = 0.9;
      context.strokeStyle = '#56616b';
      context.beginPath();
      if (blinking) {
        context.moveTo(eyeX - 4.2, -38);
        context.quadraticCurveTo(eyeX, -35.8, eyeX + 4.2, -38);
        context.stroke();
      } else {
        context.ellipse(eyeX + look, -38.5, 5.1, state.motion === 'dragged' ? 5.1 : 4.6, -0.08, 0, Math.PI * 2);
        context.fillStyle = '#bec57e';
        context.fill();
        context.stroke();
        context.beginPath();
        context.ellipse(eyeX + look + 0.35, -38.5, 2, 3.5, 0, 0, Math.PI * 2);
        context.fillStyle = '#303b41';
        context.fill();
        context.beginPath();
        context.arc(eyeX + look - 1.3, -40.1, 0.85, 0, Math.PI * 2);
        context.fillStyle = '#f6f7e8';
        context.fill();
      }
    }

    context.beginPath();
    context.moveTo(-3.7, -29);
    context.quadraticCurveTo(0, -30, 3.7, -29);
    context.lineTo(0, -25.9);
    context.closePath();
    context.fillStyle = '#c493a0';
    context.fill();
    context.beginPath();
    context.moveTo(0, -29.4);
    context.lineTo(3.7, -29);
    context.lineTo(0, -25.9);
    context.lineTo(-0.7, -27.4);
    context.closePath();
    context.fillStyle = '#38434b';
    context.fill();
    context.strokeStyle = '#6e7780';
    context.lineWidth = 0.9;
    context.beginPath();
    context.moveTo(0, -25.9);
    context.lineTo(0, -23.3);
    context.moveTo(-4, -22.2);
    context.quadraticCurveTo(-1.5, -20.4, 0, -23.3);
    context.quadraticCurveTo(1.5, -20.4, 4, -22.2);
    context.stroke();
    if (state.motion === 'idle' && epochNow % 7600 < 1900) {
      context.fillStyle = '#cb8898';
      context.beginPath();
      context.ellipse(1.1, -20.5, 1.8, 2.1, -0.18, 0, Math.PI * 2);
      context.fill();
    }

    context.strokeStyle = 'rgba(249,250,245,0.85)';
    context.lineWidth = 0.85;
    for (const sign of [-1, 1]) {
      context.beginPath();
      context.moveTo(sign * 14, -29);
      context.lineTo(sign * 38, -32);
      context.moveTo(sign * 15, -26);
      context.lineTo(sign * 43, -25);
      context.moveTo(sign * 15, -24);
      context.lineTo(sign * 37, -20);
      context.stroke();
    }

    const stride = state.motion === 'walking' ? Math.sin(elapsed / 145) * 1.35 : 0;
    for (const [x, lift] of [[-16, Math.max(0, stride)], [16, Math.max(0, -stride)]]) {
      context.beginPath();
      context.ellipse(x, -3.2 - lift, 9.5, 4.1, 0, 0, Math.PI * 2);
      context.fillStyle = '#f3f4ef';
      context.fill();
      context.strokeStyle = '#9aa5ab';
      context.lineWidth = 0.9;
      context.stroke();
      context.beginPath();
      context.moveTo(x - 2.4, -4.5 - lift);
      context.lineTo(x - 2.4, -1.5 - lift);
      context.moveTo(x + 2.4, -4.5 - lift);
      context.lineTo(x + 2.4, -1.5 - lift);
      context.stroke();
    }
  },
};
