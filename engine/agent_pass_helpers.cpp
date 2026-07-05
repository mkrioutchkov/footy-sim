#include "agent.h"
#include "agent_helpers.h"
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
    // The keeper is a valid pass target when urgently needed, OR as a deliberate
    // SAFE recycle for a pressed defender / deep midfielder in his own third — he
    // then distributes safely (play out from the back). The score below keeps it
    // from being spammed: it only wins when the forward options are genuinely poor.
    bool nearOwnThirdForGk = ownProgress < PITCH_W * 0.42;
    bool keeperRecycle = nearOwnThirdForGk && per.pressureCount >= 1 && !hasClearOutfieldOutlet
        && isDefenderLike();
    bool keeperOutlet = t.role == Role::GK && ((urgentKeeperNeed && !hasClearOutfieldOutlet) || keeperRecycle);
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
        if (!isActiveOpponent(o, p.team)) continue;
        double t2 = clamp(((o.x - p.x) * dx + (o.y - p.y) * dy) / ls, 0.0, 1.0);
        double perp = std::sqrt((o.x - p.x - t2 * dx) * (o.x - p.x - t2 * dx)
                              + (o.y - p.y - t2 * dy) * (o.y - p.y - t2 * dy));
        // STEP-IN realism (user 0:40 Kovac + the Okafor pass): a defender CLOSING on the lane reaches
        // FURTHER than his static perp suggests — he'll be nearer by the time the ball arrives. So a
        // closer's effective BLOCKER radius extends with his speed TOWARD the closest-approach point
        // (Kovac stepped in from 40px at ~48px/s and cut a slow build-up ball). A defender drifting
        // AWAY keeps the static radius, so a pass into a vacating lane isn't over-penalised. The graded
        // mid-lane risk (50% of interceptions are a step-in, ZERO strict blockers) is otherwise intact.
        double cx = p.x + t2 * dx, cy = p.y + t2 * dy;
        double tlx = cx - o.x, tly = cy - o.y, tld = std::hypot(tlx, tly);
        double closing = tld > 1.0 ? (o.vx * tlx + o.vy * tly) / tld : 0.0;   // px/s toward the lane
        double effBlocker = PASS_BLOCKER_PERP + clamp(closing / 50.0, 0.0, 1.0) * 13.0;
        if (perp < effBlocker) bl++;
        else if (perp < 112.0 && t2 > 0.10 && t2 < 0.92) laneRisk += clamp((112.0 - perp) / 76.0, 0.0, 1.0);
        // Opponent right on the boot at release: near-certain deflection that
        // the wide lane radius under-weighted (passes straight into a marker
        // 17px away looked like normal 1-blocker passes).
        if (perp < 17.0 && dist(o.x, o.y, p.x, p.y) < 42.0) pointBlank++;
    }
    if (bl >= 3 || (pointBlank > 0 && per.pressureCount < 2)) return std::nullopt;

    double fp = pitch::forwardGain(p.x, t.x, p.team);
    double rs = attrFactor(p.attrs.passing);
    double rr = attrFactor(t.attrs.positioning);

    int receiverPressure = 0;
    for (auto& o : engine.state.players) {
        if (o.team != p.team && o.role != Role::GK && !o.sentOff && dist(o.x, o.y, t.x, t.y) < PASS_RECEIVER_PRESS_MAX) receiverPressure++;
    }
    if (receiverPressure >= 3) return std::nullopt;

    // ── Base scoring ──
    // Chip-aware blocker pricing: passBallTo already LOFTS a blocked lane at
    // range (blockers>0 && d>120 => elevation), so bodies on a longer lane
    // cost less than the flat-ball price said — the lofted diagonal over the
    // line was "quite likely at this level" (watched replay 0:50) yet scored
    // as if it would be cut on the ground. Short passes keep the full price
    // (no room to get it up and over).
    double blCost = bl * (d > 170.0 ? 0.18 : 0.23);
    double completion = clamp(
        0.89 + rs * 0.10 + rr * 0.06 - d / PASS_DIST_NORMALIZATION * 0.28 - blCost
            - std::min(laneRisk, 2.2) * 0.10 - receiverPressure * 0.15 - (fp > 130.0 ? 0.05 : 0.0),
        0.08, 0.98);
    // play_it_long: direct sides gamble on lower-completion (longer) balls. 0 by
    // default => floor stays 0.44 => the no-directive match is unchanged.
    double longBall = engine.teamTactics[teamIndex(p.team)].longBallBias;
    if (completion < 0.44 - longBall * 0.24) return std::nullopt;   // play_it_long: allow riskier long balls

    // ── G1 BUILD-UP LOOK (user 2026-06-27: "still prototype, make it look better") ──
    // In our own build-up third the defenders were pinging mid-completion balls to each
    // other that get picked off — reads aimless, not "patiently probe for a gap". Demand
    // a HIGHER completion floor here UNLESS the pass genuinely breaks a line into a real
    // gap (forward, unmarked receiver, clean lane). The keeper recycle (keeperOutlet) is
    // excluded so there is always a safe valve — this can't stall the build-up, only make
    // it pick the safe keep until a gap opens. play_it_long sides bypass it (they commit).
    if (!keeperOutlet && longBall <= 0.0 && ownProgress < PITCH_W * 0.42) {
        bool breaksLine = fp > 120.0 && receiverPressure == 0 && bl == 0 && laneRisk < 0.8;
        double buildFloor = breaksLine ? 0.50 : 0.66;
        if (completion < buildFloor) return std::nullopt;
    }

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
    // slow_it_down (team-wide): keep the ball, take no risks — reward the safe
    // option and shun low-completion balls so the side knocks it around. Dedicated
    // hook because the dial deltas were swamped by the clamp. 0 => no effect.
    double slowT = engine.teamTactics[teamIndex(p.team)].slowTempo;
    if (slowT > 0.0) {
        if (safeConnector || recyclePass) sc += slowT * 0.16;
        sc -= slowT * (1.0 - completion) * 0.40;
    }
    // PATIENT BUILD-UP (defensive-shape redesign §3): completely unpressed in our
    // own half — CIRCULATE rather than force it. Reward the safe keep and shun the
    // risky/forward ball, so the side strings a long possession instead of gifting it
    // with a hopeful direct pass. Pairs with the mid-block + forwards-drop: the
    // opponent holds off, so pressureCount==0 happens often here and 20+ moves form.
    // G1: also reward safe retention under LIGHT pressure (==1), not just fully unpressed
    // — that is exactly when the aimless risky ping happened. Scale the keep-bonus down a
    // touch when pressed so the side still progresses when a real forward gap is on.
    if (per.pressureCount <= 1 && ownProgress < PITCH_W * 0.5) {
        double pressScale = per.pressureCount == 0 ? 1.0 : 0.65;
        if (safeConnector || recyclePass) sc += 0.30 * pressScale;
        sc -= (1.0 - completion) * 0.45;
    }
    if (keeperOutlet) {
        sc += 0.04 + per.pressureCount * 0.04 + (movingTowardOwnGoal ? 0.06 : 0.0);
        if (bl == 0) sc += 0.02;
    }
    if (t.id == lastPassTargetId) sc -= 0.18;

    if (recentPassTarget == t.id && engine.state.clockMs - recentPassTime < 3000.0) sc -= 0.10;

    if (bl == 0 && fp > 80.0) sc += completion > 0.70 ? 0.06 : 0.02;
    bool carrierFinalThird = pitch::inFinalThird(p.x, p.team);
    // USERWATCH A1 (~3:23: carrier stripped with a safe backpass on): under HEAVY pressure a
    // SECURE outlet (unmarked teammate + clear lane) beats getting dispossessed — waive the
    // backward-pass penalty + add a retention bonus so the carrier plays safe instead of forcing it.
    bool securePressuredOutlet = per.pressureCount >= 2 && per.nearestOpponentDist < 40.0
                              && receiverPressure == 0 && bl == 0;
    if (!keeperOutlet && !securePressuredOutlet && fp < -30.0) sc -= carrierFinalThird ? 0.28 : 0.16;
    if (!keeperOutlet && !securePressuredOutlet && fp < -90.0) sc -= carrierFinalThird ? 0.30 : 0.18;
    if (!keeperOutlet && carrierFinalThird && per.pressureCount == 0 && fp < 0.0) sc -= 0.12;
    if (securePressuredOutlet) sc += 0.18;

    double dg2 = std::abs(p.x - (goalXFor(p.team)));
    if (dg2 < 200.0 && fp > 0.0 && d < 150.0) sc += 0.10;

    // ── Wide delivery classification ──
    double dgW = dg2;
    bool isWideDelivery = isWidePlayer()
        && dgW < 430.0
        && pitch::lateralFromCenter(p.y) > 75.0
        && std::abs(t.x - (goalXFor(p.team))) < 310.0
        && pitch::lateralFromCenter(t.y) < 210.0
        && fp > -120.0;

    double boxTargetGoalDist = pitch::distToOppGoal(t.x, p.team);
    // §C Stage 2: a DEEP (byline) carrier can cut back to a now-onside CLOSE runner — once b.x is deep
    // the near-post runner is legally onside-close (max(line,b.x)=b.x), so widen the cutback target zone
    // (goalDist>45, y<215) for a deep carrier to let that 6-yard tap-in route qualify for the +0.54 cutback.
    bool deepCarrier = dgW < 140.0;
    // NOTE: the 245 outer gate means the +0.54 cutback premium also pays out on
    // ~24m lay-backs (receiver median tgd 250 at delivery, only 3/48 inside the
    // 175 first-time-finish gate — 2026-07-02 audit). Tightening was A/B'd
    // TWICE and rejected twice: 190 pre-box-burst (carriers switched to whips,
    // headed 25%->36%), and 200 post-box-burst (2026-07-02, 48 paired seeds:
    // close goals 10->6 — WRONG direction — cutbacks 41->34/match, crosses up).
    // The gate is not the lever: receivers are simply never in the band at
    // decision time despite box-burst SPEED. Stage 2 must make the runner's
    // POSITION TARGET sit in the 80-140 band earlier in the move (positioning
    // candidates + arbitration weight), then re-test this gate.
    bool centralBoxTarget = pitch::lateralFromCenter(t.y) < (deepCarrier ? 215.0 : 185.0)
        && boxTargetGoalDist > (deepCarrier ? 45.0 : 75.0) && boxTargetGoalDist < 245.0;
    bool aerialTarget = isWideDelivery
        && t.role == Role::CF
        && pitch::lateralFromCenter(t.y) < 150.0
        && boxTargetGoalDist > 95.0 && boxTargetGoalDist < 210.0
        && fp > -15.0
        && receiverPressure <= 1;
    bool cutbackTarget = isWideDelivery
        && pitch::lateralFromCenter(p.y) > 110.0
        && !aerialTarget
        && centralBoxTarget
        && (t.role == Role::CF || t.role == Role::CM || t.role == Role::WM)
        && fp < 75.0;
    // cross_early extends the cross window deeper (whip it in early, don't dribble
    // to the byline first).
    double crossRange = engine.directiveBias[p.id].crossEarly ? 420.0 : 340.0;
    // §C byline-carry: an UNPRESSED wide carrier still far out should carry to the BYLINE (the dribble
    // byline-seek) rather than crossing early -> shrink the cross window so the deeper carry + onside
    // cutback wins. Pressed / crossEarly-directive carriers still whip it in early (unchanged).
    if (isWideDelivery && per.pressureCount == 0 && pitch::lateralFromCenter(p.y) > 120.0
        && dgW > 110.0 && !engine.directiveBias[p.id].crossEarly)
        crossRange = 215.0;
    bool isCross   = isWideDelivery && !cutbackTarget && dgW < crossRange
        && pitch::lateralFromCenter(p.y) > 120.0 && (fp > -45.0 || aerialTarget);
    bool isCutback = isWideDelivery && !isCross;

    // BP1 (backward-pass audit, user "180-degree unrealistic passes"): the scorer never read facing,
    // so a BLIND pass played behind where the passer is LOOKING scored like any other. Penalise ONLY a
    // genuinely blind backpass (>135deg off the facing) in CALM possession that is NOT a sanctioned or
    // creative backward ball — keeper outlet, secure pressured escape, cross, and CUTBACK are all legit
    // backward and excluded (a cutback is >135deg off the facing but a prime chance; the blunt version
    // that hit cutbacks cost goals and was reverted). Through-balls are forward, so they never qualify.
    if (!keeperOutlet && !securePressuredOutlet && !isCross && !isCutback && per.pressureCount == 0) {
        double pdl = std::sqrt(ls);
        double facingDot = pdl > 1.0 ? (dx * std::cos(p.facing) + dy * std::sin(p.facing)) / pdl : 1.0;
        if (facingDot < -0.7) sc -= (-facingDot - 0.7) / 0.3 * 0.30;   // 0 at ~135deg -> -0.30 at a true 180deg no-looker
    }

    // ── Cross / cutback scoring ──
    if (isCross) {
        sc += 0.05;   // was 0.26 — this helper is the 2nd cross source; trimmed with the wide-carrier override to pull total crosses toward realistic (~40-60/match)
        // A crowded box makes the cross a coin-flip turnover — count the bodies
        // and recycle/pull it back instead (mirrors the override's crowd gate).
        {
            double gxc = goalXFor(p.team);
            int boxDefenders = 0;
            for (auto& o : engine.state.players) {
                if (!isActiveOpponent(o, p.team)) continue;
                if (std::abs(o.x - gxc) < 200.0 && pitch::lateralFromCenter(o.y) < 170.0) boxDefenders++;
            }
            sc -= std::max(0, boxDefenders - 2) * 0.10;
        }
        if (engine.directiveBias[p.id].crossEarly) sc += 0.55;   // "whip it in early"
        if (t.role == Role::CF) sc += 0.30;
        else if (t.role == Role::WM) sc += 0.10;
        else if (t.role == Role::CM) sc -= 0.34;
        bool headerZone = boxTargetGoalDist > 85.0 && boxTargetGoalDist < 205.0
            && pitch::lateralFromCenter(t.y) < 165.0;
        if (headerZone && t.role == Role::CF && receiverPressure <= 1) sc += 0.24;
        if (headerZone && t.role == Role::WM && receiverPressure == 0) sc += 0.10;
        if (aerialTarget) sc += 0.24;
        if (boxTargetGoalDist > 245.0) sc -= 0.22;
        if (pitch::lateralFromCenter(t.y) > 185.0) sc -= 0.12;
    }
    if (isCutback) {
        // The cutback is the wingers' assist to arriving mids — the main route
        // for non-CF goals, so it should outscore yet another cross.
        sc += cutbackTarget ? 0.54 : 0.18;
        if (cutbackTarget && (t.role == Role::CM || t.role == Role::WM)) sc += 0.12;
        if (cutbackTarget && receiverPressure == 0 && bl == 0) sc += 0.12;
        // Spot-band preference (ADDITIVE — the deep lay-back fallback stays, see
        // the rejected 245->190 gate note above): when a box-burst runner has
        // actually arrived in the penalty-spot band, HE gets the ball — the
        // pull-back to an arriving runner is the chance, the 24m lay-back is
        // just recycling. This is what converts burst runs into close shots
        // via the first-time-finish path.
        if (cutbackTarget && boxTargetGoalDist < 165.0
            && pitch::lateralFromCenter(t.y) < 120.0) sc += 0.22;
        if (cutbackTarget) sc += engine.directiveBias[p.id].cutbackBias;   // "pull it back" directive
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
        else if (t.role == Role::CM && pitch::lateralFromCenter(t.y) < 150.0) sc += 0.06;
    }
    if ((p.role == Role::CM || p.role == Role::WM || p.role == Role::FB)
        && t.role == Role::CF
        && pitch::lateralFromCenter(t.y) < 175.0
        && boxTargetGoalDist < 245.0
        && fp > -35.0
        && bl <= 1
        && receiverPressure <= 1) {
        sc += carrierFinalThird ? 0.30 : 0.20;
    }
    if (isCutback && receiverPressure <= 1 && bl <= 1) sc += 0.08;   // was cross+cutback; the cutback is the one to reward
    if (isWideMidfielder() && dgW < 450.0 && t.role == Role::CF && pitch::lateralFromCenter(t.y) < 230.0) sc += 0.24;
    if (isWideMidfielder() && fp > 10.0 && pitch::lateralFromCenter(p.y) > 100.0 && bl <= 2) sc += 0.26;   // wide-funnel sugar trimmed 0.32
    if (isFullBack() && fp > 0.0 && pitch::lateralFromCenter(p.y) > 75.0 && dgW < 430.0) sc += 0.24;       // trimmed 0.30
    bool targetWide = roles::isWide(t.role) && pitch::lateralFromCenter(t.y) > 125.0;
    bool passerCanFindWide = isDefenderLike();
    if (passerCanFindWide && targetWide && fp > 20.0 && d < 460.0 && bl <= 1 && receiverPressure <= 1) {
        double centralPasserBonus = pitch::lateralFromCenter(p.y) < 170.0 ? 0.10 : 0.0;
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
    sc -= bl * (d > 170.0 ? 0.09 : 0.12);   // chippable range: the lofted ball goes over (see blCost note)
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

    if (engine.phase.addedTimeActive && engine.phase.half == 2) {   // 2nd-half stoppage only
        bool inDefThird = pitch::inOwnDefensiveThird(p.x, p.team);
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
    if (t.role == p.role) sc -= isDefenderRole() ? 0.30 : 0.20;

    if (isDefenderRole() && (t.role == Role::CM || t.role == Role::WM) && fp > 0.0) sc += 0.08;

    // ── Final third target bonuses ──
    bool passerFinalThird = pitch::inFinalThird(p.x, p.team);
    double targetGoalDist = pitch::distToOppGoal(t.x, p.team);
    if (passerFinalThird && targetGoalDist < 230.0) {
        if (t.role == Role::CF) sc += 0.24;
        else if (t.role == Role::WM && pitch::lateralFromCenter(t.y) < 210.0) sc += 0.10;
        else if (t.role == Role::CM) sc -= 0.16;
    }

    // ── Assignment-based bonuses ──
    auto* assignment = engine.assignmentFor(t.id);
    if (assignment) {
        if (assignment->role == DefensiveTask::RunAhead)        sc += 0.12;
        if ((assignment->role == DefensiveTask::CrossLane || assignment->role == DefensiveTask::HoldWidth)
            && roles::isWide(t.role) && pitch::lateralFromCenter(t.y) > 120.0) sc += 0.08;
        if (assignment->role == DefensiveTask::Overlap && !isCenterBack()) sc += 0.11;
        if (assignment->role == DefensiveTask::AdvanceMidfield) sc += 0.09;
        if (assignment->role == DefensiveTask::HoldWidth && std::abs(t.y - p.y) > 120.0) sc += 0.08;
    }

    // ── Through ball / wide outlet ──
    double offsideLine = engine.offsideLineFor(p.team);
    double onsideGap = std::isnan(offsideLine) ? 1e9 : (offsideLine - t.x) * fd;

    bool wideOutletTarget = targetWide && fp > 20.0 && d < 500.0;
    // Runner intent = speed TOWARD THE GOAL, not raw x-speed: a winger's
    // diagonal cut between the centre-backs (watched replay 0:46 — full-tilt
    // run, near-zero vx) never counted as a run under the old t.vx * fd, so
    // the first-time-shot through ball was never even rated.
    double runnerForwardSpeed = t.vx * fd;
    {
        // Only a genuine SPRINT that is mostly goalward counts — crediting any
        // radial drift flooded the match with hopeful through balls (first cut
        // of this change: 4.6 -> 14.9 attempts per 10min, completion -2.6pts).
        double tgx = goalXFor(p.team) - t.x, tgy = PITCH_H / 2.0 - t.y;
        double tgl = std::hypot(tgx, tgy);
        double spd = std::hypot(t.vx, t.vy);
        if (tgl > 1.0 && tgl < 320.0 && spd > 34.0) {
            double radial = (t.vx * tgx + t.vy * tgy) / tgl;
            if (radial > spd * 0.55) runnerForwardSpeed = std::max(runnerForwardSpeed, radial);
        }
    }
    bool targetAttacker = roles::isAttacker(t.role);

    // ── Killer-ball projection ── passBallTo(through=true) LEADS the runner
    // (velocity x 1.32 over the flight, plus 90-210px straight forward), but
    // every through-ball gate below judged his CURRENT spot — so the obvious
    // slide-in ball kept failing on margins. Watched replay: 1:15, WM on the
    // ball, CF at full tilt into the CB channel — pass never rated (fp 26 vs
    // gate 30, goalDist 372 vs 255, marker counted that he was outrunning);
    // 5:37, the led lane to the sprinting winger was clean but the engine saw
    // only the covered straight lane and threw it into the interceptor. For a
    // MOVING runner, judge pressure/blockers/range at the projected receive
    // point, with the defenders projected too. Offside stays judged at the
    // CURRENT position — that is the law, and the executed ball is released
    // this tick.
    double fpEff = fp;
    double goalDistEff = targetGoalDist;
    int rpEff = receiverPressure;
    int blEff = bl;
    double rxEff = t.x, ryEff = t.y;   // projected receive point (falls back to the current spot)
    if ((targetAttacker || t.role == Role::CM) && runnerForwardSpeed > 15.0) {
        double lead = clamp(d / 300.0 + 0.3, 0.4, 1.1);
        double px2 = clamp(t.x + t.vx * lead, 12.0, PITCH_W - 12.0);
        double py2 = clamp(t.y + t.vy * lead, 12.0, PITCH_H - 12.0);
        rxEff = px2; ryEff = py2;
        fpEff = pitch::forwardGain(p.x, px2, p.team);
        goalDistEff = pitch::distToOppGoal(px2, p.team);
        rpEff = 0;
        blEff = 0;
        double dx2 = px2 - p.x, dy2 = py2 - p.y, ls2 = dx2 * dx2 + dy2 * dy2;
        for (auto& o : engine.state.players) {
            if (o.team == p.team || o.sentOff) continue;
            double ox = o.x + o.vx * lead, oy = o.y + o.vy * lead;
            if (o.role != Role::GK && dist(ox, oy, px2, py2) < PASS_RECEIVER_PRESS_MAX) rpEff++;
            if (ls2 > 1.0 && o.role != Role::GK) {
                double t3 = clamp(((ox - p.x) * dx2 + (oy - p.y) * dy2) / ls2, 0.0, 1.0);
                double perp = std::hypot(ox - p.x - t3 * dx2, oy - p.y - t3 * dy2);
                if (perp < PASS_BLOCKER_PERP) blEff++;
            }
        }
    }
    // USERWATCH A3 (Leon Kovac ~4:33 missed it): a teammate CLEAR & ONSIDE in behind with an
    // open lane is a through-ball target even BEFORE he sprints — the obvious killer pass a
    // human expects. Strict gates (unmarked, lane fully clear, genuine range) so it never spams.
    bool clearOnsideAttacker = targetAttacker && rpEff == 0 && blEff == 0
                            && onsideGap > 3.0 && onsideGap < 170.0 && goalDistEff < 430.0;
    bool runnerIntent =
        (assignment && (assignment->role == DefensiveTask::RunAhead
                     || assignment->role == DefensiveTask::InsideRun
                     || assignment->role == DefensiveTask::Overlap
                     || assignment->role == DefensiveTask::CrossLane))
        || runnerForwardSpeed > 26.0
        || clearOnsideAttacker;
    bool goodThroughWindow = targetAttacker
                          && runnerIntent
                          && fpEff > 30.0
                          && onsideGap > -12.0
                          && onsideGap < 170.0        // was 130; the 1:15 channel runner sat at 133
                          && blEff <= 1
                          && rpEff <= 1
                          && goalDistEff < 300.0;   // was 480 (nearly half-pitch), then 255 judged at the CURRENT spot; 300 at the PROJECTED receive point is the same real-ball philosophy
    bool releasedRunner = (assignment && (assignment->role == DefensiveTask::RunAhead
                                       || assignment->role == DefensiveTask::InsideRun
                                       || (assignment->role == DefensiveTask::CrossLane && t.role == Role::WM)))
                          || (assignment && assignment->role == DefensiveTask::Overlap && !wideOutletTarget)
                          || (isCentralMidfielder() && targetAttacker && !wideOutletTarget)
                          || clearOnsideAttacker;
    // USER #2 "PASSES INTO SPACE" (Park North vs max ~2:21, winger ran in behind UNFED): the
    // genuinely-CLEAN killer ball (clearOnsideAttacker = an unmarked, ONSIDE CF/WM in behind with
    // a clear lane, <430 to goal) should fire EVEN at moderate fp, which goodThroughWindow's fp>30
    // gate blocks. It's strictly gated (receiverPressure==0, bl==0, onside) so it never adds a
    // hopeful punt — the broad gate-relax was REVERTED for cratering goals; THIS plays only the
    // clean 1-on-1, with a boost so it beats the safe square pass / the take-on.
    bool cleanKillerBall = !isWideDelivery && clearOnsideAttacker;
    // CHANCE-CREATION (goals-fine-to-raise from better creation): a CM deliberately sent into the
    // box (AdvanceMidfield, assignAttackingRoles) who arrives UNMARKED, ONSIDE, central and in a
    // clean lane is a legit killer-ball recipient. The run-STATE already ships (engine_defense.cpp),
    // but the Through reward above was CF/WM-only (clearOnsideAttacker/goodThroughWindow both gate on
    // targetAttacker), so the slip to an arriving CM was never rewarded and lost to a safe recycle.
    // Strict gates (unmarked, clear lane, onside, central, inside the box) so it never adds a hopeful
    // ball; byte-identical in any tick where no CM holds AdvanceMidfield.
    bool cmKillerBall = !isWideDelivery && t.role == Role::CM
                     && assignment && assignment->role == DefensiveTask::AdvanceMidfield
                     && rpEff == 0 && blEff == 0
                     && onsideGap > 3.0 && onsideGap < 170.0
                     && pitch::lateralFromCenter(t.y) < 150.0
                     && goalDistEff < 245.0 && fpEff > 20.0;
    if ((!isWideDelivery && releasedRunner && goodThroughWindow) || cleanKillerBall || cmKillerBall) {
        pur = ActionPurpose::Through;
        // Slide a runner in behind for a 1-on-1 (converts ~40% vs a 4% pot-shot).
        sc += 0.12 + attrFactor(p.attrs.creativity) * 0.10;   // trimmed with the window above to cut through-ball spam (~121 -> target ~15-30/match)
        if (cleanKillerBall) sc += 0.16;
        if (cmKillerBall) sc += 0.12;   // slip the arriving midfield runner in (smaller than the CF/WM premium — conservative)
        // Quick transition: hit the runner FAST while the defence is unset.
        // counter_attack amplifies this (and the matching off-ball-run bonus).
        if (engine.state.clockMs < engine.transitionUntilMs)
            sc += 0.18 * (1.0 + engine.teamTactics[teamIndex(p.team)].counterAttackBonus)
                       * clamp((engine.transitionUntilMs - engine.state.clockMs) / 400.0, 0.0, 1.0);
        if (runnerForwardSpeed > 10.0) sc += 0.07;
        if (onsideGap > 8.0 && onsideGap < 70.0) sc += 0.08;
        if (targetGoalDist < 250.0) sc += 0.14;
        if (receiverPressure > 0) sc -= 0.05;
    } else if (!isWideDelivery && releasedRunner && !runnerIntent && isCentralMidfielder()) {
        sc -= 0.08;
    }
    if (wideOutletTarget && !isWideDelivery && onsideGap > 10.0 && bl <= 1 && receiverPressure <= 1) {
        pur = std::abs(t.y - p.y) > 120.0 ? ActionPurpose::Switch : ActionPurpose::Build;
        sc += 0.12 + attrFactor(p.attrs.creativity) * 0.08;
    }

    // ── Release ball (1:12) — ATTEMPTED AND REVERTED ── a class rewarding
    // the ball in behind a beaten flank marker at midfield range was A/B'd
    // twice (broad, then flank-only + tight onside window): both cuts pushed
    // through-ball volume +20-45% while GOALS FELL (0.47 -> 0.28-0.33) and
    // completion dropped — the selection finds the ball but the conversion
    // chain (collect -> next decision -> finish) doesn't cash it, so each
    // extra Through is a possession lottery at negative EV. Same verdict as
    // the directed-panic-outlet experiment. Fix CONVERSION first (fresh-
    // through finishing / 1-on-1 balance), then revisit selection.

    // ── Assist-awareness ── a receiver who will have a CLEAR SHOT when the
    // ball arrives outranks any neutral connector: shooting range, unmarked
    // at the receive point, a real opening angle, and no bodies on his shot
    // line. The missing "set him up for the first-time finish" (watched
    // replay 0:49: carrier facing a teammate with a clean look at goal chose
    // a sideways ball instead; owner: raising goals this way is welcome).
    if (goalDistEff < 215.0 && rpEff == 0 && blEff <= 1 && fp > -25.0) {
        double shotAngle = engine.goalOpeningAngleDeg(rxEff, ryEff, goalXFor(p.team));
        if (shotAngle > 9.0
            && countLaneBlockers(engine.state.players, rxEff, ryEff,
                                 goalXFor(p.team), PITCH_H / 2.0, p.team,
                                 BLOCKER_PERP_FREEKICK * 0.75, 0.05, 0.94) == 0)
            sc += 0.20;
    }

    // ── Final adjustments ──
    sc += std::min(holdTicks / 260.0, 0.20);

    if (receiverPressure >= 2) sc -= 0.25;
    if (per.pressureCount >= 2 && bl == 0) sc += 0.10;
    if (per.pressureCount >= 2 && bl >= 2) sc -= 0.15;

    if (isCentralMidfielder() && t.role == Role::CF && receiverPressure >= 1 && bl <= 1)
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
