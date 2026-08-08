// ── shared-world lobby ── extracted from app.ts (Round: appts-audit, pass 3). Reachable WITHOUT a club
// (boot lets a club-less manager visit #/worlds), so screenCreateTeam is an offer here, not a fallback.

import { api } from '../api.ts';
import { h, clickable } from '../ui/dom.ts';
import { mount, toast, screenGuard } from '../ui/shell.ts';
import { emptyState } from '../ui/states.ts';
import { header } from '../ui/nav.ts';
import { screenCreateTeam } from './create-team.ts';

// §autonomous: the world lobby — browse shared (multiplayer) worlds and claim an unclaimed club. A world
// advances on a schedule (2 turns/day); you set tactics/transfers and the matchday plays automatically.
export async function screenWorlds() {
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading worlds…')));
  let data: Awaited<ReturnType<typeof api.worlds>>;
  try { data = await api.worlds(); }
  catch (e: any) { if (!alive()) return; return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message))); }

  const container = h('div', {});
  let worldRequest = 0;
  let claimBusy = false;
  const claimButtons = new Set<HTMLButtonElement>();
  const paintClaimBusy = () => {
    for (const button of claimButtons) {
      if (!button.isConnected) { claimButtons.delete(button); continue; }
      button.disabled = claimBusy;
    }
  };
  const cadence = (min: number) => min % 1440 === 0 ? `${min / 1440}/day` : `every ${Math.round(min / 60)}h`;
  const claimInto = async (worldId: number, teamId: number, btn: HTMLButtonElement) => {
    if (claimBusy) return;
    claimBusy = true; paintClaimBusy(); btn.textContent = 'Claiming…';
    try {
      await api.claimTeam(worldId, teamId);
      if (!alive()) return;
      toast('✓ Club claimed — welcome to the world!'); location.hash = '#/';
    } catch (e: any) { if (alive()) toast(e.message); }
    finally { claimBusy = false; btn.textContent = 'Claim'; paintClaimBusy(); }
  };
  const openWorld = async (w: import('../api').JoinableWorldT) => {
    const request = ++worldRequest;
    claimButtons.clear();
    const host = h('div', { class: 'card muted' }, 'Loading clubs…');
    container.replaceChildren(
      h('div', { class: 'between' }, h('h2', {}, w.name), h('button', { class: 'ghost', onclick: () => render() }, '← All worlds')),
      h('div', { class: 'muted', style: 'margin:-4px 0 10px;font-size:13px' }, `Season ${w.season} · turn ${w.turn} · advances ${cadence(w.intervalMin)} · ${w.unclaimed} club(s) open`),
      host);
    try {
      const { teams } = await api.worldTeams(w.worldId);
      if (!alive() || request !== worldRequest) return;
      const rowFor = (t: import('../api').ClaimableTeamT) => {
        const claim = h('button', { class: 'primary small' }, 'Claim') as HTMLButtonElement;
        if (!t.claimed && !data.hasTeam) { claimButtons.add(claim); claim.disabled = claimBusy; }
        claim.addEventListener('click', () => claimInto(w.worldId, t.teamId, claim));
        return h('tr', {},
          h('td', {}, t.name, h('span', { class: 'muted', style: 'font-size:11px' }, ` · ${t.division}`)),
          h('td', { class: 'num' }, `T${t.tier}`),
          h('td', { class: 'num' }, String(t.overall)),
          h('td', { class: 'num' }, t.claimed ? h('span', { class: 'muted', style: 'font-size:12px' }, `👤 ${t.manager}`) : (data.hasTeam ? h('span', { class: 'muted', style: 'font-size:11px' }, 'open') : claim)));
      };
      host.replaceChildren(h('div', { class: 'card', style: 'padding:0;overflow-x:auto' },
        h('table', { style: 'width:100%' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Club'), h('th', { class: 'num' }, 'Div'), h('th', { class: 'num' }, 'OVR'), h('th', { class: 'num' }, ''))),
          h('tbody', {}, ...teams.map(rowFor))),
        data.hasTeam ? h('div', { class: 'muted', style: 'padding:10px;font-size:12px' }, 'You already manage a club — leave it first (from your dashboard) to claim here.') : ''));
    } catch (e: any) { if (alive() && request === worldRequest) host.replaceChildren(h('div', { class: 'card err' }, e.message)); }
  };
  const render = () => {
    worldRequest++;   // invalidate a slower club-list request after returning to the lobby
    container.replaceChildren(
      h('div', { class: 'between' }, h('div', {}, h('h2', {}, '🌍 Shared worlds'), h('div', { class: 'muted', style: 'font-size:13px' }, 'Live multiplayer worlds that advance on a schedule. Claim a club to join.')),
        h('button', { class: 'ghost', onclick: () => (location.hash = data.hasTeam ? '#/' : '') }, data.hasTeam ? '← Dashboard' : '← Back')),
      data.worlds.length
        ? h('div', { class: 'grid' }, ...data.worlds.map(w => h('div', { class: 'card', ...clickable(() => openWorld(w)), style: 'cursor:pointer' },
            h('div', { class: 'between' },
              h('div', {}, h('div', { style: 'font-weight:700' }, w.name), h('div', { class: 'muted', style: 'font-size:12px' }, `Season ${w.season} · turn ${w.turn} · advances ${cadence(w.intervalMin)}`)),
              h('span', { class: 'pill', style: w.unclaimed ? 'background:var(--accent);color:#0b1018' : '' }, `${w.unclaimed}/${w.total} open`)))))
        : emptyState({ icon: '🌍', title: 'No shared worlds yet', hint: 'Ask an admin to open one — or start your own solo career.', action: h('button', { class: 'primary small', style: 'margin-top:6px', onclick: () => screenCreateTeam() }, 'Create a solo club →') }));
  };
  if (!alive()) return;
  mount(header(), h('div', { class: 'wrap grid' }, container));
  render();
}
