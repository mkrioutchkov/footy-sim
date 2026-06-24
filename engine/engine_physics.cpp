#include "engine.h"
#include "agent.h"
#include <cmath>
#include <cstdio>
#include <numbers>

// ══════════════════════════════════════════════════════════════
// Physics — ball physics, collision, collection, movement
// ══════════════════════════════════════════════════════════════

void GameEngine::separateTeammates(double sdt) {
    double secs = sdt / 1000.0;
    double maxPush = 32.0 * secs;
    for (size_t i = 0; i < state.players.size(); ++i) {
        for (size_t j = i + 1; j < state.players.size(); ++j) {
            Player& a = state.players[i];
            Player& b = state.players[j];
            // GKs separate too (at the opponent distance) — exempting them let
            // outfielders stand INSIDE the keeper for seconds.
            bool gkPair = a.role == Role::GK || b.role == Role::GK;
            double dx = b.x - a.x, dy = b.y - a.y;
            double d = std::hypot(dx, dy);
            double minDist = (gkPair || a.team != b.team) ? 24.0 : SEPARATION_DIST;
            if (d < 0.1 || d >= minDist) continue;
            double nx = dx / d, ny = dy / d;
            double pushScale = (gkPair || a.team != b.team) ? 0.10 : 0.24;
            // Deep overlap (two bodies on one pixel) escalates the push hard —
            // the gentle 0.5px/tick separation lost to shared chase targets.
            double push = std::min(maxPush * (d < 12.0 ? 4.0 : 1.0), (minDist - d) * pushScale * (d < 12.0 ? 4.0 : 1.0));
            bool aFixed = state.ball.controllerId == a.id || isActiveKnockAheadRunner(a.id);
            bool bFixed = state.ball.controllerId == b.id || isActiveKnockAheadRunner(b.id);
            if (aFixed && bFixed) continue;
            if (aFixed) {
                b.x = clampToPitchX(b.x + nx * push * 2.0);
                b.y = clampToPitchY(b.y + ny * push * 2.0);
            } else if (bFixed) {
                a.x = clampToPitchX(a.x - nx * push * 2.0);
                a.y = clampToPitchY(a.y - ny * push * 2.0);
            } else {
                a.x = clampToPitchX(a.x - nx * push);
                a.y = clampToPitchY(a.y - ny * push);
                b.x = clampToPitchX(b.x + nx * push);
                b.y = clampToPitchY(b.y + ny * push);
            }
        }
    }
}

void GameEngine::applyBallPhysics(double s) {
    auto& b = state.ball;
    if (b.curl != 0.0) {
        double rot = b.curl * s;
        double cs = std::cos(rot), sn = std::sin(rot);
        double nvx = b.vx * cs - b.vy * sn;
        b.vy = b.vx * sn + b.vy * cs;
        b.vx = nvx;
        b.curl *= std::pow(b.z > 2.0 ? 0.55 : 0.02, s);
        if (std::abs(b.curl) < 0.02) b.curl = 0.0;
    }
    double friction = std::pow(BALL_FRICTION, s);
    if (weather == 1) friction = 1.0 - (1.0 - friction) * 0.55;   // §weather rain: wet pitch sheds ~45% less rolling friction (ball skids further)
    b.vx *= friction;
    b.vy *= friction;
    // Rolling friction: a grounded ball below jogging pace stops in a stride
    // or two, not a multi-second exponential crawl that never quite reaches 0.
    double gs = std::hypot(b.vx, b.vy);
    if (b.z < 1.0 && gs > 0.0 && gs < 65.0) {
        double stopRate = (weather == 1) ? 47.5 : 95.0;   // §weather rain: skids, doesn't pull up in a stride
        double slowed = std::max(0.0, gs - stopRate * s);
        b.vx *= slowed / gs; b.vy *= slowed / gs;
    }
    if (std::hypot(b.vx, b.vy) < 4) { b.vx = b.vy = 0; }
    b.x += b.vx * s;
    b.y += b.vy * s;
    if (b.vz != 0.0 || b.z > 0) {
        b.vz -= GRAVITY * s;
        b.z += b.vz * s;
        if (b.z <= 0) {
            b.z = 0;
            if (b.vz < -75.0) {
                // One firm bounce for a hard-driven ball: grass sheds most of
                // the vertical energy and grips horizontally. The high
                // threshold means a ball returning below ~75px/s just settles,
                // so there's no multi-hop micro-bounce tail (the audit's
                // phantom vz that never died), and high balls stop hovercraft-
                // sliding across the pitch.
                b.vz *= -0.30;
                b.vx *= 0.70; b.vy *= 0.70;
            } else {
                b.vz = 0;
            }
        }
    }
}

void GameEngine::clampBallPosition() {
    state.ball.x = clamp(state.ball.x, -40., PITCH_W + 40);
    state.ball.y = clamp(state.ball.y, -40., PITCH_H + 40);
}

bool GameEngine::checkGoal(){
    auto&b=state.ball;
    bool inOpening=std::abs(b.y-PITCH_H/2)<=GOAL_W/2&&b.z+BALL_R<=GOAL_H;
    if(!inOpening)return false;
    auto recordGoalSource=[&](Team scoringTeam){
        lastGoal.scoringTeam=scoringTeam;
        lastGoal.touchTeam=b.lastTouchTeam;
        lastGoal.toucherId=b.lastToucherId;
        lastGoal.ballSpeed=std::hypot(b.vx,b.vy);
        if(!shot.tracked){
            if(pendingPass.active&&pendingPass.team==scoringTeam){
                if(pendingPass.isCross){lastGoal.source=GoalSource::DirectCross;}
                else lastGoal.source=GoalSource::DirectDelivery;
            }else if(pendingPass.active){
                lastGoal.source=GoalSource::TackleDeflection;
            }else if(lastLooseOrigin == LooseOrigin::TackleDeflection){
                lastGoal.source=GoalSource::TackleDeflection;
            }else if(lastLooseOrigin == LooseOrigin::GoalkeeperParry){
                lastGoal.source=GoalSource::GoalkeeperParry;
            }else if(lastLooseOrigin == LooseOrigin::Shot){
                lastGoal.source=GoalSource::ShotStateLost;
            }else if(lastLooseOrigin == LooseOrigin::KnockAhead){
                resolveKnockAhead(nullptr,"goal");
                lastGoal.source=GoalSource::KnockAhead;
            }else if(b.lastTouchTeam==scoringTeam&&b.lastToucherId>=0){
                lastGoal.source=GoalSource::ShotStateLost;
            }else{
                lastGoal.source=GoalSource::LooseUnclassified;
            }
            return;
        }
        if(b.lastTouchTeam!=shot.team){
            lastGoal.source=GoalSource::ShotDeflection;
        }else{
            lastGoal.source=shot.penalty ? GoalSource::Penalty : GoalSource::Shot;
        }
    };
    // A goal: identical bookkeeping for either end — only the scoring team, the goal
    // line, the score counter, and who restarts differ. (Conceding side kicks off.)
    auto finishGoal=[&](Team scoringTeam, double goalLineX){
        recordGoalSource(scoringTeam);
        double goalDist=0;
        if(shot.tracked)goalDist=dist(shot.originX,shot.originY,goalLineX,PITCH_H/2);
        Player* scorer=playerById(lastGoal.toucherId);
        std::optional<Role> scorerRole=scorer?std::optional<Role>(scorer->role):std::nullopt;
        if(lastGoal.source==GoalSource::Penalty)stats.recordPenaltyGoal();
        if(shot.dribble20m&&lastGoal.source==GoalSource::Shot)stats.recordDribble20mGoal();
        stats.recordGoal(scoringTeam,lastGoal.source,goalDist,lastGoal.ballSpeed,scorerRole,shot.header);
        if(passDebug&&shot.tracked)fprintf(stderr,"GOALSCORED type=%d src=%d\n",shot.type,(int)lastGoal.source);
        creditGoal(lastGoal.toucherId);
        emitEvent("goal", goalLineX, b.y, lastGoal.toucherId);
        if(scoringTeam==Team::Home)state.homeScore++; else state.awayScore++;
        shot.active=false; shot.clearFlags();
        kickoff(scoringTeam==Team::Home?Team::Away:Team::Home);
    };
    if(b.x+BALL_R<HOME_GOAL_X){ finishGoal(Team::Away, HOME_GOAL_X); return true; }
    if(b.x-BALL_R>AWAY_GOAL_X){ finishGoal(Team::Home, AWAY_GOAL_X); return true; }
    return false;
}

// Posts and crossbar. A ball arriving at the goal-frame plane that catches an
// upright or the bar ricochets back into play (or down off the bar) instead of
// passing cleanly — the rebound is then live for a follow-up. Runs each tick
// before the goal/out checks; emits a "woodwork" event for the renderer.
bool GameEngine::checkWoodwork() {
    auto& b = state.ball;
    if (b.controllerId >= 0) return false;
    double goalX, inSign;
    if (b.vx < -1.0 && b.x <= HOME_GOAL_X + BALL_R + 2.0 && b.x > HOME_GOAL_X - 28.0) { goalX = HOME_GOAL_X; inSign = 1.0; }
    else if (b.vx > 1.0 && b.x >= AWAY_GOAL_X - BALL_R - 2.0 && b.x < AWAY_GOAL_X + 28.0) { goalX = AWAY_GOAL_X; inSign = -1.0; }
    else return false;
    double center = PITCH_H / 2.0, half = GOAL_W / 2.0;
    double dyPost = std::abs(b.y - center);
    double topOfBall = b.z + BALL_R;
    bool withinPosts = dyPost <= half;
    // ── Crossbar ── arriving at the bar height, between the uprights.
    if (withinPosts && topOfBall >= GOAL_H - 1.0 && b.z <= GOAL_H + BALL_R + 4.0) {
        b.x = goalX + inSign * (BALL_R + 2.0);
        b.vx = -b.vx * 0.32;
        b.vz = -std::abs(b.vz) * 0.45 - 30.0;
        b.vy *= 0.70;
        b.curl = 0.0;
        lastLooseOrigin = LooseOrigin::Woodwork;
        emitEvent("woodwork", goalX, b.y, b.lastToucherId);
        return true;
    }
    // ── Post ── catching an upright (a sliver inside to just outside it), under
    // the bar. Mostly turns near-misses into rattles; rebounds back into play.
    if (topOfBall <= GOAL_H + 2.0 && dyPost >= half - 1.5 && dyPost <= half + BALL_R + 3.0) {
        double postSide = (b.y >= center) ? 1.0 : -1.0;
        b.x = goalX + inSign * (BALL_R + 2.0);
        b.vx = -b.vx * 0.45;
        b.vy = postSide * std::abs(b.vy) * 0.55;   // shove back off the upright
        b.vz *= 0.6;
        b.curl = 0.0;
        lastLooseOrigin = LooseOrigin::Woodwork;
        emitEvent("woodwork", goalX, center + postSide * half, b.lastToucherId);
        return true;
    }
    return false;
}

bool GameEngine::checkOutOfPlay() {
    auto& b = state.ball;
    Team lt = b.lastTouchTeam;
    auto clearState = [&]() {
        resolveKnockAhead(nullptr, "out_of_play");
        pendingPass.active = false;
        shot.clearFlags();
        lastLooseOrigin = LooseOrigin::None;
    };
    if (b.y < 0 || b.y > PITCH_H) {
        clearState();
        awardThrowIn(lt, b.y < 0 ? 0 : PITCH_H);
        return true;
    }
    if (b.x + BALL_R < HOME_GOAL_X) {
        // A ball over the bar (or wide) is out — only one passing UNDER the bar
        // between the posts was a goal (already taken by checkGoal).
        bool inGoal = std::abs(b.y - PITCH_H / 2) <= GOAL_W / 2 && b.z + BALL_R <= GOAL_H;
        if (!inGoal) {
            clearState();
            if(lt==Team::Home) awardCorner(Team::Away,true,b.y);
            else awardSetPiece(SetPiece::GoalKick, Team::Home);
            return true;
        }
    }
    if (b.x - BALL_R > AWAY_GOAL_X) {
        bool inGoal = std::abs(b.y - PITCH_H / 2) <= GOAL_W / 2 && b.z + BALL_R <= GOAL_H;
        if (!inGoal) {
            clearState();
            if(lt==Team::Away) awardCorner(Team::Home,false,b.y);
            else awardSetPiece(SetPiece::GoalKick, Team::Away);
            return true;
        }
    }
    return false;
}

void GameEngine::checkBallPlayerCollision(double){
    auto&b=state.ball;
    double bs=std::hypot(b.vx,b.vy);
    const double collectRadius=COLLECT_DIST;
    const double fastContactRadius=PLAYER_R+BALL_R-3.0;

    // ── First-time finish ── A driven LOW cross/cutback reaching an attacking
    // runner in the box is swept in FIRST-TIME rather than trapped: it is too
    // quick to control (it would skid through, or the keeper would gather it),
    // but a finisher meeting it goal-side can strike it clean. We route through
    // shootBall so it is a genuine tracked shot, and stamp throughCollected for
    // the clean first-touch error model (a FOOT finish, not a header). This sits
    // ahead of the keeper-gather so the striker who is first to the ball wins —
    // but only when he is actually closer to it than any keeper.
    if (b.controllerId < 0 && pendingPass.active && pendingPass.isCross
        && b.intendedReceiverId >= 0 && bs > 190.0 && b.z <= GROUND_MEET_MAX_Z + 6.0) {
        Player* rcv = playerById(b.intendedReceiverId);
        if (rcv && rcv->team == pendingPass.team
            && (rcv->role == Role::CF || rcv->role == Role::WM || rcv->role == Role::CM)) {
            double goalX = goalXFor(rcv->team);
            double tgd = std::abs(rcv->x - goalX);
            double dRcv = dist(rcv->x, rcv->y, b.x, b.y);
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
                } else if (dist(o.x, o.y, rcv->x, rcv->y) < 26.0) frontPress++;
            }
            if (inBox && reachable && !keeperCloser) {
                // A keeper right on top of the chance smothers the tap-in — proximity
                // to the RUNNER (not just the ball) cuts the finish toward zero.
                double gkProx = clamp((55.0 - gkDistToRcv) / 55.0, 0.0, 1.0);
                double finishChance = clamp(0.50 + attrFactor(rcv->attrs.shooting) * 0.30
                    - frontPress * 0.16 - gkProx * 0.45 - clamp((bs - 250.0) / 600.0, 0.0, 0.16), 0.12, 0.88);
                if (rng.random() < finishChance) {
                    rcv->firstTouchFinish = 1400.0; // flat, clean foot finish (not a header)
                    pendingPass.active = false;
                    b.intendedReceiverId = -1;
                    shootBall(*rcv, nullptr);
                    return;
                }
                // Scuffed the first-time effort — the ball runs loose.
                b.intendedReceiverId = -1;
                blockReboundFor(rcv->id, 200);
            }
        }
    }

    // A shot the keeper has already won the reflex roll on belongs to the
    // deferred-save resolver (parry/punch/tip/catch) — don't let the generic
    // keeper-gather scoop it first and flatten every save into a clean pickup.
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
            bool ballInOwnArea = std::abs(b.x - goalX) < PENALTY_AREA_W
                && std::abs(b.y - PITCH_H / 2.0) < PENALTY_AREA_H / 2.0;
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
                bool goalBound = std::abs(projY - PITCH_H / 2.0) < GOAL_W / 2.0 + 6.0
                                 && b.z + BALL_R <= GOAL_H;   // #1b: under the bar too
                if (goalBound) {
                    stats.recordShotOnTarget();
                    // #1c: a weak goalbound roller the keeper routinely scoops up is a
                    // CLAIM, not a "save" — counting every one of them is why saves run
                    // ~8/match (= onTarget) instead of the real ~3-4 (< onTarget 8-9).
                    // Count only genuine-pace stops as saves; the weak ones stay on-target.
                    if (std::hypot(b.vx, b.vy) > 295.0) stats.recordSave();   // #35: re-tuned 340->295 for the compressed-attr regime (slower shots; only 14% cleared 340 -> saves 1.5; real 3-4)
                    emitEvent("save", keeperContact->x, keeperContact->y, keeperContact->id);
                    keeperContact->diveAnim = std::max(keeperContact->diveAnim, 440.0);  // render-only stretch
                }
            }
            collectBall(*keeperContact);
            return;
        }
    }

    // Intended receiver gets priority with larger collection radius. A driven
    // cross arrives way over the 250 trap-speed limit — but it isn't trapped,
    // it's MET (header), so the band-height arrival bypasses the speed gate.
    bool crossArrival = pendingPass.active && pendingPass.isCross
        && b.z >= HEADER_MIN_HEIGHT && b.z <= HEADER_MAX_HEIGHT;
    if(b.intendedReceiverId>=0&&(bs<250||crossArrival)){
        Player* intended=playerById(b.intendedReceiverId);
        if(intended){
            double d=dist(intended->x,intended->y,b.x,b.y);
            // Z-AWARE SLANT REACH (not a horizontal cylinder). A header reaches
            // up to HEADER_REACH_Z high; the true ball->contact range is the
            // slant hypot of the horizontal gap and the height above that reach.
            // The old flat (d<=meetDist && z<=64) let a runner "meet/head" a
            // cross from ~3-4m and even at chest height — the ghost deflection.
            double reachZ = crossArrival ? HEADER_REACH_Z : 0.0;
            double reach  = crossArrival ? MEET_REACH_HEAD : MEET_REACH_GROUND;
            double zGate  = crossArrival ? HEADER_MAX_HEIGHT : GROUND_MEET_MAX_Z;
            double dz     = std::max(0.0, b.z - reachZ);
            double meetD3 = std::sqrt(d*d + dz*dz);
            // Aerial duel: a marker tight on the runner attacks the same ball —
            // but only if HE is genuinely within header reach of the BALL, not
            // just near the runner (the old od<48 picked a man up to ~7m off
            // the ball, who then "headed it clear" in mid-air).
            if(crossArrival&&meetD3<=reach&&b.z<=zGate&&canContestBall(*intended)){
                Player* dueler=nullptr;
                double duelerDist=1e9;
                for(auto& opp:state.players){
                    if(opp.team==intended->team||opp.role==Role::GK||!canContestBall(opp))continue;
                    double od=dist(opp.x,opp.y,intended->x,intended->y);
                    double obd=dist(opp.x,opp.y,b.x,b.y);
                    double obz=std::max(0.0,b.z-HEADER_REACH_Z);
                    double ob3=std::sqrt(obd*obd+obz*obz);
                    if(od<48.0&&ob3<=MEET_REACH_HEAD&&od<duelerDist){dueler=&opp;duelerDist=od;}
                }
                if(dueler){
                    // Aerial duel blends positioning with HEIGHT (50/50): a tall
                    // stopper out-jumps a small attacker on crosses. height defaults
                    // to positioning, so this is byte-identical until a spec sets a
                    // distinct height (then the tall man wins more).
                    double dAer = 0.5*attrFactor(dueler->attrs.positioning)   + 0.5*attrFactor(dueler->attrs.height);
                    double iAer = 0.5*attrFactor(intended->attrs.positioning) + 0.5*attrFactor(intended->attrs.height);
                    double duelChance=clamp(0.52
                        +(dAer-iAer)*0.35
                        +(48.0-duelerDist)/48.0*0.18,0.12,0.76);
                    if(rng.random()<duelChance){
                        dueler->headingAnim=520.0;
                        collectBall(*dueler);   // routes to header clearance
                        return;
                    }
                    // One jump per cross — a beaten dueler doesn't get to
                    // re-roll every tick the ball hangs in his radius.
                    blockReboundFor(dueler->id,420);
                }
            }
            if(meetD3<=reach&&b.z<=zGate
               &&crossArrival&&bs>300.0&&canContestBall(*intended)
               &&rng.random() > CROSS_MEET_BASE + attrFactor(intended->attrs.positioning)*CROSS_MEET_SKILL){
                blockReboundFor(intended->id,380);
            } else if(meetD3<=reach&&b.z<=zGate){
                if(canContestBall(*intended)){
                    // Find the tightest opponent and whether he's GOAL-SIDE
                    // (in front) of the receiver — receiving front-to-front
                    // with a defender between you and goal is the hard case:
                    // you can't turn, and controlling cleanly is far from
                    // guaranteed. A defender behind/beside is far less of a
                    // threat (you can shield and roll away).
                    double ifd=fdFor(intended->team);
                    double nearOppD=1e9; double frontPress=0.0; int tightMarkers=0;
                    for(auto& opponent:state.players){
                        if(opponent.team==intended->team||opponent.role==Role::GK||opponent.sentOff)continue;
                        double od=dist(opponent.x,opponent.y,intended->x,intended->y);
                        if(od<32.0)tightMarkers++;   // sandwiched count
                        if(od<nearOppD){
                            nearOppD=od;
                            double goalSide=(opponent.x-intended->x)*ifd; // >0 in front
                            // Only TIGHT pressure (<26px) disrupts control —
                            // a defender 3-4m off lets you take it cleanly.
                            // The curve is steep so only true front-to-front
                            // (a stride away, goal-side) really bites.
                            double prox=clamp((26.0-od)/26.0,0.0,1.0);
                            frontPress=prox*(goalSide>0.0?1.0:goalSide>-14.0?0.45:0.1);
                        }
                    }
                    // A second tight marker adds pressure regardless of side —
                    // a sandwiched receiver rarely controls a driven ball.
                    if(tightMarkers>=2)frontPress=std::max(frontPress,0.55);
                    if(nearOppD>=42.0){collectBall(*intended);return;}
                    // Control degrades with pace and, heavily, with front
                    // pressure. A striker fronted tight by a CB usually CAN'T
                    // just take it cleanly — he has to shield, lay off, or
                    // loses it. The base is deliberately modest so tight front
                    // pressure can pull it well down.
                    double trapChance=clamp(0.50+attrFactor(intended->attrs.positioning)*0.28
                        +attrFactor(intended->attrs.passing)*0.12
                        -clamp((bs-95.0)/360.0,0.0,0.20)
                        -frontPress*0.85,0.10,0.92);
                    if(rng.random()<trapChance){stats.recordPressuredReception(false);collectBall(*intended);return;}
                    stats.recordPressuredReception(true);
                    b.intendedReceiverId=-1;
                    receiverShieldTargetId=-1;
                    blockReboundFor(intended->id,150);
                }
            }
        }
    }

    // ── KEEPER CROSS-CLAIM ──
    // A live cross the intended receiver did NOT win, hanging in the keeper's
    // own 6-yard zone at takeable height: he comes and claims it. Sits AFTER the
    // intended-receiver block (the striker gets first refusal) and BEFORE the
    // generic loop, returning on commit so the GK-skip path never double-handles.
    // Every gate condition is deterministic board state — NO rng before commit.
    if (pendingPass.active && pendingPass.isCross && b.controllerId < 0
        && b.z >= GK_CLAIM_MIN_Z && b.z <= GK_CLAIM_MAX_Z) {
        Player* gk = nullptr;
        for (auto& p : state.players) {
            if (p.role != Role::GK || p.team == pendingPass.team) continue;  // defending keeper
            if (!canContestBall(p)) continue;
            gk = &p; break;
        }
        if (gk && agentFor(*gk)->canUseHands()) {
            double goalX = ownGoalXFor(gk->team);
            double bdg   = std::abs(b.x - goalX);
            bool inZone  = bdg < GK_CLAIM_DEPTH
                        && std::abs(b.y - PITCH_H / 2.0) < GK_CLAIM_HALF_W;
            double dz     = std::max(0.0, b.z - GK_CLAIM_REACH_Z);
            double claimD = std::hypot(dist(gk->x, gk->y, b.x, b.y), dz);
            if (inZone && claimD <= GK_CLAIM_RADIUS) {
                resolveCrossClaim(*gk, claimD);   // draws rng, then RETURNS
                return;
            }
        }
    }

    Player* contact = nullptr;
    double contactRadius = collectRadius;
    double bestContactScore = 1e9;
    bool intendedNearby = false;
    if (pendingPass.active && b.intendedReceiverId >= 0) {
        if (Player* intended = playerById(b.intendedReceiverId)) {
            intendedNearby = dist(intended->x, intended->y, b.x, b.y) < INTENDED_NEARBY_DIST;
        }
    }

    for(auto&p:state.players){
        if(!canContestBall(p))continue;
        double d=dist(p.x,p.y,b.x,b.y);
        // A live shot is only touchable by its pre-rolled blocker — everyone
        // else lost their one deliberate chance at launch. Keyed on the loose
        // origin (not shot.active, which the GK assessment clears at 250px).
        // Exception: defenders ASSIGNED to the shot lane are the designated
        // wall — deliberate positioning earns physical contact; bystanders
        // still can't eat shots.
        bool shotInFlight=lastLooseOrigin == LooseOrigin::Shot&&bs>95.0;
        bool designatedWall=false;
        if(shotInFlight&&p.id!=shot.blockerId&&p.team!=shot.team&&p.role!=Role::GK){
            const auto* task=assignmentFor(p.id);
            designatedWall=task&&task->role==DefensiveTask::ShotLane;
        }
        if(shotInFlight&&p.role!=Role::GK&&p.id!=shot.blockerId&&!designatedWall)continue;
        double r=(bs>COLLISION_FAST_CONTACT&&p.team!=b.lastTouchTeam)?fastContactRadius:collectRadius;
        // A dead ball is collectible from a stride away — opponent separation
        // (24px) parked two players 10-12px from it, just outside the 8px
        // radius, in a 2.8s Mexican standoff ~43 times a match.
        if(bs<30.0)r=std::max(r,COLLECT_DIST+6.0);
        // The chosen blocker / wall gets the FULL block reach (leg+body across the
        // lane), matching the block-roll radius — otherwise a defender selected to
        // block at perp 14-27px never connects (fastContactRadius is only 13.5px),
        // which is why shotsBlocked sat at 0.
        if(shotInFlight&&(p.id==shot.blockerId||designatedWall))r=PLAYER_R+BALL_R+11.0;
        if(d>r)continue;
        double zLimit = pendingPass.active && pendingPass.isCross ? HEADER_MAX_HEIGHT : AERIAL_HEIGHT;
        if(b.z>zLimit)continue;
        if(p.role==Role::GK){
            continue;
        }
        // Intended receiver already handled above — skip them here
        if(p.id==b.intendedReceiverId)continue;
        if(pendingPass.active && intendedNearby && p.team==pendingPass.team && bs<INTENDED_PASS_SPEED_LIMIT)continue;
        double score=d/std::max(1.0,r);
        if(p.team!=b.lastTouchTeam)score-=0.10;
        if(score<bestContactScore){
            bestContactScore=score;
            contact=&p;
            contactRadius=r;
        }
    }

    if(!contact)return;
    if(pendingPass.active && pendingPass.isCross && b.z >= HEADER_MIN_HEIGHT && b.z <= HEADER_MAX_HEIGHT){
        // Cutting out a whipped delivery is a duel, not a given — the old
        // unconditional collect meant the first body on the flight line ate
        // every driven cross. A whiff locks the defender out so it flies past.
        if(contact->team!=pendingPass.team && bs>300.0){
            double cutChance=clamp(CROSS_CUTOUT_BASE+attrFactor(contact->attrs.positioning)*CROSS_CUTOUT_SKILL-(bs-300.0)/700.0,0.08,0.58);
            if(rng.random()>=cutChance){blockReboundFor(contact->id,420);return;}
        }
        // A defender cutting out a cross near his own line often puts it BEHIND for a
        // corner rather than controlling it cleanly — the dominant real corner source.
        // With 250+ crosses/match this is the main lever toward a realistic count
        // (engine sat at ~2 vs ~10 because every cut was a clean collect).
        if(contact->team!=pendingPass.team){
            double ownLineX=ownGoalXFor(contact->team);
            if(std::abs(b.x-ownLineX)<175.0 && rng.random()<0.55){   // corners 2.7->6.5: dominant source, was 28%/140. Raising the rate further (0.70) was noise — the cut-near-line VOLUME caps it, not the rate; the last ~3 (toward real ~10) need a kicked-clearance-behind source.
                awardCorner(pendingPass.team, contact->team==Team::Home, b.y);
                return;
            }
        }
        collectBall(*contact);
        return;
    }
    if(bs<COLLISION_SPEED_THRESH){
        collectBall(*contact);
        return;
    }
    if(bs>COLLISION_SPEED_THRESH){
        double dx=b.x-contact->x,dy=b.y-contact->y,d2=std::hypot(dx,dy);
        if(d2<1)return;
        double nx=dx/d2,ny=dy/d2;
        double dot=b.vx*nx+b.vy*ny;
        // A ball moving AWAY from the player isn't a touch: phantom grazes
        // applied damp, flipped last-touch, and rebound-blocked bystanders
        // (600ms, re-applied per tick) just for standing near a pass lane.
        if(dot>=0)return;
        // A fast loose ball driven AT an opponent's body is a reaction duel,
        // not a given: the chance to get a touch in falls off hard with pace —
        // a ~24m/s ball is blockable, a rocket usually flies past. Same-team
        // balls (a shin deflection off a teammate) always make contact. A
        // whiffed read locks the bystander out (no per-tick re-roll) so it
        // passes clean instead of being eaten frame-by-frame.
        if(contact->team!=b.lastTouchTeam){
            double blockChance=clamp(LOOSE_BLOCK_BASE
                +attrFactor(contact->attrs.positioning)*LOOSE_BLOCK_SKILL
                -(bs-COLLISION_SPEED_THRESH)/LOOSE_BLOCK_SPEED_FALLOFF,0.06,0.92);
            if(rng.random()>=blockChance){blockReboundFor(contact->id,360);return;}
        }
        b.x=contact->x+nx*contactRadius;b.y=contact->y+ny*contactRadius;
        b.vx-=COLLISION_REFLECT_FACTOR*dot*nx;b.vy-=COLLISION_REFLECT_FACTOR*dot*ny;
        double damp=(b.lastTouchTeam==contact->team)?COLLISION_DAMP_SAME_TEAM:COLLISION_DAMP_OPPONENT;
        b.vx*=damp;b.vy*=damp;
        double glance=(b.lastTouchTeam==contact->team)?COLLISION_GLANCE_SAME:COLLISION_GLANCE_OPPONENT;
        b.vx+=ny*bs*glance;b.vy+=-nx*bs*glance;
        b.lastTouchTeam=contact->team;b.lastToucherId=contact->id;
        if(contact->team==lastCollectionTeam)lastSameTeamCollectionMs=state.clockMs-500;
        blockReboundFor(contact->id,600);
        bool wallBlock=false;
        if(lastLooseOrigin == LooseOrigin::Shot&&contact->id!=shot.blockerId&&contact->team!=shot.team){
            const auto* task=assignmentFor(contact->id);
            wallBlock=task&&task->role==DefensiveTask::ShotLane;
        }
        if(lastLooseOrigin == LooseOrigin::Shot&&(contact->id==shot.blockerId||wallBlock)){
            // Handball (Law 12): a defender blocking INSIDE HIS OWN BOX sometimes stops it with an
            // arm -> penalty. Gated low (~1 per several matches), in-box only, a simple probabilistic
            // model (not full arm-geometry). Adds penalty VARIETY alongside the tackle-fouls.
            double hbLine=ownGoalXFor(contact->team);
            bool hbInBox=std::abs(b.x-hbLine)<PENALTY_AREA_W
                         &&std::abs(b.y-PITCH_H/2.0)<PENALTY_AREA_H/2.0;
            if(hbInBox&&rng.random()<0.040){
                shot.active=false; shot.tracked=false;
                lastLooseOrigin = LooseOrigin::ShotBlock;
                stats.recordPenaltyAwarded();
                emitEvent("handball", contact->x, contact->y, contact->id, shot.shooterId);
                awardSetPiece(SetPiece::Penalty, shot.team);
            } else {
                stats.recordShotBlocked();
                emitEvent("block", contact->x, contact->y, contact->id, shot.shooterId);
                shot.active=false; shot.tracked=false;
                lastLooseOrigin = LooseOrigin::ShotBlock;
                // A block close to the defender's own line that deflects goalward
                // often loops behind for a corner — another corner source the
                // engine never produced.
                double ownLine=ownGoalXFor(contact->team);
                bool nearLine=std::abs(b.x-ownLine)<150.0;
                bool deflectingBehind=(ownLine==0.0)?b.vx<0:b.vx>0;
                if(nearLine&&deflectingBehind&&rng.random()<0.80){   // corner boost (was 0.65)
                    awardCorner(shot.team, contact->team==Team::Home, b.y);
                }
            }
        }
    }
}

void GameEngine::collectBall(Player& c) {
    auto& b = state.ball;
    if (!canContestBall(c)) return;
    contestBlockedUntil[c.id] = 0;
    bool intended = receiverShieldTargetId == c.id;
    bool teammateTarget = receiverShieldTargetId >= 0 && b.lastTouchTeam == c.team;
    resolveKnockAhead(&c);
    if (resolvePendingPass(c)) return;
    if (c.role != Role::GK) {
        double fdx = b.x - c.x, fdy = b.y - c.y;
        double fd = std::hypot(fdx, fdy);
        if (fd > 0.1) {
            // Turn toward the ball, capped — the hard set spun players up to
            // 175 degrees in one 16ms tick on every reception.
            double want = std::atan2(fdy, fdx);
            double delta = std::atan2(std::sin(want - c.facing), std::cos(want - c.facing));
            c.facing += clamp(delta, -1.2, 1.2);
        }
    }
    if (lastCollectionTeam.has_value() && c.team == *lastCollectionTeam && state.clockMs - lastSameTeamCollectionMs < PING_PONG_WINDOW_MS) {
        teammatePingPongs++;
        stats.recordCollection(true);
    }
    // Assist bookkeeping: a fresh controlled touch ends any prior receive
    // link for this slot (a dribble/recovery is not an assisted goal).
    if (c.id >= 0 && c.id < 22 && receiverShieldTargetId != c.id) lastReceiveFrom[c.id] = -1;
    stats.recordControlledTouch(c.role);
    lastCollectionTeam = c.team;
    lastSameTeamCollectionMs = state.clockMs;
    // A keeper gathering a live ball holds it before distributing — without
    // this he could collect a 400px/s shot and punt it upfield in the SAME
    // tick, which read as the ball ricocheting off him like a pinball.
    double incoming = std::hypot(b.vx, b.vy);
    if (c.role == Role::GK) {
        goalKickMonitor.distributeTimer = std::max(goalKickMonitor.distributeTimer,
            clamp(700.0 + incoming * 1.2, 700.0, 1500.0));
    } else if (c.id >= 0 && c.id < 22) {
        // Settle window before a deliberate pass — long for a fierce ball,
        // ~nil for a gently rolled one, shorter for a composed player. He can
        // still dribble/shield during it (and shoot a first-timer).
        double settle = clamp((incoming - 90.0) / 300.0, 0.0, 1.0)
            * (165.0 - attrFactor(c.attrs.positioning) * 110.0);
        firstTouchUntilMs[c.id] = state.clockMs + settle;
    }
    shot.clearFlags();
    lastLooseOrigin = LooseOrigin::None;
    b.controllerId = c.id;
    b.intendedReceiverId = -1;
    b.curl = 0.0;
    b.vx *= .3;
    b.vy *= .3;
    b.z = b.vz = 0;
    b.lastTouchTeam = c.team;
    b.lastToucherId = c.id;
    c.dribbleType = 0;
    double fd = fdFor(c.team);
    c.targetX = clampToPitchX(c.x + fd * 28.0, 35.0);
    c.targetY = clampToPitchY(c.y, 35.0);
    if (intended) {
        receiverShieldUntil = state.clockMs + 300;
        receiverShieldedPlayerId = c.id;
        receiverShieldTargetId = -1;
    } else if (teammateTarget) {
        receiverShieldUntil = state.clockMs + 150;
        receiverShieldedPlayerId = c.id;
    } else {
        receiverShieldUntil = state.clockMs + 220;
        receiverShieldedPlayerId = c.id;
        receiverShieldTargetId = -1;
    }
}

bool GameEngine::collectBall(Player& c, const std::string&, double allowedDist) {
    auto& b = state.ball;
    if (b.controllerId >= 0) return false;
    if (!canContestBall(c)) return false;
    if (dist(c.x, c.y, b.x, b.y) > allowedDist + 0.001) return false;
    collectBall(c);
    return true;
}

void GameEngine::updateControlledBall(double) {
    Player* c = playerById(state.ball.controllerId);
    if (!c || phase.kickoffPhase) return;
    double dx = std::cos(c->facing), dy = std::sin(c->facing);
    double speed = std::hypot(c->vx, c->vy);
    double nearestOppDist = 1e9;
    double nearestOppX = 0.0, nearestOppY = 0.0;
    if (c->role != Role::GK) {
        for (const auto& o : state.players) {
            if (o.team == c->team || o.role == Role::GK) continue;
            double od = dist(c->x, c->y, o.x, o.y);
            if (od < nearestOppDist) {
                nearestOppDist = od;
                nearestOppX = o.x;
                nearestOppY = o.y;
            }
        }
    }
    if (c->role != Role::GK && speed > 18.0) {
        double mx = c->vx / speed, my = c->vy / speed;
        double facingMoveDot = dx * mx + dy * my;
        double moveBlend = facingMoveDot < 0.15 ? 0.75 : 0.35;
        if (nearestOppDist < 68.0) {
            double pressure = clamp((68.0 - nearestOppDist) / 68.0, 0.0, 1.0);
            double toOppX = (nearestOppX - c->x) / std::max(1.0, nearestOppDist);
            double toOppY = (nearestOppY - c->y) / std::max(1.0, nearestOppDist);
            double exposure = dx * toOppX + dy * toOppY;
            double shielded = exposure < -0.25 ? 1.0 : 0.0;
            moveBlend *= lerp(0.65, 0.86, shielded) - pressure * 0.08;
            moveBlend = clamp(moveBlend, 0.12, 0.75);
        }
        dx = dx * (1.0 - moveBlend) + mx * moveBlend;
        dy = dy * (1.0 - moveBlend) + my * moveBlend;
        double len = std::hypot(dx, dy);
        if (len > 0.001) { dx /= len; dy /= len; }
    }
    state.ball.x = clamp(c->x + dx * CONTROL_DIST, 5.0, PITCH_W - 5.0);
    state.ball.y = clamp(c->y + dy * CONTROL_DIST, 5.0, PITCH_H - 5.0);
    state.ball.lastTouchTeam = c->team;
    state.ball.lastToucherId = c->id;
}

void GameEngine::moveBallCarrier(double sdt){
    Player*c=playerById(state.ball.controllerId);
    if(!c)return;
    if(c->dribbleType==0){
        c->targetX=c->x;
        c->targetY=c->y;
        c->vx=0;
        c->vy=0;
        updateControlledBall(0);
        return;
    }
    double limit=c->dribbleType==1?DRIBBLE_CLOSE_SPEED:c->dribbleType==3?DRIBBLE_FAST_SPEED:DRIBBLE_MEDIUM_SPEED;
    double speed=attrFactor(c->attrs.speed)*limit;
    double dx=c->targetX-c->x,dy=c->targetY-c->y,d=std::hypot(dx,dy);
    double secs=sdt/1000.0,px=c->x,py=c->y;
    double previousSpeed=std::hypot(c->vx,c->vy);
    double previousAngle=previousSpeed>5?std::atan2(c->vy,c->vx):0;
    double moveAngle=d>1?std::atan2(dy,dx):previousAngle;
    bool turnWasLimited=false;
    if(d>1&&previousSpeed>5){
        double requestedTurn=std::atan2(std::sin(moveAngle-previousAngle),std::cos(moveAngle-previousAngle));
        // Path turn caps: a carrier carving 17 rad/s zigzagged on every target
        // jitter and read as spinning. Smooth arcs instead.
        double turnRate=c->dribbleType==1?9.0:c->dribbleType==3?5.5:7.5;
        double maxTurn=turnRate*secs;
        if(std::abs(requestedTurn)>maxTurn){
            moveAngle=previousAngle+clamp(requestedTurn,-maxTurn,maxTurn);
            turnWasLimited=true;
        }
    }
    if(d>1){
        double step=std::min(speed*secs,d);
        if(step>=d){c->x=c->targetX;c->y=c->targetY;}
        else{c->x+=std::cos(moveAngle)*step;c->y+=std::sin(moveAngle)*step;}
    }
    c->x=clamp(c->x,5.0,PITCH_W-5.0);c->y=clamp(c->y,5.0,PITCH_H-5.0);
    c->vx=(c->x-px)/secs;c->vy=(c->y-py)/secs;
    double actualSpeed=std::hypot(c->vx,c->vy);
    if(previousSpeed>5&&actualSpeed>5){
        double actualTurn=std::abs(std::atan2(
            std::sin(std::atan2(c->vy,c->vx)-previousAngle),
            std::cos(std::atan2(c->vy,c->vx)-previousAngle)));
        double actualTurnDeg=actualTurn*180.0/3.141592653589793;
        stats.recordCarrierTurn(actualTurn>3.141592653589793/2,actualTurnDeg,turnWasLimited);
    }
    if(actualSpeed>5){
        double desiredFacing=std::atan2(c->vy,c->vx);
        double nearestOppDist=1e9;
        double nearestOppX=0.0,nearestOppY=0.0;
        if(c->role!=Role::GK){
            for(const auto& o:state.players){
                if(o.team==c->team||o.role==Role::GK)continue;
                double od=dist(c->x,c->y,o.x,o.y);
                if(od<nearestOppDist){nearestOppDist=od;nearestOppX=o.x;nearestOppY=o.y;}
            }
        }
        if(nearestOppDist<68.0){
            double awayAngle=std::atan2(c->y-nearestOppY,c->x-nearestOppX);
            double pressure=clamp((68.0-nearestOppDist)/68.0,0.0,1.0);
            double shieldBlend=lerp(0.14,0.38,pressure);
            desiredFacing+=std::atan2(std::sin(awayAngle-desiredFacing),std::cos(awayAngle-desiredFacing))*shieldBlend;
        }
        double desiredStep=std::atan2(std::sin(desiredFacing-c->facing),std::cos(desiredFacing-c->facing))*0.28;
        double speedBlend=clamp((actualSpeed-12.0)/58.0,0.0,1.0);
        // Carrier-only cap: 0.24 rad/tick let body facing whirl after every
        // velocity jitter (the chaser-perception deadlock doesn't apply here).
        double maxFacingTurn=lerp(0.11,0.055,speedBlend);
        c->facing+=clamp(desiredStep,-maxFacingTurn,maxFacingTurn);
    }
    updateControlledBall(0);
}

