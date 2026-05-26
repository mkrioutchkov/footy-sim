# Footy Sim - Current Native Architecture

This section supersedes the legacy TypeScript-engine description retained
below for historical context. The simulation is now C++ owned by `native/`;
TypeScript is only the browser renderer, WebSocket relay, and native benchmark
driver.

```
footy-sim/
|-- native/              C++ engine source and generated executables
|-- scripts/             native build and live deployment scripts
|-- src/cpp-server.ts    paced WebSocket relay for native/live.exe
|-- src/native-batch.ts  concurrent seeded native benchmark driver
|-- src/native-scenarios.ts  long-run native quality guards
|-- src/main.ts          renderer client entry point
|-- src/renderer.ts      Pixi renderer
|-- src/types.ts         renderer state contract
`-- src/constants.ts     renderer pitch constants
```

## Run And Verify

```powershell
npm.cmd run build
npm.cmd run scenarios
npm.cmd run benchmark

# terminal 1: build/deploy the live native executable and relay it
npm.cmd run server

# terminal 2: browser client
npm.cmd run dev
```

`npm.cmd run benchmark` builds `native/benchmark.exe` and concurrently runs
eight deterministic ten-minute summaries. `npm.cmd run server` deploys that
build to `native/live.exe`; using separate files avoids rebuild failure while
the visible match process is running. The client connects to
`ws://localhost:3000`; there is no legacy engine selector.

## Current Measurement

Accepted native baseline on seeds `101-108`, ten simulated minutes each
(`2026-05-26`): `0.6` goals/match, `3.9` shots/match, `48.4%` on target,
`81.8%` pass completion and `35.4` tackle attempts/match. Hard quality flags
for stuck carriers, abnormal tackle launches/OOB, own-pass goals, unknown
loose goals, better-pass shots and tight-angle shots are all zero.

The new shot-choice audit finds `3.6` sampled low-pressure CF shooting
openings/match between `120` and `190` px, all deferred for dribbling, but
zero deferred openings inside `120` px. A direct shot-score boost was tested
and rejected because it reduced shots to `2.9` and goals to `0.4`; chance
construction, not weaker shooting criteria, is the next attacking problem.

## Known Native Gaps

`GameEngine::isOffsideTarget`, `offsideLineFor`, `committedRunFor`, and
`teamPhaseFor` remain placeholder implementations in the native port. Offside
and coordinated onside runs must be implemented together before adding more
aggressive penalty-area movement.

