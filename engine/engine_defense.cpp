#include "engine.h"
#include "agent.h"
#include <cmath>
#include <numbers>
#include <iostream>   // §1.3b: [live] inject-applied logging in applyLiveCommands

// ══════════════════════════════════════════════════════════════
// Tactical — assignments, defensive roles, tactical audit
// ══════════════════════════════════════════════════════════════

void GameEngine::setAssignment(Player& player, DefensiveTask role, double x, double y, int opponentId) {
    assignmentByPlayer[player.id] = {role, opponentId, clamp(x, 35.0, PITCH_W - 35.0), clamp(y, 35.0, PITCH_H - 35.0)};
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
    longBallBias = {};      // reset play_it_long pass-scorer hook each tick
    slowTempo = {};         // reset slow_it_down safe-pass hook each tick
    counterAttackBonus = {};   // reset counter_attack transition amplifier each tick
    offsideTrapActive = {};    // reset offside_trap line-hold flag each tick
    allOutActive = {};         // reset all_out_attack runner-commit flag each tick
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
        // ── Team-wide dial command: nudge this team's 5 dials. Added on top of
        // the base config in configFor() and clamped, so the whole side shifts
        // shape (press height, line, width, tempo) coherently. ──
        if (d.teamScope >= 0) {
            ConfigDelta& dv = dialOverride[d.teamScope];
            double k = d.intensity;
            switch (d.kind) {
                case DirectiveKind::AllOutAttack:   dv.aggression+=30*k; dv.defensiveLineHeight+=25*k; dv.overlapFrequency+=25*k; dv.midfieldFreedom+=20*k; allOutActive[d.teamScope]=true; break;
                case DirectiveKind::ParkTheBus:     dv.aggression-=28*k; dv.defensiveLineHeight-=32*k; dv.overlapFrequency-=25*k; dv.midfieldFreedom-=15*k; break;
                case DirectiveKind::HighPress:      dv.aggression+=35*k; dv.defensiveLineHeight+=22*k; dv.midfieldFreedom+=6*k;  break;
                case DirectiveKind::DropOff:        dv.aggression-=32*k; dv.defensiveLineHeight-=40*k; break;
                case DirectiveKind::PlayItLong:     dv.passingDirectness+=58*k; dv.midfieldFreedom-=14*k; dv.overlapFrequency-=5*k; longBallBias[d.teamScope]+=k; break;
                case DirectiveKind::CounterAttack:  counterAttackBonus[d.teamScope]+=k; break;
                case DirectiveKind::KeepItOnGround: dv.passingDirectness-=30*k; dv.midfieldFreedom+=10*k; break;
                case DirectiveKind::GetItWide:
                    // overlapFrequency only pushes FBs FORWARD (widthPush adds to homeX),
                    // so "get it wide" must actually widen the wide players' lateral anchor.
                    dv.overlapFrequency+=20*k;
                    for (auto& wp2 : state.players)
                        if ((wp2.team == Team::Home) == (d.teamScope == 0) && (wp2.role == Role::WM || wp2.role == Role::FB)) {
                            double sgn = baseHomeY[wp2.id] < PITCH_H / 2.0 ? -1.0 : 1.0;
                            wp2.homeY = clamp(baseHomeY[wp2.id] + sgn * 75.0 * k, 24.0, PITCH_H - 24.0);
                        }
                    break;
                case DirectiveKind::PlayNarrow:
                    dv.overlapFrequency-=20*k; dv.midfieldFreedom+=15*k;
                    for (auto& wp2 : state.players)
                        if ((wp2.team == Team::Home) == (d.teamScope == 0) && (wp2.role == Role::WM || wp2.role == Role::FB))
                            wp2.homeY = lerp(baseHomeY[wp2.id], PITCH_H / 2.0, 0.35 * k);
                    break;
                case DirectiveKind::PushUp:         dv.defensiveLineHeight+=30*k; dv.aggression+=10*k; break;
                case DirectiveKind::OffsideTrap:    dv.defensiveLineHeight+=45*k; dv.aggression+=15*k; offsideTrapActive[d.teamScope]=true; break;
                case DirectiveKind::SlowItDown:     dv.passingDirectness-=34*k; dv.aggression-=22*k; dv.overlapFrequency-=12*k; slowTempo[d.teamScope]+=k; break;
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
    bool allOut = allOutActive[team == Team::Home ? 0 : 1];
    if ((ballAdvance > 0.40 && carrierWide) || (allOut && ballAdvance > 0.30)) {
        Player* fbOver = nullptr; double bestFb = -1e9;
        for (auto& p : state.players) {
            if (p.team != team || p.id == carrier.id || p.role != Role::FB) continue;
            if ((p.homeY >= cy) != (carrier.y >= cy)) continue;   // ball-side FB only
            double adv = p.x * fd;
            if (adv > bestFb) { bestFb = adv; fbOver = &p; }
        }
        if (fbOver) {
            double ty = clamp(cy + ballSide * 200.0, 40.0, PITCH_H - 40.0);
            setAssignment(*fbOver, DefensiveTask::Overlap, oppGoalX - fd * 110.0, ty, -1);
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
    bool danger = std::abs(carrier.x - ownGoalX) < DANGER_ZONE_DIST;
    Config tactics = configFor(team);

    // Phase 1: Rank defenders
    auto ranked = rankDefenders(team, carrier);
    if (ranked.empty()) return;

    // Build context — anchor on whichever is nearer our goal, carrier or ball,
    // so a ball played in behind pulls the line back even before it's collected.
    double carrierGoalDist = std::min(std::abs(carrier.x - ownGoalX), std::abs(state.ball.x - ownGoalX));
    danger = danger || carrierGoalDist < DANGER_ZONE_DIST;
    bool shootingRange = carrierGoalDist < 310.0 && std::abs(carrier.y - PITCH_H / 2.0) < 235.0;
    bool wideDanger = carrierGoalDist < 360.0 && std::abs(carrier.y - PITCH_H / 2.0) > 135.0;
    // DEFENSIVE-SHAPE REDESIGN (docs/DEFENSIVE_SHAPE_REDESIGN.md): a MID-BLOCK. While
    // the carrier builds up in his OWN half (far from our goal) we HOLD SHAPE — only
    // the primary container engages; the second presser / lanes / cover / screen /
    // close-down hold zonal positions — AND this team's forwards drop (agent_
    // positioning reads defenseHoldingShape) to EMPTY the opponent's build-up zone so
    // he can string passes. Goals will spike; the target is build-up, not goals.
    bool highPress = tactics.defensiveLineHeight > 62.0 || tactics.aggression > 66.0;
    bool holdShape = carrierGoalDist > PITCH_W * 0.52 && !danger && !highPress;
    {
        int tIdx = team == Team::Home ? 0 : 1;
        defenseHoldingShape[tIdx] = holdShape;
        defenseHoldingShape[1 - tIdx] = false;   // the side in possession isn't holding shape
    }
    // defensiveLineHeight: high line steps right up (compresses space, presses
    // higher, leaves room behind); deep line sits in. Strengthened from 0.9 so
    // the dial is actually felt — a high vs deep block is now ~190px apart.
    double linePush = (tactics.defensiveLineHeight - 50.0) * 1.9;
    // offside_trap: hold the raised line in the danger zone instead of the 92px
    // safety drop — the high line (driven by the +45 dial above) springs late
    // runners offside. The deepest-runner clamp below still keeps it goal-side of
    // the most advanced attacker, so it traps mistimed runs, not every ball.
    bool holdLine = offsideTrapActive[team == Team::Home ? 0 : 1];
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
        if (p.team == team || p.role == Role::GK || p.id == carrier.id) continue;
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
    double ownGoalX = ownGoalXFor(defending);
    double fd = fdFor(defending);
    bool danger = std::abs(carrier.x - ownGoalX) < DANGER_ZONE_DIST;
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
        line.push_back({&defender, (defender.x - ownGoalX) * fd});
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
    bool finalThird = carrier.team == Team::Home ? carrier.x > PITCH_W * 2.0 / 3.0 : carrier.x < PITCH_W / 3.0;
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

