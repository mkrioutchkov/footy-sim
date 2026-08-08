// ── scouting centre ── extracted from app.ts (Round: appts-audit, pass 3): the world-wide player search.
// Distinct from the pre-match opponent dossier in scout.ts (#/scout/:fixtureId).

import { api } from '../api.ts';
import { h } from '../ui/dom.ts';
import { fmtMoney, parseMoneyInput, SQUAD_ATTRS } from '../ui/format.ts';
import { mount, toast, screenGuard } from '../ui/shell.ts';
import { header } from '../ui/nav.ts';
import { screenCreateTeam } from './create-team.ts';

// ── scouting centre (world-wide player search) ──
// Hunt targets across every club in the world by role/age/overall/value/name. Attributes come back
// FOGGED to the club's scout depth (reusing the opponent-report fog), so a better scouting network
// reads a sharper picture. ★ to shortlist; buyable (listed / release-clause) players link to the Market
// where the negotiation flow lives. Engine-free — a query over existing player data.
const SCOUT_ROLES = ['GK', 'FB', 'CB', 'CM', 'WM', 'CF'];
export async function screenScouting() {
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading…')));
  let players: import('../api').ScoutedPlayerT[] = [];
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

  const toggleStar = async (p: import('../api').ScoutedPlayerT) => {
    const add = !p.shortlisted;
    try { await api.toggleShortlist(p.id, add); p.shortlisted = add; toast(add ? '★ Added to your shortlist' : 'Removed from shortlist'); renderResults(); }
    catch (e: any) { toast(e.message); }
  };

  const resultsHost = h('div', {});
  const fogCell = (p: import('../api').ScoutedPlayerT) => {
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
