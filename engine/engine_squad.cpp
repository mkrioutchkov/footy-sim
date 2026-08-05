// engine_squad.cpp — who is on the pitch, and how that changes
//
// Split out of engine.cpp (2939 lines, six unrelated subsystems in one file).
// This is the squad lifecycle: build the two teams from the roster tables or a
// spec override, seed the RNG-derived attributes, stock the bench, and then every
// way the eleven can change during a match — substitutions, red cards, and the
// goal-credit bookkeeping that hangs off a scorer id.
#include "engine.h"
#include "agent.h"
#include "role_ai.h"
#include "gk_ai.h"
#include <format>
#include <cmath>
#include <numbers>

// Role → role-AI factory. Single source of truth for the role-to-subclass map,
// used by both the kickoff build and the mid-match reassignAgent() swap (was the
// same switch copy-pasted in two places).
static std::unique_ptr<PlayerAI> makeAgentFor(Player& p, GameEngine& e) {
    switch (p.role) {
    case Role::GK: return std::make_unique<GKPlayerAI>(p, e);
    case Role::CF: return std::make_unique<CFPlayerAI>(p, e);
    case Role::WM: return std::make_unique<WMPlayerAI>(p, e);
    case Role::CM: return std::make_unique<CMPlayerAI>(p, e);
    case Role::CB: return std::make_unique<CBPlayerAI>(p, e);
    case Role::FB: return std::make_unique<FBPlayerAI>(p, e);
    default: return std::make_unique<PlayerAI>(p, e);
    }
}

// Default 4-3-3 slot roles + home anchors (engine frame). When a spec carries a
// formation layout (RosterOverride::hasLayout) these are overridden per slot;
// otherwise they reproduce the original hardcoded literals exactly (so the
// no-layout / default match stays byte-identical). Slot 0 is ALWAYS the GK on
// the goal line — a bad spec can't field a keeperless side.
namespace {
constexpr Role DEF_ROLES[11] = {Role::GK, Role::FB, Role::CB, Role::CB, Role::FB, Role::CM, Role::CM, Role::CM, Role::WM, Role::CF, Role::WM};
constexpr double DEF_HX_HOME[11] = {31.5, 157.5, 189, 189, 157.5, 420, 420, 420, 441, 756, 441};
constexpr double DEF_HX_AWAY[11] = {1018.5, 892.5, 861, 861, 892.5, 630, 630, 630, 609, 294, 609};
constexpr double DEF_HY[11] = {340, 81.6, 226.6667, 453.3333, 598.4, 170, 340, 510, 81.6, 340, 598.4};
} // namespace

void GameEngine::initWithSeed(int seed) {
    // One-shot guard: GameEngine is ONE-MATCH-PER-INSTANCE. A second call would
    // append to state.players again (no clear), reallocating the vector and
    // dangling every Player& the agents hold. Make a re-init a safe no-op.
    if (initialized_) return;
    initialized_ = true;
    rng.setSeed(seed);
    if (!configOverride) {
        // No tactics supplied: random "manager" personalities (legend exhibition).
        auto manager = [&]() {
            return Config{40 + rng.random() * 40, 30 + rng.random() * 40, 25 + rng.random() * 60,
                          30 + rng.random() * 55, 25 + rng.random() * 55};
        };
        baseConfig[0] = manager();
        baseConfig[1] = manager();
    }
    // The 23-random advances vary the legends' ±4 form between sides; a
    // data-driven roster has exact attrs (no form roll), so skip them there.
    if (!homeRoster.active)
        for (int i = 0; i < 23; i++) rng.random();
    createHomeTeam();
    if (!awayRoster.active)
        for (int i = 0; i < 23; i++) rng.random();
    createAwayTeam();
    for (auto& p : state.players) {
        if (p.id >= 0 && p.id < 22) playerLookup[p.id] = &p;
    }
    initBench();
    // §arena: park everyone except the GKs (0/11) and N outfielders per side
    // off-pitch, sent-off style, so the whole engine — press assignment, pass
    // menus, set pieces, offside — sees a legitimate small-sided match. No red
    // cards recorded, no subs (an ejected slot can't be replaced anyway, and
    // there is nobody on the pitch worth swapping).
    if (arenaMode) {
        // Round-30 (arena generality): an N-AWARE SHAPE. The round-21 table kept
        // attacking slots first ({9}, {9,5}, {9,5,8}) and every one of their
        // 4-3-3 anchors sits in the TOP half (y=340/170/81.6), so no arena
        // outfielder was ever a defender, the bottom half of the pitch was empty
        // at kickoff, and the offside line was drawn by a midfielder loitering on
        // halfway (3v3 measured ~44 offsides/90 against 11v11's ~4).
        //
        // Instead: keep a DEFENDER first, then a central mid, then the forward,
        // then width — growing in slot PAIRS that are already symmetric about
        // y=PITCH_H/2 (CB 2/3, CM 5/7, FB 1/4, WM 8/10) so every size fields a
        // real small-sided shape with both halves of the pitch occupied.
        //   1: 0-0-1   2: 1-0-1   3: 2-0-1   4: 2-1-1   5: 2-2-1
        //   6: 2-3-1   7: 2-4-1   8: 4-3-1   9: 4-4-1  10: 4-3-3 (full XI)
        // Slot 9 (the CF) is in every row — a match spec's star directives are
        // written against it. N=1 is deliberately UNCHANGED: the same anchor move
        // at 1v1 measured strictly WORSE (fouls 6.0->13.1, corners 0.8->9.0), the
        // lone man having nobody to defend with.
        static constexpr int ARENA_KEEP[ARENA_MAX_OUTFIELDERS][ARENA_MAX_OUTFIELDERS] = {
            {  9, -1, -1, -1, -1, -1, -1, -1, -1, -1},  //  1v1: CF
            {  3,  9, -1, -1, -1, -1, -1, -1, -1, -1},  //  2v2: CB + CF
            {  2,  3,  9, -1, -1, -1, -1, -1, -1, -1},  //  3v3: CB CB + CF
            {  2,  3,  6,  9, -1, -1, -1, -1, -1, -1},  //  4v4: + central CM
            {  2,  3,  5,  7,  9, -1, -1, -1, -1, -1},  //  5v5: CB CB, CM CM, CF
            {  2,  3,  5,  6,  7,  9, -1, -1, -1, -1},  //  6v6: + central CM
            {  2,  3,  5,  7,  8, 10,  9, -1, -1, -1},  //  7v7: + a winger pair
            {  1,  2,  3,  4,  5,  6,  7,  9, -1, -1},  //  8v8: back four, CM x3
            {  1,  2,  3,  4,  5,  7,  8, 10,  9, -1},  //  9v9: back four, CM x2 + wingers
            {  1,  2,  3,  4,  5,  6,  7,  8,  9, 10},  // 10v10: the full XI (4-3-3)
        };
        int n = clamp(arenaOutfielders, 1, ARENA_MAX_OUTFIELDERS);
        auto kept = [&](int id) {
            if (id == 0 || id == 11) return true;               // GKs always play
            for (int k = 0; k < n; ++k) {
                int slot = ARENA_KEEP[n - 1][k];
                if (slot >= 0 && (id == slot || id == slot + 11)) return true;
            }
            return false;
        };
        for (auto& p : state.players) {
            if (kept(p.id)) {
                // A LONE centre-back (the 2v2 row) owns the whole width, so his
                // 4-3-3 half-space anchor would leave one flank permanently open.
                // Re-centre him. Every other row keeps a symmetric pair, whose
                // default anchors already balance about the centre line.
                if (n == 2 && (p.id == 3 || p.id == 14))
                    p.homeY = p.y = p.targetY = PITCH_H / 2.0;
                continue;
            }
            p.sentOff = true;
            parkOffPitch(p);
        }
        subsRemaining = {0, 0};
    }
    for (auto& p : state.players) {
        agents.push_back(makeAgentFor(p, *this));
    }
    // §weather v2 WIND: derive the per-match wind vector from a SEPARATE seed-stream so the MAIN rng
    // (hence the whole clear-vs-wind in-match sim) stays byte-identical — only the airborne drift
    // differs (a clean paired comparison). Gated weather==2 so clear/rain never draw it, keeping the
    // default game byte-identical + the live-replay determinism invariant intact.
    // INIT-COUPLING: weather is set BEFORE initWithSeed (main.cpp), so the vector is derived once here;
    // a FUTURE live mid-match weather->wind flip must re-derive it (else windX/windY stay 0 = a silent
    // no-op wind). There is no such command today — weather is init-only. [adversarial-review flag]
    if (weather == 2) {
        SeededRNG wrng;
        wrng.setSeed(static_cast<uint32_t>(seed) ^ 0x57494e44u); // "WIND"
        double ang = wrng.random() * 6.283185307179586;          // 0..2pi
        double mag = WIND_ACCEL_BASE + wrng.random() * WIND_ACCEL_RANGE;
        windX = std::cos(ang) * mag;
        windY = std::sin(ang) * mag;
    }
}

void GameEngine::buildTeam(Team team, const RosterOverride& ro, const double* defHX) {
    int off = team == Team::Home ? 0 : 11;
    bool L = ro.hasLayout;
    for (int i = 0; i < 11; ++i) {
        // slot 0 forced to GK on its default line; others read the layout when present
        Role r = (L && i > 0) ? ro.roles[i] : DEF_ROLES[i];
        double hx = (L && i > 0 && ro.homeX[i] > 0.0) ? ro.homeX[i] : defHX[i];
        double hy = (L && i > 0 && ro.homeY[i] > 0.0) ? ro.homeY[i] : DEF_HY[i];
        state.players.push_back(mkPlayer(off + i, team, r, hx, hy));
        state.players.back().moraleBoost = ro.moraleBoost[i]; // 0 by default => no effect
    }
}

void GameEngine::createHomeTeam() {
    buildTeam(Team::Home, homeRoster, DEF_HX_HOME);
}

void GameEngine::createAwayTeam() {
    buildTeam(Team::Away, awayRoster, DEF_HX_AWAY);
}

// Mid-match role change (a formation shout): set the player's role and swap in a
// fresh role-AI for the new role. Same factory as the kickoff setup; the engine
// re-fetches agents[id] every tick (never caches), so the swap is safe in-tick.
void GameEngine::reassignAgent(Player& p, Role r) {
    if (p.id < 0 || p.id >= (int) agents.size()) return;
    p.role = r;
    agents[p.id] = makeAgentFor(p, *this);
}

void GameEngine::equalizeAttributes(int val) {
    attrsEqualized = true;   // Round-21 (arena audit): flag the equalized regime for the summary JSON
    for (auto& p : state.players) {
        p.attrs.speed = val;
        p.attrs.passing = val;
        p.attrs.shooting = val;
        p.attrs.tackling = val;
        p.attrs.positioning = val;
        p.attrs.creativity = val;
        p.attrs.stamina = val;
        p.attrs.handling = val; // (mkPlayer derives these from positioning; equalize must set all 9)
        p.attrs.height = val;
    }
}

void GameEngine::initBench() {
    // Reserve identities. Round-30: a reserve is now a NAMED squad player with the
    // SHAPE of the legend he is named after, put through the same elite compression
    // the starting legends get (legendAttrsFor's cz) and then a notch below —
    // instead of seven flat random rolls in bands that could hand a tiring Messi's
    // shirt to a reserve with BETTER attributes than the man he replaced. The seven
    // rng draws per reserve are kept, in the same order, and re-used as a small
    // per-attribute form jitter, so the stream POSITION is unchanged; only the
    // values move (and only once a substitution actually happens).
    struct Reserve { const char* name; PlayerAttributes attrs; };
    // {speed, passing, creativity, shooting, tackling, positioning, stamina}
    static const Reserve homeRes[8] = {
        {"Pirlo",     {58, 96, 92, 74, 50, 86, 78}},
        {"Casillas",  {56, 58, 52, 30, 42, 90, 72}},
        {"Maldini",   {74, 76, 62, 48, 92, 92, 84}},
        {"Zidane",    {72, 92, 96, 80, 58, 84, 82}},
        {"Carlos",    {88, 74, 76, 82, 70, 70, 86}},
        {"Puyol",     {72, 66, 52, 46, 92, 88, 88}},
        {"Kaka",      {86, 84, 88, 82, 44, 76, 82}},
        {"Villa",     {82, 78, 82, 88, 40, 74, 82}},
    };
    static const Reserve awayRes[8] = {
        {"Cannavaro", {74, 70, 56, 40, 90, 90, 84}},
        {"Vidic",     {68, 64, 48, 52, 92, 86, 84}},
        {"Pirlo",     {58, 96, 92, 74, 50, 86, 78}},
        {"Toure",     {76, 80, 74, 70, 84, 82, 88}},
        {"Sneijder",  {68, 90, 90, 82, 52, 80, 80}},
        {"Silva",     {70, 92, 92, 72, 46, 80, 80}},
        {"Aguero",    {86, 78, 86, 90, 38, 74, 80}},
        {"Ferdinand", {74, 74, 58, 44, 88, 90, 82}},
    };
    // Same compression legendAttrsFor applies to the starting XI, then x0.97: a
    // squad player, directly comparable to the man he comes on for.
    auto squad = [](double v) { return clamp(63.0 + (v - 63.0) * 0.28, 38.0, 80.0) * 0.97; };
    for (int t = 0; t < 2; ++t) {
        bench[t].clear();
        for (int i = 0; i < 7; ++i) {
            const Reserve& r = (t == 0) ? homeRes[i % 8] : awayRes[i % 8];
            auto roll = [&](double base) { return squad(base) * (0.96 + rng.random() * 0.08); };
            PlayerAttributes a;
            a.speed = roll(r.attrs.speed);
            a.passing = roll(r.attrs.passing);
            a.creativity = roll(r.attrs.creativity);
            a.shooting = roll(r.attrs.shooting);
            a.tackling = roll(r.attrs.tackling);
            a.positioning = roll(r.attrs.positioning);
            a.stamina = roll(r.attrs.stamina);
            // Derived, no extra draw — matches mkPlayer, and stops a substitute
            // inheriting the flat 50 defaults for the aerial duel.
            a.handling = a.positioning;
            a.height = a.positioning;
            bench[t].push_back({r.name, a, false});
        }
    }
    subsRemaining = {5, 5};
    nextSubCheckMs = 0;
    nextSubWindowMs = {0.0, 0.0};
}

void GameEngine::sendOff(Player& p) {
    // §arena: never eject the duelists — with 9 team-mates already parked,
    // every foul is a "last man" foul and the first tackle of the match drew
    // a straight red, leaving GK-vs-attacker for the remaining 9 minutes.
    // Fouls and yellows still happen; the ejection is the mode-breaking part.
    if (arenaMode) return;
    p.sentOff = true;
    stats.recordRedCard();
    // Park him off the pitch by his own touchline — the slot stays in the
    // array (lookups depend on it) but he's out of play and out of the way.
    if (state.ball.controllerId == p.id) {
        state.ball.controllerId = -1;
        state.ball.intendedReceiverId = -1;
        lastLooseOrigin = LooseOrigin::None;
    }
    parkOffPitch(p);
    p.injurySeverity = 0.0;
    assignmentByPlayer[p.id] = {};
}

void GameEngine::substituteSlot(Player& slot, BenchPlayer& in) {
    in.used = true;
    // Round-31: carry BOTH identities. A substitution has two men but the pitch has
    // one slot, and the slot is renamed below in this same tick — so the event's
    // playerId always resolves to the man ARRIVING, whichever tick a consumer reads
    // it on, and the man leaving is unrecoverable from engine state. Both names ride
    // on the event (live JSON) and in substitutionLog (summary, for .bin replays).
    char prefix = slot.team == Team::Home ? 'H' : 'A';
    std::string outName = slot.name;
    std::string inName = std::format("{}{} {}", prefix, slot.id, in.name);
    stats.recordSubstitution();
    // Hand the departing player his stat line before the slot is reset, so the
    // summary can report both men rather than crediting the arrival with both.
    substitutionLog.push_back({state.clockMs, slot.id, slot.team, outName, inName,
                               pStats[slot.id]});
    emitEvent("sub", slot.x, slot.y, slot.id, -1, /*traceOnly=*/false, /*ownGoal=*/false, outName, inName);
    slot.name = inName;
    slot.attrs = in.attrs;
    slot.stamina = 100.0; // fresh legs
    slot.injurySeverity = 0.0;
    slot.needsReplacement = false;   // the latched knock leaves with him
    slot.sentOff = false;
    resetSlotRuntime(slot.id);
    pStats[slot.id] = PlayerTally{};   // the arrival starts on zero; the starter's line rode out above
}

// Wipe every per-slot runtime record when a new man takes the slot.
//
// The engine keys per-player runtime by pitch SLOT, not by person, so anything
// left live at the whistle was silently inherited by the substitute. Only the
// yellow card was ever cleared here; measured over seeds 101-130 at 45 min,
// 48 of 137 substitutions (35%) arrived carrying something live — mostly the
// arena foul count, but also contestBlockedUntil (a fresh man who cannot
// collect the ball), containUntilMs (arrives with a raised tackle commit bar),
// secureUntilMs (settles along a direction cached from a duel he never had) and
// once a lunge dash with distance still to run, which walks him along the
// departing player's dash vector.
//
// Substitution is the ONE event that changes who a slot is, so this is the one
// place the invariant belongs: a slot's runtime describes the man standing in
// it, and a new man starts clean.
void GameEngine::resetSlotRuntime(int slotId) {
    if (slotId < 0 || slotId >= 22) return;
    runtime[slotId] = PlayerRuntime{};
}

void GameEngine::updateSubstitutions() {
    // Manager check on a coarse cadence (deterministic — clock-driven). A team
    // brings someone on for an injured player immediately, or for a spent one
    // in the closing stretch, while subs remain.
    // §arena: no bench in an exhibition — the spare slots are parked off-pitch,
    // there is nobody to legally replace, and a swap would resurrect a ghost.
    if (arenaMode) return;
    if (state.clockMs < nextSubCheckMs) return;
    // Substitutions happen at STOPPAGES, and they cost time (owner: "added
    // time... should be a real thing - so substitutions should take actual
    // time"). The swap waits for a dead ball, visibly extends the hold, and
    // credits the board the ~20s a real change burns. Round-30: the cadence
    // advance used to sit ABOVE this gate, so every open-play tick ate the 8s
    // window and a short set piece could fall clean between two checks.
    if (!setPiece.armed && !phase.kickoffPhase) return;
    nextSubCheckMs = state.clockMs + 8000.0;
    // Round-30 manager window. The old test was `p.stamina < 32 && minute > 58`:
    // 32 sits BELOW the drain floor (STAMINA_MATCH_FLOOR + staminaSkill*12 = 50-62),
    // whole-match minimum measured at 82.4 over 44 player-matches, so it was
    // unreachable — and an absolute minute-58 would never fire in a short
    // exhibition match either. Score freshness SQUAD-RELATIVE instead (this
    // commit changes no STAMINA_* constant and no physics), and scale the window
    // off matchDurationMs exactly as the added-time board already does: changes
    // open at two-thirds time and recur on a ~9-minute-at-90 cadence.
    const double subsOpenMs  = matchDurationMs * (60.0 / 90.0);
    const double subWindowMs = matchDurationMs * 0.09;
    for (int t = 0; t < 2; ++t) {
        if (subsRemaining[t] <= 0) continue;
        Team team = static_cast<Team>(t);
        bool windowOpen = state.clockMs >= subsOpenMs && state.clockMs >= nextSubWindowMs[t];
        Player* worst = nullptr;
        double worstScore = -1e9;
        bool injuredFound = false;
        for (auto& p : state.players) {
            if (p.team != team || p.role == Role::GK || p.sentOff) continue;
            if (p.id == state.ball.controllerId) continue; // never swap a man mid-carry
            // Latched: injurySeverity decays at 1/90 per second, so a 0.30 knock
            // was gone in ~11s and the old `> 0.18` test almost never saw it.
            bool injured = p.needsReplacement;
            if (!injured && !windowOpen) continue;
            double score = (injured ? 1000.0 + p.injurySeverity * 100.0 : 0.0) + (100.0 - p.stamina);
            if (score > worstScore) {
                worstScore = score;
                worst = &p;
                injuredFound = injured;
            }
        }
        if (!worst) continue;
        // Pick the freshest unused bench player.
        BenchPlayer* best = nullptr;
        double bestRating = -1.0;
        for (auto& b : bench[t]) {
            if (b.used) continue;
            double r = b.attrs.speed + b.attrs.passing + b.attrs.tackling + b.attrs.positioning;
            if (r > bestRating) {
                bestRating = r;
                best = &b;
            }
        }
        if (!best) continue;
        // A tired-but-not-injured change is the manager's call: one roll per
        // window, then the window closes either way so a side cannot empty its
        // bench at the hour. Measured: ~4 windows a side over the closing third,
        // so 0.57 lands the match at 5 changes (target band 4-6) — the rate was
        // trimmed here rather than anywhere near the fatigue model.
        if (!injuredFound) {
            nextSubWindowMs[t] = state.clockMs + subWindowMs;
            if (rng.random() > 0.57) continue;
        }
        substituteSlot(*worst, *best);
        subsRemaining[t]--;
        // The change burns real time: extend the current hold so the swap is
        // visible, and credit the board the rest of the ~20s a real sub takes.
        if (setPiece.armed) phase.actionTimer += 2500.0;
        phase.stoppageMs += 15000.0;
    }
}

void GameEngine::creditGoal(int scorerId) {
    if (scorerId < 0 || scorerId >= 22) return;
    pStats[scorerId].goals++;
    // Set-piece goal bucket: scored within 9s of a restart release. FKs are
    // split direct-threat vs deep by nothing here — the release type is enough
    // for the "where do goals come from" audit.
    if (state.clockMs - lastRestartReleaseMs < 9000.0)
        stats.recordSetPieceGoal(lastRestartReleaseType);
    else
        stats.recordOpenPlayGoal();
    // Assist: the teammate who last fed the scorer, within ~12s of the goal.
    int passer = runtime[scorerId].lastReceiveFrom;
    if (passer >= 0 && passer < 22 && passer != scorerId && state.clockMs - runtime[scorerId].lastReceiveMs < 12000.0) {
        Player* sc = playerById(scorerId);
        Player* as = playerById(passer);
        if (sc && as && sc->team == as->team) {
            pStats[passer].assists++;
            emitEvent("assist", as->x, as->y, passer, scorerId);
        }
    }
}

// Make the engine consistent with a world that was overwritten from outside
// (main.cpp's --snapshot-in path: positions, velocities, ball, clock and score
// are assigned straight onto `state`, then this runs).
//
// This used to live in main.cpp, which meant the CLI was hand-maintaining engine
// invariants across a restart boundary — every new piece of restart state was a
// silent staleness bug waiting in the snapshot path. The engine owns them now.
//
// Live-ball housekeeping: no kickoff staging, no armed restart; the carry tracker
// starts on the snapshot's controller so dwell/marathon logic measures from the
// resume rather than from a phantom past.
void GameEngine::resumeFromSnapshot() {
    // WHICH HALF. phase.half is per-half state that a resume has to DERIVE from
    // the restored clock — the snapshot format does not carry it (neither
    // --snapshot-out nor tools/snapshot_from_trace.py records it), and it
    // defaults to 1. Resuming a second-half moment therefore left the engine
    // believing it was still in the first half, so the very next tick compared
    // the restored clock against halfDurationMs, blew the half-time whistle and
    // restarted from the centre spot — destroying the situation the snapshot
    // existed to replay. (Reproduced on seed 101 @10min, snapshot at 400s: the
    // resume reported half 2, clock 607795, matchState finished, having played
    // the captured moment for zero seconds.)
    //
    // The added-time bookkeeping is per-half too and is stoppage accumulated by
    // a half this run never played, so it resets with it.
    phase.half = (state.clockMs >= halfDurationMs) ? 2 : 1;
    phase.halfTimePause = 0.0;
    phase.addedTimeActive = false;
    phase.stoppageMs = 0.0;
    phase.announcedAddedMs = 0.0;
    phase.announcedAddedMin = 0;
    phase.kickoffPhase = false;
    phase.actionTimer = 0;
    setPiece.armed = false;
    setPiece.type = SetPiece::None;
    setPiece.placeBallAtMs = 0.0;
    carrierTracker.carryTrackerId = state.ball.controllerId;
    carrierTracker.carryStartMs = state.clockMs;
    carrierTracker.carryStartX = state.ball.x;
    if (Player* rc = playerById(state.ball.controllerId))
        carrierTracker.carryStartFacing = rc->facing;
    carrierTracker.marathonReleased = false;
    // Re-mirror the ball. The OffBallOverspeed/BallTeleport tripwire measures
    // each tick's ball delta against prevBall*, which startMatch/kickoff leave at
    // the centre spot — so the snapshot's (entirely legitimate) ball placement
    // was scored as a real teleport on the first tick and the resumed run
    // permanently reported a false ball_jump. The three conditions that would
    // otherwise suppress the detector — kickoffPhase, setPiece.armed and
    // placeBallAtMs — are the ones this very method has just cleared, so the
    // mirror has to be refreshed here. (Seed 101 @10min, loose-ball snapshot at
    // 210s: ball_jump 1 before this line, 0 after; control run 0.)
    cacheBallState();
}
