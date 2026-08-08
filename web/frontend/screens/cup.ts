// ── cup ── extracted from app.ts (Round: appts-audit, pass 3): the knockout bracket.

import { api, type CupT } from '../api.ts';
import { h } from '../ui/dom.ts';
import { mount, screenGuard } from '../ui/shell.ts';
import { header } from '../ui/nav.ts';
import { screenCreateTeam } from './create-team.ts';

// ── cup (knockout bracket) ──
export async function screenCup() {
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
