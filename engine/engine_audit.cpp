// engine_audit.cpp — measurement and tripwires, not gameplay
//
// Split out of engine.cpp. Everything here observes the simulation: possession
// spell tracking, the blob-purpose probe, the freeze detector and the stuck-carrier
// tripwire. None of it draws rng or gates a simulation branch, so a change in this
// file that moves the golden fingerprint is by definition a bug in the change.
#include "engine.h"
#include "agent.h"
#include "role_ai.h"
#include "gk_ai.h"
#include <format>
#include <cmath>
#include <numbers>

// Per-tick ball-carrier diagnostics for the current controller: possession clock,
// stuck / backward-carry / carry-distance / marathon-shuttle / stationary-hold
// trackers. Feeds quality stats; does not steer play.
void GameEngine::trackCarrierPossession(Player* c, double sdt) {
        if (c->team == Team::Home)
            metrics.possessionHome += sdt;
        else
            metrics.possessionAway += sdt;
        double fd = fdFor(c->team);
        if (c->id != carrierTracker.carryTrackerId) {
            carrierTracker.carryTrackerId = c->id;
            carrierTracker.carryLastX = c->x;
            carrierTracker.carryLastY = c->y;
            carrierTracker.carryPathDistance = 0;
            carrierTracker.carryStartMs = state.clockMs;
            carrierTracker.carryStartX = c->x;
            carrierTracker.carryStartFacing = c->facing;
            carrierTracker.carryRevsY = 0;
            carrierTracker.carryLastDirY = 0;
            carrierTracker.carryPivotY = c->y;
            carrierTracker.marathonRecorded = false;
            carrierTracker.shuttleRecorded = false;
            carrierTracker.marathonReleased = false;
        } else {
            double step = dist(c->x, c->y, carrierTracker.carryLastX, carrierTracker.carryLastY);
            if (step < 45.0) carrierTracker.carryPathDistance += step;
            // Lateral shuttle: count amplitude-qualified y reversals — the
            // "dribbled side to side for ages" pattern. Per-tick sign flips are
            // dominated by steering jitter and undercount macro swings (they
            // never reached 3 in a full match), so this uses hysteresis peak
            // detection: a swing must retrace >= SHUTTLE_AMP px from its extreme
            // before it counts as a reversal in the opposite direction.
            constexpr double SHUTTLE_AMP = 45.0;
            double y = c->y;
            int dir = carrierTracker.carryLastDirY;
            double& pivot = carrierTracker.carryPivotY;
            if (dir > 0) {
                if (y > pivot)
                    pivot = y;
                else if (pivot - y >= SHUTTLE_AMP) {
                    carrierTracker.carryRevsY++;
                    dir = -1;
                    pivot = y;
                }
            } else if (dir < 0) {
                if (y < pivot)
                    pivot = y;
                else if (y - pivot >= SHUTTLE_AMP) {
                    carrierTracker.carryRevsY++;
                    dir = 1;
                    pivot = y;
                }
            } else {
                if (y - pivot >= SHUTTLE_AMP) {
                    dir = 1;
                    pivot = y;
                } else if (pivot - y >= SHUTTLE_AMP) {
                    dir = -1;
                    pivot = y;
                }
            }
            carrierTracker.carryLastDirY = dir;
            carrierTracker.carryLastX = c->x;
            carrierTracker.carryLastY = c->y;
            double carryMs = state.clockMs - carrierTracker.carryStartMs;
            if (!carrierTracker.marathonRecorded && carryMs >= 8000.0 && c->role != Role::GK) {
                carrierTracker.marathonRecorded = true;
                stats.recordMarathonCarry();
            }
            if (!carrierTracker.shuttleRecorded && carryMs >= 6000.0 && carrierTracker.carryRevsY >= 3 && c->role != Role::GK) {
                carrierTracker.shuttleRecorded = true;
                stats.recordShuttleCarry();
            }
            stats.noteLongestCarry(carryMs);
        }
        if (c->id != carrierTracker.backwardCarryCarrierId) {
            carrierTracker.backwardCarryCarrierId = c->id;
            carrierTracker.backwardCarryStartX = c->x;
            carrierTracker.backwardCarryRecorded = false;
        } else {
            // Measure regression from the carry's HIGH-WATER mark, not possession
            // start: a carrier who advanced 65px then gave back 106px netted only
            // -41 from his start point and never tripped the -70 backward-carry
            // dampers (watched replay seed 129 0:17-0:24 — a 7s corner-pocket
            // retreat with backwardCarry reading -28). Riding the max keeps the
            // dampers (and the longBackwardCarries stat) honest.
            if ((c->x - carrierTracker.backwardCarryStartX) * fd > 0.0)
                carrierTracker.backwardCarryStartX = c->x;
            if (!carrierTracker.backwardCarryRecorded && (c->x - carrierTracker.backwardCarryStartX) * fd < -200.0) {
                stats.recordLongBackwardCarry();
                carrierTracker.backwardCarryRecorded = true;
            }
        }
        double carrierSpeed = std::hypot(c->vx, c->vy);
        double targetDistance = dist(c->x, c->y, c->targetX, c->targetY);
        bool stationaryOutfieldHold = !setPiece.armed && !phase.kickoffPhase && c->role != Role::GK && carrierSpeed < 8.0 && (targetDistance < 8.0 || c->dribbleType == 0);
        if (c->id != carrierTracker.stationaryHoldCarrierId || !stationaryOutfieldHold) {
            carrierTracker.stationaryHoldCarrierId = stationaryOutfieldHold ? c->id : -1;
            carrierTracker.stationaryHoldMs = 0;
            carrierTracker.stationaryHoldRecorded = false;
        } else if (!carrierTracker.stationaryHoldRecorded) {
            carrierTracker.stationaryHoldMs += sdt;
            if (carrierTracker.stationaryHoldMs >= 420.0) {
                carrierTracker.stationaryHoldRecorded = true;
                // Round-29: NEAREST teammate is not a graded ball — route this
                // exit through the shared pass grader; below the floor, the
                // dribble nudge is the honest escape (an unpressured stationary
                // carrier must never gift a low-grade pass).
                Player* best = bestGradedReceiver(*c, 360.0, 0.2);
                if (best) {
                    forcePassTo(*c, *best, nullptr);
                } else {
                    double side = c->y < PITCH_H / 2.0 ? 1.0 : -1.0;
                    c->dribbleType = 2;
                    c->targetX = clamp(c->x + fd * 70.0, 35.0, PITCH_W - 35.0);
                    c->targetY = clamp(c->y + side * 42.0, 35.0, PITCH_H - 35.0);
                }
            }
        }
        // ── Moving-marathon release ── Score-nudging the carrier's Dribble does
        // NOT end these carries (A/B: marathonCarries went UP, goals down) — the
        // carrier holds precisely because no pass out-scored dribbling. So when an
        // uninterrupted outfield carry has run long WITHOUT net forward progress
        // (the "dribbled non stop from one side to the other" shuttle), physically
        // hand it to the best OPEN supporting teammate. Guarded: fires only when
        // such an open, in-range option exists, so we never gift possession into a
        // covered pass — if the carrier is truly boxed in, the carry stands.
        if (!setPiece.armed && !phase.kickoffPhase && c->role != Role::GK && !carrierTracker.marathonReleased) {
            double carryDurMs = state.clockMs - carrierTracker.carryStartMs;
            double carryFwd = (c->x - carrierTracker.carryStartX) * fd;
            // Spare final-third carries: shots are built there, and forcing a
            // release cost ~22% of shots. The shuttle we're killing is the
            // midfield/own-half "side to side" hold, not the final ball.
            double distToOppGoal = pitch::distToOppGoal(c->x, c->team);
            // 5.2s, was 7.0s: the carry-duration histogram had a spike at
            // exactly 6.8-7.2s — ~15 carries per watched match visibly riding
            // this watchdog (census, seed 129). With the safe-outlet receiver
            // pick below the forced release now reads as an ordinary escape
            // ball, so it can come when a real player would play it.
            if (carryDurMs >= 5200.0 && carryFwd < 80.0 && distToOppGoal > 340.0) {
                // The forced release is the SAFE out-ball, not a mortar: the old
                // pick weighted forwardness double openness with no lane check,
                // so it chipped 145° over its shoulder into a triple-blocked lane
                // the pass scorer had vetoed that same tick (watched replay seed
                // 129 0:24.5 — the owner's "the pass attempted was just weird",
                // intercepted 0.15s after release) while the free CB behind
                // ranked LAST by construction. Safety-first scoring (same formula
                // as the pressured-circling release below), a lane check, and a
                // facing-compatible preference make the backstop ball look like a
                // player's choice; fixes upstream should make it rarely fire.
                // Graded lane read: hard-skip only a near-certain deflection
                // (a body within ~20px of the flight line); nearby traffic
                // costs score. A hard 30px skip left the watchdog with NO
                // candidate in crowded midfield, the release never fired, and
                // marathon carries ROSE (7-11/match vs baseline 3-6).
                // The rules relax as the carry drags on: at first only a clean
                // safe outlet is accepted (a real player's ball); past ~6.5s any
                // honest escape beats carrying forever (a hard candidate filter
                // here left the release unfired in crowded midfield and marathon
                // carries ROSE).
                bool desperate = carryDurMs >= 6500.0;
                double hardPerp = desperate ? 14.0 : 20.0;
                double coverMin = desperate ? 45.0 : 55.0;
                auto laneCost = [&](const Player& o) {
                    double dx = o.x - c->x, dy = o.y - c->y, ls = dx * dx + dy * dy;
                    if (ls < 1.0) return 1e9;
                    double cost = 0.0;
                    for (auto& q : state.players) {
                        if (q.team == c->team || q.role == Role::GK || q.sentOff) continue;
                        double t2 = clamp(((q.x - c->x) * dx + (q.y - c->y) * dy) / ls, 0.0, 1.0);
                        if (t2 * std::sqrt(ls) < 40.0) continue;   // the on-boot presser blocks every lane equally
                        double perp = std::hypot(q.x - c->x - t2 * dx, q.y - c->y - t2 * dy);
                        if (perp < hardPerp) return 1e9;           // ball into a body — the scorer already refused this
                        if (perp < 40.0) cost += (40.0 - perp) * 2.5;
                    }
                    return cost;
                };
                Player* best = nullptr;
                double bestScore = -1e9;
                for (auto& o : state.players) {
                    if (o.team != c->team || o.id == c->id || o.role == Role::GK || o.sentOff) continue;
                    double d = dist(c->x, c->y, o.x, o.y);
                    if (d < PASS_MIN_DISTANCE || d > 380.0) continue; // realistic pass range
                    double oppD = 1e9;                   // receiver's nearest marker
                    for (auto& q : state.players)
                        if (q.team != c->team && q.role != Role::GK && !q.sentOff)
                            oppD = std::min(oppD, dist(o.x, o.y, q.x, q.y));
                    if (oppD < coverMin) continue;                 // covered — not a safe release
                    double lc = laneCost(o);
                    if (lc > 1e8) continue;                        // certain deflection
                    if (gradePass(*c, o) < 0.2) continue;          // round-29: shared grade floor on every exit path
                    double score = oppD - lc - std::abs((o.x - c->x) * fd) * 0.15; // safest open man, near before far
                    double wantAng = std::atan2(o.y - c->y, o.x - c->x);
                    double offF = std::abs(std::atan2(std::sin(wantAng - c->facing), std::cos(wantAng - c->facing)));
                    if (offF > 2.0) score -= 40.0;                 // prefer a ball he can play without a no-look spin
                    if (score > bestScore) {
                        bestScore = score;
                        best = &o;
                    }
                }
                if (best) {
                    c->facing = std::atan2(best->y - c->y, best->x - c->x);   // square up with the release, not a no-looker
                    forcePassTo(*c, *best, nullptr);
                    carrierTracker.marathonReleased = true;
                } else if (desperate) {
                    // Round-29: no receiver clears the grade floor and the carry
                    // has dragged past 6.5s — clear to space rather than either
                    // gifting a graded-refused ball or carrying forever (the
                    // unfired-release tombstone above).
                    hoofClearToSpace(*c);
                    carrierTracker.marathonReleased = true;
                }
            }
            // ── Pressured-circling release ── the 7s/final-third guard above misses
            // the commonest lost-possession shuttle: a carrier SWARMED (2+ markers,
            // one touch-tight) in the attacking half but OUTSIDE the box, circling
            // 2.6s+ with no forward progress while a WIDE-open team-mate stands free —
            // dispossessed ~100% of the time (watched replay seed 105 0:16 was 14.6s
            // of it). Release to the safest wide-open man. TIGHT gates (2 markers incl.
            // one <32px, a confirmed side-to-side shuttle, the 200-340 band, a receiver
            // 90px+ clear) — deliberately NOT the looser long-hold variant that raised
            // giveaways. Reuses the proven forcePassTo one-shot.
            if (!carrierTracker.marathonReleased && carryDurMs >= 2600.0 && carryFwd < 40.0
                && carrierTracker.carryRevsY >= 1 && distToOppGoal > 200.0 && distToOppGoal < 340.0) {
                int tightMarkers = 0;
                double nearestOpp = 1e9;
                for (auto& q : state.players) {
                    if (q.team == c->team || q.role == Role::GK || q.sentOff) continue;
                    double qd = dist(c->x, c->y, q.x, q.y);
                    if (qd < 55.0) tightMarkers++;
                    nearestOpp = std::min(nearestOpp, qd);
                }
                if (tightMarkers >= 2 && nearestOpp < 32.0) {
                    // Round-29 (owner 0:18 — THE headline): this pick had NO lane
                    // check — "wide-open" measured only the receiver's marker
                    // distance, so it forced a ball the pass scorer had graded
                    // −0.89 that same tick, straight down a covered lane
                    // (interceptor 24px off the line, INTCPT comp=0). Route it
                    // through the shared grader; if nobody clears the floor,
                    // CLEAR — a throw-in conceded ≫ a gifted interception.
                    Player* best = nullptr;
                    double bestScore = -1e9;
                    for (auto& o : state.players) {
                        if (o.team != c->team || o.id == c->id || o.role == Role::GK || o.sentOff) continue;
                        double od = dist(c->x, c->y, o.x, o.y);
                        if (od < 90.0 || od > 380.0) continue;
                        double oppD = 1e9;
                        for (auto& q : state.players)
                            if (q.team != c->team && q.role != Role::GK && !q.sentOff)
                                oppD = std::min(oppD, dist(o.x, o.y, q.x, q.y));
                        if (oppD < 90.0) continue;                 // WIDE-open only
                        if (gradePass(*c, o) < 0.2) continue;      // shared grade floor
                        double score = oppD - std::abs((o.x - c->x) * fd) * 0.15; // safest, not most forward
                        if (score > bestScore) { bestScore = score; best = &o; }
                    }
                    if (best) {
                        forcePassTo(*c, *best, nullptr);
                        carrierTracker.marathonReleased = true;
                    } else {
                        hoofClearToSpace(*c);
                        carrierTracker.marathonReleased = true;
                    }
                }
            }
        }
}

void GameEngine::updatePossessionTracking(double sdt) {
    auto* c = playerById(state.ball.controllerId);
    // Detect a live turnover (control flips teams in open play) -> open the
    // quick-transition window. Suppressed during set-piece restarts.
    if (c && !setPiece.armed) {
        if (transitionHadCtrl && c->team != transitionLastCtrlTeam)
            transitionUntilMs = state.clockMs + 400.0;
        transitionLastCtrlTeam = c->team;
        transitionHadCtrl = true;
    }
    if (c) trackCarrierPossession(c, sdt);
    else {
        if (activeKnockAhead.active && activeKnockAhead.playerId >= 0) {
            Player* runner = playerById(activeKnockAhead.playerId);
            if (runner) {
                if (carrierTracker.carryTrackerId != runner->id) {
                    carrierTracker.carryTrackerId = runner->id;
                    carrierTracker.carryLastX = runner->x;
                    carrierTracker.carryLastY = runner->y;
                    carrierTracker.carryPathDistance = 0;
                } else {
                    double step = dist(runner->x, runner->y, carrierTracker.carryLastX, carrierTracker.carryLastY);
                    if (step < 45.0) carrierTracker.carryPathDistance += step;
                    carrierTracker.carryLastX = runner->x;
                    carrierTracker.carryLastY = runner->y;
                }
            }
        } else {
            carrierTracker.carryTrackerId = -1;
            carrierTracker.carryPathDistance = 0;
        }
        carrierTracker.backwardCarryCarrierId = -1;
        carrierTracker.backwardCarryRecorded = false;
        carrierTracker.stationaryHoldCarrierId = -1;
        carrierTracker.stationaryHoldMs = 0;
        carrierTracker.stationaryHoldRecorded = false;
    }
    // Line-too-deep sampler (user: "defensive lines drop a bit too deep
    // sometimes when they shouldn't"): once a second per team — flag when the
    // back line sits inside 110px of its own goal while the ball is far away
    // (>450px from that goal) and no attacker is even near the line depth.
    if (state.clockMs >= telemetry.lineDepthNextMs && !setPiece.armed && !phase.kickoffPhase) {
        telemetry.lineDepthNextMs = state.clockMs + 1000.0;
        for (int t = 0; t < 2; t++) {
            Team team = t == 0 ? Team::Home : Team::Away;
            double line = 1e9;
            for (auto& p : state.players)
                if (p.team == team && !p.sentOff && roles::isDefenderRole(p.role))
                    line = std::min(line, pitch::distToOwnGoal(p.x, team));
            if (line > 110.0) continue;
            if (pitch::distToOwnGoal(state.ball.x, team) < 450.0) continue;
            bool threatDeep = false;
            for (auto& p : state.players)
                if (p.team != team && p.role != Role::GK && !p.sentOff && pitch::distToOwnGoal(p.x, team) < line + 60.0) {
                    threatDeep = true;
                    break;
                }
            if (!threatDeep) stats.recordLineTooDeep();
        }
    }
    stats.recordPossession(metrics.possessionHome, metrics.possessionAway);
    auditStuckCarrier(sdt);
    auditBlobPurposes();
}

// Knot counting is ALWAYS on (summary blobMoments — the crowding ticket's
// summary-level target metric; 15-min traces are too noisy at n=3).
// FOOTY_BLOBDEBUG=1 additionally stderr-logs each knot with every member's
// role/team/last action/purpose/target (attribution).
void GameEngine::auditBlobPurposes() {
    static const bool on = [] { const char* e = std::getenv("FOOTY_BLOBDEBUG"); return e && e[0] == '1'; }();
    if (setPiece.armed || phase.kickoffPhase) return;
    if (state.clockMs < telemetry.blobLogNextMs) return;
    for (auto& seed : state.players) {
        if (seed.sentOff) continue;
        int n = 0;
        for (auto& q : state.players) {
            if (q.sentOff) continue;
            // Axis pre-reject before the sqrt (perf, round-2 profile: this is an
            // O(22x22) scan on EVERY tick — 64M dist() calls a match, measured by
            // instrumenting pristine HEAD at seed 501 @45min — and it runs
            // in the shipping build because recordBlobMoment fires regardless of
            // FOOTY_BLOBDEBUG). hypot(dx, dy) >= max(|dx|, |dy|), so an axis gap of
            // 50 or more already fails the strict `< 50.0` test below; a skipped
            // pair could never have incremented n.
            if (std::abs(q.x - seed.x) >= 50.0 || std::abs(q.y - seed.y) >= 50.0) continue;
            if (dist(q.x, q.y, seed.x, seed.y) < 50.0) n++;
        }
        if (n < 6) continue;
        telemetry.blobLogNextMs = state.clockMs + 1500.0;
        stats.recordBlobMoment();
        if (!on) return;
        std::fprintf(stderr, "BLOB %.0fms @(%.0f,%.0f) ball=(%.0f,%.0f,ctrl=%d):",
                     state.clockMs, seed.x, seed.y, state.ball.x, state.ball.y, state.ball.controllerId);
        for (auto& q : state.players) {
            if (q.sentOff || dist(q.x, q.y, seed.x, seed.y) >= 50.0) continue;
            PlayerAI* a = agentFor(q);
            // pur=task alone can't be acted on — append WHICH DefensiveTask
            // (press/screen/cover/...) so the attribution names a lever.
            const auto* asn = assignmentFor(q.id);
            std::fprintf(stderr, " #%d[%s%s act=%d pur=%s%s%s tgt=(%.0f,%.0f)]",
                         q.id, std::string(to_string(q.role)).c_str(), q.team == Team::Home ? "H" : "A",
                         static_cast<int>(a->lastAction()), std::string(to_string(a->lastActionPurpose())).c_str(),
                         asn ? ":" : "", asn ? std::string(to_string(asn->role)).c_str() : "",
                         q.targetX, q.targetY);
        }
        std::fprintf(stderr, "\n");
        return;
    }
}

void GameEngine::detectSimulationFreeze(double sdt) {
    if (setPiece.armed || phase.kickoffPhase) return;
    auto& fb = state.ball;
    int cid = fb.controllerId;
    // A keeper holding for distribution keeps a stationary ball legitimately; his
    // hold is bounded by the GK distribution cap (GK_MAX_HOLD_MS → forced punt),
    // not by this freeze watchdog. Watching him here only fired a false-positive
    // "freeze" ~1.5s in and nudged him forward with the ball — a keeper wandering
    // upfield. Skip GK carriers; the distribution logic owns his release.
    {
        Player* cctrl = cid >= 0 ? playerById(cid) : nullptr;
        if (cctrl && cctrl->role == Role::GK) {
            freezeDetector.freezeWatchMs = 0;
            freezeDetector.freezeBallX = fb.x;
            freezeDetector.freezeBallY = fb.y;
            freezeDetector.freezeLastController = cid;
            return;
        }
    }
    if (cid < 0) {
        // A LOOSE ball can come to rest uncollected — nobody is assigned to chase
        // it (e.g. it rolls dead into a corner). It then sits there forever: the
        // controlled-carrier watcher below only runs while a player HOLDS the ball,
        // so it never sees this. A dead ball in a final third also starves the
        // half-end whistle (which needs !inFinalThird), hanging the match to the
        // +5:00 hard cap. Watch a stationary loose ball and, after
        // LOOSE_BALL_STALL_MS, give it to the nearest player so play restarts.
        double bs = std::hypot(fb.vx, fb.vy);
        // Nearest player to the loose ball right now (deterministic: min dist, tie -> lower id).
        // `best` is who the ball is HANDED to when the watchdog fires — every player,
        // keeper included, because a ball that has died in his own six-yard box
        // belongs to him. `chaseD` is a different question (see the closing test).
        Player* best = nullptr;
        double bestD = 1e9;
        double chaseD = 1e9;   // ...nearest OUTFIELDER: the man who would actually chase it
        for (auto& p : state.players) {
            if (p.sentOff) continue;
            double d = dist(fb.x, fb.y, p.x, p.y);
            if (d < bestD) {
                bestD = d;
                best = &p;
            }
            if (p.role != Role::GK && d < chaseD) {
                chaseD = d;
            }
        }
        bool wasLoose = freezeDetector.freezeLastController == -1; // loose last tick too
        bool travelling = bs >= LOOSE_BALL_STALL_SPEED || dist(fb.x, fb.y, freezeDetector.freezeBallX, freezeDetector.freezeBallY) >= 5.0;
        // A ball a player is CLOSING IN ON is not stuck — it's about to be collected.
        // Only a ball nobody has moved toward for the whole window is genuinely
        // abandoned. Re-arm whenever the nearest OUTFIELDER gets LOOSE_BALL_CLOSING_EPS
        // closer than the baseline set when the watch armed.
        //
        // Round-38 KEEPERS ARE NOT CHASERS. This baseline used to be the minimum over
        // ALL players. A keeper's distance to a dead ball is a coincidence of where
        // his line is, not evidence that anyone is coming — and a ball that dies near
        // a goal (exactly what this watchdog is for) has a keeper as its nearest body
        // almost by construction. So `looseNearestD` armed on the GK's small distance,
        // the GK then walked back to his line, and no genuine chaser closing from 300px
        // could ever beat that floor: `someoneClosing` was pinned false and the watchdog
        // fired ON TOP OF a live chase, rolling the ball away from the man about to
        // reach it. Censused over seeds 101-140 @90min with the old logic: 13 fires
        // (0.33/match) and ALL THIRTEEN happened while the nearest outfielder had
        // closed since the watch armed — median 224px at arm time down to 66px at the
        // fire. Not one fire in 60 hours of football was a genuinely abandoned ball;
        // 3 of the 13 shoved it to a keeper. Scoping the baseline to outfielders takes
        // those 13 to 0 while leaving the abandoned-ball path exactly as it was.
        //
        // NOT per-player best-ever (the audit's other suggestion): with 22 men milling
        // about, somebody improves his own record almost every tick, which suppresses
        // the watchdog entirely and brings back the dead-ball hang it exists to break.
        // The nearest outfielder is the man most likely to collect it — that is the
        // one distance whose trend actually answers "is this ball being chased?".
        bool someoneClosing = wasLoose && chaseD < freezeDetector.looseNearestD - LOOSE_BALL_CLOSING_EPS;
        if (!wasLoose || travelling || someoneClosing) {
            freezeDetector.freezeWatchMs = 0;
            freezeDetector.freezeBallX = fb.x;
            freezeDetector.freezeBallY = fb.y;
            freezeDetector.looseNearestD = chaseD;
        } else {
            freezeDetector.freezeWatchMs += sdt;
            if (freezeDetector.freezeWatchMs > LOOSE_BALL_STALL_MS && best && state.clockMs - freezeDetector.lastFreezeAlertMs > 5000) {
                stats.recordSimulationFreeze();
                double rdx = best->x - fb.x, rdy = best->y - fb.y, rd = std::hypot(rdx, rdy);
                if (rd < 20.0) {
                    // Already at his feet — a genuine pickup.
                    fb.controllerId = best->id;
                    fb.vx = fb.vy = fb.vz = 0.0;
                    fb.z = 0.0;
                    fb.curl = 0.0;
                    fb.lastTouchTeam = best->team;
                    fb.lastToucherId = best->id; lastRicochetMs = -1e9;   // genuine touch supersedes ricochet restart memory
                    fb.intendedReceiverId = -1;
                    lastLooseOrigin = LooseOrigin::None;
                } else {
                    // ROLL the abandoned ball to him — assigning control from range
                    // teleported it up to ~150px to his feet in one tick (watched
                    // replay seed 133 1:28). A bounded nudge-roll reads as the ball
                    // wobbling back into life; he collects it naturally on arrival,
                    // and the 5s re-arm re-rolls if it under-reaches.
                    double rs = clamp(rd * 0.9, 120.0, 260.0);
                    driveBall(fb, rdx, rdy, rd, rs);
                    fb.vz = 0.0;
                    fb.z = 0.0;
                    fb.curl = 0.0;
                }
                freezeDetector.lastFreezeAlertMs = state.clockMs;
                freezeDetector.freezeWatchMs = 0;
            }
        }
        freezeDetector.freezeLastController = -1;
    } else if (cid != freezeDetector.freezeLastController) {
        freezeDetector.freezeWatchMs = 0;
        freezeDetector.freezeBallX = fb.x;
        freezeDetector.freezeBallY = fb.y;
        freezeDetector.freezeLastController = cid;
    } else {
        freezeDetector.freezeWatchMs += sdt;
        Player* movingCarrier = playerById(cid);
        if (movingCarrier && std::hypot(movingCarrier->vx, movingCarrier->vy) > 12.0) {
            freezeDetector.freezeWatchMs = 0;
            freezeDetector.freezeBallX = fb.x;
            freezeDetector.freezeBallY = fb.y;
            return;
        }
        if (dist(fb.x, fb.y, freezeDetector.freezeBallX, freezeDetector.freezeBallY) >= 5) {
            freezeDetector.freezeWatchMs = 0;
            freezeDetector.freezeBallX = fb.x;
            freezeDetector.freezeBallY = fb.y;
        } else if (freezeDetector.freezeWatchMs > 1500 && state.clockMs - freezeDetector.lastFreezeAlertMs > 5000) {
            Player* frozen = playerById(cid);
            Player* best = nullptr;
            if (frozen && frozen->role != Role::GK)
                // Round-29: graded receiver, not nearest — below the floor the
                // nudge branch below un-freezes him without gifting a bad ball.
                best = bestGradedReceiver(*frozen, 380.0, 0.2);
            if (frozen && best) {
                stats.recordSimulationFreeze();
                forcePassTo(*frozen, *best, nullptr);
            } else if (frozen) {
                stats.recordSimulationFreeze();
                double fd = fdFor(frozen->team);
                frozen->targetX = clamp(frozen->x + fd * 90.0, 35.0, PITCH_W - 35.0);
                frozen->targetY = clamp(frozen->y + (frozen->y < PITCH_H / 2 ? -45.0 : 45.0), 35.0, PITCH_H - 35.0);
            } else {
                freezeDetector.simulationFreezes++;
                stats.recordSimulationFreeze();
            }
            freezeDetector.lastFreezeAlertMs = state.clockMs;
            freezeDetector.freezeWatchMs = 0;
            freezeDetector.freezeBallX = fb.x;
            freezeDetector.freezeBallY = fb.y;
        }
    }
}

void GameEngine::auditStuckCarrier(double sdt) {
    // A held restart is SUPPOSED to be stationary — the taker stands at the spot
    // for the whole set-piece/kickoff hold (now seconds long under the restart-
    // pacing pass). Watching him here force-passed every corner/free-kick taker
    // ~2.7s into his hold (~50 false stuck-alerts per match). Same guard the
    // freeze detector has always had.
    if (setPiece.armed || phase.kickoffPhase || phase.halfTimePause > 0) {
        carrierTracker.watchedCarrierId = -1;
        carrierTracker.watchedCarrierMs = 0;
        return;
    }
    Player* carrier = playerById(state.ball.controllerId);
    // A keeper standing on the ball is NOT a stuck carrier — holding for
    // distribution is legitimate (legal up to 6s) and is now self-capped by the
    // GK distribution logic (initial delay + GK_MAX_HOLD_MS, then a forced punt).
    // Watching him here only produced a false-positive force-pass ~2.7s in, which
    // raced — and beat — his own hold cap. This watchdog is for OUTFIELD carriers
    // who genuinely wedge; leave the keeper to his distribution logic.
    if (carrier && carrier->role == Role::GK) {
        carrierTracker.watchedCarrierId = -1;
        carrierTracker.watchedCarrierMs = 0;
        return;
    }
    if (!carrier) {
        carrierTracker.watchedCarrierId = -1;
        carrierTracker.watchedCarrierMs = 0;
        return;
    }
    if (carrier->id != carrierTracker.watchedCarrierId) {
        carrierTracker.watchedCarrierId = carrier->id;
        carrierTracker.watchedCarrierX = carrier->x;
        carrierTracker.watchedCarrierY = carrier->y;
        carrierTracker.watchedCarrierMs = 0;
        return;
    }
    carrierTracker.watchedCarrierMs += sdt;
    double moved = dist(carrier->x, carrier->y, carrierTracker.watchedCarrierX, carrierTracker.watchedCarrierY);
    double carrierSpeed = std::hypot(carrier->vx, carrier->vy);
    if (carrierSpeed > 12.0) {
        carrierTracker.watchedCarrierX = carrier->x;
        carrierTracker.watchedCarrierY = carrier->y;
        carrierTracker.watchedCarrierMs = 0;
        return;
    }
    if (moved > STUCK_CARRIER_MOVE_THRESHOLD) {
        carrierTracker.watchedCarrierX = carrier->x;
        carrierTracker.watchedCarrierY = carrier->y;
        carrierTracker.watchedCarrierMs = 0;
        return;
    }
    double fd = fdFor(carrier->team);
    double forwardProgress = (carrier->x - carrierTracker.watchedCarrierX) * fd;
    if (forwardProgress > 30.0) {
        carrierTracker.watchedCarrierX = carrier->x;
        carrierTracker.watchedCarrierY = carrier->y;
        carrierTracker.watchedCarrierMs = 0;
        return;
    }
    if (carrierTracker.watchedCarrierMs > STUCK_CARRIER_TIMEOUT_MS * 0.65) {
        stats.recordStuckCarrier();
        // Round-29: graded receiver, not nearest (bestGradedReceiver skips
        // sent-off men — the round-21 phantom-target guard holds); when nobody
        // clears the floor the forward hoof below is the honest escape.
        Player* best = bestGradedReceiver(*carrier, 400.0, 0.2);
        if (best)
            forcePassTo(*carrier, *best, nullptr);
        else
            hoofClearToSpace(*carrier);
        setPiece.armed = false;
        setPiece.type = SetPiece::None;
        setPiece.team = Team::Home;
        setPiece.reason.clear();
        carrierTracker.watchedCarrierMs = 0;
        carrierTracker.watchedCarrierX = carrier->x;
        carrierTracker.watchedCarrierY = carrier->y;
    }
}
