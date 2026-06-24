// Unsettled-player management (the §2.3 transfer-request depth). Harmony surfaces a fractured dressing
// room; this lets the manager ACT on it. A player agitating to leave — deeply unhappy, a benched big
// ego, or running his deal down while unsettled — becomes a "concern" the manager can resolve three
// ways: talk him round (reassure → morale up, personality-driven), grant the move (list him), or hold
// firm (he stays but sulks). Derived detection (always current, no persisted request flag — mirrors the
// §2.3 seeking-move pill); only the reassure cooldown is persisted (players.last_settled_round).
import { db } from './db.ts';
import { listPlayer } from './market.ts';

export type ConcernKind = 'unsettled' | 'benched_star' | 'wantaway';
export interface PlayerConcern {
  slot: number; name: string; morale: number; kind: ConcernKind;
  reason: string; contractYears: number; canReassure: boolean;
}
export type ConcernAction = 'reassure' | 'accept' | 'reject';
export interface ConcernOutcome {
  ok: boolean; error?: string;
  action?: ConcernAction; moraleDelta?: number; morale?: number; listed?: boolean; askPrice?: number; message?: string;
}

interface Traits { ego?: number; praiseResponse?: number; temperament?: number }
function traitsOf(p: string | null): Traits { try { return p ? (JSON.parse(p).traits ?? {}) : {}; } catch { return {}; } }

const playedCount = (teamId: number): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM fixtures WHERE (home_team_id = ? OR away_team_id = ?) AND played = 1').get(teamId, teamId) as { n: number }).n;

function startersOf(teamId: number): Set<number> {
  try {
    const l = (db.prepare('SELECT lineup FROM teams WHERE id = ?').get(teamId) as { lineup: string | null } | undefined)?.lineup;
    const parsed = l ? JSON.parse(l) : null;
    return Array.isArray(parsed) && parsed.length === 11 ? new Set(parsed.map(Number)) : new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  } catch { return new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]); }
}

interface PlayerRow { slot: number; name: string; personality: string | null; morale: number; contract_years: number; listed: number; last_settled_round: number | null }

// Classify a single player; null = settled. Shared by the list + the resolve guard so they never drift.
function classify(p: PlayerRow, starters: Set<number>): { kind: ConcernKind; reason: string } | null {
  if (p.listed) return null;                                    // already on the market — the request is moot
  const ego = traitsOf(p.personality).ego ?? 50;
  const benched = !starters.has(p.slot);
  const cy = p.contract_years ?? 3;
  if (p.morale <= 30) return { kind: 'unsettled', reason: 'Deeply unhappy — he wants out.' };
  if (ego >= 70 && benched && p.morale < 60) return { kind: 'benched_star', reason: 'A big name frustrated on the bench.' };
  if (cy <= 1 && p.morale < 45) return { kind: 'wantaway', reason: 'Running his deal down and unsettled — angling for a move.' };
  return null;
}

export function getConcerns(teamId: number): PlayerConcern[] {
  const rows = db.prepare('SELECT slot, name, personality, morale, contract_years, listed, last_settled_round FROM players WHERE team_id = ? ORDER BY slot').all(teamId) as unknown as PlayerRow[];
  const starters = startersOf(teamId);
  const played = playedCount(teamId);
  const out: PlayerConcern[] = [];
  for (const p of rows) {
    const c = classify(p, starters);
    if (!c) continue;
    out.push({ slot: p.slot, name: p.name, morale: p.morale, kind: c.kind, reason: c.reason, contractYears: p.contract_years ?? 3,
      canReassure: p.last_settled_round == null || p.last_settled_round < played });
  }
  // most acute first: lowest morale leads
  return out.sort((a, b) => a.morale - b.morale || a.slot - b.slot);
}

const clamp = (v: number) => Math.max(0, Math.min(100, v));

// Resolve a concern. Guarded by classify() so you can only act on a genuinely unsettled player.
export function resolveConcern(teamId: number, slot: number, action: ConcernAction): ConcernOutcome {
  const p = db.prepare('SELECT slot, name, personality, morale, contract_years, listed, last_settled_round FROM players WHERE team_id = ? AND slot = ?').get(teamId, slot) as unknown as PlayerRow | undefined;
  if (!p) return { ok: false, error: 'no such player' };
  if (!classify(p, startersOf(teamId))) return { ok: false, error: `${p.name} has no outstanding concern.` };
  const t = traitsOf(p.personality);

  if (action === 'reassure') {
    const played = playedCount(teamId);
    if (p.last_settled_round != null && p.last_settled_round >= played) {
      return { ok: false, error: `You've already had a word with ${p.name} — give it until the next match.` };
    }
    // The lift scales with how much he values reassurance (praiseResponse) + ego, dampened by a fiery
    // temperament (a hot-head trusts words less). ~3..13; never enough to fully cure deep unhappiness in
    // one sitting (the cooldown forces it across matches), but it pulls him back from the brink.
    const pr = (t.praiseResponse ?? 50) / 100, ego = (t.ego ?? 50) / 100, temp = (t.temperament ?? 50) / 100;
    const lift = Math.round(4 + pr * 8 + ego * 3 - temp * 3);
    const morale = clamp(p.morale + lift);
    db.prepare('UPDATE players SET morale = ?, last_settled_round = ? WHERE team_id = ? AND slot = ?').run(morale, played, teamId, slot);
    return { ok: true, action, moraleDelta: morale - p.morale, morale, message: `You sit ${p.name} down and reaffirm his role. He looks reassured — for now.` };
  }

  if (action === 'accept') {
    const r = listPlayer(teamId, slot);                         // list at the auto asking price
    if (!r.ok) return { ok: false, error: r.error ?? 'could not list him' };
    const morale = clamp(p.morale + 6);                          // relief — you'll let him move on
    db.prepare('UPDATE players SET morale = ? WHERE team_id = ? AND slot = ?').run(morale, teamId, slot);
    return { ok: true, action, moraleDelta: morale - p.morale, morale, listed: true, askPrice: r.askPrice, message: `You agree to listen to offers for ${p.name}. He's transfer-listed.` };
  }

  // reject — hold firm. You keep the asset, but he sulks: a morale hit that risks the dressing room.
  const morale = clamp(p.morale - 8);
  db.prepare('UPDATE players SET morale = ? WHERE team_id = ? AND slot = ?').run(morale, teamId, slot);
  return { ok: true, action, moraleDelta: morale - p.morale, morale, message: `You tell ${p.name} he's going nowhere. He's not happy about it.` };
}
