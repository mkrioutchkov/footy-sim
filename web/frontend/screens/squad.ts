// ── squad spine screen: sortable attribute table + heat + depth chart + compare ── extracted from app.ts
// (Round: appts-audit). squadView below is deliberately module-level so the chosen sort/compare survives
// navigating away and back.
import { api, type TeamT, type PlayerT, type RotationT } from '../api.ts';
import { h, clickable } from '../ui/dom.ts';
import { BAND_COLOR, SQUAD_ATTRS, attrHeat, contractStyle, fmtMoney, footLabel, footTag, seekingMove, skillOvr } from '../ui/format.ts';
import { mount, rerender, screenGuard, toast } from '../ui/shell.ts';
import { responsiveTable, scrollRegion } from '../ui/states.ts';
import { header } from '../ui/nav.ts';
import { screenCreateTeam } from './create-team.ts';

// Persisted squad-table view state so a captain/rotation action (which reloads the whole screen) — or a
// return visit — keeps the user's chosen sort column/direction and the two compare picks. See screenSquad.
const squadView: { sortKey: string; sortDir: 1 | -1; cmpA: number; cmpB: number; q: string; roleF: string; attn: boolean } = { sortKey: 'slot', sortDir: 1, cmpA: -1, cmpB: -1, q: '', roleF: '', attn: false };
// ── squad spine screen: sortable attribute table + heat + depth chart + compare ──
export async function screenSquad() {
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading squad…')));
  let team: TeamT;
  try { team = await api.team(); }
  catch (e: any) {
    if (!alive()) return;
    if (String(e.message).includes('no team')) return screenCreateTeam();
    return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message),
      h('button', { class: 'ghost', style: 'margin-top:12px', onclick: () => screenSquad() }, '↻ Retry')));
  }
  // §2.10 fitness/rotation: best-effort — the table + rotation card degrade gracefully if it 404s.
  let rot: RotationT | null = null;
  try { rot = await api.rotation(); } catch { /* no rotation guidance */ }
  const rotMap = new Map((rot?.players ?? []).map(p => [p.slot, p] as const));
  // Fitness cell: 🤕 for the injured, else the condition % coloured by band, with a ⚠risk badge on
  // an at-risk starter (so the cost of fielding a tired man is visible right in the squad table).
  const fitCell = (p: PlayerT) => {
    if ((p.injuredMatches ?? 0) > 0) return h('td', { class: 'num', style: 'color:var(--danger)' }, `🤕${p.injuredMatches}`);
    const r = rotMap.get(p.slot);
    const col = r ? BAND_COLOR[r.band] : '';
    // Show the risk badge for any objectively tired/exhausted starter — keyed off the fitness band, not
    // an absolute risk, so a strong physio lowering the % can't hide the warning for a tired man.
    const warn = r && r.starter && (r.band === 'tired' || r.band === 'exhausted')
      ? h('span', { class: 'muted', style: 'font-size:10px;color:#ffb84d' }, ` ⚠${Math.round(r.risk * 100)}%`) : '';
    return h('td', { class: 'num', style: col ? `color:${col}` : '', title: r ? `${Math.round(r.risk * 100)}% injury risk if he starts` : '' }, `${p.fitness ?? 100}%`, warn);
  };
  const players = [...team.players];
  const leadOf = (p: PlayerT) => (p.personality?.traits?.leadership ?? -1);
  // §2.11: the MANAGER's chosen captain wins; otherwise the highest-leadership player (and only when at
  // least one player HAS personality data — don't fabricate a captain on players[0] for a dial-less squad).
  const autoCap = players.length ? players.reduce((best, p) => leadOf(p) > leadOf(best) ? p : best, players[0]) : null;
  const autoSlot = autoCap && leadOf(autoCap) >= 0 ? autoCap.slot : -1;
  const captainSlot = team.captainSlot != null && players.some(p => p.slot === team.captainSlot) ? team.captainSlot : autoSlot;

  let sortKey = squadView.sortKey, sortDir: 1 | -1 = squadView.sortDir, cmpA = squadView.cmpA, cmpB = squadView.cmpB;
  const COLS: { key: string; label: string; text?: boolean; get: (p: PlayerT) => number | string }[] = [
    { key: 'slot', label: 'Name', text: true, get: p => p.name },
    { key: 'role', label: 'Pos', text: true, get: p => p.role },
    { key: 'age', label: 'Age', get: p => p.age ?? 0 },
    { key: 'ovr', label: 'OVR', get: p => skillOvr(p.attrs, p.role) },
    { key: 'pot', label: 'POT', get: p => p.potential ?? 0 },
    ...SQUAD_ATTRS.map(([a, lab]): { key: string; label: string; get: (p: PlayerT) => number } => ({ key: a, label: lab, get: p => p.attrs[a] ?? 0 })),
    { key: 'wage', label: 'Wage', get: p => p.wage ?? 0 },
    { key: 'contract', label: 'Contr', get: p => p.contractYears ?? 0 },
    { key: 'morale', label: 'Mor', get: p => p.morale ?? 0 },
    { key: 'fitness', label: 'Fit', get: p => (p.injuredMatches ?? 0) > 0 ? -1 : (p.fitness ?? 100) },
  ];

  function render() {
    const col = COLS.find(c => c.key === sortKey)!;
    const sorted = [...players].sort((a, b) => {
      const va = col.get(a), vb = col.get(b);
      const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return c * sortDir;
    });
    const thead = h('thead', {}, h('tr', {}, ...COLS.map(c => {
      const sort = () => { if (sortKey === c.key) sortDir = (sortDir === 1 ? -1 : 1); else { sortKey = c.key; sortDir = c.text ? 1 : -1; } squadView.sortKey = sortKey; squadView.sortDir = sortDir; render(); };
      // a sortable column header: keep the columnheader role (don't override with role=button), add aria-sort + keyboard
      const th = h('th', {
        class: c.text ? '' : 'num', style: 'cursor:pointer;user-select:none', tabindex: '0', title: `Sort by ${c.label}`,
        'aria-sort': sortKey === c.key ? (sortDir === 1 ? 'ascending' : 'descending') : 'none',
        onclick: sort, onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sort(); } },
      }, c.label + (sortKey === c.key ? (sortDir === 1 ? ' ▲' : ' ▼') : ''));
      return th;
    })));
    // Position + "needs attention" filters apply at build time (so the rows in the DOM are the role/attn set);
    // the free-text search filters those rows IN PLACE (applyText below), so typing never remounts / loses focus.
    const needsAttention = (p: PlayerT): boolean =>
      (p.injuredMatches ?? 0) > 0 || (p.morale ?? 100) < 40 || seekingMove(p) || (p.contractYears ?? 9) <= 1;
    const matchesRoleAttn = (p: PlayerT): boolean =>
      (!squadView.roleF || p.role === squadView.roleF) && (!squadView.attn || needsAttention(p));
    // squad-strength summary (filter-independent — squad-wide read)
    const xi = players.filter(p => p.slot < 11);
    const xiOvr = xi.length ? Math.round(xi.reduce((s, p) => s + skillOvr(p.attrs, p.role), 0) / xi.length) : 0;
    const avgAge = players.length ? Math.round(players.reduce((s, p) => s + (p.age ?? 0), 0) / players.length) : 0;
    const attnCount = players.filter(needsAttention).length;
    const statChip = (label: string, val: string, color = '') => h('div', { style: 'min-width:84px' },
      h('div', { style: `font-size:20px;font-weight:700${color ? `;color:${color}` : ''}` }, val),
      h('div', { class: 'muted', style: 'font-size:11px' }, label));
    const strengthCard = h('div', { class: 'card', style: 'display:flex;gap:20px;flex-wrap:wrap;align-items:center' },
      statChip('XI avg OVR', String(xiOvr)),
      statChip('Squad avg age', `${avgAge}y`),
      statChip('Need attention', String(attnCount), attnCount ? '#ffb84d' : ''),
      (team.wageBill != null && team.wageBudget != null)
        ? statChip('Wage bill', `${fmtMoney(team.wageBill)}`, team.wageBill > team.wageBudget ? 'var(--danger)' : '') : '');
    const tbody = h('tbody');
    for (const p of sorted.filter(matchesRoleAttn)) {
      const ovr = skillOvr(p.attrs, p.role);
      const isCap = captainSlot === p.slot;
      // §2.11: a clickable armband — the captain shows 🧭, others a faint one; clicking names/clears the captain.
      const setCap = async () => {
        try { const r = await api.setCaptain(isCap ? -1 : p.slot); if (!alive()) return; toast(r.captainSlot == null ? 'Captain reset to auto (top leader)' : `${p.name} takes the armband`); rerender(); }
        catch (err: any) { if (alive()) toast(err.message); }
      };
      const capArm = h('span', {
        title: isCap ? 'Club captain — click to reset to auto (highest leader)' : `Make ${p.name} captain`,
        'aria-label': isCap ? `${p.name} is club captain — reset captain to auto` : `Make ${p.name} club captain`,
        style: `cursor:pointer;margin-right:4px;${isCap ? '' : 'opacity:.25'}`,
        ...clickable(setCap),
      }, '🧭');
      tbody.append(h('tr', { class: p.slot < 11 ? 'me' : '', 'data-search': `${p.name} ${p.role}`.toLowerCase() },
        h('td', { style: 'white-space:nowrap' }, capArm,
          h('span', { style: 'cursor:pointer', ...clickable(() => (location.hash = `#/player/${p.slot}`)) }, p.name),
          p.slot >= 11 ? h('span', { class: 'muted', style: 'font-size:10px' }, ' · bench') : '',
          seekingMove(p) ? h('span', { class: 'pill', title: 'Running down his contract and unsettled — likely to push for a move', style: 'margin-left:5px;background:var(--danger);color:#fff;font-size:9px' }, 'seeking move') : ''),
        h('td', { style: 'white-space:nowrap' }, h('span', { class: 'pill' }, p.role),
          h('span', { class: 'muted', title: footLabel(p.foot), style: 'font-size:10px;margin-left:4px' }, `(${footTag(p.foot)})`)),
        h('td', { class: 'num' }, String(p.age ?? '—')),
        h('td', { class: 'num', style: 'font-weight:700' }, String(ovr)),
        h('td', { class: 'num' }, p.potential != null && p.potential > ovr ? h('span', { class: 'a', style: 'color:var(--accent)' }, String(p.potential)) : String(p.potential ?? '—')),
        ...SQUAD_ATTRS.map(([a]) => h('td', { class: 'num', style: attrHeat(p.attrs[a] ?? 0) }, String(Math.round(p.attrs[a] ?? 0)))),
        h('td', { class: 'num' }, p.wage != null ? fmtMoney(p.wage) : '—'),
        h('td', { class: 'num', style: contractStyle(p.contractYears) }, (p.contractYears ?? 0) + 'y'),
        h('td', { class: 'num', style: p.morale != null ? (p.morale >= 75 ? 'color:var(--accent)' : p.morale <= 40 ? 'color:var(--danger)' : '') : '' }, String(p.morale ?? '—')),
        fitCell(p)));
    }
    // ── filter bar: free-text search (in-place, focus-preserving) + position + "needs attention" ──
    const countLabel = h('span', { class: 'muted', style: 'font-size:12px' });
    const applyText = () => {
      const q = squadView.q.trim().toLowerCase();
      let shown = 0;
      for (const tr of Array.from(tbody.children) as HTMLElement[]) {
        const hit = !q || (tr.getAttribute('data-search') ?? '').includes(q);
        tr.style.display = hit ? '' : 'none';
        if (hit) shown++;
      }
      countLabel.textContent = shown === players.length ? `${players.length} players` : `${shown} of ${players.length}`;
    };
    const qInput = h('input', { placeholder: 'Search name…', value: squadView.q, 'aria-label': 'Search squad by name', style: 'max-width:170px' }) as HTMLInputElement;
    qInput.addEventListener('input', () => { squadView.q = qInput.value; applyText(); });
    const roleSel = h('select', { 'aria-label': 'Filter by position', style: 'width:auto' },
      h('option', { value: '' }, 'All positions'),
      ...['GK', 'CB', 'FB', 'CM', 'WM', 'CF'].map(r => { const o = h('option', { value: r }, r) as HTMLOptionElement; if (squadView.roleF === r) o.selected = true; return o; })) as HTMLSelectElement;
    roleSel.addEventListener('change', () => { squadView.roleF = roleSel.value; render(); });
    const attnCb = h('input', { type: 'checkbox', 'aria-label': 'Show only players needing attention' }) as HTMLInputElement;
    attnCb.checked = squadView.attn;
    attnCb.addEventListener('change', () => { squadView.attn = attnCb.checked; render(); });
    const clearBtn = h('button', { class: 'ghost small', title: 'Clear filters' }, 'Clear');
    clearBtn.addEventListener('click', () => { squadView.q = ''; squadView.roleF = ''; squadView.attn = false; render(); });
    // On mobile the table reflows into cards and the sortable column headers are hidden — this select keeps
    // sorting reachable (desktop uses the header clicks, so it's CSS-hidden ≥720px via .resp-sort).
    const sortSel = h('select', { class: 'resp-sort', 'aria-label': 'Sort players by', style: 'width:auto' },
      ...COLS.map(c => { const o = h('option', { value: c.key }, `Sort: ${c.label}`) as HTMLOptionElement; if (c.key === sortKey) o.selected = true; return o; })) as HTMLSelectElement;
    sortSel.addEventListener('change', () => { const c = COLS.find(x => x.key === sortSel.value); if (!c) return; sortKey = c.key; sortDir = c.text ? 1 : -1; squadView.sortKey = sortKey; squadView.sortDir = sortDir; render(); });
    const filterBar = h('div', { class: 'row', style: 'gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:8px' },
      qInput, roleSel, sortSel,
      h('label', { class: 'row', style: 'gap:5px;align-items:center;font-size:12px;cursor:pointer' }, attnCb, '🚨 Needs attention'),
      (squadView.q || squadView.roleF || squadView.attn) ? clearBtn : '', countLabel);
    applyText();   // apply the current text filter to the freshly-built rows
    // depth by position (● starter / ○ bench)
    const ROLE_ORDER = ['GK', 'CB', 'FB', 'CM', 'WM', 'CF'];
    const byRole = ROLE_ORDER.map(role => ({ role, ps: players.filter(p => p.role === role).sort((a, b) => a.slot - b.slot) })).filter(g => g.ps.length);
    // Thin-position flag: a role with no FIT bench cover has no like-for-like replacement for an injury/suspension
    // there — the exact squad-planning signal FM surfaces. Amber ⚠ on the heading + a hint (data already in hand).
    const depth = h('div', { class: 'row', style: 'gap:16px;flex-wrap:wrap;align-items:start' }, ...byRole.map(g => {
      const cover = g.ps.filter(p => p.slot >= 11 && (p.injuredMatches ?? 0) === 0).length;
      const thin = cover === 0;
      return h('div', { style: 'min-width:120px' },
        h('div', { class: 'muted', style: `font-size:11px;text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px${thin ? ';color:#ffb84d' : ''}`, title: thin ? 'No fit backup in this position — an injury or suspension here leaves no like-for-like cover' : '' }, `${g.role} · ${g.ps.length}${thin ? ' ⚠' : ''}`),
        ...g.ps.map(p => h('div', { style: 'font-size:12px;padding:1px 0;' + (p.slot < 11 ? '' : 'opacity:.55'), }, `${p.slot < 11 ? '●' : '○'} ${p.name} ${skillOvr(p.attrs, p.role)}`)));
    }));
    // compare
    const opt = (sel: number) => [h('option', { value: '-1' }, '— pick —'), ...players.map(p => { const o = h('option', { value: String(p.slot) }, `${p.name} (${p.role})`) as HTMLOptionElement; if (p.slot === sel) o.selected = true; return o; })];
    const selA = h('select', { 'aria-label': 'Compare — first player' }, ...opt(cmpA)) as HTMLSelectElement;
    const selB = h('select', { 'aria-label': 'Compare — second player' }, ...opt(cmpB)) as HTMLSelectElement;
    selA.addEventListener('change', () => { cmpA = Number(selA.value); squadView.cmpA = cmpA; render(); });
    selB.addEventListener('change', () => { cmpB = Number(selB.value); squadView.cmpB = cmpB; render(); });
    const pa = players.find(p => p.slot === cmpA), pb = players.find(p => p.slot === cmpB);
    // A headline metric row (OVR/POT/age/wage/morale/fit) — greens the better value where higher-is-better;
    // age/wage aren't "better/worse" so they stay uncoloured. Turns a bare attr diff into a real like-for-like.
    const cmpSummary = (label: string, va: number, vb: number, fmt: (n: number) => string, colour = true) => {
      const ga = colour && va !== vb && va > vb ? 'color:var(--accent);font-weight:700' : '';
      const gb = colour && va !== vb && vb > va ? 'color:var(--accent);font-weight:700' : '';
      return h('div', { class: 'row', style: 'gap:10px;align-items:center;font-size:12px;margin:3px 0;justify-content:center' },
        h('span', { class: 'num', style: 'width:56px;text-align:right;' + ga }, fmt(va)),
        h('span', { class: 'muted', style: 'width:44px;text-align:center' }, label),
        h('span', { class: 'num', style: 'width:56px;' + gb }, fmt(vb)));
    };
    const cmpFit = (p: PlayerT) => (p.injuredMatches ?? 0) > 0 ? -1 : (p.fitness ?? 100);
    const cmp = pa && pb
      ? h('div', {},
          cmpSummary('OVR', skillOvr(pa.attrs, pa.role), skillOvr(pb.attrs, pb.role), n => String(n)),
          cmpSummary('POT', pa.potential ?? skillOvr(pa.attrs, pa.role), pb.potential ?? skillOvr(pb.attrs, pb.role), n => String(n)),
          cmpSummary('Age', pa.age ?? 0, pb.age ?? 0, n => n ? `${n}y` : '—', false),
          cmpSummary('Wage', pa.wage ?? 0, pb.wage ?? 0, n => n ? fmtMoney(n) : '—', false),
          cmpSummary('Morale', pa.morale ?? 0, pb.morale ?? 0, n => String(n)),
          cmpSummary('Fit', cmpFit(pa), cmpFit(pb), n => n < 0 ? '🤕' : `${n}%`),
          h('div', { style: 'border-top:1px solid var(--line);margin:7px 0' }),
          ...SQUAD_ATTRS.map(([a, lab]) => h('div', { class: 'row', style: 'gap:10px;align-items:center;font-size:12px;margin:3px 0;justify-content:center' },
            h('span', { class: 'num', style: 'width:56px;text-align:right;' + attrHeat(pa.attrs[a] ?? 0) }, String(Math.round(pa.attrs[a] ?? 0))),
            h('span', { class: 'muted', style: 'width:44px;text-align:center' }, lab),
            h('span', { class: 'num', style: 'width:56px;' + attrHeat(pb.attrs[a] ?? 0) }, String(Math.round(pb.attrs[a] ?? 0))))))
      : h('div', { class: 'muted', style: 'font-size:12px' }, 'Pick two players to compare their attributes.');

    // §2.10 rotation guidance: a "rest X for Y" panel with one-click apply, driven by fitness/injury.
    const rotationCard = (() => {
      const r = rot;
      if (!r) return '';
      const head = h('div', { class: 'between' },
        h('div', { class: 'section-title', style: 'margin-top:0' }, '🩺 Fitness & rotation'),
        h('div', { class: 'muted', style: 'font-size:12px' },
          `${r.atRisk} at risk · ~${r.expectedInjuries} expected injur${r.expectedInjuries === 1 ? 'y' : 'ies'} this matchday${r.physioMitigation ? ` · physios −${r.physioMitigation}% risk` : ''}`));
      if (!r.suggestions.length) return h('div', { class: 'card' }, head,
        h('div', { class: 'muted', style: 'font-size:13px;margin-top:6px' },
          r.atRisk ? 'Some starters are tired but you have no fitter cover in their position — sign depth or risk it.' : '✅ Your XI is fresh — no rotation needed.'));
      const rows = r.suggestions.map(s => {
        const btn = h('button', { class: 'ghost small' }, s.urgent ? 'Replace' : 'Rest him');
        btn.addEventListener('click', async () => {
          btn.setAttribute('disabled', 'true'); btn.textContent = '…';
          try { await api.applyRotation(s.outSlot, s.inSlot); if (!alive()) return; toast(`${s.inName} starts for ${s.outName}`); rerender(); }
          catch (e: any) { if (!alive()) return; toast(e.message); btn.removeAttribute('disabled'); btn.textContent = s.urgent ? 'Replace' : 'Rest him'; }
        });
        return h('div', { class: 'card', style: 'padding:8px 10px;margin:0;display:flex;justify-content:space-between;align-items:center;gap:10px' },
          h('div', { style: 'font-size:13px' },
            s.urgent ? h('span', { class: 'pill', style: 'background:var(--danger);color:#fff;font-size:9px;margin-right:6px' }, 'injured') : '',
            s.reason),
          btn);
      });
      return h('div', { class: 'card' }, head, h('div', { class: 'grid', style: 'gap:6px;margin-top:8px' }, ...rows));
    })();

    // Match-condition panel: a visual per-player STAMINA BAR (user ask) — most tired/injured first, so the
    // players who need resting surface at the top. Complements the Fit column + the 🩺 rotation card below.
    const conditionCard = (() => {
      const condCol = (p: PlayerT) => {
        if ((p.injuredMatches ?? 0) > 0) return 'var(--danger)';
        const band = rotMap.get(p.slot)?.band;
        if (band && BAND_COLOR[band]) return BAND_COLOR[band];
        const f = p.fitness ?? 100;
        return f < 50 ? 'var(--danger)' : f < 75 ? '#ffb84d' : f < 90 ? '#7fb2ff' : 'var(--accent)';
      };
      const fitVal = (p: PlayerT) => (p.injuredMatches ?? 0) > 0 ? -1 : (p.fitness ?? 100);
      const ranked = [...players].sort((a, b) => fitVal(a) - fitVal(b));   // most tired/injured first
      const bar = (p: PlayerT) => {
        const inj = (p.injuredMatches ?? 0) > 0;
        const fit = Math.max(0, Math.min(100, p.fitness ?? 100));
        const col = condCol(p);
        const r = rotMap.get(p.slot);
        const risk = r && r.starter && (r.band === 'tired' || r.band === 'exhausted') ? ` ⚠${Math.round(r.risk * 100)}%` : '';
        return h('div', { class: 'between', style: 'gap:10px;font-size:12px;padding:3px 0;align-items:center' },
          h('span', { style: 'width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0' },
            h('span', { style: 'opacity:.45;margin-right:3px' }, p.slot < 11 ? '●' : '○'), p.name,
            h('span', { class: 'muted', style: 'margin-left:5px;font-size:10px' }, p.role)),
          h('div', { style: 'flex:1;height:9px;background:var(--panel2,#161f30);border-radius:5px;overflow:hidden' },
            h('div', { style: `height:100%;width:${inj ? 100 : fit}%;background:${col}${inj ? ';background-image:repeating-linear-gradient(45deg,transparent,transparent 3px,rgba(0,0,0,.3) 3px,rgba(0,0,0,.3) 6px)' : ''}` })),
          h('span', { class: 'num', style: `width:62px;text-align:right;color:${col}` }, inj ? `🤕${p.injuredMatches}` : `${fit}%`),
          h('span', { class: 'muted', style: 'width:34px;font-size:10px;color:#ffb84d' }, risk));
      };
      return h('div', { class: 'card' },
        h('div', { class: 'section-title', style: 'margin-top:0' }, '🔋 Match condition'),
        h('div', { class: 'muted', style: 'font-size:11px;margin-bottom:6px' }, 'Per-player stamina — most tired first. A tired ⚠ or injured 🤕 starter risks an injury; rotate from the panel below.'),
        h('div', { style: 'max-height:430px;overflow:auto' }, ...ranked.map(bar)));
    })();

    if (!alive()) return;
    mount(header(), h('div', { class: 'wrap grid' },
      h('div', { class: 'between' },
        h('div', {}, h('h2', {}, 'Squad'), h('div', { class: 'muted' }, `${players.length} players · ● starter / ○ bench · 🧭 captain (click the armband to set — a strong leader steadies squad morale) · click a header to sort`)),
        h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, '← Back')),
      strengthCard,
      h('div', { class: 'card' }, filterBar, scrollRegion('Squad table', responsiveTable(thead, tbody), { sticky: true })),
      h('div', { class: 'grid cols-2', style: 'align-items:start' }, conditionCard, rotationCard || h('div')),
      h('div', { class: 'grid cols-2', style: 'align-items:start' },
        h('div', { class: 'card' }, h('div', { class: 'section-title', style: 'margin-top:0' }, 'Depth by position'), depth),
        h('div', { class: 'card' }, h('div', { class: 'section-title', style: 'margin-top:0' }, 'Compare two players'),
          h('div', { class: 'row', style: 'gap:10px;margin-bottom:10px' }, selA, selB), cmp))));
  }
  render();
}
