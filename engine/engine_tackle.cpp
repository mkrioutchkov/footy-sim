// engine_tackle.cpp — the tackle contest and what it leaves behind
//
// Split out of engine_actions.cpp. attemptTackle is the committed/contain
// decision and the contest roll; resolveTackleFoul the Law-12 outcome; and
// noteRegain the round-36 post-regain securing cache that steers the winner's
// first touch away from the man he just beat.
#include "engine.h"
#include "agent.h"
#include "agent_helpers.h"
#include <cmath>
#include <numbers>
#include <cstdio>

// Resolve a committed tackle that missed the ball (rng >= chance): foul odds,
// cards, injury, advantage, and the free-kick/penalty award. Mutates match state;
// on advantage it returns early (play waved on).
void GameEngine::resolveTackleFoul(Player& tackler, Player& carrier, bool fromBehind, bool cynical, double boxFoulScale) {
    auto& b = state.ball;
        // Per-failure foul odds must be low because duel volume is high —
        double foulChance = (fromBehind ? TACKLE_FOUL_FROM_BEHIND : TACKLE_FOUL_NORMAL) * boxFoulScale * (1.0 + directiveBias[tackler.id].tackleAggression * 0.35) // tackle_hard: more reckless
                            * (1.0 - directiveBias[tackler.id].stayOnFeet * 0.45)                                                                                  // stay_on_feet: cleaner
                            * (1.0 + (1.0 - staminaFrac(tackler.stamina)) * 0.6);                                                                                  // tired legs mistime the tackle (+60% at empty; no-op fresh)
        // A deliberate cynical foul IS the foul — he means to bring the man down.
        if (cynical) foulChance = CYNICAL_FOUL_PROB;
        // A booked player plays it safe — fewer reckless AND cynical fouls, so second
        // yellows (and the resulting reds) drop toward real rates. A booked last man
        // knows a second foul = off, so he's far more careful even when tempted to
        // cynically pull the man down. (SysArch 2026-06-30: reds measured ~0.60/match
        // ≈ 2.4× real ~0.25 — the booked-CYNICAL path was bypassing this damping.)
        if (runtime[tackler.id].yellowCards >= 1) foulChance *= 0.38; // booked → VERY careful (now incl. cynical: trims second-yellow reds)
        // Round-30 (arena audit D5): the booking above is the ONLY brake on a
        // repeat offender, and arenaMode disables both the send-off and the
        // second yellow. In a 1v1 both outfielders are booked within minutes,
        // after which nothing escalates however often they foul — fouls measured
        // 102/90 against an 11v11's 18. Real small-sided football answers this
        // with a sin bin; the mode cannot afford to remove a man from a two-man
        // team, so instead the referee's patience visibly runs out: every FURTHER
        // foul by the same player makes his next challenge more cautious still.
        // Arena-gated, and it draws no rng, so 11v11 is untouched.
        if (arenaMode && runtime[tackler.id].arenaFouls > 0)
            foulChance *= std::pow(0.70, std::min(runtime[tackler.id].arenaFouls, 5));
        if (rng.random() < foulChance) {
            if (tackler.id >= 0 && tackler.id < 22) runtime[tackler.id].arenaFouls++;
            stats.recordTackleFoul();
            if (cynical) stats.recordTacticalFoul();
            double foulX = carrier.x;
            double foulY = carrier.y;
            emitEvent("foul", foulX, foulY, tackler.id, carrier.id);
            // Bookings: reckless (from-behind) fouls risk a card. A second
            // yellow — or a straight red for a wild challenge — sends him off.
            // Tuned for ~3-4 yellows and ~0.25 reds per match (real-world).
            // Card-per-foul was ~32% (≈2× real ~17%): a foul fired a card far too
            // often, so raising fouls toward real exploded yellows/reds. Lowered to
            // calibrate cards to the higher foul volume (cynical fouls stay bookable).
            double cardChance = cynical ? CYNICAL_CARD : (fromBehind ? 0.42 : 0.13); // recalibrated after DOGSO: cynical-yellow volume became (rare) reds; fouls sit at ~21.5/90 (real band), card-per-foul was ~10% vs real ~17%
            // A booked player's borderline SECOND foul: a real ref usually warns
            // rather than firing the automatic second yellow. Second-yellow reds were
            // measured ~0.62/match (≈2.5× real ~0.25), piled up in chippy high-yellow
            // games — trimming the average never tamed that tail; this does. (A cynical
            // second foul stays bookable — he meant it.)
            if (runtime[tackler.id].yellowCards >= 1 && !cynical) cardChance *= 0.45;
            // Law 12 DOGSO (audit HIGH): the cynical trigger IS textbook
            // denial-of-goal-scoring-opportunity outside the box (last man, no
            // cover, unwinnable challenge) — a straight red, not the 55% SPA
            // yellow it rolled (45% walked away cardless). Small ref-error
            // residual keeps it human.
            bool straightRed = (cynical && rng.random() < 0.92)
                || (fromBehind && rng.random() < 0.0032); // non-DOGSO wild lunges stay rare
            // Round-21 (arena 1v1): no ejection and no escalation to red — the
            // duel must never collapse to GK-vs-attacker. The card ESCALATION,
            // not just sendOff(), fires here, so the "red" event and the
            // second-yellow send-off are both suppressed at this site. The rng
            // draws above stay (straightRed is zeroed AFTER them) so the
            // deterministic stream — and 11v11 — is byte-identical.
            if (arenaMode) straightRed = false;
            if (straightRed || rng.random() < cardChance) {
                // ^ the rng.random() < cardChance draw still fires in arena
                //   (straightRed is always false there), so the stream is intact.
                // Round-21 (arena audit): with no send-off in the duel, a booked
                // player used to keep collecting 4-5 meaningless yellows. Book him
                // ONCE — suppress the second+ yellow record/emit. yellowCards>=1 is
                // the threshold for both the foulChance and cardChance damping, so
                // holding the count at 1 rather than incrementing changes no draw.
                bool arenaAlreadyBooked = arenaMode && runtime[tackler.id].yellowCards >= 1;
                if (!straightRed && !arenaAlreadyBooked) {
                    runtime[tackler.id].yellowCards++;
                    stats.recordYellowCard();
                    emitEvent("yellow", foulX, foulY, tackler.id, carrier.id);
                }
                if ((straightRed || runtime[tackler.id].yellowCards >= 2) && !arenaMode) {
                    sendOff(tackler);
                    emitEvent("red", foulX, foulY, tackler.id, carrier.id);
                }
            }
            // A hard (from-behind) foul can leave the fouled player hurt — a
            // knock that scales down his pace until it fades, and makes him a
            // substitution candidate.
            // Injuries ran ~1.8/match (real ~0.3-0.6); trimmed to land mid-band ~0.4.
            double injChance = fromBehind ? 0.030 : 0.009;
            if (rng.random() < injChance) {
                carrier.injurySeverity = std::max(carrier.injurySeverity, 0.30 + rng.random() * 0.45);
                // Round-30: latch it. injurySeverity decays at 1/90 per second,
                // so the manager had ~11s to spot a 0.30 knock at an 8s cadence
                // that also needed a stoppage to land in — he never did.
                carrier.needsReplacement = true;
                stats.recordInjury();
                emitEvent("injury", carrier.x, carrier.y, carrier.id);
            }
            // Advantage: if the fouled team is going forward in open play and
            // the carrier kept his feet, wave play on — the foul and any card
            // still count (shown now; banked till the next stoppage in reality).
            double attFd = fdFor(carrier.team);
            bool inAttackingHalf = attFd > 0 ? carrier.x > HALF_X : carrier.x < HALF_X;
            double defGoalX0 = ownGoalXFor(tackler.team);
            bool nearOppBox = std::abs(carrier.x - defGoalX0) < PENALTY_AREA_W * 1.4;
            if (inAttackingHalf && !nearOppBox && carrier.injurySeverity < 0.18 && rng.random() < 0.35) {
                emitEvent("advantage", foulX, foulY, carrier.id, tackler.id);
                advantage = {true, carrier.team, foulX, foulY, state.clockMs}; // recall if it fizzles
                blockReboundFor(tackler.id, 500);                              // fouler can't re-lunge instantly
                return;                                                  // carrier plays on
            }
            b.vx = b.vy = b.z = b.vz = 0;
            b.controllerId = -1;
            b.intendedReceiverId = -1;
            b.lastTouchTeam = carrier.team;
            b.lastToucherId = carrier.id; lastRicochetMs = -1e9;   // genuine touch supersedes ricochet restart memory
            lastLooseOrigin = LooseOrigin::None;
            blockReboundFor(tackler.id, 900);   // Round-37: 650->900 — a beaten lunge can't instantly re-stab (tackle-volume diet)
            double defendingGoalX = ownGoalXFor(tackler.team);
            double defendingFd = fdFor(tackler.team);
            bool foulInBox = std::abs(foulX - defendingGoalX) < PENALTY_AREA_W && std::abs(foulY - PITCH_H / 2.0) < PENALTY_AREA_H / 2.0;
            if (foulInBox) {
                b.x = defendingGoalX + defendingFd * PENALTY_SPOT_FROM_GOAL;
                b.y = PITCH_H / 2.0;
                stats.recordPenaltyAwarded();
                emitEvent("penalty", b.x, b.y, carrier.id);
                awardSetPiece(SetPiece::Penalty, carrier.team);
                setPiece.reason = "penalty";
            } else {
                b.x = clamp(foulX, 20.0, PITCH_W - 20.0);
                b.y = clamp(foulY, 20.0, PITCH_H - 20.0);
                awardSetPiece(SetPiece::FreeKick, carrier.team);
            }
            setPiece.spotX = b.x;
            setPiece.spotY = b.y;
        } else {
            blockReboundFor(tackler.id, 900);   // Round-37: 650->900 — same diet for a clean miss
        }
}

// Round-36 — POST-REGAIN SECURING (owner, seed 407 0:26: "7B makes good tackle,
// why turn into traffic?"). Cache ONE fixed direction for the winner's gather:
// away from the man he beat, blended with away from the local opponent knot (the
// beaten man is rarely alone — in the watched moment it was the SECOND opponent
// who took it straight back). Cached, not re-derived per tick: a rotating settle
// target makes the carrier orbit it and pirouette at the turn cap.
void GameEngine::noteRegain(const Player& w, int beatenId, double windowMs) {
    // Arena is a duel/tuning harness with its own frozen invariants — the
    // securing settle is deliberately inert there (asserted byte-identical at
    // N=1,3,5,7,9).
    if (arenaMode) return;
    if (w.id < 0 || w.id >= 22 || w.role == Role::GK) return;
    double dx = 0.0, dy = 0.0;
    const Player* beaten = beatenId >= 0 ? playerById(beatenId) : nullptr;
    if (beaten && beaten->team != w.team) {
        double ax = w.x - beaten->x, ay = w.y - beaten->y, ad = std::hypot(ax, ay);
        if (ad > 1.0) { dx = ax / ad; dy = ay / ad; }
    }
    double cx = 0.0, cy = 0.0;
    int n = 0;
    for (const auto& o : state.players) {
        if (!isActiveOpponent(o, w.team)) continue;
        if (dist(w.x, w.y, o.x, o.y) > 90.0) continue;
        cx += o.x; cy += o.y; n++;
    }
    if (n > 0) {
        double ox = w.x - cx / n, oy = w.y - cy / n, od = std::hypot(ox, oy);
        if (od > 1.0) { dx += 0.6 * ox / od; dy += 0.6 * oy / od; }
    }
    double d = std::hypot(dx, dy);
    if (d < 1e-6) { dx = fdFor(w.team); dy = 0.0; d = 1.0; }   // nobody to turn from: face the way you attack
    dx /= d; dy /= d;
    // Touchline/byline guard — securing INTO the paint is not securing.
    if      (w.y < DRIBBLE_EDGE_MARGIN          && dy < 0.0) dy = -dy;
    else if (w.y > PITCH_H - DRIBBLE_EDGE_MARGIN && dy > 0.0) dy = -dy;
    if      (w.x < DRIBBLE_EDGE_MARGIN          && dx < 0.0) dx = -dx;
    else if (w.x > PITCH_W - DRIBBLE_EDGE_MARGIN && dx > 0.0) dx = -dx;
    d = std::hypot(dx, dy);
    if (d < 1e-6) return;
    runtime[w.id].duel.secureDirX    = dx / d;
    runtime[w.id].duel.secureDirY    = dy / d;
    runtime[w.id].duel.secureUntilMs = state.clockMs + windowMs;
}

bool GameEngine::attemptTackle(Player& tackler, Player& carrier, double extraReach) {
    double contactDist = dist(tackler.x, tackler.y, carrier.x, carrier.y);
    auto& b = state.ball;
    if (setPiece.armed) return false;
    if (b.controllerId != carrier.id || tackler.team == carrier.team || contactDist > TACKLE_RANGE + extraReach) return false;
    if (carrier.role == Role::GK) return false;
    if (!canContestBall(tackler)) return false;
    if (isCarrierShielded(carrier.id)) return false;
    double tackleSkill = attrFactor(tackler.attrs.tackling);
    double carrierControl = attrFactor(carrier.attrs.positioning) * 0.35 + attrFactor(carrier.attrs.speed) * 0.15;
    double facingBonus = (tackler.team == Team::Home ? tackler.vx > 0 : tackler.vx < 0) ? 0.08 : -0.05;
    double carrierSpeed = std::hypot(carrier.vx, carrier.vy);
    double forwardX = carrierSpeed > 8 ? carrier.vx / carrierSpeed : fdFor(carrier.team);
    double forwardY = carrierSpeed > 8 ? carrier.vy / carrierSpeed : 0;
    double approachDot = contactDist > 0
                             ? ((tackler.x - carrier.x) * forwardX + (tackler.y - carrier.y) * forwardY) / contactDist
                             : 0;
    bool fromBehind = approachDot < -0.30;
    bool carrierShielded = isCarrierShielded(carrier.id) || isActiveShield(carrier.id);
    double dribbleBonus = carrier.dribbleType == 3 ? 0.10 : carrier.dribbleType == 1 ? -0.10
                                                                                     : 0;

    // Carrier facing vs tackler position: shielding detection
    double carrierFacingX = std::cos(carrier.facing);
    double carrierFacingY = std::sin(carrier.facing);
    double toTacklerX = contactDist > 0 ? (tackler.x - carrier.x) / contactDist : 0;
    double toTacklerY = contactDist > 0 ? (tackler.y - carrier.y) / contactDist : 0;
    double facingDot = carrierFacingX * toTacklerX + carrierFacingY * toTacklerY;
    double ballSideX = b.x - carrier.x;
    double ballSideY = b.y - carrier.y;
    double ballSideLen = std::hypot(ballSideX, ballSideY);
    double ballExposureDot = ballSideLen > 0.5
                                 ? (ballSideX / ballSideLen) * toTacklerX + (ballSideY / ballSideLen) * toTacklerY
                                 : facingDot;
    double tacklerFacingX = std::cos(tackler.facing);
    double tacklerFacingY = std::sin(tackler.facing);
    double tacklerFacingCarrierDot = contactDist > 0
                                         ? tacklerFacingX * (-toTacklerX) + tacklerFacingY * (-toTacklerY)
                                         : 0;
    bool tacklerSquaredUp = tacklerFacingCarrierDot > std::cos(50.0 * PI / 180.0);
    bool exposedToFacingTackler = ballExposureDot > 0.25 && tacklerSquaredUp;

    // Shielding vs exposure is the heart of a duel and was barely weighted.
    // Back turned, ball tucked away from the tackler → very hard to win.
    // Ball shown front-to-front → it should be there for the taking.
    double shieldingBonus = 0.0;
    if (ballExposureDot < -0.45)
        shieldingBonus = -0.30; // well shielded — the duel should read from the shielding (seed 133 1:20)
    else if (ballExposureDot < -0.10)
        shieldingBonus = -0.15; // mostly shielded
    else if (ballExposureDot > 0.45)
        shieldingBonus = 0.24; // ball exposed at him
    else if (ballExposureDot > 0.10)
        shieldingBonus = 0.12;                          // partly exposed
    if (exposedToFacingTackler) shieldingBonus += 0.10; // and he's squared up

    double chance = clamp(0.20 + tackleSkill * 0.38 - carrierControl * 0.15 + facingBonus - (carrierShielded ? 0.20 : 0) - (fromBehind ? 0.18 : 0) + (approachDot > 0.3 && approachDot < 0.85 ? 0.06 : 0) + dribbleBonus + shieldingBonus
                          - (contactDist > TACKLE_RANGE ? 0.08 : 0.0)                 // stretched step-in lunge is harder
                          - (tacklerFacingCarrierDot < -0.2 ? 0.22 : 0.0)             // back to the duel: he must turn first (round-14 geometry audit)
                          + (ballExposureDot > 0.55 && contactDist < TACKLE_RANGE ? 0.12 : 0.0), 0.06, 0.78);   // ball shown square, touch-tight: take it
    // Contain by default: a defender only COMMITS to a challenge when he has a
    // real chance of winning it (or it's an emergency, or the carrier has
    // stopped and exposed the ball). Otherwise he stays on his feet and
    // jockeys — the agent's containment keeps him goal-side. This converts the
    // flood of low-percentage lunges-and-misses (~70% of all challenges) into
    // the contain-first defending real players actually do, without a recorded
    // attempt or a wild swing.
    double carrierGoalDist = pitch::distToOwnGoal(carrier.x, tackler.team);
    bool inPenaltyBox = carrierGoalDist < PENALTY_AREA_W && pitch::lateralFromCenter(carrier.y) < PENALTY_AREA_H / 2.0;
    // Emergency lunges are forced only in the APPROACH band (box edge to
    // EMERGENCY_BOX_DIST) — NOT inside the box itself. A defender who dives in
    // the box gives a penalty; real defenders jockey and force the shot. Inside
    // the box he commits only to a genuinely winnable tackle (chance>=0.30) or
    // a clearly exposed loose touch. This was the engine's penalty factory:
    // forced low-% box lunges fouled ~2-3x/match (~10x real).
    bool boxEmergency = carrierGoalDist < EMERGENCY_BOX_DIST - directiveBias[tackler.id].stayOnFeet * 60.0 && !inPenaltyBox && pitch::lateralFromCenter(carrier.y) < PENALTY_AREA_H / 2.0;
    bool ballPushedAhead = carrier.dribbleType == 2 || carrier.dribbleType == 3;
    double commitBar = tackleCommitBar(tackler, carrier);
    // Deliberate (cynical) foul: the last man, genuinely beaten on a transition
    // break OUTSIDE the box, brings the carrier down to stop the counter. Pure
    // state (no rng); it forces commitment so the challenge reaches the existing
    // failed-tackle foul branch, where the foul/card thresholds are re-weighted.
    int goalSideCover = 0;
    for (auto& d : state.players)
        if (d.team == tackler.team && d.role != Role::GK && d.id != tackler.id && !d.sentOff && (d.x - carrier.x) * fdFor(tackler.team) < 0.0 // goal-side of the carrier
            && std::abs(d.y - carrier.y) < CYNICAL_LASTMAN_LATERAL) goalSideCover++;
    // The classic professional foul: a genuine last-man break (no cover goal-
    // side) with the carrier driving at me in the approach band, where I can't
    // win the ball. Not gated on the transition flag — a beaten last man is a
    // beaten last man whenever it happens (that gate made it fire ~0/match).
    // A beaten last man has the carrier breaking PAST him toward goal (not
    // driving into him — that's a winnable front challenge). Key off the
    // carrier's forward velocity toward our goal, not approachDot.
    double carrierToGoal = carrierSpeed > 8.0 ? forwardX * fdFor(carrier.team) : 0.0;
    bool cynical = !inPenaltyBox && carrierGoalDist > CYNICAL_BAND_NEAR && carrierGoalDist < CYNICAL_BAND_FAR && carrierToGoal > CYNICAL_FOUL_DRIVE                       // carrier breaking toward my goal
                   && carrierSpeed > 40.0                                                                                                                                 // a genuine sprint breakaway (was 18 — that fired ~3.5/90; DOGSO reds hit 3.3 vs real ~0.25)
                   && goalSideCover == 0                                                                                                                                  // I am the last man
                   && chance < commitBar                                                                                                                                  // the tackle is genuinely unwinnable
                   && state.ball.controllerId == carrier.id                                                                                                               // he's in control (a real break, not a loose 50/50)
                   && directiveBias[tackler.id].stayOnFeet < 0.5                                                                                                          // a stay_on_feet order suppresses it
                   && rng.random() < 0.30;                                                                                                                                // most pros do NOT pull him down — willingness, not certainty
    // Round-24: raise the exposure auto-commit thresholds (0.0->0.25, 0.40->0.55)
    // so a MARGINALLY shown ball stays a jockey rather than auto-committing a
    // tackle regardless of win chance. NOTE: measured inert on tackle VOLUME on
    // its own (the chance>=commitBar path above dominates commitment); the real
    // contain-first cut is the commitBar raise. Kept because it is directionally
    // correct and harmless — a faintly exposed ball is not worth a committed
    // lunge. The win-chance formula and round-19/20 scoring terms are untouched.
    bool committed = chance >= commitBar || boxEmergency || cynical || (carrier.dribbleType == 0 && ballExposureDot > 0.25) || (ballPushedAhead && ballExposureDot > 0.15) // nick the loose touch off an open carry
                     || (ballExposureDot > 0.55);                                                                                                                         // ball shown front-to-front at me — go, whatever the carry type
    // Round-27 COMMIT 2 (arbitration dwell): with chance hovering at the decayed
    // commitBar, `committed` flips true/false every tick — the fire-retract-fire
    // target thrash behind the jitter. Once a defender switches contain<->commit,
    // hold that mode >=150ms unless the carrier situation changes sharply (he no
    // longer controls the ball, or a hard auto-commit clause fires). A resolved
    // committed attempt rebound-blocks the tackler, so this cannot loop fouls.
    if (tackler.id >= 0 && tackler.id < 22 && !arenaMode) {   // 11v11 only: a 1v1 dwell can starve the lone container's resolution (round-25 freeze)
        bool hardCommit = boxEmergency || cynical || ballExposureDot > 0.55;   // situation-sharp: never hold contain over these
        bool sharpChange = state.ball.controllerId != carrier.id;             // carrier released the ball -> re-evaluate now
        int desired = committed ? 1 : -1;
        if (!hardCommit && !sharpChange && runtime[tackler.id].duel.tackleModeLatch != 0
            && state.clockMs < runtime[tackler.id].duel.tackleModeUntilMs) {
            committed = (runtime[tackler.id].duel.tackleModeLatch == 1);   // still inside the dwell: hold the latched mode
        } else if (desired != runtime[tackler.id].duel.tackleModeLatch) {
            runtime[tackler.id].duel.tackleModeLatch = desired;            // a genuine switch starts a fresh 150ms hold
            runtime[tackler.id].duel.tackleModeUntilMs = state.clockMs + 150.0;
        }
    }
    if (!committed) return false;
    // R28 C7: mark that a defender COMMITTED a challenge against this carrier (the
    // live commit/lunge hook the take-on reads). Set for every committed attempt,
    // win or miss — a carrier who rides it then bursts past the committed man.
    if (carrier.id >= 0 && carrier.id < 22) {
        runtime[carrier.id].duel.committedTackleVsCarrierMs = state.clockMs;
        runtime[carrier.id].duel.committedTackleVsCarrierBy = tackler.id;
    }
    // Even a committed challenge inside the box is careful — half the foul risk
    // of an open-field lunge (a clumsy one is still a penalty, just far rarer).
    double boxFoulScale = inPenaltyBox ? 0.54 : 1.0; // 0.5 -> 0.54: penalties ~0.14 -> ~0.3/match (still careful in the box)
    stats.recordTackleAttempt();
    commitLungeDash(tackler);
    if (rng.random() >= chance) {
        resolveTackleFoul(tackler, carrier, fromBehind, cynical, boxFoulScale);
        return false;
    }
    pendingPass.active = false;
    shot.clearFlags();
    receiverShieldUntil = 0;
    receiverShieldedPlayerId = -1;
    receiverShieldTargetId = -1;
    double angle = std::atan2(b.y - tackler.y, b.x - tackler.x) + (rng.random() - 0.5) * 0.9;
    double outcomeRoll = rng.random();
    double controlChance = clamp(0.28 + tackleSkill * 0.35 - carrierControl * 0.18 - (fromBehind ? 0.20 : 0) + (approachDot > 0.15 ? 0.12 : 0) - (carrier.dribbleType == 3 ? 0.08 : 0) + (exposedToFacingTackler ? 0.04 : 0) + (ballExposureDot > 0.40 ? 0.10 : 0.0) - (ballExposureDot < -0.30 ? 0.10 : 0.0), 0.12, 0.74);
    if (outcomeRoll < controlChance) {
        completeTackleWin(tackler, carrier);
        return true;
    }
    // Carry security — the carrier BEATS the man and keeps it. This outcome was
    // MISSING: every committed challenge used to dispossess (won OR spilled loose),
    // so possession churned ~2.4x too often (~390 strips/match, no 20+ build-up).
    // A good carrier (control/dribble/shield, harder still from behind) rides the
    // tackle and plays on; the beaten defender is briefly off-balance.
    // Round-16 rebalance (owner: "need attackers to get better at retention
    // and build up play"): a good carrier rides more of the extra challenges
    // the defensive rounds added — control weighs heavier, shielding pays
    // more, cap up 0.60 -> 0.66.
    double retainChance = clamp(carrierControl * 0.70 + (carrier.dribbleType == 3 ? 0.12 : 0.0) + (carrierShielded ? 0.24 : 0.0) + (fromBehind ? 0.10 : 0.0) - tackleSkill * 0.15, 0.0, 0.72);   // round-18: third retention step (owner: still too many turnovers)
    if (rng.random() < retainChance) {
        emitEvent("skill", carrier.x, carrier.y, carrier.id, tackler.id);
        blockReboundFor(tackler.id, 520);
        agentFor(tackler)->stunLock(12);
        return false;
    }
    spillTackleLoose(tackler, carrier, angle, outcomeRoll, carrierSpeed);
    return true;
}

// ══════════════════════════════════════════════════════════════════════════════
// spillTackleLoose() — the poke-away: nobody comes out of it with the ball
// ══════════════════════════════════════════════════════════════════════════════
// The third outcome of attemptTackle. Unlike the clean win it does depend on
// the duel's own numbers — the SAME outcome roll that rejected a clean steal
// also sets how hard the ball is poked — so the roll, the deflection angle and
// the carrier pace are passed in rather than re-derived. The caller still owns
// the `return true`.
void GameEngine::spillTackleLoose(Player& tackler, Player& carrier, double angle,
                                  double outcomeRoll, double carrierSpeed) {
    auto& b = state.ball;
    stats.recordTackleWin(false);
    if (tackler.id >= 0 && tackler.id < 22) pStats[tackler.id].tackles++; // a loose-deflection win is still a tackle won by this player (mirrors the clean-win branch); was omitted, under-counting per-player tackles ~46%
    emitEvent("tackle_loose", (tackler.x + carrier.x) / 2.0, (tackler.y + carrier.y) / 2.0, tackler.id, carrier.id);
    b.controllerId = -1;
    // A poke-away travels a few meters, not 12+ — high speeds here sent every
    // contested ball pinging across the pitch. But 30-98px/s dropped it INSIDE
    // the duel bubble: trace analysis found ~54 A-B-A-B rallies/match — the
    // same attacker/defender pair whacking the ball between them 4-8 times at
    // <1.2s per exchange (the user-reported "ping-pong"). 45-120px/s lets the
    // break escape the pair without restoring the cross-pitch ping.
    double kickSpeed = 45 + outcomeRoll * 48 + (carrier.dribbleType == 3 ? 16 : 0) + (carrierSpeed > DRIBBLE_MEDIUM_SPEED ? 10 : 0);
    b.vx = std::cos(angle) * kickSpeed;
    b.vy = std::sin(angle) * kickSpeed;
    b.x = clamp(b.x, 5.0, PITCH_W - 5.0);
    b.y = clamp(b.y, 5.0, PITCH_H - 5.0);
    if (kickSpeed > 180) { stats.recordSlideTackleDistance(); }
    if (b.x < 10 || b.x > PITCH_W - 10 || b.y < 10 || b.y > PITCH_H - 10) { stats.recordSlideTackleOob(); }
    b.lastTouchTeam = tackler.team;
    b.lastToucherId = tackler.id; lastRicochetMs = -1e9;   // genuine touch supersedes ricochet restart memory
    b.intendedReceiverId = -1;
    b.z = b.vz = 0;
    lastLooseOrigin = LooseOrigin::TackleDeflection;
    recordBallImpulse();
    // Both duelists need a real beat after the poke (was 250/450ms — expired
    // before the ball left the bubble, so the SAME pair re-collected and
    // re-dueled on loop). 700ms turns the break into a genuine 50/50 for the
    // better-positioned player or a third man; the ghost-body ricochet keeps
    // the locked pair's bodies physical meanwhile.
    blockReboundFor(tackler.id, 700);
    blockReboundFor(carrier.id, 700);
    carrier.vx = carrier.vy = 0;
}

// ══════════════════════════════════════════════════════════════════════════════
// completeTackleWin() — a clean steal: the tackler comes away with it
// ══════════════════════════════════════════════════════════════════════════════
// The winning branch of attemptTackle. It reads nothing from the duel
// arithmetic — only who won and who lost — so it is the cleanest of the three
// outcome branches to lift. The caller still owns the `return true`.
void GameEngine::completeTackleWin(Player& tackler, Player& carrier) {
    auto& b = state.ball;
    stats.recordTackleWin(true);
    if (tackler.id >= 0 && tackler.id < 22) pStats[tackler.id].tackles++;
    emitEvent("tackle_won", (tackler.x + carrier.x) / 2.0, (tackler.y + carrier.y) / 2.0, tackler.id, carrier.id);
    // Round-20 (seed 477: an early loss stayed silent): the first-5s-of-kickoff
    // giveaway census (pass_giveaway_first_5s) only fired on an intercepted
    // pass — a carrier DISPOSSESSED by a tackle in that window was invisible.
    // A clean tackle-won is the definitive possession loss (the recordPassIntercepted
    // analog), so mirror the pass site's kickoff-relative scoping. Census only.
    if (state.clockMs - phase.lastKickoffMs < 5000.0 && state.clockMs >= phase.lastKickoffMs)
        stats.recordQualityFlag(QualityFlag::EarlyKickoffGiveaway);
    b.controllerId = tackler.id;
    b.vx = b.vy = b.z = b.vz = 0;
    b.curl = 0;
    b.lastTouchTeam = tackler.team;
    b.lastToucherId = tackler.id; lastRicochetMs = -1e9;   // genuine touch supersedes ricochet restart memory
    b.intendedReceiverId = -1;
    receiverShieldUntil = state.clockMs + 260;
    receiverShieldedPlayerId = tackler.id;
    // Round-38: this path grants control WITHOUT collectBall, so without the
    // stamp the panic-clear first-touch grace reads a stale controlStartMs and
    // a fresh tackle winner could still hoof on his next decision tick — the
    // exact "won it then hooved it" the grace exists to stop.
    if (tackler.id >= 0 && tackler.id < 22) runtime[tackler.id].controlStartMs = state.clockMs;
    // Round-28 C3(b): amortize the ball across the 17-25px duel gap to the
    // winner's foot over 2-3 ticks (no knock-ahead, faster pull) instead of
    // letting it settle at the carry offset far from him.
    if (tackler.id >= 0 && tackler.id < 22 && !arenaMode) runtime[tackler.id].duel.carrierGatherUntilMs = state.clockMs + 100.0;
    // Round-36: a won duel is a REGAIN — cache which way to secure it. The
    // lunge above just set tackler.facing AT the carrier, and the gather lock
    // settles along a fixed direction; without this it settles into the man
    // just beaten (owner, seed 407 0:26).
    noteRegain(tackler, carrier.id, 700.0);
    lastLooseOrigin = LooseOrigin::None;
    blockReboundFor(carrier.id, 450);
    // Round-27 COMMIT 2 (eased stop): don't hard-zero the victim's momentum —
    // that abrupt one-tick halt was ~8% of the tackle-jitter screengrabs.
    // Keep his velocity and let applyMovement bleed it over the next ~3 ticks.
    if (carrier.id >= 0 && carrier.id < 22 && !arenaMode) runtime[carrier.id].duel.tackleStopEaseUntilMs = state.clockMs + 50.0;
}

// ══════════════════════════════════════════════════════════════════════════════
// commitLungeDash() — the committed tackler steps onto the ball
// ══════════════════════════════════════════════════════════════════════════════
// Everything this needs is the tackler and the ball, so it is independent of
// the duel arithmetic above it. fixedUpdate plays the queued dash out; see the
// teleport tombstone below for why it is a dash and not a snap.
void GameEngine::commitLungeDash(Player& tackler) {
    auto& b = state.ball;
    // LUNGE (micro audit #3: every duel resolved with the bodies 21-25px apart
    // and the winner moving 1-2px — the steal happened across a gap). Commit
    // the tackler's body toward the ball — but as a DASH over the next few
    // ticks, not the old instant 60%-of-gap snap: that snap was a one-tick
    // ~900px/s teleport, the biggest visual artifact of the round-13 build
    // (seed 305 0:09, 0:42). fixedUpdate plays the dash out at LUNGE_DASH_SPEED.
    {
        double lx = b.x - tackler.x, ly = b.y - tackler.y, ld = std::hypot(lx, ly);
        if (ld > 4.0 && tackler.id >= 0 && tackler.id < 22) {
            runtime[tackler.id].lungeDash.dirX = lx / ld;
            runtime[tackler.id].lungeDash.dirY = ly / ld;
            runtime[tackler.id].lungeDash.remainPx = std::min(ld * 0.55, 11.0);   // 16 -> 11px: shorter committed step, same contact read (seed 111 burst complaint)
            runtime[tackler.id].lungeDash.switchPx = 0.0;   // R28 C8: a tackle step is always single-stage — never inherit a stale chop
            runtime[tackler.id].lungeDash.dir2X = runtime[tackler.id].lungeDash.dir2Y = 0.0;
            // Round-23: seed spd=peak=LUNGE_DASH_SPEED so this short defender
            // contact step stays the flat 11px/90ms hard step round-14 tuned.
            runtime[tackler.id].lungeDash.spd  = LUNGE_DASH_SPEED;
            runtime[tackler.id].lungeDash.peak = LUNGE_DASH_SPEED;
            tackler.facing = std::atan2(ly, lx);
        }
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// tackleCommitBar() — the threshold a challenge must clear to be committed
// ══════════════════════════════════════════════════════════════════════════════
// Aggression dial, the two directives, the shepherd-contain floor and the
// long-carry decay, all in one place. It reads only the two duelists (plus
// engine state) and produces one number, which is why it is the one clean
// seam in attemptTackle's commit arbitration.
double GameEngine::tackleCommitBar(const Player& tackler, const Player& carrier) const {
    // aggression lowers the commit bar: a high-press side dives in on lower-%
    // challenges (wins it back higher, but is beaten more); a contain side
    // only commits to a clear chance. Centred at dial 50 = the old 0.30.
    // tackle_hard lowers the commit bar (dives in on lower-% challenges);
    // stay_on_feet raises it (jockey, only commit to a clear chance).
    // Round-24 (largest turnover bucket, contain-first): committed tackles ran
    // ~830/90 (real 60-90). Measurement showed the exposure auto-commit clauses
    // in attemptTackle are INERT on tackle volume — even disabling them entirely moved
    // attempts by ~0 (the chance>=commitBar path drives essentially all
    // commitment). So the honest contain-first lever is commitBar itself: raise
    // the base 0.30->0.40 so a defender only commits to a clearer chance and
    // jockeys the rest. This is NOT the win-chance formula or a scoring term —
    // it is the commit threshold. Deliberately PARTIAL: 0.40 cuts committed
    // tackles ~826->704/90 (12-seed A/B, REAL) with marathonCarries and
    // dizzy_spin still in noise; pushing to 0.45+ reached the 450-550 band but
    // spiked marathonCarries (carriers running free) — the regression this round
    // must avoid. Upper clamp 0.50->0.56 to keep the stay_on_feet headroom.
    // Round-37 (owner: "too many turnovers and tackles — unrealistic"): 0.40->0.43,
    // HALF the remaining documented-safe step toward the 0.45 marathon threshold —
    // paired with a longer post-miss re-lunge lockout (below) so volume comes down
    // without freeing carriers.
    double commitBar = clamp(0.43 - (configFor(tackler.team).aggression - 50.0) / 50.0 * 0.13 - directiveBias[tackler.id].tackleAggression * 0.13 + directiveBias[tackler.id].stayOnFeet * 0.15, 0.10, 0.56);
    // R28 C4: a shepherd-engaged defender is CONTAINING — only commit to a clearly
    // winnable challenge (bypasses the 0.56 contain-first clamp for this case only,
    // so the recovery sprint into the shield bubble doesn't inflate incidental
    // steals). The round-25 long-carry commitBar decay below still overrides it, so
    // a genuinely stuck escort still resolves.
    if (tackler.id >= 0 && tackler.id < 22 && runtime[tackler.id].duel.containUntilMs > state.clockMs)
        commitBar = std::max(commitBar, 0.62);
    // Round-25 (2v2 audit top defect): with a LONE container, contain-first never
    // resolves — carriers ride one jockey 15-24s (marathonCarries 14-17/10min; a
    // 50-rated CM dribbled the full pitch with a defender glued 19-40px away). The
    // flat 0.40 bar means the container waits forever for a clear chance that a
    // lone jockey can never manufacture. Decay the bar as the CURRENT carry runs
    // long: a container who has ridden ONE man >4s progressively commits (fully by
    // ~12s). Reuses the carryStartMs idiom; deterministic, no rng; near-inert in
    // 11v11 where >4s single-carries are rare (cover arrives / the ball moves on).
    if (carrierTracker.carryTrackerId == carrier.id) {
        double carryMs = state.clockMs - carrierTracker.carryStartMs;
        commitBar -= clamp((carryMs - 4000.0) / 8000.0, 0.0, 1.0) * 0.18;
    }
    return commitBar;
}
