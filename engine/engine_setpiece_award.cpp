// engine_setpiece_award.cpp — arming a restart: the spot, and who takes it
//
// Split out of engine_setpiece.cpp (1378 lines). The file it came from is about
// RELEASING a restart — the taker's foot meeting a ball that is already spotted
// and waiting. This is the other half of that story and the earlier one: the
// moment play stops, before anyone has walked anywhere.
//
// Each of these three sets setPiece.{type,team,armed,reason,spotX,spotY,takerId}
// and hands the rest to updateSetPiecePhase. They are called from wherever the
// ball died, never from each other: checkOutOfPlay (engine_ball_bounds.cpp) for
// the touchline and goal line, the foul paths in engine_tackle.cpp and the
// handball/keeper paths in engine_ball_contest.cpp, and the advantage timeout in
// engine.cpp. Offside arms its own free kick inline (engine_offside.cpp), which
// is why awardOffsideFreeKick is not one of these.
//
// The shared care they take is the same one: the whistle stops PLAY, not the
// ball mid-frame, so the out-ball keeps a decaying roll for placeBallAtMs before
// it is teleported to the spot.

#include "engine.h"
#include "agent.h"
#include "agent_helpers.h"
#include "setpiece_weights.h"
#include <cmath>
#include <cstdio>   // fprintf at the corner-debug site below (was inherited transitively)

void GameEngine::awardThrowIn(Team lastTouchTeam, double y) {
    auto& b = state.ball;
    Team atTeam = (lastTouchTeam == Team::Home) ? Team::Away : Team::Home;
    // Spot from where it crossed; the BALL itself keeps rolling out (glide)
    // instead of teleporting to the line — updateSetPiecePhase places it.
    double sx = clamp(b.x, 10., PITCH_W - 10);
    double sy = clamp(y, 3.0, PITCH_H - 3.0);
    b.controllerId = -1;
    b.intendedReceiverId = -1;
    setPiece.type = SetPiece::ThrowIn;
    setPiece.team = atTeam;
    setPiece.armed = true;
    setPiece.reason = "throw_in";
    if (const Player* tgk = findGK(atTeam))
        emitEvent("throw_in", sx, sy, tgk->id, -1, true);
    phase.actionTimer = 5000;
    setPiece.spotX = sx;
    setPiece.spotY = sy;
    setPiece.takerArrived = false;
    setPiece.placeBallAtMs = state.clockMs + OUT_BALL_GLIDE_MS;
    Player* best = findNearestOutfieldPlayer(atTeam, sx, sy);
    setPiece.takerId = best ? best->id : -1;
}

void GameEngine::awardSetPiece(SetPiece t, Team tm) {
    auto& b = state.ball;
    // Goal kicks restore these for the out-ball glide; pens stay dead. Free
    // kicks (fouls/offside) keep a decaying roll-out for ~0.4s before being
    // placed — the whistle stops PLAY, not the ball mid-frame (micro audit:
    // the offside ball warped 2.3m to the spot in one tick).
    double keepVx = b.vx, keepVy = b.vy, keepZ = b.z, keepVz = b.vz;
    b.vx = b.vy = b.z = b.vz = 0;
    if (t == SetPiece::FreeKick && std::hypot(keepVx, keepVy) > 60.0) {
        b.vx = keepVx * 0.45;
        b.vy = keepVy * 0.45;
        setPiece.placeBallAtMs = state.clockMs + 420.0;
    }
    b.controllerId = -1;
    setPiece.type = t;
    setPiece.team = tm;
    setPiece.armed = true;
    setPiece.fast = false;   // default; the FreeKick branch may set it true
    setPiece.runUpActive = false;   // FK run-up is planned fresh when the taker arrives
    setPiece.reason = std::string(to_string(t));
    setPiece.spotX = b.x;
    setPiece.spotY = b.y;
    setPiece.takerArrived = false;
    Team tmTeam = tm;

    if (t == SetPiece::GoalKick) {
        // Place the BALL at the goal-kick spot and let the keeper jog to it
        // via the generic taker walk — snapping him there teleported the GK
        // ~100px on every restart (the most frequent visual pop left).
        // 6s total (was 1.55s): a goal kick is a breather, not a quick restart —
        // part of the restart-pacing pass that brings in-play time toward real.
        // Round-21 (arena audit): the duel doesn't need the full breather — ~2s.
        phase.actionTimer = arenaMode ? 2000 : 6000;
        setPiece.takerId = -1;
        for (auto& p : state.players) {
            if (p.team == tmTeam && p.role == Role::GK) {
                double fd = fdFor(tmTeam);
                double side = b.y < PITCH_H / 2.0 ? -1.0 : 1.0;
                setPiece.spotX = ownGoalXFor(tmTeam) + fd * (40.0 + CONTROL_DIST);   // inside the 55px goal area (audit: 70px sat outside it)
                setPiece.spotY = clamp(PITCH_H / 2.0 + side * 78.0, 120.0, PITCH_H - 120.0);
                setPiece.takerId = p.id;
                break;
            }
        }
        if (setPiece.takerId >= 0)
            emitEvent("goal_kick", setPiece.spotX, setPiece.spotY, setPiece.takerId, -1, true);
        // The out-ball GLIDES (it used to vanish mid-flight at the line and
        // reappear dead at the spot); restore its flight and let
        // updateSetPiecePhase place it when the glide window closes.
        b.vx = keepVx;
        b.vy = keepVy;
        b.z = keepZ;
        b.vz = keepVz;
        setPiece.placeBallAtMs = state.clockMs + OUT_BALL_GLIDE_MS;
        return;
    }

    if (t == SetPiece::Penalty) {
        // Ball goes to the SPOT — without this, "penalties" were taken from
        // wherever the foul happened (tight angles, crowds) and barely scored.
        double fd = fdFor(tmTeam);
        b.x = goalXFor(tmTeam) - fd * PENALTY_SPOT_FROM_GOAL;
        b.y = PITCH_H / 2.0;
        setPiece.spotX = b.x;
        setPiece.spotY = b.y;
        phase.actionTimer = 5000;
        Player* best = nullptr;
        double bestScore = -1e9;
        for (auto& p : state.players) {
            if (p.team != tmTeam || p.role == Role::GK || p.sentOff) continue;
            double roleBonus = agentFor(p)->penaltyTakerBonus();
            double score = roleBonus + attrFactor(p.attrs.shooting) * 95.0 - dist(p.x, p.y, b.x, b.y) * 0.04;
            if (score > bestScore) {
                bestScore = score;
                best = &p;
            }
        }
        setPiece.takerId = best ? best->id : -1;
        return;
    }

    // Free kick: nearest outfield player runs to ball
    phase.actionTimer = 5000;
    Player* best = findNearestOutfieldPlayer(tmTeam, b.x, b.y);
    setPiece.takerId = best ? best->id : -1;

    // ── Rare sneaky FAST free kick ── occasionally a taker plays it QUICKLY,
    // before the defence forms its block — the sharp counter-punch a good side
    // takes when the ref lets play flow (owner ask). Gated tight so it never
    // spams and never replaces a shooting FK: only when it is NOT a direct
    // shooting position (a fast shot would just be a worse shot from range),
    // and only when a genuinely open team-mate is already ahead of the ball
    // with a clean lane to receive. ~14% of those.
    double oppGoalX = goalXFor(tmTeam);
    double spotToGoal = std::abs(b.x - oppGoalX);
    setPiece.fast = false;
    // Frequency rises with distance from goal (owner ask): near a shooting
    // position a quick tap is rarely the play, but a free kick won deep in
    // your own half is exactly where the sharp early ball beats the press
    // before it sets. 0.16 floor at the 260 gate, climbing toward ~0.38 for a
    // FK won ~550+ from the opposition goal.
    double fastProb = clamp(0.16 + (spotToGoal - 260.0) / 900.0 * 0.30, 0.16, 0.38);
    if (best && spotToGoal > 260.0 && rng.random() < fastProb) {
        double fd = fdFor(tmTeam);
        for (auto& m : state.players) {
            if (m.team != tmTeam || m.id == best->id || m.role == Role::GK || m.sentOff) continue;
            double fwd = (m.x - b.x) * fd;              // ahead of the ball
            if (fwd < 40.0 || fwd > 320.0) continue;
            if (isOffsideTargetPerceived(*best, m)) continue;
            double nearOpp = 1e9;
            for (auto& o : state.players)
                if (isActiveOpponent(o, tmTeam)) nearOpp = std::min(nearOpp, dist(o.x, o.y, m.x, m.y));
            if (nearOpp < 70.0) continue;               // receiver must be open
            if (countLaneBlockers(state.players, b.x, b.y, m.x, m.y, tmTeam, BLOCKER_PERP_FREEKICK, 0.08, 0.92) != 0) continue;
            setPiece.fast = true;                       // clean quick outlet exists — take it early
            break;
        }
    }
    // Restart marker for the replay feed / trace probes — free kicks were the ONE
    // restart that emitted no event (corner/throw/goal_kick all do). Team derives
    // from the taker's id.
    if (setPiece.takerId >= 0)
        emitEvent("free_kick", setPiece.spotX, setPiece.spotY, setPiece.takerId, -1, true);
}

void GameEngine::awardCorner(Team attackingTeam, bool atHomeEnd, double y) {
    if (std::getenv("CORNER_DEBUG"))
        fprintf(stderr, "[corner] t=%.2f ball=(%.0f,%.0f,z%.0f) v=(%.0f,%.0f) att=%d lastTouch=%d\n",
                state.clockMs/1000.0, state.ball.x, state.ball.y, state.ball.z,
                state.ball.vx, state.ball.vy, (int)attackingTeam, state.ball.lastToucherId);
    stats.recordCorner();
    // Own-corner concession census (owner: "player kicks it out — flag this
    // shit and never do this fuckup again"): a corner conceded by the
    // defender's own DELIBERATE kick within 2.5s of release — not a save,
    // header duel, block or deflection. The slice-clearance branch was the
    // known source (both seed-133 0:25 and 0:48); this is the standing
    // tripwire for any future member of the class.
    {
        Team conceding = attackingTeam == Team::Home ? Team::Away : Team::Home;
        Player* ct = playerById(state.ball.lastToucherId);
        if (ct && ct->team == conceding && ct->role != Role::GK
            && state.ball.lastToucherId == lastDeliberateKickToucher
            && state.clockMs - lastDeliberateKickMs < 2500.0
            && lastLooseOrigin != LooseOrigin::Shot
            && lastLooseOrigin != LooseOrigin::HeaderClearance
            && lastLooseOrigin != LooseOrigin::Woodwork)
            stats.recordQualityFlag(QualityFlag::OwnCornerConcession);
    }
    // Restart marker for the replay feed (trace-only: keeps the live ticker and
    // getJSON events[] unchanged). Without it the out-ball glide to the flag
    // reads as "the ball moved without anyone touching it" (watched seed 133
    // 0:39) — the feed line names the restart the moment it's awarded. Team is
    // carried via the attacking GK's id (events derive team from playerId).
    if (const Player* cgk = findGK(attackingTeam))
        emitEvent("corner", state.ball.x, state.ball.y, cgk->id, -1, true);
    auto& b = state.ball;
    b.controllerId = -1;
    b.intendedReceiverId = -1;
    setPiece.type = SetPiece::Corner;
    setPiece.team = attackingTeam;
    setPiece.armed = true;
    setPiece.reason = "corner";
    phase.actionTimer = 5000;
    setPiece.takerArrived = false;
    // Corner SIDE from the ball's actual TRAJECTORY: several award sites fire
    // while the deflection is still in flight (block/header ricochets ruled
    // "going behind" early), and the passed-in y is the ball's CURRENT y — a
    // ball arcing toward the top corner got placed at the bottom flag
    // (watched replay 0:24). Project where it will cross the goal line.
    double lineX = atHomeEnd ? 0.0 : PITCH_W;
    double yProj = y;
    if (std::abs(b.vx) > 20.0 && (lineX - b.x) * b.vx > 0.0)
        yProj = b.y + b.vy * ((lineX - b.x) / b.vx);
    double cy = yProj < PITCH_H / 2.0 ? 0.0 : PITCH_H;
    // Corner taken from the corner ARC, not 1.8m inside the field of play.
    double ix = atHomeEnd ? 6.0 : PITCH_W - 6.0;
    double iy = cy == 0.0 ? 6.0 : PITCH_H - 6.0;
    // Ball GLIDES out (no mid-flight teleport); placed at the arc by
    // updateSetPiecePhase when the glide window closes.
    setPiece.spotX = ix;
    setPiece.spotY = iy;
    setPiece.placeBallAtMs = state.clockMs + OUT_BALL_GLIDE_MS;
    Player* taker = nullptr;
    double best = 1e9;
    for (auto& p : state.players) {
        if (p.team != attackingTeam || p.role == Role::GK || p.sentOff) continue;
        double roleCost = sp::weight(sp::CORNER_TAKER, p.role);
        double d = dist(p.x, p.y, ix, iy) + roleCost;
        if (d < best) {
            best = d;
            taker = &p;
        }
    }
    setPiece.takerId = taker ? taker->id : -1;
}
