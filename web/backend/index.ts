import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fstatic from '@fastify/static';
import { WebSocketServer } from 'ws';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { registerUser, loginUser, createSession, destroySession, getUserBySession, type User } from './auth.ts';
import { db } from './db.ts';
import {
  newSeasonForUser, getTeamWithPlayers, standings, teamForUser,
  assignPersonalities, needsPersonalities, fillMissingPersonalities, backfillFreeAgents, backfillPotentials, backfillContracts,
  playerValue, DEFAULT_TACTICS, type Tactics,
} from './game.ts';
import { deriveTraits, defaultPersonality, type Personality } from './personality.ts';
import { playFixture, playCupTie, getFixture, writeSpec, MatchStream, ReplayStream, recordingFor, loadRecording, hasHumanStake } from './match.ts';
import { joinLiveMatch, liveKey, type Seat } from './coordinator.ts';
import { pendingCupRound, advanceCupRound, cupView, cupTieFor } from './cup.ts';
import { compileLineup } from './lineup.ts';
import { FORMATIONS, PITCH_W } from './formations.ts';
import { getMarket, buyFreeAgent, listPlayer, unlistPlayer, marketTick, bidForPlayer, loanIn, offersForTeam, withdrawOffer, matchCounter, aiListSurplus, incomingOffersForTeam, acceptIncomingOffer, rejectIncomingOffer } from './market.ts';
import { compileInitialPlan } from './plan.ts';
import { developmentTick, setTrainingFocus, setPlayerTrainingFocus, getTrainingReport, TRAINABLE, VALID_FOCUS } from './training.ts';
import { getRotationView, applyRotation } from './rotation.ts';
import { seedAcademy, getAcademy, promoteProspect } from './youth.ts';
import { worldLeagues, pendingMatchday, seasonComplete, rolloverSeason, worldStandings, PROMOTE } from './season.ts';
import { aiManagerTick } from './ai.ts';
import { previewRenewal, proposeRenewal, processContractOffers, contractOffersForTeam, matchContractCounter, withdrawContractOffer } from './contracts.ts';
import { applyPressConference } from './press.ts';
import { buildMatchReport } from './report.ts';
import { buildScoutReport } from './scout.ts';
import { getHistory, getClubRecords } from './history.ts';
import { getObjective } from './objectives.ts';
import { getConfidence, boardMood, recruitmentBacking } from './confidence.ts';
import { getStaffView, hireStaff, fireStaff } from './staff.ts';
import { getFinances, payMatchdayIncome } from './finances.ts';
import { getSquadHarmony } from './harmony.ts';
import { processMatchAftermath, recentNews } from './news.ts';
import { fitnessTick } from './fitness.ts';
import { moraleTick } from './morale.ts';

const PORT = Number.parseInt(process.env.FOOTY_PORT ?? '4000', 10);
// Give any pre-market league a free-agent pool + every player a potential (one-time,
// idempotent backfills for saves that predate pillars 1 & 2).
backfillFreeAgents();
backfillPotentials();
backfillContracts();
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
function requireUser(req: any, reply: any): User | null {
  const u = currentUser(req);
  if (!u) { reply.code(401).send({ error: 'not logged in' }); return null; }
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
  return { planText: text, plan, note: r.note || '', error: r.error || null };
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
app.post('/api/press', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const text = String(req.body?.text ?? '').trim().slice(0, 400);
  if (!text) return reply.code(400).send({ error: 'say something to the media' });
  const r = await applyPressConference(teamId, text);
  return { ...r, team: getTeamWithPlayers(teamId) };
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
    'SELECT id, round, home_team_id, away_team_id, played, home_score, away_score FROM fixtures WHERE league_id = ? ORDER BY round, id',
  ).all(leagueId) as any[]).map(f => ({
    id: f.id, round: f.round,
    home: names.get(f.home_team_id), away: names.get(f.away_team_id),
    homeTeamId: f.home_team_id, awayTeamId: f.away_team_id,
    played: !!f.played, homeScore: f.home_score, awayScore: f.away_score,
    involvesMe: f.home_team_id === teamId || f.away_team_id === teamId,
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
  const result = await playFixture(fx.id);
  return { result, standings: standings(team.leagueId) };
});

// Post-match report + ratings for a played fixture (cached; generated from the recording on
// first view). 404 if the match has no recording (e.g. a distant AI-vs-AI game).
app.get('/api/report', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
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
  return { news: recentNews(teamId) };
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
const advancing = new Set<number>();   // per-user lock: a matchday mutates many tables + plays
app.post('/api/advance', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  // serialise per user so two overlapping advances (two tabs, a mid-request refresh) can't
  // double-run the ticks or duplicate a cup round.
  if (advancing.has(user.id)) return reply.code(409).send({ error: 'a matchday is already in progress' });
  advancing.add(user.id);
  try {
  const team = getTeamWithPlayers(teamId)!;
  const leagues = worldLeagues(team.leagueId);
  // the round number the user's own division is completing this matchday (for the UI)
  const userRound = (db.prepare('SELECT MIN(round) AS r FROM fixtures WHERE league_id = ? AND played = 0').get(team.leagueId) as { r: number | null }).r;
  const toPlay = pendingMatchday(team.leagueId);
  if (!toPlay.length) return reply.code(404).send({ error: 'season complete' });
  const results = await Promise.all(toPlay.map(id => playFixture(id)));
  // the user's match this matchday (null if they'd already played/watched it ahead)
  const myFx = userRound == null ? null
    : db.prepare('SELECT id FROM fixtures WHERE league_id = ? AND round = ? AND (home_team_id = ? OR away_team_id = ?) LIMIT 1').get(team.leagueId, userRound, teamId, teamId) as { id: number } | undefined;
  const myResult = myFx ? results.find(r => r.fixtureId === myFx.id) ?? null : null;
  // The world progresses between matchdays: condition drains + injuries land (before any
  // squad changes, so "who played" is the XI as it lined up), AI clubs trade + manage, then
  // every player trains.
  const transfers: any[] = [];
  const listingsExpired: any[] = [];   // §2.4: the user's listings that lapsed unsold at the window deadline
  const incomingBids: any[] = [];      // §2.1: other clubs bidding for the user's listed players this matchday
  const injuries: any[] = [];
  const contractEvents: any[] = [];
  let income = 0;                       // §P2: the user's matchday gate & TV income this tick
  let developed = 0;
  for (const l of leagues) {
    income += payMatchdayIncome(l.id).filter(e => e.teamId === teamId).reduce((s, e) => s + e.amount, 0);
    injuries.push(...fitnessTick(l.id)); moraleTick(l.id);
    const mkt = marketTick(l.id);
    transfers.push(...mkt.filter(e => e.type === 'sign' || e.type === 'buy_listed'));
    listingsExpired.push(...mkt.filter(e => e.type === 'listing_expired' && e.teamId === teamId));
    incomingBids.push(...mkt.filter(e => e.type === 'incoming_bid' && e.teamId === teamId));
    contractEvents.push(...processContractOffers(l.id)); aiManagerTick(l.id); developed += developmentTick(l.id).players;
  }
  // The cup is spread across the season — round R plays once the league reaches matchday R*3,
  // so it concludes (the final at matchday 12) before the season rolls over.
  let cup: { round: number; champion: number | null; myTie: { homeScore: number; awayScore: number; opponent: string; won: boolean } | null } | null = null;
  const pend = pendingCupRound(team.leagueId);
  if (pend && userRound != null && pend.round * 3 <= userRound) {
    await Promise.all(pend.tieIds.map(id => playCupTie(id)));
    const adv = advanceCupRound(team.leagueId, pend.round);
    cup = { round: pend.round, champion: adv?.champion ?? null, myTie: cupTieFor(teamId, team.leagueId, pend.round) };
  }
  // The match aftermath for the user's players: rating -> morale + season tally, and notable
  // events (hat-trick, red card, long injury…) become news + evolve the backstory/dials.
  // Background + best-effort, like the personality backfill; fired before rollover so the squad
  // map + the season tally reflect the match just played (rollover then crowns the awards).
  if (myFx) void processMatchAftermath(teamId, myFx.id, injuries).catch(() => { /* aftermath is ambient */ });
  // End of season? Roll it over and report the new standings of whichever division the
  // user now sits in (they may have just been promoted or relegated).
  const rollover = seasonComplete(team.leagueId) ? rolloverSeason(team.leagueId) : null;
  // a rollover may have brought academy regens through — give them LLM backstories + dials in
  // the background (best-effort; never blocks the response, never touches established players).
  if (rollover) void fillMissingPersonalities(teamId).catch(() => { /* regens stay neutral on failure */ });
  const nowLeagueId = getTeamWithPlayers(teamId)!.leagueId;
  return {
    round: userRound, myFixtureId: myFx?.id ?? null, myResult, results,
    transfers, development: { players: developed }, injuries, cup, rollover,
    contractOffers: contractEvents.filter(e => e.teamId === teamId),   // §2.2: my renewal verdicts this matchday
    listingsExpired,   // §2.4: my listings that lapsed unsold
    incomingBids,      // §2.1: other clubs bidding for my listed players
    income,            // §P2: matchday gate & TV income credited this tick
    standings: standings(nowLeagueId),
  };
  } finally { advancing.delete(user.id); }
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

const server = app.server;
await app.listen({ port: PORT, host: '127.0.0.1' });
console.log(`footy game server on http://localhost:${PORT}`);

// ── match-watch WebSocket: /ws/match?fixture=ID (re-runs the deterministic sim) ──
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '', `http://${request.headers.host}`);
  if (url.pathname !== '/ws/match') { socket.destroy(); return; }
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
      new MatchStream(ws as any, writeSpec(fx), fx.seed, homeName, awayName, myTeam, seedPlan, canShout);
    } catch (e) { ws.close(); }
  });
});
