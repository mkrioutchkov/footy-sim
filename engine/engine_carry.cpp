// engine_carry.cpp — the ball at a carrier's feet
//
// Split out of engine_physics.cpp, whose banner ("ball physics, collision,
// collection, movement") had grown to cover four unrelated subsystems in 1739
// lines. This is the "movement" one: the half of the ball step that runs when
// state.ball.controllerId >= 0 and the ball belongs to somebody.
//
// updateControlledBall is the glue — the touch cadence (stride sawtooth), the
// leash length under pressure, and the convergence that walks the ball toward
// the carry target; it runs 2-3x per tick (see the note on engine.h's
// carry-glue bookkeeping). moveBallCarrier is the carrier's own step: his turn
// limits and the body-block sweep. nearestOpponentTo is the shared scan both of
// them need, and it lives here because those two are its only callers.

#include "engine.h"
#include "agent.h"
#include <cmath>

void GameEngine::updateControlledBall(double sec) {
    // sec = SECONDS this tick (callers pass `sec`); the intra-tick re-glue
    // calls in moveBallCarrier pass 0 — they only re-anchor the target, the
    // convergence step below is driven by the once-per-tick timed call.
    Player* c = playerById(state.ball.controllerId);
    if (!c || phase.kickoffPhase) return;
    double dx = std::cos(c->facing), dy = std::sin(c->facing);
    double speed = std::hypot(c->vx, c->vy);
    const NearestOpp no = nearestOpponentTo(*c);
    double nearestOppDist = no.dist, nearestOppX = no.x, nearestOppY = no.y;
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
        && runtime[c->id].firstTouchUntilMs > state.clockMs;
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
        // Round-34 (OWNER COMPLAINT 1, "the ball shifts a lot rapidly in front of
        // the player in possession"). The stride and the knock used to be floored
        // INDEPENDENTLY — stride halved under pressure while peak kept its own
        // floor — so peak/stride emerged at a median 0.87 with 12% at or above
        // 1.0, i.e. the ball had to travel BACKWARDS through the carrier's own
        // advance to make the geometry work. Derive the stride FROM the peak
        // instead, so the ratio is an invariant of the model rather than a
        // by-product of two floors: peak/stride > 1 becomes arithmetically
        // impossible at any speed. Close control now means smaller touches AND a
        // shorter stride, which is what the round-28 tombstone above intended.
        // Open-play peak still reaches 17px at sprint, so the tackle leash
        // (TACKLE_RANGE and the ballShownDot bonuses in agent_defend.cpp) sees the
        // same maximum ball exposure it does today.
        bool tight = nearestOppDist < 40.0;
        double peak = clamp(speed * 0.24, 5.0, 17.0);
        if (tight) peak *= 0.6;
        double stride = std::max(peak / 0.40, 6.0);
        bool touched = carryTouchTravel >= stride;
        if (touched) carryTouchTravel = 0.0;   // the next touch
        // The plan's part (B) — reshaping the knock into a rise-then-decay
        // profile over u — is DELIBERATELY NOT TAKEN. It was built, measured and
        // rejected: it re-opened the arena ball-at-rest deadlock this block's own
        // comment warns about. 4 loose-ball stalls across 33 arena matches at
        // N=3/5/7 against 0 for the parent, and in 11v11 simulation_freeze rose
        // 0.21 -> 0.75 per match at 24 paired seeds x 90 min (t=2.41). Ending
        // every stride at zero extension removes the pace the reset used to give
        // a ball that comes loose mid-carry, so it dies where it is knocked and
        // nobody commits to it — which is exactly what round-34 commit 6 (the
        // loose-ball rest-point solve) exists to fix. Part (A) above carries the
        // owner-visible win on its own: measured on the same trace it beats the
        // reshaped version on radial offset step (p90 3.20 vs 3.29px) and on
        // median world-advance ratio (0.91 vs 2.10, against a physical ideal of
        // 1.0), because the reshaped profile spent most of the stride in its
        // rise. Revisit part (B) after commit 6, not before.
        double u = carryTouchTravel / std::max(stride, 1.0);
        knockExtra = peak * (1.0 - u);
        // Round-34 census: touch cadence + how much of the carry is spent pressed.
        stats.census.carryMs += sec * 1000.0;
        if (tight) stats.census.carryTightMs += sec * 1000.0;
        if (touched) { stats.census.carryTouches++; if (tight) stats.census.carryTouchesTight++; }
    }
    // Round-28 C3: during the post-duel gather window tuck the ball to the foot
    // (no knock-ahead) so the winner's separation converges to ~CONTROL_DIST
    // (12px) rather than settling at the carry offset — the "he's got it" read.
    bool gatheringWin = c->id >= 0 && c->id < 22 && runtime[c->id].duel.carrierGatherUntilMs > state.clockMs;
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
        // Round-34 census (owner complaint 4, un-measured half): a controlled ball
        // more than 60px from its target offset is written OUTRIGHT here — a snap,
        // not a step. Count them so the next round can confirm or close it.
        if (firstTimedCallThisTick && md >= 60.0) stats.census.glueSnaps++;
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
        // Round-34 census — THE carried-ball detector CarriedBallOverspeed cannot
        // be. That tripwire fires at carrierSpeed+320 while maxStep above clamps
        // every converging tick to carrierSpeed+220, so it is blind by
        // construction to the touch-cadence class (seed 407 reports
        // carried_ball_overspeed = 0 while the ball is pinned in world space
        // between touches and then delivers the whole knock in one frame).
        // Measure the honest thing instead: how far the BALL advanced in world
        // space this tick against how far its CARRIER advanced. 1.0 is a ball
        // travelling with the man; <0.35 is frozen; <0 is a ball going backwards.
        if (c->role != Role::GK && !gatheringWin) {
            double carrierAdv = std::hypot(c->vx, c->vy) * sec;
            double bsx = state.ball.x - prevBx, bsy = state.ball.y - prevBy;
            double ballAdv = std::hypot(bsx, bsy);
            {
                int ob = (int) ballAdv;
                stats.census.carryOffsetHist[ob < 0 ? 0 : (ob > 31 ? 31 : ob)]++;
            }
            if (carrierAdv > 15.0 * sec) {
                double ratio = ballAdv / carrierAdv;
                stats.census.carryTicks++;
                if (nearestOppDist < 40.0) stats.census.carryTight++;
                if (ratio < 0.25 || ratio > 2.5) stats.census.carryAnom++;
                if (ratio < 0.35) stats.census.carryFrozen++;
                if (ratio >= 0.35 && ratio <= 2.3) stats.census.carryBand35_230++;
                if (ratio >= 0.50 && ratio <= 1.8) stats.census.carryBand50_180++;
                if (bsx * c->vx + bsy * c->vy < 0.0) stats.census.carryBackward++;
                int rb = (int) (ratio * 10.0);
                stats.census.carryRatioHist[rb < 0 ? 0 : (rb > 31 ? 31 : rb)]++;
            }
        }
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
    // (receiverShieldUntil / receiverShieldedPlayerId, set in attemptTackle, engine_tackle.cpp).
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
            if (runtime[o.id].duel.beatenSlowUntilMs > state.clockMs) continue;
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
    if (c->id >= 0 && c->id < 22 && (runtime[c->id].lungeDash.remainPx > 0.0
                                     || runtime[c->id].lungeDash.doneMs == state.clockMs)) {
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
    if (c->id >= 0 && c->id < 22 && runtime[c->id].duel.probeSlowUntilMs > state.clockMs) speed *= 0.7;
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
        const NearestOpp no = nearestOpponentTo(*c);
        double nearestOppDist = no.dist, nearestOppX = no.x, nearestOppY = no.y;
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

// Nearest opposing OUTFIELDER to a player, with his position. Both carrier-facing
// sites in this file scanned for it longhand with identical GK/own-team filters;
// a keeper carrying the ball is deliberately reported as "nobody near" (dist 1e9)
// because the callers only use this to decide how a CARRY should turn.
GameEngine::NearestOpp GameEngine::nearestOpponentTo(const Player& c) const {
    NearestOpp r;
    if (c.role == Role::GK) return r;
    for (const auto& o : state.players) {
        if (o.team == c.team || o.role == Role::GK) continue;
        double od = dist(c.x, c.y, o.x, o.y);
        if (od < r.dist) { r.dist = od; r.x = o.x; r.y = o.y; }
    }
    return r;
}
