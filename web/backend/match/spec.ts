// Spec construction: the DB's view of two clubs -> the JSON object the engine consumes. The
// oldest invariant in the repo lives here (GAME_LAYER_NOTES.md:25) — a default 4-3-3 identity XI
// must emit a BYTE-IDENTICAL spec — so every field added since is conditional on opting in.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { db } from '../db.ts';
import { getTeamWithPlayers, fieldedXIIndices, DEFAULT_TACTICS, type SetPieceTakers } from '../game.ts';
import { getTeamTalkDeltas } from '../teamtalk.ts';
import type { Directive } from '../tactics.ts';
import { FORMATIONS, DEFAULT_FORMATION, PITCH_W, engineRole } from '../formations.ts';
import { MINUTES, SPEC_DIR } from './runtime.ts';
import { weatherForSeed } from './weather.ts';

interface Fixture {
  id: number; league_id: number; home_team_id: number; away_team_id: number;
  seed: number; played: number; home_score: number | null; away_score: number | null;
}

export function getFixture(id: number): Fixture | null {
  return (db.prepare('SELECT * FROM fixtures WHERE id = ?').get(id) as Fixture | undefined) ?? null;
}

const isIdentityXI = (lineup: number[] | null): boolean =>
  !lineup || lineup.every((v, i) => v === i);

// Resolve a persisted plan (TEAM-RELATIVE squad-slot ids, teamScope 0) to THIS match's engine ids.
// slotToEngine maps a squad slot to its POSITION in the emitted spec.players — which differs from
// slot order under a custom XI, a non-default formation, or an injury-cover swap, so a directive
// must be translated through it (not just +11'd). A per-player order whose slot isn't in the
// fielded XI is dropped; team-wide orders take the side's teamScope; the away side then shifts
// engine ids by +11. (Pre-match plans carry no man_mark of a specific opponent — only a
// target_player's team-mate target is remapped.)
function resolvePlanDirectives(dirs: Directive[] | undefined, slotToEngine: Map<number, number>, side: 'home' | 'away'): Directive[] {
  if (!dirs?.length) return [];
  const off = side === 'away' ? 11 : 0;
  const out: Directive[] = [];
  for (const d of dirs) {
    if (d.teamScope === 0 || d.teamScope === 1) { out.push({ ...d, teamScope: side === 'away' ? 1 : 0 }); continue; }
    const eng = slotToEngine.get(d.playerId);
    if (eng === undefined) continue;                      // that slot isn't on the pitch — drop the order
    const r: Directive = { ...d, playerId: eng + off };
    if (d.kind === 'target_player' && typeof d.targetId === 'number') {
      const tEng = slotToEngine.get(d.targetId);
      if (tEng === undefined) continue;                   // the team-mate to feed isn't fielded — drop
      r.targetId = tEng + off;
    }
    out.push(r);
  }
  return out;
}

// Returns the per-team spec object + this side's engine-id-resolved standing directives (combined
// into the top-level spec.directives by buildTieSpec). A HUMAN team's dials are forced neutral —
// the plain-English plan (directives) is the manager's only tactical input now; AI keeps its dials.
function specForTeam(teamId: number, side: 'home' | 'away', talk?: Map<number, number>): { spec: Record<string, unknown>; directives: Directive[] } {
  const t = getTeamWithPlayers(teamId);
  if (!t) throw new Error(`team ${teamId} not found`);
  const tactics = t.userId != null ? DEFAULT_TACTICS : t.tactics;
  const bySlot = t.players.slice().sort((a, b) => a.slot - b.slot);
  const formation = t.formation ?? DEFAULT_FORMATION;
  const layout = FORMATIONS[formation];
  // The fielded XI as squad-slot INDICES, in formation order — via fieldedXIIndices, the ONE selection
  // shared with fitnessTick so "who played" can never diverge from "who got drained" (a fully fit squad
  // on the default shape is byte-identical; a custom XI / non-default shape / injury-cover swap reorders).
  const xiIdx = fieldedXIIndices(bySlot, p => !!p.injuredMatches, formation, t.lineup);
  // squad slot -> position in the emitted spec.players (the engine id) — differs from slot order under a
  // custom XI / a non-default formation / an injury-cover swap, so the plan resolves through it.
  const slotToEngine = new Map<number, number>();
  let players: Record<string, unknown>[];
  // Byte-identical guard: a team on the default shape with the identity XI emits the
  // exact pre-formation spec (no role/anchor fields) — so every existing team plays
  // precisely as before. Only an opted-in team (non-default formation OR a reordered
  // XI) gets an explicit per-slot layout.
  if ((formation === DEFAULT_FORMATION && isIdentityXI(t.lineup)) || !layout) {
    // personality rides along (engine ignores it) so the watch flow can read each
    // player's personality by engine id without re-deriving the lineup order. The bench
    // depth (slots 11+, added by the transfer market) stays out of the match.
    const xi = xiIdx.map(i => bySlot[i]);
    // §2.13: a pre-match team talk rides in as players[].moraleBoost (engine reads it at kickoff). Only
    // added when a talk gave this player a non-zero delta — no talk ⇒ no field ⇒ byte-identical spec.
    players = xi.map(p => { const mb = talk?.get(p.slot); return { name: p.name, attrs: p.attrs, foot: p.foot, personality: p.personality ?? null, ...(mb ? { moraleBoost: mb } : {}) }; });
    xi.forEach((p, i) => slotToEngine.set(p.slot, i));
  } else {
    // Emit per-slot role + home anchor. The away side mirrors x (PITCH_W - x) to match
    // the engine's away frame; width (y) is shared. Slot 0 stays the keeper (the engine
    // pins it regardless). xiIdx[i] = which squad slot fills formation slot i (an injured
    // pick already swapped for the best fit, unused player by fieldedXIIndices).
    players = layout.map((slot, i) => {
      const p = bySlot[xiIdx[i]] ?? bySlot[i];
      slotToEngine.set(p.slot, i);
      const mb = talk?.get(p.slot);
      return {
        name: p.name, attrs: p.attrs, foot: p.foot, role: engineRole(slot.role), personality: p.personality ?? null,
        homeX: side === 'away' ? PITCH_W - slot.x : slot.x,
        homeY: slot.y,
        ...(mb ? { moraleBoost: mb } : {}),
      };
    });
  }
  // Set-piece takers (user-watch): the manager's designated FK/corner/pen/long-throw takers ride in as
  // per-player directives (playerId = squad slot) that resolve to engine ids alongside the plan. A taker
  // who isn't in the fielded XI is dropped by resolvePlanDirectives → the engine falls back to its default.
  // These kinds are read end-to-end now: the engine maps fk_taker/corner_taker/pen_taker/long_throw_taker
  // via designatedTakerFor and honours them at the restart (engine_setpiece.cpp). Truly unknown kinds are
  // still ignored by the engine (main.cpp `else continue`) — but the backend never emits those.
  const directives = resolvePlanDirectives([...(t.plan?.directives ?? []), ...setPieceTakerDirectives(t.setPieceTakers)], slotToEngine, side);
  return { spec: { name: t.name, tactics, players }, directives };
}

// Build the per-player set-piece-taker directives the engine reads at a restart (omits any taker left on
// the default). Kinds: fk_taker | corner_taker | pen_taker | long_throw_taker; playerId = squad slot.
function setPieceTakerDirectives(takers: SetPieceTakers | null): Directive[] {
  if (!takers) return [];
  const out: Directive[] = [];
  if (takers.fk != null) out.push({ kind: 'fk_taker', playerId: takers.fk });
  if (takers.corner != null) out.push({ kind: 'corner_taker', playerId: takers.corner });
  if (takers.pen != null) out.push({ kind: 'pen_taker', playerId: takers.pen });
  if (takers.longThrow != null) out.push({ kind: 'long_throw_taker', playerId: takers.longThrow });
  return out;
}

// Build a match spec for two teams (shared by league fixtures + cup ties). Each team's persisted
// standing plan is resolved to engine ids and merged into the top-level `directives` the engine
// reads (home 0-10, away +11) — omitted entirely when neither team has a plan, so AI-vs-AI specs
// are unchanged. Tactics dials are neutral for human teams (their plan is the tactical input).
export function buildTieSpec(homeTeamId: number, awayTeamId: number, seed: number, fixtureId?: number) {
  // §2.13: fold each side's pre-match team talk (if any) into its players' moraleBoost. No talk ⇒ empty
  // map ⇒ no moraleBoost field ⇒ the spec is byte-identical (AI-vs-AI + untouched fixtures unchanged).
  const homeTalk = fixtureId != null ? getTeamTalkDeltas(homeTeamId, fixtureId) : undefined;
  const awayTalk = fixtureId != null ? getTeamTalkDeltas(awayTeamId, fixtureId) : undefined;
  const home = specForTeam(homeTeamId, 'home', homeTalk && homeTalk.size ? homeTalk : undefined);
  const away = specForTeam(awayTeamId, 'away', awayTalk && awayTalk.size ? awayTalk : undefined);
  const directives = [...home.directives, ...away.directives];
  const spec: Record<string, unknown> = { seed, minutes: MINUTES, home: home.spec, away: away.spec };
  if (directives.length) spec.directives = directives;
  const weather = weatherForSeed(seed);
  if (weather !== 'clear') spec.weather = weather;       // omit 'clear' ⇒ byte-identical with weather-free specs
  return spec;
}
export function buildSpec(fixture: Fixture) {
  return buildTieSpec(fixture.home_team_id, fixture.away_team_id, fixture.seed, fixture.id);
}

export function writeSpec(fixture: Fixture): string {
  const spec = buildSpec(fixture);
  const file = path.join(SPEC_DIR, `fixture-${fixture.id}.json`);
  writeFileSync(file, JSON.stringify(spec));
  return file;
}
