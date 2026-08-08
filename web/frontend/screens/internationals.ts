// ── internationals ── extracted from app.ts (Round: appts-audit, pass 3): the tournament brackets plus the
// nations that can field a squad. The selected nation is the screen's own module state — nothing else reads
// it, so it travels with the screen.

import { api } from '../api.ts';
import { h, clickable } from '../ui/dom.ts';
import { mount, screenGuard } from '../ui/shell.ts';
import { header } from '../ui/nav.ts';
import { flagOf, nationNameOf, loadNations, nationsLoaded } from '../ui/nations.ts';
import { screenCreateTeam } from './create-team.ts';

// Module-level so a filter/selection survives navigating away and back (mirrors the squadView pattern).
let intlNation: string | null = null;

// §national-teams: international tournaments (World Cup + continental) + the nations that can field a
// squad in this world. Tournaments run in the off-season (at rollover); results show here.
export async function screenInternationals() {
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading internationals…')));
  if (!nationsLoaded()) await loadNations();
  let data: Awaited<ReturnType<typeof api.tournaments>>;
  try { data = await api.tournaments(); }
  catch (e: any) { if (!alive()) return; if (String(e.message).includes('no team')) return screenCreateTeam(); return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message))); }
  // Nations render with a flag; clubs (Club World Cup) have no flag key, so show the name as-is.
  const nat = (k: string | null) => { if (!k) return 'TBD'; const f = flagOf(k); return `${f ? f + ' ' : ''}${nationNameOf(k) || k}`; };

  // bracket for one tournament: rounds as columns (like the cup), winners bold, pens shown
  const bracket = (t: import('../api').TournamentT) => {
    const totalRounds = t.ties.reduce((m, x) => Math.max(m, x.round), 0);
    const roundName = (r: number) => { const d = totalRounds - r; return d === 0 ? 'Final' : d === 1 ? 'Semi-finals' : d === 2 ? 'Quarter-finals' : `Round of ${2 ** (d + 1)}`; };
    const byRound = new Map<number, import('../api').TournamentTieT[]>();
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
