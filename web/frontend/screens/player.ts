// ── player profile (personality + the story↔traits coupling) ── extracted from app.ts (Round: appts-audit),
// together with the trait/attribute bar helpers and the development-summary line that only it renders.
import { api, type TeamT, type PlayerT, type ContractOfferT, type PlayerSeasonStatT } from '../api.ts';
import { h, svgEl } from '../ui/dom.ts';
import { SQUAD_ATTRS, TRAINING_FOCI, attrTierColor, capWord, fmtMoney, focusLabel, footLabel, parseMoneyInput, seekingMove, skillOvr } from '../ui/format.ts';
import { goBack, mount, rerender, screenGuard, toast } from '../ui/shell.ts';
import { guardSelect, subcard } from '../ui/states.ts';
import { promptModal } from '../ui/modal.ts';
import { header } from '../ui/nav.ts';
import { flagOf, nationNameOf } from '../ui/nations.ts';
import { screenCreateTeam } from './create-team.ts';

// A player's individual DEVELOPMENT state (focus / intensity / retraining) in plain English — all four
// fields ride on PlayerT already but only surface on the Training screen; the profile ignored them.
// Returns null when the player is on the club default with nothing individual set (nothing worth a line).
function trainingSummary(p: PlayerT): string | null {
  const bits: string[] = [];
  if (p.trainFocus && p.trainFocus !== 'balanced') bits.push(`${capWord(p.trainFocus)} focus`);
  if (p.trainIntensity && p.trainIntensity !== 'normal') bits.push(`${capWord(p.trainIntensity)} intensity`);
  if (p.retrainRole) bits.push(`retraining → ${p.retrainRole}${p.roleFamiliarity != null ? ` (settling ${Math.round(p.roleFamiliarity)}%)` : ''}`);
  return bits.length ? bits.join(' · ') : null;
}

// ── player profile (personality + the story↔traits coupling) ──
const TRAIT_LABELS: { key: string; label: string }[] = [
  { key: 'professionalism', label: 'Professionalism' }, { key: 'consistency', label: 'Consistency' },
  { key: 'bigGame', label: 'Big-game' }, { key: 'leadership', label: 'Leadership' },
  { key: 'temperament', label: 'Temperament (fiery)' }, { key: 'ego', label: 'Ego' },
  { key: 'criticismResponse', label: 'Responds to criticism' }, { key: 'praiseResponse', label: 'Responds to praise' },
];
function traitBar(label: string, v: number, color = 'var(--accent,#4ea1ff)', note?: Node | string): HTMLElement {
  return h('div', { style: 'margin-bottom:7px' },
    h('div', { class: 'between', style: 'font-size:12px;margin-bottom:2px' }, h('span', { class: 'muted' }, label), h('span', {}, String(v), note ?? '')),
    h('div', { style: 'height:6px;background:var(--panel2,#161f30);border-radius:3px;overflow:hidden' },
      h('div', { style: `height:100%;width:${Math.max(0, Math.min(100, v))}%;background:${color}` })));
}
// Attribute bars are colour-tiered (strong / solid / weak) so a profile reads at a glance, like the squad table.
const ATTR_LABELS: { key: keyof PlayerT['attrs']; label: string }[] = [
  { key: 'speed', label: 'Speed' }, { key: 'passing', label: 'Passing' }, { key: 'shooting', label: 'Shooting' },
  { key: 'creativity', label: 'Creativity' }, { key: 'tackling', label: 'Tackling' }, { key: 'positioning', label: 'Positioning' }, { key: 'stamina', label: 'Stamina' },
];
export async function screenPlayer(slot: number) {
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading…')));
  let team: TeamT;
  try { team = await api.team(); }
  catch (e: any) { if (!alive()) return; if (String(e.message).includes('no team')) return screenCreateTeam(); return mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message))); }
  const p = team.players.find(x => x.slot === slot);
  if (!p) { location.hash = '#/'; return; }
  const ovr = skillOvr(p.attrs, p.role);
  // squad role-average, for the per-attribute delta on the profile ("how good a CB is he for MY squad?")
  const sameRole = team.players.filter(x => x.role === p.role);
  const roleAvg = (k: string): number => sameRole.length ? sameRole.reduce((s, x) => s + (x.attrs[k] ?? 0), 0) / sameRole.length : 0;
  // development outlook — reads age vs headroom-to-potential the same way the dev tick does (grow young /
  // plateau / decline past ~30), so a manager sees whether a player is still a project or on the slide.
  const headroom = (p.potential ?? ovr) - ovr;
  const devOutlook: { icon: string; text: string; color: string } | null = (() => {
    const age = p.age ?? 24;
    if (age <= 23 && headroom >= 3) return { icon: '🌱', text: `Developing — ${headroom} OVR of headroom to his ${p.potential} ceiling`, color: 'var(--accent)' };
    if (age <= 29 && headroom >= 2) return { icon: '↗', text: `Still improving — ${headroom} to his ${p.potential} ceiling`, color: '#7fb2ff' };
    if (age >= 31) return { icon: '↘', text: 'Past his peak — likely to decline as he ages', color: '#e8896b' };
    if (headroom <= 1 && age >= 24) return { icon: '◎', text: 'At his ceiling — settled at this level', color: 'var(--muted)' };
    return null;
  })();

  // §2.2 contract negotiation: this player's live renewal talks (pending / countered), best-effort.
  let myOffer: ContractOfferT | null = null;
  try { myOffer = (await api.contractOffers()).offers.find(o => o.playerSlot === slot && (o.status === 'pending' || o.status === 'countered')) ?? null; }
  catch { /* no offers / pre-feature save */ }
  const openTalks = async () => {
    let suggested = p.wage ?? 0;
    try { const pv = await api.renewPreview(slot); suggested = pv.newWage; } catch { /* fall back to current wage */ }
    if (!alive()) return;
    const raw = await promptModal('Open contract talks',
      `Offer ${p.name} a new annual wage (3-year deal). His fair wage is about ${fmtMoney(suggested)} — go higher to land him, lower and he'll likely counter. He replies at the next matchday.`,
      String(suggested), 'Send offer');
    if (raw == null) return;
    const wage = parseMoneyInput(raw);
    if (wage == null) { toast('Enter a valid wage — e.g. 50k or 50000'); return; }
    try { await api.renewOffer(slot, wage, 3); if (!alive()) return; toast('Offer sent — he responds at the next matchday.'); rerender(); }
    catch (e: any) { if (alive()) toast(e.message); }
  };
  const contractControl = (() => {
    if (myOffer && myOffer.status === 'pending') {
      const wd = h('button', { class: 'ghost small' }, 'Withdraw');
      wd.addEventListener('click', async () => { wd.setAttribute('disabled', 'true'); try { await api.withdrawContractOffer(myOffer!.id); if (!alive()) return; toast('Offer withdrawn'); rerender(); } catch (e: any) { if (!alive()) return; toast(e.message); wd.removeAttribute('disabled'); } });
      return h('span', { class: 'row', style: 'gap:6px;align-items:center' },
        h('span', { class: 'pill', title: 'Awaiting his reply at the next matchday', style: 'background:#262d3a' }, `⏳ offered ${fmtMoney(myOffer.wage)}/yr × ${myOffer.years}y`), wd);
    }
    if (myOffer && myOffer.status === 'countered') {
      const cw = myOffer.counterWage ?? myOffer.wage, cy = myOffer.counterYears ?? myOffer.years;
      const m = h('button', { class: 'primary small' }, `Accept ${fmtMoney(cw)}/yr`);
      m.addEventListener('click', async () => { m.setAttribute('disabled', 'true'); try { const r = await api.matchContractOffer(myOffer!.id); if (!alive()) return; toast(`${r.player ?? p.name} re-signed — ${fmtMoney(r.wage!)}/yr × ${r.years}y`); rerender(); } catch (e: any) { if (!alive()) return; toast(e.message); m.removeAttribute('disabled'); } });
      const wd = h('button', { class: 'ghost small', style: 'margin-left:4px' }, 'Walk away');
      wd.addEventListener('click', async () => { wd.setAttribute('disabled', 'true'); try { await api.withdrawContractOffer(myOffer!.id); if (!alive()) return; toast('Talks ended'); rerender(); } catch (e: any) { if (!alive()) return; toast(e.message); wd.removeAttribute('disabled'); } });
      return h('span', { class: 'row', style: 'gap:6px;align-items:center' },
        h('span', { class: 'pill', title: 'His agent countered', style: 'background:#3a2a1f;color:#ffce9a' }, `↩ wants ${fmtMoney(cw)}/yr × ${cy}y`), m, wd);
    }
    const open = h('button', { class: 'ghost small' }, 'Open contract talks');
    // guard the async preview→prompt flow so a double-click can't stack wage-entry modals
    open.addEventListener('click', async () => { if (open.hasAttribute('disabled')) return; open.setAttribute('disabled', 'true'); try { await openTalks(); } finally { open.removeAttribute('disabled'); } });
    return open;
  })();

  const traitsEl = h('div', {});
  const renderTraits = (tr: Record<string, number>) => traitsEl.replaceChildren(...TRAIT_LABELS.map(t => traitBar(t.label, tr?.[t.key] ?? 50)));
  // Don't fabricate eight 50-bars for a player with no personality — that reads as real data.
  // The backstory editor below still works (saving derives the personality), so point there.
  if (p.personality?.traits) renderTraits(p.personality.traits as any);
  else traitsEl.replaceChildren(h('div', { class: 'muted', style: 'font-size:13px;line-height:1.5' },
    'No personality yet — write a backstory below and save to derive these dials, or generate the whole squad’s personalities from the squad screen.'));

  const back = h('textarea', { id: 'f-backstory', class: 'tactics-input', rows: '4', placeholder: 'Backstory — e.g. "A model professional and ice-cool penalty taker who rises on the big occasion."' }, p.personality?.backstory ?? '') as HTMLTextAreaElement;
  const tag = h('input', { id: 'f-tagline', placeholder: 'Tagline (≤6 words, in character)', value: p.personality?.tagline ?? '' }) as HTMLInputElement;
  const valEl = h('span', { class: 'muted', style: 'font-size:12px' });
  const save = h('button', {}, 'Save story & re-derive traits');
  save.addEventListener('click', async () => {
    if (!back.value.trim()) { toast('Write a backstory first'); return; }
    save.setAttribute('disabled', 'true'); save.textContent = 'Re-deriving…';
    try {
      const r = await api.setPlayerStory(slot, back.value.trim(), tag.value.trim());
      renderTraits(r.personality.traits as any);
      valEl.textContent = `Re-derived · value ${fmtMoney(r.value)}`;
      toast('Traits re-derived from the new story');
    } catch (e: any) { toast(e.message); }
    finally { save.removeAttribute('disabled'); save.textContent = 'Save story & re-derive traits'; }
  });

  // §player-interaction: a private 1-to-1 word that moves morale by his personality dials (one per matchday).
  const talkReact = h('div', { style: 'font-size:13px;min-height:18px;margin-top:8px', 'aria-live': 'polite' });
  const talkBtns: HTMLButtonElement[] = [];
  const INTERACT_TONES: { tone: string; label: string; title: string }[] = [
    { tone: 'praise', label: '👏 Praise', title: 'Single him out for his form — lifts most, especially praise-hungry players and big egos.' },
    { tone: 'encourage', label: '💬 Encourage', title: 'A quiet word of belief — a gentle lift for most.' },
    { tone: 'warn', label: '☝️ Have a word', title: 'A measured warning about his standards — mild; the thick-skinned take it well.' },
    { tone: 'criticise', label: '🔥 Criticise', title: 'Tear a strip off him — fires up the thick-skinned, wounds the sensitive and hot-heads.' },
  ];
  const doTalk = async (tone: string, btn: HTMLButtonElement) => {
    talkBtns.forEach(b => b.setAttribute('disabled', 'true'));
    const t0 = btn.textContent; btn.textContent = '…';
    try {
      const r = await api.interactPlayer(slot, tone);
      p.morale = r.morale;   // keep the local copy in step (the header already painted the old value)
      talkReact.replaceChildren(h('span', { class: r.delta > 0 ? 'ok' : r.delta < 0 ? 'warn' : 'muted' },
        `${r.delta > 0 ? '▲ +' + r.delta : r.delta < 0 ? '▼ ' + r.delta : 'no change'} morale · now ${r.morale} — “${r.reaction}”`));
      // one chat per matchday — leave the buttons disabled after a successful word
    } catch (e: any) {
      talkReact.replaceChildren(h('span', { class: 'muted' }, e.message));
      if (!/already had a word/.test(e.message)) talkBtns.forEach(b => b.removeAttribute('disabled'));   // a failed call didn't consume the cooldown
    } finally { btn.textContent = t0; }
  };
  const interactCard = h('div', { class: 'card' },
    h('div', { class: 'section-title', style: 'margin-top:0' }, 'Have a word'),
    h('div', { class: 'muted', style: 'font-size:12px;margin-bottom:8px' }, 'A private word moves his morale — how it lands depends on his personality. One chat per player per matchday.'),
    h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' }, ...INTERACT_TONES.map(it => {
      const b = h('button', { class: 'ghost small', title: it.title }, it.label) as HTMLButtonElement;
      b.addEventListener('click', () => doTalk(it.tone, b));
      talkBtns.push(b); return b;
    })),
    talkReact);

  // §individual-training: shape this player's development from his own page (reuses the training endpoints).
  const pfSel = h('select', { style: 'width:auto;font-size:12px;padding:3px 6px', 'aria-label': 'Training focus' }) as HTMLSelectElement;
  pfSel.append(h('option', { value: '' }, 'Follow club focus'));
  for (const f of TRAINING_FOCI) { const o = h('option', { value: f }, focusLabel(f)) as HTMLOptionElement; if (f === (p.trainFocus ?? '')) o.selected = true; pfSel.append(o); }
  guardSelect(pfSel, async v => { const r = await api.setPlayerTraining(slot, v); p.trainFocus = r.focus ?? undefined; toast(r.focus ? `Focus: ${focusLabel(r.focus)}` : 'Follows the club focus'); return r.focus ?? undefined; }, alive);
  const piSel = h('select', { style: 'width:auto;font-size:12px;padding:3px 6px', 'aria-label': 'Training intensity', title: 'Higher intensity grows faster but raises injury risk; rest recovers' }) as HTMLSelectElement;
  for (const [iv, lbl] of [['normal', 'Normal'], ['double', 'Double ↑'], ['half', 'Light'], ['rest', 'Rest']]) { const o = h('option', { value: iv }, lbl) as HTMLOptionElement; if (iv === (p.trainIntensity ?? 'normal')) o.selected = true; piSel.append(o); }
  guardSelect(piSel, async v => { const r = await api.setPlayerIntensity(slot, v); p.trainIntensity = r.intensity ?? undefined; toast(`Intensity: ${r.intensity ?? 'normal'}`); return r.intensity ?? undefined; }, alive);
  const rtSel = h('select', { style: 'width:auto;font-size:12px;padding:3px 6px', 'aria-label': 'Retrain position', title: 'Retrain him into a new position — he settles in over several matchdays, developing a little slower until comfortable.' }) as HTMLSelectElement;
  rtSel.append(h('option', { value: '' }, `No (stay ${p.role})`));
  for (const role of ['GK', 'FB', 'CB', 'CM', 'WM', 'CF']) { if (role === p.role) continue; const o = h('option', { value: role }, `→ ${role}`) as HTMLOptionElement; if (role === (p.retrainRole ?? '')) o.selected = true; rtSel.append(o); }
  guardSelect(rtSel, async v => { const r = await api.setPlayerRetrain(slot, v || 'clear'); if (!alive()) return; toast(r.retrainRole ? `Retraining → ${r.retrainRole}` : `Settled at ${p.role}`); rerender(); return r.retrainRole ?? undefined; }, alive);
  const devCard = h('div', { class: 'card' },
    h('div', { class: 'section-title', style: 'margin-top:0' }, 'Development'),
    h('div', { class: 'muted', style: 'font-size:12px;margin-bottom:8px' }, 'His individual training — a focus grows one area faster, intensity trades growth for injury risk, and you can retrain him into a new position.'),
    h('div', { class: 'row', style: 'gap:14px;flex-wrap:wrap;align-items:center' },
      h('label', { class: 'row', style: 'gap:5px;align-items:center;font-size:12px' }, h('span', { class: 'muted' }, 'Focus'), pfSel),
      h('label', { class: 'row', style: 'gap:5px;align-items:center;font-size:12px' }, h('span', { class: 'muted' }, 'Intensity'), piSel),
      h('label', { class: 'row', style: 'gap:5px;align-items:center;font-size:12px' }, h('span', { class: 'muted' }, 'Retrain'), rtSel)));

  // §player-stats: this season's contribution (goals/assists/apps/avg-rating, tallied from every fixture's
  // --summary in leaders.ts) + a career table archived per season. The season figures live on the player
  // payload now; the career rows load async (empty until his first season completes at rollover).
  const seasonAvg = (p.seasonApps ?? 0) > 0 ? (p.seasonRatingSum ?? 0) / (p.seasonApps ?? 1) : null;
  const statTile = (label: string, val: string, big = false) => h('div', { style: 'min-width:64px;text-align:center' },
    h('div', { style: `font-size:${big ? 22 : 20}px;font-weight:800;font-variant-numeric:tabular-nums` }, val),
    h('div', { class: 'muted', style: 'font-size:11px' }, label));
  const careerBody = h('div', { class: 'muted', style: 'font-size:12px' }, 'Loading career…');
  const statsCard = h('div', { class: 'card' },
    h('div', { class: 'section-title', style: 'margin-top:0' }, 'This season'),
    h('div', { class: 'row', style: 'gap:20px;flex-wrap:wrap' },
      statTile('Apps', String(p.seasonApps ?? 0)),
      statTile('Goals', String(p.seasonGoals ?? 0)),
      statTile('Assists', String(p.seasonAssists ?? 0)),
      statTile('Avg rating', seasonAvg != null ? seasonAvg.toFixed(1) : '—', true)),
    h('div', { class: 'section-title' }, 'Career'),
    careerBody);
  // load the career table into its placeholder (kept out of the initial mount so the profile paints fast)
  api.playerCareer(slot).then(r => {
    if (!alive()) return;
    if (!r.career.length) { careerBody.replaceChildren(h('div', { class: 'muted', style: 'font-size:12px' }, 'No completed seasons yet — his career table fills in at the end of each season.')); return; }
    const th = (t: string, left = false) => h('th', { style: `text-align:${left ? 'left' : 'right'};padding:3px 8px;font-size:11px;font-weight:600;color:var(--muted)` }, t);
    const td = (v: string, left = false, style = '') => h('td', { style: `text-align:${left ? 'left' : 'right'};padding:3px 8px;font-size:13px;font-variant-numeric:tabular-nums;${style}` }, v);
    // career totals across the archived seasons (weighted average rating by apps)
    const tot = r.career.reduce((a, s) => ({ apps: a.apps + s.apps, goals: a.goals + s.goals, assists: a.assists + s.assists, ratedApps: a.ratedApps + (s.avgRating > 0 ? s.apps : 0), ratingSum: a.ratingSum + s.avgRating * s.apps }), { apps: 0, goals: 0, assists: 0, ratedApps: 0, ratingSum: 0 });
    const totAvg = tot.ratedApps > 0 ? (tot.ratingSum / tot.ratedApps).toFixed(1) : '—';
    careerBody.replaceChildren(h('div', { style: 'overflow-x:auto' }, h('table', { style: 'width:100%;border-collapse:collapse' },
      h('thead', {}, h('tr', { style: 'border-bottom:1px solid var(--line)' }, th('Season', true), th('Club', true), th('Apps'), th('Goals'), th('Assists'), th('Avg'))),
      h('tbody', {},
        ...r.career.map((s: PlayerSeasonStatT) => h('tr', { style: 'border-bottom:1px solid var(--line)' },
          td(`S${s.season}`, true), td(s.club, true, 'color:var(--muted)'), td(String(s.apps)), td(String(s.goals)), td(String(s.assists)), td(s.avgRating > 0 ? s.avgRating.toFixed(1) : '—'))),
        r.career.length > 1 ? h('tr', { style: 'font-weight:700' }, td('Total', true), td('', true), td(String(tot.apps)), td(String(tot.goals)), td(String(tot.assists)), td(totAvg)) : ''))));
  }).catch(() => { if (alive()) careerBody.replaceChildren(h('div', { class: 'muted', style: 'font-size:12px' }, 'Career history unavailable.')); });

  // §attr-progression: the Development graph — an attribute (or overall) plotted over every matchday the
  // squad trained (attr_snapshots, one point per developed matchday). Loads async; needs ≥2 points to draw.
  const progBody = h('div', { class: 'muted', style: 'font-size:12px' }, 'Loading development…');
  const progressionCard = h('div', { class: 'card' },
    h('div', { class: 'section-title', style: 'margin-top:0' }, 'Development graph'), progBody);
  api.playerProgression(slot).then(r => {
    if (!alive()) return;
    const snaps = r.progression;
    if (snaps.length < 2) { progBody.replaceChildren(h('div', { class: 'muted', style: 'font-size:12px' }, 'Not enough history yet — his line fills in as the squad trains each matchday.')); return; }
    const series = [{ key: 'ovr', label: 'Overall' }, ...SQUAD_ATTRS.map(([k, abbr]) => ({ key: k, label: abbr }))];
    const sel = h('select', { style: 'width:auto;font-size:12px;padding:3px 6px', 'aria-label': 'Attribute to graph' }, ...series.map(s => h('option', { value: s.key }, s.label))) as HTMLSelectElement;
    const chartHost = h('div', {});
    const valAt = (snap: typeof snaps[number], key: string): number => key === 'ovr' ? snap.ovr : Math.round(snap.attrs[key] ?? 0);
    const drawChart = () => {
      const key = sel.value, label = series.find(s => s.key === key)?.label ?? key;
      const vals = snaps.map(s => valAt(s, key));
      const lo = Math.max(0, Math.min(...vals) - 2), hi = Math.min(99, Math.max(...vals) + 2);
      const CW = 320, CH = 90, pad = 8;
      const px = (i: number) => pad + (i / (snaps.length - 1)) * (CW - 2 * pad);
      const py = (v: number) => (CH - pad) - ((v - lo) / Math.max(1, hi - lo)) * (CH - 2 * pad);
      const pts = vals.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ');
      const svg = svgEl('svg', { viewBox: `0 0 ${CW} ${CH}`, width: '100%', style: 'display:block;overflow:visible;max-width:620px;margin:0 auto' },
        svgEl('polyline', { points: pts, fill: 'none', stroke: 'var(--accent,#4ea1ff)', 'stroke-width': 2, 'stroke-linejoin': 'round' }),
        svgEl('circle', { cx: String(px(snaps.length - 1)), cy: String(py(vals[vals.length - 1])), r: '3', fill: 'var(--accent,#4ea1ff)' }));
      const delta = vals[vals.length - 1] - vals[0];
      chartHost.replaceChildren(
        h('div', { style: 'display:flex;justify-content:space-between;align-items:baseline;font-size:11px;margin-bottom:3px' },
          h('span', { class: 'muted' }, `S${snaps[0].season} R${snaps[0].round}`),
          h('span', { style: `font-weight:700;color:${delta > 0 ? 'var(--accent)' : delta < 0 ? '#e8896b' : 'var(--muted)'}` }, `${label} ${vals[vals.length - 1]}${delta !== 0 ? ` (${delta > 0 ? '+' : ''}${delta})` : ''}`),
          h('span', { class: 'muted' }, `S${snaps[snaps.length - 1].season} R${snaps[snaps.length - 1].round}`)),
        svg);
    };
    sel.addEventListener('change', drawChart);
    progBody.replaceChildren(
      h('div', { class: 'row', style: 'gap:8px;align-items:center;margin-bottom:6px' }, h('span', { class: 'muted', style: 'font-size:12px' }, 'Track'), sel,
        h('span', { class: 'muted', style: 'font-size:11px' }, `· ${snaps.length} matchdays`)),
      chartHost);
    drawChart();
  }).catch(() => { if (alive()) progBody.replaceChildren(h('div', { class: 'muted', style: 'font-size:12px' }, 'Development history unavailable.')); });

  if (!alive()) return;
  mount(header(), h('div', { class: 'wrap grid' },
    h('div', { class: 'between' },
      h('div', {}, h('h2', {}, p.name),
        h('div', { class: 'muted' }, `${p.role} · OVR ${ovr}${p.potential && p.potential > ovr ? ` → ${p.potential}` : ''}${p.age != null ? ` · ${p.age}y` : ''} · ${footLabel(p.foot)}${p.nationality ? ` · ${flagOf(p.nationality)} ${nationNameOf(p.nationality) || p.personality?.nationality || ''}`.trimEnd() : (p.personality?.nationality ? ` · ${p.personality.nationality}` : '')}`),
        p.wage != null ? h('div', { class: 'row', style: 'align-items:center;gap:10px;font-size:12px' },
          h('span', { class: 'muted' }, `Wage ${fmtMoney(p.wage)}/yr · ${p.contractYears ?? 0}y left`),
          (team.wageBudget != null && team.wageBill != null)   // §1.15: club wage headroom, so a renewal isn't a blind 400
            ? h('span', { class: 'muted', style: team.wageBudget - team.wageBill < 0 ? 'color:var(--danger)' : '' }, `· club headroom ${fmtMoney(team.wageBudget - team.wageBill)}/yr`) : '',
          contractControl) : '',
        (p.injuredMatches ?? 0) > 0
          ? h('div', { style: 'font-size:12px;color:#e8896b' }, `🤕 Injured — out ${p.injuredMatches} match${(p.injuredMatches ?? 0) > 1 ? 'es' : ''}${p.morale != null ? ` · Morale ${p.morale}` : ''}`)
          : h('div', { class: 'muted', style: 'font-size:12px' }, `Match fitness ${p.fitness ?? 100}%${p.morale != null ? ` · Morale ${p.morale}` : ''}`),
        // Development state (focus / intensity / retraining) + a "seeking a move" flag — both were only
        // visible on other screens; the profile is where a manager reads a single player, so surface them here.
        trainingSummary(p) ? h('div', { class: 'muted', style: 'font-size:12px' }, `🎯 ${trainingSummary(p)}`) : '',
        devOutlook ? h('div', { class: 'muted', style: `font-size:12px;color:${devOutlook.color}` }, `${devOutlook.icon} ${devOutlook.text}`) : '',
        seekingMove(p) ? h('div', { style: 'font-size:12px;margin-top:2px' },
          h('span', { class: 'pill', title: 'Running down his contract and unsettled — likely to push for a move', style: 'background:var(--danger);color:#fff;font-size:9px' }, 'seeking a move')) : ''),
      h('button', { class: 'ghost', onclick: () => goBack() }, '← Back'),
    ),
    h('div', { class: 'grid cols-2', style: 'align-items:start' },
      h('div', { class: 'card' },
        h('div', { class: 'between', style: 'align-items:baseline' },
          h('div', { class: 'section-title', style: 'margin-top:0' }, 'Attributes'),
          sameRole.length > 1 ? h('span', { class: 'muted', style: 'font-size:11px' }, `± vs your ${sameRole.length} ${p.role}s` ) : ''),
        h('div', { class: 'grid cols-2', style: 'gap:0 22px' },
          ...(p.role === 'GK' ? [...ATTR_LABELS, { key: 'handling', label: 'Handling' }] : ATTR_LABELS).map(a => {
            const v = p.attrs[a.key] ?? 0;
            // delta vs the squad average for this position — "is he a strong CB for MY squad?" (FM's role context)
            const dRaw = sameRole.length > 1 ? Math.round(v - roleAvg(a.key)) : null;
            const note = dRaw != null
              ? h('span', { style: `font-size:10px;margin-left:6px;color:${dRaw > 0 ? 'var(--accent)' : dRaw < 0 ? '#e8896b' : 'var(--muted)'}` }, `${dRaw > 0 ? '+' : ''}${dRaw}`)
              : undefined;
            return traitBar(a.label, v, attrTierColor(v), note);
          })),
      ),
      interactCard),
    statsCard,
    progressionCard,
    devCard,
    h('div', { class: 'grid cols-2', style: 'align-items:start' },
      subcard('Personality dials', traitsEl),
      h('div', { class: 'card' },
        h('div', { class: 'section-title', style: 'margin-top:0' }, 'Backstory'),
        h('div', { class: 'muted', style: 'font-size:12px;margin-bottom:8px' }, 'These dials are read off the backstory — and the player’s training rate and transfer value read the dials. Rewrite the story and the numbers re-derive.'),
        h('div', { class: 'field' }, h('label', { for: 'f-backstory' }, 'Backstory'), back),
        h('div', { class: 'field' }, h('label', { for: 'f-tagline' }, 'Tagline'), tag),
        h('div', { class: 'row', style: 'align-items:center;gap:10px' }, save, valEl),
      ),
    ),
  ));
}
