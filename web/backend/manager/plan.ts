// manager_ai — the standing PLAN (plan_text + plan_directives).
//
// This is the ONLY part of manager_ai that may call the LLM, and it runs ONLY inside
// prepareMatchday's pre-matchday async pass (never on the synchronous fire path — see the
// contract's fire-path rule). We REUSE plan.ts compileInitialPlan: it turns plain English into
// the composite plan {summary, directives} with TEAM-RELATIVE ids (0-10) + teamScope 0 — exactly
// the shape teams.plan_directives stores and specForTeam resolves to engine ids at spec-build.
//
// Graceful degradation is mandatory: with no API key (or the model unreachable) compileInitialPlan
// returns an EMPTY plan + an error — we then fall back to a DETERMINISTIC default plan so a full-AI
// club always has a sensible standing plan and prepareMatchday NEVER throws.
import { compileInitialPlan, type Plan, type SquadPlayer } from '../plan.ts';
import { TEAM_KIND_SET, VALID_KINDS, type Directive } from '../tactics.ts';
import type { Traits } from '../personality.ts';

export interface PlanInput {
  teamName: string;
  // The fielded XI (slot order), with personality dials for flavour. ids are TEAM-RELATIVE 0-10.
  squad: { name: string; role: string; traits?: Traits | null }[];
  formation: string;
}

// ── Deterministic club identity → a one-line tactical brief the LLM flavours, AND the seed for
// the no-LLM fallback. Reads the squad's AGGREGATE personality (how bold / aggressive / patient
// the dressing room is) so different clubs get different default plans without any rng. ──
interface Identity { aggression: number; boldness: number; patience: number; brief: string; }
function clubIdentity(input: PlanInput): Identity {
  const xi = input.squad.slice(0, 11);
  const avg = (pick: (t: Traits) => number): number => {
    const vals = xi.map(p => p.traits).filter((t): t is Traits => !!t).map(pick);
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 50;
  };
  // bold/attacking dressing rooms (high ego + bigGame + low... ) lean to attack; gritty ones press.
  const ego = avg(t => t.ego), bigGame = avg(t => t.bigGame), temperament = avg(t => t.temperament);
  const leadership = avg(t => t.leadership), professionalism = avg(t => t.professionalism);
  const aggression = Math.round((temperament + (100 - professionalism) / 2) / 1.5);   // fiery + loose => aggressive
  const boldness = Math.round((ego + bigGame) / 2);                                    // ego + big-game => bold
  const patience = Math.round((professionalism + leadership) / 2);                     // pros + leaders => patient build-up
  const tone = boldness >= 60 ? 'on the front foot, attacking with intent'
    : boldness <= 40 ? 'compact and disciplined, picking our moments'
      : 'balanced, controlling the game';
  const press = aggression >= 60 ? ' We press high and hunt the ball back.'
    : aggression <= 40 ? ' We sit off and stay organised.' : '';
  const build = patience >= 60 ? ' Keep it on the ground and build through the lines.'
    : patience <= 40 ? ' Get it forward early and play direct.' : '';
  return { aggression, boldness, patience, brief: `Play ${tone}.${press}${build}`.trim() };
}

// A team-wide directive in the persisted (team-relative, teamScope-0) shape. Mirrors what
// tactics.ts validate() emits, so specForTeam resolves it identically to an LLM-compiled one.
function teamDirective(kind: string): Directive {
  return { playerId: -1, teamScope: 0, kind, intensity: 1, when: { fromMin: 0, toMin: 1000, scoreState: 'any', scoreBy: 0 } };
}

// DETERMINISTIC fallback plan from the club identity — used when the LLM is unavailable. Emits a
// short prose summary + 0..2 team-wide directives, ALL within VALID_KINDS (asserted below), so the
// engine always gets a legal plan. No rng: identical squad => identical plan (replay-safe).
export function fallbackPlan(input: PlanInput): Plan {
  const id = clubIdentity(input);
  const directives: Directive[] = [];
  // shape/tempo from boldness; pressing from aggression — pick at most one of each axis.
  if (id.boldness >= 65) directives.push(teamDirective('all_out_attack'));
  else if (id.boldness <= 35) directives.push(teamDirective('park_the_bus'));
  if (id.aggression >= 65) directives.push(teamDirective('high_press'));
  else if (id.aggression <= 35) directives.push(teamDirective('drop_off'));
  if (id.patience >= 65 && directives.length < 2) directives.push(teamDirective('keep_it_on_ground'));
  else if (id.patience <= 35 && directives.length < 2) directives.push(teamDirective('play_it_long'));
  // belt-and-braces: every kind we emit MUST be valid (and team-wide) — drop any that isn't.
  const legal = directives.filter(d => VALID_KINDS.has(d.kind) && TEAM_KIND_SET.has(d.kind));
  const summary = `${input.teamName}: ${id.brief}`.slice(0, 280);
  return { summary, directives: legal };
}

// Build the plain-English brief the manager would "write", flavoured by club identity, that we
// feed to compileInitialPlan. Kept short + concrete so the compiler maps it to clean directives.
function briefText(input: PlanInput): string {
  const id = clubIdentity(input);
  return id.brief;
}

export interface PlanResult { planText: string; plan: Plan; usedLLM: boolean; }

// Produce the standing plan for a full-AI club. Tries the LLM (via compileInitialPlan) first;
// on ANY failure (no key, unreachable, empty result) falls back to the deterministic plan. The
// returned planText is the human-readable brief; plan is {summary, directives} for plan_directives.
// NEVER throws — a thrown compiler is caught and degraded to the fallback.
export async function buildPlan(input: PlanInput): Promise<PlanResult> {
  const brief = briefText(input);
  const fallback = fallbackPlan(input);
  try {
    const squad: SquadPlayer[] = input.squad.slice(0, 11).map((p, i) => ({
      id: i, name: p.name, role: p.role,
      personality: p.traits ? { traits: p.traits as unknown as Record<string, number> } : null,
    }));
    const r = await compileInitialPlan(brief, squad);
    // compileInitialPlan returns an error (and the empty/unchanged plan) when the model is
    // unreachable or no key is set — degrade to the deterministic plan in that case.
    if (r.error || !r.plan || r.plan.directives.length === 0) {
      return { planText: brief, plan: fallback, usedLLM: false };
    }
    // Use the LLM's summary as the plan text (richer than the seed brief), keep its directives.
    return { planText: r.plan.summary || brief, plan: r.plan, usedLLM: true };
  } catch {
    return { planText: brief, plan: fallback, usedLLM: false };
  }
}
