// market/window.ts — WHEN club-to-club business is allowed. Every deal path (bids, loans, the AI
// tick's step 2) gates on this one derivation, and §2.4 listings expire against its deadline.
import { db } from '../db.ts';

// Transfer windows: club-to-club deals are allowed only when a window is open — the pre-season
// "summer" window (before the opening matchday) and a mid-season "winter" window. Free agents
// (unattached) can be signed any time. Derived from the league's fixture rounds, so it needs no
// new state and lines up with the matchday the user is about to play.
export interface TransferWindow { open: boolean; window: 'summer' | 'winter' | null; current: number; total: number; label: string; deadline: number | null; closesIn: number; deadlineDay: boolean }
export function transferWindow(leagueId: number): TransferWindow {
  const total = (db.prepare('SELECT COALESCE(MAX(round), 0) AS r FROM fixtures WHERE league_id = ?').get(leagueId) as { r: number }).r;
  const unplayed = (db.prepare('SELECT MIN(round) AS r FROM fixtures WHERE league_id = ? AND played = 0').get(leagueId) as { r: number | null }).r;
  const current = unplayed ?? total + 1;                 // season complete -> just past the end
  const mid = Math.max(2, Math.floor(total / 2));
  let window: 'summer' | 'winter' | null = null;
  if (current <= 1) window = 'summer';
  else if (current <= total && (current === mid || current === mid + 1)) window = 'winter';   // not after the season ends
  const open = window != null;
  // The last matchday the window stays open (summer = matchday 1; winter = mid+1). closesIn counts the
  // matchdays left including this one; deadlineDay = it's the final chance before the window shuts.
  const deadline = window === 'summer' ? 1 : window === 'winter' ? Math.min(total, mid + 1) : null;   // clamp: a degenerate 2-round season has mid+1 > total
  const closesIn = open && deadline != null ? Math.max(1, deadline - current + 1) : 0;
  const deadlineDay = open && deadline != null && current >= deadline;
  const label = open
    ? `${window === 'summer' ? 'Summer' : 'Winter'} window open`
    : current < mid ? `Window shut — reopens matchday ${mid} (winter)`
      : 'Window shut — reopens pre-season';
  return { open, window, current, total, label, deadline, closesIn, deadlineDay };
}
