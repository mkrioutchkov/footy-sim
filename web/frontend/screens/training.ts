// ── training ── extracted from app.ts (Round: appts-audit, pass 3): club focus + intensity, the quick
// schedules, last session's report and the per-player focus/intensity/retrain overrides. The two direct
// route() calls that re-dispatched after a preset or a retrain are now shell.rerender() — same dispatch
// (boot wires it to route()), without this module importing the router.

import { api, type TeamT, type TrainingReportT } from '../api.ts';
import { h } from '../ui/dom.ts';
import { skillOvr, TRAINING_FOCI, ATTR_SHORT, focusLabel, fmtDelta } from '../ui/format.ts';
import { mount, toast, screenGuard, rerender } from '../ui/shell.ts';
import { guardSelect, scrollRegion, responsiveTable } from '../ui/states.ts';
import { header } from '../ui/nav.ts';
import { screenCreateTeam } from './create-team.ts';

// ── training / development ──
export async function screenTraining() {
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading…')));
  let team: TeamT;
  try { team = await api.team(); }
  catch (e: any) {
    if (!alive()) return;
    if (String(e.message).includes('no team')) return screenCreateTeam();
    return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message)));
  }
  // The report is best-effort — show the screen even if it hasn't been generated yet (or 404s).
  let report: TrainingReportT | null = null;
  try { report = (await api.trainingReport()).report; } catch { /* no report yet */ }
  const ovrOf = (p: typeof team.players[number]) => skillOvr(p.attrs, p.role);

  // club-wide focus selector
  const sel = h('select', { class: 'focus-select', 'aria-label': 'Club training focus' }) as HTMLSelectElement;
  for (const f of TRAINING_FOCI) {
    const o = h('option', { value: f }, focusLabel(f)) as HTMLOptionElement;
    if (f === (team.trainingFocus ?? 'balanced')) o.selected = true;
    sel.append(o);
  }
  guardSelect(sel, async v => { const r = await api.setTraining(v); toast(`Club training focus: ${focusLabel(r.focus)}`); return r.focus; }, alive);

  // club-wide training intensity dial — a gentler scale than the per-player override (which wins).
  // 'normal' is the byte-identical default; heavy grows the whole squad faster at a higher injury cost.
  const TEAM_INTENSITY: [string, string][] = [['light', 'Light'], ['normal', 'Normal'], ['heavy', 'Heavy ↑']];
  const tiSel = h('select', { class: 'focus-select', 'aria-label': 'Club training intensity', title: 'Sets the whole squad’s training load (a player’s own intensity overrides this). Heavier grows faster but tires legs and raises injury risk.' }) as HTMLSelectElement;
  for (const [iv, lbl] of TEAM_INTENSITY) {
    const o = h('option', { value: iv }, lbl) as HTMLOptionElement;
    if (iv === (team.trainingIntensity ?? 'normal')) o.selected = true;
    tiSel.append(o);
  }
  const tiHint = h('span', { class: 'muted', style: 'font-size:12px' });
  const intensityHint = (v: string) => v === 'heavy' ? 'Whole squad: +40% growth, higher fatigue + injury risk'
    : v === 'light' ? 'Whole squad: −30% growth, fresher legs + fewer injuries' : 'Whole squad: standard load';
  tiHint.textContent = intensityHint(team.trainingIntensity ?? 'normal');
  guardSelect(tiSel, async v => { const r = await api.setTeamIntensity(v); tiHint.textContent = intensityHint(r.intensity); toast(`Club intensity: ${r.intensity}`); return r.intensity; }, alive);

  // one-click training schedules — set the club focus + intensity together (FM's preset buttons)
  const PRESETS: [string, string, string][] = [
    ['balanced', 'Balanced', 'Even development, normal load'],
    ['attacking', 'Attacking', 'Sharpen shooting, normal load'],
    ['possession', 'Possession', 'Drill passing, normal load'],
    ['defending', 'Defending', 'Work the back line, normal load'],
    ['fitness', 'Fitness', 'Build stamina — heavy load'],
    ['recovery', 'Recovery', 'Freshen the legs — light load'],
  ];
  const presetRow = h('div', { class: 'card' },
    h('div', { class: 'row', style: 'align-items:center;gap:8px;flex-wrap:wrap' },
      h('span', { class: 'section-title', style: 'margin:0 6px 0 0' }, 'Quick schedules'),
      ...PRESETS.map(([name, label, hint]) => h('button', {
        class: 'ghost', style: 'font-size:12px;padding:4px 10px', title: hint,
        onclick: async () => {
          try { const r = await api.applyTrainingPreset(name); if (!alive()) return; toast(`Training schedule: ${r.preset?.label ?? label}`); rerender(); }
          catch (e: any) { if (alive()) toast(e.message); }
        },
      }, label))));

  // ── last session's training report — "why did X improve" ──
  const reportCard = (() => {
    if (!report || !report.lines.length) return h('div', { class: 'card' },
      h('div', { class: 'muted', style: 'font-size:13px' }, '📈 No training session yet — play a matchday and your squad’s development shows up here.'));
    const lines = [...report.lines].sort((a, b) => b.ovrDelta - a.ovrDelta || b.ovrAfter - a.ovrAfter);
    const improved = lines.filter(l => l.ovrDelta > 0).length;
    const declined = lines.filter(l => l.ovrDelta < 0).length;
    const steady = lines.length - improved - declined;
    const chips: (HTMLElement | string)[] = [h('span', { class: 'pill' }, `Focus: ${focusLabel(report.teamFocus)}`)];
    if (report.coachBoost > 0) chips.push(h('span', { class: 'pill', style: 'background:rgba(67,211,158,.15);color:var(--accent)' }, `Coaching +${report.coachBoost}%`));
    if (report.harmonyFactor > 1) chips.push(h('span', { class: 'pill', style: 'background:rgba(67,211,158,.15);color:var(--accent)' }, 'Settled squad ↑'));
    else if (report.harmonyFactor < 1) chips.push(h('span', { class: 'pill', style: 'background:#3a2a1f;color:#ffce9a' }, 'Unsettled squad ↓'));

    const lineEls = lines.map(l => {
      const up = l.ovrDelta > 0, down = l.ovrDelta < 0;
      const deltaBadge = h('span', { style: `font-weight:700;${up ? 'color:var(--accent)' : down ? 'color:var(--danger)' : 'opacity:.55'}` },
        up ? `▲ ${l.ovrDelta}` : down ? `▼ ${Math.abs(l.ovrDelta)}` : '– 0');
      const attrChips = l.attrs.slice(0, 5).map(a => h('span', {
        class: 'pill', style: `text-transform:none;letter-spacing:0;font-size:11px;${a.delta > 0 ? 'color:var(--accent)' : 'color:var(--danger)'}`,
      }, `${ATTR_SHORT[a.key] ?? a.key} ${fmtDelta(a.delta)}`));
      return h('div', { class: 'card', style: 'padding:8px 10px;margin:0' },
        h('div', { class: 'between', style: 'align-items:baseline;gap:8px' },
          h('div', {}, h('span', { style: 'font-weight:600' }, l.name),
            h('span', { class: 'pill', style: 'margin-left:6px' }, l.role),
            l.individual ? h('span', { class: 'pill', style: 'margin-left:4px;background:rgba(78,161,255,.18)' }, `★ ${focusLabel(l.focus)}`) : ''),
          h('div', { style: 'display:flex;gap:8px;align-items:baseline;white-space:nowrap' },
            h('span', { class: 'muted', style: 'font-size:12px' }, `OVR ${l.ovrBefore}→${l.ovrAfter}`), deltaBadge)),
        l.attrs.length ? h('div', { class: 'row', style: 'gap:4px;flex-wrap:wrap;margin-top:5px' }, ...attrChips) : '',
        l.factors.length ? h('div', { class: 'muted', style: 'font-size:11px;margin-top:4px' }, l.factors.join(' · ')) : '');
    });

    // per-category coaching board snapshot — shows which categories the staff is driving (★ + growth %)
    const catRow = report.categoryFactors && report.categoryFactors.length
      ? h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap;margin:0 0 8px' },
          ...report.categoryFactors.map(c => {
            const pct = Math.round((c.factor - 1) * 100);
            const full = Math.max(0, Math.min(5, Math.round(c.stars)));
            const stars = '★'.repeat(full) + '☆'.repeat(5 - full);
            const good = pct > 0;
            return h('span', {
              class: 'pill', style: `text-transform:none;letter-spacing:0;font-size:11px;${good ? 'color:var(--accent)' : pct < 0 ? 'color:#ffce9a' : 'opacity:.7'}`,
              title: `${c.category}: ${c.stars.toFixed(1)}★ · coverage ${Math.round(c.coverage * 100)}% · ${pct >= 0 ? '+' : ''}${pct}% growth`,
            }, `${c.category} ${stars} ${pct >= 0 ? '+' : ''}${pct}%`);
          }))
      : '';
    return h('div', { class: 'card' },
      h('div', { class: 'between' },
        h('div', { class: 'section-title', style: 'margin-top:0' }, 'Last training session'),
        h('div', { class: 'muted', style: 'font-size:12px' }, `Season ${report.season} · after Matchday ${report.round}`)),
      h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap;margin:-2px 0 8px;align-items:center' }, ...chips,
        h('span', { class: 'muted', style: 'font-size:12px;margin-left:2px' }, `${improved} improved · ${declined} declined${steady ? ` · ${steady} steady` : ''}`)),
      catRow,
      h('div', { class: 'grid', style: 'gap:6px;max-height:440px;overflow:auto' }, ...lineEls));
  })();

  // ── squad table — OVR/potential + a per-player focus override ──
  const body = h('tbody');
  for (const p of [...team.players].sort((a, b) => a.slot - b.slot)) {
    const ovr = ovrOf(p), pot = p.potential ?? ovr;
    const room = pot - ovr;
    const pfSel = h('select', { class: 'focus-select', style: 'font-size:12px;padding:2px 4px', 'aria-label': 'Training focus for ' + p.name }) as HTMLSelectElement;
    pfSel.append(h('option', { value: '' }, 'Follow club'));
    for (const f of TRAINING_FOCI) {
      const o = h('option', { value: f }, focusLabel(f)) as HTMLOptionElement;
      if (f === (p.trainFocus ?? '')) o.selected = true;
      pfSel.append(o);
    }
    guardSelect(pfSel, async v => { const r = await api.setPlayerTraining(p.slot, v); toast(r.focus ? `${p.name}: ${focusLabel(r.focus)}` : `${p.name} follows the club focus`); return r.focus ?? undefined; }, alive);
    // per-player training intensity — faster growth at a higher injury cost (normal = the default / byte-identical)
    const piSel = h('select', { class: 'focus-select', style: 'font-size:12px;padding:2px 4px', 'aria-label': 'Training intensity for ' + p.name, title: 'Higher intensity grows faster but raises injury risk; rest recovers' }) as HTMLSelectElement;
    for (const [iv, lbl] of [['normal', 'Normal'], ['double', 'Double ↑'], ['half', 'Light'], ['rest', 'Rest']]) {
      const o = h('option', { value: iv }, lbl) as HTMLOptionElement;
      if (iv === (p.trainIntensity ?? 'normal')) o.selected = true;
      piSel.append(o);
    }
    guardSelect(piSel, async v => { const r = await api.setPlayerIntensity(p.slot, v); toast(`${p.name}: ${r.intensity ?? 'normal'} training`); return r.intensity ?? undefined; }, alive);
    // position retrain — learn a new role; while settling, he develops a little slower (familiarity bar)
    const rtSel = h('select', { class: 'focus-select', style: 'font-size:12px;padding:2px 4px', 'aria-label': 'Retrain position for ' + p.name, title: 'Retrain this player into a new position. He settles in over several matchdays, developing a little slower until comfortable.' }) as HTMLSelectElement;
    rtSel.append(h('option', { value: '' }, 'No (stay ' + p.role + ')'));
    for (const role of ['GK', 'FB', 'CB', 'CM', 'WM', 'CF']) {
      if (role === p.role) continue;
      const o = h('option', { value: role }, '→ ' + role) as HTMLOptionElement;
      if (role === (p.retrainRole ?? '')) o.selected = true;
      rtSel.append(o);
    }
    guardSelect(rtSel, async v => { const r = await api.setPlayerRetrain(p.slot, v || 'clear'); if (!alive()) return; toast(r.retrainRole ? `${p.name}: retraining → ${r.retrainRole}` : `${p.name}: settled at ${p.role}`); rerender(); return r.retrainRole ?? undefined; }, alive);
    const fam = Math.round(p.roleFamiliarity ?? 100);
    const retrainCell = p.retrainRole
      ? h('div', { style: 'min-width:90px' }, rtSel,
          h('div', { style: 'margin-top:3px;height:5px;background:#26303f;border-radius:3px;overflow:hidden', title: `Settling into ${p.retrainRole}: ${fam}%` },
            h('div', { style: `height:100%;width:${fam}%;background:var(--accent)` })),
          h('div', { class: 'muted', style: 'font-size:10px;margin-top:1px' }, `settling ${fam}%`))
      : rtSel;
    body.append(h('tr', {},
      h('td', {}, p.name, p.slot >= 11 ? h('span', { class: 'muted', style: 'font-size:11px' }, ' · bench') : ''),
      h('td', {}, h('span', { class: 'pill' }, p.role)),
      h('td', { class: 'num' }, p.age != null ? String(p.age) : '—'),
      h('td', { class: 'num' }, String(ovr)),
      h('td', { class: 'num' }, room > 0 ? h('span', { class: 'a' }, `${pot} (+${room})`) : String(pot)),
      h('td', {}, pfSel),
      h('td', {}, piSel),
      h('td', {}, retrainCell),
    ));
  }

  if (!alive()) return;
  mount(header(), h('div', { class: 'wrap grid' },
    h('div', { class: 'between' },
      h('div', {}, h('h2', {}, 'Training'),
        h('div', { class: 'muted' }, 'Players drift toward their potential each matchday — faster while young and for the diligent. Set a club focus, or override one player to push a single attribute (or “Position-specific” to train for his role).')),
      h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, '← Back'),
    ),
    presetRow,
    reportCard,
    h('div', { class: 'card' },
      h('div', { class: 'row', style: 'align-items:center;gap:10px;margin-bottom:6px;flex-wrap:wrap' },
        h('span', { class: 'section-title', style: 'margin:0' }, 'Club training focus'), sel,
        h('span', { class: 'section-title', style: 'margin:0 0 0 10px' }, 'Intensity'), tiSel, tiHint),
      (() => {
        // squad load at a glance — surfaces the per-player overrides + retrains against the club dial
        const piCount = (v: string) => team.players.filter(p => p.trainIntensity === v).length;
        const retraining = team.players.filter(p => p.retrainRole).length;
        const bits: string[] = [];
        if (piCount('double')) bits.push(`${piCount('double')} on Double ↑`);
        if (piCount('half')) bits.push(`${piCount('half')} on Light`);
        if (piCount('rest')) bits.push(`${piCount('rest')} Resting`);
        if (retraining) bits.push(`${retraining} retraining`);
        return h('div', { class: 'muted', style: 'font-size:12px;margin:0 0 4px' },
          bits.length ? `Squad: ${bits.join(' · ')} — everyone else on the club dial` : 'Squad: every player on the club default');
      })(),
      h('div', { style: 'margin-top:8px' },
        scrollRegion('Training table', responsiveTable(
          h('thead', {}, h('tr', {},
            h('th', {}, 'Player'), h('th', {}, 'Pos'),
            h('th', { class: 'num' }, 'Age'), h('th', { class: 'num' }, 'OVR'), h('th', { class: 'num' }, 'Potential'), h('th', {}, 'Focus'), h('th', {}, 'Intensity'), h('th', {}, 'Retrain'))),
          body), { maxH: '540px', sticky: true })),
    ),
  ));
}
