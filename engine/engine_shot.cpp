// engine_shot.cpp — striking the ball goalward, and the knock-ahead
//
// Split out of engine_actions.cpp. shootBall is the whole shot pipeline
// (accuracy, pressure, placement error, header vs foot, the release), and the
// knock-ahead pair is the sprint touch that trades control for pace.
#include "engine.h"

// Round-48 (seed-1110 audit: shots into a defender 2-4m away or into a
// team-mate's back; 12 of 31 shots were the auto first-time finish from the D
// into a crowd). Nothing in the shot decision looked at who stood on the line.
int GameEngine::shotLaneBody(const Player& shooter) const {
    double gx = goalXFor(shooter.team), gy = PITCH_H / 2.0;
    double dx = gx - shooter.x, dy = gy - shooter.y, len = std::hypot(dx, dy);
    if (len < 1.0) return 0;
    dx /= len; dy /= len;
    int found = 0;
    for (const auto& o : state.players) {
        if (o.id == shooter.id || o.role == Role::GK || o.sentOff) continue;
        double along = (o.x - shooter.x) * dx + (o.y - shooter.y) * dy;
        if (along < 10.0 || along > SHOT_LANE_NEAR_PX) continue;
        double perp = std::abs(-(o.x - shooter.x) * dy + (o.y - shooter.y) * dx);
        if (perp >= SHOT_LANE_PERP_PX) continue;
        if (o.team == shooter.team) return 1;
        found = 2;
    }
    return found;
}
#include "agent.h"
#include "agent_helpers.h"
#include <cmath>
#include <numbers>
#include <cstdio>

// ── Shot-type truth ────────────────────────────────────────────────────────
// TOMBSTONE (Round-31). `headerFinish` and `firstTimeFinish` are parameters, not
// player state. They used to be read off `s.crossCollected` / `s.firstTouchFinish`
// — decaying markers set by the caller one line before the call and cleared again
// at the bottom of this same function. That made `crossCollected` mean TWO things
// at once: "this player just collected a cross" (its name) and "render this shot
// as a HEADER" (its only actual effect). Two readers elsewhere tried to use the
// first meaning — agent_resolve.cpp's fresh-cross volley override and
// scoreShoot()'s freshCross branch — and could never fire, because the flag was
// always already back to 0 by the time an agent ticked. Reviving them while the
// overload stood would have branded a controlled GROUND shot a header: +headedShots,
// shot.header true, and the CF error multiplier (0.46, a ~54% accuracy bonus).
// Both dead readers were deleted in the same commit; see the tombstone at
// agent_shoot_dribble.cpp scoreShoot().
void GameEngine::shootBall(Player& s, const ShotSelectionAudit* selectionAudit,
                           bool headerFinish, bool firstTimeFinish) {
    // Law 11 rebound snapshot: teammates offside NOW may not play the rebound.
    {
        double fdS = fdFor(s.team);
        double lineS = offsideLineFor(s.team);
        for (auto& r : runtime) r.offsideAtShot = false;
        shotTeam = s.team;
        shotSnapshotLive = true;
        for (auto& tm : state.players) {
            if (tm.team != s.team || tm.id == s.id || tm.role == Role::GK) continue;
            bool bh = fdS > 0.0 ? tm.x > HALF_X : tm.x < HALF_X;
            bool bp = fdS > 0.0 ? tm.x > s.x + OFFSIDE_TOLERANCE : tm.x < s.x - OFFSIDE_TOLERANCE;
            bool bl = fdS > 0.0 ? tm.x > lineS + OFFSIDE_TOLERANCE : tm.x < lineS - OFFSIDE_TOLERANCE;
            runtime[tm.id].offsideAtShot = bh && bp && bl;
        }
    }
    emitEvent("shot", s.x, s.y, s.id);
    if (s.id >= 0 && s.id < 22) pStats[s.id].shots++;
    if (goalKickMonitor.active && s.team != goalKickMonitor.team) {
        stats.recordGoalKickTrappedShot();
        goalKickMonitor.active = false;
    }
    stats.recordShot(s.team, false, s.role);
    bool dribble20mShot = carrierTracker.carryTrackerId == s.id && carrierTracker.carryPathDistance >= 200.0;
    if (dribble20mShot) stats.recordDribble20mShot();
    double gx = goalXFor(s.team);
    // Fatigue: a tired finish is less accurate — accuracy scales with the tank.
    // Feeds executionError via (1-accuracy)*SHOT_ERROR_SKILL below, so a tired
    // shooter sprays more. No-op at full stamina.
    double accuracy = attrFactor(s.attrs.shooting) * staminaFrac(s.stamina);
    double goalCenterY = PITCH_H / 2.0;
    double shotDistance = std::hypot(gx - s.x, goalCenterY - s.y);
    double freshCrossMax = agentFor(s)->freshCrossMaxDistance();
    bool freshCross = headerFinish && shotDistance < freshCrossMax;
    if (freshCross) stats.recordHeadedShot();
    stats.recordShotDistance(shotDistance);
    // Penalty-area POLYGON census — the radial bands straddle the box edge, so
    // "goals from outside the box" could never be read off them.
    stats.recordShotInBox(std::abs(s.x - gx) < PENALTY_AREA_W
                          && pitch::lateralFromCenter(s.y) < PENALTY_AREA_H / 2.0);
    int pressureCount = 0;
    pressureCount = countPressure(state.players, s.x, s.y, s.team, PRESSURE_RANGE);
    double angleDeg = goalOpeningAngleDeg(s.x, s.y, gx);
    int laneBlockers = 0;
    double dxGoal = gx - s.x, dyGoal = goalCenterY - s.y, laneLenSq = dxGoal * dxGoal + dyGoal * dyGoal;
    if (laneLenSq > 1.0) {
        for (auto& o : state.players) {
            if (!isActiveOpponent(o, s.team)) continue;
            double along = ((o.x - s.x) * dxGoal + (o.y - s.y) * dyGoal) / laneLenSq;
            if (along <= 0.06 || along >= 0.92) continue;
            double perp = std::hypot(o.x - s.x - along * dxGoal, o.y - s.y - along * dyGoal);
            double bodyWidth = shotDistance > 180.0 ? 38.0 : 30.0;
            if (perp < bodyWidth) laneBlockers++;
        }
    }
    bool outsideGoalLane = std::abs(s.y - goalCenterY) > GOAL_W / 2 + 20;
    bool acuteGeometry = outsideGoalLane && angleDeg < 7.5 && shotDistance > 150;
    const auto* audit = selectionAudit;
    if (audit) {
        bool betterPassFlag = audit->bestPassTargetId >= 0 && audit->bestPassScore > audit->score + 0.12;
        bool tightAngleFlag = audit->angleDeg < 8.0 && audit->distance > 120.0;
        stats.recordShotSelection(audit->angleDeg, audit->pressureCount, 0, 0, 0, 0, 0, 0, betterPassFlag, tightAngleFlag);
    } else {
        bool tightAngleFlag = angleDeg < 8.0 && shotDistance > 120.0;
        stats.recordShotSelection(angleDeg, pressureCount, 0, 0, 0, 0, 0, 0, false, tightAngleFlag);
    }
    // Round-23 (11v11 0:32/33): the flag auto-branded EVERY shot >210px regardless
    // of geometry, which would fight the clean-long-shot fix. A clean look
    // (unpressured, real opening) is a legitimate choice out to ~26m; only a
    // genuinely long strike (>265), a non-clean >210, an acute angle, or a clearly
    // better pass is questionable.
    bool cleanLong = pressureCount == 0 && angleDeg > 9.0;
    if ((shotDistance > 210 && !cleanLong) || shotDistance > 265 || acuteGeometry || (audit && audit->bestPassScore > audit->score + 0.12)) { stats.recordQuestionableShot(); }
    double anglePenalty = clamp(std::abs(s.y - goalCenterY) / 230, 0.0, 1.0);
    double distancePenalty = clamp((shotDistance - 70) / 270, 0.0, 1.0);
    double longRangePenalty = clamp((shotDistance - 120) / 130, 0.0, 1.0);
    double closePressure = shotDistance < 130.0 ? pressureCount * (freshCross ? SHOT_ERROR_CLOSE_PRESSURE_CROSS : SHOT_ERROR_CLOSE_PRESSURE_NORMAL) : 0.0;
    double roleError = agentFor(s)->shotRoleError(freshCross, shotDistance);
    double weakFootShotMul = weakFootStrike(s, goalXFor(s.team) - s.x, PITCH_H / 2.0 - s.y) ? 1.22 : 1.0;
    // ── Round-31 COMMIT 1: the crowd penalty SATURATES ──
    // It used to be linear and uncapped: pressureCount*34 + closePressure*28 +
    // laneBlockers*58 with nothing to stop it, so a six-yard chance with three
    // bodies around it carried ~320px of lateral spread across a 73px goal — a
    // chance the engine was ARITHMETICALLY INCAPABLE of converting. The measured
    // consequences were the whole "box is a lottery" complaint: conversion
    // INVERTED against distance (6-11m 5.4% vs 11-16.5m 18.7%), a third of all
    // goals from outside the box against a real ~15%, and corners that could not
    // score because every corner chance is by construction a crowded one.
    // Traffic must DEGRADE a chance, never erase it. Two changes:
    //   (a) each additional body adds less than the last (exponential
    //       saturation toward SHOT_ERROR_CROWD_SAT) — a fourth defender in a
    //       six-yard scramble does not double the miss;
    //   (b) a FLOOR ON ACHIEVABLE ACCURACY that tightens with range, so the
    //       total spread on a point-blank chance is bounded no matter how
    //       crowded it is. A striker six yards out in traffic still hits the
    //       target most of the time; what he loses is the ability to PICK his
    //       spot, and that is what the keeper roll is for.
    // The cap is monotone increasing in distance and the saturation is monotone
    // increasing in crowd, so "closer + cleaner converts better" still holds
    // everywhere — the relationship is preserved, only its slope is sane.
    double crowdRaw = pressureCount * (freshCross ? SHOT_ERROR_PRESSURE_CROSS : SHOT_ERROR_PRESSURE_NORMAL)
                    + closePressure
                    + laneBlockers * (freshCross ? SHOT_ERROR_LANE_CROSS : SHOT_ERROR_LANE_NORMAL);
    double crowdError = SHOT_ERROR_CROWD_SAT * (1.0 - std::exp(-crowdRaw / SHOT_ERROR_CROWD_SAT));
    double executionError = weakFootShotMul * (SHOT_ERROR_BASE + (1 - accuracy) * SHOT_ERROR_SKILL + crowdError + anglePenalty * SHOT_ERROR_ANGLE + distancePenalty * SHOT_ERROR_DISTANCE + longRangePenalty * SHOT_ERROR_LONG_RANGE);
    executionError = std::max(SHOT_ERROR_FLOOR, executionError + roleError);
    double rangeErrorCap = SHOT_ERROR_CAP_CLOSE
        + clamp((shotDistance - 60.0) / 160.0, 0.0, 1.0) * (SHOT_ERROR_CAP_FAR - SHOT_ERROR_CAP_CLOSE);
    executionError = std::min(executionError, rangeErrorCap);
    // A crowded-but-CLOSE chance is still a real chance. The old gate demanded
    // pressureCount<=2 AND laneBlockers<=1 at every range, which structurally
    // excluded every six-yard-box scramble from being treated as a finish at
    // all — no execution multiplier, no speed bonus, extra loft, wide post aim.
    // Inside ~11.5m a striker is allowed a crowd; the saturating error above is
    // what prices it.
    bool closeRange = shotDistance < 115.0;
    bool credibleFinish = angleDeg > 9.0 && shotDistance < 200.0
                       && (closeRange ? (pressureCount <= 4 && laneBlockers <= 2)
                                      : (pressureCount <= 2 && laneBlockers <= 1));
    bool freshThrough = s.throughCollected > 0.0 && shotDistance < 245.0;
    // A CLEAR-CUT chance: close, clean sight of goal, unpressured — a real
    // striker BURIES these (~35-45%). The post-edge aim + full error spread
    // (a global fix that cut a 4x over-conversion on HALF-chances) strangled
    // these clean chances to ~9-14% conversion too (funnel analysis, seed
    // 101-116). Gated hard — close, no pressure, no blocker, real angle — so it
    // only catches genuine chances; contested/long shots keep the post-edge aim
    // and don't re-inflate on-target. Finished clinically below.
    // Round-31: the second clause. Point-blank with NOBODY IN THE LANE is a big
    // chance in real football even with defenders alongside the shooter — a
    // six-yard tap-in does not stop being a tap-in because a centre-back is
    // goal-side of the near post. The original clause (no pressure at all, out
    // to 14m) is untouched; this only adds the traffic-tolerant point-blank case,
    // and it still requires a genuinely CLEAR shooting lane.
    // (firstTimeFinish is the explicit parameter that replaced the overloaded
    // s.firstTouchFinish flag — same meaning, no longer doubling as a marker.)
    bool clearCutChance = (shotDistance < 140.0 && angleDeg > 11.0
                           && pressureCount == 0 && laneBlockers == 0
                           && (freshThrough || firstTimeFinish || credibleFinish))
                       || (shotDistance < 85.0 && angleDeg > 13.0
                           && laneBlockers == 0 && pressureCount <= 2);
    // First-time foot finish off a low cross: struck clean and FLAT (not a
    // header, so shot.header stays false), with a tight error band — the whole
    // point is to turn a swept low cross into an on-target chance.
    bool firstTouch = firstTimeFinish && shotDistance < 235.0;
    bool directFreeKickShot = setPiece.type == SetPiece::FreeKick;
    // Dead ball, no pressure, twelve yards: penalty execution is near-pure
    // placement. Without this the open-play error model sprayed pens wide.
    bool penaltyKick = setPiece.type == SetPiece::Penalty;
    if (credibleFinish) executionError *= shotDistance < 95.0 ? 0.46 : 0.56;
    if (directFreeKickShot) executionError *= 0.62; // §FK: less clinical than the old 0.48 — the curl-around-wall + open-corner aim were over-converting (goal-inflation); target ~1-in-12-15
    if (penaltyKick) executionError *= 0.30;
    if (freshThrough && angleDeg > 8.0 && pressureCount <= 1) executionError *= shotDistance < 170.0 ? 0.72 : 0.82;
    // 2026-07-02 audit, DEFINITIVE 48-seed paired A/B: headed goals run ~34% of
    // all goals (real 13-24%), but moderating this privilege (CF 0.46→0.56,
    // WM 0.62→0.70) does NOT move the share — 33.7%→39.0%, paired headed delta
    // +0.04±0.38/match — while costing ~0.36 goals/match. The share is
    // CHANCE-MIX-driven (how many box chances arrive as whipped deliveries),
    // not conversion-driven. Don't touch this multiplier to fix header share;
    // fix delivery volume / close-range foot-chance creation instead.
    if (freshCross) executionError *= s.role == Role::CF ? 0.46 : (s.role == Role::WM ? 0.62 : 0.82);
    if (firstTouch) executionError *= shotDistance < 120.0 ? 0.50 : 0.62;
    // ── Shot type — pick HOW to beat the keeper and route to the physics.
    // 0 normal · 1 finesse (placement) · 2 power (pace) · 3 curl (bend round
    // him) · 4 chip (loop over an onrushing keeper). Set pieces, headers and
    // first-touch finishes keep their bespoke models untouched.
    Player* dgk = findGK(s.team == Team::Home ? Team::Away : Team::Home);
    double gkY = dgk ? dgk->y : goalCenterY;
    double gkAdvance = dgk ? std::abs(dgk->x - gx) : 0.0; // how far the keeper has come off his line
    int shotType = 0;
    bool clearSight = pressureCount <= 1 && laneBlockers == 0;
    bool bespoke = penaltyKick || directFreeKickShot || freshCross || firstTouch || acuteGeometry;
    if (!bespoke) {
        bool wideAngle = outsideGoalLane && angleDeg >= 7.0 && angleDeg <= 22.0;
        // Keeper has rushed well off his line and the shooter is behind him with
        // a clear sight: dink it over his head into the empty net.
        // Round-23 (arena reaudit): the old gkAdvance>72 gate branded a
        // FORMULA-DEPTH keeper (engine_gk parks him at clamp(ballGoalDist*0.52,
        // 30,135) => 72+ from ~139px out, and the arena 1v1 smother sits him at a
        // trace-measured 83-89px) as "rushed", so a chip led the priority chain on
        // ~2-in-3 arena possessions — 12-17 bar hits/match. A keeper standing at
        // his positional depth is NOT rushed; require a genuine deep commit
        // (>100px AND past ~45% of the way to the shooter). A fully-committed
        // 150px smother still qualifies (gkAdvance is his real off-line distance
        // regardless of which GK branch drove it).
        bool keeperRushed = gkAdvance > 100.0 && gkAdvance > shotDistance * 0.45
            && shotDistance > gkAdvance + 50.0 && shotDistance < 340.0 && angleDeg > 10.0;
        if (keeperRushed && clearSight)
            shotType = 4; // chip
        else if (credibleFinish && shotDistance < 175.0 && pressureCount <= 1 && accuracy > 0.50)
            shotType = 1; // finesse
        else if (clearSight && shotDistance < 140.0 && angleDeg > 10.0 && accuracy > 0.55)
            shotType = 1; // composed placed shot (owner: "more placed/finesse shots"; first cut at acc>0.45/155px/ang8 tripled finesse volume — goals +0.55, woodwork +0.68 — keep it for genuinely composed looks)
        else if (wideAngle && shotDistance >= 110.0 && shotDistance <= 235.0 && clearSight)
            shotType = 3; // curl
        else if (clearSight && shotDistance >= 120.0 && shotDistance <= 250.0 && accuracy > 0.45)
            shotType = 2; // power
    }
    if (passDebug) fprintf(stderr, "SHOTTYPE t=%d dist=%d ang=%d pr=%d fk=%d lb=%d\n", shotType, (int) shotDistance, (int) angleDeg, pressureCount, directFreeKickShot ? 1 : 0, laneBlockers);
    // Placed shots (finesse/curl) aim for the corner the keeper is NOT shading;
    // the random side stays for instinctive/power strikes (keep the rng draw so
    // the deterministic stream count is unchanged — only the value moves).
    double openSide = (gkY >= goalCenterY ? -1.0 : 1.0);
    double postAimScale = credibleFinish ? 0.92 : 1.0;
    // Aim composed open-play shots NEARER the post (over-conversion fix, audit #1:
    // onTarget ~4x real). The cause wasn't the keeper — the aim sat ~29px inside a
    // 36.5px frame, so the symmetric error spread could only stray wide on the post
    // side while the inner half always found the frame (~97% on-frame for a clean
    // finesse). Aiming to the post EDGE puts the post-ward half of the spread
    // genuinely wide — the only lateral lever that moves on-frame toward the real
    // ~34% (raising the spread alone saturates, since the aim is inside the frame).
    // LATERAL ONLY: loft is untouched, so the old beat-keeper-then-sail-over bug
    // can't revive. Penalty operand kept byte-identical — pens must stay clinical.
    double postFrac = penaltyKick ? 0.36 + accuracy * 0.07 : (0.38 + accuracy * 0.15) * postAimScale;
    if (shotType == 1)
        postFrac = 0.33 + accuracy * 0.05; // finesse: a foot inside the post — every near-edge variant (0.47, 0.44+wide spread, 0.38) kept woodwork 4x real; the aim must genuinely leave the frame zone.
    else if (shotType == 2)
        postFrac = 0.34 + accuracy * 0.07; // power: same inward step
    else if (shotType == 3)
        postFrac = 0.27 + accuracy * 0.05; // curl: small nudge — the bend already carries it out toward the corner
    else if (shotType == 4)
        postFrac = 0.18 + accuracy * 0.06; // chip: net is open with the keeper out — aim safely inside
    double postRoll = (rng.random() < 0.5 ? -1.0 : 1.0);
    double postSide = (shotType || directFreeKickShot) ? openSide : postRoll; // deliberate types + a direct FK aim off the keeper (open corner), not a random post
    double aimedPost = postSide * GOAL_W * postFrac;
    // Composed strikes are struck cleaner than a snatched effort — tighten the
    // spread a little so they keep finding the frame, but not so far that the
    // off-centre aim starts spraying wide (that cost on-target last iteration).
    if (shotType) executionError *= (shotType == 2 ? 0.88 : 0.80);
    // Clear-cut chance: place it into the side the keeper is NOT covering,
    // comfortably inside the frame, with a tight spread — bury it. This is the
    // ONLY place a clean close chance escapes the deliberately-wide post-edge
    // aim; everything else (contested, long, half-chances) is untouched.
    if (clearCutChance) {
        postSide = openSide;
        // Near the post — PAST the keeper's dive from his set position — but
        // with a very tight spread so it finds the side netting instead of
        // straying wide. A central placement just sat in his dive envelope and
        // was saved (saves rose, conversion didn't); the corner + tight error
        // is the actual clinical 1-on-1 finish.
        aimedPost = postSide * GOAL_W * (0.34 + accuracy * 0.06);
        executionError *= 0.42;
    }
    double goalY = goalCenterY + aimedPost + (rng.random() + rng.random() - 1.0) * executionError;
    if (acuteGeometry) {
        double nearPostSide = s.y < goalCenterY ? -1.0 : 1.0;
        double nearPostY = goalCenterY + nearPostSide * GOAL_W / 2;
        goalY = nearPostY - nearPostSide * (BALL_R + 7.0 + rng.random() * 16.0);
    }
    double missMargin = (directFreeKickShot || penaltyKick)
                            ? clamp(5.0 + shotDistance * 0.012 + laneBlockers * 2.0, 7.0, 12.0)
                            : clamp(9.0 + shotDistance * 0.030 + pressureCount * 3.0 + laneBlockers * 3.0, 14.0, 24.0);
    goalY = clamp(goalY, goalCenterY - GOAL_W / 2.0 - missMargin, goalCenterY + GOAL_W / 2.0 + missMargin);
    double dx = gx - s.x, dy = goalY - s.y;
    double d = std::hypot(dx, dy);
    // Headers redirect the cross's pace — box pressure costs them far less
    // power than it costs a wound-up foot shot.
    double speed = SHOT_SPEED_BASE + accuracy * 118.0 - pressureCount * (freshCross ? 10.0 : 24.0) - laneBlockers * (freshCross ? 13.0 : 28.0) - longRangePenalty * 44 + (credibleFinish ? 28.0 : 0.0);
    speed = std::max(185.0, speed);
    if (shotType == 1)
        speed *= 0.94; // finesse: a touch off pace, mostly placement
    else if (shotType == 2)
        speed *= 1.15; // power: blast it past him
    else if (shotType == 3)
        speed *= 0.96; // curl: enough pace to hold the bend
    else if (shotType == 4)
        speed = clamp(shotDistance * 1.25, 205.0, 300.0); // chip: gentle, judged pace
    speed = clamp(speed, 185.0, 455.0);                   // stay inside the keeper-model's anchored band
    auto& b = state.ball;
    b.controllerId = -1;
    placeBallForRelease(s, dx, dy);
    blockReboundFor(s.id, 850);
    b.vx = dx / d * speed;
    b.vy = dy / d * speed;
    // A striker PIVOTS into his shot — leave the stale pre-shot facing and a
    // first-time finish reads as a no-look backheel (watched replay 8:45).
    s.facing = std::atan2(dy, dx);
    // Elevation. A clean chance is struck down and flat; a rushed, long, or
    // poorly-hit one leans back and rises — sometimes onto the bar, sometimes
    // sailing over. Clean credible finishes stay essentially on the deck.
    double loft = 0.0;
    if (!penaltyKick && !directFreeKickShot && !freshCross && !firstTouch) {
        if (!credibleFinish) loft += 26.0;
        loft += pressureCount * 20.0;
        loft += longRangePenalty * 55.0;
        loft += (1.0 - accuracy) * 70.0;
        loft *= 0.5 + rng.random(); // 0.5x..1.5x: some balloon over, some kept down
        // Cap at a DRIVEN miss, not a float: 240 gave apex 5.8m — a rushed long
        // shot hung like a deliberate lob (watched replay seed 133 1:51, vz=199,
        // apex 4.1m onto the bar). 160 -> apex ~2.6m: still clears the bar and
        // balloons over, but on a believable driven trajectory.
        loft = std::min(loft, 160.0);
    }
    // Finesse and power are struck DOWN — under the bar, never floated over the
    // save roll (the conversion gap the save-roll probe exposed). But "down"
    // used to mean vz<=10 = a ground skimmer: the watched-match census found
    // 20/20 goal-line crossings at z<=7 — no shot ever arrived above the
    // keeper's ankles. Give the placed/driven strike its real height band:
    // solve vz so the ball crosses the line between shin and hip (z 2-8).
    // HARD CAP at apex <= GK_STAND_Z (vz <= sqrt(2*G*8) ~ 89): the save roll
    // fires mid-flight (dToGoal < 250), so any z above GK_STAND_Z ANYWHERE on
    // the flight engages the top-corner tax and quietly buys goals — a first
    // cut capped at 118 (apex ~14) doubled per-SoT conversion on shots that
    // were meant to be cosmetically lifted, not harder to save.
    if (shotType == 1 || shotType == 2) {
        double tLine = d / std::max(speed, 1.0);
        double zTarget = 2.0 + rng.random() * (GK_STAND_Z - 2.0);
        loft = std::min(landOnTargetVz(tLine, std::max(tLine, 0.1), zTarget),
                        std::sqrt(2.0 * GRAVITY * GK_STAND_Z));
    }
    // Curl: give it just enough air to keep the spin alive (curl dies fast on
    // the deck) and bend it toward the open corner — a bent flight the keeper,
    // who reads a straight line, mis-sets for (see engine_gk deception term).
    if (shotType == 3) {
        loft = clamp(loft, 45.0, 85.0); // a little air so the spin lives, but down by the line
        double vxSign = (dx >= 0.0 ? 1.0 : -1.0);
        // Footedness: the bend lives on the strong foot — a weak-foot curler
        // barely wraps it, a strong-foot strike bends harder.
        double footCurl = weakFootShotMul > 1.0 ? 0.6 : 1.15;
        b.curl = openSide * vxSign * (0.12 + accuracy * 0.08) * footCurl; // bend enough to round the keeper, not so far it sails the post
    }
    // Chip: loft sized so the parabola loops OVER the advanced keeper yet DIPS
    // genuinely under the bar at the line. The old apexDipVz(t, 1.08) crested a
    // hair past the target and arrived z≈13-20 in vacuum; the launch offset
    // (+~23px, ball released ahead of the striker) and the 6.5px-early goal-plane
    // check pushed the real arrival straight into the 18.5px bar band, so ~half
    // of every chip clanged the crossbar. Solve the loft to LAND at shin height
    // (z≈5) at the line instead — the apex still peaks 3.5-7m up (clears the
    // onrushing keeper by a wide margin) but the ball is descending under the bar
    // when it reaches the frame.
    if (shotType == 4) {
        double tLine = d / std::max(speed, 1.0);
        loft = clamp(landOnTargetVz(tLine, std::max(tLine, 0.1), 5.0), 150.0, 340.0);
    }
    b.intendedReceiverId = -1;
    // A VOLLEY keeps its strike height (seed 111 13:35, owner twice: the
    // first-touch volley snapped z 18.6 -> 0 in one tick — "looked glitchy
    // visually"). The ball leaves the boot where it was met; grounded
    // strikes are unchanged (z was already 0).
    b.z = clamp(b.z, 0.0, HEADER_REACH_Z);
    b.vz = loft;
    // Direct free kick with a wall: CHIP it over, don't blast it through.
    // The old vz=speed*0.50 was tuned for ~470px/s shots; with realistic
    // ~210px/s shot pace the lift only reached ~1m (z=10), BELOW the 20px
    // aerial-clearance height, so the ball flew flat THROUGH the wall. Cap the
    // pace to a chippable speed and loft it so the peak clears the wall
    // (>AERIAL_HEIGHT) yet dips back under the bar by the goal line.
    if (directFreeKickShot && laneBlockers >= 1) {
        // A dead-ball strike is hit CLEAN — pressure/lane penalties that shaped
        // `speed` model open-play duress, not a placed run-up. At the old
        // min(speed,250) the land-at-the-line vz sizing forces elevation past
        // 45° whenever d > v²/250 ≈ 23m, so every long wall-FK launched as a
        // 6m-apex lob (watched replay seed 133 0:22, measured 46.7°/6.2m —
        // "looked like a lob... no power perception"). 300-380 keeps elevation
        // under ~30° across the direct-FK range and the whip look real.
        double fkSpeed = clamp(speed * 1.35, 300.0, 380.0);
        driveBall(b, dx, dy, d, fkSpeed);
        double vxSign = (dx >= 0.0 ? 1.0 : -1.0);
        // §FK variety (Commit 2): ~30% a FLOATED DIPPER — lobbed higher over the wall (parabola peaks
        // well clear, distance-sized loft so it dips under the bar by the line) with LESS curl; else the
        // §FK curl-around-the-wall default (Commit 1, Beckham): the chip lofts it (z>2 so the spin
        // SUSTAINS, curl decays slow airborne per engine_physics:57) and bends it toward the open corner.
        // Choice via a deterministic shooter+clock HASH (NOT a main-rng draw) so it doesn't shift the
        // match's rng sequence -> a CLEAN paired comparison vs the curl-only baseline + replay-stable.
        bool fkDipper = ((static_cast<uint32_t>(s.id) * 48271u + static_cast<uint32_t>(state.clockMs)) % 100u < 18u) && shotDistance < 235.0; // ~18% (a special occasional shot, not a third of FKs — the floated dipper over-converts vs the curler, +0.29 at 30%; keep it a small variety)
        b.z = 2.5;   // above the z>2 airborne gate: launch-tick curl decays at the air rate, not the harsh grounded one
        if (fkDipper) {
            b.vz = clamp(apexDipVz(d / std::max(fkSpeed, 1.0), 1.05), 170.0, 330.0);
            b.curl = openSide * vxSign * (0.10 + accuracy * 0.07);
        } else {
            // Distance-SIZED loft (was a flat fkSpeed*0.72, distance-blind):
            // the flat lift peaked ~3m at any range, so a 20m+ curler came
            // back to ground ~5-6m SHORT and plopped softly into the keeper's
            // 6-yard box (watched replay 1:00 "missed tap-in" — the FK that
            // died short) — directly against this code's own intent ("dips
            // under the bar BY THE GOAL LINE"). Size vz so the parabola lands
            // at the line (0.5·g·d/fkSpeed) with a lower peak than the dipper
            // (×1.0 vs ×1.05) so it arrives flat-ish and the curl still lives;
            // floor 150 keeps the peak above the 20px wall-clearance height.
            b.vz = clamp(apexDipVz(d / std::max(fkSpeed, 1.0), 1.0), 150.0, 330.0);
            b.curl = openSide * vxSign * (0.20 + accuracy * 0.15);
        }
    }
    b.lastTouchTeam = s.team;
    b.lastToucherId = s.id; lastRicochetMs = -1e9;   // genuine touch supersedes ricochet restart memory
    metrics.shotLaunchSpeedTotal += speed;
    metrics.shotLaunchCount++;
    stats.recordShotLaunch(speed);
    recordBallImpulse();
    pendingPass.active = false;
    lastLooseOrigin = LooseOrigin::Shot;
    pendingSave.active = false; // a fresh shot supersedes any in-flight save
    receiverShieldTargetId = -1;
    shot.active = true;
    shot.tracked = true;
    shot.preventable = false;
    shot.header = freshCross;
    shot.dribble20m = dribble20mShot;
    shot.team = s.team;
    shot.shooterId = s.id;
    shot.originX = s.x;
    shot.originY = s.y;
    shot.freshFinish = firstTouch || freshCross || freshThrough || clearCutChance; // snap finish — wrong-foots the keeper (engine_gk reaction); a clean 1-on-1 is placed before he can set
    shot.type = shotType;                                        // carried to the save roll for the per-type probe (debug only)
    // ── Explicit shot-block roll: each defender in the lane gets ONE
    // deliberate, skill-based chance (squareness in lane x reaction time x
    // tackling). The winner is the only body allowed to touch the flight;
    // a shot that survives every roll is committed past the crowd.
    shot.blockerId = -1;
    // A penalty beaten by the dive shouldn't be casually scooped on the line.
    shot.scoopAllowed = rng.random() < (penaltyKick ? PENALTY_SCOOP_CHANCE : SHOT_SCOOP_CHANCE);
    if (!penaltyKick) {
        double ndx = dx / d, ndy = dy / d;
        for (auto& o : state.players) {
            if (!isActiveOpponent(o, s.team)) continue;
            double ox = o.x - s.x, oy = o.y - s.y;
            double along = ox * ndx + oy * ndy;
            if (along < 14.0 || along > d * 0.94) continue;
            double perp = std::abs(ox * ndy - oy * ndx);
            double reachR = PLAYER_R + BALL_R + 11.0; // throw a body/leg across the lane
            if (perp > reachR) continue;
            double inLine = 1.0 - perp / reachR;
            double reactFactor = clamp(along / 90.0, 0.25, 1.0);
            double chance = clamp((0.21 + attrFactor(o.attrs.tackling) * 0.36) * inLine * reactFactor, 0.03, 0.62);
            if (rng.random() < chance) {
                shot.blockerId = o.id;
                break;
            }
        }
    }
    // Consume the through-ball marker now the shot has used it: it otherwise decays
    // over 1400ms, so a SAME-player rebound shot inside that window would wrongly
    // re-apply the through-ball error reduction. (The header / first-time markers
    // used to be cleared here too; they are parameters now — a rebound shot simply
    // isn't called with them.)
    s.throughCollected = 0.0;
}

bool GameEngine::knockBallAhead(Player& carrier, double targetX, double targetY) {
    auto& b = state.ball;
    if (b.controllerId != carrier.id || !canKnockBallAhead(carrier.id)) return false;
    double dx = targetX - carrier.x, dy = targetY - carrier.y, directionDist = std::hypot(dx, dy);
    if (directionDist < 1) return false;
    int nearestId = -1;
    double nearestDist = 1e9;
    for (auto& opponent : state.players) {
        if (!isActiveOpponent(opponent, carrier.team)) continue;
        double d = dist(opponent.x, opponent.y, carrier.x, carrier.y);
        if (d < nearestDist) {
            nearestDist = d;
            nearestId = opponent.id;
        }
    }
    bool risky = nearestId >= 0 && nearestDist < 125;
    double nx = dx / directionDist, ny = dy / directionDist;
    double launchSpeed = attrFactor(carrier.attrs.speed) * DRIBBLE_FAST_SPEED + DRIBBLE_KNOCK_SPEED_ADVANTAGE;
    b.controllerId = -1;
    b.intendedReceiverId = -1;
    receiverShieldUntil = 0;
    receiverShieldedPlayerId = -1;
    receiverShieldTargetId = -1;
    placeBallForRelease(carrier, dx, dy, DRIBBLE_KNOCK_OFFSET);
    b.vx = nx * launchSpeed;
    b.vy = ny * launchSpeed;
    b.z = b.vz = 0;
    b.lastTouchTeam = carrier.team;
    b.lastToucherId = carrier.id; lastRicochetMs = -1e9;   // genuine touch supersedes ricochet restart memory
    lastLooseOrigin = LooseOrigin::KnockAhead;
    recordBallImpulse();
    stats.recordKnockAhead(launchSpeed);
    if (risky) { stats.recordRiskyKnockAhead(); }
    runtime[carrier.id].duel.contestBlockedUntil = 0;
    activeKnockAhead = {true, carrier.id, carrier.team, state.clockMs, nearestId, nearestDist, risky};
    return true;
}

void GameEngine::resolveKnockAhead(Player* collector, const std::string& stopped) {
    if (!activeKnockAhead.active) return;
    if (stopped == "out_of_play") {
        stats.recordKnockAheadOutOfPlay();
    } else if (stopped == "goal") {
    } else if (collector && collector->id == activeKnockAhead.playerId) {
        stats.recordKnockAheadRecovered();
        runtime[collector->id].knockAheadCooldownUntil = state.clockMs + 1400;
    } else if (collector && collector->team == activeKnockAhead.team) {
        stats.recordKnockAheadRetained();
    } else {
        stats.recordKnockAheadTurnover(activeKnockAhead.risky);
        // Round-26 (observability, trace-only): the knock-ahead turnover also
        // resolves possession silently. Mark it for the same future audit as the
        // body-block steal. traceOnly => no gameplay/RNG/golden-hash effect.
        if (collector) emitEvent("steal", collector->x, collector->y, collector->id, activeKnockAhead.playerId, /*traceOnly=*/true);
    }
    activeKnockAhead.active = false;
}
