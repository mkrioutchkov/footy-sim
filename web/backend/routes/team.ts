// routes/team.ts — the club itself: creation, squad + personalities, captain, set-piece takers,
// team talks, the youth academy, the standing plan (text / quick / structured), tactics sliders,
// lineup & formation. Split out of index.ts (its '── team / league ──' section).
import type { FastifyInstance } from 'fastify';
import { db } from '../db.ts';
import { newSeasonForUser, getTeamWithPlayers, teamForUser, assignPersonalities, needsPersonalities, DEFAULT_TACTICS } from '../game.ts';
import { aiListSurplus, seedReleaseClauses } from '../market.ts';
import { compileLineup } from '../lineup.ts';
import { FORMATIONS, PITCH_W, roleFit } from '../formations.ts';
import { compileInitialPlan, QUICK_TACTICS, buildQuickPlan, type QuickTactic } from '../plan.ts';
import { sanitizeStructuredDirectives } from '../tactics.ts';
import { seedAcademy, getAcademy, promoteProspect } from '../youth.ts';
import { TALK_TONES, isTalkTone, setTeamTalk, pendingTalk, previewTalk } from '../teamtalk.ts';
import { requireUser, requireTeam, validTactics, idParam } from './shared.ts';

export function registerTeamRoutes(app: FastifyInstance): void {
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
    const teamId = requireTeam(req, reply); if (teamId == null) return;
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
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const raw = req.body?.slot;
    if (raw == null || Number(raw) === -1) { db.prepare('UPDATE teams SET captain_slot = NULL WHERE id = ?').run(teamId); return { ok: true, captainSlot: null }; }
    const slot = idParam(reply, raw, 'slot'); if (slot == null) return;   // (the null / -1 "clear" sentinels are handled above)
    if (!db.prepare('SELECT 1 FROM players WHERE team_id = ? AND slot = ?').get(teamId, slot)) return reply.code(404).send({ error: 'no such player in your squad' });
    db.prepare('UPDATE teams SET captain_slot = ? WHERE id = ?').run(slot, teamId);
    return { ok: true, captainSlot: slot };
  });

  // Set-piece takers (user-watch): designate FK / corner / penalty / long-throw takers (squad slots; null =
  // the engine's default). Validated against the squad; emitted as per-player directives the engine reads at
  // the restart. getTeamWithPlayers returns the current selection (team.setPieceTakers), so no GET needed.
  app.post('/api/set-piece-takers', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
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
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const fixtureId = Number(req.query?.fixture);
    const chk = ownUnplayedFixture(teamId, fixtureId);
    if (!chk.ok) return reply.code(chk.code).send({ error: chk.error });
    const pending = pendingTalk(teamId, fixtureId);
    const tone = isTalkTone(req.query?.tone) ? req.query.tone : (pending?.tone ?? 'believe');
    return { tones: TALK_TONES, pending, tone, reactions: previewTalk(teamId, tone) };
  });
  app.post('/api/teamtalk', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const fixtureId = Number(req.body?.fixtureId);
    const chk = ownUnplayedFixture(teamId, fixtureId);
    if (!chk.ok) return reply.code(chk.code).send({ error: chk.error });
    if (!isTalkTone(req.body?.tone)) return reply.code(400).send({ error: 'unknown tone' });
    return setTeamTalk(teamId, fixtureId, req.body.tone);
  });

  // §2.9: the youth academy — the club's developing prospects + promote one to the senior squad.
  app.get('/api/academy', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    return { prospects: getAcademy(teamId) };
  });
  app.post('/api/academy/:id/promote', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const prospectId = idParam(reply, req.params?.id, 'prospect id'); if (prospectId == null) return;
    const r = promoteProspect(teamId, prospectId);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return { ...r, prospects: getAcademy(teamId) };
  });

  // Set the club's plain-English STANDING tactical plan: compile it to directives (team-relative
  // ids) and persist both the text + the compiled plan. Empty text clears the plan. Graceful — if
  // the compiler is unreachable, the text is saved with no directives + a note (plays the neutral base).
  app.post('/api/team/plan', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
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
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const preset = String(req.body?.preset ?? '');
    if (!(preset in QUICK_TACTICS)) return reply.code(400).send({ error: 'unknown preset' });
    const plan = buildQuickPlan(preset as QuickTactic, 0);   // team-relative scope; resolved to engine ids at spec-build
    const text = QUICK_TACTICS[preset as QuickTactic].text;
    db.prepare('UPDATE teams SET plan_text = ?, plan_directives = ? WHERE id = ?')
      .run(text, plan.directives.length ? JSON.stringify(plan) : null, teamId);
    return { planText: text, plan };
  });

  app.put('/api/tactics', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
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
    const teamId = requireTeam(req, reply); if (teamId == null) return;
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
    const teamId = requireTeam(req, reply); if (teamId == null) return;
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
    const teamId = requireTeam(req, reply); if (teamId == null) return;
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
    const teamId = requireTeam(req, reply); if (teamId == null) return;
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
}
