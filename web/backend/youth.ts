// Youth & retirement (pillar 5.3). At each season rollover, players past a retirement age
// leave the game (never below a legal XI), and every club brings through young prospects —
// raw now (low attrs) but with high potential to develop into. Closes the ageing loop so
// squads renew across seasons instead of greying out. Regens start with a neutral personality
// (so a flavourless default dial set) that the manager can flesh out via the story editor —
// which re-derives their training/value weights (the text↔dial coupling).
import { db } from './db.ts';
import { overall, genAttrs, genPotential, playerWage, type Role } from './game.ts';
import { removePlayerFromSquad, SQUAD_MAX, SQUAD_MIN } from './market.ts';
import { randomPlayerName } from './names.ts';
import { defaultPersonality } from './personality.ts';

const RETIRE_AGE = 37;          // a hard, deterministic cutoff (TASTE — FM is probabilistic)
const YOUTH_INTAKE = 2;         // prospects each club brings through per season
const YOUTH_ROLES: Role[] = ['GK', 'FB', 'CB', 'CM', 'WM', 'CF'];

const squadSize = (teamId: number) => (db.prepare('SELECT COUNT(*) AS n FROM players WHERE team_id = ?').get(teamId) as { n: number }).n;

export interface YouthEvent { teamId: number; type: 'retired' | 'intake'; player: string; age: number }

// Retire veterans + intake prospects for every club in a division. Call inside the rollover
// transaction (no tx of its own); run AFTER the contract tick so retirees leave the game
// rather than the free-agent pool.
export function youthAndRetirement(leagueId: number): YouthEvent[] {
  const events: YouthEvent[] = [];
  const ins = db.prepare('INSERT INTO players (team_id, slot, name, role, attrs, age, potential, personality, wage, contract_years) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 3)');
  for (const { id } of db.prepare('SELECT id FROM teams WHERE league_id = ?').all(leagueId) as { id: number }[]) {
    // 1. retirement — oldest first, but never below a legal XI (re-resolve slot by id as
    //    removePlayerFromSquad renumbers).
    const vets = db.prepare('SELECT id, name, age FROM players WHERE team_id = ? AND age >= ? ORDER BY age DESC, id').all(id, RETIRE_AGE) as { id: number; name: string; age: number }[];
    const canRetire = Math.max(0, squadSize(id) - SQUAD_MIN);
    for (const v of vets.slice(0, canRetire)) {
      const cur = db.prepare('SELECT slot FROM players WHERE id = ?').get(v.id) as { slot: number } | undefined;
      if (!cur) continue;
      removePlayerFromSquad(id, cur.slot);
      events.push({ teamId: id, type: 'retired', player: v.name, age: v.age });
    }
    // 2. youth intake — raw teenagers with upside, onto the bench, up to the squad cap.
    const intake = Math.max(0, Math.min(YOUTH_INTAKE, SQUAD_MAX - squadSize(id)));
    for (let i = 0; i < intake; i++) {
      const role = YOUTH_ROLES[Math.floor(Math.random() * YOUTH_ROLES.length)];
      const age = 16 + Math.floor(Math.random() * 3);                 // 16..18
      const attrs = genAttrs(role, 40 + Math.floor(Math.random() * 16));   // 40..55 raw
      const name = randomPlayerName();
      const per = defaultPersonality(name, role);
      const maxSlot = (db.prepare('SELECT COALESCE(MAX(slot), -1) AS m FROM players WHERE team_id = ?').get(id) as { m: number }).m;
      ins.run(id, maxSlot + 1, name, role, JSON.stringify(attrs), age, genPotential(overall(attrs), age), JSON.stringify(per), playerWage(attrs, age, per));
      events.push({ teamId: id, type: 'intake', player: name, age });
    }
  }
  return events;
}
