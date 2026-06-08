#include "engine.h"
#include "agent.h"
#include <map>

std::vector<Action> PlayerAI::scorePositioning(const Perception& per, const GameContext& ctx) {
    const auto& p = player;
    auto& b = engine.state.ball;
    double fd = fdFor(p.team);
    Team ip = engine.teamInPossession();
    bool my = (per.ballControllerTeam == p.team);
    double ba = (fd == 1.0) ? b.x / PITCH_W : 1.0 - b.x / PITCH_W;
    double pu = my ? fd * ba * 220.0 : 0.0;
    bool iw = (isFullBack() || isWideMidfielder());
    double wp = (iw && my) ? fd * ba * 85.0 : 0.0;

    PositioningContext pc{fd, my, ba, pu, wp, ip};
    std::vector<PositionCandidate> c;

    posBaseCandidates(c, pc);
    posDefensiveCover(c, pc, per);
    posBallFarOffers(c, pc, per);
    posAttackingSupport(c, pc, per);
    posDefensiveLine(c, pc, per);
    posGeneralCover(c, pc, per);

    // ── Score candidates ──
    std::vector<Action> options;
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
                    double legalShoulder = fd > 0.0 ? std::max(line, b.x) - 12.0 : std::min(line, b.x) + 12.0;
                    double overrun = std::abs(targetX - legalShoulder);
                    bool timedRun = (cn.pur == ActionPurpose::InsideRun || cn.pur == ActionPurpose::RunAhead || cn.pur == ActionPurpose::CrossLane)
                        && ba > 0.58 && overrun < 95.0;
                    if (!timedRun) targetX = clamp(legalShoulder, 45.0, PITCH_W - 45.0);
                    onsideScoreAdjust -= timedRun ? 0.18 : 0.04;
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
        bool counterOutlet = cn.pur == ActionPurpose::CounterOutlet || cn.pur == ActionPurpose::RestForward;
        double tac = my ? (targetX - p.homeX) * fd / PITCH_W * 0.5 : counterOutlet ? 0.0 : -(targetX - p.homeX) * fd / PITCH_W * 0.25;
        double og2 = ownGoalXFor(p.team);
        double db = !my ? clamp(((b.x - targetX) * fd) / (std::abs(b.x - og2) + 1.0), 0.0, 0.30) : 0.0;
        double bp2 = std::sqrt((targetX - b.x) * (targetX - b.x) + (targetY - b.y) * (targetY - b.y)) / 600.0 * 0.08;
        double ob = counterOutlet ? 0.44 :
                    (cn.pur == ActionPurpose::RunAhead && isCenterForward() && ba > 0.48) ? 0.20 :
                    (cn.pur == ActionPurpose::InsideRun && isCenterForward() && ba > 0.50) ? 0.14 :
                    (cn.pur == ActionPurpose::InsideRun && isWideMidfielder() && ba > 0.42) ? 0.20 :
                    (cn.pur == ActionPurpose::RunAhead && isWideMidfielder()) ? 0.14 :
                    (cn.pur == ActionPurpose::CrossLane || cn.pur == ActionPurpose::Overlap) ? 0.24 :
                    (cn.pur == ActionPurpose::HoldWidth && isWideMidfielder() && ba > 0.45) ? 0.10 :
                    (cn.pur == ActionPurpose::Observe) ? 0.10 :
                    (cn.pur == ActionPurpose::Space && isWideMidfielder() && std::abs(cn.y - PITCH_H / 2.0) > 150.0 && ba > 0.4) ? 0.12 : 0.0;

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
        static const std::map<DefensiveTask, double> taskScores = {
            {DefensiveTask::PrimaryPress, 0.86}, {DefensiveTask::SecondaryPress, 0.72}, {DefensiveTask::ShotLane, 0.88}, {DefensiveTask::Cover, 0.66},
            {DefensiveTask::CrossLane, 0.87}, {DefensiveTask::LaneBlock, 0.87}, {DefensiveTask::BoxGuard, 0.88}, {DefensiveTask::FarPostGuard, 0.84},
            {DefensiveTask::NearPostGuard, 0.86}, {DefensiveTask::CutbackGuard, 0.84}, {DefensiveTask::DefensiveLine, 0.84}, {DefensiveTask::WideCover, 0.82},
            {DefensiveTask::MidfieldScreen, 0.72}, {DefensiveTask::BoxScreen, 0.80}, {DefensiveTask::SupportOutlet, 0.47}, {DefensiveTask::AdvanceMidfield, 0.66},
            {DefensiveTask::RunAhead, 0.74}, {DefensiveTask::InsideRun, 0.72}, {DefensiveTask::HoldWidth, 0.64},
            {DefensiveTask::Overlap, 0.72}, {DefensiveTask::RestDefence, 0.56}, {DefensiveTask::CloseDown, 0.84},
        };
        double ts = 0.80;
        auto tit = taskScores.find(task->role);
        if (tit != taskScores.end()) ts = tit->second;
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
            && carrierDist < 62.0;
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
