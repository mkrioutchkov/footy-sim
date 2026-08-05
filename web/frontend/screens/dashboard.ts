// ── dashboard ── extracted from app.ts (Round: appts-audit). The landing screen and the two panels only it
// renders: the other-divisions tables and the formation card. Its module state (the matchday digest and the
// shared-world refresh cooldown) is read by nothing else, so it travels with the screen.
import { api, type LeagueT, type TeamT, type FormationsT, type HarmonyT, type ConcernT, type BoardMeetingT, type NewsItemT } from '../api.ts';
import { h, clickable } from '../ui/dom.ts';
import { attrTokens, fmtMoney, ordinal, seekingMove, skillOvr } from '../ui/format.ts';
import { getUser, mount, rerender, screenGuard, toast } from '../ui/shell.ts';
import { scrollRegion, subcard } from '../ui/states.ts';
import { confirmModal } from '../ui/modal.ts';
import { header, NAV, navItem } from '../ui/nav.ts';
import { pitchSvg } from '../ui/pitch.ts';
import { screenCreateTeam } from './create-team.ts';

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

// Formation control: a plain-text shout ("play 4-4-2", "AB at left back") sets the
// team's shape + XI for every match it plays. Shows the resolved XI + any note.
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

// §board-confidence: how the board reads the season so far (shown on the dashboard board card).
const CONF_LABEL: Record<string, string> = {
  secure: 'Secure', stable: 'Stable', shaky: 'Under pressure', at_risk: 'At risk',
};

// ── dashboard ──
// The advance-matchday digest: everything the last Advance produced, shown as ONE persistent card at the
// top of the dashboard until dismissed (replaces the old ~15-toast pile that vanished in 2.6s each).
type DigestItem = { category?: string; icon: string; text: string; hash?: string | null };
let matchdayDigest: { round: number | null; headline: string; items: DigestItem[] } | null = null;
let lastWorldTurnRefreshAt = 0;
// Retires the previous render's next-turn countdown (interval + visibilitychange listener). The chip is a
// singleton on screen, so a re-render must dispose the old one rather than let it self-expire on a later tick.
let turnChipCleanup: (() => void) | null = null;
export async function screenDashboard() {
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading…')));
  let team: TeamT, league: LeagueT, news: NewsItemT[] = [], harmony: HarmonyT | null = null, reg: FormationsT | null = null, concerns: ConcernT[] = [];
  try {
    const [t, l, n, hm, fr, cn] = await Promise.all([api.team(), api.league(), api.news().catch(() => ({ news: [] })), api.harmony().catch(() => null), api.formations().catch(() => null), api.concerns().catch(() => ({ concerns: [] }))]);
    team = t; league = l; news = n.news; harmony = hm; reg = fr; concerns = cn.concerns;
  } catch (e: any) {
    // team()/league() are essential — one transient failure shouldn't strand the home screen on a
    // bare error string with no way out. Offer a retry (news/harmony already fall back above).
    if (!alive()) return;
    if (String(e.message).includes('no team')) return screenCreateTeam();
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
    const ovr = skillOvr(p.attrs, p.role);
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
    try { await api.generatePersonalities(); if (!alive()) return; toast('Personalities generated'); rerender(); }
    catch (e: any) { if (!alive()) return; toast(e.message); genPersBtn.removeAttribute('disabled'); genPersBtn.textContent = 'Generate personalities'; }
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
  const canAdvanceHere = worldTurn ? worldTurn.canAdvance : !!getUser()?.isAdmin;
  const adminTag = (getUser()?.isAdmin && isShared) ? ' (admin)' : '';   // only tag the tester-forced case
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
      if (!alive()) return;
      // ── matchday DIGEST: everything the matchday produced, in ONE persistent, dismissable card on the
      // dashboard (was ~15 stacked 2.6-second toasts). The items + headline are now assembled server-side
      // (inbox.ts) and PERSISTED to the Inbox — the card renders the same array, so there's one formatting
      // source and no drift between the live digest and the archived feed.
      matchdayDigest = (r.digestHeadline || r.inbox.length) ? { round: pendingRound, headline: r.digestHeadline, items: r.inbox } : null;
      if (!matchdayDigest) toast('Matchday advanced.');
      rerender();
    } catch (e: any) { if (!alive()) return; toast(e.message); rerender(); }
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
      h('button', { class: 'ghost small', 'aria-label': 'Dismiss the matchday digest', onclick: () => { matchdayDigest = null; rerender(); } }, '✕')),
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
          let countdownTimer = 0, expiryTimer = 0, refreshQueued = false;
          const onVisibility = () => { if (!document.hidden) tick(); };
          const cleanup = () => {
            clearInterval(countdownTimer); clearTimeout(expiryTimer);
            document.removeEventListener('visibilitychange', onVisibility);
          };
          const queueRefresh = () => {
            if (refreshQueued || worldTurn.nextTurnAt == null || worldTurn.nextTurnAt > Date.now()) return;
            refreshQueued = true;
            // Give the scheduler a moment, then refetch the whole dashboard. If it has not advanced yet,
            // the module-level cooldown prevents an expired timestamp from creating a tight reload loop.
            const delay = Math.max(5000, 60000 - (Date.now() - lastWorldTurnRefreshAt));
            expiryTimer = window.setTimeout(() => {
              cleanup();
              if (!alive() || !chip.isConnected) return;
              lastWorldTurnRefreshAt = Date.now();
              rerender();
            }, delay);
          };
          const paintCountdown = () => {
            if (worldTurn.nextTurnAt == null) chip.textContent = `⏱ Turn ${worldTurn.turn} · scheduled`;
            else {
              const ms = worldTurn.nextTurnAt - Date.now();
              if (ms <= 0) { chip.textContent = `⏱ Turn ${worldTurn.turn} · refreshing…`; queueRefresh(); }
              else { const hh = Math.floor(ms / 3600000), mm = Math.floor((ms % 3600000) / 60000); chip.textContent = `⏱ Next turn in ${hh > 0 ? hh + 'h ' : ''}${mm}m`; }
            }
          };
          const tick = () => {
            if (!alive() || !chip.isConnected) { cleanup(); return; }
            paintCountdown();
          };
          paintCountdown();
          // Only ONE countdown chip can be on screen at a time, so retire the previous render's interval +
          // visibilitychange listener HERE rather than leaving it to whichever timer happens to run first.
          // Measured (2026-08, 9 dashboard renders in a shared world, chromium): the pre-existing paths do
          // reclaim the stale pairs — 9 intervals installed, 1 still running at the end, both before and
          // after this line — so this is determinism, not a leak fix. It removes the dependency on a tick
          // (≤30s) or the queueRefresh expiry (≥5s) firing before the next render.
          turnChipCleanup?.();
          turnChipCleanup = cleanup;
          countdownTimer = window.setInterval(tick, 30000);
          document.addEventListener('visibilitychange', onVisibility);
          return chip;
        })()
      : '');

  // §autonomous: shared-world membership controls — an autonomy toggle (assistant sets only tactics+XI vs
  // full also spends in the market while you're away) and a leave-world action. Only meaningful in a shared
  // world; solo worlds have neither an assistant tier nor a "leave" (you own the world). Both endpoints existed
  // but had no UI — the worlds screen even told users to "leave from your dashboard" with nothing to click.
  const sharedWorldCard: HTMLElement | string = isShared && worldTurn ? (() => {
    let autonomy: 'assistant' | 'full' = worldTurn.autonomy ?? 'assistant';
    const autoBtn = h('button', { class: 'ghost small' }) as HTMLButtonElement;
    const paintAuto = () => { autoBtn.textContent = autonomy === 'full' ? '🤖 Full autonomy' : '🧭 Assistant only'; autoBtn.setAttribute('aria-pressed', String(autonomy === 'full')); };
    paintAuto();
    autoBtn.addEventListener('click', async () => {
      const next = autonomy === 'full' ? 'assistant' : 'full';
      autoBtn.setAttribute('disabled', 'true');
      try { await api.setAutonomy(next); autonomy = next; paintAuto(); toast(next === 'full' ? '🤖 Full autonomy — the assistant will also make transfers while you’re away' : '🧭 Assistant only — tactics & XI while you’re away, never spends'); }
      catch (e: any) { toast(e.message); }
      finally { autoBtn.removeAttribute('disabled'); }
    });
    const leaveBtn = h('button', { class: 'ghost small danger' }, 'Leave world') as HTMLButtonElement;
    leaveBtn.addEventListener('click', async () => {
      if (!await confirmModal('Leave this world?', `${team.name} will be released back to AI control and you’ll return to the world lobby. This can’t be undone.`, 'Leave world', 'danger')) return;
      leaveBtn.setAttribute('disabled', 'true');
      try { await api.leaveWorld(); toast('You’ve left the world.'); location.hash = '#/worlds'; }
      catch (e: any) { toast(e.message); leaveBtn.removeAttribute('disabled'); }
    });
    return h('div', { class: 'card', style: 'padding:12px 16px' },
      h('div', { class: 'between', style: 'gap:12px;flex-wrap:wrap' },
        h('div', { class: 'row', style: 'gap:8px;align-items:baseline' },
          h('span', { class: 'section-title', style: 'margin:0' }, '🌍 Shared world'),
          h('span', { class: 'muted', style: 'font-size:12px' }, 'While you’re away, your assistant runs the club:')),
        h('div', { class: 'row', style: 'gap:8px' }, autoBtn, leaveBtn)));
  })() : '';

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
    sharedWorldCard,
    digestCard,
    nextMatchCard,
    h('div', { class: 'card', style: 'padding:14px' },
      h('div', { class: 'nav-grid' },
        ...NAV.filter(e => e.hash !== '#/').map(e => navItem(e.icon, e.label, e.hash)))),
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
    h('div', { class: 'card' }, h('div', { class: 'section-title', style: 'margin-top:0' }, league.divisionName ?? 'League table'), scrollRegion('League table', table),
      (hasPromotion || hasRelegation) ? h('div', { class: 'muted', style: 'font-size:11px;margin-top:8px;display:flex;gap:16px' },
        hasPromotion ? h('span', {}, ZONE_DOT('promo'), 'Promotion') : '',
        hasRelegation ? h('span', {}, ZONE_DOT('releg'), 'Relegation') : '') : ''),
    otherDivisions(league),
    h('div', { class: 'grid cols-split', style: 'align-items:start' },
      subcard('Your fixtures', fxBox),
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
