// Squad harmony / dressing room. A READ-ONLY read of how settled the squad is, derived from the
// existing personality dials + morale — it mutates nothing (no balance effect), it's an insight
// panel. Leaders + model pros lift it; big egos who are unhappy or stuck on the bench drag it, as
// does a wide morale spread (a split dressing room). See personality.ts for the dials.
import { db } from './db.ts';

export type HarmonyTag = 'leader' | 'pro' | 'disruptive' | 'unsettled';
export interface HarmonyPlayer { slot: number; name: string; tag: HarmonyTag; note: string; }
export interface SquadHarmony {
  harmony: number;            // 0..100
  status: 'united' | 'settled' | 'restless' | 'fractured';
  avgMorale: number;
  players: HarmonyPlayer[];   // notable players, most significant first
}

function traitsOf(personality: string | null): { ego?: number; leadership?: number; professionalism?: number } | null {
  try { return personality ? (JSON.parse(personality).traits ?? null) : null; } catch { return null; }
}

const SEVERITY: Record<HarmonyTag, number> = { disruptive: 0, unsettled: 1, leader: 2, pro: 3 };

export function getSquadHarmony(teamId: number): SquadHarmony | null {
  const rows = db.prepare('SELECT slot, name, personality, morale FROM players WHERE team_id = ? ORDER BY slot')
    .all(teamId) as { slot: number; name: string; personality: string | null; morale: number }[];
  if (!rows.length) return null;

  let sumMorale = 0, min = 100, max = 0, leadBonus = 0, disrupt = 0;
  const players: HarmonyPlayer[] = [];
  for (const p of rows) {
    sumMorale += p.morale; min = Math.min(min, p.morale); max = Math.max(max, p.morale);
    const t = traitsOf(p.personality);
    const ego = t?.ego ?? 50, lead = t?.leadership ?? 50, prof = t?.professionalism ?? 50;
    const benched = p.slot >= 11;
    if (ego >= 70 && (p.morale < 50 || (benched && p.morale < 65))) {
      disrupt += 1 + (ego - 70) / 15;
      players.push({ slot: p.slot, name: p.name, tag: 'disruptive', note: benched ? 'A big ego unhappy on the bench' : 'A big ego, unsettled' });
    } else if (p.morale <= 35) {
      players.push({ slot: p.slot, name: p.name, tag: 'unsettled', note: 'Deeply unhappy' });
    } else if (lead >= 70) {
      leadBonus += (lead - 65) / 10;
      players.push({ slot: p.slot, name: p.name, tag: 'leader', note: 'A dressing-room leader' });
    } else if (prof >= 78) {
      players.push({ slot: p.slot, name: p.name, tag: 'pro', note: 'A model professional' });
    }
  }
  const avg = sumMorale / rows.length;
  const spread = max - min;
  const spreadPenalty = spread > 30 ? Math.min(18, (spread - 30) / 2) : 0;   // a split dressing room
  const harmony = Math.max(0, Math.min(100, Math.round(
    avg + Math.min(10, leadBonus * 2) - spreadPenalty - Math.min(25, disrupt * 6),
  )));
  const status = harmony >= 75 ? 'united' : harmony >= 55 ? 'settled' : harmony >= 35 ? 'restless' : 'fractured';
  players.sort((a, b) => SEVERITY[a.tag] - SEVERITY[b.tag] || a.slot - b.slot);
  return { harmony, status, avgMorale: Math.round(avg), players: players.slice(0, 6) };
}
