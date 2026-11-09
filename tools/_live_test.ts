// Live coordinator + event-sourcing tests — the engine-INDEPENDENT logic (no live.exe spawn).
// The resident-engine transport is INJECTED as a fake (EngineFactory), so we test fan-out,
// per-team isolation, the editLock-serialised inject path, the applyAIShout seam, lifecycle, and
// the format-2 command-log <-> timeline conversion. The actual stdin protocol against a real
// engine is gated on Boris's Phase 1 (build-ahead).
//
//   npx tsx tools/_live_test.ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'footy-live-'));
process.env.FOOTY_DB = path.join(tmp, 'test.sqlite');   // routes recordings/events under tmp
process.env.TACTICS_LLM_API_KEY = '';

let pass = 0, fail = 0;
function check(c: boolean, m: string): void { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } }

const match = await import('../web/backend/match.ts');
const coord = await import('../web/backend/coordinator.ts');

// ── pure: commandsToTimeline / events.json round-trip / buildReplaySpec ──────────────────────
const cmds = [
  { atMs: 1000, team: 0, directives: [{ playerId: 3, kind: 'man_mark', targetId: 15, intensity: 0.9 }], morale: [{ playerId: 3, delta: 0.1 }], layout: [{ playerId: 1, role: 'CM', homeX: 200, homeY: 300 }] },
  { atMs: 2000, team: 1, directives: [{ teamScope: 1, kind: 'high_press', intensity: 0.8 }] },
];
const tl = match.commandsToTimeline(cmds as never);
check(tl.length === 2 && tl[0].atMs === 1000 && tl[0].team === 0 && tl[1].team === 1, 'commandsToTimeline keeps atMs + team per entry');
check(!!tl[0].morale && !!tl[0].layout && tl[1].morale === undefined, 'optional morale/layout carried only when present');
const log = { seed: 42, duration: 5400000, scores: { home: 1, away: 2 }, spec: { seed: 42, minutes: 90, home: {}, away: {} }, commands: cmds };
match.writeEventsLog('fixture', 9991, log as never);
const back = match.loadEventsLog('fixture', 9991);
check(!!back && back.seed === 42 && back.commands.length === 2 && back.commands[1].team === 1, 'events.json write/read round-trips');
const rspec = match.buildReplaySpec(back!);
check(Array.isArray(rspec.timeline) && (rspec.timeline as unknown[]).length === 2 && rspec.seed === 42, 'buildReplaySpec merges base spec + reconstructed timeline');

// ── persist-the-plan: the raw shout TEXT survives in the events log but never reaches the engine ──
const shoutCmds = [
  { atMs: 600000, team: 0, directives: [{ playerId: 3, kind: 'man_mark', targetId: 15 }, { teamScope: 0, kind: 'high_press' }], morale: [{ playerId: 3, delta: 0.2 }], layout: [{ playerId: 1, role: 'CM', homeX: 200, homeY: 300 }], text: 'man-mark their 10 and press high' },
  { atMs: 3000000, team: 0, directives: [], text: 'forget all that, sit deep' },
];
match.writeEventsLog('fixture', 9992, { seed: 7, duration: 5400000, scores: { home: 2, away: 1 }, spec: { home: {}, away: {} }, commands: shoutCmds } as never);
const slog = match.loadEventsLog('fixture', 9992)!;
check(slog.commands[0].text === 'man-mark their 10 and press high' && slog.commands[1].text === 'forget all that, sit deep', 'shout text round-trips in the events log');
check(match.commandsToTimeline(slog.commands as never).every(e => !('text' in e)), 'commandsToTimeline strips text — the engine never sees the shout prose');
const review = match.tacticsReview(slog);
check(review.side === 'home' && review.scores.home === 2 && review.shouts.length === 2, 'tacticsReview: side + scores + one entry per shout');
check(review.shouts[0].minute === 10 && review.shouts[0].directives === 2 && review.shouts[0].formationChange === true && review.shouts[0].morale === 1, 'tacticsReview digests minute / directive count / formation change / morale hits');
check(review.shouts[1].minute === 50 && review.shouts[1].directives === 0 && review.shouts[1].formationChange === false, 'tacticsReview reflects a nuke shout (0 directives, no shape change)');

// ── LiveMatch with a FAKE engine ─────────────────────────────────────────────────────────────
interface FakeEng { commands: string[]; killed: boolean; frameCb: (f: string) => void; exitCb: () => void; writeCommand(l: string): void; onFrame(cb: (f: string) => void): void; onExit(cb: () => void): void; kill(): void }
function fakeFactory(): { eng: FakeEng; factory: (sp: string) => FakeEng } {
  const eng: FakeEng = {
    commands: [], killed: false, frameCb: () => { /* set by ctor */ }, exitCb: () => { /* set by ctor */ },
    writeCommand(l) { this.commands.push(l); }, onFrame(cb) { this.frameCb = cb; }, onExit(cb) { this.exitCb = cb; }, kill() { this.killed = true; },
  };
  return { eng, factory: (_sp: string) => eng };
}
class FakeWs {
  readyState = 1;
  sent: string[] = [];
  private handlers: Record<string, ((d: unknown) => void)[]> = {};
  on(ev: string, cb: (d: unknown) => void): void { (this.handlers[ev] ??= []).push(cb); }
  send(s: string): void { this.sent.push(s); }
  emit(ev: string, d: unknown): void { for (const h of (this.handlers[ev] ?? [])) h(d); }
  close(): void { this.readyState = 3; this.emit('close', undefined); }
}
const msg = (o: unknown): Buffer => Buffer.from(JSON.stringify(o));

const specPath = path.join(tmp, 'spec.json');
const players = (n: string) => Array.from({ length: 11 }, (_, i) => ({ name: `${n}${i}`, role: 'CM', personality: null }));
writeFileSync(specPath, JSON.stringify({ seed: 7, minutes: 90, home: { players: players('H') }, away: { players: players('A') }, directives: [] }));
const create = { specPath, seed: 7, homeName: 'H', awayName: 'A', homeTeamId: 100, awayTeamId: 200, kind: 'fixture' as const, refId: 9992, record: false };

// registry: three joins on one key -> ONE engine, three subscribers
const f = fakeFactory();
const wsHome = new FakeWs(), wsAway = new FakeWs(), wsSpec = new FakeWs();
const lm = coord.joinLiveMatch('fixture-9992', wsHome as never, 'home', create, f.factory as never);
const lmAway = coord.joinLiveMatch('fixture-9992', wsAway as never, 'away', create, f.factory as never);
const lmSpec = coord.joinLiveMatch('fixture-9992', wsSpec as never, 'spectator', create, f.factory as never);
check(lm.subscriberCount === 3, 'three sockets attach to ONE shared LiveMatch (no second engine)');
// The registry is probed through joinLiveMatch itself: the liveMatchFor() accessor this test
// used was removed as a zero-reference export (5781836), since this file was never tracked.
check(lmAway === lm && lmSpec === lm, 'registry returns the shared instance for the key');

// frame fan-out
f.eng.frameCb(JSON.stringify({ clockMs: 1000, matchState: 'playing', homeScore: 0, awayScore: 0 }));
check(wsHome.sent.length === 1 && wsAway.sent.length === 1 && wsSpec.sent.length === 1, 'a frame fans out to ALL subscribers once each');
check(JSON.parse(wsHome.sent[0]).live === true, 'fanned frames are tagged live');

// shared speed control from a MANAGER reaches the engine; a spectator cannot touch the shared clock
wsHome.emit('message', msg({ type: 'speed', value: 2 }));
check(f.eng.commands.some(c => { const j = JSON.parse(c); return j.type === 'speed' && j.value === 2; }), 'a manager speed control reaches the engine (match-global)');
const beforeSpecCtl = f.eng.commands.length;
wsSpec.emit('message', msg({ type: 'pause' }));
wsSpec.emit('message', msg({ type: 'speed', value: 8 }));
check(f.eng.commands.length === beforeSpecCtl, 'a spectator cannot pause/speed the shared live clock (isolation)');

// per-team isolation: a SPECTATOR shout injects nothing
const before = f.eng.commands.length;
wsSpec.emit('message', msg({ type: 'tactics', text: 'park the bus' }));
await new Promise(r => setTimeout(r, 10));
check(f.eng.commands.length === before, 'a spectator tactics shout is dropped (no inject)');

// applyAIShout seam: AI clubs (by teamId) inject on the right side, monotonic, command-logged
await lm.applyAIShout(100, { plan: { summary: 'press', directives: [{ teamScope: 0, kind: 'high_press', intensity: 1 } as never] }, motivation: [], formation: null });
await lm.applyAIShout(200, { plan: { summary: 'sit', directives: [{ teamScope: 1, kind: 'park_the_bus', intensity: 1 } as never] }, motivation: [], formation: null });
const injects = f.eng.commands.map(c => JSON.parse(c)).filter(c => c.type === 'inject');
check(injects.length === 2, 'two AI shouts produce two inject commands');
check(injects[0].team === 0 && injects[1].team === 1, 'injects carry the right team (home teamId->0, away->1)');
check(typeof injects[0].atMs === 'number' && injects[0].atMs <= injects[1].atMs, 'inject atMs is monotonic under serialised shouts');
check(lm.commandLog.length === 2, 'the canonical command log captured both AI shouts');
await lm.applyAIShout(999, { plan: { summary: 'x', directives: [] }, motivation: [] });
check(lm.commandLog.length === 2, 'an applyAIShout for a teamId not in the fixture is a no-op');

// lifecycle: last subscriber leaves -> engine killed + registry cleared
wsHome.close(); wsAway.close();
check(f.eng.killed === false && lm.subscriberCount === 1, 'engine stays alive while a subscriber remains');
wsSpec.close();
check(f.eng.killed === true, 'engine is killed when the LAST subscriber leaves');
const wsRejoin = new FakeWs();
const rejoin = coord.joinLiveMatch('fixture-9992', wsRejoin as never, 'home', create, fakeFactory().factory as never);
check(rejoin !== lm, 'the fixture is removed from the registry at last-leave (a re-join builds a fresh match)');
wsRejoin.close();

// engine exit (full-time) also clears the registry entry (so a reconnect finds the recording)
const f2 = fakeFactory();
const lmExit = coord.joinLiveMatch('fixture-9993', new FakeWs() as never, 'home', { ...create, refId: 9993 }, f2.factory as never);
f2.eng.exitCb();
f2.eng.exitCb();   // idempotent — a repeated exit must not throw or double-fire onGone
const wsAfterExit = new FakeWs();
const afterExit = coord.joinLiveMatch('fixture-9993', wsAfterExit as never, 'home', { ...create, refId: 9993 }, fakeFactory().factory as never);
check(afterExit !== lmExit, 'engine exit (full-time) clears the registry entry; repeat exit is a no-op');
wsAfterExit.close();

// ── OPT-IN real-engine E2E (FOOTY_LIVE_E2E=1) — proves the coordinator drives the REAL FOOTY_LIVE
// engine end-to-end: spawn + stream (live:true frames) + pause/resume inject. Spawns live.exe (~5s),
// so it's gated out of the fast fake-engine suite above. Run: FOOTY_LIVE_E2E=1 npx tsx tools/_live_test.ts
if (process.env.FOOTY_LIVE_E2E === '1') {
  if (!process.env.FOOTY_LIVE_SPEED) process.env.FOOTY_LIVE_SPEED = '3';
  const { default: path2 } = await import('node:path');
  const specPath = path2.join(process.cwd(), 'web', 'backend', 'data', 'specs', 'fixture-1.json');
  const rf: any[] = [];
  let onMsg: (b: Buffer) => void = () => {}, onClose: () => void = () => {};
  const realWs: any = { readyState: 1, send(s: string) { rf.push(JSON.parse(s)); }, on(ev: string, cb: any) { if (ev === 'message') onMsg = cb; if (ev === 'close') onClose = cb; }, close() {} };
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const lm = coord.joinLiveMatch('e2e-live', realWs as never, 'home', { specPath, seed: 42, homeName: 'Home', awayName: 'Away', homeTeamId: 1, awayTeamId: 2, kind: 'fixture', refId: 999998, record: false } as never);
  await sleep(2500);
  const streamed = rf.length, f0 = rf[0];
  check(streamed > 20 && f0?.live === true && Array.isArray(f0?.players), `E2E real engine: spawn + stream live frames (${streamed})`);
  onMsg(Buffer.from(JSON.stringify({ type: 'pause' })));
  await sleep(1000);
  const afterPause = rf.length;
  onMsg(Buffer.from(JSON.stringify({ type: 'resume' })));
  await sleep(1000);
  check(afterPause - streamed <= 3, 'E2E real engine: pause inject halts the stream');
  check(rf.length - afterPause > 10, 'E2E real engine: resume inject restarts the stream');
  void onClose; lm.dispose();   // kill the engine directly; give the SIGTERM time to land before process.exit
  await sleep(900);
}

// ── OPT-IN live≡replay DETERMINISM (FOOTY_LIVE_DET=1) — THE multiplayer architectural core (joint
// with Boris's engine): a 2-sided live match's command log → replayViaTimeline → byte-identical
// excluding `version`. Spawns the real engine; gated out of the fast suite. Run:
//   FOOTY_LIVE_DET=1 npx tsx tools/_live_test.ts
if (process.env.FOOTY_LIVE_DET === '1') {
  const { spawn } = await import('node:child_process');
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { default: p } = await import('node:path');
  const ROOT = process.cwd();
  const base = JSON.parse(readFileSync(p.join(ROOT, 'web', 'backend', 'data', 'specs', 'fixture-1.json'), 'utf8'));
  base.minutes = 2; base.seed = 7;   // short, deterministic
  const specPath = p.join(ROOT, 'web', 'backend', 'data', 'specs', 'det-test.json');
  writeFileSync(specPath, JSON.stringify(base));
  const commands = [
    { atMs: 30000, team: 0, directives: [{ teamScope: 0, kind: 'high_press', intensity: 0.9 }] },
    { atMs: 60000, team: 1, directives: [{ teamScope: 1, kind: 'high_press', intensity: 0.9 }] },
  ];
  // LIVE: spawn the real FOOTY_LIVE engine, inject both upfront (queued → apply at atMs), capture
  const liveFrames: string[] = [];
  const child = spawn(p.join(ROOT, 'build', 'live.exe'), ['--match', specPath, '--no-debug'], { env: { ...process.env, FOOTY_LIVE: '1', FOOTY_LIVE_SPEED: '60' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let lbuf = ''; child.stdout.on('data', (d: Buffer) => { lbuf += d.toString(); const ls = lbuf.split(/\r?\n/); lbuf = ls.pop() ?? ''; for (const l of ls) if (l.length) liveFrames.push(l); });
  child.stderr.on('data', () => {});
  for (const c of commands) child.stdin.write(JSON.stringify({ type: 'inject', ...c }) + '\n');
  await new Promise<void>(res => { child.on('close', () => res()); });
  if (lbuf.length) liveFrames.push(lbuf);
  // REPLAY: the same command log via the timeline path
  match.writeEventsLog('fixture', 999990, { seed: 7, duration: 120000, scores: { home: 0, away: 0 }, spec: base, commands } as never);
  const replayFrames = await match.replayViaTimeline('fixture', 999990);
  const strip = (l: string): string => { try { const o = JSON.parse(l); delete o.version; return JSON.stringify(o); } catch { return l; } };
  let firstDiff = -1; const nn = Math.min(liveFrames.length, replayFrames.length);
  for (let i = 0; i < nn; i++) { if (strip(liveFrames[i]) !== strip(replayFrames[i])) { firstDiff = i; break; } }
  const detOk = firstDiff === -1 && liveFrames.length === replayFrames.length;
  if (!detOk) console.error(`  DET divergence: live ${liveFrames.length}f vs replay ${replayFrames.length}f, firstDiff@${firstDiff < 0 ? 'count' : firstDiff}${firstDiff >= 0 ? ` (clock ${JSON.parse(liveFrames[firstDiff]).clockMs})` : ''}`);
  check(detOk, 'DET: 2-sided live ≡ timeline-replay byte-identical (excl version)');
}

const { db } = await import('../web/backend/db.ts');
db.close();
console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
try { rmSync(tmp, { recursive: true, force: true }); } catch { /* windows temp lock — ignore */ }
process.exit(fail === 0 ? 0 : 1);
