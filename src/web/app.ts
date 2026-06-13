import './styles.css';
import { api, type TeamT, type Tactics, type LeagueT } from './api';
import { MatchRenderer } from '../renderer';

const root = document.getElementById('app')!;
let user: { id: number; username: string } | null = null;

// ── tiny DOM helper ──
type Attrs = Record<string, any>;
function h(tag: string, attrs: Attrs = {}, ...kids: (Node | string)[]): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
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

const TACTIC_DEFS: { key: keyof Tactics; label: string; lo: string; hi: string }[] = [
  { key: 'aggression', label: 'Aggression', lo: 'Contain', hi: 'Press hard' },
  { key: 'passingDirectness', label: 'Passing', lo: 'Patient', hi: 'Direct' },
  { key: 'overlapFrequency', label: 'Overlaps', lo: 'Stay home', hi: 'Bomb on' },
  { key: 'midfieldFreedom', label: 'Midfield', lo: 'Disciplined', hi: 'Free roam' },
  { key: 'defensiveLineHeight', label: 'Def. line', lo: 'Deep', hi: 'High' },
];

function header(): HTMLElement {
  return h('header', { class: 'top' },
    h('div', { class: 'wrap' },
      h('div', { class: 'brand' , html: 'FOOTY <span class="a">MANAGER</span>' }),
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
      h('div', { class: 'brand', style: 'font-size:24px;margin-bottom:6px', html: 'FOOTY <span class="a">MANAGER</span>' }),
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
  const tactics: Tactics = { aggression: 50, passingDirectness: 50, overlapFrequency: 50, midfieldFreedom: 50, defensiveLineHeight: 50 };
  const name = h('input', { placeholder: 'e.g. Brisbane Roar', value: `${user!.username} FC` }) as HTMLInputElement;
  const err = h('div', { class: 'err' });
  const create = h('button', {}, 'Create team & start season');
  create.addEventListener('click', async () => {
    create.setAttribute('disabled', 'true');
    try { await api.createTeam(name.value.trim(), tactics); route(); }
    catch (e: any) { err.textContent = e.message; create.removeAttribute('disabled'); }
  });
  mount(header(), h('div', { class: 'wrap' },
    h('div', { class: 'card' },
      h('h2', {}, 'Create your club'),
      h('div', { class: 'muted', style: 'margin-bottom:16px' }, 'We’ll generate your 11 players and drop you into an 8-team league against AI managers.'),
      h('div', { class: 'field' }, h('label', {}, 'Club name'), name),
      h('div', { class: 'section-title' }, 'Starting tactics'),
      tacticsSliders(tactics),
      h('div', { style: 'margin-top:16px' }, create), err,
    ),
  ));
}

function tacticsSliders(tactics: Tactics): HTMLElement {
  const box = h('div', {});
  for (const def of TACTIC_DEFS) {
    const val = h('span', { class: 'num' }, String(tactics[def.key]));
    const range = h('input', { type: 'range', min: '0', max: '100', value: String(tactics[def.key]) }) as HTMLInputElement;
    range.addEventListener('input', () => { tactics[def.key] = +range.value; val.textContent = range.value; });
    box.append(h('div', { class: 'slider-row' },
      h('div', { class: 'lab' }, def.label, h('div', { class: 'muted', style: 'font-size:11px' }, `${def.lo} → ${def.hi}`)),
      range, val,
    ));
  }
  return box;
}

// ── dashboard ──
async function screenDashboard() {
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading…')));
  let team: TeamT, league: LeagueT;
  try { [team, league] = await Promise.all([api.team(), api.league()]); }
  catch (e: any) {
    if (String(e.message).includes('no team')) return screenCreateTeam();
    return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message)));
  }

  const myNext = league.fixtures.find(f => f.involvesMe && !f.played);
  const myPos = league.standings.findIndex(s => s.teamId === league.myTeamId) + 1;

  // team / squad card
  const squad = h('div', { class: 'players' });
  for (const p of team.players) {
    const ovr = Math.round(Object.values(p.attrs).reduce((a, b) => a + b, 0) / Object.keys(p.attrs).length);
    squad.append(h('div', { class: 'pcard' },
      h('div', { class: 'role' }, `${p.role} · OVR ${ovr}`),
      h('div', { class: 'pn' }, p.name),
      h('div', { class: 'at' }, `SPD ${p.attrs.speed} · PAS ${p.attrs.passing} · SHO ${p.attrs.shooting}`,
        h('br'), `TAC ${p.attrs.tackling} · POS ${p.attrs.positioning} · CRE ${p.attrs.creativity}`),
    ));
  }

  const advanceBtn = h('button', {}, myNext ? `Play matchday ${myNext.round}` : 'Season complete');
  if (!myNext) advanceBtn.setAttribute('disabled', 'true');
  advanceBtn.addEventListener('click', async () => {
    advanceBtn.setAttribute('disabled', 'true'); advanceBtn.textContent = 'Simulating…';
    try {
      const r = await api.advance();
      if (r.myResult) toast(`Your match: ${r.myResult.homeScore}–${r.myResult.awayScore}`);
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
      ? h('button', { class: 'ghost small', onclick: () => (location.hash = `#/watch/${f.id}`) }, 'Watch')
      : h('span', { class: 'pill' }, `R${f.round}`);
    fxBox.append(h('div', { class: 'fx me' },
      h('div', { class: 'h' }, f.home), score, h('div', {}, f.away), action));
  }

  mount(header(), h('div', { class: 'wrap grid' },
    h('div', { class: 'between' },
      h('div', {}, h('h2', {}, team.name), h('div', { class: 'muted' }, `Managed by ${team.manager} · League position ${myPos}/${league.standings.length}`)),
      h('div', { class: 'row' }, watchBtn, advanceBtn,
        h('button', { class: 'ghost', onclick: () => (location.hash = '#/tactics') }, 'Tactics')),
    ),
    h('div', { class: 'card' }, h('div', { class: 'section-title', style: 'margin-top:0' }, 'League table'), table),
    h('div', { class: 'grid', style: 'grid-template-columns:1.2fr .8fr;align-items:start' },
      h('div', { class: 'card' }, h('div', { class: 'section-title', style: 'margin-top:0' }, 'Your fixtures'), fxBox),
      h('div', { class: 'card' }, h('div', { class: 'section-title', style: 'margin-top:0' }, `Squad · ${team.name}`), squad),
    ),
  ));
}

// ── tactics ──
async function screenTactics() {
  let team: TeamT;
  try { team = await api.team(); } catch { return route(); }
  const tactics = { ...team.tactics };
  const err = h('div', { class: 'err' });
  const save = h('button', {}, 'Save tactics');
  save.addEventListener('click', async () => {
    save.setAttribute('disabled', 'true');
    try { await api.setTactics(tactics); toast('Tactics saved'); location.hash = '#/'; }
    catch (e: any) { err.textContent = e.message; save.removeAttribute('disabled'); }
  });
  mount(header(), h('div', { class: 'wrap' },
    h('div', { class: 'card' },
      h('h2', {}, 'Tactics'),
      h('div', { class: 'muted', style: 'margin-bottom:14px' }, 'These drive your team’s behaviour in every match. Applied to your next fixtures.'),
      tacticsSliders(tactics),
      h('div', { class: 'row', style: 'margin-top:16px' }, save,
        h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, 'Back')), err,
    ),
  ));
}

// ── watch ──
let activeRenderer: MatchRenderer | null = null;
let activeWs: WebSocket | null = null;
function teardownWatch() {
  try { activeWs?.close(); } catch { /* */ } activeWs = null;
  try { activeRenderer?.destroy(); } catch { /* */ } activeRenderer = null;
}

async function screenWatch(fixtureId: number) {
  teardownWatch();
  // Ensure the result is recorded (idempotent, deterministic, same as the stream).
  api.playFixture(fixtureId).catch(() => { /* may already be played */ });

  root.replaceChildren();
  const bar = h('div', { class: 'watch-bar' },
    h('button', { class: 'ghost small', onclick: () => { location.hash = '#/'; } }, '← Back'),
    h('button', { class: 'ghost small', onclick: () => activeWs?.send(JSON.stringify({ type: 'speed', value: 4 })) }, '4×'),
    h('button', { class: 'ghost small', onclick: () => activeWs?.send(JSON.stringify({ type: 'speed', value: 1 })) }, '1×'),
    h('button', { class: 'ghost small', onclick: () => activeWs?.send(JSON.stringify({ type: 'pause' })) }, 'Pause'),
  );
  document.body.appendChild(bar);
  const cleanupBar = () => bar.remove();

  const renderer = new MatchRenderer();
  activeRenderer = renderer;
  await renderer.init();

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/match?fixture=${fixtureId}`);
  activeWs = ws;
  ws.onmessage = (ev) => { try { renderer.sync(JSON.parse(ev.data)); } catch { /* */ } };
  ws.onclose = () => { /* match over or navigated away */ };

  // Hook hashchange once to tear down when leaving.
  const onLeave = () => {
    if (!location.hash.startsWith('#/watch/')) {
      teardownWatch(); cleanupBar(); window.removeEventListener('hashchange', onLeave);
    }
  };
  window.addEventListener('hashchange', onLeave);
}

// ── router ──
function route() {
  const hash = location.hash;
  if (!user) { screenAuth(); return; }
  if (!hash.startsWith('#/watch/')) teardownWatch();
  if (hash.startsWith('#/watch/')) screenWatch(Number(hash.split('/')[2]));
  else if (hash === '#/tactics') screenTactics();
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
