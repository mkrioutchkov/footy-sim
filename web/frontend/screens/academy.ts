// ── youth academy ── extracted from app.ts (Round: appts-audit, pass 3). The route() re-dispatch after a
// promotion is now shell.rerender() — same dispatch, no router import.

import { api, type AcademyProspectT } from '../api.ts';
import { h } from '../ui/dom.ts';
import { attrTokens } from '../ui/format.ts';
import { mount, toast, screenGuard, rerender } from '../ui/shell.ts';
import { scrollRegion, responsiveTable } from '../ui/states.ts';
import { header } from '../ui/nav.ts';
import { screenCreateTeam } from './create-team.ts';

// ── youth academy (§2.9): the club's developing prospects + promote-to-squad ──
export async function screenAcademy() {
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
      try { const r = await api.promoteProspect(p.id); if (!alive()) return; toast(`${r.player} promoted to the senior squad`); rerender(); }
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
