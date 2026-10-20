export interface HpAppearance {
  percent: number;
  color: string;
  textColor: string;
}

const HP_BANDS = [
  { maximum: 20, color: '#d86c65', textColor: '#9c3f39' },
  { maximum: 40, color: '#d89a58', textColor: '#94571e' },
  { maximum: 60, color: '#d5bd5f', textColor: '#776016' },
  { maximum: 80, color: '#a0bb75', textColor: '#526b37' },
  { maximum: 100, color: '#4f8255', textColor: '#2f6138' },
] as const;

/** Match main's floored percentage before choosing a band, including fractional input. */
export function getHpAppearance(value: number): HpAppearance {
  const percent = Number.isFinite(value) ? Math.floor(Math.max(0, Math.min(100, value))) : 0;
  const band = HP_BANDS.find((candidate) => percent <= candidate.maximum)!;
  return { percent, color: band.color, textColor: band.textColor };
}
