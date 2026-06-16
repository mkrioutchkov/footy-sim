// Composite-plan editor + motivation (items 3 + the 4.3 driver). The tactics box
// becomes STATEFUL: the team carries a running "composite plan" (a human summary +
// the structured directives the engine runs). Each shout is an EDIT against that
// plan, not a fresh compile — amend one player, overhaul, nuke ("forget all that"),
// or no tactical change at all (a pure bollocking → motivation only). The same call
// also judges the shout's MOTIVATIONAL effect using the addressed player's
// personality, returning morale deltas the live flow folds into the engine's
// moraleBoost hook. Same provider/env as tactics.ts; reuses its directive vocab.
import { type Directive, type Side, VALID_KINDS, TEAM_KIND_SET } from './tactics.ts';
import { FORMATIONS, normalizeFormation } from './formations.ts';

const BASE = (process.env.TACTICS_LLM_BASE_URL ?? 'https://api.groq.com/openai/v1').replace(/\/$/, '');
const MODEL = process.env.TACTICS_LLM_MODEL ?? 'llama-3.3-70b-versatile';
const KEY = process.env.TACTICS_LLM_API_KEY ?? '';

export interface Plan { summary: string; directives: Directive[]; }
export interface Motivation { playerId: number; moraleDelta: number; reaction: string; durationMin: number; }
export interface PlanResult { plan: Plan; changed: string; motivation: Motivation[]; note: string; formation?: string | null; raw?: string; error?: string; }
export interface SquadPlayer {
  id: number; name: string; role: string;
  personality?: { traits?: Record<string, number>; tagline?: string } | null;
  morale?: number; motivationUsed?: number;
}
export interface PlanCtx { minute?: number; score?: string; }

export const EMPTY_PLAN: Plan = { summary: 'No standing instructions yet.', directives: [] };
const MOTIVATION_CAP = 2;     // motivation changes per player per game (tactical edits uncapped)
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clampInt = (v: unknown, lo: number, hi: number, d: number) => Math.max(lo, Math.min(hi, Math.round(num(v, d))));
const initialsOf = (name: string) => name.split(/\s+/).filter(Boolean).map(w => w[0]).join('').toUpperCase();

// The motivation-relevant trait dials, summarised compactly for the prompt.
function personaTag(p: SquadPlayer): string {
  const t = p.personality?.traits;
  if (!t) return '';
  const cr = num(t.criticismResponse, 50), pr = num(t.praiseResponse, 50), ego = num(t.ego, 50), temp = num(t.temperament, 50);
  return ` {crit ${cr} praise ${pr} ego ${ego} temp ${temp}, morale ${num(p.morale, 50)}, motUsed ${num(p.motivationUsed, 0)}/${MOTIVATION_CAP}}`;
}

function squadContext(mine: SquadPlayer[], opp: { id: number; name: string; role: string }[]): string {
  const meLine = mine.slice(0, 11).map(p => `id${p.id} ${p.name} [${initialsOf(p.name)}](${p.role})${personaTag(p)}`).join('\n  ');
  const oppLine = opp.slice(0, 11).map(p => `id${p.id} ${p.name} [${initialsOf(p.name)}](${p.role})`).join(', ');
  return `YOUR SQUAD:\n  ${meLine}\nOPPONENT: ${oppLine}`;
}

function planText(plan: Plan): string {
  if (!plan.directives.length) return `${plan.summary || EMPTY_PLAN.summary}\n  (no directives)`;
  const lines = plan.directives.map(d => {
    const who = d.teamScope !== undefined && d.teamScope >= 0 ? 'TEAM' : `id${d.playerId}`;
    const tgt = d.targetId !== undefined && d.targetId >= 0 ? ` -> id${d.targetId}` : '';
    return `  - ${who}: ${d.kind}${tgt}`;
  });
  return `${plan.summary || ''}\n${lines.join('\n')}`;
}

const SYSTEM = (myTeam: Side, myIds: string, oppIds: string, myScope: number) => `You are the manager's voice, holding a STATEFUL composite plan and editing it per each shout, while ALSO judging the shout's motivational effect on the player addressed. You manage ${myTeam.toUpperCase()} (your ids ${myIds}; opponent ${oppIds}). Output ONLY this JSON object — no prose, no markdown:
{"plan":{"summary":"<=2 sentences, plain English, the whole standing plan AFTER this shout","directives":[ ...the FULL directive set after the edit... ]},"changed":"<=1 line on what this shout changed (or 'No tactical change.')","motivation":[{"playerId":<your id>,"moraleDelta":-30..30,"reaction":"<short in-character line>","durationMin":<5-30>}],"formation":"<a shape key below, ONLY if the shout asks to change formation; else null>","note":""}

STEP 1 — FORMATION CHECK (do this FIRST): does the shout name a team SHAPE? A number ("4-3-3","go 4 4 2","4-1-2-1-2","442") OR a name ("diamond","midfield diamond","christmas tree","three at the back","back three","two up top","five at the back"). If YES: set "formation" to the matching key from [${Object.keys(FORMATIONS).join(', ')}] and DO NOT convert the shape into directives — the engine re-shapes the team itself. Keep "directives" exactly as the prior plan. (You may STILL add a separate explicit order in the same shout: "go 3-5-2 and AB mark their man" => formation "3-5-2" + that one man_mark.) If the shout names NO shape, "formation":null and continue.
EXAMPLES: "go 4-4-2" => formation "4-4-2", directives unchanged. "switch to a diamond" => formation "4-1-2-1-2". "three at the back" => formation "3-5-2". "AB mark their striker" => formation null.

STEP 2 — EDIT THE PLAN BY INTENT (for the non-formation part of the shout):
- amend one player / add an order  -> keep the rest of "directives", add or replace just that one.
- overhaul (a broad new set of TACTICAL orders — NOT a formation) -> rewrite directives broadly.
- nuke ("forget all that", "scrap it", "back to normal") -> directives: [] and say so in "changed".
- no tactical content (pure praise/abuse/rant) -> directives UNCHANGED (echo them back verbatim); "changed":"No tactical change."
"directives" is ALWAYS the complete plan after the edit (not just this shout's delta) — the engine runs exactly what you return. NEVER turn a formation/shape into stay_wide/sit_deep/get_forward directives — that is what "formation" is for.

DIRECTIVES (same vocabulary as the tactics compiler):
{"playerId":<id, per-player kinds>,"kind":"<kind>","targetId":<id, man_mark/target_player only>,"intensity":0.1-1,"teamScope":${myScope} <team-wide kinds, no playerId>,"when":{"fromMin","toMin","scoreState","scoreBy"}}
per-player: man_mark target_player shoot_on_sight get_forward sit_deep stay_wide come_inside stay_central cross_early switch_play play_simple run_in_behind make_runs dribble_more press_hard tackle_hard stay_on_feet.
team-wide (teamScope ${myScope}): all_out_attack park_the_bus high_press drop_off play_it_long keep_it_on_ground get_it_wide play_narrow push_up slow_it_down counter_attack offside_trap.
Resolve names/initials from the squad (tolerate typos); man_mark targets are OPPONENT ids, target_player targets are TEAM-MATE ids. Never invent a player not in a squad — omit + note. OMIT "when" unless the shout states a time/score.

MOTIVATION (the shout's emotional effect — separate from tactics):
- Judge from the addressed player's PERSONALITY, not the literal words: criticismResponse HIGH => a rocket FIRES them up (positive delta); LOW => they wilt (negative). praiseResponse scales how much praise lifts. High ego => praise risks complacency (smaller/negative). temperament high => bigger swings.
- A purely motivational shout (no tactic) => directives unchanged, motivation only. A purely tactical shout => motivation usually []. moraleDelta in -30..30; durationMin 5-30.
- CAP: each player's "motUsed" is shown. If a player is already at ${MOTIVATION_CAP}, do NOT add motivation for them (skip; mention in note). Motivation is scarce + meaningful.
- "we/lads/everyone" addressed motivationally => you may move a few key players, not all 11.

NOTE: short, only for a problem (unknown player, ambiguous, nonsense/abuse-with-no-target). "" when clean.`;

function extract(content: string): Record<string, unknown> {
  const body = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { const v = JSON.parse(body); if (v && typeof v === 'object') return v as Record<string, unknown>; } catch { /* salvage */ }
  const s = content.indexOf('{'), e = content.lastIndexOf('}');
  if (s >= 0 && e > s) { try { const v = JSON.parse(content.slice(s, e + 1)); if (v && typeof v === 'object') return v as Record<string, unknown>; } catch { /* noop */ } }
  return {};
}

const TIME_WORDS = /\b(\d{1,3}\s*(?:'|min|mins|minute|minutes)|half|first|second|opening|closing|last|from the|after the|until|before|kick.?off|whistle|early on|late on)\b/i;
const SCORE_WORDS = /\b(winning|losing|drawing|level|tied|all square|ahead|behind|trailing|chasing|in front|leading|protect|see it out|goal up|goal down|a man (?:up|down)|nil|equaliser|equalizer)\b/i;

// Validate the returned plan's directives (same rules as tactics.ts) + motivation
// (id range, clamp, enforce the per-player cap from motUsed). Deterministic given
// the model output, so cached replays stay identical.
function validate(raw: Record<string, unknown>, myTeam: Side, shout: string, mineIds: Set<number>, oppIds: Set<number>, motUsed: Map<number, number>): { plan: Plan; changed: string; motivation: Motivation[]; note: string; formation: string | null } {
  const myScope = myTeam === 'home' ? 0 : 1;
  const planRaw = (raw.plan ?? {}) as Record<string, unknown>;
  const timeOK = TIME_WORDS.test(shout), scoreOK = SCORE_WORDS.test(shout);
  const directives: Directive[] = [];
  for (const r of (Array.isArray(planRaw.directives) ? planRaw.directives : [])) {
    if (!r || typeof r !== 'object') continue;
    const d = r as Record<string, unknown>;
    const kind = String(d.kind ?? '');
    if (!VALID_KINDS.has(kind)) continue;
    const intensity = Math.max(0, Math.min(1, num(d.intensity, 1)));
    let dir: Directive;
    if (TEAM_KIND_SET.has(kind)) {
      const ts = num(d.teamScope, myScope);
      dir = { playerId: -1, teamScope: ts === 0 || ts === 1 ? ts : myScope, kind, intensity };
    } else {
      const pid = num(d.playerId, -1);
      if (!mineIds.has(pid) && !oppIds.has(pid)) continue;
      dir = { playerId: pid, kind, intensity };
      if (kind === 'man_mark') {
        const t = num(d.targetId, -1);
        if (!oppIds.has(t)) continue;          // mark an OPPONENT (else the engine ignores it)
        dir.targetId = t;
      } else if (kind === 'target_player') {
        const t = num(d.targetId, -1);
        if (!mineIds.has(t)) continue;         // feed a TEAM-MATE
        dir.targetId = t;
      }
    }
    const w = (d.when ?? {}) as Record<string, unknown>;
    let toMin = Math.round(num(w.toMin, 1000)); if (toMin >= 90) toMin = 1000;
    dir.when = {
      fromMin: timeOK ? Math.max(0, Math.round(num(w.fromMin, 0))) : 0,
      toMin: timeOK ? toMin : 1000,
      scoreState: scoreOK && typeof w.scoreState === 'string' ? String(w.scoreState) : 'any',
      scoreBy: scoreOK ? Math.round(num(w.scoreBy, 0)) : 0,
    };
    directives.push(dir);
  }
  const motivation: Motivation[] = [];
  const seen = new Set<number>();
  for (const r of (Array.isArray(raw.motivation) ? raw.motivation : [])) {
    if (!r || typeof r !== 'object') continue;
    const m = r as Record<string, unknown>;
    const pid = num(m.playerId, -1);
    if (!mineIds.has(pid) || seen.has(pid)) continue;            // your players only, once each
    if ((motUsed.get(pid) ?? 0) >= MOTIVATION_CAP) continue;     // respect the per-game cap
    const delta = clampInt(m.moraleDelta, -30, 30, 0);
    if (delta === 0) continue;
    seen.add(pid);
    motivation.push({ playerId: pid, moraleDelta: delta, reaction: String(m.reaction ?? '').slice(0, 120), durationMin: clampInt(m.durationMin, 5, 30, 15) });
  }
  const summary = typeof planRaw.summary === 'string' && planRaw.summary.trim() ? planRaw.summary.trim().slice(0, 280) : (directives.length ? 'Standing plan in effect.' : EMPTY_PLAN.summary);
  const changed = typeof raw.changed === 'string' ? raw.changed.trim().slice(0, 160) : '';
  const note = typeof raw.note === 'string' ? raw.note.trim().slice(0, 200) : '';
  // Formation change: accept only a real registry shape (normalise digits/keys).
  let formation: string | null = null;
  if (typeof raw.formation === 'string' && raw.formation.trim()) {
    formation = (FORMATIONS[raw.formation] ? raw.formation : null) ?? normalizeFormation(raw.formation);
  }
  return { plan: { summary, directives }, changed, motivation, note, formation };
}

// Pre-match: compile a manager's plain-English STANDING plan into the composite plan, against an
// EMPTY base (the text IS the whole plan, not an edit). Squad ids are TEAM-RELATIVE (0-10, the XI);
// there is no opponent pre-match, so any man_mark of a specific opponent is dropped by validate()
// (that's a live shout). Same graceful failure as a shout: no key / model down -> empty plan + a note.
export async function compileInitialPlan(text: string, squad: SquadPlayer[]): Promise<PlanResult> {
  if (!text.trim()) return { plan: EMPTY_PLAN, changed: '', motivation: [], note: '' };
  return compilePlanEdit(EMPTY_PLAN, text, squad, [], 'home', {});
}

const cache = new Map<string, { plan: Plan; changed: string; motivation: Motivation[]; note: string; formation: string | null }>();

// Apply one shout to the running plan. Returns the FULL new plan + the shout's
// motivational effect. Cached by (plan + shout + squad-morale state) so a replay of
// the same sequence is deterministic. Degrades to the unchanged plan on failure.
export async function compilePlanEdit(
  currentPlan: Plan, shout: string, mine: SquadPlayer[],
  opp: { id: number; name: string; role: string }[], myTeam: Side = 'home', ctx: PlanCtx = {},
): Promise<PlanResult> {
  const plan = currentPlan ?? EMPTY_PLAN;
  const mineIds = new Set(mine.map(p => p.id));
  const oppIds = new Set(opp.map(p => p.id));
  const motUsed = new Map(mine.map(p => [p.id, num(p.motivationUsed, 0)]));
  const ctxStr = `${ctx.minute ?? ''}/${ctx.score ?? ''}`;
  const cacheKey = `${planText(plan)}|${shout.trim()}|${[...motUsed].join(',')}|${ctxStr}`;
  const hit = cache.get(cacheKey);
  if (hit) return { ...hit };
  if (!KEY) return { plan, changed: '', motivation: [], note: '', error: 'TACTICS_LLM_API_KEY not set (see web/backend/.env)' };
  const myIds = myTeam === 'home' ? '0-10' : '11-21';
  const oppIdRange = myTeam === 'home' ? '11-21' : '0-10';
  const user = `CURRENT PLAN:\n${planText(plan)}\n\n${squadContext(mine, opp)}\n\nMATCH: ${ctx.minute != null ? `${ctx.minute}'` : 'pre-match'}${ctx.score ? `, score ${ctx.score}` : ''}\n\nSHOUT: ${shout}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: MODEL, temperature: 0.4, max_tokens: 900, messages: [
          { role: 'system', content: SYSTEM(myTeam, myIds, oppIdRange, myTeam === 'home' ? 0 : 1) }, { role: 'user', content: user },
        ] }),
        signal: AbortSignal.timeout(15000),
      });
      if ((res.status === 429 || res.status >= 500) && attempt === 0) {
        const ra = Number(res.headers.get('retry-after'));
        await new Promise(r => setTimeout(r, Math.min(Number.isFinite(ra) && ra > 0 ? ra : 1.2, 4) * 1000));
        continue;
      }
      const j = await res.json() as { choices?: { message?: { content?: string } }[] };
      if (res.ok) {
        const out = validate(extract(j.choices?.[0]?.message?.content ?? '{}'), myTeam, shout, mineIds, oppIds, motUsed);
        cache.set(cacheKey, out);
        return { ...out, raw: j.choices?.[0]?.message?.content ?? '' };
      }
      break;
    } catch { break; }
  }
  return { plan, changed: '', motivation: [], note: '', error: 'the plan model was unreachable' };
}
