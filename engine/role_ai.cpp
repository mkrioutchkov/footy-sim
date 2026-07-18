#include "engine.h"
#include "role_ai.h"
#include "agent_helpers.h"

bool PlayerAI::pressedTightOrClosing() const {
    for (auto& o : engine.state.players) {
        if (o.team == player.team || o.role == Role::GK || o.sentOff) continue;
        if (dist(o.x, o.y, player.x, player.y) < 34.0) return true;
    }
    // A tackler sprinting in counts before he arrives — a jockey holding his
    // standoff does not (closing speed, not proximity).
    return tackleArriving(engine.state.players, player.x, player.y, player.team, 100.0, 55.0);
}

// In-possession last man (seed 264 1:09): the carrier has NO own outfield
// teammate goal-side of him (between him and his own goal). Mirrors the
// goalSideCover scan the defensive cynical-foul detector runs over the OTHER
// team — here it is inverted onto the carrier's own team. The keeper never
// counts (a GK behind is not outfield cover); an outfield man goal-side, at
// any width, means he is not the last man.
bool PlayerAI::carrierIsLastMan() const {
    double fd = fdFor(player.team);
    for (auto& d : engine.state.players) {
        if (d.team != player.team || d.id == player.id || d.role == Role::GK || d.sentOff) continue;
        if ((d.x - player.x) * fd < 0.0) return false;   // teammate goal-side => not last man
    }
    return true;
}

// The forensic case (seed 264 1:09) is a last man DEEP and genuinely CORNERED —
// not any deep CB calmly playing out. That common case ("deep defender, someone
// closing") is exactly the permanent-valve trap the round-18 note warns about:
// pricing it floods clearances and erodes completion. So require BOTH a tight
// opponent already inside 38px AND a genuine arriving tackle (sprinting in) on
// top of last-man + deep. "Tight AND arriving" (not "tight OR closing") is the
// difference between a cornered carrier and a jockeyed one, and keeps this rare
// enough to leave aggregate completion untouched.
bool PlayerAI::carrierLastManTrapped() const {
    if (!carrierIsLastMan()) return false;
    if (pitch::forwardProgress(player.x, player.team) >= PITCH_W * 0.42) return false;
    bool tight = false;
    for (auto& o : engine.state.players) {
        if (o.team == player.team || o.role == Role::GK || o.sentOff) continue;
        if (dist(o.x, o.y, player.x, player.y) < 38.0) { tight = true; break; }
    }
    return tight
        && tackleArriving(engine.state.players, player.x, player.y, player.team, 90.0, 45.0);
}

void CFPlayerAI::adjustActionScores(SmallVector<Action, 24>& actions, bool isController) {
    PlayerAI::adjustActionScores(actions, isController);
    if (!isController) return;
    for (auto& a : actions) {
        if (a.type == ActionType::Shoot) a.score += 0.18;
    }
}

void WMPlayerAI::adjustActionScores(SmallVector<Action, 24>& actions, bool isController) {
    PlayerAI::adjustActionScores(actions, isController);
    if (!isController) return;
    for (auto& a : actions) {
        if (a.type == ActionType::Dribble && a.score > 0.25) a.score += 0.05;
    }
    for (auto& a : actions) {
        if (a.type == ActionType::Dribble) a.score += 0.12;
        if (a.type == ActionType::Pass)   a.score += 0.04;
    }
}

void CMPlayerAI::adjustActionScores(SmallVector<Action, 24>& actions, bool isController) {
    PlayerAI::adjustActionScores(actions, isController);
    if (!isController) return;
    Action* bestDribble = nullptr;
    for (auto& a : actions) {
        if (a.type == ActionType::Dribble) {
            if (!bestDribble || a.score > bestDribble->score) bestDribble = &a;
        }
    }
    if (bestDribble && bestDribble->score > 0.25) bestDribble->score += 0.04;
    for (auto& a : actions) {
        if (a.type == ActionType::Dribble) a.score += 0.04;
        if (a.type == ActionType::Pass)   a.score += 0.04;
    }
}

void CBPlayerAI::adjustActionScores(SmallVector<Action, 24>& actions, bool isController) {
    PlayerAI::adjustActionScores(actions, isController);
    for (auto& a : actions) {
        if (a.type == ActionType::Tackle) a.score += 0.05;
    }
    // A centre-back never invites the duel (watched replay 1:22: a CB carried
    // ACROSS the presser at touching distance near the centre circle, showing
    // him the ball). Pressed tight in his own half, he releases NOW — carrying
    // is off the menu, the quick ball out is on. Triggers on projected arrival
    // too: static 34px opens the valve only in the final 0.3s of a sprint-in.
    // A ball-playing CB (directive) is trusted to carry out of the back: soften the
    // pressed-tight carry suppression so he steps past the first presser instead of
    // always releasing. Still damped (a tight press is a bad time to dwell), just
    // less so. Unflagged CBs keep the full -0.22 valve (byte-identical default).
    if (isController && pitch::inOwnHalf(player.x, player.team)) {
        if (pressedTightOrClosing()) {
            double dribblePenalty = engine.directiveBias[player.id].ballPlaying ? -0.08 : -0.22;
            for (auto& a : actions) {
                if (a.type == ActionType::Dribble) a.score += dribblePenalty;
                if (a.type == ActionType::Pass)    a.score += 0.05;
            }
        }
    }
}

void FBPlayerAI::adjustActionScores(SmallVector<Action, 24>& actions, bool isController) {
    PlayerAI::adjustActionScores(actions, isController);
    // Full-backs get the same quick-release valve as CBs — the watched 0:40
    // (seed 129) caught-in-possession was an FB with no equivalent: he chose
    // escape-dribbles into his own corner while the presser arrived.
    if (isController && pitch::inOwnHalf(player.x, player.team)) {
        if (pressedTightOrClosing()) {
            for (auto& a : actions) {
                if (a.type == ActionType::Dribble) a.score -= 0.22;
                if (a.type == ActionType::Pass)    a.score += 0.05;
            }
        }
    }
}
