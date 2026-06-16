// Prune match recordings (prototype housekeeping). A recording is a gzipped NDJSON frame file
// under <data>/recordings plus a row in match_recordings; this deletes both for recordings
// beyond a retention policy. Newest-first: keeps the most recent KEEP, and/or drops anything
// older than MAX_AGE_DAYS.
//
//   npx tsx tools/recordings_gc.ts                       # keep the most recent 100
//   KEEP=50 npx tsx tools/recordings_gc.ts
//   MAX_AGE_DAYS=14 npx tsx tools/recordings_gc.ts
//   FOOTY_DB=/path/to/save.sqlite npx tsx tools/recordings_gc.ts   # target a specific save
//
// Safe to run while the game server is up (WAL); it only touches match_recordings + its files.
import { pruneRecordings } from '../web/backend/match.ts';

const keep = Number(process.env.KEEP ?? 100);
const maxAgeDays = process.env.MAX_AGE_DAYS ? Number(process.env.MAX_AGE_DAYS) : undefined;
const r = pruneRecordings({ keep, maxAgeDays });
console.log(`recordings_gc: pruned ${r.pruned} recording(s) — ${r.files} file(s) removed, ${r.kept} kept` +
  (maxAgeDays != null ? ` (keep ${keep}, max age ${maxAgeDays}d)` : ` (keep ${keep})`));
