// ── news archive ── extracted from app.ts (Round: appts-audit, pass 3).

import { api, type NewsItemT } from '../api.ts';
import { h } from '../ui/dom.ts';
import { mount, screenGuard } from '../ui/shell.ts';
import { header } from '../ui/nav.ts';
import { screenCreateTeam } from './create-team.ts';

// ── news archive (§2.14): the full club-news feed, grouped by season ──
export async function screenNews() {
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
