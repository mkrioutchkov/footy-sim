// ── league stat leaders ── extracted from app.ts (Round: appts-audit, pass 3).

import { api, type LeadersT } from '../api.ts';
import { h } from '../ui/dom.ts';
import { mount, screenGuard } from '../ui/shell.ts';
import { pageHead } from '../ui/states.ts';
import { header } from '../ui/nav.ts';
import { screenCreateTeam } from './create-team.ts';

// ── league stat leaders (§stat-leaders): the division's top scorers + assisters this season ──
export async function screenLeaders() {
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
