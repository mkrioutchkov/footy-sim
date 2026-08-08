// The --summary path: run a written spec through the engine (or the fast-sim model) and read back
// the score + one stats line per man. This is the AUTHORITATIVE result — the frame recording is
// only ever a replay artifact — so the aftermath (ratings, news, morale, leaderboards) rates off it.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fastSimEnabled, fastSimSummary, type MatchSpec } from '../fastsim.ts';
import { ENGINE } from './runtime.ts';

// The per-player line from a --summary run — the cheap STATS the aftermath rates off (the same fields
// analyzeRecording reads from the final frame), so ratings/news/morale never need the frame recording.
export interface SummaryPlayer { id: number; name: string; role: string; team: 'home' | 'away'; goals: number; assists: number; shots: number; tackles: number; passes: number; passesCompleted: number; yellow: number; sentOff: boolean }
// `players` is ONE ROW PER MAN WHO PLAYED, not per pitch slot — see withSubstitutionStints. Rows
// 0..21 are still the 22 FINAL slot holders in engine-id order (so anything indexing or `find`-ing
// by slot id gets exactly what it got before), and every row after them is a man who was
// substituted OFF, rebuilt from the engine's substitutionLog. `finalPlayers` keeps the old 22-slot
// view explicitly for a consumer that genuinely wants the shirts rather than the men; it is ABSENT
// on the fast-sim path (fastsim.ts never substitutes, so there `players` IS the final-slot view).
export interface SummaryResult { homeScore: number; awayScore: number; players: SummaryPlayer[]; finalPlayers?: SummaryPlayer[] }
const numF = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// Fold the engine's `substitutionLog` into the --summary player list: a row per MAN, not per slot.
//
// A substitution is an IN-PLACE slot swap (engine_squad.cpp substituteSlot): the slot keeps its id
// and role, is renamed to the arrival in the same tick, and `pStats[slot.id]` is ZEROED — the
// departing man's line survives only in the frame-/summary-borne substitutionLog (engine.cpp
// getJSON, the `out*` fields). --summary reports the FINAL 22 slots, so before this every man who
// came off was simply absent from the aftermath: measured on a real fixture (seed 19960, 7-3, 5
// substitutions, 27 men) the leaderboard tallied 9 of the 10 goals (a departed man's goal lost),
// the human club logged 9 season_apps for 13 men, the AI club 8 for 14. Note the arrivals are
// engine-invented bench names ("H8 Maldini", engine_squad.cpp:283) that resolve to no DB player, so
// their rows drop downstream on the name lookup — the men this restores are the real starters.
//
// The departed row keeps the SLOT id (same shirt, two men — matching report.ts's stint rows) and
// sits after all 22 final holders, so `players[i]`/`find(p => p.id === slot)` still resolve to the
// slot's final holder exactly as before.
//
// yellow/sentOff: `yellow` comes from the engine's `outYellowCards`, added to SubstitutionRecord
// for exactly this reason — the slot's card count is runtime state that resetSlotRuntime wipes at
// the swap, so before that field existed a booked departed man lost the -0.3 card dent on his
// rating. Older recordings predate it and degrade to 0, which is the pre-fix behaviour rather than
// a crash. `sentOff` is exact rather than assumed: pickSubstitutions skips `p.sentOff`
// (engine_squad.cpp:354), so a sent-off man is never substituted.
export function withSubstitutionStints(finalPlayers: SummaryPlayer[], substitutionLog: unknown): SummaryPlayer[] {
  if (!Array.isArray(substitutionLog) || substitutionLog.length === 0) return finalPlayers;
  const roleOfSlot = new Map(finalPlayers.map(p => [p.id, p.role] as const));   // the role stays with the slot
  const out = finalPlayers.slice();
  for (const rec of substitutionLog as Record<string, unknown>[]) {
    if (!rec || typeof rec !== 'object') { continue; }
    const slotId = rec.slotId;
    const name = typeof rec.outName === 'string' ? rec.outName : '';
    // A record with no slot or no departing name identifies nobody — skip it rather than invent a
    // row keyed to slot 0 (numF would turn a missing slotId into a real player's id).
    if (typeof slotId !== 'number' || !Number.isInteger(slotId) || slotId < 0 || !name) { continue; }
    out.push({
      id: slotId, name, role: roleOfSlot.get(slotId) ?? '',
      team: rec.team === 'away' ? 'away' : 'home',
      goals: numF(rec.outGoals), assists: numF(rec.outAssists), shots: numF(rec.outShots), tackles: numF(rec.outTackles),
      passes: numF(rec.outPasses), passesCompleted: numF(rec.outPassesCompleted),
      yellow: numF(rec.outYellowCards), sentOff: false,
    });
  }
  return out;
}

// Run a written spec through the engine (--summary, deterministic via its seed) and return the score +
// the per-player stats. Async (spawn) so a ~1-2s sim never blocks the event loop. Shared by league
// fixtures + cup ties so they sim identically.
export function runEngineSummary(specPath: string): Promise<SummaryResult> {
  // Fast-resolve tier: skip the engine spawn entirely and resolve the spec via the deterministic
  // statistical model. Same seed+spec ⇒ same result, so a headless/bulk run stays reproducible while
  // a match costs microseconds not seconds. Watched/human matches use the full engine (this path is
  // --summary only). See fastsim.ts + FOOTY_FAST_SIM.
  if (fastSimEnabled()) {
    try {
      const spec = JSON.parse(readFileSync(specPath, 'utf8')) as MatchSpec;
      return Promise.resolve(fastSimSummary(spec));
    } catch (e) { return Promise.reject(new Error(`fast-sim spec read failed: ${String(e)}`)); }
  }
  return new Promise((resolve, reject) => {
    const child = spawn(ENGINE, ['--match', specPath, '--summary', '--no-debug'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { err += d.toString(); });
    const to = setTimeout(() => { child.kill(); reject(new Error('engine timeout')); }, 120000);
    child.on('error', e => { clearTimeout(to); reject(e); });
    child.on('close', () => {
      clearTimeout(to);
      try {
        const lines = out.split(/\r?\n/).filter(l => l.trim().startsWith('{'));
        const summary = JSON.parse(lines[lines.length - 1]) as { homeScore?: number; awayScore?: number; players?: Record<string, unknown>[]; substitutionLog?: unknown };
        const finalPlayers: SummaryPlayer[] = (summary.players ?? []).map(p => ({
          id: numF(p.id), name: String(p.name ?? ''), role: String(p.role ?? ''),
          team: p.team === 'away' ? 'away' : 'home',
          goals: numF(p.goals), assists: numF(p.assists), shots: numF(p.shots), tackles: numF(p.tackles),
          passes: numF(p.passes), passesCompleted: numF(p.passesCompleted),
          yellow: numF(p.yellow), sentOff: !!p.sentOff,
        }));
        // The 22 final slots are only the men STILL on the pitch — fold the substitutionLog in so the
        // aftermath rates every man who played (a pre-substitutionLog engine emits none and degrades
        // to the old 22-row behaviour).
        const players = withSubstitutionStints(finalPlayers, summary.substitutionLog);
        resolve({ homeScore: summary.homeScore ?? 0, awayScore: summary.awayScore ?? 0, players, finalPlayers });
      } catch (e) { reject(new Error(`engine parse failed: ${err || String(e)}`)); }
    });
  });
}
