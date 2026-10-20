import type { CompanionState, Point, Rect } from '../shared/contracts';

export interface CharacterPose {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
}

/** A character owns its appearance, silhouette and the motion of that appearance. */
export interface CharacterDefinition {
  id: string;
  label: string;
  notification: { jumpCount: number; jumpDurationMs: number; jumpHeight: number };
  hitPolygon: readonly Point[];
  getPose(state: CompanionState, epochNow: number): CharacterPose;
  draw(context: CanvasRenderingContext2D, state: CompanionState, epochNow: number): void;
}

export interface CharacterFrame {
  pose: CharacterPose;
  origin: Point;
  polygon: Point[];
  hp: Rect;
}

export const SCENE_SIZE = { width: 280, height: 300 };

export function getCharacterFrame(
  character: CharacterDefinition,
  state: CompanionState,
  epochNow: number,
): CharacterFrame {
  const pose = character.getPose(state, epochNow);
  const origin = { x: 140 + pose.x, y: 266 + pose.y };
  const cos = Math.cos(pose.rotation);
  const sin = Math.sin(pose.rotation);
  const polygon = character.hitPolygon.map((point) => {
    const x = point.x * pose.scaleX;
    const y = point.y * pose.scaleY;
    return { x: origin.x + x * cos - y * sin, y: origin.y + x * sin + y * cos };
  });
  return { pose, origin, polygon, hp: { x: 71 + pose.x, y: 171 + pose.y, width: 138, height: 17 } };
}

function roundedRect(context: CanvasRenderingContext2D, rect: Rect, radius: number): void {
  context.beginPath();
  context.roundRect(rect.x, rect.y, rect.width, rect.height, radius);
}

export function renderCharacterScene(
  context: CanvasRenderingContext2D,
  character: CharacterDefinition,
  state: CompanionState,
  epochNow: number,
): CharacterFrame {
  context.clearRect(0, 0, SCENE_SIZE.width, SCENE_SIZE.height);
  const frame = getCharacterFrame(character, state, epochNow);

  // The shadow stays on the ground while both the character and its HP jump.
  context.save();
  context.fillStyle = 'rgba(31, 41, 40, 0.12)';
  context.beginPath();
  context.ellipse(140, 269, Math.max(24, 40 + frame.pose.y * 0.3), 5, 0, 0, Math.PI * 2);
  context.fill();
  context.restore();

  const hp = frame.hp;
  context.save();
  context.shadowColor = 'rgba(31, 41, 40, 0.12)';
  context.shadowBlur = 7;
  context.shadowOffsetY = 2;
  roundedRect(context, hp, 5);
  context.fillStyle = '#fafbf6';
  context.fill();
  context.shadowColor = 'transparent';
  context.lineWidth = 1.5;
  context.strokeStyle = '#58675e';
  context.stroke();

  const inner = { x: hp.x + 3, y: hp.y + 3, width: hp.width - 6, height: hp.height - 6 };
  roundedRect(context, inner, 2);
  context.fillStyle = '#dce4d9';
  context.fill();
  const boundedHp = Math.max(0, Math.min(100, state.hp));
  if (boundedHp > 0) {
    context.save();
    roundedRect(context, inner, 2);
    context.clip();
    context.fillStyle = boundedHp >= 100 ? '#7aab54' : '#a0bb75';
    context.fillRect(inner.x, inner.y, inner.width * boundedHp / 100, inner.height);
    context.fillStyle = 'rgba(255,255,255,0.22)';
    context.fillRect(inner.x, inner.y, inner.width * boundedHp / 100, 3);
    context.restore();
  }
  context.strokeStyle = 'rgba(69, 83, 65, 0.15)';
  context.lineWidth = 1;
  for (let index = 1; index < 10; index += 1) {
    const x = inner.x + inner.width * index / 10;
    context.beginPath();
    context.moveTo(x, inner.y);
    context.lineTo(x, inner.y + inner.height);
    context.stroke();
  }
  context.font = '600 9px -apple-system, BlinkMacSystemFont, sans-serif';
  context.textBaseline = 'bottom';
  context.fillStyle = '#52604e';
  context.textAlign = 'left';
  context.fillText('HP', hp.x + 1, hp.y - 4);
  context.textAlign = 'right';
  context.fillText(`${Math.round(boundedHp)}%`, hp.x + hp.width - 1, hp.y - 4);
  context.restore();

  context.save();
  context.translate(frame.origin.x, frame.origin.y);
  context.rotate(frame.pose.rotation);
  context.scale(frame.pose.scaleX, frame.pose.scaleY);
  character.draw(context, state, epochNow);
  context.restore();
  return frame;
}
