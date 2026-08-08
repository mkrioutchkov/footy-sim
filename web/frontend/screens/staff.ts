// ── backroom staff ── extracted from app.ts (Round: appts-audit, pass 3): hire/release plus the coaching
// focus board and the serialized save chain it needs.

import { api, type StaffViewT } from '../api.ts';
import { h } from '../ui/dom.ts';
import { fmtMoney } from '../ui/format.ts';
import { mount, toast, screenGuard } from '../ui/shell.ts';
import { errMessage, scrollRegion, responsiveTable } from '../ui/states.ts';
import { confirmModal } from '../ui/modal.ts';
import { header } from '../ui/nav.ts';
import { screenCreateTeam } from './create-team.ts';

// ── backroom staff ──
const ROLE_ICON: Record<string, string> = { coach: '🎓', physio: '🩺', scout: '🔍' };
const ROLE_LABEL: Record<string, string> = { coach: 'Coach', physio: 'Physio', scout: 'Scout' };
export async function screenStaff() {
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
