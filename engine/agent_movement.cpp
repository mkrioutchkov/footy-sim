#include "engine.h"
#include "agent.h"
#include "agent_helpers.h"

void PlayerAI::applyMovement(double sdt) {
    auto& p = player;
    if (isGoalkeeper()) return;
    if (setPieceHold) return;
    // A committed tackle dash owns the body until it lands (fixedUpdate moves
    // him): stacking normal movement on top pushed combined pace past 250px/s.
    if (p.id >= 0 && p.id < 22 && engine.lungeDashRemainPx[p.id] > 0.0) return;

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
    // Round-23 (arena reaudit): a busy player drains only to his fit floor (50-62,
    // above the 35 crash threshold), so the SPEED curve was dormant — a duelist
    // sprinted a flat p95 ~72.5px/s from minute 0 to 10. Give a GENTLE, visible
    // sag as stamina settles onto that floor: ~0.93 (7% off pace) pinned at the
    // floor, easing back to full pace 15 points above it. A fresh or rotating
    // player (stamina > floor+15) is untouched, so 11v11 barely moves; the
    // relentless arena duelist visibly tires.
    double fitFloor = STAMINA_MATCH_FLOOR + staminaSkill * 12.0;
    double sf = lerp(0.93, 1.0, clamp((p.stamina - fitFloor) / 15.0, 0.0, 1.0));
    if (p.stamina < slowThreshold) {
        // Heavy sprinting can drain below the floor; the steeper legacy crash
        // curve then takes over (kept as a floor on the gentle band, so the two
        // are continuous at the threshold).
        double fatigueBlend = clamp(p.stamina / std::max(1.0, slowThreshold), 0.0, 1.0);
        sf = std::min(sf, lerp(fatigueFloor, 1.0, fatigueBlend));
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

    // Round-27 COMMIT 5 (owner 15:06 "sudden forward movement of 10R is weird"):
    // a player poked loose (his OWN rebound-block live) with the ball still within
    // reach fired a 220px forward off-ball run at ~112-125px/s (>SPEED_SPRINT),
    // then snapped back to chase when the block lifted. While his own rebound
    // block is live and the ball is loose within ~150px, suppress the forward run:
    // hold a jockey stance ON the ball (a step to the goal-side, facing it) and
    // cap pace to SPEED_RUN so there is no overspeed burst — ready to pounce at
    // expiry. Pure state, no rng.
    // The pathology (not the benign case of a man already jockeying the ball at
    // his feet): a REACHABLE loose ball (40-150px, not underfoot) that he ignores
    // to walk off toward a far off-ball target. Round-29: the original gate only
    // caught a FORWARD flee — a rebound-blocked player whose shape target was
    // BACKWARD walked off the ball he just blocked all the same. Any move-away
    // >30px from the nearby blocked ball triggers the jockey.
    bool rblForwardFlee = dist(p.targetX, p.targetY, engine.state.ball.x, engine.state.ball.y) > 120.0
                       && dist(p.targetX, p.targetY, p.x, p.y) > 30.0;
    bool ownReboundBlockedLoose = p.id >= 0 && p.id < 22
        && !engine.arenaMode   // 11v11 only: in a 1v1 the jockey redirect recreates the round-25 freeze
        && engine.contestBlockedUntil[p.id] > engine.state.clockMs
        && engine.state.ball.controllerId < 0
        && engine.state.ball.intendedReceiverId != p.id
        && bd > 40.0 && bd < 150.0
        && rblForwardFlee;
    if (ownReboundBlockedLoose) {
        double jx = engine.state.ball.x, jy = engine.state.ball.y;
        double gsx = ownGoalXFor(p.team) - jx;
        double gnorm = std::abs(gsx) > 1e-6 ? gsx / std::abs(gsx) : 0.0;
        p.targetX = clamp(jx + gnorm * 22.0, 30.0, PITCH_W - 30.0);
        p.targetY = clamp(jy, 30.0, PITCH_H - 30.0);
        dx = p.targetX - p.x; dy = p.targetY - p.y; d = std::sqrt(dx * dx + dy * dy);
    }

    bool carrierCornered = (engine.state.ball.x < 80.0 || engine.state.ball.x > PITCH_W - 80.0)
                        && (engine.state.ball.y < 80.0 || engine.state.ball.y > PITCH_H - 80.0);
    bool predatorial = (pressTask || secondaryPress) && carrierCornered;

    bool committedPress = (pressTask && bd > 45.0 && (bd < PRESS_COMMIT_MAX_DIST || pitch::inDangerZone(engine.state.ball.x, p.team)))
                        || predatorial;

    // Round-25 (2v2 audit defect 3): a loose ball >300px from everyone trips the
    // observing crawl below (bd>300) and the loose-ball sprint only fires bd<230
    // near a goal, so a ~380px ball sat untouched until the 3s freeze watchdog
    // teleport-rolled it. The SINGLE nearest man of each team to a live loose ball
    // pursues at full pace regardless of range: exempt him from the crawl and from
    // the bd<230 sprint gate. Nearest-of-team is naturally self-limiting (two
    // chasers max), so everyone else's gates stay untouched and 11v11 midfield
    // pile-on suppression is preserved.
    // Two guards keep this safe: (1) bd>230 — inside the normal sprint range the
    // existing gates already pursue, so short-range play is byte-unchanged; (2)
    // the man must already be moving BALLWARD (his chosen action targets the ball
    // — i.e. scoreChase gave him a Chase). Without (2), exempting the crawl merely
    // sped the far man toward his POSITIONING spot (away from the ball), which
    // over-ran the naturally-spread duelists in 1v1 (arena goals down, stalls).
    // With it, the exemption only ever helps a man genuinely fetching a stranded
    // ball reach it before the 3s watchdog; it never sends anyone the wrong way.
    // The "nearest man of my TEAM" selection is only meaningful with >=2
    // outfielders per side; in a 1v1 the lone outfielder is trivially always the
    // nearest, so the concept degenerates and (measured) perturbs the duel into
    // extra freezes (1v1: base 0/12 seeds -> 5/12). Skip pure 1v1; 2v2/3v3 and
    // 11v11 (all >=2 outfielders) keep it.
    bool meaningfulTeamNearest = !engine.arenaMode || engine.arenaOutfielders >= 2;
    bool nearestChaserToLoose = false;
    if (meaningfulTeamNearest
        && engine.state.ball.controllerId < 0 && engine.state.ball.intendedReceiverId < 0
        && bd > 230.0 && (dx * bdx + dy * bdy) > 0.0 && p.role != Role::GK && !p.sentOff) {
        nearestChaserToLoose = true;
        for (auto& o : engine.state.players) {
            if (o.team != p.team || o.id == p.id || o.role == Role::GK || o.sentOff) continue;
            if (dist(o.x, o.y, engine.state.ball.x, engine.state.ball.y) < bd) { nearestChaserToLoose = false; break; }
        }
    }

    // A dead ball is never "observed": during a hold the choreography (box
    // crowd, wall, build-up spread) IS the job, and the crawl multiplier meant
    // a CB sent forward for a corner covered ~250 of 440px in a 10s hold — the
    // box stayed empty however good the targets were (seed 133 0:40).
    bool isObserving = !committedChase && !committedPress && !nearestChaserToLoose
                    && bd > 300.0 && bd > PLAYER_AWARE_RANGE * 0.5
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
    // Caught-upfield DEFENDER recovery (FB audit: recoveries ran at 39-44px/s
    // — 43% of top speed — because being >300px from the ball trips the
    // observing crawl and defendSprint requires !isObserving, so being caught
    // FURTHER out DISABLED sprinting; 2:05 Marcelo jogged home 146px behind
    // the ball line while his target was goal-side the whole way). A defender
    // on the wrong side of the ball while the opponent has it sprints home,
    // however far away the play is.
    bool recoverySprint = false;
    // Round-25 (2v2 audit defect 2): this caught-upfield recovery is gated
    // isDefenderLike(), so an arena CF stranded upfield of a counter ambles home
    // (cover goal-side only 51-65% of possession frames). In a small-sided game
    // EVERY outfielder is a cover defender, so in arenaMode extend the wrong-side
    // recovery sprint to any outfielder. 11v11 is unchanged (CFs staying high is
    // by design there).
    if ((isDefenderLike() || (engine.arenaMode && p.role != Role::GK))
        && !defendSprint && engine.state.ball.controllerId >= 0) {
        Player* oppCarrier = engine.playerById(engine.state.ball.controllerId);
        if (oppCarrier && oppCarrier->team != p.team) {
            double fdMe = fdFor(p.team);
            bool wrongSide = (p.x - engine.state.ball.x) * fdMe > 40.0;   // upfield of the ball line
            if (wrongSide) { recoverySprint = true; defendSprint = true; }
        }
    }

    // ── Step with the pass (anticipation pass, tombstone prerequisite) ── an
    // opponent pass IN FLIGHT is the defender's cue to move NOW: real defenders
    // break toward their man as the ball leaves the boot, arriving WITH it.
    // Here the sprint gates go dead for the whole flight — committedPress keys
    // on distance to the BALL (mid-flight: far), and every defendSprint branch
    // above requires a live carrier (controllerId >= 0) — so the man assigned
    // to the receiver ambled through the flight and only sprinted once the
    // ball was controlled, always a step late. Whoever is assigned to the
    // receiver, or already near him, executes his current job at full urgency
    // for the flight. Target is unchanged (no swarming) — only the weight shift.
    bool stepWithPass = false;
    if (!defendSprint && engine.state.ball.controllerId < 0
        && engine.state.ball.intendedReceiverId >= 0
        && std::hypot(engine.state.ball.vx, engine.state.ball.vy) > 40.0) {
        Player* rcv = engine.playerById(engine.state.ball.intendedReceiverId);
        if (rcv && rcv->team != p.team) {
            double rd = dist(p.x, p.y, rcv->x, rcv->y);
            auto* flightTask = engine.assignmentFor(p.id);
            bool myMan = flightTask && flightTask->opponentId == rcv->id;
            // 140 -> 115 (round-16 rebalance): step-with-the-pass put a
            // full-urgency body on EVERY reception within 14m — part of why
            // build-up suffocated (completion -1.3pp, duels +29% across the
            // defensive rounds). The assigned man still breaks from anywhere;
            // bystanders only inside 11.5m.
            if ((myMan || rd < 115.0) && rd > 20.0) {
                stepWithPass = true;
                defendSprint = true;
            }
        }
    }

    double cruiseMul = (isObserving && !recoverySprint && !stepWithPass)
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
    bool pursuingLooseBall = engine.state.ball.controllerId < 0 && (dx * bdx + dy * bdy) > 0.0
        && ((looseBallHighValue && bd < 230.0) || nearestChaserToLoose);
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
    // Round-28 C4(4): episode sprint cap. The shepherd recovery burst must not
    // sprint all match (stamina bleed -> late-half defensive collapse — the exact
    // 30-min A/B regression the comment above warns of). After ~2s of CONTINUOUS
    // committed-tackle sprint, throttle to run pace until the pursuit resets; the
    // closure floor (df) and momentum exemption below stay so he still arrives.
    if (committedTackle) {
        if (shepherdSprintSinceMs < -1e8) shepherdSprintSinceMs = engine.state.clockMs;
    } else {
        shepherdSprintSinceMs = -1e9;
    }
    bool committedTackleSprint = committedTackle
        && (engine.state.clockMs - shepherdSprintSinceMs <= 2000.0);
    bool fastDribbleGear = (activeKnockAheadRunner || p.dribbleType == 3);
    bool sprintGear = lastActionType == ActionType::Chase || committedPress
                   || committedTackleSprint || defendSprint || pursuingLooseBall || boxBurst;
    double baseSpeed = fastDribbleGear
        ? DRIBBLE_FAST_SPEED
        : (sprintGear ? SPEED_SPRINT : SPEED_RUN);

    // Shielding: slow down when near opponents with ball
    bool isController = (engine.state.ball.controllerId == p.id);
    if (isController && bd < 60.0) {
        baseSpeed *= 0.80; // 20% slower when shielding
    }

    // Round-34 COMMIT 5 (gear inversion). This line used to read `? 1.0 :` for
    // every committed-pursuit branch, so a chaser's distance term was PINNED at
    // 1.0 while a non-pursuing mover with a target >180px away got 1.5 — and
    // SPEED_SPRINT * 1.0 (68) is less than SPEED_RUN * 1.5 (78). Committing to
    // the chase made you slower than a team-mate strolling to a far spot, which
    // is why closing bursts never closed. Pursuit now takes the SAME distance
    // term with a floor at 1.0: it is never damped below full pace on the
    // approach (the whole point of the old constant), but it earns the same
    // overrun when the ball or the man is genuinely far away. See the
    // static_assert in constants.h — the ordering is now a compile-time
    // invariant, not an emergent coincidence.
    bool pursuitGear = committedChase || committedPress || committedTackle
                    || defendSprint || pursuingLooseBall || boxBurst;
    double df = pursuitGear
        ? std::max(1.0, std::min(d / 120.0, MOVE_DF_MAX_PURSUIT))
        : std::min(d / 120.0, MOVE_DF_MAX_OFFBALL);
    // A contain point riding a DRIFTING carrier is a pursuit, not an arrival:
    // the d/120 damping collapsed closure to ~0 at 24px short of the point
    // (2:21 Iniesta pinned 4.5-5.5m off Bale for 4.7s at walk pace while the
    // point drifted with the carrier). Keep a real floor near a live opponent
    // carrier when my target hugs him.
    {
        const auto& cb2 = engine.state.ball;
        if (cb2.controllerId >= 0 && df < 0.8) {
            Player* cc2 = engine.playerById(cb2.controllerId);
            if (cc2 && cc2->team != p.team
                && dist(p.targetX, p.targetY, cc2->x, cc2->y) < 45.0
                && dist(p.x, p.y, cc2->x, cc2->y) < 110.0)
                df = 0.8;
        }
    }
    double ms = attrFactor(p.attrs.speed) * baseSpeed * sf * df * cruiseMul;
    // Round-27 COMMIT 5: a rebound-blocked player jockeying the loose ball never
    // exceeds a run — no forward-burst overspeed while he waits to pounce.
    if (ownReboundBlockedLoose) ms = std::min(ms, SPEED_RUN * sf);
    // Round-21 (take-on audit) COMMIT 4b: a just-beaten defender is off-balance
    // and wrong-footed. A REAL two-stage stun on his pursuit pace (this replaces
    // the take-on's dead stunLock, which was only ever read on a controller):
    // ~0.25x planted for the first ~250ms, then ~0.55x recovering out to ~1100ms,
    // so the carrier's beat burst opens a genuine gap instead of the man re-gluing
    // at 22px. Applies before the momentum block, so committed pursuit obeys it.
    if (p.id >= 0 && p.id < 22 && engine.beatenSlowUntilMs[p.id] > engine.state.clockMs) {
        double remain = engine.beatenSlowUntilMs[p.id] - engine.state.clockMs;
        ms *= (remain > BEATEN_SLOW_TOTAL_MS - BEATEN_SLOW_HARD_MS) ? 0.25 : 0.55;
    }
    // Round-27 COMMIT 2 (eased stop): a just-dispossessed victim keeps his
    // momentum (set at the tackle win) and bleeds it down over ~3 ticks rather
    // than snapping to a dead stop. Decay the carried velocity and cap the
    // command speed to it so he can't re-accelerate mid-glide.
    if (p.id >= 0 && p.id < 22 && engine.tackleStopEaseUntilMs[p.id] > engine.state.clockMs) {
        p.vx *= 0.55;
        p.vy *= 0.55;
        ms = std::min(ms, std::hypot(p.vx, p.vy) + 4.0);
    }
    // Round-34 census (pure counter, serialised only under FOOTY_CENSUS=1): the
    // final commanded speed, bucketed by gear. Nothing below reads it.
    {
        int gear = fastDribbleGear ? 0 : (sprintGear ? 3 : (cruiseMul < 1.0 ? 1 : 2));
        int b = (int) (ms / 2.0);
        engine.stats.census.gearHist[gear][b < 0 ? 0 : (b > 63 ? 63 : b)]++;
    }

    // ── Momentum v3 (tombstone lifted, round 13) ── v1/v2 taxed EVERYONE with
    // a real accel/turn model and died twice (shots +62%/+71%, tackles
    // -19%/-28%): reactive defenders paid hardest because nothing in the AI
    // read the play early. The anticipation pass now exists (drop-point
    // attack, step-with-the-pass, plus the existing press/chase commitments),
    // so v3 EXEMPTS committed pursuit — a player who has read the play keeps
    // command kinematics — while everyone else (shape holders, markers
    // idling, attackers drifting into space) pays real launch physics: an
    // accel-capped velocity chase (the cap IS the turn carve at speed) and a
    // plant-and-brake through reversals. The carrier never runs through here
    // (agent.cpp gates applyMovement to non-controllers) — moveCarrier's
    // turn-rate caps remain his momentum.
    double px = p.x, py = p.y;
    bool momentumExempt = committedChase || committedPress || committedTackle
        || defendSprint || pursuingLooseBall || boxBurst
        || lastActionType == ActionType::Chase || lastActionType == ActionType::Tackle;
    if (momentumExempt) {
        if (d > 1.0) {
            double step = std::min(ms * secs, d);
            p.x += (dx / d) * step;
            p.y += (dy / d) * step;
        }
        if (secs > 0.001) {
            p.vx = (p.x - px) / secs;
            p.vy = (p.y - py) / secs;
        }
    } else if (d < 14.0) {
        // Docking: the last stride lands EXACTLY (command step under the
        // braking envelope). An accel-capped follower can never quite stop ON
        // the point — the residual crossing speed had containers orbiting
        // their contain points, flipping direction every few ticks (measured:
        // near-target at-speed flips 3.5x the command-kinematics build).
        double lim = std::min(ms, std::sqrt(2.0 * MOMENTUM_ACCEL * d));
        if (d > 1e-6) {
            double step = std::min(lim * secs, d);
            p.x += (dx / d) * step;
            p.y += (dy / d) * step;
        }
        if (secs > 0.001) {
            p.vx = (p.x - px) / secs;
            p.vy = (p.y - py) / secs;
        }
    } else {
        // Open field: velocity chases the command under the accel cap (the
        // cap IS the turn carve at speed); reversals plant-and-brake first.
        // Arrival envelope: never command more speed than can be braked away
        // within the remaining distance (a naive d/secs cap is ~no-op at 60Hz,
        // and the df=0.8 contain floor keeps commands hot arbitrarily close).
        double desSpd = std::min(ms, std::sqrt(2.0 * MOMENTUM_ACCEL * d));
        double desVx = (dx / d) * desSpd;
        double desVy = (dy / d) * desSpd;
        double curSpd = std::hypot(p.vx, p.vy);
        // A bookkeeping velocity (separation shove, exempt-mode displacement
        // math after a snap) can arrive far beyond human pace — integrating
        // it here would BE the teleport. Clamp to plausible flesh first.
        double vCap = ms * 1.35 + 40.0;
        if (curSpd > vCap && curSpd > 1.0) {
            p.vx *= vCap / curSpd;
            p.vy *= vCap / curSpd;
            curSpd = vCap;
        }
        double headDot = (curSpd > 40.0 && desSpd > 1.0)
            ? (p.vx * desVx + p.vy * desVy) / (curSpd * desSpd)
            : 1.0;
        if (headDot < -0.35) {
            // Hard reversal: nobody carves through 110+ degrees at speed —
            // plant, kill the momentum, THEN relaunch the other way.
            double brake = std::min(curSpd, MOMENTUM_ACCEL * MOMENTUM_REVERSAL_BRAKE_MUL * secs);
            p.vx -= (p.vx / curSpd) * brake;
            p.vy -= (p.vy / curSpd) * brake;
        } else {
            double dvx = desVx - p.vx, dvy = desVy - p.vy;
            double dvl = std::hypot(dvx, dvy);
            double cap = MOMENTUM_ACCEL * secs;
            if (dvl > cap) {
                dvx *= cap / dvl;
                dvy *= cap / dvl;
            }
            p.vx += dvx;
            p.vy += dvy;
        }
        p.x += p.vx * secs;
        p.y += p.vy * secs;
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

    bool offBallFacing = engine.state.ball.controllerId != p.id;
    // Moonwalk constraint (round-30): cap how far the facing TARGET may sit off
    // the run line, instead of overriding the delta after the dampers have run.
    // The old override wrote its ±16° yank at the bottom of this function, AFTER
    // the reversal damper, after the dizzy damper and after prevFacingDeltaSigned
    // was captured — so the yank was never damped AND the stored sign was the
    // pre-override value, which made the next tick's sign test read "same sign"
    // and pass the counter-yank straight through. The guard written to kill
    // exactly this oscillation was structurally blind to it, and the result was a
    // sustained ±16°/50ms body judder. Constraining the target instead leaves the
    // damper in charge of the whole tick and still beats the moonwalk fix on its
    // own objective (frac >90° off travel at speed). Same gate as before.
    bool runLineForced = false;
    if (offBallFacing && spdAfter > 38.0) {
        // Same ball distance the old override measured: taken AFTER this tick's
        // movement integration, not the pre-move `bd` at the top of the function.
        double bdNow = dist(p.x, p.y, engine.state.ball.x, engine.state.ball.y);
        if (bdNow > 220.0 || (spdAfter > 42.0 && bdNow > 120.0)) {
            constexpr double RUN_LINE_LIM = 1.55;   // ~89°: shoulder-on is fine, backwards is not
            double moveAngle = std::atan2(p.vy, p.vx);
            double off = std::atan2(std::sin(facing - moveAngle), std::cos(facing - moveAngle));
            if (std::abs(off) > RUN_LINE_LIM) {
                facing = moveAngle + (off > 0.0 ? RUN_LINE_LIM : -RUN_LINE_LIM);
                runLineForced = true;
            }
        }
    }

    double prevFacing = p.facing;
    double requestedFacingDelta = std::atan2(std::sin(facing - prevFacing), std::cos(facing - prevFacing));
    // G2 dizzy-spin: an OFF-BALL player whose facing TARGET oscillates (decision-flicker) chases it back and
    // forth → ~540°/1.5s pirouette. Damp a facing change that REVERSES the previous tick's direction (the
    // oscillation signature); CONSISTENT rotation (aligning body to travel, reacting to a threat) is same-sign
    // and passes through untouched. maxFacingTurn is UNTOUCHED (per the audit / turn-cap-perception note).
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
        // Moonwalk fix (micro audit: 141 backward-at-speed runs, worst 5s of
        // 51px/s backpedal by an attacker) — a sustained RUN turns the body into
        // the travel line. Legit ball-watching backpedal is preserved: only
        // forced when the ball is far (>220px), i.e. nothing to track. Round-30:
        // the DELTA override that used to live here has moved above prevFacing
        // as a target constraint (see the RUN_LINE_LIM block); all that is left
        // here is the turn-cap raise that lets the damped delta get there in
        // reasonable time — fired off the same gate (220 -> 120 with a speed
        // tier; 2-min audit, seed 629: 27 sustained backpedal windows, worst
        // 2.45s at 45-50px/s with facing WELDED to a ball well inside 220px).
        if (runLineForced) maxFacingTurn = std::max(maxFacingTurn, 0.28);
    }
    // Round-30 hygiene: capture the sign AFTER every modifier, so a future
    // late write can never blind the reversal damper the way the moonwalk
    // override did (it stored the pre-override sign and the counter-yank on the
    // next tick then read as "same direction" and sailed through undamped).
    prevFacingDeltaSigned = requestedFacingDelta;
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
