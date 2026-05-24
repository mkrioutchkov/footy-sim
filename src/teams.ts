import type { Player, Team, Formation } from './types';
import { PITCH_W, PITCH_H } from './constants';
import { randomInt, shuffle } from './random';

let nextId = 0;

export function resetIds(): void { nextId = 0; }

function rand(min: number, max: number): number {
  return randomInt(min, max);
}

function randomAttrs() {
  return {
    speed: rand(35, 90), passing: rand(35, 90), creativity: rand(35, 90),
    shooting: rand(35, 90), tackling: rand(35, 90), positioning: rand(35, 90), stamina: rand(60, 95),
  };
}

const NAMES = [
  'Silva', 'Müller', 'Park', 'Garcia', 'Ivanov', 'Chen', 'Okonkwo', 'Jensen',
  'Diallo', 'Kim', 'Santos', 'Rossi', 'Mbeki', 'Larsson', 'Tanaka', 'Ferreira',
  'Novak', 'Osei', 'Berg', 'Hernandez', 'Okafor', 'Andersen', 'Costa', 'Lee',
];

function shuffledNames(team: Team, count: number): string[] {
  const names = shuffle(NAMES);
  return names.slice(0, count).map((n, i) => `${n[0]}. ${n} (${team === 'home' ? 'H' : 'A'}${i + 1})`);
}

function roleHomePosition(role: string, idx: number, total: number, team: Team): { x: number; y: number } {
  const fd = team === 'home' ? 1 : -1;
  const flip = (normX: number) => fd === 1 ? normX * PITCH_W : PITCH_W - normX * PITCH_W;
  const spreadY = (i: number, n: number) => n === 1 ? PITCH_H / 2 : (PITCH_H / (n + 1)) * (i + 1);

  switch (role) {
    case 'GK': return { x: flip(0.03), y: PITCH_H / 2 };
    case 'CB': return { x: flip(0.18), y: spreadY(idx, total) };
    case 'FB': return { x: flip(0.15), y: idx === 0 ? PITCH_H * 0.12 : PITCH_H * 0.88 };
    case 'CM': return { x: flip(0.40), y: spreadY(idx, total) };
    case 'WM': return { x: flip(0.42), y: idx === 0 ? PITCH_H * 0.12 : PITCH_H * 0.88 };
    case 'CF': return { x: flip(0.72), y: spreadY(idx, total) };
    default: return { x: PITCH_W / 2, y: PITCH_H / 2 };
  }
}

export function createTeam(team: Team, formation: Formation): Player[] {
  const roleCounts = new Map<string, number>();
  for (const r of formation.roles) roleCounts.set(r, (roleCounts.get(r) ?? 0) + 1);

  const assigned = new Map<string, number>();
  const names = shuffledNames(team, formation.roles.length);

  return formation.roles.map((role, i) => {
    const idx = assigned.get(role) ?? 0;
    assigned.set(role, idx + 1);
    const total = roleCounts.get(role)!;
    const pos = roleHomePosition(role, idx, total, team);

    return {
      id: nextId++,
      name: names[i],
      team,
      role: role as Player['role'],
      x: pos.x, y: pos.y,
      vx: 0, vy: 0,
      targetX: pos.x, targetY: pos.y,
      homeX: pos.x, homeY: pos.y,
      stamina: 100,
      attrs: randomAttrs(),
      tackleAnim: 0,
      headingAnim: 0,
      facing: team === 'home' ? 0 : Math.PI,
    };
  });
}
