// 1-to-1 player interaction (praise / encourage / warn / criticise) — a private word with ONE player
// that moves his morale, gated by his personality dials (the SAME personality-gated math press
// conferences use, reused from press.ts). Cooldown: one chat per player per matchday
// (players.last_interact_round), so morale can't be farmed. Deterministic + always available (no LLM):
// the reaction line is templated from the tone × how it landed. Human clubs only (routed via the user's team).
import { db } from './db.ts';
import { deterministicDelta } from './press.ts';

export type InteractTone = 'praise' | 'encourage' | 'warn' | 'criticise';
export const INTERACT_TONES: { tone: InteractTone; label: string; blurb: string }[] = [
  { tone: 'praise', label: '👏 Praise', blurb: 'Single him out for his form — lifts most, especially praise-hungry players and big egos.' },
  { tone: 'encourage', label: '💬 Encourage', blurb: 'A quiet word of belief — a gentle lift for most.' },
  { tone: 'warn', label: '☝️ Have a word', blurb: 'A measured warning about his standards — mild; the thick-skinned take it well.' },
  { tone: 'criticise', label: '🔥 Criticise', blurb: 'Tear a strip off him — fires up the thick-skinned, wounds the sensitive and hot-heads.' },
];
const TONE_VAL: Record<InteractTone, number> = { praise: 1, encourage: 0.5, warn: -0.5, criticise: -1 };
export function isInteractTone(t: unknown): t is InteractTone {
  return t === 'praise' || t === 'encourage' || t === 'warn' || t === 'criticise';
}

interface Dials { criticismResponse: number; praiseResponse: number; ego: number; temperament: number }
const parseJSON = (s: string | null): unknown => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
// The club's played-match count — the cooldown marker, same as the press-conference cadence.
const playedCount = (teamId: number): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM fixtures WHERE (home_team_id = ? OR away_team_id = ?) AND played = 1').get(teamId, teamId) as { n: number }).n;

// A templated in-character reaction from the tone and how it landed (delta sign + the driving dial).
function reactionLine(tone: InteractTone, delta: number, d: Dials): string {
  if (tone === 'praise' || tone === 'encourage') {
    return delta >= 4 ? 'Cheers, gaffer — means a lot. I’ll keep it going.'
      : delta > 0 ? 'Appreciated. I’ll keep my head down and work.'
        : 'Nice of you to say — but talk’s cheap. I’ll show it on the pitch.';
  }
  if (delta > 0) return d.criticismResponse >= 60 ? 'Fair enough — I’ll show you what I’m about.' : 'Message received. I’ll respond.';
  if (delta === 0) return 'Understood.';
  return d.temperament >= 60 ? 'That’s bang out of order — I don’t need this.' : 'That stings… I’ll try to put it right.';
}

export interface InteractResult { ok: boolean; error?: string; delta?: number; morale?: number; reaction?: string; name?: string }

// Have a private word with one player. Returns the morale delta, his new morale, and his reaction line.
export function interactWithPlayer(teamId: number, slot: number, tone: InteractTone): InteractResult {
  const row = db.prepare('SELECT name, personality, morale, last_interact_round FROM players WHERE team_id = ? AND slot = ?')
    .get(teamId, slot) as { name: string; personality: string | null; morale: number; last_interact_round: number | null } | undefined;
  if (!row) return { ok: false, error: 'no such player' };
  const played = playedCount(teamId);
  if (row.last_interact_round != null && row.last_interact_round >= played) {
    return { ok: false, error: `You've already had a word with ${row.name} this matchday — leave it until the next match.` };
  }
  const tr = ((parseJSON(row.personality) as { traits?: Partial<Dials> } | null)?.traits) ?? {};
  const d: Dials = { criticismResponse: tr.criticismResponse ?? 50, praiseResponse: tr.praiseResponse ?? 50, ego: tr.ego ?? 50, temperament: tr.temperament ?? 50 };
  const delta = deterministicDelta(TONE_VAL[tone], d);
  const newMorale = Math.max(0, Math.min(100, row.morale + delta));
  db.prepare('UPDATE players SET morale = ?, last_interact_round = ? WHERE team_id = ? AND slot = ?').run(newMorale, played, teamId, slot);
  return { ok: true, delta, morale: newMorale, reaction: reactionLine(tone, delta, d), name: row.name };
}
