// routes/world.ts — the turn engine (advanceWorldCore: one matchday for a whole world) and the
// world-scoped routes: on-demand advance + the scheduled tick, nations/internationals, the
// shared-world lobby (claim/leave/autonomy), admin world creation, and play-next. index.ts's
// auto-tick interval drives runDueTicks from here (tickInFlight, its only caller-side guard,
// stays beside that interval in index.ts). Split out of index.ts.
import type { FastifyInstance } from 'fastify';
import { db } from '../db.ts';
import { createSharedWorld, getTeamWithPlayers, standings, teamForUser, fillMissingPersonalities, overall } from '../game.ts';
import { playFixture, playCupTie, mapPool, recordReplay } from '../match.ts';
import { pendingCupRound, advanceCupRound, cupTieFor } from '../cup.ts';
import { worldLeagues, pendingMatchday, seasonComplete, rolloverSeason } from '../season.ts';
import { worldForTeam, getWorld, ensureWorldForLeague, claimAdvanceLock, releaseAdvanceLock, recordWorldAdvanced, dueSharedWorlds, listJoinableWorlds } from '../worlds.ts';
import { prepareMatchdayHeuristic, setTacticsAndXI } from '../manager/index.ts';
import { NATIONS, NATION_BY_KEY, CONFED_NAME } from '../nations.ts';
import { runInternationalTournaments, getWorldTournaments, selectNationalSquad, fieldableNations } from '../national.ts';
import { aiManagerTick, optimizeLineup } from '../ai.ts';
import { processContractOffers } from '../contracts.ts';
import { marketTick, resolveFreeAgentOffers } from '../market.ts';
import { developmentTick } from '../training.ts';
import { assembleInboxItems, matchdayHeadline, recordMatchdayInbox } from '../inbox.ts';
import { payMatchdayIncome } from '../finances.ts';
import { processMatchAftermath, tallyDivisionRatings } from '../news.ts';
import { fitnessTick } from '../fitness.ts';
import { moraleTick } from '../morale.ts';
import { requireUser, requireAdmin, requireTeam, idParam } from './shared.ts';

// Advance a matchday: play my next unplayed round across EVERY division of my world (so
// both tables move together), then run the market + training ticks for each division. If
// that completes the season, roll it over (prize money, promotion/relegation, ageing, new
// fixtures) and return the summary.
// ── Turn engine ─────────────────────────────────────────────────────────────
// advanceWorldCore plays ONE matchday for a whole world (every division) + the world-progression ticks
// (market/fitness/training/cup/rollover) + per-human aftermath/recording/inbox. It is world-scoped and
// user-agnostic, so BOTH the on-demand /api/advance (solo worlds) and the scheduled tick (shared worlds)
// drive the identical progression. It returns a per-human-team payload map so a caller can pull its own.
interface HumanTurnPayload {
  teamId: number; round: number | null; myFixtureId: number | null; myResult: any;
  transfers: any[]; injuries: any[]; incomingBids: any[]; faOffers: any[]; listingsExpired: any[];
  contractOffers: any[]; income: number; developed: number;
  cup: { round: number; champion: number | null; myTie: any } | null;
  inbox: any[]; digestHeadline: string;
}
interface WorldTurnCore {
  played: boolean; worldRound: number; season: number; results: any[]; developedWorld: number;
  rollover: any | null; cupChampion: number | null; cupRound: number | null; humans: Map<number, HumanTurnPayload>;
}

// §manager-ai: the heuristic manager runs in the pre-matchday pass (default on; FOOTY_MANAGER_AI=0 reverts
// to the old XI-only aiManagerTick). ABSENT_MS = how long a human can be away before the assistant takes over.
const MANAGER_AI_ON = process.env.FOOTY_MANAGER_AI !== '0';
const ABSENT_MS = Math.max(1, Number(process.env.FOOTY_ABSENT_HOURS) || 30) * 3600000;

// Pre-matchday manager pass: set every AI club's formation/XI/plan (+ transfers) and auto-run any ABSENT
// human's club (assistant tier = tactics + XI, never spends; or full if they opted in). A PRESENT human
// keeps their own setup. Heuristic-only (deterministic, no LLM) → replay-safe + fast at scale.
function runManagerPrePass(fixtureIds: number[]): void {
  if (!MANAGER_AI_ON || !fixtureIds.length) return;
  const nowMs = Date.now();
  const seen = new Set<number>();
  const fxRow = db.prepare('SELECT home_team_id AS h, away_team_id AS a FROM fixtures WHERE id = ?');
  const teamRow = db.prepare('SELECT t.user_id AS uid, t.autonomy AS autonomy, u.last_seen AS last_seen FROM teams t LEFT JOIN users u ON u.id = t.user_id WHERE t.id = ?');
  for (const fid of fixtureIds) {
    const fx = fxRow.get(fid) as { h: number; a: number } | undefined;
    if (!fx) continue;
    for (const tid of [fx.h, fx.a]) {
      if (seen.has(tid)) continue; seen.add(tid);
      const t = teamRow.get(tid) as { uid: number | null; autonomy: string | null; last_seen: number | null } | undefined;
      if (!t) continue;
      try {
        if (t.uid == null) {
          setTacticsAndXI(tid);   // AI club: formation/XI/plan (transfers stay with marketTick — no double-trade)
        } else if (t.last_seen != null && (nowMs - t.last_seen) > ABSENT_MS) {
          // Absent human. NULL last_seen means the user PREDATES the column (it stamps on any
          // authed request) — treating that as absent made the first post-upgrade turn overwrite
          // every existing user's saved setup. And the assistant tier must never DESTROY a saved
          // plan/formation: setTacticsAndXI persists a heuristic formation + fallback plan over
          // whatever the human set. Refresh the XI only (injury/fatigue cover) — the same
          // never-touch-a-human's-plan contract prepareWorldMatchday documents.
          if (t.autonomy === 'full') prepareMatchdayHeuristic(tid, 'full');   // full autonomy: they opted into takeover
          else optimizeLineup(tid);
        }
        // a present human keeps their own tactics/XI
      } catch { /* a manager error never blocks the matchday */ }
    }
  }
}

function humanTeamIdsInWorld(leagueIds: number[]): number[] {
  if (!leagueIds.length) return [];
  const ph = leagueIds.map(() => '?').join(',');
  return (db.prepare(`SELECT id FROM teams WHERE league_id IN (${ph}) AND user_id IS NOT NULL`).all(...leagueIds) as { id: number }[]).map(r => r.id);
}

async function advanceWorldCore(worldLeagueId: number): Promise<WorldTurnCore> {
  const leagues = worldLeagues(worldLeagueId);
  const leagueIds = leagues.map(l => l.id);
  const humanIds = humanTeamIdsInWorld(leagueIds);
  const season = (db.prepare('SELECT season FROM leagues WHERE id = ?').get(worldLeagueId) as { season: number } | undefined)?.season ?? 1;
  const worldRound = (db.prepare(`SELECT MIN(round) AS r FROM fixtures WHERE league_id IN (${leagueIds.map(() => '?').join(',')}) AND played = 0`).get(...leagueIds) as { r: number | null }).r ?? 0;
  const toPlay = pendingMatchday(worldLeagueId);
  if (!toPlay.length) return { played: false, worldRound, season, results: [], developedWorld: 0, rollover: null, cupChampion: null, cupRound: null, humans: new Map() };

  // per-human pre-play context (their division round + this round's fixture — resolved while it still exists)
  const preCtx = new Map<number, { round: number | null; fx: { id: number; home_team_id: number; away_team_id: number } | null }>();
  for (const tid of humanIds) {
    const lid = (db.prepare('SELECT league_id FROM teams WHERE id = ?').get(tid) as { league_id: number }).league_id;
    const rnd = (db.prepare('SELECT MIN(round) AS r FROM fixtures WHERE league_id = ? AND played = 0').get(lid) as { r: number | null }).r;
    const fx = rnd == null ? null : (db.prepare('SELECT id, home_team_id, away_team_id FROM fixtures WHERE league_id = ? AND round = ? AND (home_team_id = ? OR away_team_id = ?) LIMIT 1').get(lid, rnd, tid, tid) as { id: number; home_team_id: number; away_team_id: number } | undefined ?? null);
    preCtx.set(tid, { round: rnd, fx });
  }

  runManagerPrePass(toPlay);   // §manager-ai: AI clubs + absent humans get their formation/XI/plan set now
  const results = await mapPool(toPlay, id => playFixture(id));   // core-capped: the whole world's matchday
  // Ambient by design: the ratings tally is a derived season stat, not match state. The fixtures are
  // already played and persisted at this point, so a failure here loses one matchday of leaderboard
  // input — it must never abort a turn that has real results in it.
  for (const r of results) { if (r && r.players) { try { tallyDivisionRatings(r.fixtureId, r.players); } catch { /* see above */ } } }

  // per-human result + side + opponent, resolved BEFORE rollover purges the fixtures
  const snap = new Map<number, { myFixtureId: number | null; myResult: any; myHome: boolean | null; myOpponent: string }>();
  for (const tid of humanIds) {
    const fx = preCtx.get(tid)!.fx;
    const myResult = fx ? results.find(r => r.fixtureId === fx.id) ?? null : null;
    const myHome = fx ? fx.home_team_id === tid : null;
    const myOpponent = fx ? ((db.prepare('SELECT name FROM teams WHERE id = ?').get(myHome ? fx.away_team_id : fx.home_team_id) as { name: string } | undefined)?.name ?? '') : '';
    snap.set(tid, { myFixtureId: fx?.id ?? null, myResult, myHome, myOpponent });
  }

  // world-progression ticks — collect ALL events unfiltered (payloads filter per human below)
  const income: { teamId: number; amount: number }[] = [];
  const injuries: any[] = []; const transfers: any[] = []; const listingsExpired: any[] = [];
  const incomingBids: any[] = []; const faOffers: any[] = []; const contractEvents: any[] = [];
  const improvedByTeam: Record<number, number> = {}; let developedWorld = 0;
  for (const l of leagues) {
    income.push(...payMatchdayIncome(l.id));
    injuries.push(...fitnessTick(l.id)); moraleTick(l.id);
    const mkt = marketTick(l.id);
    transfers.push(...mkt.filter((e: any) => e.type === 'sign' || e.type === 'buy_listed'));
    listingsExpired.push(...mkt.filter((e: any) => e.type === 'listing_expired'));
    incomingBids.push(...mkt.filter((e: any) => e.type === 'incoming_bid'));
    faOffers.push(...resolveFreeAgentOffers(l.id));
    contractEvents.push(...processContractOffers(l.id)); aiManagerTick(l.id);
    const dt = developmentTick(l.id); developedWorld += dt.players; Object.assign(improvedByTeam, dt.improvedByTeam);
  }

  // cup (world-scoped) — round R plays once the world reaches matchday R*3 (gated on the round just played)
  let cupChampion: number | null = null; let cupRound: number | null = null;
  const pend = pendingCupRound(worldLeagueId);
  if (pend && pend.round * 3 <= worldRound) {
    await mapPool(pend.tieIds, id => playCupTie(id));
    const adv = advanceCupRound(worldLeagueId, pend.round);
    cupChampion = adv?.champion ?? null; cupRound = pend.round;
  }

  // per-human aftermath + replay recording (best-effort, BEFORE rollover so the season tally reflects the match)
  for (const tid of humanIds) {
    const s = snap.get(tid)!;
    if (s.myFixtureId != null) {
      // Ambient by design: aftermath is the flavour pass (news lines, story beats) and is deliberately
      // fire-and-forget so the advance response isn't held on it. It owns no money, table or squad state.
      void processMatchAftermath(tid, s.myFixtureId, injuries, s.myResult?.players ?? []).catch(e => console.warn(`[aftermath] team ${tid} fixture ${s.myFixtureId}:`, e));
      if (!s.myResult?.alreadyPlayed) recordReplay(s.myFixtureId);
    }
  }

  const rollover = seasonComplete(worldLeagueId) ? rolloverSeason(worldLeagueId) : null;
  if (rollover) {
    for (const tid of humanIds) void fillMissingPersonalities(tid).catch(() => { /* regens stay neutral */ });
    // §national-teams: the off-season internationals (World Cup / continental) run in the BACKGROUND —
    // the ~7-15 engine sims must not block the advance response (they'd take minutes on the real engine).
    // Results land in the tournament tables and surface on the #/internationals screen when ready.
    void runInternationalTournaments(worldLeagueId, rollover.season)
      .catch(e => console.warn(`[internationals] world ${worldLeagueId} season ${rollover.season} failed (will retry next trigger):`, e));
  }

  // build + persist each human's inbox + payload
  const humans = new Map<number, HumanTurnPayload>();
  for (const tid of humanIds) {
    const s = snap.get(tid)!; const c = preCtx.get(tid)!;
    const cup = cupRound != null ? { round: cupRound, champion: cupChampion, myTie: cupTieFor(tid, worldLeagueId, cupRound) } : null;
    const myContract = contractEvents.filter((e: any) => e.teamId === tid);
    const myIncome = income.filter(e => e.teamId === tid).reduce((sum, e) => sum + e.amount, 0);
    const myIncoming = incomingBids.filter((e: any) => e.teamId === tid);
    const myFa = faOffers.filter((e: any) => e.teamId === tid);
    const myListings = listingsExpired.filter((e: any) => e.teamId === tid);
    const bag = {
      teamId: tid, myResult: s.myResult, myFixtureId: s.myFixtureId, myHome: s.myHome, myOpponent: s.myOpponent,
      income: myIncome, developed: improvedByTeam[tid] ?? 0, injuries, transfers,
      incomingBids: myIncoming, faOffers: myFa, listingsExpired: myListings, contractOffers: myContract, cup, rollover,
    };
    const inboxItems = assembleInboxItems(bag);
    const digestHeadline = matchdayHeadline(bag);
    try { recordMatchdayInbox(tid, season, worldRound, inboxItems); } catch { /* archive is best-effort */ }
    humans.set(tid, {
      teamId: tid, round: c.round, myFixtureId: s.myFixtureId, myResult: s.myResult, transfers,
      injuries, incomingBids: myIncoming, faOffers: myFa, listingsExpired: myListings, contractOffers: myContract,
      income: myIncome, developed: improvedByTeam[tid] ?? 0, cup, inbox: inboxItems, digestHeadline,
    });
  }
  return { played: true, worldRound, season, results, developedWorld, rollover, cupChampion, cupRound, humans };
}

// The scheduler: advance every SHARED world whose cadence is due, sequentially + capped (bounds engine
// fan-out — "2/day unless there are many games"). Per-world durable lock so overlapping ticks can't
// double-advance. Solo worlds are never touched here (their owner advances them on demand).
export async function runDueTicks(now: number, max = 25): Promise<{ advanced: number[]; errors: { worldId: number; error: string }[]; due: number }> {
  const due = dueSharedWorlds(now);
  const batch = due.slice(0, Math.max(1, max));
  const advanced: number[] = []; const errors: { worldId: number; error: string }[] = [];
  for (const w of batch) {
    if (!claimAdvanceLock(w.worldId)) continue;   // another tick / an on-demand advance holds it
    try {
      const core = await advanceWorldCore(w.worldId);
      if (core.played) { recordWorldAdvanced(w.worldId, Date.now()); advanced.push(w.worldId); }
      else releaseAdvanceLock(w.worldId);   // nothing to play (rollover regenerates, so rare)
    } catch (e: any) {
      releaseAdvanceLock(w.worldId);
      errors.push({ worldId: w.worldId, error: String(e?.message ?? e) });
      console.warn(`[scheduler] world ${w.worldId} turn failed:`, e);   // errors were previously discarded silently
    }
  }
  return { advanced, errors, due: due.length };
}

export function registerWorldRoutes(app: FastifyInstance): void {
  // On-demand advance: admin may advance any world; a normal user may advance only their own SOLO world
  // (single-player turn-based). Shared worlds move ONLY on the schedule (all their humans stay in lockstep).
  app.post('/api/advance', async (req: any, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    const teamId = teamForUser(user.id);
    if (!teamId) return reply.code(404).send({ error: 'no team' });
    const worldId = worldForTeam(teamId);
    if (worldId == null) return reply.code(404).send({ error: 'no world' });
    const world = getWorld(worldId) ?? ensureWorldForLeague(worldId);
    if (!user.isAdmin && world.mode !== 'solo') return reply.code(403).send({ error: 'this world advances on a schedule' });
    if (!claimAdvanceLock(worldId)) return reply.code(409).send({ error: 'a matchday is already in progress' });
    try {
      const core = await advanceWorldCore(worldId);
      if (!core.played) return reply.code(404).send({ error: 'season complete' });
      recordWorldAdvanced(worldId, Date.now());
      const me = core.humans.get(teamId);
      const nowLeagueId = getTeamWithPlayers(teamId)!.leagueId;
      if (!me) return { round: core.worldRound, results: core.results, rollover: core.rollover, inbox: [], digestHeadline: '', standings: standings(nowLeagueId) };
      return {
        round: me.round, myFixtureId: me.myFixtureId, myResult: me.myResult, results: core.results,
        transfers: me.transfers, development: { players: core.developedWorld }, injuries: me.injuries, cup: me.cup, rollover: core.rollover,
        contractOffers: me.contractOffers, listingsExpired: me.listingsExpired, incomingBids: me.incomingBids, faOffers: me.faOffers,
        income: me.income, inbox: me.inbox, digestHeadline: me.digestHeadline, standings: standings(nowLeagueId),
      };
    } finally { releaseAdvanceLock(worldId); }
  });

  // The scheduled tick (admin/cron): advance all due shared worlds. Drive it from an external cron, the
  // CCR trigger, or set FOOTY_AUTO_TICK_MIN to have the server self-schedule (see the boot hook).
  app.post('/api/tick', async (req: any, reply) => {
    const user = requireAdmin(req, reply); if (!user) return;
    const max = Math.min(500, Math.max(1, Number((req.query as any)?.max) || 25));
    return await runDueTicks(Date.now(), max);
  });

  // §national-teams: the fixed nation registry (key → name/flag/confederation). Fetched once by the UI to
  // render flags in player bios/squads + group tournaments by confederation.
  app.get('/api/nations', async () => {
    return { nations: NATIONS.map(n => ({ key: n.key, name: n.name, flag: n.flag, confed: n.confed })), confeds: CONFED_NAME };
  });

  // §national-teams: this world's international tournaments (World Cup / continental) + their brackets, and
  // the nations that can currently field a squad (with strength). Scoped to the caller's world.
  app.get('/api/tournaments', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const wid = worldForTeam(teamId);
    if (wid == null) return reply.code(404).send({ error: 'no world' });
    return { tournaments: getWorldTournaments(wid), fieldable: fieldableNations(wid).sort((a, b) => b.strength - a.strength) };
  });

  // §national-teams: a nation's current best XI in the caller's world.
  app.get('/api/nation/:key/squad', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const wid = worldForTeam(teamId);
    if (wid == null) return reply.code(404).send({ error: 'no world' });
    // An UNKNOWN key used to 200 with an empty squad — indistinguishable from a real nation that
    // simply can't field an XI in this world, so a typo'd/stale link showed "no players" forever.
    // Validate against the fixed registry (the same list GET /api/nations serves) and 404 instead.
    const key = String(req.params?.key ?? '');
    if (!NATION_BY_KEY.has(key)) return reply.code(404).send({ error: 'no such nation' });
    const xi = selectNationalSquad(wid, key);
    return { squad: (xi ?? []).map(p => ({ name: p.name, role: p.role, overall: overall(p.attrs, p.role) })) };
  });

  // §national-teams: admin — run this world's internationals now (testing; normally fires at rollover).
  app.post('/api/admin/run-internationals', async (req: any, reply) => {
    const user = requireAdmin(req, reply); if (!user) return;
    const wid = idParam(reply, req.body?.worldId, 'worldId'); if (wid == null) return;
    const season = idParam(reply, req.body?.season, 'season'); if (season == null) return;
    const held = await runInternationalTournaments(wid, season);
    return { ok: true, held };
  });

  // §autonomous: the lobby — shared worlds a player can join, with their unclaimed-team counts.
  app.get('/api/worlds', async (req: any, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    // hasTeam must mean an ACTIVE club: teamForUser also returns a sacked one, which hid every
    // Claim button from exactly the users the claim endpoint's sacked-exception is written for.
    const activeTeam = (db.prepare('SELECT id FROM teams WHERE user_id = ? AND sacked = 0 ORDER BY id DESC LIMIT 1').get(user.id) as { id: number } | undefined)?.id ?? null;
    return { worlds: listJoinableWorlds(), hasTeam: activeTeam != null };
  });

  // §autonomous: the teams in a shared world (claimable = unclaimed AI seats), with OVR + division.
  app.get('/api/worlds/:id/teams', async (req: any, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    const worldId = idParam(reply, req.params?.id, 'world id'); if (worldId == null) return;
    // Shared worlds only: without this gate any logged-in user could enumerate every club,
    // manager name and squad strength of every OTHER user's private solo world by iterating ids.
    const w = getWorld(worldId);
    if (!w || w.mode !== 'shared') return reply.code(404).send({ error: 'no such world' });
    const leagues = worldLeagues(worldId);
    if (!leagues.length) return reply.code(404).send({ error: 'no such world' });
    const ph = leagues.map(() => '?').join(',');
    const rows = db.prepare(`SELECT t.id, t.name, t.user_id, t.manager, l.tier, l.name AS division
      FROM teams t JOIN leagues l ON l.id = t.league_id WHERE t.league_id IN (${ph}) ORDER BY l.tier, t.name`).all(...leagues.map(l => l.id)) as { id: number; name: string; user_id: number | null; manager: string; tier: number; division: string }[];
    // One query for every squad (was one per team — the hottest new endpoint doing N+1).
    const attrsByTeam = new Map<number, number[]>();
    if (rows.length) {
      const tph = rows.map(() => '?').join(',');
      for (const pr of db.prepare(`SELECT team_id, attrs FROM players WHERE team_id IN (${tph})`).all(...rows.map(t => t.id)) as { team_id: number; attrs: string }[]) {
        const arr = attrsByTeam.get(pr.team_id) ?? [];
        arr.push(overall(JSON.parse(pr.attrs)));
        attrsByTeam.set(pr.team_id, arr);
      }
    }
    const teams = rows.map(t => {
      const ovrs = attrsByTeam.get(t.id) ?? [];
      const ovr = ovrs.length ? Math.round(ovrs.sort((x, y) => y - x).slice(0, 11).reduce((s2, v) => s2 + v, 0) / Math.min(11, ovrs.length)) : 0;
      return { teamId: t.id, name: t.name, tier: t.tier, division: t.division, overall: ovr, claimed: t.user_id != null, manager: t.user_id != null ? t.manager : 'AI' };
    });
    return { teams };
  });

  // §autonomous: claim an unclaimed team in a shared world (transactional, race-safe). You must not
  // already manage a (non-sacked) club — one active team per user (the locked decision).
  app.post('/api/worlds/:id/claim', async (req: any, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    const worldId = idParam(reply, req.params?.id, 'world id'); if (worldId == null) return;
    const teamId = idParam(reply, req.body?.teamId, 'teamId'); if (teamId == null) return;
    const existing = teamForUser(user.id);
    if (existing != null && !((db.prepare('SELECT sacked FROM teams WHERE id = ?').get(existing) as { sacked: number } | undefined)?.sacked)) {
      return reply.code(409).send({ error: 'you already manage a club — leave it first' });
    }
    const w = getWorld(worldId);
    if (!w || w.mode !== 'shared') return reply.code(404).send({ error: 'not a joinable world' });
    if (!w.joinOpen) return reply.code(403).send({ error: 'this world is not accepting new managers' });
    const leagueIds = worldLeagues(worldId).map(l => l.id);
    const ph = leagueIds.map(() => '?').join(',');
    // atomic claim: only succeeds if the seat is still unclaimed and in this world
    const res = db.prepare(`UPDATE teams SET user_id = ?, manager = ?, sacked = 0 WHERE id = ? AND user_id IS NULL AND league_id IN (${ph})`).run(user.id, user.username, teamId, ...leagueIds);
    if (res.changes === 0) return reply.code(409).send({ error: 'that team was just taken — pick another' });
    // Release the user's PREVIOUS club (the sacked one that made this claim legal): leaving its
    // user_id set meant teamForUser (ORDER BY id DESC) could keep resolving to the dead club, so
    // every team-scoped endpoint served the old save and the claim looked like a no-op.
    db.prepare("UPDATE teams SET user_id = NULL, manager = 'AI' WHERE user_id = ? AND id <> ?").run(user.id, teamId);
    // backfill the squad's personalities/nationalities in the background (they were seeded blank for AI)
    void fillMissingPersonalities(teamId).catch(() => { /* stays neutral on failure */ });
    const nowLeagueId = getTeamWithPlayers(teamId)!.leagueId;
    return { ok: true, teamId, standings: standings(nowLeagueId) };
  });

  // §autonomous: leave your club — it returns to AI control and its seat re-opens for another player.
  app.post('/api/worlds/leave', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const wid = worldForTeam(teamId);
    const w = wid != null ? getWorld(wid) : null;
    if (!w || w.mode !== 'shared') return reply.code(400).send({ error: 'you can only leave a shared world' });
    db.prepare("UPDATE teams SET user_id = NULL, manager = 'AI', sacked = 0 WHERE id = ?").run(teamId);
    return { ok: true };
  });

  // §autonomous: opt into full autonomy (the assistant also makes transfers while you're away) or back to
  // the default 'assistant' tier (tactics + XI only, never spends). Read on the team payload.
  app.post('/api/autonomy', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const mode = req.body?.mode === 'full' ? 'full' : 'assistant';
    db.prepare('UPDATE teams SET autonomy = ? WHERE id = ?').run(mode, teamId);
    return { ok: true, autonomy: mode };
  });

  // §autonomous: admin — spin up a fresh shared (autonomous) world of all-AI clubs open for claims.
  app.post('/api/admin/world', async (req: any, reply) => {
    const user = requireAdmin(req, reply); if (!user) return;
    const name = (typeof req.body?.name === 'string' && req.body.name.trim()) ? req.body.name.trim().slice(0, 60) : `Shared World ${Date.now()}`;
    const { worldId } = createSharedWorld(name);
    return { ok: true, worldId, name };
  });

  // Convenience: play my next unplayed fixture.
  app.post('/api/play-next', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const team = getTeamWithPlayers(teamId)!;
    const fx = db.prepare(
      `SELECT id FROM fixtures WHERE league_id = ? AND played = 0
         AND (home_team_id = ? OR away_team_id = ?) ORDER BY round, id LIMIT 1`,
    ).get(team.leagueId, teamId, teamId) as { id: number } | undefined;
    if (!fx) return reply.code(404).send({ error: 'no upcoming fixture' });
    const result = await playFixture(fx.id);
    return { fixtureId: fx.id, result, standings: standings(team.leagueId) };
  });
}
