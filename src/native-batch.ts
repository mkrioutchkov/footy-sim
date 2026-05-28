import { spawn } from 'node:child_process';
import path from 'node:path';

interface Summary {
  homeScore: number;
  awayScore: number;
  passes: number;
  passesCompleted: number;
  passesIntercepted: number;
  passCompletionPct: number;
  offsides: number;
  shots: number;
  shotsOnTarget: number;
  saves: number;
  stuckCarrierAlerts: number;
  simulationFreezes: number;
  dizzySpins: number;
  teammatePingPongs: number;
  slideTackleDistanceAlerts: number;
  slideTackleOobAlerts: number;
  ownPassGoals: number;
  unknownLooseGoals: number;
  shotsByDistance: { questionable: number };
  tackles: { attempts: number; wins: number };
  dribbleTypes: { knockAheads: number; turnovers: number; riskyTurnovers: number };
  passSelection: { risky: number; saferIgnored: number; pressuredReceptions: number; pressuredReceptionFailures: number };
  shotSelection: {
    betterPassAvailable: number;
    tightAngle: number;
    cfCredibleWindowSamples: number;
    cfDeferredSamples: number;
    cfDeferredForPass: number;
    cfDeferredForDribble: number;
    cfCloseWindowSamples: number;
    cfCloseDeferredSamples: number;
  };
  marking: {
    questionablePress: number;
    backLineSamples: number;
    singleDropSamples: number;
    avgBackLineGap: number;
    avgSingleDropGap: number;
    maxBackLineGap: number;
    laneBlockSingleDrops: number;
    finalThirdSamples: number;
    unmarkedFinalThird: number;
  };
  carrierTurns: { over30: number };
}

function argNumber(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

const executable = path.resolve(process.cwd(), 'build', 'benchmark.exe');

function runMatch(seed: number, minutes: number): Promise<Summary & { seed: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [String(seed), String(minutes), '--summary']);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data.toString(); });
    child.stderr.on('data', data => { stderr += data.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(stderr || `Native match ${seed} exited ${code}`));
        return;
      }
      const output = stdout.trim().split(/\r?\n/).at(-1);
      if (!output) {
        reject(new Error(`Native match ${seed} produced no summary`));
        return;
      }
      resolve({ seed, ...JSON.parse(output) as Summary });
    });
  });
}

const matches = Math.floor(argNumber('--matches', 8));
const minutes = argNumber('--minutes', 10);
const firstSeed = Math.floor(argNumber('--seed', 101));
const results = await Promise.all(Array.from({ length: matches }, (_, index) => runMatch(firstSeed + index, minutes)));
const total = <K extends keyof Summary>(key: K): number => results.reduce((sum, result) => sum + (result[key] as number), 0);
const passes = total('passes');
const shots = total('shots');
const goals = results.reduce((sum, result) => sum + result.homeScore + result.awayScore, 0);
const markingSamples = results.reduce((sum, result) => sum + result.marking.finalThirdSamples, 0);
const unmarked = results.reduce((sum, result) => sum + result.marking.unmarkedFinalThird, 0);
const backLineSamples = results.reduce((sum, result) => sum + result.marking.backLineSamples, 0);
const singleDrops = results.reduce((sum, result) => sum + result.marking.singleDropSamples, 0);
const laneBlockSingleDrops = results.reduce((sum, result) => sum + result.marking.laneBlockSingleDrops, 0);

console.log(JSON.stringify({
  config: { matches, minutes, seeds: results.map(result => result.seed), engine: 'native' },
  aggregate: {
    goalsPerMatch: round(goals / matches),
    shotsPerMatch: round(shots / matches),
    shotsOnTargetPct: round(total('shotsOnTarget') / Math.max(1, shots) * 100),
    savesPerMatch: round(total('saves') / matches),
    goalsPerShotPct: round(goals / Math.max(1, shots) * 100),
    passesPerMatch: round(passes / matches),
    passCompletionPct: round(total('passesCompleted') / Math.max(1, passes) * 100),
    interceptedPassesPerMatch: round(total('passesIntercepted') / matches),
    offsidesPerMatch: round(total('offsides') / matches),
    tacklesAttemptedPerMatch: round(results.reduce((sum, result) => sum + result.tackles.attempts, 0) / matches),
    tackleWinPct: round(results.reduce((sum, result) => sum + result.tackles.wins, 0)
      / Math.max(1, results.reduce((sum, result) => sum + result.tackles.attempts, 0)) * 100),
    knockAheadsPerMatch: round(results.reduce((sum, result) => sum + result.dribbleTypes.knockAheads, 0) / matches),
    knockAheadTurnoversPerMatch: round(results.reduce((sum, result) => sum + result.dribbleTypes.turnovers, 0) / matches),
    questionableShotsPerMatch: round(results.reduce((sum, result) => sum + result.shotsByDistance.questionable, 0) / matches),
    cfCredibleWindowSamplesPerMatch: round(results.reduce((sum, result) => sum + result.shotSelection.cfCredibleWindowSamples, 0) / matches),
    cfDeferredSamplesPerMatch: round(results.reduce((sum, result) => sum + result.shotSelection.cfDeferredSamples, 0) / matches),
    cfDeferredForPassPerMatch: round(results.reduce((sum, result) => sum + result.shotSelection.cfDeferredForPass, 0) / matches),
    cfDeferredForDribblePerMatch: round(results.reduce((sum, result) => sum + result.shotSelection.cfDeferredForDribble, 0) / matches),
    cfCloseWindowSamplesPerMatch: round(results.reduce((sum, result) => sum + result.shotSelection.cfCloseWindowSamples, 0) / matches),
    cfCloseDeferredSamplesPerMatch: round(results.reduce((sum, result) => sum + result.shotSelection.cfCloseDeferredSamples, 0) / matches),
    riskyPassSelectionsPerMatch: round(results.reduce((sum, result) => sum + result.passSelection.risky, 0) / matches),
    pressuredReceptionFailuresPerMatch: round(results.reduce((sum, result) => sum + result.passSelection.pressuredReceptionFailures, 0) / matches),
    questionablePressSelectionsPerMatch: round(results.reduce((sum, result) => sum + result.marking.questionablePress, 0) / matches),
    singleDefenderDropPct: round(singleDrops / Math.max(1, backLineSamples) * 100),
    laneBlockSingleDropsPerMatch: round(laneBlockSingleDrops / matches),
    avgBackLineGap: round(results.reduce((sum, result) => sum + result.marking.avgBackLineGap * result.marking.backLineSamples, 0) / Math.max(1, backLineSamples)),
    avgSingleDropGap: round(results.reduce((sum, result) => sum + result.marking.avgSingleDropGap * result.marking.singleDropSamples, 0) / Math.max(1, singleDrops)),
    maxBackLineGap: round(results.reduce((max, result) => Math.max(max, result.marking.maxBackLineGap), 0)),
    unmarkedFinalThirdPct: round(unmarked / Math.max(1, markingSamples) * 100),
    carrierTurnsOver30PerMatch: round(results.reduce((sum, result) => sum + result.carrierTurns.over30, 0) / matches),
    teammatePingPongsPerMatch: round(results.reduce((sum, result) => sum + result.teammatePingPongs, 0) / matches),
  },
  qualityFlags: {
    stuckCarrier: total('stuckCarrierAlerts'),
    simulationFreeze: total('simulationFreezes'),
    dizzySpin: total('dizzySpins'),
    slideTackleDistance: total('slideTackleDistanceAlerts'),
    slideTackleOob: total('slideTackleOobAlerts'),
    ownPassGoal: total('ownPassGoals'),
    unknownLooseGoal: total('unknownLooseGoals'),
    betterPassShot: results.reduce((sum, result) => sum + result.shotSelection.betterPassAvailable, 0),
    tightAngleShot: results.reduce((sum, result) => sum + result.shotSelection.tightAngle, 0),
  },
  matches: results.map(result => ({
    seed: result.seed,
    score: `${result.homeScore}-${result.awayScore}`,
    passes: result.passes,
    completionPct: result.passCompletionPct,
    shots: result.shots,
    goals: result.homeScore + result.awayScore,
    tackles: result.tackles.attempts,
    stuck: result.stuckCarrierAlerts,
    singleDropPct: round(result.marking.singleDropSamples / Math.max(1, result.marking.backLineSamples) * 100),
    unmarkedFinalThirdPct: round(result.marking.unmarkedFinalThird / Math.max(1, result.marking.finalThirdSamples) * 100),
  })),
}, null, 2));
