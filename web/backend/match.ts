// The backend's engine seam. This module is now a FACADE: every symbol below still resolves
// exactly as it did when all 1,144 lines lived here, so coordinator.ts, routes/**, fastsim.ts,
// report.ts, news.ts, leaders.ts, season.ts, national.ts and tools/** keep importing from
// './match.ts' unchanged. The implementation lives in ./match/, split along the seams the file
// already had:
//
//   match/runtime.ts      the engine binary + the data/spec/recordings dirs (resolved at import)
//   match/weather.ts      §weather — the pure seed→condition function
//   match/spec.ts         DB → engine spec (specForTeam, buildTieSpec, writeSpec) + getFixture
//   match/summary.ts      the --summary result path (runEngineSummary, withSubstitutionStints)
//   match/recordings.ts   the recording store: rows, files, retention, hasHumanStake
//   match/capture.ts      producing a recording: captureLineStream, recordMatch, the record queue
//   match/events-log.ts   the event-sourced command log + its self-contained re-sim spec
//   match/pacer.ts        paceStep + FramePacer — pacing frames to one client (DEFAULT_FRAME_MS)
//   match/streams.ts      the three frame sources: MatchStream / ReplayStream / EventsReplayStream
//   match/pool.ts         MATCH_CONCURRENCY + mapPool — how many engines a matchday may run
//   match/play.ts         playFixture / playCupTie / playVirtualTie / recordReplay
//
// Re-exports are listed EXPLICITLY (not `export *`) so this file is the auditable record of the
// public surface: adding a symbol to a submodule does not silently widen it.

export { type Weather, weatherForSeed } from './match/weather.ts';
export { getFixture, buildTieSpec, buildSpec, writeSpec } from './match/spec.ts';
export { type SummaryPlayer, type SummaryResult, withSubstitutionStints } from './match/summary.ts';
export {
  type RecKind, type Recording,
  hasHumanStake, persistRecording, recordingFor, loadRecording, pruneRecordings, purgeRecordings,
} from './match/recordings.ts';
export { REPLAY_SAMPLE, captureLineStream } from './match/capture.ts';
export {
  type Command, type EventsLog, type ShoutReviewEntry,
  writeEventsLog, loadEventsLog, commandsToTimeline, buildReplaySpec, tacticsReview, replayViaTimeline,
} from './match/events-log.ts';
export { DEFAULT_FRAME_MS, type PaceStep, paceStep } from './match/pacer.ts';
export { MatchStream, ReplayStream, EventsReplayStream } from './match/streams.ts';
export { MATCH_CONCURRENCY, mapPool } from './match/pool.ts';
export {
  type PlayResult, type CupTieResult, type VirtualPlayer,
  playFixture, recordReplay, playCupTie, playVirtualTie,
} from './match/play.ts';
