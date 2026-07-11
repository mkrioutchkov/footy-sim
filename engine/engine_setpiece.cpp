#include "engine.h"
#include "agent.h"
#include "agent_helpers.h"
#include "setpiece_weights.h"
#include <cmath>
#include <numbers>

// ══════════════════════════════════════════════════════════════
// Offside helpers
// ══════════════════════════════════════════════════════════════

// Offside line: the second-last opponent INCLUDING the goalkeeper (the law).
// With the keeper home this is the deepest outfield defender; excluding the GK
// here made the line one defender too tight and ruled out legal deep runs.
double GameEngine::offsideLineFor(Team t) const {
    const double fd = fdFor(t);
    const Player *d1 = nullptr, *d2 = nullptr;
    double v1 = -1e9, v2 = -1e9;
    for (auto& p : state.players) {
        if (p.team == t || p.sentOff) continue; // a parked sent-off defender must not set the offside line
        double v = p.x * fd;
        if (v > v1) {
            v2 = v1;
            d2 = d1;
            v1 = v;
            d1 = &p;
        } else if (v > v2) {
            v2 = v;
            d2 = &p;
        }
    }
    if (d2) return d2->x;
    return d1 ? d1->x : (t == Team::Home ? 0.0 : PITCH_W);
}

// Opponent midfield line: the average x of the opponent's central midfielders (the top of the pocket
// for drift_into_pocket). Mirrors offsideLineFor's skip-t (we read the OPPONENT's CMs, not our own).
double GameEngine::midlineFor(Team t) const {
    double sum = 0.0;
    int n = 0;
    for (auto& p : state.players) {
        if (p.team == t || p.sentOff || p.role != Role::CM) continue;
        sum += p.x;
        n++;
    }
    return n > 0 ? sum / n : HALF_X; // fallback: opp has no central midfielders
}

bool GameEngine::checkOffside(const Player& receiver, const Player& passer) const {
    const double fd = fdFor(passer.team);
    if (fd == 1) {
        if (receiver.x <= HALF_X || receiver.x <= passer.x + OFFSIDE_TOLERANCE) return false;
    } else {
        if (receiver.x >= HALF_X || receiver.x >= passer.x - OFFSIDE_TOLERANCE) return false;
    }
    const double line = offsideLineFor(passer.team);
    return fd == 1 ? receiver.x > line + OFFSIDE_TOLERANCE : receiver.x < line - OFFSIDE_TOLERANCE;
}

void GameEngine::awardOffsideFreeKick(Team defTeam, const Player& offsidePlayer) {
    auto& b = state.ball;
    b.x = clamp(offsidePlayer.x, 20.0, PITCH_W - 20);
    b.y = clamp(offsidePlayer.y, 20.0, PITCH_H - 20);
    b.vx = b.vy = b.z = b.vz = 0;
    b.controllerId = -1;
    b.intendedReceiverId = -1;
    receiverShieldTargetId = -1;
    setPiece.type = SetPiece::FreeKick;
    setPiece.team = defTeam;
    setPiece.armed = true;
    setPiece.reason = "offside";
    phase.actionTimer = 5000;
    setPiece.spotX = b.x;
    setPiece.spotY = b.y;
    setPiece.takerArrived = false;
    Player* best = findNearestOutfieldPlayer(defTeam, b.x, b.y);
    setPiece.takerId = best ? best->id : -1;
}

bool GameEngine::isOffsideTarget(const Player& passer, const Player& receiver) const {
    return checkOffside(receiver, passer);
}

// Passers don't carry a linesman's flag: they reject only CLEARLY offside
// targets (a ~6px margin beyond the line). Marginal runs get played — and
// the whistle, judged exactly, sometimes catches them. Without this the AI
// filter was rule-perfect and zero offsides occurred in six hours of play.
bool GameEngine::isOffsideTargetPerceived(const Player& passer, const Player& receiver) const {
    const double fd = fdFor(passer.team);
    if (fd == 1) {
        if (receiver.x <= HALF_X || receiver.x <= passer.x + OFFSIDE_TOLERANCE) return false;
    } else {
        if (receiver.x >= HALF_X || receiver.x >= passer.x - OFFSIDE_TOLERANCE) return false;
    }
    const double line = offsideLineFor(passer.team);
    // The passer judges by eye, not a linesman's flag — he'll thread a ball
    // to a runner up to ~18px beyond the line believing him onside, so a
    // mistimed run (6-18px offside) actually gets flagged. An 11px margin left
    // only a 5px window above the 6px whistle tolerance, so offsides never
    // happened despite attackers logging ~50s/match in offside positions.
    const double margin = 18.0;
    return fd == 1 ? receiver.x > line + margin : receiver.x < line - margin;
}

// ══════════════════════════════════════════════════════════════
// Set pieces — kickoff tap, release, throw-in, goal kick
// ══════════════════════════════════════════════════════════════

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
            if (p.team == holder->team && p.id != holder->id && p.role == Role::CM) {
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
    b.vx = dx / rawDist * speed;
    b.vy = dy / rawDist * speed;
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
        bool wideFK = std::abs(holder->y - gy2) > 120.0;
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
                    b.vx = dx / d * speed;
                    b.vy = dy / d * speed;
                    b.z = 0;
                    applyWhipDelivery(d, speed, gx2, CROSS_CURL_MIN, CROSS_CURL_RANGE);
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
        if (p.team != holder->team || p.id == holder->id || p.role == Role::GK) continue;
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

void GameEngine::releaseGoalKick(Player& holder) {
    if (holder.role != Role::GK) return;
    double fd = fdFor(holder.team);
    double ownGoalX = ownGoalXFor(holder.team);
    // Law 16 audit at release: opponents must be outside the area when a goal
    // kick is played (scenario-guarded to 0).
    for (auto& p : state.players) {
        if (p.team == holder.team || p.sentOff) continue;
        if ((p.x - ownGoalX) * fd < PENALTY_AREA_W
            && std::abs(p.y - PITCH_H / 2.0) < PENALTY_AREA_H / 2.0)
            stats.recordRestartLawViolation();
    }
    // Modern short goal kick: if a defender is open with a clean lane, roll it to
    // him (secure — fast, accurate) instead of hoofing it 50/50. The 2019 rule
    // lets the ball be received inside the area. Falls through to the long kick
    // below when no safe short option exists. A play-it-long team skips this and
    // launches it (distribution tactic).
    double gkLongBias = teamTactics[teamIndex(holder.team)].longBallBias;
    // ── Goal-kick long-distribution mix (SHELVED) ── owner asked for fewer
    // always-short goal kicks (seed 105). Skipping the short-safe roll to launch
    // a target-man ball a fraction of the time WORKS, but it is route-one and
    // the engine's long balls are low-percentage: at a 0.30 mix, A/B over 40
    // seeds @30min cratered goals 1.05 -> 0.65 (-38%) with clearances +4.3 and
    // shots-on-target down — the target man loses the aerial and it's cleared.
    // A meaningful long-mix rate is simply not affordable until a target man can
    // actually WIN and lay off the long ball (hold-up play doesn't exist yet).
    // Left short-safe. GK_LONG_MIX_PROB / GK_LONG_TARGET_MIN_PROG retained for a
    // future revival paired with hold-up mechanics.
    if (!(gkLongBias > 0.0 && rng.random() < gkLongBias)) {
        // Clipped-first mix (seed 111 census: 6/6 goal kicks were <150px rolls
        // to a camped deep man — zero variety, zero progression): a third of
        // the time the keeper LOOKS MID-RANGE FIRST (the clipped ball to the
        // FB/CM seam); if no mid target is safely open, the pass below re-runs
        // with the full range, so the failure mode is unchanged.
        bool preferClipped = rng.random() < 0.33;
        Player* sp = nullptr;
        double bestSafe = -1e9;
        double shortMinD = preferClipped ? 165.0 : 42.0;
        for (int attempt = 0; attempt < (preferClipped ? 2 : 1) && !sp; attempt++, shortMinD = 42.0) {
        for (auto& p : state.players) {
            if (p.team != holder.team || p.id == holder.id || p.role == Role::GK || p.sentOff) continue;
            double d = dist(holder.x, holder.y, p.x, p.y);
            // GK DISTRIBUTION POLISH (user "better distribution"): the 60px floor made the keeper
            // SKIP a close, open defender right next to him and hoof it 50/50 instead — dumb. Allow
            // the simple short roll to a close open man (down to 42px) + a touch longer (320). The
            // openness (nearestOpp>42) + clean-lane gates below are UNCHANGED, so it only plays out
            // to a SAFE option — no added risk, just fewer needless punts.
            if (d < shortMinD || d > 320.0) continue;
            // Press-aware openness (same as releaseGoalkeeperDistribution): the
            // receiver must still be open when the ball ARRIVES, not just now —
            // opponents are projected along their velocity over the flight.
            double eta = d / 300.0 + 1.0;
            double nearestOpp = 1e9;
            for (auto& o : state.players) {
                if (!isActiveOpponent(o, holder.team)) continue;
                double now = dist(o.x, o.y, p.x, p.y);
                double soon = dist(o.x + o.vx * eta * 0.85, o.y + o.vy * eta * 0.85, p.x, p.y);
                nearestOpp = std::min(nearestOpp, std::max(std::min(now, soon), now * 0.35));
            }
            if (nearestOpp <= (d >= 165.0 ? 50.0 : 58.0)) continue;   // clipped ball arrives quicker than the roll this was tuned for
            if (countLaneBlockers(state.players, holder.x, holder.y, p.x, p.y, holder.team, BLOCKER_PERP_GK_DIST, 0.12, 0.92) != 0) continue;
            double progress = (p.x - ownGoalX) * fd;
            // GK DISTRIBUTION POLISH: among the safe short options, prefer the MOST OPEN man (most
            // space around him), not just the most advanced — a keeper rolls it to the defender in
            // acres, not the one with a forward breathing on him. Picks the genuinely-safe ball.
            // Mid-band distance penalty halved: an OPEN clipped option at
            // 170-320 competes with the deep roll instead of always losing
            // 0.20/px (openness is already the dominant term).
            double score = progress * 0.30 - d * (d < 170.0 ? 0.20 : 0.10) + sp::weight(sp::GK_SHORT, p.role) +
                           (std::min(nearestOpp, 160.0) - 42.0) * 0.45;
            if (score > bestSafe) {
                bestSafe = score;
                sp = &p;
            }
        }
        }
        if (sp && passBallTo(holder, *sp, false, false, nullptr, /*secure=*/true)) {
            goalKickMonitor.active = true;
            goalKickMonitor.team = holder.team;
            goalKickMonitor.startedMs = state.clockMs;
            stats.recordGoalKickAttempt();
            goalKickMonitor.distributeTimer = 0;
            return;
        }
    }
    Player* outlet = nullptr;
    double best = -1e9;
    for (auto& p : state.players) {
        if (p.team != holder.team || p.id == holder.id || p.role == Role::GK || p.sentOff) continue;
        double progress = (p.x - ownGoalX) * fd;
        if (progress < 430.0) continue;
        double lane = std::abs(p.y - PITCH_H / 2.0);
        double roleBonus = sp::weight(sp::GK_LONG, p.role);
        double pressurePenalty = 0.0;
        for (auto& o : state.players) {
            if (!isActiveOpponent(o, holder.team)) continue;
            double od = dist(o.x, o.y, p.x, p.y);
            if (od < 90.0) pressurePenalty += (90.0 - od) * 0.65;
        }
        double score = progress * 0.32 + lane * 0.20 + roleBonus - pressurePenalty;
        if (score > best) {
            best = score;
            outlet = &p;
        }
    }
    if (!outlet) {
        for (auto& p : state.players) {
            if (p.team != holder.team || p.id == holder.id || p.role == Role::GK || p.sentOff) continue;
            double progress = (p.x - ownGoalX) * fd;
            double score = progress + sp::weight(sp::GK_BOXRUN, p.role);
            if (score > best) {
                best = score;
                outlet = &p;
            }
        }
    }

    double targetX = outlet ? outlet->x : clamp(holder.x + fd * 575.0, 45.0, PITCH_W - 45.0);
    double targetY = outlet ? outlet->y : clamp(PITCH_H / 2.0 + (rng.random() < 0.5 ? -170.0 : 170.0), 55.0, PITCH_H - 55.0);
    targetX = clamp(targetX + fd * (35.0 + rng.random() * 55.0), 45.0, PITCH_W - 45.0);
    targetY = clamp(targetY + (rng.random() - 0.5) * 55.0, 55.0, PITCH_H - 55.0);

    double dx = targetX - holder.x, dy = targetY - holder.y;
    double d = std::max(1.0, std::hypot(dx, dy));
    if (d < 500.0) {
        targetX = clamp(holder.x + fd * 560.0, 45.0, PITCH_W - 45.0);
        dx = targetX - holder.x;
        dy = targetY - holder.y;
        d = std::max(1.0, std::hypot(dx, dy));
    }
    auto& b = state.ball;
    b.controllerId = -1;
    placeBallForRelease(holder, dx, dy);
    b.lastTouchTeam = holder.team;
    b.lastToucherId = holder.id;
    double speed = 315.0 + clamp(d - 500.0, 0.0, 180.0) * 0.16;
    b.vx = dx / d * speed;
    b.vy = dy / d * speed;
    b.vz = 315.0;
    b.z = 30.0;
    b.intendedReceiverId = outlet ? outlet->id : -1;
    receiverShieldTargetId = b.intendedReceiverId;
    blockReboundFor(holder.id, 900);
    pendingPass.active = false;
    if (outlet) beginTrackedPass(holder, *outlet, false);
    emitEvent("pass", holder.x, holder.y, holder.id, outlet ? outlet->id : -1);
    goalKickMonitor.active = true;
    goalKickMonitor.team = holder.team;
    goalKickMonitor.startedMs = state.clockMs;
    stats.recordGoalKickAttempt();
    goalKickMonitor.distributeTimer = 0;
}

void GameEngine::releaseGoalkeeperDistribution(Player& holder) {
    double fd = fdFor(holder.team);
    double ownGoalX = ownGoalXFor(holder.team);
    bool wasGoalKick = setPiece.type == SetPiece::GoalKick;
    double nearestKeeperPressure = 1e9;
    int closeKeeperPressure = 0;
    Player* nearestPress = nullptr;
    for (auto& o : state.players) {
        if (!isActiveOpponent(o, holder.team)) continue;
        double od = dist(holder.x, holder.y, o.x, o.y);
        if (od < nearestKeeperPressure) {
            nearestKeeperPressure = od;
            nearestPress = &o;
        }
        if (od < 112.0) closeKeeperPressure++;
    }

    auto puntLong = [&]() {
        Player* outlet = nullptr;
        double best = -1e9;
        for (auto& p : state.players) {
            if (p.team != holder.team || p.id == holder.id || p.role == Role::GK || p.sentOff) continue;
            double progress = (p.x - ownGoalX) * fd;
            double wide = std::abs(p.y - PITCH_H / 2.0);
            double roleBonus = sp::weight(sp::DIST_OUTLET, p.role);
            double score = progress + wide * 0.28 + roleBonus;
            if (score > best) {
                best = score;
                outlet = &p;
            }
        }
        double targetX = clamp(holder.x + fd * 575.0, 45.0, PITCH_W - 45.0);
        double targetY = outlet ? outlet->y : (nearestPress ? (nearestPress->y < PITCH_H / 2.0 ? PITCH_H * 0.72 : PITCH_H * 0.28) : holder.y);
        targetY = clamp(targetY, 55.0, PITCH_H - 55.0);
        double dx = targetX - holder.x, dy = targetY - holder.y;
        double d = std::max(1.0, std::hypot(dx, dy));
        auto& b = state.ball;
        b.controllerId = -1;
        placeBallForRelease(holder, dx, dy);
        b.lastTouchTeam = holder.team;
        b.lastToucherId = holder.id;
        b.vx = dx / d * 300.0;   // punt at ~108 km/h (was 119)
        b.vy = dy / d * 300.0;
        // Feet-only hold (back-pass law): the long ball is a driven low punt
        // off the deck, never the from-hands launch.
        b.vz = gkHoldFeetOnly ? 120.0 : 300.0;
        b.z = gkHoldFeetOnly ? 0.0 : 28.0;
        gkHoldFeetOnly = false;
        b.intendedReceiverId = -1;
        emitEvent("pass", holder.x, holder.y, holder.id, outlet ? outlet->id : -1); // tag the GK long distribution (audit #6)
        blockReboundFor(holder.id, 750);
        if (wasGoalKick) {
            goalKickMonitor.active = true;
            goalKickMonitor.team = holder.team;
            goalKickMonitor.startedMs = state.clockMs;
            stats.recordGoalKickAttempt();
        }
        goalKickMonitor.distributeTimer = 0;
        goalKickMonitor.holdSinceMs = -1;
    };

    // Distribution tactic: a team told to play it long sends its keeper long too
    // (probabilistic by the bias). Possession sides (bias 0 — the default) skip
    // this entirely and play out short-safe below.
    double gkLongBias = teamTactics[teamIndex(holder.team)].longBallBias;
    if (gkLongBias > 0.0 && rng.random() < gkLongBias) {
        puntLong();
        return;
    }


    // ── Safety-first distribution: a keeper should keep the ball, not gift it.
    // Find the safest open outlet (clear passing lane, sensible range) and roll
    // it there; only hoof long when genuinely swarmed with no clear lane at all.
    // The old code punted on the faintest pressure (<115px / 2 close) and rated
    // short passes by PROGRESS, so distribution completed only ~60%. This defaults
    // to a short, safe ball — targeting 95%+ completion. Short goal kicks to an
    // open defender are allowed (the 2019 rule lets the ball be received in-area).
    struct GkOutlet {
        Player* p;
        double score;
        bool safe;
    };
    SmallVector<GkOutlet, 11> outs;
    for (auto& p : state.players) {
        if (p.team != holder.team || p.id == holder.id || p.role == Role::GK || p.sentOff) continue;
        double d = dist(holder.x, holder.y, p.x, p.y);
        if (d < 60.0 || d > 520.0) continue;
        double progress = (p.x - ownGoalX) * fd;
        if (progress < -30.0) continue; // never play it back across your own line
        // Press-aware openness: judge the receiver at BALL ARRIVAL, projecting
        // each opponent along his velocity over the flight + first-touch window.
        // "Open now" means nothing under a committed press — watched replay
        // 3'16: a short ball to a full-back read as open at release, the swarm
        // arrived with the ball, tackle -> foul -> penalty conceded.
        double eta = d / 300.0 + 1.0;
        double nearestOpp = 1e9;
        int escapePressure = 0;
        for (auto& o : state.players) {
            if (!isActiveOpponent(o, holder.team)) continue;
            double now = dist(o.x, o.y, p.x, p.y);
            double soon = dist(o.x + o.vx * eta * 0.85, o.y + o.vy * eta * 0.85, p.x, p.y);
            nearestOpp = std::min(nearestOpp, std::max(std::min(now, soon), now * 0.35));
            if (std::min(now, soon) < 115.0) escapePressure++;
        }
        // Press CAPACITY, heading-agnostic: the velocity projection can't see a
        // press that flips on the release trigger (watched replay seed 129
        // 0:36: the nearest presser was RETREATING at release, flipped to the
        // receive point within 0.5s, and the chain ended in a tackle at 0:40).
        // Count everyone whose sprint reaches the receiver inside the flight +
        // first-touch window, whatever he's doing right now.
        int capacityPressure = 0;
        for (auto& o : state.players) {
            if (!isActiveOpponent(o, holder.team)) continue;
            double sprint = std::max(40.0, attrFactor(o.attrs.speed) * SPEED_SPRINT);
            if ((dist(o.x, o.y, p.x, p.y) - 20.0) / sprint < eta) capacityPressure++;
        }
        // A teammate standing in the rolling lane kills the ball dead: the 0:36
        // roll clipped the CB's boots and died 90px short, turning a 215px
        // outlet into a deep central reception with the press converging on it.
        bool mateInLane = false;
        {
            double dxm = p.x - holder.x, dym = p.y - holder.y, lsm = dxm * dxm + dym * dym;
            if (lsm > 1.0)
                for (auto& m : state.players) {
                    if (m.team != holder.team || m.id == holder.id || m.id == p.id || m.sentOff) continue;
                    double t2 = clamp(((m.x - holder.x) * dxm + (m.y - holder.y) * dym) / lsm, 0.08, 0.92);
                    if (std::hypot(m.x - holder.x - t2 * dxm, m.y - holder.y - t2 * dym) < 14.0
                        && dist(m.x, m.y, holder.x, holder.y) < d - 25.0) {
                        mateInLane = true;
                        break;
                    }
                }
        }
        int laneBlockers = countLaneBlockers(state.players, holder.x, holder.y, p.x, p.y, holder.team, BLOCKER_PERP_GK_DIST, 0.12, 0.92);
        bool clearLane = laneBlockers == 0 && !mateInLane;
        // SAFE-BUT-TRAPPED (watched replay 0:45-0:47: the claim was rolled
        // short to a man who was open ON ARRIVAL but boxed in deep; two
        // passes later the opponent had the ball in the danger zone): a deep
        // short outlet must also have somewhere to GO. Two-plus opponents in
        // his escape bubble means the ball comes straight back under
        // pressure — that's not a safe outlet, punt instead.
        bool trapped = progress < 260.0 && (escapePressure >= 2 || capacityPressure >= 2);
        // "Safe" = near-certain to complete AND playable on arrival: a clean
        // lane, a receiver still open when the ball gets there, a short-to-mid
        // ball. The keeper releases only on these and otherwise HOLDS (he can't
        // be tackled — attemptTackle bails on a GK carrier — so waiting for a
        // lane costs nothing and never gifts it). Under a real swarm the bar
        // rises: a marginal short ball into a packed box is how the 3'16
        // penalty happened.
        double openNeed = closeKeeperPressure >= 2 ? 85.0 : 58.0;
        bool safe = clearLane && nearestOpp > openNeed && d < 320.0 && !trapped;
        double roleBonus = sp::weight(sp::DIST_SAFE, p.role);
        double openness = clamp(nearestOpp / 90.0, 0.0, 1.0);
        double prox = 1.0 - clamp(d / 520.0, 0.0, 1.0); // shorter = safer
        double score = (clearLane ? 1.5 : 0.0) + openness * 0.9 + prox * 0.5 + roleBonus + progress / 900.0 * 0.3;
        outs.push_back({&p, score, safe});
    }
    std::sort(outs.begin(), outs.end(), [](const GkOutlet& a, const GkOutlet& b) { return a.score > b.score; });
    auto onRelease = [&](int toId) {
        // Tag GK open-play distribution as a pass EVENT (audit #6: both keepers logged
        // 0 pass events because distribution calls passBallTo directly, bypassing the
        // agent path's emit at agent.cpp). Trace/probe only — the pass STAT is already
        // recorded inside passBallTo, so this changes no summary metric.
        emitEvent("pass", holder.x, holder.y, holder.id, toId);
        if (wasGoalKick) {
            goalKickMonitor.active = true;
            goalKickMonitor.team = holder.team;
            goalKickMonitor.startedMs = state.clockMs;
            stats.recordGoalKickAttempt();
        }
        goalKickMonitor.distributeTimer = 0;
        goalKickMonitor.holdSinceMs = -1;
    };
    // 1) Safest open outlet — a secure (fast, accurate) short roll that completes
    //    almost always.
    for (auto& o : outs) {
        if (!o.safe) continue;
        if (passBallTo(holder, *o.p, false, false, nullptr, /*secure=*/true)) {
            onRelease(o.p->id);
            return;
        }
    }
    // 2) No clean lane, and he's genuinely swarmed (a real high press, 3+ bodies
    //    on him) — holding achieves nothing, so clear it long. Prefer the best
    //    short outlet over a blind hoof; punt only if there's no one at all.
    if (closeKeeperPressure >= 3) {
        for (auto& o : outs) {
            if (passBallTo(holder, *o.p, false, false, nullptr)) {
                onRelease(o.p->id);
                return;
            }
        }
        puntLong();
        return;
    }
    // 3) Otherwise HOLD and wait for a lane to open rather than passing into
    //    traffic. The keeper can't be tackled while holding, so waiting for a lane
    //    is cheap and lifts completion into the high-90s — but it is NOT free
    //    forever: with no clean lane and under 3 bodies, the old code re-armed a
    //    set-piece (`setPiece.armed=true; type stays None`) to "retry shortly".
    //    That was a freeze bug — an armed set-piece diverts fixedUpdate into
    //    updateSetPiecePhase, which has NO branch for an armed/type-None keeper
    //    holding the ball, so nothing ever re-called this function. The keeper sat
    //    frozen ~2.7s until the stuck-carrier watchdog force-passed him.
    //    Fix: DON'T arm. Re-arm the distribute timer instead — fixedUpdate counts
    //    it down and re-enters releaseSetPiece → back here for a genuine retry,
    //    all in open play where the keeper is positioned and tackle-immune.
    //    And cap the total hold: once he has waited GK_MAX_HOLD_MS for a lane that
    //    never opened, stop stalling and play the best ball he has, or hoof long.
    if (goalKickMonitor.holdSinceMs < 0) goalKickMonitor.holdSinceMs = state.clockMs;
    if (state.clockMs - goalKickMonitor.holdSinceMs > GK_MAX_HOLD_MS) {
        for (auto& o : outs) {
            if (passBallTo(holder, *o.p, false, false, nullptr)) {
                onRelease(o.p->id);
                return;
            }
        }
        puntLong();
        return;
    }
    goalKickMonitor.distributeTimer = 250; // hold in open play; retry in 250ms
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
        b.controllerId = -1;
        placeBallForRelease(holder, dx, dy);
        blockReboundFor(holder.id, 600);
        b.lastTouchTeam = holder.team;
        b.lastToucherId = holder.id;
        double speed = clamp(160.0 + d * 0.15, 160.0, 290.0); // a powerful long throw
        b.vx = dx / d * speed;
        b.vy = dy / d * speed;
        b.vz = speed * 0.9;
        b.z = 0; // flat-fast aerial into the box
        b.intendedReceiverId = -1;
        receiverShieldTargetId = -1;
        pendingPass.active = false;
        return;
    }
    for (auto& p : state.players) {
        if (p.team != holder.team || p.id == holder.id || p.role == Role::GK || p.sentOff) continue;
        double d = dist(holder.x, holder.y, p.x, p.y);
        if (d < 30.0 || d > 400.0) continue;
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
        b.controllerId = -1;
        placeBallForRelease(holder, dx, dy);
        blockReboundFor(holder.id, 600);
        b.lastTouchTeam = holder.team;
        b.lastToucherId = holder.id;
        b.vx = dx / d * speed;
        b.vy = dy / d * speed;
        b.vz = speed * 1.4;
        b.z = 0;
        b.intendedReceiverId = t.id;
        receiverShieldTargetId = t.id;
        beginTrackedPass(holder, t, false);
        return;
    }
    auto& b = state.ball;
    double side = holder.y < PITCH_H / 2.0 ? 1.0 : -1.0;
    double dx = fd * 80.0, dy = side * 130.0, d = std::hypot(dx, dy);
    double speed = 155.0;
    b.controllerId = -1;
    placeBallForRelease(holder, dx, dy);
    blockReboundFor(holder.id, 600);
    b.lastTouchTeam = holder.team;
    b.lastToucherId = holder.id;
    b.vx = dx / d * speed;
    b.vy = dy / d * speed;
    b.vz = speed * 0.95;
    b.z = 0;
    b.intendedReceiverId = -1;
    receiverShieldTargetId = -1;
    pendingPass.active = false;
}

void GameEngine::releaseCornerKick(Player& holder) {
    double goalX = holder.x < HALF_X ? HOME_GOAL_X : AWAY_GOAL_X;
    // Short corner: ~18% are worked SHORT to a nearby teammate (the short option who stayed near
    // the flag) instead of the whipped cross — set-piece variety. The receiver then plays on in
    // open play (cross/cutback/dribble). Falls through to the cross if no near option is present.
    if (rng.random() < 0.18) {
        Player* shortOpt = nullptr;
        double bestD = 125.0;
        for (auto& p : state.players) {
            if (p.team != holder.team || p.id == holder.id || p.role == Role::GK || p.sentOff) continue;
            double d = dist(holder.x, holder.y, p.x, p.y);
            if (d > 35.0 && d < bestD) {
                bestD = d;
                shortOpt = &p;
            }
        }
        if (shortOpt) {
            double dx = shortOpt->x - holder.x, dy = shortOpt->y - holder.y, d = std::max(1.0, std::hypot(dx, dy));
            auto& b = state.ball;
            b.controllerId = -1;
            placeBallForRelease(holder, dx, dy);
            blockReboundFor(holder.id, 600);
            b.lastTouchTeam = holder.team;
            b.lastToucherId = holder.id;
            double speed = clamp(150.0 + d * 0.35, 150.0, 250.0);
            b.vx = dx / d * speed;
            b.vy = dy / d * speed;
            b.z = 0;
            b.vz = 0;
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
        Player& target = *targets.front().player;
        double tx = goalX + (holder.team == Team::Home ? -1.0 : 1.0) * 85.0;
        double ty = lerp(target.y, PITCH_H / 2.0, 0.55);
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
            b.vx = dx / d * speed;
            b.vy = dy / d * speed;
            b.z = 0;
            applyWhipDelivery(d, speed, goalX, 0.18, 0.15);
            b.intendedReceiverId = target.id;
            receiverShieldTargetId = target.id;
            beginTrackedPass(holder, target, true);
            return;
        }
    }
    setPiece.armed = true;
    phase.actionTimer = 450;
}

void GameEngine::awardThrowIn(Team lastTouchTeam, double y) {
    auto& b = state.ball;
    Team atTeam = (lastTouchTeam == Team::Home) ? Team::Away : Team::Home;
    // Spot from where it crossed; the BALL itself keeps rolling out (glide)
    // instead of teleporting to the line — updateSetPiecePhase places it.
    double sx = clamp(b.x, 10., PITCH_W - 10);
    double sy = clamp(y, 3.0, PITCH_H - 3.0);
    b.controllerId = -1;
    b.intendedReceiverId = -1;
    setPiece.type = SetPiece::ThrowIn;
    setPiece.team = atTeam;
    setPiece.armed = true;
    setPiece.reason = "throw_in";
    if (const Player* tgk = findGK(atTeam))
        emitEvent("throw_in", sx, sy, tgk->id, -1, true);
    phase.actionTimer = 5000;
    setPiece.spotX = sx;
    setPiece.spotY = sy;
    setPiece.takerArrived = false;
    setPiece.placeBallAtMs = state.clockMs + OUT_BALL_GLIDE_MS;
    Player* best = findNearestOutfieldPlayer(atTeam, sx, sy);
    setPiece.takerId = best ? best->id : -1;
}

void GameEngine::awardSetPiece(SetPiece t, Team tm) {
    auto& b = state.ball;
    // Goal kicks restore these for the out-ball glide; fouls/pens stay dead.
    double keepVx = b.vx, keepVy = b.vy, keepZ = b.z, keepVz = b.vz;
    b.vx = b.vy = b.z = b.vz = 0;
    b.controllerId = -1;
    setPiece.type = t;
    setPiece.team = tm;
    setPiece.armed = true;
    setPiece.fast = false;   // default; the FreeKick branch may set it true
    setPiece.reason = std::string(to_string(t));
    setPiece.spotX = b.x;
    setPiece.spotY = b.y;
    setPiece.takerArrived = false;
    Team tmTeam = tm;

    if (t == SetPiece::GoalKick) {
        // Place the BALL at the goal-kick spot and let the keeper jog to it
        // via the generic taker walk — snapping him there teleported the GK
        // ~100px on every restart (the most frequent visual pop left).
        // 6s total (was 1.55s): a goal kick is a breather, not a quick restart —
        // part of the restart-pacing pass that brings in-play time toward real.
        phase.actionTimer = 6000;
        setPiece.takerId = -1;
        for (auto& p : state.players) {
            if (p.team == tmTeam && p.role == Role::GK) {
                double fd = fdFor(tmTeam);
                double side = b.y < PITCH_H / 2.0 ? -1.0 : 1.0;
                setPiece.spotX = ownGoalXFor(tmTeam) + fd * (40.0 + CONTROL_DIST);   // inside the 55px goal area (audit: 70px sat outside it)
                setPiece.spotY = clamp(PITCH_H / 2.0 + side * 78.0, 120.0, PITCH_H - 120.0);
                setPiece.takerId = p.id;
                break;
            }
        }
        if (setPiece.takerId >= 0)
            emitEvent("goal_kick", setPiece.spotX, setPiece.spotY, setPiece.takerId, -1, true);
        // The out-ball GLIDES (it used to vanish mid-flight at the line and
        // reappear dead at the spot); restore its flight and let
        // updateSetPiecePhase place it when the glide window closes.
        b.vx = keepVx;
        b.vy = keepVy;
        b.z = keepZ;
        b.vz = keepVz;
        setPiece.placeBallAtMs = state.clockMs + OUT_BALL_GLIDE_MS;
        return;
    }

    if (t == SetPiece::Penalty) {
        // Ball goes to the SPOT — without this, "penalties" were taken from
        // wherever the foul happened (tight angles, crowds) and barely scored.
        double fd = fdFor(tmTeam);
        b.x = goalXFor(tmTeam) - fd * PENALTY_SPOT_FROM_GOAL;
        b.y = PITCH_H / 2.0;
        setPiece.spotX = b.x;
        setPiece.spotY = b.y;
        phase.actionTimer = 5000;
        Player* best = nullptr;
        double bestScore = -1e9;
        for (auto& p : state.players) {
            if (p.team != tmTeam || p.role == Role::GK || p.sentOff) continue;
            double roleBonus = agentFor(p)->penaltyTakerBonus();
            double score = roleBonus + attrFactor(p.attrs.shooting) * 95.0 - dist(p.x, p.y, b.x, b.y) * 0.04;
            if (score > bestScore) {
                bestScore = score;
                best = &p;
            }
        }
        setPiece.takerId = best ? best->id : -1;
        return;
    }

    // Free kick: nearest outfield player runs to ball
    phase.actionTimer = 5000;
    Player* best = findNearestOutfieldPlayer(tmTeam, b.x, b.y);
    setPiece.takerId = best ? best->id : -1;

    // ── Rare sneaky FAST free kick ── occasionally a taker plays it QUICKLY,
    // before the defence forms its block — the sharp counter-punch a good side
    // takes when the ref lets play flow (owner ask). Gated tight so it never
    // spams and never replaces a shooting FK: only when it is NOT a direct
    // shooting position (a fast shot would just be a worse shot from range),
    // and only when a genuinely open team-mate is already ahead of the ball
    // with a clean lane to receive. ~14% of those.
    double oppGoalX = goalXFor(tmTeam);
    double spotToGoal = std::abs(b.x - oppGoalX);
    setPiece.fast = false;
    // Frequency rises with distance from goal (owner ask): near a shooting
    // position a quick tap is rarely the play, but a free kick won deep in
    // your own half is exactly where the sharp early ball beats the press
    // before it sets. 0.16 floor at the 260 gate, climbing toward ~0.38 for a
    // FK won ~550+ from the opposition goal.
    double fastProb = clamp(0.16 + (spotToGoal - 260.0) / 900.0 * 0.30, 0.16, 0.38);
    if (best && spotToGoal > 260.0 && rng.random() < fastProb) {
        double fd = fdFor(tmTeam);
        for (auto& m : state.players) {
            if (m.team != tmTeam || m.id == best->id || m.role == Role::GK || m.sentOff) continue;
            double fwd = (m.x - b.x) * fd;              // ahead of the ball
            if (fwd < 40.0 || fwd > 320.0) continue;
            if (isOffsideTargetPerceived(*best, m)) continue;
            double nearOpp = 1e9;
            for (auto& o : state.players)
                if (isActiveOpponent(o, tmTeam)) nearOpp = std::min(nearOpp, dist(o.x, o.y, m.x, m.y));
            if (nearOpp < 70.0) continue;               // receiver must be open
            if (countLaneBlockers(state.players, b.x, b.y, m.x, m.y, tmTeam, BLOCKER_PERP_FREEKICK, 0.08, 0.92) != 0) continue;
            setPiece.fast = true;                       // clean quick outlet exists — take it early
            break;
        }
    }
}

void GameEngine::awardCorner(Team attackingTeam, bool atHomeEnd, double y) {
    if (std::getenv("CORNER_DEBUG"))
        fprintf(stderr, "[corner] t=%.2f ball=(%.0f,%.0f,z%.0f) v=(%.0f,%.0f) att=%d lastTouch=%d\n",
                state.clockMs/1000.0, state.ball.x, state.ball.y, state.ball.z,
                state.ball.vx, state.ball.vy, (int)attackingTeam, state.ball.lastToucherId);
    stats.recordCorner();
    // Own-corner concession census (owner: "player kicks it out — flag this
    // shit and never do this fuckup again"): a corner conceded by the
    // defender's own DELIBERATE kick within 2.5s of release — not a save,
    // header duel, block or deflection. The slice-clearance branch was the
    // known source (both seed-133 0:25 and 0:48); this is the standing
    // tripwire for any future member of the class.
    {
        Team conceding = attackingTeam == Team::Home ? Team::Away : Team::Home;
        Player* ct = playerById(state.ball.lastToucherId);
        if (ct && ct->team == conceding && ct->role != Role::GK
            && state.ball.lastToucherId == lastDeliberateKickToucher
            && state.clockMs - lastDeliberateKickMs < 2500.0
            && lastLooseOrigin != LooseOrigin::Shot
            && lastLooseOrigin != LooseOrigin::HeaderClearance
            && lastLooseOrigin != LooseOrigin::Woodwork)
            stats.recordQualityFlag(QualityFlag::OwnCornerConcession);
    }
    // Restart marker for the replay feed (trace-only: keeps the live ticker and
    // getJSON events[] unchanged). Without it the out-ball glide to the flag
    // reads as "the ball moved without anyone touching it" (watched seed 133
    // 0:39) — the feed line names the restart the moment it's awarded. Team is
    // carried via the attacking GK's id (events derive team from playerId).
    if (const Player* cgk = findGK(attackingTeam))
        emitEvent("corner", state.ball.x, state.ball.y, cgk->id, -1, true);
    auto& b = state.ball;
    b.controllerId = -1;
    b.intendedReceiverId = -1;
    setPiece.type = SetPiece::Corner;
    setPiece.team = attackingTeam;
    setPiece.armed = true;
    setPiece.reason = "corner";
    phase.actionTimer = 5000;
    setPiece.takerArrived = false;
    // Corner SIDE from the ball's actual TRAJECTORY: several award sites fire
    // while the deflection is still in flight (block/header ricochets ruled
    // "going behind" early), and the passed-in y is the ball's CURRENT y — a
    // ball arcing toward the top corner got placed at the bottom flag
    // (watched replay 0:24). Project where it will cross the goal line.
    double lineX = atHomeEnd ? 0.0 : PITCH_W;
    double yProj = y;
    if (std::abs(b.vx) > 20.0 && (lineX - b.x) * b.vx > 0.0)
        yProj = b.y + b.vy * ((lineX - b.x) / b.vx);
    double cy = yProj < PITCH_H / 2.0 ? 0.0 : PITCH_H;
    // Corner taken from the corner ARC, not 1.8m inside the field of play.
    double ix = atHomeEnd ? 6.0 : PITCH_W - 6.0;
    double iy = cy == 0.0 ? 6.0 : PITCH_H - 6.0;
    // Ball GLIDES out (no mid-flight teleport); placed at the arc by
    // updateSetPiecePhase when the glide window closes.
    setPiece.spotX = ix;
    setPiece.spotY = iy;
    setPiece.placeBallAtMs = state.clockMs + OUT_BALL_GLIDE_MS;
    Player* taker = nullptr;
    double best = 1e9;
    for (auto& p : state.players) {
        if (p.team != attackingTeam || p.role == Role::GK || p.sentOff) continue;
        double roleCost = sp::weight(sp::CORNER_TAKER, p.role);
        double d = dist(p.x, p.y, ix, iy) + roleCost;
        if (d < best) {
            best = d;
            taker = &p;
        }
    }
    setPiece.takerId = taker ? taker->id : -1;
}

void GameEngine::updateGoalKickMonitor() {
    if (!goalKickMonitor.active) return;
    double fd = fdFor(goalKickMonitor.team);
    double ownGoalX = ownGoalXFor(goalKickMonitor.team);
    double progress = (state.ball.x - ownGoalX) * fd;
    if (state.ball.lastTouchTeam == goalKickMonitor.team && progress > PITCH_W / 3.0) {
        stats.recordGoalKickExit();
        goalKickMonitor.active = false;
    } else if (state.clockMs - goalKickMonitor.startedMs > 18000.0) {
        goalKickMonitor.active = false;
    }
}
