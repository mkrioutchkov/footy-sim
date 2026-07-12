#include "engine.h"
#include "agent.h"
#include <cstdio>

Action PlayerAI::scoreTackle(const Perception& per, const GameContext& /*ctx*/) {
    if (engine.setPiece.armed) return Action{ActionType::Tackle, 0.0};
    if (per.ballIsLoose || per.ballControllerTeam == player.team)
        return Action{ActionType::Tackle, 0.0};

    Player* ctrl = engine.playerById(per.ballControllerId);
    if (!ctrl) return Action{ActionType::Tackle, 0.0};
    if (ctrl->role == Role::GK) return Action{ActionType::Tackle, 0.0};

    double d = dist(player.x, player.y, ctrl->x, ctrl->y);
    if (d > TACKLE_ZONE_MAX) return Action{ActionType::Tackle, 0.0};

    // First-touch grace: a player who won the ball THIS instant gets his
    // controlling touch before anyone may challenge (watched replay 0:45:
    // interception -> foul 100ms later read as scripted). Box emergencies are
    // exempt — a striker taking a touch six yards out still gets closed down.
    if (engine.carrierTracker.carryTrackerId == ctrl->id
        && engine.state.clockMs - engine.carrierTracker.carryStartMs < 280.0
        && !(pitch::distToOwnGoal(ctrl->x, player.team) < EMERGENCY_BOX_DIST))
        return Action{ActionType::Tackle, 0.0};

    // Carrier kinematics: where is he going, and am I in his running lane?
    double carrierSpeed = std::hypot(ctrl->vx, ctrl->vy);
    double forwardX = carrierSpeed > 8.0 ? ctrl->vx / carrierSpeed : std::cos(ctrl->facing);
    double forwardY = carrierSpeed > 8.0 ? ctrl->vy / carrierSpeed : std::sin(ctrl->facing);
    double toTacklerX = d > 1.0 ? (player.x - ctrl->x) / d : 0.0;
    double toTacklerY = d > 1.0 ? (player.y - ctrl->y) / d : 0.0;
    double exposedDot = forwardX * toTacklerX + forwardY * toTacklerY; // >0 = I'm in front of his run

    // Is the BALL shown front-to-front at me? (dir carrier->ball vs carrier->me)
    // This is the real "tackleable" signal — not the dribbleType label. A
    // close-control dribbler (type 1) who turns the ball into a touch-tight
    // defender is just as nickable as an open carry; the old type-2/3-only gate
    // let a striker shield-and-stroll past a CB at 18px for seconds on end.
    const auto& bball = engine.state.ball;
    double bcx = bball.x - ctrl->x, bcy = bball.y - ctrl->y, bcl = std::hypot(bcx, bcy);
    double ballShownDot = (bcl > 0.5 && d > 1.0) ? (bcx * toTacklerX + bcy * toTacklerY) / bcl : 0.0;

    // A defender who is touch-tight steps in and nicks it — press assignment or
    // not — when either he's in the running lane of an open carry, or the ball
    // is plainly exposed toward him (any carry type that isn't a back-to-goal shield).
    // audit #1: a SUSTAINED on-the-ball contest (glued within TACKLE_RANGE for ~>0.15s, e.g. a
    // shielding carrier the container rode without challenging) must RESOLVE — treat it as a nick
    // chance so the contain-gate doesn't suppress it. Brief grazes (<0.15s) stay jockey.
    bool sustainedContest = ballContestTicks > 9;   // ~0.15s+ glued (the no-tackle overlap); resolved via the nick path, not force-boosted
    bool nickOpportunity = (d < TACKLE_RANGE && (
            (exposedDot > 0.10 && (ctrl->dribbleType == 2 || ctrl->dribbleType == 3))
         || ballShownDot > 0.45
         || sustainedContest))
        // Round-14 geometry audit: a CLEARLY shown ball a half-step outside
        // contact range is still a nick — the 18-26px band was doctrine-vetoed
        // for everyone without a press job, and shown balls escaped 76% of
        // sustained touch-tight moments.
        || (d < TACKLE_RANGE + 4.0 && ballShownDot > 0.60);
    // 3v1 squeeze (watched replay seed 107 0:16: three defenders ringed a
    // shielding carrier at 24-41px and nobody engaged — the ball was never
    // "shown", so everyone contained forever). With numbers up close and the
    // carrier pinned for over a second, the CLOSEST man commits.
    if (!nickOpportunity && d < 45.0 && carrierSpeed < 30.0
        && engine.carrierTracker.carryTrackerId == ctrl->id
        && engine.state.clockMs - engine.carrierTracker.carryStartMs > 1200.0) {
        int crowd = 0;
        bool closest = true;
        for (auto& q : engine.state.players) {
            if (q.team != player.team || q.id == player.id || q.role == Role::GK || q.sentOff) continue;
            double qd = dist(q.x, q.y, ctrl->x, ctrl->y);
            if (qd < 55.0) crowd++;
            if (qd < d - 1.0) closest = false;
        }
        if (crowd >= 1 && closest) nickOpportunity = true;
    }

    bool isDef = isDefenderRole();
    if (isDef) {
        if (isCenterBack()) {
            if (!pitch::inOwnHalf(ctrl->x, player.team)) return Action{ActionType::Tackle, 0.0};
        }
        if (isFullBack()) {
            bool onMyFlank = std::abs(ctrl->y - player.homeY) < 250.0;
            bool isAttacker = ctrl->role == Role::WM || ctrl->role == Role::CF || ctrl->role == Role::CM;
            if (!onMyFlank || !isAttacker) return Action{ActionType::Tackle, 0.0};
        }
    }

    double sc = tackleBaseScore() - (d / 60.0) * tackleDistCoeff() + attrFactor(player.attrs.tackling) * tackleSkillCoeff();

    sc += tackleRoleAdjust();
    if (d < TACKLE_CLOSE_BOOST_RANGE) sc += 0.15;

    // Carrier holding still — easier target, but not a guaranteed lunge: the
    // old +0.30 meant every pause triggered a challenge from anyone in range.
    if (ctrl->dribbleType == 0 && d < TACKLE_ZONE_MAX) sc += 0.18;

    double ownGoalX = ownGoalXFor(player.team);
    bool emergencyBoxChallenge = pitch::distToOwnGoal(ctrl->x, player.team) < EMERGENCY_BOX_DIST
        && std::abs(ctrl->y - PITCH_H / 2.0) < 210.0
        && d < TACKLE_RANGE + 18.0
        && isDefenderLike();

    auto* defensiveTask = engine.assignmentFor(player.id);
    // Defensive doctrine: dueling is the presser's job. Shape players and
    // unassigned trackers contain unless it's a box emergency or the ball is
    // literally at their feet — five rounds of score tweaks failed to dent the
    // ~1400 duels/match because everyone in range was allowed to roll.
    {
        bool pressJob = defensiveTask
            && (defensiveTask->role == DefensiveTask::PrimaryPress
                || defensiveTask->role == DefensiveTask::SecondaryPress
                || defensiveTask->role == DefensiveTask::CloseDown);
        if (!pressJob && !emergencyBoxChallenge && !nickOpportunity && d > TACKLE_RANGE * 0.75)
            return Action{ActionType::Tackle, 0.0};
    }
    if (defensiveTask) {
        if (defensiveTask->opponentId == ctrl->id && defensiveTask->role == DefensiveTask::PrimaryPress)   sc += 0.20;
        if (defensiveTask->opponentId == ctrl->id && defensiveTask->role == DefensiveTask::SecondaryPress) sc += 0.10;
        // The presser in contact range must actually challenge: holding
        // position scored higher than tackling a MOVING carrier, so a dribbler
        // could stroll 20m into the box with three pressers in tow (the only
        // tackle trigger was the carrier standing still).
        if (defensiveTask->opponentId == ctrl->id && defensiveTask->role == DefensiveTask::PrimaryPress
            && d < TACKLE_RANGE + 6.0 && ctrl->dribbleType != 0)
            sc += 0.24;
        if (emergencyBoxChallenge) sc += 0.26;
    }

    if (engine.isCarrierShielded(ctrl->id) || engine.isActiveShield(ctrl->id)) sc -= 0.20;

    // Box discipline: a lunge from the wrong side in our own area is a
    // penalty waiting to happen — never tackle from behind in the box,
    // jockey and force the shot instead. (The soft -0.30 version of this
    // still conceded 2.8 pens/match once the low block crowded the area.)
    {
        bool inOurBox = pitch::distToOwnGoal(ctrl->x, player.team) < PENALTY_AREA_W
            && std::abs(ctrl->y - PITCH_H / 2.0) < PENALTY_AREA_H / 2.0;
        double fd = fdFor(player.team);
        bool goalSide = (player.x - ctrl->x) * fd < -2.0;
        if (inOurBox && !goalSide) return Action{ActionType::Tackle, 0.0};
        // Even goal-side: stay on your feet in the box unless it's the
        // emergency — every challenge is a penalty roll.
        if (inOurBox && !emergencyBoxChallenge) sc -= 0.12;
    }

    if (pitch::distToOwnGoal(ctrl->x, player.team) < NEAR_GOAL_DIST) sc += 0.18;
    if (pitch::distToOwnGoal(ctrl->x, player.team) < CLOSE_GOAL_DIST) sc += 0.12;

    // The counter-press prize: a DEFENDER showing the ball in HIS OWN half is
    // the best turnover in football — win it there and the goal is close with
    // the shape broken. All the urgency bonuses above are defensive (near OUR
    // goal); nothing rewarded the steal high up, so the presser rode a carrying
    // CB at touching distance and never engaged (watched replay 1:22).
    if (roles::isDefenderRole(ctrl->role)
        && pitch::inOwnHalf(ctrl->x, ctrl->team)
        && d < TACKLE_RANGE + 10.0
        && ballShownDot > 0.15) {
        double carrierGoalDist = pitch::distToOwnGoal(ctrl->x, ctrl->team);
        sc += 0.18 + clamp(1.0 - carrierGoalDist / (PITCH_W * 0.5), 0.0, 1.0) * 0.14;
    }

    int oppsClose = 0;
    for (auto* o : per.nearbyOpponents) {
        if (dist(o->x, o->y, ctrl->x, ctrl->y) < 60.0) oppsClose++;
    }
    if (pitch::distToOwnGoal(ctrl->x, player.team) < 300.0 && oppsClose < 2) sc += 0.08;
    if (d < TACKLE_RANGE + 4.0 && oppsClose >= 2) sc += 0.18;
    if (d < TACKLE_RANGE) sc += 0.14;

    bool oppFacingAway = (ctrl->team == Team::Home) ? ctrl->vx < 0.0 : ctrl->vx > 0.0;
    if (oppFacingAway && d < TACKLE_RANGE + 20.0) sc += 0.10;
    bool carrierNearTouchline = ctrl->y < TOUCHLINE_PROXIMITY || ctrl->y > PITCH_H - TOUCHLINE_PROXIMITY;
    if (oppFacingAway && carrierNearTouchline && d < TACKLE_RANGE + 16.0
        && (player.role == Role::WM || player.role == Role::CM || player.role == Role::FB)) {
        sc += 0.24;
    }

    if (nickOpportunity) sc += 0.16;
    if (exposedDot > 0.35 && d < TACKLE_RANGE + 22.0) sc += 0.12;
    if (exposedDot < -0.35 && !emergencyBoxChallenge) sc -= 0.18;
    // Round-14 tackle-geometry audit (owner: shown balls escape too often):
    // 76 sustained shown-ball episodes at touch-tight range in one match,
    // only 24% punished — a ball shown square at a marker inside TACKLE_RANGE
    // for a beat must usually be taken. And the mirror: a defender with his
    // BACK to the duel has to turn before he can challenge.
    if (d < TACKLE_RANGE && ballShownDot > 0.55) sc += 0.22;
    {
        double meFacingCarrier = std::cos(player.facing) * (-toTacklerX) + std::sin(player.facing) * (-toTacklerY);
        if (meFacingCarrier < -0.2) sc -= 0.20;
    }

    double goalDx = ownGoalX - ctrl->x;
    double goalDy = PITCH_H / 2.0 - ctrl->y;
    double goalDist = std::max(1.0, std::hypot(goalDx, goalDy));
    double drivingAtGoal = (forwardX * goalDx + forwardY * goalDy) / goalDist;
    if (drivingAtGoal > 0.38 && d < TACKLE_RANGE + 24.0 && pitch::distToOwnGoal(ctrl->x, player.team) < 300.0) sc += 0.14;
    if (drivingAtGoal < -0.25 && !emergencyBoxChallenge) sc -= 0.06;

    // aggression: an aggressive side hunts the ball (higher tackle desire);
    // a passive side jockeys. Centred on the old +0.05 at dial 50 so defaults
    // are unchanged, with a strong spread either side.
    sc += 0.05 + ((engine.configFor(player.team).aggression - 50.0) / 50.0) * 0.15;

    // Added time: press harder in defending final third
    if (engine.phase.addedTimeActive && engine.phase.half == 2) {   // 2nd-half stoppage only
        bool inDefThird = pitch::inOwnDefensiveThird(player.x, player.team);
        if (inDefThird) sc += 0.12;
    }

    return Action{ActionType::Tackle, clamp(sc, 0.0, 1.0), ctrl};
}

// ══════════════════════════════════════════════════════════════════════════════
// cm() — can-mark
// ══════════════════════════════════════════════════════════════════════════════
Action PlayerAI::scoreMark(const Perception& per, const GameContext& /*ctx*/) {
    if (!isDefenderRole()) return Action{ActionType::Mark, 0.0};
    if (per.ballControllerTeam == player.team && !per.ballIsLoose) return Action{ActionType::Mark, 0.0};

    if (per.ballIsLoose && per.intendedId >= 0) {
        Player* t = engine.playerById(per.intendedId);
        if (t && t->team != player.team && roles::isAttacker(t->role)) {
            double d = dist(player.x, player.y, t->x, t->y);
            if (d < 340.0) return Action{ActionType::Mark, clamp(0.80 - (d / 340.0) * 0.25, 0.0, 1.0), t};
        }
    }

    Player* best = nullptr;
    double bd = 1e9;
    double ownGx = ownGoalXFor(player.team);
    bool isFb = isFullBack();

    for (auto& o : engine.state.players) {
        if (o.team == player.team || o.role == Role::GK) continue;
        if (isFb && o.role != Role::WM && (o.role != Role::CM || std::abs(o.y - player.homeY) > 200.0)) continue;
        if (!isFb && o.role != Role::CF && o.role != Role::CM) continue;

        double d = dist(player.x, player.y, o.x, o.y);
        double danger = std::abs(o.x - ownGx);
        double score = d * 0.6 + danger * 0.4;

        if (isFb) {
            bool onFlank = std::abs(o.y - player.homeY) < 220.0;
            if (onFlank && o.role == Role::WM)      score -= 80.0;
            else if (!onFlank && o.role == Role::WM) score += 20.0;
            else if (o.role == Role::CM)             score -= 15.0;
        }
        if (!isFb) {
            if (o.role == Role::CF)      score -= 60.0;
            else if (o.role == Role::CM) score -= 20.0;
        }

        if (score < bd && d < 300.0) { bd = score; best = &o; }
    }

    if (!best) return Action{ActionType::Mark, 0.0};

    double dangerDist = dist(player.x, player.y, best->x, best->y);
    double baseScore = isFb ? 0.68 : 0.66;
    return Action{ActionType::Mark, clamp(baseScore + attrFactor(player.attrs.positioning) * 0.25 - (dangerDist / 300.0) * 0.25, 0.0, 1.0), best};
}

// ══════════════════════════════════════════════════════════════════════════════
// cc() — can-chase
// ══════════════════════════════════════════════════════════════════════════════
Action PlayerAI::scoreChase(const Perception& per) {
    // Law 11 self-restraint: a player who was in an offside position when his
    // teammate SHOT pulls out of the rebound chase — real poachers know the
    // flag is coming (without this, honest rebound whistling hit 9.7/90 vs
    // real 3-6 because runners chased balls they could never legally play).
    if (engine.shotSnapshotLive && player.team == engine.shotTeam
        && player.id >= 0 && player.id < 22 && engine.offsideAtShot[player.id])
        return Action{ActionType::Chase, 0.0};
    auto& b = engine.state.ball;
    bool isIntendedReceiver = (player.id == b.intendedReceiverId);
    bool activeKnockAheadRunner = engine.isActiveKnockAheadRunner(player.id);
    double ballSpeed = std::sqrt(b.vx * b.vx + b.vy * b.vy);
    bool needsRecovery = b.z <= AERIAL_HEIGHT && ballSpeed < RECOVERY_BALL_SPEED_MAX && per.amClosestToBall;
    bool selfLooseTouch = b.controllerId < 0 && b.intendedReceiverId < 0
        && b.lastToucherId == player.id && b.z <= AERIAL_HEIGHT
        && ballSpeed < SELF_LOOSE_TOUCH_SPEED && per.ballDist < SELF_LOOSE_TOUCH_DIST;

    bool canContest = engine.canContestBall(player);
    // An ARMED restart's dead ball belongs to the taker ALONE. Without this,
    // the nearest man chased the placed ball and STOOD ON IT (same-team men
    // aren't moved by enforceRestartDistance at all), physically blocking the
    // taker's 15px arrival until the 3.5s walkMs backstop teleported control —
    // t101 5:30: ~10s frozen with a CM parked on the goal-kick spot. Score 0
    // so arbitration falls back to shape/marking (the restart choreography).
    if (engine.setPiece.armed && b.controllerId < 0 && player.id != engine.setPiece.takerId)
        return Action{ActionType::Chase, 0.0};
    double toPlayerDist = std::max(per.ballDist, 1.0);
    double approachDot = ballSpeed > 1.0
        ? (b.vx * (player.x - b.x) + b.vy * (player.y - b.y)) / (ballSpeed * toPlayerDist)
        : 0.0;
    double arrivalTime = per.ballDist / std::max(ballSpeed, 1.0);
    bool incomingLooseBall = b.z <= AERIAL_HEIGHT && ballSpeed > 20.0 && per.ballDist < 100.0
        && approachDot > 0.35 && arrivalTime < 1.25;
    bool deadBallRecoveryRun = !canContest && b.z <= AERIAL_HEIGHT && ballSpeed < 35.0 && per.ballDist < 70.0;
    bool closeLooseBall = canContest && b.z <= AERIAL_HEIGHT && per.ballDist < 45.0;
    // ── Attack the drop point (seed 173 0:51 + anticipation pass) ── every
    // chase branch above is gated z <= AERIAL_HEIGHT, so for the ~0.9s an
    // opponent's cross hung in the air Pique stood ON the landing spot, then
    // walked off it goal-side and let the ball drop to Ronaldo's feet. A
    // defender reads the flight: when an AIRBORNE ball is coming down for an
    // OPPONENT (or loose), and I can reach its predicted landing before/with
    // it, I attack the drop point now.
    bool attackDropPoint = false;
    double dropX = 0.0, dropY = 0.0;
    if (canContest && b.z > AERIAL_HEIGHT && b.vz < 40.0 && ballSpeed > 40.0) {
        Player* intd = engine.playerById(b.intendedReceiverId);
        bool oppBall = intd ? intd->team != player.team
                            : (b.controllerId < 0 && b.lastTouchTeam != player.team);
        if (oppBall) {
            // Walk the flight forward to the touchdown (predictBallPos handles
            // drag/gravity/bounce); coarse 0.15s steps are plenty at 60Hz.
            double tLand = 0.0;
            for (double t = 0.15; t <= 1.8; t += 0.15) {
                double bx2, by2;
                engine.predictBallPos(t, bx2, by2);
                double zApprox = b.z + b.vz * t - 0.5 * GRAVITY * t * t;
                if (zApprox <= AERIAL_HEIGHT) { tLand = t; dropX = bx2; dropY = by2; break; }
            }
            if (tLand > 0.0) {
                double dDrop = dist(player.x, player.y, dropX, dropY);
                double mySprint = std::max(45.0, attrFactor(player.attrs.speed) * SPEED_SPRINT);
                if (dDrop < 170.0 && dDrop / mySprint < tLand + 0.35)
                    attackDropPoint = true;
            }
        }
    }
    if (attackDropPoint) {
        double sc = clamp(0.88 - dist(player.x, player.y, dropX, dropY) / 500.0, 0.60, 0.88);
        return Action{ActionType::Chase, sc, nullptr, dropX, dropY, ActionPurpose::MeetIncoming};
    }
    // A teammate's pass in flight is HIS ball — the urgency rules above made
    // off-ball players shadow-chase every pass that rolled near them,
    // oscillating at the carrier's elbow instead of holding shape.
    if (Player* inFlightTo = engine.playerById(b.intendedReceiverId)) {
        if (inFlightTo->team == player.team && !isIntendedReceiver && ballSpeed > 60.0) {
            incomingLooseBall = false;
            closeLooseBall = false;
        }
    }
    bool urgentLooseBallRun = incomingLooseBall || deadBallRecoveryRun || closeLooseBall;

    // ── Dead-ball recovery override (wide/corner pursuit gap) ──
    // A STATIONARY uncontested ball that this player can reach and is the nearest
    // eligible man to MUST be collected — and the recovery must WIN arbitration
    // over his shape/line positioning (which scores up to ~1.0). The two branches
    // below cap the recovery at 0.96 (free-ball, d>=45) and 1.0 (urgent, d<45), so
    // a wide fullback's defensive-line candidate out-arbitrates it and the ball is
    // stranded in the corner until the 3s freeze-rescue teleports control to him.
    // This single override covers BOTH distance bands: for a truly dead ball
    // (bs<15) that I am closest-eligible to, floor the chase above any positioning
    // candidate. Tightly gated to bs<15 => all moving loose-ball play is unchanged.
    if (canContest && per.ballIsLoose && b.z <= AERIAL_HEIGHT && ballSpeed < 15.0
        && !isIntendedReceiver && per.ballDist < 340.0) {
        bool amNearestEligible = true;
        for (auto& q : engine.state.players) {
            if (q.id == player.id || q.role == Role::GK) continue;
            if (dist(q.x, q.y, b.x, b.y) + 25.0 < per.ballDist && engine.canContestBall(q)) {
                amNearestEligible = false;
                break;
            }
        }
        if (amNearestEligible)
            // Target the ball tightly (BALL_R margin, not the usual 10px) so a ball
            // wedged in the true corner is reachable — a 10px inset left the chaser
            // pointed ~10px short of a corner ball, just outside a clean collect.
            return Action{ActionType::Chase, 1.60, nullptr,
                          clamp(b.x, BALL_R, PITCH_W - BALL_R), clamp(b.y, BALL_R, PITCH_H - BALL_R),
                          ActionPurpose::RecoverLoose};
    }
    // Free ball: a slow loose ball whose nearer players are all contest-blocked
    // (e.g. shepherding their own clearance) is anyone's — the nearest eligible
    // player must go get it, even from beyond the usual chase radius. Without
    // this, balls rolled dead for seconds while everyone watched.
    bool nearestEligibleFreeBall = false;
    if (per.ballIsLoose && canContest && b.z <= AERIAL_HEIGHT
        && ballSpeed < 130.0 && per.ballDist < 340.0) {
        nearestEligibleFreeBall = true;
        for (auto& q : engine.state.players) {
            if (q.id == player.id || q.role == Role::GK) continue;
            if (dist(q.x, q.y, b.x, b.y) + 25.0 < per.ballDist && engine.canContestBall(q)) {
                nearestEligibleFreeBall = false;
                break;
            }
        }
    }
    bool cfLoosePassSupport = false;
    if (isCenterForward() && canContest && !isIntendedReceiver
        && b.controllerId < 0 && b.intendedReceiverId >= 0
        && b.lastTouchTeam == player.team
        && b.z <= AERIAL_HEIGHT
        && ballSpeed > 20.0 && per.ballDist < 155.0) {
        Player* intended = engine.playerById(b.intendedReceiverId);
        double intendedDist = intended ? dist(intended->x, intended->y, b.x, b.y) : 1e9;
        bool intendedUnderPressure = false;
        if (intended) {
            for (auto& opponent : engine.state.players) {
                if (opponent.team != player.team && opponent.role != Role::GK && !opponent.sentOff
                    && dist(opponent.x, opponent.y, intended->x, intended->y) < 45.0) {
                    intendedUnderPressure = true;
                    break;
                }
            }
        }
        double toPlayerAlongBall = ballSpeed > 1.0
            ? (b.vx * (player.x - b.x) + b.vy * (player.y - b.y)) / ballSpeed
            : 0.0;
        bool closeEnoughToHelp = per.ballDist < 130.0 || intendedDist > per.ballDist + 45.0;
        bool usefulSupportRun = closeEnoughToHelp || intendedUnderPressure || toPlayerAlongBall > -20.0;
        cfLoosePassSupport = usefulSupportRun
            && intendedDist > INTENDED_COLLECT_DIST + 18.0
            && (per.ballDist < 140.0 || intendedUnderPressure);
    }

    // Rebound crash: a keeper parry is a free close-range chance — the
    // nearest attackers must attack the spill instantly.
    bool parryRebound = per.ballIsLoose && b.z <= AERIAL_HEIGHT
        && engine.lastLooseOrigin == LooseOrigin::GoalkeeperParry
        && canContest && per.ballDist < 230.0
        && pitch::distToOppGoal(player.x, player.team) < 360.0
        && b.lastTouchTeam != player.team;
    if (parryRebound) {
        double lead = ballSpeed > 30.0 ? std::min(ballSpeed / 260.0, 0.30) : 0.0;
        return Action{ActionType::Chase, 1.10, nullptr,
                      clamp(b.x + b.vx * lead, 10.0, PITCH_W - 10.0),
                      clamp(b.y + b.vy * lead, 10.0, PITCH_H - 10.0),
                      ActionPurpose::RecoverLoose};
    }

    if (activeKnockAheadRunner && per.ballIsLoose && b.z <= AERIAL_HEIGHT) {
        double lead = ballSpeed > 8.0 ? std::min(ballSpeed / 180.0, 0.35) : 0.0;
        return Action{ActionType::Chase, 1.0, nullptr,
                      clamp(b.x + b.vx * lead, 10.0, PITCH_W - 10.0),
                      clamp(b.y + b.vy * lead, 10.0, PITCH_H - 10.0),
                      ActionPurpose::RecoverLoose};
    }

    if (selfLooseTouch) {
        double lead = ballSpeed > 8.0 ? std::min(ballSpeed / 160.0, 0.34) : 0.0;
        return Action{ActionType::Chase, 1.12, nullptr,
                      clamp(b.x + b.vx * lead, 10.0, PITCH_W - 10.0),
                      clamp(b.y + b.vy * lead, 10.0, PITCH_H - 10.0),
                      ActionPurpose::RecoverOwnTouch};
    }

    // ── Lane interception: READ an opponent's pass and STEP INTO it ──
    // The reactive incomingLooseBall gate above only fires when the ball heads
    // straight AT the player (approachDot) within 100px — so a pass crossing
    // within a defender's reach, but not aimed at him, sailed past untouched
    // (the "why didn't he just step across?" misses). Here any contest-eligible
    // opponent the ball will pass within a stride of, soon enough to get there,
    // steps to the closest-approach point and cuts it out. The passer's own team
    // is excluded (lastTouchTeam), so this only helps the side WITHOUT the ball.
    if (canContest && !isIntendedReceiver && b.controllerId < 0 && b.z <= AERIAL_HEIGHT
        && ballSpeed > 45.0 && b.lastTouchTeam != player.team) {
        double t = ((player.x - b.x) * b.vx + (player.y - b.y) * b.vy) / (ballSpeed * ballSpeed);  // sec to closest approach
        if (t > 0.03 && t < 1.30) {
            double cx = b.x + b.vx * t, cy = b.y + b.vy * t;        // where the ball is nearest him
            double perp = dist(player.x, player.y, cx, cy);         // how far he must travel to the lane
            if (perp < 16.0 + 55.0 * t) {                          // G4 near-intercepts: realistic close-down (~55px/s + a stride), was 22+90*t which let a defender "teleport" 100-138px to magnetically cut a slow pass (the user's "weird near intercepts"); only genuinely reachable lanes now
                if (engine.passDebug) fprintf(stderr, "LANECUT id=%d t=%d perp=%d\n", player.id, (int)(engine.state.clockMs / 1000), (int)perp);
                return Action{ActionType::Chase, 1.06, nullptr,
                              clamp(cx, 10.0, PITCH_W - 10.0), clamp(cy, 10.0, PITCH_H - 10.0),
                              ActionPurpose::RecoverLoose};
            }
        }
    }

    // G1 crowding (converger cap): the NEAREST few recover a loose ball; a 4th+ teammate piling in just
    // builds the 6-player scrum the user flagged. Count teammates clearly closer to the ball — if this
    // player is the 4th+ closest (and not the intended receiver / not on an urgent run / not recovering his
    // own touch), he HOLDS SHAPE instead of converging. Pure geometry, no rng. The nearest 3 still recover,
    // so ball-recovery is kept; only the redundant pile-on is dropped (a modest goal cost is acceptable).
    int closerMates = 0;
    for (auto& o : engine.state.players) {
        if (o.team != player.team || o.id == player.id || o.role == Role::GK) continue;
        // Only teammates who can actually TAKE the ball count toward the
        // pile-on cap — after a scramble the closer men are often all
        // contest-blocked, and counting them made the one eligible player
        // hold shape while nobody collected (watched replay 0:17: the best-
        // placed man stood 38px from where the ball stopped and let an
        // ineligible teammate shepherd it out).
        if (!engine.canContestBall(o)) continue;
        if (dist(o.x, o.y, b.x, b.y) < per.ballDist - 2.0) closerMates++;
    }
    bool tooManyClosing = closerMates >= 3 && !isIntendedReceiver && !urgentLooseBallRun && !needsRecovery;
    if (!per.ballIsLoose || (!canContest && !urgentLooseBallRun) || tooManyClosing
        || (!isIntendedReceiver && per.ballDist > 180.0 && !needsRecovery && !urgentLooseBallRun && !cfLoosePassSupport && !nearestEligibleFreeBall))
        return Action{ActionType::Chase, 0.0};

    if (nearestEligibleFreeBall && !urgentLooseBallRun && !isIntendedReceiver) {
        double lead = ballSpeed > 20.0 ? std::min(ballSpeed / 240.0, 0.30) : 0.0;
        return Action{ActionType::Chase, 0.96, nullptr,
                      clamp(b.x + b.vx * lead, 10.0, PITCH_W - 10.0),
                      clamp(b.y + b.vy * lead, 10.0, PITCH_H - 10.0),
                      ActionPurpose::RecoverLoose};
    }

    if (urgentLooseBallRun) {
        double lead = incomingLooseBall ? std::min(arrivalTime * 0.35, 0.22) : 0.0;
        // A loose ball rolling within ONE STRIDE is taken, full stop — at a
        // flat 1.0 this chase kept coin-flipping against shape candidates
        // that reach ~1.0 with bonuses (watched replay 1:26: a defender stood
        // 17px off a 2-second rolling ball and let it pass).
        double urgency = incomingLooseBall && per.ballDist < 70.0 ? 1.15 : 1.0;
        return Action{ActionType::Chase, urgency, nullptr,
                      clamp(b.x + b.vx * lead, 10.0, PITCH_W - 10.0),
                      clamp(b.y + b.vy * lead, 10.0, PITCH_H - 10.0),
                      incomingLooseBall ? ActionPurpose::MeetIncoming : ActionPurpose::RecoverLoose};
    }

    if (isIntendedReceiver) {
        double lead = ballSpeed > 30.0 ? 0.2 + std::min(ballSpeed / 300.0, 0.5) : 0.0;
        return Action{ActionType::Chase, 1.0, nullptr,
                      clamp(b.x + b.vx * lead, 10.0, PITCH_W - 10.0),
                      clamp(b.y + b.vy * lead, 10.0, PITCH_H - 10.0),
                      ActionPurpose::Receive};
    }

    if (needsRecovery) {
        double lead = ballSpeed > 20.0 ? std::min(ballSpeed / 220.0, 0.32) : 0.0;
        return Action{ActionType::Chase, 1.0, nullptr,
                      clamp(b.x + b.vx * lead, 10.0, PITCH_W - 10.0),
                      clamp(b.y + b.vy * lead, 10.0, PITCH_H - 10.0),
                      ActionPurpose::RecoverLoose};
    }

    if (cfLoosePassSupport) {
        double lead = std::min(ballSpeed / 280.0, 0.26);
        return Action{ActionType::Chase, 0.70, nullptr,
                      clamp(b.x + b.vx * lead, 10.0, PITCH_W - 10.0),
                      clamp(b.y + b.vy * lead, 10.0, PITCH_H - 10.0),
                      ActionPurpose::RecoverLoose};
    }

    bool isDef = isDefenderRole();
    // Hold shape rather than chase a distant ball outside this role's zone. The
    // per-role trigger distance + zone geometry (CB own-half >120px, FB/WM own
    // flank >100/80px, CM middle third >100px, CF near opp goal >80px) now lives
    // as abandonsDistantChase() overrides on the role classes.
    if (abandonsDistantChase(per, b)) return Action{ActionType::Chase, 0.0};

    double sc = per.ballDist < 50.0 ? 0.90 : per.ballDist < 100.0 ? 0.75 : 0.55;
    sc -= per.ballDist / 180.0 * 0.3;

    // Press the backpass: a ball rolling to the OPPOSING KEEPER deep in his
    // territory is a pressing trigger, not a hold-shape moment — the nearest
    // forward hunts the reception to force the rushed clearance (watched
    // replay 0:21: the striker jogged away mid-roll because the hold-shape
    // drop kept outbidding this chase, flip-flopping his target every tick).
    if (Player* rcvGk = engine.playerById(b.intendedReceiverId)) {
        if (rcvGk->team != player.team && rcvGk->role == Role::GK
            && pitch::forwardProgress(rcvGk->x, rcvGk->team) < 220.0
            && per.ballDist < 280.0 && per.amClosestToBall)
            sc += 0.30;
    }

    if (per.amClosestToBall) sc += 0.12;
    if (per.anyOpponentCloserToBall) {
        double ms = attrFactor(player.attrs.speed) * SPEED_SPRINT;
        if (per.ballDist / std::max(ms, 1.0) < 1.5) sc += 0.10;
    }

    double bs = ballSpeed;
    double la = bs > 30.0 ? 0.3 + std::min(bs / 200.0, 0.8) : 0.0;

    if (bs > 15.0 && per.ballDist > 20.0) {
        double toMeX = player.x - b.x, toMeY = player.y - b.y;
        double toMeDist = std::sqrt(toMeX * toMeX + toMeY * toMeY);
        if (toMeDist > 1.0) {
            double dot = (b.vx * toMeX + b.vy * toMeY) / (bs * toMeDist);
            if (dot > 0.4) sc += 0.12;
            if (dot > 0.7) sc += 0.10;
        }
    }

    auto* rp = engine.qRecentPass();
    if (rp && engine.state.clockMs - rp->clockMs < 800.0) {
        if (rp->team != player.team) {
            double rdx = rp->vx, rdy = rp->vy;
            double rd = std::sqrt(rdx * rdx + rdy * rdy);
            if (rd > 1.0) {
                double toLine = ((player.x - rp->bx) * rdx + (player.y - rp->by) * rdy) / (rd * rd);
                double perp = std::sqrt(
                    (player.x - rp->bx - toLine * rdx) * (player.x - rp->bx - toLine * rdx)
                  + (player.y - rp->by - toLine * rdy) * (player.y - rp->by - toLine * rdy));
                if (perp < 60.0 && toLine > 0.1 && toLine < 1.2) sc += 0.12;
            }
        }
    }

    if (isDef) {
        if (pitch::distToOwnGoal(b.x, player.team) < WIDE_DANGER_DIST) sc += 0.20;
        if (pitch::distToOwnGoal(b.x, player.team) < PERIMETER_GOAL_DIST) sc += 0.15;
    }

    // Added time: chase harder when ball in defending final third
    if (engine.phase.addedTimeActive && engine.phase.half == 2) {   // 2nd-half stoppage only
        bool inDefThird = pitch::inOwnDefensiveThird(b.x, player.team);
        if (inDefThird) sc += 0.12;
    }

    // Long leads must respect the flight model: linear projection on a fast
    // ball overshoots the real stopping point by 100px+ (drag + the bounce's
    // 30% horizontal kill), which had whole groups overrunning a dying cross.
    double leadX, leadY;
    engine.predictBallPos(la, leadX, leadY);
    return Action{ActionType::Chase, clamp(sc, 0.0, 1.0), nullptr,
                  clamp(leadX, 10.0, PITCH_W - 10.0),
                  clamp(leadY, 10.0, PITCH_H - 10.0)};
}

// ══════════════════════════════════════════════════════════════════════════════
// bp() — best-position (off-ball positioning)
// ══════════════════════════════════════════════════════════════════════════════
