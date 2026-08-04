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
    takeOnCooldown = std::max(0, takeOnCooldown - 1);
    // Round-21 (take-on audit) COMMIT 6b: the jockey-lock only means something
    // while THIS player holds the ball. Reset it whenever he isn't the carrier —
    // otherwise the lock survived possession loss / a restart / half-time and a
    // stale count let him commit a take-on the instant he next touched the ball.
    if (engine.state.ball.controllerId != player.id) { jockeyLockTicks = 0; jockeyLockDefId = -1; }

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
            // Settle along a FIXED direction — a time-rotating target made the
            // carrier orbit it and pirouette at the turn cap after every collection.
            // Round-36: on a fresh REGAIN that direction is the cached secure
            // vector (away from the man just beaten and out of the local knot),
            // NOT `facing`. The tackle lunge sets facing at the man being tackled,
            // so the plain-facing settle walked every tackle winner 18-21px back
            // into the opponent he had just beaten (owner, seed 407 0:26).
            double sx = std::cos(player.facing), sy = std::sin(player.facing);
            if (engine.securing(player.id)) {
                sx = engine.duel[player.id].secureDirX;
                sy = engine.duel[player.id].secureDirY;
            }
            double tx = player.x + sx * 3.0;
            double ty = player.y + sy * 3.0;
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
        // Deep defenders read an IMMINENT steady closer as trouble too (seed
        // 111 0:45: pid5 closed 2B at 44-45px/s — under the 50 sprint bar —
        // so no valve armed, the GK ball never reached the menu, and 2B
        // turned into the traffic and was stripped). A flat lower bar (38)
        // was tried and REVERTED: it sits below normal press-approach speed,
        // the valve went permanent and clearances blew 164 -> 274/90. The
        // deep-defender clause instead requires the closer already INSIDE
        // 65px and still coming — contact inside ~1.5s, not a distant cruise.
        bool deepDefValve = isDefenderLike()
            && pitch::forwardProgress(player.x, player.team) < PITCH_W * 0.34;
        // NOTE (round 18, seed 111 0:45): wiring a lower/imminence closing bar
        // into tackleComing for deep defenders was tried THREE ways (flat 38,
        // 65px@34, banded 30-65px@34) and each kept the clearance valve
        // near-permanent (+84 to +110 clears/90) — deep defenders always have
        // someone closing at press pace. The 0:45 fix is the DRIBBLE TAX
        // below instead: same imminence read, but it only demotes turning
        // into the traffic, never mints a hoof.
        bool imminentDeepCloser = false;
        if (deepDefValve) {
            for (auto& o : engine.state.players) {
                if (!isActiveOpponent(o, player.team)) continue;
                double dxo = player.x - o.x, dyo = player.y - o.y;
                double d2 = std::hypot(dxo, dyo);
                if (d2 < 30.0 || d2 > 65.0) continue;
                if ((o.vx * dxo + o.vy * dyo) / d2 > 34.0) { imminentDeepCloser = true; break; }
            }
        }
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
                // <140 -> arriving-or-<60 (seed 111 22:37: a LONE presser 64px
                // away drove three first-touch clears in 0.8s — the pinball.
                // The hoof needs pressure genuinely ARRIVING, not just present).
                && (tackleComing || per.nearestOpponentDist < 60.0);
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
                        // Round-21 (arena audit): a sent-off ghost is parked at
                        // y=-40 — hoofing the panic clearance at it gifted 85% of
                        // arena "clearances" straight to the opponent (the owner's
                        // "0:45 passing to each other"). Skip ejected men; if none
                        // survive, tgt stays null and the Clear is never pushed —
                        // the carrier prices dribble/take-on/hold normally instead
                        // of a blind hoof to nobody. Inert in 11v11.
                        if (t.team != player.team || t.id == player.id || t.role == Role::GK || t.sentOff) continue;
                        // The panic ball goes long AND wide — up the channel,
                        // not through the middle where losing it is fatal.
                        // (A "directed outlet into a breakaway runner's path"
                        // variant was A/B'd here and REVERTED: even gated to
                        // 130px-ahead sprinters projected 70px free, it
                        // re-tagged ~5 hoofs/match as through balls and
                        // halved conversion — the lever needs its own pass.)
                        // Width was REWARDED here (+lat*0.35) and it hooked the
                        // clear onto a wide man near our own byline: seed 305
                        // 1:27, 2R hoofed 88 degrees across the face of his own
                        // box to the touchline corner, entirely on the width
                        // bonus (the central CF outscored him on forward gain).
                        // Prefer the CENTRAL forward out-ball — the middle is
                        // where the danger actually leaves.
                        double fx = pitch::forwardProgress(t.x, player.team)
                                  - pitch::lateralFromCenter(t.y) * 0.20;
                        // Square-hoof guard, on the ball's actual travel RATIO
                        // (the old forward-gain<50 test passed a ball going
                        // 320px sideways for 94px forward): far more sideways
                        // than forward across our own face is never the clear.
                        double relFwd = (t.x - player.x) * fdFor(player.team);
                        double relLat = std::abs(t.y - player.y);
                        if (relLat > relFwd * 1.5 + 120.0) fx -= 400.0;
                        // Round-26: the clear scan had NO lane check, so it could
                        // pick a teammate whose lane the pass-scorer's own point-
                        // blank veto (perp<17, near half, presser within the fresh
                        // release radius) rejects for identical geometry on the
                        // same tick — the owner's 0:09 pid3 clear drilled 65px
                        // straight to an opponent. Penalise (never skip: one
                        // presser can straddle two lanes and null every target in
                        // a swarm, the starved-carrier Hold tombstone) any target
                        // with an opponent point-blank in front of the release
                        // lane. Same magnitude as the square-hoof guard; the
                        // guaranteed fallback (least-bad target still wins) holds.
                        double cdx = t.x - player.x, cdy = t.y - player.y, cls = cdx * cdx + cdy * cdy;
                        if (cls >= 1.0) {
                            for (auto& o : engine.state.players) {
                                if (o.team == player.team || o.role == Role::GK || o.sentOff) continue;
                                double t2 = clamp(((o.x - player.x) * cdx + (o.y - player.y) * cdy) / cls, 0.0, 1.0);
                                double perp = std::hypot(o.x - player.x - t2 * cdx, o.y - player.y - t2 * cdy);
                                if (perp < 17.0 && t2 < 0.5 && dist(o.x, o.y, player.x, player.y) < 70.0) { fx -= 400.0; break; }
                            }
                        }
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
            // Seed 111 0:45: a deep defender with a closer arriving does NOT
            // turn on the ball and carry into him — the pass menu (CB, and
            // the keeper when the press is real) must win that beat.
            if (x.type == ActionType::Dribble && imminentDeepCloser) x.score -= 0.22;
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
            bool tightPress = per.nearestOpponentDist < 20.0 || pc >= 2
                || (tackleComing && progress < PITCH_W * 0.42);
            // A panic Clear is never "composing" — braking it (esp. the −2.0
            // hard gate below: Clear is a Pass, deep zone, fresh touch — all
            // three conditions of a panic situation) left the swarmed deep
            // receiver standing on the ball until the tackle arrived. The keeper
            // recycle is the same class of escape ball WHEN THE PRESS IS REAL —
            // exempting it unconditionally made the GK the only playable ball of
            // every braked deep hold, and build-up degenerated into a
            // defender→GK→defender loop (measured 28-47 backpasses/match).
            // A clearance is only "no time to think" when the press is REAL
            // (seed 111 22:37: dwell-exempt Clears pinballed first-time hoofs
            // between three own clearers in 0.8s). Un-pressed, the receiver of
            // a clearance takes a settling touch like anyone else.
            bool panicClear = (x.purpose == ActionPurpose::Clear && (tightPress || tackleComing))
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

    // ── Absolute pass-quality floor (round-29, owner 0:18) ── whatever menu
    // arithmetic produced it, a chosen ordinary Pass whose shared grade is
    // sub-floor loses to dribble/hold/shield — deliberate-risk classes
    // (through/cross/cutback/clear) keep their aggression, and a genuinely
    // swarmed carrier in his own third is left alone (the clearance valve is
    // his out, not a shield that invites the swarm).
    if (ic && best.type == ActionType::Pass && best.target
        && best.purpose != ActionPurpose::Clear && best.purpose != ActionPurpose::Through
        && best.purpose != ActionPurpose::Cross && best.purpose != ActionPurpose::Cutback
        && engine.gradePass(player, *best.target) < 0.2) {
        int pcFloor = cachedPerception.has_value() ? cachedPerception->pressureCount : 0;
        bool emergency = pitch::distToOwnGoal(player.x, player.team) < PITCH_W * 0.33 && pcFloor >= 2;
        if (!emergency) {
            for (auto& x : a)
                if (x.type == ActionType::Dribble && x.score > 0.15) return x;
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
    }

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
            // Round-17 low-level audit (owner: "crosses that are unnatural —
            // facing forward but cross back inside milliseconds"): this gate
            // existed but spun the body at 0.55rad/tick (~33rad/s — a full 180
            // in 100ms) and released up to 77deg misaligned, so 27% of all
            // releases still flew >100deg off the facing of 200ms earlier
            // (180/677 measured, mostly SETTLED carriers at full power). Human
            // pivot: ~0.22rad/tick (180deg in ~250ms), release within ~54deg.
            // Pressure can force a different choice mid-turn — that's real.
            if (std::abs(offT) > 0.95) {
                facing = p.facing + clamp(offT, -0.22, 0.22);
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
            // Round-19 (audit): a Clear already emitted "clearance" above for this
            // same touch — emitting "pass" too made the viewer see both events on
            // one hoof. The clearance is the true label; skip the pass emit.
            if (a.purpose != ActionPurpose::Clear)
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
                // C4(1): re-key the swing-around on the carrier->own-goal ALONG-AXIS
                // projection of the defender (positive = defender is goal-side).
                // The old velocity-dot gate flickered every ~200ms; this is a
                // slow-moving positional read with a 20px release hysteresis and a
                // ~500ms minimum hold once engaged — persistence, not gate widening
                // (widening adot to 0 without dwell revived the round-27 orbit).
                double ogx = ownGoalXFor(player.team);
                double axX = ogx - a.target->x, axY = PITCH_H / 2.0 - a.target->y;
                double axL = std::max(1.0, std::hypot(axX, axY));
                axX /= axL; axY /= axL;
                double alongProj = (p.x - a.target->x) * axX + (p.y - a.target->y) * axY;
                bool movingCarrier = cs > 8.0 && td < 40.0;
                bool wantEngage  = movingCarrier && alongProj < 10.0;
                bool wantRelease = alongProj > 30.0 || td > 55.0 || cs < 6.0;
                if (shepherdEngaged && shepherdCarrierId == a.target->id) {
                    if (engine.state.clockMs >= shepherdHoldUntilMs && wantRelease)
                        shepherdEngaged = false;
                } else if (wantEngage) {
                    shepherdEngaged = true;
                    shepherdCarrierId = a.target->id;
                    shepherdHoldUntilMs = engine.state.clockMs + 500.0;   // 450-600ms min hold
                }
                if (shepherdEngaged && shepherdCarrierId == a.target->id && p.id >= 0 && p.id < 22) {
                    // C4: contain-first — hold the raised commit bar through the
                    // swing AND the "then contains" phase after he re-establishes
                    // goal-side (~900ms), so the recovery sprint doesn't nick-lunge
                    // every tick it grazes tackle range (steals off the shield bubble).
                    engine.duel[p.id].containUntilMs = engine.state.clockMs + 1100.0;
                }
                double aroundX = 0.0, aroundY = 0.0;
                if (shepherdEngaged && shepherdCarrierId == a.target->id && cs > 6.0) {
                    // Route AROUND the body to a cut-off point up the running lane:
                    // a straight line to the lead point drives the chaser INTO the
                    // carrier's back and the separation force cancels it to a crawl.
                    double vux = a.target->vx / cs, vuy = a.target->vy / cs;
                    double perpX = -vuy, perpY = vux;
                    // C4(3): pure-x carriers make perpX*(ownGoalX-carrier.x) ~ 0 and
                    // the side pick degenerates to a fixed +1 — fall back to showing
                    // the carrier toward the NEAREST touchline (defender takes the
                    // inside, toward center).
                    double gsMetric = perpX * (ogx - a.target->x);
                    double side;
                    if (std::abs(gsMetric) < 8.0) {
                        double towardCenterY = a.target->y < PITCH_H / 2.0 ? 1.0 : -1.0;
                        side = (perpY * towardCenterY >= 0.0) ? 1.0 : -1.0;
                    } else {
                        side = gsMetric >= 0.0 ? 1.0 : -1.0;
                    }
                    // C4(2): a real cut-off LEAD ahead of the run (floor ~50px, was
                    // vel*1.25 ~ 32px), plus a goal-side swing so he arrives level
                    // and shows the ball, not glued to the back.
                    double leadDist = clamp(cs * 1.6, 50.0, 120.0);
                    p.targetX = clamp(a.target->x + vux * leadDist + perpX * side * 26.0, 8.0, PITCH_W - 8.0);
                    p.targetY = clamp(a.target->y + vuy * leadDist + perpY * side * 26.0, 8.0, PITCH_H - 8.0);
                } else {
                    p.targetX = clamp(a.target->x + a.target->vx * lead, 8.0, PITCH_W - 8.0);
                    p.targetY = clamp(a.target->y + a.target->vy * lead, 8.0, PITCH_H - 8.0);
                }
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
    // Success scales with creativity; the beaten defender is locked out of an
    // immediate tackle (the contest rebound lockout below).
    bool ownDefensiveThird = pitch::inOwnDefensiveThird(p.x, p.team);
    // ── Awareness: a presser CHARGING STRAIGHT AT ME (owner, seed 437 0:33:
    // "this guy is running straight at me, let me not face him head on and
    // rotate as he tries to get around me... maybe beat him with skill") ──
    // The random skill roll below excludes touch-tight range (>18px) and
    // fires ~5% per beat, so a carrier who turned the ball square to a
    // sprinting presser mostly just showed it and hoped. A genuine
    // straight-line charge is a DETERMINISTIC read: shield-turn the carry to
    // the shoulder AWAY from his approach, body between him and the ball.
    // Hard-gated (real sprint >40px/s, chargeDot >0.60, ~5s cooldown) so it
    // can't become trick-spam or a free escape from ordinary pressing.
    if (skillMoveCooldown == 0 && cp.nearestPlayer && !ownDefensiveThird) {
        Player* chg = cp.nearestPlayer;
        double rx = p.x - chg->x, ry = p.y - chg->y, rd = std::max(1.0, std::hypot(rx, ry));
        double ds = std::hypot(chg->vx, chg->vy);
        double chargeDot = ds > 8.0 ? (chg->vx * rx + chg->vy * ry) / (ds * rd) : 0.0;
        // ...and I'M FACING HIM — the complaint case is the carrier square-on
        // to the charge showing the ball, not any pressed carry (without this
        // gate the read fired on cooldown all match: 375 "skill moves" vs the
        // ~25 band; every presser sprints at his carrier).
        double faceChgDot = std::cos(p.facing) * (-rx / rd) + std::sin(p.facing) * (-ry / rd);
        if (rd < 38.0 && ds > 55.0 && chargeDot > 0.72 && faceChgDot > 0.5) {
            double appAng = std::atan2(chg->vy, chg->vx);
            double side = std::sin(p.facing - appAng) >= 0.0 ? 1.0 : -1.0;   // shoulder away from his line
            double fdc = fdFor(p.team);
            p.targetX = clamp(p.x - fdc * 20.0 + std::cos(appAng + side * 1.9) * 44.0, 30.0, PITCH_W - 30.0);
            p.targetY = clamp(p.y + std::sin(appAng + side * 1.9) * 44.0, 30.0, PITCH_H - 30.0);
            engine.markActiveShield(p.id);   // the turn is a shield, not a free nick
            engine.emitEvent("dragback", p.x, p.y, p.id, chg->id);
            engine.stats.recordSkillMove();
            skillMoveCooldown = 300;
            return;
        }
    }
    if (skillMoveCooldown == 0 && cp.nearestPlayer && nearbyOpps <= 2 && !ownDefensiveThird
        && cp.score > 0.72 && nearestOppDist > 18.0 && nearestOppDist < 58.0) {
        double skillChance = 0.013 + attrFactor(p.attrs.creativity) * 0.050;   // G3 razzle: trimmed ~0.6x (was 0.022+0.085) toward real ~20-30/match; goal-safe (skill-moves don't score)
        // Round-27 COMMIT 3 (owner 13:09 "improve CB decision making to be safer"):
        // the take-on trigger had NO role gate — a CB rolled a skill-move under
        // press in his own half and was stripped in 33ms. A defender in his own
        // half almost never dribbles out of trouble; slash the take-on chance
        // there (a stray elite roll can still fire, but ~0.15x). Attackers and
        // anyone in the opposition half are untouched.
        if (roles::isDefenderRole(p.role) && pitch::inOwnHalf(p.x, p.team))
            skillChance *= 0.15;
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
                engine.blockReboundFor(def->id, 950);   // rebound lockout (the dead stunLock on a non-controller was removed)
                moveType = "nutmeg";
            } else if (defAhead) {
                // Drag-back: turn away from the presser and open up sideways.
                double side = (p.y < PITCH_H / 2.0) ? 1.0 : -1.0;
                p.targetX = clamp(p.x - fd * 26.0, 30.0, PITCH_W - 30.0);
                p.targetY = clamp(p.y + side * 58.0, 30.0, PITCH_H - 30.0);
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
                    engine.blockReboundFor(def->id, 950);
                    moveType = "nutmeg";
                } else if (fromBehindSide && defD < 34.0) {
                    // Roulette: 360 spin away from the contact shoulder.
                    double side = (def->y >= p.y) ? -1.0 : 1.0;
                    p.targetX = clamp(p.x + fd * 40.0, 30.0, PITCH_W - 30.0);
                    p.targetY = clamp(p.y + side * 36.0, 30.0, PITCH_H - 30.0);
                    engine.blockReboundFor(def->id, 850);
                    moveType = "roulette";
                } else if (finalThird) {
                    // Step-over take-on: beat the man TOWARD goal — slip past
                    // his outside shoulder and attack the box.
                    double side = (def->y >= p.y) ? -1.0 : 1.0;
                    p.targetX = clamp(def->x + fd * 56.0, 30.0, PITCH_W - 30.0);
                    p.targetY = clamp(def->y + side * 44.0, 30.0, PITCH_H - 30.0);
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

    // ── Take-on: beat the escorting defender with a feint + explosive burst ──
    // Round-21 (arena 1v1; benefits 11v11 wing iso): the ambient skill-move roll
    // above fires ~5% and gains no ground against an equal-pace jockey — a
    // carrier can be escorted at a constant ~22px for 9s and never separate. A
    // genuine take-on is a DELIBERATE commit: once a single defender has shadowed
    // him close, goal-side and at matched pace for ~700ms (the jockey-lock), the
    // carrier picks the defender's blind side, sells a feint (an existing skill
    // event) and explodes past with a real burst — the carrier-side twin of the
    // tackle lunge-dash — while the beaten man eats the contest lockout.
    {
        double fdc = fdFor(p.team);
        Player* def = cp.nearestPlayer;
        bool locked = false;
        if (def && def->role != Role::GK && !ownDefensiveThird) {
            double dx = def->x - p.x, dy = def->y - p.y, dd = std::hypot(dx, dy);
            bool goalSideX = (fdc > 0 ? def->x >= p.x - 6.0 : def->x <= p.x + 6.0);
            double relv = std::hypot(p.vx - def->vx, p.vy - def->vy);
            if (dd < 44.0 && goalSideX && relv < 55.0) locked = true;
        }
        if (locked && def) {
            if (jockeyLockDefId != def->id) { jockeyLockDefId = def->id; jockeyLockTicks = 0; }
            jockeyLockTicks++;
        } else {
            jockeyLockTicks = 0;
            jockeyLockDefId = -1;
        }
        // Isolation gate (11v11): only take a man on with room to attack — no
        // SECOND opponent within 120px. The arena has one defender, so it is
        // always satisfied there; in open play it fires on the wing iso / break.
        int nearOpps120 = 0;
        for (auto& o : engine.state.players) {
            if (o.team == p.team || o.role == Role::GK || o.sentOff) continue;
            if (dist(p.x, p.y, o.x, o.y) < 120.0) nearOpps120++;
        }
        bool isolated = nearOpps120 <= 1;
        // Round-21 (take-on audit) COMMIT 6a: placement. The bare !ownDefensiveThird
        // gate produced 50+ take-ons/team/90 (real ~12-18), 94% of them in the
        // middle third. Normally require the ATTACKING HALF; allow a middle-third
        // take-on only for a genuinely elite dribbler (creativity >= 70), or when a
        // counter is on — few opponents goal-side of the carrier. Never in his own
        // defensive third. The lock also runs an extra beat (60 ticks, ~1s escort).
        bool attackingHalf = !pitch::inOwnHalf(p);
        bool middleThird   = !ownDefensiveThird && !attackingHalf;
        double gxc = goalXFor(p.team);
        int oppsGoalSide = 0;
        for (auto& o : engine.state.players) {
            if (o.team == p.team || o.role == Role::GK || o.sentOff) continue;
            if ((gxc > p.x) ? (o.x > p.x) : (o.x < p.x)) oppsGoalSide++;
        }
        bool counterOn      = oppsGoalSide <= 2;
        bool eliteDribbler  = attrFactor(p.attrs.creativity) >= 0.70;
        bool placementOk    = attackingHalf || (middleThird && (eliteDribbler || counterOn));
        // Round-28 C7 (Messi beat trigger): replace the pure jockey timer with two
        // paths. PRIMARY commit-read — a jockeying defender has actually committed
        // a challenge (engine hook, not raw closing velocity: R27 made jockeys
        // patient, so closing>35 qualified only 5/47); this is the beatable moment.
        // SECONDARY stall-timeout — a jittered 1.5-2.5s fallback at TODAY'S baseline
        // odds so the take-on doesn't dry up vs a patient jockey who never commits
        // (this leg carries most volume; cutting its odds collapses the band). The
        // jitter is (carrier,defender)-keyed so the inter-attempt histogram doesn't
        // spike at the timeout value.
        // The commit itself is the signal — do NOT gate on jockeyLockTicks: a
        // defender's committing lunge spikes relative velocity, which breaks the
        // lock (resets the timer), so gating on it made the commit-read never fire.
        // Round-28 C8 probe: half a second into the jockey lock, slow the carry to
        // a probing ~0.7x touch for a HARD-CAPPED 0.4-0.9s (pair-jittered) window —
        // show the ball, invite the commit, then let C7's commit-read punish it.
        // Armed only where a take-on could actually fire (isolated, placement, off
        // cooldown) and renewed per tick strictly INSIDE the window: the cap is
        // structural (round-27 contain deadband+dwell = static face-off / marathon /
        // arena-freeze tombstones; an uncapped probe re-creates them).
        if (locked && def && takeOnCooldown == 0 && isolated && placementOk) {
            int probeLen = 24 + ((p.id * 7 + def->id * 13) % 31);   // 24-54 ticks = 0.4-0.9s
            if (jockeyLockTicks >= 30 && jockeyLockTicks < 30 + probeLen)
                engine.duel[p.id].probeSlowUntilMs = engine.state.clockMs + 40.0;   // ~2 ticks — dies unless renewed
        }
        bool defenderCommitted = def && def->role != Role::GK && def->id >= 0 && def->id < 22
            && engine.duel[p.id].committedTackleVsCarrierMs > 0.0
            && engine.duel[p.id].committedTackleVsCarrierMs > engine.state.clockMs - 250.0
            && engine.duel[p.id].committedTackleVsCarrierBy == def->id;
        int stallThreshold = 90 + ((p.id * 13 + (def ? def->id : 0) * 7) % 61);   // 90-150 ticks = 1.5-2.5s
        bool viaCommit = defenderCommitted;
        bool stallTimeout = jockeyLockTicks >= stallThreshold;
        if (def && takeOnCooldown == 0 && (defenderCommitted || stallTimeout) && isolated && placementOk) {
            double ddx = def->x - p.x, ddy = def->y - p.y, ddl = std::max(1.0, std::hypot(ddx, ddy));
            // Slip to the defender's blind side: the side away from his BODY offset
            // (the ball ends up on the far side from him). Only when he is squared
            // directly ahead do we fall back to his lateral drift's blind side, then
            // to the open pitch. Choosing by body offset first keeps the across-face
            // penalty below consistent with the side we actually take.
            // Round-21 (take-on audit) COMMIT 5: side choice with variety. A
            // fixed blind-side rule staircased 41/44 beats onto the same shoulder
            // (corner-bound). Take his blind side when he clearly shades (>20px)
            // or drifts one way; but when he is squared up / marginally offset,
            // blend the open-pitch pull (toward the middle third) with a
            // per-attempt rng draw so consecutive beats genuinely alternate.
            double side;
            if (std::abs(ddy) > 20.0)         side = ddy > 0 ? -1.0 : 1.0;
            else if (std::abs(def->vy) > 8.0) side = def->vy > 0 ? -1.0 : 1.0;
            else {
                double openBias  = (p.y < PITCH_H / 2.0) ? 1.0 : -1.0;
                double bodyBlind = (ddy > 0.0) ? -1.0 : 1.0;
                double s = openBias * 0.55
                         + bodyBlind * (std::abs(ddy) / 20.0) * 0.45
                         + (engine.rng.random() - 0.5) * 1.1;
                side = s >= 0.0 ? 1.0 : -1.0;
            }
            // Round-21 (take-on audit) COMMIT 2: touchline shoulder choice. The
            // old override flipped `side` inward UNCONDITIONALLY near a touchline;
            // on the wing — exactly where 11v11's isolation gate concentrates
            // attempts — the defender shepherds inside, so the forced-inward beat
            // cut straight across his face (lateralFace huge, odds floored at
            // 5-9%; 28% of attempts). Beat him on whichever shoulder is his BLIND
            // side: inward when he shades outside, else down the line on the
            // outside shoulder when there's touchline room. If BOTH shoulders are
            // bad here (crammed on the line, shading inside), DON'T roll a doomed
            // attempt — short-set the cooldown and keep escorting (the lock keeps
            // accruing) until the geometry opens up.
            bool committed = true;
            bool nearTop = p.y < 130.0, nearBot = p.y > PITCH_H - 130.0;
            if (nearTop || nearBot) {
                double inward = nearTop ? 1.0 : -1.0, outward = -inward;
                bool outsideRoom = nearTop ? (p.y > 58.0) : (p.y < PITCH_H - 58.0);
                if (inward * ddy <= 0.0)                      side = inward;
                else if (outward * ddy <= 0.0 && outsideRoom) side = outward;
                else { takeOnCooldown = 40; committed = false; }
            }
          if (committed) {
            // Angle modulation (both real): a residual cut toward the side his body
            // shades is riskier (across the face), while a defender COMMITTING —
            // closing hard at the ball — is easier to slip than a patient jockey.
            double lateralFace = std::max(0.0, side * (ddy / ddl));
            double closing = -((def->vx - p.vx) * ddx + (def->vy - p.vy) * ddy) / ddl;
            // C7: a defender who has COMMITTED is far easier to slip than a patient
            // jockey — a flat 0.22 read bonus. The stall-timeout leg keeps today's
            // closing-scaled baseline (do NOT cut it — it carries the volume).
            double commitBonus = viaCommit ? 0.22 : clamp(closing / 55.0, 0.0, 1.0) * 0.10;
            // COMMIT 5: vary the cut so beats don't all fire the same ~29°/58px
            // shape. Lateral slip in [0.30,0.65] and burst length in [45,75]px,
            // scaled by creativity (sharper, longer for the tricky) and damped by
            // lateralFace (can't cut as hard across his body), plus an rng jitter.
            double creF = attrFactor(p.attrs.creativity);
            double j = engine.rng.random();
            double dashLen = clamp(48.0 + creF * 22.0 + (j - 0.5) * 18.0, 45.0, 75.0);
            // R28 C8 (beat execution): the old beat vector (fdc*0.88 + a small
            // lateral slip) hard-capped the cut at ~36°, so every won beat was a
            // straight-line speed roll (realized median 11-18°). Stage 1 now SELLS
            // THE SHOULDER: 45-90° off the goal axis toward the chosen side —
            // sharper for the tricky, softened when cutting across his face — for
            // the first ~40% of the dash; stage 2 (below) snaps goal-ward at the
            // chop. Unit-length by construction, same ramp/peak speed model.
            double chopDeg = clamp(45.0 + creF * 25.0 + (j - 0.5) * 24.0 - lateralFace * 18.0, 45.0, 90.0);
            double chopRad = chopDeg * PI / 180.0;
            double bx = fdc * std::cos(chopRad), by = side * std::sin(chopRad);
            // Round-21 (take-on audit): differential odds — score the ATTACKER's
            // edge OVER THIS defender, not raw attribute LEVELS. The level form
            // capped equal-65s at ~17.6% and only the arena's cre97-vs-tkl26 ever
            // cleared ~0.5, so 11v11 take-ons died at ~6%. atk/dfd are weighted
            // composites; their gap (scaled ×1.1) is the real contest. Sanity:
            // equal-65s ≈ 44%; elite winger (cre85/spd88) over avg FB (tkl72/pos70) ≈ 60%.
            double atk = 0.72 * attrFactor(p.attrs.creativity) + 0.28 * attrFactor(p.attrs.speed);
            double dfd = 0.78 * attrFactor(def->attrs.tackling) + 0.22 * attrFactor(def->attrs.positioning);
            double odds = 0.44 + 1.1 * (atk - dfd) + commitBonus - lateralFace * 0.18;
            odds = clamp(odds, 0.08, 0.88);
            bool won = engine.rng.random() < odds;
            const char* mv = lateralFace > 0.4 ? "roulette" : "stepover";
            engine.emitEvent(mv, p.x, p.y, p.id, def->id);          // feint visual (viewer)
            engine.emitEvent("takeon", p.x, p.y, p.id, def->id, /*traceOnly=*/true);   // COMMIT 6c: distinct forensics marker
            engine.stats.recordTakeOn(won);
            // COMMIT 6c: do NOT recordSkillMove here — takeOnAttempts already
            // counts the beat; double-counting inflated the tuned skillMoves band.
            // COMMIT 6a/5: base cooldown ~5s in open play so a team takes a man on
            // ~12-18x/90, jittered off the 1.33s grid. Keep the arena lively —
            // scale the base down there and for dribble_more carriers (~15-30/10min).
            double cdBase = engine.arenaMode ? 85.0 : 300.0;
            if (engine.directiveBias[p.id].dribbleBonus > 0.0) cdBase *= engine.arenaMode ? 0.9 : 0.6;
            takeOnCooldown = static_cast<int>(cdBase + engine.rng.random() * 40.0);
            jockeyLockTicks = 0;
            if (won) {
                // Explosive cut past him: a carrier-side lunge-dash (fixedUpdate
                // plays it out at LUNGE_DASH_SPEED with the ball glued), plus the
                // beaten-defender contest lockout so he can't insta-recover.
                engine.lungeDash[p.id].dirX = bx;
                engine.lungeDash[p.id].dirY = by;
                engine.lungeDash[p.id].remainPx = dashLen;
                // Round-23 (carrier burst realism): seed the ramp from the
                // carrier's CURRENT pace up to a speed-scaled peak (~80-104px/s),
                // so a won take-on accelerates into the burst and settles out of
                // it instead of snapping flat to 120 for the whole 45-75px.
                engine.lungeDash[p.id].spd  = std::hypot(p.vx, p.vy);
                engine.lungeDash[p.id].peak = clamp(72.0 + 32.0 * attrFactor(p.attrs.speed), 80.0, 104.0);
                // R28 C8: stage 2 — re-aim goal-ward at ~60% remaining (the chop).
                // Clamped away from the touchlines, and away from an OCCUPIED cover
                // lane: markActiveShield/blockRebound only lock the BEATEN man, so a
                // covering defender sitting in the exit lane is cut away from, not
                // dashed into. engine.cpp swaps the dash onto dir2 at the switch
                // point and emits the 'chop' event there.
                double stage1 = clamp(dashLen * 0.4, 15.0, 25.0);
                double cutX = p.x + bx * stage1, cutY = p.y + by * stage1;
                double g2x = fdc, g2y = side * 0.25;
                if (cutY < 95.0)                 g2y = std::max(g2y, 0.18);
                else if (cutY > PITCH_H - 95.0)  g2y = std::min(g2y, -0.18);
                for (auto& o : engine.state.players) {
                    if (o.team == p.team || o.role == Role::GK || o.sentOff || o.id == def->id) continue;
                    double lox = (o.x - cutX) * fdc, loy = o.y - cutY;
                    if (lox > 0.0 && lox < 110.0 && std::abs(loy) < 34.0) {
                        g2y += (loy >= 0.0 ? -0.30 : 0.30);   // exit lane occupied — cut to his empty side
                        break;
                    }
                }
                double g2l = std::hypot(g2x, g2y);
                engine.lungeDash[p.id].dir2X = g2x / g2l;
                engine.lungeDash[p.id].dir2Y = g2y / g2l;
                engine.lungeDash[p.id].switchPx = dashLen - stage1;
                p.facing = std::atan2(by, bx);
                p.dribbleType = 3;   // drive on after the burst
                // Once the body is past him, STRAIGHTEN onto goal — the beat is a
                // means to a shooting angle, not an end. A target still aimed along
                // the (lateral) beat vector zig-zagged the carrier into the corner
                // and killed the shot; drive at the goal with only a small residual
                // clearance to the beat side.
                double gx = goalXFor(p.team);
                double gy = PITCH_H / 2.0;
                p.targetX = clamp(p.x + fdc * 130.0, 30.0, PITCH_W - 30.0);
                // C8: the post-burst drive aligns with the stage-2 exit lane, not
                // the stage-1 shoulder sell (which now points up to 90° sideways).
                p.targetY = clamp(p.y + engine.lungeDash[p.id].dir2Y * 34.0 + (gy - p.y) * 0.25, 30.0, PITCH_H - 30.0);
                (void)gx;
                // COMMIT 4a: hold DRIBBLE_FAST for ~1.5s so the next tick can't
                // re-classify the carry down to DRIBBLE_MEDIUM while the beaten
                // man recovers at sprint pace — the beat must buy a running start.
                engine.duel[p.id].beatWindowUntilMs = engine.state.clockMs + 1500.0;
                engine.blockReboundFor(def->id, 850);
                // COMMIT 4b: a REAL two-stage off-balance (agent_movement honours
                // beatenSlowUntilMs) — replaces the dead stunLock(24), which was
                // only ever read on a controller. Extended 550 -> ~1100ms total.
                engine.duel[def->id].beatenSlowUntilMs = engine.state.clockMs + BEATEN_SLOW_TOTAL_MS;
                engine.markActiveShield(p.id);   // body past him first — no free nick
                return;
            } else {
                // Round-21 (take-on audit) COMMIT 3: beaten — a GENUINE turnover.
                // The old 70px/s nudge stalled ~12px on and the momentum-committed
                // carrier (nearest, and the at-rest hatch dissolved his lockout)
                // re-grabbed ~70% within ~220ms — 1.33s machine-gun retries; a
                // fast squirt past the defender overshot into empty space and
                // rolled uncollected. Award the defender who read the feint direct
                // control — mirror a clean tackle-won, same brief settle window —
                // and lock the beaten carrier out. NOT a foul.
                auto& b = engine.state.ball;
                b.controllerId = def->id;
                b.vx = b.vy = b.z = b.vz = 0;
                b.curl = 0;
                b.lastTouchTeam = def->team;
                b.lastToucherId = def->id;
                b.intendedReceiverId = -1;
                engine.lastRicochetMs = -1e9;
                // C4: shield the winner for the FULL 400ms gather stun (was 260) —
                // a stunned winner left challengeable at 260-400ms was drawing
                // incidental re-challenges (inflated tackle count).
                engine.receiverShieldUntil = engine.state.clockMs + 400;   // "he read the feint" settle
                engine.receiverShieldedPlayerId = def->id;
                engine.lastLooseOrigin = LooseOrigin::None;                // controlled now — not a loose ball
                engine.blockReboundFor(p.id, 900);   // beaten carrier can't instantly re-challenge
                // Round-28 C3(a) (owner 0:21): the winner used to be granted the
                // ball and pass it 33ms later — the grant read as a magic flip.
                // Give him the SAME 24-tick (~400ms) gather stun a clean tackle
                // win gets (:733), so the ball visibly settles at his foot before
                // any outlet, and amortize its travel across the duel gap over
                // 2-3 ticks (gather window). Deterministic grant is kept (round-21
                // tombstone: a loose squirt machine-gunned re-grabs).
                // Scoped OFF arena (like tackleStopEase / tackleModeLatch): a 1v1
                // stun+rebound double-static is the round-25/27 dwell-freeze family.
                if (!engine.arenaMode) {
                    engine.agentFor(*def)->stunLock(24);
                    if (def->id >= 0 && def->id < 22)
                        engine.duel[def->id].carrierGatherUntilMs = engine.state.clockMs + 100.0;
                }
                engine.emitEvent("takeon_lost", def->x, def->y, def->id, p.id);
                p.dribbleType = 0;
                p.vx = p.vy = 0;
                return;
            }
          }   // if (committed) — a doomed touchline geometry falls through to jockey
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
    // COMMIT 4a: inside the post-beat exploit window, force DRIBBLE_FAST and keep
    // driving at goal — don't let the beaten man (now nearest, killing the burst
    // gates) collapse the carry to DRIBBLE_MEDIUM while he recovers at sprint pace.
    if (engine.duel[p.id].beatWindowUntilMs > engine.state.clockMs) {
        dribbleType = 3;
        p.targetX = clamp(p.x + fd * 130.0, 30.0, PITCH_W - 30.0);
        p.targetY = clamp(p.y + (PITCH_H / 2.0 - p.y) * 0.25, 30.0, PITCH_H - 30.0);
    }

    // COMMIT 2c (Round-23): the opener off a kickoff is a CONTROLLED carry, never
    // a blind ~300px/s knock-ahead into the man in front (the "kickoff mugging" —
    // a 1.5-3s statue freeze then a knock straight to the defender 45px away). For
    // the first ~1.5s after the whistle, downgrade a burst to a controlled dribble
    // so the first touch settles the ball. Time-gated, so it is inert once open
    // play is under way (and a normal 11v11 opener rarely bursts in that window).
    // Arena-gated: making this universal changes 11v11 openers (a receiver
    // occasionally bursts inside the window), and 11v11 kickoffs must stay
    // byte-identical. In the arena the taker/receiver settling the ball is the
    // whole point (2v2/3v3 receivers, and a belt-and-braces guard for the 1v1
    // GK-backpass path).
    if (engine.arenaMode && dribbleType == 3
        && engine.state.clockMs >= engine.phase.lastKickoffMs
        && engine.state.clockMs - engine.phase.lastKickoffMs < POST_KICKOFF_CARRY_MS)
        dribbleType = nearbyOpps >= 1 ? 1 : 2;

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
        // Must have a valid completion estimate. (The old `|| !a.audit.forwardProgress`
        // guard also excluded every SQUARE/backward recycle — fwd ~ 0 — i.e. the
        // classic safer option; drop it so those count.)
        if (!a.audit.expectedCompletion) continue;
        // Round-27 COMMIT 9b (observability, trace-only): the "an obviously safer
        // option existed" test was populated on ~1 of 38 intercepts because it
        // required the safer ball to score within 0.04 of the chosen one — but
        // recklessness is exactly picking a lower-scored RISKY ball over a much
        // safer alternative. Anchor on a clearly higher completion (+0.12) and
        // relax the forward-loss and score bands so the field is populated on
        // more decisions and per-role recklessness becomes measurable next round.
        // Pure audit/stat field — no gameplay/RNG effect.
        if (a.audit.expectedCompletion >= chosen.expectedCompletion + 0.12
            && a.audit.forwardProgress >= chosen.forwardProgress - 70.0
            && a.score >= choice.score - 0.18)
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

// ══════════════════════════════════════════════════════════════════════════════
// Narrow views onto engine internals, for the role subclasses
// ══════════════════════════════════════════════════════════════════════════════
// PlayerAI is GameEngine's only friend. Friendship is not inherited, so the six
// role subclasses cannot reach engine internals themselves — these are the three
// things they actually need, and keeping them here is what lets the engine's
// friend list stay at one entry instead of naming all seven agent classes.
//
// Two carry GK vocabulary on a base class every role inherits, which is not
// lovely; the alternative is friending GKPlayerAI on the engine, and one extra
// method on PlayerAI is the cheaper of the two. Callers: directiveBallPlaying
// from CBPlayerAI (role_ai.cpp), the other two from GKPlayerAI (gk_ai.cpp).
bool PlayerAI::directiveBallPlaying() const {
    return engine.directiveBias[player.id].ballPlaying;
}
double PlayerAI::gkDistributeTimer() const {
    return engine.goalKickMonitor.distributeTimer;
}
void PlayerAI::releaseGkDistribution() {
    engine.releaseGoalkeeperDistribution(player);
}
