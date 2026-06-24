#include "engine.h"
#include "agent.h"

SmallVector<Action, 24> PlayerAI::scorePositioning(const Perception& per, const GameContext& ctx) {
    const auto& p = player;
    auto& b = engine.state.ball;
    double fd = fdFor(p.team);
    Team ip = engine.teamInPossession();
    bool my = (per.ballControllerTeam == p.team);
    // DEFENSIVE-SHAPE REDESIGN §8: when my team holds a mid-block, my forwards DROP
    // to the halfway line — OUT of the opponent's build-up zone — instead of pressing
    // high. This is what lets the opponent play out cleanly and string a long
    // possession (more build-up, less constant scrappy pressing). Goals will spike.
    {
        int myIdx = p.team == Team::Home ? 0 : 1;
        if (!my && engine.defenseHoldingShape[myIdx] && (isCenterForward() || isWideMidfielder())) {
            double dropX = clamp(HALF_X + fd * 40.0, 60.0, PITCH_W - 60.0);
            double dropY = clamp(p.homeY, 40.0, PITCH_H - 40.0);
            return { Action{ActionType::Position, 0.95, nullptr, dropX, dropY, ActionPurpose::Observe} };
        }
    }
    double ba = (fd == 1.0) ? b.x / PITCH_W : 1.0 - b.x / PITCH_W;
    // Tactics (centred at the dial's 50 = unchanged behaviour):
    //  midfieldFreedom -> how far central midfielders advance/roam in attack.
    //  overlapFrequency -> how high & wide full-backs bomb on.
    const auto& tac = engine.configFor(p.team);
    double freedom = tac.midfieldFreedom / 50.0;   // 0..2, 1 at dial 50
    double overlap = tac.overlapFrequency / 50.0;
    double cmAdvance = isCentralMidfielder() ? (0.70 + 0.30 * freedom) : 1.0;
    double pu = my ? fd * ba * 220.0 * cmAdvance : 0.0;
    bool iw = (isFullBack() || isWideMidfielder());
    double fbOverlap = isFullBack() ? (0.55 + 0.45 * overlap) : 1.0;
    if (my && isFullBack()) pu *= (0.80 + 0.20 * overlap);
    double wp = (iw && my) ? fd * ba * 85.0 * fbOverlap : 0.0;
    // stay_back: hold defensive shape. The advance is driven mostly by pu/wp
    // (how far the player's attacking base shifts forward), so damp those —
    // suppressing only run-candidate scores barely moves a full-back, whose
    // overlap rides the base push, not a RunAhead purpose.
    if (my && engine.directiveBias[p.id].stayBackBias > 0.0) {
        double hold = clamp(1.0 - engine.directiveBias[p.id].stayBackBias * 0.60, 0.0, 1.0);
        pu *= hold;
        wp *= hold;
    }

    PositioningContext pc{fd, my, ba, pu, wp, ip};
    SmallVector<PositionCandidate, 32> c;

    // Delivery imminent: a teammate carries wide in the final third — box
    // runs must spike now or the cross/cutback arrives to an empty box.
    bool deliveryImminent = false;
    if (my && !per.iAmController) {
        Player* carrierNow = engine.playerById(per.ballControllerId);
        if (carrierNow && carrierNow->team == p.team) {
            double cgd = std::abs(carrierNow->x - goalXFor(p.team));
            deliveryImminent = cgd < 330.0 && std::abs(carrierNow->y - PITCH_H / 2.0) > 140.0;
        }
    }

    posBaseCandidates(c, pc);
    posDefensiveCover(c, pc, per);
    posBallFarOffers(c, pc, per);
    posAttackingSupport(c, pc, per);
    posDefensiveLine(c, pc, per);
    posGeneralCover(c, pc, per);

    // ── Score candidates ──
    SmallVector<Action, 24> options;
    for (auto& cn : c) {
        double targetX = cn.x;
        double targetY = cn.y;
        double onsideScoreAdjust = 0.0;
        if (my && !per.iAmController && (isCenterForward() || isWideMidfielder())) {
            double line = engine.offsideLineFor(p.team);
            if (!std::isnan(line)) {
                bool beyondHalf = fd > 0.0 ? targetX > HALF_X : targetX < HALF_X;
                bool beyondBall = fd > 0.0 ? targetX > b.x + OFFSIDE_TOLERANCE : targetX < b.x - OFFSIDE_TOLERANCE;
                bool beyondLine = fd > 0.0 ? targetX > line + OFFSIDE_TOLERANCE : targetX < line - OFFSIDE_TOLERANCE;
                if (beyondHalf && beyondBall && beyondLine) {
                    double legalShoulder = fd > 0.0 ? std::max(line, b.x) - 5.0 : std::min(line, b.x) + 5.0;
                    targetX = clamp(legalShoulder, 45.0, PITCH_W - 45.0);
                    bool attackingRun = cn.pur == ActionPurpose::InsideRun
                        || cn.pur == ActionPurpose::RunAhead
                        || cn.pur == ActionPurpose::CrossLane;
                    onsideScoreAdjust += attackingRun ? 0.08 : -0.04;
                    if (cn.pur == ActionPurpose::Offer) onsideScoreAdjust += 0.16;
                } else if (std::abs(targetX - line) < 45.0 && beyondHalf) {
                    onsideScoreAdjust += 0.06;
                }
            }
        }
        double sf = 0;
        for (auto* o : per.nearbyOpponents) {
            double d2 = std::sqrt((targetX - o->x) * (targetX - o->x) + (targetY - o->y) * (targetY - o->y));
            if (d2 < 50.0) sf -= (50.0 - d2) / 50.0;
        }
        // Runs into the box are SUPPOSED to enter defended space — the
        // opponent-proximity penalty otherwise repels every box run and
        // crosses arrive to an empty box (measured 0.1 teammates in the box
        // during wide final-third carries).
        bool attackingRunPur = cn.pur == ActionPurpose::InsideRun || cn.pur == ActionPurpose::RunAhead;
        // A deliberately-sent runner (woken attacking assignment) reaches the box
        // via a Task candidate, not a RunAhead/InsideRun purpose — waive its
        // proximity penalty too, else we repel the very runner we just assigned.
        auto* atask = engine.assignmentFor(p.id);
        bool assignedArrival = cn.pur == ActionPurpose::Task && atask
            && (atask->role == DefensiveTask::RunAhead || atask->role == DefensiveTask::InsideRun
                || atask->role == DefensiveTask::Overlap || atask->role == DefensiveTask::AdvanceMidfield);
        double oppGx = goalXFor(p.team);
        bool boxTarget = std::abs(targetX - oppGx) < 200.0 && std::abs(targetY - PITCH_H / 2.0) < 200.0;
        // Graded throttle (was a blanket ×0.06 that repelled every box run): keep
        // runs entering defended space, but let the penalty-spot/cutback band fill
        // rather than everyone clustering on the keeper at the 6-yard line.
        if (my && (attackingRunPur || assignedArrival) && boxTarget)
            sf *= (std::abs(targetX - oppGx) < 95.0 ? 0.12 : 0.35);
        bool counterOutlet = cn.pur == ActionPurpose::CounterOutlet || cn.pur == ActionPurpose::RestForward;
        double tac = my ? (targetX - p.homeX) * fd / PITCH_W * 0.5 : counterOutlet ? 0.0 : -(targetX - p.homeX) * fd / PITCH_W * 0.25;
        double og2 = ownGoalXFor(p.team);
        double db = !my ? clamp(((b.x - targetX) * fd) / (std::abs(b.x - og2) + 1.0), 0.0, 0.30) : 0.0;
        double bp2 = std::sqrt((targetX - b.x) * (targetX - b.x) + (targetY - b.y) * (targetY - b.y)) / 600.0 * 0.08;
        double ob = counterOutlet ? 0.44 :
                    (cn.pur == ActionPurpose::RunAhead && isCenterForward() && ba > 0.40) ? 0.44 :
                    (cn.pur == ActionPurpose::InsideRun && isCenterForward() && ba > 0.42) ? 0.38 :
                    (cn.pur == ActionPurpose::InsideRun && isWideMidfielder() && ba > 0.36) ? 0.36 :
                    (cn.pur == ActionPurpose::RunAhead && isWideMidfielder()) ? 0.30 :
                    (cn.pur == ActionPurpose::CrossLane || cn.pur == ActionPurpose::Overlap) ? 0.28 :
                    (cn.pur == ActionPurpose::HoldWidth && isWideMidfielder() && ba > 0.45) ? 0.10 :
                    (cn.pur == ActionPurpose::Observe) ? 0.10 :
                    (cn.pur == ActionPurpose::Space && isWideMidfielder() && std::abs(cn.y - PITCH_H / 2.0) > 150.0 && ba > 0.4) ? 0.12 : 0.0;
        if (deliveryImminent && boxTarget && (isCenterForward() || isWideMidfielder() || isCentralMidfielder())) ob += 0.56;
        // run_in_behind / make_runs: bias this player toward runs in behind.
        if (my && (cn.pur == ActionPurpose::RunAhead || cn.pur == ActionPurpose::InsideRun || cn.pur == ActionPurpose::CrossLane)) {
            ob += engine.directiveBias[p.id].runAheadBias;
            ob -= engine.directiveBias[p.id].comeShortBias;  // come_short: suppress runs in behind (the inverse half)
            ob -= engine.directiveBias[p.id].pocketBias;     // drift_into_pocket: same — drop into the pocket instead of running in behind
            // Quick transition: sprint in behind while the defence is unset (counters).
            // counter_attack amplifies it symmetrically with the through-ball bonus.
            if (engine.state.clockMs < engine.transitionUntilMs)
                ob += 0.20 * (1.0 + engine.counterAttackBonus[p.team == Team::Home ? 0 : 1])
                           * clamp((engine.transitionUntilMs - engine.state.clockMs) / 400.0, 0.0, 1.0);
            // play_it_long: the forwards gamble on the over-the-top run so the long
            // ball has a TARGET — the dial hit it long but had no runner, so it was
            // committing to nothing. Gated on longBallBias (0 => no-directive match
            // unchanged); CF/WM, RunAhead purpose only.
            double longB = engine.longBallBias[p.team == Team::Home ? 0 : 1];
            if (longB > 0.0 && cn.pur == ActionPurpose::RunAhead && (isCenterForward() || isWideMidfielder()))
                ob += longB * 0.30;
        }
        // come_short: the INVERSE of run_in_behind — favour the to-feet Offer candidate (drop short to
        // link), gated on the directive (default 0 => no-directive match unchanged).
        if (my && cn.pur == ActionPurpose::ComeShort)
            ob += engine.directiveBias[p.id].comeShortBias;
        // overlap: a directed FB bombs forward on the overlap run (boost the existing Overlap candidate alone).
        if (my && cn.pur == ActionPurpose::Overlap)
            ob += engine.directiveBias[p.id].overlapBias;
        // drift_into_pocket: boost the dedicated Pocket purpose alone (the deep between-the-lines target
        // would lose to advanced candidates on danger-bias without its own boost — the come_short lesson).
        if (my && cn.pur == ActionPurpose::Pocket)
            ob += engine.directiveBias[p.id].pocketBias;

        double jx = std::sin(engine.state.clockMs * 0.007 + p.id * 1.3) * 6.0;
        double jy = std::cos(engine.state.clockMs * 0.009 + p.id * 1.9) * 6.0;

        options.push_back(Action{
            ActionType::Position,
            clamp(0.15 + sf * 0.3 + tac - bp2 + db + ob + onsideScoreAdjust, 0.0, 1.0),
            nullptr,
            clamp(targetX + jx, 40.0, PITCH_W - 40.0),
            clamp(targetY + jy, 40.0, PITCH_H - 40.0),
            cn.pur
        });
    }

    // ── Task assignment ──
    auto* task = engine.assignmentFor(p.id);
    if (task) {
        static constexpr double taskScores[] = {
            0.80, // 0: None
            0.86, // 1: PrimaryPress
            0.72, // 2: SecondaryPress
            0.88, // 3: ShotLane
            0.66, // 4: Cover
            0.87, // 5: CrossLane
            0.87, // 6: LaneBlock
            0.88, // 7: BoxGuard
            0.84, // 8: FarPostGuard
            0.86, // 9: NearPostGuard
            0.84, // 10: CutbackGuard
            0.84, // 11: DefensiveLine
            0.82, // 12: WideCover
            0.72, // 13: MidfieldScreen
            0.80, // 14: BoxScreen
            0.47, // 15: SupportOutlet
            0.66, // 16: AdvanceMidfield
            0.74, // 17: RunAhead
            0.72, // 18: InsideRun
            0.64, // 19: HoldWidth
            0.72, // 20: Overlap
            0.56, // 21: RestDefence
            0.84, // 22: CloseDown
            0.80, // 23: LocalCloseDown
            0.80, // 24: EmergencyCloseDown
        };
        int ti = static_cast<int>(task->role);
        double ts = (ti >= 0 && ti < 25) ? taskScores[ti] : 0.80;
        options.push_back(Action{ActionType::Position, ts, nullptr, task->targetX, task->targetY,
                                 ActionPurpose::Task});
    }

    // ── Local close-down pressure ──
    Player* carrier = engine.playerById(per.ballControllerId);
    if (!my && carrier && carrier->team != p.team && carrier->role != Role::GK) {
        double carrierDist = dist(p.x, p.y, carrier->x, carrier->y);
        double ownGx = ownGoalXFor(p.team);
        bool inOwnHalf = (p.team == Team::Home) ? carrier->x < HALF_X : carrier->x > HALF_X;
        bool inOwnThird = std::abs(carrier->x - ownGx) < PITCH_W * 0.36;
        auto* existingTask = engine.assignmentFor(p.id);
        bool mustHoldShape = existingTask
            && (existingTask->role == DefensiveTask::LaneBlock || existingTask->role == DefensiveTask::BoxGuard
                || existingTask->role == DefensiveTask::FarPostGuard
                || existingTask->role == DefensiveTask::NearPostGuard
                || existingTask->role == DefensiveTask::CutbackGuard
                || existingTask->role == DefensiveTask::ShotLane
                || existingTask->role == DefensiveTask::CrossLane
                || existingTask->role == DefensiveTask::DefensiveLine || existingTask->role == DefensiveTask::WideCover
                || existingTask->role == DefensiveTask::MidfieldScreen || existingTask->role == DefensiveTask::BoxScreen);
        bool emergencyCloseDown = mustHoldShape && inOwnThird
            && std::abs(carrier->y - PITCH_H / 2.0) < 215.0
            && carrierDist < 34.0;
        bool roleCanStep = isDefenderLike()
            || (isWideMidfielder() && std::abs(carrier->y - p.y) < 170.0);
        bool localPressure = (!mustHoldShape || emergencyCloseDown) && roleCanStep && inOwnHalf
            && (carrierDist < (inOwnThird ? 118.0 : 86.0));
        if (localPressure) {
            bool tackleDistance = carrierDist < TACKLE_RANGE + 14.0;
            bool carrierBacktracking = (carrier->team == Team::Home) ? carrier->vx < -8.0 : carrier->vx > 8.0;
            if (!(tackleDistance && carrierBacktracking)) {
                double goalSide = (p.team == Team::Home) ? -1.0 : 1.0;
                double containX = clamp(carrier->x + goalSide * 18.0, 35.0, PITCH_W - 35.0);
                double side = (p.y < carrier->y) ? -1.0 : 1.0;
                double containY = clamp(carrier->y + side * 10.0, 35.0, PITCH_H - 35.0);
                double score = emergencyCloseDown
                    ? clamp(0.97 - carrierDist / 900.0, 0.90, 0.96)
                    : clamp(0.96 - carrierDist / 700.0, 0.72, 0.94);
                options.push_back(Action{ActionType::Position, score, carrier, containX, containY,
                                         emergencyCloseDown ? ActionPurpose::EmergCloseDown : ActionPurpose::LocalCloseDown});
            }
        }
    }

    return options;
}

// ══════════════════════════════════════════════════════════════════════════════
// rc() — resolve choice
