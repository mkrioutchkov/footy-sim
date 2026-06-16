// Dynamic player-news (LLM stream). Notable events — a hat-trick, a brace, a red card, a
// man-of-the-match display, a long injury — become news AND evolve the player himself: a
// development is woven into his backstory and his trait dials are RE-DERIVED from the new text
// (the text↔dial coupling, see personality.ts). LLM-primary for the rewrite, with a deterministic
// cue-rich append as the always-available fallback, so it never blocks and is fully testable
// without a key. Match events are read from the recording (no engine run); injuries come from the
// fitness tick. Processed once per matchday (ref_id = fixture), in the background from /api/advance.
import { db } from './db.ts';
import { recordingFor, loadRecording, getFixture } from './match.ts';
import { analyzeRecording } from './report.ts';
import { deriveTraits, defaultPersonality, type Personality } from './personality.ts';

const BASE = (process.env.TACTICS_LLM_BASE_URL ?? 'https://api.groq.com/openai/v1').replace(/\/$/, '');
const MODEL = process.env.TACTICS_LLM_MODEL ?? 'llama-3.3-70b-versatile';
const KEY = process.env.TACTICS_LLM_API_KEY ?? '';

export type NewsType = 'hat_trick' | 'brace' | 'red_card' | 'star' | 'long_injury';

// Each event: the feed headline + a cue-rich "development" sentence. The sentence is woven into
// the backstory (the LLM rewrites around it; the fallback appends it verbatim) — its phrases are
// the deterministic keyword cues in personality.ts, so re-deriving moves the right dials: a
// hat-trick lifts ego + big-game, a red card the temperament, a long injury dents consistency, etc.
const EVENTS: Record<NewsType, { headline: (player: string) => string; dev: string }> = {
  hat_trick: { headline: p => `${p} fires home a hat-trick!`, dev: 'Fresh off a match-ball hat-trick — box office now, and rises to the big occasion.' },
  brace: { headline: p => `${p} bags a brace`, dev: 'Red-hot in front of goal — a confidence player who feeds off the crowd.' },
  red_card: { headline: p => `${p} sees red`, dev: 'A rash sending-off laid bare the short fuse and fiery temper once again.' },
  star: { headline: p => `${p} runs the show — man of the match`, dev: 'A big-game talisman who commands the side when it matters.' },
  long_injury: { headline: p => `${p} ruled out with a lay-off`, dev: 'A long lay-off has left him fragile, and he needs encouragement to rebuild.' },
};

const cap = (s: string, n = 380) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

function parsePersonality(json: string | null, name: string, role: string): Personality {
  const d = defaultPersonality(name, role);
  try {
    const o = json ? JSON.parse(json) : null;
    if (o && typeof o === 'object') return { traits: { ...d.traits, ...(o.traits ?? {}) }, nationality: o.nationality ?? '', backstory: o.backstory ?? '', tagline: o.tagline ?? '' };
  } catch { /* default */ }
  return d;
}

const REWRITE_SYSTEM = 'You evolve a football player\'s backstory after a development in his career. Keep his established character but weave the new development in. Output ONLY JSON: {"backstory":"2-3 sentences","tagline":"<=6 words, in character"}.';

// Rewrite the backstory to absorb a development (LLM-primary); the deterministic fallback appends
// the cue-rich development sentence so the re-derive still shifts the dials sensibly.
async function rewriteStory(name: string, role: string, p: Personality, dev: string): Promise<{ backstory: string; tagline: string }> {
  // Prepend the development so its cue phrases survive the length cap (and re-derive) even when the
  // backstory has already grown over a season — the cap then sheds the OLDEST text, not the newest.
  const fallback = () => ({ backstory: cap(p.backstory ? `${dev} ${p.backstory}` : dev), tagline: p.tagline });
  if (!KEY) return fallback();
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, temperature: 0.7, max_tokens: 300, messages: [
        { role: 'system', content: REWRITE_SYSTEM },
        { role: 'user', content: `${name} — ${role}.\nCurrent backstory: ${p.backstory || '(none yet)'}\nDevelopment: ${dev}` },
      ] }),
      signal: AbortSignal.timeout(20000),
    });
    if (res.ok) {
      const j = await res.json() as { choices?: { message?: { content?: string } }[] };
      const raw = (j.choices?.[0]?.message?.content ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
      if (s >= 0 && e > s) {
        const o = JSON.parse(raw.slice(s, e + 1)) as { backstory?: unknown; tagline?: unknown };
        const backstory = typeof o.backstory === 'string' && o.backstory.trim() ? cap(o.backstory.trim()) : fallback().backstory;
        const tagline = typeof o.tagline === 'string' && o.tagline.trim() ? o.tagline.trim().slice(0, 80) : p.tagline;
        return { backstory, tagline };
      }
    }
  } catch { /* fall through */ }
  return fallback();
}

interface Event { id: number; slot: number; player: string; type: NewsType }

// One player's evolution + news row, in a fresh tx-free write (caller batches). Keyed by the
// player's stable DB id (captured synchronously at detection) — so a deferred write never lands on
// the wrong player if slots renumber (a season-ending advance) between detection and here.
// Re-derives the dials from the new story so training rate + transfer value (which read them) follow.
async function applyEvent(teamId: number, fixtureId: number, season: number, ev: Event): Promise<void> {
  const row = db.prepare('SELECT name, role, personality FROM players WHERE id = ?').get(ev.id) as
    { name: string; role: string; personality: string | null } | undefined;
  if (!row) return;   // player left the club between detection and this (deferred) write — skip
  const dev = EVENTS[ev.type].dev;
  const cur = parsePersonality(row.personality, row.name, row.role);
  const { backstory, tagline } = await rewriteStory(row.name, row.role, cur, dev);
  const traits = await deriveTraits(row.name, row.role, backstory, tagline);
  const next: Personality = { traits, nationality: cur.nationality, backstory, tagline };
  db.prepare('UPDATE players SET personality = ? WHERE id = ?').run(JSON.stringify(next), ev.id);
  db.prepare('INSERT INTO player_news (team_id, player_slot, player_name, type, headline, ref_id, season, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(teamId, ev.slot, ev.player, ev.type, EVENTS[ev.type].headline(ev.player), fixtureId, season, Date.now());
}

const LONG_INJURY = 3;   // matchdays sidelined that counts as "a lay-off"

// Detect + apply a matchday's player-news for the user's team: notable events in his match (from
// its recording) + any long injury that landed (from the fitness tick). Idempotent per fixture.
// Returns the headlines produced (also persisted). Best-effort — call in the background.
export async function processPlayerNews(teamId: number, fixtureId: number, injuries: { teamId: number; player: string; matches: number }[]): Promise<string[]> {
  if (db.prepare('SELECT 1 FROM player_news WHERE team_id = ? AND ref_id = ?').get(teamId, fixtureId)) return [];   // already processed this matchday
  const squad = db.prepare('SELECT id, slot, name FROM players WHERE team_id = ?').all(teamId) as { id: number; slot: number; name: string }[];
  // Resolve events to a player by name, but ONLY when the name is unique in the squad — player
  // names aren't guaranteed unique, and mis-evolving a same-named team-mate is worse than dropping
  // the rare ambiguous event. Captures the stable DB id (synchronously, pre any rollover).
  const nameCount = new Map<string, number>();
  for (const p of squad) nameCount.set(p.name, (nameCount.get(p.name) ?? 0) + 1);
  const byName = new Map(squad.filter(p => nameCount.get(p.name) === 1).map(p => [p.name, p]));
  const season = (db.prepare('SELECT l.season AS s FROM leagues l JOIN teams t ON t.league_id = l.id WHERE t.id = ?').get(teamId) as { s: number } | undefined)?.s ?? 1;

  const events: Event[] = [];
  // match events — read the recording (deterministic, no engine), user's side only, one per player
  const rec = recordingFor('fixture', fixtureId);
  const fx = getFixture(fixtureId);
  if (rec && fx) {
    const frames = loadRecording(rec);
    if (frames.length) {
      const facts = analyzeRecording(frames);
      const side: 'home' | 'away' = fx.home_team_id === teamId ? 'home' : 'away';
      const sentOff = new Set(facts.timeline.filter(e => e.type === 'red' && e.team === side).map(e => e.name));   // user's side only
      for (const r of facts.ratings.filter(x => x.team === side)) {
        const p = byName.get(r.name);
        if (!p) continue;
        const type: NewsType | null = r.goals >= 3 ? 'hat_trick' : sentOff.has(r.name) ? 'red_card' : r.goals === 2 ? 'brace' : r.rating >= 8.5 ? 'star' : null;
        if (type) events.push({ id: p.id, slot: p.slot, player: r.name, type });
      }
    }
  }
  // injury events — a long lay-off for one of the user's players
  for (const i of injuries) {
    if (i.teamId !== teamId || i.matches < LONG_INJURY) continue;
    const p = byName.get(i.player);
    if (p) events.push({ id: p.id, slot: p.slot, player: i.player, type: 'long_injury' });
  }

  const headlines: string[] = [];
  for (const ev of events) { await applyEvent(teamId, fixtureId, season, ev); headlines.push(EVENTS[ev.type].headline(ev.player)); }
  return headlines;
}

export interface NewsRow { player: string; type: NewsType; headline: string; season: number; slot: number }
export function recentNews(teamId: number, limit = 20): NewsRow[] {
  return (db.prepare('SELECT player_name, type, headline, season, player_slot FROM player_news WHERE team_id = ? ORDER BY id DESC LIMIT ?').all(teamId, limit) as
    { player_name: string; type: NewsType; headline: string; season: number; player_slot: number }[])
    .map(r => ({ player: r.player_name, type: r.type, headline: r.headline, season: r.season, slot: r.player_slot }));
}
