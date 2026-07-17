#include "agent.h"
#include "agent_helpers.h"
#include "engine.h"
#include <optional>
#include <unordered_map>
#include <algorithm>

// ══════════════════════════════════════════════════════════════════════════════
// scorePassToTarget() — scores a single teammate as a pass target
// Returns nullopt if the target should be filtered out.
// ══════════════════════════════════════════════════════════════════════════════
std::optional<Action> PlayerAI::scorePassToTarget(Player& t, const Perception& per,
    double fd, double ownGoalX, double ownProgress, bool hasClearOutfieldOutlet,
    bool urgentKeeperNeed, bool movingTowardOwnGoal, bool corneredEscape, bool oppClosingSoon)
{
    const auto& p = player;

    // ── Gate checks ──
    if (t.sentOff) return std::nullopt;   // never pass to an ejected team-mate (parked off-pitch)
    // The keeper is a valid pass target when urgently needed, OR as a deliberate
    // SAFE recycle for a pressed defender / deep midfielder in his own third — he
    // then distributes safely (play out from the back). The score below keeps it
    // from being spammed: it only wins when the forward options are genuinely poor.
    // A PRESSED deep defender gets the valve regardless of hasClearOutfieldOutlet
    // (watched replay seed 129 0:36-0:40: the FB's "clear outlets" were the very
    // passes the dwell gate had priced to -1.3, so the keeper never scored and
    // the carrier was tackled holding a menu of unplayable options — real
    // defenders recycle via the GK constantly under press).
    bool nearOwnThirdForGk = ownProgress < PITCH_W * 0.42;
    // The pressed-recycle valve is a DEEP defender's escape (own 36%), not a
    // midfield option — at 0.42W the keeper's touches doubled (85/90 vs real
    // ~40) as halfway-line carriers cycled him into ordinary possession.
    bool keeperRecycle = ownProgress < PITCH_W * 0.36 && isDefenderLike()
        && ((oppClosingSoon && per.nearestOpponentDist < 110.0) || per.pressureCount >= 2
            || (per.pressureCount >= 1 && !hasClearOutfieldOutlet));
    // NOTE: a static-tight admission (marker <45px, outlets open) was A/B'd
    // twice for the 0:42 trapped-squares case and REVERTED — keeper ping-pong
    // blew to 112 then 96 backpasses/90 (real ~30-40). The safe-angle support
    // drop + oppClosingSoon term cover that moment without the flood.
    bool keeperOutlet = t.role == Role::GK && ((urgentKeeperNeed && !hasClearOutfieldOutlet) || keeperRecycle);
    if (t.role == Role::GK && !keeperOutlet) return std::nullopt;
    double d = dist(p.x, p.y, t.x, t.y);
    if (d < PASS_MIN_DISTANCE || d > (keeperOutlet ? PASS_MAX_DISTANCE_KEEPER : PASS_MAX_DISTANCE)) return std::nullopt;
    if (!keeperOutlet && engine.isOffsideTargetPerceived(p, t)) return std::nullopt;

    int bl = 0;
    int onBootBl = 0;
    double laneRisk = 0.0;
    double dx = t.x - p.x, dy = t.y - p.y, ls = dx * dx + dy * dy;
    if (ls < 1.0) return std::nullopt;

    int pointBlank = 0;
    // A ball struck before it's settled cannot be THREADED past a close man
    // (seed 305 1:12: 4R's first-time interception-clearance drilled straight
    // into 8B parked 4.8px off the lane, 60px in front — outside the 42px
    // point-blank gate). Fresh releases widen the gate to 70px; the settled
    // carrier keeps 42 (the pointBlank tombstone below: pricing these harder
    // for EVERYONE made pressed carriers hold, the uglier failure).
    double heldPb = engine.state.clockMs - engine.carrierTracker.carryStartMs;
    bool freshRelease = (engine.carrierTracker.carryTrackerId == p.id && heldPb < 500.0)
        || (p.id >= 0 && p.id < 22 && engine.firstTouchUntilMs[p.id] > engine.state.clockMs);
    double pbRadius = freshRelease ? 70.0 : 42.0;
    for (auto& o : engine.state.players) {
        if (!isActiveOpponent(o, p.team)) continue;
        double t2 = clamp(((o.x - p.x) * dx + (o.y - p.y) * dy) / ls, 0.0, 1.0);
        double perp = std::sqrt((o.x - p.x - t2 * dx) * (o.x - p.x - t2 * dx)
                              + (o.y - p.y - t2 * dy) * (o.y - p.y - t2 * dy));
        // STEP-IN realism (user 0:40 Kovac + the Okafor pass): a defender CLOSING on the lane reaches
        // FURTHER than his static perp suggests — he'll be nearer by the time the ball arrives. So a
        // closer's effective BLOCKER radius extends with his speed TOWARD the closest-approach point
        // (Kovac stepped in from 40px at ~48px/s and cut a slow build-up ball). A defender drifting
        // AWAY keeps the static radius, so a pass into a vacating lane isn't over-penalised. The graded
        // mid-lane risk (50% of interceptions are a step-in, ZERO strict blockers) is otherwise intact.
        double cx = p.x + t2 * dx, cy = p.y + t2 * dy;
        double tlx = cx - o.x, tly = cy - o.y, tld = std::hypot(tlx, tly);
        double closing = tld > 1.0 ? (o.vx * tlx + o.vy * tly) / tld : 0.0;   // px/s toward the lane
        double effBlocker = PASS_BLOCKER_PERP + clamp(closing / 50.0, 0.0, 1.0) * 13.0;
        bool onBootPresser = t2 < 0.05 && dist(o.x, o.y, p.x, p.y) < 42.0;
        // Step-in RACE (watched replay seed 111 1:13): an ALREADY-CLOSING mid-lane
        // defender who reaches his gate before the ball does is a blocker, however
        // far his static perp is. Messi at perp 58.6 closing 47px/s sat ~10px
        // outside the max step-in radius, priced as soft laneRisk, and cut the
        // lateral ball across Chiellini's own D 650ms later. Already-closing
        // (>25px/s) waives the reaction lag a flat-footed defender would pay —
        // he has committed; a static body keeps the old radius so tight-but-
        // standing markers don't double count.
        bool stepInWins = false;
        if (perp >= effBlocker && perp < 112.0 && t2 > 0.10 && t2 < 0.92 && closing > 25.0) {
            // 0.82: average in-flight drag — the launch-speed estimate gave the
            // stepper ~18% less time than the ball actually takes to reach his
            // gate, which is how the 1:14/1:29 (seed 437) covered-lane balls
            // priced as playable.
            double passSpeed = 0.82 * std::min(std::max(150.0 + d * 0.32, PASS_SPEED_BASE + d * PASS_SPEED_DIST), 300.0);
            double tGate = t2 * d / passSpeed;                       // when the ball crosses his gate
            double sprint = std::max(80.0, attrFactor(o.attrs.speed) * SPEED_SPRINT);
            stepInWins = (perp - 18.0) / sprint + 0.05 < tGate;
        }
        if (perp < effBlocker || stepInWins) {
            bl++;
            if (onBootPresser) onBootBl++;
        }
        else if (perp < 112.0 && t2 > 0.10 && t2 < 0.92) laneRisk += clamp((112.0 - perp) / 76.0, 0.0, 1.0);
        // Opponent right on the boot at release, in the NEAR half of the lane:
        // near-certain deflection that the wide lane radius under-weighted
        // (passes straight into a marker 17px away looked like normal
        // 1-blocker passes). t2<0.5 so it's a body in FRONT of the passer,
        // not one hovering by the receiver.
        if (perp < 17.0 && t2 < 0.5 && dist(o.x, o.y, p.x, p.y) < pbRadius) pointBlank++;
        // TOMBSTONE (seed 133 0:04, presser at the boot stepping across the
        // release): pricing these harder was tried twice — a pointBlank veto
        // (completion -7.0pts, marathon carries 8.5->16) and a graded double
        // count (completion -5.2, senseless giveaways +3.6). Both starved the
        // pressured carrier of his outlets and made him HOLD, which is the
        // uglier failure. The step-in effBlocker above already prices the
        // closing presser once; the residual 0:04-class pick stays accepted.
    }
    double fp = pitch::forwardGain(p.x, t.x, p.team);
    double nearestOppRecv = 1e9;
    for (auto& o : engine.state.players)
        if (o.team != p.team && o.role != Role::GK && !o.sentOff)
            nearestOppRecv = std::min(nearestOppRecv, dist(o.x, o.y, t.x, t.y));
    // An opponent standing ON THE CARRIER'S BOOT (within pressing contact, at
    // the lane's origin) presses the CARRIER, not a lane — but exempting him
    // from EVERY lane flooded releases match-wide (+50% pass volume; his
    // blocker count is load-bearing for the possession tempo the brake sets).
    // Scope the exemption to the pressed ESCAPE ball only: the backward safe
    // out while cornered or with a tackle arriving — the class the double-
    // count starved (watched replay seed 129 0:20-0:24: a cornered winger's
    // easy CB out-ball priced 0.55 instead of ~0.79 because BOTH on-boot
    // pressers counted on it, and he carried into the corner until the release
    // watchdog fired). The pointBlank veto below still kills the lane the
    // presser IS standing in (perp<17).
    if (onBootBl > 0 && fp < -20.0
        && (corneredEscape || (oppClosingSoon && ownProgress < PITCH_W * 0.42)))
        bl = std::max(0, bl - onBootBl);
    // A man point-blank in the near lane is fatal EVEN under pressure — you
    // cannot thread the ball past a defender 3-4m directly in front however
    // swarmed you are (watched replay 0:38: a pressed Messi fired a hard
    // backpass straight into Busquets 7px off the lane because the veto was
    // disabled at pressureCount>=2; he should shield/spin instead).
    if (bl >= 3 || pointBlank > 0) return std::nullopt;
    double rs = attrFactor(p.attrs.passing);
    double rr = attrFactor(t.attrs.positioning);

    int receiverPressure = 0;
    for (auto& o : engine.state.players) {
        if (o.team != p.team && o.role != Role::GK && !o.sentOff && dist(o.x, o.y, t.x, t.y) < PASS_RECEIVER_PRESS_MAX) receiverPressure++;
    }
    // The opposing KEEPER owns his zone (watched replay seed 111 1:35: a through
    // ball led 100px past the runner scored rpEff=0/blEff=0 because every
    // opponent loop filters GK — Neuer, set 76px away, collected uncontested).
    // A receive point near the opposing GK inside his defensive quarter counts
    // as pressed; outfield loops elsewhere still ignore him (he never presses
    // upfield).
    for (auto& o : engine.state.players) {
        if (o.team == p.team || o.role != Role::GK || o.sentOff) continue;
        if (pitch::distToOwnGoal(t.x, o.team) < PITCH_W * 0.25
            && dist(o.x, o.y, t.x, t.y) < PASS_RECEIVER_PRESS_MAX * 1.4) receiverPressure++;
    }
    if (receiverPressure >= 3) return std::nullopt;

    // ── Base scoring ──
    // Chip-aware blocker pricing: passBallTo already LOFTS a blocked lane at
    // range (blockers>0 && d>120 => elevation), so bodies on a longer lane
    // cost less than the flat-ball price said — the lofted diagonal over the
    // line was "quite likely at this level" (watched replay 0:50) yet scored
    // as if it would be cut on the ground. Short passes keep the full price
    // (no room to get it up and over).
    double blCost = bl * (d > 170.0 ? 0.18 : 0.23);
    double completion = clamp(
        0.89 + rs * 0.10 + rr * 0.06 - d / PASS_DIST_NORMALIZATION * 0.28 - blCost
            - std::min(laneRisk, 2.2) * 0.10 - receiverPressure * 0.15 - (fp > 130.0 ? 0.05 : 0.0),
        0.08, 0.98);
    // First-touch discount (owner, seed 111 2:05: "first touch is harder —
    // make sure that's in mechanics"): a ball released before the carrier has
    // settled it is likelier sprayed than the space model says — the execution
    // side now genuinely sprays it (passBallTo freshTouch), so the scorer must
    // price that in or the agent keeps choosing the 43m first-time switch.
    // Short lay-offs stay cheap; long and across-the-body pays most.
    {
        double heldMs = engine.state.clockMs - engine.carrierTracker.carryStartMs;
        if (engine.carrierTracker.carryTrackerId == p.id && heldMs < 500.0) {
            double wantAng = std::atan2(t.y - p.y, t.x - p.x);
            double offF = std::abs(std::atan2(std::sin(wantAng - p.facing), std::cos(wantAng - p.facing)));
            completion -= clamp(d / 260.0, 0.0, 1.0)
                        * (0.10 + 0.14 * clamp((offF - 0.4) / 1.6, 0.0, 1.0));
        }
    }
    // ── Arrival contest ── a long ball hangs long enough for a defender to beat
    // it to the receive point: price the race explicitly. The step-in blocker
    // model extends reach by at most 13px (~0.26s of closing) while a 450px
    // ball flies ~1.6s — the watched 0:26.4 "mindless pass" needed its
    // interceptor to move at walking pace (20px/s over the flight) yet priced
    // as a normal 1-blocker ball. Opponents already inside the receiver-press
    // radius are priced above — this term is the RANGE extension only.
    // ...and for a PRESSED passer's own-third lateral the race runs from 130px
    // up (seed 111 1:24: a 151px lateral from 302px out, presser on the boot,
    // cut by a reader at t2=0.93 — under 240 it skipped every race and priced
    // as a clean switch, outbidding the safe keeper ball). Calm build-up
    // laterals skip it — racing them all starved the deep short menu under
    // the build floor and clearances blew 164 -> 273/90.
    if (d > 240.0 || (d > 130.0 && fp < 40.0 && ownProgress < PITCH_W * 0.34 && oppClosingSoon)) {
        double tFlight = d / std::min(std::max(150.0 + d * 0.32, PASS_SPEED_BASE + d * PASS_SPEED_DIST), 300.0);
        double tOpp = 1e9;
        for (auto& o : engine.state.players) {
            if (!isActiveOpponent(o, p.team)) continue;
            double od = dist(o.x, o.y, t.x, t.y);
            if (od < PASS_RECEIVER_PRESS_MAX) continue;
            double sprint = std::max(40.0, attrFactor(o.attrs.speed) * SPEED_SPRINT);
            tOpp = std::min(tOpp, (od - 18.0) / sprint);
        }
        completion -= clamp(tFlight - tOpp, 0.0, 1.2) * 0.25;
        // STEP-IN RACE on the LANE, not just the receive point (seed 305 0:35):
        // the 326px switch was cut by a CF who jogged 57px sideways to the
        // lane's closest-approach point — he was 102px from the RECEIVER (the
        // race above scored him ~even) but only had to beat the ball to his
        // own gate at t2=0.76. Race every opponent to HIS point on the lane; a
        // man who reaches it before the ball crosses is a pick however far he
        // is from the target. Scoped to non-killer balls (fp < 60): switches
        // and recycles — the deliberate in-behind classes already price their
        // lanes via rpEff/blEff and must keep their aggression.
        if (fp < 60.0) {
            double laneRace = 0.0;
            double ux = dx / std::sqrt(ls), uy = dy / std::sqrt(ls);
            double passSpd = std::min(std::max(150.0 + d * 0.32, PASS_SPEED_BASE + d * PASS_SPEED_DIST), 300.0);
            for (auto& o : engine.state.players) {
                if (!isActiveOpponent(o, p.team)) continue;
                double t2 = clamp(((o.x - p.x) * ux + (o.y - p.y) * uy) / d, 0.15, 0.90);
                double perp = dist(o.x, o.y, p.x + ux * t2 * d, p.y + uy * t2 * d);
                if (perp < 20.0 || perp > 130.0) continue;   // <20 already blocker/laneRisk; >130 can't make the gate
                double tGate = t2 * d / passSpd;
                double sprint = std::max(60.0, attrFactor(o.attrs.speed) * SPEED_SPRINT);
                double tReach = (perp - 16.0) / sprint;
                if (tReach + 0.05 < tGate)
                    laneRace = std::max(laneRace, clamp((tGate - tReach) * 0.8, 0.0, 0.30));
            }
            completion -= laneRace;
        }
    }
    // play_it_long: direct sides gamble on lower-completion (longer) balls. 0 by
    // default => floor stays 0.44 => the no-directive match is unchanged.
    double longBall = engine.teamTactics[teamIndex(p.team)].longBallBias;
    // Press-pinned RELIEF (watched replay seed 111 0:00-1:30: the pressing side
    // committed 7-8 into blue's half, Ronaldo stood unmarked upfield in 100% of
    // frames, and the 328px relief ball priced ~0.41 — vetoed here and by the
    // build-up floor, so blue recycled 33-114px squares until picked off at
    // x~700. Real teams go long against a full press). A deep carrier whose
    // half is FLOODED (6+ opponents) may play the honest 50/50 relief to a
    // genuinely unmarked man well upfield.
    bool reliefBall = false;
    if (fp > 180.0 && d > 240.0 && ownProgress < PITCH_W * 0.42 && t.role != Role::GK) {
        double recvOpen = 1e9;
        int oppInOurHalf = 0;
        for (auto& o : engine.state.players) {
            if (!isActiveOpponent(o, p.team)) continue;
            recvOpen = std::min(recvOpen, dist(o.x, o.y, t.x, t.y));
            if (pitch::forwardProgress(o.x, p.team) < PITCH_W * 0.5) oppInOurHalf++;
        }
        reliefBall = oppInOurHalf >= 6 && recvOpen > 90.0;
    }
    if (completion < (reliefBall ? 0.36 : 0.44) - longBall * 0.24) return std::nullopt;   // play_it_long: allow riskier long balls

    // Blind-pass gate (watched replay seed 133 0:04/0:56: launches 163°/145°
    // off the passer's FACING — no-look bombs "the player isn't even facing
    // that direction"). Beyond ~140° off facing the ball is not a candidate at
    // all; 93°-140° pays a stiff price so it only wins when clearly best. The
    // scorer re-runs every tick and facing tracks motion, so a genuinely right
    // backward ball still gets played — one beat later, body turned, like a
    // real player. Dead-ball takers are exempt (they address the ball freely).
    double passAngF = std::atan2(dy, dx);
    double offFacing = std::abs(std::atan2(std::sin(passAngF - p.facing), std::cos(passAngF - p.facing)));
    // A PRESSED carrier deep in his own territory (or pinned/cornered) keeps the
    // behind-him ball as a PRICED candidate instead of a hard veto: his escape
    // dribble rotates his facing away from his own support, and the veto then
    // deleted every backward outlet exactly when they were needed (watched
    // replay seed 129 0:39-0:40: the FB's menu emptied the instant his facing
    // turned upfield, and the keeper/CB recycle never existed). Execution stays
    // honest: the turn-then-release path rotates the body over 2-3 ticks before
    // the ball goes, so this never releases an actual 160° no-looker — the calm
    // no-look bombs the veto was built for (seed 133 0:04/0:56) stay vetoed.
    bool pressedDeepTurn = (oppClosingSoon && ownProgress < PITCH_W * 0.42)
        || keeperOutlet || corneredEscape;
    if (!engine.setPiece.armed) {
        if (offFacing > 2.45 && !pressedDeepTurn) return std::nullopt;
        if (offFacing > 2.45)      completion *= 0.76;
        else if (offFacing > 1.62) completion *= 0.80;
    }

    // ── G1 BUILD-UP LOOK (user 2026-06-27: "still prototype, make it look better") ──
    // In our own build-up third the defenders were pinging mid-completion balls to each
    // other that get picked off — reads aimless, not "patiently probe for a gap". Demand
    // a HIGHER completion floor here UNLESS the pass genuinely breaks a line into a real
    // gap (forward, unmarked receiver, clean lane). The keeper recycle (keeperOutlet) is
    // excluded so there is always a safe valve — this can't stall the build-up, only make
    // it pick the safe keep until a gap opens. play_it_long sides bypass it (they commit).
    // A PRESSED carrier's short clean out-ball bypasses the floor: the floor
    // exists to make CALM build-up probe patiently, and its own design note
    // promises "there is always a safe valve — this can't stall the build-up".
    // Under an arriving press the safe valve set must include the short escape
    // to an unmarked man with a clean lane, or the carrier stands holding
    // unplayable options until he's tackled (seed 129 0:37-0:40).
    bool pressedSafeOut = oppClosingSoon && d < 260.0 && receiverPressure == 0 && bl == 0;
    // Led-runner bypass (seed 437 0:40: the clearly-on over-the-top to Neymar
    // was FLOORED here before the killer-ball classes ever evaluated it — his
    // CURRENT feet read near-lateral while his run was a line-break). A ball
    // in behind to a flying attacker with a genuinely open reception is not
    // timid own-half build-up; same goalward-sprint test the killer classes
    // use, computed early.
    bool ledRunnerBypass = false;
    // Tight gates (first cut at completion>=0.50/rfs>26/any range blew through
    // balls 73 -> 178/90 — the exact volume regression the tombstones warn
    // about): killer-ball RANGE only, a genuine full sprint, a clearly open
    // reception, and a solid completion floor of its own.
    if (roles::isAttacker(t.role) && completion >= 0.55 && nearestOppRecv > 85.0
        && d >= 230.0 && d <= 520.0) {
        double fdB = fdFor(p.team);
        double tgx = goalXFor(p.team) - t.x, tgy = PITCH_H / 2.0 - t.y;
        double tgl = std::hypot(tgx, tgy);
        double spdT = std::hypot(t.vx, t.vy);
        double rfs = t.vx * fdB;
        if (tgl > 1.0 && tgl < 320.0 && spdT > 34.0) {
            double radial = (t.vx * tgx + t.vy * tgy) / tgl;
            if (radial > spdT * 0.55) rfs = std::max(rfs, radial);
        }
        ledRunnerBypass = rfs > 40.0;   // full flight only — 34 still fed the volume dial
    }
    if (!keeperOutlet && !pressedSafeOut && !reliefBall && !ledRunnerBypass && longBall <= 0.0 && ownProgress < PITCH_W * 0.42) {
        bool breaksLine = fp > 120.0 && receiverPressure == 0 && bl == 0 && laneRisk < 0.8;
        double buildFloor = breaksLine ? 0.50 : 0.66;
        if (completion < buildFloor) return std::nullopt;
    }

    double progression = clamp(fp / 240.0, -0.5, 1.0);
    double turnoverCost = ((p.team == Team::Home) ? p.x < PITCH_W * 0.38 : p.x > PITCH_W * 0.62) ? 0.42 : 0.25;
    // Own-CORNER escapes are the highest-leverage giveaway on the pitch (seed
    // 133 1:19: a cornered FB threaded infield instead of clearing/using his
    // keeper — picked off, instant chance). Losing it there must terrify.
    if (pitch::distToOwnGoal(p.x, p.team) < 190.0 && pitch::lateralFromCenter(p.y) > 200.0)
        turnoverCost = 0.62;
    // passingDirectness (centred at 50): high -> reward forward passes more and
    // value safe recycling less (vertical, direct); low -> patient possession.
    double directness = engine.configFor(p.team).passingDirectness / 50.0; // 0..2, 1 at 50
    double sc = completion * (0.34 + std::max(0.0, progression) * 0.27 * directness) - (1.0 - completion) * turnoverCost;   // Round-20: progression reward 0.34->0.27 (~20%) to ease the forward scoring tilt (59% fwd)
    if (reliefBall) sc += 0.12;   // press-pinned escape beats the 15th sterile square recycle
    if (!engine.setPiece.armed && offFacing > 1.62) sc -= offFacing > 2.45 ? 0.24 : 0.14;   // blind-pass tax on top of the completion hit (stiffer past the old veto line)
    if (longBall > 0.0 && fp > 80.0) {                          // play_it_long: make the direct long ball win
        sc += longBall * (0.38 + std::min(fp, 360.0) / 360.0 * 0.46);   // longer => bigger reward (boosted to commit)
        sc += (1.0 - completion) * turnoverCost * longBall * 0.8;       // forgive most of the long-ball risk
    }
    double recycleMul = clamp(2.0 - directness, 0.4, 1.6); // direct sides recycle less
    // play_it_long also SUPPRESSES safe recycling — a long-ball side stops passing
    // it square and commits forward. This is what makes the order actually "commit".
    double recycleSuppress = clamp(1.0 - longBall * 0.7, 0.2, 1.0);
    // laneRisk < 0.7 (seed 437 0:03; 0.6 demoted too many ordinary safe balls and shifted arbitration toward risky forward ones): a defender READING the lane must not be
    // priced as a secure connector — Iniesta's first pass of the match went to
    // the wide man with a jogging interceptor 54px abeam (laneRisk 0.76, cut
    // out 500ms later) and still banked the safeConnector + patient-build
    // stack, beating the genuinely clean 11m square. Demotion, not veto:
    // the contested ball can still win on its own merit.
    bool safeConnector = completion > 0.74 && bl == 0 && receiverPressure == 0 && d < 300.0 && fp > -45.0 && fp < 95.0 && laneRisk < 0.7;
    bool recyclePass = completion > 0.78 && bl == 0 && receiverPressure == 0 && d < 260.0 && fp >= -80.0 && fp <= 25.0 && laneRisk < 0.7;
    if (safeConnector) sc += (ownProgress < PITCH_W * 0.68 ? 0.18 : 0.10) * recycleMul * recycleSuppress;
    if (recyclePass) sc += (per.pressureCount <= 1 ? 0.12 : 0.20) * recycleMul * recycleSuppress;
    if ((recyclePass || safeConnector) && engine.directiveBias[p.id].simplifyBias > 0.0)
        sc += engine.directiveBias[p.id].simplifyBias;          // "keep it simple / pass it around"
    // slow_it_down (team-wide): keep the ball, take no risks — reward the safe
    // option and shun low-completion balls so the side knocks it around. Dedicated
    // hook because the dial deltas were swamped by the clamp. 0 => no effect.
    double slowT = engine.teamTactics[teamIndex(p.team)].slowTempo;
    if (slowT > 0.0) {
        if (safeConnector || recyclePass) sc += slowT * 0.16;
        sc -= slowT * (1.0 - completion) * 0.40;
    }
    // PATIENT BUILD-UP (defensive-shape redesign §3): completely unpressed in our
    // own half — CIRCULATE rather than force it. Reward the safe keep and shun the
    // risky/forward ball, so the side strings a long possession instead of gifting it
    // with a hopeful direct pass. Pairs with the mid-block + forwards-drop: the
    // opponent holds off, so pressureCount==0 happens often here and 20+ moves form.
    // G1: also reward safe retention under LIGHT pressure (==1), not just fully unpressed
    // — that is exactly when the aimless risky ping happened. Scale the keep-bonus down a
    // touch when pressed so the side still progresses when a real forward gap is on.
    if (per.pressureCount <= 1 && ownProgress < PITCH_W * 0.5) {
        double pressScale = per.pressureCount == 0 ? 1.0 : 0.65;
        // A square into a man with a marker at his back is not "patient
        // circulation", it is the sterile ping the owner keeps flagging —
        // the keep bonus thins as the receiver's space disappears (2:26).
        double openScale = clamp((nearestOppRecv - 30.0) / 50.0, 0.55, 1.0);
        // Round-20: thinned 0.30 -> 0.20 (~a third) — the patient-circulation
        // keep-bonus was over-rewarding the sterile square recycle and inflating
        // pass volume (876 -> target 550-700/team/90). Mechanism kept; magnitude cut.
        if (safeConnector || recyclePass) sc += 0.20 * pressScale * openScale;
        sc -= (1.0 - completion) * 0.45;
    }
    if (keeperOutlet) {
        // Priced to win only under duress: the closing-press term is what lets a
        // defender play it back BEFORE the tackler arrives (0:40 class) — a calm
        // carrier's keeper ball stays a last resort.
        sc += 0.04 + per.pressureCount * 0.05 + (oppClosingSoon ? 0.08 : 0.0)
            + (movingTowardOwnGoal ? 0.06 : 0.0);
        if (bl == 0) sc += 0.02;
    }
    if (t.id == lastPassTargetId) sc -= 0.18;

    if (recentPassTarget == t.id && engine.state.clockMs - recentPassTime < 3000.0) sc -= 0.10;

    if (bl == 0 && fp > 80.0) sc += completion > 0.70 ? 0.06 : 0.02;
    bool carrierFinalThird = pitch::inFinalThird(p.x, p.team);
    // USERWATCH A1 (~3:23: carrier stripped with a safe backpass on): under HEAVY pressure a
    // SECURE outlet (unmarked teammate + clear lane) beats getting dispossessed — waive the
    // backward-pass penalty + add a retention bonus so the carrier plays safe instead of forcing it.
    // corneredEscape arms the same waiver from ground-truth carrier pressure: a
    // touchline-pinned or regressing carrier whose second presser sits outside
    // the perception cone "felt" pc=1 for a whole 7s corner trap (seed 129
    // 0:23) while the easy CB out-ball paid full backward penalties and never
    // reached arbitration. Owner: "prioritize finding an easy pass e.g. to 3
    // if being cornered like that."
    bool securePressuredOutlet = (per.pressureCount >= 2 && per.nearestOpponentDist < 40.0
                              && receiverPressure == 0 && bl == 0)
                              || (corneredEscape && receiverPressure == 0 && bl == 0);
    // Open-switch waiver (2:26 class): the ball across to a genuinely FREE
    // wide man is how real teams change the angle — it paid full backward
    // taxes while the marked square collected the retention stack, a ~0.6
    // structural spread the openness of the receiver never entered (openness
    // had zero weight outside the forward killer classes).
    bool openSwitch = nearestOppRecv > 85.0 && pitch::lateralFromCenter(t.y) > 120.0
        && std::abs(t.y - p.y) > 150.0 && completion >= 0.64 && fp > -110.0;
    if (!keeperOutlet && !securePressuredOutlet && !openSwitch && fp < -30.0) sc -= carrierFinalThird ? 0.28 : 0.16;
    if (!keeperOutlet && !securePressuredOutlet && !openSwitch && fp < -90.0) sc -= carrierFinalThird ? 0.30 : 0.18;
    if (openSwitch) sc += 0.08;
    // Receiver openness has universal (small) weight: a free man is worth
    // more than a marked one for the SAME geometry, everywhere on the pitch.
    if (!keeperOutlet) sc += clamp((nearestOppRecv - 55.0) / 130.0, 0.0, 1.0) * 0.10;
    if (!keeperOutlet && carrierFinalThird && per.pressureCount == 0 && fp < 0.0) sc -= 0.12;
    if (securePressuredOutlet) sc += 0.18;

    double dg2 = std::abs(p.x - (goalXFor(p.team)));
    if (dg2 < 200.0 && fp > 0.0 && d < 150.0) sc += 0.10;

    // ── Wide delivery classification ──
    double dgW = dg2;
    // A ball into a CENTRAL, roughly-onside attacker in behind is a THROUGH
    // ball, not a wide delivery — even from a wide player (seed 111 0:11:
    // RED9(WM)->RED10(CF) satisfied goodThroughWindow's whole geometry but
    // this tag shunted it into the cutback branch, where every killer class
    // is switched off, and it died as a bare +0.18 recycle).
    bool inBehindCentral = false;
    {
        double olW = engine.offsideLineFor(p.team);
        double ogW = std::isnan(olW) ? 1e9 : (olW - t.x) * fdFor(p.team);
        // Tight window (the 170px onside band reclassified enough wide-player
        // balls to blow Through volume +23/90): only the man genuinely ON THE
        // SHOULDER, central, final 30m.
        inBehindCentral = roles::isAttacker(t.role)
            && ogW > -12.0 && ogW < 80.0
            && pitch::lateralFromCenter(t.y) < 120.0
            && pitch::distToOppGoal(t.x, p.team) < 300.0;
    }
    bool isWideDelivery = isWidePlayer()
        && !inBehindCentral
        && dgW < 430.0
        && pitch::lateralFromCenter(p.y) > 75.0
        && std::abs(t.x - (goalXFor(p.team))) < 310.0
        && pitch::lateralFromCenter(t.y) < 210.0
        && fp > -120.0;

    double boxTargetGoalDist = pitch::distToOppGoal(t.x, p.team);
    // §C Stage 2: a DEEP (byline) carrier can cut back to a now-onside CLOSE runner — once b.x is deep
    // the near-post runner is legally onside-close (max(line,b.x)=b.x), so widen the cutback target zone
    // (goalDist>45, y<215) for a deep carrier to let that 6-yard tap-in route qualify for the +0.54 cutback.
    bool deepCarrier = dgW < 140.0;
    // NOTE: the 245 outer gate means the +0.54 cutback premium also pays out on
    // ~24m lay-backs (receiver median tgd 250 at delivery, only 3/48 inside the
    // 175 first-time-finish gate — 2026-07-02 audit). Tightening was A/B'd
    // TWICE and rejected twice: 190 pre-box-burst (carriers switched to whips,
    // headed 25%->36%), and 200 post-box-burst (2026-07-02, 48 paired seeds:
    // close goals 10->6 — WRONG direction — cutbacks 41->34/match, crosses up).
    // The gate is not the lever: receivers are simply never in the band at
    // decision time despite box-burst SPEED. Stage 2 must make the runner's
    // POSITION TARGET sit in the 80-140 band earlier in the move (positioning
    // candidates + arbitration weight), then re-test this gate.
    bool centralBoxTarget = pitch::lateralFromCenter(t.y) < (deepCarrier ? 215.0 : 185.0)
        && boxTargetGoalDist > (deepCarrier ? 45.0 : 75.0) && boxTargetGoalDist < 245.0;
    bool aerialTarget = isWideDelivery
        && t.role == Role::CF
        && pitch::lateralFromCenter(t.y) < 150.0
        && boxTargetGoalDist > 95.0 && boxTargetGoalDist < 210.0
        && fp > -15.0
        && receiverPressure <= 1;
    bool cutbackTarget = isWideDelivery
        && pitch::lateralFromCenter(p.y) > 110.0
        && !aerialTarget
        && centralBoxTarget
        && (t.role == Role::CF || t.role == Role::CM || t.role == Role::WM)
        && fp < 75.0;
    // cross_early extends the cross window deeper (whip it in early, don't dribble
    // to the byline first).
    double crossRange = engine.directiveBias[p.id].crossEarly ? 420.0 : 300.0;   // 340 -> 300: cross volume ran ~95/90 (~2.5x real); the supply gate protects quality, this trims supply
    // §C byline-carry: an UNPRESSED wide carrier still far out should carry to the BYLINE (the dribble
    // byline-seek) rather than crossing early -> shrink the cross window so the deeper carry + onside
    // cutback wins. Pressed / crossEarly-directive carriers still whip it in early (unchanged).
    if (isWideDelivery && per.pressureCount == 0 && pitch::lateralFromCenter(p.y) > 120.0
        && dgW > 110.0 && !engine.directiveBias[p.id].crossEarly)
        crossRange = 215.0;
    bool isCross   = isWideDelivery && !cutbackTarget && dgW < crossRange
        && pitch::lateralFromCenter(p.y) > 120.0 && (fp > -45.0 || aerialTarget);
    bool isCutback = isWideDelivery && !isCross;

    // BP1 (backward-pass audit, user "180-degree unrealistic passes"): the scorer never read facing,
    // so a BLIND pass played behind where the passer is LOOKING scored like any other. Penalise ONLY a
    // genuinely blind backpass (>135deg off the facing) in CALM possession that is NOT a sanctioned or
    // creative backward ball — keeper outlet, secure pressured escape, cross, and CUTBACK are all legit
    // backward and excluded (a cutback is >135deg off the facing but a prime chance; the blunt version
    // that hit cutbacks cost goals and was reverted). Through-balls are forward, so they never qualify.
    if (!keeperOutlet && !securePressuredOutlet && !isCross && !isCutback && per.pressureCount == 0) {
        double pdl = std::sqrt(ls);
        double facingDot = pdl > 1.0 ? (dx * std::cos(p.facing) + dy * std::sin(p.facing)) / pdl : 1.0;
        if (facingDot < -0.7) sc -= (-facingDot - 0.7) / 0.3 * 0.30;   // 0 at ~135deg -> -0.30 at a true 180deg no-looker
    }

    // ── Cross / cutback scoring ──
    if (isCross) {
        sc += 0.05;   // was 0.26 — this helper is the 2nd cross source; trimmed with the wide-carrier override to pull total crosses toward realistic (~40-60/match)
        // A crowded box makes the cross a coin-flip turnover — count the bodies
        // and recycle/pull it back instead (mirrors the override's crowd gate).
        // SUPPLY GATE (high-level audit #1: 100 crosses/90 — 3x real — with 0
        // goals and only 3 headed shots across 5 matches; the whip went in
        // regardless of whether anyone attacked it): the cross's positive
        // stack scales with the ATTACKERS actually in/arriving at the box —
        // no targets, no ball. Defender crowding still subtracts separately.
        double boxSupply = 0.0;
        {
            double gxc = goalXFor(p.team);
            int boxDefenders = 0, boxAttackers = 0;
            for (auto& o : engine.state.players) {
                if (o.sentOff || o.role == Role::GK) continue;
                bool inBoxBand = std::abs(o.x - gxc) < 210.0 && pitch::lateralFromCenter(o.y) < 175.0;
                bool arriving = std::abs(o.x + o.vx * 0.9 - gxc) < 210.0
                    && pitch::lateralFromCenter(o.y + o.vy * 0.9) < 175.0;
                if (o.team != p.team && inBoxBand) boxDefenders++;
                if (o.team == p.team && o.id != p.id && (inBoxBand || arriving)) boxAttackers++;
            }
            sc -= std::max(0, boxDefenders - 2) * 0.10;
            boxSupply = clamp(boxAttackers / 2.0, 0.0, 1.0);
        }
        if (engine.directiveBias[p.id].crossEarly) sc += 0.55;   // "whip it in early" (explicit order: exempt from the supply gate)
        if (t.role == Role::CF) sc += 0.30 * boxSupply;
        else if (t.role == Role::WM) sc += 0.10 * boxSupply;
        else if (t.role == Role::CM) sc -= 0.34;
        bool headerZone = boxTargetGoalDist > 85.0 && boxTargetGoalDist < 205.0
            && pitch::lateralFromCenter(t.y) < 165.0;
        if (headerZone && t.role == Role::CF && receiverPressure <= 1) sc += 0.24 * boxSupply;
        if (headerZone && t.role == Role::WM && receiverPressure == 0) sc += 0.10 * boxSupply;
        if (aerialTarget) sc += 0.24 * boxSupply;
        if (boxSupply < 0.5) sc -= 0.14;   // an empty box makes the whip a giveaway, not an attack
        if (boxTargetGoalDist > 245.0) sc -= 0.22;
        if (pitch::lateralFromCenter(t.y) > 185.0) sc -= 0.12;
    }
    if (isCutback) {
        // The cutback is the wingers' assist to arriving mids — the main route
        // for non-CF goals, so it should outscore yet another cross.
        sc += cutbackTarget ? 0.54 : 0.18;
        if (cutbackTarget && (t.role == Role::CM || t.role == Role::WM)) sc += 0.12;
        if (cutbackTarget && receiverPressure == 0 && bl == 0) sc += 0.12;
        // Spot-band preference (ADDITIVE — the deep lay-back fallback stays, see
        // the rejected 245->190 gate note above): when a box-burst runner has
        // actually arrived in the penalty-spot band, HE gets the ball — the
        // pull-back to an arriving runner is the chance, the 24m lay-back is
        // just recycling. This is what converts burst runs into close shots
        // via the first-time-finish path.
        if (cutbackTarget && boxTargetGoalDist < 165.0
            && pitch::lateralFromCenter(t.y) < 120.0) sc += 0.22;
        if (cutbackTarget) sc += engine.directiveBias[p.id].cutbackBias;   // "pull it back" directive
    }

    bool boxCombination = carrierFinalThird
        && centralBoxTarget
        && (t.role == Role::CF || t.role == Role::WM || t.role == Role::CM)
        && receiverPressure <= 1
        && bl <= 1
        && completion >= 0.56;
    if (boxCombination) {
        sc += 0.34;
        if (receiverPressure == 0 && bl == 0) sc += 0.12;
        if (t.role == Role::CF) sc += 0.10;
    }

    // ── Role-based target bonuses ──
    if (carrierFinalThird && boxTargetGoalDist < 150.0 && receiverPressure <= 1 && bl <= 1) {
        if (t.role == Role::CF) sc += 0.16;
        else if (t.role == Role::WM) sc += 0.12;
        else if (t.role == Role::CM && pitch::lateralFromCenter(t.y) < 150.0) sc += 0.06;
    }
    if ((p.role == Role::CM || p.role == Role::WM || p.role == Role::FB)
        && t.role == Role::CF
        && pitch::lateralFromCenter(t.y) < 175.0
        && boxTargetGoalDist < 245.0
        && fp > -35.0
        && bl <= 1
        && receiverPressure <= 1) {
        sc += carrierFinalThird ? 0.30 : 0.20;
    }
    if (isCutback && receiverPressure <= 1 && bl <= 1) sc += 0.08;   // was cross+cutback; the cutback is the one to reward
    if (isWideMidfielder() && dgW < 450.0 && t.role == Role::CF && pitch::lateralFromCenter(t.y) < 230.0) sc += 0.24;
    if (isWideMidfielder() && fp > 10.0 && pitch::lateralFromCenter(p.y) > 100.0 && bl <= 2) sc += 0.26;   // wide-funnel sugar trimmed 0.32
    if (isFullBack() && fp > 0.0 && pitch::lateralFromCenter(p.y) > 75.0 && dgW < 430.0) sc += 0.24;       // trimmed 0.30
    bool targetWide = roles::isWide(t.role) && pitch::lateralFromCenter(t.y) > 125.0;
    bool passerCanFindWide = isDefenderLike();
    if (passerCanFindWide && targetWide && fp > 20.0 && d < 460.0 && bl <= 1 && receiverPressure <= 1) {
        double centralPasserBonus = pitch::lateralFromCenter(p.y) < 170.0 ? 0.10 : 0.0;
        double advancedBonus = carrierFinalThird ? 0.08 : 0.0;
        sc += 0.16 + centralPasserBonus + advancedBonus;
    }

    // ── Completion penalties ──
    if (completion < 0.62) sc -= (0.62 - completion) * 0.55;
    // Unforced-giveaway guard: with NO pressure on the ball there is no excuse
    // to force a genuinely LOOSE pass — recycle and keep it. Targets only the
    // clearly-risky balls so it doesn't make an unpressured carrier passive.
    if (per.pressureCount == 0 && completion < 0.64) sc -= (0.64 - completion) * 0.55;
    if (fp > 110.0 && completion < 0.70) sc -= 0.10;
    if (fp > 180.0 && completion < 0.76) sc -= 0.08;
    // Risk taxes keyed to DISTANCE, not just forward gain: the 0:26.4 pick won
    // partly because a 476px sideways coin-flip (fp 96) slipped under both
    // fwdRisk gates above while the safer 290px forward ball paid them — the
    // longest, slowest, most interceptable ball on the menu was taxed least.
    if (d > 320.0 && completion < 0.70) sc -= 0.10;
    if (d > 400.0 && completion < 0.76) sc -= 0.10;
    sc -= bl * (d > 170.0 ? 0.09 : 0.12);   // chippable range: the lofted ball goes over (see blCost note)
    sc -= std::min(laneRisk, 2.2) * 0.075;   // steer away from lanes a defender can step into (see pass audit)
    if (fp > 0.0) {
        // Round-20: universal fp>0 directness bonus trimmed ~40% (0.08/0.20 ->
        // 0.05/0.12) — it rewarded ANY forward ball and tilted the mix to 59% fwd.
        sc += 0.05 + (engine.configFor(p.team).passingDirectness - 50.0) / 100.0 * 0.12;
    } else {
        sc -= (engine.configFor(p.team).passingDirectness - 50.0) / 100.0 * 0.15;
    }

    // ── Purpose classification ──
    ActionPurpose pur = ActionPurpose::Keep;
    if (keeperOutlet)                    pur = ActionPurpose::KeeperBackpass;
    else if (fp > 120.0 && bl == 0)     pur = ActionPurpose::Build;
    else if (fp > 40.0 && bl <= 1)      pur = ActionPurpose::Build;
    else if (std::abs(t.y - p.y) > 150.0) pur = ActionPurpose::Switch;
    else if (bl >= 2 && fp < -30.0)      pur = ActionPurpose::Clear;
    if (isCross)                          pur = ActionPurpose::Cross;
    else if (isCutback)                   pur = ActionPurpose::Cutback;

    // Ball-playing CB (directive): reward a progressive, line-breaking distribution
    // — a forward build pass or a switch that changes the angle — so a stepped-out
    // centre-back looks for the vertical/wide outlet over the square safe ball.
    // Gated on the directive, so an unflagged CB is byte-identical.
    if (engine.directiveBias[p.id].ballPlaying) {
        if (pur == ActionPurpose::Build && fp > 60.0)  sc += 0.12;
        else if (pur == ActionPurpose::Switch)         sc += 0.08;
    }

    // ── Switch bonus ──
    if (pur == ActionPurpose::Switch) {
        sc += engine.directiveBias[p.id].switchBias;            // "switch the play / spread it"
        bool carrierTop = (p.y < PITCH_H / 2.0);
        bool targetTop  = (t.y < PITCH_H / 2.0);
        if (carrierTop != targetTop) {
            int oppsNearCarrier = 0;
            int oppsNearTarget  = 0;
            for (auto& o : engine.state.players) {
                if (o.team == p.team || o.role == Role::GK) continue;
                bool onCarrierSide = carrierTop ? o.y < PITCH_H / 2.0 : o.y >= PITCH_H / 2.0;
                if (onCarrierSide && dist(p.x, p.y, o.x, o.y) < 250.0) oppsNearCarrier++;
                bool onTargetSide = targetTop ? o.y < PITCH_H / 2.0 : o.y >= PITCH_H / 2.0;
                if (onTargetSide && dist(o.x, o.y, t.x, t.y) < 200.0) oppsNearTarget++;
            }
            // Congestion relief only pays on a CLEAN lane (seed 305 0:35: the
            // boxed FB's 326px switch collected the full +0.18 while a jogging
            // CF sat 66px abeam of the lane — the "escape the congestion" read
            // was right about the flanks and wrong about the ball ever
            // arriving; the safe 213px recycle lost by exactly this bonus).
            if (oppsNearCarrier >= 3 && oppsNearTarget <= 1 && bl == 0 && laneRisk < 0.8) sc += 0.18;
            else if (oppsNearCarrier >= 2 && oppsNearTarget <= 2 && laneRisk < 1.2)       sc += 0.10;
        }
    }

    // ── Creativity / added time / role preference ──
    double cr = attrFactor(p.attrs.creativity);
    if (pur == ActionPurpose::Build && bl > 0) sc += cr * 0.12;
    if (pur == ActionPurpose::Clear)           sc -= cr * 0.10;

    if (engine.phase.addedTimeActive && engine.phase.half == 2) {   // 2nd-half stoppage only
        bool inDefThird = pitch::inOwnDefensiveThird(p.x, p.team);
        if (inDefThird) {
            bool targetExitsThird = (p.team == Team::Home) ? t.x > THIRD_1 : t.x < THIRD_2;
            if (targetExitsThird) sc += 0.30;
            else if (fp > 80.0) sc += 0.15;
        }
    }

    using RoleList = std::vector<Role>;
    static const std::unordered_map<Role, RoleList> rcMap = {
        {Role::GK, {}},
        {Role::CB, {Role::CM, Role::FB, Role::WM, Role::CF}},
        {Role::FB, {Role::CM, Role::WM, Role::CB}},
        {Role::CM, {Role::CF, Role::WM, Role::FB}},
        {Role::WM, {Role::CF, Role::CM}},
        {Role::CF, {Role::CM, Role::WM}},
    };
    auto it = rcMap.find(p.role);
    const RoleList& pref = (it != rcMap.end()) ? it->second : RoleList{};
    auto rii = std::find(pref.begin(), pref.end(), t.role);
    if (rii == pref.begin())           sc += 0.12;
    else if (rii == pref.begin() + 1)  sc += 0.06;
    if (t.role == p.role) sc -= isDefenderRole() ? 0.30 : 0.20;

    if (isDefenderRole() && (t.role == Role::CM || t.role == Role::WM) && fp > 0.0) sc += 0.08;

    // ── Final third target bonuses ──
    bool passerFinalThird = pitch::inFinalThird(p.x, p.team);
    double targetGoalDist = pitch::distToOppGoal(t.x, p.team);
    if (passerFinalThird && targetGoalDist < 230.0) {
        if (t.role == Role::CF) sc += 0.24;
        else if (t.role == Role::WM && pitch::lateralFromCenter(t.y) < 210.0) sc += 0.10;
        else if (t.role == Role::CM) sc -= 0.16;
    }

    // ── Assignment-based bonuses ──
    auto* assignment = engine.assignmentFor(t.id);
    if (assignment) {
        if (assignment->role == DefensiveTask::RunAhead)        sc += 0.12;
        if ((assignment->role == DefensiveTask::CrossLane || assignment->role == DefensiveTask::HoldWidth)
            && roles::isWide(t.role) && pitch::lateralFromCenter(t.y) > 120.0) sc += 0.08;
        if (assignment->role == DefensiveTask::Overlap && !isCenterBack()) sc += 0.11;
        if (assignment->role == DefensiveTask::AdvanceMidfield) sc += 0.09;
        if (assignment->role == DefensiveTask::HoldWidth && std::abs(t.y - p.y) > 120.0) sc += 0.08;
    }

    // ── Through ball / wide outlet ──
    double offsideLine = engine.offsideLineFor(p.team);
    double onsideGap = std::isnan(offsideLine) ? 1e9 : (offsideLine - t.x) * fd;

    bool wideOutletTarget = targetWide && fp > 20.0 && d < 500.0;
    // Runner intent = speed TOWARD THE GOAL, not raw x-speed: a winger's
    // diagonal cut between the centre-backs (watched replay 0:46 — full-tilt
    // run, near-zero vx) never counted as a run under the old t.vx * fd, so
    // the first-time-shot through ball was never even rated.
    double runnerForwardSpeed = t.vx * fd;
    {
        // Only a genuine SPRINT that is mostly goalward counts — crediting any
        // radial drift flooded the match with hopeful through balls (first cut
        // of this change: 4.6 -> 14.9 attempts per 10min, completion -2.6pts).
        double tgx = goalXFor(p.team) - t.x, tgy = PITCH_H / 2.0 - t.y;
        double tgl = std::hypot(tgx, tgy);
        double spd = std::hypot(t.vx, t.vy);
        if (tgl > 1.0 && tgl < 320.0 && spd > 34.0) {
            double radial = (t.vx * tgx + t.vy * tgy) / tgl;
            if (radial > spd * 0.55) runnerForwardSpeed = std::max(runnerForwardSpeed, radial);
        }
    }
    bool targetAttacker = roles::isAttacker(t.role);

    // ── Killer-ball projection ── passBallTo(through=true) LEADS the runner
    // (velocity x 1.32 over the flight, plus 90-210px straight forward), but
    // every through-ball gate below judged his CURRENT spot — so the obvious
    // slide-in ball kept failing on margins. Watched replay: 1:15, WM on the
    // ball, CF at full tilt into the CB channel — pass never rated (fp 26 vs
    // gate 30, goalDist 372 vs 255, marker counted that he was outrunning);
    // 5:37, the led lane to the sprinting winger was clean but the engine saw
    // only the covered straight lane and threw it into the interceptor. For a
    // MOVING runner, judge pressure/blockers/range at the projected receive
    // point, with the defenders projected too. Offside stays judged at the
    // CURRENT position — that is the law, and the executed ball is released
    // this tick.
    double fpEff = fp;
    double goalDistEff = targetGoalDist;
    int rpEff = receiverPressure;
    int blEff = bl;
    double rxEff = t.x, ryEff = t.y;   // projected receive point (falls back to the current spot)
    // Lateral/channel runners too (loft audit M1/M2: a WM sprinting down the
    // flank had vx*fd ~2-14, under the radial-speed gate, so the projection
    // never ran and his run was judged at the spot he was LEAVING).
    double runnerRawSpd = std::hypot(t.vx, t.vy);
    bool lateralRunner = runnerRawSpd > 30.0 && (t.vx * fd) > 8.0
                      && (targetAttacker || t.role == Role::CM || t.role == Role::FB);
    if (((targetAttacker || t.role == Role::CM) && runnerForwardSpeed > 15.0) || lateralRunner) {
        // A genuinely SPRINTING runner earns a longer projection (up to 1.8s):
        // the 1.1s cap judged De Bruyne->Alba (2:05) and Xavi->Neymar (2:26)
        // at spots the runner was leaving — fpEff read -85..-67 for a run that
        // lands 100px+ upfield. The arrival-race blocker scan below runs at
        // the same lead, so the longer ball is priced at its landing spot.
        double lead = clamp(d / 300.0 + 0.3, 0.4, runnerRawSpd > 42.0 ? 1.8 : 1.1);
        double px2 = clamp(t.x + t.vx * lead, 12.0, PITCH_W - 12.0);
        double py2 = clamp(t.y + t.vy * lead, 12.0, PITCH_H - 12.0);
        rxEff = px2; ryEff = py2;
        fpEff = pitch::forwardGain(p.x, px2, p.team);
        goalDistEff = pitch::distToOppGoal(px2, p.team);
        rpEff = 0;
        blEff = 0;
        double dx2 = px2 - p.x, dy2 = py2 - p.y, ls2 = dx2 * dx2 + dy2 * dy2;
        for (auto& o : engine.state.players) {
            if (o.team == p.team || o.sentOff) continue;
            double ox = o.x + o.vx * lead, oy = o.y + o.vy * lead;
            if (o.role != Role::GK && dist(ox, oy, px2, py2) < PASS_RECEIVER_PRESS_MAX) rpEff++;
            if (ls2 > 1.0 && o.role != Role::GK) {
                double t3 = clamp(((ox - p.x) * dx2 + (oy - p.y) * dy2) / ls2, 0.0, 1.0);
                double perp = std::hypot(ox - p.x - t3 * dx2, oy - p.y - t3 * dy2);
                // A body ON THE PASSER'S BOOT is cleared by a genuine LOFT —
                // long balls only (d>=250): the exclusion feeds every killer
                // class via blEff==0, and un-gated it reclassified every
                // sandwiched carrier's forward poke as a through ball
                // (attempts 73 -> 212/90 in the first two cuts). A short
                // slipped ball never gets up and over the presser; only the
                // over-the-top range does (seed 437 0:40: Iniesta's two
                // sandwich pressers killed the clearly-on 300px+ ball to
                // Neymar).
                bool bootPresser = d >= 300.0 && dist(ox, oy, p.x, p.y) < 45.0;   // 250 -> 300: true over-the-top range only
                if (!bootPresser && perp < PASS_BLOCKER_PERP) blEff++;
            }
        }
    }
    // Nearest defender PROJECTED to the receive point at arrival (only for a
    // runner already at pace — rawSpd>30; a slower man is judged at his spot).
    // Hoisted above the killer-ball classes (Round-20) so clearOnsideAttacker
    // can see the closing defender it used to ignore (seed 477 0:11: a CB
    // projected 39px at arrival still read as a clean lane). Also feeds
    // ledRunnerLoft below.
    double nearestOppProj = 1e9;
    if (runnerRawSpd > 30.0) {
        double leadT = clamp(d / 300.0 + 0.3, 0.4, 1.1);
        for (auto& o : engine.state.players)
            if (o.team != p.team && o.role != Role::GK && !o.sentOff)
                nearestOppProj = std::min(nearestOppProj,
                    dist(o.x + o.vx * leadT, o.y + o.vy * leadT, rxEff, ryEff));
    }
    // USERWATCH A3 (Leon Kovac ~4:33 missed it): a teammate CLEAR & ONSIDE in behind with an
    // open lane is a through-ball target even BEFORE he sprints — the obvious killer pass a
    // human expects. Strict gates (unmarked, lane fully clear, genuine range) so it never spams.
    // Round-20 (seed 477 0:11: WM's "aimless throughball to nobody" — a 32m
    // "clean killer ball" to a CF 154px short of the line, drifting laterally
    // (goalward speed 3.3) with a CB stepping in, cut out). The class demanded
    // no runner intent and accepted a target 15m short of the line, so a static
    // shirt in a momentarily-clean lane read as an on ball. Require a genuine
    // forward run, a shoulder-of-the-line position (onsideGap<90, not <170), and
    // — for a runner already at pace — no defender projected to step in (>60px).
    bool clearOnsideAttacker = targetAttacker && rpEff == 0 && blEff == 0
                            && runnerForwardSpeed > 20.0
                            && onsideGap > 3.0 && onsideGap < 90.0 && goalDistEff < 430.0
                            && nearestOppProj > 60.0;
    bool runnerIntent =
        (assignment && (assignment->role == DefensiveTask::RunAhead
                     || assignment->role == DefensiveTask::InsideRun
                     || assignment->role == DefensiveTask::Overlap
                     || assignment->role == DefensiveTask::CrossLane))
        || runnerForwardSpeed > 26.0
        || clearOnsideAttacker;
    bool goodThroughWindow = targetAttacker
                          && runnerIntent
                          && fpEff > 30.0
                          && onsideGap > -12.0
                          && onsideGap < 170.0        // was 130; the 1:15 channel runner sat at 133
                          && blEff <= 1
                          && rpEff <= 1
                          && goalDistEff < 300.0;   // was 480 (nearly half-pitch), then 255 judged at the CURRENT spot; 300 at the PROJECTED receive point is the same real-ball philosophy
    bool releasedRunner = (assignment && (assignment->role == DefensiveTask::RunAhead
                                       || assignment->role == DefensiveTask::InsideRun
                                       || (assignment->role == DefensiveTask::CrossLane && t.role == Role::WM)))
                          || (assignment && assignment->role == DefensiveTask::Overlap && !wideOutletTarget)
                          || (isCentralMidfielder() && targetAttacker && !wideOutletTarget)
                          || clearOnsideAttacker;
    // USER #2 "PASSES INTO SPACE" (Park North vs max ~2:21, winger ran in behind UNFED): the
    // genuinely-CLEAN killer ball (clearOnsideAttacker = an unmarked, ONSIDE CF/WM in behind with
    // a clear lane, <430 to goal) should fire EVEN at moderate fp, which goodThroughWindow's fp>30
    // gate blocks. It's strictly gated (receiverPressure==0, bl==0, onside) so it never adds a
    // hopeful punt — the broad gate-relax was REVERTED for cratering goals; THIS plays only the
    // clean 1-on-1, with a boost so it beats the safe square pass / the take-on.
    bool cleanKillerBall = !isWideDelivery && clearOnsideAttacker;
    // CHANCE-CREATION (goals-fine-to-raise from better creation): a CM deliberately sent into the
    // box (AdvanceMidfield, assignAttackingRoles) who arrives UNMARKED, ONSIDE, central and in a
    // clean lane is a legit killer-ball recipient. The run-STATE already ships (engine_defense.cpp),
    // but the Through reward above was CF/WM-only (clearOnsideAttacker/goodThroughWindow both gate on
    // targetAttacker), so the slip to an arriving CM was never rewarded and lost to a safe recycle.
    // Strict gates (unmarked, clear lane, onside, central, inside the box) so it never adds a hopeful
    // ball; byte-identical in any tick where no CM holds AdvanceMidfield.
    bool cmKillerBall = !isWideDelivery && t.role == Role::CM
                     && assignment && assignment->role == DefensiveTask::AdvanceMidfield
                     && rpEff == 0 && blEff == 0
                     && onsideGap > 3.0 && onsideGap < 170.0
                     && pitch::lateralFromCenter(t.y) < 150.0
                     && goalDistEff < 245.0 && fpEff > 20.0;
    // ── Over the top (FIVE strikes — permanently shelved) ── the lofted ball
    // behind the line for the striker (owner asked repeatedly, most recently
    // 1:06/1:28 seed 317). A/B'd THREE times pre-conversion-fix and twice
    // post: even with clear-cut finishing landed (1-on-1s 14% -> 33%), the
    // tight variant still dropped goals (0.38 -> 0.17 in the combined round;
    // isolated bisect confirmed it as the driver). Why conversion didn't save
    // it: the reception lands ~30-35m out with the keeper set — the runner
    // still has to carry and beat him, so it's NOT a clear-cut chance by
    // strike time; meanwhile the attempts replace possession sequences that
    // did produce chances. Do not re-add via selection; if this ball is ever
    // wanted, it needs its own receive-to-finish path (first-touch knock past
    // the keeper / earlier clear-cut qualification), not a score bonus here.
    // ── Genuinely-open advanced man (seed 105 0:52: killer balls to unmarked
    // shirts 7 & 10 declined for a safe square) ── the Through rewards above are
    // CF/WM-only (targetAttacker) and gate on the strict in-behind band, so an
    // UNMARKED advanced CENTRAL man — especially a central MIDFIELDER — got no
    // forward premium and lost selection to a safe recycle. RE-RANK, not new
    // supply: fires only when the man is genuinely open (no marker within 85px,
    // zero lane blockers, zero receiver pressure), central, advanced, roughly
    // onside, and the ball completes (>=0.50). Pairs with the chip-loft (0:55):
    // these forward balls now beat a blocker instead of being cut on the deck.
    bool genuinelyOpenAdvanced = !isWideDelivery
        && (t.role == Role::CF || t.role == Role::WM || t.role == Role::CM)
        && rpEff == 0 && blEff == 0 && nearestOppRecv > 85.0
        && onsideGap > -20.0 && pitch::lateralFromCenter(t.y) < 150.0
        && goalDistEff < 300.0 && fpEff > 60.0 && completion >= 0.50;
    // ── Led-runner loft (seed 103: 0:58 Robben jogging into an empty channel
    // unfed; 1:05 Kroos facing Robben's finished run but playing a doomed short
    // ball; 9:44 the one time it WAS played, it looked great) ── the visible
    // 25-45m ball into a genuine runner's path. Every other killer class needs
    // the final 30m (goalDistEff<300) or a tight in-behind band, so the long
    // diagonal to a runner in acres simply had no reward class. Gates: real
    // range (250-460), a genuinely MOVING runner (raw speed + forward
    // component — lateral channel runs count via the projection extension),
    // and a CLEAN projected reception (no pressure, no lane blockers, nearest
    // projected marker 75px+, real forward gain, completes). Executed as a
    // Through (led + lofted at range by passBallTo), exempt from the sanity
    // penalty like every deliberate killer ball. (nearestOppProj is computed
    // once above, hoisted so clearOnsideAttacker can see the closing defender.)
    bool runnerAssignment = assignment && (assignment->role == DefensiveTask::RunAhead
        || assignment->role == DefensiveTask::InsideRun || assignment->role == DefensiveTask::Overlap
        || assignment->role == DefensiveTask::CrossLane);
    // A flying FB counts by his RUN, not his paperwork (2:05: Alba's byline
    // sprint existed only as a positioning candidate the pass scorer couldn't
    // see — the Overlap assignment needs a wide carrier, and De Bruyne was
    // central).
    bool sprintingFB = t.role == Role::FB && runnerRawSpd > 38.0 && (t.vx * fd) > 18.0;
    // Kickoff-migration guard (seed 173 0:03): for ~2 ticks after a kickoff the
    // whole team's positioning targets flip from the scripted kickoff shape to
    // open play, manufacturing phantom "runs" (Ronaldinho read 30.9px/s off a
    // one-tick target flip and drew a 42m loft straight through the CF still
    // parked on the centre circle). No killer-ball class arms in the first 4s.
    bool kickoffMigration = engine.state.clockMs - engine.phase.lastKickoffMs < 4000.0;
    bool ledRunnerLoft = !kickoffMigration && d >= 250.0 && d <= 460.0
        && (targetAttacker || ((t.role == Role::CM || t.role == Role::FB) && runnerAssignment) || sprintingFB)
        && runnerRawSpd > 40.0 && (t.vx * fd) > 16.0
        && rpEff == 0 && blEff == 0 && nearestOppProj > 75.0
        && fpEff > 40.0 && completion >= 0.58;
    // Over the top (1:33: Neymar on an InsideRun, 10-12m onside, 30m of grass
    // to Neuer, never fed — every killer class needs the final 30m): the long
    // ball over the line to an assigned runner with real space behind it, from
    // ANY depth. Priced at the projected landing like the loft.
    double spaceBehindLine = std::isnan(offsideLine) ? 0.0
        : std::abs(goalXFor(p.team) - offsideLine) ;
    bool overTheTop = !kickoffMigration && runnerAssignment && d >= 230.0 && d <= 520.0
        && onsideGap > 25.0 && onsideGap < 200.0 && spaceBehindLine > 180.0
        && rpEff == 0 && blEff <= 1 && nearestOppProj > 70.0
        // Round-20 (seed 477 0:11): an over-the-top needs BOTH a moving runner
        // AND space behind — a free STANDER with grass gets the ball to feet,
        // not lofted into a channel he isn't attacking. Was OR (a stander alone
        // armed it), now AND.
        && (runnerRawSpd > 28.0 && nearestOppRecv > 70.0)
        && completion >= 0.48;
    if ((!isWideDelivery && releasedRunner && goodThroughWindow) || cleanKillerBall || cmKillerBall || genuinelyOpenAdvanced || ledRunnerLoft || overTheTop) {
        pur = ActionPurpose::Through;
        if (genuinelyOpenAdvanced) sc += 0.14;   // capped re-rank so the open forward ball beats the safe square
        if (ledRunnerLoft) sc += 0.15;           // the visible runner gets the ball into his path
        if (overTheTop && !ledRunnerLoft) sc += 0.14;   // spring the assigned runner from deep
        // Slide a runner in behind for a 1-on-1 (converts ~40% vs a 4% pot-shot).
        sc += 0.12 + attrFactor(p.attrs.creativity) * 0.10;   // trimmed with the window above to cut through-ball spam (~121 -> target ~15-30/match)
        if (cleanKillerBall) sc += 0.16;
        if (cmKillerBall) sc += 0.12;   // slip the arriving midfield runner in (smaller than the CF/WM premium — conservative)
        // Quick transition: hit the runner FAST while the defence is unset.
        // counter_attack amplifies this (and the matching off-ball-run bonus).
        if (engine.state.clockMs < engine.transitionUntilMs)
            sc += 0.18 * (1.0 + engine.teamTactics[teamIndex(p.team)].counterAttackBonus)
                       * clamp((engine.transitionUntilMs - engine.state.clockMs) / 400.0, 0.0, 1.0);
        if (runnerForwardSpeed > 10.0) sc += 0.07;
        if (onsideGap > 8.0 && onsideGap < 70.0) sc += 0.08;
        if (targetGoalDist < 250.0) sc += 0.14;
        if (receiverPressure > 0) sc -= 0.05;
    } else if (!isWideDelivery && releasedRunner && !runnerIntent && isCentralMidfielder()) {
        sc -= 0.08;
    }
    // Completion-gated (was d<500 with no completion check — the bonus paid out
    // on hopeful hangs a defender could walk under, 0:26.4).
    if (wideOutletTarget && !isWideDelivery && onsideGap > 10.0 && bl <= 1 && receiverPressure <= 1
        && completion >= 0.60 && d < 400.0) {
        pur = std::abs(t.y - p.y) > 120.0 ? ActionPurpose::Switch : ActionPurpose::Build;
        sc += 0.12 + attrFactor(p.attrs.creativity) * 0.08;
    }

    // ── Release ball (1:12) — ATTEMPTED AND REVERTED ── a class rewarding
    // the ball in behind a beaten flank marker at midfield range was A/B'd
    // twice (broad, then flank-only + tight onside window): both cuts pushed
    // through-ball volume +20-45% while GOALS FELL (0.47 -> 0.28-0.33) and
    // completion dropped — the selection finds the ball but the conversion
    // chain (collect -> next decision -> finish) doesn't cash it, so each
    // extra Through is a possession lottery at negative EV. Same verdict as
    // the directed-panic-outlet experiment. Fix CONVERSION first (fresh-
    // through finishing / 1-on-1 balance), then revisit selection.

    // ── Assist-awareness ── a receiver who will have a CLEAR SHOT when the
    // ball arrives outranks any neutral connector: shooting range, unmarked
    // at the receive point, a real opening angle, and no bodies on his shot
    // line. The missing "set him up for the first-time finish" (watched
    // replay 0:49: carrier facing a teammate with a clean look at goal chose
    // a sideways ball instead; owner: raising goals this way is welcome).
    if (goalDistEff < 215.0 && rpEff == 0 && blEff <= 1 && fp > -25.0) {
        double shotAngle = engine.goalOpeningAngleDeg(rxEff, ryEff, goalXFor(p.team));
        if (shotAngle > 9.0
            && countLaneBlockers(engine.state.players, rxEff, ryEff,
                                 goalXFor(p.team), PITCH_H / 2.0, p.team,
                                 BLOCKER_PERP_FREEKICK * 0.75, 0.05, 0.94) == 0)
            sc += 0.20;
    }

    // ── Final adjustments ──
    sc += std::min(holdTicks / 260.0, 0.20);

    if (receiverPressure >= 2) sc -= 0.25;
    if (per.pressureCount >= 2 && bl == 0) sc += 0.10;
    if (per.pressureCount >= 2 && bl >= 2) sc -= 0.15;

    if (isCentralMidfielder() && t.role == Role::CF && receiverPressure >= 1 && bl <= 1)
        sc += attrFactor(p.attrs.creativity) * 0.10;

    auto& bb = engine.blackboards[GameEngine::teamIndex(p.team)];
    if (bb.oneTwo.has_value()
        && bb.oneTwo->from == t.id
        && bb.oneTwo->to == p.id
        && engine.state.clockMs < bb.oneTwo->expires) {
        sc += 0.30;
        // The wall pass: reward returning it into the original passer's run.
        bool runnerInStride = t.vx * fdFor(p.team) > 12.0;
        if (runnerInStride && fp > 10.0) sc += 0.14;
    }

    // target_player directive: steer this passer's distribution toward a man.
    if (engine.directiveBias[p.id].passTargetId == t.id)
        sc += engine.directiveBias[p.id].passTargetBias;

    if (sc <= 0.0) return std::nullopt;

    return Action{
        ActionType::Pass,
        clamp(sc, 0.0, 1.0),
        &t,
        0, 0,
        pur,
        ActionAudit{ d, fp, completion, bl, receiverPressure, 0, 0 }
    };
}
