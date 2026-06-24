// Press conferences (LLM stream). The manager addresses the media; the statement's tone is
// judged against each player's personality dials to move their morale — a praise-hungry player
// lifts when you back him, a criticism-responsive one responds to a rocket while a sensitive or
// hot-headed one wilts. LLM-primary (same provider as personality.ts/tactics.ts) with a
// deterministic keyword fallback, so it never blocks. Reads the dials (the text↔dial coupling).
import { db } from './db.ts';
import { chatComplete, llmReady } from './llm.ts';
import { adjustConfidence } from './confidence.ts';

interface Dials { criticismResponse: number; praiseResponse: number; ego: number; temperament: number }
interface SquadMember { slot: number; name: string; traits: Dials }
export interface PressReaction { slot: number; name: string; delta: number; quote?: string }

const clampDelta = (v: number) => Math.max(-15, Math.min(15, Math.round(v)));

// Deterministic tone read of the statement: +1 praising/confident .. -1 critical.
const PRAISE = ['proud', 'brilliant', 'best', 'confident in', 'back the', 'great', 'delighted', 'fantastic', 'believe in', 'top', 'quality', 'magnificent', 'buzzing'];
const CRIT = ['not good enough', 'disappointed', 'must do better', 'unacceptable', 'angry', 'poor', 'embarrassing', 'sloppy', 'wake up', 'demand more', 'not happy', 'no excuses'];
const CONFIDENT = ['calm', 'focused', 'process', 'one game at a time', 'take each', 'no pressure', 'quietly confident', 'prepared', 'ready'];
function toneOf(text: string): number {
  const t = text.toLowerCase();
  const score = PRAISE.filter(k => t.includes(k)).length + CONFIDENT.filter(k => t.includes(k)).length * 0.5 - CRIT.filter(k => t.includes(k)).length;
  return Math.max(-1, Math.min(1, score / 2));
}
// A player's morale shift from a tone, via their dials.
function deterministicDelta(tone: number, d: Dials): number {
  const pr = d.praiseResponse / 100, cr = d.criticismResponse / 100, ego = d.ego / 100, temp = d.temperament / 100;
  if (tone >= 0) return clampDelta(tone * (5 + pr * 10 + ego * 3));          // praise lifts the praise-hungry + egos
  return clampDelta((-tone) * (cr * 14 - (1 - cr) * 9 - temp * 4));          // criticism: lifts the responsive, dents the sensitive + hotheads
}

function extractArray(content: string): unknown[] {
  const body = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { const v = JSON.parse(body); if (Array.isArray(v)) return v; if (v && Array.isArray((v as any).reactions)) return (v as any).reactions; } catch { /* salvage */ }
  const s = content.indexOf('['), e = content.lastIndexOf(']');
  if (s >= 0 && e > s) { try { const v = JSON.parse(content.slice(s, e + 1)); if (Array.isArray(v)) return v; } catch { /* noop */ } }
  return [];
}

const SYSTEM = `You judge how a football manager's press-conference statement lands with each of his players, returning ONE reaction per player IN ORDER. Output ONLY a JSON array of objects [{"delta":-15..15,"quote":"..."}]. Use each player's dials (0-100): praiseResponse = how much praise lifts them; criticismResponse = HIGH thrives on a public rocket / LOW wilts under it; ego = self-importance (loves praise, bristles at criticism); temperament = HIGH is fiery (reacts badly to criticism). A warm/backing statement lifts most players (most the praise-hungry + big egos); a critical statement lifts the criticism-responsive but dents the sensitive and the hot-heads. Keep deltas modest (most within ±10). "quote" is a SHORT first-person in-character line (max ~12 words) showing how it landed for that player given his dials — terse and natural, no name prefix. Return EXACTLY one object per player, in order.`;

// LLM-primary morale reactions; deterministic keyword judge as the always-available fallback.
export async function judgePressConference(text: string, squad: SquadMember[]): Promise<PressReaction[]> {
  const tone = toneOf(text);
  const fallback = () => squad.map(m => ({ slot: m.slot, name: m.name, delta: deterministicDelta(tone, m.traits) }));
  if (!llmReady().ok || !text.trim() || !squad.length) return fallback();
  try {
    const lines = squad.map((m, i) => `${i + 1}. ${m.name} — praiseResponse ${m.traits.praiseResponse}, criticismResponse ${m.traits.criticismResponse}, ego ${m.traits.ego}, temperament ${m.traits.temperament}`).join('\n');
    const arr = extractArray(await chatComplete({
      system: SYSTEM,
      user: `Statement: "${text}"\n\nPlayers:\n${lines}`,
      temperature: 0.4, maxTokens: 1600, timeoutMs: 20000,
    }));
    if (arr.length) return squad.map((m, i) => {
      const obj = arr[i] as { delta?: unknown; quote?: unknown } | undefined;
      const raw = obj?.delta;
      // accept only a real number or a non-empty numeric string; null/""/[]/false etc. fall
      // back to the deterministic per-player delta (unary + coerces those to a finite 0).
      const n = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN);
      const quote = typeof obj?.quote === 'string' && obj.quote.trim() ? obj.quote.trim().slice(0, 140) : undefined;
      return { slot: m.slot, name: m.name, delta: Number.isFinite(n) ? clampDelta(n) : deterministicDelta(tone, m.traits), quote };
    });
  } catch { /* unreachable / no-key / bad output — fall through */ }
  return fallback();
}

const parseJSON = (s: string | null): unknown => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

// ── Cadence: one press conference per the club's match (so you can't spam to farm morale) ────────
// Marker = the club's played-fixture count. You may face the media once between matches; recordPress
// stamps the current count, and the next match (which increments it) re-opens the room. Reset at rollover.
const playedCount = (teamId: number): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM fixtures WHERE (home_team_id = ? OR away_team_id = ?) AND played = 1').get(teamId, teamId) as { n: number }).n;

export function pressAvailable(teamId: number): boolean {
  const row = db.prepare('SELECT last_press_round FROM teams WHERE id = ?').get(teamId) as { last_press_round: number | null } | undefined;
  if (!row) return false;
  return row.last_press_round == null || row.last_press_round < playedCount(teamId);
}

export function recordPress(teamId: number): void {
  db.prepare('UPDATE teams SET last_press_round = ? WHERE id = ?').run(playedCount(teamId), teamId);
}

// Hold a press conference for a club: judge the statement + apply the morale changes.
export async function applyPressConference(teamId: number, text: string): Promise<{ reactions: PressReaction[]; lifted: number; unsettled: number }> {
  const rows = db.prepare('SELECT slot, name, personality FROM players WHERE team_id = ? ORDER BY slot').all(teamId) as
    { slot: number; name: string; personality: string | null }[];
  const squad: SquadMember[] = rows.map(r => {
    const tr = ((parseJSON(r.personality) as { traits?: Partial<Dials> } | null)?.traits) ?? {};
    return { slot: r.slot, name: r.name, traits: { criticismResponse: tr.criticismResponse ?? 50, praiseResponse: tr.praiseResponse ?? 50, ego: tr.ego ?? 50, temperament: tr.temperament ?? 50 } };
  });
  const reactions = await judgePressConference(text, squad);
  // Apply each delta to the player's CURRENT morale IN SQL (clamped), not a pre-await snapshot
  // + delta — so it composes atomically with a concurrent matchday morale tick instead of
  // clobbering it (the read-modify-write must not span the multi-second LLM await).
  const upd = db.prepare('UPDATE players SET morale = MAX(0, MIN(100, morale + ?)) WHERE team_id = ? AND slot = ?');
  for (const r of reactions) upd.run(r.delta, teamId, r.slot);
  return { reactions, lifted: reactions.filter(r => r.delta > 0).length, unsettled: reactions.filter(r => r.delta < 0).length };
}

// ── Interactive press conference: a context-aware journalist QUESTION + tone-keyed response OPTIONS.
// The chosen response feeds the morale judge above AND nudges board confidence by its tone —
// accountability earns the board's respect, deflection erodes it. ────────────────────────────────────
export type PressTone = 'back_players' | 'demand_more' | 'accountable' | 'defiant' | 'calm';
const TONE_BOARD: Record<PressTone, number> = { accountable: 3, calm: 1, back_players: 1, demand_more: 1, defiant: -4 };
export function boardDeltaForTone(tone: string): number {
  return (TONE_BOARD as Record<string, number>)[tone] ?? 0;
}

export interface PressOption { tone: PressTone; label: string; text: string }
export interface PressQuestion { question: string; options: PressOption[] }
export interface PressContext {
  form: string;                       // last 5 e.g. "WWLDL" (newest last), '' early
  lastResult?: 'W' | 'D' | 'L';
  // the just-played match — lets the press react like a POST-MATCH interview (scoreline + opponent),
  // not just "you won/lost". Undefined before any match.
  lastMatch?: { result: 'W' | 'D' | 'L'; gf: number; ga: number; opponent: string; home: boolean };
  position: number; teams: number;
  objective?: string; nextOpponent?: string; confidence?: string;
}

// Deterministic template question + the five tone options keyed to the situation — the always-available
// fallback (and the test fixture). The LLM enriches the wording when reachable; tones/effects stay fixed.
const STD_OPTIONS: PressOption[] = [
  { tone: 'back_players', label: 'Back the players', text: 'I believe in this group — they give me everything and we go again together.' },
  { tone: 'demand_more', label: 'Demand more', text: "Not good enough — I've told them, one or two need to step up and show me more." },
  { tone: 'accountable', label: 'Take responsibility', text: "That's on me. The buck stops with the manager and I'll put it right." },
  { tone: 'calm', label: 'Stay calm', text: 'We stay calm and focused — one game at a time, trust the process.' },
  { tone: 'defiant', label: 'Deflect it', text: "Ask the board, not me. I won't answer that — judge me at the end of the season." },
];
function templateQuestion(c: PressContext): PressQuestion {
  const lm = c.lastMatch;
  let question: string;
  if (lm) {
    // post-match: react to the actual scoreline + opponent
    const score = `${lm.gf}-${lm.ga}`;
    const vs = lm.home ? `at home to ${lm.opponent}` : `away at ${lm.opponent}`;
    question = lm.result === 'W'
      ? `That ${score} win ${lm.home ? 'over' : 'at'} ${lm.opponent} — is this side turning a corner?`
      : lm.result === 'L'
        ? `A ${score} defeat ${vs}${/LL$/.test(c.form) ? ' — and the run goes on' : ''}. What went wrong?`
        : `A ${score} draw ${vs} — two points dropped, or a point earned?`;
  } else {
    const losing = c.lastResult === 'L' || /LL$/.test(c.form);
    const winning = c.lastResult === 'W' || /WW$/.test(c.form);
    question = losing
      ? `That result will sting${c.nextOpponent ? `, and ${c.nextOpponent} are next` : ''}. Are you worried about the run?`
      : winning ? 'Good win — is this side turning a corner?'
      : c.objective ? `The board want "${c.objective}". Are you on course?`
      : 'How do you assess where the team is right now?';
  }
  return { question, options: STD_OPTIONS };
}

const Q_SYSTEM = `You are a sharp football journalist at a manager's POST-MATCH press conference. Lead with the JUST-PLAYED result (the scoreline + opponent) when given, then ask ONE pointed, natural question (max ~22 words); also propose 4-5 short response options he could give, each a distinct TONE. Output ONLY JSON {"question":"...","options":[{"tone":"back_players|demand_more|accountable|defiant|calm","label":"2-3 words","text":"first-person line, max ~18 words"}]}. Make the question specific to that result (and the form/objective/next opponent). Punchy and in-character.`;

export async function generatePressQuestion(c: PressContext): Promise<PressQuestion> {
  const fb = templateQuestion(c);
  if (!llmReady(true).ok) return fb;
  try {
    const lm = c.lastMatch;
    const lastMatchLine = lm ? `Just played: ${lm.result === 'W' ? 'WON' : lm.result === 'L' ? 'LOST' : 'DREW'} ${lm.gf}-${lm.ga} ${lm.home ? 'at home to' : 'away to'} ${lm.opponent}. ` : '';
    const ctx = `${lastMatchLine}Form (last 5, newest last): ${c.form || 'n/a'}. League position: ${c.position}/${c.teams}. Board objective: ${c.objective ?? 'n/a'}. Board confidence: ${c.confidence ?? 'n/a'}. Next opponent: ${c.nextOpponent ?? 'n/a'}.`;
    const raw = await chatComplete({ system: Q_SYSTEM, user: ctx, temperature: 0.7, maxTokens: 500, timeoutMs: 9000, live: true });
    const o = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) as { question?: unknown; options?: unknown };
    const valid: PressOption[] = Array.isArray(o.options) ? o.options.flatMap((x): PressOption[] => {
      const opt = x as { tone?: unknown; label?: unknown; text?: unknown };
      const tone = (['back_players', 'demand_more', 'accountable', 'defiant', 'calm'] as const).find(t => t === opt.tone) ?? null;
      if (!tone || typeof opt.text !== 'string' || !opt.text.trim()) return [];
      return [{ tone, label: typeof opt.label === 'string' && opt.label.trim() ? opt.label.trim().slice(0, 24) : tone.replace('_', ' '), text: opt.text.trim().slice(0, 160) }];
    }) : [];
    const question = typeof o.question === 'string' && o.question.trim() ? o.question.trim().slice(0, 200) : fb.question;
    return valid.length >= 2 ? { question, options: valid.slice(0, 5) } : fb;
  } catch { return fb; }
}

// Apply a chosen press response: the per-player morale judge PLUS a board-confidence nudge from the
// response's tone (free-text with no tone → board-neutral). Returns the morale reactions + board delta.
// A press conference is part of the club's story, so it leaves a 🎤 headline in Club news (a club-level
// news row, no player link). Tone-keyed; best-effort so it can never break the press response.
const PRESS_HEADLINE: Record<string, string> = {
  back_players: 'Manager publicly backs his players',
  demand_more: 'Manager demands more from his squad',
  accountable: 'Manager takes responsibility in front of the media',
  defiant: 'Manager defiant in his press conference',
  calm: 'Manager strikes a calm note with the press',
};
function recordPressNews(teamId: number, tone?: string): void {
  try {
    const headline = (tone && PRESS_HEADLINE[tone]) || 'Manager faces the media';
    const season = (db.prepare('SELECT l.season FROM leagues l JOIN teams t ON t.league_id = l.id WHERE t.id = ?').get(teamId) as { season: number } | undefined)?.season ?? 1;
    db.prepare("INSERT INTO player_news (team_id, player_slot, player_name, type, headline, ref_id, season, created_at) VALUES (?, -1, '', 'press', ?, 0, ?, ?)").run(teamId, headline, season, Date.now());
  } catch { /* ambient — the headline is a nicety, never block the presser */ }
}

export async function applyPressResponse(teamId: number, text: string, tone?: string): Promise<{ reactions: PressReaction[]; lifted: number; unsettled: number; boardDelta: number }> {
  const r = await applyPressConference(teamId, text);
  const boardDelta = tone ? boardDeltaForTone(tone) : 0;
  if (boardDelta) adjustConfidence(teamId, boardDelta);
  recordPressNews(teamId, tone);   // leave a headline in Club news (the press is part of the club's story)
  return { ...r, boardDelta };
}
