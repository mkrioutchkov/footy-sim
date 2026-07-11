#include "engine.h"
#include "agent.h"
#include <cmath>
#include <numbers>
#include <iostream>   // §1.3b: [live] inject-applied logging in applyLiveCommands

// ══════════════════════════════════════════════════════════════
// Tactical — assignments, defensive roles, tactical audit
// ══════════════════════════════════════════════════════════════

void GameEngine::setAssignment(Player& player, DefensiveTask role, double x, double y, int opponentId) {
    // Man-mark hysteresis (see AssignLock in engine.h): a held mark with a
    // live opponent persists 900ms against a DIFFERENT incoming assignment,
    // unless the ball is close (near-ball reactions stay instant). The kept
    // target is recomputed goal-side of the marked man's CURRENT position.
    {
        auto& lk = assignLock[player.id];
        bool differs = lk.role != role || lk.oppId != opponentId;
        if (differs && lk.oppId >= 0
            && state.clockMs - lk.changedMs < 900.0
            && dist(player.x, player.y, state.ball.x, state.ball.y) > 250.0) {
            Player* mo = playerById(lk.oppId);
            if (mo && !mo->sentOff) {
                double og = ownGoalXFor(player.team);
                double gdx = og - mo->x, gdy = PITCH_H / 2.0 - mo->y;
                double gl = std::max(1.0, std::hypot(gdx, gdy));
                assignmentByPlayer[player.id] = {lk.role, lk.oppId,
                    clamp(mo->x + gdx / gl * 14.0, 35.0, PITCH_W - 35.0),
                    clamp(mo->y + gdy / gl * 14.0, 35.0, PITCH_H - 35.0)};
                return;
            }
        }
        if (differs) { lk.role = role; lk.oppId = opponentId; lk.changedMs = state.clockMs; }
    }
    double tx = clamp(x, 35.0, PITCH_W - 35.0);
    double ty = clamp(y, 35.0, PITCH_H - 35.0);
    // Assignment-target spacing (2026-07-02 knot logger): 41% of six-player-crowd
    // members were defensive TASK targets stacked within 50px — press point,
    // lanes, screen and cover all sit on the same carrier→goal line. Keep a
    // ZONE target a body-width off any same-team assignment already placed
    // (earlier phases = higher priority claim their spot; later ones shade
    // off it). Man-oriented tasks (a real opponent to touch: press, marks with
    // opponentId) are untouched — they MUST converge.
    // 40px is MEASURED, not arbitrary: 48-seed paired A/B gave blobs −22.8±15.1
    // with goals in band; the 55px notch was A/B'd the same evening and REJECTED
    // (blob gain marginal 395→392, goals +0.58 paired — way past the ±0.35 gate:
    // wider shading visibly loosens the defensive block). Don't raise it blind.
    if (opponentId < 0 && role != DefensiveTask::PrimaryPress && role != DefensiveTask::SecondaryPress) {
        for (auto& q : state.players) {
            if (q.team != player.team || q.id == player.id || q.sentOff) continue;
            const auto& other = assignmentByPlayer[q.id];
            if (other.role == DefensiveTask::None) continue;
            double ddx = tx - other.targetX, ddy = ty - other.targetY;
            double d = std::hypot(ddx, ddy);
            if (d >= 40.0) continue;
            if (d < 1.0) { ddx = (player.id % 2 == 0) ? 1.0 : -1.0; ddy = 0.0; d = 1.0; }
            tx = clamp(other.targetX + ddx / d * 40.0, 35.0, PITCH_W - 35.0);
            ty = clamp(other.targetY + ddy / d * 40.0, 35.0, PITCH_H - 35.0);
        }
        // Depth-shading NOTE (2026-07-04, rejected): crowd-aware slide of
        // ShotLane/Cover/MidfieldScreen targets 45px toward own goal when >=3
        // bodies stood within 45px of the spot. 48-seed paired (two independent
        // 24-batches): blobs −12.5 ± 15.4 @2SE — consistent point estimate
        // (−12.9/−12.1) but UNRESOLVED, guards clean. Fire-rate instrument
        // showed WHY the ceiling is low: ~25k fires/match (screen lives in a
        // permanent midfield crowd) yet ~−3% blobs — most knot members (57%
        // per FOOTY_BLOBDEBUG) already have targets OUTSIDE the knot and are
        // merely in transit. Target-placement levers only reach the other 43%
        // and are near exhausted (this 40px spacing −5.5%, the positioning
        // teammate-crowding term −5.7%, depth shading −2.9% n.s.). Next lever
        // class is movement-side (crowd-exit urgency) or assignment-count
        // (send fewer bodies to the same contest) — not target geometry.
    }
    assignmentByPlayer[player.id] = {role, opponentId, tx, ty};
}

// ── Plain-English tactics interpreter ──
// Runs once per tick AFTER updateTeamAssignments() (which wipes+rebuilds the
// assignment array) and BEFORE tickAgents() reads it. man_mark overrides one
// assignment slot (goal-side shadow + opponentId, reusing the LaneBlock
// executor); the bias kinds stash a per-player nudge the scorers consult. Pure
// function of clock + score — NO rng (any draw here would desync the stream).
// §1.3: which team a directive belongs to — team-wide dials carry teamScope (0/1); player
// directives carry a playerId (0-10 home, 11-21 away). Lets an inject replace only ONE side's set.
static int directiveTeam(const GameEngine::Directive& d) {
    return d.teamScope >= 0 ? d.teamScope : (d.playerId >= 0 && d.playerId < 11 ? 0 : 1);
}

// Apply one timeline / live-inject entry: REPLACE the active directive set (team-scoped when the
// entry names a team — §1.3/§4 per-team — else the whole set, byte-identical to the old single-set
// path) + the entry's per-player morale deltas + formation re-anchor. Shared by the timeline replay
// and applyLiveCommands so live-inject ≡ timeline-replay. Clock-driven, NO rng (determinism).
void GameEngine::applyDirectiveEntry(const TimelineEntry& e) {
    if (e.team >= 0) {
        directives.erase(std::remove_if(directives.begin(), directives.end(),
            [&](const Directive& d) { return directiveTeam(d) == e.team; }), directives.end());
        directives.insert(directives.end(), e.directives.begin(), e.directives.end());
    } else {
        directives = e.directives;
    }
    for (int i = 0; i < 22 && i < (int)state.players.size(); ++i)
        if (e.moraleDelta[i] != 0.0 && !state.players[i].sentOff)
            state.players[i].moraleBoost = clamp(state.players[i].moraleBoost + e.moraleDelta[i], -1.0, 1.0);
    for (int i = 0; i < 22 && i < (int)state.players.size(); ++i) {
        if (!e.layoutSet[i] || state.players[i].sentOff || state.players[i].role == Role::GK) continue;
        baseHomeX[i] = e.layoutHX[i]; baseHomeY[i] = e.layoutHY[i];
        state.players[i].homeX = e.layoutHX[i]; state.players[i].homeY = e.layoutHY[i];
        reassignAgent(state.players[i], e.layoutRole[i]);
    }
}

// §1.3b: drain the live inject queue — apply every entry whose atMs has arrived (clock>=atMs),
// per-team, via the shared applyDirectiveEntry (so live-inject ≡ timeline-replay). Called in
// fixedUpdate AFTER applyDirectives so the live overlay replaces the pre-match plan. NO rng.
void GameEngine::applyLiveCommands() {
    if (liveCommandQueue.empty()) return;
    for (auto it = liveCommandQueue.begin(); it != liveCommandQueue.end(); ) {
        if (state.clockMs >= it->atMs) {
            applyDirectiveEntry(*it);
            std::cerr << "[live] applied inject atMs=" << it->atMs << " team=" << it->team << "\n";
            it = liveCommandQueue.erase(it);
        } else {
            ++it;
        }
    }
}

void GameEngine::applyDirectives() {
    directiveBias.fill({});
    dialOverride = {};      // reset team-wide dial deltas each tick (clock-driven)
    // Reset the per-tick directive hooks (defenseHoldingShape is NOT reset here —
    // it's set for both teams in assignDefensiveRoles each tick).
    for (auto& t : teamTactics) {
        t.longBallBias = 0; t.slowTempo = 0; t.counterAttackBonus = 0;
        t.offsideTrapActive = false; t.shootDistBias = 0; t.allOutActive = false;
    }
    // Snapshot the kickoff formation anchors the first time through, then reset
    // every player's homeX/homeY to base — a directive that lapsed (time window
    // passed, plan replaced) must spring back to its original station.
    if (!baseHomeXCaptured) {
        for (auto& p : state.players) { baseHomeX[p.id] = p.homeX; baseHomeY[p.id] = p.homeY; }
        baseHomeXCaptured = true;
    }
    for (auto& p : state.players) { p.homeX = baseHomeX[p.id]; p.homeY = baseHomeY[p.id]; }
    // P2: advance the timeline — a plan change whose time has arrived replaces
    // the active directive set. Clock-driven (no rng), so replays are identical.
    while (directiveTimelineIdx < directiveTimeline.size()
           && state.clockMs >= directiveTimeline[directiveTimelineIdx].atMs) {
        applyDirectiveEntry(directiveTimeline[directiveTimelineIdx]);
        directiveTimelineIdx++;
    }
    // §1.3b determinism fix (SysArch sign-off): apply LIVE injects HERE — the SAME point as the
    // timeline replay (right after the timeline loop, BEFORE this tick's dial-application) — so a
    // live inject and its recorded timeline entry both take effect ATOMICALLY on their atMs tick:
    // live-inject ≡ timeline-replay, no 1-tick offset. Empty queue / non-live = no-op (byte-identical).
    applyLiveCommands();
    if (directives.empty()) return;
    int minute = static_cast<int>(state.clockMs / 60000.0);
    for (const auto& d : directives) {
        // Resolve the team this directive concerns (for the score condition and
        // for team-scoped dial commands). Player-scoped directives resolve a
        // player; team-scoped ones (teamScope 0/1) skip the player lookup.
        Player* p = nullptr;
        Team team;
        if (d.teamScope >= 0) {
            team = d.teamScope == 0 ? Team::Home : Team::Away;
        } else {
            p = playerById(d.playerId);
            if (!p) continue;
            team = p->team;
        }
        // Condition: time window (default 0..1000 => whole match).
        if (minute < d.fromMin || minute > d.toMin) continue;
        // Condition: score state for the concerned team.
        if (d.scoreState != CondScore::Any) {
            int diff = team == Team::Home ? state.homeScore - state.awayScore
                                          : state.awayScore - state.homeScore;
            int n = std::max(1, d.scoreBy);
            bool ok = (d.scoreState == CondScore::Winning && diff >= n)
                   || (d.scoreState == CondScore::Drawing && diff == 0)
                   || (d.scoreState == CondScore::Losing  && diff <= -n);
            if (!ok) continue;
        }
        // Condition: possession PHASE for the concerned team (gates counter_press / play-out-from-back /
        // transition behaviours). inPoss = the ball controller is on this team; transition = recent turnover.
        if (d.phase != CondPhase::Any) {
            Player* ctrl = playerById(state.ball.controllerId);
            bool inPoss = ctrl && ctrl->team == team;
            bool ok = (d.phase == CondPhase::InPossession   && inPoss)
                   || (d.phase == CondPhase::OutOfPossession && !inPoss)
                   || (d.phase == CondPhase::Transition      && state.clockMs < transitionUntilMs);
            if (!ok) continue;
        }
        // ── Team-wide dial command: nudge this team's 5 dials. Added on top of
        // the base config in configFor() and clamped, so the whole side shifts
        // shape (press height, line, width, tempo) coherently. ──
        if (d.teamScope >= 0) {
            ConfigDelta& dv = dialOverride[d.teamScope];
            double k = d.intensity;
            switch (d.kind) {
                case DirectiveKind::AllOutAttack:   dv.aggression+=30*k; dv.defensiveLineHeight+=25*k; dv.overlapFrequency+=25*k; dv.midfieldFreedom+=20*k; teamTactics[d.teamScope].allOutActive=true; break;
                case DirectiveKind::ParkTheBus:     dv.aggression-=28*k; dv.defensiveLineHeight-=32*k; dv.overlapFrequency-=25*k; dv.midfieldFreedom-=15*k; break;
                case DirectiveKind::HighPress:      dv.aggression+=35*k; dv.defensiveLineHeight+=22*k; dv.midfieldFreedom+=6*k;  break;
                case DirectiveKind::DropOff:        dv.aggression-=32*k; dv.defensiveLineHeight-=40*k; break;
                case DirectiveKind::PlayItLong:     dv.passingDirectness+=58*k; dv.midfieldFreedom-=14*k; dv.overlapFrequency-=5*k; teamTactics[d.teamScope].longBallBias+=k; break;
                case DirectiveKind::CounterAttack:  teamTactics[d.teamScope].counterAttackBonus+=k; break;
                case DirectiveKind::KeepItOnGround: dv.passingDirectness-=30*k; dv.midfieldFreedom+=10*k; break;
                case DirectiveKind::GetItWide:
                    // overlapFrequency only pushes FBs FORWARD (widthPush adds to homeX),
                    // so "get it wide" must actually widen the wide players' lateral anchor.
                    dv.overlapFrequency+=20*k;
                    for (auto& wp2 : state.players)
                        if ((wp2.team == Team::Home) == (d.teamScope == 0) && roles::isWide(wp2.role)) {
                            double sgn = baseHomeY[wp2.id] < PITCH_H / 2.0 ? -1.0 : 1.0;
                            wp2.homeY = clamp(baseHomeY[wp2.id] + sgn * 75.0 * k, 24.0, PITCH_H - 24.0);
                        }
                    break;
                case DirectiveKind::PlayNarrow:
                    dv.overlapFrequency-=20*k; dv.midfieldFreedom+=15*k;
                    for (auto& wp2 : state.players)
                        if ((wp2.team == Team::Home) == (d.teamScope == 0) && roles::isWide(wp2.role))
                            wp2.homeY = lerp(baseHomeY[wp2.id], PITCH_H / 2.0, 0.35 * k);
                    break;
                case DirectiveKind::PushUp:         dv.defensiveLineHeight+=30*k; dv.aggression+=10*k; break;
                case DirectiveKind::OffsideTrap:    dv.defensiveLineHeight+=45*k; dv.aggression+=15*k; teamTactics[d.teamScope].offsideTrapActive=true; break;
                case DirectiveKind::ShootFromDistance: teamTactics[d.teamScope].shootDistBias += 70.0 * k; break;   // shoot from further out
                case DirectiveKind::WorkItIntoBox:     teamTactics[d.teamScope].shootDistBias -= 60.0 * k; break;   // hold for a closer shot
                case DirectiveKind::SlowItDown:     dv.passingDirectness-=34*k; dv.aggression-=22*k; dv.overlapFrequency-=12*k; teamTactics[d.teamScope].slowTempo+=k; break;
                // tactical-depth (Gaylord seam): press_intensity 0-1 (0=contain/no-chase, 0.5=neutral,
                // 1=high press) — exposes the aggression/chase knob as a slider + compresses the block
                // up when pressing high. Generalizes high_press. (mentality / line_height to follow.)
                case DirectiveKind::PressIntensity: { double s=(k-0.5)*2.0; dv.aggression+=s*38.0; dv.defensiveLineHeight+=s*16.0; } break;
                // mentality 0-1 (0=ultra-defensive, 0.5=balanced, 1=all-out): how many bodies commit
                // forward + the rest shape. Generalizes all_out_attack/park_the_bus.
                case DirectiveKind::Mentality: { double s=(k-0.5)*2.0; dv.aggression+=s*26.0; dv.defensiveLineHeight+=s*22.0; dv.overlapFrequency+=s*24.0; dv.midfieldFreedom+=s*18.0; } break;
                // line_height 0-1 (0=deep block, 0.5=neutral, 1=high line): the back line's rest-x +
                // compactness. Generalizes push_up/drop_off (pairs with offside_trap); LINE-focused (the
                // press is press_intensity's axis), just a small aggression nudge to hold/concede the line.
                case DirectiveKind::LineHeight: { double s=(k-0.5)*2.0; dv.defensiveLineHeight+=s*35.0; dv.aggression+=s*8.0; } break;
                default: break;
            }
            continue;
        }
        // ── Per-player directive ──
        double fd = fdFor(p->team);
        switch (d.kind) {
            case DirectiveKind::ManMark: {
                Player* t = playerById(d.targetId);
                if (!t) break;
                double ownGoalX = ownGoalXFor(p->team);
                double tx = lerp(t->x, ownGoalX + fd * 36.0, 0.20);   // goal-side of the man
                double ty = lerp(t->y, PITCH_H / 2.0, 0.05);
                setAssignment(*p, DefensiveTask::LaneBlock, tx, ty, d.targetId);
                break;
            }
            case DirectiveKind::ShootOnSight: directiveBias[p->id].shootOnSight = true; break;
            // Set-piece taker designations are read at the RESTART (designatedTakerFor); no per-tick action.
            case DirectiveKind::FkTaker:
            case DirectiveKind::CornerTaker:
            case DirectiveKind::PenTaker:
            case DirectiveKind::LongThrowTaker: break;
            // Forward/back anchor (210px = a full role-band, visibly higher).
            case DirectiveKind::GetForward:
                p->homeX = clamp(baseHomeX[p->id] + fd * 210.0 * d.intensity, 30.0, PITCH_W - 30.0);
                break;
            case DirectiveKind::SitDeep:
                p->homeX = clamp(baseHomeX[p->id] - fd * 150.0 * d.intensity, 30.0, PITCH_W - 30.0);
                break;
            case DirectiveKind::TargetPlayer:
                directiveBias[p->id].passTargetId = d.targetId;
                directiveBias[p->id].passTargetBias = 0.30 * d.intensity;
                break;
            // Lateral anchor: stay_wide pushes toward the near touchline; come_inside
            // / stay_central pull toward the middle. Positioning keys off homeY, so
            // the whole shape slides sideways coherently.
            case DirectiveKind::StayWide: {
                double sign = baseHomeY[p->id] < PITCH_H / 2.0 ? -1.0 : 1.0;
                p->homeY = clamp(baseHomeY[p->id] + sign * 90.0 * d.intensity, 24.0, PITCH_H - 24.0);
                break;
            }
            case DirectiveKind::ComeInside:
                p->homeY = lerp(baseHomeY[p->id], PITCH_H / 2.0, 0.40 * d.intensity);
                break;
            case DirectiveKind::StayCentral:
                p->homeY = lerp(baseHomeY[p->id], PITCH_H / 2.0, 0.65 * d.intensity);
                break;
            // On-ball passing biases the carrier reads when choosing a pass.
            case DirectiveKind::CrossEarly: directiveBias[p->id].crossEarly = true; break;
            case DirectiveKind::SwitchPlay: directiveBias[p->id].switchBias  = 0.20 * d.intensity; break;
            case DirectiveKind::PlaySimple: directiveBias[p->id].simplifyBias = 0.20 * d.intensity; break;
            // "pull it back" — favour the cutback to an arriving runner over a cross.
            case DirectiveKind::Cutback:    directiveBias[p->id].cutbackBias  = 0.30 * d.intensity; break;
            // Off-ball runs: bias the player toward run-in-behind candidates.
            case DirectiveKind::RunInBehind: directiveBias[p->id].runAheadBias = 0.30 * d.intensity; break;
            // come_short / check_to_feet: the INVERSE of run_in_behind — drop toward the carrier to receive to feet.
            case DirectiveKind::ComeShort:  directiveBias[p->id].comeShortBias = 0.55 * d.intensity; break;
            case DirectiveKind::CutInside:  directiveBias[p->id].cutInsideBias = d.intensity; break;   // wide carrier drives inside to shoot
            case DirectiveKind::OverlapRun: directiveBias[p->id].overlapBias = 0.30 * d.intensity; break;   // FB bombs forward on the overlap
            // drift_into_pocket: position between the opp def + mid lines to receive facing forward (dedicated Pocket candidate).
            case DirectiveKind::DriftIntoPocket: directiveBias[p->id].pocketBias = 0.50 * d.intensity; break;
            // target_man_holdup: a CF drops short to RECEIVE (reuse the shipped come_short half) AND, once on the
            // ball under pressure with no support arrived, HOLDS UP — shields/retains over a forced release.
            case DirectiveKind::TargetManHoldup:
                directiveBias[p->id].comeShortBias = 0.55 * d.intensity;   // the receive half (reuse come_short candidate + boost)
                directiveBias[p->id].holdUpBias    = 0.30 * d.intensity;   // the carry half (read in resolveChoice's shield gate)
                break;
            // "ball-playing CB": step out of defence and carry/progress the ball. Enables the
            // open-lane carry (agent_shoot_dribble), softens the own-half carry suppression
            // (role_ai CBPlayerAI), and rewards a line-breaking distribution (agent_pass_helpers).
            case DirectiveKind::BallPlaying: directiveBias[p->id].ballPlaying = true; break;
            case DirectiveKind::MakeRuns:    directiveBias[p->id].runAheadBias = 0.16 * d.intensity; break;
            case DirectiveKind::DribbleMore: directiveBias[p->id].dribbleBonus = 0.22 * d.intensity; break;
            // "stay back" — hold shape, don't bomb forward into the attack (damps the
            // dynamic overlap/advance push, distinct from sit_deep's static anchor).
            case DirectiveKind::StayBack:    directiveBias[p->id].stayBackBias = d.intensity; break;
            // Defensive intensity (read in the press assignment / tackle resolution).
            case DirectiveKind::PressHard:   directiveBias[p->id].pressTightness   = d.intensity; break;
            case DirectiveKind::TackleHard:  directiveBias[p->id].tackleAggression = d.intensity; break;
            case DirectiveKind::StayOnFeet:  directiveBias[p->id].stayOnFeet       = d.intensity; break;
            // "contain him" — sit off in the press (jockey) instead of engaging tight.
            case DirectiveKind::Contain:     directiveBias[p->id].containBias      = d.intensity; break;
            default: break;   // team-scoped kinds handled above
        }
    }
}

void GameEngine::updateTeamAssignments() {
    Player* carrier = playerById(state.ball.controllerId);
    if (!carrier || carrier->role == Role::GK) {
        // Pass in flight: defend the ARRIVAL, not the memory of the launch.
        // Anchoring on the intended receiver collapses markers and the press
        // onto the reception point while the ball travels — without this the
        // defense executed stale assignments for the whole flight of every
        // cross and through ball. Otherwise keep the previous shape while
        // the ball is loose (clearing it let the back line float).
        Player* receiver = playerById(state.ball.intendedReceiverId);
        if (receiver && receiver->role != Role::GK && state.ball.controllerId < 0) {
            assignmentByPlayer.fill({});
            Team defending = receiver->team == Team::Home ? Team::Away : Team::Home;
            assignDefensiveRoles(defending, *receiver);
        }
        return;
    }
    assignmentByPlayer.fill({});
    Team defending = carrier->team == Team::Home ? Team::Away : Team::Home;
    assignDefensiveRoles(defending, *carrier);
    assignAttackingRoles(carrier->team, *carrier);
    auditTacticalCoverage(*carrier);
}

// Designate the in-possession team's off-ball runners. Without this the
// attacking half of assignmentByPlayer was always empty, so every assignment-
// gated attacking branch (through-ball releasedRunner, Overlap/InsideRun pass
// bonuses, the RunAhead/InsideRun/Overlap run-target overrides) was dormant —
// runners drifted to safe width and the box stayed empty (~0.1 attackers in
// the box on final-third carries). Pure geometry + clock, NO rng.
void GameEngine::assignAttackingRoles(Team team, Player& carrier) {
    double fd = fdFor(team);
    double oppGoalX = goalXFor(team);                       // the goal we attack
    double carrierGoalDist = std::abs(carrier.x - oppGoalX);
    // Only commit runners when genuinely attacking (carrier past own 45%) or in
    // the quick-transition window — never over-commit from our own half.
    if (!(carrierGoalDist < PITCH_W * 0.55 || state.clockMs < transitionUntilMs)) return;

    double cy = PITCH_H / 2.0;
    double line = offsideLineFor(team);                     // offside shoulder x
    double ballAdvance = clamp((PITCH_W - carrierGoalDist) / PITCH_W, 0.0, 1.0);
    bool carrierWide = std::abs(carrier.y - cy) > 140.0;
    double ballSide = carrier.y >= cy ? 1.0 : -1.0;         // vertical half the ball is in

    // 1) RunAhead — the most advanced CF sits on the shoulder, ball-side, poised
    //    to run in behind (feeds the through-ball releasedRunner path).
    Player* runAhead = nullptr; double bestAdv = -1e9;
    for (auto& p : state.players) {
        if (p.team != team || p.id == carrier.id || p.role != Role::CF) continue;
        double adv = p.x * fd;
        if (adv > bestAdv) { bestAdv = adv; runAhead = &p; }
    }
    if (runAhead) {
        double tx = (fd > 0.0 ? std::max(line, carrier.x) : std::min(line, carrier.x)) - fd * 5.0;
        double ty = clamp(cy + ballSide * 60.0, 60.0, PITCH_H - 60.0);
        setAssignment(*runAhead, DefensiveTask::RunAhead, tx, ty, -1);
    }

    // 2) InsideRun — the weak-side WM attacks the far post.
    Player* insideRun = nullptr; double farY = -1.0;
    for (auto& p : state.players) {
        if (p.team != team || p.id == carrier.id || p.role != Role::WM) continue;
        if (runAhead && p.id == runAhead->id) continue;
        double dy = std::abs(p.homeY - carrier.y);
        if (dy > farY) { farY = dy; insideRun = &p; }
    }
    if (insideRun) {
        double farPostY = clamp(cy - ballSide * 55.0, 55.0, PITCH_H - 55.0);
        setAssignment(*insideRun, DefensiveTask::InsideRun, oppGoalX - fd * 70.0, farPostY, -1);
    }

    // 3) Overlap + cutback CM — normally only on a wide, advanced carry (the
    //    over-commit guard). all_out_attack relaxes it: throw the FB + a CM
    //    forward on central carries and a touch earlier too.
    bool allOut = teamTactics[teamIndex(team)].allOutActive;
    // USER FEEDBACK #1 ("lack of overlapping runs"): the FB only bombed forward on a
    // WIDE + advanced (>0.40) carry, so overlaps were rare (audit: FB ~1.8% attacking-
    // third). Trigger earlier (>0.32) AND on the classic case — the ball-side WINGER
    // carrying wide, where his FB overlaps OUTSIDE him — so the run is frequent and
    // visible. More committed fullbacks = more wide overhang; a deliberate, user-
    // sanctioned attacking risk ("bumping goals a bit is fine, we can improve defending").
    bool wingerCarryWide = carrier.role == Role::WM && carrierWide && ballAdvance > 0.28;
    if ((ballAdvance > 0.32 && carrierWide) || wingerCarryWide || (allOut && ballAdvance > 0.30)) {
        Player* fbOver = nullptr; double bestFb = -1e9;
        for (auto& p : state.players) {
            if (p.team != team || p.id == carrier.id || p.role != Role::FB) continue;
            if ((p.homeY >= cy) != (carrier.y >= cy)) continue;   // ball-side FB only
            double adv = p.x * fd;
            if (adv > bestFb) { bestFb = adv; fbOver = &p; }
        }
        if (fbOver) {
            // hug the touchline and get goal-side: a clear bombing run to the wide
            // byline beyond the winger (cross/cutback end-point), not a half-hearted edge.
            double ty = clamp(cy + ballSide * 225.0, 32.0, PITCH_H - 32.0);
            setAssignment(*fbOver, DefensiveTask::Overlap, oppGoalX - fd * 95.0, ty, -1);
        }
        Player* cmCut = nullptr; double bestCm = -1e9;
        for (auto& p : state.players) {
            if (p.team != team || p.id == carrier.id || p.role != Role::CM) continue;
            double adv = p.x * fd;
            if (adv > bestCm) { bestCm = adv; cmCut = &p; }
        }
        if (cmCut) setAssignment(*cmCut, DefensiveTask::AdvanceMidfield, oppGoalX - fd * 135.0, cy, -1);
    }
}

void GameEngine::auditCredibleShotWindow(const Player& player, double distance, double angleDeg,
                                                int pressureCount, const std::string& choiceType) {
    if (player.role != Role::CF || distance >= 190.0 || angleDeg <= 9.0 || pressureCount > 1) return;
    bool closeChance = distance < 120.0;
    stats.recordShotSelection(0, 0, 1, choiceType == "shoot" ? 0 : 1, choiceType == "pass" ? 1 : 0, choiceType == "dribble" ? 1 : 0, closeChance ? 1 : 0, closeChance && choiceType != "shoot" ? 1 : 0, false, false);
}

void GameEngine::assignDefensiveRoles(Team team, Player& carrier) {
    double fd = fdFor(team);
    double ownGoalX = ownGoalXFor(team);
    bool danger = pitch::inDangerZone(carrier.x, team);
    Config tactics = configFor(team);

    // Phase 1: Rank defenders
    auto ranked = rankDefenders(team, carrier);
    if (ranked.empty()) return;

    // Build context — anchor on whichever is nearer our goal, carrier or ball,
    // so a ball played in behind pulls the line back even before it's collected.
    double carrierGoalDist = std::min(std::abs(carrier.x - ownGoalX), std::abs(state.ball.x - ownGoalX));
    danger = danger || carrierGoalDist < DANGER_ZONE_DIST;
    bool shootingRange = carrierGoalDist < 310.0 && pitch::lateralFromCenter(carrier.y) < 235.0;
    bool wideDanger = carrierGoalDist < 360.0 && pitch::lateralFromCenter(carrier.y) > 135.0;
    // DEFENSIVE-SHAPE REDESIGN (docs/DEFENSIVE_SHAPE_REDESIGN.md): a MID-BLOCK. While
    // the carrier builds up in his OWN half (far from our goal) we HOLD SHAPE — only
    // the primary container engages; the second presser / lanes / cover / screen /
    // close-down hold zonal positions — AND this team's forwards drop (agent_
    // positioning reads defenseHoldingShape) to EMPTY the opponent's build-up zone so
    // he can string passes. Goals will spike; the target is build-up, not goals.
    bool highPress = tactics.defensiveLineHeight > 62.0 || tactics.aggression > 66.0;
    bool holdShape = carrierGoalDist > PITCH_W * 0.52 && !danger && !highPress;
    {
        int tIdx = teamIndex(team);
        teamTactics[tIdx].defenseHoldingShape = holdShape;
        teamTactics[1 - tIdx].defenseHoldingShape = false;   // the side in possession isn't holding shape
    }
    // defensiveLineHeight: high line steps right up (compresses space, presses
    // higher, leaves room behind); deep line sits in. Strengthened from 0.9 so
    // the dial is actually felt — a high vs deep block is now ~190px apart.
    double linePush = (tactics.defensiveLineHeight - 50.0) * 1.9;
    // offside_trap: hold the raised line in the danger zone instead of the 92px
    // safety drop — the high line (driven by the +45 dial above) springs late
    // runners offside. The deepest-runner clamp below still keeps it goal-side of
    // the most advanced attacker, so it traps mistimed runs, not every ball.
    bool holdLine = teamTactics[teamIndex(team)].offsideTrapActive;
    double lineProgress = (danger && !holdLine)
        ? 92.0
        : ((lerp(team == Team::Home ? 245.0 : PITCH_W - 245.0, carrier.x - fd * 108.0, 0.38) - ownGoalX) * fd) + linePush;
    // Retreat with an advancing carrier: a fixed ~245px line left the box empty
    // behind it, and `danger` (carrier < 240) only triggered once that line was
    // already beaten. Stay ~115px goal-side until reaching box depth.
    if (!danger) lineProgress = std::min(lineProgress, carrierGoalDist - 230.0);
    // Track the deepest runner: a line that ignores attackers behind it hands
    // every through ball a free lane. Stay a stride goal-side of the most
    // advanced opponent (which also keeps him onside-marked, not played on).
    double deepestRunner = 1e9;
    for (auto& p : state.players) {
        // Skip sent-off players: they're parked off-pitch (y=-40) at their homeX,
        // so an ejected opponent could still be picked as the "deepest runner" and
        // drag the back line to mark a phantom. Every other geometry loop (offside
        // line, GK cover, cynical-foul cover) already excludes sentOff — match it.
        if (p.team == team || p.role == Role::GK || p.sentOff || p.id == carrier.id) continue;
        deepestRunner = std::min(deepestRunner, std::abs(p.x - ownGoalX));
    }
    // Normally the line stays a stride goal-side of the deepest runner (keeps him
    // onside-marked). offside_trap deliberately SKIPS this so the raised line can
    // step PAST a loitering attacker and spring him offside — the gamble.
    if (deepestRunner < 1e9 && !holdLine) lineProgress = std::min(lineProgress, std::max(70.0, deepestRunner - 26.0));
    lineProgress = clamp(lineProgress, 70.0, 360.0);

    DefenseContext ctx{team, fd, ownGoalX, danger, tactics, lineProgress, shootingRange, wideDanger,
                       carrierGoalDist, {}, std::move(ranked), {}};

    // Sent-off defenders are parked off-pitch — pre-mark them assigned so every
    // phase below (press / lanes / cover / marking / box) skips them via ctx.used().
    for (auto& p : state.players)
        if (p.team == team && p.sentOff) ctx.assigned[p.id] = true;

    // Phase 2-3: Press
    assignPrimaryPress(ctx, carrier);
    // Mid-block: holding shape, only the primary container engages — the rest hold
    // their zonal positions (no assignment => default positioning) so the opponent's
    // build-up lanes aren't pre-occupied.
    if (!holdShape) {
        assignSecondaryPress(ctx, carrier);

        // Phase 4-5: Lane blockers
        assignShotLane(ctx, carrier);
        assignCrossLane(ctx, carrier);

        // Phase 6-7: Cover & screen
        assignCoverRoles(ctx, carrier);
        assignMidfieldScreen(ctx, carrier);

        // Phase 8: Close-down
        assignCloseDown(ctx, carrier);
    } else if (state.clockMs < transitionUntilMs) {
        // G3 COUNTER-PRESS (1-2-man gegenpress, SysArch directive). In the ~400ms after
        // we LOST the ball (transition window), send the SECOND hunter at the new carrier
        // to win it back immediately — but keep everyone else HOLDING SHAPE (no lane /
        // cover / screen / close-down push-up). That is the difference from the failed
        // full-press attempt that set highPress and re-crowded: this adds exactly ONE
        // extra man, and the G1 converger cap bounds the pile at 2. A brief, focused hunt.
        assignSecondaryPress(ctx, carrier);
    }

    // Phase 9-10: Threat identification & marking
    ctx.threats = identifyThreats(ctx, carrier);
    assignThreatMarking(ctx, carrier);

    // Phase 11: Box protection
    assignBoxProtection(ctx, carrier);

    // Phase 11b: wingers track back when the goal is under threat — a low
    // block defends with more than the back four plus screens. They take
    // the wide channels at box height, the lanes cutbacks travel through.
    if (ctx.danger) {
        for (auto& p : state.players) {
            if (p.team != ctx.team || ctx.used(&p) || p.role != Role::WM) continue;
            double sideY = p.homeY < PITCH_H / 2.0 ? PITCH_H * 0.26 : PITCH_H * 0.74;
            setAssignment(p, DefensiveTask::BoxScreen, ctx.ownGoalX + ctx.fd * 150.0, sideY);
            ctx.assigned[p.id] = true;
        }
    }

    // Phase 12: Defensive line
    assignDefensiveLine(ctx, carrier);
}

void GameEngine::auditTacticalCoverage(Player& carrier) {
    if (state.clockMs < nextTacticalAuditMs) return;
    nextTacticalAuditMs = state.clockMs + 500.0;
    Team defending = carrier.team == Team::Home ? Team::Away : Team::Home;
    bool danger = pitch::inDangerZone(carrier.x, defending);
    Player* primary = nullptr;
    for (int id = 0; id < 22; id++) {
        if (assignmentByPlayer[id].role == DefensiveTask::PrimaryPress) { primary = playerById(id); break; }
    }
    if (primary) {
        double selectedDistance = dist(primary->x, primary->y, carrier.x, carrier.y);
        stats.recordPressSample(selectedDistance);
        double selectedEta = selectedDistance / std::max(18.0, attrFactor(primary->attrs.speed) * SPEED_SPRINT);
        double fastestEta = 1e9;
        for (auto& p : state.players) {
            if (p.team != defending || p.role == Role::GK) continue;
            double eta = dist(p.x, p.y, carrier.x, carrier.y) / std::max(18.0, attrFactor(p.attrs.speed) * SPEED_SPRINT);
            fastestEta = std::min(fastestEta, eta);
        }
        if (selectedEta > fastestEta + 0.45) { stats.recordQuestionablePress(); }
    }
    struct LineMember { const Player* player; double progress; };
    SmallVector<LineMember, 6> line;
    for (const auto& defender : state.players) {
        if (defender.team != defending) continue;
        if (!agentFor(defender)->isCenterBack() && !agentFor(defender)->isFullBack()) continue;
        line.push_back({&defender, pitch::forwardProgress(defender.x, defending)});
    }
    if (line.size() >= 3) {
        std::sort(line.begin(), line.end(), [](const LineMember& a, const LineMember& b) { return a.progress < b.progress; });
        double gap = line[1].progress - line[0].progress;
        bool singleDrop = false, laneBlock = false;
        if (!danger && gap > 85.0) {
            singleDrop = true;
            const auto* task = assignmentFor(line[0].player->id);
            if (task && task->role == DefensiveTask::LaneBlock) { laneBlock = true; }
        }
        stats.recordBackLineSample(gap, singleDrop, laneBlock);
    }
    bool finalThird = pitch::inFinalThird(carrier.x, carrier.team);
    if (!finalThird) return;
    double nearestCb = 1e9, nearestDefender = 1e9;
    for (auto& defender : state.players) {
        if (defender.team != defending || defender.role == Role::GK) continue;
        double distance = dist(defender.x, defender.y, carrier.x, carrier.y);
        nearestDefender = std::min(nearestDefender, distance);
        if (agentFor(defender)->isCenterBack()) nearestCb = std::min(nearestCb, distance);
    }
    bool unmarked = nearestDefender > 55.0 && nearestCb > 90.0;
    stats.recordFinalThirdMarking(nearestCb, nearestDefender, unmarked);
}

