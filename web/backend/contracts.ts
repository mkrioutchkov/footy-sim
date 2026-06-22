// Contracts (pillar 5.2b). Deals tick down a year each season; expiring players resolve:
// an AI club auto-renews its men (a stable world); a human club's expiring players are
// RELEASED to the free-agent pool — but never below a legal XI (the best expiring players
// are auto-renewed to hold the squad at SQUAD_MIN). Renewal recomputes the wage from the
// player's current attrs/age/personality (a developed youngster earns more, a faded vet
// less) and is gated by the wage budget.
import { db } from './db.ts';
import { overall, playerWage } from './game.ts';
import { releasePlayerToFreeAgents, SQUAD_MIN } from './market.ts';

const RENEWAL_YEARS = 3;
const OFFER_EXPIRY = 3;   // matchdays a contract offer / counter stays live before it lapses
const parseJSON = (s: string | null): unknown => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const leagueRound = (leagueId: number): number =>
  (db.prepare('SELECT MAX(round) AS r FROM fixtures WHERE league_id = ? AND played = 1').get(leagueId) as { r: number | null }).r ?? 0;

export interface RenewResult { ok: boolean; error?: string; wage?: number; years?: number; }

// Renew one player's deal: recompute their wage and commit a fresh contract. A voluntary
// renewal (force=false, the user endpoint) is gated by the wage budget; a forced one
// (force=true — the season tick keeping an AI squad together or holding a human XI at the
// floor) is honoured even if it strains the budget, because the club must field a team.
// Single mutation — safe inside or outside a transaction.
export function renewContract(teamId: number, slot: number, years = RENEWAL_YEARS, force = false): RenewResult {
  const team = db.prepare('SELECT wage_budget FROM teams WHERE id = ?').get(teamId) as { wage_budget: number } | undefined;
  const p = db.prepare('SELECT id, attrs, age, personality, wage FROM players WHERE team_id = ? AND slot = ?')
    .get(teamId, slot) as { id: number; attrs: string; age: number; personality: string | null; wage: number | null } | undefined;
  if (!team || !p) return { ok: false, error: 'player not found' };
  const newWage = playerWage(JSON.parse(p.attrs), p.age, parseJSON(p.personality));
  const bill = (db.prepare('SELECT COALESCE(SUM(wage), 0) AS w FROM players WHERE team_id = ?').get(teamId) as { w: number }).w;
  if (!force && bill - (p.wage ?? 0) + newWage > team.wage_budget) return { ok: false, error: 'not enough wage budget to renew' };
  const yr = Math.max(1, Math.min(5, Math.round(Number.isFinite(years) ? years : RENEWAL_YEARS)));   // NaN-safe
  db.prepare('UPDATE players SET contract_years = ?, wage = ? WHERE id = ?').run(yr, newWage, p.id);
  return { ok: true, wage: newWage, years: yr };
}

export interface RenewPreview { ok: boolean; error?: string; currentWage?: number; newWage?: number; delta?: number; years?: number; affordable?: boolean; }

// What a renewal WOULD cost, without committing: the wage recomputed from current ability/age, the
// delta vs the present wage, and whether it fits the budget. (§1.14: the renewed wage can DROP for an
// ageing player or jump for a developed one — the manager should see it before clicking Renew.)
export function previewRenewal(teamId: number, slot: number, years = RENEWAL_YEARS): RenewPreview {
  const team = db.prepare('SELECT wage_budget FROM teams WHERE id = ?').get(teamId) as { wage_budget: number } | undefined;
  const p = db.prepare('SELECT attrs, age, personality, wage FROM players WHERE team_id = ? AND slot = ?')
    .get(teamId, slot) as { attrs: string; age: number; personality: string | null; wage: number | null } | undefined;
  if (!team || !p) return { ok: false, error: 'player not found' };
  const newWage = playerWage(JSON.parse(p.attrs), p.age, parseJSON(p.personality));
  const bill = (db.prepare('SELECT COALESCE(SUM(wage), 0) AS w FROM players WHERE team_id = ?').get(teamId) as { w: number }).w;
  const yr = Math.max(1, Math.min(5, Math.round(Number.isFinite(years) ? years : RENEWAL_YEARS)));
  return { ok: true, currentWage: p.wage ?? 0, newWage, delta: newWage - (p.wage ?? 0), years: yr, affordable: bill - (p.wage ?? 0) + newWage <= team.wage_budget };
}

// ── Contract renewal negotiation (audit §2.2) ───────────────────────────────
// A voluntary renewal is a NEGOTIATION, not an instant click: the manager proposes a wage + length,
// the player (agent) considers it for a matchday, then accepts / counters / rejects.

export interface RenewalVerdict { decision: 'accept' | 'counter' | 'reject'; demand: number; counterWage?: number; counterYears?: number; }

// The player's verdict on a renewal offer. Pure + deterministic: his DEMAND is the fair wage (from
// ability/age — the same playerWage the value model uses) lifted by ego (a big ego wants up to +15%)
// and by mood (an unhappy man wants a premium to stay, a buoyant one shaves a little). He accepts at or
// above his demand, counters at it otherwise — and a deeply unhappy player rejects a lowball outright
// (he'd rather run his deal down / force a move), tying renewals into the morale + personality streams.
export function evaluateRenewalOffer(
  attrs: Record<string, number>, age: number, personality: unknown,
  morale: number, offerWage: number, offerYears: number,
): RenewalVerdict {
  const traits = (personality as { traits?: Record<string, number> } | null)?.traits ?? null;
  const ego = traits?.ego ?? 50;
  const fair = playerWage(attrs, age, personality);
  const egoFactor = 1 + Math.min(50, Math.max(0, ego - 50)) / 50 * 0.15;          // ego 50→1.0, 100→1.15
  const moraleFactor = morale < 40 ? 1.10 : morale >= 80 ? 0.97 : 1.0;
  const demand = Math.round(fair * egoFactor * moraleFactor);
  const years = Math.max(1, Math.min(5, Math.round(Number.isFinite(offerYears) ? offerYears : RENEWAL_YEARS)));
  if (morale < 35 && offerWage < demand * 1.2) return { decision: 'reject', demand };
  if (offerWage >= demand) return { decision: 'accept', demand, counterYears: years };
  return { decision: 'counter', demand, counterWage: demand, counterYears: years };
}

interface ContractOfferRow { id: number; team_id: number; player_id: number; wage: number; years: number; status: string; counter_wage: number | null; counter_years: number | null; created_round: number; expires_round: number; }
export interface ContractOfferView { id: number; playerSlot: number | null; playerName: string; wage: number; years: number; status: string; counterWage: number | null; counterYears: number | null; }
export interface ContractOfferEvent { teamId: number; player: string; result: 'accepted' | 'countered' | 'rejected' | 'expired'; wage: number; years: number; counterWage?: number; counterYears?: number; }

// Commit an agreed renewal at a SPECIFIC wage + length (the negotiated terms, not a recompute), gated by
// the wage budget — a voluntary deal can't push the bill over budget (the manager must free wages first).
function commitRenewal(teamId: number, playerId: number, wage: number, years: number): { ok: boolean } {
  const team = db.prepare('SELECT wage_budget FROM teams WHERE id = ?').get(teamId) as { wage_budget: number } | undefined;
  const p = db.prepare('SELECT wage FROM players WHERE id = ? AND team_id = ?').get(playerId, teamId) as { wage: number | null } | undefined;
  if (!team || !p) return { ok: false };
  const bill = (db.prepare('SELECT COALESCE(SUM(wage), 0) AS w FROM players WHERE team_id = ?').get(teamId) as { w: number }).w;
  if (bill - (p.wage ?? 0) + wage > team.wage_budget) return { ok: false };
  db.prepare('UPDATE players SET contract_years = ?, wage = ? WHERE id = ?').run(years, wage, playerId);
  return { ok: true };
}

export interface ProposeResult { ok: boolean; error?: string; offers?: ContractOfferView[]; }

// Propose a renewal (wage + length). Creates a PENDING offer the player resolves at the next matchday;
// supersedes any prior live offer for the same player (one negotiation at a time). Permissive on the
// figure (the wage budget is enforced when the deal is actually struck, in commitRenewal).
export function proposeRenewal(teamId: number, slot: number, wage: number, years: number): ProposeResult {
  const p = db.prepare('SELECT id FROM players WHERE team_id = ? AND slot = ?').get(teamId, slot) as { id: number } | undefined;
  if (!p) return { ok: false, error: 'player not found' };
  const w = Math.round(Number(wage));
  if (!Number.isFinite(w) || w <= 0) return { ok: false, error: 'offer a positive wage' };
  const yr = Math.max(1, Math.min(5, Math.round(Number.isFinite(years) ? years : RENEWAL_YEARS)));
  const leagueId = (db.prepare('SELECT league_id AS l FROM teams WHERE id = ?').get(teamId) as { l: number }).l;
  const round = leagueRound(leagueId);
  db.prepare("UPDATE contract_offers SET status='withdrawn' WHERE team_id=? AND player_id=? AND status IN ('pending','countered')").run(teamId, p.id);
  db.prepare(`INSERT INTO contract_offers (team_id, player_id, wage, years, status, created_round, expires_round, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`).run(teamId, p.id, w, yr, round, round + OFFER_EXPIRY, Date.now());
  return { ok: true, offers: contractOffersForTeam(teamId) };
}

// Resolve a team's pending renewal offers at the matchday tick (mirrors market.processOffers): the
// player accepts / counters / rejects after a matchday's consideration; an accepted deal commits at the
// offered terms (budget permitting); a countered offer the manager never matches lapses at its expiry.
// No-op when the league has no pending offers, so the season suites are unaffected.
export function processContractOffers(leagueId: number): ContractOfferEvent[] {
  const events: ContractOfferEvent[] = [];
  const round = leagueRound(leagueId);
  // Reap orphans first: a player with a live offer may have been sold/released this tick (his row is
  // gone), which the INNER JOIN below would silently skip — leaving the offer stuck. Lapse those.
  db.prepare("UPDATE contract_offers SET status='expired' WHERE status IN ('pending','countered') AND team_id IN (SELECT id FROM teams WHERE league_id = ?) AND player_id NOT IN (SELECT id FROM players)").run(leagueId);
  const setStatus = db.prepare('UPDATE contract_offers SET status = ? WHERE id = ?');
  const pending = db.prepare(`SELECT o.*, p.name AS player_name, p.attrs, p.age, p.personality, p.morale
      FROM contract_offers o JOIN players p ON p.id = o.player_id JOIN teams t ON t.id = o.team_id
      WHERE o.status = 'pending' AND t.league_id = ? ORDER BY o.id`)
    .all(leagueId) as unknown as (ContractOfferRow & { player_name: string; attrs: string; age: number; personality: string | null; morale: number })[];
  for (const o of pending) {
    if (round <= o.created_round) continue;   // the agent considers it for a matchday before replying
    const ev = (result: ContractOfferEvent['result'], extra?: Partial<ContractOfferEvent>): void => {
      events.push({ teamId: o.team_id, player: o.player_name, result, wage: o.wage, years: o.years, ...extra });
    };
    if (round > o.expires_round) { setStatus.run('expired', o.id); ev('expired'); continue; }
    const v = evaluateRenewalOffer(JSON.parse(o.attrs), o.age, parseJSON(o.personality), o.morale, o.wage, o.years);
    if (v.decision === 'accept') {
      if (commitRenewal(o.team_id, o.player_id, o.wage, o.years).ok) { setStatus.run('accepted', o.id); ev('accepted'); }
      else { setStatus.run('rejected', o.id); ev('rejected'); }   // agreed, but the wage budget can't bear it
    } else if (v.decision === 'counter') {
      db.prepare("UPDATE contract_offers SET status='countered', counter_wage=?, counter_years=? WHERE id=?").run(v.counterWage ?? o.wage, v.counterYears ?? o.years, o.id);
      ev('countered', { counterWage: v.counterWage, counterYears: v.counterYears });
    } else { setStatus.run('rejected', o.id); ev('rejected'); }
  }
  db.prepare("UPDATE contract_offers SET status='expired' WHERE status='countered' AND expires_round < ? AND team_id IN (SELECT id FROM teams WHERE league_id = ?)").run(round, leagueId);
  return events;
}

// A club's recent renewal negotiations for the UI (live + recently-resolved, newest first).
export function contractOffersForTeam(teamId: number): ContractOfferView[] {
  return (db.prepare(`SELECT o.id, o.wage, o.years, o.status, o.counter_wage, o.counter_years, p.slot AS player_slot, COALESCE(p.name, '(left the club)') AS player_name
      FROM contract_offers o LEFT JOIN players p ON p.id = o.player_id
      WHERE o.team_id = ? AND o.status IN ('pending','countered','accepted','rejected') ORDER BY o.id DESC LIMIT 20`)
    .all(teamId) as unknown as { id: number; wage: number; years: number; status: string; counter_wage: number | null; counter_years: number | null; player_slot: number | null; player_name: string }[])
    .map(r => ({ id: r.id, playerSlot: r.player_slot, playerName: r.player_name, wage: r.wage, years: r.years, status: r.status, counterWage: r.counter_wage, counterYears: r.counter_years }));
}

// Match the player's counter — strike the deal at HIS terms (budget permitting).
export function matchContractCounter(teamId: number, offerId: number): { ok: boolean; error?: string; player?: string; wage?: number; years?: number; offers?: ContractOfferView[] } {
  const o = db.prepare("SELECT * FROM contract_offers WHERE id = ? AND team_id = ? AND status = 'countered'").get(offerId, teamId) as unknown as ContractOfferRow | undefined;
  if (!o) return { ok: false, error: 'no counter to match' };
  // the player may have left between page-load and click — give a true reason, not a budget red herring
  const stillHere = db.prepare('SELECT 1 FROM players WHERE id = ? AND team_id = ?').get(o.player_id, teamId);
  if (!stillHere) { db.prepare("UPDATE contract_offers SET status='expired' WHERE id = ?").run(offerId); return { ok: false, error: 'that player has left the club' }; }
  const wage = o.counter_wage ?? o.wage, years = o.counter_years ?? o.years;
  if (!commitRenewal(teamId, o.player_id, wage, years).ok) return { ok: false, error: 'not enough wage budget to match the counter — sell or release first' };
  db.prepare("UPDATE contract_offers SET status='accepted', wage=?, years=? WHERE id=?").run(wage, years, offerId);
  const name = (db.prepare('SELECT name FROM players WHERE id = ?').get(o.player_id) as { name: string } | undefined)?.name;
  return { ok: true, player: name, wage, years, offers: contractOffersForTeam(teamId) };
}

// Pull a live (pending/countered) renewal offer off the table.
export function withdrawContractOffer(teamId: number, offerId: number): { ok: boolean; error?: string; offers?: ContractOfferView[] } {
  const o = db.prepare("SELECT id FROM contract_offers WHERE id = ? AND team_id = ? AND status IN ('pending','countered')").get(offerId, teamId) as { id: number } | undefined;
  if (!o) return { ok: false, error: 'offer not found or already resolved' };
  db.prepare("UPDATE contract_offers SET status='withdrawn' WHERE id = ?").run(offerId);
  return { ok: true, offers: contractOffersForTeam(teamId) };
}

export interface ContractEvent { teamId: number; player: string; type: 'renewed' | 'released'; }

// Season-end contract resolution for a division. Decrements every deal, then resolves the
// expiries. Call inside the rollover transaction (does not open its own); the free-agent
// pool must already be (re)seeded so released players join the new window's pool.
export function tickContracts(leagueId: number): ContractEvent[] {
  const events: ContractEvent[] = [];
  // §2.2: lapse any live renewal negotiation at season's end — the rollover resolves every expiring
  // deal anyway, and offer round-numbers become meaningless once the fixtures (and leagueRound) reset,
  // so a carried-over offer would otherwise never expire / stay matchable at stale terms.
  db.prepare("UPDATE contract_offers SET status='expired' WHERE status IN ('pending','countered') AND team_id IN (SELECT id FROM teams WHERE league_id = ?)").run(leagueId);
  db.prepare('UPDATE players SET contract_years = contract_years - 1 WHERE team_id IN (SELECT id FROM teams WHERE league_id = ?)').run(leagueId);
  const teams = db.prepare('SELECT id, name, user_id FROM teams WHERE league_id = ?').all(leagueId) as { id: number; name: string; user_id: number | null }[];
  for (const t of teams) {
    const expired = db.prepare('SELECT slot, name, attrs FROM players WHERE team_id = ? AND contract_years <= 0').all(t.id) as { slot: number; name: string; attrs: string }[];
    if (!expired.length) continue;

    if (t.user_id == null) {
      // AI: keep its squad together — force-renew every expiring player (honoured even if
      // it strains the wage budget; an AI never lets a player walk).
      for (const e of expired) { renewContract(t.id, e.slot, RENEWAL_YEARS, true); events.push({ teamId: t.id, player: e.name, type: 'renewed' }); }
      continue;
    }

    // Human: release expiring players (worst first) but never below a legal XI. Track by id
    // and re-resolve the current slot each time — releasePlayerToFreeAgents renumbers, so
    // slots shift after every release.
    const ranked = (db.prepare('SELECT id, name, attrs FROM players WHERE team_id = ? AND contract_years <= 0').all(t.id) as { id: number; name: string; attrs: string }[])
      .map(e => ({ id: e.id, name: e.name, ovr: overall(JSON.parse(e.attrs)) }))
      .sort((a, b) => a.ovr - b.ovr);
    for (const e of ranked) {
      const size = (db.prepare('SELECT COUNT(*) AS n FROM players WHERE team_id = ?').get(t.id) as { n: number }).n;
      if (size <= SQUAD_MIN) break;                       // floor reached — keep (renew) the rest
      const cur = db.prepare('SELECT slot FROM players WHERE id = ?').get(e.id) as { slot: number } | undefined;
      if (!cur) continue;
      releasePlayerToFreeAgents(t.id, cur.slot);
      events.push({ teamId: t.id, player: e.name, type: 'released' });
    }
    // anyone still out of contract was kept for the floor — force a 1-year extension so the
    // club can field a legal XI even if the wage bill is tight.
    const stillExpired = db.prepare('SELECT slot, name FROM players WHERE team_id = ? AND contract_years <= 0').all(t.id) as { slot: number; name: string }[];
    for (const s of stillExpired) { renewContract(t.id, s.slot, 1, true); events.push({ teamId: t.id, player: s.name, type: 'renewed' }); }
  }
  return events;
}
