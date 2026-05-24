let source: (() => number) | null = null;

export function setSeed(seed: number): void {
  let state = seed >>> 0;
  source = () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function clearSeed(): void {
  source = null;
}

export function random(): number {
  return source ? source() : Math.random();
}

export function randomInt(min: number, max: number): number {
  return Math.floor(random() * (max - min + 1)) + min;
}

export function shuffle<T>(values: T[]): T[] {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
