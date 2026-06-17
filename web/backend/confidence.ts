// Board confidence / job security. A 0..100 measure of how the board rates the manager: it drifts
// a little with each result and swings at season rollover on the objective verdict + final finish +
// promotion/relegation. Persisted on teams.board_confidence (see db.ts). No sacking yet — the
// number + status set up that consequence; for now it's the stakes/narrative layer.
import { db } from './db.ts';

export type ConfidenceStatus = 'secure' | 'stable' | 'shaky' | 'at_risk';

export function confidenceStatus(c: number): ConfidenceStatus {
  if (c >= 75) return 'secure';
  if (c >= 50) return 'stable';
  if (c >= 28) return 'shaky';
  return 'at_risk';
}

export function getConfidence(teamId: number): { value: number; status: ConfidenceStatus } | null {
  const r = db.prepare('SELECT board_confidence FROM teams WHERE id = ?').get(teamId) as { board_confidence: number | null } | undefined;
  if (!r || r.board_confidence == null) return null;
  return { value: r.board_confidence, status: confidenceStatus(r.board_confidence) };
}

function applyDelta(teamId: number, delta: number): void {
  db.prepare('UPDATE teams SET board_confidence = MAX(0, MIN(100, board_confidence + ?)) WHERE id = ?').run(delta, teamId);
}

// Small per-match drift; the big moves come at rollover.
export function nudgeConfidence(teamId: number, outcome: 'W' | 'D' | 'L'): void {
  applyDelta(teamId, outcome === 'W' ? 2 : outcome === 'L' ? -2 : 0);
}

// The season verdict — the major swings. Relegation/promotion dominate; the board objective verdict
// and a top-/bottom-third finish layer on. Returns the resulting (clamped) confidence.
export function settleConfidenceAtRollover(opts: {
  teamId: number; finalPosition: number; size: number;
  promoted: boolean; relegated: boolean; objectiveMet: boolean | null;
}): number {
  let delta = 0;
  if (opts.relegated) delta -= 30;
  if (opts.promoted) delta += 22;
  if (opts.objectiveMet === true) delta += 14;
  else if (opts.objectiveMet === false) delta -= 16;
  const third = Math.max(1, Math.round(opts.size / 3));
  if (opts.finalPosition <= third) delta += 6;                                   // strong finish
  else if (opts.finalPosition > opts.size - third && !opts.relegated) delta -= 6; // poor finish (relegation already counted)
  applyDelta(opts.teamId, delta);
  return (db.prepare('SELECT board_confidence FROM teams WHERE id = ?').get(opts.teamId) as { board_confidence: number }).board_confidence;
}

export type BoardTone = 'backed' | 'satisfied' | 'concerned' | 'warned' | 'final_warning';

// The board's verdict on the manager at rollover, escalating if confidence stays at-risk across
// seasons. Tracks the consecutive at-risk streak on the team. Call AFTER settleConfidenceAtRollover.
export function boardVerdictAtRollover(teamId: number, confidence: number, objectiveMet: boolean | null): { tone: BoardTone; message: string } {
  const status = confidenceStatus(confidence);
  let streak = (db.prepare('SELECT low_confidence_streak AS s FROM teams WHERE id = ?').get(teamId) as { s: number }).s;
  streak = status === 'at_risk' ? streak + 1 : 0;
  db.prepare('UPDATE teams SET low_confidence_streak = ? WHERE id = ?').run(streak, teamId);
  if (status === 'at_risk') return streak >= 2
    ? { tone: 'final_warning', message: 'The board has run out of patience — another season like this and your time is up.' }
    : { tone: 'warned', message: 'The board is deeply unhappy. You are under serious pressure to turn results around.' };
  if (status === 'secure') return { tone: 'backed', message: objectiveMet === false ? 'The board keeps full faith in you despite the missed target.' : 'The board is delighted — your standing has never been higher.' };
  if (status === 'stable') return { tone: 'satisfied', message: objectiveMet === true ? 'The board is satisfied — objective met. Keep it going.' : 'The board remains supportive.' };
  return { tone: 'concerned', message: 'The board expects a clear improvement next season.' };
}
