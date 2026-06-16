#include "agent.h"
#include "engine.h"
#include <optional>
#include <unordered_map>
#include <algorithm>

// ══════════════════════════════════════════════════════════════════════════════
// scorePassToTarget() — scores a single teammate as a pass target
// Returns nullopt if the target should be filtered out.
// ══════════════════════════════════════════════════════════════════════════════
std::optional<Action> PlayerAI::scorePassToTarget(Player& t, const Perception& per,
    double fd, double ownGoalX, double ownProgress, bool hasClearOutfieldOutlet,
    bool urgentKeeperNeed, bool movingTowardOwnGoal)
{
    const auto& p = player;

    // ── Gate checks ──
    if (t.sentOff) return std::nullopt;   // never pass to an ejected team-mate (parked off-pitch)
    bool keeperOutlet = t.role == Role::GK && urgentKeeperNeed && !hasClearOutfieldOutlet;
    if (t.role == Role::GK && !keeperOutlet) return std::nullopt;
    double d = dist(p.x, p.y, t.x, t.y);
    if (d < PASS_MIN_DISTANCE || d > (keeperOutlet ? PASS_MAX_DISTANCE_KEEPER : PASS_MAX_DISTANCE)) return std::nullopt;
    if (!keeperOutlet && engine.isOffsideTargetPerceived(p, t)) return std::nullopt;

    int bl = 0;
    double laneRisk = 0.0;
    double dx = t.x - p.x, dy = t.y - p.y, ls = dx * dx + dy * dy;
    if (ls < 1.0) return std::nullopt;

    int pointBlank = 0;
    for (auto& o : engine.state.players) {
        if (o.team == p.team || o.role == Role::GK || o.sentOff) continue;
        double t2 = clamp(((o.x - p.x) * dx + (o.y - p.y) * dy) / ls, 0.0, 1.0);
        double perp = std::sqrt((o.x - p.x - t2 * dx) * (o.x - p.x - t2 * dx)
                              + (o.y - p.y - t2 * dy) * (o.y - p.y - t2 * dy));
        if (perp < PASS_BLOCKER_PERP) bl++;
        // Defender who can STEP INTO the lane and cut it out — mirrors the defenders'
        // lane-interception (they now close ~90px/s). 50% of interceptions have ZERO
        // strict blockers (a defender steps in during flight), so the passer must
        // read these too: graded risk, full weight at the strict radius fading to 0
        // at ~112px, only counted mid-lane (the ends are pressure/point-blank).
        else if (perp < 112.0 && t2 > 0.10 && t2 < 0.92) laneRisk += clamp((112.0 - perp) / 76.0, 0.0, 1.0);
        // Opponent right on the boot at release: near-certain deflection that
        // the wide lane radius under-weighted (passes straight into a marker
        // 17px away looked like normal 1-blocker passes).
        if (perp < 17.0 && dist(o.x, o.y, p.x, p.y) < 42.0) pointBlank++;
    }
    if (bl >= 3 || (pointBlank > 0 && per.pressureCount < 2)) return std::nullopt;

    double fp = (t.x - p.x) * fd;
    double rs = attrFactor(p.attrs.passing);
    double rr = attrFactor(t.attrs.positioning);

    int receiverPressure = 0;
    for (auto& o : engine.state.players) {
        if (o.team != p.team && o.role != Role::GK && !o.sentOff && dist(o.x, o.y, t.x, t.y) < PASS_RECEIVER_PRESS_MAX) receiverPressure++;
    }
    if (receiverPressure >= 3) return std::nullopt;

    // ── Base scoring ──
    double completion = clamp(
        0.89 + rs * 0.10 + rr * 0.06 - d / PASS_DIST_NORMALIZATION * 0.28 - bl * 0.23
            - std::min(laneRisk, 2.2) * 0.10 - receiverPressure * 0.15 - (fp > 130.0 ? 0.05 : 0.0),
        0.08, 0.98);
    // play_it_long: direct sides gamble on lower-completion (longer) balls. 0 by
    // default => floor stays 0.44 => the no-directive match is unchanged.
    double longBall = engine.longBallBias[p.team == Team::Home ? 0 : 1];
    if (completion < 0.44 - longBall * 0.24) return std::nullopt;   // play_it_long: allow riskier long balls

    double progression = clamp(fp / 240.0, -0.5, 1.0);
    double turnoverCost = ((p.team == Team::Home) ? p.x < PITCH_W * 0.38 : p.x > PITCH_W * 0.62) ? 0.42 : 0.25;
    // passingDirectness (centred at 50): high -> reward forward passes more and
    // value safe recycling less (vertical, direct); low -> patient possession.
    double directness = engine.configFor(p.team).passingDirectness / 50.0; // 0..2, 1 at 50
    double sc = completion * (0.34 + std::max(0.0, progression) * 0.34 * directness) - (1.0 - completion) * turnoverCost;
    if (longBall > 0.0 && fp > 80.0) {                          // play_it_long: make the direct long ball win
        sc += longBall * (0.38 + std::min(fp, 360.0) / 360.0 * 0.46);   // longer => bigger reward (boosted to commit)
        sc += (1.0 - completion) * turnoverCost * longBall * 0.8;       // forgive most of the long-ball risk
    }
    double recycleMul = clamp(2.0 - directness, 0.4, 1.6); // direct sides recycle less
    // play_it_long also SUPPRESSES safe recycling — a long-ball side stops passing
    // it square and commits forward. This is what makes the order actually "commit".
    double recycleSuppress = clamp(1.0 - longBall * 0.7, 0.2, 1.0);
    bool safeConnector = completion > 0.74 && bl == 0 && receiverPressure == 0 && d < 300.0 && fp > -45.0 && fp < 95.0;
    bool recyclePass = completion > 0.78 && bl == 0 && receiverPressure == 0 && d < 260.0 && fp >= -80.0 && fp <= 25.0;
    if (safeConnector) sc += (ownProgress < PITCH_W * 0.68 ? 0.18 : 0.10) * recycleMul * recycleSuppress;
    if (recyclePass) sc += (per.pressureCount <= 1 ? 0.12 : 0.20) * recycleMul * recycleSuppress;
    if ((recyclePass || safeConnector) && engine.directiveBias[p.id].simplifyBias > 0.0)
        sc += engine.directiveBias[p.id].simplifyBias;          // "keep it simple / pass it around"
    if (keeperOutlet) {
        sc += 0.04 + per.pressureCount * 0.04 + (movingTowardOwnGoal ? 0.06 : 0.0);
        if (bl == 0) sc += 0.02;
    }
    if (t.id == lastPassTargetId) sc -= 0.18;

    if (recentPassTarget == t.id && engine.state.clockMs - recentPassTime < 3000.0) sc -= 0.10;

    if (bl == 0 && fp > 80.0) sc += completion > 0.70 ? 0.06 : 0.02;
    bool carrierFinalThird = (p.team == Team::Home) ? p.x > PITCH_W * 2.0 / 3.0 : p.x < PITCH_W / 3.0;
    if (!keeperOutlet && fp < -30.0) sc -= carrierFinalThird ? 0.28 : 0.16;
    if (!keeperOutlet && fp < -90.0) sc -= carrierFinalThird ? 0.30 : 0.18;
    if (!keeperOutlet && carrierFinalThird && per.pressureCount == 0 && fp < 0.0) sc -= 0.12;

    double dg2 = std::abs(p.x - (goalXFor(p.team)));
    if (dg2 < 200.0 && fp > 0.0 && d < 150.0) sc += 0.10;

    // ── Wide delivery classification ──
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
    bool aerialTarget = isWideDelivery
        && t.role == Role::CF
        && std::abs(t.y - PITCH_H / 2.0) < 150.0
        && boxTargetGoalDist > 95.0 && boxTargetGoalDist < 210.0
        && fp > -15.0
        && receiverPressure <= 1;
    bool cutbackTarget = isWideDelivery
        && std::abs(p.y - PITCH_H / 2.0) > 110.0
        && !aerialTarget
        && centralBoxTarget
        && (t.role == Role::CF || t.role == Role::CM || t.role == Role::WM)
        && fp < 75.0;
    // cross_early extends the cross window deeper (whip it in early, don't dribble
    // to the byline first).
    double crossRange = engine.directiveBias[p.id].crossEarly ? 420.0 : 340.0;
    bool isCross   = isWideDelivery && !cutbackTarget && dgW < crossRange
        && std::abs(p.y - PITCH_H / 2.0) > 120.0 && (fp > -45.0 || aerialTarget);
    bool isCutback = isWideDelivery && !isCross;

    // ── Cross / cutback scoring ──
    if (isCross) {
        sc += 0.26;
        if (engine.directiveBias[p.id].crossEarly) sc += 0.55;   // "whip it in early"
        if (t.role == Role::CF) sc += 0.30;
        else if (t.role == Role::WM) sc += 0.10;
        else if (t.role == Role::CM) sc -= 0.34;
        bool headerZone = boxTargetGoalDist > 85.0 && boxTargetGoalDist < 205.0
            && std::abs(t.y - PITCH_H / 2.0) < 165.0;
        if (headerZone && t.role == Role::CF && receiverPressure <= 1) sc += 0.24;
        if (headerZone && t.role == Role::WM && receiverPressure == 0) sc += 0.10;
        if (aerialTarget) sc += 0.24;
        if (boxTargetGoalDist > 245.0) sc -= 0.22;
        if (std::abs(t.y - PITCH_H / 2.0) > 185.0) sc -= 0.12;
    }
    if (isCutback) {
        // The cutback is the wingers' assist to arriving mids — the main route
        // for non-CF goals, so it should outscore yet another cross.
        sc += cutbackTarget ? 0.54 : 0.18;
        if (cutbackTarget && (t.role == Role::CM || t.role == Role::WM)) sc += 0.12;
        if (cutbackTarget && receiverPressure == 0 && bl == 0) sc += 0.12;
    }

    bool boxCombination = carrierFinalThird
        && centralBoxTarget
        && (t.role == Role::CF || t.role == Role::WM || t.role == Role::CM)
        && receiverPressure <= 1
        && bl <= 1
        && completion >= 0.56;
    if (boxCombination) {
        sc += 0.34;
        if (receiverPressure == 0 && bl == 0) sc += 0.12;
        if (t.role == Role::CF) sc += 0.10;
    }

    // ── Role-based target bonuses ──
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
    if (p.role == Role::WM && dgW < 450.0 && t.role == Role::CF && std::abs(t.y - PITCH_H / 2.0) < 230.0) sc += 0.24;
    if (p.role == Role::WM && fp > 10.0 && std::abs(p.y - PITCH_H / 2.0) > 100.0 && bl <= 2) sc += 0.32;
    if (p.role == Role::FB && fp > 0.0 && std::abs(p.y - PITCH_H / 2.0) > 75.0 && dgW < 430.0) sc += 0.30;
    bool targetWide = (t.role == Role::WM || t.role == Role::FB) && std::abs(t.y - PITCH_H / 2.0) > 125.0;
    bool passerCanFindWide = p.role == Role::CM || p.role == Role::CB || p.role == Role::FB;
    if (passerCanFindWide && targetWide && fp > 20.0 && d < 460.0 && bl <= 1 && receiverPressure <= 1) {
        double centralPasserBonus = std::abs(p.y - PITCH_H / 2.0) < 170.0 ? 0.10 : 0.0;
        double advancedBonus = carrierFinalThird ? 0.08 : 0.0;
        sc += 0.16 + centralPasserBonus + advancedBonus;
    }

    // ── Completion penalties ──
    if (completion < 0.62) sc -= (0.62 - completion) * 0.55;
    // Unforced-giveaway guard: with NO pressure on the ball there is no excuse
    // to force a genuinely LOOSE pass — recycle and keep it. Targets only the
    // clearly-risky balls so it doesn't make an unpressured carrier passive.
    if (per.pressureCount == 0 && completion < 0.64) sc -= (0.64 - completion) * 0.55;
    if (fp > 110.0 && completion < 0.70) sc -= 0.10;
    if (fp > 180.0 && completion < 0.76) sc -= 0.08;
    sc -= bl * 0.12;
    sc -= std::min(laneRisk, 2.2) * 0.075;   // steer away from lanes a defender can step into (see pass audit)
    if (fp > 0.0) {
        sc += 0.08 + (engine.configFor(p.team).passingDirectness - 50.0) / 100.0 * 0.20;
    } else {
        sc -= (engine.configFor(p.team).passingDirectness - 50.0) / 100.0 * 0.15;
    }

    // ── Purpose classification ──
    ActionPurpose pur = ActionPurpose::Keep;
    if (keeperOutlet)                    pur = ActionPurpose::KeeperBackpass;
    else if (fp > 120.0 && bl == 0)     pur = ActionPurpose::Build;
    else if (fp > 40.0 && bl <= 1)      pur = ActionPurpose::Build;
    else if (std::abs(t.y - p.y) > 150.0) pur = ActionPurpose::Switch;
    else if (bl >= 2 && fp < -30.0)      pur = ActionPurpose::Clear;
    if (isCross)                          pur = ActionPurpose::Cross;
    else if (isCutback)                   pur = ActionPurpose::Cutback;

    // ── Switch bonus ──
    if (pur == ActionPurpose::Switch) {
        sc += engine.directiveBias[p.id].switchBias;            // "switch the play / spread it"
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

    // ── Creativity / added time / role preference ──
    double cr = attrFactor(p.attrs.creativity);
    if (pur == ActionPurpose::Build && bl > 0) sc += cr * 0.12;
    if (pur == ActionPurpose::Clear)           sc -= cr * 0.10;

    if (engine.phase.addedTimeActive) {
        bool inDefThird = (p.team == Team::Home) ? p.x < THIRD_1 : p.x > THIRD_2;
        if (inDefThird) {
            bool targetExitsThird = (p.team == Team::Home) ? t.x > THIRD_1 : t.x < THIRD_2;
            if (targetExitsThird) sc += 0.30;
            else if (fp > 80.0) sc += 0.15;
        }
    }

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

    // ── Final third target bonuses ──
    bool passerFinalThird = (p.team == Team::Home) ? p.x > PITCH_W * 2.0 / 3.0 : p.x < PITCH_W / 3.0;
    double targetGoalDist = std::abs(t.x - goalXFor(p.team));
    if (passerFinalThird && targetGoalDist < 230.0) {
        if (t.role == Role::CF) sc += 0.24;
        else if (t.role == Role::WM && std::abs(t.y - PITCH_H / 2.0) < 210.0) sc += 0.10;
        else if (t.role == Role::CM) sc -= 0.16;
    }

    // ── Assignment-based bonuses ──
    auto* assignment = engine.assignmentFor(t.id);
    if (assignment) {
        if (assignment->role == DefensiveTask::RunAhead)        sc += 0.12;
        if ((assignment->role == DefensiveTask::CrossLane || assignment->role == DefensiveTask::HoldWidth)
            && (t.role == Role::WM || t.role == Role::FB) && std::abs(t.y - PITCH_H / 2.0) > 120.0) sc += 0.08;
        if (assignment->role == DefensiveTask::Overlap && p.role != Role::CB) sc += 0.11;
        if (assignment->role == DefensiveTask::AdvanceMidfield) sc += 0.09;
        if (assignment->role == DefensiveTask::HoldWidth && std::abs(t.y - p.y) > 120.0) sc += 0.08;
    }

    // ── Through ball / wide outlet ──
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
                          && onsideGap < 210.0
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
        // Slide a runner in behind for a 1-on-1 (converts ~40% vs a 4% pot-shot).
        sc += 0.24 + attrFactor(p.attrs.creativity) * 0.15;
        // Quick transition: hit the runner FAST while the defence is unset.
        // counter_attack amplifies this (and the matching off-ball-run bonus).
        if (engine.state.clockMs < engine.transitionUntilMs)
            sc += 0.18 * (1.0 + engine.counterAttackBonus[p.team == Team::Home ? 0 : 1])
                       * clamp((engine.transitionUntilMs - engine.state.clockMs) / 400.0, 0.0, 1.0);
        if (runnerForwardSpeed > 10.0) sc += 0.07;
        if (onsideGap > 8.0 && onsideGap < 70.0) sc += 0.08;
        if (targetGoalDist < 250.0) sc += 0.14;
        if (receiverPressure > 0) sc -= 0.05;
    } else if (!isWideDelivery && releasedRunner && !runnerIntent && p.role == Role::CM) {
        sc -= 0.08;
    }
    if (wideOutletTarget && !isWideDelivery && onsideGap > 10.0 && bl <= 1 && receiverPressure <= 1) {
        pur = std::abs(t.y - p.y) > 120.0 ? ActionPurpose::Switch : ActionPurpose::Build;
        sc += 0.12 + attrFactor(p.attrs.creativity) * 0.08;
    }

    // ── Final adjustments ──
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
        && engine.state.clockMs < bb.oneTwo->expires) {
        sc += 0.30;
        // The wall pass: reward returning it into the original passer's run.
        bool runnerInStride = t.vx * fdFor(p.team) > 12.0;
        if (runnerInStride && fp > 10.0) sc += 0.14;
    }

    // target_player directive: steer this passer's distribution toward a man.
    if (engine.directiveBias[p.id].passTargetId == t.id)
        sc += engine.directiveBias[p.id].passTargetBias;

    if (sc <= 0.0) return std::nullopt;

    return Action{
        ActionType::Pass,
        clamp(sc, 0.0, 1.0),
        &t,
        0, 0,
        pur,
        ActionAudit{ d, fp, completion, bl, receiverPressure, 0, 0 }
    };
}
