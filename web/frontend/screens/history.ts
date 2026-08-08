// ── club history + manager career ── extracted from app.ts (Round: appts-audit, pass 3). The two archive
// screens share the `trophy` tile, so they stay in one module rather than exporting a helper across two.

import { api, type SeasonHistoryT, type ManagerCareerT } from '../api.ts';
import { h } from '../ui/dom.ts';
import { ordinal } from '../ui/format.ts';
import { mount, screenGuard } from '../ui/shell.ts';
import { subcard } from '../ui/states.ts';
import { header } from '../ui/nav.ts';
import { screenCreateTeam } from './create-team.ts';

// ── club history / honours archive ──
const OBJ_LABEL: Record<string, string> = {
  title: 'Win the league', promotion: 'Win promotion', top_half: 'Finish in the top half', survival: 'Avoid relegation',
};
const BOARD_TONE_LABEL: Record<string, string> = {
  backed: 'Backed', satisfied: 'Satisfied', concerned: 'Concerned', warned: 'Warned', final_warning: 'Final warning',
};
const BOARD_TONE_ICON: Record<string, string> = {
  backed: '🟢', satisfied: '🙂', concerned: '🟡', warned: '🟠', final_warning: '🔴',
};
const BOARD_TONE_STYLE: Record<string, string> = {
  warned: 'background:#3a2a1f;color:#ffce9a', final_warning: 'background:#3a1f24;color:#ff9a9a',
};
function trophy(icon: string, n: number, label: string): HTMLElement {
  return h('div', { style: 'text-align:center;min-width:74px' },
    h('div', { style: 'font-size:26px' }, icon),
    h('div', { style: 'font-size:22px;font-weight:800' }, String(n)),
    h('div', { class: 'muted', style: 'font-size:11px' }, label));
}
// ── manager career: the manager's CV aggregated across every club managed ──
export async function screenCareer() {
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading your career…')));
  let c: ManagerCareerT;
  try { c = await api.career(); }
  catch (e: any) {
    if (!alive()) return;
    if (String(e.message).includes('no team')) return screenCreateTeam();
    return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message)));
  }
  const stat = (label: string, val: string | number, sub?: string) => h('div', { class: 'card', style: 'padding:12px 16px;min-width:118px' },
    h('div', { style: 'font-size:24px;font-weight:700' }, String(val)),
    h('div', { class: 'muted', style: 'font-size:12px' }, label),
    sub ? h('div', { class: 'muted', style: 'font-size:11px;margin-top:2px' }, sub) : '');
  const body = c.seasons === 0
    ? h('div', { class: 'card' }, h('div', { class: 'muted' }, 'No completed seasons yet — play through a season and your managerial record will build here.'))
    : h('div', {},
        h('div', { class: 'row', style: 'gap:12px;flex-wrap:wrap;margin-bottom:14px' },
          stat('Seasons', c.seasons, c.clubs > 1 ? `${c.clubs} clubs` : undefined),
          stat('Record', `${c.won}-${c.drawn}-${c.lost}`, `${c.played} games`),
          stat('Win rate', `${c.winPct}%`),
          stat('Points', c.points),
          // GF/GA were returned by /api/career but never shown — a manager's goals-for/against + difference.
          stat('Goals', `${c.gf}-${c.ga}`, `${c.gf - c.ga >= 0 ? '+' : ''}${c.gf - c.ga} GD`)),
        h('div', { class: 'card', style: 'margin-bottom:14px' },
          h('div', { class: 'section-title', style: 'margin-top:0' }, 'Honours'),
          h('div', { class: 'row', style: 'gap:18px;flex-wrap:wrap' },
            trophy('🏆', c.titles, c.titles === 1 ? 'League title' : 'League titles'),
            trophy('🥇', c.cups, c.cups === 1 ? 'Cup' : 'Cups'),
            trophy('⬆️', c.promotions, 'Promotions'),
            trophy('⬇️', c.relegations, 'Relegations')),
          c.objectivesSet ? h('div', { class: 'muted', style: 'font-size:12px;margin-top:8px' },
            `Board objectives met: ${c.objectivesMet}/${c.objectivesSet}${c.bestFinish ? ` · Best finish: ${ordinal(c.bestFinish.position)} (${c.bestFinish.division}, S${c.bestFinish.season})` : ''}`) : ''),
        h('div', { class: 'card' },
          h('div', { class: 'section-title', style: 'margin-top:0' }, 'Clubs managed'),
          ...c.spells.map(s => h('div', { class: 'between', style: 'font-size:13px;padding:5px 0;border-top:1px solid var(--line)' },
            h('span', {}, h('b', {}, s.team), ' ', h('span', { class: 'muted', style: 'font-size:12px' }, `${s.from === s.to ? `S${s.from}` : `S${s.from}–S${s.to}`} · ${s.seasons} season${s.seasons === 1 ? '' : 's'}`)),
            h('span', { class: 'muted', style: 'font-size:12px' }, [s.titles ? `${s.titles}🏆` : '', s.promotions ? `${s.promotions}⬆️` : '', s.relegations ? `${s.relegations}⬇️` : ''].filter(Boolean).join('  ') || '—')))));
  // §P2#9 reputation badge — the synthesised media standing from the career CV (tier + blurb).
  const rep = c.reputation;
  const repBadge = rep ? (() => {
    const COLOR: Record<string, string> = { unproven: 'var(--muted,#8a93a6)', promising: '#7fb2ff', respected: 'var(--accent)', renowned: 'var(--gold)', elite: 'var(--gold)', legendary: '#ffd24a' };
    const col = COLOR[rep.tier] ?? 'var(--accent)';
    const icon = rep.tier === 'legendary' ? '👑' : rep.tier === 'elite' ? '⭐' : '★';
    return h('span', { class: 'pill', title: rep.blurb, style: `border:1px solid ${col};color:${col};font-weight:700;font-size:12px` }, `${icon} ${rep.label}`);
  })() : '';
  if (!alive()) return;
  mount(header(), h('div', { class: 'wrap grid' },
    h('div', { class: 'between' },
      h('div', { class: 'row', style: 'gap:10px;align-items:center' }, h('h2', { style: 'margin:0' }, 'Managerial career'), repBadge),
      h('button', { class: 'ghost small', onclick: () => (location.hash = '#/') }, '← Back')),
    rep ? h('div', { class: 'muted', style: 'font-size:12px;margin-top:-4px;font-style:italic' }, rep.blurb) : '',
    body));
}

export async function screenHistory() {
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading history…')));
  let hist: SeasonHistoryT[]; let records: import('../api').ClubRecordsT | null = null;
  try { const r = await api.history(); hist = r.history; records = r.records; }
  catch (e: any) {
    if (!alive()) return;
    if (String(e.message).includes('no team')) return screenCreateTeam();
    return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message)));
  }

  const titles = hist.filter(s => s.champion).length;
  const cups = hist.filter(s => s.cupWon).length;
  const promotions = hist.filter(s => s.promoted).length;
  const cabinet = h('div', { class: 'row', style: 'gap:18px;flex-wrap:wrap' },
    trophy('🏆', titles, titles === 1 ? 'League title' : 'League titles'),
    trophy('🥇', cups, cups === 1 ? 'Cup' : 'Cups'),
    trophy('⬆️', promotions, promotions === 1 ? 'Promotion' : 'Promotions'),
    trophy('📅', hist.length, hist.length === 1 ? 'Season' : 'Seasons'));

  const body = h('tbody');
  if (!hist.length) body.append(h('tr', {}, h('td', { colspan: '7', class: 'muted' }, 'No completed seasons yet — play through a season and your history starts here.')));
  for (const s of hist) {
    const honours = h('span', { style: 'display:inline-flex;gap:5px;flex-wrap:wrap;align-items:center' });
    if (s.champion) honours.append(h('span', { class: 'pill', title: 'Division champions', style: 'background:var(--gold);color:#1a1205' }, '🏆 Champions'));
    if (s.promoted) honours.append(h('span', { class: 'pill', title: 'Promoted' }, '⬆️ Promoted'));
    if (s.relegated) honours.append(h('span', { class: 'pill', title: 'Relegated', style: 'background:#3a1f24;color:#ff9a9a' }, '⬇️ Relegated'));
    if (s.cupWon) honours.append(h('span', { class: 'pill', title: 'Cup winners', style: 'background:var(--gold);color:#1a1205' }, '🥇 Cup'));
    if (s.objective) honours.append(h('span', { class: 'pill', title: `Board objective: ${OBJ_LABEL[s.objective.kind] ?? 'season target'}`, style: s.objective.met ? '' : 'background:#3a1f24;color:#ff9a9a' }, (s.objective.met ? '✅' : '❌') + ' Target'));
    if (s.board) honours.append(h('span', { class: 'pill', title: s.board.message, style: BOARD_TONE_STYLE[s.board.tone] ?? '' }, `${BOARD_TONE_ICON[s.board.tone] ?? '📋'} ${BOARD_TONE_LABEL[s.board.tone] ?? 'Board'}`));
    if (s.pots) honours.append(h('span', { class: 'muted', style: 'font-size:11px' }, `POTS: ${s.pots}`));
    body.append(h('tr', {},
      h('td', { class: 'num' }, String(s.season)),
      h('td', {}, `T${s.tier} · ${s.division}`),
      h('td', { class: 'num', style: s.position === 1 ? 'font-weight:700;color:var(--gold)' : '' }, ordinal(s.position)),
      h('td', { class: 'num' }, `${s.won}-${s.drawn}-${s.lost}`),
      h('td', { class: 'num' }, `${s.gf}:${s.ga}`),
      h('td', { class: 'num', style: 'font-weight:700' }, String(s.points)),
      h('td', {}, honours)));
  }

  if (!alive()) return;
  mount(header(), h('div', { class: 'wrap grid' },
    h('div', { class: 'between' },
      h('div', {}, h('h2', {}, 'Club history'),
        h('div', { class: 'muted' }, 'Every completed season and the honours that came with it.')),
      h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, '← Back')),
    subcard('Trophy cabinet', cabinet),
    records && records.seasons > 0 ? h('div', { class: 'card' },
      h('div', { class: 'section-title', style: 'margin-top:0' }, 'All-time records'),
      h('div', { class: 'row', style: 'gap:26px;flex-wrap:wrap;font-size:13px' },
        ...[
          records.bestFinish ? ['Best finish', `${ordinal(records.bestFinish.position)} · Tier ${records.bestFinish.tier} (S${records.bestFinish.season})`] : null,
          records.mostPoints ? ['Most points', `${records.mostPoints.points} (S${records.mostPoints.season})`] : null,
          records.mostGoals ? ['Most goals', `${records.mostGoals.gf} (S${records.mostGoals.season})`] : null,
          ['Relegations', String(records.relegations)],
        ].filter((x): x is [string, string] => x != null).map(([lab, val]) => h('div', {},
          h('div', { class: 'muted', style: 'font-size:11px' }, lab),
          h('div', { style: 'font-weight:700' }, val))))) : '',
    h('div', { class: 'card' },
      h('div', { class: 'section-title', style: 'margin-top:0' }, 'Season by season'),
      h('div', { style: 'max-height:560px;overflow:auto' }, h('table', {},
        h('thead', {}, h('tr', {},
          h('th', { class: 'num' }, 'Season'), h('th', {}, 'Division'), h('th', { class: 'num' }, 'Pos'),
          h('th', { class: 'num' }, 'W-D-L'), h('th', { class: 'num' }, 'GF:GA'), h('th', { class: 'num' }, 'Pts'), h('th', {}, 'Honours'))),
        body))),
  ));
}
