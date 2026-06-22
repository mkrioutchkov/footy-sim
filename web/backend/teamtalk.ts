// Pre-match team talk (audit §2.13, the engine-independent half of "in-match depth"). Before a match,
// the manager addresses the squad with a chosen TONE; each player reacts according to his personality
// dials, producing a one-off morale delta that rides into the match spec as players[].moraleBoost — a
// hook the engine already reads at kickoff (main.cpp) and uses to shade effort. Deterministic (no LLM,
// no RNG), so a given squad + tone always yields the same reactions; testable side-by-side with the sim.
//
// This is the turn-based counterpart to the live in-match shouts (plan.ts / coordinator.ts): same morale
// idea, but resolved up front into the spec so it works WITHOUT the engine's (still-TODO) live channel.
import { db } from './db.ts';
import { getTeamWithPlayers } from './game.ts';
import type { Traits } from './personality.ts';

export type TalkTone = 'believe' | 'demand' | 'calm' | 'fire_up';
export interface TalkToneDef { key: TalkTone; label: string; blurb: string; }
export const TALK_TONES: TalkToneDef[] = [
  { key: 'believe', label: 'Show belief',  blurb: 'Back them to perform — lifts confidence players, but big egos may coast on it.' },
  { key: 'demand',  label: 'Demand more',  blurb: 'A hairdryer — fires up the thick-skinned, but can rattle the sensitive.' },
  { key: 'calm',    label: 'Stay calm',    blurb: 'Settle the nerves — helps players who freeze on the big day or run hot.' },
  { key: 'fire_up', label: 'Fire them up', blurb: 'Rouse them for the occasion — big-game players and leaders rise to it.' },
];
const TONE_KEYS = new Set<string>(TALK_TONES.map(t => t.key));
export const isTalkTone = (s: unknown): s is TalkTone => typeof s === 'string' && TONE_KEYS.has(s);

const NEUTRAL: Traits = { temperament: 50, criticismResponse: 50, praiseResponse: 50, bigGame: 50, consistency: 50, leadership: 50, professionalism: 50, ego: 50 };
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

// The deterministic reaction model — a moraleBoost delta in [-0.5, 0.5] from the player's dials. Mirrors
// the live-shout motivation logic (plan.ts MOTIVATION): criticism fires the thick-skinned / wilts the
// sensitive, praise lifts but risks ego complacency, calm settles the nervous & hot-headed, occasion
// rouses the big-game players. A perfectly neutral (all-50) player barely moves — talks reward a varied squad.
export function talkDelta(tr: Traits, tone: TalkTone): number {
  const v = (k: keyof Traits) => (typeof tr[k] === 'number' ? tr[k] : 50);
  const n = (k: keyof Traits) => (v(k) - 50) / 50;   // -1..1
  let d = 0;
  if (tone === 'demand') {
    const amp = 0.6 + 0.4 * (v('temperament') / 100);          // fiery players swing harder
    d = n('criticismResponse') * amp * 0.5;                    // thrive on a rocket vs wilt at it
    if (v('ego') > 70) d -= 0.08;                              // big egos bristle at a dressing-down
  } else if (tone === 'believe') {
    d = 0.45 * Math.max(0, n('praiseResponse'));               // praise lifts the confidence players; ~0 for the praise-immune
    if (v('ego') > 60) d -= 0.30 * ((v('ego') - 60) / 40);     // complacency creeps in for big egos
  } else if (tone === 'calm') {
    d = 0.25 * Math.max(0, (50 - v('bigGame')) / 50)           // settles the players who freeze
      + 0.25 * Math.max(0, n('temperament'));                  // and the hot-heads
  } else if (tone === 'fire_up') {
    d = 0.40 * n('bigGame') + 0.15 * n('leadership');          // the occasion players + leaders rise
  }
  return Math.round(clamp(d, -0.5, 0.5) * 100) / 100;          // 2dp, deterministic
}

const traitsOf = (personality: unknown): Traits => ((personality as { traits?: Traits } | null)?.traits) ?? NEUTRAL;
function reactionLabel(d: number): string {
  if (d >= 0.25) return 'fired up';
  if (d >= 0.08) return 'lifted';
  if (d > -0.08) return 'unmoved';
  return 'rattled';
}

export interface TalkReaction { slot: number; name: string; role: string; delta: number; reaction: string; }
// Per-player preview of how a tone would land across the squad (for the UI — and the source of truth the
// stored deltas are computed from).
export function previewTalk(teamId: number, tone: TalkTone): TalkReaction[] {
  const t = getTeamWithPlayers(teamId);
  if (!t) return [];
  return t.players.map(p => {
    const d = talkDelta(traitsOf(p.personality), tone);
    return { slot: p.slot, name: p.name, role: p.role, delta: d, reaction: reactionLabel(d) };
  });
}

// Lock in the talk for a given fixture (replaces any prior talk for that fixture). Stores the computed
// per-slot deltas so the reaction can't drift if personalities change before the match.
export function setTeamTalk(teamId: number, fixtureId: number, tone: TalkTone): { ok: boolean; tone: TalkTone; reactions: TalkReaction[] } {
  const reactions = previewTalk(teamId, tone);
  const deltas = reactions.filter(r => Math.abs(r.delta) >= 0.01).map(r => ({ slot: r.slot, delta: r.delta }));
  db.prepare('INSERT OR REPLACE INTO team_talks (team_id, fixture_id, tone, deltas, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(teamId, fixtureId, tone, JSON.stringify(deltas), Date.now());
  return { ok: true, tone, reactions };
}

// The talk a manager has tabled for a fixture (for the UI to show the current selection), or null.
export function pendingTalk(teamId: number, fixtureId: number): { tone: TalkTone; reactions: TalkReaction[] } | null {
  const row = db.prepare('SELECT tone FROM team_talks WHERE team_id = ? AND fixture_id = ?').get(teamId, fixtureId) as { tone: string } | undefined;
  if (!row || !isTalkTone(row.tone)) return null;
  return { tone: row.tone, reactions: previewTalk(teamId, row.tone) };
}

// The per-slot moraleBoost deltas to fold into a fixture's spec (empty when no talk was given — so a
// match with no talk emits no moraleBoost field and stays byte-identical to before).
export function getTeamTalkDeltas(teamId: number, fixtureId: number): Map<number, number> {
  const row = db.prepare('SELECT deltas FROM team_talks WHERE team_id = ? AND fixture_id = ?').get(teamId, fixtureId) as { deltas: string } | undefined;
  const out = new Map<number, number>();
  if (!row) return out;
  try { for (const d of JSON.parse(row.deltas) as { slot: number; delta: number }[]) out.set(d.slot, d.delta); } catch { /* ignore a corrupt row */ }
  return out;
}

// Consume a fixture's talk once the match has been played (one-off effect).
export function consumeTeamTalk(fixtureId: number): void {
  db.prepare('DELETE FROM team_talks WHERE fixture_id = ?').run(fixtureId);
}
