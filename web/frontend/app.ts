import './styles.css';
import { api, type TeamT, type LeagueT, type FixtureT, type MarketT, type CupT, type ReportT, type NewsItemT, type ScoutT, type SeasonHistoryT, type StaffViewT, type FinancesT, type ManagerCareerT, type OfferT, type TrainingReportT, type ScoutPlayerT, type IncomingOfferT, type AcademyProspectT, type FreeAgentOfferT, type TalkToneT, type TalkReactionT, type TacticsReviewT, type ShoutReviewT, type TimelineEventT, type LeadersT } from './api';
import { parseRouteId } from './util';
// ── extracted subsystems (Round: appts-audit) ── app.ts used to be one 5,500-line module. The layers below
// go bottom-up (dom → format/shell → states/modal → nav/pitch → screens) and none of them imports app.ts, so
// the graph is acyclic. Screens that need to re-dispatch the current route call shell.rerender(), which boot
// wires to route() — that indirection is what keeps a screen module from importing the router.
import { h, clickable } from './ui/dom.ts';
import { fmtMoney, parseMoneyInput, skillOvr, SQUAD_ATTRS, attrTokens, ordinal, TRAINING_FOCI, ATTR_SHORT, focusLabel, fmtDelta } from './ui/format.ts';
import { root, mount, toast, screenGuard, bumpRouteGen, goBack, noteRouteHash, getUser, setUser, setOnboarding, setTacticsPlanFlash, setRerender, rerender } from './ui/shell.ts';
import { isOffline, errMessage, loadingState, emptyState, errorState, offlineState, partialFailure, guardSelect, scrollRegion, pageHead, subcard, responsiveTable } from './ui/states.ts';
import { confirmModal, promptModal } from './ui/modal.ts';
import { header, setupBottomNav, syncNav, closeNavSheet } from './ui/nav.ts';
import { flagOf, nationNameOf, loadNations, nationsLoaded } from './ui/nations.ts';
import { screenWatch, teardownWatch } from './screens/watch.ts';
import { screenCreateTeam } from './screens/create-team.ts';
import { screenDashboard } from './screens/dashboard.ts';
import { screenSquad } from './screens/squad.ts';
import { screenPlayer } from './screens/player.ts';
import { screenTactics, teardownTactics } from './screens/tactics.ts';

// A screen-level error mount used by the router async error boundary + malformed-route not-found.
function mountError(title: string, detail: string, onRetry?: () => void): void {
  mount(header(), h('div', { class: 'wrap' }, errorState({ title, detail, onRetry, back: 'dashboard' })));
}

// ── auth ──
function screenAuth() {
  document.title = 'Sign in · Footy Manager';
  let tab: 'login' | 'register' = 'login';
  let submitting = false;
  const err = h('div', { id: 'auth-error', class: 'err', role: 'status', 'aria-live': 'polite' });
  const uname = h('input', { id: 'f-uname', placeholder: 'username', autocomplete: 'username', required: true, minlength: '2', maxlength: '32', 'aria-describedby': 'auth-error' }) as HTMLInputElement;
  const pass = h('input', { id: 'f-pass', type: 'password', placeholder: 'password', autocomplete: 'current-password', required: true, minlength: '4', 'aria-describedby': 'auth-error' }) as HTMLInputElement;
  const submit = h('button', { type: 'submit' }, 'Sign in');

  async function go() {
    if (submitting) return;
    submitting = true;
    err.textContent = '';
    submit.setAttribute('disabled', 'true');
    try {
      const fn = tab === 'login' ? api.login : api.register;
      const r = await fn(uname.value.trim(), pass.value);
      setUser(r.user);
      rerender();
    } catch (e: any) { err.textContent = e.message; submitting = false; submit.removeAttribute('disabled'); }
  }
  const form = h('form', { id: 'auth-form', role: 'tabpanel', 'aria-labelledby': 'auth-tab-login', onsubmit: (e: SubmitEvent) => { e.preventDefault(); void go(); } },
    h('div', { class: 'field' }, h('label', { for: 'f-uname' }, 'Username'), uname),
    h('div', { class: 'field' }, h('label', { for: 'f-pass' }, 'Password'), pass),
    submit, err);

  const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Account access' });
  const tLogin = h('button', { id: 'auth-tab-login', type: 'button', class: 'active', role: 'tab', tabindex: '0', 'aria-selected': 'true', 'aria-controls': 'auth-form' }, 'Log in');
  const tReg = h('button', { id: 'auth-tab-register', type: 'button', role: 'tab', tabindex: '-1', 'aria-selected': 'false', 'aria-controls': 'auth-form' }, 'Register');
  const setTab = (t: 'login' | 'register') => {
    tab = t; err.textContent = '';
    tLogin.classList.toggle('active', t === 'login');
    tReg.classList.toggle('active', t === 'register');
    tLogin.setAttribute('aria-selected', String(t === 'login'));
    tReg.setAttribute('aria-selected', String(t === 'register'));
    tLogin.tabIndex = t === 'login' ? 0 : -1;
    tReg.tabIndex = t === 'register' ? 0 : -1;
    form.setAttribute('aria-labelledby', t === 'login' ? 'auth-tab-login' : 'auth-tab-register');
    pass.autocomplete = t === 'login' ? 'current-password' : 'new-password';
    submit.textContent = t === 'login' ? 'Sign in' : 'Create account';
    document.title = `${t === 'login' ? 'Sign in' : 'Create account'} · Footy Manager`;
  };
  tLogin.addEventListener('click', () => setTab('login'));
  tReg.addEventListener('click', () => setTab('register'));
  const tabKey = (e: KeyboardEvent) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const current = document.activeElement === tReg ? 'register' : 'login';
    const next = e.key === 'Home' ? 'login' : e.key === 'End' ? 'register' : current === 'login' ? 'register' : 'login';
    setTab(next); (next === 'login' ? tLogin : tReg).focus();
  };
  tLogin.addEventListener('keydown', tabKey);
  tReg.addEventListener('keydown', tabKey);
  tabs.append(tLogin, tReg);

  mount(h('div', { class: 'center' },
    h('div', { class: 'card auth-card' },
      h('div', { class: 'brand', style: 'font-size:24px;margin-bottom:6px' }, 'FOOTY ', h('span', { class: 'a' }, 'MANAGER')),
      h('div', { class: 'muted', style: 'margin-bottom:18px' }, 'Build a team. Set your tactics. Play the season.'),
      tabs,
      form,
    ),
  ));
}

// §autonomous: the world lobby — browse shared (multiplayer) worlds and claim an unclaimed club. A world
// advances on a schedule (2 turns/day); you set tactics/transfers and the matchday plays automatically.
async function screenWorlds() {
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading worlds…')));
  let data: Awaited<ReturnType<typeof api.worlds>>;
  try { data = await api.worlds(); }
  catch (e: any) { if (!alive()) return; return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message))); }

  const container = h('div', {});
  let worldRequest = 0;
  let claimBusy = false;
  const claimButtons = new Set<HTMLButtonElement>();
  const paintClaimBusy = () => {
    for (const button of claimButtons) {
      if (!button.isConnected) { claimButtons.delete(button); continue; }
      button.disabled = claimBusy;
    }
  };
  const cadence = (min: number) => min % 1440 === 0 ? `${min / 1440}/day` : `every ${Math.round(min / 60)}h`;
  const claimInto = async (worldId: number, teamId: number, btn: HTMLButtonElement) => {
    if (claimBusy) return;
    claimBusy = true; paintClaimBusy(); btn.textContent = 'Claiming…';
    try {
      await api.claimTeam(worldId, teamId);
      if (!alive()) return;
      toast('✓ Club claimed — welcome to the world!'); location.hash = '#/';
    } catch (e: any) { if (alive()) toast(e.message); }
    finally { claimBusy = false; btn.textContent = 'Claim'; paintClaimBusy(); }
  };
  const openWorld = async (w: import('./api').JoinableWorldT) => {
    const request = ++worldRequest;
    claimButtons.clear();
    const host = h('div', { class: 'card muted' }, 'Loading clubs…');
    container.replaceChildren(
      h('div', { class: 'between' }, h('h2', {}, w.name), h('button', { class: 'ghost', onclick: () => render() }, '← All worlds')),
      h('div', { class: 'muted', style: 'margin:-4px 0 10px;font-size:13px' }, `Season ${w.season} · turn ${w.turn} · advances ${cadence(w.intervalMin)} · ${w.unclaimed} club(s) open`),
      host);
    try {
      const { teams } = await api.worldTeams(w.worldId);
      if (!alive() || request !== worldRequest) return;
      const rowFor = (t: import('./api').ClaimableTeamT) => {
        const claim = h('button', { class: 'primary small' }, 'Claim') as HTMLButtonElement;
        if (!t.claimed && !data.hasTeam) { claimButtons.add(claim); claim.disabled = claimBusy; }
        claim.addEventListener('click', () => claimInto(w.worldId, t.teamId, claim));
        return h('tr', {},
          h('td', {}, t.name, h('span', { class: 'muted', style: 'font-size:11px' }, ` · ${t.division}`)),
          h('td', { class: 'num' }, `T${t.tier}`),
          h('td', { class: 'num' }, String(t.overall)),
          h('td', { class: 'num' }, t.claimed ? h('span', { class: 'muted', style: 'font-size:12px' }, `👤 ${t.manager}`) : (data.hasTeam ? h('span', { class: 'muted', style: 'font-size:11px' }, 'open') : claim)));
      };
      host.replaceChildren(h('div', { class: 'card', style: 'padding:0;overflow-x:auto' },
        h('table', { style: 'width:100%' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Club'), h('th', { class: 'num' }, 'Div'), h('th', { class: 'num' }, 'OVR'), h('th', { class: 'num' }, ''))),
          h('tbody', {}, ...teams.map(rowFor))),
        data.hasTeam ? h('div', { class: 'muted', style: 'padding:10px;font-size:12px' }, 'You already manage a club — leave it first (from your dashboard) to claim here.') : ''));
    } catch (e: any) { if (alive() && request === worldRequest) host.replaceChildren(h('div', { class: 'card err' }, e.message)); }
  };
  const render = () => {
    worldRequest++;   // invalidate a slower club-list request after returning to the lobby
    container.replaceChildren(
      h('div', { class: 'between' }, h('div', {}, h('h2', {}, '🌍 Shared worlds'), h('div', { class: 'muted', style: 'font-size:13px' }, 'Live multiplayer worlds that advance on a schedule. Claim a club to join.')),
        h('button', { class: 'ghost', onclick: () => (location.hash = data.hasTeam ? '#/' : '') }, data.hasTeam ? '← Dashboard' : '← Back')),
      data.worlds.length
        ? h('div', { class: 'grid' }, ...data.worlds.map(w => h('div', { class: 'card', ...clickable(() => openWorld(w)), style: 'cursor:pointer' },
            h('div', { class: 'between' },
              h('div', {}, h('div', { style: 'font-weight:700' }, w.name), h('div', { class: 'muted', style: 'font-size:12px' }, `Season ${w.season} · turn ${w.turn} · advances ${cadence(w.intervalMin)}`)),
              h('span', { class: 'pill', style: w.unclaimed ? 'background:var(--accent);color:#0b1018' : '' }, `${w.unclaimed}/${w.total} open`)))))
        : emptyState({ icon: '🌍', title: 'No shared worlds yet', hint: 'Ask an admin to open one — or start your own solo career.', action: h('button', { class: 'primary small', style: 'margin-top:6px', onclick: () => screenCreateTeam() }, 'Create a solo club →') }));
  };
  if (!alive()) return;
  mount(header(), h('div', { class: 'wrap grid' }, container));
  render();
}

// §national-teams: international tournaments (World Cup + continental) + the nations that can field a
// squad in this world. Tournaments run in the off-season (at rollover); results show here.
async function screenInternationals() {
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading internationals…')));
  if (!nationsLoaded()) await loadNations();
  let data: Awaited<ReturnType<typeof api.tournaments>>;
  try { data = await api.tournaments(); }
  catch (e: any) { if (!alive()) return; if (String(e.message).includes('no team')) return screenCreateTeam(); return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message))); }
  // Nations render with a flag; clubs (Club World Cup) have no flag key, so show the name as-is.
  const nat = (k: string | null) => { if (!k) return 'TBD'; const f = flagOf(k); return `${f ? f + ' ' : ''}${nationNameOf(k) || k}`; };

  // bracket for one tournament: rounds as columns (like the cup), winners bold, pens shown
  const bracket = (t: import('./api').TournamentT) => {
    const totalRounds = t.ties.reduce((m, x) => Math.max(m, x.round), 0);
    const roundName = (r: number) => { const d = totalRounds - r; return d === 0 ? 'Final' : d === 1 ? 'Semi-finals' : d === 2 ? 'Quarter-finals' : `Round of ${2 ** (d + 1)}`; };
    const byRound = new Map<number, import('./api').TournamentTieT[]>();
    for (const tie of t.ties) { const a = byRound.get(tie.round) ?? []; a.push(tie); byRound.set(tie.round, a); }
    const tieClass = (winner: string | null, side: string | null): string => !winner ? 'bracket-team pending' : winner === side ? 'bracket-team winner' : 'bracket-team loser';
    const cols = [...byRound.keys()].sort((a, b) => a - b).map(r => h('div', { style: 'min-width:190px' },
      h('div', { class: 'section-title', style: 'margin-top:0' }, roundName(r)),
      ...byRound.get(r)!.map(tie => h('div', { class: 'card', style: 'padding:8px;margin-bottom:8px;font-size:13px' },
        h('div', { class: tieClass(tie.winner, tie.home) }, h('span', {}, nat(tie.home)), h('span', {}, `${tie.homeScore ?? ''}${tie.homePens != null ? ` (${tie.homePens})` : ''}`)),
        h('div', { class: tieClass(tie.winner, tie.away) }, h('span', {}, nat(tie.away)), h('span', {}, `${tie.awayScore ?? ''}${tie.awayPens != null ? ` (${tie.awayPens})` : ''}`))))));
    return h('div', { class: 'card' },
      h('div', { class: 'between' }, h('div', {}, h('div', { style: 'font-weight:700;font-size:16px' }, `${t.kind === 'world_cup' ? '🌍' : t.kind === 'club_world_cup' ? '🏟️' : '🏆'} ${t.name}`), h('div', { class: 'muted', style: 'font-size:12px' }, `Season ${t.season}${t.champion ? '' : ' · in progress'}`)),
        t.champion ? h('span', { class: 'pill', style: 'background:var(--gold,#e8b53a);color:#1a1205;font-weight:700' }, `🏆 ${nat(t.champion)}`) : ''),
      h('div', { class: 'bracket-scroll', tabindex: '0', role: 'region', 'aria-label': 'Tournament bracket' }, ...cols));
  };

  // qualified nations by confederation, click → the nation's XI
  const squadHost = h('div', {}, h('div', { class: 'card muted' }, 'Select a nation to see its strongest available XI.'));
  let squadRequest = 0;
  const showSquad = async (key: string) => {
    const request = ++squadRequest;
    intlNation = key;   // survives navigation (module-level)
    nationsCard.querySelectorAll<HTMLElement>('[data-nation]').forEach(el => { const on = el.dataset.nation === key; el.classList.toggle('active', on); if (on) el.setAttribute('aria-current', 'true'); else el.removeAttribute('aria-current'); });
    if (window.matchMedia('(max-width: 860px)').matches) squadHost.scrollIntoView({ behavior: 'smooth', block: 'start' });   // on mobile the squad panel stacks below the long nations list — bring it into view
    squadHost.replaceChildren(h('div', { class: 'muted', style: 'font-size:12px' }, 'Loading squad…'));
    try {
      const { squad } = await api.nationSquad(key);
      if (!alive() || request !== squadRequest) return;
      squadHost.replaceChildren(h('div', { class: 'card' },
        h('div', { class: 'section-title', style: 'margin-top:0' }, `${nat(key)} — best XI`),
        squad.length ? h('div', { class: 'nation-xi' }, ...squad.map(p => h('div', { class: 'between', style: 'font-size:13px;padding:2px 0' }, h('span', {}, p.name, h('span', { class: 'muted', style: 'font-size:11px' }, ` ${p.role}`)), h('span', { style: 'font-weight:600' }, String(p.overall))))) : h('div', { class: 'muted' }, 'Not enough players to field a squad.')));
    } catch (e: any) { if (alive() && request === squadRequest) squadHost.replaceChildren(h('div', { class: 'card err' }, e.message)); }
  };
  const byConfed = new Map<string, typeof data.fieldable>();
  for (const f of data.fieldable) { const a = byConfed.get(f.confed) ?? []; a.push(f); byConfed.set(f.confed, a); }
  const nationsCard = h('div', { class: 'card' },
    h('div', { class: 'section-title', style: 'margin-top:0' }, `Qualified nations (${data.fieldable.length})`),
    data.fieldable.length
      ? h('div', { class: 'grid cols-2', style: 'gap:6px 20px' }, ...[...byConfed.entries()].map(([cf, nats]) => h('div', {},
          h('div', { class: 'muted', style: 'font-size:11px;text-transform:uppercase;letter-spacing:.4px;margin:6px 0 3px' }, cf),
          ...nats.sort((a, b) => b.strength - a.strength).map(f => h('div', { class: 'between intl-nation', 'data-nation': f.key, style: 'font-size:13px;padding:2px 0;cursor:pointer', ...clickable(() => showSquad(f.key)) },
            h('span', {}, nat(f.key), h('span', { class: 'muted', style: 'font-size:11px' }, ` · ${f.count} players`)), h('span', { style: 'font-weight:700' }, String(f.strength)))))))
      : h('div', { class: 'muted', style: 'font-size:13px' }, 'No nations have enough players to field a squad yet — squads fill out as youth come through.'));

  if (!alive()) return;
  mount(header(), h('div', { class: 'wrap grid' },
    h('div', { class: 'between' }, h('div', {}, h('h2', {}, '🌍 Internationals'), h('div', { class: 'muted', style: 'font-size:13px' }, 'National teams (by player nationality) contest the World Cup every 4 seasons + continental cups; the world\'s best clubs meet in the Club World Cup. Held in the off-season.')),
      h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, '← Back')),
    data.tournaments.length
      ? h('div', { class: 'grid' },
          ...data.tournaments.slice(0, 4).map(bracket),
          // recent tournaments visible; older seasons' brackets go behind a "Show history" disclosure so the
          // current continental cups (up to 6) aren't silently dropped by an arbitrary top-4 cap.
          data.tournaments.length > 4
            ? h('details', { style: 'margin-top:2px' },
                h('summary', { style: 'cursor:pointer;color:var(--muted);font-size:13px;padding:4px 0' }, `Show ${data.tournaments.length - 4} older tournament${data.tournaments.length - 4 > 1 ? 's' : ''}`),
                h('div', { class: 'grid', style: 'margin-top:10px' }, ...data.tournaments.slice(4).map(bracket)))
            : '')
      : h('div', { class: 'card muted' }, 'No tournaments yet — the first internationals play at the end of this season.'),
    h('div', { class: 'grid cols-2', style: 'align-items:start' }, nationsCard, squadHost)));
  // restore the previously-selected nation on re-entry (module-level intlNation)
  if (intlNation && data.fieldable.some(f => f.key === intlNation)) void showSquad(intlNation);
}

// ── transfer market ──
async function screenMarket() {
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, loadingState('Loading the transfer market…')));
  let market: MarketT;
  try { market = await api.market(); }
  catch (e: any) {
    if (!alive()) return;
    if (String(e.message).includes('no team')) return screenCreateTeam();
    return mount(header(), h('div', { class: 'wrap' }, errorState({ title: 'Couldn’t load the market', detail: errMessage(e), onRetry: () => screenMarket(), back: 'dashboard' })));
  }
  // The four side panels are INDEPENDENT + optional — fetch them in PARALLEL (was four serial round-trips, so
  // time-to-interactive was the SUM not the max) and keep each panel's FAILURE distinct from genuinely-empty,
  // so a transient error surfaces a retry note instead of a silently-empty panel.
  let offers: OfferT[] = [], incoming: IncomingOfferT[] = [], faOffers: FreeAgentOfferT[] = [];
  let shortlist: import('./api').ShortlistRowT[] = [];
  let shortIds = new Set<number>();
  const failed = { offers: false, incoming: false, faOffers: false, shortlist: false };
  const [offR, incR, faR, shR] = await Promise.allSettled([api.offers(), api.incomingOffers(), api.freeAgentOffers(), api.shortlist()]);
  if (!alive()) return;
  if (offR.status === 'fulfilled') offers = offR.value.offers; else failed.offers = true;
  if (incR.status === 'fulfilled') incoming = incR.value.incoming; else failed.incoming = true;
  if (faR.status === 'fulfilled') faOffers = faR.value.offers; else failed.faOffers = true;
  if (shR.status === 'fulfilled') { shortlist = shR.value.shortlist; shortIds = new Set(shR.value.ids); } else failed.shortlist = true;
  const refreshOffers = async (): Promise<void> => { try { offers = (await api.offers()).offers; failed.offers = false; } catch { /* keep current */ } };
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
          const wage = parseMoneyInput(raw);
          if (wage == null) { toast('Enter a valid wage — e.g. 50k or 50000'); return; }
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
      const fee = parseMoneyInput(raw);
      if (fee == null) { toast('Enter a valid bid — e.g. 1.5m, 500k, or 1500000'); return; }
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
          if (!await confirmModal('Match their price?', `Pay ${fmtMoney(o.counterFee ?? o.fee)} to complete this signing? This commits club funds now.`, `Pay ${fmtMoney(o.counterFee ?? o.fee)}`)) return;
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
          if (!await confirmModal('Sell player?', `Accept the ${fmtMoney(o.fee)} bid for ${o.playerName}? This is a binding, irreversible sale.`, 'Sell', 'danger')) return;
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
      // §1.6: a panel that FAILED to load (vs genuinely empty) gets a visible retry, not a silent blank.
      (failed.offers || failed.incoming || failed.faOffers || failed.shortlist)
        ? partialFailure('some transfer panels', () => screenMarket())
        : '',
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
        scrollRegion('Free agents', responsiveTable(headRow('Player'), faBody), { maxH: '520px', dataScroll: 'fa', sticky: true })),
      h('div', { class: 'card' },
        h('div', { class: 'section-title', style: 'margin-top:0' }, 'Your squad'),
        h('div', { class: 'muted', style: 'margin:-6px 0 8px;font-size:12px' }, `List a player to sell him — an AI club may buy once you have squad depth (12+).${win.open ? ' Listings lapse at the deadline if unsold.' : ''}`),
        scrollRegion('Your squad', responsiveTable(headRow('Player'), sqBody), { maxH: '520px', dataScroll: 'squad', sticky: true })),
      incomingCard,
      offersCard,
      h('div', { class: 'card' },
        h('div', { class: 'section-title', style: 'margin-top:0' }, 'For sale — other clubs',
          win.open ? '' : h('span', { class: 'pill', style: 'margin-left:8px;text-transform:none;letter-spacing:0;background:#3a2a1f;color:#ffce9a' }, '🔒 window shut')),
        h('div', { class: 'muted', style: 'margin:-6px 0 8px;font-size:12px' }, win.open ? 'Bid for a listed player — the club may accept, counter, or reject.' : 'Bidding opens during a transfer window.'),
        scrollRegion('For sale — other clubs', responsiveTable(headRow('Player'), tgtBody), { maxH: '420px', dataScroll: 'targets', sticky: true })),
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
  catch (e: any) { if (!alive()) return; if (String(e.message).includes('no team')) return screenCreateTeam(); return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message))); }

  const expanded = new Set<number>();   // player ids whose fogged attributes are shown
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
    const maxValueText = valInput.value.trim();
    const maxValue = maxValueText ? parseMoneyInput(maxValueText) : null;
    if (maxValueText && maxValue == null) { toast('Enter a valid maximum value — e.g. 5m or 5000000'); valInput.focus(); return; }
    const my = ++searchSeq;
    searchBtn.setAttribute('disabled', 'true'); searchBtn.textContent = '…';
    try {
      const r = await api.searchPlayers({
        role: roleSel.value || undefined,
        maxAge: ageInput.value ? Number(ageInput.value) : undefined,
        minOverall: ovrInput.value ? Number(ovrInput.value) : undefined,
        maxValue: maxValue ?? undefined,
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
      // Un-nested: the star and the expand control are SIBLING real <button>s in a non-interactive <td> (no more
      // role=button-inside-role=button + the stopPropagation crutch). aria-pressed = shortlist state; aria-expanded
      // on the name button reflects the detail row.
      const isExp = expanded.has(p.id);
      const star = h('button', { type: 'button', class: 'icon-btn', 'aria-pressed': String(p.shortlisted), title: p.shortlisted ? 'On your shortlist — click to remove' : 'Add to your shortlist',
        style: `margin-right:5px;${p.shortlisted ? 'color:var(--gold,#e8b53a)' : 'opacity:.4'}`, onclick: () => toggleStar(p) }, '★');
      const nameBtn = h('button', { type: 'button', class: 'linkish', 'aria-expanded': String(isExp), title: 'Show scouted attributes',
        onclick: () => { if (expanded.has(p.id)) expanded.delete(p.id); else expanded.add(p.id); renderResults(); } },
        p.name, h('span', { class: 'muted', style: 'font-size:11px' }, ' · ' + p.club),
        p.releaseClause != null ? h('span', { class: 'pill', title: 'Release clause — instantly buyable from the Market', style: 'margin-left:6px;background:rgba(230,57,70,.18);color:#f2a1a8' }, `⚡ ${fmtMoney(p.releaseClause)}`)
          : p.buyable ? h('span', { class: 'pill', title: 'Listed for sale — bid from the Market', style: 'margin-left:6px' }, 'listed') : '');
      const nameCell = h('td', {}, star, nameBtn);
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
async function screenTraining() {
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading…')));
  let team: TeamT;
  try { team = await api.team(); }
  catch (e: any) {
    if (!alive()) return;
    if (String(e.message).includes('no team')) return screenCreateTeam();
    return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message)));
  }
  // The report is best-effort — show the screen even if it hasn't been generated yet (or 404s).
  let report: TrainingReportT | null = null;
  try { report = (await api.trainingReport()).report; } catch { /* no report yet */ }
  const ovrOf = (p: typeof team.players[number]) => skillOvr(p.attrs, p.role);

  // club-wide focus selector
  const sel = h('select', { class: 'focus-select', 'aria-label': 'Club training focus' }) as HTMLSelectElement;
  for (const f of TRAINING_FOCI) {
    const o = h('option', { value: f }, focusLabel(f)) as HTMLOptionElement;
    if (f === (team.trainingFocus ?? 'balanced')) o.selected = true;
    sel.append(o);
  }
  guardSelect(sel, async v => { const r = await api.setTraining(v); toast(`Club training focus: ${focusLabel(r.focus)}`); return r.focus; }, alive);

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
  guardSelect(tiSel, async v => { const r = await api.setTeamIntensity(v); tiHint.textContent = intensityHint(r.intensity); toast(`Club intensity: ${r.intensity}`); return r.intensity; }, alive);

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
          try { const r = await api.applyTrainingPreset(name); if (!alive()) return; toast(`Training schedule: ${r.preset?.label ?? label}`); route(); }
          catch (e: any) { if (alive()) toast(e.message); }
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
    guardSelect(pfSel, async v => { const r = await api.setPlayerTraining(p.slot, v); toast(r.focus ? `${p.name}: ${focusLabel(r.focus)}` : `${p.name} follows the club focus`); return r.focus ?? undefined; }, alive);
    // per-player training intensity — faster growth at a higher injury cost (normal = the default / byte-identical)
    const piSel = h('select', { class: 'focus-select', style: 'font-size:12px;padding:2px 4px', 'aria-label': 'Training intensity for ' + p.name, title: 'Higher intensity grows faster but raises injury risk; rest recovers' }) as HTMLSelectElement;
    for (const [iv, lbl] of [['normal', 'Normal'], ['double', 'Double ↑'], ['half', 'Light'], ['rest', 'Rest']]) {
      const o = h('option', { value: iv }, lbl) as HTMLOptionElement;
      if (iv === (p.trainIntensity ?? 'normal')) o.selected = true;
      piSel.append(o);
    }
    guardSelect(piSel, async v => { const r = await api.setPlayerIntensity(p.slot, v); toast(`${p.name}: ${r.intensity ?? 'normal'} training`); return r.intensity ?? undefined; }, alive);
    // position retrain — learn a new role; while settling, he develops a little slower (familiarity bar)
    const rtSel = h('select', { class: 'focus-select', style: 'font-size:12px;padding:2px 4px', 'aria-label': 'Retrain position for ' + p.name, title: 'Retrain this player into a new position. He settles in over several matchdays, developing a little slower until comfortable.' }) as HTMLSelectElement;
    rtSel.append(h('option', { value: '' }, 'No (stay ' + p.role + ')'));
    for (const role of ['GK', 'FB', 'CB', 'CM', 'WM', 'CF']) {
      if (role === p.role) continue;
      const o = h('option', { value: role }, '→ ' + role) as HTMLOptionElement;
      if (role === (p.retrainRole ?? '')) o.selected = true;
      rtSel.append(o);
    }
    guardSelect(rtSel, async v => { const r = await api.setPlayerRetrain(p.slot, v || 'clear'); if (!alive()) return; toast(r.retrainRole ? `${p.name}: retraining → ${r.retrainRole}` : `${p.name}: settled at ${p.role}`); route(); return r.retrainRole ?? undefined; }, alive);
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
      h('div', { style: 'margin-top:8px' },
        scrollRegion('Training table', responsiveTable(
          h('thead', {}, h('tr', {},
            h('th', {}, 'Player'), h('th', {}, 'Pos'),
            h('th', { class: 'num' }, 'Age'), h('th', { class: 'num' }, 'OVR'), h('th', { class: 'num' }, 'Potential'), h('th', {}, 'Focus'), h('th', {}, 'Intensity'), h('th', {}, 'Retrain'))),
          body), { maxH: '540px', sticky: true })),
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
    if (!alive()) return;
    if (String(e.message).includes('no team')) return screenCreateTeam();
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
        h('button', { class: 'ghost', onclick: () => goBack() }, '← Back')),
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
  catch (e: any) { if (!alive()) return; if (String(e.message).includes('no team')) return screenCreateTeam(); return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message))); }

  const body = h('tbody');
  // best-potential first, so the ones worth promoting rise to the top
  for (const p of [...prospects].sort((a, b) => (b.potential ?? b.overall) - (a.potential ?? a.overall))) {
    const room = (p.potential ?? p.overall) - p.overall;
    const promote = h('button', { class: 'primary small' }, 'Promote');
    promote.addEventListener('click', async () => {
      promote.setAttribute('disabled', 'true');
      try { const r = await api.promoteProspect(p.id); if (!alive()) return; toast(`${r.player} promoted to the senior squad`); route(); }
      catch (e: any) { if (!alive()) return; toast(e.message); promote.removeAttribute('disabled'); }
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
      ? h('div', { class: 'card' }, scrollRegion('Academy prospects', responsiveTable(
          h('thead', {}, h('tr', {}, h('th', {}, 'Prospect'), h('th', {}, 'Pos'), h('th', { class: 'num' }, 'Age'), h('th', { class: 'num' }, 'OVR'), h('th', { class: 'num' }, 'Potential'), h('th', {}, ''))),
          body), { maxH: '540px', sticky: true }))
      : h('div', { class: 'card muted', style: 'font-size:13px' }, 'No prospects right now — your next youth intake arrives at the end of the season.'),
  ));
}

// ── news archive (§2.14): the full club-news feed, grouped by season ──
async function screenNews() {
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading the archive…')));
  let news: NewsItemT[];
  try { news = (await api.news(200)).news; }
  catch (e: any) { if (!alive()) return; if (String(e.message).includes('no team')) return screenCreateTeam(); return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message))); }
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
  catch (e: any) { if (!alive()) return; if (String(e.message).includes('no team')) return screenCreateTeam(); return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message))); }

  let filter = inboxFilter;   // survives navigation (module-level)
  const container = h('div', {});
  const render = () => {
    const items = filter === 'all' ? data.inbox : data.inbox.filter(i => (i.category ?? '') === filter);
    const cats = [...new Set(data.inbox.map(i => i.category ?? 'other'))];
    const chip = (key: string, label: string) => h('button', { class: filter === key ? 'primary small' : 'ghost small', 'aria-pressed': String(filter === key), onclick: () => { filter = key; inboxFilter = key; render(); } }, label);
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

  // The subtitle count + the markAll button live OUTSIDE render() (which only rebuilds the message list), so a
  // helper repaints them after any unread change — otherwise 'Mark all read' left a stale '· N unread' and an
  // enabled button that just re-hit the endpoint.
  const subtitle = h('div', { class: 'muted' });
  const markAll = h('button', { class: 'ghost small' }, 'Mark all read') as HTMLButtonElement;
  const syncHeader = () => {
    subtitle.textContent = `${data.inbox.length} item(s)${data.unread ? ` · ${data.unread} unread` : ''}`;
    markAll.disabled = data.unread === 0;
    markAll.style.display = data.unread === 0 ? 'none' : '';
  };
  markAll.addEventListener('click', async () => {
    markAll.disabled = true;
    try { const r = await api.markInboxRead({ all: true }); data.unread = r.unread; data.inbox.forEach(i => i.read = true); render(); syncHeader(); }
    catch (e: any) { toast(e.message); syncHeader(); }
  });
  if (!alive()) return;
  mount(header(), h('div', { class: 'wrap grid' },
    h('div', { class: 'between' },
      h('div', {}, h('h2', {}, '📨 Inbox'), subtitle),
      h('div', { class: 'row', style: 'gap:8px' }, markAll, h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, '← Back'))),
    container));
  syncHeader();
  render();
}

// ── league stat leaders (§stat-leaders): the division's top scorers + assisters this season ──
async function screenLeaders() {
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading the leaderboards…')));
  let d: LeadersT;
  try { d = await api.leaders(); }
  catch (e: any) {
    if (!alive()) return;
    if (String(e.message).includes('no team')) return screenCreateTeam();
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
    pageHead('Stat leaders', { subtitle: h('div', { class: 'muted' }, `${d.division} · this season`), onBack: () => (location.hash = '#/') }),
    h('div', { class: 'grid cols-2', style: 'align-items:start' },
      board('🥇 Top scorers', 'goals', d.scorers),
      board('🅰️ Top assists', 'assists', d.assists)),
    h('div', { class: 'grid cols-2', style: 'align-items:start' },
      board('⭐ Best average rating', 'ratings', d.ratings),
      totCard)));
}

// ── cup (knockout bracket) ──
async function screenCup() {
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading…')));
  let cup: CupT;
  try { cup = await api.cup(); }
  catch (e: any) { if (!alive()) return; if (String(e.message).includes('no team')) return screenCreateTeam(); return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message))); }
  if (!cup.rounds.length) return mount(header(), h('div', { class: 'wrap grid' },
    h('div', { class: 'between' }, h('h2', {}, 'Cup'), h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, '← Back')),
    h('div', { class: 'card muted' }, 'No cup this season.')));

  const teamRow = (name: string | null, score: number | null, pens: number | null, won: boolean, decided: boolean, isMe: boolean) =>
    h('div', { class: `bracket-team ${decided ? won ? 'winner' : 'loser' : 'pending'}${isMe ? ' me' : ''}`, style: 'font-size:12px;gap:10px' },
      h('span', {}, name ?? 'TBD'), h('span', {}, score != null ? `${score}${pens != null ? ` (${pens})` : ''}` : ''));
  const cols = cup.rounds.map(rd => h('div', { style: 'min-width:170px' },
    h('div', { class: 'section-title', style: 'margin-top:0' }, rd.name),
    ...rd.ties.map(t => {
      // Only YOUR ties carry a recording (human stake), so Watch/Report show on played ties you were in.
      const mine = t.homeTeamId === cup.myTeamId || t.awayTeamId === cup.myTeamId;
      return h('div', { class: 'card', style: 'padding:8px;margin-bottom:8px' },
        teamRow(t.home, t.homeScore, t.homePens, t.winnerTeamId === t.homeTeamId, t.winnerTeamId != null, t.homeTeamId === cup.myTeamId),
        teamRow(t.away, t.awayScore, t.awayPens, t.winnerTeamId === t.awayTeamId, t.winnerTeamId != null, t.awayTeamId === cup.myTeamId),
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
    h('div', { class: 'card' }, h('div', { class: 'bracket-scroll', tabindex: '0', role: 'region', 'aria-label': 'Tournament bracket' }, ...cols)),
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
  const shootoutLine = rep.shootout ? (() => {
    const winnerName = rep.shootout.winner === 'home' ? rep.homeName : rep.awayName;
    const winnerPens = rep.shootout.winner === 'home' ? rep.shootout.home : rep.shootout.away;
    const loserPens = rep.shootout.winner === 'home' ? rep.shootout.away : rep.shootout.home;
    return h('div', { style: 'text-align:center;font-size:13px;font-weight:700;margin-top:4px;color:var(--gold,#e8b53a)' }, `${winnerName} won ${winnerPens}–${loserPens} on penalties`);
  })() : '';
  const scoreboard = h('div', { class: 'card' },
    h('div', { style: 'display:flex;align-items:baseline;justify-content:center;gap:18px;flex-wrap:wrap' },
      h('div', { style: `flex:1;min-width:120px;text-align:right;font-weight:700;color:${HOME_C}` }, rep.homeName),
      h('div', { style: 'font-size:34px;font-weight:800;font-variant-numeric:tabular-nums;letter-spacing:1px' }, `${rep.facts.homeScore} — ${rep.facts.awayScore}`),
      h('div', { style: `flex:1;min-width:120px;font-weight:700;color:${AWAY_C}` }, rep.awayName)),
    shootoutLine,
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
  staff: 'Staff fees', wages: 'Player wages', sponsor: 'Sponsorship', gate: 'Gate & TV', other: 'Other',
};
async function screenFinances() {
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading…')));
  let f: FinancesT;
  try { f = await api.finances(); }
  catch (e: any) {
    if (!alive()) return;
    if (String(e.message).includes('no team')) return screenCreateTeam();
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
    pageHead('Finances', { subtitle: h('div', { class: 'muted' }, `Season ${f.season}`), onBack: () => (location.hash = '#/') }),
    h('div', { class: 'card' },
      h('div', { class: 'row', style: 'gap:32px;flex-wrap:wrap' },
        cell('Balance', fmtMoney(f.balance)),
        cell('Income (season)', signed(f.income), col(f.income)),
        cell('Expense (season)', signed(f.expense), col(f.expense)),
        cell('Net (season)', signed(net), col(net)),
        cell('Wage bill', `${fmtMoney(f.wageBill)}/yr`, f.wageBill > f.wageBudget ? 'color:var(--danger)' : ''))),
    // wage bill vs budget bar
    (() => {
      // rawPct is the TRUE percentage (can exceed 100 when over budget — the label must show it);
      // barPct clamps only the bar WIDTH so it can't overflow its track.
      const rawPct = f.wageBudget > 0 ? Math.round((f.wageBill / f.wageBudget) * 100) : 0;
      const barPct = Math.min(100, rawPct);
      const over = f.wageBill > f.wageBudget;
      return h('div', { class: 'card', style: 'padding:10px 14px' },
        h('div', { class: 'between', style: 'font-size:12px;margin-bottom:4px' },
          h('span', { class: 'muted' }, 'Wage bill vs budget'),
          h('span', { style: over ? 'color:var(--danger);font-weight:600' : '' }, `${fmtMoney(f.wageBill)} / ${fmtMoney(f.wageBudget)} (${rawPct}%)`)),
        h('div', { style: 'height:7px;background:var(--panel2,#161f30);border-radius:4px;overflow:hidden' },
          h('div', { style: `height:100%;width:${barPct}%;background:${over ? 'var(--danger)' : 'var(--accent)'}` })));
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
    if (!alive()) return;
    if (String(e.message).includes('no team')) return screenCreateTeam();
    return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message)));
  }
  // Coach-assignment saves are a FULL-snapshot replace server-side, so two quick edits to DIFFERENT categories
  // must not each POST a stale snapshot (one would clobber the other). Serialize them: each save's payload is
  // built from the LATEST v (after the prior save lands).
  let staffChain: Promise<void> = Promise.resolve();
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
        if (!await confirmModal('Release staff', `Release ${s.name}? This is permanent — re-hiring later costs the full fee.`, 'Release', 'danger')) return;
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
        // rollback-safe MULTI-select: snapshot the persisted selection, disable during the round-trip, and roll
        // the options back on failure. Serialized via staffChain so the payload reads the latest v (no clobber).
        let saved = [...c.assigned];
        sel.addEventListener('change', () => {
          const chosen = [...sel.selectedOptions].map(o => Number(o.value));
          sel.disabled = true;
          staffChain = staffChain.then(async () => {
            const assignment: Record<string, number[]> = Object.fromEntries(v.categories.map(cc => [cc.category, cc.category === c.category ? chosen : [...cc.assigned]]));
            try {
              v = await api.saveCoachAssignment(assignment);
              if (!alive()) return;
              saved = chosen; toast(`${c.category} coaching updated`); render();   // render() rebuilds the panel from the new v
            } catch (er) {
              for (const o of sel.options) o.selected = saved.includes(Number(o.value));   // roll back to the last-saved selection
              sel.disabled = false; toast(errMessage(er));
            }
          });
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
          scrollRegion('Your staff', responsiveTable(
            h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Role'), h('th', { class: 'num' }, 'Rating'), h('th', { class: 'num' }, ''))), mineBody), { maxH: '430px', sticky: true })),
        h('div', { class: 'card' },
          h('div', { class: 'section-title', style: 'margin-top:0' }, 'Hire pool'),
          scrollRegion('Hire pool', responsiveTable(
            h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Role'), h('th', { class: 'num' }, 'Rating'), h('th', { class: 'num' }, 'Fee'), h('th', { class: 'num' }, ''))), poolBody), { maxH: '430px', sticky: true })),
      ),
    ));
  }
  render();
}

// ── pre-match opponent scouting report ──
async function screenScout(fixtureId: number) {
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Scouting the opposition…')));
  let s: ScoutT;
  try { s = await api.scout(fixtureId); }
  catch (e: any) {
    if (!alive()) return;
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
      h('button', { class: 'ghost', onclick: () => goBack() }, '← Back')),
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
    if (!alive()) return;
    if (String(e.message).includes('no team')) return screenCreateTeam();
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
    if (!alive()) return;
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

  if (!alive()) return;
  mount(header(), h('div', { class: 'wrap grid' },
    h('div', { class: 'between' },
      h('div', {}, h('h2', {}, 'Club history'),
        h('div', { class: 'muted' }, 'Every completed season and the honours that came with it.')),
      h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, '← Back')),
    subcard('Trophy cabinet', cabinet),
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
    if (!alive()) return;
    if (String(e.message).includes('no team')) screenCreateTeam();
    else mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message)));
  });
  if (!alive()) return;
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
    if (!alive()) return;
    if (String(e.message).includes('no team')) screenCreateTeam();
    else mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message)));
  });
  if (!alive()) return;
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

// Module-level so a filter/selection survives navigating away and back (mirrors the squadView pattern).
let inboxFilter = 'all';
let intlNation: string | null = null;

function route() {
  const hash = location.hash;
  bumpRouteGen();      // invalidate any in-flight screen's pending mount (see screenGuard) — the new route owns the DOM now
  noteRouteHash(hash); // remember where we came from (for goBack)
  setOnboarding(false);// a real route is dispatching → leaving the club-creation screen
  closeNavSheet();     // close the More sheet if a navigation happened while it was open
  syncNav();           // active-tab indication on the persistent mobile bottom bar (hides on auth / Watch / onboarding)
  if (hash !== '#/tactics') teardownTactics();   // leaving the screen drops its gate listeners (see screens/tactics.ts)
  if (!getUser()) { teardownWatch(); screenAuth(); return; }
  if (!hash.startsWith('#/watch/')) teardownWatch();
  const alive = screenGuard();
  // Router async error boundary — an async screen that rejects OUTSIDE its own try/catch (a synchronous render
  // throw, an unhandled path) would otherwise leave a permanent half-mounted spinner. Catch it and show a
  // recoverable error instead. Fires only if this route is still current (a later navigation supersedes it).
  const run = (p: void | Promise<void>): void => { void Promise.resolve(p).catch(err => { if (alive()) mountError('Something went wrong', errMessage(err), () => route()); }); };
  // Validate numeric route params (parseRouteId, see util.ts) so a garbage hash (#/report/abc, #/player/NaN)
  // shows a recoverable not-found state instead of firing NaN at the API.
  const idArg = parseRouteId;
  const notFound = () => mount(header(), h('div', { class: 'wrap' }, errorState({ title: 'Page not found', detail: 'That link doesn’t point to a valid page.', back: 'dashboard' })));

  if (hash.startsWith('#/watch/')) { const id = idArg(hash.split('/')[2] ?? ''); if (id == null) return notFound(); run(screenWatch(id, /[?&]shouts=1\b/.test(hash), /[?&]live=1\b/.test(hash), Number(hash.match(/[?&]t=(\d+)/)?.[1] ?? 0), /[?&]cup=1\b/.test(hash))); }
  else if (hash === '#/worlds') run(screenWorlds());
  else if (hash === '#/internationals') run(screenInternationals());
  else if (hash === '#/matches') run(screenMyMatches());
  else if (hash === '#/league') run(screenLeagueMatches());
  else if (hash === '#/tactics') run(screenTactics());
  else if (hash === '#/market') run(screenMarket());
  else if (hash === '#/scouting') run(screenScouting());
  else if (hash === '#/training') run(screenTraining());
  else if (hash === '#/academy') run(screenAcademy());
  else if (hash.startsWith('#/teamtalk/')) { const id = idArg(hash.split('/')[2] ?? ''); if (id == null) return notFound(); run(screenTeamTalk(id)); }
  else if (hash === '#/news') run(screenNews());
  else if (hash === '#/inbox') run(screenInbox());
  else if (hash === '#/leaders') run(screenLeaders());
  else if (hash === '#/squad') run(screenSquad());
  else if (hash === '#/staff') run(screenStaff());
  else if (hash === '#/finances') run(screenFinances());
  else if (hash === '#/cup') run(screenCup());
  else if (hash === '#/history') run(screenHistory());
  else if (hash === '#/career') run(screenCareer());
  else if (hash.startsWith('#/report/')) { const id = idArg(hash.split('/')[2] ?? ''); if (id == null) return notFound(); run(screenReport(id, /[?&]cup=1\b/.test(hash))); }
  else if (hash.startsWith('#/scout/')) { const id = idArg(hash.split('/')[2] ?? ''); if (id == null) return notFound(); run(screenScout(id)); }
  else if (hash.startsWith('#/player/')) { const slot = idArg(hash.split('/')[2] ?? ''); if (slot == null) return notFound(); run(screenPlayer(slot)); }
  else run(screenDashboard());
}
// Last-resort net: log any unhandled rejection the router boundary didn't wrap (kept console-only to avoid
// toasting the app's intentional fire-and-forget `void promise` paths). The boundary above is the user-facing net.
window.addEventListener('unhandledrejection', (e) => { console.error('[unhandled]', e.reason); });

// a11y: a "skip to content" link as the first focusable element lets keyboard users jump past the header nav.
// It focuses the #main-content landmark directly (NOT via an href hash, which would clobber the SPA route).
const skipLink = h('a', { href: '#main-content', class: 'skip-link' }, 'Skip to content');
skipLink.addEventListener('click', (e: Event) => { e.preventDefault(); document.getElementById('main-content')?.focus(); });
document.body.insertBefore(skipLink, document.body.firstChild);
setupBottomNav();   // the persistent mobile bottom nav (hidden on desktop via CSS; syncNav toggles per-route)

window.addEventListener('hashchange', route);
// Session expired (any api call got a 401): drop the stale user and fall back to the login screen instead of
// leaving a raw "not logged in" under a live URL. teardownWatch() stops any running watch first.
window.addEventListener('footy:auth-expired', () => { if (!getUser()) return; setUser(null); setTacticsPlanFlash(null); teardownWatch(); route(); });

// ── stale-tab guard ── the SPA ships as one content-hashed bundle with no HMR for the watch screen, so an
// open tab keeps running the OLD code after a deploy — which is exactly why the user saw "still choppy" on a
// tab opened before the P0 renderer rewrite. Poll the served index.html for a changed asset hash and offer a
// one-click reload. No-ops in dev (vite serves modules directly, no hashed index-*.js) — only the built :4000.
// boot() re-enters itself (the offline screen's Retry calls boot() again) and this runs in its tail, so make
// the init idempotent: the 90s poll + visibilitychange listener it installs are never removed. Measured
// 2026-08 with the /api/me request aborted then retried: exactly ONE install per page load, because the
// offline branch returns before the tail — so this latch is a guard on the invariant, not a fix for an
// observed double-install. Keep it if the boot flow ever grows another path into this tail.
let versionWatchStarted = false;
function watchForNewVersion(): void {
  if (versionWatchStarted) return;
  const mine = [...document.querySelectorAll('script[src]')].map(s => s.getAttribute('src') || '').find(s => /assets\/index-[\w-]+\.js/.test(s));
  if (!mine) return;
  versionWatchStarted = true;
  let bannerShown = false;
  const check = async (): Promise<void> => {
    if (bannerShown) return;
    try {
      const html = await (await fetch('/?_v=' + Date.now(), { cache: 'no-store' })).text();
      const m = html.match(/assets\/index-[\w-]+\.js/);
      if (m && !mine.includes(m[0])) {
        bannerShown = true;
        document.body.appendChild(h('div', {
          ...clickable(() => location.reload()), title: 'Reload to get the latest version',
          style: 'position:fixed;top:0;left:0;right:0;z-index:99999;background:var(--accent,#1b9af7);color:#fff;font:600 13px/1.5 system-ui,monospace;padding:9px 14px;text-align:center;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3)',
        }, '↻ A new version of the match viewer is available — click to reload'));
      }
    } catch { /* offline / transient — retry next tick */ }
  };
  setInterval(() => void check(), 90000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void check(); });
}

setRerender(route);   // screens call shell.rerender() instead of importing the router (see ui/shell.ts)
mount(h('div', { class: 'center' }, h('div', { class: 'spin' }, 'Loading Footy Manager…')));
(async function boot() {
  try {
    const me = await api.me();
    setUser(me.user);
    void loadNations();   // fire-and-forget; screens re-render on navigation so flags fill in
    // A manager without a club may still browse shared worlds and claim one. The old tactics exception was a
    // typo: it forced a direct #/worlds visit back to club creation, then left that link on an unchanged hash.
    if (getUser() && me.teamId == null && location.hash !== '#/worlds') { screenCreateTeam(); return; }
  } catch (e) {
    // A NETWORK failure (server down / offline) is NOT the same as being logged out — don't dump the user on
    // the login screen. Show a recoverable offline state; a real not-logged-in /me RESOLVES (user:null) rather
    // than throwing, so it still falls through to route() → Auth as before.
    if (isOffline(e)) {
      mount(h('div', { class: 'center' }, offlineState(() => { mount(h('div', { class: 'center' }, h('div', { class: 'spin' }, 'Reconnecting…'))); void boot(); })));
      syncNav();   // no user → hide the bottom bar on the offline screen (boot bypasses route())
      return;
    }
  }
  route();
  watchForNewVersion();
  registerServiceWorker();
})();

// PWA: register the shell service worker so the app is installable ("Add to Home Screen" →
// standalone, own icon) and launches offline-tolerant. Only in secure contexts (https or
// localhost); a failed registration is non-fatal — the app runs fine without it.
function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  // Register directly — NOT gated on the `load` event: boot() awaits a network call first, so by
  // the time we get here `load` has usually already fired and a load-listener would never run.
  navigator.serviceWorker.register('/sw.js').catch(() => { /* SW unavailable — no-op */ });
}
