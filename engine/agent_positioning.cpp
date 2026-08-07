#include "engine.h"
#include "agent.h"

void PlayerAI::scorePositioning(const Perception& per, SmallVector<Action, 48>& options) {
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
        int myIdx = teamIndex(p.team);
        if (!my && engine.teamTactics[myIdx].defenseHoldingShape && (isCenterForward() || isWideMidfielder())) {
            // "Only the primary container engages" — but this early-return
            // swallowed even HIS duty: the assigned presser's drop (0.95)
            // outbid his own press task (0.86), so his target flip-flopped
            // between pressing and the halfway drop on every re-rank (watched
            // replay 0:21: the striker jogging away from the keeper
            // mid-backpass). A press/close-down assignee falls through to
            // normal candidate generation, where his task candidate lives.
            auto* myTask = engine.assignmentFor(p.id);
            bool pressDuty = myTask && (myTask->role == DefensiveTask::PrimaryPress
                                     || myTask->role == DefensiveTask::SecondaryPress
                                     || myTask->role == DefensiveTask::CloseDown);
            if (!pressDuty) {
                double dropX = clamp(HALF_X + fd * 40.0, 60.0, PITCH_W - 60.0);
                double dropY = clamp(p.homeY, 40.0, PITCH_H - 40.0);
                options.push_back(Action{ActionType::Position, 0.95, nullptr, dropX, dropY, ActionPurpose::Observe});
                return;
            }
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
    SmallVector<PositionCandidate, 48> c;

    // Delivery imminent: a teammate carries wide in the final third — box
    // runs must spike now or the cross/cutback arrives to an empty box.
    bool deliveryImminent = false;
    if (my && !per.iAmController) {
        Player* carrierNow = engine.playerById(per.ballControllerId);
        if (carrierNow && carrierNow->team == p.team) {
            double cgd = pitch::distToOppGoal(carrierNow->x, p.team);
            deliveryImminent = cgd < 330.0 && std::abs(carrierNow->y - PITCH_H / 2.0) > 140.0;
        }
    }

    posBaseCandidates(c, pc);
    posDefensiveCover(c, pc, per);
    posBallFarOffers(c, pc, per);
    posAttackingSupport(c, pc, per);
    posDefensiveLine(c, pc, per);
    posGeneralCover(c, pc, per);

    // ── Per-call invariants for the scoring loop (perf, 2026-08 profile) ──
    // scorePositioning was 33% of match wall time, and the loop below runs once
    // per candidate (~20-30 per call). Everything cached here reads state that
    // cannot change while this call scores its candidates — same operands, same
    // results, bit-identical scores; the loop just stops recomputing them.
    //
    // Jitter ±6 -> ±2: the deliberate sinusoid moved every target 12px
    // peak-to-peak per axis EVERY tick — under momentum that renders as
    // in-place shiver, not liveliness. (Depends only on clockMs + player id,
    // so it is identical for every candidate this tick — hoisted.)
    double jx = std::sin(engine.state.clockMs * 0.007 + p.id * 1.3) * 2.0;
    double jy = std::cos(engine.state.clockMs * 0.009 + p.id * 1.9) * 2.0;
    // Role identity: these hooks are VIRTUAL (role_ai overrides the AI, not the
    // role read), so the compiler cannot hoist them itself — it must assume an
    // override could observe the candidate loop. They answer from player.role,
    // which no candidate can change, so reading them once per call is the same
    // answer every time. Round-2 profile: the purpose-bonus ladder below (now
    // ~209-217) was making up to five indirect calls per candidate, ~40M a match.
    const bool amCF = isCenterForward();
    const bool amWM = isWideMidfielder();
    const bool amCM = isCentralMidfielder();
    const bool amFB = isFullBack();
    // The directive row, the team's tactics row and this player's assignment are
    // all indexed by ids fixed for the call — same rationale, hoisted from the
    // candidate loop's boost ladder.
    const auto& myBias = engine.directiveBias[p.id];
    const auto& myTac  = engine.teamTactics[teamIndex(p.team)];
    auto* atask = engine.assignmentFor(p.id);
    const bool ataskIsArrival = atask
        && (atask->role == DefensiveTask::RunAhead || atask->role == DefensiveTask::InsideRun
            || atask->role == DefensiveTask::Overlap || atask->role == DefensiveTask::AdvanceMidfield);
    // Goal geometry and the danger-bias denominator: same operands every
    // candidate (only the numerator moves), so the division is unchanged.
    const double oppGx = goalXFor(p.team);
    const double og2 = ownGoalXFor(p.team);
    const double dbDenom = std::abs(b.x - og2) + 1.0;
    // Offside line: an O(players) scan of a roster that does not move during
    // this call — hoisted from the per-candidate onside adjustment.
    bool onsideAware = my && !per.iAmController && (amCF || amWM);
    double onsideLine = onsideAware ? engine.offsideLineFor(p.team) : 0.0;
    // Teammate spots for the crowding term, filtered ONCE (was a full-roster
    // scan re-running the team/id/sentOff tests per candidate). Same players,
    // same order, same hypot operands — the crowding sum is bit-identical.
    struct MateXY { double x, y; };
    SmallVector<MateXY, 11> mateXY;
    for (auto& q : engine.state.players) {
        if (q.team != p.team || q.id == p.id || q.sentOff) continue;
        mateXY.push_back(MateXY{q.x, q.y});
    }
    // Fellow-CM spots for the CM spacing term — same filter-once rationale.
    SmallVector<MateXY, 4> cmXY;
    if (amCM) {
        for (auto& tm : engine.state.players) {
            if (tm.team != p.team || tm.id == p.id || tm.sentOff || tm.role != Role::CM) continue;
            cmXY.push_back(MateXY{tm.x, tm.y});
        }
    }

    // ── Score candidates ──
    for (auto& cn : c) {
        double targetX = cn.x;
        double targetY = cn.y;
        double onsideScoreAdjust = 0.0;
        if (onsideAware) {
            double line = onsideLine;
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
            // |dx| or |dy| >= 50 already proves the distance >= 50 -> zero term
            // (the compare below is strict <); skipping the sqrt cannot change sf.
            if (std::abs(targetX - o->x) >= 50.0 || std::abs(targetY - o->y) >= 50.0) continue;
            double d2 = std::sqrt((targetX - o->x) * (targetX - o->x) + (targetY - o->y) * (targetY - o->y));
            if (d2 < 50.0) sf -= (50.0 - d2) / 50.0;
        }
        // ── Teammate-crowding term (crowding ticket, 2026-07-04) ── The score
        // penalized opponents at the target but teammates were FREE, so
        // offer/space/keep candidates happily landed on top of each other —
        // fresh FOOTY_BLOBDEBUG attribution puts intentional attacking-support
        // members at ~1/3 of six-player-knot bodies (offer 102 + space 81 +
        // keep 69 of 768), exactly the "space the intentional members" lever
        // the 55px-notch rejection note designated. Full-roster scan, not the
        // perception cone: a teammate BEHIND me still crowds the spot.
        double tf = 0;
        for (auto& q : mateXY) {
            // Same conservative reject as sf above: hypot(dx, dy) >= max(|dx|, |dy|),
            // so a skipped teammate contributed exactly 0 — tf is unchanged.
            if (std::abs(targetX - q.x) >= 50.0 || std::abs(targetY - q.y) >= 50.0) continue;
            double d2 = std::hypot(targetX - q.x, targetY - q.y);
            if (d2 < 50.0) tf -= (50.0 - d2) / 50.0;
        }
        // Runs into the box are SUPPOSED to enter defended space — the
        // opponent-proximity penalty otherwise repels every box run and
        // crosses arrive to an empty box (measured 0.1 teammates in the box
        // during wide final-third carries).
        bool attackingRunPur = cn.pur == ActionPurpose::InsideRun || cn.pur == ActionPurpose::RunAhead;
        // A deliberately-sent runner (woken attacking assignment) reaches the box
        // via a Task candidate, not a RunAhead/InsideRun purpose — waive its
        // proximity penalty too, else we repel the very runner we just assigned.
        bool assignedArrival = cn.pur == ActionPurpose::Task && ataskIsArrival;
        bool boxTarget = std::abs(targetX - oppGx) < 200.0 && std::abs(targetY - PITCH_H / 2.0) < 200.0;
        // Graded throttle (was a blanket ×0.06 that repelled every box run): keep
        // runs entering defended space, but let the penalty-spot/cutback band fill
        // rather than everyone clustering on the keeper at the 6-yard line.
        if (my && (attackingRunPur || assignedArrival) && boxTarget) {
            double runThrottle = std::abs(targetX - oppGx) < 95.0 ? 0.12 : 0.35;
            sf *= runThrottle;
            tf *= runThrottle;   // box arrivals legitimately congregate — same waiver
        }
        bool counterOutlet = cn.pur == ActionPurpose::CounterOutlet || cn.pur == ActionPurpose::RestForward;
        double tac = my ? (targetX - p.homeX) * fd / PITCH_W * 0.5 : counterOutlet ? 0.0 : -(targetX - p.homeX) * fd / PITCH_W * 0.25;
        double db = !my ? clamp(((b.x - targetX) * fd) / dbDenom, 0.0, 0.30) : 0.0;
        double bp2 = std::sqrt((targetX - b.x) * (targetX - b.x) + (targetY - b.y) * (targetY - b.y)) / 600.0 * 0.08;
        double ob = counterOutlet ? 0.44 :
                    (cn.pur == ActionPurpose::RunAhead && amCF && ba > 0.40) ? 0.44 :
                    (cn.pur == ActionPurpose::InsideRun && amCF && ba > 0.42) ? 0.38 :
                    (cn.pur == ActionPurpose::InsideRun && amWM && ba > 0.36) ? 0.36 :
                    (cn.pur == ActionPurpose::RunAhead && amWM) ? 0.30 :
                    (cn.pur == ActionPurpose::CrossLane || cn.pur == ActionPurpose::Overlap) ? 0.28 :
                    (cn.pur == ActionPurpose::HoldWidth && amWM && ba > 0.45) ? 0.10 :
                    (cn.pur == ActionPurpose::Observe) ? 0.10 :
                    (cn.pur == ActionPurpose::Space && amWM && pitch::lateralFromCenter(cn.y) > 150.0 && ba > 0.4) ? 0.12 : 0.0;
        if (deliveryImminent && boxTarget && (amCF || amWM || amCM)) ob += 0.56;
        // run_in_behind / make_runs: bias this player toward runs in behind.
        if (my && (cn.pur == ActionPurpose::RunAhead || cn.pur == ActionPurpose::InsideRun || cn.pur == ActionPurpose::CrossLane)) {
            ob += myBias.runAheadBias;
            ob -= myBias.comeShortBias;  // come_short: suppress runs in behind (the inverse half)
            ob -= myBias.pocketBias;     // drift_into_pocket: same — drop into the pocket instead of running in behind
            // Quick transition: sprint in behind while the defence is unset (counters).
            // counter_attack amplifies it symmetrically with the through-ball bonus.
            if (engine.state.clockMs < engine.transitionUntilMs)
                ob += 0.20 * (1.0 + myTac.counterAttackBonus)
                           * clamp((engine.transitionUntilMs - engine.state.clockMs) / 400.0, 0.0, 1.0);
            // play_it_long: the forwards gamble on the over-the-top run so the long
            // ball has a TARGET — the dial hit it long but had no runner, so it was
            // committing to nothing. Gated on longBallBias (0 => no-directive match
            // unchanged); CF/WM, RunAhead purpose only.
            double longB = myTac.longBallBias;
            if (longB > 0.0 && cn.pur == ActionPurpose::RunAhead && (amCF || amWM))
                ob += longB * 0.30;
        }
        // come_short: the INVERSE of run_in_behind — favour the to-feet Offer candidate (drop short to
        // link), gated on the directive (default 0 => no-directive match unchanged).
        if (my && cn.pur == ActionPurpose::ComeShort)
            ob += myBias.comeShortBias;
        // overlap: a directed FB bombs forward on the overlap run (boost the existing Overlap candidate alone).
        if (my && cn.pur == ActionPurpose::Overlap) {
            ob += myBias.overlapBias;
            // DEFAULT overlap (user feedback #1 "lack of overlapping runs"): even WITHOUT a directive, the
            // BALL-SIDE full-back bombs on when the team is SETTLED in the opp half — offering the width the
            // user found missing (FBs sat at ~5% att-third). Ball-side only (the far FB holds for balance) +
            // gated on ball advancement, so it never bares both flanks; recovery is structural (the boost
            // lapses the moment the ball drops back / possession turns over). Pure geometry, no rng.
            if (amFB && ba > 0.50 && (p.y >= PITCH_H / 2.0) == (b.y >= PITCH_H / 2.0))
                ob += 0.16;
        }
        // drift_into_pocket: boost the dedicated Pocket purpose alone (the deep between-the-lines target
        // would lose to advanced candidates on danger-bias without its own boost — the come_short lesson).
        if (my && cn.pur == ActionPurpose::Pocket)
            ob += myBias.pocketBias;

        // CM spacing (shape audit: the midfield trio's mean nearest-teammate
        // was 5.4-6.6m vs 10-12m for every other role, and CM-CM-CM was the
        // top clump class at ~7 clusters/min). A candidate that stands on a
        // fellow CM pays for it — the trio spreads instead of stacking.
        double crowd = 0.0;
        if (amCM) {
            for (auto& tm : cmXY) {
                // dist >= 95 -> zero term (strict <); the reject can't change crowd.
                if (std::abs(cn.x - tm.x) >= 95.0 || std::abs(cn.y - tm.y) >= 95.0) continue;
                double cd = dist(cn.x, cn.y, tm.x, tm.y);
                if (cd < 95.0) crowd += (95.0 - cd) / 95.0 * 0.26;
            }
        }
        // Incumbency (micro audit #5: 33k target-jitter windows/5min — the
        // argmax re-ran every tick with zero hysteresis, and the target noise
        // passed straight into velocity as direction flips and in-place
        // shivering). The candidate nearest the CURRENT target gets a small
        // edge, so a genuinely better spot still wins but ties stop strobing.
        // 0.05/45 -> 0.12/70 (2-min audit, seed 629 52-56s: candidates ~40px
        // apart tie-strobed THROUGH the old bonus — pid7 flip-flopped targets
        // 87 times in 1.5s, velocity flipping ~176deg per tick while standing
        // still). The stronger edge makes a genuinely better spot still win
        // while adjacent ties stay put.
        double incumbency = (std::abs(cn.x - p.targetX) < 70.0 && std::abs(cn.y - p.targetY) < 70.0
                             && dist(cn.x, cn.y, p.targetX, p.targetY) < 70.0) ? 0.12 : 0.0;

        options.push_back(Action{
            ActionType::Position,
            clamp(0.15 + sf * 0.3 + tf * 0.25 + tac - bp2 + db + ob + onsideScoreAdjust - crowd + incumbency, 0.0, 1.0),
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
    if (!my && carrier && carrier->team != p.team && !roles::isGoalkeeper(carrier->role)) {
        double carrierDist = dist(p.x, p.y, carrier->x, carrier->y);
        double ownGx = ownGoalXFor(p.team);
        bool inOwnHalf = pitch::inOwnHalf(carrier->x, p.team);
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
                double containX = clamp(carrier->x + goalSide * 34.0, 35.0, PITCH_W - 35.0);
                // Round-27 COMMIT 2: latch the Y side with a ~22px deadband. The old
                // bare (p.y < carrier->y ? -1 : 1) flipped the instant the defender
                // drifted a pixel across the carrier's Y line, jumping the contain
                // point 32px and driving a lateral limit-cycle shuffle. Hold the
                // side until |p.y - carrier->y| clears the deadband on the far side.
                double dySigned = p.y - carrier->y;   // >0 => defender is below the carrier
                double side;
                if (engine.arenaMode) {
                    side = (dySigned < 0.0) ? -1.0 : 1.0;   // 1v1: keep the original bare flip (latch/dwell freeze risk)
                } else {
                    if (containSideLatch == 0)
                        containSideLatch = (dySigned < 0.0) ? -1 : 1;
                    else if (containSideLatch < 0 && dySigned > 22.0)
                        containSideLatch = 1;
                    else if (containSideLatch > 0 && dySigned < -22.0)
                        containSideLatch = -1;
                    side = (double)containSideLatch;
                }
                double containY = clamp(carrier->y + side * 16.0, 35.0, PITCH_H - 35.0);
                double score = emergencyCloseDown
                    ? clamp(0.97 - carrierDist / 900.0, 0.90, 0.96)
                    : clamp(0.96 - carrierDist / 700.0, 0.72, 0.94);
                options.push_back(Action{ActionType::Position, score, carrier, containX, containY,
                                         emergencyCloseDown ? ActionPurpose::EmergCloseDown : ActionPurpose::LocalCloseDown});
            }
        }
    }

}

// ══════════════════════════════════════════════════════════════════════════════
// rc() — resolve choice
