// engine_pass_exec.cpp — the EXECUTION side of passing
//
// Split out of engine_actions.cpp (2184 lines, four subsystems in one file).
// agent_pass*.cpp is the DECISION side (scoring the menu); this file is what
// happens after a pass is chosen: aim/lead/error at release, the tracked-pass
// lifecycle (beginTrackedPass -> resolvePendingPass), release-frame grading,
// whip/loft delivery shaping, forced releases and the clearance hoof.
#include "engine.h"
#include "agent.h"
#include "agent_helpers.h"
#include <cmath>
#include <numbers>
#include <cstdio>

void GameEngine::beginTrackedPass(Player& from, Player& to, bool isCross, bool isThrough, bool isCutback, bool isClear) {
    // Round-26: a Clear-purpose release is booked as a clearance elsewhere
    // (stats.recordClearance in agent.cpp), so it must not ALSO enter the
    // pass-completion ledger. Suppress passesAttempted here (and the matching
    // Completed/Intercepted in resolvePendingPass) while leaving every other
    // side effect below untouched.
    if (!isClear) stats.recordPassAttempt();
    if (from.id >= 0 && from.id < 22) pStats[from.id].passes++; // per-player rating input
    if (isThrough) stats.recordThroughBallAttempt();
    lastLooseOrigin = LooseOrigin::None;
    double speed = std::hypot(state.ball.vx, state.ball.vy);
    metrics.passLaunchSpeedTotal += speed;
    metrics.passLaunchCount++;
    stats.recordPassLaunch(speed);
    recordBallImpulse();
    double fd = fdFor(from.team);
    double forwardProgress = (to.x - from.x) * fd;
    stats.recordPassDirection(forwardProgress);
    if (to.role == Role::GK && forwardProgress < -30.0) stats.recordKeeperBackpass();
    bool offsideExempt = setPiece.type == SetPiece::Corner || setPiece.type == SetPiece::ThrowIn || setPiece.type == SetPiece::GoalKick;
    double line = offsideLineFor(from.team);
    bool beyondHalf = fd > 0.0 ? to.x > HALF_X : to.x < HALF_X;
    bool beyondPasser = fd > 0.0 ? to.x > from.x + OFFSIDE_TOLERANCE : to.x < from.x - OFFSIDE_TOLERANCE;
    bool beyondLine = fd > 0.0 ? to.x > line + OFFSIDE_TOLERANCE : to.x < line - OFFSIDE_TOLERANCE;
    bool receiverOffsideAtPass = beyondHalf && beyondPasser && beyondLine;
    pendingPass = {true, from.id, to.id, from.team, isCross, isThrough, isCutback, offsideExempt, receiverOffsideAtPass, from.x, from.y, line};
    // Round-31: mark the genuine aerial long ball. Not a cross (crosses already
    // have their own airborne contest), struck the length of a real long ball,
    // and actually leaving the ground — the loft itself is already applied by
    // the rawDist>240 / rawDist>350 vz rules in passBallTo above.
    pendingPass.isLofted = !isCross && dist(from.x, from.y, to.x, to.y) >= AERIAL_LONG_BALL_DIST
                           && state.ball.vz > 40.0;
    pendingPass.isClear = isClear;   // Round-26: keep Clear releases out of the pass-completion ledger
    // Round-34 census (owner complaint 2, the 0:59 ball): was there already an
    // opponent within 70px (7m) of the PASSER when he let it go? Tagged onto the
    // pass so the interception site below can report the share. Counter only.
    {
        double np = 1e9;
        for (auto& o : state.players) {
            if (o.team == from.team || o.role == Role::GK || o.sentOff) continue;
            np = std::min(np, dist(o.x, o.y, from.x, from.y));
        }
        pendingPass.nearPress70 = np < 70.0;
        if (!isClear) {
            stats.census.passReleases++;
            if (pendingPass.nearPress70) stats.census.passReleasesNearPress++;
        }
    }
    // Snapshot EVERY attacking teammate's offside status now (the law judges position when the ball is played).
    pendingPass.offsideAtPass = {};
    for (auto& tm : state.players) {
        if (tm.team != from.team || tm.id == from.id || tm.role == Role::GK) continue;
        bool bh = fd > 0.0 ? tm.x > HALF_X : tm.x < HALF_X;
        bool bp = fd > 0.0 ? tm.x > from.x + OFFSIDE_TOLERANCE : tm.x < from.x - OFFSIDE_TOLERANCE;
        bool bl = fd > 0.0 ? tm.x > line + OFFSIDE_TOLERANCE : tm.x < line - OFFSIDE_TOLERANCE;
        pendingPass.offsideAtPass[tm.id] = bh && bp && bl;
    }
    // Suicide-pass audit arming (owner: "let's audit these", seed 111 1:13 spec):
    // own defensive third + lateral/backward + an already-closing opponent in the
    // middle of the lane at release. Fires as a quality flag only if the ball is
    // actually cut inside 800ms (the Chiellini->Van Dijk ball died in 650ms).
    pendingPass.releaseMs = state.clockMs;
    // Round-23 gifted_pass geometry (owner explicitly expects the "retard pass"
    // alert): snapshot the passer's space and the closest opponent to the release
    // lane, judged the moment the ball is played. The lane is the ball's actual
    // launch direction (a through ball is led ahead, so passer->receiver would lie
    // about the path); each opponent is projected onto that ray (point-to-segment).
    {
        double avx = state.ball.vx, avy = state.ball.vy, asp = std::hypot(avx, avy);
        double dirx, diry;
        if (asp > 1.0) { dirx = avx / asp; diry = avy / asp; }
        else {
            double ddx = to.x - from.x, ddy = to.y - from.y, dd = std::hypot(ddx, ddy);
            if (dd > 1.0) { dirx = ddx / dd; diry = ddy / dd; } else { dirx = fd; diry = 0.0; }
        }
        double segLen = std::max(40.0, dist(from.x, from.y, to.x, to.y));
        double nearestOpp = 1e9;
        pendingPass.laneDistAtRelease.fill(1e9);   // a non-computed id (teammate/GK) never satisfies the <40 gate
        for (auto& o : state.players) {
            if (o.team == from.team || o.role == Role::GK || o.sentOff) continue;
            nearestOpp = std::min(nearestOpp, dist(o.x, o.y, from.x, from.y));
            double t2 = clamp((o.x - from.x) * dirx + (o.y - from.y) * diry, 0.0, segLen);
            double cx = from.x + dirx * t2, cy = from.y + diry * t2;
            if (o.id >= 0 && o.id < 22) pendingPass.laneDistAtRelease[o.id] = dist(o.x, o.y, cx, cy);
        }
        pendingPass.passerSpaceAtRelease = nearestOpp;
    }
    pendingPass.suicideRisk = false;
    // 300 -> 320 and t2 0.15/0.85 -> 0.12/0.95 (seed 111 1:24: a textbook
    // suicide ball from 302.4px missed the zone gate by 2.4px, and its
    // interceptor read the ball at t2=0.93 — outside the old scan band).
    if (pitch::distToOwnGoal(from.x, from.team) < 320.0 && forwardProgress <= 40.0) {
        double sdx = to.x - from.x, sdy = to.y - from.y, sls = sdx * sdx + sdy * sdy;
        if (sls > 1.0) {
            for (auto& o : state.players) {
                if (o.team == from.team || o.role == Role::GK || o.sentOff) continue;
                double t2 = ((o.x - from.x) * sdx + (o.y - from.y) * sdy) / sls;
                if (t2 < 0.12 || t2 > 0.95) continue;
                double cx = from.x + t2 * sdx, cy = from.y + t2 * sdy;
                double perp = dist(o.x, o.y, cx, cy);
                if (perp > 60.0) continue;
                double closing = perp > 1.0 ? (o.vx * (cx - o.x) + o.vy * (cy - o.y)) / perp : 0.0;
                if (closing > 20.0) { pendingPass.suicideRisk = true; break; }
            }
        }
    }
}

bool GameEngine::resolvePendingPass(Player& receiver) {
    if (!pendingPass.active) return false;
    if (receiver.team == pendingPass.team && !pendingPass.offsideExempt) {
        double fd = fdFor(pendingPass.team);
        // Intended receiver: judged by his position when the ball was played
        // (stored at launch). Judging at collection flagged every legal run
        // in behind. Unintended teammates keep the collection-time check.
        bool offside;
        if (receiver.id == pendingPass.toId) {
            offside = pendingPass.receiverOffsideAtPass;
        } else {
            // Unintended teammate: judged by HIS position when the ball was PLAYED (the law),
            // not at collection — collection-time flagged onside players who chased a long ball
            // 20m+ past the line (diagnosed: 63% of calls, median 164px past the line, all false).
            offside = pendingPass.offsideAtPass[receiver.id];
        }
        if (offside) {
            stats.recordOffside();
            Team defendingTeam = receiver.team == Team::Home ? Team::Away : Team::Home;
            pendingPass.active = false;
            emitEvent("offside", receiver.x, receiver.y, receiver.id, pendingPass.fromId);
            awardOffsideFreeKick(defendingTeam, receiver);
            return true;
        }
    }
    auto& b = state.ball;
    double deliveryDist = dist(pendingPass.passerX, pendingPass.passerY, receiver.x, receiver.y);
    double deliverySpeed = std::hypot(b.vx, b.vy);
    // Round-31: a lofted long ball met in the air IS a header — book and render
    // it as one, so aerial duels and second balls appear in the census instead
    // of being silently resolved as ground control.
    bool plausibleHeader = (pendingPass.isCross || pendingPass.isLofted) && b.z >= HEADER_MIN_HEIGHT && b.z <= HEADER_MAX_HEIGHT && deliveryDist >= HEADER_MIN_DELIVERY_DIST && deliverySpeed >= HEADER_MIN_SPEED;
    if (plausibleHeader) {
        // Tripwire (watched replay seed 133 0:28): the contact gates cap header
        // contact at leap reach — a header resolving above it means the ghost
        // class (contact rendered a body-length off the header-er) is back.
        if (b.z > HEADER_REACH_Z + MEET_REACH_HEAD) stats.recordQualityFlag(QualityFlag::GhostHeader);
        // Horizontal ghost (seed 111 28:45): a header resolved with the ball
        // 19px+ from the header-er's body — vertical-only tripwire missed it.
        if (dist(receiver.x, receiver.y, b.x, b.y) > MEET_REACH_HEAD + 6.0) stats.recordQualityFlag(QualityFlag::GhostHeader);
        stats.recordHeader(b.z, deliveryDist, deliverySpeed, !plausibleHeader);
        receiver.headingAnim = 520.0;
        emitEvent("header", receiver.x, receiver.y, receiver.id, pendingPass.fromId);
        double fd = fdFor(receiver.team);
        double gx = goalXFor(receiver.team);
        double shotDistance = pitch::distToGoalMouth(receiver.x, receiver.y, receiver.team);
        if (receiver.team != pendingPass.team) {
            return resolveHeaderClearance(receiver, deliverySpeed);
        }
        if (receiver.team == pendingPass.team) {
            return resolveAttackingHeader(receiver, fd, gx, shotDistance);
        }
    }
    recordPassOutcome(receiver);
    pendingPass.active = false;
    return false;
}

// ══════════════════════════════════════════════════════════════════════════════
// recordPassOutcome() — close the ledger on a ground reception
// ══════════════════════════════════════════════════════════════════════════════
// The 101-line bookkeeping tail of resolvePendingPass: completed-vs-cut
// counters, the four giveaway censuses (suicide / early-kickoff / senseless /
// gifted), the intercept event and the cross/through collection flags. It has
// no early exits and touches no local of the resolution above it — the only
// thing it needs is who ended up with the ball.
void GameEngine::recordPassOutcome(Player& receiver) {
    bool passOk = receiver.team == pendingPass.team;
    if (passDebug) {
        // PASSRES: one line per resolved pass (complete/fail) with match-clock
        // seconds + passer stamina — lets a probe bucket completion% by window
        // (early vs late) to confirm decision-level fatigue. Measurement-only.
        const Player* fromP = playerById(pendingPass.fromId);
        fprintf(stderr, "PASSRES t=%d ok=%d sf=%d\n", (int) (state.clockMs / 1000), passOk ? 1 : 0,
                fromP ? (int) fromP->stamina : -1);
    }
    if (passOk) {
        if (receiver.id >= 0 && receiver.id < 22 && pendingPass.fromId != receiver.id) {
            runtime[receiver.id].lastReceiveFrom = pendingPass.fromId;
            runtime[receiver.id].lastReceiveMs = state.clockMs;
        }
        if (!pendingPass.isClear) stats.recordPassComplete();   // Round-26: a completed Clear is a clearance, not a pass
        if (pendingPass.fromId >= 0 && pendingPass.fromId < 22) pStats[pendingPass.fromId].passesCompleted++;
        if (pendingPass.isThrough) stats.recordThroughBallComplete();
        if (receiver.id == pendingPass.toId)
            stats.recordPassIntendedReceived();
        else
            stats.recordPassWrongTeammate();
    } else {
        if (!pendingPass.isClear) stats.recordPassIntercepted();   // Round-26: a cut Clear is a clearance that didn't retain, not a failed pass
        // Round-34 census: the 41% statistic — how many cut balls were cut by a
        // man who was already within 7m of the passer at release.
        if (!pendingPass.isClear) {
            stats.census.passIntercepts++;
            if (pendingPass.nearPress70) stats.census.passInterceptsNearPress++;
        }
        if (receiver.id >= 0 && receiver.id < 22) runtime[receiver.id].lastTurnoverWinMs = state.clockMs;
        if (pendingPass.suicideRisk && state.clockMs - pendingPass.releaseMs < 800.0)
            stats.recordQualityFlag(QualityFlag::SuicidePass);
        // Owner ask (seed 437 0:03, a giveaway straight off the kickoff with
        // easy options everywhere): census of passes RELEASED within 5s of a
        // kickoff that the opponent cuts out. Measurement only.
        if (pendingPass.releaseMs - phase.lastKickoffMs < 5000.0 && pendingPass.releaseMs >= phase.lastKickoffMs)
            stats.recordQualityFlag(QualityFlag::EarlyKickoffGiveaway);
        // Senseless-giveaway census (owner ask, 0:06 "senseless loss"): an
        // UNPRESSURED passer whose plain (non-cross, non-through) ball was cut
        // out — a poor giveaway, not a forced or deliberately-risky ball. Pressure
        // gauged at the release point; measurement only.
        if (!pendingPass.isCross && !pendingPass.isThrough) {
            const Player* fromP2 = playerById(pendingPass.fromId);
            if (fromP2 && fromP2->role != Role::GK) {
                double np = 1e9;
                for (auto& o : state.players)
                    if (o.team != fromP2->team && o.role != Role::GK && !o.sentOff)
                        np = std::min(np, dist(o.x, o.y, pendingPass.passerX, pendingPass.passerY));
                if (np > 65.0) stats.recordSenselessGiveaway();
            }
        }
        // Round-23 gifted_pass (owner explicitly expects the "retard pass" alert):
        // an OUTCOME flag that the coverage holes miss — Through balls are exempt
        // from nonsense_pass/senseless_giveaway, and nonsense_pass needs the
        // engine's OWN expectedCompletion<0.5 (the mispricing that chose the ball
        // hides it). Here: the passer HAD space (>55px) yet threaded it straight to
        // the very opponent already sitting IN its path (<25px off the release lane),
        // cut promptly (<1200ms — a ball that took longer went far / the man
        // converged, an ambitious ball, not a gift-to-a-stander). NO isThrough
        // exemption — a race lost in behind is a deliberate risk; a body standing in
        // the ball's path is not. Crosses are excluded (an aerial delivery has no
        // ground lane, and a headed-away cross is not a "pass to the opposition").
        // The lane<25 / <1200ms thresholds tighten the spec's 40px/2000ms starting
        // point, which also swept up long balls a distant defender converged on.
        {
            const Player* fromG = playerById(pendingPass.fromId);
            bool interceptorInLane = receiver.id >= 0 && receiver.id < 22
                                     && pendingPass.laneDistAtRelease[receiver.id] < 25.0;
            if (fromG && fromG->role != Role::GK && !pendingPass.isCross
                && state.clockMs - pendingPass.releaseMs < 1200.0
                && pendingPass.passerSpaceAtRelease > 55.0
                && interceptorInLane)
                stats.recordQualityFlag(QualityFlag::GiftedPass);
        }
        emitEvent("intercept", receiver.x, receiver.y, receiver.id, pendingPass.toId);
        if (passDebug) {
            const Player* intended = playerById(pendingPass.toId);
            double laneFrac = -1.0, passDist = 0.0;
            if (intended) {
                double dx = intended->x - pendingPass.passerX, dy = intended->y - pendingPass.passerY, ls = dx * dx + dy * dy;
                if (ls > 1.0) laneFrac = clamp(((receiver.x - pendingPass.passerX) * dx + (receiver.y - pendingPass.passerY) * dy) / ls, 0.0, 1.0);
                passDist = std::hypot(dx, dy);
            }
            // lane% = where along the passer->receiver line it was cut (0=at passer, 100=at receiver).
            fprintf(stderr, "INTCPT t=%d comp=%d blk=%d press=%d fwd=%d dist=%d lane=%d cross=%d thru=%d saferComp=%d\n",
                    (int) (state.clockMs / 1000), (int) (pendingPass.auComp * 100), pendingPass.auBlk, pendingPass.auPress,
                    (int) pendingPass.auFwd, (int) passDist, (int) (laneFrac * 100), (int) pendingPass.isCross,
                    (int) pendingPass.isThrough, (int) (pendingPass.auSafer * 100));
        }
    }
    if (pendingPass.isCross && receiver.team == pendingPass.team) {
        stats.recordCrossComplete();
        // (Round-31: the historical dead `receiver.crossCollected = 1500.0;` here is
        //  gone for good — the marker itself no longer exists. A cross collected on
        //  the ground now simply becomes an ordinary carry; whether such a collector
        //  should get a first-time-shot bias is an open question for a round that can
        //  afford the A/B, not a flag to be re-lit. See the tombstone in shootBall().)
    }
    if (pendingPass.isThrough && receiver.team == pendingPass.team) {
        receiver.throughCollected = 1400.0;
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// resolveAttackingHeader() — a teammate meets the cross
// ══════════════════════════════════════════════════════════════════════════════
// The own-team half of resolvePendingPass' header branch: book the completed
// cross, then decide header-at-goal vs cushioned layoff. Takes the three
// geometry facts the caller already computed off the receiver; like the
// clearance it always consumes the ball, hence the unconditional true.
bool GameEngine::resolveAttackingHeader(Player& receiver, double fd, double gx,
                                        double shotDistance) {
    auto& b = state.ball;
    stats.recordPassComplete();
    if (pendingPass.fromId >= 0 && pendingPass.fromId < 22) pStats[pendingPass.fromId].passesCompleted++;
    if (receiver.id == pendingPass.toId)
        stats.recordPassIntendedReceived();
    else
        stats.recordPassWrongTeammate();
    stats.recordCrossComplete();
    double angleDeg = goalOpeningAngleDeg(receiver.x, receiver.y, gx);
    int pressure = countPressure(state.players, receiver.x, receiver.y, receiver.team, PRESSURE_RANGE);
    int laneBlockers = countLaneBlockers(state.players, receiver.x, receiver.y, gx, PITCH_H / 2.0, receiver.team, 32.0, 0.08, 0.88);
    double roleShotMax = receiver.role == Role::CM ? 235.0 : 285.0;
    // Pressure degrades the chance, not eligibility — strikers attack
    // headers in crowded boxes; a pressure veto turned them all into layoffs.
    // Round-31 COMMIT 1: the BIG MAN. agent_setpiece sends a centre-back
    // to the far post for every corner, and the role list here (CF/WM/CM
    // only) then forbade him from attacking the goal with the header he
    // was sent up to win — so the classic set-piece goal could not exist
    // and corners scored ~1 in 200. Let a defender who is genuinely in
    // the box, close and central, head at goal. Tightly gated (inside the
    // area laterally, <15m, real opening) so a full-back glancing an
    // open-play cross from the touchline is untouched.
    bool bigManHeader = roles::isDefenderRole(receiver.role)
        && shotDistance < 150.0 && angleDeg > 8.0
        && pitch::lateralFromCenter(receiver.y) < PENALTY_AREA_H / 2.0;
    bool headerShot = ((receiver.role == Role::CF || receiver.role == Role::WM || receiver.role == Role::CM) && shotDistance < roleShotMax && angleDeg > 4.0 && laneBlockers <= 3)
                    || (bigManHeader && laneBlockers <= 3);
    bool mustAttackHeader = (shotDistance < 185.0 && angleDeg > 6.0 && pressure <= 2 && laneBlockers <= 1)
                         || (bigManHeader && shotDistance < 110.0 && laneBlockers <= 1);
    double shotChance = clamp(0.32 + (roleShotMax - shotDistance) / 260.0 + angleDeg / 82.0 - pressure * 0.06 - laneBlockers * 0.08, 0.0, 0.85);
    if (headerShot && (mustAttackHeader || rng.random() < shotChance)) {
        // Launch FROM the contact point: shootBall aims from the
        // shooter's body, but the met ball can sit ~15-20px away — the
        // 28:45 phantom rocketed goalward from beside an untouched
        // defender. Snap the ball to the header-er's head first so
        // position and velocity tell the same story.
        {
            double hbd = dist(receiver.x, receiver.y, b.x, b.y);
            if (hbd > 10.0) {
                b.x = receiver.x + (b.x - receiver.x) / hbd * 10.0;
                b.y = receiver.y + (b.y - receiver.y) / hbd * 10.0;
            }
        }
        if (receiver.id >= 0 && receiver.id < 22 && pendingPass.fromId != receiver.id) {
            runtime[receiver.id].lastReceiveFrom = pendingPass.fromId;
            runtime[receiver.id].lastReceiveMs = state.clockMs;
        }
        pendingPass.active = false;
        shootBall(receiver, nullptr, /*headerFinish=*/true);
        return true;
    }

    stats.recordHeaderLayoff();
    Player* outlet = nullptr;
    double bestScore = -1e9;
    for (auto& t : state.players) {
        if (t.team != receiver.team || t.id == receiver.id || t.role == Role::GK || t.sentOff) continue;
        double d = dist(receiver.x, receiver.y, t.x, t.y);
        if (d < 28.0 || d > 285.0) continue;
        double progress = (t.x - receiver.x) * fd;
        double targetGoalDist = std::abs(t.x - gx);
        bool central = pitch::lateralFromCenter(t.y) < 180.0;
        double score = progress * 0.28 - std::abs(t.y - receiver.y) * 0.12 - d * 0.06;
        if (roles::isAttacker(t.role)) score += 28.0;
        if (t.role == Role::CM && central && targetGoalDist < 260.0) score += 34.0;
        if (targetGoalDist < shotDistance + 25.0 && central) score += 22.0;
        if (pressure >= 2 && progress < -15.0) score += 18.0;
        if (score > bestScore) {
            bestScore = score;
            outlet = &t;
        }
    }
    double tx = outlet ? outlet->x : clamp(receiver.x + fd * 95.0, 25.0, PITCH_W - 25.0);
    double ty = outlet ? outlet->y : lerp(receiver.y, PITCH_H / 2.0, 0.25);
    double dx = tx - receiver.x, dy = ty - receiver.y;
    double len = std::max(1.0, std::hypot(dx, dy));
    b.controllerId = -1;
    b.intendedReceiverId = outlet ? outlet->id : -1;
    receiverShieldTargetId = b.intendedReceiverId;
    b.vx = dx / len * 135.0;
    b.vy = dy / len * 135.0;
    b.z = 12.0;
    b.vz = 45.0;
    b.lastTouchTeam = receiver.team;
    b.lastToucherId = receiver.id; lastRicochetMs = -1e9;   // genuine touch supersedes ricochet restart memory
    lastLooseOrigin = LooseOrigin::HeaderLayoff;
    pendingPass.active = false;
    recordBallImpulse();
    return true;
}

// ══════════════════════════════════════════════════════════════════════════════
// resolveHeaderClearance() — a defender heads the cross away
// ══════════════════════════════════════════════════════════════════════════════
// The opponent half of the header branch of resolvePendingPass, 89 lines that
// need one fact from the caller (the delivery pace the clearance inherits) and
// end, on every path, with the ball loose and the pass ledger closed — hence
// the unconditional true.
bool GameEngine::resolveHeaderClearance(Player& receiver, double deliverySpeed) {
    auto& b = state.ball;
    stats.recordHeaderClearance();
    stats.recordPassIntercepted(); // the cross was cut out — close the pass ledger
    stats.census.passIntercepts++;
    if (pendingPass.nearPress70) stats.census.passInterceptsNearPress++;
    // Direction is pressure-driven (watched replay seed 133 0:28: an
    // UNPRESSURED CB glanced a routine cross behind for a corner —
    // "just heading forward would be more realistic ... or a header
    // back to the gk"). Conceding a corner is what a PRESSED defender
    // does because it's all he can reach; a free man heads forward, or
    // cushions it down to his keeper.
    double clearerPressD = 1e9;
    for (auto& opp : state.players) {
        if (!isActiveOpponent(opp, receiver.team)) continue;
        clearerPressD = std::min(clearerPressD, dist(opp.x, opp.y, receiver.x, receiver.y));
    }
    bool clearerPressed = clearerPressD < 60.0;
    double ownLineX = ownGoalXFor(receiver.team);
    if (clearerPressed && std::abs(receiver.x - ownLineX) < 165.0 && rng.random() < 0.72) { // pressed-only now; prob 0.62->0.72 recovers volume lost to the pressure gate
        double sideDir = receiver.y < PITCH_H / 2.0 ? -1.0 : 1.0;
        // Speed scales with distance to the line so the header genuinely
        // carries behind despite airborne drag (see the cut-cross deflection).
        double hs = std::max(clamp(deliverySpeed * 0.5, 140.0, 240.0),
                             std::abs(ownLineX - receiver.x) / 0.55);
        // AIM at a point on the goal line OUTSIDE the near post — the
        // old flat vy ratio sent a CENTRAL clearer's header straight
        // through his own mouth (seed 103: headed "behind" from y=331,
        // crossed at y=306, inside the post — an own goal).
        double clearY = PITCH_H / 2.0 + sideDir * (GOAL_W / 2.0 + 20.0 + rng.random() * 95.0);
        if (sideDir < 0.0) clearY = std::min(clearY, b.y - 8.0);
        else clearY = std::max(clearY, b.y + 8.0);
        double dxL = ownLineX - b.x, dyL = clearY - b.y;
        double dL = std::max(1.0, std::hypot(dxL, dyL));
        b.controllerId = -1;
        b.intendedReceiverId = -1;
        b.vx = dxL / dL * hs;
        b.vy = dyL / dL * hs;
        b.z = std::max(b.z, 12.0);
        b.vz = 70.0 + rng.random() * 80.0;
        b.lastTouchTeam = receiver.team;
        b.lastToucherId = receiver.id; lastRicochetMs = -1e9;   // genuine touch supersedes ricochet restart memory
        pendingPass.active = false;
        blockReboundFor(receiver.id, 500);
        return true;
    }
    // Unpressured and deep, keeper unbothered: cushion the header down
    // to the GK — the routine real-life choice a free defender makes
    // instead of hammering it anywhere.
    if (!clearerPressed && std::abs(receiver.x - ownLineX) < 220.0) {
        Player* gk = findGK(receiver.team);
        if (gk && rng.random() < 0.55) {
            double gkOppD = 1e9;
            for (auto& opp : state.players) {
                if (!isActiveOpponent(opp, receiver.team)) continue;
                gkOppD = std::min(gkOppD, dist(opp.x, opp.y, gk->x, gk->y));
            }
            double gkD = dist(receiver.x, receiver.y, gk->x, gk->y);
            if (gkOppD > 110.0 && gkD > 55.0 && gkD < 260.0) {
                double ndx = gk->x - receiver.x, ndy = gk->y - receiver.y;
                double hs2 = clamp(gkD * 1.15, 110.0, 230.0);
                b.controllerId = -1;
                b.intendedReceiverId = gk->id;
                b.vx = ndx / gkD * hs2;
                b.vy = ndy / gkD * hs2;
                b.z = std::max(b.z * 0.5, 10.0);
                b.vz = 35.0;
                b.lastTouchTeam = receiver.team;
                b.lastToucherId = receiver.id; lastRicochetMs = -1e9;   // genuine touch supersedes ricochet restart memory
                lastLooseOrigin = LooseOrigin::HeaderClearance;
                pendingPass.active = false;
                recordBallImpulse();
                return true;
            }
        }
    }
    double clearFd = fdFor(receiver.team);
    b.controllerId = -1;
    b.intendedReceiverId = -1;
    // Launch from the BALL's flight position — snapping it to the
    // header-winner's body popped it up to 90px in one tick.
    b.vx = clearFd * 210.0;
    b.vy = (receiver.y < PITCH_H / 2.0 ? -1.0 : 1.0) * 55.0;
    b.z = 18.0;
    b.vz = 95.0;
    b.lastTouchTeam = receiver.team;
    b.lastToucherId = receiver.id; lastRicochetMs = -1e9;   // genuine touch supersedes ricochet restart memory
    lastLooseOrigin = LooseOrigin::HeaderClearance;
    pendingPass.active = false;
    recordBallImpulse();
    return true;
}

double GameEngine::goalOpeningAngleDeg(double x, double y, double gx) const {
    double dx = gx - x;
    double top = std::atan2(PITCH_H / 2.0 - GOAL_W / 2.0 - y, dx);
    double bottom = std::atan2(PITCH_H / 2.0 + GOAL_W / 2.0 - y, dx);
    double opening = std::abs(std::atan2(std::sin(bottom - top), std::cos(bottom - top)));
    return opening * 180.0 / PI;
}

// Shared whip math for driven deliveries. Assumes ball velocity already
// points at the target with magnitude `speed`. Adds the dip (the ball
// arrives at header height as it reaches the aim point), the inswinging
// curl toward the goal mouth, and pre-rotates the launch wide so the bent
// path still lands on the target.
void GameEngine::applyWhipDelivery(double dist, double speed, double goalX, double curlMin, double curlRange, const Player* crosser) {
    auto& b = state.ball;
    double flightT = clamp(dist / speed, 0.25, 1.1);
    b.vz = clamp(landOnTargetVz(flightT, flightT, CROSS_DIP_TARGET_Z), 150.0, 280.0);
    double toGoalCross = b.vx * (PITCH_H / 2.0 - b.y) - b.vy * (goalX - b.x);
    b.curl = signedCurl(toGoalCross, curlMin + rng.random() * curlRange);
    // Footedness: the default whip is the INSWINGER (bends at goal). A crosser
    // whose strike foot matches the flank (right foot from the right byline)
    // wraps it the other way — the OUTSWINGER, flatter and drifting away —
    // and a weak-foot whip carries ~30% less bend. Left-footers on the right
    // (Robben-style) keep the vicious inswinger.
    if (crosser) {
        int kf = kickingFootFor(*crosser, b.vx, b.vy);
        bool bottomFlank = crosser->y > PITCH_H / 2.0;
        bool outswing = (kf > 0) == (bottomFlank == (fdFor(crosser->team) > 0.0));
        if (outswing) b.curl = -b.curl * 0.8;
        if (crosser->foot != 0 && kf != crosser->foot) b.curl *= 0.7;
    }
    applyCurlPreRotation(b, b.curl, flightT);
}

void GameEngine::placeBallForRelease(Player& kicker, double dx, double dy, double maxOffset) {
    state.ball.curl = 0.0;
    double d = std::hypot(dx, dy);
    double tx, ty;
    if (d < 0.001) {
        double fd = fdFor(kicker.team);
        tx = clamp(kicker.x + fd * maxOffset, 5.0, PITCH_W - 5.0);
        ty = kicker.y;
    } else {
        tx = clamp(kicker.x + dx / d * maxOffset, 5.0, PITCH_W - 5.0);
        ty = clamp(kicker.y + dy / d * maxOffset, 5.0, PITCH_H - 5.0);
    }
    // Step toward the release point instead of snapping: a snap moved the ball
    // up to ~2*maxOffset across the kicker's body in one tick, and the launch
    // velocity covers the remainder within a tick or two anyway.
    double mx = tx - state.ball.x, my = ty - state.ball.y;
    double md = std::hypot(mx, my);
    if (md > BALL_RELEASE_MAX_STEP && md < 60.0) {
        state.ball.x += mx / md * BALL_RELEASE_MAX_STEP;
        state.ball.y += my / md * BALL_RELEASE_MAX_STEP;
    } else {
        state.ball.x = tx;
        state.ball.y = ty;
    }
}

void GameEngine::passBallTo(Player& f, Player& t) {
    passBallTo(f, t, false, false, nullptr);
}

bool GameEngine::passBallTo(Player& f, Player& t, bool throughBall, bool lob, const PassSelectionAudit* selectionAudit, bool secure) {
    double rawDx = t.x - f.x, rawDy = t.y - f.y, rawDist = std::hypot(rawDx, rawDy);
    if (rawDist < 1) return false;
    // `secure`: a deliberate, unpressured short roll (keeper distribution to an
    // already-clear man). Drive it faster and flatter so a defender can't drift
    // into the lane before it arrives — an open keeper roll isn't getting nicked.
    double speed = (PASS_SPEED_BASE + rawDist * PASS_SPEED_DIST) * (0.92 + rng.random() * 0.16);
    // A contested reception wants PACE (watched replay seed 111 0:32: soft
    // ball played square while the presser arrived with it — "at least it
    // should be a faster pass as can see 7 arriving"): when an opponent is
    // within a closing stride of the receiver, zip it.
    {
        double recvThreat = 1e9;
        for (auto& o : state.players) {
            if (o.team == f.team || o.role == Role::GK || o.sentOff) continue;
            recvThreat = std::min(recvThreat, dist(o.x, o.y, t.x, t.y));
        }
        if (recvThreat < 85.0) speed *= 1.14;
    }
    // NOTE: a short-range pace throttle (speed *= clamp(rawDist/150, 0.66, 1))
    // for the "why was that pass so hard" look (0:38) was A/B'd and REVERTED —
    // a gentler short ball spends longer in the lane and the step-in
    // interceptor model punishes it (completion 81.1 -> 79.4). The verifier
    // confirmed the pace was cosmetic and did NOT cause the turnover; the
    // point-blank blocker did (fixed in scorePassToTarget).
    if (secure) speed *= 1.45;
    // Long balls are DRIVEN (watched replay seed 129 0:26.4, owner: "mindless
    // pass not realistic"): the base gradient tops out ~195px/s, and with air
    // drag a 350px+ ball died ~60% of the way out and arrived as a walking-pace
    // roll anyone could step in front of (census: 13 passes planned >330px,
    // only 4 arrived — every one as a dead ball the receiver walked back to).
    // Real switches are struck: ~1.6s flight instead of ~2.8s+roll. Crosses
    // set their own pace below; through balls keep the led-runner solve.
    // Round-24 (underhit census: the 180-260px band fell to the soft gradient
    // ~160px/s and died a mean ~149px short of a moving receiver — the biggest
    // visible "misplaced pass" class). Lower the driven floor 260->180 so the
    // medium ball is struck, not lobbed onto the gradient; the >300px through
    // floor below stays a separate, gentler solve and the led-runner semantics
    // are untouched.
    if (rawDist > 180.0 && !throughBall && !lob)
        speed = std::max(speed, std::min(300.0, 150.0 + rawDist * 0.32));
    // Round-23 (11v11 0:10 "why would 9R just pass it to the opposition"): a LONG
    // through ball ("over the top") was exempt from the driven floor and floated
    // out at ~166px/s (the base gradient) while the selection model priced it at
    // 150+d*0.32 — systematic step-in optimism, the ball arriving at walking pace
    // for the sweeper. Give a >300px through ball its own (slightly gentler)
    // driven floor so it actually arrives; short slipped balls keep the led-runner
    // solve untouched.
    if (rawDist > 300.0 && throughBall && !lob)
        speed = std::max(speed, std::min(260.0, 140.0 + rawDist * 0.28));
    double travelTime = rawDist / std::max(speed, 1.0);
    double receiverSpeed = std::hypot(t.vx, t.vy);
    double fd = fdFor(f.team);
    bool movingForward = t.vx * fd > 5;
    // Round-24 TOMBSTONE: raising the moving-receiver leadFactor (0.90->0.95
    // and ->1.05) to "cure" underhit was A/B'd on the misplaced census and
    // REVERTED. With the ball now DRIVEN (floor above), the extra lead over-ran
    // the runner into empty grass — census misplaced 20.7 -> 22.0/23.9, the
    // 260-360 band worsened, and turnovers rose (poss changes 508 -> 550) for
    // no completion gain (~85% either way). The driven floor alone reaches the
    // moving receiver before he vacates; the 0.90/0.55 lead stays.
    double leadFactor = throughBall ? (movingForward && receiverSpeed > 14 ? 1.32 : 0.80) : (movingForward && receiverSpeed > 20 ? 0.90 : 0.55);
    // Lead scales with the ball's own length (seed 111 1:35: a 195px through
    // ball took the full 90-210px lead and landed in Neuer's arms 100px past
    // the runner). A short slipped ball leads a stride; only the long killer
    // earns the full channel lead. And with the RECEIVER'S actual run (seed
    // 437 1:14: a near-standing collector was led 90px+ into empty grass,
    // straight to the sweeping defender — the channel lead is for a runner at
    // pace; a static man gets it to feet).
    double throughLead = throughBall ? fd * (90 + attrFactor(f.attrs.creativity) * 120) * clamp(rawDist / 450.0, 0.35, 1.0)
                                     * clamp(receiverSpeed / 40.0, 0.15, 1.0) : 0;
    // NOTE: clamping the through-ball aim point inside the field (weighting it
    // to stay in) was A/B'd and REVERTED — the most valuable killer balls are
    // aimed exactly at the deep byline channel, and pulling them up cost the
    // led-runner-loft goal gain (1.45 -> 0.82). An overhit through ball running
    // out is deliberate-risk football; the senseless-out-of-play census
    // excludes Through purposes (like crosses) for the same reason.
    double predX = t.x + t.vx * travelTime * leadFactor + throughLead;
    double predY = t.y + t.vy * travelTime * leadFactor;
    // A passer never AIMS outside the pitch: leading a winger sprinting down
    // the line put the aim point past the touchline (predY < 0), and with
    // realistic airborne drag the ball now carries there instead of dying
    // short — traced senseless-out-of-play census: deep diagonals drifting
    // out over the touchline, unpressured. Tight 12px margin so the deep
    // byline channel ball stays aggressive (a 40px margin blunted penetration
    // and cost the led-runner-loft goal gain).
    predX = clamp(predX, 12.0, PITCH_W - 12.0);
    predY = clamp(predY, 10.0, PITCH_H - 10.0);
    double dx = predX - f.x, dy = predY - f.y, adjDist = std::hypot(dx, dy);
    if (adjDist < 1) return false;
    double passSkill = attrFactor(f.attrs.passing);
    double skillMiss = std::pow(1.0 - passSkill, 1.4);
    // Round-24 (long-ball lateral spray census): the distance-quadratic doubled
    // inaccuracy by ~40m while sub-260px balls are already 98% on-line — the
    // long switch sprayed laterally far more than a good passer's execution
    // warrants. Trim the quadratic 7.0->5.0; the linear term and the freshTouch
    // Round-25 (SPACING/PATIENCE co-tune): the wider standoff + composure brake
    // + middle-third offer package left more balls threaded through pressured
    // zones, so completion sank ~2pp below band and lane interceptions ticked up.
    // The quadratic still has margin against the 6px normal-ball median — trim
    // 5.0->4.5 to buy execution accuracy back without touching short balls.
    // (0.75/0.5) / settled (0.28) face terms below are untouched (round-17 spray
    // is exonerated — median lateral miss 6px on normal balls).
    double inacc = skillMiss * (rawDist * 0.085 + (rawDist / 200.0) * (rawDist / 200.0) * 4.5);
    // Fatigue: a tired passer sprays it — error grows as the tank empties
    // (up to +80% at empty). No-op at full stamina, so early passes are clean.
    inacc *= 1.0 + (1.0 - staminaFrac(f.stamina)) * 0.8;
    // Footedness: a ball forced onto the weak side sprays more and carries
    // less. Two-footed players (foot=0) never pay it.
    if (weakFootStrike(f, dx, dy)) { inacc *= 1.28; speed *= 0.93; }
    // First touch is harder (owner, seed 111 2:05: "first touch is harder —
    // make sure that's in mechanics"; pid19 struck a 43.6m first-time
    // cross-field ball 400ms after winning a tackle, at full pace, dead
    // straight — no mechanic anywhere priced it). A ball struck before it's
    // settled sprays, worst of all a LONG ball hit ACROSS the body; a short
    // lay-off to feet barely pays. Keyed on carryStartMs<500 (the settle
    // window alone maxes at ~165ms and misses the 200-400ms turn-and-hits).
    {
        double heldMs = state.clockMs - carrierTracker.carryStartMs;
        bool freshTouch = f.id >= 0 && f.id < 22
            && ((runtime[f.id].firstTouchUntilMs > state.clockMs)
                || (carrierTracker.carryTrackerId == f.id && heldMs < 500.0));
        double wantAng = std::atan2(dy, dx);
        double offF = std::abs(std::atan2(std::sin(wantAng - f.facing), std::cos(wantAng - f.facing)));
        double faceTerm = clamp((offF - 0.4) / 1.6, 0.0, 1.0);
        // A SETTLED carrier striking across the body pays a mild spray too —
        // the turn-before-release gate lets go within ~54deg, and a pressured
        // release mid-turn can still be well off-axis (round-17 low-level
        // audit: the "unnatural cross" class was 100% spray-free when held
        // >500ms). Fresh touches keep the full first-touch penalty on top.
        inacc *= 1.0 + 0.28 * faceTerm;   // round-18 trim
        if (freshTouch) {
            double distTerm = clamp(rawDist / 260.0, 0.0, 1.0);
            inacc *= 1.0 + 0.75 * distTerm + 0.5 * faceTerm;   // round-18 trim (turnover volume)
            speed *= 1.0 - 0.15 * (distTerm * 0.5 + faceTerm * 0.5);
        }
    }
    if (secure) inacc *= 0.12; // rolled accurately to feet
    double tdx = dx + (rng.random() - 0.5) * inacc;
    double tdy = dy + (rng.random() - 0.5) * inacc;
    double tDist = std::hypot(tdx, tdy);
    double ownGoalX = ownGoalXFor(f.team);
    bool towardOwnGoal = f.team == Team::Home ? tdx < 0 : tdx > 0;
    bool defendingOwnBox = std::abs(f.x - ownGoalX) < PITCH_W / 3.0;
    if (towardOwnGoal && defendingOwnBox) {
        double travel = (ownGoalX - f.x) / tdx;
        double crossingY = f.y + tdy * travel;
        if (travel > 0 && travel <= 1.0 && std::abs(crossingY - PITCH_H / 2) < GOAL_W / 2 + BALL_R + 8) return false;
    }
    // A ball driven INTO the opponent's mouth is a SHOT, not a pass (seed 111
    // 14:57: Kroos's poked interception routed through the pass path at
    // 163px/s — below even the shot model's 185 floor — and rolled in at
    // 31km/h; owner: "shot lacked power"). If the release ray crosses the
    // mouth within the ball's overrun range from shooting distance, hand it
    // to shootBall for honest pace and bookkeeping. Crosses never enter this
    // path; cutbacks aim away from the line so the ray test skips them.
    if (!lob) {
        double oppGoalX = goalXFor(f.team);
        bool towardOppGoal = f.team == Team::Home ? tdx > 0 : tdx < 0;
        if (towardOppGoal && std::abs(f.x - oppGoalX) < 420.0) {
            double travel = (oppGoalX - f.x) / tdx;
            double crossingY = f.y + tdy * travel;
            if (travel > 0 && travel <= 1.5 && std::abs(crossingY - PITCH_H / 2) < GOAL_W / 2 - 2.0) {
                shootBall(f, nullptr);
                return true;
            }
        }
    }
    auto& b = state.ball;
    b.controllerId = -1;
    placeBallForRelease(f, tdx, tdy);
    // 450ms: long enough to stop instant re-grabs, short enough that a passer
    // whose ball deflected dead nearby reclaims it instead of jogging beside it.
    blockReboundFor(f.id, 450);
    b.lastTouchTeam = f.team;
    b.lastToucherId = f.id; lastRicochetMs = -1e9;   // genuine touch supersedes ricochet restart memory
    driveBall(b, tdx, tdy, tDist, speed);
    b.intendedReceiverId = t.id;
    receiverShieldTargetId = t.id;
    b.z = clamp(b.z, 0.0, HEADER_REACH_Z);   // a first-time pass off an aerial ball leaves from strike height (13:35 volley-snap class)
    b.vz = 0;
    // Loft over a blocker in the lane (watched replay seed 105 0:55: a pass hit
    // low straight into a defender who should have been chipped over). Read the
    // lane with the SAME step-in model the pass SCORER uses (a closing defender
    // reaches further than his static perp) — the flat execution's narrow 35px
    // read saw a stepping-in defender as "clear" and left the ball on the deck.
    double bdx = predX - f.x, bdy = predY - f.y, blenSq = bdx * bdx + bdy * bdy;
    int blockers = 0;
    if (blenSq > 1.0)
        for (auto& o : state.players) {
            if (o.team == f.team || o.role == Role::GK || o.sentOff) continue;
            double al = clamp(((o.x - f.x) * bdx + (o.y - f.y) * bdy) / blenSq, 0.0, 1.0);
            if (al <= 0.15 || al >= 0.85) continue;                 // mid-lane bodies only
            double cx = f.x + al * bdx, cy = f.y + al * bdy;
            double tlx = cx - o.x, tly = cy - o.y, tld = std::hypot(tlx, tly);
            double closing = tld > 1.0 ? (o.vx * tlx + o.vy * tly) / tld : 0.0;
            double eff = PASS_BLOCKER_PERP + clamp(closing / 50.0, 0.0, 1.0) * 13.0;
            if (std::hypot(o.x - cx, o.y - cy) < eff) blockers++;
        }
    // Round-47 (seed-1110 audit: every pass over 24m was lofted, ~94 a match of them
    // square or backward down an empty lane): height was decided on distance alone.
    // A long ball that gains ground, a through ball, or one with a body in the lane
    // goes in the air; a switch or recycle along an empty lane stays on the turf.
    const double execFwdGain = (predX - f.x) * fdFor(f.team);
    const bool loftWorthy = throughBall || blockers > 0 || execFwdGain > LOFT_MIN_FORWARD_GAIN;
    if (rawDist > 240 && loftWorthy) b.vz = speed * 0.55;
    // CHIP over a blocker in the lane onto the receiver. Only for a NORMAL pass:
    // a THROUGH ball is aimed well BEYOND the receiver (predX leads his run), so
    // the land-on-target arc computed from that far aim point over-lofts into a
    // moonball (watched replay 2:55: a led ball reached z=314). Through balls keep
    // the driven loft above; the chip is the fix for the flat ball into a marker.
    // Chip DIET (loft audit: 29% of 8.5-15m passes were lofted vs real <2%,
    // 21 chips/match pinned at the apex cap — the "90% of lofts look wrong"
    // class): floor raised 85 -> 115 so the mundane short ball stays on the
    // deck, and the chip may be DRIVEN faster than the soft base pass speed so
    // it reads as a clipped dink (0.6-0.7s) rather than a floaty ~1s lob.
    if (blockers > 0 && rawDist > 115 && !throughBall) {
        if (rawDist < 260.0) {
            // chipSpeed <= 1.55*d keeps the land-on-target vz clearing
            // AERIAL_HEIGHT 20; the 240 floor on the cap lets a short chip be
            // struck with real pace instead of inheriting the soft pass speed.
            double chipSpeed = clamp(tDist * 1.55, 120.0, std::max(speed, 240.0));
            driveBall(b, tdx, tdy, tDist, chipSpeed);
            double flight = tDist / std::max(chipSpeed, 1.0);
            b.vz = std::max(b.vz, std::min(apexDipVz(flight, 1.0), 200.0));  // apex <= 40 — a dink, never a lob
        } else {
            b.vz = std::max(b.vz, speed * 0.70);   // a long blocked ball keeps the driven loft
        }
    }
    // Cleared heads is enough: vz >= speed turned every 350px+ ball into a
    // hanging mortar whose flight time invited the arrival contest (0:26.4).
    if (rawDist > 350 && loftWorthy) b.vz = std::max(b.vz, speed * 0.72);
    const auto* audit = selectionAudit;
    double goalX = goalXFor(f.team);
    bool fromWide = std::abs(f.y - PITCH_H / 2) > 130;
    bool intoBox = std::abs(predX - goalX) < 270 && std::abs(predY - PITCH_H / 2) < 190;
    bool selectedCross = audit && audit->purpose == ActionPurpose::Cross && fromWide && (f.role == Role::WM || f.role == Role::FB) && !throughBall;
    bool selectedCutback = audit && audit->purpose == ActionPurpose::Cutback; // render-hint + first-time-finish arm (engine_ball_contest.cpp)
    bool whippedCross = fromWide && intoBox && (f.role == Role::WM || f.role == Role::FB) && !throughBall && (!audit || (audit->purpose != ActionPurpose::Cutback && audit->purpose != ActionPurpose::Through && audit->purpose != ActionPurpose::Cross));
    // Only deliberate (selected) crosses count as crosses — counting every
    // incidental lofted wide ball reported ~350 "crosses" per match.
    if (selectedCross) {
        stats.recordCrossAttempt(f.team == Team::Home);
        stats.recordOpenPlayCross();
    }
    if (selectedCutback) stats.recordCutbackAttempt();
    if (selectedCross) {
        // Lead the runner goalward and slightly central instead of to feet —
        // headed chances need the ball met closer to goal, but a fixed box-zone
        // aim just found the retreated defenders (18% completion, all cleared).
        // Small lead only — the whip itself supplies the attacking momentum;
        // a 34-70px lead had the ball arriving before the runner ever could.
        double ax = predX + fd * (10.0 + rng.random() * 24.0);
        ax = fd > 0.0 ? std::min(ax, goalX - 60.0) : std::max(ax, goalX + 60.0);
        double ay = lerp(predY, PITCH_H / 2.0, 0.25);
        double adx = ax - f.x + (rng.random() - 0.5) * inacc, ady = ay - f.y + (rng.random() - 0.5) * inacc;
        double aDist = std::max(1.0, std::hypot(adx, ady));
        // A cross is a driven delivery, not a pass with a multiplier — the
        // pass formula tops out ~220px/s, a floaty lob. Drive it near shot
        // speed and let applyWhipDelivery supply the dip and the bend.
        double aSpeed = clamp(CROSS_DRIVE_SPEED_BASE + aDist * CROSS_DRIVE_SPEED_PER_PX,
                              CROSS_DRIVE_SPEED_MIN, CROSS_DRIVE_SPEED_MAX) *
                        (0.95 + rng.random() * 0.12);
        // Nothing kicked should leave the boot faster than the hardest shot
        // (~38 m/s). A "cross" aimed OUTSIDE the box (intoBox false) is really a
        // wide diagonal / switch — cap it lower (~34 m/s); those over-hit
        // switches were wasted, so slowing them lets teammates RETAIN wide
        // possession (the +1.6-goal effect, paired). A genuine box delivery
        // stays DRIVEN but is capped at the hardest-shot ceiling (~38 m/s) so it
        // no longer launches at the measured 44-56 m/s.
        aSpeed = std::min(aSpeed, intoBox ? 300.0 : 270.0);   // 108 / 97 km/h — real driven-cross band
        driveBall(b, adx, ady, aDist, aSpeed);
        // Low driven cross vs whipped loft. A runner attacking the near post or
        // the 6-yard box gets the ball SKIDDED low and hard across the face —
        // too quick for the keeper to claim, a tap-in if it's met. The runner
        // now sweeps it FIRST-TIME (see the first-time-finish branch in
        // checkBallPlayerCollision), so it's driven hard — no longer throttled
        // to stay trappable. Deeper / far-post / aerial targets keep the
        // whipped, dipping loft.
        double tgdCross = std::abs(predX - goalX);
        bool lowDriven = tgdCross < 112.0 && std::abs(predY - PITCH_H / 2.0) < 120.0;
        if (lowDriven) {
            double lowSpeed = clamp(aDist * 0.90, 205.0, 265.0);  // 74-95 km/h low-driven band
            driveBall(b, adx, ady, aDist, lowSpeed);
            b.z = 0;
            b.vz = std::min(lowSpeed * 0.12, 24.0);
            double cz = adx * (PITCH_H / 2.0 - f.y) - ady * (goalX - f.x);
            b.curl = signedCurl(cz, CROSS_CURL_MIN * 0.6);
        } else {
            applyWhipDelivery(aDist, aSpeed, goalX, CROSS_CURL_MIN, CROSS_CURL_RANGE, &f);
        }
    }
    if (whippedCross) {
        // Incidental lofted wide balls keep a lofted arc (they're just passes)
        // with mild curl. The old vz = 2x horizontal launched SHORT ones as
        // 60°+ mortars (watched replay seed 111 0:20: horizontal 119, vz 238,
        // apex 7.6m over ~13m of travel). A whip is a FLAT fast arc: solve vz
        // from the flight time to the target so the ball dips ON the receiver
        // (same construction as the FK dipper), never steeper than ~50°.
        scaleBallSpeed(b, 1.30);
        double whipH = std::hypot(b.vx, b.vy);
        double whipT = whipH > 1.0 ? dist(b.x, b.y, t.x, t.y) / whipH : 0.5;
        b.vz = clamp(apexDipVz(whipT, 0.90), 80.0, std::min(235.0, whipH * 1.2));
        double crossz = b.vx * (PITCH_H / 2.0 - b.y) - b.vy * (goalX - b.x);
        b.curl = signedCurl(crossz, 0.18 + rng.random() * 0.12);
    }
    // Pivot the passer's body onto the ball's launch line for a CROSS or any
    // lofted delivery. A player swinging a ball across his body kicks THROUGH
    // it — he doesn't release it facing the other way (watched replay seed 105
    // Messi goal: the crosser whipped it in while rendered facing back infield,
    // because his body still pointed at the ball he'd been shielding below him).
    // Scoped to crosses/lofted balls: that is where the wide swing makes the
    // stale windup-facing look wrong, and it keeps the pivot off the hundreds of
    // flat to-feet passes (an all-pass pivot fed pass-scoring's facing term and
    // reshuffled the game harder than the render fix warranted). Physics lerps
    // facing back toward his run over the following ticks.
    // No pass is a mortar: cap climb at ~50° of the horizontal pace. Every
    // legitimate lofted pass (chips, whips, clears) lives inside this; only
    // the broken short-loft corner cases exceeded it and they read as absurd.
    capSteepness(b, 1.2);
    if (std::hypot(b.vx, b.vy) > 1.0) {
        double launchAng = std::atan2(b.vy, b.vx);
        double offF = std::abs(std::atan2(std::sin(launchAng - f.facing), std::cos(launchAng - f.facing)));
        // Tripwire (seed 133 0:04/0:56 no-look bombs): selection now vetoes
        // passes >140° off facing — one resolving anyway means a forced path
        // (layoff/panic) is leaking blind launches.
        if (offF > 2.6 && !setPiece.armed) stats.recordQualityFlag(QualityFlag::BlindPass);
        // Pivot onto the launch line for crosses/lofted balls AND any pass
        // played meaningfully across the body (>~57°) — the passer turns as he
        // strikes, physics lerps facing back toward his run afterwards. Flat
        // to-feet passes near the facing line keep the stale-facing exemption.
        if (selectedCross || whippedCross || b.vz > 40.0 || offF > 1.0)
            f.facing = launchAng;
    }
    if (audit) {
        bool riskyFlag = audit->blockers > 0 || audit->receiverPressure > 0 || audit->expectedCompletion < 0.58;
        stats.recordPassSelection(audit->distance, audit->expectedCompletion, audit->blockers, audit->receiverPressure, riskyFlag, audit->saferOptionTargetId);
    }
    if (throughBall || selectedCross) { lastRiskyBallMs = state.clockMs; lastRiskyBallToucher = f.id; }
    lastDeliberateKickMs = state.clockMs;
    lastDeliberateKickToucher = f.id;
    beginTrackedPass(f, t, selectedCross, throughBall, selectedCutback);
    if (audit) {
        pendingPass.auComp = audit->expectedCompletion;
        pendingPass.auBlk = audit->blockers;
        pendingPass.auPress = (int) audit->receiverPressure;
        pendingPass.auFwd = audit->forwardProgress;
        pendingPass.auSafer = audit->saferOptionCompletion;
        pendingPass.auSaferId = audit->saferOptionTargetId;
    }
    return true;
}

// ── Pass grading (round-29, owner 0:18) ── one grader for every forced-release
// exit path. The watchdog releases (stationary-hold, marathon, circling, freeze,
// stuck) each picked a receiver by their own ad-hoc "safest man" formula — the
// circling release had NO lane check at all and forced a ball the pass scorer
// had graded −0.89 that same tick (interceptor 24px off the lane; census: ~36
// sub-0.2-grade passes/90 vs owner tolerance ~1/100min). Rubric:
//   grade = pComplete*(0.55 + 0.45*threat) − (1−pComplete)*0.35*turnoverDanger
// pComplete distills the scorer's lane machinery (blocker perp with the step-in
// closing extension, graded mid-lane risk, receiver pressure, length); threat is
// normalized forward gain; turnoverDanger scales with how close to OUR goal the
// ball dies if cut. tools/pass_grade.py mirrors this rubric for trace audits —
// keep them in sync.
double GameEngine::gradePass(const Player& f, const Player& t, double* pCompleteOut) const {
    double dx = t.x - f.x, dy = t.y - f.y;
    double d = std::hypot(dx, dy);
    if (d < 1.0 || t.sentOff) return -1.0;
    double ls = d * d;
    int bl = 0, blClosing = 0, recvPress = 0;
    double laneRisk = 0.0;
    for (auto& o : state.players) {
        if (o.team == f.team || o.role == Role::GK || o.sentOff) continue;
        if (dist(o.x, o.y, t.x, t.y) < PASS_RECEIVER_PRESS_MAX) recvPress++;
        double t2 = clamp(((o.x - f.x) * dx + (o.y - f.y) * dy) / ls, 0.0, 1.0);
        if (t2 * d < 40.0 && dist(o.x, o.y, f.x, f.y) < 42.0) continue;   // on-boot presser blocks every lane equally
        double cx = f.x + t2 * dx, cy = f.y + t2 * dy;
        double perp = dist(o.x, o.y, cx, cy);
        double tlx = cx - o.x, tly = cy - o.y, tld = std::hypot(tlx, tly);
        double closing = tld > 1.0 ? (o.vx * tlx + o.vy * tly) / tld : 0.0;
        double effBlocker = PASS_BLOCKER_PERP + clamp(closing / 50.0, 0.0, 1.0) * 13.0;
        if (perp < effBlocker) {
            bl++;
            if (closing > 25.0) blClosing++;
        } else if (perp < 112.0 && t2 > 0.10 && t2 < 0.92) {
            laneRisk += clamp((112.0 - perp) / 76.0, 0.0, 1.0);
        }
    }
    double pComplete = clamp(0.92 - d / PASS_DIST_NORMALIZATION * 0.28
                                  - bl * 0.23 - blClosing * 0.10
                                  - std::min(laneRisk, 2.2) * 0.10
                                  - recvPress * 0.15,
                             0.05, 0.97);
    if (pCompleteOut) *pCompleteOut = pComplete;
    double fp = pitch::forwardGain(f.x, t.x, f.team);
    double threat = clamp((fp + 60.0) / 300.0, 0.0, 1.0);
    double turnoverDanger = clamp(1.25 - pitch::distToOwnGoal(t.x, f.team) / (PITCH_W * 0.8), 0.35, 1.10);
    return pComplete * (0.55 + 0.45 * threat) - (1.0 - pComplete) * 0.35 * turnoverDanger;
}

// SAFEST receiver clearing the grade floor for a forced release, or nullptr
// when nobody does — the caller then CLEARS to space instead of gifting an
// interception. Ranked by pComplete, gated by grade: a watchdog bail-out is a
// safety ball, not a line-breaker (ranking by grade let the threat term turn
// every forced release into an attacking pass and pushed goals out of noise).
Player* GameEngine::bestGradedReceiver(const Player& f, double maxDist, double floor, double* gradeOut) {
    Player* best = nullptr;
    double bestP = -1e9, bestG = -1.0;
    for (auto& o : state.players) {
        if (o.team != f.team || o.id == f.id || o.role == Role::GK || o.sentOff) continue;
        double d = dist(f.x, f.y, o.x, o.y);
        if (d < 30.0 || d > maxDist) continue;
        double pc = 0.0;
        double g = gradePass(f, o, &pc);
        if (g < floor) continue;
        if (pc > bestP) { bestP = pc; bestG = g; best = &o; }
    }
    if (gradeOut) *gradeOut = bestG;
    return best;
}

// Forced-release fallback when no receiver clears the grade floor: hoof toward
// the most open forward-ish direction. A throw-in conceded ≫ a gifted
// interception (owner 0:18). Deterministic — direction from geometry only.
void GameEngine::hoofClearToSpace(Player& f) {
    double fd = fdFor(f.team);
    double bestAng = 0.0, bestOpen = -1e9;
    for (int i = -2; i <= 2; i++) {
        double ang = i * 0.55;                        // fan of forward directions
        double ux = fd * std::cos(ang), uy = std::sin(ang);
        double px = f.x + ux * 220.0, py = f.y + uy * 220.0;
        double open = 1e9;
        for (auto& o : state.players) {
            if (o.team == f.team || o.role == Role::GK || o.sentOff) continue;
            open = std::min(open, dist(o.x, o.y, px, py));
        }
        // keep the hoof aimed inside the pitch when possible
        if (py < 20.0 || py > PITCH_H - 20.0) open -= 120.0;
        if (open > bestOpen) { bestOpen = open; bestAng = ang; }
    }
    auto& b = state.ball;
    double ux = fd * std::cos(bestAng), uy = std::sin(bestAng);
    placeBallForRelease(f, ux, uy);
    b.controllerId = -1;
    b.intendedReceiverId = -1;
    receiverShieldTargetId = -1;
    pendingPass.active = false;
    driveBall(b, ux, uy, 1.0, 300.0);
    b.vz = 90.0;
    b.z = 0.0;
    b.lastTouchTeam = f.team;
    b.lastToucherId = f.id;
    lastRicochetMs = -1e9;
    blockReboundFor(f.id, 600);
    stats.recordClearance();
    emitEvent("clearance", f.x, f.y, f.id);
    recordBallImpulse();
}

void GameEngine::forcePassTo(Player& f, Player& t, const PassSelectionAudit* audit) {
    double dx = t.x - f.x, dy = t.y - f.y, rawDist = std::hypot(dx, dy);
    if (rawDist < 1) return;
    // Kicked-clearance behind: the slice/hook-out-for-a-corner sub-case is ONLY for the
    // desperate Clear-purpose path (agent.cpp — the sole caller that passes an audit).
    // The engine-internal outlet releases (stationary-hold, moving-marathon, freeze and
    // stuck-carrier recovery) also route through forcePassTo but are CALM passes — before
    // this gate they had an 18% chance of silently becoming a conceded corner whenever the
    // carrier stood within 165px of his own goal line (a phantom corner from nothing).
    // Gated low + in-box only (genuinely last-ditch).
    if (audit) {
        double clrLine = ownGoalXFor(f.team);
        if (std::abs(f.x - clrLine) < PENALTY_AREA_W && rng.random() < 0.08) {
            // (0.18 -> 0.08: the panic-clearance diet grew this session, and
            // 18% of every deep hoof flying backward off the boot became a
            // shank factory — corners more than halved once they were real.)
            // Sliced! Send the REAL ball shanking toward the byline and let
            // out-of-bounds detection award the corner when it actually
            // crosses. The old code armed the corner silently and returned —
            // the physical ball kept rolling INFIELD, then teleported to the
            // flag (watched replay 0:14: a phantom corner from a clearance
            // that visibly ran upfield).
            auto& sb = state.ball;
            double fdc = fdFor(f.team);
            double sliceSide = f.y < PITCH_H / 2.0 ? -1.0 : 1.0; // shank toward the nearer corner
            // Direction depends on WHERE the scuff happens. Right on the goal
            // line (<70px) a slice going behind for a corner is football; from
            // 10-16m out it read as a player deliberately kicking it out of
            // his own end (watched replay seed 133: BOTH 0:25 and 0:48 were
            // this branch — one rolled over the byline from x=924, one from a
            // deep-corner clear at 133px out — "player kicks it out... never
            // do this fuckup again"). Away from the line, the scuff now shanks
            // toward the TOUCHLINE (a throw-in, the way a real shank usually
            // dies) with only residual backward lean.
            double distToLine = std::abs(f.x - clrLine);
            double svx, svy;
            if (distToLine < 70.0) {
                svx = -fdc * (130.0 + rng.random() * 80.0);         // toward OWN byline: honest corner
                svy = sliceSide * (70.0 + rng.random() * 90.0);
            } else {
                svx = -fdc * (20.0 + rng.random() * 50.0);          // slight backward lean only
                svy = sliceSide * (150.0 + rng.random() * 80.0);    // out over the touchline
            }
            // An honest slice behind must NEVER scuff into our own net (seed
            // 103 guard trip: a central clearer's slice crossed the line
            // inside the post — an own goal recorded as an unknown loose
            // ball). If the scuff ray crosses the mouth, re-aim it just
            // outside the near post; the corner is still conceded honestly.
            if (svx * -fdc > 1.0) {
                double travel = (clrLine - f.x) / svx;
                if (travel > 0.0) {
                    double crossY = f.y + svy * travel;
                    double half = GOAL_W / 2.0 + BALL_R + 10.0;
                    if (std::abs(crossY - PITCH_H / 2.0) < half) {
                        double want = PITCH_H / 2.0 + sliceSide * (half + 26.0);
                        svy = (want - f.y) / travel;
                    }
                }
            }
            sb.controllerId = -1;
            placeBallForRelease(f, svx, svy);
            sb.lastTouchTeam = f.team;
            sb.lastToucherId = f.id; lastRicochetMs = -1e9;   // genuine touch supersedes ricochet restart memory
            sb.vx = svx;
            sb.vy = svy;
            sb.z = 4.0;
            sb.vz = 90.0 + rng.random() * 70.0; // scuffed up and spinning
            sb.intendedReceiverId = -1;
            lastDeliberateKickMs = state.clockMs;
            lastDeliberateKickToucher = f.id;
            blockReboundFor(f.id, 700);
            return;
        }
    }
    double tdx = dx + (rng.random() - 0.5) * rawDist * 0.2;
    double tdy = dy + (rng.random() - 0.5) * rawDist * 0.2;
    double tDist = std::hypot(tdx, tdy);
    double ownGoalX = ownGoalXFor(f.team);
    bool towardOwnGoal = f.team == Team::Home ? tdx < 0 : tdx > 0;
    if (towardOwnGoal) {
        double travel = (ownGoalX - f.x) / tdx;
        double crossingY = f.y + tdy * travel;
        if (travel > 0 && travel <= 1.0 && std::abs(crossingY - PITCH_H / 2) < GOAL_W / 2 + BALL_R + 14.0) {
            tdy += (crossingY < PITCH_H / 2 ? -1.0 : 1.0) * (GOAL_W / 2 + BALL_R + 24.0);
            tDist = std::hypot(tdx, tdy);
        }
    }
    double speed = PASS_SPEED_BASE + 35 + rawDist * (PASS_SPEED_DIST + 0.05);
    // ── Genuine BOX HOOF ── a real panic clearance (audit != null) from
    // inside/near his own area is BOOTED long and high UP THE CHANNEL toward
    // the target man — not a measured ~180px/s pass that a defender in the
    // lane nicks at his feet (watched replay seed 994 2:15: a full-back's
    // "clearance" travelled 55px straight to Ronaldo for a tap-in). Extend the
    // launch to a real clearance distance and loft it over the immediate
    // presser. Only the panic path (agent.cpp passes an audit); calm engine-
    // internal outlets keep the measured pass.
    // Also hoof a SWARMED clear from the wider defensive quarter (audited: the
    // De Bruyne-goal buildup was seven "clearances" launched 3-9m OUTSIDE the
    // box gate, each a measured flat pass nicked within 1-4m; seed 133 1:41 the
    // same — a pressed defender 13px outside the gate hit a flat ball into the
    // interceptor when the target needed elevation). Presser within 45px + own
    // defensive quarter → the already-tuned hoof treatment (loft over him,
    // scatter, real distance) instead of the flat measured ball.
    double pressOnClear = 1e9;
    // Round-26: the radial 45px check missed chargedown pressers who sit 2-35px
    // OUTSIDE the band but directly ON the kick line (~10/28 flat clears in the
    // audit were charged down within 800ms — a presser <15px perpendicular to
    // the release ray, within ~90px along it). Project each opponent onto the
    // kick line and loft the clear over him too, regardless of the radial check.
    bool presserOnKickLine = false;
    if (audit) {
        double kl = std::hypot(tdx, tdy);
        double kux = kl > 1.0 ? tdx / kl : fdFor(f.team), kuy = kl > 1.0 ? tdy / kl : 0.0;
        for (auto& o : state.players) {
            if (!isActiveOpponent(o, f.team)) continue;
            pressOnClear = std::min(pressOnClear, dist(o.x, o.y, f.x, f.y));
            double along = (o.x - f.x) * kux + (o.y - f.y) * kuy;
            double perp = std::hypot(o.x - f.x - along * kux, o.y - f.y - along * kuy);
            if (along > 2.0 && along < 90.0 && perp < 15.0) presserOnKickLine = true;
        }
    }
    bool swarmedClear = audit && std::abs(f.x - ownGoalX) < PENALTY_AREA_W * 1.7
                        && (pressOnClear < 45.0 || presserOnKickLine);
    bool boxHoof = (audit && std::abs(f.x - ownGoalX) < PENALTY_AREA_W) || swarmedClear;
    if (boxHoof) {
        // Clear the DANGER — boot it out to around midfield, not a pinpoint
        // ball onto the target man's boot in the final third. A desperate boot
        // is scrappy: reach ~the middle third and scatter it wide so it lands
        // as a genuine 50/50 in a neutral area (a longer, pinpoint hoof lifted
        // goals to ~4.1/90 by gifting the CF a clear-cut finish — the clearance
        // is meant to end the threat, not start a counter on a plate).
        double minReach = 360.0;
        if (tDist < minReach) { tdx = tdx / tDist * minReach; tdy = tdy / tDist * minReach; tDist = minReach; }
        double sc = (rng.random() - 0.5) * 200.0;
        double perpx = -tdy / tDist, perpy = tdx / tDist;
        tdx += perpx * sc; tdy += perpy * sc; tDist = std::hypot(tdx, tdy);
        // Don't LAUNCH it out of play at full hoof pace (owner, seed 13 1:02: a
        // first-touch box-hoof exited at ~290px/s into touch by the corner —
        // "ball just flew out at unrealistic speeds, absolutely bizarre"). The
        // +-200px scatter takes NO account of where the lines are, so a wide
        // box hoof could be aimed at row Z. Clamp the aim point inside the
        // pitch margin and scale the boot to the room that remains — a hoof
        // that stays in play is a clearance; one aimed out is a shank.
        double aimX = clamp(f.x + tdx, 25.0, PITCH_W - 25.0);
        double aimY = clamp(f.y + tdy, 45.0, PITCH_H - 45.0);
        tdx = aimX - f.x; tdy = aimY - f.y; tDist = std::hypot(tdx, tdy);
        speed = std::max(speed, 320.0);   // real hoof pace, clears the danger zone
        speed = std::min(speed, std::max(200.0, tDist * 0.85));
    }
    // Body mechanics (post-tackle audit: all 5 complaint-class releases were
    // THIS path — a 320px/s hoof 267ms after a tackle win, up to 173 degrees
    // off facing, body never turning). A clear struck against the body's
    // orientation right after winning a duel is a SHANK, not a laser: scale
    // power down with the off-facing angle when possession is fresh (<600ms),
    // and always square the body onto the release line like passBallTo does.
    double shankMul = 1.0;
    {
        double wantAng = std::atan2(tdy, tdx);
        // Measure "across the body" against the facing AT POSSESSION-GAIN, not
        // the live facing — the body rotates freely during even a 400ms hold,
        // so by release the live facing already reads square and the shank
        // never fired (seed 111 2:05: pid19's 43.6m first-time cross-field
        // clear, struck 400ms after a tackle win at full pace, dead straight).
        double refFacing = carrierTracker.carryTrackerId == f.id
            ? carrierTracker.carryStartFacing : f.facing;
        double offF = std::abs(std::atan2(std::sin(wantAng - refFacing), std::cos(wantAng - refFacing)));
        double heldMs = state.clockMs - carrierTracker.carryStartMs;
        if (carrierTracker.carryTrackerId == f.id && heldMs < 600.0 && offF > 0.6)
            shankMul = clamp(1.0 - (offF - 0.6) * 0.30, 0.55, 1.0);
        speed *= shankMul;
        f.facing = wantAng;
    }
    auto& b = state.ball;
    b.controllerId = -1;
    placeBallForRelease(f, tdx, tdy);
    blockReboundFor(f.id, 900);
    b.lastTouchTeam = f.team;
    b.lastToucherId = f.id; lastRicochetMs = -1e9;   // genuine touch supersedes ricochet restart memory
    driveBall(b, tdx, tdy, tDist, speed);
    b.intendedReceiverId = t.id;
    receiverShieldTargetId = t.id;
    b.z = 0;
    // The vz floor must shank WITH the horizontal power (seed 173 1:03: the
    // off-facing scaler cut horizontal to ~176 while the floor stayed 200 —
    // a 49-degree mortar that "zapped up like crazy out of nowhere"). A
    // shanked hoof is a scuff in EVERY axis.
    b.vz = boxHoof ? std::max(speed * 0.62, 200.0 * shankMul) : speed * 0.40;   // high, up and over the presser
    // Round-47 (audit: 34% of clearances travelled under 12m): at speed*0.40 a
    // ~320px/s flat clear never reaches head height at all (vz 128 against gravity
    // 500 tops out at z 16 < AERIAL_HEIGHT 20), so the first body on the line took
    // it. A clearance clears heads.
    b.vz = std::max(b.vz, CLEAR_MIN_VZ * shankMul);
    // Round-26: audit != nullptr uniquely identifies the ActionPurpose::Clear
    // path (agent.cpp is the only caller that passes an audit; the engine-internal
    // calm outlets pass nullptr). Flag it so the completion ledger skips it —
    // scopes to ALL clear releases (boxHoof/scatter AND slower flat clears), not
    // just the in-box slice branch.
    beginTrackedPass(f, t, /*isCross=*/false, /*isThrough=*/false, /*isCutback=*/false, /*isClear=*/audit != nullptr);
    // Round-27 COMMIT 9a (observability, trace-only): a forcePassTo with a NULL
    // audit is an engine-internal DELIBERATE outlet to a teammate (stuck-carrier
    // watchdog, calm relief) — it set intendedReceiver but emitted NO event, so
    // ~9% of deliberate passes (M5: 4R->3R 14:39.6) were invisible to event
    // tooling. Emit the missing `pass` as traceOnly (the agent Clear path, audit
    // != nullptr, emits its own clearance; skip it here to avoid a double label).
    // traceOnly => zero gameplay/RNG/golden-hash effect; new trace line only.
    if (audit == nullptr && t.team == f.team)
        emitEvent("pass", f.x, f.y, f.id, t.id, /*traceOnly=*/true);
}
