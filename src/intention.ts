import type { Player, Team } from './types';

export interface Perceived {
  ballInFOV: boolean;
  ballDist: number;
  ballIsLoose: boolean;
  ballControllerTeam: Team | null;
  ballControllerId: number | null;
  nearbyTeammates: Player[];
  nearbyOpponents: Player[];
  nearestOpponentDist: number;
  iAmController: boolean;
  amBeingMarked: boolean;
  amClosestToBall: boolean;
  chasingTeammatesCount: number;
  anyOpponentCloserToBall: boolean;
  lastDefenderX: number | null;
  nearestOppFwd: Player | null;
  zone: 'defensive' | 'middle' | 'attacking';
  ballZone: 'defensive' | 'middle' | 'attacking';
  spaceAhead: number;
}

export type Phase = 'settling' | 'playing' | 'chasing' | 'positioning';

export function zoneFromX(x: number): 'defensive' | 'middle' | 'attacking' {
  if (x < 350) return 'defensive';
  if (x < 700) return 'middle';
  return 'attacking';
}
