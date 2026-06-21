// manager_ai (v1) — an AI manager that decides a club's matchday setup, filling in for absent
// humans. Its ONLY output is writing the four team columns specForTeam already reads, so the
// engine + match.ts need zero knowledge of it:
//   teams.formation        — a FORMATIONS key
//   teams.lineup           — JSON int[11] (formationSlot -> squad-slot index), or NULL = identity XI
//   teams.plan_text        — the manager's plain-English standing plan
//   teams.plan_directives  — the compiled plan {summary, directives} (team-relative ids)
//
// Two tiers (see docs/MANAGER_AI.md):
//   'assistant' — a present-but-idle HUMAN didn't set tactics. Fill ONLY the gaps: a heuristic
//                 best XI + a neutral plan. NO transfers/renewals (never spend a human's money).
//   'full'      — a fully-AI club. Decide everything: formation + XI + a personality-flavoured
//                 LLM plan + transfers/renewals to fix the weakest role within budget.
//
// THE FIRE-PATH RULE: prepareMatchday IS the pre-matchday ASYNC pass (it persists + may call the
// LLM for the plan). The synchronous "play all worlds" fire path only READS these columns. The
// heuristic (formation/XI/transfers) is cleanly separable + synchronous; only the plan is async.
//
// Idempotent: re-running for the same club re-derives + overwrites the same columns. Never throws
// (a down LLM degrades to a deterministic plan).
import { db } from '../db.ts';
import { getTeamWithPlayers } from '../game.ts';
import { optimizeLineup } from '../ai.ts';
import { DEFAULT_FORMATION } from '../formations.ts';
import { pickFormation, buildXI, isIdentityLineup, managerPlayers } from './lineup.ts';
import { manageTransfers } from './transfers.ts';
import { buildPlan, buildPlans, fallbackPlan, type PlanInput, type PlanResult } from './plan.ts';
import type { Traits } from '../personality.ts';

export type Autonomy = 'assistant' | 'full';

// A neutral standing plan for the assistant tier — a present human's stand-in, deliberately
// conservative + tactically empty (the human can override before kickoff). No directives, so the
// team plays the engine's neutral base; specForTeam emits no directive line for an empty plan.
const NEUTRAL_PLAN_TEXT = 'Balanced approach — keep our shape and play our normal game.';
const NEUTRAL_PLAN = { summary: NEUTRAL_PLAN_TEXT, directives: [] as never[] };

const traitsOf = (personality: unknown): Traits | null =>
  (personality as { traits?: Traits } | null)?.traits ?? null;

// Persist the heuristic shape + XI (the synchronous half). Returns the chosen formation + the XI
// rows so the plan step can flavour itself by the fielded XI. Shared by both tiers.
function persistShapeAndXI(teamId: number): { formation: string; xi: { name: string; role: string; traits: Traits | null }[] } | null {
  // REUSE optimizeLineup (ai.ts) for the XI: repack the squad so the strongest role-correct 11
  // (drawn from the WHOLE squad, incl. any bench depth from a transfer) occupy slots 0..10. This
  // is the contract's baseline XI; pickFormation/buildXI then choose the shape + map those 11 into
  // it. On the default shape with an already-optimal identity squad this is a no-op -> NULL lineup
  // -> the byte-identical default path. Deterministic (optimizeLineup uses no rng).
  optimizeLineup(teamId);
  const t = getTeamWithPlayers(teamId);
  if (!t || t.players.length < 11) return null;
  const mp = managerPlayers(t.players);
  const formation = pickFormation(mp);
  const lineupArr = buildXI(mp, formation);
  // NULL when it's the identity XI on the default shape (keeps the byte-identical default path);
  // else the explicit int[11]. A non-default shape always stores an explicit lineup (so the
  // engine gets the per-slot role/anchor layout).
  const storeLineup = lineupArr && !(formation === DEFAULT_FORMATION && isIdentityLineup(lineupArr))
    ? JSON.stringify(lineupArr) : null;
  db.prepare('UPDATE teams SET formation = ?, lineup = ? WHERE id = ?').run(formation, storeLineup, teamId);

  // The fielded XI in formation-slot order (for plan flavour). lineupArr[i] = squad-slot index.
  const order = lineupArr ?? Array.from({ length: 11 }, (_, i) => i);
  const xi = order.map(idx => {
    const p = t.players[idx] ?? t.players[0];
    return { name: p.name, role: p.role, traits: traitsOf(p.personality) };
  });
  return { formation, xi };
}

function persistPlan(teamId: number, planText: string, plan: { summary: string; directives: unknown[] }): void {
  db.prepare('UPDATE teams SET plan_text = ?, plan_directives = ? WHERE id = ?')
    .run(planText, JSON.stringify(plan), teamId);
}

// Decide + persist a club's matchday setup. See the module header for the two tiers + the
// fire-path rule. Idempotent; never throws.
export async function prepareMatchday(teamId: number, autonomy: Autonomy): Promise<void> {
  const team = db.prepare('SELECT id, user_id FROM teams WHERE id = ?').get(teamId) as { id: number; user_id: number | null } | undefined;
  if (!team) return;

  if (autonomy === 'full') {
    // A fully-AI club: trade FIRST (a signing can change the best XI), then shape/XI, then the plan.
    // manageTransfers is a no-op for a human club (defensive), so this only spends AI money.
    try { manageTransfers(teamId); } catch { /* a failed market move never blocks the setup */ }
  }

  const built = persistShapeAndXI(teamId);
  if (!built) return;   // <11 players — leave the columns as they are (the row stays legal)

  if (autonomy === 'assistant') {
    // Human stand-in: best XI + a neutral plan only. NEVER transfers (handled by the tier gate
    // above) and a deliberately empty/neutral plan the human can override.
    persistPlan(teamId, NEUTRAL_PLAN_TEXT, NEUTRAL_PLAN);
    return;
  }

  // full tier — a personality-flavoured plan via the LLM, with a deterministic fallback.
  const planInput: PlanInput = {
    teamName: getTeamWithPlayers(teamId)?.name ?? 'The team',
    squad: built.xi,
    formation: built.formation,
  };
  let planText: string;
  let plan: { summary: string; directives: unknown[] };
  try {
    const r = await buildPlan(planInput);
    planText = r.planText;
    plan = r.plan;
  } catch {
    // belt-and-braces: buildPlan already degrades gracefully, but never let a throw escape.
    const fb = fallbackPlan(planInput);
    planText = fb.summary;
    plan = fb;
  }
  persistPlan(teamId, planText, plan);
}

// SYNCHRONOUS heuristic-only entry — formation + XI (+ transfers for full) WITHOUT the LLM plan.
// Lets a synchronous caller (or a future fire-path fallback) run the deterministic half alone.
// For 'full' it leaves a deterministic fallback plan so the club still has a standing plan.
export function prepareMatchdayHeuristic(teamId: number, autonomy: Autonomy): void {
  const team = db.prepare('SELECT id FROM teams WHERE id = ?').get(teamId) as { id: number } | undefined;
  if (!team) return;
  if (autonomy === 'full') { try { manageTransfers(teamId); } catch { /* ignore */ } }
  const built = persistShapeAndXI(teamId);
  if (!built) return;
  if (autonomy === 'assistant') { persistPlan(teamId, NEUTRAL_PLAN_TEXT, NEUTRAL_PLAN); return; }
  const fb = fallbackPlan({ teamName: getTeamWithPlayers(teamId)?.name ?? 'The team', squad: built.xi, formation: built.formation });
  persistPlan(teamId, fb.summary, fb);
}

// ── The integration convenience: prepare every club playing this matchday ───────
// This is what the matchday tick calls — ONE await before the synchronous fire path. Given the
// pending fixture ids, it resolves the distinct teams about to play and prepares each at the right
// tier: 'full' for an AI club (user_id IS NULL), 'assistant' for a HUMAN club that left no standing
// plan (plan_text IS NULL — they didn't set tactics this matchday; we fill the gap, they can still
// override before kickoff). A human who DID set a plan is left entirely alone.
//
// Runs in the PRE-MATCHDAY ASYNC PASS (it persists + may call the LLM), so the synchronous
// "play all worlds" fire path only READS the columns — honouring the fire-path rule. The heuristic
// (transfers + shape/XI) runs per club synchronously; the full-AI clubs' plans are then compiled in
// ONE batched LLM call (compileInitialPlans) — so a matchday of N AI clubs costs ONE chatComplete,
// not N (load-bearing on the ~10s/call claude-code/Haiku transport). Never throws.
export async function prepareWorldMatchday(fixtureIds: number[]): Promise<void> {
  if (!fixtureIds.length) return;
  const seen = new Set<number>();
  const sel = db.prepare('SELECT home_team_id AS h, away_team_id AS a FROM fixtures WHERE id = ?');
  const teamRow = db.prepare('SELECT user_id, plan_text FROM teams WHERE id = ?');
  // PASS 1 (synchronous, no LLM): each club's heuristic (transfers + shape/XI); persist the
  // assistant clubs' neutral plan now; COLLECT the full-AI clubs' plan inputs for the batch.
  const fullJobs: { teamId: number; input: PlanInput }[] = [];
  for (const fid of fixtureIds) {
    const fx = sel.get(fid) as { h: number; a: number } | undefined;
    if (!fx) continue;
    for (const tid of [fx.h, fx.a]) {
      if (seen.has(tid)) continue;
      seen.add(tid);
      const t = teamRow.get(tid) as { user_id: number | null; plan_text: string | null } | undefined;
      if (!t) continue;
      try {
        if (t.user_id == null) {
          // full AI club: transfers + shape/XI now; DEFER the plan to the one batched LLM call.
          try { manageTransfers(tid); } catch { /* a failed market move never blocks setup */ }
          const built = persistShapeAndXI(tid);
          if (built) fullJobs.push({ teamId: tid, input: { teamName: getTeamWithPlayers(tid)?.name ?? 'The team', squad: built.xi, formation: built.formation } });
        } else if (t.plan_text == null) {
          // assistant (idle human): best XI + a neutral plan — NO LLM, NO transfers.
          if (persistShapeAndXI(tid)) persistPlan(tid, NEUTRAL_PLAN_TEXT, NEUTRAL_PLAN);
        }
        // a human who set a plan keeps it — left untouched.
      } catch { /* never block a matchday */ }
    }
  }
  // PASS 2 (ONE LLM call for ALL full-AI clubs' plans). buildPlans is per-club graceful + never throws.
  if (!fullJobs.length) return;
  let results: PlanResult[] = [];
  try { results = await buildPlans(fullJobs.map(j => j.input)); } catch { results = []; }
  fullJobs.forEach((j, i) => {
    const r = results[i] ?? { planText: fallbackPlan(j.input).summary, plan: fallbackPlan(j.input), usedLLM: false };
    try { persistPlan(j.teamId, r.planText, r.plan); } catch { /* leave columns as the heuristic set them */ }
  });
}

export { pickFormation, buildXI } from './lineup.ts';
export { manageTransfers } from './transfers.ts';
export { buildPlan, fallbackPlan } from './plan.ts';
