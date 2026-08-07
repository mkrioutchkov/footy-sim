// ── tactics screen ── extracted from app.ts (Round: appts-audit, pass 2): the whole tactics subsystem —
// the plain-English plan panel + directive vocabulary, the set-piece taker panel, the structured board
// (formation / sliders / role presets) and screenTactics itself, plus the mutation gate they share. The
// first split deliberately left this behind as too coupled; the coupling was three direct route() calls
// (now shell.rerender(), same dispatch — boot wires it to route()) and the router's leaving-#/tactics
// listener clear (now the exported teardownTactics(), mirroring watch.ts's teardownWatch).
import { api, type TeamT, type FormationsT, type DirectiveT } from '../api.ts';
import { h } from '../ui/dom.ts';
import { shortName } from '../ui/format.ts';
import { mount, toast, screenGuard, rerender, getTacticsPlanFlash, setTacticsPlanFlash, type TacticsPlanFlash } from '../ui/shell.ts';
import { confirmModal } from '../ui/modal.ts';
import { header } from '../ui/nav.ts';
import { pitchSvg } from '../ui/pitch.ts';
import { describeDirective, setDirectiveNames } from './directives.ts';
import { screenCreateTeam } from './create-team.ts';

// The standing tactical plan: a plain-English textarea + a read-only resolved-plan display
// (the compiled directives), mirroring the live shout receipt. Replaces the old 5-dial sliders.
// The directive vocabulary, grouped FM-style — every entry maps to a REAL engine-backed kind in
// tactics.ts VALID_KINDS (no born-dead duties). Clicking a chip drops a phrasing into the plan box so
// the language is discoverable, not guessed. Kept in sync as the engine gains primitives — now surfaces
// the WAVE movement kinds (overlap [user feedback #1], come_short, drift_into_pocket, target_man_holdup,
// cut_inside) + the team shot-selection pair (shoot_from_distance / work_it_into_box).
const VOCAB_GROUPS: { title: string; items: { label: string; phrase: string }[] }[] = [
  { title: 'Team shape', items: [
    { label: 'High press', phrase: 'press high and win it back fast' },
    { label: 'Counter-press', phrase: 'counter-press — win it back the moment we lose it' },
    { label: 'Drop off', phrase: 'sit back and stay compact' },
    { label: 'All-out attack', phrase: 'throw everyone forward' },
    { label: 'Park the bus', phrase: 'shut up shop and see it out' },
    { label: 'Push up', phrase: 'push the line up' },
    { label: 'Offside trap', phrase: 'hold a high line and play offside' },
    { label: 'Counter-attack', phrase: 'hit them on the counter' },
  ] },
  { title: 'Build-up', items: [
    { label: 'Play it long', phrase: 'go direct, hit it long' },
    { label: 'Keep it down', phrase: 'pass it out from the back' },
    { label: 'Get it wide', phrase: 'use the wings' },
    { label: 'Play narrow', phrase: 'stay narrow, through the middle' },
    { label: 'Slow it down', phrase: 'keep the ball, take the sting out' },
    { label: 'Work it into the box', phrase: 'work it into the box, no long shots' },
    { label: 'Shoot from range', phrase: 'have a go from distance' },
  ] },
  { title: 'Player movement', items: [
    { label: 'Get forward', phrase: '[player] get forward' },
    { label: 'Sit deep', phrase: '[player] sit deep' },
    { label: "Stay back", phrase: "[player] don't bomb forward" },
    { label: 'Stay wide', phrase: '[player] hug the touchline' },
    { label: 'Come inside', phrase: '[player] tuck inside into the half-space' },
    { label: 'Overlap', phrase: '[player] get on the overlap and bomb down the wing' },
    { label: 'Run in behind', phrase: '[player] run in behind' },
    { label: 'Make runs', phrase: '[player] make runs and get on the move' },
    { label: 'Stay central', phrase: '[player] stay central and hold the middle' },
    { label: 'Come short', phrase: '[player] come short to feet' },
    { label: 'Drop into pocket', phrase: '[player] drift into the pockets between the lines' },
    { label: 'Hold it up', phrase: '[player] hold it up as the target man' },
  ] },
  { title: 'On the ball', items: [
    { label: 'Shoot on sight', phrase: '[player] shoot on sight' },
    { label: 'Cut inside to shoot', phrase: '[player] cut inside onto his stronger foot to shoot' },
    { label: 'Dribble more', phrase: '[player] take them on' },
    { label: 'Cross early', phrase: '[player] whip crosses in early' },
    { label: 'Cut it back', phrase: '[player] pull it back from the byline' },
    { label: 'Switch play', phrase: '[player] switch the play' },
    { label: 'Feed him', phrase: 'get the ball to [player]' },
  ] },
  { title: 'Defending', items: [
    { label: 'Man-mark', phrase: '[player] man-mark their [opponent]' },
    { label: 'Press hard', phrase: '[player] press him hard' },
    { label: 'Contain', phrase: "[player] sit off and jockey, don't dive in" },
    { label: 'Get stuck in', phrase: '[player] get stuck in' },
    { label: 'Stay on feet', phrase: '[player] stay on your feet' },
  ] },
];
function vocabPanel(input: HTMLTextAreaElement): HTMLElement {
  const add = (phrase: string) => { input.value = input.value.trim() ? `${input.value.trim()}, ${phrase}` : phrase; input.focus(); };
  return h('details', { style: 'margin-top:10px' },
    h('summary', { style: 'cursor:pointer;font-size:13px;color:var(--muted)' }, 'Instructions you can give — click to add ▾'),
    h('div', { class: 'muted', style: 'font-size:11px;margin:6px 0' }, 'Drop a phrasing into the plan, then edit the [names]. It’s compiled to your team’s instructions — anything it can’t read shows as a note below. (Instructions change decisions, not guaranteed goals.)'),
    ...VOCAB_GROUPS.map(g => h('div', { style: 'margin:8px 0' },
      h('div', { class: 'muted', style: 'font-size:11px;text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px' }, g.title),
      h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' }, ...g.items.map(it => {
        const b = h('button', { class: 'ghost small', type: 'button', title: it.phrase }, it.label);
        b.addEventListener('click', () => add(it.phrase));
        return b;
      })))));
}
interface TacticsMutationGate {
  run(action: () => Promise<void>): Promise<boolean>;
  onBusy(listener: (busy: boolean) => void): void;
  clearListeners(): void;
  whenIdle(): Promise<void>;
  focusOrigin(): HTMLElement | null;
}
function createTacticsMutationGate(): TacticsMutationGate {
  let busy = false;
  let origin: HTMLElement | null = null;
  const listeners = new Set<(busy: boolean) => void>();
  const idleWaiters = new Set<() => void>();
  const notify = () => { for (const listener of listeners) { try { listener(busy); } catch { /* detached panel */ } } };
  return {
    async run(action): Promise<boolean> {
      if (busy) { toast('Another tactics change is still being applied.'); return false; }
      origin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      busy = true; notify();
      try { await action(); return true; }
      finally {
        const restore = origin;
        busy = false; notify();
        for (const resolve of idleWaiters) resolve();
        idleWaiters.clear();
        origin = null;
        try { if (restore?.isConnected && !restore.hasAttribute('disabled')) restore.focus({ preventScroll: true }); } catch { /* remounted */ }
      }
    },
    onBusy(listener): void { listeners.add(listener); listener(busy); },
    clearListeners(): void { listeners.clear(); },
    whenIdle(): Promise<void> { return busy ? new Promise(resolve => idleWaiters.add(resolve)) : Promise.resolve(); },
    focusOrigin(): HTMLElement | null { return origin; },
  };
}
// One gate spans remounts and route changes. A request that already reached the server cannot be safely
// "cancelled" by navigation, so a newly mounted tactics screen must stay locked until that write settles.
const tacticsMutationGate = createTacticsMutationGate();
// route() calls this on every navigation that leaves #/tactics (mirrors teardownWatch): dropping the dead
// panels' busy-listeners on exit, while the gate itself — and any in-flight write — survives, see above.
// Re-entry is covered separately by screenTactics's own clearListeners() at the top of every render.
export function teardownTactics(): void { tacticsMutationGate.clearListeners(); }
function bindTacticsControls(gate: TacticsMutationGate, host: HTMLElement): void {
  type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement;
  const prior = new Map<Control, boolean>();
  gate.onBusy(busy => {
    if (busy) {
      prior.clear();
      host.querySelectorAll<Control>('input, select, textarea, button').forEach(el => { prior.set(el, el.disabled); el.disabled = true; });
    } else {
      for (const [el, disabled] of prior) if (el.isConnected) el.disabled = disabled;
      prior.clear();
    }
  });
}
function planPanel(team: TeamT, gate: TacticsMutationGate, alive: () => boolean, flash: TacticsPlanFlash | null = null): HTMLElement {
  // resolve the plan's ids (squad slots) to names for describeDirective — full squad so a directive on a
  // promoted bench player (slot > 10, from the structured board) still resolves, not just the nominal XI.
  setDirectiveNames(team.players.map(p => ({ id: p.slot, name: p.name })));
  const input = h('textarea', { class: 'tactics-input', rows: '3',
    placeholder: '"high press, build from the back, full-backs bomb on, sit deeper if 2-0 up. Suárez takes our penalties, Lars on long throws"' }) as HTMLTextAreaElement;
  input.value = team.planText ?? '';
  const out = h('div', { class: 'tactics-receipt', style: 'margin-top:10px' });
  const renderPlan = (plan: { summary: string; directives: any[] } | null | undefined, note?: string, error?: string | null) => {
    out.replaceChildren();
    if (error) out.appendChild(h('div', { class: 'warn' }, '⚠ ' + error + ' — saved your text; the team plays the neutral base until the plan compiles.'));
    if (plan?.summary) out.appendChild(h('div', { class: 'ok' }, plan.summary));
    const dirs = plan?.directives ?? [];
    if (dirs.length) {
      out.appendChild(h('div', { class: 'muted', style: 'margin-top:6px' }, 'Standing plan:'));
      for (const d of dirs) out.appendChild(h('div', { class: 'receipt-line' }, '• ' + describeDirective(d)));
    } else if (!error && (team.planText || input.value.trim())) {
      out.appendChild(h('div', { class: 'muted' }, "Couldn't read that as tactical orders — try plainer instructions."));
    }
    // surface the compiler's note prominently — it flags an order that was dropped/misread/ambiguous
    if (note) out.appendChild(h('div', { style: 'margin-top:8px;color:var(--gold);font-size:13px' }, '📝 ' + note));
  };
  const save = h('button', { class: 'primary small' }, 'Save plan');
  save.addEventListener('click', () => void gate.run(async () => {
    save.textContent = 'Saving…';
    try {
      const before = JSON.stringify(team.setPieceTakers ?? null);
      const text = input.value.trim();
      const r = await api.teamPlan(text);
      if (!alive()) return;
      team.planText = r.planText; team.plan = r.plan; team.setPieceTakers = r.setPieceTakers ?? null;
      renderPlan(r.plan, r.note, r.error);
      setTacticsPlanFlash((r.error || r.note) ? { error: r.error, note: r.note } : null);
      // §3: if the plan also (re)assigned dead-ball takers, the panel below must reflect it — re-render.
      if (JSON.stringify(r.setPieceTakers ?? null) !== before) { toast('Set-piece takers set from your plan ⚽'); return void rerender(); }
      toast(r.error ? 'Plan text saved, but its instructions could not be compiled.' : text ? 'Plan saved' : 'Plan cleared');
      // Always re-render so the structured board reflects the server's actual plan—even a compile error saves
      // a neutral plan. `tacticsPlanFlash` re-opens this editor with the compiler feedback intact.
      return void rerender();
    } catch (e: any) { if (alive()) out.replaceChildren(h('div', { class: 'warn' }, '⚠ ' + e.message)); }
    finally { if (save.isConnected) save.textContent = 'Save plan'; }
  }));
  // §2 quick-tactics: one-tap team mentality (deterministic, instant — no LLM wait). Sets the plan text +
  // directives together; the user can then refine in the box below.
  const QUICK: [string, string][] = [['defensive', '🛡️ Defensive'], ['balanced', '⚖️ Balanced'], ['attacking', '⚔️ Attacking'], ['allout', '🔥 All-out']];
  const quickRow = h('div', { class: 'row', style: 'gap:6px;margin-bottom:10px;flex-wrap:wrap' },
    ...QUICK.map(([key, label]) => {
      const b = h('button', { class: 'ghost small', title: 'Set your team’s overall approach in one tap (replaces the standing plan)' }, label) as HTMLButtonElement;
      b.addEventListener('click', () => void gate.run(async () => {
        try {
          const r = await api.quickTactics(key);
          if (!alive()) return;
          team.planText = r.planText; team.plan = r.plan;
          input.value = r.planText; renderPlan(r.plan);
          toast(`Tactics set: ${label.replace(/^\S+\s/, '')}`);
          return void rerender();
        } catch (e: any) { if (alive()) toast(e.message); }
      }));
      return b;
    }));
  renderPlan(team.plan, flash?.note, flash?.error);
  const panel = h('div', { class: 'card' },
    h('div', { class: 'section-title', style: 'margin-top:0' }, 'Tactical plan'),
    h('div', { class: 'muted', style: 'font-size:12px;margin-bottom:8px' }, 'Type a standing plan in plain English — it’s compiled to your team’s instructions and seeds every match (and your live shouts). Name your dead-ball takers here too ("Lars on long throws"). Mid-match, the shout box edits it.'),
    h('div', { class: 'muted', style: 'font-size:11px;text-transform:uppercase;letter-spacing:.4px;margin-bottom:5px' }, 'Quick tactics'),
    quickRow,
    h('div', { class: 'tactics-row' }, input, save),
    vocabPanel(input),
    out,
  );
  bindTacticsControls(gate, panel);
  return panel;
}

// ── tactics ──
// Set-piece takers (user-watch): designate FK / corner / pen / long-throw takers. A taker who isn't in
// the fielded XI falls back to the engine default (the backend drops his directive at spec-build).
type TakerKey = 'fk' | 'corner' | 'pen' | 'longThrow';
function setPieceTakerPanel(team: TeamT, gate: TacticsMutationGate, alive: () => boolean): HTMLElement {
  const players = [...team.players].sort((a, b) => a.slot - b.slot);
  const cur = team.setPieceTakers ?? { fk: null, corner: null, pen: null, longThrow: null };
  const fields: { key: TakerKey; label: string; s: HTMLSelectElement; saved: string }[] = ([
    ['fk', 'Free kicks'], ['corner', 'Corners'], ['pen', 'Penalties'], ['longThrow', 'Long throws'],
  ] as [TakerKey, string][]).map(([key, label]) => {
    const s = h('select', { class: 'tactics-input', style: 'width:auto;min-width:190px;padding:5px 8px' }) as HTMLSelectElement;
    s.append(h('option', { value: '' }, '— Default (by position) —'));
    for (const p of players) s.append(h('option', { value: String(p.slot) }, `${p.name} · ${p.role}${p.slot >= 11 ? ' (bench)' : ''}`));
    s.value = cur[key] != null ? String(cur[key]) : '';
    return { key, label, s, saved: s.value };
  });
  const save = (changed: typeof fields[number]) => void gate.run(async () => {
    const body = { fk: null as number | null, corner: null as number | null, pen: null as number | null, longThrow: null as number | null };
    for (const f of fields) body[f.key] = f.s.value === '' ? null : Number(f.s.value);
    try {
      const r = await api.setSetPieceTakers(body);
      if (!alive()) return;
      const saved = r.setPieceTakers ?? body;
      fields.forEach(f => { f.s.value = saved[f.key] == null ? '' : String(saved[f.key]); f.saved = f.s.value; });
      team.setPieceTakers = saved;
      toast('Set-piece takers updated');
    } catch (e: any) {
      if (!alive()) return;
      changed.s.value = changed.saved;
      toast(e.message);
    }
  });
  fields.forEach(f => f.s.addEventListener('change', () => save(f)));
  const panel = h('div', { class: 'card' },
    h('div', { class: 'section-title', style: 'margin-top:0' }, '⚽ Set-piece takers'),
    h('div', { class: 'muted', style: 'font-size:12px;margin-bottom:10px' }, 'Designate who takes your dead balls — or leave on Default to let the engine pick by position. A taker who isn’t in your matchday XI falls back to the default. You can also just say it in your tactical plan above ("Suárez takes our penalties").'),
    h('div', { class: 'grid cols-2', style: 'gap:10px' }, ...fields.map(f =>
      h('label', { class: 'between', style: 'gap:10px;align-items:center;font-size:13px' },
        h('span', { style: 'flex-shrink:0' }, f.label), f.s))));
  bindTacticsControls(gate, panel);
  return panel;
}

// ── structured tactics board (sliders / menus / formation picker) ──────────────────────────────────
// The deterministic, no-LLM tactics surface. Every control maps to a REAL engine-backed directive kind
// (tactics.ts VALID_KINDS) and is saved straight to plan_directives via /api/team/plan-structured — the
// same store the plain-English plan compiles to, so the two surfaces are interchangeable. FM positions
// (wing-back, inside forward, #10, holding mid…) are PRESET BUNDLES of (formation anchor + directives)
// over the engine's 6 roles, not new roles — the engine reads them today. The few that need engine work
// (ball-playing CB, true DM/AM behaviour) are labelled honestly or disabled.

// Recommended shapes shown first in the picker; the registry's auto-generated band shapes (6-0-4, …) go
// under "more shapes" so the menu leads with real, sensible formations.
const RECOMMENDED_FORMATIONS = ['4-3-3', '4-4-2', '4-2-3-1', '4-1-2-1-2', '4-3-2-1', '4-4-1-1', '4-2-2-2',
  '3-5-2', '3-4-3', '3-4-2-1', '5-3-2', '5-4-1', 'wide 4-2-3-1', 'wide diamond'];

// A per-player role preset = a bundle of per-player directive kinds (each [kind, intensity?]). The FIRST
// entry of every family is the NEUTRAL default (no directives) so an un-set team round-trips to zero
// directives. Grouped by the slot's engine-role family.
type RolePreset = { key: string; label: string; disabled?: boolean; dirs: [string, number?][] };
const ROLE_PRESETS: Record<string, RolePreset[]> = {
  GK: [{ key: 'gk', label: 'Goalkeeper', dirs: [] }],
  CB: [
    { key: 'defend', label: 'Central defender', dirs: [] },
    { key: 'stopper', label: 'Stopper — step out & press', dirs: [['press_hard', 0.8], ['tackle_hard', 0.7]] },
    { key: 'cover', label: 'Cover — hold, no risks', dirs: [['stay_back', 1], ['play_simple', 0.8]] },
    { key: 'ballplaying', label: 'Ball-playing — carry & pass out', dirs: [['ball_playing', 1]] },
  ],
  FB: [
    { key: 'fullback', label: 'Full-back', dirs: [] },
    { key: 'wingback', label: 'Wing-back — overlap & bomb on', dirs: [['overlap', 1], ['get_forward', 0.8], ['stay_wide', 1]] },
    { key: 'attacking', label: 'Attacking full-back — early crosses', dirs: [['overlap', 0.8], ['cross_early', 1]] },
    { key: 'inverted', label: 'Inverted full-back — tuck inside (approx.)', dirs: [['come_inside', 1], ['stay_back', 0.6]] },
    { key: 'defensive', label: 'Defensive full-back — stay home', dirs: [['stay_back', 1]] },
  ],
  MID: [
    { key: 'central', label: 'Central midfielder', dirs: [] },
    { key: 'box', label: 'Box-to-box — get forward', dirs: [['get_forward', 0.7], ['make_runs', 0.7]] },
    { key: 'deep', label: 'Holding / deep-lying', dirs: [['sit_deep', 0.8], ['stay_back', 1]] },
    { key: 'advanced', label: 'Advanced playmaker (#10)', dirs: [['get_forward', 0.8], ['drift_into_pocket', 1]] },
    { key: 'ballwinner', label: 'Ball-winner — press & tackle', dirs: [['press_hard', 1], ['tackle_hard', 0.8]] },
    { key: 'roaming', label: 'Roaming — take them on', dirs: [['dribble_more', 1], ['switch_play', 0.6]] },
  ],
  WM: [
    { key: 'wide', label: 'Wide midfielder', dirs: [] },
    { key: 'winger', label: 'Winger — stay wide, cross', dirs: [['stay_wide', 1], ['cross_early', 0.7]] },
    { key: 'inside', label: 'Inside forward — cut in & shoot', dirs: [['cut_inside', 1], ['shoot_on_sight', 1], ['come_inside', 0.6]] },
    { key: 'wideforward', label: 'Wide forward — get in behind', dirs: [['get_forward', 0.8], ['run_in_behind', 0.8]] },
    { key: 'wideplaymaker', label: 'Wide playmaker — drift in & switch', dirs: [['come_inside', 0.7], ['switch_play', 0.8]] },
    { key: 'trackback', label: 'Defensive winger — track back', dirs: [['stay_back', 0.8]] },
  ],
  CF: [
    { key: 'forward', label: 'Forward', dirs: [] },
    { key: 'poacher', label: 'Poacher — get in behind', dirs: [['run_in_behind', 1], ['shoot_on_sight', 0.8]] },
    { key: 'target', label: 'Target man — hold it up', dirs: [['target_man_holdup', 1]] },
    { key: 'false9', label: 'False 9 — drop & link', dirs: [['come_short', 1], ['drift_into_pocket', 0.8]] },
    { key: 'pressing', label: 'Pressing forward — hunt it down', dirs: [['press_hard', 1]] },
  ],
};
function roleFamily(role: string): string {
  if (role === 'GK' || role === 'CB' || role === 'FB' || role === 'WM' || role === 'CF') return role;
  return 'MID';   // CM / DM / AM all compile to CM (deep/high is carried by the slot anchor)
}
const engineRoleC = (r: string): string => (r === 'DM' || r === 'AM' ? 'CM' : r);
// The team-instruction segmented controls (opposite pairs → one 3-way). 'mid' emits nothing.
const SEG_PASSING = [{ key: 'long', label: 'Direct', kind: 'play_it_long' }, { key: 'mid', label: 'Mixed', kind: '' }, { key: 'short', label: 'Short', kind: 'keep_it_on_ground' }];
const SEG_WIDTH = [{ key: 'narrow', label: 'Narrow', kind: 'play_narrow' }, { key: 'mid', label: 'Balanced', kind: '' }, { key: 'wide', label: 'Wide', kind: 'get_it_wide' }];
const SEG_SHOOT = [{ key: 'patient', label: 'Work it in', kind: 'work_it_into_box' }, { key: 'mid', label: 'Mixed', kind: '' }, { key: 'range', label: 'Shoot on sight', kind: 'shoot_from_distance' }];

function boardSlider(labelText: string, bands: [string, string, string], value: number, onCommit: (v: number) => void): HTMLElement {
  const read = h('span', { class: 'muted', style: 'font-size:12px;text-align:right' });
  const setRead = (v: number) => { read.textContent = bands[v <= 0.3 ? 0 : v <= 0.6 ? 1 : 2]; };
  setRead(value);
  const input = h('input', { type: 'range', min: '0', max: '100', step: '5', value: String(Math.round(value * 100)), style: 'width:100%;accent-color:var(--accent)', 'aria-label': labelText }) as HTMLInputElement;
  input.addEventListener('input', () => setRead(Number(input.value) / 100));
  input.addEventListener('change', () => onCommit(Number(input.value) / 100));
  return h('div', { style: 'margin:10px 0' },
    h('div', { class: 'between', style: 'margin-bottom:3px;gap:10px' }, h('span', { style: 'font-size:13px;font-weight:600' }, labelText), read),
    input);
}
function boardSeg(labelText: string, opts: { key: string; label: string }[], value: string, onChange: (k: string) => void): HTMLElement {
  const btns: Record<string, HTMLButtonElement> = {};
  // paint the selected option (visual class + aria-pressed, so the state is exposed to assistive tech)
  const paint = (k: string) => { for (const key in btns) { const sel = key === k; btns[key].className = sel ? 'small' : 'ghost small'; btns[key].setAttribute('aria-pressed', String(sel)); } };
  const row = h('div', { class: 'row', role: 'group', 'aria-label': labelText, style: 'gap:6px;flex-wrap:wrap' }, ...opts.map(o => {
    const b = h('button', { type: 'button' }, o.label) as HTMLButtonElement;
    btns[o.key] = b;
    b.addEventListener('click', () => { paint(o.key); onChange(o.key); });
    return b;
  }));
  paint(value);
  return h('div', { style: 'margin:10px 0' }, h('div', { style: 'font-size:13px;font-weight:600;margin-bottom:4px' }, labelText), row);
}
function boardToggle(labelText: string, checked: boolean, onChange: (c: boolean) => void): HTMLButtonElement {
  let on = checked;
  const b = h('button', { type: 'button', 'aria-pressed': String(on), class: on ? 'small' : 'ghost small' }, labelText) as HTMLButtonElement;
  b.addEventListener('click', () => { on = !on; b.className = on ? 'small' : 'ghost small'; b.setAttribute('aria-pressed', String(on)); onChange(on); });
  return b;
}

// The team-wide kinds the board can represent (the 3 dials + the segmented pairs + the 3 toggles). Anything
// else (all_out_attack/park_the_bus/high_press/drop_off/push_up) or any conditional `when` can't be shown here,
// so we warn before a board save silently replaces them.
const BOARD_TEAM_KINDS = new Set(['mentality', 'press_intensity', 'line_height', 'play_it_long', 'keep_it_on_ground', 'play_narrow', 'get_it_wide', 'work_it_into_box', 'shoot_from_distance', 'counter_attack', 'offside_trap', 'slow_it_down', 'gk_up_for_corners']);
const hasWhenCond = (w: DirectiveT['when']): boolean => !!w && ((w.fromMin ?? 0) > 0 || (w.toMin ?? 1000) < 1000 || (!!w.scoreState && w.scoreState !== 'any') || !!w.phase);

function tacticsBoard(team: TeamT, reg: FormationsT | null, gate: TacticsMutationGate): HTMLElement {
  // directive playerIds are SQUAD SLOTS (the fielded player, incl. promoted bench) → names for the readback
  setDirectiveNames(team.players.map(p => ({ id: p.slot, name: p.name })));
  // `existing` is re-pointed to the latest saved plan after every commit, so seedPresets (on a formation
  // change) re-derives roles from what's actually persisted — not a stale load-time snapshot.
  let existing = team.plan?.directives ?? [];
  // EVERY saved directive the board can't represent (and a board save would therefore drop or rewrite):
  //   • team-wide kinds with no board control (park_the_bus, push_up, …);
  //   • any time/score/phase condition (the board has no `when` UI);
  //   • per-player orders the slot's reconstructed preset bundle doesn't reproduce EXACTLY — a lone typed
  //     "shoot_on_sight", an order on an unfielded player, or a preset-shaped set at custom intensities
  //     (save re-emits the preset's canonical intensities, silently rewriting the manager's).
  // Must run AFTER seedPresets() — it compares the SAVED plan with the preset reconstructed from that plan.
  // Keep the result as a snapshot until the next successful save: comparing against a newly selected role
  // would incorrectly label the old, ordinary role as an "advanced" instruction.
  let savedHiddenDirectives: DirectiveT[] = [];
  const detectHiddenDirectives = (): DirectiveT[] => {
    // squad slot -> the kind→intensity map the current preset choices would emit for the player fielded there
    const emitted = new Map<number, Map<string, number>>();
    slotsOf().forEach((s, i) => {
      const preset = ROLE_PRESETS[roleFamily(s.role)].find(p => p.key === presets[i]);
      emitted.set(squadIdx(i), new Map((preset?.dirs ?? []).map(([k, v]) => [k, v ?? 1])));
    });
    return existing.filter(d => {
      if (hasWhenCond(d.when)) return true;
      if (d.teamScope != null) return !BOARD_TEAM_KINDS.has(d.kind);
      return emitted.get(d.playerId)?.get(d.kind) !== (d.intensity ?? 1);   // unfielded / kind missing / intensity rewritten
    });
  };
  const hiddenDirectives = (): DirectiveT[] => savedHiddenDirectives;
  const teamKind = (k: string) => existing.find(d => d.teamScope != null && d.kind === k);
  const dialVal = (k: string) => { const d = teamKind(k); return typeof d?.intensity === 'number' ? d.intensity : 0.5; };
  // gk_up_for_corners is a 3-state set-piece instruction (off / 0.5 = up late when behind / 1 = every late
  // corner), so it defaults to 0 (off) rather than the dials' neutral 0.5 — read the saved intensity or off.
  const gkUpVal = () => { const d = teamKind('gk_up_for_corners'); return typeof d?.intensity === 'number' ? d.intensity : 0; };

  // ── mutable board state ──
  let formation = team.formation ?? '4-3-3';
  let lineup: number[] | null = team.lineup ?? null;
  const instr = {
    mentality: dialVal('mentality'), press: dialVal('press_intensity'), line: dialVal('line_height'),
    passing: teamKind('play_it_long') ? 'long' : teamKind('keep_it_on_ground') ? 'short' : 'mid',
    width: teamKind('play_narrow') ? 'narrow' : teamKind('get_it_wide') ? 'wide' : 'mid',
    shoot: teamKind('work_it_into_box') ? 'patient' : teamKind('shoot_from_distance') ? 'range' : 'mid',
    counter: !!teamKind('counter_attack'), offside: !!teamKind('offside_trap'), slow: !!teamKind('slow_it_down'),
    gkUp: gkUpVal(),   // 0 = keeper stays / 0.5 = up late when behind / 1 = up for every late corner
  };
  // per formation-slot preset key; seeded by matching each slot's existing per-player directive set
  let presets: string[] = [];
  const seedPresets = () => {
    const slots = slotsOf();
    presets = slots.map((s, i) => {
      const fam = ROLE_PRESETS[roleFamily(s.role)];
      const mine = new Set(existing.filter(d => d.teamScope == null && d.playerId === squadIdx(i)).map(d => d.kind));
      if (!mine.size) return fam[0].key;
      const hit = fam.find(p => p.dirs.length === mine.size && p.dirs.every(([k]) => mine.has(k)));
      return (hit ?? fam[0]).key;
    });
  };
  const slotsOf = () => reg?.formations[formation] ?? reg?.formations['4-3-3'] ?? [];
  const squadIdx = (i: number) => lineup?.[i] ?? i;

  // ── directive assembly ──
  const teamDirectives = (): DirectiveT[] => {
    const out: DirectiveT[] = [];
    const dial = (kind: string, v: number) => { if (Math.abs(v - 0.5) >= 0.06) out.push({ playerId: -1, teamScope: 0, kind, intensity: Math.round(v * 100) / 100 }); };
    dial('mentality', instr.mentality); dial('press_intensity', instr.press); dial('line_height', instr.line);
    const seg = (opts: { key: string; kind: string }[], v: string) => { const k = opts.find(o => o.key === v)?.kind; if (k) out.push({ playerId: -1, teamScope: 0, kind: k, intensity: 1 }); };
    seg(SEG_PASSING, instr.passing); seg(SEG_WIDTH, instr.width); seg(SEG_SHOOT, instr.shoot);
    if (instr.counter) out.push({ playerId: -1, teamScope: 0, kind: 'counter_attack', intensity: 1 });
    if (instr.offside) out.push({ playerId: -1, teamScope: 0, kind: 'offside_trap', intensity: 1 });
    if (instr.slow) out.push({ playerId: -1, teamScope: 0, kind: 'slow_it_down', intensity: 1 });
    // Set-piece: send the keeper up for late attacking corners. Off (0) emits nothing; the two intensity
    // modes ride as the standard team directive (0.5 = up late when behind, 1 = every late corner).
    if (instr.gkUp > 0) out.push({ playerId: -1, teamScope: 0, kind: 'gk_up_for_corners', intensity: instr.gkUp });
    return out;
  };
  const playerDirectives = (): DirectiveT[] => {
    const out: DirectiveT[] = [];
    const slots = slotsOf();
    slots.forEach((s, i) => {
      const fam = ROLE_PRESETS[roleFamily(s.role)];
      const preset = fam.find(p => p.key === presets[i]);
      // playerId = the SQUAD SLOT of whoever is fielded at this formation slot (may be a bench player the
      // auto-fit promoted) — resolvePlanDirectives maps that squad slot to the engine id, so the role follows
      // the player on the pitch, not the slot index.
      for (const [kind, intensity] of (preset?.dirs ?? [])) out.push({ playerId: squadIdx(i), kind, intensity: intensity ?? 1 });
    });
    return out;
  };
  const allDirectives = () => [...teamDirectives(), ...playerDirectives()];
  const stateFingerprint = (directives = allDirectives()): string => JSON.stringify({ formation, lineup, directives });

  // ── render targets ──
  const pitchBox = h('div', {});
  const slotBox = h('div', { class: 'grid cols-2', style: 'gap:6px;margin-top:10px' });
  const rolesBox = h('div', { class: 'grid cols-2', style: 'gap:8px' });
  const readout = h('div', { class: 'tactics-receipt', style: 'margin-top:10px' });
  const saveBtn = h('button', { class: 'primary' }, 'Save tactics') as HTMLButtonElement;
  const saveStatus = h('span', { class: 'muted', role: 'status', 'aria-live': 'polite', style: 'font-size:12px' });
  const warningHost = h('div', {});
  const boardRoot = h('div', { class: 'grid tactics-board' });
  let savedFingerprint = '', mutationBusy = false;
  const priorDisabled = new Map<HTMLInputElement | HTMLSelectElement | HTMLButtonElement, boolean>();
  const setBoardBusy = (busy: boolean) => {
    if (busy) {
      priorDisabled.clear();
      boardRoot.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input, select, button').forEach(el => { priorDisabled.set(el, el.disabled); el.disabled = true; });
    } else {
      for (const [el, disabled] of priorDisabled) if (el.isConnected) el.disabled = disabled;
      priorDisabled.clear();
    }
  };
  const isBoardDirty = () => stateFingerprint() !== savedFingerprint;
  const paintSaveState = () => {
    const dirty = isBoardDirty();
    saveBtn.disabled = mutationBusy || !dirty;
    saveBtn.textContent = mutationBusy ? 'Saving…' : dirty ? 'Save tactics •' : 'Saved';
    saveStatus.textContent = mutationBusy ? 'Applying changes…' : dirty ? 'Unsaved changes' : 'All changes saved';
  };
  const markDirty = () => { paintSaveState(); renderReadout(); renderHiddenWarning(); };
  const runBoardMutation = async (action: () => Promise<void>): Promise<void> => {
    await gate.run(action);
  };

  function renderReadout() {
    // resolve directive playerIds (squad slots, incl. promoted bench) → names for describeDirective's readback
    setDirectiveNames(team.players.map(p => ({ id: p.slot, name: p.name })));
    const dirs = allDirectives();
    readout.replaceChildren(h('div', { class: 'muted', style: 'font-size:11px;text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px' }, 'Your instructions'));
    if (!dirs.length) { readout.appendChild(h('div', { class: 'muted' }, 'Neutral base — no special instructions yet.')); return; }
    for (const d of dirs) readout.appendChild(h('div', { class: 'receipt-line' }, '• ' + describeDirective(d)));
  }
  function drawPitch() {
    const slots = slotsOf();
    const tokens = slots.map((s, i) => {
      const p = team.players[squadIdx(i)];
      return { x: s.x, y: s.y, role: s.role, name: p?.name ?? '—', injured: !!p?.injuredMatches, misfit: !!p && engineRoleC(p.role) !== engineRoleC(s.role) };
    });
    pitchBox.replaceChildren(reg ? pitchSvg(tokens, reg.pitchW, reg.pitchH) : h('div', { class: 'muted', style: 'font-size:12px' }, '(pitch unavailable)'));
  }
  // per-slot player picker — choosing a player already in the XI swaps the two slots; a bench player pushes
  // the displaced starter out. Persists immediately (structural, like changing the shape).
  function drawSlots() {
    const slots = slotsOf();
    const order = team.players.slice().sort((a, b) => a.slot - b.slot);
    slotBox.replaceChildren(...slots.map((s, i) => {
      const sel = h('select', { class: 'tactics-input', style: 'width:auto;flex:1;min-width:0;padding:5px 8px' }) as HTMLSelectElement;
      for (const p of order) sel.append(h('option', { value: String(p.slot) }, `${p.name} (${p.role})`));
      sel.value = String(squadIdx(i));
      const original = sel.value;
      sel.addEventListener('change', () => void runBoardMutation(async () => {
        if (!await confirmHiddenReplacement()) { sel.value = original; return; }
        const chosen = Number(sel.value);
        const cur = slots.map((_, j) => squadIdx(j));
        const at = cur.indexOf(chosen);
        const prev = cur[i]; cur[i] = chosen;
        if (at >= 0 && at !== i) cur[at] = prev;   // swap within the XI; bench-in (at<0) just drops prev
        if (!await persistFormation(formation, cur)) { sel.value = original; return; }
        await commitDirectives();                  // re-bind roles to the new XI so the saved plan matches the board
        redrawShape();
      }));
      return h('label', { class: 'row tactics-slot-row', style: 'gap:6px;align-items:center;font-size:12px' },
        h('span', { class: 'pill', style: 'flex-shrink:0;min-width:34px;text-align:center' }, s.role), sel);
    }));
  }
  function drawRoles() {
    const slots = slotsOf();
    rolesBox.replaceChildren(...slots.map((s, i) => {
      const fam = ROLE_PRESETS[roleFamily(s.role)];
      const p = team.players[squadIdx(i)];
      if (fam.length <= 1) return h('div', { class: 'row', style: 'gap:8px;align-items:center;font-size:12px' },
        h('span', { class: 'pill', style: 'min-width:34px;text-align:center' }, s.role), h('span', {}, p?.name ?? '—'));
      const sel = h('select', { class: 'tactics-input', style: 'width:100%;padding:5px 8px' }) as HTMLSelectElement;
      for (const pr of fam) { const o = h('option', { value: pr.key }, pr.label) as HTMLOptionElement; if (pr.disabled) o.disabled = true; sel.append(o); }
      sel.value = presets[i];
      sel.addEventListener('change', () => { presets[i] = sel.value; markDirty(); });
      return h('div', { style: 'font-size:12px' },
        h('div', { class: 'row', style: 'gap:6px;align-items:center;margin-bottom:3px' },
          h('span', { class: 'pill', style: 'min-width:34px;text-align:center' }, s.role), h('span', { style: 'font-weight:600' }, shortName(p?.name ?? '—'))),
        sel);
    }));
  }
  const redrawShape = () => { drawPitch(); drawSlots(); drawRoles(); renderReadout(); };

  async function persistFormation(fmt: string, lu: number[]): Promise<boolean> {
    try {
      const r = await api.setFormation(fmt, lu);
      formation = r.formation; lineup = r.lineup; badge.textContent = r.formation;
      return true;
    } catch (e: any) { toast(e.message); return false; }
  }
  // Persist the current directive board (team instructions + per-player roles). Called by the explicit Save AND
  // after any XI change (slot swap / Strongest XI / formation change) so the stored plan_directives always stay
  // bound to the fielded XI — playerDirectives() keys on squadIdx, so a lineup change re-targets the roles.
  // Re-points `existing` to the saved plan so a later formation change re-seeds from live state, not a stale load.
  async function commitDirectives(): Promise<boolean> {
    const directives = allDirectives();
    const fingerprint = stateFingerprint(directives);
    try {
      const mentWord = instr.mentality <= 0.3 ? 'Defensive' : instr.mentality <= 0.6 ? 'Balanced' : 'Attacking';
      const roleCount = presets.filter((k, i) => k !== ROLE_PRESETS[roleFamily(slotsOf()[i]?.role ?? 'MID')][0].key).length;
      const summary = `${mentWord} setup${roleCount ? `, ${roleCount} player role${roleCount > 1 ? 's' : ''} set` : ''}.`;
      const r = await api.setPlanStructured(directives, summary);
      team.planText = r.planText; team.plan = r.plan; existing = r.plan.directives ?? [];
      savedFingerprint = fingerprint;
      savedHiddenDirectives = detectHiddenDirectives();
      paintSaveState(); renderHiddenWarning();
      return true;
    } catch (e: any) { toast(e.message); paintSaveState(); return false; }
  }
  function renderHiddenWarning(): void {
    const hidden = hiddenDirectives();
    warningHost.replaceChildren();
    if (!hidden.length) return;
    warningHost.appendChild(h('div', { class: 'card tactics-hidden-warning', style: 'border-color:var(--gold)' },
      h('div', { style: 'color:var(--gold);font-size:13px' },
        `⚠ Your saved plan has instructions this board can't represent (${[...new Set(hidden.map(d => d.kind))].join(', ')}). A board save will replace or rewrite them; you will be asked before that happens.`)));
  }
  async function confirmHiddenReplacement(): Promise<boolean> {
    const hidden = hiddenDirectives();
    if (!hidden.length) return true;
    const kinds = [...new Set(hidden.map(d => d.kind))].join(', ');
    return confirmModal('Replace advanced instructions?',
      `This board cannot represent ${kinds}. Saving these changes will replace or rewrite those instructions.\n\nCancel and use the plain-English editor if you want to keep them.`,
      'Replace & save', 'danger', gate.focusOrigin());
  }

  // ── formation card ──
  const badge = h('span', { class: 'pill', style: 'margin-left:8px' }, formation);
  const fmtSel = h('select', { class: 'tactics-input', style: 'width:auto;min-width:150px;padding:5px 8px' }) as HTMLSelectElement;
  {
    const keys = reg ? Object.keys(reg.formations) : [formation];
    const rec = RECOMMENDED_FORMATIONS.filter(k => !reg || k in reg.formations);
    const more = keys.filter(k => !rec.includes(k)).sort();
    const grp = (label: string, ks: string[]) => { if (!ks.length) return; const og = h('optgroup', { label }) as HTMLOptGroupElement; for (const k of ks) og.append(h('option', { value: k }, k)); fmtSel.append(og); };
    grp('Formations', rec); grp('More shapes', more);
    fmtSel.value = formation;
  }
  fmtSel.addEventListener('change', () => {
    const requested = fmtSel.value, previous = formation;
    void runBoardMutation(async () => {
      if (!await confirmHiddenReplacement()) { fmtSel.value = previous; return; }
      // A shape change re-seeds role presets for different slots. Persist the current board first so pending
      // role/team changes are carried into that re-seed instead of silently disappearing.
      if (isBoardDirty() && !await commitDirectives()) { fmtSel.value = previous; return; }
      if (!await persistFormation(requested, [])) { fmtSel.value = previous; return; } // empty lineup → auto-fit this shape
      fmtSel.value = formation;
      seedPresets();                           // re-derive roles from the saved plan for the new slots
      const saved = await commitDirectives();  // persist those roles, now re-bound to the new XI
      redrawShape();
      if (saved) toast(`Shape: ${formation}`);
    });
  });
  const autoBtn = h('button', { class: 'ghost small', title: 'Field your strongest role-correct XI in this shape' }, '⚡ Strongest XI') as HTMLButtonElement;
  autoBtn.addEventListener('click', () => void runBoardMutation(async () => {
    if (!await confirmHiddenReplacement()) return;
    if (isBoardDirty() && !await commitDirectives()) return;
    try {
      const r = await api.autoLineup();
      const shapeChanged = r.formation !== formation;
      formation = r.formation; lineup = r.lineup; badge.textContent = formation; fmtSel.value = formation;
      if (shapeChanged) seedPresets();
      const saved = await commitDirectives(); redrawShape();
      if (saved) toast('Strongest XI selected');
    }
    catch (e: any) { toast(e.message); }
  }));

  seedPresets();
  savedHiddenDirectives = detectHiddenDirectives();
  savedFingerprint = stateFingerprint();
  redrawShape();

  const formationCard = h('div', { class: 'card' },
    h('div', { class: 'between' }, h('div', { class: 'section-title', style: 'margin-top:0' }, 'Formation', badge), autoBtn),
    h('div', { class: 'row', style: 'gap:8px;align-items:center;margin-bottom:8px' }, h('span', { style: 'font-size:13px' }, 'Shape'), fmtSel),
    pitchBox,
    h('div', { class: 'muted', style: 'font-size:11px;margin-top:8px' }, 'Pick a shape, then swap any player into a slot below (amber ⚠ = out of position).'),
    slotBox);

  // ── team-instructions card ──
  const sMent = boardSlider('Mentality', ['Defensive — see it out', 'Balanced', 'All-out attack'], instr.mentality, v => { instr.mentality = v; markDirty(); });
  const sPress = boardSlider('Pressing', ['Sit off & contain', 'Measured mid-block', 'Aggressive high press'], instr.press, v => { instr.press = v; markDirty(); });
  const sLine = boardSlider('Defensive line', ['Deep block', 'Mid', 'High line & squeeze'], instr.line, v => { instr.line = v; markDirty(); });
  const instrCard = h('div', { class: 'card' },
    h('div', { class: 'section-title', style: 'margin-top:0' }, 'Team instructions'),
    sMent, sPress, sLine,
    boardSeg('In possession', SEG_PASSING, instr.passing, k => { instr.passing = k; markDirty(); }),
    boardSeg('Width', SEG_WIDTH, instr.width, k => { instr.width = k; markDirty(); }),
    boardSeg('Shooting', SEG_SHOOT, instr.shoot, k => { instr.shoot = k; markDirty(); }),
    h('div', { style: 'font-size:13px;font-weight:600;margin:10px 0 4px' }, 'Extras'),
    h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' },
      boardToggle('Counter-attack', instr.counter, c => { instr.counter = c; markDirty(); }),
      boardToggle('Offside trap', instr.offside, c => { instr.offside = c; markDirty(); }),
      boardToggle('Waste time / slow it down', instr.slow, c => { instr.slow = c; markDirty(); })),
    // ── set pieces (team) ── send the keeper up for late attacking corners. A 3-state select rather than a
    // toggle: off, up only when chasing late, or up for every late corner. Rides as the gk_up_for_corners team
    // directive through the same plan-structured save as the dials.
    h('div', { style: 'font-size:13px;font-weight:600;margin:10px 0 4px' }, 'Set pieces'),
    (() => {
      const sel = h('select', { class: 'tactics-input', style: 'width:auto;min-width:230px;padding:5px 8px' }) as HTMLSelectElement;
      sel.append(h('option', { value: '0' }, 'Keeper stays back'));
      sel.append(h('option', { value: '0.5' }, 'Send keeper up late when behind'));
      sel.append(h('option', { value: '1' }, 'Send keeper up for every late corner'));
      sel.value = instr.gkUp === 1 ? '1' : instr.gkUp > 0 ? '0.5' : '0';
      sel.addEventListener('change', () => { instr.gkUp = Number(sel.value); markDirty(); });
      return h('label', { class: 'row', style: 'gap:8px;align-items:center;font-size:13px' },
        h('span', { style: 'flex-shrink:0' }, 'Late-corner keeper'), sel);
    })());

  // ── player-roles card ──
  const rolesCard = h('div', { class: 'card' },
    h('div', { class: 'section-title', style: 'margin-top:0' }, 'Player roles'),
    h('div', { class: 'muted', style: 'font-size:12px;margin-bottom:10px' }, 'Give each player a role — wing-backs, inside forwards, a #10, a holding mid, a target man. Each is a bundle of instructions the engine reads.'),
    rolesBox);

  // ── save bar ──
  saveBtn.addEventListener('click', () => void runBoardMutation(async () => {
    if (!await confirmHiddenReplacement()) return;
    if (await commitDirectives()) toast('Tactics saved ✓');
  }));
  renderReadout();

  boardRoot.replaceChildren(
    warningHost,
    formationCard,
    instrCard,
    rolesCard,
    h('div', { class: 'card' }, readout),
    h('div', { class: 'card tactics-savebar' },
      h('div', { class: 'between', style: 'gap:12px' }, saveStatus, saveBtn)));
  renderHiddenWarning();
  paintSaveState();
  gate.onBusy(busy => { mutationBusy = busy; setBoardBusy(busy); paintSaveState(); });
  return boardRoot;
}

export async function screenTactics() {
  const alive = screenGuard();
  tacticsMutationGate.clearListeners();
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading tactics…')));
  await tacticsMutationGate.whenIdle();
  if (!alive()) return;
  let team: TeamT;
  try { team = await api.team(); }
  catch (e: any) {
    if (!alive()) return;
    if (String(e.message).includes('no team')) return screenCreateTeam();
    return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message)));
  }
  const reg = await api.formations().catch(() => null);   // registry for the visual pitch (graceful if it fails)
  if (!alive()) return;
  const gate = tacticsMutationGate;
  const flash = getTacticsPlanFlash(); setTacticsPlanFlash(null);
  mount(header(), h('div', { class: 'wrap grid' },
    h('div', { class: 'between' },
      h('h2', {}, 'Tactics'),
      h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, '← Back')),
    tacticsBoard(team, reg, gate),
    setPieceTakerPanel(team, gate, alive),
    // The plain-English plan (LLM) stays as an optional power-user alternative to the board above — it
    // compiles to the SAME plan_directives store, so either surface can drive the team.
    h('details', { class: 'card', open: !!flash },
      h('summary', { style: 'cursor:pointer;font-weight:600' }, 'Prefer to type it? Plain-English plan ▾'),
      h('div', { style: 'margin-top:10px' }, planPanel(team, gate, alive, flash))),
  ));
}
