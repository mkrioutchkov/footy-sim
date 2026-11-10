#include "engine.h"
#include "nlohmann/json.hpp"
#include "agent.h"
#include "role_ai.h"
#include "gk_ai.h"
#include "build_version.h"
#include <format>
#include <cmath>
#include <numbers>

// Stand an out-of-play man off the field.
//
// Round-30 (arena audit D9): y=-40 is only 40px outside the touchline, and
// slots sharing a homeX stacked 2-3 bodies on one pixel — which is where every
// LOITER / CROWD / PLAYER_OVERLAP / PLAYER_OOB anomaly flag at small N came
// from (they fire on ghosts, not on live players). In arenaMode, where 16-18
// slots are parked at once, stand them well clear of the canvas and fan them
// along the row.
//
// Round-37: 11v11 now parks at the same -400. The round-30 note left it at -40
// because "a body there is still inside some 380px search radii, so moving it is
// a live-gameplay change" — true, and now measured rather than assumed. A ghost
// at y=-40 sits 45px from the top touchline (live players clamp to y>=5), and 10
// proximity scans filter by team without excluding sentOff, with radii up to
// 300px. Instrumented over seeds 55/101/151 at 90min, one red card each: the
// carrier-congestion count in the switch/relief pass term (agent_pass_helpers)
// is inflated by a ghost 1411/1961/3126 times per match. The marking scan was
// measured too and selects a ghost ZERO times, so that one was never real.
//
// -400 is out of reach of every radius in the engine, which fixes the whole
// class rather than the two sites that happen to bite. Deliberate balance change
// — see the commit message for the paired A/B.
void GameEngine::parkOffPitch(Player& p) const {
    p.x = clamp(p.homeX + (arenaMode ? (p.id % 11) * 3.0 : 0.0), 30.0, PITCH_W - 30.0);
    p.y = -400.0;
    p.targetX = p.x;
    p.targetY = p.y;
    p.vx = p.vy = 0;
}

// ══════════════════════════════════════════════════════════════
// Player lookups
// ══════════════════════════════════════════════════════════════

Player* GameEngine::playerById(int id) {
    if (id >= 0 && id < 22 && playerLookup[id]) return playerLookup[id];
    for (auto& p : state.players)
        if (p.id == id) return &p;
    return nullptr;
}

const Player* GameEngine::playerById(int id) const {
    if (id >= 0 && id < 22 && playerLookup[id]) return playerLookup[id];
    for (auto& p : state.players)
        if (p.id == id) return &p;
    return nullptr;
}

SmallVector<Player*, 11> GameEngine::nearPlayers(Player& p, double range) {
    SmallVector<Player*, 11> r;
    for (auto& o : state.players)
        if (&o != &p && dist(p.x, p.y, o.x, o.y) < range) r.push_back(&o);
    return r;
}

Player* GameEngine::findNearestOutfieldPlayer(Team team, double x, double y) {
    Player* best = nullptr;
    double bestDist = 1e9;
    for (auto& p : state.players) {
        if (p.team != team || p.role == Role::GK || p.sentOff) continue;
        double d = dist(p.x, p.y, x, y);
        if (d < bestDist) {
            bestDist = d;
            best = &p;
        }
    }
    return best;
}

PlayerAI* GameEngine::agentFor(const Player& p) {
    return agents[p.id].get();
}

const PlayerAI* GameEngine::agentFor(const Player& p) const {
    return agents[p.id].get();
}

Player* GameEngine::findGK(Team team) {
    for (auto& p : state.players) {
        if (p.team == team && p.role == Role::GK) return &p;
    }
    return nullptr;
}

const Player* GameEngine::findGK(Team team) const {
    for (auto& p : state.players) {
        if (p.team == team && p.role == Role::GK) return &p;
    }
    return nullptr;
}

bool GameEngine::canContestBall(Player& player) {
    // Double-touch law: the restart taker waits for another touch.
    if (player.id == restartRetouchBlockedId) return false;
    if (player.sentOff) return false;
    if (setPiece.armed && state.ball.controllerId < 0) return false;
    if (activeKnockAhead.active && activeKnockAhead.playerId == player.id) return true;
    if (state.ball.controllerId < 0 && state.ball.intendedReceiverId == player.id && state.ball.lastTouchTeam == player.team && state.ball.lastToucherId != player.id) return true;
    if (runtime[player.id].duel.contestBlockedUntil > state.clockMs) {
        // A lockout marks a moment that beat him (whiffed duel, beaten dribble,
        // lost tackle) — but a loose ball at REST is a NEW moment anyone can
        // play. Watched replay seed 133 4:02: a pass ricocheted off a
        // reaction-locked CB, died 6px from his boots, and he stood over it
        // while the intended receiver strolled 30px to collect.
        // Guarded to the DELIBERATE PASSER of a still-live pending pass —
        // dissolving a passer's own lockout let him re-grab his own under-hit
        // pass (the stale-grab churn the lockout exists to stop). The old
        // blanket last-toucher exclusion ALSO froze a player who INCIDENTALLY
        // deflected a ball dead at his own feet: he owned BOTH the rebound
        // lockout and the last touch, so neither this hatch nor the
        // 'another player touched' reset ever fired — a statue welded to the
        // stationary ball for the full lockout (seed 437 1:12, Chiellini over
        // his GK's deflected goal kick; 34 such freezes in one match).
        double looseRest = std::hypot(state.ball.vx, state.ball.vy);
        bool selfRegrabOfOwnPass = state.ball.lastToucherId == player.id
            && pendingPass.active && pendingPass.fromId == player.id;
        if (!(state.ball.controllerId < 0 && looseRest < LOOSE_BALL_STALL_SPEED
              && !selfRegrabOfOwnPass)) return false;
    }
    runtime[player.id].duel.contestBlockedUntil = 0;
    return true;
}

// ══════════════════════════════════════════════════════════════
// Lifecycle — kickoff, update, fixedUpdate, tickAgents, auditStuckCarrier
// ══════════════════════════════════════════════════════════════

void GameEngine::startMatch() {
    state.matchState = "running";
    state.clockMs = 0;
    phase.addedTimeActive = false;
    phase.matchKickoffTeam = Team::Home;
    kickoff(Team::Home);
}

void GameEngine::kickoff(Team t, double holdMs, bool walkIn) {
    // Post-goal walk-in: remember where every dot stands NOW (at the goal) so the
    // formation reset below can be re-expressed as a stroll rather than a teleport.
    std::array<double, 22> walkFromX{}, walkFromY{};
    if (walkIn)
        for (auto& p : state.players) { walkFromX[p.id] = p.x; walkFromY[p.id] = p.y; }
    phase.nextKickoffTeam = (t == Team::Home) ? Team::Away : Team::Home;
    for (auto& r : runtime) r.duel.contestBlockedUntil = 0;
    receiverShieldUntil = 0;
    receiverShieldedPlayerId = -1;
    receiverShieldTargetId = -1;
    pendingPass.active = false;
    activeKnockAhead.active = false;
    for (auto& r : runtime) r.knockAheadCooldownUntil = 0;
    shot.tracked = false;
    shot.preventable = false;
    shot.header = false;
    shot.penalty = false;
    shot.dribble20m = false;
    pendingSave.active = false; // no stale dive carried across a restart
    advantage.active = false;   // a goal/half-time supersedes any pending advantage
    lastLooseOrigin = LooseOrigin::None;
    auto& b = state.ball;
    b.x = HALF_X;
    b.y = PITCH_H / 2;
    b.vx = b.vy = b.z = b.vz = 0;
    b.controllerId = -1;
    b.intendedReceiverId = -1;
    int takerId = stageKickoffFormation(t);
    if (takerId >= 0) {
        b.controllerId = takerId;
        b.lastTouchTeam = t;
        b.lastToucherId = takerId; lastRicochetMs = -1e9;   // genuine touch supersedes ricochet restart memory
        runtime[takerId].controlStartMs = state.clockMs;   // Round-38: restart possession is fresh control — stamp for the panic-clear grace
    }
    // Post-goal walk-in: the formation above is now the TARGET. Send every dot
    // back to where it stood at the goal and let updateKickoffPhase stroll it to
    // the spot over the hold (snapping exactly at the end). The ball stays dead on
    // the centre spot; the taker walks up to it. Byte-identical at the tap.
    restartWalk.active = false;
    if (walkIn) {
        for (auto& p : state.players) {
            if (p.sentOff) continue;
            restartWalk.targetX[p.id] = p.targetX;
            restartWalk.targetY[p.id] = p.targetY;
            p.x = walkFromX[p.id];
            p.y = walkFromY[p.id];
            p.vx = p.vy = 0;
        }
        restartWalk.active = true;
        // Round-34 census: how far does the furthest dot have to travel to its
        // spot inside the hold? Round-34 commit 3 caps the walk-in to a jog, and
        // its stated mitigation is to size that cap so the 99th percentile still
        // arrives before the terminal snap. This is that measurement.
        for (auto& p : state.players) {
            if (p.sentOff) continue;
            double wd = dist(p.x, p.y, restartWalk.targetX[p.id], restartWalk.targetY[p.id]);
            restartWalk.pace[p.id] = std::max(KICKOFF_WALK_SPEED, wd / std::max(holdMs / 1000.0, 1e-6));
            stats.census.walkArms++;
            stats.census.walkStartDistSum += wd;
            if (wd > stats.census.walkStartDistMax) stats.census.walkStartDistMax = wd;
            int wb = (int) (wd / 50.0);
            stats.census.walkStartHist[wb < 0 ? 0 : (wb > 19 ? 19 : wb)]++;
        }
        restartWalk.scorerId = lastGoal.toucherId;
        restartWalk.presentMs = std::min(3000.0, holdMs * 0.5);   // scorer wheels away for the first ~3s
    }
    phase.kickoffPhase = true;
    phase.actionTimer = holdMs;
    phase.lastKickoffMs = state.clockMs;
    setPiece.armed = false;
    setPiece.reason.clear();
    // Record the restart so trace inspectors can tell a legitimate kickoff (ball
    // to centre + 22-player reset + possession to the other team) from a bug.
    // Without this, every kickoff (opening, post-goal, second-half) reads as a
    // "phantom centre teleport" — it has been misdiagnosed as a bug three times.
    emitEvent("kickoff", HALF_X, PITCH_H / 2.0, b.controllerId, -1, /*traceOnly=*/true);
}

// Stage every player for a kick-off by `t` and return the taker's id (-1 if the
// kicking side has no available CF). Split out of kickoff() so the HALF-TIME
// interval can pre-compute the exact H2 formation the restart will snap to and
// walk the dots there over the break instead of playing on through the whistle.
// Position-only: no ball, timer or phase state is touched here.
int GameEngine::stageKickoffFormation(Team t) {
    for (auto& p : state.players) {
        if (p.sentOff) {
            parkOffPitch(p);
            continue;
        }
        double margin = (p.team == t) ? 30.0 : 45.0;
        p.x = p.team == Team::Home
                  ? clamp(p.homeX, 25.0, HALF_X - margin)
                  : clamp(p.homeX, HALF_X + margin, PITCH_W - 25.0);
        p.y = p.homeY;
        p.targetX = p.x;
        p.targetY = p.y;
        p.vx = p.vy = 0;
    }
    int takerId = -1;
    for (auto& p : state.players) {
        if (p.team == t && p.role == Role::CF && !p.sentOff) {
            p.x = HALF_X;
            p.y = PITCH_H / 2;
            p.targetX = p.x;
            p.targetY = p.y;
            takerId = p.id;
            break;
        }
    }
    // Round-23 (arena reaudit): stage the lone defender at the legal 10-yard
    // (91.5px) distance from the centre spot, not the 45px (margin) that let him
    // mug the opener the instant the ball moved. Arena-only; the 11v11 staging
    // (every non-kicking man at his clamped homeX) is byte-untouched.
    if (arenaMode) {
        for (auto& p : state.players) {
            if (p.team == t || p.role == Role::GK || p.sentOff) continue;
            double fdp = fdFor(p.team);
            double legalX = HALF_X - fdp * 91.5;   // 91.5px into the defender's own half
            p.x = fdp > 0 ? std::min(p.x, legalX) : std::max(p.x, legalX);
            p.targetX = p.x;
        }
    }
    // Round-30 (Law 8): no opponent may stand inside the 9.15 m centre circle
    // until the ball is in play. The staging above knows only the flat 45px
    // `margin`, which parks the defending centre-forward 45px from the spot —
    // half the 91.5px ring the viewer draws — and fixedUpdate returns before
    // tickAgents during the hold, so he is FROZEN there for the whole restart.
    // Step him off the centre line in y FIRST: a pure radial push slides him
    // along y=340 straight into his own centre-mid (13.5px apart, far inside
    // SEPARATION_DIST, with no separation force running during the hold). Then
    // take the smallest x, away from halfway, that clears the ring at that y.
    // The arena block above already clears its lone defender, so this is a
    // no-op there.
    {
        constexpr double CIRCLE_R = 91.5;    // 9.15 m, the ring viewer_template draws
        constexpr double STEP_Y   = 42.0;    // off the centre line, clear of the CM slot
        constexpr double CLEAR_R  = 92.5;    // sit just OUTSIDE the line, not on it
        for (auto& p : state.players) {
            if (p.team == t || p.role == Role::GK || p.sentOff) continue;
            double dy = p.y - PITCH_H / 2;
            if (std::hypot(p.x - HALF_X, dy) >= CIRCLE_R) continue;
            // Deterministic side: whichever half of the pitch he already leans to,
            // tie-broken by team so a dead-centre striker never picks at random.
            double side = dy > 0 ? 1.0 : (dy < 0 ? -1.0 : (p.team == Team::Home ? -1.0 : 1.0));
            if (std::abs(dy) < STEP_Y) {
                dy = side * STEP_Y;
                p.y = PITCH_H / 2 + dy;
            }
            double needX = std::abs(dy) >= CLEAR_R ? 0.0
                                                   : std::sqrt(CLEAR_R * CLEAR_R - dy * dy);
            double fdp = fdFor(p.team);
            double legalX = HALF_X - fdp * needX;   // back into his own half
            p.x = fdp > 0 ? std::min(p.x, legalX) : std::max(p.x, legalX);
            p.targetX = p.x;
            p.targetY = p.y;
        }
    }
    return takerId;
}

// §1.4 (docs/LIVE_MATCH_ARCHITECTURE.md): express the tick as a public bool step() — one fixed
// update, returns false at full-time. main()'s loop becomes `while (step())`; the future
// many-games-per-thread runner drives N engines round-robin via step() with no second rewrite.
// The exit bound (matchDurationMs + 300000) == the old loop's totalMs + added-time buffer, so the
// default/--summary path is BYTE-IDENTICAL (golden untouched). Live self-pacing will wrap step().
bool GameEngine::step() {
    if (state.matchState == "finished") return false;
    if (state.clockMs >= matchDurationMs + 300000.0) {
        // Hard cap reached without a natural full-time whistle (e.g. a stall kept
        // the ball in a final third so the half never ended). Finalize cleanly so
        // the summary reports a FINISHED match with the score recorded — rather
        // than a 'running' match frozen at 95:00 that never called recordScore.
        state.matchState = "finished";
        stats.recordScore(state.homeScore, state.awayScore);
        return false;
    }
    update(FIXED_DT);
    return true;
}

void GameEngine::update(double dM) {
    accumulator += dM * state.speed;
    int steps = 0;
    while (accumulator >= FIXED_DT && steps < 3) {
        accumulator -= FIXED_DT;
        fixedUpdate(FIXED_DT);
        steps++;
    }
}

void GameEngine::cacheBallState() {
    prevBallX = state.ball.x;
    prevBallY = state.ball.y;
    prevBallVx = state.ball.vx;
    prevBallVy = state.ball.vy;
    prevControllerId = state.ball.controllerId;
}

void GameEngine::fixedUpdate(double sdt) {
    fixedUpdateTick(sdt);
    // Runs LAST and unconditionally, whichever of the tick's several early-return
    // paths was taken (half-time interval, kick-off hold, set piece, open play).
    updateRenderFacing();
}

// Render-only facing smoothing (display copy; logic uses raw Player::facing).
// Exponential low-pass of facing: a high-frequency ~30deg left-right shimmer
// averages toward its centre (smooth), while a genuine sustained turn still
// tracks within a few ticks. alpha 0.18 ~ 90ms settle — imperceptible lag, but
// it kills the watched-match jitter. Logic is untouched -> gameplay identical.
//
// Round-31: this used to live INSIDE updateOpenPlayPhase, so it only advanced on
// open-play ticks. Measured on a 30-min trace: 12.0% of ticks left the display
// angle frozen while the real body turned — 44 windows, median 4.8 s, longest
// 9.0 s, with the display up to 180 deg stale by the end of one. Every set piece,
// kick-off hold and the half-time interval locked all 22 bodies at a stale angle
// in the live web view. The trace now carries this value too, so a replay would
// have inherited the same freeze; hoisted here instead.
void GameEngine::updateRenderFacing() {
    if (!renderFacingInit) {
        for (auto& p : state.players) renderFacing[p.id] = p.facing;
        renderFacingInit = true;
        return;
    }
    for (auto& p : state.players) {
        double dF = std::atan2(std::sin(p.facing - renderFacing[p.id]), std::cos(p.facing - renderFacing[p.id]));
        renderFacing[p.id] = std::atan2(std::sin(renderFacing[p.id] + dF * 0.18), std::cos(renderFacing[p.id] + dF * 0.18));
    }
}

void GameEngine::fixedUpdateTick(double sdt) {
    state.clockMs += sdt;
    // Hard pin: a sent-off player is held off the pitch every tick no matter
    // what any phase does to him, and can never hold the ball. This is the
    // single guarantee that backstops every per-system exclusion.
    for (auto& p : state.players) {
        if (!p.sentOff) continue;
        if (state.ball.controllerId == p.id) {
            state.ball.controllerId = -1;
            state.ball.intendedReceiverId = -1;
            lastLooseOrigin = LooseOrigin::None;
        }
        parkOffPitch(p);
    }
    // Tackle lunge dash: play the committed closing step out at a bounded
    // burst pace (see attemptTackle). Runs for controller and off-ball alike,
    // which the agent movement path cannot (it skips controllers).
    for (auto& p : state.players) {
        double& rem = runtime[p.id].lungeDash.remainPx;
        if (rem <= 0.0) continue;
        if (p.sentOff) { rem = 0.0; runtime[p.id].lungeDash.switchPx = 0.0; runtime[p.id].lungeDash.dir2X = runtime[p.id].lungeDash.dir2Y = 0.0; continue; }
        // R28 C8: two-stage chop — at the switch point of a won take-on's dash,
        // cut off the shoulder-sell direction onto the goal-ward second stage
        // (agent.cpp seeds both). Single 'chop' event marks the cut for the
        // trace/viewer; speed model untouched (same ramp, same peak), so the
        // per-tick displacement stays under the carrier tripwire.
        if (runtime[p.id].lungeDash.switchPx > 0.0 && rem <= runtime[p.id].lungeDash.switchPx) {
            double n2x = runtime[p.id].lungeDash.dir2X, n2y = runtime[p.id].lungeDash.dir2Y;
            if (std::hypot(n2x, n2y) > 0.1) {
                runtime[p.id].lungeDash.dirX = n2x;
                runtime[p.id].lungeDash.dirY = n2y;
                p.facing = std::atan2(n2y, n2x);
                emitEvent("chop", p.x, p.y, p.id);
            }
            runtime[p.id].lungeDash.switchPx = 0.0;
            runtime[p.id].lungeDash.dir2X = runtime[p.id].lungeDash.dir2Y = 0.0;
        }
        // Round-23 (carrier burst realism): RAMP the pace up toward the seeded
        // peak (agent.cpp / engine_tackle.cpp) at ~150px/s^2 instead of the old
        // one-tick snap to a flat 120, and DECAY it back toward the carrier's
        // dribble pace over the last stretch — a burst that accelerates and
        // settles, not an on/off block. The tackler path seeds spd=peak=
        // LUNGE_DASH_SPEED so its short committed contact step stays ~flat.
        double& spd = runtime[p.id].lungeDash.spd;
        double rampRate = 150.0 * sdt / 1000.0;
        spd = std::min(runtime[p.id].lungeDash.peak, spd + rampRate);
        if (rem < 14.0) {
            double settle = attrFactor(p.attrs.speed) * DRIBBLE_FAST_SPEED;
            spd = std::max(settle, spd - rampRate);
        }
        double step = std::min(rem, spd * sdt / 1000.0);
        p.x = clamp(p.x + runtime[p.id].lungeDash.dirX * step, 5.0, PITCH_W - 5.0);
        p.y = clamp(p.y + runtime[p.id].lungeDash.dirY * step, 5.0, PITCH_H - 5.0);
        // Truthful velocity (Round-23): the dash wrote position but never vx/vy,
        // so every velocity reader saw 0 for the whole burst. Derive the real
        // per-tick velocity from the step actually taken (mirrors the FK run-up).
        double stepSpd = step / (sdt / 1000.0);
        p.vx = runtime[p.id].lungeDash.dirX * stepSpd;
        p.vy = runtime[p.id].lungeDash.dirY * stepSpd;
        rem -= step;
        // Handoff-spike guard (Round-23): stamp the tick the dash ends so
        // moveBallCarrier doesn't add a full carry step on top of this one.
        if (rem <= 0.0) { rem = 0.0; runtime[p.id].lungeDash.doneMs = state.clockMs; }
    }
    // OffBallOverspeed tripwire (owner: "moves stupidly fast for a split
    // second... biggest issue — also make it a quality flag"): any outfield
    // player whose ACTUAL displacement this tick exceeds every designed
    // motion (SPEED_SPRINT 68px/s, lunge-dash peak ~104) is a teleport-grade
    // blip, whatever system caused it. Suppressed across restarts/kickoffs/
    // halves (legit repositioning) — those invalidate the previous-position
    // snapshot.
    // Round-34: this comment used to claim "sprint ~90" px/s. The true command
    // ceiling is SPEED_SPRINT = 68 (constants.h), so the 250px/s tripwire below
    // sits ~3.7x above anything the engine can produce, not the ~2.8x the stale
    // figure implied. The number is left alone — it is a teleport tripwire, not
    // a speed gate — but the census below now measures the real distribution.
    {
        bool measurable = !setPiece.armed && !phase.kickoffPhase && phase.halfTimePause <= 0
            && sdt > 1e-3;
        if (measurable && telemetry.prevValid) {
            double maxStep = 250.0 * sdt / 1000.0;
            // Round-23 (carrier burst): a CARRIER body stepping faster than the
            // ramped dash peak (~104px/s) is the flat-120 burst artifact the
            // off-ball 250 line (and the dead-by-construction carried-ball cap)
            // could never catch. 112 sits just above the peak.
            double carrierMaxStep = 112.0 * sdt / 1000.0;
            for (auto& p : state.players) {
                if (p.sentOff || p.role == Role::GK) continue;
                double dispStep = dist(p.x, p.y, telemetry.prevX[p.id], telemetry.prevY[p.id]);
                if (dispStep > maxStep)
                    stats.recordQualityFlag(QualityFlag::OffBallOverspeed);
                // Exempt the sanctioned DEFENDER-contact dash (engine_tackle.cpp:
                // won tackle → carrier for its 11px/90ms step, seeded peak=120):
                // round-14 tuned it and the spec keeps it. The take-on carry
                // ramps to peak <=104, so it stays measured (a regression to
                // flat-120 would still trip this line).
                bool contactDash = (runtime[p.id].lungeDash.remainPx > 0.0
                                    || runtime[p.id].lungeDash.doneMs == state.clockMs)
                                   && runtime[p.id].lungeDash.peak > 112.0;
                if (state.ball.controllerId == p.id && dispStep > carrierMaxStep && !contactDash)
                    stats.recordQualityFlag(QualityFlag::CarrierOverspeed);
            }
        }
        for (auto& p : state.players) { telemetry.prevX[p.id] = p.x; telemetry.prevY[p.id] = p.y; }
        telemetry.prevValid = measurable;
    }
    // ── Round-34 census: phase-filtered outfield speed bands, and the loose-ball
    // episode ledger. Both are pure counters (see stats.h Census). The phase
    // filter matters: the post-goal walk-in alone moves the squad-wide >5.5 m/s
    // share from 2.46% to 3.02% and the 7-9 m/s band from 0.06% to 0.27%, so any
    // speed evidence gathered without it is measuring the restart, not the match.
    {
        // Category at SNAPSHOT time governs the movement the dispatch below is
        // about to perform, so a sample is only taken when two consecutive ticks
        // agree. Every restart teleport (kickoff staging, the half-time stage,
        // the terminal walk-in snap) straddles a category change and is dropped.
        int cat = setPiece.armed ? 1 : (phase.kickoffPhase ? 2 : (phase.halfTimePause > 0 ? 3 : 0));
        if (sdt > 1e-3 && telemetry.censusPrevCat == cat && (cat == 0 || cat == 2)) {
            long* band = cat == 0 ? stats.census.openBand : stats.census.resetBand;
            for (auto& p : state.players) {
                if (p.sentOff || p.role == Role::GK) continue;
                double mps = dist(p.x, p.y, telemetry.censusPrevX[p.id], telemetry.censusPrevY[p.id]) / (sdt / 1000.0) / 10.0;
                int b = mps < 0.3 ? 0 : (mps < 2.0 ? 1 : (mps < 4.0 ? 2 : (mps < 5.5 ? 3 : (mps < 7.0 ? 4 : 5))));
                band[b]++;
            }
        }
        for (auto& p : state.players) { telemetry.censusPrevX[p.id] = p.x; telemetry.censusPrevY[p.id] = p.y; }
        telemetry.censusPrevCat = cat;

        // Loose-ball episodes: an episode runs from the tick control is lost to
        // the tick it is regained. Restarts close the open episode without
        // booking it (a dead ball on the spot is not a loose ball).
        bool controlled = state.ball.controllerId >= 0;
        if (cat == 0) {
            stats.census.openTicks++;
            if (!controlled) {
                stats.census.looseTicks++;
                if (std::hypot(state.ball.vx, state.ball.vy) < 5.0 && state.ball.z < 1.0)
                    stats.census.looseDeadTicks++;
                if (telemetry.censusLooseStartMs < 0.0) telemetry.censusLooseStartMs = state.clockMs;
                // Round-34 commit 6 guard (pure counter): how many outfielders are
                // committed to a Chase while the ball is free. Redirecting the
                // anticipating chaser must not turn into a pile-on.
                int chasers = 0;
                for (auto& a : agents) {
                    if (!a) continue;
                    const Player& q = a->player;
                    if (q.sentOff || q.role == Role::GK) continue;
                    if (a->lastAction() == ActionType::Chase) chasers++;
                }
                stats.census.looseChaserSum += chasers;
                stats.census.looseChaserTicks++;
                if (chasers > stats.census.looseChaserMax) stats.census.looseChaserMax = chasers;
            } else if (telemetry.censusLooseStartMs >= 0.0) {
                double ms = state.clockMs - telemetry.censusLooseStartMs;
                telemetry.censusLooseStartMs = -1.0;
                stats.census.looseEpisodes++;
                stats.census.looseMsTotal += ms;
                if (ms > stats.census.looseMsMax) stats.census.looseMsMax = ms;
                if (ms > 1000.0) stats.census.looseEpisodesOver1s++;
                if (ms > 1500.0) stats.census.looseEpisodesOver1500ms++;
                int lb = (int) (ms / 250.0);
                stats.census.looseMsHist[lb < 0 ? 0 : (lb > 23 ? 23 : lb)]++;
            }
        } else {
            telemetry.censusLooseStartMs = -1.0;
        }
    }
    // Played-advantage recall: the ref waved a foul on. If, within ~4s, the fouled
    // side LOSES the ball to an outfield opponent (a clean turnover — not a keeper
    // save, which means the advantage produced a shot), bring the free kick BACK to
    // the foul spot. Otherwise the advantage stands. Clock-driven, no rng.
    if (advantage.active) {
        Player* ctrl = playerById(state.ball.controllerId);
        if (state.clockMs - advantage.grantMs > 4000.0) {
            advantage.active = false; // it ran its course — stands
        } else if (!setPiece.armed && ctrl && ctrl->team != advantage.team && ctrl->role != Role::GK) {
            auto& b = state.ball;
            b.x = clamp(advantage.foulX, 20.0, PITCH_W - 20.0);
            b.y = clamp(advantage.foulY, 20.0, PITCH_H - 20.0);
            b.lastTouchTeam = advantage.team;
            b.lastToucherId = -1;
            b.intendedReceiverId = -1;
            lastLooseOrigin = LooseOrigin::None;
            awardSetPiece(SetPiece::FreeKick, advantage.team); // zeroes vel+control, sets spot+armed
            advantage.active = false;
        }
    }
    // Stoppage time accrues while the ball is dead — set pieces, kickoffs,
    // the halftime pause. The board announces a real +N at 45:00/90:00.
    if (setPiece.armed || phase.kickoffPhase || phase.halfTimePause > 0) phase.stoppageMs += sdt;

    // ── Added-time / end-of-phase.half whistle ──
    double halfEndMs = (phase.half == 1) ? halfDurationMs : matchDurationMs;
    if (state.clockMs >= halfEndMs) {
        if (!phase.addedTimeActive) {
            // The 1-5 minute band assumes a 45-min half. Scale it to the ACTUAL
            // half length so a short exhibition/test match doesn't get a full
            // minute of added time (a "5-min" match was running ~6:00, and its
            // second-half kickoff then landed mid-play and read as a glitch).
            // Ratio is exactly 1.0 for a 90-min match → standard game unchanged.
            double addedScale = std::min(1.0, halfDurationMs / (45.0 * 60000.0));
            // Round-30: the ANNOUNCED figure is the whole-minute board number;
            // announcedAddedMs is the scaled WHISTLE threshold. They were the
            // same expression, so the sub-45-min scale (0.333 at 30 min) was
            // being applied before the board read it back and every match under
            // 90 minutes announced "+0". Keep the threshold exactly as it was —
            // it must NOT become continuous (that moves the half-time whistle
            // and rerolls the second half) — and publish the integer separately.
            phase.announcedAddedMin = static_cast<int>(clamp(std::round(phase.stoppageMs * 0.35 / 60000.0), 1.0, 5.0));
            phase.announcedAddedMs = phase.announcedAddedMin * 60000.0 * addedScale;
            // The board goes up (owner: "added time... should be communicated
            // properly") — the viewer renders this as the +N banner. playerId
            // carries the announced minutes, targetId the half.
            emitEvent("added_time", HALF_X, 20.0, phase.announcedAddedMin, phase.half);
        }
        phase.addedTimeActive = true;
        double overtimeMs = state.clockMs - halfEndMs;
        double bx = state.ball.x;
        bool inFinalThird = (bx < THIRD_1 || bx > THIRD_2);
        // Normally the whistle waits for the ball to leave the final third. But a
        // persistent final-third camp would starve that condition indefinitely, so
        // force the whistle once we are well past the announced added time.
        bool hardOverrun = overtimeMs >= phase.announcedAddedMs + ADDED_TIME_MAX_OVERRUN_MS;
        if ((overtimeMs >= phase.announcedAddedMs && !inFinalThird) || hardOverrun) {
            phase.addedTimeActive = false;
            phase.stoppageMs = 0;
            phase.announcedAddedMs = 0;
            phase.announcedAddedMin = 0;
            if (phase.half == 1) {
                phase.half = 2;
                phase.halfTimePause = 5000; // a visible break, not a real 15min
                // Law: the team that did NOT kick off the match starts H2.
                phase.nextKickoffTeam = phase.matchKickoffTeam == Team::Home ? Team::Away : Team::Home;
                // Round-27 COMMIT 10 (owner 17:59 "stuck incident then goes to
                // restart" — it was HALFTIME with no cue): mark the pause with a
                // half_time event so the viewer can render a banner.
                // Round-30: the settle is now done HERE, in the engine, not left
                // to the viewer. The old note ("zeroing state.ball perturbs the
                // agents that tick through the dead pause") described the very
                // bug being fixed — nobody ticks through the whistle any more, so
                // there is nothing left to perturb, and the shipping renderer
                // (which has no half_time handling at all) gets a dead ball on
                // the deck for free instead of one hovering 6px above its shadow.
                emitEvent("half_time", HALF_X, PITCH_H / 2.0, 1, -1, /*traceOnly=*/true);
                // Pre-stage the H2 formation kickoff() will snap to, then put
                // everyone back where the whistle caught them: the break becomes
                // a scripted walk to those spots (same rng-free lerp-to-arrive
                // machinery as the post-goal walk-in), not five more seconds of
                // football played with the referee's whistle in his mouth.
                {
                    std::array<double, 22> fromX{}, fromY{};
                    for (auto& p : state.players) { fromX[p.id] = p.x; fromY[p.id] = p.y; }
                    stageKickoffFormation(phase.nextKickoffTeam);
                    for (auto& p : state.players) {
                        restartWalk.targetX[p.id] = p.targetX;
                        restartWalk.targetY[p.id] = p.targetY;
                        p.x = fromX[p.id];
                        p.y = fromY[p.id];
                        p.vx = p.vy = 0;
                    }
                    restartWalk.active = false;
                    restartWalk.halfTime = true;
                    // Round-34 census: the interval walk runs the same lerp over a
                    // 5s hold. Measured only — commit 3 is scoped to the post-goal
                    // walk-in, and this number says how much is left behind.
                    for (auto& p : state.players) {
                        if (p.sentOff) continue;
                        double wd = dist(p.x, p.y, restartWalk.targetX[p.id], restartWalk.targetY[p.id]);
                        stats.census.htWalkArms++;
                        stats.census.htWalkStartDistSum += wd;
                        if (wd > stats.census.htWalkStartDistMax) stats.census.htWalkStartDistMax = wd;
                    }
                }
            } else {
                // Round-27 COMMIT 10: full_time marker for the viewer (the viewer
                // parks the ball). Same reason the settle stays out of the engine.
                emitEvent("full_time", HALF_X, PITCH_H / 2.0, 2, -1, /*traceOnly=*/true);
                state.matchState = "finished";
                stats.recordScore(state.homeScore, state.awayScore);
                return;
            }
        }
    }
    if (phase.halfTimePause > 0) {
        phase.halfTimePause -= sdt;
        // Round-30: play a real INTERVAL. This branch used to early-return before
        // separateTeammates (engine.cpp) and before finalizeVelocities, and ran no
        // ball physics at all — so for 5s a match 21 agents kept chasing with ZERO
        // body-collision resolution (min pairwise distance 0.26px, the deepest
        // overlap of the entire match, in every match measured) while the ball
        // hung frozen in mid-air with stale velocity. Park the ball on the deck,
        // walk the dots to their H2 spots, and keep the separation pass running.
        auto& b = state.ball;
        b.vx = b.vy = b.vz = 0;
        b.z = 0;
        b.controllerId = -1;
        b.intendedReceiverId = -1;
        if (phase.halfTimePause <= 0) {
            restartWalk.halfTime = false;
            kickoff(phase.nextKickoffTeam);
        } else {
            halfTimeWalk(sdt);
            separateTeammates(sdt);   // belt and braces: nobody spends the break inside a team-mate
        }
        cacheBallState();
        return;
    }
    double sec = sdt / 1000;
    updatePlayerAnimations(sdt);
    updatePossessionTracking(sdt);
    Player* possession = playerById(state.ball.controllerId);
    if (possession && possession->role != Role::GK) {
        Team team = possession->team;
        double fd = fdFor(team);
        double line = offsideLineFor(team);
        if (!std::isnan(line)) {
            for (auto& p : state.players) {
                if (p.team != team || p.id == possession->id || p.role == Role::GK) continue;
                bool beyondHalf = fd > 0.0 ? p.x > HALF_X : p.x < HALF_X;
                bool beyondBall = fd > 0.0 ? p.x > state.ball.x + OFFSIDE_TOLERANCE : p.x < state.ball.x - OFFSIDE_TOLERANCE;
                bool beyondLine = fd > 0.0 ? p.x > line + OFFSIDE_TOLERANCE : p.x < line - OFFSIDE_TOLERANCE;
                if (beyondHalf && beyondBall && beyondLine) stats.recordOffsidePosition(p.role, sdt);
            }
        }
    }
    if (pendingPass.active && !pendingPass.offsideExempt) {
        Player* receiver = playerById(pendingPass.toId);
        if (receiver && receiver->team == pendingPass.team) {
            double fd = fdFor(pendingPass.team);
            bool beyondHalf = fd > 0.0 ? receiver->x > HALF_X : receiver->x < HALF_X;
            bool beyondPasser = fd > 0.0 ? receiver->x > pendingPass.passerX + OFFSIDE_TOLERANCE : receiver->x < pendingPass.passerX - OFFSIDE_TOLERANCE;
            bool beyondLine = fd > 0.0 ? receiver->x > pendingPass.offsideLine + OFFSIDE_TOLERANCE : receiver->x < pendingPass.offsideLine - OFFSIDE_TOLERANCE;
            if (beyondHalf && beyondPasser && beyondLine) stats.recordOffsidePosition(receiver->role, sdt);
        }
    }
    detectSimulationFreeze(sdt);

    // Round-30: substitutions are made AT STOPPAGES, so the check has to run
    // before the phase dispatch. It used to be the first statement of
    // updateOpenPlayPhase, which the dispatch below only reaches when
    // !setPiece.armed && !phase.kickoffPhase — while updateSubstitutions itself
    // returns unless one of those is TRUE. Provably unsatisfiable, and measured
    // as such: 290k entries, 663 cadence hits, 0 gate passes, 0 substitutions in
    // 12 of 12 ninety-minute matches.
    updateSubstitutions();

    if (setPiece.armed) {
        updateSetPiecePhase(sdt, sec);
        return;
    }
    if (phase.kickoffPhase) {
        updateKickoffPhase(sdt);
        return;
    }

    updateOpenPlayPhase(sdt, sec);
}
void GameEngine::updatePlayerAnimations(double sdt) {
    for (auto& p : state.players) {
        p.wall = false; // render-hint: cleared each tick; setPiecePositioning (runs after this) re-sets it for the FK wall
        if (p.tackleAnim > 0) p.tackleAnim = std::max(0., p.tackleAnim - sdt);
        if (p.headingAnim > 0) p.headingAnim = std::max(0., p.headingAnim - sdt);
        if (p.diveAnim > 0) p.diveAnim = std::max(0., p.diveAnim - sdt);
        if (p.throughCollected > 0) p.throughCollected = std::max(0., p.throughCollected - sdt);
    }
}

// ── Set piece parameter helpers ──
static double standBackFor(SetPiece sp) {
    if (sp == SetPiece::ThrowIn) return 0.0;
    if (sp == SetPiece::Corner) return 7.0;
    if (sp == SetPiece::Penalty) return 18.0;
    return 14.0;
}
static double minDistFor(SetPiece sp) {
    // Law-audited: 10yd = 9.15m = 91.5px at the 10px/m scale. FK was 78
    // (1.35m short) and corners 58 (3.35m short) — both confirmed violations.
    // Throw-in stays 42 (law asks only 2m; the engine is deliberately more
    // generous for playability). Penalty 96 covers the arc.
    if (sp == SetPiece::ThrowIn) return 42.0;
    if (sp == SetPiece::Corner) return 91.5;
    if (sp == SetPiece::Penalty) return 96.0;
    return 91.5;
}
// Post-arrival hold before the restart is taken. The old values (0.65-1.8s)
// resumed play near-instantly, which packed ~85 in-play minutes into the 90 —
// every rate stat (passes/shots/crosses) ran ~1.5-2x real because the match
// simply contained too much football. Real restarts take 12-40s; these sit at
// game-friendly fractions of that (a watched match shouldn't be half dead air),
// and double as the window where the box crowd / wall / spread actually forms
// on screen before the ball comes in.
static double actionTimerFor(SetPiece sp, double spotDistToOppGoal) {
    if (sp == SetPiece::ThrowIn) return 4000.0;
    if (sp == SetPiece::Penalty) return 9000.0;
    // Deep own-half free kick: no box routine to stage, so the full 7s hold is
    // just dead air (seed 103 @41s sat 9.6s on a kick that was always a short pass).
    if (sp == SetPiece::FreeKick && spotDistToOppGoal > 380.0) return 3000.0;
    // Round-19 (audit): a shared 7s hold left the corner-taker standing over the
    // ball for 7-12s. A corner has no wall to stage, so it needs only enough time
    // for the box crowd to form (~4s). Short-distance corner retrieval (<300px ->
    // ~1.5s at the capped roll speed) completes well inside this hold.
    if (sp == SetPiece::Corner) return 4000.0;
    return 7000.0; // attacking free kick (wall setup justifies the longer hold)
}

// Gaylord seam (16:48): the engine id of the team's designated taker for this set-piece type
// (fk/corner/pen/long_throw_taker directive), or -1 if none set => default position-based pick.
int GameEngine::designatedTakerFor(SetPiece type, Team team) {
    DirectiveKind want;
    switch (type) {
    case SetPiece::FreeKick: want = DirectiveKind::FkTaker; break;
    case SetPiece::Corner: want = DirectiveKind::CornerTaker; break;
    case SetPiece::Penalty: want = DirectiveKind::PenTaker; break;
    case SetPiece::ThrowIn: want = DirectiveKind::LongThrowTaker; break;
    default: return -1;
    }
    for (const auto& d : directives) {
        if (d.kind != want) continue;
        Player* p = playerById(d.playerId);
        if (p && p->team == team && !p->sentOff) return d.playerId;
    }
    return -1;
}

// Pre-compute each teammate's throw-in support target into the blackboard,
// once per set piece (role-shaped: CF stretches long, WM offers short/wide, etc.).
void GameEngine::populateThrowInSupport(Team spTeam) {
    if (setPiece.type == SetPiece::ThrowIn) {
        auto& bb = blackboards[teamIndex(spTeam)];
        if (!bb.throwInSupport.active) {
            bb.throwInSupport.active = true;
            bb.throwInSupport.spotX = setPiece.spotX;
            bb.throwInSupport.spotY = setPiece.spotY;
            double fd = fdFor(spTeam);
            double bx = setPiece.spotX;
            double by = setPiece.spotY;
            double ownX = ownGoalXFor(spTeam);
            // A throw won deep in our own corner is a BUILD-UP restart, not a
            // spot-relative attack (mirrors the deep-FK spread in
            // agent_setpiece.cpp): the spot-relative shape collapsed the whole
            // team into ~210px in its own quarter — CBs walking past their own
            // GK, five outfielders deeper than the keeper, the CF "stretch"
            // landing at CM depth. Anchor targets on OUR goal instead.
            bool deepThrow = std::abs(bx - ownX) < PITCH_W * 0.35;
            // Which FB is nearer the throw (he stays as ladder support; the
            // spare FB gives width on the far flank).
            int nearFbId = -1; double nearFbD = 1e9;
            for (auto& p : state.players)
                if (p.team == spTeam && p.role == Role::FB && !p.sentOff && p.id != setPiece.takerId) {
                    double dd = std::abs(p.homeY - by);
                    if (dd < nearFbD) { nearFbD = dd; nearFbId = p.id; }
                }
            for (auto& p : state.players) {
                if (p.team != spTeam || p.role == Role::GK) continue;
                if (p.id == setPiece.takerId) continue;
                double tx, ty;
                if (deepThrow) {
                    double farY = by < PITCH_H / 2.0 ? PITCH_H * 0.75 : PITCH_H * 0.25;
                    if (p.role == Role::CF) {
                        tx = ownX + fd * 530.0;
                        ty = PITCH_H / 2.0 + std::cos(p.id * 2.3) * 60.0;
                    } else if (p.role == Role::WM) {
                        if (std::abs(p.homeY - by) < PITCH_H * 0.35) {
                            tx = bx + fd * 85.0;   // near WM: live combo option
                            ty = by + (by < PITCH_H / 2.0 ? -50.0 : 50.0);
                        } else {
                            tx = ownX + fd * 455.0;   // far WM: switch outlet
                            ty = farY;
                        }
                    } else if (p.role == Role::CM) {
                        tx = ownX + fd * (175.0 + std::abs(std::sin(p.id * 1.7)) * 35.0);
                        ty = PITCH_H / 2.0 + std::sin(p.id * 2.1) * 70.0;
                    } else if (p.role == Role::FB) {
                        if (p.id == nearFbId) {
                            tx = ownX + fd * 175.0;   // ladder support under the throw
                            ty = lerp(by, PITCH_H / 2.0, 0.35);
                        } else {
                            tx = ownX + fd * 275.0;   // spare FB: far-flank width
                            ty = farY;
                        }
                    } else {   // CBs: goal-kick-style split, never behind the GK
                        tx = ownX + fd * 115.0;
                        ty = (p.homeY < PITCH_H / 2.0) ? PITCH_H * 0.30 : PITCH_H * 0.70;
                    }
                    bb.throwInSupport.targetX[p.id] = clamp(tx, 35.0, PITCH_W - 35.0);
                    bb.throwInSupport.targetY[p.id] = clamp(ty, 35.0, PITCH_H - 35.0);
                    continue;
                }
                if (p.role == Role::CF) {
                    // +170 parked the "stretch" man at CM depth — 240 with a
                    // past-halfway floor makes him a genuine outlet again.
                    tx = bx + fd * 240.0;
                    if ((tx - HALF_X) * fd < 40.0) tx = HALF_X + fd * 40.0;
                    ty = PITCH_H / 2.0 + std::cos(p.id * 2.3) * 60.0;
                } else if (p.role == Role::WM) {
                    if (std::abs(p.homeY - by) < PITCH_H * 0.35) {
                        tx = bx + fd * 85.0;   // same-side WM: combo option
                        ty = by + (by < PITCH_H / 2.0 ? -50.0 : 50.0);
                    } else {
                        // +30 put BOTH wingers behind all three CMs (inverted
                        // ladder at 17/23 throws) — the far WM is the wide
                        // SWITCH outlet, not a second bail-out.
                        tx = bx + fd * 165.0;
                        ty = by < PITCH_H / 2.0 ? PITCH_H * 0.73 : PITCH_H * 0.27;
                    }
                } else if (p.role == Role::CM) {
                    double depth = 80.0 + std::abs(std::sin(p.id * 1.7)) * 80.0;
                    double lateral = std::sin(p.id * 2.1) * 110.0;
                    tx = bx + fd * depth;
                    ty = PITCH_H / 2.0 + lateral;
                } else if (p.role == Role::FB) {
                    tx = bx - fd * 25.0;
                    ty = p.homeY;
                } else {
                    tx = bx - fd * 55.0;
                    ty = p.homeY;
                }
                // Absolute depth floor: no support target ever sits goal-adjacent
                // (a spot-relative -55 near our box aimed defenders AT our GK).
                if ((tx - ownX) * fd < 95.0) tx = ownX + fd * 95.0;
                bb.throwInSupport.targetX[p.id] = clamp(tx, 35.0, PITCH_W - 35.0);
                bb.throwInSupport.targetY[p.id] = clamp(ty, 35.0, PITCH_H - 35.0);
            }
            // A dedicated SHORT man (watched replay seed 133 0:52: the thrower
            // had NO teammate within 130px — nearest body was an opponent at
            // 38px — because every role target sits 80-170px upfield or at
            // central y). The nearest non-taker teammate comes to a genuine
            // bail-out spot: ~60px away, angled infield from the touchline.
            Player* shortMan = nullptr;
            double shortBest = 1e9;
            for (auto& p : state.players) {
                if (p.team != spTeam || p.role == Role::GK || p.sentOff || p.id == setPiece.takerId) continue;
                double dd = dist(p.x, p.y, bx, by);
                if (dd < shortBest) { shortBest = dd; shortMan = &p; }
            }
            if (shortMan) {
                double inDir = by < PITCH_H / 2.0 ? 1.0 : -1.0;   // toward the middle
                bb.throwInSupport.targetX[shortMan->id] = clamp(bx + fd * 30.0, 35.0, PITCH_W - 35.0);
                bb.throwInSupport.targetY[shortMan->id] = clamp(by + inDir * 55.0, 35.0, PITCH_H - 35.0);
            }
        }
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// Round-49: updateShapePossession() — possession as the OFF-BALL shape sees it
// ══════════════════════════════════════════════════════════════════════════════
// Seed-1110 audit: whole teams U-turned in a single frame whenever the "who has
// it" flag flipped — 577 flips a match, 98 team-wide lurches, 19 of them a
// double U-turn off a half-second deflection (34:06: three midfielders from +4
// to -5 m/s and back inside 0.58s). Cause: scorePositioning's `my` is binary
// and, with the ball loose, follows lastTouchTeam — a brush off a shin flips
// it — and every base target steps by up to 22m with it. A real team does not
// reshape until the other side actually has the ball. Loose balls change
// nothing here; a new team must CONTROL it for SHAPE_POSSESSION_SETTLE_MS; a
// keeper's control and restarts count at once.
void GameEngine::updateShapePossession() {
    const Player* c = playerById(state.ball.controllerId);
    if (!c) return;   // loose: keep the shape we have
    if (c->team == shapePossession) { shapeCandidate = shapePossession; return; }
    if (c->role == Role::GK) { shapePossession = shapeCandidate = c->team; shapeCandidateSinceMs = state.clockMs; return; }
    if (shapeCandidate != c->team) { shapeCandidate = c->team; shapeCandidateSinceMs = state.clockMs; return; }
    if (state.clockMs - shapeCandidateSinceMs >= SHAPE_POSSESSION_SETTLE_MS) shapePossession = c->team;
}

void GameEngine::updateSetPiecePhase(double sdt, double sec) {
    phase.actionTimer -= sdt;
    Team spTeam = setPiece.team;

    // Out-ball glide: an awarded corner/throw/goal-kick ball keeps ROLLING
    // beyond the line under friction instead of teleporting to the restart
    // spot the tick it crossed ("goal kicks look weird" — the ball vanished
    // mid-flight and reappeared dead in the keeper's hands). Nobody can play
    // it (armed chase gate; no collection runs in this phase) and the taker
    // walks to the SPOT; when the window closes — or the ball dies — place it.
    if (setPiece.placeBallAtMs > 0.0) {
        auto& gb = state.ball;
        bool alive = std::hypot(gb.vx, gb.vy) > 20.0 || gb.z > 0.5;
        // A deflection ruled "going behind" can be awarded while the ball is
        // still WELL INSIDE the pitch — the fixed window then expired
        // mid-flight and snapped it to the arc from 80px in-field (watched
        // replay 0:24, 0:37). While it is alive, un-crossed and still heading
        // out, extend the glide (hard cap +1400ms so a freak swerve that
        // stays in can't stall the restart forever).
        bool inField = gb.x > -6.0 && gb.x < PITCH_W + 6.0 && gb.y > -6.0 && gb.y < PITCH_H + 6.0;
        bool headingOut = (setPiece.spotX < HALF_X ? gb.vx < -15.0 : gb.vx > 15.0)
                       || gb.y < -6.0 || gb.y > PITCH_H + 6.0;
        bool extend = (setPiece.type == SetPiece::Corner || setPiece.type == SetPiece::GoalKick)
                   && alive && inField && headingOut
                   && state.clockMs < setPiece.placeBallAtMs + 1400.0;
        if ((state.clockMs < setPiece.placeBallAtMs || extend) && alive && gb.controllerId < 0) {
            applyBallPhysics(sec);
            clampBallPosition();
        } else {
            // GUIDED RETRIEVAL — never snap. When the glide window closes with the
            // ball still away from the restart spot (an early-ruled deflection, a
            // ball that rolled past the arc), STEER the dead ball to the spot at a
            // bounded roll speed instead of teleporting it (watched replay seed
            // 103 0:30/31: a 420px snap to the flag). Reads as the ball being
            // rolled back for the restart; placement completes on arrival.
            double gdx = setPiece.spotX - gb.x, gdy = setPiece.spotY - gb.y;
            double gd = std::hypot(gdx, gdy);
            if (gd < 14.0) {
                gb.x = setPiece.spotX;
                gb.y = setPiece.spotY;
                gb.vx = gb.vy = gb.z = gb.vz = 0;
                setPiece.placeBallAtMs = 0.0;
            } else {
                // Round-19 (audit): the old 240-760px/s cap made a restart-ball
                // retrieval read as a ghost-struck ball at up to 760px/s. Cap
                // near a rolled-ball speed instead — a far retrieval simply takes
                // longer to arrive, which reads naturally and never rushes the
                // restart (the hold timer only starts once the taker is on the
                // placed ball, so slower placement cannot fire the restart early).
                double sp = clamp(gd / 0.40, 200.0, 300.0);
                driveBall(gb, gdx, gdy, gd, sp);
                gb.vz = 0;
                gb.z *= 0.72;                                  // settle out of the air
                gb.x += gb.vx * sec;
                gb.y += gb.vy * sec;
            }
        }
    }

    // Populate throw-in support targets once per set piece.
    populateThrowInSupport(spTeam);
    shapePossession = shapeCandidate = spTeam;   // Round-49: a restart settles possession at once
    shapeCandidateSinceMs = state.clockMs;

    runSetPieceChoreography(spTeam, sdt, sec);
    capRestartMovement(sdt);
}

// ══════════════════════════════════════════════════════════════════════════════
// Round-44: capRestartMovement() — one speed limit for the walk to a restart
// ══════════════════════════════════════════════════════════════════════════════
// Owner: "it needs to look smooth like a real game". The seed-1110 audit found
// that 233 of the 238 player-frames above 15 m/s in the whole match, and 429 of
// the 613 above 10 m/s, fall inside restart holds: at 23:00.83 a centre-forward
// covers 29m in 1.6s (peak 26.9 m/s) to join a wall, twelve players are above
// 10 m/s at once, and all of them then stand still for five seconds waiting for
// the kick. 28 of the 58 restarts in the match had a player above 10 m/s.
// Cause: three movers push the same man in the same tick while a set piece is
// armed — his own applyMovement toward the choreography target, the Law-13 /
// goal-kick-area shove in enforceRestartDistance (x1.9 sprint, raised to win a
// tug-of-war with the first) and, on a dangerous free kick, the wall mover
// (x1.5 sprint). They add: 68 + 129 + 102 = 299 px/s, the measured peak. Each
// was tuned on its own and each is doing its job, so rather than re-tune three
// multipliers against each other, bound their SUM: whatever they ask for between
// them, a non-taker's net displacement this tick is at most a sprint. Direction
// is preserved, so the shove still wins the tug-of-war; it just cannot teleport.
// ("A sprint" here is RESTART_MOVE_MAX_SPEED, a quarter above SPEED_SPRINT — see
// the tombstone on that constant for why not SPEED_SPRINT itself.)
// telemetry.prevX/Y hold every player's position at the top of this tick.
// The taker is exempt — his run-up and its placement backstop are a separate
// mechanism (driveRestartApproach). The hold timers are unchanged: the men who
// used to arrive in a second and wait five now arrive in three and wait three.
// When that is not enough, the release gate in driveRestartApproach waits for
// them (restartCappedLastTick), so a kick is not taken past men still retreating.
void GameEngine::capRestartMovement(double sdt) {
    const double cap = RESTART_MOVE_MAX_SPEED * (sdt / 1000.0);
    restartCappedLastTick = 0;
    if (cap <= 0.0) return;
    for (auto& p : state.players) {
        if (p.sentOff || p.id == setPiece.takerId) continue;
        double dx = p.x - telemetry.prevX[p.id], dy = p.y - telemetry.prevY[p.id];
        double step = std::hypot(dx, dy);
        if (step <= cap) continue;
        p.x = telemetry.prevX[p.id] + dx / step * cap;
        p.y = telemetry.prevY[p.id] + dy / step * cap;
        stats.recordRestartMoveCapped();
        restartCappedLastTick++;
    }
}

// Round-30: the half-time interval. Exactly the post-goal walk-in motion model
// (lerp-to-arrive over the remaining break + the sin() micro-idle sway + facing
// along the walk vector), re-aimed at the H2 formation spots captured when the
// pause was armed. No rng, no decisions, no ball physics — the players stroll to
// their restart positions and stand there. kickoff() snaps them onto the exact
// spots when the break ends, so the H2 tap is the same staging as any other.
void GameEngine::halfTimeWalk(double sdt) {
    if (!restartWalk.halfTime) return;
    double sec = sdt / 1000.0;
    double remainMs = std::max(sdt, phase.halfTimePause);
    double frac = clamp(sdt / remainMs, 0.0, 1.0);
    for (auto& p : state.players) {
        if (p.sentOff) continue;
        double dx = restartWalk.targetX[p.id] - p.x, dy = restartWalk.targetY[p.id] - p.y;
        double stepX = dx * frac, stepY = dy * frac;
        double idle = std::sin((state.clockMs + p.id * 211.0) * 0.005) * 0.6 * sec * 60.0;
        p.x += stepX;
        p.y += stepY + idle;
        p.vx = stepX / std::max(sec, 1e-6);
        p.vy = stepY / std::max(sec, 1e-6);
        if (std::hypot(dx, dy) > 2.0) p.facing = std::atan2(dy, dx);
    }
}

void GameEngine::updateKickoffPhase(double sdt) {
    phase.actionTimer -= sdt;
    // Post-goal walk-in: stroll each dot toward its formation spot over the
    // remaining hold (lerp-to-arrive, so the per-tick step is small and eases to
    // zero — never the 80px teleport of the old snap). Deterministic drift only.
    if (restartWalk.active && phase.actionTimer > 0.0) {
        double sec = sdt / 1000.0;
        double remainMs = std::max(sdt, phase.actionTimer);
        // lerp-to-arrive: close this fraction of the REMAINING distance each tick.
        // With the whole hold ahead the early steps are a few px (never a slide),
        // easing to zero as the dot settles onto its spot exactly at the snap.
        double frac = clamp(sdt / remainMs, 0.0, 1.0);
        double elapsed = state.clockMs - phase.lastKickoffMs;
        for (auto& p : state.players) {
            if (p.sentOff) continue;
            double dx = restartWalk.targetX[p.id] - p.x, dy = restartWalk.targetY[p.id] - p.y;
            double stepX = dx * frac, stepY = dy * frac;
            // Round-34: the lerp's opening pace is distance/hold, so a dot 80m
            // from his spot LAUNCHED at 8.3 m/s and, with the sway on top,
            // peaked at 13.75 m/s — 49 km/h, half again the human world record,
            // held for essentially the whole hold. 22 dots gliding across the
            // pitch after every goal. Cap the step at a run so the restart is
            // paced like football; the hold was widened to 16s at the call site
            // (engine_physics.cpp) so the 99th-percentile distance still arrives
            // and the terminal snap below stays a no-op.
            double sl = std::hypot(stepX, stepY);
            double cap = restartWalk.pace[p.id] * sec;
            if (sl > cap) { stepX *= cap / sl; stepY *= cap / sl; }
            // Micro idle: a tiny deterministic sway (no rng) so a dot that has
            // reached its spot breathes rather than freezing dead. Round-34: it
            // is applied to ARRIVED dots only. On a moving dot it was never a
            // breath — it added a standing 3.6 m/s of lateral jitter to the walk
            // and ate into the cap above for no visible gain.
            double idle = std::hypot(dx, dy) <= 2.0
                ? std::sin((state.clockMs + p.id * 211.0) * 0.005) * 0.6 * sec * 60.0 : 0.0;
            p.x += stepX;
            p.y += stepY + idle;
            p.vx = stepX / std::max(sec, 1e-6);
            p.vy = stepY / std::max(sec, 1e-6);
            // The scorer WHEELS AWAY to celebrate — face the nearest corner for the
            // presentation window; everyone else faces their walk direction.
            if (p.id == restartWalk.scorerId && elapsed < restartWalk.presentMs) {
                double cx = (p.x < HALF_X) ? 0.0 : PITCH_W;
                double cy = (p.y < PITCH_H / 2.0) ? 0.0 : PITCH_H;
                p.facing = std::atan2(cy - p.y, cx - p.x);
            } else if (std::hypot(dx, dy) > 2.0) {
                p.facing = std::atan2(dy, dx);
            }
        }
    }
    if (phase.actionTimer <= 0) {
        // Snap to the EXACT formation so the tap (and everything after) is
        // byte-identical to a straight-to-staging kickoff.
        if (restartWalk.active) {
            for (auto& p : state.players) {
                if (p.sentOff) continue;
                // Round-34 census: residual at the terminal snap. The lerp-to-arrive
                // was introduced to remove an 80px teleport here; any jog cap put on
                // it has to keep this at ~0 or the teleport comes back.
                double sd = dist(p.x, p.y, restartWalk.targetX[p.id], restartWalk.targetY[p.id]);
                stats.census.walkSnaps++;
                stats.census.walkSnapDistSum += sd;
                if (sd > stats.census.walkSnapDistMax) stats.census.walkSnapDistMax = sd;
                if (sd > 8.0) stats.census.walkSnapOver8++;
                if (sd > 20.0) stats.census.walkSnapOver20++;
                if (sd > 80.0) stats.census.walkSnapOver80++;
                p.x = restartWalk.targetX[p.id];
                p.y = restartWalk.targetY[p.id];
                p.vx = p.vy = 0;
            }
            restartWalk.active = false;
        }
        phase.kickoffPhase = false;
        kickoffTap();
    }
    cacheBallState();
}

void GameEngine::updateOpenPlayPhase(double sdt, double sec) {
    sampleVelocityOrigins();
    auto& b = state.ball;
    if (b.controllerId >= 0) runtime[b.controllerId].duel.contestBlockedUntil = 0;
    if (b.controllerId < 0) {
        applyBallPhysics(sec);
        clampBallPosition();
        tryGKSave();
        if (checkWoodwork()) {
            cacheBallState();
            return;
        }
        if (checkGoal()) {
            cacheBallState();
            return;
        }
        if (checkOutOfPlay()) {
            cacheBallState();
            return;
        }
        checkBallPlayerCollision(sec);
    }
    // Marking conflicts are re-decided every tick, so the arbitration array
    // must be rebuilt every tick — leaving it stale pinned each opponent to
    // his first marker for the rest of the match, degrading coordination.
    for (auto& bb : blackboards) {
        bb.pressingPlayerId = bb.pressingPlayerId2 = -1;
        bb.markedOpponents.fill(-1);
    }
    updateShapePossession();
    updateTeamAssignments();
    applyDirectives(); // §1.3b: applyLiveCommands now runs INSIDE applyDirectives (after the timeline
                       // loop, before the dials) so live-inject ≡ timeline-replay — no 1-tick offset.
    tickAgents(sdt, true);
    // ── Keeper-distribution choreography ── the fix the anti-swarm tombstone
    // (agent_positioning_helpers.cpp) prescribes: ONLY while a keeper holds the
    // ball in his own box, both teams run the goal-kick shapes (build-up spread
    // for his side, press ladder + rest defense for the opponents). Written
    // AFTER tickAgents so the targets stand, and executeAction defers to them
    // (keeperHoldChoreo gate) so they actually DRIVE movement — the seed 133
    // 0:46 knot was 7 teammates loitering at 0-16px/s on correct 300px-away
    // targets while their own per-tick decisions kept re-anchoring them, plus
    // one opponent presser flapping his target every 1-3 ticks against a
    // keeper he can never tackle.
    keeperHoldChoreo = false;
    if (!setPiece.armed && b.controllerId >= 0) {
        Player* holdGk = playerById(b.controllerId);
        if (holdGk && holdGk->role == Role::GK && !gkHoldFeetOnly
            && std::abs(holdGk->x - ownGoalXFor(holdGk->team)) < PENALTY_AREA_W + 30.0) {
            keeperHoldChoreo = true;
            for (auto& a : agents)
                if (a->player.id != holdGk->id)
                    a->setPiecePositioning(SetPiece::GoalKick, holdGk->team);
        }
    }
    if (goalKickMonitor.distributeTimer > 0) {
        goalKickMonitor.distributeTimer -= sdt;
        if (goalKickMonitor.distributeTimer <= 0) releaseSetPiece();
    }
    // The keeper's hold-for-a-lane clock is only meaningful while a GK holds the
    // ball; the moment the ball leaves him (distribution, or knocked loose) it
    // resets so the next hold episode starts fresh (never fires the cap stale).
    {
        Player* ctrl = b.controllerId >= 0 ? playerById(b.controllerId) : nullptr;
        if (!ctrl || ctrl->role != Role::GK) goalKickMonitor.holdSinceMs = -1;
    }
    if (b.intendedReceiverId >= 0 && b.controllerId < 0) {
        Player* receiver = playerById(b.intendedReceiverId);
        if (receiver) {
            double ballSpeed = std::hypot(b.vx, b.vy);
            double rx = b.x - receiver->x;
            double ry = b.y - receiver->y;
            double receiverDist = std::hypot(rx, ry);
            double receiverSpeed = std::max(36.0, SPEED_SPRINT * attrFactor(receiver->attrs.speed));
            // Round-26: this post-tick override rewrites the receiver's target to a
            // near meet-early point EVERY tick, clobbering agent_defend's properly-
            // led Chase aim (ball_pos + ball_vel*0.7). For a ball LED AHEAD of a
            // forward run its nearer point pulls the receiver BACKWARD into the
            // presser (owner's 0:03.4->0:05.18 seed-264 moment: pid8 abandoned a
            // wing run, reversed 46px down the ball line, and was dispossessed at
            // the standing reception). Gate the override OFF when the ball is
            // aimed ahead of the receiver's own running direction AND he can reach
            // the flight line before the ball arrives -- then agent_defend's lead
            // target stands and he runs ONTO the ball. Meet-early is kept for
            // backward/square balls and standing/relief receptions (dot<=0, or no
            // genuine run), so round-25's patient-defending interception cost is
            // not extended by a blanket removal.
            bool letRunStand = false;
            double recvSp = std::hypot(receiver->vx, receiver->vy);
            if (ballSpeed > 40.0 && recvSp > 45.0) {
                double flightT = clamp(receiverDist / std::max(ballSpeed, 1.0), 0.0, 1.2);
                double aimX, aimY;
                predictBallPos(flightT, aimX, aimY);   // drag/bounce-correct, not linear (overruns 100px+)
                double toAimX = aimX - receiver->x, toAimY = aimY - receiver->y;
                if (toAimX * receiver->vx + toAimY * receiver->vy > 0.0) {   // ball led ahead of the run
                    double aimDist = std::hypot(toAimX, toAimY);
                    if (aimDist / receiverSpeed <= flightT + 0.15) letRunStand = true;   // reaches the flight line in time
                }
            }
            if (!letRunStand) {
                double leadTime = clamp(receiverDist / receiverSpeed, 0.14, 0.46);
                double maxLead = clamp(receiverDist * 0.72, 18.0, 74.0);
                double leadDist = std::min(ballSpeed * leadTime, maxLead);
                double targetX = b.x;
                double targetY = b.y;
                if (ballSpeed > 12.0) {
                    targetX += (b.vx / ballSpeed) * leadDist;
                    targetY += (b.vy / ballSpeed) * leadDist;
                }
                receiver->targetX = clamp(targetX, PLAYER_R, PITCH_W - PLAYER_R);
                receiver->targetY = clamp(targetY, PLAYER_R, PITCH_H - PLAYER_R);
            }
        }
    }
    updateControlledBall(sec);
    moveBallCarrier(sdt);
    updateGK(sdt);
    separateTeammates(sdt);
    finalizeVelocities(sec); // authoritative velocity from this tick's true displacement
    // (Round-31: the render-facing low-pass used to sit here — see
    //  GameEngine::updateRenderFacing, now driven from fixedUpdate every tick.)
    updateControlledBall(sec);
    updateGoalKickMonitor();
    tryGKSave();
    if (state.ball.controllerId < 0) {
        double speed = std::hypot(state.ball.vx, state.ball.vy);
        metrics.peakBallSpeed = std::max(metrics.peakBallSpeed, speed);
        metrics.looseBallSpeedTotal += speed;
        metrics.looseBallSpeedSamples++;
        stats.recordBallSpeedSample(speed);
    }
    double jumpDx = state.ball.x - prevBallX;
    double jumpDy = state.ball.y - prevBallY;
    double jumpDist = std::hypot(jumpDx, jumpDy);
    double expectedSpeed = std::max(std::hypot(prevBallVx, prevBallVy), std::hypot(state.ball.vx, state.ball.vy));
    double expectedMax = expectedSpeed * sec + 20.0 + (activeKnockAhead.active ? DRIBBLE_KNOCK_OFFSET : 0.0);
    bool recentImpulse = ballImpulseGraceTicks > 0;
    if (jumpDist > expectedMax && jumpDist > 25.0 && !recentImpulse && !setPiece.armed && !phase.kickoffPhase && state.ball.controllerId < 0) {
        stats.recordBallJump();
    }
    // Round-19 (seed 629 0:48): the velocity-gated ball_jump check above is
    // suppressed during the impulse grace window, so a save-punch that snapped
    // the ball 191px in one tick slipped through. A pure POSITION discontinuity
    // is never legitimate for a loose ball: real one-tick flight is <15px, so a
    // >55px jump is a teleport regardless of impulse. Suppressed only for genuine
    // placements (armed set piece, kickoff, out-ball glide/restart retrieval).
    if (jumpDist > 55.0 && state.ball.controllerId < 0 && !setPiece.armed
        && !phase.kickoffPhase && setPiece.placeBallAtMs <= 0.0) {
        stats.recordQualityFlag(QualityFlag::BallTeleport);
    }
    if (ballImpulseGraceTicks > 0) ballImpulseGraceTicks--;
    cacheBallState();
}

void GameEngine::tickAgents(double sdt, bool ic) {
    for (auto& a : agents) {
        int id = a->player.id;
        if (a->player.sentOff) continue;
        if (id == state.ball.controllerId && !ic) continue;
        a->tick(sdt);
        // 720°/2s == the trace auditor's 540°/1.5s pirouette rate — at 1080 the
        // flag was blind (1 firing per 16 matches vs 4-11 visible spins/15min).
        if (a->dizzyRotationAccum > 720.0) {
            dizzySpins++;
            stats.recordDizzySpin();
            a->dizzyRotationAccum = 0;
            a->dizzyWindowStartMs = state.clockMs;
        }
    }
}

// ══════════════════════════════════════════════════════════════
// JSON serialization
// ══════════════════════════════════════════════════════════════


std::string GameEngine::getJSON() const {
    auto& b = state.ball;
    nlohmann::json j;
    j["clockMs"] = std::round(state.clockMs);
    j["matchState"] = state.matchState;
    j["half"] = phase.half;
    j["addedTime"] = phase.addedTimeActive;
    j["addedTimeAnnouncedMin"] = phase.announcedAddedMin;
    j["version"] = nativeBuildVersion();
    j["speed"] = state.speed;
    j["homeScore"] = state.homeScore;
    j["awayScore"] = state.awayScore;
    j["attrsEqualized"] = attrsEqualized;   // Round-21 (arena audit): true when equalizeAttributes ran (bare-CLI debug default)
    if (frameSample > 0) j["frameSample"] = frameSample;   // --frame-sample only: marks the stream as already thinned (see engine.h)

    j["ball"] = {
        {"x", std::round(b.x * 10) / 10}, {"y", std::round(b.y * 10) / 10}, {"vx", std::round(b.vx * 10) / 10}, {"vy", std::round(b.vy * 10) / 10}, {"z", std::round(b.z * 10) / 10}, {"curl", std::round(b.curl * 1000) / 1000}, {"cutback", pendingPass.active && pendingPass.isCutback}, {"controllerId", b.controllerId >= 0 ? nlohmann::json(b.controllerId) : nlohmann::json(nullptr)}, {"intendedReceiverId", b.intendedReceiverId >= 0 ? nlohmann::json(b.intendedReceiverId) : nlohmann::json(nullptr)}, {"lastTouchTeam", std::string(to_string(b.lastTouchTeam))}, {"lastToucherId", b.lastToucherId >= 0 ? nlohmann::json(b.lastToucherId) : nlohmann::json(nullptr)}};

    j["players"] = nlohmann::json::array();
    for (auto& p : state.players) {
        j["players"].push_back({{"id", p.id}, {"name", p.name}, {"team", std::string(to_string(p.team))}, {"role", std::string(to_string(p.role))}, {"x", std::round(p.x * 10) / 10}, {"y", std::round(p.y * 10) / 10}, {"vx", std::round(p.vx * 10) / 10}, {"vy", std::round(p.vy * 10) / 10}, {"targetX", std::round(p.targetX * 10) / 10}, {"targetY", std::round(p.targetY * 10) / 10}, {"stamina", std::round(p.stamina)}, {"facing", std::round(renderFacing[p.id] * 1000) / 1000}, {"dribbleType", p.dribbleType}, {"tackleAnim", std::round(p.tackleAnim)}, {"headingAnim", std::round(p.headingAnim)}, {"diveAnim", std::round(p.diveAnim)}, {"wall", p.wall}, {"slide", p.tackleAnim > 400.0}, {"goals", pStats[p.id].goals}, {"assists", pStats[p.id].assists}, {"shots", pStats[p.id].shots}, {"tackles", pStats[p.id].tackles}, {"yellow", runtime[p.id].yellowCards}, {"passes", pStats[p.id].passes}, {"passesCompleted", pStats[p.id].passesCompleted}, {"injured", p.injurySeverity > 0.05}, {"sentOff", p.sentOff}});
    }

    // Forward every stats summary metric verbatim. getJSON builds its own
    // "events" array (from visualEvents) below, so drop the summary copy.
    // Two output keys differ from their produced names and are set explicitly:
    //   wrongTeammateTouches ← wrongTeammate (rename)
    //   penaltyGoals         ← setPieces.penaltiesScored (derived)
    nlohmann::json summary = nlohmann::json::parse(stats.summaryJSON());
    summary.erase("events");
    j.update(summary);
    j["wrongTeammateTouches"] = summary["wrongTeammate"];
    j.erase("wrongTeammate");
    j["penaltyGoals"] = summary["setPieces"]["penaltiesScored"];

    j["events"] = nlohmann::json::array();
    for (const auto& ev : visualEvents) {
        double age = state.clockMs - ev.clockMs;
        if (age > 2600.0) continue;
        nlohmann::json je = {{"type", ev.type},
                             {"x", std::round(ev.x * 10) / 10},
                             {"y", std::round(ev.y * 10) / 10},
                             {"age", std::round(age)},
                             {"playerId", ev.playerId >= 0 ? nlohmann::json(ev.playerId) : nlohmann::json(nullptr)},
                             {"targetId", ev.targetId >= 0 ? nlohmann::json(ev.targetId) : nlohmann::json(nullptr)},
                             {"ownGoal", ev.ownGoal}};
        // Substitutions only (see VisualEvent): playerId is the SLOT and resolves to
        // the arriving man, so the departing one has to travel as a name.
        if (!ev.outName.empty()) je["outName"] = ev.outName;
        if (!ev.inName.empty()) je["inName"] = ev.inName;
        j["events"].push_back(std::move(je));
    }
    // Whole-match substitution log — the .bin trace's fixed-width event record has
    // no room for a name, so the replay exporter joins this to the trace's "sub"
    // events on (clockMs, slotId).
    j["substitutionLog"] = nlohmann::json::array();
    for (const auto& s : substitutionLog) {
        j["substitutionLog"].push_back({{"clockMs", std::round(s.clockMs)},
                                        {"slotId", s.slotId},
                                        {"team", std::string(to_string(s.team))},
                                        {"outName", s.outName},
                                        {"inName", s.inName},
                                        {"outGoals", s.outTally.goals},
                                        {"outAssists", s.outTally.assists},
                                        {"outShots", s.outTally.shots},
                                        {"outTackles", s.outTally.tackles},
                                        {"outPasses", s.outTally.passes},
                                        {"outPassesCompleted", s.outTally.passesCompleted},
                                        {"outYellowCards", s.outYellowCards}});
    }
    j["possessionPct"] = summary["possessionPct"];

    if (setPiece.armed) {
        j["setPieceState"] = {
            {"type", to_string(setPiece.type)},
            {"reason", setPiece.reason.empty() ? to_string(setPiece.type) : setPiece.reason},
            {"team", to_string(setPiece.team)},
            {"takerId", setPiece.takerId},
            {"takerArrived", setPiece.takerArrived},
            {"spotX", setPiece.spotX},
            {"spotY", setPiece.spotY},
            {"timerMs", phase.actionTimer}};
    }

    return j.dump();
}

// The --frame-sample pin for transient events. Reads the SAME list with the SAME rounded age
// as the events[] block above, so "this frame would carry a fresh penalty/woodwork event" is
// decided without serialising the frame. No upper age bound is needed here: getJSON drops an
// event from events[] past 2600ms, far above the freshness window.
bool GameEngine::hasFreshNotableEvent() const {
    for (const auto& ev : visualEvents) {
        if (ev.type != "penalty" && ev.type != "woodwork") continue;
        if (std::round(state.clockMs - ev.clockMs) < FRAME_SAMPLE_FRESH_EVENT_MS) return true;
    }
    return false;
}

// ══════════════════════════════════════════════════════════════
// Lifecycle — constructor, initWithSeed, createHomeTeam, createAwayTeam
// ══════════════════════════════════════════════════════════════

GameEngine::~GameEngine() = default;

GameEngine::GameEngine() {
    blackboards[0] = TeamBlackboard();
    blackboards[1] = TeamBlackboard();
}

namespace {
// Per-legend attribute identity: {speed, passing, creativity, shooting,
// tackling, positioning, stamina}. Random rolls made Messi play like
// Chiellini; these make the names mean something on the pitch.
PlayerAttributes legendAttrsFor(int id) {
    static const PlayerAttributes profiles[22] = {
        /* 0 Buffon      */ {50, 60, 55, 30, 45, 92, 70},
        /* 1 Dani Alves  */ {82, 78, 76, 60, 72, 74, 88},
        /* 2 Ramos       */ {74, 72, 60, 62, 90, 84, 84},
        /* 3 Pique       */ {62, 74, 62, 55, 86, 86, 78},
        /* 4 Marcelo     */ {84, 80, 82, 62, 65, 68, 84},
        /* 5 Iniesta     */ {70, 92, 94, 66, 55, 80, 80},
        /* 6 Xavi        */ {64, 96, 92, 60, 52, 86, 82},
        /* 7 Modric      */ {72, 92, 90, 70, 62, 82, 86},
        /* 8 Neymar      */ {90, 84, 95, 84, 40, 70, 80},
        /* 9 Messi       */ {91, 90, 97, 96, 38, 78, 82},
        /*10 Ronaldinho  */ {84, 88, 96, 82, 36, 68, 76},
        /*11 Neuer       */ {62, 75, 65, 35, 50, 94, 75},
        /*12 Lahm        */ {78, 84, 78, 58, 84, 88, 86},
        /*13 Van Dijk    */ {78, 76, 58, 60, 92, 90, 86},
        /*14 Chiellini   */ {68, 64, 50, 50, 94, 88, 82},
        /*15 Alba        */ {88, 78, 74, 60, 68, 72, 88},
        /*16 Kroos       */ {60, 95, 88, 78, 58, 84, 80},
        /*17 De Bruyne   */ {78, 95, 93, 86, 56, 80, 84},
        /*18 Busquets    */ {58, 90, 84, 50, 78, 90, 80},
        /*19 Robben      */ {88, 78, 86, 88, 40, 72, 76},
        /*20 Ronaldo     */ {92, 78, 84, 96, 40, 82, 90},
        /*21 Bale        */ {93, 76, 80, 88, 48, 70, 84},
    };
    // #35 (SysArch/user decision): legends are ELITE, not superhuman. Compress the maxed
    // attrs toward realistic-elite so the SHOWCASE demo reads like a real elite match — THE
    // unlock for the attribute-driven over-conversion. RosterOverride spec teams (the game
    // layer) are untouched; each legend's relative identity (shape) is preserved.
    // Coefficient tightened 0.42 -> 0.26 (2026-06-24, SysArch "a-lite"): the WIDENED 16-seed
    // agg exposed the true legend goals as 4.4-4.8 (the old 8 fixed seeds under-reported ~3.4);
    // 0.26 lands the showcase at goals ~3.4 / shots ~25 / oT ~8 / saves ~3.1 / pass% 82 — all
    // realistic, saves+pass% HELD (no keeper backfire). Top forwards' shooting ~72 (Messi-tier).
    PlayerAttributes a = (id >= 0 && id < 22) ? profiles[id] : PlayerAttributes{};
    // RE-BUMP 0.26->0.28 (2026-06-25, post-offside-fix 82835b4 which shaved the showcase ~0.2): restores the
    // showcase to goals ~2.71 (24-seed ≈ real 2.8). ⚠ A CONVERSION CLIFF sits just above 0.28 — cz=0.29 jumps to
    // goals 4.5 (the high-attr shot/save curve is steep here); 0.28 is the TOP of the stable below-cliff zone. Do
    // NOT raise further. Golden-safe: the golden=fixture-1=SPEC roster, cz-independent (legendAttrsFor bypassed).
    auto cz = [](double v) { return clamp(63.0 + (v - 63.0) * 0.28, 38.0, 80.0); };
    a.speed = cz(a.speed);
    a.passing = cz(a.passing);
    a.creativity = cz(a.creativity);
    a.shooting = cz(a.shooting);
    a.tackling = cz(a.tackling);
    a.positioning = cz(a.positioning);
    a.stamina = cz(a.stamina);
    return a;
}

std::string legendNameFor(int id, Team team) {
    static const char* homeNames[] = {
        "Buffon", "Dani Alves", "Ramos", "Pique", "Marcelo", "Iniesta",
        "Xavi", "Modric", "Neymar", "Messi", "Ronaldinho"};
    static const char* awayNames[] = {
        "Neuer", "Lahm", "Van Dijk", "Chiellini", "Alba", "Kroos",
        "De Bruyne", "Busquets", "Robben", "Ronaldo", "Bale"};
    if (team == Team::Home && id >= 0 && id < 11) return std::format("H{} {}", id, homeNames[id]);
    if (team == Team::Away && id >= 11 && id < 22) return std::format("A{} {}", id, awayNames[id - 11]);
    return std::format("{}{}", to_string(team), id);
}
} // namespace

Player GameEngine::mkPlayer(int id, Team t, Role r, double hx, double hy) {
    const RosterOverride& ro = (t == Team::Home) ? homeRoster : awayRoster;
    int slot = (t == Team::Home) ? id : id - 11;
    if (ro.active && slot >= 0 && slot < 11) {
        // Data-driven: exact attrs + name from the user's team (no form roll).
        Player pl{id, ro.names[slot], t, r, hx, hy, 0, 0, hx, hy, hx, hy, 100.0,
                  ro.attrs[slot], t == Team::Home ? 0.0 : PI};
        pl.foot = ro.feet[slot];
        return pl;
    }
    // Legend profile with small per-match form variance (±4) so the same
    // names play recognizably while no two matches are identical.
    PlayerAttributes a = legendAttrsFor(id);
    auto form = [&](double v) { return clamp(v + rng.randomInt(-4, 4), 25.0, 99.0); };
    a.speed = form(a.speed);
    a.passing = form(a.passing);
    a.creativity = form(a.creativity);
    a.shooting = form(a.shooting);
    a.tackling = form(a.tackling);
    a.positioning = form(a.positioning);
    a.stamina = form(a.stamina);
    a.handling = a.positioning; // legend keepers: handling = positioning (no extra rng roll — preserves the stream)
    // Distinct per-legend aerial height (0-100) so the EXISTING height-weighted aerial duel
    // (engine_ball_contest.cpp, 0.5 positioning + 0.5 height) actually bites: tall CBs / target-men
    // win headers vs small playmakers, instead of a flat positioning-only ~50/50. NOT cz-compressed
    // (height drives aerial contests, not the over-conversion the cz targets) and no rng draw (the
    // stream is preserved). Legend-only — spec/golden teams return above with their own attrs, so
    // the golden stays byte-identical.
    static const double legendHeight[22] = {
        /*0 Buffon*/ 65,
        /*1 D.Alves*/ 52,
        /*2 Ramos*/ 85,
        /*3 Pique*/ 86,
        /*4 Marcelo*/ 55,
        /*5 Iniesta*/ 48,
        /*6 Xavi*/ 46,
        /*7 Modric*/ 50,
        /*8 Neymar*/ 54,
        /*9 Messi*/ 45,
        /*10 Ronaldinho*/ 62,
        /*11 Neuer*/ 68,
        /*12 Lahm*/ 46,
        /*13 VanDijk*/ 92,
        /*14 Chiellini*/ 84,
        /*15 Alba*/ 46,
        /*16 Kroos*/ 62,
        /*17 DeBruyne*/ 60,
        /*18 Busquets*/ 74,
        /*19 Robben*/ 56,
        /*20 Ronaldo*/ 88,
        /*21 Bale*/ 78,
    };
    a.height = (id >= 0 && id < 22) ? legendHeight[id] : a.positioning;
    Player pl{id, legendNameFor(id, t), t, r, hx, hy, 0, 0, hx, hy, hx, hy, 100.0,
              a, t == Team::Home ? 0.0 : PI};
    // Legend footedness (the watched-match roster stays true to life):
    // Messi(9), Robben(19), Bale(21), Alba(15), Marcelo(4) left-footed;
    // Ronaldinho(10) and Kroos(16) effectively two-footed.
    static const int legendFoot[22] = {
        /*0*/ 1, 1, 1, 1, /*4 Marcelo*/ -1, 1, 1, 1, 1, /*9 Messi*/ -1, /*10 Ronaldinho*/ 0,
        /*11*/ 1, 1, 1, 1, /*15 Alba*/ -1, /*16 Kroos*/ 0, 1, 1, /*19 Robben*/ -1, 1, /*21 Bale*/ -1,
    };
    pl.foot = (id >= 0 && id < 22) ? legendFoot[id] : 1;
    return pl;
}

// ══════════════════════════════════════════════════════════════════════════════
// runSetPieceChoreography() — everything that happens WHILE a restart is set up
// ══════════════════════════════════════════════════════════════════════════════
// updateSetPiecePhase was 563 lines doing two separable jobs: advancing the
// dead-ball clock and the out-ball glide (which it still does), then the whole
// choreography of walking the taker in, arranging the wall and support, and
// firing the release. That second job reads only which team has the ball, so it
// splits off cleanly behind a one-argument interface.
void GameEngine::runSetPieceChoreography(Team spTeam, double sdt, double sec)
{

    if (setPiece.takerId >= 0) {
        for (auto& a : agents) {
            if (a->player.id == setPiece.takerId) {
                a->setPieceHold = true;
                break;
            }
        }
    }

    tickAgents(sdt, false);
    // Restart choreography is AUTHORITATIVE: run it after tickAgents so the
    // corner/FK/throw shape targets stand. It used to run before — each
    // player's own shape decision then overwrote his set-piece target on
    // every decision tick, a tug-of-war that left the box crowd walking in
    // circles and never arriving (watched replay 0:27: ONE attacker in the
    // box after nine seconds of an armed corner, everyone else stuck 150px
    // short with the right targets).
    for (auto& a : agents) {
        a->setPiecePositioning(setPiece.type, spTeam);
    }
    moveBallCarrier(sdt);
    separateTeammates(sdt);
    enforceRestartDistance(sdt);

    // ── Defensive wall / block, that actually FORMS, with hurry ──
    // setPiecePositioning writes the wall + block-shape targets (agent_
    // setpiece.cpp, FreeKick defending branch) AFTER tickAgents' movement
    // integrator has already run for the tick, and nothing downstream walks a
    // defender to that target — so the wall rendered (p.wall=1) but no bodies
    // were ever there (watched replay 0:53: a 21m central FK with no wall, the
    // defenders strolling their open-play shape). Walk every defending
    // outfielder to his set-piece target at urgent pace — same proven mover as
    // the intruder push above — so the block sets in ~2s of the hold. Only for
    // a dangerous FreeKick (near the defending goal); elsewhere no wall forms
    // and this is a no-op.
    if (setPiece.type == SetPiece::FreeKick && !setPiece.fast) {
        Team defTeam = setPiece.team == Team::Home ? Team::Away : Team::Home;
        double defGoalX = ownGoalXFor(defTeam);
        bool dangerFK = std::abs(setPiece.spotX - defGoalX) < 300.0;
        if (dangerFK) {
            double step = SPEED_SPRINT * 1.5 * (sdt / 1000.0);
            for (auto& p : state.players) {
                if (p.team != defTeam || p.role == Role::GK || p.sentOff) continue;
                double mx = p.targetX - p.x, my = p.targetY - p.y, md = std::hypot(mx, my);
                if (md > 2.0) {
                    double st = std::min(step, md);
                    p.x += mx / md * st;
                    p.y += my / md * st;
                    p.vx = mx / md * SPEED_SPRINT;
                    p.vy = my / md * SPEED_SPRINT;
                    p.facing = std::atan2(state.ball.y - p.y, state.ball.x - p.x); // watch the ball
                }
            }
        }
    }

    // Keepers are NOT statues during restarts: fixedUpdate's armed
    // early-return skips updateGK entirely, so a keeper stood wherever the
    // previous phase left him through every corner/FK hold (watched replay
    // 0:34-0:36: 80px off his line, below the post, for six seconds — the
    // agent's setPiecePositioning early-returns for GKs too). Position each
    // keeper normally, except the taker (the restart walk owns him) and the
    // defending keeper at a penalty (the Law 14 walk owns him).
    for (Team tm : {Team::Home, Team::Away}) {
        Player* k = findGK(tm);
        if (!k || k->sentOff || k->id == setPiece.takerId) continue;
        if (setPiece.type == SetPiece::Penalty && tm != setPiece.team) continue;
        updateOneGK(*k, sec);
    }

    // Watchdog: a malformed arm (no taker, no controller) must never freeze
    // the match — disarm and let open play resume.
    if (setPiece.armed && setPiece.takerId < 0 && state.ball.controllerId < 0 && setPiece.type != SetPiece::GoalKick && phase.actionTimer <= 0) {
        setPiece.armed = false;
        setPiece.type = SetPiece::None;
        setPiece.reason.clear();
        setPiece.placeBallAtMs = 0.0;
        return;
    }
    if (setPiece.type == SetPiece::GoalKick && phase.actionTimer <= 0 && state.ball.controllerId >= 0) {
        setPiece.armed = false;
        setPiece.reason.clear();
        releaseSetPiece();
        cacheBallState();
        return;
    }

    // Gaylord seam: a designated taker (fk/corner/pen/long_throw_taker directive) takes the
    // restart instead of the default position-based pick. No designation => -1 => no override
    // => golden byte-identical. Switch before the taker has arrived; restart his walk.
    if (setPiece.armed && !setPiece.takerArrived) {
        int designated = designatedTakerFor(setPiece.type, setPiece.team);
        if (designated >= 0 && setPiece.takerId != designated) {
            setPiece.takerId = designated;
            setPiece.walkMs = 0;
        }
    }

    // While the out-ball is still gliding, the taker walks to the SPOT (not
    // the rolling ball — chasing it would drag him off the pitch).
    double takerTX = setPiece.placeBallAtMs > 0.0 ? setPiece.spotX : state.ball.x;
    double takerTY = setPiece.placeBallAtMs > 0.0 ? setPiece.spotY : state.ball.y;
    if (setPiece.takerId >= 0 && !setPiece.takerArrived) {
        setPiece.walkMs += sdt;
        Player* taker = playerById(setPiece.takerId);
        if (taker) {
            double dx = takerTX - taker->x;
            double dy = takerTY - taker->y;
            double d = std::hypot(dx, dy);
            if (d > 1.0) {
                double speed = attrFactor(taker->attrs.speed) * SPEED_SPRINT;
                double step = std::min(speed * (sdt / 1000.0), d);
                taker->x += (dx / d) * step;
                taker->y += (dy / d) * step;
                taker->facing = std::atan2(dy, dx);
            }
            taker->targetX = takerTX;
            taker->targetY = takerTY;
        }
    }

    if (setPiece.takerId >= 0 && !setPiece.takerArrived) {
        Player* taker = playerById(setPiece.takerId);
        if (taker) {
            double d = dist(taker->x, taker->y, takerTX, takerTY);
            // If the taker is ALREADY at the spot (e.g. he just took a corner from
            // this exact flag) but the awarded ball is still far away mid-glide,
            // do NOT complete the placement — that snapped a ball from the middle
            // of the box to the flag in one tick (watched replay seed 103 0:30).
            // He waits for the glide; placement completes when the ball is near.
            bool ballNearSpot = setPiece.placeBallAtMs <= 0.0
                             || dist(state.ball.x, state.ball.y, setPiece.spotX, setPiece.spotY) < 30.0;
            if (d < 15.0 && ballNearSpot) {
                // Taker reached the spot while the ball is still gliding —
                // finish the placement now so he takes control of a real ball.
                if (setPiece.placeBallAtMs > 0.0) {
                    state.ball.x = setPiece.spotX;
                    state.ball.y = setPiece.spotY;
                    state.ball.vx = state.ball.vy = state.ball.z = state.ball.vz = 0;
                    setPiece.placeBallAtMs = 0.0;
                }
                setPiece.takerArrived = true;
                setPiece.walkMs = 0;
                state.ball.controllerId = taker->id;
                state.ball.lastTouchTeam = taker->team;
                state.ball.lastToucherId = taker->id; lastRicochetMs = -1e9;   // genuine touch supersedes ricochet restart memory
                runtime[taker->id].controlStartMs = state.clockMs;   // Round-38: restart possession is fresh control — stamp for the panic-clear grace
                // Goal kick: the 6s award budget (awardSetPiece: "6s total") keeps
                // counting through the keeper's walk — re-arming on arrival stacked
                // another full hold on top (observed 10-13s frozen restarts).
                // Fast free kick: barely any hold — play it before the wall sets.
                if (setPiece.type != SetPiece::GoalKick) {
                    double oppGoalX = (setPiece.team == Team::Home) ? PITCH_W : 0.0;
                    phase.actionTimer = setPiece.fast ? 300.0
                        : actionTimerFor(setPiece.type, std::abs(setPiece.spotX - oppGoalX))
                              * (arenaMode ? ARENA_RESTART_SCALE : 1.0);   // Round-21 (arena audit): tighter restart pacing in the duel
                }
                // ── Plan the FREE-KICK RUN-UP (owner: "free kicks especially shot
                // ones should have run ups") now that the taker is on the ball. A
                // fast FK skips it (the whole point of a fast FK is no theatre).
                // Deterministic: goal/spot geometry + the taker id, never rng.
                setPiece.runUpActive = false;
                if (setPiece.type == SetPiece::FreeKick && !setPiece.fast) {
                    double gx = goalXFor(taker->team);          // opponent goal-mouth centre
                    double gy = PITCH_H / 2.0;
                    double shotDist = std::hypot(gx - setPiece.spotX, gy - setPiece.spotY);
                    bool central = std::abs(setPiece.spotY - gy) < 170.0;
                    // Direct-shot range ⇒ aim the run-up at goal; otherwise up-pitch
                    // toward the opponent goal (the pass target isn't chosen until
                    // releaseSetPiece — owner's "else toward the opponent goal").
                    bool shotRange = shotDist < 330.0 && central;
                    double sdx, sdy;
                    if (shotRange) { sdx = gx - setPiece.spotX; sdy = gy - setPiece.spotY; }
                    else           { sdx = fdFor(taker->team);  sdy = 0.0; }
                    double sl = std::hypot(sdx, sdy);
                    if (sl < 1e-6) { sdx = fdFor(taker->team); sdy = 0.0; sl = 1.0; }
                    sdx /= sl; sdy /= sl;
                    double runDist = shotRange ? RUNUP_DIST_SHOT : RUNUP_DIST_PASS;
                    // A SHOOTING run-up comes in from an angle (the curler's stutter
                    // steps around the wall); a short pass is a straight compact
                    // approach. Side keyed off the taker id — deterministic variety,
                    // no rng draw. perp = (-dir.y, dir.x).
                    double perpX = -sdy, perpY = sdx;
                    double side = (setPiece.takerId % 2 == 0) ? 1.0 : -1.0;
                    double lat = shotRange ? RUNUP_SIDE_OFFSET * side : 0.0;
                    setPiece.runUpDirX = sdx;
                    setPiece.runUpDirY = sdy;
                    setPiece.runUpStartX = clamp(setPiece.spotX - sdx * runDist + perpX * lat, 6.0, PITCH_W - 6.0);
                    setPiece.runUpStartY = clamp(setPiece.spotY - sdy * runDist + perpY * lat, 6.0, PITCH_H - 6.0);
                    setPiece.runUpActive = true;
                }
            }
        }
    }

    driveRestartApproach(sdt, sec);
}

// Walk the restart taker to (or onto) the spot. Was a lambda inside
// runSetPieceChoreography; a member function so the choreography can be split.
void GameEngine::placeTakerForRestart(Player& taker, bool releaseSpot, double sdt) {
        double fd = fdFor(taker.team);
        double standBack = standBackFor(setPiece.type);
        double px = clamp(releaseSpot ? setPiece.spotX : setPiece.spotX - fd * standBack, 5.0, PITCH_W - 5.0);
        double py = clamp(setPiece.spotY, 5.0, PITCH_H - 5.0);
        if (releaseSpot) {
            // Step in briskly, don't snap: the one-tick hop from the stand-back
            // offset onto the spot was the audit's "carrier teleport" (~14px in
            // 17ms, 2-5×/15min, scan_anomalies PLAYER_TELEPORT). The kick still
            // launches from the spot this tick — the taker just strides the last
            // step like a human instead of blinking; kicking from a stride back
            // is exactly how every open-play kick already looks (CONTROL_DIST).
            double dx = px - taker.x, dy = py - taker.y;
            double d = std::hypot(dx, dy);
            double step = std::min(SPEED_SPRINT * 2.0 * (sdt / 1000.0), d);
            if (d > 0.5) {
                taker.x += dx / d * step;
                taker.y += dy / d * step;
            }
        } else {
            // Steer to the stand-back point; snapping every tick made the taker
            // vibrate against moveBallCarrier walking him toward the spot.
            double dx = px - taker.x, dy = py - taker.y;
            double d = std::hypot(dx, dy);
            double step = std::min(SPEED_SPRINT * (sdt / 1000.0), d);
            if (d > 0.5) {
                taker.x += dx / d * step;
                taker.y += dy / d * step;
            }
        }
        taker.targetX = px;
        taker.targetY = py;
        taker.vx = taker.vy = 0;
        if (dist(taker.x, taker.y, setPiece.spotX, setPiece.spotY) > 0.5) {
            taker.facing = std::atan2(setPiece.spotY - taker.y, setPiece.spotX - taker.x);
        }
}

// Law 13: push everyone outside the restart radius, and put the defending keeper
// on his line for a penalty. Was a lambda inside runSetPieceChoreography.
void GameEngine::enforceRestartDistance(double sdt) {
        double minDist = minDistFor(setPiece.type);
        Team restartTeam = setPiece.team;
        double maxStep = SPEED_SPRINT * (sdt / 1000.0);
        bool pen = setPiece.type == SetPiece::Penalty;
        double fdAtt = fdFor(restartTeam);
        if (pen) {
            // The defending keeper belongs ON his line for a penalty — the
            // agent's GK early-return left him 6m off it.
            Team defTeam = restartTeam == Team::Home ? Team::Away : Team::Home;
            if (Player* dgk = findGK(defTeam)) {
                double gx = ownGoalXFor(defTeam);
                double lineX = gx + fdFor(defTeam) * 5.0;
                double mx = lineX - dgk->x, my = PITCH_H / 2.0 - dgk->y;
                double md = std::hypot(mx, my);
                double step = std::min(SPEED_SPRINT * 1.5 * (sdt / 1000.0), md);
                if (md > 0.5) {
                    dgk->x += mx / md * step;
                    dgk->y += my / md * step;
                }
            }
        }
        for (auto& p : state.players) {
            // For penalties EVERY outfielder obeys the law — attackers too.
            bool isTaker = p.id == setPiece.takerId;
            if (p.role == Role::GK || isTaker) continue;
            if (!pen && p.team == restartTeam) continue;
            // Wall members stand at a LEGAL spot (91px down the line, slant
            // ~93px) — the radial re-target here fired on them mid-WALK every
            // time their path dipped inside the radius, so the wall never
            // finished forming (seed 107 5:51: one-man wall).
            if (!pen && p.wall) continue;
            double dx = p.x - setPiece.spotX;
            double dy = p.y - setPiece.spotY;
            double d = std::hypot(dx, dy);
            // Penalty law: everyone but taker and keeper must be BEHIND the
            // spot, not just 96px away — radial spacing let defenders stand
            // on the goal line and wall up the shot.
            bool goalSide = pen && (p.x - setPiece.spotX) * fdAtt > -12.0;
            // Law 14 backstop: OUTSIDE the area too — the radial test alone let
            // the crowd camp in the 55px strip between the box edge and the
            // mark (watched replay: ten players inside the area at the kick).
            double boxEdgeBack = PENALTY_AREA_W - PENALTY_SPOT_FROM_GOAL; // 55
            bool penBoxIntruder = pen && !goalSide
                && std::abs(p.y - PITCH_H / 2.0) < PENALTY_AREA_H / 2.0 + 8.0
                && (p.x - (setPiece.spotX - fdAtt * boxEdgeBack)) * fdAtt > -6.0;
            // Law 16 (2019): opponents stay OUT of the area until a goal kick
            // is played — they pressed from inside the box before the kick.
            bool gkBoxIntruder = false;
            if (setPiece.type == SetPiece::GoalKick && p.team != restartTeam) {
                double og = ownGoalXFor(restartTeam);
                gkBoxIntruder = (p.x - og) * fdAtt < PENALTY_AREA_W + 6.0
                             && std::abs(p.y - PITCH_H / 2.0) < PENALTY_AREA_H / 2.0 + 10.0;
            }
            if (d >= minDist && !goalSide && !penBoxIntruder && !gkBoxIntruder) continue;
            if (d < 1.0) {
                double fd = fdFor(p.team);
                dx = -fd;
                dy = p.homeY < PITCH_H / 2.0 ? -0.35 : 0.35;
                d = std::hypot(dx, dy);
            }
            // FK defenders clear the ring toward their OWN GOAL, not to the
            // radial-nearest (often ball-side) arc point — a forward caught
            // inside otherwise gets parked LEVEL with the ball, velocity
            // zeroed, target == own position, and stands there for the whole
            // hold (seed 305 17:31: Bale, statue on the ball-side arc for 5.6s
            // while a shooting FK was lined up; owner: "should be running back").
            if (!pen && setPiece.type == SetPiece::FreeKick && p.team != restartTeam) {
                double gs = ownGoalXFor(p.team) - setPiece.spotX;   // spot -> own goal
                if (std::abs(gs) > 1.0) {
                    dx = (gs > 0 ? 1.0 : -1.0) * std::max(std::abs(dx), 20.0);
                    d = std::hypot(dx, dy);
                }
            }
            double tx = clamp(setPiece.spotX + dx / d * minDist, 5.0, PITCH_W - 5.0);
            double ty = clamp(setPiece.spotY + dy / d * minDist, 5.0, PITCH_H - 5.0);
            if (goalSide) {
                // Behind the box EDGE in one move, not just behind the mark —
                // re-resolving a goal-side player to 40px back still left him
                // standing inside the area.
                tx = clamp(setPiece.spotX - fdAtt * (boxEdgeBack + 16.0), 5.0, PITCH_W - 5.0);
                double sideOff = p.y >= setPiece.spotY ? 1.0 : -1.0;
                ty = clamp(setPiece.spotY + sideOff * std::max(std::abs(p.y - setPiece.spotY), 90.0), 5.0, PITCH_H - 5.0);
            } else if (penBoxIntruder) {
                tx = clamp(setPiece.spotX - fdAtt * (boxEdgeBack + 16.0), 5.0, PITCH_W - 5.0);
                ty = clamp(p.y, 5.0, PITCH_H - 5.0);
            } else if (gkBoxIntruder) {
                double og = ownGoalXFor(restartTeam);
                tx = clamp(og + fdAtt * (PENALTY_AREA_W + 16.0), 5.0, PITCH_W - 5.0);
                ty = clamp(p.y, 5.0, PITCH_H - 5.0);
            }
            // Jog out of the restart radius rather than teleporting there.
            // Urgent pace: at walking speed the agents' own pull toward the
            // ball won the tug-of-war and FKs released with opponents at 5m.
            double mx = tx - p.x, my = ty - p.y;
            double md = std::hypot(mx, my);
            if (md > 0.1) {
                double step = std::min(maxStep * 1.9, md);
                p.x += mx / md * step;
                p.y += my / md * step;
                p.vx = mx / md * SPEED_SPRINT;
                p.vy = my / md * SPEED_SPRINT;
            } else {
                p.vx = p.vy = 0;
            }
            p.targetX = tx;
            p.targetY = ty;
        }
}

// ══════════════════════════════════════════════════════════════════════════════
// driveRestartApproach() — the taker's run-up, his strike, and the release gate
// ══════════════════════════════════════════════════════════════════════════════
// The second half of runSetPieceChoreography, which was 502 lines doing two
// separable jobs: arrange the shape (wall, keepers, walk the taker toward the
// spot, plan his run-up) and then DRIVE the approach — steer him over the ball,
// dash him through it, strike on arrival, and hold the release until the Law 13
// restraint zone is clear. Once the two helper lambdas became member functions
// nothing at all is live across this boundary, so the split needs no parameters
// beyond the tick the caller already has.
void GameEngine::driveRestartApproach(double sdt, double sec)
{
    // ══ Free-kick RUN-UP drive ══ (owner: "free kicks especially shot ones should
    // have run ups"). For the bulk of the hold the taker "sets" at his run-up start
    // a few steps BEHIND the ball; in the final RUNUP_LEAD_MS he accelerates THROUGH
    // it and the kick fires the moment he arrives. The generic hold-position at the
    // foot of this function is suppressed for a run-up FK (this block owns the taker
    // instead); the ball stays pinned to the spot there until the strike.
    if (setPiece.takerArrived && setPiece.type == SetPiece::FreeKick && setPiece.runUpActive) {
        Player* taker = playerById(setPiece.takerId);
        if (taker) {
            if (phase.actionTimer > RUNUP_LEAD_MS) {
                // Set over the ball: steer back to the run-up start (never snap — a
                // one-tick hop is exactly the teleport the anomaly audit flags),
                // facing the ball like a taker measuring his steps.
                double dx = setPiece.runUpStartX - taker->x;
                double dy = setPiece.runUpStartY - taker->y;
                double d = std::hypot(dx, dy);
                double step = std::min(SPEED_SPRINT * (sdt / 1000.0), d);
                if (d > 0.5) { taker->x += dx / d * step; taker->y += dy / d * step; }
                taker->targetX = setPiece.runUpStartX;
                taker->targetY = setPiece.runUpStartY;
                taker->vx = taker->vy = 0;
                if (dist(taker->x, taker->y, setPiece.spotX, setPiece.spotY) > 0.5)
                    taker->facing = std::atan2(setPiece.spotY - taker->y, setPiece.spotX - taker->x);
            } else {
                // The approach: dash from the start THROUGH the ball to a point just
                // beyond it, at an explosive-but-human pace. RUNUP_DASH_SPEED (132)
                // sits above the LUNGE_DASH_SPEED (120) tackle-dash but is held under
                // the RUNUP_STRIKE_MAX (180) strike ceiling — so the strike tick is a
                // stride into the ball, not a sprint-teleport onto it.
                double dashSpeed = std::min(RUNUP_DASH_SPEED, RUNUP_STRIKE_MAX);
                double tx = setPiece.spotX + setPiece.runUpDirX * RUNUP_OVERRUN;
                double ty = setPiece.spotY + setPiece.runUpDirY * RUNUP_OVERRUN;
                double dx = tx - taker->x, dy = ty - taker->y, d = std::hypot(dx, dy);
                double step = std::min(dashSpeed * (sdt / 1000.0), d);
                if (d > 0.1) { taker->x += dx / d * step; taker->y += dy / d * step; }
                taker->vx = setPiece.runUpDirX * dashSpeed;
                taker->vy = setPiece.runUpDirY * dashSpeed;
                taker->targetX = tx;
                taker->targetY = ty;
                taker->facing = std::atan2(setPiece.runUpDirY, setPiece.runUpDirX);
                // Strike-on-arrival: he's reached the ball — bring the scheduled
                // release forward to THIS tick (the compliance/release gates below
                // run after this and fire immediately). The kick therefore NEVER
                // launches with the taker still short of the ball; the countdown
                // timer survives only as the deadlock backstop.
                if (dist(taker->x, taker->y, setPiece.spotX, setPiece.spotY) <= RUNUP_STRIKE_DIST
                    && phase.actionTimer > 0.0)
                    phase.actionTimer = 0.0;
            }
        }
    }

    // Gate release on rough compliance: extend in 250ms steps (max ~1.2s;
    // penalties get longer — Law 14 is scenario-guarded to zero violations)
    // while players are still inside the restraint zone. For most restarts
    // that means OPPONENTS inside the radius; for a PENALTY the law binds
    // BOTH teams — anyone but the taker and the keepers must be out of the
    // box and the arc, so a lingering TEAMMATE must also hold the kick.
    double complianceCap = setPiece.type == SetPiece::Penalty ? -3000.0 : -1200.0;
    if (setPiece.takerArrived && phase.actionTimer <= 0 && phase.actionTimer > complianceCap && setPiece.type != SetPiece::ThrowIn) {
        if (setPiece.type == SetPiece::Penalty) {
            for (auto& p : state.players) {
                if (p.id == setPiece.takerId || p.role == Role::GK || p.sentOff) continue;
                bool inBox = std::abs(p.y - PITCH_H / 2.0) < PENALTY_AREA_H / 2.0
                          && std::abs(p.x - goalXFor(setPiece.team)) < PENALTY_AREA_W;
                bool inArc = dist(p.x, p.y, setPiece.spotX, setPiece.spotY) < 92.0;
                if (inBox || inArc) {
                    phase.actionTimer -= sdt;
                    cacheBallState();
                    return;
                }
            }
        } else {
            double minDist = minDistFor(setPiece.type);
            for (auto& p : state.players) {
                if (p.team == setPiece.team || p.role == Role::GK) continue;
                if (dist(p.x, p.y, setPiece.spotX, setPiece.spotY) < minDist * 0.72) {
                    phase.actionTimer -= sdt; // keep counting the cap down
                    cacheBallState();
                    return;
                }
            }
        }
    }
    // Round-44: the men being moved for this restart — out of the Law-13 radius, out of
    // the area, into the wall — now travel at a sprint instead of sliding there, so they
    // can still be on their way when the kick comes due. Hold while anyone was held to
    // the cap last tick, bounded so a crowd that can never comply cannot freeze the
    // match. Quick free kicks are exempt: catching the other side out is the point of
    // them. (This wait did NOT cure the interception rise measured at a x1.0 cap — see
    // RESTART_MOVE_MAX_SPEED — it is here so a kick is not struck through a wall that
    // is still forming.)
    if (setPiece.takerArrived && phase.actionTimer <= 0 && !setPiece.fast
        && phase.actionTimer > -RESTART_ARRIVAL_MAX_WAIT_MS && restartCappedLastTick > 0) {
        phase.actionTimer -= sdt;
        cacheBallState();
        return;
    }
    if (setPiece.takerArrived && phase.actionTimer <= 0) {
        for (auto& a : agents) {
            if (a->player.id == setPiece.takerId) {
                a->setPieceHold = false;
                break;
            }
        }
        Player* taker = playerById(setPiece.takerId);
        if (taker) placeTakerForRestart(*taker, true, sdt);
        enforceRestartDistance(sdt);
        state.ball.x = setPiece.spotX;
        state.ball.y = setPiece.spotY;
        state.ball.vx = state.ball.vy = state.ball.z = state.ball.vz = 0;
        setPiece.armed = false;
        setPiece.reason.clear();
        setPiece.takerId = -1;
        setPiece.takerArrived = false;
        setPiece.runUpActive = false;
        releaseSetPiece();
    } else if (!setPiece.takerArrived && phase.actionTimer <= 0) {
        if (setPiece.takerId >= 0) {
            Player* taker = playerById(setPiece.takerId);
            // Still honestly walking and nearly there? Give him another stride
            // instead of teleporting (the 1550ms goal-kick budget was short).
            // BUT cap the total wait: resetting actionTimer here used to defeat
            // its own -2500 gate forever, so a taker shoved out of the 15px
            // arrival radius by crowding teammates froze the match. The walkMs
            // backstop force-teleports after 3.5s no matter what.
            if (taker && dist(taker->x, taker->y, state.ball.x, state.ball.y) < 90.0 && setPiece.walkMs < 3500.0) {
                phase.actionTimer = 200.0;
                cacheBallState();
                return;
            }
            if (taker) {
                // Backstop force-control: make sure a still-gliding ball is
                // placed first — he must not "control" a ball rolling off-pitch.
                if (setPiece.placeBallAtMs > 0.0) {
                    state.ball.x = setPiece.spotX;
                    state.ball.y = setPiece.spotY;
                    state.ball.vx = state.ball.vy = state.ball.z = state.ball.vz = 0;
                    setPiece.placeBallAtMs = 0.0;
                }
                state.ball.controllerId = taker->id;
                state.ball.lastTouchTeam = taker->team;
                state.ball.lastToucherId = taker->id; lastRicochetMs = -1e9;   // genuine touch supersedes ricochet restart memory
                runtime[taker->id].controlStartMs = state.clockMs;   // Round-38: restart possession is fresh control — stamp for the panic-clear grace
                taker->x = state.ball.x;
                taker->y = state.ball.y;
                taker->targetX = state.ball.x;
                taker->targetY = state.ball.y;
                setPiece.takerArrived = true;
                setPiece.walkMs = 0;
                // Same GoalKick exclusion as the honest-arrival path: the budget
                // already ran out (plus the 3.5s walk backstop) — kick it now.
                if (setPiece.type != SetPiece::GoalKick) {
                    double oppGoalX = (setPiece.team == Team::Home) ? PITCH_W : 0.0;
                    phase.actionTimer = setPiece.fast ? 300.0
                        : actionTimerFor(setPiece.type, std::abs(setPiece.spotX - oppGoalX))
                              * (arenaMode ? ARENA_RESTART_SCALE : 1.0);   // Round-21 (arena audit): tighter restart pacing in the duel
                }
            }
        }
    }
    updateControlledBall(sec);
    if (setPiece.takerArrived) {
        Player* taker = playerById(setPiece.takerId);
        // A run-up FK is owned by the RUN-UP drive block above (hold-at-start,
        // then the dash) — don't yank the taker back to the generic stand-back
        // here, which would fight his approach. The ball still pins to the spot
        // until the strike, exactly as for every other held restart.
        bool fkRunUp = setPiece.type == SetPiece::FreeKick && setPiece.runUpActive;
        if (taker && !fkRunUp) placeTakerForRestart(*taker, false, sdt);
        state.ball.x = setPiece.spotX;
        state.ball.y = setPiece.spotY;
        state.ball.vx = state.ball.vy = state.ball.z = state.ball.vz = 0;
    }
    cacheBallState();
}

// ══════════════════════════════════════════════════════════════════════════════
// Action plumbing — the residue of engine_actions.cpp after its three subsystems
// moved to engine_pass_exec / engine_tackle / engine_shot: the rebound block, the
// ball-impulse census hook, and the one emitEvent every subsystem calls.
// ══════════════════════════════════════════════════════════════════════════════
void GameEngine::blockReboundFor(int playerId, double ms) {
    if (playerId < 0) return;
    runtime[playerId].duel.contestBlockedUntil = std::max(runtime[playerId].duel.contestBlockedUntil, state.clockMs + ms);
}

void GameEngine::recordBallImpulse() {
    double spd = std::hypot(state.ball.vx, state.ball.vy);
    metrics.peakBallSpeed = std::max(metrics.peakBallSpeed, spd);
    stats.recordBallSpeedSample(spd);
    // Round-19 (seed 629 0:48): a kicked ball changes VELOCITY, not position —
    // resetting prevBallX/prevBallY to the post-impulse position here (mid-tick,
    // before the jump check runs) blinded the position-continuity tripwire to a
    // 191px save-punch teleport (jumpDx computed as 0). Reset only the velocity
    // baseline; position continuity must be measured against the pre-impulse spot.
    prevBallVx = state.ball.vx;
    prevBallVy = state.ball.vy;
    prevControllerId = state.ball.controllerId;
    ballImpulseGraceTicks = 2;
}

void GameEngine::emitEvent(const std::string& type, double x, double y, int playerId, int targetId, bool traceOnly, bool ownGoal,
                           const std::string& outName, const std::string& inName) {
    VisualEvent ev{type, x, y, state.clockMs, playerId, targetId, ownGoal, outName, inName};
    traceEventQueue.push_back(ev);
    // traceOnly events (e.g. kickoff/restart markers) go to the trace log but NOT
    // the capped renderer ticker — so they can't perturb the getJSON events[] the
    // golden guard hashes, and don't spam the live ticker with restart lines.
    if (traceOnly) return;
    visualEvents.push_back(ev);
    while (visualEvents.size() > 32) visualEvents.erase(visualEvents.begin());
}

// ══════════════════════════════════════════════════════════════
// Dribble — knock-ahead logic
// ══════════════════════════════════════════════════════════════

