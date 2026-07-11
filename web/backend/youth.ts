// Youth & retirement (pillar 5.3 + audit §2.9 academy). At each season rollover, players past a
// retirement age leave the game (never below a legal XI), and every club brings through young prospects.
//
// §2.9: a HUMAN club's prospects now land in a visible ACADEMY (youth_prospects) that develops them each
// season — the manager PROMOTES the ones he wants into the senior squad — instead of 2 raw regens silently
// appearing in the squad. AI clubs keep the auto-intake-to-squad path, so the AI world still renews itself.
// Regens carry a neutral personality the manager can flesh out via the story editor (the text↔dial coupling).
import { db } from './db.ts';
import { overall, genAttrs, genPotential, playerWage, genFoot, type EngineRole } from './game.ts';
import { removePlayerFromSquad, SQUAD_MAX, SQUAD_MIN } from './market.ts';
import { developAttrs } from './training.ts';
import { randomPlayerName } from './names.ts';
import { defaultPersonality } from './personality.ts';

const RETIRE_AGE = 37;          // a hard, deterministic cutoff (TASTE — FM is probabilistic)
const YOUTH_INTAKE = 2;         // prospects each club brings through per season
const ACADEMY_LEAVE_AGE = 21;   // a prospect not promoted by this age graduates out of the academy
const YOUTH_ROLES: EngineRole[] = ['GK', 'FB', 'CB', 'CM', 'WM', 'CF'];

const squadSize = (teamId: number) => (db.prepare('SELECT COUNT(*) AS n FROM players WHERE team_id = ?').get(teamId) as { n: number }).n;
const parseJSON = (s: string | null): unknown => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

export interface YouthEvent { teamId: number; type: 'retired' | 'intake'; player: string; age: number }

// Generate one raw prospect into a club's academy; returns his name + age for the event feed.
function newProspect(teamId: number): { name: string; age: number } {
  const role = YOUTH_ROLES[Math.floor(Math.random() * YOUTH_ROLES.length)];
  const age = 15 + Math.floor(Math.random() * 4);                       // 15..18
  const attrs = genAttrs(role, 38 + Math.floor(Math.random() * 16));    // 38..53 raw
  const name = randomPlayerName();
  const per = defaultPersonality(name, role);
  db.prepare('INSERT INTO youth_prospects (team_id, name, role, attrs, age, potential, personality, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(teamId, name, role, JSON.stringify(attrs), age, genPotential(overall(attrs, role), age), JSON.stringify(per), Date.now());
  return { name, age };
}

// Seed a fresh academy (team creation). Idempotent-ish: only tops up to `n` so a re-call can't flood it.
export function seedAcademy(teamId: number, n = 4): void {
  const have = (db.prepare('SELECT COUNT(*) AS c FROM youth_prospects WHERE team_id = ?').get(teamId) as { c: number }).c;
  for (let i = have; i < n; i++) newProspect(teamId);
}

// Develop the academy a season: each prospect ages + drifts toward potential (the same dev curve as the
// senior squad), and any who pass ACADEMY_LEAVE_AGE without being promoted graduate out (leave the club).
function academyTick(teamId: number): void {
  const rows = db.prepare('SELECT id, role, attrs, age, potential, personality FROM youth_prospects WHERE team_id = ?')
    .all(teamId) as { id: number; role: string; attrs: string; age: number; potential: number | null; personality: string | null }[];
  const upd = db.prepare('UPDATE youth_prospects SET attrs = ?, age = ? WHERE id = ?');
  const del = db.prepare('DELETE FROM youth_prospects WHERE id = ?');
  for (const p of rows) {
    const age = p.age + 1;
    if (age >= ACADEMY_LEAVE_AGE) { del.run(p.id); continue; }
    const traits = (parseJSON(p.personality) as { traits?: { professionalism?: number; consistency?: number } } | null)?.traits ?? null;
    const attrs = developAttrs(JSON.parse(p.attrs), age, p.potential ?? overall(JSON.parse(p.attrs), p.role), traits, 'balanced', 65, 1, 1, p.role);
    upd.run(JSON.stringify(attrs), age, p.id);
  }
}

// Retire veterans + bring prospects through for every club in a division. Call inside the rollover
// transaction (no tx of its own); run AFTER the contract tick so retirees leave the game, not the FA pool.
export function youthAndRetirement(leagueId: number): YouthEvent[] {
  const events: YouthEvent[] = [];
  const insSquad = db.prepare('INSERT INTO players (team_id, slot, name, role, attrs, age, potential, personality, wage, contract_years, foot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 3, ?)');
  for (const t of db.prepare('SELECT id, user_id FROM teams WHERE league_id = ?').all(leagueId) as { id: number; user_id: number | null }[]) {
    const id = t.id;
    // 1. retirement — oldest first, but never below a legal XI (re-resolve slot by id as removePlayerFromSquad renumbers).
    const vets = db.prepare('SELECT id, name, age FROM players WHERE team_id = ? AND age >= ? ORDER BY age DESC, id').all(id, RETIRE_AGE) as { id: number; name: string; age: number }[];
    const canRetire = Math.max(0, squadSize(id) - SQUAD_MIN);
    for (const v of vets.slice(0, canRetire)) {
      const cur = db.prepare('SELECT slot FROM players WHERE id = ?').get(v.id) as { slot: number } | undefined;
      if (!cur) continue;
      removePlayerFromSquad(id, cur.slot);
      events.push({ teamId: id, type: 'retired', player: v.name, age: v.age });
    }
    // 2. youth intake. HUMAN clubs: develop the academy + add new prospects there (the manager promotes them).
    //    AI clubs: drop raw teenagers straight onto the bench, up to the squad cap (keeps the AI world renewing).
    if (t.user_id != null) {
      academyTick(id);
      for (let i = 0; i < YOUTH_INTAKE; i++) { const p = newProspect(id); events.push({ teamId: id, type: 'intake', player: p.name, age: p.age }); }
    } else {
      const intake = Math.max(0, Math.min(YOUTH_INTAKE, SQUAD_MAX - squadSize(id)));
      for (let i = 0; i < intake; i++) {
        const role = YOUTH_ROLES[Math.floor(Math.random() * YOUTH_ROLES.length)];
        const age = 16 + Math.floor(Math.random() * 3);                 // 16..18
        const attrs = genAttrs(role, 40 + Math.floor(Math.random() * 16));   // 40..55 raw
        const name = randomPlayerName();
        const per = defaultPersonality(name, role);
        const maxSlot = (db.prepare('SELECT COALESCE(MAX(slot), -1) AS m FROM players WHERE team_id = ?').get(id) as { m: number }).m;
        insSquad.run(id, maxSlot + 1, name, role, JSON.stringify(attrs), age, genPotential(overall(attrs, role), age), JSON.stringify(per), playerWage(attrs, age, per, role), genFoot());
        events.push({ teamId: id, type: 'intake', player: name, age });
      }
    }
  }
  return events;
}

export interface AcademyProspect { id: number; name: string; role: string; age: number; overall: number; potential: number | null; attrs: Record<string, number>; }
// A club's academy prospects — most promising first.
export function getAcademy(teamId: number): AcademyProspect[] {
  return (db.prepare('SELECT id, name, role, attrs, age, potential FROM youth_prospects WHERE team_id = ? ORDER BY potential DESC, id')
    .all(teamId) as { id: number; name: string; role: string; attrs: string; age: number; potential: number | null }[])
    .map(p => ({ id: p.id, name: p.name, role: p.role, age: p.age, overall: overall(JSON.parse(p.attrs), p.role), potential: p.potential, attrs: JSON.parse(p.attrs) }));
}

// Promote a prospect to the senior squad (onto the bench), if there's room under the squad cap.
export function promoteProspect(teamId: number, prospectId: number): { ok: boolean; error?: string; player?: string } {
  const p = db.prepare('SELECT name, role, attrs, age, potential, personality FROM youth_prospects WHERE id = ? AND team_id = ?')
    .get(prospectId, teamId) as { name: string; role: string; attrs: string; age: number; potential: number | null; personality: string | null } | undefined;
  if (!p) return { ok: false, error: 'no such prospect in your academy' };
  if (squadSize(teamId) >= SQUAD_MAX) return { ok: false, error: `squad full (max ${SQUAD_MAX}) — sell or release first` };
  const maxSlot = (db.prepare('SELECT COALESCE(MAX(slot), -1) AS m FROM players WHERE team_id = ?').get(teamId) as { m: number }).m;
  db.prepare('INSERT INTO players (team_id, slot, name, role, attrs, age, potential, personality, wage, contract_years, foot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 3, ?)')
    .run(teamId, maxSlot + 1, p.name, p.role, p.attrs, p.age, p.potential, p.personality, playerWage(JSON.parse(p.attrs), p.age, parseJSON(p.personality)), genFoot());
  db.prepare('DELETE FROM youth_prospects WHERE id = ?').run(prospectId);
  return { ok: true, player: p.name };
}
