// Match reports (LLM stream). After a match, its RECORDING is the source of truth: we scan the
// stored frames for the goal + card timeline (score/card changes between frames) and read the
// final frame's per-player stats for deterministic ratings, then have an LLM write the narrative
// (LLM-primary, same provider as press.ts/tactics.ts, with a deterministic template fallback so
// it never blocks). The result is cached in match_reports (generated once, on first view). No
// engine run — this works purely off a recording, so it's fully testable with synthetic frames.
import { db } from './db.ts';
import { recordingFor, loadRecording, type RecKind, type SummaryPlayer } from './match.ts';
import { chatComplete, llmReady } from './llm.ts';

export interface PlayerRating { id: number; name: string; team: 'home' | 'away'; role: string; rating: number; goals: number; assists: number; shots: number; tackles: number }
// clockMs = the EXACT event clock (the frame where the score/card flipped; evClock for penalty/woodwork).
// The viewer seeks markers/highlights with it — the display `minute` (floor+1) overshoots by up to 60s,
// which made every recorded jump-to-goal land AFTER the goal. Optional: old cached reports lack it.
export interface TimelineEvent { minute: number; team: 'home' | 'away'; name: string; type: 'goal' | 'yellow' | 'red' | 'penalty' | 'woodwork'; clockMs?: number }
export interface MatchFacts {
  homeScore: number; awayScore: number;
  possessionHome: number;              // home possession %
  shots: { home: number; away: number };
  shotsOnTarget: number; saves: number; corners: number;
  timeline: TimelineEvent[];           // goals + cards, in order
  ratings: PlayerRating[];
}
export interface MatchReport { headline: string; body: string; facts: MatchFacts; ratings: PlayerRating[] }

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const minuteOf = (clockMs: unknown): number => Math.max(1, Math.floor(num(clockMs) / 60000) + 1);

// Deterministic player rating from the final-frame stats + team context. Base 6.5, lifted by
// attacking returns (goals/assists/shots) + tackles, a clean-sheet bonus for the back line / GK,
// and dented by a heavy concession (GK), cards, or a sending-off. Clamped to a 1.0–10.0 scale.
function ratePlayer(p: { role: string; goals: number; assists: number; shots: number; tackles: number; passes?: number; passesCompleted?: number; yellow: number; sentOff: boolean }, won: boolean, lost: boolean, conceded: number): number {
  let r = 6.5;
  r += p.goals * 1.2 + p.assists * 0.8 + p.shots * 0.08 + p.tackles * 0.06;
  // Distribution: for a player involved enough in build-up (≥15 passes), reward completion above a
  // league-ish 80% baseline and dent sloppy passing — a deep playmaker's main contribution. Volume-gated
  // so a striker's 4 passes don't swing his rating. Bounded so it never rivals goals/tackles.
  const passes = p.passes ?? 0;
  if (passes >= 15) r += Math.max(-0.5, Math.min(0.7, ((p.passesCompleted ?? 0) / passes - 0.8) * 3));
  const defensive = p.role === 'GK' || p.role === 'CB' || p.role === 'FB';
  if (defensive && conceded === 0) r += 0.8;
  if (p.role === 'GK') r -= conceded * 0.25;
  r += won ? 0.3 : (lost ? -0.3 : 0);
  r -= p.yellow > 0 ? 0.3 : 0;
  r -= p.sentOff ? 2.0 : 0;
  return Math.max(1, Math.min(10, Math.round(r * 10) / 10));
}

export interface RatedPlayer { id: number; name: string; team: 'home' | 'away'; role: string; rating: number; goals: number; sentOff: boolean }
// Ratings straight off a --summary run's per-player stats — the cheap path the aftermath uses instead of
// scanning the frame recording (same ratePlayer model + the same inputs the final frame would carry), so
// ratings/news/morale never depend on a (slow, opt-in) recording.
export function ratePlayers(players: SummaryPlayer[], homeScore: number, awayScore: number): RatedPlayer[] {
  return players.map(p => {
    const won = p.team === 'home' ? homeScore > awayScore : awayScore > homeScore;
    const lost = p.team === 'home' ? homeScore < awayScore : awayScore < homeScore;
    const conceded = p.team === 'home' ? awayScore : homeScore;
    return {
      id: p.id, name: p.name, team: p.team, role: p.role, goals: p.goals, sentOff: p.sentOff,
      rating: ratePlayer({ role: p.role, goals: p.goals, assists: p.assists, shots: p.shots, tackles: p.tackles, passes: p.passes, passesCompleted: p.passesCompleted, yellow: p.yellow, sentOff: p.sentOff }, won, lost, conceded),
    };
  });
}

// Scan a recording's frames into structured match facts: a goal/card timeline + final team /
// per-player stats + ratings. Goals are driven by the SCORE delta (authoritative) so the timeline
// can never disagree with the headline scoreline; the scorer's NAME comes from a same-side goal
// increment that frame, else "Own goal" (score-delta attribution is authoritative regardless of how
// the engine credits per-player goals — the engine no longer credits the conceding player for an
// own goal, but this path stays correct either way). Only goals that coincide with the player's own side scoring count
// toward his ratings, so an own goal isn't rewarded. (Iterates once, holding only running state +
// the last frame — never all frames — so it's safe to stream over a long recording.)
export function analyzeRecording(frames: Iterable<string>): MatchFacts {
  let last: any = null;
  let prevHome = 0, prevAway = 0;
  const prevStat = new Map<number, { goals: number; yellow: number; sentOff: boolean }>();
  const legitGoals = new Map<number, number>();   // goals scored WITH the player's own side scoring
  const timeline: TimelineEvent[] = [];
  const seenEv = new Set<string>();   // dedup a transient event (it lingers ~78 frames) by type:player:evClock-bucket
  for (const line of frames) {
    let f: any; try { f = JSON.parse(line); } catch { continue; }
    if (!Array.isArray(f.players)) continue;
    const minute = minuteOf(f.clockMs);
    const inc: { home: { id: number; name: string }[]; away: { id: number; name: string }[] } = { home: [], away: [] };
    for (const p of f.players) {
      const team: 'home' | 'away' = p.team === 'away' ? 'away' : 'home';
      const name = String(p.name ?? `#${p.id}`);
      const was = prevStat.get(p.id);
      const goals = num(p.goals), yellow = num(p.yellow), sentOff = !!p.sentOff;
      if (was) {
        if (goals > was.goals) inc[team].push({ id: num(p.id), name });
        if (yellow > was.yellow) timeline.push({ minute, team, name, type: 'yellow', clockMs: num(f.clockMs) });
        if (sentOff && !was.sentOff) timeline.push({ minute, team, name, type: 'red', clockMs: num(f.clockMs) });
      }
      prevStat.set(p.id, { goals, yellow, sentOff });
    }
    // Attribute each goal to the side whose score rose; name it from a same-side increment (else
    // "Own goal"), and credit a legit goal only to a player whose side actually scored.
    const credit = (side: 'home' | 'away', n: number) => {
      for (let i = 0; i < n; i++) {
        const scorer = inc[side].shift();
        if (scorer) legitGoals.set(scorer.id, (legitGoals.get(scorer.id) ?? 0) + 1);
        timeline.push({ minute, team: side, name: scorer?.name ?? 'Own goal', type: 'goal', clockMs: num(f.clockMs) });
      }
    };
    credit('home', Math.max(0, num(f.homeScore) - prevHome));
    credit('away', Math.max(0, num(f.awayScore) - prevAway));
    prevHome = num(f.homeScore); prevAway = num(f.awayScore);
    // Notable non-score/card moments for the timeline (a saved/missed penalty, a shot off the woodwork) — the
    // drama a goals-only reel misses. Read from the frame's transient events (kept in the recording, see
    // captureLineStream), deduped by evClock so one event isn't re-added across the ~78 frames it lingers.
    for (const e of (Array.isArray(f.events) ? f.events : [])) {
      if (e.type !== 'penalty' && e.type !== 'woodwork') continue;
      const evClock = num(f.clockMs) - num(e.age);
      const key = `${e.type}:${e.playerId ?? '?'}:${Math.round(evClock / 400)}`;
      if (seenEv.has(key)) continue;
      seenEv.add(key);
      // Guard the lookup: an untouched-ball woodwork has playerId null → num(null) is 0, which would wrongly
      // match the real id-0 player. Only resolve a name/team from a present, non-negative id (else "Woodwork").
      const pl = (e.playerId != null && num(e.playerId) >= 0) ? f.players.find((p: any) => num(p.id) === num(e.playerId)) : undefined;
      const team: 'home' | 'away' = pl ? (pl.team === 'away' ? 'away' : 'home') : 'home';
      timeline.push({ minute: minuteOf(evClock), team, name: pl ? String(pl.name) : (e.type === 'penalty' ? 'Penalty' : 'Woodwork'), type: e.type, clockMs: Math.max(0, evClock) });
    }
    last = f;
  }
  if (!last) return { homeScore: 0, awayScore: 0, possessionHome: 50, shots: { home: 0, away: 0 }, shotsOnTarget: 0, saves: 0, corners: 0, timeline: [], ratings: [] };

  const homeScore = num(last.homeScore), awayScore = num(last.awayScore);
  const players: any[] = Array.isArray(last.players) ? last.players : [];
  const ratings: PlayerRating[] = players.map(p => {
    const team: 'home' | 'away' = p.team === 'away' ? 'away' : 'home';
    const conceded = team === 'home' ? awayScore : homeScore;
    const won = team === 'home' ? homeScore > awayScore : awayScore > homeScore;
    const lost = team === 'home' ? homeScore < awayScore : awayScore < homeScore;
    const goals = legitGoals.get(num(p.id)) ?? 0;   // own goals excluded from the player's credit
    return {
      id: num(p.id), name: String(p.name ?? `#${p.id}`), team, role: String(p.role ?? ''),
      goals, assists: num(p.assists), shots: num(p.shots), tackles: num(p.tackles),
      rating: ratePlayer({ role: String(p.role ?? ''), goals, assists: num(p.assists), shots: num(p.shots), tackles: num(p.tackles), yellow: num(p.yellow), sentOff: !!p.sentOff }, won, lost, conceded),
    };
  });
  return {
    homeScore, awayScore,
    possessionHome: Math.round(num(last.possessionPct, 50)),
    shots: { home: num(last.homeShots), away: num(last.awayShots) },
    shotsOnTarget: num(last.shotsOnTarget), saves: num(last.saves), corners: num(last.cornersAwarded),
    timeline, ratings,
  };
}

const goalsBy = (facts: MatchFacts, team: 'home' | 'away') =>
  facts.timeline.filter(e => e.type === 'goal' && e.team === team).map(e => `${e.name} ${e.minute}'`);

// Deterministic, always-available report (used as the LLM fallback + the LLM's grounding facts).
function templateReport(facts: MatchFacts, homeName: string, awayName: string): { headline: string; body: string } {
  const { homeScore: h, awayScore: a } = facts;
  const result = h > a ? `${homeName} beat ${awayName}` : a > h ? `${awayName} beat ${homeName}` : `${homeName} and ${awayName} drew`;
  const headline = `${homeName} ${h}–${a} ${awayName}`;
  const hg = goalsBy(facts, 'home'), ag = goalsBy(facts, 'away');
  const top = [...facts.ratings].sort((x, y) => y.rating - x.rating)[0];
  const reds = facts.timeline.filter(e => e.type === 'red');
  const parts = [
    `${result} ${h}–${a}.`,
    hg.length ? `${homeName}: ${hg.join(', ')}.` : '',
    ag.length ? `${awayName}: ${ag.join(', ')}.` : '',
    `Possession ${facts.possessionHome}%–${100 - facts.possessionHome}%, shots ${facts.shots.home}–${facts.shots.away}.`,
    top ? `${top.name} was the standout with a ${top.rating.toFixed(1)} rating.` : '',
    reds.length ? `${reds.map(r => `${r.name} was sent off (${r.minute}')`).join('; ')}.` : '',
  ].filter(Boolean);
  return { headline, body: parts.join(' ') };
}

// LLM-primary narrative; the deterministic template is both the fallback and the grounding facts.
// The HEADLINE is always the deterministic facts-derived scoreline (never the LLM's) — the
// recording is the source of truth, and the headline is the only place the score appears in text,
// so it must not be able to contradict the recording. The LLM supplies only the prose body.
async function writeNarrative(facts: MatchFacts, homeName: string, awayName: string): Promise<{ headline: string; body: string }> {
  const fallback = templateReport(facts, homeName, awayName);
  if (!llmReady().ok) return fallback;
  const standouts = [...facts.ratings].sort((x, y) => y.rating - x.rating).slice(0, 4)
    .map(r => `${r.name} (${r.team}, ${r.role}) ${r.rating.toFixed(1)}${r.goals ? `, ${r.goals}g` : ''}${r.assists ? `, ${r.assists}a` : ''}`).join('; ');
  const factText = [
    `${homeName} ${facts.homeScore}-${facts.awayScore} ${awayName}`,
    `Goals — ${homeName}: ${goalsBy(facts, 'home').join(', ') || 'none'}; ${awayName}: ${goalsBy(facts, 'away').join(', ') || 'none'}`,
    `Possession ${facts.possessionHome}% / ${100 - facts.possessionHome}%, shots ${facts.shots.home}/${facts.shots.away} (${facts.shotsOnTarget} on target), ${facts.saves} saves`,
    facts.timeline.some(e => e.type === 'red') ? `Red cards: ${facts.timeline.filter(e => e.type === 'red').map(e => `${e.name} ${e.minute}'`).join(', ')}` : '',
    `Top performers: ${standouts}`,
  ].filter(Boolean).join('\n');
  try {
    const raw = (await chatComplete({
      system: 'You are a football match reporter. From the facts, write a vivid but accurate 2–3 short-paragraph match report. Use ONLY the facts given — do not invent scorers, minutes, or events. Output ONLY JSON: {"body": "..."} — just the report prose.',
      user: factText, temperature: 0.6, maxTokens: 500, timeoutMs: 20000,
    })).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
    if (s >= 0 && e > s) {
      const obj = JSON.parse(raw.slice(s, e + 1)) as { body?: unknown };
      const body = typeof obj.body === 'string' && obj.body.trim() ? obj.body.trim() : fallback.body;
      // Headline is ALWAYS the deterministic scoreline — the LLM only writes the body.
      return { headline: fallback.headline, body };
    }
  } catch { /* unreachable / no-key / bad output — fall through to the template */ }
  return fallback;
}

// Single-flight: dedupe concurrent first-view generations for the same match (the LLM call is the
// expensive part) so two tabs / a double-click don't both run it. The cache + idempotent upsert
// make this purely an efficiency guard.
const inFlight = new Map<string, Promise<MatchReport | null>>();

// Build (or fetch the cached) report for a recorded match. Returns null if there is no recording
// (e.g. an AI-vs-AI match played via --summary) — the caller surfaces "no report available".
export function buildMatchReport(kind: RecKind, refId: number, homeName: string, awayName: string): Promise<MatchReport | null> {
  const key = `${kind}:${refId}`;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const p = generateMatchReport(kind, refId, homeName, awayName).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

async function generateMatchReport(kind: RecKind, refId: number, homeName: string, awayName: string): Promise<MatchReport | null> {
  const cached = db.prepare('SELECT headline, body, ratings, facts FROM match_reports WHERE kind = ? AND ref_id = ?')
    .get(kind, refId) as { headline: string; body: string; ratings: string; facts: string } | undefined;
  if (cached) {
    try { return { headline: cached.headline, body: cached.body, ratings: JSON.parse(cached.ratings), facts: JSON.parse(cached.facts) }; }
    catch { /* corrupt cache row — regenerate below */ }
  }
  const rec = recordingFor(kind, refId);
  if (!rec) return null;
  const frames = loadRecording(rec);
  if (!frames.length) return null;
  const facts = analyzeRecording(frames);
  const { headline, body } = await writeNarrative(facts, homeName, awayName);
  db.prepare(`INSERT INTO match_reports (kind, ref_id, headline, body, ratings, facts, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(kind, ref_id) DO UPDATE SET
      headline = excluded.headline, body = excluded.body, ratings = excluded.ratings, facts = excluded.facts, created_at = excluded.created_at`)
    .run(kind, refId, headline, body, JSON.stringify(facts.ratings), JSON.stringify(facts), Date.now());
  return { headline, body, facts, ratings: facts.ratings };
}

// Delete cached reports for a set of matches — called when their fixtures are removed at season
// rollover so match_reports doesn't accumulate rows keyed to dead fixture ids.
export function purgeReports(kind: RecKind, refIds: number[]): void {
  if (!refIds.length) return;
  const del = db.prepare('DELETE FROM match_reports WHERE kind = ? AND ref_id = ?');
  for (const id of refIds) del.run(kind, id);
}
