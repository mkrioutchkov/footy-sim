import { GameEngine, type AnalysisSummary } from './engine';
import { createManager } from './manager';
import { setSeed } from './random';
import { createTeam, resetIds } from './teams';
import { FORMATIONS } from './types';

function argNumber(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function optionalArgNumber(name: string): number | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : undefined;
}

interface TacticalOverrides {
  overlapFrequency?: number;
  midfieldFreedom?: number;
  defensiveLineHeight?: number;
}

function applyOverrides(config: ReturnType<typeof createManager>, overrides: TacticalOverrides): void {
  if (overrides.overlapFrequency !== undefined) config.overlapFrequency = overrides.overlapFrequency;
  if (overrides.midfieldFreedom !== undefined) config.midfieldFreedom = overrides.midfieldFreedom;
  if (overrides.defensiveLineHeight !== undefined) config.defensiveLineHeight = overrides.defensiveLineHeight;
}

function runMatch(seed: number, minutes: number, overrides: TacticalOverrides): AnalysisSummary & { seed: number } {
  setSeed(seed);
  resetIds();
  const homeConfig = createManager('home', false, FORMATIONS[1]);
  const awayConfig = createManager('away', false, FORMATIONS[1]);
  applyOverrides(homeConfig, overrides);
  applyOverrides(awayConfig, overrides);
  const players = [...createTeam('home', homeConfig.formation), ...createTeam('away', awayConfig.formation)];
  const engine = new GameEngine(players, homeConfig, awayConfig);
  engine.startMatch();

  const ticks = Math.ceil(minutes * 60_000 / 16.667);
  for (let i = 0; i < ticks; i++) engine.update(16.667);
  return { seed, ...engine.getAnalysisSummary() };
}

function sumValues(records: Record<string, number>[]): Record<string, number> {
  const total: Record<string, number> = {};
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) total[key] = (total[key] ?? 0) + value;
  }
  return total;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

const matches = Math.floor(argNumber('--matches', 5));
const minutes = argNumber('--minutes', 10);
const firstSeed = Math.floor(argNumber('--seed', 1));
const overrides: TacticalOverrides = {
  overlapFrequency: optionalArgNumber('--overlap'),
  midfieldFreedom: optionalArgNumber('--midfield'),
  defensiveLineHeight: optionalArgNumber('--line'),
};
const results = Array.from({ length: matches }, (_, i) => runMatch(firstSeed + i, minutes, overrides));
const taskSelections = sumValues(results.map(result => result.taskSelections));
const qualityFlags = sumValues(results.map(result => result.qualityFlags));

const attempted = results.reduce((total, result) => total + result.passes.attempted, 0);
const completed = results.reduce((total, result) => total + result.passes.completed, 0);
const crosses = results.reduce((total, result) => total + result.crosses.attempted, 0);
const openPlayCrosses = results.reduce((total, result) => total + result.crosses.openPlayAttempted, 0);
const cornerCrosses = results.reduce((total, result) => total + result.crosses.cornerAttempted, 0);
const cutbacks = results.reduce((total, result) => total + result.cutbacks.attempted, 0);
const gkDistributions = results.reduce((total, result) => total + result.distributions.goalkeeper.attempted, 0);
const completedGKDistributions = results.reduce((total, result) => total + result.distributions.goalkeeper.completed, 0);
const looseBallSamples = results.reduce((total, result) => total + result.ballSpeed.looseSamples, 0);
const passLaunches = results.reduce((total, result) => total + result.ballSpeed.passLaunches, 0);
const shotLaunches = results.reduce((total, result) => total + result.ballSpeed.shotLaunches, 0);
const headerLaunches = results.reduce((total, result) => total + result.ballSpeed.headerLaunches, 0);
const auditedPasses = results.reduce((total, result) => total + result.selectionAudit.passes.audited, 0);
const auditedShots = results.reduce((total, result) => total + result.selectionAudit.shots.audited, 0);
const auditedGoals = results.reduce((total, result) => total + result.selectionAudit.goals.audited, 0);
const pressSamples = results.reduce((total, result) => total + result.defending.pressSamples, 0);
const collections = results.reduce((total, result) => total + result.contests.collections, 0);
const interceptionCollections = results.reduce((total, result) => total + result.contests.interceptionsCollected, 0);
const tacklesWon = results.reduce((total, result) => total + result.contests.tacklesWon, 0);
const tacklesAttempted = results.reduce((total, result) => total + result.contests.tacklesAttempted, 0);
const knockAheads = results.reduce((total, result) => total + result.dribbleTypes.knockAheads, 0);
const retainedKnockAheads = results.reduce((total, result) => total + result.dribbleTypes.recovered + result.dribbleTypes.retainedByTeammate, 0);
const knockAheadLaunchSpeedTotal = results.reduce((total, result) => total + result.dribbleTypes.launchSpeedAvg * result.dribbleTypes.knockAheads, 0);
const shots = results.reduce((total, result) => total + result.shots.home + result.shots.away, 0);
const finalThirdEntries = results.reduce((total, result) => total + result.finalThird.entries, 0);
const finalThirdShots = results.reduce((total, result) => total + result.finalThird.shots, 0);
const output = {
  config: { matches, minutes, seeds: results.map(result => result.seed), tacticalOverrides: overrides },
  aggregate: {
    goalsPerMatch: round(results.reduce((total, result) => total + result.score.home + result.score.away, 0) / matches),
    shotsPerMatch: round(results.reduce((total, result) => total + result.shots.home + result.shots.away, 0) / matches),
    shotsOnTargetPct: round(results.reduce((total, result) => total + result.shots.onTarget, 0) / Math.max(1, results.reduce((total, result) => total + result.shots.home + result.shots.away, 0)) * 100),
    savesPerMatch: round(results.reduce((total, result) => total + result.shots.saved, 0) / matches),
    goalsPerShotPct: round(results.reduce((total, result) => total + result.score.home + result.score.away, 0) / Math.max(1, results.reduce((total, result) => total + result.shots.home + result.shots.away, 0)) * 100),
    passesPerMatch: round(attempted / matches),
    passCompletionPct: round(completed / Math.max(1, attempted) * 100),
    interceptedPassesPerMatch: round(results.reduce((total, result) => total + result.passes.intercepted, 0) / matches),
    offsidesPerMatch: round(results.reduce((total, result) => total + result.passes.offsides, 0) / matches),
    throughBallsPerMatch: round(results.reduce((total, result) => total + result.throughBalls.attempted, 0) / matches),
    throughBallCompletionPct: round(results.reduce((total, result) => total + result.throughBalls.completed, 0) / Math.max(1, results.reduce((total, result) => total + result.throughBalls.attempted, 0)) * 100),
    timedRunsPerMatch: round(results.reduce((total, result) => total + result.timedRuns.started, 0) / matches),
    timedRunOffsidesPerMatch: round(results.reduce((total, result) => total + result.timedRuns.offsides, 0) / matches),
    crossesPerMatch: round(crosses / matches),
    crossCompletionPct: round(results.reduce((total, result) => total + result.crosses.completed, 0) / Math.max(1, crosses) * 100),
    openPlayCrossesPerMatch: round(openPlayCrosses / matches),
    openPlayCrossCompletionPct: round(results.reduce((total, result) => total + result.crosses.openPlayCompleted, 0) / Math.max(1, openPlayCrosses) * 100),
    cornerCrossesPerMatch: round(cornerCrosses / matches),
    crossShotsPerMatch: round(results.reduce((total, result) => total + result.crosses.shots, 0) / matches),
    crossGoalsPerMatch: round(results.reduce((total, result) => total + result.crosses.goals, 0) / matches),
    openPlayCrossShotsPerMatch: round(results.reduce((total, result) => total + result.crosses.openPlayShots, 0) / matches),
    openPlayCrossGoalsPerMatch: round(results.reduce((total, result) => total + result.crosses.openPlayGoals, 0) / matches),
    cornerCrossShotsPerMatch: round(results.reduce((total, result) => total + result.crosses.cornerShots, 0) / matches),
    cutbacksPerMatch: round(cutbacks / matches),
    cutbackCompletionPct: round(results.reduce((total, result) => total + result.cutbacks.completed, 0) / Math.max(1, cutbacks) * 100),
    cutbackShotsPerMatch: round(results.reduce((total, result) => total + result.cutbacks.shots, 0) / matches),
    cutbackGoalsPerMatch: round(results.reduce((total, result) => total + result.cutbacks.goals, 0) / matches),
    finalThirdEntriesPerMatch: round(finalThirdEntries / matches),
    finalThirdShotsPerMatch: round(finalThirdShots / matches),
    finalThirdEntryShotPct: round(finalThirdShots / Math.max(1, finalThirdEntries) * 100),
    shotsBlockedPerMatch: round(results.reduce((total, result) => total + result.shotsBlocked, 0) / matches),
    shotBlockPct: round(results.reduce((total, result) => total + result.shotsBlocked, 0) / Math.max(1, shots) * 100),
    panicClearsPerMatch: round(results.reduce((total, result) => total + result.panicClears, 0) / matches),
    unpressuredClearancesPerMatch: round(results.reduce((total, result) => total + result.setPieces.unpressuredClearances, 0) / matches),
    timeWastingDribblesPerMatch: round(results.reduce((total, result) => total + result.timeWastingDribbles, 0) / matches),
    fastDribblesPerMatch: round(results.reduce((total, result) => total + result.dribbleTypes.fast, 0) / matches),
    mediumDribblesPerMatch: round(results.reduce((total, result) => total + result.dribbleTypes.medium, 0) / matches),
    closeDribblesPerMatch: round(results.reduce((total, result) => total + result.dribbleTypes.close, 0) / matches),
    knockAheadsPerMatch: round(knockAheads / matches),
    knockAheadCarrierRecoveryPct: round(results.reduce((total, result) => total + result.dribbleTypes.recovered, 0) / Math.max(1, knockAheads) * 100),
    knockAheadRetentionPct: round(retainedKnockAheads / Math.max(1, knockAheads) * 100),
    knockAheadTurnoversPerMatch: round(results.reduce((total, result) => total + result.dribbleTypes.turnovers, 0) / matches),
    knockAheadOutOfPlayPerMatch: round(results.reduce((total, result) => total + result.dribbleTypes.outOfPlay, 0) / matches),
    riskyKnockAheadsPerMatch: round(results.reduce((total, result) => total + result.dribbleTypes.risky, 0) / matches),
    riskyKnockAheadTurnoversPerMatch: round(results.reduce((total, result) => total + result.dribbleTypes.riskyTurnovers, 0) / matches),
    knockAheadLaunchSpeedAvg: round(knockAheadLaunchSpeedTotal / Math.max(1, knockAheads)),
    gkDistributionsPerMatch: round(gkDistributions / matches),
    gkDistributionCompletionPct: round(completedGKDistributions / Math.max(1, gkDistributions) * 100),
    gkDangerousTurnoversPerMatch: round(results.reduce((total, result) => total + result.distributions.goalkeeper.dangerousTurnovers, 0) / matches),
    outfieldDangerTurnoversPerMatch: round(results.reduce((total, result) => total + result.distributions.outfieldDangerTurnovers, 0) / matches),
    gkAssessedShotsPerMatch: round(results.reduce((total, result) => total + result.goalkeeping.assessedShots, 0) / matches),
    unlikelyGKSavesPerMatch: round(results.reduce((total, result) => total + result.goalkeeping.unlikelySaves, 0) / matches),
    preventableGoalsPerMatch: round(results.reduce((total, result) => total + result.goalkeeping.preventableGoals, 0) / matches),
    peakBallSpeedAvg: round(results.reduce((total, result) => total + result.ballSpeed.peak, 0) / matches),
    looseBallSpeedAvg: round(results.reduce((total, result) => total + result.ballSpeed.looseSampleAvg * result.ballSpeed.looseSamples, 0) / Math.max(1, looseBallSamples)),
    passLaunchSpeedAvg: round(results.reduce((total, result) => total + result.ballSpeed.passLaunchAvg * result.ballSpeed.passLaunches, 0) / Math.max(1, passLaunches)),
    shotLaunchSpeedAvg: round(results.reduce((total, result) => total + result.ballSpeed.shotLaunchAvg * result.ballSpeed.shotLaunches, 0) / Math.max(1, shotLaunches)),
    headerLaunchSpeedAvg: round(results.reduce((total, result) => total + result.ballSpeed.headerLaunchAvg * result.ballSpeed.headerLaunches, 0) / Math.max(1, headerLaunches)),
    midfieldTerritoryPct: round(results.reduce((total, result) => total + result.territoryPct.mid, 0) / matches),
    auditedPassesPerMatch: round(auditedPasses / matches),
    chosenPassDistanceAvg: round(results.reduce((total, result) => total + result.selectionAudit.passes.avgDistance * result.selectionAudit.passes.audited, 0) / Math.max(1, auditedPasses)),
    chosenPassExpectedCompletionPct: round(results.reduce((total, result) => total + result.selectionAudit.passes.avgExpectedCompletion * result.selectionAudit.passes.audited, 0) / Math.max(1, auditedPasses)),
    saferPassIgnoredPerMatch: round(results.reduce((total, result) => total + result.selectionAudit.passes.saferOptionIgnored, 0) / matches),
    auditedShotsPerMatch: round(auditedShots / matches),
    chosenShotDistanceAvg: round(results.reduce((total, result) => total + result.selectionAudit.shots.avgDistance * result.selectionAudit.shots.audited, 0) / Math.max(1, auditedShots)),
    chosenShotAngleDegAvg: round(results.reduce((total, result) => total + result.selectionAudit.shots.avgAngleDeg * result.selectionAudit.shots.audited, 0) / Math.max(1, auditedShots)),
    lowValueShotsPerMatch: round(results.reduce((total, result) => total + result.selectionAudit.shots.lowValue, 0) / matches),
    betterPassShotChoicesPerMatch: round(results.reduce((total, result) => total + result.selectionAudit.shots.betterPassAvailable, 0) / matches),
    auditedGoalsPerMatch: round(auditedGoals / matches),
    chosenGoalDistanceAvg: round(results.reduce((total, result) => total + result.selectionAudit.goals.avgDistance * result.selectionAudit.goals.audited, 0) / Math.max(1, auditedGoals)),
    chosenGoalAngleDegAvg: round(results.reduce((total, result) => total + result.selectionAudit.goals.avgAngleDeg * result.selectionAudit.goals.audited, 0) / Math.max(1, auditedGoals)),
    lowValueGoalsPerMatch: round(results.reduce((total, result) => total + result.selectionAudit.goals.lowValue, 0) / matches),
    pressPrimaryDistanceAvg: round(results.reduce((total, result) => total + result.defending.avgPrimaryDistance * result.defending.pressSamples, 0) / Math.max(1, pressSamples)),
    avoidablePressSelectionsPerMatch: round(results.reduce((total, result) => total + result.defending.avoidablePressSelections, 0) / matches),
    dangerUnengagedSamplesPerMatch: round(results.reduce((total, result) => total + result.defending.dangerUnengagedSamples, 0) / matches),
    collectionsPerMatch: round(collections / matches),
    collectionDistanceAvg: round(results.reduce((total, result) => total + result.contests.avgCollectionDistance * result.contests.collections, 0) / Math.max(1, collections)),
    collectionDistanceMax: round(Math.max(...results.map(result => result.contests.maxCollectionDistance))),
    interceptionsCollectedPerMatch: round(interceptionCollections / matches),
    interceptionDistanceAvg: round(results.reduce((total, result) => total + result.contests.avgInterceptionDistance * result.contests.interceptionsCollected, 0) / Math.max(1, interceptionCollections)),
    interceptionDistanceMax: round(Math.max(...results.map(result => result.contests.maxInterceptionDistance))),
    preventedStaleGrabsPerMatch: round(results.reduce((total, result) => total + result.contests.preventedStaleGrabs, 0) / matches),
    rejectedControlledGrabsPerMatch: round(results.reduce((total, result) => total + result.contests.rejectedControlledGrabs, 0) / matches),
    rejectedLongReachPerMatch: round(results.reduce((total, result) => total + result.contests.rejectedLongReach, 0) / matches),
    protectedRecollectionsPerMatch: round(results.reduce((total, result) => total + result.contests.protectedRecollections, 0) / matches),
    tacklesAttemptedPerMatch: round(tacklesAttempted / matches),
    tackleWinPct: round(tacklesWon / Math.max(1, tacklesAttempted) * 100),
    winningTackleDistanceAvg: round(results.reduce((total, result) => total + result.contests.avgWinningTackleDistance * result.contests.tacklesWon, 0) / Math.max(1, tacklesWon)),
    winningTackleDistanceMax: round(Math.max(...results.map(result => result.contests.maxWinningTackleDistance))),
  },
  tacticalActivity: taskSelections,
  qualityFlags,
  matches: results,
};

console.log(JSON.stringify(output, null, 2));
