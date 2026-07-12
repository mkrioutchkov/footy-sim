#include "engine.h"
#include "agent.h"
#include "agent_helpers.h"


// tick()
// ══════════════════════════════════════════════════════════════════════════════

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
                if (distance == 0.0) distance = pitch::distToGoalMouth(player.x, player.y, player.team);
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

        // ── Hoof under pressure / panic clearance ── A deep player with the
        // press ARRIVING (projected along the pressers' velocities, not just
        // standing near) and no safe outlet boots it long rather than gifting
        // possession in a dangerous area. Routed through Clear (scattered
        // forcePassTo) so it's an honest 50/50 clearance toward the forwards,
        // not a measured pass. Watched replay 3'16-3'18: a full-back received
        // deep in his own box with the swarm converging, stood on the ball
        // (static pressureCount hadn't ticked to 2 yet), was tackled — penalty
        // conceded. The emergency case fires on CLOSING pressure and outbids
        // everything except a genuinely clean pass out.
        // A tackle genuinely ARRIVING (an opponent sprinting in, not the assigned
        // jockey holding his standoff) — the shared trigger for the deep-carrier
        // release valves below. Proximity/projection variants of this were tried
        // and reverted (see the tempo-brake note).
        bool tackleComing = tackleArriving(engine.state.players, player.x, player.y, player.team);
        {
            double prog = pitch::forwardProgress(player.x, player.team);
            double oppSoon = 1e9;
            if (prog < PITCH_W * 0.30) {
                for (auto& o : engine.state.players) {
                    if (!isActiveOpponent(o, player.team)) continue;
                    double now = dist(o.x, o.y, player.x, player.y);
                    double soon = dist(o.x + o.vx * 0.8, o.y + o.vy * 0.8, player.x, player.y);
                    oppSoon = std::min(oppSoon, std::min(now, soon));
                }
            }
            // Emergency also covers the WIDENED own-30% band when a tackle is
            // genuinely arriving (was a hardcoded 200px: the 0:40 FB stood at
            // x=236 with the press sprinting in and no clearance on the menu);
            // a lone CAPPED presser sprinting at a defender also counts as
            // swarmed — the 2-man press cap makes pc>=2 structurally rare, so
            // the old gate could never fire for the commonest caught-in-
            // possession shape (one sprinting presser, everyone else marking).
            bool emergency = (prog < 200.0 && oppSoon < 48.0 && per.nearestOpponentDist < 78.0)
                || (prog < PITCH_W * 0.30 && tackleComing && per.nearestOpponentDist < 78.0);
            bool swarmed = prog < PITCH_W * 0.30
                && (per.pressureCount >= 2 || (isDefenderLike() && per.pressureCount >= 1 && tackleComing));
            // "Hoof away" (owner, seed 111 1:36: ball dropping in the danger
            // area — 4R's only concerns should be head it clear / corner /
            // back to GK, "or to check down and hoof away. really want to see
            // a hoof away introduced"). A defender holding the ball INSIDE his
            // own box with bodies anywhere near doesn't need a sprinting
            // tackler to justify getting rid — the check-down is the bestSafe
            // test below (a genuinely clean out-ball still wins), the hoof is
            // the answer when there isn't one.
            bool boxDanger = isDefenderLike()
                && pitch::distToOwnGoal(player.x, player.team) < PENALTY_AREA_W + 25.0
                && pitch::lateralFromCenter(player.y) < PENALTY_AREA_H / 2.0 + 30.0
                && per.nearestOpponentDist < 140.0;
            if (emergency || swarmed || boxDanger) {
                double bestSafe = 0.0;
                // Judge "a genuinely clean pass out" on the PLAYABLE score, not raw
                // completion: the old check read audit.expectedCompletion, so a pass
                // the dwell gate had priced to -1.3 still suppressed the clearance —
                // the carrier got neither the hoof nor the ball out (0:38 Ramos) and
                // invited the presser to tackling range.
                for (auto& x : a)
                    if (x.type == ActionType::Pass && x.score > 0.15) bestSafe = std::max(bestSafe, x.audit.expectedCompletion);
                // 0.70/0.60 -> 0.78/0.70 (owner, round 14: "too many silly
                // losses of possession in [the defensive] third, would prefer
                // more clearances") — a pass out of a swarm must be genuinely
                // safe to beat the hoof, not merely coin-flip playable.
                if (bestSafe < (emergency ? 0.78 : swarmed ? 0.70 : 0.66)) {
                    Player* tgt = nullptr; double bestFx = -1e9;
                    for (auto& t : engine.state.players) {
                        if (t.team != player.team || t.id == player.id || t.role == Role::GK) continue;
                        // The panic ball goes long AND wide — up the channel,
                        // not through the middle where losing it is fatal.
                        // (A "directed outlet into a breakaway runner's path"
                        // variant was A/B'd here and REVERTED: even gated to
                        // 130px-ahead sprinters projected 70px free, it
                        // re-tagged ~5 hoofs/match as through balls and
                        // halved conversion — the lever needs its own pass.)
                        double fx = pitch::forwardProgress(t.x, player.team)
                                  + pitch::lateralFromCenter(t.y) * 0.35;
                        if (fx > bestFx) { bestFx = fx; tgt = &t; }
                    }
                    if (tgt) {
                        ActionAudit au;
                        au.distance = dist(player.x, player.y, tgt->x, tgt->y);
                        au.forwardProgress = (tgt->x - player.x) * fdFor(player.team);
                        au.expectedCompletion = 0.4;
                        double sc = emergency ? 1.05 + per.pressureCount * 0.05
                                  : swarmed  ? 0.74 + std::max(0, per.pressureCount - 2) * 0.05
                                             : 0.68;   // boxDanger: the hoof is on the menu, a truly clean out-ball can still beat it
                        a.push_back(Action{ActionType::Pass, sc,
                                           tgt, 0, 0, ActionPurpose::Clear, au});
                    }
                }
            }
        }

        int pc = per.pressureCount;
        double fd = fdFor(player.team);
        double progress = (player.x - ownGoalXFor(player.team)) * fd;
        // (Round 14: a blanket deep-third risk tax on sub-0.62-completion
        // passes was tried here and REVERTED — it didn't dent the silly-loss
        // flags (suicide/senseless flat) and goals rose ~+2/90: the taxed
        // passes lost to holding/dribbling into the tackle, not to the clear.
        // The clearance preference lives in the emergency/swarmed thresholds
        // above instead.)

        // ── Back-pressure layoff ── A rider on the carrier's BACK (behind his
        // line of travel, touch-tight) means: shield it and give it simple —
        // the short lay-back to a supporting teammate beats carrying on blind
        // (watched replay 0:12-0:17: a chased carrier ran four seconds without
        // once considering the free layoff behind him).
        {
            double spd = std::hypot(player.vx, player.vy);
            if (pc >= 1 && spd > 12.0 && per.nearestOpponentDist < 42.0) {
                double fx = player.vx / spd, fy = player.vy / spd;
                double bnx = 0, bny = 0, bd2 = 1e9;
                for (auto& o : engine.state.players) {
                    if (!isActiveOpponent(o, player.team)) continue;
                    double d2 = dist(o.x, o.y, player.x, player.y);
                    if (d2 < bd2) { bd2 = d2; bnx = o.x - player.x; bny = o.y - player.y; }
                }
                double bl = std::hypot(bnx, bny);
                if (bl > 0.5 && (bnx * fx + bny * fy) / bl < -0.25) {
                    for (auto& x : a) {
                        if (x.type == ActionType::Pass && x.audit.distance < 190.0
                            && x.audit.forwardProgress < 40.0 && x.audit.expectedCompletion > 0.70)
                            x.score += 0.14;
                        if (x.type == ActionType::Dribble) x.score -= 0.06;
                    }
                }
            }
        }
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
            // ── Tempo brake (composure dwell) ── An UNPRESSURED carrier doesn't
            // ping the ball on first touch — he scans and carries before releasing.
            // The old brake excluded Build/Switch/Cross/Cutback/Through, i.e.
            // nearly every real pass, and lasted 0.2-0.4s — a no-op that left the
            // match at ~2100 passes (real ~900-1000, one release every ~6s not
            // ~2.5s). Now every unpressured pass EXCEPT a genuine killer ball
            // (Through/Cutback — those windows are fleeting) pays a dwell that
            // decays over ~2s of hold. A quick vertical outlet that genuinely
            // breaks lines stays exempt (fast transitions are real football).
            // Pressure lifts the brake entirely (pc>0): being closed down is what
            // forces tempo — so possession rhythm emerges from the press, not a
            // timer. Shots/dribbles are never braked; the carrier carries instead
            // of standing (Dribble outscores the braked pass).
            // A "Cutback" is only a killer ball when it actually finds a runner
            // in the penalty-spot band — that window IS fleeting, play it now.
            // The isCutback classifier is a catch-all (any wide non-cross
            // delivery), so a ~24m lay-back to a deep CM wears the same purpose;
            // that one is ordinary recycling and pays the dwell like any other
            // pass — which keeps the wide carrier CARRYING (byline-seek) while
            // the box-burst runner arrives, fixing the cutback's timing from the
            // carrier's side too (runner-side fix: agent_movement.cpp boxBurst).
            bool spotBandCutback = x.purpose == ActionPurpose::Cutback
                && x.target
                && pitch::distToOppGoal(x.target->x, player.team) < 165.0
                && std::abs(x.target->y - PITCH_H / 2.0) < 120.0;
            bool killerBall = x.purpose == ActionPurpose::Through || spotBandCutback;
            bool lineBreakOutlet = x.type == ActionType::Pass
                && x.target
                && roles::isAttacker(x.target->role)
                && x.audit.forwardProgress > 60.0
                && x.audit.expectedCompletion > 0.72
                && x.audit.blockers <= 1
                && x.audit.receiverPressure <= 1;
            // Only TIGHT pressure lifts the dwell: a jockeying container 3-4m off
            // (the measured-press standoff) doesn't force a release — a defender
            // arriving at touching distance, or two bodies closing in, does.
            // (pc counts opponents within 60px = 6m, which made the brake a no-op
            // once the assigned presser arrived — i.e. always.)
            // A tackler SPRINTING IN also lifts it (closing speed, not distance:
            // proximity/projection variants read as permanently "arriving"
            // because the assigned presser lives at a 12-30px standoff — pass
            // volume exploded +55-80% with those). nearestOpp<30 alone opens the
            // valve only when the tackler is already at contact — measured
            // match-wide, deep defenders released at 22-28px on all nine holds,
            // two of them turnovers (seed 129 0:40, 4:01).
            bool tightPress = per.nearestOpponentDist < 30.0 || pc >= 2
                || (tackleComing && progress < PITCH_W * 0.42);
            // A panic Clear is never "composing" — braking it (esp. the −2.0
            // hard gate below: Clear is a Pass, deep zone, fresh touch — all
            // three conditions of a panic situation) left the swarmed deep
            // receiver standing on the ball until the tackle arrived. The keeper
            // recycle is the same class of escape ball WHEN THE PRESS IS REAL —
            // exempting it unconditionally made the GK the only playable ball of
            // every braked deep hold, and build-up degenerated into a
            // defender→GK→defender loop (measured 28-47 backpasses/match).
            bool panicClear = x.purpose == ActionPurpose::Clear
                || (x.purpose == ActionPurpose::KeeperBackpass
                    && (tackleComing || pc >= 2));
            if (!tightPress && x.type == ActionType::Pass && !killerBall && !lineBreakOutlet && !panicClear) {
                if      (holdTicks < 60)  x.score -= 0.26;   // <1.0s: just took the touch
                else if (holdTicks < 110) x.score -= 0.16;   // <1.8s: still composing
                else if (holdTicks < 170) x.score -= 0.07;   // <2.8s: about ready
                // Stage-2 dwell gate NOTE (2026-07-02 audit): an extra −0.34 for
                // holdTicks<40 in the own-40% zone was A/B'd at 48 paired seeds
                // and came back INERT on volume (passes 1794→1782, dwell u250ms
                // 15→12%) — good candidates out-bid even −0.60 total. Only real
                // effect: ping-pong −18% (82→67/match). Penalties don't move this
                // arbitration; hence the HARD gate below.
                // Stage-2b HARD dwell gate: in calm own-40% build-up an ordinary
                // pass is simply not on the menu for the first ~1.3s of holding —
                // the carrier scans/carries (Dribble always scores, no deadlock).
                // Killer balls, line-break outlets and any tight press remain
                // exempt via the conditions above.
                // Notch-2 NOTE: extending the zone 0.42→0.55·W was A/B'd at 48
                // paired seeds and FAILED — passes only 1664→1649 (−0.9%) while
                // goals broke the guard (+0.40 paired, 2.67→3.06). The midfield
                // band's holds are mostly pressed or already past the floor, so
                // the wider zone only perturbed. 0.42 is the sweet spot; the next
                // tempo lever should be receiver-side (first-touch redirects),
                // not this gate.
                if (holdTicks < 80 && progress < PITCH_W * 0.42)
                    x.score -= 2.0;
                // Return-pass damper NOTE (2026-07-04 audit: PINGPONG A<->B x5
                // in 5s): a −0.22 penalty for returning the ball to
                // lastReceiveFrom[me] within 2.5s (unpressed, non-killer,
                // non-forward) was A/B'd and came back INERT on both counters —
                // teammatePingPongs 67→70 (6x90min) and decision-level A-B-A
                // pass chains 39→37 (3x10min traces). Same lesson as Stage-2:
                // this arbitration out-bids flat penalties; the ping-pong lever
                // is receiver-side (first-touch redirects), not carrier-side.
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

    // ── Armed restart: choreography OWNS the targets ── setPiecePositioning
    // runs after tickAgents so its targets "stand" for rendering — but the
    // agent's own decision here re-overwrote them before movement every tick,
    // so players WALKED to their stale open-play waypoints while DISPLAYING
    // corner targets (seed 133 audit: at taker-at-flag, 1 of 9 attackers within
    // 165px of goal; laggards moving 5-26px/s in the WRONG direction, cos -0.9
    // to their shown targets, then snapping to cos=1.00 the frame after the
    // kick). Non-takers do nothing here during a dead ball: the choreography
    // target from last tick steers applyMovement, the referee push still
    // applies, and tackles/chases are already gated off while armed.
    if ((engine.setPiece.armed || engine.keeperHoldChoreo)
        && p.id != engine.setPiece.takerId
        && p.id != engine.state.ball.controllerId && !isGoalkeeper()) {
        lastActionType = ActionType::Position;
        lastPurpose = ActionPurpose::Space;
        p.dribbleType = 0;
        applyMovement(sdt);   // still WALK to the choreography target (movement normally runs at the end of this function)
        return;
    }

    lastActionType = a.type;
    lastPurpose = a.purpose;
    lastTargetId = a.target ? a.target->id : -1;

    if (a.type != ActionType::Dribble) p.dribbleType = 0;

    if (a.type == ActionType::Pass && a.target) {
        PassSelectionAudit audit = passSelectionAudit(a, actions);
        // "Nonsense pass" census (owner ask: a metric for the pass that makes
        // no sense): a low-completion ball released under little/no pressure
        // while a clearly safer option with comparable progress was on the
        // menu. Killer balls and panic clears are exempt — those are meant to
        // be risky. Census only; the selection-sanity penalty in scorePass is
        // what actually reduces them.
        int pcNow = cachedPerception.has_value() ? cachedPerception->pressureCount : 0;
        if (pcNow <= 1 && a.audit.expectedCompletion > 0.0 && a.audit.expectedCompletion < 0.50
            && a.purpose != ActionPurpose::Through && a.purpose != ActionPurpose::Clear
            && a.purpose != ActionPurpose::Cross && a.purpose != ActionPurpose::Cutback) {
            for (auto& x : actions) {
                if (x.type != ActionType::Pass || !x.target || x.target->id == a.target->id) continue;
                if (x.audit.expectedCompletion > 0.74
                    && x.audit.forwardProgress >= a.audit.forwardProgress - 60.0) {
                    engine.stats.recordNonsensePass();
                    break;
                }
            }
        }
        // Turn BEFORE the release, don't teleport the body (watched replay seed
        // 111 0:20: the pivot snapped 163° in one tick — "instant shift 180
        // degrees"). A pass played meaningfully across the body first rotates
        // facing toward the launch line at a fast-but-human rate and releases
        // on a later tick, once roughly aligned. The ball stays on the foot;
        // pressure can still force a different choice next tick — that's real.
        if (a.target && a.purpose != ActionPurpose::Clear) {
            double wantAng = std::atan2(a.target->y - p.y, a.target->x - p.x);
            double offT = std::atan2(std::sin(wantAng - p.facing), std::cos(wantAng - p.facing));
            if (std::abs(offT) > 1.35) {
                facing = p.facing + clamp(offT, -0.55, 0.55);   // ~19 rad/s at 34ms ticks: a sharp half-turn beat
                p.facing = facing;
                return;   // release next tick(s), body coming around
            }
        }
        bool released;
        if (a.purpose == ActionPurpose::Clear) {
            engine.forcePassTo(p, *a.target, &audit);
            engine.stats.recordClearance();
            // Label EVERY clearance for the viewer/census — the event used to
            // fire only from forcePassTo's in-box slice-out-for-a-corner branch
            // (18% sub-case), so a match showed "1 clearance" while the engine
            // actually hoofed ~96 (2026-07-02 counter baseline, 48 seeds).
            engine.emitEvent("clearance", p.x, p.y, p.id);
            released = true;
        } else {
            released = engine.passBallTo(p, *a.target, a.purpose == ActionPurpose::Through, false, &audit);
        }
        if (released) {
            engine.stats.recordPassDwell(holdTicks);
            lastPassTargetId = a.target->id;
            recentPassTarget = a.target->id;
            recentPassTime = engine.state.clockMs;
            engine.emitEvent("pass", p.x, p.y, p.id, a.target->id);
            double passDist = dist(p.x, p.y, a.target->x, a.target->y);
            bool combinationZone = (fdFor(p.team) > 0.0 ? p.x > HALF_X - 90.0 : p.x < HALF_X + 90.0);
            double passFwd = (a.target->x - p.x) * fdFor(p.team);
            // A give-and-go is only ON for a SHORT pass played FORWARD in the
            // attacking half — the one situation the return-into-space wall-pass
            // bonus (scorePassToTarget) should reward. Arming a one-two after
            // EVERY released pass (long balls, square balls, backpasses included)
            // made the receiver want to immediately return the ball to whoever
            // just fed him, driving A->B->A->B ping-pong (~122/match, 60 seqs).
            auto& bb = engine.blackboards[GameEngine::teamIndex(p.team)];
            if (passDist < 190.0 && combinationZone && passFwd > 20.0)
                bb.oneTwo = TeamBlackboard::OneTwo{ p.id, a.target->id, engine.state.clockMs + 2000.0 };
            // Short pass in the opponent's half: move again quickly so the
            // give-and-go is physically possible — a ~1s freeze after every
            // pass meant the one-two runner stood still through the window.
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
        // Earned lunge: choosing Tackle tick after tick while the collision
        // bubble holds you at 27-40px is a stalemate the selection layer can't
        // see (instrumented seed 129: act=Tackle at score ~1.05 for 3+ straight
        // seconds, attemptTackle never reached — its 24px gate sits inside the
        // separation force's standoff). After ~0.9s shadowing the SAME carrier,
        // the challenge gets a step-in band (+14px) so the duel actually rolls;
        // attemptTackle prices the stretched reach down.
        if (a.target && a.target->id == tackleShadowCarrierId
            && dist(p.x, p.y, a.target->x, a.target->y) < TACKLE_ZONE_MAX - 8.0) tackleShadowTicks++;
        else { tackleShadowTicks = 0; tackleShadowCarrierId = a.target ? a.target->id : -1; }
        double lungeReach = tackleShadowTicks > 33 ? 14.0 : 0.0;
        if (a.target && dist(p.x, p.y, a.target->x, a.target->y) <= TACKLE_RANGE + lungeReach
            && engine.attemptTackle(p, *a.target, lungeReach))
        {
            tackleShadowTicks = 0;
            engine.emitEvent("tackle", (p.x + a.target->x) / 2.0, (p.y + a.target->y) / 2.0, p.id, a.target->id);
            bool cleanWin = engine.state.ball.controllerId == p.id;
            p.tackleAnim = cleanWin ? 220.0 : 800.0;
            if (cleanWin) {
                // 24 ticks = 400ms gather (was 267ms): the post-tackle census
                // put 40% of releases on the very first decision tick after the
                // old stun — a won duel needs the ball dug out from under two
                // bodies before any 30m ball is on.
                stunLockTicks = 24;
                engine.lastTurnoverWinMs[p.id] = engine.state.clockMs;
            }
        } else {
            // Approach at an INTERCEPT point, not the carrier's heels: chasing
            // his current spot pins the pursuer just outside tackle range
            // forever (watched replay 0:12-0:17: two defenders trailing a
            // lateral carrier at 24px for four seconds). Lead along his
            // velocity so the challenge arrives in his PATH and forces the
            // turn.
            if (a.target) {
                double td = dist(p.x, p.y, a.target->x, a.target->y);
                double lead = clamp(td / 90.0, 0.25, 0.8);
                // Pinned on the carrier's BACK at contact range: the shielded
                // ball sits beyond the challenge gate and the short lead point
                // is inside the collision bubble, so the chaser rides there
                // indefinitely (watched replay: a CM locked at exactly 23px for
                // 10 straight seconds of a wing carry, zero challenges). Swing
                // AROUND to the cut-off point ahead of the run — with a sprint
                // edge over a dribbling carrier he gets goal-side, the ball is
                // shown, and the duel actually happens.
                double cs = std::hypot(a.target->vx, a.target->vy);
                double aroundX = 0.0, aroundY = 0.0;
                if (td < 40.0 && cs > 8.0) {
                    double bx = (p.x - a.target->x) / std::max(td, 1.0);
                    double by = (p.y - a.target->y) / std::max(td, 1.0);
                    if ((bx * a.target->vx + by * a.target->vy) / cs < -0.3) {
                        lead = 1.25;
                        // Route AROUND the body: the straight line to a cut-off
                        // point up the running lane drives the chaser INTO the
                        // carrier's back, and the separation force cancels the
                        // approach into a net crawl at exactly the dribble pace
                        // (measured: 23px behind, 30px/s, for 10s). Swing out on
                        // the goal side of the run and come around.
                        double perpX = -a.target->vy / cs, perpY = a.target->vx / cs;
                        double side = (perpX * (ownGoalXFor(player.team) - a.target->x)) >= 0.0 ? 1.0 : -1.0;
                        aroundX = perpX * side * 26.0;
                        aroundY = perpY * side * 26.0;
                    }
                }
                p.targetX = clamp(a.target->x + a.target->vx * lead + aroundX, 8.0, PITCH_W - 8.0);
                p.targetY = clamp(a.target->y + a.target->vy * lead + aroundY, 8.0, PITCH_H - 8.0);
            } else {
                p.targetX = p.x;
                p.targetY = p.y;
            }
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
        // CB partnership clamp, in possession (shape audit: back line "broken"
        // 24-28% of in-possession samples, 45% of them pure TARGET splits —
        // Chiellini's own target sat 25m behind Van Dijk's body at 2:05). A CB
        // never plans to sit more than 70px behind his partner while his team
        // has the ball; he steps up with the line.
        if (isCenterBack() && engine.state.ball.controllerId >= 0) {
            Player* cc = engine.playerById(engine.state.ball.controllerId);
            if (cc && cc->team == p.team) {
                double fdm = fdFor(p.team);
                for (auto& tm : engine.state.players) {
                    if (tm.team != p.team || tm.id == p.id || tm.role != Role::CB || tm.sentOff) continue;
                    double gap = (tm.targetX - p.targetX) * fdm;
                    if (gap > 70.0) p.targetX = tm.targetX - fdm * 70.0;
                    break;
                }
            }
        }
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
    bool ownDefensiveThird = pitch::inOwnDefensiveThird(p.x, p.team);
    if (skillMoveCooldown == 0 && cp.nearestPlayer && nearbyOpps <= 2 && !ownDefensiveThird
        && cp.score > 0.72 && nearestOppDist > 18.0 && nearestOppDist < 58.0) {
        double skillChance = 0.013 + attrFactor(p.attrs.creativity) * 0.050;   // G3 razzle: trimmed ~0.6x (was 0.022+0.085) toward real ~20-30/match; goal-safe (skill-moves don't score)
        // Take-ons live in the final third — that's where beating a man is
        // worth the risk.
        bool inFinalThirdAtk = pitch::inFinalThird(p.x, p.team);
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
                // Defender geometry decides the trick (renderer animates each):
                // square-on and touch-tight with elite feet -> NUTMEG (through
                // his legs); pressing from behind/side -> ROULETTE (spin off
                // him); frontal take-on in the final third -> STEPOVER.
                double defD = dist(p.x, p.y, def->x, def->y);
                double defAhead = (def->x - p.x) * fd;
                bool squareOn = defAhead > 8.0 && std::abs(def->y - p.y) < 14.0;
                bool fromBehindSide = defAhead < 4.0;
                if (squareOn && defD < 26.0 && attrFactor(p.attrs.creativity) > 0.62) {
                    // Nutmeg: ball THROUGH the defender, carrier darts around.
                    p.targetX = clamp(def->x + fd * 48.0, 30.0, PITCH_W - 30.0);
                    p.targetY = clamp(p.y + ((def->y >= p.y) ? -20.0 : 20.0), 30.0, PITCH_H - 30.0);
                    engine.agentFor(*def)->stunLock(30);
                    engine.blockReboundFor(def->id, 950);
                    moveType = "nutmeg";
                } else if (fromBehindSide && defD < 34.0) {
                    // Roulette: 360 spin away from the contact shoulder.
                    double side = (def->y >= p.y) ? -1.0 : 1.0;
                    p.targetX = clamp(p.x + fd * 40.0, 30.0, PITCH_W - 30.0);
                    p.targetY = clamp(p.y + side * 36.0, 30.0, PITCH_H - 30.0);
                    engine.agentFor(*def)->stunLock(26);
                    engine.blockReboundFor(def->id, 850);
                    moveType = "roulette";
                } else if (finalThird) {
                    // Step-over take-on: beat the man TOWARD goal — slip past
                    // his outside shoulder and attack the box.
                    double side = (def->y >= p.y) ? -1.0 : 1.0;
                    p.targetX = clamp(def->x + fd * 56.0, 30.0, PITCH_W - 30.0);
                    p.targetY = clamp(def->y + side * 44.0, 30.0, PITCH_H - 30.0);
                    engine.agentFor(*def)->stunLock(24);
                    engine.blockReboundFor(def->id, 800);
                    moveType = "stepover";
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
    bool onFlank = pitch::lateralFromCenter(p.y) > 120.0;
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
    double distToGoalX = pitch::distToOppGoal(p.x, p.team);
    bool targetForward = (fd > 0.0 && p.targetX > p.x + 30.0) || (fd < 0.0 && p.targetX < p.x - 30.0);
    bool breakawayBurst = clearPath && advancedEnough && distToGoalX < 480.0
        && nearestOppDist > 40.0 && distToTarget > 90.0 && targetForward;
    // Chase escape (watched replay seed 133 1:10): being run down FROM BEHIND
    // with open grass ahead is the classic knock-and-go — but every space gate
    // above fails because the chaser IS the nearest opponent. If the nearest
    // man is level-or-behind the shoulder relative to the run, and the path
    // ahead is clear, punch it forward and maximize the advantage.
    bool chaseEscapeBurst = false;
    if (clearPath && advancedEnough && targetForward && distToTarget > 90.0
        && nearestOppDist > 22.0 && nearestOppDist < 90.0) {
        const Player* chaser = nullptr;
        double chaserD = 1e9;
        for (auto& o : engine.state.players) {
            if (o.team == p.team || o.role == Role::GK || o.sentOff) continue;
            double dd = dist(o.x, o.y, p.x, p.y);
            if (dd < chaserD) { chaserD = dd; chaser = &o; }
        }
        if (chaser) {
            double rdx = p.targetX - p.x, rdy = p.targetY - p.y, rl = std::hypot(rdx, rdy);
            double aheadOfMe = rl > 1.0 ? ((chaser->x - p.x) * rdx + (chaser->y - p.y) * rdy) / rl : 1e9;
            chaseEscapeBurst = aheadOfMe < 12.0;
        }
    }
    bool mayBurst = engine.canKnockBallAhead(p.id) && cp.score < (needsCarryShotWindow ? 0.82 : 0.65)
        && (openBurst || speculativeBurst || finalThirdBurst || needsCarryShotWindow || breakawayBurst || chaseEscapeBurst);
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
