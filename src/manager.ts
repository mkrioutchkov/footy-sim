import type { ManagerConfig, Team, Formation } from './types';
import { FORMATIONS } from './types';
import { random } from './random';

export function createManager(team: Team, isHuman: boolean, formation?: Formation): ManagerConfig {
  return {
    team,
    isHuman,
    aggression: isHuman ? 50 : 40 + random() * 40,
    passingDirectness: isHuman ? 50 : 30 + random() * 40,
    overlapFrequency: isHuman ? 50 : 25 + random() * 60,
    midfieldFreedom: isHuman ? 50 : 30 + random() * 55,
    defensiveLineHeight: isHuman ? 50 : 25 + random() * 55,
    formation: formation ?? FORMATIONS[Math.floor(random() * FORMATIONS.length)],
  };
}
