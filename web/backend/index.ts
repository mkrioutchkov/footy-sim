import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fstatic from '@fastify/static';
import { WebSocketServer } from 'ws';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { registerUser, loginUser, createSession, destroySession, getUserBySession, seedAdminUser, type User } from './auth.ts';
import { db } from './db.ts';
import {
  newSeasonForUser, createSharedWorld, getTeamWithPlayers, standings, teamForUser,
  assignPersonalities, needsPersonalities, fillMissingPersonalities, backfillFreeAgents, backfillPotentials, backfillContracts,
  playerValue, overall, DEFAULT_TACTICS, type Tactics,
} from './game.ts';
import { deriveTraits, defaultPersonality, type Personality } from './personality.ts';
import { playFixture, playCupTie, getFixture, writeSpec, MatchStream, ReplayStream, EventsReplayStream, recordingFor, loadRecording, hasHumanStake, recordReplay, mapPool, loadEventsLog, tacticsReview, weatherForSeed } from './match.ts';
import { joinLiveMatch, liveKey, type Seat } from './coordinator.ts';
import { cupTieWinnerId, pendingCupRound, advanceCupRound, cupView, cupTieFor } from './cup.ts';
import { compileLineup } from './lineup.ts';
import { FORMATIONS, PITCH_W, roleFit } from './formations.ts';
import { getMarket, buyFreeAgent, listPlayer, unlistPlayer, marketTick, bidForPlayer, loanIn, loanOut, endLoan, offersForTeam, withdrawOffer, matchCounter, aiListSurplus, incomingOffersForTeam, acceptIncomingOffer, rejectIncomingOffer, offerToFreeAgent, freeAgentOffersForTeam, resolveFreeAgentOffers, seedReleaseClauses, searchPlayers } from './market.ts';
import { compileInitialPlan, QUICK_TACTICS, buildQuickPlan, type QuickTactic } from './plan.ts';
import { sanitizeStructuredDirectives } from './tactics.ts';
import { developmentTick, setTrainingFocus, setPlayerTrainingFocus, setPlayerTrainingIntensity, setTeamTrainingIntensity, applyTrainingPreset, TRAINING_PRESETS, setPlayerRetrain, RETRAIN_ROLES, getTrainingReport, getAttrProgression, TRAINABLE, VALID_FOCUS, VALID_INTENSITY, VALID_TEAM_INTENSITY } from './training.ts';
import { getRotationView, applyRotation } from './rotation.ts';
import { seedAcademy, getAcademy, promoteProspect } from './youth.ts';
import { TALK_TONES, isTalkTone, setTeamTalk, pendingTalk, previewTalk } from './teamtalk.ts';
import { worldLeagues, pendingMatchday, seasonComplete, rolloverSeason, worldStandings, PROMOTE } from './season.ts';
import { worldForTeam, getWorld, ensureWorldForLeague, claimAdvanceLock, releaseAdvanceLock, recordWorldAdvanced, dueSharedWorlds, listJoinableWorlds } from './worlds.ts';
import { prepareMatchdayHeuristic, setTacticsAndXI } from './manager/index.ts';
import { NATIONS, CONFED_NAME, backfillNationalities } from './nations.ts';
import { runInternationalTournaments, getWorldTournaments, selectNationalSquad, fieldableNations } from './national.ts';
import { fastSimEnabled } from './fastsim.ts';
import { aiManagerTick, optimizeLineup } from './ai.ts';
import { previewRenewal, proposeRenewal, processContractOffers, contractOffersForTeam, matchContractCounter, withdrawContractOffer } from './contracts.ts';
import { applyPressResponse, generatePressQuestion, pressAvailable, recordPress } from './press.ts';
import { interactWithPlayer, isInteractTone } from './interaction.ts';
import { leagueLeaders } from './leaders.ts';
import { getShortlist, shortlistIds, toggleShortlist } from './shortlist.ts';
import { getConcerns, resolveConcern, type ConcernAction } from './concerns.ts';
import { getBoardMeeting, requestBoardBacking, type BoardRequestKind } from './board.ts';
import { getManagerCareer, managerReputation } from './career.ts';
import { buildMatchReport } from './report.ts';
import { buildScoutReport } from './scout.ts';
import { getHistory, getClubRecords, getPlayerCareer } from './history.ts';
import { assembleInboxItems, matchdayHeadline, recordMatchdayInbox, getInbox, countUnread, markInboxRead } from './inbox.ts';
import { getObjective } from './objectives.ts';
import { getConfidence, boardMood, recruitmentBacking, boardMessages } from './confidence.ts';
import { getStaffView, hireStaff, fireStaff, saveCoachAssignment } from './staff.ts';
import { getFinances, payMatchdayIncome } from './finances.ts';
import { getSquadHarmony } from './harmony.ts';
import { processMatchAftermath, recentNews, tallyDivisionRatings } from './news.ts';
import { fitnessTick } from './fitness.ts';
import { moraleTick } from './morale.ts';

const PORT = Number.parseInt(process.env.FOOTY_PORT ?? '4000', 10);
// Give any pre-market league a free-agent pool + every player a potential (one-time,
// idempotent backfills for saves that predate pillars 1 & 2).
backfillFreeAgents();
backfillPotentials();
backfillContracts();
backfillNationalities();   // §national-teams: every player/free-agent gets a fixed-list nation + flag
const app = Fastify({ logger: false });
await app.register(cookie);

const DIST = path.resolve(process.cwd(), 'dist');
if (existsSync(DIST)) {
  await app.register(fstatic, { root: DIST });
}

// ── auth helpers ──
function currentUser(req: any): User | null {
  return getUserBySession(req.cookies?.sid);
}
function setSession(reply: any, userId: number): void {
  const sid = createSession(userId);
  reply.setCookie('sid', sid, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 30 });
}
const lastSeenStamp = new Map<number, number>();   // throttle the last_seen write to ≤1/min per user
function requireUser(req: any, reply: any): User | null {
  const u = currentUser(req);
  if (!u) { reply.code(401).send({ error: 'not logged in' }); return null; }
  // §autonomous: record activity so the assistant manager knows when a human is present vs away.
  const now = Date.now();
  if ((lastSeenStamp.get(u.id) ?? 0) < now - 60000) {
    lastSeenStamp.set(u.id, now);
    try { db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(now, u.id); } catch { /* non-fatal */ }
  }
  return u;
}
// Admin-only gate. A non-admin (or logged-out) caller can NEVER pass — the endpoint 404s to
// logged-out and 403s to normal users, so /api/advance is unreachable to a normal user even if
// they hand-craft the request. The frontend also hides the button, but THIS is the real guard.
function requireAdmin(req: any, reply: any): User | null {
  const u = requireUser(req, reply);
  if (!u) return null;
  if (!u.isAdmin) { reply.code(403).send({ error: 'admin only' }); return null; }
  return u;
}
function validTactics(t: any): Tactics {
  const clamp = (v: any) => Math.max(0, Math.min(100, Number.isFinite(+v) ? Math.round(+v) : 50));
  return {
    aggression: clamp(t?.aggression), passingDirectness: clamp(t?.passingDirectness),
    overlapFrequency: clamp(t?.overlapFrequency), midfieldFreedom: clamp(t?.midfieldFreedom),
    defensiveLineHeight: clamp(t?.defensiveLineHeight),
  };
}

// ── auth routes ──
app.post('/api/register', async (req: any, reply) => {
  const { username, password } = req.body ?? {};
  if (!username || !password || String(username).length < 2 || String(password).length < 4)
    return reply.code(400).send({ error: 'username (2+) and password (4+) required' });
  try {
    const user = registerUser(String(username).trim().slice(0, 32), String(password));
    setSession(reply, user.id);
    return { user };
  } catch { return reply.code(409).send({ error: 'username taken' }); }
});

app.post('/api/login', async (req: any, reply) => {
  const { username, password } = req.body ?? {};
  const user = loginUser(String(username ?? '').trim(), String(password ?? ''));
  if (!user) return reply.code(401).send({ error: 'invalid credentials' });
  setSession(reply, user.id);
  return { user };
});

app.post('/api/logout', async (req: any, reply) => {
  destroySession(req.cookies?.sid);
  reply.clearCookie('sid', { path: '/' });
  return { ok: true };
});

app.get('/api/me', async (req: any) => {
  const user = currentUser(req);
  if (!user) return { user: null };
  return { user, teamId: teamForUser(user.id) };
});

// ── team / league ──
app.post('/api/team', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  // §2.5: a sacked manager may start a new career (a fresh team supersedes the old, since
  // teamForUser returns the newest); otherwise you can't create a second team.
  const existing = teamForUser(user.id);
  if (existing && !(db.prepare('SELECT sacked FROM teams WHERE id = ?').get(existing) as { sacked: number } | undefined)?.sacked) {
    return reply.code(409).send({ error: 'you already have a team' });
  }
  const name = String(req.body?.name ?? '').trim().slice(0, 40) || `${user.username} FC`;
  const tactics = req.body?.tactics ? validTactics(req.body.tactics) : DEFAULT_TACTICS;
  const { teamId, leagueId, worldId } = newSeasonForUser(user.id, user.username, name, tactics);
  // §P2: stock the for-sale market for the opening summer window (both divisions) so a brand-new
  // manager sees AI clubs offering players to bid on, not an empty board.
  for (const lid of new Set([leagueId, worldId])) aiListSurplus(lid);
  seedReleaseClauses([leagueId, worldId]);   // §release-clause: AI clubs' stars get a clause from day one
  seedAcademy(teamId);   // §2.9: a starting crop of youth prospects in the academy
  // Generate the squad's personalities in the background (best-effort, ~3s) so team
  // creation returns immediately; the dashboard backfills via /api/personalities.
  void assignPersonalities(teamId).catch(() => { /* defaults already stored on failure */ });
  return { teamId, leagueId };
});

// Generate personalities for the user's squad if any are missing (backfills teams
// created before this feature, and resolves the post-creation race). Returns the team.
app.post('/api/personalities', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  if (needsPersonalities(teamId)) await assignPersonalities(teamId);
  return getTeamWithPlayers(teamId);
});

app.get('/api/team', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team yet' });
  return getTeamWithPlayers(teamId);
});

// §2.11: name the club captain (a squad slot) — a strong leader steadies squad morale each matchday.
// slot null/-1 clears it (back to auto: the highest-leadership player wears the armband).
app.put('/api/captain', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const raw = req.body?.slot;
  if (raw == null || Number(raw) === -1) { db.prepare('UPDATE teams SET captain_slot = NULL WHERE id = ?').run(teamId); return { ok: true, captainSlot: null }; }
  const slot = Number(raw);
  if (!Number.isInteger(slot)) return reply.code(400).send({ error: 'bad slot' });
  if (!db.prepare('SELECT 1 FROM players WHERE team_id = ? AND slot = ?').get(teamId, slot)) return reply.code(404).send({ error: 'no such player in your squad' });
  db.prepare('UPDATE teams SET captain_slot = ? WHERE id = ?').run(slot, teamId);
  return { ok: true, captainSlot: slot };
});

// Set-piece takers (user-watch): designate FK / corner / penalty / long-throw takers (squad slots; null =
// the engine's default). Validated against the squad; emitted as per-player directives the engine reads at
// the restart. getTeamWithPlayers returns the current selection (team.setPieceTakers), so no GET needed.
app.post('/api/set-piece-takers', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const slots = new Set((db.prepare('SELECT slot FROM players WHERE team_id = ?').all(teamId) as { slot: number }[]).map(r => r.slot));
  const pick = (v: unknown): number | null => { const n = Number(v); return v != null && Number.isInteger(n) && slots.has(n) ? n : null; };
  const takers = { fk: pick(req.body?.fk), corner: pick(req.body?.corner), pen: pick(req.body?.pen), longThrow: pick(req.body?.longThrow) };
  const allDefault = takers.fk == null && takers.corner == null && takers.pen == null && takers.longThrow == null;
  db.prepare('UPDATE teams SET set_piece_takers = ? WHERE id = ?').run(allDefault ? null : JSON.stringify(takers), teamId);
  return { ok: true, setPieceTakers: allDefault ? null : takers };
});

// §2.13: the pre-match team talk — preview how a tone lands across the squad + lock one in for an
// upcoming fixture (its per-player morale deltas ride into the match spec as moraleBoost).
function ownUnplayedFixture(teamId: number, fixtureId: number): { ok: true } | { ok: false; code: number; error: string } {
  if (!Number.isInteger(fixtureId)) return { ok: false, code: 400, error: 'fixture required' };
  const fx = db.prepare('SELECT home_team_id, away_team_id, played FROM fixtures WHERE id = ?').get(fixtureId) as { home_team_id: number; away_team_id: number; played: number } | undefined;
  if (!fx || (fx.home_team_id !== teamId && fx.away_team_id !== teamId)) return { ok: false, code: 404, error: 'not your fixture' };
  if (fx.played) return { ok: false, code: 400, error: 'that match has already been played' };
  return { ok: true };
}
app.get('/api/teamtalk', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const fixtureId = Number(req.query?.fixture);
  const chk = ownUnplayedFixture(teamId, fixtureId);
  if (!chk.ok) return reply.code(chk.code).send({ error: chk.error });
  const pending = pendingTalk(teamId, fixtureId);
  const tone = isTalkTone(req.query?.tone) ? req.query.tone : (pending?.tone ?? 'believe');
  return { tones: TALK_TONES, pending, tone, reactions: previewTalk(teamId, tone) };
});
app.post('/api/teamtalk', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const fixtureId = Number(req.body?.fixtureId);
  const chk = ownUnplayedFixture(teamId, fixtureId);
  if (!chk.ok) return reply.code(chk.code).send({ error: chk.error });
  if (!isTalkTone(req.body?.tone)) return reply.code(400).send({ error: 'unknown tone' });
  return setTeamTalk(teamId, fixtureId, req.body.tone);
});

// §2.9: the youth academy — the club's developing prospects + promote one to the senior squad.
app.get('/api/academy', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  return { prospects: getAcademy(teamId) };
});
app.post('/api/academy/:id/promote', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const r = promoteProspect(teamId, Number(req.params.id));
  if (!r.ok) return reply.code(400).send({ error: r.error });
  return { ...r, prospects: getAcademy(teamId) };
});

// Set the club's plain-English STANDING tactical plan: compile it to directives (team-relative
// ids) and persist both the text + the compiled plan. Empty text clears the plan. Graceful — if
// the compiler is unreachable, the text is saved with no directives + a note (plays the neutral base).
app.post('/api/team/plan', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const text = String(req.body?.text ?? '').trim().slice(0, 600);
  const t = getTeamWithPlayers(teamId)!;
  // team-relative XI: the first 11 by slot, id = 0..10 (resolved to engine ids at spec-build time)
  const squad = t.players.slice(0, 11).map((p, i) => ({ id: i, name: p.name, role: p.role, personality: p.personality as { traits?: Record<string, number> } | null }));
  const r = await compileInitialPlan(text, squad);
  const plan = { summary: r.plan.summary, directives: r.plan.directives };
  db.prepare('UPDATE teams SET plan_text = ?, plan_directives = ? WHERE id = ?')
    .run(text || null, text ? JSON.stringify(plan) : null, teamId);
  // §3 (takers-via-prompt): if the plain-English plan named dead-ball takers, MERGE them into the same
  // persistent store the dropdown writes (only the roles named; the rest stay). One prompt assigns takers
  // too — the dropdown remains the discoverable explicit path.
  let setPieceTakers = t.setPieceTakers ?? null;
  if (r.setPieceTakers && Object.keys(r.setPieceTakers).length) {
    const merged = { fk: null, corner: null, pen: null, longThrow: null, ...(t.setPieceTakers ?? {}), ...r.setPieceTakers };
    const allDefault = merged.fk == null && merged.corner == null && merged.pen == null && merged.longThrow == null;
    db.prepare('UPDATE teams SET set_piece_takers = ? WHERE id = ?').run(allDefault ? null : JSON.stringify(merged), teamId);
    setPieceTakers = allDefault ? null : merged;
  }
  return { planText: text, plan, setPieceTakers, note: r.note || '', error: r.error || null };
});

// §2 quick-tactics: one-tap team mentality (deterministic, no LLM) — sets a coherent plan_text + team-wide
// directives in one write. Replaces the standing plan with the chosen stance (the user refines via the prompt).
app.post('/api/team/quick-tactics', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const preset = String(req.body?.preset ?? '');
  if (!(preset in QUICK_TACTICS)) return reply.code(400).send({ error: 'unknown preset' });
  const plan = buildQuickPlan(preset as QuickTactic, 0);   // team-relative scope; resolved to engine ids at spec-build
  const text = QUICK_TACTICS[preset as QuickTactic].text;
  db.prepare('UPDATE teams SET plan_text = ?, plan_directives = ? WHERE id = ?')
    .run(text, plan.directives.length ? JSON.stringify(plan) : null, teamId);
  return { planText: text, plan };
});

app.put('/api/tactics', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const tactics = validTactics(req.body?.tactics);
  db.prepare('UPDATE teams SET tactics = ? WHERE id = ?').run(JSON.stringify(tactics), teamId);
  return { tactics };
});

// Set the team's formation / XI from a free-text instruction ("play 4-4-2",
// "AB at left back"). Compiles via the LLM lineup compiler, persists the shape +
// XI on the team (so every match that team plays uses it), and returns the
// resolved XI + note. Storing the default 4-3-3 identity as NULL keeps the
// byte-identical spec path for un-customised teams.
app.put('/api/lineup', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const text = String(req.body?.text ?? '').trim();
  if (!text) return reply.code(400).send({ error: 'say how you want to line up' });
  const team = getTeamWithPlayers(teamId)!;
  const squad = { players: team.players.slice().sort((a, b) => a.slot - b.slot).map(p => ({ name: p.name, role: p.role, attrs: p.attrs })) };
  const r = await compileLineup(text, squad);
  if (r.error) return reply.code(503).send({ error: r.error });
  if (!r.slots.length) return { formation: team.formation, lineup: team.lineup, slots: [], note: r.note || 'No change made.' };
  const lineup = r.slots.map(s => s.fromSlot);
  const isDefault = r.formation === '4-3-3' && lineup.every((v, i) => v === i);
  db.prepare('UPDATE teams SET formation = ?, lineup = ? WHERE id = ?')
    .run(r.formation, isDefault ? null : JSON.stringify(lineup), teamId);
  return { formation: r.formation, lineup: isDefault ? null : lineup, slots: r.slots, note: r.note };
});

// Strongest role-correct XI for a shape — the role-fit model the lineup compiler uses (best fit per
// slot; injured players deprioritised; the keeper anchored to slot 0). Shared by /lineup/auto (current
// shape) and /lineup/set (a shape chosen from the tactics board), so both stay byte-identical.
function strongestXI(players: { slot: number; role: string; attrs: Record<string, number>; injuredMatches?: number }[], formation: string): number[] {
  const slots = FORMATIONS[formation] ?? FORMATIONS['4-3-3'];
  const used = new Set<number>();
  const lineup: number[] = [];
  for (let i = 0; i < slots.length; i++) {
    const role = slots[i].role;   // roleFit understands DM/AM weights directly — do NOT collapse to CM here
    const score = (p: typeof players[number]) => roleFit(p.attrs, role) + ((p.injuredMatches ?? 0) > 0 ? -1000 : 0) + (i === 0 && p.role === 'GK' ? 500 : 0);
    const cand = players.filter(p => !used.has(p.slot));
    const pick = cand.reduce((best, p) => (score(p) > score(best) ? p : best), cand[0]);
    used.add(pick.slot); lineup.push(pick.slot);
  }
  return lineup;
}

// §auto-XI: field the strongest role-correct XI for the CURRENT formation.
app.post('/api/lineup/auto', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const team = getTeamWithPlayers(teamId)!;
  const formation = team.formation ?? '4-3-3';
  const players = team.players.slice().sort((a, b) => a.slot - b.slot);
  if (players.length < 11) return reply.code(400).send({ error: 'not enough players for an XI' });
  const lineup = strongestXI(players, formation);
  const isDefault = formation === '4-3-3' && lineup.every((v, i) => v === i);
  db.prepare('UPDATE teams SET lineup = ? WHERE id = ?').run(isDefault ? null : JSON.stringify(lineup), teamId);
  return { formation, lineup: isDefault ? null : lineup, note: `Fielded your strongest XI in a ${formation}.` };
});

// DETERMINISTIC formation + XI from the tactics board (no LLM) — the structured sibling of PUT /api/lineup.
// Body: { formation: <registry key>, lineup?: number[11] } (formation-slot order -> squad slot). An omitted
// or invalid lineup falls back to the strongest role-fit XI for that shape. Keeps the byte-identical guard
// (default 4-3-3 identity persists as NULL). No opponent, no LLM latency — a shape/slot change is instant.
app.post('/api/lineup/set', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const formation = String(req.body?.formation ?? '');
  if (!FORMATIONS[formation]) return reply.code(400).send({ error: 'unknown formation' });
  const team = getTeamWithPlayers(teamId)!;
  const players = team.players.slice().sort((a, b) => a.slot - b.slot);
  if (players.length < 11) return reply.code(400).send({ error: 'not enough players for an XI' });
  let lineup: number[];
  const given = req.body?.lineup;
  if (Array.isArray(given) && given.length === 11) {
    const nums = given.map(Number);
    // accept only a clean 11-permutation of real squad indices (mirrors getTeamWithPlayers' guard) — a
    // malformed map could otherwise duplicate or drop a player in the spec.
    if (!(nums.every((n: number) => Number.isInteger(n) && n >= 0 && n < players.length) && new Set(nums).size === 11))
      return reply.code(400).send({ error: 'invalid lineup' });
    lineup = nums;
  } else {
    lineup = strongestXI(players, formation);
  }
  const isDefault = formation === '4-3-3' && lineup.every((v, i) => v === i);
  db.prepare('UPDATE teams SET formation = ?, lineup = ? WHERE id = ?').run(formation, isDefault ? null : JSON.stringify(lineup), teamId);
  return { formation, lineup: isDefault ? null : lineup, note: `Set up in a ${formation}.` };
});

// DETERMINISTIC structured tactics from the board (sliders/menus) — the no-LLM sibling of POST /api/team/plan.
// Body: { directives: Directive[] (team-relative XI ids 0-10, teamScope 0), summary?: string }. Sanitised
// against VALID_KINDS (man_mark dropped — live-only), then persisted to plan_directives exactly like the
// text/quick paths, so spec-build + the engine consume it unchanged. No opponent, no LLM.
app.post('/api/team/plan-structured', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const directives = sanitizeStructuredDirectives(req.body?.directives, 0);   // team-relative (home scope 0); resolved at spec-build
  const summary = (String(req.body?.summary ?? '').trim().slice(0, 280)) || (directives.length ? 'Tactics set from the tactics board.' : 'No special team instructions.');
  const plan = { summary, directives };
  db.prepare('UPDATE teams SET plan_text = ?, plan_directives = ? WHERE id = ?')
    .run(directives.length ? summary : null, directives.length ? JSON.stringify(plan) : null, teamId);
  return { planText: directives.length ? summary : '', plan };
});

// The formation registry (per-slot role + pitch coordinates) for the visual tactics pitch.
app.get('/api/formations', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  return { pitchW: PITCH_W, pitchH: 680, formations: FORMATIONS };
});

// ── transfer market (pillar 1) ──
app.get('/api/market', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const market = getMarket(teamId);
  if (!market) return reply.code(404).send({ error: 'no team' });
  // how the board frames recruitment (confidence + objective) — pure framing, never a budget change
  const conf = getConfidence(teamId), obj = getObjective(teamId);
  return { ...market, backing: conf ? recruitmentBacking(conf.status, obj?.kind ?? null) : null };
});

app.post('/api/market/buy', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const agentId = Number(req.body?.agentId);
  if (!Number.isInteger(agentId)) return reply.code(400).send({ error: 'agentId required' });
  const r = buyFreeAgent(teamId, agentId);
  if (!r.ok) return reply.code(400).send({ error: r.error });
  return { ...r, market: getMarket(teamId) };
});

app.post('/api/market/list', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const slot = Number(req.body?.slot);
  if (!Number.isInteger(slot)) return reply.code(400).send({ error: 'slot required' });
  const price = req.body?.price != null ? Number(req.body.price) : undefined;
  const r = listPlayer(teamId, slot, price);
  if (!r.ok) return reply.code(400).send({ error: r.error });
  return { ...r, market: getMarket(teamId) };
});

app.post('/api/market/unlist', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const slot = Number(req.body?.slot);
  if (!Number.isInteger(slot)) return reply.code(400).send({ error: 'slot required' });
  unlistPlayer(teamId, slot);
  return { ok: true, market: getMarket(teamId) };
});

// Bid for another club's player (club-to-club, window-gated, with negotiation). A rejection /
// counter is a normal outcome (200 + status), only a malformed/illegal bid is a 4xx.
app.post('/api/transfer/bid', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const playerId = Number(req.body?.playerId), fee = Number(req.body?.fee);
  if (!Number.isInteger(playerId)) return reply.code(400).send({ error: 'playerId required' });
  const r = bidForPlayer(teamId, playerId, fee);
  if (r.status === 'error') return reply.code(400).send({ error: r.error });
  return { ...r, market: getMarket(teamId) };
});

// Loan in another club's player for the season (no fee, window-gated).
app.post('/api/transfer/loan', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const playerId = Number(req.body?.playerId);
  if (!Number.isInteger(playerId)) return reply.code(400).send({ error: 'playerId required' });
  const r = loanIn(teamId, playerId);
  if (!r.ok) return reply.code(400).send({ error: r.error });
  return { ...r, market: getMarket(teamId) };
});

// §2.1 (free-agent half): offer a free agent terms (wage + length) — he considers it and answers at the
// next matchday — and the manager's free-agent negotiations in progress.
app.post('/api/freeagent/offer', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const agentId = Number(req.body?.agentId), wage = Number(req.body?.wage), years = Number(req.body?.years);
  if (!Number.isInteger(agentId)) return reply.code(400).send({ error: 'agentId required' });
  const r = offerToFreeAgent(teamId, agentId, wage, years);
  if (!r.ok) return reply.code(400).send({ error: r.error });
  return { ...r, market: getMarket(teamId), faOffers: freeAgentOffersForTeam(teamId) };
});
app.get('/api/freeagent/offers', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  return { offers: freeAgentOffersForTeam(teamId) };
});

// §loan-out: send one of your own players out on loan to a world club for the season (frees his wage; he
// returns at rollover). Optional clubId picks the destination; otherwise a club short in his role is chosen.
app.post('/api/transfer/loan-out', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const slot = Number(req.body?.slot);
  if (!Number.isInteger(slot)) return reply.code(400).send({ error: 'slot required' });
  const clubId = req.body?.clubId != null ? Number(req.body.clubId) : undefined;
  const r = loanOut(teamId, slot, Number.isInteger(clubId) ? clubId : undefined);
  if (!r.ok) return reply.code(400).send({ error: r.error });
  return { ...r, market: getMarket(teamId) };
});

// §2.12: send a loaned-in player back to his parent club early (frees the slot + wage).
app.post('/api/transfer/loan/end', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const slot = Number(req.body?.slot);
  if (!Number.isInteger(slot)) return reply.code(400).send({ error: 'slot required' });
  const r = endLoan(teamId, slot);
  if (!r.ok) return reply.code(400).send({ error: r.error });
  return { ...r, market: getMarket(teamId) };
});

// §2.1 signing drama: a buyer's outgoing offers (live + recently resolved), withdraw a live one,
// or match a counter (completes the deal at the seller's named price).
app.get('/api/offers', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  return { offers: offersForTeam(teamId) };
});
app.post('/api/offer/:id/withdraw', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const r = withdrawOffer(teamId, Number(req.params.id));
  if (!r.ok) return reply.code(400).send({ error: r.error });
  return { ...r, offers: offersForTeam(teamId) };
});
app.post('/api/offer/:id/match', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const r = matchCounter(teamId, Number(req.params.id));
  if (r.status === 'error') return reply.code(400).send({ error: r.error });
  return { ...r, market: getMarket(teamId), offers: offersForTeam(teamId) };
});

// §2.1: INCOMING bids — other clubs bidding for YOUR listed players. List them, accept (sell), or reject.
app.get('/api/incoming-offers', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  return { incoming: incomingOffersForTeam(teamId) };
});
app.post('/api/offer/:id/accept', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const r = acceptIncomingOffer(teamId, Number(req.params.id));
  if (!r.ok) return reply.code(400).send({ error: r.error });
  return { ...r, market: getMarket(teamId), incoming: incomingOffersForTeam(teamId) };
});
app.post('/api/offer/:id/reject', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const r = rejectIncomingOffer(teamId, Number(req.params.id));
  if (!r.ok) return reply.code(400).send({ error: r.error });
  return { ...r, incoming: incomingOffersForTeam(teamId) };
});

// Rewrite a player's backstory/tagline and RE-DERIVE their trait dials from the new text
// (the text↔dial coupling: the dials are the story's machine-readable projection, and the
// training rate + transfer value read the dials live, so editing the story changes the
// player's underlying weights). LLM-primary with a deterministic keyword fallback.
app.put('/api/player/:slot/story', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const slot = Number(req.params.slot);
  if (!Number.isInteger(slot)) return reply.code(400).send({ error: 'bad slot' });
  const backstory = String(req.body?.backstory ?? '').trim().slice(0, 400);
  const tagline = String(req.body?.tagline ?? '').trim().slice(0, 80);
  if (!backstory) return reply.code(400).send({ error: 'a backstory is required' });
  const row = db.prepare('SELECT name, role, attrs, age, personality FROM players WHERE team_id = ? AND slot = ?')
    .get(teamId, slot) as { name: string; role: string; attrs: string; age: number; personality: string | null } | undefined;
  if (!row) return reply.code(404).send({ error: 'player not found' });
  let prev: Personality | null = null;
  try { prev = row.personality ? JSON.parse(row.personality) : null; } catch { /* ignore */ }
  const traits = await deriveTraits(row.name, row.role, backstory, tagline);
  const personality: Personality = { traits, nationality: prev?.nationality ?? defaultPersonality(row.name, row.role).nationality, backstory, tagline };
  db.prepare('UPDATE players SET personality = ? WHERE team_id = ? AND slot = ?').run(JSON.stringify(personality), teamId, slot);
  // return the re-derived weights so the UI can show the story drove the numbers
  return { slot, personality, value: playerValue(JSON.parse(row.attrs), row.age, personality) };
});

// Propose a renewal (§2.2): the manager offers a wage + length; the player resolves it at the next
// matchday (accept / counter / reject). Replaces the old instant one-click renewal with a negotiation.
app.post('/api/player/:slot/renew-offer', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const slot = Number(req.params.slot);
  if (!Number.isInteger(slot)) return reply.code(400).send({ error: 'bad slot' });
  const wage = Number(req.body?.wage);
  const years = req.body?.years != null ? Number(req.body.years) : 3;
  const r = proposeRenewal(teamId, slot, wage, years);
  if (!r.ok) return reply.code(400).send({ error: r.error });
  return r;
});

// The club's contract negotiations (outgoing renewal offers + their status).
app.get('/api/contract-offers', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  return { offers: contractOffersForTeam(teamId) };
});

// Match the player's counter — strike the renewal at his terms (budget permitting).
app.post('/api/contract-offer/:id/match', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const id = Number(req.params.id);
  const r = matchContractCounter(teamId, id);
  if (!r.ok) return reply.code(400).send({ error: r.error });
  return r;
});

// Withdraw a live renewal offer.
app.post('/api/contract-offer/:id/withdraw', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const id = Number(req.params.id);
  const r = withdrawContractOffer(teamId, id);
  if (!r.ok) return reply.code(400).send({ error: r.error });
  return r;
});

// Preview a renewal (§1.14): the recomputed wage + delta + affordability, WITHOUT committing.
app.get('/api/player/:slot/renew-preview', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const slot = Number(req.params.slot);
  if (!Number.isInteger(slot)) return reply.code(400).send({ error: 'bad slot' });
  const r = previewRenewal(teamId, slot, 3);
  if (!r.ok) return reply.code(400).send({ error: r.error });
  return r;
});

// Hold a press conference: the manager's statement (free text) is judged against each
// player's personality dials to move squad morale. LLM-primary with a deterministic fallback.
const pressInFlight = new Set<number>();   // a presser is mid-judge (multi-second LLM await) — see the guard below

// Interactive press: a context-aware journalist question + tone-keyed response options (LLM, with a
// deterministic template fallback). The frontend shows the question + lets the manager pick a tone.
app.get('/api/press', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  if (!pressAvailable(teamId)) return { available: false };
  const team = getTeamWithPlayers(teamId)!;
  const last5 = db.prepare('SELECT home_team_id, away_team_id, home_score, away_score FROM fixtures WHERE (home_team_id = ? OR away_team_id = ?) AND played = 1 ORDER BY round DESC LIMIT 5')
    .all(teamId, teamId) as { home_team_id: number; away_team_id: number; home_score: number | null; away_score: number | null }[];
  const res = (f: typeof last5[number]): 'W' | 'D' | 'L' => {
    const gf = f.home_team_id === teamId ? (f.home_score ?? 0) : (f.away_score ?? 0);
    const ga = f.home_team_id === teamId ? (f.away_score ?? 0) : (f.home_score ?? 0);
    return gf > ga ? 'W' : gf < ga ? 'L' : 'D';
  };
  const form = last5.slice().reverse().map(res).join('');   // oldest → newest
  const nextFx = db.prepare('SELECT home_team_id, away_team_id FROM fixtures WHERE (home_team_id = ? OR away_team_id = ?) AND played = 0 ORDER BY round LIMIT 1')
    .get(teamId, teamId) as { home_team_id: number; away_team_id: number } | undefined;
  const oppId = nextFx ? (nextFx.home_team_id === teamId ? nextFx.away_team_id : nextFx.home_team_id) : null;
  const nextOpponent = oppId != null ? (db.prepare('SELECT name FROM teams WHERE id = ?').get(oppId) as { name: string } | undefined)?.name : undefined;
  const tbl = standings(team.leagueId);
  const idx = tbl.findIndex(s => (s as { isUser?: boolean }).isUser);
  // the just-played match (scoreline + opponent) → a post-match-style, result-aware press question
  let lastMatch: { result: 'W' | 'D' | 'L'; gf: number; ga: number; opponent: string; home: boolean } | undefined;
  if (last5.length) {
    const f0 = last5[0];
    const home = f0.home_team_id === teamId;
    const oppName = (db.prepare('SELECT name FROM teams WHERE id = ?').get(home ? f0.away_team_id : f0.home_team_id) as { name: string } | undefined)?.name;
    if (oppName) lastMatch = { result: res(f0), gf: home ? (f0.home_score ?? 0) : (f0.away_score ?? 0), ga: home ? (f0.away_score ?? 0) : (f0.home_score ?? 0), opponent: oppName, home };
  }
  const q = await generatePressQuestion({
    form, lastResult: last5.length ? res(last5[0]) : undefined, lastMatch,
    position: idx >= 0 ? idx + 1 : 0, teams: tbl.length,
    objective: getObjective(teamId)?.label, nextOpponent, confidence: getConfidence(teamId)?.status,
  });
  return { available: true, ...q };
});

app.post('/api/press', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const text = String(req.body?.text ?? '').trim().slice(0, 400);
  const tone = typeof req.body?.tone === 'string' ? req.body.tone : undefined;   // the chosen option's tone (board effect)
  if (!text) return reply.code(400).send({ error: 'say something to the media' });
  // one presser per match — you can't spam the media to farm morale
  if (!pressAvailable(teamId)) return reply.code(400).send({ error: "you've already faced the media this matchday — nothing new to say until your next game." });
  // Close the double-submit race: pressAvailable() → await → recordPress() lets two concurrent submits both
  // pass the gate before either records, double-applying morale. The check+add below is synchronous (no await
  // between), so on Node's single thread the second submit always sees the in-flight flag and is rejected.
  if (pressInFlight.has(teamId)) return reply.code(409).send({ error: "you're already in front of the media." });
  pressInFlight.add(teamId);
  try {
    const r = await applyPressResponse(teamId, text, tone);   // morale (dials) + board confidence (tone)
    recordPress(teamId);   // only consume the once-per-match cadence on success (a failed judge can be retried)
    return { ...r, confidence: getConfidence(teamId), team: getTeamWithPlayers(teamId) };
  } finally {
    pressInFlight.delete(teamId);
  }
});

// §shortlist: the manager's transfer watchlist (resolved to live rows) + the tracked id set for the ★ toggle.
app.get('/api/shortlist', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  return { shortlist: getShortlist(teamId), ids: shortlistIds(teamId) };
});
app.post('/api/shortlist', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const playerId = Number(req.body?.playerId);
  if (!Number.isInteger(playerId)) return reply.code(400).send({ error: 'playerId required' });
  const add = req.body?.add !== false;   // default to add unless explicitly false
  const r = toggleShortlist(teamId, playerId, add);
  return { ...r, shortlist: getShortlist(teamId), ids: shortlistIds(teamId) };
});

// §scouting-centre: search the whole player population of the user's world by role/age/overall/value/
// name, with attributes fogged to the club's scout depth. Filters come in as query params (all optional).
app.get('/api/search', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const q = req.query ?? {};
  const num = (v: unknown): number | undefined => { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) ? n : undefined; };
  return searchPlayers(teamId, {
    role: typeof q.role === 'string' && q.role ? q.role : undefined,
    maxAge: num(q.maxAge),
    minOverall: num(q.minOverall),
    maxValue: num(q.maxValue),
    name: typeof q.name === 'string' ? q.name : undefined,
    onlyShortlisted: q.shortlisted === '1' || q.shortlisted === 'true',
  });
});

// §stat-leaders: the current division's top scorers + top assisters this season.
app.get('/api/leaders', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const l = leagueLeaders(teamId);
  if (!l) return reply.code(404).send({ error: 'no team' });
  return l;
});

// §player-interaction: a private 1-to-1 word with one player (praise/encourage/warn/criticise) that moves
// his morale via his personality dials. One chat per player per matchday (cooldown enforced in the module).
app.post('/api/player/:slot/interact', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const slot = Number(req.params?.slot);
  if (!Number.isInteger(slot)) return reply.code(400).send({ error: 'bad slot' });
  if (!isInteractTone(req.body?.tone)) return reply.code(400).send({ error: 'unknown tone' });
  const r = interactWithPlayer(teamId, slot, req.body.tone);
  if (!r.ok) return reply.code(400).send({ error: r.error });
  return r;
});

// A squad player's archived career — one row per finished season (goals/assists/apps/avg-rating),
// resolved slot → stable players.id within the user's own club (career only for players you manage).
app.get('/api/player/:slot/career', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const slot = Number(req.params?.slot);
  if (!Number.isInteger(slot)) return reply.code(400).send({ error: 'bad slot' });
  const row = db.prepare('SELECT id FROM players WHERE team_id = ? AND slot = ?').get(teamId, slot) as { id: number } | undefined;
  if (!row) return reply.code(404).send({ error: 'no such player in your squad' });
  return { career: getPlayerCareer(row.id) };
});

// A squad player's attribute-progression series — one snapshot per developed matchday (attr_snapshots),
// for the Development graph. Same slot → stable players.id resolution as /career (auth boundary).
app.get('/api/player/:slot/progression', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const slot = Number(req.params?.slot);
  if (!Number.isInteger(slot)) return reply.code(400).send({ error: 'bad slot' });
  const row = db.prepare('SELECT id FROM players WHERE team_id = ? AND slot = ?').get(teamId, slot) as { id: number } | undefined;
  if (!row) return reply.code(404).send({ error: 'no such player in your squad' });
  return { progression: getAttrProgression(row.id) };
});

// Unsettled players (§2.3 depth) — the dressing-room concerns the manager can act on, + resolving one.
app.get('/api/concerns', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  return { concerns: getConcerns(teamId) };
});

app.post('/api/concerns/:slot', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const slot = Number(req.params?.slot);
  if (!Number.isInteger(slot)) return reply.code(400).send({ error: 'slot must be an integer' });   // reject a bad param at the boundary (matches every other slot route)
  const action = String(req.body?.action ?? '') as ConcernAction;
  if (!['reassure', 'accept', 'reject'].includes(action)) return reply.code(400).send({ error: 'unknown action' });
  const r = resolveConcern(teamId, slot, action);
  if (!r.ok) return reply.code(400).send({ error: r.error });
  return { ...r, concerns: getConcerns(teamId), team: getTeamWithPlayers(teamId) };
});

// Board meeting (board interaction) — the once-a-season audience state, and requesting backing.
app.get('/api/board', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  return getBoardMeeting(teamId);
});

app.post('/api/board/request', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const kind = String(req.body?.kind ?? '') as BoardRequestKind;
  if (kind !== 'funds' && kind !== 'wages') return reply.code(400).send({ error: 'kind must be funds or wages' });
  const r = requestBoardBacking(teamId, kind);
  if (!r.ok) return reply.code(400).send({ error: r.message });
  return { ...r, meeting: getBoardMeeting(teamId), team: getTeamWithPlayers(teamId) };
});

// The manager's career record (aggregated from season_history across every club they've managed).
app.get('/api/career', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const career = getManagerCareer(user.id);
  return { ...career, reputation: managerReputation(career) };   // §P2#9 the synthesised media standing
});

// Set the club's training focus ('balanced' or a trainable attribute). Drives the
// development tick that runs each matchday.
app.put('/api/training', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const focus = String(req.body?.focus ?? '');
  if (!VALID_FOCUS.has(focus)) return reply.code(400).send({ error: `focus must be one of: balanced, position, ${TRAINABLE.join(', ')}` });
  return setTrainingFocus(teamId, focus);
});

// Set ONE player's training focus, overriding the club focus (audit §2.7). An empty value (or
// 'club') clears the override so he follows the club focus again.
app.put('/api/training/player', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const slot = Number(req.body?.slot);
  if (!Number.isInteger(slot)) return reply.code(400).send({ error: 'slot must be an integer' });
  const focus = String(req.body?.focus ?? '');
  // a non-empty focus must be valid; '' / 'club' are the allowed "clear" sentinels
  if (focus && focus !== 'club' && !VALID_FOCUS.has(focus)) return reply.code(400).send({ error: `focus must be one of: balanced, position, ${TRAINABLE.join(', ')}` });
  const r = setPlayerTrainingFocus(teamId, slot, focus);
  if (!r.ok) return reply.code(404).send({ error: 'no such player in your squad' });
  return r;
});

// Set ONE player's training intensity (double|normal|half|rest). ''/'normal'/invalid clears to the normal default.
app.put('/api/training/player-intensity', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const slot = Number(req.body?.slot);
  if (!Number.isInteger(slot)) return reply.code(400).send({ error: 'slot must be an integer' });
  const value = String(req.body?.value ?? '');
  if (value && value !== 'normal' && !VALID_INTENSITY.has(value)) return reply.code(400).send({ error: 'intensity must be one of: double, normal, half, rest' });
  const r = setPlayerTrainingIntensity(teamId, slot, value);
  if (!r.ok) return reply.code(404).send({ error: 'no such player in your squad' });
  return r;
});

// Set the CLUB-WIDE training intensity dial (light|normal|heavy). 'normal'/invalid = the byte-identical
// default; the whole squad trains at this level unless a player carries his own intensity override.
app.put('/api/training/team-intensity', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const level = String(req.body?.value ?? '');
  if (level && !VALID_TEAM_INTENSITY.has(level)) return reply.code(400).send({ error: 'intensity must be one of: light, normal, heavy' });
  return setTeamTrainingIntensity(teamId, level);
});

// Apply a one-click training PRESET (a named focus + club-intensity schedule). Sets both the club
// focus and the club intensity dial in one go (per-player overrides untouched).
app.put('/api/training/preset', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const name = String(req.body?.name ?? '');
  if (!Object.prototype.hasOwnProperty.call(TRAINING_PRESETS, name)) return reply.code(400).send({ error: `preset must be one of: ${Object.keys(TRAINING_PRESETS).join(', ')}` });
  const r = applyTrainingPreset(teamId, name);
  if (!r.ok) return reply.code(400).send({ error: r.error ?? 'could not apply preset' });
  return r;
});

// Start/clear a position RETRAIN for one player ('' or his current role clears it → he settles).
// A valid different role starts a settling-in period during which he develops a little slower.
app.put('/api/training/retrain', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const slot = Number(req.body?.slot);
  if (!Number.isInteger(slot)) return reply.code(400).send({ error: 'slot must be an integer' });
  const role = String(req.body?.role ?? '');
  if (role && role !== 'clear' && !(RETRAIN_ROLES as readonly string[]).includes(role)) return reply.code(400).send({ error: `role must be one of: ${RETRAIN_ROLES.join(', ')}` });
  const r = setPlayerRetrain(teamId, slot, role === 'clear' ? '' : role);
  if (!r.ok) return reply.code(404).send({ error: 'no such player in your squad' });
  return r;
});

// The latest per-matchday training report for the club (null until the first matchday develops
// the squad): attribute drift per player + the factors behind it + the staff/harmony contribution.
app.get('/api/training-report', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  return { report: getTrainingReport(teamId) };
});

// The cup bracket for the user's world this season.
app.get('/api/cup', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const team = getTeamWithPlayers(teamId)!;
  return { ...cupView(team.leagueId), myTeamId: teamId };
});

app.get('/api/league', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const team = getTeamWithPlayers(teamId)!;
  const leagueId = team.leagueId;
  const names = new Map((db.prepare('SELECT id, name FROM teams WHERE league_id = ?').all(leagueId) as { id: number; name: string }[]).map(t => [t.id, t.name]));
  const fixtures = (db.prepare(
    'SELECT id, round, home_team_id, away_team_id, played, home_score, away_score, seed FROM fixtures WHERE league_id = ? ORDER BY round, id',
  ).all(leagueId) as any[]).map(f => ({
    id: f.id, round: f.round,
    home: names.get(f.home_team_id), away: names.get(f.away_team_id),
    homeTeamId: f.home_team_id, awayTeamId: f.away_team_id,
    played: !!f.played, homeScore: f.home_score, awayScore: f.away_score,
    involvesMe: f.home_team_id === teamId || f.away_team_id === teamId,
    weather: weatherForSeed(f.seed),   // §weather: the deterministic per-match condition (forecast / what happened)
  }));
  const lg = db.prepare('SELECT season, tier, name FROM leagues WHERE id = ?').get(leagueId) as { season: number; tier: number; name: string };
  const table = standings(leagueId);
  const objective = getObjective(teamId);
  const confidence = getConfidence(teamId);
  // mid-season board mood: a weekly pulse on the once-a-season verdict, from confidence + whether
  // the club is currently meeting the board's target.
  const myPos = table.findIndex(s => s.teamId === teamId) + 1;
  const onTrack = objective ? (myPos > 0 && myPos <= objective.target) : true;
  const mood = confidence ? boardMood(confidence.status, onTrack) : null;
  // Event-driven board comms: react to my last played match + set expectations for my next one.
  const mine = fixtures.filter(f => f.involvesMe);
  const last = mine.filter(f => f.played).at(-1);
  const lastResult = last ? (() => {
    const home = last.homeTeamId === teamId;
    const gf = (home ? last.homeScore : last.awayScore) ?? 0;
    const ga = (home ? last.awayScore : last.homeScore) ?? 0;
    const outcome: 'W' | 'D' | 'L' = gf > ga ? 'W' : gf < ga ? 'L' : 'D';
    return { outcome, gf, ga, opponent: (home ? last.away : last.home) ?? '' };
  })() : null;
  const nextFx = mine.find(f => !f.played);
  const posOf = (tid: number): number => { const i = table.findIndex(s => s.teamId === tid); return i >= 0 ? i + 1 : 0; };
  const nextMatch = nextFx ? {
    opponent: (nextFx.homeTeamId === teamId ? nextFx.away : nextFx.home) ?? '',
    home: nextFx.homeTeamId === teamId,
    myPos, oppPos: posOf(nextFx.homeTeamId === teamId ? nextFx.awayTeamId : nextFx.homeTeamId),
  } : null;
  const messages = boardMessages({ status: confidence?.status ?? null, objectiveKind: objective?.kind ?? null, lastResult, nextMatch });
  // world = every division's table (for the "other divisions" peek); the user's row is
  // flagged isUser within each division's standings.
  return {
    leagueId, myTeamId: teamId, standings: table, fixtures,
    season: lg.season, tier: lg.tier, divisionName: lg.name, world: worldStandings(leagueId),
    // gates the "advance" button on the whole world, not just the user's own fixtures:
    // a user who watched all their matches still needs to play out the other games.
    seasonComplete: seasonComplete(leagueId),
    objective,                         // the board's expectation this season (null if unset)
    promote: PROMOTE,                  // bottom N are relegated — lets the UI place the drop line
    confidence,                        // board confidence / job security
    boardMood: mood,                   // mid-season board mood line (null if no confidence)
    boardMessages: messages,           // event-driven board comms: last-result reaction + next-match expectation
    pressAvailable: pressAvailable(teamId),   // §2.14: can the manager hold a press conference this matchday
    // §autonomous: the world's turn model. 'solo' → the owner advances on demand (show the button);
    // 'shared' → the scheduler advances it, so surface the next-turn ETA instead of a manual button.
    world_turn: (() => {
      const wid = worldForTeam(teamId); const w = wid != null ? getWorld(wid) : null;
      if (!w) return { mode: 'solo' as const, turn: 0, canAdvance: !!user.isAdmin };
      const nextTurnAt = w.mode === 'shared' && w.lastAdvanced != null ? w.lastAdvanced + w.intervalMin * 60000 : null;
      // §autonomous: surface the team's autonomy tier so a shared-world manager can see/toggle whether the
      // assistant only sets tactics+XI ('assistant') or also makes transfers while they're away ('full').
      const autonomy = (db.prepare('SELECT autonomy FROM teams WHERE id = ?').get(teamId) as { autonomy: string | null } | undefined)?.autonomy === 'full' ? 'full' : 'assistant';
      return { mode: w.mode, turn: w.turn, intervalMin: w.intervalMin, lastAdvanced: w.lastAdvanced, nextTurnAt, canAdvance: user.isAdmin || w.mode === 'solo', autonomy };
    })(),
  };
});

// Play a specific fixture (must be in my league). Returns result + standings.
app.post('/api/fixtures/:id/play', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const fx = getFixture(Number(req.params.id));
  if (!fx) return reply.code(404).send({ error: 'fixture not found' });
  const team = getTeamWithPlayers(teamId)!;
  if (fx.league_id !== team.leagueId) return reply.code(403).send({ error: 'not your league' });
  // Ownership: only YOUR own fixtures can be played here (watching your next match records its result early).
  // Spectating another club's game must NOT pre-play it out of order vs pendingMatchday — that's the advance's job.
  if (fx.home_team_id !== teamId && fx.away_team_id !== teamId) return reply.code(403).send({ error: 'not your fixture' });
  const result = await playFixture(fx.id);
  return { result, standings: standings(team.leagueId) };
});

// Post-match report + ratings for a played fixture (cached; generated from the recording on
// first view). 404 if the match has no recording (e.g. a distant AI-vs-AI game).
app.get('/api/report', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  // §cup-report: a cup tie's report (the recording exists for the user's ties). Same builder, kind='cup'.
  if (req.query?.cup != null) {
    const tie = db.prepare('SELECT * FROM cup_ties WHERE id = ?').get(Number(req.query.cup)) as { id: number; world_id: number; home_team_id: number | null; away_team_id: number | null; seed: number; played: number; home_score: number | null; away_score: number | null; home_pens: number | null; away_pens: number | null; winner_team_id: number | null } | undefined;
    if (!tie || !tie.played || tie.home_team_id == null || tie.away_team_id == null) return reply.code(404).send({ error: 'cup tie not found' });
    const lg = db.prepare('SELECT id, world_id FROM leagues WHERE id = (SELECT league_id FROM teams WHERE id = ?)').get(teamId) as { id: number; world_id: number | null };
    if (tie.world_id !== (lg.world_id ?? lg.id)) return reply.code(403).send({ error: 'not your world' });
    const cnm = db.prepare('SELECT id, name FROM teams WHERE id IN (?, ?)').all(tie.home_team_id, tie.away_team_id) as { id: number; name: string }[];
    const chome = cnm.find(t => t.id === tie.home_team_id)?.name ?? 'Home';
    const caway = cnm.find(t => t.id === tie.away_team_id)?.name ?? 'Away';
    const crep = await buildMatchReport('cup', tie.id, chome, caway);
    if (!crep) return reply.code(404).send({ error: 'no recording for this tie' });
    if (tie.home_pens != null && tie.away_pens != null && tie.home_pens !== tie.away_pens) {
      const winner: 'home' | 'away' = cupTieWinnerId({ ...tie, home_team_id: tie.home_team_id, away_team_id: tie.away_team_id }) === tie.home_team_id ? 'home' : 'away';
      const winnerName = winner === 'home' ? chome : caway;
      const winnerPens = winner === 'home' ? tie.home_pens : tie.away_pens;
      const loserPens = winner === 'home' ? tie.away_pens : tie.home_pens;
      const decider = `${winnerName} won ${winnerPens}–${loserPens} on penalties after the tie finished ${crep.facts.homeScore}–${crep.facts.awayScore}.`;
      return {
        homeName: chome, awayName: caway, ...crep,
        headline: `${crep.headline} (${tie.home_pens}–${tie.away_pens} pens)`,
        body: `${decider} ${crep.body}`,
        shootout: { home: tie.home_pens, away: tie.away_pens, winner },
      };
    }
    return { homeName: chome, awayName: caway, ...crep, shootout: null };
  }
  const fx = getFixture(Number(req.query?.fixture));
  if (!fx) return reply.code(404).send({ error: 'fixture not found' });
  const team = getTeamWithPlayers(teamId)!;
  if (fx.league_id !== team.leagueId) return reply.code(403).send({ error: 'not your league' });
  const nm = db.prepare('SELECT id, name FROM teams WHERE id IN (?, ?)').all(fx.home_team_id, fx.away_team_id) as { id: number; name: string }[];
  const homeName = nm.find(t => t.id === fx.home_team_id)?.name ?? 'Home';
  const awayName = nm.find(t => t.id === fx.away_team_id)?.name ?? 'Away';
  const report = await buildMatchReport('fixture', fx.id, homeName, awayName);
  if (!report) return reply.code(404).send({ error: 'no recording for this match' });
  return { homeName, awayName, ...report };
});

// The shout/tactics review for a watched match — the persisted command log digested to
// {minute, text, what-it-changed}. Empty `shouts` if the match was watched without shouting
// (or never live-watched). Reads the durable events log MatchStream writes on socket close.
app.get('/api/tactics', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const fx = getFixture(Number(req.query?.fixture));
  if (!fx) return reply.code(404).send({ error: 'fixture not found' });
  const team = getTeamWithPlayers(teamId)!;
  if (fx.league_id !== team.leagueId) return reply.code(403).send({ error: 'not your league' });
  const log = loadEventsLog('fixture', fx.id);
  if (!log) return { shouts: [] };
  return tacticsReview(log);
});

// Pre-match opponent scouting report for an upcoming fixture the user is in (form, table
// position, danger men, a read of how they play). 404 if the fixture isn't the user's.
app.get('/api/scout', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const report = buildScoutReport(Number(req.query?.fixture), teamId);
  if (!report) return reply.code(404).send({ error: 'no scout report for this fixture' });
  return report;
});

// The club's player-news feed (events that evolved a player's story this/past seasons).
app.get('/api/news', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const limit = Math.min(200, Math.max(1, Number((req.query as any)?.limit) || 20));   // §2.14: the archive asks for more
  return { news: recentNews(teamId, limit) };
});

// §inbox: the persistent matchday feed (results/transfers/injuries/contracts/cup/board/awards), newest
// first + the unread count. Written server-side at /api/advance; survives rollover, grouped by season.
app.get('/api/inbox', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const limit = Math.min(200, Math.max(1, Number((req.query as any)?.limit) || 50));
  return { inbox: getInbox(teamId, limit), unread: countUnread(teamId) };
});
app.post('/api/inbox/read', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  markInboxRead(teamId, { id: req.body?.id != null ? Number(req.body.id) : undefined, all: !!req.body?.all });
  return { ok: true, unread: countUnread(teamId) };
});

// Backroom staff: the club's coaches/physios/scouts + the world's hire pool + current effects.
app.get('/api/staff', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  return getStaffView(teamId);
});
app.post('/api/staff/hire', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const staffId = Number(req.body?.staffId);
  if (!Number.isInteger(staffId)) return reply.code(400).send({ error: 'staffId required' });
  const r = hireStaff(teamId, staffId);
  if (!r.ok) return reply.code(400).send({ error: r.error });
  return { ...r, ...getStaffView(teamId) };
});
app.post('/api/staff/fire', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const staffId = Number(req.body?.staffId);
  if (!Number.isInteger(staffId)) return reply.code(400).send({ error: 'staffId required' });
  const r = fireStaff(teamId, staffId);
  if (!r.ok) return reply.code(400).send({ error: r.error });
  return { ...r, ...getStaffView(teamId) };
});

// Save the category→coach assignment (what ACTIVATES per-category development). A missing/empty assignment reverts
// to the flat coaching factor (byte-identical). Returns the refreshed staff view so the board re-renders.
app.put('/api/staff/assignment', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const assignment = (req.body && typeof req.body.assignment === 'object') ? req.body.assignment : null;
  saveCoachAssignment(teamId, assignment);
  return getStaffView(teamId);
});

// The club's finances statement: balance, this-season income/expense by category, recent movements.
app.get('/api/finances', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const fin = getFinances(teamId);
  if (!fin) return reply.code(404).send({ error: 'no team' });
  return fin;
});

// Dressing-room harmony: a read-only read of how settled the squad is (from dials + morale).
app.get('/api/harmony', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const h = getSquadHarmony(teamId);
  if (!h) return reply.code(404).send({ error: 'no squad' });
  return h;
});

// Fitness & rotation guidance (§2.10): per-player fitness band + injury-risk %, and "rest X, start Y"
// suggestions. Read-only.
app.get('/api/rotation', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const v = getRotationView(teamId);
  if (!v) return reply.code(404).send({ error: 'no squad' });
  return v;
});

// Apply one rotation swap (bench a starter, start a bench player) by editing the stored XI directly.
app.post('/api/rotation/apply', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const r = applyRotation(teamId, Number(req.body?.outSlot), Number(req.body?.inSlot));
  if (!r.ok) return reply.code(400).send({ error: r.error ?? 'could not apply' });
  return { ...r, rotation: getRotationView(teamId) };
});

// The club's season-by-season history + honours (populated at each rollover).
app.get('/api/history', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  return { history: getHistory(teamId), records: getClubRecords(teamId) };
});

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
  for (const r of results) { if (r && r.players) { try { tallyDivisionRatings(r.fixtureId, r.players); } catch { /* ambient */ } } }

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
      void processMatchAftermath(tid, s.myFixtureId, injuries, s.myResult?.players ?? []).catch(() => { /* ambient */ });
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
let tickInFlight = false;
async function runDueTicks(now: number, max = 25): Promise<{ advanced: number[]; errors: { worldId: number; error: string }[]; due: number }> {
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
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const wid = worldForTeam(teamId);
  if (wid == null) return reply.code(404).send({ error: 'no world' });
  return { tournaments: getWorldTournaments(wid), fieldable: fieldableNations(wid).sort((a, b) => b.strength - a.strength) };
});

// §national-teams: a nation's current best XI in the caller's world.
app.get('/api/nation/:key/squad', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const wid = worldForTeam(teamId);
  if (wid == null) return reply.code(404).send({ error: 'no world' });
  const xi = selectNationalSquad(wid, String(req.params?.key));
  return { squad: (xi ?? []).map(p => ({ name: p.name, role: p.role, overall: overall(p.attrs) })) };
});

// §national-teams: admin — run this world's internationals now (testing; normally fires at rollover).
app.post('/api/admin/run-internationals', async (req: any, reply) => {
  const user = requireAdmin(req, reply); if (!user) return;
  const wid = Number(req.body?.worldId);
  const season = Number(req.body?.season);
  if (!Number.isInteger(wid) || !Number.isInteger(season)) return reply.code(400).send({ error: 'worldId + season required' });
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
  const worldId = Number(req.params?.id);
  if (!Number.isInteger(worldId)) return reply.code(400).send({ error: 'bad world' });
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
  const worldId = Number(req.params?.id);
  const teamId = Number(req.body?.teamId);
  if (!Number.isInteger(worldId) || !Number.isInteger(teamId)) return reply.code(400).send({ error: 'world + teamId required' });
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
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const wid = worldForTeam(teamId);
  const w = wid != null ? getWorld(wid) : null;
  if (!w || w.mode !== 'shared') return reply.code(400).send({ error: 'you can only leave a shared world' });
  db.prepare("UPDATE teams SET user_id = NULL, manager = 'AI', sacked = 0 WHERE id = ?").run(teamId);
  return { ok: true };
});

// §autonomous: opt into full autonomy (the assistant also makes transfers while you're away) or back to
// the default 'assistant' tier (tactics + XI only, never spends). Read on the team payload.
app.post('/api/autonomy', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
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
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const team = getTeamWithPlayers(teamId)!;
  const fx = db.prepare(
    `SELECT id FROM fixtures WHERE league_id = ? AND played = 0
       AND (home_team_id = ? OR away_team_id = ?) ORDER BY round, id LIMIT 1`,
  ).get(team.leagueId, teamId, teamId) as { id: number } | undefined;
  if (!fx) return reply.code(404).send({ error: 'no upcoming fixture' });
  const result = await playFixture(fx.id);
  return { fixtureId: fx.id, result, standings: standings(team.leagueId) };
});

// SPA fallback for client-side routing (only if a build exists). Must be
// registered before listen().
if (existsSync(DIST)) {
  app.setNotFoundHandler((req: any, reply) => {
    if (req.raw.url?.startsWith('/api')) return reply.code(404).send({ error: 'not found' });
    return reply.sendFile('index.html');
  });
}

// Ensure the default admin (maxk/maxk) exists so a tester / headless run can advance the world.
// Idempotent; disable in prod with FOOTY_NO_ADMIN_SEED=1. See auth.seedAdminUser.
seedAdminUser();

const server = app.server;
await app.listen({ port: PORT, host: '127.0.0.1' });
console.log(`footy game server on http://localhost:${PORT}`);
if (fastSimEnabled()) console.log('⚡ FOOTY_FAST_SIM on — matches resolve via the fast statistical model (no engine spawn). Headless/bulk mode; watched matches lose full-engine fidelity.');

// ── Autonomous turn scheduler (opt-in) ──────────────────────────────────────
// When FOOTY_AUTO_TICK_MIN is set, the server self-drives: every N minutes it advances every shared
// world whose cadence (worlds.interval_min, default 720 = 2/day) is due. Off by default so dev/tests and
// solo play are unaffected; a self-hosted autonomous deployment sets e.g. FOOTY_AUTO_TICK_MIN=30. An
// external cron / the CCR trigger can drive POST /api/tick instead (same runDueTicks path).
const AUTO_TICK_MIN = Number(process.env.FOOTY_AUTO_TICK_MIN);
if (Number.isFinite(AUTO_TICK_MIN) && AUTO_TICK_MIN > 0) {
  const everyMs = AUTO_TICK_MIN * 60000;
  setInterval(() => {
    if (tickInFlight) return;   // a slow tick must not stack on the next interval
    tickInFlight = true;
    runDueTicks(Date.now()).then(r => { if (r.advanced.length) console.log(`[tick] advanced ${r.advanced.length} world(s)`); }).catch(e => console.warn('[tick] failed', e)).finally(() => { tickInFlight = false; });
  }, everyMs);
  console.log(`[tick] auto-scheduler ON — every ${AUTO_TICK_MIN} min (shared worlds; cadence per world)`);
}

// ── match-watch WebSocket: /ws/match?fixture=ID (re-runs the deterministic sim) ──
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '', `http://${request.headers.host}`);
  if (url.pathname !== '/ws/match') { socket.destroy(); return; }
  // §cup-watch: replay a recorded cup tie (?cup=TIE_ID). The user's own ties are recorded (human stake);
  // a cup tie with no recording (AI-vs-AI) sends an error frame rather than a blank pitch. Replay-only —
  // cup ties aren't shout-driven, so no live re-sim / coordinator path.
  if (url.searchParams.get('cup')) {
    const tieId = Number(url.searchParams.get('cup'));
    const tie = db.prepare('SELECT id, world_id, home_team_id, away_team_id, seed, played FROM cup_ties WHERE id = ?').get(tieId) as { id: number; world_id: number; home_team_id: number | null; away_team_id: number | null; seed: number; played: number } | undefined;
    if (!tie || !tie.played || tie.home_team_id == null || tie.away_team_id == null) { socket.destroy(); return; }
    // World-scope guard (mirrors the cup-report REST branch's 403): only a manager in the tie's own world
    // may watch it back. Cup ties are personal — only your own club's ties are recorded — so this never
    // blocks a legitimate watch, but it stops another tenant streaming your replay by guessing a tie id.
    const wsSid = request.headers.cookie?.match(/(?:^|;\s*)sid=([^;]+)/)?.[1];
    const wsUser = wsSid ? getUserBySession(wsSid) : null;
    const wsTeamId = wsUser ? teamForUser(wsUser.id) : null;
    const wsWorld = wsTeamId ? db.prepare('SELECT id, world_id FROM leagues WHERE id = (SELECT league_id FROM teams WHERE id = ?)').get(wsTeamId) as { id: number; world_id: number | null } | undefined : undefined;
    if (!wsWorld || tie.world_id !== (wsWorld.world_id ?? wsWorld.id)) { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, (ws) => {
      try {
        const cnm = db.prepare('SELECT id, name FROM teams WHERE id IN (?, ?)').all(tie.home_team_id, tie.away_team_id) as { id: number; name: string }[];
        const chome = cnm.find(t => t.id === tie.home_team_id)?.name ?? 'HOME';
        const caway = cnm.find(t => t.id === tie.away_team_id)?.name ?? 'AWAY';
        const rec = recordingFor('cup', tieId);
        const frames = rec ? loadRecording(rec) : [];
        if (frames.length) { new ReplayStream(ws as any, frames, tie.seed, chome, caway); return; }
        ws.send(JSON.stringify({ error: 'This cup tie wasn’t recorded — only ties your club played can be watched back.' }));
        ws.close();
      } catch { try { ws.close(); } catch { /* */ } }
    });
    return;
  }
  const fixtureId = Number(url.searchParams.get('fixture'));
  const fx = getFixture(fixtureId);
  if (!fx) { socket.destroy(); return; }
  // Which side is the human watching? Resolve their team from the session cookie
  // so "we/us/all" and team-wide tactics ("park the bus") target the right side.
  const sid = request.headers.cookie?.match(/(?:^|;\s*)sid=([^;]+)/)?.[1];
  const user = sid ? getUserBySession(sid) : null;
  const myTeamId = user ? teamForUser(user.id) : null;
  // This socket's seat. A manager of one of the TWO teams in this fixture gets that side (and may
  // shout); anyone else — a spectator, a manager of a different club, or an unauthenticated socket
  // — is a spectator: watch only, NO tactics. (§1.2: the watch socket had no ownership check and
  // defaulted everyone to 'home', so a crafted message could tweak the home team's tactics live.)
  const seat: Seat = myTeamId === fx.home_team_id ? 'home' : myTeamId === fx.away_team_id ? 'away' : 'spectator';
  const myTeam: 'home' | 'away' = seat === 'away' ? 'away' : 'home';
  const canShout = seat !== 'spectator';
  wss.handleUpgrade(request, socket, head, (ws) => {
    try {
      const nm = db.prepare('SELECT id, name FROM teams WHERE id IN (?, ?)').all(fx.home_team_id, fx.away_team_id) as { id: number; name: string }[];
      const homeName = nm.find(t => t.id === fx.home_team_id)?.name ?? 'HOME';
      const awayName = nm.find(t => t.id === fx.away_team_id)?.name ?? 'AWAY';
      // A recorded match replays its stored frames (no engine spawn, no re-sim drift). We load
      // the frames here and only replay if there ARE frames — a metadata row that outlived its
      // file (manual disk clear, an interrupted prune) falls through to the live re-sim instead
      // of hanging the watch on a blank pitch. No recording at all → live re-sim (with shouts).
      const rec = recordingFor('fixture', fixtureId);
      const frames = rec ? loadRecording(rec) : [];
      if (frames.length) { new ReplayStream(ws as any, frames, fx.seed, homeName, awayName); return; }
      // "▶ Replay from your shouts" (?shouts=1): a shout-driven match that wasn't frame-recorded still
      // has a persisted command log — stream a PACED re-sim from it (deterministic), rather than the
      // live re-sim which would start from an empty plan. (A frame-recorded match already replays its
      // shouts via ReplayStream above.)
      if (url.searchParams.get('shouts') === '1') {
        const log = loadEventsLog('fixture', fixtureId);
        if (log) { new EventsReplayStream(ws as any, log, fx.seed, homeName, awayName); return; }
      }
      // Seed the live shout box from the manager's persisted standing plan (team-relative ids;
      // MatchStream resolves them to this watch's roster) so shouts edit the standing plan.
      const seedPlan = canShout ? (getTeamWithPlayers(myTeamId!)?.plan ?? null) : null;
      // `?live=1` (opt-in) routes to the SHARED resident coordinator (docs/LIVE_MATCH_ARCHITECTURE.md
      // §2): one engine per fixture, both managers + spectators attach, shouts inject live (no
      // kill-respawn). The default path (no live flag) is unchanged → byte-identical. NOTE: needs
      // Boris's engine Phase 1 (FOOTY_LIVE) to actually run; until then this branch is build-ahead.
      if (url.searchParams.get('live') === '1') {
        const seedPlans = {
          home: getTeamWithPlayers(fx.home_team_id)?.plan ?? null,
          away: getTeamWithPlayers(fx.away_team_id)?.plan ?? null,
        };
        joinLiveMatch(liveKey('fixture', fixtureId), ws as any, seat, {
          specPath: writeSpec(fx), seed: fx.seed, homeName, awayName,
          homeTeamId: fx.home_team_id, awayTeamId: fx.away_team_id,
          kind: 'fixture', refId: fixtureId, record: hasHumanStake(fx.home_team_id, fx.away_team_id), seedPlans,
        });
        return;
      }
      new MatchStream(ws as any, writeSpec(fx), fx.seed, homeName, awayName, myTeam, seedPlan, canShout, 'fixture', fixtureId);
    } catch (e) { ws.close(); }
  });
});
