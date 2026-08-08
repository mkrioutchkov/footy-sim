#include "engine.h"
#include "agent.h"
#include <cmath>

// ══════════════════════════════════════════════════════════════
// Physics — ball physics, collision, collection, movement
// ══════════════════════════════════════════════════════════════
// That banner had grown to describe four subsystems in 1739 lines. What is left
// here is the first item and the pure kinematics: bodies do not interpenetrate,
// and a ball nobody owns flies by drag, gravity and one bounce. No rule, no
// contest, no possession — separateTeammates and applyBallPhysics are the two
// things every other ball path is layered on top of. The rest moved out whole:
//   collision  → engine_ball_contest.cpp  (the ordered per-tick contest)
//   collection → engine_collect.cpp       (collectBall, the grant of control)
//   movement   → engine_carry.cpp         (the ball at a carrier's feet)
//   the line/frame checks → engine_ball_bounds.cpp (goal, woodwork, out of play)
// predictBallPos stays with applyBallPhysics deliberately: it is that model
// forward-simulated, and the two must be edited together or the chase aid lies.

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
                if (p.role == Role::GK || p.sentOff || runtime[p.id].duel.contestBlockedUntil > state.clockMs) continue;
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
            double minDist = (gkPair || a.team != b.team) ? 24.0 : SEPARATION_DIST;
            // Pre-reject before the hypot (perf: this O(pairs) loop runs every
            // tick and nearly every pair is far apart). An axis gap >= minDist
            // already proves hypot >= minDist, so the `d >= minDist` skip below
            // fires either way — the shortcut cannot change who gets pushed.
            if (std::abs(dx) >= minDist || std::abs(dy) >= minDist) continue;
            double d = std::hypot(dx, dy);
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
        if (airborne && lastLooseOrigin != LooseOrigin::Shot
            && std::abs(vx) + std::abs(vy) > 179.0) {
            // |vx|+|vy| <= 179 bounds the speed under the 180 gate below with a
            // 1px/s margin (>> fp rounding), so the skipped hypot could never
            // have fired the extra drag — per-step cost only, same trajectory.
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
