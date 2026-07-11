// National teams + international tournaments (engine-free). National squads are selected on-demand from
// players (+ free agents) by nationality — no materialized teams/players rows — and play via the engine
// through match.ts playVirtualTie (a pure spec, zero engine change). Tournaments (World Cup every 4th
// season; continental in the others) run in a burst at season rollover, so the league calendar is
// untouched. A drawn knockout is settled by a deterministic penalty shootout (better than a coin-flip).
import { db } from './db.ts';
import { worldLeagues } from './season.ts';
import { ROLE_SLOTS, overall } from './game.ts';
import { playVirtualTie, type VirtualPlayer } from './match.ts';
import { NATION_BY_KEY, NATIONS_BY_CONFED, CONFED_TOURNAMENT, nationName, type Confed } from './nations.ts';

const parseJSON = (s: string | null): unknown => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
function mulberry32(a: number) {
  return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

interface PoolPlayer { name: string; role: string; attrs: Record<string, number>; personality: unknown; ovr: number }
function poolFor(worldId: number, nationKey: string): PoolPlayer[] {
  const leagueIds = worldLeagues(worldId).map(l => l.id);
  if (!leagueIds.length) return [];
  const ph = leagueIds.map(() => '?').join(',');
  const club = db.prepare(`SELECT p.name, p.role, p.attrs, p.personality FROM players p JOIN teams t ON t.id = p.team_id WHERE t.league_id IN (${ph}) AND p.nationality = ?`).all(...leagueIds, nationKey) as { name: string; role: string; attrs: string; personality: string | null }[];
  const fas = db.prepare(`SELECT name, role, attrs, personality FROM free_agents WHERE league_id IN (${ph}) AND nationality = ?`).all(...leagueIds, nationKey) as { name: string; role: string; attrs: string; personality: string | null }[];
  return [...club, ...fas].map(p => { const attrs = JSON.parse(p.attrs) as Record<string, number>; return { name: p.name, role: p.role, attrs, personality: parseJSON(p.personality), ovr: overall(attrs) }; });
}

// The best XI for a nation, ordered to the default formation's slots (GK first). null if < 11 available.
export function selectNationalSquad(worldId: number, nationKey: string): VirtualPlayer[] | null {
  const pool = poolFor(worldId, nationKey).sort((a, b) => b.ovr - a.ovr);
  if (pool.length < 11) return null;
  const used = new Set<number>(); const xi: VirtualPlayer[] = [];
  for (const role of ROLE_SLOTS) {
    let idx = pool.findIndex((p, i) => !used.has(i) && p.role === role);
    if (idx < 0) idx = pool.findIndex((_, i) => !used.has(i));   // pad with the best remaining of any role
    used.add(idx); const p = pool[idx];
    xi.push({ name: p.name, role: p.role, attrs: p.attrs, personality: p.personality });
  }
  return xi;
}

export interface FieldableNation { key: string; confed: Confed; count: number; strength: number }
export function fieldableNations(worldId: number): FieldableNation[] {
  const leagueIds = worldLeagues(worldId).map(l => l.id);
  if (!leagueIds.length) return [];
  const ph = leagueIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT nationality AS nat, COUNT(*) AS c FROM (
      SELECT p.nationality FROM players p JOIN teams t ON t.id = p.team_id WHERE t.league_id IN (${ph})
      UNION ALL SELECT nationality FROM free_agents WHERE league_id IN (${ph})
    ) GROUP BY nationality HAVING c >= 11`).all(...leagueIds, ...leagueIds) as { nat: string; c: number }[];
  return rows.filter(r => NATION_BY_KEY.has(r.nat)).map(r => {
    const top = poolFor(worldId, r.nat).sort((a, b) => b.ovr - a.ovr).slice(0, 11);
    const strength = top.length ? Math.round(top.reduce((s, p) => s + p.ovr, 0) / top.length) : 0;
    return { key: r.nat, confed: NATION_BY_KEY.get(r.nat)!.confed, count: r.c, strength };
  });
}

// Deterministic best-of-5 (+ sudden death) shootout from the two squads' penalty takers (shooting attr).
function penShootout(seed: number, home: VirtualPlayer[], away: VirtualPlayer[]): { home: number; away: number } {
  const rnd = mulberry32((seed ^ 0x5eed5eed) >>> 0);
  const takers = (sq: VirtualPlayer[]) => sq.slice().sort((a, b) => (b.attrs.shooting ?? 50) - (a.attrs.shooting ?? 50));
  const ht = takers(home), at = takers(away);
  const prob = (p?: VirtualPlayer) => Math.max(0.5, Math.min(0.92, 0.62 + (((p?.attrs.shooting ?? 60) - 65) / 150)));
  let hs = 0, as_ = 0;
  for (let k = 0; k < 5; k++) { if (rnd() < prob(ht[k % ht.length])) hs++; if (rnd() < prob(at[k % at.length])) as_++; }
  for (let r = 5; hs === as_ && r < 30; r++) { if (rnd() < prob(ht[r % ht.length])) hs++; if (rnd() < prob(at[r % at.length])) as_++; }
  if (hs === as_) hs++;   // safety: never return a level shootout
  return { home: hs, away: as_ };
}

function createTournament(worldId: number, season: number, kind: string, confed: string | null, name: string): number {
  const r = db.prepare('INSERT INTO tournaments (world_id, season, kind, confed, name, created_at) VALUES (?,?,?,?,?,?)').run(worldId, season, kind, confed, name, Date.now());
  return Number(r.lastInsertRowid);
}
function seedBracket(keys: string[], seed: number): string[] {
  const rnd = mulberry32(seed >>> 0); const a = keys.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function largestPow2(n: number): number { let p = 1; while (p * 2 <= n) p *= 2; return p; }

// Play a single-elimination knockout to a champion, recording every tie. Sequential (off-season burst —
// bounds engine spawns). Squads are re-selected per tie (cheap; the roster is fixed for the tournament).
async function runKnockout(tournamentId: number, seeded: string[], worldId: number, baseSeed: number): Promise<string> {
  let round = 1; let alive = seeded.slice();
  while (alive.length > 1) {
    const winners: string[] = [];
    for (let slot = 0; slot < alive.length; slot += 2) {
      const h = alive[slot], a = alive[slot + 1];
      const seed = ((baseSeed ^ (round * 100003 + (slot / 2) * 131)) >>> 0) || 1;
      const hs = selectNationalSquad(worldId, h)!, as_ = selectNationalSquad(worldId, a)!;
      const res = await playVirtualTie(seed, nationName(h), hs, nationName(a), as_, 'nat');
      let winner: string, hp: number | null = null, ap: number | null = null;
      if (res.homeScore > res.awayScore) winner = h;
      else if (res.awayScore > res.homeScore) winner = a;
      else { const pen = penShootout(seed, hs, as_); hp = pen.home; ap = pen.away; winner = pen.home > pen.away ? h : a; }
      db.prepare('INSERT INTO tournament_ties (tournament_id, round, slot, home_nation, away_nation, seed, played, home_score, away_score, home_pens, away_pens, winner_nation) VALUES (?,?,?,?,?,?,1,?,?,?,?,?)')
        .run(tournamentId, round, slot / 2, h, a, seed, res.homeScore, res.awayScore, hp, ap, winner);
      winners.push(winner);
    }
    alive = winners; round++;
  }
  return alive[0];
}

export interface HeldTournament { name: string; kind: string; confed: string | null; champion: string; teams: number }
// Run this season's internationals for a world (idempotent-ish: skip if already held this world+season).
// World Cup on season%4===0; otherwise the continental cups (one per confederation with >=4 fieldable).
export async function runInternationalTournaments(worldId: number, season: number): Promise<HeldTournament[]> {
  if ((db.prepare('SELECT 1 FROM tournaments WHERE world_id = ? AND season = ? LIMIT 1').get(worldId, season))) return [];
  const fieldable = fieldableNations(worldId).sort((a, b) => b.strength - a.strength);
  if (fieldable.length < 4) return [];
  const baseSeed = ((worldId * 7919 + season * 104729) >>> 0) || 1;
  const held: HeldTournament[] = [];
  if (season % 4 === 0) {
    const size = Math.min(16, largestPow2(fieldable.length));
    const nats = seedBracket(fieldable.slice(0, size).map(f => f.key), baseSeed);
    const id = createTournament(worldId, season, 'world_cup', null, 'World Cup');
    const champ = await runKnockout(id, nats, worldId, baseSeed);
    db.prepare('UPDATE tournaments SET champion = ? WHERE id = ?').run(champ, id);
    held.push({ name: 'World Cup', kind: 'world_cup', confed: null, champion: champ, teams: size });
  } else {
    for (const [confed] of NATIONS_BY_CONFED) {
      const f = fieldable.filter(x => x.confed === confed);
      if (f.length < 4) continue;
      const size = Math.min(8, largestPow2(f.length));
      const nats = seedBracket(f.slice(0, size).map(x => x.key), (baseSeed ^ confed.charCodeAt(0)) >>> 0);
      const name = CONFED_TOURNAMENT[confed];
      const id = createTournament(worldId, season, 'continental', confed, name);
      const champ = await runKnockout(id, nats, worldId, (baseSeed ^ (confed.charCodeAt(1) || 7)) >>> 0);
      db.prepare('UPDATE tournaments SET champion = ? WHERE id = ?').run(champ, id);
      held.push({ name, kind: 'continental', confed, champion: champ, teams: size });
    }
  }
  return held;
}

// ── Read side (for the UI) ──────────────────────────────────────────────────
export interface TournamentTieView { round: number; slot: number; home: string | null; away: string | null; homeScore: number | null; awayScore: number | null; homePens: number | null; awayPens: number | null; winner: string | null }
export interface TournamentView { id: number; season: number; kind: string; confed: string | null; name: string; champion: string | null; ties: TournamentTieView[] }

export function getWorldTournaments(worldId: number, limit = 12): TournamentView[] {
  const ts = db.prepare('SELECT id, season, kind, confed, name, champion FROM tournaments WHERE world_id = ? ORDER BY season DESC, id DESC LIMIT ?').all(worldId, limit) as { id: number; season: number; kind: string; confed: string | null; name: string; champion: string | null }[];
  return ts.map(t => ({ ...t, ties: getTies(t.id) }));
}
function getTies(tournamentId: number): TournamentTieView[] {
  return (db.prepare('SELECT round, slot, home_nation, away_nation, home_score, away_score, home_pens, away_pens, winner_nation FROM tournament_ties WHERE tournament_id = ? ORDER BY round, slot').all(tournamentId) as any[])
    .map(r => ({ round: r.round, slot: r.slot, home: r.home_nation, away: r.away_nation, homeScore: r.home_score, awayScore: r.away_score, homePens: r.home_pens, awayPens: r.away_pens, winner: r.winner_nation }));
}
