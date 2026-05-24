import { WebSocketServer, WebSocket } from 'ws';
import { GameEngine } from './engine';
import { createTeam, resetIds } from './teams';
import { createManager } from './manager';
import { FORMATIONS } from './types';
import type { ManagerConfig, Team } from './types';
import { setSeed } from './random';
import fs from 'node:fs';
import path from 'node:path';

const PORT = 3000;
const FIXED_DT = 16.667;
const LOG_DIR = path.resolve(process.cwd(), '..', '.scratch', 'footy-sim-logs');
const SEED = Number.parseInt(process.env.SIM_SEED ?? '', 10);
let matchIndex = 0;
let debugLastWrittenSeq = 0;

function flushDebugLog(engine: GameEngine): void {
  const batch = engine.getDebugLogBatch(debugLastWrittenSeq);
  if (batch.entries.length === 0) return;
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logPath = path.join(LOG_DIR, `${batch.sessionId}.jsonl`);
  const metaPath = path.join(LOG_DIR, `${batch.sessionId}.meta.json`);
  const receivedAt = new Date().toISOString();
  const lines = batch.entries
    .map(e => JSON.stringify({ receivedAt, sessionId: batch.sessionId, ...e }))
    .join('\n');
  fs.appendFileSync(logPath, `${lines}\n`, 'utf8');
  debugLastWrittenSeq = batch.lastSeq;
  let entriesReceived = batch.entries.length;
  try {
    entriesReceived += JSON.parse(fs.readFileSync(metaPath, 'utf8')).entriesReceived ?? 0;
  } catch { /* first write */ }
  fs.writeFileSync(metaPath, JSON.stringify({
    sessionId: batch.sessionId,
    startedAt: batch.startedAt,
    latestAt: receivedAt,
    entriesReceived,
    lastSeq: debugLastWrittenSeq,
    logPath,
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(LOG_DIR, 'latest-session.json'), JSON.stringify({
    sessionId: batch.sessionId, startedAt: batch.startedAt,
    latestAt: receivedAt, entriesReceived, lastSeq: debugLastWrittenSeq, logPath,
  }, null, 2), 'utf8');
}

function boundedSetting(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : fallback;
}

function configuredManager(team: Team, input?: Partial<ManagerConfig>): ManagerConfig {
  const fallback = createManager(team, false, FORMATIONS[1]);
  if (!input) return fallback;
  return {
    ...fallback,
    formation: FORMATIONS.find(formation => formation.name === input.formation?.name) ?? fallback.formation,
    aggression: boundedSetting(input.aggression, fallback.aggression),
    passingDirectness: boundedSetting(input.passingDirectness, fallback.passingDirectness),
    overlapFrequency: boundedSetting(input.overlapFrequency, fallback.overlapFrequency),
    midfieldFreedom: boundedSetting(input.midfieldFreedom, fallback.midfieldFreedom),
    defensiveLineHeight: boundedSetting(input.defensiveLineHeight, fallback.defensiveLineHeight),
  };
}

function createEngine(config?: { home?: Partial<ManagerConfig>; away?: Partial<ManagerConfig> }): GameEngine {
  if (Number.isFinite(SEED)) setSeed(SEED + matchIndex++);
  resetIds();
  const homeConfig = configuredManager('home', config?.home);
  const awayConfig = configuredManager('away', config?.away);
  const homePlayers = createTeam('home', homeConfig.formation);
  const awayPlayers = createTeam('away', awayConfig.formation);
  const engine = new GameEngine([...homePlayers, ...awayPlayers], homeConfig, awayConfig);
  engine.startMatch();
  return engine;
}

let engine = createEngine();

const wss = new WebSocketServer({ port: PORT });
console.log(`Engine running on ws://localhost:${PORT}`);
console.log(`Logs -> ${LOG_DIR}`);

let lastTime = Date.now();

setInterval(() => {
  const now = Date.now();
  const delta = now - lastTime;
  lastTime = now;

  engine.update(Math.min(delta, 50));

  // auto-restart on match finish
  if (engine.matchState === 'finished') {
    flushDebugLog(engine);
    debugLastWrittenSeq = 0;
    engine = createEngine();
  }

  const state = engine.getState();
  const msg = JSON.stringify(state);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}, FIXED_DT);

// Flush debug logs to disk every 2 seconds
setInterval(() => {
  if (engine) flushDebugLog(engine);
}, 2000);

wss.on('connection', (ws: WebSocket) => {
  console.log('Client connected');

  ws.on('message', (data: Buffer) => {
    try {
      const cmd = JSON.parse(data.toString());
      switch (cmd.type) {
        case 'pause':
          engine.togglePause();
          break;
        case 'speed':
          engine.speed = cmd.value;
          break;
        case 'restart':
          flushDebugLog(engine);
          debugLastWrittenSeq = 0;
          engine = createEngine({ home: cmd.homeConfig, away: cmd.awayConfig });
          break;
      }
    } catch { /* ignore */ }
  });

  ws.on('close', () => console.log('Client disconnected'));
});
