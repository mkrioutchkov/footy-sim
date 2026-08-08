// engine_collect.cpp — a player takes possession of a loose ball
//
// Split out of engine_physics.cpp (1739 lines, four subsystems). collectBall is
// the one door through which control of a free ball is granted, and it is not
// owned by any single phase: the ball/player contest calls it six times over,
// and the chase reception in agent_movement.cpp calls the guarded overload. It
// owns everything that must happen exactly once at that instant — the same-team
// snatch guard, the first-touch settle window, the controlled-touch and
// collection stats, the deferred offside flag, and the round-36 regain cache
// that steers the winner's first touch away from the man he just took it off.
//
// The (Player&, const std::string&, double) overload is the guarded form: the
// same grant, but only if the ball is genuinely free and inside allowedDist.

#include "engine.h"
#include "agent.h"
#include <cmath>

void GameEngine::collectBall(Player& c) {
    auto& b = state.ball;
    if (!canContestBall(c)) return;
    // Round-36: who had it last, captured BEFORE this collection overwrites it —
    // an opposing last-toucher makes this grant a regain (see noteRegain at the
    // bottom of this function).
    const int prevToucherId = b.lastToucherId;
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
    runtime[c.id].duel.contestBlockedUntil = 0;
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
    if (c.id >= 0 && c.id < 22 && receiverShieldTargetId != c.id) runtime[c.id].lastReceiveFrom = -1;
    stats.recordControlledTouch(c.role);
    // Round-34 census (owner complaint 4, "unnatural collect radius" at 2:03 —
    // never measured by any lens). How far was the ball from the man at the
    // instant control was granted, and was he the intended receiver, who alone
    // gets INTENDED_COLLECT_DIST (26px = 2.6m) against everyone else's
    // COLLECT_DIST (8px)? Counter only — no gate reads it.
    {
        double gd = dist(c.x, c.y, b.x, b.y);
        stats.census.grants++;
        stats.census.grantDistSum += gd;
        if (gd > stats.census.grantDistMax) stats.census.grantDistMax = gd;
        int gb = (int) (gd / 4.0);
        stats.census.grantHist[gb < 0 ? 0 : (gb > 9 ? 9 : gb)]++;
        if (intended) { stats.census.grantsIntended++; stats.census.grantIntendedDistSum += gd; }
    }
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
        runtime[c.id].firstTouchUntilMs = state.clockMs + settle;
    }
    // Law 11 rebound judgment: a shot-time-offside teammate collecting the
    // rebound off the frame or the keeper is offside (the poacher tap-in the
    // normal snapshot missed because shootBall killed pendingPass).
    if (shotSnapshotLive
        && (lastLooseOrigin == LooseOrigin::Shot || lastLooseOrigin == LooseOrigin::Woodwork
            || lastLooseOrigin == LooseOrigin::GoalkeeperParry || lastLooseOrigin == LooseOrigin::GoalkeeperPunch)
        && c.team == shotTeam && c.id >= 0 && c.id < 22 && runtime[c.id].offsideAtShot) {
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
    // Round-36: an interception or a loose ball recovered off the OPPOSITION is a
    // regain just like a won tackle — cache the securing direction for the gather
    // lock that follows (stunLockTicks is set by the chase/reception path).
    // A teammate's ball is not a regain and is left alone.
    {
        const Player* prev = prevToucherId >= 0 ? playerById(prevToucherId) : nullptr;
        if (prev && prev->team != c.team) noteRegain(c, prevToucherId, 700.0);
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
