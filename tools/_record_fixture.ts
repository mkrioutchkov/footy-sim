// One-off: record a full-frame replay for an existing fixture using the CURRENT engine build.
//   npx tsx tools/_record_fixture.ts <fixtureId>
// Writes recordings/fixture-<id>.ndjson.gz + upserts the match_recordings row (replaces any older recording).
//
// Records through the backend's own recordMatch — the same spawn, capture and hang watchdog a
// matchday recording gets. This tool used to carry a copy of that code with its own 180s cap, and
// on 2026-11-10 it gave up ("engine timeout") on a healthy capture that needed 389s.
//
// NOTE: a cached match report is keyed by fixture and is NOT invalidated by a re-record, so a
// fixture that already has a match_reports row keeps the OLD recording's goal markers and write-up.
import { getFixture, writeSpec, recordMatch } from '../web/backend/match.ts';
import { ENGINE } from '../web/backend/match/runtime.ts';

const id = Number(process.argv[2]);
if (!Number.isInteger(id)) { console.error('usage: npx tsx tools/_record_fixture.ts <fixtureId>'); process.exit(1); }

const fx = getFixture(id);
if (!fx) { console.error(`fixture ${id} not found`); process.exit(1); }

const specPath = writeSpec(fx);
console.log(`recording fixture ${id} via ${ENGINE} (spec ${specPath})…`);

const t0 = Date.now();
try {
  const r = await recordMatch('fixture', id, specPath);
  console.log(`done: fixture ${id} recorded ${r.homeScore}-${r.awayScore} (${r.frames} frames) in ${Math.round((Date.now() - t0) / 1000)}s`);
} catch (e) {
  console.error(`recording failed: ${(e as Error).message}`);
  process.exit(1);
}
