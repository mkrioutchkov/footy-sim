# docs/ — index

The map of this directory. Start here.

| Doc | What it is | Status |
|---|---|---|
| [TEAM.md](TEAM.md) | The 3-session dev model (Boris=Engine, Gaylord=web, Fuckwit=SysArch), ownership boundaries, and the comms protocol. The **process** layer over CONTRACT.md. | current |
| [CONTRACT.md](CONTRACT.md) | The **frozen engine↔web interface** — CLI, `spec.json` input, `--summary` output, the `directives`/`timeline` schema. Authoritative seam (with `web/frontend/types.ts`); change deliberately, both sides together. | current |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System map: engine + backend + frontend + DB + LLM modules, and the key flows. | current (refreshed 2026-06-16) |
| [TACTICS.md](TACTICS.md) | The plain-English tactics feature: text→directives compiler (LLM-only, Groq), the directive vocabulary (**17 per-player + 12 team-wide** — the authoritative list), engine mechanisms, the golden guard. | current |
| [TACTICS_RUNTIME.md](TACTICS_RUNTIME.md) | The as-built tactics **runtime**: live compiler (`plan.ts`), the shout→timeline→re-sim flow, the engine mechanisms, and the **persistence model** (what survives a restart — and what doesn't). | current |
| [SHOUTS_AND_PERSONALITY.md](SHOUTS_AND_PERSONALITY.md) | The shouts → composite-plan → personality → morale loop (shipped); prompt sketches and the as-built data model. | current |
| [STATSBOMB_DATA.md](STATSBOMB_DATA.md) | StatsBomb open-data **licence** (research/calibration only) + ~80 real-world **calibration benchmark** targets mapped to engine levers. | current; **keeper figures in §3.0 superseded by the keeper nerf** — see the callout |
| [REAL_DATA_AND_IP.md](REAL_DATA_AND_IP.md) | Can footy-sim use real teams/players? IP verdict (no, in a sold build) + the fictional-defaults + community-editor path. AU-based dev, global release. | current |

**Authoritative pointers**
- The engine↔web boundary is **CONTRACT.md + `web/frontend/types.ts`** — nothing else.
- The directive vocabulary is owned by **TACTICS.md** (+ `engine/main.cpp parseDirectives` / `web/backend/tactics.ts`); other docs link to it rather than re-list it.
- Ownership / who-does-what is **TEAM.md**.

**Live roadmap & working notes** (root, not in `docs/`): `GAME_LAYER_NOTES.md`,
`NOTES_OVERNIGHT.md` — the rolling build log. These may lag the code; treat `docs/`
as the curated layer and the root notes as scratch.
