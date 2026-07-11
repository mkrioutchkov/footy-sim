#include "engine.h"
#include "agent.h"

Action PlayerAI::scoreShot(const Perception& per, const GameContext& ctx) {
    const auto& p = player;
    bool shootOnSight = engine.directiveBias[p.id].shootOnSight;   // directive: shoot from range
    double gx = goalXFor(p.team);
    double shotDistance = pitch::distToGoalMouth(p.x, p.y, p.team);
    double angleDeg = engine.goalOpeningAngleDeg(p.x, p.y, gx);

    ActionAudit audit;
    audit.distance = shotDistance;
    audit.angleDeg = angleDeg;
    audit.pressureCount = per.pressureCount;
    CarrierPressure cp = assessCarrierPressure(engine, p);
    double freshCrossMax = freshCrossMaxDistance();
    bool freshCross = p.crossCollected > 0.0 && shotDistance < freshCrossMax;
    bool freshThrough = p.throughCollected > 0.0 && shotDistance < 245.0;

    // Fresh windfall (possession won off the opponent <2s ago) in range: the
    // long pot shot is ON — the defence is unset, exactly when real players
    // let fly (owner, seed 111 1:13).
    bool windfall = engine.state.clockMs - engine.lastTurnoverWinMs[p.id] < 2000.0
        && engine.lastTurnoverWinMs[p.id] > 0.0 && shotDistance < 345.0;
    bool outsideGoalLane = pitch::lateralFromCenter(p.y) > GOAL_W / 2.0 - BALL_R + 20.0;
    bool acuteGeometry = outsideGoalLane && angleDeg < SHOT_ANGLE_ACUTE_THRESH && shotDistance > 150.0;

    if (!freshCross && !freshThrough && angleDeg < SHOT_ACUTE_SOFT_THRESH && shotDistance > 120.0)
        return Action{ActionType::Shoot, -1.0, nullptr, 0, 0, ActionPurpose::Keep, audit};

    if ((!freshCross && shotDistance > (shootOnSight ? 360.0 : windfall ? 345.0 : 310.0)) || (freshCross && shotDistance > freshCrossMax) || (!freshCross && !shootOnSight && !windfall && acuteGeometry))
        return Action{ActionType::Shoot, -1.0, nullptr, 0, 0, ActionPurpose::Keep, audit};

    if (!freshCross && !freshThrough && shotDistance > 285.0 && angleDeg < SHOT_ACUTE_HARD_THRESH)
        return Action{ActionType::Shoot, -1.0, nullptr, 0, 0, ActionPurpose::Keep, audit};

    double hardMax = shotMaxDistance() + engine.teamTactics[teamIndex(p.team)].shootDistBias;   // shoot_from_distance extends the HARD cap too (line-36 gate); 0 = default
    if (freshCross) hardMax = std::max(hardMax, freshCrossMax);
    if (shootOnSight) hardMax = std::max(hardMax, 330.0);
    if (windfall) hardMax = std::max(hardMax, 345.0);
    if (shotDistance > hardMax)
        return Action{ActionType::Shoot, -1.0, nullptr, 0, 0, ActionPurpose::Keep, audit};
    if (!shootOnSight && isCentralMidfielder() && shotDistance > 225.0 && (angleDeg < 9.0 || per.pressureCount > 1))
        return Action{ActionType::Shoot, -1.0, nullptr, 0, 0, ActionPurpose::Keep, audit};
    if (!shootOnSight && isWideMidfielder() && pitch::lateralFromCenter(p.y) > 180.0 && shotDistance > 155.0)
        return Action{ActionType::Shoot, -1.0, nullptr, 0, 0, ActionPurpose::Keep, audit};

    double maxShootRange = SHOOT_MIN_DIST + attrFactor(p.attrs.shooting) * (SHOOT_MAX_DIST - SHOOT_MIN_DIST);
    maxShootRange += engine.teamTactics[teamIndex(p.team)].shootDistBias;   // shoot_from_distance (+) / work_it_into_box (-); 0 = default
    // Clear sight of goal extends range: unpressured with a real opening,
    // a strike from just outside the usual band beats recycling sideways.
    double clearSightBoost = (per.pressureCount == 0 && angleDeg > 9.0) ? 24.0 : 0.0;
    if (shootOnSight) clearSightBoost += 60.0;
    if (shotDistance > std::min(maxShootRange + 18.0 + clearSightBoost, hardMax + 12.0 + clearSightBoost))
        return Action{ActionType::Shoot, -1.0, nullptr, 0, 0, ActionPurpose::Keep, audit};

    double toGoalX = gx - p.x;
    double toGoalY = PITCH_H / 2.0 - p.y;
    double toGoalDist = std::hypot(toGoalX, toGoalY);
    if (toGoalDist < 1.0) toGoalDist = 1.0;
    double facingDot = (std::cos(p.facing) * toGoalX + std::sin(p.facing) * toGoalY) / toGoalDist;
    if (!freshCross && !freshThrough && facingDot < 0.05 && shotDistance > 70.0) return Action{ActionType::Shoot, -1.0, nullptr, 0, 0, ActionPurpose::Keep, audit};
    // F6 (facing audit): a fresh cross/through finish skips the veto above (a volley/header
    // can legitimately be side-on), but still refuse a TRUE back-to-goal shot (>120 deg off
    // the goal) — that looked broken. Rear tolerance for glancing headers is preserved.
    if ((freshCross || freshThrough) && facingDot < -0.5 && shotDistance > 70.0) return Action{ActionType::Shoot, -1.0, nullptr, 0, 0, ActionPurpose::Keep, audit};
    // OUTSIDE the box the side-on tolerance shrinks: a first-time finish from
    // 20m while barely facing the goal read as a no-look backheel bomb
    // (watched replay 8:45: scorer collected and struck in 200ms, body still
    // square to the arriving pass). Box-range volleys and flicks keep the
    // wide tolerance above.
    if ((freshCross || freshThrough) && facingDot < 0.15 && shotDistance > 150.0) return Action{ActionType::Shoot, -1.0, nullptr, 0, 0, ActionPurpose::Keep, audit};
    if (!freshCross && !freshThrough && facingDot < 0.35 && shotDistance > 135.0)
        return Action{ActionType::Shoot, -1.0, nullptr, 0, 0, ActionPurpose::Keep, audit};
    if (!freshCross && cp.score > 1.15 && cp.exposed > 0.45 && shotDistance > 105.0)
        return Action{ActionType::Shoot, -1.0, nullptr, 0, 0, ActionPurpose::Keep, audit};
    // Over-conversion residual (BORIS_OVERCONVERSION §NEW residual): a long-range
    // shot with defenders closing is low-quality — the keeper reads it, so it pads
    // on-frame/saves, not goals. Recycle and keep possession instead. A clear sight
    // (no crowd), a shoot-on-sight directive, or a fresh cross/through finish still shoot.
    if (!freshCross && !freshThrough && !shootOnSight && shotDistance > 195.0 && per.pressureCount >= 2)
        return Action{ActionType::Shoot, -1.0, nullptr, 0, 0, ActionPurpose::Keep, audit};

    double sc = attrFactor(p.attrs.shooting) * (1.0 - shotDistance / maxShootRange) * 0.55;
    if (shotDistance < 140.0 && per.pressureCount == 0 && angleDeg > 10.0) sc = std::max(sc, 0.38);
    if (shotDistance < 120.0 && per.pressureCount == 0) sc = std::max(sc, 0.30);
    if (shotDistance < 90.0 && per.pressureCount == 0)  sc = std::max(sc, 0.45);
    if (shotDistance < 50.0 && per.pressureCount <= 1)  sc = std::max(sc, 0.50);
    if (shotDistance < 30.0 && per.pressureCount <= 1)  sc = std::max(sc, 0.68);

    Player* gk = nullptr;
    for (auto& o : engine.state.players) {
        if (o.team != p.team && o.role == Role::GK) { gk = &o; break; }
    }
    if (gk) {
        // Judge the KEEPER'S coverage of this shot, not raw y-difference: his
        // perpendicular offset from the shot line (shooter -> goal centre) at
        // his own depth, normalised by the shot cone's half-width there.
        // openness 0 = plumb on the line, 1 = a post effectively open (watched
        // replay 0:50: keeper planted at goal centre against a wide-angle
        // carrier — the old |p.y - gk.y| test barely noticed; this sees the
        // gaping near post).
        double span = std::abs(gx - p.x);
        if (span > 8.0) {
            double frac = clamp((gk->x - p.x) / (gx - p.x), 0.0, 1.0);
            double yLine = p.y + frac * (PITCH_H / 2.0 - p.y);
            double hw = GOAL_W / 2.0 * frac;
            double openness = clamp((std::abs(gk->y - yLine) - 6.0) / std::max(hw, 10.0), 0.0, 1.2);
            sc += openness * 0.16;
            if (openness < 0.12 && shotDistance > 120.0) sc -= 0.08; // set keeper, long shot: the old damper
        }
        if (std::abs(gk->x - gx) > 50.0) sc += 0.08; // well off his line: chip/beat him
    }

    if (shotDistance < 100.0) sc += 0.14;
    if (shotDistance < 60.0)  sc += 0.12;
    sc += shotScoreBonus();
    if (shootOnSight) sc += 0.55;   // directive: bias toward pulling the trigger
    sc += shotDistancePenalty(shotDistance);
    if (pitch::lateralFromCenter(p.y) < 140.0) sc += centralShootBonus();
    if (pitch::lateralFromCenter(p.y) > 100.0) sc -= wideShootPenalty();
    sc -= std::min(0.42, per.pressureCount * 0.16);
    sc -= clamp(cp.score - 0.55, 0.0, 0.75) * 0.18;
    if (cp.exposed > 0.45 && shotDistance > 85.0) sc -= 0.12;

    bool credibleOpening = angleDeg >= 7.5 || shotDistance < 115.0;
    // The big shoot reward is for genuine box/edge chances, NOT 20-yard pot-shots:
    // close shots convert ~40%, long ones ~4%, so working it closer must win.
    if (shotDistance < 150.0 && credibleOpening) sc += per.pressureCount == 0 ? 0.38 : 0.16;
    if (shotDistance < 135.0 && credibleOpening) sc += per.pressureCount == 0 ? 0.46 : 0.16;
    if (shotDistance < 70.0  && credibleOpening) sc += per.pressureCount <= 1 ? 0.22 : 0.05;
    if (shotDistance < 40.0)  sc += per.pressureCount <= 1 ? 0.18 : 0.04;
    bool longCarryShotZone = engine.carrierTracker.carryTrackerId == p.id && engine.carrierTracker.carryPathDistance >= 200.0
        && shotDistance < 255.0 && angleDeg > 8.0;
    if (longCarryShotZone && per.pressureCount <= 1) sc += 0.18;
    else if (longCarryShotZone) sc += 0.08;

    if (freshCross) sc += freshCrossShotBonus();
    if (freshThrough) {
        // Distance-shaped (was flat +0.22 unpressured): an UNPRESSURED collector
        // still 18m+ out should carry his 1v1 in (the breakaway drive in
        // scoreDribble), not snap-shoot — the early bonus only pays close-in.
        // A pressured collector (recovering CB on his back) still shoots early.
        sc += per.pressureCount == 0 ? (shotDistance < 180.0 ? 0.22 : 0.02) : 0.10;
        if (shotDistance < 170.0 && angleDeg > 8.0) sc += 0.16;
    }
    if (shotDistance < 160.0 && angleDeg > 6.5) sc += per.pressureCount <= 1 ? 0.24 : 0.10;
    if (shotDistance < 165.0 && angleDeg > 6.0) sc += closeRangeShootBonus();
    if (per.pressureCount == 0 && angleDeg > 9.0 && shotDistance < 200.0) sc += 0.10;
    // Pot-shot tax: the audit flagged ~70 questionable long strikes per match —
    // keepers eat them, so working a better position should win the comparison.
    // The 200-235px band was over-rewarded to chase a goals target; from outside
    // the box (>=200px) working it closer should beat the speculative strike.
    // Long-range pot-shot tax — but SOFTENED in stoppage time so a trailing side
    // has a go (drama), with a desperation premium for a clean look. Execution
    // error (SHOT_ERROR_LONG_RANGE) is unchanged, so most still fly wide — this
    // only shifts WHEN strikers try them, concentrating screamers into the nervy
    // closing minutes rather than inflating the baseline goal rate.
    bool lateGame = engine.phase.addedTimeActive && engine.phase.half == 2;   // end-of-match urgency is 2nd-half stoppage only (H1 added time is not "closing minutes")
    // The tax stays full for hopeful hits, but a CLEAN LOOK — unpressured,
    // real opening, inside screamer range — is a legitimate strike choice, not
    // a pot-shot (user: "would like to see more long range shots attempted";
    // the flat -0.34 priced Xavi-from-22-yards identically to a crowded hoof).
    double potShotTax = lateGame ? 0.18 : 0.34;
    bool cleanLongLook = per.pressureCount == 0 && angleDeg > 8.0 && shotDistance < 260.0
                      && pitch::lateralFromCenter(p.y) < 160.0;
    if (cleanLongLook) potShotTax *= 0.35;
    if (shotDistance > 175.0) sc -= potShotTax;
    if (shotDistance > 175.0 && cleanLongLook) sc += 0.10;
    if (lateGame && shotDistance > 175.0 && shotDistance < 250.0 && per.pressureCount == 0 && angleDeg > 8.0)
        sc += 0.24;

    return Action{ActionType::Shoot, clamp(sc, 0.0, 1.0), nullptr, 0, 0, ActionPurpose::Keep, audit};
}

// ══════════════════════════════════════════════════════════════════════════════
// cd() — can-dribble
// ══════════════════════════════════════════════════════════════════════════════
Action PlayerAI::scoreDribble(const Perception& per, const GameContext& /*ctx*/) {
    const auto& p = player;
    double gx = goalXFor(p.team);
    double fd = fdFor(p.team);
    double tx = gx, ty = p.y;
    CarrierPressure cp = assessCarrierPressure(engine, p);

    // Evade nearest opponent if close
    if (per.nearestOpponentDist < DRIBBLE_EVADE_DIST && !per.nearbyOpponents.empty()) {
        Player* n = nullptr;
        double nd = 1e9;
        for (auto* o : per.nearbyOpponents) {
            double d = dist(p.x, p.y, o->x, o->y);
            if (d < nd) { nd = d; n = o; }
        }
        if (n) {
            double ax = p.x - n->x, ay = p.y - n->y;
            double ad = std::sqrt(ax * ax + ay * ay);
            if (ad > 1.0) {
                double ex = ax / ad;
                double ey = ay / ad;
                if (ex * fd < -0.25) {
                    // Commit to an escape side for a beat — re-picking each tick
                    // flipped the dribble target side-to-side and spun the carrier.
                    if (engine.state.clockMs > evadeSideUntilMs) {
                        evadeSide = ey >= 0.0 ? 1.0 : -1.0;
                        evadeSideUntilMs = engine.state.clockMs + 750.0;
                    }
                    tx = p.x + fd * 24.0;
                    ty = p.y + evadeSide * 72.0;
                } else {
                    tx = p.x + ex * 70.0;
                    ty = p.y + ey * 70.0;
                }
            }
        }
    }

    // Keep away from pitch edges
    if (p.y < DRIBBLE_EDGE_MARGIN)           ty = std::max(ty, p.y + 40.0);
    if (p.y > PITCH_H - DRIBBLE_EDGE_MARGIN) ty = std::min(ty, p.y - 40.0);
    if (p.x < DRIBBLE_EDGE_MARGIN)           tx = std::max(tx, p.x + 40.0);
    if (p.x > PITCH_W - DRIBBLE_EDGE_MARGIN) tx = std::min(tx, p.x - 40.0);

    // Target selection: prefer space over goal
    double distToGoal = std::abs(p.x - gx);
    bool inOwnHalf = (fd > 0 && p.x < HALF_X) || (fd < 0 && p.x > HALF_X);
    bool finalThird = (fd > 0 && p.x > PITCH_W * 2.0 / 3.0) || (fd < 0 && p.x < PITCH_W / 3.0);
    bool nearGoal = distToGoal < 200.0;
    bool activeLongCarry = engine.carrierTracker.carryTrackerId == p.id && engine.carrierTracker.carryPathDistance >= 90.0;
    bool carryNeedsShotWindow = engine.carrierTracker.carryTrackerId == p.id && engine.carrierTracker.carryPathDistance >= 125.0 && distToGoal > 90.0;
    bool freshThrough = p.throughCollected > 0.0;

    // Find open space: check density around potential targets
    auto densityAt = [&](double cx, double cy) {
        int count = 0;
        for (auto& o : engine.state.players) {
            if (o.team == p.team || o.role == Role::GK) continue;
            if (dist(cx, cy, o.x, o.y) < DRIBBLE_DENSITY_RADIUS) count++;
        }
        return count;
    };

    // Consider flank targets for CM/FB
    if (canUseFlankTargets()) {
        double topFlank = std::max(80.0, p.y - 100.0);
        double botFlank = std::min(PITCH_H - 80.0, p.y + 100.0);
        double topDensity = densityAt(p.x + fd * 60.0, topFlank);
        double botDensity = densityAt(p.x + fd * 60.0, botFlank);
        double centerDensity = densityAt(p.x + fd * 60.0, p.y);

        // Pick the least congested direction
        if (topDensity < centerDensity && topDensity < botDensity) {
            ty = topFlank;
            tx = p.x + fd * 80.0;
        } else if (botDensity < centerDensity) {
            ty = botFlank;
            tx = p.x + fd * 80.0;
        } else {
            tx = p.x + fd * 80.0;
        }
    }

    // Blend toward goal only when close. §C byline-carry: a WIDE attacker (WM/FB) in the final
    // third, genuinely wide + with space + NOT a clean cut-in-to-shoot look, steers to the BYLINE
    // (deep, staying wide) instead of cutting inside to goal-center — so max(offsideLine, b.x)=b.x
    // goes deep and the near-post runner is legally onside-CLOSE, enabling the onside 6-yard cutback
    // (the realistic close-chance route). Central / build-up carriers fail the wide+final-third gate;
    // the cut-inside-to-SHOOT lane survives via !nearGoal.
    // cut_inside: a wide carrier in the final third drives toward goal-center (onto his stronger foot)
    // INSTEAD of the byline — the inverted-winger shot threat. Gated on the directive (0 => unchanged).
    bool cutInside = engine.directiveBias[p.id].cutInsideBias > 0.0
        && isWidePlayer() && finalThird && distToGoal < 360.0
        && pitch::lateralFromCenter(p.y) > 90.0
        && !nearGoal;
    bool bylineSeek = !cutInside && isWidePlayer() && finalThird && distToGoal < 340.0
        && pitch::lateralFromCenter(p.y) > 120.0
        && per.nearestOpponentDist > 55.0
        && !nearGoal;
    if (bylineSeek) {
        tx = clamp(gx - fd * 40.0, 35.0, PITCH_W - 35.0);                          // byline depth, stay wide
        ty = clamp(p.y + (p.y < PITCH_H / 2.0 ? -10.0 : 10.0), 70.0, PITCH_H - 70.0);
    } else if (cutInside) {
        tx = lerp(tx, gx, 0.50);                                                   // drive toward goal
        ty = clamp(lerp(p.y, PITCH_H / 2.0, 0.42), 70.0, PITCH_H - 70.0);          // cut inside toward center
    } else if (nearGoal) {
        tx = lerp(tx, gx, 0.55);
    } else {
        tx = lerp(tx, gx, 0.20);
    }

    // ── Breakaway drive ── A through-ball collector who is genuinely IN BEHIND
    // (no outfield defender goal-side in his corridor) drives at the keeper
    // before finishing — real 1v1s are finished from 8-12m, not 20m. Without
    // this, the freshThrough shot bonus fired from wherever the ball was
    // collected (~180-250px), which is why 27 completed through balls/match
    // produced almost no close-range chances (shot mix: close 2% vs real ~20%).
    bool breakawayDrive = false;
    if (freshThrough && distToGoal > 120.0 && distToGoal < 310.0) {
        // A defender only kills the 1v1 if he can actually make the drive lane:
        // goal-side AND within ~60px lateral of the carrier-to-goal line. The
        // first version counted anyone goal-side within 120y — with a retreating
        // line that is ALWAYS someone, so the drive never fired (measured 0).
        int defendersAhead = 0;
        double lx = gx - p.x, ly = PITCH_H / 2.0 - p.y, ll = std::hypot(lx, ly);
        for (auto& o : engine.state.players) {
            if (!isActiveOpponent(o, p.team)) continue;
            if ((o.x - p.x) * fd <= -10.0) continue;               // chasing from behind
            double t = ll > 1.0 ? clamp(((o.x - p.x) * lx + (o.y - p.y) * ly) / (ll * ll), 0.0, 1.0) : 0.0;
            double lane = dist(o.x, o.y, p.x + lx * t, p.y + ly * t);
            if (lane < 60.0) defendersAhead++;
        }
        if (defendersAhead == 0) {
            breakawayDrive = true;
            tx = clamp(gx - fd * 90.0, 35.0, PITCH_W - 35.0);   // drive to ~9m out
            ty = clamp(lerp(p.y, PITCH_H / 2.0, 0.35), 70.0, PITCH_H - 70.0);
        }
    }

    // Scoring
    double sc = 0.35;
    if (bylineSeek) sc += 0.18;   // §C reward the byline carry so it wins vs an early cross / cut-inside
    if (cutInside)  sc += 0.20;   // cut_inside: reward the inside drive so it wins vs the byline (mirror)
    if (breakawayDrive) sc += 0.30;   // the 1v1 carry must beat the 20m snapshot
    double backwardTarget = (tx - p.x) * fd;
    if (backwardTarget < -45.0) {
        sc -= 0.34;
        tx = p.x - fd * 32.0;
    }
    if (engine.carrierTracker.backwardCarryCarrierId == p.id) {
        double possessionBackward = (p.x - engine.carrierTracker.backwardCarryStartX) * fd;
        bool touchlineCarry = p.y < 85.0 || p.y > PITCH_H - 85.0;
        if (possessionBackward < -70.0 && backwardTarget < 0.0) {
            double side = p.y < PITCH_H / 2.0 ? 1.0 : -1.0;
            tx = p.x + fd * (touchlineCarry ? 70.0 : 48.0);
            ty = clamp(p.y + side * (touchlineCarry ? 64.0 : 42.0), 35.0, PITCH_H - 35.0);
            sc -= possessionBackward < -140.0 ? 0.42 : 0.24;
        }
    }

    // Space bonus: more space = more dribble
    if (per.nearestOpponentDist > DRIBBLE_SPACE_BONUS_DIST) sc += 0.15;
    else if (per.nearestOpponentDist > 60.0) sc += 0.05;
    else if (per.nearestOpponentDist < DRIBBLE_TIGHT_DIST) sc -= 0.20;
    if (cp.score > 0.70) sc -= 0.16;
    if (cp.score > 1.05) sc -= 0.18;
    if (cp.exposed > 0.35 && per.nearestOpponentDist < 42.0) sc -= 0.12;

    // Traffic penalty: crowded area = don't dribble
    int oppsInPath = 0;
    for (auto& o : engine.state.players) {
        if (o.team == p.team || o.role == Role::GK) continue;
        double d = dist(p.x, p.y, o.x, o.y);
        if (d < DRIBBLE_DENSITY_RADIUS) oppsInPath++;
    }
    if (oppsInPath >= 3) sc -= 0.20;
    if (oppsInPath >= 5) sc -= 0.30;

    // Field position: prefer passing in own half
    bool ballPlaying = engine.directiveBias[p.id].ballPlaying;   // ball-playing CB: carry out of the back
    if (inOwnHalf) sc -= 0.10;
    if (inOwnHalf && !ballPlaying) sc += dribbleOwnHalfExtraPenalty(); // CM/CB/FB: extra penalty in own half (a ball-playing CB is exempt)

    // Near goal bonus
    if (nearGoal) sc += 0.20;
    if (freshThrough && distToGoal < 270.0 && per.nearestOpponentDist > 38.0) {
        sc += 0.18;
        tx = clamp(p.x + fd * 95.0, 35.0, PITCH_W - 35.0);
        ty = lerp(p.y, PITCH_H / 2.0, 0.28);
    }

    // Stuck detection
    double m = std::sqrt((p.x - lastPosX) * (p.x - lastPosX) + (p.y - lastPosY) * (p.y - lastPosY));
    if (holdTicks > DRIBBLE_STUCK_HOLD_TICKS && m < 3.0)  sc -= 0.20;
    if (holdTicks > DRIBBLE_STUCK_SEVERE)                 sc -= 0.30;

    // Open space ahead bonus: check if target area is clear
    int densityAtTarget = densityAt(tx, ty);
    if (densityAtTarget == 0) sc += 0.15;
    else if (densityAtTarget == 1) sc += 0.05;
    else if (densityAtTarget >= 3) sc -= 0.10;

    double aheadX = clamp(p.x + fd * 130.0, 35.0, PITCH_W - 35.0);
    int densityAhead = densityAt(aheadX, p.y);
    // Open-lane carry. A ball-playing CB (directive) is granted the lane even though
    // his role can't use it by default, with a real forward bonus/distance (the CB
    // profile's are 0), so a stepped-out centre-back drives into the space ahead.
    if ((canUseOpenLane() || ballPlaying) && !finalThird && per.nearestOpponentDist > 78.0) {
        double laneY = p.y;
        double topDensity = densityAt(p.x + fd * 145.0, clamp(p.y - 75.0, 45.0, PITCH_H - 45.0));
        double midDensity = densityAt(p.x + fd * 145.0, p.y);
        double botDensity = densityAt(p.x + fd * 145.0, clamp(p.y + 75.0, 45.0, PITCH_H - 45.0));
        if (topDensity < midDensity && topDensity <= botDensity) laneY = clamp(p.y - 75.0, 45.0, PITCH_H - 45.0);
        else if (botDensity < midDensity) laneY = clamp(p.y + 75.0, 45.0, PITCH_H - 45.0);
        int laneDensity = std::min({ topDensity, midDensity, botDensity });
        if (laneDensity <= 1) {
            double laneBonus = openLaneDribbleBonus();
            double laneDist  = openLaneDribbleDistance();
            if (ballPlaying) { if (laneBonus < 0.16) laneBonus = 0.16; if (laneDist < 150.0) laneDist = 150.0; }
            sc += laneBonus;
            tx = clamp(p.x + fd * laneDist, 35.0, PITCH_W - 35.0);
            ty = laneY;
        }
    }
    if (finalThird && per.nearestOpponentDist > 70.0 && densityAhead <= 1) {
        sc += 0.28;
        // (cross_early no longer penalises this carry — the benchmark showed
        // suppressing it stops the player reaching a crossing position, so crosses
        // DROP. cross_early now lives purely in the cross-score bonus + an earlier
        // cross window in agent_pass_helpers.)
        tx = p.x + fd * (activeLongCarry ? 190.0 : 165.0);
        ty = lerp(p.y, PITCH_H / 2.0, 0.18);
    } else if (!inOwnHalf && per.nearestOpponentDist > 115.0 && densityAhead <= 1) {
        sc += 0.12;
        tx = p.x + fd * 130.0;
    }
    if (carryNeedsShotWindow && per.nearestOpponentDist > 40.0 && densityAhead <= 2) {
        double carryDistance = engine.carrierTracker.carryPathDistance;
        bool beforeMetricWindow = carryDistance < 210.0;
        sc += finalThird ? (beforeMetricWindow ? 0.34 : 0.24) : (beforeMetricWindow ? 0.25 : 0.17);
        tx = clamp(p.x + fd * (finalThird ? 175.0 : 195.0), 35.0, PITCH_W - 35.0);
        ty = lerp(ty, PITCH_H / 2.0, finalThird ? 0.32 : 0.18);
    }

    // Role-specific
    if (canUseWideDribble()) {
        bool inWide = pitch::lateralFromCenter(p.y) > 140.0;
        bool nearOppBox = distToGoal < 350.0;
        if (inWide) {
            sc += 0.15;
            if (per.nearestOpponentDist < 60.0) sc += 0.08;
        }
        if (nearOppBox && per.nearestOpponentDist > 50.0) sc += 0.10;
        if (inWide && nearOppBox) {
            tx = lerp(tx, gx, 0.75);
            ty = lerp(ty, PITCH_H / 2.0, 0.6);
        }
    }
    sc += openSpaceDribbleBonus(per.nearestOpponentDist);
    sc += nearGoalDribbleBonus(nearGoal, distToGoal);
    sc += engine.directiveBias[p.id].dribbleBonus;   // "take them on / dribble more"

    if (cp.score > 0.70 && cp.nearestPlayer) {
        double ax = p.x - cp.nearestPlayer->x;
        double ay = p.y - cp.nearestPlayer->y;
        double ad = std::hypot(ax, ay);
        if (ad > 1.0) {
            if (engine.state.clockMs > evadeSideUntilMs) {
                evadeSide = ay >= 0.0 ? 1.0 : -1.0;
                evadeSideUntilMs = engine.state.clockMs + 750.0;
            }
            // OWN-HALF ONLY (bisected): applied everywhere, this escape turned
            // pressing episodes that used to END possession (backward retreat →
            // recycle or dispossession) into retained forward carries, and the
            // compounding showed up as shots +7/90, goals +2/90 at 30 min (flat
            // at 10) with the CM-goals/headed-shots signature. The complaint it
            // fixes (seed 129 0:17-0:24, a 7s backward touchline crawl) was a
            // DEEP corner trap — attacking-third cornered carriers keep the old
            // radial retreat and have to release instead of grinding upfield.
            if ((ax / ad) * fd < -0.25 && pitch::forwardProgress(p.x, p.team) < PITCH_W * 0.55) {
                // Radial retreat from a goal-side presser points BACKWARD —
                // escape ACROSS the pitch instead (same idea as the committed
                // lateral escape in the close-evade branch above). The pure
                // away-vector ran a cornered winger 100px backward along the
                // touchline for 7 seconds, and because this block runs after
                // the backward-target pricing, that retreat was never even
                // scored as backward.
                tx = p.x + fd * 24.0;
                ty = p.y + evadeSide * 72.0;
            } else {
                double retreat = cp.exposed > 0.35 ? -fd * 34.0 : 0.0;
                tx = p.x + ax / ad * 44.0 + retreat;
                ty = p.y + evadeSide * 48.0;
            }
            // Re-apply the edge guard — this block runs after it, so the evade
            // could walk the carry into the touchline pocket the guard exists
            // to prevent.
            if (p.y < DRIBBLE_EDGE_MARGIN)           ty = std::max(ty, p.y + 40.0);
            if (p.y > PITCH_H - DRIBBLE_EDGE_MARGIN) ty = std::min(ty, p.y - 40.0);
            if (p.x < DRIBBLE_EDGE_MARGIN)           tx = std::max(tx, p.x + 40.0);
            if (p.x > PITCH_W - DRIBBLE_EDGE_MARGIN) tx = std::min(tx, p.x - 40.0);
        }
    }

    if (engine.carrierTracker.backwardCarryCarrierId == p.id) {
        double possessionBackward = (p.x - engine.carrierTracker.backwardCarryStartX) * fd;
        double finalBackwardTarget = (tx - p.x) * fd;
        bool touchlineCarry = p.y < 85.0 || p.y > PITCH_H - 85.0;
        if (possessionBackward < -70.0 && finalBackwardTarget < 0.0) {
            double side = p.y < PITCH_H / 2.0 ? 1.0 : -1.0;
            tx = p.x + fd * (touchlineCarry ? 78.0 : 55.0);
            ty = clamp(p.y + side * (touchlineCarry ? 70.0 : 46.0), 35.0, PITCH_H - 35.0);
            sc -= possessionBackward < -140.0 ? 0.50 : 0.28;
        }
    }

    // ── Round the keeper — he's charged off his line and you're clean through:
    // knock it past him and run on, rather than shooting into him. Steer the
    // carry to a point beside-and-beyond him, toward the open net, and prefer it
    // over a shot (the tap-in fires next ticks once he's behind you). Beating him
    // by taking him on is the one thing placement/pace/chip don't cover.
    if (const Player* gk = engine.findGK(p.team == Team::Home ? Team::Away : Team::Home)) {
        double gkOff = std::abs(gk->x - gx);                  // keeper genuinely off his line
        double gkToCarrier = dist(p.x, p.y, gk->x, gk->y);
        bool keeperAhead = (gk->x - p.x) * fd > 4.0;          // keeper is goal-side of me
        double gkPerp = std::abs(gk->y - p.y);                // ...and roughly in my path
        // Truly clean through: nobody (bar the keeper) goal-side and near.
        int goalSideDef = 0;
        for (auto& o : engine.state.players) {
            if (o.team == p.team || o.role == Role::GK) continue;
            if ((o.x - p.x) * fd > -8.0 && dist(p.x, p.y, o.x, o.y) < 110.0) goalSideDef++;
        }
        bool chargedRush = gkOff > 62.0 && keeperAhead && gkPerp < 58.0
                         && distToGoal > 70.0 && distToGoal < 215.0;
        bool cleanThrough = per.pressureCount == 0 && goalSideDef == 0 && gkToCarrier < 130.0 && gkToCarrier > 16.0 && !inOwnHalf;
        if (chargedRush && cleanThrough) {
            // Take the side of the keeper with more room, a stride beyond him,
            // staying within the goal mouth so the next touch faces the net.
            double sideTop = densityAt(gk->x + fd * 28.0, gk->y - 48.0);
            double sideBot = densityAt(gk->x + fd * 28.0, gk->y + 48.0);
            double roundSide = (sideTop <= sideBot) ? -1.0 : 1.0;
            tx = clamp(gk->x + fd * 42.0, 35.0, PITCH_W - 35.0);
            ty = clamp(gk->y + roundSide * 46.0, PITCH_H / 2.0 - GOAL_W * 0.6, PITCH_H / 2.0 + GOAL_W * 0.6);
            sc += 0.35;   // prefer taking him on over shooting into him
            if (engine.passDebug) fprintf(stderr, "ROUNDGK id=%d gkOff=%d d2g=%d\n", p.id, (int)gkOff, (int)distToGoal);
        }
    }

    return Action{ActionType::Dribble, clamp(sc, 0.0, 1.0), nullptr,
                  clamp(tx, 35.0, PITCH_W - 35.0),
                  clamp(ty, 35.0, PITCH_H - 35.0),
                  ActionPurpose::Space};
}

// ══════════════════════════════════════════════════════════════════════════════
// ct() — can-tackle
// ══════════════════════════════════════════════════════════════════════════════
