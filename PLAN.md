# footy-sim → the game

Turning the match engine into an FM-style web game. Core loop the user wants:
**register → log in → create a team → get placed in a league → set tactics →
play your fixtures (vs AI or other humans, simulated) → watch the 2D replay →
league table updates.**

"Play against others" is the FM model: you don't control players live — you set
tactics, matches simulate deterministically server-side, you watch the replay.
(Live human-controlled play is a much later, maybe-never phase.)

## Architecture

```
native/            C++ engine — now DATA-DRIVEN: `live.exe --match spec.json`
                   builds the 22 players from rosters + applies tactics dials,
                   instead of the hardcoded legend arrays. seed kept for determinism.
server/            NEW. Node + Fastify + node:sqlite. Auth, game state, match orchestration.
  db.ts            schema + migrations (users, teams, players, leagues, fixtures, matches)
  auth.ts          register/login, scrypt hashing, cookie sessions
  game.ts          team generation, league seeding, fixtures, standings
  match.ts         run a fixture through live.exe (spec in, result out), store it
  index.ts         Fastify app + routes + static serve of the built frontend
src/
  cpp-server.ts    relay — extended to spawn a match SPEC (for watching a stored fixture)
  renderer.ts      PixiJS renderer — reused unchanged as the watch view
  web/             NEW. React app (login, dashboard, create-team, tactics, watch)
```

## Data model (SQLite)

- **users**(id, username, pass_hash, pass_salt, created_at)
- **leagues**(id, name, season, status)
- **teams**(id, user_id NULL=AI, league_id, name, tactics_json, created_at)
- **players**(id, team_id, name, role, slot 0..10, attrs_json)
- **fixtures**(id, league_id, round, home_team_id, away_team_id, seed, played, home_score, away_score)
- **sessions**(id, user_id, expires)

11 players per team in the fixed engine formation slots:
GK, FB, CB, CB, FB, CM, CM, CM, WM, CF, WM (slots 0..10 == engine ids 0..10).
Tactics = the 5 Config dials: aggression, passingDirectness, overlapFrequency,
midfieldFreedom, defensiveLineHeight (0..100).

## Match flow

A fixture stores a fixed `seed`. To play/watch it, build a match spec from both
teams' rosters+tactics and run `live.exe --match spec.json` (deterministic).
The result (score) is parsed from the engine summary and stored. To WATCH, the
relay spawns the same spec and streams frames to the renderer — same seed, so the
replay always matches the stored result.

## Phases

1. **Data-driven engine** — `--match spec.json` input path. ← foundation
2. **Backend** — Fastify + node:sqlite, auth, team/league/fixture entities,
   AI-team seeding, "play fixture" orchestration, standings. (curl-tested)
3. **Frontend** — React: auth, dashboard, create-team, tactics, watch-match.
4. Later: real fake-name player pools, scheduled/cron auto-sim, promotion/
   relegation, transfers, text-based tactics, true live PvP.

## How to run (localhost)

Two processes:
```
npm run game     # backend API + match-watch WS on http://localhost:4000
npm run dev      # Vite frontend on http://localhost:5173 (proxies /api + /ws -> 4000)
```
Open http://localhost:5173 → register → create a club → Play matchday → Watch.
(`npm run game` rebuilds the engine first via the `native:build` prebuild step;
re-run it after any native/ change — tsx does not hot-reload.)

Production-ish single server: `npm run build` (vite build → dist/), then
`npm run game` serves the built SPA + API on :4000.

The SQLite db lives at `server/data/footy.sqlite` (gitignored). Delete it to wipe
all accounts/leagues.

## Status — MVP COMPLETE (phases 1-3)
Phases 1-3 done and verified in-browser: register → create team (generated fake
players) → 8-team league vs AI + round-robin fixtures → play matchdays (table
advances) → watch the 2D match with your own players → navigate back. Each phase
is a separate commit. Phase 4 (shared human leagues/lobbies, scheduled auto-sim,
promotion/relegation, transfers, text tactics, live PvP) is future work.
