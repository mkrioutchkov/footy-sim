// Dynamic player-news (LLM stream). Notable events — a hat-trick, a brace, a red card, a
// man-of-the-match display, a long injury — become news AND evolve the player himself: a
// development is woven into his backstory and his trait dials are RE-DERIVED from the new text
// (the text↔dial coupling, see personality.ts). LLM-primary for the rewrite, with a deterministic
// cue-rich append as the always-available fallback, so it never blocks and is fully testable
// without a key. Match events are derived from the cheap --summary per-player STATS (not the opt-in frame
// recording); injuries come from the fitness tick. Processed once per matchday (ref_id = fixture), background.
import { db } from './db.ts';
import { getFixture, type SummaryPlayer } from './match.ts';
import { ratePlayers } from './report.ts';
import { evolveSquadStories, defaultPersonality, type Personality } from './personality.ts';
import { nudgeConfidence } from './confidence.ts';
import { pressArcHeadline } from './press.ts';

export type EvolveType = 'hat_trick' | 'brace' | 'red_card' | 'star' | 'long_injury';   // events that evolve the story
export type NewsType = EvolveType | 'pots' | 'young_pots' | 'press';                    // + season awards + press-conference headlines

// Each event: the feed headline + a cue-rich "development" sentence. The sentence is woven into
// the backstory (the LLM rewrites around it; the fallback appends it verbatim) — its phrases are
// the deterministic keyword cues in personality.ts, so re-deriving moves the right dials: a
// hat-trick lifts ego + big-game, a red card the temperament, a long injury dents consistency, etc.
const EVENTS: Record<EvolveType, { headline: (player: string) => string; dev: string }> = {
  hat_trick: { headline: p => `${p} fires home a hat-trick!`, dev: 'Fresh off a match-ball hat-trick — box office now, and rises to the big occasion.' },
  brace: { headline: p => `${p} bags a brace`, dev: 'Red-hot in front of goal — a confidence player who feeds off the crowd.' },
  red_card: { headline: p => `${p} sees red`, dev: 'A rash sending-off laid bare the short fuse and fiery temper once again.' },
  star: { headline: p => `${p} runs the show — man of the match`, dev: 'A big-game talisman who commands the side when it matters.' },
  long_injury: { headline: p => `${p} ruled out with a lay-off`, dev: 'A long lay-off has left him fragile, and he needs encouragement to rebuild.' },
};

function parsePersonality(json: string | null, name: string, role: string): Personality {
  const d = defaultPersonality(name, role);
  try {
    const o = json ? JSON.parse(json) : null;
    if (o && typeof o === 'object') return { traits: { ...d.traits, ...(o.traits ?? {}) }, nationality: o.nationality ?? '', backstory: o.backstory ?? '', tagline: o.tagline ?? '' };
  } catch { /* default */ }
  return d;
}

interface Event { id: number; slot: number; player: string; type: EvolveType }

const LONG_INJURY = 3;   // matchdays sidelined that counts as "a lay-off"

// Detect + apply a matchday's player-news for the user's team: notable events in his match (from
// its recording) + any long injury that landed (from the fitness tick). Idempotent per fixture.
// Returns the headlines produced (also persisted). Best-effort — call in the background.
const RATING_MORALE = 2.5;   // morale points per rating-point either side of 6.5 (capped at ±8)

// The player-facing aftermath of the user's match: each man who played has his RATING nudge his
// morale and feed his season tally (-> awards), and standout / low-light events evolve his story
// and make the news. Read once from the recording; guarded per-fixture by fixtures.aftermath_done
// so it can't double-apply (e.g. the user watches the match, then advances). Story work is
// best-effort; the morale + tally are claimed up front. Names resolve to a player only when UNIQUE
// in the squad (a duplicate name drops rather than mis-attributes), capturing the stable DB id.
export async function processMatchAftermath(teamId: number, fixtureId: number, injuries: { teamId: number; player: string; matches: number }[], players: SummaryPlayer[] = []): Promise<string[]> {
  const done = db.prepare('SELECT aftermath_done FROM fixtures WHERE id = ?').get(fixtureId) as { aftermath_done: number } | undefined;
  if (!done || done.aftermath_done) return [];
  const squad = db.prepare('SELECT id, slot, name FROM players WHERE team_id = ?').all(teamId) as { id: number; slot: number; name: string }[];
  const nameCount = new Map<string, number>();
  for (const p of squad) nameCount.set(p.name, (nameCount.get(p.name) ?? 0) + 1);
  const byName = new Map(squad.filter(p => nameCount.get(p.name) === 1).map(p => [p.name, p]));
  const season = (db.prepare('SELECT l.season AS s FROM leagues l JOIN teams t ON t.league_id = l.id WHERE t.id = ?').get(teamId) as { s: number } | undefined)?.s ?? 1;

  const events: Event[] = [];
  const fx = getFixture(fixtureId);
  // Ratings/news/morale derive from the cheap --summary per-player stats (passed in) — NOT the frame
  // recording — so they always run, even when the (opt-in, slow) recording timed out or was skipped.
  if (players.length && fx) {
    const side: 'home' | 'away' = fx.home_team_id === teamId ? 'home' : 'away';
    const upd = db.prepare('UPDATE players SET morale = MAX(0, MIN(100, morale + ?)), season_rating_sum = season_rating_sum + ?, season_apps = season_apps + 1 WHERE id = ?');
    for (const r of ratePlayers(players, fx.home_score ?? 0, fx.away_score ?? 0).filter(x => x.team === side)) {
      const p = byName.get(r.name);
      if (!p) continue;
      const delta = Math.max(-8, Math.min(8, Math.round((r.rating - 6.5) * RATING_MORALE)));
      upd.run(delta, r.rating, p.id);   // rating -> morale nudge + season tally (in one write)
      const type: EvolveType | null = r.goals >= 3 ? 'hat_trick' : r.sentOff ? 'red_card' : r.goals === 2 ? 'brace' : r.rating >= 8.5 ? 'star' : null;
      if (type) events.push({ id: p.id, slot: p.slot, player: r.name, type });
    }
  }
  for (const i of injuries) {
    if (i.teamId !== teamId || i.matches < LONG_INJURY) continue;
    const p = byName.get(i.player);
    if (p) events.push({ id: p.id, slot: p.slot, player: i.player, type: 'long_injury' });
  }
  // Board confidence drifts a little on the result (exactly once per fixture, same guard). The big
  // swings happen at rollover; this just keeps the number alive through the season.
  if (fx && fx.home_score != null && fx.away_score != null) {
    const mySide: 'home' | 'away' = fx.home_team_id === teamId ? 'home' : 'away';
    const mine = mySide === 'home' ? fx.home_score : fx.away_score;
    const theirs = mySide === 'home' ? fx.away_score : fx.home_score;
    const outcome: 'W' | 'D' | 'L' = mine > theirs ? 'W' : mine < theirs ? 'L' : 'D';
    nudgeConfidence(teamId, outcome);
    // §P2#8 press → news arc: if a presser was held since the last match, the result now vindicates or
    // undermines that stance — a follow-up headline in Club news, then clear the one-shot marker. Fires
    // once per fixture by the aftermath_done claim below (keep this block above that claim + any await).
    const tone = (db.prepare('SELECT last_press_tone AS t FROM teams WHERE id = ?').get(teamId) as { t: string | null } | undefined)?.t;
    if (tone) {
      const headline = pressArcHeadline(tone, outcome);
      if (headline) db.prepare("INSERT INTO player_news (team_id, player_slot, player_name, type, headline, ref_id, season, created_at) VALUES (?, -1, '', 'press', ?, ?, ?, ?)").run(teamId, headline, fixtureId, season, Date.now());
      db.prepare('UPDATE teams SET last_press_tone = NULL WHERE id = ?').run(teamId);
    }
  }
  // Claim the matchday now that morale + tally are applied — a re-fire can't double them; the
  // (slower, LLM) story evolution below is best-effort on top.
  db.prepare('UPDATE fixtures SET aftermath_done = 1 WHERE id = ?').run(fixtureId);

  // Evolve every standout/injured player's story in ONE batched LLM call (was 2 calls × N events,
  // fully sequential — the dominant matchday latency, esp. on the per-call cold-start transports).
  // Each player's dials are RE-DERIVED in the same response (the text↔dial coupling) so training
  // rate + transfer value follow. Best-effort + deterministic per-event fallback (no throw): if a
  // player left the club between detection and here we skip him entirely (the stable DB id won't
  // resolve), matching the old applyEvent. Keyed by the stable id so a slot renumber can't mis-land.
  const present = events
    .map(ev => {
      const row = db.prepare('SELECT name, role, personality FROM players WHERE id = ?').get(ev.id) as
        { name: string; role: string; personality: string | null } | undefined;
      return row ? { ev, row, cur: parsePersonality(row.personality, row.name, row.role) } : null;
    })
    .filter((x): x is { ev: Event; row: { name: string; role: string; personality: string | null }; cur: Personality } => x !== null);

  const headlines: string[] = [];
  if (present.length) {
    const evolved = await evolveSquadStories(present.map(x => ({
      name: x.row.name, role: x.row.role, backstory: x.cur.backstory, tagline: x.cur.tagline, dev: EVENTS[x.ev.type].dev,
    })));
    const upd = db.prepare('UPDATE players SET personality = ? WHERE id = ?');
    const ins = db.prepare('INSERT INTO player_news (team_id, player_slot, player_name, type, headline, ref_id, season, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    present.forEach((x, i) => {
      const e = evolved[i];
      const next: Personality = { traits: e.traits, nationality: x.cur.nationality, backstory: e.backstory, tagline: e.tagline };
      upd.run(JSON.stringify(next), x.ev.id);
      ins.run(teamId, x.ev.slot, x.ev.player, x.ev.type, EVENTS[x.ev.type].headline(x.ev.player), fixtureId, season, Date.now());
      headlines.push(EVENTS[x.ev.type].headline(x.ev.player));
    });
  }
  return headlines;
}

// §division-ratings: tally a fixture's per-player match ratings into the SEASON tally for the players whose
// club is NOT a human's — the human club is already tallied by processMatchAftermath (incl live matches), so
// skipping it here avoids a double count. Additive: fills AI clubs' season_rating_sum/apps so the division
// average-rating leaderboard is complete. Guarded per-fixture by rating_tallied (fixtures reset at rollover).
// Called from the advance handler over every played fixture's --summary players.
export function tallyDivisionRatings(fixtureId: number, players: SummaryPlayer[]): void {
  const fx = db.prepare(`SELECT f.home_team_id, f.away_team_id, f.home_score, f.away_score, f.rating_tallied,
      (SELECT user_id FROM teams WHERE id = f.home_team_id) AS home_user,
      (SELECT user_id FROM teams WHERE id = f.away_team_id) AS away_user
    FROM fixtures f WHERE f.id = ?`)
    .get(fixtureId) as { home_team_id: number; away_team_id: number; home_score: number | null; away_score: number | null; rating_tallied: number; home_user: number | null; away_user: number | null } | undefined;
  if (!fx || fx.rating_tallied || !players.length) return;
  const uniqueNameMap = (teamId: number): Map<string, number> => {
    const rows = db.prepare('SELECT id, name FROM players WHERE team_id = ?').all(teamId) as { id: number; name: string }[];
    const cnt = new Map<string, number>();
    for (const r of rows) cnt.set(r.name, (cnt.get(r.name) ?? 0) + 1);
    return new Map(rows.filter(r => cnt.get(r.name) === 1).map(r => [r.name, r.id] as const));
  };
  const homeMap = uniqueNameMap(fx.home_team_id), awayMap = uniqueNameMap(fx.away_team_id);
  const ratings = ratePlayers(players, fx.home_score ?? 0, fx.away_score ?? 0);   // index-aligned with players
  const upd = db.prepare('UPDATE players SET season_rating_sum = season_rating_sum + ?, season_apps = season_apps + 1 WHERE id = ?');
  players.forEach((p, i) => {
    const isHome = p.team === 'home';
    if (isHome ? fx.home_user != null : fx.away_user != null) return;   // human club → owned by processMatchAftermath
    const id = (isHome ? homeMap : awayMap).get(p.name);
    if (id != null) upd.run(ratings[i].rating, id);
  });
  db.prepare('UPDATE fixtures SET rating_tallied = 1 WHERE id = ?').run(fixtureId);
}

const MIN_AWARD_APPS = 3;   // games played to be eligible for a season award

// Crown the club's Player + Young Player of the Season from the accumulated rating tally, as news
// (no story change). Called at rollover BEFORE the tally resets; no eligible player -> no award.
export interface SeasonAward { teamId: number; player: string; slot: number; type: 'pots' | 'young_pots'; headline: string; avg: number }
// Crown the club's season awards from the rating tally + record them in the news. Returns the awards so
// the rollover can surface them as a celebration moment (§2.14).
export function recordSeasonAwards(teamId: number, season: number): SeasonAward[] {
  const rated = (db.prepare('SELECT slot, name, age, season_rating_sum AS sum, season_apps AS apps FROM players WHERE team_id = ? AND season_apps >= ?').all(teamId, MIN_AWARD_APPS) as
    { slot: number; name: string; age: number; sum: number; apps: number }[])
    .map(p => ({ ...p, avg: p.sum / p.apps }));
  if (!rated.length) return [];
  const ins = db.prepare('INSERT INTO player_news (team_id, player_slot, player_name, type, headline, ref_id, season, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)');
  const now = Date.now();
  const awards: SeasonAward[] = [];
  const pots = [...rated].sort((a, b) => b.avg - a.avg)[0];
  const potsHead = `${pots.name} — your Player of the Season (avg ${pots.avg.toFixed(1)} over ${pots.apps} games)`;
  ins.run(teamId, pots.slot, pots.name, 'pots', potsHead, season, now);
  awards.push({ teamId, player: pots.name, slot: pots.slot, type: 'pots', headline: potsHead, avg: pots.avg });
  const young = [...rated].filter(p => p.age <= 21).sort((a, b) => b.avg - a.avg)[0];
  if (young && young.name !== pots.name) {
    const youngHead = `${young.name} — your Young Player of the Season (avg ${young.avg.toFixed(1)} over ${young.apps} games)`;
    ins.run(teamId, young.slot, young.name, 'young_pots', youngHead, season, now);
    awards.push({ teamId, player: young.name, slot: young.slot, type: 'young_pots', headline: youngHead, avg: young.avg });
  }
  return awards;
}

export interface NewsRow { player: string; type: NewsType; headline: string; season: number; slot: number }
export function recentNews(teamId: number, limit = 20): NewsRow[] {
  return (db.prepare('SELECT player_name, type, headline, season, player_slot FROM player_news WHERE team_id = ? ORDER BY id DESC LIMIT ?').all(teamId, limit) as
    { player_name: string; type: NewsType; headline: string; season: number; player_slot: number }[])
    .map(r => ({ player: r.player_name, type: r.type, headline: r.headline, season: r.season, slot: r.player_slot }));
}
