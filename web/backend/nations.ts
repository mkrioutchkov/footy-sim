// Nations, confederations, and flags for national teams + international tournaments. A fixed list (no
// LLM) so every player — not just the human club's — has a real, indexed nationality and a flag emoji.
// Weights bias the deterministic backfill so the traditional footballing nations get deep-enough squads
// (~15+ players in a world) to field a national XI, with a long tail for flavour.

import { db } from './db.ts';

export type Confed = 'UEFA' | 'CONMEBOL' | 'CAF' | 'CONCACAF' | 'AFC' | 'OFC';
export const CONFED_NAME: Record<Confed, string> = {
  UEFA: 'Europe', CONMEBOL: 'South America', CAF: 'Africa', CONCACAF: 'North & Central America', AFC: 'Asia', OFC: 'Oceania',
};
// The flagship continental tournament per confederation (World-Cup-adjacent flavour).
export const CONFED_TOURNAMENT: Record<Confed, string> = {
  UEFA: 'Euros', CONMEBOL: 'Copa América', CAF: 'Africa Cup of Nations', CONCACAF: 'Gold Cup', AFC: 'Asian Cup', OFC: 'Nations Cup',
};

export interface Nation { key: string; name: string; flag: string; confed: Confed; weight: number }

// key = stable slug (stored in players.nationality). weight ↑ = more players in a world. Concentrated so
// ~16-20 traditional footballing nations get a fieldable squad (≥11 players in a ~270-player world) while
// a long tail of minnows gets a handful each (flavour) and doesn't qualify — realistic.
export const NATIONS: Nation[] = [
  // UEFA
  { key: 'ENG', name: 'England', flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', confed: 'UEFA', weight: 15 },
  { key: 'FRA', name: 'France', flag: '🇫🇷', confed: 'UEFA', weight: 15 },
  { key: 'GER', name: 'Germany', flag: '🇩🇪', confed: 'UEFA', weight: 14 },
  { key: 'ESP', name: 'Spain', flag: '🇪🇸', confed: 'UEFA', weight: 14 },
  { key: 'ITA', name: 'Italy', flag: '🇮🇹', confed: 'UEFA', weight: 13 },
  { key: 'NED', name: 'Netherlands', flag: '🇳🇱', confed: 'UEFA', weight: 12 },
  { key: 'POR', name: 'Portugal', flag: '🇵🇹', confed: 'UEFA', weight: 12 },
  { key: 'BEL', name: 'Belgium', flag: '🇧🇪', confed: 'UEFA', weight: 12 },
  { key: 'CRO', name: 'Croatia', flag: '🇭🇷', confed: 'UEFA', weight: 4 },
  { key: 'DEN', name: 'Denmark', flag: '🇩🇰', confed: 'UEFA', weight: 3 },
  { key: 'SUI', name: 'Switzerland', flag: '🇨🇭', confed: 'UEFA', weight: 2 },
  { key: 'SCO', name: 'Scotland', flag: '🏴󠁧󠁢󠁳󠁣󠁴󠁿', confed: 'UEFA', weight: 2 },
  { key: 'POL', name: 'Poland', flag: '🇵🇱', confed: 'UEFA', weight: 2 },
  { key: 'SWE', name: 'Sweden', flag: '🇸🇪', confed: 'UEFA', weight: 1 },
  { key: 'SRB', name: 'Serbia', flag: '🇷🇸', confed: 'UEFA', weight: 1 },
  { key: 'AUT', name: 'Austria', flag: '🇦🇹', confed: 'UEFA', weight: 1 },
  { key: 'NOR', name: 'Norway', flag: '🇳🇴', confed: 'UEFA', weight: 1 },
  { key: 'IRL', name: 'Ireland', flag: '🇮🇪', confed: 'UEFA', weight: 1 },
  { key: 'TUR', name: 'Türkiye', flag: '🇹🇷', confed: 'UEFA', weight: 1 },
  { key: 'UKR', name: 'Ukraine', flag: '🇺🇦', confed: 'UEFA', weight: 1 },
  // CONMEBOL
  { key: 'BRA', name: 'Brazil', flag: '🇧🇷', confed: 'CONMEBOL', weight: 15 },
  { key: 'ARG', name: 'Argentina', flag: '🇦🇷', confed: 'CONMEBOL', weight: 15 },
  { key: 'URU', name: 'Uruguay', flag: '🇺🇾', confed: 'CONMEBOL', weight: 12 },
  { key: 'COL', name: 'Colombia', flag: '🇨🇴', confed: 'CONMEBOL', weight: 12 },
  { key: 'CHI', name: 'Chile', flag: '🇨🇱', confed: 'CONMEBOL', weight: 4 },
  { key: 'PAR', name: 'Paraguay', flag: '🇵🇾', confed: 'CONMEBOL', weight: 2 },
  { key: 'PER', name: 'Peru', flag: '🇵🇪', confed: 'CONMEBOL', weight: 2 },
  { key: 'ECU', name: 'Ecuador', flag: '🇪🇨', confed: 'CONMEBOL', weight: 2 },
  // CAF
  { key: 'NGA', name: 'Nigeria', flag: '🇳🇬', confed: 'CAF', weight: 13 },
  { key: 'SEN', name: 'Senegal', flag: '🇸🇳', confed: 'CAF', weight: 13 },
  { key: 'MAR', name: 'Morocco', flag: '🇲🇦', confed: 'CAF', weight: 12 },
  { key: 'EGY', name: 'Egypt', flag: '🇪🇬', confed: 'CAF', weight: 11 },
  { key: 'CMR', name: 'Cameroon', flag: '🇨🇲', confed: 'CAF', weight: 4 },
  { key: 'GHA', name: 'Ghana', flag: '🇬🇭', confed: 'CAF', weight: 4 },
  { key: 'CIV', name: 'Ivory Coast', flag: '🇨🇮', confed: 'CAF', weight: 3 },
  { key: 'ALG', name: 'Algeria', flag: '🇩🇿', confed: 'CAF', weight: 2 },
  { key: 'RSA', name: 'South Africa', flag: '🇿🇦', confed: 'CAF', weight: 1 },
  // CONCACAF
  { key: 'USA', name: 'United States', flag: '🇺🇸', confed: 'CONCACAF', weight: 12 },
  { key: 'MEX', name: 'Mexico', flag: '🇲🇽', confed: 'CONCACAF', weight: 12 },
  { key: 'CAN', name: 'Canada', flag: '🇨🇦', confed: 'CONCACAF', weight: 5 },
  { key: 'CRC', name: 'Costa Rica', flag: '🇨🇷', confed: 'CONCACAF', weight: 2 },
  { key: 'JAM', name: 'Jamaica', flag: '🇯🇲', confed: 'CONCACAF', weight: 2 },
  // AFC
  { key: 'JPN', name: 'Japan', flag: '🇯🇵', confed: 'AFC', weight: 12 },
  { key: 'KOR', name: 'South Korea', flag: '🇰🇷', confed: 'AFC', weight: 12 },
  { key: 'AUS', name: 'Australia', flag: '🇦🇺', confed: 'AFC', weight: 5 },
  { key: 'IRN', name: 'Iran', flag: '🇮🇷', confed: 'AFC', weight: 4 },
  { key: 'KSA', name: 'Saudi Arabia', flag: '🇸🇦', confed: 'AFC', weight: 2 },
  { key: 'QAT', name: 'Qatar', flag: '🇶🇦', confed: 'AFC', weight: 1 },
  // OFC
  { key: 'NZL', name: 'New Zealand', flag: '🇳🇿', confed: 'OFC', weight: 2 },
];

export const NATION_BY_KEY = new Map(NATIONS.map(n => [n.key, n]));
export const NATIONS_BY_CONFED = (() => {
  const m = new Map<Confed, Nation[]>();
  for (const n of NATIONS) { const a = m.get(n.confed) ?? []; a.push(n); m.set(n.confed, a); }
  return m;
})();

export function nationName(key: string | null | undefined): string {
  return (key && NATION_BY_KEY.get(key)?.name) || 'Unknown';
}

// Deterministic weighted nation for a player id (stable — players.id never changes/reuses). Same id ⇒ same
// nation, so a re-run of the backfill is idempotent and a replay is stable.
const TOTAL_WEIGHT = NATIONS.reduce((s, n) => s + n.weight, 0);
export function nationForPlayer(playerId: number): string {
  // a cheap well-mixing hash of the id → [0,1)
  let h = (playerId | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  const u = ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  let r = u * TOTAL_WEIGHT;
  for (const n of NATIONS) { r -= n.weight; if (r <= 0) return n.key; }
  return NATIONS[NATIONS.length - 1].key;
}

// Assign a nation (by id, deterministic) to every player/free-agent that lacks one. Idempotent — only
// touches blank rows, so a re-run at rollover just catches new youth intake / signings. If a player's LLM
// personality already named a real nation we keep the fixed-list key; otherwise the id-seeded pick.
export function backfillNationalities(): void {
  for (const table of ['players', 'free_agents'] as const) {
    const rows = db.prepare(`SELECT id FROM ${table} WHERE nationality IS NULL OR nationality = ''`).all() as { id: number }[];
    if (!rows.length) continue;
    const upd = db.prepare(`UPDATE ${table} SET nationality = ? WHERE id = ?`);
    for (const r of rows) upd.run(nationForPlayer(r.id), r.id);
  }
}
