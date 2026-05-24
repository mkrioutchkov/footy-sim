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
    midfieldTerritoryPct: round(results.reduce((total, result) => total + result.territoryPct.mid, 0) / matches),
  },
  tacticalActivity: taskSelections,
  qualityFlags,
  matches: results,
};

console.log(JSON.stringify(output, null, 2));
