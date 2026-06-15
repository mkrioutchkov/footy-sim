# Overnight autonomous run — 2026-06-16

Working the prioritized backlog top-down. Each VERIFIED increment committed+pushed to master
(determinism + golden green; paired-measured; revert if noise/backfire).

## SHIPPED (this overnight run)
- **0. SHOUTS_AND_PERSONALITY.md** committed (`5eaeda1`) + memory pointer.
- **1c. weak dials strengthened** (`ae1daa1`): all_out_attack amplified via the attacking-runs mechanism
  (allOutActive flag → commit FB+CM forward on central carries) — homeShots 10.1→11.5 (win 45%→59%),
  homeGoals 0.67→1.04; drop_off + slow_it_down bigger deltas (drop_off tackles now move the right way).
  Golden GREEN, determinism IDENTICAL.
- **2/A4. height attribute** (`123bb24` engine + `99e36a0` backend): aerial duels blend positioning+height
  50/50; height defaults to positioning (golden byte-identical) and bites when distinct (3/8 seeds diverge
  at extreme heights). Backend genAttrs now generates varied height by role (CB+24/GK+16/CF+12/…). Foundation
  for "target the tall man".

## SHIPPED earlier this session (pre-loop)
- counter_attack + offside_trap kinds, play_it_long commit-boost (`1dd9f2e`); formation foundation A0 — engine
  reads per-slot role+homeX/homeY from spec, hasLayout=false default keeps golden identical (`ed95211`).
- **1a get_forward is NOT a regression** — bench's FAIL was 5-seed noise (16-seed probe: +20px fwd, 15/16 up);
  fixed the bench (movement 5→12 seeds). 1b offside_trap reworked to spring offsides. 1d counter/offside committed.

- **2/A1 formation registry** (formations.ts): 7 shapes (4-3-3, 4-4-2, 4-2-3-1, 3-5-2, 5-3-2, 4-5-1, 3-4-3)
  in the engine HOME frame + a roleFit scorer + normalizeFormation. Verified via tools/_formprobe.py: the
  4-3-3 entry reproduces the engine default BYTE-FOR-BYTE across 5 seeds (coords == DEF_*), and 4-4-2 plays
  differently 5/5. Pure data + helper, no engine/live-flow touch.
- **2/A3 LLM lineup compiler** (lineup.ts): "play 4-4-2" / "AB at left back" / "Lange lone striker" / ASCII grid
  -> {formation, 11-slot assignment, note}. LLM parses intent (shape + explicit overrides + ASCII + nonsense);
  CODE does deterministic role-fit assignment (best tackler->CB, quickest->WM, sharpest->CF). Verified live vs
  Groq: shapes + overrides honoured, Messi/"cup of tea" correctly noted-not-substituted. Standalone module (not
  yet imported by the server) — no live-flow risk.

## ON THE BENCH / NEXT (in order)
- Formation A2: wire A1+A3 into the live flow (DB teams.formation/lineup cols, match.ts specForTeam emits
  role+homeX/homeY mirrored for away, pre-match screen). NEEDS REVIEW — touches DB + watch flow + UX (see below).
- Item 5: goalKickExitedOwnThird is NOT a safe tidy — it's a real metric (goal kicks clearing the def third in
  18s) and golden hashes the FULL summary JSON, so removing it breaks golden + native-batch.ts. Left as-is.

## DECISIONS WAITING FOR MAX (need your taste / touch the live flow — NOT guessed per the brief)
- **Formation A2 + frontend (the user-facing "play 4-4-2" path).** A0 (engine) + A4 (height) are in; A1 registry
  + A3 compiler are buildable. But wiring it END-TO-END needs: a DB migration (teams.formation/lineup columns),
  match.ts specForTeam emitting role+anchors, AND a pre-match SCREEN in app.ts. That touches the live DB + watch
  flow + is a UX surface — your call on the screen's shape. I'll build the safe backend/compiler pieces and leave
  the frontend screen + DB-migration wiring for you to review. NOTE: when both sides pick shapes, formation
  BALANCE needs a paired audit — in the A1 probe a HOME 4-4-2 (two high CFs) vs the default away 4-3-3 ran up
  7-0/5-0, so some shapes look over/under-powered head-to-head; the anchors likely need tuning once both teams
  use them. Also the greedy fit-assignment shoehorns (e.g. a winger as the 3rd CB in 3-5-2) — fine for v1, a
  Hungarian assignment would be optimal.
- **Item 3 composite-plan / stateful shouts.** A rework of the live tactics box (each shout edits a persistent
  plan vs fresh compile). Big UX + live-flow change; the doc itself flags it as the biggest UX piece. Foundation
  is the {currentPlan, shout, ctx} → {plan, changed, motivation, note} contract — I'll sketch it but NOT swap the
  live box autonomously (brief: never break the live tactics box).
- **Item 4 personality + motivation.** LLM personality gen at squad creation + the shout→morale loop. The engine
  morale hook (small/decaying/deterministic, mirror injurySeverity) is a clean foundation I can build; the LLM
  personality JSON + the shout→morale mapping need your taste (reaction tuning, cap). Foundation + note.
- **press_hard** dial: its bench metric (total tackles) is the wrong proxy for a per-player press; needs an
  interceptions / opp-pass-completion metric. Left as-is (works directionally).
- **Item 5 scorePassToTarget split**: a 300-line refactor = destabilization risk; skipping unless clearly safe.

## AUDIT BASELINE (paired-30, fixture-1 HOME directed) — for reference
PASS: shoot_on_sight, high_press, man_mark, play_simple, play_it_long, dribble_more, keep_it_on_ground,
      stay_on_feet, counter_attack, sit_deep, stay_wide, come_inside, get_it_wide, play_narrow, stay_central,
      push_up, get_forward(@12seeds), all_out_attack(now 59%).
WEAK-but-directional: drop_off, slow_it_down (tempo proxy weak), cross_early, tackle_hard (rare-metric), press_hard.
