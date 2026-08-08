// Where the TypeScript layer meets the C++ binary on disk: the engine executable and the
// data/scratch directories every match path writes through. Resolved ONCE at import — exactly
// when match.ts used to resolve them — because a test pins FOOTY_DB and process.cwd() BEFORE
// its first backend import and depends on that timing (see tools/_report_test.ts's header).
import { mkdirSync } from 'node:fs';
import path from 'node:path';

// Engine binary resolution lives in ONE shared helper (engine-path.ts) so every spawner —
// this runner, the live coordinator, the dev cpp-server, the batch tools — agrees on the name.
import { resolveEngine } from '../engine-path.ts';
export const ENGINE = resolveEngine(path.resolve(process.cwd(), 'build'));
// Recordings live next to the DB (so a temp-DB test writes them to its temp dir, never the
// real save), and the SPEC scratch under the canonical data dir.
export const DATA_DIR = process.env.FOOTY_DB ? path.dirname(process.env.FOOTY_DB) : path.resolve(process.cwd(), 'web', 'backend', 'data');
export const SPEC_DIR = path.resolve(process.cwd(), 'web', 'backend', 'data', 'specs');
const REC_DIR = path.join(DATA_DIR, 'recordings');
mkdirSync(SPEC_DIR, { recursive: true });
mkdirSync(REC_DIR, { recursive: true });
export const MINUTES = Number.parseInt(process.env.FOOTY_MINUTES ?? '90', 10);
