// Pre-match opponent scouting report — reads existing league data (no engine run): the
// opponent's table position + recent form, a plain-English read of how they play (derived
// from their tactical dials), and their danger men. Built for an UPCOMING fixture the user
// is in. Frontend: #/scout/:fixtureId.
import { db } from './db.ts';
import { getTeamWithPlayers, standings } from './game.ts';
import type { Tactics } from './game.ts';

export interface ScoutPlayer { name: string; role: string; age: number; overall: number; potential: number | null; danger: boolean; }
export interface ScoutForm { round: number; opponent: string; venue: 'H' | 'A'; gf: number; ga: number; result: 'W' | 'D' | 'L'; }
export interface ScoutReport {
  opponent: {
    teamId: number; name: string; manager: string; formation: string; position: number | null;
    played: number; won: number; drawn: number; lost: number; gf: number; ga: number; gd: number; points: number;
  };
  venue: 'home' | 'away';   // where the USER plays this fixture
  round: number;
  approach: string[];       // plain-English read of how the opponent plays
  form: ScoutForm[];        // their last up-to-5 league results, most recent first
  keyPlayers: ScoutPlayer[];
}

const SKILL_KEYS = ['speed', 'passing', 'creativity', 'shooting', 'tackling', 'positioning', 'stamina'];
function ovr(attrs: Record<string, number>): number {
  return Math.round(SKILL_KEYS.reduce((s, k) => s + (attrs[k] ?? 0), 0) / SKILL_KEYS.length);
}

// Translate the opponent's dials into a few scouting phrases. Derived from dials (not their
// plan text) so a future human opponent's private team-talk is never leaked, and AI sides —
// whose dials carry their style — read truthfully.
function describeApproach(t: Tactics): string[] {
  const out: string[] = [];
  if (t.aggression >= 65) out.push('Press high and hunt the ball back');
  else if (t.aggression <= 35) out.push('Sit off and stay compact');
  if (t.defensiveLineHeight >= 65) out.push('High defensive line — exploitable in behind');
  else if (t.defensiveLineHeight <= 35) out.push('Defend deep in a low block');
  if (t.passingDirectness >= 65) out.push('Direct — long and early');
  else if (t.passingDirectness <= 35) out.push('Patient, build from the back');
  if (t.overlapFrequency >= 65) out.push('Attack through overlapping full-backs');
  if (t.midfieldFreedom >= 65) out.push('Fluid, roaming midfield');
  else if (t.midfieldFreedom <= 35) out.push('Rigid, disciplined shape');
  if (!out.length) out.push('Balanced — no obvious tactical bias');
  return out;
}

export function buildScoutReport(fixtureId: number, userTeamId: number): ScoutReport | null {
  const fx = db.prepare('SELECT id, league_id, home_team_id, away_team_id, round FROM fixtures WHERE id = ?')
    .get(fixtureId) as { id: number; league_id: number; home_team_id: number; away_team_id: number; round: number } | undefined;
  if (!fx) return null;
  const userTeam = getTeamWithPlayers(userTeamId);
  if (!userTeam || fx.league_id !== userTeam.leagueId) return null;   // not in the user's league
  const oppId = fx.home_team_id === userTeamId ? fx.away_team_id
    : fx.away_team_id === userTeamId ? fx.home_team_id : null;
  if (oppId == null) return null;   // the fixture doesn't involve the user
  const opp = getTeamWithPlayers(oppId);
  if (!opp) return null;

  const table = standings(fx.league_id);
  const idx = table.findIndex(s => s.teamId === oppId);
  const row = idx >= 0 ? table[idx] : null;

  // recent form — the opponent's last up-to-5 played league fixtures, most recent first
  const recent = db.prepare(
    'SELECT round, home_team_id, away_team_id, home_score, away_score FROM fixtures WHERE league_id = ? AND played = 1 AND (home_team_id = ? OR away_team_id = ?) ORDER BY round DESC LIMIT 5',
  ).all(fx.league_id, oppId, oppId) as { round: number; home_team_id: number; away_team_id: number; home_score: number; away_score: number }[];
  const nameOf = (id: number) => (db.prepare('SELECT name FROM teams WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? '?';
  const form: ScoutForm[] = recent.map(f => {
    const home = f.home_team_id === oppId;
    const gf = home ? f.home_score : f.away_score;
    const ga = home ? f.away_score : f.home_score;
    return { round: f.round, opponent: nameOf(home ? f.away_team_id : f.home_team_id), venue: home ? 'H' : 'A', gf, ga, result: gf > ga ? 'W' : gf < ga ? 'L' : 'D' };
  });

  // key players — their fielded XI (custom lineup or first 11), top 5 by OVR. Among those five,
  // flag the highest-OVR attacker (or the top-rated player if none) as the danger man — chosen
  // from within the shown list so exactly one of the displayed players is ever flagged.
  const xi = opp.lineup ? opp.lineup.map(i => opp.players[i]).filter(Boolean) : opp.players.slice(0, 11);
  const keyPlayers = xi
    .map(p => ({ name: p.name, role: p.role, age: p.age, overall: ovr(p.attrs), potential: p.potential, danger: false }))
    .sort((a, b) => b.overall - a.overall)
    .slice(0, 5);
  if (keyPlayers.length) {
    const attIdx = keyPlayers.findIndex(p => p.role === 'CF' || p.role === 'WM');
    keyPlayers[attIdx >= 0 ? attIdx : 0].danger = true;
  }

  return {
    opponent: {
      teamId: oppId, name: opp.name, manager: opp.manager, formation: opp.formation,
      position: idx >= 0 ? idx + 1 : null,
      played: row?.played ?? 0, won: row?.won ?? 0, drawn: row?.drawn ?? 0, lost: row?.lost ?? 0,
      gf: row?.gf ?? 0, ga: row?.ga ?? 0, gd: row?.gd ?? 0, points: row?.points ?? 0,
    },
    venue: fx.home_team_id === userTeamId ? 'home' : 'away',
    round: fx.round,
    approach: describeApproach(opp.tactics),
    form,
    keyPlayers,
  };
}
