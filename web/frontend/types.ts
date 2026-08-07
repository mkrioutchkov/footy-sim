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

// Wire-exact frame player (engine.cpp getJSON players[]). 2026-08 contract audit:
// homeX/homeY/attrs were REQUIRED here but the engine has never emitted them on a
// frame (formation anchors travel in the spec/lineup API, attrs never leave the
// engine) — deleted rather than marked optional; no TS consumer read them.
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
  stamina: number;
  tackleAnim: number;
  headingAnim: number;
  diveAnim: number;
  facing: number;
  dribbleType: number; // 0=none, 1=close, 2=medium, 3=fast/knock-forward
  goals?: number;
  assists?: number;
  shots?: number;
  tackles?: number;
  yellow?: number;
  passes?: number;           // pass attempts (rides on every frame; report.ts rating input)
  passesCompleted?: number;
  injured?: boolean;
  sentOff?: boolean;
  wall?: boolean;    // render-hint (Boris): this player is in the defensive FK wall — drives the wall highlight
  slide?: boolean;   // render-hint (Boris): a committed grounded slide tackle (tackleAnim>400) vs a standing poke
}

// Wire-exact frame ball (engine.cpp getJSON "ball"). 2026-08 contract audit: `vz`
// was REQUIRED here but the engine emits only z (height), never the vertical
// velocity — deleted; no TS consumer read it.
export interface Ball {
  x: number;
  y: number;
  vx: number;
  vy: number;
  z: number;
  curl?: number;   // render-hint (Boris): sideways curl/spin magnitude — drives the trail curl tint
  cutback?: boolean;   // render-hint (Boris): this ball is a cutback (pull-back into the box) — drives a distinct cutback trail cue. SHIPS on the wire (engine.cpp getJSON: pendingPass.active && isCutback) — an older note here said "pending serialization"; that landed.
  controllerId: number | null;
  intendedReceiverId: number | null;
  lastTouchTeam: Team | null;
  lastToucherId: number | null;
}

// One substitution, as emitted in every frame's `substitutionLog` (engine.cpp getJSON,
// engine commit 573675e). A sub is an IN-PLACE slot identity swap (engine_squad.cpp
// substituteSlot): the pitch slot keeps its id/role, only name/attrs/freshness change,
// and the slot's stat tally is zeroed for the arrival — so the departing man's line
// exists ONLY here, in the outGoals..outPassesCompleted snapshot taken the moment he
// came off. Any consumer that builds per-person stats (report.ts ratings) MUST fold
// these records in, and re-key any slot-id-keyed credit by who held the slot at the
// event's clockMs — the slot id alone survives the swap and silently transfers a
// starter's goals to his replacement. The log is CUMULATIVE (subs so far), so the
// final frame carries the whole match; the replay exporter joins it to the .bin
// trace's "sub" events on (clockMs, slotId).
export interface SubstitutionRecord {
  clockMs: number;
  slotId: number;             // the engine slot (0-21) whose identity changed
  team: Team;
  outName: string;            // the departing man (unrecoverable from any later frame)
  inName: string;             // the arrival — also the slot's `name` from this clockMs on
  outGoals: number;           // ── the departing man's tally at the moment he came off ──
  outAssists: number;
  outShots: number;
  outTackles: number;
  outPasses: number;
  outPassesCompleted: number;
  // Cards live in per-slot RUNTIME state, which the swap wipes, so they cannot ride in the
  // out* tally with the rest — hence the separate field (engine.h SubstitutionRecord). Absent
  // on recordings made before it landed; readers should treat a missing value as 0.
  outYellowCards?: number;
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
  // Team stats merged into every frame from the --summary stats object (engine.cpp
  // j.update(summary)) — declared here since report.ts reads them off the recorded
  // final frame (closes the CONTRACT.md "chip filed for Boris": these three rode the
  // wire untyped while homeShots/awayShots/possessionPct were already declared).
  shotsOnTarget: number;
  saves: number;
  cornersAwarded: number;
  // Whole-match-so-far substitution log (see SubstitutionRecord). Emitted on every
  // frame since engine 573675e; optional because recordings persisted before that
  // commit are storage-frozen without it (readers must degrade, not crash).
  substitutionLog?: SubstitutionRecord[];
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
  // On the wire this is a RAW int (engine.cpp emits setPiece.takerId unwrapped, unlike
  // controllerId): -1 = no taker assigned yet, never null. `null` stays in the type for
  // TS-side constructors; treat takerId == null || takerId < 0 as "no taker".
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
  // `punch` is NEVER emitted by the engine (2026-08 audit: the keeper punch ships as `gk_punch`,
  // engine_gk.cpp) — it stays in the union only because renderer.ts still branches on it
  // (accStatEvent's `type === 'punch'` / `case 'punch':` arms type-check against this union);
  // drop both together if the renderer arms are ever cleaned up.
  // `added_time` OVERLOADS the id fields (engine.cpp added-time announce): playerId = the
  // announced added MINUTES (1-5), targetId = the HALF (1|2) — neither is a player id. Any
  // consumer resolving playerId to a player must skip this type.
  type: 'pass' | 'shot' | 'tackle' | 'tackle_won' | 'tackle_loose' | 'takeon_lost' | 'chop' | 'foul' | 'offside' | 'intercept' | 'save' | 'claim' | 'tip' | 'goal' | 'header' | 'punch' | 'skill' | 'nutmeg' | 'dragback' | 'stepover' | 'roulette' | 'gk_punch' | 'block' | 'penalty' | 'yellow' | 'sub' | 'injury' | 'assist' | 'advantage' | 'red' | 'woodwork' | 'handball' | 'corner_short' | 'clearance' | 'added_time';
  x: number;
  y: number;
  age: number;
  playerId?: number | null;
  targetId?: number | null;
  // Round-30: the engine now publishes this on "goal" events. True when the last
  // toucher put it into his OWN net, i.e. the event's playerId belongs to the
  // CONCEDING side — every consumer that derives a team from playerId must flip.
  ownGoal?: boolean;
  // Round-31: "sub" events only. A substitution has two men but the pitch has ONE
  // slot, and the engine renames that slot in the same tick — so `playerId` always
  // resolves to the man ARRIVING and the outgoing man can only travel as a name.
  outName?: string;
  inName?: string;
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
