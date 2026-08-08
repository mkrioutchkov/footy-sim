// ── pre-match team talk ── extracted from app.ts (Round: appts-audit, pass 3).

import { api, type TalkToneT, type TalkReactionT } from '../api.ts';
import { h } from '../ui/dom.ts';
import { mount, toast, screenGuard, goBack } from '../ui/shell.ts';
import { header } from '../ui/nav.ts';
import { screenCreateTeam } from './create-team.ts';

// ── pre-match team talk (§2.13): pick a tone, see how it lands, deliver it ──
export async function screenTeamTalk(fixtureId: number) {
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Gathering the squad…')));
  let data: { tones: TalkToneT[]; pending: { tone: string } | null; tone: string; reactions: TalkReactionT[] };
  try { data = await api.teamTalk(fixtureId); }
  catch (e: any) {
    if (!alive()) return;
    if (String(e.message).includes('no team')) return screenCreateTeam();
    return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message),
      h('button', { class: 'ghost', style: 'margin-top:12px', onclick: () => (location.hash = '#/') }, '← Back')));
  }
  let tone = data.tone;
  let talkReq = 0;   // ignore an out-of-order tone-preview response (rapid clicks can resolve in the wrong order)

  function render() {
    const reactColor = (d: number) => d >= 0.08 ? 'var(--accent)' : d <= -0.08 ? 'var(--danger)' : 'var(--muted, #8a93a3)';
    const lifts = data.reactions.filter(r => r.delta >= 0.08).length;
    const rattles = data.reactions.filter(r => r.delta <= -0.08).length;
    const toneBtns = data.tones.map(t => {
      const b = h('button', { class: t.key === tone ? 'primary small' : 'ghost small', title: t.blurb }, t.label);
      if (t.key !== tone) b.addEventListener('click', async () => { const my = ++talkReq; try { const d = await api.teamTalk(fixtureId, t.key); if (!alive() || my !== talkReq) return; data = d; tone = d.tone; render(); } catch (e: any) { toast(e.message); } });
      return b;
    });
    const blurb = data.tones.find(t => t.key === tone)?.blurb ?? '';
    const rows = data.reactions.slice().sort((a, b) => b.delta - a.delta).map(r => h('div', { class: 'between', style: 'font-size:13px;padding:3px 0' },
      h('span', {}, r.name, h('span', { class: 'muted', style: 'font-size:11px;margin-left:6px' }, r.role)),
      h('span', { style: `color:${reactColor(r.delta)};font-weight:600;text-transform:capitalize` }, `${r.reaction}${r.delta ? ` (${r.delta > 0 ? '+' : ''}${r.delta.toFixed(2)})` : ''}`)));

    const deliver = h('button', { class: 'primary' }, data.pending ? 'Update the talk' : 'Deliver this talk');
    deliver.addEventListener('click', async () => {
      deliver.setAttribute('disabled', 'true'); deliver.textContent = '…';
      try { await api.setTeamTalk(fixtureId, tone); toast('Team talk locked in — it shades your next match.'); location.hash = '#/'; }
      catch (e: any) { toast(e.message); deliver.removeAttribute('disabled'); deliver.textContent = 'Deliver this talk'; }
    });

    if (!alive()) return;
    mount(header(), h('div', { class: 'wrap grid' },
      h('div', { class: 'between' },
        h('div', {}, h('h2', {}, 'Team talk'), h('div', { class: 'muted' }, 'How you address the squad before kick-off shades their morale for the match — and each player reacts to his own temperament.')),
        h('button', { class: 'ghost', onclick: () => goBack() }, '← Back')),
      h('div', { class: 'card' },
        h('div', { class: 'row', style: 'flex-wrap:wrap;gap:6px' }, ...toneBtns),
        h('div', { class: 'muted', style: 'font-size:12px;margin-top:8px' }, blurb),
        data.pending ? h('div', { class: 'muted', style: 'font-size:11px;margin-top:4px;font-style:italic' }, `Currently set: ${data.tones.find(t => t.key === data.pending!.tone)?.label ?? data.pending.tone}`) : ''),
      h('div', { class: 'card' },
        h('div', { class: 'between', style: 'margin-bottom:6px' },
          h('div', { class: 'section-title', style: 'margin:0' }, 'How it lands'),
          h('span', { class: 'muted', style: 'font-size:11px' }, `${lifts} lifted · ${rattles} rattled`)),
        // Honest hint when nobody reacts: a talk moves players via their PERSONALITY, so a squad with no
        // strong characters yet (freshly created, or personalities still being generated) barely stirs.
        lifts === 0 && rattles === 0 && data.reactions.length
          ? h('div', { class: 'muted', style: 'font-size:12px;font-style:italic;margin-bottom:6px' }, 'No one’s stirred — this squad has no strong personalities for a talk to move yet (they settle as your players’ characters develop).')
          : '',
        h('div', { style: 'max-height:420px;overflow:auto' }, ...rows)),
      h('div', { class: 'row' }, deliver),
    ));
  }
  render();
}
