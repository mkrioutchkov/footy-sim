#include "engine.h"
#include "agent.h"
#include "agent_helpers.h"

void PlayerAI::applyMovement(double sdt) {
    auto& p = player;
    if (isGoalkeeper()) return;
    if (setPieceHold) return;

    double secs = sdt / 1000.0;
    double spd = std::sqrt(p.vx * p.vx + p.vy * p.vy);

    double staminaSkill = attrFactor(p.attrs.stamina);
    // Drain scales with sprint intensity (quadratic): cruising just above
    // jogging pace costs little, flat-out sprinting costs full price. A
    // binary threshold either emptied midfielders in minutes or never tired
    // anyone, depending on where it sat relative to their cruise speed.
    double sprintFrac = clamp((spd - SPEED_SPRINT * 0.55) / (SPEED_SPRINT * 0.45), 0.0, 1.0);
    if (sprintFrac > 0.0)
        p.stamina = std::max(0.0, p.stamina - STAMINA_DRAIN_SPRINT * sprintFrac * sprintFrac * (1.12 - staminaSkill * 0.35));
    else if (spd >= 26.0) {
        // Match fatigue (FATIGUE_FINDING redesign): a WORKING player tires toward a FLOOR — busier = faster
        // toward it — and NEVER crashes below it, so SPEED dynamics stay dormant (floor > the 0.35 threshold)
        // and only the continuous decision gates bite. (The old sprint-only drain pinned everyone ~99; an
        // un-floored movement drain crashed the busiest player below 35 while others stayed fresh.)
        double fitFloor = STAMINA_MATCH_FLOOR + staminaSkill * 12.0;   // 50..62: a fitter player floors higher
        double work = 0.35 + sprintFrac;                              // 0.35 cruising -> 1.35 flat-out
        p.stamina = std::max(fitFloor, p.stamina - STAMINA_DRAIN_MOVE * work * (1.12 - staminaSkill * 0.35));
    } else
        p.stamina = std::min(100.0, p.stamina + STAMINA_RECOVER * (0.80 + staminaSkill * 0.45));

    double slowThreshold = STAMINA_SLOW_THRESHOLD * 100.0;
    double fatigueFloor = 0.54 + staminaSkill * 0.20;
    double sf = 1.0;
    if (p.stamina < slowThreshold) {
        double fatigueBlend = clamp(p.stamina / std::max(1.0, slowThreshold), 0.0, 1.0);
        sf = lerp(fatigueFloor, 1.0, fatigueBlend);
    }
    // A knock costs pace and fades over ~90s of match time.
    if (p.injurySeverity > 0.0) {
        sf *= clamp(1.0 - p.injurySeverity * 0.5, 0.45, 1.0);
        p.injurySeverity = std::max(0.0, p.injurySeverity - secs / 90.0);
    }
    // Morale shades effort/pace a little and decays toward neutral over ~4 min.
    // Default 0 = no effect (golden-safe). Driven by pre-match morale + shouts later.
    if (p.moraleBoost != 0.0) {
        sf *= clamp(1.0 + p.moraleBoost * 0.12, 0.88, 1.10);
        double dec = secs / 240.0;
        p.moraleBoost = p.moraleBoost > 0.0 ? std::max(0.0, p.moraleBoost - dec)
                                            : std::min(0.0, p.moraleBoost + dec);
    }

    double dx = p.targetX - p.x, dy = p.targetY - p.y;
    double d = std::sqrt(dx * dx + dy * dy);

    // Target hysteresis: when two decision branches argue at 60Hz, a player
    // vibrates in place (~730 episodes/90min measured). A target that
    // REVERSES the current commitment is only accepted every 300ms; forward
    // refinements pass through freely. Ball-near play is exempt — reactions
    // there must be instant.
    {
        double now = engine.state.clockMs;
        double bdq = dist(p.x, p.y, engine.state.ball.x, engine.state.ball.y);
        bool exempt = engine.state.ball.controllerId == p.id
            || engine.state.ball.intendedReceiverId == p.id
            || engine.isActiveKnockAheadRunner(p.id) || bdq < 60.0;
        if (!exempt && d > 6.0) {
            double comDx = commitTargetX - p.x, comDy = commitTargetY - p.y;
            double comD = std::hypot(comDx, comDy);
            // A heading change of more than ~73deg off the held commit is a
            // whipsaw, not a refinement; off-ball CMs were pirouetting on
            // sub-84deg hops the old <0.1 (=84deg) test let through.
            bool reversal = comD > 6.0 && (dx * comDx + dy * comDy) / (d * comD) < 0.3;
            if (reversal && now < commitUntilMs) {
                p.targetX = commitTargetX; p.targetY = commitTargetY;
                dx = comDx; dy = comDy; d = comD;
            } else if (reversal) {
                // Accept the new heading and HOLD it: don't let the commit
                // anchor ratchet around the circle on every accepted frame.
                commitTargetX = p.targetX; commitTargetY = p.targetY;
                commitUntilMs = now + 260.0;
            } else if (now >= commitUntilMs) {
                // Forward refinement with no active hold: track freely.
                commitTargetX = p.targetX; commitTargetY = p.targetY;
            }
            // else: forward refinement during an active hold — keep the held anchor.
        } else {
            commitTargetX = p.targetX; commitTargetY = p.targetY;
            commitUntilMs = now;
        }
    }

    auto* lastTask = engine.assignmentFor(p.id);
    bool pressTask      = (lastActionType == ActionType::Position && lastPurpose == ActionPurpose::Task && lastTask && lastTask->role == DefensiveTask::PrimaryPress);
    bool secondaryPress = (lastActionType == ActionType::Position && lastPurpose == ActionPurpose::Task && lastTask && lastTask->role == DefensiveTask::SecondaryPress);
    bool activeKnockAheadRunner = engine.isActiveKnockAheadRunner(p.id);
    bool committedChase = activeKnockAheadRunner
                       || (lastActionType == ActionType::Chase && engine.state.ball.controllerId < 0)
                       || (lastActionType == ActionType::Chase && lastPurpose == ActionPurpose::Receive)
                       || (lastActionType == ActionType::Chase && lastPurpose == ActionPurpose::RecoverOwnTouch)
                       || (lastActionType == ActionType::Chase && lastPurpose == ActionPurpose::RecoverLoose);

    double bdx = engine.state.ball.x - p.x, bdy = engine.state.ball.y - p.y;
    double bd  = std::sqrt(bdx * bdx + bdy * bdy);

    bool carrierCornered = (engine.state.ball.x < 80.0 || engine.state.ball.x > PITCH_W - 80.0)
                        && (engine.state.ball.y < 80.0 || engine.state.ball.y > PITCH_H - 80.0);
    bool predatorial = (pressTask || secondaryPress) && carrierCornered;

    bool committedPress = (pressTask && bd > 45.0 && (bd < PRESS_COMMIT_MAX_DIST || pitch::inDangerZone(engine.state.ball.x, p.team)))
                        || predatorial;

    // A dead ball is never "observed": during a hold the choreography (box
    // crowd, wall, build-up spread) IS the job, and the crawl multiplier meant
    // a CB sent forward for a corner covered ~250 of 440px in a 10s hold — the
    // box stayed empty however good the targets were (seed 133 0:40).
    bool isObserving = !committedChase && !committedPress && bd > 300.0 && bd > PLAYER_AWARE_RANGE * 0.5
                    && !engine.setPiece.armed;

    // Defenders sprint when carrier is in their half
    bool defendSprint = false;
    if (isDefenderLike() && !isObserving) {
        auto* task = engine.assignmentFor(p.id);
        if (task && task->role == DefensiveTask::CloseDown) defendSprint = true;
        else if (task && (task->role == DefensiveTask::LaneBlock || task->role == DefensiveTask::BoxGuard || task->role == DefensiveTask::FarPostGuard
            || task->role == DefensiveTask::NearPostGuard
            || task->role == DefensiveTask::CutbackGuard
            || task->role == DefensiveTask::ShotLane
            || task->role == DefensiveTask::CrossLane
            || task->role == DefensiveTask::MidfieldScreen || task->role == DefensiveTask::BoxScreen || task->role == DefensiveTask::DefensiveLine
            || task->role == DefensiveTask::WideCover)) {
            Player* carrier = engine.state.ball.controllerId >= 0 ? engine.playerById(engine.state.ball.controllerId) : nullptr;
            double tdist = dist(p.x, p.y, task->targetX, task->targetY);
            if (carrier && carrier->team != p.team && pitch::distToOwnGoal(carrier->x, p.team) < PITCH_W * 0.45 && tdist > 32.0) {
                defendSprint = true;
            }
        }
        else if (engine.state.ball.controllerId >= 0) {
            Player* carrier = engine.playerById(engine.state.ball.controllerId);
            if (carrier && carrier->team != p.team && bd < 200.0) defendSprint = true;
        }
    }
    // E1 (user-visible live-watch standout: attackers JOG back on a turnover, leaving a 0v1
    // breakaway). The sprint gate above is DEFENDERS-ONLY, so a CF/WM ambles back at jog pace
    // while the defenders bust a gut. Extend the recovery sprint to attackers when an OPPONENT
    // controls the ball nearby — they hustle back into shape instead of strolling. (defendSprint
    // just lifts the speed cap to SPEED_SPRINT below; pure state, no rng.)
    if (!defendSprint && !isObserving && (isCenterForward() || isWideMidfielder())) {
        Player* oppCarrier = engine.state.ball.controllerId >= 0 ? engine.playerById(engine.state.ball.controllerId) : nullptr;
        if (oppCarrier && oppCarrier->team != p.team && bd < 180.0) defendSprint = true;
    }

    double cruiseMul = isObserving
        ? observingCruiseMul()
        : 1.0;

    Player* carrier = engine.state.ball.controllerId >= 0 ? engine.playerById(engine.state.ball.controllerId) : nullptr;
    if (carrier && carrier->team == p.team && carrier->id != p.id
        && engine.state.ball.intendedReceiverId != p.id
        && lastActionType != ActionType::Chase) {
        double cdx = p.x - carrier->x, cdy = p.y - carrier->y;
        double cd = std::sqrt(cdx * cdx + cdy * cdy);
        if (cd > 0.1 && cd < SUPPORT_CARRIER_CLEAR_DIST) {
            double away = (SUPPORT_CARRIER_CLEAR_DIST - cd) / SUPPORT_CARRIER_CLEAR_DIST;
            double fd = fdFor(p.team);
            double laneBias = p.homeY < PITCH_H / 2.0 ? -1.0 : 1.0;
            dx += (cdx / cd) * away * SUPPORT_CARRIER_PUSH_FORCE + fd * away * SUPPORT_CARRIER_FORWARD_BIAS;
            dy += (cdy / cd) * away * SUPPORT_CARRIER_PUSH_FORCE + laneBias * away * SUPPORT_CARRIER_LANE_BIAS;
            d = std::sqrt(dx * dx + dy * dy);
        }
    }

    // USERWATCH A2 (~4:04): a player pursuing a WINNABLE loose ball must FULL-SPRINT, not cruise
    // onto a chance. Ball loose + within contesting range + actually moving toward it => commit to
    // the sprint (and drop the distance-damping below) — hustle for the 50/50, don't amble.
    // High-value ONLY (USERWATCH: "winnable AND high-value — a clear chance"): the loose ball is
    // near a goal — an attacking chance to pounce on, or a defensive emergency to beat the striker
    // to. Midfield 50/50s stay at normal pursuit pace (this isn't a blanket sprint-everywhere).
    bool looseBallHighValue = pitch::distToOppGoal(engine.state.ball.x, p.team) < 300.0
                           || pitch::distToOwnGoal(engine.state.ball.x, p.team) < 300.0;
    bool pursuingLooseBall = engine.state.ball.controllerId < 0 && looseBallHighValue
        && bd < 230.0 && (dx * bdx + dy * bdy) > 0.0;
    // Attacking the delivery (mirror of E1's sprint-back): a runner whose chosen
    // position is in the opponent's box while HIS OWN team's carrier is wide /
    // advanced in the final third must BURST there — real cutback and low-cross
    // runs arrive WITH the ball. At jog pace + the approach damping below, the
    // CF was measured arriving ~50px late on every pull-back (pos tgd median
    // 197 vs his own target 149 at release) — the box was empty on 81% of
    // cutbacks, which is why the shot mix had 2% close-range chances.
    bool boxBurst = false;
    if (!defendSprint && !committedChase && !committedPress
        && lastActionType == ActionType::Position
        && (lastPurpose == ActionPurpose::InsideRun || lastPurpose == ActionPurpose::RunAhead
            || lastPurpose == ActionPurpose::Offer || lastPurpose == ActionPurpose::Space)
        && (isCenterForward() || isWideMidfielder() || isCentralMidfielder())) {
        double oppGoalX = goalXFor(p.team);
        bool targetAttacksBox = std::abs(p.targetX - oppGoalX) < 210.0
            && std::abs(p.targetY - PITCH_H / 2.0) < 200.0;
        if (targetAttacksBox && carrier && carrier->team == p.team && carrier->id != p.id
            && std::abs(carrier->x - oppGoalX) < 330.0) {
            boxBurst = true;
        }
    }
    // A chosen TACKLE is committed pursuit: at SPEED_RUN with the approach
    // damping below, a presser 40px behind a dribbling carrier moved at ~1/3
    // run pace — precisely the carrier's dribble speed — and rode his back at
    // the collision radius indefinitely (watched replay: 23px for 10 straight
    // seconds, zero challenges). You don't amble into a challenge.
    // Scoped to the CLOSING BURST (d<90): an unbounded sprint-while-Tackle-chosen
    // kept every jockeying defender in permanent sprint, and the stamina bleed
    // showed up as a late-match defensive collapse (30-min A/B: shots +24%,
    // goals +40% — both flat at 10 min).
    bool committedTackle = lastActionType == ActionType::Tackle && engine.state.ball.controllerId >= 0
        && d < 90.0;
    double baseSpeed = (activeKnockAheadRunner || p.dribbleType == 3)
        ? DRIBBLE_FAST_SPEED
        : (lastActionType == ActionType::Chase || committedPress || committedTackle || defendSprint || pursuingLooseBall || boxBurst ? SPEED_SPRINT : SPEED_RUN);

    // Shielding: slow down when near opponents with ball
    bool isController = (engine.state.ball.controllerId == p.id);
    if (isController && bd < 60.0) {
        baseSpeed *= 0.80; // 20% slower when shielding
    }

    double df = (committedChase || committedPress || committedTackle || defendSprint || pursuingLooseBall || boxBurst) ? 1.0 : std::min(d / 120.0, 1.5);
    double ms = attrFactor(p.attrs.speed) * baseSpeed * sf * df * cruiseMul;

    double px = p.x, py = p.y;
    if (d > 1.0) {
        double step = std::min(ms * secs, d);
        p.x += (dx / d) * step;
        p.y += (dy / d) * step;
    }

    if (secs > 0.001) {
        p.vx = (p.x - px) / secs;
        p.vy = (p.y - py) / secs;
    }

    double bAngle = std::atan2(engine.state.ball.y - p.y, engine.state.ball.x - p.x);
    double bDiff  = std::abs(bAngle - facing);
    double bNorm  = (bDiff > PI) ? 2.0 * PI - bDiff : bDiff;
    // Within ~5m the ball is heard/sensed regardless of facing — purely
    // vision-gated memory had players guarding a 3s-old ghost position while
    // the real ball rolled away at their back.
    if (bNorm < PI / 3.0 || bd < 56.0) {
        ballMemoryX = engine.state.ball.x;
        ballMemoryY = engine.state.ball.y;
        ballMemoryAge = 0;
    } else {
        ballMemoryAge++;
    }

    double spdAfter = std::sqrt(p.vx * p.vx + p.vy * p.vy);
    bool ic = (engine.state.ball.controllerId == p.id);
    if (ic) {
        // Find nearest opponent for shielding
        double nearOppDist = 1e9;
        double nearOppX = 0, nearOppY = 0;
        for (auto& o : engine.state.players) {
            if (o.team != p.team && o.role != Role::GK && !o.sentOff) {
                double d = dist(p.x, p.y, o.x, o.y);
                if (d < nearOppDist) { nearOppDist = d; nearOppX = o.x; nearOppY = o.y; }
            }
        }

        if (nearOppDist < 68.0) {
            // Face the ball side away from pressure; the speed turn cap below prevents snap-spins.
            double awayAngle = std::atan2(p.y - nearOppY, p.x - nearOppX);
            double pressure = clamp((68.0 - nearOppDist) / 68.0, 0.0, 1.0);
            double shieldLerp = lerp(0.035, 0.08, pressure);
            facing = facing + std::atan2(std::sin(awayAngle - facing), std::cos(awayAngle - facing)) * shieldLerp;
            // F3 (facing audit): a shielding carrier at a sprint re-aligns his facing toward
            // travel a touch, so he doesn't moonwalk forward at speed facing 180 back — the
            // shield blend alone left him permanently turned away while motoring upfield.
            if (spdAfter > 35.0) {
                double moveAngle = std::atan2(p.vy, p.vx);
                facing = facing + std::atan2(std::sin(moveAngle - facing), std::cos(moveAngle - facing)) * 0.08;
            }
        } else {
            // Open field: face toward ball velocity (movement direction)
            auto& b = engine.state.ball;
            double bs = std::hypot(b.vx, b.vy);
            // F2 (facing audit): the carrier should face the way the ball ROLLS (his dribble
            // direction), not away from it — the -b.vy,-b.vx negation faced him backward.
            if(bs > 0.5) facing = facing + std::atan2(std::sin(std::atan2(b.vy, b.vx) - facing), std::cos(std::atan2(b.vy, b.vx) - facing)) * 0.05;
        }
    } else if (engine.state.ball.controllerId >= 0) {
        Player* carrier = engine.playerById(engine.state.ball.controllerId);
        // Ball-watching is a jogging habit: at speed you face your run, or
        // you moonwalk — players were sprinting backward at 74px/s for
        // seconds while staring at the carrier.
        // F1 (facing audit, THE headline: 31.6% of chasing defenders had their BACK to the ball;
        // E1's sprint-backs worsened it). A defender near a ball-carrying opponent now keeps his
        // EYE ON THE BALL across the engaged range and up to a RUN (was barely-moving <38): he
        // backpedals/jockeys facing the threat instead of turning his back. Only at a true SPRINT
        // (>56, the body has to face the run) does he face his movement. Threat-aware: gated to an
        // opponent carrier within the engaged range.
        if (carrier && carrier->team != p.team && bd < 290.0 && spdAfter < 56.0) {
            double ballAngle = std::atan2(bdy, bdx);
            facing = facing + std::atan2(std::sin(ballAngle - facing), std::cos(ballAngle - facing)) * 0.18;
        } else if (spdAfter > 5.0) {
            double moveAngle = std::atan2(p.vy, p.vx);
            double w = spdAfter > 45.0 ? 0.16 : 0.06;
            facing = facing + std::atan2(std::sin(moveAngle - facing), std::cos(moveAngle - facing)) * w;
        }
    } else if (engine.state.ball.intendedReceiverId == p.id) {
        // F4 (facing audit): the pass is on its way to ME (here controllerId<0, ball in flight)
        // — face the incoming ball, not a stale 3s-old ball-memory ghost. He already MOVES to
        // meet it; now he LOOKS at it too, across the whole pitch (was gated to bd<80 below).
        double ballAngle = std::atan2(bdy, bdx);
        facing = facing + std::atan2(std::sin(ballAngle - facing), std::cos(ballAngle - facing)) * 0.16;
    } else if (engine.state.ball.controllerId < 0 && bd < 80.0 && spdAfter < 52.0) {
        double ballAngle = std::atan2(bdy, bdx);
        facing = facing + std::atan2(std::sin(ballAngle - facing), std::cos(ballAngle - facing)) * 0.15;
    } else if (spdAfter > 5.0) {
        double moveAngle = std::atan2(p.vy, p.vx);
        facing = facing + std::atan2(std::sin(moveAngle - facing), std::cos(moveAngle - facing)) * 0.06;
    } else if (ballMemoryAge > 30) {
        double memAngle = std::atan2(ballMemoryY - p.y, ballMemoryX - p.x);
        facing = facing + std::atan2(std::sin(memAngle - facing), std::cos(memAngle - facing)) * 0.02;
    }

    double prevFacing = p.facing;
    double requestedFacingDelta = std::atan2(std::sin(facing - prevFacing), std::cos(facing - prevFacing));
    // G2 dizzy-spin: an OFF-BALL player whose facing TARGET oscillates (decision-flicker) chases it back and
    // forth → ~540°/1.5s pirouette. Damp a facing change that REVERSES the previous tick's direction (the
    // oscillation signature); CONSISTENT rotation (aligning body to travel, reacting to a threat) is same-sign
    // and passes through untouched. maxFacingTurn is UNTOUCHED (per the audit / turn-cap-perception note).
    bool offBallFacing = engine.state.ball.controllerId != p.id;
    if (offBallFacing && requestedFacingDelta * prevFacingDeltaSigned < -1e-6)
        requestedFacingDelta *= 0.15;   // SysArch 2026-06-28: tightened 0.30→0.15 — the overlap/counter-press off-ball churn re-raised SPIN 16→38; stronger reversal-damp (Boris's suggested lever). Measure-gated.
    // Sustained-pirouette damp (2026-07-02 audit): the reversal-damp above kills
    // flip-flop, but a facing target that rotates CONTINUOUSLY (orbiting a near
    // ball, circling a carrier) is same-sign and sails through — 540°+/1.5s
    // pirouettes, 4-11 per 15min. Once this 2s window has already accumulated a
    // full turn, further off-ball rotation damps hard until the window rolls.
    // Normal scanning never accumulates 360°/window, and maxFacingTurn is
    // untouched — perception gating (the turn-cap deadlock) stays intact.
    if (offBallFacing && dizzyRotationAccum > 360.0)
        requestedFacingDelta *= 0.2;
    prevFacingDeltaSigned = requestedFacingDelta;
    double turnSpeedBlend = clamp((spdAfter - 12.0) / 58.0, 0.0, 1.0);
    double maxFacingTurn = lerp(0.24, 0.055, turnSpeedBlend);
    // Rotating INTO your direction of travel is natural at any speed — the
    // slow cap models scanning AWAY from the run line. Without this, fast
    // movers could never align body to velocity and glided backward.
    if (spdAfter > 5.0) {
        double moveAngle = std::atan2(p.vy, p.vx);
        double nowOff  = std::abs(std::atan2(std::sin(facing - moveAngle), std::cos(facing - moveAngle)));
        double prevOff = std::abs(std::atan2(std::sin(prevFacing - moveAngle), std::cos(prevFacing - moveAngle)));
        if (nowOff < prevOff) maxFacingTurn = std::max(maxFacingTurn, 0.28);
    }
    requestedFacingDelta = clamp(requestedFacingDelta, -maxFacingTurn, maxFacingTurn);
    facing = prevFacing + requestedFacingDelta;
    double facingDelta = std::abs(requestedFacingDelta);
    dizzyRotationAccum += facingDelta * 180.0 / PI;
    if(engine.state.clockMs - dizzyWindowStartMs > 2000){
        dizzyWindowStartMs = engine.state.clockMs;
        dizzyRotationAccum = facingDelta * 180.0 / PI;
    }
    facing = std::atan2(std::sin(facing), std::cos(facing));
    p.facing = facing;
}

// ══════════════════════════════════════════════════════════════════════════════
// tryCollectAfterChase()
// ══════════════════════════════════════════════════════════════════════════════
void PlayerAI::tryCollectAfterChase() {
    auto& p = player;
    auto& b = engine.state.ball;

    if (b.controllerId >= 0) return;

    double distance = dist(p.x, p.y, b.x, b.y);
    bool intended = (p.id == b.intendedReceiverId);
    double reach = intended ? INTENDED_COLLECT_DIST : COLLECT_DIST;

    if (b.z >= 20.0 || distance > reach) return;

    double speed = std::hypot(b.vx, b.vy);
    double speedLimit = intended ? COLLECT_SPEED_MAX * INTENDED_COLLECT_BONUS : COLLECT_SPEED_MAX;

    if (speed >= speedLimit) return;

    if (!engine.collectBall(p, intended ? "intended_chase_reception" : "chase_collection", reach)) return;

    // Position-based stun lock: short in opponent's final third, long elsewhere
    bool inFinalThird = (p.team == Team::Home) ? p.x > PITCH_W * 2.0 / 3.0 : p.x < PITCH_W / 3.0;
    if (inFinalThird) {
        stunLockTicks = 12;  // ~200ms — react quickly near goal
        shotCooldown = 0;    // can shoot immediately in the box
    } else {
        // Threat-scaled settle: a presser arriving within ~0.8s means the first
        // decision comes NOW, not after a 750ms rest — the calm settle froze a
        // deep receiver's whole menu while the press arrived with the ball
        // (watched replay seed 129 0:38.6-0:39.4: the FB's only action for 45
        // ticks was the settle-dribble as the tackler closed 89→60px; tackled
        // at 0:40.2). Calm receptions keep the full composure beat.
        // Standing markers don't hurry the touch — a sprinting-in tackler does.
        // (A static near-marker test here hurried nearly every midfield
        // reception — the press retargets to the receive point on every pass —
        // and inflated match pass volume.)
        bool pressArriving = tackleArriving(engine.state.players, p.x, p.y, p.team);
        stunLockTicks = pressArriving ? 16 : 45;  // ~270ms hurried / ~750ms calm
        shotCooldown = 15;   // ~250ms — brief cooldown after collect
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// passSelectionAudit()
// ══════════════════════════════════════════════════════════════════════════════
