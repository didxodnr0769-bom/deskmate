const MINUTE = 60_000;
export const CASUAL_LIFETIME_MS = 12_000;
export const CASUAL_LINES = [
  '오늘 업무는 어때요? 잠깐 이야기해도 좋아요.',
  '조금 심심하네요. 무슨 생각 하고 있어요?',
  '오늘 작은 즐거움이 있었나요?',
  '잠깐 기지개 켜고 같이 쉬어 갈까요?',
  '저는 여기서 조용히 응원하고 있어요.',
] as const;

/** Local phrases only: no provider, history, disk access, or catch-up queue. */
export class CasualConversation {
  private nextAt: number;
  private lastPoll: number;
  private previousLine = -1;
  constructor(now: number, private readonly random = Math.random) {
    this.lastPoll = now;
    this.nextAt = now + this.delay();
  }
  private delay() { return (30 + this.random() * 30) * MINUTE; }
  reset(now: number) { this.lastPoll = now; this.nextAt = now + this.delay(); }
  poll(now: number, allowed: boolean): string | null {
    if (now < this.lastPoll || now - this.lastPoll > MINUTE) { this.reset(now); return null; }
    this.lastPoll = now;
    if (now < this.nextAt) return null;
    const hour = new Date(now).getHours();
    if (!allowed || hour < 8 || hour >= 22) {
      this.nextAt = now + 5 * MINUTE;
      return null;
    }
    const choices = CASUAL_LINES.length - Number(this.previousLine >= 0);
    let index = Math.floor(this.random() * choices);
    if (this.previousLine >= 0 && index >= this.previousLine) index += 1;
    this.previousLine = index;
    this.nextAt = now + this.delay();
    return CASUAL_LINES[index];
  }
}
