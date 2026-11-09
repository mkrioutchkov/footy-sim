// §2.13 pre-match team talk. Throwaway FOOTY_DB; no engine. Asserts: the deterministic tone→delta model
// reacts to personality the way the live shouts do (criticism fires the thick-skinned / wilts the
// sensitive, praise lifts but big egos coast, calm settles nerves, the occasion rouses big-game players);
// a set talk rides into the match spec as players[].moraleBoost on the manager's side only; no talk leaves
// the spec byte-identical (no moraleBoost field); and the talk is consumed when the match plays.
//
//   npx tsx tools/_teamtalk_test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'footy-talk-'));
process.env.FOOTY_DB = path.join(tmp, 'test.sqlite');
process.env.TACTICS_LLM_API_KEY = '';

let pass = 0, fail = 0;
function check(c: boolean, m: string): void { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } }

const { db } = await import('../web/backend/db.ts');
const { registerUser } = await import('../web/backend/auth.ts');
const game = await import('../web/backend/game.ts');
const match = await import('../web/backend/match.ts');
const tt = await import('../web/backend/teamtalk.ts');
import type { Traits } from '../web/backend/personality.ts';

const T = (over: Partial<Traits>): Traits => ({ temperament: 50, criticismResponse: 50, praiseResponse: 50, bigGame: 50, consistency: 50, leadership: 50, professionalism: 50, ego: 50, ...over });

// ── tone → delta model (deterministic, personality-gated) ─────────────────────────────────────
check(tt.talkDelta(T({ criticismResponse: 90 }), 'demand') > 0.1, 'demand fires up a player who thrives on a rocket');
check(tt.talkDelta(T({ criticismResponse: 10 }), 'demand') < -0.1, 'demand wilts a thin-skinned player');
check(Math.abs(tt.talkDelta(T({}), 'demand')) < 0.05, 'demand barely moves a perfectly neutral player');
// every tone is ~0 for a perfectly neutral squad — a talk rewards a VARIED squad, never a free blanket lift
check(Math.abs(tt.talkDelta(T({}), 'believe')) < 0.05, 'believe barely moves a perfectly neutral player (no free lift)');
check(Math.abs(tt.talkDelta(T({}), 'calm')) < 0.05, 'calm barely moves a perfectly neutral player');
check(Math.abs(tt.talkDelta(T({}), 'fire_up')) < 0.05, 'fire_up barely moves a perfectly neutral player');
check(tt.talkDelta(T({ praiseResponse: 90 }), 'believe') > tt.talkDelta(T({ praiseResponse: 10 }), 'believe'), 'belief lifts a praise-responsive player more');
check(tt.talkDelta(T({ ego: 95 }), 'believe') < tt.talkDelta(T({ ego: 50 }), 'believe'), 'a big ego coasts on belief (complacency)');
check(tt.talkDelta(T({ bigGame: 10 }), 'calm') > 0.1, 'calm settles a player who freezes on the big day');
check(tt.talkDelta(T({ temperament: 95 }), 'calm') > tt.talkDelta(T({ temperament: 50 }), 'calm'), 'calm helps a hot-head more');
check(tt.talkDelta(T({ bigGame: 95 }), 'fire_up') > 0.2, 'firing up rouses a big-game player');
check(tt.talkDelta(T({ bigGame: 10 }), 'fire_up') < 0, 'firing up overwhelms a player who shrinks from the occasion');
// bounded to ±0.5 at the extremes of every dial
for (const tone of ['believe', 'demand', 'calm', 'fire_up'] as const)
  for (const v of [0, 100])
    check(Math.abs(tt.talkDelta(T({ temperament: v, criticismResponse: v, praiseResponse: v, bigGame: v, leadership: v, ego: v }), tone)) <= 0.5, `delta stays within ±0.5 (${tone}, all dials ${v})`);
check(tt.isTalkTone('believe') && !tt.isTalkTone('nonsense'), 'tone validation accepts known tones only');

// ── integration: the talk rides into the match spec as moraleBoost, manager's side only ─────────
const u = registerUser('orator', 'secret');
const { teamId, worldId } = game.newSeasonForUser(u.id, u.username, 'Talkers FC', game.DEFAULT_TACTICS);
// give three of the XI praise-responsive personalities so a 'believe' talk lands a positive moraleBoost
// (with the fix, a neutral player gets ~0 — the talk rewards a varied squad, not a blanket lift)
const eager = JSON.stringify({ traits: { ...{ temperament: 50, criticismResponse: 50, praiseResponse: 90, bigGame: 50, consistency: 50, leadership: 50, professionalism: 50, ego: 40 } }, nationality: '', backstory: '', tagline: '' });
for (const slot of [0, 1, 2]) db.prepare('UPDATE players SET personality = ? WHERE team_id = ? AND slot = ?').run(eager, teamId, slot);
const fxRow = db.prepare('SELECT id FROM fixtures WHERE (home_team_id = ? OR away_team_id = ?) AND played = 0 ORDER BY round, id LIMIT 1').get(teamId, teamId) as { id: number };
const fx = match.getFixture(fxRow.id)!;
const mySide: 'home' | 'away' = fx.home_team_id === teamId ? 'home' : 'away';
const theirSide = mySide === 'home' ? 'away' : 'home';
const playersOf = (spec: any, side: string) => spec[side].players as Record<string, unknown>[];
const anyMB = (spec: any) => playersOf(spec, 'home').concat(playersOf(spec, 'away')).some(p => 'moraleBoost' in p);

// no talk → byte-identical (no moraleBoost field anywhere)
check(!anyMB(match.buildSpec(fx)), 'with no talk the spec carries no moraleBoost (byte-identical)');

const set = tt.setTeamTalk(teamId, fx.id, 'believe');
check(set.ok && set.reactions.length > 0, 'a team talk previews a reaction per squad player');
check(tt.getTeamTalkDeltas(teamId, fx.id).size > 0, 'the talk stores per-slot morale deltas');
check(tt.pendingTalk(teamId, fx.id)?.tone === 'believe', 'the pending talk reads back its tone');

const spec1 = match.buildSpec(fx);
check(playersOf(spec1, mySide).some(p => typeof p.moraleBoost === 'number' && (p.moraleBoost as number) > 0), 'my XI carries the talk as a positive moraleBoost');
check(playersOf(spec1, theirSide).every(p => !('moraleBoost' in p)), 'the opponent is unaffected by my talk');

// re-setting replaces (one talk per fixture)
tt.setTeamTalk(teamId, fx.id, 'calm');
check(tt.pendingTalk(teamId, fx.id)?.tone === 'calm', 'a new talk supersedes the prior one');

// consumed once the match is played
tt.consumeTeamTalk(fx.id);
check(tt.getTeamTalkDeltas(teamId, fx.id).size === 0, 'the talk is consumed (spent on the match)');
check(!anyMB(match.buildSpec(fx)), 'after consumption the spec is byte-identical again');

// ── rollover purges an unplayed talk whose fixture is about to vanish (review fix: no orphan rows) ──
const season = await import('../web/backend/season.ts');
tt.setTeamTalk(teamId, fx.id, 'believe');                       // a stored talk (slots 0-2 are praise-responsive)
check(tt.getTeamTalkDeltas(teamId, fx.id).size > 0, 'a fresh talk is stored before rollover');
for (const lid of season.worldLeagues(worldId).map(l => l.id)) db.prepare('UPDATE fixtures SET played = 1, home_score = 1, away_score = 0 WHERE league_id = ?').run(lid);   // force the season complete (bypasses playFixture's consume)
check(!!season.rolloverSeason(worldId), 'the season rolled over');
check(tt.getTeamTalkDeltas(teamId, fx.id).size === 0, 'rollover purges the unplayed talk for the vanished fixture (no orphan rows)');

db.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
