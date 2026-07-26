#include "engine.h"
#include "agent.h"
#include "agent_helpers.h"

// ══════════════════════════════════════════════════════════════════════════════
// resolveChoice() pipeline helpers
//
// Each method returns nullptr when it has no override (caller continues to the
// next phase), or a pointer to the chosen action.  Pointers point into the
// caller's sorted action vector `a`.
// ══════════════════════════════════════════════════════════════════════════════

// ── Fresh ball collection overrides ──────────────────────────────────────────
// After collecting a through-ball, the player gets a brief window where shooting
// or driving forward is heavily favoured. (Round-31: the parallel cross branch is
// gone — see the tombstone at the bottom of tryFreshBallOverride.)

Action* PlayerAI::tryFreshBallOverride(SmallVector<Action, 24>& a, Action& best,
                                        bool ic, bool nearGoal) {
    if (ic && player.throughCollected > 0.0) {
        Action* shootOpt = nullptr;
        Action* dribbleOpt = nullptr;
        for (auto& x : a) {
            if (x.type == ActionType::Shoot && x.score >= 0.0) {
                if (!shootOpt || x.score > shootOpt->score) shootOpt = &x;
            } else if (x.type == ActionType::Dribble) {
                if (!dribbleOpt || x.score > dribbleOpt->score) dribbleOpt = &x;
            }
        }
        // An UNPRESSURED collector still 18m+ out snap-shooting is the reason 27
        // completed through balls/match produced almost no close chances — this
        // override's 0.18 tolerance picked the shot regardless of relative
        // scores (nerfing the shot score changed literally nothing). A real 1v1
        // is CARRIED to 8-12m first: far + unpressured now prefers the dribble
        // (the breakaway drive targets ~9m out); the shot stays first choice
        // when close, pressured (recovering CB on his back), or with no carry.
        bool farSnap = shootOpt && shootOpt->audit.distance > 180.0
            && shootOpt->audit.pressureCount == 0;
        if (shootOpt && !farSnap && shootOpt->score > best.score - 0.18
            && shootOpt->audit.distance < 245.0)
            return shootOpt;
        if (dribbleOpt && (nearGoal || farSnap) && dribbleOpt->score > best.score - 0.14)
            return dribbleOpt;
        if (shootOpt && shootOpt->score > best.score - 0.18
            && shootOpt->audit.distance < 245.0)
            return shootOpt;   // no viable carry — take the shot anyway
    }
    // TOMBSTONE (Round-31): a "fresh-cross volley" override used to sit here,
    // gated on `player.crossCollected > 0.0`. It NEVER EXECUTED — not once, in any
    // recorded match. crossCollected was only ever set one statement before a
    // shootBall() call that cleared it again before returning, so no agent tick
    // could observe it. A past round tuned this branch against a live-watch
    // complaint ("forced first-time shot"), raising its angle gate 5.5deg -> 11deg
    // and tightening the score tolerance 0.32 -> 0.22. That tuning was applied to
    // code that has never run, and therefore cannot have caused the complaint —
    // whatever produced that shot is still out there. Do not re-derive a fix from
    // those numbers. If a cross collector should be biased toward a first-time
    // finish, that is a new, measured behaviour change, not a revived flag.
    return nullptr;
}

// ── Low-score panic fallback ─────────────────────────────────────────────────
// When every evaluated action scores very poorly, try to salvage the situation
// with any pass or dribble that has a non-trivial score.  Returns nullptr if
// nothing viable exists (caller handles the forced dribble / hold).

Action* PlayerAI::tryLowScoreFallback(SmallVector<Action, 24>& a, Action& /*best*/) {
    Action* passOpt = nullptr;
    Action* dribbleOpt = nullptr;
    for (auto& x : a) {
        if (x.type == ActionType::Pass
            && (!passOpt || x.score > passOpt->score))
            passOpt = &x;
        if (x.type == ActionType::Dribble
            && (!dribbleOpt || x.score > dribbleOpt->score))
            dribbleOpt = &x;
    }
    // A desperation pass must still be a PASS, not a hopeful launch: the
    // fallback's pass-first 0.05 bar sent a 476px lofted coin-flip diagonal
    // (comp 0.52, died mid-pitch, picked off — watched replay seed 129 0:26.4,
    // owner: "mindless pass not realistic") over both the dribble and the
    // shield-Hold path one line below it. Keep short balls and honest-risk
    // clears; a long low-completion ball loses to carrying/shielding.
    bool passPlayable = passOpt && passOpt->score > 0.05
        && (passOpt->audit.expectedCompletion >= 0.55
            || passOpt->audit.distance < 260.0
            || passOpt->purpose == ActionPurpose::Clear);
    if (passPlayable && (!dribbleOpt || passOpt->score >= dribbleOpt->score)) return passOpt;
    if (dribbleOpt && dribbleOpt->score > 0.04) return dribbleOpt;
    if (passPlayable) return passOpt;
    return nullptr;
}

// ── Long carry shot window ───────────────────────────────────────────────────
// When the ball carrier has dribbled a significant distance, favour shooting
// or continuing the dribble over recycling possession.

Action* PlayerAI::tryLongCarryOverride(SmallVector<Action, 24>& a, Action& best, bool ic) {
    if (!ic || engine.carrierTracker.carryTrackerId != player.id) return nullptr;

    double carryDistance = engine.carrierTracker.carryPathDistance;
    double progress = pitch::forwardProgress(player.x, player.team);
    bool attackingHalf = progress > PITCH_W * 0.46;
    bool finalThirdCarry = progress > PITCH_W * 0.62;
    CarrierPressure cp = assessCarrierPressure(engine, player);

    Action* shootOpt = nullptr;
    Action* dribbleOpt = nullptr;
    Action* passOpt = nullptr;
    Action* attackingOutlet = nullptr;
    for (auto& x : a) {
        if (x.type == ActionType::Shoot && x.score >= 0.0) {
            if (!shootOpt || x.score > shootOpt->score) shootOpt = &x;
        } else if (x.type == ActionType::Dribble) {
            if (!dribbleOpt || x.score > dribbleOpt->score) dribbleOpt = &x;
        } else if (x.type == ActionType::Pass) {
            if (!passOpt || x.score > passOpt->score) passOpt = &x;
            bool frontLineOutlet = x.target
                && (x.target->role == Role::WM || x.target->role == Role::CF)
                && x.audit.expectedCompletion > 0.68
                && x.audit.blockers <= 1
                && x.audit.receiverPressure <= 1
                && x.audit.forwardProgress > 8.0;
            if (frontLineOutlet && (!attackingOutlet || x.score > attackingOutlet->score))
                attackingOutlet = &x;
        }
    }

    if (carryDistance >= 45.0 && attackingOutlet && dribbleOpt) {
        double releaseMargin = finalThirdCarry ? 0.12 : 0.04;
        if (attackingOutlet->score > dribbleOpt->score - releaseMargin)
            return attackingOutlet;
    }

    // Long carry → take the shot if angle is decent
    // Round-23 (arena reaudit): a 205px+ carry could fire the shot out to 255px,
    // so every arena duel ended in a 20-26m launch — zero shots inside the box.
    // In the arena, hold the long-carry trigger until the carry is genuinely into
    // shooting range (~125px), so the won duel is driven into the box first. 11v11
    // approach play (where a supporting shape rewards the earlier release) keeps
    // the 255px trigger.
    double longCarryShotMax = engine.arenaMode ? 125.0 : 255.0;
    if (carryDistance >= 205.0 && shootOpt
        && shootOpt->audit.distance < longCarryShotMax
        && shootOpt->audit.angleDeg > SHOT_ANGLE_ACUTE_THRESH
        && shootOpt->score > best.score - 0.22) {
        return shootOpt;
    }

    // Medium carry → keep dribbling unless pass/shot is clearly superior
    if (carryDistance >= 80.0 && dribbleOpt && attackingHalf && cp.score < 1.05) {
        bool passClearlyBetter = passOpt
            && passOpt->score > dribbleOpt->score + (finalThirdCarry ? 0.38 : 0.30)
            && passOpt->audit.forwardProgress > 30.0;
        bool shotClearlyBetter = shootOpt
            && shootOpt->score > dribbleOpt->score + 0.28;
        bool needsCarryShotWindow = carryDistance < 210.0;
        if (!passClearlyBetter && !shotClearlyBetter
            && dribbleOpt->score > best.score - (needsCarryShotWindow ? 0.40 : 0.32)) {
            return dribbleOpt;
        }
    }
    return nullptr;
}

// ── Press-slot management ────────────────────────────────────────────────────
// At most two defenders may chase / press at any time.  This helper claims a
// slot when the chosen action is Chase, Position (close-down), or Tackle, and
// redirects to a fallback action when both slots are already taken.

Action* PlayerAI::managePressSlots(SmallVector<Action, 24>& a, Action& best,
                                    TeamBlackboard& bb) {
    static Action holdFallback{ActionType::Hold, 1.0};

    // Chase slot
    if (best.type == ActionType::Chase && engine.state.ball.controllerId < 0) {
        // A loose ball within touching distance is yours to take — slot
        // bookkeeping (claimed first-come by farther teammates) was vetoing
        // the best-placed chaser standing 10px from a rolling pass.
        double looseBallDist = dist(player.x, player.y, engine.state.ball.x, engine.state.ball.y);
        // The guaranteed DEAD-BALL recovery (agent_defend: nearest eligible man
        // to a stationary ball, score 1.60, "must WIN arbitration") was losing
        // this slot check to two teammates 260-300px away who claimed the slots
        // first — the nearest man to a dead ball walked away and the ball sat.
        // The arbitration winner for a dead ball is never slot-vetoed.
        double slotBallSpeed = std::hypot(engine.state.ball.vx, engine.state.ball.vy);
        bool priorityChaser = engine.state.ball.intendedReceiverId == player.id
                           || engine.isActiveKnockAheadRunner(player.id)
                           || looseBallDist < 30.0
                           || (slotBallSpeed < 15.0 && best.purpose == ActionPurpose::RecoverLoose
                               && best.score >= 1.5)
                           || (engine.lastLooseOrigin == LooseOrigin::GoalkeeperParry && looseBallDist < 230.0);
        auto ps = checkPressSlots(bb, player.id, engine.pressSlotCap());
        if (!priorityChaser && !ps.isSelf && !ps.slot1Free && !ps.slot2Free) {
            for (auto& x : a)
                if (x.type != ActionType::Chase && x.type != ActionType::Tackle
                    && x.score > MIN_FALLBACK_SCORE) return &x;
            return &holdFallback;
        }
        if (!priorityChaser)
            tryClaimPressSlot(bb, player.id, ps.isSelf, ps.slot1Free, ps.slot2Free);
    }

    // Position (close-down) slot
    if (best.type == ActionType::Position) {
        bool reservePressSlot = false;
        auto* task = engine.assignmentFor(player.id);
        if (best.purpose == ActionPurpose::LocalCloseDown
            || best.purpose == ActionPurpose::EmergCloseDown)
            reservePressSlot = true;
        if (best.purpose == ActionPurpose::Task && task
            && (task->role == DefensiveTask::PrimaryPress
             || task->role == DefensiveTask::SecondaryPress
             || task->role == DefensiveTask::CloseDown))
            reservePressSlot = true;

        if (reservePressSlot) {
            auto ps = checkPressSlots(bb, player.id, engine.pressSlotCap());
            // Every close-down (local OR emergency) obeys the 2-man press cap:
            // assignPrimaryPress always names one contester so the carrier is
            // never left unpressed, and the 3rd/4th/5th body that used to swarm
            // in (EmergCloseDown bypassed the cap, producing 6-man piles) is
            // sent back to shape instead.
            if (!ps.isSelf && !ps.slot1Free && !ps.slot2Free) {
                for (auto& x : a) {
                    if (x.type == ActionType::Position
                        && (x.purpose == ActionPurpose::LocalCloseDown
                         || x.purpose == ActionPurpose::EmergCloseDown)) continue;
                    if (x.type != ActionType::Tackle
                        && x.score > MIN_FALLBACK_SCORE) return &x;
                }
                return &holdFallback;
            }
            if (!ps.isSelf)
                tryClaimPressSlot(bb, player.id, ps.isSelf, ps.slot1Free, ps.slot2Free);
        }
    }

    // Tackle slot
    if (best.type == ActionType::Tackle && best.target) {
        auto ps = checkPressSlots(bb, player.id, engine.pressSlotCap());
        if (!ps.isSelf && !ps.slot1Free && !ps.slot2Free) {
            for (auto& x : a)
                if (x.type != ActionType::Tackle
                    && x.score > MIN_FALLBACK_SCORE) return &x;
            return &holdFallback;
        }
        tryClaimPressSlot(bb, player.id, ps.isSelf, ps.slot1Free, ps.slot2Free);
    }

    // Mark conflict — redirect if another teammate already marks this target
    if (best.type == ActionType::Mark && best.target) {
        int markerId = bb.markedOpponents[best.target->id];
        if (markerId >= 0 && markerId != player.id) {
            for (auto& x : a)
                if (x.type != ActionType::Mark && x.type != ActionType::Tackle
                    && x.score > MIN_FALLBACK_SCORE) return &x;
            return &holdFallback;
        }
        bb.markedOpponents[best.target->id] = player.id;
    }

    return nullptr;
}

// ── Backpass audit (logging only, no override) ──────────────────────────────

void PlayerAI::auditBackpass(SmallVector<Action, 24>& a, Action& best, bool ic) {
    if (!ic || best.type != ActionType::Pass || best.audit.forwardProgress >= -40.0)
        return;
    Action* fwdOpt = nullptr;
    for (auto& x : a) {
        if (x.type == ActionType::Pass && x.audit.forwardProgress > 30.0
            && x.score > best.score - 0.15) {
            fwdOpt = &x;
            break;
        }
    }
    if (fwdOpt)
        engine.logQualityFlag(QualityFlag::QuestionableBackpass,
                              player.id, player.role,
                              best.audit.forwardProgress, true,
                              fwdOpt->score, best.score,
                              8000.0, "backpass:" + std::to_string(player.id));
}

// ── Clear path to goal ──────────────────────────────────────────────────────
// If the carrier has an unobstructed corridor to goal with few blockers,
// override with a shot (close range) or a forward dribble.

Action* PlayerAI::tryClearPathOverride(SmallVector<Action, 24>& a, Action& best,
                                        bool ic, double gx) {
    if (!ic) return nullptr;

    double dx = gx - player.x;
    double dy = PITCH_H / 2.0 - player.y;
    double toGoalDist = std::hypot(dx, dy);
    dx /= std::max(toGoalDist, 1.0);
    dy /= std::max(toGoalDist, 1.0);

    double nearestOppDist = 1e9;
    int blockersInPath = 0;
    for (auto& o : engine.state.players) {
        if (!isActiveOpponent(o, player.team)) continue;
        double odx = o.x - player.x, ody = o.y - player.y;
        double od = std::hypot(odx, ody);
        double along = odx * dx + ody * dy;
        double perp = std::abs(odx * dy - ody * dx);
        if (along > 5.0) {
            if (along < toGoalDist && perp < 80.0) blockersInPath++;
            if (od < nearestOppDist) nearestOppDist = od;
        }
    }

    bool clearPath = blockersInPath <= 1 && nearestOppDist > 35.0;
    double distToGoal = std::abs(player.x - gx);
    bool inDangerZone = distToGoal < 500.0;
    if (!clearPath || !inDangerZone) return nullptr;

    // Close enough to shoot
    if (distToGoal < 225.0) {
        Action* shootAct = nullptr;
        for (auto& x : a)
            if (x.type == ActionType::Shoot && x.score > 0.0)
                if (!shootAct || x.score > shootAct->score) shootAct = &x;
        if (shootAct) {
            engine.logQualityFlag(QualityFlag::ClearPathShoot,
                                  player.id, player.role,
                                  distToGoal, shootAct->audit.angleDeg,
                                  shootAct->score, best.type, best.score);
            return shootAct;
        }
    }

    // Drive toward goal
    Action* driveAct = nullptr;
    for (auto& x : a)
        if (x.type == ActionType::Dribble && x.purpose == ActionPurpose::Space)
            if (!driveAct || x.score > driveAct->score) driveAct = &x;
    if (driveAct) {
        engine.logQualityFlag(QualityFlag::ClearPathDrive,
                              player.id, player.role,
                              distToGoal, 0,
                              driveAct->score, best.type, best.score);
        return driveAct;
    }
    return nullptr;
}

// ── Carrier pressure safety pass ─────────────────────────────────────────────
// Under heavy pressure and not an attacker in a shooting position, look for a
// safe recycling pass to avoid losing possession.

Action* PlayerAI::tryPressureSafetyPass(SmallVector<Action, 24>& a, Action& best,
                                         bool ic, bool nearGoal) {
    if (!ic) return nullptr;
    CarrierPressure cp = assessCarrierPressure(engine, player);
    if (cp.score <= 0.85) return nullptr;
    if (isAttackerRole() && nearGoal) return nullptr;

    Action* safePass = nullptr;
    for (auto& x : a) {
        if (x.type != ActionType::Pass || !x.target) continue;
        bool safe = x.audit.expectedCompletion > 0.66
            && x.audit.blockers <= 1
            && x.audit.receiverPressure <= 1
            && x.audit.distance < 300.0;
        if (!safe) continue;
        if (!safePass || x.score > safePass->score) safePass = &x;
    }
    if (safePass && (best.type == ActionType::Shoot || best.type == ActionType::Dribble)
        && safePass->score > best.score - (cp.exposed > 0.35 ? 0.30 : 0.20))
        return safePass;
    return nullptr;
}

// ── Final-third decision overrides ───────────────────────────────────────────
// In the attacking final third, bias toward shooting, driving, and forward
// passes over recycling possession.

Action* PlayerAI::tryFinalThirdOverride(SmallVector<Action, 24>& a, Action& best, bool ic) {
    if (!ic) return nullptr;
    double fd = fdFor(player.team);
    bool finalThird = fd > 0.0
        ? player.x > PITCH_W * 2.0 / 3.0
        : player.x < PITCH_W / 3.0;
    if (!finalThird) return nullptr;

    Action* chancePass = nullptr;
    for (auto& x : a) {
        if (x.type != ActionType::Pass || !x.target) continue;
        double targetGoalDist = std::abs(goalXFor(player.team) - x.target->x);
        bool frontLineTarget = x.target->role == Role::CF || x.target->role == Role::WM;
        bool centralTarget = std::abs(x.target->y - PITCH_H / 2.0) < 190.0;
        bool boxChance = targetGoalDist < 245.0 && centralTarget;
        bool cutbackOrSlip = targetGoalDist < 210.0 && x.audit.forwardProgress > -15.0;
        if ((frontLineTarget || boxChance)
            && (boxChance || cutbackOrSlip)
            && x.audit.expectedCompletion >= 0.58
            && x.audit.blockers <= 1
            && x.audit.receiverPressure <= 1) {
            if (!chancePass || x.score > chancePass->score)
                chancePass = &x;
        }
    }
    if (chancePass
        && (best.type == ActionType::Dribble || best.type == ActionType::Shoot)
        && chancePass->score > best.score - 0.18)
        return chancePass;

    // Long shots look ugly and rarely score. In the final third, use them only
    // when there is no credible way to move the ball into a better chance.
    if (best.type == ActionType::Shoot && best.audit.distance > 235.0) {
        Action* bestBoxPass = nullptr;
        Action* driveOpt = nullptr;
        for (auto& x : a) {
            if (x.type == ActionType::Pass && x.target) {
                double targetGoalDist = std::abs(goalXFor(player.team) - x.target->x);
                bool centralTarget = std::abs(x.target->y - PITCH_H / 2.0) < 185.0;
                bool chancePass = targetGoalDist < 245.0 && centralTarget
                    && x.audit.expectedCompletion >= 0.58
                    && x.audit.blockers <= 1
                    && x.audit.receiverPressure <= 1;
                if (chancePass && (!bestBoxPass || x.score > bestBoxPass->score))
                    bestBoxPass = &x;
            }
            if (x.type == ActionType::Dribble && x.purpose == ActionPurpose::Space)
                if (!driveOpt || x.score > driveOpt->score) driveOpt = &x;
        }
        if (bestBoxPass && bestBoxPass->score > best.score - 0.34)
            return bestBoxPass;
        if (driveOpt && best.audit.distance > 255.0 && driveOpt->score > best.score - 0.22)
            return driveOpt;
    }

    // Prefer front-line pass over shooting (WM/CF in better position)
    if (shouldSearchForPassOverShot() && best.type == ActionType::Shoot) {
        Action* frontLinePass = nullptr;
        for (auto& x : a) {
            if (x.type != ActionType::Pass || !x.target) continue;
            if (x.target->role != Role::CF && x.target->role != Role::WM) continue;
            if (x.audit.expectedCompletion < 0.66 || x.audit.blockers > 1
                || x.audit.receiverPressure > 1) continue;
            double targetGoalDist = std::abs(goalXFor(player.team) - x.target->x);
            if (targetGoalDist > 230.0 && x.audit.forwardProgress < 40.0) continue;
            if (!frontLinePass || x.score > frontLinePass->score) frontLinePass = &x;
        }
        if (frontLinePass && frontLinePass->score > best.score - 0.22)
            return frontLinePass;
    }

    // Attacker: drive forward when pass is stagnant
    if (best.type == ActionType::Pass && best.audit.forwardProgress < 25.0
        && isAttackerRole()) {
        for (auto& x : a)
            if (x.type == ActionType::Dribble && x.purpose == ActionPurpose::Space)
                if (x.score > best.score - 0.22) return &x;
    }

    // Backward pass → prefer shot or drive
    if (best.type == ActionType::Pass && best.audit.forwardProgress < 0.0) {
        Action* driveOpt = nullptr;
        Action* shootOpt = nullptr;
        for (auto& x : a) {
            if (x.type == ActionType::Dribble && x.purpose == ActionPurpose::Space)
                driveOpt = &x;
            if (x.type == ActionType::Shoot) shootOpt = &x;
        }
        if (shootOpt && shootOpt->score > best.score - 0.12) return shootOpt;
        if (driveOpt && driveOpt->score > best.score - 0.16) return driveOpt;
    }

    // Credible shot when best isn't a shot and no tap-in pass available
    if (best.type != ActionType::Shoot) {
        Action* shotOpt = nullptr;
        Action* tapInPass = nullptr;
        for (auto& x : a) {
            if (x.type == ActionType::Shoot && x.score > 0.0) shotOpt = &x;
            if (x.type == ActionType::Pass && x.target) {
                double tGoalDist = std::abs(goalXFor(player.team) - x.target->x);
                if (tGoalDist < 75.0 && x.audit.expectedCompletion > 0.62
                    && x.audit.blockers <= 1)
                    tapInPass = &x;
            }
        }
        if (shotOpt && !tapInPass) {
            double maxDistance = finalThirdShotMaxDistance() + 25.0;
            double minAngle = std::max(6.5, finalThirdShotMinAngle() - 1.5);
            bool credible = shotOpt->audit.distance < maxDistance
                && shotOpt->audit.angleDeg > minAngle
                && shotOpt->audit.pressureCount <= 2;
            if (credible && shotOpt->score > best.score - 0.40) return shotOpt;
        }
    }
    return nullptr;
}

// ── CF near-goal shot bias ───────────────────────────────────────────────────
// Centre-forwards near goal should shoot unless a teammate has a clear tap-in.

Action* PlayerAI::tryNearGoalShotBias(SmallVector<Action, 24>& a, Action& best,
                                       bool ic, bool nearGoal, double gx) {
    if (!ic || !nearGoal || best.type == ActionType::Shoot) return nullptr;
    double margin = nearGoalShotBiasMargin();
    if (margin <= 0.0) return nullptr;

    Action* shotOpt = nullptr;
    Action* passToTapIn = nullptr;
    for (auto& x : a) {
        if (x.type == ActionType::Shoot) shotOpt = &x;
        if (x.type == ActionType::Pass && x.target) {
            double tGoalDist = std::abs(gx - x.target->x);
            if (tGoalDist < 70.0 && x.audit.expectedCompletion > 0.70
                && x.audit.blockers == 0 && x.audit.receiverPressure == 0)
                passToTapIn = &x;
        }
    }
    if (shotOpt && !passToTapIn
        && shotOpt->score > best.score - (margin + 0.06))
        return shotOpt;
    return nullptr;
}
