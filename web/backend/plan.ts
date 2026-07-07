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
import { chatComplete, llmReady, LlmError } from './llm.ts';

export interface Plan { summary: string; directives: Directive[]; }
export interface Motivation { playerId: number; moraleDelta: number; reaction: string; durationMin: number; }
// Set-piece-taker assignments the prompt can change (slots 0-10, or null to clear a role). A PARTIAL
// edit — only the roles the shout/brief names are present, so the caller merges into the persistent
// teams.set_piece_takers (the same store the dropdown writes). Absent role = unchanged.
export type SPRole = 'fk' | 'corner' | 'pen' | 'longThrow';
export type PlanTakers = Partial<Record<SPRole, number | null>>;
export interface PlanResult { plan: Plan; changed: string; motivation: Motivation[]; note: string; formation?: string | null; setPieceTakers?: PlanTakers | null; raw?: string; error?: string; }
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
{"plan":{"summary":"<=2 sentences, plain English, the whole standing plan AFTER this shout","directives":[ ...the FULL directive set after the edit... ]},"changed":"<=1 line on what this shout changed (or 'No tactical change.')","motivation":[{"playerId":<your id>,"moraleDelta":-30..30,"reaction":"<short in-character line>","durationMin":<5-30>}],"formation":"<a shape key below, ONLY if the shout asks to change formation; else null>","setPieceTakers":<null, OR an object naming ONLY the dead-ball roles this shout assigns — {"fk":<id>,"corner":<id>,"pen":<id>,"longThrow":<id>}; id from YOUR XI; use null for a role to clear it ("no set penalty taker")>,"note":""}

STEP 1 — FORMATION CHECK (do this FIRST): does the shout name a team SHAPE? A number ("4-3-3","go 4 4 2","4-1-2-1-2","442") OR a name ("diamond","midfield diamond","christmas tree","three at the back","back three","two up top","five at the back"). If YES: set "formation" to the matching key from [${Object.keys(FORMATIONS).join(', ')}] and DO NOT convert the shape into directives — the engine re-shapes the team itself. Keep "directives" exactly as the prior plan. (You may STILL add a separate explicit order in the same shout: "go 3-5-2 and AB mark their man" => formation "3-5-2" + that one man_mark.) If the shout names NO shape, "formation":null and continue.
EXAMPLES: "go 4-4-2" => formation "4-4-2", directives unchanged. "switch to a diamond" => formation "4-1-2-1-2". "three at the back" => formation "3-5-2". "AB mark their striker" => formation null.

STEP 2 — EDIT THE PLAN BY INTENT (for the non-formation part of the shout):
- amend one player / add an order  -> keep the rest of "directives", add or replace just that one.
- overhaul (a broad new set of TACTICAL orders — NOT a formation) -> rewrite directives broadly.
- nuke ("forget all that", "scrap it", "back to normal") -> directives: [] and say so in "changed".
- no tactical content (pure praise/abuse/rant) -> directives UNCHANGED (echo them back verbatim); "changed":"No tactical change."
"directives" is ALWAYS the complete plan after the edit (not just this shout's delta) — the engine runs exactly what you return. NEVER turn a formation/shape into stay_wide/sit_deep/get_forward directives — that is what "formation" is for.

DIRECTIVES (same vocabulary as the tactics compiler):
{"playerId":<id, per-player kinds>,"kind":"<kind>","targetId":<id, man_mark/target_player only>,"intensity":0.1-1,"teamScope":${myScope} <team-wide kinds, no playerId>,"when":{"fromMin","toMin","scoreState","scoreBy","phase"}}
per-player: man_mark target_player shoot_on_sight get_forward sit_deep stay_wide come_inside stay_central cross_early cutback switch_play play_simple run_in_behind make_runs come_short drift_into_pocket target_man_holdup cut_inside overlap dribble_more press_hard contain tackle_hard stay_on_feet stay_back.
team-wide (teamScope ${myScope}): all_out_attack park_the_bus high_press drop_off play_it_long keep_it_on_ground get_it_wide play_narrow push_up slow_it_down counter_attack offside_trap shoot_from_distance work_it_into_box press_intensity mentality line_height.
GRADATED DIALS (the FM team-instruction trio — each takes an "intensity" 0-1 that IS the slider, 0.5 = neutral; prefer these over the binary kinds when the shout implies a DEGREE):
- press_intensity: ~0.15 sit off/contain/no chase, ~0.5 measured mid-block, ~0.85-1 aggressive high press. (vs binary high_press)
- mentality: how much the team commits forward — ~0.15 ultra-defensive/see it out, ~0.5 balanced, ~0.85-1 all-out attack/chase the game. (vs binary all_out_attack/park_the_bus)
- line_height: the defensive line — ~0.15 deep/drop off, ~0.5 mid, ~0.85-1 push right up / squeeze with an offside trap. (vs binary push_up/drop_off)
SYNONYMS: come_short = come short to feet / check to feet / drop to link / receive between the lines / don't always run in behind (per-player INVERSE of run_in_behind). target_man_holdup = play him as a target man / hold it up / hold-up play / lay it off / feet not runs / be the out-ball (a forward holding it up back-to-goal; NOT make_runs). drift_into_pocket = drop into the ten / find pockets / play between the lines / get in the hole / in the half-space (receive between their defence + midfield, facing forward). cut_inside = cut inside and shoot / come in off the line / inside forward / a lefty on the right (or righty on the left) onto his stronger foot (a WIDE attacker driving infield; NOT come_inside, which is an inverting full-back). overlap = overlap / bomb on / get on the overlap / get round the outside (a full-back overlapping his winger and bombing on OUTSIDE him; NOT cut_inside/come_inside). shoot_from_distance = shoot from range / let fly from outside / pepper them / have a go / efforts from distance (team-wide). work_it_into_box = work it into the box / walk it in / no shots from distance / get a better chance (team-wide; the opposite of shoot_from_distance). cutback = pull it back / square it across the box from the byline (vs cross_early's higher cross). contain = sit off / jockey / show him inside — ease off ONE opponent (per-player opposite of press_hard; vs stay_on_feet = tackle discipline). stay_back = don't bomb forward / don't overlap / hold position — damp his forward runs (vs sit_deep = take up a deep position).
Resolve names/initials from the squad (tolerate typos); man_mark targets are OPPONENT ids, target_player targets are TEAM-MATE ids. Never invent a player not in a squad — omit + note. OMIT "when" unless the shout states a time/score/PHASE. PHASE (only if the order ties to a game phase): "phase":"in_possession" (on the ball / when we have it / when attacking), "out_of_possession" (off the ball / when defending), "transition" (the moment we win/lose it / counter-press / on the turnover). e.g. "counter-press the second we lose it" => press_intensity high + "when":{"phase":"transition"}.

SET-PIECE TAKERS: if the shout names who takes DEAD BALLS, fill "setPieceTakers" with ONLY the named roles (else null). fk = free kicks / "set pieces" / "dead balls", corner = corners, pen = penalties / "spot kicks", longThrow = long throw-ins. The id is one of YOUR players. "AB takes our free kicks and corners, CD on penalties" => {"fk":<AB>,"corner":<AB>,"pen":<CD>}. "no designated penalty taker" => {"pen":null}. This is SEPARATE from directives — do NOT also emit a directive for it. Roles not named stay as they were.

MOTIVATION (the shout's emotional effect — separate from tactics):
- Judge from the addressed player's PERSONALITY, not the literal words: criticismResponse HIGH => a rocket FIRES them up (positive delta); LOW => they wilt (negative). praiseResponse scales how much praise lifts. High ego => praise risks complacency (smaller/negative). temperament high => bigger swings.
- A purely motivational shout (no tactic) => directives unchanged, motivation only. A purely tactical shout => motivation usually []. moraleDelta in -30..30; durationMin 5-30.
- CAP: each player's "motUsed" is shown. If a player is already at ${MOTIVATION_CAP}, do NOT add motivation for them (skip; mention in note). Motivation is scarce + meaningful.
- "we/lads/everyone" addressed motivationally => you may move a few key players, not all 11.

NOTE: short, only for a problem (unknown player, ambiguous, nonsense/abuse-with-no-target). "" when clean. Never use a kind not listed above.`;

function extract(content: string): Record<string, unknown> {
  const body = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { const v = JSON.parse(body); if (v && typeof v === 'object') return v as Record<string, unknown>; } catch { /* salvage */ }
  const s = content.indexOf('{'), e = content.lastIndexOf('}');
  if (s >= 0 && e > s) { try { const v = JSON.parse(content.slice(s, e + 1)); if (v && typeof v === 'object') return v as Record<string, unknown>; } catch { /* noop */ } }
  return {};
}

// Parse the LLM's "setPieceTakers" into a PARTIAL taker edit: keep only the dead-ball roles it named
// whose taker is one of MY players (a slot, not an opponent), or an explicit null (clear that role).
// Empty / no valid role => null (no change). Exported so the deterministic validation is unit-tested
// without needing the LLM. The caller merges the result into the persistent teams.set_piece_takers.
export function takersFromRaw(spRaw: unknown, mineIds: Set<number>): PlanTakers | null {
  if (!spRaw || typeof spRaw !== 'object') return null;
  const sp = spRaw as Record<string, unknown>;
  const out: PlanTakers = {};
  for (const role of ['fk', 'corner', 'pen', 'longThrow'] as SPRole[]) {
    if (!(role in sp)) continue;
    const v = sp[role];
    if (v === null) out[role] = null;                          // explicit clear
    else { const id = num(v, -1); if (mineIds.has(id)) out[role] = id; }   // must be one of my players
  }
  return Object.keys(out).length ? out : null;
}

const TIME_WORDS = /\b(\d{1,3}\s*(?:'|min|mins|minute|minutes)|half|first|second|opening|closing|last|from the|after the|until|before|kick.?off|whistle|early on|late on)\b/i;
const SCORE_WORDS = /\b(winning|losing|drawing|level|tied|all square|ahead|behind|trailing|chasing|in front|leading|protect|see it out|goal up|goal down|a man (?:up|down)|nil|equaliser|equalizer)\b/i;
// phase conditions ("when":{"phase"}) — only honoured if the shout actually ties an order to a game phase
// (in/out of possession or the transition), mirroring the time/score guards so plain orders stay unconditional.
export const PHASE_WORDS = /\b(in possession|out of possession|when we(?:'re| are|'ve| have)?\s*(?:have|win|won|lose|lost|regain|attack|defend)|win it back|won it back|lose the ball|lost the ball|in transition|on the (?:counter|break|turnover)|counter.?press|gegen.?press|when (?:we'?re )?(?:attacking|defending)|the (?:second|moment|instant) we (?:win|lose|regain))\b/i;
export const VALID_PHASES = new Set(['in_possession', 'attacking', 'out_of_possession', 'defending', 'transition']);

// honest-decline net (the coverage corpus's #1 failure mode is a SILENT wrong-approximation): if the LLM
// proposed tactical directives but every kind was unrecognised (no matching primitive → all dropped), left no
// motivation, and gave no note of its own, surface that it couldn't map the order instead of a silent no-op.
// Conservative on purpose — only fires when there's genuinely nothing else (real directives/motivation/a note
// all suppress it), so it never clobbers a legit mapping or the LLM's own note.
export function declineFallback(hasDirectives: boolean, hasMotivation: boolean, droppedKind: boolean, note: string): string {
  return (!hasDirectives && !hasMotivation && droppedKind && !note) ? "I couldn't map that to a tactical setting yet." : note;
}

// Validate the returned plan's directives (same rules as tactics.ts) + motivation
// (id range, clamp, enforce the per-player cap from motUsed). Deterministic given
// the model output, so cached replays stay identical.
// Exported for the deterministic offline regression test (tools/test_plan_validate.ts):
// the live compile paths are LLM-backed, so validate() is the seam a unit test can
// drive with a hand-authored raw plan (e.g. the GAP 1 standing-plan man_mark note).
export function validate(raw: Record<string, unknown>, myTeam: Side, shout: string, mineIds: Set<number>, oppIds: Set<number>, motUsed: Map<number, number>): { plan: Plan; changed: string; motivation: Motivation[]; note: string; formation: string | null; setPieceTakers: PlanTakers | null } {
  const myScope = myTeam === 'home' ? 0 : 1;
  const planRaw = (raw.plan ?? {}) as Record<string, unknown>;
  const timeOK = TIME_WORDS.test(shout), scoreOK = SCORE_WORDS.test(shout), phaseOK = PHASE_WORDS.test(shout);
  const directives: Directive[] = [];
  let droppedKind = false;   // the LLM proposed a directive whose kind isn't a real primitive (→ honest-decline net)
  let proposedManMark = false;   // a man_mark was asked for but there's no opponent XI to bind it to (standing plan) — GAP 1
  for (const r of (Array.isArray(planRaw.directives) ? planRaw.directives : [])) {
    if (!r || typeof r !== 'object') continue;
    const d = r as Record<string, unknown>;
    const kind = String(d.kind ?? '');
    if (!VALID_KINDS.has(kind)) { if (kind) droppedKind = true; continue; }
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
        // mark an OPPONENT (else the engine ignores it). Pre-match there is no
        // opponent XI (oppIds empty), so this always drops — flag it so we tell
        // the manager it's a live-only order instead of a silent no-op (GAP 1).
        if (!oppIds.has(t)) { if (oppIds.size === 0) proposedManMark = true; continue; }
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
    const ph = typeof w.phase === 'string' ? w.phase : '';
    if (phaseOK && VALID_PHASES.has(ph)) dir.when.phase = ph;   // phase condition — gated like time/score, valid engine phases only
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
  let note = typeof raw.note === 'string' ? raw.note.trim().slice(0, 200) : '';
  note = declineFallback(directives.length > 0, motivation.length > 0, droppedKind, note);
  // GAP 1: a man_mark in a STANDING plan can't bind (no opponent XI at plan-save
  // time) and it's a valid kind, so the honest-decline net above never fires —
  // it would just vanish. Surface a note so the manager knows to set it live.
  if (proposedManMark) {
    const mm = 'Man-marking is set as a live shout during the match, not in the standing plan.';
    note = (note ? `${note} ${mm}` : mm).slice(0, 240);
  }
  // Formation change: accept only a real registry shape (normalise digits/keys).
  let formation: string | null = null;
  if (typeof raw.formation === 'string' && raw.formation.trim()) {
    formation = (FORMATIONS[raw.formation] ? raw.formation : null) ?? normalizeFormation(raw.formation);
  }
  return { plan: { summary, directives }, changed, motivation, note, formation, setPieceTakers: takersFromRaw(raw.setPieceTakers, mineIds) };
}

// §2 quick-tactics: one-tap team mentality presets. A DETERMINISTIC shortcut (no LLM) that sets a coherent
// (plain-English summary + team-wide directives) pair in one go — so the text and the directives can't drift.
// Each preset places the gradated FM trio (mentality / press_intensity / line_height — engine dials, 0-1)
// plus the odd binary flavour kind, so the presets ARE the canonical trio examples. The user can then refine
// via the prompt. Team-relative scope (0), resolved at spec-build. 'balanced' = the neutral base (no dials).
export const QUICK_TACTICS = {
  defensive: { label: '🛡️ Defensive', text: 'Sit deep and stay compact — drop off, protect the box and hit them on the counter.', dirs: [['mentality', 0.2], ['press_intensity', 0.2], ['line_height', 0.25], ['counter_attack', 1]] },
  balanced: { label: '⚖️ Balanced', text: 'A balanced approach — no special team instructions; play the game in front of you.', dirs: [] },
  attacking: { label: '⚔️ Attacking', text: 'On the front foot — commit forward, press them and push the line up.', dirs: [['mentality', 0.75], ['press_intensity', 0.7], ['line_height', 0.7]] },
  allout: { label: '🔥 All-out attack', text: 'Throw everyone forward — all-out attack, hunt the ball high and squeeze the line up.', dirs: [['mentality', 1], ['press_intensity', 0.95], ['line_height', 0.85]] },
} as const;
export type QuickTactic = keyof typeof QUICK_TACTICS;
export function buildQuickPlan(preset: QuickTactic, myScope: number): Plan {
  const p = QUICK_TACTICS[preset];
  return { summary: p.text, directives: p.dirs.map(([kind, intensity]): Directive => ({ playerId: -1, teamScope: myScope, kind, intensity })) };
}

// Pre-match: compile a manager's plain-English STANDING plan into the composite plan, against an
// EMPTY base (the text IS the whole plan, not an edit). Squad ids are TEAM-RELATIVE (0-10, the XI);
// there is no opponent pre-match, so any man_mark of a specific opponent is dropped by validate()
// (that's a live shout). Same graceful failure as a shout: no key / model down -> empty plan + a note.
export async function compileInitialPlan(text: string, squad: SquadPlayer[]): Promise<PlanResult> {
  if (!text.trim()) return { plan: EMPTY_PLAN, changed: '', motivation: [], note: '' };
  return compilePlanEdit(EMPTY_PLAN, text, squad, [], 'home', {});
}

// BATCHED initial-plan compiler (manager_ai's pre-matchday pass): ONE LLM call compiles N clubs'
// standing plans instead of N sequential compileInitialPlan calls — the matchday win on the
// per-call cold-start transports (claude-code). Returns one PlanResult per job IN ORDER. Each
// element runs through the SAME validate() as the single path (team-relative ids 0-10, teamScope
// 0, no opponent → man_mark dropped), so the directive shape is byte-for-byte identical. Graceful:
// no key / unreachable / a club the model omits → that club's result is EMPTY_PLAN + error, so the
// caller's per-club deterministic fallback (manager/plan.ts fallbackPlan) still applies. Never throws.
const INITIAL_BATCH_SYSTEM = `You compile several football managers' STANDING pre-match plans into structured directives. Each club gives a one-line tactical brief + its starting XI (ids 0-10). For EACH club, turn the brief into a small directive set. Output ONLY a JSON array, one object per club IN ORDER — no prose, no markdown:
[{"summary":"<=2 sentences restating the plan","directives":[{"playerId":<0-10 for per-player kinds>,"kind":"<kind>","intensity":0.1-1,"teamScope":0 <for team-wide kinds, omit playerId>}]}]
per-player kinds: shoot_on_sight get_forward sit_deep stay_wide come_inside stay_central cross_early cutback switch_play play_simple run_in_behind make_runs dribble_more press_hard contain tackle_hard stay_on_feet stay_back.
team-wide kinds (teamScope 0, no playerId): all_out_attack park_the_bus high_press drop_off play_it_long keep_it_on_ground get_it_wide play_narrow push_up slow_it_down counter_attack offside_trap, plus three GRADATED dials that take an "intensity" 0-1 (0.5 neutral): press_intensity (contain↔high press), mentality (defensive↔all-out), line_height (deep↔high line).
A standing plan is mostly TEAM-WIDE shape/tempo — 0-3 directives is plenty; add a per-player order only if the brief clearly implies one. There is NO opponent pre-match, so do NOT emit man_mark or target_player. Resolve names/initials from each club's own squad; never invent a player. Return EXACTLY one entry per club, in the given order.`;

function extractArray(content: string): unknown[] {
  const body = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { const v = JSON.parse(body); if (Array.isArray(v)) return v; if (v && Array.isArray((v as { plans?: unknown }).plans)) return (v as { plans: unknown[] }).plans; } catch { /* salvage */ }
  const s = content.indexOf('['), e = content.lastIndexOf(']');
  if (s >= 0 && e > s) { try { const v = JSON.parse(content.slice(s, e + 1)); if (Array.isArray(v)) return v; } catch { /* noop */ } }
  return [];
}

function buildInitialBatchPrompt(jobs: { text: string; squad: SquadPlayer[] }[]): string {
  const blocks = jobs.map((job, i) => {
    const xi = job.squad.slice(0, 11).map(p => `id${p.id} ${p.name} [${initialsOf(p.name)}](${p.role})`).join(', ');
    return `CLUB ${i + 1}\nBrief: ${job.text}\nXI: ${xi}`;
  }).join('\n\n');
  return `Compile these ${jobs.length} clubs' standing plans:\n\n${blocks}`;
}

export async function compileInitialPlans(jobs: { text: string; squad: SquadPlayer[] }[]): Promise<PlanResult[]> {
  if (!jobs.length) return [];
  const ready = llmReady();
  if (!ready.ok) return jobs.map(() => ({ plan: EMPTY_PLAN, changed: '', motivation: [], note: '', error: ready.error }));
  let content: string;
  try {
    content = await chatComplete({
      system: INITIAL_BATCH_SYSTEM, user: buildInitialBatchPrompt(jobs),
      temperature: 0.5, maxTokens: Math.min(3000, 320 * jobs.length + 200), timeoutMs: 30000,
    });
  } catch {
    return jobs.map(() => ({ plan: EMPTY_PLAN, changed: '', motivation: [], note: '', error: 'the plan model was unreachable' }));
  }
  const arr = extractArray(content);
  return jobs.map((job, i) => {
    const el = arr[i];
    if (!el || typeof el !== 'object') return { plan: EMPTY_PLAN, changed: '', motivation: [], note: '', error: 'no plan returned for this club' };
    // Reuse the single-path validator: wrap the element as a {plan} response, team-relative ids
    // from the club's own XI, empty opponent (man_mark/target_player to an opponent => dropped),
    // empty motivation budget (pre-match standing plan, no shout). The brief is the "shout" text
    // for validate's time/score-word gating (a standing brief has none → no-bound when-fields).
    const mineIds = new Set(job.squad.slice(0, 11).map(p => p.id));
    const v = validate({ plan: el }, 'home', job.text, mineIds, new Set<number>(), new Map<number, number>());
    return { plan: v.plan, changed: v.changed, motivation: [], note: v.note };
  });
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
  const ready = llmReady(true);   // interactive shout/plan — check the FAST live provider
  if (!ready.ok) return { plan, changed: '', motivation: [], note: '', error: ready.error };
  const myIds = myTeam === 'home' ? '0-10' : '11-21';
  const oppIdRange = myTeam === 'home' ? '11-21' : '0-10';
  const user = `CURRENT PLAN:\n${planText(plan)}\n\n${squadContext(mine, opp)}\n\nMATCH: ${ctx.minute != null ? `${ctx.minute}'` : 'pre-match'}${ctx.score ? `, score ${ctx.score}` : ''}\n\nSHOUT: ${shout}`;
  let content: string;
  try {
    content = await chatComplete({
      system: SYSTEM(myTeam, myIds, oppIdRange, myTeam === 'home' ? 0 : 1),
      user, temperature: 0.4, maxTokens: 900, timeoutMs: 15000, live: true,   // interactive — fast live provider
    });
  } catch (e) {
    return { plan, changed: '', motivation: [], note: '',
      error: e instanceof LlmError ? e.userMessage : 'the plan model was unreachable' };
  }
  const out = validate(extract(content), myTeam, shout, mineIds, oppIds, motUsed);
  cache.set(cacheKey, out);
  return { ...out, raw: content };
}
