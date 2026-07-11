import './styles.css';
import { api, type TeamT, type PlayerT, type LeagueT, type FixtureT, type MarketT, type CupT, type ReportT, type NewsItemT, type PlanT, type DirectiveT, type ScoutT, type SeasonHistoryT, type StaffViewT, type FinancesT, type HarmonyT, type ConcernT, type BoardMeetingT, type ManagerCareerT, type FormationsT, type OfferT, type TrainingReportT, type RotationT, type ContractOfferT, type ScoutPlayerT, type IncomingOfferT, type AcademyProspectT, type FreeAgentOfferT, type TalkToneT, type TalkReactionT, type TacticsReviewT, type ShoutReviewT, type TimelineEventT, type LeadersT, type PlayerSeasonStatT } from './api';
import { MatchRenderer } from './renderer';
import { PITCH_W, PITCH_H } from './constants';
import type { EngineState } from './types';

// ── live-watch socket envelope ── the web backend wraps each engine frame with team names +
// a replay flag, and pushes a tacticsReceipt message in reply to a shout. Typed here (not in
// types.ts) because it's the web transport layer, not the engine contract.
interface MotivationReaction { playerId: number; moraleDelta: number; reaction?: string; }
interface TacticsReceipt {
  error?: string; formation?: string; note?: string; changed?: string;
  motivation?: MotivationReaction[]; plan?: PlanT | null; directives?: DirectiveT[];
}
type WatchMessage = EngineState & { homeName?: string; awayName?: string; weather?: 'clear' | 'rain' | 'wind'; replay?: boolean; durationMs?: number; tacticsReceipt?: TacticsReceipt; error?: string };

const root = document.getElementById('app')!;
let user: { id: number; username: string; isAdmin?: boolean } | null = null;

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
// a11y: keyboard-accessible props for a clickable NON-button element (a card/row div). role+tabindex make it
// focusable; Enter/Space activate it like a real button. Spread into h()'s attrs in place of a bare onclick.
function clickable(handler: () => void): Attrs {
  return { role: 'button', tabindex: '0', onclick: handler, onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); } } };
}
// SVG sibling of h() — createElementNS so <svg> children render; values go in as attributes and
// text as text nodes (so player names can't inject markup), same XSS-safe posture as h().
function svgEl(tag: string, attrs: Record<string, string | number | undefined> = {}, ...kids: (Node | string)[]): SVGElement {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) e.setAttribute(k, String(v));
  for (const kid of kids) e.append(kid instanceof Node ? kid : document.createTextNode(kid));
  return e;
}
let lastFocusHash = 'init';
let navFocusTimer = 0;   // sentinel — guarantees the focus move happens on the first render too
// ── route-generation guard ── bumped on every route() dispatch. An async screen captures `const alive =
// screenGuard();` at entry and calls `if (!alive()) return;` after each await before it touches the DOM, so a
// slow fetch can't mount() stale content over a screen the user has since navigated to — and can't orphan the
// watch's body-attached controls/socket by wiping its canvas. Mirrors screenWatch's watchEpoch, generalised.
let routeGen = 0;
function screenGuard(): () => boolean { const g = routeGen; return () => g === routeGen; }
function mount(...nodes: Node[]) {
  root.replaceChildren(...nodes);
  // a11y: tag the content as the <main> landmark, and on a ROUTE CHANGE move focus into it so screen-reader +
  // keyboard users land on the new content's heading instead of re-traversing the header nav every navigation.
  // Hash-guarded so an in-screen re-render (same route, e.g. after an action) doesn't steal focus from the user.
  const main = nodes[nodes.length - 1];
  if (main instanceof HTMLElement) {
    main.id = 'main-content'; main.setAttribute('role', 'main'); main.setAttribute('tabindex', '-1');
    if (location.hash !== lastFocusHash) {
      // debounced + re-queried at fire time so a screen that mounts twice (skeleton then content) focuses its FINAL
      // content; hash-guarded so an in-screen re-render of the SAME route never yanks focus from what the user is doing.
      clearTimeout(navFocusTimer);
      navFocusTimer = window.setTimeout(() => {
        lastFocusHash = location.hash;
        const m = document.getElementById('main-content'); if (!m) return;
        const target = (m.querySelector('h1, h2') as HTMLElement | null) ?? m;
        target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
      }, 90);
    }
  }
}
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
// a11y: keep Tab inside the open dialog (a modal must not let keyboard/SR users tab into the inert page behind).
function trapTab(e: KeyboardEvent, card: HTMLElement): void {
  const f = card.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])');
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1], active = document.activeElement;
  if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
}
function confirmModal(title: string, message: string, okLabel = 'Confirm'): Promise<boolean> {
  return new Promise(resolve => {
    let done = false;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') finish(false); else if (e.key === 'Enter') finish(true); else if (e.key === 'Tab') trapTab(e, card); };
    const onHash = () => finish(false);   // navigating away closes the modal (it lives on body, not root)
    const finish = (v: boolean) => { if (done) return; done = true; document.removeEventListener('keydown', onKey); window.removeEventListener('hashchange', onHash); backdrop.remove(); resolve(v); };
    const ok = h('button', { class: 'primary', onclick: () => finish(true) }, okLabel);
    const card = h('div', { class: 'modal-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'modal-title' },
      h('h3', { id: 'modal-title', style: 'margin-bottom:10px' }, title),
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
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') finish(null); else if (e.key === 'Tab') trapTab(e, card); };
    const onHash = () => finish(null);   // navigating away closes the modal (it lives on body, not root)
    const finish = (v: string | null) => { if (done) return; done = true; document.removeEventListener('keydown', onKey); window.removeEventListener('hashchange', onHash); backdrop.remove(); resolve(v); };
    const input = h('input', { type: 'text', value }) as HTMLInputElement;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(input.value); } });
    const card = h('div', { class: 'modal-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'modal-title' },
      h('h3', { id: 'modal-title', style: 'margin-bottom:10px' }, title),
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
  if (n < 0) return `-${fmtMoney(-n)}`;   // a deficit renders as -£1.2M, not £-1200000 (raw, hyphen glued to £)
  if (n >= 1e6) return `£${(n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1)}M`;
  if (n >= 1e3) {
    const k = Math.round(n / 1e3);
    if (k >= 1000) return `£${(k / 1000).toFixed(1)}M`;   // 999,500+ rounds to 1000K → roll up to £1.0M, not £1000K
    return `£${k}K`;
  }
  return `£${Math.round(n)}`;
}
// OVR = mean of the 7 core skills (excludes height/handling) — matches the backend's
// overall() and the market/training screens, so a player's OVR reads the same everywhere
// and the potential headroom (a skill-based ceiling) compares against the right number.
const SKILL_KEYS = ['speed', 'passing', 'creativity', 'shooting', 'tackling', 'positioning', 'stamina'];
function skillOvr(attrs: Record<string, number>): number {
  return Math.round(SKILL_KEYS.reduce((s, k) => s + (attrs[k] ?? 0), 0) / SKILL_KEYS.length);
}
// per-cell attribute heat: red (low) → green (high), used across the squad table + compare.
// 'POSN' (not 'POS') for the positioning ATTRIBUTE so it never reads the same as the role/Position column.
const SQUAD_ATTRS: [string, string][] = [['speed', 'SPD'], ['passing', 'PAS'], ['creativity', 'CRE'], ['shooting', 'SHO'], ['tackling', 'TAC'], ['positioning', 'POSN'], ['stamina', 'STA']];
// A player's key attributes as "ABBR value" tokens — the single source of truth so every screen shows
// the SAME set (the dashboard squad card used to hand-write 6 and silently dropped stamina).
const attrTokens = (attrs: Record<string, number>): string[] => SQUAD_ATTRS.map(([k, abbr]) => `${abbr} ${Math.round(attrs[k] ?? 0)}`);
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
  // Collapsible (collapsed by default) — it's a secondary "peek at the world" that otherwise stacks
  // every other division's full table onto the dashboard (the density the user flagged). One click opens it.
  return h('details', { class: 'card' },
    h('summary', { class: 'section-title', style: 'margin-top:0;cursor:pointer' }, `Other divisions (${others.length})`),
    h('div', { class: 'grid cols-auto', style: 'align-items:start;margin-top:10px' }, ...cards));
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
  const uname = h('input', { id: 'f-uname', placeholder: 'username', autocomplete: 'username' }) as HTMLInputElement;
  const pass = h('input', { id: 'f-pass', type: 'password', placeholder: 'password', autocomplete: 'current-password' }) as HTMLInputElement;
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
      h('div', { class: 'field' }, h('label', { for: 'f-uname' }, 'Username'), uname),
      h('div', { class: 'field' }, h('label', { for: 'f-pass' }, 'Password'), pass),
      submit, err,
    ),
  ));
}

// ── create team ──
function screenCreateTeam() {
  const name = h('input', { id: 'f-clubname', placeholder: 'e.g. Brisbane Roar', value: `${user!.username} FC` }) as HTMLInputElement;
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
      h('div', { class: 'field' }, h('label', { for: 'f-clubname' }, 'Club name'), name),
      h('div', { class: 'section-title' }, 'Tactical plan'),
      planInput,
      h('div', { style: 'margin-top:16px' }, create), err,
    ),
  ));
}

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
      fmt = r.formation; lineup = r.lineup; badge.textContent = r.formation;   // the read-only badge reflects the shape the plan text set
      out.textContent = r.note || `Lined up in a ${r.formation}.`;
      drawPitch(r.slots?.length ? r.slots.map(s => ({ x: s.homeX, y: s.homeY, role: s.role, name: s.playerName || '—', injured: !!team.players.find(p => p.name === s.playerName)?.injuredMatches, misfit: s.misfit })) : tokensFromReg());
    } catch (e: any) { out.textContent = e.message; }
  };
  // §P0 (user 2026-06-25): the formation is set IN THE PLAN TEXT (the compiler reads it), so there's no
  // Shape dropdown — the badge above is the read-only current shape, and you change it in words below.
  const input = h('input', { placeholder: 'set your shape + tune in words — “play a 4-2-3-1”, “AB at left back”, “push the full-backs on”' }) as HTMLInputElement;
  const setBtn = h('button', { class: 'primary small' }, 'Set');
  const applyInput = () => { const t = input.value.trim(); if (t) { apply(t); input.value = ''; } };
  setBtn.addEventListener('click', applyInput);
  input.addEventListener('keydown', (ev: any) => { if (ev.key === 'Enter') applyInput(); });
  // §auto-XI: one-click strongest role-correct XI in the current shape (best role-fit per slot, injured last).
  const autoBtn = h('button', { class: 'ghost small', title: 'Field your strongest role-correct XI in the current shape' }, '⚡ Strongest XI') as HTMLButtonElement;
  autoBtn.addEventListener('click', async () => {
    autoBtn.setAttribute('disabled', 'true'); const t0 = autoBtn.textContent; autoBtn.textContent = '…';
    try {
      const r = await api.autoLineup();
      fmt = r.formation; lineup = r.lineup; badge.textContent = r.formation;
      drawPitch(tokensFromReg());
      out.textContent = r.note;
      toast('Strongest XI selected');
    } catch (e: any) { out.textContent = e.message; }
    finally { autoBtn.removeAttribute('disabled'); autoBtn.textContent = t0; }
  });

  return h('div', { class: 'card' },
    h('div', { class: 'between' }, h('div', { class: 'section-title', style: 'margin-top:0' }, 'Formation', badge), autoBtn),
    pitchBox,
    warn,
    h('div', { class: 'tactics-row', style: 'margin-top:10px' }, input, setBtn),
    h('div', { class: 'muted', style: 'font-size:11px;margin-top:5px' }, 'Your shape is set in the plan — just say it in words (“play a 4-2-3-1”, “switch to 3-5-2”), or ⚡ auto-pick your strongest XI. The badge above shows your current shape.'),
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
const capWord = (s: string): string => s ? s[0].toUpperCase() + s.slice(1) : s;
// A player's individual DEVELOPMENT state (focus / intensity / retraining) in plain English — all four
// fields ride on PlayerT already but only surface on the Training screen; the profile ignored them.
// Returns null when the player is on the club default with nothing individual set (nothing worth a line).
function trainingSummary(p: PlayerT): string | null {
  const bits: string[] = [];
  if (p.trainFocus && p.trainFocus !== 'balanced') bits.push(`${capWord(p.trainFocus)} focus`);
  if (p.trainIntensity && p.trainIntensity !== 'normal') bits.push(`${capWord(p.trainIntensity)} intensity`);
  if (p.retrainRole) bits.push(`retraining → ${p.retrainRole}${p.roleFamiliarity != null ? ` (settling ${Math.round(p.roleFamiliarity)}%)` : ''}`);
  return bits.length ? bits.join(' · ') : null;
}

// ── dashboard ──
// The advance-matchday digest: everything the last Advance produced, shown as ONE persistent card at the
// top of the dashboard until dismissed (replaces the old ~15-toast pile that vanished in 2.6s each).
type DigestItem = { category?: string; icon: string; text: string; hash?: string | null };
let matchdayDigest: { round: number | null; headline: string; items: DigestItem[] } | null = null;
async function screenDashboard() {
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading…')));
  let team: TeamT, league: LeagueT, news: NewsItemT[] = [], harmony: HarmonyT | null = null, reg: FormationsT | null = null, concerns: ConcernT[] = [];
  try {
    const [t, l, n, hm, fr, cn] = await Promise.all([api.team(), api.league(), api.news().catch(() => ({ news: [] })), api.harmony().catch(() => null), api.formations().catch(() => null), api.concerns().catch(() => ({ concerns: [] }))]);
    team = t; league = l; news = n.news; harmony = hm; reg = fr; concerns = cn.concerns;
  } catch (e: any) {
    if (String(e.message).includes('no team')) return screenCreateTeam();
    // team()/league() are essential — one transient failure shouldn't strand the home screen on a
    // bare error string with no way out. Offer a retry (news/harmony already fall back above).
    if (!alive()) return;
    return mount(header(), h('div', { class: 'wrap' },
      h('div', { class: 'err' }, 'Couldn’t load your club — ' + (e.message || 'something went wrong') + '.'),
      h('button', { class: 'ghost', style: 'margin-top:12px', onclick: () => screenDashboard() }, '↻ Retry')));
  }

  // §2.5: a sacked manager's save is over — the board let you go. No dashboard; offer a fresh start
  // (a new team supersedes the old, so the career restarts cleanly).
  if (team.sacked) {
    if (!alive()) return;
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
    const at = attrTokens(p.attrs);   // all 7, from SQUAD_ATTRS — split 4 / 3 across two lines to fit the card
    const card = h('div', { class: 'pcard', style: 'cursor:pointer', title: 'View profile & personality', ...clickable(() => { location.hash = `#/player/${p.slot}`; }) },
      h('div', { class: 'role' }, `${p.role} · OVR ${ovr}${potText}${ageText}${fitText}${moraleText}`),
      h('div', { class: 'pn' }, p.name),
      h('div', { class: 'at' }, at.slice(0, 4).join(' · '), h('br'), at.slice(4).join(' · ')),
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
  // §autonomous: 'solo' worlds advance on demand by their owner; 'shared' worlds advance on a schedule
  // (no manual button — a countdown is shown instead). canAdvance also lets an admin force any world.
  const worldTurn = league.world_turn;
  const isShared = worldTurn?.mode === 'shared';
  const canAdvanceHere = worldTurn ? worldTurn.canAdvance : !!user?.isAdmin;
  const adminTag = (user?.isAdmin && isShared) ? ' (admin)' : '';   // only tag the tester-forced case
  const advanceBtn = h('button', { title: simmingMyMatch
    ? 'Simulate the whole matchday now — including YOUR match (instantly). To play yours yourself, use “Watch my next match” or “⚡ Play LIVE” first.'
    : 'Simulate every club’s matchday and move the season on. No undo.' },
    !canAdvance ? 'Season complete'
      : simmingMyMatch ? `Play matchday ${pendingRound}${adminTag}`
        : `Advance matchday${pendingRound != null ? ` ${pendingRound}` : ''}${adminTag}`);
  if (!canAdvance) advanceBtn.setAttribute('disabled', 'true');
  advanceBtn.addEventListener('click', async () => {
    const opp = myInPending ? (myInPending.homeTeamId === team.id ? myInPending.away : myInPending.home) : '';
    const msg = simmingMyMatch
      ? `Your match this matchday — R${pendingRound}${opp ? ` vs ${opp}` : ''} — will be SIMULATED now, along with the rest of the world. To play it yourself, Cancel and hit “⚡ Play next match LIVE” (or “Watch my next match” for a quick sim). There is no undo.`
      : `${myNext ? 'Your match this round is already played — a' : 'A'}dvancing simulates the rest of the world’s matchday now. No undo — set your lineup, tactics and transfers first.`;
    if (!await confirmModal(simmingMyMatch ? 'Simulate your match & advance?' : 'Advance matchday', msg, simmingMyMatch ? 'Simulate & advance' : 'Advance')) return;
    advanceBtn.setAttribute('disabled', 'true'); advanceBtn.textContent = 'Simulating…';
    try {
      const r = await api.advance();
      // ── matchday DIGEST: everything the matchday produced, in ONE persistent, dismissable card on the
      // dashboard (was ~15 stacked 2.6-second toasts). The items + headline are now assembled server-side
      // (inbox.ts) and PERSISTED to the Inbox — the card renders the same array, so there's one formatting
      // source and no drift between the live digest and the archived feed.
      matchdayDigest = (r.digestHeadline || r.inbox.length) ? { round: pendingRound, headline: r.digestHeadline, items: r.inbox } : null;
      if (!matchdayDigest) toast('Matchday advanced.');
      screenDashboard();
    } catch (e: any) { toast(e.message); screenDashboard(); }
  });

  const watchBtn = h('button', { class: 'ghost', title: myNext
    ? 'Watch your next match as a quick simulation (the result is decided as it plays). To influence it live, use ⚡ Play LIVE instead.'
    : 'Replay your last match.' }, myNext ? 'Watch my next match' : 'Replay last match');
  watchBtn.addEventListener('click', async () => {
    const fx = myNext ?? [...league.fixtures].reverse().find(f => f.involvesMe && f.played);
    if (fx) location.hash = `#/watch/${fx.id}`;
    else toast('No match to watch yet — play or advance a matchday first.');
  });
  // ⚡ OPT-IN live play (beta): the resident coordinator runs your next match in real time with live
  // shouts that apply on the tick; full-time persists the result (it counts). Default stays the instant
  // pre-sim via Advance — this is the chosen big-match experience. Only for an upcoming (unplayed) match.
  // The LIVE path is the headline match experience — make it PRIMARY + prominent so it's the obvious way
  // to play your next match (otherwise users reach for Watch/Advance, which both SIM it, and never play live).
  const liveBtn = myNext
    ? h('button', { class: 'primary', title: 'Play your next match LIVE — watch in real time and shout; the result counts', onclick: () => (location.hash = `#/watch/${myNext.id}?live=1`) }, '⚡ Play next match LIVE')
    : '';

  // recent form (last 5 played in this division, oldest→newest) — computed from the fixtures already in
  // the payload, so no extra request and no engine. W/D/L from the team's own result.
  const FORM_DOT = (r: 'w' | 'd' | 'l') => h('span', {
    title: r.toUpperCase(),
    style: `display:inline-block;width:14px;height:14px;line-height:14px;text-align:center;font-size:9px;font-weight:700;border-radius:3px;color:#0b1018;`
      + `background:${r === 'w' ? 'var(--accent)' : r === 'd' ? 'var(--muted)' : 'var(--danger)'}`,
  }, r.toUpperCase());
  const formDots = (teamId: number): HTMLElement => {
    const res = league.fixtures
      .filter(f => f.played && f.homeScore != null && f.awayScore != null && (f.homeTeamId === teamId || f.awayTeamId === teamId))
      .sort((a, b) => a.round - b.round).slice(-5)
      .map(f => { const gf = f.homeTeamId === teamId ? f.homeScore! : f.awayScore!; const ga = f.homeTeamId === teamId ? f.awayScore! : f.homeScore!; return gf > ga ? 'w' : gf < ga ? 'l' : 'd'; });
    return res.length
      ? h('span', { style: 'display:inline-flex;gap:3px;justify-content:center' }, ...res.map(FORM_DOT))
      : h('span', { class: 'muted' }, '—');
  };
  const formCell = (teamId: number): HTMLElement => h('td', { class: 'num' }, formDots(teamId));
  // ── the matchday digest card (see matchdayDigest above) — dismiss ✕ clears it ──
  const digestCard = matchdayDigest ? h('div', { class: 'card', style: 'padding:14px 16px;border-left:3px solid var(--accent)' },
    h('div', { class: 'between' },
      h('div', { class: 'section-title', style: 'margin:0' }, `📰 Matchday${matchdayDigest.round != null ? ` ${matchdayDigest.round}` : ''} digest`),
      h('button', { class: 'ghost small', 'aria-label': 'Dismiss the matchday digest', onclick: () => { matchdayDigest = null; screenDashboard(); } }, '✕')),
    matchdayDigest.headline ? h('div', { style: 'font-size:17px;font-weight:700;margin-top:6px' }, matchdayDigest.headline) : '',
    ...matchdayDigest.items.map(it => it.hash
      ? h('div', { style: 'font-size:13px;padding:3px 0;cursor:pointer', title: 'Open', ...clickable(() => (location.hash = it.hash!)) }, `${it.icon} ${it.text} →`)
      : h('div', { style: 'font-size:13px;padding:3px 0' }, `${it.icon} ${it.text}`))) : '';

  // ── next-match hero: WHO you play, their position + form vs yours, venue + weather, and every
  //    match action (LIVE / sim / talk / scout) in ONE place — was scattered across the header row +
  //    the fixtures list. Only when there IS an upcoming match; the header keeps Advance (+ replay-last).
  const posOf = (teamId: number): number => league.standings.findIndex(s => s.teamId === teamId) + 1;
  const teamTalkBtn = myNext ? h('button', { class: 'ghost', title: 'Address the squad before your next match', onclick: () => (location.hash = `#/teamtalk/${myNext.id}`) }, '🎤 Team talk') : '';
  const scoutBtn = myNext ? h('button', { class: 'ghost', title: 'Scout the opposition — shape, danger men, weak spots', onclick: () => (location.hash = `#/scout/${myNext.id}`) }, '🔍 Scout them') : '';
  const heroSide = (teamId: number, name: string, alignRight: boolean): HTMLElement => {
    const p = posOf(teamId);
    const mine = teamId === team.id;
    return h('div', { style: `flex:1;min-width:150px;text-align:${alignRight ? 'right' : 'left'}` },
      h('div', { style: `font-size:16px;font-weight:700;${mine ? 'color:var(--accent);' : ''}` }, name),
      h('div', { class: 'muted', style: 'font-size:12px;margin:2px 0 4px' }, p > 0 ? `${ordinal(p)} in the table` : ''),
      formDots(teamId));
  };
  const nextMatchCard = myNext ? h('div', { class: 'card', style: 'padding:14px 16px' },
    h('div', { class: 'between', style: 'margin-bottom:8px' },
      h('div', { class: 'section-title', style: 'margin:0' }, `Next match · Round ${myNext.round} · ${team.id === myNext.homeTeamId ? '🏟 at home' : '🚌 away'}`),
      myNext.weather && myNext.weather !== 'clear'
        ? h('span', { class: 'pill', title: myNext.weather === 'rain' ? 'Wet pitch — the ball skids further' : 'Windy — long balls and crosses drift', style: 'background:rgba(127,178,255,.14);color:#9ec5ff' }, myNext.weather === 'rain' ? '🌧 Rain forecast' : '🌬 Windy forecast')
        : ''),
    h('div', { style: 'display:flex;align-items:center;gap:16px;flex-wrap:wrap' },
      heroSide(myNext.homeTeamId, myNext.home, true),
      h('div', { class: 'muted', style: 'font-weight:800;font-size:14px' }, 'vs'),
      heroSide(myNext.awayTeamId, myNext.away, false)),
    h('div', { class: 'row', style: 'margin-top:12px;flex-wrap:wrap' }, liveBtn, watchBtn, teamTalkBtn, scoutBtn)) : '';

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
    // §weather: a forecast (upcoming) / what-happened (played) badge — only the notable conditions show.
    const wx = f.weather && f.weather !== 'clear'
      ? h('span', { class: 'pill', title: f.weather === 'rain' ? 'Wet pitch — the ball skids further' : 'Windy — long balls and crosses drift', style: 'background:rgba(127,178,255,.14);color:#9ec5ff' }, f.weather === 'rain' ? '🌧 Rain' : '🌬 Wind')
      : '';
    if (f.played) {
      const action = h('span', { class: 'fx-actions', style: 'display:flex;gap:6px;align-items:center' }, wx,
        h('button', { class: 'ghost small', onclick: () => (location.hash = `#/watch/${f.id}`) }, 'Watch'),
        h('button', { class: 'ghost small', onclick: () => (location.hash = `#/report/${f.id}`) }, 'Report'));
      fxBox.append(h('div', { class: 'fx me' }, h('div', { class: 'h' }, f.home), score, h('div', {}, f.away), action));
    } else {
      // UX: the whole upcoming-fixture ROW scouts the opponent (declutters the ~12 per-row "Scout"
      // buttons SysArch flagged → one row-action + a 🔍 hint, not a button on every line).
      const opp = f.home === team.name ? f.away : f.home;
      const action = h('span', { class: 'fx-actions', style: 'display:flex;gap:6px;align-items:center' }, wx,
        h('span', { class: 'pill' }, `R${f.round}`), h('span', { class: 'muted', style: 'font-size:12px' }, '🔍'));
      fxBox.append(h('div', { class: 'fx me', style: 'cursor:pointer', title: `Scout ${opp}`, ...clickable(() => { location.hash = `#/scout/${f.id}`; }) },
        h('div', { class: 'h' }, f.home), score, h('div', {}, f.away), action));
    }
  }

  // press conference — your words move squad morale via each player's dials. One per match (§2.14 cadence):
  // you can't spam the media to farm morale, so the room is shut until your next game once you've spoken.
  const pressOpen = league.pressAvailable !== false;
  const pressInput = h('textarea', { class: 'tactics-input', rows: '2', placeholder: 'Or answer in your own words…' }) as HTMLTextAreaElement;
  const pressBtn = h('button', { class: 'ghost small' }, 'Say it');
  const pressQEl = h('div', { style: 'margin-bottom:8px' });   // the journalist question + tone buttons (fetched async)
  if (!pressOpen) { pressInput.setAttribute('disabled', 'true'); pressBtn.setAttribute('disabled', 'true'); }
  // "How it landed" panel — the per-player reactions (+ quotes) the backend returns, plus the board's
  // take. Patched in place (no dashboard rebuild, so the squad cards' morale just goes mildly stale).
  const pressReceipt = h('div', { class: 'tactics-receipt', style: 'max-height:300px;margin-top:10px' });
  const shutRoom = () => {
    pressInput.setAttribute('disabled', 'true'); pressBtn.setAttribute('disabled', 'true'); pressBtn.textContent = 'Spoken to the media';
    pressQEl.querySelectorAll('button').forEach(b => b.setAttribute('disabled', 'true'));
  };
  const submitPress = async (text: string, tone?: string) => {
    if (!text.trim()) { toast('Say something to the media first'); return; }
    pressBtn.setAttribute('disabled', 'true');
    pressQEl.querySelectorAll('button').forEach(b => b.setAttribute('disabled', 'true'));
    pressReceipt.replaceChildren(h('div', { class: 'muted' }, 'Facing the press…'));
    try {
      const r = await api.press(text, tone);
      toast(`Media reaction: ${r.lifted} lifted${r.unsettled ? `, ${r.unsettled} unsettled` : ''}`);
      const lines: (HTMLElement | string)[] = [
        h('div', { class: 'muted', style: 'margin-bottom:5px' }, `How it landed — ${r.lifted} lifted, ${r.unsettled} unsettled:`),
        ...[...r.reactions].sort((a, b) => b.delta - a.delta).map(x => h('div', {
          class: 'receipt-line ' + (x.delta > 0 ? 'up' : x.delta < 0 ? 'down' : ''), style: 'font-size:13px;padding:2px 0',
        }, `${x.delta > 0 ? '▲' : x.delta < 0 ? '▼' : '·'} ${x.name} ${x.delta > 0 ? '+' : ''}${x.delta}${x.quote ? ` — “${x.quote}”` : ''}`)),
      ];
      if (r.boardDelta) lines.push(h('div', { class: 'receipt-line ' + (r.boardDelta > 0 ? 'up' : 'down'), style: 'font-size:13px;padding:5px 0 0;border-top:1px solid var(--line);margin-top:5px' },
        `📋 Board ${r.boardDelta > 0 ? '▲ +' : '▼ '}${r.boardDelta}${r.confidence ? ` — confidence ${r.confidence.value} (${CONF_LABEL[r.confidence.status] ?? r.confidence.status})` : ''}`));
      pressReceipt.replaceChildren(...lines);
      pressInput.value = ''; shutRoom();   // one per match — leave the room shut until the next game
    } catch (e: any) {
      pressReceipt.replaceChildren(h('div', { class: 'warn' }, '⚠ ' + e.message));
      pressBtn.removeAttribute('disabled');
      pressQEl.querySelectorAll('button').forEach(b => b.removeAttribute('disabled'));
    }
  };
  pressBtn.addEventListener('click', () => submitPress(pressInput.value));
  // Fetch the journalist's question + tone-keyed options (LLM, context-aware; template fallback).
  if (pressOpen) {
    void api.pressQuestion().then(q => {
      if (!q.available || !q.question) return;
      pressQEl.replaceChildren(
        h('div', { style: 'margin-bottom:7px' }, h('span', { class: 'muted' }, '🎙 '), h('em', {}, `“${q.question}”`)),
        h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' }, ...(q.options ?? []).map(o =>
          h('button', { class: 'ghost small', title: o.text, onclick: () => submitPress(o.text, o.tone) }, o.label))));
    }).catch((e) => { console.warn('[press] question fetch failed — the free-text box still works', e); });
  }
  const pressCard = h('div', { class: 'card', style: 'margin-top:14px' },
    h('div', { class: 'section-title', style: 'margin-top:0' }, 'Press conference'),
    h('div', { class: 'muted', style: 'font-size:12px;margin-bottom:8px' },
      pressOpen ? 'Face the media — your tone moves squad morale (each player reacts via his personality) and the board takes note.'
        : 'You’ve already faced the media this matchday — back after your next match.'),
    pressQEl, pressInput, h('div', { style: 'margin-top:6px' }, pressBtn), pressReceipt);

  // ── club news: events that evolved a player's story + dials ──
  const NEWS_ICON: Record<NewsItemT['type'], string> = { hat_trick: '⚽⚽⚽', brace: '⚽⚽', red_card: '🟥', star: '⭐', long_injury: '🤕', pots: '🏆', young_pots: '🌟', press: '🎤' };
  // link by CURRENT name → slot (slots renumber on transfers, so a stored slot can drift); only
  // unique names link (a duplicate name can't be resolved to one player), and a player who has
  // since left the club just isn't a link.
  const nameCount = new Map<string, number>();
  for (const p of team.players) nameCount.set(p.name, (nameCount.get(p.name) ?? 0) + 1);
  const slotByName = new Map(team.players.filter(p => nameCount.get(p.name) === 1).map(p => [p.name, p.slot]));
  const newsCard = h('div', { class: 'card', style: 'margin-top:14px' },
    h('div', { class: 'between', style: 'margin-bottom:6px' },
      h('div', { class: 'section-title', style: 'margin:0' }, 'Club news'),
      news.length > 8 ? h('a', { class: 'a', href: '#/news', style: 'font-size:12px' }, 'View all →') : ''),
    news.length
      ? h('div', {}, ...news.slice(0, 8).map(n => h('div', { class: 'between', style: 'font-size:13px;padding:3px 0;' + (slotByName.has(n.player) ? 'cursor:pointer' : ''), ...(slotByName.has(n.player) ? clickable(() => { const s = slotByName.get(n.player); if (s != null) location.hash = `#/player/${s}`; }) : {}) },
          h('span', {}, `${NEWS_ICON[n.type] ?? '•'} ${n.headline}`),
          h('span', { class: 'muted', style: 'font-size:11px' }, `S${n.season}`))))
      : h('div', { class: 'muted', style: 'font-size:12px' }, 'No headlines yet — play on and your players will make news.'));

  // ── dressing room: squad harmony at a glance ──
  const HARMONY_ICON: Record<string, string> = { leader: '🧭', pro: '⭐', disruptive: '⚠️', unsettled: '😟' };
  // Re-paintable so a concern action (which moves morale) can refresh it in place — keeping the
  // dressing-room reading consistent with the concerns panel below it.
  const harmonyCard = h('div', { class: 'card', style: 'margin-top:14px' });
  const paintHarmony = (hm: HarmonyT | null): void => {
    if (!hm) { harmonyCard.style.display = 'none'; return; }
    harmonyCard.style.display = '';
    const c = hm.status === 'united' ? 'var(--accent)' : hm.status === 'settled' ? '#7fb2ff' : hm.status === 'restless' ? 'var(--gold)' : 'var(--danger)';
    harmonyCard.replaceChildren(
      h('div', { class: 'section-title', style: 'margin-top:0' }, 'Dressing room'),
      h('div', { class: 'between', style: 'font-size:13px;margin-bottom:6px' },
        h('span', { style: `color:${c};font-weight:600;text-transform:capitalize` }, hm.status),
        h('span', { class: 'muted' }, `avg morale ${hm.avgMorale}`)),
      ...(hm.players.length
        ? hm.players.map(p => h('div', { class: 'between', style: 'font-size:12px;padding:2px 0;cursor:pointer', ...clickable(() => { location.hash = `#/player/${p.slot}`; }) },
            h('span', {}, `${HARMONY_ICON[p.tag] ?? '•'} ${p.name}`),
            h('span', { class: 'muted', style: 'font-size:11px' }, p.note)))
        : [h('div', { class: 'muted', style: 'font-size:12px' }, 'A settled, unremarkable dressing room.')]));
  };
  paintHarmony(harmony);

  // ── dressing room concerns: players agitating to leave + the manager's response (§2.3 depth) ──
  // The actionable extension of the harmony panel: each unsettled player gets three responses. Patched
  // in place on action (no dashboard rebuild — the squad cards' morale just goes mildly stale).
  const KIND_LABEL: Record<string, string> = { unsettled: 'Unhappy', benched_star: 'Frustrated', wantaway: 'Wants out' };
  const concernsCard = h('div', { class: 'card', style: 'margin-top:14px' });
  let concernList = concerns;
  const paintConcerns = (list: ConcernT[]): void => {
    concernList = list;
    if (!list.length) { concernsCard.style.display = 'none'; concernsCard.replaceChildren(); return; }
    concernsCard.style.display = '';
    const act = async (slot: number, action: 'reassure' | 'accept' | 'reject'): Promise<void> => {
      concernsCard.querySelectorAll('button').forEach(b => b.setAttribute('disabled', 'true'));
      try {
        const r = await api.resolveConcern(slot, action);
        toast(`${r.message}${r.moraleDelta ? ` (morale ${r.moraleDelta > 0 ? '+' : ''}${r.moraleDelta})` : ''}`);
        paintConcerns(r.concerns);
        void api.harmony().then(paintHarmony).catch((e) => { console.warn('[harmony] refresh failed — card left as-is', e); });
      } catch (e: any) { toast('⚠ ' + e.message); paintConcerns(concernList); }
    };
    concernsCard.replaceChildren(
      h('div', { class: 'section-title', style: 'margin-top:0' }, `Dressing room concerns (${list.length})`),
      h('div', { class: 'muted', style: 'font-size:12px;margin-bottom:4px' }, 'Players angling for a move — talk them round, grant it, or hold firm.'),
      ...list.map(cn => {
        const reassure = h('button', { class: 'ghost small', title: cn.canReassure ? 'Talk him round — a morale lift (once per match)' : "You've already had a word — wait until the next match", onclick: () => act(cn.slot, 'reassure') }, 'Reassure');
        if (!cn.canReassure) reassure.setAttribute('disabled', 'true');
        return h('div', { style: 'padding:7px 0;border-top:1px solid var(--line)' },
          h('div', { class: 'between', style: 'font-size:13px' },
            h('span', {}, h('a', { class: 'a', href: `#/player/${cn.slot}` }, cn.name),
              ' ', h('span', { class: 'pill', style: 'background:#3a2a1f;color:#ffce9a;font-size:10px' }, KIND_LABEL[cn.kind] ?? cn.kind)),
            h('span', { class: 'muted', style: 'font-size:11px' }, `morale ${cn.morale}`)),
          h('div', { class: 'muted', style: 'font-size:12px;margin:2px 0 5px' }, cn.reason),
          h('div', { class: 'row', style: 'gap:6px' }, reassure,
            h('button', { class: 'ghost small', title: 'Agree to listen to offers — transfer-list him', onclick: () => act(cn.slot, 'accept') }, 'Accept — list'),
            h('button', { class: 'ghost small', title: 'Refuse — he stays, but his morale drops', onclick: () => act(cn.slot, 'reject') }, 'Reject')));
      }));
  };
  paintConcerns(concerns);

  // §autonomous: the header turn control. A solo world (or an admin) gets the Advance button; a shared
  // world advances on a schedule, so show a next-turn countdown chip instead of a manual button.
  const turnControl: HTMLElement | string = canAdvanceHere ? advanceBtn
    : (isShared && worldTurn
      ? (() => {
          const chip = h('span', { class: 'pill', title: 'This world advances on a schedule (2 turns/day). Set your tactics & transfers — the matchday plays automatically.' });
          if (worldTurn.nextTurnAt == null) chip.textContent = `⏱ Turn ${worldTurn.turn} · scheduled`;
          else {
            const ms = worldTurn.nextTurnAt - Date.now();
            if (ms <= 0) chip.textContent = `⏱ Turn ${worldTurn.turn} · next turn imminent`;
            else { const hh = Math.floor(ms / 3600000), mm = Math.floor((ms % 3600000) / 60000); chip.textContent = `⏱ Next turn in ${hh > 0 ? hh + 'h ' : ''}${mm}m`; }
          }
          return chip;
        })()
      : '');

  if (!alive()) return;
  mount(header(), h('div', { class: 'wrap grid' },
    h('div', { class: 'between' },
      h('div', {}, h('h2', {}, team.name), h('div', { class: 'muted' },
        `Managed by ${team.manager} · ${league.divisionName ?? 'League'}${league.season ? ` · Season ${league.season}` : ''} · Position ${myPos}/${league.standings.length}`)),
      // Match-flow actions live in the next-match hero card below; the header keeps Advance
      // (+ replay-last when there's no upcoming match — the hero only exists with one).
      h('div', {},
        h('div', { class: 'row' }, myNext ? '' : watchBtn, turnControl),
        // played-ahead dead-end: all your matches are done but the season hasn't rolled over yet — explain it
        // so the missing "Play LIVE" doesn't read as a bug (you simply have no upcoming match this season).
        !myNext && canAdvance ? h('div', { class: 'muted', style: 'font-size:12px;margin-top:6px' },
          'You’ve played all your matches this season — keep advancing to finish the season, then play your next fixtures live.') : ''),
    ),
    digestCard,
    nextMatchCard,
    h('div', { class: 'card', style: 'padding:14px' },
      h('div', { class: 'nav-grid' },
        navItem('📨', 'Inbox', '#/inbox'),
        navItem('📅', 'My Matches', '#/matches'),
        navItem('⚽', 'Results', '#/league'),
        navItem('📊', 'Stat leaders', '#/leaders'),
        navItem('👥', 'Squad', '#/squad'),
        navItem('💸', 'Market', '#/market'),
        navItem('🔎', 'Scouting', '#/scouting'),
        navItem('🏃', 'Training', '#/training'),
        navItem('🎓', 'Academy', '#/academy'),
        navItem('🧑‍🏫', 'Staff', '#/staff'),
        navItem('💰', 'Finances', '#/finances'),
        navItem('🏆', 'Cup', '#/cup'),
        navItem('📜', 'History', '#/history'),
        navItem('📋', 'Career', '#/career'),
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
          h('span', { class: 'pill', title: 'View profile / renew', style: 'cursor:pointer' + (seekingMove(p) ? ';background:var(--danger);color:#fff' : ''), ...clickable(() => (location.hash = `#/player/${p.slot}`)) },
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
      // §2.7 board messages — the board reacting to your last match + setting the next one's expectation.
      const msgs = league.boardMessages ?? [];
      if (msgs.length) {
        rows.push(h('div', { style: (conf || obj) ? 'margin-top:10px;border-top:1px solid var(--line);padding-top:8px' : '' },
          h('div', { class: 'muted', style: 'font-size:10px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px' }, 'From the boardroom'),
          ...msgs.map(m => h('div', { style: 'font-size:12px;margin-top:3px;display:flex;gap:7px;align-items:baseline' },
            h('span', { style: 'flex:0 0 auto' }, m.kind === 'reaction' ? '💬' : '🎯'),
            h('span', { class: 'muted' }, m.text)))));
      }
      // §41 board meeting — ask the board to back you (funds/wages), once a season; the grant scales
      // with confidence. Fetched async + patched in (the card renders immediately).
      const meetEl = h('div', { style: (conf || obj) ? 'margin-top:10px;border-top:1px solid var(--line);padding-top:8px' : '' });
      const askBoard = async (kind: 'funds' | 'wages'): Promise<void> => {
        meetEl.querySelectorAll('button').forEach(b => b.setAttribute('disabled', 'true'));
        try { const r = await api.boardRequest(kind); toast(r.message + (r.granted && r.budget != null && kind === 'funds' ? ` Budget now £${(r.budget / 1e6).toFixed(0)}M.` : '')); paintMeeting(r.meeting); }
        catch (e: any) { toast('⚠ ' + e.message); }
      };
      const paintMeeting = (m: BoardMeetingT): void => {
        const btn = (kind: 'funds' | 'wages', label: string, amt: number) => {
          const b = h('button', { class: 'ghost small', title: amt > 0 ? `The board would add £${(amt / 1e6).toFixed(0)}M` : 'The board won’t back this at your current standing', onclick: () => askBoard(kind) }, `${label}${amt > 0 ? ` · £${(amt / 1e6).toFixed(0)}M` : ''}`);
          if (!m.available || amt <= 0) b.setAttribute('disabled', 'true');
          return b;
        };
        meetEl.replaceChildren(
          h('div', { class: 'between', style: 'font-size:13px;margin-bottom:5px' },
            h('span', {}, '🤝 Board meeting'),
            m.available ? '' : h('span', { class: 'muted', style: 'font-size:11px' }, 'met this season')),
          m.available
            ? h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' }, btn('funds', 'Ask for transfer funds', m.grants.funds), btn('wages', 'Ask for wage budget', m.grants.wages))
            : h('div', { class: 'muted', style: 'font-size:12px' }, 'You’ve had your audience with the board — back next season.'));
      };
      void api.board().then(paintMeeting).catch((e) => { console.warn('[board] meeting fetch failed — section hidden', e); meetEl.style.display = 'none'; });
      rows.push(meetEl);
      return h('div', { class: 'card', style: 'padding:12px 14px' }, ...rows);
    })(),
    h('div', { class: 'card' }, h('div', { class: 'section-title', style: 'margin-top:0' }, league.divisionName ?? 'League table'), h('div', { class: 'scroll-x' }, table),
      (hasPromotion || hasRelegation) ? h('div', { class: 'muted', style: 'font-size:11px;margin-top:8px;display:flex;gap:16px' },
        hasPromotion ? h('span', {}, ZONE_DOT('promo'), 'Promotion') : '',
        hasRelegation ? h('span', {}, ZONE_DOT('releg'), 'Relegation') : '') : ''),
    otherDivisions(league),
    h('div', { class: 'grid cols-split', style: 'align-items:start' },
      h('div', { class: 'card' }, h('div', { class: 'section-title', style: 'margin-top:0' }, 'Your fixtures'), fxBox),
      h('div', {},
        formationPanel(team, reg),
        harmonyCard,
        concernsCard,
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
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading tactics…')));
  let team: TeamT;
  try { team = await api.team(); }
  catch (e: any) {
    if (String(e.message).includes('no team')) return screenCreateTeam();
    if (!alive()) return;
    return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message)));
  }
  const reg = await api.formations().catch(() => null);   // registry for the visual pitch (graceful if it fails)
  if (!alive()) return;
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
let watchKeyHandler: ((e: KeyboardEvent) => void) | null = null;   // P3 viewer keyboard shortcuts (space/←/→/,/.)
let watchVisHandler: (() => void) | null = null;   // background-tab handling (skip draw work while hidden; snap current on return)
let activeReplayTimer: ReturnType<typeof setInterval> | null = null;   // live goal-replay playback loop
let activeHighlightTimer: ReturnType<typeof setTimeout> | null = null;   // 🎞 highlights-reel tour step (survives teardown otherwise)
let watchStatsPanel: HTMLElement | null = null;   // 📊 on-demand match-analysis overlay (ratings + shot map + xG)
let watchStatsTimer: ReturnType<typeof setInterval> | null = null;   // refreshes the stats overlay while it's open
let watchLineupsPanel: HTMLElement | null = null;   // 👥 on-demand line-ups overlay (home/away columns)
let watchEpoch = 0;   // bumped on every teardown so an in-flight screenWatch can detect it was superseded
function teardownWatch() {
  watchEpoch++;
  if (activeReplayTimer) { clearTimeout(activeReplayTimer); clearInterval(activeReplayTimer); activeReplayTimer = null; }   // a live-rewind timer is a setTimeout — clear BOTH kinds
  if (activeHighlightTimer) { clearTimeout(activeHighlightTimer); activeHighlightTimer = null; }   // stop a highlights tour scheduled but not yet fired
  if (watchStatsTimer) { clearInterval(watchStatsTimer); watchStatsTimer = null; }   // stop the 📊 stats refresh loop
  watchStatsPanel?.remove(); watchStatsPanel = null;
  watchLineupsPanel?.remove(); watchLineupsPanel = null;
  try { watchPanelObs?.disconnect(); } catch { /* */ } watchPanelObs = null;
  if (watchKeyHandler) { window.removeEventListener('keydown', watchKeyHandler); watchKeyHandler = null; }
  if (watchVisHandler) { document.removeEventListener('visibilitychange', watchVisHandler); watchVisHandler = null; }
  try { activeWs?.close(); } catch { /* */ } activeWs = null;
  try { activeRenderer?.setReplay(false); } catch { /* */ }   // dismiss any GOAL-REPLAY banner before tearing down (no stuck overlay across watches)
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
  shoot_from_distance: 'Shoot from distance', work_it_into_box: 'Work it into the box',  // GAP 3: both are engine-run team kinds
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
  // WAVE movement primitives — readback prose so a compiled directive reads as English, not "player: come_short"
  come_short: 'comes short to feet', check_to_feet: 'comes short to feet',
  drift_into_pocket: 'drifts into the pockets', play_between_lines: 'plays between the lines',
  between_the_lines: 'plays between the lines', drop_into_the_ten: 'drops into the ten',
  target_man_holdup: 'holds it up as the target man', hold_it_up: 'holds it up', target_man: 'holds it up',
  cut_inside: 'cuts inside to shoot', cut_in: 'cuts inside', cut_inside_to_shoot: 'cuts inside to shoot',
  overlap: 'gets on the overlap', overlap_runs: 'overlaps', get_on_the_overlap: 'gets on the overlap',
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

async function screenWatch(fixtureId: number, shouts = false, live = false, startMs = 0, cup = false) {
  teardownWatch();
  const myEpoch = watchEpoch;   // if another teardown/navigation bumps this during init, we bail below
  // A cup tie is a recorded, spectator-only replay (no coordinator, no shout log keyed by tie id), so
  // its watch is always plain playback — force off the live/shout paths regardless of the hash.
  if (cup) { live = false; shouts = false; }
  // Ensure the result is recorded (idempotent, deterministic, same as the stream). NOT for a LIVE
  // match — that must reach full-time UNPLAYED so the coordinator persists the live (shout-driven)
  // result; a pre-sim here would mark it played and the live persist would (correctly) skip. NOT for a
  // cup tie either — it's already played (only played ties have a recording) and there's no playFixture
  // for cup ties (the engine plays them at draw/advance time).
  if (!live && !cup) api.playFixture(fixtureId).catch(() => { /* may already be played */ });
  // Felt-tactics overlay (BACKLOG2 #1): surface the ACTIVE composite plan persistently in the viewer, seeded
  // from the team's standing plan so it's visible from kickoff (not just after a shout) — shouts update it live.
  const myTeam = await api.team().catch(() => null);
  if (myEpoch !== watchEpoch) return;   // navigated away during the fetch
  if (myTeam) watchPlayers = myTeam.players.slice(0, 11).map((p, i) => ({ id: i, name: p.name }));
  let activeDirectives: DirectiveT[] = (myTeam?.plan?.directives as DirectiveT[] | undefined) ?? [];
  // Directive overlay ("type it → see it work"): a short per-player label, mapped slot→engine-id, for the renderer toggle.
  const DIR_LABEL: Record<string, string> = {
    drift_into_pocket: 'pocket', play_between_lines: 'pocket', between_the_lines: 'pocket', drop_into_the_ten: 'pocket',
    come_short: 'come short', check_to_feet: 'come short', target_man_holdup: 'hold up', hold_it_up: 'hold up', target_man: 'hold up',
    cut_inside: 'cut in', cut_in: 'cut in', cut_inside_to_shoot: 'cut in', overlap: 'overlap', overlap_runs: 'overlap', get_on_the_overlap: 'overlap',
    run_in_behind: 'in behind', make_runs: 'make runs', get_forward: 'get fwd', stay_wide: 'stay wide', come_inside: 'invert',
    stay_central: 'central', sit_deep: 'sit deep', press_hard: 'press', contain: 'contain', tackle_hard: 'tackle hard',
    stay_on_feet: 'stay up', stay_back: 'hold', dribble_more: 'dribble', play_simple: 'keep simple', shoot_on_sight: 'shoot',
  };
  const dirShort = (k: string): string => DIR_LABEL[k] ?? k.replace(/_/g, ' ');
  const buildDirMap = (isHome: boolean): Map<number, string> => {
    const off = isHome ? 0 : 11, m = new Map<number, string>();
    for (const d of activeDirectives) {
      if (typeof d.playerId !== 'number' || d.playerId < 0 || d.playerId > 10) continue;   // per-player only (skip team-wide)
      if (!m.has(d.playerId + off)) m.set(d.playerId + off, dirShort(d.kind));   // first directive wins per player
    }
    return m;
  };
  let watchIsHome = false;   // resolved on the first frame (engine ids 0–10 home / 11–21 away)
  const refreshDirOverlay = (): void => { activeRenderer?.setDirectives(buildDirMap(watchIsHome)); };

  root.replaceChildren();
  // ── control strip ── one full-width rounded bar directly UNDER the DOM scoreboard (the renderer
  // owns that): Back · Pause · speed · ⏪10s · 10s⏩ · slider (flexes to fill, markers on top) ·
  // time/duration · ● LIVE · ⋯ · weather/recorded chips. Nothing floats over anything any more.
  // Everything secondary (tactics overlay, highlights tour, goal replay) lives behind one ⋯ menu.
  // ● LIVE — shown only while rewound; jumps back to the live edge (▶ Resume on a re-sim).
  const goLiveBtn = h('button', { class: 'primary small', style: 'display:none', 'aria-label': 'Resume live', title: 'Jump back to the live edge', onclick: () => resumeLive() }, '● LIVE') as HTMLButtonElement;
  // The slider is THE navigation control: drag to any moment (recorded = backend random access; live/re-sim =
  // the client buffer). It spans the REAL match length once known (durationMs from a recording) — not a fixed
  // 96' with a dead tail; markers recompute when the range tightens.
  const SCRUB_MAX_MS = 96 * 60 * 1000;    // fallback until the real duration is known (live: the match is still growing)
  let scrubMaxMs = SCRUB_MAX_MS;
  let scrubMinMs = 0;                     // live watches raise this to the oldest BUFFERED frame (the rewind window)
  let scrubbing = false;
  let currentMs = 0;                      // the live playhead (each frame's clockMs) — drives ⏪/⏩
  let knownDurationMs: number | null = null;   // a recording's real length → the label reads "cur / total"
  const fmtClock = (ms: number): string => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const scrubLabel = h('span', { class: 'muted', style: "display:none;font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap" }, '0:00');
  const paintScrubLabel = (ms: number): void => {
    scrubLabel.textContent = knownDurationMs !== null ? `${fmtClock(ms)} / ${fmtClock(knownDurationMs)}` : fmtClock(ms);
  };
  const scrubEl = h('input', { type: 'range', min: '0', max: String(SCRUB_MAX_MS), step: '1000', value: '0',
    style: 'width:100%;accent-color:var(--accent)', 'aria-label': 'Scrub through the match — drag to jump to any point' }) as HTMLInputElement;
  // ⚽ moment markers float over the scrub track (report timeline upfront on recorded; indexed live otherwise).
  const goalMarkers = h('div', { style: 'position:absolute;left:0;right:0;top:0;bottom:0;pointer-events:none' });
  const scrubWrap = h('div', { class: 'scrub-wrap', style: 'display:none;position:relative;align-items:center;flex:1 1 240px;min-width:150px;height:22px' }, scrubEl, goalMarkers) as HTMLElement;
  scrubEl.addEventListener('input', () => { scrubbing = true; paintScrubLabel(+scrubEl.value); });
  scrubEl.addEventListener('change', () => { seekTo(+scrubEl.value); scrubbing = false; });
  // A drag released back at its STARTING value fires no 'change' → `scrubbing` stuck true → the playhead
  // stopped tracking forever. Commit on release too (deferred a tick so a real 'change' wins; idempotent).
  const commitScrub = (): void => { setTimeout(() => { if (scrubbing) { scrubbing = false; seekTo(+scrubEl.value); } }, 0); };
  scrubEl.addEventListener('pointerup', commitScrub);
  scrubEl.addEventListener('keyup', commitScrub);
  // ⏪ / ⏩ compact jump stepper — REWIND −10/−5/−3/−2/−1s · FAST-FORWARD +1/+2/+3/+5/+10s. Each rides the
  // unified seekTo (recorded → backend random access; live → the client rewind buffer), so a rewind lands in
  // buffered history and a forward jump catches back up to the live edge. Revealed with the scrub.
  const STEP_BACK = [10, 5, 3, 2, 1];   // seconds (rewind)
  const STEP_FWD = [1, 2, 3, 5, 10];    // seconds (fast-forward)
  const mkStep = (sec: number, dir: -1 | 1): HTMLButtonElement => h('button', {
    class: 'ghost small step-btn', 'aria-label': `${dir < 0 ? 'Rewind' : 'Forward'} ${sec} seconds`,
    title: `${dir < 0 ? '−' : '+'}${sec}s`, onclick: () => seekTo(Math.max(0, currentMs + dir * sec * 1000)),
  }, `${dir < 0 ? '−' : '+'}${sec}s`) as HTMLButtonElement;
  const stepGroup = h('div', { class: 'step-group', style: 'display:none', role: 'group', 'aria-label': 'Rewind and fast-forward' },
    ...STEP_BACK.map(s => mkStep(s, -1)),
    h('span', { class: 'step-sep', 'aria-hidden': 'true' }),
    ...STEP_FWD.map(s => mkStep(s, 1)),
  ) as HTMLElement;
  // The moments the 🎞 reel + the , / . keys tour: the drama — goals, red cards, penalties, woodwork. A
  // goalless-but-eventful match (a sending-off, a saved penalty, a 0-0 that rattled the bar) now gets a
  // highlights tour, not nothing. Yellows stay as clickable scrub markers only (a 5-yellow game shouldn't
  // turn the reel into a card show). Recorded matches get these from the report timeline (analyzeRecording
  // now surfaces penalty/woodwork); a live watch indexes them from the frame events as they happen.
  let highlightIndex: { clockMs: number; name: string; kind: string }[] = [];
  let hasReportMarkers = false;   // the report timeline (full, upfront) was loaded → don't let the incremental live-marks clobber it
  let lastMarkerEvents: { clockMs: number; name: string; kind: string }[] | null = null;   // rebuilt when the scrub range tightens
  const MARKER_ICON: Record<string, string> = { goal: '⚽', yellow: '🟨', red: '🟥', penalty: '🎯', woodwork: '🪵' };
  const HIGHLIGHT_KINDS = new Set(['goal', 'red', 'penalty', 'woodwork']);
  const buildMarkers = (events: { clockMs: number; name: string; kind: string }[]): void => {
    lastMarkerEvents = events;
    highlightIndex = events.filter(e => HIGHLIGHT_KINDS.has(e.kind)).map(e => ({ clockMs: e.clockMs, name: e.name, kind: e.kind })).sort((a, b) => a.clockMs - b.clockMs);
    goalMarkers.replaceChildren();
    for (const e of events) {   // goals + cards on the timeline; click any to jump to it
      // position within the CURRENT range (live: the rewind window; recorded: 0..duration) — a moment older
      // than the window pins to the left edge (clicking it seeks the oldest buffered frame).
      const pct = Math.min(99.5, Math.max(0, ((e.clockMs - scrubMinMs) / Math.max(1, scrubMaxMs - scrubMinMs)) * 100));
      goalMarkers.append(h('span', {
        title: `${Math.floor(e.clockMs / 60000)}' — ${e.name} · click to jump`,
        style: `position:absolute;left:${pct}%;top:-2px;transform:translateX(-50%);font-size:13px;line-height:1;cursor:pointer;pointer-events:auto`,
        onclick: () => seekTo(Math.max(0, e.clockMs - 4000)),
      }, MARKER_ICON[e.kind] ?? '•'));
    }
    highlightBtn.style.display = highlightIndex.length ? '' : 'none';   // a moments-tour needs at least one goal/red
  };
  // The slider spans what you can actually REACH. Recorded: 0 → the real match length (durationMs — the old
  // fixed 96' left a dead ~6% tail + compressed markers). LIVE: the buffered rewind WINDOW (oldest buffered
  // frame → the live edge), so the whole track is real instead of 0–96' with only ~12 min of it seekable.
  // Markers recompute on a range change; the range never moves under an in-progress drag (scrubbing).
  const setScrubRange = (minMs: number, maxMs: number): void => {
    if (scrubbing || !(maxMs > minMs)) return;
    if (Math.abs(maxMs - scrubMaxMs) < 1500 && Math.abs(minMs - scrubMinMs) < 1500) return;   // dirty-check (live updates arrive ~10/s)
    scrubMinMs = Math.max(0, minMs);
    scrubMaxMs = maxMs;
    scrubEl.min = String(scrubMinMs);
    scrubEl.max = String(maxMs);
    if (lastMarkerEvents) buildMarkers(lastMarkerEvents);
  };
  const setScrubMax = (ms: number): void => setScrubRange(0, ms);
  // ⚽ Replay — appears after the first live goal; plays back the buffered run-up (instant action replay).
  const replayBtn = h('button', { class: 'primary small', style: 'display:none', 'aria-label': 'Action replay of the last goal', title: 'Action replay of the last goal' }, '⚽ Replay goal') as HTMLButtonElement;
  // 🎞 Highlights — tours every goal + red card (jumps to ~5s before each, ~11s apart). Shown once the
  // moment index is known (recorded from the report timeline; live from the indexed events). Reuses seekTo.
  const highlightBtn = h('button', { class: 'ghost small', style: 'display:none', 'aria-label': 'Play the highlights', title: 'Tour the highlights — goals, red cards, penalties, woodwork' }, '🎞 Highlights') as HTMLButtonElement;
  // §weather: the match's actual condition, set from the first frame that carries it (clear → hidden).
  const weatherEl = h('span', { class: 'chip', style: 'display:none' });
  // 📹 Recorded vs ⚙ Re-simulated: a recorded replay is faithful to the stored result; a non-recorded
  // fixture falls back to a fresh engine re-sim whose scoreline can differ from the league table. Set on
  // the first frame so the divergence is honest (this is the 4-1-here-vs-0-2-in-the-table confusion).
  const recBadge = h('span', { class: 'chip', style: 'display:none' });
  // speed — a pill GROUP (was a select) where EVERY preset actually bites: a click sends the rate to the
  // backend AND applies it locally at once (curSpeed), so it re-paces the client-side buffer playback the
  // instant you change it even while rewound (the old select only mailed the backend → invisible mid-rewind).
  // The active pill also tracks each frame's real state.speed via paintBar → paintSpeed, so it never lies.
  const SPEEDS = [0.5, 1, 2, 4, 8];   // 0.5× slow-mo for detail (backend clamps [0.25,60]); 8× to skip ahead
  let paused = false;
  let curSpeed = 1;                   // last speed reported by a frame — the one true playback rate
  const speedPills = SPEEDS.map(v => h('button', {
    class: 'spd-pill small' + (v === 1 ? ' on' : ''), 'data-s': String(v),
    'aria-label': `${v}× speed`, 'aria-pressed': String(v === 1), title: `${v}× playback`,
  }, `${v}×`) as HTMLButtonElement);
  const paintSpeed = (v: number): void => {
    speedPills.forEach((btn, i) => { const on = SPEEDS[i] === v; btn.classList.toggle('on', on); btn.setAttribute('aria-pressed', String(on)); });
  };
  const setSpeed = (v: number): void => {
    curSpeed = v;   // apply immediately — re-paces the buffer playback even while rewound (replaying)
    activeWs?.send(JSON.stringify({ type: 'speed', value: v }));
    paintSpeed(v);
  };
  speedPills.forEach((btn, i) => btn.addEventListener('click', () => setSpeed(SPEEDS[i])));
  const speedGroup = h('div', { class: 'spd-pills', role: 'group', 'aria-label': 'Playback speed' }, ...speedPills);
  // Pause ↔ Resume — distinct pause/resume commands (every stream handles 'resume' now, so no more
  // per-mode toggle protocol). Pausing also freezes the client-side buffer playback when rewound
  // (step() holds while paused). The local state is RECONCILED from each frame's matchState (below),
  // so a refused command (spectator seat) or another manager's pause can't leave the button lying.
  let pauseClickedAt = 0;   // grace window: in-flight pre-click frames must not flap the just-clicked state back
  const pauseBtn = h('button', { class: 'ghost small', 'aria-label': 'Pause or resume playback', 'aria-pressed': 'false', onclick: () => {
    paused = !paused;
    pauseClickedAt = performance.now();
    activeWs?.send(JSON.stringify({ type: paused ? 'pause' : 'resume' }));
    pauseBtn.textContent = paused ? '▶ Resume' : '⏸ Pause';
    paintBar();
  } }, '⏸ Pause') as HTMLButtonElement;
  const paintBar = (s?: number): void => {
    if (typeof s === 'number' && SPEEDS.includes(s)) {
      curSpeed = s;
      paintSpeed(s);   // reflect the frame's real playback rate on the pills (don't churn if already matching)
    }
    pauseBtn.classList.toggle('primary', paused); pauseBtn.classList.toggle('ghost', !paused); pauseBtn.setAttribute('aria-pressed', String(paused));
  };
  // 🎯 directive overlay toggle — surface each player's active tactical instruction on the pitch ("see it work")
  let dirOn = false;
  const dirBtn = h('button', { class: 'ghost small', 'aria-label': 'Toggle the on-pitch tactics overlay', 'aria-pressed': 'false', title: 'Show each player’s active tactical instruction on the pitch' },
    '\u{1F3AF} Tactics') as HTMLButtonElement;
  dirBtn.addEventListener('click', () => {
    dirOn = !dirOn;
    activeRenderer?.setShowDirectives(dirOn);
    dirBtn.classList.toggle('primary', dirOn);
    dirBtn.classList.toggle('ghost', !dirOn);
    dirBtn.setAttribute('aria-pressed', String(dirOn));
  });
  // 📊 Match-stats overlay — FM-style live analysis (sorted player ratings + a shot map + an xG race),
  // on-demand from ⋯, refreshed ~1.5s while open, body-appended + torn down centrally (teardownWatch).
  const statsBtn = h('button', { class: 'ghost small', 'aria-label': 'Toggle match stats', 'aria-pressed': 'false', title: 'Live player ratings, shot map & xG race' }, '📊 Stats') as HTMLButtonElement;
  let statsContent: HTMLElement | null = null;
  const closeStats = (): void => {
    if (watchStatsTimer) { clearInterval(watchStatsTimer); watchStatsTimer = null; }
    watchStatsPanel?.remove(); watchStatsPanel = null; statsContent = null;
    statsBtn.classList.remove('primary'); statsBtn.classList.add('ghost'); statsBtn.setAttribute('aria-pressed', 'false');
  };
  const ratTint = (r: number): string => r >= 7.5 ? '#57e08a' : r >= 6.5 ? '#e8edf2' : r >= 5.5 ? '#cdd6df' : '#f3b06b';
  const renderStatsPanel = (): void => {
    if (!statsContent || !activeRenderer) return;
    const names = activeRenderer.getTeamNames();
    const ratings = activeRenderer.getRatings();
    const shots = activeRenderer.getShots();
    const series = activeRenderer.getXgSeries();
    // ── live ratings, two columns, best first ──
    const ratCol = (name: string, list: typeof ratings, col: string) => h('div', { style: 'flex:1;min-width:0' },
      h('div', { style: `font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:${col};margin-bottom:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap` }, name),
      ...[...list].sort((a, b) => b.rating - a.rating).map(r => h('div', { class: 'between', style: 'font-size:11px;padding:1px 0;gap:6px' },
        h('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0' }, h('span', { class: 'muted', style: 'font-size:9px;margin-right:3px' }, r.role), shortName(r.name)),
        h('span', { style: `font-weight:700;flex:0 0 auto;color:${ratTint(r.rating)}` }, r.rating.toFixed(1)))));
    const ratingsBlock = h('div', { class: 'row', style: 'gap:12px;align-items:start;margin-bottom:8px' },
      ratCol(names.home, ratings.filter(r => r.team === 'home'), '#e77'),
      ratCol(names.away, ratings.filter(r => r.team === 'away'), '#8ab6d9'));
    // ── shot map: dots on a mini pitch, radius ∝ xG, filled = goal ──
    const sm = svgEl('svg', { viewBox: `0 0 ${PITCH_W} ${PITCH_H}`, width: '100%', style: 'display:block;background:#16331f;border-radius:6px' });
    const smStroke = { fill: 'none', stroke: '#ffffff', 'stroke-opacity': 0.18, 'stroke-width': 3 };
    sm.append(
      svgEl('rect', { x: 3, y: 3, width: PITCH_W - 6, height: PITCH_H - 6, ...smStroke }),
      svgEl('line', { x1: PITCH_W / 2, y1: 3, x2: PITCH_W / 2, y2: PITCH_H - 3, ...smStroke }),
      svgEl('circle', { cx: PITCH_W / 2, cy: PITCH_H / 2, r: 80, ...smStroke }));
    for (const sh of shots) {
      const col = sh.side > 0 ? '#e63946' : '#457b9d';
      sm.append(svgEl('circle', { cx: sh.x, cy: sh.y, r: 7 + sh.xg * 26, fill: sh.goal ? col : 'none', 'fill-opacity': sh.goal ? 0.85 : 0, stroke: col, 'stroke-width': 3.5, 'stroke-opacity': 0.9 }));
    }
    const shotBlock = h('div', {},
      h('div', { class: 'muted', style: 'font-size:10px;text-transform:uppercase;letter-spacing:.4px;margin:4px 0 3px' }, `Shot map · ${shots.length} shot${shots.length === 1 ? '' : 's'} (○ shot · ● goal · size = xG)`),
      shots.length ? sm : h('div', { class: 'muted', style: 'font-size:11px' }, 'No shots yet.'));
    // ── xG race line (cumulative per side) ──
    const lastS = series[series.length - 1];
    const xgMax = Math.max(0.5, lastS?.h ?? 0, lastS?.a ?? 0);
    const tMax = Math.max(60000, lastS?.t ?? 0);
    const CW = 300, CH = 60, pad = 4;
    const px = (t: number) => pad + (t / tMax) * (CW - 2 * pad);
    const py = (v: number) => (CH - pad) - (v / xgMax) * (CH - 2 * pad);
    const xgLine = (key: 'h' | 'a', col: string) => {
      if (!series.length) return svgEl('g', {});
      // step line: cumulative xG holds flat between shots, then jumps — the honest shape
      const pts: string[] = [`${px(0).toFixed(1)},${py(0).toFixed(1)}`];
      let prev = 0;
      for (const s of series) { pts.push(`${px(s.t).toFixed(1)},${py(prev).toFixed(1)}`, `${px(s.t).toFixed(1)},${py(s[key]).toFixed(1)}`); prev = s[key]; }
      pts.push(`${px(tMax).toFixed(1)},${py(prev).toFixed(1)}`);
      return svgEl('polyline', { points: pts.join(' '), fill: 'none', stroke: col, 'stroke-width': 2 });
    };
    const xgSvg = svgEl('svg', { viewBox: `0 0 ${CW} ${CH}`, width: '100%', style: 'display:block' },
      svgEl('line', { x1: pad, y1: CH - pad, x2: CW - pad, y2: CH - pad, stroke: '#ffffff', 'stroke-opacity': 0.15, 'stroke-width': 1 }),
      xgLine('a', '#457b9d'), xgLine('h', '#e63946'));
    const xgBlock = h('div', {},
      h('div', { class: 'muted', style: 'font-size:10px;text-transform:uppercase;letter-spacing:.4px;margin:6px 0 3px' },
        `xG race · ${(lastS?.h ?? 0).toFixed(2)} `, h('span', { style: 'color:#e77' }, names.home), ' – ', h('span', { style: 'color:#8ab6d9' }, names.away), ` ${(lastS?.a ?? 0).toFixed(2)}`),
      series.length ? xgSvg : h('div', { class: 'muted', style: 'font-size:11px' }, 'No shots yet.'));
    statsContent.replaceChildren(ratingsBlock, shotBlock, xgBlock);
  };
  statsBtn.addEventListener('click', () => {
    if (watchStatsPanel) { closeStats(); return; }
    statsBtn.classList.add('primary'); statsBtn.classList.remove('ghost'); statsBtn.setAttribute('aria-pressed', 'true');
    statsContent = h('div', {});
    watchStatsPanel = h('div', { role: 'region', 'aria-label': 'Match statistics',
      style: 'position:fixed;left:12px;bottom:74px;width:min(330px,54vw);max-height:62vh;overflow:auto;z-index:40;background:rgba(12,19,32,.97);border:1px solid var(--line);border-radius:10px;padding:10px;box-shadow:0 6px 24px rgba(0,0,0,.45)' },
      h('div', { class: 'between', style: 'margin-bottom:6px' },
        h('span', { style: 'font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted)' }, '📊 Match stats'),
        h('button', { class: 'ghost small', 'aria-label': 'Close match stats', onclick: closeStats }, '×')),
      statsContent);
    document.body.appendChild(watchStatsPanel);
    renderStatsPanel();
    watchStatsTimer = setInterval(() => { if (myEpoch !== watchEpoch) { closeStats(); return; } renderStatsPanel(); }, 1500);
  });
  // 👥 Line-ups — a two-column (home/away) roster overlay: shirt number, short name, role tag, team dot.
  // Sourced from the renderer's per-frame roster (getRatings gives id/name/team/role; shirt = id%11+1 to
  // match the on-pitch labels). Built on open (rosters are stable within a match); torn down centrally.
  const lineupsBtn = h('button', { class: 'ghost small', 'aria-label': 'Toggle line-ups', 'aria-pressed': 'false', title: 'Match line-ups (both teams)' }, '👥 Line-ups') as HTMLButtonElement;
  const closeLineups = (): void => {
    watchLineupsPanel?.remove(); watchLineupsPanel = null;
    lineupsBtn.classList.remove('primary'); lineupsBtn.classList.add('ghost'); lineupsBtn.setAttribute('aria-pressed', 'false');
  };
  const openLineups = (): void => {
    if (!activeRenderer) return;
    const names = activeRenderer.getTeamNames();
    const roster = activeRenderer.getRatings();
    const sideCol = (teamName: string, side: 'home' | 'away', dot: string) => {
      const list = roster.filter(r => r.team === side).sort((a, b) => (a.id % 11) - (b.id % 11));
      return h('div', { class: 'lu-side' },
        h('div', { class: 'lu-head' }, h('span', { class: 'lu-dot', style: `background:${dot}` }), h('span', { class: 'lu-team' }, teamName || (side === 'home' ? 'Home' : 'Away'))),
        ...(list.length ? list.map(r => h('div', { class: 'lu-row' },
          h('span', { class: 'lu-no' }, String((r.id % 11) + 1)),
          h('span', { class: 'lu-nm' }, shortName(r.name)),
          h('span', { class: 'lu-rl' }, r.role))) : [h('div', { class: 'muted', style: 'font-size:11px' }, 'Awaiting kick-off…')]));
    };
    const panel = h('div', { role: 'region', 'aria-label': 'Line-ups', class: 'watch-lineups' },
      h('div', { class: 'between', style: 'margin-bottom:8px' },
        h('span', { style: 'font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted)' }, '👥 Line-ups'),
        h('button', { class: 'ghost small', 'aria-label': 'Close line-ups', onclick: closeLineups }, '×')),
      h('div', { class: 'lu-cols' }, sideCol(names.home, 'home', '#e63946'), sideCol(names.away, 'away', '#4b93c9')));
    document.body.appendChild(panel);
    watchLineupsPanel = panel;
  };
  lineupsBtn.addEventListener('click', () => {
    if (watchLineupsPanel) { closeLineups(); return; }
    openLineups();
    lineupsBtn.classList.add('primary'); lineupsBtn.classList.remove('ghost'); lineupsBtn.setAttribute('aria-pressed', 'true');
  });
  // ⋯ — everything secondary in ONE place (tactics overlay, match stats, line-ups, highlights tour, live goal
  // replay), so the bar itself stays: pause · speed · ⏪/⏩ · slider · ● LIVE. Items keep their own show/hide logic.
  const morePop = h('div', { style: 'display:none;position:absolute;top:100%;right:0;margin-top:6px;z-index:41;background:rgba(12,19,32,.96);border:1px solid var(--line);border-radius:8px;padding:6px;flex-direction:column;gap:6px;min-width:160px' },
    dirBtn, statsBtn, lineupsBtn, highlightBtn, replayBtn) as HTMLElement;
  const moreBtn = h('button', { class: 'ghost small', 'aria-label': 'More controls', 'aria-haspopup': 'true', 'aria-expanded': 'false', title: 'More — tactics overlay, highlights, goal replay' }, '⋯') as HTMLButtonElement;
  moreBtn.addEventListener('click', () => {
    const open = morePop.style.display === 'none';
    morePop.style.display = open ? 'flex' : 'none';
    moreBtn.setAttribute('aria-expanded', String(open));
    moreBtn.classList.toggle('primary', open); moreBtn.classList.toggle('ghost', !open);
  });
  const moreWrap = h('div', { style: 'position:relative' }, moreBtn, morePop);
  // status chips (weather + recorded/live) pinned to the bar's right edge even while the slider is hidden
  const chipGroup = h('div', { style: 'margin-left:auto;display:flex;gap:8px;align-items:center' }, weatherEl, recBadge);
  const bar = h('div', { class: 'watch-bar' },
    h('button', { class: 'ghost small', onclick: () => { location.hash = '#/'; } }, '← Back'),
    pauseBtn,
    speedGroup,
    stepGroup,
    scrubWrap,
    scrubLabel,
    goLiveBtn,
    moreWrap,
    chipGroup,
  );
  document.body.appendChild(bar);
  watchBar = bar;
  // P3 viewer keyboard shortcuts: space = pause/resume, ←/→ = seek ∓10s (Shift+←/→ = fine ∓2s),
  // , / . = prev/next moment (goal or red card). Seek-keys are no-ops on a live match (the coordinator
  // ignores seek) + before a moment index is loaded. Removed in teardownWatch. Ignored while typing a shout.
  watchKeyHandler = (e: KeyboardEvent): void => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const step = e.shiftKey ? 2000 : 10000;   // Shift = a fine 2s nudge for landing on a specific touch
    if (e.key === ' ') { e.preventDefault(); pauseBtn.click(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); seekTo(Math.max(0, currentMs - step)); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); seekTo(currentMs + step); }
    else if (e.key === ',' || e.key === '.') {
      if (!highlightIndex.length) return;
      const target = e.key === '.'
        ? highlightIndex.find(g => g.clockMs > currentMs + 1500)
        : [...highlightIndex].reverse().find(g => g.clockMs < currentMs - 1500);
      if (target) { e.preventDefault(); seekTo(Math.max(0, target.clockMs - 4000)); }
    }
  };
  window.addEventListener('keydown', watchKeyHandler);

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
  // Ctrl/Cmd+Enter applies the shout (same as the Apply button) — keep your hands on the keyboard mid-match.
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); applyPlan(); }
  });
  const showReceipt = (r: TacticsReceipt) => {
    receiptEl.replaceChildren();
    if (r.error) { receiptEl.appendChild(h('div', { class: 'warn' }, '⚠ ' + r.error)); return; }
    if (r.formation) receiptEl.appendChild(h('div', { class: 'ok' }, `✓ Shape → ${r.formation}`));
    const note = (r.note ?? '').trim();
    const changed = (r.changed ?? '').trim();
    const motivation: MotivationReaction[] = Array.isArray(r.motivation) ? r.motivation : [];
    const dirs: DirectiveT[] = r.plan?.directives ?? r.directives ?? [];
    // The persistent "Active tactics" strip owns the full directive list — update it from this shout's plan.
    if (r.plan?.directives) { activeDirectives = r.plan.directives; renderActivePlan(); refreshDirOverlay(); }
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
  // Shouts apply ON THE TICK — only a LIVE match (⚡ Play LIVE / the resident coordinator) honours them.
  // A replay, a re-sim (?shouts=1) or a quick-watch is finished/deterministic playback, so an editable
  // shout box there is meaningless (and misleading). Live → the full interactive panel; otherwise a
  // compact column holding the match stats + a dismissible one-line tip (G2 — was editable on past matches).
  // The right column's top slot hosts the renderer's stats block (ON-TGT/xG/BIG-CH/CORNERS + PRESSURE) —
  // it used to float over the scoreboard and the timeline at top-left.
  const statsHost = h('div', { class: 'watch-stats' });
  const TIP_KEY = 'footy:watch-tip-dismissed';
  let tipDismissed = false;
  try { tipDismissed = localStorage.getItem(TIP_KEY) === '1'; } catch { /* storage unavailable → just show it */ }
  const tipRow = h('div', { class: 'watch-tip' },
    h('span', { style: 'flex:1 1 auto;min-width:0' }, '💡 Shouts are live-only — use ⚡ Play LIVE to steer a match in real time.'),
    h('button', { class: 'ghost small', 'aria-label': 'Dismiss this tip', title: 'Dismiss',
      onclick: () => { tipRow.remove(); try { localStorage.setItem(TIP_KEY, '1'); } catch { /* */ } } }, '×'));
  const panel = live
    ? h('div', { class: 'tactics-panel' },
        statsHost,
        planEl,
        h('div', { class: 'tactics-row' }, ta, h('button', { class: 'primary small', title: 'Apply your shout (Ctrl+Enter)', onclick: applyPlan }, 'Apply')),
        receiptEl,
      )
    : h('div', { class: 'tactics-panel compact' }, statsHost, ...(tipDismissed ? [] : [tipRow]));
  document.body.appendChild(panel);
  watchPanel = panel;

  // ⚽ goal markers (replays only): pull the report timeline so every goal is known upfront — you can
  // jump to one before playback reaches it. Best-effort: another club's match has no report → no markers,
  // the scrub still works. The markers only show once the scrub is revealed (a recorded replay).
  if (!live) {
    api.report(fixtureId, cup).then(rep => {
      if (myEpoch !== watchEpoch) return;
      const events = (rep.facts?.timeline ?? [])
        .filter(e => e.type === 'goal' || e.type === 'yellow' || e.type === 'red' || e.type === 'penalty' || e.type === 'woodwork')
        // EXACT event clock when the report carries it. The display minute is floor(ms/60000)+1, so the old
        // minute*60000 mapping overshot by up to 60s — every recorded jump-to-goal landed AFTER the goal
        // (you saw the celebration, never the shot). Old cached reports (no clockMs) fall back to the START
        // of the display minute, so the −4s pre-roll can never land past the moment.
        .map(e => ({ clockMs: typeof e.clockMs === 'number' ? e.clockMs : Math.max(0, ((e.minute ?? 1) - 1) * 60000), name: e.name, kind: e.type }));
      if (events.length) { buildMarkers(events); hasReportMarkers = true; }   // full upfront set → suppress the incremental live-marks (which reassign wholesale)
    }).catch(() => { /* no report (re-sim / another club) → scrub without markers (falls back to live-marks) */ });
  }

  const renderer = new MatchRenderer();
  activeRenderer = renderer;
  await renderer.init();
  // If the user navigated away (or to another match) during the async init, this screen is stale:
  // teardownWatch already ran — destroy this orphan renderer and stop before opening a socket.
  if (myEpoch !== watchEpoch) { renderer.destroy(); return; }
  // Dock the renderer's live-stats block into the right column's top slot (it renders detached until then).
  renderer.dockStats(statsHost);

  // Keep the pitch clear of every panel: reserve the TOP for the scoreboard + control bar (measured —
  // the bar wraps on narrow viewports), and the panel's height/width at bottom/right. Wide screens dock
  // the panel RIGHT (reserve width → the pitch keeps full height); narrow screens (≤860px, matching the
  // CSS media query that bottom-docks it) reserve its height. Hidden (replay) → free both. The pitch
  // always claims the remaining space, so it can no longer collapse to a thumbnail behind full-size panels.
  const syncReserve = () => {
    const hudBottom = renderer.hudElement?.getBoundingClientRect().bottom ?? 0;
    const barBottom = bar.getBoundingClientRect().bottom;
    renderer.setReservedTop(Math.max(hudBottom, barBottom) + 6);
    const visible = panel.style.display !== 'none' && panel.offsetWidth > 0;
    if (!visible) { renderer.setReservedRight(0); renderer.setReservedBottom(8); panel.style.top = ''; return; }
    if (window.innerWidth > 860) {
      panel.style.top = `${Math.round(barBottom) + 8}px`;   // the right column starts under the control bar
      renderer.setReservedRight(panel.offsetWidth + 24);
      renderer.setReservedBottom(8);
    } else {
      panel.style.top = '';                                  // CSS bottom-docks it ≤860px
      renderer.setReservedRight(0);
      renderer.setReservedBottom(panel.offsetHeight + 24);
    }
  };
  watchPanelObs = new ResizeObserver(syncReserve);
  watchPanelObs.observe(panel);
  watchPanelObs.observe(bar);   // the bar wraps/unwraps with viewport width → re-measure the top reserve
  syncReserve();

  // Connecting overlay — the canvas is otherwise a blank dark void until the first frame
  // arrives (and silently stays one if the match never starts). Cleared on the first frame.
  const status = h('div', { class: 'watch-status' }, h('div', { class: 'spin' }, 'Connecting to match…'));
  document.body.appendChild(status);
  watchStatus = status;
  const showStatusError = (msg: string) => {
    if (myEpoch !== watchEpoch) return;   // superseded — don't resurrect an overlay teardown removed
    // Once the first frame arrived, `status` was removed from the DOM (see `status.remove()`). A later
    // mid-stream error (e.g. a failed re-sim) must re-attach it, or the message is written to a detached
    // node and the user sees nothing while the pitch freezes.
    if (!status.isConnected) { document.body.appendChild(status); watchStatus = status; }
    status.replaceChildren(
      h('div', { class: 'err' }, msg),
      h('button', { class: 'ghost small', onclick: () => { location.hash = '#/'; } }, '← Back'),
    );
    status.style.display = '';
  };

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const wsQuery = cup ? `cup=${fixtureId}` : `fixture=${fixtureId}${shouts ? '&shouts=1' : ''}${live ? '&live=1' : ''}`;
  const ws = new WebSocket(`${proto}://${location.host}/ws/match?${wsQuery}`);
  activeWs = ws;
  let replayUiApplied = false;
  let gotFrame = false;
  // ── live goal replay: buffer recent frames; on a goal, snapshot the run-up + offer an instant replay ──
  const GOAL_CLIP = 130;                       // frames of run-up to keep (~several seconds before the goal)
  const LIVE_BUFFER_MAX = 7200;                // ~12 min of rewind at the ~10fps thinned rate (bounds memory ~35MB)
  const liveBuffer: WatchMessage[] = [];
  const liveMarks: { clockMs: number; name: string; kind: string }[] = [];   // goal/card markers indexed live (no report)
  const seenMarkKeys = new Set<string>();   // dedup live markers per EVENT (events linger ~78 frames), not per frame
  let goalClip: WatchMessage[] | null = null;
  let replaying = false;
  let hiddenLatest: WatchMessage | null = null;   // newest frame skipped while the tab was hidden — synced once on return
  // ── live rewind (viewer #1) ── a live watch (re-sim or coordinator) has NO backend seek — frames are
  // generated on the fly. So buffer them client-side + let the scrub / ⏪ / ⏮ play BACK through the buffer
  // (real-time paced) and catch up to live; ● LIVE resumes. Additive: a live watch with no rewind action is
  // untouched. A RECORDED replay keeps using the backend seek (full random access). `replaying` gates the
  // live-frame render in onmessage (frames keep buffering while you're rewound).
  let liveSeek = false;   // a live watch has buffered enough → route the scrub/rewind to the buffer
  let playbackGen = 0;    // bumped per buffer-playback start → invalidates any prior step() chain (re-entrant safety)
  // A goal clip's ⚽ button reset used to live ONLY in the clip's own completion branch — any seek/resume that
  // cleared the shared timer externally stranded it disabled on "⏵ Replaying…" forever. Idempotent, so every
  // supersession path (seek → startBufferPlayback, ● LIVE → resumeLive) just calls it.
  const resetClipButton = (): void => { replayBtn.disabled = false; replayBtn.textContent = '⚽ Replay goal'; };
  const resumeLive = (): void => {
    if (myEpoch !== watchEpoch) return;   // a stale callback must not touch the new watch's renderer/controls
    replaying = false;
    if (activeReplayTimer) { clearTimeout(activeReplayTimer); clearInterval(activeReplayTimer); activeReplayTimer = null; }
    resetClipButton();
    activeRenderer?.setReplay(false);
    goLiveBtn.style.display = 'none';
    if (activeRenderer && liveBuffer.length) {
      const f = liveBuffer[liveBuffer.length - 1];
      activeRenderer.sync(f);
      if (typeof f.clockMs === 'number') { currentMs = f.clockMs; if (!scrubbing) { scrubEl.value = String(f.clockMs); paintScrubLabel(f.clockMs); } }
    }
  };
  const startBufferPlayback = (startIdx: number): void => {
    if (!activeRenderer || !liveBuffer.length) return;
    const myGen = ++playbackGen;            // a fresh re-scrub invalidates any in-flight step() chain
    replaying = true;                       // gate the live-frame render (onmessage keeps buffering)
    resetClipButton();                      // a seek supersedes a goal clip — never leave ⚽ stuck on "⏵ Replaying…"
    // Suppress the live GOAL / HALF-TIME banner while replaying buffered frames FORWARD across a rewind —
    // else crossing a goal during the rewind re-pops "GOAL!" though none was scored. setReplay only sets the
    // suppression flag; the "⚽ GOAL REPLAY" overlay is playClip's separate doing, so a PLAIN rewind still
    // shows no overlay (that stays playClip's job). resumeLive() clears the flag.
    activeRenderer.setReplay(true);
    // The resume button reads ● LIVE only on a TRUE live match; on a re-sim it's "▶ Resume" (no live edge).
    // The button's presence is the rewound indicator.
    goLiveBtn.textContent = live ? '● LIVE' : '▶ Resume';
    goLiveBtn.title = live ? 'Jump back to the live edge' : 'Resume to the latest point';
    goLiveBtn.style.display = '';
    // SNAPSHOT the playback range. onmessage keeps push+shift()ing liveBuffer while we play (at the 7200-frame
    // cap — i.e. past ~12 buffered minutes — every arriving frame evicts the head), so indexing the LIVE array
    // slid frames under the cursor: rewound playback ran ~2× with every other frame skipped and slammed back
    // into the live edge early. The slice shares frame references (no copy of the frames themselves); when it's
    // exhausted, resumeLive() syncs to the TRUE current live edge anyway.
    const clip = liveBuffer.slice(Math.max(0, Math.min(startIdx, liveBuffer.length - 1)));
    let i = 0;
    if (activeReplayTimer) { clearTimeout(activeReplayTimer); clearInterval(activeReplayTimer); activeReplayTimer = null; }
    const step = (): void => {
      if (myEpoch !== watchEpoch || !activeRenderer || !replaying || myGen !== playbackGen) return;   // navigated / torn down / resumed / superseded
      if (paused) { activeReplayTimer = setTimeout(step, 150); return; }   // ⏸ freezes the buffer playback too (was: button said paused, pitch kept moving)
      if (i >= clip.length - 1) { resumeLive(); return; }  // played the snapshot out → follow live from the current edge
      const f = clip[i];
      activeRenderer.sync(f);
      if (typeof f.clockMs === 'number' && !scrubbing) { currentMs = f.clockMs; scrubEl.value = String(f.clockMs); paintScrubLabel(f.clockMs); }
      const cur = f.clockMs ?? 0, nxt = clip[i + 1]?.clockMs ?? cur + 250;
      i++;
      // paced by the frame deltas SCALED by the chosen speed (was: real-time only — the speed control
      // silently did nothing while rewound). curSpeed tracks the last frame's actual state.speed.
      activeReplayTimer = setTimeout(step, Math.max(16, Math.min((nxt - cur) / Math.max(0.25, curSpeed), 1000)));
    };
    step();
  };
  const seekLiveBuffer = (targetMs: number): void => {
    if (!liveBuffer.length) return;
    const lastMs = liveBuffer[liveBuffer.length - 1].clockMs ?? 0;
    if (targetMs >= lastMs - 300) { resumeLive(); return; }     // at/after the live edge → just follow live
    let idx = liveBuffer.findIndex(f => (f.clockMs ?? 0) >= targetMs);
    if (idx < 0) idx = 0;
    startBufferPlayback(idx);
  };
  // unified seek: a recorded replay seeks the backend (full random access); a live watch seeks the buffer.
  let pendingSeekMs: number | null = null;   // a backend seek is in flight — drop pre-seek frames so the pitch/thumb don't flick back first
  let pendingSeekAt = 0;
  const seekTo = (targetMs: number): void => {
    if (liveSeek) { seekLiveBuffer(targetMs); return; }
    if (!replayUiApplied) return;   // a live re-sim before its buffer is ready / a non-seekable stream: nothing to backend-seek (avoid a dead send)
    pendingSeekMs = Math.max(0, targetMs); pendingSeekAt = performance.now();
    activeWs?.send(JSON.stringify({ type: 'seek', value: Math.max(0, targetMs) }));
    // ReplayStream.seekTo() force-resumes the backend, so re-sync the local pause label — else the Pause
    // button inverts (reads "▶ Resume" while the match visibly plays, and needs two clicks to recover).
    if (paused) { paused = false; pauseBtn.textContent = '⏸ Pause'; paintBar(); }
  };
  // 🎞 highlights reel: tour every goal + red card — seek to ~5s before each, ~11s apart. Reuses seekTo (so
  // it rides the recorded backend-seek, or the live buffer). Stops on click, at the end, or on navigation
  // (epoch). The timer is module-level (activeHighlightTimer) so teardownWatch can cancel a pending tour step.
  const stopHighlights = (): void => {
    if (activeHighlightTimer) { clearTimeout(activeHighlightTimer); activeHighlightTimer = null; }
    highlightBtn.textContent = '🎞 Highlights'; highlightBtn.classList.add('ghost'); highlightBtn.classList.remove('primary');
  };
  const playHighlights = (): void => {
    if (!highlightIndex.length) return;
    let gi = 0;
    highlightBtn.textContent = '⏹ Stop'; highlightBtn.classList.add('primary'); highlightBtn.classList.remove('ghost');
    const next = (): void => {
      if (myEpoch !== watchEpoch || gi >= highlightIndex.length) { stopHighlights(); return; }
      seekTo(Math.max(0, highlightIndex[gi].clockMs - 5000));
      gi++;
      activeHighlightTimer = setTimeout(next, 11000);
    };
    next();
  };
  highlightBtn.onclick = () => { if (activeHighlightTimer) stopHighlights(); else playHighlights(); };
  const playClip = () => {
    if (myEpoch !== watchEpoch || replaying || !goalClip || !goalClip.length || !activeRenderer) return;
    stopHighlights();   // the tour and a goal clip are mutually exclusive — don't let an 11s tour-step seek mid-clip
    replaying = true;
    activeRenderer.setReplay(true);   // GOAL-REPLAY banner — ONLY here (an actual goal replay), not plain rewind
    replayBtn.disabled = true; replayBtn.textContent = '⏵ Replaying…';
    const clip = goalClip;
    let i = 0;
    playbackGen++;   // supersede any live-rewind step() chain (shared activeReplayTimer)
    if (activeReplayTimer) { clearTimeout(activeReplayTimer); clearInterval(activeReplayTimer); activeReplayTimer = null; }   // a live-rewind timer is a setTimeout — clear BOTH
    activeReplayTimer = setInterval(() => {
      if (myEpoch !== watchEpoch || !activeRenderer || i >= clip.length) {          // navigated / torn down / clip done
        if (activeReplayTimer) { clearInterval(activeReplayTimer); activeReplayTimer = null; }
        replaying = false;
        activeRenderer?.setReplay(false);   // drop the overlay + resume live goal banners
        resetClipButton();
        if (activeRenderer && liveBuffer.length) { const lf = liveBuffer[liveBuffer.length - 1]; activeRenderer.sync(lf); if (typeof lf.clockMs === 'number' && !scrubbing) { currentMs = lf.clockMs; scrubEl.value = String(lf.clockMs); paintScrubLabel(lf.clockMs); } }   // snap back to live
        return;
      }
      const cf = clip[i];
      activeRenderer.sync(cf);   // the score/clock rewinds through the clip, then snaps forward to live
      if (typeof cf.clockMs === 'number' && !scrubbing) { currentMs = cf.clockMs; scrubEl.value = String(cf.clockMs); paintScrubLabel(cf.clockMs); }   // keep the scrub tracking during the clip
      i++;
    }, 45);
  };
  replayBtn.addEventListener('click', playClip);
  // Background-tab policy: while hidden, a throttled (≥1s) replay timer would crawl a rewind/goal-clip at
  // ~1fps AND hold `replaying` so nothing live draws on return — jump back to live instead. On return,
  // sync the newest frame we skipped so the pitch is current the instant the tab is visible again.
  watchVisHandler = (): void => {
    if (myEpoch !== watchEpoch) return;
    if (document.hidden) { if (replaying) resumeLive(); return; }
    if (hiddenLatest && activeRenderer) { const f = hiddenLatest; hiddenLatest = null; renderer.sync(f); paintBar(f.speed); }
  };
  document.addEventListener('visibilitychange', watchVisHandler);
  ws.onmessage = (ev) => {
    if (myEpoch !== watchEpoch) return;   // navigated away — a queued frame must not sync() the now-destroyed renderer or touch detached DOM (matches the guards at the api callsites)
    try {
      const msg = JSON.parse(ev.data) as WatchMessage;
      if (msg.error) { showStatusError(msg.error); return; }   // re-sim failed (e.g. replay-from-shouts)
      // A backend seek is in flight: frames sent BEFORE the backend processed it would flick the pitch +
      // thumb back to the pre-seek position for a beat. Drop them until a frame lands near the target
      // (or the gate times out — accept whatever streams then, e.g. a seek past the end re-sends the tail).
      if (pendingSeekMs !== null && typeof msg.clockMs === 'number') {
        if (Math.abs(msg.clockMs - pendingSeekMs) <= 2500 || performance.now() - pendingSeekAt > 2000) pendingSeekMs = null;
        else return;
      }
      // Reconcile pause from the stream's own state: a refused command (spectator seat on a live match),
      // another manager pausing, or a backend force-resume can all desync the local flag — the frame is
      // the truth. Grace window after a local click so in-flight pre-click frames don't flap it back.
      // NOT while rewound (`replaying`): there the local pause governs the BUFFER playback, and the live
      // feed's 'running' state must not resume it out from under the viewer.
      if (typeof msg.matchState === 'string' && !replaying && performance.now() - pauseClickedAt > 1200) {
        const srvPaused = msg.matchState === 'paused';
        if (srvPaused !== paused) { paused = srvPaused; pauseBtn.textContent = paused ? '▶ Resume' : '⏸ Pause'; paintBar(msg.speed); }
      }
      // A replayed recording is finished playback: reveal the rewind/scrub/back-10s controls. The shout
      // box is already gone (the panel is the read-only live-only note when !live), so keep the note visible.
      if (msg.replay && !replayUiApplied) {
        replayUiApplied = true; stepGroup.style.display = 'flex'; scrubWrap.style.display = 'inline-flex'; scrubLabel.style.display = ''; syncReserve();
        // deep-link (#/watch/id?t=ms — e.g. a report-timeline click): jump straight to the moment once seekable
        if (startMs > 0) { seekTo(Math.max(0, startMs)); startMs = 0; }
      }
      // a recording knows its real length → the slider spans the actual match, not a fixed 96',
      // and the time label can read "current / total"
      if (typeof msg.durationMs === 'number') { knownDurationMs = msg.durationMs; setScrubMax(msg.durationMs + 1000); }
      // Track the playhead while FOLLOWING (a recorded replay, or a live watch at the edge) — but not while
      // dragging, and not while rewound (`replaying`: the buffer-playback loop owns the playhead then).
      if ((replayUiApplied || liveSeek) && !replaying && typeof msg.clockMs === 'number') {
        currentMs = msg.clockMs;
        if (!scrubbing) { scrubEl.value = String(msg.clockMs); paintScrubLabel(msg.clockMs); }
      }
      if (msg.tacticsReceipt) { showReceipt(msg.tacticsReceipt); return; }
      if (Array.isArray(msg.players)) watchPlayers = msg.players.map(p => ({ id: p.id, name: p.name }));
      if (!gotFrame) {
        gotFrame = true; status.remove(); watchStatus = null; watchIsHome = msg.homeName === myTeam?.name; refreshDirOverlay();
        if (live) { recBadge.textContent = '🔴 LIVE'; recBadge.title = 'Live match — the result counts.'; }
        else if (shouts) { recBadge.textContent = '⚙ Re-sim'; recBadge.title = 'Re-simulated from your shouts.'; }
        else if (msg.replay) { recBadge.textContent = '📹 Recorded'; recBadge.title = 'A faithful recording of how this match was played.'; }
        else { recBadge.textContent = '⚙ Re-simulated'; recBadge.title = 'Not recorded — re-simulated on the latest engine, so the scoreline may differ from the league table.'; }
        recBadge.style.display = '';   // hidden until it has something to say (an empty chip renders as a stray pill)
      }
      // §weather: show the match's condition once (clear stays hidden — only the notable conditions show)
      if (msg.weather && msg.weather !== 'clear' && !weatherEl.textContent) {
        weatherEl.textContent = msg.weather === 'rain' ? '🌧 Rain' : '🌬 Wind';
        weatherEl.title = msg.weather === 'rain' ? 'Wet pitch — the ball skids further' : 'Windy — long balls and crosses drift';
        weatherEl.style.display = '';
      }
      // felt-tactics: live possession in the active-plan strip (YOUR share — flip it when you're the away side)
      if (typeof msg.possessionPct === 'number' && myTeam && msg.homeName) {
        const mine = msg.homeName === myTeam.name ? msg.possessionPct : 100 - msg.possessionPct;
        possEl.textContent = `Possession ${Math.round(mine)}%`;
      }
      // buffer live frames (a recorded replay has its own backend rewind/seek). The buffer powers BOTH the
      // goal replay AND the live rewind (viewer #1) — keep ~a full match so you can rewind to any of it.
      if (!msg.replay && Array.isArray(msg.players)) {
        // Thin the rewind buffer to ~10fps (the renderer interpolates, so playback stays smooth) — this bounds
        // memory AND gives a predictable ~12-min rewind window regardless of the raw live frame rate (~37fps).
        // Always keep a goal frame (for the run-up + marker). The LIVE render below is unthinned (full fps).
        const lastBuf = liveBuffer[liveBuffer.length - 1];
        const goalFrame = !!(msg.events && msg.events.some(e => e.type === 'goal'));
        const dueByTime = !lastBuf || typeof msg.clockMs !== 'number' || typeof lastBuf.clockMs !== 'number' || Math.abs(msg.clockMs - lastBuf.clockMs) >= 100;
        if (goalFrame || dueByTime) {
          liveBuffer.push(msg);
          if (liveBuffer.length > LIVE_BUFFER_MAX) liveBuffer.shift();
        }
        // ⚽ Replay-goal (with its GOAL-REPLAY banner) is a TRUE-live-only control — on a re-sim it'd raise
        // the banner inappropriately; re-sim users jump to goals via the markers instead. (P0 bug-fix #6.)
        if (goalFrame) {
          goalClip = liveBuffer.slice(-GOAL_CLIP);
          // the ⚽ Replay item lives in the ⋯ menu now — light the ⋯ up so a fresh goal replay is discoverable
          if (live) { replayBtn.style.display = ''; if (morePop.style.display === 'none') { moreBtn.classList.add('primary'); moreBtn.classList.remove('ghost'); } }
        }
        // live goal/card markers — a stream with NO upfront report (a true live match; a re-sim of a
        // report-less fixture) indexes events as they happen so the scrub shows ⚽/🟨/🟥 + jump + , / . +
        // highlights mid-game. SKIP when the report already supplied the full timeline (recorded, and now the
        // buffered shouts-replay) — else buildMarkers(liveMarks) reassigns wholesale and clobbers the full set.
        const marks = hasReportMarkers ? [] : (msg.events ?? []).filter(e => e.type === 'goal' || e.type === 'yellow' || e.type === 'red' || e.type === 'penalty' || e.type === 'woodwork');
        if (marks.length && typeof msg.clockMs === 'number') {
          let added = false;
          for (const e of marks) {
            // An engine event lingers ~2600ms in the feed (~78 frames at 30fps), so pushing per-frame stacks
            // ~78 duplicate markers per goal (breaking highlights + ,/. nav). Dedup per EVENT with the same key
            // the renderer's ticker uses (type:player:evClock/400 — evClock = frameClock − age).
            const evClock = msg.clockMs - (e.age ?? 0);
            const key = `${e.type}:${e.playerId}:${Math.round(evClock / 400)}`;
            if (seenMarkKeys.has(key)) continue;
            seenMarkKeys.add(key);
            liveMarks.push({ clockMs: evClock, name: e.playerId != null ? pname(e.playerId) : (e.type === 'goal' ? 'Goal' : e.type === 'red' ? 'Red card' : e.type === 'penalty' ? 'Penalty' : e.type === 'woodwork' ? 'Woodwork' : 'Booking'), kind: e.type });
            added = true;
          }
          if (added) buildMarkers(liveMarks);
        }
        // reveal the rewind/scrub controls for a LIVE watch once there's enough buffered to seek within
        if (!liveSeek && liveBuffer.length >= 8) { liveSeek = true; stepGroup.style.display = 'flex'; scrubWrap.style.display = 'inline-flex'; scrubLabel.style.display = ''; syncReserve(); }
        // the live slider spans the actual rewind WINDOW (oldest buffered → the live edge) — the whole track
        // is reachable, instead of a fixed 96' where only the last ~12 buffered minutes meant anything.
        // setScrubRange dirty-checks (1.5s) + never moves the range mid-drag, so this is cheap per push.
        if (liveSeek) {
          const oldest = liveBuffer[0]?.clockMs, newest = liveBuffer[liveBuffer.length - 1]?.clockMs;
          if (typeof oldest === 'number' && typeof newest === 'number') setScrubRange(oldest, Math.max(newest, oldest + 30000));
        }
      }
      if (replaying) return;   // a goal clip OR a live rewind is driving the renderer — keep buffering, don't draw live
      // Background tab: rAF is paused so nothing renders anyway — skip the full sync (trail/event/DOM work at
      // 30-37Hz for the whole match) and just remember the newest frame; visibilitychange snaps it current.
      if (document.hidden) { hiddenLatest = msg; return; }
      hiddenLatest = null;
      renderer.sync(msg);
      paintBar(msg.speed);   // highlight the active speed off the frame

    } catch (e) { console.warn('[watch] dropped a malformed frame', e); }   // one bad frame shouldn't kill the watch (the next frame redraws) — but surface it for debugging rather than swallowing silently
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
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading…')));
  let market: MarketT;
  try { market = await api.market(); }
  catch (e: any) {
    if (String(e.message).includes('no team')) return screenCreateTeam();
    if (!alive()) return;
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
  // §shortlist: the transfer watchlist (resolved rows) + the tracked id set for the ★ toggle state.
  let shortlist: import('./api').ShortlistRowT[] = [];
  let shortIds = new Set<number>();
  try { const s = await api.shortlist(); shortlist = s.shortlist; shortIds = new Set(s.ids); } catch { /* none / pre-feature */ }
  const toggleStar = async (playerId: number) => {
    const add = !shortIds.has(playerId);
    try { const s = await api.toggleShortlist(playerId, add); shortlist = s.shortlist; shortIds = new Set(s.ids); toast(add ? '★ Added to your shortlist' : 'Removed from shortlist'); render(); }
    catch (e: any) { toast(e.message); }
  };

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
      // §loan-out: an owned (not loaned-in) player can be sent out on loan for the season while a window is
      // open + you can spare him — the outbound mirror of the inbound loan on the targets table below.
      let loanOutBtn: HTMLElement | string = '';
      if (!p.onLoan && market.window.open && canSell) {
        const lo = h('button', { class: 'ghost small', title: 'Loan him out to a club that needs him for the season — frees his wages; he returns at season end' }, 'Loan out');
        lo.addEventListener('click', async () => {
          if (!await confirmModal('Loan out', `Send ${p.name} out on loan for the season? A club short in his position takes him on — you free his wages and he returns at the end of the campaign.`, 'Loan out')) return;
          lo.setAttribute('disabled', 'true'); lo.textContent = '…';
          try { const r = await api.loanOut(p.slot); market = r.market; toast(`${r.player} joins ${r.from} on loan`); render(); }
          catch (e: any) { toast(e.message); render(); }
        });
        loanOutBtn = lo;
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
        h('td', { class: 'num' }, h('div', { style: 'display:flex;gap:5px;justify-content:flex-end;flex-wrap:wrap' }, btn, loanOutBtn))));
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
      // §release-clause: an instant, binding buy at the player's clause — bypasses negotiation.
      const clauseBtn = t.releaseClause != null
        ? h('button', { class: 'primary small', style: 'margin-left:4px', title: `Trigger his release clause — an instant signing at ${fmtMoney(t.releaseClause)}` }, 'Buy now')
        : '';
      // Disable the button for the whole action (modal + request) so an impatient re-click on a
      // slow network can't fire a second concurrent bid/loan for the same player — the same guard
      // Sign/List use. render() rebuilds fresh buttons on success; the finally re-enables on cancel.
      const guard = (btn: HTMLElement, fn: () => Promise<void>) => async () => {
        if (btn.hasAttribute('disabled')) return;
        btn.setAttribute('disabled', 'true');
        try { await fn(); } finally { btn.removeAttribute('disabled'); }
      };
      const acts: HTMLElement[] = [bid, loan, ...(clauseBtn instanceof HTMLButtonElement ? [clauseBtn] : [])];
      if (!win.open) { for (const b of acts) { b.setAttribute('disabled', 'true'); b.setAttribute('title', 'Transfer window is shut'); } }
      else {
        bid.addEventListener('click', guard(bid, () => doBid(t)));
        loan.addEventListener('click', guard(loan, () => doLoan(t)));
        if (clauseBtn instanceof HTMLButtonElement) clauseBtn.addEventListener('click', guard(clauseBtn, async () => {
          if (!await confirmModal('Trigger release clause', `Sign ${t.name} from ${t.club} for his release clause of ${fmtMoney(t.releaseClause!)}? This is an instant, binding transfer.`, `Pay ${fmtMoney(t.releaseClause!)}`)) return;
          await sendBid(t.id, t.releaseClause!);
        }));
      }
      const tPot = t.potential != null && t.potential > t.overall;
      const star = h('span', { role: 'button', tabindex: '0', title: shortIds.has(t.id) ? 'On your shortlist — click to remove' : 'Add to your shortlist',
        style: `cursor:pointer;margin-right:5px;${shortIds.has(t.id) ? 'color:var(--gold,#e8b53a)' : 'opacity:.3'}`, ...clickable(() => toggleStar(t.id)) }, '★');
      tgtBody.append(h('tr', {},
        h('td', {}, star, t.name, h('span', { class: 'muted', style: 'font-size:11px' }, ' · ' + t.club),
          t.releaseClause != null ? h('span', { class: 'pill', title: 'Release clause — instantly buyable at this fee', style: 'margin-left:6px;background:rgba(230,57,70,.18);color:#f2a1a8' }, `⚡ ${fmtMoney(t.releaseClause)}`) : ''),
        h('td', {}, h('span', { class: 'pill' }, t.role)),
        h('td', { class: 'num' }, String(t.age)),
        h('td', { class: 'num' }, String(t.overall)),
        h('td', { class: 'num' }, tPot ? h('span', { class: 'a' }, String(t.potential)) : (t.potential != null ? String(t.potential) : '—')),
        moneyCell(t.askPrice ?? t.value, t.wage),
        h('td', { class: 'num' }, h('span', { style: 'display:inline-flex;flex-wrap:wrap;justify-content:flex-end' }, ...acts))));
    }

    // §shortlist: the transfer watchlist — tracked players with their live status + a bid shortcut.
    const shortlistCard = shortlist.length ? h('div', { class: 'card' },
      h('div', { class: 'section-title', style: 'margin-top:0' }, `★ Your shortlist (${shortlist.length})`),
      h('div', { class: 'muted', style: 'margin:-6px 0 8px;font-size:12px' }, 'Players you’re tracking across the world — status updates as the market moves. ★ a target below to add one.'),
      ...shortlist.map(s => h('div', { class: 'between', style: 'font-size:13px;padding:4px 0;border-top:1px solid var(--line)' },
        h('span', {},
          h('span', { role: 'button', tabindex: '0', title: 'Remove from shortlist', style: 'cursor:pointer;color:var(--gold,#e8b53a);margin-right:6px', ...clickable(() => toggleStar(s.id)) }, '★'),
          h('span', { style: 'font-weight:600' }, s.name),
          h('span', { class: 'muted', style: 'font-size:11px' }, ` ${s.role} · ${s.age}y · ${s.club}`),
          s.mine ? h('span', { class: 'pill', style: 'margin-left:6px' }, 'in your squad') : '',
          s.onLoan ? h('span', { class: 'pill', style: 'margin-left:6px' }, 'on loan') : '',
          s.listed ? h('span', { class: 'pill', style: 'margin-left:6px;background:rgba(67,211,158,.15);color:var(--accent)' }, 'listed') : '',
          s.releaseClause != null ? h('span', { class: 'pill', title: 'Release clause', style: 'margin-left:6px;background:rgba(230,57,70,.18);color:#f2a1a8' }, `⚡ ${fmtMoney(s.releaseClause)}`) : ''),
        h('span', { class: 'row', style: 'gap:10px;align-items:center' },
          h('span', { class: 'muted', style: 'font-size:12px' }, `OVR ${s.overall} · ${fmtMoney(s.value)}`),
          (win.open && !s.mine && !s.onLoan)
            ? (() => { const b = h('button', { class: 'ghost small' }, 'Bid'); b.addEventListener('click', () => doBid({ id: s.id, name: s.name, club: s.club, clubTeamId: 0, role: s.role, age: s.age, overall: s.overall, potential: null, value: s.value, askPrice: null, releaseClause: s.releaseClause, wage: 0 })); return b; })()
            : ''))))
      : '';

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

    if (!alive()) return;
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
      // Free agents + Your squad are FULL-WIDTH (was a 2-col grid that clipped the action buttons — "Make
      // offer" / "List" / "Loan out" — off the narrow column edge). Full width keeps every action visible.
      h('div', { class: 'card' },
        h('div', { class: 'section-title', style: 'margin-top:0' }, 'Free agents',
          h('span', { class: 'pill', style: 'margin-left:8px;text-transform:none;letter-spacing:0;background:rgba(67,211,158,.15);color:var(--accent)' }, 'signable any time')),
        h('div', { class: 'scroll-x', style: 'max-height:520px;overflow:auto', 'data-scroll': 'fa' }, h('table', {}, headRow('Player'), faBody))),
      h('div', { class: 'card' },
        h('div', { class: 'section-title', style: 'margin-top:0' }, 'Your squad'),
        h('div', { class: 'muted', style: 'margin:-6px 0 8px;font-size:12px' }, `List a player to sell him — an AI club may buy once you have squad depth (12+).${win.open ? ' Listings lapse at the deadline if unsold.' : ''}`),
        h('div', { class: 'scroll-x', style: 'max-height:520px;overflow:auto', 'data-scroll': 'squad' }, h('table', {}, headRow('Player'), sqBody))),
      incomingCard,
      offersCard,
      h('div', { class: 'card' },
        h('div', { class: 'section-title', style: 'margin-top:0' }, 'For sale — other clubs',
          win.open ? '' : h('span', { class: 'pill', style: 'margin-left:8px;text-transform:none;letter-spacing:0;background:#3a2a1f;color:#ffce9a' }, '🔒 window shut')),
        h('div', { class: 'muted', style: 'margin:-6px 0 8px;font-size:12px' }, win.open ? 'Bid for a listed player — the club may accept, counter, or reject.' : 'Bidding opens during a transfer window.'),
        h('div', { style: 'max-height:420px;overflow:auto', 'data-scroll': 'targets' }, h('table', {}, headRow('Player'), tgtBody))),
      shortlistCard,
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

// ── scouting centre (world-wide player search) ──
// Hunt targets across every club in the world by role/age/overall/value/name. Attributes come back
// FOGGED to the club's scout depth (reusing the opponent-report fog), so a better scouting network
// reads a sharper picture. ★ to shortlist; buyable (listed / release-clause) players link to the Market
// where the negotiation flow lives. Engine-free — a query over existing player data.
const SCOUT_ROLES = ['GK', 'FB', 'CB', 'CM', 'WM', 'CF'];
async function screenScouting() {
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading…')));
  let players: import('./api').ScoutedPlayerT[] = [];
  let depth = 0;
  try { const r = await api.searchPlayers(); depth = r.depth; players = r.players; }
  catch (e: any) { if (String(e.message).includes('no team')) return screenCreateTeam(); if (!alive()) return; return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message))); }

  const expanded = new Set<number>();   // player ids whose fogged attributes are shown
  // parse "1.5m" / "500k" / "1500000" into a number (shared with the market bid parser's intent)
  const parseMoney = (s: string): number | undefined => {
    const t = s.trim().toLowerCase().replace(/[£,\s]/g, '');
    if (!t) return undefined;
    if (!/^\d*\.?\d+[mk]?$/.test(t)) return undefined;
    return Math.round(parseFloat(t) * (t.endsWith('m') ? 1e6 : t.endsWith('k') ? 1e3 : 1));
  };

  const roleSel = h('select', { class: 'focus-select', 'aria-label': 'Position' }, h('option', { value: '' }, 'Any position'), ...SCOUT_ROLES.map(r => h('option', { value: r }, r))) as HTMLSelectElement;
  const ageInput = h('input', { type: 'number', min: '15', max: '40', placeholder: 'Max age', style: 'width:88px', 'aria-label': 'Maximum age' }) as HTMLInputElement;
  const ovrInput = h('input', { type: 'number', min: '1', max: '99', placeholder: 'Min OVR', style: 'width:88px', 'aria-label': 'Minimum overall' }) as HTMLInputElement;
  const valInput = h('input', { placeholder: 'Max value', style: 'width:100px', 'aria-label': 'Maximum value (e.g. 5m)' }) as HTMLInputElement;
  const nameInput = h('input', { placeholder: 'Name', style: 'width:120px', 'aria-label': 'Name contains' }) as HTMLInputElement;
  const shortChk = h('input', { type: 'checkbox', 'aria-label': 'Only shortlisted' }) as HTMLInputElement;
  const searchBtn = h('button', { class: 'primary small' }, 'Search') as HTMLButtonElement;

  // sequence token: role/checkbox/Enter can fire overlapping searches; only the LATEST may write the table
  // (two concurrent fetches can resolve out of order, else a stale filter's results would win).
  let searchSeq = 0;
  const runSearch = async () => {
    const my = ++searchSeq;
    searchBtn.setAttribute('disabled', 'true'); searchBtn.textContent = '…';
    try {
      const r = await api.searchPlayers({
        role: roleSel.value || undefined,
        maxAge: ageInput.value ? Number(ageInput.value) : undefined,
        minOverall: ovrInput.value ? Number(ovrInput.value) : undefined,
        maxValue: parseMoney(valInput.value),
        name: nameInput.value.trim() || undefined,
        shortlisted: shortChk.checked,
      });
      if (!alive() || my !== searchSeq) return;   // a newer search superseded this one
      depth = r.depth; players = r.players; expanded.clear(); renderResults();
    } catch (e: any) { if (my === searchSeq) toast(e.message); }
    finally { if (my === searchSeq) { searchBtn.removeAttribute('disabled'); searchBtn.textContent = 'Search'; } }
  };
  searchBtn.addEventListener('click', runSearch);
  for (const el of [ageInput, ovrInput, valInput, nameInput]) el.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') runSearch(); });
  roleSel.addEventListener('change', runSearch);
  shortChk.addEventListener('change', runSearch);

  const toggleStar = async (p: import('./api').ScoutedPlayerT) => {
    const add = !p.shortlisted;
    try { await api.toggleShortlist(p.id, add); p.shortlisted = add; toast(add ? '★ Added to your shortlist' : 'Removed from shortlist'); renderResults(); }
    catch (e: any) { toast(e.message); }
  };

  const resultsHost = h('div', {});
  const fogCell = (p: import('./api').ScoutedPlayerT) => {
    if (!p.attrs) return h('div', { class: 'muted', style: 'font-size:12px;padding:4px 0' }, 'No scouting network — hire a scout (Staff) to reveal his attributes.');
    return h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;padding:4px 0' },
      ...SQUAD_ATTRS.map(([k, abbr]) => {
        const a = p.attrs!.find(x => x.key === k);
        const txt = a ? (a.lo === a.hi ? String(a.lo) : `${a.lo}–${a.hi}`) : '—';
        return h('span', { class: 'pill', style: 'font-size:11px' }, `${abbr} `, h('b', {}, txt));
      }));
  };

  function renderResults() {
    if (!players.length) { resultsHost.replaceChildren(h('div', { class: 'card muted' }, 'No players match these filters. Widen the search.')); return; }
    const body = h('tbody');
    for (const p of players) {
      const pot = p.potential != null && p.potential > p.overall;
      // the star must NOT bubble to the name cell's expand handler — stop propagation on both click + key
      const star = h('span', { role: 'button', tabindex: '0', title: p.shortlisted ? 'On your shortlist — click to remove' : 'Add to your shortlist',
        style: `cursor:pointer;margin-right:5px;${p.shortlisted ? 'color:var(--gold,#e8b53a)' : 'opacity:.3'}`,
        onclick: (e: Event) => { e.stopPropagation(); toggleStar(p); },
        onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggleStar(p); } } }, '★');
      const nameCell = h('td', { ...clickable(() => { if (expanded.has(p.id)) expanded.delete(p.id); else expanded.add(p.id); renderResults(); }), style: 'cursor:pointer', title: 'Show scouted attributes' },
        star, p.name, h('span', { class: 'muted', style: 'font-size:11px' }, ' · ' + p.club),
        p.releaseClause != null ? h('span', { class: 'pill', title: 'Release clause — instantly buyable from the Market', style: 'margin-left:6px;background:rgba(230,57,70,.18);color:#f2a1a8' }, `⚡ ${fmtMoney(p.releaseClause)}`)
          : p.buyable ? h('span', { class: 'pill', title: 'Listed for sale — bid from the Market', style: 'margin-left:6px' }, 'listed') : '');
      const action = p.buyable
        ? h('button', { class: 'ghost small', title: 'Go to the Market to bid for him', onclick: () => (location.hash = '#/market') }, '→ Market')
        : h('span', { class: 'muted', style: 'font-size:11px' }, 'not for sale');
      body.append(h('tr', {},
        nameCell,
        h('td', {}, h('span', { class: 'pill' }, p.role)),
        h('td', { class: 'num' }, String(p.age)),
        h('td', { class: 'num' }, String(p.overall)),
        h('td', { class: 'num' }, pot ? h('span', { class: 'a' }, String(p.potential)) : (p.potential != null ? String(p.potential) : '—')),
        h('td', { class: 'num' }, fmtMoney(p.value), h('div', { class: 'muted', style: 'font-size:10px' }, `${fmtMoney(p.wage)}/yr`)),
        h('td', { class: 'num' }, action)));
      if (expanded.has(p.id)) body.append(h('tr', {}, h('td', { colspan: '7', style: 'background:rgba(255,255,255,.02)' }, fogCell(p))));
    }
    resultsHost.replaceChildren(h('div', { class: 'card', style: 'padding:0;overflow-x:auto' },
      h('table', { style: 'width:100%' },
        h('thead', {}, h('tr', {},
          h('th', {}, `Player (${players.length})`), h('th', {}, 'Role'),
          h('th', { class: 'num' }, 'Age'), h('th', { class: 'num' }, 'OVR'), h('th', { class: 'num' }, 'POT'),
          h('th', { class: 'num' }, 'Value/Wage'), h('th', { class: 'num' }, ''))),
        body)));
  }

  if (!alive()) return;
  const depthNote = depth >= 3 ? 'exact attributes' : depth >= 1 ? `attribute ranges (±${depth === 2 ? 4 : 7})` : 'no attribute picture — hire a scout';
  mount(header(), h('div', { class: 'wrap grid' },
    h('div', { class: 'between' },
      h('div', {}, h('h2', {}, '🔎 Scouting Centre'),
        h('div', { class: 'muted', style: 'font-size:12px' }, `Search every club in your world. Scout depth ${depth}/3 — ${depthNote}. Click a player to reveal his scouted attributes.`)),
      h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, '← Back')),
    h('div', { class: 'card' },
      h('div', { class: 'row', style: 'gap:10px;flex-wrap:wrap;align-items:center' },
        roleSel, ageInput, ovrInput, valInput, nameInput,
        h('label', { class: 'row', style: 'gap:5px;align-items:center;font-size:12px' }, shortChk, h('span', { class: 'muted' }, '★ shortlisted only')),
        searchBtn)),
    resultsHost));
  renderResults();
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
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading…')));
  let team: TeamT;
  try { team = await api.team(); }
  catch (e: any) {
    if (String(e.message).includes('no team')) return screenCreateTeam();
    if (!alive()) return;
    return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message)));
  }
  // The report is best-effort — show the screen even if it hasn't been generated yet (or 404s).
  let report: TrainingReportT | null = null;
  try { report = (await api.trainingReport()).report; } catch { /* no report yet */ }
  const ovrOf = (p: typeof team.players[number]) => skillOvr(p.attrs);

  // club-wide focus selector
  const sel = h('select', { class: 'focus-select', 'aria-label': 'Club training focus' }) as HTMLSelectElement;
  for (const f of TRAINING_FOCI) {
    const o = h('option', { value: f }, focusLabel(f)) as HTMLOptionElement;
    if (f === (team.trainingFocus ?? 'balanced')) o.selected = true;
    sel.append(o);
  }
  sel.addEventListener('change', async () => {
    try { const r = await api.setTraining(sel.value); toast(`Club training focus: ${focusLabel(r.focus)}`); }
    catch (e: any) { toast(e.message); }
  });

  // club-wide training intensity dial — a gentler scale than the per-player override (which wins).
  // 'normal' is the byte-identical default; heavy grows the whole squad faster at a higher injury cost.
  const TEAM_INTENSITY: [string, string][] = [['light', 'Light'], ['normal', 'Normal'], ['heavy', 'Heavy ↑']];
  const tiSel = h('select', { class: 'focus-select', 'aria-label': 'Club training intensity', title: 'Sets the whole squad’s training load (a player’s own intensity overrides this). Heavier grows faster but tires legs and raises injury risk.' }) as HTMLSelectElement;
  for (const [iv, lbl] of TEAM_INTENSITY) {
    const o = h('option', { value: iv }, lbl) as HTMLOptionElement;
    if (iv === (team.trainingIntensity ?? 'normal')) o.selected = true;
    tiSel.append(o);
  }
  const tiHint = h('span', { class: 'muted', style: 'font-size:12px' });
  const intensityHint = (v: string) => v === 'heavy' ? 'Whole squad: +40% growth, higher fatigue + injury risk'
    : v === 'light' ? 'Whole squad: −30% growth, fresher legs + fewer injuries' : 'Whole squad: standard load';
  tiHint.textContent = intensityHint(team.trainingIntensity ?? 'normal');
  tiSel.addEventListener('change', async () => {
    try { const r = await api.setTeamIntensity(tiSel.value); tiHint.textContent = intensityHint(r.intensity); toast(`Club intensity: ${r.intensity}`); }
    catch (e: any) { toast(e.message); }
  });

  // one-click training schedules — set the club focus + intensity together (FM's preset buttons)
  const PRESETS: [string, string, string][] = [
    ['balanced', 'Balanced', 'Even development, normal load'],
    ['attacking', 'Attacking', 'Sharpen shooting, normal load'],
    ['possession', 'Possession', 'Drill passing, normal load'],
    ['defending', 'Defending', 'Work the back line, normal load'],
    ['fitness', 'Fitness', 'Build stamina — heavy load'],
    ['recovery', 'Recovery', 'Freshen the legs — light load'],
  ];
  const presetRow = h('div', { class: 'card' },
    h('div', { class: 'row', style: 'align-items:center;gap:8px;flex-wrap:wrap' },
      h('span', { class: 'section-title', style: 'margin:0 6px 0 0' }, 'Quick schedules'),
      ...PRESETS.map(([name, label, hint]) => h('button', {
        class: 'ghost', style: 'font-size:12px;padding:4px 10px', title: hint,
        onclick: async () => {
          try { const r = await api.applyTrainingPreset(name); toast(`Training schedule: ${r.preset?.label ?? label}`); screenTraining(); }
          catch (e: any) { toast(e.message); }
        },
      }, label))));

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

    // per-category coaching board snapshot — shows which categories the staff is driving (★ + growth %)
    const catRow = report.categoryFactors && report.categoryFactors.length
      ? h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap;margin:0 0 8px' },
          ...report.categoryFactors.map(c => {
            const pct = Math.round((c.factor - 1) * 100);
            const full = Math.max(0, Math.min(5, Math.round(c.stars)));
            const stars = '★'.repeat(full) + '☆'.repeat(5 - full);
            const good = pct > 0;
            return h('span', {
              class: 'pill', style: `text-transform:none;letter-spacing:0;font-size:11px;${good ? 'color:var(--accent)' : pct < 0 ? 'color:#ffce9a' : 'opacity:.7'}`,
              title: `${c.category}: ${c.stars.toFixed(1)}★ · coverage ${Math.round(c.coverage * 100)}% · ${pct >= 0 ? '+' : ''}${pct}% growth`,
            }, `${c.category} ${stars} ${pct >= 0 ? '+' : ''}${pct}%`);
          }))
      : '';
    return h('div', { class: 'card' },
      h('div', { class: 'between' },
        h('div', { class: 'section-title', style: 'margin-top:0' }, 'Last training session'),
        h('div', { class: 'muted', style: 'font-size:12px' }, `Season ${report.season} · after Matchday ${report.round}`)),
      h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap;margin:-2px 0 8px;align-items:center' }, ...chips,
        h('span', { class: 'muted', style: 'font-size:12px;margin-left:2px' }, `${improved} improved · ${declined} declined${steady ? ` · ${steady} steady` : ''}`)),
      catRow,
      h('div', { class: 'grid', style: 'gap:6px;max-height:440px;overflow:auto' }, ...lineEls));
  })();

  // ── squad table — OVR/potential + a per-player focus override ──
  const body = h('tbody');
  for (const p of [...team.players].sort((a, b) => a.slot - b.slot)) {
    const ovr = ovrOf(p), pot = p.potential ?? ovr;
    const room = pot - ovr;
    const pfSel = h('select', { class: 'focus-select', style: 'font-size:12px;padding:2px 4px', 'aria-label': 'Training focus for ' + p.name }) as HTMLSelectElement;
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
    // per-player training intensity — faster growth at a higher injury cost (normal = the default / byte-identical)
    const piSel = h('select', { class: 'focus-select', style: 'font-size:12px;padding:2px 4px', 'aria-label': 'Training intensity for ' + p.name, title: 'Higher intensity grows faster but raises injury risk; rest recovers' }) as HTMLSelectElement;
    for (const [iv, lbl] of [['normal', 'Normal'], ['double', 'Double ↑'], ['half', 'Light'], ['rest', 'Rest']]) {
      const o = h('option', { value: iv }, lbl) as HTMLOptionElement;
      if (iv === (p.trainIntensity ?? 'normal')) o.selected = true;
      piSel.append(o);
    }
    piSel.addEventListener('change', async () => {
      try { const r = await api.setPlayerIntensity(p.slot, piSel.value); toast(`${p.name}: ${r.intensity ?? 'normal'} training`); }
      catch (e: any) { toast(e.message); }
    });
    // position retrain — learn a new role; while settling, he develops a little slower (familiarity bar)
    const rtSel = h('select', { class: 'focus-select', style: 'font-size:12px;padding:2px 4px', 'aria-label': 'Retrain position for ' + p.name, title: 'Retrain this player into a new position. He settles in over several matchdays, developing a little slower until comfortable.' }) as HTMLSelectElement;
    rtSel.append(h('option', { value: '' }, 'No (stay ' + p.role + ')'));
    for (const role of ['GK', 'FB', 'CB', 'CM', 'WM', 'CF']) {
      if (role === p.role) continue;
      const o = h('option', { value: role }, '→ ' + role) as HTMLOptionElement;
      if (role === (p.retrainRole ?? '')) o.selected = true;
      rtSel.append(o);
    }
    rtSel.addEventListener('change', async () => {
      try { const r = await api.setPlayerRetrain(p.slot, rtSel.value || 'clear'); toast(r.retrainRole ? `${p.name}: retraining → ${r.retrainRole}` : `${p.name}: settled at ${p.role}`); screenTraining(); }
      catch (e: any) { toast(e.message); }
    });
    const fam = Math.round(p.roleFamiliarity ?? 100);
    const retrainCell = p.retrainRole
      ? h('div', { style: 'min-width:90px' }, rtSel,
          h('div', { style: 'margin-top:3px;height:5px;background:#26303f;border-radius:3px;overflow:hidden', title: `Settling into ${p.retrainRole}: ${fam}%` },
            h('div', { style: `height:100%;width:${fam}%;background:var(--accent)` })),
          h('div', { class: 'muted', style: 'font-size:10px;margin-top:1px' }, `settling ${fam}%`))
      : rtSel;
    body.append(h('tr', {},
      h('td', {}, p.name, p.slot >= 11 ? h('span', { class: 'muted', style: 'font-size:11px' }, ' · bench') : ''),
      h('td', {}, h('span', { class: 'pill' }, p.role)),
      h('td', { class: 'num' }, p.age != null ? String(p.age) : '—'),
      h('td', { class: 'num' }, String(ovr)),
      h('td', { class: 'num' }, room > 0 ? h('span', { class: 'a' }, `${pot} (+${room})`) : String(pot)),
      h('td', {}, pfSel),
      h('td', {}, piSel),
      h('td', {}, retrainCell),
    ));
  }

  if (!alive()) return;
  mount(header(), h('div', { class: 'wrap grid' },
    h('div', { class: 'between' },
      h('div', {}, h('h2', {}, 'Training'),
        h('div', { class: 'muted' }, 'Players drift toward their potential each matchday — faster while young and for the diligent. Set a club focus, or override one player to push a single attribute (or “Position-specific” to train for his role).')),
      h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, '← Back'),
    ),
    presetRow,
    reportCard,
    h('div', { class: 'card' },
      h('div', { class: 'row', style: 'align-items:center;gap:10px;margin-bottom:6px;flex-wrap:wrap' },
        h('span', { class: 'section-title', style: 'margin:0' }, 'Club training focus'), sel,
        h('span', { class: 'section-title', style: 'margin:0 0 0 10px' }, 'Intensity'), tiSel, tiHint),
      (() => {
        // squad load at a glance — surfaces the per-player overrides + retrains against the club dial
        const piCount = (v: string) => team.players.filter(p => p.trainIntensity === v).length;
        const retraining = team.players.filter(p => p.retrainRole).length;
        const bits: string[] = [];
        if (piCount('double')) bits.push(`${piCount('double')} on Double ↑`);
        if (piCount('half')) bits.push(`${piCount('half')} on Light`);
        if (piCount('rest')) bits.push(`${piCount('rest')} Resting`);
        if (retraining) bits.push(`${retraining} retraining`);
        return h('div', { class: 'muted', style: 'font-size:12px;margin:0 0 4px' },
          bits.length ? `Squad: ${bits.join(' · ')} — everyone else on the club dial` : 'Squad: every player on the club default');
      })(),
      h('div', { style: 'max-height:540px;overflow:auto;margin-top:8px' },
        h('table', {},
          h('thead', {}, h('tr', {},
            h('th', {}, 'Player'), h('th', {}, 'Pos'),
            h('th', { class: 'num' }, 'Age'), h('th', { class: 'num' }, 'OVR'), h('th', { class: 'num' }, 'Potential'), h('th', {}, 'Focus'), h('th', {}, 'Intensity'), h('th', {}, 'Retrain'))),
          body)),
    ),
  ));
}

// ── pre-match team talk (§2.13): pick a tone, see how it lands, deliver it ──
async function screenTeamTalk(fixtureId: number) {
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Gathering the squad…')));
  let data: { tones: TalkToneT[]; pending: { tone: string } | null; tone: string; reactions: TalkReactionT[] };
  try { data = await api.teamTalk(fixtureId); }
  catch (e: any) {
    if (String(e.message).includes('no team')) return screenCreateTeam();
    if (!alive()) return;
    return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message),
      h('button', { class: 'ghost', style: 'margin-top:12px', onclick: () => (location.hash = '#/') }, '← Back')));
  }
  let tone = data.tone;
  let talkReq = 0;   // ignore an out-of-order tone-preview response (rapid clicks can resolve in the wrong order)

  function render() {
    const reactColor = (d: number) => d >= 0.08 ? 'var(--accent)' : d <= -0.08 ? 'var(--danger)' : 'var(--muted, #8a93a3)';
    const lifts = data.reactions.filter(r => r.delta >= 0.08).length;
    const rattles = data.reactions.filter(r => r.delta <= -0.08).length;
    const toneBtns = data.tones.map(t => {
      const b = h('button', { class: t.key === tone ? 'primary small' : 'ghost small', title: t.blurb }, t.label);
      if (t.key !== tone) b.addEventListener('click', async () => { const my = ++talkReq; try { const d = await api.teamTalk(fixtureId, t.key); if (!alive() || my !== talkReq) return; data = d; tone = d.tone; render(); } catch (e: any) { toast(e.message); } });
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

    if (!alive()) return;
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
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading the academy…')));
  let prospects: AcademyProspectT[];
  try { prospects = (await api.academy()).prospects; }
  catch (e: any) { if (String(e.message).includes('no team')) return screenCreateTeam(); if (!alive()) return; return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message))); }

  const body = h('tbody');
  // best-potential first, so the ones worth promoting rise to the top
  for (const p of [...prospects].sort((a, b) => (b.potential ?? b.overall) - (a.potential ?? a.overall))) {
    const room = (p.potential ?? p.overall) - p.overall;
    const promote = h('button', { class: 'primary small' }, 'Promote');
    promote.addEventListener('click', async () => {
      promote.setAttribute('disabled', 'true');
      try { const r = await api.promoteProspect(p.id); toast(`${r.player} promoted to the senior squad`); screenAcademy(); }
      catch (e: any) { toast(e.message); promote.removeAttribute('disabled'); }
    });
    // promotion signals: a prospect at first-team level, and one graduating out (leaves the academy at 21).
    const ready = p.overall >= 60;
    const graduating = p.age >= 20;
    body.append(h('tr', {},
      h('td', {}, p.name,
        ready ? h('span', { class: 'pill', title: 'At first-team level — ready to promote', style: 'margin-left:6px;background:transparent;border:1px solid var(--accent);color:var(--accent);font-size:9px' }, 'ready') : '',
        graduating ? h('span', { class: 'pill', title: 'Graduates out of the academy at 21 if not promoted', style: 'margin-left:5px;background:transparent;border:1px solid #ffb84d;color:#ffb84d;font-size:9px' }, '⚠ graduating') : '',
        // the attribute profile so a prospect can be evaluated on more than OVR (the squad/scout views show this)
        h('div', { class: 'muted', style: 'font-size:10px' }, attrTokens(p.attrs).join(' · '))),
      h('td', {}, h('span', { class: 'pill' }, p.role)),
      h('td', { class: 'num', style: graduating ? 'color:#ffb84d;font-weight:600' : '' }, String(p.age)),
      h('td', { class: 'num' }, String(p.overall)),
      h('td', { class: 'num' }, room > 0 ? h('span', { class: 'a', style: 'color:var(--accent)' }, `${p.potential} (+${room})`) : String(p.potential ?? '—')),
      h('td', {}, promote)));
  }

  if (!alive()) return;
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
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading the archive…')));
  let news: NewsItemT[];
  try { news = (await api.news(200)).news; }
  catch (e: any) { if (String(e.message).includes('no team')) return screenCreateTeam(); if (!alive()) return; return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message))); }
  const NEWS_ICON: Record<NewsItemT['type'], string> = { hat_trick: '⚽⚽⚽', brace: '⚽⚽', red_card: '🟥', star: '⭐', long_injury: '🤕', pots: '🏆', young_pots: '🌟', press: '🎤' };

  const groups: { season: number; items: NewsItemT[] }[] = [];
  for (const n of news) { const g = groups[groups.length - 1]; if (g && g.season === n.season) g.items.push(n); else groups.push({ season: n.season, items: [n] }); }

  if (!alive()) return;
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

// ── inbox (§inbox): the persistent matchday feed — every result, transfer, injury, contract, cup and
// board message, archived across seasons with a category filter + unread state. Written server-side at
// advance; the dashboard digest card is the same items for the latest matchday only. ──
const INBOX_CAT_LABEL: Record<string, string> = {
  result: 'Results', finance: 'Finance', development: 'Training', injury: 'Injuries', transfer: 'Transfers',
  bid: 'Bids', contract: 'Contracts', cup: 'Cup', season: 'Season', youth: 'Academy', award: 'Awards', board: 'Board',
};
async function screenInbox() {
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading your inbox…')));
  let data: Awaited<ReturnType<typeof api.inbox>>;
  try { data = await api.inbox(200); }
  catch (e: any) { if (String(e.message).includes('no team')) return screenCreateTeam(); if (!alive()) return; return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message))); }

  let filter = 'all';
  const container = h('div', {});
  const render = () => {
    const items = filter === 'all' ? data.inbox : data.inbox.filter(i => (i.category ?? '') === filter);
    const cats = [...new Set(data.inbox.map(i => i.category ?? 'other'))];
    const chip = (key: string, label: string) => h('button', { class: filter === key ? 'primary small' : 'ghost small', onclick: () => { filter = key; render(); } }, label);
    const chips = h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap;margin-bottom:10px' },
      chip('all', `All (${data.inbox.length})`), ...cats.map(c => chip(c, INBOX_CAT_LABEL[c] ?? c)));
    const groups: { season: number; items: typeof data.inbox }[] = [];
    for (const it of items) { const g = groups[groups.length - 1]; if (g && g.season === it.season) g.items.push(it); else groups.push({ season: it.season, items: [it] }); }
    const rowEl = (it: typeof data.inbox[number]) => h('div', { class: 'between', style: `font-size:13px;padding:5px 0;border-bottom:1px solid var(--line);${it.read ? '' : 'font-weight:600'}` },
      h('span', it.hash ? { ...clickable(async () => { const dest = it.hash!; if (!it.read) { try { await api.markInboxRead({ id: it.id }); it.read = true; } catch { /* still navigate */ } } location.hash = dest; }), style: 'cursor:pointer' } : {},
        it.read ? '' : h('span', { style: 'color:var(--accent);margin-right:5px' }, '●'),
        `${it.icon} ${it.text}${it.hash ? ' →' : ''}`),
      h('span', { class: 'muted', style: 'font-size:10px;white-space:nowrap;margin-left:8px' }, `R${it.round}`));
    container.replaceChildren(chips,
      ...(items.length
        ? groups.map(g => h('div', { class: 'card' }, h('div', { class: 'section-title', style: 'margin-top:0' }, `Season ${g.season}`), ...g.items.map(rowEl)))
        : [h('div', { class: 'card muted', style: 'font-size:13px' }, filter === 'all'
            ? 'Nothing here yet — advance a matchday and results, transfers and board messages collect in your inbox.'
            : 'No items in this category.')]));
  };

  const markAll = h('button', { class: 'ghost small' }, 'Mark all read');
  markAll.addEventListener('click', async () => {
    try { const r = await api.markInboxRead({ all: true }); data.unread = r.unread; data.inbox.forEach(i => i.read = true); render(); }
    catch (e: any) { toast(e.message); }
  });
  if (!alive()) return;
  mount(header(), h('div', { class: 'wrap grid' },
    h('div', { class: 'between' },
      h('div', {}, h('h2', {}, '📨 Inbox'), h('div', { class: 'muted' }, `${data.inbox.length} item(s)${data.unread ? ` · ${data.unread} unread` : ''}`)),
      h('div', { class: 'row', style: 'gap:8px' }, data.inbox.length ? markAll : '', h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, '← Back'))),
    container));
  render();
}

// ── league stat leaders (§stat-leaders): the division's top scorers + assisters this season ──
async function screenLeaders() {
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading the leaderboards…')));
  let d: LeadersT;
  try { d = await api.leaders(); }
  catch (e: any) {
    if (String(e.message).includes('no team')) return screenCreateTeam();
    if (!alive()) return;
    return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message),
      h('button', { class: 'ghost', style: 'margin-top:12px', onclick: () => screenLeaders() }, '↻ Retry')));
  }
  const board = (title: string, unit: string, rows: LeadersT['scorers']) => h('div', { class: 'card' },
    h('div', { class: 'section-title', style: 'margin-top:0' }, title),
    rows.length
      ? h('table', {}, h('tbody', {}, ...rows.map((r, i) => h('tr', { class: r.isMine ? 'me' : '' },
          h('td', { class: 'num', style: 'width:26px' }, String(i + 1)),
          h('td', {}, r.name, h('span', { class: 'muted', style: 'font-size:11px' }, ` ${r.role}`), r.isMine ? h('span', { class: 'pill', style: 'margin-left:6px' }, 'you') : ''),
          h('td', { class: 'muted', style: 'font-size:12px' }, r.club),
          h('td', { class: 'num', style: 'font-weight:700' }, String(r.value))))))
      : h('div', { class: 'muted', style: 'font-size:13px' }, `No ${unit} yet — the table fills as the season plays out.`));
  // Team of the Season — the division's best-rated XI (a role band per row), your players highlighted.
  const totCard = d.teamOfSeason.length ? h('div', { class: 'card' },
    h('div', { class: 'section-title', style: 'margin-top:0' }, '🌟 Team of the Season'),
    h('div', { class: 'muted', style: 'margin:-4px 0 8px;font-size:12px' }, `${d.division}'s best-rated XI by average match rating this season.`),
    h('table', {}, h('tbody', {}, ...d.teamOfSeason.map(r => h('tr', { class: r.isMine ? 'me' : '' },
      h('td', { style: 'width:38px' }, h('span', { class: 'pill' }, r.role)),
      h('td', {}, r.name, r.isMine ? h('span', { class: 'pill', style: 'margin-left:6px' }, 'you') : ''),
      h('td', { class: 'muted', style: 'font-size:12px' }, r.club),
      h('td', { class: 'num', style: 'font-weight:700' }, r.value.toFixed(1))))))) : '';
  if (!alive()) return;
  mount(header(), h('div', { class: 'wrap grid' },
    h('div', { class: 'between' },
      h('div', {}, h('h2', {}, 'Stat leaders'), h('div', { class: 'muted' }, `${d.division} · this season`)),
      h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, '← Back')),
    h('div', { class: 'grid cols-2', style: 'align-items:start' },
      board('🥇 Top scorers', 'goals', d.scorers),
      board('🅰️ Top assists', 'assists', d.assists)),
    h('div', { class: 'grid cols-2', style: 'align-items:start' },
      board('⭐ Best average rating', 'ratings', d.ratings),
      totCard)));
}

// ── player profile (personality + the story↔traits coupling) ──
const TRAIT_LABELS: { key: string; label: string }[] = [
  { key: 'professionalism', label: 'Professionalism' }, { key: 'consistency', label: 'Consistency' },
  { key: 'bigGame', label: 'Big-game' }, { key: 'leadership', label: 'Leadership' },
  { key: 'temperament', label: 'Temperament (fiery)' }, { key: 'ego', label: 'Ego' },
  { key: 'criticismResponse', label: 'Responds to criticism' }, { key: 'praiseResponse', label: 'Responds to praise' },
];
function traitBar(label: string, v: number, color = 'var(--accent,#4ea1ff)', note?: Node | string): HTMLElement {
  return h('div', { style: 'margin-bottom:7px' },
    h('div', { class: 'between', style: 'font-size:12px;margin-bottom:2px' }, h('span', { class: 'muted' }, label), h('span', {}, String(v), note ?? '')),
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
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading…')));
  let team: TeamT;
  try { team = await api.team(); }
  catch (e: any) { if (String(e.message).includes('no team')) return screenCreateTeam(); if (!alive()) return; return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message))); }
  const p = team.players.find(x => x.slot === slot);
  if (!p) { location.hash = '#/'; return; }
  const ovr = skillOvr(p.attrs);
  // squad role-average, for the per-attribute delta on the profile ("how good a CB is he for MY squad?")
  const sameRole = team.players.filter(x => x.role === p.role);
  const roleAvg = (k: string): number => sameRole.length ? sameRole.reduce((s, x) => s + (x.attrs[k] ?? 0), 0) / sameRole.length : 0;
  // development outlook — reads age vs headroom-to-potential the same way the dev tick does (grow young /
  // plateau / decline past ~30), so a manager sees whether a player is still a project or on the slide.
  const headroom = (p.potential ?? ovr) - ovr;
  const devOutlook: { icon: string; text: string; color: string } | null = (() => {
    const age = p.age ?? 24;
    if (age <= 23 && headroom >= 3) return { icon: '🌱', text: `Developing — ${headroom} OVR of headroom to his ${p.potential} ceiling`, color: 'var(--accent)' };
    if (age <= 29 && headroom >= 2) return { icon: '↗', text: `Still improving — ${headroom} to his ${p.potential} ceiling`, color: '#7fb2ff' };
    if (age >= 31) return { icon: '↘', text: 'Past his peak — likely to decline as he ages', color: '#e8896b' };
    if (headroom <= 1 && age >= 24) return { icon: '◎', text: 'At his ceiling — settled at this level', color: 'var(--muted)' };
    return null;
  })();

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

  const back = h('textarea', { id: 'f-backstory', class: 'tactics-input', rows: '4', placeholder: 'Backstory — e.g. "A model professional and ice-cool penalty taker who rises on the big occasion."' }, p.personality?.backstory ?? '') as HTMLTextAreaElement;
  const tag = h('input', { id: 'f-tagline', placeholder: 'Tagline (≤6 words, in character)', value: p.personality?.tagline ?? '' }) as HTMLInputElement;
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

  // §player-interaction: a private 1-to-1 word that moves morale by his personality dials (one per matchday).
  const talkReact = h('div', { style: 'font-size:13px;min-height:18px;margin-top:8px', 'aria-live': 'polite' });
  const talkBtns: HTMLButtonElement[] = [];
  const INTERACT_TONES: { tone: string; label: string; title: string }[] = [
    { tone: 'praise', label: '👏 Praise', title: 'Single him out for his form — lifts most, especially praise-hungry players and big egos.' },
    { tone: 'encourage', label: '💬 Encourage', title: 'A quiet word of belief — a gentle lift for most.' },
    { tone: 'warn', label: '☝️ Have a word', title: 'A measured warning about his standards — mild; the thick-skinned take it well.' },
    { tone: 'criticise', label: '🔥 Criticise', title: 'Tear a strip off him — fires up the thick-skinned, wounds the sensitive and hot-heads.' },
  ];
  const doTalk = async (tone: string, btn: HTMLButtonElement) => {
    talkBtns.forEach(b => b.setAttribute('disabled', 'true'));
    const t0 = btn.textContent; btn.textContent = '…';
    try {
      const r = await api.interactPlayer(slot, tone);
      p.morale = r.morale;   // keep the local copy in step (the header already painted the old value)
      talkReact.replaceChildren(h('span', { class: r.delta > 0 ? 'ok' : r.delta < 0 ? 'warn' : 'muted' },
        `${r.delta > 0 ? '▲ +' + r.delta : r.delta < 0 ? '▼ ' + r.delta : 'no change'} morale · now ${r.morale} — “${r.reaction}”`));
      // one chat per matchday — leave the buttons disabled after a successful word
    } catch (e: any) {
      talkReact.replaceChildren(h('span', { class: 'muted' }, e.message));
      if (!/already had a word/.test(e.message)) talkBtns.forEach(b => b.removeAttribute('disabled'));   // a failed call didn't consume the cooldown
    } finally { btn.textContent = t0; }
  };
  const interactCard = h('div', { class: 'card' },
    h('div', { class: 'section-title', style: 'margin-top:0' }, 'Have a word'),
    h('div', { class: 'muted', style: 'font-size:12px;margin-bottom:8px' }, 'A private word moves his morale — how it lands depends on his personality. One chat per player per matchday.'),
    h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' }, ...INTERACT_TONES.map(it => {
      const b = h('button', { class: 'ghost small', title: it.title }, it.label) as HTMLButtonElement;
      b.addEventListener('click', () => doTalk(it.tone, b));
      talkBtns.push(b); return b;
    })),
    talkReact);

  // §individual-training: shape this player's development from his own page (reuses the training endpoints).
  const pfSel = h('select', { style: 'width:auto;font-size:12px;padding:3px 6px', 'aria-label': 'Training focus' }) as HTMLSelectElement;
  pfSel.append(h('option', { value: '' }, 'Follow club focus'));
  for (const f of TRAINING_FOCI) { const o = h('option', { value: f }, focusLabel(f)) as HTMLOptionElement; if (f === (p.trainFocus ?? '')) o.selected = true; pfSel.append(o); }
  pfSel.addEventListener('change', async () => { try { const r = await api.setPlayerTraining(slot, pfSel.value); p.trainFocus = r.focus ?? undefined; toast(r.focus ? `Focus: ${focusLabel(r.focus)}` : 'Follows the club focus'); } catch (e: any) { toast(e.message); } });
  const piSel = h('select', { style: 'width:auto;font-size:12px;padding:3px 6px', 'aria-label': 'Training intensity', title: 'Higher intensity grows faster but raises injury risk; rest recovers' }) as HTMLSelectElement;
  for (const [iv, lbl] of [['normal', 'Normal'], ['double', 'Double ↑'], ['half', 'Light'], ['rest', 'Rest']]) { const o = h('option', { value: iv }, lbl) as HTMLOptionElement; if (iv === (p.trainIntensity ?? 'normal')) o.selected = true; piSel.append(o); }
  piSel.addEventListener('change', async () => { try { const r = await api.setPlayerIntensity(slot, piSel.value); p.trainIntensity = r.intensity ?? undefined; toast(`Intensity: ${r.intensity ?? 'normal'}`); } catch (e: any) { toast(e.message); } });
  const rtSel = h('select', { style: 'width:auto;font-size:12px;padding:3px 6px', 'aria-label': 'Retrain position', title: 'Retrain him into a new position — he settles in over several matchdays, developing a little slower until comfortable.' }) as HTMLSelectElement;
  rtSel.append(h('option', { value: '' }, `No (stay ${p.role})`));
  for (const role of ['GK', 'FB', 'CB', 'CM', 'WM', 'CF']) { if (role === p.role) continue; const o = h('option', { value: role }, `→ ${role}`) as HTMLOptionElement; if (role === (p.retrainRole ?? '')) o.selected = true; rtSel.append(o); }
  rtSel.addEventListener('change', async () => { try { const r = await api.setPlayerRetrain(slot, rtSel.value || 'clear'); toast(r.retrainRole ? `Retraining → ${r.retrainRole}` : `Settled at ${p.role}`); screenPlayer(slot); } catch (e: any) { toast(e.message); } });
  const devCard = h('div', { class: 'card' },
    h('div', { class: 'section-title', style: 'margin-top:0' }, 'Development'),
    h('div', { class: 'muted', style: 'font-size:12px;margin-bottom:8px' }, 'His individual training — a focus grows one area faster, intensity trades growth for injury risk, and you can retrain him into a new position.'),
    h('div', { class: 'row', style: 'gap:14px;flex-wrap:wrap;align-items:center' },
      h('label', { class: 'row', style: 'gap:5px;align-items:center;font-size:12px' }, h('span', { class: 'muted' }, 'Focus'), pfSel),
      h('label', { class: 'row', style: 'gap:5px;align-items:center;font-size:12px' }, h('span', { class: 'muted' }, 'Intensity'), piSel),
      h('label', { class: 'row', style: 'gap:5px;align-items:center;font-size:12px' }, h('span', { class: 'muted' }, 'Retrain'), rtSel)));

  // §player-stats: this season's contribution (goals/assists/apps/avg-rating, tallied from every fixture's
  // --summary in leaders.ts) + a career table archived per season. The season figures live on the player
  // payload now; the career rows load async (empty until his first season completes at rollover).
  const seasonAvg = (p.seasonApps ?? 0) > 0 ? (p.seasonRatingSum ?? 0) / (p.seasonApps ?? 1) : null;
  const statTile = (label: string, val: string, big = false) => h('div', { style: 'min-width:64px;text-align:center' },
    h('div', { style: `font-size:${big ? 22 : 20}px;font-weight:800;font-variant-numeric:tabular-nums` }, val),
    h('div', { class: 'muted', style: 'font-size:11px' }, label));
  const careerBody = h('div', { class: 'muted', style: 'font-size:12px' }, 'Loading career…');
  const statsCard = h('div', { class: 'card' },
    h('div', { class: 'section-title', style: 'margin-top:0' }, 'This season'),
    h('div', { class: 'row', style: 'gap:20px;flex-wrap:wrap' },
      statTile('Apps', String(p.seasonApps ?? 0)),
      statTile('Goals', String(p.seasonGoals ?? 0)),
      statTile('Assists', String(p.seasonAssists ?? 0)),
      statTile('Avg rating', seasonAvg != null ? seasonAvg.toFixed(1) : '—', true)),
    h('div', { class: 'section-title' }, 'Career'),
    careerBody);
  // load the career table into its placeholder (kept out of the initial mount so the profile paints fast)
  api.playerCareer(slot).then(r => {
    if (!alive()) return;
    if (!r.career.length) { careerBody.replaceChildren(h('div', { class: 'muted', style: 'font-size:12px' }, 'No completed seasons yet — his career table fills in at the end of each season.')); return; }
    const th = (t: string, left = false) => h('th', { style: `text-align:${left ? 'left' : 'right'};padding:3px 8px;font-size:11px;font-weight:600;color:var(--muted)` }, t);
    const td = (v: string, left = false, style = '') => h('td', { style: `text-align:${left ? 'left' : 'right'};padding:3px 8px;font-size:13px;font-variant-numeric:tabular-nums;${style}` }, v);
    // career totals across the archived seasons (weighted average rating by apps)
    const tot = r.career.reduce((a, s) => ({ apps: a.apps + s.apps, goals: a.goals + s.goals, assists: a.assists + s.assists, ratedApps: a.ratedApps + (s.avgRating > 0 ? s.apps : 0), ratingSum: a.ratingSum + s.avgRating * s.apps }), { apps: 0, goals: 0, assists: 0, ratedApps: 0, ratingSum: 0 });
    const totAvg = tot.ratedApps > 0 ? (tot.ratingSum / tot.ratedApps).toFixed(1) : '—';
    careerBody.replaceChildren(h('div', { style: 'overflow-x:auto' }, h('table', { style: 'width:100%;border-collapse:collapse' },
      h('thead', {}, h('tr', { style: 'border-bottom:1px solid var(--line)' }, th('Season', true), th('Club', true), th('Apps'), th('Goals'), th('Assists'), th('Avg'))),
      h('tbody', {},
        ...r.career.map((s: PlayerSeasonStatT) => h('tr', { style: 'border-bottom:1px solid var(--line)' },
          td(`S${s.season}`, true), td(s.club, true, 'color:var(--muted)'), td(String(s.apps)), td(String(s.goals)), td(String(s.assists)), td(s.avgRating > 0 ? s.avgRating.toFixed(1) : '—'))),
        r.career.length > 1 ? h('tr', { style: 'font-weight:700' }, td('Total', true), td('', true), td(String(tot.apps)), td(String(tot.goals)), td(String(tot.assists)), td(totAvg)) : ''))));
  }).catch(() => { if (alive()) careerBody.replaceChildren(h('div', { class: 'muted', style: 'font-size:12px' }, 'Career history unavailable.')); });

  // §attr-progression: the Development graph — an attribute (or overall) plotted over every matchday the
  // squad trained (attr_snapshots, one point per developed matchday). Loads async; needs ≥2 points to draw.
  const progBody = h('div', { class: 'muted', style: 'font-size:12px' }, 'Loading development…');
  const progressionCard = h('div', { class: 'card' },
    h('div', { class: 'section-title', style: 'margin-top:0' }, 'Development graph'), progBody);
  api.playerProgression(slot).then(r => {
    if (!alive()) return;
    const snaps = r.progression;
    if (snaps.length < 2) { progBody.replaceChildren(h('div', { class: 'muted', style: 'font-size:12px' }, 'Not enough history yet — his line fills in as the squad trains each matchday.')); return; }
    const series = [{ key: 'ovr', label: 'Overall' }, ...SQUAD_ATTRS.map(([k, abbr]) => ({ key: k, label: abbr }))];
    const sel = h('select', { style: 'width:auto;font-size:12px;padding:3px 6px', 'aria-label': 'Attribute to graph' }, ...series.map(s => h('option', { value: s.key }, s.label))) as HTMLSelectElement;
    const chartHost = h('div', {});
    const valAt = (snap: typeof snaps[number], key: string): number => key === 'ovr' ? snap.ovr : Math.round(snap.attrs[key] ?? 0);
    const drawChart = () => {
      const key = sel.value, label = series.find(s => s.key === key)?.label ?? key;
      const vals = snaps.map(s => valAt(s, key));
      const lo = Math.max(0, Math.min(...vals) - 2), hi = Math.min(99, Math.max(...vals) + 2);
      const CW = 320, CH = 90, pad = 8;
      const px = (i: number) => pad + (i / (snaps.length - 1)) * (CW - 2 * pad);
      const py = (v: number) => (CH - pad) - ((v - lo) / Math.max(1, hi - lo)) * (CH - 2 * pad);
      const pts = vals.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ');
      const svg = svgEl('svg', { viewBox: `0 0 ${CW} ${CH}`, width: '100%', style: 'display:block;overflow:visible;max-width:620px;margin:0 auto' },
        svgEl('polyline', { points: pts, fill: 'none', stroke: 'var(--accent,#4ea1ff)', 'stroke-width': 2, 'stroke-linejoin': 'round' }),
        svgEl('circle', { cx: String(px(snaps.length - 1)), cy: String(py(vals[vals.length - 1])), r: '3', fill: 'var(--accent,#4ea1ff)' }));
      const delta = vals[vals.length - 1] - vals[0];
      chartHost.replaceChildren(
        h('div', { style: 'display:flex;justify-content:space-between;align-items:baseline;font-size:11px;margin-bottom:3px' },
          h('span', { class: 'muted' }, `S${snaps[0].season} R${snaps[0].round}`),
          h('span', { style: `font-weight:700;color:${delta > 0 ? 'var(--accent)' : delta < 0 ? '#e8896b' : 'var(--muted)'}` }, `${label} ${vals[vals.length - 1]}${delta !== 0 ? ` (${delta > 0 ? '+' : ''}${delta})` : ''}`),
          h('span', { class: 'muted' }, `S${snaps[snaps.length - 1].season} R${snaps[snaps.length - 1].round}`)),
        svg);
    };
    sel.addEventListener('change', drawChart);
    progBody.replaceChildren(
      h('div', { class: 'row', style: 'gap:8px;align-items:center;margin-bottom:6px' }, h('span', { class: 'muted', style: 'font-size:12px' }, 'Track'), sel,
        h('span', { class: 'muted', style: 'font-size:11px' }, `· ${snaps.length} matchdays`)),
      chartHost);
    drawChart();
  }).catch(() => { if (alive()) progBody.replaceChildren(h('div', { class: 'muted', style: 'font-size:12px' }, 'Development history unavailable.')); });

  if (!alive()) return;
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
          : h('div', { class: 'muted', style: 'font-size:12px' }, `Match fitness ${p.fitness ?? 100}%${p.morale != null ? ` · Morale ${p.morale}` : ''}`),
        // Development state (focus / intensity / retraining) + a "seeking a move" flag — both were only
        // visible on other screens; the profile is where a manager reads a single player, so surface them here.
        trainingSummary(p) ? h('div', { class: 'muted', style: 'font-size:12px' }, `🎯 ${trainingSummary(p)}`) : '',
        devOutlook ? h('div', { class: 'muted', style: `font-size:12px;color:${devOutlook.color}` }, `${devOutlook.icon} ${devOutlook.text}`) : '',
        seekingMove(p) ? h('div', { style: 'font-size:12px;margin-top:2px' },
          h('span', { class: 'pill', title: 'Running down his contract and unsettled — likely to push for a move', style: 'background:var(--danger);color:#fff;font-size:9px' }, 'seeking a move')) : ''),
      h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, '← Back'),
    ),
    h('div', { class: 'grid cols-2', style: 'align-items:start' },
      h('div', { class: 'card' },
        h('div', { class: 'between', style: 'align-items:baseline' },
          h('div', { class: 'section-title', style: 'margin-top:0' }, 'Attributes'),
          sameRole.length > 1 ? h('span', { class: 'muted', style: 'font-size:11px' }, `± vs your ${sameRole.length} ${p.role}s` ) : ''),
        h('div', { class: 'grid cols-2', style: 'gap:0 22px' },
          ...ATTR_LABELS.map(a => {
            const v = p.attrs[a.key] ?? 0;
            // delta vs the squad average for this position — "is he a strong CB for MY squad?" (FM's role context)
            const dRaw = sameRole.length > 1 ? Math.round(v - roleAvg(a.key)) : null;
            const note = dRaw != null
              ? h('span', { style: `font-size:10px;margin-left:6px;color:${dRaw > 0 ? 'var(--accent)' : dRaw < 0 ? '#e8896b' : 'var(--muted)'}` }, `${dRaw > 0 ? '+' : ''}${dRaw}`)
              : undefined;
            return traitBar(a.label, v, attrTierColor(v), note);
          })),
      ),
      interactCard),
    statsCard,
    progressionCard,
    devCard,
    h('div', { class: 'grid cols-2', style: 'align-items:start' },
      h('div', { class: 'card' }, h('div', { class: 'section-title', style: 'margin-top:0' }, 'Personality dials'), traitsEl),
      h('div', { class: 'card' },
        h('div', { class: 'section-title', style: 'margin-top:0' }, 'Backstory'),
        h('div', { class: 'muted', style: 'font-size:12px;margin-bottom:8px' }, 'These dials are read off the backstory — and the player’s training rate and transfer value read the dials. Rewrite the story and the numbers re-derive.'),
        h('div', { class: 'field' }, h('label', { for: 'f-backstory' }, 'Backstory'), back),
        h('div', { class: 'field' }, h('label', { for: 'f-tagline' }, 'Tagline'), tag),
        h('div', { class: 'row', style: 'align-items:center;gap:10px' }, save, valEl),
      ),
    ),
  ));
}

// ── cup (knockout bracket) ──
async function screenCup() {
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading…')));
  let cup: CupT;
  try { cup = await api.cup(); }
  catch (e: any) { if (String(e.message).includes('no team')) return screenCreateTeam(); if (!alive()) return; return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message))); }
  if (!cup.rounds.length) return mount(header(), h('div', { class: 'wrap grid' },
    h('div', { class: 'between' }, h('h2', {}, 'Cup'), h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, '← Back')),
    h('div', { class: 'card muted' }, 'No cup this season.')));

  const teamRow = (name: string | null, score: number | null, won: boolean, isMe: boolean) =>
    h('div', { class: 'between', style: `font-size:12px;gap:10px;${won ? 'font-weight:700;' : 'opacity:.7;'}${isMe ? 'color:var(--accent,#4ea1ff);' : ''}` },
      h('span', {}, name ?? 'TBD'), h('span', {}, score != null ? String(score) : ''));
  const cols = cup.rounds.map(rd => h('div', { style: 'min-width:170px' },
    h('div', { class: 'section-title', style: 'margin-top:0' }, rd.name),
    ...rd.ties.map(t => {
      // Only YOUR ties carry a recording (human stake), so Watch/Report show on played ties you were in.
      const mine = t.homeTeamId === cup.myTeamId || t.awayTeamId === cup.myTeamId;
      return h('div', { class: 'card', style: 'padding:8px;margin-bottom:8px' },
        teamRow(t.home, t.homeScore, t.winnerTeamId != null && t.winnerTeamId === t.homeTeamId, t.homeTeamId === cup.myTeamId),
        teamRow(t.away, t.awayScore, t.winnerTeamId != null && t.winnerTeamId === t.awayTeamId, t.awayTeamId === cup.myTeamId),
        mine && t.played ? h('div', { class: 'row', style: 'gap:6px;margin-top:6px' },
          h('button', { class: 'ghost small', title: 'Watch this cup tie back', onclick: () => (location.hash = `#/watch/${t.id}?cup=1`) }, '▶ Watch'),
          h('button', { class: 'ghost small', title: 'Read the match report', onclick: () => (location.hash = `#/report/${t.id}?cup=1`) }, 'Report')) : '');
    })));

  if (!alive()) return;
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
function shoutReviewCard(tac: TacticsReviewT, fixtureId: number): HTMLElement | string {
  if (!tac.shouts.length) return '';
  const changed = (s: ShoutReviewT): string => {
    const bits = [`${s.directives} instruction${s.directives === 1 ? '' : 's'}`];
    if (s.formationChange) bits.push('formation change');
    if (s.morale) bits.push(`${s.morale} player${s.morale === 1 ? '' : 's'} rallied`);
    return bits.join(' · ');
  };
  return h('div', { class: 'card', style: 'margin-top:10px' },
    h('div', { class: 'between', style: 'margin-bottom:2px' },
      h('div', { class: 'section-title', style: 'margin:0' }, '📣 Your shouts this match'),
      // Re-sim the match from this command log (deterministic) and watch it play back, paced.
      h('button', { class: 'ghost small', title: 'Re-simulate the match from these shouts and watch it back', onclick: () => (location.hash = `#/watch/${fixtureId}?shouts=1`) }, '▶ Replay from shouts')),
    ...tac.shouts.map(s => h('div', { style: 'padding:5px 0;border-top:1px solid var(--line)' },
      h('div', { style: 'font-size:13px' }, h('span', { class: 'muted', style: 'font-variant-numeric:tabular-nums' }, `${s.minute}' `), `“${s.text}”`),
      h('div', { class: 'muted', style: 'font-size:11px;margin-top:2px' }, changed(s)))));
}

async function screenReport(fixtureId: number, cup = false) {
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Reading the match…')));
  // A cup tie's replay is spectator-only (no shout log / tactics endpoint keyed by tie id), so the
  // shout review is a league-fixture concept — skip it (and its fetch) for cup reports.
  const watchSuffix = cup ? '?cup=1' : '';
  const tacP = cup ? Promise.resolve<TacticsReviewT>({ shouts: [] })
    : api.tactics(fixtureId).catch((): TacticsReviewT => ({ shouts: [] }));
  let rep: ReportT;
  try { rep = await api.report(fixtureId, cup); }
  catch (e: any) {
    const tac = await tacP;
    const msg = String(e.message).includes('no recording')
      ? "No report yet — this match wasn't recorded (play or watch it first)."
      // a past-season fixture is purged at rollover, so an old inbox 'report' deep-link 404s here
      : String(e.message).includes('not found')
        ? "This report is no longer available — matches from past seasons are cleared when the season rolls over."
        : e.message;
    if (!alive()) return;
    return mount(header(), h('div', { class: 'wrap grid' },
      h('div', { class: 'between' }, h('h2', {}, 'Match report'), h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, '← Back')),
      h('div', { class: 'card muted' }, msg),
      cup ? '' : shoutReviewCard(tac, fixtureId)));
  }
  const tac = await tacP;

  const icon = (t: string) => t === 'goal' ? '⚽' : t === 'red' ? '🟥' : t === 'penalty' ? '🎯' : t === 'woodwork' ? '🪵' : '🟨';
  const evClock = (e: TimelineEventT): number => typeof e.clockMs === 'number' ? e.clockMs : Math.max(0, ((e.minute ?? 1) - 1) * 60000);
  const HOME_C = '#ff8a8a', AWAY_C = '#9ecbff';   // the renderer's banner colours — home/away read the same everywhere

  // ── scoreboard: the result at a glance, scorers + reds under each side (the prose stays below) ──
  const sideEvents = (team: 'home' | 'away') => rep.facts.timeline
    .filter(e => e.team === team && (e.type === 'goal' || e.type === 'red'))
    .map(e => h('div', { class: 'muted', style: 'font-size:12px;padding:1px 0' }, `${icon(e.type)} ${e.name} ${e.minute}'`));
  const scoreboard = h('div', { class: 'card' },
    h('div', { style: 'display:flex;align-items:baseline;justify-content:center;gap:18px;flex-wrap:wrap' },
      h('div', { style: `flex:1;min-width:120px;text-align:right;font-weight:700;color:${HOME_C}` }, rep.homeName),
      h('div', { style: 'font-size:34px;font-weight:800;font-variant-numeric:tabular-nums;letter-spacing:1px' }, `${rep.facts.homeScore} — ${rep.facts.awayScore}`),
      h('div', { style: `flex:1;min-width:120px;font-weight:700;color:${AWAY_C}` }, rep.awayName)),
    h('div', { style: 'display:flex;gap:18px;margin-top:6px' },
      h('div', { style: 'flex:1;text-align:right' }, ...sideEvents('home')),
      h('div', { style: 'width:60px' }),
      h('div', { style: 'flex:1' }, ...sideEvents('away'))));

  // ── the match on one strip: every moment positioned at its REAL clock, home above / away below the
  //    spine. Click any marker → the replay AT that moment (#/watch/id?t=). ──
  const lastClock = rep.facts.timeline.reduce((m, e) => Math.max(m, evClock(e)), 0);
  const stripDur = Math.max(90 * 60000, lastClock + 90000);
  const stripMark = (e: TimelineEventT) => {
    const pct = Math.min(99, Math.max(1, (evClock(e) / stripDur) * 100));
    return h('button', {
      class: 'ghost', title: `${e.minute}' ${e.name} — watch this moment`,
      style: `position:absolute;left:${pct}%;${e.team === 'home' ? 'bottom:52%' : 'top:52%'};transform:translateX(-50%);border:none;background:none;padding:1px 2px;font-size:15px;line-height:1;cursor:pointer`,
      onclick: () => (location.hash = `#/watch/${fixtureId}?t=${Math.max(0, evClock(e) - 5000)}${cup ? '&cup=1' : ''}`),
    }, icon(e.type));
  };
  const stripTick = (pct: number, lab: string) => [
    h('span', { style: `position:absolute;left:${pct}%;top:46%;bottom:46%;width:1px;background:var(--line)` }),
    h('span', { class: 'muted', style: `position:absolute;left:${pct}%;top:100%;transform:translate(-50%,-14px);font-size:10px` }, lab)];
  const timeline = rep.facts.timeline.length
    ? h('div', { class: 'card', style: 'margin-top:10px' },
        h('div', { class: 'between', style: 'margin-bottom:2px' },
          h('div', { class: 'section-title', style: 'margin:0' }, 'Timeline'),
          h('span', { class: 'muted', style: 'font-size:11px' }, `${rep.homeName} above · ${rep.awayName} below · click a moment to watch it`)),
        h('div', { style: 'position:relative;height:64px' },
          h('div', { style: 'position:absolute;left:0;right:0;top:50%;height:2px;background:var(--line)' }),
          ...stripTick(0.5, "0'"), ...stripTick((45 * 60000 / stripDur) * 100, 'HT'), ...stripTick((90 * 60000 / stripDur) * 100, 'FT'),
          ...rep.facts.timeline.map(stripMark)))
    : '';

  // ── head-to-head bars: the split stats, mirrored around the centre ──
  const statBar = (label: string, hv: number, av: number, fmt = (n: number) => String(n)) => {
    const total = Math.max(1, hv + av);
    return h('div', { style: 'margin:7px 0' },
      h('div', { style: 'display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px' },
        h('span', { style: 'font-variant-numeric:tabular-nums;font-weight:600' }, fmt(hv)), h('span', { class: 'muted' }, label), h('span', { style: 'font-variant-numeric:tabular-nums;font-weight:600' }, fmt(av))),
      h('div', { style: 'display:flex;height:6px;border-radius:3px;overflow:hidden;background:var(--line)' },
        h('div', { style: `width:${(hv / total) * 100}%;background:${HOME_C}` }),
        h('div', { style: `width:${(av / total) * 100}%;background:${AWAY_C}` })));
  };

  // ratings, one column per side, best first
  const ratingsCol = (team: 'home' | 'away', label: string) => {
    const cleanSheet = (team === 'home' ? rep.facts.awayScore : rep.facts.homeScore) === 0;   // this side conceded nothing
    return h('div', { style: 'flex:1;min-width:200px' },
      h('div', { class: 'section-title', style: 'margin-top:0' }, label),
      ...rep.ratings.filter(r => r.team === team).sort((a, b) => b.rating - a.rating).map(r => {
        const tag = (n: number, s: string, title: string) => n > 0 ? h('span', { class: 'pill', title, style: 'margin-left:4px' }, `${n}${s}`) : '';
        // heat: 4.0 red → 9.0 green (same hsl ramp as the squad attribute heat) — the whole column reads at a glance
        const hue = Math.max(0, Math.min(120, Math.round(((r.rating - 4) / 5) * 120)));
        const cs = (cleanSheet && r.role === 'GK') ? h('span', { class: 'pill', title: 'Clean sheet', style: 'margin-left:4px' }, '🧤') : '';
        return h('div', { class: 'between', style: 'font-size:13px;padding:2px 0' },
          h('span', {}, `${r.name} `, h('span', { class: 'muted', style: 'font-size:11px' }, r.role),
            tag(r.goals, '⚽', 'Goals'), tag(r.assists, '🅰', 'Assists'), tag(r.shots, '🎯', 'Shots'), tag(r.tackles, '🛡', 'Tackles'), cs),
          h('span', { style: `font-weight:700;font-variant-numeric:tabular-nums;color:hsl(${hue},70%,62%)` }, r.rating.toFixed(1)));
      }));
  };

  const f = rep.facts;
  // Man of the Match — the highest match rating across both sides (a staple report headline).
  const motm = [...rep.ratings].sort((a, b) => b.rating - a.rating)[0];
  if (!alive()) return;
  mount(header(), h('div', { class: 'wrap grid' },
    h('div', { class: 'between' }, h('h2', {}, rep.headline),
      // From the report you can jump straight into the replay (now with rewind/scrub) — no hunting for
      // the fixture back on the dashboard.
      h('div', { class: 'row' },
        h('button', { class: 'ghost', title: 'Watch this match back — rewind and scrub to any moment', onclick: () => (location.hash = `#/watch/${fixtureId}${watchSuffix}`) }, '▶ Watch replay'),
        h('button', { class: 'ghost', onclick: () => (location.hash = cup ? '#/cup' : '#/') }, '← Back'))),
    scoreboard,
    timeline,
    h('div', { class: 'grid cols-2', style: 'align-items:start;margin-top:10px' },
      h('div', { class: 'card' },
        h('div', { style: 'white-space:pre-wrap;line-height:1.5' }, rep.body)),
      h('div', { class: 'card' },
        h('div', { class: 'section-title', style: 'margin-top:0' }, 'Head to head'),
        statBar('Possession', f.possessionHome, 100 - f.possessionHome, n => `${n}%`),
        statBar('Shots', f.shots.home, f.shots.away),
        h('div', { class: 'muted', style: 'margin-top:8px;font-size:12px' },
          `${f.shotsOnTarget} on target · ${f.saves} saves · ${f.corners} corners`))),
    h('div', { class: 'card', style: 'margin-top:10px' },
      h('div', { class: 'between', style: 'align-items:center;flex-wrap:wrap;gap:8px' },
        h('div', { class: 'section-title', style: 'margin-top:0' }, 'Player ratings'),
        motm ? h('span', { class: 'pill', title: 'Highest match rating', style: 'background:var(--gold,#e8b53a);color:#1a1205;font-weight:700' }, `⭐ Man of the Match — ${motm.name} (${motm.team === 'home' ? rep.homeName : rep.awayName}) ${motm.rating.toFixed(1)}`) : ''),
      h('div', { style: 'display:flex;gap:24px;flex-wrap:wrap' }, ratingsCol('home', rep.homeName), ratingsCol('away', rep.awayName))),
    cup ? '' : shoutReviewCard(tac, fixtureId),
  ));
}

// ── club finances ──
const FIN_LABEL: Record<string, string> = {
  prize: 'Prize money', transfer_in: 'Transfers in', transfer_out: 'Transfers out',
  staff: 'Staff fees', sponsor: 'Sponsorship', gate: 'Gate & TV', other: 'Other',
};
async function screenFinances() {
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading…')));
  let f: FinancesT;
  try { f = await api.finances(); }
  catch (e: any) {
    if (String(e.message).includes('no team')) return screenCreateTeam();
    if (!alive()) return;
    return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message)));
  }
  const net = f.income + f.expense;   // expense is already negative
  // zero is NEUTRAL — never a misleading "+£0" in green on an expense/empty line (income +, expense −, zero plain)
  const col = (n: number) => n > 0 ? 'color:var(--accent)' : n < 0 ? 'color:var(--danger)' : 'color:var(--muted)';
  const signed = (n: number) => n > 0 ? '+' + fmtMoney(n) : n < 0 ? '−' + fmtMoney(Math.abs(n)) : fmtMoney(0);
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

  if (!alive()) return;
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
          h('td', { class: 'num', style: s.income !== 0 ? 'color:var(--accent)' : 'color:var(--muted)' }, signed(s.income)),
          h('td', { class: 'num', style: s.expense !== 0 ? 'color:var(--danger)' : 'color:var(--muted)' }, signed(s.expense)),
          h('td', { class: 'num', style: 'font-weight:700;' + col(s.net) }, signed(s.net))))))) : '',
  ));
}

// ── backroom staff ──
const ROLE_ICON: Record<string, string> = { coach: '🎓', physio: '🩺', scout: '🔍' };
const ROLE_LABEL: Record<string, string> = { coach: 'Coach', physio: 'Physio', scout: 'Scout' };
async function screenStaff() {
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading…')));
  let v: StaffViewT;
  try { v = await api.staff(); }
  catch (e: any) {
    if (String(e.message).includes('no team')) return screenCreateTeam();
    if (!alive()) return;
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

    // Coaching focus board: assign coaches to a category → those attributes grow faster (the +% rises). Unassigned
    // categories use the flat club coaching factor (byte-identical to before the feature).
    const coaches = v.staff.filter(s => s.role === 'coach');
    const clampStar = (n: number) => Math.round(Math.max(0, Math.min(5, n)));
    const starStr = (n: number) => '★'.repeat(clampStar(n)) + '☆'.repeat(5 - clampStar(n));
    const factorColor = (f: number) => f > 1.02 ? 'var(--accent)' : f < 0.98 ? 'var(--danger)' : 'var(--muted)';
    const boardCard = h('div', { class: 'card' },
      h('div', { class: 'section-title', style: 'margin-top:0' }, 'Coaching focus'),
      h('div', { class: 'muted', style: 'font-size:12px;margin-bottom:4px' }, coaches.length
        ? 'Assign a coach to a category to sharpen those attributes faster. Unassigned categories use your flat club coaching.'
        : 'Hire coaches, then assign them to categories here to specialise your training.'),
      ...(v.categories ?? []).map(c => {   // ?? [] = graceful if the shared :4000 hasn't restarted onto the new staff view yet
        const sel = h('select', { class: 'small', multiple: 'true', size: String(Math.max(2, Math.min(coaches.length, 4))), style: 'min-width:150px' }) as HTMLSelectElement;
        for (const coach of coaches) {
          const o = h('option', { value: String(coach.id) }, `${coach.name} · ${coach.rating}`) as HTMLOptionElement;
          if (c.assigned.includes(coach.id)) o.selected = true;
          sel.append(o);
        }
        sel.addEventListener('change', async () => {
          const assignment: Record<string, number[]> = Object.fromEntries(v.categories.map(cc => [cc.category, [...cc.assigned]]));
          assignment[c.category] = [...sel.selectedOptions].map(o => Number(o.value));
          try { v = await api.saveCoachAssignment(assignment); toast(`${c.category} coaching updated`); render(); } catch (er: any) { toast(er.message); }
        });
        return h('div', { class: 'between', style: 'padding:7px 0;border-top:1px solid var(--line);gap:12px;align-items:center' },
          h('div', { style: 'min-width:96px' },
            h('div', { style: 'font-weight:600;font-size:13px' }, c.category),
            h('div', { class: 'muted', style: 'font-size:11px' }, c.assigned.length ? `${starStr(c.stars)} · cover ${Math.round(c.coverage * 100)}%` : 'flat club coaching')),
          h('div', { style: 'font-size:16px;font-weight:800;min-width:52px;text-align:center;color:' + factorColor(c.factor) }, `${c.factor >= 1 ? '+' : ''}${Math.round((c.factor - 1) * 100)}%`),
          coaches.length ? sel : h('span', { class: 'muted', style: 'font-size:11px' }, '—'));
      }),
    );

    if (!alive()) return;
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
      boardCard,
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
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Scouting the opposition…')));
  let s: ScoutT;
  try { s = await api.scout(fixtureId); }
  catch (e: any) {
    if (String(e.message).includes('no team')) return screenCreateTeam();
    if (!alive()) return;
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

  const ATTR_ABBR: Record<string, string> = { speed: 'SPD', passing: 'PAS', creativity: 'CRE', shooting: 'SHO', tackling: 'TAC', positioning: 'POSN', stamina: 'STA' };
  const playerRow = (p: ScoutPlayerT) => h('div', { style: 'padding:4px 0;border-bottom:1px solid var(--line)' },
    h('div', { class: 'between', style: 'font-size:13px' },
      h('span', {}, p.danger ? h('span', { title: 'danger man', style: 'margin-right:5px' }, '⚠️') : '',
        p.name, h('span', { class: 'muted', style: 'font-size:11px' }, ` ${p.role} · ${p.age}y`)),
      h('span', { style: p.danger ? 'font-weight:700;color:var(--gold)' : '' },
        `OVR ${p.overall}${p.potential && p.potential > p.overall ? ` → ${p.potential}` : ''}`)),
    // scouted attribute fog — ranges that tighten with scout quality (exact at full depth)
    p.attrs ? h('div', { class: 'muted', style: 'font-size:11px;margin-top:2px' },
      p.attrs.map(a => `${ATTR_ABBR[a.key] ?? a.key} ${a.lo === a.hi ? a.lo : `${a.lo}–${a.hi}`}`).join(' · ')) : '');
  const players = s.keyPlayers.length ? s.keyPlayers.map(playerRow)
    : [h('div', { class: 'muted', style: 'font-size:13px' }, s.bench.length ? 'No likely XI scouted yet — see the rest of the squad below.' : 'Squad not available.')];
  const scoutHint = s.keyPlayers.length && !s.keyPlayers[0].attrs
    ? h('div', { class: 'muted', style: 'margin:-4px 0 8px;font-size:11px' }, 'Hire scouts (Staff) to reveal their players’ attributes + scout deeper into the squad.')
    : '';
  // Turn the read-only scout into an ACTION: compose an opposition instruction (man-marking the flagged
  // danger men) and append it to the standing plain-English plan. Matches the plan-as-source-of-truth design
  // (the compiler assigns a marker); confirmed first because it recompiles the plan.
  const dangerNames = s.keyPlayers.filter(p => p.danger).map(p => p.name);
  const markBtn = dangerNames.length
    ? h('button', { class: 'ghost small', title: 'Add a man-marking instruction for the danger man to your tactical plan' },
        dangerNames.length > 1 ? '🎯 Man-mark them' : `🎯 Man-mark ${dangerNames[0].split(' ').slice(-1)[0]}`) as HTMLButtonElement
    : '';
  if (markBtn instanceof HTMLButtonElement) {
    markBtn.addEventListener('click', async () => {
      const sentence = dangerNames.length === 1
        ? `keep their danger man ${dangerNames[0]} quiet — man-mark him tightly`
        : `man-mark their danger men (${dangerNames.join(', ')}) tightly`;
      if (!await confirmModal('Add to your standing plan?', `This appends an opposition instruction to your tactical plan and recompiles it:\n\n“${sentence}”`, 'Add to plan')) return;
      markBtn.setAttribute('disabled', 'true'); const label = markBtn.textContent; markBtn.textContent = 'Updating plan…';
      try {
        const team = await api.team();
        const base = (team.planText ?? '').trim().replace(/[.\s]*$/, '');
        const r = await api.teamPlan(base ? `${base}. ${sentence}` : sentence);
        toast(r.error ? 'Saved, but couldn’t compile it — refine on the Tactics screen.' : '✓ Added to your plan');
      } catch (e: any) { toast(e.message); }
      finally { markBtn.removeAttribute('disabled'); markBtn.textContent = label; }
    });
  }
  // §2.8 bench tier — the squad behind the XI, a fuzzier read; only present once you have some intel.
  const benchCard = s.bench.length
    ? h('div', { class: 'card' },
        h('div', { class: 'section-title', style: 'margin-top:0' }, 'Rest of the squad'),
        h('div', { class: 'muted', style: 'margin:-4px 0 8px;font-size:12px' }, 'Bench & squad players — a fuzzier read than the likely XI; it sharpens with better scouts and as the fixture nears.'),
        ...s.bench.map(playerRow))
    : '';

  if (!alive()) return;
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
          h('div', { class: 'between', style: 'align-items:center' },
            h('div', { class: 'section-title', style: 'margin-top:0' }, 'Danger men'),
            markBtn),
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
// ── manager career: the manager's CV aggregated across every club managed ──
async function screenCareer() {
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading your career…')));
  let c: ManagerCareerT;
  try { c = await api.career(); }
  catch (e: any) {
    if (String(e.message).includes('no team')) return screenCreateTeam();
    if (!alive()) return;
    return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message)));
  }
  const stat = (label: string, val: string | number, sub?: string) => h('div', { class: 'card', style: 'padding:12px 16px;min-width:118px' },
    h('div', { style: 'font-size:24px;font-weight:700' }, String(val)),
    h('div', { class: 'muted', style: 'font-size:12px' }, label),
    sub ? h('div', { class: 'muted', style: 'font-size:11px;margin-top:2px' }, sub) : '');
  const body = c.seasons === 0
    ? h('div', { class: 'card' }, h('div', { class: 'muted' }, 'No completed seasons yet — play through a season and your managerial record will build here.'))
    : h('div', {},
        h('div', { class: 'row', style: 'gap:12px;flex-wrap:wrap;margin-bottom:14px' },
          stat('Seasons', c.seasons, c.clubs > 1 ? `${c.clubs} clubs` : undefined),
          stat('Record', `${c.won}-${c.drawn}-${c.lost}`, `${c.played} games`),
          stat('Win rate', `${c.winPct}%`),
          stat('Points', c.points),
          // GF/GA were returned by /api/career but never shown — a manager's goals-for/against + difference.
          stat('Goals', `${c.gf}-${c.ga}`, `${c.gf - c.ga >= 0 ? '+' : ''}${c.gf - c.ga} GD`)),
        h('div', { class: 'card', style: 'margin-bottom:14px' },
          h('div', { class: 'section-title', style: 'margin-top:0' }, 'Honours'),
          h('div', { class: 'row', style: 'gap:18px;flex-wrap:wrap' },
            trophy('🏆', c.titles, c.titles === 1 ? 'League title' : 'League titles'),
            trophy('🥇', c.cups, c.cups === 1 ? 'Cup' : 'Cups'),
            trophy('⬆️', c.promotions, 'Promotions'),
            trophy('⬇️', c.relegations, 'Relegations')),
          c.objectivesSet ? h('div', { class: 'muted', style: 'font-size:12px;margin-top:8px' },
            `Board objectives met: ${c.objectivesMet}/${c.objectivesSet}${c.bestFinish ? ` · Best finish: ${ordinal(c.bestFinish.position)} (${c.bestFinish.division}, S${c.bestFinish.season})` : ''}`) : ''),
        h('div', { class: 'card' },
          h('div', { class: 'section-title', style: 'margin-top:0' }, 'Clubs managed'),
          ...c.spells.map(s => h('div', { class: 'between', style: 'font-size:13px;padding:5px 0;border-top:1px solid var(--line)' },
            h('span', {}, h('b', {}, s.team), ' ', h('span', { class: 'muted', style: 'font-size:12px' }, `${s.from === s.to ? `S${s.from}` : `S${s.from}–S${s.to}`} · ${s.seasons} season${s.seasons === 1 ? '' : 's'}`)),
            h('span', { class: 'muted', style: 'font-size:12px' }, [s.titles ? `${s.titles}🏆` : '', s.promotions ? `${s.promotions}⬆️` : '', s.relegations ? `${s.relegations}⬇️` : ''].filter(Boolean).join('  ') || '—')))));
  // §P2#9 reputation badge — the synthesised media standing from the career CV (tier + blurb).
  const rep = c.reputation;
  const repBadge = rep ? (() => {
    const COLOR: Record<string, string> = { unproven: 'var(--muted,#8a93a6)', promising: '#7fb2ff', respected: 'var(--accent)', renowned: 'var(--gold)', elite: 'var(--gold)', legendary: '#ffd24a' };
    const col = COLOR[rep.tier] ?? 'var(--accent)';
    const icon = rep.tier === 'legendary' ? '👑' : rep.tier === 'elite' ? '⭐' : '★';
    return h('span', { class: 'pill', title: rep.blurb, style: `border:1px solid ${col};color:${col};font-weight:700;font-size:12px` }, `${icon} ${rep.label}`);
  })() : '';
  if (!alive()) return;
  mount(header(), h('div', { class: 'wrap grid' },
    h('div', { class: 'between' },
      h('div', { class: 'row', style: 'gap:10px;align-items:center' }, h('h2', { style: 'margin:0' }, 'Managerial career'), repBadge),
      h('button', { class: 'ghost small', onclick: () => (location.hash = '#/') }, '← Back')),
    rep ? h('div', { class: 'muted', style: 'font-size:12px;margin-top:-4px;font-style:italic' }, rep.blurb) : '',
    body));
}

async function screenHistory() {
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading history…')));
  let hist: SeasonHistoryT[]; let records: import('./api').ClubRecordsT | null = null;
  try { const r = await api.history(); hist = r.history; records = r.records; }
  catch (e: any) {
    if (String(e.message).includes('no team')) return screenCreateTeam();
    if (!alive()) return;
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

  if (!alive()) return;
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

// Persisted squad-table view state so a captain/rotation action (which reloads the whole screen) — or a
// return visit — keeps the user's chosen sort column/direction and the two compare picks. See screenSquad.
const squadView: { sortKey: string; sortDir: 1 | -1; cmpA: number; cmpB: number; q: string; roleF: string; attn: boolean } = { sortKey: 'slot', sortDir: 1, cmpA: -1, cmpB: -1, q: '', roleF: '', attn: false };
// ── squad spine screen: sortable attribute table + heat + depth chart + compare ──
async function screenSquad() {
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading squad…')));
  let team: TeamT;
  try { team = await api.team(); }
  catch (e: any) {
    if (String(e.message).includes('no team')) return screenCreateTeam();
    if (!alive()) return;
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

  let sortKey = squadView.sortKey, sortDir: 1 | -1 = squadView.sortDir, cmpA = squadView.cmpA, cmpB = squadView.cmpB;
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
      const sort = () => { if (sortKey === c.key) sortDir = (sortDir === 1 ? -1 : 1); else { sortKey = c.key; sortDir = c.text ? 1 : -1; } squadView.sortKey = sortKey; squadView.sortDir = sortDir; render(); };
      // a sortable column header: keep the columnheader role (don't override with role=button), add aria-sort + keyboard
      const th = h('th', {
        class: c.text ? '' : 'num', style: 'cursor:pointer;user-select:none', tabindex: '0', title: `Sort by ${c.label}`,
        'aria-sort': sortKey === c.key ? (sortDir === 1 ? 'ascending' : 'descending') : 'none',
        onclick: sort, onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sort(); } },
      }, c.label + (sortKey === c.key ? (sortDir === 1 ? ' ▲' : ' ▼') : ''));
      return th;
    })));
    // Position + "needs attention" filters apply at build time (so the rows in the DOM are the role/attn set);
    // the free-text search filters those rows IN PLACE (applyText below), so typing never remounts / loses focus.
    const needsAttention = (p: PlayerT): boolean =>
      (p.injuredMatches ?? 0) > 0 || (p.morale ?? 100) < 40 || seekingMove(p) || (p.contractYears ?? 9) <= 1;
    const matchesRoleAttn = (p: PlayerT): boolean =>
      (!squadView.roleF || p.role === squadView.roleF) && (!squadView.attn || needsAttention(p));
    // squad-strength summary (filter-independent — squad-wide read)
    const xi = players.filter(p => p.slot < 11);
    const xiOvr = xi.length ? Math.round(xi.reduce((s, p) => s + skillOvr(p.attrs), 0) / xi.length) : 0;
    const avgAge = players.length ? Math.round(players.reduce((s, p) => s + (p.age ?? 0), 0) / players.length) : 0;
    const attnCount = players.filter(needsAttention).length;
    const statChip = (label: string, val: string, color = '') => h('div', { style: 'min-width:84px' },
      h('div', { style: `font-size:20px;font-weight:700${color ? `;color:${color}` : ''}` }, val),
      h('div', { class: 'muted', style: 'font-size:11px' }, label));
    const strengthCard = h('div', { class: 'card', style: 'display:flex;gap:20px;flex-wrap:wrap;align-items:center' },
      statChip('XI avg OVR', String(xiOvr)),
      statChip('Squad avg age', `${avgAge}y`),
      statChip('Need attention', String(attnCount), attnCount ? '#ffb84d' : ''),
      (team.wageBill != null && team.wageBudget != null)
        ? statChip('Wage bill', `${fmtMoney(team.wageBill)}`, team.wageBill > team.wageBudget ? 'var(--danger)' : '') : '');
    const tbody = h('tbody');
    for (const p of sorted.filter(matchesRoleAttn)) {
      const ovr = skillOvr(p.attrs);
      const isCap = captainSlot === p.slot;
      // §2.11: a clickable armband — the captain shows 🧭, others a faint one; clicking names/clears the captain.
      const setCap = async () => {
        try { const r = await api.setCaptain(isCap ? -1 : p.slot); toast(r.captainSlot == null ? 'Captain reset to auto (top leader)' : `${p.name} takes the armband`); screenSquad(); }
        catch (err: any) { toast(err.message); }
      };
      const capArm = h('span', {
        title: isCap ? 'Club captain — click to reset to auto (highest leader)' : `Make ${p.name} captain`,
        'aria-label': isCap ? `${p.name} is club captain — reset captain to auto` : `Make ${p.name} club captain`,
        style: `cursor:pointer;margin-right:4px;${isCap ? '' : 'opacity:.25'}`,
        ...clickable(setCap),
      }, '🧭');
      tbody.append(h('tr', { class: p.slot < 11 ? 'me' : '', 'data-search': `${p.name} ${p.role}`.toLowerCase() },
        h('td', { style: 'white-space:nowrap' }, capArm,
          h('span', { style: 'cursor:pointer', ...clickable(() => (location.hash = `#/player/${p.slot}`)) }, p.name),
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
    // ── filter bar: free-text search (in-place, focus-preserving) + position + "needs attention" ──
    const countLabel = h('span', { class: 'muted', style: 'font-size:12px' });
    const applyText = () => {
      const q = squadView.q.trim().toLowerCase();
      let shown = 0;
      for (const tr of Array.from(tbody.children) as HTMLElement[]) {
        const hit = !q || (tr.getAttribute('data-search') ?? '').includes(q);
        tr.style.display = hit ? '' : 'none';
        if (hit) shown++;
      }
      countLabel.textContent = shown === players.length ? `${players.length} players` : `${shown} of ${players.length}`;
    };
    const qInput = h('input', { placeholder: 'Search name…', value: squadView.q, 'aria-label': 'Search squad by name', style: 'max-width:170px' }) as HTMLInputElement;
    qInput.addEventListener('input', () => { squadView.q = qInput.value; applyText(); });
    const roleSel = h('select', { 'aria-label': 'Filter by position', style: 'width:auto' },
      h('option', { value: '' }, 'All positions'),
      ...['GK', 'CB', 'FB', 'CM', 'WM', 'CF'].map(r => { const o = h('option', { value: r }, r) as HTMLOptionElement; if (squadView.roleF === r) o.selected = true; return o; })) as HTMLSelectElement;
    roleSel.addEventListener('change', () => { squadView.roleF = roleSel.value; render(); });
    const attnCb = h('input', { type: 'checkbox', 'aria-label': 'Show only players needing attention' }) as HTMLInputElement;
    attnCb.checked = squadView.attn;
    attnCb.addEventListener('change', () => { squadView.attn = attnCb.checked; render(); });
    const clearBtn = h('button', { class: 'ghost small', title: 'Clear filters' }, 'Clear');
    clearBtn.addEventListener('click', () => { squadView.q = ''; squadView.roleF = ''; squadView.attn = false; render(); });
    const filterBar = h('div', { class: 'row', style: 'gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:8px' },
      qInput, roleSel,
      h('label', { class: 'row', style: 'gap:5px;align-items:center;font-size:12px;cursor:pointer' }, attnCb, '🚨 Needs attention'),
      (squadView.q || squadView.roleF || squadView.attn) ? clearBtn : '', countLabel);
    applyText();   // apply the current text filter to the freshly-built rows
    // depth by position (● starter / ○ bench)
    const ROLE_ORDER = ['GK', 'CB', 'FB', 'CM', 'WM', 'CF'];
    const byRole = ROLE_ORDER.map(role => ({ role, ps: players.filter(p => p.role === role).sort((a, b) => a.slot - b.slot) })).filter(g => g.ps.length);
    // Thin-position flag: a role with no FIT bench cover has no like-for-like replacement for an injury/suspension
    // there — the exact squad-planning signal FM surfaces. Amber ⚠ on the heading + a hint (data already in hand).
    const depth = h('div', { class: 'row', style: 'gap:16px;flex-wrap:wrap;align-items:start' }, ...byRole.map(g => {
      const cover = g.ps.filter(p => p.slot >= 11 && (p.injuredMatches ?? 0) === 0).length;
      const thin = cover === 0;
      return h('div', { style: 'min-width:120px' },
        h('div', { class: 'muted', style: `font-size:11px;text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px${thin ? ';color:#ffb84d' : ''}`, title: thin ? 'No fit backup in this position — an injury or suspension here leaves no like-for-like cover' : '' }, `${g.role} · ${g.ps.length}${thin ? ' ⚠' : ''}`),
        ...g.ps.map(p => h('div', { style: 'font-size:12px;padding:1px 0;' + (p.slot < 11 ? '' : 'opacity:.55'), }, `${p.slot < 11 ? '●' : '○'} ${p.name} ${skillOvr(p.attrs)}`)));
    }));
    // compare
    const opt = (sel: number) => [h('option', { value: '-1' }, '— pick —'), ...players.map(p => { const o = h('option', { value: String(p.slot) }, `${p.name} (${p.role})`) as HTMLOptionElement; if (p.slot === sel) o.selected = true; return o; })];
    const selA = h('select', { 'aria-label': 'Compare — first player' }, ...opt(cmpA)) as HTMLSelectElement;
    const selB = h('select', { 'aria-label': 'Compare — second player' }, ...opt(cmpB)) as HTMLSelectElement;
    selA.addEventListener('change', () => { cmpA = Number(selA.value); squadView.cmpA = cmpA; render(); });
    selB.addEventListener('change', () => { cmpB = Number(selB.value); squadView.cmpB = cmpB; render(); });
    const pa = players.find(p => p.slot === cmpA), pb = players.find(p => p.slot === cmpB);
    // A headline metric row (OVR/POT/age/wage/morale/fit) — greens the better value where higher-is-better;
    // age/wage aren't "better/worse" so they stay uncoloured. Turns a bare attr diff into a real like-for-like.
    const cmpSummary = (label: string, va: number, vb: number, fmt: (n: number) => string, colour = true) => {
      const ga = colour && va !== vb && va > vb ? 'color:var(--accent);font-weight:700' : '';
      const gb = colour && va !== vb && vb > va ? 'color:var(--accent);font-weight:700' : '';
      return h('div', { class: 'row', style: 'gap:10px;align-items:center;font-size:12px;margin:3px 0;justify-content:center' },
        h('span', { class: 'num', style: 'width:56px;text-align:right;' + ga }, fmt(va)),
        h('span', { class: 'muted', style: 'width:44px;text-align:center' }, label),
        h('span', { class: 'num', style: 'width:56px;' + gb }, fmt(vb)));
    };
    const cmpFit = (p: PlayerT) => (p.injuredMatches ?? 0) > 0 ? -1 : (p.fitness ?? 100);
    const cmp = pa && pb
      ? h('div', {},
          cmpSummary('OVR', skillOvr(pa.attrs), skillOvr(pb.attrs), n => String(n)),
          cmpSummary('POT', pa.potential ?? skillOvr(pa.attrs), pb.potential ?? skillOvr(pb.attrs), n => String(n)),
          cmpSummary('Age', pa.age ?? 0, pb.age ?? 0, n => n ? `${n}y` : '—', false),
          cmpSummary('Wage', pa.wage ?? 0, pb.wage ?? 0, n => n ? fmtMoney(n) : '—', false),
          cmpSummary('Morale', pa.morale ?? 0, pb.morale ?? 0, n => String(n)),
          cmpSummary('Fit', cmpFit(pa), cmpFit(pb), n => n < 0 ? '🤕' : `${n}%`),
          h('div', { style: 'border-top:1px solid var(--line);margin:7px 0' }),
          ...SQUAD_ATTRS.map(([a, lab]) => h('div', { class: 'row', style: 'gap:10px;align-items:center;font-size:12px;margin:3px 0;justify-content:center' },
            h('span', { class: 'num', style: 'width:56px;text-align:right;' + attrHeat(pa.attrs[a] ?? 0) }, String(Math.round(pa.attrs[a] ?? 0))),
            h('span', { class: 'muted', style: 'width:44px;text-align:center' }, lab),
            h('span', { class: 'num', style: 'width:56px;' + attrHeat(pb.attrs[a] ?? 0) }, String(Math.round(pb.attrs[a] ?? 0))))))
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

    if (!alive()) return;
    mount(header(), h('div', { class: 'wrap grid' },
      h('div', { class: 'between' },
        h('div', {}, h('h2', {}, 'Squad'), h('div', { class: 'muted' }, `${players.length} players · ● starter / ○ bench · 🧭 captain (click the armband to set — a strong leader steadies squad morale) · click a header to sort`)),
        h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, '← Back')),
      strengthCard,
      h('div', { class: 'card' }, filterBar, h('div', { class: 'scroll-x' }, h('table', {}, thead, tbody))),
      h('div', { class: 'grid cols-2', style: 'align-items:start' }, conditionCard, rotationCard || h('div')),
      h('div', { class: 'grid cols-2', style: 'align-items:start' },
        h('div', { class: 'card' }, h('div', { class: 'section-title', style: 'margin-top:0' }, 'Depth by position'), depth),
        h('div', { class: 'card' }, h('div', { class: 'section-title', style: 'margin-top:0' }, 'Compare two players'),
          h('div', { class: 'row', style: 'gap:10px;margin-bottom:10px' }, selA, selB), cmp))));
  }
  render();
}

// ── match hubs: watch any game (viewer P1 #1/#2) ── the dashboard only surfaces next/last; these list
// the full history. Data is already served by /api/league (every fixture in the division); screenWatch
// handles any id (a recorded replay, else a live re-sim fallback).
function matchRow(f: FixtureT, withReport: boolean, rankOf?: (name: string) => number | undefined): HTMLElement {
  const wx = f.weather && f.weather !== 'clear'
    ? h('span', { class: 'pill', title: f.weather === 'rain' ? 'Wet pitch' : 'Windy', style: 'background:rgba(127,178,255,.14);color:#9ec5ff' }, f.weather === 'rain' ? '🌧' : '🌬')
    : '';
  // current league position next to each club (FM-style context for the result) — from the live standings
  const rank = (name: string): HTMLElement | string => { const r = rankOf?.(name); return r ? h('span', { class: 'muted', title: `League position ${r}`, style: 'font-size:10px;margin-left:4px' }, `#${r}`) : ''; };
  // Only a PLAYED fixture is watchable — opening an unplayed one would mark it played + live-re-sim it with
  // the (live-only) controls (P0 bug-fix #5). Unplayed shows "vs ⏳ scheduled", not a misleading 0–0 + Watch.
  const actions = f.played
    ? h('span', { class: 'fx-actions', style: 'display:flex;gap:6px;align-items:center' }, wx,
        h('button', { class: 'ghost small', title: 'Watch this match', onclick: () => (location.hash = `#/watch/${f.id}`) }, '▶ Watch'),
        withReport ? h('button', { class: 'ghost small', onclick: () => (location.hash = `#/report/${f.id}`) }, 'Report') : '')
    : h('span', { class: 'fx-actions', style: 'display:flex;gap:6px;align-items:center' }, wx, h('span', { class: 'muted', style: 'font-size:12px' }, '⏳ scheduled'));
  return h('div', { class: 'fx' + (f.involvesMe ? ' me' : '') },
    h('div', { class: 'h' }, f.home, rank(f.home)),
    f.played ? h('span', { class: 'sc' }, `${f.homeScore ?? 0}–${f.awayScore ?? 0}`) : h('span', { class: 'sc muted' }, 'vs'),
    h('div', {}, f.away, rank(f.away)),
    actions);
}

// teamName → current league position (1-based), from the position-ordered standings
function rankLookup(league: LeagueT): (name: string) => number | undefined {
  const byName = new Map(league.standings.map((s, i) => [s.name, i + 1]));
  return (name: string) => byName.get(name);
}

async function loadLeagueOr(fallback: (e: any) => void): Promise<LeagueT | null> {
  try { return await api.league(); }
  catch (e: any) { fallback(e); return null; }
}

async function screenMyMatches() {
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading…')));
  const league = await loadLeagueOr(e => {
    if (String(e.message).includes('no team')) screenCreateTeam();
    else mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message)));
  });
  if (!league) return;
  const mine = league.fixtures.filter(f => f.involvesMe && f.played).sort((a, b) => b.round - a.round);
  const rankOf = rankLookup(league);
  // ── upcoming fixtures with an opponent-difficulty read (from the live table) — FM's fixture planner ──
  const myId = league.myTeamId;
  const posById = new Map(league.standings.map((s, i) => [s.teamId, i + 1]));
  const nStand = Math.max(1, league.standings.length);
  const upcoming = league.fixtures.filter(f => f.involvesMe && !f.played).sort((a, b) => a.round - b.round).slice(0, 6);
  const diffPill = (oppPos?: number) => {
    if (!oppPos) return h('span', { class: 'muted', style: 'font-size:11px' }, '—');
    const frac = (oppPos - 1) / Math.max(1, nStand - 1);   // 0 = top of the table, 1 = bottom
    const [label, col] = frac < 0.25 ? ['Very tough', 'var(--danger)'] : frac < 0.45 ? ['Tough', '#ffb84d'] : frac < 0.7 ? ['Even', '#7fb2ff'] : ['Winnable', 'var(--accent)'];
    return h('span', { class: 'pill', title: `Opponent is ${ordinal(oppPos)} in the table`, style: `background:transparent;border:1px solid ${col};color:${col};font-size:10px` }, label);
  };
  const upcomingCard = upcoming.length ? h('div', { class: 'card' },
    h('div', { class: 'section-title', style: 'margin-top:0' }, 'Upcoming fixtures'),
    ...upcoming.map(f => {
      const home = f.homeTeamId === myId;
      const opp = home ? f.away : f.home;
      const oppPos = posById.get(home ? f.awayTeamId : f.homeTeamId);
      return h('div', { class: 'between', style: 'font-size:13px;padding:5px 0;border-top:1px solid var(--line)' },
        h('span', {}, h('span', { class: 'muted', style: 'font-size:11px;margin-right:6px' }, `R${f.round}`),
          h('span', { style: 'font-weight:600' }, home ? 'vs ' : '@ ', opp), oppPos ? h('span', { class: 'muted', style: 'font-size:10px;margin-left:4px' }, `#${oppPos}`) : ''),
        h('span', { class: 'row', style: 'gap:8px;align-items:center' },
          f.weather && f.weather !== 'clear' ? h('span', { class: 'muted', style: 'font-size:11px', title: f.weather === 'rain' ? 'Wet pitch' : 'Windy' }, f.weather === 'rain' ? '🌧' : '🌬') : '',
          diffPill(oppPos),
          h('button', { class: 'ghost small', title: 'Scout this opponent', onclick: () => (location.hash = `#/scout/${f.id}`) }, '🔍')));
    })) : '';
  if (!alive()) return;
  mount(header(), h('div', { class: 'wrap grid' },
    h('div', { class: 'between' }, h('h2', {}, '📅 My Matches'), h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, '← Back')),
    upcomingCard,
    mine.length
      ? h('div', { class: 'card' }, h('div', { class: 'section-title', style: 'margin-top:0' }, 'Played'), ...mine.map(f => matchRow(f, true, rankOf)))
      : h('div', { class: 'card muted' }, 'No matches played yet — play or advance a matchday, then watch them back here.')));
}

async function screenLeagueMatches() {
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading…')));
  const league = await loadLeagueOr(e => {
    if (String(e.message).includes('no team')) screenCreateTeam();
    else mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message)));
  });
  if (!league) return;
  const played = league.fixtures.filter(f => f.played);
  const rounds = [...new Set(played.map(f => f.round))].sort((a, b) => b - a);
  const rankOf = rankLookup(league);
  if (!alive()) return;
  mount(header(), h('div', { class: 'wrap grid' },
    h('div', { class: 'between' }, h('h2', {}, '⚽ League — all results'), h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, '← Back')),
    played.length
      ? h('div', {}, ...rounds.map(rd => h('div', { class: 'card', style: 'margin-bottom:10px' },
          h('div', { class: 'section-title', style: 'margin-top:0' }, `Round ${rd}`),
          ...played.filter(f => f.round === rd).map(f => matchRow(f, f.involvesMe, rankOf)))))
      : h('div', { class: 'card muted' }, 'No results played yet this season — advance a matchday.')));
}

function route() {
  const hash = location.hash;
  routeGen++;   // invalidate any in-flight screen's pending mount (see screenGuard) — the new route owns the DOM now
  if (!user) { screenAuth(); return; }
  if (!hash.startsWith('#/watch/')) teardownWatch();
  if (hash.startsWith('#/watch/')) { const seg = hash.split('/')[2] ?? ''; screenWatch(Number(seg.split('?')[0]), /[?&]shouts=1\b/.test(hash), /[?&]live=1\b/.test(hash), Number(hash.match(/[?&]t=(\d+)/)?.[1] ?? 0), /[?&]cup=1\b/.test(hash)); }
  else if (hash === '#/matches') screenMyMatches();
  else if (hash === '#/league') screenLeagueMatches();
  else if (hash === '#/tactics') screenTactics();
  else if (hash === '#/market') screenMarket();
  else if (hash === '#/scouting') screenScouting();
  else if (hash === '#/training') screenTraining();
  else if (hash === '#/academy') screenAcademy();
  else if (hash.startsWith('#/teamtalk/')) screenTeamTalk(Number(hash.split('/')[2]));
  else if (hash === '#/news') screenNews();
  else if (hash === '#/inbox') screenInbox();
  else if (hash === '#/leaders') screenLeaders();
  else if (hash === '#/squad') screenSquad();
  else if (hash === '#/staff') screenStaff();
  else if (hash === '#/finances') screenFinances();
  else if (hash === '#/cup') screenCup();
  else if (hash === '#/history') screenHistory();
  else if (hash === '#/career') screenCareer();
  else if (hash.startsWith('#/report/')) { const seg = hash.split('/')[2] ?? ''; screenReport(Number(seg.split('?')[0]), /[?&]cup=1\b/.test(hash)); }
  else if (hash.startsWith('#/scout/')) screenScout(Number(hash.split('/')[2]));
  else if (hash.startsWith('#/player/')) screenPlayer(Number(hash.split('/')[2]));
  else screenDashboard();
}

// a11y: a "skip to content" link as the first focusable element lets keyboard users jump past the header nav.
// It focuses the #main-content landmark directly (NOT via an href hash, which would clobber the SPA route).
const skipLink = h('a', { href: '#main-content', class: 'skip-link' }, 'Skip to content');
skipLink.addEventListener('click', (e: Event) => { e.preventDefault(); document.getElementById('main-content')?.focus(); });
document.body.insertBefore(skipLink, document.body.firstChild);

window.addEventListener('hashchange', route);
// Session expired (any api call got a 401): drop the stale user and fall back to the login screen instead of
// leaving a raw "not logged in" under a live URL. teardownWatch() stops any running watch first.
window.addEventListener('footy:auth-expired', () => { if (!user) return; user = null; teardownWatch(); route(); });

// ── stale-tab guard ── the SPA ships as one content-hashed bundle with no HMR for the watch screen, so an
// open tab keeps running the OLD code after a deploy — which is exactly why the user saw "still choppy" on a
// tab opened before the P0 renderer rewrite. Poll the served index.html for a changed asset hash and offer a
// one-click reload. No-ops in dev (vite serves modules directly, no hashed index-*.js) — only the built :4000.
function watchForNewVersion(): void {
  const mine = [...document.querySelectorAll('script[src]')].map(s => s.getAttribute('src') || '').find(s => /assets\/index-[\w-]+\.js/.test(s));
  if (!mine) return;
  let bannerShown = false;
  const check = async (): Promise<void> => {
    if (bannerShown) return;
    try {
      const html = await (await fetch('/?_v=' + Date.now(), { cache: 'no-store' })).text();
      const m = html.match(/assets\/index-[\w-]+\.js/);
      if (m && !mine.includes(m[0])) {
        bannerShown = true;
        document.body.appendChild(h('div', {
          role: 'button', tabindex: '0', title: 'Reload to get the latest version',
          style: 'position:fixed;top:0;left:0;right:0;z-index:99999;background:var(--accent,#1b9af7);color:#fff;font:600 13px/1.5 system-ui,monospace;padding:9px 14px;text-align:center;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3)',
          onclick: () => location.reload(),
        }, '↻ A new version of the match viewer is available — click to reload'));
      }
    } catch { /* offline / transient — retry next tick */ }
  };
  setInterval(() => void check(), 90000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void check(); });
}

(async function boot() {
  try {
    const me = await api.me();
    user = me.user;
    if (user && me.teamId == null && location.hash !== '#/tactics') { screenCreateTeam(); return; }
  } catch { /* */ }
  route();
  watchForNewVersion();
})();
