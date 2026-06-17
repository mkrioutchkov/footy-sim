import './styles.css';
import { api, type TeamT, type LeagueT, type MarketT, type CupT, type ReportT, type NewsItemT, type PlanT, type DirectiveT, type ScoutT, type SeasonHistoryT, type StaffViewT, type FinancesT } from './api';
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
function mount(...nodes: Node[]) { root.replaceChildren(...nodes); }
function toast(msg: string) {
  const t = h('div', { class: 'toast' }, msg);
  document.body.appendChild(t);
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

// Compact tables for the world's OTHER divisions (the user's own is the main table above).
// Empty for a legacy single-division world.
function otherDivisions(league: LeagueT): HTMLElement {
  const others = (league.world ?? []).filter(d => d.tier !== league.tier);
  if (!others.length) return h('div', { style: 'display:none' });
  const cards = others.map(d => {
    const tb = h('tbody');
    d.standings.forEach((s, i) => tb.append(h('tr', { class: s.isUser ? 'me' : '' },
      h('td', { class: 'num' }, String(i + 1)),
      h('td', {}, s.name, s.isUser ? h('span', { class: 'pill', style: 'margin-left:8px' }, 'you') : ''),
      h('td', { class: 'num' }, String(s.played)),
      h('td', { class: 'num' }, (s.gd > 0 ? '+' : '') + s.gd),
      h('td', { class: 'num', style: 'font-weight:700' }, String(s.points)))));
    return h('div', {},
      h('div', { class: 'section-title', style: 'margin-top:0' }, d.name),
      h('table', {}, h('thead', {}, h('tr', {},
        h('th', { class: 'num' }, '#'), h('th', {}, 'Club'),
        h('th', { class: 'num' }, 'P'), h('th', { class: 'num' }, 'GD'), h('th', { class: 'num' }, 'Pts'))), tb));
  });
  return h('div', { class: 'card' },
    h('div', { class: 'section-title', style: 'margin-top:0' }, 'Other divisions'),
    h('div', { class: 'grid', style: `grid-template-columns:repeat(${cards.length},1fr);align-items:start` }, ...cards));
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
    create.setAttribute('disabled', 'true');
    try {
      await api.createTeam(name.value.trim());
      const plan = planInput.value.trim();
      if (plan) await api.teamPlan(plan).catch(() => { /* graceful — they can set it on the Tactics screen */ });
      route();
    } catch (e: any) { err.textContent = e.message; create.removeAttribute('disabled'); }
  });
  mount(header(), h('div', { class: 'wrap' },
    h('div', { class: 'card' },
      h('h2', {}, 'Create your club'),
      h('div', { class: 'muted', style: 'margin-bottom:16px' }, 'We’ll generate your 11 players and drop you into an 8-team league against AI managers.'),
      h('div', { class: 'field' }, h('label', {}, 'Club name'), name),
      h('div', { class: 'section-title' }, 'Tactical plan'),
      planInput,
      h('div', { style: 'margin-top:16px' }, create), err,
    ),
  ));
}

// The standing tactical plan: a plain-English textarea + a read-only resolved-plan display
// (the compiled directives), mirroring the live shout receipt. Replaces the old 5-dial sliders.
function planPanel(team: TeamT): HTMLElement {
  // resolve the plan's team-relative ids (0-10) to player names for describeDirective
  watchPlayers = team.players.slice(0, 11).map((p, i) => ({ id: i, name: p.name }));
  const input = h('textarea', { class: 'tactics-input', rows: '3',
    placeholder: '"high press, build from the back, full-backs bomb on, sit deeper if 2-0 up"' }) as HTMLTextAreaElement;
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
    if (note) out.appendChild(h('div', { class: 'muted', style: 'margin-top:6px' }, '• ' + note));
  };
  const save = h('button', { class: 'primary small' }, 'Save plan');
  save.addEventListener('click', async () => {
    save.setAttribute('disabled', 'true'); save.textContent = '…';
    try {
      const r = await api.teamPlan(input.value.trim());
      team.planText = r.planText; team.plan = r.plan;
      renderPlan(r.plan, r.note, r.error);
      toast(input.value.trim() ? 'Plan saved' : 'Plan cleared');
    } catch (e: any) { out.replaceChildren(h('div', { class: 'warn' }, '⚠ ' + e.message)); }
    save.removeAttribute('disabled'); save.textContent = 'Save plan';
  });
  renderPlan(team.plan);
  return h('div', { class: 'card' },
    h('div', { class: 'section-title', style: 'margin-top:0' }, 'Tactical plan'),
    h('div', { class: 'muted', style: 'font-size:12px;margin-bottom:8px' }, 'Type a standing plan in plain English — it’s compiled to your team’s instructions and seeds every match (and your live shouts). Mid-match, the shout box edits it.'),
    h('div', { class: 'tactics-row' }, input, save),
    out,
  );
}

// Formation control: a plain-text shout ("play 4-4-2", "AB at left back") sets the
// team's shape + XI for every match it plays. Shows the resolved XI + any note.
function formationPanel(team: TeamT): HTMLElement {
  const badge = h('span', { class: 'pill', style: 'margin-left:8px' }, team.formation ?? '4-3-3');
  const input = h('input', { placeholder: 'e.g. play 4-4-2  ·  “AB at left back”' }) as HTMLInputElement;
  const out = h('div', { class: 'muted', style: 'font-size:12px;margin-top:8px' });
  const xiBox = h('div', { class: 'players', style: 'margin-top:10px' });
  const renderXI = (slots: { role: string; playerName: string }[]) => {
    xiBox.replaceChildren(...slots.map(s => h('div', { class: 'pcard' },
      h('div', { class: 'role' }, s.role), h('div', { class: 'pn' }, s.playerName || '—'))));
  };
  const setBtn = h('button', { class: 'primary small' }, 'Set');
  const apply = async () => {
    const text = input.value.trim(); if (!text) return;
    setBtn.setAttribute('disabled', 'true'); setBtn.textContent = '…';
    try {
      const r = await api.setLineup(text);
      badge.textContent = r.formation;
      out.textContent = r.note || `Lined up in a ${r.formation}.`;
      if (r.slots?.length) renderXI(r.slots);
    } catch (e: any) { out.textContent = e.message; }
    setBtn.removeAttribute('disabled'); setBtn.textContent = 'Set';
  };
  setBtn.addEventListener('click', apply);
  input.addEventListener('keydown', (ev: any) => { if (ev.key === 'Enter') apply(); });
  return h('div', { class: 'card' },
    h('div', { class: 'section-title', style: 'margin-top:0' }, 'Formation', badge),
    h('div', { class: 'tactics-row' }, input, setBtn),
    out, xiBox,
  );
}

// ── dashboard ──
async function screenDashboard() {
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading…')));
  let team: TeamT, league: LeagueT, news: NewsItemT[] = [];
  try {
    const [t, l, n] = await Promise.all([api.team(), api.league(), api.news().catch(() => ({ news: [] }))]);
    team = t; league = l; news = n.news;
  } catch (e: any) {
    if (String(e.message).includes('no team')) return screenCreateTeam();
    return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message)));
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
  const advanceBtn = h('button', {}, myNext ? `Play matchday ${myNext.round}` : (canAdvance ? 'Advance matchday' : 'Season complete'));
  if (!canAdvance) advanceBtn.setAttribute('disabled', 'true');
  advanceBtn.addEventListener('click', async () => {
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
        if (retired.length || intake.length) toast(`Academy: ${intake.length} prospect(s) promoted${retired.length ? `, ${retired.length} veteran(s) retired` : ''}.`);
      }
      screenDashboard();
    } catch (e: any) { toast(e.message); screenDashboard(); }
  });

  const watchBtn = h('button', { class: 'ghost' }, myNext ? 'Watch my next match' : 'Replay last match');
  watchBtn.addEventListener('click', async () => {
    const fx = myNext ?? [...league.fixtures].reverse().find(f => f.involvesMe && f.played);
    if (fx) location.hash = `#/watch/${fx.id}`;
  });

  // standings table
  const tbody = h('tbody');
  league.standings.forEach((s, i) => {
    tbody.append(h('tr', { class: s.isUser ? 'me' : '' },
      h('td', { class: 'num' }, String(i + 1)),
      h('td', {}, s.name, s.isUser ? h('span', { class: 'pill', style: 'margin-left:8px' }, 'you') : ''),
      h('td', { class: 'num' }, String(s.played)),
      h('td', { class: 'num' }, String(s.won)), h('td', { class: 'num' }, String(s.drawn)), h('td', { class: 'num' }, String(s.lost)),
      h('td', { class: 'num' }, `${s.gf}:${s.ga}`),
      h('td', { class: 'num' }, (s.gd > 0 ? '+' : '') + s.gd),
      h('td', { class: 'num', style: 'font-weight:700' }, String(s.points)),
    ));
  });
  const table = h('table', {},
    h('thead', {}, h('tr', {},
      h('th', { class: 'num' }, '#'), h('th', {}, 'Club'),
      h('th', { class: 'num' }, 'P'), h('th', { class: 'num' }, 'W'), h('th', { class: 'num' }, 'D'), h('th', { class: 'num' }, 'L'),
      h('th', { class: 'num' }, 'GF:GA'), h('th', { class: 'num' }, 'GD'), h('th', { class: 'num' }, 'Pts'))),
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

  // press conference — your words move squad morale via each player's dials
  const pressInput = h('textarea', { class: 'tactics-input', rows: '2', placeholder: 'Address the media — back your players, demand more, or stay ice-cool…' }) as HTMLTextAreaElement;
  const pressBtn = h('button', { class: 'ghost small' }, 'Address the media');
  pressBtn.addEventListener('click', async () => {
    const txt = pressInput.value.trim(); if (!txt) { toast('Say something to the media first'); return; }
    pressBtn.setAttribute('disabled', 'true'); pressBtn.textContent = '…';
    try { const r = await api.press(txt); toast(`Media reaction: ${r.lifted} lifted${r.unsettled ? `, ${r.unsettled} unsettled` : ''}`); pressInput.value = ''; screenDashboard(); }
    catch (e: any) { toast(e.message); pressBtn.removeAttribute('disabled'); pressBtn.textContent = 'Address the media'; }
  });
  const pressCard = h('div', { class: 'card', style: 'margin-top:14px' },
    h('div', { class: 'section-title', style: 'margin-top:0' }, 'Press conference'),
    h('div', { class: 'muted', style: 'font-size:12px;margin-bottom:6px' }, 'What you say moves squad morale — each player reacts through his own personality.'),
    pressInput, h('div', { style: 'margin-top:6px' }, pressBtn));

  // ── club news: events that evolved a player's story + dials ──
  const NEWS_ICON: Record<NewsItemT['type'], string> = { hat_trick: '⚽⚽⚽', brace: '⚽⚽', red_card: '🟥', star: '⭐', long_injury: '🤕', pots: '🏆', young_pots: '🌟' };
  // link by CURRENT name → slot (slots renumber on transfers, so a stored slot can drift); only
  // unique names link (a duplicate name can't be resolved to one player), and a player who has
  // since left the club just isn't a link.
  const nameCount = new Map<string, number>();
  for (const p of team.players) nameCount.set(p.name, (nameCount.get(p.name) ?? 0) + 1);
  const slotByName = new Map(team.players.filter(p => nameCount.get(p.name) === 1).map(p => [p.name, p.slot]));
  const newsCard = h('div', { class: 'card', style: 'margin-top:14px' },
    h('div', { class: 'section-title', style: 'margin-top:0' }, 'Club news'),
    news.length
      ? h('div', {}, ...news.slice(0, 8).map(n => h('div', { class: 'between', style: 'font-size:13px;padding:3px 0;' + (slotByName.has(n.player) ? 'cursor:pointer' : ''), onclick: () => { const s = slotByName.get(n.player); if (s != null) location.hash = `#/player/${s}`; } },
          h('span', {}, `${NEWS_ICON[n.type] ?? '•'} ${n.headline}`),
          h('span', { class: 'muted', style: 'font-size:11px' }, `S${n.season}`))))
      : h('div', { class: 'muted', style: 'font-size:12px' }, 'No headlines yet — play on and your players will make news.'));

  mount(header(), h('div', { class: 'wrap grid' },
    h('div', { class: 'between' },
      h('div', {}, h('h2', {}, team.name), h('div', { class: 'muted' },
        `Managed by ${team.manager} · ${league.divisionName ?? 'League'}${league.season ? ` · Season ${league.season}` : ''} · Position ${myPos}/${league.standings.length}`)),
      h('div', { class: 'row' }, watchBtn, advanceBtn,
        h('button', { class: 'ghost', onclick: () => (location.hash = '#/market') }, 'Market'),
        h('button', { class: 'ghost', onclick: () => (location.hash = '#/training') }, 'Training'),
        h('button', { class: 'ghost', onclick: () => (location.hash = '#/staff') }, 'Staff'),
        h('button', { class: 'ghost', onclick: () => (location.hash = '#/finances') }, 'Finances'),
        h('button', { class: 'ghost', onclick: () => (location.hash = '#/cup') }, 'Cup'),
        h('button', { class: 'ghost', onclick: () => (location.hash = '#/history') }, 'History'),
        h('button', { class: 'ghost', onclick: () => (location.hash = '#/tactics') }, 'Tactics')),
    ),
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
            h('div', { style: `height:100%;width:${Math.max(0, Math.min(100, conf.value))}%;background:${cc}` }))));
      }
      if (obj) {
        // "just outside it" must never include a relegation place — the bottom `promote` spots are
        // the drop zone, so cap the amber band at the drop line (otherwise survival, whose target IS
        // the drop line, would render gold instead of red while actually in the relegation zone).
        const dropLine = league.standings.length - (league.promote ?? 2);
        const onTrack = myPos <= obj.target;
        const close = !onTrack && myPos <= Math.min(obj.target + 2, dropLine);
        const c = onTrack ? 'var(--accent)' : close ? 'var(--gold)' : 'var(--danger)';
        rows.push(h('div', { style: conf ? 'margin-top:10px' : '' },
          h('span', { style: 'font-weight:600' }, '📋 Board objective: ' + obj.label),
          h('span', { class: 'muted', style: 'margin-left:8px;font-size:13px' }, `currently ${ordinal(myPos)} — `),
          h('span', { style: `color:${c};font-size:13px;font-weight:600` }, onTrack ? 'on track' : close ? 'just outside it' : 'work to do')));
      }
      return h('div', { class: 'card', style: 'padding:12px 14px' }, ...rows);
    })(),
    h('div', { class: 'card' }, h('div', { class: 'section-title', style: 'margin-top:0' }, league.divisionName ?? 'League table'), table),
    otherDivisions(league),
    h('div', { class: 'grid', style: 'grid-template-columns:1.2fr .8fr;align-items:start' },
      h('div', { class: 'card' }, h('div', { class: 'section-title', style: 'margin-top:0' }, 'Your fixtures'), fxBox),
      h('div', {},
        formationPanel(team),
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
async function screenTactics() {
  let team: TeamT;
  try { team = await api.team(); } catch { return route(); }
  mount(header(), h('div', { class: 'wrap grid' },
    h('div', { class: 'between' },
      h('h2', {}, 'Tactics'),
      h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, '← Back')),
    planPanel(team),
    formationPanel(team),
  ));
}

// ── watch ──
let activeRenderer: MatchRenderer | null = null;
let activeWs: WebSocket | null = null;
let watchBar: HTMLElement | null = null;
let watchPanel: HTMLElement | null = null;
let watchStatus: HTMLElement | null = null;   // connecting / connection-lost overlay
let watchPanelObs: ResizeObserver | null = null;   // keeps the pitch sized to the space the panel leaves
let watchEpoch = 0;   // bumped on every teardown so an in-flight screenWatch can detect it was superseded
function teardownWatch() {
  watchEpoch++;
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
const PLAYER_VERB: Record<string, string> = {
  shoot_on_sight: 'shoots on sight', get_forward: 'gets forward', sit_deep: 'sits deep',
  stay_wide: 'stays wide', come_inside: 'comes inside', stay_central: 'stays central',
  cross_early: 'crosses early', switch_play: 'switches the play', play_simple: 'keeps it simple',
  run_in_behind: 'runs in behind', make_runs: 'makes runs', dribble_more: 'takes them on',
  press_hard: 'presses hard', tackle_hard: 'gets stuck in', stay_on_feet: 'stays on his feet',
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

  root.replaceChildren();
  // Rewind to the start — only meaningful for a finished recording (revealed on the first
  // replay frame), since a live re-sim can't seek backwards.
  const rewindBtn = h('button', { class: 'ghost small', style: 'display:none', onclick: () => activeWs?.send(JSON.stringify({ type: 'seek', value: 0 })) }, '⏮ Rewind');
  const bar = h('div', { class: 'watch-bar' },
    h('button', { class: 'ghost small', onclick: () => { location.hash = '#/'; } }, '← Back'),
    h('button', { class: 'ghost small', onclick: () => activeWs?.send(JSON.stringify({ type: 'speed', value: 4 })) }, '4×'),
    h('button', { class: 'ghost small', onclick: () => activeWs?.send(JSON.stringify({ type: 'speed', value: 1 })) }, '1×'),
    h('button', { class: 'ghost small', onclick: () => activeWs?.send(JSON.stringify({ type: 'pause' })) }, 'Pause'),
    rewindBtn,
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
    // What this shout did.
    if (changed) receiptEl.appendChild(h('div', { class: 'ok' }, '✓ ' + changed));
    // Motivational reactions (personality-driven morale swings).
    for (const m of motivation) {
      receiptEl.appendChild(h('div', { class: 'receipt-line ' + (m.moraleDelta > 0 ? 'up' : 'down') },
        `${m.moraleDelta > 0 ? '▲' : '▼'} ${pname(m.playerId)} ${m.moraleDelta > 0 ? '+' : ''}${m.moraleDelta} morale${m.reaction ? ` — “${m.reaction}”` : ''}`));
    }
    // The full standing composite plan.
    if (dirs.length) {
      receiptEl.appendChild(h('div', { class: 'muted', style: 'margin-top:6px' }, 'Standing plan:'));
      for (const d of dirs) receiptEl.appendChild(h('div', { class: 'receipt-line' }, '• ' + describeDirective(d)));
    } else if (!motivation.length && !changed && !note) {
      receiptEl.appendChild(h('div', { class: 'muted' }, "Couldn't read that as an order or a word to the players.")); return;
    }
    if (note) receiptEl.appendChild(h('div', { class: 'muted' }, '• ' + note));
  };
  const panel = h('div', { class: 'tactics-panel' },
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
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data) as WatchMessage;
      // A replayed recording is finished playback: drop the live-only shout box and offer rewind.
      if (msg.replay && !replayUiApplied) { replayUiApplied = true; panel.style.display = 'none'; rewindBtn.style.display = ''; syncReserve(); }
      if (msg.tacticsReceipt) { showReceipt(msg.tacticsReceipt); return; }
      if (Array.isArray(msg.players)) watchPlayers = msg.players.map(p => ({ id: p.id, name: p.name }));
      if (!gotFrame) { gotFrame = true; status.remove(); watchStatus = null; }
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
    for (const a of market.freeAgents) {
      const afford = market.budget >= a.value, room = market.squad.length < market.squadMax, wageOk = a.wage <= wageHeadroom;
      const sign = h('button', { class: 'ghost small' }, 'Sign');
      if (!afford || !room || !wageOk) sign.setAttribute('disabled', 'true');
      if (afford && room && !wageOk) sign.setAttribute('title', 'Not enough wage budget');
      sign.addEventListener('click', async () => {
        sign.setAttribute('disabled', 'true'); sign.textContent = '…';
        try { const r = await api.buyAgent(a.id); market = r.market; toast(`Signed ${r.name} — ${fmtMoney(r.value)} (${r.placed === 'xi' ? 'straight into the XI' : 'to the bench'})`); render(); }
        catch (e: any) { toast(e.message); render(); }
      });
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
      const btn = p.listed
        ? h('button', { class: 'ghost small' }, 'Unlist')
        : h('button', { class: 'ghost small' }, 'List');
      if (p.onLoan) { btn.setAttribute('disabled', 'true'); btn.setAttribute('title', "on loan — you can't sell him"); }
      else if (!p.listed && !canSell) btn.setAttribute('disabled', 'true');
      if (!p.onLoan) btn.addEventListener('click', async () => {
        btn.setAttribute('disabled', 'true'); btn.textContent = '…';
        try {
          const r = p.listed ? await api.unlistPlayer(p.slot) : await api.listPlayer(p.slot);
          market = r.market; toast(p.listed ? `${p.name} taken off the market` : `${p.name} listed for ${fmtMoney((r as any).askPrice)}`); render();
        } catch (e: any) { toast(e.message); render(); }
      });
      const sqPot = p.potential != null && p.potential > p.overall;
      sqBody.append(h('tr', {},
        h('td', {}, p.name, p.onLoan ? h('span', { class: 'pill', style: 'margin-left:6px' }, 'loan') : (p.starter ? '' : h('span', { class: 'muted', style: 'font-size:11px' }, ' · bench')),
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
        if (r.status === 'accepted') { market = r.market; toast(`Signed ${r.player} for ${fmtMoney(r.fee!)} (${r.placed === 'xi' ? 'straight into the XI' : 'to the bench'})`); render(); }
        else if (r.status === 'countered') {
          market = r.market;
          if (await confirmModal('Counter-offer', `${r.club} want ${fmtMoney(r.counterFee!)} for ${r.player}. Match their valuation?`, 'Match it')) await sendBid(playerId, r.counterFee!);
          else render();
        } else { toast(r.error || `${r.club} rejected the bid`); render(); }
      } catch (e: any) { toast(e.message); render(); }
    };
    const doBid = async (t: typeof market.transferTargets[number]): Promise<void> => {
      const ask = t.askPrice ?? t.value;
      const raw = await promptModal(`Bid for ${t.name}`,
        `${t.club} are asking ${fmtMoney(ask)}. Your budget: ${fmtMoney(market.budget)}.\nEnter a number, or shorthand like 1.5m / 500k.`,
        String(ask), 'Submit bid');
      if (raw == null) return;
      // accept plain numbers AND the shorthand the screen shows (£1.5M, 500k) — strip symbols,
      // then scale by a trailing m/k so "1.5m" reads as 1,500,000 rather than 2.
      const s = raw.trim().toLowerCase().replace(/[£,\s]/g, '');
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
    mount(header(), h('div', { class: 'wrap grid' },
      h('div', { class: 'between' },
        h('div', {}, h('h2', {}, 'Transfer market'),
          h('div', { class: 'muted' }, `Budget ${fmtMoney(market.budget)} · wages ${fmtMoney(market.wageBill)}/${fmtMoney(market.wageBudget)} (${wagePct}%) · squad ${market.squad.length}/${market.squadMax}`)),
        h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, '← Back'),
      ),
      h('div', { class: 'card', style: `padding:8px 12px;${win.open ? 'border-left:3px solid var(--accent,#4ea1ff)' : 'opacity:.8'}` },
        h('span', { style: win.open ? 'font-weight:600' : '' }, (win.open ? '🟢 ' : '🔒 ') + win.label),
        h('span', { class: 'muted', style: 'margin-left:8px;font-size:12px' }, 'Free agents can be signed any time; club-to-club deals need an open window.')),
      h('div', { class: 'grid', style: 'grid-template-columns:1fr 1fr;align-items:start' },
        h('div', { class: 'card' },
          h('div', { class: 'section-title', style: 'margin-top:0' }, 'Free agents'),
          h('div', { style: 'max-height:520px;overflow:auto', 'data-scroll': 'fa' }, h('table', {}, headRow('Player'), faBody))),
        h('div', { class: 'card' },
          h('div', { class: 'section-title', style: 'margin-top:0' }, 'Your squad'),
          h('div', { class: 'muted', style: 'margin:-6px 0 8px;font-size:12px' }, 'List a player to sell him — an AI club may buy once you have squad depth (12+).'),
          h('div', { style: 'max-height:520px;overflow:auto', 'data-scroll': 'squad' }, h('table', {}, headRow('Player'), sqBody))),
      ),
      h('div', { class: 'card' },
        h('div', { class: 'section-title', style: 'margin-top:0' }, 'For sale — other clubs'),
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
const TRAINING_FOCI = ['balanced', 'speed', 'passing', 'creativity', 'shooting', 'tackling', 'positioning', 'stamina'];
async function screenTraining() {
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading…')));
  let team: TeamT;
  try { team = await api.team(); }
  catch (e: any) {
    if (String(e.message).includes('no team')) return screenCreateTeam();
    return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message)));
  }
  const ovrOf = (p: typeof team.players[number]) => skillOvr(p.attrs);

  const sel = h('select', { class: 'focus-select' }) as HTMLSelectElement;
  for (const f of TRAINING_FOCI) {
    const o = h('option', { value: f }, f[0].toUpperCase() + f.slice(1)) as HTMLOptionElement;
    if (f === (team.trainingFocus ?? 'balanced')) o.selected = true;
    sel.append(o);
  }
  sel.addEventListener('change', async () => {
    try { const r = await api.setTraining(sel.value); toast(`Training focus: ${r.focus}`); }
    catch (e: any) { toast(e.message); }
  });

  const body = h('tbody');
  for (const p of [...team.players].sort((a, b) => a.slot - b.slot)) {
    const ovr = ovrOf(p), pot = p.potential ?? ovr;
    const room = pot - ovr;
    body.append(h('tr', {},
      h('td', {}, p.name, p.slot >= 11 ? h('span', { class: 'muted', style: 'font-size:11px' }, ' · bench') : ''),
      h('td', {}, h('span', { class: 'pill' }, p.role)),
      h('td', { class: 'num' }, p.age != null ? String(p.age) : '—'),
      h('td', { class: 'num' }, String(ovr)),
      h('td', { class: 'num' }, room > 0 ? h('span', { class: 'a' }, `${pot} (+${room})`) : String(pot)),
    ));
  }

  mount(header(), h('div', { class: 'wrap grid' },
    h('div', { class: 'between' },
      h('div', {}, h('h2', {}, 'Training'),
        h('div', { class: 'muted' }, 'Players drift toward their potential each matchday — faster while young and for the diligent. Pick a focus to push one attribute harder.')),
      h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, '← Back'),
    ),
    h('div', { class: 'card' },
      h('div', { class: 'row', style: 'align-items:center;gap:10px;margin-bottom:6px' },
        h('span', { class: 'section-title', style: 'margin:0' }, 'Training focus'), sel),
      h('div', { style: 'max-height:540px;overflow:auto;margin-top:8px' },
        h('table', {},
          h('thead', {}, h('tr', {},
            h('th', {}, 'Player'), h('th', {}, 'Pos'),
            h('th', { class: 'num' }, 'Age'), h('th', { class: 'num' }, 'OVR'), h('th', { class: 'num' }, 'Potential'))),
          body)),
    ),
  ));
}

// ── player profile (personality + the story↔traits coupling) ──
const TRAIT_LABELS: { key: string; label: string }[] = [
  { key: 'professionalism', label: 'Professionalism' }, { key: 'consistency', label: 'Consistency' },
  { key: 'bigGame', label: 'Big-game' }, { key: 'leadership', label: 'Leadership' },
  { key: 'temperament', label: 'Temperament (fiery)' }, { key: 'ego', label: 'Ego' },
  { key: 'criticismResponse', label: 'Responds to criticism' }, { key: 'praiseResponse', label: 'Responds to praise' },
];
function traitBar(label: string, v: number): HTMLElement {
  return h('div', { style: 'margin-bottom:7px' },
    h('div', { class: 'between', style: 'font-size:12px;margin-bottom:2px' }, h('span', { class: 'muted' }, label), h('span', {}, String(v))),
    h('div', { style: 'height:6px;background:var(--panel2,#161f30);border-radius:3px;overflow:hidden' },
      h('div', { style: `height:100%;width:${Math.max(0, Math.min(100, v))}%;background:var(--accent,#4ea1ff)` })));
}
async function screenPlayer(slot: number) {
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading…')));
  let team: TeamT;
  try { team = await api.team(); }
  catch (e: any) { if (String(e.message).includes('no team')) return screenCreateTeam(); return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message))); }
  const p = team.players.find(x => x.slot === slot);
  if (!p) { location.hash = '#/'; return; }
  const ovr = skillOvr(p.attrs);

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
          (() => {
            const renew = h('button', { class: 'ghost small' }, 'Renew (3y)');
            renew.addEventListener('click', async () => {
              renew.setAttribute('disabled', 'true');
              try { const r = await api.renewPlayer(slot, 3); toast(`Renewed — ${fmtMoney(r.wage)}/yr for ${r.years}y`); screenPlayer(slot); }
              catch (e: any) { toast(e.message); renew.removeAttribute('disabled'); }
            });
            return renew;
          })()) : '',
        (p.injuredMatches ?? 0) > 0
          ? h('div', { style: 'font-size:12px;color:#e8896b' }, `🤕 Injured — out ${p.injuredMatches} match${(p.injuredMatches ?? 0) > 1 ? 'es' : ''}${p.morale != null ? ` · Morale ${p.morale}` : ''}`)
          : h('div', { class: 'muted', style: 'font-size:12px' }, `Match fitness ${p.fitness ?? 100}%${p.morale != null ? ` · Morale ${p.morale}` : ''}`)),
      h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, '← Back'),
    ),
    h('div', { class: 'grid', style: 'grid-template-columns:1fr 1fr;align-items:start' },
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
async function screenReport(fixtureId: number) {
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Reading the match…')));
  let rep: ReportT;
  try { rep = await api.report(fixtureId); }
  catch (e: any) {
    const msg = String(e.message).includes('no recording')
      ? "No report yet — this match wasn't recorded (play or watch it first)."
      : e.message;
    return mount(header(), h('div', { class: 'wrap grid' },
      h('div', { class: 'between' }, h('h2', {}, 'Match report'), h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, '← Back')),
      h('div', { class: 'card muted' }, msg)));
  }

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
  ));
}

// ── club finances ──
const FIN_LABEL: Record<string, string> = {
  prize: 'Prize money', transfer_in: 'Transfers in', transfer_out: 'Transfers out',
  staff: 'Staff fees', sponsor: 'Sponsorship', other: 'Other',
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
        cell('Net (season)', signed(net), col(net)))),
    h('div', { class: 'grid', style: 'grid-template-columns:1fr 1fr;align-items:start' },
      h('div', { class: 'card' },
        h('div', { class: 'section-title', style: 'margin-top:0' }, 'This season by category'),
        ...byKind),
      h('div', { class: 'card' },
        h('div', { class: 'section-title', style: 'margin-top:0' }, 'Recent movements'),
        h('div', { style: 'max-height:360px;overflow:auto' }, ...recent))),
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
      h('div', { class: 'grid', style: 'grid-template-columns:1fr 1fr;align-items:start' },
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

  const players = s.keyPlayers.length
    ? s.keyPlayers.map(p => h('div', { class: 'between', style: 'font-size:13px;padding:3px 0' },
        h('span', {}, p.danger ? h('span', { title: 'danger man', style: 'margin-right:5px' }, '⚠️') : '',
          p.name, h('span', { class: 'muted', style: 'font-size:11px' }, ` ${p.role} · ${p.age}y`)),
        h('span', { style: p.danger ? 'font-weight:700;color:var(--gold)' : '' },
          `OVR ${p.overall}${p.potential && p.potential > p.overall ? ` → ${p.potential}` : ''}`)))
    : [h('div', { class: 'muted', style: 'font-size:13px' }, 'Squad not available.')];

  mount(header(), h('div', { class: 'wrap grid' },
    h('div', { class: 'between' },
      h('div', {}, h('h2', {}, `Scouting — ${o.name}`),
        h('div', { class: 'muted' },
          `${o.manager} · ${o.formation} · ${o.position != null ? ordinal(o.position) + ' in the table' : 'unranked'} · you play ${s.venue === 'home' ? 'at home' : 'away'} (R${s.round})`)),
      h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, '← Back')),
    h('div', { class: 'grid', style: 'grid-template-columns:1fr 1fr;align-items:start' },
      h('div', { class: 'card' },
        h('div', { class: 'section-title', style: 'margin-top:0' }, 'Form & record'),
        h('div', { class: 'muted', style: 'margin-bottom:10px;font-size:13px' },
          `P${o.played}  ·  W${o.won} D${o.drawn} L${o.lost}  ·  ${o.gf}:${o.ga} (${o.gd >= 0 ? '+' : ''}${o.gd})  ·  ${o.points} pts`),
        formRow,
        h('div', { class: 'section-title' }, 'How they play'),
        h('ul', { style: 'margin:0;padding-left:18px;line-height:1.7' }, ...s.approach.map(a => h('li', {}, a)))),
      h('div', { class: 'card' },
        h('div', { class: 'section-title', style: 'margin-top:0' }, 'Danger men'),
        h('div', { class: 'muted', style: 'margin:-4px 0 8px;font-size:12px' }, 'Their highest-rated players in the likely XI.'),
        ...players)),
  ));
}

// ── club history / honours archive ──
const OBJ_LABEL: Record<string, string> = {
  title: 'Win the league', promotion: 'Win promotion', top_half: 'Finish in the top half', survival: 'Avoid relegation',
};
const CONF_LABEL: Record<string, string> = {
  secure: 'Secure', stable: 'Stable', shaky: 'Under pressure', at_risk: 'At risk',
};
function trophy(icon: string, n: number, label: string): HTMLElement {
  return h('div', { style: 'text-align:center;min-width:74px' },
    h('div', { style: 'font-size:26px' }, icon),
    h('div', { style: 'font-size:22px;font-weight:800' }, String(n)),
    h('div', { class: 'muted', style: 'font-size:11px' }, label));
}
async function screenHistory() {
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading history…')));
  let hist: SeasonHistoryT[];
  try { hist = (await api.history()).history; }
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
    if (s.objective) honours.append(h('span', { class: 'pill', title: `Board objective: ${OBJ_LABEL[s.objective.kind] ?? 'season target'}`, style: s.objective.met ? '' : 'background:#3a1f24;color:#ff9a9a' }, (s.objective.met ? '✅' : '❌') + ' Board'));
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
    h('div', { class: 'card' },
      h('div', { class: 'section-title', style: 'margin-top:0' }, 'Season by season'),
      h('div', { style: 'max-height:560px;overflow:auto' }, h('table', {},
        h('thead', {}, h('tr', {},
          h('th', { class: 'num' }, 'Season'), h('th', {}, 'Division'), h('th', { class: 'num' }, 'Pos'),
          h('th', { class: 'num' }, 'W-D-L'), h('th', { class: 'num' }, 'GF:GA'), h('th', { class: 'num' }, 'Pts'), h('th', {}, 'Honours'))),
        body))),
  ));
}

function route() {
  const hash = location.hash;
  if (!user) { screenAuth(); return; }
  if (!hash.startsWith('#/watch/')) teardownWatch();
  if (hash.startsWith('#/watch/')) screenWatch(Number(hash.split('/')[2]));
  else if (hash === '#/tactics') screenTactics();
  else if (hash === '#/market') screenMarket();
  else if (hash === '#/training') screenTraining();
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
