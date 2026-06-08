#include "engine.h"
#include "agent.h"


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
    if (player.role == Role::GK) return;
    facing = player.facing;

    stunLockTicks = std::max(0, stunLockTicks - 1);
    shotCooldown = std::max(0, shotCooldown - 1);

    if (ballMemoryAge == 0 && ballMemoryX == 0 && ballMemoryY == 0) {
        ballMemoryX = engine.state.ball.x;
        ballMemoryY = engine.state.ball.y;
    }

    bool ic = (engine.state.ball.controllerId == player.id);
    if (ic) holdTicks++;
    else    holdTicks = 0;

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
    std::vector<Action> aff = evaluateActions(per, ic, gctx);
    Action choice = resolveChoice(aff);

    auditDefensiveMovement(choice);
    executeAction(choice, sdt, aff);

    if (std::fmod(engine.state.clockMs, 500.0) < 20.0) {
        std::vector<Action> top = aff;
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
    double tl = std::max(0.0, MATCH_DURATION - engine.state.clockMs);
    return { d, tl, (engine.state.clockMs < MATCH_DURATION / 2.0) ? 1 : 2 };
}

// ══════════════════════════════════════════════════════════════════════════════
// ev() — evaluate actions
// ══════════════════════════════════════════════════════════════════════════════
std::vector<Action> PlayerAI::evaluateActions(const Perception& per, bool ic, const GameContext& ctx) {
    std::vector<Action> a;
    if (ic) {
        if (stunLockTicks > 0) {
            double angle = engine.state.clockMs * 0.005 + player.id * 1.7;
            double tx = player.x + std::cos(angle) * 3.0;
            double ty = player.y + std::sin(angle) * 3.0;
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
                double roleBoost = (player.role == Role::WM || player.role == Role::CM) ? 0.18 : (player.role == Role::FB ? 0.12 : 0.08);
                x.score += roleBoost;
            }
            if (pc == 0 && x.type == ActionType::Pass && x.purpose != ActionPurpose::Cross && x.purpose != ActionPurpose::Through) {
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
            if (x.type == ActionType::Pass && x.purpose == ActionPurpose::Through)        x.score += 0.04;
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

void PlayerAI::adjustActionScores(std::vector<Action>& actions, bool isController) {
    if (!isController) return;
    for (auto& a : actions) {
        if (a.type == ActionType::Dribble) a.score += 0.10;
    }
}

Action PlayerAI::resolveChoice(std::vector<Action>& a) {
    std::sort(a.begin(), a.end(),
              [](const Action& x, const Action& y) { return x.score > y.score; });

    if (a.empty()) return Action{ActionType::Hold, 1.0};

    Action& best = a[0];
    bool ic = (engine.state.ball.controllerId == player.id);
    double gx = goalXFor(player.team);
    bool nearGoal = std::abs(player.x - gx) < 220.0;
    bool inBox    = std::abs(player.x - gx) < 150.0;

    if (ic && player.throughCollected > 0.0) {
        Action* shootOpt = nullptr;
        Action* dribbleOpt = nullptr;
        for (auto& x : a) {
            if (x.type == ActionType::Shoot && x.score >= 0.0) {
                if (!shootOpt || x.score > shootOpt->score) shootOpt = &x;
            } else if (x.type == ActionType::Dribble) {
                if (!dribbleOpt || x.score > dribbleOpt->score) dribbleOpt = &x;
            }
        }
        if (shootOpt && shootOpt->score > best.score - 0.18 && shootOpt->audit.distance < 245.0) return *shootOpt;
        if (dribbleOpt && nearGoal && dribbleOpt->score > best.score - 0.14) return *dribbleOpt;
    }

    if (ic && player.crossCollected > 0.0) {
        Action* shootOpt = nullptr;
        for (auto& x : a) {
            if (x.type == ActionType::Shoot && x.score >= 0.0) {
                if (!shootOpt || x.score > shootOpt->score) shootOpt = &x;
            }
        }
        if (shootOpt && shootOpt->audit.distance < 225.0 && shootOpt->audit.angleDeg > 7.0
            && shootOpt->score > best.score - 0.24) return *shootOpt;
    }

    if (ic && best.score < (inBox ? 0.0 : nearGoal ? 0.03 : 0.22)) {
        Action* passOpt = nullptr;
        Action* dribbleOpt = nullptr;
        for (auto& x : a) {
            if (x.type == ActionType::Pass && (!passOpt || x.score > passOpt->score)) passOpt = &x;
            if (x.type == ActionType::Dribble && (!dribbleOpt || x.score > dribbleOpt->score)) dribbleOpt = &x;
        }
        if (passOpt && passOpt->score > 0.05) return *passOpt;
        if (dribbleOpt && dribbleOpt->score > 0.04) return *dribbleOpt;
        if (player.role != Role::GK) {
            double fd = fdFor(player.team);
            double side = player.y < PITCH_H / 2.0 ? 1.0 : -1.0;
            return Action{ActionType::Dribble, 0.20, nullptr,
                          clamp(player.x + fd * 55.0, 35.0, PITCH_W - 35.0),
                          clamp(player.y + side * 34.0, 35.0, PITCH_H - 35.0),
                          ActionPurpose::Space};
        }
        return Action{ActionType::Hold, 1.0};
    }

    if (ic && engine.carryTrackerId == player.id) {
        double carryDistance = engine.carryPathDistance;
        double fd = fdFor(player.team);
        double ownGoalX = ownGoalXFor(player.team);
        double progress = (player.x - ownGoalX) * fd;
        bool attackingHalf = progress > PITCH_W * 0.46;
        bool finalThirdCarry = progress > PITCH_W * 0.62;
        CarrierPressure cp = assessCarrierPressure(engine, player);
        Action* shootOpt = nullptr;
        Action* dribbleOpt = nullptr;
        Action* passOpt = nullptr;
        for (auto& x : a) {
            if (x.type == ActionType::Shoot && x.score >= 0.0) {
                if (!shootOpt || x.score > shootOpt->score) shootOpt = &x;
            } else if (x.type == ActionType::Dribble) {
                if (!dribbleOpt || x.score > dribbleOpt->score) dribbleOpt = &x;
            } else if (x.type == ActionType::Pass) {
                if (!passOpt || x.score > passOpt->score) passOpt = &x;
            }
        }
        if (carryDistance >= 205.0 && shootOpt && shootOpt->audit.distance < 255.0
            && shootOpt->audit.angleDeg > 7.5 && shootOpt->score > best.score - 0.22) {
            return *shootOpt;
        }
        if (carryDistance >= 80.0 && dribbleOpt && attackingHalf && cp.score < 1.05) {
            bool passClearlyBetter = passOpt && passOpt->score > dribbleOpt->score + (finalThirdCarry ? 0.38 : 0.30)
                && passOpt->audit.forwardProgress > 30.0;
            bool shotClearlyBetter = shootOpt && shootOpt->score > dribbleOpt->score + 0.28;
            bool needsCarryShotWindow = carryDistance < 210.0;
            if (!passClearlyBetter && !shotClearlyBetter && dribbleOpt->score > best.score - (needsCarryShotWindow ? 0.40 : 0.32)) {
                return *dribbleOpt;
            }
        }
    }

    auto& bb = engine.blackboards[GameEngine::teamIndex(player.team)];

    if (best.type == ActionType::Chase && engine.state.ball.controllerId < 0) {
        bool priorityChaser = engine.state.ball.intendedReceiverId == player.id || engine.isActiveKnockAheadRunner(player.id);
        bool isSelf = (bb.pressingPlayerId == player.id || bb.pressingPlayerId2 == player.id);
        bool slot1Free = (bb.pressingPlayerId < 0);
        bool slot2Free = (bb.pressingPlayerId2 < 0);
        if (!priorityChaser && !isSelf && !slot1Free && !slot2Free) {
            for (auto& x : a) {
                if (x.type != ActionType::Chase && x.type != ActionType::Tackle && x.score > 0.15) return x;
            }
            return Action{ActionType::Hold, 1.0};
        }
        if (!priorityChaser && !isSelf) {
            if (slot1Free)      bb.pressingPlayerId  = player.id;
            else if (slot2Free) bb.pressingPlayerId2 = player.id;
        }
    }

    if (best.type == ActionType::Position) {
        bool reservePressSlot = false;
        bool emergencyCloseDown = best.purpose == ActionPurpose::EmergCloseDown;
        auto* task = engine.assignmentFor(player.id);
        if (best.purpose == ActionPurpose::LocalCloseDown) reservePressSlot = true;
        if (best.purpose == ActionPurpose::Task && task
            && (task->role == DefensiveTask::PrimaryPress || task->role == DefensiveTask::SecondaryPress || task->role == DefensiveTask::CloseDown)) {
            reservePressSlot = true;
        }
        if (reservePressSlot) {
            bool isSelf = (bb.pressingPlayerId == player.id || bb.pressingPlayerId2 == player.id);
            bool slot1Free = (bb.pressingPlayerId < 0);
            bool slot2Free = (bb.pressingPlayerId2 < 0);
            if (!emergencyCloseDown && !isSelf && !slot1Free && !slot2Free) {
                for (auto& x : a) {
                    if (x.type == ActionType::Position && x.purpose == ActionPurpose::LocalCloseDown) continue;
                    if (x.type != ActionType::Tackle && x.score > 0.15) return x;
                }
                return Action{ActionType::Hold, 1.0};
            }
            if (!isSelf) {
                if (slot1Free)      bb.pressingPlayerId  = player.id;
                else if (slot2Free) bb.pressingPlayerId2 = player.id;
            }
        }
    }

    if (best.type == ActionType::Tackle && best.target) {
        bool isSelf = (bb.pressingPlayerId == player.id || bb.pressingPlayerId2 == player.id);
        bool slot1Free = (bb.pressingPlayerId < 0);
        bool slot2Free = (bb.pressingPlayerId2 < 0);

        if (!isSelf && !slot1Free && !slot2Free) {
            for (auto& x : a) {
                if (x.type != ActionType::Tackle && x.score > 0.15) return x;
            }
            return Action{ActionType::Hold, 1.0};
        }

        if (!isSelf) {
            if (slot1Free)      bb.pressingPlayerId  = player.id;
            else if (slot2Free) bb.pressingPlayerId2 = player.id;
        }
    }

    if (best.type == ActionType::Mark && best.target) {
        auto it = bb.markedOpponents.find(best.target->id);
        if (it != bb.markedOpponents.end() && it->second != player.id) {
            for (auto& x : a) {
                if (x.type != ActionType::Mark && x.type != ActionType::Tackle && x.score > 0.15) return x;
            }
            return Action{ActionType::Hold, 1.0};
        }
        bb.markedOpponents[best.target->id] = player.id;
    }

    if (ic && best.type == ActionType::Pass && best.audit.forwardProgress < -40.0) {
        Action* fwdOpt = nullptr;
        for (auto& x : a) {
            if (x.type == ActionType::Pass && x.audit.forwardProgress > 30.0 && x.score > best.score - 0.15) {
                fwdOpt = &x; break;
            }
        }
        if (fwdOpt) engine.logQualityFlag(QualityFlag::QuestionableBackpass, player.id, player.role,
                                          best.audit.forwardProgress, true,
                                          fwdOpt->score, best.score,
                                          8000.0, "backpass:" + std::to_string(player.id));
    }

    // ── Clear path alert: relaxed — broad corridor, allow 1 blocker, wider zone ──
    if (ic) {
        double dx = gx - player.x;
        double dy = PITCH_H / 2.0 - player.y;
        double toGoalDist = std::hypot(dx, dy);
        dx /= std::max(toGoalDist, 1.0);
        dy /= std::max(toGoalDist, 1.0);
        double nearestOppDist = 1e9;
        int blockersInPath = 0;
        for (auto& o : engine.state.players) {
            if (o.team == player.team || o.role == Role::GK) continue;
            double odx = o.x - player.x, ody = o.y - player.y;
            double od = std::hypot(odx, ody);
            double along = odx * dx + ody * dy;
            double perp = std::abs(odx * dy - ody * dx);
            if (along > 5.0) {
                if (along < toGoalDist && perp < 80.0) blockersInPath++;
                if (od < nearestOppDist) nearestOppDist = od;
            }
        }
        bool clearPath = blockersInPath <= 1 && nearestOppDist > 35.0;
        double distToGoal = std::abs(player.x - gx);
        bool inDangerZone = distToGoal < 500.0;
        if (clearPath && inDangerZone) {
            // Close enough: shoot if possible, else dribble closer
            if (distToGoal < 200.0) {
                Action* shootAct = nullptr;
                for (auto& x : a) {
                    if (x.type == ActionType::Shoot && x.score > 0.0) {
                        if (!shootAct || x.score > shootAct->score) shootAct = &x;
                    }
                }
                if (shootAct) {
                    engine.logQualityFlag(QualityFlag::ClearPathShoot, player.id, player.role,
                        distToGoal, shootAct->audit.angleDeg,
                        shootAct->score, best.type, best.score);
                    return *shootAct;
                }
            }
            // Dribble toward goal — even if no shot exists yet, get closer
            Action* driveAct = nullptr;
            for (auto& x : a) {
                if (x.type == ActionType::Dribble && x.purpose == ActionPurpose::Space) {
                    if (!driveAct || x.score > driveAct->score) driveAct = &x;
                }
            }
            if (driveAct) {
                engine.logQualityFlag(QualityFlag::ClearPathDrive, player.id, player.role,
                    distToGoal, 0,
                    driveAct->score, best.type, best.score);
                return *driveAct;
            }
        }
    }

    if (ic) {
        CarrierPressure cp = assessCarrierPressure(engine, player);
        if (cp.score > 0.85) {
            bool attackerNearGoal = isAttackerRole() && nearGoal;
            if (!attackerNearGoal) {
            Action* safePass = nullptr;
            for (auto& x : a) {
                if (x.type != ActionType::Pass || !x.target) continue;
                bool safe = x.audit.expectedCompletion > 0.66 && x.audit.blockers <= 1
                    && x.audit.receiverPressure <= 1 && x.audit.distance < 300.0;
                if (!safe) continue;
                if (!safePass || x.score > safePass->score) safePass = &x;
            }
            if (safePass && (best.type == ActionType::Shoot || best.type == ActionType::Dribble)
                && safePass->score > best.score - (cp.exposed > 0.35 ? 0.30 : 0.20)) {
                return *safePass;
            }
            }
        }
    }

    if (ic) {
        double fd = fdFor(player.team);
        bool finalThird = fd > 0.0 ? player.x > PITCH_W * 2.0 / 3.0 : player.x < PITCH_W / 3.0;
        if (finalThird && shouldSearchForPassOverShot() && best.type == ActionType::Shoot) {
            Action* frontLinePass = nullptr;
            for (auto& x : a) {
                if (x.type != ActionType::Pass || !x.target) continue;
                if (x.target->role != Role::CF && x.target->role != Role::WM) continue;
                if (x.audit.expectedCompletion < 0.66 || x.audit.blockers > 1 || x.audit.receiverPressure > 1) continue;
                double targetGoalDist = std::abs(goalXFor(player.team) - x.target->x);
                if (targetGoalDist > 230.0 && x.audit.forwardProgress < 40.0) continue;
                if (!frontLinePass || x.score > frontLinePass->score) frontLinePass = &x;
            }
            if (frontLinePass && frontLinePass->score > best.score - 0.22) return *frontLinePass;
        }
        if (finalThird && best.type == ActionType::Pass && best.audit.forwardProgress < 25.0 && isAttackerRole()) {
            Action* driveIn = nullptr;
            for (auto& x : a) {
                if (x.type == ActionType::Dribble && x.purpose == ActionPurpose::Space) { driveIn = &x; break; }
            }
            if (driveIn && driveIn->score > best.score - 0.22) return *driveIn;
        }
        if (finalThird && best.type == ActionType::Pass && best.audit.forwardProgress < 0.0) {
            Action* driveOpt = nullptr;
            Action* shootOpt = nullptr;
            for (auto& x : a) {
                if (x.type == ActionType::Dribble && x.purpose == ActionPurpose::Space) driveOpt = &x;
                if (x.type == ActionType::Shoot) shootOpt = &x;
            }
            if (shootOpt && shootOpt->score > best.score - 0.12) return *shootOpt;
            if (driveOpt && driveOpt->score > best.score - 0.16) return *driveOpt;
        }
        if (finalThird && best.type != ActionType::Shoot) {
            Action* shotOpt = nullptr;
            Action* tapInPass = nullptr;
            for (auto& x : a) {
                if (x.type == ActionType::Shoot && x.score > 0.0) shotOpt = &x;
                if (x.type == ActionType::Pass && x.target) {
                    double tGoalDist = std::abs(goalXFor(player.team) - x.target->x);
                    if (tGoalDist < 75.0 && x.audit.expectedCompletion > 0.62 && x.audit.blockers <= 1) tapInPass = &x;
                }
            }
            if (shotOpt && !tapInPass) {
                double maxDistance = finalThirdShotMaxDistance();
                double minAngle = finalThirdShotMinAngle();
                bool credible = shotOpt->audit.distance < maxDistance
                    && shotOpt->audit.angleDeg > minAngle
                    && shotOpt->audit.pressureCount <= 1;
                if (credible && shotOpt->score > best.score - 0.26) return *shotOpt;
            }
        }
    }

    // CF near goal: bias toward shooting unless teammate has a clear tap-in
    if (ic && nearGoal && best.type != ActionType::Shoot) {
        double margin = nearGoalShotBiasMargin();
        if (margin > 0.0) {
        Action* shotOpt = nullptr;
        Action* passToTapIn = nullptr;
        for (auto& x : a) {
            if (x.type == ActionType::Shoot) shotOpt = &x;
            if (x.type == ActionType::Pass && x.target) {
                double tGoalDist = std::abs(goalXFor(player.team) - x.target->x);
                if (tGoalDist < 80.0) passToTapIn = &x;
            }
        }
        // If shot exists and passes don't go to a tap-in, prefer shot
        if (shotOpt && !passToTapIn && shotOpt->score > best.score - (margin + 0.06)) {
            return *shotOpt;
        }
        }
    }

    return best;
}

// ══════════════════════════════════════════════════════════════════════════════
// ex() — execute chosen action
// ══════════════════════════════════════════════════════════════════════════════
void PlayerAI::executeAction(Action& a, double sdt, std::vector<Action>& actions) {
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
            stunLockTicks = 50 + static_cast<int>(engine.rng.random() * 21);
        } else {
            stunLockTicks = 4;
        }
    }
    else if (a.type == ActionType::Shoot) {
        ShotSelectionAudit audit = shotSelectionAudit(a, actions);
        engine.shootBall(p, &audit);
        engine.emitEvent("shot", p.x, p.y, p.id);
        stunLockTicks = 20;
    }
    else if (a.type == ActionType::Dribble) {
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

        // Wobble only in open space — suppress under pressure
        if (nearestOppDist > 80.0) {
            double wobbleAngle = std::sin(engine.state.clockMs * 0.008 + p.id * 1.7) * 0.3;
            double wobbleDist  = std::sin(engine.state.clockMs * 0.012 + p.id * 2.3) * 12.0;
            p.targetX += std::cos(wobbleAngle) * wobbleDist;
            p.targetY += std::sin(wobbleAngle) * wobbleDist;
        }

        double distToTarget = std::sqrt((p.targetX - p.x) * (p.targetX - p.x)
                                      + (p.targetY - p.y) * (p.targetY - p.y));

        int oppsInPath = 0;
        double fd = (p.team == Team::Home) ? 1.0 : -1.0;
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

        bool activeLongCarry = engine.carryTrackerId == p.id && engine.carryPathDistance >= 95.0;
        bool needsCarryShotWindow = activeLongCarry && engine.carryPathDistance < 220.0 && clearPath
            && nearestOppDist > 135.0 && distToTarget > 120.0 && advancedEnough;
        bool mayBurst = engine.canKnockBallAhead(p.id) && cp.score < (needsCarryShotWindow ? 0.82 : 0.65)
            && (openBurst || speculativeBurst || finalThirdBurst || needsCarryShotWindow);
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
    else if (a.type == ActionType::Tackle) {
        if (a.target && dist(p.x, p.y, a.target->x, a.target->y) <= TACKLE_RANGE
            && engine.attemptTackle(p, *a.target))
        {
            engine.emitEvent("tackle", (p.x + a.target->x) / 2.0, (p.y + a.target->y) / 2.0, p.id, a.target->id);
            p.tackleAnim = engine.state.ball.controllerId == p.id ? 220.0 : 800.0;
        } else {
            p.targetX = a.target ? a.target->x : p.x;
            p.targetY = a.target ? a.target->y : p.y;
        }
    }
    else if (a.type == ActionType::Mark && a.target) {
        double leadX = a.target->x + a.target->vx * 0.45;
        double leadY = a.target->y + a.target->vy * 0.45;
        double ownGx = ownGoalXFor(p.team);
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
            p.dribbleType = 1;
            auto near = engine.nearPlayers(p, 60.0);
            Player* closestOpp = nullptr;
            double closestD = 1e9;
            for (auto* o : near) {
                if (o->team != p.team) {
                    double d = dist(p.x, p.y, o->x, o->y);
                    if (d < closestD) { closestD = d; closestOpp = o; }
                }
            }
            if (closestOpp) {
                double ax = p.x - closestOpp->x;
                double ay = p.y - closestOpp->y;
                double ad = std::hypot(ax, ay);
                if (ad < 3.0) {
                    double fd = fdFor(p.team);
                    double side = p.y < PITCH_H / 2.0 ? 1.0 : -1.0;
                    ax = fd * 22.0;
                    ay = side * 52.0;
                    ad = std::hypot(ax, ay);
                }
                p.targetX = clamp(p.x + ax / std::max(1.0, ad) * 58.0, 35.0, PITCH_W - 35.0);
                p.targetY = clamp(p.y + ay / std::max(1.0, ad) * 58.0, 35.0, PITCH_H - 35.0);
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
// gp() — get perception (cached)
// ══════════════════════════════════════════════════════════════════════════════
PassSelectionAudit PlayerAI::passSelectionAudit(const Action& choice,
                                                   const std::vector<Action>& actions)
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
                                                    const std::vector<Action>& actions)
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
