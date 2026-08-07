// routes/market.ts — the transfer market: free agents, listings, club-to-club bids, loans
// (in / out / early end), free-agent terms, outgoing + incoming offers. Split out of index.ts
// (its '── transfer market (pillar 1) ──' section).
import type { FastifyInstance } from 'fastify';
import { getMarket, buyFreeAgent, listPlayer, unlistPlayer, bidForPlayer, loanIn, loanOut, endLoan, offersForTeam, withdrawOffer, matchCounter, incomingOffersForTeam, acceptIncomingOffer, rejectIncomingOffer, offerToFreeAgent, freeAgentOffersForTeam } from '../market.ts';
import { getObjective } from '../objectives.ts';
import { getConfidence, recruitmentBacking } from '../confidence.ts';
import { requireTeam, idParam, optionalIdParam } from './shared.ts';

export function registerMarketRoutes(app: FastifyInstance): void {
  // ── transfer market (pillar 1) ──
  app.get('/api/market', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const market = getMarket(teamId);
    if (!market) return reply.code(404).send({ error: 'no team' });
    // how the board frames recruitment (confidence + objective) — pure framing, never a budget change
    const conf = getConfidence(teamId), obj = getObjective(teamId);
    return { ...market, backing: conf ? recruitmentBacking(conf.status, obj?.kind ?? null) : null };
  });

  app.post('/api/market/buy', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const agentId = idParam(reply, req.body?.agentId, 'agentId'); if (agentId == null) return;
    const r = buyFreeAgent(teamId, agentId);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return { ...r, market: getMarket(teamId) };
  });

  app.post('/api/market/list', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const slot = idParam(reply, req.body?.slot, 'slot'); if (slot == null) return;
    const price = req.body?.price != null ? Number(req.body.price) : undefined;
    const r = listPlayer(teamId, slot, price);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return { ...r, market: getMarket(teamId) };
  });

  app.post('/api/market/unlist', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const slot = idParam(reply, req.body?.slot, 'slot'); if (slot == null) return;
    unlistPlayer(teamId, slot);
    return { ok: true, market: getMarket(teamId) };
  });

  // Bid for another club's player (club-to-club, window-gated, with negotiation). A rejection /
  // counter is a normal outcome (200 + status), only a malformed/illegal bid is a 4xx.
  app.post('/api/transfer/bid', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const playerId = idParam(reply, req.body?.playerId, 'playerId'); if (playerId == null) return;
    const fee = Number(req.body?.fee);   // bidForPlayer rejects a non-finite / non-positive fee with its own copy
    const r = bidForPlayer(teamId, playerId, fee);
    if (r.status === 'error') return reply.code(400).send({ error: r.error });
    return { ...r, market: getMarket(teamId) };
  });

  // Loan in another club's player for the season (no fee, window-gated).
  app.post('/api/transfer/loan', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const playerId = idParam(reply, req.body?.playerId, 'playerId'); if (playerId == null) return;
    const r = loanIn(teamId, playerId);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return { ...r, market: getMarket(teamId) };
  });

  // §2.1 (free-agent half): offer a free agent terms (wage + length) — he considers it and answers at the
  // next matchday — and the manager's free-agent negotiations in progress.
  app.post('/api/freeagent/offer', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const agentId = idParam(reply, req.body?.agentId, 'agentId'); if (agentId == null) return;
    const wage = Number(req.body?.wage), years = Number(req.body?.years);   // range-checked inside offerToFreeAgent
    const r = offerToFreeAgent(teamId, agentId, wage, years);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return { ...r, market: getMarket(teamId), faOffers: freeAgentOffersForTeam(teamId) };
  });
  app.get('/api/freeagent/offers', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    return { offers: freeAgentOffersForTeam(teamId) };
  });

  // §loan-out: send one of your own players out on loan to a world club for the season (frees his wage; he
  // returns at rollover). Optional clubId picks the destination; otherwise a club short in his role is chosen.
  app.post('/api/transfer/loan-out', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const slot = idParam(reply, req.body?.slot, 'slot'); if (slot == null) return;
    const clubId = optionalIdParam(reply, req.body?.clubId, 'clubId'); if (clubId === null) return;
    const r = loanOut(teamId, slot, clubId);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return { ...r, market: getMarket(teamId) };
  });

  // §2.12: send a loaned-in player back to his parent club early (frees the slot + wage).
  app.post('/api/transfer/loan/end', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const slot = idParam(reply, req.body?.slot, 'slot'); if (slot == null) return;
    const r = endLoan(teamId, slot);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return { ...r, market: getMarket(teamId) };
  });

  // §2.1 signing drama: a buyer's outgoing offers (live + recently resolved), withdraw a live one,
  // or match a counter (completes the deal at the seller's named price).
  app.get('/api/offers', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    return { offers: offersForTeam(teamId) };
  });
  app.post('/api/offer/:id/withdraw', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const offerId = idParam(reply, req.params?.id, 'offer id'); if (offerId == null) return;
    const r = withdrawOffer(teamId, offerId);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return { ...r, offers: offersForTeam(teamId) };
  });
  app.post('/api/offer/:id/match', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const offerId = idParam(reply, req.params?.id, 'offer id'); if (offerId == null) return;
    const r = matchCounter(teamId, offerId);
    if (r.status === 'error') return reply.code(400).send({ error: r.error });
    return { ...r, market: getMarket(teamId), offers: offersForTeam(teamId) };
  });

  // §2.1: INCOMING bids — other clubs bidding for YOUR listed players. List them, accept (sell), or reject.
  app.get('/api/incoming-offers', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    return { incoming: incomingOffersForTeam(teamId) };
  });
  app.post('/api/offer/:id/accept', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const offerId = idParam(reply, req.params?.id, 'offer id'); if (offerId == null) return;
    const r = acceptIncomingOffer(teamId, offerId);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return { ...r, market: getMarket(teamId), incoming: incomingOffersForTeam(teamId) };
  });
  app.post('/api/offer/:id/reject', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const offerId = idParam(reply, req.params?.id, 'offer id'); if (offerId == null) return;
    const r = rejectIncomingOffer(teamId, offerId);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return { ...r, incoming: incomingOffersForTeam(teamId) };
  });
}
