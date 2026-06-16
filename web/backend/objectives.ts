// Board objectives — the season expectation the board sets a club. Derived from the club's tier
// and how last season went; the current target lives on the team, and at rollover the finished
// season's target + verdict are archived into season_history. Pure of game/season imports (size +
// promote are passed in) so there's no import cycle. See db.ts (teams + season_history columns).
import { db } from './db.ts';

export type ObjectiveKind = 'title' | 'promotion' | 'top_half' | 'survival';
export interface Objective { kind: ObjectiveKind; target: number; label: string; }

export function describeObjective(kind: string): string {
  switch (kind) {
    case 'title': return 'Win the league';
    case 'promotion': return 'Win promotion';
    case 'top_half': return 'Finish in the top half';
    case 'survival': return 'Avoid relegation';
    default: return 'Compete well this season';
  }
}

// Derive the board's expectation for the coming season. size = division size; promote = up/down
// count; prevPosition = last final position (undefined for a brand-new club); justPromoted/
// justRelegated reflect the move that just happened; isTopTier = there's no division above.
export function deriveObjective(opts: {
  tier: number; size: number; promote: number; prevPosition?: number;
  justPromoted?: boolean; justRelegated?: boolean; isTopTier: boolean;
}): Objective {
  const { size, promote, prevPosition, justPromoted, justRelegated, isTopTier } = opts;
  let kind: ObjectiveKind;
  if (justPromoted) kind = 'survival';                       // freshly up — consolidate first
  else if (justRelegated) kind = 'promotion';                // bounce straight back
  else if (isTopTier) {
    if (prevPosition != null && prevPosition <= 2) kind = 'title';
    else if (prevPosition != null && prevPosition >= size - 1) kind = 'survival';
    else kind = 'top_half';
  } else {
    if (prevPosition == null || prevPosition <= promote + 1) kind = 'promotion';   // contended (or new club)
    else if (prevPosition >= size - 1) kind = 'survival';
    else kind = 'top_half';
  }
  const target = kind === 'title' ? 1 : kind === 'promotion' ? promote : kind === 'top_half' ? Math.floor(size / 2) : size - promote;
  return { kind, target, label: describeObjective(kind) };
}

export function objectiveMet(target: number, finalPosition: number): boolean {
  return finalPosition <= target;
}

export function setSeasonObjective(teamId: number, season: number, obj: Objective): void {
  db.prepare('UPDATE teams SET objective_kind = ?, objective_target = ?, objective_season = ? WHERE id = ?')
    .run(obj.kind, obj.target, season, teamId);
}

export function getObjective(teamId: number): { kind: ObjectiveKind; target: number; season: number; label: string } | null {
  const r = db.prepare('SELECT objective_kind, objective_target, objective_season FROM teams WHERE id = ?')
    .get(teamId) as { objective_kind: string | null; objective_target: number | null; objective_season: number | null } | undefined;
  if (!r || !r.objective_kind || r.objective_target == null || r.objective_season == null) return null;
  return { kind: r.objective_kind as ObjectiveKind, target: r.objective_target, season: r.objective_season, label: describeObjective(r.objective_kind) };
}
