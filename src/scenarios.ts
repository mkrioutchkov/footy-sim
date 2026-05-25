import { GameEngine } from './engine';
import { createManager } from './manager';
import { setSeed } from './random';
import { createTeam, resetIds } from './teams';
import { FORMATIONS, type Player, type Team } from './types';

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

contactBoundsScenario();
crossCompletionScenario();
aerialReachScenario();
shotBlockScenario();
finalThirdConversionScenario();
console.log('Scenario checks passed: contact, crosses, headers, shot blocks, final-third conversion.');
