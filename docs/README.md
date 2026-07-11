# docs/ — index

The map of this directory. Start here.

**Core**
| Doc | What it is |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | System map: engine + backend + frontend + DB + LLM modules, and the key flows. |
| [CONTRACT.md](CONTRACT.md) | The **frozen engine↔web interface** — CLI, `spec.json` input, `--summary`/frame output, the `directives`/`timeline` schema, the recording contract. Authoritative seam (with `web/frontend/types.ts`); change deliberately, both sides together. |
| [TEAM.md](TEAM.md) | The 3-session dev model (Engine / web / SysArch), ownership boundaries, and the comms protocol — the **process** layer over CONTRACT.md. |

**Tactics**
| Doc | What it is |
|---|---|
| [TACTICS.md](TACTICS.md) | The tactics feature — design of the plain-English text→directives compiler + the structured board; the directive vocabulary (**~25 per-player + 17 team-wide + 4 set-piece-taker** kinds; authoritative list = `web/backend/tactics.ts` VALID_KINDS + `engine/main.cpp parseDirectives`), engine mechanisms, the golden guard. |
| [TACTICS_RUNTIME.md](TACTICS_RUNTIME.md) | The as-built tactics **runtime**: the live compiler (`plan.ts`) + the deterministic structured board, the shout→timeline→re-sim flow, the engine mechanisms, and the **persistence model**. |
| [TACTICS_ENGINE_FOLLOWUPS.md](TACTICS_ENGINE_FOLLOWUPS.md) | Forward-looking engine hand-off: the 3 FM roles that need C++ work (ball-playing CB, true DM/AM, true inverted full-back) + the parked role-weighted-`overall()` MR. |
| [SHOUTS_AND_PERSONALITY.md](SHOUTS_AND_PERSONALITY.md) | The shouts → composite-plan → personality → morale loop; design rationale + the as-built data model. |

**Systems**
| Doc | What it is |
|---|---|
| [MANAGER_AI.md](MANAGER_AI.md) | The AI/assistant-manager contract (the pre-matchday seam that sets tactics + XI for AI clubs). |
| [LIVE_MATCH_ARCHITECTURE.md](LIVE_MATCH_ARCHITECTURE.md) | The live-match architecture (engine self-pacing, the coordinator edit-lock + fan-out, event-sourcing) + the still-pending runner. |
| [TRAINING_COACHES_SPEC.md](TRAINING_COACHES_SPEC.md) | The training & coaches model (development, specialist coaches, intensity/burnout, retraining) — spec + roadmap. |

**Reference**
| Doc | What it is |
|---|---|
| [STATSBOMB_DATA.md](STATSBOMB_DATA.md) | StatsBomb open-data **licence** (research/calibration only) + ~80 real-world **calibration benchmark** targets mapped to engine levers. (Some keeper figures predate the keeper nerf — see the callout.) |
| [REAL_DATA_AND_IP.md](REAL_DATA_AND_IP.md) | Can footy-sim ship real teams/players? IP verdict (no, in a sold build) + the fictional-defaults + community-editor path. |

**Authoritative pointers**
- The engine↔web boundary is **CONTRACT.md + `web/frontend/types.ts`** — nothing else.
- The directive vocabulary is owned by **`web/backend/tactics.ts` VALID_KINDS** (+ `engine/main.cpp parseDirectives`); TACTICS.md documents it, other docs link rather than re-list.
- Ownership / who-does-what is **TEAM.md**.

`GAME_LAYER_NOTES.md` (repo root) is the rolling game-layer build log — treat `docs/` as the curated layer and that as the running ledger.
