// engine_gk_restart.cpp — the goalkeeper puts the ball back into play
//
// Split out of engine_setpiece.cpp (1378 lines: offside law, restart releases
// and restart awards in one TU). These two releases are half that file's length
// on their own, and they are the only ones whose taker is always the keeper.
//
// releaseGoalKick is the dead-ball restart from the six-yard box, with the
// Law 16 clear-the-area audit at the moment of release. releaseGoalkeeperDist-
// ribution is the ball IN HIS HANDS or at his feet in open play — the pressure
// read that chooses between a short feed to a safe outlet and the long punt, and
// the one restart the keeper's own agent can trigger (agent.cpp) rather than the
// set-piece phase. Both funnel their long option through the same puntLong.
//
// updateGoalKickMonitor rides here rather than with the other restart plumbing
// because releaseGoalKick is what arms goalKickMonitor: this is the tick-side
// half that decides whether the goal kick actually got the ball out (a stat, no
// simulation state) and closes the episode.

#include "engine.h"
#include "agent.h"
#include "agent_helpers.h"
#include "setpiece_weights.h"
#include <cmath>

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
    driveBall(b, dx, dy, d, speed);
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

    // Closing the distribution episode. Both exits below — the punt and the short
    // feed — wrote this same eight-line tail out longhand: re-arm goalKickMonitor
    // when the ball came from a goal kick, clear the retry timer, and drop the
    // hold clock so the next hold starts fresh. It is the same trap releaseRestart-
    // Ball was extracted for: an exit that forgot holdSinceMs would leave the
    // GK_MAX_HOLD_MS stopwatch running from the PREVIOUS hold, and nobody reading
    // one site would see it. One copy.
    auto endDistribution = [&]() {
        if (wasGoalKick) {
            goalKickMonitor.active = true;
            goalKickMonitor.team = holder.team;
            goalKickMonitor.startedMs = state.clockMs;
            stats.recordGoalKickAttempt();
        }
        goalKickMonitor.distributeTimer = 0;
        goalKickMonitor.holdSinceMs = -1;
    };

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
        double targetX, targetY;
        if (arenaMode && outlet) {
            // Round-21 (arena audit): a punt to the fixed fd*575 spot dropped into
            // an empty channel the lone CF had to chase from a standstill. Lead his
            // ACTUAL projected position (pos + velocity over the flight) so the ball
            // is contestable — he runs onto it instead of hunting a dead spot.
            double raw = dist(holder.x, holder.y, outlet->x, outlet->y);
            double eta = clamp(raw / 300.0, 0.4, 2.2);   // driven punt ~300px/s
            double leadX = outlet->x + outlet->vx * eta;
            double leadY = outlet->y + outlet->vy * eta;
            // Round-30 (arena audit D3/D4): once the punt actually REACHES its
            // lead point (see the range solve below) it must not drop onto a
            // marked man's toes — that is a 50/50 on the spot, and the arena
            // punt otherwise always leaves at v(300,~0) straight down the centre
            // line. Push the target sideways, off the punt axis, AWAY from the
            // receiver's nearest opponent: he runs onto it into space, and the
            // delivery finally varies laterally instead of tracing one corridor.
            double ux = leadX - holder.x, uy = leadY - holder.y;
            double ul = std::max(1.0, std::hypot(ux, uy));
            double perpX = -uy / ul, perpY = ux / ul;
            const Player* marker = nullptr;
            double markD = 1e9;
            for (const auto& o : state.players) {
                if (o.team == holder.team || o.sentOff || o.role == Role::GK) continue;
                double od = dist(o.x, o.y, outlet->x, outlet->y);
                if (od < markD) { markD = od; marker = &o; }
            }
            double side = 1.0;
            if (marker && (marker->x - outlet->x) * perpX + (marker->y - outlet->y) * perpY > 0.0)
                side = -1.0;
            // Only meaningful with a SECOND outfielder to cover the space (the
            // same gate agent_movement's nearest-chaser concept uses). In a 1v1
            // the lone receiver IS the only man who can reach it, so putting the
            // ball beside him just recreates the stall it was meant to cure
            // (measured: LOOSE_STALL 2.7 -> 10.9 per 10 min at N=1).
            double lateral = arenaOutfielders >= 2 ? ARENA_PUNT_SPACE : 0.0;
            targetX = clamp(leadX + perpX * side * lateral, 45.0, PITCH_W - 45.0);
            targetY = clamp(leadY + perpY * side * lateral, 55.0, PITCH_H - 55.0);
        } else {
            targetX = clamp(holder.x + fd * 575.0, 45.0, PITCH_W - 45.0);
            targetY = outlet ? outlet->y : (nearestPress ? (nearestPress->y < PITCH_H / 2.0 ? PITCH_H * 0.72 : PITCH_H * 0.28) : holder.y);
            targetY = clamp(targetY, 55.0, PITCH_H - 55.0);
        }
        double dx = targetX - holder.x, dy = targetY - holder.y;
        double d = std::max(1.0, std::hypot(dx, dy));
        auto& b = state.ball;
        b.controllerId = -1;
        placeBallForRelease(holder, dx, dy);
        b.lastTouchTeam = holder.team;
        b.lastToucherId = holder.id;
        // Feet-only hold (back-pass law): the long ball is a driven low punt
        // off the deck, never the from-hands launch. Both launches are decided
        // here because the arena punt has to SOLVE for its speed (below).
        // Round-45: with the back-pass law finally live this branch runs ~3x as often,
        // and the driven 120 vz ball travelled at head height through midfield: 84%
        // of them were lost (16-seed probe). A keeper clearing off the deck still
        // gets under it — lofted, just not the from-hands drop-kick height.
        double puntVz = gkHoldFeetOnly ? 260.0 : 300.0;
        double puntZ  = gkHoldFeetOnly ? 0.0 : 28.0;
        // Round-30 (arena audit D3): driveBall normalises the direction and
        // DISCARDS d, so a flat 300 always carried the ball ~575px — exactly
        // what the 11v11 branch above is calibrated for (targetX = fd*575), but
        // the arena branch aims at a LED receiver who is usually much nearer.
        // Every arena punt therefore overshot its outlet by ~275px and sat dead
        // while both strikers sprinted at it (the LOOSE_STALL x29 signature:
        // stall points exactly 575px from each goal, every ~14s). Solve the
        // launch speed that actually lands the ball on the lead point. The
        // 11v11 branch keeps its calibrated constant, untouched.
        double puntSpeed = 300.0;
        if (arenaMode && outlet)
            puntSpeed = driveSpeedForRange(std::max(d + ARENA_PUNT_RUN_ON, ARENA_PUNT_MIN_RANGE),
                                           puntVz, puntZ, 150.0, 400.0);
        driveBall(b, dx, dy, d, puntSpeed);   // 300 => ~108 km/h (was 119)
        b.vz = puntVz;
        b.z = puntZ;
        gkHoldFeetOnly = false;
        b.intendedReceiverId = -1;
        emitEvent("pass", holder.x, holder.y, holder.id, outlet ? outlet->id : -1); // tag the GK long distribution (audit #6)
        blockReboundFor(holder.id, 750);
        endDistribution();
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
        // Round-45 (a) ARRIVES WITH THE BALL (owner, seed 1110 77:52: "why would a
        // defender get caught like that? it's a one-in-500 games event"). Neuer
        // rolled it 14m to Chiellini with Messi 5.7m off the centre-back; Messi
        // arrived with the ball and won it on the first touch at the edge of the
        // box. Every gate here passed by a hair: nearestOpp read ~58px against the
        // 58px bar because Messi was drifting toward the OTHER centre-back at
        // release; the under-more-pressure guard below stopped at 140px and the
        // roll was 142; `trapped` wants TWO bodies. In the keeper's own third ONE
        // presser who can sprint to the receiver inside the roll plus a settling
        // touch is enough to make the ball unsafe — being wrong there is a shot.
        bool metOnArrival = false;
        if (progress < GK_OUTLET_DEEP_PROGRESS) {
            double arriveS = d / GK_OUTLET_ROLL_SPEED + GK_OUTLET_SETTLE_S;
            for (auto& o : state.players) {
                if (!isActiveOpponent(o, holder.team)) continue;
                double sprint = std::max(40.0, attrFactor(o.attrs.speed) * SPEED_SPRINT);
                if ((dist(o.x, o.y, p.x, p.y) - TACKLE_RANGE) / sprint < arriveS) {
                    metOnArrival = true;
                    break;
                }
            }
        }
        // Round-45 (b) RETURN TO SENDER. 7-8 times a match the keeper rolled it
        // straight back to the man who had just given it to him BECAUSE he was
        // pressed — and the press was still on him. He is an outlet again only
        // once he has genuinely got free.
        bool returnToPressedSender = p.id == runtime[holder.id].lastReceiveFrom && nearestOpp < GK_RETURN_OPEN_DIST;
        // "Safe" = near-certain to complete AND playable on arrival: a clean
        // lane, a receiver still open when the ball gets there, a short-to-mid
        // ball. The keeper releases only on these and otherwise HOLDS (he can't
        // be tackled — attemptTackle bails on a GK carrier — so waiting for a
        // lane costs nothing and never gifts it). Under a real swarm the bar
        // rises: a marginal short ball into a packed box is how the 3'16
        // penalty happened.
        double openNeed = closeKeeperPressure >= 2 ? 85.0 : 58.0;
        bool safe = clearLane && nearestOpp > openNeed && d < 320.0 && !trapped && !metOnArrival && !returnToPressedSender;
        // An UNPRESSURED keeper must not shovel a short ball to a man under
        // MORE pressure than himself (seed 111 22:37: a comfortable 1.68s
        // hold ended in a short pass to a pressed man in the box corner —
        // three first-touch clears and a turnover followed). Holding costs a
        // keeper nothing; a short ball must IMPROVE the picture.
        // Round-45: the d < 140 scope let a 142px roll into exactly this situation
        // through (seed 1110 77:52). A short ball must improve the picture at any range.
        if (nearestKeeperPressure > 60.0 && nearestOpp < nearestKeeperPressure - 10.0) safe = false;
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
        endDistribution();
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
    // Round-45: the swarmed branch used to feed the top-scored outlet WITHOUT the
    // safety test — no safe outlet existed (step 1 just tried them all), so by
    // construction it rolled the ball to a pressed man inside a crowded box.
    // Swarmed with nothing safe, a keeper clears his lines.
    if (closeKeeperPressure >= 3) {
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
        // Round-21 (arena audit): at max-hold the old code force-fed the best-
        // scored outlet regardless of its safe flag — drilling the ball through
        // the presser's lane into the marked lone striker, a deterministic
        // interception within 5s (arena: the CF is the only outlet and always
        // marked). Punt long instead when the best outlet isn't genuinely safe,
        // or when the sole outlet is marked tight (<60px). Only a safe outlet is
        // force-fed.
        bool badFeed = outs.empty() || !outs.front().safe;
        if (!badFeed && outs.size() == 1) {
            double nd = 1e9;
            for (auto& o2 : state.players)
                if (isActiveOpponent(o2, holder.team))
                    nd = std::min(nd, dist(o2.x, o2.y, outs.front().p->x, outs.front().p->y));
            if (nd < 60.0) badFeed = true;
        }
        if (badFeed) { puntLong(); return; }
        for (auto& o : outs) {
            if (!o.safe) continue;
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
