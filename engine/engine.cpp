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
// along the row. An 11v11 red card keeps the historic -40 exactly: a body there
// is still inside some 380px search radii, so moving it is a live-gameplay
// change, and the ghost-rendering half of D9 is fixed in the renderer instead.
void GameEngine::parkOffPitch(Player& p) const {
    p.x = clamp(p.homeX + (arenaMode ? (p.id % 11) * 3.0 : 0.0), 30.0, PITCH_W - 30.0);
    p.y = arenaMode ? -400.0 : -40.0;
    p.targetX = p.x;
    p.targetY = p.y;
    p.vx = p.vy = 0;
}

// Role → role-AI factory. Single source of truth for the role-to-subclass map,
// used by both the kickoff build and the mid-match reassignAgent() swap (was the
// same switch copy-pasted in two places).
static std::unique_ptr<PlayerAI> makeAgentFor(Player& p, GameEngine& e) {
    switch (p.role) {
    case Role::GK: return std::make_unique<GKPlayerAI>(p, e);
    case Role::CF: return std::make_unique<CFPlayerAI>(p, e);
    case Role::WM: return std::make_unique<WMPlayerAI>(p, e);
    case Role::CM: return std::make_unique<CMPlayerAI>(p, e);
    case Role::CB: return std::make_unique<CBPlayerAI>(p, e);
    case Role::FB: return std::make_unique<FBPlayerAI>(p, e);
    default: return std::make_unique<PlayerAI>(p, e);
    }
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
    if (contestBlockedUntil[player.id] > state.clockMs) {
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
    contestBlockedUntil[player.id] = 0;
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
    contestBlockedUntil.fill(0);
    receiverShieldUntil = 0;
    receiverShieldedPlayerId = -1;
    receiverShieldTargetId = -1;
    pendingPass.active = false;
    activeKnockAhead.active = false;
    knockAheadCooldownUntil.fill(0);
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
    }
    // Post-goal walk-in: the formation above is now the TARGET. Send every dot
    // back to where it stood at the goal and let updateKickoffPhase stroll it to
    // the spot over the hold (snapping exactly at the end). The ball stays dead on
    // the centre spot; the taker walks up to it. Byte-identical at the tap.
    kickoffWalkActive = false;
    if (walkIn) {
        for (auto& p : state.players) {
            if (p.sentOff) continue;
            kickoffWalkTargetX[p.id] = p.targetX;
            kickoffWalkTargetY[p.id] = p.targetY;
            p.x = walkFromX[p.id];
            p.y = walkFromY[p.id];
            p.vx = p.vy = 0;
        }
        kickoffWalkActive = true;
        kickoffWalkScorerId = lastGoal.toucherId;
        kickoffWalkPresentMs = std::min(3000.0, holdMs * 0.5);   // scorer wheels away for the first ~3s
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
        double& rem = lungeDashRemainPx[p.id];
        if (rem <= 0.0) continue;
        if (p.sentOff) { rem = 0.0; lungeDashSwitchPx[p.id] = 0.0; lungeDashDir2X[p.id] = lungeDashDir2Y[p.id] = 0.0; continue; }
        // R28 C8: two-stage chop — at the switch point of a won take-on's dash,
        // cut off the shoulder-sell direction onto the goal-ward second stage
        // (agent.cpp seeds both). Single 'chop' event marks the cut for the
        // trace/viewer; speed model untouched (same ramp, same peak), so the
        // per-tick displacement stays under the carrier tripwire.
        if (lungeDashSwitchPx[p.id] > 0.0 && rem <= lungeDashSwitchPx[p.id]) {
            double n2x = lungeDashDir2X[p.id], n2y = lungeDashDir2Y[p.id];
            if (std::hypot(n2x, n2y) > 0.1) {
                lungeDashDirX[p.id] = n2x;
                lungeDashDirY[p.id] = n2y;
                p.facing = std::atan2(n2y, n2x);
                emitEvent("chop", p.x, p.y, p.id);
            }
            lungeDashSwitchPx[p.id] = 0.0;
            lungeDashDir2X[p.id] = lungeDashDir2Y[p.id] = 0.0;
        }
        // Round-23 (carrier burst realism): RAMP the pace up toward the seeded
        // peak (agent.cpp / engine_actions.cpp) at ~150px/s^2 instead of the old
        // one-tick snap to a flat 120, and DECAY it back toward the carrier's
        // dribble pace over the last stretch — a burst that accelerates and
        // settles, not an on/off block. The tackler path seeds spd=peak=
        // LUNGE_DASH_SPEED so its short committed contact step stays ~flat.
        double& spd = lungeDashSpd[p.id];
        double rampRate = 150.0 * sdt / 1000.0;
        spd = std::min(lungeDashPeak[p.id], spd + rampRate);
        if (rem < 14.0) {
            double settle = attrFactor(p.attrs.speed) * DRIBBLE_FAST_SPEED;
            spd = std::max(settle, spd - rampRate);
        }
        double step = std::min(rem, spd * sdt / 1000.0);
        p.x = clamp(p.x + lungeDashDirX[p.id] * step, 5.0, PITCH_W - 5.0);
        p.y = clamp(p.y + lungeDashDirY[p.id] * step, 5.0, PITCH_H - 5.0);
        // Truthful velocity (Round-23): the dash wrote position but never vx/vy,
        // so every velocity reader saw 0 for the whole burst. Derive the real
        // per-tick velocity from the step actually taken (mirrors the FK run-up).
        double stepSpd = step / (sdt / 1000.0);
        p.vx = lungeDashDirX[p.id] * stepSpd;
        p.vy = lungeDashDirY[p.id] * stepSpd;
        rem -= step;
        // Handoff-spike guard (Round-23): stamp the tick the dash ends so
        // moveBallCarrier doesn't add a full carry step on top of this one.
        if (rem <= 0.0) { rem = 0.0; lungeDashDoneMs[p.id] = state.clockMs; }
    }
    // OffBallOverspeed tripwire (owner: "moves stupidly fast for a split
    // second... biggest issue — also make it a quality flag"): any outfield
    // player whose ACTUAL displacement this tick exceeds every designed
    // motion (sprint ~90, lunge-dash peak ~104) is a teleport-grade blip,
    // whatever system caused it. Suppressed across restarts/kickoffs/halves
    // (legit repositioning) — those invalidate the previous-position snapshot.
    {
        bool measurable = !setPiece.armed && !phase.kickoffPhase && phase.halfTimePause <= 0
            && sdt > 1e-3;
        if (measurable && qfPrevValid) {
            double maxStep = 250.0 * sdt / 1000.0;
            // Round-23 (carrier burst): a CARRIER body stepping faster than the
            // ramped dash peak (~104px/s) is the flat-120 burst artifact the
            // off-ball 250 line (and the dead-by-construction carried-ball cap)
            // could never catch. 112 sits just above the peak.
            double carrierMaxStep = 112.0 * sdt / 1000.0;
            for (auto& p : state.players) {
                if (p.sentOff || p.role == Role::GK) continue;
                double dispStep = dist(p.x, p.y, qfPrevX[p.id], qfPrevY[p.id]);
                if (dispStep > maxStep)
                    stats.recordQualityFlag(QualityFlag::OffBallOverspeed);
                // Exempt the sanctioned DEFENDER-contact dash (engine_actions:
                // won tackle → carrier for its 11px/90ms step, seeded peak=120):
                // round-14 tuned it and the spec keeps it. The take-on carry
                // ramps to peak <=104, so it stays measured (a regression to
                // flat-120 would still trip this line).
                bool contactDash = (lungeDashRemainPx[p.id] > 0.0
                                    || lungeDashDoneMs[p.id] == state.clockMs)
                                   && lungeDashPeak[p.id] > 112.0;
                if (state.ball.controllerId == p.id && dispStep > carrierMaxStep && !contactDash)
                    stats.recordQualityFlag(QualityFlag::CarrierOverspeed);
            }
        }
        for (auto& p : state.players) { qfPrevX[p.id] = p.x; qfPrevY[p.id] = p.y; }
        qfPrevValid = measurable;
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
                        kickoffWalkTargetX[p.id] = p.targetX;
                        kickoffWalkTargetY[p.id] = p.targetY;
                        p.x = fromX[p.id];
                        p.y = fromY[p.id];
                        p.vx = p.vy = 0;
                    }
                    kickoffWalkActive = false;
                    halfTimeWalkActive = true;
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
            halfTimeWalkActive = false;
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

// Per-tick ball-carrier diagnostics for the current controller: possession clock,
// stuck / backward-carry / carry-distance / marathon-shuttle / stationary-hold
// trackers. Feeds quality stats; does not steer play.
void GameEngine::trackCarrierPossession(Player* c, double sdt) {
        if (c->team == Team::Home)
            metrics.possessionHome += sdt;
        else
            metrics.possessionAway += sdt;
        double fd = fdFor(c->team);
        if (c->id != carrierTracker.carryTrackerId) {
            carrierTracker.carryTrackerId = c->id;
            carrierTracker.carryLastX = c->x;
            carrierTracker.carryLastY = c->y;
            carrierTracker.carryPathDistance = 0;
            carrierTracker.carryStartMs = state.clockMs;
            carrierTracker.carryStartX = c->x;
            carrierTracker.carryStartFacing = c->facing;
            carrierTracker.carryRevsY = 0;
            carrierTracker.carryLastDirY = 0;
            carrierTracker.carryPivotY = c->y;
            carrierTracker.marathonRecorded = false;
            carrierTracker.shuttleRecorded = false;
            carrierTracker.marathonReleased = false;
        } else {
            double step = dist(c->x, c->y, carrierTracker.carryLastX, carrierTracker.carryLastY);
            if (step < 45.0) carrierTracker.carryPathDistance += step;
            // Lateral shuttle: count amplitude-qualified y reversals — the
            // "dribbled side to side for ages" pattern. Per-tick sign flips are
            // dominated by steering jitter and undercount macro swings (they
            // never reached 3 in a full match), so this uses hysteresis peak
            // detection: a swing must retrace >= SHUTTLE_AMP px from its extreme
            // before it counts as a reversal in the opposite direction.
            constexpr double SHUTTLE_AMP = 45.0;
            double y = c->y;
            int dir = carrierTracker.carryLastDirY;
            double& pivot = carrierTracker.carryPivotY;
            if (dir > 0) {
                if (y > pivot)
                    pivot = y;
                else if (pivot - y >= SHUTTLE_AMP) {
                    carrierTracker.carryRevsY++;
                    dir = -1;
                    pivot = y;
                }
            } else if (dir < 0) {
                if (y < pivot)
                    pivot = y;
                else if (y - pivot >= SHUTTLE_AMP) {
                    carrierTracker.carryRevsY++;
                    dir = 1;
                    pivot = y;
                }
            } else {
                if (y - pivot >= SHUTTLE_AMP) {
                    dir = 1;
                    pivot = y;
                } else if (pivot - y >= SHUTTLE_AMP) {
                    dir = -1;
                    pivot = y;
                }
            }
            carrierTracker.carryLastDirY = dir;
            carrierTracker.carryLastX = c->x;
            carrierTracker.carryLastY = c->y;
            double carryMs = state.clockMs - carrierTracker.carryStartMs;
            if (!carrierTracker.marathonRecorded && carryMs >= 8000.0 && c->role != Role::GK) {
                carrierTracker.marathonRecorded = true;
                stats.recordMarathonCarry();
            }
            if (!carrierTracker.shuttleRecorded && carryMs >= 6000.0 && carrierTracker.carryRevsY >= 3 && c->role != Role::GK) {
                carrierTracker.shuttleRecorded = true;
                stats.recordShuttleCarry();
            }
            stats.noteLongestCarry(carryMs);
        }
        if (c->id != carrierTracker.backwardCarryCarrierId) {
            carrierTracker.backwardCarryCarrierId = c->id;
            carrierTracker.backwardCarryStartX = c->x;
            carrierTracker.backwardCarryRecorded = false;
        } else {
            // Measure regression from the carry's HIGH-WATER mark, not possession
            // start: a carrier who advanced 65px then gave back 106px netted only
            // -41 from his start point and never tripped the -70 backward-carry
            // dampers (watched replay seed 129 0:17-0:24 — a 7s corner-pocket
            // retreat with backwardCarry reading -28). Riding the max keeps the
            // dampers (and the longBackwardCarries stat) honest.
            if ((c->x - carrierTracker.backwardCarryStartX) * fd > 0.0)
                carrierTracker.backwardCarryStartX = c->x;
            if (!carrierTracker.backwardCarryRecorded && (c->x - carrierTracker.backwardCarryStartX) * fd < -200.0) {
                stats.recordLongBackwardCarry();
                carrierTracker.backwardCarryRecorded = true;
            }
        }
        double carrierSpeed = std::hypot(c->vx, c->vy);
        double targetDistance = dist(c->x, c->y, c->targetX, c->targetY);
        bool stationaryOutfieldHold = !setPiece.armed && !phase.kickoffPhase && c->role != Role::GK && carrierSpeed < 8.0 && (targetDistance < 8.0 || c->dribbleType == 0);
        if (c->id != carrierTracker.stationaryHoldCarrierId || !stationaryOutfieldHold) {
            carrierTracker.stationaryHoldCarrierId = stationaryOutfieldHold ? c->id : -1;
            carrierTracker.stationaryHoldMs = 0;
            carrierTracker.stationaryHoldRecorded = false;
        } else if (!carrierTracker.stationaryHoldRecorded) {
            carrierTracker.stationaryHoldMs += sdt;
            if (carrierTracker.stationaryHoldMs >= 420.0) {
                carrierTracker.stationaryHoldRecorded = true;
                // Round-29: NEAREST teammate is not a graded ball — route this
                // exit through the shared pass grader; below the floor, the
                // dribble nudge is the honest escape (an unpressured stationary
                // carrier must never gift a low-grade pass).
                Player* best = bestGradedReceiver(*c, 360.0, 0.2);
                if (best) {
                    forcePassTo(*c, *best, nullptr);
                } else {
                    double side = c->y < PITCH_H / 2.0 ? 1.0 : -1.0;
                    c->dribbleType = 2;
                    c->targetX = clamp(c->x + fd * 70.0, 35.0, PITCH_W - 35.0);
                    c->targetY = clamp(c->y + side * 42.0, 35.0, PITCH_H - 35.0);
                }
            }
        }
        // ── Moving-marathon release ── Score-nudging the carrier's Dribble does
        // NOT end these carries (A/B: marathonCarries went UP, goals down) — the
        // carrier holds precisely because no pass out-scored dribbling. So when an
        // uninterrupted outfield carry has run long WITHOUT net forward progress
        // (the "dribbled non stop from one side to the other" shuttle), physically
        // hand it to the best OPEN supporting teammate. Guarded: fires only when
        // such an open, in-range option exists, so we never gift possession into a
        // covered pass — if the carrier is truly boxed in, the carry stands.
        if (!setPiece.armed && !phase.kickoffPhase && c->role != Role::GK && !carrierTracker.marathonReleased) {
            double carryDurMs = state.clockMs - carrierTracker.carryStartMs;
            double carryFwd = (c->x - carrierTracker.carryStartX) * fd;
            // Spare final-third carries: shots are built there, and forcing a
            // release cost ~22% of shots. The shuttle we're killing is the
            // midfield/own-half "side to side" hold, not the final ball.
            double distToOppGoal = pitch::distToOppGoal(c->x, c->team);
            // 5.2s, was 7.0s: the carry-duration histogram had a spike at
            // exactly 6.8-7.2s — ~15 carries per watched match visibly riding
            // this watchdog (census, seed 129). With the safe-outlet receiver
            // pick below the forced release now reads as an ordinary escape
            // ball, so it can come when a real player would play it.
            if (carryDurMs >= 5200.0 && carryFwd < 80.0 && distToOppGoal > 340.0) {
                // The forced release is the SAFE out-ball, not a mortar: the old
                // pick weighted forwardness double openness with no lane check,
                // so it chipped 145° over its shoulder into a triple-blocked lane
                // the pass scorer had vetoed that same tick (watched replay seed
                // 129 0:24.5 — the owner's "the pass attempted was just weird",
                // intercepted 0.15s after release) while the free CB behind
                // ranked LAST by construction. Safety-first scoring (same formula
                // as the pressured-circling release below), a lane check, and a
                // facing-compatible preference make the backstop ball look like a
                // player's choice; fixes upstream should make it rarely fire.
                // Graded lane read: hard-skip only a near-certain deflection
                // (a body within ~20px of the flight line); nearby traffic
                // costs score. A hard 30px skip left the watchdog with NO
                // candidate in crowded midfield, the release never fired, and
                // marathon carries ROSE (7-11/match vs baseline 3-6).
                // The rules relax as the carry drags on: at first only a clean
                // safe outlet is accepted (a real player's ball); past ~6.5s any
                // honest escape beats carrying forever (a hard candidate filter
                // here left the release unfired in crowded midfield and marathon
                // carries ROSE).
                bool desperate = carryDurMs >= 6500.0;
                double hardPerp = desperate ? 14.0 : 20.0;
                double coverMin = desperate ? 45.0 : 55.0;
                auto laneCost = [&](const Player& o) {
                    double dx = o.x - c->x, dy = o.y - c->y, ls = dx * dx + dy * dy;
                    if (ls < 1.0) return 1e9;
                    double cost = 0.0;
                    for (auto& q : state.players) {
                        if (q.team == c->team || q.role == Role::GK || q.sentOff) continue;
                        double t2 = clamp(((q.x - c->x) * dx + (q.y - c->y) * dy) / ls, 0.0, 1.0);
                        if (t2 * std::sqrt(ls) < 40.0) continue;   // the on-boot presser blocks every lane equally
                        double perp = std::hypot(q.x - c->x - t2 * dx, q.y - c->y - t2 * dy);
                        if (perp < hardPerp) return 1e9;           // ball into a body — the scorer already refused this
                        if (perp < 40.0) cost += (40.0 - perp) * 2.5;
                    }
                    return cost;
                };
                Player* best = nullptr;
                double bestScore = -1e9;
                for (auto& o : state.players) {
                    if (o.team != c->team || o.id == c->id || o.role == Role::GK || o.sentOff) continue;
                    double d = dist(c->x, c->y, o.x, o.y);
                    if (d < PASS_MIN_DISTANCE || d > 380.0) continue; // realistic pass range
                    double oppD = 1e9;                   // receiver's nearest marker
                    for (auto& q : state.players)
                        if (q.team != c->team && q.role != Role::GK && !q.sentOff)
                            oppD = std::min(oppD, dist(o.x, o.y, q.x, q.y));
                    if (oppD < coverMin) continue;                 // covered — not a safe release
                    double lc = laneCost(o);
                    if (lc > 1e8) continue;                        // certain deflection
                    if (gradePass(*c, o) < 0.2) continue;          // round-29: shared grade floor on every exit path
                    double score = oppD - lc - std::abs((o.x - c->x) * fd) * 0.15; // safest open man, near before far
                    double wantAng = std::atan2(o.y - c->y, o.x - c->x);
                    double offF = std::abs(std::atan2(std::sin(wantAng - c->facing), std::cos(wantAng - c->facing)));
                    if (offF > 2.0) score -= 40.0;                 // prefer a ball he can play without a no-look spin
                    if (score > bestScore) {
                        bestScore = score;
                        best = &o;
                    }
                }
                if (best) {
                    c->facing = std::atan2(best->y - c->y, best->x - c->x);   // square up with the release, not a no-looker
                    forcePassTo(*c, *best, nullptr);
                    carrierTracker.marathonReleased = true;
                } else if (desperate) {
                    // Round-29: no receiver clears the grade floor and the carry
                    // has dragged past 6.5s — clear to space rather than either
                    // gifting a graded-refused ball or carrying forever (the
                    // unfired-release tombstone above).
                    hoofClearToSpace(*c);
                    carrierTracker.marathonReleased = true;
                }
            }
            // ── Pressured-circling release ── the 7s/final-third guard above misses
            // the commonest lost-possession shuttle: a carrier SWARMED (2+ markers,
            // one touch-tight) in the attacking half but OUTSIDE the box, circling
            // 2.6s+ with no forward progress while a WIDE-open team-mate stands free —
            // dispossessed ~100% of the time (watched replay seed 105 0:16 was 14.6s
            // of it). Release to the safest wide-open man. TIGHT gates (2 markers incl.
            // one <32px, a confirmed side-to-side shuttle, the 200-340 band, a receiver
            // 90px+ clear) — deliberately NOT the looser long-hold variant that raised
            // giveaways. Reuses the proven forcePassTo one-shot.
            if (!carrierTracker.marathonReleased && carryDurMs >= 2600.0 && carryFwd < 40.0
                && carrierTracker.carryRevsY >= 1 && distToOppGoal > 200.0 && distToOppGoal < 340.0) {
                int tightMarkers = 0;
                double nearestOpp = 1e9;
                for (auto& q : state.players) {
                    if (q.team == c->team || q.role == Role::GK || q.sentOff) continue;
                    double qd = dist(c->x, c->y, q.x, q.y);
                    if (qd < 55.0) tightMarkers++;
                    nearestOpp = std::min(nearestOpp, qd);
                }
                if (tightMarkers >= 2 && nearestOpp < 32.0) {
                    // Round-29 (owner 0:18 — THE headline): this pick had NO lane
                    // check — "wide-open" measured only the receiver's marker
                    // distance, so it forced a ball the pass scorer had graded
                    // −0.89 that same tick, straight down a covered lane
                    // (interceptor 24px off the line, INTCPT comp=0). Route it
                    // through the shared grader; if nobody clears the floor,
                    // CLEAR — a throw-in conceded ≫ a gifted interception.
                    Player* best = nullptr;
                    double bestScore = -1e9;
                    for (auto& o : state.players) {
                        if (o.team != c->team || o.id == c->id || o.role == Role::GK || o.sentOff) continue;
                        double od = dist(c->x, c->y, o.x, o.y);
                        if (od < 90.0 || od > 380.0) continue;
                        double oppD = 1e9;
                        for (auto& q : state.players)
                            if (q.team != c->team && q.role != Role::GK && !q.sentOff)
                                oppD = std::min(oppD, dist(o.x, o.y, q.x, q.y));
                        if (oppD < 90.0) continue;                 // WIDE-open only
                        if (gradePass(*c, o) < 0.2) continue;      // shared grade floor
                        double score = oppD - std::abs((o.x - c->x) * fd) * 0.15; // safest, not most forward
                        if (score > bestScore) { bestScore = score; best = &o; }
                    }
                    if (best) {
                        forcePassTo(*c, *best, nullptr);
                        carrierTracker.marathonReleased = true;
                    } else {
                        hoofClearToSpace(*c);
                        carrierTracker.marathonReleased = true;
                    }
                }
            }
        }
}

void GameEngine::updatePossessionTracking(double sdt) {
    auto* c = playerById(state.ball.controllerId);
    // Detect a live turnover (control flips teams in open play) -> open the
    // quick-transition window. Suppressed during set-piece restarts.
    if (c && !setPiece.armed) {
        if (transitionHadCtrl && c->team != transitionLastCtrlTeam)
            transitionUntilMs = state.clockMs + 400.0;
        transitionLastCtrlTeam = c->team;
        transitionHadCtrl = true;
    }
    if (c) trackCarrierPossession(c, sdt);
    else {
        if (activeKnockAhead.active && activeKnockAhead.playerId >= 0) {
            Player* runner = playerById(activeKnockAhead.playerId);
            if (runner) {
                if (carrierTracker.carryTrackerId != runner->id) {
                    carrierTracker.carryTrackerId = runner->id;
                    carrierTracker.carryLastX = runner->x;
                    carrierTracker.carryLastY = runner->y;
                    carrierTracker.carryPathDistance = 0;
                } else {
                    double step = dist(runner->x, runner->y, carrierTracker.carryLastX, carrierTracker.carryLastY);
                    if (step < 45.0) carrierTracker.carryPathDistance += step;
                    carrierTracker.carryLastX = runner->x;
                    carrierTracker.carryLastY = runner->y;
                }
            }
        } else {
            carrierTracker.carryTrackerId = -1;
            carrierTracker.carryPathDistance = 0;
        }
        carrierTracker.backwardCarryCarrierId = -1;
        carrierTracker.backwardCarryRecorded = false;
        carrierTracker.stationaryHoldCarrierId = -1;
        carrierTracker.stationaryHoldMs = 0;
        carrierTracker.stationaryHoldRecorded = false;
    }
    // Line-too-deep sampler (user: "defensive lines drop a bit too deep
    // sometimes when they shouldn't"): once a second per team — flag when the
    // back line sits inside 110px of its own goal while the ball is far away
    // (>450px from that goal) and no attacker is even near the line depth.
    if (state.clockMs >= lineDepthNextMs && !setPiece.armed && !phase.kickoffPhase) {
        lineDepthNextMs = state.clockMs + 1000.0;
        for (int t = 0; t < 2; t++) {
            Team team = t == 0 ? Team::Home : Team::Away;
            double line = 1e9;
            for (auto& p : state.players)
                if (p.team == team && !p.sentOff && roles::isDefenderRole(p.role))
                    line = std::min(line, pitch::distToOwnGoal(p.x, team));
            if (line > 110.0) continue;
            if (pitch::distToOwnGoal(state.ball.x, team) < 450.0) continue;
            bool threatDeep = false;
            for (auto& p : state.players)
                if (p.team != team && p.role != Role::GK && !p.sentOff && pitch::distToOwnGoal(p.x, team) < line + 60.0) {
                    threatDeep = true;
                    break;
                }
            if (!threatDeep) stats.recordLineTooDeep();
        }
    }
    stats.recordPossession(metrics.possessionHome, metrics.possessionAway);
    auditStuckCarrier(sdt);
    auditBlobPurposes();
}

// Knot counting is ALWAYS on (summary blobMoments — the crowding ticket's
// summary-level target metric; 15-min traces are too noisy at n=3).
// FOOTY_BLOBDEBUG=1 additionally stderr-logs each knot with every member's
// role/team/last action/purpose/target (attribution).
void GameEngine::auditBlobPurposes() {
    static const bool on = [] { const char* e = std::getenv("FOOTY_BLOBDEBUG"); return e && e[0] == '1'; }();
    if (setPiece.armed || phase.kickoffPhase) return;
    if (state.clockMs < blobLogNextMs) return;
    for (auto& seed : state.players) {
        if (seed.sentOff) continue;
        int n = 0;
        for (auto& q : state.players)
            if (!q.sentOff && dist(q.x, q.y, seed.x, seed.y) < 50.0) n++;
        if (n < 6) continue;
        blobLogNextMs = state.clockMs + 1500.0;
        stats.recordBlobMoment();
        if (!on) return;
        std::fprintf(stderr, "BLOB %.0fms @(%.0f,%.0f) ball=(%.0f,%.0f,ctrl=%d):",
                     state.clockMs, seed.x, seed.y, state.ball.x, state.ball.y, state.ball.controllerId);
        for (auto& q : state.players) {
            if (q.sentOff || dist(q.x, q.y, seed.x, seed.y) >= 50.0) continue;
            PlayerAI* a = agentFor(q);
            // pur=task alone can't be acted on — append WHICH DefensiveTask
            // (press/screen/cover/...) so the attribution names a lever.
            const auto* asn = assignmentFor(q.id);
            std::fprintf(stderr, " #%d[%s%s act=%d pur=%s%s%s tgt=(%.0f,%.0f)]",
                         q.id, std::string(to_string(q.role)).c_str(), q.team == Team::Home ? "H" : "A",
                         static_cast<int>(a->lastAction()), std::string(to_string(a->lastActionPurpose())).c_str(),
                         asn ? ":" : "", asn ? std::string(to_string(asn->role)).c_str() : "",
                         q.targetX, q.targetY);
        }
        std::fprintf(stderr, "\n");
        return;
    }
}

void GameEngine::detectSimulationFreeze(double sdt) {
    if (setPiece.armed || phase.kickoffPhase) return;
    auto& fb = state.ball;
    int cid = fb.controllerId;
    // A keeper holding for distribution keeps a stationary ball legitimately; his
    // hold is bounded by the GK distribution cap (GK_MAX_HOLD_MS → forced punt),
    // not by this freeze watchdog. Watching him here only fired a false-positive
    // "freeze" ~1.5s in and nudged him forward with the ball — a keeper wandering
    // upfield. Skip GK carriers; the distribution logic owns his release.
    {
        Player* cctrl = cid >= 0 ? playerById(cid) : nullptr;
        if (cctrl && cctrl->role == Role::GK) {
            freezeDetector.freezeWatchMs = 0;
            freezeDetector.freezeBallX = fb.x;
            freezeDetector.freezeBallY = fb.y;
            freezeDetector.freezeLastController = cid;
            return;
        }
    }
    if (cid < 0) {
        // A LOOSE ball can come to rest uncollected — nobody is assigned to chase
        // it (e.g. it rolls dead into a corner). It then sits there forever: the
        // controlled-carrier watcher below only runs while a player HOLDS the ball,
        // so it never sees this. A dead ball in a final third also starves the
        // half-end whistle (which needs !inFinalThird), hanging the match to the
        // +5:00 hard cap. Watch a stationary loose ball and, after
        // LOOSE_BALL_STALL_MS, give it to the nearest player so play restarts.
        double bs = std::hypot(fb.vx, fb.vy);
        // Nearest player to the loose ball right now (deterministic: min dist, tie -> lower id).
        Player* best = nullptr;
        double bestD = 1e9;
        for (auto& p : state.players) {
            if (p.sentOff) continue;
            double d = dist(fb.x, fb.y, p.x, p.y);
            if (d < bestD) {
                bestD = d;
                best = &p;
            }
        }
        bool wasLoose = freezeDetector.freezeLastController == -1; // loose last tick too
        bool travelling = bs >= LOOSE_BALL_STALL_SPEED || dist(fb.x, fb.y, freezeDetector.freezeBallX, freezeDetector.freezeBallY) >= 5.0;
        // A ball a player is CLOSING IN ON is not stuck — it's about to be collected.
        // Only a ball nobody has moved toward for the whole window is genuinely
        // abandoned. Re-arm whenever the nearest player gets >5px closer than the
        // baseline set when the watch armed.
        bool someoneClosing = wasLoose && bestD < freezeDetector.looseNearestD - 5.0;
        if (!wasLoose || travelling || someoneClosing) {
            freezeDetector.freezeWatchMs = 0;
            freezeDetector.freezeBallX = fb.x;
            freezeDetector.freezeBallY = fb.y;
            freezeDetector.looseNearestD = bestD;
        } else {
            freezeDetector.freezeWatchMs += sdt;
            if (freezeDetector.freezeWatchMs > LOOSE_BALL_STALL_MS && best && state.clockMs - freezeDetector.lastFreezeAlertMs > 5000) {
                stats.recordSimulationFreeze();
                double rdx = best->x - fb.x, rdy = best->y - fb.y, rd = std::hypot(rdx, rdy);
                if (rd < 20.0) {
                    // Already at his feet — a genuine pickup.
                    fb.controllerId = best->id;
                    fb.vx = fb.vy = fb.vz = 0.0;
                    fb.z = 0.0;
                    fb.curl = 0.0;
                    fb.lastTouchTeam = best->team;
                    fb.lastToucherId = best->id; lastRicochetMs = -1e9;   // genuine touch supersedes ricochet restart memory
                    fb.intendedReceiverId = -1;
                    lastLooseOrigin = LooseOrigin::None;
                } else {
                    // ROLL the abandoned ball to him — assigning control from range
                    // teleported it up to ~150px to his feet in one tick (watched
                    // replay seed 133 1:28). A bounded nudge-roll reads as the ball
                    // wobbling back into life; he collects it naturally on arrival,
                    // and the 5s re-arm re-rolls if it under-reaches.
                    double rs = clamp(rd * 0.9, 120.0, 260.0);
                    driveBall(fb, rdx, rdy, rd, rs);
                    fb.vz = 0.0;
                    fb.z = 0.0;
                    fb.curl = 0.0;
                }
                freezeDetector.lastFreezeAlertMs = state.clockMs;
                freezeDetector.freezeWatchMs = 0;
            }
        }
        freezeDetector.freezeLastController = -1;
    } else if (cid != freezeDetector.freezeLastController) {
        freezeDetector.freezeWatchMs = 0;
        freezeDetector.freezeBallX = fb.x;
        freezeDetector.freezeBallY = fb.y;
        freezeDetector.freezeLastController = cid;
    } else {
        freezeDetector.freezeWatchMs += sdt;
        Player* movingCarrier = playerById(cid);
        if (movingCarrier && std::hypot(movingCarrier->vx, movingCarrier->vy) > 12.0) {
            freezeDetector.freezeWatchMs = 0;
            freezeDetector.freezeBallX = fb.x;
            freezeDetector.freezeBallY = fb.y;
            return;
        }
        if (dist(fb.x, fb.y, freezeDetector.freezeBallX, freezeDetector.freezeBallY) >= 5) {
            freezeDetector.freezeWatchMs = 0;
            freezeDetector.freezeBallX = fb.x;
            freezeDetector.freezeBallY = fb.y;
        } else if (freezeDetector.freezeWatchMs > 1500 && state.clockMs - freezeDetector.lastFreezeAlertMs > 5000) {
            Player* frozen = playerById(cid);
            Player* best = nullptr;
            if (frozen && frozen->role != Role::GK)
                // Round-29: graded receiver, not nearest — below the floor the
                // nudge branch below un-freezes him without gifting a bad ball.
                best = bestGradedReceiver(*frozen, 380.0, 0.2);
            if (frozen && best) {
                stats.recordSimulationFreeze();
                forcePassTo(*frozen, *best, nullptr);
            } else if (frozen) {
                stats.recordSimulationFreeze();
                double fd = fdFor(frozen->team);
                frozen->targetX = clamp(frozen->x + fd * 90.0, 35.0, PITCH_W - 35.0);
                frozen->targetY = clamp(frozen->y + (frozen->y < PITCH_H / 2 ? -45.0 : 45.0), 35.0, PITCH_H - 35.0);
            } else {
                freezeDetector.simulationFreezes++;
                stats.recordSimulationFreeze();
            }
            freezeDetector.lastFreezeAlertMs = state.clockMs;
            freezeDetector.freezeWatchMs = 0;
            freezeDetector.freezeBallX = fb.x;
            freezeDetector.freezeBallY = fb.y;
        }
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

    auto placeTakerForRestart = [&](Player& taker, bool releaseSpot) {
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
    };
    auto enforceRestartDistance = [&]() {
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
    };

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
    enforceRestartDistance();

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
    if (setPiece.takerArrived && phase.actionTimer <= 0) {
        for (auto& a : agents) {
            if (a->player.id == setPiece.takerId) {
                a->setPieceHold = false;
                break;
            }
        }
        Player* taker = playerById(setPiece.takerId);
        if (taker) placeTakerForRestart(*taker, true);
        enforceRestartDistance();
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
        if (taker && !fkRunUp) placeTakerForRestart(*taker, false);
        state.ball.x = setPiece.spotX;
        state.ball.y = setPiece.spotY;
        state.ball.vx = state.ball.vy = state.ball.z = state.ball.vz = 0;
    }
    cacheBallState();
}

// Round-30: the half-time interval. Exactly the post-goal walk-in motion model
// (lerp-to-arrive over the remaining break + the sin() micro-idle sway + facing
// along the walk vector), re-aimed at the H2 formation spots captured when the
// pause was armed. No rng, no decisions, no ball physics — the players stroll to
// their restart positions and stand there. kickoff() snaps them onto the exact
// spots when the break ends, so the H2 tap is the same staging as any other.
void GameEngine::halfTimeWalk(double sdt) {
    if (!halfTimeWalkActive) return;
    double sec = sdt / 1000.0;
    double remainMs = std::max(sdt, phase.halfTimePause);
    double frac = clamp(sdt / remainMs, 0.0, 1.0);
    for (auto& p : state.players) {
        if (p.sentOff) continue;
        double dx = kickoffWalkTargetX[p.id] - p.x, dy = kickoffWalkTargetY[p.id] - p.y;
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
    if (kickoffWalkActive && phase.actionTimer > 0.0) {
        double sec = sdt / 1000.0;
        double remainMs = std::max(sdt, phase.actionTimer);
        // lerp-to-arrive: close this fraction of the REMAINING distance each tick.
        // With the whole hold ahead the early steps are a few px (never a slide),
        // easing to zero as the dot settles onto its spot exactly at the snap.
        double frac = clamp(sdt / remainMs, 0.0, 1.0);
        double elapsed = state.clockMs - phase.lastKickoffMs;
        for (auto& p : state.players) {
            if (p.sentOff) continue;
            double dx = kickoffWalkTargetX[p.id] - p.x, dy = kickoffWalkTargetY[p.id] - p.y;
            double stepX = dx * frac, stepY = dy * frac;
            // Micro idle: a tiny deterministic sway (no rng) so a dot that has
            // reached its spot breathes rather than freezing dead.
            double idle = std::sin((state.clockMs + p.id * 211.0) * 0.005) * 0.6 * sec * 60.0;
            p.x += stepX;
            p.y += stepY + idle;
            p.vx = stepX / std::max(sec, 1e-6);
            p.vy = stepY / std::max(sec, 1e-6);
            // The scorer WHEELS AWAY to celebrate — face the nearest corner for the
            // presentation window; everyone else faces their walk direction.
            if (p.id == kickoffWalkScorerId && elapsed < kickoffWalkPresentMs) {
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
        if (kickoffWalkActive) {
            for (auto& p : state.players) {
                if (p.sentOff) continue;
                p.x = kickoffWalkTargetX[p.id];
                p.y = kickoffWalkTargetY[p.id];
                p.vx = p.vy = 0;
            }
            kickoffWalkActive = false;
        }
        phase.kickoffPhase = false;
        kickoffTap();
    }
    cacheBallState();
}

void GameEngine::updateOpenPlayPhase(double sdt, double sec) {
    sampleVelocityOrigins();
    auto& b = state.ball;
    if (b.controllerId >= 0) contestBlockedUntil[b.controllerId] = 0;
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
    // Render-only facing smoothing (display copy; logic uses raw Player::facing).
    // Exponential low-pass of facing: a high-frequency ~30deg left-right shimmer
    // averages toward its centre (smooth), while a genuine sustained turn still
    // tracks within a few ticks. alpha 0.18 ~ 90ms settle — imperceptible lag, but
    // it kills the watched-match jitter. Logic is untouched -> gameplay identical.
    if (!renderFacingInit) {
        for (auto& p : state.players) renderFacing[p.id] = p.facing;
        renderFacingInit = true;
    } else {
        for (auto& p : state.players) {
            double dF = std::atan2(std::sin(p.facing - renderFacing[p.id]), std::cos(p.facing - renderFacing[p.id]));
            renderFacing[p.id] = std::atan2(std::sin(renderFacing[p.id] + dF * 0.18), std::cos(renderFacing[p.id] + dF * 0.18));
        }
    }
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

void GameEngine::auditStuckCarrier(double sdt) {
    // A held restart is SUPPOSED to be stationary — the taker stands at the spot
    // for the whole set-piece/kickoff hold (now seconds long under the restart-
    // pacing pass). Watching him here force-passed every corner/free-kick taker
    // ~2.7s into his hold (~50 false stuck-alerts per match). Same guard the
    // freeze detector has always had.
    if (setPiece.armed || phase.kickoffPhase || phase.halfTimePause > 0) {
        carrierTracker.watchedCarrierId = -1;
        carrierTracker.watchedCarrierMs = 0;
        return;
    }
    Player* carrier = playerById(state.ball.controllerId);
    // A keeper standing on the ball is NOT a stuck carrier — holding for
    // distribution is legitimate (legal up to 6s) and is now self-capped by the
    // GK distribution logic (initial delay + GK_MAX_HOLD_MS, then a forced punt).
    // Watching him here only produced a false-positive force-pass ~2.7s in, which
    // raced — and beat — his own hold cap. This watchdog is for OUTFIELD carriers
    // who genuinely wedge; leave the keeper to his distribution logic.
    if (carrier && carrier->role == Role::GK) {
        carrierTracker.watchedCarrierId = -1;
        carrierTracker.watchedCarrierMs = 0;
        return;
    }
    if (!carrier) {
        carrierTracker.watchedCarrierId = -1;
        carrierTracker.watchedCarrierMs = 0;
        return;
    }
    if (carrier->id != carrierTracker.watchedCarrierId) {
        carrierTracker.watchedCarrierId = carrier->id;
        carrierTracker.watchedCarrierX = carrier->x;
        carrierTracker.watchedCarrierY = carrier->y;
        carrierTracker.watchedCarrierMs = 0;
        return;
    }
    carrierTracker.watchedCarrierMs += sdt;
    double moved = dist(carrier->x, carrier->y, carrierTracker.watchedCarrierX, carrierTracker.watchedCarrierY);
    double carrierSpeed = std::hypot(carrier->vx, carrier->vy);
    if (carrierSpeed > 12.0) {
        carrierTracker.watchedCarrierX = carrier->x;
        carrierTracker.watchedCarrierY = carrier->y;
        carrierTracker.watchedCarrierMs = 0;
        return;
    }
    if (moved > STUCK_CARRIER_MOVE_THRESHOLD) {
        carrierTracker.watchedCarrierX = carrier->x;
        carrierTracker.watchedCarrierY = carrier->y;
        carrierTracker.watchedCarrierMs = 0;
        return;
    }
    double fd = fdFor(carrier->team);
    double forwardProgress = (carrier->x - carrierTracker.watchedCarrierX) * fd;
    if (forwardProgress > 30.0) {
        carrierTracker.watchedCarrierX = carrier->x;
        carrierTracker.watchedCarrierY = carrier->y;
        carrierTracker.watchedCarrierMs = 0;
        return;
    }
    if (carrierTracker.watchedCarrierMs > STUCK_CARRIER_TIMEOUT_MS * 0.65) {
        stats.recordStuckCarrier();
        // Round-29: graded receiver, not nearest (bestGradedReceiver skips
        // sent-off men — the round-21 phantom-target guard holds); when nobody
        // clears the floor the forward hoof below is the honest escape.
        Player* best = bestGradedReceiver(*carrier, 400.0, 0.2);
        if (best)
            forcePassTo(*carrier, *best, nullptr);
        else
            hoofClearToSpace(*carrier);
        setPiece.armed = false;
        setPiece.type = SetPiece::None;
        setPiece.team = Team::Home;
        setPiece.reason.clear();
        carrierTracker.watchedCarrierMs = 0;
        carrierTracker.watchedCarrierX = carrier->x;
        carrierTracker.watchedCarrierY = carrier->y;
    }
}

// ══════════════════════════════════════════════════════════════
// JSON serialization
// ══════════════════════════════════════════════════════════════

std::string GameEngine::getSummaryJSON() const {
    return stats.summaryJSON();
}

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

    j["ball"] = {
        {"x", std::round(b.x * 10) / 10}, {"y", std::round(b.y * 10) / 10}, {"vx", std::round(b.vx * 10) / 10}, {"vy", std::round(b.vy * 10) / 10}, {"z", std::round(b.z * 10) / 10}, {"curl", std::round(b.curl * 1000) / 1000}, {"cutback", pendingPass.active && pendingPass.isCutback}, {"controllerId", b.controllerId >= 0 ? nlohmann::json(b.controllerId) : nlohmann::json(nullptr)}, {"intendedReceiverId", b.intendedReceiverId >= 0 ? nlohmann::json(b.intendedReceiverId) : nlohmann::json(nullptr)}, {"lastTouchTeam", std::string(to_string(b.lastTouchTeam))}, {"lastToucherId", b.lastToucherId >= 0 ? nlohmann::json(b.lastToucherId) : nlohmann::json(nullptr)}};

    j["players"] = nlohmann::json::array();
    for (auto& p : state.players) {
        j["players"].push_back({{"id", p.id}, {"name", p.name}, {"team", std::string(to_string(p.team))}, {"role", std::string(to_string(p.role))}, {"x", std::round(p.x * 10) / 10}, {"y", std::round(p.y * 10) / 10}, {"vx", std::round(p.vx * 10) / 10}, {"vy", std::round(p.vy * 10) / 10}, {"targetX", std::round(p.targetX * 10) / 10}, {"targetY", std::round(p.targetY * 10) / 10}, {"stamina", std::round(p.stamina)}, {"facing", std::round(renderFacing[p.id] * 1000) / 1000}, {"dribbleType", p.dribbleType}, {"tackleAnim", std::round(p.tackleAnim)}, {"headingAnim", std::round(p.headingAnim)}, {"diveAnim", std::round(p.diveAnim)}, {"wall", p.wall}, {"slide", p.tackleAnim > 400.0}, {"goals", pStats[p.id].goals}, {"assists", pStats[p.id].assists}, {"shots", pStats[p.id].shots}, {"tackles", pStats[p.id].tackles}, {"yellow", yellowCards[p.id]}, {"passes", pStats[p.id].passes}, {"passesCompleted", pStats[p.id].passesCompleted}, {"injured", p.injurySeverity > 0.05}, {"sentOff", p.sentOff}});
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
        j["events"].push_back({{"type", ev.type},
                               {"x", std::round(ev.x * 10) / 10},
                               {"y", std::round(ev.y * 10) / 10},
                               {"age", std::round(age)},
                               {"playerId", ev.playerId >= 0 ? nlohmann::json(ev.playerId) : nlohmann::json(nullptr)},
                               {"targetId", ev.targetId >= 0 ? nlohmann::json(ev.targetId) : nlohmann::json(nullptr)},
                               {"ownGoal", ev.ownGoal}});
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

// ══════════════════════════════════════════════════════════════
// Lifecycle — constructor, initWithSeed, createHomeTeam, createAwayTeam
// ══════════════════════════════════════════════════════════════

GameEngine::~GameEngine() = default;

GameEngine::GameEngine() {
    blackboards[0] = TeamBlackboard();
    blackboards[1] = TeamBlackboard();
}

void GameEngine::initWithSeed(int seed) {
    // One-shot guard: GameEngine is ONE-MATCH-PER-INSTANCE. A second call would
    // append to state.players again (no clear), reallocating the vector and
    // dangling every Player& the agents hold. Make a re-init a safe no-op.
    if (initialized_) return;
    initialized_ = true;
    rng.setSeed(seed);
    if (!configOverride) {
        // No tactics supplied: random "manager" personalities (legend exhibition).
        auto manager = [&]() {
            return Config{40 + rng.random() * 40, 30 + rng.random() * 40, 25 + rng.random() * 60,
                          30 + rng.random() * 55, 25 + rng.random() * 55};
        };
        baseConfig[0] = manager();
        baseConfig[1] = manager();
    }
    // The 23-random advances vary the legends' ±4 form between sides; a
    // data-driven roster has exact attrs (no form roll), so skip them there.
    if (!homeRoster.active)
        for (int i = 0; i < 23; i++) rng.random();
    createHomeTeam();
    if (!awayRoster.active)
        for (int i = 0; i < 23; i++) rng.random();
    createAwayTeam();
    for (auto& p : state.players) {
        if (p.id >= 0 && p.id < 22) playerLookup[p.id] = &p;
    }
    initBench();
    // §arena: park everyone except the GKs (0/11) and N outfielders per side
    // off-pitch, sent-off style, so the whole engine — press assignment, pass
    // menus, set pieces, offside — sees a legitimate small-sided match. No red
    // cards recorded, no subs (an ejected slot can't be replaced anyway, and
    // there is nobody on the pitch worth swapping).
    if (arenaMode) {
        // Round-30 (arena generality): an N-AWARE SHAPE. The round-21 table kept
        // attacking slots first ({9}, {9,5}, {9,5,8}) and every one of their
        // 4-3-3 anchors sits in the TOP half (y=340/170/81.6), so no arena
        // outfielder was ever a defender, the bottom half of the pitch was empty
        // at kickoff, and the offside line was drawn by a midfielder loitering on
        // halfway (3v3 measured ~44 offsides/90 against 11v11's ~4).
        //
        // Instead: keep a DEFENDER first, then a central mid, then the forward,
        // then width — growing in slot PAIRS that are already symmetric about
        // y=PITCH_H/2 (CB 2/3, CM 5/7, FB 1/4, WM 8/10) so every size fields a
        // real small-sided shape with both halves of the pitch occupied.
        //   1: 0-0-1   2: 1-0-1   3: 2-0-1   4: 2-1-1   5: 2-2-1
        //   6: 2-3-1   7: 2-4-1   8: 4-3-1   9: 4-4-1  10: 4-3-3 (full XI)
        // Slot 9 (the CF) is in every row — a match spec's star directives are
        // written against it. N=1 is deliberately UNCHANGED: the same anchor move
        // at 1v1 measured strictly WORSE (fouls 6.0->13.1, corners 0.8->9.0), the
        // lone man having nobody to defend with.
        static constexpr int ARENA_KEEP[ARENA_MAX_OUTFIELDERS][ARENA_MAX_OUTFIELDERS] = {
            {  9, -1, -1, -1, -1, -1, -1, -1, -1, -1},  //  1v1: CF
            {  3,  9, -1, -1, -1, -1, -1, -1, -1, -1},  //  2v2: CB + CF
            {  2,  3,  9, -1, -1, -1, -1, -1, -1, -1},  //  3v3: CB CB + CF
            {  2,  3,  6,  9, -1, -1, -1, -1, -1, -1},  //  4v4: + central CM
            {  2,  3,  5,  7,  9, -1, -1, -1, -1, -1},  //  5v5: CB CB, CM CM, CF
            {  2,  3,  5,  6,  7,  9, -1, -1, -1, -1},  //  6v6: + central CM
            {  2,  3,  5,  7,  8, 10,  9, -1, -1, -1},  //  7v7: + a winger pair
            {  1,  2,  3,  4,  5,  6,  7,  9, -1, -1},  //  8v8: back four, CM x3
            {  1,  2,  3,  4,  5,  7,  8, 10,  9, -1},  //  9v9: back four, CM x2 + wingers
            {  1,  2,  3,  4,  5,  6,  7,  8,  9, 10},  // 10v10: the full XI (4-3-3)
        };
        int n = clamp(arenaOutfielders, 1, ARENA_MAX_OUTFIELDERS);
        auto kept = [&](int id) {
            if (id == 0 || id == 11) return true;               // GKs always play
            for (int k = 0; k < n; ++k) {
                int slot = ARENA_KEEP[n - 1][k];
                if (slot >= 0 && (id == slot || id == slot + 11)) return true;
            }
            return false;
        };
        for (auto& p : state.players) {
            if (kept(p.id)) {
                // A LONE centre-back (the 2v2 row) owns the whole width, so his
                // 4-3-3 half-space anchor would leave one flank permanently open.
                // Re-centre him. Every other row keeps a symmetric pair, whose
                // default anchors already balance about the centre line.
                if (n == 2 && (p.id == 3 || p.id == 14))
                    p.homeY = p.y = p.targetY = PITCH_H / 2.0;
                continue;
            }
            p.sentOff = true;
            parkOffPitch(p);
        }
        subsRemaining = {0, 0};
    }
    lastReceiveFrom.fill(-1);
    for (auto& p : state.players) {
        agents.push_back(makeAgentFor(p, *this));
    }
    // §weather v2 WIND: derive the per-match wind vector from a SEPARATE seed-stream so the MAIN rng
    // (hence the whole clear-vs-wind in-match sim) stays byte-identical — only the airborne drift
    // differs (a clean paired comparison). Gated weather==2 so clear/rain never draw it, keeping the
    // default game byte-identical + the live-replay determinism invariant intact.
    // INIT-COUPLING: weather is set BEFORE initWithSeed (main.cpp), so the vector is derived once here;
    // a FUTURE live mid-match weather->wind flip must re-derive it (else windX/windY stay 0 = a silent
    // no-op wind). There is no such command today — weather is init-only. [adversarial-review flag]
    if (weather == 2) {
        SeededRNG wrng;
        wrng.setSeed(static_cast<uint32_t>(seed) ^ 0x57494e44u); // "WIND"
        double ang = wrng.random() * 6.283185307179586;          // 0..2pi
        double mag = WIND_ACCEL_BASE + wrng.random() * WIND_ACCEL_RANGE;
        windX = std::cos(ang) * mag;
        windY = std::sin(ang) * mag;
    }
}

void GameEngine::creditGoal(int scorerId) {
    if (scorerId < 0 || scorerId >= 22) return;
    pStats[scorerId].goals++;
    // Set-piece goal bucket: scored within 9s of a restart release. FKs are
    // split direct-threat vs deep by nothing here — the release type is enough
    // for the "where do goals come from" audit.
    if (state.clockMs - lastRestartReleaseMs < 9000.0)
        stats.recordSetPieceGoal(lastRestartReleaseType);
    else
        stats.recordOpenPlayGoal();
    // Assist: the teammate who last fed the scorer, within ~12s of the goal.
    int passer = lastReceiveFrom[scorerId];
    if (passer >= 0 && passer < 22 && passer != scorerId && state.clockMs - lastReceiveMs[scorerId] < 12000.0) {
        Player* sc = playerById(scorerId);
        Player* as = playerById(passer);
        if (sc && as && sc->team == as->team) {
            pStats[passer].assists++;
            emitEvent("assist", as->x, as->y, passer, scorerId);
        }
    }
}

void GameEngine::initBench() {
    // Reserve identities. Round-30: a reserve is now a NAMED squad player with the
    // SHAPE of the legend he is named after, put through the same elite compression
    // the starting legends get (legendAttrsFor's cz) and then a notch below —
    // instead of seven flat random rolls in bands that could hand a tiring Messi's
    // shirt to a reserve with BETTER attributes than the man he replaced. The seven
    // rng draws per reserve are kept, in the same order, and re-used as a small
    // per-attribute form jitter, so the stream POSITION is unchanged; only the
    // values move (and only once a substitution actually happens).
    struct Reserve { const char* name; PlayerAttributes attrs; };
    // {speed, passing, creativity, shooting, tackling, positioning, stamina}
    static const Reserve homeRes[8] = {
        {"Pirlo",     {58, 96, 92, 74, 50, 86, 78}},
        {"Casillas",  {56, 58, 52, 30, 42, 90, 72}},
        {"Maldini",   {74, 76, 62, 48, 92, 92, 84}},
        {"Zidane",    {72, 92, 96, 80, 58, 84, 82}},
        {"Carlos",    {88, 74, 76, 82, 70, 70, 86}},
        {"Puyol",     {72, 66, 52, 46, 92, 88, 88}},
        {"Kaka",      {86, 84, 88, 82, 44, 76, 82}},
        {"Villa",     {82, 78, 82, 88, 40, 74, 82}},
    };
    static const Reserve awayRes[8] = {
        {"Cannavaro", {74, 70, 56, 40, 90, 90, 84}},
        {"Vidic",     {68, 64, 48, 52, 92, 86, 84}},
        {"Pirlo",     {58, 96, 92, 74, 50, 86, 78}},
        {"Toure",     {76, 80, 74, 70, 84, 82, 88}},
        {"Sneijder",  {68, 90, 90, 82, 52, 80, 80}},
        {"Silva",     {70, 92, 92, 72, 46, 80, 80}},
        {"Aguero",    {86, 78, 86, 90, 38, 74, 80}},
        {"Ferdinand", {74, 74, 58, 44, 88, 90, 82}},
    };
    // Same compression legendAttrsFor applies to the starting XI, then x0.97: a
    // squad player, directly comparable to the man he comes on for.
    auto squad = [](double v) { return clamp(63.0 + (v - 63.0) * 0.28, 38.0, 80.0) * 0.97; };
    for (int t = 0; t < 2; ++t) {
        bench[t].clear();
        for (int i = 0; i < 7; ++i) {
            const Reserve& r = (t == 0) ? homeRes[i % 8] : awayRes[i % 8];
            auto roll = [&](double base) { return squad(base) * (0.96 + rng.random() * 0.08); };
            PlayerAttributes a;
            a.speed = roll(r.attrs.speed);
            a.passing = roll(r.attrs.passing);
            a.creativity = roll(r.attrs.creativity);
            a.shooting = roll(r.attrs.shooting);
            a.tackling = roll(r.attrs.tackling);
            a.positioning = roll(r.attrs.positioning);
            a.stamina = roll(r.attrs.stamina);
            // Derived, no extra draw — matches mkPlayer, and stops a substitute
            // inheriting the flat 50 defaults for the aerial duel.
            a.handling = a.positioning;
            a.height = a.positioning;
            bench[t].push_back({r.name, a, false});
        }
    }
    subsRemaining = {5, 5};
    nextSubCheckMs = 0;
    nextSubWindowMs = {0.0, 0.0};
}

void GameEngine::sendOff(Player& p) {
    // §arena: never eject the duelists — with 9 team-mates already parked,
    // every foul is a "last man" foul and the first tackle of the match drew
    // a straight red, leaving GK-vs-attacker for the remaining 9 minutes.
    // Fouls and yellows still happen; the ejection is the mode-breaking part.
    if (arenaMode) return;
    p.sentOff = true;
    stats.recordRedCard();
    // Park him off the pitch by his own touchline — the slot stays in the
    // array (lookups depend on it) but he's out of play and out of the way.
    if (state.ball.controllerId == p.id) {
        state.ball.controllerId = -1;
        state.ball.intendedReceiverId = -1;
        lastLooseOrigin = LooseOrigin::None;
    }
    parkOffPitch(p);
    p.injurySeverity = 0.0;
    assignmentByPlayer[p.id] = {};
}

void GameEngine::substituteSlot(Player& slot, BenchPlayer& in) {
    in.used = true;
    // Round-30: emit BEFORE the slot is overwritten. The event used to be raised
    // after slot.name had already become the incoming player's, so every consumer
    // that resolves the name from engine state at emit time named the man coming
    // ON in a toast that reads "... off". (The live JSON stream serialises events
    // and players from the same tick, so the shipping renderer still needs a
    // payload/renderer-side change to say both names — noted, not done here.)
    stats.recordSubstitution();
    emitEvent("sub", slot.x, slot.y, slot.id);
    char prefix = slot.team == Team::Home ? 'H' : 'A';
    slot.name = std::format("{}{} {}", prefix, slot.id, in.name);
    slot.attrs = in.attrs;
    slot.stamina = 100.0; // fresh legs
    slot.injurySeverity = 0.0;
    slot.needsReplacement = false;   // the latched knock leaves with him
    slot.sentOff = false;
    yellowCards[slot.id] = 0;
}

void GameEngine::updateSubstitutions() {
    // Manager check on a coarse cadence (deterministic — clock-driven). A team
    // brings someone on for an injured player immediately, or for a spent one
    // in the closing stretch, while subs remain.
    // §arena: no bench in an exhibition — the spare slots are parked off-pitch,
    // there is nobody to legally replace, and a swap would resurrect a ghost.
    if (arenaMode) return;
    if (state.clockMs < nextSubCheckMs) return;
    // Substitutions happen at STOPPAGES, and they cost time (owner: "added
    // time... should be a real thing - so substitutions should take actual
    // time"). The swap waits for a dead ball, visibly extends the hold, and
    // credits the board the ~20s a real change burns. Round-30: the cadence
    // advance used to sit ABOVE this gate, so every open-play tick ate the 8s
    // window and a short set piece could fall clean between two checks.
    if (!setPiece.armed && !phase.kickoffPhase) return;
    nextSubCheckMs = state.clockMs + 8000.0;
    // Round-30 manager window. The old test was `p.stamina < 32 && minute > 58`:
    // 32 sits BELOW the drain floor (STAMINA_MATCH_FLOOR + staminaSkill*12 = 50-62),
    // whole-match minimum measured at 82.4 over 44 player-matches, so it was
    // unreachable — and an absolute minute-58 would never fire in a short
    // exhibition match either. Score freshness SQUAD-RELATIVE instead (this
    // commit changes no STAMINA_* constant and no physics), and scale the window
    // off matchDurationMs exactly as the added-time board already does: changes
    // open at two-thirds time and recur on a ~9-minute-at-90 cadence.
    const double subsOpenMs  = matchDurationMs * (60.0 / 90.0);
    const double subWindowMs = matchDurationMs * 0.09;
    for (int t = 0; t < 2; ++t) {
        if (subsRemaining[t] <= 0) continue;
        Team team = static_cast<Team>(t);
        bool windowOpen = state.clockMs >= subsOpenMs && state.clockMs >= nextSubWindowMs[t];
        Player* worst = nullptr;
        double worstScore = -1e9;
        bool injuredFound = false;
        for (auto& p : state.players) {
            if (p.team != team || p.role == Role::GK || p.sentOff) continue;
            if (p.id == state.ball.controllerId) continue; // never swap a man mid-carry
            // Latched: injurySeverity decays at 1/90 per second, so a 0.30 knock
            // was gone in ~11s and the old `> 0.18` test almost never saw it.
            bool injured = p.needsReplacement;
            if (!injured && !windowOpen) continue;
            double score = (injured ? 1000.0 + p.injurySeverity * 100.0 : 0.0) + (100.0 - p.stamina);
            if (score > worstScore) {
                worstScore = score;
                worst = &p;
                injuredFound = injured;
            }
        }
        if (!worst) continue;
        // Pick the freshest unused bench player.
        BenchPlayer* best = nullptr;
        double bestRating = -1.0;
        for (auto& b : bench[t]) {
            if (b.used) continue;
            double r = b.attrs.speed + b.attrs.passing + b.attrs.tackling + b.attrs.positioning;
            if (r > bestRating) {
                bestRating = r;
                best = &b;
            }
        }
        if (!best) continue;
        // A tired-but-not-injured change is the manager's call: one roll per
        // window, then the window closes either way so a side cannot empty its
        // bench at the hour. Measured: ~4 windows a side over the closing third,
        // so 0.57 lands the match at 5 changes (target band 4-6) — the rate was
        // trimmed here rather than anywhere near the fatigue model.
        if (!injuredFound) {
            nextSubWindowMs[t] = state.clockMs + subWindowMs;
            if (rng.random() > 0.57) continue;
        }
        substituteSlot(*worst, *best);
        subsRemaining[t]--;
        // The change burns real time: extend the current hold so the swap is
        // visible, and credit the board the rest of the ~20s a real sub takes.
        if (setPiece.armed) phase.actionTimer += 2500.0;
        phase.stoppageMs += 15000.0;
    }
}

void GameEngine::equalizeAttributes(int val) {
    attrsEqualized = true;   // Round-21 (arena audit): flag the equalized regime for the summary JSON
    for (auto& p : state.players) {
        p.attrs.speed = val;
        p.attrs.passing = val;
        p.attrs.shooting = val;
        p.attrs.tackling = val;
        p.attrs.positioning = val;
        p.attrs.creativity = val;
        p.attrs.stamina = val;
        p.attrs.handling = val; // (mkPlayer derives these from positioning; equalize must set all 9)
        p.attrs.height = val;
    }
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
    // (engine_physics.cpp:395, 0.5 positioning + 0.5 height) actually bites: tall CBs / target-men
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

// Default 4-3-3 slot roles + home anchors (engine frame). When a spec carries a
// formation layout (RosterOverride::hasLayout) these are overridden per slot;
// otherwise they reproduce the original hardcoded literals exactly (so the
// no-layout / default match stays byte-identical). Slot 0 is ALWAYS the GK on
// the goal line — a bad spec can't field a keeperless side.
namespace {
constexpr Role DEF_ROLES[11] = {Role::GK, Role::FB, Role::CB, Role::CB, Role::FB, Role::CM, Role::CM, Role::CM, Role::WM, Role::CF, Role::WM};
constexpr double DEF_HX_HOME[11] = {31.5, 157.5, 189, 189, 157.5, 420, 420, 420, 441, 756, 441};
constexpr double DEF_HX_AWAY[11] = {1018.5, 892.5, 861, 861, 892.5, 630, 630, 630, 609, 294, 609};
constexpr double DEF_HY[11] = {340, 81.6, 226.6667, 453.3333, 598.4, 170, 340, 510, 81.6, 340, 598.4};
} // namespace
void GameEngine::buildTeam(Team team, const RosterOverride& ro, const double* defHX) {
    int off = team == Team::Home ? 0 : 11;
    bool L = ro.hasLayout;
    for (int i = 0; i < 11; ++i) {
        // slot 0 forced to GK on its default line; others read the layout when present
        Role r = (L && i > 0) ? ro.roles[i] : DEF_ROLES[i];
        double hx = (L && i > 0 && ro.homeX[i] > 0.0) ? ro.homeX[i] : defHX[i];
        double hy = (L && i > 0 && ro.homeY[i] > 0.0) ? ro.homeY[i] : DEF_HY[i];
        state.players.push_back(mkPlayer(off + i, team, r, hx, hy));
        state.players.back().moraleBoost = ro.moraleBoost[i]; // 0 by default => no effect
    }
}
void GameEngine::createHomeTeam() {
    buildTeam(Team::Home, homeRoster, DEF_HX_HOME);
}
void GameEngine::createAwayTeam() {
    buildTeam(Team::Away, awayRoster, DEF_HX_AWAY);
}

// Mid-match role change (a formation shout): set the player's role and swap in a
// fresh role-AI for the new role. Same factory as the kickoff setup; the engine
// re-fetches agents[id] every tick (never caches), so the swap is safe in-tick.
void GameEngine::reassignAgent(Player& p, Role r) {
    if (p.id < 0 || p.id >= (int) agents.size()) return;
    p.role = r;
    agents[p.id] = makeAgentFor(p, *this);
}
