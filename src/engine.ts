import type {
  Player, Ball, MatchState, EngineState, ManagerConfig, Team, MatchEvent,
  TeamAssignment, TeamBlackboard, DebugLogEntry, DebugLogBatch, TeamAssignmentRole, TacticalPhase, PlayerRole,
} from './types';
import {
  PITCH_W, PITCH_H, HOME_GOAL_X, AWAY_GOAL_X, HALF_X,
  MATCH_DURATION_MS, MAX_PLAYER_SPEED, SPEED_SPRINT,
  PLAYER_R,
  SEPARATION_DIST, SEPARATION_FORCE,
  GK_RUSH_DIST,
  DRIBBLE_MAX,
  CONTROL_DIST,
  BALL_FRICTION,
  PASS_SPEED_BASE, PASS_SPEED_DIST, SHOT_SPEED_BASE, TACKLE_KICK_SPEED,
  clamp, dist, lerp, attrFactor,
  PENALTY_AREA_W, PENALTY_AREA_H,
} from './constants';
import { PlayerAgent } from './agent';
import { random } from './random';

const GOAL_W = 73;
const FIXED_DT = 16.667;
const MAX_FRAME_DELTA_MS = 34;
const MAX_STEPS_PER_FRAME = 3;
const GRID_CELL = 150;
const GRID_COLS = Math.ceil(PITCH_W / GRID_CELL);
const GRID_ROWS = Math.ceil(PITCH_H / GRID_CELL);
const DEBUG_LOG_MAX = 1200;
const COORDINATOR_LOG_INTERVAL = 1000;
const STUCK_LOG_INTERVAL = 1200;
const STATE_SAMPLE_LOG_INTERVAL = 500;

export type { EngineState } from './types';

export interface AnalysisSummary {
  clockMs: number;
  score: { home: number; away: number };
  passes: { attempted: number; completed: number; intercepted: number; offsides: number; completionPct: number };
  shots: { home: number; away: number; onTarget: number; offTarget: number; saved: number; onTargetPct: number; conversionPct: number };
  throughBalls: { attempted: number; completed: number; completionPct: number };
  possessionPct: { home: number; away: number };
  territoryPct: { homeDef: number; mid: number; awayDef: number };
  qualityFlags: Record<string, number>;
  passByRole: Record<string, { att: number; comp: number; pct: number }>;
  setPieces: { corners: number; throwIns: number; freeKicks: number };
  crosses: { attempted: number; completed: number };
  headers: { total: number; won: number };
  bounces: number;
  flankTime: { left: number; mid: number; right: number };
  phaseTicks: Record<Team, Record<TacticalPhase, number>>;
  taskSelections: Record<string, number>;
  possessionByRole: Partial<Record<PlayerRole, number>>;
}

export class GameEngine {
  players: Player[];
  ball: Ball;
  clockMs = 0;
  matchState: MatchState = 'not_started';
  speed = 1;
  homeScore = 0;
  awayScore = 0;
  recentEvents: MatchEvent[] = [];
  state: EngineState;

  homeConfig: ManagerConfig;
  awayConfig: ManagerConfig;

  private actionTimer = 0;
  private setPieceType: 'goal_kick' | 'corner' | 'throw_in' = 'throw_in';
  private setPieceTeam: Team = 'home';
  private setPieceArmed = false;
  private setPieceTakerId: number | null = null;
  private cornerCrossPending = false;
  private cornerCrossTaker: number | null = null;
  private kickoffPhase = false;
  private gkDistributeTimer = 0;
  private receiverShieldUntil = 0;
  private receiverShieldTargetId: number | null = null;
  private accumulator = 0;
  private half = 1;
  private halfTimePause = 0;
  private nextKickoffTeam: Team = 'home';
  private lastSaveMs = 0;
  private reboundBlockedId: number | null = null;
  private reboundBlockTimer = 0;
  private assignmentByPlayer: Map<number, TeamAssignment> = new Map();
  teamBlackboards: Map<Team, TeamBlackboard> = new Map();
  private debugLog: DebugLogEntry[] = [];
  private debugSeq = 0;
  private debugSessionId = 'not_started';
  private debugStartedAt = '';
  private lastAssignmentLog = 0;
  private lastStuckLog = 0;
  private lastStateSampleLog = 0;

  // expanded stats
  private statsCrossAttempted = 0; private statsCrossCompleted = 0;
  private statsHeadersWon = 0; private statsHeadersTotal = 0;
  private statsCornersTaken = 0; private statsCornersToShot = 0;
  private statsThrowInsTaken = 0; private statsThrowInsRetained = 0;
  private statsBouncesNoControl = 0;
  private statsFlankTime: Record<string, number> = { left: 0, right: 0, center: 0 };
  private statsPossessionTime: Map<number, number> = new Map();
  private statsPhaseTime: Record<string, number> = {};
  private statsFreeKicks = 0;
  private statsPlayerUncontestedMs: Map<number, number> = new Map();

  // distance tracking (meters, assuming 10px = 1m pitch scale)
  private ballDistance = 0;
  private playerDistances: Map<number, number> = new Map();
  private prevBallX = 0;
  private prevBallY = 0;
  private prevBallTick = 0; // for teleport detection
  private prevPlayerPositions: Map<number, { x: number; y: number }> = new Map();
  private lastDistanceLog = 0;

  // match stats tracking
  private statsPossession: Record<string, number> = { home: 0, away: 0 };
  private statsPassAttempted = 0; private statsPassCompleted = 0; private statsPassIntercepted = 0;
  private statsThroughBallAttempted = 0; private statsThroughBallCompleted = 0;
  private statsOffsides = 0;
  private statsShotsOnTarget = 0; private statsShotsOffTarget = 0; private statsSaves = 0;
  private statsBallInThird: Record<string, number> = { homeDef: 0, mid: 0, awayDef: 0 };
  private isShotActive = false;

  // simulation quality tracking
  private qBallUnclaimedSince = 0;
  private qPossessionChanges: number[] = [];
  private qLastControllerId: number | null = null;
  private qLastPossessionTeam: Team | null = null;
  private qLastPossessionTeamChange = 0;
  private qPlayerLastMoved: Map<number, { x: number; y: number; stuckSince: number }> = new Map();
  private qOutOfPlayEvents: number[] = [];
  private qBallPrevSpeed = 0;
  private qLastBallImpulseMs = -Infinity;
  private qTackleAttempts: number[] = []; private qTackleSuccesses: number[] = [];
  private qPassAttempts: number[] = []; private qPassFails: number[] = [];
  private qRecentPassPairs: { pair: string; t: number }[] = [];
  private pendingPass: { fromId: number; team: Team; toId: number; source: string } | null = null;
  private qConsecutiveSaves = 0;
  private qLastShotMs = 0;
  private qLastPassFrom = 0; private qLastPassRecipient = 0; private qLastPassRecipientMs = 0;
  private statsPassByRole: Record<string, { att: number; comp: number }> = {};
  private statsShotsByZone: Record<string, number> = {}; // shot locations binned
  private qShotOrigin: { team: Team; x: number; y: number } | null = null;
  private qBounceOnSamePlayer = 0; private qLastBouncePlayer: number | null = null;
  private qBallThird: 'homeDef' | 'mid' | 'awayDef' | null = null;
  private qBallThirdSince = 0;
  private qLastQualityCheck = 0;
  private qFlagLastLogged: Map<string, number> = new Map();
  private qualityFlagCounts: Map<string, number> = new Map();
  private transitionUntil: Record<Team, number> = { home: 0, away: 0 };
  private phaseTicks: Record<Team, Record<TacticalPhase, number>> = {
    home: { loose_ball: 0, possession: 0, attacking_transition: 0, defending: 0, defensive_transition: 0 },
    away: { loose_ball: 0, possession: 0, attacking_transition: 0, defending: 0, defensive_transition: 0 },
  };
  private taskSelections: Map<string, number> = new Map();
  private possessionByRole: Partial<Record<PlayerRole, number>> = {};
  private carrierWatchId: number | null = null;
  private carrierWatchMs = 0;
  private carrierWatchX = 0;
  private carrierWatchY = 0;

  homeShots = 0; awayShots = 0;
  homeTackles = 0; awayTackles = 0;
  private possessionHome = 0;
  private possessionAway = 0;

  playersByTeam: Map<Team, Player[]> = new Map();
  gkByTeam: Map<Team, Player> = new Map();
  private agents: Map<number, PlayerAgent> = new Map();

  private grid: number[][] = [];
  private gridPlayers: Map<number, number> = new Map();

  constructor(players: Player[], homeConfig: ManagerConfig, awayConfig: ManagerConfig) {
    this.players = players;
    this.homeConfig = homeConfig;
    this.awayConfig = awayConfig;

    for (const p of this.players) {
      if (!this.playersByTeam.has(p.team)) this.playersByTeam.set(p.team, []);
      this.playersByTeam.get(p.team)!.push(p);
      if (p.role === 'GK') this.gkByTeam.set(p.team, p);
      this.agents.set(p.id, new PlayerAgent(p, this));
    }

    for (const t of ['home', 'away'] as Team[]) {
      this.teamBlackboards.set(t, { pressingPlayerId: null, pressingPlayerId2: null, markedOpponents: new Map(), activeRuns: [], zoneClaims: [], passPairCount: new Map(), oneTwo: null });
    }

    this.ball = {
      x: HALF_X, y: PITCH_H / 2,
      vx: 0, vy: 0, z: 0, vz: 0,
      controllerId: null, intendedReceiverId: null,
      lastTouchTeam: null, lastToucherId: null,
    };

    this.state = {
      players: this.players,
      ball: this.ball,
      clockMs: 0, matchState: 'not_started', speed: 1,
      homeScore: 0, awayScore: 0,
      events: this.recentEvents,
      homeShots: 0, awayShots: 0, possessionPct: 50, half: 1,
    };
  }

  getState(): EngineState { return this.state; }

  emitEvent(type: MatchEvent['type'], x: number, y: number): void {
    this.recentEvents.push({ type, x, y, age: 0 });
    if (this.recentEvents.length > 20) this.recentEvents.shift();
    this.logDebug(type, {
      x: Math.round(x), y: Math.round(y),
      controller: this.ball.controllerId,
      lastTouch: this.ball.lastToucherId,
      lastTeam: this.ball.lastTouchTeam,
    });
  }

  assignmentFor(playerId: number): TeamAssignment | undefined {
    return this.assignmentByPlayer.get(playerId);
  }

  getDebugLogText(): string {
    const latest = this.debugLog.slice(-DEBUG_LOG_MAX);
    return latest.map(e => JSON.stringify(e)).join('\n');
  }

  getDebugLogBatch(afterSeq: number): DebugLogBatch {
    const entries = this.debugLog.filter(e => e.seq > afterSeq);
    return {
      sessionId: this.debugSessionId,
      startedAt: this.debugStartedAt,
      lastSeq: entries.length > 0 ? entries[entries.length - 1].seq : afterSeq,
      entries,
    };
  }

  getAnalysisSummary(): AnalysisSummary {
    const totalPossession = Math.max(1, this.statsPossession.home + this.statsPossession.away);
    const totalTerritory = Math.max(1, Object.values(this.statsBallInThird).reduce((a, b) => a + b, 0));
    const totalShots = this.homeShots + this.awayShots;
    return {
      clockMs: Math.round(this.clockMs),
      score: { home: this.homeScore, away: this.awayScore },
      passes: {
        attempted: this.statsPassAttempted,
        completed: this.statsPassCompleted,
        intercepted: this.statsPassIntercepted,
        offsides: this.statsOffsides,
        completionPct: Math.round(this.statsPassCompleted / Math.max(1, this.statsPassAttempted) * 1000) / 10,
      },
      shots: {
        home: this.homeShots,
        away: this.awayShots,
        onTarget: this.statsShotsOnTarget,
        offTarget: this.statsShotsOffTarget,
        saved: this.statsSaves,
        onTargetPct: Math.round(this.statsShotsOnTarget / Math.max(1, totalShots) * 1000) / 10,
        conversionPct: Math.round((this.homeScore + this.awayScore) / Math.max(1, totalShots) * 1000) / 10,
      },
      throughBalls: {
        attempted: this.statsThroughBallAttempted,
        completed: this.statsThroughBallCompleted,
        completionPct: Math.round(this.statsThroughBallCompleted / Math.max(1, this.statsThroughBallAttempted) * 1000) / 10,
      },
      possessionPct: {
        home: Math.round(this.statsPossession.home / totalPossession * 1000) / 10,
        away: Math.round(this.statsPossession.away / totalPossession * 1000) / 10,
      },
      territoryPct: {
        homeDef: Math.round(this.statsBallInThird.homeDef / totalTerritory * 1000) / 10,
        mid: Math.round(this.statsBallInThird.mid / totalTerritory * 1000) / 10,
        awayDef: Math.round(this.statsBallInThird.awayDef / totalTerritory * 1000) / 10,
      },
      qualityFlags: Object.fromEntries(this.qualityFlagCounts),
      passByRole: Object.fromEntries(Object.entries(this.statsPassByRole).map(([role, s]) => [role, { ...s, pct: Math.round(s.comp / Math.max(1, s.att) * 1000) / 10 }])),
      setPieces: { corners: this.statsCornersTaken, throwIns: this.statsThrowInsTaken, freeKicks: this.statsFreeKicks },
      crosses: { attempted: this.statsCrossAttempted, completed: this.statsCrossCompleted },
      headers: { total: this.statsHeadersTotal, won: this.statsHeadersWon },
      bounces: this.statsBouncesNoControl,
      flankTime: { left: Math.round(this.statsFlankTime.left / Math.max(1, this.statsFlankTime.left + this.statsFlankTime.center + this.statsFlankTime.right) * 1000) / 10, mid: Math.round(this.statsFlankTime.center / Math.max(1, this.statsFlankTime.left + this.statsFlankTime.center + this.statsFlankTime.right) * 1000) / 10, right: Math.round(this.statsFlankTime.right / Math.max(1, this.statsFlankTime.left + this.statsFlankTime.center + this.statsFlankTime.right) * 1000) / 10 },
      phaseTicks: { home: { ...this.phaseTicks.home }, away: { ...this.phaseTicks.away } },
      taskSelections: Object.fromEntries(this.taskSelections),
      possessionByRole: { ...this.possessionByRole },
    };
  }

  teamPhaseFor(team: Team): TacticalPhase {
    const possessingTeam = this.teamInPossession();
    if (!possessingTeam) return 'loose_ball';
    if (possessingTeam === team) return this.clockMs < this.transitionUntil[team] ? 'attacking_transition' : 'possession';
    return this.clockMs < this.transitionUntil[team] ? 'defensive_transition' : 'defending';
  }

  noteTaskSelection(player: Player, task: TeamAssignmentRole): void {
    const key = `${player.team}:${player.role}:${task}`;
    this.taskSelections.set(key, (this.taskSelections.get(key) ?? 0) + 1);
  }

  isOffsideTarget(passer: Player, receiver: Player): boolean {
    return this.checkOffside(receiver, passer);
  }

  offsideLineFor(team: Team): number | null {
    const fd = team === 'home' ? 1 : -1;
    const defenders = this.players.filter(p => p.team !== team);
    if (defenders.length < 2) return null;
    defenders.sort((a, b) => fd === 1 ? b.x - a.x : a.x - b.x);
    return defenders[1].x;
  }

  private logDebug(kind: string, data: DebugLogEntry['data']): void {
    this.debugLog.push({ seq: ++this.debugSeq, t: Math.round(this.clockMs), half: this.half, kind, data });
    if (this.debugLog.length > DEBUG_LOG_MAX) {
      this.debugLog.splice(0, this.debugLog.length - DEBUG_LOG_MAX);
    }
  }

  logPlayerDecision(playerId: number, action: string, score: number, topScores: { type: string; score: number }[], x: number, y: number, purpose?: string): void {
    this.logDebug('player_decision', {
      player: playerId, role: this.playerById(playerId)?.role ?? '?', team: this.playerById(playerId)?.team ?? '?',
      action, score: Math.round(score * 1000) / 1000,
      top: topScores.slice(0, 3).map(s => `${s.type}:${Math.round(s.score * 1000) / 1000}`).join('|'),
      x: Math.round(x), y: Math.round(y),
      ...(purpose ? { purpose } : {}),
    });
  }

  private logQualityFlag(flag: string, data: DebugLogEntry['data'], cooldownMs = 10000, key = flag): void {
    const last = this.qFlagLastLogged.get(key) ?? -Infinity;
    if (this.clockMs - last < cooldownMs) return;
    this.qFlagLastLogged.set(key, this.clockMs);
    this.qualityFlagCounts.set(flag, (this.qualityFlagCounts.get(flag) ?? 0) + 1);
    this.logDebug('q_flag', { flag, ...data });
  }

  private recordControlChange(collector: Player): void {
    if (this.qLastControllerId !== collector.id) {
      if (this.qLastControllerId !== null) this.qPossessionChanges.push(this.clockMs);
      this.qLastControllerId = collector.id;
    }
    if (this.qLastPossessionTeam !== collector.team) {
      const previousTeam = this.qLastPossessionTeam;
      if (previousTeam !== null) {
        this.transitionUntil[collector.team] = this.clockMs + 2500;
        this.transitionUntil[previousTeam] = this.clockMs + 2500;
        this.logDebug('transition', { wonBy: collector.team, lostBy: previousTeam, player: collector.id, x: Math.round(collector.x), y: Math.round(collector.y) });
      }
      this.qLastPossessionTeam = collector.team;
      this.qLastPossessionTeamChange = this.clockMs;
    }
  }

  private recordOutOfPlay(): void {
    this.qOutOfPlayEvents.push(this.clockMs);
    this.qOutOfPlayEvents = this.qOutOfPlayEvents.filter(t => t >= this.clockMs - 30000);
    if (this.qOutOfPlayEvents.length >= 5) {
      this.logQualityFlag('frequent_out_of_play', { count: this.qOutOfPlayEvents.length, windowMs: 30000 });
    }
  }

  private recordPassAttempt(from: Player, to: Player): void {
    this.qPassAttempts.push(this.clockMs);
    const pair = [from.id, to.id].sort((a, b) => a - b).join(':');
    this.qRecentPassPairs.push({ pair, t: this.clockMs });
    this.qRecentPassPairs = this.qRecentPassPairs.filter(p => p.t >= this.clockMs - 15000);
    const pairCount = this.qRecentPassPairs.filter(p => p.pair === pair).length;
    if (pairCount >= 6) {
      this.logQualityFlag('repeated_pass_pair', { pair, count: pairCount, windowMs: 15000 }, 15000, `repeated_pass_pair:${pair}`);
    }
  }

  private recordPassFailure(): void {
    this.qPassFails.push(this.clockMs);
  }

  private beginTrackedPass(from: Player, to: Player, source = 'open_play'): void {
    this.statsPassAttempted++;
    if (source === 'through_ball') this.statsThroughBallAttempted++;
    this.recordPassAttempt(from, to);
    this.pendingPass = { fromId: from.id, team: from.team, toId: to.id, source };
    this.qLastPassFrom = from.id; this.qLastPassRecipient = to.id; this.qLastPassRecipientMs = this.clockMs;
    this.logDebug('pass_attempt', { from: from.id, to: to.id, team: from.team, source });
  }

  private failPendingPass(reason: string): void {
    if (!this.pendingPass) return;
    this.recordPassFailure();
    this.logDebug('pass_fail', { reason, from: this.pendingPass.fromId, intended: this.pendingPass.toId });
    this.pendingPass = null;
  }

  private recordBounce(playerId: number): void {
    if (this.qLastBouncePlayer === playerId) this.qBounceOnSamePlayer++;
    else { this.qLastBouncePlayer = playerId; this.qBounceOnSamePlayer = 1; }
    if (this.qBounceOnSamePlayer >= 4) {
      this.logQualityFlag('ball_pinball_same_player', { player: playerId, count: this.qBounceOnSamePlayer }, 5000, `ball_pinball_same_player:${playerId}`);
    }
  }

  private recordBallImpulse(): void {
    this.qLastBallImpulseMs = this.clockMs;
  }

  private beginDebugSession(): void {
    this.debugSeq = 0;
    this.debugLog = [];
    const startedAt = new Date().toISOString();
    const stamp = startedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    this.debugSessionId = `game_${stamp}_${random().toString(36).slice(2, 8)}`;
    this.debugStartedAt = startedAt;
    this.logDebug('session_start', {
      sessionId: this.debugSessionId,
      startedAt: this.debugStartedAt,
      homeFormation: this.homeConfig.formation.name,
      awayFormation: this.awayConfig.formation.name,
      homeManager: this.homeConfig.isHuman ? 'human' : 'ai',
      awayManager: this.awayConfig.isHuman ? 'human' : 'ai',
      homeTactics: {
        aggression: Math.round(this.homeConfig.aggression),
        passingDirectness: Math.round(this.homeConfig.passingDirectness),
        overlapFrequency: Math.round(this.homeConfig.overlapFrequency),
        midfieldFreedom: Math.round(this.homeConfig.midfieldFreedom),
        defensiveLineHeight: Math.round(this.homeConfig.defensiveLineHeight),
      },
      awayTactics: {
        aggression: Math.round(this.awayConfig.aggression),
        passingDirectness: Math.round(this.awayConfig.passingDirectness),
        overlapFrequency: Math.round(this.awayConfig.overlapFrequency),
        midfieldFreedom: Math.round(this.awayConfig.midfieldFreedom),
        defensiveLineHeight: Math.round(this.awayConfig.defensiveLineHeight),
      },
    });
  }

  startMatch(): void {
    this.matchState = 'running'; this.clockMs = 0;
    this.homeScore = 0; this.awayScore = 0;
    this.homeShots = 0; this.awayShots = 0;
    this.homeTackles = 0; this.awayTackles = 0;
    this.possessionHome = 0; this.possessionAway = 0;
    this.recentEvents = [];
    this.accumulator = 0; this.half = 1; this.halfTimePause = 0;
    this.beginDebugSession();
    this.assignmentByPlayer.clear();
    this.carrierWatchId = null; this.carrierWatchMs = 0;
    this.lastAssignmentLog = 0; this.lastStuckLog = 0; this.lastStateSampleLog = 0;
    this.lastDistanceLog = 0;
    this.statsPossession = { home: 0, away: 0 };
    this.statsPassAttempted = 0; this.statsPassCompleted = 0; this.statsPassIntercepted = 0;
    this.statsThroughBallAttempted = 0; this.statsThroughBallCompleted = 0;
    this.statsOffsides = 0;
    this.statsShotsOnTarget = 0; this.statsShotsOffTarget = 0; this.statsSaves = 0;
    this.statsBallInThird = { homeDef: 0, mid: 0, awayDef: 0 };
    this.qBallUnclaimedSince = 0;
    this.qPossessionChanges = [];
    this.qLastControllerId = null;
    this.qLastPossessionTeam = null;
    this.qLastPossessionTeamChange = 0;
    this.qPlayerLastMoved.clear();
    this.qOutOfPlayEvents = [];
    this.qBallPrevSpeed = 0; this.qLastBallImpulseMs = -Infinity;
    this.qTackleAttempts = []; this.qTackleSuccesses = [];
    this.qPassAttempts = []; this.qPassFails = [];
    this.qRecentPassPairs = [];
    this.pendingPass = null;
    this.qConsecutiveSaves = 0;
    this.qLastShotMs = 0;
    this.qShotOrigin = null;
    this.qBounceOnSamePlayer = 0; this.qLastBouncePlayer = null;
    this.qBallThird = null; this.qBallThirdSince = 0;
    this.qLastQualityCheck = 0; this.qFlagLastLogged.clear();
    this.qualityFlagCounts.clear();
    this.transitionUntil = { home: 0, away: 0 };
    this.phaseTicks = {
      home: { loose_ball: 0, possession: 0, attacking_transition: 0, defending: 0, defensive_transition: 0 },
      away: { loose_ball: 0, possession: 0, attacking_transition: 0, defending: 0, defensive_transition: 0 },
    };
    this.taskSelections.clear();
    this.possessionByRole = {};
    this.ballDistance = 0; this.playerDistances.clear();
    this.prevBallX = 0; this.prevBallY = 0; this.prevPlayerPositions.clear();
    this.nextKickoffTeam = 'home';
    this.setPieceTakerId = null;
    this.kickoff();
  }

  configFor(team: Team): ManagerConfig { return team === 'home' ? this.homeConfig : this.awayConfig; }
  pause(): void { if (this.matchState === 'running') this.matchState = 'paused'; }
  resume(): void { if (this.matchState === 'paused') this.matchState = 'running'; }
  togglePause(): void {
    if (this.matchState === 'running') this.matchState = 'paused';
    else if (this.matchState === 'paused') this.matchState = 'running';
  }

  playerById(id: number | null): Player | undefined {
    if (id === null) return undefined;
    return this.players.find(p => p.id === id);
  }

  teamInPossession(): Team | undefined {
    const c = this.playerById(this.ball.controllerId);
    return c?.team ?? this.pendingPass?.team;
  }

  // ── spatial grid

  private rebuildGrid(): void {
    for (let i = 0; i < GRID_COLS * GRID_ROWS; i++) this.grid[i] = [];
    for (const p of this.players) {
      const cx = clamp(Math.floor(p.x / GRID_CELL), 0, GRID_COLS - 1);
      const cy = clamp(Math.floor(p.y / GRID_CELL), 0, GRID_ROWS - 1);
      const cell = cy * GRID_COLS + cx;
      this.grid[cell].push(p.id);
      this.gridPlayers.set(p.id, cell);
    }
  }

  nearPlayers(player: Player, range: number): Player[] {
    const cx = clamp(Math.floor(player.x / GRID_CELL), 0, GRID_COLS - 1);
    const cy = clamp(Math.floor(player.y / GRID_CELL), 0, GRID_ROWS - 1);
    const cells = Math.ceil(range / GRID_CELL);
    const result: Player[] = [];

    for (let dy = -cells; dy <= cells; dy++) {
      for (let dx = -cells; dx <= cells; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || nx >= GRID_COLS || ny < 0 || ny >= GRID_ROWS) continue;
        const cell = ny * GRID_COLS + nx;
        for (const id of this.grid[cell] || []) {
          const p = this.playerById(id);
          if (p && p.id !== player.id) result.push(p);
        }
      }
    }
    return result;
  }

  private updateTeamAssignments(): void {
    this.assignmentByPlayer.clear();
    const possessingTeam = this.teamInPossession();
    for (const team of ['home', 'away'] as Team[]) {
      const phase = this.teamPhaseFor(team);
      this.phaseTicks[team][phase]++;
      if (possessingTeam && possessingTeam !== team) this.assignDefensiveRoles(team);
      else if (possessingTeam === team) this.assignAttackingRoles(team);
    }

    if (this.clockMs - this.lastAssignmentLog >= COORDINATOR_LOG_INTERVAL) {
      this.lastAssignmentLog = this.clockMs;
      const snapshot = [...this.assignmentByPlayer.values()]
        .map(a => `${a.team}:${a.role}:${a.playerId}->${Math.round(a.targetX)},${Math.round(a.targetY)}`)
        .join('|');
      this.logDebug('assignments', {
        controller: this.ball.controllerId,
        team: possessingTeam ?? 'none',
        homePhase: this.teamPhaseFor('home'),
        awayPhase: this.teamPhaseFor('away'),
        snapshot,
      });
    }
  }

  private assignDefensiveRoles(team: Team): void {
    const ctrl = this.playerById(this.ball.controllerId ?? this.pendingPass?.toId ?? null);
    if (!ctrl || ctrl.team === team) return;
    const fd = team === 'home' ? 1 : -1;
    const ownGoalX = team === 'home' ? HOME_GOAL_X : AWAY_GOAL_X;
    const phase = this.teamPhaseFor(team);
    const tactics = this.configFor(team);
    const aggression = tactics.aggression;
    const defendingDanger = Math.abs(ctrl.x - ownGoalX) < 240;
    const candidates = (this.playersByTeam.get(team) ?? []).filter(p => p.role !== 'GK');
    const ranked = candidates
      .map(p => ({
        p,
        score: dist(p, ctrl)
          - attrFactor(p.attrs, 'speed') * 45
          - attrFactor(p.attrs, 'tackling') * 35
          + (p.role === 'CB' ? (defendingDanger ? 8 : 70) : p.role === 'CF' ? 28 : p.role === 'CM' ? 0 : p.role === 'WM' ? 6 : 14),
      }))
      .sort((a, b) => a.score - b.score);
    const assigned = new Set<number>();

    const primary = ranked[0]?.p;
    if (primary) {
      this.setAssignment(primary, 'primary_press', ctrl.x - fd * 16, ctrl.y, ranked[0].score, ctrl.id);
      assigned.add(primary.id);
    }
    if (phase === 'defensive_transition' || aggression >= 62) {
      const secondary = ranked.find(r => !assigned.has(r.p.id) && r.p.role !== 'CB' && dist(r.p, ctrl) < 260)?.p;
      if (secondary) {
        this.setAssignment(secondary, 'secondary_press', ctrl.x - fd * 42, clamp(ctrl.y + (secondary.homeY < ctrl.y ? -38 : 38), 35, PITCH_H - 35), 1, ctrl.id);
        assigned.add(secondary.id);
      }
    }
    const cover = ranked.find(r => !assigned.has(r.p.id) && (r.p.role === 'CB' || r.p.role === 'CM'))?.p;
    if (cover) {
      this.setAssignment(cover, 'cover', lerp(ctrl.x, ownGoalX + fd * 115, 0.58), lerp(ctrl.y, PITCH_H / 2, 0.4), 1, ctrl.id);
      assigned.add(cover.id);
    }
    const screen = candidates.find(p => !assigned.has(p.id) && p.role === 'CM');
    if (screen) {
      this.setAssignment(screen, 'midfield_screen', lerp(ctrl.x, ownGoalX + fd * 175, 0.4), lerp(ctrl.y, PITCH_H / 2, 0.65), 1);
      assigned.add(screen.id);
    }
    for (const defender of candidates.filter(p => !assigned.has(p.id) && (p.role === 'CB' || p.role === 'FB'))) {
      const task: TeamAssignmentRole = defender.role === 'FB' ? 'wide_cover' : 'defensive_line';
      const depth = phase === 'defensive_transition' ? 92 : 120;
      const linePush = (tactics.defensiveLineHeight - 50) * 0.9;
      const targetX = defendingDanger
        ? clamp(ownGoalX + fd * (defender.role === 'CB' ? 92 : 118), 35, PITCH_W - 35)
        : clamp(lerp(defender.homeX, ctrl.x - fd * depth, 0.32) + fd * linePush, 35, PITCH_W - 35);
      const targetY = defender.role === 'FB'
        ? clamp(lerp(defender.homeY, ctrl.y, 0.20), 35, PITCH_H - 35)
        : clamp(lerp(defender.homeY, PITCH_H / 2, 0.08), 35, PITCH_H - 35);
      this.setAssignment(defender, task, targetX, targetY, 1);
      assigned.add(defender.id);
    }
  }

  private assignAttackingRoles(team: Team): void {
    const ctrl = this.playerById(this.ball.controllerId ?? this.pendingPass?.toId ?? null);
    if (!ctrl || ctrl.team !== team) return;
    const fd = team === 'home' ? 1 : -1;
    const phase = this.teamPhaseFor(team);
    const tactics = this.configFor(team);
    const progress = team === 'home' ? ctrl.x / PITCH_W : 1 - ctrl.x / PITCH_W;
    const teammates = (this.playersByTeam.get(team) ?? []).filter(p => p.role !== 'GK' && p.id !== ctrl.id);
    const assigned = new Set<number>();
    const midfielders = teammates.filter(p => p.role === 'CM').sort((a, b) => dist(a, ctrl) - dist(b, ctrl));
    const support = midfielders[0];
    if (support) {
      this.setAssignment(support, 'support_outlet', clamp(ctrl.x - fd * 70, 55, PITCH_W - 55), clamp(ctrl.y + (support.homeY <= ctrl.y ? -75 : 75), 50, PITCH_H - 50), 1);
      assigned.add(support.id);
    }
    const advancedMid = midfielders.find(p => !assigned.has(p.id));
    const midfieldThreshold = clamp(0.45 - tactics.midfieldFreedom / 250, 0.12, 0.36);
    if (advancedMid && (phase === 'attacking_transition' || progress > midfieldThreshold)) {
      const advance = (phase === 'attacking_transition' ? 135 : 86) + tactics.midfieldFreedom * 0.42;
      this.setAssignment(advancedMid, 'advance_midfield', clamp(ctrl.x + fd * advance, 55, PITCH_W - 55), clamp(lerp(advancedMid.homeY, ctrl.y, 0.32), 45, PITCH_H - 45), 1);
      assigned.add(advancedMid.id);
    }
    const runner = teammates.filter(p => p.role === 'CF').sort((a, b) => dist(a, ctrl) - dist(b, ctrl))[0];
    if (runner) {
      const depth = phase === 'attacking_transition' ? 220 : 150;
      this.setAssignment(runner, 'run_ahead', clamp(ctrl.x + fd * depth, 55, PITCH_W - 55), clamp(runner.homeY, 45, PITCH_H - 45), 1);
      assigned.add(runner.id);
    }
    for (const winger of teammates.filter(p => p.role === 'WM')) {
      const wideY = winger.homeY < PITCH_H / 2 ? 35 : PITCH_H - 35;
      this.setAssignment(winger, 'hold_width', clamp(ctrl.x + fd * (phase === 'attacking_transition' ? 145 : 85), 45, PITCH_W - 45), wideY, 1);
      assigned.add(winger.id);
    }
    const fullbacks = teammates.filter(p => p.role === 'FB');
    const overlap = fullbacks.sort((a, b) => Math.abs(a.homeY - ctrl.y) - Math.abs(b.homeY - ctrl.y))[0];
    const overlapThreshold = clamp(0.46 - tactics.overlapFrequency / 230, 0.12, 0.38);
    if (overlap && progress > overlapThreshold && (ctrl.role === 'WM' || ctrl.role === 'CM' || phase === 'attacking_transition')) {
      const wideY = overlap.homeY < PITCH_H / 2 ? 42 : PITCH_H - 42;
      const overlapDepth = (phase === 'attacking_transition' ? 125 : 76) + tactics.overlapFrequency * 0.72;
      this.setAssignment(overlap, 'overlap', clamp(ctrl.x + fd * overlapDepth, 45, PITCH_W - 45), wideY, 1);
      assigned.add(overlap.id);
    }
    for (const defender of teammates.filter(p => !assigned.has(p.id) && (p.role === 'CB' || p.role === 'FB'))) {
      const linePush = (tactics.defensiveLineHeight - 50) * 0.45;
      const targetX = clamp(defender.homeX + fd * (Math.min(115, progress * 150) + linePush), 40, PITCH_W - 40);
      this.setAssignment(defender, 'rest_defence', targetX, clamp(lerp(defender.homeY, PITCH_H / 2, 0.18), 45, PITCH_H - 45), 1);
    }
  }

  private setAssignment(player: Player, role: TeamAssignmentRole, targetX: number, targetY: number, score: number, opponentId?: number): void {
    this.assignmentByPlayer.set(player.id, {
      team: player.team,
      role,
      playerId: player.id,
      targetX: clamp(targetX, 10, PITCH_W - 10),
      targetY: clamp(targetY, 10, PITCH_H - 10),
      ...(opponentId !== undefined ? { opponentId } : {}),
      score: Math.round(score * 100) / 100,
    });
  }

  private clearTeamAssignments(): void {
    this.assignmentByPlayer.clear();
  }

  private detectStuckCarrier(sdt: number): void {
    const carrier = this.playerById(this.ball.controllerId);
    if (!carrier) {
      this.carrierWatchId = null;
      this.carrierWatchMs = 0;
      return;
    }
    if (this.carrierWatchId !== carrier.id) {
      this.carrierWatchId = carrier.id;
      this.carrierWatchMs = 0;
      this.carrierWatchX = carrier.x;
      this.carrierWatchY = carrier.y;
      return;
    }
    this.carrierWatchMs += sdt;
    const moved = Math.hypot(carrier.x - this.carrierWatchX, carrier.y - this.carrierWatchY);
    if (moved > 42) {
      this.carrierWatchMs = 0;
      this.carrierWatchX = carrier.x;
      this.carrierWatchY = carrier.y;
      return;
    }

    const nearbyOpponents = this.players.filter(p => p.team !== carrier.team && p.role !== 'GK' && dist(p, carrier) < 58).length;
    const pressuredOrDeep = nearbyOpponents > 0 || (carrier.team === 'home' ? carrier.x < PITCH_W * 0.28 : carrier.x > PITCH_W * 0.72);
    if (this.carrierWatchMs > 2800 && moved <= 42 && pressuredOrDeep && this.clockMs - this.lastStuckLog > STUCK_LOG_INTERVAL) {
      this.lastStuckLog = this.clockMs;
      this.logDebug('stuck_carrier', {
        player: carrier.id,
        team: carrier.team,
        x: Math.round(carrier.x),
        y: Math.round(carrier.y),
        heldMs: Math.round(this.carrierWatchMs),
        moved: Math.round(moved),
        nearbyOpponents,
        assignment: this.assignmentByPlayer.get(carrier.id)?.role ?? 'none',
      });
    }

    if (this.carrierWatchMs > 4200 && moved <= 42 && pressuredOrDeep && this.breakStuckCarrier(carrier, nearbyOpponents)) {
      this.carrierWatchMs = 0;
      this.carrierWatchX = carrier.x;
      this.carrierWatchY = carrier.y;
    }
  }

  private breakStuckCarrier(carrier: Player, nearbyOpponents: number): boolean {
    const fd = carrier.team === 'home' ? 1 : -1;
    const teammates = (this.playersByTeam.get(carrier.team) ?? [])
      .filter(p => p.id !== carrier.id && p.role !== 'GK')
      .map(p => {
        const d = dist(carrier, p);
        const forward = (p.x - carrier.x) * fd;
        const roleBonus = p.role === 'CM' ? -35 : p.role === 'CB' ? -18 : 8;
        const forwardBonus = forward > 10 ? -30 : forward < -90 ? 30 : 0;
        return { p, d, score: d + roleBonus + forwardBonus };
      })
      .filter(o => o.d > 35 && o.d < 430)
      .sort((a, b) => a.score - b.score);

    const target = teammates[0]?.p;
    this.logDebug('carrier_escape', {
      player: carrier.id,
      team: carrier.team,
      x: Math.round(carrier.x),
      y: Math.round(carrier.y),
      heldMs: Math.round(this.carrierWatchMs),
      nearbyOpponents,
      target: target?.id ?? null,
      targetRole: target?.role ?? null,
    });

    if (target) {
      this.forcePassTo(carrier, target);
      return true;
    }

    this.releaseAndKick(carrier, fd * 430, (random() - 0.5) * 170);
    return true;
  }

  // ═══════════════════════ MAIN LOOP

  private logPitchSample(): void {
    const b = this.ball;
    const controller = this.playerById(b.controllerId);
    const ballSpeed = Math.hypot(b.vx, b.vy);
    const closePlayers = this.players
      .map(p => ({ p, d: dist(p, b) }))
      .sort((a, b2) => a.d - b2.d)
      .slice(0, 6)
      .map(({ p, d }) => `${p.id}:${p.team[0]}:${p.role}:${Math.round(p.x)},${Math.round(p.y)}:${Math.round(d)}`)
      .join('|');
    const pressure = controller
      ? this.players.filter(p => p.team !== controller.team && p.role !== 'GK' && dist(p, controller) < 70).length
      : 0;
    const controllerPhase = 'playing';

    this.logDebug('sample', {
      bx: Math.round(b.x),
      by: Math.round(b.y),
      bvx: Math.round(b.vx),
      bvy: Math.round(b.vy),
      bz: Math.round(b.z),
      ballSpeed: Math.round(ballSpeed),
      controller: b.controllerId,
      controllerTeam: controller?.team ?? 'none',
      controllerPhase,
      intended: b.intendedReceiverId,
      lastTouch: b.lastToucherId,
      lastTeam: b.lastTouchTeam,
      pressure,
      controlTicks: this.controlTicks,
      setPiece: this.setPieceArmed ? this.setPieceType : 'none',
      kickoff: this.kickoffPhase,
      closePlayers,
    });
  }

  private maybeLogPitchSample(): void {
    if (this.clockMs - this.lastStateSampleLog < STATE_SAMPLE_LOG_INTERVAL) return;
    this.lastStateSampleLog = this.clockMs;
    this.logPitchSample();
  }

  update(deltaMs: number): void {
    if (this.matchState !== 'running') return;
    const boundedDelta = clamp(deltaMs, 0, MAX_FRAME_DELTA_MS);
    this.accumulator += boundedDelta * this.speed;
    this.accumulator = Math.min(this.accumulator, FIXED_DT * MAX_STEPS_PER_FRAME);

    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
      this.fixedUpdate(FIXED_DT);
      this.accumulator -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) {
      this.accumulator = 0;
    }
    this.syncState();

    // goal-area logging
    for (const p of this.players) {
      if (p.role === 'GK') continue;
      const oppGoalX = p.team === 'home' ? AWAY_GOAL_X : HOME_GOAL_X;
      const dg = Math.abs(p.x - oppGoalX);
      if (dg < 200 && Math.abs(p.y - PITCH_H / 2) < 150) {
        this.logDebug('goal_area', {
          player: p.id, team: p.team, role: p.role,
          x: Math.round(p.x), y: Math.round(p.y), dg: Math.round(dg),
          hasBall: this.ball.controllerId === p.id,
          oppNear: this.nearPlayers(p, 60).filter(o => o.team !== p.team).length,
        });
      }
    }
  }

  private syncState(): void {
    this.state.clockMs = this.clockMs;
    this.state.matchState = this.matchState;
    this.state.speed = this.speed;
    this.state.homeScore = this.homeScore;
    this.state.awayScore = this.awayScore;
    this.state.events = this.recentEvents;
    this.state.homeShots = this.homeShots;
    this.state.awayShots = this.awayShots;
    this.state.possessionPct = this.possessionHome / Math.max(1, this.possessionHome + this.possessionAway) * 100;
    this.state.half = this.half;
  }

  private fixedUpdate(sdt: number): void {
    this.clockMs += sdt;
    if (this.clockMs >= MATCH_DURATION_MS) {
      this.matchState = 'finished'; this.clockMs = MATCH_DURATION_MS; return;
    }

    // half time
    if (this.half === 1 && this.clockMs >= 45 * 60 * 1000) {
      this.half = 2;
      this.halfTimePause = 2000;
    }

    if (this.halfTimePause > 0) {
      this.halfTimePause -= sdt;
      if (this.halfTimePause <= 0) {
        this.kickoff();
      }
      this.tickAgents(sdt, false);
      this.applySeparation(sdt / 1000);
      this.updateGK(sdt);
      return;
    }

    for (const e of this.recentEvents) e.age += sdt;
    this.recentEvents = this.recentEvents.filter(e => e.age < 2000);

    const secs = sdt / 1000;
    this.rebuildGrid();
    this.updateTeamAssignments();
    this.detectStuckCarrier(sdt);
    // decay tackle animation timers
    for (const p of this.players) { if (p.tackleAnim > 0) p.tackleAnim = Math.max(0, p.tackleAnim - sdt); }
    this.maybeLogPitchSample();
    if (this.reboundBlockTimer > 0) {
      this.reboundBlockTimer -= sdt;
      if (this.reboundBlockTimer <= 0) this.reboundBlockedId = null;
    }

    // possession tracking
    const ctrl = this.playerById(this.ball.controllerId);
    if (ctrl) {
      if (ctrl.team === 'home') this.possessionHome += sdt;
      else this.possessionAway += sdt;
    }

    if (this.setPieceArmed) {
      this.actionTimer -= sdt;
      if (this.actionTimer <= 0) { this.setPieceArmed = false; this.giveBallToTaker(); }
      this.tickAgents(sdt, false);
      this.moveBallCarrier(sdt);
      this.updateControlledBall(secs);
      this.applySeparation(secs);
      this.updateGK(sdt);
      return;
    }

    if (this.kickoffPhase) {
      this.actionTimer -= sdt;
      this.holdKickoffShape();
      this.updateControlledBall(secs);
      if (this.actionTimer <= 0) { this.kickoffPhase = false; this.kickoffTap(); }
      return;
    }

    if (this.ball.controllerId === null) {
      this.applyBallPhysics(secs);
      this.clampBallPosition();
      this.checkBallPlayerCollision(secs);
      this.checkOutOfPlay();
    }

    // clear blackboards before agents evaluate
    for (const [, bb] of this.teamBlackboards) {
      bb.pressingPlayerId = null;
      bb.pressingPlayerId2 = null;
      bb.activeRuns = [];
      bb.zoneClaims = [];
    }
    this.tickAgents(sdt, true);

    // goal-area logging

    if (this.gkDistributeTimer > 0) {
      this.gkDistributeTimer -= sdt;
      if (this.gkDistributeTimer <= 0) this.gkDistribute();
    }

    this.updateControlledBall(secs);
    this.moveBallCarrier(sdt);
    this.applySeparation(secs);

    // corner cross execution
    if (this.cornerCrossPending) {
      this.actionTimer -= sdt;
      if (this.actionTimer <= 0) {
        this.executeCornerCross();
        this.cornerCrossPending = false;
      }
    }
    this.updateGK(sdt);
    this.tryGKSave(secs);
    // ball trace: log every 2nd tick to catch teleports
    if (this.debugSeq % 2 === 0) {
      this.logDebug('ball_trace', {
        bx: Math.round(this.ball.x), by: Math.round(this.ball.y),
        bvx: Math.round(this.ball.vx), bvy: Math.round(this.ball.vy),
        bz: Math.round(this.ball.z), bvz: Math.round(this.ball.vz),
        ctrl: this.ball.controllerId, intended: this.ball.intendedReceiverId,
        lastTouch: this.ball.lastToucherId, lastTeam: this.ball.lastTouchTeam,
      });
    }
    // accumulate ball distance only when loose (carrier movement = player distance)
    if (this.prevBallX !== 0 || this.prevBallY !== 0) {
      if (this.ball.controllerId === null) {
        this.ballDistance += Math.sqrt((this.ball.x - this.prevBallX) ** 2 + (this.ball.y - this.prevBallY) ** 2);
      }
    }
    this.prevBallX = this.ball.x; this.prevBallY = this.ball.y; this.prevBallTick = this.clockMs;
    // possession tracking
    const ballCtrl = this.playerById(this.ball.controllerId);
    if (ballCtrl) { this.statsPossession[ballCtrl.team] = (this.statsPossession[ballCtrl.team] ?? 0) + 1; this.statsPossessionTime.set(ballCtrl.id, (this.statsPossessionTime.get(ballCtrl.id) ?? 0) + 1); }
    // flank tracking
    if (this.ball.y < PITCH_H * 0.35) this.statsFlankTime.left++;
    else if (this.ball.y > PITCH_H * 0.65) this.statsFlankTime.right++;
    else this.statsFlankTime.center++;
    // territory: which third is the ball in
    if (this.ball.x < PITCH_W / 3) this.statsBallInThird.homeDef++;
    else if (this.ball.x > PITCH_W * 2 / 3) this.statsBallInThird.awayDef++;
    else this.statsBallInThird.mid++;
    for (const p of this.players) {
      const prev = this.prevPlayerPositions.get(p.id);
      if (prev) {
        const pd = Math.sqrt((p.x - prev.x) ** 2 + (p.y - prev.y) ** 2);
        this.playerDistances.set(p.id, (this.playerDistances.get(p.id) ?? 0) + pd);
      }
      this.prevPlayerPositions.set(p.id, { x: p.x, y: p.y });
    }
    // log distances every 10 game-seconds
    if (this.clockMs - this.lastDistanceLog >= 10000) {
      this.lastDistanceLog = this.clockMs;
      const pxToM = (v: number) => Math.round(v / 10 * 100) / 100; // 10px = 1m
      const elapsedMin = this.clockMs / 60000;
      const roleDist: Record<string, number> = {};
      for (const p of this.players) {
        const r = p.role;
        roleDist[r] = (roleDist[r] ?? 0) + (this.playerDistances.get(p.id) ?? 0);
      }
      this.logDebug('distance', {
        clockMs: this.clockMs,
        elapsedMin: Math.round(elapsedMin * 100) / 100,
        ballTotal: pxToM(this.ballDistance),
        ballPerMin: elapsedMin > 0 ? Math.round(pxToM(this.ballDistance) / elapsedMin) : 0,
        players: Object.fromEntries(
          Object.entries(roleDist).map(([role, d]) => [role, {
            total: pxToM(d),
            perMin: elapsedMin > 0 ? Math.round(pxToM(d) / elapsedMin) : 0,
            count: this.players.filter(p => p.role === role).length,
          }])
        ),
        // match stats
        possession: {
          home: Math.round((this.statsPossession.home / Math.max(this.statsPossession.home + this.statsPossession.away, 1)) * 100),
          away: Math.round((this.statsPossession.away / Math.max(this.statsPossession.home + this.statsPossession.away, 1)) * 100),
        },
        passes: { attempted: this.statsPassAttempted, completed: this.statsPassCompleted, intercepted: this.statsPassIntercepted },
        shots: { onTarget: this.statsShotsOnTarget, offTarget: this.statsShotsOffTarget, home: this.homeShots, away: this.awayShots },
        territory: {
          homeDef: Math.round((this.statsBallInThird.homeDef / Math.max(Object.values(this.statsBallInThird).reduce((a:number,b:number)=>a+b,0), 1)) * 100),
          mid: Math.round((this.statsBallInThird.mid / Math.max(Object.values(this.statsBallInThird).reduce((a:number,b:number)=>a+b,0), 1)) * 100),
          awayDef: Math.round((this.statsBallInThird.awayDef / Math.max(Object.values(this.statsBallInThird).reduce((a:number,b:number)=>a+b,0), 1)) * 100),
        },
      });
    }
    this.simQualityCheck();
    this.checkGoal();
  }

  private tickAgents(sdt: number, includeCarrier: boolean): void {
    for (const [id, agent] of this.agents) {
      if (id === this.ball.controllerId && !includeCarrier) continue;
      if (this.gkByTeam.get(agent.player.team)?.id === id) continue;
      agent.tick(sdt);
    }
  }

  // ═══════════════════════ BALL PHYSICS

  private applyBallPhysics(secs: number): void {
    const f = Math.pow(BALL_FRICTION, secs);
    this.ball.vx *= f; this.ball.vy *= f;
    if (Math.sqrt(this.ball.vx ** 2 + this.ball.vy ** 2) < 3) { this.ball.vx = 0; this.ball.vy = 0; }
    this.ball.x += this.ball.vx * secs; this.ball.y += this.ball.vy * secs;

    // arc — only for balls already in the air or explicitly launched
    if (this.ball.vz !== 0 || this.ball.z > 0) {
      this.ball.vz -= 500 * secs;
      this.ball.z += this.ball.vz * secs;
      if (this.ball.z < 0) { this.ball.z = 0; this.ball.vz *= -0.2; }
    }
  }

  private clampBallPosition(): void {
    this.ball.x = clamp(this.ball.x, -40, PITCH_W + 40);
    this.ball.y = clamp(this.ball.y, -40, PITCH_H + 40);
  }

  private checkBallPlayerCollision(_secs: number): void {
    const b = this.ball;
    if (b.x < -10 || b.x > PITCH_W + 10 || b.y < -10 || b.y > PITCH_H + 10) return;
    const ballSpeed = Math.sqrt(b.vx ** 2 + b.vy ** 2);
    const r = 20; // collection radius
    for (const p of this.players) {
      if (!this.canContestBall(p)) continue;
      const d = dist(p, b);
      if (d > r) continue;
      // heading: play aerial balls with head (z between 50-180)
      if (b.z > 25 && b.z < 200 && p.role !== 'GK') {
        const headingSkill = attrFactor(p.attrs, 'positioning') * 0.5 + attrFactor(p.attrs, 'tackling') * 0.2;
        this.statsHeadersTotal++;
        if (random() < headingSkill * 0.7) {
          this.statsHeadersWon++;
          this.headBall(p);
          return;
        }
      }
      if (b.z > 20 && p.id !== b.intendedReceiverId) continue;
      if (p.role === 'GK' && ballSpeed < 220 && this.isInKeeperArea(p, b.x, b.y)) {
        this.collectBall(p);
        return;
      }
      if (p.role === 'GK') continue;
      // A marked receiver must still secure the ball under pressure.
      if (p.id === b.intendedReceiverId && ballSpeed < 220) {
        const underPressure = this.players.some(o => o.team !== p.team && o.role !== 'GK' && dist(o, p) < 38);
        if (!underPressure && this.collectBall(p)) return;
        if (underPressure && this.tryTrapMovingBall(p, ballSpeed, d)) return;
        continue;
      }
      // general collection: most slow/medium balls stick
      if (ballSpeed < 130) {
        if (this.collectBall(p)) return;
        continue;
      }
      // trap for faster balls
      if (this.tryTrapMovingBall(p, ballSpeed, d)) return;
      // hard bounce: only for fast balls that couldn't be collected
      if (ballSpeed > 130) {
        if (b.z > 20) continue;
        const dx = b.x - p.x, dy = b.y - p.y;
        const d2 = Math.sqrt(dx * dx + dy * dy);
        if (d2 < 1) continue;
        const nx = dx / d2, ny = dy / d2;
        b.x = p.x + nx * r; b.y = p.y + ny * r;
        const dot = b.vx * nx + b.vy * ny;
        if (dot < 0) { b.vx -= 1.3 * dot * nx; b.vy -= 1.3 * dot * ny; } // soft deflection
        b.vx *= 0.25; b.vy *= 0.25; // kill the ball — it's near a player
        b.vx += ny * ballSpeed * 0.03; b.vy += -nx * ballSpeed * 0.03;
        b.lastTouchTeam = p.team; b.lastToucherId = p.id;
        this.statsBouncesNoControl++;
        this.blockReboundFor(p.id, 600);
        this.recordBounce(p.id);
      }
    }
  }

  private tryTrapMovingBall(player: Player, ballSpeed: number, contactDist: number): boolean {
    const b = this.ball;
    if (ballSpeed > 280) return false;
    const isIntended = player.id === b.intendedReceiverId;
    const isInterception = b.lastTouchTeam !== null && b.lastTouchTeam !== player.team;
    if (!isIntended && !isInterception) return false;

    const skill = attrFactor(player.attrs, 'positioning') * 0.40
      + attrFactor(player.attrs, 'tackling') * 0.20
      + attrFactor(player.attrs, 'speed') * 0.15
      + (isIntended ? attrFactor(player.attrs, 'passing') * 0.30 : 0.10);
    const speedPenalty = clamp((ballSpeed - 80) / 250, 0, 0.35);
    const contactBonus = clamp((20 - contactDist) / 20, 0, 1) * 0.25;
    const chance = clamp(skill - speedPenalty + contactBonus + (isIntended ? 0.35 : 0.10), 0.25, 0.98);
    if (random() >= chance) return false;
    if (!this.collectBall(player)) return false;
    if (isInterception) this.emitEvent('intercept', player.x, player.y);
    return true;
  }

  canContestBall(player: Player): boolean {
    if (this.setPieceArmed && this.ball.controllerId === null) return false;
    return !(this.reboundBlockTimer > 0 && this.reboundBlockedId === player.id);
  }

  isCarrierShielded(): boolean {
    return this.clockMs < this.receiverShieldUntil;
  }

  private blockReboundFor(playerId: number | null, ms: number): void {
    if (playerId === null) return;
    this.reboundBlockedId = playerId;
    this.reboundBlockTimer = ms;
  }

  private blockReleaser(player: Player, ms: number): void {
    this.blockReboundFor(player.id, ms);
    this.logDebug('contest_block', { player: player.id, ms });
  }

  private placeBallForRelease(kicker: Player, dx: number, dy: number, maxOffset = CONTROL_DIST + PLAYER_R + 10): void {
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < 0.001) {
      const fd = kicker.team === 'home' ? 1 : -1;
      this.ball.x = clamp(kicker.x + fd * maxOffset, 5, PITCH_W - 5);
      this.ball.y = kicker.y;
      return;
    }
    this.ball.x = clamp(kicker.x + (dx / d) * maxOffset, 5, PITCH_W - 5);
    this.ball.y = clamp(kicker.y + (dy / d) * maxOffset, 5, PITCH_H - 5);
  }

  private isInKeeperArea(gk: Player, x: number, y: number): boolean {
    const ownGoalX = gk.team === 'home' ? HOME_GOAL_X : AWAY_GOAL_X;
    const inDepth = gk.team === 'home' ? x < 190 : x > PITCH_W - 190;
    return inDepth && Math.abs(y - PITCH_H / 2) < 135 && Math.abs(x - ownGoalX) < 210;
  }

  // ═══════════════════════ AGENT API

  passBallTo(from: Player, to: Player, throughBall = false): void {
    // lead pass: predict where receiver will be when ball arrives, not where they are now
    const rawDx = to.x - from.x, rawDy = to.y - from.y;
    const rawDist = Math.sqrt(rawDx * rawDx + rawDy * rawDy);
    const speed = PASS_SPEED_BASE + rawDist * PASS_SPEED_DIST;
    const travelTime = rawDist / Math.max(speed, 1);
    // through-ball: lead more when receiver is sprinting forward into space
    const receiverSpeed = Math.sqrt(to.vx * to.vx + to.vy * to.vy);
    const fd = from.team === 'home' ? 1 : -1;
    const movingForward = to.vx * fd > 5; // receiver running toward opponent goal
    const leadFactor = movingForward && receiverSpeed > 20 ? 0.80 : 0.45;
    const throughLead = throughBall ? fd * (32 + attrFactor(from.attrs, 'creativity') * 62) : 0;
    const predX = to.x + to.vx * travelTime * leadFactor + throughLead;
    const predY = to.y + to.vy * travelTime * leadFactor;
    const dx = predX - from.x, dy = predY - from.y;
    const adjDist = Math.sqrt(dx * dx + dy * dy);
    if (adjDist < 1) return; // safety check
    const passSkill = attrFactor(from.attrs, 'passing');
    const inacc = (1 - passSkill) * rawDist * 0.12;
    const tdx = dx + (random() - 0.5) * inacc;
    const tdy = dy + (random() - 0.5) * inacc;
    const tDist = Math.sqrt(tdx * tdx + tdy * tdy);
    this.clearTeamAssignments();
    this.ball.controllerId = null;
    this.placeBallForRelease(from, tdx, tdy);
    this.blockReleaser(from, 900);
    this.ball.lastTouchTeam = from.team; this.ball.lastToucherId = from.id;
    this.ball.vx = (tdx / tDist) * speed; this.ball.vy = (tdy / tDist) * speed;
    this.recordBallImpulse();
    this.ball.intendedReceiverId = to.id;
    this.receiverShieldTargetId = to.id; // protect the receiver on collect
    this.ball.z = 0; this.ball.vz = 0;
    // cross curl: wide passes bend toward goal
    const fromWideForCurl = Math.abs(from.y - PITCH_H / 2) > 180;
    const intoBoxForCurl = Math.abs(predX - (from.team === 'home' ? AWAY_GOAL_X : HOME_GOAL_X)) < 220 && Math.abs(predY - PITCH_H / 2) < 150;
    if (fromWideForCurl && intoBoxForCurl && (from.role === 'WM' || from.role === 'FB')) {
      this.statsCrossAttempted++;
      const curlDir = from.y < PITCH_H / 2 ? 1 : -1; // curl toward center
      const rawDx2 = to.x - from.x, rawDy2 = to.y - from.y;
      this.ball.vx += -rawDy2 / rawDist * speed * 0.08 * curlDir;
      this.ball.vy += rawDx2 / rawDist * speed * 0.08 * curlDir;
    }
    // loft based on distance + opponent interference in passing lane
    let blockers = 0;
    for (const o of this.players) {
      if (o.team === from.team || o.role === 'GK') continue;
      const t = clamp(((o.x - from.x) * dx + (o.y - from.y) * dy) / (adjDist * adjDist), 0, 1);
      const perp = Math.sqrt((o.x - from.x - t * dx) ** 2 + (o.y - from.y - t * dy) ** 2);
      if (perp < 35 && t > 0.1 && t < 0.9) blockers++;
    }
    // loft: short passes stay flat, long + contested passes go aerial (scaled for heading range)
    if (rawDist > 90) this.ball.vz = speed * 0.90;  // even short-medium passes get air
    if (rawDist > 200) this.ball.vz = Math.max(this.ball.vz, speed * 1.30);
    if (blockers > 0) this.ball.vz = Math.max(this.ball.vz, speed * (0.90 + blockers * 0.25));
    if (rawDist > 350) this.ball.vz = Math.max(this.ball.vz, speed * 1.60);
    this.beginTrackedPass(from, to, throughBall ? 'through_ball' : 'open_play');
    if (this.checkOffside(to, from)) {
      this.statsOffsides++;
      this.logDebug('offside', { from: from.id, to: to.id, x: Math.round(to.x), y: Math.round(to.y) });
      this.failPendingPass('offside');
      this.awardOffsideFreeKick(from.team === 'home' ? 'away' : 'home', to);
      return;
    }
    this.logDebug(throughBall ? 'through_ball_start' : 'pass_start', { from: from.id, to: to.id, dist: Math.round(rawDist), speed: Math.round(speed) });
    // cross detection: wide player passing into the box from open play
    const fromWide = Math.abs(from.y - PITCH_H / 2) > 180;
    const goalX = from.team === 'home' ? AWAY_GOAL_X : HOME_GOAL_X;
    const intoBox = Math.abs(predX - goalX) < 200 && Math.abs(predY - PITCH_H / 2) < 140;
    if (fromWide && intoBox && (from.role === 'WM' || from.role === 'FB') && !throughBall) {
      this.logDebug('cross_attempt', { from: from.id, role: from.role, targetX: Math.round(predX), targetY: Math.round(predY), lofted: this.ball.vz > 0 });
    }
    if (rawDist > 380) this.logDebug('long_ball', { from: from.id, role: from.role, to: to.id, dist: Math.round(rawDist) });
  }

  forcePassTo(from: Player, to: Player): void {
    const dx = to.x - from.x, dy = to.y - from.y;
    const rawDist = Math.sqrt(dx * dx + dy * dy);
    const tdx = dx + (random() - 0.5) * rawDist * 0.2;
    const tdy = dy + (random() - 0.5) * rawDist * 0.2;
    const tDist = Math.sqrt(tdx * tdx + tdy * tdy);
    const speed = PASS_SPEED_BASE + 35 + rawDist * (PASS_SPEED_DIST + 0.05);
    this.clearTeamAssignments();
    this.ball.controllerId = null;
    this.placeBallForRelease(from, tdx, tdy);
    this.blockReleaser(from, 900);
    this.ball.lastTouchTeam = from.team; this.ball.lastToucherId = from.id;
    this.ball.vx = (tdx / tDist) * speed; this.ball.vy = (tdy / tDist) * speed;
    this.recordBallImpulse();
    this.ball.intendedReceiverId = to.id;
    this.receiverShieldTargetId = to.id; // protect the receiver on collect
    this.ball.z = 0; this.ball.vz = 0;
    this.ball.vz = speed * 0.40; // clearance always lofts high
    this.beginTrackedPass(from, to, 'forced');
    if (this.checkOffside(to, from)) {
      this.statsOffsides++;
      this.logDebug('offside_forced', { from: from.id, to: to.id });
      this.failPendingPass('offside');
      this.awardOffsideFreeKick(from.team === 'home' ? 'away' : 'home', to);
      return;
    }
    this.logDebug('force_pass_start', { from: from.id, to: to.id, dist: Math.round(rawDist), speed: Math.round(speed) });
  }

  releaseAndKick(kicker: Player, vx: number, vy: number): void {
    this.clearTeamAssignments();
    this.ball.controllerId = null;
    this.placeBallForRelease(kicker, vx, vy);
    this.blockReleaser(kicker, 700);
    this.ball.lastTouchTeam = kicker.team; this.ball.lastToucherId = kicker.id;
    this.ball.vx = vx; this.ball.vy = vy;
    this.recordBallImpulse();
    this.ball.intendedReceiverId = null;
    this.ball.z = 0; this.ball.vz = 0;
    this.logDebug('clearance', { from: kicker.id, vx: Math.round(vx), vy: Math.round(vy) });
  }

  shootBall(shooter: Player): void {
    if (shooter.team === 'home') this.homeShots++; else this.awayShots++;
    const goalX = shooter.team === 'home' ? AWAY_GOAL_X : HOME_GOAL_X;
    const accuracy = attrFactor(shooter.attrs, 'shooting');
    const goalCenterY = PITCH_H / 2;
    const shotDistance = Math.hypot(goalX - shooter.x, goalCenterY - shooter.y);
    const pressureCount = this.players.filter(p => p.team !== shooter.team && p.role !== 'GK' && dist(p, shooter) < 58).length;
    const anglePenalty = clamp(Math.abs(shooter.y - goalCenterY) / 230, 0, 1);
    const distancePenalty = clamp((shotDistance - 70) / 270, 0, 1);
    const executionError = 24 + (1 - accuracy) * 112 + pressureCount * 28 + anglePenalty * 52 + distancePenalty * 48;
    const aimedPost = (random() < 0.5 ? -1 : 1) * GOAL_W * (0.18 + accuracy * 0.13);
    const goalY = goalCenterY + aimedPost + (random() + random() - 1) * executionError;
    const dx = goalX - shooter.x, dy = goalY - shooter.y;
    const dst = Math.sqrt(dx * dx + dy * dy);
    const shotSpeed = SHOT_SPEED_BASE + accuracy * 180 - pressureCount * 10;
    this.clearTeamAssignments();
    this.ball.controllerId = null;
    this.placeBallForRelease(shooter, dx, dy);
    this.blockReleaser(shooter, 850);
    this.ball.lastTouchTeam = shooter.team; this.ball.lastToucherId = shooter.id;
    this.ball.vx = (dx / dst) * shotSpeed; this.ball.vy = (dy / dst) * shotSpeed;
    this.recordBallImpulse();
    this.ball.intendedReceiverId = null;
    this.isShotActive = true; // distinguish from fast passes triggering saves
    this.qLastShotMs = this.clockMs;
    this.qShotOrigin = { team: shooter.team, x: shooter.x, y: shooter.y };
    // key pass: shot within 3s of receiving a pass
    if (this.qLastPassRecipient === shooter.id && this.clockMs - this.qLastPassRecipientMs < 3000) {
      this.logDebug('key_pass', { to: shooter.id, passer: this.qLastPassFrom, msSincePass: this.clockMs - this.qLastPassRecipientMs });
    }
    const inOwnHalf = shooter.team === 'home' ? shooter.x < HALF_X : shooter.x > HALF_X;
    if (inOwnHalf) {
      this.logQualityFlag('shot_from_own_half', { shooter: shooter.id, team: shooter.team, x: Math.round(shooter.x), y: Math.round(shooter.y) });
    }
    this.ball.z = 0; this.ball.vz = 0;
    this.logDebug('shot_start', {
      shooter: shooter.id,
      x: Math.round(shooter.x),
      y: Math.round(shooter.y),
      speed: Math.round(shotSpeed),
      distance: Math.round(shotDistance),
      pressureCount,
      projectedOnTarget: Math.abs(goalY - goalCenterY) < GOAL_W / 2,
    });
  }

  collectBall(collector: Player): boolean {
    if (!this.canContestBall(collector)) return false;
    const previous = this.ball.controllerId;
    const intendedId = this.ball.intendedReceiverId;
    const pendingPass = this.pendingPass;
    this.ball.controllerId = collector.id; this.ball.intendedReceiverId = null;
    this.ball.vx *= 0.3; this.ball.vy *= 0.3; this.ball.z = 0; this.ball.vz = 0;
    this.ball.lastTouchTeam = collector.team; this.ball.lastToucherId = collector.id;
    this.controlTicks = 0;
    if (this.reboundBlockedId === collector.id) {
      this.reboundBlockedId = null;
      this.reboundBlockTimer = 0;
    }
    if (this.ball.x < 5 || this.ball.x > PITCH_W - 5 || this.ball.y < 5 || this.ball.y > PITCH_H - 5) {
      this.ball.x = clamp(collector.x, 20, PITCH_W - 20); this.ball.y = clamp(collector.y, 20, PITCH_H - 20);
    }
    if (collector.role === 'GK') this.gkDistributeTimer = 400;
    // face receiver toward opponent's goal
    const fd = collector.team === 'home' ? 1 : -1;
    collector.vx = fd * 15; collector.vy = 0;
    this.recordControlChange(collector);
    this.possessionByRole[collector.role] = (this.possessionByRole[collector.role] ?? 0) + 1;
    // ball teleport diagnosis: ball was far from collector last tick, suddenly in possession
    if (this.prevBallTick > 0) {
      const collectorPrev = this.prevPlayerPositions.get(collector.id);
      const ballPrevDist = collectorPrev ? Math.sqrt((this.prevBallX - collectorPrev.x) ** 2 + (this.prevBallY - collectorPrev.y) ** 2) : 0;
      if (ballPrevDist > 40) this.logDebug('q_flag', { flag: 'possession_mystery', player: collector.id, role: collector.role, prevBallDist: Math.round(ballPrevDist), tickDelta: this.clockMs - this.prevBallTick });
    }
    this.qLastBouncePlayer = null; this.qBounceOnSamePlayer = 0;
    if (this.isShotActive) {
      this.isShotActive = false;
      this.qShotOrigin = null;
      this.qConsecutiveSaves = 0;
    }
    // first-touch protection: only for intended pass recipients, brief window
    const wasIntendedReceiver = this.receiverShieldTargetId !== null && collector.id === this.receiverShieldTargetId;
    if (wasIntendedReceiver) {
      this.receiverShieldUntil = this.clockMs + 300;
      this.receiverShieldTargetId = null;
    }
    // pass completion tracking
    if (pendingPass && intendedId === pendingPass.toId) {
      const passer = this.playerById(pendingPass.fromId);
      const pRole = passer?.role ?? '?';
      if (!this.statsPassByRole[pRole]) this.statsPassByRole[pRole] = { att: 0, comp: 0 };
      this.statsPassByRole[pRole].att++;
      if (collector.id === pendingPass.toId) {
        this.statsPassCompleted++;
        this.statsPassByRole[pRole].comp++;
        if (pendingPass.source === 'through_ball') this.statsThroughBallCompleted++;
      }
      else if (collector.team !== pendingPass.team) {
        this.statsPassIntercepted++;
        this.recordPassFailure();
        this.logDebug('pass_fail', { reason: 'intercepted', intended: intendedId, collector: collector.id, collectorTeam: collector.team });
        // danger pass: ball given away in own defensive third
        const passer = this.playerById(pendingPass.fromId);
        if (passer) {
          const ownGoalX = passer.team === 'home' ? HOME_GOAL_X : AWAY_GOAL_X;
          const inOwnThird = Math.abs(passer.x - ownGoalX) < PITCH_W / 3;
          if (inOwnThird) {
            const forced = this.players.filter(o => o.team !== passer.team && o.role !== 'GK' && dist(o, passer) < 60).length >= 2;
            this.logDebug('danger_pass', { from: passer.id, role: passer.role, team: passer.team, x: Math.round(passer.x), y: Math.round(passer.y), forced, collector: collector.id, collectorRole: collector.role });
          }
        }
      } else {
        this.recordPassFailure();
        this.logDebug('pass_fail', { reason: 'wrong_teammate', intended: intendedId, collector: collector.id });
      }
      this.pendingPass = null;
    }
    if (previous !== collector.id) {
      this.logDebug('possession', {
        player: collector.id,
        team: collector.team,
        role: collector.role,
        x: Math.round(collector.x),
        y: Math.round(collector.y),
      });
    }
    return true;
  }

  attemptTackle(tackler: Player, carrier: Player): boolean {
    this.qTackleAttempts.push(this.clockMs);
    const tackleSkill = attrFactor(tackler.attrs, 'tackling');
    const carrierControl = attrFactor(carrier.attrs, 'positioning') * 0.35 + attrFactor(carrier.attrs, 'speed') * 0.15;
    const facingBonus = (tackler.team === 'home' ? tackler.vx > 0 : tackler.vx < 0) ? 0.08 : -0.05;
    const carrierShielded = this.clockMs < this.receiverShieldUntil;
    const chance = clamp(0.18 + tackleSkill * 0.35 - carrierControl * 0.15 + facingBonus - (carrierShielded ? 0.20 : 0), 0.08, 0.72);
    if (random() >= chance) {
      this.logDebug('tackle_fail', { tackler: tackler.id, carrier: carrier.id, chance: Math.round(chance*100) });
      // slide tackle foul: small chance of free kick on failed tackles
      if (random() < 0.12) { this.awardFreeKick(carrier.team, tackler); }
      return false;
    }
    this.qTackleSuccesses.push(this.clockMs);
    this.logDebug('tackle_win', { tackler: tackler.id, carrier: carrier.id, chance: Math.round(chance*100) });
    this.tackleBall(tackler, carrier);
    return true;
  }

  private headBall(player: Player): void {
    this.clearTeamAssignments();
    this.ball.controllerId = null;
    const fd = player.team === 'home' ? 1 : -1;
    const dx = fd * (30 + random() * 70);
    const dy = (random() - 0.5) * 100;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const speed = 80 + random() * 100;
    this.ball.vx = dx / d * speed; this.ball.vy = dy / d * speed;
    this.recordBallImpulse();
    this.ball.lastTouchTeam = player.team; this.ball.lastToucherId = player.id;
    this.ball.intendedReceiverId = null; this.ball.z = 0; this.ball.vz = 0;
    this.logDebug('header', { player: player.id, role: player.role, team: player.team, x: Math.round(player.x), y: Math.round(player.y) });
  }

  tackleBall(tackler: Player, carrier: Player): void {
    this.clearTeamAssignments();
    this.ball.controllerId = null;
    const angle = Math.atan2(this.ball.y - tackler.y, this.ball.x - tackler.x) + (random() - 0.5) * 1.5;
    const kickSpeed = TACKLE_KICK_SPEED + random() * 150;
    this.ball.vx = Math.cos(angle) * kickSpeed; this.ball.vy = Math.sin(angle) * kickSpeed;
    this.recordBallImpulse();
    this.placeBallForRelease(tackler, this.ball.vx, this.ball.vy, CONTROL_DIST + PLAYER_R + 4);
    this.blockReboundFor(carrier.id, 450);
    this.ball.lastTouchTeam = tackler.team; this.ball.lastToucherId = tackler.id;
    this.ball.intendedReceiverId = null; this.ball.z = 0; this.ball.vz = 0;
    carrier.vx = 0; carrier.vy = 0;
  }

  private rollBallTo(from: Player, to: Player): void {
    const dx = to.x - from.x, dy = to.y - from.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const speed = 90 + d * 0.08;
    this.ball.controllerId = null;
    this.ball.lastTouchTeam = from.team; this.ball.lastToucherId = from.id;
    this.ball.vx = (dx / d) * speed; this.ball.vy = (dy / d) * speed;
    this.ball.intendedReceiverId = to.id;
    this.receiverShieldTargetId = to.id;
    this.ball.z = 0; this.ball.vz = 0;
    this.logDebug('gk_throw', { from: from.id, to: to.id, role: to.role, dist: Math.round(d) });
  }

  private awardFreeKick(team: Team, fouler: Player): void {
    this.statsFreeKicks++;
    this.ball.controllerId = null;
    this.ball.x = clamp(fouler.x, 30, PITCH_W - 30);
    this.ball.y = clamp(fouler.y, 30, PITCH_H - 30);
    this.ball.vx = 0; this.ball.vy = 0; this.ball.z = 0; this.ball.vz = 0;
    this.setPieceType = 'goal_kick'; // reuse existing restart logic
    this.setPieceTeam = team;
    this.armSetPiece();
    this.logDebug('free_kick', { team, fouler: fouler.id, role: fouler.role, x: Math.round(this.ball.x), y: Math.round(this.ball.y) });
  }

  private gkDistribute(): void {
    const gk = this.playerById(this.ball.controllerId);
    if (!gk || gk.role !== 'GK') return;
    this.clearTeamAssignments();
    // short distribution: roll/throw to nearest open defender
    const closeDef = this.players.find(p => p.team === gk.team && (p.role === 'CB' || p.role === 'FB') && dist(gk, p) < 120
      && !this.players.some(o => o.team !== gk.team && o.role !== 'GK' && dist(o, p) < 50));
    if (closeDef && random() < 0.55) {
      this.rollBallTo(gk, closeDef);
      return;
    }
    // medium throw: find fullback/winger at moderate distance
    const mediumTarget = this.players.find(p => p.team === gk.team && (p.role === 'FB' || p.role === 'WM') && dist(gk, p) > 80 && dist(gk, p) < 250
      && !this.players.some(o => o.team !== gk.team && o.role !== 'GK' && dist(o, p) < 45));
    if (mediumTarget && random() < 0.50) {
      const dx = mediumTarget.x - gk.x, dy = mediumTarget.y - gk.y;
      const d = Math.sqrt(dx*dx+dy*dy) || 1;
      const speed = 140 + d * 0.1;
      this.ball.controllerId = null;
      this.ball.lastTouchTeam = gk.team; this.ball.lastToucherId = gk.id;
      this.ball.vx = (dx/d)*speed; this.ball.vy = (dy/d)*speed;
      this.ball.intendedReceiverId = mediumTarget.id;
      this.receiverShieldTargetId = mediumTarget.id;
      this.ball.z = 0; this.ball.vz = 0;
      this.logDebug('gk_throw', { from: gk.id, to: mediumTarget.id, role: mediumTarget.role, dist: Math.round(d), type: 'medium' });
      return;
    }
    // find best open teammate — prefer progressive passes, avoid marked targets
    const teammates = this.players.filter(p => p.team === gk.team && p.role !== 'GK' && dist(gk, p) < 600);
    if (teammates.length === 0) return;
    let bestTarget: Player | null = null;
    let bestScore = -Infinity;
    for (const t of teammates) {
      const d = dist(gk, t);
      let sc = 0;
      // prefer forward passes (progressive)
      const fd = gk.team === 'home' ? 1 : -1;
      const forward = (t.x - gk.x) * fd;
      if (forward > 0) sc += forward / PITCH_W * 30;
      // penalise marked targets
      const nearbyOpps = this.players.filter(o => o.team !== gk.team && o.role !== 'GK' && dist(o, t) < 50).length;
      sc -= nearbyOpps * 15;
      // prefer fullbacks and wingers for wide distribution
      if (t.role === 'FB' || t.role === 'WM') sc += 5;
      // penalise very short passes (just gives it back to pressure)
      if (d < 80) sc -= 10;
      // bonus for being in space
      if (nearbyOpps === 0 && d > 100) sc += 8;
      if (sc > bestScore) { bestScore = sc; bestTarget = t; }
    }
    const target = bestTarget ?? teammates[0];
    this.ball.controllerId = null;
    this.ball.lastTouchTeam = gk.team; this.ball.lastToucherId = gk.id;
    const dx = target.x - gk.x, dy = target.y - gk.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    this.placeBallForRelease(gk, dx, dy);
    this.blockReleaser(gk, 700);
    const speed = PASS_SPEED_BASE + 40 + Math.min(d / 5, 30);
    this.ball.vx = (dx / d) * speed; this.ball.vy = (dy / d) * speed;
    this.recordBallImpulse();
    this.ball.intendedReceiverId = target.id;
    this.receiverShieldTargetId = target.id;
    this.ball.z = 0; this.ball.vz = 0;
    this.beginTrackedPass(gk, target, 'gk_distribution');
  }

  private tryGKSave(_secs: number): void {
    const gk = this.opponentGK();
    if (!gk) return;
    if (!this.isShotActive) return;
    if (this.clockMs - this.lastSaveMs < 300) return; // prevent double-save on consecutive ticks
    const b = this.ball;
    const shooterId = b.lastToucherId;
    const speed = Math.sqrt(b.vx ** 2 + b.vy ** 2);
    if (speed < 200) return;
    const goalX = gk.team === 'home' ? HOME_GOAL_X : AWAY_GOAL_X;
    const headingToGoal = (gk.team === 'home' && b.vx < 0) || (gk.team === 'away' && b.vx > 0);
    if (!headingToGoal) return;
    const dToGoal = Math.abs(b.x - goalX);
    if (dToGoal > 250) return;
    const crossY = b.y + b.vy * (dToGoal / Math.abs(b.vx));
    if (crossY < PITCH_H / 2 - GOAL_W / 2 || crossY > PITCH_H / 2 + GOAL_W / 2) return;
    const originDistance = this.qShotOrigin
      ? Math.hypot(this.qShotOrigin.x - goalX, this.qShotOrigin.y - PITCH_H / 2)
      : Math.sqrt((b.x - gk.x) ** 2 + (b.y - gk.y) ** 2);
    const keeperSkill = attrFactor(gk.attrs, 'positioning') * 0.58 + attrFactor(gk.attrs, 'speed') * 0.19;
    const reactionBonus = clamp((originDistance - 65) / 300, 0, 0.25);
    const placementPenalty = clamp(Math.abs(crossY - gk.y) / 70, 0, 1) * 0.30;
    const speedPenalty = clamp((speed - 450) / 350, 0, 0.15);
    const saveChance = clamp(0.11 + keeperSkill + reactionBonus - placementPenalty - speedPenalty, 0.08, 0.86);
    this.statsShotsOnTarget++;
    this.isShotActive = false;
    if (random() < saveChance) {
      this.statsSaves++;
      this.qConsecutiveSaves++;
      this.qShotOrigin = null;
      this.lastSaveMs = this.clockMs;
      this.emitEvent('save', gk.x, gk.y);
      const handling = attrFactor(gk.attrs, 'positioning');
      const catchChance = clamp(0.22 + handling * 0.38 - Math.max(0, speed - 520) / 900, 0.12, 0.58);
      if (random() < catchChance) {
        this.ball.x = gk.x;
        this.ball.y = gk.y;
        this.collectBall(gk);
        return;
      }

      this.blockReboundFor(shooterId, 1400);
      const fieldDir = gk.team === 'home' ? 1 : -1;
      const shooter = this.playerById(shooterId);
      let side = shooter ? Math.sign(gk.y - shooter.y) : Math.sign(gk.y - PITCH_H / 2);
      if (side === 0) side = random() < 0.5 ? -1 : 1;
      const parrySpeedX = 155 + speed * 0.10;
      const parrySpeedY = 140 + random() * 90;
      b.x = clamp(gk.x + fieldDir * 28, 10, PITCH_W - 10);
      b.y = clamp(gk.y + side * 24, 18, PITCH_H - 18);
      b.vx = fieldDir * parrySpeedX;
      b.vy = side * parrySpeedY;
      this.recordBallImpulse();
      b.z = 0; b.vz = 0;
      const defenderId = this.nearestDefenderId(gk);
      b.intendedReceiverId = defenderId;
      this.receiverShieldTargetId = defenderId;
      b.lastTouchTeam = gk.team; b.lastToucherId = gk.id;
    } else {
      this.qConsecutiveSaves = 0;
    }
  }

  private nearestDefenderId(gk: Player): number | null {
    let best: Player | null = null;
    let bestDist = Infinity;
    for (const p of this.playersByTeam.get(gk.team) ?? []) {
      if (p.role !== 'CB') continue;
      const d = dist(gk, p);
      if (d < bestDist) { bestDist = d; best = p; }
    }
    return best?.id ?? null;
  }

  private opponentGK(): Player | null {
    if (!this.ball.lastTouchTeam) return null;
    const opp = this.ball.lastTouchTeam === 'home' ? 'away' : 'home';
    return this.gkByTeam.get(opp) ?? null;
  }

  private updateGK(sdt: number): void {
    const secs = sdt / 1000;
    for (const [, gk] of this.gkByTeam) {
      const goalX = gk.team === 'home' ? HOME_GOAL_X : AWAY_GOAL_X;
      const bdg = Math.abs(this.ball.x - goalX);
      const fd = gk.team === 'home' ? 1 : -1;
      const ballInOurHalf = gk.team === 'home' ? this.ball.x < PITCH_W * 0.55 : this.ball.x > PITCH_W * 0.45;
      // sweep: come off line for through balls heading toward goal
      const ballTowardGoal = (gk.team === 'home' ? this.ball.vx < 0 : this.ball.vx > 0);
      const ballSpeed = Math.sqrt(this.ball.vx ** 2 + this.ball.vy ** 2);
      const inPenaltyArea = bdg < PENALTY_AREA_W && Math.abs(this.ball.y - gk.homeY) < PENALTY_AREA_H / 2;
      if (inPenaltyArea && ballTowardGoal && ballSpeed > 100 && this.ball.controllerId === null) {
        const interceptX = clamp(this.ball.x + this.ball.vx * 0.4, goalX, goalX + fd * 180);
        const interceptY = clamp(this.ball.y + this.ball.vy * 0.4, PITCH_H * 0.15, PITCH_H * 0.85);
        gk.targetX = interceptX;
        gk.targetY = interceptY;
      } else if (bdg < GK_RUSH_DIST) {
        gk.targetX = goalX + fd * Math.min(bdg * 0.5, 150);
        gk.targetY = clamp(lerp(gk.homeY, this.ball.y, 0.3), PITCH_H * 0.2, PITCH_H * 0.8);
      } else if (ballInOurHalf) {
        gk.targetX = gk.homeX;
        gk.targetY = clamp(lerp(gk.homeY, this.ball.y, 0.15), PITCH_H * 0.2, PITCH_H * 0.8); // slow tracking
      } else {
        gk.targetX = gk.homeX;
        gk.targetY = gk.homeY; // stay centered when ball is far
      }
      const ms = attrFactor(gk.attrs, 'speed') * MAX_PLAYER_SPEED * 0.55; // GK moves slower than outfield
      const dx = gk.targetX - gk.x, dy = gk.targetY - gk.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > 1) { const sp = Math.min(ms * secs, d); gk.x += (dx / d) * sp; gk.y += (dy / d) * sp; }
      gk.x = clamp(gk.x, 5, PITCH_W - 5); gk.y = clamp(gk.y, 5, PITCH_H - 5);
    }
  }

  private controlTicks = 0;

  private updateControlledBall(secs: number): void {
    const c = this.playerById(this.ball.controllerId);
    if (!c) return;
    if (this.kickoffPhase) {
      this.ball.x = clamp(this.ball.x, HALF_X - 2, HALF_X + 2);
      this.ball.y = clamp(this.ball.y, PITCH_H / 2 - 2, PITCH_H / 2 + 2);
      this.ball.lastTouchTeam = c.team; this.ball.lastToucherId = c.id;
      return;
    }
    // shield ball away from nearest opponent, or toward attack direction
    const fd = c.team === 'home' ? 1 : -1;
    let shieldDx = fd, shieldDy = 0;

    let nearestOppDist = Infinity;
    for (const p of this.players) {
      if (p.team === c.team || p.role === 'GK') continue;
      const d = dist(c, p);
      if (d < 40 && d < nearestOppDist) {
        nearestOppDist = d;
        const sdx = c.x - p.x, sdy = c.y - p.y;
        const sd = Math.sqrt(sdx * sdx + sdy * sdy);
        if (sd > 1) { shieldDx = sdx / sd; shieldDy = sdy / sd; }
      }
    }

    const tx = c.x + shieldDx * CONTROL_DIST, ty = c.y + shieldDy * CONTROL_DIST;
    const dx = tx - this.ball.x, dy = ty - this.ball.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    this.controlTicks++;
    const followSpeed = this.controlTicks < 8 ? 150 + this.controlTicks * 30 : 400;
    if (d > 0.5) {
      const m = Math.min(followSpeed * secs, d);
      this.ball.x += (dx / d) * m; this.ball.y += (dy / d) * m;
    }
    this.ball.lastTouchTeam = c.team; this.ball.lastToucherId = c.id;
  }

  private moveBallCarrier(sdt: number): void {
    const c = this.playerById(this.ball.controllerId);
    if (!c) return;
    const secs = sdt / 1000;
    const ts = attrFactor(c.attrs, 'speed') * DRIBBLE_MAX;
    const dx = c.targetX - c.x, dy = c.targetY - c.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    const prevX = c.x, prevY = c.y;
    if (d > 1) {
      const step = Math.min(ts * secs, d);
      c.x += (dx / d) * step; c.y += (dy / d) * step;
    }
    c.x = clamp(c.x, 5, PITCH_W - 5); c.y = clamp(c.y, 5, PITCH_H - 5);
    c.vx = (c.x - prevX) / secs; c.vy = (c.y - prevY) / secs;
  }

  private applySeparation(secs: number): void {
    const md = SEPARATION_DIST; const f = SEPARATION_FORCE;
    for (let i = 0; i < this.players.length; i++) {
      for (let j = i + 1; j < this.players.length; j++) {
        const a = this.players[i], b = this.players[j];
        const d = dist(a, b);
        const minDist = a.team === b.team ? md : md * 0.82;
        if (d < minDist && d > 0.1) {
          const nx = (a.x - b.x) / d, ny = (a.y - b.y) / d;
          const teamScale = a.team === b.team ? 1 : 0.55;
          const push = ((minDist - d) / minDist) * f * teamScale * secs;
          a.x += nx * push; a.y += ny * push;
          b.x -= nx * push; b.y -= ny * push;
        }
      }
    }
    for (const p of this.players) {
      p.x = clamp(p.x, 5, PITCH_W - 5);
      p.y = clamp(p.y, 5, PITCH_H - 5);
    }
  }

  private checkOutOfPlay(): void {
    const b = this.ball; const lt = this.ball.lastTouchTeam;
    if (b.y < -25 || b.y > PITCH_H + 25) {
      if (this.isShotActive) { this.statsShotsOffTarget++; this.isShotActive = false; this.qShotOrigin = null; this.qConsecutiveSaves = 0; }
      this.awardThrowIn(lt, b.y < 0 ? 0 : PITCH_H); return;
    }
    if (b.x < -25) {
      const inGoal = b.y > PITCH_H / 2 - GOAL_W / 2 && b.y < PITCH_H / 2 + GOAL_W / 2;
      if (!inGoal) {
        if (this.isShotActive) { this.statsShotsOffTarget++; this.isShotActive = false; this.qShotOrigin = null; this.qConsecutiveSaves = 0; }
        this.failPendingPass('out_of_play');
        if (lt === 'away') this.awardSetPiece('goal_kick', 'home');
        else if (lt === 'home') this.awardSetPiece('corner', 'away');
        else this.awardSetPiece('goal_kick', 'home');
      } return;
    }
    if (b.x > PITCH_W + 25) {
      const inGoal = b.y > PITCH_H / 2 - GOAL_W / 2 && b.y < PITCH_H / 2 + GOAL_W / 2;
      if (!inGoal) {
        if (this.isShotActive) { this.statsShotsOffTarget++; this.isShotActive = false; this.qShotOrigin = null; this.qConsecutiveSaves = 0; }
        this.failPendingPass('out_of_play');
        if (lt === 'home') this.awardSetPiece('goal_kick', 'away');
        else if (lt === 'away') this.awardSetPiece('corner', 'home');
        else this.awardSetPiece('goal_kick', 'away');
      }
    }
  }

  private awardThrowIn(lt: Team | null, y: number): void {
    this.recordOutOfPlay();
    this.failPendingPass('out_of_play');
    if (this.pendingPass) {
      const passer = this.playerById(this.pendingPass.fromId);
      this.logDebug('stray_pass', { reason: 'into_touch', from: this.pendingPass.fromId, intended: this.pendingPass.toId, passerX: passer ? Math.round(passer.x) : '?', passerY: passer ? Math.round(passer.y) : '?' });
    }
    const exitX = Math.round(this.ball.x);
    const exitY = Math.round(this.ball.y);
    this.setPieceType = 'throw_in';
    // opposite of last touch team gets the throw
    if (lt === 'home') this.setPieceTeam = 'away';
    else if (lt === 'away') this.setPieceTeam = 'home';
    else this.setPieceTeam = this.ball.x < PITCH_W/2 ? 'away' : 'home';
    // alert: suspicious throw-in (throwing team = last touch team indicates bug)
    if (lt && lt === this.setPieceTeam) this.logDebug('throw_in_bug', { lastTouch: lt, awardedTo: this.setPieceTeam, fallback: !lt, bx: Math.round(this.ball.x) });
    this.statsThrowInsTaken++;
    // x at crossing point, clamped to pitch
    this.ball.x = clamp(this.ball.x, 10, PITCH_W - 10);
    this.ball.y = clamp(y, 10, PITCH_H - 10);
    this.ball.vx = 0; this.ball.vy = 0; this.ball.controllerId = null;
    this.recordBallImpulse();
    this.qBallPrevSpeed = 0;
    this.ball.intendedReceiverId = null;
    this.logDebug('set_piece_awarded', {
      type: 'throw_in',
      team: this.setPieceTeam,
      lastTouchTeam: lt,
      exitX,
      exitY,
      restartX: Math.round(this.ball.x),
      restartY: Math.round(this.ball.y),
    });
    this.armSetPiece();
  }

  private awardSetPiece(type: 'goal_kick' | 'corner', team: Team): void {
    this.recordOutOfPlay();
    this.failPendingPass('out_of_play');
    if (type === 'corner') this.statsCornersTaken++;
    const exitX = Math.round(this.ball.x);
    const exitY = Math.round(this.ball.y);
    const lastTouchTeam = this.ball.lastTouchTeam;
    this.setPieceType = type; this.setPieceTeam = team;
    this.ball.vx = 0; this.ball.vy = 0; this.ball.controllerId = null; this.ball.intendedReceiverId = null;
    this.recordBallImpulse();
    this.qBallPrevSpeed = 0;
    if (type === 'goal_kick') {
      const gk = this.gkByTeam.get(team);
      this.ball.x = gk ? gk.x : (team === 'home' ? 30 : PITCH_W - 30);
      this.ball.y = gk ? gk.y : PITCH_H / 2;
    } else {
      // corner at the side where ball exited
      const exitY = this.ball.y < PITCH_H / 2 ? 5 : PITCH_H - 5;
      const exitX = this.ball.x < PITCH_W / 2 ? 5 : PITCH_W - 5;
      this.ball.x = exitX;
      this.ball.y = exitY;
    }
    this.logDebug('set_piece_awarded', {
      type,
      team,
      lastTouchTeam,
      exitX,
      exitY,
      restartX: Math.round(this.ball.x),
      restartY: Math.round(this.ball.y),
    });
    this.armSetPiece();
  }

  private armSetPiece(): void {
    this.setPieceArmed = true; this.actionTimer = 900;
    this.setPieceTakerId = this.findSetPieceTaker()?.id ?? null;
    for (const p of this.players) { p.vx = 0; p.vy = 0; }
    this.setAttackingPositions(this.setPieceTeam);
  }

  private giveBallToTaker(): void {
    const taker = this.findSetPieceTaker();
    if (!taker) return;
    this.moveTakerToRestart(taker);
    this.ball.controllerId = taker.id;
    this.ball.lastTouchTeam = taker.team; this.ball.lastToucherId = taker.id;
    this.ball.vx = 0; this.ball.vy = 0;
    this.recordControlChange(taker);
    this.actionTimer = 400; this.kickoffPhase = false;
    if (taker.role === 'GK') this.gkDistributeTimer = 500;

    // corner cross: taker kicks ball into the box immediately
    if (this.setPieceType === 'corner') {
      this.actionTimer = 200;
      // short corner option: pass to nearby teammate instead of crossing (30% chance)
      if (random() < 0.30) {
        const shortTarget = this.players.find(p => p.team === taker.team && p.id !== taker.id && p.role !== 'GK' && dist(taker, p) < 150);
        if (shortTarget) {
          this.passBallTo(taker, shortTarget);
          this.logDebug('short_corner', { taker: taker.id, target: shortTarget.id, role: shortTarget.role });
          return;
        }
      }
      this.cornerCrossPending = true;
      this.cornerCrossTaker = taker.id;
    }

    this.logDebug('set_piece_taker', {
      type: this.setPieceType,
      team: this.setPieceTeam,
      taker: taker.id,
      role: taker.role,
      x: Math.round(taker.x),
      y: Math.round(taker.y),
    });
    this.setPieceTakerId = null;
  }

  private findSetPieceTaker(): Player | undefined {
    const team = this.setPieceTeam;
    if (this.setPieceType === 'goal_kick') return this.gkByTeam.get(team);
    if (this.setPieceTakerId !== null) {
      const existing = this.playerById(this.setPieceTakerId);
      if (existing && existing.team === team) return existing;
    }

    const candidates = (this.playersByTeam.get(team) ?? []).filter(p => p.role !== 'GK');
    const byRestartFit = candidates
      .map(p => {
        const rolePenalty = p.role === 'CM' ? -18 : p.role === 'CB' ? 0 : 14;
        const sidePenalty = this.setPieceType === 'throw_in' && Math.abs(p.y - this.ball.y) > PITCH_H * 0.35 ? 55 : 0;
        return { p, score: dist(p, this.ball) + rolePenalty + sidePenalty };
      })
      .sort((a, b) => a.score - b.score);
    return byRestartFit[0]?.p ?? candidates[0];
  }

  private moveTakerToRestart(taker: Player): void {
    if (this.setPieceType === 'goal_kick') return;
    const fd = taker.team === 'home' ? 1 : -1;
    const restartX = clamp(this.ball.x - fd * CONTROL_DIST, 5, PITCH_W - 5);
    const restartY = clamp(this.ball.y, 5, PITCH_H - 5);
    if (dist(taker, { x: restartX, y: restartY }) > 24) {
      this.logDebug('set_piece_taker_reposition', {
        type: this.setPieceType,
        team: this.setPieceTeam,
        taker: taker.id,
        fromX: Math.round(taker.x),
        fromY: Math.round(taker.y),
        toX: Math.round(restartX),
        toY: Math.round(restartY),
      });
    }
    taker.x = restartX;
    taker.y = restartY;
    taker.targetX = restartX;
    taker.targetY = restartY;
    taker.vx = 0;
    taker.vy = 0;
    this.qPlayerLastMoved.delete(taker.id);
  }

  private setAttackingPositions(team: Team): void {
    const fd = team === 'home' ? 1 : -1;
    const isCorner = this.setPieceType === 'corner';
    const goalX = fd === 1 ? AWAY_GOAL_X : HOME_GOAL_X;

    for (const p of this.players) {
      if (p.team !== team) {
        if (isCorner) {
          // defending team: pack the 6-yard box and mark
          p.targetX = goalX - fd * (15 + random() * 50);
          p.targetY = clamp(PITCH_H/2 + (p.homeY - PITCH_H/2)*0.5 + (random()-0.5)*40, PITCH_H*0.28, PITCH_H*0.72);
          if (p.role === 'GK') { p.targetX = goalX - fd * 8; p.targetY = PITCH_H/2; }
        } else {
          p.targetX = lerp(p.homeX, p.homeX + fd * -100, 0.3);
          p.targetY = p.homeY;
        }
        continue;
      }

      if (isCorner) {
        switch (p.role) {
          case 'GK': p.targetX = fd===1?HOME_GOAL_X+30:AWAY_GOAL_X-30; p.targetY=PITCH_H/2; break;
          case 'CB':
            // tall players: near post and far post
            if (random() < 0.5) p.targetX = goalX - fd*25; // near post
            else p.targetX = goalX - fd*70; // far post
            p.targetY = clamp(PITCH_H/2 + (p.homeY<PITCH_H/2?-35:35), PITCH_H*0.30, PITCH_H*0.70);
            break;
          case 'CF':
            // attack the ball: center of box
            p.targetX = goalX - fd*(30 + random()*60);
            p.targetY = clamp(PITCH_H/2 + (random()-0.5)*80, PITCH_H*0.28, PITCH_H*0.72);
            break;
          case 'CM':
            // edge of box and short option
            if (random() < 0.25) { p.targetX = this.ball.x+fd*30; p.targetY = this.ball.y+20; }
            else { p.targetX = goalX - fd*130; p.targetY = clamp(PITCH_H/2+(random()-0.5)*120, PITCH_H*0.2, PITCH_H*0.8); }
            break;
          case 'WM':
          case 'FB':
            // wide options: near post/far post runs
            if (random() < 0.3) { p.targetX = this.ball.x+fd*25; p.targetY = this.ball.y+15; }
            else { p.targetX = goalX - fd*(40+random()*60); p.targetY = clamp(PITCH_H/2+(p.homeY<PITCH_H/2?-40:40), PITCH_H*0.25, PITCH_H*0.75); }
            break;
        }
      } else {
        switch (p.role) {
          case 'GK': p.targetX = fd === 1 ? HOME_GOAL_X + 30 : AWAY_GOAL_X - 30; p.targetY = PITCH_H / 2; break;
          case 'CB': p.targetX = lerp(p.homeX, HALF_X + fd * 100, 0.4); p.targetY = p.homeY; break;
          case 'CM': p.targetX = lerp(p.homeX, HALF_X + fd * 250, 0.5); p.targetY = p.homeY; break;
          case 'CF': p.targetX = lerp(p.homeX, HALF_X + fd * 400, 0.6); p.targetY = p.homeY; break;
        }
      }
    }
  }

  private kickoff(team = this.nextKickoffTeam): void {
    this.nextKickoffTeam = team === 'home' ? 'away' : 'home';
    this.prepareKickoff(team);
  }

  private prepareKickoff(team: Team): void {
    for (const p of this.players) {
      const pos = this.kickoffPositionFor(p, team);
      p.x = pos.x; p.y = pos.y;
      p.targetX = pos.x; p.targetY = pos.y;
      p.vx = 0; p.vy = 0;
    }
    const cf = this.players.find(p => p.team === team && p.role === 'CF')!;
    cf.x = HALF_X; cf.y = PITCH_H / 2;
    cf.targetX = HALF_X; cf.targetY = PITCH_H / 2;
    this.ball.x = HALF_X; this.ball.y = PITCH_H / 2;
    this.ball.vx = 0; this.ball.vy = 0; this.ball.z = 0; this.ball.vz = 0;
    this.recordBallImpulse();
    this.qBallPrevSpeed = 0;
    this.ball.controllerId = cf.id;
    this.ball.lastTouchTeam = cf.team; this.ball.lastToucherId = cf.id;
    this.ball.intendedReceiverId = null;
    this.recordControlChange(cf);
    this.qPlayerLastMoved.clear();
    this.setPieceArmed = false;
    this.setPieceTakerId = null;
    this.gkDistributeTimer = 0;
    this.actionTimer = 600; this.kickoffPhase = true;
  }

  private kickoffPositionFor(p: Player, kickoffTeam: Team): { x: number; y: number } {
    const margin = p.team === kickoffTeam ? 30 : 45;
    const ownHalfX = p.team === 'home'
      ? clamp(p.homeX, 25, HALF_X - margin)
      : clamp(p.homeX, HALF_X + margin, PITCH_W - 25);
    return { x: ownHalfX, y: p.homeY };
  }

  private holdKickoffShape(): void {
    for (const p of this.players) {
      if (p.id === this.ball.controllerId) continue;
      const pos = this.kickoffPositionFor(p, this.ball.lastTouchTeam ?? 'home');
      p.x = pos.x; p.y = pos.y;
      p.targetX = pos.x; p.targetY = pos.y;
      p.vx = 0; p.vy = 0;
    }
  }

  private kickoffTap(): void {
    const holder = this.playerById(this.ball.controllerId);
    if (!holder) return;
    const mids = this.players.filter(p => p.team === holder.team && p.role === 'CM' && p.id !== holder.id);
    if (mids.length === 0) return;
    const teammate = mids[Math.floor(random() * mids.length)];
    if (!teammate) return;
    this.clearTeamAssignments();
    this.ball.controllerId = null;
    this.ball.lastTouchTeam = holder.team; this.ball.lastToucherId = holder.id;
    const dx = teammate.x - holder.x, dy = teammate.y - holder.y;
    const rawDist = Math.sqrt(dx * dx + dy * dy);
    const speed = 180 + rawDist * 0.2;
    this.placeBallForRelease(holder, dx, dy);
    this.blockReleaser(holder, 650);
    this.ball.vx = (dx / rawDist) * speed;
    this.ball.vy = (dy / rawDist) * speed;
    this.recordBallImpulse();
    this.ball.intendedReceiverId = teammate.id;
    this.receiverShieldTargetId = teammate.id;
    this.ball.z = 0; this.ball.vz = 0;
    this.beginTrackedPass(holder, teammate, 'kickoff');
  }

  private checkGoal(): void {
    const b = this.ball;
    const inLeft = b.x < 5 && b.y > PITCH_H / 2 - GOAL_W / 2 && b.y < PITCH_H / 2 + GOAL_W / 2;
    const inRight = b.x > PITCH_W - 5 && b.y > PITCH_H / 2 - GOAL_W / 2 && b.y < PITCH_H / 2 + GOAL_W / 2;
    if (inLeft) { this.recordGoalQuality('away', HOME_GOAL_X); this.awayScore++; this.emitEvent('goal', b.x, b.y); this.resetAfterGoal('home'); }
    else if (inRight) { this.recordGoalQuality('home', AWAY_GOAL_X); this.homeScore++; this.emitEvent('goal', b.x, b.y); this.resetAfterGoal('away'); }
  }

  private recordGoalQuality(scoringTeam: Team, goalX: number): void {
    if (this.isShotActive) this.statsShotsOnTarget++;
    if (this.qShotOrigin?.team === scoringTeam) {
      const shotDistance = Math.abs(goalX - this.qShotOrigin.x);
      if (shotDistance > 450) {
        this.logQualityFlag('long_range_goal', { team: scoringTeam, distance: Math.round(shotDistance) });
      }
    }
    this.isShotActive = false;
    this.pendingPass = null;
    this.qShotOrigin = null;
    this.qConsecutiveSaves = 0;
  }

  private resetAfterGoal(kickoffTeam: Team): void {
    this.prepareKickoff(kickoffTeam);
  }

  private executeCornerCross(): void {
    const taker = this.playerById(this.cornerCrossTaker);
    if (!taker) return;
    const fd = taker.team === 'home' ? 1 : -1;
    const goalX = fd === 1 ? AWAY_GOAL_X : HOME_GOAL_X;
    // target: random spot in the danger zone
    const targetX = goalX - fd * (30 + random() * 80);
    const targetY = PITCH_H / 2 + (random() - 0.5) * 120;
    this.ball.controllerId = null;
    this.ball.lastTouchTeam = taker.team; this.ball.lastToucherId = taker.id;
    const dx = targetX - taker.x, dy = targetY - taker.y;
    const dist = Math.sqrt(dx*dx + dy*dy);
    const speed = 280 + dist * 0.2;
    this.ball.vx = (dx/dist) * speed;
    this.ball.vy = (dy/dist) * speed;
    this.recordBallImpulse();
    this.ball.vz = speed * 0.5; // high arc
    this.ball.intendedReceiverId = null;
    this.clearTeamAssignments();
    this.cornerCrossTaker = null;
  }

  private checkOffside(receiver: Player, passer: Player): boolean {
    const fd = passer.team === 'home' ? 1 : -1;
    const inOpponentHalf = fd === 1 ? receiver.x > HALF_X : receiver.x < HALF_X;
    const aheadOfBall = fd === 1 ? receiver.x > passer.x + 5 : receiver.x < passer.x - 5;
    if (!inOpponentHalf || !aheadOfBall) return false;
    const opponents = this.players.filter(p => p.team !== passer.team);
    if (opponents.length < 2) return false;
    // Offside is judged against the second-last opponent, commonly including the goalkeeper.
    const sorted = [...opponents].sort((a, b) => fd === 1 ? b.x - a.x : a.x - b.x);
    const offsideLine = sorted[1].x; // second-to-last
    return fd === 1 ? receiver.x > offsideLine + 5 : receiver.x < offsideLine - 5;
  }

  private awardOffsideFreeKick(defendingTeam: Team, offsidePlayer: Player): void {
    this.ball.x = clamp(offsidePlayer.x, 20, PITCH_W - 20);
    this.ball.y = clamp(offsidePlayer.y, 20, PITCH_H - 20);
    this.ball.vx = 0; this.ball.vy = 0; this.ball.z = 0; this.ball.vz = 0;
    this.recordBallImpulse();
    this.qBallPrevSpeed = 0;
    this.ball.controllerId = null;
    this.setPieceType = 'goal_kick'; // treat like goal kick for simplicity
    this.setPieceTeam = defendingTeam;
    this.armSetPiece();
  }

  private simQualityCheck(): void {
    const elapsedMs = this.clockMs - this.qLastQualityCheck;
    if (elapsedMs < 500) return;
    this.qLastQualityCheck = this.clockMs;
    const b = this.ball; const bs = Math.sqrt(b.vx ** 2 + b.vy ** 2);

    // 1. Ball unclaimed for too long
    if (b.controllerId === null && (!this.pendingPass || bs < 30)) this.qBallUnclaimedSince += 500;
    else this.qBallUnclaimedSince = 0;
    if (this.qBallUnclaimedSince > 1500) this.logQualityFlag('ball_unclaimed', { ms: this.qBallUnclaimedSince });

    // 2. Rapid possession changes
    this.qPossessionChanges = this.qPossessionChanges.filter(t => t >= this.clockMs - 5000);
    if (this.qPossessionChanges.length > 8) {
      this.logQualityFlag('rapid_control_changes', { count: this.qPossessionChanges.length, windowMs: 5000 });
    }
    if (b.controllerId !== null && this.qLastPossessionTeam !== null && this.clockMs - this.qLastPossessionTeamChange > 90000) {
      this.logQualityFlag('sustained_team_possession', { team: this.qLastPossessionTeam, ms: Math.round(this.clockMs - this.qLastPossessionTeamChange) }, 30000);
    }

    // 3. Player frozen
    for (const p of this.players) {
      if (p.role === 'GK') continue;
      const pr = this.qPlayerLastMoved.get(p.id);
      if (!pr) {
        this.qPlayerLastMoved.set(p.id, { x: p.x, y: p.y, stuckSince: this.clockMs });
        continue;
      }
      const moved = Math.hypot(p.x - pr.x, p.y - pr.y);
      const wantsToMove = Math.hypot(p.targetX - p.x, p.targetY - p.y) > 10;
      if (!this.setPieceArmed && !this.kickoffPhase && moved / (elapsedMs / 1000) > SPEED_SPRINT * 1.45) {
        this.logQualityFlag('improbable_player_speed', { player: p.id, role: p.role, speed: Math.round(moved / (elapsedMs / 1000)) }, 10000, `improbable_player_speed:${p.id}`);
      }
      if (moved < 2 && wantsToMove) {
        if (this.clockMs - pr.stuckSince > 3000) {
          this.logQualityFlag('player_stuck', { player: p.id, role: p.role, ms: Math.round(this.clockMs - pr.stuckSince) }, 10000, `player_stuck:${p.id}`);
        }
      } else {
        this.qPlayerLastMoved.set(p.id, { x: p.x, y: p.y, stuckSince: this.clockMs });
      }
    }

    if (bs > 800) this.logQualityFlag('ball_over_speed', { speed: Math.round(bs) });

    // 6. Ball speed spike
    if (Math.abs(bs - this.qBallPrevSpeed) > 400 && this.clockMs - this.qLastBallImpulseMs > 600) {
      this.logQualityFlag('ball_speed_spike', { from: Math.round(this.qBallPrevSpeed), to: Math.round(bs) });
    }
    this.qBallPrevSpeed = bs;

    // 7. Low tackle success rate
    this.qTackleAttempts = this.qTackleAttempts.filter(t => t >= this.clockMs - 60000);
    this.qTackleSuccesses = this.qTackleSuccesses.filter(t => t >= this.clockMs - 60000);
    if (this.qTackleAttempts.length >= 10) {
      const rate = this.qTackleSuccesses.length / this.qTackleAttempts.length;
      if (rate < 0.2) this.logQualityFlag('low_tackle_success', { rate: Math.round(rate * 100), attempts: this.qTackleAttempts.length }, 15000);
    }

    // 8. Low pass completion
    this.qPassAttempts = this.qPassAttempts.filter(t => t >= this.clockMs - 60000);
    this.qPassFails = this.qPassFails.filter(t => t >= this.clockMs - 60000);
    if (this.qPassAttempts.length >= 15) {
      const rate = 1 - this.qPassFails.length / this.qPassAttempts.length;
      if (rate < 0.55) this.logQualityFlag('low_pass_completion', { rate: Math.round(rate * 100), attempts: this.qPassAttempts.length }, 15000);
    }

    // 9. No shots for too long
    if (this.clockMs > 240000 && this.clockMs - this.qLastShotMs > 240000) this.logQualityFlag('no_shots', { ms: Math.round(this.clockMs - this.qLastShotMs) }, 120000);

    // 10. Possession imbalance
    const tp = this.statsPossession.home + this.statsPossession.away;
    if (tp > 1800) {
      const hp = this.statsPossession.home / tp;
      if (hp > 0.80 || hp < 0.20) this.logQualityFlag('possession_imbalance', { homePct: Math.round(hp*100) }, 30000);
    }

    // 11. Crowding — too many players near ball
    const nb = this.players.filter(p => dist(p, b) < 60).length;
    if (nb > 10) this.logQualityFlag('crowding', { playersNearBall: nb });

    // 12. Ball too high (z > 80)
    if (b.z > 80) this.logQualityFlag('ball_too_high', { z: Math.round(b.z) });

    // 13. Ball remains in one third for an extended period.
    const third: 'homeDef' | 'mid' | 'awayDef' = b.x < PITCH_W / 3 ? 'homeDef' : b.x > PITCH_W * 2 / 3 ? 'awayDef' : 'mid';
    if (this.qBallThird !== third) {
      this.qBallThird = third;
      this.qBallThirdSince = this.clockMs;
    } else if (this.clockMs - this.qBallThirdSince > 60000) {
      this.logQualityFlag('stale_ball_territory', { third, ms: Math.round(this.clockMs - this.qBallThirdSince) }, 30000);
    }

    // 14. GK consecutive saves
    if (this.qConsecutiveSaves > 4) this.logQualityFlag('gk_consecutive_saves', { count: this.qConsecutiveSaves });

    // 15. Ball bouncing off same player
    // Pinball is logged at collision time so repeated rebounds retain the responsible player id.

    // 16. Defensive third empty — no defenders near goal
    const homeDefInBox = this.players.filter(p => p.team === 'home' && (p.role === 'CB' || p.role === 'FB') && Math.abs(p.x - HOME_GOAL_X) < PENALTY_AREA_W).length;
    const awayDefInBox = this.players.filter(p => p.team === 'away' && (p.role === 'CB' || p.role === 'FB') && Math.abs(p.x - AWAY_GOAL_X) < PENALTY_AREA_W).length;
    if (homeDefInBox === 0 && Math.abs(b.x - HOME_GOAL_X) < 200) this.logQualityFlag('defensive_line_absent', { team: 'home' }, 10000, 'defensive_line_absent:home');
    if (awayDefInBox === 0 && Math.abs(b.x - AWAY_GOAL_X) < 200) this.logQualityFlag('defensive_line_absent', { team: 'away' }, 10000, 'defensive_line_absent:away');

    // 17. Ball stationary too long while in play
    if (bs < 3 && b.controllerId === null && this.qBallUnclaimedSince > 3000) this.logQualityFlag('ball_stationary_in_play', { ms: this.qBallUnclaimedSince });

    // Shot-from-own-half and repeated-pass-pair flags are recorded at action time.

    // 20. GK out of position
    for (const [, gk] of this.gkByTeam) {
      const goalX = gk.team === 'home' ? HOME_GOAL_X : AWAY_GOAL_X;
      if (Math.abs(gk.x - goalX) > 250) this.logQualityFlag('gk_out_of_position', { team: gk.team, distFromGoal: Math.round(Math.abs(gk.x - goalX)) }, 10000, `gk_out_of_position:${gk.team}`);
    }
  }
}
