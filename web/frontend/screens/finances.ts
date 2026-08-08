// ── club finances ── extracted from app.ts (Round: appts-audit, pass 3).

import { api, type FinancesT } from '../api.ts';
import { h } from '../ui/dom.ts';
import { fmtMoney } from '../ui/format.ts';
import { mount, screenGuard } from '../ui/shell.ts';
import { pageHead } from '../ui/states.ts';
import { header } from '../ui/nav.ts';
import { screenCreateTeam } from './create-team.ts';

// ── club finances ──
const FIN_LABEL: Record<string, string> = {
  prize: 'Prize money', transfer_in: 'Transfers in', transfer_out: 'Transfers out',
  staff: 'Staff fees', wages: 'Player wages', sponsor: 'Sponsorship', gate: 'Gate & TV', other: 'Other',
};
export async function screenFinances() {
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
