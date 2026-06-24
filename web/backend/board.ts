// Board interaction (board meetings). The manager gets one audience with the board per season to ask
// for backing — transfer funds or wage room — and the board's generosity scales with its CONFIDENCE in
// him. This is the payoff side of the board-confidence loop the press conferences feed: win games + face
// the media well → confidence up → the board opens the chequebook; lose faith → it stays shut. A secure
// board backs your vision; an at-risk one tells you to fix results first.
import { db } from './db.ts';
import { getConfidence, type ConfidenceStatus } from './confidence.ts';

export type BoardRequestKind = 'funds' | 'wages';

// Per-status grant (£). secure is generous; at-risk gets nothing — the board won't reward a failing run.
const GRANT: Record<ConfidenceStatus, Record<BoardRequestKind, number>> = {
  secure:  { funds: 20_000_000, wages: 8_000_000 },
  stable:  { funds: 10_000_000, wages: 4_000_000 },
  shaky:   { funds: 3_000_000,  wages: 1_000_000 },
  at_risk: { funds: 0,          wages: 0 },
};

function currentSeason(teamId: number): number {
  const r = db.prepare('SELECT l.season FROM leagues l JOIN teams t ON t.league_id = l.id WHERE t.id = ?').get(teamId) as { season: number } | undefined;
  return r?.season ?? 1;
}

export function boardMeetingAvailable(teamId: number): boolean {
  const r = db.prepare('SELECT board_request_season FROM teams WHERE id = ?').get(teamId) as { board_request_season: number | null } | undefined;
  if (!r) return false;
  return r.board_request_season == null || r.board_request_season < currentSeason(teamId);
}

export interface BoardMeeting {
  available: boolean;
  confidence: { value: number; status: ConfidenceStatus } | null;
  grants: { funds: number; wages: number };   // what each request would yield at the current confidence
}

// The meeting state the UI shows: whether the audience is open + what the board would grant right now.
export function getBoardMeeting(teamId: number): BoardMeeting {
  const confidence = getConfidence(teamId);
  const grants = confidence ? GRANT[confidence.status] : { funds: 0, wages: 0 };
  return { available: boardMeetingAvailable(teamId), confidence, grants };
}

export interface BoardRequestOutcome {
  ok: boolean; error?: string;
  granted: boolean; kind?: BoardRequestKind; amount?: number; budget?: number; wageBudget?: number; message: string;
}

// Make the request. The once-a-season audience is consumed regardless of outcome (the GET preview shows
// grants:0 when the board won't back you, so the manager isn't blindsided into wasting it).
export function requestBoardBacking(teamId: number, kind: BoardRequestKind): BoardRequestOutcome {
  if (kind !== 'funds' && kind !== 'wages') return { ok: false, granted: false, message: 'unknown request' };
  if (!boardMeetingAvailable(teamId)) return { ok: false, granted: false, message: "You've already met the board this season — wait until next season." };
  const conf = getConfidence(teamId);
  if (!conf) return { ok: false, granted: false, message: 'the board has no stance on you yet' };

  db.prepare('UPDATE teams SET board_request_season = ? WHERE id = ?').run(currentSeason(teamId), teamId);
  const amount = GRANT[conf.status][kind];
  if (amount <= 0) {
    return { ok: true, granted: false, kind, amount: 0, message: kind === 'funds'
      ? "The board won't sanction transfer funds while results are this poor — turn it around first."
      : "The board won't raise the wage ceiling given the pressure on your position." };
  }
  const col = kind === 'funds' ? 'budget' : 'wage_budget';
  db.prepare(`UPDATE teams SET ${col} = ${col} + ? WHERE id = ?`).run(amount, teamId);   // col is a fixed internal literal, not user input
  const t = db.prepare('SELECT budget, wage_budget FROM teams WHERE id = ?').get(teamId) as { budget: number; wage_budget: number };
  const m = (amount / 1e6).toFixed(0);
  return { ok: true, granted: true, kind, amount, budget: t.budget, wageBudget: t.wage_budget, message: kind === 'funds'
    ? `The board backs your vision — £${m}M added to your transfer kitty.`
    : `The board raises your wage budget by £${m}M.` };
}
