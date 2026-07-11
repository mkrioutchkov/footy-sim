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
                // Clamped onside: the choreography ordered a 7.4s offside camp
                // at 1:16 (seed 111) — the CF was SENT 70px beyond the line
                // and deleted himself from the possession.
                p.targetX = clampToLegalX(oppGoalX - fd * (80.0 + slotA * 20.0), fd);
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
            // 380 -> 546 (52%W): a MIDFIELD FK (448px from own goal at 1:16,
            // seed 111) fell into the attacking-third blob shape — 8 of 9
            // outfield targets inside a ~190x170 box on the taker, both FBs
            // 32px apart in the centre. Anything up to just past halfway is a
            // build-up restart and gets the spread.
            if (std::abs(bx - ownGoalX) < PITCH_W * 0.52) {
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
                p.targetX = clampToLegalX(oppGoalX - fd * (60.0 + slotA * 15.0), fd);
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
                // 275: the true seam between the defending CF press ring
                // (~215) and the WM ring (~335) — 235 parked the FB ON the
                // presser and the clipped ball never had a safe target (probe:
                // 7/7 kicks still rolled short even with the mid look forced).
                // (300 was a disconnected gap, goals -1.0; 180 sat him inside
                // the CF's camp — seed 111 census: 6/6 short, zero progression.)
                p.targetX = ownGoalX + fd * (275.0 + slotA * 20.0);
                p.targetY = (p.homeY < PITCH_H / 2.0) ? PITCH_H * 0.16 : PITCH_H * 0.84;
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
            // Delivery FKs out to ~330 need the man-aware box defense too — the
            // seed 107 1:36 goal came from a 301px FK swung into an unmarked box.
            if (goalDist < 330.0) {
                // ── Wall ── FBs man it; a CENTRAL fk (the direct-shot threat)
                // adds the lowest-id CM as a third body. Targets sit 91px down
                // the ball->goal line (the lateral offset keeps the slant legal
                // at ~93px); enforceRestartDistance EXEMPTS p.wall so walkers
                // actually arrive — it used to radially re-target anyone who
                // dipped inside 91px en route, so the second FB never reached
                // his slot (watched replay seed 107 5:51, the Ronaldinho FK:
                // a one-man "wall", the other FB frozen 77px off the line).
                bool centralFk = std::abs(by - PITCH_H / 2.0) < 150.0;
                int lowestCm = -1;
                if (centralFk)
                    for (auto& q : engine.state.players)
                        if (q.team == p.team && q.role == Role::CM && !q.sentOff
                            && (lowestCm < 0 || q.id < lowestCm)) lowestCm = q.id;
                int wallSlot = -1;
                if (goalDist < 250.0) {   // wall only against a genuine direct-shot threat
                    if (isFullBack()) wallSlot = (p.homeY < PITCH_H / 2.0) ? 0 : 1;
                    else if (p.id == lowestCm) wallSlot = 2;
                }
                if (wallSlot >= 0) {
                    double wdx = ownGoalX - bx, wdy = PITCH_H / 2.0 - by, wlen = std::max(1.0, std::hypot(wdx, wdy));
                    wdx /= wlen; wdy /= wlen;
                    double off = wallSlot == 0 ? -18.0 : wallSlot == 1 ? 18.0 : 0.0;
                    p.targetX = bx + wdx * 91.0 + (-wdy) * off;
                    p.targetY = by + wdy * 91.0 + ( wdx) * off;
                    p.wall = true;   // render-hint + enforceRestartDistance exemption
                } else {
                    // ── Man-aware box defense ── mark the attacker (in the
                    // danger zone) for whom I am the closest unengaged
                    // defender — goal-side, a stride off. Zone lines only as
                    // fallback (watched replay seed 107 1:36: zone ladders
                    // marched three defenders past unmarked attackers on the
                    // six-yard line — "positions made no sense").
                    auto inWall = [&](const Player& q) {
                        return goalDist < 250.0
                            && (roles::isFullBack(q.role) || (q.id == lowestCm && lowestCm >= 0));
                    };
                    const Player* markT = nullptr;
                    double markD = 1e9;
                    for (auto& opp : engine.state.players) {
                        if (opp.team == p.team || opp.role == Role::GK || opp.sentOff) continue;
                        if (opp.id == engine.setPiece.takerId) continue;
                        if (std::abs(opp.x - ownGoalX) > 260.0
                            || std::abs(opp.y - PITCH_H / 2.0) > 230.0) continue;
                        double myD = dist(p.x, p.y, opp.x, opp.y);
                        bool closest = true;
                        for (auto& q : engine.state.players) {
                            if (q.team != p.team || q.id == p.id || q.role == Role::GK
                                || q.sentOff || inWall(q)) continue;
                            if (dist(q.x, q.y, opp.x, opp.y) < myD - 1.0) { closest = false; break; }
                        }
                        if (closest && myD < markD) { markD = myD; markT = &opp; }
                    }
                    if (markT) {
                        double gdx = ownGoalX - markT->x, gdy = PITCH_H / 2.0 - markT->y;
                        double gl = std::max(1.0, std::hypot(gdx, gdy));
                        p.targetX = markT->x + gdx / gl * 16.0;
                        p.targetY = markT->y + gdy / gl * 16.0;
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
        } else if (spType == SetPiece::ThrowIn) {
            // Contest the throw (owner: "we should see the other team contest
            // it more"): defenders near the spot pick up the thrower's nearby
            // options — stand a stride INSIDE the receiver (between him and
            // our goal) so the catch is pressured the moment it lands. The
            // 2m-from-thrower law is handled by enforceRestartDistance.
            double sx = engine.setPiece.spotX, sy = engine.setPiece.spotY;
            const Player* markT = nullptr;
            double markD = 1e9;
            if (dist(p.x, p.y, sx, sy) < 260.0) {
                for (auto& opp : engine.state.players) {
                    if (opp.team == p.team || opp.role == Role::GK || opp.sentOff) continue;
                    if (opp.id == engine.setPiece.takerId) continue;
                    if (dist(opp.x, opp.y, sx, sy) > 200.0) continue;
                    double myD = dist(p.x, p.y, opp.x, opp.y);
                    bool closest = true;
                    for (auto& q : engine.state.players) {
                        if (q.team != p.team || q.id == p.id || q.role == Role::GK || q.sentOff) continue;
                        if (dist(q.x, q.y, opp.x, opp.y) < myD - 1.0) { closest = false; break; }
                    }
                    if (closest && myD < markD) { markD = myD; markT = &opp; }
                }
            }
            if (markT) {
                double gdx = ownGoalX - markT->x, gdy = PITCH_H / 2.0 - markT->y;
                double gl = std::max(1.0, std::hypot(gdx, gdy));
                p.targetX = markT->x + gdx / gl * 14.0;
                p.targetY = markT->y + gdy / gl * 14.0;
            } else {
                p.targetX = lerp(p.x, ownGoalX + fd * 120.0, 0.3);
                p.targetY = lerp(p.y, PITCH_H / 2.0, 0.15);
            }
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
