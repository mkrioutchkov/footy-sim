// Manager career record — the manager's CV, aggregated from season_history across ALL the clubs the
// user has managed (a sacked manager starts a fresh team, §2.5, so a career can span clubs). One row
// per club per completed season is archived at rollover; this rolls them up into a career summary +
// per-club spells. Read-only; powers the manager-career screen.
import { db } from './db.ts';

export interface ManagerSpell { team: string; seasons: number; from: number; to: number; titles: number; promotions: number; relegations: number; }
export interface ManagerCareer {
  clubs: number; seasons: number;
  played: number; won: number; drawn: number; lost: number; gf: number; ga: number; points: number;
  winPct: number;                 // 0..100
  titles: number; promotions: number; relegations: number; cups: number;
  objectivesMet: number; objectivesSet: number;
  bestFinish: { position: number; division: string; season: number } | null;
  spells: ManagerSpell[];         // one per club managed, most recent first
}

interface HistRow {
  team_id: number; season: number; division: string; position: number;
  played: number; won: number; drawn: number; lost: number; gf: number; ga: number; points: number;
  champion: number; promoted: number; relegated: number; cup_won: number;
  objective_kind: string | null; objective_met: number | null;
}

const EMPTY: ManagerCareer = {
  clubs: 0, seasons: 0, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, points: 0, winPct: 0,
  titles: 0, promotions: 0, relegations: 0, cups: 0, objectivesMet: 0, objectivesSet: 0, bestFinish: null, spells: [],
};

export function getManagerCareer(userId: number): ManagerCareer {
  const teams = db.prepare('SELECT id, name FROM teams WHERE user_id = ?').all(userId) as unknown as { id: number; name: string }[];
  if (!teams.length) return { ...EMPTY };
  const ids = teams.map(t => t.id);
  const nameById = new Map(teams.map(t => [t.id, t.name]));
  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT team_id, season, division, position, played, won, drawn, lost, gf, ga, points, champion, promoted, relegated, cup_won, objective_kind, objective_met FROM season_history WHERE team_id IN (${ph}) ORDER BY season`).all(...ids) as unknown as HistRow[];

  const c: ManagerCareer = { ...EMPTY, spells: [] };
  let best: ManagerCareer['bestFinish'] = null;
  const spells = new Map<number, ManagerSpell>();
  for (const r of rows) {
    c.seasons++; c.played += r.played; c.won += r.won; c.drawn += r.drawn; c.lost += r.lost;
    c.gf += r.gf; c.ga += r.ga; c.points += r.points;
    c.titles += r.champion; c.promotions += r.promoted; c.relegations += r.relegated; c.cups += r.cup_won;
    if (r.objective_kind != null) { c.objectivesSet++; if (r.objective_met === 1) c.objectivesMet++; }
    if (!best || r.position < best.position) best = { position: r.position, division: r.division, season: r.season };
    const sp = spells.get(r.team_id) ?? { team: nameById.get(r.team_id) ?? '—', seasons: 0, from: r.season, to: r.season, titles: 0, promotions: 0, relegations: 0 };
    sp.seasons++; sp.from = Math.min(sp.from, r.season); sp.to = Math.max(sp.to, r.season);
    sp.titles += r.champion; sp.promotions += r.promoted; sp.relegations += r.relegated;
    spells.set(r.team_id, sp);
  }
  c.clubs = spells.size;
  c.winPct = c.played ? Math.round((c.won / c.played) * 100) : 0;
  c.bestFinish = best;
  c.spells = [...spells.values()].sort((a, b) => b.to - a.to);   // most recent club first
  return c;
}
