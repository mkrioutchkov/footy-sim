// Persistent matchday inbox (the FM home-screen spine). See the `inbox` table in db.ts.
//
// The advance handler assembles ONE batch of items per matchday from its locals (assembleInboxItems +
// matchdayHeadline), persists them idempotently by (team, season, world-round), and returns them so the
// dashboard digest card renders from the SAME array — one formatting source, no frontend/backend drift.
// The archive persists across rollover (like player_news), grouped by season on the screen. Engine-free —
// pure formatting + storage over data the advance response already carries.
import { db } from './db.ts';

export interface InboxItem { category: string; icon: string; text: string; hash?: string | null }
export interface InboxRow extends InboxItem { id: number; season: number; round: number; read: boolean }

// Mirror the frontend fmtMoney (app.ts) EXACTLY so a persisted item reads identically to the live digest.
function fmtMoney(n: number): string {
  if (n < 0) return `-${fmtMoney(-n)}`;
  if (n >= 1e6) return `£${(n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1)}M`;
  if (n >= 1e3) { const k = Math.round(n / 1e3); if (k >= 1000) return `£${(k / 1000).toFixed(1)}M`; return `£${k}K`; }
  return `£${Math.round(n)}`;
}

// The advance-handler locals the assembly reads (a subset of the /api/advance response, + teamId).
export interface AdvanceBag {
  teamId: number;
  myResult: { homeScore: number; awayScore: number } | null;
  myFixtureId: number | null;
  // The user's side + opponent for THIS match, resolved in the handler BEFORE rollover (which purges the
  // fixtures). Passing them through avoids re-reading the DB post-rollover, where the fixture is gone and
  // the headline would default to home=true and invert an away result. null home = unknown (fall back home).
  myHome: boolean | null;
  myOpponent: string;
  income: number;
  developed: number;
  injuries: { teamId: number; player: string; matches: number }[];
  transfers: { teamName: string; player: string; fee: number; type: string }[];
  incomingBids: { from: string; fee: number; player: string }[];
  faOffers: { type: string; player: string; wage: number; years: number }[];
  listingsExpired: { player: string }[];
  contractOffers: { result: string; player: string; years: number; wage: number; counterWage?: number | null }[];
  cup: { champion: number | null; myTie: { homeScore: number; awayScore: number; opponent: string; won: boolean } | null } | null;
  rollover: {
    season: number;
    promoted: { teamId: number; toTier: number }[];
    relegated: { teamId: number; toTier: number }[];
    prizeMoney: { teamId: number; amount: number }[];
    contracts?: { teamId: number; type: string }[];
    youth?: { teamId: number; type: string }[];
    awards?: { teamId: number; player: string; type: string }[];
    board?: { teamId: number; message: string }[];
  } | null;
}

// The matchday headline — the user's result from their own perspective (their goals first + W/D/L +
// opponent). Uses the side/opponent resolved in the handler BEFORE rollover (bag.myHome/myOpponent), so
// a season-completing advance (which deletes the fixture) can't flip an away win into a reported loss.
export function matchdayHeadline(bag: AdvanceBag): string {
  if (!bag.myResult || bag.myFixtureId == null) return '';
  const home = bag.myHome !== false;   // null (unknown) falls back to home
  const gf = home ? bag.myResult.homeScore : bag.myResult.awayScore;
  const ga = home ? bag.myResult.awayScore : bag.myResult.homeScore;
  return `${gf > ga ? '✅ Won' : gf < ga ? '❌ Lost' : '➖ Drew'} ${gf}–${ga}${bag.myOpponent ? ` vs ${bag.myOpponent}` : ''}`;
}

// Port of the frontend digest assembly (app.ts:660-713) — same items/icons/wording/hashes, so the inbox
// archive and the live digest card are identical by construction. Categories tag each item for filtering.
export function assembleInboxItems(bag: AdvanceBag): InboxItem[] {
  const d: InboxItem[] = [];
  const teamId = bag.teamId;
  if (bag.myResult && bag.myFixtureId != null) d.push({ category: 'result', icon: '📄', text: 'Read the match report', hash: `#/report/${bag.myFixtureId}` });
  if (bag.income) d.push({ category: 'finance', icon: '💷', text: `Gate & TV income: ${fmtMoney(bag.income)}` });
  if (bag.developed) d.push({ category: 'development', icon: '📈', text: `${bag.developed} player${bag.developed > 1 ? 's' : ''} developed in training`, hash: '#/training' });
  for (const i of bag.injuries.filter(x => x.teamId === teamId)) d.push({ category: 'injury', icon: '🤕', text: `${i.player} out ${i.matches} match${i.matches > 1 ? 'es' : ''}`, hash: '#/squad' });
  if (bag.transfers.length) {
    const t = bag.transfers[0];
    const verb = t.type === 'buy_listed' ? 'bought' : 'signed';
    d.push({ category: 'transfer', icon: '🔁', text: bag.transfers.length === 1 ? `${t.teamName} ${verb} ${t.player} (${fmtMoney(t.fee)})` : `${bag.transfers.length} transfers around the league`, hash: '#/news' });
  }
  for (const b of bag.incomingBids) d.push({ category: 'bid', icon: '📥', text: `${b.from} bid ${fmtMoney(b.fee)} for ${b.player} — accept or reject`, hash: '#/market' });
  for (const f of bag.faOffers) {
    if (f.type === 'fa_signed') d.push({ category: 'transfer', icon: '✍️', text: `${f.player} accepted your offer — signed (${fmtMoney(f.wage)}/yr × ${f.years}y)`, hash: '#/squad' });
    else if (f.type === 'fa_rejected') d.push({ category: 'transfer', icon: '✖', text: `${f.player} turned down your offer` });
    else if (f.type === 'fa_gone') d.push({ category: 'transfer', icon: '🏃', text: `${f.player} signed for another club before answering your offer` });
    else if (f.type === 'fa_expired') d.push({ category: 'transfer', icon: '⏳', text: `${f.player} never answered your offer — it lapsed` });
  }
  for (const l of bag.listingsExpired) d.push({ category: 'transfer', icon: '⌛', text: `${l.player}'s listing expired unsold — the window closed` });
  for (const c of bag.contractOffers) {
    if (c.result === 'accepted') d.push({ category: 'contract', icon: '✍️', text: `${c.player} signed a new ${c.years}-year deal (${fmtMoney(c.wage)}/yr)` });
    else if (c.result === 'countered') d.push({ category: 'contract', icon: '↩', text: `${c.player}'s agent wants ${fmtMoney(c.counterWage ?? c.wage)}/yr — respond on his profile`, hash: '#/squad' });
    else if (c.result === 'rejected') d.push({ category: 'contract', icon: '✖', text: `${c.player} turned down the contract offer` });
    else if (c.result === 'expired') d.push({ category: 'contract', icon: '⏱️', text: `${c.player}'s contract talks lapsed — he never answered` });
  }
  const wonCup = bag.cup?.champion != null && bag.cup.champion === teamId;
  if (bag.cup?.myTie && !wonCup) {
    const c = bag.cup.myTie;
    const pens = c.homeScore === c.awayScore ? ' (on pens)' : '';
    d.push({ category: 'cup', icon: '🏆', text: `Cup: ${c.won ? 'beat' : 'lost to'} ${c.opponent} ${c.homeScore}–${c.awayScore}${pens}${c.won ? ' — through' : ' — knocked out'}`, hash: '#/cup' });
  }
  if (wonCup) d.push({ category: 'cup', icon: '🏆', text: 'You won the Cup!', hash: '#/cup' });
  if (bag.rollover) {
    const ro = bag.rollover;
    const up = ro.promoted.find(p => p.teamId === teamId);
    const down = ro.relegated.find(p => p.teamId === teamId);
    const mine = ro.prizeMoney.find(p => p.teamId === teamId);
    const verdict = up ? `🎉 PROMOTED to Division ${up.toTier}!` : down ? `Relegated to Division ${down.toTier}.` : 'Season complete.';
    d.push({ category: 'season', icon: '🔚', text: `${verdict}${mine ? ` Prize money: ${fmtMoney(mine.amount)}.` : ''} Season ${ro.season} begins.` });
    const released = (ro.contracts ?? []).filter(c => c.teamId === teamId && c.type === 'released');
    if (released.length) d.push({ category: 'transfer', icon: '🚪', text: `${released.length} player(s) left on a free transfer — re-sign from the market, or renew deals earlier next season`, hash: '#/market' });
    const myYouth = (ro.youth ?? []).filter(y => y.teamId === teamId);
    const retired = myYouth.filter(y => y.type === 'retired'), intake = myYouth.filter(y => y.type === 'intake');
    if (retired.length || intake.length) d.push({ category: 'youth', icon: '🎓', text: `Academy: ${intake.length} new prospect(s) in the youth setup${retired.length ? `, ${retired.length} veteran(s) retired` : ''}`, hash: '#/academy' });
    for (const a of (ro.awards ?? []).filter(a => a.teamId === teamId)) {
      d.push({ category: 'award', icon: a.type === 'pots' ? '🏆' : '🌟', text: `${a.player} — your ${a.type === 'pots' ? 'Player' : 'Young Player'} of the Season!` });
    }
    const board = (ro.board ?? []).find(b => b.teamId === teamId);
    if (board) d.push({ category: 'board', icon: '📋', text: `Board: ${board.message}` });
  }
  return d;
}

// Persist one matchday's items, idempotent per (team, season, round): if any row already exists for that
// key (a retried/overlapping advance), skip — the world round advances once per advance so this can't
// wrongly collapse two distinct matchdays. Ordering is by autoincrement id (no Date.now dependency).
export function recordMatchdayInbox(teamId: number, season: number, round: number, items: InboxItem[]): void {
  if (!items.length) return;
  if (db.prepare('SELECT 1 FROM inbox WHERE team_id = ? AND season = ? AND round = ? LIMIT 1').get(teamId, season, round)) return;
  const ins = db.prepare('INSERT INTO inbox (team_id, season, round, category, icon, text, hash, read, created_at) VALUES (?,?,?,?,?,?,?,0,?)');
  const now = Date.now();
  for (const it of items) ins.run(teamId, season, round, it.category, it.icon, it.text, it.hash ?? null, now);
}

// The club's inbox, newest first (mirror recentNews ordering).
export function getInbox(teamId: number, limit = 50): InboxRow[] {
  const rows = db.prepare('SELECT id, season, round, category, icon, text, hash, read FROM inbox WHERE team_id = ? ORDER BY id DESC LIMIT ?')
    .all(teamId, limit) as { id: number; season: number; round: number; category: string; icon: string; text: string; hash: string | null; read: number }[];
  return rows.map(r => ({ id: r.id, season: r.season, round: r.round, category: r.category, icon: r.icon, text: r.text, hash: r.hash, read: !!r.read }));
}

export function countUnread(teamId: number): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM inbox WHERE team_id = ? AND read = 0').get(teamId) as { n: number }).n;
}

// Mark one item (by id) or all of the club's items read. team-scoped, so a forged id can't flip another
// club's row (the id predicate is ANDed with team_id).
export function markInboxRead(teamId: number, opts: { id?: number; all?: boolean }): void {
  if (opts.all) { db.prepare('UPDATE inbox SET read = 1 WHERE team_id = ?').run(teamId); return; }
  if (opts.id != null && Number.isInteger(opts.id)) db.prepare('UPDATE inbox SET read = 1 WHERE team_id = ? AND id = ?').run(teamId, opts.id);
}
