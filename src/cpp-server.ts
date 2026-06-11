// Relays native-engine frames at viewing speed while keeping the child blocked
// between small stdout batches. The native executable remains a fast simulator.
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = Number.parseInt(process.env.CPP_PORT ?? '3000', 10);
const CPP_ENGINE = path.resolve(process.cwd(), 'build', 'live.exe');
// Fixed seed via CPP_SEED for reproduction; otherwise every restart is a
// fresh match (the seed is shown in the page footer for bug reports).
const FIXED_SEED = process.env.CPP_SEED ? Number.parseInt(process.env.CPP_SEED, 10) : null;
let currentSeed = FIXED_SEED ?? randomSeed();
const MINUTES = 90;
// Debug equalizes attributes; default off so the legend profiles show.
const DEBUG = process.env.CPP_DEBUG === '1' || process.env.CPP_DEBUG === 'true';

function randomSeed(): number {
  return 1 + Math.floor(Math.random() * 99999);
}
const DEFAULT_FRAME_MS = 1000 / 30;
const MIN_SPEED = 0.5;
const MAX_SPEED = 60;

interface NativeState {
  clockMs: number;
  matchState: string;
  speed: number;
  seed?: number;
  [key: string]: unknown;
}

type NativeProcess = ChildProcessByStdio<null, Readable, Readable>;

const wss = new WebSocketServer({ port: PORT });
console.log(`Native engine WS on ws://localhost:${PORT}`);
console.log(`Native executable: ${CPP_ENGINE}`);

let engine: NativeProcess | null = null;
let generation = 0;
let outputBuffer = '';
let pendingLines: string[] = [];
let broadcastTimer: ReturnType<typeof setTimeout> | null = null;
let previousClockMs: number | null = null;
let nextVisibleClockMs: number | null = null;
let latestState: NativeState | null = null;
let playbackSpeed = 1;
let paused = false;

function broadcast(state: NativeState): void {
  const visibleState = {
    ...state,
    seed: currentSeed,
    speed: playbackSpeed,
    matchState: paused ? 'paused' : state.matchState,
  };
  latestState = state;
  const message = JSON.stringify(visibleState);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  }
}

function clearBroadcastTimer(): void {
  if (!broadcastTimer) return;
  clearTimeout(broadcastTimer);
  broadcastTimer = null;
}

function scheduleFrame(): void {
  if (broadcastTimer || paused) return;
  if (pendingLines.length === 0) {
    engine?.stdout.resume();
    return;
  }

  const line = pendingLines.shift()!;
  let state: NativeState;
  try {
    state = JSON.parse(line) as NativeState;
  } catch {
    scheduleFrame();
    return;
  }

  if (playbackSpeed > 1 && nextVisibleClockMs !== null && state.clockMs < nextVisibleClockMs) {
    scheduleFrame();
    return;
  }

  const simulatedDelta = previousClockMs === null
    ? DEFAULT_FRAME_MS
    : Math.max(1, state.clockMs - previousClockMs);
  previousClockMs = state.clockMs;
  broadcast(state);

  const delayMs = playbackSpeed > 1
    ? DEFAULT_FRAME_MS
    : Math.max(1, simulatedDelta / playbackSpeed);
  nextVisibleClockMs = playbackSpeed > 1
    ? state.clockMs + DEFAULT_FRAME_MS * playbackSpeed
    : null;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    scheduleFrame();
  }, delayMs);
}

function stopEngine(): void {
  generation++;
  clearBroadcastTimer();
  pendingLines = [];
  outputBuffer = '';
  previousClockMs = null;
  nextVisibleClockMs = null;
  latestState = null;
  if (engine) {
    engine.kill();
    engine = null;
  }
}

function startEngine(): void {
  stopEngine();
  const thisGeneration = generation;
  currentSeed = FIXED_SEED ?? randomSeed();
  console.log(`Starting match with seed ${currentSeed}`);
  const args = [String(currentSeed), String(MINUTES)];
  if (!DEBUG) args.push('--no-debug');
  const child = spawn(CPP_ENGINE, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  engine = child;

  child.stdout.on('data', (data: Buffer) => {
    if (engine !== child || generation !== thisGeneration) return;
    child.stdout.pause();
    outputBuffer += data.toString();
    const lines = outputBuffer.split(/\r?\n/);
    outputBuffer = lines.pop() ?? '';
    pendingLines.push(...lines.filter(line => line.length > 0));
    scheduleFrame();
  });
  child.stderr.on('data', (data: Buffer) => process.stderr.write(data));
  child.on('error', error => console.error(`Native engine failed: ${error.message}`));
  child.on('close', code => {
    if (engine !== child || generation !== thisGeneration) return;
    engine = null;
    console.log(`C++ engine exited: ${code}`);
    scheduleFrame();
  });
}

function boundedSpeed(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(MIN_SPEED, Math.min(MAX_SPEED, value));
}

wss.on('connection', (ws: WebSocket) => {
  console.log('Client connected to C++ engine');
  if (latestState) broadcast(latestState);

  ws.on('message', (data: Buffer) => {
    try {
      const command = JSON.parse(data.toString()) as { type?: string; value?: unknown };
      switch (command.type) {
        case 'restart':
          paused = false;
          startEngine();
          break;
        case 'pause':
          paused = !paused;
          if (paused) clearBroadcastTimer();
          if (latestState) broadcast(latestState);
          if (!paused) scheduleFrame();
          break;
        case 'speed': {
          const nextSpeed = boundedSpeed(command.value);
          if (nextSpeed === null) break;
          playbackSpeed = nextSpeed;
          clearBroadcastTimer();
          nextVisibleClockMs = playbackSpeed > 1 && latestState
            ? latestState.clockMs + DEFAULT_FRAME_MS * playbackSpeed
            : null;
          if (latestState) broadcast(latestState);
          scheduleFrame();
          break;
        }
      }
    } catch { /* Ignore malformed UI messages. */ }
  });
});

startEngine();
