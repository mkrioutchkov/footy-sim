#include "engine.h"
#include "agent.h"

std::vector<Action> PlayerAI::scorePass(const Perception& per, const GameContext& ctx) {
    const auto& p = player;
    double fd = (p.team == Team::Home) ? 1.0 : -1.0;
    std::vector<Action> r;
    double ownGoalX = ownGoalXFor(p.team);
    double ownProgress = (p.x - ownGoalX) * fd;

    auto clearOutfieldOutletExists = [&]() {
        for (auto& t : engine.state.players) {
            if (t.team != p.team || t.id == p.id || t.role == Role::GK) continue;
            if (engine.isOffsideTarget(p, t)) continue;
            double d = dist(p.x, p.y, t.x, t.y);
            if (d < 42.0 || d > 360.0) continue;
            double fp = (t.x - p.x) * fd;
            if (fp < -80.0) continue;
            double dx = t.x - p.x, dy = t.y - p.y, ls = dx * dx + dy * dy;
            if (ls < 1.0) continue;
            int bl = 0;
            for (auto& o : engine.state.players) {
                if (o.team == p.team || o.role == Role::GK) continue;
                double t2 = clamp(((o.x - p.x) * dx + (o.y - p.y) * dy) / ls, 0.0, 1.0);
                double perp = std::hypot(o.x - p.x - t2 * dx, o.y - p.y - t2 * dy);
                if (perp < 34.0) bl++;
            }
            if (bl > 1) continue;
            int receiverPressure = 0;
            for (auto& o : engine.state.players) {
                if (o.team != p.team && o.role != Role::GK && dist(o.x, o.y, t.x, t.y) < 45.0) receiverPressure++;
            }
            if (receiverPressure > 1) continue;
            return true;
        }
        return false;
    };
    bool hasClearOutfieldOutlet = clearOutfieldOutletExists();

    for (auto& t : engine.state.players) {
        if (t.team != p.team || t.id == p.id) continue;
        bool movingTowardOwnGoal = p.vx * fd < -8.0;
        bool trappedNearTouchline = (p.y < 90.0 || p.y > PITCH_H - 90.0) && per.nearestOpponentDist < 42.0;
        bool nearOwnThird = ownProgress < PITCH_W * 0.40;
        bool urgentKeeperNeed = (per.pressureCount >= 2 && nearOwnThird)
            || (movingTowardOwnGoal && per.nearestOpponentDist < 42.0 && nearOwnThird)
            || (trappedNearTouchline && ownProgress < PITCH_W * 0.36);
        bool keeperOutlet = t.role == Role::GK && urgentKeeperNeed && !hasClearOutfieldOutlet;
        if (t.role == Role::GK && !keeperOutlet) continue;
        double d = dist(p.x, p.y, t.x, t.y);
        if (d < 42.0 || d > (keeperOutlet ? 455.0 : 550.0)) continue;
        if (!keeperOutlet && engine.isOffsideTarget(p, t)) continue;

        int bl = 0;
        double dx = t.x - p.x, dy = t.y - p.y, ls = dx * dx + dy * dy;
        if (ls < 1.0) continue;

        for (auto& o : engine.state.players) {
            if (o.team == p.team || o.role == Role::GK) continue;
            double t2 = clamp(((o.x - p.x) * dx + (o.y - p.y) * dy) / ls, 0.0, 1.0);
            double perp = std::sqrt((o.x - p.x - t2 * dx) * (o.x - p.x - t2 * dx)
                                  + (o.y - p.y - t2 * dy) * (o.y - p.y - t2 * dy));
            if (perp < 36.0) bl++;
        }
        if (bl >= 3) continue;

        double fp = (t.x - p.x) * fd;
        double rs = attrFactor(p.attrs.passing);
        double rr = attrFactor(t.attrs.positioning);

        int receiverPressure = 0;
        for (auto& o : engine.state.players) {
            if (o.team != p.team && o.role != Role::GK && dist(o.x, o.y, t.x, t.y) < 45.0) receiverPressure++;
        }
        if (receiverPressure >= 3) continue;

        double completion = clamp(
            0.89 + rs * 0.10 + rr * 0.06 - d / 850.0 * 0.28 - bl * 0.23
                - receiverPressure * 0.15 - (fp > 130.0 ? 0.05 : 0.0),
            0.08, 0.98);
        if (completion < 0.44) continue;

        double progression = clamp(fp / 240.0, -0.5, 1.0);
        double turnoverCost = ((p.team == Team::Home) ? p.x < PITCH_W * 0.38 : p.x > PITCH_W * 0.62) ? 0.42 : 0.25;
        double sc = completion * (0.34 + std::max(0.0, progression) * 0.34) - (1.0 - completion) * turnoverCost;
        if (keeperOutlet) {
            sc += 0.04 + per.pressureCount * 0.04 + (movingTowardOwnGoal ? 0.06 : 0.0);
            if (bl == 0) sc += 0.02;
        }
        if (t.id == lastPassTargetId) sc -= 0.18;

        if (recentPassTarget == t.id && engine.state.clockMs - recentPassTime < 3000.0) sc -= 0.10;

        if (bl == 0 && fp > 80.0) sc += 0.08;
        bool carrierFinalThird = (p.team == Team::Home) ? p.x > PITCH_W * 2.0 / 3.0 : p.x < PITCH_W / 3.0;
        if (!keeperOutlet && fp < -30.0) sc -= carrierFinalThird ? 0.28 : 0.16;
        if (!keeperOutlet && fp < -90.0) sc -= carrierFinalThird ? 0.30 : 0.18;
        if (!keeperOutlet && carrierFinalThird && per.pressureCount == 0 && fp < 0.0) sc -= 0.12;

        double dg2 = std::abs(p.x - (goalXFor(p.team)));
        if (dg2 < 200.0 && fp > 0.0 && d < 150.0) sc += 0.10;

        double dgW = dg2;
        bool isWideDelivery = (p.role == Role::WM || p.role == Role::FB)
            && dgW < 430.0
            && std::abs(p.y - PITCH_H / 2.0) > 75.0
            && std::abs(t.x - (goalXFor(p.team))) < 310.0
            && std::abs(t.y - PITCH_H / 2.0) < 210.0
            && fp > -120.0;

        double boxTargetGoalDist = std::abs(t.x - goalXFor(p.team));
        bool centralBoxTarget = std::abs(t.y - PITCH_H / 2.0) < 185.0
            && boxTargetGoalDist > 75.0 && boxTargetGoalDist < 245.0;
        bool cutbackTarget = isWideDelivery
            && std::abs(p.y - PITCH_H / 2.0) > 110.0
            && centralBoxTarget
            && (t.role == Role::CF || t.role == Role::CM || t.role == Role::WM)
            && fp < 75.0;
        bool isCross   = isWideDelivery && !cutbackTarget && std::abs(p.y - PITCH_H / 2.0) > 120.0 && fp > -45.0;
        bool isCutback = isWideDelivery && !isCross;

        if (isCross) {
            sc += 0.48;
            if (t.role == Role::CF) sc += 0.30;
            else if (t.role == Role::WM) sc += 0.10;
            else if (t.role == Role::CM) sc -= 0.34;
            bool headerZone = boxTargetGoalDist > 85.0 && boxTargetGoalDist < 205.0
                && std::abs(t.y - PITCH_H / 2.0) < 165.0;
            if (headerZone && t.role == Role::CF && receiverPressure <= 1) sc += 0.24;
            if (headerZone && t.role == Role::WM && receiverPressure == 0) sc += 0.10;
            if (boxTargetGoalDist > 245.0) sc -= 0.22;
            if (std::abs(t.y - PITCH_H / 2.0) > 185.0) sc -= 0.12;
        }
        if (isCutback) {
            sc += cutbackTarget ? 0.42 : 0.18;
            if (cutbackTarget && t.role == Role::CM) sc += 0.10;
            if (cutbackTarget && receiverPressure == 0 && bl == 0) sc += 0.10;
        }
        if (carrierFinalThird && boxTargetGoalDist < 150.0 && receiverPressure <= 1 && bl <= 1) {
            if (t.role == Role::CF) sc += 0.16;
            else if (t.role == Role::WM) sc += 0.12;
            else if (t.role == Role::CM && std::abs(t.y - PITCH_H / 2.0) < 150.0) sc += 0.06;
        }
        if ((p.role == Role::CM || p.role == Role::WM || p.role == Role::FB)
            && t.role == Role::CF
            && std::abs(t.y - PITCH_H / 2.0) < 175.0
            && boxTargetGoalDist < 245.0
            && fp > -35.0
            && bl <= 1
            && receiverPressure <= 1) {
            sc += carrierFinalThird ? 0.30 : 0.20;
        }
        if ((isCross || isCutback) && receiverPressure <= 1 && bl <= 1) sc += 0.08;
        if (p.role == Role::WM && dgW < 450.0 && t.role == Role::CF && std::abs(t.y - PITCH_H / 2.0) < 230.0) sc += 0.42;
        if (p.role == Role::WM && fp > 10.0 && std::abs(p.y - PITCH_H / 2.0) > 100.0 && bl <= 2) sc += 0.32;
        if (p.role == Role::FB && fp > 0.0 && std::abs(p.y - PITCH_H / 2.0) > 75.0 && dgW < 430.0) sc += 0.30;
        bool targetWide = (t.role == Role::WM || t.role == Role::FB) && std::abs(t.y - PITCH_H / 2.0) > 125.0;
        bool passerCanFindWide = p.role == Role::CM || p.role == Role::CB || p.role == Role::FB;
        if (passerCanFindWide && targetWide && fp > 20.0 && d < 460.0 && bl <= 1 && receiverPressure <= 1) {
            double centralPasserBonus = std::abs(p.y - PITCH_H / 2.0) < 170.0 ? 0.10 : 0.0;
            double advancedBonus = carrierFinalThird ? 0.08 : 0.0;
            sc += 0.16 + centralPasserBonus + advancedBonus;
        }

        if (completion < 0.62) sc -= (0.62 - completion) * 0.55;
        sc -= bl * 0.12;
        if (fp > 0.0) {
            sc += 0.08 + (engine.configFor(p.team).passingDirectness - 50.0) / 100.0 * 0.20;
        } else {
            sc -= (engine.configFor(p.team).passingDirectness - 50.0) / 100.0 * 0.15;
        }

        ActionPurpose pur = ActionPurpose::Keep;
        if (keeperOutlet)                    pur = ActionPurpose::KeeperBackpass;
        else if (fp > 120.0 && bl == 0)     pur = ActionPurpose::Build;
        else if (fp > 40.0 && bl <= 1)      pur = ActionPurpose::Build;
        else if (std::abs(t.y - p.y) > 150.0) pur = ActionPurpose::Switch;
        else if (bl >= 2 && fp < -30.0)      pur = ActionPurpose::Clear;
        if (isCross)                          pur = ActionPurpose::Cross;
        else if (isCutback)                   pur = ActionPurpose::Cutback;

        if (pur == ActionPurpose::Switch) {
            bool carrierTop = (p.y < PITCH_H / 2.0);
            bool targetTop  = (t.y < PITCH_H / 2.0);
            if (carrierTop != targetTop) {
                int oppsNearCarrier = 0;
                int oppsNearTarget  = 0;
                for (auto& o : engine.state.players) {
                    if (o.team == p.team || o.role == Role::GK) continue;
                    bool onCarrierSide = carrierTop ? o.y < PITCH_H / 2.0 : o.y >= PITCH_H / 2.0;
                    if (onCarrierSide && dist(p.x, p.y, o.x, o.y) < 250.0) oppsNearCarrier++;
                    bool onTargetSide = targetTop ? o.y < PITCH_H / 2.0 : o.y >= PITCH_H / 2.0;
                    if (onTargetSide && dist(o.x, o.y, t.x, t.y) < 200.0) oppsNearTarget++;
                }
                if (oppsNearCarrier >= 3 && oppsNearTarget <= 1)      sc += 0.18;
                else if (oppsNearCarrier >= 2 && oppsNearTarget <= 2) sc += 0.10;
            }
        }

        double cr = attrFactor(p.attrs.creativity);
        if (pur == ActionPurpose::Build && bl > 0) sc += cr * 0.12;
        if (pur == ActionPurpose::Clear)           sc -= cr * 0.10;

        using RoleList = std::vector<Role>;
        static const std::unordered_map<Role, RoleList> rcMap = {
            {Role::GK, {}},
            {Role::CB, {Role::CM, Role::FB, Role::WM, Role::CF}},
            {Role::FB, {Role::CM, Role::WM, Role::CB}},
            {Role::CM, {Role::CF, Role::WM, Role::FB}},
            {Role::WM, {Role::CF, Role::CM}},
            {Role::CF, {Role::CM, Role::WM}},
        };
        auto it = rcMap.find(p.role);
        const RoleList& pref = (it != rcMap.end()) ? it->second : RoleList{};
        auto rii = std::find(pref.begin(), pref.end(), t.role);
        if (rii == pref.begin())           sc += 0.12;
        else if (rii == pref.begin() + 1)  sc += 0.06;
        if (t.role == p.role) sc -= (p.role == Role::CB || p.role == Role::FB) ? 0.30 : 0.20;

        if ((p.role == Role::CB || p.role == Role::FB) && (t.role == Role::CM || t.role == Role::WM) && fp > 0.0) sc += 0.08;

        bool passerFinalThird = (p.team == Team::Home) ? p.x > PITCH_W * 2.0 / 3.0 : p.x < PITCH_W / 3.0;
        double targetGoalDist = std::abs(t.x - goalXFor(p.team));
        if (passerFinalThird && targetGoalDist < 230.0) {
            if (t.role == Role::CF) sc += 0.24;
            else if (t.role == Role::WM && std::abs(t.y - PITCH_H / 2.0) < 210.0) sc += 0.10;
            else if (t.role == Role::CM) sc -= 0.16;
        }

        auto* assignment = engine.assignmentFor(t.id);
        if (assignment) {
            if (assignment->role == DefensiveTask::RunAhead)        sc += 0.12;
            if ((assignment->role == DefensiveTask::CrossLane || assignment->role == DefensiveTask::HoldWidth)
                && (t.role == Role::WM || t.role == Role::FB) && std::abs(t.y - PITCH_H / 2.0) > 120.0) sc += 0.08;
            if (assignment->role == DefensiveTask::Overlap && p.role != Role::CB) sc += 0.11;
            if (assignment->role == DefensiveTask::AdvanceMidfield) sc += 0.09;
            if (assignment->role == DefensiveTask::HoldWidth && std::abs(t.y - p.y) > 120.0) sc += 0.08;
        }

        double offsideLine = engine.offsideLineFor(p.team);
        double onsideGap = std::isnan(offsideLine) ? 1e9 : (offsideLine - t.x) * fd;

        bool wideOutletTarget = targetWide && fp > 20.0 && d < 500.0;
        double runnerForwardSpeed = t.vx * fd;
        bool targetAttacker = t.role == Role::CF || t.role == Role::WM;
        bool runnerIntent =
            (assignment && (assignment->role == DefensiveTask::RunAhead
                         || assignment->role == DefensiveTask::InsideRun
                         || assignment->role == DefensiveTask::Overlap
                         || assignment->role == DefensiveTask::CrossLane))
            || runnerForwardSpeed > 5.0;
        bool goodThroughWindow = targetAttacker
                              && runnerIntent
                              && fp > 30.0
                              && onsideGap > -12.0
                              && onsideGap < 170.0
                              && bl <= 1
                              && receiverPressure <= 1
                              && targetGoalDist < 480.0;
        bool releasedRunner = (assignment && (assignment->role == DefensiveTask::RunAhead
                                           || assignment->role == DefensiveTask::InsideRun
                                           || (assignment->role == DefensiveTask::CrossLane && t.role == Role::WM)))
                              || (assignment && assignment->role == DefensiveTask::Overlap && !wideOutletTarget)
                              || (p.role == Role::CM && targetAttacker && !wideOutletTarget);
        if (!isWideDelivery && releasedRunner && goodThroughWindow) {
            pur = ActionPurpose::Through;
            sc += 0.16 + attrFactor(p.attrs.creativity) * 0.15;
            if (runnerForwardSpeed > 10.0) sc += 0.07;
            if (onsideGap > 8.0 && onsideGap < 70.0) sc += 0.08;
            if (targetGoalDist < 250.0) sc += 0.08;
            if (receiverPressure > 0) sc -= 0.05;
        } else if (!isWideDelivery && releasedRunner && !runnerIntent && p.role == Role::CM) {
            sc -= 0.08;
        }
        if (wideOutletTarget && !isWideDelivery && onsideGap > 10.0 && bl <= 1 && receiverPressure <= 1) {
            pur = std::abs(t.y - p.y) > 120.0 ? ActionPurpose::Switch : ActionPurpose::Build;
            sc += 0.12 + attrFactor(p.attrs.creativity) * 0.08;
        }

        sc += std::min(holdTicks / 260.0, 0.20);

        if (receiverPressure >= 2) sc -= 0.25;
        if (per.pressureCount >= 2 && bl == 0) sc += 0.10;
        if (per.pressureCount >= 2 && bl >= 2) sc -= 0.15;

        if (p.role == Role::CM && t.role == Role::CF && receiverPressure >= 1 && bl <= 1)
            sc += attrFactor(p.attrs.creativity) * 0.10;

        auto& bb = engine.blackboards[GameEngine::teamIndex(p.team)];
        if (bb.oneTwo.has_value()
            && bb.oneTwo->from == t.id
            && bb.oneTwo->to == p.id
            && engine.state.clockMs < bb.oneTwo->expires)
            sc += 0.25;

        if (sc > 0.0) {
            r.push_back(Action{
                ActionType::Pass,
                clamp(sc, 0.0, 1.0),
                &t,
                0, 0,
                pur,
                ActionAudit{ d, fp, completion, bl, receiverPressure, 0, 0 }
            });
        }
    }
    double goalX = goalXFor(p.team);
    bool crossingCarrier = (p.role == Role::WM || p.role == Role::FB)
        && std::abs(p.y - PITCH_H / 2.0) > 75.0
        && std::abs(p.x - goalX) < 520.0;
    if (crossingCarrier) {
        Player* bestRunner = nullptr;
        double bestScore = -1e9;
        for (auto& t : engine.state.players) {
            if (t.team != p.team || t.id == p.id || t.role == Role::GK) continue;
            if (engine.isOffsideTarget(p, t)) continue;
            double targetGoalDist = std::abs(t.x - goalX);
            if (targetGoalDist > 430.0 || std::abs(t.y - PITCH_H / 2.0) > 255.0) continue;
            double d = dist(p.x, p.y, t.x, t.y);
            if (d < 65.0 || d > 520.0) continue;
            int pressure = 0;
            for (auto& o : engine.state.players) {
                if (o.team != p.team && o.role != Role::GK && dist(o.x, o.y, t.x, t.y) < 48.0) pressure++;
            }
            double central = 1.0 - std::abs(t.y - PITCH_H / 2.0) / 230.0;
            double roleBonus = 0.0;
            for (auto& a : engine.agents) { if (a->player.id == t.id) { roleBonus = a->roleBonusForPassTarget(); break; } }
            double goalThreat = targetGoalDist < 150.0 ? 0.34 : targetGoalDist < 210.0 ? 0.20 : targetGoalDist < 260.0 ? 0.06 : -0.08;
            double score = central + roleBonus + goalThreat + (300.0 - targetGoalDist) / 390.0 - pressure * 0.25 - d / 900.0;
            if (score > bestScore) { bestScore = score; bestRunner = &t; }
        }
        if (bestRunner && bestScore > -0.05) {
            double d = dist(p.x, p.y, bestRunner->x, bestRunner->y);
            double fp = (bestRunner->x - p.x) * fd;
            r.push_back(Action{ActionType::Pass, clamp(0.78 + bestScore * 0.20, 0.0, 0.98), bestRunner, 0, 0,
                               ActionPurpose::Cross, ActionAudit{d, fp, 0.72, 0, 0, 0, 0}});
        }
    }
    return r;
}

// ══════════════════════════════════════════════════════════════════════════════
// cs() — can-shoot
// ══════════════════════════════════════════════════════════════════════════════
