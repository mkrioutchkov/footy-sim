// ── inbox ── extracted from app.ts (Round: appts-audit, pass 3): the persistent matchday feed. The chosen
// category filter is the screen's own module state — nothing else reads it, so it travels with the screen.

import { api } from '../api.ts';
import { h, clickable } from '../ui/dom.ts';
import { mount, toast, screenGuard } from '../ui/shell.ts';
import { header } from '../ui/nav.ts';
import { screenCreateTeam } from './create-team.ts';

// Module-level so a filter/selection survives navigating away and back (mirrors the squadView pattern).
let inboxFilter = 'all';

// ── inbox (§inbox): the persistent matchday feed — every result, transfer, injury, contract, cup and
// board message, archived across seasons with a category filter + unread state. Written server-side at
// advance; the dashboard digest card is the same items for the latest matchday only. ──
const INBOX_CAT_LABEL: Record<string, string> = {
  result: 'Results', finance: 'Finance', development: 'Training', injury: 'Injuries', transfer: 'Transfers',
  bid: 'Bids', contract: 'Contracts', cup: 'Cup', season: 'Season', youth: 'Academy', award: 'Awards', board: 'Board',
};
export async function screenInbox() {
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
