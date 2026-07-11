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
import { simulatePenaltyShootout, mulberry32 } from './shootout.ts';

const parseJSON = (s: string | null): unknown => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

interface PoolPlayer { name: string; role: string; attrs: Record<string, number>; personality: unknown; ovr: number }
function poolFor(worldId: number, nationKey: string): PoolPlayer[] {
  const leagueIds = worldLeagues(worldId).map(l => l.id);
  if (!leagueIds.length) return [];
  const ph = leagueIds.map(() => '?').join(',');
  const club = db.prepare(`SELECT p.name, p.role, p.attrs, p.personality FROM players p JOIN teams t ON t.id = p.team_id WHERE t.league_id IN (${ph}) AND p.nationality = ?`).all(...leagueIds, nationKey) as { name: string; role: string; attrs: string; personality: string | null }[];
  const fas = db.prepare(`SELECT name, role, attrs, personality FROM free_agents WHERE league_id IN (${ph}) AND nationality = ?`).all(...leagueIds, nationKey) as { name: string; role: string; attrs: string; personality: string | null }[];
  return [...club, ...fas].map(p => { const attrs = JSON.parse(p.attrs) as Record<string, number>; return { name: p.name, role: p.role, attrs, personality: parseJSON(p.personality), ovr: overall(attrs) }; });
}

// One best-XI picker for BOTH resolvers (national squads and Club World Cup clubs): sort the pool
// by overall, fill the default formation's role slots (GK first — shootout.ts trusts slot 0 as the
// keeper), pad with the best remaining. Two hand-kept copies of this loop would let the two
// tournament families silently pick XIs by different rules.
interface XiCandidate { name: string; role: string; attrs: Record<string, number>; personality: unknown; ovr: number }
function pickXI(pool: XiCandidate[]): VirtualPlayer[] | null {
  const sorted = pool.slice().sort((a, b) => b.ovr - a.ovr);
  if (sorted.length < 11) return null;
  const used = new Set<number>(); const xi: VirtualPlayer[] = [];
  for (const role of ROLE_SLOTS) {
    let idx = sorted.findIndex((p, i) => !used.has(i) && p.role === role);
    if (idx < 0) idx = sorted.findIndex((_, i) => !used.has(i));   // pad with the best remaining of any role
    used.add(idx); const p = sorted[idx];
    xi.push({ name: p.name, role: p.role, attrs: p.attrs, personality: p.personality });
  }
  return xi;
}

// The best XI for a nation, ordered to the default formation's slots (GK first). null if < 11 available.
export function selectNationalSquad(worldId: number, nationKey: string): VirtualPlayer[] | null {
  return pickXI(poolFor(worldId, nationKey));
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

// Resolve an entrant key (nation key or club label) to its XI. Nations key by NATION key; clubs key by
// their (world-unique) name — that key is what's stored in the tie rows and rendered by the UI (a club
// name has no flag, so it shows as-is). Returns null if the entrant can't field 11 (never happens for a
// vetted field). Shared so nations and clubs run through one knockout.
type SquadResolver = (key: string) => VirtualPlayer[] | null;

// Play a single-elimination knockout to a champion, recording every tie. Sequential (off-season burst —
// bounds engine spawns). Squads are re-selected per tie (cheap; the roster is fixed for the tournament).
async function runKnockout(tournamentId: number, seeded: string[], baseSeed: number, resolve: SquadResolver, label: (k: string) => string, tag: string): Promise<string> {
  let round = 1; let alive = seeded.slice();
  while (alive.length > 1) {
    const winners: string[] = [];
    for (let slot = 0; slot < alive.length; slot += 2) {
      const h = alive[slot], a = alive[slot + 1];
      const seed = ((baseSeed ^ (round * 100003 + (slot / 2) * 131)) >>> 0) || 1;
      const hs = resolve(h)!, as_ = resolve(a)!;
      const res = await playVirtualTie(seed, label(h), hs, label(a), as_, tag);
      let winner: string, hp: number | null = null, ap: number | null = null;
      if (res.homeScore > res.awayScore) winner = h;
      else if (res.awayScore > res.homeScore) winner = a;
      else { const pen = simulatePenaltyShootout(seed, hs, as_); hp = pen.home; ap = pen.away; winner = pen.home > pen.away ? h : a; }
      db.prepare('INSERT INTO tournament_ties (tournament_id, round, slot, home_nation, away_nation, seed, played, home_score, away_score, home_pens, away_pens, winner_nation) VALUES (?,?,?,?,?,?,1,?,?,?,?,?)')
        .run(tournamentId, round, slot / 2, h, a, seed, res.homeScore, res.awayScore, hp, ap, winner);
      winners.push(winner);
    }
    alive = winners; round++;
  }
  return alive[0];
}

// ── Club World Cup ──────────────────────────────────────────────────────────
// The world's strongest CLUBS (across every division) contest a knockout every 4 seasons — the same
// engine-free virtual-tie machinery as the national cups, entrants keyed by club name. A faithful stand-in
// for a true cross-country CWC until worlds span multiple countries; here "the world's best clubs" is a
// robust, always-available field (ranked by best-XI strength, no dependency on standings history).
function clubXI(worldId: number, teamId: number): { xi: VirtualPlayer[]; strength: number } | null {
  const rows = db.prepare('SELECT name, role, attrs, personality FROM players WHERE team_id = ?').all(teamId) as { name: string; role: string; attrs: string; personality: string | null }[];
  const pool = rows.map(p => { const attrs = JSON.parse(p.attrs) as Record<string, number>; return { name: p.name, role: p.role, attrs, personality: parseJSON(p.personality), ovr: overall(attrs) }; });
  const xi = pickXI(pool);
  if (!xi) return null;
  const strength = Math.round(xi.slice(0, 11).reduce((s, p) => s + overall(p.attrs), 0) / 11);
  return { xi, strength };
}

interface ClubEntry { name: string; teamId: number; strength: number }
export function topClubs(worldId: number, n: number): ClubEntry[] {
  const leagueIds = worldLeagues(worldId).map(l => l.id);
  if (!leagueIds.length) return [];
  const ph = leagueIds.map(() => '?').join(',');
  const teams = db.prepare(`SELECT id, name FROM teams WHERE league_id IN (${ph})`).all(...leagueIds) as { id: number; name: string }[];
  const scored: ClubEntry[] = [];
  for (const t of teams) { const x = clubXI(worldId, t.id); if (x) scored.push({ name: t.name, teamId: t.id, strength: x.strength }); }
  scored.sort((a, b) => b.strength - a.strength);
  const seen = new Set<string>(); const out: ClubEntry[] = [];   // key by name → dedupe so bracket keys stay unique
  for (const c of scored) { if (seen.has(c.name)) continue; seen.add(c.name); out.push(c); if (out.length >= n) break; }
  return out;
}

export interface HeldTournament { name: string; kind: string; confed: string | null; champion: string; teams: number }
// Run this season's internationals for a world (idempotent-ish: skip if already held this world+season).
// World Cup on season%4===0; otherwise the continental cups (one per confederation with >=4 fieldable).
export async function runInternationalTournaments(worldId: number, season: number): Promise<HeldTournament[]> {
  // A tournament row is committed BEFORE its knockout runs, so a crash / missing engine /
  // swallowed error used to leave champion NULL and the bare existence guard then blocked every
  // retry — the tournament showed "in progress" forever. Sweep unfinished wreckage first; the
  // guard below only respects COMPLETED seasons.
  const wreck = db.prepare('SELECT id FROM tournaments WHERE world_id = ? AND season = ? AND champion IS NULL').all(worldId, season) as { id: number }[];
  for (const t of wreck) {
    db.prepare('DELETE FROM tournament_ties WHERE tournament_id = ?').run(t.id);
    db.prepare('DELETE FROM tournaments WHERE id = ?').run(t.id);
  }
  if ((db.prepare('SELECT 1 FROM tournaments WHERE world_id = ? AND season = ? LIMIT 1').get(worldId, season))) return [];
  const fieldable = fieldableNations(worldId).sort((a, b) => b.strength - a.strength);
  const baseSeed = ((worldId * 7919 + season * 104729) >>> 0) || 1;
  const held: HeldTournament[] = [];
  const natSquad: SquadResolver = k => selectNationalSquad(worldId, k);
  if (season % 4 === 0) {
    if (fieldable.length < 4) return held;
    const size = Math.min(16, largestPow2(fieldable.length));
    const nats = seedBracket(fieldable.slice(0, size).map(f => f.key), baseSeed);
    const id = createTournament(worldId, season, 'world_cup', null, 'World Cup');
    const champ = await runKnockout(id, nats, baseSeed, natSquad, nationName, 'nat');
    db.prepare('UPDATE tournaments SET champion = ? WHERE id = ?').run(champ, id);
    held.push({ name: 'World Cup', kind: 'world_cup', confed: null, champion: champ, teams: size });
  } else if (season % 4 === 2) {
    // Club World Cup — the world's best clubs. Falls back to nothing if <4 clubs can field an XI.
    const clubs = topClubs(worldId, 16);
    if (clubs.length >= 4) {
      const size = largestPow2(clubs.length);
      const byName = new Map(clubs.map(c => [c.name, c.teamId]));
      const keys = seedBracket(clubs.slice(0, size).map(c => c.name), (baseSeed ^ 0x0c1b) >>> 0);
      const id = createTournament(worldId, season, 'club_world_cup', null, 'Club World Cup');
      const champ = await runKnockout(id, keys, (baseSeed ^ 0xc1ab) >>> 0, name => clubXI(worldId, byName.get(name)!)?.xi ?? null, name => name, 'club');
      db.prepare('UPDATE tournaments SET champion = ? WHERE id = ?').run(champ, id);
      held.push({ name: 'Club World Cup', kind: 'club_world_cup', confed: null, champion: champ, teams: size });
    }
  } else {
    for (const [confed] of NATIONS_BY_CONFED) {
      const f = fieldable.filter(x => x.confed === confed);
      if (f.length < 4) continue;
      const size = Math.min(8, largestPow2(f.length));
      // Hash the WHOLE confed name: charCodeAt collided (CONMEBOL/CONCACAF share 'O',
      // AFC/OFC share 'F', three confeds start with 'C'), giving different tournaments
      // identical engine + shootout RNG streams in the same season.
      const confedHash = [...confed].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 17);
      const nats = seedBracket(f.slice(0, size).map(x => x.key), (baseSeed ^ confedHash) >>> 0);
      const name = CONFED_TOURNAMENT[confed];
      const id = createTournament(worldId, season, 'continental', confed, name);
      const champ = await runKnockout(id, nats, ((baseSeed ^ Math.imul(confedHash, 2654435761)) >>> 0) || 1, natSquad, nationName, 'nat');
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
