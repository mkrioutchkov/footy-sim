#include "engine.h"
#include "agent.h"
#include "agent_helpers.h"
#include "setpiece_weights.h"
#include <cmath>
#include <numbers>

// ══════════════════════════════════════════════════════════════
// Set pieces — kickoff tap, release, throw-in, goal kick
// ══════════════════════════════════════════════════════════════
// What is left under that banner is TAKING a restart: the ball is already
// spotted, the taker has walked to it, and this is his foot meeting it —
// kickoffTap, the releaseSetPiece dispatcher, and the two restarts an outfield
// player takes (throw-in, corner). releaseRestartBall at the bottom is the one
// sequence all six release sites share. The banner's other items moved out:
//   goal kick (and GK distribution) → engine_gk_restart.cpp
//   awarding a restart at all       → engine_setpiece_award.cpp
// and offside, which was never a set piece, is now engine_offside.cpp.

void GameEngine::kickoffTap() {
    Player* holder = playerById(state.ball.controllerId);
    if (!holder) return;
    double fd = fdFor(holder->team);
    // Pick the SAFEST outlet, not a random CM fired into the congested centre
    // circle: a clear lane (no opponent to cut it out) + an open receiver,
    // preferring a short ball backward/sideways into space. A kickoff should
    // retain possession — the old random-CM ball was intercepted ~90% of the
    // time and looked awful. (Deterministic: the rng draw it replaced is gone.)
    Player* best = nullptr;
    double bestScore = -1e9;
    for (auto& t : state.players) {
        if (t.team != holder->team || t.id == holder->id || t.role == Role::GK || t.sentOff) continue;
        double dx = t.x - holder->x, dy = t.y - holder->y, d = std::hypot(dx, dy);
        if (d < 28.0 || d > 320.0) continue;
        double ls = dx * dx + dy * dy;
        if (ls < 1.0) continue;
        double nearOpp = 1e9;
        bool laneBlocked = false;
        for (auto& o : state.players) {
            if (!isActiveOpponent(o, holder->team)) continue;
            nearOpp = std::min(nearOpp, dist(o.x, o.y, t.x, t.y));
            double tt = clamp(((o.x - holder->x) * dx + (o.y - holder->y) * dy) / ls, 0.0, 1.0);
            double perp = std::hypot(o.x - holder->x - tt * dx, o.y - holder->y - tt * dy);
            if (perp < 34.0 && tt > 0.05) laneBlocked = true;
        }
        if (laneBlocked || nearOpp < 40.0) continue; // never thread it past a marker / to a marked man
        double backward = (holder->x - t.x) * fd;    // + = toward own goal (the safe ball)
        double score = nearOpp + std::max(0.0, backward) * 0.5 - d * 0.25;
        if (score > bestScore) {
            bestScore = score;
            best = &t;
        }
    }
    if (!best)
        for (auto& p : state.players)
            // Round-21 (arena audit): the CM fallback ignored sentOff, so in arena
            // (every CM ejected, parked at y=-40) every kickoff tapped to a ghost
            // and sailed to the top touchline to die (5.5-7.1s chase). Skip ejected
            // men; with no CM left, best stays null and the taker keeps the ball
            // and dribbles (the existing return). Inert in 11v11 (a CM is present).
            if (p.team == holder->team && p.id != holder->id && p.role == Role::CM && !p.sentOff) {
                best = &p;
                break;
            }
    if (!best && arenaMode)
        // Round-23 (arena reaudit): a 1v1 kickoff has NO outfield outlet (the CMs
        // are ejected), so the taker kept the ball and immediately knocked it into
        // the lone defender 45px away — possession lost ~every kickoff. Fall back
        // to the OWN GK, the textbook 1v1 backpass, to keep the ball. Arena-gated:
        // 11v11 always finds a receiver (or a CM) first, so this never fires there.
        for (auto& p : state.players)
            if (p.team == holder->team && p.id != holder->id && p.role == Role::GK && !p.sentOff) {
                best = &p;
                break;
            }
    if (!best) return;
    Player& target = *best;
    double dx = target.x - holder->x, dy = target.y - holder->y, rawDist = std::hypot(dx, dy);
    if (rawDist < 1) return;
    double speed = clamp(140.0 + rawDist * 0.35, 150.0, 235.0); // firm, flat, controllable
    auto& b = state.ball;
    b.controllerId = -1;
    placeBallForRelease(*holder, dx, dy);
    b.lastTouchTeam = holder->team;
    b.lastToucherId = holder->id;
    driveBall(b, dx, dy, rawDist, speed);
    b.intendedReceiverId = target.id;
    receiverShieldTargetId = target.id;
    blockReboundFor(holder->id, 650);
    b.z = 0;
    b.vz = 0;
    beginTrackedPass(*holder, target);
}

void GameEngine::releaseSetPiece() {
    // Clear throw-in support coordination
    for (auto& bb : blackboards) bb.throwInSupport = {};
    Player* holder = playerById(state.ball.controllerId);
    if (!holder) return;
    auto clearReleasedSetPiece = [&]() {
        // Goal-source tagging (owner audit: "all goals set pieces?"): remember
        // what restart just released and when — creditGoal buckets any goal
        // scored within 9s as a set-piece goal of that type.
        lastRestartReleaseMs = state.clockMs;
        lastRestartReleaseType = setPiece.type;
        // Law 13-17 double-touch: whoever just took the restart cannot touch
        // again until another player does (previously a pure 600-900ms timer,
        // after which the taker could legally re-collect his own throw/corner).
        restartRetouchBlockedId = setPiece.takerId;
        if (!setPiece.armed) {
            setPiece.type = SetPiece::None;
            setPiece.team = Team::Home;
            setPiece.reason.clear();
        }
    };
    // Clear setPieceHold for all agents
    for (auto& a : agents) a->setPieceHold = false;
    if (setPiece.type == SetPiece::Corner) {
        releaseCornerKick(*holder);
        clearReleasedSetPiece();
        return;
    }
    if (setPiece.type == SetPiece::ThrowIn) {
        releaseThrowIn(*holder);
        clearReleasedSetPiece();
        return;
    }
    if (setPiece.type == SetPiece::GoalKick) {
        releaseGoalKick(*holder);
        clearReleasedSetPiece();
        return;
    }
    if (setPiece.type == SetPiece::Penalty) {
        // Final referee correction at the strike: the per-tick enforcer nudges
        // stragglers out radially, but an agent whose defensive-shape target
        // sits ON the arc boundary can tug-of-war to an equilibrium a few px
        // inside (seed 126: a CB parked at 86px vs the 88px arc check). It's a
        // dead ball — step anyone still inside cleanly out before the audit,
        // exactly like a referee waving a player back before the whistle.
        for (auto& p : state.players) {
            if (p.id == holder->id || p.role == Role::GK || p.sentOff) continue;
            // Box intruder: step him behind the area's edge, toward midfield.
            double penGoalX = goalXFor(setPiece.team);
            bool corrInBox = std::abs(p.y - PITCH_H / 2.0) < PENALTY_AREA_H / 2.0
                          && std::abs(p.x - penGoalX) < PENALTY_AREA_W;
            if (corrInBox) {
                double outDir = penGoalX == 0.0 ? 1.0 : -1.0;   // away from that goal
                p.x = clamp(penGoalX + outDir * (PENALTY_AREA_W + 6.0), 8.0, PITCH_W - 8.0);
            }
            // Arc intruder: step him radially past the D.
            double adx = p.x - setPiece.spotX, ady = p.y - setPiece.spotY;
            double ad = std::hypot(adx, ady);
            if (ad < 92.0) {
                if (ad < 1.0) { adx = -fdFor(setPiece.team); ady = 0.2; ad = std::hypot(adx, ady); }
                p.x = clamp(setPiece.spotX + adx / ad * 96.0, 8.0, PITCH_W - 8.0);
                p.y = clamp(setPiece.spotY + ady / ad * 96.0, 8.0, PITCH_H - 8.0);
            }
        }
        // Law 14 audit at the actual strike: anyone but the taker and the
        // keepers inside the area or the arc is a violation (scenario-guarded
        // to 0 — this is how the ten-men-in-the-box replay bug stays dead).
        for (auto& p : state.players) {
            if (p.id == holder->id || p.role == Role::GK || p.sentOff) continue;
            bool inBox = std::abs(p.y - PITCH_H / 2.0) < PENALTY_AREA_H / 2.0
                      && std::abs(p.x - goalXFor(setPiece.team)) < PENALTY_AREA_W;
            bool inArc = dist(p.x, p.y, setPiece.spotX, setPiece.spotY) < 88.0;
            if (inBox || inArc) {
                if (std::getenv("LAW_DEBUG"))
                    fprintf(stderr, "[law14] t=%.2f pid=%d at(%.0f,%.0f) inBox=%d inArc=%d spot=(%.0f,%.0f)\n",
                            state.clockMs/1000.0, p.id, p.x, p.y, inBox, inArc, setPiece.spotX, setPiece.spotY);
                stats.recordRestartLawViolation();
            }
        }
        stats.recordPenaltyTaken();
        shot.penalty = true;
        shootBall(*holder, nullptr);
        clearReleasedSetPiece();
        return;
    }
    if (holder->role == Role::GK) {
        releaseGoalkeeperDistribution(*holder);
        clearReleasedSetPiece();
        return;
    }
    if (setPiece.type == SetPiece::FreeKick) {
        double gx = goalXFor(holder->team);
        double gy = PITCH_H / 2.0;
        double shotDist = std::hypot(gx - holder->x, gy - holder->y);
        double angleDeg = goalOpeningAngleDeg(holder->x, holder->y, gx);
        int laneBlockers = countLaneBlockers(state.players, holder->x, holder->y, gx, gy, holder->team, BLOCKER_PERP_FREEKICK, 0.06, 0.90);
        bool central = std::abs(holder->y - gy) < 170.0;
        // A defensive wall is normal for a direct free kick — don't veto on it.
        // §FK: a defensive WALL is EXPECTED on a central direct free kick — it must NOT veto the
        // shot (that left FKs "too few"). The curl-around-the-wall shot (shootBall) beats it, so only
        // EXCESS blockers beyond the ~3-man wall suppress; base chance raised so 10-28m central FKs fire.
        bool credibleShot = shotDist > 105.0 && shotDist < 300.0 && central && angleDeg > 5.5;
        double shotChance = clamp(0.40 + (300.0 - shotDist) / 300.0 + angleDeg / 95.0 - std::max(0.0, laneBlockers - 3.0) * 0.12, 0.22, 0.72);
        if (credibleShot && rng.random() < shotChance) {
            shootBall(*holder, nullptr);
            clearReleasedSetPiece();
            return;
        }
    }
    // §FK Commit 3: a WIDE/DEEP direct FK that wasn't shot is a CROSS, not a CM/FB reset — whip it
    // to the TALLEST attacker in the box for a header. Mirrors the corner cross (~570 this file):
    // applyWhipDelivery + beginTrackedPass(isCross=true) arms the freshCross header (the isCross flag
    // is load-bearing; leave lastLooseOrigin alone). Target = max attrs.height in the box (deterministic
    // argmax, no rng in the choice). Likely the CF — a tall CB isn't in the box (positioning stays back).
    if (setPiece.type == SetPiece::FreeKick) {
        double gx2 = goalXFor(holder->team), gy2 = PITCH_H / 2.0;
        double fkDist = std::hypot(gx2 - holder->x, gy2 - holder->y);
        // 120 -> 85 (seed 111 1:54: a 94px-off-center FK became a lone-CF
        // direct shot with ONE red in the box — a wide-central spot is a
        // whipped delivery into a populated box, not a solo pot-shot).
        bool wideFK = std::abs(holder->y - gy2) > 85.0;
        if (wideFK && fkDist > 250.0 && fkDist < 560.0) {
            Player* tgt = nullptr;
            double best = -1e9;
            for (auto& p : state.players) {
                if (p.team != holder->team || p.id == holder->id || p.role == Role::GK || p.sentOff) continue;
                if (std::abs(p.x - gx2) > 180.0 || std::abs(p.y - gy2) > 200.0) continue; // in the box
                double sc = p.attrs.height + (180.0 - std::abs(p.y - gy2)) * 0.02;        // tallest, central tiebreak
                if (sc > best) {
                    best = sc;
                    tgt = &p;
                }
            }
            if (tgt) {
                double tx = gx2 + (holder->team == Team::Home ? -1.0 : 1.0) * 85.0;
                double ty = lerp(tgt->y, gy2, 0.55);
                double dx = tx - holder->x, dy = ty - holder->y, d = std::hypot(dx, dy);
                if (d > 1.0) {
                    double speed = clamp(240.0 + d * 0.24, 260.0, 300.0);   // FK cross at real driven pace (94-108 km/h)
                    auto& b = state.ball;
                    b.controllerId = -1;
                    placeBallForRelease(*holder, dx, dy);
                    blockReboundFor(holder->id, 900);
                    b.lastTouchTeam = holder->team;
                    b.lastToucherId = holder->id;
                    driveBall(b, dx, dy, d, speed);
                    b.z = 0;
                    applyWhipDelivery(d, speed, gx2, CROSS_CURL_MIN, CROSS_CURL_RANGE, holder);
                    b.intendedReceiverId = tgt->id;
                    receiverShieldTargetId = tgt->id;
                    stats.recordCrossAttempt(holder->team == Team::Home);
                    beginTrackedPass(*holder, *tgt, true);
                    clearReleasedSetPiece();
                    return;
                }
            }
        }
    }
    SmallVector<Player*, 11> targets;
    for (auto& p : state.players) {
        // Round-21 (arena audit): never build a FK/restart pass to a sent-off
        // ghost (parked at y=-40). With no legal target the list is empty, the
        // pass loop is skipped, and the existing clearReleasedSetPiece fallthrough
        // disarms and lets the taker play on. Inert in 11v11.
        if (p.team != holder->team || p.id == holder->id || p.role == Role::GK || p.sentOff) continue;
        if (setPiece.type == SetPiece::FreeKick && dist(holder->x, holder->y, p.x, p.y) < 55.0) continue;
        targets.push_back(&p);
    }
    std::sort(targets.begin(), targets.end(), [&](const Player* a, const Player* b) {
        auto scoreTarget = [&](const Player* p) {
            double fd = fdFor(holder->team);
            double d = dist(holder->x, holder->y, p->x, p->y);
            double progress = (p->x - holder->x) * fd;
            double width = std::abs(p->y - PITCH_H / 2.0);
            double closestOpp = 1e9;
            for (auto& o : state.players) {
                if (o.team == holder->team || o.role == Role::GK) continue;
                closestOpp = std::min(closestOpp, dist(o.x, o.y, p->x, p->y));
            }
            int laneBlockers = countLaneBlockers(state.players, holder->x, holder->y, p->x, p->y, holder->team, PASS_BLOCKER_PERP_OUTLET, 0.12, 0.92);
            if (setPiece.type == SetPiece::FreeKick) {
                double holderShotDist = pitch::distToGoalMouth(holder->x, holder->y, holder->team);
                double distanceFit = 1.0 - std::abs(d - 145.0) / 210.0;
                double pressureScore = clamp((closestOpp - 35.0) / 95.0, -0.60, 0.75);
                double resetBonus = progress < -25.0 ? 0.55 : std::abs(progress) < 45.0 ? 0.30
                                                                                        : -0.18;
                // In shooting range, recycling backward wastes the set piece.
                if (holderShotDist < 320.0 && resetBonus > 0.0) resetBonus *= 0.25;
                double roleBonus = sp::weight(sp::FK_RECYCLE, p->role);
                double centerSupport = 1.0 - std::abs(p->y - PITCH_H / 2.0) / PITCH_H;
                return distanceFit + pressureScore + resetBonus + roleBonus + centerSupport * 0.22 - laneBlockers * 0.70;
            }
            double distanceFit = 1.0 - std::abs(d - 210.0) / 260.0;
            double roleBonus = sp::weight(sp::FK_FORWARD, p->role);
            return distanceFit + clamp(progress / 260.0, -0.25, 0.42) + width / 520.0 + roleBonus - laneBlockers * 0.30;
        };
        return scoreTarget(a) > scoreTarget(b);
    });
    for (Player* target : targets) {
        if (passBallTo(*holder, *target, false, false, nullptr)) {
            clearReleasedSetPiece();
            return;
        }
    }
    // No pass target worked (every lane blocked). The old fallback re-armed
    // (armed=true, timer=250) into a taker-less held-ball state the malformed-arm
    // watchdog can't see (it needs controllerId<0) — the taker kept the ball and it
    // stalled ~2.7s until auditStuckCarrier force-passed it. Instead just clear the
    // set-piece and let the taker (still holding the ball) play on as a normal
    // carrier next tick — no stall.
    clearReleasedSetPiece();
}

void GameEngine::releaseThrowIn(Player& holder) {
    SmallVector<RatedTarget, 11> targets;
    double fd = fdFor(holder.team);
    // USERWATCH C: a designated LONG-THROW taker in the attacking half hurls it INTO the box
    // (a flat, fast aerial delivery like a corner) instead of a short throw — the big-throw weapon.
    // Opt-in via the long_throw_taker directive => default teams (no taker) keep short throws => golden unchanged.
    bool attackingHalf = (fd > 0.0) ? holder.x > PITCH_W * 0.5 : holder.x < PITCH_W * 0.5;
    if (attackingHalf && holder.id == designatedTakerFor(SetPiece::ThrowIn, holder.team)) {
        double oppGoalX = goalXFor(holder.team);
        double targetX = oppGoalX - fd * 95.0;                                      // ~the 6-yard area
        double targetY = PITCH_H / 2.0 + (holder.y < PITCH_H / 2.0 ? -55.0 : 55.0); // near post, throw side
        double dx = targetX - holder.x, dy = targetY - holder.y, d = std::max(1.0, std::hypot(dx, dy));
        auto& b = state.ball;
        double speed = clamp(160.0 + d * 0.15, 160.0, 290.0); // a powerful long throw
        releaseRestartBall(holder, dx, dy, d, speed, speed * 0.9);   // flat-fast aerial into the box
        b.intendedReceiverId = -1;
        receiverShieldTargetId = -1;
        pendingPass.active = false;
        return;
    }
    for (auto& p : state.players) {
        if (p.team != holder.team || p.id == holder.id || p.role == Role::GK || p.sentOff) continue;
        double d = dist(holder.x, holder.y, p.x, p.y);
        if (d < THROW_IN_MIN_TARGET || d > 400.0) continue;   // Round-51: was 30px — throws were 2-3m hand-offs, never lost
        double nearestOpp = 1e9;
        for (auto& o : state.players) {
            if (!isActiveOpponent(o, holder.team)) continue;
            nearestOpp = std::min(nearestOpp, dist(o.x, o.y, p.x, p.y));
        }
        int laneBlockers = countLaneBlockers(state.players, holder.x, holder.y, p.x, p.y, holder.team, BLOCKER_PERP_THROWIN, 0.12, 0.92);
        double progress = (p.x - holder.x) * fd;
        double score = 1.0 - d / 420.0 + clamp(progress / 180.0, -0.15, 0.20);
        score -= laneBlockers * 0.32 + clamp((70.0 - nearestOpp) / 70.0, 0.0, 1.0) * 0.35;
        targets.push_back({&p, score});
    }
    std::sort(targets.begin(), targets.end(), [](const RatedTarget& a, const RatedTarget& b) { return a.score > b.score; });
    for (auto& target : targets) {
        if (target.score < 0.05) continue;
        Player& t = *target.player;
        double dx = t.x - holder.x, dy = t.y - holder.y, d = std::hypot(dx, dy);
        if (d < 30.0) continue;
        double speed = 120.0 + d * 0.15;
        auto& b = state.ball;
        releaseRestartBall(holder, dx, dy, d, speed, speed * 1.4);
        b.intendedReceiverId = t.id;
        receiverShieldTargetId = t.id;
        beginTrackedPass(holder, t, false);
        return;
    }
    // Round-21 (arena audit): with ZERO scored outfield candidates (arena: every
    // outfield team-mate is ejected) the old blind up-the-line hoof gifted the
    // opponent. Throw to our own keeper if he's within range — a legal, safe
    // outlet; only if he isn't do we throw the fallback AWAY from the nearest
    // opponent. Reached ONLY when targets is empty, which never happens in 11v11
    // (nine outfield team-mates always populate the list), so the golden path
    // below is byte-identical.
    if (targets.empty()) {
        // Prefer a legal throw to our own keeper.
        if (Player* gk = findGK(holder.team); gk && !gk->sentOff) {
            double dx = gk->x - holder.x, dy = gk->y - holder.y, d = std::hypot(dx, dy);
            if (d >= 30.0 && d <= 400.0) {
                double speed = 120.0 + d * 0.15;
                auto& b = state.ball;
                releaseRestartBall(holder, dx, dy, d, speed, speed * 1.4);
                b.intendedReceiverId = gk->id;
                receiverShieldTargetId = gk->id;
                beginTrackedPass(holder, *gk, false);
                return;
            }
        }
        // No keeper outlet: throw the untargeted ball AWAY from the nearest
        // opponent (flip the up-line forward component if he sits ahead) rather
        // than blindly handing it to him.
        auto& b = state.ball;
        double side = holder.y < PITCH_H / 2.0 ? 1.0 : -1.0;
        double throwFd = fd, bd = 1e9, onx = holder.x;
        for (auto& o : state.players) {
            if (!isActiveOpponent(o, holder.team)) continue;
            double d2 = dist(o.x, o.y, holder.x, holder.y);
            if (d2 < bd) { bd = d2; onx = o.x; }
        }
        if (bd < 1e8 && (onx - holder.x) * fd > 0.0) throwFd = -fd;
        double dx = throwFd * 80.0, dy = side * 130.0, d = std::hypot(dx, dy);
        double speed = 155.0;
        releaseRestartBall(holder, dx, dy, d, speed, speed * 0.95);
        b.intendedReceiverId = -1;
        receiverShieldTargetId = -1;
        pendingPass.active = false;
        return;
    }
    auto& b = state.ball;
    double side = holder.y < PITCH_H / 2.0 ? 1.0 : -1.0;
    double dx = fd * 80.0, dy = side * 130.0, d = std::hypot(dx, dy);
    double speed = 155.0;
    releaseRestartBall(holder, dx, dy, d, speed, speed * 0.95);
    b.intendedReceiverId = -1;
    receiverShieldTargetId = -1;
    pendingPass.active = false;
}

void GameEngine::releaseCornerKick(Player& holder) {
    double goalX = holder.x < HALF_X ? HOME_GOAL_X : AWAY_GOAL_X;
    // ── SHORT CORNER (owner, seed-111 replay @1:47: "5 is completely free [near the
    // corner]... i think more likely a short corner would be taken here") ──
    // The old version fired ~18% UNCONDITIONALLY and picked the nearest teammate to
    // the TAKER with NO openness check — so it worked short into a marked man just as
    // readily as into acres, and did it on a quarter of all corners (probe: 24.3%).
    // Re-gated on the picture the owner actually described: play it short ONLY when a
    // teammate is GENUINELY FREE by the flag — inside SHORT_CORNER_NEAR_R of the
    // corner SPOT (not the taker), outside SHORT_CORNER_MIN_R (not standing on him),
    // and with his nearest defender beyond SHORT_CORNER_FREE_D (unmarked, the "5 is
    // completely free" frame). If the defence has posted a short-lane cover man
    // (setPiecePositioning defending-corner branch, agent_setpiece.cpp) the receiver
    // is inside SHORT_CORNER_FREE_D of that cover and this gate FAILS — so a covered
    // corner is whipped, exactly as the owner wants. The rng draw is the SAME single
    // per-corner draw the old branch already spent (no new call site); it only trims
    // the free-man corners down to a minority so the whip stays the norm. On release
    // the receiver is on the byline and the normal open-play AI takes over; the
    // corner is offside-EXEMPT here (setPiece.type is still Corner at beginTrackedPass
    // — a corner can't be offside directly), and clearReleasedSetPiece's
    // restartRetouchBlockedId = taker still fires after we return, so the taker's
    // double-touch law holds until the short receiver plays it.
    // Round-30: hoist the single per-corner rng draw out of the short-corner
    // short-circuit so it is spent exactly once per corner, whether or not a free
    // short option exists — the whipped branch below then reuses it for delivery
    // dispersion instead of opening a second call site.
    const double cornerRoll = rng.random();
    {
        double cx = setPiece.spotX, cy = setPiece.spotY;
        Player* shortOpt = nullptr;
        double bestFree = -1e9;
        for (auto& p : state.players) {
            if (p.team != holder.team || p.id == holder.id || p.role == Role::GK || p.sentOff) continue;
            double dCorner = dist(p.x, p.y, cx, cy);
            if (dCorner < SHORT_CORNER_MIN_R || dCorner > SHORT_CORNER_NEAR_R) continue;
            double nearestDef = 1e9;
            for (auto& o : state.players) {
                if (!isActiveOpponent(o, holder.team)) continue;
                nearestDef = std::min(nearestDef, dist(o.x, o.y, p.x, p.y));
            }
            if (nearestDef < SHORT_CORNER_FREE_D) continue;   // marked — not a free short option
            double score = nearestDef - dCorner * 0.15;       // freest man; tiebreak nearest the flag
            if (score > bestFree) { bestFree = score; shortOpt = &p; }
        }
        if (shortOpt && cornerRoll < SHORT_CORNER_PROB) {
            double dx = shortOpt->x - holder.x, dy = shortOpt->y - holder.y, d = std::max(1.0, std::hypot(dx, dy));
            auto& b = state.ball;
            double speed = clamp(150.0 + d * 0.35, 150.0, 250.0);
            releaseRestartBall(holder, dx, dy, d, speed, 0.0);   // rolled short, stays down
            b.intendedReceiverId = shortOpt->id;
            receiverShieldTargetId = shortOpt->id;
            emitEvent("corner_short", holder.x, holder.y, holder.id);
            beginTrackedPass(holder, *shortOpt, false);
            return;
        }
    }
    SmallVector<RatedTarget, 11> targets;
    for (auto& p : state.players) {
        if (p.team != holder.team || p.id == holder.id || p.role == Role::GK || p.sentOff) continue;
        double goalDist = std::abs(p.x - goalX);
        double central = std::abs(p.y - PITCH_H / 2.0);
        double roleBonus = sp::weight(sp::CORNER_TARGET, p.role);
        double score = (260.0 - goalDist) / 260.0 * 0.45 + (180.0 - central) / 180.0 * 0.35 + roleBonus;
        targets.push_back({&p, score});
    }
    std::sort(targets.begin(), targets.end(), [](const RatedTarget& a, const RatedTarget& b) { return a.score > b.score; });
    if (!targets.empty()) {
        // Round-30: aim by OCCUPANCY, not at a constant. Every corner used to be
        // whipped at goalX +/- 85 with ty pulled 55% toward the centre line, which
        // lands 1.1 m from where the zonal shape anchors a centre-back
        // (ownGoalX + fd*68, PITCH_H/2 +/- 54): 32 of 63 airborne deliveries fell
        // within 1.2 m of one of exactly two mirror points, the nearest defender at
        // the release frame was a CB in 54 of 73 corners at a median 22.6px, and
        // the result was 0 goals from 371 corners. Score a handful of candidate
        // landing spots by how clear they are (nearest defender, minus half the
        // distance to the nearest team-mate so the ball still goes where someone
        // can attack it) and take the best. The back post at |y-340| ~ 100-130 is
        // the genuinely free zone: outside GK_CLAIM_HALF_W, with a full-back post
        // guard ~48px away instead of a centre-back at 11.
        const double fdc = fdFor(holder.team);
        // Deeper for the back post; the shallowest candidate still clears
        // GK_CLAIM_DEPTH (78) with margin — see the hard clamp below.
        static const double CAND_LAT[5]   = {  20.0,  47.0,  75.0, 102.0, 130.0 };
        static const double CAND_DEPTH[5] = {  92.0,  98.0, 105.0, 112.0, 120.0 };
        double bestAim = -1e9, tx = goalX - fdc * 92.0, ty = PITCH_H / 2.0;
        for (int side = -1; side <= 1; side += 2) {
            for (int k = 0; k < 5; ++k) {
                double candX = goalX - fdc * CAND_DEPTH[k];
                double candY = PITCH_H / 2.0 + side * CAND_LAT[k];
                double nearestDef = 1e9, nearestAtt = 1e9;
                for (auto& o : state.players) {
                    if (o.sentOff) continue;
                    double dd = dist(o.x, o.y, candX, candY);
                    if (o.team != holder.team) nearestDef = std::min(nearestDef, dd);
                    else if (o.id != holder.id && o.role != Role::GK) nearestAtt = std::min(nearestAtt, dd);
                }
                // Round-51 (seed-1110 audit: no attacker ever contested a corner in
                // the air): weighting the nearest attacker at half the nearest
                // defender sent the ball to the EMPTIEST spot, i.e. where nobody
                // was. Weight the man who can attack it more than the space.
                double sc = nearestDef - CORNER_AIM_ATTACKER_W * nearestAtt;
                if (sc > bestAim) { bestAim = sc; tx = candX; ty = candY; }
            }
        }
        // Dispersion off the SAME single draw the branch already spends, remapped
        // twice so the two axes decorrelate: no two corners land on one pixel and
        // no new rng call site opens.
        double du = std::fmod(cornerRoll * 9.7 + 0.137, 1.0);
        double dv = std::fmod(cornerRoll * 23.3 + 0.611, 1.0);
        tx += (du * 2.0 - 1.0) * 15.0;
        ty += (dv * 2.0 - 1.0) * 20.0;
        // HARD CONSTRAINT: the delivery never enters the keeper's claim envelope
        // (constants.h GK_CLAIM_DEPTH = 78). This is what keeps the commit
        // compatible with the deferred GK cross-claim work — relax it and the
        // keeper takes roughly half the deliveries at header height, and corners
        // get MORE sterile than they were.
        tx = goalX - fdc * clamp(std::abs(tx - goalX), 92.0, 145.0);
        ty = clamp(ty, 40.0, PITCH_H - 40.0);
        // Address it to whoever can actually attack that spot, so the run and the
        // ball agree (the fixed-point version addressed the highest-rated target
        // and then whipped it somewhere else).
        Player* aimed = targets.front().player;
        double bestReach = 1e9;
        for (auto& rt : targets) {
            double dd = dist(rt.player->x, rt.player->y, tx, ty);
            if (dd < bestReach) { bestReach = dd; aimed = rt.player; }
        }
        Player& target = *aimed;
        double dx = tx - holder.x, dy = ty - holder.y, d = std::hypot(dx, dy);
        if (d > 1.0) {
            // Driven corner delivery — same whip treatment as open-play crosses,
            // capped at the hardest-shot ceiling (~38 m/s); was launching to 52.
            double speed = clamp(240.0 + d * 0.24, 265.0, 300.0);   // corner delivery at real driven pace
            auto& b = state.ball;
            b.controllerId = -1;
            placeBallForRelease(holder, dx, dy);
            blockReboundFor(holder.id, 900);
            b.lastTouchTeam = holder.team;
            b.lastToucherId = holder.id;
            driveBall(b, dx, dy, d, speed);
            b.z = 0;
            applyWhipDelivery(d, speed, goalX, 0.18, 0.15, &holder);
            b.intendedReceiverId = target.id;
            receiverShieldTargetId = target.id;
            beginTrackedPass(holder, target, true);
            return;
        }
    }
    // Round-21 (arena audit): the empty-targets fallback used to re-arm
    // (armed=true, timer=450) into a taker-less held-ball state that NO branch of
    // updateSetPiecePhase can service — the watchdog needs controllerId<0, the
    // taker-walk needs takerId>=0, the release needs takerArrived, and
    // auditStuckCarrier is disabled while armed. The taker (still holding the
    // ball) statued until the half whistle. In arena the corner target loop above
    // always skips every sent-off ghost, so it is ALWAYS empty and every corner
    // froze (up to 51% of the match). This is the SAME defect the free-kick path
    // already retired (tombstone at ~line 255, in releaseSetPiece). Fix: DON'T re-arm — fall through.
    // clearReleasedSetPiece() runs the moment releaseCornerKick returns
    // (releaseSetPiece), armed goes false, and the holder plays on as a normal
    // carrier next tick. 11v11 is unaffected: its target list is never empty.
}

// ══════════════════════════════════════════════════════════════════════════════
// releaseRestartBall() — the one way a dead ball leaves the taker's foot
// ══════════════════════════════════════════════════════════════════════════════
// Six restart releases (long throw, throw-in to a target, the two throw fallbacks,
// the goal-kick fallback, the short corner) each wrote this identical eight-line
// sequence out longhand: drop control, step the ball to the release point, arm the
// Law 13-17 double-touch block, stamp attribution, then drive it. Any restart that
// forgot one line — the rebound block especially — would be a referee bug nobody
// would spot by reading one site. One copy now.
void GameEngine::releaseRestartBall(Player& holder, double dx, double dy, double d,
                                    double speed, double lift, double reboundBlockMs) {
    auto& b = state.ball;
    b.controllerId = -1;
    placeBallForRelease(holder, dx, dy);
    blockReboundFor(holder.id, reboundBlockMs);
    b.lastTouchTeam = holder.team;
    b.lastToucherId = holder.id;
    driveBall(b, dx, dy, d, speed);
    b.vz = lift;
    b.z = 0;
}
