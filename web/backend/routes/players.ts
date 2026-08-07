// routes/players.ts — player identity & terms: the story↔dials rewrite (the backstory edit that
// re-derives trait weights) and contract renewals (propose / preview / match / withdraw + the
// club's negotiation list). Split out of index.ts.
import type { FastifyInstance } from 'fastify';
import { db } from '../db.ts';
import { playerValue } from '../game.ts';
import { deriveTraits, defaultPersonality, type Personality } from '../personality.ts';
import { previewRenewal, proposeRenewal, contractOffersForTeam, matchContractCounter, withdrawContractOffer } from '../contracts.ts';
import { requireTeam } from './shared.ts';

export function registerPlayerRoutes(app: FastifyInstance): void {
  // Rewrite a player's backstory/tagline and RE-DERIVE their trait dials from the new text
  // (the text↔dial coupling: the dials are the story's machine-readable projection, and the
  // training rate + transfer value read the dials live, so editing the story changes the
  // player's underlying weights). LLM-primary with a deterministic keyword fallback.
  app.put('/api/player/:slot/story', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const slot = Number(req.params.slot);
    if (!Number.isInteger(slot)) return reply.code(400).send({ error: 'bad slot' });
    const backstory = String(req.body?.backstory ?? '').trim().slice(0, 400);
    const tagline = String(req.body?.tagline ?? '').trim().slice(0, 80);
    if (!backstory) return reply.code(400).send({ error: 'a backstory is required' });
    const row = db.prepare('SELECT name, role, attrs, age, personality FROM players WHERE team_id = ? AND slot = ?')
      .get(teamId, slot) as { name: string; role: string; attrs: string; age: number; personality: string | null } | undefined;
    if (!row) return reply.code(404).send({ error: 'player not found' });
    let prev: Personality | null = null;
    try { prev = row.personality ? JSON.parse(row.personality) : null; } catch { /* ignore */ }
    const traits = await deriveTraits(row.name, row.role, backstory, tagline);
    const personality: Personality = { traits, nationality: prev?.nationality ?? defaultPersonality(row.name, row.role).nationality, backstory, tagline };
    db.prepare('UPDATE players SET personality = ? WHERE team_id = ? AND slot = ?').run(JSON.stringify(personality), teamId, slot);
    // return the re-derived weights so the UI can show the story drove the numbers
    return { slot, personality, value: playerValue(JSON.parse(row.attrs), row.age, personality) };
  });

  // Propose a renewal (§2.2): the manager offers a wage + length; the player resolves it at the next
  // matchday (accept / counter / reject). Replaces the old instant one-click renewal with a negotiation.
  app.post('/api/player/:slot/renew-offer', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const slot = Number(req.params.slot);
    if (!Number.isInteger(slot)) return reply.code(400).send({ error: 'bad slot' });
    const wage = Number(req.body?.wage);
    const years = req.body?.years != null ? Number(req.body.years) : 3;
    const r = proposeRenewal(teamId, slot, wage, years);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return r;
  });

  // The club's contract negotiations (outgoing renewal offers + their status).
  app.get('/api/contract-offers', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    return { offers: contractOffersForTeam(teamId) };
  });

  // Match the player's counter — strike the renewal at his terms (budget permitting).
  app.post('/api/contract-offer/:id/match', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const id = Number(req.params.id);
    const r = matchContractCounter(teamId, id);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return r;
  });

  // Withdraw a live renewal offer.
  app.post('/api/contract-offer/:id/withdraw', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const id = Number(req.params.id);
    const r = withdrawContractOffer(teamId, id);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return r;
  });

  // Preview a renewal (§1.14): the recomputed wage + delta + affordability, WITHOUT committing.
  app.get('/api/player/:slot/renew-preview', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const slot = Number(req.params.slot);
    if (!Number.isInteger(slot)) return reply.code(400).send({ error: 'bad slot' });
    const r = previewRenewal(teamId, slot, 3);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return r;
  });
}
