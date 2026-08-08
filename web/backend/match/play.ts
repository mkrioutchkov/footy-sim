// Playing a match end to end: write the spec, run --summary for the authoritative result, persist
// it, and (best-effort, off the critical path) queue the replay recording. League fixtures, cup
// ties and national-team friendlies all funnel through here so they sim identically.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { db } from '../db.ts';
import { DEFAULT_TACTICS } from '../game.ts';
import { consumeTeamTalk } from '../teamtalk.ts';
import { tallyFixtureStats } from '../leaders.ts';
import { simulatePenaltyShootout, type ShootoutPlayer } from '../shootout.ts';
import { MINUTES, SPEC_DIR } from './runtime.ts';
import { weatherForSeed } from './weather.ts';
import { getFixture, writeSpec, buildTieSpec } from './spec.ts';
import { type SummaryPlayer, type SummaryResult, runEngineSummary } from './summary.ts';
import { hasHumanStake } from './recordings.ts';
import { enqueueRecording } from './capture.ts';

export interface PlayResult { fixtureId: number; homeScore: number; awayScore: number; alreadyPlayed: boolean; players?: SummaryPlayer[]; }

// Run a fixture through the engine (deterministic via the stored seed) and
// persist the score. Idempotent: a played fixture returns its stored result.
// ASYNC (spawn, not spawnSync) so a ~1-2s (slower under load) match sim never
// blocks the Node event loop — that froze the watch socket and serialised a
// whole matchday. A round's fixtures can now sim concurrently (Promise.all).
export function playFixture(fixtureId: number): Promise<PlayResult> {
  const fx = getFixture(fixtureId);
  if (!fx) return Promise.reject(new Error('fixture not found'));
  if (fx.played) {
    return Promise.resolve({ fixtureId, homeScore: fx.home_score ?? 0, awayScore: fx.away_score ?? 0, alreadyPlayed: true });
  }
  const specPath = writeSpec(fx);
  // --summary is the AUTHORITATIVE, fast result + the per-player stats the aftermath rates off (same seed
  // ⇒ same score as a full-frame run). The frame recording is now PURELY OPT-IN for replay (recordReplay,
  // fired AFTER the matchday's summaries so it never competes with them) — if it times out or crashes the
  // season is untouched. The event/stats-vs-frames split: ratings/news/morale derive from the cheap stats.
  return runEngineSummary(specPath).then(({ homeScore, awayScore, players }) => {
    db.prepare('UPDATE fixtures SET played = 1, home_score = ?, away_score = ? WHERE id = ?').run(homeScore, awayScore, fixtureId);
    consumeTeamTalk(fixtureId);   // §2.13: a pre-match talk is a one-off — spent once the match is played
    tallyFixtureStats(fixtureId, players);   // §stat-leaders: both clubs' goals/assists → the division leaderboard (once)
    return { fixtureId, homeScore, awayScore, alreadyPlayed: false, players };
  });
}

// Best-effort full-frame REPLAY recording for a just-played fixture — fired by the advance handler AFTER
// the matchday's summaries resolve, so the slow full-frame run never competes with the (fast, result-
// bearing) summaries that gate the advance. Capped at one in flight + skips an existing recording, so it
// can't pile up on a slow host. Failure is silent: the result + aftermath already came from --summary.
export function recordReplay(fixtureId: number): void {
  const fx = getFixture(fixtureId);
  if (!fx) return;
  // Default: only human-stake matches are recorded (your games — faithful + bounded ~38/season). The
  // FOOTY_RECORD_ALL knob records any fixture passed here too (for "watch any game" testing; off by
  // default so the default disk footprint + behaviour are unchanged).
  if (process.env.FOOTY_RECORD_ALL !== '1' && !hasHumanStake(fx.home_team_id, fx.away_team_id)) return;
  enqueueRecording('fixture', fixtureId, writeSpec(fx));
}

export interface CupTieResult { tieId: number; homeScore: number; awayScore: number; homePens: number | null; awayPens: number | null; alreadyPlayed: boolean }

// Play a cup tie through the engine and persist its score. Idempotent.
export function playCupTie(tieId: number): Promise<CupTieResult> {
  const t = db.prepare('SELECT home_team_id, away_team_id, seed, played, home_score, away_score, home_pens, away_pens FROM cup_ties WHERE id = ?')
    .get(tieId) as { home_team_id: number | null; away_team_id: number | null; seed: number; played: number; home_score: number | null; away_score: number | null; home_pens: number | null; away_pens: number | null } | undefined;
  if (!t || t.home_team_id == null || t.away_team_id == null) return Promise.reject(new Error('cup tie not ready'));
  if (t.played) return Promise.resolve({ tieId, homeScore: t.home_score ?? 0, awayScore: t.away_score ?? 0, homePens: t.home_pens, awayPens: t.away_pens, alreadyPlayed: true });
  const file = path.join(SPEC_DIR, `cup-${tieId}.json`);
  const spec = buildTieSpec(t.home_team_id, t.away_team_id, t.seed);
  writeFileSync(file, JSON.stringify(spec));
  // Use the exact emitted XIs (custom formation + injury cover included), not a later DB squad snapshot.
  const homePlayers = ((spec.home as { players?: ShootoutPlayer[] }).players ?? []);
  const awayPlayers = ((spec.away as { players?: ShootoutPlayer[] }).players ?? []);
  const human = hasHumanStake(t.home_team_id, t.away_team_id);
  // Same split as the league: --summary is the authoritative result; a human tie ALSO fires a best-effort,
  // capped, non-blocking replay recording (a timeout/crash leaves the result + bracket untouched).
  return runEngineSummary(file).then(({ homeScore, awayScore }) => {
    const pens = homeScore === awayScore ? simulatePenaltyShootout(t.seed, homePlayers, awayPlayers) : null;
    db.prepare('UPDATE cup_ties SET played = 1, home_score = ?, away_score = ?, home_pens = ?, away_pens = ? WHERE id = ?')
      .run(homeScore, awayScore, pens?.home ?? null, pens?.away ?? null, tieId);
    if (human || process.env.FOOTY_RECORD_ALL === '1') enqueueRecording('cup', tieId, file);
    return { tieId, homeScore, awayScore, homePens: pens?.home ?? null, awayPens: pens?.away ?? null, alreadyPlayed: false };
  });
}

// §national-teams: play a match between two arbitrary player lists (a national XI) with NO teams/players
// rows — the engine only reads the spec JSON. Same neutral-base spec as a default-shape AI-vs-AI club tie
// (name + tactics + 11 players by attrs), so it needs zero engine change. Players must be pre-ordered to
// the default formation's slots (GK first). Returns the full summary (scores + per-player stats).
export interface VirtualPlayer { name: string; role: string; attrs: Record<string, number>; personality?: unknown; foot?: number }
export function playVirtualTie(seed: number, homeName: string, homePlayers: VirtualPlayer[], awayName: string, awayPlayers: VirtualPlayer[], tag = 'nat'): Promise<SummaryResult> {
  const side = (name: string, players: VirtualPlayer[]) => ({ name, tactics: DEFAULT_TACTICS, players: players.slice(0, 11).map(p => ({ name: p.name, attrs: p.attrs, foot: p.foot ?? 1, personality: p.personality ?? null })) });
  const spec: Record<string, unknown> = { seed, minutes: MINUTES, home: side(homeName, homePlayers), away: side(awayName, awayPlayers) };
  const weather = weatherForSeed(seed);
  if (weather !== 'clear') spec.weather = weather;
  const file = path.join(SPEC_DIR, `${tag}-${seed}.json`);
  writeFileSync(file, JSON.stringify(spec));
  return runEngineSummary(file);
}
