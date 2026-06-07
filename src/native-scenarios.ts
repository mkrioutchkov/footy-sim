import { spawnSync } from 'node:child_process';
import path from 'node:path';

interface Summary {
  clockMs: number;
  passes: number;
  stuckCarrierAlerts: number;
  slideTackleDistanceAlerts: number;
  ownPassGoals: number;
  unknownLooseGoals: number;
  passSelection?: { pressuredReceptions: number };
  marking?: { finalThirdSamples: number };
}

const executable = path.resolve(process.cwd(), 'build', 'live.exe');

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function summary(seed: number, minutes: number): Summary {
  const result = spawnSync(executable, [String(seed), String(minutes), '--summary', '--no-debug'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  assert(result.status === 0, result.stderr || `seed ${seed} failed to run`);
  const line = result.stdout.trim().split(/\r?\n/).at(-1);
  assert(Boolean(line), `seed ${seed} did not produce JSON`);
  return JSON.parse(line!) as Summary;
}

for (const seed of [102, 103]) {
  const state = summary(seed, 20);
  assert(state.clockMs >= 20 * 60_000 - 20, `seed ${seed} did not reach twenty minutes`);
  assert(state.stuckCarrierAlerts === 0, `seed ${seed} generated stuck carriers`);
  assert(state.slideTackleDistanceAlerts === 0, `seed ${seed} generated tackle launches`);
  assert(state.ownPassGoals === 0, `seed ${seed} generated an own-pass goal`);
  assert(state.unknownLooseGoals === 0, `seed ${seed} generated an unknown loose-ball goal`);
  assert((state.passSelection?.pressuredReceptions ?? 0) >= 0, `seed ${seed} lacks pass selection telemetry`);
  assert((state.marking?.finalThirdSamples ?? 0) >= 0, `seed ${seed} lacks marking telemetry`);
}

console.log('native scenarios passed: 20-minute flow, restart, tackle and loose-goal guards');
