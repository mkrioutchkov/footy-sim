// Record-and-replay test (no engine). Feeds a SYNTHETIC frame stream through the recording
// store + the pure pacer, asserting: capture writes a file whose gzip round-trips, the stored
// score equals the final frame's score, the replay source yields the same frames in order, the
// source selector picks replay-vs-resim, re-recording REPLACES (no dup), the fast-forward pacer
// actually skips frames at >1× (the 4× bug fix), the GC prunes by retention, and the engine
// watchdog ends a capture on silence — not on a slow host.
//
//   npx tsx tools/_replay_test.ts
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { Readable, PassThrough } from 'node:stream';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'footy-rpl-'));
process.env.FOOTY_DB = path.join(tmp, 'test.sqlite');   // recordings land in tmp/recordings, not the real save

let pass = 0, fail = 0;
function check(c: boolean, m: string): void { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } }

const DATA_DIR = path.dirname(process.env.FOOTY_DB);
const m = await import('../web/backend/match.ts');
const { db } = await import('../web/backend/db.ts');

// ── a synthetic match: 301 frames, ~33ms apart, opener at frame 150, final whistle 1-0 ──
const frame = (clockMs: number, hs: number, as: number, st = 'live') =>
  JSON.stringify({ clockMs, homeScore: hs, awayScore: as, matchState: st, ball: { x: 0, y: 0 }, players: [] });
const lines: string[] = [];
for (let i = 0; i <= 300; i++) lines.push(frame(Math.round(i * (1000 / 30)), i >= 150 ? 1 : 0, 0, i === 300 ? 'finished' : 'live'));

// ── capture: persist → file exists, gzip round-trips, score == final frame, row present ──
const rec1 = await m.persistRecording('fixture', 42, lines);
check(rec1.homeScore === 1 && rec1.awayScore === 0, 'stored score is derived from the final frame (1-0)');
check(rec1.frames === lines.length, `frame count recorded (${rec1.frames})`);
const found = m.recordingFor('fixture', 42);
check(!!found && found.path === 'recordings/fixture-42.ndjson.gz', 'recordingFor returns the row + relative path');
const abs = path.join(DATA_DIR, found!.path);
check(existsSync(abs), 'the gzipped frame file exists on disk');
check(abs.startsWith(tmp), 'recordings write next to the (temp) DB, never the real save');
const roundTrip = gunzipSync(readFileSync(abs)).toString('utf8').split(/\r?\n/).filter(l => l.length > 0);
check(roundTrip.length === lines.length && roundTrip[0] === lines[0] && roundTrip[300] === lines[300], 'gzip round-trips to the exact frames');

// ── replay source: loadRecording yields the same frames, in order ──
const loaded = m.loadRecording(found!);
check(loaded.length === lines.length && loaded.every((l, i) => l === lines[i]), 'loadRecording replays the frames in order');

// ── source selector: replay when a recording exists, null (→ re-sim) when it doesn't ──
check(m.recordingFor('fixture', 42) !== null, 'selector → replay for a recorded match');
check(m.recordingFor('fixture', 999) === null, 'selector → null (re-sim fallback) for an unrecorded match');
check(m.recordingFor('cup', 42) === null, 'kind is part of the key (cup 42 ≠ fixture 42)');

// ── re-record REPLACES (idempotent): one row, file overwritten with the new score ──
const replaced = lines.slice(0, 200).map((_, i) => frame(Math.round(i * (1000 / 30)), i >= 150 ? 2 : 0, 1, i === 199 ? 'finished' : 'live'));
await m.persistRecording('fixture', 42, replaced);
const rows = db.prepare('SELECT COUNT(*) AS n FROM match_recordings WHERE kind = ? AND ref_id = ?').get('fixture', 42) as { n: number };
check(rows.n === 1, 're-recording replaces (no duplicate row)');
const after = m.recordingFor('fixture', 42)!;
check(after.homeScore === 2 && after.awayScore === 1 && after.frames === 200, 're-recorded score + frame count updated (2-1, 200 frames)');

// ── streaming capture core (captureLineStream) — exercised with a synthetic Readable, no engine.
// This is the path recordMatch uses for a real match; it streams to disk (O(1) memory) and only
// publishes a COMPLETE match (final frame matchState 'finished'), atomically.
// (a) a complete stream, fed as TWO chunks split mid-line, publishes with the right score ──────
const full = lines.join('\n') + '\n';                            // 301 frames, final 'finished', 1-0
const mid = Math.floor(full.length / 2);
const src = Readable.from([Buffer.from(full.slice(0, mid)), Buffer.from(full.slice(mid))]);
const cap = await m.captureLineStream('fixture', 500, src);
check(cap.frames === lines.length && cap.homeScore === 1 && cap.awayScore === 0, 'captureLineStream publishes a complete match (1-0, 301 frames) across split chunks');
const cap500 = m.recordingFor('fixture', 500);
check(!!cap500 && existsSync(path.join(DATA_DIR, cap500!.path)), 'streamed recording row + file exist');
check(m.loadRecording(cap500!).length === lines.length, 'streamed recording round-trips to the same frame count');
// (b) an INCOMPLETE stream (crash/timeout — no 'finished' frame) is rejected, leaving NO row/file
const truncated = lines.slice(0, 120).join('\n') + '\n';         // ends mid-match, matchState 'live'
let rejected = false;
try { await m.captureLineStream('fixture', 501, Readable.from([Buffer.from(truncated)])); }
catch { rejected = true; }
check(rejected, 'captureLineStream rejects a stream that never reached the final whistle');
check(m.recordingFor('fixture', 501) === null, 'a rejected (incomplete) capture writes NO metadata row');
check(!existsSync(path.join(DATA_DIR, 'recordings/fixture-501.ndjson.gz')), 'a rejected capture leaves no published file');
check(!existsSync(path.join(DATA_DIR, 'recordings/fixture-501.ndjson.gz.tmp')), 'a rejected capture cleans up its temp file');

// ── orphan row → selector must fall back (finding #3): a row whose file is gone yields no frames
const orphan = m.recordingFor('fixture', 500)!;
rmSync(path.join(DATA_DIR, orphan.path), { force: true });        // file vanishes, row remains
check(m.recordingFor('fixture', 500) !== null, 'the metadata row still exists after the file is deleted');
check(m.loadRecording(orphan).length === 0, 'loadRecording yields no frames for an orphaned row → /ws/match falls back to re-sim');

// ── pacer: at ≤1× one frame per step; at >1× FRAME-SKIP so 4× advances ~4× the clock ──
// (thread prevClock from each step into the next, exactly as the tick loop does).
const FRAME = m.DEFAULT_FRAME_MS;
const q1 = lines.slice(); const a1 = m.paceStep(q1, null, 1);     // seed prevClock from frame 0
const s1 = m.paceStep(q1, a1.prevClock, 1);                       // frame 1, one ~33ms step
check(s1.drained === 1, '1× drains exactly one frame per step');
check(Math.abs(s1.delayMs - FRAME) < 2, '1× paces by the real ~33ms clock delta');
const q4 = lines.slice(); const a4 = m.paceStep(q4, null, 4);     // first fast-forward step
const s4 = m.paceStep(q4, a4.prevClock, 4);
check(s4.drained >= 3, `4× skips multiple frames per render (drained ${s4.drained}) — the fast-forward fix`);
// The pacer's real contract is SPEED HONESTY: delay = consumed-clock/speed (the old assertion demanded
// a CONSTANT delay — which was exactly the speed-floor bug on thinned recordings). On a dense stream the
// drain loop may overshoot the budget by one frame, so the cadence is ~24-30fps — assert 4× wall-clock
// exactly, and that the cadence stays render-frequent (the client interpolates between sends anyway).
const consumed4 = (s4.prevClock ?? 0) - (a4.prevClock ?? 0);
check(Math.abs(consumed4 / s4.delayMs - 4) < 0.15, `4× is wall-clock honest on a dense stream (${(consumed4 / s4.delayMs).toFixed(2)}×)`);
check(s4.delayMs < 50, `4× keeps a render-frequent cadence (delay ${s4.delayMs.toFixed(1)}ms < 50ms)`);
check(s4.drained > s1.drained, '4× advances the match faster than 1× (genuinely faster, not a no-op)');
// the OLD bug: every >1× behaved like 1× (drained 1). Guard against a regression to that.
check(!(m.paceStep(lines.slice(), null, 60).drained <= 1), '60× is not silently capped to one-frame-per-tick');
// ── the SPEED-FLOOR regression guard (the "2× plays like 8×" bug): on a THINNED recording
// (~264ms between frames, REPLAY_SAMPLE=8) one frame overshoots the whole 2× budget — the pacer
// must wait ~consumed/speed (≈132ms), NOT a fixed 33ms tick (which floored every speed at ~8×).
const thin: string[] = [];
for (let i = 0; i <= 40; i++) thin.push(frame(i * 264, 0, 0, 'live'));
const qt = thin.slice(); const t0 = m.paceStep(qt, null, 2);
const t1 = m.paceStep(qt, t0.prevClock, 2);
check(t1.drained === 1, '2× on a thinned stream drains one ~264ms frame per step');
check(Math.abs(t1.delayMs - 132) < 3, `2× on a thinned stream paces ~132ms/frame = true 2× (delay ${t1.delayMs.toFixed(1)}ms)`);
const qt8 = thin.slice(); const e0 = m.paceStep(qt8, null, 8);
const e1 = m.paceStep(qt8, e0.prevClock, 8);
check(Math.abs(e1.delayMs - (e1.drained * 264) / 8) < 3, `8× on a thinned stream paces consumed/8 (${e1.drained} frames, delay ${e1.delayMs.toFixed(1)}ms)`);

// ── GC: keep the most recent N, drop the rest (file + row) ──
for (let id = 100; id < 105; id++) await m.persistRecording('fixture', id, lines.slice(0, 10));
const before = db.prepare('SELECT COUNT(*) AS n FROM match_recordings').get() as { n: number };
const gc = m.pruneRecordings({ keep: 3 });
const remaining = db.prepare('SELECT COUNT(*) AS n FROM match_recordings').get() as { n: number };
check(remaining.n === 3, `GC keeps exactly 3 (had ${before.n}, pruned ${gc.pruned})`);
check(gc.files >= 1, 'GC removes the underlying files too');
check(m.pruneRecordings({ keep: 100 }).pruned === 0, 'GC is a no-op when under the keep threshold');
// max-age policy prunes by created_at against an injected clock
await m.persistRecording('fixture', 7, lines.slice(0, 5));
const aged = m.pruneRecordings({ keep: 100, maxAgeDays: 1, now: Date.now() + 3 * 86_400_000 });
check(aged.pruned >= 1, 'GC max-age prunes recordings older than the cutoff');

// ── engine watchdog: a capture is ended by SILENCE (or by never finishing), never by being slow ──
// The regression this guards: a fixed wall-clock cap (120s, then 180s) killed healthy captures on a
// slow host. So the first case is the one that matters — a stream that outlives the stall limit
// several times over, but keeps talking, must NOT lapse.
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
{
  const out = new PassThrough(); let why = '';
  const disarm = m.watchEngineOutput(out, w => { why = w; }, 400, 60_000);
  for (let i = 0; i < 12; i++) { out.write('frame\n'); await sleep(100); }   // ~1.2s of output = 3× the stall limit
  check(why === '', `a slow but talking engine is left alone (ran 3× the stall limit${why ? `, lapsed: ${why}` : ''})`);
  await sleep(900);                                                          // ...then it goes quiet
  check(/^no output for 0\.4s$/.test(why), `silence lapses the stall timer ("${why}")`);
  disarm();
}
{
  const out = new PassThrough(); let why = '', lapses = 0;
  const disarm = m.watchEngineOutput(out, w => { why = w; lapses++; }, 60_000, 400);
  const chatter = setInterval(() => out.write('frame\n'), 50);               // never stalls, never finishes
  await sleep(1000);
  clearInterval(chatter);
  check(/^still running after 0\.4s$/.test(why), `an engine that never finishes lapses the overall cap ("${why}")`);
  check(lapses === 1, `the lapse fires once (${lapses})`);
  disarm();
}
{
  const out = new PassThrough(); let lapsed = false;
  m.watchEngineOutput(out, () => { lapsed = true; }, 200, 200)();            // armed, then disarmed at once (a finished capture)
  await sleep(500);
  check(!lapsed, 'a disarmed watchdog never fires');
  check(out.listenerCount('data') === 0, 'disarming removes its stdout listener');
}
check(m.RECORD_STALL_MS < m.RECORD_CAP_MS && m.RECORD_CAP_MS >= 4 * 389_000, 'the shipped cap clears the slowest healthy capture seen (389s) at least 4× over');

db.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
