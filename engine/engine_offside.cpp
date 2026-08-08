// engine_offside.cpp — Law 11, and the two lines drawn across the pitch
//
// Split out of engine_setpiece.cpp, where it had been sitting above the restart
// code because offside's punishment happens to be a free kick. It is not a set
// piece: nothing here is armed, walked to or taken. It is a judgement made every
// time a pass is considered or played, and the rest of the AI reads it hundreds
// of times a tick through isOffsideTargetPerceived.
//
// The pair that matters is checkOffside (the linesman: exact, OFFSIDE_TOLERANCE)
// and isOffsideTargetPerceived (the passer: no flag, an 18px margin, so mistimed
// runs actually get caught) — they are deliberately DIFFERENT and must be edited
// as a pair; making them agree is what produced zero offsides in six hours.
// midlineFor is here because it is offsideLineFor's mirror image: the same skip-t
// scan of the opponent's shape, drawing the other edge of the pocket.

#include "engine.h"
#include "agent.h"
#include <cmath>

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
    // Round-30 tripwire: this function RELOCATES the ball to the flagged
    // player's feet, and it arms the set piece in the same tick — which is
    // exactly what `!setPiece.armed` suppresses at the ball_teleport check, so a
    // flag raised before the ball ever arrived could (and did) fling it 265px in
    // one frame with nothing recording it. Measure the jump BEFORE overwriting
    // the position. A correctly-timed call moves the ball ~13-25px (the receiver
    // is already on it); anything past 40px means the ball had not arrived.
    if (dist(b.x, b.y, offsidePlayer.x, offsidePlayer.y) > 40.0)
        stats.recordQualityFlag(QualityFlag::OffsideBallRelocation);
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
    setPiece.runUpActive = false;   // planned fresh when the taker reaches the ball
    Player* best = findNearestOutfieldPlayer(defTeam, b.x, b.y);
    setPiece.takerId = best ? best->id : -1;
    // Restart marker for the replay feed — free kicks were the ONE restart that
    // emitted no event (corner/throw/goal_kick all do), so the feed and any
    // trace probe couldn't see them. Team derives from the taker's id.
    if (setPiece.takerId >= 0)
        emitEvent("free_kick", setPiece.spotX, setPiece.spotY, setPiece.takerId, -1, true);
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
