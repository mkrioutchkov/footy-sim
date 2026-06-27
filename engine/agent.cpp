#include "engine.h"
#include "agent.h"
#include "agent_helpers.h"


// tick()
// ══════════════════════════════════════════════════════════════════════════════

PitchArea PlayerAI::currentPitchArea() const {
    double ownGoalX = ownGoalXFor(player.team);
    double oppGoalX = goalXFor(player.team);
    double fd = fdFor(player.team);
    double progress = (player.x - ownGoalX) * fd;
    double halfPitch = PITCH_W * 0.5;
    double centralDist = std::abs(player.y - PITCH_H / 2.0);
    bool wide = centralDist > 140.0;
    
    if (std::abs(player.x - ownGoalX) < PENALTY_AREA_W && centralDist < PENALTY_AREA_H / 2.0)
        return PitchArea::OwnBox;
    if (progress < halfPitch * 0.33)
        return wide ? (player.y < PITCH_H / 2.0 ? PitchArea::WideLeft : PitchArea::WideRight) : PitchArea::OwnThird;
    if (progress < halfPitch * 0.66)
        return wide ? (player.y < PITCH_H / 2.0 ? PitchArea::WideLeft : PitchArea::WideRight) : PitchArea::MidThird;
    if (std::abs(player.x - oppGoalX) < PENALTY_AREA_W && centralDist < PENALTY_AREA_H / 2.0)
        return PitchArea::OppBox;
    return wide ? (player.y < PITCH_H / 2.0 ? PitchArea::WideLeft : PitchArea::WideRight) : PitchArea::FinalThird;
}

void PlayerAI::tick(double sdt) {
    if (isGoalkeeper()) return;
    facing = player.facing;

    stunLockTicks = std::max(0, stunLockTicks - 1);
    shotCooldown = std::max(0, shotCooldown - 1);
    skillMoveCooldown = std::max(0, skillMoveCooldown - 1);

    if (ballMemoryAge == 0 && ballMemoryX == 0 && ballMemoryY == 0) {
        ballMemoryX = engine.state.ball.x;
        ballMemoryY = engine.state.ball.y;
    }

    bool ic = (engine.state.ball.controllerId == player.id);
    if (ic) holdTicks++;
    else    holdTicks = 0;

    // audit #1: sustained on-the-ball contest timer — how long this player has been glued within
    // TACKLE_RANGE of an OPPONENT carrier's grounded ball. scoreTackle resolves the contest past
    // ~0.15s so a defender can't ride glued without ever challenging (the "no-tackle overlap" bug).
    {
        const auto& cb = engine.state.ball;
        Player* cc = cb.controllerId >= 0 ? engine.playerById(cb.controllerId) : nullptr;
        bool contesting = cc && cc->team != player.team && cb.z < 15.0
                          && dist(player.x, player.y, cb.x, cb.y) < TACKLE_RANGE;
        ballContestTicks = contesting ? ballContestTicks + 1 : 0;
    }

    if (cachedPerception.has_value() && cachedPerception->ballControllerId != engine.state.ball.controllerId) {
        if (cachedPerception->ballIsLoose
            && engine.state.ball.controllerId >= 0
            && dist(player.x, player.y, engine.state.ball.x, engine.state.ball.y) <= PRE_CONTACT_CHASE_REACH)
        {
            engine.notePreventedStaleGrab(player);
        }
        cachedPerception.reset();
    }

    if (engine.state.ball.intendedReceiverId == player.id) cachedPerception.reset();

    Perception per = getCachedPerception();

    GameContext gctx = buildContext();
    SmallVector<Action, 24> aff = evaluateActions(per, ic, gctx);
    Action choice = resolveChoice(aff);

    auditDefensiveMovement(choice);
    executeAction(choice, sdt, aff);

    if (std::fmod(engine.state.clockMs, 500.0) < 20.0) {
        SmallVector<Action, 24> top = aff;
        std::sort(top.begin(), top.end(),
                  [](const Action& x, const Action& y) { return x.score > y.score; });
        if (top.size() > 5) top.resize(5);
        engine.logPlayerDecision(player.id, choice.type, choice.score,
                                 top, player.x, player.y, choice.purpose);
        if (ic) {
            auto shootOpt = std::find_if(aff.begin(), aff.end(),
                                         [](const Action& x) { return x.type == ActionType::Shoot && x.score >= 0.0; });
            if (shootOpt != aff.end()) {
                engine.auditCredibleShotWindow(player, shootOpt->audit.distance,
                    shootOpt->audit.angleDeg, per.pressureCount, std::string(to_string(choice.type)));
            }
        }
    }

    if (ic && per.pressureCount == 0 && choice.type != ActionType::Shoot && choice.type != ActionType::Hold
        && std::fmod(engine.state.clockMs, 500.0) < 20.0)
    {
        double gx = goalXFor(player.team);
        if (std::abs(player.x - gx) < 120.0) {
            auto shootOpt = std::find_if(aff.begin(), aff.end(),
                                         [](const Action& x) { return x.type == ActionType::Shoot; });
            if (shootOpt != aff.end() && shootOpt->score > 0.20) {
                double distance = shootOpt->audit.distance;
                if (distance == 0.0) distance = std::hypot(player.x - gx, player.y - PITCH_H / 2.0);
                double angleDeg = shootOpt->audit.angleDeg;
                if (angleDeg == 0.0) angleDeg = engine.goalOpeningAngleDeg(player.x, player.y, gx);
                engine.logQualityFlag(QualityFlag::WhyNoShoot, player.id, player.role,
                    distance, angleDeg, shootOpt->score, choice.type, choice.score);
                engine.captureDecisionMoment("why_no_shoot", player,
                    choice.type, choice.score, shootOpt->score,
                    distance, angleDeg, per.pressureCount,
                    8000.0, std::string("why_no_shoot:") + std::string(to_string(player.team)));
            }
        }
    }

    lastPosX = player.x;
    lastPosY = player.y;
}

// ══════════════════════════════════════════════════════════════════════════════
// ctx() — game context
// ══════════════════════════════════════════════════════════════════════════════
GameContext PlayerAI::buildContext() {
    int ms = engine.state.homeScore, os = engine.state.awayScore;
    int my = (player.team == Team::Home) ? ms : os;
    int op = (player.team == Team::Home) ? os : ms;
    int d  = my - op;
    double tl = std::max(0.0, engine.matchDurationMs - engine.state.clockMs);
    return { d, tl, engine.phase.half };
}

// ══════════════════════════════════════════════════════════════════════════════
// ev() — evaluate actions
// ══════════════════════════════════════════════════════════════════════════════
SmallVector<Action, 24> PlayerAI::evaluateActions(const Perception& per, bool ic, const GameContext& ctx) {
    SmallVector<Action, 24> a;
    if (ic) {
        if (stunLockTicks > 0) {
            // Settle along the current facing — a time-rotating target made the
            // carrier orbit it and pirouette at the turn cap after every collection.
            double tx = player.x + std::cos(player.facing) * 3.0;
            double ty = player.y + std::sin(player.facing) * 3.0;
            return { Action{ActionType::Dribble, 1.0, nullptr, tx, ty, ActionPurpose::Keep} };
        }
        if (shotCooldown > 0) {
            double gx = goalXFor(player.team);
            if (std::abs(player.x - gx) < 150.0) {
                auto cpv = this->scorePass(per, ctx);
                auto csv = this->scoreShot(per, ctx);
                auto cdv = this->scoreDribble(per, ctx);
                a = cpv;
                a.push_back(csv);
                a.push_back(cdv);
            } else {
                Action d = this->scoreDribble(per, ctx);
                d.score = 0.6;
                return { d };
            }
        } else {
            auto cpv = this->scorePass(per, ctx);
            auto csv = this->scoreShot(per, ctx);
            auto cdv = this->scoreDribble(per, ctx);
            a = cpv;
            a.push_back(csv);
            a.push_back(cdv);
        }

        // ── Hoof under pressure ── A deep player swarmed with no safe outlet
        // boots it long upfield rather than gifting possession in a dangerous
        // area. Routed through Clear (scattered forcePassTo) so it's an honest
        // 50/50 clearance toward the forwards, not a measured pass.
        {
            double fdh = fdFor(player.team);
            double prog = (player.x - ownGoalXFor(player.team)) * fdh;
            if (prog < PITCH_W * 0.30 && per.pressureCount >= 2) {
                double bestSafe = 0.0;
                for (auto& x : a)
                    if (x.type == ActionType::Pass) bestSafe = std::max(bestSafe, x.audit.expectedCompletion);
                if (bestSafe < 0.60) {
                    Player* tgt = nullptr; double bestFx = -1e9;
                    for (auto& t : engine.state.players) {
                        if (t.team != player.team || t.id == player.id || t.role == Role::GK) continue;
                        double fx = (t.x - ownGoalXFor(player.team)) * fdh;
                        if (fx > bestFx) { bestFx = fx; tgt = &t; }
                    }
                    if (tgt) {
                        ActionAudit au;
                        au.distance = dist(player.x, player.y, tgt->x, tgt->y);
                        au.forwardProgress = (tgt->x - player.x) * fdh;
                        au.expectedCompletion = 0.4;
                        a.push_back(Action{ActionType::Pass, 0.74 + (per.pressureCount - 2) * 0.05,
                                           tgt, 0, 0, ActionPurpose::Clear, au});
                    }
                }
            }
        }

        int pc = per.pressureCount;
        double fd = fdFor(player.team);
        double progress = (player.x - ownGoalXFor(player.team)) * fd;
        bool carryLaunchZone = progress > PITCH_W * 0.42 && progress < PITCH_W * 0.78;
        bool hasGrassToCarry = per.nearestOpponentDist > 90.0 && pc == 0;
        for (auto& x : a) {
            if (x.type == ActionType::Pass)    x.score += pc * 0.04;
            if (x.type == ActionType::Shoot)   x.score += pc * 0.03;
            if (x.type == ActionType::Dribble && pc == 1) x.score += 0.10;
            if (x.type == ActionType::Dribble && pc >= 3) x.score -= 0.10;
            if (x.type == ActionType::Dribble && x.purpose == ActionPurpose::Space && carryLaunchZone && hasGrassToCarry) {
                x.score += spaceCarryRoleBonus();
            }
            bool earlyAttackingOutlet = x.type == ActionType::Pass
                && x.target
                && (x.target->role == Role::WM || x.target->role == Role::CF)
                && x.audit.forwardProgress > 8.0
                && x.audit.expectedCompletion > 0.68
                && x.audit.blockers <= 1
                && x.audit.receiverPressure <= 1;
            if (pc == 0 && x.type == ActionType::Pass && !earlyAttackingOutlet
                && x.purpose != ActionPurpose::Build
                && x.purpose != ActionPurpose::Switch
                && x.purpose != ActionPurpose::Cross
                && x.purpose != ActionPurpose::Cutback
                && x.purpose != ActionPurpose::Through) {
                if (holdTicks < 12) x.score -= 0.18;
                else if (holdTicks < 24) x.score -= 0.10;
            }
        }

        adjustActionScores(a, ic);
        return a;
    } else {
        a.push_back(this->scoreTackle(per, ctx));
        a.push_back(this->scoreMark(per, ctx));
        a.push_back(this->scoreChase(per));
        auto bpv = this->scorePositioning(per, ctx);
        a.insert(a.end(), bpv.begin(), bpv.end());
    }

    double gx = goalXFor(player.team);
    if (std::abs(player.x - gx) < 280.0) {
        for (auto& x : a) {
            if (x.type == ActionType::Shoot)                                  x.score += 0.06;
            if (x.type == ActionType::Pass && x.purpose == ActionPurpose::Through)        x.score += 0.12;
            if (x.type == ActionType::Dribble && x.purpose == ActionPurpose::Space)       x.score += 0.08;
        }
    }

    for (auto& x : a) {
        if (x.type == lastActionType && x.target && x.target->id == lastTargetId) x.score += ic ? 0.12 : 0.05;

        if (x.type == ActionType::Position && x.posX != 0 && x.posY != 0) {
            double td = std::sqrt((x.posX - player.targetX) * (x.posX - player.targetX)
                                + (x.posY - player.targetY) * (x.posY - player.targetY));
            if (td < 50.0) x.score += 0.07;
        }

        x.score += (engine.rng.random() - 0.5) * 0.03;
    }

    adjustActionScores(a, ic);
    return a;
}

void PlayerAI::adjustActionScores(SmallVector<Action, 24>& actions, bool isController) {
    if (!isController) return;
    for (auto& a : actions) {
        if (a.type == ActionType::Dribble) a.score += 0.10;
    }
}

Action PlayerAI::resolveChoice(SmallVector<Action, 24>& a) {
    std::sort(a.begin(), a.end(),
              [](const Action& x, const Action& y) { return x.score > y.score; });

    if (a.empty()) return Action{ActionType::Hold, 1.0};

    Action& best = a[0];
    bool ic = (engine.state.ball.controllerId == player.id);
    double gx = goalXFor(player.team);
    bool nearGoal = std::abs(player.x - gx) < NEAR_GOAL_DIST;
    bool inBox    = std::abs(player.x - gx) < PERIMETER_GOAL_DIST;

    // ── Decision pipeline: each phase can override with a better action ──

    if (Action* r = tryFreshBallOverride(a, best, ic, nearGoal)) return *r;

    // target_man_holdup: when this carrier is told to hold it up, raise the
    // "no good option → shield" threshold so a MARGINAL pass/dribble gives way to
    // shielding-and-waiting for support — but ONLY when pressured AND no team-mate
    // has arrived close, and never in/near the box (there he should shoot/feed).
    // Gated on holdUpBias > 0 (default 0 => threshold unchanged => match byte-identical).
    double holdUpThresh = 0.0;
    if (ic && !inBox && !nearGoal && engine.directiveBias[player.id].holdUpBias > 0.0) {
        double nearOppD = 1e9, nearMateD = 1e9;
        for (auto& o : engine.state.players) {
            if (o.role == Role::GK || o.sentOff || o.id == player.id) continue;
            double d = dist(player.x, player.y, o.x, o.y);
            if (o.team != player.team) nearOppD = std::min(nearOppD, d);
            else                       nearMateD = std::min(nearMateD, d);
        }
        // pressed (opp within 46px, same radius the shield path uses) and support
        // not yet arrived (no team-mate within 150px) → wait for the runner.
        if (nearOppD < 46.0 && nearMateD > 150.0)
            holdUpThresh = engine.directiveBias[player.id].holdUpBias;   // up to +0.30 onto the 0.22 open-play gate
    }

    if (ic && best.score < (inBox ? 0.0 : nearGoal ? 0.03 : 0.22 + holdUpThresh)) {
        if (Action* r = tryLowScoreFallback(a, best)) return *r;
        if (!isGoalkeeper()) {
            // Pinned with no good option: SHIELD and work a passing angle (Hold ->
            // shield-and-shift) rather than dribbling forward INTO the presser and
            // losing it. Only when genuinely pressured; unpressured, drive into space.
            double nearOpp = 1e9;
            for (auto& o : engine.state.players)
                if (o.team != player.team && o.role != Role::GK && !o.sentOff)
                    nearOpp = std::min(nearOpp, dist(player.x, player.y, o.x, o.y));
            if (nearOpp < 46.0) return Action{ActionType::Hold, 1.0};
            double fd = fdFor(player.team);
            double side = player.y < PITCH_H / 2.0 ? 1.0 : -1.0;
            return Action{ActionType::Dribble, 0.20, nullptr,
                          clamp(player.x + fd * 55.0, 35.0, PITCH_W - 35.0),
                          clamp(player.y + side * 34.0, 35.0, PITCH_H - 35.0),
                          ActionPurpose::Space};
        }
        return Action{ActionType::Hold, 1.0};
    }

    if (Action* r = tryLongCarryOverride(a, best, ic)) return *r;

    auto& bb = engine.blackboards[GameEngine::teamIndex(player.team)];
    if (Action* r = managePressSlots(a, best, bb)) return *r;

    auditBackpass(a, best, ic);

    if (Action* r = tryClearPathOverride(a, best, ic, gx)) return *r;
    if (Action* r = tryPressureSafetyPass(a, best, ic, nearGoal)) return *r;
    if (Action* r = tryFinalThirdOverride(a, best, ic)) return *r;
    if (Action* r = tryNearGoalShotBias(a, best, ic, nearGoal, gx)) return *r;

    return best;
}

// ══════════════════════════════════════════════════════════════════════════════
// ex() — execute chosen action
// ══════════════════════════════════════════════════════════════════════════════
void PlayerAI::executeAction(Action& a, double sdt, SmallVector<Action, 24>& actions) {
    auto& p = player;
    auto& b = engine.state.ball;

    lastActionType = a.type;
    lastPurpose = a.purpose;
    lastTargetId = a.target ? a.target->id : -1;

    if (a.type != ActionType::Dribble) p.dribbleType = 0;

    if (a.type == ActionType::Pass && a.target) {
        PassSelectionAudit audit = passSelectionAudit(a, actions);
        bool released;
        if (a.purpose == ActionPurpose::Clear) {
            engine.forcePassTo(p, *a.target, &audit);
            released = true;
        } else {
            released = engine.passBallTo(p, *a.target, a.purpose == ActionPurpose::Through, false, &audit);
        }
        if (released) {
            lastPassTargetId = a.target->id;
            recentPassTarget = a.target->id;
            recentPassTime = engine.state.clockMs;
            engine.emitEvent("pass", p.x, p.y, p.id, a.target->id);
            auto& bb = engine.blackboards[GameEngine::teamIndex(p.team)];
            bb.oneTwo = TeamBlackboard::OneTwo{ p.id, a.target->id, engine.state.clockMs + 2000.0 };
            // Short pass in the opponent's half: move again quickly so the
            // give-and-go is physically possible — a ~1s freeze after every
            // pass meant the one-two runner stood still through the window.
            double passDist = dist(p.x, p.y, a.target->x, a.target->y);
            bool combinationZone = (fdFor(p.team) > 0.0 ? p.x > HALF_X - 90.0 : p.x < HALF_X + 90.0);
            stunLockTicks = (passDist < 190.0 && combinationZone)
                ? 16 + static_cast<int>(engine.rng.random() * 9)
                : 50 + static_cast<int>(engine.rng.random() * 21);
        } else {
            stunLockTicks = 4;
        }
    }
    else if (a.type == ActionType::Shoot) {
        ShotSelectionAudit audit = shotSelectionAudit(a, actions);
        engine.shootBall(p, &audit);
        stunLockTicks = 20;
    }
    else if (a.type == ActionType::Dribble) {
        executeDribble(a, sdt);
    }
    else if (a.type == ActionType::Tackle) {
        if (a.target && dist(p.x, p.y, a.target->x, a.target->y) <= TACKLE_RANGE
            && engine.attemptTackle(p, *a.target))
        {
            engine.emitEvent("tackle", (p.x + a.target->x) / 2.0, (p.y + a.target->y) / 2.0, p.id, a.target->id);
            bool cleanWin = engine.state.ball.controllerId == p.id;
            p.tackleAnim = cleanWin ? 220.0 : 800.0;
            if (cleanWin) {
                stunLockTicks = 16;
            }
        } else {
            p.targetX = a.target ? a.target->x : p.x;
            p.targetY = a.target ? a.target->y : p.y;
        }
    }
    else if (a.type == ActionType::Mark && a.target) {
        double leadX = a.target->x + a.target->vx * 0.45;
        double leadY = a.target->y + a.target->vy * 0.45;
        double goalSide = p.team == Team::Home ? -1.0 : 1.0;
        p.targetX = clamp(leadX + goalSide * 18.0, leadX - 45.0, leadX + 45.0);
        p.targetY = clamp(leadY, 30.0, PITCH_H - 30.0);
    }
    else if (a.type == ActionType::Chase) {
        double tx = (a.posX != 0) ? a.posX : b.x;
        double ty = (a.posY != 0) ? a.posY : b.y;
        p.targetX = tx;
        p.targetY = ty;
        double ms = attrFactor(p.attrs.speed) * SPEED_SPRINT;
        double cdx = tx - p.x, cdy = ty - p.y;
        double cd = std::sqrt(cdx * cdx + cdy * cdy);
        if (cd > 1.0) {
            bool urgentChase = a.purpose == ActionPurpose::RecoverOwnTouch
                             || a.purpose == ActionPurpose::RecoverLoose
                             || a.purpose == ActionPurpose::MeetIncoming
                             || a.purpose == ActionPurpose::Receive;
            double steer = urgentChase ? 0.34 : 0.15;
            p.vx = lerp(p.vx, (cdx / cd) * ms, steer);
            p.vy = lerp(p.vy, (cdy / cd) * ms, steer);
        }
    }
    else if (a.type == ActionType::Position) {
        p.targetX = (a.posX != 0) ? a.posX : p.homeX;
        p.targetY = (a.posY != 0) ? a.posY : p.homeY;
        if (a.purpose == ActionPurpose::Task) {
            auto* task = engine.assignmentFor(p.id);
            if (task) engine.noteTaskSelection(p, task->role);
            }
    }
    else if (a.type == ActionType::Hold) {
        if (b.controllerId == p.id) {
            p.dribbleType = 1;   // close control — shield the ball
            double fd = fdFor(p.team);
            auto near = engine.nearPlayers(p, 60.0);
            Player* closestOpp = nullptr;
            double closestD = 1e9;
            for (auto* o : near) {
                if (o->team != p.team) {
                    double d = dist(p.x, p.y, o->x, o->y);
                    if (d < closestD) { closestD = d; closestOpp = o; }
                }
            }
            // SHIELD-AND-SHIFT: pinned with no good pass — rather than blindly backing
            // away, pick the team-mate most worth opening a lane to and slide to the
            // side that clears the blocking defender out of that lane (the presser's
            // blind side). Keeps possession and MAKES an angle instead of forcing it.
            Player* angleTarget = nullptr;
            double bestT = -1e9;
            for (auto& tm : engine.state.players) {
                if (tm.team != p.team || tm.id == p.id || tm.role == Role::GK || tm.sentOff) continue;
                double dd = dist(p.x, p.y, tm.x, tm.y);
                if (dd < 70.0 || dd > 360.0) continue;
                double fwd = (tm.x - p.x) * fd;                     // forward progress on offer
                double recOpp = 1e9;
                for (auto& o2 : engine.state.players)
                    if (o2.team != p.team && o2.role != Role::GK && !o2.sentOff)
                        recOpp = std::min(recOpp, dist(o2.x, o2.y, tm.x, tm.y));
                double tsc = fwd * 0.012 + std::min(recOpp, 130.0) * 0.02 - dd * 0.004;
                if (tsc > bestT) { bestT = tsc; angleTarget = &tm; }
            }
            if (angleTarget && closestOpp) {
                double lx = angleTarget->x - p.x, ly = angleTarget->y - p.y;
                double ll = std::max(1.0, std::hypot(lx, ly));
                double nx = -ly / ll, ny = lx / ll;                 // perpendicular to the pass lane
                if ((closestOpp->x - p.x) * nx + (closestOpp->y - p.y) * ny > 0.0) { nx = -nx; ny = -ny; }
                p.targetX = clamp(p.x + nx * 46.0 - fd * 6.0, 35.0, PITCH_W - 35.0);
                p.targetY = clamp(p.y + ny * 46.0, 35.0, PITCH_H - 35.0);
                engine.markActiveShield(p.id);                      // back to the man while I work the angle
            } else if (closestOpp) {
                double ax = p.x - closestOpp->x;
                double ay = p.y - closestOpp->y;
                double ad = std::hypot(ax, ay);
                if (ad < 3.0) {
                    double side = p.y < PITCH_H / 2.0 ? 1.0 : -1.0;
                    ax = fd * 22.0; ay = side * 52.0; ad = std::hypot(ax, ay);
                }
                p.targetX = clamp(p.x + ax / std::max(1.0, ad) * 58.0, 35.0, PITCH_W - 35.0);
                p.targetY = clamp(p.y + ay / std::max(1.0, ad) * 58.0, 35.0, PITCH_H - 35.0);
                engine.markActiveShield(p.id);
            } else {
                p.targetX = clamp(goalXFor(p.team), 40.0, PITCH_W - 40.0);
                p.targetY = clamp(p.y + (engine.rng.random() - 0.5) * 20.0, 40.0, PITCH_H - 40.0);
            }
        }
    }

    if (engine.state.ball.controllerId != p.id) {
        applyMovement(sdt);
        if (a.type == ActionType::Chase) tryCollectAfterChase();
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// executeDribble() — extracted from executeAction
// ══════════════════════════════════════════════════════════════════════════════
void PlayerAI::executeDribble(Action& a, double /*sdt*/) {
    auto& p = player;

    p.targetX = (a.posX != 0) ? a.posX : (goalXFor(p.team));
    p.targetY = (a.posY != 0) ? a.posY : p.y;

    // Count nearby opponents first to decide wobble/shielding
    int nearbyOpps = 0;
    double nearestOppDist = 1e9;
    CarrierPressure cp = assessCarrierPressure(engine, p);
    for (auto& o : engine.state.players) {
        if (o.team != p.team && o.role != Role::GK) {
            double d = dist(p.x, p.y, o.x, o.y);
            nearestOppDist = std::min(nearestOppDist, d);
            if (d < 55.0) nearbyOpps++;
        }
    }
    if (cp.score > 0.80) nearbyOpps = std::max(nearbyOpps, 2);

    // ── Skill move: pressed 1v1, try to beat the man with a sharp cut ──
    // Success scales with creativity; the beaten defender is briefly frozen
    // and locked out of an immediate tackle.
    bool ownDefensiveThird = (fdFor(p.team) > 0.0) ? p.x < PITCH_W / 3.0 : p.x > PITCH_W * 2.0 / 3.0;
    if (skillMoveCooldown == 0 && cp.nearestPlayer && nearbyOpps <= 2 && !ownDefensiveThird
        && cp.score > 0.72 && nearestOppDist > 18.0 && nearestOppDist < 58.0) {
        double skillChance = 0.013 + attrFactor(p.attrs.creativity) * 0.050;   // G3 razzle: trimmed ~0.6x (was 0.022+0.085) toward real ~20-30/match; goal-safe (skill-moves don't score)
        // Take-ons live in the final third — that's where beating a man is
        // worth the risk.
        bool inFinalThirdAtk = (fdFor(p.team) > 0.0) ? p.x > PITCH_W * 2.0 / 3.0 : p.x < PITCH_W / 3.0;
        if (inFinalThirdAtk) skillChance *= 1.3;   // BORIS_WATCH G3: trim the final-third take-on spike (1.6->1.3); skill-moves don't score -> goal-safe
        if (engine.rng.random() < skillChance) {
            Player* def = cp.nearestPlayer;
            double fd = fdFor(p.team);
            double ddx = def->x - p.x, ddy = def->y - p.y;
            double dd = std::max(1.0, std::hypot(ddx, ddy));
            bool defAhead = (ddx * fd) / dd > 0.55;
            const char* moveType;
            if (defAhead && nearestOppDist < 28.0 && attrFactor(p.attrs.creativity) > 0.80) {   // BORIS_WATCH: nutmeg only for the most creative at very close range (real nutmegs ~1-3/match)
                // Nutmeg: straight through the squared-up defender's ground.
                p.targetX = clamp(p.x + ddx / dd * (dd + 64.0), 30.0, PITCH_W - 30.0);
                p.targetY = clamp(p.y + ddy / dd * (dd + 64.0), 30.0, PITCH_H - 30.0);
                engine.agentFor(*def)->stunLock(30);
                engine.blockReboundFor(def->id, 950);
                moveType = "nutmeg";
            } else if (defAhead) {
                // Drag-back: turn away from the presser and open up sideways.
                double side = (p.y < PITCH_H / 2.0) ? 1.0 : -1.0;
                p.targetX = clamp(p.x - fd * 26.0, 30.0, PITCH_W - 30.0);
                p.targetY = clamp(p.y + side * 58.0, 30.0, PITCH_H - 30.0);
                engine.agentFor(*def)->stunLock(16);
                engine.blockReboundFor(def->id, 600);
                moveType = "dragback";
            } else {
                bool finalThird = (fd > 0.0) ? p.x > PITCH_W * 2.0 / 3.0 : p.x < PITCH_W / 3.0;
                if (finalThird) {
                    // Take-on: beat the man TOWARD goal — slip past his outside
                    // shoulder and attack the box, not the touchline.
                    double side = (def->y >= p.y) ? -1.0 : 1.0;
                    p.targetX = clamp(def->x + fd * 56.0, 30.0, PITCH_W - 30.0);
                    p.targetY = clamp(def->y + side * 44.0, 30.0, PITCH_H - 30.0);
                    engine.agentFor(*def)->stunLock(24);
                    engine.blockReboundFor(def->id, 800);
                    moveType = "skill";
                } else {
                    // Cut to whichever side has fewer bodies.
                    auto sideCrowd = [&](double sy) {
                        int n = 0;
                        for (auto& o : engine.state.players) {
                            if (o.team == p.team || o.role == Role::GK) continue;
                            if (dist(p.x + fd * 42.0, sy, o.x, o.y) < 75.0) n++;
                        }
                        return n;
                    };
                    double upY = clamp(p.y - 64.0, 30.0, PITCH_H - 30.0);
                    double dnY = clamp(p.y + 64.0, 30.0, PITCH_H - 30.0);
                    p.targetX = clamp(p.x + fd * 52.0, 30.0, PITCH_W - 30.0);
                    p.targetY = sideCrowd(upY) <= sideCrowd(dnY) ? upY : dnY;
                    engine.agentFor(*def)->stunLock(22);
                    engine.blockReboundFor(def->id, 700);
                    moveType = "skill";
                }
            }
            engine.emitEvent(moveType, p.x, p.y, p.id, def->id);
            engine.stats.recordSkillMove();
            skillMoveCooldown = 450;                       // ~7.5s between tricks (G3 razzle: was 300/~5s — trim skill-move spam)
        } else {
            skillMoveCooldown = 400;                       // failed read — wait ~6.7s (G3: was 280)
        }
    }

    // Wobble only in open space — suppress under pressure. Sway laterally
    // around the run direction, scaled down for short targets: full-size sway
    // on a ~10px target vector whipped the direction (and the carrier's
    // facing) around every tick — the "spinning like a madman" look.
    if (nearestOppDist > 80.0) {
        double dxT = p.targetX - p.x, dyT = p.targetY - p.y;
        double dT = std::hypot(dxT, dyT);
        if (dT > 24.0) {
            // ~1.6s weave period — the old 0.5s cycle read as twitching.
            double sway = std::sin(engine.state.clockMs * 0.004 + p.id * 2.3) * 12.0
                * clamp(dT / 110.0, 0.0, 1.0);
            p.targetX += -dyT / dT * sway;
            p.targetY +=  dxT / dT * sway;
        }
    }

    double distToTarget = std::sqrt((p.targetX - p.x) * (p.targetX - p.x)
                                  + (p.targetY - p.y) * (p.targetY - p.y));

    int oppsInPath = 0;
    double fd = fdFor(p.team);
    for (auto& o : engine.state.players) {
        if (o.team != p.team && o.role != Role::GK) {
            double pathDist = std::abs(o.x - p.x);
            double lateralDist = std::abs(o.y - p.y);
            if (pathDist < 200.0 && lateralDist < 40.0 && ((fd > 0 && o.x > p.x) || (fd < 0 && o.x < p.x)))
                oppsInPath++;
        }
    }

    // Knock-ahead: clear lanes with enough grass to run into.
    bool advancedEnough = (fd > 0 && p.x > HALF_X - 100.0) || (fd < 0 && p.x < HALF_X + 100.0);
    bool clearPath = oppsInPath == 0;
    bool spaceAhead = nearestOppDist > 180.0;
    bool openGrass = nearestOppDist > 220.0;
    bool longDistToTarget = distToTarget > 90.0;

    // Check if a teammate can collect (within ~175px of launch point)
    bool teammateSupport = false;
    double launchX = p.x + fd * DRIBBLE_KNOCK_OFFSET;
    double launchY = p.y;
    for (auto& o : engine.state.players) {
        if (o.team == p.team && o.id != p.id && o.role != Role::GK) {
            double d = dist(launchX, launchY, o.x, o.y);
            if (d < 175.0) { teammateSupport = true; break; }
        }
    }

    // Flank bonus: knock-aheads on the flank are safer (less central traffic)
    bool onFlank = std::abs(p.y - PITCH_H / 2.0) > 120.0;
    bool finalThird = (fd > 0.0) ? p.x > PITCH_W * 2.0 / 3.0 : p.x < PITCH_W / 3.0;
    bool finalThirdBurst = finalThird && distToTarget > 110.0 && nearestOppDist > 180.0 && clearPath;

    // Open burst: clear path with support, flank safety, or very obvious space.
    bool openBurst = longDistToTarget && spaceAhead && clearPath && advancedEnough
                    && (teammateSupport || onFlank || openGrass || finalThirdBurst);

    // Speculative burst: creative player with some space, advanced enough.
    bool speculativeBurst = distToTarget > 150.0 && nearestOppDist > 75.0 && clearPath
                           && advancedEnough && p.attrs.creativity >= 65.0
                           && (teammateSupport || onFlank || openGrass);

    bool activeLongCarry = engine.carrierTracker.carryTrackerId == p.id && engine.carrierTracker.carryPathDistance >= 95.0;
    bool needsCarryShotWindow = activeLongCarry && engine.carrierTracker.carryPathDistance < 220.0 && clearPath
        && nearestOppDist > 135.0 && distToTarget > 120.0 && advancedEnough;
    // Breakaway: corridor to goal is clear and the nearest opponent is a chaser,
    // not a blocker — burst at sprint pace instead of letting recovery runners
    // (who move ~50% faster than a close dribble) reel the carrier in.
    double distToGoalX = std::abs(p.x - goalXFor(p.team));
    bool targetForward = (fd > 0.0 && p.targetX > p.x + 30.0) || (fd < 0.0 && p.targetX < p.x - 30.0);
    bool breakawayBurst = clearPath && advancedEnough && distToGoalX < 480.0
        && nearestOppDist > 40.0 && distToTarget > 90.0 && targetForward;
    bool mayBurst = engine.canKnockBallAhead(p.id) && cp.score < (needsCarryShotWindow ? 0.82 : 0.65)
        && (openBurst || speculativeBurst || finalThirdBurst || needsCarryShotWindow || breakawayBurst);
    int dribbleType = mayBurst ? 3 : (nearbyOpps >= 2 ? 1 : 2);

    bool newEpisode = (p.dribbleType != dribbleType);
    if (newEpisode) {
        engine.stats.recordDribble(dribbleType);
    }
    p.dribbleType = dribbleType;
    if (dribbleType == 3 && (newEpisode || needsCarryShotWindow)) engine.knockBallAhead(p, p.targetX, p.targetY);

    double oppGoalX = goalXFor(p.team);
    if ((fd == 1.0 && p.targetX < p.x - 10.0) || (fd == -1.0 && p.targetX > p.x + 10.0)) {
        if (std::abs(p.x - oppGoalX) < 300.0) {
            int closeOpps = 0;
            for (auto& o : engine.state.players) {
                if (o.team != p.team && o.role != Role::GK && dist(p.x, p.y, o.x, o.y) < 60.0) closeOpps++;
            }
            if (closeOpps == 0) {
                int myScore  = (p.team == Team::Home) ? engine.state.homeScore : engine.state.awayScore;
                int oppScore = (p.team == Team::Home) ? engine.state.awayScore : engine.state.homeScore;
                bool isTimeWasting = (myScore > oppScore && engine.state.clockMs > 60000.0);
                engine.logQualityFlag(isTimeWasting ? QualityFlag::TimeWastingDribble : QualityFlag::BackwardDribble,
                                      p.id, p.role, (double)p.targetX, 0.0, 0.0, "", 0.0);
            }
        }
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// gp() — get perception (cached)
// ══════════════════════════════════════════════════════════════════════════════
PassSelectionAudit PlayerAI::passSelectionAudit(const Action& choice,
                                                   const SmallVector<Action, 24>& actions)
{
    const auto& chosen = choice.audit;
    if (!choice.target) return {};

    const Action* safer = nullptr;
    double saferComp = 0;
    for (auto& a : actions) {
        if (a.type != ActionType::Pass || !a.target || a.target->id == choice.target->id) continue;
        if (!a.audit.expectedCompletion || !a.audit.forwardProgress) continue;
        if (a.audit.expectedCompletion >= chosen.expectedCompletion + 0.12
            && a.audit.forwardProgress >= chosen.forwardProgress - 35.0
            && a.score >= choice.score - 0.04)
        {
            if (!safer || a.audit.expectedCompletion > saferComp) {
                safer = &a;
                saferComp = a.audit.expectedCompletion;
            }
        }
    }

    PassSelectionAudit out;
    out.score             = choice.score;
    out.distance          = chosen.distance;
    out.forwardProgress   = chosen.forwardProgress;
    out.expectedCompletion = chosen.expectedCompletion;
    out.blockers          = chosen.blockers;
    out.receiverPressure  = chosen.receiverPressure;
    out.purpose           = choice.purpose;
    out.saferOptionTargetId  = safer ? safer->target->id : -1;
    out.saferOptionScore      = safer ? safer->score : 0;
    out.saferOptionCompletion = safer ? safer->audit.expectedCompletion : 0;
    out.saferOptionProgress   = safer ? safer->audit.forwardProgress : 0;
    return out;
}

// ══════════════════════════════════════════════════════════════════════════════
// shotSelectionAudit()
// ══════════════════════════════════════════════════════════════════════════════
ShotSelectionAudit PlayerAI::shotSelectionAudit(const Action& choice,
                                                    const SmallVector<Action, 24>& actions)
{
    const auto& shot = choice.audit;
    if (choice.score < 0) return {};

    const Action* bestPass = nullptr;
    for (auto& a : actions) {
        if (a.type == ActionType::Pass && a.target) {
            if (!bestPass || a.score > bestPass->score) bestPass = &a;
        }
    }

    ShotSelectionAudit out;
    out.score             = choice.score;
    out.distance          = shot.distance;
    out.angleDeg          = shot.angleDeg;
    out.pressureCount     = shot.pressureCount;
    out.bestPassTargetId  = bestPass ? bestPass->target->id : -1;
    out.bestPassScore     = bestPass ? bestPass->score : 0;
    out.bestPassCompletion = bestPass ? bestPass->audit.expectedCompletion : 0;
    return out;
}

// ══════════════════════════════════════════════════════════════════════════════
// auditDefensiveMovement()
// ══════════════════════════════════════════════════════════════════════════════
void PlayerAI::auditDefensiveMovement(const Action& choice) {
    auto* task = engine.assignmentFor(player.id);
    Player* controller = engine.playerById(engine.state.ball.controllerId);
    if (!task || !controller || controller->team == player.team) return;
    if (task->role != DefensiveTask::PrimaryPress && task->role != DefensiveTask::SecondaryPress) return;
    if (choice.type == ActionType::Tackle || choice.type == ActionType::Chase
        || (choice.purpose == ActionPurpose::Task))
        return;

    double targetX = choice.target ? choice.target->x : (choice.posX != 0 ? choice.posX : player.targetX);
    double targetY = choice.target ? choice.target->y : (choice.posY != 0 ? choice.posY : player.targetY);

    double currentDistance = dist(player.x, player.y, controller->x, controller->y);
    double targetDistance = std::hypot(targetX - controller->x, targetY - controller->y);

    double ownGoalX = ownGoalXFor(player.team);
    bool danger = std::abs(controller->x - ownGoalX) < 240.0;

    if (!danger && targetDistance <= currentDistance + 12.0) return;

    engine.logQualityFlag(QualityFlag::WhyPlayerRunningDirection, player.id, task->role,
                          controller->id, choice.type, choice.purpose,
                          currentDistance, targetDistance, danger ? 1.0 : 0.0,
                          8000.0, std::string("why_player_running_direction:") + std::string(to_string(player.team)));
    engine.captureDecisionMoment("why_player_running_direction", player,
                                 choice.type,
                                 choice.score, 0.0, currentDistance, targetDistance,
                                 danger ? 1 : 0,
                                 8000.0, std::string("why_player_running_direction:") + std::string(to_string(player.team)));
}
