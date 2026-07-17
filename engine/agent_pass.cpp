#include "engine.h"
#include "agent.h"
#include "agent_helpers.h"
#include <optional>

SmallVector<Action, 24> PlayerAI::scorePass(const Perception& per, const GameContext& ctx) {
    const auto& p = player;
    SmallVector<Action, 24> r;
    // Still settling a fierce first touch — no measured pass this tick. He
    // takes a touch (dribble/shield) or shoots a first-timer instead. Slow
    // receptions carry ~0 settle, so one-twos off a controlled ball survive.
    if (engine.inFirstTouch(p.id)) return r;
    double fd = fdFor(p.team);
    double ownGoalX = ownGoalXFor(p.team);
    double ownProgress = pitch::forwardProgress(p.x, p.team);

    auto clearOutfieldOutletExists = [&]() {
        for (auto& t : engine.state.players) {
            if (t.team != p.team || t.id == p.id || t.role == Role::GK || t.sentOff) continue;
            if (engine.isOffsideTargetPerceived(p, t)) continue;
            double d = dist(p.x, p.y, t.x, t.y);
            if (d < PASS_MIN_DISTANCE || d > 360.0) continue;
            double fp = pitch::forwardGain(p.x, t.x, p.team);
            if (fp < -80.0) continue;
            double dx = t.x - p.x, dy = t.y - p.y, ls = dx * dx + dy * dy;
            if (ls < 1.0) continue;
            int bl = 0;
            for (auto& o : engine.state.players) {
                if (o.team == p.team || o.role == Role::GK) continue;
                double t2 = clamp(((o.x - p.x) * dx + (o.y - p.y) * dy) / ls, 0.0, 1.0);
                double perp = std::hypot(o.x - p.x - t2 * dx, o.y - p.y - t2 * dy);
                // Count a defender CLOSING on the lane as a blocker (same step-in
                // model scorePassToTarget uses): the static perp check rated a
                // lane "clear" while a defender stepped into it and picked the
                // ball, so a pressed CB never got the keeper recycle valve
                // (watched replay 0:31, 0:59). A defender drifting away keeps the
                // static radius.
                double cx = p.x + t2 * dx, cy = p.y + t2 * dy;
                double tlx = cx - o.x, tly = cy - o.y, tld = std::hypot(tlx, tly);
                double closing = tld > 1.0 ? (o.vx * tlx + o.vy * tly) / tld : 0.0;
                double effBlocker = PASS_BLOCKER_PERP_OUTLET + clamp(closing / 50.0, 0.0, 1.0) * 13.0;
                if (perp < effBlocker) bl++;
            }
            if (bl > 1) continue;
            int receiverPressure = 0;
            for (auto& o : engine.state.players) {
                if (o.team != p.team && o.role != Role::GK && dist(o.x, o.y, t.x, t.y) < PASS_RECEIVER_PRESS_MAX) receiverPressure++;
            }
            if (receiverPressure > 1) continue;
            return true;
        }
        return false;
    };
    bool hasClearOutfieldOutlet = clearOutfieldOutletExists();

    // Pre-compute per-iteration constants
    bool movingTowardOwnGoal = p.vx * fd < -8.0;
    bool trappedNearTouchline = (p.y < PASS_TOUCHLINE_TRAPPED || p.y > PITCH_H - PASS_TOUCHLINE_TRAPPED) && per.nearestOpponentDist < PASS_MIN_DISTANCE;
    bool nearOwnThird = ownProgress < PITCH_W * 0.40;
    bool urgentKeeperNeed = (per.pressureCount >= 2 && nearOwnThird)
        || (movingTowardOwnGoal && per.nearestOpponentDist < PASS_MIN_DISTANCE && nearOwnThird)
        || (trappedNearTouchline && ownProgress < PITCH_W * 0.36);

    // ── Closing press / cornered carrier (watched replay seed 129, 0:23 + 0:40) ──
    // Two ground-truth states the perception cone systematically misses:
    // oppClosingSoon projects every opponent 0.8s along his velocity — the press
    // that is ARRIVING, not just standing (a defender released at nearestOpp<30
    // is releasing into the tackle, ~0.5s too late). corneredEscape is the
    // touchline-pinned or regressing carrier under real carrier pressure
    // (cp reads all pressers; per.pressureCount held 1 through a 7-second
    // two-man corner trap because the second presser sat outside the cone) —
    // it arms the secure-outlet waiver so the easy out-ball to a CB behind
    // is a candidate instead of being backward-penalised to score<=0.
    // NOTE (round 18): lowering this bar for deep defenders (38, then 43) to
    // mint the GK outlet earlier was tried and REVERTED — keeper backpasses
    // blew 36 -> 98/90 (then 70), the defender->GK->defender loop the old
    // tombstone warns about. The 0:45 complaint is answered by the CLEARANCE
    // valve's 38px/s bar in agent.cpp instead: the pressed deep defender now
    // hoofs rather than turning into traffic; the GK mint keeps the 50 bar.
    bool oppClosingSoon = tackleArriving(engine.state.players, p.x, p.y, p.team);
    CarrierPressure cpPass = assessCarrierPressure(engine, p);
    bool touchlinePinned = p.y < PASS_TOUCHLINE_TRAPPED || p.y > PITCH_H - PASS_TOUCHLINE_TRAPPED;
    bool regressingCarry = engine.carrierTracker.backwardCarryCarrierId == p.id
        && (p.x - engine.carrierTracker.backwardCarryStartX) * fd < -70.0;
    bool corneredEscape = cpPass.score > 0.70 && per.nearestOpponentDist < 42.0
        && (touchlinePinned || regressingCarry);

    for (auto& t : engine.state.players) {
        if (t.team != p.team || t.id == p.id) continue;
        auto result = scorePassToTarget(t, per, fd, ownGoalX, ownProgress,
                                        hasClearOutfieldOutlet, urgentKeeperNeed, movingTowardOwnGoal,
                                        corneredEscape, oppClosingSoon);
        if (result) r.push_back(*result);
    }

    // ── Selection sanity ── with little/no pressure, a low-completion ball
    // must not outbid CLEARLY safer options of comparable progress (watched
    // replay seed 317: the same wide defender picked off build-up pass after
    // build-up pass — 0:31, 1:11, 1:34 — while two or three easy outlets stood
    // free each time; "spin pass into massive traffic instead of the simple
    // ball"). Killer balls, clears and deliveries stay exempt (meant to be
    // risky). The penalty scales with how much safer the best alternative is,
    // so a marginal gap changes nothing.
    if (per.pressureCount <= 1) {
        double bestSafeComp = 0.0;
        for (auto& x : r)
            if (x.audit.forwardProgress > -60.0)
                bestSafeComp = std::max(bestSafeComp, x.audit.expectedCompletion);
        if (bestSafeComp > 0.70) {
            for (auto& x : r) {
                if (x.purpose == ActionPurpose::Through || x.purpose == ActionPurpose::Clear
                    || x.purpose == ActionPurpose::Cross || x.purpose == ActionPurpose::Cutback) continue;
                double gap = bestSafeComp - x.audit.expectedCompletion - 0.26;
                if (gap > 0.0) x.score -= gap * 0.9;
            }
        }
    }

    // NOTE: a "pressured release valve" (boost the safest outlet once a carrier has
    // been pressed + dwelling >1.4s, to force the shield-then-safe-ball at seed 105
    // 0:16) was A/B'd and REVERTED. Fire-often cost -0.18 goals (recycling killed
    // attacks a good carrier would have carried out of); gated to "genuinely stuck"
    // it barely fired and still reshuffled -0.12 with backward passes DOWN, not up.
    // The 0:16 dwell is better treated as a decision-latency problem (stuck-carrier
    // watchdog) than a pass-score nudge — revisit there, not here.

    // ── Crossing carrier override ──
    // ⚠ Load-bearing offense — do NOT remove without replacing the chances.
    // History: this block is the engine's cross-volume machine (originally ~246
    // crosses/match, gated to ~76; attribution testing shows it produces ~50 of
    // those). Score thresholds and arbitration weights CANNOT cut its volume:
    // the carrier re-evaluates every tick, so any per-tick chance of the cross
    // winning saturates over a multi-second wide possession (threshold 0.42 ->
    // 1.05 and a 0.90 -> 0.72 weight cap each moved volume by ~1/match). And an
    // A/B with the override restricted to the cross_early directive collapsed
    // the attack entirely — 1.05 goals/match, 9-of-20 matches 0-0 — because
    // central penetration/cutback chance creation doesn't yet exist to replace
    // it. Until that exists (chance-mix rebuild), this stays as the offense.
    bool crossEarly = engine.directiveBias[p.id].crossEarly;
    bool crossingCarrier = isWidePlayer()
        && pitch::lateralFromCenter(p.y) > (crossEarly ? 120.0 : 150.0)
        && pitch::distToOppGoal(p.x, p.team) < (crossEarly ? 360.0 : 250.0);
    if (crossingCarrier) {
        Player* bestRunner = nullptr;
        double bestScore = -1e9;
        for (auto& t : engine.state.players) {
            if (t.team != p.team || t.id == p.id || t.role == Role::GK || t.sentOff) continue;
            if (engine.isOffsideTargetPerceived(p, t)) continue;
            double targetGoalDist = pitch::distToOppGoal(t.x, p.team);
            if (targetGoalDist > 430.0 || pitch::lateralFromCenter(t.y) > 255.0) continue;
            double d = dist(p.x, p.y, t.x, t.y);
            if (d < 65.0 || d > 520.0) continue;
            int pressure = 0;
            for (auto& o : engine.state.players) {
                if (o.team != p.team && o.role != Role::GK && dist(o.x, o.y, t.x, t.y) < 48.0) pressure++;
            }
            double central = 1.0 - pitch::lateralFromCenter(t.y) / 230.0;
            double roleBonus = 0.0;
            for (auto& a : engine.agents) { if (a->player.id == t.id) { roleBonus = a->roleBonusForPassTarget(); break; } }
            double goalThreat = targetGoalDist < 150.0 ? 0.34 : targetGoalDist < 210.0 ? 0.20 : targetGoalDist < 260.0 ? 0.06 : -0.08;
            double score = central + roleBonus + goalThreat + (300.0 - targetGoalDist) / 390.0 - pressure * 0.25 - d / 900.0;
            if (score > bestScore) { bestScore = score; bestRunner = &t; }
        }
        // A packed box kills the cross: real wingers recycle or pull it back when
        // the area is crowded — whipping it into 4+ defenders is a turnover, and
        // indiscriminate crossing is why the engine sat at ~76 crosses (real
        // 30-40) with every attack looking identical.
        if (bestRunner) {
            int boxDefenders = 0, boxAttackers = 0;
            for (auto& o : engine.state.players) {
                if (o.role == Role::GK || o.sentOff || o.id == p.id) continue;
                bool inZone = pitch::distToOppGoal(o.x, p.team) < 200.0 && pitch::lateralFromCenter(o.y) < 170.0;
                if (!inZone) continue;
                if (o.team == p.team) boxAttackers++; else boxDefenders++;
            }
            bestScore -= std::max(0, boxDefenders - 2) * 0.13;
            // Populated-box gate: you don't whip it in for ONE runner vs a set
            // defense — real wing play waits for bodies. This is the structural
            // volume cut the score threshold couldn't deliver (per-tick
            // re-evaluation saturates any probability gate; the box-occupancy
            // condition instead stays false until the burst runners actually
            // arrive — and then the cross is GOOD). The earlier hard removal of
            // this override collapsed the attack (1.05 goals); with the
            // box-burst runs + breakaway + cutback channels now live, the
            // populated-box moments carry the load.
            if (boxAttackers < 2) bestRunner = nullptr;
        }
        // Threshold calibrated by attribution test: this override produced ~50 of
        // the ~72 crosses/match (helper ~21 + corners ~11 are the rest). The score
        // scale runs ~1.0-1.7 for a decent runner, so 0.42/0.55 barely gated —
        // 1.05 demands a genuinely elite target (central, near goal, unmarked,
        // uncrowded box) and drops the override's volume to a garnish on top of
        // the organic helper crosses.
        if (bestRunner && bestScore > (crossEarly ? 0.15 : 1.05)) {
            double d = dist(p.x, p.y, bestRunner->x, bestRunner->y);
            double fp = pitch::forwardGain(p.x, bestRunner->x, p.team);
            r.push_back(Action{ActionType::Pass, clamp(0.55 + bestScore * 0.25, 0.0, 0.90), bestRunner, 0, 0,
                               ActionPurpose::Cross, ActionAudit{d, fp, 0.72, 0, 0, 0, 0}});
        }
    }
    return r;
}

// ══════════════════════════════════════════════════════════════════════════════
// cs() — can-shoot
// ══════════════════════════════════════════════════════════════════════════════
