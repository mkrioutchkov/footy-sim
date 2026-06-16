Shouts, the Evolving Plan, and Player Personality — design sketch

Status: SHIPPED (2026-06-16). The 3-phase loop is built — plan.ts (composite plan), personality.ts (personalities), morale.ts + press.ts (morale + press conferences), match.ts (engine morale hook). This doc is now the as-built design; only personality *drift* and per-directive compliance gating remain (see TACTICS.md P5).



1\. One shout box → one evolving "composite plan"

Today the box is stateless (text → directives for that text only). Target is a stateful, LLM-maintained plan:



Pre-match: manager types initial instructions → LLM resolves them into the composite plan (all standing orders, per-player + team), shown in a read-only "composite plan" textarea (human text) backed by structured directives.

Mid-match: each shout is an edit against the current plan, not a fresh compile. The LLM takes (current plan + this shout + match context) → returns the new plan. The shout's content decides the edit size: amend one player · major overhaul · nuke it ("forget all that") · or no tactical change at all (a pure bollocking → §2).

The LLM decides how the read-only plan reads after each shout and what the directives become. The plan is the single source of truth the engine runs.

Contract shift — from text → directives to a plan editor:



in:  { currentPlan, shout, ctx:{minute,score,...} }

out: { plan:{summary, directives\[]}, changed:"1 line", motivation\[], note? }

The existing tactics.ts guards (name resolution, condition gate, note) carry over — they operate on a diff against the plan. Directives still freeze on the timeline for deterministic replay (plan after shout N = what re-sims from clock N). Keep the current single-shout flow working; make this additive/reversible.



2\. Player personality → how shouts land (motivation)

A shout isn't only tactical. "Get up the pitch" moves a player; "fuck you, homo" is a motivational act whose effect depends on who you said it to.



Each player has an LLM-generated personality (at squad creation, persisted): traits that drive reactions (temperament, criticismResponse, praiseResponse, bigGame, consistency, leadership, professionalism, ego) — short descriptors + 0–100 dials so both LLM and engine read them — plus backstory, nationality, tagline, and a live morale (0–100, default 65). Modifiable later by training/events.

Shouts move morale, gated by personality. Thick-skinned/confrontational → "fuck you" can fire them up (morale ↑, brief lift); sensitive → sulk (↓). Praise lifts most, but a big ego gets complacent. Pure-motivation shout → morale only. Cap \~2 motivation changes/player/game (tactical edits uncapped; motivational ones scarce + meaningful).

Morale → effect: a small, decaying modifier on effective performance (work-rate / decision quality / slight attr multiplier) — shades a match, never dominates. Hook mirrors how injurySeverity already scales a player; deterministic (no rng in the apply).

3\. Prompt sketches

3a — Personality generation (squad creation):



Generate a player's personality. Output JSON: {traits:{temperament,criticismResponse,praiseResponse,bigGame,consistency,leadership,professionalism,ego} (0–100), nationality, backstory:"2–3 sentences", tagline}. Vary them — hotheads, model pros, fragile talents, grizzled leaders. criticismResponse high = thrives on a rocket; low = wilts. Input: name, role, age, key attrs.



3b — Shout → plan edit + motivation (the core loop):



You are the manager's voice. Hold the CURRENT PLAN, edit it per the shout, AND judge the shout's motivational effect using the addressed player's personality. Output JSON: {plan:{summary,directives\[]}, changed:"1 line", motivation:\[{playerId,moraleDelta:-30..30,reaction:"in-character line",durationMin}], note}. Rules: edit by intent (amend one / overhaul / nuke / no-op); a purely abusive or praising shout with no tactic → directives unchanged, motivation only; moraleDelta sign+size come from personality (criticismResponse/praiseResponse/ego/temperament), not the literal words; respect the per-player cap (caller passes motivationUsed; if at cap → delta 0 + say so in note); never invent players (same guards as tactics). Input: currentPlan, shout, squad(names+initials+personalities+morale+motivationUsed), ctx.



3c — reuse the tactics name/initials/condition guards from tactics.ts verbatim.



4\. Data model (when built)

Player.personality (3a JSON) + morale are persisted columns (`players.personality`, `players.morale`, default 65) + per-match motivationUsed. The composite plan is NOT a persisted Team column — it lives per-match in `MatchSession.plan` (match.ts) and is frozen on the directive timeline for deterministic replay (plan after shout N = what re-sims from clock N). Engine morale folds into effort/decision scoring (small, decaying, deterministic).



5\. Phasing — SHIPPED

- [x] Composite plan / stateful shouts (LLM plan-editor) — `plan.ts`.
- [x] Personality generation + storage (squad creation + DB) — `personality.ts`, `players.personality`.
- [x] Motivation loop (shout→morale via personality + cap + engine hook) — `morale.ts` + the runtime moraleBoost/moraleDelta in `match.ts`; press conferences (`press.ts`) also move morale via the same dials.
- [ ] Later: training-driven personality drift, backstory events, media.

Related: docs/TACTICS.md (the directive vocabulary).

