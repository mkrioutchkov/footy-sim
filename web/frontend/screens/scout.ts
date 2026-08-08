// ── pre-match opponent scouting report ── extracted from app.ts (Round: appts-audit, pass 3): the dossier
// for one fixture (#/scout/:fixtureId). The world-wide player search is scouting.ts (#/scouting).

import { api, type ScoutT, type ScoutPlayerT } from '../api.ts';
import { h } from '../ui/dom.ts';
import { ordinal } from '../ui/format.ts';
import { mount, toast, screenGuard, goBack } from '../ui/shell.ts';
import { confirmModal } from '../ui/modal.ts';
import { header } from '../ui/nav.ts';
import { screenCreateTeam } from './create-team.ts';

// ── pre-match opponent scouting report ──
export async function screenScout(fixtureId: number) {
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Scouting the opposition…')));
  let s: ScoutT;
  try { s = await api.scout(fixtureId); }
  catch (e: any) {
    if (!alive()) return;
    if (String(e.message).includes('no team')) return screenCreateTeam();
    return mount(header(), h('div', { class: 'wrap' },
      h('div', { class: 'err' }, e.message),
      h('button', { class: 'ghost', style: 'margin-top:12px', onclick: () => (location.hash = '#/') }, '← Back')));
  }
  const o = s.opponent;

  const formRow = h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' });
  if (!s.form.length) formRow.append(h('span', { class: 'muted', style: 'font-size:13px' }, 'No games played yet this season.'));
  else for (const f of s.form) formRow.append(h('span', {
    class: 'form-badge ' + (f.result === 'W' ? 'w' : f.result === 'L' ? 'l' : 'd'),
    title: `R${f.round} · ${f.venue === 'H' ? 'home' : 'away'} ${f.gf}–${f.ga} vs ${f.opponent}`,
  }, f.result));

  const ATTR_ABBR: Record<string, string> = { speed: 'SPD', passing: 'PAS', creativity: 'CRE', shooting: 'SHO', tackling: 'TAC', positioning: 'POSN', stamina: 'STA' };
  const playerRow = (p: ScoutPlayerT) => h('div', { style: 'padding:4px 0;border-bottom:1px solid var(--line)' },
    h('div', { class: 'between', style: 'font-size:13px' },
      h('span', {}, p.danger ? h('span', { title: 'danger man', style: 'margin-right:5px' }, '⚠️') : '',
        p.name, h('span', { class: 'muted', style: 'font-size:11px' }, ` ${p.role} · ${p.age}y`)),
      h('span', { style: p.danger ? 'font-weight:700;color:var(--gold)' : '' },
        `OVR ${p.overall}${p.potential && p.potential > p.overall ? ` → ${p.potential}` : ''}`)),
    // scouted attribute fog — ranges that tighten with scout quality (exact at full depth)
    p.attrs ? h('div', { class: 'muted', style: 'font-size:11px;margin-top:2px' },
      p.attrs.map(a => `${ATTR_ABBR[a.key] ?? a.key} ${a.lo === a.hi ? a.lo : `${a.lo}–${a.hi}`}`).join(' · ')) : '');
  const players = s.keyPlayers.length ? s.keyPlayers.map(playerRow)
    : [h('div', { class: 'muted', style: 'font-size:13px' }, s.bench.length ? 'No likely XI scouted yet — see the rest of the squad below.' : 'Squad not available.')];
  const scoutHint = s.keyPlayers.length && !s.keyPlayers[0].attrs
    ? h('div', { class: 'muted', style: 'margin:-4px 0 8px;font-size:11px' }, 'Hire scouts (Staff) to reveal their players’ attributes + scout deeper into the squad.')
    : '';
  // Turn the read-only scout into an ACTION: compose an opposition instruction (man-marking the flagged
  // danger men) and append it to the standing plain-English plan. Matches the plan-as-source-of-truth design
  // (the compiler assigns a marker); confirmed first because it recompiles the plan.
  const dangerNames = s.keyPlayers.filter(p => p.danger).map(p => p.name);
  const markBtn = dangerNames.length
    ? h('button', { class: 'ghost small', title: 'Add a man-marking instruction for the danger man to your tactical plan' },
        dangerNames.length > 1 ? '🎯 Man-mark them' : `🎯 Man-mark ${dangerNames[0].split(' ').slice(-1)[0]}`) as HTMLButtonElement
    : '';
  if (markBtn instanceof HTMLButtonElement) {
    markBtn.addEventListener('click', async () => {
      const sentence = dangerNames.length === 1
        ? `keep their danger man ${dangerNames[0]} quiet — man-mark him tightly`
        : `man-mark their danger men (${dangerNames.join(', ')}) tightly`;
      if (!await confirmModal('Add to your standing plan?', `This appends an opposition instruction to your tactical plan and recompiles it:\n\n“${sentence}”`, 'Add to plan')) return;
      markBtn.setAttribute('disabled', 'true'); const label = markBtn.textContent; markBtn.textContent = 'Updating plan…';
      try {
        const team = await api.team();
        const base = (team.planText ?? '').trim().replace(/[.\s]*$/, '');
        const r = await api.teamPlan(base ? `${base}. ${sentence}` : sentence);
        toast(r.error ? 'Saved, but couldn’t compile it — refine on the Tactics screen.' : '✓ Added to your plan');
      } catch (e: any) { toast(e.message); }
      finally { markBtn.removeAttribute('disabled'); markBtn.textContent = label; }
    });
  }
  // §2.8 bench tier — the squad behind the XI, a fuzzier read; only present once you have some intel.
  const benchCard = s.bench.length
    ? h('div', { class: 'card' },
        h('div', { class: 'section-title', style: 'margin-top:0' }, 'Rest of the squad'),
        h('div', { class: 'muted', style: 'margin:-4px 0 8px;font-size:12px' }, 'Bench & squad players — a fuzzier read than the likely XI; it sharpens with better scouts and as the fixture nears.'),
        ...s.bench.map(playerRow))
    : '';

  if (!alive()) return;
  mount(header(), h('div', { class: 'wrap grid' },
    h('div', { class: 'between' },
      h('div', {}, h('h2', {}, `Scouting — ${o.name}`),
        h('div', { class: 'muted' },
          `${o.manager} · ${o.formation} · ${o.position != null ? ordinal(o.position) + ' in the table' : 'unranked'} · you play ${s.venue === 'home' ? 'at home' : 'away'} (R${s.round}) · ${s.roundsAway === 0 ? 'your next match' : `${s.roundsAway} matchday${s.roundsAway > 1 ? 's' : ''} away`}`)),
      h('button', { class: 'ghost', onclick: () => goBack() }, '← Back')),
    h('div', { class: 'grid cols-2', style: 'align-items:start' },
      h('div', { class: 'card' },
        h('div', { class: 'section-title', style: 'margin-top:0' }, 'Form & record'),
        h('div', { class: 'muted', style: 'margin-bottom:10px;font-size:13px' },
          `P${o.played}  ·  W${o.won} D${o.drawn} L${o.lost}  ·  ${o.gf}:${o.ga} (${o.gd >= 0 ? '+' : ''}${o.gd})  ·  ${o.points} pts`),
        formRow,
        h('div', { class: 'section-title' }, 'How they play'),
        h('ul', { style: 'margin:0;padding-left:18px;line-height:1.7' }, ...s.approach.map(a => h('li', {}, a)))),
      h('div', { class: 'grid', style: 'gap:14px;align-items:start' },
        h('div', { class: 'card' },
          h('div', { class: 'between', style: 'align-items:center' },
            h('div', { class: 'section-title', style: 'margin-top:0' }, 'Danger men'),
            markBtn),
          h('div', { class: 'muted', style: 'margin:-4px 0 8px;font-size:12px' }, 'Their highest-rated players in the likely XI.'),
          scoutHint,
          ...players),
        benchCard)),
  ));
}
