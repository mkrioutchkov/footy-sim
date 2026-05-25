# TODO — Footy Sim

## Active — P0 (affects benchmarks)
- [ ] Recover credible chance volume (`4.4` shots / match after rejecting bad attempts) through delivery and movement, not weaker shot geometry
- [ ] Replay the remaining `no_shots` alerts (`6` in the standard run) while creating wide/cutback alternatives
- [ ] Validate dribble-type episodes and tackle outcomes (`84.3` fast, `6.6` medium, `16.0` close / match)

## Active — P1 (realism metrics)
- [ ] Cross frequency and completion (`0.3` attempts, `0` completions / match) through positioning and delivery choices only
- [ ] Cross-to-shot chain (`0` / match; do not expand receiver/header reach)
- [ ] Shot block rate (`5.7%` current run; replay after restoring credible shots)
- [ ] Monitor final-third entry-to-shot conversion (`18.6%` current run)
- [ ] Goals consistency (`1.1` / match standard run)

## Active — P2

## Done
- [x] Replay and remove selected low-value shots (`2.1` to `0.0` / match); rejected shot options cannot be revived by urgency/pressure bonuses
- [x] Reserve scripted corner wind-up execution; a corner taker cannot take an ordinary shot before the scheduled cross
- [x] Tighten `poor_gk_save_attempt` to clear keeper failures; ordinary failed `74-82%` save chances no longer raise a false alarm (`0.4` to `0.0` / match)
- [x] Restore TypeScript build after metrics/cross changes
- [x] Add deterministic `npm.cmd run scenarios` checks for contact, cross completion, header reach, shot blocks and final-third conversion
- [x] Remove extended cross-header contact reach; aerial contact remains at 20px
- [x] Bound final-third conversion to one resulting shot per attacking-third possession entry
- [x] Attribute outfield shot blocks before the shot state is cleared
- [x] Establish valid standard baseline: final-third entry-to-shot `24.3%`, shot blocks `9.1%`, panic clears `0`
- [x] Pass-triggered player reactions (defenders intercept — +0.12 chase near trajectory)
- [x] Sliding tackle angle alerts (rear_tackle, head_on_tackle)
- [x] Backward pass audit (questionable_backpass)
- [x] TODO.md created + AGENTS.md + autonomous agents
- [x] Offsides (0 → 0.5)
- [x] Color bug (stamina-based alpha variance fixed)
- [x] Unpressured out-of-play counter stores pressure at launch
- [x] Time-wasting dribble counter added
- [x] GK save significantly nerfed (floor 0.04)
- [x] Cross→shoot boosted (0.52 at 260px/5°)
- [x] Cross loft lowered + speed 1.25x
- [x] Box floor 0.35/0.52/0.70 for point-blank shots
- [x] Cross goals (0 → 0.1, first ever)
- [x] Cutback goals (0 → 0.3)
- [x] Ghost dispossessions
- [x] Slide tackle oval stuck bug
- [x] Ball shadow for elevation
- [x] Through-ball→shot chain
- [x] Avoidable press (15.4 → 12-14)
- [x] Shot frequency (3.3 → 5.5)
- [x] Pass completion (73.4 → 76.7)
- [x] Box dimensions (penalty 403×165, goal 183×55)
- [x] GK distribution (short/medium/long)
- [x] Headers (physics work)
- [x] Free kicks on tackles
- [x] Short corners
- [x] Cross curl/spin
- [x] Flickering fix (smooth facing synced)
- [x] 3D ball shadow
- [x] Legs + head visuals
- [x] Backward dribble alert
- [x] Why-no-shoot alert
- [x] Defender passive alert
- [x] Player way-off alert
- [x] Receiver lead overshoot fix

## Benchmarks needed
- [ ] Backward pass audit (questionable_backpass flag exists)
- [ ] Sliding tackle angle audit (rear_tackle flag exists)
- [ ] Kicking-out-of-play audit (unpressured clearances)
- [ ] Pointless backward dribble audit (time wasting)
- [ ] Pass reaction time audit
- [ ] Cross conversion audit
- [ ] Through-ball completion rate
- [ ] Defensive shape compactness metric
