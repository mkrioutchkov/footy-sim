import './styles.css';
import { api, type TeamT, type PlayerT, type LeagueT, type MarketT, type CupT, type ReportT, type NewsItemT, type PlanT, type DirectiveT, type ScoutT, type SeasonHistoryT, type StaffViewT, type FinancesT, type HarmonyT, type FormationsT, type OfferT, type TrainingReportT, type RotationT, type ContractOfferT, type ScoutPlayerT, type IncomingOfferT, type AcademyProspectT, type FreeAgentOfferT, type TalkToneT, type TalkReactionT, type TacticsReviewT, type ShoutReviewT } from './api';
import { MatchRenderer } from './renderer';
import type { EngineState } from './types';

// ── live-watch socket envelope ── the web backend wraps each engine frame with team names +
// a replay flag, and pushes a tacticsReceipt message in reply to a shout. Typed here (not in
// types.ts) because it's the web transport layer, not the engine contract.
interface MotivationReaction { playerId: number; moraleDelta: number; reaction?: string; }
interface TacticsReceipt {
  error?: string; formation?: string; note?: string; changed?: string;
  motivation?: MotivationReaction[]; plan?: PlanT | null; directives?: DirectiveT[];
}
type WatchMessage = EngineState & { homeName?: string; awayName?: string; replay?: boolean; tacticsReceipt?: TacticsReceipt };

const root = document.getElementById('app')!;
let user: { id: number; username: string } | null = null;

// ── tiny DOM helper ──
type Attrs = Record<string, any>;
function h(tag: string, attrs: Attrs = {}, ...kids: (Node | string)[]): HTMLElement {
  const e = document.createElement(tag);
  // No `innerHTML` escape hatch on purpose — every value goes in as text or an attribute, so
  // user-supplied strings (team/player names, plans) can never inject markup. Build structure
  // with child nodes instead.
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, String(v));
  }
  for (const kid of kids) e.append(kid instanceof Node ? kid : document.createTextNode(kid));
  return e;
}
// SVG sibling of h() — createElementNS so <svg> children render; values go in as attributes and
// text as text nodes (so player names can't inject markup), same XSS-safe posture as h().
function svgEl(tag: string, attrs: Record<string, string | number | undefined> = {}, ...kids: (Node | string)[]): SVGElement {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) e.setAttribute(k, String(v));
  for (const kid of kids) e.append(kid instanceof Node ? kid : document.createTextNode(kid));
  return e;
}
function mount(...nodes: Node[]) { root.replaceChildren(...nodes); }
function toast(msg: string) {
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.appendChild(t);
  // mirror into a persistent polite live-region so screen readers announce transient toasts
  let live = document.getElementById('live-region');
  if (!live) { live = h('div', { id: 'live-region', class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' }); document.body.appendChild(live); }
  live.textContent = msg;
  setTimeout(() => t.remove(), 2600);
}

// ── in-app modals (replace native confirm()/prompt(), which are ugly + block the event loop) ──
// Both resolve a promise: cancel → false/null, confirm → true/the input value. ESC and a
// backdrop click cancel; Enter confirms. The focused control is set on open for keyboard use.
function confirmModal(title: string, message: string, okLabel = 'Confirm'): Promise<boolean> {
  return new Promise(resolve => {
    let done = false;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') finish(false); else if (e.key === 'Enter') finish(true); };
    const onHash = () => finish(false);   // navigating away closes the modal (it lives on body, not root)
    const finish = (v: boolean) => { if (done) return; done = true; document.removeEventListener('keydown', onKey); window.removeEventListener('hashchange', onHash); backdrop.remove(); resolve(v); };
    const ok = h('button', { class: 'primary', onclick: () => finish(true) }, okLabel);
    const card = h('div', { class: 'modal-card' },
      h('h3', { style: 'margin-bottom:10px' }, title),
      h('div', { class: 'muted', style: 'margin-bottom:18px;line-height:1.5;white-space:pre-wrap' }, message),
      h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { class: 'ghost', onclick: () => finish(false) }, 'Cancel'), ok));
    const backdrop = h('div', { class: 'modal-backdrop', onmousedown: (e: MouseEvent) => { if (e.target === backdrop) finish(false); } }, card);
    document.addEventListener('keydown', onKey);
    window.addEventListener('hashchange', onHash);
    document.body.appendChild(backdrop);
    ok.focus();
  });
}
function promptModal(title: string, message: string, value = '', okLabel = 'Submit'): Promise<string | null> {
  return new Promise(resolve => {
    let done = false;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') finish(null); };
    const onHash = () => finish(null);   // navigating away closes the modal (it lives on body, not root)
    const finish = (v: string | null) => { if (done) return; done = true; document.removeEventListener('keydown', onKey); window.removeEventListener('hashchange', onHash); backdrop.remove(); resolve(v); };
    const input = h('input', { type: 'text', value }) as HTMLInputElement;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(input.value); } });
    const card = h('div', { class: 'modal-card' },
      h('h3', { style: 'margin-bottom:10px' }, title),
      message ? h('div', { class: 'muted', style: 'margin-bottom:12px;line-height:1.5;white-space:pre-wrap' }, message) : '',
      h('div', { style: 'margin-bottom:16px' }, input),
      h('div', { class: 'row', style: 'justify-content:flex-end' },
        h('button', { class: 'ghost', onclick: () => finish(null) }, 'Cancel'),
        h('button', { class: 'primary', onclick: () => finish(input.value) }, okLabel)));
    const backdrop = h('div', { class: 'modal-backdrop', onmousedown: (e: MouseEvent) => { if (e.target === backdrop) finish(null); } }, card);
    document.addEventListener('keydown', onKey);
    window.addEventListener('hashchange', onHash);
    document.body.appendChild(backdrop);
    input.focus(); input.select();
  });
}
function fmtMoney(n: number): string {
  if (n >= 1e6) return `£${(n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1)}M`;
  if (n >= 1e3) return `£${Math.round(n / 1e3)}K`;
  return `£${n}`;
}
// OVR = mean of the 7 core skills (excludes height/handling) — matches the backend's
// overall() and the market/training screens, so a player's OVR reads the same everywhere
// and the potential headroom (a skill-based ceiling) compares against the right number.
const SKILL_KEYS = ['speed', 'passing', 'creativity', 'shooting', 'tackling', 'positioning', 'stamina'];
function skillOvr(attrs: Record<string, number>): number {
  return Math.round(SKILL_KEYS.reduce((s, k) => s + (attrs[k] ?? 0), 0) / SKILL_KEYS.length);
}
// per-cell attribute heat: red (low) → green (high), used across the squad table + compare.
const SQUAD_ATTRS: [string, string][] = [['speed', 'SPD'], ['passing', 'PAS'], ['creativity', 'CRE'], ['shooting', 'SHO'], ['tackling', 'TAC'], ['positioning', 'POS'], ['stamina', 'STA']];
// §2.10 fitness-band colours: red exhausted/injured, amber tired, green fresh, neutral ok.
const BAND_COLOR: Record<string, string> = { injured: 'var(--danger)', exhausted: 'var(--danger)', tired: '#ffb84d', ok: '', fresh: 'var(--accent)' };
function attrHeat(v: number): string {
  const hue = Math.max(0, Math.min(120, Math.round(((v - 35) / (95 - 35)) * 120)));
  return `color:hsl(${hue},70%,64%);font-weight:600`;
}

// Compact tables for the world's OTHER divisions (the user's own is the main table above).
// Empty for a legacy single-division world.
function otherDivisions(league: LeagueT): HTMLElement {
  const others = (league.world ?? []).filter(d => d.tier !== league.tier);
  if (!others.length) return h('div', { style: 'display:none' });
  // same tier-aware promotion/relegation dots as the main table (a division must exist above/below)
  const tiers = (league.world ?? []).map(d => d.tier);
  const promoteN = league.promote ?? 0;
  const zoneDot = (z: 'promo' | 'releg') => h('span', { title: z === 'promo' ? 'Promotion place' : 'Relegation place', style: `display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:4px;vertical-align:middle;background:${z === 'promo' ? 'var(--accent)' : 'var(--danger)'}` });
  const cards = others.map(d => {
    const hasPromo = promoteN > 0 && tiers.some(t => t < d.tier);
    const hasReleg = promoteN > 0 && tiers.some(t => t > d.tier);
    const tb = h('tbody');
    d.standings.forEach((s, i) => {
      const z = hasPromo && i < promoteN ? 'promo' : hasReleg && i >= d.standings.length - promoteN ? 'releg' : null;
      tb.append(h('tr', { class: s.isUser ? 'me' : '' },
      h('td', { class: 'num' }, z ? zoneDot(z) : '', String(i + 1)),
      h('td', {}, s.name, s.isUser ? h('span', { class: 'pill', style: 'margin-left:8px' }, ' you') : ''),
      h('td', { class: 'num' }, String(s.played)),
      h('td', { class: 'num' }, (s.gd > 0 ? '+' : '') + s.gd),
      h('td', { class: 'num', style: 'font-weight:700' }, String(s.points))));
    });
    return h('div', {},
      h('div', { class: 'section-title', style: 'margin-top:0' }, d.name),
      h('table', {}, h('thead', {}, h('tr', {},
        h('th', { class: 'num' }, '#'), h('th', {}, 'Club'),
        h('th', { class: 'num' }, 'P'), h('th', { class: 'num' }, 'GD'), h('th', { class: 'num' }, 'Pts'))), tb));
  });
  return h('div', { class: 'card' },
    h('div', { class: 'section-title', style: 'margin-top:0' }, 'Other divisions'),
    h('div', { class: 'grid cols-auto', style: 'align-items:start' }, ...cards));
}


function header(): HTMLElement {
  return h('header', { class: 'top' },
    h('div', { class: 'wrap' },
      h('div', { class: 'brand' }, 'FOOTY ', h('span', { class: 'a' }, 'MANAGER')),
      h('div', { class: 'row' },
        h('span', { class: 'muted' }, user ? user.username : ''),
        h('button', { class: 'ghost small', onclick: async () => { await api.logout(); user = null; route(); } }, 'Log out'),
      ),
    ),
  );
}

// A section-nav tile for the dashboard grid (icon + label → a hash route).
function navItem(icon: string, label: string, route: string): HTMLElement {
  return h('button', { class: 'nav-item', onclick: () => (location.hash = route) },
    h('span', { class: 'ico' }, icon), h('span', { class: 'lab' }, label));
}

// ── auth ──
function screenAuth() {
  let tab: 'login' | 'register' = 'login';
  const err = h('div', { class: 'err' });
  const uname = h('input', { placeholder: 'username', autocomplete: 'username' }) as HTMLInputElement;
  const pass = h('input', { type: 'password', placeholder: 'password', autocomplete: 'current-password' }) as HTMLInputElement;
  const submit = h('button', {}, 'Sign in');

  async function go() {
    err.textContent = '';
    submit.setAttribute('disabled', 'true');
    try {
      const fn = tab === 'login' ? api.login : api.register;
      const r = await fn(uname.value.trim(), pass.value);
      user = r.user;
      route();
    } catch (e: any) { err.textContent = e.message; submit.removeAttribute('disabled'); }
  }
  submit.addEventListener('click', go);
  pass.addEventListener('keydown', (ev: any) => { if (ev.key === 'Enter') go(); });

  const tabs = h('div', { class: 'tabs' });
  const tLogin = h('button', { class: 'active' }, 'Log in');
  const tReg = h('button', {}, 'Register');
  const setTab = (t: 'login' | 'register') => {
    tab = t; err.textContent = '';
    tLogin.classList.toggle('active', t === 'login');
    tReg.classList.toggle('active', t === 'register');
    submit.textContent = t === 'login' ? 'Sign in' : 'Create account';
  };
  tLogin.addEventListener('click', () => setTab('login'));
  tReg.addEventListener('click', () => setTab('register'));
  tabs.append(tLogin, tReg);

  mount(h('div', { class: 'center' },
    h('div', { class: 'card', style: 'width:360px' },
      h('div', { class: 'brand', style: 'font-size:24px;margin-bottom:6px' }, 'FOOTY ', h('span', { class: 'a' }, 'MANAGER')),
      h('div', { class: 'muted', style: 'margin-bottom:18px' }, 'Build a team. Set your tactics. Play the season.'),
      tabs,
      h('div', { class: 'field' }, h('label', {}, 'Username'), uname),
      h('div', { class: 'field' }, h('label', {}, 'Password'), pass),
      submit, err,
    ),
  ));
}

// ── create team ──
function screenCreateTeam() {
  const name = h('input', { placeholder: 'e.g. Brisbane Roar', value: `${user!.username} FC` }) as HTMLInputElement;
  const planInput = h('textarea', { class: 'tactics-input', rows: '3',
    placeholder: 'Optional — your tactical plan in plain English: "high press, build from the back, full-backs bomb on, sit deeper if 2-0 up". You can set or change it any time from Tactics.' }) as HTMLTextAreaElement;
  const err = h('div', { class: 'err' });
  const create = h('button', {}, 'Create team & start season');
  create.addEventListener('click', async () => {
    create.setAttribute('disabled', 'true'); create.textContent = 'Creating your club…';
    try {
      await api.createTeam(name.value.trim());
      const plan = planInput.value.trim();
      // P3: don't block entry on the LLM plan compile (~40s on a cold model — it used to freeze the
      // create screen with no feedback, and a timeout left you on a broken screen). Drop into the
      // dashboard immediately and compile the standing plan in the BACKGROUND; a toast reports how it landed.
      if (plan) {
        toast('Compiling your tactical plan in the background…');
        void api.teamPlan(plan)
          .then(r => toast(r.error ? 'Couldn’t read your plan — set it from the Tactics screen.' : '✓ Tactical plan set.'))
          .catch(() => toast('Couldn’t read your plan — set it from the Tactics screen.'));
      }
      route();
    } catch (e: any) { err.textContent = e.message; create.removeAttribute('disabled'); create.textContent = 'Create team & start season'; }
  });
  mount(header(), h('div', { class: 'wrap' },
    h('div', { class: 'card' },
      h('h2', {}, 'Create your club'),
      h('div', { class: 'muted', style: 'margin-bottom:16px' }, 'We’ll generate your squad — a starting XI plus bench — and drop you into an 8-team league against AI managers.'),
      h('div', { class: 'field' }, h('label', {}, 'Club name'), name),
      h('div', { class: 'section-title' }, 'Tactical plan'),
      planInput,
      h('div', { style: 'margin-top:16px' }, create), err,
    ),
  ));
}

// The standing tactical plan: a plain-English textarea + a read-only resolved-plan display
// (the compiled directives), mirroring the live shout receipt. Replaces the old 5-dial sliders.
// The directive vocabulary, grouped FM-style — every entry maps to a REAL engine-backed kind (no
// born-dead duties). Clicking a chip drops a phrasing into the plan box so the language is
// discoverable, not guessed. Includes the just-unblocked cutback / contain / stay_back (P0).
const VOCAB_GROUPS: { title: string; items: { label: string; phrase: string }[] }[] = [
  { title: 'Team shape', items: [
    { label: 'High press', phrase: 'press high and win it back fast' },
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
  ] },
  { title: 'Player movement', items: [
    { label: 'Get forward', phrase: '[player] get forward' },
    { label: 'Sit deep', phrase: '[player] sit deep' },
    { label: "Stay back", phrase: "[player] don't bomb forward" },
    { label: 'Stay wide', phrase: '[player] hug the touchline' },
    { label: 'Come inside', phrase: '[player] cut inside' },
    { label: 'Run in behind', phrase: '[player] run in behind' },
  ] },
  { title: 'On the ball', items: [
    { label: 'Shoot on sight', phrase: '[player] shoot on sight' },
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
function planPanel(team: TeamT): HTMLElement {
  // resolve the plan's team-relative ids (0-10) to player names for describeDirective
  watchPlayers = team.players.slice(0, 11).map((p, i) => ({ id: i, name: p.name }));
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
  save.addEventListener('click', async () => {
    save.setAttribute('disabled', 'true'); save.textContent = '…';
    try {
      const before = JSON.stringify(team.setPieceTakers ?? null);
      const r = await api.teamPlan(input.value.trim());
      team.planText = r.planText; team.plan = r.plan; team.setPieceTakers = r.setPieceTakers ?? null;
      renderPlan(r.plan, r.note, r.error);
      // §3: if the plan also (re)assigned dead-ball takers, the panel below must reflect it — re-render.
      if (JSON.stringify(r.setPieceTakers ?? null) !== before) { toast('Set-piece takers set from your plan ⚽'); return void screenTactics(); }
      toast(input.value.trim() ? 'Plan saved' : 'Plan cleared');
    } catch (e: any) { out.replaceChildren(h('div', { class: 'warn' }, '⚠ ' + e.message)); }
    save.removeAttribute('disabled'); save.textContent = 'Save plan';
  });
  // §2 quick-tactics: one-tap team mentality (deterministic, instant — no LLM wait). Sets the plan text +
  // directives together; the user can then refine in the box below.
  const QUICK: [string, string][] = [['defensive', '🛡️ Defensive'], ['balanced', '⚖️ Balanced'], ['attacking', '⚔️ Attacking'], ['allout', '🔥 All-out']];
  const quickRow = h('div', { class: 'row', style: 'gap:6px;margin-bottom:10px;flex-wrap:wrap' },
    ...QUICK.map(([key, label]) => {
      const b = h('button', { class: 'ghost small', title: 'Set your team’s overall approach in one tap (replaces the standing plan)' }, label) as HTMLButtonElement;
      b.addEventListener('click', async () => {
        b.setAttribute('disabled', 'true');
        try {
          const r = await api.quickTactics(key);
          team.planText = r.planText; team.plan = r.plan;
          input.value = r.planText; renderPlan(r.plan);
          toast(`Tactics set: ${label.replace(/^\S+\s/, '')}`);
        } catch (e: any) { toast(e.message); }
        b.removeAttribute('disabled');
      });
      return b;
    }));
  renderPlan(team.plan);
  return h('div', { class: 'card' },
    h('div', { class: 'section-title', style: 'margin-top:0' }, 'Tactical plan'),
    h('div', { class: 'muted', style: 'font-size:12px;margin-bottom:8px' }, 'Type a standing plan in plain English — it’s compiled to your team’s instructions and seeds every match (and your live shouts). Name your dead-ball takers here too ("Lars on long throws"). Mid-match, the shout box edits it.'),
    h('div', { class: 'muted', style: 'font-size:11px;text-transform:uppercase;letter-spacing:.4px;margin-bottom:5px' }, 'Quick tactics'),
    quickRow,
    h('div', { class: 'tactics-row' }, input, save),
    vocabPanel(input),
    out,
  );
}

// Formation control: a plain-text shout ("play 4-4-2", "AB at left back") sets the
// team's shape + XI for every match it plays. Shows the resolved XI + any note.
function shortName(n: string): string { return n.length > 13 ? n.slice(0, 12) + '…' : n; }
// A top-down pitch with 11 positioned tokens (engine HOME frame: x = depth own-goal-left, y = width).
function pitchSvg(tokens: { x: number; y: number; role: string; name: string; injured?: boolean; misfit?: boolean }[], pitchW: number, pitchH: number): SVGElement {
  const W = pitchW, H = pitchH, m = 8;
  const stroke = (extra: Record<string, string | number> = {}) => ({ fill: 'none', stroke: '#ffffff', 'stroke-opacity': 0.22, 'stroke-width': 3, ...extra });
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', style: 'max-height:520px;display:block;background:linear-gradient(180deg,#1c4a2c,#16331f);border-radius:10px' });
  svg.append(
    svgEl('rect', { x: m, y: m, width: W - 2 * m, height: H - 2 * m, ...stroke() }),
    svgEl('line', { x1: W / 2, y1: m, x2: W / 2, y2: H - m, ...stroke() }),
    svgEl('circle', { cx: W / 2, cy: H / 2, r: 80, ...stroke() }),
    svgEl('rect', { x: m, y: H / 2 - 160, width: 150, height: 320, ...stroke({ 'stroke-opacity': 0.18 }) }),
    svgEl('rect', { x: W - m - 150, y: H / 2 - 160, width: 150, height: 320, ...stroke({ 'stroke-opacity': 0.18 }) }),
  );
  for (const t of tokens) {
    // GK gold; a holding mid (DM) reads cooler/deeper, a #10 (AM) warmer/higher; outfield default green.
    const color = t.role === 'GK' ? '#ffd24d' : t.role === 'DM' ? '#4db8ff' : t.role === 'AM' ? '#ff9d5c' : '#43d39e';
    const g = svgEl('g', { transform: `translate(${t.x},${t.y})` });
    // Injured (red ring + 🤕) — auto-subbed at kickoff (§1.3). Out-of-position (amber ring + ⚠) —
    // a player anchored off his role for this shape (§1.11). Injured takes visual priority.
    const ring = t.injured ? '#ff5d5d' : t.misfit ? '#ffb84d' : '#0b1018';
    g.append(
      svgEl('circle', { r: 30, fill: color, 'fill-opacity': t.injured ? 0.35 : 0.92, stroke: ring, 'stroke-width': t.injured || t.misfit ? 3 : 2 }),
      svgEl('text', { 'text-anchor': 'middle', y: 6, 'font-size': 21, 'font-weight': 700, fill: '#0b1018' }, t.role),
      svgEl('text', { 'text-anchor': 'middle', y: 56, 'font-size': 22, fill: '#eef3f8', 'paint-order': 'stroke', stroke: '#0b1018', 'stroke-width': 4 }, shortName(t.name)),
    );
    if (t.injured) g.append(svgEl('text', { 'text-anchor': 'middle', y: -22, 'font-size': 26 }, '🤕'));
    else if (t.misfit) g.append(svgEl('text', { 'text-anchor': 'middle', y: -20, 'font-size': 22 }, '⚠'));
    svg.append(g);
  }
  return svg;
}
function formationPanel(team: TeamT, reg: FormationsT | null): HTMLElement {
  const badge = h('span', { class: 'pill', style: 'margin-left:8px' }, team.formation ?? '4-3-3');
  const out = h('div', { class: 'muted', style: 'font-size:12px;margin-top:8px' });
  const warn = h('div', { style: 'font-size:12px;color:#ff9d5c;margin-top:6px' });   // injured-starter notice (§1.3)
  const pitchBox = h('div', {});
  let fmt = team.formation ?? '4-3-3';
  let lineup: number[] | null = team.lineup ?? null;

  type Tok = { x: number; y: number; role: string; name: string; injured?: boolean };
  const tokensFromReg = (): Tok[] => {
    const slots = reg?.formations[fmt] ?? reg?.formations['4-3-3'] ?? [];
    return slots.map((s, i) => { const p = team.players[lineup?.[i] ?? i]; return { x: s.x, y: s.y, role: s.role, name: p?.name ?? '—', injured: !!p?.injuredMatches }; });
  };
  const drawPitch = (tokens: Tok[]) => {
    pitchBox.replaceChildren(reg ? pitchSvg(tokens, reg.pitchW, reg.pitchH) : h('div', { class: 'muted', style: 'font-size:12px' }, '(pitch unavailable)'));
    const hurt = tokens.filter(t => t.injured).map(t => t.name);
    warn.textContent = hurt.length ? `🤕 ${hurt.join(', ')} ${hurt.length > 1 ? 'are' : 'is'} injured — auto-subbed at kickoff. Pick a fit replacement.` : '';
  };
  drawPitch(tokensFromReg());

  const apply = async (text: string) => {
    out.textContent = 'Setting…';
    try {
      const r = await api.setLineup(text);
      fmt = r.formation; lineup = r.lineup; badge.textContent = r.formation;
      if (sel) sel.value = r.formation;
      out.textContent = r.note || `Lined up in a ${r.formation}.`;
      drawPitch(r.slots?.length ? r.slots.map(s => ({ x: s.homeX, y: s.homeY, role: s.role, name: s.playerName || '—', injured: !!team.players.find(p => p.name === s.playerName)?.injuredMatches, misfit: s.misfit })) : tokensFromReg());
    } catch (e: any) { out.textContent = e.message; }
  };
  // Minor (playthrough): group the ~35 shapes into Standard vs Experimental so the conventional
  // formations aren't buried among the novelty ones (2-6-2, 6-0-4, 4-6-0…). A shape is "experimental"
  // if it fields ≤2 or ≥6 defenders, 0 or ≥4 forwards, or ≥6 in midfield; named/variant keys stay standard.
  const isNovelty = (name: string): boolean => {
    const nums = name.split(/[- ]/).map(Number).filter(n => Number.isFinite(n));
    if (nums.length < 2) return false;
    const def = nums[0], fwd = nums[nums.length - 1], mid = nums.slice(1, -1).reduce((s, n) => s + n, 0);
    return def <= 2 || def >= 6 || fwd === 0 || fwd >= 4 || mid >= 6;
  };
  const mkOpt = (name: string) => { const o = h('option', { value: name }, name) as HTMLOptionElement; if (name === fmt) o.selected = true; return o; };
  const fkeys = reg ? Object.keys(reg.formations) : [];
  const fStd = fkeys.filter(k => !isNovelty(k)), fExp = fkeys.filter(isNovelty);
  const sel = reg ? h('select', { style: 'max-width:170px' },
    ...(fStd.length ? [h('optgroup', { label: 'Standard' }, ...fStd.map(mkOpt))] : []),
    ...(fExp.length ? [h('optgroup', { label: 'Experimental' }, ...fExp.map(mkOpt))] : []),
  ) as HTMLSelectElement : null;
  if (sel) sel.addEventListener('change', () => apply(`play ${sel.value}`));

  const input = h('input', { placeholder: 'fine-tune in words — “AB at left back”, “push the full-backs on”' }) as HTMLInputElement;
  const setBtn = h('button', { class: 'primary small' }, 'Set');
  const applyInput = () => { const t = input.value.trim(); if (t) { apply(t); input.value = ''; } };
  setBtn.addEventListener('click', applyInput);
  input.addEventListener('keydown', (ev: any) => { if (ev.key === 'Enter') applyInput(); });

  return h('div', { class: 'card' },
    h('div', { class: 'section-title', style: 'margin-top:0' }, 'Formation', badge),
    sel ? h('div', { class: 'row', style: 'gap:10px;margin-bottom:10px' }, h('span', { class: 'muted', style: 'font-size:12px' }, 'Shape'), sel) : '',
    pitchBox,
    warn,
    h('div', { class: 'tactics-row', style: 'margin-top:10px' }, input, setBtn),
    out,
  );
}

// §2.3: a player "seeking a move" — running down his deal (≤1y) AND unsettled (low morale, or a big
// ego stuck on the bench). Derived (no persisted flag), so it's always current. contractYears/morale/
// ego/slot all ride on PlayerT.
const seekingMove = (p: PlayerT): boolean =>
  (p.contractYears ?? 9) <= 1 && ((p.morale ?? 100) < 40 || ((p.personality?.traits?.ego ?? 0) >= 70 && p.slot >= 11));
// Contract-years cell style: red at ≤1y (walks next summer), amber at ≤2y.
const contractStyle = (yrs: number | undefined): string =>
  (yrs ?? 9) <= 1 ? 'color:var(--danger);font-weight:600' : (yrs ?? 9) <= 2 ? 'color:#ffb84d' : '';

// ── dashboard ──
async function screenDashboard() {
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading…')));
  let team: TeamT, league: LeagueT, news: NewsItemT[] = [], harmony: HarmonyT | null = null, reg: FormationsT | null = null;
  try {
    const [t, l, n, hm, fr] = await Promise.all([api.team(), api.league(), api.news().catch(() => ({ news: [] })), api.harmony().catch(() => null), api.formations().catch(() => null)]);
    team = t; league = l; news = n.news; harmony = hm; reg = fr;
  } catch (e: any) {
    if (String(e.message).includes('no team')) return screenCreateTeam();
    // team()/league() are essential — one transient failure shouldn't strand the home screen on a
    // bare error string with no way out. Offer a retry (news/harmony already fall back above).
    return mount(header(), h('div', { class: 'wrap' },
      h('div', { class: 'err' }, 'Couldn’t load your club — ' + (e.message || 'something went wrong') + '.'),
      h('button', { class: 'ghost', style: 'margin-top:12px', onclick: () => screenDashboard() }, '↻ Retry')));
  }

  // §2.5: a sacked manager's save is over — the board let you go. No dashboard; offer a fresh start
  // (a new team supersedes the old, so the career restarts cleanly).
  if (team.sacked) {
    return mount(header(), h('div', { class: 'wrap' },
      h('div', { class: 'card', style: 'text-align:center;border:1px solid var(--danger);max-width:560px;margin:40px auto' },
        h('h2', { style: 'color:var(--danger);margin-top:0' }, '🪦 You’ve been sacked'),
        h('div', { class: 'muted', style: 'margin:10px 0 18px;line-height:1.5' }, `${team.name} have parted ways with you — the board ran out of patience after three straight seasons in crisis. Your time at the club is over.`),
        h('button', { class: 'primary', onclick: () => screenCreateTeam() }, 'Start a new career'))));
  }

  const myNext = league.fixtures.find(f => f.involvesMe && !f.played);
  const myPos = league.standings.findIndex(s => s.teamId === league.myTeamId) + 1;

  // team / squad card
  const squad = h('div', { class: 'players' });
  for (const p of team.players) {
    const ovr = skillOvr(p.attrs);
    const per = p.personality;
    const potText = p.potential != null && p.potential > ovr ? ` → ${p.potential}` : '';
    const ageText = p.age != null ? ` · ${p.age}y` : '';
    const fitText = (p.injuredMatches ?? 0) > 0 ? ` · 🤕${p.injuredMatches}` : (p.fitness != null && p.fitness < 90 ? ` · ${p.fitness}%` : '');
    const moraleText = p.morale != null ? (p.morale >= 75 ? ' · 😊' : p.morale <= 40 ? ' · 😟' : '') : '';
    const r = (n: number) => Math.round(n);
    const card = h('div', { class: 'pcard', style: 'cursor:pointer', title: 'View profile & personality', onclick: () => (location.hash = `#/player/${p.slot}`) },
      h('div', { class: 'role' }, `${p.role} · OVR ${ovr}${potText}${ageText}${fitText}${moraleText}`),
      h('div', { class: 'pn' }, p.name),
      h('div', { class: 'at' }, `SPD ${r(p.attrs.speed)} · PAS ${r(p.attrs.passing)} · SHO ${r(p.attrs.shooting)}`,
        h('br'), `TAC ${r(p.attrs.tackling)} · POS ${r(p.attrs.positioning)} · CRE ${r(p.attrs.creativity)}`),
    );
    if (per && per.tagline) {
      card.setAttribute('title', `${per.nationality}${per.nationality ? ' · ' : ''}${per.backstory}`);
      card.append(h('div', { class: 'persona' },
        h('span', { class: 'tag' }, `“${per.tagline}”`),
        per.nationality ? h('span', { class: 'muted', style: 'font-size:11px' }, ` ${per.nationality}`) : '',
      ));
    }
    squad.append(card);
  }
  const needsPersonalities = team.players.some(p => !p.personality);
  const genPersBtn = h('button', { class: 'ghost small' }, 'Generate personalities');
  genPersBtn.addEventListener('click', async () => {
    genPersBtn.setAttribute('disabled', 'true'); genPersBtn.textContent = 'Generating…';
    try { await api.generatePersonalities(); toast('Personalities generated'); screenDashboard(); }
    catch (e: any) { toast(e.message); genPersBtn.removeAttribute('disabled'); genPersBtn.textContent = 'Generate personalities'; }
  });

  // advance is gated on the WHOLE world having games left (the user may have watched all
  // their own matches yet other fixtures still need playing before the season can roll).
  const canAdvance = league.seasonComplete != null ? !league.seasonComplete : !!myNext;
  // P4: advance plays the world's NEXT round (the min unplayed round) — which may be EARLIER than the
  // user's next match if they've watched ahead. Label + warn off THAT round (not myNext.round), and flag
  // when advancing will auto-simulate the user's own unplayed match, so the state is never a silent desync.
  const pendingUnplayed = league.fixtures.filter(f => !f.played);
  const pendingRound = pendingUnplayed.length ? Math.min(...pendingUnplayed.map(f => f.round)) : null;
  const myInPending = pendingRound != null ? league.fixtures.find(f => f.involvesMe && f.round === pendingRound) : undefined;
  const simmingMyMatch = !!(myInPending && !myInPending.played);
  const advanceBtn = h('button', {},
    !canAdvance ? 'Season complete'
      : simmingMyMatch ? `Play matchday ${pendingRound}`
        : `Advance matchday${pendingRound != null ? ` ${pendingRound}` : ''}`);
  if (!canAdvance) advanceBtn.setAttribute('disabled', 'true');
  advanceBtn.addEventListener('click', async () => {
    const opp = myInPending ? (myInPending.homeTeamId === team.id ? myInPending.away : myInPending.home) : '';
    const msg = simmingMyMatch
      ? `Your match this matchday — R${pendingRound}${opp ? ` vs ${opp}` : ''} — will be SIMULATED now, along with the rest of the world. To play it yourself, Cancel and use “Watch my next match”. There is no undo.`
      : `${myNext ? 'Your match this round is already played — a' : 'A'}dvancing simulates the rest of the world’s matchday now. No undo — set your lineup, tactics and transfers first.`;
    if (!await confirmModal(simmingMyMatch ? 'Simulate your match & advance?' : 'Advance matchday', msg, simmingMyMatch ? 'Simulate & advance' : 'Advance')) return;
    advanceBtn.setAttribute('disabled', 'true'); advanceBtn.textContent = 'Simulating…';
    try {
      const r = await api.advance();
      if (r.myResult) toast(`Your match: ${r.myResult.homeScore}–${r.myResult.awayScore}`);
      if (r.transfers?.length) {
        const t = r.transfers[0];
        const verb = t.type === 'buy_listed' ? 'bought' : 'signed';
        toast(r.transfers.length === 1
          ? `Transfer: ${t.teamName} ${verb} ${t.player} (${fmtMoney(t.fee)})`
          : `${r.transfers.length} transfers around the league`);
      }
      const myInj = (r.injuries ?? []).filter(i => i.teamId === team.id);
      if (myInj.length) toast(`🤕 ${myInj.map(i => `${i.player} out ${i.matches} match${i.matches > 1 ? 'es' : ''}`).join(' · ')}`);
      // §P2: matchday gate & TV income credited to the club
      if (r.income) toast(`💷 Gate & TV income: ${fmtMoney(r.income)}`);
      // §2.1: other clubs bidding for your listed players — resolve them in the Market
      for (const b of r.incomingBids ?? []) toast(`📥 ${b.from} bid ${fmtMoney(b.fee)} for ${b.player} — accept or reject in the Market`);
      // §2.1: how the matchday's free-agent offers were answered
      for (const f of r.faOffers ?? []) {
        if (f.type === 'fa_signed') toast(`✍️ ${f.player} accepted your offer — signed (${fmtMoney(f.wage)}/yr × ${f.years}y)`);
        else if (f.type === 'fa_rejected') toast(`✖ ${f.player} turned down your offer`);
        else if (f.type === 'fa_gone') toast(`🏃 ${f.player} signed for another club before answering your offer`);
      }
      // §2.4: listings that lapsed unsold at the window deadline
      for (const l of r.listingsExpired ?? []) toast(`⌛ ${l.player}'s listing expired unsold — the window closed`);
      // §2.2: how the matchday's contract talks resolved
      for (const c of r.contractOffers ?? []) {
        if (c.result === 'accepted') toast(`✍️ ${c.player} signed a new ${c.years}-year deal (${fmtMoney(c.wage)}/yr)`);
        else if (c.result === 'countered') toast(`↩ ${c.player}'s agent wants ${fmtMoney(c.counterWage ?? c.wage)}/yr — open his profile to respond`);
        else if (c.result === 'rejected') toast(`✖ ${c.player} turned down the contract offer`);
      }
      const wonCup = r.cup?.champion != null && r.cup.champion === team.id;
      if (r.cup?.myTie && !wonCup) {
        const c = r.cup.myTie;
        const pens = c.homeScore === c.awayScore ? ' (on pens)' : '';
        toast(`Cup: ${c.won ? 'beat' : 'lost to'} ${c.opponent} ${c.homeScore}–${c.awayScore}${pens}${c.won ? ' — through' : ' — knocked out'}`);
      }
      if (wonCup) toast('🏆 You won the Cup!');
      if (r.rollover) {
        const ro = r.rollover;
        const up = ro.promoted.find(p => p.teamId === team.id);
        const down = ro.relegated.find(p => p.teamId === team.id);
        const mine = ro.prizeMoney.find(p => p.teamId === team.id);
        const verdict = up ? `🎉 PROMOTED to Division ${up.toTier}!` : down ? `Relegated to Division ${down.toTier}.` : 'Season complete.';
        const released = (ro.contracts ?? []).filter(c => c.teamId === team.id && c.type === 'released');
        toast(`${verdict}${mine ? ` Prize money: ${fmtMoney(mine.amount)}.` : ''} Season ${ro.season} begins.`);
        if (released.length) toast(`${released.length} player(s) left on a free transfer — re-sign from the market, or renew deals earlier next season.`);
        const myYouth = (ro.youth ?? []).filter(y => y.teamId === team.id);
        const retired = myYouth.filter(y => y.type === 'retired'), intake = myYouth.filter(y => y.type === 'intake');
        if (retired.length || intake.length) toast(`Academy: ${intake.length} new prospect(s) in the youth setup${retired.length ? `, ${retired.length} veteran(s) retired` : ''}.`);
        for (const a of (ro.awards ?? []).filter(a => a.teamId === team.id)) {
          toast(`${a.type === 'pots' ? '🏆' : '🌟'} ${a.player} — your ${a.type === 'pots' ? 'Player' : 'Young Player'} of the Season!`);
        }
        const board = (ro.board ?? []).find(b => b.teamId === team.id);
        if (board) toast(`📋 Board: ${board.message}`);
      }
      screenDashboard();
    } catch (e: any) { toast(e.message); screenDashboard(); }
  });

  const watchBtn = h('button', { class: 'ghost' }, myNext ? 'Watch my next match' : 'Replay last match');
  watchBtn.addEventListener('click', async () => {
    const fx = myNext ?? [...league.fixtures].reverse().find(f => f.involvesMe && f.played);
    if (fx) location.hash = `#/watch/${fx.id}`;
  });

  // recent form (last 5 played in this division, oldest→newest) — computed from the fixtures already in
  // the payload, so no extra request and no engine. W/D/L from the team's own result.
  const FORM_DOT = (r: 'w' | 'd' | 'l') => h('span', {
    title: r.toUpperCase(),
    style: `display:inline-block;width:14px;height:14px;line-height:14px;text-align:center;font-size:9px;font-weight:700;border-radius:3px;color:#0b1018;`
      + `background:${r === 'w' ? 'var(--accent)' : r === 'd' ? 'var(--muted)' : 'var(--danger)'}`,
  }, r.toUpperCase());
  const formCell = (teamId: number): HTMLElement => {
    const res = league.fixtures
      .filter(f => f.played && f.homeScore != null && f.awayScore != null && (f.homeTeamId === teamId || f.awayTeamId === teamId))
      .sort((a, b) => a.round - b.round).slice(-5)
      .map(f => { const gf = f.homeTeamId === teamId ? f.homeScore! : f.awayScore!; const ga = f.homeTeamId === teamId ? f.awayScore! : f.homeScore!; return gf > ga ? 'w' : gf < ga ? 'l' : 'd'; });
    return h('td', { class: 'num' }, res.length
      ? h('span', { style: 'display:inline-flex;gap:3px;justify-content:center' }, ...res.map(FORM_DOT))
      : h('span', { class: 'muted' }, '—'));
  };
  // promotion / relegation zones — only where they ACTUALLY apply (a division must exist above/below in
  // this world), so the top tier shows no promotion + the bottom shows no relegation. A small dot on the
  // position + a legend; deliberately content-level so it never fights the .me row highlight.
  const worldTiers = (league.world ?? []).map(d => d.tier);
  const promoteN = league.promote ?? 0;
  const hasPromotion = promoteN > 0 && worldTiers.some(t => t < (league.tier ?? 99));
  const hasRelegation = promoteN > 0 && worldTiers.some(t => t > (league.tier ?? -1));
  const zoneOf = (i: number): 'promo' | 'releg' | null =>
    hasPromotion && i < promoteN ? 'promo'
      : hasRelegation && i >= league.standings.length - promoteN ? 'releg' : null;
  const ZONE_DOT = (z: 'promo' | 'releg'): HTMLElement => h('span', {
    title: z === 'promo' ? 'Promotion place' : 'Relegation place',
    style: `display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px;vertical-align:middle;background:${z === 'promo' ? 'var(--accent)' : 'var(--danger)'}`,
  });
  // standings table
  const tbody = h('tbody');
  league.standings.forEach((s, i) => {
    const z = zoneOf(i);
    tbody.append(h('tr', { class: s.isUser ? 'me' : '' },
      h('td', { class: 'num' }, z ? ZONE_DOT(z) : '', String(i + 1)),
      h('td', {}, s.name, s.isUser ? h('span', { class: 'pill', style: 'margin-left:8px' }, ' you') : ''),
      h('td', { class: 'num' }, String(s.played)),
      h('td', { class: 'num' }, String(s.won)), h('td', { class: 'num' }, String(s.drawn)), h('td', { class: 'num' }, String(s.lost)),
      h('td', { class: 'num' }, `${s.gf}:${s.ga}`),
      h('td', { class: 'num' }, (s.gd > 0 ? '+' : '') + s.gd),
      h('td', { class: 'num', style: 'font-weight:700' }, String(s.points)),
      formCell(s.teamId),
    ));
  });
  const table = h('table', {},
    h('thead', {}, h('tr', {},
      h('th', { class: 'num' }, '#'), h('th', {}, 'Club'),
      h('th', { class: 'num' }, 'P'), h('th', { class: 'num' }, 'W'), h('th', { class: 'num' }, 'D'), h('th', { class: 'num' }, 'L'),
      h('th', { class: 'num' }, 'GF:GA'), h('th', { class: 'num' }, 'GD'), h('th', { class: 'num' }, 'Pts'), h('th', { class: 'num' }, 'Form'))),
    tbody);

  // my fixtures
  const fxBox = h('div', {});
  for (const f of league.fixtures.filter(x => x.involvesMe)) {
    const score = f.played ? h('span', { class: 'sc' }, `${f.homeScore}–${f.awayScore}`) : h('span', { class: 'sc muted' }, 'vs');
    const action = f.played
      ? h('span', { style: 'display:flex;gap:6px' },
          h('button', { class: 'ghost small', onclick: () => (location.hash = `#/watch/${f.id}`) }, 'Watch'),
          h('button', { class: 'ghost small', onclick: () => (location.hash = `#/report/${f.id}`) }, 'Report'))
      : h('span', { style: 'display:flex;gap:6px;align-items:center' },
          h('button', { class: 'ghost small', onclick: () => (location.hash = `#/scout/${f.id}`) }, '🔍 Scout'),
          h('span', { class: 'pill' }, `R${f.round}`));
    fxBox.append(h('div', { class: 'fx me' },
      h('div', { class: 'h' }, f.home), score, h('div', {}, f.away), action));
  }

  // press conference — your words move squad morale via each player's dials. One per match (§2.14 cadence):
  // you can't spam the media to farm morale, so the room is shut until your next game once you've spoken.
  const pressOpen = league.pressAvailable !== false;
  const pressInput = h('textarea', { class: 'tactics-input', rows: '2', placeholder: 'Address the media — back your players, demand more, or stay ice-cool…' }) as HTMLTextAreaElement;
  const pressBtn = h('button', { class: 'ghost small' }, 'Address the media');
  if (!pressOpen) { pressInput.setAttribute('disabled', 'true'); pressBtn.setAttribute('disabled', 'true'); }
  // "How it landed" panel — surfaces the per-player reactions (+ in-character quotes) the backend
  // already returns, instead of collapsing them to a toast. Patched in place: no dashboard rebuild
  // (which would nuke scroll + refetch everything), so the squad cards' morale just goes mildly stale.
  const pressReceipt = h('div', { class: 'tactics-receipt', style: 'max-height:300px;margin-top:10px' });
  pressBtn.addEventListener('click', async () => {
    const txt = pressInput.value.trim(); if (!txt) { toast('Say something to the media first'); return; }
    pressBtn.setAttribute('disabled', 'true'); pressBtn.textContent = '…';
    pressReceipt.replaceChildren(h('div', { class: 'muted' }, 'Facing the press…'));
    try {
      const r = await api.press(txt);
      toast(`Media reaction: ${r.lifted} lifted${r.unsettled ? `, ${r.unsettled} unsettled` : ''}`);
      pressReceipt.replaceChildren(
        h('div', { class: 'muted', style: 'margin-bottom:5px' }, `How it landed — ${r.lifted} lifted, ${r.unsettled} unsettled:`),
        ...[...r.reactions].sort((a, b) => b.delta - a.delta).map(x => h('div', {
          class: 'receipt-line ' + (x.delta > 0 ? 'up' : x.delta < 0 ? 'down' : ''), style: 'font-size:13px;padding:2px 0',
        }, `${x.delta > 0 ? '▲' : x.delta < 0 ? '▼' : '·'} ${x.name} ${x.delta > 0 ? '+' : ''}${x.delta}${x.quote ? ` — “${x.quote}”` : ''}`)));
      // one per match — leave the room shut until the next game
      pressInput.value = ''; pressInput.setAttribute('disabled', 'true'); pressBtn.textContent = 'Spoken to the media';
    } catch (e: any) {
      pressReceipt.replaceChildren(h('div', { class: 'warn' }, '⚠ ' + e.message));
      pressBtn.removeAttribute('disabled'); pressBtn.textContent = 'Address the media';
    }
  });
  const pressCard = h('div', { class: 'card', style: 'margin-top:14px' },
    h('div', { class: 'section-title', style: 'margin-top:0' }, 'Press conference'),
    h('div', { class: 'muted', style: 'font-size:12px;margin-bottom:6px' },
      pressOpen ? 'What you say moves squad morale — each player reacts through his own personality.'
        : 'You’ve already faced the media this matchday — back after your next match.'),
    pressInput, h('div', { style: 'margin-top:6px' }, pressBtn), pressReceipt);

  // ── club news: events that evolved a player's story + dials ──
  const NEWS_ICON: Record<NewsItemT['type'], string> = { hat_trick: '⚽⚽⚽', brace: '⚽⚽', red_card: '🟥', star: '⭐', long_injury: '🤕', pots: '🏆', young_pots: '🌟' };
  // link by CURRENT name → slot (slots renumber on transfers, so a stored slot can drift); only
  // unique names link (a duplicate name can't be resolved to one player), and a player who has
  // since left the club just isn't a link.
  const nameCount = new Map<string, number>();
  for (const p of team.players) nameCount.set(p.name, (nameCount.get(p.name) ?? 0) + 1);
  const slotByName = new Map(team.players.filter(p => nameCount.get(p.name) === 1).map(p => [p.name, p.slot]));
  const newsCard = h('div', { class: 'card', style: 'margin-top:14px' },
    h('div', { class: 'between', style: 'margin-bottom:6px' },
      h('div', { class: 'section-title', style: 'margin:0' }, 'Club news'),
      news.length > 8 ? h('a', { class: 'a', style: 'font-size:12px;cursor:pointer', onclick: () => (location.hash = '#/news') }, 'View all →') : ''),
    news.length
      ? h('div', {}, ...news.slice(0, 8).map(n => h('div', { class: 'between', style: 'font-size:13px;padding:3px 0;' + (slotByName.has(n.player) ? 'cursor:pointer' : ''), onclick: () => { const s = slotByName.get(n.player); if (s != null) location.hash = `#/player/${s}`; } },
          h('span', {}, `${NEWS_ICON[n.type] ?? '•'} ${n.headline}`),
          h('span', { class: 'muted', style: 'font-size:11px' }, `S${n.season}`))))
      : h('div', { class: 'muted', style: 'font-size:12px' }, 'No headlines yet — play on and your players will make news.'));

  // ── dressing room: squad harmony at a glance ──
  const HARMONY_ICON: Record<string, string> = { leader: '🧭', pro: '⭐', disruptive: '⚠️', unsettled: '😟' };
  const harmonyCard = harmony ? (() => {
    const c = harmony.status === 'united' ? 'var(--accent)' : harmony.status === 'settled' ? '#7fb2ff' : harmony.status === 'restless' ? 'var(--gold)' : 'var(--danger)';
    return h('div', { class: 'card', style: 'margin-top:14px' },
      h('div', { class: 'section-title', style: 'margin-top:0' }, 'Dressing room'),
      h('div', { class: 'between', style: 'font-size:13px;margin-bottom:6px' },
        h('span', { style: `color:${c};font-weight:600;text-transform:capitalize` }, harmony.status),
        h('span', { class: 'muted' }, `avg morale ${harmony.avgMorale}`)),
      ...(harmony.players.length
        ? harmony.players.map(p => h('div', { class: 'between', style: 'font-size:12px;padding:2px 0;cursor:pointer', onclick: () => (location.hash = `#/player/${p.slot}`) },
            h('span', {}, `${HARMONY_ICON[p.tag] ?? '•'} ${p.name}`),
            h('span', { class: 'muted', style: 'font-size:11px' }, p.note)))
        : [h('div', { class: 'muted', style: 'font-size:12px' }, 'A settled, unremarkable dressing room.')]));
  })() : h('div', { style: 'display:none' });

  mount(header(), h('div', { class: 'wrap grid' },
    h('div', { class: 'between' },
      h('div', {}, h('h2', {}, team.name), h('div', { class: 'muted' },
        `Managed by ${team.manager} · ${league.divisionName ?? 'League'}${league.season ? ` · Season ${league.season}` : ''} · Position ${myPos}/${league.standings.length}`)),
      // Primary match-flow actions stay prominent up top; section nav moves to the grid below.
      h('div', { class: 'row' }, watchBtn,
        myNext ? h('button', { class: 'ghost', title: 'Address the squad before your next match', onclick: () => (location.hash = `#/teamtalk/${myNext.id}`) }, 'Team talk') : '',
        advanceBtn),
    ),
    h('div', { class: 'card', style: 'padding:14px' },
      h('div', { class: 'nav-grid' },
        navItem('👥', 'Squad', '#/squad'),
        navItem('💸', 'Market', '#/market'),
        navItem('🏃', 'Training', '#/training'),
        navItem('🎓', 'Academy', '#/academy'),
        navItem('🧑‍🏫', 'Staff', '#/staff'),
        navItem('💰', 'Finances', '#/finances'),
        navItem('🏆', 'Cup', '#/cup'),
        navItem('📜', 'History', '#/history'),
        navItem('♟️', 'Tactics', '#/tactics'))),
    // §1.17: a wage bill over budget (e.g. forced renewals after relegation shrank it) is otherwise
    // only visible if you open Finances — surface it up front (new signings are blocked until under).
    (team.wageBudget != null && team.wageBill != null && team.wageBill > team.wageBudget)
      ? h('div', { class: 'card', style: 'border-color:var(--danger);color:var(--danger);font-size:13px' },
        `⚠ Wage bill ${fmtMoney(team.wageBill)} exceeds your budget ${fmtMoney(team.wageBudget)} — sell or release to get back under (no new signings until you are).`)
      : '',
    // §2.3: contract-expiry card — players running down their deal walk for free at season end.
    (() => {
      const expiring = team.players.filter(p => (p.contractYears ?? 9) <= 1).sort((a, b) => (a.contractYears ?? 9) - (b.contractYears ?? 9));
      if (!expiring.length) return '';
      return h('div', { class: 'card', style: 'border-color:#ffb84d' },
        h('div', { class: 'section-title', style: 'margin-top:0;color:#ffb84d' }, `⏳ Out of contract soon (${expiring.length})`),
        h('div', { class: 'muted', style: 'font-size:12px;margin-bottom:8px' }, 'Renew them or they leave on a free at season end. A “seeking move” player is likely to agitate.'),
        h('div', { class: 'row', style: 'flex-wrap:wrap;gap:8px' }, ...expiring.map(p =>
          h('span', { class: 'pill', title: 'View profile / renew', style: 'cursor:pointer' + (seekingMove(p) ? ';background:var(--danger);color:#fff' : ''), onclick: () => (location.hash = `#/player/${p.slot}`) },
            `${p.name} · ${p.contractYears ?? 0}y${seekingMove(p) ? ' · seeking move' : ''}`))));
    })(),
    // the boardroom: confidence in the manager + the season objective with live progress
    (() => {
      const conf = league.confidence, obj = league.objective;
      if (!conf && !obj) return h('div', { style: 'display:none' });
      const rows: (HTMLElement | string)[] = [];
      if (conf) {
        const cc = conf.status === 'secure' ? 'var(--accent)' : conf.status === 'stable' ? '#7fb2ff' : conf.status === 'shaky' ? 'var(--gold)' : 'var(--danger)';
        const label = CONF_LABEL[conf.status] ?? conf.status;
        rows.push(h('div', {},
          h('div', { class: 'between', style: 'font-size:13px;margin-bottom:4px' },
            h('span', {}, '🪑 Board confidence'),
            h('span', { style: `color:${cc};font-weight:600` }, label)),
          h('div', { style: 'height:7px;background:var(--panel2,#161f30);border-radius:4px;overflow:hidden' },
            h('div', { style: `height:100%;width:${Math.max(0, Math.min(100, conf.value))}%;background:${cc}` })),
          league.boardMood ? h('div', { class: 'muted', style: 'font-size:11px;margin-top:5px;font-style:italic' }, league.boardMood) : ''));
      }
      if (obj) {
        // "just outside it" must never include a relegation place — the bottom `promote` spots are
        // the drop zone, so cap the amber band at the drop line (otherwise survival, whose target IS
        // the drop line, would render gold instead of red while actually in the relegation zone).
        const dropLine = league.standings.length - (league.promote ?? 2);
        const onTrack = myPos <= obj.target;
        const close = !onTrack && myPos <= Math.min(obj.target + 2, dropLine);
        const c = onTrack ? 'var(--accent)' : close ? 'var(--gold)' : 'var(--danger)';
        const gamesLeft = league.fixtures.filter(f => f.involvesMe && !f.played).length;
        // §2.6: spell out the margin + what missing it costs (objective → board confidence → your job).
        const margin = onTrack
          ? (obj.target - myPos > 0 ? `${obj.target - myPos} place${obj.target - myPos === 1 ? '' : 's'} clear of the target (${ordinal(obj.target)})` : `right on the target (${ordinal(obj.target)})`)
          : `${myPos - obj.target} place${myPos - obj.target === 1 ? '' : 's'} short of ${ordinal(obj.target)}, ${gamesLeft} game${gamesLeft === 1 ? '' : 's'} to go`;
        const consequence = onTrack
          ? 'Hold this to season’s end and the board stays satisfied.'
          : close
            ? 'Within reach — close the gap before the campaign ends.'
            : 'Finish short and the board’s confidence will slide — and your job with it.';
        rows.push(h('div', { style: conf ? 'margin-top:10px' : '' },
          h('div', { class: 'between', style: 'font-size:13px' },
            h('span', { style: 'font-weight:600' }, '📋 Board objective: ' + obj.label),
            h('span', { style: `color:${c};font-weight:600` }, onTrack ? 'on track' : close ? 'just outside it' : 'work to do')),
          h('div', { class: 'muted', style: 'font-size:12px;margin-top:3px' }, `Currently ${ordinal(myPos)} — ${margin}.`),
          h('div', { style: `color:${c};font-size:11px;margin-top:3px;font-style:italic` }, consequence)));
      }
      return h('div', { class: 'card', style: 'padding:12px 14px' }, ...rows);
    })(),
    h('div', { class: 'card' }, h('div', { class: 'section-title', style: 'margin-top:0' }, league.divisionName ?? 'League table'), table,
      (hasPromotion || hasRelegation) ? h('div', { class: 'muted', style: 'font-size:11px;margin-top:8px;display:flex;gap:16px' },
        hasPromotion ? h('span', {}, ZONE_DOT('promo'), 'Promotion') : '',
        hasRelegation ? h('span', {}, ZONE_DOT('releg'), 'Relegation') : '') : ''),
    otherDivisions(league),
    h('div', { class: 'grid cols-split', style: 'align-items:start' },
      h('div', { class: 'card' }, h('div', { class: 'section-title', style: 'margin-top:0' }, 'Your fixtures'), fxBox),
      h('div', {},
        formationPanel(team, reg),
        harmonyCard,
        newsCard,
        pressCard,
        h('div', { class: 'card', style: 'margin-top:14px' },
          h('div', { class: 'between', style: 'margin-bottom:8px' },
            h('div', { class: 'section-title', style: 'margin:0' }, `Squad · ${team.name}`),
            needsPersonalities ? genPersBtn : '',
          ),
          squad),
      ),
    ),
  ));
}

// ── tactics ──
// Set-piece takers (user-watch): designate FK / corner / pen / long-throw takers. A taker who isn't in
// the fielded XI falls back to the engine default (the backend drops his directive at spec-build).
type TakerKey = 'fk' | 'corner' | 'pen' | 'longThrow';
function setPieceTakerPanel(team: TeamT): HTMLElement {
  const players = [...team.players].sort((a, b) => a.slot - b.slot);
  const cur = team.setPieceTakers ?? { fk: null, corner: null, pen: null, longThrow: null };
  const fields: { key: TakerKey; label: string; s: HTMLSelectElement }[] = ([
    ['fk', 'Free kicks'], ['corner', 'Corners'], ['pen', 'Penalties'], ['longThrow', 'Long throws'],
  ] as [TakerKey, string][]).map(([key, label]) => {
    const s = h('select', { class: 'tactics-input', style: 'width:auto;min-width:190px;padding:5px 8px' }) as HTMLSelectElement;
    s.append(h('option', { value: '' }, '— Default (by position) —'));
    for (const p of players) s.append(h('option', { value: String(p.slot) }, `${p.name} · ${p.role}${p.slot >= 11 ? ' (bench)' : ''}`));
    s.value = cur[key] != null ? String(cur[key]) : '';
    return { key, label, s };
  });
  const save = async () => {
    const body = { fk: null as number | null, corner: null as number | null, pen: null as number | null, longThrow: null as number | null };
    for (const f of fields) body[f.key] = f.s.value === '' ? null : Number(f.s.value);
    try { await api.setSetPieceTakers(body); toast('Set-piece takers updated'); }
    catch (e: any) { toast(e.message); }
  };
  fields.forEach(f => f.s.addEventListener('change', save));
  return h('div', { class: 'card' },
    h('div', { class: 'section-title', style: 'margin-top:0' }, '⚽ Set-piece takers'),
    h('div', { class: 'muted', style: 'font-size:12px;margin-bottom:10px' }, 'Designate who takes your dead balls — or leave on Default to let the engine pick by position. A taker who isn’t in your matchday XI falls back to the default. You can also just say it in your tactical plan above ("Suárez takes our penalties").'),
    h('div', { class: 'grid cols-2', style: 'gap:10px' }, ...fields.map(f =>
      h('label', { class: 'between', style: 'gap:10px;align-items:center;font-size:13px' },
        h('span', { style: 'flex-shrink:0' }, f.label), f.s))));
}

async function screenTactics() {
  let team: TeamT;
  try { team = await api.team(); } catch { return route(); }
  const reg = await api.formations().catch(() => null);   // registry for the visual pitch (graceful if it fails)
  mount(header(), h('div', { class: 'wrap grid' },
    h('div', { class: 'between' },
      h('h2', {}, 'Tactics'),
      h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, '← Back')),
    planPanel(team),
    formationPanel(team, reg),
    setPieceTakerPanel(team),
  ));
}

// ── watch ──
let activeRenderer: MatchRenderer | null = null;
let activeWs: WebSocket | null = null;
let watchBar: HTMLElement | null = null;
let watchPanel: HTMLElement | null = null;
let watchStatus: HTMLElement | null = null;   // connecting / connection-lost overlay
let watchPanelObs: ResizeObserver | null = null;   // keeps the pitch sized to the space the panel leaves
let activeReplayTimer: ReturnType<typeof setInterval> | null = null;   // live goal-replay playback loop
let watchEpoch = 0;   // bumped on every teardown so an in-flight screenWatch can detect it was superseded
function teardownWatch() {
  watchEpoch++;
  if (activeReplayTimer) { clearInterval(activeReplayTimer); activeReplayTimer = null; }
  try { watchPanelObs?.disconnect(); } catch { /* */ } watchPanelObs = null;
  try { activeWs?.close(); } catch { /* */ } activeWs = null;
  try { activeRenderer?.destroy(); } catch { /* */ } activeRenderer = null;
  watchBar?.remove(); watchBar = null;     // teardown owns the floating control bar + tactics panel,
  watchPanel?.remove(); watchPanel = null; // so navigation (incl. watch→watch) never leaves them stacked
  watchStatus?.remove(); watchStatus = null;
}

// ── live tactics panel helpers (P4) ──
let watchPlayers: { id: number; name: string }[] = [];
function pname(id: number): string {
  return watchPlayers.find(p => p.id === id)?.name ?? `#${id}`;
}
const TEAM_LABEL: Record<string, string> = {
  all_out_attack: 'All-out attack', park_the_bus: 'Park the bus', high_press: 'High press',
  drop_off: 'Drop off / contain', play_it_long: 'Play it long', keep_it_on_ground: 'Keep it on the ground',
  get_it_wide: 'Get it wide', play_narrow: 'Play narrow', push_up: 'Push the line up', slow_it_down: 'Slow it down',
  counter_attack: 'Counter-attack', offside_trap: 'Offside trap',
};
// the gradated FM dials — [low, mid, high] readback bands keyed off the directive's intensity
const GRADATED: Record<string, [string, string, string]> = {
  press_intensity: ['pressing: sit off & contain', 'pressing: measured mid-block', 'pressing: aggressive high press'],
  mentality: ['mentality: defensive — see it out', 'mentality: balanced', 'mentality: all-out attack'],
  line_height: ['defensive line: deep block', 'defensive line: mid', 'defensive line: high & squeeze'],
};
const PLAYER_VERB: Record<string, string> = {
  shoot_on_sight: 'shoots on sight', get_forward: 'gets forward', sit_deep: 'sits deep',
  stay_wide: 'stays wide', come_inside: 'comes inside', stay_central: 'stays central',
  cross_early: 'crosses early', switch_play: 'switches the play', play_simple: 'keeps it simple',
  run_in_behind: 'runs in behind', make_runs: 'makes runs', dribble_more: 'takes them on',
  press_hard: 'presses hard', tackle_hard: 'gets stuck in', stay_on_feet: 'stays on his feet',
  cutback: 'cuts it back from the byline', contain: 'sits off and contains', stay_back: 'holds his position',
};
function condText(w: any): string {
  let c = '';
  if (w?.fromMin > 0 && w?.toMin < 1000) c += ` (min ${w.fromMin}–${w.toMin})`;
  else if (w?.fromMin > 0) c += ` (from ${w.fromMin}')`;
  else if (w?.toMin < 1000) c += ` (first ${w.toMin}')`;
  if (w?.scoreState && w.scoreState !== 'any') c += ` when ${w.scoreState}`;
  return c;
}
function describeDirective(d: any): string {
  const cond = condText(d.when);
  if (GRADATED[d.kind]) {   // the FM dials — describe by where the intensity sits (0-1)
    const i = typeof d.intensity === 'number' ? d.intensity : 1;
    const band = i <= 0.3 ? 0 : i <= 0.6 ? 1 : 2;
    return `Whole team — ${GRADATED[d.kind][band]}${cond}`;
  }
  if (d.teamScope != null && TEAM_LABEL[d.kind]) return `Whole team — ${TEAM_LABEL[d.kind]}${cond}`;
  const who = pname(d.playerId);
  if (d.kind === 'man_mark') return `${who} man-marks ${pname(d.targetId)}${cond}`;
  if (d.kind === 'target_player') return `${who} feeds ${pname(d.targetId)}${cond}`;
  if (PLAYER_VERB[d.kind]) return `${who} ${PLAYER_VERB[d.kind]}${cond}`;
  return `${who}: ${d.kind}${cond}`;
}

async function screenWatch(fixtureId: number) {
  teardownWatch();
  const myEpoch = watchEpoch;   // if another teardown/navigation bumps this during init, we bail below
  // Ensure the result is recorded (idempotent, deterministic, same as the stream).
  api.playFixture(fixtureId).catch(() => { /* may already be played */ });
  // Felt-tactics overlay (BACKLOG2 #1): surface the ACTIVE composite plan persistently in the viewer, seeded
  // from the team's standing plan so it's visible from kickoff (not just after a shout) — shouts update it live.
  const myTeam = await api.team().catch(() => null);
  if (myEpoch !== watchEpoch) return;   // navigated away during the fetch
  if (myTeam) watchPlayers = myTeam.players.slice(0, 11).map((p, i) => ({ id: i, name: p.name }));
  let activeDirectives: DirectiveT[] = (myTeam?.plan?.directives as DirectiveT[] | undefined) ?? [];

  root.replaceChildren();
  // Rewind to the start — only meaningful for a finished recording (revealed on the first
  // replay frame), since a live re-sim can't seek backwards.
  const rewindBtn = h('button', { class: 'ghost small', style: 'display:none', onclick: () => activeWs?.send(JSON.stringify({ type: 'seek', value: 0 })) }, '⏮ Rewind');
  // ⚽ Replay — appears after the first live goal; plays back the buffered run-up (instant action replay).
  const replayBtn = h('button', { class: 'primary small', style: 'display:none', title: 'Action replay of the last goal' }, '⚽ Replay goal') as HTMLButtonElement;
  const bar = h('div', { class: 'watch-bar' },
    h('button', { class: 'ghost small', onclick: () => { location.hash = '#/'; } }, '← Back'),
    h('button', { class: 'ghost small', onclick: () => activeWs?.send(JSON.stringify({ type: 'speed', value: 4 })) }, '4×'),
    h('button', { class: 'ghost small', onclick: () => activeWs?.send(JSON.stringify({ type: 'speed', value: 1 })) }, '1×'),
    h('button', { class: 'ghost small', onclick: () => activeWs?.send(JSON.stringify({ type: 'pause' })) }, 'Pause'),
    rewindBtn,
    replayBtn,
  );
  document.body.appendChild(bar);
  watchBar = bar;

  // ── live tactics panel: type a plan, see what was understood, apply it ──
  const receiptEl = h('div', { class: 'tactics-receipt' });
  const ta = h('textarea', { class: 'tactics-input', rows: '2',
    placeholder: 'Shout at your team — "AB mark their striker, everyone push up", or rev them up: "come on Lange, sort it out". Each shout edits your standing plan.' }) as HTMLTextAreaElement;
  const applyPlan = () => {
    const text = ta.value.trim();
    if (!text || !activeWs) return;
    receiptEl.replaceChildren(h('div', { class: 'muted' }, 'Applying…'));
    activeWs.send(JSON.stringify({ type: 'tactics', text }));
  };
  const showReceipt = (r: TacticsReceipt) => {
    receiptEl.replaceChildren();
    if (r.error) { receiptEl.appendChild(h('div', { class: 'warn' }, '⚠ ' + r.error)); return; }
    if (r.formation) receiptEl.appendChild(h('div', { class: 'ok' }, `✓ Shape → ${r.formation}`));
    const note = (r.note ?? '').trim();
    const changed = (r.changed ?? '').trim();
    const motivation: MotivationReaction[] = Array.isArray(r.motivation) ? r.motivation : [];
    const dirs: DirectiveT[] = r.plan?.directives ?? r.directives ?? [];
    // The persistent "Active tactics" strip owns the full directive list — update it from this shout's plan.
    if (r.plan?.directives) { activeDirectives = r.plan.directives; renderActivePlan(); }
    // The receipt now shows only what THIS shout DID (the live plan lives in the strip above).
    if (changed) receiptEl.appendChild(h('div', { class: 'ok' }, '✓ ' + changed));
    // Motivational reactions (personality-driven morale swings) — the team responding to the shout.
    for (const m of motivation) {
      receiptEl.appendChild(h('div', { class: 'receipt-line ' + (m.moraleDelta > 0 ? 'up' : 'down') },
        `${m.moraleDelta > 0 ? '▲' : '▼'} ${pname(m.playerId)} ${m.moraleDelta > 0 ? '+' : ''}${m.moraleDelta} morale${m.reaction ? ` — “${m.reaction}”` : ''}`));
    }
    // Manager-voice readback: the whole standing plan in prose (FM never narrates your tactic back).
    const summary = (r.plan?.summary ?? '').trim();
    if (summary) receiptEl.appendChild(h('div', { style: 'font-style:italic;color:var(--accent);margin:6px 0 2px;line-height:1.4' }, '“' + summary + '”'));
    if (!dirs.length && !motivation.length && !changed && !note && !r?.formation) {
      receiptEl.appendChild(h('div', { class: 'muted' }, "Couldn't read that as an order or a word to the players.")); return;
    }
    if (note) receiptEl.appendChild(h('div', { class: 'muted' }, '• ' + note));
  };
  // The persistent ACTIVE-PLAN strip: what the team is doing right now (updates on shouts) + a live
  // possession read so the tactic reads as a felt change, not an invisible directive.
  const possEl = h('span', { class: 'muted', style: 'font-size:11px' });
  const planEl = h('div', { class: 'tactics-receipt', style: 'border-bottom:1px solid var(--line);padding-bottom:7px;margin-bottom:7px;flex:0 0 auto;max-height:none' });
  const renderActivePlan = () => {
    planEl.replaceChildren(
      h('div', { class: 'between', style: 'font-size:12px;margin-bottom:3px' },
        h('span', { class: 'muted', style: 'text-transform:uppercase;letter-spacing:.4px' }, '📋 Active tactics'), possEl),
      ...(activeDirectives.length
        ? activeDirectives.map(d => h('div', { class: 'receipt-line', style: 'font-size:12px' }, '• ' + describeDirective(d)))
        : [h('div', { class: 'muted', style: 'font-size:12px' }, 'No standing instructions — shout to set the plan.')]));
  };
  renderActivePlan();
  const panel = h('div', { class: 'tactics-panel' },
    planEl,
    h('div', { class: 'tactics-row' }, ta, h('button', { class: 'primary small', onclick: applyPlan }, 'Apply')),
    receiptEl,
  );
  document.body.appendChild(panel);
  watchPanel = panel;

  const renderer = new MatchRenderer();
  activeRenderer = renderer;
  await renderer.init();
  // If the user navigated away (or to another match) during the async init, this screen is stale:
  // teardownWatch already ran — destroy this orphan renderer and stop before opening a socket.
  if (myEpoch !== watchEpoch) { renderer.destroy(); return; }

  // Keep the pitch above the floating panel: reserve exactly the panel's height (+margins),
  // so a tall standing plan doesn't overlap the pitch and a hidden panel (replay) frees the space.
  const syncReserve = () => {
    const visible = panel.style.display !== 'none' && panel.offsetHeight > 0;
    renderer.setReservedBottom(visible ? panel.offsetHeight + 24 : 8);
  };
  watchPanelObs = new ResizeObserver(syncReserve);
  watchPanelObs.observe(panel);
  syncReserve();

  // Connecting overlay — the canvas is otherwise a blank dark void until the first frame
  // arrives (and silently stays one if the match never starts). Cleared on the first frame.
  const status = h('div', { class: 'watch-status' }, h('div', { class: 'spin' }, 'Connecting to match…'));
  document.body.appendChild(status);
  watchStatus = status;
  const showStatusError = (msg: string) => {
    if (myEpoch !== watchEpoch) return;   // superseded — don't resurrect an overlay teardown removed
    status.replaceChildren(
      h('div', { class: 'err' }, msg),
      h('button', { class: 'ghost small', onclick: () => { location.hash = '#/'; } }, '← Back'),
    );
    status.style.display = '';
  };

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/match?fixture=${fixtureId}`);
  activeWs = ws;
  let replayUiApplied = false;
  let gotFrame = false;
  // ── live goal replay: buffer recent frames; on a goal, snapshot the run-up + offer an instant replay ──
  const GOAL_CLIP = 130;                       // frames of run-up to keep (~several seconds before the goal)
  const liveBuffer: WatchMessage[] = [];
  let goalClip: WatchMessage[] | null = null;
  let replaying = false;
  const playClip = () => {
    if (replaying || !goalClip || !goalClip.length || !activeRenderer) return;
    replaying = true;
    replayBtn.disabled = true; replayBtn.textContent = '⏵ Replaying…';
    const clip = goalClip;
    let i = 0;
    if (activeReplayTimer) clearInterval(activeReplayTimer);
    activeReplayTimer = setInterval(() => {
      if (!activeRenderer || i >= clip.length) {                                    // clip done (or torn down)
        if (activeReplayTimer) { clearInterval(activeReplayTimer); activeReplayTimer = null; }
        replaying = false;
        replayBtn.disabled = false; replayBtn.textContent = '⚽ Replay goal';
        if (activeRenderer && liveBuffer.length) activeRenderer.sync(liveBuffer[liveBuffer.length - 1]);   // snap back to live
        return;
      }
      activeRenderer.sync(clip[i]);   // the score/clock rewinds through the clip, then snaps forward to live
      i++;
    }, 45);
  };
  replayBtn.addEventListener('click', playClip);
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data) as WatchMessage;
      // A replayed recording is finished playback: drop the live-only shout box and offer rewind.
      if (msg.replay && !replayUiApplied) { replayUiApplied = true; panel.style.display = 'none'; rewindBtn.style.display = ''; syncReserve(); }
      if (msg.tacticsReceipt) { showReceipt(msg.tacticsReceipt); return; }
      if (Array.isArray(msg.players)) watchPlayers = msg.players.map(p => ({ id: p.id, name: p.name }));
      if (!gotFrame) { gotFrame = true; status.remove(); watchStatus = null; }
      // felt-tactics: live possession in the active-plan strip (YOUR share — flip it when you're the away side)
      if (typeof msg.possessionPct === 'number' && myTeam && msg.homeName) {
        const mine = msg.homeName === myTeam.name ? msg.possessionPct : 100 - msg.possessionPct;
        possEl.textContent = `Possession ${Math.round(mine)}%`;
      }
      // buffer live frames + arm the replay on a goal (a finished-recording replay has its own rewind/seek)
      if (!msg.replay && Array.isArray(msg.players)) {
        liveBuffer.push(msg);
        if (liveBuffer.length > GOAL_CLIP + 40) liveBuffer.shift();
        if (msg.events && msg.events.some(e => e.type === 'goal')) { goalClip = liveBuffer.slice(-GOAL_CLIP); replayBtn.style.display = ''; }
      }
      if (replaying) return;   // the clip is driving the renderer — keep buffering live frames but don't draw them
      renderer.sync(msg);
    } catch { /* */ }
  };
  ws.onerror = () => { if (!gotFrame) showStatusError('Could not connect to the match.'); };
  // A close before any frame means the match never streamed (engine missing / failed to start);
  // a close after frames is just the match ending or navigating away — nothing to flag.
  ws.onclose = () => { if (!gotFrame) showStatusError('The match could not be started.'); };
  // Teardown is owned centrally by route() (it calls teardownWatch() on leaving '#/watch/') and by
  // the next screenWatch() (which calls teardownWatch() up front) — so no per-screen hashchange
  // listener is needed here. Adding one per visit used to leak a listener on every watch→watch.
}

// ── transfer market ──
async function screenMarket() {
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading…')));
  let market: MarketT;
  try { market = await api.market(); }
  catch (e: any) {
    if (String(e.message).includes('no team')) return screenCreateTeam();
    return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message)));
  }
  let offers: OfferT[] = [];
  try { offers = (await api.offers()).offers; } catch { /* the bids panel just stays empty */ }
  const refreshOffers = async (): Promise<void> => { try { offers = (await api.offers()).offers; } catch { /* keep current */ } };
  // §2.1: incoming bids — other clubs bidding for YOUR listed players.
  let incoming: IncomingOfferT[] = [];
  try { incoming = (await api.incomingOffers()).incoming; } catch { /* none / pre-feature */ }
  // §2.1 (free-agent half): the manager's free-agent offers still being considered.
  let faOffers: FreeAgentOfferT[] = [];
  try { faOffers = (await api.freeAgentOffers()).offers; } catch { /* none / pre-feature */ }

  function render() {
    // Preserve scroll across the full re-render each action triggers (signing/listing/bidding
    // otherwise jumps every list back to the top). Capture the current panes before mount, restore after.
    const scrollPos: Record<string, number> = {};
    root.querySelectorAll<HTMLElement>('[data-scroll]').forEach(el => { if (el.dataset.scroll) scrollPos[el.dataset.scroll] = el.scrollTop; });
    const winY = window.scrollY;

    // free-agent pool — sign to your squad
    const faBody = h('tbody');
    if (!market.freeAgents.length) faBody.append(h('tr', {}, h('td', { colspan: '7', class: 'muted' }, 'No free agents left.')));
    const wageHeadroom = market.wageBudget - market.wageBill;
    const moneyCell = (value: number, wage: number) => h('td', { class: 'num' }, fmtMoney(value),
      h('div', { class: 'muted', style: 'font-size:10px' }, `${fmtMoney(wage)}/yr`));
    const faPending = new Map(faOffers.map(o => [o.agentId, o]));
    for (const a of market.freeAgents) {
      const afford = market.budget >= a.value, room = market.squad.length < market.squadMax, wageOk = a.wage <= wageHeadroom;
      const live = faPending.get(a.id);
      // §2.1: a free agent now CONSIDERS a wage offer rather than signing on the spot — he answers next matchday.
      const sign = live
        ? h('span', { class: 'pill', title: `Awaiting his reply at the next matchday`, style: 'background:#262d3a;font-size:11px' }, `⏳ ${fmtMoney(live.wage)}/yr × ${live.years}y`)
        : h('button', { class: 'ghost small' }, 'Make offer');
      if (!live) {
        if (!afford || !room) sign.setAttribute('disabled', 'true');
        else if (!wageOk) sign.setAttribute('title', 'His wage is over your budget — you can still try a lower offer');
        sign.addEventListener('click', async () => {
          const raw = await promptModal(`Offer ${a.name} terms`,
            `Offer ${a.name} (${a.role}, ${a.age}) an annual wage on a 3-year deal. He wants about ${fmtMoney(a.wage)} — match or beat it and he'll sign; lowball him and he'll walk. There's a ${fmtMoney(a.value)} signing-on fee. He decides at the next matchday.`,
            String(a.wage), 'Make offer');
          if (raw == null) return;
          const wage = Math.round(Number(String(raw).replace(/[^0-9.]/g, '')));
          if (!Number.isFinite(wage) || wage <= 0) { toast('Enter a positive wage'); return; }
          try { const r = await api.offerFreeAgent(a.id, wage, 3); market = r.market; faOffers = r.faOffers; toast(`Offer made to ${r.player} — he decides at the next matchday.`); render(); }
          catch (e: any) { toast(e.message); render(); }
        });
      }
      const faPot = a.potential != null && a.potential > a.overall;
      faBody.append(h('tr', {},
        h('td', {}, a.name),
        h('td', {}, h('span', { class: 'pill' }, a.role)),
        h('td', { class: 'num' }, String(a.age)),
        h('td', { class: 'num' }, String(a.overall)),
        h('td', { class: 'num' }, faPot ? h('span', { class: 'a' }, String(a.potential)) : (a.potential != null ? String(a.potential) : '—')),
        moneyCell(a.value, a.wage),
        h('td', { class: 'num' }, sign)));
    }

    // your squad — transfer-list for sale (or pull the listing)
    const sqBody = h('tbody');
    for (const p of market.squad) {
      const canSell = market.squad.length > market.squadMin;
      let btn: HTMLElement;
      if (p.onLoan) {
        // §2.12: a loaned-in player can be sent back to his parent early (frees the slot + wage)
        btn = h('button', { class: 'ghost small' }, 'End loan');
        if (market.squad.length <= market.squadMin) { btn.setAttribute('disabled', 'true'); btn.setAttribute('title', `can't drop below ${market.squadMin} players`); }
        else btn.addEventListener('click', async () => {
          if (!await confirmModal('End loan', `Send ${p.name} back to ${p.loanFrom ?? 'his parent club'} now? You'll free his squad slot and wages, ahead of the season-end return.`, 'Send back')) return;
          btn.setAttribute('disabled', 'true'); btn.textContent = '…';
          try { const r = await api.endLoan(p.slot); market = r.market; toast(`${r.player} sent back to ${r.from}`); render(); }
          catch (e: any) { toast(e.message); render(); }
        });
      } else {
        btn = p.listed ? h('button', { class: 'ghost small' }, 'Unlist') : h('button', { class: 'ghost small' }, 'List');
        if (!p.listed && !canSell) btn.setAttribute('disabled', 'true');
        btn.addEventListener('click', async () => {
          btn.setAttribute('disabled', 'true'); btn.textContent = '…';
          try {
            const r = p.listed ? await api.unlistPlayer(p.slot) : await api.listPlayer(p.slot);
            market = r.market; toast(p.listed ? `${p.name} taken off the market` : `${p.name} listed for ${fmtMoney((r as any).askPrice)}`); render();
          } catch (e: any) { toast(e.message); render(); }
        });
      }
      const sqPot = p.potential != null && p.potential > p.overall;
      sqBody.append(h('tr', {},
        h('td', {}, p.name, p.onLoan ? h('span', { class: 'pill', style: 'margin-left:6px', title: `on loan from ${p.loanFrom ?? 'another club'}${p.loanUntil != null ? ` until end of S${p.loanUntil}` : ''}` }, `loan: ${p.loanFrom ?? '?'}`) : (p.starter ? '' : h('span', { class: 'muted', style: 'font-size:11px' }, ' · bench')),
          p.listed ? h('span', { class: 'pill', style: 'margin-left:6px' }, p.askPrice != null ? fmtMoney(p.askPrice) : 'listed') : ''),
        h('td', {}, h('span', { class: 'pill' }, p.role)),
        h('td', { class: 'num' }, String(p.age)),
        h('td', { class: 'num' }, String(p.overall)),
        h('td', { class: 'num' }, sqPot ? h('span', { class: 'a' }, String(p.potential)) : (p.potential != null ? String(p.potential) : '—')),
        moneyCell(p.value, p.wage),
        h('td', { class: 'num' }, btn)));
    }

    const headRow = (label: string) => h('thead', {}, h('tr', {},
      h('th', {}, label), h('th', {}, 'Pos'),
      h('th', { class: 'num' }, 'Age'), h('th', { class: 'num' }, 'OVR'), h('th', { class: 'num' }, 'POT'),
      h('th', { class: 'num' }, 'Fee/Wage'), h('th', { class: 'num' }, '')));

    // ── club-to-club transfers: bid for a listed player at another club, with negotiation ──
    const win = market.window;
    const sendBid = async (playerId: number, fee: number): Promise<void> => {
      try {
        const r = await api.bid(playerId, fee);
        // A bid is now a PENDING offer the club resolves next matchday (accept/counter/reject) —
        // see the "Your bids" panel. (accepted can still come back from matching a counter.)
        if (r.status === 'pending') { toast(`Bid lodged with ${r.club} for ${fmtMoney(r.fee!)} — they respond at the next matchday.`); await refreshOffers(); render(); }
        else if (r.status === 'accepted') { market = r.market; toast(`Signed ${r.player} for ${fmtMoney(r.fee!)}`); await refreshOffers(); render(); }
        else { toast(r.error || `${r.club} rejected the bid`); render(); }
      } catch (e: any) { toast(e.message); render(); }
    };
    const doBid = async (t: typeof market.transferTargets[number]): Promise<void> => {
      try { market = await api.market(); } catch { /* keep the cached snapshot */ }   // §1.13: compose the bid against a fresh budget
      const ask = t.askPrice ?? t.value;
      const raw = await promptModal(`Bid for ${t.name}`,
        `${t.club} are asking ${fmtMoney(ask)}. Your budget: ${fmtMoney(market.budget)}.\nEnter a number, or shorthand like 1.5m / 500k.`,
        String(ask), 'Submit bid');
      if (raw == null) return;
      // accept plain numbers AND the shorthand the screen shows (£1.5M, 500k) — strip symbols,
      // then scale by a trailing m/k so "1.5m" reads as 1,500,000 rather than 2. Reject anything
      // that isn't a clean number with an optional single m/k suffix (so "1.5g" can't parse to ~2).
      const s = raw.trim().toLowerCase().replace(/[£,\s]/g, '');
      if (!/^\d*\.?\d+[mk]?$/.test(s)) { toast('Enter a valid bid — e.g. 1.5m, 500k, or 1500000'); return; }
      const mult = s.endsWith('m') ? 1e6 : s.endsWith('k') ? 1e3 : 1;
      const fee = Math.round(parseFloat(s) * mult);
      if (!fee || fee <= 0) { toast('Enter a valid bid'); return; }
      await sendBid(t.id, fee);   // awaited so the click guard spans the full request, not just the modal
    };
    const doLoan = async (t: typeof market.transferTargets[number]): Promise<void> => {
      if (!await confirmModal('Loan deal', `Take ${t.name} (${t.club}) on loan for the season? He returns to his club at the end of the campaign — no fee, but you carry his wages.`, 'Take on loan')) return;
      try { const r = await api.loan(t.id); market = r.market; toast(`${r.player} joins on loan from ${r.from}`); render(); }
      catch (e: any) { toast(e.message); render(); }
    };
    const tgtBody = h('tbody');
    if (!market.transferTargets.length) tgtBody.append(h('tr', {}, h('td', { colspan: '7', class: 'muted' }, 'No players listed for sale at other clubs.')));
    for (const t of market.transferTargets) {
      const bid = h('button', { class: 'ghost small' }, 'Bid');
      const loan = h('button', { class: 'ghost small', style: 'margin-left:4px' }, 'Loan');
      // Disable the button for the whole action (modal + request) so an impatient re-click on a
      // slow network can't fire a second concurrent bid/loan for the same player — the same guard
      // Sign/List use. render() rebuilds fresh buttons on success; the finally re-enables on cancel.
      const guard = (btn: HTMLElement, fn: () => Promise<void>) => async () => {
        if (btn.hasAttribute('disabled')) return;
        btn.setAttribute('disabled', 'true');
        try { await fn(); } finally { btn.removeAttribute('disabled'); }
      };
      if (!win.open) { for (const b of [bid, loan]) { b.setAttribute('disabled', 'true'); b.setAttribute('title', 'Transfer window is shut'); } }
      else { bid.addEventListener('click', guard(bid, () => doBid(t))); loan.addEventListener('click', guard(loan, () => doLoan(t))); }
      const tPot = t.potential != null && t.potential > t.overall;
      tgtBody.append(h('tr', {},
        h('td', {}, t.name, h('span', { class: 'muted', style: 'font-size:11px' }, ' · ' + t.club)),
        h('td', {}, h('span', { class: 'pill' }, t.role)),
        h('td', { class: 'num' }, String(t.age)),
        h('td', { class: 'num' }, String(t.overall)),
        h('td', { class: 'num' }, tPot ? h('span', { class: 'a' }, String(t.potential)) : (t.potential != null ? String(t.potential) : '—')),
        moneyCell(t.askPrice ?? t.value, t.wage),
        h('td', { class: 'num' }, h('span', { style: 'display:inline-flex' }, bid, loan))));
    }

    const wagePct = market.wageBudget > 0 ? Math.round((market.wageBill / market.wageBudget) * 100) : 0;

    // §2.1: your outstanding bids — pending (awaiting the club's reply at the next matchday),
    // countered (match their price or withdraw), or recently resolved.
    const offerLabel: Record<string, string> = { pending: '⏳ awaiting reply', countered: '↩ countered', accepted: '✅ signed', rejected: '✖ rejected' };
    const offerGuard = (btn: HTMLElement, fn: () => Promise<void>) => async () => { if (btn.hasAttribute('disabled')) return; btn.setAttribute('disabled', 'true'); try { await fn(); } finally { btn.removeAttribute('disabled'); } };
    const offerRow = (o: OfferT) => {
      const acts: (HTMLElement | string)[] = [];
      if (o.status === 'countered') {
        const m = h('button', { class: 'primary small' }, `Match ${fmtMoney(o.counterFee ?? o.fee)}`);
        m.addEventListener('click', offerGuard(m, async () => {
          try { const r = await api.matchOffer(o.id); if (r.status === 'accepted') { market = r.market; toast(`Signed ${r.player} for ${fmtMoney(r.fee!)}`); } offers = r.offers; render(); }
          catch (e: any) { toast(e.message); await refreshOffers(); render(); }
        }));
        acts.push(m);
      }
      if (o.status === 'pending' || o.status === 'countered') {
        const w = h('button', { class: 'ghost small', style: 'margin-left:4px' }, 'Withdraw');
        w.addEventListener('click', offerGuard(w, async () => { try { const r = await api.withdrawOffer(o.id); offers = r.offers; render(); } catch (e: any) { toast(e.message); } }));
        acts.push(w);
      }
      return h('tr', {},
        h('td', {}, o.playerName, h('span', { class: 'muted', style: 'font-size:11px' }, ' · ' + o.club)),
        h('td', { class: 'num' }, fmtMoney(o.fee)),
        h('td', {}, offerLabel[o.status] ?? o.status, o.status === 'countered' && o.counterFee != null ? h('span', { class: 'muted', style: 'font-size:11px' }, ` · they want ${fmtMoney(o.counterFee)}`) : ''),
        h('td', { class: 'num' }, ...acts));
    };
    const offersCard = offers.length
      ? h('div', { class: 'card' }, h('div', { class: 'section-title', style: 'margin-top:0' }, 'Your bids'), h('table', {}, ...offers.map(offerRow)))
      : '';

    // §2.1 incoming bids — other clubs want YOUR listed players; accept (sell) or reject.
    const incLabel: Record<string, string> = { pending: '⏳ awaiting your reply', accepted: '✅ sold', rejected: '✖ rejected' };
    const incRow = (o: IncomingOfferT) => {
      const acts: (HTMLElement | string)[] = [];
      if (o.status === 'pending') {
        const acc = h('button', { class: 'primary small' }, `Accept ${fmtMoney(o.fee)}`);
        acc.addEventListener('click', offerGuard(acc, async () => {
          try { const r = await api.acceptOffer(o.id); market = r.market; incoming = r.incoming; toast(`Sold ${o.playerName} to ${r.club} for ${fmtMoney(r.fee!)}`); render(); }
          catch (e: any) { toast(e.message); try { incoming = (await api.incomingOffers()).incoming; } catch { /* keep */ } render(); }
        }));
        const rej = h('button', { class: 'ghost small', style: 'margin-left:4px' }, 'Reject');
        rej.addEventListener('click', offerGuard(rej, async () => { try { const r = await api.rejectOffer(o.id); incoming = r.incoming; render(); } catch (e: any) { toast(e.message); try { incoming = (await api.incomingOffers()).incoming; } catch { /* keep */ } render(); } }));
        acts.push(acc, rej);
      }
      return h('tr', {},
        h('td', {}, o.playerName, o.playerSlot != null ? h('span', { class: 'muted', style: 'font-size:11px' }, ` · slot ${o.playerSlot}`) : ''),
        h('td', {}, h('span', { class: 'muted', style: 'font-size:12px' }, o.club)),
        h('td', { class: 'num' }, fmtMoney(o.fee)),
        h('td', {}, incLabel[o.status] ?? o.status),
        h('td', { class: 'num' }, ...acts));
    };
    const incomingCard = incoming.length
      ? h('div', { class: 'card', style: 'border-left:3px solid var(--accent,#4ea1ff)' },
          h('div', { class: 'section-title', style: 'margin-top:0' }, '📥 Bids for your players'),
          h('div', { class: 'muted', style: 'margin:-6px 0 8px;font-size:12px' }, 'Other clubs are bidding for players you listed — accept to sell, or reject.'),
          h('table', {}, ...incoming.map(incRow)))
      : '';

    mount(header(), h('div', { class: 'wrap grid' },
      h('div', { class: 'between' },
        h('div', {}, h('h2', {}, 'Transfer market'),
          h('div', { class: 'muted' }, `Budget ${fmtMoney(market.budget)} · wages ${fmtMoney(market.wageBill)}/${fmtMoney(market.wageBudget)} (${wagePct}%) · squad ${market.squad.length}/${market.squadMax}`)),
        h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, '← Back'),
      ),
      h('div', { class: 'card', style: `padding:8px 12px;${win.open ? (win.deadlineDay ? 'border-left:3px solid var(--danger)' : 'border-left:3px solid var(--accent,#4ea1ff)') : 'opacity:.8'}` },
        h('span', { style: win.open ? 'font-weight:600' : '' }, (win.deadlineDay ? '🚨 ' : win.open ? '🟢 ' : '🔒 ') + win.label),
        // §2.4: deadline-day urgency — count down the matchdays left in the window
        win.open ? h('span', { style: `margin-left:8px;font-size:12px;font-weight:600;color:${win.deadlineDay ? 'var(--danger)' : 'var(--accent)'}` },
          win.deadlineDay ? '· 🚨 Deadline day — shuts after this matchday' : `· closes in ${win.closesIn} matchday${win.closesIn === 1 ? '' : 's'}`) : '',
        h('span', { class: 'muted', style: 'margin-left:8px;font-size:12px' }, 'Free agents can be signed any time; club-to-club deals need an open window.')),
      market.backing ? h('div', { class: 'card', style: 'padding:8px 12px' },
        h('span', { class: 'muted', style: 'font-size:12px' }, `🏛️ ${market.backing}`)) : '',
      h('div', { class: 'grid cols-2', style: 'align-items:start' },
        h('div', { class: 'card' },
          h('div', { class: 'section-title', style: 'margin-top:0' }, 'Free agents',
            h('span', { class: 'pill', style: 'margin-left:8px;text-transform:none;letter-spacing:0;background:rgba(67,211,158,.15);color:var(--accent)' }, 'signable any time')),
          h('div', { style: 'max-height:520px;overflow:auto', 'data-scroll': 'fa' }, h('table', {}, headRow('Player'), faBody))),
        h('div', { class: 'card' },
          h('div', { class: 'section-title', style: 'margin-top:0' }, 'Your squad'),
          h('div', { class: 'muted', style: 'margin:-6px 0 8px;font-size:12px' }, `List a player to sell him — an AI club may buy once you have squad depth (12+).${win.open ? ' Listings lapse at the deadline if unsold.' : ''}`),
          h('div', { style: 'max-height:520px;overflow:auto', 'data-scroll': 'squad' }, h('table', {}, headRow('Player'), sqBody))),
      ),
      incomingCard,
      offersCard,
      h('div', { class: 'card' },
        h('div', { class: 'section-title', style: 'margin-top:0' }, 'For sale — other clubs',
          win.open ? '' : h('span', { class: 'pill', style: 'margin-left:8px;text-transform:none;letter-spacing:0;background:#3a2a1f;color:#ffce9a' }, '🔒 window shut')),
        h('div', { class: 'muted', style: 'margin:-6px 0 8px;font-size:12px' }, win.open ? 'Bid for a listed player — the club may accept, counter, or reject.' : 'Bidding opens during a transfer window.'),
        h('div', { style: 'max-height:420px;overflow:auto', 'data-scroll': 'targets' }, h('table', {}, headRow('Player'), tgtBody))),
    ));

    // Restore the captured scroll positions onto the freshly-mounted panes.
    root.querySelectorAll<HTMLElement>('[data-scroll]').forEach(el => {
      const v = el.dataset.scroll ? scrollPos[el.dataset.scroll] : undefined;
      if (typeof v === 'number') el.scrollTop = v;
    });
    window.scrollTo(0, winY);
  }
  render();
}

// ── training / development ──
// 'position' = role-matched drills (§2.7); the rest push one attribute club-wide or per-player.
const TRAINING_FOCI = ['balanced', 'position', 'speed', 'passing', 'creativity', 'shooting', 'tackling', 'positioning', 'stamina'];
const FOCUS_LABEL: Record<string, string> = {
  balanced: 'Balanced', position: 'Position-specific',
  speed: 'Speed', passing: 'Passing', creativity: 'Creativity', shooting: 'Shooting',
  tackling: 'Tackling', positioning: 'Positioning', stamina: 'Stamina',
};
const ATTR_SHORT: Record<string, string> = Object.fromEntries(SQUAD_ATTRS.map(([k, s]) => [k, s]));
const focusLabel = (f: string) => FOCUS_LABEL[f] ?? (f ? f[0].toUpperCase() + f.slice(1) : f);
const fmtDelta = (d: number) => `${d > 0 ? '+' : ''}${d}`;

async function screenTraining() {
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading…')));
  let team: TeamT;
  try { team = await api.team(); }
  catch (e: any) {
    if (String(e.message).includes('no team')) return screenCreateTeam();
    return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message)));
  }
  // The report is best-effort — show the screen even if it hasn't been generated yet (or 404s).
  let report: TrainingReportT | null = null;
  try { report = (await api.trainingReport()).report; } catch { /* no report yet */ }
  const ovrOf = (p: typeof team.players[number]) => skillOvr(p.attrs);

  // club-wide focus selector
  const sel = h('select', { class: 'focus-select' }) as HTMLSelectElement;
  for (const f of TRAINING_FOCI) {
    const o = h('option', { value: f }, focusLabel(f)) as HTMLOptionElement;
    if (f === (team.trainingFocus ?? 'balanced')) o.selected = true;
    sel.append(o);
  }
  sel.addEventListener('change', async () => {
    try { const r = await api.setTraining(sel.value); toast(`Club training focus: ${focusLabel(r.focus)}`); }
    catch (e: any) { toast(e.message); }
  });

  // ── last session's training report — "why did X improve" ──
  const reportCard = (() => {
    if (!report || !report.lines.length) return h('div', { class: 'card' },
      h('div', { class: 'muted', style: 'font-size:13px' }, '📈 No training session yet — play a matchday and your squad’s development shows up here.'));
    const lines = [...report.lines].sort((a, b) => b.ovrDelta - a.ovrDelta || b.ovrAfter - a.ovrAfter);
    const improved = lines.filter(l => l.ovrDelta > 0).length;
    const declined = lines.filter(l => l.ovrDelta < 0).length;
    const steady = lines.length - improved - declined;
    const chips: (HTMLElement | string)[] = [h('span', { class: 'pill' }, `Focus: ${focusLabel(report.teamFocus)}`)];
    if (report.coachBoost > 0) chips.push(h('span', { class: 'pill', style: 'background:rgba(67,211,158,.15);color:var(--accent)' }, `Coaching +${report.coachBoost}%`));
    if (report.harmonyFactor > 1) chips.push(h('span', { class: 'pill', style: 'background:rgba(67,211,158,.15);color:var(--accent)' }, 'Settled squad ↑'));
    else if (report.harmonyFactor < 1) chips.push(h('span', { class: 'pill', style: 'background:#3a2a1f;color:#ffce9a' }, 'Unsettled squad ↓'));

    const lineEls = lines.map(l => {
      const up = l.ovrDelta > 0, down = l.ovrDelta < 0;
      const deltaBadge = h('span', { style: `font-weight:700;${up ? 'color:var(--accent)' : down ? 'color:var(--danger)' : 'opacity:.55'}` },
        up ? `▲ ${l.ovrDelta}` : down ? `▼ ${Math.abs(l.ovrDelta)}` : '– 0');
      const attrChips = l.attrs.slice(0, 5).map(a => h('span', {
        class: 'pill', style: `text-transform:none;letter-spacing:0;font-size:11px;${a.delta > 0 ? 'color:var(--accent)' : 'color:var(--danger)'}`,
      }, `${ATTR_SHORT[a.key] ?? a.key} ${fmtDelta(a.delta)}`));
      return h('div', { class: 'card', style: 'padding:8px 10px;margin:0' },
        h('div', { class: 'between', style: 'align-items:baseline;gap:8px' },
          h('div', {}, h('span', { style: 'font-weight:600' }, l.name),
            h('span', { class: 'pill', style: 'margin-left:6px' }, l.role),
            l.individual ? h('span', { class: 'pill', style: 'margin-left:4px;background:rgba(78,161,255,.18)' }, `★ ${focusLabel(l.focus)}`) : ''),
          h('div', { style: 'display:flex;gap:8px;align-items:baseline;white-space:nowrap' },
            h('span', { class: 'muted', style: 'font-size:12px' }, `OVR ${l.ovrBefore}→${l.ovrAfter}`), deltaBadge)),
        l.attrs.length ? h('div', { class: 'row', style: 'gap:4px;flex-wrap:wrap;margin-top:5px' }, ...attrChips) : '',
        l.factors.length ? h('div', { class: 'muted', style: 'font-size:11px;margin-top:4px' }, l.factors.join(' · ')) : '');
    });

    return h('div', { class: 'card' },
      h('div', { class: 'between' },
        h('div', { class: 'section-title', style: 'margin-top:0' }, 'Last training session'),
        h('div', { class: 'muted', style: 'font-size:12px' }, `Season ${report.season} · after Matchday ${report.round}`)),
      h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap;margin:-2px 0 8px;align-items:center' }, ...chips,
        h('span', { class: 'muted', style: 'font-size:12px;margin-left:2px' }, `${improved} improved · ${declined} declined${steady ? ` · ${steady} steady` : ''}`)),
      h('div', { class: 'grid', style: 'gap:6px;max-height:440px;overflow:auto' }, ...lineEls));
  })();

  // ── squad table — OVR/potential + a per-player focus override ──
  const body = h('tbody');
  for (const p of [...team.players].sort((a, b) => a.slot - b.slot)) {
    const ovr = ovrOf(p), pot = p.potential ?? ovr;
    const room = pot - ovr;
    const pfSel = h('select', { class: 'focus-select', style: 'font-size:12px;padding:2px 4px' }) as HTMLSelectElement;
    pfSel.append(h('option', { value: '' }, 'Follow club'));
    for (const f of TRAINING_FOCI) {
      const o = h('option', { value: f }, focusLabel(f)) as HTMLOptionElement;
      if (f === (p.trainFocus ?? '')) o.selected = true;
      pfSel.append(o);
    }
    pfSel.addEventListener('change', async () => {
      try { const r = await api.setPlayerTraining(p.slot, pfSel.value); toast(r.focus ? `${p.name}: ${focusLabel(r.focus)}` : `${p.name} follows the club focus`); }
      catch (e: any) { toast(e.message); }
    });
    body.append(h('tr', {},
      h('td', {}, p.name, p.slot >= 11 ? h('span', { class: 'muted', style: 'font-size:11px' }, ' · bench') : ''),
      h('td', {}, h('span', { class: 'pill' }, p.role)),
      h('td', { class: 'num' }, p.age != null ? String(p.age) : '—'),
      h('td', { class: 'num' }, String(ovr)),
      h('td', { class: 'num' }, room > 0 ? h('span', { class: 'a' }, `${pot} (+${room})`) : String(pot)),
      h('td', {}, pfSel),
    ));
  }

  mount(header(), h('div', { class: 'wrap grid' },
    h('div', { class: 'between' },
      h('div', {}, h('h2', {}, 'Training'),
        h('div', { class: 'muted' }, 'Players drift toward their potential each matchday — faster while young and for the diligent. Set a club focus, or override one player to push a single attribute (or “Position-specific” to train for his role).')),
      h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, '← Back'),
    ),
    reportCard,
    h('div', { class: 'card' },
      h('div', { class: 'row', style: 'align-items:center;gap:10px;margin-bottom:6px' },
        h('span', { class: 'section-title', style: 'margin:0' }, 'Club training focus'), sel),
      h('div', { style: 'max-height:540px;overflow:auto;margin-top:8px' },
        h('table', {},
          h('thead', {}, h('tr', {},
            h('th', {}, 'Player'), h('th', {}, 'Pos'),
            h('th', { class: 'num' }, 'Age'), h('th', { class: 'num' }, 'OVR'), h('th', { class: 'num' }, 'Potential'), h('th', {}, 'Focus'))),
          body)),
    ),
  ));
}

// ── pre-match team talk (§2.13): pick a tone, see how it lands, deliver it ──
async function screenTeamTalk(fixtureId: number) {
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Gathering the squad…')));
  let data: { tones: TalkToneT[]; pending: { tone: string } | null; tone: string; reactions: TalkReactionT[] };
  try { data = await api.teamTalk(fixtureId); }
  catch (e: any) {
    if (String(e.message).includes('no team')) return screenCreateTeam();
    return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message),
      h('button', { class: 'ghost', style: 'margin-top:12px', onclick: () => (location.hash = '#/') }, '← Back')));
  }
  let tone = data.tone;

  function render() {
    const reactColor = (d: number) => d >= 0.08 ? 'var(--accent)' : d <= -0.08 ? 'var(--danger)' : 'var(--muted, #8a93a3)';
    const lifts = data.reactions.filter(r => r.delta >= 0.08).length;
    const rattles = data.reactions.filter(r => r.delta <= -0.08).length;
    const toneBtns = data.tones.map(t => {
      const b = h('button', { class: t.key === tone ? 'primary small' : 'ghost small', title: t.blurb }, t.label);
      if (t.key !== tone) b.addEventListener('click', async () => { try { data = await api.teamTalk(fixtureId, t.key); tone = data.tone; render(); } catch (e: any) { toast(e.message); } });
      return b;
    });
    const blurb = data.tones.find(t => t.key === tone)?.blurb ?? '';
    const rows = data.reactions.slice().sort((a, b) => b.delta - a.delta).map(r => h('div', { class: 'between', style: 'font-size:13px;padding:3px 0' },
      h('span', {}, r.name, h('span', { class: 'muted', style: 'font-size:11px;margin-left:6px' }, r.role)),
      h('span', { style: `color:${reactColor(r.delta)};font-weight:600;text-transform:capitalize` }, `${r.reaction}${r.delta ? ` (${r.delta > 0 ? '+' : ''}${r.delta.toFixed(2)})` : ''}`)));

    const deliver = h('button', { class: 'primary' }, data.pending ? 'Update the talk' : 'Deliver this talk');
    deliver.addEventListener('click', async () => {
      deliver.setAttribute('disabled', 'true'); deliver.textContent = '…';
      try { await api.setTeamTalk(fixtureId, tone); toast('Team talk locked in — it shades your next match.'); location.hash = '#/'; }
      catch (e: any) { toast(e.message); deliver.removeAttribute('disabled'); deliver.textContent = 'Deliver this talk'; }
    });

    mount(header(), h('div', { class: 'wrap grid' },
      h('div', { class: 'between' },
        h('div', {}, h('h2', {}, 'Team talk'), h('div', { class: 'muted' }, 'How you address the squad before kick-off shades their morale for the match — and each player reacts to his own temperament.')),
        h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, '← Back')),
      h('div', { class: 'card' },
        h('div', { class: 'row', style: 'flex-wrap:wrap;gap:6px' }, ...toneBtns),
        h('div', { class: 'muted', style: 'font-size:12px;margin-top:8px' }, blurb),
        data.pending ? h('div', { class: 'muted', style: 'font-size:11px;margin-top:4px;font-style:italic' }, `Currently set: ${data.tones.find(t => t.key === data.pending!.tone)?.label ?? data.pending.tone}`) : ''),
      h('div', { class: 'card' },
        h('div', { class: 'between', style: 'margin-bottom:6px' },
          h('div', { class: 'section-title', style: 'margin:0' }, 'How it lands'),
          h('span', { class: 'muted', style: 'font-size:11px' }, `${lifts} lifted · ${rattles} rattled`)),
        // Honest hint when nobody reacts: a talk moves players via their PERSONALITY, so a squad with no
        // strong characters yet (freshly created, or personalities still being generated) barely stirs.
        lifts === 0 && rattles === 0 && data.reactions.length
          ? h('div', { class: 'muted', style: 'font-size:12px;font-style:italic;margin-bottom:6px' }, 'No one’s stirred — this squad has no strong personalities for a talk to move yet (they settle as your players’ characters develop).')
          : '',
        h('div', { style: 'max-height:420px;overflow:auto' }, ...rows)),
      h('div', { class: 'row' }, deliver),
    ));
  }
  render();
}

// ── youth academy (§2.9): the club's developing prospects + promote-to-squad ──
async function screenAcademy() {
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading the academy…')));
  let prospects: AcademyProspectT[];
  try { prospects = (await api.academy()).prospects; }
  catch (e: any) { if (String(e.message).includes('no team')) return screenCreateTeam(); return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message))); }

  const body = h('tbody');
  for (const p of prospects) {
    const room = (p.potential ?? p.overall) - p.overall;
    const promote = h('button', { class: 'primary small' }, 'Promote');
    promote.addEventListener('click', async () => {
      promote.setAttribute('disabled', 'true');
      try { const r = await api.promoteProspect(p.id); toast(`${r.player} promoted to the senior squad`); screenAcademy(); }
      catch (e: any) { toast(e.message); promote.removeAttribute('disabled'); }
    });
    body.append(h('tr', {},
      h('td', {}, p.name),
      h('td', {}, h('span', { class: 'pill' }, p.role)),
      h('td', { class: 'num' }, String(p.age)),
      h('td', { class: 'num' }, String(p.overall)),
      h('td', { class: 'num' }, room > 0 ? h('span', { class: 'a', style: 'color:var(--accent)' }, `${p.potential} (+${room})`) : String(p.potential ?? '—')),
      h('td', {}, promote)));
  }

  mount(header(), h('div', { class: 'wrap grid' },
    h('div', { class: 'between' },
      h('div', {}, h('h2', {}, 'Youth academy'),
        h('div', { class: 'muted' }, 'Raw prospects who develop here each season — promote the ones you rate into the senior squad. Unpromoted prospects move on once they turn 21.')),
      h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, '← Back'),
    ),
    prospects.length
      ? h('div', { class: 'card' }, h('div', { style: 'max-height:540px;overflow:auto' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Prospect'), h('th', {}, 'Pos'), h('th', { class: 'num' }, 'Age'), h('th', { class: 'num' }, 'OVR'), h('th', { class: 'num' }, 'Potential'), h('th', {}, ''))),
          body)))
      : h('div', { class: 'card muted', style: 'font-size:13px' }, 'No prospects right now — your next youth intake arrives at the end of the season.'),
  ));
}

// ── news archive (§2.14): the full club-news feed, grouped by season ──
async function screenNews() {
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading the archive…')));
  let news: NewsItemT[];
  try { news = (await api.news(200)).news; }
  catch (e: any) { if (String(e.message).includes('no team')) return screenCreateTeam(); return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message))); }
  const NEWS_ICON: Record<NewsItemT['type'], string> = { hat_trick: '⚽⚽⚽', brace: '⚽⚽', red_card: '🟥', star: '⭐', long_injury: '🤕', pots: '🏆', young_pots: '🌟' };

  const groups: { season: number; items: NewsItemT[] }[] = [];
  for (const n of news) { const g = groups[groups.length - 1]; if (g && g.season === n.season) g.items.push(n); else groups.push({ season: n.season, items: [n] }); }

  mount(header(), h('div', { class: 'wrap grid' },
    h('div', { class: 'between' },
      h('div', {}, h('h2', {}, 'News archive'), h('div', { class: 'muted' }, `${news.length} headline(s) across your tenure`)),
      h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, '← Back'),
    ),
    news.length
      ? h('div', { class: 'grid' }, ...groups.map(g => h('div', { class: 'card' },
          h('div', { class: 'section-title', style: 'margin-top:0' }, `Season ${g.season}`),
          ...g.items.map(n => h('div', { class: 'between', style: 'font-size:13px;padding:3px 0' },
            h('span', {}, `${NEWS_ICON[n.type] ?? '•'} ${n.headline}`))))))
      : h('div', { class: 'card muted', style: 'font-size:13px' }, 'No headlines yet — play on and your players will make news.'),
  ));
}

// ── player profile (personality + the story↔traits coupling) ──
const TRAIT_LABELS: { key: string; label: string }[] = [
  { key: 'professionalism', label: 'Professionalism' }, { key: 'consistency', label: 'Consistency' },
  { key: 'bigGame', label: 'Big-game' }, { key: 'leadership', label: 'Leadership' },
  { key: 'temperament', label: 'Temperament (fiery)' }, { key: 'ego', label: 'Ego' },
  { key: 'criticismResponse', label: 'Responds to criticism' }, { key: 'praiseResponse', label: 'Responds to praise' },
];
function traitBar(label: string, v: number, color = 'var(--accent,#4ea1ff)'): HTMLElement {
  return h('div', { style: 'margin-bottom:7px' },
    h('div', { class: 'between', style: 'font-size:12px;margin-bottom:2px' }, h('span', { class: 'muted' }, label), h('span', {}, String(v))),
    h('div', { style: 'height:6px;background:var(--panel2,#161f30);border-radius:3px;overflow:hidden' },
      h('div', { style: `height:100%;width:${Math.max(0, Math.min(100, v))}%;background:${color}` })));
}
// Attribute bars are colour-tiered (strong / solid / weak) so a profile reads at a glance, like the squad table.
const ATTR_LABELS: { key: keyof PlayerT['attrs']; label: string }[] = [
  { key: 'speed', label: 'Speed' }, { key: 'passing', label: 'Passing' }, { key: 'shooting', label: 'Shooting' },
  { key: 'creativity', label: 'Creativity' }, { key: 'tackling', label: 'Tackling' }, { key: 'positioning', label: 'Positioning' }, { key: 'stamina', label: 'Stamina' },
];
const attrTierColor = (v: number): string => v >= 75 ? 'var(--accent,#43d39e)' : v >= 50 ? 'var(--gold,#ffe97a)' : 'var(--danger,#ff6b6b)';
async function screenPlayer(slot: number) {
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading…')));
  let team: TeamT;
  try { team = await api.team(); }
  catch (e: any) { if (String(e.message).includes('no team')) return screenCreateTeam(); return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message))); }
  const p = team.players.find(x => x.slot === slot);
  if (!p) { location.hash = '#/'; return; }
  const ovr = skillOvr(p.attrs);

  // §2.2 contract negotiation: this player's live renewal talks (pending / countered), best-effort.
  let myOffer: ContractOfferT | null = null;
  try { myOffer = (await api.contractOffers()).offers.find(o => o.playerSlot === slot && (o.status === 'pending' || o.status === 'countered')) ?? null; }
  catch { /* no offers / pre-feature save */ }
  const openTalks = async () => {
    let suggested = p.wage ?? 0;
    try { const pv = await api.renewPreview(slot); suggested = pv.newWage; } catch { /* fall back to current wage */ }
    const raw = await promptModal('Open contract talks',
      `Offer ${p.name} a new annual wage (3-year deal). His fair wage is about ${fmtMoney(suggested)} — go higher to land him, lower and he'll likely counter. He replies at the next matchday.`,
      String(suggested), 'Send offer');
    if (raw == null) return;
    const wage = Math.round(Number(String(raw).replace(/[^0-9.]/g, '')));   // tolerate "£50,000" etc.
    if (!Number.isFinite(wage) || wage <= 0) { toast('Enter a positive wage'); return; }
    try { await api.renewOffer(slot, wage, 3); toast('Offer sent — he responds at the next matchday.'); screenPlayer(slot); }
    catch (e: any) { toast(e.message); }
  };
  const contractControl = (() => {
    if (myOffer && myOffer.status === 'pending') {
      const wd = h('button', { class: 'ghost small' }, 'Withdraw');
      wd.addEventListener('click', async () => { wd.setAttribute('disabled', 'true'); try { await api.withdrawContractOffer(myOffer!.id); toast('Offer withdrawn'); screenPlayer(slot); } catch (e: any) { toast(e.message); wd.removeAttribute('disabled'); } });
      return h('span', { class: 'row', style: 'gap:6px;align-items:center' },
        h('span', { class: 'pill', title: 'Awaiting his reply at the next matchday', style: 'background:#262d3a' }, `⏳ offered ${fmtMoney(myOffer.wage)}/yr × ${myOffer.years}y`), wd);
    }
    if (myOffer && myOffer.status === 'countered') {
      const cw = myOffer.counterWage ?? myOffer.wage, cy = myOffer.counterYears ?? myOffer.years;
      const m = h('button', { class: 'primary small' }, `Accept ${fmtMoney(cw)}/yr`);
      m.addEventListener('click', async () => { m.setAttribute('disabled', 'true'); try { const r = await api.matchContractOffer(myOffer!.id); toast(`${r.player ?? p.name} re-signed — ${fmtMoney(r.wage!)}/yr × ${r.years}y`); screenPlayer(slot); } catch (e: any) { toast(e.message); m.removeAttribute('disabled'); } });
      const wd = h('button', { class: 'ghost small', style: 'margin-left:4px' }, 'Walk away');
      wd.addEventListener('click', async () => { wd.setAttribute('disabled', 'true'); try { await api.withdrawContractOffer(myOffer!.id); toast('Talks ended'); screenPlayer(slot); } catch (e: any) { toast(e.message); wd.removeAttribute('disabled'); } });
      return h('span', { class: 'row', style: 'gap:6px;align-items:center' },
        h('span', { class: 'pill', title: 'His agent countered', style: 'background:#3a2a1f;color:#ffce9a' }, `↩ wants ${fmtMoney(cw)}/yr × ${cy}y`), m, wd);
    }
    const open = h('button', { class: 'ghost small' }, 'Open contract talks');
    // guard the async preview→prompt flow so a double-click can't stack wage-entry modals
    open.addEventListener('click', async () => { if (open.hasAttribute('disabled')) return; open.setAttribute('disabled', 'true'); try { await openTalks(); } finally { open.removeAttribute('disabled'); } });
    return open;
  })();

  const traitsEl = h('div', {});
  const renderTraits = (tr: Record<string, number>) => traitsEl.replaceChildren(...TRAIT_LABELS.map(t => traitBar(t.label, tr?.[t.key] ?? 50)));
  // Don't fabricate eight 50-bars for a player with no personality — that reads as real data.
  // The backstory editor below still works (saving derives the personality), so point there.
  if (p.personality?.traits) renderTraits(p.personality.traits as any);
  else traitsEl.replaceChildren(h('div', { class: 'muted', style: 'font-size:13px;line-height:1.5' },
    'No personality yet — write a backstory below and save to derive these dials, or generate the whole squad’s personalities from the squad screen.'));

  const back = h('textarea', { class: 'tactics-input', rows: '4', placeholder: 'Backstory — e.g. "A model professional and ice-cool penalty taker who rises on the big occasion."' }, p.personality?.backstory ?? '') as HTMLTextAreaElement;
  const tag = h('input', { placeholder: 'Tagline (≤6 words, in character)', value: p.personality?.tagline ?? '' }) as HTMLInputElement;
  const valEl = h('span', { class: 'muted', style: 'font-size:12px' });
  const save = h('button', {}, 'Save story & re-derive traits');
  save.addEventListener('click', async () => {
    if (!back.value.trim()) { toast('Write a backstory first'); return; }
    save.setAttribute('disabled', 'true'); save.textContent = 'Re-deriving…';
    try {
      const r = await api.setPlayerStory(slot, back.value.trim(), tag.value.trim());
      renderTraits(r.personality.traits as any);
      valEl.textContent = `Re-derived · value ${fmtMoney(r.value)}`;
      toast('Traits re-derived from the new story');
    } catch (e: any) { toast(e.message); }
    finally { save.removeAttribute('disabled'); save.textContent = 'Save story & re-derive traits'; }
  });

  mount(header(), h('div', { class: 'wrap grid' },
    h('div', { class: 'between' },
      h('div', {}, h('h2', {}, p.name),
        h('div', { class: 'muted' }, `${p.role} · OVR ${ovr}${p.potential && p.potential > ovr ? ` → ${p.potential}` : ''}${p.age != null ? ` · ${p.age}y` : ''}${p.personality?.nationality ? ` · ${p.personality.nationality}` : ''}`),
        p.wage != null ? h('div', { class: 'row', style: 'align-items:center;gap:10px;font-size:12px' },
          h('span', { class: 'muted' }, `Wage ${fmtMoney(p.wage)}/yr · ${p.contractYears ?? 0}y left`),
          (team.wageBudget != null && team.wageBill != null)   // §1.15: club wage headroom, so a renewal isn't a blind 400
            ? h('span', { class: 'muted', style: team.wageBudget - team.wageBill < 0 ? 'color:var(--danger)' : '' }, `· club headroom ${fmtMoney(team.wageBudget - team.wageBill)}/yr`) : '',
          contractControl) : '',
        (p.injuredMatches ?? 0) > 0
          ? h('div', { style: 'font-size:12px;color:#e8896b' }, `🤕 Injured — out ${p.injuredMatches} match${(p.injuredMatches ?? 0) > 1 ? 'es' : ''}${p.morale != null ? ` · Morale ${p.morale}` : ''}`)
          : h('div', { class: 'muted', style: 'font-size:12px' }, `Match fitness ${p.fitness ?? 100}%${p.morale != null ? ` · Morale ${p.morale}` : ''}`)),
      h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, '← Back'),
    ),
    h('div', { class: 'card' },
      h('div', { class: 'section-title', style: 'margin-top:0' }, 'Attributes'),
      h('div', { class: 'grid cols-2', style: 'gap:0 22px' },
        ...ATTR_LABELS.map(a => traitBar(a.label, p.attrs[a.key] ?? 0, attrTierColor(p.attrs[a.key] ?? 0)))),
    ),
    h('div', { class: 'grid cols-2', style: 'align-items:start' },
      h('div', { class: 'card' }, h('div', { class: 'section-title', style: 'margin-top:0' }, 'Personality dials'), traitsEl),
      h('div', { class: 'card' },
        h('div', { class: 'section-title', style: 'margin-top:0' }, 'Backstory'),
        h('div', { class: 'muted', style: 'font-size:12px;margin-bottom:8px' }, 'These dials are read off the backstory — and the player’s training rate and transfer value read the dials. Rewrite the story and the numbers re-derive.'),
        h('div', { class: 'field' }, h('label', {}, 'Backstory'), back),
        h('div', { class: 'field' }, h('label', {}, 'Tagline'), tag),
        h('div', { class: 'row', style: 'align-items:center;gap:10px' }, save, valEl),
      ),
    ),
  ));
}

// ── cup (knockout bracket) ──
async function screenCup() {
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading…')));
  let cup: CupT;
  try { cup = await api.cup(); }
  catch (e: any) { if (String(e.message).includes('no team')) return screenCreateTeam(); return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message))); }
  if (!cup.rounds.length) return mount(header(), h('div', { class: 'wrap grid' },
    h('div', { class: 'between' }, h('h2', {}, 'Cup'), h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, '← Back')),
    h('div', { class: 'card muted' }, 'No cup this season.')));

  const teamRow = (name: string | null, score: number | null, won: boolean, isMe: boolean) =>
    h('div', { class: 'between', style: `font-size:12px;gap:10px;${won ? 'font-weight:700;' : 'opacity:.7;'}${isMe ? 'color:var(--accent,#4ea1ff);' : ''}` },
      h('span', {}, name ?? 'TBD'), h('span', {}, score != null ? String(score) : ''));
  const cols = cup.rounds.map(rd => h('div', { style: 'min-width:170px' },
    h('div', { class: 'section-title', style: 'margin-top:0' }, rd.name),
    ...rd.ties.map(t => h('div', { class: 'card', style: 'padding:8px;margin-bottom:8px' },
      teamRow(t.home, t.homeScore, t.winnerTeamId != null && t.winnerTeamId === t.homeTeamId, t.homeTeamId === cup.myTeamId),
      teamRow(t.away, t.awayScore, t.winnerTeamId != null && t.winnerTeamId === t.awayTeamId, t.awayTeamId === cup.myTeamId)))));

  mount(header(), h('div', { class: 'wrap grid' },
    h('div', { class: 'between' },
      h('div', {}, h('h2', {}, 'Cup'),
        h('div', { class: 'muted' }, cup.champion ? `🏆 Winners: ${cup.champion}` : 'Single elimination — win it or go home. Ties play out across the season.')),
      h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, '← Back')),
    h('div', { class: 'card' }, h('div', { style: 'display:flex;gap:14px;overflow:auto;align-items:flex-start' }, ...cols)),
  ));
}

// ── router ──
// ── post-match report + player ratings (generated from the recording) ──
// The persisted shout log for a watched match — minute · what you said · what it changed.
// Independent of the frame recording (a shout-driven match may have no replay), so it can ride
// either the full report or the "no recording" fallback. '' when there were no shouts.
function shoutReviewCard(tac: TacticsReviewT): HTMLElement | string {
  if (!tac.shouts.length) return '';
  const changed = (s: ShoutReviewT): string => {
    const bits = [`${s.directives} instruction${s.directives === 1 ? '' : 's'}`];
    if (s.formationChange) bits.push('formation change');
    if (s.morale) bits.push(`${s.morale} player${s.morale === 1 ? '' : 's'} rallied`);
    return bits.join(' · ');
  };
  return h('div', { class: 'card', style: 'margin-top:10px' },
    h('div', { class: 'section-title', style: 'margin-top:0' }, '📣 Your shouts this match'),
    ...tac.shouts.map(s => h('div', { style: 'padding:5px 0;border-top:1px solid var(--line)' },
      h('div', { style: 'font-size:13px' }, h('span', { class: 'muted', style: 'font-variant-numeric:tabular-nums' }, `${s.minute}' `), `“${s.text}”`),
      h('div', { class: 'muted', style: 'font-size:11px;margin-top:2px' }, changed(s)))));
}

async function screenReport(fixtureId: number) {
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Reading the match…')));
  // The shout review is independent of the frame recording — fetch it alongside, and show it even
  // when the match wasn't recorded (a shout-driven watch leaves a tactics log but maybe no replay).
  const tacP = api.tactics(fixtureId).catch((): TacticsReviewT => ({ shouts: [] }));
  let rep: ReportT;
  try { rep = await api.report(fixtureId); }
  catch (e: any) {
    const tac = await tacP;
    const msg = String(e.message).includes('no recording')
      ? "No report yet — this match wasn't recorded (play or watch it first)."
      : e.message;
    return mount(header(), h('div', { class: 'wrap grid' },
      h('div', { class: 'between' }, h('h2', {}, 'Match report'), h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, '← Back')),
      h('div', { class: 'card muted' }, msg),
      shoutReviewCard(tac)));
  }
  const tac = await tacP;

  const icon = (t: string) => t === 'goal' ? '⚽' : t === 'red' ? '🟥' : '🟨';
  const timeline = rep.facts.timeline.length
    ? h('div', { class: 'card', style: 'margin-top:10px' },
        h('div', { class: 'section-title', style: 'margin-top:0' }, 'Timeline'),
        ...rep.facts.timeline.map(e => h('div', { class: 'between', style: 'font-size:13px;padding:2px 0' },
          h('span', {}, `${icon(e.type)} ${e.name}`),
          h('span', { class: 'muted' }, `${e.minute}'${e.team === 'home' ? ` · ${rep.homeName}` : ` · ${rep.awayName}`}`))))
    : '';

  // ratings, one column per side, best first
  const ratingsCol = (team: 'home' | 'away', label: string) => h('div', { style: 'flex:1;min-width:200px' },
    h('div', { class: 'section-title', style: 'margin-top:0' }, label),
    ...rep.ratings.filter(r => r.team === team).sort((a, b) => b.rating - a.rating).map(r => {
      const tag = (n: number, s: string) => n > 0 ? h('span', { class: 'pill', style: 'margin-left:4px' }, `${n}${s}`) : '';
      const hot = r.rating >= 7.5 ? 'color:var(--accent,#4ea1ff);font-weight:700;' : r.rating < 5 ? 'opacity:.6;' : '';
      return h('div', { class: 'between', style: 'font-size:13px;padding:2px 0' },
        h('span', {}, `${r.name} `, h('span', { class: 'muted', style: 'font-size:11px' }, r.role), tag(r.goals, '⚽'), tag(r.assists, '🅰')),
        h('span', { style: hot }, r.rating.toFixed(1)));
    }));

  const f = rep.facts;
  mount(header(), h('div', { class: 'wrap grid' },
    h('div', { class: 'between' }, h('h2', {}, rep.headline), h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, '← Back')),
    h('div', { class: 'card' },
      h('div', { style: 'white-space:pre-wrap;line-height:1.5' }, rep.body),
      h('div', { class: 'muted', style: 'margin-top:10px;font-size:12px' },
        `Possession ${f.possessionHome}%–${100 - f.possessionHome}% · Shots ${f.shots.home}–${f.shots.away} (${f.shotsOnTarget} on target) · ${f.saves} saves · ${f.corners} corners`)),
    timeline,
    h('div', { class: 'card', style: 'margin-top:10px' },
      h('div', { class: 'section-title', style: 'margin-top:0' }, 'Player ratings'),
      h('div', { style: 'display:flex;gap:24px;flex-wrap:wrap' }, ratingsCol('home', rep.homeName), ratingsCol('away', rep.awayName))),
    shoutReviewCard(tac),
  ));
}

// ── club finances ──
const FIN_LABEL: Record<string, string> = {
  prize: 'Prize money', transfer_in: 'Transfers in', transfer_out: 'Transfers out',
  staff: 'Staff fees', sponsor: 'Sponsorship', gate: 'Gate & TV', other: 'Other',
};
async function screenFinances() {
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading…')));
  let f: FinancesT;
  try { f = await api.finances(); }
  catch (e: any) {
    if (String(e.message).includes('no team')) return screenCreateTeam();
    return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message)));
  }
  const net = f.income + f.expense;   // expense is already negative
  const col = (n: number) => n >= 0 ? 'color:var(--accent)' : 'color:var(--danger)';
  const signed = (n: number) => (n >= 0 ? '+' : '−') + fmtMoney(Math.abs(n));
  const cell = (label: string, val: string, style = '') => h('div', { style: 'min-width:120px' },
    h('div', { class: 'muted', style: 'font-size:11px' }, label),
    h('div', { style: 'font-size:20px;font-weight:800;' + style }, val));

  const byKind = f.byKind.length
    ? f.byKind.map(k => h('div', { class: 'between', style: 'font-size:13px;padding:3px 0' },
        h('span', {}, FIN_LABEL[k.kind] ?? k.kind),
        h('span', { style: col(k.amount) }, signed(k.amount))))
    : [h('div', { class: 'muted', style: 'font-size:13px' }, 'No money has moved yet this season.')];

  const recent = f.recent.length
    ? f.recent.map(e => h('div', { class: 'between', style: 'font-size:13px;padding:3px 0' },
        h('span', {}, e.note, h('span', { class: 'muted', style: 'font-size:11px' }, ` · S${e.season}`)),
        h('span', { style: col(e.amount) }, signed(e.amount))))
    : [h('div', { class: 'muted', style: 'font-size:13px' }, 'No transactions recorded yet — play on, sign players, win prize money.')];

  mount(header(), h('div', { class: 'wrap grid' },
    h('div', { class: 'between' },
      h('div', {}, h('h2', {}, 'Finances'), h('div', { class: 'muted' }, `Season ${f.season}`)),
      h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, '← Back')),
    h('div', { class: 'card' },
      h('div', { class: 'row', style: 'gap:32px;flex-wrap:wrap' },
        cell('Balance', fmtMoney(f.balance)),
        cell('Income (season)', signed(f.income), col(f.income)),
        cell('Expense (season)', signed(f.expense), col(f.expense)),
        cell('Net (season)', signed(net), col(net)),
        cell('Wage bill', `${fmtMoney(f.wageBill)}/yr`, f.wageBill > f.wageBudget ? 'color:var(--danger)' : ''))),
    // wage bill vs budget bar
    (() => {
      const pct = f.wageBudget > 0 ? Math.min(100, Math.round((f.wageBill / f.wageBudget) * 100)) : 0;
      const over = f.wageBill > f.wageBudget;
      return h('div', { class: 'card', style: 'padding:10px 14px' },
        h('div', { class: 'between', style: 'font-size:12px;margin-bottom:4px' },
          h('span', { class: 'muted' }, 'Wage bill vs budget'),
          h('span', { style: over ? 'color:var(--danger);font-weight:600' : '' }, `${fmtMoney(f.wageBill)} / ${fmtMoney(f.wageBudget)} (${pct}%)`)),
        h('div', { style: 'height:7px;background:var(--panel2,#161f30);border-radius:4px;overflow:hidden' },
          h('div', { style: `height:100%;width:${pct}%;background:${over ? 'var(--danger)' : 'var(--accent)'}` })));
    })(),
    h('div', { class: 'grid cols-2', style: 'align-items:start' },
      h('div', { class: 'card' },
        h('div', { class: 'section-title', style: 'margin-top:0' }, 'This season by category'),
        ...byKind),
      h('div', { class: 'card' },
        h('div', { class: 'section-title', style: 'margin-top:0' }, 'Recent movements'),
        h('div', { style: 'max-height:360px;overflow:auto' }, ...recent))),
    // season-over-season net (income/expense/net per season)
    f.history.length ? h('div', { class: 'card' },
      h('div', { class: 'section-title', style: 'margin-top:0' }, 'Season by season'),
      h('table', {}, h('thead', {}, h('tr', {},
        h('th', { class: 'num' }, 'Season'), h('th', { class: 'num' }, 'Income'), h('th', { class: 'num' }, 'Expense'), h('th', { class: 'num' }, 'Net'))),
        h('tbody', {}, ...f.history.map(s => h('tr', {},
          h('td', { class: 'num' }, `S${s.season}`),
          h('td', { class: 'num', style: 'color:var(--accent)' }, signed(s.income)),
          h('td', { class: 'num', style: 'color:var(--danger)' }, signed(s.expense)),
          h('td', { class: 'num', style: 'font-weight:700;' + col(s.net) }, signed(s.net))))))) : '',
  ));
}

// ── backroom staff ──
const ROLE_ICON: Record<string, string> = { coach: '🎓', physio: '🩺', scout: '🔍' };
const ROLE_LABEL: Record<string, string> = { coach: 'Coach', physio: 'Physio', scout: 'Scout' };
async function screenStaff() {
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading…')));
  let v: StaffViewT;
  try { v = await api.staff(); }
  catch (e: any) {
    if (String(e.message).includes('no team')) return screenCreateTeam();
    return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message)));
  }
  const guard = (btn: HTMLElement, fn: () => Promise<void>) => async () => {
    if (btn.hasAttribute('disabled')) return;
    btn.setAttribute('disabled', 'true');
    try { await fn(); } finally { btn.removeAttribute('disabled'); }
  };
  function render() {
    const e = v.effects;
    const stat = (icon: string, val: string, label: string) => h('div', { style: 'text-align:center;min-width:88px' },
      h('div', { style: 'font-size:22px' }, icon),
      h('div', { style: 'font-size:18px;font-weight:800' }, val),
      h('div', { class: 'muted', style: 'font-size:11px' }, label));

    const mineBody = h('tbody');
    if (!v.staff.length) mineBody.append(h('tr', {}, h('td', { colspan: '4', class: 'muted' }, 'No staff yet — hire from the pool.')));
    for (const s of v.staff) {
      const fire = h('button', { class: 'ghost small' }, 'Release');
      fire.addEventListener('click', guard(fire, async () => {
        if (!await confirmModal('Release staff', `Release ${s.name}? This is permanent — re-hiring later costs the full fee.`, 'Release')) return;
        try { v = await api.fireStaff(s.id); toast(`Released ${s.name}`); render(); } catch (er: any) { toast(er.message); }
      }));
      mineBody.append(h('tr', {},
        h('td', {}, `${ROLE_ICON[s.role] ?? ''} ${s.name}`),
        h('td', {}, h('span', { class: 'pill' }, ROLE_LABEL[s.role] ?? s.role)),
        h('td', { class: 'num' }, String(s.rating)),
        h('td', { class: 'num' }, fire)));
    }

    const poolBody = h('tbody');
    if (!v.pool.length) poolBody.append(h('tr', {}, h('td', { colspan: '5', class: 'muted' }, 'No candidates available.')));
    for (const s of v.pool) {
      const afford = v.budget >= s.cost, room = v.staff.length < v.max;
      const hire = h('button', { class: 'ghost small' }, 'Hire');
      if (!afford || !room) { hire.setAttribute('disabled', 'true'); hire.setAttribute('title', !room ? `Max ${v.max} staff` : 'Not enough budget'); }
      else hire.addEventListener('click', guard(hire, async () => {
        try { const r = await api.hireStaff(s.id); v = r; toast(`Hired ${r.name ?? s.name}`); render(); } catch (er: any) { toast(er.message); }
      }));
      poolBody.append(h('tr', {},
        h('td', {}, `${ROLE_ICON[s.role] ?? ''} ${s.name}`),
        h('td', {}, h('span', { class: 'pill' }, ROLE_LABEL[s.role] ?? s.role)),
        h('td', { class: 'num' }, String(s.rating)),
        h('td', { class: 'num' }, fmtMoney(s.cost)),
        h('td', { class: 'num' }, hire)));
    }

    mount(header(), h('div', { class: 'wrap grid' },
      h('div', { class: 'between' },
        h('div', {}, h('h2', {}, 'Backroom staff'),
          h('div', { class: 'muted' }, `Budget ${fmtMoney(v.budget)} · ${v.staff.length}/${v.max} employed`)),
        h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, '← Back')),
      h('div', { class: 'card' },
        h('div', { class: 'section-title', style: 'margin-top:0' }, 'Backroom effect'),
        h('div', { class: 'row', style: 'gap:22px;flex-wrap:wrap' },
          stat('🎓', `+${e.training}%`, 'Faster training'),
          stat('🩺', `−${e.injuryReduction}%`, 'Injury risk'),
          stat('💪', `+${e.recoverBonus}`, 'Match recovery'),
          stat('🔍', `+${e.scoutDepth}`, 'Scouted players'))),
      h('div', { class: 'grid cols-2', style: 'align-items:start' },
        h('div', { class: 'card' },
          h('div', { class: 'section-title', style: 'margin-top:0' }, 'Your staff'),
          h('div', { style: 'max-height:430px;overflow:auto' }, h('table', {},
            h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Role'), h('th', { class: 'num' }, 'Rating'), h('th', { class: 'num' }, ''))), mineBody))),
        h('div', { class: 'card' },
          h('div', { class: 'section-title', style: 'margin-top:0' }, 'Hire pool'),
          h('div', { style: 'max-height:430px;overflow:auto' }, h('table', {},
            h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Role'), h('th', { class: 'num' }, 'Rating'), h('th', { class: 'num' }, 'Fee'), h('th', { class: 'num' }, ''))), poolBody))),
      ),
    ));
  }
  render();
}

// ── pre-match opponent scouting report ──
function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}
async function screenScout(fixtureId: number) {
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Scouting the opposition…')));
  let s: ScoutT;
  try { s = await api.scout(fixtureId); }
  catch (e: any) {
    if (String(e.message).includes('no team')) return screenCreateTeam();
    return mount(header(), h('div', { class: 'wrap' },
      h('div', { class: 'err' }, e.message),
      h('button', { class: 'ghost', style: 'margin-top:12px', onclick: () => (location.hash = '#/') }, '← Back')));
  }
  const o = s.opponent;

  const formRow = h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' });
  if (!s.form.length) formRow.append(h('span', { class: 'muted', style: 'font-size:13px' }, 'No games played yet this season.'));
  else for (const f of s.form) formRow.append(h('span', {
    class: 'form-badge ' + (f.result === 'W' ? 'w' : f.result === 'L' ? 'l' : 'd'),
    title: `R${f.round} · ${f.venue === 'H' ? 'home' : 'away'} ${f.gf}–${f.ga} vs ${f.opponent}`,
  }, f.result));

  const ATTR_ABBR: Record<string, string> = { speed: 'SPD', passing: 'PAS', creativity: 'CRE', shooting: 'SHO', tackling: 'TAC', positioning: 'POS', stamina: 'STA' };
  const playerRow = (p: ScoutPlayerT) => h('div', { style: 'padding:4px 0;border-bottom:1px solid var(--line)' },
    h('div', { class: 'between', style: 'font-size:13px' },
      h('span', {}, p.danger ? h('span', { title: 'danger man', style: 'margin-right:5px' }, '⚠️') : '',
        p.name, h('span', { class: 'muted', style: 'font-size:11px' }, ` ${p.role} · ${p.age}y`)),
      h('span', { style: p.danger ? 'font-weight:700;color:var(--gold)' : '' },
        `OVR ${p.overall}${p.potential && p.potential > p.overall ? ` → ${p.potential}` : ''}`)),
    // scouted attribute fog — ranges that tighten with scout quality (exact at full depth)
    p.attrs ? h('div', { class: 'muted', style: 'font-size:11px;margin-top:2px' },
      p.attrs.map(a => `${ATTR_ABBR[a.key] ?? a.key} ${a.lo === a.hi ? a.lo : `${a.lo}–${a.hi}`}`).join(' · ')) : '');
  const players = s.keyPlayers.length ? s.keyPlayers.map(playerRow) : [h('div', { class: 'muted', style: 'font-size:13px' }, 'Squad not available.')];
  const scoutHint = s.keyPlayers.length && !s.keyPlayers[0].attrs
    ? h('div', { class: 'muted', style: 'margin:-4px 0 8px;font-size:11px' }, 'Hire scouts (Staff) to reveal their players’ attributes + scout deeper into the squad.')
    : '';
  // §2.8 bench tier — the squad behind the XI, a fuzzier read; only present once you have some intel.
  const benchCard = s.bench.length
    ? h('div', { class: 'card' },
        h('div', { class: 'section-title', style: 'margin-top:0' }, 'Rest of the squad'),
        h('div', { class: 'muted', style: 'margin:-4px 0 8px;font-size:12px' }, 'Bench & squad players — a fuzzier read than the likely XI; it sharpens with better scouts and as the fixture nears.'),
        ...s.bench.map(playerRow))
    : '';

  mount(header(), h('div', { class: 'wrap grid' },
    h('div', { class: 'between' },
      h('div', {}, h('h2', {}, `Scouting — ${o.name}`),
        h('div', { class: 'muted' },
          `${o.manager} · ${o.formation} · ${o.position != null ? ordinal(o.position) + ' in the table' : 'unranked'} · you play ${s.venue === 'home' ? 'at home' : 'away'} (R${s.round}) · ${s.roundsAway === 0 ? 'your next match' : `${s.roundsAway} matchday${s.roundsAway > 1 ? 's' : ''} away`}`)),
      h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, '← Back')),
    h('div', { class: 'grid cols-2', style: 'align-items:start' },
      h('div', { class: 'card' },
        h('div', { class: 'section-title', style: 'margin-top:0' }, 'Form & record'),
        h('div', { class: 'muted', style: 'margin-bottom:10px;font-size:13px' },
          `P${o.played}  ·  W${o.won} D${o.drawn} L${o.lost}  ·  ${o.gf}:${o.ga} (${o.gd >= 0 ? '+' : ''}${o.gd})  ·  ${o.points} pts`),
        formRow,
        h('div', { class: 'section-title' }, 'How they play'),
        h('ul', { style: 'margin:0;padding-left:18px;line-height:1.7' }, ...s.approach.map(a => h('li', {}, a)))),
      h('div', { class: 'grid', style: 'gap:14px;align-items:start' },
        h('div', { class: 'card' },
          h('div', { class: 'section-title', style: 'margin-top:0' }, 'Danger men'),
          h('div', { class: 'muted', style: 'margin:-4px 0 8px;font-size:12px' }, 'Their highest-rated players in the likely XI.'),
          scoutHint,
          ...players),
        benchCard)),
  ));
}

// ── club history / honours archive ──
const OBJ_LABEL: Record<string, string> = {
  title: 'Win the league', promotion: 'Win promotion', top_half: 'Finish in the top half', survival: 'Avoid relegation',
};
const CONF_LABEL: Record<string, string> = {
  secure: 'Secure', stable: 'Stable', shaky: 'Under pressure', at_risk: 'At risk',
};
const BOARD_TONE_LABEL: Record<string, string> = {
  backed: 'Backed', satisfied: 'Satisfied', concerned: 'Concerned', warned: 'Warned', final_warning: 'Final warning',
};
const BOARD_TONE_ICON: Record<string, string> = {
  backed: '🟢', satisfied: '🙂', concerned: '🟡', warned: '🟠', final_warning: '🔴',
};
const BOARD_TONE_STYLE: Record<string, string> = {
  warned: 'background:#3a2a1f;color:#ffce9a', final_warning: 'background:#3a1f24;color:#ff9a9a',
};
function trophy(icon: string, n: number, label: string): HTMLElement {
  return h('div', { style: 'text-align:center;min-width:74px' },
    h('div', { style: 'font-size:26px' }, icon),
    h('div', { style: 'font-size:22px;font-weight:800' }, String(n)),
    h('div', { class: 'muted', style: 'font-size:11px' }, label));
}
async function screenHistory() {
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading history…')));
  let hist: SeasonHistoryT[]; let records: import('./api').ClubRecordsT | null = null;
  try { const r = await api.history(); hist = r.history; records = r.records; }
  catch (e: any) {
    if (String(e.message).includes('no team')) return screenCreateTeam();
    return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message)));
  }

  const titles = hist.filter(s => s.champion).length;
  const cups = hist.filter(s => s.cupWon).length;
  const promotions = hist.filter(s => s.promoted).length;
  const cabinet = h('div', { class: 'row', style: 'gap:18px;flex-wrap:wrap' },
    trophy('🏆', titles, titles === 1 ? 'League title' : 'League titles'),
    trophy('🥇', cups, cups === 1 ? 'Cup' : 'Cups'),
    trophy('⬆️', promotions, promotions === 1 ? 'Promotion' : 'Promotions'),
    trophy('📅', hist.length, hist.length === 1 ? 'Season' : 'Seasons'));

  const body = h('tbody');
  if (!hist.length) body.append(h('tr', {}, h('td', { colspan: '7', class: 'muted' }, 'No completed seasons yet — play through a season and your history starts here.')));
  for (const s of hist) {
    const honours = h('span', { style: 'display:inline-flex;gap:5px;flex-wrap:wrap;align-items:center' });
    if (s.champion) honours.append(h('span', { class: 'pill', title: 'Division champions', style: 'background:var(--gold);color:#1a1205' }, '🏆 Champions'));
    if (s.promoted) honours.append(h('span', { class: 'pill', title: 'Promoted' }, '⬆️ Promoted'));
    if (s.relegated) honours.append(h('span', { class: 'pill', title: 'Relegated', style: 'background:#3a1f24;color:#ff9a9a' }, '⬇️ Relegated'));
    if (s.cupWon) honours.append(h('span', { class: 'pill', title: 'Cup winners', style: 'background:var(--gold);color:#1a1205' }, '🥇 Cup'));
    if (s.objective) honours.append(h('span', { class: 'pill', title: `Board objective: ${OBJ_LABEL[s.objective.kind] ?? 'season target'}`, style: s.objective.met ? '' : 'background:#3a1f24;color:#ff9a9a' }, (s.objective.met ? '✅' : '❌') + ' Target'));
    if (s.board) honours.append(h('span', { class: 'pill', title: s.board.message, style: BOARD_TONE_STYLE[s.board.tone] ?? '' }, `${BOARD_TONE_ICON[s.board.tone] ?? '📋'} ${BOARD_TONE_LABEL[s.board.tone] ?? 'Board'}`));
    if (s.pots) honours.append(h('span', { class: 'muted', style: 'font-size:11px' }, `POTS: ${s.pots}`));
    body.append(h('tr', {},
      h('td', { class: 'num' }, String(s.season)),
      h('td', {}, `T${s.tier} · ${s.division}`),
      h('td', { class: 'num', style: s.position === 1 ? 'font-weight:700;color:var(--gold)' : '' }, ordinal(s.position)),
      h('td', { class: 'num' }, `${s.won}-${s.drawn}-${s.lost}`),
      h('td', { class: 'num' }, `${s.gf}:${s.ga}`),
      h('td', { class: 'num', style: 'font-weight:700' }, String(s.points)),
      h('td', {}, honours)));
  }

  mount(header(), h('div', { class: 'wrap grid' },
    h('div', { class: 'between' },
      h('div', {}, h('h2', {}, 'Club history'),
        h('div', { class: 'muted' }, 'Every completed season and the honours that came with it.')),
      h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, '← Back')),
    h('div', { class: 'card' }, h('div', { class: 'section-title', style: 'margin-top:0' }, 'Trophy cabinet'), cabinet),
    records && records.seasons > 0 ? h('div', { class: 'card' },
      h('div', { class: 'section-title', style: 'margin-top:0' }, 'All-time records'),
      h('div', { class: 'row', style: 'gap:26px;flex-wrap:wrap;font-size:13px' },
        ...[
          records.bestFinish ? ['Best finish', `${ordinal(records.bestFinish.position)} · Tier ${records.bestFinish.tier} (S${records.bestFinish.season})`] : null,
          records.mostPoints ? ['Most points', `${records.mostPoints.points} (S${records.mostPoints.season})`] : null,
          records.mostGoals ? ['Most goals', `${records.mostGoals.gf} (S${records.mostGoals.season})`] : null,
          ['Relegations', String(records.relegations)],
        ].filter((x): x is [string, string] => x != null).map(([lab, val]) => h('div', {},
          h('div', { class: 'muted', style: 'font-size:11px' }, lab),
          h('div', { style: 'font-weight:700' }, val))))) : '',
    h('div', { class: 'card' },
      h('div', { class: 'section-title', style: 'margin-top:0' }, 'Season by season'),
      h('div', { style: 'max-height:560px;overflow:auto' }, h('table', {},
        h('thead', {}, h('tr', {},
          h('th', { class: 'num' }, 'Season'), h('th', {}, 'Division'), h('th', { class: 'num' }, 'Pos'),
          h('th', { class: 'num' }, 'W-D-L'), h('th', { class: 'num' }, 'GF:GA'), h('th', { class: 'num' }, 'Pts'), h('th', {}, 'Honours'))),
        body))),
  ));
}

// ── squad spine screen: sortable attribute table + heat + depth chart + compare ──
async function screenSquad() {
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading squad…')));
  let team: TeamT;
  try { team = await api.team(); }
  catch (e: any) {
    if (String(e.message).includes('no team')) return screenCreateTeam();
    return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message),
      h('button', { class: 'ghost', style: 'margin-top:12px', onclick: () => screenSquad() }, '↻ Retry')));
  }
  // §2.10 fitness/rotation: best-effort — the table + rotation card degrade gracefully if it 404s.
  let rot: RotationT | null = null;
  try { rot = await api.rotation(); } catch { /* no rotation guidance */ }
  const rotMap = new Map((rot?.players ?? []).map(p => [p.slot, p] as const));
  // Fitness cell: 🤕 for the injured, else the condition % coloured by band, with a ⚠risk badge on
  // an at-risk starter (so the cost of fielding a tired man is visible right in the squad table).
  const fitCell = (p: PlayerT) => {
    if ((p.injuredMatches ?? 0) > 0) return h('td', { class: 'num', style: 'color:var(--danger)' }, `🤕${p.injuredMatches}`);
    const r = rotMap.get(p.slot);
    const col = r ? BAND_COLOR[r.band] : '';
    // Show the risk badge for any objectively tired/exhausted starter — keyed off the fitness band, not
    // an absolute risk, so a strong physio lowering the % can't hide the warning for a tired man.
    const warn = r && r.starter && (r.band === 'tired' || r.band === 'exhausted')
      ? h('span', { class: 'muted', style: 'font-size:10px;color:#ffb84d' }, ` ⚠${Math.round(r.risk * 100)}%`) : '';
    return h('td', { class: 'num', style: col ? `color:${col}` : '', title: r ? `${Math.round(r.risk * 100)}% injury risk if he starts` : '' }, `${p.fitness ?? 100}%`, warn);
  };
  const players = [...team.players];
  const leadOf = (p: PlayerT) => (p.personality?.traits?.leadership ?? -1);
  // §2.11: the MANAGER's chosen captain wins; otherwise the highest-leadership player (and only when at
  // least one player HAS personality data — don't fabricate a captain on players[0] for a dial-less squad).
  const autoCap = players.length ? players.reduce((best, p) => leadOf(p) > leadOf(best) ? p : best, players[0]) : null;
  const autoSlot = autoCap && leadOf(autoCap) >= 0 ? autoCap.slot : -1;
  const captainSlot = team.captainSlot != null && players.some(p => p.slot === team.captainSlot) ? team.captainSlot : autoSlot;

  let sortKey = 'slot', sortDir: 1 | -1 = 1, cmpA = -1, cmpB = -1;
  const COLS: { key: string; label: string; text?: boolean; get: (p: PlayerT) => number | string }[] = [
    { key: 'slot', label: 'Name', text: true, get: p => p.name },
    { key: 'role', label: 'Pos', text: true, get: p => p.role },
    { key: 'age', label: 'Age', get: p => p.age ?? 0 },
    { key: 'ovr', label: 'OVR', get: p => skillOvr(p.attrs) },
    { key: 'pot', label: 'POT', get: p => p.potential ?? 0 },
    ...SQUAD_ATTRS.map(([a, lab]): { key: string; label: string; get: (p: PlayerT) => number } => ({ key: a, label: lab, get: p => p.attrs[a] ?? 0 })),
    { key: 'wage', label: 'Wage', get: p => p.wage ?? 0 },
    { key: 'contract', label: 'Contr', get: p => p.contractYears ?? 0 },
    { key: 'morale', label: 'Mor', get: p => p.morale ?? 0 },
    { key: 'fitness', label: 'Fit', get: p => (p.injuredMatches ?? 0) > 0 ? -1 : (p.fitness ?? 100) },
  ];

  function render() {
    const col = COLS.find(c => c.key === sortKey)!;
    const sorted = [...players].sort((a, b) => {
      const va = col.get(a), vb = col.get(b);
      const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return c * sortDir;
    });
    const thead = h('thead', {}, h('tr', {}, ...COLS.map(c => {
      const th = h('th', { class: c.text ? '' : 'num', style: 'cursor:pointer;user-select:none' },
        c.label + (sortKey === c.key ? (sortDir === 1 ? ' ▲' : ' ▼') : ''));
      th.addEventListener('click', () => { if (sortKey === c.key) sortDir = (sortDir === 1 ? -1 : 1); else { sortKey = c.key; sortDir = c.text ? 1 : -1; } render(); });
      return th;
    })));
    const tbody = h('tbody');
    for (const p of sorted) {
      const ovr = skillOvr(p.attrs);
      const isCap = captainSlot === p.slot;
      // §2.11: a clickable armband — the captain shows 🧭, others a faint one; clicking names/clears the captain.
      const capArm = h('span', {
        title: isCap ? 'Club captain — click to reset to auto (highest leader)' : `Make ${p.name} captain`,
        style: `cursor:pointer;margin-right:4px;${isCap ? '' : 'opacity:.25'}`,
      }, '🧭');
      capArm.addEventListener('click', async (e: any) => {
        e.stopPropagation();
        try { const r = await api.setCaptain(isCap ? -1 : p.slot); toast(r.captainSlot == null ? 'Captain reset to auto (top leader)' : `${p.name} takes the armband`); screenSquad(); }
        catch (err: any) { toast(err.message); }
      });
      tbody.append(h('tr', { class: p.slot < 11 ? 'me' : '' },
        h('td', {}, capArm,
          h('span', { style: 'cursor:pointer', onclick: () => (location.hash = `#/player/${p.slot}`) }, p.name),
          p.slot >= 11 ? h('span', { class: 'muted', style: 'font-size:10px' }, ' · bench') : '',
          seekingMove(p) ? h('span', { class: 'pill', title: 'Running down his contract and unsettled — likely to push for a move', style: 'margin-left:5px;background:var(--danger);color:#fff;font-size:9px' }, 'seeking move') : ''),
        h('td', {}, h('span', { class: 'pill' }, p.role)),
        h('td', { class: 'num' }, String(p.age ?? '—')),
        h('td', { class: 'num', style: 'font-weight:700' }, String(ovr)),
        h('td', { class: 'num' }, p.potential != null && p.potential > ovr ? h('span', { class: 'a', style: 'color:var(--accent)' }, String(p.potential)) : String(p.potential ?? '—')),
        ...SQUAD_ATTRS.map(([a]) => h('td', { class: 'num', style: attrHeat(p.attrs[a] ?? 0) }, String(Math.round(p.attrs[a] ?? 0)))),
        h('td', { class: 'num' }, p.wage != null ? fmtMoney(p.wage) : '—'),
        h('td', { class: 'num', style: contractStyle(p.contractYears) }, (p.contractYears ?? 0) + 'y'),
        h('td', { class: 'num', style: p.morale != null ? (p.morale >= 75 ? 'color:var(--accent)' : p.morale <= 40 ? 'color:var(--danger)' : '') : '' }, String(p.morale ?? '—')),
        fitCell(p)));
    }
    // depth by position (● starter / ○ bench)
    const ROLE_ORDER = ['GK', 'CB', 'FB', 'CM', 'WM', 'CF'];
    const byRole = ROLE_ORDER.map(role => ({ role, ps: players.filter(p => p.role === role).sort((a, b) => a.slot - b.slot) })).filter(g => g.ps.length);
    const depth = h('div', { class: 'row', style: 'gap:16px;flex-wrap:wrap;align-items:start' }, ...byRole.map(g => h('div', { style: 'min-width:120px' },
      h('div', { class: 'muted', style: 'font-size:11px;text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px' }, `${g.role} · ${g.ps.length}`),
      ...g.ps.map(p => h('div', { style: 'font-size:12px;padding:1px 0;' + (p.slot < 11 ? '' : 'opacity:.55'), }, `${p.slot < 11 ? '●' : '○'} ${p.name} ${skillOvr(p.attrs)}`)))));
    // compare
    const opt = (sel: number) => [h('option', { value: '-1' }, '— pick —'), ...players.map(p => { const o = h('option', { value: String(p.slot) }, `${p.name} (${p.role})`) as HTMLOptionElement; if (p.slot === sel) o.selected = true; return o; })];
    const selA = h('select', {}, ...opt(cmpA)) as HTMLSelectElement;
    const selB = h('select', {}, ...opt(cmpB)) as HTMLSelectElement;
    selA.addEventListener('change', () => { cmpA = Number(selA.value); render(); });
    selB.addEventListener('change', () => { cmpB = Number(selB.value); render(); });
    const pa = players.find(p => p.slot === cmpA), pb = players.find(p => p.slot === cmpB);
    const cmp = pa && pb
      ? h('div', {}, ...SQUAD_ATTRS.map(([a, lab]) => h('div', { class: 'row', style: 'gap:10px;align-items:center;font-size:12px;margin:3px 0;justify-content:center' },
          h('span', { class: 'num', style: 'width:34px;text-align:right;' + attrHeat(pa.attrs[a] ?? 0) }, String(Math.round(pa.attrs[a] ?? 0))),
          h('span', { class: 'muted', style: 'width:44px;text-align:center' }, lab),
          h('span', { class: 'num', style: 'width:34px;' + attrHeat(pb.attrs[a] ?? 0) }, String(Math.round(pb.attrs[a] ?? 0))))))
      : h('div', { class: 'muted', style: 'font-size:12px' }, 'Pick two players to compare their attributes.');

    // §2.10 rotation guidance: a "rest X for Y" panel with one-click apply, driven by fitness/injury.
    const rotationCard = (() => {
      const r = rot;
      if (!r) return '';
      const head = h('div', { class: 'between' },
        h('div', { class: 'section-title', style: 'margin-top:0' }, '🩺 Fitness & rotation'),
        h('div', { class: 'muted', style: 'font-size:12px' },
          `${r.atRisk} at risk · ~${r.expectedInjuries} expected injur${r.expectedInjuries === 1 ? 'y' : 'ies'} this matchday${r.physioMitigation ? ` · physios −${r.physioMitigation}% risk` : ''}`));
      if (!r.suggestions.length) return h('div', { class: 'card' }, head,
        h('div', { class: 'muted', style: 'font-size:13px;margin-top:6px' },
          r.atRisk ? 'Some starters are tired but you have no fitter cover in their position — sign depth or risk it.' : '✅ Your XI is fresh — no rotation needed.'));
      const rows = r.suggestions.map(s => {
        const btn = h('button', { class: 'ghost small' }, s.urgent ? 'Replace' : 'Rest him');
        btn.addEventListener('click', async () => {
          btn.setAttribute('disabled', 'true'); btn.textContent = '…';
          try { await api.applyRotation(s.outSlot, s.inSlot); toast(`${s.inName} starts for ${s.outName}`); screenSquad(); }
          catch (e: any) { toast(e.message); btn.removeAttribute('disabled'); btn.textContent = s.urgent ? 'Replace' : 'Rest him'; }
        });
        return h('div', { class: 'card', style: 'padding:8px 10px;margin:0;display:flex;justify-content:space-between;align-items:center;gap:10px' },
          h('div', { style: 'font-size:13px' },
            s.urgent ? h('span', { class: 'pill', style: 'background:var(--danger);color:#fff;font-size:9px;margin-right:6px' }, 'injured') : '',
            s.reason),
          btn);
      });
      return h('div', { class: 'card' }, head, h('div', { class: 'grid', style: 'gap:6px;margin-top:8px' }, ...rows));
    })();

    // Match-condition panel: a visual per-player STAMINA BAR (user ask) — most tired/injured first, so the
    // players who need resting surface at the top. Complements the Fit column + the 🩺 rotation card below.
    const conditionCard = (() => {
      const condCol = (p: PlayerT) => {
        if ((p.injuredMatches ?? 0) > 0) return 'var(--danger)';
        const band = rotMap.get(p.slot)?.band;
        if (band && BAND_COLOR[band]) return BAND_COLOR[band];
        const f = p.fitness ?? 100;
        return f < 50 ? 'var(--danger)' : f < 75 ? '#ffb84d' : f < 90 ? '#7fb2ff' : 'var(--accent)';
      };
      const fitVal = (p: PlayerT) => (p.injuredMatches ?? 0) > 0 ? -1 : (p.fitness ?? 100);
      const ranked = [...players].sort((a, b) => fitVal(a) - fitVal(b));   // most tired/injured first
      const bar = (p: PlayerT) => {
        const inj = (p.injuredMatches ?? 0) > 0;
        const fit = Math.max(0, Math.min(100, p.fitness ?? 100));
        const col = condCol(p);
        const r = rotMap.get(p.slot);
        const risk = r && r.starter && (r.band === 'tired' || r.band === 'exhausted') ? ` ⚠${Math.round(r.risk * 100)}%` : '';
        return h('div', { class: 'between', style: 'gap:10px;font-size:12px;padding:3px 0;align-items:center' },
          h('span', { style: 'width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0' },
            h('span', { style: 'opacity:.45;margin-right:3px' }, p.slot < 11 ? '●' : '○'), p.name,
            h('span', { class: 'muted', style: 'margin-left:5px;font-size:10px' }, p.role)),
          h('div', { style: 'flex:1;height:9px;background:var(--panel2,#161f30);border-radius:5px;overflow:hidden' },
            h('div', { style: `height:100%;width:${inj ? 100 : fit}%;background:${col}${inj ? ';background-image:repeating-linear-gradient(45deg,transparent,transparent 3px,rgba(0,0,0,.3) 3px,rgba(0,0,0,.3) 6px)' : ''}` })),
          h('span', { class: 'num', style: `width:62px;text-align:right;color:${col}` }, inj ? `🤕${p.injuredMatches}` : `${fit}%`),
          h('span', { class: 'muted', style: 'width:34px;font-size:10px;color:#ffb84d' }, risk));
      };
      return h('div', { class: 'card' },
        h('div', { class: 'section-title', style: 'margin-top:0' }, '🔋 Match condition'),
        h('div', { class: 'muted', style: 'font-size:11px;margin-bottom:6px' }, 'Per-player stamina — most tired first. A tired ⚠ or injured 🤕 starter risks an injury; rotate from the panel below.'),
        h('div', { style: 'max-height:430px;overflow:auto' }, ...ranked.map(bar)));
    })();

    mount(header(), h('div', { class: 'wrap grid' },
      h('div', { class: 'between' },
        h('div', {}, h('h2', {}, 'Squad'), h('div', { class: 'muted' }, `${players.length} players · ● starter / ○ bench · 🧭 captain (click the armband to set — a strong leader steadies squad morale) · click a header to sort`)),
        h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, '← Back')),
      h('div', { class: 'card scroll-x' }, h('table', {}, thead, tbody)),
      h('div', { class: 'grid cols-2', style: 'align-items:start' }, conditionCard, rotationCard || h('div')),
      h('div', { class: 'grid cols-2', style: 'align-items:start' },
        h('div', { class: 'card' }, h('div', { class: 'section-title', style: 'margin-top:0' }, 'Depth by position'), depth),
        h('div', { class: 'card' }, h('div', { class: 'section-title', style: 'margin-top:0' }, 'Compare two players'),
          h('div', { class: 'row', style: 'gap:10px;margin-bottom:10px' }, selA, selB), cmp))));
  }
  render();
}

function route() {
  const hash = location.hash;
  if (!user) { screenAuth(); return; }
  if (!hash.startsWith('#/watch/')) teardownWatch();
  if (hash.startsWith('#/watch/')) screenWatch(Number(hash.split('/')[2]));
  else if (hash === '#/tactics') screenTactics();
  else if (hash === '#/market') screenMarket();
  else if (hash === '#/training') screenTraining();
  else if (hash === '#/academy') screenAcademy();
  else if (hash.startsWith('#/teamtalk/')) screenTeamTalk(Number(hash.split('/')[2]));
  else if (hash === '#/news') screenNews();
  else if (hash === '#/squad') screenSquad();
  else if (hash === '#/staff') screenStaff();
  else if (hash === '#/finances') screenFinances();
  else if (hash === '#/cup') screenCup();
  else if (hash === '#/history') screenHistory();
  else if (hash.startsWith('#/report/')) screenReport(Number(hash.split('/')[2]));
  else if (hash.startsWith('#/scout/')) screenScout(Number(hash.split('/')[2]));
  else if (hash.startsWith('#/player/')) screenPlayer(Number(hash.split('/')[2]));
  else screenDashboard();
}

window.addEventListener('hashchange', route);

(async function boot() {
  try {
    const me = await api.me();
    user = me.user;
    if (user && me.teamId == null && location.hash !== '#/tactics') { screenCreateTeam(); return; }
  } catch { /* */ }
  route();
})();
