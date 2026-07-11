// Deterministic web-layer penalty shootouts for every knockout competition.
//
// This deliberately uses its own RNG stream, derived from the match seed, so resolving a draw never
// changes (or depends on) the engine's RNG consumption. The same seed + the same two XIs therefore
// always produces the same shootout. Takers are ordered by shooting; formation slot 0 is the keeper,
// matching the engine, and that player's positioning affects saves.

export interface ShootoutPlayer {
  role?: string;
  attrs: Record<string, number>;
}

export interface PenaltyShootoutResult { home: number; away: number }

const DEFAULT_PLAYER: ShootoutPlayer = { attrs: {} };
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
const attr = (p: ShootoutPlayer | undefined, key: string, fallback: number): number => {
  const value = p?.attrs?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value, 0, 100) : fallback;
};

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function keeperFor(squad: readonly ShootoutPlayer[]): ShootoutPlayer {
  return squad[0] ?? DEFAULT_PLAYER;
}

function takersFor(squad: readonly ShootoutPlayer[]): ShootoutPlayer[] {
  const source = squad.length ? squad : [DEFAULT_PLAYER];
  return source.map((player, index) => ({ player, index }))
    .sort((a, b) => attr(b.player, 'shooting', 50) - attr(a.player, 'shooting', 50) || a.index - b.index)
    .map(x => x.player);
}

function conversionChance(taker: ShootoutPlayer, keeper: ShootoutPlayer): number {
  const shooting = attr(taker, 'shooting', 50);
  const positioning = attr(keeper, 'positioning', 50);
  // About 76% for a solid taker against a strong keeper, with enough attribute leverage for squad
  // selection to matter without turning poor takers into automatic misses or stars into certainties.
  return clamp(0.76 + (shooting - 65) / 400 - (positioning - 65) / 500, 0.55, 0.92);
}

// Sudden death is bounded (hostile/malformed inputs must terminate); the max total score a side
// can reach is 5 regulation + the sudden-death rounds + the final forced kick. The test asserts
// against MAX_SHOOTOUT_SCORE so the two numbers can never drift apart.
export const SUDDEN_DEATH_ROUNDS = 100;
export const MAX_SHOOTOUT_SCORE = 5 + SUDDEN_DEATH_ROUNDS + 1;

// Best of five with normal early completion, then paired sudden death until the scores differ.
export function simulatePenaltyShootout(seed: number, home: readonly ShootoutPlayer[], away: readonly ShootoutPlayer[]): PenaltyShootoutResult {
  const normalizedSeed = Number.isFinite(seed) ? Math.trunc(seed) : 0;
  const rnd = mulberry32((normalizedSeed ^ 0x5eed5eed) >>> 0);
  const homeTakers = takersFor(home), awayTakers = takersFor(away);
  const homeKeeper = keeperFor(home), awayKeeper = keeperFor(away);
  const scores = { home: 0, away: 0 };
  const kick = (taker: ShootoutPlayer, keeper: ShootoutPlayer): boolean => rnd() < conversionChance(taker, keeper);

  for (let round = 0; round < 5; round++) {
    if (kick(homeTakers[round % homeTakers.length], awayKeeper)) scores.home++;
    const homeLeft = 4 - round, awayLeft = 5 - round; // away still has this round's kick
    if (scores.home > scores.away + awayLeft || scores.away > scores.home + homeLeft) return scores;

    if (kick(awayTakers[round % awayTakers.length], homeKeeper)) scores.away++;
    const eachLeft = 4 - round;
    if (scores.home > scores.away + eachLeft || scores.away > scores.home + eachLeft) return scores;
  }

  for (let round = 5; round < 5 + SUDDEN_DEATH_ROUNDS; round++) {
    if (kick(homeTakers[round % homeTakers.length], awayKeeper)) scores.home++;
    if (kick(awayTakers[round % awayTakers.length], homeKeeper)) scores.away++;
    if (scores.home !== scores.away) return scores;
  }
  // Practically unreachable, but keep hostile/malformed inputs bounded without the old home-side bias.
  if (rnd() < 0.5) scores.home++; else scores.away++;
  return scores;
}
