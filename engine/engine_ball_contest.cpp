// engine_ball_contest.cpp — who gets a live ball this tick, and what happens
//
// Split out of engine_physics.cpp (1739 lines, four subsystems). This is the
// whole of checkBallPlayerCollision: the ordered contest that runs once per tick
// on a ball with no controller, after applyBallPhysics has stepped it and the
// woodwork/goal/out-of-play checks have declined it.
//
// The order IS the design and each phase returns on commit, so the one below it
// never sees the ball:
//   1  tryCutbackFirstTimeFinish  a box runner sweeps a low cross/cutback in
//   2  tryKeeperLooseGather       the keeper scoops a reachable loose ball
//   3  tryIntendedReceiverMeet    the man it was played to traps or heads it
//   4  tryKeeperCrossClaim        the keeper comes and claims a hanging cross
//   5  resolveBallContact         everyone else: the generic body contact
// findBallContact is phase 5's swept-path pick, and it lives here because that
// is its only caller. Granting control is engine_collect.cpp's collectBall.

#include "engine.h"
#include "agent.h"
#include <cmath>

// ── First-time finish ── A driven LOW cross/cutback reaching an attacking
// runner in the box is swept in FIRST-TIME rather than trapped: it is too
// quick to control (it would skid through, or the keeper would gather it),
// but a finisher meeting it goal-side can strike it clean. We route through
// shootBall so it is a genuine tracked shot, and stamp throughCollected for
// the clean first-touch error model (a FOOT finish, not a header). This sits
// ahead of the keeper-gather so the striker who is first to the ball wins —
// but only when he is actually closer to it than any keeper.
// Cutbacks now finish first-time too (isCutback was a render-only hint): the
// pulled-back ball to an arriving runner at the spot is real football's
// signature close chance, but its reception was a normal trap — take a touch
// at 12m with defenders closing, recycle. Sweeping it first-time is what
// converts the engine's existing cutback volume into genuine box chances
// (shot mix sat at close 2% / medium 68%; real ~20/40). Lower speed gate
// than the driven cross — a cutback is a measured pull-back, not a whip.
// Returns true when it fired a shot (caller returns); false = fall through.
bool GameEngine::tryCutbackFirstTimeFinish(double bs) {
    auto& b = state.ball;
    if (b.controllerId < 0 && pendingPass.active && (pendingPass.isCross ? bs > 190.0 : pendingPass.isCutback && bs > 110.0) && b.intendedReceiverId >= 0 && b.z <= GROUND_MEET_MAX_Z + 6.0) {
        Player* rcv = playerById(b.intendedReceiverId);
        if (rcv && rcv->team == pendingPass.team && (rcv->role == Role::CF || rcv->role == Role::WM || rcv->role == Role::CM)) {
            double goalX = goalXFor(rcv->team);
            double tgd = std::abs(rcv->x - goalX);
            double dRcv = dist(rcv->x, rcv->y, b.x, b.y);
            // NOTE (measured): cutback receivers currently arrive at tgd ~195 —
            // OUTSIDE this 175 gate — so the cutback first-time finish rarely
            // fires yet. Widening the gate to 215 was A/B'd and REJECTED: it
            // just minted 20m first-time pot-shots (long-shot share up, goals
            // +0.5). The right fix is POSITIONING — the cutback runner must
            // attack the penalty-spot band (80-140px), not hang at the edge;
            // until then this fires only on the (correctly) well-positioned few.
            bool inBox = tgd < 175.0 && std::abs(rcv->y - PITCH_H / 2.0) < 200.0;
            bool reachable = dRcv <= MEET_REACH_GROUND + 10.0;
            bool keeperCloser = false;
            int frontPress = 0;
            double gkDistToRcv = 1e9;
            for (auto& o : state.players) {
                if (o.sentOff || o.team == rcv->team) continue;
                if (o.role == Role::GK) {
                    if (dist(o.x, o.y, b.x, b.y) < dRcv - 2.0) keeperCloser = true;
                    gkDistToRcv = std::min(gkDistToRcv, dist(o.x, o.y, rcv->x, rcv->y));
                } else if (dist(o.x, o.y, rcv->x, rcv->y) < 26.0)
                    frontPress++;
            }
            if (inBox && reachable && !keeperCloser) {
                // Law 11 (audit HIGH): this path cleared pendingPass and shot
                // without ever consulting the offside snapshot — a receiver
                // offside at the whip could sweep it in unflagged. Same judgment
                // as resolvePendingPass, from the same launch snapshot.
                // Round-30: this test used to sit ABOVE the dRcv/inBox/reachable
                // gates, and the enclosing guard is true on the FIRST tick after
                // any low cross leaves the foot — so the flag went up at the
                // STRIKE and awardOffsideFreeKick then dragged the ball up to
                // 265px to the flagged player's feet while it was still on the
                // kick spot. Offside is a decision about a player who BECOMES
                // INVOLVED, so judge it where the involvement happens: the r9
                // comment always said the point was to gate the SHOT. Deliberate
                // consequence: when keeperCloser is true this now falls through
                // and the keeper gathers with no offside given — correct, the
                // offside-positioned attacker never became involved at all.
                if (!pendingPass.offsideExempt && rcv->id == pendingPass.toId && pendingPass.receiverOffsideAtPass) {
                    stats.recordOffside();
                    emitEvent("offside", rcv->x, rcv->y, rcv->id, pendingPass.fromId);
                    pendingPass.active = false;
                    awardOffsideFreeKick(rcv->team == Team::Home ? Team::Away : Team::Home, *rcv);
                    return true;
                }
                // A keeper right on top of the chance smothers the tap-in — proximity
                // to the RUNNER (not just the ball) cuts the finish toward zero.
                double gkProx = clamp((55.0 - gkDistToRcv) / 55.0, 0.0, 1.0);
                double finishChance = clamp(0.50 + attrFactor(rcv->attrs.shooting) * 0.30 - frontPress * 0.16 - gkProx * 0.45 - clamp((bs - 250.0) / 600.0, 0.0, 0.16), 0.12, 0.88);
                if (rng.random() < finishChance) {
                    pendingPass.active = false;
                    b.intendedReceiverId = -1;
                    // Flat, clean foot finish — explicitly NOT a header (shot.header stays false).
                    shootBall(*rcv, nullptr, /*headerFinish=*/false, /*firstTimeFinish=*/true);
                    return true;
                }
                // Scuffed the first-time effort — the ball runs loose.
                b.intendedReceiverId = -1;
                blockReboundFor(rcv->id, 200);
            }
        }
    }
    return false;
}

// A shot the keeper has already won the reflex roll on belongs to the
// deferred-save resolver (parry/punch/tip/catch) — don't let the generic
// keeper-gather scoop it first and flatten every save into a clean pickup.
// Returns true if he collected it (caller returns).
bool GameEngine::tryKeeperLooseGather(double bs) {
    auto& b = state.ball;
    if (b.controllerId < 0 && b.z <= AERIAL_HEIGHT && !pendingSave.active) {
        Player* keeperContact = nullptr;
        double bestKeeperScore = 1e9;
        for (auto& p : state.players) {
            if (p.role != Role::GK || !canContestBall(p)) continue;
            // A shot pre-rolled as beating the keeper clean can't be casually
            // scooped via positioning pickup after the failed reflex save —
            // but a DYING ball (<140px/s) is anyone's: a keeper watching a
            // trickler roll past him into the net is absurd. (Re-anchored from
            // 220 with the ~0.62x shot-speed reduction.)
            if (lastLooseOrigin == LooseOrigin::Shot && bs > 140.0 && p.team != shot.team && !shot.scoopAllowed) continue;
            double goalX = ownGoalXFor(p.team);
            bool ballInOwnArea = std::abs(b.x - goalX) < PENALTY_AREA_W && pitch::lateralFromCenter(b.y) < PENALTY_AREA_H / 2.0;
            if (!ballInOwnArea) continue;
            double d = dist(p.x, p.y, b.x, b.y);
            bool dyingShot = lastLooseOrigin == LooseOrigin::Shot && bs < 140.0;
            double reach = dyingShot ? GK_LOOSE_COLLECT_DIST + 6.0
                                     : (bs > 120.0 ? GK_LOOSE_COLLECT_FAST_DIST : GK_LOOSE_COLLECT_DIST);
            if (d > reach) continue;
            double score = d / reach;
            if (b.lastTouchTeam != p.team) score -= 0.18;
            if (score < bestKeeperScore) {
                bestKeeperScore = score;
                keeperContact = &p;
            }
        }
        if (keeperContact) {
            // A keeper gathering a beaten-but-reachable shot IS a save — but
            // only if the ball was actually goal-bound (else saves > shots-on-
            // target, which is impossible). Record the on-target shot too so
            // the ledger stays consistent (saves <= shotsOnTarget).
            if (lastLooseOrigin == LooseOrigin::Shot && keeperContact->team != shot.team) {
                double goalX = ownGoalXFor(keeperContact->team);
                double along = std::max(std::abs(b.vx), 1.0);
                double projY = b.y + b.vy * (std::abs(b.x - goalX) / along);
                bool goalBound = std::abs(projY - PITCH_H / 2.0) < GOAL_W / 2.0 + 6.0 && b.z + BALL_R <= GOAL_H; // #1b: under the bar too
                if (goalBound) {
                    stats.recordShotOnTarget();
                    // Real-world convention (Opta): EVERY on-target shot the keeper
                    // stops is a save, however routine the gather. The old >295px/s
                    // pace gate (#1c/#35) was calibrated when shotsOnTarget itself
                    // under-counted (it excluded scored shots pre-5519235), which
                    // made "saves = onTarget" look inflated — circular. With the
                    // on-target ledger complete, the audit read SoT 8.45 = goals
                    // 3.10 + saves 3.60 + 1.75 UNACCOUNTED (these scoops); counting
                    // them lands saves at ~5.3 (real 5-6) and closes the ledger.
                    stats.recordSave();
                    emitEvent("save", keeperContact->x, keeperContact->y, keeperContact->id);
                    keeperContact->diveAnim = std::max(keeperContact->diveAnim, 440.0); // render-only stretch
                }
            }
            // Reaching BEYOND standing arm length (23.5px) to gather a loose
            // ball means the keeper stretches/lunges for it — without this he
            // grabbed a ball 34px away looking planted, "well outside his
            // wingspan" (watched replay 0:44). diveAnim is render-only (feeds
            // no rng, no logic — engine_gk.cpp) so the golden is untouched.
            if (dist(keeperContact->x, keeperContact->y, b.x, b.y) > GK_STAND_REACH)
                keeperContact->diveAnim = std::max(keeperContact->diveAnim, 300.0);
            collectBall(*keeperContact);
            return true;
        }
    }
    return false;
}

    // ── KEEPER CROSS-CLAIM ──
    // A live cross the intended receiver did NOT win, hanging in the keeper's
    // own 6-yard zone at takeable height: he comes and claims it. Sits AFTER the
    // intended-receiver block (the striker gets first refusal) and BEFORE the
    // generic loop, returning on commit so the GK-skip path never double-handles.
    // Every gate condition is deterministic board state — NO rng before commit.
bool GameEngine::tryKeeperCrossClaim() {
    auto& b = state.ball;
    if (pendingPass.active && pendingPass.isCross && b.controllerId < 0 && b.z >= GK_CLAIM_MIN_Z && b.z <= GK_CLAIM_MAX_Z) {
        Player* gk = nullptr;
        for (auto& p : state.players) {
            if (p.role != Role::GK || p.team == pendingPass.team) continue; // defending keeper
            if (!canContestBall(p)) continue;
            gk = &p;
            break;
        }
        if (gk && agentFor(*gk)->canUseHands()) {
            double goalX = ownGoalXFor(gk->team);
            double bdg = std::abs(b.x - goalX);
            bool inZone = bdg < GK_CLAIM_DEPTH && pitch::lateralFromCenter(b.y) < GK_CLAIM_HALF_W;
            double dz = std::max(0.0, b.z - GK_CLAIM_REACH_Z);
            double claimD = std::hypot(dist(gk->x, gk->y, b.x, b.y), dz);
            if (inZone && claimD <= GK_CLAIM_RADIUS) {
                resolveCrossClaim(*gk, claimD); // draws rng, then RETURNS
                return true;
            }
        }
    }
    return false;
}

    // Intended receiver gets priority with larger collection radius. A driven
    // cross arrives way over the 250 trap-speed limit — but it isn't trapped,
    // it's MET (header), so the band-height arrival bypasses the speed gate.
bool GameEngine::tryIntendedReceiverMeet(double bs) {
    auto& b = state.ball;
    // Round-31: a lofted long ball arrives exactly like a cross does — in the
    // air, to be met rather than trapped — so it takes the same aerial arrival
    // treatment: header reach, the trap-speed bypass, and the aerial duel below.
    bool crossArrival = pendingPass.active && (pendingPass.isCross || pendingPass.isLofted)
                        && b.z >= HEADER_MIN_HEIGHT && b.z <= HEADER_MAX_HEIGHT;
    if (b.intendedReceiverId >= 0 && (bs < 250 || crossArrival)) {
        Player* intended = playerById(b.intendedReceiverId);
        if (intended) {
            double d = dist(intended->x, intended->y, b.x, b.y);
            // Z-AWARE SLANT REACH (not a horizontal cylinder). A header reaches
            // up to HEADER_REACH_Z high; the true ball->contact range is the
            // slant hypot of the horizontal gap and the height above that reach.
            // The old flat (d<=meetDist && z<=64) let a runner "meet/head" a
            // cross from ~3-4m and even at chest height — the ghost deflection.
            double reachZ = crossArrival ? HEADER_REACH_Z : 0.0;
            double reach = crossArrival ? MEET_REACH_HEAD : MEET_REACH_GROUND;
            double zGate = crossArrival ? HEADER_MAX_HEIGHT : GROUND_MEET_MAX_Z;
            double dz = std::max(0.0, b.z - reachZ);
            double meetD3 = std::sqrt(d * d + dz * dz);
            // Aerial duel: a marker tight on the runner attacks the same ball —
            // but only if HE is genuinely within header reach of the BALL, not
            // just near the runner (the old od<48 picked a man up to ~7m off
            // the ball, who then "headed it clear" in mid-air).
            if (crossArrival && meetD3 <= reach && b.z <= zGate && canContestBall(*intended)) {
                Player* dueler = nullptr;
                double duelerDist = 1e9;
                for (auto& opp : state.players) {
                    if (opp.team == intended->team || opp.role == Role::GK || !canContestBall(opp)) continue;
                    double od = dist(opp.x, opp.y, intended->x, intended->y);
                    double obd = dist(opp.x, opp.y, b.x, b.y);
                    double obz = std::max(0.0, b.z - HEADER_REACH_Z);
                    double ob3 = std::sqrt(obd * obd + obz * obz);
                    // Same slant reach as the receiver's own meet grant: the
                    // 28:45 phantom (seed 111) granted the header at meetD3~19
                    // while the defender 20.4px from the BALL failed the tighter
                    // MEET_REACH_HEAD gate and was never consulted. Symmetric
                    // reach = whoever is genuinely closer contests.
                    if (od < 48.0 && ob3 <= reach + 4.0 && od < duelerDist) {
                        dueler = &opp;
                        duelerDist = od;
                    }
                }
                if (dueler) {
                    // Aerial duel blends positioning with HEIGHT (50/50): a tall
                    // stopper out-jumps a small attacker on crosses. height defaults
                    // to positioning, so this is byte-identical until a spec sets a
                    // distinct height (then the tall man wins more).
                    double dAer = 0.5 * attrFactor(dueler->attrs.positioning) + 0.5 * attrFactor(dueler->attrs.height);
                    double iAer = 0.5 * attrFactor(intended->attrs.positioning) + 0.5 * attrFactor(intended->attrs.height);
                    // Defender-favoured base (0.52 -> 0.58): the marker attacks a
                    // whipped ball moving TOWARD him — real defenses win most
                    // contested aerials, and at 0.52 the engine ran 30% headed
                    // goals (real 15-20%).
                    double duelChance = clamp(0.58 + (dAer - iAer) * 0.35 + (48.0 - duelerDist) / 48.0 * 0.18, 0.12, 0.80);
                    if (rng.random() < duelChance) {
                        dueler->headingAnim = 520.0;
                        collectBall(*dueler); // routes to header clearance
                        return true;
                    }
                    // One jump per cross — a beaten dueler doesn't get to
                    // re-roll every tick the ball hangs in his radius.
                    blockReboundFor(dueler->id, 420);
                }
            }
            if (meetD3 <= reach && b.z <= zGate && crossArrival && bs > 300.0 && canContestBall(*intended) && rng.random() > CROSS_MEET_BASE + attrFactor(intended->attrs.positioning) * CROSS_MEET_SKILL) {
                blockReboundFor(intended->id, 380);
            } else if (meetD3 <= reach && b.z <= zGate) {
                if (canContestBall(*intended)) {
                    // Find the tightest opponent and whether he's GOAL-SIDE
                    // (in front) of the receiver — receiving front-to-front
                    // with a defender between you and goal is the hard case:
                    // you can't turn, and controlling cleanly is far from
                    // guaranteed. A defender behind/beside is far less of a
                    // threat (you can shield and roll away).
                    double ifd = fdFor(intended->team);
                    double nearOppD = 1e9;
                    double frontPress = 0.0;
                    int tightMarkers = 0;
                    for (auto& opponent : state.players) {
                        if (!isActiveOpponent(opponent, intended->team)) continue;
                        double od = dist(opponent.x, opponent.y, intended->x, intended->y);
                        if (od < 32.0) tightMarkers++; // sandwiched count
                        if (od < nearOppD) {
                            nearOppD = od;
                            double goalSide = (opponent.x - intended->x) * ifd; // >0 in front
                            // Only TIGHT pressure (<26px) disrupts control —
                            // a defender 3-4m off lets you take it cleanly.
                            // The curve is steep so only true front-to-front
                            // (a stride away, goal-side) really bites.
                            double prox = clamp((26.0 - od) / 26.0, 0.0, 1.0);
                            frontPress = prox * (goalSide > 0.0 ? 1.0 : goalSide > -14.0 ? 0.45
                                                                                         : 0.1);
                        }
                    }
                    // A second tight marker adds pressure regardless of side —
                    // a sandwiched receiver rarely controls a driven ball.
                    if (tightMarkers >= 2) frontPress = std::max(frontPress, 0.55);
                    if (nearOppD >= 42.0) {
                        collectBall(*intended);
                        return true;
                    }
                    // Control degrades with pace and, heavily, with front
                    // pressure. A striker fronted tight by a CB usually CAN'T
                    // just take it cleanly — he has to shield, lay off, or
                    // loses it. The base is deliberately modest so tight front
                    // pressure can pull it well down.
                    double trapChance = clamp(0.50 + attrFactor(intended->attrs.positioning) * 0.28 + attrFactor(intended->attrs.passing) * 0.12 - clamp((bs - 95.0) / 360.0, 0.0, 0.20) - frontPress * 0.85, 0.10, 0.92);
                    if (rng.random() < trapChance) {
                        stats.recordPressuredReception(false);
                        collectBall(*intended);
                        return true;
                    }
                    stats.recordPressuredReception(true);
                    b.intendedReceiverId = -1;
                    receiverShieldTargetId = -1;
                    blockReboundFor(intended->id, 150);
                }
            }
        }
    }
    return false;
}

// Resolve the actual ball-vs-player contact this tick: intended-receiver trap,
// the nearest-contact pick, and the collect/collision/deflection outcome. The
// swept-path setup lives here because only this phase uses prevX/prevY + radii.
// Find the player (if any) whose body the ball contacts this tick — swept-path for
// fast balls, point test for slow. Sets contactRadius (for the caller's post-
// collision ball placement); returns nullptr if nothing is in contact.
Player* GameEngine::findBallContact(double sec, double& contactRadius) {
    auto& b = state.ball;
    double bs = std::hypot(b.vx, b.vy);
    const double collectRadius = COLLECT_DIST;
    const double fastContactRadius = PLAYER_R + BALL_R - 3.0;
    // Swept-contact origin (user feedback #2 "the ball just travels through the player"): a FAST loose
    // ball moves up to ~15px/tick (bs~900px/s × FIXED_DT) against a ~13.5px contact radius, so a single
    // end-of-tick POINT test lets it skip PAST a player between ticks (the closest approach falls mid-tick).
    // For fast balls we test each player against the ball's PATH this tick (prev→cur), not just the
    // endpoint; slow balls keep the point test (byte-identical). prev = undo the step applyBallPhysics
    // just applied (b.x += b.vx*sec). Live shots stay protected by the shot-in-flight gate below.
    double prevX = b.x - b.vx * sec, prevY = b.y - b.vy * sec;
    // Shared incidental-ricochet geometry: surface the ball on the body, reflect
    // the into-body velocity component, damp, and stamp the restart-attribution
    // memory (lastRicochetTeam — never possession/offside; see engine.h).
    auto ricochetOffBody = [&](Player& p, double damp) {
        double nx = b.x - p.x, ny = b.y - p.y, nd = std::hypot(nx, ny);
        if (nd < 1e-6) {
            nx = -b.vx / bs;
            ny = -b.vy / bs;
            nd = 1.0;
        }
        nx /= nd;
        ny /= nd;
        b.x = p.x + nx * (PLAYER_R + BALL_R);
        b.y = p.y + ny * (PLAYER_R + BALL_R);
        double dot = b.vx * nx + b.vy * ny;
        if (dot < 0) {
            b.vx -= COLLISION_REFLECT_FACTOR * dot * nx;
            b.vy -= COLLISION_REFLECT_FACTOR * dot * ny;
        }
        lastRicochetTeam = p.team;
        lastRicochetMs = state.clockMs;
        b.vx *= damp;
        b.vy *= damp;
        // A body clips the loft too (seed 437 1:04: a charged-down cross kept
        // its full vz through THIS path and floated up 6m — the round-16 fix
        // damped vz only in the resolveBallContact block-path). Same
        // restitution on the vertical, and never exit steeper than the
        // surviving horizontal allows.
        b.vz *= damp;
        capSteepness(b, 1.2);
        recordBallImpulse();
    };
    Player* contact = nullptr;
    contactRadius = collectRadius;
    double bestContactScore = 1e9;
    bool intendedNearby = false;
    if (pendingPass.active && b.intendedReceiverId >= 0) {
        if (Player* intended = playerById(b.intendedReceiverId)) {
            // Only while the ball is still COMING to him: once a pass has
            // overshot the intended receiver and is rolling away, a teammate
            // must be allowed to rescue it — the old unconditional skip had a
            // winger escort his own team's overrun pass at 10px for two full
            // seconds, barred from touching it, straight into an opponent's
            // interception (watched replay seed 133 1:06).
            bool approaching = (intended->x - b.x) * b.vx + (intended->y - b.y) * b.vy > 0.0;
            intendedNearby = approaching && dist(intended->x, intended->y, b.x, b.y) < INTENDED_NEARBY_DIST;
        }
    }

    for (auto& p : state.players) {
        if (!canContestBall(p)) {
            // ── Ghost-body fix (user-reported: "ball passes through a player") ──
            // A contest lockout (beaten defender 600-950ms, tackle loser, recent
            // passer 450-900ms, whiffed reaction duel 360ms) made the player's
            // whole BODY a ghost: trace analysis measured ~900 opponent + ~800
            // recent-toucher frame-hits per match where a grounded ball rolled
            // DEAD-CENTER (<8px) through a body with velocity unchanged. A locked
            // player can't WIN the ball, but he still has legs — a true center
            // hit ricochets off him (grazes at 10.5-13.5px still pass by, matching
            // the whiff branch's "passes clean" intent for near-misses; the band
            // was <8 but fast balls threading 9-11px through a body still read
            // as passing through a leg on replay). The
            // ricochet is incidental: lastTouch is NOT updated (no possession /
            // offside / restart-attribution side effects), no new lockouts.
            // Exempt: GK (own handling paths), sent-off (parked off-pitch), armed
            // set-pieces (everyone is contest-blocked while the ball is placed),
            // aerial balls. Live shots USED to be exempt too ("the blocker rule
            // owns those") — but that made locked bodies fully transparent to
            // shots (seed 173 0:54: Bale's strike ran 7.2px THROUGH Marcelo and
            // out, no corner). A dead-center shot hit deflects like any other;
            // the blocker rule only governs DELIBERATE ball-winning.
            if (p.role != Role::GK && !p.sentOff && !setPiece.armed && b.controllerId < 0 && b.z < 15.0 && bs > 30.0) {
                double sx = b.x - prevX, sy = b.y - prevY, seg2 = sx * sx + sy * sy;
                double tg = seg2 > 1e-6 ? clamp(((p.x - prevX) * sx + (p.y - prevY) * sy) / seg2, 0.0, 1.0) : 0.0;
                double dg = dist(p.x, p.y, prevX + sx * tg, prevY + sy * tg);
                double toward = (p.x - b.x) * b.vx + (p.y - b.y) * b.vy;
                if (dg < 10.5 && toward > 0.0)
                    ricochetOffBody(p, 0.72);   // a leggy, messy ricochet, not a clean block
            }
            continue;
        }
        // Fast ball → swept distance (closest approach of the player to the prev→cur path);
        // slow ball → the original endpoint test (byte-identical, no tunnelling at low speed).
        double d;
        if (bs > COLLISION_FAST_CONTACT) {
            double sx = b.x - prevX, sy = b.y - prevY, seg2 = sx * sx + sy * sy;
            double t = seg2 > 1e-6 ? clamp(((p.x - prevX) * sx + (p.y - prevY) * sy) / seg2, 0.0, 1.0) : 0.0;
            d = dist(p.x, p.y, prevX + sx * t, prevY + sy * t);
        } else
            d = dist(p.x, p.y, b.x, b.y);
        // A live shot is only touchable by its pre-rolled blocker — everyone
        // else lost their one deliberate chance at launch. Keyed on the loose
        // origin (not shot.active, which the GK assessment clears at 250px).
        // Exception: defenders ASSIGNED to the shot lane are the designated
        // wall — deliberate positioning earns physical contact; bystanders
        // still can't eat shots.
        bool shotInFlight = lastLooseOrigin == LooseOrigin::Shot && bs > 95.0;
        bool designatedWall = false;
        if (shotInFlight && p.id != shot.blockerId && p.team != shot.team && p.role != Role::GK) {
            const auto* task = assignmentFor(p.id);
            designatedWall = task && task->role == DefensiveTask::ShotLane;
        }
        if (shotInFlight && p.role != Role::GK && p.id != shot.blockerId && !designatedWall) {
            // Bystanders can't deliberately EAT a live shot — but a TRUE center
            // hit (<8px; d is already swept at shot speed) is physical contact:
            // the ball strikes the body and deflects, and the ricochet memory
            // awards the restart (seed 173 0:54: the shot off Marcelo that ran
            // behind must be a corner, not a goal kick). Grazes still pass by.
            if (d < 8.0 && b.z < AERIAL_HEIGHT)
                ricochetOffBody(p, 0.80);   // a deflection keeps more pace than a leggy loose-ball ricochet
            continue;
        }
        // A same-team CHASER who is NOT the intended receiver contests a live
        // overrun exactly like an opponent — give him the fast-contact reach
        // too. The team-asymmetric radius let a 12.9px near-miss on an 82px/s
        // ball thread the 8-13.5px band only the OPPONENT was allowed to use,
        // and the opponent cut it out (seed 111 1:39: 7R "should have got
        // there... ball drifted past him").
        double r = (bs > COLLISION_FAST_CONTACT
                    && (p.team != b.lastTouchTeam || p.id != b.intendedReceiverId))
                   ? fastContactRadius : collectRadius;
        // Micro audit #4: a fast FRIENDLY ball dead-center through a teammate's
        // body tunneled straight through (24 times/5min) — the fast-contact
        // radius was opponents-only, and the ghost-body ricochet covers only
        // contest-locked players. A true center hit (<8px) on a teammate who
        // is NOT the intended receiver connects like any body would.
        if (bs > COLLISION_FAST_CONTACT && p.team == b.lastTouchTeam
            && p.id != b.intendedReceiverId && d < 8.0)
            r = std::max(r, 8.0);
        // A dead ball is collectible from a stride away — opponent separation
        // (24px) parked two players 10-12px from it, just outside the 8px
        // radius, in a 2.8s Mexican standoff ~43 times a match.
        if (bs < 30.0) r = std::max(r, COLLECT_DIST + 6.0);
        // The chosen blocker / wall gets the FULL block reach (leg+body across the
        // lane), matching the block-roll radius — otherwise a defender selected to
        // block at perp 14-27px never connects (fastContactRadius is only 13.5px),
        // which is why shotsBlocked sat at 0.
        if (shotInFlight && (p.id == shot.blockerId || designatedWall)) r = PLAYER_R + BALL_R + 11.0;
        if (d > r) continue;
        // Cross contact uses the same z-aware slant reach as tryIntendedReceiverMeet:
        // you can only head what your leap actually reaches. The old flat z<=64 gate
        // let a flat-footed CB "head" a dropping cross from 3.8m up — rendered with
        // the ball's z-lift, the contact appears a body-length from his dot, between
        // other players (watched replay seed 133 0:28, the ghost header).
        if (pendingPass.active && pendingPass.isCross) {
            double dzc = std::max(0.0, b.z - HEADER_REACH_Z);
            if (std::sqrt(d * d + dzc * dzc) > std::max(r, MEET_REACH_HEAD)) continue;
        } else if (pendingPass.active && pendingPass.isLofted
                   && b.z >= HEADER_MIN_HEIGHT && b.z <= HEADER_MAX_HEIGHT) {
            // Round-31 — THE AERIAL LONG BALL. This `else if` used to be a bare
            // `b.z > AERIAL_HEIGHT -> continue`, i.e. NOBODY except the intended
            // receiver could touch any non-cross ball above 2m. That one line is
            // why 97.9% of open-play 30m+ balls were collected at z=0, and why
            // the simulation contained no aerial duel and no second-ball phase
            // at all: the engine already LOFTS long balls (the rawDist>240 and
            // >350 vz rules in engine_pass_exec.cpp), they simply sailed over everyone
            // untouchable and were picked up off the deck.
            // A genuine lofted long ball is now contestable in the air by the
            // same z-aware slant reach a cross uses — you can only head what
            // your leap actually reaches. Distance-gated by construction
            // (AERIAL_LONG_BALL_DIST), so short/medium passing is untouched.
            double dzc = std::max(0.0, b.z - HEADER_REACH_Z);
            if (std::sqrt(d * d + dzc * dzc) > std::max(r, MEET_REACH_HEAD)) continue;
        } else if (b.z > AERIAL_HEIGHT) continue;
        if (p.role == Role::GK) {
            continue;
        }
        // Intended receiver already handled above — skip them here
        if (p.id == b.intendedReceiverId) continue;
        if (pendingPass.active && intendedNearby && p.team == pendingPass.team && bs < INTENDED_PASS_SPEED_LIMIT) continue;
        double score = d / std::max(1.0, r);
        // Round-24: the flat 50/50 loose-ball edge to the defending team (0.10)
        // is half the interception/turnover story — every contested loose ball
        // tilted to the opponent. Halve it 0.10->0.05 so a marginal 50/50 is
        // genuinely even and the attacking side keeps its fair share.
        if (p.team != b.lastTouchTeam) score -= 0.05;
        if (score < bestContactScore) {
            bestContactScore = score;
            contact = &p;
            contactRadius = r;
        }
    }

    return contact;
}

void GameEngine::resolveBallContact(double sec) {
    auto& b = state.ball;
    double bs = std::hypot(b.vx, b.vy);
    double contactRadius = COLLECT_DIST;
    Player* contact = findBallContact(sec, contactRadius);
    if (!contact) return;
    if (pendingPass.active && pendingPass.isCross && b.z >= HEADER_MIN_HEIGHT && b.z <= HEADER_MAX_HEIGHT) {
        // Cutting out a whipped delivery is a duel, not a given — the old
        // unconditional collect meant the first body on the flight line ate
        // every driven cross. A whiff locks the defender out so it flies past.
        if (contact->team != pendingPass.team && bs > CROSS_CUTOUT_MIN_SPEED) {
            // Round-31: the arming bar was a flat 300px/s. A CORNER arrives at
            // ~250, so no corner delivery was ever a duel — the first defender
            // on the flight line collected it deterministically and corner
            // conversion fell to ~0%. Arm at any genuine delivery pace, and
            // anchor the pace penalty at CROSS_CUTOUT_PACE_REF clamped at zero
            // below it, so a slower ball no longer earns a cut-out BONUS.
            double cutChance = clamp(CROSS_CUTOUT_BASE + attrFactor(contact->attrs.positioning) * CROSS_CUTOUT_SKILL
                                     - std::max(0.0, bs - CROSS_CUTOUT_PACE_REF) / 700.0, 0.08, 0.58);
            if (rng.random() >= cutChance) {
                blockReboundFor(contact->id, 420);
                return;
            }
        }
        // A defender cutting out a cross near his own line often puts it BEHIND for a
        // corner rather than controlling it cleanly — the dominant real corner source.
        // With 250+ crosses/match this is the main lever toward a realistic count
        // (engine sat at ~2 vs ~10 because every cut was a clean collect).
        if (contact->team != pendingPass.team) {
            double ownLineX = ownGoalXFor(contact->team);
            // A cut only becomes a corner if the ball is genuinely going BEHIND —
            // heading toward the defender's GOAL line and crossing it in bounds. An
            // overhit cross drifting off the pitch over the TOUCHLINE by the corner
            // flag is a throw-in, not the crossing team's corner (watched replay
            // seed 105 1:46: 11R's cross ran out over the top touchline at the flag
            // — moving AWAY from the goal line in x, out over y=0 — yet a red corner
            // was awarded, a "ghost corner"). Project the flight to the goal line:
            // require it to be heading there and to cross between the touchlines.
            double toLine = ownLineX - b.x;                 // signed distance to that goal line
            bool headingBehind = toLine * b.vx > 0.0;       // moving toward it, not away
            double tLine = std::abs(b.vx) > 1.0 ? toLine / b.vx : 1e9;   // time to reach the line
            double yAtLine = b.y + b.vy * tLine;            // y where it would cross the goal line
            // He only clears a cross BEHIND for a corner when it is a genuinely
            // DANGEROUS delivery dropping into the goalmouth — not one projected to
            // cross WIDE of the posts (that is sailing out for a goal kick off the
            // attacker; a defender near it did not "concede a corner"). Instrumented
            // seed 105 1:46: the cross crossed the away line ~70px wide of the near
            // post, yet a red corner was manufactured off a body it merely passed.
            bool dangerousCross = tLine > 0.0 && std::abs(yAtLine - PITCH_H / 2.0) < GOAL_W / 2.0 + 55.0;
            // And he must be GOAL-SIDE of the ball (between it and his own line) to
            // put it behind — a defender level with or behind the ball can't cut it out.
            bool defenderGoalSide = std::abs(contact->x - ownLineX) <= std::abs(b.x - ownLineX) + BALL_R;
            if (std::abs(b.x - ownLineX) < 175.0 && headingBehind && dangerousCross && defenderGoalSide && rng.random() < 0.55) { // corners 2.7->6.5: dominant source. VOLUME is capped by the cut-near-line rate, not this probability.
                // Physically DEFLECT it behind — never award instantly. The instant
                // awardCorner here TELEPORTED a live ball out of the box to the flag
                // (watched replay seed 103 0:30: a corner's own cross was cut at
                // (957,279) and the ball snapped to (1044,674) one tick later,
                // because the taker still stood at the flag so the glide was
                // skipped). Give the defender a real scuffed touch: kill most of
                // the incoming pace, send it toward his own goal line angled away
                // from the mouth, with a bit of lift. checkOutOfPlay then awards
                // the corner when the ball ACTUALLY crosses, glide and all — and
                // if the scuff drifts out by the flag for a throw-in instead,
                // that's football.
                double lineDir = (ownLineX == 0.0) ? -1.0 : 1.0;
                double sideDir = b.y < PITCH_H / 2.0 ? -1.0 : 1.0;
                // Speed scales with distance to the line so the deflection genuinely
                // crosses despite airborne drag (an under-hit one stalled in-field —
                // corners collapsed 4.3 -> 3.0/30min on the first cut of this fix).
                double defl = std::max(clamp(bs * 0.45, 150.0, 260.0),
                                       std::abs(ownLineX - b.x) / 0.55);
                b.vx = lineDir * defl;
                b.vy = sideDir * defl * (0.35 + rng.random() * 0.40);
                b.vz = 60.0 + rng.random() * 90.0;
                b.z = std::max(b.z, 1.0);
                b.lastTouchTeam = contact->team;
                b.lastToucherId = contact->id; lastRicochetMs = -1e9;   // genuine touch supersedes ricochet restart memory
                pendingPass.active = false;
                blockReboundFor(contact->id, 500);
                return;
            }
        }
        collectBall(*contact);
        return;
    }
    if (bs < COLLISION_SPEED_THRESH) {
        collectBall(*contact);
        return;
    }
    if (bs > COLLISION_SPEED_THRESH) {
        double dx = b.x - contact->x, dy = b.y - contact->y, d2 = std::hypot(dx, dy);
        if (d2 < 1) return;
        double nx = dx / d2, ny = dy / d2;
        double dot = b.vx * nx + b.vy * ny;
        // A ball moving AWAY from the player isn't a touch: phantom grazes
        // applied damp, flipped last-touch, and rebound-blocked bystanders
        // (600ms, re-applied per tick) just for standing near a pass lane.
        if (dot >= 0) return;
        // A fast loose ball driven AT an opponent's body is a reaction duel,
        // not a given: the chance to get a touch in falls off hard with pace —
        // a ~24m/s ball is blockable, a rocket usually flies past. Same-team
        // balls (a shin deflection off a teammate) always make contact. A
        // whiffed read locks the bystander out (no per-tick re-roll) so it
        // passes clean instead of being eaten frame-by-frame.
        if (contact->team != b.lastTouchTeam) {
            double blockChance = clamp(LOOSE_BLOCK_BASE + attrFactor(contact->attrs.positioning) * LOOSE_BLOCK_SKILL - (bs - COLLISION_SPEED_THRESH) / LOOSE_BLOCK_SPEED_FALLOFF, 0.06, 0.92);
            if (rng.random() >= blockChance) {
                blockReboundFor(contact->id, 360);
                return;
            }
        }
        b.x = contact->x + nx * contactRadius;
        b.y = contact->y + ny * contactRadius;
        b.vx -= COLLISION_REFLECT_FACTOR * dot * nx;
        b.vy -= COLLISION_REFLECT_FACTOR * dot * ny;
        double damp = (b.lastTouchTeam == contact->team) ? COLLISION_DAMP_SAME_TEAM : COLLISION_DAMP_OPPONENT;
        b.vx *= damp;
        b.vy *= damp;
        // A block that kills the horizontal must kill the vertical too — a
        // charged-down whipped cross (H 300->136) kept its full vz=280 and
        // rocketed up at 64 degrees (seed 305 1:20, "ball just wobbled up").
        // Damp vz with the pace, and never leave a deflection steeper than
        // its surviving horizontal allows.
        b.vz *= damp;
        capSteepness(b, 1.2);
        double glance = (b.lastTouchTeam == contact->team) ? COLLISION_GLANCE_SAME : COLLISION_GLANCE_OPPONENT;
        b.vx += ny * bs * glance;
        b.vy += -nx * bs * glance;
        b.lastTouchTeam = contact->team;
        b.lastToucherId = contact->id; lastRicochetMs = -1e9;   // genuine touch supersedes ricochet restart memory
        if (contact->team == lastCollectionTeam) lastSameTeamCollectionMs = state.clockMs - 500;
        blockReboundFor(contact->id, 600);
        bool wallBlock = false;
        if (lastLooseOrigin == LooseOrigin::Shot && contact->id != shot.blockerId && contact->team != shot.team) {
            const auto* task = assignmentFor(contact->id);
            wallBlock = task && task->role == DefensiveTask::ShotLane;
        }
        if (lastLooseOrigin == LooseOrigin::Shot && (contact->id == shot.blockerId || wallBlock)) {
            // Handball (Law 12): a defender blocking INSIDE HIS OWN BOX sometimes stops it with an
            // arm -> penalty. Gated low (~1 per several matches), in-box only, a simple probabilistic
            // model (not full arm-geometry). Adds penalty VARIETY alongside the tackle-fouls.
            double hbLine = ownGoalXFor(contact->team);
            bool hbInBox = std::abs(b.x - hbLine) < PENALTY_AREA_W && std::abs(b.y - PITCH_H / 2.0) < PENALTY_AREA_H / 2.0;
            if (hbInBox && rng.random() < 0.040) {
                shot.active = false;
                shot.tracked = false;
                lastLooseOrigin = LooseOrigin::ShotBlock;
                stats.recordPenaltyAwarded();
                emitEvent("handball", contact->x, contact->y, contact->id, shot.shooterId);
                awardSetPiece(SetPiece::Penalty, shot.team);
            } else if (!hbInBox && rng.random() < 0.022) {
                // Law 12 completeness: the OUT-of-box block handball — a direct
                // free kick from the contact spot (rarer than the box variant:
                // arms come down naturally outside the area).
                shot.active = false;
                shot.tracked = false;
                lastLooseOrigin = LooseOrigin::ShotBlock;
                emitEvent("handball", contact->x, contact->y, contact->id, shot.shooterId);
                awardSetPiece(SetPiece::FreeKick, shot.team);
            } else {
                stats.recordShotBlocked();
                emitEvent("block", contact->x, contact->y, contact->id, shot.shooterId);
                shot.active = false;
                shot.tracked = false;
                lastLooseOrigin = LooseOrigin::ShotBlock;
                // A block close to the defender's own line that deflects goalward
                // often loops behind for a corner — another corner source the
                // engine never produced. COMMIT the deflection physically (no
                // instant award — that teleported live balls; see the cross-cut
                // deflection above): steepen the outbound component and lift it a
                // touch so the already-deflected ball genuinely carries behind,
                // then checkOutOfPlay awards the corner when it crosses.
                double ownLine = ownGoalXFor(contact->team);
                bool nearLine = std::abs(b.x - ownLine) < 150.0;
                bool deflectingBehind = (ownLine == 0.0) ? b.vx < 0 : b.vx > 0;
                if (nearLine && deflectingBehind && rng.random() < 0.80) { // corner boost (was 0.65)
                    double lineDir = (ownLine == 0.0) ? -1.0 : 1.0;
                    double bs2 = std::hypot(b.vx, b.vy);
                    b.vx = lineDir * std::max(std::abs(b.vx), std::max(bs2, 140.0) * 0.75);
                    b.vz = std::max(b.vz, 40.0 + rng.random() * 80.0);
                    b.z = std::max(b.z, 1.0);
                }
            }
        }
    }
}

void GameEngine::checkBallPlayerCollision(double sec) {
    auto& b = state.ball;
    double bs = std::hypot(b.vx, b.vy);

    // Phase 1 — first-time finish (cutback/low cross swept in by a box runner).
    if (tryCutbackFirstTimeFinish(bs)) return;

    // Phase 2 — keeper gathers a beaten-but-reachable loose shot in his area.
    if (tryKeeperLooseGather(bs)) return;

    if (tryIntendedReceiverMeet(bs)) return;

    if (tryKeeperCrossClaim()) return;
    // Phase 5 — resolve the actual ball/player contact.
    resolveBallContact(sec);
}
