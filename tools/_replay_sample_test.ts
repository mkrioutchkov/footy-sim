// captureLineStream frame-sampling test (synthetic stream — no engine). Proves the OPT-IN matchday
// thinning keeps ~1-in-N frames AND always keeps score changes, state changes and the 'finished' frame,
// while the default (sampleEvery=0) keeps every line (the live-watch recorder is unchanged).
//   npx tsx tools/_replay_sample_test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'footy-rs-'));
process.env.FOOTY_DB = path.join(tmp, 'test.sqlite');
process.env.TACTICS_LLM_API_KEY = '';

let pass = 0, fail = 0;
const check = (c: boolean, m: string): void => { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } };

const match = await import('../web/backend/match.ts');   // its DATA_DIR = dirname(FOOTY_DB) = our tmp, so the test writes into tmp (auto-cleaned)

const N = 200;
// frame t: kickoff at 0, finished at N-1, else playing; a goal at t=3 (a NON-1-in-8-boundary line → must
// be kept by the score-change rule) and another at t=150.
function frames(): string {
  const lines: string[] = [];
  let h = 0;
  for (let t = 0; t < N; t++) {
    if (t === 3 || t === 150) h++;
    const matchState = t === 0 ? 'kickoff' : t === N - 1 ? 'finished' : 'playing';
    lines.push(JSON.stringify({ t, matchState, homeScore: h, awayScore: 0 }));
  }
  return lines.join('\n');   // no trailing newline → last (finished) line flushes from the buffer on 'end'
}
// ── sampled (1-in-8) ────────────────────────────────────────────────────────
const sampled = await match.captureLineStream('fixture', 990001, Readable.from([frames()]), 1, 8);
check(sampled.homeScore === 2 && sampled.awayScore === 0, `score tracked through sampling (${sampled.homeScore}-${sampled.awayScore} == 2-0)`);
check(sampled.frames < N / 2 && sampled.frames > 0, `sampling thinned the capture (${sampled.frames} << ${N})`);
const kept = match.loadRecording(match.recordingFor('fixture', 990001)!).map(l => JSON.parse(l));
const ts = new Set(kept.map(f => f.t));
check(ts.has(3) && ts.has(150), 'both score-change frames are ALWAYS kept (even off the 1-in-8 boundary)');
check(kept[kept.length - 1].matchState === 'finished', "the 'finished' frame is kept (capture would reject otherwise)");
check(kept[0].t === 0, 'the first frame is kept');

// ── default (no sampling) keeps EVERY frame — the live-watch recorder is unchanged ──
const full = await match.captureLineStream('fixture', 990002, Readable.from([frames()]), 1, 0);
check(full.frames === N, `default sampleEvery=0 keeps every frame (${full.frames} == ${N})`);

console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
try { const { db } = await import('../web/backend/db.ts'); db.close(); } catch { /* */ }   // release the FOOTY_DB lock before rm (Windows EPERM)
try { rmSync(tmp, { recursive: true, force: true }); } catch { /* OS reaps the temp dir */ }
process.exit(fail === 0 ? 0 : 1);
