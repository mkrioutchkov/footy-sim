// agent.hpp — PlayerAgent for footy-sim C++ engine
//
// Include strategy (engine.hpp):
//   1. #include "agent.hpp"          — gets PlayerAgent class declaration
//   2. class GameEngine { ... };     — full engine definition
//   3. #define AGENT_HPP_IMPL
//   4. #include "agent.hpp"          — gets method implementations
//   5. #undef AGENT_HPP_IMPL
//
// The agent stores GameEngine& and calls engine methods freely.
// All engine callbacks needed are listed in comments below.

#ifndef AGENT_HPP_DECL
#define AGENT_HPP_DECL

#include "types.hpp"
#include "constants.hpp"
#include "rng.hpp"
#include <vector>
#include <string>
#include <algorithm>
#include <cmath>
#include <optional>

// ── Forward declare GameEngine ────────────────────────────────────────────────
class GameEngine;

// ── Former chase collection envelope (counts now-rejected stale steals) ──────
inline constexpr double PRE_CONTACT_CHASE_REACH = 36.4;

// ══════════════════════════════════════════════════════════════════════════════
// Agent-internal types (mirror TS interfaces from agent.ts)
// ══════════════════════════════════════════════════════════════════════════════

struct ActionAudit {
    double distance         = 0;
    double forwardProgress  = 0;
    double expectedCompletion = 0;
    int    blockers         = 0;
    int    receiverPressure = 0;
    double angleDeg         = 0;
    int    pressureCount    = 0;
};

struct Action {
    std::string type;
    double      score   = 0;
    Player*     target  = nullptr;
    double      posX    = 0;
    double      posY    = 0;
    std::string purpose;
    ActionAudit audit;
};

struct GameContext {
    int    scoreDiff = 0;
    double timeLeft  = 0;
    int    half      = 1;
    double urgency   = 0;
};

struct Perception {
    double              ballDist      = 0;
    bool                ballIsLoose   = false;
    std::string         ballControllerTeam;   // empty = null
    int                 ballControllerId = -1;
    std::vector<Player*> nearbyTeammates;
    std::vector<Player*> nearbyOpponents;
    double              nearestOpponentDist = 1e9;
    bool                iAmController    = false;
    bool                amClosestToBall  = false;
    int                 chasingTeammatesCount = 0;
    bool                anyOpponentCloserToBall = false;
    int                 pressureCount    = 0;
    int                 intendedId       = -1;
};

struct PassSelectionAudit {
    double score              = 0;
    double distance           = 0;
    double forwardProgress    = 0;
    double expectedCompletion = 0;
    int    blockers           = 0;
    int    receiverPressure   = 0;
    std::string purpose;
    int    saferOptionTargetId   = -1;
    double saferOptionScore      = 0;
    double saferOptionCompletion = 0;
    double saferOptionProgress   = 0;
};

struct ShotSelectionAudit {
    double score          = 0;
    double distance       = 0;
    double angleDeg       = 0;
    int    pressureCount  = 0;
    int    bestPassTargetId   = -1;
    double bestPassScore      = 0;
    double bestPassCompletion = 0;
};

// Minimal types the agent reads from engine — defined here so agent.hpp
// is self-contained.  If you add richer versions to types.hpp later,
// remove these and adjust field names.

struct AgentManagerConfig {
    double aggression        = 50.0;
    double passingDirectness = 50.0;
};

struct AgentTeamAssignment {
    std::string role;          // TeamAssignmentRole as string
    double targetX = 0;
    double targetY = 0;
    int    opponentId = -1;
};

struct AgentCommitRun {
    double targetX = 0;
    double targetY = 0;
};

struct AgentRecentPass {
    double bx = 0, by = 0;    // origin
    double vx = 0, vy = 0;    // velocity
    std::string team;
    double clockMs = 0;
};

// ══════════════════════════════════════════════════════════════════════════════
// PlayerAgent class
// ══════════════════════════════════════════════════════════════════════════════

class PlayerAgent {
public:
    Player&     player;
    GameEngine& engine;

    // ── constructor ──
    PlayerAgent(Player& p, GameEngine& e)
        : player(p), engine(e)
    {
        facing = (player.team == "home") ? 0.0 : 3.141592653589793;
    }

    // ── public tick ──
    void tick(double sdt);
    double dizzyRotationAccum = 0;
    double dizzyWindowStartMs = 0;

private:
    // ---- cooldowns / state ----
    int    sl = 0;           // shot-lock
    int    sc = 0;           // shot cooldown
    int    pa = 0;           // perception age
    std::optional<Perception> ch;   // cached perception

    int    ht = 0;           // hold-time (frames as ball carrier)
    double lx = 0, ly = 0;   // last position

    std::string la;          // last action type
    std::string lastPurpose;
    int    lt = -1;          // last target id
    int    lp = -1;          // last pass target id (for pass-pair memory)

    double facing = 0;

    int    recentPassTarget = -1;
    double recentPassTime   = 0;

    // ball memory (for out-of-vision tracking)
    double ballMemX   = 0;
    double ballMemY   = 0;
    int    ballMemAge = 0;

    // ---- helper methods (signatures only; bodies follow in AGENT_HPP_IMPL) ----
    GameContext           ctx();
    std::vector<Action>   ev(const Perception& per, bool ic, const GameContext& ctx);
    std::vector<Action>   cp(const Perception& per, const GameContext& ctx);
    Action                cs(const Perception& per, const GameContext& ctx);
    Action                cd(const Perception& per, const GameContext& ctx);
    Action                ct(const Perception& per, const GameContext& ctx);
    Action                cm(const Perception& per, const GameContext& ctx);
    Action                cc(const Perception& per);
    std::vector<Action>   bp(const Perception& per, const GameContext& ctx);
    Action                rc(std::vector<Action>& a);
    void                  ex(Action& a, double sdt, std::vector<Action>& actions);
    Perception            gp();
    Perception            pr();
    void                  am(double sdt);
    void                  tryCollectAfterChase();
    void                  auditDefensiveMovement(const Action& choice);
    PassSelectionAudit    passSelectionAudit(const Action& choice, const std::vector<Action>& actions);
    ShotSelectionAudit    shotSelectionAudit(const Action& choice, const std::vector<Action>& actions);
};

#endif // AGENT_HPP_DECL

// ══════════════════════════════════════════════════════════════════════════════
// Method implementations  (compiled only after GameEngine is fully defined)
// ══════════════════════════════════════════════════════════════════════════════
#ifdef AGENT_HPP_IMPL

#include <limits>
#include <numeric>

// ── forward-declare engine methods used by agent (actual signatures in engine.hpp) ──
// The agent calls these; they must be public on GameEngine:
//
//   Ball&             ball();
//   std::vector<Player>& players();
//   Player*            playerById(int id);
//   bool               isPreparingPass(int playerId);
//   void               notePreventedStaleGrab(Player& p);
//   void               logPlayerDecision(int id, const std::string& type, double score,
//                                        const std::vector<Action>& top5, double x, double y,
//                                        const std::string& purpose);
//   void               logQualityFlag(const std::string& flag, /* ... */);
//   void               captureDecisionMoment(const std::string& tag, Player& p, /* ... */);
//   double             goalOpeningAngleDeg(double x, double y, double gx);
//   bool               isOffsideTarget(const Player& p, const Player& t);
//   AgentManagerConfig configFor(const std::string& team);
//   AgentTeamAssignment* assignmentFor(int playerId);
//   bool               isRecentFinishingDeliveryReceiver(int playerId);
//   bool               isRecentThroughBallReceiver(int playerId);
//   void               emitEvent(const std::string& type, double x, double y);
//   bool               passBallTo(Player& from, Player& to, bool through, bool lob,
//                                 const PassSelectionAudit* audit);
//   void               forcePassTo(Player& from, Player& to, const PassSelectionAudit* audit);
//   void               shootBall(Player& s, const ShotSelectionAudit* audit);
//   bool               attemptTackle(Player& tackler, Player& target);
//   bool               collectBall(Player& p, const std::string& context, double reach);
//   bool               canContestBall(const Player& p);
//   AgentCommitRun*    committedRunFor(int playerId);
//   const std::string& teamInPossession();
//   const std::string& teamPhaseFor(const std::string& team);
//   double             offsideLineFor(const std::string& team);  // returns NaN if null
//   AgentRecentPass*   qRecentPass();
//   std::vector<Player*> nearPlayers(const Player& p, double range);
//   void               noteTaskSelection(Player& p, const std::string& role);
//   bool               isCarrierShielded(int playerId);
//   bool               canKnockBallAhead(int playerId);
//   void               knockBallAhead(Player& p, double tx, double ty);
//   bool               isActiveKnockAheadRunner(int playerId);
//
//   // public counters
//   int statsDribbleFast    = 0;
//   int statsDribbleClose   = 0;
//   int statsDribbleMedium  = 0;
//   int statsTimeWastingDribbles = 0;

// ══════════════════════════════════════════════════════════════════════════════
// tick()
// ══════════════════════════════════════════════════════════════════════════════
inline void PlayerAgent::tick(double sdt) {
    if (player.role == "GK") return;
    // The engine advances a carrier directly; keep perception aligned with that visible facing.
    facing = player.facing;

    sl = std::max(0, sl - 1);
    sc = std::max(0, sc - 1);

    // lazy-init ball memory on first tick
    if (ballMemAge == 0 && ballMemX == 0 && ballMemY == 0) {
        ballMemX = engine.state.ball.x;
        ballMemY = engine.state.ball.y;
    }

    bool ic = (engine.state.ball.controllerId == player.id);
    if (ic) ht++;
    else    ht = 0;

    if (ic && engine.isPreparingPass(player.id)) {
        player.targetX = player.x;
        player.targetY = player.y;
        lx = player.x;
        ly = player.y;
        return;
    }

    if (ch.has_value() && ch->ballControllerId != engine.state.ball.controllerId) {
        if (ch->ballIsLoose
            && engine.state.ball.controllerId >= 0
            && dist(player.x, player.y, engine.state.ball.x, engine.state.ball.y) <= PRE_CONTACT_CHASE_REACH)
        {
            engine.notePreventedStaleGrab(player);
        }
        ch.reset();
    }

    // Intended receivers must react to the current flight, not a cached pre-pass view.
    if (engine.state.ball.intendedReceiverId == player.id) ch.reset();

    Perception per = gp();

    GameContext gctx = ctx();
    std::vector<Action> aff = ev(per, ic, gctx);
    Action choice = rc(aff);

    auditDefensiveMovement(choice);
    ex(choice, sdt, aff);

    // per-player decision log (roughly every 500 ms)
    if (std::fmod(engine.state.clockMs, 500.0) < 20.0) {
        std::vector<Action> top = aff;
        std::sort(top.begin(), top.end(),
                  [](const Action& x, const Action& y) { return x.score > y.score; });
        if (top.size() > 5) top.resize(5);
        // Convert to simpler struct for logging — pass as-is; engine will extract what it needs.
        engine.logPlayerDecision(player.id, choice.type, choice.score,
                                 top, player.x, player.y, choice.purpose);
        if (ic) {
            auto shootOpt = std::find_if(aff.begin(), aff.end(),
                                         [](const Action& x) { return x.type == "shoot" && x.score >= 0.0; });
            if (shootOpt != aff.end()) {
                engine.auditCredibleShotWindow(player, shootOpt->audit.distance,
                    shootOpt->audit.angleDeg, per.pressureCount, choice.type);
            }
        }
    }

    // "why no shoot" alert: carrier near goal, unpressured, didn't shoot
    if (ic && per.pressureCount == 0 && choice.type != "shoot" && choice.type != "hold"
        && std::fmod(engine.state.clockMs, 500.0) < 20.0)
    {
        double gx = (player.team == "home") ? AWAY_GOAL_X : HOME_GOAL_X;
        if (std::abs(player.x - gx) < 120.0) {
            auto shootOpt = std::find_if(aff.begin(), aff.end(),
                                         [](const Action& x) { return x.type == "shoot"; });
            if (shootOpt != aff.end() && shootOpt->score > 0.20) {
                double distance = shootOpt->audit.distance;
                if (distance == 0.0) distance = std::hypot(player.x - gx, player.y - PITCH_H / 2.0);
                double angleDeg = shootOpt->audit.angleDeg;
                if (angleDeg == 0.0) angleDeg = engine.goalOpeningAngleDeg(player.x, player.y, gx);
                engine.logQualityFlag("why_no_shoot", player.id, player.role,
                    distance, angleDeg, shootOpt->score, choice.type, choice.score);
                engine.captureDecisionMoment("why_no_shoot", player,
                    choice.type, choice.score, shootOpt->score,
                    distance, angleDeg, per.pressureCount,
                    8000.0, "why_no_shoot:" + player.team);
            }
        }
    }

    lx = player.x;
    ly = player.y;
}

// ══════════════════════════════════════════════════════════════════════════════
// ctx() — game context
// ══════════════════════════════════════════════════════════════════════════════
inline GameContext PlayerAgent::ctx() {
    int ms = engine.state.homeScore, os = engine.state.awayScore;
    int my = (player.team == "home") ? ms : os;
    int op = (player.team == "home") ? os : ms;
    int d  = my - op;
    double tl = std::max(0.0, 90.0 * 60.0 * 1000.0 - engine.state.clockMs);
    double u;
    if (tl < 5.0 * 60.0 * 1000.0) {
        u = (d < 0) ? 1.0 : (d == 0) ? 0.7 : 0.3;
    } else {
        u = (d < 0) ? 0.6 : (d == 0) ? 0.3 : 0.0;
    }
    return { d, tl, (engine.state.clockMs < 45.0 * 60.0 * 1000.0) ? 1 : 2, u };
}

// ══════════════════════════════════════════════════════════════════════════════
// ev() — evaluate actions
// ══════════════════════════════════════════════════════════════════════════════
inline std::vector<Action> PlayerAgent::ev(const Perception& per, bool ic, const GameContext& ctx) {
    std::vector<Action> a;
    if (ic) {
        if (sl > 0) {
            // scan-hold: gentle drift
            double angle = engine.state.clockMs * 0.005 + player.id * 1.7;
            double tx = player.x + std::cos(angle) * 3.0;
            double ty = player.y + std::sin(angle) * 3.0;
            return { Action{"dribble", 1.0, nullptr, tx, ty, "hold"} };
        }
        // scan-hold: unpressured carriers in opponent half pause briefly
        if (per.pressureCount == 0) {
            bool inOppHalf = player.team == "home" ? player.x > HALF_X : player.x < HALF_X;
            if (inOppHalf) {
                bool quickPassAvailable = false;
                double facingRad = player.facing;
                double fx = std::cos(facingRad), fy = std::sin(facingRad);
                for (auto& t : engine.state.players) {
                    if (t.team != player.team || t.id == player.id || t.role == "GK") continue;
                    double dx = t.x - player.x, dy = t.y - player.y;
                    double d = std::hypot(dx, dy);
                    if (d > 150.0) continue;
                    double dot = (dx * fx + dy * fy) / d;
                    if (dot > 0.65) { quickPassAvailable = true; break; }
                }
                if (!quickPassAvailable) {
                    sl = 8 + static_cast<int>(engine.rng.random() * 10); // 133-300ms scan-hold
                    return { Action{"hold", 1.0} };
                }
            }
        }
        if (sc > 0) {
            double gx = (player.team == "home") ? AWAY_GOAL_X : HOME_GOAL_X;
            if (std::abs(player.x - gx) < 150.0) {
                auto cpv = this->cp(per, ctx);
                auto csv = this->cs(per, ctx);
                auto cdv = this->cd(per, ctx);
                a = cpv;
                a.push_back(csv);
                a.push_back(cdv);
            } else {
                Action d = this->cd(per, ctx);
                d.score = 0.6;
                return { d };
            }
        } else {
            auto cpv = this->cp(per, ctx);
            auto csv = this->cs(per, ctx);
            auto cdv = this->cd(per, ctx);
            a = cpv;
            a.push_back(csv);
            a.push_back(cdv);
        }

        int pc = per.pressureCount;
        for (auto& x : a) {
            if (x.type == "pass")    x.score += pc * 0.04;
            if (x.type == "shoot")   x.score += pc * 0.03;
            if (x.type == "dribble" && pc == 1) x.score += 0.10;
            if (x.type == "dribble" && pc >= 3) x.score -= 0.10;
        }

        // carriers prefer passing over shooting
        auto bestPassIt = std::max_element(a.begin(), a.end(),
            [](const Action& x, const Action& y) {
                if (x.type != "pass") return true;
                if (y.type != "pass") return false;
                return x.score < y.score;
            });
        Action* bestPass = nullptr;
        for (auto& x : a) {
            if (x.type == "pass") {
                if (!bestPass || x.score > bestPass->score) bestPass = &x;
            }
        }
        if (bestPass && bestPass->score > 0.20) bestPass->score += 0.00; // was 0.06
        if (player.role == "CM" && bestPass && bestPass->score > 0.15) bestPass->score += 0.00; // was 0.14

        // CM: drive into space when no passing option is obvious
        if (player.role == "CM") {
            Action* bestDribble = nullptr;
            for (auto& x : a) {
                if (x.type == "dribble") {
                    if (!bestDribble || x.score > bestDribble->score) bestDribble = &x;
                }
            }
            if (bestDribble && bestDribble->score > 0.25) bestDribble->score += 0.08;
        }

        // hold ball longer when unpressured
        if (pc == 0) {
            for (auto& x : a) { if (x.type == "dribble") x.score += 0.10; }
            if (player.role == "CM") {
                for (auto& x : a) { if (x.type == "dribble") x.score += 0.08; if (x.type == "pass") x.score += 0.02; }
            }
            if (player.role == "WM") {
                for (auto& x : a) { if (x.type == "dribble") x.score += 0.12; if (x.type == "pass") x.score += 0.04; }
            }
        }
    } else {
        a.push_back(this->ct(per, ctx));
        a.push_back(this->cm(per, ctx));
        a.push_back(this->cc(per));
        auto bpv = this->bp(per, ctx);
        a.insert(a.end(), bpv.begin(), bpv.end());
    }

    // final third urgency
    double gx = (player.team == "home") ? AWAY_GOAL_X : HOME_GOAL_X;
    if (std::abs(player.x - gx) < 280.0) {
        for (auto& x : a) {
            if (x.type == "shoot")                                  x.score += 0.06;
            if (x.type == "pass" && x.purpose == "through")        x.score += 0.04;
            if (x.type == "dribble" && x.purpose == "space")       x.score += 0.04;
        }
    }

    for (auto& x : a) {
        if (x.type == la && x.target && x.target->id == lt) x.score += ic ? 0.12 : 0.05;

        // position stickiness
        if (x.type == "position" && x.posX != 0 && x.posY != 0) {
            double td = std::sqrt((x.posX - player.targetX) * (x.posX - player.targetX)
                                + (x.posY - player.targetY) * (x.posY - player.targetY));
            if (td < 50.0) x.score += 0.07;
        }

        x.score += (engine.rng.random() - 0.5) * 0.03;  // ★ random() #1
    }

    return a;
}

// ══════════════════════════════════════════════════════════════════════════════
// cp() — can-pass
// ══════════════════════════════════════════════════════════════════════════════
inline std::vector<Action> PlayerAgent::cp(const Perception& per, const GameContext& ctx) {
    const auto& p = player;
    double fd = (p.team == "home") ? 1.0 : -1.0;
    std::vector<Action> r;

    for (auto& t : engine.state.players) {
        if (t.team != p.team || t.id == p.id || t.role == "GK") continue;
        double d = dist(p.x, p.y, t.x, t.y);
        if (d < 30.0 || d > 550.0) continue;
        if (engine.isOffsideTarget(p, t)) continue;

        // vision cone: only pass to teammates in forward 120° arc
        if (d > 40.0) {
            double angleTo = std::atan2(t.y - p.y, t.x - p.x);
            double aDiff = std::abs(angleTo - facing);
            double na = (aDiff > 3.141592653589793) ? 2.0 * 3.141592653589793 - aDiff : aDiff;
            if (na > 3.141592653589793 / 3.0) continue;
        }

        int bl = 0;
        double dx = t.x - p.x, dy = t.y - p.y, ls = dx * dx + dy * dy;
        if (ls < 1.0) continue;

        for (auto& o : engine.state.players) {
            if (o.team == p.team || o.role == "GK") continue;
            double t2 = clamp(((o.x - p.x) * dx + (o.y - p.y) * dy) / ls, 0.0, 1.0);
            double perp = std::sqrt((o.x - p.x - t2 * dx) * (o.x - p.x - t2 * dx)
                                  + (o.y - p.y - t2 * dy) * (o.y - p.y - t2 * dy));
            if (perp < 30.0) bl++;
        }

        double fp = (t.x - p.x) * fd;
        double rs = attrFactor(p.attrs.passing);
        double rr = attrFactor(t.attrs.positioning);

        int receiverPressure = 0;
        for (auto& o : engine.state.players) {
            if (o.team != p.team && o.role != "GK" && dist(o.x, o.y, t.x, t.y) < 45.0) receiverPressure++;
        }
        if (receiverPressure >= 3) continue;

        double completion = clamp(
            0.89 + rs * 0.10 + rr * 0.06 - d / 850.0 * 0.28 - bl * 0.21
                - receiverPressure * 0.12 - (fp > 130.0 ? 0.05 : 0.0),
            0.08, 0.98);
        if (completion < 0.06) continue;

        double progression = clamp(fp / 240.0, -0.5, 1.0);
        double turnoverCost = ((p.team == "home") ? p.x < PITCH_W * 0.38 : p.x > PITCH_W * 0.62) ? 0.42 : 0.25;
        double sc = completion * (0.38 + std::max(0.0, progression) * 0.34) - (1.0 - completion) * turnoverCost;
        if (t.id == lp) sc -= 0.18;

        if (recentPassTarget == t.id && engine.state.clockMs - recentPassTime < 3000.0) sc -= 0.10;

        if (bl == 0 && fp > 80.0) sc += 0.08;
        if (fp < -30.0) sc -= 0.16;
        if (fp < -90.0) sc -= 0.18;

        double dg2 = std::abs(p.x - ((p.team == "home") ? AWAY_GOAL_X : HOME_GOAL_X));
        if (dg2 < 200.0 && fp > 0.0 && d < 150.0) sc += 0.10;

        double dgW = dg2;  // same computation
        bool isWideDelivery = (p.role == "WM" || p.role == "FB")
            && dgW < 315.0
            && std::abs(p.y - PITCH_H / 2.0) > 90.0
            && std::abs(t.x - ((p.team == "home") ? AWAY_GOAL_X : HOME_GOAL_X)) < 235.0
            && std::abs(t.y - PITCH_H / 2.0) < 135.0
            && fp > -80.0;

        bool isCross   = isWideDelivery && std::abs(p.y - PITCH_H / 2.0) > 180.0 && fp > 0.0;
        bool isCutback = isWideDelivery && !isCross;

        if (p.role == "WM" && dgW < 380.0 && t.role == "CF" && std::abs(t.y - PITCH_H / 2.0) < 200.0) sc += 0.28;
        if (p.role == "WM" && fp > 50.0 && std::abs(p.y - PITCH_H / 2.0) > 120.0 && bl <= 2) sc += 0.20;
        if (p.role == "FB" && fp > 35.0 && std::abs(p.y - PITCH_H / 2.0) > 90.0 && dgW < 360.0) sc += 0.18;

        sc -= bl * 0.06;
        if (fp > 0.0) {
            sc += 0.08 + (ctx.urgency > 0.5 ? 0.10 : 0.0)
                + (engine.configFor(p.team).passingDirectness - 50.0) / 100.0 * 0.20;
        } else {
            sc -= (engine.configFor(p.team).passingDirectness - 50.0) / 100.0 * 0.15;
        }

        std::string pur = "keep";
        if (fp > 120.0 && bl == 0)          pur = "build";
        else if (fp > 40.0 && bl <= 1)      pur = "build";
        else if (std::abs(t.y - p.y) > 150.0) pur = "switch";
        else if (bl >= 2 && fp < -30.0)      pur = "clear";
        if (isCross)                          pur = "cross";
        else if (isCutback)                   pur = "cutback";

        // switching play boost
        if (pur == "switch") {
            std::string carrierSide = (p.y < PITCH_H / 2.0) ? "top" : "bottom";
            std::string targetSide  = (t.y < PITCH_H / 2.0) ? "top" : "bottom";
            if (carrierSide != targetSide) {
                int oppsNearCarrier = 0;
                int oppsNearTarget  = 0;
                for (auto& o : engine.state.players) {
                    if (o.team == p.team || o.role == "GK") continue;
                    bool onCarrierSide = (carrierSide == "top") ? o.y < PITCH_H / 2.0 : o.y >= PITCH_H / 2.0;
                    if (onCarrierSide && dist(p.x, p.y, o.x, o.y) < 250.0) oppsNearCarrier++;
                    bool onTargetSide = (targetSide == "top") ? o.y < PITCH_H / 2.0 : o.y >= PITCH_H / 2.0;
                    if (onTargetSide && dist(o.x, o.y, t.x, t.y) < 200.0) oppsNearTarget++;
                }
                if (oppsNearCarrier >= 3 && oppsNearTarget <= 1)      sc += 0.18;
                else if (oppsNearCarrier >= 2 && oppsNearTarget <= 2) sc += 0.10;
            }
        }

        if (ctx.urgency > 0.6) {
            if (pur == "build")   sc += 0.20;
            if (pur == "switch")  sc += 0.15;
            if (pur == "keep")    sc -= 0.05;
        } else if (ctx.urgency < 0.3) {
            if (pur == "keep")    sc += 0.15;
            if (pur == "switch")  sc += 0.12;
        } else {
            if (pur == "switch")  sc += 0.10;
        }

        double cr = attrFactor(p.attrs.creativity);
        if (pur == "build" && bl > 0) sc += cr * 0.12;
        if (pur == "clear")           sc -= cr * 0.10;

        // role preference matrix
        using RoleList = std::vector<std::string>;
        static const std::unordered_map<std::string, RoleList> rcMap = {
            {"GK", {}},
            {"CB", {"CM", "FB", "WM", "CF"}},
            {"FB", {"CM", "WM", "CB"}},
            {"CM", {"CF", "WM", "FB"}},
            {"WM", {"CF", "CM"}},
            {"CF", {"CM", "WM"}},
        };
        auto it = rcMap.find(p.role);
        const RoleList& pref = (it != rcMap.end()) ? it->second : RoleList{};
        auto rii = std::find(pref.begin(), pref.end(), t.role);
        if (rii == pref.begin())           sc += 0.12;
        else if (rii == pref.begin() + 1)  sc += 0.06;
        if (t.role == p.role) sc -= (p.role == "CB" || p.role == "FB") ? 0.30 : 0.20;

        if ((p.role == "CB" || p.role == "FB") && (t.role == "CM" || t.role == "WM") && fp > 0.0) sc += 0.08;

        auto* assignment = engine.assignmentFor(t.id);
        if (assignment) {
            if (assignment->role == "run_ahead")        sc += 0.12;
            if (assignment->role == "overlap" && p.role != "CB") sc += 0.11;
            if (assignment->role == "advance_midfield") sc += 0.09;
            if (assignment->role == "hold_width" && std::abs(t.y - p.y) > 120.0) sc += 0.08;
        }

        double offsideLine = engine.offsideLineFor(p.team);
        double onsideGap = std::isnan(offsideLine) ? 1e9 : (offsideLine - t.x) * fd;

        bool releasedRunner = (assignment && (assignment->role == "run_ahead" || assignment->role == "overlap"))
                              || (p.role == "CM" && (t.role == "CF" || t.role == "WM"));
        if (!isWideDelivery && releasedRunner && fp > 30.0 && onsideGap > -25.0 && onsideGap < 170.0 && bl <= 2) {
            pur = "through";
            sc += 0.18 + attrFactor(p.attrs.creativity) * 0.12;
            if (onsideGap < 8.0) sc += engine.rng.random() * 0.04;  // ★ random() #2
        }

        sc += std::min(ht / 200.0, 0.35);

        if (receiverPressure >= 2) sc -= 0.25;
        if (per.pressureCount >= 2 && bl == 0) sc += 0.10;
        if (per.pressureCount >= 2 && bl >= 2) sc -= 0.15;

        if (p.role == "CM" && t.role == "CF" && receiverPressure >= 1 && bl <= 1)
            sc += attrFactor(p.attrs.creativity) * 0.10;

        // one-two return
        auto& bb = engine.blackboards[p.team];
        if (bb.oneTwo.has_value()
            && bb.oneTwo->from == t.id
            && bb.oneTwo->to == p.id
            && engine.state.clockMs < bb.oneTwo->expires)
            sc += 0.25;

        if (sc > 0.0) {
            r.push_back(Action{
                "pass",
                clamp(sc, 0.0, 1.0),
                &t,
                0, 0,
                pur,
                ActionAudit{ d, fp, completion, bl, receiverPressure, 0, 0 }
            });
        }
    }
    return r;
}

// ══════════════════════════════════════════════════════════════════════════════
// cs() — can-shoot
// ══════════════════════════════════════════════════════════════════════════════
inline Action PlayerAgent::cs(const Perception& per, const GameContext& ctx) {
    const auto& p = player;
    double gx = (p.team == "home") ? AWAY_GOAL_X : HOME_GOAL_X;
    double shotDistance = std::hypot(p.x - gx, p.y - PITCH_H / 2.0);
    double angleDeg = engine.goalOpeningAngleDeg(p.x, p.y, gx);

    ActionAudit audit;
    audit.distance = shotDistance;
    audit.angleDeg = angleDeg;
    audit.pressureCount = per.pressureCount;

    bool outsideGoalLane = std::abs(p.y - PITCH_H / 2.0) > GOAL_W / 2.0 - BALL_R + 20.0;
    bool acuteGeometry = outsideGoalLane && angleDeg < 7.5 && shotDistance > 150.0;

    if (shotDistance > 225.0 || acuteGeometry)
        return Action{"shoot", -1.0, nullptr, 0, 0, "", audit};

    if (shotDistance > 200.0 && angleDeg < 9.0)
        return Action{"shoot", -1.0, nullptr, 0, 0, "", audit};

    static const std::unordered_map<std::string, double> roleMax = {
        {"CF", 225.0}, {"CM", 205.0}, {"WM", 200.0}, {"FB", 165.0}, {"CB", 140.0}
    };
    double hardMax = 220.0;
    auto rit = roleMax.find(p.role);
    if (rit != roleMax.end()) hardMax = rit->second;
    if (shotDistance > hardMax)
        return Action{"shoot", -1.0, nullptr, 0, 0, "", audit};

    double mr = SHOOT_MIN_DIST + attrFactor(p.attrs.shooting) * (SHOOT_MAX_DIST - SHOOT_MIN_DIST);
    if (shotDistance > std::min(mr, hardMax))
        return Action{"shoot", -1.0, nullptr, 0, 0, "", audit};

    double sc = attrFactor(p.attrs.shooting) * (1.0 - shotDistance / mr) * 0.35;
    if (shotDistance < 90.0)  sc = std::max(sc, 0.35);
    if (shotDistance < 50.0)  sc = std::max(sc, 0.52);
    if (shotDistance < 30.0)  sc = std::max(sc, 0.70);

    Player* gk = nullptr;
    for (auto& o : engine.state.players) {
        if (o.team != p.team && o.role == "GK") { gk = &o; break; }
    }
    if (gk) {
        double gkOffCenter = std::abs(p.y - gk->y);
        if (gkOffCenter > 60.0)      sc += 0.12;
        else if (gkOffCenter < 25.0) sc -= 0.08;
        if (std::abs(gk->x - gx) > 50.0) sc += 0.08;
    }

    if (shotDistance < 100.0) sc += 0.14;
    if (shotDistance < 60.0)  sc += 0.12;
    if (p.role == "CF") sc += 0.13;
    if (p.role == "CM") sc -= 0.03;
    if (std::abs(p.y - PITCH_H / 2.0) > 100.0) sc -= 0.08;
    sc -= std::min(0.24, per.pressureCount * 0.09);
    if (ctx.urgency > 0.6 && shotDistance < 240.0) sc += 0.08;

    bool credibleOpening = angleDeg >= 7.5 || shotDistance < 115.0;
    if (shotDistance < 120.0 && credibleOpening) sc += 0.38;
    if (shotDistance < 70.0  && credibleOpening) sc += 0.28;
    if (shotDistance < 40.0)  sc += 0.18;

    bool recentFinishingDelivery = engine.isRecentFinishingDeliveryReceiver(p.id);
    if (shotDistance < 230.0 && angleDeg > 5.0 && recentFinishingDelivery) sc += 0.52;
    if (p.crossCollected > 0.0 && shotDistance < 230.0 && !recentFinishingDelivery) sc += 0.35;
    if (shotDistance < 220.0 && engine.isRecentThroughBallReceiver(p.id)) sc += 0.32;

    return Action{"shoot", clamp(sc, 0.0, 1.0), nullptr, 0, 0, "", audit};
}

// ══════════════════════════════════════════════════════════════════════════════
// cd() — can-dribble
// ══════════════════════════════════════════════════════════════════════════════
inline Action PlayerAgent::cd(const Perception& per, const GameContext& /*ctx*/) {
    const auto& p = player;
    double gx = (p.team == "home") ? AWAY_GOAL_X : HOME_GOAL_X;
    double tx = gx, ty = p.y;

    if (per.nearestOpponentDist < 50.0 && !per.nearbyOpponents.empty()) {
        // find nearest opponent
        Player* n = nullptr;
        double nd = 1e9;
        for (auto* o : per.nearbyOpponents) {
            double d = dist(p.x, p.y, o->x, o->y);
            if (d < nd) { nd = d; n = o; }
        }
        if (n) {
            double ax = p.x - n->x, ay = p.y - n->y;
            double ad = std::sqrt(ax * ax + ay * ay);
            if (ad > 1.0) { tx = p.x + (ax / ad) * 70.0; ty = p.y + (ay / ad) * 70.0; }
        }
    }

    if (p.y < 60.0)           ty = std::max(ty, p.y + 40.0);
    if (p.y > PITCH_H - 60.0) ty = std::min(ty, p.y - 40.0);
    if (p.x < 60.0)           tx = std::max(tx, p.x + 40.0);
    if (p.x > PITCH_W - 60.0) tx = std::min(tx, p.x - 40.0);

    tx = lerp(tx, gx, 0.3);
    double sc = 0.30;

    if (per.nearestOpponentDist > 80.0) sc += 0.10;
    if (per.nearestOpponentDist < 40.0) sc -= 0.10;
    if (std::abs(p.x - gx) < 200.0) sc += 0.10;

    double m = std::sqrt((p.x - lx) * (p.x - lx) + (p.y - ly) * (p.y - ly));
    if (ht > 60 && m < 3.0)  sc -= 0.20;
    if (ht > 180)            sc -= 0.30;

    int ndCount = 0;
    for (auto* o : per.nearbyOpponents) {
        if (dist(p.x, p.y, o->x, o->y) < 80.0) ndCount++;
    }
    if (ndCount >= 3) sc -= 0.15;
    if (ndCount >= 5) sc -= 0.20;

    // WM: take on defenders in wide areas
    if (p.role == "WM" && std::abs(p.y - PITCH_H / 2.0) > 120.0) sc += 0.08;
    if (p.role == "WM") {
        bool inWide = std::abs(p.y - PITCH_H / 2.0) > 140.0;
        bool nearOppBox = std::abs(p.x - gx) < 350.0;
        if (inWide) {
            sc += 0.15;
            if (per.nearestOpponentDist < 60.0) sc += 0.08;
        }
        if (nearOppBox && per.nearestOpponentDist > 50.0) sc += 0.10;
        if (inWide && nearOppBox) {
            tx = lerp(tx, gx, 0.5);
            ty = lerp(ty, PITCH_H / 2.0, 0.3);
        }
    }
    if (p.role == "CM" && per.nearestOpponentDist > 60.0) sc += 0.12;
    if (p.role == "CM" && std::abs(p.x - gx) < 250.0) sc += 0.06;

    return Action{"dribble", clamp(sc, 0.0, 1.0), nullptr,
                  clamp(tx, 35.0, PITCH_W - 35.0),
                  clamp(ty, 35.0, PITCH_H - 35.0)};
}

// ══════════════════════════════════════════════════════════════════════════════
// ct() — can-tackle
// ══════════════════════════════════════════════════════════════════════════════
inline Action PlayerAgent::ct(const Perception& per, const GameContext& /*ctx*/) {
    if (per.ballIsLoose || per.ballControllerTeam == player.team || per.ballControllerTeam.empty())
        return Action{"tackle", 0.0};

    Player* ctrl = engine.playerById(per.ballControllerId);
    if (!ctrl) return Action{"tackle", 0.0};

    double d = dist(player.x, player.y, ctrl->x, ctrl->y);
    if (d > TACKLE_RANGE + 30.0) return Action{"tackle", 0.0};

    bool isDef = (player.role == "CB" || player.role == "FB");
    if (isDef) {
        if (player.role == "CB") {
            double fd = (player.team == "home") ? 1.0 : -1.0;
            bool inOwnHalf = (fd == 1.0) ? ctrl->x < PITCH_W * 0.5 : ctrl->x > PITCH_W * 0.5;
            if (!inOwnHalf) return Action{"tackle", 0.0};
        }
        if (player.role == "FB") {
            bool onMyFlank = std::abs(ctrl->y - player.homeY) < 250.0;
            bool isAttacker = ctrl->role == "WM" || ctrl->role == "CF" || ctrl->role == "CM";
            if (!onMyFlank || !isAttacker) return Action{"tackle", 0.0};
        }
    }

    double sc;
    if (player.role == "FB") {
        sc = 0.50 - (d / 60.0) * 0.35 + attrFactor(player.attrs.tackling) * 0.18;
    } else if (player.role == "CB") {
        sc = 0.68 - (d / 60.0) * 0.35 + attrFactor(player.attrs.tackling) * 0.22;
    } else {
        sc = 0.60 - (d / 60.0) * 0.40 + attrFactor(player.attrs.tackling) * 0.20;
    }

    if (player.role == "CM") sc += 0.06;
    if (player.role == "CF") sc -= 0.15;
    if (player.role == "WM") sc -= 0.04;
    if (d < TACKLE_RANGE + 10.0) sc += 0.15;

    auto* defensiveTask = engine.assignmentFor(player.id);
    if (defensiveTask) {
        if (defensiveTask->opponentId == ctrl->id && defensiveTask->role == "primary_press")   sc += 0.20;
        if (defensiveTask->opponentId == ctrl->id && defensiveTask->role == "secondary_press") sc += 0.10;
        if (defensiveTask->role != "primary_press" && defensiveTask->role != "secondary_press"
            && std::abs(ctrl->x - ((player.team == "home") ? HOME_GOAL_X : AWAY_GOAL_X)) > 170.0)
            sc -= 0.20;
    }

    if (engine.isCarrierShielded(ctrl->id)) sc -= 0.20;

    double ownGoalX = (player.team == "home") ? HOME_GOAL_X : AWAY_GOAL_X;
    if (std::abs(ctrl->x - ownGoalX) < 220.0) sc += 0.18;
    if (std::abs(ctrl->x - ownGoalX) < 120.0) sc += 0.12;

    // pressing trigger
    int oppsClose = 0;
    for (auto* o : per.nearbyOpponents) {
        if (dist(o->x, o->y, ctrl->x, ctrl->y) < 60.0) oppsClose++;
    }
    if (std::abs(ctrl->x - ownGoalX) < 300.0 && oppsClose < 2) sc += 0.08;

    bool oppFacingAway = (ctrl->team == "home") ? ctrl->vx < 0.0 : ctrl->vx > 0.0;
    if (oppFacingAway && d < TACKLE_RANGE + 20.0) sc += 0.10;

    sc += (engine.configFor(player.team).aggression / 100.0) * 0.10;

    return Action{"tackle", clamp(sc, 0.0, 1.0), ctrl};
}

// ══════════════════════════════════════════════════════════════════════════════
// cm() — can-mark
// ══════════════════════════════════════════════════════════════════════════════
inline Action PlayerAgent::cm(const Perception& per, const GameContext& /*ctx*/) {
    if (player.role != "CB" && player.role != "FB") return Action{"mark", 0.0};
    if (per.ballControllerTeam == player.team && !per.ballIsLoose) return Action{"mark", 0.0};

    if (per.ballIsLoose && per.intendedId >= 0) {
        Player* t = engine.playerById(per.intendedId);
        if (t && t->team != player.team && (t->role == "CF" || t->role == "WM")) {
            double d = dist(player.x, player.y, t->x, t->y);
            if (d < 300.0) return Action{"mark", clamp(0.65 - (d / 300.0) * 0.3, 0.0, 1.0), t};
        }
    }

    Player* best = nullptr;
    double bd = 1e9;
    double ownGx = (player.team == "home") ? HOME_GOAL_X : AWAY_GOAL_X;
    bool isFb = (player.role == "FB");

    for (auto& o : engine.state.players) {
        if (o.team == player.team || o.role == "GK") continue;
        if (isFb && o.role != "WM" && (o.role != "CM" || std::abs(o.y - player.homeY) > 200.0)) continue;
        if (!isFb && o.role != "CF" && o.role != "CM") continue;

        double d = dist(player.x, player.y, o.x, o.y);
        double danger = std::abs(o.x - ownGx);
        double score = d * 0.6 + danger * 0.4;

        if (isFb) {
            bool onFlank = std::abs(o.y - player.homeY) < 220.0;
            if (onFlank && o.role == "WM")      score -= 80.0;
            else if (!onFlank && o.role == "WM") score += 20.0;
            else if (o.role == "CM")             score -= 15.0;
        }
        if (!isFb) {
            if (o.role == "CF")      score -= 60.0;
            else if (o.role == "CM") score -= 20.0;
        }

        if (score < bd && d < 300.0) { bd = score; best = &o; }
    }

    if (!best) return Action{"mark", 0.0};

    double dangerDist = dist(player.x, player.y, best->x, best->y);
    double baseScore = isFb ? 0.60 : 0.50;
    return Action{"mark", clamp(baseScore + attrFactor(player.attrs.positioning) * 0.25 - (dangerDist / 300.0) * 0.25, 0.0, 1.0), best};
}

// ══════════════════════════════════════════════════════════════════════════════
// cc() — can-chase
// ══════════════════════════════════════════════════════════════════════════════
inline Action PlayerAgent::cc(const Perception& per) {
    auto& b = engine.state.ball;
    bool isIntendedReceiver = (player.id == b.intendedReceiverId);
    double ballSpeed = std::sqrt(b.vx * b.vx + b.vy * b.vy);
    bool needsRecovery = b.z <= 20.0 && ballSpeed < 30.0 && per.amClosestToBall;

    if (!per.ballIsLoose || !engine.canContestBall(player)
        || (!isIntendedReceiver && per.ballDist > 180.0 && !needsRecovery))
        return Action{"chase", 0.0};

    if (isIntendedReceiver) {
        double lead = ballSpeed > 30.0 ? 0.2 + std::min(ballSpeed / 300.0, 0.5) : 0.0;
        return Action{"chase", 1.0, nullptr,
                      clamp(b.x + b.vx * lead, 10.0, PITCH_W - 10.0),
                      clamp(b.y + b.vy * lead, 10.0, PITCH_H - 10.0),
                      "receive_ball"};
    }

    if (needsRecovery) {
        return Action{"chase", 1.0, nullptr,
                      clamp(b.x, 10.0, PITCH_W - 10.0),
                      clamp(b.y, 10.0, PITCH_H - 10.0),
                      "recover_loose_ball"};
    }

    bool isDef = (player.role == "CB" || player.role == "FB");
    if (isDef) {
        if (player.role == "FB") {
            bool onMyFlank = (player.homeY < PITCH_H / 2.0)
                ? b.y < PITCH_H * 0.55 : b.y > PITCH_H * 0.45;
            if (per.ballDist > 100.0 && !onMyFlank) return Action{"chase", 0.0};
        }
        if (player.role == "CB") {
            bool ballInOwnHalf = (player.team == "home")
                ? b.x < PITCH_W * 0.6 : b.x > PITCH_W * 0.4;
            if (per.ballDist > 120.0 && !ballInOwnHalf) return Action{"chase", 0.0};
        }
    }

    if (player.role == "CM" && per.ballDist > 100.0) {
        bool ballInMiddle = b.x > PITCH_W * 0.25 && b.x < PITCH_W * 0.75;
        if (!ballInMiddle) return Action{"chase", 0.0};
    }

    if (player.role == "WM" && per.ballDist > 80.0) {
        bool onMyFlank = (player.homeY < PITCH_H / 2.0)
            ? b.y < PITCH_H * 0.55 : b.y > PITCH_H * 0.45;
        if (!onMyFlank) return Action{"chase", 0.0};
    }

    if (player.role == "CF" && per.ballDist > 80.0) {
        double oppGx = (player.team == "home") ? AWAY_GOAL_X : HOME_GOAL_X;
        bool ballNearOppGoal = std::abs(b.x - oppGx) < 200.0;
        if (!ballNearOppGoal) return Action{"chase", 0.0};
    }

    double sc = per.ballDist < 50.0 ? 0.90 : per.ballDist < 100.0 ? 0.75 : 0.55;
    sc -= per.ballDist / 180.0 * 0.3;

    if (per.amClosestToBall) sc += 0.12;
    if (per.anyOpponentCloserToBall) {
        double ms = attrFactor(player.attrs.speed) * SPEED_SPRINT;
        if (per.ballDist / std::max(ms, 1.0) < 1.5) sc += 0.10;
    }

    double bs = ballSpeed;
    double la = bs > 30.0 ? 0.3 + std::min(bs / 200.0, 0.8) : 0.0;

    if (bs > 15.0 && per.ballDist > 20.0) {
        double toMeX = player.x - b.x, toMeY = player.y - b.y;
        double toMeDist = std::sqrt(toMeX * toMeX + toMeY * toMeY);
        if (toMeDist > 1.0) {
            double dot = (b.vx * toMeX + b.vy * toMeY) / (bs * toMeDist);
            if (dot > 0.4) sc += 0.12;
            if (dot > 0.7) sc += 0.10;
        }
    }

    // pass reaction: intercept if near the pass trajectory
    auto* rp = engine.qRecentPass();
    if (rp && engine.state.clockMs - rp->clockMs < 800.0) {
        if (rp->team != player.team) {
            double rdx = rp->vx, rdy = rp->vy;
            double rd = std::sqrt(rdx * rdx + rdy * rdy);
            if (rd > 1.0) {
                double toLine = ((player.x - rp->bx) * rdx + (player.y - rp->by) * rdy) / (rd * rd);
                double perp = std::sqrt(
                    (player.x - rp->bx - toLine * rdx) * (player.x - rp->bx - toLine * rdx)
                  + (player.y - rp->by - toLine * rdy) * (player.y - rp->by - toLine * rdy));
                if (perp < 60.0 && toLine > 0.1 && toLine < 1.2) sc += 0.12;
            }
        }
    }

    if (isDef) {
        double ownGoalX = (player.team == "home") ? HOME_GOAL_X : AWAY_GOAL_X;
        if (std::abs(b.x - ownGoalX) < 250.0) sc += 0.20;
        if (std::abs(b.x - ownGoalX) < 150.0) sc += 0.15;
    }

    return Action{"chase", clamp(sc, 0.0, 1.0), nullptr,
                  clamp(b.x + b.vx * la, 10.0, PITCH_W - 10.0),
                  clamp(b.y + b.vy * la, 10.0, PITCH_H - 10.0)};
}

// ══════════════════════════════════════════════════════════════════════════════
// bp() — best-position (off-ball positioning)
// ══════════════════════════════════════════════════════════════════════════════
inline std::vector<Action> PlayerAgent::bp(const Perception& per, const GameContext& ctx) {
    const auto& p = player;
    auto& b = engine.state.ball;
    double fd = (p.team == "home") ? 1.0 : -1.0;
    std::string ip = engine.teamInPossession();
    bool my = (per.ballControllerTeam == p.team);
    auto* committedRun = engine.committedRunFor(p.id);

    if (committedRun) {
        return { Action{"position", 1.0, nullptr, committedRun->targetX, committedRun->targetY, "timed_run"} };
    }

    std::string phase = engine.teamPhaseFor(p.team);
    double ba = (fd == 1.0) ? b.x / PITCH_W : 1.0 - b.x / PITCH_W;
    double pu = my ? ba * 180.0 : 0.0;
    bool iw = (p.role == "FB" || p.role == "WM");
    double wp = (iw && my) ? ba * 60.0 : 0.0;

    struct Candidate { double x, y; std::string pur; };
    std::vector<Candidate> c = {
        { p.homeX + pu + wp, p.homeY, "cover" },
        { p.homeX + fd * 30.0 + pu + wp, p.homeY, "cover" },
        { p.homeX - fd * 20.0 + pu + wp, p.homeY, "cover" },
        { p.homeX + pu + wp, p.homeY - 25.0, "cover" },
        { p.homeX + pu + wp, p.homeY + 25.0, "cover" },
        { lerp(p.homeX, b.x, 0.15) + pu, lerp(p.homeY, b.y, 0.10), "cover" },
    };

    // space utilization: shift toward less congested flank
    int topCount = 0, botCount = 0;
    for (auto& o : engine.state.players) {
        if (dist(p.x, p.y, o.x, o.y) >= 200.0) continue;
        if (o.y < PITCH_H / 2.0) topCount++;
        else                      botCount++;
    }
    int openFlank = (topCount < botCount) ? -1 : 1;
    c.push_back({ p.homeX + pu, clamp(p.homeY + openFlank * 50.0, 40.0, PITCH_H - 40.0), "cover" });

    if (!my && !per.ballIsLoose && !per.ballControllerTeam.empty()) {
        double og = (p.team == "home") ? HOME_GOAL_X : AWAY_GOAL_X;
        double rx = clamp(lerp(p.x, og, 0.5), og, p.x);
        c.push_back({ rx, p.homeY, "cover" });
        c.push_back({ rx, p.homeY - 30.0, "cover" });
        c.push_back({ rx, p.homeY + 30.0, "cover" });

        bool ballPastUs = (fd == 1.0) ? b.x > p.x + 20.0 : b.x < p.x - 20.0;
        if (ballPastUs && (p.role == "CB" || p.role == "FB" || p.role == "CM")) {
            c.push_back({ rx - fd * 30.0, p.homeY, "cover" });
            c.push_back({ rx - fd * 30.0, p.homeY - 25.0, "cover" });
        }
    }

    if (per.ballDist > 150.0) {
        if (my && ip == p.team) {
            c.push_back({ p.homeX + fd * 60.0 + pu, clamp(p.homeY + ((p.homeY < PITCH_H / 2.0) ? 40.0 : -40.0), 50.0, PITCH_H - 50.0), "offer" });
            if (p.role == "WM" || p.role == "FB")
                c.push_back({ p.homeX + fd * 40.0 + pu, clamp(p.homeY + ((p.homeY < PITCH_H / 2.0) ? -50.0 : 50.0), 40.0, PITCH_H - 40.0), "space" });
        } else if (!my) {
            c.push_back({ p.homeX - fd * 40.0, p.homeY, "cover" });
            if (p.role == "CM" || p.role == "CF")
                c.push_back({ lerp(p.homeX, b.x, 0.3), lerp(p.homeY, b.y, 0.2), "cover" });
        }
    }

    // observe: walk toward play when far from ball
    if (per.ballDist > 250.0 && !per.iAmController) {
        c.push_back({ lerp(p.x, b.x, 0.15), lerp(p.y, b.y, 0.12), "observe" });
        c.push_back({ lerp(p.x, b.x, 0.10), clamp(lerp(p.y, b.y, 0.08), 40.0, PITCH_H - 40.0), "observe" });
    }

    // press resistance
    if (my && !per.iAmController) {
        Player* carrier = engine.playerById(engine.state.ball.controllerId);
        if (carrier && carrier->team == p.team) {
            int carrierPressure = 0;
            for (auto& o : engine.state.players) {
                if (o.team != p.team && o.role != "GK" && dist(o.x, o.y, carrier->x, carrier->y) < 60.0) carrierPressure++;
            }
            if (carrierPressure >= 2) {
                c.push_back({ lerp(p.x, carrier->x, 0.3), lerp(p.y, carrier->y, 0.25), "offer" });
                c.push_back({ lerp(p.x, carrier->x, 0.2), clamp(lerp(p.y, carrier->y, 0.15), 40.0, PITCH_H - 40.0), "offer" });
            }
        }
    }

    // react to nearby pass
    auto* rp2 = engine.qRecentPass();
    if (rp2 && engine.state.clockMs - rp2->clockMs < 600.0) {
        if (rp2->team == p.team && dist(p.x, p.y, rp2->bx, rp2->by) < 250.0) {
            c.push_back({ lerp(p.x, rp2->bx, 0.12), lerp(p.y, rp2->by, 0.10), "offer" });
        }
    }

    if (my && ip == p.team) {
        c.push_back({ p.homeX + fd * 80.0 + pu, p.homeY, "offer" });
        c.push_back({ p.homeX + fd * 50.0 + pu, p.homeY - 35.0, "space" });
        c.push_back({ p.homeX + fd * 50.0 + pu, p.homeY + 35.0, "space" });

        // one-two: sprint forward
        auto& bb2 = engine.blackboards[p.team];
        if (bb2.oneTwo.has_value() && bb2.oneTwo->from == p.id && engine.state.clockMs < bb2.oneTwo->expires) {
            double oppGoalX = (p.team == "home") ? AWAY_GOAL_X : HOME_GOAL_X;
            c.push_back({ clamp(p.x + fd * 80.0, p.homeX + fd * 40.0, oppGoalX), p.y, "space" });
            c.push_back({ clamp(p.x + fd * 120.0, p.homeX + fd * 60.0, oppGoalX), clamp(p.y - 30.0, 40.0, PITCH_H - 40.0), "space" });
            c.push_back({ clamp(p.x + fd * 120.0, p.homeX + fd * 60.0, oppGoalX), clamp(p.y + 30.0, 40.0, PITCH_H - 40.0), "space" });
        }

        // counter-attack
        if (phase == "attacking_transition" && (p.role == "CF" || p.role == "WM" || p.role == "CM")) {
            double oppGoalX = (p.team == "home") ? AWAY_GOAL_X : HOME_GOAL_X;
            c.push_back({ clamp(lerp(p.x, oppGoalX, 0.6), p.x + fd * 50.0, oppGoalX), p.homeY, "space" });
            c.push_back({ clamp(lerp(p.x, oppGoalX, 0.5), p.x + fd * 40.0, oppGoalX), p.homeY - 30.0, "space" });
        }

        // box runs
        if (ba > 0.6 && (p.role == "CF" || p.role == "CM" || p.role == "WM")) {
            double bGoalX = (p.team == "home") ? AWAY_GOAL_X : HOME_GOAL_X;
            c.push_back({ bGoalX - fd * (30.0 + engine.rng.random() * 70.0),                           clamp(PITCH_H / 2.0 + (p.homeY - PITCH_H / 2.0) * 0.4, PITCH_H * 0.25, PITCH_H * 0.75), "space" });  // ★ random() #3
            c.push_back({ bGoalX - fd * (50.0 + engine.rng.random() * 50.0),                           clamp(PITCH_H / 2.0 + (engine.rng.random() - 0.5) * 80.0, PITCH_H * 0.20, PITCH_H * 0.80), "space" });  // ★ random() #4, #5
        }

        // CM: find gaps between opponent lines
        if (p.role == "CM") {
            double midSum = 0, defSum = 0;
            int midCount = 0, defCount = 0;
            for (auto& o : engine.state.players) {
                if (o.team == p.team) continue;
                if (o.role == "CM" || o.role == "WM") { midSum += o.x; midCount++; }
                if (o.role == "CB" || o.role == "FB") { defSum += o.x; defCount++; }
            }
            if (midCount > 0 && defCount > 0) {
                double midLine = midSum / midCount;
                double defLine = defSum / defCount;
                double gapX = (midLine + defLine) / 2.0;
                c.push_back({ clamp(gapX, p.homeX - 40.0, p.homeX + 120.0), p.homeY, "offer" });
                c.push_back({ clamp(gapX, p.homeX - 40.0, p.homeX + 120.0), clamp(p.homeY - 40.0, 40.0, PITCH_H - 40.0), "space" });
            }
            if (ba < 0.35 && my) {
                c.push_back({ clamp(p.homeX - fd * 30.0, 60.0, PITCH_W - 60.0), p.homeY, "offer" });
                c.push_back({ clamp(p.homeX - fd * 20.0, 60.0, PITCH_W - 60.0), clamp(p.homeY + 35.0, 40.0, PITCH_H - 40.0), "offer" });
            }
            double bSide = (b.y < PITCH_H / 2.0) ? -1.0 : 1.0;
            c.push_back({ clamp(p.homeX + fd * 30.0 + pu, 60.0, PITCH_W - 60.0), clamp(p.homeY + bSide * 50.0, 40.0, PITCH_H - 40.0), "space" });
        }

        // WM: attack the flank
        if (p.role == "WM") {
            double flankY = (p.homeY < PITCH_H / 2.0) ? 18.0 : PITCH_H - 18.0;
            std::string crossPur = ba > 0.45 ? "offer" : "space";
            c.push_back({ clamp(p.homeX + fd * 80.0 + pu, 60.0, PITCH_W - 60.0), flankY, crossPur });
            double runBehindY = (p.homeY < PITCH_H / 2.0) ? PITCH_H * 0.3 : PITCH_H * 0.7;
            c.push_back({ clamp(p.homeX + fd * 140.0 + pu, 60.0, AWAY_GOAL_X - fd * 20.0), runBehindY, "space" });
            if (std::abs(b.y - p.homeY) > 200.0) {
                c.push_back({ clamp(p.homeX + fd * 100.0 + pu, 60.0, PITCH_W - 60.0), clamp(lerp(p.y, PITCH_H / 2.0, 0.3), 40.0, PITCH_H - 40.0), "space" });
                c.push_back({ clamp(p.homeX + fd * 80.0 + pu, 60.0, PITCH_W - 60.0), clamp(PITCH_H / 2.0 + ((p.homeY < PITCH_H / 2.0) ? 80.0 : -80.0), 40.0, PITCH_H - 40.0), "space" });
            }
        }

        if (p.role == "CB" || p.role == "FB")
            c.push_back({ p.homeX + fd * 150.0 + pu, p.homeY, "cover" });

        double fld = (b.y < PITCH_H / 2.0) ? -1.0 : 1.0;
        c.push_back({ p.homeX + fd * 55.0 + pu, clamp(p.homeY + fld * 50.0, 40.0, PITCH_H - 40.0), "space" });
        c.push_back({ p.homeX + fd * 40.0 + pu, clamp(p.homeY - fld * 70.0, 40.0, PITCH_H - 40.0), "switch" });
        if (p.role == "WM" || p.role == "FB")
            c.push_back({ p.homeX + fd * 40.0 + pu, clamp(p.homeY + ((p.homeY < PITCH_H / 2.0) ? -80.0 : 80.0), 30.0, PITCH_H - 30.0), "space" });

        // FB overlap
        if (p.role == "FB" && my) {
            Player* wmOnMySide = nullptr;
            for (auto& o : engine.state.players) {
                if (o.team == p.team && o.role == "WM" && std::abs(o.homeY - p.homeY) < 100.0) {
                    wmOnMySide = &o; break;
                }
            }
            bool wmHasBall = wmOnMySide && engine.state.ball.controllerId == wmOnMySide->id;
            if (wmHasBall) {
                c.push_back({ clamp(wmOnMySide->x + fd * 80.0, p.homeX + fd * 80.0, AWAY_GOAL_X - fd * 20.0),
                              clamp((p.homeY < PITCH_H / 2.0) ? 35.0 : PITCH_H - 35.0, 35.0, PITCH_H - 35.0), "space" });
                c.push_back({ clamp(wmOnMySide->x + fd * 50.0, p.homeX + fd * 50.0, AWAY_GOAL_X),
                              clamp((p.homeY < PITCH_H / 2.0) ? 55.0 : PITCH_H - 55.0, 40.0, PITCH_H - 40.0), "space" });
            } else {
                double wmHomeY = (p.homeY < PITCH_H / 2.0) ? PITCH_H * 0.12 : PITCH_H * 0.88;
                c.push_back({ p.homeX + fd * 120.0 + pu, clamp(wmHomeY, 40.0, PITCH_H - 40.0), "space" });
            }
        }

        // CF positioning
        if (p.role == "CF") {
            double oppGoalX = (p.team == "home") ? AWAY_GOAL_X : HOME_GOAL_X;
            double ld = (fd == 1.0) ? -1e9 : 1e9;
            bool anyDefenders = false;
            for (auto& o : engine.state.players) {
                if (o.team != p.team && o.role != "GK") {
                    anyDefenders = true;
                    ld = (fd == 1.0) ? std::max(ld, o.x) : std::min(ld, o.x);
                }
            }
            if (anyDefenders) {
                double defLine = clamp(ld, p.homeX - 40.0, oppGoalX + fd * 20.0);
                double pushX = (fd == 1.0) ? std::min(p.homeX + fd * 100.0, ld - 15.0) : std::max(p.homeX + fd * 100.0, ld + 15.0);
                c.push_back({ pushX, p.homeY, "offer" });
                double runY = clamp(p.homeY + ((engine.rng.random() > 0.5) ? 40.0 : -40.0), PITCH_H * 0.2, PITCH_H * 0.8);  // ★ random() #6
                c.push_back({ clamp(defLine - fd * 10.0, p.homeX + fd * 40.0, oppGoalX), runY, "space" });
            }
            if (ba < 0.5 && my) {
                c.push_back({ clamp(p.homeX - fd * 20.0, p.homeX - 60.0, PITCH_W - 60.0), p.homeY, "offer" });
            }
            if (ba > 0.58 && my) {
                double nearPost = (p.y < PITCH_H / 2.0) ? PITCH_H * 0.35 : PITCH_H * 0.65;
                double farPost  = (p.y < PITCH_H / 2.0) ? PITCH_H * 0.65 : PITCH_H * 0.35;
                c.push_back({ clamp(oppGoalX - fd * 55.0, 60.0, PITCH_W - 60.0), nearPost, "space" });
                c.push_back({ clamp(oppGoalX - fd * 80.0, 60.0, PITCH_W - 60.0), farPost, "space" });
            }
        }
    }

    // defensive line — move as a unit
    if (!my && (p.role == "CB" || p.role == "FB")) {
        double sumX = 0;
        int count = 0;
        double deepestX = (p.team == "home") ? 0.0 : PITCH_W;
        for (auto& t : engine.state.players) {
            if (t.team != p.team || t.role == "GK") continue;
            if (t.role == "CB" || t.role == "FB") {
                sumX += t.x; count++;
                double tx = (p.team == "home") ? t.x : PITCH_W - t.x;
                double rev = (p.team == "home") ? deepestX : PITCH_W - deepestX;
                if (tx < rev) deepestX = t.x;
            }
        }
        double meanLine = count > 0 ? sumX / count : p.homeX;
        double lineX = clamp(meanLine, p.homeX - 70.0, p.homeX + 70.0);
        c.push_back({ lineX, p.homeY, "cover" });
        c.push_back({ lineX - fd * 15.0, p.homeY, "cover" });
        if (ba < 0.35)
            c.push_back({ clamp(p.homeX + fd * 180.0, lineX + fd * 40.0, PITCH_W - 50.0), p.homeY, "cover" });

        bool ballPastUs = (fd == 1.0) ? b.x > lineX + 20.0 : b.x < lineX - 20.0;
        if (ballPastUs) {
            double dropX = clamp(lerp(lineX, (p.team == "home") ? HOME_GOAL_X : AWAY_GOAL_X, 0.3), p.homeX - 80.0, p.homeX);
            c.push_back({ dropX, p.homeY, "cover" });
            c.push_back({ dropX - fd * 20.0, p.homeY, "cover" });
        }
        double bSide2 = (b.y < PITCH_H / 2.0) ? -1.0 : 1.0;
        c.push_back({ lineX - fd * 10.0, clamp(p.homeY + bSide2 * 25.0, 40.0, PITCH_H - 40.0), "cover" });
        if (ba < 0.4)
            c.push_back({ clamp(p.homeX + fd * 220.0, p.homeX + 50.0, PITCH_W - 50.0), p.homeY, "cover" });
    }

    if (!my) {
        c.push_back({ clamp((b.x + ((p.team == "home") ? HOME_GOAL_X : AWAY_GOAL_X)) / 2.0, p.homeX - 80.0, p.homeX + 20.0), p.homeY, "cover" });
        double bf2 = (b.y < PITCH_H / 2.0) ? -1.0 : 1.0;
        c.push_back({ clamp(p.homeX - fd * 30.0, 40.0, PITCH_W - 40.0), clamp(p.homeY + bf2 * 25.0, 40.0, PITCH_H - 40.0), "cover" });
        if (p.role == "FB" && std::abs(b.y - p.homeY) > 200.0) {
            c.push_back({ clamp(p.homeX - fd * 20.0, 40.0, PITCH_W - 40.0), clamp(lerp(p.homeY, PITCH_H / 2.0, 0.5), 40.0, PITCH_H - 40.0), "cover" });
        }
    }

    if (ctx.urgency > 0.6 && my) {
        c.push_back({ p.homeX + fd * 120.0 + pu, p.homeY, "offer" });
        c.push_back({ p.homeX + fd * 90.0 + pu, p.homeY - 40.0, "space" });
    }

    std::vector<Action> options;
    for (auto& cn : c) {
        double sf = 0;
        for (auto* o : per.nearbyOpponents) {
            double d2 = std::sqrt((cn.x - o->x) * (cn.x - o->x) + (cn.y - o->y) * (cn.y - o->y));
            if (d2 < 50.0) sf -= (50.0 - d2) / 50.0;
        }
        double tac = my ? (cn.x - p.homeX) * fd / PITCH_W * 0.5 : -(cn.x - p.homeX) * fd / PITCH_W * 0.25;
        double og2 = (p.team == "home") ? HOME_GOAL_X : AWAY_GOAL_X;
        double db = !my ? clamp(((b.x - cn.x) * fd) / (std::abs(b.x - og2) + 1.0), 0.0, 0.30) : 0.0;
        double bp2 = std::sqrt((cn.x - b.x) * (cn.x - b.x) + (cn.y - b.y) * (cn.y - b.y)) / 600.0 * 0.08;
        double ob = (cn.pur == "observe") ? 0.10 :
                    (cn.pur == "space" && p.role == "WM" && std::abs(cn.y - PITCH_H / 2.0) > 150.0 && ba > 0.4) ? 0.12 : 0.0;

        double jx = std::sin(engine.state.clockMs * 0.007 + p.id * 1.3) * 6.0;
        double jy = std::cos(engine.state.clockMs * 0.009 + p.id * 1.9) * 6.0;

        options.push_back(Action{
            "position",
            clamp(0.15 + sf * 0.3 + tac - bp2 + db + ob, 0.0, 1.0),
            nullptr,
            clamp(cn.x + jx, 40.0, PITCH_W - 40.0),
            clamp(cn.y + jy, 40.0, PITCH_H - 40.0),
            cn.pur
        });
    }

    auto* task = engine.assignmentFor(p.id);
    if (task) {
        static const std::unordered_map<std::string, double> taskScores = {
            {"primary_press", 0.82}, {"secondary_press", 0.70}, {"cover", 0.62},
            {"lane_block", 0.68}, {"defensive_line", 0.62}, {"wide_cover", 0.62},
            {"midfield_screen", 0.60}, {"support_outlet", 0.47}, {"advance_midfield", 0.60},
            {"run_ahead", 0.64}, {"inside_run", 0.62}, {"hold_width", 0.56},
            {"overlap", 0.66}, {"rest_defence", 0.56},
        };
        double ts = 0.80;
        auto tit = taskScores.find(task->role);
        if (tit != taskScores.end()) ts = tit->second;
        options.push_back(Action{"position", ts, nullptr, task->targetX, task->targetY,
                                 "task:" + task->role});
    }

    return options;
}

// ══════════════════════════════════════════════════════════════════════════════
// rc() — resolve choice
// ══════════════════════════════════════════════════════════════════════════════
inline Action PlayerAgent::rc(std::vector<Action>& a) {
    std::sort(a.begin(), a.end(),
              [](const Action& x, const Action& y) { return x.score > y.score; });

    if (a.empty()) return Action{"hold", 1.0};

    Action& best = a[0];
    bool ic = (engine.state.ball.controllerId == player.id);
    double gx = (player.team == "home") ? AWAY_GOAL_X : HOME_GOAL_X;
    bool nearGoal = std::abs(player.x - gx) < 220.0;
    bool inBox    = std::abs(player.x - gx) < 150.0;

    if (ic && best.score < (inBox ? 0.05 : nearGoal ? 0.10 : 0.22))
        return Action{"hold", 1.0};

    auto& bb = engine.blackboards[player.team];

    if (best.type == "tackle" && best.target) {
        bool isSelf = (bb.pressingPlayerId == player.id || bb.pressingPlayerId2 == player.id);
        bool slot1Free = (bb.pressingPlayerId < 0);
        bool slot2Free = (bb.pressingPlayerId2 < 0);

        if (!isSelf && !slot1Free && !slot2Free) {
            for (auto& x : a) {
                if (x.type != "tackle" && x.score > 0.15) return x;
            }
            return Action{"hold", 1.0};
        }

        if (!isSelf) {
            if (slot1Free)      bb.pressingPlayerId  = player.id;
            else if (slot2Free) bb.pressingPlayerId2 = player.id;
        }
    }

    if (best.type == "mark" && best.target) {
        auto it = bb.markedOpponents.find(best.target->id);
        if (it != bb.markedOpponents.end() && it->second != player.id) {
            for (auto& x : a) {
                if (x.type != "mark" && x.type != "tackle" && x.score > 0.15) return x;
            }
            return Action{"hold", 1.0};
        }
        bb.markedOpponents[best.target->id] = player.id;
    }

    // backward pass audit
    if (ic && best.type == "pass" && best.audit.forwardProgress < -40.0) {
        Action* fwdOpt = nullptr;
        for (auto& x : a) {
            if (x.type == "pass" && x.audit.forwardProgress > 30.0 && x.score > best.score - 0.15) {
                fwdOpt = &x; break;
            }
        }
        if (fwdOpt) engine.logQualityFlag("questionable_backpass", player.id, player.role,
                                          best.audit.forwardProgress, true,
                                          fwdOpt->score, best.score,
                                          8000.0, "backpass:" + std::to_string(player.id));
    }

    return best;
}

// ══════════════════════════════════════════════════════════════════════════════
// ex() — execute chosen action
// ══════════════════════════════════════════════════════════════════════════════
inline void PlayerAgent::ex(Action& a, double sdt, std::vector<Action>& actions) {
    auto& p = player;
    auto& b = engine.state.ball;

    la = a.type;
    lastPurpose = a.purpose;
    lt = a.target ? a.target->id : -1;

    if (a.type != "dribble") p.dribbleType = 0;

    if (a.type == "pass" && a.target) {
        PassSelectionAudit audit = passSelectionAudit(a, actions);
        bool released;
        if (a.purpose == "clear") {
            engine.forcePassTo(p, *a.target, &audit);
            released = true;
        } else {
            released = engine.passBallTo(p, *a.target, a.purpose == "through", false, &audit);
        }
        if (released) {
            lp = a.target->id;
            recentPassTarget = a.target->id;
            recentPassTime = engine.state.clockMs;
            engine.emitEvent("pass", p.x, p.y);
            auto& bb = engine.blackboards[p.team];
            bb.oneTwo = TeamBlackboard::OneTwo{ p.id, a.target->id, engine.state.clockMs + 2000.0 };
            sl = 50 + static_cast<int>(engine.rng.random() * 21); // 0.8-1.2s cooldown
        } else {
            sl = 4;
        }
    }
    else if (a.type == "shoot") {
        ShotSelectionAudit audit = shotSelectionAudit(a, actions);
        engine.shootBall(p, &audit);
        engine.emitEvent("shot", p.x, p.y);
        sl = 20;
    }
    else if (a.type == "dribble") {
        p.targetX = (a.posX != 0) ? a.posX : ((p.team == "home") ? AWAY_GOAL_X : HOME_GOAL_X);
        p.targetY = (a.posY != 0) ? a.posY : p.y;

        double wobbleAngle = std::sin(engine.state.clockMs * 0.008 + p.id * 1.7) * 0.3;
        double wobbleDist  = std::sin(engine.state.clockMs * 0.012 + p.id * 2.3) * 12.0;
        p.targetX += std::cos(wobbleAngle) * wobbleDist;
        p.targetY += std::sin(wobbleAngle) * wobbleDist;

        double distToTarget = std::sqrt((p.targetX - p.x) * (p.targetX - p.x)
                                      + (p.targetY - p.y) * (p.targetY - p.y));

        int nearbyOpps = 0;
        double nearestOppDist = 1e9;
        for (auto& o : engine.state.players) {
            if (o.team != p.team && o.role != "GK") {
                double d = dist(p.x, p.y, o.x, o.y);
                nearestOppDist = std::min(nearestOppDist, d);
                if (d < 55.0) nearbyOpps++;
            }
        }

        bool openBurst       = distToTarget > 130.0 && nearestOppDist > 120.0;
        bool speculativeBurst = distToTarget > 175.0 && nearestOppDist > 95.0 && p.attrs.creativity >= 84.0;
        bool mayBurst = engine.canKnockBallAhead(p.id) && (openBurst || speculativeBurst);
        int dribbleType = mayBurst ? 3 : (nearbyOpps >= 2 ? 1 : 2);

        bool newEpisode = (p.dribbleType != dribbleType);
        if (newEpisode) {
            engine.stats.recordDribble(dribbleType);
        }
        p.dribbleType = dribbleType;
        if (dribbleType == 3 && newEpisode) engine.knockBallAhead(p, p.targetX, p.targetY);

        double oppGoalX = (p.team == "home") ? AWAY_GOAL_X : HOME_GOAL_X;
        double fd = (p.team == "home") ? 1.0 : -1.0;
        if ((fd == 1.0 && p.targetX < p.x - 10.0) || (fd == -1.0 && p.targetX > p.x + 10.0)) {
            if (std::abs(p.x - oppGoalX) < 300.0) {
                int closeOpps = 0;
                for (auto& o : engine.state.players) {
                    if (o.team != p.team && o.role != "GK" && dist(p.x, p.y, o.x, o.y) < 60.0) closeOpps++;
                }
                if (closeOpps == 0) {
                    int myScore  = (p.team == "home") ? engine.state.homeScore : engine.state.awayScore;
                    int oppScore = (p.team == "home") ? engine.state.awayScore : engine.state.homeScore;
                    bool isTimeWasting = (myScore <= oppScore && engine.state.clockMs > 60000.0);
                    if (isTimeWasting) engine.logQualityFlag(isTimeWasting ? "time_wasting_dribble" : "backward_dribble",
                                          p.id, p.role, (double)p.targetX, 0.0, 0.0, "", 0.0);
                }
            }
        }
    }
    else if (a.type == "tackle") {
        if (a.target && dist(p.x, p.y, a.target->x, a.target->y) <= TACKLE_RANGE
            && engine.attemptTackle(p, *a.target))
        {
            engine.emitEvent("tackle", (p.x + a.target->x) / 2.0, (p.y + a.target->y) / 2.0);
            p.tackleAnim = 300.0;
        } else {
            p.targetX = a.target ? a.target->x : p.x;
            p.targetY = a.target ? a.target->y : p.y;
        }
    }
    else if (a.type == "mark" && a.target) {
        double leadX = a.target->x + a.target->vx * 0.3;
        double leadY = a.target->y + a.target->vy * 0.3;
        double ownGx = (p.team == "home") ? HOME_GOAL_X : AWAY_GOAL_X;
        p.targetX = clamp(lerp(leadX, ownGx, 0.15), leadX - 80.0, leadX + 40.0);
        p.targetY = clamp(leadY + std::sin(engine.state.clockMs * 0.004 + p.id) * 8.0, 30.0, PITCH_H - 30.0);
    }
    else if (a.type == "chase") {
        double tx = (a.posX != 0) ? a.posX : b.x;
        double ty = (a.posY != 0) ? a.posY : b.y;
        p.targetX = tx;
        p.targetY = ty;
        double ms = attrFactor(p.attrs.speed) * SPEED_SPRINT;
        double cdx = tx - p.x, cdy = ty - p.y;
        double cd = std::sqrt(cdx * cdx + cdy * cdy);
        if (cd > 1.0) {
            p.vx = lerp(p.vx, (cdx / cd) * ms, 0.15);
            p.vy = lerp(p.vy, (cdy / cd) * ms, 0.15);
        }
    }
    else if (a.type == "position") {
        p.targetX = (a.posX != 0) ? a.posX : p.homeX;
        p.targetY = (a.posY != 0) ? a.posY : p.homeY;
        if (!a.purpose.empty() && a.purpose.rfind("task:", 0) == 0)
            engine.noteTaskSelection(p, a.purpose.substr(5));
    }
    else if (a.type == "hold") {
        if (b.controllerId == p.id) {
            // shield away from nearest opponent
            auto near = engine.nearPlayers(p, 60.0);
            Player* closestOpp = nullptr;
            double closestD = 1e9;
            for (auto* o : near) {
                if (o->team != p.team) {
                    double d = dist(p.x, p.y, o->x, o->y);
                    if (d < closestD) { closestD = d; closestOpp = o; }
                }
            }
            if (closestOpp) {
                p.targetX = clamp(p.x + (p.x - closestOpp->x) * 0.5, 35.0, PITCH_W - 35.0);
                p.targetY = clamp(p.y + (p.y - closestOpp->y) * 0.5, 35.0, PITCH_H - 35.0);
            } else {
                p.targetX = clamp((p.team == "home") ? AWAY_GOAL_X : HOME_GOAL_X, 40.0, PITCH_W - 40.0);
                p.targetY = clamp(p.y + (engine.rng.random() - 0.5) * 20.0, 40.0, PITCH_H - 40.0);  // ★ random() #7
            }
        }
    }

    if (engine.state.ball.controllerId != p.id) {
        am(sdt);
        if (a.type == "chase") tryCollectAfterChase();
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// gp() — get perception (cached)
// ══════════════════════════════════════════════════════════════════════════════
inline Perception PlayerAgent::gp() {
    pa++;
    if (ch.has_value() && pa < 3) return ch.value();
    ch = pr();
    pa = 0;
    return ch.value();
}

// ══════════════════════════════════════════════════════════════════════════════
// pr() — perceive surroundings
// ══════════════════════════════════════════════════════════════════════════════
inline Perception PlayerAgent::pr() {
    const auto& p = player;
    auto& b = engine.state.ball;
    double dx = b.x - p.x, dy = b.y - p.y, bd = std::sqrt(dx * dx + dy * dy);

    Perception per;
    per.ballDist = bd;
    per.ballIsLoose = (b.controllerId < 0);
    per.iAmController = (b.controllerId == p.id);
    per.intendedId = b.intendedReceiverId;
    per.nearestOpponentDist = 1e9;

    int pc = 0;

    for (auto& o : engine.state.players) {
        if (o.id == p.id) continue;
        double d = dist(p.x, p.y, o.x, o.y);
        if (d > PLAYER_AWARE_RANGE) continue;

        // vision cone
        bool inCone = false;
        if (d < 40.0) {
            inCone = true;
        } else {
            double angleTo = std::atan2(o.y - p.y, o.x - p.x);
            double diff = std::abs(angleTo - facing);
            double nd = (diff > 3.141592653589793) ? 2.0 * 3.141592653589793 - diff : diff;
            bool isOwnThird = (p.team == "home") ? b.x < PITCH_W / 3.0 : b.x > PITCH_W * 2.0 / 3.0;
            bool defenderWide = (p.role == "CB" || p.role == "FB") && isOwnThird;
            inCone = nd < (defenderWide ? 3.141592653589793 / 2.0 : 3.141592653589793 / 3.0);
        }
        if (!inCone) continue;

        if (o.team == p.team) {
            per.nearbyTeammates.push_back(&o);
        } else {
            per.nearbyOpponents.push_back(&o);
            if (d < per.nearestOpponentDist) per.nearestOpponentDist = d;
            if (d < 60.0) pc++;
        }
    }

    per.pressureCount = pc;

    Player* ctrl = engine.playerById(b.controllerId);
    if (ctrl) {
        per.ballControllerId = ctrl->id;
        per.ballControllerTeam = ctrl->team;
    } else {
        per.ballControllerTeam = engine.teamInPossession();
        if (per.ballControllerTeam.empty()) per.ballControllerTeam = "";
    }

    bool ac = true, ao = false;
    int cc = 0;
    double ctd = 1e9;

    for (auto& o : engine.state.players) {
        if (o.id == p.id || o.role == "GK") continue;
        double d = dist(o.x, o.y, b.x, b.y);
        if (o.team == p.team && d < bd) { cc++; if (d < ctd) ctd = d; }
        if (o.team != p.team && d < bd) ao = true;
    }
    if (cc > 0 && ctd < bd - 30.0) ac = false;

    per.amClosestToBall = ac;
    per.chasingTeammatesCount = cc;
    per.anyOpponentCloserToBall = ao;

    return per;
}

// ══════════════════════════════════════════════════════════════════════════════
// am() — apply movement
// ══════════════════════════════════════════════════════════════════════════════
inline void PlayerAgent::am(double sdt) {
    auto& p = player;
    if (p.role == "GK") return;

    double secs = sdt / 1000.0;
    double spd = std::sqrt(p.vx * p.vx + p.vy * p.vy);

    if (spd > SPEED_SPRINT * 0.5)
        p.stamina = std::max(0.0, p.stamina - STAMINA_DRAIN_SPRINT);
    else if (spd < 15.0)
        p.stamina = std::min(100.0, p.stamina + STAMINA_RECOVER);

    double sf = (p.stamina < STAMINA_SLOW_THRESHOLD * 100.0) ? p.stamina / 100.0 : 1.0;

    double dx = p.targetX - p.x, dy = p.targetY - p.y;
    double d = std::sqrt(dx * dx + dy * dy);

    bool committedRun   = (engine.committedRunFor(p.id) != nullptr);
    bool pressTask      = (lastPurpose == "task:primary_press");
    bool committedChase = (la == "chase" && engine.state.ball.controllerId < 0
                           && (lastPurpose == "receive_ball" || lastPurpose == "recover_loose_ball"));

    double bdx = engine.state.ball.x - p.x, bdy = engine.state.ball.y - p.y;
    double bd  = std::sqrt(bdx * bdx + bdy * bdy);
    double ownGoalX = (p.team == "home") ? HOME_GOAL_X : AWAY_GOAL_X;
    bool committedPress = pressTask && bd > 45.0 && (bd < 145.0 || std::abs(engine.state.ball.x - ownGoalX) < 240.0);

    bool isObserving = !committedRun && !committedChase && !committedPress && bd > 300.0 && bd > PLAYER_AWARE_RANGE * 0.5;

    double cruiseMul = isObserving
        ? (p.role == "CF" ? 0.45 : p.role == "CB" || p.role == "FB" ? 0.65 : p.role == "WM" ? 0.55 : 0.50)
        : 1.0;

    double baseSpeed = engine.isActiveKnockAheadRunner(p.id)
        ? DRIBBLE_FAST_SPEED
        : (la == "chase" || committedRun || committedPress ? SPEED_SPRINT : SPEED_RUN);

    double df = (committedRun || committedChase || committedPress) ? 1.0 : std::min(d / 120.0, 1.5);
    double ms = attrFactor(p.attrs.speed) * baseSpeed * sf * df * cruiseMul;

    double px = p.x, py = p.y;
    if (d > 1.0) {
        double sp = std::min(ms * secs, d);
        p.x += (dx / d) * sp;
        p.y += (dy / d) * sp;
    }

    if (secs > 0.001) {
        p.vx = (p.x - px) / secs;
        p.vy = (p.y - py) / secs;
    }

    // ball tracking: update memory when ball is in vision cone
    double bAngle = std::atan2(engine.state.ball.y - p.y, engine.state.ball.x - p.x);
    double bDiff  = std::abs(bAngle - facing);
    double bNorm  = (bDiff > 3.141592653589793) ? 2.0 * 3.141592653589793 - bDiff : bDiff;
    if (bNorm < 3.141592653589793 / 3.0) {
        ballMemX = engine.state.ball.x;
        ballMemY = engine.state.ball.y;
        ballMemAge = 0;
    } else {
        ballMemAge++;
    }

    // update facing
    double spdAfter = std::sqrt(p.vx * p.vx + p.vy * p.vy);
    bool ic = (engine.state.ball.controllerId == p.id);
    if (ic) {
        auto& b = engine.state.ball;
        double bs = std::hypot(b.vx, b.vy);
        if(bs > 0.5) facing = facing + std::atan2(std::sin(std::atan2(-b.vy, -b.vx) - facing), std::cos(std::atan2(-b.vy, -b.vx) - facing)) * 0.05;
    } else if (spdAfter > 5.0) {
        double moveAngle = std::atan2(p.vy, p.vx);
        facing = facing + std::atan2(std::sin(moveAngle - facing), std::cos(moveAngle - facing)) * 0.06;
    } else if (ballMemAge > 30) {
        double memAngle = std::atan2(ballMemY - p.y, ballMemX - p.x);
        facing = facing + std::atan2(std::sin(memAngle - facing), std::cos(memAngle - facing)) * 0.02;
    }

    // dizzy tracking: cumulative rotation in degrees
    double prevFacing = p.facing;
    double facingDelta = std::abs(std::atan2(std::sin(facing - prevFacing), std::cos(facing - prevFacing)));
    dizzyRotationAccum += facingDelta * 180.0 / 3.141592653589793;
    if(engine.state.clockMs - dizzyWindowStartMs > 2000){
        dizzyWindowStartMs = engine.state.clockMs;
        dizzyRotationAccum = facingDelta * 180.0 / 3.141592653589793;
    }
    p.facing = facing;
}

// ══════════════════════════════════════════════════════════════════════════════
// tryCollectAfterChase()
// ══════════════════════════════════════════════════════════════════════════════
inline void PlayerAgent::tryCollectAfterChase() {
    auto& p = player;
    auto& b = engine.state.ball;

    if (b.controllerId >= 0) return;

    double distance = dist(p.x, p.y, b.x, b.y);
    bool intended = (p.id == b.intendedReceiverId);
    double reach = intended ? INTENDED_COLLECT_DIST : COLLECT_DIST;

    if (b.z >= 20.0 || distance > reach) return;

    double speed = std::hypot(b.vx, b.vy);
    double speedLimit = intended ? COLLECT_SPEED_MAX * INTENDED_COLLECT_BONUS : COLLECT_SPEED_MAX;

    if (speed >= speedLimit) return;

    if (!engine.collectBall(p, intended ? "intended_chase_reception" : "chase_collection", reach)) return;

    bool firstTimeChance = engine.isRecentFinishingDeliveryReceiver(p.id);
    sl = firstTimeChance ? 0 : 45;
    sc = firstTimeChance ? 0 : 15;
}

// ══════════════════════════════════════════════════════════════════════════════
// passSelectionAudit()
// ══════════════════════════════════════════════════════════════════════════════
inline PassSelectionAudit PlayerAgent::passSelectionAudit(const Action& choice,
                                                           const std::vector<Action>& actions)
{
    const auto& chosen = choice.audit;
    if (!choice.target) return {};

    const Action* safer = nullptr;
    double saferComp = 0;
    for (auto& a : actions) {
        if (a.type != "pass" || !a.target || a.target->id == choice.target->id) continue;
        if (!a.audit.expectedCompletion || !a.audit.forwardProgress) continue;
        if (a.audit.expectedCompletion >= chosen.expectedCompletion + 0.12
            && a.audit.forwardProgress >= chosen.forwardProgress - 35.0
            && a.score >= choice.score - 0.04)
        {
            if (!safer || a.audit.expectedCompletion > saferComp) {
                safer = &a;
                saferComp = a.audit.expectedCompletion;
            }
        }
    }

    PassSelectionAudit out;
    out.score             = choice.score;
    out.distance          = chosen.distance;
    out.forwardProgress   = chosen.forwardProgress;
    out.expectedCompletion = chosen.expectedCompletion;
    out.blockers          = chosen.blockers;
    out.receiverPressure  = chosen.receiverPressure;
    out.purpose           = choice.purpose.empty() ? "keep" : choice.purpose;
    out.saferOptionTargetId  = safer ? safer->target->id : -1;
    out.saferOptionScore      = safer ? safer->score : 0;
    out.saferOptionCompletion = safer ? safer->audit.expectedCompletion : 0;
    out.saferOptionProgress   = safer ? safer->audit.forwardProgress : 0;
    return out;
}

// ══════════════════════════════════════════════════════════════════════════════
// shotSelectionAudit()
// ══════════════════════════════════════════════════════════════════════════════
inline ShotSelectionAudit PlayerAgent::shotSelectionAudit(const Action& choice,
                                                            const std::vector<Action>& actions)
{
    const auto& shot = choice.audit;
    if (choice.score < 0) return {};

    const Action* bestPass = nullptr;
    for (auto& a : actions) {
        if (a.type == "pass" && a.target) {
            if (!bestPass || a.score > bestPass->score) bestPass = &a;
        }
    }

    ShotSelectionAudit out;
    out.score             = choice.score;
    out.distance          = shot.distance;
    out.angleDeg          = shot.angleDeg;
    out.pressureCount     = shot.pressureCount;
    out.bestPassTargetId  = bestPass ? bestPass->target->id : -1;
    out.bestPassScore     = bestPass ? bestPass->score : 0;
    out.bestPassCompletion = bestPass ? bestPass->audit.expectedCompletion : 0;
    return out;
}

// ══════════════════════════════════════════════════════════════════════════════
// auditDefensiveMovement()
// ══════════════════════════════════════════════════════════════════════════════
inline void PlayerAgent::auditDefensiveMovement(const Action& choice) {
    auto* task = engine.assignmentFor(player.id);
    Player* controller = engine.playerById(engine.state.ball.controllerId);
    if (!task || !controller || controller->team == player.team) return;
    if (task->role != "primary_press" && task->role != "secondary_press") return;
    if (choice.type == "tackle" || choice.type == "chase"
        || (!choice.purpose.empty() && choice.purpose.rfind("task:", 0) == 0))
        return;

    double targetX = choice.target ? choice.target->x : (choice.posX != 0 ? choice.posX : player.targetX);
    double targetY = choice.target ? choice.target->y : (choice.posY != 0 ? choice.posY : player.targetY);

    double currentDistance = dist(player.x, player.y, controller->x, controller->y);
    double targetDistance = std::hypot(targetX - controller->x, targetY - controller->y);

    double ownGoalX = (player.team == "home") ? HOME_GOAL_X : AWAY_GOAL_X;
    bool danger = std::abs(controller->x - ownGoalX) < 240.0;

    if (!danger && targetDistance <= currentDistance + 12.0) return;

    engine.logQualityFlag("why_player_running_direction", player.id, task->role,
                          controller->id, choice.type, choice.purpose,
                          currentDistance, targetDistance, danger ? 1.0 : 0.0,
                          8000.0, "why_player_running_direction:" + player.team);
    engine.captureDecisionMoment("why_player_running_direction", player,
                                 choice.type,
                                 choice.score, 0.0, currentDistance, targetDistance,
                                 danger ? 1 : 0,
                                 8000.0, "why_player_running_direction:" + player.team);
}

#endif // AGENT_HPP_IMPL
