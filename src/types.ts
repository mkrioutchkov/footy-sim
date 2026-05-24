export interface PlayerAttributes {
  speed: number;
  passing: number;
  creativity: number;
  shooting: number;
  tackling: number;
  positioning: number;
  stamina: number;
}

export type PlayerRole = 'GK' | 'CB' | 'FB' | 'CM' | 'WM' | 'CF';
export type Team = 'home' | 'away';
export type MatchState = 'not_started' | 'running' | 'paused' | 'finished';
export type TacticalPhase = 'loose_ball' | 'possession' | 'attacking_transition' | 'defending' | 'defensive_transition';

export interface Player {
  id: number;
  name: string;
  team: Team;
  role: PlayerRole;
  x: number;
  y: number;
  vx: number;
  vy: number;
  targetX: number;
  targetY: number;
  homeX: number;
  homeY: number;
  stamina: number;
  attrs: PlayerAttributes;
  tackleAnim: number;
  headingAnim: number;
}

export interface Ball {
  x: number;
  y: number;
  vx: number;
  vy: number;
  z: number;
  vz: number;
  controllerId: number | null;
  intendedReceiverId: number | null;
  lastTouchTeam: Team | null;
  lastToucherId: number | null;
}

export interface EngineState {
  players: Player[];
  ball: Ball;
  clockMs: number;
  matchState: MatchState;
  speed: number;
  homeScore: number;
  awayScore: number;
  events: MatchEvent[];
  homeShots: number;
  awayShots: number;
  possessionPct: number;
  half: number;
}

export interface MatchEvent {
  type: 'pass' | 'shot' | 'tackle' | 'intercept' | 'save' | 'goal' | 'header';
  x: number;
  y: number;
  age: number;
}

export interface Formation {
  name: string;
  roles: PlayerRole[];
}

export interface ManagerConfig {
  team: Team;
  isHuman: boolean;
  aggression: number;
  passingDirectness: number;
  overlapFrequency: number;
  midfieldFreedom: number;
  defensiveLineHeight: number;
  formation: Formation;
}

export interface TeamAssignment {
  team: Team;
  role: TeamAssignmentRole;
  playerId: number;
  targetX: number;
  targetY: number;
  opponentId?: number;
  score?: number;
}

export type TeamAssignmentRole =
  | 'primary_press'
  | 'secondary_press'
  | 'cover'
  | 'lane_block'
  | 'defensive_line'
  | 'wide_cover'
  | 'midfield_screen'
  | 'support_outlet'
  | 'advance_midfield'
  | 'run_ahead'
  | 'hold_width'
  | 'overlap'
  | 'rest_defence';

export interface DebugLogEntry {
  seq: number;
  t: number;
  half: number;
  kind: string;
  data: Record<string, unknown>;
}

export interface TeamBlackboard {
  pressingPlayerId: number | null;
  pressingPlayerId2: number | null;
  markedOpponents: Map<number, number>;
  activeRuns: { playerId: number; targetX: number; targetY: number }[];
  zoneClaims: { playerId: number; minY: number; maxY: number }[];
  passPairCount: Map<string, number>;
  oneTwo: { from: number; to: number; expires: number } | null;
}

export interface DebugLogBatch {
  sessionId: string;
  startedAt: string;
  entries: DebugLogEntry[];
  lastSeq: number;
}

export const FORMATIONS: Formation[] = [
  {
    name: '4-4-2',
    roles: ['GK', 'FB', 'CB', 'CB', 'FB', 'WM', 'CM', 'CM', 'WM', 'CF', 'CF'],
  },
  {
    name: '4-3-3',
    roles: ['GK', 'FB', 'CB', 'CB', 'FB', 'CM', 'CM', 'CM', 'WM', 'CF', 'WM'],
  },
  {
    name: '5-3-2',
    roles: ['GK', 'FB', 'CB', 'CB', 'CB', 'FB', 'CM', 'CM', 'CM', 'CF', 'CF'],
  },
];
