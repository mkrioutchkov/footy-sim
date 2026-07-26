#include "engine.h"
#include "agent.h"
#include <cmath>
#include <cstdio>
#include <numbers>

// ══════════════════════════════════════════════════════════════
// Physics — ball physics, collision, collection, movement
// ══════════════════════════════════════════════════════════════

void GameEngine::separateTeammates(double sdt) {
    double secs = sdt / 1000.0;
    double maxPush = 32.0 * secs;
    // Loose-ball standoff fix: a dead ball has no controller, so NONE of the
    // converging chasers is exempt from the mutual separation push — they cancel
    // each other's inward step and orbit ~20-33px out, never reaching the ~14px
    // collect radius, so the ball sits dead for seconds. Exempt the SINGLE nearest
    // eligible chaser (like the controller). Deterministic (lowest dist, first-index tiebreak).
    int looseWinner = -1;
    {
        auto& lb = state.ball;
        if (lb.controllerId < 0 && lb.z < 6.0 && std::hypot(lb.vx, lb.vy) < 40.0) {
            double best = 30.0;
            for (auto& p : state.players) {
                if (p.role == Role::GK || p.sentOff || contestBlockedUntil[p.id] > state.clockMs) continue;
                double dd = dist(p.x, p.y, lb.x, lb.y);
                if (dd < best) {
                    best = dd;
                    looseWinner = p.id;
                }
            }
        }
    }
    for (size_t i = 0; i < state.players.size(); ++i) {
        for (size_t j = i + 1; j < state.players.size(); ++j) {
            Player& a = state.players[i];
            Player& b = state.players[j];
            // Round-21: a sent-off (or arena-parked) player has no body on the
            // pitch — separating him dragged him off his y=-40 touchline back to
            // the y=5 edge, where the arena's nine parked men then formed a wall
            // the duelling carrier collided with (the corner-stall / touchline
            // pile-up). Never push a player who isn't in play.
            if (a.sentOff || b.sentOff) continue;
            // GKs separate too (at the opponent distance) — exempting them let
            // outfielders stand INSIDE the keeper for seconds.
            bool gkPair = a.role == Role::GK || b.role == Role::GK;
            double dx = b.x - a.x, dy = b.y - a.y;
            double d = std::hypot(dx, dy);
            double minDist = (gkPair || a.team != b.team) ? 24.0 : SEPARATION_DIST;
            if (d < 0.1 || d >= minDist) continue;
            double nx = dx / d, ny = dy / d;
            double pushScale = (gkPair || a.team != b.team) ? 0.10 : 0.24;
            // Deep overlap (two bodies on one pixel) escalates the push hard —
            // the gentle 0.5px/tick separation lost to shared chase targets.
            double push = std::min(maxPush * (d < 12.0 ? 4.0 : 1.0), (minDist - d) * pushScale * (d < 12.0 ? 4.0 : 1.0));
            bool aFixed = state.ball.controllerId == a.id || isActiveKnockAheadRunner(a.id) || a.id == looseWinner;
            bool bFixed = state.ball.controllerId == b.id || isActiveKnockAheadRunner(b.id) || b.id == looseWinner;
            if (aFixed && bFixed) continue;
            if (aFixed) {
                b.x = clampToPitchX(b.x + nx * push * 2.0);
                b.y = clampToPitchY(b.y + ny * push * 2.0);
            } else if (bFixed) {
                a.x = clampToPitchX(a.x - nx * push * 2.0);
                a.y = clampToPitchY(a.y - ny * push * 2.0);
            } else {
                a.x = clampToPitchX(a.x - nx * push);
                a.y = clampToPitchY(a.y - ny * push);
                b.x = clampToPitchX(b.x + nx * push);
                b.y = clampToPitchY(b.y + ny * push);
            }
        }
    }
}

void GameEngine::applyBallPhysics(double s) {
    auto& b = state.ball;
    if (b.curl != 0.0) {
        rotateBallVelocity(b, b.curl * s);
        b.curl *= std::pow(b.z > 2.0 ? 0.55 : 0.02, s);
        if (std::abs(b.curl) < 0.02) b.curl = 0.0;
    }
    // Airborne balls fly near-ballistically (light air drag); grounded balls
    // roll under grass friction. Same z>2 gate curl already uses. The rain
    // modifier is a WET-PITCH effect, so it now correctly applies only to
    // grounded balls (it was accidentally lightening airborne drag too).
    bool airborne = b.z > 2.0;
    double friction = std::pow(airborne ? BALL_AIR_DRAG : BALL_FRICTION, s);
    if (weather == 1 && !airborne) friction = 1.0 - (1.0 - friction) * 0.55; // §weather rain: wet pitch sheds ~45% less rolling friction (ball skids further)
    // Air drag grows with speed (quadratic in reality): a 30m/s ball sheds far
    // more than 7%/s. The flat 0.93 made driven flights look laser-flat
    // (watched replay seed 111 0:59 — "the physics of how it travels is off...
    // should slow down more"). Up to ~14%/s extra at 300+ px/s.
    // Scoped to NON-SHOT flights: shot ballistics (loft/bar clearance/keeper
    // model) were calibrated without it — with it, drives that used to clear
    // the bar sagged into the bar band and woodwork rose ~40%.
    if (airborne && lastLooseOrigin != LooseOrigin::Shot) {
        double spA = std::hypot(b.vx, b.vy);
        if (spA > 180.0) friction *= (1.0 - clamp((spA - 180.0) / 900.0, 0.0, 0.14) * s);
    }
    b.vx *= friction;
    b.vy *= friction;
    // Rolling friction: a grounded ball below jogging pace stops in a stride
    // or two, not a multi-second exponential crawl that never quite reaches 0.
    double gs = std::hypot(b.vx, b.vy);
    if (b.z < 1.0 && gs > 0.0 && gs < 65.0) {
        double stopRate = (weather == 1) ? 47.5 : 95.0; // §weather rain: skids, doesn't pull up in a stride
        double slowed = std::max(0.0, gs - stopRate * s);
        b.vx *= slowed / gs;
        b.vy *= slowed / gs;
    }
    if (b.z < 1.0 && std::hypot(b.vx, b.vy) < 4) { b.vx = b.vy = 0; }   // grounded only — a vertical lob keeps its drift
    b.x += b.vx * s;
    b.y += b.vy * s;
    if (b.vz != 0.0 || b.z > 0) {
        b.vz -= GRAVITY * s;
        b.z += b.vz * s;
        if (weather == 2 && b.z > 0.5) { // §weather v2 WIND: height-gated lateral drift on AIRBORNE balls only (ground passes immune -> passPct protected)
            double h = std::min(b.z / WIND_HEIGHT_REF, 1.0);
            b.vx += windX * h * s;
            b.vy += windY * h * s;
        }
        if (b.z <= 0) {
            b.z = 0;
            if (b.vz < -75.0) {
                // One firm bounce for a hard-driven ball: grass sheds most of
                // the vertical energy and grips horizontally. The high
                // threshold means a ball returning below ~75px/s just settles,
                // so there's no multi-hop micro-bounce tail (the audit's
                // phantom vz that never died), and high balls stop hovercraft-
                // sliding across the pitch.
                b.vz *= -0.30;
                b.vx *= 0.70;
                b.vy *= 0.70;
            } else {
                b.vz = 0;
            }
        }
    }
}

// Predict where the ball will actually BE tAhead seconds from now, using the
// same drag / gravity / bounce model as applyBallPhysics (walls and bodies
// excluded — this is a chase aid, not an oracle). The linear `ball + v*lead`
// chase target ignored air drag and the bounce's 30% horizontal kill, so on a
// 293px/s cross with a 1.1s lead THREE defenders plus a home runner all
// overran to a phantom point 140px beyond where the ball actually died
// (watched replay seed 107, the untouched FK cross that rolled in far post).
void GameEngine::predictBallPos(double tAhead, double& outX, double& outY) const {
    const auto& b = state.ball;
    double x = b.x, y = b.y, z = b.z, vx = b.vx, vy = b.vy, vz = b.vz;
    const double dt = 0.05;
    for (double t = 0.0; t < tAhead; t += dt) {
        bool airborne = z > 2.0;
        double f = std::pow(airborne ? BALL_AIR_DRAG : BALL_FRICTION, dt);
        if (airborne && lastLooseOrigin != LooseOrigin::Shot) {
            double spA = std::hypot(vx, vy);   // mirror applyBallPhysics' speed-dependent air drag (same shot exemption)
            if (spA > 180.0) f *= (1.0 - clamp((spA - 180.0) / 900.0, 0.0, 0.14) * dt);
        }
        vx *= f;
        vy *= f;
        x += vx * dt;
        y += vy * dt;
        if (airborne || vz != 0.0) {
            z += vz * dt;
            vz -= GRAVITY * dt;
            if (z <= 0.0) {
                z = 0.0;
                if (vz < -75.0) {
                    vz *= -0.30;
                    vx *= 0.70;
                    vy *= 0.70;
                } else
                    vz = 0.0;
            }
        }
        if (vx * vx + vy * vy < 36.0) break; // effectively at rest
    }
    outX = x;
    outY = y;
}

void GameEngine::clampBallPosition() {
    auto& b = state.ball;
    double px = b.x, py = b.y;
    b.x = clamp(b.x, -40., PITCH_W + 40);
    b.y = clamp(b.y, -40., PITCH_H + 40);
    // Settle at the runoff wall (micro audit: a corner out-ball sat pinned at
    // the wall for 450ms with outward velocity still set, then flung to the
    // flag): kill the outward component and bleed the slide so the dead ball
    // visibly comes to rest instead of vibrating against an invisible fence.
    if (b.x != px) { b.vx = 0; b.vy *= 0.80; }
    if (b.y != py) { b.vy = 0; b.vx *= 0.80; }
}

bool GameEngine::checkGoal() {
    auto& b = state.ball;
    bool inOpening = std::abs(b.y - PITCH_H / 2) <= GOAL_W / 2 && b.z + BALL_R <= GOAL_H;
    if (!inOpening) return false;
    // Law 15: a goal cannot be scored directly from a throw-in. Untouched
    // since the throw (the taker is still retouch-blocked -> nobody else has
    // touched), the ball crossing the line is a goal kick (opponent's goal)
    // or a corner (own goal) — handled by the normal out-of-play award once
    // we refuse the goal here.
    if (lastRestartReleaseType == SetPiece::ThrowIn && restartRetouchBlockedId >= 0
        && b.lastToucherId == restartRetouchBlockedId)
        return false;
    auto recordGoalSource = [&](Team scoringTeam) {
        lastGoal.scoringTeam = scoringTeam;
        lastGoal.touchTeam = b.lastTouchTeam;
        lastGoal.toucherId = b.lastToucherId;
        lastGoal.ballSpeed = std::hypot(b.vx, b.vy);
        if (!shot.tracked) {
            if (pendingPass.active && pendingPass.team == scoringTeam) {
                if (pendingPass.isCross) {
                    lastGoal.source = GoalSource::DirectCross;
                } else
                    lastGoal.source = GoalSource::DirectDelivery;
            } else if (pendingPass.active) {
                lastGoal.source = GoalSource::TackleDeflection;
            } else if (lastLooseOrigin == LooseOrigin::TackleDeflection) {
                lastGoal.source = GoalSource::TackleDeflection;
            } else if (lastLooseOrigin == LooseOrigin::GoalkeeperParry) {
                lastGoal.source = GoalSource::GoalkeeperParry;
            } else if (lastLooseOrigin == LooseOrigin::Shot) {
                lastGoal.source = GoalSource::ShotStateLost;
            } else if (lastLooseOrigin == LooseOrigin::ShotBlock) {
                // A blocked shot whose ricochet rolls in (usually off the
                // blocker, an own-goal deflection). The block site sets
                // ShotBlock, but no branch here consumed it — the goal fell
                // through to LooseUnclassified and tripped the scenario guard.
                lastGoal.source = GoalSource::ShotDeflection;
            } else if (lastLooseOrigin == LooseOrigin::KnockAhead) {
                resolveKnockAhead(nullptr, "goal");
                lastGoal.source = GoalSource::KnockAhead;
            } else if (b.lastTouchTeam == scoringTeam && b.lastToucherId >= 0) {
                lastGoal.source = GoalSource::ShotStateLost;
            } else {
                lastGoal.source = GoalSource::LooseUnclassified;
            }
            return;
        }
        if (b.lastTouchTeam != shot.team) {
            lastGoal.source = GoalSource::ShotDeflection;
        } else {
            lastGoal.source = shot.penalty ? GoalSource::Penalty : GoalSource::Shot;
        }
    };
    // A goal: identical bookkeeping for either end — only the scoring team, the goal
    // line, the score counter, and who restarts differ. (Conceding side kicks off.)
    auto finishGoal = [&](Team scoringTeam, double goalLineX) {
        recordGoalSource(scoringTeam);
        double goalDist = 0;
        if (shot.tracked) goalDist = dist(shot.originX, shot.originY, goalLineX, PITCH_H / 2);
        Player* scorer = playerById(lastGoal.toucherId);
        // OWN GOAL: the last toucher is a defender of the CONCEDING team (a deflection
        // into his own net). Don't credit HIM a personal goal/assist or attribute the
        // goal to his role/header — the scoreline is authoritative. (report.ts already
        // filters pGoals via legitGoals but NOT assists/goalsByRole, so this leaked.)
        bool ownGoal = lastGoal.touchTeam != scoringTeam;
        std::optional<Role> scorerRole = (scorer && !ownGoal) ? std::optional<Role>(scorer->role) : std::nullopt;
        if (lastGoal.source == GoalSource::Penalty) stats.recordPenaltyGoal();
        if (shot.dribble20m && lastGoal.source == GoalSource::Shot) stats.recordDribble20mGoal();
        stats.recordGoal(scoringTeam, lastGoal.source, goalDist, lastGoal.ballSpeed, scorerRole, ownGoal ? false : shot.header);
        if (shot.tracked)
            stats.recordGoalInBox(std::abs(shot.originX - goalLineX) < PENALTY_AREA_W
                                  && pitch::lateralFromCenter(shot.originY) < PENALTY_AREA_H / 2.0);
        // A goal from a tracked shot never hit the shotsOnTarget ledger (only SAVED
        // shots did) — count it so shotsOnTarget includes scored shots. Only raises it,
        // so saves<=shotsOnTarget still holds.
        if (lastGoal.source == GoalSource::Shot || lastGoal.source == GoalSource::Penalty) stats.recordShotOnTarget();
        if (passDebug && shot.tracked) fprintf(stderr, "GOALSCORED type=%d src=%d\n", shot.type, (int) lastGoal.source);
        if (!ownGoal) creditGoal(lastGoal.toucherId);
        // Round-30: carry the own-goal truth OUT of the engine. The event's
        // player id is the toucher (a defender of the conceding side on an own
        // goal), and every consumer synthesises the team from that id — so the
        // flag is the only thing that tells them the goal belongs to the other
        // team. Payload only; play is unchanged.
        emitEvent("goal", goalLineX, b.y, lastGoal.toucherId, -1, /*traceOnly=*/false, ownGoal);
        if (scoringTeam == Team::Home)
            state.homeScore++;
        else
            state.awayScore++;
        shot.active = false;
        shot.clearFlags();
        // goal celebration (owner: "have delays after goal") — stoppage accrues via kickoffPhase, so it feeds real added time.
        // Round-23 (arena reaudit): players WALK to the reset over the hold (walkIn)
        // instead of teleporting; the arena hold grows 3s -> 6s to fit the scorer's
        // celebration + the stroll back (11v11 keeps its 9s, already ample). The
        // hold snaps to the exact formation at the end, so the tap is unchanged.
        // Round-30 (arena audit D11): the post-goal walk-in is the ONE restart
        // budget arenaMode never scaled — 6s of dead ball on the centre spot at
        // arena scoring rates costs a real slice of a 10-minute match. Put it on
        // the same ARENA_RESTART_SCALE the free kick / corner / throw budgets
        // already use. 11v11 keeps its 9s exactly.
        kickoff(scoringTeam == Team::Home ? Team::Away : Team::Home,
                9000.0 * (arenaMode ? ARENA_RESTART_SCALE : 1.0), /*walkIn=*/true);
    };
    if (b.x + BALL_R < HOME_GOAL_X) {
        finishGoal(Team::Away, HOME_GOAL_X);
        return true;
    }
    if (b.x - BALL_R > AWAY_GOAL_X) {
        finishGoal(Team::Home, AWAY_GOAL_X);
        return true;
    }
    return false;
}

// Posts and crossbar. A ball arriving at the goal-frame plane that catches an
// upright or the bar ricochets back into play (or down off the bar) instead of
// passing cleanly — the rebound is then live for a follow-up. Runs each tick
// before the goal/out checks; emits a "woodwork" event for the renderer.
bool GameEngine::checkWoodwork() {
    auto& b = state.ball;
    if (b.controllerId >= 0) return false;
    // W1 (user "completely broken hitting of the woodwork"): after a hit, the rebound could still
    // satisfy the same height/x band next tick → re-collide, bounce repeatedly, or STICK at the bar.
    // Hold a few ticks so the rebound clears the band before we re-check. Clock-driven, no rng.
    if (woodworkCooldown > 0) {
        woodworkCooldown--;
        return false;
    }
    double goalX, inSign;
    if (b.vx < -1.0 && b.x <= HOME_GOAL_X + BALL_R + 2.0 && b.x > HOME_GOAL_X - 28.0) {
        goalX = HOME_GOAL_X;
        inSign = 1.0;
    } else if (b.vx > 1.0 && b.x >= AWAY_GOAL_X - BALL_R - 2.0 && b.x < AWAY_GOAL_X + 28.0) {
        goalX = AWAY_GOAL_X;
        inSign = -1.0;
    } else
        return false;
    double center = PITCH_H / 2.0, half = GOAL_W / 2.0;
    double dyPost = std::abs(b.y - center);
    double topOfBall = b.z + BALL_R;
    bool withinPosts = dyPost <= half;
    // ── Crossbar ── arriving at the bar height, between the uprights.
    // NOTE (2026-07-02 audit): shrinking this band + the post band to physical
    // contact was A/B'd and made almost no dent in woodworkHits (3.19->3.0)
    // while costing rebound scrambles — the hit rate is driven by shot AIM
    // (postFrac puts a typical credible finesse at ~36.1px vs the post at
    // 36.5), not by hitbox slack. Fix the aim distribution, not this.
    if (withinPosts && topOfBall >= GOAL_H - 1.0 && b.z <= GOAL_H + BALL_R + 4.0) {
        b.x = goalX + inSign * (BALL_R + 2.0);
        b.vx = -b.vx * 0.32;
        b.vz = -b.vz * 0.45 - 12.0; // W3: reflect the vertical (preserves a ball grazing the bar from above) + a small downward nudge — was -abs()*0.45-30, a forced dead-stick drop
        b.vy *= 0.70;
        b.curl = 0.0;
        woodworkCooldown = 4; // W1: don't re-collide with the bar next tick
        lastLooseOrigin = LooseOrigin::Woodwork;
        stats.recordWoodwork();
        stats.recordWoodworkBar();
        emitEvent("woodwork", goalX, b.y, b.lastToucherId);
        return true;
    }
    // ── Post ── catching an upright (a sliver inside to just outside it), under
    // the bar. Mostly turns near-misses into rattles; rebounds back into play.
    // (See the crossbar NOTE: band-tightening A/B'd 2026-07-02, ineffective —
    // the woodwork rate lives in the aim distribution.)
    if (topOfBall <= GOAL_H + 2.0 && dyPost >= half - 1.5 && dyPost <= half + BALL_R + 3.0) {
        double postSide = (b.y >= center) ? 1.0 : -1.0;
        b.x = goalX + inSign * (BALL_R + 2.0);
        b.vx = -b.vx * 0.45;
        b.vy = postSide * std::abs(b.vy) * 0.55; // shove back off the upright (away from goal-center)
        b.vz *= 0.6;
        b.curl = 0.0;
        woodworkCooldown = 4; // W1: don't re-collide with the post next tick
        lastLooseOrigin = LooseOrigin::Woodwork;
        stats.recordWoodwork();
        stats.recordWoodworkPost();
        emitEvent("woodwork", goalX, center + postSide * half, b.lastToucherId);
        return true;
    }
    return false;
}

bool GameEngine::checkOutOfPlay() {
    auto& b = state.ball;
    Team lt = b.lastTouchTeam;
    // Census (owner ask): a ball put OUT OF PLAY by an UNPRESSURED outfielder who
    // wasn't shooting or crossing — the "just kicked it out of play for no reason"
    // moment. A shot going wide, a cross that runs out, a GK's long ball, or a
    // genuine clearance under pressure are all legitimate and excluded. Detection
    // only — changes no restart, so it can't perturb determinism beyond the counter.
    auto flagSenselessOut = [&]() {
        // Through balls are DELIBERATE-RISK balls like crosses: an overhit led
        // ball running dead past its runner is normal football, not the aimless
        // "just kicked it out" this census measures.
        if (shot.active || (pendingPass.active && (pendingPass.isCross || pendingPass.isThrough))) return;
        // ...including one whose pass tracker already resolved: the sticky
        // risky-launch marker survives the failure so the overhit killer ball
        // rolling dead isn't miscounted as an aimless hoof.
        if (b.lastToucherId == lastRiskyBallToucher && state.clockMs - lastRiskyBallMs < 4000.0) return;
        Player* toucher = playerById(b.lastToucherId);
        if (!toucher || toucher->role == Role::GK || toucher->sentOff) return;
        double nearestOpp = 1e9;
        for (auto& o : state.players)
            if (o.team != toucher->team && o.role != Role::GK && !o.sentOff)
                nearestOpp = std::min(nearestOpp, dist(o.x, o.y, toucher->x, toucher->y));
        if (nearestOpp < 60.0) return;   // pressured — a ball hacked clear is fine
        stats.recordSenselessOutOfPlay();
    };
    auto clearState = [&]() {
        resolveKnockAhead(nullptr, "out_of_play");
        pendingPass.active = false;
        shot.clearFlags();
        lastLooseOrigin = LooseOrigin::None;
    };
    if (b.y < 0 || b.y > PITCH_H) {
        flagSenselessOut();
        clearState();
        // Law 15: the body-block knock-off (ricochet) returns before stamping
        // lastTouchTeam, so a ball rolled dead off a defender's shins was thrown
        // in by the WRONG side. Genuine touches clear the ricochet memory, so a
        // live stamp here means the ricochet IS the last contact — exactly the
        // corner/goal-kick logic above, applied to the touchline.
        Team outTeam = (lastRicochetMs > -1e8) ? lastRicochetTeam : lt;
        awardThrowIn(outTeam, b.y < 0 ? 0 : PITCH_H);
        return true;
    }
    if (b.x < HOME_GOAL_X) {
        // Centre-crossing (not whole-ball `b.x + BALL_R < ...`): a slow ball can
        // rest with its centre behind the goal line — out, but the whole-ball test
        // never fired, so no goal-kick/corner was awarded. The touchline test above
        // is already centre-based (b.y < 0); match it here.
        // A ball over the bar (or wide) is out — only one passing UNDER the bar
        // between the posts was a goal (already taken by checkGoal).
        bool inGoal = std::abs(b.y - PITCH_H / 2) <= GOAL_W / 2 && b.z + BALL_R <= GOAL_H
            // Law 15: an untouched throw-in is never a goal — fall through to
            // the corner/goal-kick award (mirrors the checkGoal refusal).
            && !(lastRestartReleaseType == SetPiece::ThrowIn && restartRetouchBlockedId >= 0
                 && b.lastToucherId == restartRetouchBlockedId);
        if (!inGoal) {
            if (lt != Team::Home) flagSenselessOut();   // away attacker put it behind for a goal kick
            clearState();
            if (lt == Team::Home
                // Validity, not a 700ms stopwatch (seed 437 1:04: a charged-down
                // cross hung ~2.1s before crossing the line and the window
                // expired — goal kick instead of the corner off the defender's
                // body). Every GENUINE touch now clears the ricochet memory, so
                // a live stamp here means the ricochet IS the last thing that
                // touched the ball, however long it flew.
                || (lastRicochetMs > -1e8 && lastRicochetTeam == Team::Home))
                awardCorner(Team::Away, true, b.y);
            else
                awardSetPiece(SetPiece::GoalKick, Team::Home);
            return true;
        }
    }
    if (b.x > AWAY_GOAL_X) { // centre-crossing (see HOME_GOAL_X note above)
        bool inGoal = std::abs(b.y - PITCH_H / 2) <= GOAL_W / 2 && b.z + BALL_R <= GOAL_H
            // Law 15: an untouched throw-in is never a goal — fall through to
            // the corner/goal-kick award (mirrors the checkGoal refusal).
            && !(lastRestartReleaseType == SetPiece::ThrowIn && restartRetouchBlockedId >= 0
                 && b.lastToucherId == restartRetouchBlockedId);
        if (!inGoal) {
            if (lt != Team::Away) flagSenselessOut();   // home attacker put it behind for a goal kick
            clearState();
            if (lt == Team::Away
                || (lastRicochetMs > -1e8 && lastRicochetTeam == Team::Away))   // validity, not a stopwatch — see the Home mirror above
                awardCorner(Team::Home, false, b.y);
            else
                awardSetPiece(SetPiece::GoalKick, Team::Away);
            return true;
        }
    }
    return false;
}

// ── First-time finish ── A driven LOW cross/cutback reaching an attacking
// runner in the box is swept in FIRST-TIME rather than trapped: it is too
// quick to control (it would skid through, or the keeper would gather it),
// but a finisher meeting it goal-side can strike it clean. We route through
// shootBall so it is a genuine tracked shot, and stamp throughCollected for
// the clean first-touch error model (a FOOT finish, not a header). This sits
// ahead of the keeper-gather so the striker who is first to the ball wins —
// but only when he is actually closer to it than any keeper.
// Cutbacks now finish first-time too (isCutback was a render-only hint): the
// pulled-back ball to an arriving runner at the spot is real football's
// signature close chance, but its reception was a normal trap — take a touch
// at 12m with defenders closing, recycle. Sweeping it first-time is what
// converts the engine's existing cutback volume into genuine box chances
// (shot mix sat at close 2% / medium 68%; real ~20/40). Lower speed gate
// than the driven cross — a cutback is a measured pull-back, not a whip.
// Returns true when it fired a shot (caller returns); false = fall through.
bool GameEngine::tryCutbackFirstTimeFinish(double bs) {
    auto& b = state.ball;
    if (b.controllerId < 0 && pendingPass.active && (pendingPass.isCross ? bs > 190.0 : pendingPass.isCutback && bs > 110.0) && b.intendedReceiverId >= 0 && b.z <= GROUND_MEET_MAX_Z + 6.0) {
        Player* rcv = playerById(b.intendedReceiverId);
        if (rcv && rcv->team == pendingPass.team && (rcv->role == Role::CF || rcv->role == Role::WM || rcv->role == Role::CM)) {
            double goalX = goalXFor(rcv->team);
            double tgd = std::abs(rcv->x - goalX);
            double dRcv = dist(rcv->x, rcv->y, b.x, b.y);
            // NOTE (measured): cutback receivers currently arrive at tgd ~195 —
            // OUTSIDE this 175 gate — so the cutback first-time finish rarely
            // fires yet. Widening the gate to 215 was A/B'd and REJECTED: it
            // just minted 20m first-time pot-shots (long-shot share up, goals
            // +0.5). The right fix is POSITIONING — the cutback runner must
            // attack the penalty-spot band (80-140px), not hang at the edge;
            // until then this fires only on the (correctly) well-positioned few.
            bool inBox = tgd < 175.0 && std::abs(rcv->y - PITCH_H / 2.0) < 200.0;
            bool reachable = dRcv <= MEET_REACH_GROUND + 10.0;
            bool keeperCloser = false;
            int frontPress = 0;
            double gkDistToRcv = 1e9;
            for (auto& o : state.players) {
                if (o.sentOff || o.team == rcv->team) continue;
                if (o.role == Role::GK) {
                    if (dist(o.x, o.y, b.x, b.y) < dRcv - 2.0) keeperCloser = true;
                    gkDistToRcv = std::min(gkDistToRcv, dist(o.x, o.y, rcv->x, rcv->y));
                } else if (dist(o.x, o.y, rcv->x, rcv->y) < 26.0)
                    frontPress++;
            }
            if (inBox && reachable && !keeperCloser) {
                // Law 11 (audit HIGH): this path cleared pendingPass and shot
                // without ever consulting the offside snapshot — a receiver
                // offside at the whip could sweep it in unflagged. Same judgment
                // as resolvePendingPass, from the same launch snapshot.
                // Round-30: this test used to sit ABOVE the dRcv/inBox/reachable
                // gates, and the enclosing guard is true on the FIRST tick after
                // any low cross leaves the foot — so the flag went up at the
                // STRIKE and awardOffsideFreeKick then dragged the ball up to
                // 265px to the flagged player's feet while it was still on the
                // kick spot. Offside is a decision about a player who BECOMES
                // INVOLVED, so judge it where the involvement happens: the r9
                // comment always said the point was to gate the SHOT. Deliberate
                // consequence: when keeperCloser is true this now falls through
                // and the keeper gathers with no offside given — correct, the
                // offside-positioned attacker never became involved at all.
                if (!pendingPass.offsideExempt && rcv->id == pendingPass.toId && pendingPass.receiverOffsideAtPass) {
                    stats.recordOffside();
                    emitEvent("offside", rcv->x, rcv->y, rcv->id, pendingPass.fromId);
                    pendingPass.active = false;
                    awardOffsideFreeKick(rcv->team == Team::Home ? Team::Away : Team::Home, *rcv);
                    return true;
                }
                // A keeper right on top of the chance smothers the tap-in — proximity
                // to the RUNNER (not just the ball) cuts the finish toward zero.
                double gkProx = clamp((55.0 - gkDistToRcv) / 55.0, 0.0, 1.0);
                double finishChance = clamp(0.50 + attrFactor(rcv->attrs.shooting) * 0.30 - frontPress * 0.16 - gkProx * 0.45 - clamp((bs - 250.0) / 600.0, 0.0, 0.16), 0.12, 0.88);
                if (rng.random() < finishChance) {
                    rcv->firstTouchFinish = 1400.0; // flat, clean foot finish (not a header)
                    pendingPass.active = false;
                    b.intendedReceiverId = -1;
                    shootBall(*rcv, nullptr);
                    return true;
                }
                // Scuffed the first-time effort — the ball runs loose.
                b.intendedReceiverId = -1;
                blockReboundFor(rcv->id, 200);
            }
        }
    }
    return false;
}

// A shot the keeper has already won the reflex roll on belongs to the
// deferred-save resolver (parry/punch/tip/catch) — don't let the generic
// keeper-gather scoop it first and flatten every save into a clean pickup.
// Returns true if he collected it (caller returns).
bool GameEngine::tryKeeperLooseGather(double bs) {
    auto& b = state.ball;
    if (b.controllerId < 0 && b.z <= AERIAL_HEIGHT && !pendingSave.active) {
        Player* keeperContact = nullptr;
        double bestKeeperScore = 1e9;
        for (auto& p : state.players) {
            if (p.role != Role::GK || !canContestBall(p)) continue;
            // A shot pre-rolled as beating the keeper clean can't be casually
            // scooped via positioning pickup after the failed reflex save —
            // but a DYING ball (<140px/s) is anyone's: a keeper watching a
            // trickler roll past him into the net is absurd. (Re-anchored from
            // 220 with the ~0.62x shot-speed reduction.)
            if (lastLooseOrigin == LooseOrigin::Shot && bs > 140.0 && p.team != shot.team && !shot.scoopAllowed) continue;
            double goalX = ownGoalXFor(p.team);
            bool ballInOwnArea = std::abs(b.x - goalX) < PENALTY_AREA_W && pitch::lateralFromCenter(b.y) < PENALTY_AREA_H / 2.0;
            if (!ballInOwnArea) continue;
            double d = dist(p.x, p.y, b.x, b.y);
            bool dyingShot = lastLooseOrigin == LooseOrigin::Shot && bs < 140.0;
            double reach = dyingShot ? GK_LOOSE_COLLECT_DIST + 6.0
                                     : (bs > 120.0 ? GK_LOOSE_COLLECT_FAST_DIST : GK_LOOSE_COLLECT_DIST);
            if (d > reach) continue;
            double score = d / reach;
            if (b.lastTouchTeam != p.team) score -= 0.18;
            if (score < bestKeeperScore) {
                bestKeeperScore = score;
                keeperContact = &p;
            }
        }
        if (keeperContact) {
            // A keeper gathering a beaten-but-reachable shot IS a save — but
            // only if the ball was actually goal-bound (else saves > shots-on-
            // target, which is impossible). Record the on-target shot too so
            // the ledger stays consistent (saves <= shotsOnTarget).
            if (lastLooseOrigin == LooseOrigin::Shot && keeperContact->team != shot.team) {
                double goalX = ownGoalXFor(keeperContact->team);
                double along = std::max(std::abs(b.vx), 1.0);
                double projY = b.y + b.vy * (std::abs(b.x - goalX) / along);
                bool goalBound = std::abs(projY - PITCH_H / 2.0) < GOAL_W / 2.0 + 6.0 && b.z + BALL_R <= GOAL_H; // #1b: under the bar too
                if (goalBound) {
                    stats.recordShotOnTarget();
                    // Real-world convention (Opta): EVERY on-target shot the keeper
                    // stops is a save, however routine the gather. The old >295px/s
                    // pace gate (#1c/#35) was calibrated when shotsOnTarget itself
                    // under-counted (it excluded scored shots pre-5519235), which
                    // made "saves = onTarget" look inflated — circular. With the
                    // on-target ledger complete, the audit read SoT 8.45 = goals
                    // 3.10 + saves 3.60 + 1.75 UNACCOUNTED (these scoops); counting
                    // them lands saves at ~5.3 (real 5-6) and closes the ledger.
                    stats.recordSave();
                    emitEvent("save", keeperContact->x, keeperContact->y, keeperContact->id);
                    keeperContact->diveAnim = std::max(keeperContact->diveAnim, 440.0); // render-only stretch
                }
            }
            // Reaching BEYOND standing arm length (23.5px) to gather a loose
            // ball means the keeper stretches/lunges for it — without this he
            // grabbed a ball 34px away looking planted, "well outside his
            // wingspan" (watched replay 0:44). diveAnim is render-only (feeds
            // no rng, no logic — engine_gk.cpp) so the golden is untouched.
            if (dist(keeperContact->x, keeperContact->y, b.x, b.y) > GK_STAND_REACH)
                keeperContact->diveAnim = std::max(keeperContact->diveAnim, 300.0);
            collectBall(*keeperContact);
            return true;
        }
    }
    return false;
}

    // ── KEEPER CROSS-CLAIM ──
    // A live cross the intended receiver did NOT win, hanging in the keeper's
    // own 6-yard zone at takeable height: he comes and claims it. Sits AFTER the
    // intended-receiver block (the striker gets first refusal) and BEFORE the
    // generic loop, returning on commit so the GK-skip path never double-handles.
    // Every gate condition is deterministic board state — NO rng before commit.
bool GameEngine::tryKeeperCrossClaim() {
    auto& b = state.ball;
    if (pendingPass.active && pendingPass.isCross && b.controllerId < 0 && b.z >= GK_CLAIM_MIN_Z && b.z <= GK_CLAIM_MAX_Z) {
        Player* gk = nullptr;
        for (auto& p : state.players) {
            if (p.role != Role::GK || p.team == pendingPass.team) continue; // defending keeper
            if (!canContestBall(p)) continue;
            gk = &p;
            break;
        }
        if (gk && agentFor(*gk)->canUseHands()) {
            double goalX = ownGoalXFor(gk->team);
            double bdg = std::abs(b.x - goalX);
            bool inZone = bdg < GK_CLAIM_DEPTH && pitch::lateralFromCenter(b.y) < GK_CLAIM_HALF_W;
            double dz = std::max(0.0, b.z - GK_CLAIM_REACH_Z);
            double claimD = std::hypot(dist(gk->x, gk->y, b.x, b.y), dz);
            if (inZone && claimD <= GK_CLAIM_RADIUS) {
                resolveCrossClaim(*gk, claimD); // draws rng, then RETURNS
                return true;
            }
        }
    }
    return false;
}

    // Intended receiver gets priority with larger collection radius. A driven
    // cross arrives way over the 250 trap-speed limit — but it isn't trapped,
    // it's MET (header), so the band-height arrival bypasses the speed gate.
bool GameEngine::tryIntendedReceiverMeet(double bs) {
    auto& b = state.ball;
    bool crossArrival = pendingPass.active && pendingPass.isCross && b.z >= HEADER_MIN_HEIGHT && b.z <= HEADER_MAX_HEIGHT;
    if (b.intendedReceiverId >= 0 && (bs < 250 || crossArrival)) {
        Player* intended = playerById(b.intendedReceiverId);
        if (intended) {
            double d = dist(intended->x, intended->y, b.x, b.y);
            // Z-AWARE SLANT REACH (not a horizontal cylinder). A header reaches
            // up to HEADER_REACH_Z high; the true ball->contact range is the
            // slant hypot of the horizontal gap and the height above that reach.
            // The old flat (d<=meetDist && z<=64) let a runner "meet/head" a
            // cross from ~3-4m and even at chest height — the ghost deflection.
            double reachZ = crossArrival ? HEADER_REACH_Z : 0.0;
            double reach = crossArrival ? MEET_REACH_HEAD : MEET_REACH_GROUND;
            double zGate = crossArrival ? HEADER_MAX_HEIGHT : GROUND_MEET_MAX_Z;
            double dz = std::max(0.0, b.z - reachZ);
            double meetD3 = std::sqrt(d * d + dz * dz);
            // Aerial duel: a marker tight on the runner attacks the same ball —
            // but only if HE is genuinely within header reach of the BALL, not
            // just near the runner (the old od<48 picked a man up to ~7m off
            // the ball, who then "headed it clear" in mid-air).
            if (crossArrival && meetD3 <= reach && b.z <= zGate && canContestBall(*intended)) {
                Player* dueler = nullptr;
                double duelerDist = 1e9;
                for (auto& opp : state.players) {
                    if (opp.team == intended->team || opp.role == Role::GK || !canContestBall(opp)) continue;
                    double od = dist(opp.x, opp.y, intended->x, intended->y);
                    double obd = dist(opp.x, opp.y, b.x, b.y);
                    double obz = std::max(0.0, b.z - HEADER_REACH_Z);
                    double ob3 = std::sqrt(obd * obd + obz * obz);
                    // Same slant reach as the receiver's own meet grant: the
                    // 28:45 phantom (seed 111) granted the header at meetD3~19
                    // while the defender 20.4px from the BALL failed the tighter
                    // MEET_REACH_HEAD gate and was never consulted. Symmetric
                    // reach = whoever is genuinely closer contests.
                    if (od < 48.0 && ob3 <= reach + 4.0 && od < duelerDist) {
                        dueler = &opp;
                        duelerDist = od;
                    }
                }
                if (dueler) {
                    // Aerial duel blends positioning with HEIGHT (50/50): a tall
                    // stopper out-jumps a small attacker on crosses. height defaults
                    // to positioning, so this is byte-identical until a spec sets a
                    // distinct height (then the tall man wins more).
                    double dAer = 0.5 * attrFactor(dueler->attrs.positioning) + 0.5 * attrFactor(dueler->attrs.height);
                    double iAer = 0.5 * attrFactor(intended->attrs.positioning) + 0.5 * attrFactor(intended->attrs.height);
                    // Defender-favoured base (0.52 -> 0.58): the marker attacks a
                    // whipped ball moving TOWARD him — real defenses win most
                    // contested aerials, and at 0.52 the engine ran 30% headed
                    // goals (real 15-20%).
                    double duelChance = clamp(0.58 + (dAer - iAer) * 0.35 + (48.0 - duelerDist) / 48.0 * 0.18, 0.12, 0.80);
                    if (rng.random() < duelChance) {
                        dueler->headingAnim = 520.0;
                        collectBall(*dueler); // routes to header clearance
                        return true;
                    }
                    // One jump per cross — a beaten dueler doesn't get to
                    // re-roll every tick the ball hangs in his radius.
                    blockReboundFor(dueler->id, 420);
                }
            }
            if (meetD3 <= reach && b.z <= zGate && crossArrival && bs > 300.0 && canContestBall(*intended) && rng.random() > CROSS_MEET_BASE + attrFactor(intended->attrs.positioning) * CROSS_MEET_SKILL) {
                blockReboundFor(intended->id, 380);
            } else if (meetD3 <= reach && b.z <= zGate) {
                if (canContestBall(*intended)) {
                    // Find the tightest opponent and whether he's GOAL-SIDE
                    // (in front) of the receiver — receiving front-to-front
                    // with a defender between you and goal is the hard case:
                    // you can't turn, and controlling cleanly is far from
                    // guaranteed. A defender behind/beside is far less of a
                    // threat (you can shield and roll away).
                    double ifd = fdFor(intended->team);
                    double nearOppD = 1e9;
                    double frontPress = 0.0;
                    int tightMarkers = 0;
                    for (auto& opponent : state.players) {
                        if (!isActiveOpponent(opponent, intended->team)) continue;
                        double od = dist(opponent.x, opponent.y, intended->x, intended->y);
                        if (od < 32.0) tightMarkers++; // sandwiched count
                        if (od < nearOppD) {
                            nearOppD = od;
                            double goalSide = (opponent.x - intended->x) * ifd; // >0 in front
                            // Only TIGHT pressure (<26px) disrupts control —
                            // a defender 3-4m off lets you take it cleanly.
                            // The curve is steep so only true front-to-front
                            // (a stride away, goal-side) really bites.
                            double prox = clamp((26.0 - od) / 26.0, 0.0, 1.0);
                            frontPress = prox * (goalSide > 0.0 ? 1.0 : goalSide > -14.0 ? 0.45
                                                                                         : 0.1);
                        }
                    }
                    // A second tight marker adds pressure regardless of side —
                    // a sandwiched receiver rarely controls a driven ball.
                    if (tightMarkers >= 2) frontPress = std::max(frontPress, 0.55);
                    if (nearOppD >= 42.0) {
                        collectBall(*intended);
                        return true;
                    }
                    // Control degrades with pace and, heavily, with front
                    // pressure. A striker fronted tight by a CB usually CAN'T
                    // just take it cleanly — he has to shield, lay off, or
                    // loses it. The base is deliberately modest so tight front
                    // pressure can pull it well down.
                    double trapChance = clamp(0.50 + attrFactor(intended->attrs.positioning) * 0.28 + attrFactor(intended->attrs.passing) * 0.12 - clamp((bs - 95.0) / 360.0, 0.0, 0.20) - frontPress * 0.85, 0.10, 0.92);
                    if (rng.random() < trapChance) {
                        stats.recordPressuredReception(false);
                        collectBall(*intended);
                        return true;
                    }
                    stats.recordPressuredReception(true);
                    b.intendedReceiverId = -1;
                    receiverShieldTargetId = -1;
                    blockReboundFor(intended->id, 150);
                }
            }
        }
    }
    return false;
}

// Resolve the actual ball-vs-player contact this tick: intended-receiver trap,
// the nearest-contact pick, and the collect/collision/deflection outcome. The
// swept-path setup lives here because only this phase uses prevX/prevY + radii.
// Find the player (if any) whose body the ball contacts this tick — swept-path for
// fast balls, point test for slow. Sets contactRadius (for the caller's post-
// collision ball placement); returns nullptr if nothing is in contact.
Player* GameEngine::findBallContact(double sec, double& contactRadius) {
    auto& b = state.ball;
    double bs = std::hypot(b.vx, b.vy);
    const double collectRadius = COLLECT_DIST;
    const double fastContactRadius = PLAYER_R + BALL_R - 3.0;
    // Swept-contact origin (user feedback #2 "the ball just travels through the player"): a FAST loose
    // ball moves up to ~15px/tick (bs~900px/s × FIXED_DT) against a ~13.5px contact radius, so a single
    // end-of-tick POINT test lets it skip PAST a player between ticks (the closest approach falls mid-tick).
    // For fast balls we test each player against the ball's PATH this tick (prev→cur), not just the
    // endpoint; slow balls keep the point test (byte-identical). prev = undo the step applyBallPhysics
    // just applied (b.x += b.vx*sec). Live shots stay protected by the shot-in-flight gate below.
    double prevX = b.x - b.vx * sec, prevY = b.y - b.vy * sec;
    // Shared incidental-ricochet geometry: surface the ball on the body, reflect
    // the into-body velocity component, damp, and stamp the restart-attribution
    // memory (lastRicochetTeam — never possession/offside; see engine.h).
    auto ricochetOffBody = [&](Player& p, double damp) {
        double nx = b.x - p.x, ny = b.y - p.y, nd = std::hypot(nx, ny);
        if (nd < 1e-6) {
            nx = -b.vx / bs;
            ny = -b.vy / bs;
            nd = 1.0;
        }
        nx /= nd;
        ny /= nd;
        b.x = p.x + nx * (PLAYER_R + BALL_R);
        b.y = p.y + ny * (PLAYER_R + BALL_R);
        double dot = b.vx * nx + b.vy * ny;
        if (dot < 0) {
            b.vx -= COLLISION_REFLECT_FACTOR * dot * nx;
            b.vy -= COLLISION_REFLECT_FACTOR * dot * ny;
        }
        lastRicochetTeam = p.team;
        lastRicochetMs = state.clockMs;
        b.vx *= damp;
        b.vy *= damp;
        // A body clips the loft too (seed 437 1:04: a charged-down cross kept
        // its full vz through THIS path and floated up 6m — the round-16 fix
        // damped vz only in the resolveBallContact block-path). Same
        // restitution on the vertical, and never exit steeper than the
        // surviving horizontal allows.
        b.vz *= damp;
        capSteepness(b, 1.2);
        recordBallImpulse();
    };
    Player* contact = nullptr;
    contactRadius = collectRadius;
    double bestContactScore = 1e9;
    bool intendedNearby = false;
    if (pendingPass.active && b.intendedReceiverId >= 0) {
        if (Player* intended = playerById(b.intendedReceiverId)) {
            // Only while the ball is still COMING to him: once a pass has
            // overshot the intended receiver and is rolling away, a teammate
            // must be allowed to rescue it — the old unconditional skip had a
            // winger escort his own team's overrun pass at 10px for two full
            // seconds, barred from touching it, straight into an opponent's
            // interception (watched replay seed 133 1:06).
            bool approaching = (intended->x - b.x) * b.vx + (intended->y - b.y) * b.vy > 0.0;
            intendedNearby = approaching && dist(intended->x, intended->y, b.x, b.y) < INTENDED_NEARBY_DIST;
        }
    }

    for (auto& p : state.players) {
        if (!canContestBall(p)) {
            // ── Ghost-body fix (user-reported: "ball passes through a player") ──
            // A contest lockout (beaten defender 600-950ms, tackle loser, recent
            // passer 450-900ms, whiffed reaction duel 360ms) made the player's
            // whole BODY a ghost: trace analysis measured ~900 opponent + ~800
            // recent-toucher frame-hits per match where a grounded ball rolled
            // DEAD-CENTER (<8px) through a body with velocity unchanged. A locked
            // player can't WIN the ball, but he still has legs — a true center
            // hit ricochets off him (grazes at 10.5-13.5px still pass by, matching
            // the whiff branch's "passes clean" intent for near-misses; the band
            // was <8 but fast balls threading 9-11px through a body still read
            // as passing through a leg on replay). The
            // ricochet is incidental: lastTouch is NOT updated (no possession /
            // offside / restart-attribution side effects), no new lockouts.
            // Exempt: GK (own handling paths), sent-off (parked off-pitch), armed
            // set-pieces (everyone is contest-blocked while the ball is placed),
            // aerial balls. Live shots USED to be exempt too ("the blocker rule
            // owns those") — but that made locked bodies fully transparent to
            // shots (seed 173 0:54: Bale's strike ran 7.2px THROUGH Marcelo and
            // out, no corner). A dead-center shot hit deflects like any other;
            // the blocker rule only governs DELIBERATE ball-winning.
            if (p.role != Role::GK && !p.sentOff && !setPiece.armed && b.controllerId < 0 && b.z < 15.0 && bs > 30.0) {
                double sx = b.x - prevX, sy = b.y - prevY, seg2 = sx * sx + sy * sy;
                double tg = seg2 > 1e-6 ? clamp(((p.x - prevX) * sx + (p.y - prevY) * sy) / seg2, 0.0, 1.0) : 0.0;
                double dg = dist(p.x, p.y, prevX + sx * tg, prevY + sy * tg);
                double toward = (p.x - b.x) * b.vx + (p.y - b.y) * b.vy;
                if (dg < 10.5 && toward > 0.0)
                    ricochetOffBody(p, 0.72);   // a leggy, messy ricochet, not a clean block
            }
            continue;
        }
        // Fast ball → swept distance (closest approach of the player to the prev→cur path);
        // slow ball → the original endpoint test (byte-identical, no tunnelling at low speed).
        double d;
        if (bs > COLLISION_FAST_CONTACT) {
            double sx = b.x - prevX, sy = b.y - prevY, seg2 = sx * sx + sy * sy;
            double t = seg2 > 1e-6 ? clamp(((p.x - prevX) * sx + (p.y - prevY) * sy) / seg2, 0.0, 1.0) : 0.0;
            d = dist(p.x, p.y, prevX + sx * t, prevY + sy * t);
        } else
            d = dist(p.x, p.y, b.x, b.y);
        // A live shot is only touchable by its pre-rolled blocker — everyone
        // else lost their one deliberate chance at launch. Keyed on the loose
        // origin (not shot.active, which the GK assessment clears at 250px).
        // Exception: defenders ASSIGNED to the shot lane are the designated
        // wall — deliberate positioning earns physical contact; bystanders
        // still can't eat shots.
        bool shotInFlight = lastLooseOrigin == LooseOrigin::Shot && bs > 95.0;
        bool designatedWall = false;
        if (shotInFlight && p.id != shot.blockerId && p.team != shot.team && p.role != Role::GK) {
            const auto* task = assignmentFor(p.id);
            designatedWall = task && task->role == DefensiveTask::ShotLane;
        }
        if (shotInFlight && p.role != Role::GK && p.id != shot.blockerId && !designatedWall) {
            // Bystanders can't deliberately EAT a live shot — but a TRUE center
            // hit (<8px; d is already swept at shot speed) is physical contact:
            // the ball strikes the body and deflects, and the ricochet memory
            // awards the restart (seed 173 0:54: the shot off Marcelo that ran
            // behind must be a corner, not a goal kick). Grazes still pass by.
            if (d < 8.0 && b.z < AERIAL_HEIGHT)
                ricochetOffBody(p, 0.80);   // a deflection keeps more pace than a leggy loose-ball ricochet
            continue;
        }
        // A same-team CHASER who is NOT the intended receiver contests a live
        // overrun exactly like an opponent — give him the fast-contact reach
        // too. The team-asymmetric radius let a 12.9px near-miss on an 82px/s
        // ball thread the 8-13.5px band only the OPPONENT was allowed to use,
        // and the opponent cut it out (seed 111 1:39: 7R "should have got
        // there... ball drifted past him").
        double r = (bs > COLLISION_FAST_CONTACT
                    && (p.team != b.lastTouchTeam || p.id != b.intendedReceiverId))
                   ? fastContactRadius : collectRadius;
        // Micro audit #4: a fast FRIENDLY ball dead-center through a teammate's
        // body tunneled straight through (24 times/5min) — the fast-contact
        // radius was opponents-only, and the ghost-body ricochet covers only
        // contest-locked players. A true center hit (<8px) on a teammate who
        // is NOT the intended receiver connects like any body would.
        if (bs > COLLISION_FAST_CONTACT && p.team == b.lastTouchTeam
            && p.id != b.intendedReceiverId && d < 8.0)
            r = std::max(r, 8.0);
        // A dead ball is collectible from a stride away — opponent separation
        // (24px) parked two players 10-12px from it, just outside the 8px
        // radius, in a 2.8s Mexican standoff ~43 times a match.
        if (bs < 30.0) r = std::max(r, COLLECT_DIST + 6.0);
        // The chosen blocker / wall gets the FULL block reach (leg+body across the
        // lane), matching the block-roll radius — otherwise a defender selected to
        // block at perp 14-27px never connects (fastContactRadius is only 13.5px),
        // which is why shotsBlocked sat at 0.
        if (shotInFlight && (p.id == shot.blockerId || designatedWall)) r = PLAYER_R + BALL_R + 11.0;
        if (d > r) continue;
        // Cross contact uses the same z-aware slant reach as tryIntendedReceiverMeet:
        // you can only head what your leap actually reaches. The old flat z<=64 gate
        // let a flat-footed CB "head" a dropping cross from 3.8m up — rendered with
        // the ball's z-lift, the contact appears a body-length from his dot, between
        // other players (watched replay seed 133 0:28, the ghost header).
        if (pendingPass.active && pendingPass.isCross) {
            double dzc = std::max(0.0, b.z - HEADER_REACH_Z);
            if (std::sqrt(d * d + dzc * dzc) > std::max(r, MEET_REACH_HEAD)) continue;
        } else if (b.z > AERIAL_HEIGHT) continue;
        if (p.role == Role::GK) {
            continue;
        }
        // Intended receiver already handled above — skip them here
        if (p.id == b.intendedReceiverId) continue;
        if (pendingPass.active && intendedNearby && p.team == pendingPass.team && bs < INTENDED_PASS_SPEED_LIMIT) continue;
        double score = d / std::max(1.0, r);
        // Round-24: the flat 50/50 loose-ball edge to the defending team (0.10)
        // is half the interception/turnover story — every contested loose ball
        // tilted to the opponent. Halve it 0.10->0.05 so a marginal 50/50 is
        // genuinely even and the attacking side keeps its fair share.
        if (p.team != b.lastTouchTeam) score -= 0.05;
        if (score < bestContactScore) {
            bestContactScore = score;
            contact = &p;
            contactRadius = r;
        }
    }

    return contact;
}

void GameEngine::resolveBallContact(double sec) {
    auto& b = state.ball;
    double bs = std::hypot(b.vx, b.vy);
    double contactRadius = COLLECT_DIST;
    Player* contact = findBallContact(sec, contactRadius);
    if (!contact) return;
    if (pendingPass.active && pendingPass.isCross && b.z >= HEADER_MIN_HEIGHT && b.z <= HEADER_MAX_HEIGHT) {
        // Cutting out a whipped delivery is a duel, not a given — the old
        // unconditional collect meant the first body on the flight line ate
        // every driven cross. A whiff locks the defender out so it flies past.
        if (contact->team != pendingPass.team && bs > 300.0) {
            double cutChance = clamp(CROSS_CUTOUT_BASE + attrFactor(contact->attrs.positioning) * CROSS_CUTOUT_SKILL - (bs - 300.0) / 700.0, 0.08, 0.58);
            if (rng.random() >= cutChance) {
                blockReboundFor(contact->id, 420);
                return;
            }
        }
        // A defender cutting out a cross near his own line often puts it BEHIND for a
        // corner rather than controlling it cleanly — the dominant real corner source.
        // With 250+ crosses/match this is the main lever toward a realistic count
        // (engine sat at ~2 vs ~10 because every cut was a clean collect).
        if (contact->team != pendingPass.team) {
            double ownLineX = ownGoalXFor(contact->team);
            // A cut only becomes a corner if the ball is genuinely going BEHIND —
            // heading toward the defender's GOAL line and crossing it in bounds. An
            // overhit cross drifting off the pitch over the TOUCHLINE by the corner
            // flag is a throw-in, not the crossing team's corner (watched replay
            // seed 105 1:46: 11R's cross ran out over the top touchline at the flag
            // — moving AWAY from the goal line in x, out over y=0 — yet a red corner
            // was awarded, a "ghost corner"). Project the flight to the goal line:
            // require it to be heading there and to cross between the touchlines.
            double toLine = ownLineX - b.x;                 // signed distance to that goal line
            bool headingBehind = toLine * b.vx > 0.0;       // moving toward it, not away
            double tLine = std::abs(b.vx) > 1.0 ? toLine / b.vx : 1e9;   // time to reach the line
            double yAtLine = b.y + b.vy * tLine;            // y where it would cross the goal line
            // He only clears a cross BEHIND for a corner when it is a genuinely
            // DANGEROUS delivery dropping into the goalmouth — not one projected to
            // cross WIDE of the posts (that is sailing out for a goal kick off the
            // attacker; a defender near it did not "concede a corner"). Instrumented
            // seed 105 1:46: the cross crossed the away line ~70px wide of the near
            // post, yet a red corner was manufactured off a body it merely passed.
            bool dangerousCross = tLine > 0.0 && std::abs(yAtLine - PITCH_H / 2.0) < GOAL_W / 2.0 + 55.0;
            // And he must be GOAL-SIDE of the ball (between it and his own line) to
            // put it behind — a defender level with or behind the ball can't cut it out.
            bool defenderGoalSide = std::abs(contact->x - ownLineX) <= std::abs(b.x - ownLineX) + BALL_R;
            if (std::abs(b.x - ownLineX) < 175.0 && headingBehind && dangerousCross && defenderGoalSide && rng.random() < 0.55) { // corners 2.7->6.5: dominant source. VOLUME is capped by the cut-near-line rate, not this probability.
                // Physically DEFLECT it behind — never award instantly. The instant
                // awardCorner here TELEPORTED a live ball out of the box to the flag
                // (watched replay seed 103 0:30: a corner's own cross was cut at
                // (957,279) and the ball snapped to (1044,674) one tick later,
                // because the taker still stood at the flag so the glide was
                // skipped). Give the defender a real scuffed touch: kill most of
                // the incoming pace, send it toward his own goal line angled away
                // from the mouth, with a bit of lift. checkOutOfPlay then awards
                // the corner when the ball ACTUALLY crosses, glide and all — and
                // if the scuff drifts out by the flag for a throw-in instead,
                // that's football.
                double lineDir = (ownLineX == 0.0) ? -1.0 : 1.0;
                double sideDir = b.y < PITCH_H / 2.0 ? -1.0 : 1.0;
                // Speed scales with distance to the line so the deflection genuinely
                // crosses despite airborne drag (an under-hit one stalled in-field —
                // corners collapsed 4.3 -> 3.0/30min on the first cut of this fix).
                double defl = std::max(clamp(bs * 0.45, 150.0, 260.0),
                                       std::abs(ownLineX - b.x) / 0.55);
                b.vx = lineDir * defl;
                b.vy = sideDir * defl * (0.35 + rng.random() * 0.40);
                b.vz = 60.0 + rng.random() * 90.0;
                b.z = std::max(b.z, 1.0);
                b.lastTouchTeam = contact->team;
                b.lastToucherId = contact->id; lastRicochetMs = -1e9;   // genuine touch supersedes ricochet restart memory
                pendingPass.active = false;
                blockReboundFor(contact->id, 500);
                return;
            }
        }
        collectBall(*contact);
        return;
    }
    if (bs < COLLISION_SPEED_THRESH) {
        collectBall(*contact);
        return;
    }
    if (bs > COLLISION_SPEED_THRESH) {
        double dx = b.x - contact->x, dy = b.y - contact->y, d2 = std::hypot(dx, dy);
        if (d2 < 1) return;
        double nx = dx / d2, ny = dy / d2;
        double dot = b.vx * nx + b.vy * ny;
        // A ball moving AWAY from the player isn't a touch: phantom grazes
        // applied damp, flipped last-touch, and rebound-blocked bystanders
        // (600ms, re-applied per tick) just for standing near a pass lane.
        if (dot >= 0) return;
        // A fast loose ball driven AT an opponent's body is a reaction duel,
        // not a given: the chance to get a touch in falls off hard with pace —
        // a ~24m/s ball is blockable, a rocket usually flies past. Same-team
        // balls (a shin deflection off a teammate) always make contact. A
        // whiffed read locks the bystander out (no per-tick re-roll) so it
        // passes clean instead of being eaten frame-by-frame.
        if (contact->team != b.lastTouchTeam) {
            double blockChance = clamp(LOOSE_BLOCK_BASE + attrFactor(contact->attrs.positioning) * LOOSE_BLOCK_SKILL - (bs - COLLISION_SPEED_THRESH) / LOOSE_BLOCK_SPEED_FALLOFF, 0.06, 0.92);
            if (rng.random() >= blockChance) {
                blockReboundFor(contact->id, 360);
                return;
            }
        }
        b.x = contact->x + nx * contactRadius;
        b.y = contact->y + ny * contactRadius;
        b.vx -= COLLISION_REFLECT_FACTOR * dot * nx;
        b.vy -= COLLISION_REFLECT_FACTOR * dot * ny;
        double damp = (b.lastTouchTeam == contact->team) ? COLLISION_DAMP_SAME_TEAM : COLLISION_DAMP_OPPONENT;
        b.vx *= damp;
        b.vy *= damp;
        // A block that kills the horizontal must kill the vertical too — a
        // charged-down whipped cross (H 300->136) kept its full vz=280 and
        // rocketed up at 64 degrees (seed 305 1:20, "ball just wobbled up").
        // Damp vz with the pace, and never leave a deflection steeper than
        // its surviving horizontal allows.
        b.vz *= damp;
        capSteepness(b, 1.2);
        double glance = (b.lastTouchTeam == contact->team) ? COLLISION_GLANCE_SAME : COLLISION_GLANCE_OPPONENT;
        b.vx += ny * bs * glance;
        b.vy += -nx * bs * glance;
        b.lastTouchTeam = contact->team;
        b.lastToucherId = contact->id; lastRicochetMs = -1e9;   // genuine touch supersedes ricochet restart memory
        if (contact->team == lastCollectionTeam) lastSameTeamCollectionMs = state.clockMs - 500;
        blockReboundFor(contact->id, 600);
        bool wallBlock = false;
        if (lastLooseOrigin == LooseOrigin::Shot && contact->id != shot.blockerId && contact->team != shot.team) {
            const auto* task = assignmentFor(contact->id);
            wallBlock = task && task->role == DefensiveTask::ShotLane;
        }
        if (lastLooseOrigin == LooseOrigin::Shot && (contact->id == shot.blockerId || wallBlock)) {
            // Handball (Law 12): a defender blocking INSIDE HIS OWN BOX sometimes stops it with an
            // arm -> penalty. Gated low (~1 per several matches), in-box only, a simple probabilistic
            // model (not full arm-geometry). Adds penalty VARIETY alongside the tackle-fouls.
            double hbLine = ownGoalXFor(contact->team);
            bool hbInBox = std::abs(b.x - hbLine) < PENALTY_AREA_W && std::abs(b.y - PITCH_H / 2.0) < PENALTY_AREA_H / 2.0;
            if (hbInBox && rng.random() < 0.040) {
                shot.active = false;
                shot.tracked = false;
                lastLooseOrigin = LooseOrigin::ShotBlock;
                stats.recordPenaltyAwarded();
                emitEvent("handball", contact->x, contact->y, contact->id, shot.shooterId);
                awardSetPiece(SetPiece::Penalty, shot.team);
            } else if (!hbInBox && rng.random() < 0.022) {
                // Law 12 completeness: the OUT-of-box block handball — a direct
                // free kick from the contact spot (rarer than the box variant:
                // arms come down naturally outside the area).
                shot.active = false;
                shot.tracked = false;
                lastLooseOrigin = LooseOrigin::ShotBlock;
                emitEvent("handball", contact->x, contact->y, contact->id, shot.shooterId);
                awardSetPiece(SetPiece::FreeKick, shot.team);
            } else {
                stats.recordShotBlocked();
                emitEvent("block", contact->x, contact->y, contact->id, shot.shooterId);
                shot.active = false;
                shot.tracked = false;
                lastLooseOrigin = LooseOrigin::ShotBlock;
                // A block close to the defender's own line that deflects goalward
                // often loops behind for a corner — another corner source the
                // engine never produced. COMMIT the deflection physically (no
                // instant award — that teleported live balls; see the cross-cut
                // deflection above): steepen the outbound component and lift it a
                // touch so the already-deflected ball genuinely carries behind,
                // then checkOutOfPlay awards the corner when it crosses.
                double ownLine = ownGoalXFor(contact->team);
                bool nearLine = std::abs(b.x - ownLine) < 150.0;
                bool deflectingBehind = (ownLine == 0.0) ? b.vx < 0 : b.vx > 0;
                if (nearLine && deflectingBehind && rng.random() < 0.80) { // corner boost (was 0.65)
                    double lineDir = (ownLine == 0.0) ? -1.0 : 1.0;
                    double bs2 = std::hypot(b.vx, b.vy);
                    b.vx = lineDir * std::max(std::abs(b.vx), std::max(bs2, 140.0) * 0.75);
                    b.vz = std::max(b.vz, 40.0 + rng.random() * 80.0);
                    b.z = std::max(b.z, 1.0);
                }
            }
        }
    }
}

void GameEngine::checkBallPlayerCollision(double sec) {
    auto& b = state.ball;
    double bs = std::hypot(b.vx, b.vy);

    // Phase 1 — first-time finish (cutback/low cross swept in by a box runner).
    if (tryCutbackFirstTimeFinish(bs)) return;

    // Phase 2 — keeper gathers a beaten-but-reachable loose shot in his area.
    if (tryKeeperLooseGather(bs)) return;

    if (tryIntendedReceiverMeet(bs)) return;

    if (tryKeeperCrossClaim()) return;
    // Phase 5 — resolve the actual ball/player contact.
    resolveBallContact(sec);
}

void GameEngine::collectBall(Player& c) {
    auto& b = state.ball;
    if (!canContestBall(c)) return;
    // Same-team snatch guard (2026-07-02 audit, the "fake pass then teleported
    // back" moment): a teammate could take over a just-touched ball within one
    // visual frame — control flapped #18→#15→#18 across consecutive ticks,
    // snapping the ball ~20px each flip. If MY team touched it <300ms ago, the
    // toucher is still on top of it, and it isn't a pass meant for me, it's
    // HIS ball — leave it. Opponents and intended receivers are unaffected.
    if (receiverShieldTargetId != c.id && lastCollectionTeam.has_value() && c.team == *lastCollectionTeam && state.clockMs - lastSameTeamCollectionMs < 300.0 && b.lastToucherId >= 0 && b.lastToucherId != c.id) {
        Player* prevT = playerById(b.lastToucherId);
        if (prevT && prevT->team == c.team && dist(prevT->x, prevT->y, b.x, b.y) < 45.0)
            return;
    }
    contestBlockedUntil[c.id] = 0;
    bool intended = receiverShieldTargetId == c.id;
    bool teammateTarget = receiverShieldTargetId >= 0 && b.lastTouchTeam == c.team;
    resolveKnockAhead(&c);
    if (resolvePendingPass(c)) return;
    if (c.role != Role::GK) {
        double fdx = b.x - c.x, fdy = b.y - c.y;
        double fd = std::hypot(fdx, fdy);
        if (fd > 0.1) {
            // Turn toward the ball, capped — the hard set spun players up to
            // 175 degrees in one 16ms tick on every reception.
            double want = std::atan2(fdy, fdx);
            double delta = std::atan2(std::sin(want - c.facing), std::cos(want - c.facing));
            c.facing += clamp(delta, -1.2, 1.2);
        }
    }
    if (lastCollectionTeam.has_value() && c.team == *lastCollectionTeam && state.clockMs - lastSameTeamCollectionMs < PING_PONG_WINDOW_MS) {
        teammatePingPongs++;
        stats.recordCollection(true);
    }
    // Assist bookkeeping: a fresh controlled touch ends any prior receive
    // link for this slot (a dribble/recovery is not an assisted goal).
    if (c.id >= 0 && c.id < 22 && receiverShieldTargetId != c.id) lastReceiveFrom[c.id] = -1;
    stats.recordControlledTouch(c.role);
    lastCollectionTeam = c.team;
    lastSameTeamCollectionMs = state.clockMs;
    // A keeper gathering a live ball holds it before distributing — without
    // this he could collect a 400px/s shot and punt it upfield in the SAME
    // tick, which read as the ball ricocheting off him like a pinball.
    double incoming = std::hypot(b.vx, b.vy);
    if (c.role == Role::GK) {
        // Law 12 back-pass (audit HIGH: 5/5 deliberate kicked back-passes in
        // the traced match became tackle-immune hand-holds): a deliberate
        // kicked pass from a teammate (intended receiver = me, last touch =
        // my team; headers/chests never set the intended receiver) may not be
        // picked up — the keeper plays it with his feet: a short feet window
        // instead of the protected 700-1500ms hold, and the release paths
        // keep it on the ground (no from-hands punt).
        gkHoldFeetOnly = b.intendedReceiverId == c.id && b.lastTouchTeam == c.team
            && pendingPass.active && pendingPass.team == c.team;
        goalKickMonitor.distributeTimer = std::max(goalKickMonitor.distributeTimer,
                                                   gkHoldFeetOnly ? 380.0
                                                                  : clamp(700.0 + incoming * 1.2, 700.0, 1500.0));
    } else if (c.id >= 0 && c.id < 22) {
        gkHoldFeetOnly = false;
        // Settle window before a deliberate pass — long for a fierce ball,
        // ~nil for a gently rolled one, shorter for a composed player. He can
        // still dribble/shield during it (and shoot a first-timer).
        double settle = clamp((incoming - 90.0) / 300.0, 0.0, 1.0) * (165.0 - attrFactor(c.attrs.positioning) * 110.0);
        // Fatigue: a tired first touch is heavier — the settle widens as the
        // tank empties (up to +50%), so late-game balls take longer to compose.
        // No-op at full stamina (golden shifts only via natural in-match drain).
        settle *= 1.0 + (1.0 - staminaFrac(c.stamina)) * 0.5;
        firstTouchUntilMs[c.id] = state.clockMs + settle;
    }
    // Law 11 rebound judgment: a shot-time-offside teammate collecting the
    // rebound off the frame or the keeper is offside (the poacher tap-in the
    // normal snapshot missed because shootBall killed pendingPass).
    if (shotSnapshotLive
        && (lastLooseOrigin == LooseOrigin::Shot || lastLooseOrigin == LooseOrigin::Woodwork
            || lastLooseOrigin == LooseOrigin::GoalkeeperParry || lastLooseOrigin == LooseOrigin::GoalkeeperPunch)
        && c.team == shotTeam && c.id >= 0 && c.id < 22 && offsideAtShot[c.id]) {
        shotSnapshotLive = false;
        stats.recordOffside();
        emitEvent("offside", c.x, c.y, c.id, -1);
        awardOffsideFreeKick(c.team == Team::Home ? Team::Away : Team::Home, c);
        return;
    }
    if (c.team != shotTeam || lastLooseOrigin == LooseOrigin::None) shotSnapshotLive = false;
    shot.clearFlags();
    lastLooseOrigin = LooseOrigin::None;
    if (restartRetouchBlockedId >= 0 && c.id != restartRetouchBlockedId)
        restartRetouchBlockedId = -1;   // another player touched: the taker is free again
    b.controllerId = c.id;
    b.intendedReceiverId = -1;
    b.curl = 0.0;
    b.vx *= .3;
    b.vy *= .3;
    b.z = b.vz = 0;
    b.lastTouchTeam = c.team;
    b.lastToucherId = c.id; lastRicochetMs = -1e9;   // genuine touch supersedes ricochet restart memory
    c.dribbleType = 0;
    double fd = fdFor(c.team);
    c.targetX = clampToPitchX(c.x + fd * 28.0, 35.0);
    c.targetY = clampToPitchY(c.y, 35.0);
    if (intended) {
        receiverShieldUntil = state.clockMs + 300;
        receiverShieldedPlayerId = c.id;
        receiverShieldTargetId = -1;
    } else if (teammateTarget) {
        receiverShieldUntil = state.clockMs + 150;
        receiverShieldedPlayerId = c.id;
    } else {
        receiverShieldUntil = state.clockMs + 220;
        receiverShieldedPlayerId = c.id;
        receiverShieldTargetId = -1;
    }
}

bool GameEngine::collectBall(Player& c, const std::string&, double allowedDist) {
    auto& b = state.ball;
    if (b.controllerId >= 0) return false;
    if (!canContestBall(c)) return false;
    if (dist(c.x, c.y, b.x, b.y) > allowedDist + 0.001) return false;
    collectBall(c);
    return true;
}

void GameEngine::updateControlledBall(double sec) {
    // sec = SECONDS this tick (callers pass `sec`); the intra-tick re-glue
    // calls in moveBallCarrier pass 0 — they only re-anchor the target, the
    // convergence step below is driven by the once-per-tick timed call.
    Player* c = playerById(state.ball.controllerId);
    if (!c || phase.kickoffPhase) return;
    double dx = std::cos(c->facing), dy = std::sin(c->facing);
    double speed = std::hypot(c->vx, c->vy);
    double nearestOppDist = 1e9;
    double nearestOppX = 0.0, nearestOppY = 0.0;
    if (c->role != Role::GK) {
        for (const auto& o : state.players) {
            if (o.team == c->team || o.role == Role::GK) continue;
            double od = dist(c->x, c->y, o.x, o.y);
            if (od < nearestOppDist) {
                nearestOppDist = od;
                nearestOppX = o.x;
                nearestOppY = o.y;
            }
        }
    }
    if (c->role != Role::GK && speed > 18.0) {
        double mx = c->vx / speed, my = c->vy / speed;
        double facingMoveDot = dx * mx + dy * my;
        double moveBlend = facingMoveDot < 0.15 ? 0.75 : 0.35;
        if (nearestOppDist < 68.0) {
            double pressure = clamp((68.0 - nearestOppDist) / 68.0, 0.0, 1.0);
            double toOppX = (nearestOppX - c->x) / std::max(1.0, nearestOppDist);
            double toOppY = (nearestOppY - c->y) / std::max(1.0, nearestOppDist);
            double exposure = dx * toOppX + dy * toOppY;
            double shielded = exposure < -0.25 ? 1.0 : 0.0;
            moveBlend *= lerp(0.65, 0.86, shielded) - pressure * 0.08;
            moveBlend = clamp(moveBlend, 0.12, 0.75);
        }
        dx = dx * (1.0 - moveBlend) + mx * moveBlend;
        dy = dy * (1.0 - moveBlend) + my * moveBlend;
        double len = std::hypot(dx, dy);
        if (len > 0.001) {
            dx /= len;
            dy /= len;
        }
    }
    // Touch cadence (micro audit #1: a 7s carry held the ball at 6.8px +-0.1
    // — welded): the control offset follows a stride sawtooth — at each
    // "touch" the ball is knocked ahead (bigger at pace), then the carrier
    // closes on it until the next touch. Tight pressure shortens the leash
    // (close control in traffic). Deterministic — no rng, golden-safe apart
    // from geometry.
    double knockExtra = 0.0;
    // A carrier still inside his first-touch settle window (set by collectBall
    // at every fresh collect/interception/tackle win) is bringing the ball
    // under control, not striding with it.
    bool freshControl = c->role != Role::GK && c->id >= 0 && c->id < 22
        && firstTouchUntilMs[c->id] > state.clockMs;
    if (c->role != Role::GK && sec > 1e-6) {
        if (carryTouchCarrier != c->id) {
            carryTouchCarrier = c->id;
            carryTouchTravel = 0.0;
            carryLastPx = c->x; carryLastPy = c->y;
            carryOffDx = dx; carryOffDy = dy;   // fresh carrier: adopt his offset dir outright
        }
        carryTouchTravel += dist(c->x, c->y, carryLastPx, carryLastPy);
        carryLastPx = c->x; carryLastPy = c->y;
        // Round-28 C6 (Messi control model — "how Messi plays"): the old cadence
        // touched every ~1.4s and crushed the knock to ~1.8px under pressure — a
        // welded, invisible ball. Model close control as touch cadence: stride
        // ~speed*0.55 (a touch every ~0.5-0.7s), and in TIGHT space HALVE the
        // stride (more, smaller-but-visible touches) rather than crush the
        // amplitude. Knock floors VISIBLE (7px open, 5px pressed) and scales to
        // ~17px at sprint. NO friction decay between touches (round-11 reception-
        // teleport class + the arena ball-at-rest deadlock).
        bool tight = nearestOppDist < 40.0;
        double stride = std::max(6.0, speed * 0.55);
        if (tight) stride *= 0.5;
        if (carryTouchTravel >= stride) carryTouchTravel = 0.0;   // the next touch
        double peak = clamp(speed * 0.24, tight ? 5.0 : 7.0, 17.0);
        knockExtra = peak * (1.0 - carryTouchTravel / std::max(stride, 1.0));
    }
    // Round-28 C3: during the post-duel gather window tuck the ball to the foot
    // (no knock-ahead) so the winner's separation converges to ~CONTROL_DIST
    // (12px) rather than settling at the carry offset — the "he's got it" read.
    bool gatheringWin = c->id >= 0 && c->id < 22 && carrierGatherUntilMs[c->id] > state.clockMs;
    if (gatheringWin) knockExtra = 0.0;
    // Offset swing-rate limit (seed 437 0:59, watched at 0.25x: "ball seems to
    // teleport a small distance around the body"): the facing/movement blend
    // swung the control offset ~95deg in 3 ticks, so the glued ball ORBITED
    // the carrier at the full converge cap — a 337px/s phantom (9x his real
    // 37px/s). The offset direction now rotates at most ~0.14rad/tick toward
    // the blend's request; position tracking is unchanged, only the orbit
    // rate is human.
    if (c->role != Role::GK && sec > 1e-6) {
        double want = std::atan2(dy, dx);
        double cur = std::atan2(carryOffDy, carryOffDx);
        double turn = std::atan2(std::sin(want - cur), std::cos(want - cur));
        double lim = 0.14;
        double ang = cur + clamp(turn, -lim, lim);
        carryOffDx = std::cos(ang);
        carryOffDy = std::sin(ang);
        dx = carryOffDx;
        dy = carryOffDy;
    }
    double tx = clamp(c->x + dx * (CONTROL_DIST + knockExtra), 5.0, PITCH_W - 5.0);
    double ty = clamp(c->y + dy * (CONTROL_DIST + knockExtra), 5.0, PITCH_H - 5.0);
    // Step the carried ball toward its control offset instead of hard-snapping.
    // The snap was THE dominant "ball flows weird" artifact: 89% of receptions
    // jumped the ball 10-21px in a single tick (first-4-min audit, fixture
    // 2245). Cap follows the carrier's pace + a firm-touch allowance, so the
    // ball converges to the same offset within ~2-3 ticks and a reception
    // reads as a touch, not a teleport. Big separations (placement/teleport
    // cases >60px) still snap — those are deliberate resets.
    double prevBx = state.ball.x, prevBy = state.ball.y;
    double mx = tx - state.ball.x, my = ty - state.ball.y;
    double md = std::hypot(mx, my);
    // First-touch settle (seed 305 1:58: Alves' CLEAN interception rendered as
    // a phantom deflection — the undiminished +300 firm-touch allowance flung
    // the ball to the forward control offset at ~300-335px/s AGAINST its
    // incoming roll on the very first control tick, and the honest velocity
    // derivation below faithfully reported the reversal). A fresh carrier
    // EASES the ball onto his foot; steady-state carries keep the firm
    // allowance so close control still converges in 2-3 ticks.
    // Round-23 (arena reaudit): the +300 steady-state allowance let the ball HOP
    // 360.7px/s between touches during a fast carry — a visible teleport ahead of
    // the carrier. Trim it to +220 (~285px/s peak): the ball still converges to
    // the control offset in 2-3 ticks, but stays under the carrier's own stride
    // rather than sling-shotting past him. Well below the +320 CarriedBallOverspeed
    // tripwire, so the census margin is preserved.
    // C3: the gather window pulls the just-won ball in faster (300 allowance,
    // held under the +320px/s CarriedBallOverspeed tripwire) so it reaches the
    // foot in 2-3 ticks; a clean fresh interception still eases at 60.
    double maxStep = (std::hypot(c->vx, c->vy) + (gatheringWin ? 300.0 : freshControl ? 60.0 : 220.0)) * sec;
    bool firstTimedCallThisTick = sec > 1e-6 && state.clockMs != glueStepDoneMs;
    if (firstTimedCallThisTick) glueStepDoneMs = state.clockMs;
    if (md < 60.0 && !(firstTimedCallThisTick && md <= maxStep)) {
        // Converging (or a repeat/0-time call): step at most maxStep once per
        // tick; repeat calls only re-anchor, they don't move the ball again.
        if (firstTimedCallThisTick && md > 1e-9) {
            state.ball.x += mx / md * maxStep;
            state.ball.y += my / md * maxStep;
        }
    } else {
        state.ball.x = tx;
        state.ball.y = ty;
    }
    // Truthful carried-ball velocity: the glue used to leave a stale (or zero)
    // vx/vy while writing position directly, so the recorded stream showed the
    // ball "moving right, velocity left" or moving with v=0 — renderer trails
    // and every velocity-reading probe lied during carries. Derive it from the
    // actual displacement; every release path overwrites it anyway. Only on
    // the first timed call — a repeat timed call sees ~zero displacement and
    // would wipe the honest value.
    if (firstTimedCallThisTick) {
        state.ball.vx = (state.ball.x - prevBx) / sec;
        state.ball.vy = (state.ball.y - prevBy) / sec;
        // CarriedBallOverspeed tripwire (mirror of OffBallOverspeed, for the
        // glued ball): a carried ball stepping faster than its carrier plus
        // the firm-touch allowance is the orbit/teleport class (seed 437
        // 0:59). Regression census only.
        double stepSpd = dist(state.ball.x, state.ball.y, prevBx, prevBy) / sec;
        if (stepSpd > std::hypot(c->vx, c->vy) + 320.0)
            stats.recordQualityFlag(QualityFlag::CarriedBallOverspeed);
    }
    // Controlled-ball body-block (seed 437 0:53: Ronaldinho spun the ball
    // "right in front of 8 then behind him into 11" — through 2.7px of pid21's
    // body center for ~170ms — and kept it: NO contact path runs while
    // controllerId >= 0, so the glue could drag the ball straight through a
    // defender). A body dead-center (<8px, the same threshold the loose-ball
    // ghost path trusts) on this tick's carried-ball sweep knocks it loose —
    // deterministic, no rng; the beaten carrier can't instantly re-collect.
    // Round-27 COMMIT 1 (owner 0:30 "ball magically went loose"): a controller
    // who just won a tackle (or read a feint) holds a possession shield
    // (receiverShieldUntil / receiverShieldedPlayerId, engine_actions.cpp:1345).
    // The body-block sweep below ignored that shield and stripped Van Dijk 17ms
    // after he won the ball (tackle_won 30.200 -> traceOnly steal 30.217). Honor
    // the shield here exactly like the beaten-defender guard honors an off-balance
    // opponent: no body-block strip of a freshly-shielded controller.
    if (firstTimedCallThisTick && c->role != Role::GK && !isCarrierShielded(c->id)) {
        double sx = state.ball.x - prevBx, sy = state.ball.y - prevBy, seg2 = sx * sx + sy * sy;
        for (auto& o : state.players) {
            if (o.team == c->team || o.role == Role::GK || o.sentOff) continue;
            // Round-21 (take-on audit) COMMIT 4c: a defender the carrier just beat
            // is off-balance and trailing — don't let this body-block sweep knock
            // the ball loose off him ~100ms after the win (stats say win, pitch
            // showed a turnover). He can't cancel the beat he just lost.
            if (beatenSlowUntilMs[o.id] > state.clockMs) continue;
            double t = seg2 > 1e-6 ? clamp(((o.x - prevBx) * sx + (o.y - prevBy) * sy) / seg2, 0.0, 1.0) : 0.0;
            double dg = dist(o.x, o.y, prevBx + sx * t, prevBy + sy * t);
            if (dg < 8.0) {
                double nx = state.ball.x - o.x, ny = state.ball.y - o.y, nd = std::hypot(nx, ny);
                if (nd < 1e-6) { nx = -dx; ny = -dy; nd = 1.0; }
                nx /= nd; ny /= nd;
                state.ball.x = o.x + nx * (PLAYER_R + BALL_R);
                state.ball.y = o.y + ny * (PLAYER_R + BALL_R);
                state.ball.vx = nx * 90.0;
                state.ball.vy = ny * 90.0;   // a leggy knock-off, not a clean tackle
                state.ball.controllerId = -1;
                c->dribbleType = 0;
                blockReboundFor(c->id, 350);
                lastRicochetTeam = o.team;
                lastRicochetMs = state.clockMs;
                // Classify the loose ball (guard tripped: a body knock-off
                // that rolled in scored as an UNKNOWN loose goal) — this is
                // the tackle-deflection family for every downstream consumer.
                lastLooseOrigin = LooseOrigin::TackleDeflection;
                // Round-26 (observability, trace-only): this body-block knock-off
                // resolves a possession change with NO event, hiding ~9% of all
                // possession changes from event-based tooling. Mark it so a future
                // round can safely measure/reduce this bucket. traceOnly => zero
                // gameplay/RNG/golden-hash effect; new trace line only.
                emitEvent("steal", o.x, o.y, o.id, c->id, /*traceOnly=*/true);
                recordBallImpulse();
                return;
            }
        }
    }
    state.ball.lastTouchTeam = c->team;
    state.ball.lastToucherId = c->id; lastRicochetMs = -1e9;   // genuine touch supersedes ricochet restart memory
}

void GameEngine::moveBallCarrier(double sdt) {
    Player* c = playerById(state.ball.controllerId);
    if (!c) return;
    if (c->id >= 0 && c->id < 22 && (lungeDashRemainPx[c->id] > 0.0
                                     || lungeDashDoneMs[c->id] == state.clockMs)) {
        // A tackle/take-on winner still finishing his committed dash, OR the
        // exact tick it just ended (Round-23): fixedUpdate already moved him this
        // tick, so stacking a full carry step on top spikes him to ~17 m/s for
        // one tick. Keep the ball glued while the dash lands / on the handoff tick.
        updateControlledBall(0);
        return;
    }
    if (c->dribbleType == 0) {
        c->targetX = c->x;
        c->targetY = c->y;
        c->vx = 0;
        c->vy = 0;
        updateControlledBall(0);
        return;
    }
    double limit = c->dribbleType == 1 ? DRIBBLE_CLOSE_SPEED : c->dribbleType == 3 ? DRIBBLE_FAST_SPEED
                                                                                   : DRIBBLE_MEDIUM_SPEED;
    double speed = attrFactor(c->attrs.speed) * limit;
    // Fatigue (queue #8): a tired carrier dribbles slower too. Running already scales by stamina
    // (agent_movement.cpp) but the carry did NOT, so a spent player still knocked it at full pace.
    // Same ramp: full above the slow threshold, down to a skill-based floor when exhausted.
    double dribSlowThr = STAMINA_SLOW_THRESHOLD * 100.0;
    if (c->stamina < dribSlowThr) {
        double staminaSkill = attrFactor(c->attrs.stamina);
        speed *= lerp(0.54 + staminaSkill * 0.20, 1.0, clamp(c->stamina / std::max(1.0, dribSlowThr), 0.0, 1.0));
    }
    // R28 C8 probe: jockey-locked carrier slows to a probing, ball-showing touch
    // (~0.7x) that INVITES the defender's commit — which the C7 commit-read then
    // punishes. The agent renews this only inside a hard-capped 0.4-0.9s window
    // of the lock (engine.h), so the dip can never latch into a static face-off.
    if (c->id >= 0 && c->id < 22 && probeSlowUntilMs[c->id] > state.clockMs) speed *= 0.7;
    double dx = c->targetX - c->x, dy = c->targetY - c->y, d = std::hypot(dx, dy);
    double secs = sdt / 1000.0, px = c->x, py = c->y;
    double previousSpeed = std::hypot(c->vx, c->vy);
    double previousAngle = previousSpeed > 5 ? std::atan2(c->vy, c->vx) : 0;
    double moveAngle = d > 1 ? std::atan2(dy, dx) : previousAngle;
    bool turnWasLimited = false;
    if (d > 1 && previousSpeed > 5) {
        double requestedTurn = std::atan2(std::sin(moveAngle - previousAngle), std::cos(moveAngle - previousAngle));
        // Path turn caps: a carrier carving 17 rad/s zigzagged on every target
        // jitter and read as spinning. Smooth arcs instead.
        double turnRate = c->dribbleType == 1 ? 9.0 : c->dribbleType == 3 ? 5.5
                                                                          : 7.5;
        double maxTurn = turnRate * secs;
        if (std::abs(requestedTurn) > maxTurn) {
            moveAngle = previousAngle + clamp(requestedTurn, -maxTurn, maxTurn);
            turnWasLimited = true;
        }
    }
    if (d > 1) {
        double step = std::min(speed * secs, d);
        if (step >= d) {
            c->x = c->targetX;
            c->y = c->targetY;
        } else {
            c->x += std::cos(moveAngle) * step;
            c->y += std::sin(moveAngle) * step;
        }
    }
    c->x = clamp(c->x, 5.0, PITCH_W - 5.0);
    c->y = clamp(c->y, 5.0, PITCH_H - 5.0);
    c->vx = (c->x - px) / secs;
    c->vy = (c->y - py) / secs;
    double actualSpeed = std::hypot(c->vx, c->vy);
    if (previousSpeed > 5 && actualSpeed > 5) {
        double actualTurn = std::abs(std::atan2(
            std::sin(std::atan2(c->vy, c->vx) - previousAngle),
            std::cos(std::atan2(c->vy, c->vx) - previousAngle)));
        double actualTurnDeg = actualTurn * 180.0 / 3.141592653589793;
        stats.recordCarrierTurn(actualTurn > 3.141592653589793 / 2, actualTurnDeg, turnWasLimited);
    }
    if (actualSpeed > 5) {
        double desiredFacing = std::atan2(c->vy, c->vx);
        double nearestOppDist = 1e9;
        double nearestOppX = 0.0, nearestOppY = 0.0;
        if (c->role != Role::GK) {
            for (const auto& o : state.players) {
                if (o.team == c->team || o.role == Role::GK) continue;
                double od = dist(c->x, c->y, o.x, o.y);
                if (od < nearestOppDist) {
                    nearestOppDist = od;
                    nearestOppX = o.x;
                    nearestOppY = o.y;
                }
            }
        }
        if (nearestOppDist < 68.0) {
            double awayAngle = std::atan2(c->y - nearestOppY, c->x - nearestOppX);
            double pressure = clamp((68.0 - nearestOppDist) / 68.0, 0.0, 1.0);
            double shieldBlend = lerp(0.14, 0.38, pressure);
            desiredFacing += std::atan2(std::sin(awayAngle - desiredFacing), std::cos(awayAngle - desiredFacing)) * shieldBlend;
        }
        double desiredStep = std::atan2(std::sin(desiredFacing - c->facing), std::cos(desiredFacing - c->facing)) * 0.28;
        double speedBlend = clamp((actualSpeed - 12.0) / 58.0, 0.0, 1.0);
        // Carrier-only cap: 0.24 rad/tick let body facing whirl after every
        // velocity jitter (the chaser-perception deadlock doesn't apply here).
        double maxFacingTurn = lerp(0.11, 0.055, speedBlend);
        c->facing += clamp(desiredStep, -maxFacingTurn, maxFacingTurn);
    }
    updateControlledBall(0);
}
