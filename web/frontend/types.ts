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
  diveAnim: number;
  facing: number;
  crossCollected: number;
  dribbleType: number;
  goals?: number;
  assists?: number;
  shots?: number;
  tackles?: number;
  yellow?: number;
  injured?: boolean;
  sentOff?: boolean; // 0=none, 1=close, 2=medium, 3=fast/knock-forward
  wall?: boolean;    // render-hint (Boris): this player is in the defensive FK wall — drives the wall highlight
  slide?: boolean;   // render-hint (Boris): a committed grounded slide tackle (tackleAnim>400) vs a standing poke
}

export interface Ball {
  x: number;
  y: number;
  vx: number;
  vy: number;
  z: number;
  vz: number;
  curl?: number;   // render-hint (Boris): sideways curl/spin magnitude — drives the trail curl tint
  cutback?: boolean;   // render-hint (Boris, pending serialization): this ball is a cutback (pull-back into the box) — drives a distinct cutback trail cue
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
  addedTime: boolean;
  addedTimeAnnouncedMin?: number;
  version: string;
  seed?: number;
  setPieceState?: SetPieceState;
  // Team display names — injected into each streamed frame by the web backend (the raw engine
  // emits ids); the renderer's HUD reads them. Optional so a raw engine frame still type-checks.
  homeName?: string;
  awayName?: string;
}

export interface SetPieceState {
  type: 'free_kick' | 'penalty' | 'throw_in' | 'corner' | 'goal_kick' | string;
  reason?: 'offside' | 'free_kick' | 'penalty' | 'throw_in' | 'corner' | 'goal_kick' | string;
  team: Team;
  takerId: number | null;
  takerArrived: boolean;
  spotX: number;
  spotY: number;
  timerMs: number;
}

export interface MatchEvent {
  // NB: the string set is the wire contract with the engine — the C++ trace/WS emitter writes these
  // exact `type` names and the renderer keys its animations off them. `stepover` / `roulette` / `gk_punch`
  // are wired ahead of the engine commit that emits them; an unknown type degrades to the generic ring.
  type: 'pass' | 'shot' | 'tackle' | 'tackle_won' | 'tackle_loose' | 'takeon_lost' | 'chop' | 'foul' | 'offside' | 'intercept' | 'save' | 'claim' | 'tip' | 'goal' | 'header' | 'punch' | 'skill' | 'nutmeg' | 'dragback' | 'stepover' | 'roulette' | 'gk_punch' | 'block' | 'penalty' | 'yellow' | 'sub' | 'injury' | 'assist' | 'advantage' | 'red' | 'woodwork' | 'handball' | 'corner_short' | 'clearance';
  x: number;
  y: number;
  age: number;
  playerId?: number | null;
  targetId?: number | null;
  // Round-30: the engine now publishes this on "goal" events. True when the last
  // toucher put it into his OWN net, i.e. the event's playerId belongs to the
  // CONCEDING side — every consumer that derives a team from playerId must flip.
  ownGoal?: boolean;
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
  | 'inside_run'
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
