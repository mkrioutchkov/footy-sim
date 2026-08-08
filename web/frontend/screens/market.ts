// ── transfer market ── extracted from app.ts (Round: appts-audit, pass 3): the largest screen the router
// still carried — free agents, your squad's listings/loans, club-to-club bids, the shortlist and both offer
// books. Every piece of its state lives in screenMarket's closure, so nothing had to move to ui/shell.ts.

import { api, type MarketT, type OfferT, type IncomingOfferT, type FreeAgentOfferT } from '../api.ts';
import { h, clickable } from '../ui/dom.ts';
import { fmtMoney, parseMoneyInput } from '../ui/format.ts';
import { root, mount, toast, screenGuard } from '../ui/shell.ts';
import { errMessage, loadingState, errorState, partialFailure, scrollRegion, responsiveTable } from '../ui/states.ts';
import { confirmModal, promptModal } from '../ui/modal.ts';
import { header } from '../ui/nav.ts';
import { screenCreateTeam } from './create-team.ts';

// ── transfer market ──
export async function screenMarket() {
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, loadingState('Loading the transfer market…')));
  let market: MarketT;
  try { market = await api.market(); }
  catch (e: any) {
    if (!alive()) return;
    if (String(e.message).includes('no team')) return screenCreateTeam();
    return mount(header(), h('div', { class: 'wrap' }, errorState({ title: 'Couldn’t load the market', detail: errMessage(e), onRetry: () => screenMarket(), back: 'dashboard' })));
  }
  // The four side panels are INDEPENDENT + optional — fetch them in PARALLEL (was four serial round-trips, so
  // time-to-interactive was the SUM not the max) and keep each panel's FAILURE distinct from genuinely-empty,
  // so a transient error surfaces a retry note instead of a silently-empty panel.
  let offers: OfferT[] = [], incoming: IncomingOfferT[] = [], faOffers: FreeAgentOfferT[] = [];
  let shortlist: import('../api').ShortlistRowT[] = [];
  let shortIds = new Set<number>();
  const failed = { offers: false, incoming: false, faOffers: false, shortlist: false };
  const [offR, incR, faR, shR] = await Promise.allSettled([api.offers(), api.incomingOffers(), api.freeAgentOffers(), api.shortlist()]);
  if (!alive()) return;
  if (offR.status === 'fulfilled') offers = offR.value.offers; else failed.offers = true;
  if (incR.status === 'fulfilled') incoming = incR.value.incoming; else failed.incoming = true;
  if (faR.status === 'fulfilled') faOffers = faR.value.offers; else failed.faOffers = true;
  if (shR.status === 'fulfilled') { shortlist = shR.value.shortlist; shortIds = new Set(shR.value.ids); } else failed.shortlist = true;
  const refreshOffers = async (): Promise<void> => { try { offers = (await api.offers()).offers; failed.offers = false; } catch { /* keep current */ } };
  const toggleStar = async (playerId: number) => {
    const add = !shortIds.has(playerId);
    try { const s = await api.toggleShortlist(playerId, add); shortlist = s.shortlist; shortIds = new Set(s.ids); toast(add ? '★ Added to your shortlist' : 'Removed from shortlist'); render(); }
    catch (e: any) { toast(e.message); }
  };

  function render() {
    // Preserve scroll across the full re-render each action triggers (signing/listing/bidding
    // otherwise jumps every list back to the top). Capture the current panes before mount, restore after.
    const scrollPos: Record<string, number> = {};
    root.querySelectorAll<HTMLElement>('[data-scroll]').forEach(el => { if (el.dataset.scroll) scrollPos[el.dataset.scroll] = el.scrollTop; });
    const winY = window.scrollY;

    // free-agent pool — sign to your squad
    const faBody = h('tbody');
    if (!market.freeAgents.length) faBody.append(h('tr', {}, h('td', { colspan: '7', class: 'muted' }, 'No free agents left.')));
    const wageHeadroom = market.wageBudget - market.wageBill;
    const moneyCell = (value: number, wage: number) => h('td', { class: 'num' }, fmtMoney(value),
      h('div', { class: 'muted', style: 'font-size:10px' }, `${fmtMoney(wage)}/yr`));
    const faPending = new Map(faOffers.map(o => [o.agentId, o]));
    for (const a of market.freeAgents) {
      const afford = market.budget >= a.value, room = market.squad.length < market.squadMax, wageOk = a.wage <= wageHeadroom;
      const live = faPending.get(a.id);
      // §2.1: a free agent now CONSIDERS a wage offer rather than signing on the spot — he answers next matchday.
      const sign = live
        ? h('span', { class: 'pill', title: `Awaiting his reply at the next matchday`, style: 'background:#262d3a;font-size:11px' }, `⏳ ${fmtMoney(live.wage)}/yr × ${live.years}y`)
        : h('button', { class: 'ghost small' }, 'Make offer');
      if (!live) {
        if (!afford || !room) sign.setAttribute('disabled', 'true');
        else if (!wageOk) sign.setAttribute('title', 'His wage is over your budget — you can still try a lower offer');
        sign.addEventListener('click', async () => {
          const raw = await promptModal(`Offer ${a.name} terms`,
            `Offer ${a.name} (${a.role}, ${a.age}) an annual wage on a 3-year deal. He wants about ${fmtMoney(a.wage)} — match or beat it and he'll sign; lowball him and he'll walk. There's a ${fmtMoney(a.value)} signing-on fee. He decides at the next matchday.`,
            String(a.wage), 'Make offer');
          if (raw == null) return;
          const wage = parseMoneyInput(raw);
          if (wage == null) { toast('Enter a valid wage — e.g. 50k or 50000'); return; }
          try { const r = await api.offerFreeAgent(a.id, wage, 3); market = r.market; faOffers = r.faOffers; toast(`Offer made to ${r.player} — he decides at the next matchday.`); render(); }
          catch (e: any) { toast(e.message); render(); }
        });
      }
      const faPot = a.potential != null && a.potential > a.overall;
      faBody.append(h('tr', {},
        h('td', {}, a.name),
        h('td', {}, h('span', { class: 'pill' }, a.role)),
        h('td', { class: 'num' }, String(a.age)),
        h('td', { class: 'num' }, String(a.overall)),
        h('td', { class: 'num' }, faPot ? h('span', { class: 'a' }, String(a.potential)) : (a.potential != null ? String(a.potential) : '—')),
        moneyCell(a.value, a.wage),
        h('td', { class: 'num' }, sign)));
    }

    // your squad — transfer-list for sale (or pull the listing)
    const sqBody = h('tbody');
    for (const p of market.squad) {
      const canSell = market.squad.length > market.squadMin;
      let btn: HTMLElement;
      if (p.onLoan) {
        // §2.12: a loaned-in player can be sent back to his parent early (frees the slot + wage)
        btn = h('button', { class: 'ghost small' }, 'End loan');
        if (market.squad.length <= market.squadMin) { btn.setAttribute('disabled', 'true'); btn.setAttribute('title', `can't drop below ${market.squadMin} players`); }
        else btn.addEventListener('click', async () => {
          if (!await confirmModal('End loan', `Send ${p.name} back to ${p.loanFrom ?? 'his parent club'} now? You'll free his squad slot and wages, ahead of the season-end return.`, 'Send back')) return;
          btn.setAttribute('disabled', 'true'); btn.textContent = '…';
          try { const r = await api.endLoan(p.slot); market = r.market; toast(`${r.player} sent back to ${r.from}`); render(); }
          catch (e: any) { toast(e.message); render(); }
        });
      } else {
        btn = p.listed ? h('button', { class: 'ghost small' }, 'Unlist') : h('button', { class: 'ghost small' }, 'List');
        if (!p.listed && !canSell) btn.setAttribute('disabled', 'true');
        btn.addEventListener('click', async () => {
          btn.setAttribute('disabled', 'true'); btn.textContent = '…';
          try {
            const r = p.listed ? await api.unlistPlayer(p.slot) : await api.listPlayer(p.slot);
            market = r.market; toast(p.listed ? `${p.name} taken off the market` : `${p.name} listed for ${fmtMoney((r as any).askPrice)}`); render();
          } catch (e: any) { toast(e.message); render(); }
        });
      }
      // §loan-out: an owned (not loaned-in) player can be sent out on loan for the season while a window is
      // open + you can spare him — the outbound mirror of the inbound loan on the targets table below.
      let loanOutBtn: HTMLElement | string = '';
      if (!p.onLoan && market.window.open && canSell) {
        const lo = h('button', { class: 'ghost small', title: 'Loan him out to a club that needs him for the season — frees his wages; he returns at season end' }, 'Loan out');
        lo.addEventListener('click', async () => {
          if (!await confirmModal('Loan out', `Send ${p.name} out on loan for the season? A club short in his position takes him on — you free his wages and he returns at the end of the campaign.`, 'Loan out')) return;
          lo.setAttribute('disabled', 'true'); lo.textContent = '…';
          try { const r = await api.loanOut(p.slot); market = r.market; toast(`${r.player} joins ${r.from} on loan`); render(); }
          catch (e: any) { toast(e.message); render(); }
        });
        loanOutBtn = lo;
      }
      const sqPot = p.potential != null && p.potential > p.overall;
      sqBody.append(h('tr', {},
        h('td', {}, p.name, p.onLoan ? h('span', { class: 'pill', style: 'margin-left:6px', title: `on loan from ${p.loanFrom ?? 'another club'}${p.loanUntil != null ? ` until end of S${p.loanUntil}` : ''}` }, `loan: ${p.loanFrom ?? '?'}`) : (p.starter ? '' : h('span', { class: 'muted', style: 'font-size:11px' }, ' · bench')),
          p.listed ? h('span', { class: 'pill', style: 'margin-left:6px' }, p.askPrice != null ? fmtMoney(p.askPrice) : 'listed') : ''),
        h('td', {}, h('span', { class: 'pill' }, p.role)),
        h('td', { class: 'num' }, String(p.age)),
        h('td', { class: 'num' }, String(p.overall)),
        h('td', { class: 'num' }, sqPot ? h('span', { class: 'a' }, String(p.potential)) : (p.potential != null ? String(p.potential) : '—')),
        moneyCell(p.value, p.wage),
        h('td', { class: 'num' }, h('div', { style: 'display:flex;gap:5px;justify-content:flex-end;flex-wrap:wrap' }, btn, loanOutBtn))));
    }

    const headRow = (label: string) => h('thead', {}, h('tr', {},
      h('th', {}, label), h('th', {}, 'Pos'),
      h('th', { class: 'num' }, 'Age'), h('th', { class: 'num' }, 'OVR'), h('th', { class: 'num' }, 'POT'),
      h('th', { class: 'num' }, 'Fee/Wage'), h('th', { class: 'num' }, '')));

    // ── club-to-club transfers: bid for a listed player at another club, with negotiation ──
    const win = market.window;
    const sendBid = async (playerId: number, fee: number): Promise<void> => {
      try {
        const r = await api.bid(playerId, fee);
        // A bid is now a PENDING offer the club resolves next matchday (accept/counter/reject) —
        // see the "Your bids" panel. (accepted can still come back from matching a counter.)
        if (r.status === 'pending') { toast(`Bid lodged with ${r.club} for ${fmtMoney(r.fee!)} — they respond at the next matchday.`); await refreshOffers(); render(); }
        else if (r.status === 'accepted') { market = r.market; toast(`Signed ${r.player} for ${fmtMoney(r.fee!)}`); await refreshOffers(); render(); }
        else { toast(r.error || `${r.club} rejected the bid`); render(); }
      } catch (e: any) { toast(e.message); render(); }
    };
    const doBid = async (t: typeof market.transferTargets[number]): Promise<void> => {
      try { market = await api.market(); } catch { /* keep the cached snapshot */ }   // §1.13: compose the bid against a fresh budget
      const ask = t.askPrice ?? t.value;
      const raw = await promptModal(`Bid for ${t.name}`,
        `${t.club} are asking ${fmtMoney(ask)}. Your budget: ${fmtMoney(market.budget)}.\nEnter a number, or shorthand like 1.5m / 500k.`,
        String(ask), 'Submit bid');
      if (raw == null) return;
      const fee = parseMoneyInput(raw);
      if (fee == null) { toast('Enter a valid bid — e.g. 1.5m, 500k, or 1500000'); return; }
      await sendBid(t.id, fee);   // awaited so the click guard spans the full request, not just the modal
    };
    const doLoan = async (t: typeof market.transferTargets[number]): Promise<void> => {
      if (!await confirmModal('Loan deal', `Take ${t.name} (${t.club}) on loan for the season? He returns to his club at the end of the campaign — no fee, but you carry his wages.`, 'Take on loan')) return;
      try { const r = await api.loan(t.id); market = r.market; toast(`${r.player} joins on loan from ${r.from}`); render(); }
      catch (e: any) { toast(e.message); render(); }
    };
    const tgtBody = h('tbody');
    if (!market.transferTargets.length) tgtBody.append(h('tr', {}, h('td', { colspan: '7', class: 'muted' }, 'No players listed for sale at other clubs.')));
    for (const t of market.transferTargets) {
      const bid = h('button', { class: 'ghost small' }, 'Bid');
      const loan = h('button', { class: 'ghost small', style: 'margin-left:4px' }, 'Loan');
      // §release-clause: an instant, binding buy at the player's clause — bypasses negotiation.
      const clauseBtn = t.releaseClause != null
        ? h('button', { class: 'primary small', style: 'margin-left:4px', title: `Trigger his release clause — an instant signing at ${fmtMoney(t.releaseClause)}` }, 'Buy now')
        : '';
      // Disable the button for the whole action (modal + request) so an impatient re-click on a
      // slow network can't fire a second concurrent bid/loan for the same player — the same guard
      // Sign/List use. render() rebuilds fresh buttons on success; the finally re-enables on cancel.
      const guard = (btn: HTMLElement, fn: () => Promise<void>) => async () => {
        if (btn.hasAttribute('disabled')) return;
        btn.setAttribute('disabled', 'true');
        try { await fn(); } finally { btn.removeAttribute('disabled'); }
      };
      const acts: HTMLElement[] = [bid, loan, ...(clauseBtn instanceof HTMLButtonElement ? [clauseBtn] : [])];
      if (!win.open) { for (const b of acts) { b.setAttribute('disabled', 'true'); b.setAttribute('title', 'Transfer window is shut'); } }
      else {
        bid.addEventListener('click', guard(bid, () => doBid(t)));
        loan.addEventListener('click', guard(loan, () => doLoan(t)));
        if (clauseBtn instanceof HTMLButtonElement) clauseBtn.addEventListener('click', guard(clauseBtn, async () => {
          if (!await confirmModal('Trigger release clause', `Sign ${t.name} from ${t.club} for his release clause of ${fmtMoney(t.releaseClause!)}? This is an instant, binding transfer.`, `Pay ${fmtMoney(t.releaseClause!)}`)) return;
          await sendBid(t.id, t.releaseClause!);
        }));
      }
      const tPot = t.potential != null && t.potential > t.overall;
      const star = h('span', { role: 'button', tabindex: '0', title: shortIds.has(t.id) ? 'On your shortlist — click to remove' : 'Add to your shortlist',
        style: `cursor:pointer;margin-right:5px;${shortIds.has(t.id) ? 'color:var(--gold,#e8b53a)' : 'opacity:.3'}`, ...clickable(() => toggleStar(t.id)) }, '★');
      tgtBody.append(h('tr', {},
        h('td', {}, star, t.name, h('span', { class: 'muted', style: 'font-size:11px' }, ' · ' + t.club),
          t.releaseClause != null ? h('span', { class: 'pill', title: 'Release clause — instantly buyable at this fee', style: 'margin-left:6px;background:rgba(230,57,70,.18);color:#f2a1a8' }, `⚡ ${fmtMoney(t.releaseClause)}`) : ''),
        h('td', {}, h('span', { class: 'pill' }, t.role)),
        h('td', { class: 'num' }, String(t.age)),
        h('td', { class: 'num' }, String(t.overall)),
        h('td', { class: 'num' }, tPot ? h('span', { class: 'a' }, String(t.potential)) : (t.potential != null ? String(t.potential) : '—')),
        moneyCell(t.askPrice ?? t.value, t.wage),
        h('td', { class: 'num' }, h('span', { style: 'display:inline-flex;flex-wrap:wrap;justify-content:flex-end' }, ...acts))));
    }

    // §shortlist: the transfer watchlist — tracked players with their live status + a bid shortcut.
    const shortlistCard = shortlist.length ? h('div', { class: 'card' },
      h('div', { class: 'section-title', style: 'margin-top:0' }, `★ Your shortlist (${shortlist.length})`),
      h('div', { class: 'muted', style: 'margin:-6px 0 8px;font-size:12px' }, 'Players you’re tracking across the world — status updates as the market moves. ★ a target below to add one.'),
      ...shortlist.map(s => h('div', { class: 'between', style: 'font-size:13px;padding:4px 0;border-top:1px solid var(--line)' },
        h('span', {},
          h('span', { role: 'button', tabindex: '0', title: 'Remove from shortlist', style: 'cursor:pointer;color:var(--gold,#e8b53a);margin-right:6px', ...clickable(() => toggleStar(s.id)) }, '★'),
          h('span', { style: 'font-weight:600' }, s.name),
          h('span', { class: 'muted', style: 'font-size:11px' }, ` ${s.role} · ${s.age}y · ${s.club}`),
          s.mine ? h('span', { class: 'pill', style: 'margin-left:6px' }, 'in your squad') : '',
          s.onLoan ? h('span', { class: 'pill', style: 'margin-left:6px' }, 'on loan') : '',
          s.listed ? h('span', { class: 'pill', style: 'margin-left:6px;background:rgba(67,211,158,.15);color:var(--accent)' }, 'listed') : '',
          s.releaseClause != null ? h('span', { class: 'pill', title: 'Release clause', style: 'margin-left:6px;background:rgba(230,57,70,.18);color:#f2a1a8' }, `⚡ ${fmtMoney(s.releaseClause)}`) : ''),
        h('span', { class: 'row', style: 'gap:10px;align-items:center' },
          h('span', { class: 'muted', style: 'font-size:12px' }, `OVR ${s.overall} · ${fmtMoney(s.value)}`),
          (win.open && !s.mine && !s.onLoan)
            ? (() => { const b = h('button', { class: 'ghost small' }, 'Bid'); b.addEventListener('click', () => doBid({ id: s.id, name: s.name, club: s.club, clubTeamId: 0, role: s.role, age: s.age, overall: s.overall, potential: null, value: s.value, askPrice: null, releaseClause: s.releaseClause, wage: 0 })); return b; })()
            : ''))))
      : '';

    const wagePct = market.wageBudget > 0 ? Math.round((market.wageBill / market.wageBudget) * 100) : 0;

    // §2.1: your outstanding bids — pending (awaiting the club's reply at the next matchday),
    // countered (match their price or withdraw), or recently resolved.
    const offerLabel: Record<string, string> = { pending: '⏳ awaiting reply', countered: '↩ countered', accepted: '✅ signed', rejected: '✖ rejected' };
    const offerGuard = (btn: HTMLElement, fn: () => Promise<void>) => async () => { if (btn.hasAttribute('disabled')) return; btn.setAttribute('disabled', 'true'); try { await fn(); } finally { btn.removeAttribute('disabled'); } };
    const offerRow = (o: OfferT) => {
      const acts: (HTMLElement | string)[] = [];
      if (o.status === 'countered') {
        const m = h('button', { class: 'primary small' }, `Match ${fmtMoney(o.counterFee ?? o.fee)}`);
        m.addEventListener('click', offerGuard(m, async () => {
          if (!await confirmModal('Match their price?', `Pay ${fmtMoney(o.counterFee ?? o.fee)} to complete this signing? This commits club funds now.`, `Pay ${fmtMoney(o.counterFee ?? o.fee)}`)) return;
          try { const r = await api.matchOffer(o.id); if (r.status === 'accepted') { market = r.market; toast(`Signed ${r.player} for ${fmtMoney(r.fee!)}`); } offers = r.offers; render(); }
          catch (e: any) { toast(e.message); await refreshOffers(); render(); }
        }));
        acts.push(m);
      }
      if (o.status === 'pending' || o.status === 'countered') {
        const w = h('button', { class: 'ghost small', style: 'margin-left:4px' }, 'Withdraw');
        w.addEventListener('click', offerGuard(w, async () => { try { const r = await api.withdrawOffer(o.id); offers = r.offers; render(); } catch (e: any) { toast(e.message); } }));
        acts.push(w);
      }
      return h('tr', {},
        h('td', {}, o.playerName, h('span', { class: 'muted', style: 'font-size:11px' }, ' · ' + o.club)),
        h('td', { class: 'num' }, fmtMoney(o.fee)),
        h('td', {}, offerLabel[o.status] ?? o.status, o.status === 'countered' && o.counterFee != null ? h('span', { class: 'muted', style: 'font-size:11px' }, ` · they want ${fmtMoney(o.counterFee)}`) : ''),
        h('td', { class: 'num' }, ...acts));
    };
    const offersCard = offers.length
      ? h('div', { class: 'card' }, h('div', { class: 'section-title', style: 'margin-top:0' }, 'Your bids'), h('table', {}, ...offers.map(offerRow)))
      : '';

    // §2.1 incoming bids — other clubs want YOUR listed players; accept (sell) or reject.
    const incLabel: Record<string, string> = { pending: '⏳ awaiting your reply', accepted: '✅ sold', rejected: '✖ rejected' };
    const incRow = (o: IncomingOfferT) => {
      const acts: (HTMLElement | string)[] = [];
      if (o.status === 'pending') {
        const acc = h('button', { class: 'primary small' }, `Accept ${fmtMoney(o.fee)}`);
        acc.addEventListener('click', offerGuard(acc, async () => {
          if (!await confirmModal('Sell player?', `Accept the ${fmtMoney(o.fee)} bid for ${o.playerName}? This is a binding, irreversible sale.`, 'Sell', 'danger')) return;
          try { const r = await api.acceptOffer(o.id); market = r.market; incoming = r.incoming; toast(`Sold ${o.playerName} to ${r.club} for ${fmtMoney(r.fee!)}`); render(); }
          catch (e: any) { toast(e.message); try { incoming = (await api.incomingOffers()).incoming; } catch { /* keep */ } render(); }
        }));
        const rej = h('button', { class: 'ghost small', style: 'margin-left:4px' }, 'Reject');
        rej.addEventListener('click', offerGuard(rej, async () => { try { const r = await api.rejectOffer(o.id); incoming = r.incoming; render(); } catch (e: any) { toast(e.message); try { incoming = (await api.incomingOffers()).incoming; } catch { /* keep */ } render(); } }));
        acts.push(acc, rej);
      }
      return h('tr', {},
        h('td', {}, o.playerName, o.playerSlot != null ? h('span', { class: 'muted', style: 'font-size:11px' }, ` · slot ${o.playerSlot}`) : ''),
        h('td', {}, h('span', { class: 'muted', style: 'font-size:12px' }, o.club)),
        h('td', { class: 'num' }, fmtMoney(o.fee)),
        h('td', {}, incLabel[o.status] ?? o.status),
        h('td', { class: 'num' }, ...acts));
    };
    const incomingCard = incoming.length
      ? h('div', { class: 'card', style: 'border-left:3px solid var(--accent,#4ea1ff)' },
          h('div', { class: 'section-title', style: 'margin-top:0' }, '📥 Bids for your players'),
          h('div', { class: 'muted', style: 'margin:-6px 0 8px;font-size:12px' }, 'Other clubs are bidding for players you listed — accept to sell, or reject.'),
          h('table', {}, ...incoming.map(incRow)))
      : '';

    if (!alive()) return;
    mount(header(), h('div', { class: 'wrap grid' },
      h('div', { class: 'between' },
        h('div', {}, h('h2', {}, 'Transfer market'),
          h('div', { class: 'muted' }, `Budget ${fmtMoney(market.budget)} · wages ${fmtMoney(market.wageBill)}/${fmtMoney(market.wageBudget)} (${wagePct}%) · squad ${market.squad.length}/${market.squadMax}`)),
        h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, '← Back'),
      ),
      // §1.6: a panel that FAILED to load (vs genuinely empty) gets a visible retry, not a silent blank.
      (failed.offers || failed.incoming || failed.faOffers || failed.shortlist)
        ? partialFailure('some transfer panels', () => screenMarket())
        : '',
      h('div', { class: 'card', style: `padding:8px 12px;${win.open ? (win.deadlineDay ? 'border-left:3px solid var(--danger)' : 'border-left:3px solid var(--accent,#4ea1ff)') : 'opacity:.8'}` },
        h('span', { style: win.open ? 'font-weight:600' : '' }, (win.deadlineDay ? '🚨 ' : win.open ? '🟢 ' : '🔒 ') + win.label),
        // §2.4: deadline-day urgency — count down the matchdays left in the window
        win.open ? h('span', { style: `margin-left:8px;font-size:12px;font-weight:600;color:${win.deadlineDay ? 'var(--danger)' : 'var(--accent)'}` },
          win.deadlineDay ? '· 🚨 Deadline day — shuts after this matchday' : `· closes in ${win.closesIn} matchday${win.closesIn === 1 ? '' : 's'}`) : '',
        h('span', { class: 'muted', style: 'margin-left:8px;font-size:12px' }, 'Free agents can be signed any time; club-to-club deals need an open window.')),
      market.backing ? h('div', { class: 'card', style: 'padding:8px 12px' },
        h('span', { class: 'muted', style: 'font-size:12px' }, `🏛️ ${market.backing}`)) : '',
      // Free agents + Your squad are FULL-WIDTH (was a 2-col grid that clipped the action buttons — "Make
      // offer" / "List" / "Loan out" — off the narrow column edge). Full width keeps every action visible.
      h('div', { class: 'card' },
        h('div', { class: 'section-title', style: 'margin-top:0' }, 'Free agents',
          h('span', { class: 'pill', style: 'margin-left:8px;text-transform:none;letter-spacing:0;background:rgba(67,211,158,.15);color:var(--accent)' }, 'signable any time')),
        scrollRegion('Free agents', responsiveTable(headRow('Player'), faBody), { maxH: '520px', dataScroll: 'fa', sticky: true })),
      h('div', { class: 'card' },
        h('div', { class: 'section-title', style: 'margin-top:0' }, 'Your squad'),
        h('div', { class: 'muted', style: 'margin:-6px 0 8px;font-size:12px' }, `List a player to sell him — an AI club may buy once you have squad depth (12+).${win.open ? ' Listings lapse at the deadline if unsold.' : ''}`),
        scrollRegion('Your squad', responsiveTable(headRow('Player'), sqBody), { maxH: '520px', dataScroll: 'squad', sticky: true })),
      incomingCard,
      offersCard,
      h('div', { class: 'card' },
        h('div', { class: 'section-title', style: 'margin-top:0' }, 'For sale — other clubs',
          win.open ? '' : h('span', { class: 'pill', style: 'margin-left:8px;text-transform:none;letter-spacing:0;background:#3a2a1f;color:#ffce9a' }, '🔒 window shut')),
        h('div', { class: 'muted', style: 'margin:-6px 0 8px;font-size:12px' }, win.open ? 'Bid for a listed player — the club may accept, counter, or reject.' : 'Bidding opens during a transfer window.'),
        scrollRegion('For sale — other clubs', responsiveTable(headRow('Player'), tgtBody), { maxH: '420px', dataScroll: 'targets', sticky: true })),
      shortlistCard,
    ));

    // Restore the captured scroll positions onto the freshly-mounted panes.
    root.querySelectorAll<HTMLElement>('[data-scroll]').forEach(el => {
      const v = el.dataset.scroll ? scrollPos[el.dataset.scroll] : undefined;
      if (typeof v === 'number') el.scrollTop = v;
    });
    window.scrollTo(0, winY);
  }
  render();
}
