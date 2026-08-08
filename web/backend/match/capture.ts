// Producing a recording: the O(1)-memory line-stream capture, the full-frame engine run that
// feeds it, and the sequential queue that keeps concurrent finishes from piling engines up. The
// STORE side (rows, files, retention) is recordings.ts.
import { spawn } from 'node:child_process';
import { existsSync, rmSync, createWriteStream, renameSync, statSync } from 'node:fs';
import { createGzip } from 'node:zlib';
import path from 'node:path';
import { ENGINE, DATA_DIR } from './runtime.ts';
import { type RecKind, recRel, recordingFor, upsertRecordingRow } from './recordings.ts';

// Best-effort replay recordings run ONE AT A TIME (so they can't pile up + swamp a slow host), but via a
// SEQUENTIAL QUEUE rather than a drop-if-busy gate — the old `at most one in flight, others skip` lost a
// game's recording whenever two human matches (or a league + cup tie) finished close together (viewer P2).
// Now every queued match records in turn; failures are isolated + the result/aftermath are untouched either
// way (they come from --summary). Dedup keeps a fixture from being queued twice.
type RecordJob = { kind: 'fixture' | 'cup'; id: number; spec: string };
const recordQueue: RecordJob[] = [];
const recordQueued = new Set<string>();   // `${kind}:${id}` currently queued or recording (dedupe)
let recordingActive = false;
export function enqueueRecording(kind: 'fixture' | 'cup', id: number, spec: string): void {
  const key = `${kind}:${id}`;
  if (recordQueued.has(key) || recordingFor(kind, id)) return;   // already queued/recording, or already on disk
  recordQueued.add(key);
  recordQueue.push({ kind, id, spec });
  void drainRecordQueue();
}
async function drainRecordQueue(): Promise<void> {
  if (recordingActive) return;            // a drain is already running — it picks up newly-queued jobs
  recordingActive = true;
  try {
    while (recordQueue.length) {
      const job = recordQueue.shift()!;
      try { await recordMatch(job.kind, job.id, job.spec); }
      catch (e) { console.error(`[match] replay recording ${job.kind} ${job.id} failed (${(e as Error).message}); result + aftermath unaffected.`); }
      finally { recordQueued.delete(`${job.kind}:${job.id}`); }
    }
  } finally { recordingActive = false; }
}

// STREAM a line-oriented frame source straight to a gzipped temp file — O(1) memory, never the
// whole match at once (a 90' match is ~200k frames / multi-GB uncompressed, which buffering would
// OOM / blow V8's max string length). The score is tracked from the last scored frame as lines
// flow past, and backpressure pauses the source while the gzip drains. We publish (atomic rename
// + row) ONLY on a CLEAN, COMPLETE finish — the source ended AND the final frame's matchState is
// "finished" — so a crashed/timed-out/killed run (stream errored, or EOF'd before the final
// whistle) leaves only a discarded .tmp, never a partial recording or a scoreline that disagrees
// with an unplayed fixture. Exported (not just internal) so a synthetic-stream test exercises it
// without spawning the engine. Returns the derived score + frame count.
// sampleEvery>0 thins captured FRAMES to ~1-in-N (the replay renderer interpolates, so it stays smooth)
// while ALWAYS keeping the first frame, every score change, every matchState change (kickoff/half/FINISHED —
// the capture requires a 'finished' last state) and any non-frame/event line. A full capture is ~200k frames
// (~97MB gz) which floods the replay renderer + balloons load-time memory; thinning the OPT-IN matchday capture
// makes its replay screenshot-able + light. Default 0 = keep every line (the live-watch recorder is unchanged).
export function captureLineStream(kind: RecKind, refId: number, src: NodeJS.ReadableStream, format = 1, sampleEvery = 0): Promise<{ homeScore: number; awayScore: number; frames: number }> {
  return new Promise((resolve, reject) => {
    const rel = recRel(kind, refId);
    const abs = path.join(DATA_DIR, rel);
    const tmp = abs + '.tmp';
    const gz = createGzip();
    const out = createWriteStream(tmp);
    gz.pipe(out);
    let buffer = '', frames = 0, seen = 0, homeScore = 0, awayScore = 0, lastState = '', settled = false, ended = false;
    const fail = (e: Error): void => {
      if (settled) return; settled = true;
      gz.destroy(); out.destroy();
      try { if (existsSync(tmp)) rmSync(tmp, { force: true }); } catch { /* best effort */ }
      reject(e);
    };
    const writeLine = (l: string): void => {
      if (!l.length) return;
      // parse EVERY line for score/state first (a dropped frame still advances the tally), then decide KEEP.
      let isFrame = false, scoreChanged = false, stateChanged = false, eventful = false;
      try {
        const f = JSON.parse(l); isFrame = true;
        if (typeof f.homeScore === 'number') { if (f.homeScore !== homeScore || (f.awayScore ?? 0) !== awayScore) scoreChanged = true; homeScore = f.homeScore; awayScore = f.awayScore ?? 0; }
        if (typeof f.matchState === 'string') { if (f.matchState !== lastState) stateChanged = true; lastState = f.matchState; }
        // Always keep a frame carrying a FRESH notable transient event (a saved/missed penalty, woodwork) so
        // the timeline (analyzeRecording) can surface it — these don't move score/card state, so they'd
        // otherwise be thinned away. Rare + age-gated (~a few frames each) → negligible size cost.
        if (Array.isArray(f.events)) eventful = f.events.some((e: any) => (e.type === 'penalty' || e.type === 'woodwork') && (typeof e.age === 'number' ? e.age : 999) < 150);
      } catch { /* a non-frame/event line — always kept */ }
      seen++;
      // keep everything (no sampling), or any non-frame/score-change/state-change/notable-event, or every Nth frame
      if (!(sampleEvery <= 0 || !isFrame || scoreChanged || stateChanged || eventful || (seen % sampleEvery === 1))) return;
      frames++;
      if (!gz.write(l + '\n')) src.pause();   // backpressure -> bounded memory
    };
    gz.on('drain', () => { if (!settled) src.resume(); });
    src.on('data', (d: Buffer) => {
      buffer += d.toString();
      const parts = buffer.split(/\r?\n/); buffer = parts.pop() ?? '';
      for (const l of parts) writeLine(l);
    });
    src.on('error', e => fail(e));
    out.on('error', e => fail(e));
    // A source .destroy()-ed WITHOUT an error (e.g. coordinator.dispose() when the last viewer leaves
    // mid-match) emits neither 'end' nor 'error' — only 'close'. Without this the Promise never settles and
    // gz/out (+ the .tmp file's fd) leak. 'close' also fires on the clean path AFTER 'end', so guard on
    // `ended` so this only rejects the genuinely-truncated case. fail() destroys gz/out + removes the .tmp.
    src.on('close', () => { if (!settled && !ended) fail(new Error('capture source closed before end')); });
    src.on('end', () => {
      if (settled) return;
      ended = true;
      if (buffer.trim().length) writeLine(buffer.trim());
      if (!frames || lastState !== 'finished') { fail(new Error(`incomplete capture (${frames} frames, last "${lastState}")`)); return; }
      gz.end();   // flush the gzip trailer through to the file
      out.on('finish', () => {
        if (settled) return; settled = true;
        try {
          renameSync(tmp, abs);   // atomic publish: the recording appears only once fully written
          upsertRecordingRow(kind, refId, homeScore, awayScore, rel, frames, statSync(abs).size, format);
          resolve({ homeScore, awayScore, frames });
        } catch (e) {
          try { if (existsSync(tmp)) rmSync(tmp, { force: true }); } catch { /* best effort */ }
          reject(e as Error);
        }
      });
    });
  });
}

// Run a match through the engine FULL-FRAME (no --summary) and capture it. Wires the child's
// lifecycle to the stream: a spawn error or a 120s hang destroys stdout (→ the capture rejects +
// cleans up); a crash EOFs stdout without a "finished" frame, which captureLineStream rejects.
// Captured SAMPLED (1-in-REPLAY_SAMPLE frames + every score/state change) so the matchday replay is
// light enough to load + screenshot — a full ~200k-frame capture floods the renderer (the QA "catch-22").
export const REPLAY_SAMPLE = 8;   // exported: the live coordinator's capture thins with the same rate (unthinned live matches stored ~160-200k frames)
function recordMatch(kind: RecKind, refId: number, specPath: string): Promise<{ homeScore: number; awayScore: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(ENGINE, ['--match', specPath, '--no-debug'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    // 180s: a full-frame capture is heavier than --summary, so give a slow host room to finish (and earn
    // a watchable replay) before the playFixture fallback drops it to --summary. A real hang still lapses.
    const to = setTimeout(() => { try { child.kill(); } catch { /* gone */ } child.stdout.destroy(new Error(`engine timeout: ${err}`)); }, 180000);
    child.on('error', e => { try { child.stdout.destroy(e); } catch { /* gone */ } });
    captureLineStream(kind, refId, child.stdout, 1, REPLAY_SAMPLE).then(
      r => { clearTimeout(to); resolve({ homeScore: r.homeScore, awayScore: r.awayScore }); },
      e => { clearTimeout(to); try { child.kill(); } catch { /* gone */ } reject(e); },
    );
  });
}
