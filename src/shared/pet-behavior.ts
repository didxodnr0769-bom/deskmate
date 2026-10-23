import type { Point, Rect } from './contracts';

export type PetActivity = 'idle' | 'turn' | 'walk' | 'groom' | 'stretch' | 'sleep';

/** Local visual state; no persisted settings or AI requests are involved. */
export interface PetAnimationState {
  activity: PetActivity;
  fromActivity?: PetActivity;
  facing: 1 | -1;
  fromFacing: 1 | -1;
  startedAt: number;
  durationMs: number;
  speed: number;
  distance: number;
  sampledAt: number;
  previousWalkDistance?: number;
  strideDistance?: number;
}

interface PetStep {
  now: number;
  seconds: number;
  position: Point;
  bounds: Rect;
  workArea: Rect;
  scale: number;
  allowMovement: boolean;
}

interface Journey {
  start: Point;
  target: Point;
  elapsedMs: number;
  durationMs: number;
}

const rests = ['idle', 'groom', 'idle', 'stretch', 'idle', 'sleep'] as const;
const smooth = (amount: number) => amount * amount * (3 - 2 * amount);
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, Math.max(min, max)));

/** Plans short, eased trips and quiet pet behaviours independently of native windows. */
export class PetBehavior {
  animation: PetAnimationState;
  private journey: Journey | null = null;
  private restIndex = 0;
  private lastAt: number;

  constructor(now: number, facing: 1 | -1 = 1, private readonly random = Math.random) {
    this.animation = this.pose('idle', now, 1_800, facing);
    this.lastAt = now;
  }

  reset(now: number, facing = this.animation.facing): void {
    this.journey = null;
    this.animation = this.pose('idle', now, 1_800, facing);
    this.lastAt = now;
  }

  private pose(activity: PetActivity, now: number, durationMs: number, facing: 1 | -1,
    fromFacing = facing, distance = 0): PetAnimationState {
    return { activity, fromActivity: this.animation?.activity, facing, fromFacing, startedAt: now, durationMs, speed: 0, distance, strideDistance: 0, sampledAt: now,
      ...(this.animation?.activity === 'walk' ? { previousWalkDistance: this.animation.strideDistance ?? this.animation.distance } : {}) };
  }

  private unit(): number {
    const value = this.random();
    return Number.isFinite(value) ? clamp(value, 0, 0.999999) : 0.5;
  }

  private rest(now: number): void {
    const activity = rests[this.restIndex++ % rests.length];
    const duration = activity === 'groom' ? 4_800 : activity === 'stretch' ? 3_200
      : activity === 'sleep' ? 12_000 + this.unit() * 6_000 : 2_000 + this.unit() * 2_000;
    this.journey = null;
    this.animation = this.pose(activity, now, duration, this.animation.facing);
  }

  private planTrip(input: PetStep): void {
    const { position, bounds, workArea, now } = input;
    const scale = Math.max(0.05, input.scale);
    const maxX = workArea.x + Math.max(0, workArea.width - bounds.width);
    const maxY = workArea.y + Math.max(0, workArea.height - bounds.height);
    const facing = this.unit() < 0.3 ? (this.animation.facing === 1 ? -1 : 1) : this.animation.facing;
    const length = (85 + this.unit() * 115) * scale;
    let x = clamp(position.x + facing * length, workArea.x, maxX);
    // Turn before walking away from a nearby boundary instead of bouncing in place.
    if (Math.abs(x - position.x) < 16 * scale) x = clamp(position.x - facing * length, workArea.x, maxX);
    const y = clamp(position.y + (this.unit() - 0.5) * 110 * scale, workArea.y, maxY);
    const target = { x, y };
    const distance = Math.hypot(target.x - position.x, target.y - position.y);
    if (distance < 2) { this.rest(now); return; }
    const nextFacing = target.x < position.x ? -1 : target.x > position.x ? 1 : this.animation.facing;
    // Smoothstep peaks at 1.5 times its average speed; keep the peak at about 40 px/s.
    this.journey = { start: { ...position }, target, elapsedMs: 0,
      durationMs: Math.max(1_300, distance / (40 * scale) * 1_500) };
    const turnDuration = this.animation.activity === 'sleep' ? 1_000 : 420;
    this.animation = this.pose('turn', now, turnDuration, nextFacing, this.animation.facing);
  }

  advance(input: PetStep): { position: Point; animation: PetAnimationState; transitioned: boolean } {
    const previous = this.animation.activity;
    const previousStartedAt = this.animation.startedAt;
    const { now, position } = input;
    // Resume at the dropped/current position after a sleep or a clock adjustment.
    if (now < this.lastAt || now - this.lastAt > 1_500) {
      this.reset(now);
      return { position, animation: this.animation, transitioned: true };
    }
    this.lastAt = now;
    if (!input.allowMovement && (previous === 'turn' || previous === 'walk')) this.rest(now);
    if (this.animation.activity === 'walk' && this.journey) {
      const seconds = Number.isFinite(input.seconds) ? clamp(input.seconds, 0, 0.1) : 0;
      const journey = this.journey;
      journey.elapsedMs = Math.min(journey.durationMs, journey.elapsedMs + seconds * 1_000);
      const amount = smooth(journey.elapsedMs / journey.durationMs);
      const next = { x: journey.start.x + (journey.target.x - journey.start.x) * amount,
        y: journey.start.y + (journey.target.y - journey.start.y) * amount };
      const travelled = Math.hypot(next.x - position.x, next.y - position.y) / Math.max(0.05, input.scale);
      this.animation = { ...this.animation, distance: this.animation.distance + travelled,
        strideDistance: (this.animation.strideDistance ?? 0) + Math.abs(next.x - position.x) / Math.max(0.05, input.scale),
        speed: seconds > 0 ? travelled / seconds : 0, sampledAt: now };
      if (journey.elapsedMs >= journey.durationMs) this.rest(now);
      return { position: next, animation: this.animation, transitioned: previous !== this.animation.activity || previousStartedAt !== this.animation.startedAt };
    }
    if (now - this.animation.startedAt >= this.animation.durationMs) {
      if (this.animation.activity === 'turn' && this.journey) {
        this.animation = this.pose('walk', now, this.journey.durationMs, this.animation.facing);
      } else if (input.allowMovement) this.planTrip(input);
      else this.rest(now);
    }
    return { position, animation: this.animation, transitioned: previous !== this.animation.activity || previousStartedAt !== this.animation.startedAt };
  }
}
