import { GameEngine } from './engine';
import { createManager } from './manager';
import { setSeed } from './random';
import { createTeam, resetIds } from './teams';
import { FORMATIONS, type Player, type Team } from './types';
import { AWAY_GOAL_X, PITCH_H, DRIBBLE_CLOSE_SPEED, DRIBBLE_MEDIUM_SPEED, DRIBBLE_FAST_SPEED, DRIBBLE_KNOCK_SPEED_ADVANTAGE } from './constants';

interface ScenarioEngine {
  pendingPass: {
    fromId: number;
    team: Team;
    toId: number;
    source: string;
    isCross: boolean;
    launchPressure: number;
  } | null;
  resolvePendingPassOnContact(receiver: Player, contact: 'control' | 'header'): void;
  checkBallPlayerCollision(secs: number): void;
  trackFinalThirdPossession(): void;
  cornerCrossPending: boolean;
  cornerCrossTaker: number | null;
  actionTimer: number;
  kickoffPhase: boolean;
  moveBallCarrier(sdt: number): void;
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function createEngine(seed: number): GameEngine {
  setSeed(seed);
  resetIds();
  const home = createManager('home', false, FORMATIONS[1]);
  const away = createManager('away', false, FORMATIONS[1]);
  return new GameEngine([...createTeam('home', home.formation), ...createTeam('away', away.formation)], home, away);
}

function outfielder(engine: GameEngine, team: Team): Player {
  const player = engine.players.find(candidate => candidate.team === team && candidate.role !== 'GK');
  if (!player) throw new Error(`No ${team} outfielder available`);
  return player;
}

function contactBoundsScenario(): void {
  const engine = createEngine(7);
  const home = outfielder(engine, 'home');
  const away = outfielder(engine, 'away');
  home.x = 100; home.y = 100;
  away.x = 125; away.y = 100;
  engine.ball.x = home.x + 12; engine.ball.y = home.y; engine.ball.controllerId = home.id;
  assert(!engine.collectBall(away, 'scenario_illegal_control', 36.4), 'controlled opponent ball was collected');

  engine.ball.controllerId = null;
  engine.ball.x = away.x + 21; engine.ball.y = away.y; engine.ball.vx = 0; engine.ball.vy = 0;
  assert(!engine.collectBall(away, 'scenario_long_reach'), 'ordinary collection succeeded from 21 px');

  engine.ball.controllerId = home.id;
  engine.ball.x = home.x + 12; engine.ball.y = home.y;
  away.x = home.x + 25; away.y = home.y;
  assert(!engine.attemptTackle(away, home), 'tackle succeeded from 25 px');
}

function crossCompletionScenario(): void {
  const engine = createEngine(8);
  const from = engine.players.find(player => player.team === 'home' && player.role === 'WM') ?? outfielder(engine, 'home');
  const receiver = engine.players.find(player => player.team === 'home' && player.role === 'CF') ?? outfielder(engine, 'home');
  const internal = engine as unknown as ScenarioEngine;
  internal.pendingPass = {
    fromId: from.id,
    team: from.team,
    toId: receiver.id,
    source: 'open_play',
    isCross: true,
    launchPressure: 0,
  };
  internal.resolvePendingPassOnContact(receiver, 'control');
  const summary = engine.getAnalysisSummary();
  assert(receiver.crossCollected === 1200, 'completed cross did not start receiver finishing window');
  assert(summary.crosses.completed === 1, 'completed cross was not counted');
  assert(summary.crosses.openPlayCompleted === 1, 'completed open-play cross was not classified by origin');
  engine.ball.controllerId = receiver.id;
  engine.ball.x = receiver.x + 12; engine.ball.y = receiver.y;
  engine.shootBall(receiver);
  assert(engine.getAnalysisSummary().crosses.openPlayShots === 1, 'open-play cross-led shot lost its origin');
}

function selectedCrossClassificationScenario(): void {
  const engine = createEngine(15);
  const crosser = engine.players.find(player => player.team === 'home' && player.role === 'WM') ?? outfielder(engine, 'home');
  const receiver = engine.players.find(player => player.team === 'home' && player.role === 'CF') ?? outfielder(engine, 'home');
  crosser.x = AWAY_GOAL_X - 280; crosser.y = 60;
  // Selection intent remains a cross even if execution leads just outside the ideal box target.
  receiver.x = AWAY_GOAL_X - 210; receiver.y = PITCH_H / 2;
  engine.ball.x = crosser.x + 12; engine.ball.y = crosser.y;
  engine.ball.controllerId = crosser.id;
  const released = engine.passBallTo(crosser, receiver, false, false, {
    score: 0.6,
    distance: 330,
    forwardProgress: 150,
    expectedCompletion: 0.7,
    blockers: 0,
    receiverPressure: 0,
    purpose: 'cross',
    saferOptionTargetId: null,
    saferOptionScore: null,
    saferOptionCompletion: null,
    saferOptionProgress: null,
  });
  const summary = engine.getAnalysisSummary();
  assert(released, 'selected open-play cross was not released');
  assert(summary.crosses.openPlayAttempted === 1, 'selected open-play cross was not counted by origin');
  assert(summary.crosses.cornerAttempted === 0, 'selected open-play cross was counted as a corner');
}

function aerialReachScenario(): void {
  const engine = createEngine(9);
  const receiver = outfielder(engine, 'home');
  for (const player of engine.players) { player.x = 600; player.y = 400; }
  receiver.x = 100; receiver.y = 100;
  engine.ball.controllerId = null;
  engine.ball.intendedReceiverId = receiver.id;
  engine.ball.lastTouchTeam = 'home';
  engine.ball.x = receiver.x + 21; engine.ball.y = receiver.y;
  engine.ball.vx = 0; engine.ball.vy = 0; engine.ball.z = 80; engine.ball.vz = 0;
  (engine as unknown as ScenarioEngine).checkBallPlayerCollision(0);
  assert(engine.getAnalysisSummary().headers.total === 0, 'aerial contact reached beyond the 20 px body limit');
}

function shotBlockScenario(): void {
  const engine = createEngine(10);
  const shooter = outfielder(engine, 'home');
  const blocker = outfielder(engine, 'away');
  shooter.x = 700; shooter.y = 300;
  engine.ball.controllerId = shooter.id;
  engine.ball.x = shooter.x + 12; engine.ball.y = shooter.y;
  engine.shootBall(shooter);
  blocker.x = engine.ball.x + 10; blocker.y = engine.ball.y;
  assert(engine.collectBall(blocker, 'scenario_shot_block'), 'blocker could not make legal contact with shot');
  assert(engine.getAnalysisSummary().shotsBlocked === 1, 'outfield shot block was not counted');

  const deflected = createEngine(12);
  const secondShooter = outfielder(deflected, 'home');
  const secondBlocker = outfielder(deflected, 'away');
  for (const player of deflected.players) { player.x = 300; player.y = 500; }
  secondShooter.x = 700; secondShooter.y = 300;
  deflected.ball.controllerId = secondShooter.id;
  deflected.ball.x = secondShooter.x + 12; deflected.ball.y = secondShooter.y;
  deflected.shootBall(secondShooter);
  secondBlocker.x = deflected.ball.x + 10; secondBlocker.y = deflected.ball.y;
  (deflected as unknown as ScenarioEngine).checkBallPlayerCollision(0);
  assert(deflected.getAnalysisSummary().shotsBlocked === 1, 'deflected outfield shot block was not counted');
}

function finalThirdConversionScenario(): void {
  const engine = createEngine(11);
  const shooter = outfielder(engine, 'home');
  const internal = engine as unknown as ScenarioEngine;
  shooter.x = 800; shooter.y = 300;
  engine.ball.controllerId = shooter.id;
  engine.ball.x = shooter.x + 12; engine.ball.y = shooter.y;
  internal.trackFinalThirdPossession();
  engine.shootBall(shooter);
  engine.ball.controllerId = shooter.id;
  engine.ball.x = shooter.x + 12; engine.ball.y = shooter.y;
  internal.trackFinalThirdPossession();
  engine.shootBall(shooter);
  const summary = engine.getAnalysisSummary();
  assert(summary.finalThird.entries === 1, 'one final-third possession created multiple entries');
  assert(summary.finalThird.shots === 1, 'multiple shots inflated possession-to-shot conversion');
  assert(summary.finalThird.shotPct === 100, 'final-third conversion exceeded its bounded definition');
}

function invalidShotChoiceScenario(): void {
  const engine = createEngine(14);
  engine.startMatch();
  const internal = engine as unknown as ScenarioEngine;
  internal.kickoffPhase = false;
  const shooter = engine.players.find(player => player.team === 'home' && player.role === 'CF') ?? outfielder(engine, 'home');
  for (const teammate of engine.players.filter(player => player.team === shooter.team && player.id !== shooter.id)) {
    teammate.x = 100; teammate.y = 100;
  }
  shooter.x = AWAY_GOAL_X - 210; shooter.y = PITCH_H - 39;
  engine.players
    .filter(player => player.team !== shooter.team && player.role !== 'GK')
    .slice(0, 5)
    .forEach((opponent, index) => {
      opponent.x = shooter.x + 20 + index * 2;
      opponent.y = shooter.y - index * 5;
    });
  engine.ball.x = shooter.x + 12; engine.ball.y = shooter.y;
  engine.ball.controllerId = shooter.id;
  engine.ball.lastTouchTeam = shooter.team;
  engine.ball.lastToucherId = shooter.id;

  engine.update(16.667);
  const summary = engine.getAnalysisSummary();
  assert(summary.shots.home + summary.shots.away === 0, 'pressure bonuses revived an invalid acute/long shot');
}

function scriptedCornerWindupScenario(): void {
  const engine = createEngine(13);
  engine.startMatch();
  const internal = engine as unknown as ScenarioEngine;
  const taker = outfielder(engine, 'home');
  internal.kickoffPhase = false;
  taker.x = AWAY_GOAL_X - 70; taker.y = PITCH_H / 2;
  engine.ball.x = taker.x + 12; engine.ball.y = taker.y;
  engine.ball.controllerId = taker.id;
  engine.ball.lastTouchTeam = taker.team;
  engine.ball.lastToucherId = taker.id;
  internal.cornerCrossPending = true;
  internal.cornerCrossTaker = taker.id;
  internal.actionTimer = 200;

  engine.update(16.667);
  let summary = engine.getAnalysisSummary();
  assert(summary.shots.home + summary.shots.away === 0, 'corner wind-up allowed a normal shot');
  assert(summary.passes.attempted === 0, 'corner wind-up allowed an ordinary pass');

  for (let tick = 0; tick < 13; tick++) engine.update(16.667);
  summary = engine.getAnalysisSummary();
  assert(summary.crosses.attempted === 1, 'scripted corner cross did not execute after its wind-up');
  assert(summary.crosses.cornerAttempted === 1, 'scripted corner cross was not classified by origin');
  assert(summary.shots.home + summary.shots.away === 0, 'scripted corner created a phantom shot');
}

function dribbleControlScenario(): void {
  const engine = createEngine(16);
  const carrier = outfielder(engine, 'home');
  const internal = engine as unknown as ScenarioEngine;
  carrier.attrs.speed = 100;
  carrier.x = 100; carrier.y = 200; carrier.targetX = 500; carrier.targetY = 200;
  engine.ball.controllerId = carrier.id;
  carrier.dribbleType = 1;
  internal.moveBallCarrier(1000);
  const closeDistance = carrier.x - 100;
  assert(Math.abs(closeDistance - DRIBBLE_CLOSE_SPEED) < 0.01, 'close control did not use its reduced carry speed');

  carrier.x = 100; carrier.targetX = 500; carrier.dribbleType = 2;
  internal.moveBallCarrier(1000);
  const mediumDistance = carrier.x - 100;
  assert(Math.abs(mediumDistance - DRIBBLE_MEDIUM_SPEED) < 0.01, 'medium control did not use its carry speed');
  assert(mediumDistance > closeDistance, 'medium control was not faster than close control');

  carrier.x = 100; carrier.targetX = 500; carrier.dribbleType = 3;
  internal.moveBallCarrier(1000);
  assert(Math.abs(carrier.x - 100 - DRIBBLE_FAST_SPEED) < 0.01, 'fast dribble exceeded or missed the 95 percent chase limit');

  const burst = createEngine(17);
  const dribbler = outfielder(burst, 'home');
  const defender = outfielder(burst, 'away');
  dribbler.x = 300; dribbler.y = 300;
  dribbler.attrs.speed = 100;
  defender.x = 420; defender.y = 300;
  burst.ball.x = dribbler.x + 12; burst.ball.y = dribbler.y; burst.ball.controllerId = dribbler.id;
  assert(burst.knockBallAhead(dribbler, 520, 300), 'fast dribble did not release a knock-ahead');
  assert(burst.ball.controllerId === null, 'knock-ahead remained attached control');
  assert(burst.ball.intendedReceiverId === null, 'knock-ahead gained intended-receiver collection reach');
  assert(Math.abs(Math.hypot(burst.ball.vx, burst.ball.vy) - (DRIBBLE_FAST_SPEED + DRIBBLE_KNOCK_SPEED_ADVANTAGE)) < 0.01, 'knock-ahead ball speed was not relative to the runner pace');
  defender.x = burst.ball.x; defender.y = burst.ball.y;
  assert(burst.collectBall(defender, 'scenario_knock_ahead_turnover'), 'defender could not legally collect a risky knock-ahead');
  const summary = burst.getAnalysisSummary();
  assert(summary.dribbleTypes.knockAheads === 1 && summary.dribbleTypes.risky === 1, 'risky knock-ahead was not measured');
  assert(Math.abs(summary.dribbleTypes.launchSpeedAvg - (DRIBBLE_FAST_SPEED + DRIBBLE_KNOCK_SPEED_ADVANTAGE)) < 0.1, 'knock-ahead launch speed was not summarized');
  assert(summary.dribbleTypes.turnovers === 1 && summary.dribbleTypes.riskyTurnovers === 1, 'risky knock-ahead turnover was not measured');
  assert(summary.qualityFlags.bad_knock_ahead_turnover === 1, 'risky knock-ahead loss did not raise its audit flag');

  const recovery = createEngine(18);
  const runner = outfielder(recovery, 'home');
  runner.x = 200; runner.y = 260; runner.attrs.speed = 100;
  recovery.players
    .filter(player => player.team !== runner.team)
    .forEach(player => { player.x = 800; player.y = 500; });
  recovery.ball.x = runner.x + 12; recovery.ball.y = runner.y; recovery.ball.controllerId = runner.id;
  assert(recovery.knockBallAhead(runner, 450, 260), 'open knock-ahead did not start');
  runner.x = recovery.ball.x; runner.y = recovery.ball.y;
  assert(recovery.collectBall(runner, 'scenario_knock_ahead_recovery'), 'runner could not legally recover its short touch');
  assert(recovery.getAnalysisSummary().dribbleTypes.recovered === 1, 'knock-ahead recovery was not measured');
  assert(!recovery.knockBallAhead(runner, 450, 260), 'recovered runner immediately repeated a knock-ahead without cadence');
}

contactBoundsScenario();
crossCompletionScenario();
selectedCrossClassificationScenario();
aerialReachScenario();
shotBlockScenario();
finalThirdConversionScenario();
invalidShotChoiceScenario();
scriptedCornerWindupScenario();
dribbleControlScenario();
console.log('Scenario checks passed: contact, cross origin, headers, shot blocks, final-third conversion, shot rejection, corner wind-up, dribble control.');
