// Fast-resolve match tier — a deterministic, seeded statistical model that produces a scoreline + the
// same per-player --summary stats the real engine emits, WITHOUT the ~356k-step physics simulation. It is
// FM's "instant result" to the C++ engine's full match: same seed + spec ⇒ same result, so a headless
// season and a live one stay reproducible, but a match resolves in microseconds instead of ~1–2s (much
// worse under load). Gated by FOOTY_FAST_SIM so watched/human matches keep full-engine fidelity by
// default; bulk AI-vs-AI (leagues, cups, virtual ties) and autonomous "next turn" ticks at scale flip it
// on. Kept deliberately in lockstep with the build/live-stub.cjs model it was promoted from.
import type { SummaryResult, SummaryPlayer } from './match.ts';

// FOOTY_FAST_SIM=1/true/on → resolve --summary matches via this model instead of spawning the engine.
export function fastSimEnabled(): boolean {
  const v = (process.env.FOOTY_FAST_SIM ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

function mulberry32(a: number): () => number {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ROLES = ['GK', 'FB', 'CB', 'CB', 'FB', 'CM', 'CM', 'WM', 'WM', 'CF', 'CF'];

interface SpecPlayer { name?: string; role?: string; attrs?: Record<string, unknown> }
interface SpecSide { players?: SpecPlayer[] }
export interface MatchSpec { seed?: number; home?: SpecSide; away?: SpecSide }

function attrMean(p: SpecPlayer): number {
  const a = p.attrs ?? {};
  const ks = Object.keys(a);
  if (!ks.length) return 60;
  return ks.reduce((s, k) => s + (Number(a[k]) || 0), 0) / ks.length;
}
function teamStrength(side: SpecSide | undefined): number {
  const ps = (side?.players ?? []).slice(0, 11);
  return ps.length ? ps.reduce((s, p) => s + attrMean(p), 0) / ps.length : 60;
}

// Deterministically resolve a spec to a full SummaryResult. Pure — the only entropy is the spec seed.
export function fastSimSummary(spec: MatchSpec): SummaryResult {
  const rnd = mulberry32((spec.seed! | 0) || 1);
  const homeStr = teamStrength(spec.home), awayStr = teamStrength(spec.away);

  // Expected goals scale gently with the strength gap + home advantage; a sum of biased coin flips
  // approximates a low-mean Poisson without pulling in a distribution lib.
  const goalsFor = (str: number, oppStr: number, homeAdv: number): number => {
    const lambda = Math.max(0.2, 1.35 + (str - oppStr) / 22 + homeAdv);
    let g = 0; for (let i = 0; i < 6; i++) if (rnd() < lambda / 6) g++;
    return g;
  };
  const homeScore = goalsFor(homeStr, awayStr, 0.25);
  const awayScore = goalsFor(awayStr, homeStr, 0);

  const buildPlayers = (side: SpecSide | undefined, offset: number, teamTag: 'home' | 'away', score: number): SummaryPlayer[] => {
    const ps = (side?.players ?? []).slice(0, 11);
    const out: SummaryPlayer[] = ps.map((p, i) => ({
      id: offset + i, name: p.name || `P${offset + i}`, role: p.role || ROLES[i] || 'CM', team: teamTag,
      goals: 0, assists: 0,
      shots: Math.floor(rnd() * 3), tackles: Math.floor(rnd() * 4),
      passes: 20 + Math.floor(rnd() * 45), passesCompleted: 0,
      yellow: rnd() < 0.08 ? 1 : 0, sentOff: false,
    }));
    out.forEach(pl => { pl.passesCompleted = Math.floor(pl.passes * (0.6 + rnd() * 0.35)); });
    const weight = (r: string): number => r === 'CF' ? 5 : r === 'WM' ? 3 : r === 'CM' ? 2 : r === 'FB' ? 1 : 0.4;
    const pick = (): SummaryPlayer => {
      const pool = out.filter(pl => pl.role !== 'GK');
      const tot = pool.reduce((s, pl) => s + weight(pl.role), 0);
      let r = rnd() * tot;
      for (const pl of pool) { r -= weight(pl.role); if (r <= 0) return pl; }
      return pool[0] ?? out[0];
    };
    for (let g = 0; g < score; g++) {
      const scorer = pick(); scorer.goals++; scorer.shots++;
      if (rnd() < 0.7) { const a = pick(); if (a !== scorer) a.assists++; }
    }
    const y2 = out.find(pl => pl.yellow === 1 && rnd() < 0.15);   // a rare second yellow → red
    if (y2) y2.sentOff = true;
    return out;
  };

  return {
    homeScore, awayScore,
    players: [...buildPlayers(spec.home, 0, 'home', homeScore), ...buildPlayers(spec.away, 11, 'away', awayScore)],
  };
}
