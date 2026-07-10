#include "engine.h"
#include "agent.h"

// Law 14 stand-back: how far behind the penalty MARK a player must stand, for a
// given lateral offset from the mark, to be legal — outside the 9.15m arc AND
// outside the area (the box edge sits PENALTY_AREA_W - PENALTY_SPOT_FROM_GOAL =
// 55 beyond the mark, so the radial test alone parks players inside the box).
static double penaltyLegalStandback(double dyOff) {
    double arcNeed = 0.0;
    double r2 = 96.0 * 96.0 - dyOff * dyOff;
    if (r2 > 0.0) arcNeed = std::sqrt(r2);
    double boxNeed = std::abs(dyOff) < PENALTY_AREA_H / 2.0 + 14.0
                         ? (PENALTY_AREA_W - PENALTY_SPOT_FROM_GOAL) + 14.0
                         : 22.0;
    return std::max(arcNeed + 8.0, boxNeed);
}

void PlayerAI::setPiecePositioning(SetPiece spType, Team spTeam) {
    auto& p = player;
    if (isGoalkeeper()) return;
    bool attacking = (p.team == spTeam);
    double fd = fdFor(p.team);
    double ownGoalX = (p.team == Team::Home) ? 0.0 : PITCH_W;
    double oppGoalX = (p.team == Team::Home) ? PITCH_W : 0.0;
    double slotA = std::sin(p.id * 2.17);
    double slotB = std::cos(p.id * 1.61);

    if (attacking) {
        if (spType == SetPiece::Corner) {
            double bx = engine.state.ball.x;
            double by = engine.state.ball.y;
            bool nearPost = by < PITCH_H / 2.0;
            if (isCenterForward()) {
                p.targetX = oppGoalX - fd * (80.0 + slotA * 20.0);
                p.targetY = PITCH_H / 2.0 + (nearPost ? -40.0 : 40.0) + slotB * 15.0;
            } else if (isWidePlayer()) {
                bool myCornerSide = (p.homeY < PITCH_H / 2.0) == (by < PITCH_H / 2.0);
                if (myCornerSide) {
                    // short-corner option: stay near the flag (a short pass infield) so the worked
                    // short corner has a target; releaseCornerKick picks the nearest within ~125px.
                    p.targetX = bx - fd * (50.0 + slotA * 12.0);
                    p.targetY = by + (by < PITCH_H / 2.0 ? 42.0 : -42.0);
                } else {
                    p.targetX = oppGoalX - fd * (50.0 + slotA * 15.0);
                    p.targetY = nearPost ? PITCH_H * 0.25 : PITCH_H * 0.75;
                }
            } else if (isCentralMidfielder()) {
                p.targetX = oppGoalX - fd * (120.0 + slotA * 20.0);
                p.targetY = PITCH_H / 2.0 + slotB * 40.0;
            } else if (isCenterBack() && p.homeY < PITCH_H / 2.0) {
                // Big man forward (watched replay seed 133 0:40 — "so few
                // players in box? chiellini not getting forward for corners"):
                // one CB attacks the far post as the aerial target while his
                // partner and the full-backs hold rest-defense. The old
                // else-branch lerped every defender to ~15m out, so the box
                // never had more than the CF + one winger in it.
                p.targetX = oppGoalX - fd * (70.0 + std::abs(slotA) * 18.0);
                p.targetY = PITCH_H / 2.0 + (nearPost ? 55.0 : -55.0) + slotB * 12.0;
            } else {
                // Partner CB + FBs: insurance outside the box for the counter.
                p.targetX = oppGoalX - fd * (240.0 + std::abs(slotA) * 40.0);
                p.targetY = lerp(p.homeY, PITCH_H / 2.0, 0.4);
            }
        } else if (spType == SetPiece::Penalty) {
            // Law 14 (watched replay: ten players INSIDE the area at the kick):
            // rebound-hunters line the edge of the D, everyone legal.
            if (isCenterForward() || isCentralMidfielder()) {
                double dyOff = slotB * 150.0;
                p.targetX = engine.state.ball.x - fd * penaltyLegalStandback(dyOff);
                p.targetY = PITCH_H / 2.0 + dyOff;
            } else {
                p.targetX = engine.state.ball.x - fd * (90.0 + std::abs(slotA) * 80.0);
                p.targetY = p.homeY;
            }
        } else if (spType == SetPiece::FreeKick) {
            double bx = engine.state.ball.x;
            double by = engine.state.ball.y;
            // The delivery shape below is ball-relative geometry written for
            // attacking-third FKs — CMs/defenders sit goal-side of ("behind")
            // the ball. For a FK won DEEP IN OUR OWN HALF, "behind the ball" is
            // our own goal line: the pitch clamp then stacked 7+ players onto
            // x=goal-line in a 16m band next to the taker for the whole hold
            // (watched replay seed 103 0:48 — "what team would do this?").
            // A deep FK is a BUILD-UP restart: reuse the goal-kick spread
            // (CBs split wide, FBs high flanks, CM pivot, front men stretch).
            if (std::abs(bx - ownGoalX) < 380.0) {
                if (isCenterBack()) {
                    p.targetX = ownGoalX + fd * (115.0 + std::abs(slotA) * 22.0);
                    p.targetY = (p.homeY < PITCH_H / 2.0) ? PITCH_H * 0.30 : PITCH_H * 0.70;
                } else if (isFullBack()) {
                    p.targetX = ownGoalX + fd * (180.0 + slotA * 28.0);
                    p.targetY = (p.homeY < PITCH_H / 2.0) ? PITCH_H * 0.18 : PITCH_H * 0.82;
                } else if (isCentralMidfielder()) {
                    p.targetX = ownGoalX + fd * (175.0 + std::abs(slotA) * 35.0);
                    p.targetY = PITCH_H / 2.0 + slotB * 60.0;
                } else {
                    p.targetX = ownGoalX + fd * (400.0 + slotA * 35.0);
                    p.targetY = lerp(p.homeY, PITCH_H / 2.0, 0.25);
                }
            } else if (isCenterForward()) {
                p.targetX = oppGoalX - fd * (60.0 + slotA * 15.0);
                p.targetY = PITCH_H / 2.0 + slotB * 30.0;
            } else if (isCentralMidfielder()) {
                p.targetX = bx - fd * (35.0 + std::abs(slotA) * 55.0);
                p.targetY = by + slotB * 80.0;
            } else if (isWideMidfielder()) {
                p.targetX = bx + fd * (25.0 + slotA * 35.0);
                p.targetY = by + slotB * 115.0;
            } else if (isDefenderRole()) {
                p.targetX = bx - fd * (75.0 + std::abs(slotA) * 60.0);
                p.targetY = by + slotB * 95.0;
            } else {
                p.targetX = lerp(p.x, bx, 0.3);
                p.targetY = lerp(p.y, PITCH_H / 2.0, 0.2);
            }
        } else if (spType == SetPiece::ThrowIn) {
            auto& bb = engine.blackboards[GameEngine::teamIndex(p.team)];
            if (bb.throwInSupport.active && bb.throwInSupport.targetX[p.id] != 0.0) {
                p.targetX = bb.throwInSupport.targetX[p.id];
                p.targetY = bb.throwInSupport.targetY[p.id];
            } else {
                double bx = engine.state.ball.x;
                double by = engine.state.ball.y;
                p.targetX = bx + fd * (60.0 + slotA * 40.0);
                p.targetY = by + slotB * 80.0;
            }
        } else if (spType == SetPiece::GoalKick) {
            // Build-up shape (user feedback #5 "weird positioning at goal kicks"): the kicking team had
            // NO goal-kick case — it fell through to open-play positions, so the keeper had no structured
            // options. Give it real ones: CBs split WIDE just outside the box (the safe short ball, legal
            // in the area since 2019), FBs push HIGH up the flanks, a CM drops in as the central pivot, the
            // front men push up to stretch + offer the long ball. Mirrors releaseGoalKick's short(CB/FB) /
            // long(CF/WM) target search, so the distribution has good targets. Pure geometry, no rng.
            // A CONNECTED ladder, not everyone-high: CB wide-short → FB/CM the medium link → only the
            // front men stretch high. (Bombing the FBs to ~300px while the keeper plays SHORT to a CB
            // left a disconnected build-up — a big gap that lost possession; goals -1.0. Keep them linked.)
            if (isCenterBack()) {
                p.targetX = ownGoalX + fd * (115.0 + std::abs(slotA) * 22.0);
                p.targetY = (p.homeY < PITCH_H / 2.0) ? PITCH_H * 0.30 : PITCH_H * 0.70;
            } else if (isFullBack()) {
                p.targetX = ownGoalX + fd * (180.0 + slotA * 28.0);
                p.targetY = (p.homeY < PITCH_H / 2.0) ? PITCH_H * 0.18 : PITCH_H * 0.82;
            } else if (isCentralMidfielder()) {
                p.targetX = ownGoalX + fd * (175.0 + std::abs(slotA) * 35.0);
                p.targetY = PITCH_H / 2.0 + slotB * 60.0;
            } else if (isCenterForward()) {
                // STRETCH the field (watched replay seed 133 0:45: every kicking
                // player inside x<422 — 20 outfielders crammed into one third,
                // the far half empty). The CF stands ON the halfway line next
                // to the opposing CBs, pinning them back; long kicks have a
                // genuine out-ball and the shape looks like football.
                p.targetX = ownGoalX + fd * (530.0 + slotA * 25.0);
                p.targetY = lerp(p.homeY, PITCH_H / 2.0, 0.30);
            } else {
                // WMs high and WIDE — between the lines, stretching laterally too.
                p.targetX = ownGoalX + fd * (455.0 + slotA * 35.0);
                p.targetY = lerp(p.homeY, PITCH_H / 2.0, 0.10);
            }
        }
    } else {
        if (spType == SetPiece::Corner) {
            double by = engine.state.ball.y;
            bool nearTop = by < PITCH_H / 2.0;
            if (isDefenderRole()) {
                bool postGuard = isFullBack();
                p.targetX = ownGoalX + fd * (postGuard ? 42.0 : 68.0);
                if (postGuard) {
                    p.targetY = nearTop
                        ? (p.homeY < PITCH_H / 2.0 ? PITCH_H * 0.25 : PITCH_H * 0.66)
                        : (p.homeY > PITCH_H / 2.0 ? PITCH_H * 0.75 : PITCH_H * 0.34);
                } else {
                    p.targetY = PITCH_H / 2.0 + (p.id % 2 == 0 ? -54.0 : 54.0);
                }
            } else if (isCentralMidfielder()) {
                p.targetX = ownGoalX + fd * (118.0 + std::abs(slotA) * 22.0);
                p.targetY = PITCH_H / 2.0 + (p.id % 3 - 1) * 58.0;
            } else {
                p.targetX = ownGoalX + fd * 185.0;
                p.targetY = lerp(p.homeY, PITCH_H / 2.0, 0.25);
            }
        } else if (spType == SetPiece::Penalty) {
            // Law 14, defending side: back line rings the D to sweep the
            // rebound; midfield/front stagger just outside it as the outlet.
            // (The old GK case here was dead — isGoalkeeper() returns at the
            // top; enforceRestartDistance walks the keeper to his line.)
            if (isDefenderRole()) {
                double dyOff = slotB * 170.0;
                p.targetX = engine.state.ball.x + fd * (penaltyLegalStandback(dyOff) + 4.0);
                p.targetY = PITCH_H / 2.0 + dyOff;
            } else {
                double dyOff = (p.homeY - PITCH_H / 2.0) * 0.65;
                p.targetX = engine.state.ball.x + fd * (penaltyLegalStandback(dyOff) + 30.0 + std::abs(slotA) * 60.0);
                p.targetY = PITCH_H / 2.0 + dyOff;
            }
        } else if (spType == SetPiece::FreeKick) {
            double bx = engine.state.ball.x;
            double by = engine.state.ball.y;
            double goalDist = std::abs(bx - ownGoalX);
            if (goalDist < 250.0) {
                if (isFullBack()) {
                    // Proper defensive wall: stand on the ball->goal line at the legal ~9.15m (91px),
                    // not the old ~3.2m token gap. The two full-backs form a 2-man wall covering the
                    // near-post angle; the FK shot already accounts for them via laneBlockers.
                    double wdx = ownGoalX - bx, wdy = PITCH_H / 2.0 - by, wlen = std::max(1.0, std::hypot(wdx, wdy));
                    wdx /= wlen; wdy /= wlen;
                    double off = (p.homeY < PITCH_H / 2.0) ? -20.0 : 20.0;
                    p.targetX = bx + wdx * 91.0 + (-wdy) * off;
                    p.targetY = by + wdy * 91.0 + ( wdx) * off;
                    p.wall = true;   // render-hint: this FB is in the FK wall (Gaylord's wall-highlight)
                } else if (isCenterBack()) {
                    p.targetX = ownGoalX + fd * 72.0;
                    p.targetY = PITCH_H / 2.0 + (p.id % 2 == 0 ? -46.0 : 46.0);
                } else if (isCentralMidfielder()) {
                    p.targetX = ownGoalX + fd * 118.0;
                    p.targetY = PITCH_H / 2.0 + (p.id % 3 - 1) * 52.0;
                } else {
                    p.targetX = ownGoalX + fd * 185.0;
                    p.targetY = lerp(p.homeY, PITCH_H / 2.0, 0.2);
                }
            } else {
                p.targetX = lerp(p.x, ownGoalX + fd * 100.0, 0.4);
                p.targetY = lerp(p.y, PITCH_H / 2.0, 0.2);
            }
        } else if (spType == SetPiece::GoalKick) {
            // Defending an opponent goal kick had NO shape — a 30% lerp toward
            // our own goal left all ten strung in one flat mid-pitch band with
            // the entire half behind them empty (watched replay seed 133 0:45,
            // "completely wrong/unrealistic"). Real: a press LADDER anchored on
            // distance from the KICKING goal — front men on the short outlets,
            // midfield on the links, FBs on the stretched wingers, CBs holding
            // rest-defense at halfway with their GK behind.
            double distFromKick;
            if (isCenterForward())            distFromKick = 215.0 + std::abs(slotA) * 30.0;
            else if (isWideMidfielder())      distFromKick = 335.0 + std::abs(slotA) * 40.0;
            else if (isCentralMidfielder())   distFromKick = 405.0 + std::abs(slotA) * 45.0;
            else if (isFullBack())            distFromKick = 520.0 + slotA * 30.0;
            else /* CB rest-defense */        distFromKick = 585.0 + std::abs(slotA) * 25.0;
            p.targetX = oppGoalX - fd * distFromKick;   // anchored on the kicking goal (= our attacking goal)
            if (isCenterForward())            p.targetY = lerp(p.homeY, PITCH_H / 2.0, 0.35);
            else if (isWideMidfielder())      p.targetY = lerp(p.homeY, PITCH_H / 2.0, 0.10);
            else if (isCentralMidfielder())   p.targetY = PITCH_H / 2.0 + slotB * 70.0;
            else if (isFullBack())            p.targetY = (p.homeY < PITCH_H / 2.0) ? PITCH_H * 0.20 : PITCH_H * 0.80;
            else                              p.targetY = (p.homeY < PITCH_H / 2.0) ? PITCH_H * 0.38 : PITCH_H * 0.62;
        } else {
            p.targetX = lerp(p.x, ownGoalX + fd * 120.0, 0.3);
            p.targetY = lerp(p.y, PITCH_H / 2.0, 0.15);
        }
    }

    p.targetX = clamp(p.targetX, 35.0, PITCH_W - 35.0);
    p.targetY = clamp(p.targetY, 35.0, PITCH_H - 35.0);
}

// ══════════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════════
