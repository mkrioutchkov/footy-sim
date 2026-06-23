// Lineup / formation compiler (A3). Turns a manager's free text — "play 4-4-2",
// "switch to 3-5-2 and put Bale at left back", an ASCII shape — into a concrete
// XI: a formation from the registry + which of the 11 squad players fills each
// slot. The LLM does the NL parsing (which shape, which explicit overrides); the
// CODE does the role-fit assignment (deterministic given attributes) so the best
// tackler lands at CB, the quickest out wide, etc. Same provider/env as tactics.ts.
import { FORMATIONS, DEFAULT_FORMATION, normalizeFormation, roleFit, type Slot } from './formations.ts';
import type { Role } from './game.ts';
import { chatComplete, llmReady, LlmError } from './llm.ts';

export interface Squad { players: { name: string; role?: string; attrs: Record<string, number> }[] }
export interface SlotAssignment { slot: number; role: Role; homeX: number; homeY: number; playerName: string; fromSlot: number; misfit?: boolean }
export interface LineupResult { formation: string; slots: SlotAssignment[]; note: string; raw?: string; cached?: boolean; error?: string }

const ROLES = new Set<Role>(['GK', 'CB', 'FB', 'CM', 'WM', 'CF', 'DM', 'AM']);
// DM/CM/AM are one positional family for slot-matching: a "put X at DM" override should
// land in central midfield even in a shape with no dedicated DM slot, and vice-versa.
const MID_FAMILY = new Set<Role>(['CM', 'DM', 'AM']);
const sameFamily = (a: Role, b: Role): boolean => a === b || (MID_FAMILY.has(a) && MID_FAMILY.has(b));
const initialsOf = (name: string) => name.split(/\s+/).filter(Boolean).map(w => w[0]).join('').toUpperCase();

function squadContext(sq: Squad): string {
  // The WHOLE squad — slots 0-10 are the XI, 11+ the bench. The manager can name a bench player to bring
  // him in ("put Smith up front"); the LLM needs to see + resolve him, so don't hide the bench.
  return sq.players
    .map((p, i) => `slot${i} ${p.name} [${initialsOf(p.name)}]${p.role ? `(${p.role})` : ''}${i >= 11 ? ' [bench]' : ''}`)
    .join(', ');
}

const SYSTEM = (ctx: string) => `You are a football lineup compiler. The manager wants to set the team's shape and/or move specific players. Output ONLY a JSON object — no prose, no markdown:
{"formation":"<one of: ${Object.keys(FORMATIONS).join(', ')}, or null to keep the current shape>","overrides":[{"player":"<exact squad name>","role":"<GK|CB|FB|DM|CM|AM|WM|CF>","side":"<L|R|C>"}],"note":""}

- "formation": the shape the manager asked for, normalised to one of the listed keys. "four-four-two"/"442"/"4 4 2" => "4-4-2"; "a back three"/"three at the back" => "3-5-2"; "two banks of four" => "4-4-2"; "lone striker"/"one up top" => "4-2-3-1". If they only move players and don't name a shape, use null.
- "overrides": ONE entry per player the manager explicitly places. Resolve the name from the squad (tolerate typos/initials: "AB"=>the player with those initials, "bale"=>Gareth Bale). Map the football position to an engine role + side:
    GK=>GK,C  ·  RB/RWB=>FB,R  ·  LB/LWB=>FB,L  ·  RCB=>CB,R  ·  LCB=>CB,L  ·  CB/centre-half=>CB,C
    CDM/DM/anchor/holding/regista=>DM,C  ·  CM/box-to-box=>CM,C  ·  CAM/AM/number 10/playmaker=>AM,C  ·  RM/RW/right wing=>WM,R  ·  LM/LW/left wing=>WM,L
    ST/CF/striker/up top/target man=>CF,C  ·  RF=>CF,R  ·  LF=>CF,L
  Side: L=left, R=right, C=central. Only include players the manager NAMES — never invent placements; the rest are auto-picked by the engine.
- ASCII / drawn formations: read the rows top(defence)->bottom(attack) or as drawn, infer the closest listed shape, set "formation". If players are written into the grid, add them as overrides.
- "note": SHORT, only to flag a problem — an unknown shape you couldn't map, a named player not in the squad (never substitute a different player — drop that override and note it), or nonsense/abuse ("note":"That's not a lineup instruction I can apply.", formation null, overrides []). Leave "" when everything mapped.

Squad (slot 0-10 = the current XI, slot 11+ = bench you can name to bring on):
${ctx}`;

function extract(content: string): { formation: unknown; overrides: unknown[]; note: string } {
  const body = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    const v = JSON.parse(body) as Record<string, unknown>;
    if (v && typeof v === 'object') return {
      formation: v.formation,
      overrides: Array.isArray(v.overrides) ? v.overrides : [],
      note: typeof v.note === 'string' ? v.note.trim() : '',
    };
  } catch { /* salvage below */ }
  return { formation: null, overrides: [], note: '' };
}

// Pick the free slot best matching (role, side): prefer a role match, then the
// slot whose width (y) sits on the requested side. R = nearer y≈0, L = nearer
// y≈680, C = nearest centre (340). Returns the slot index or -1 if none free.
function pickSlot(slots: Slot[], role: Role, side: string, taken: Set<number>): number {
  const idx = slots.map((_, i) => i).filter(i => !taken.has(i));
  const exact = idx.filter(i => slots[i].role === role);
  const family = exact.length ? exact : idx.filter(i => sameFamily(slots[i].role, role));
  const pool = family.length ? family : idx;            // exact role → same family (DM/CM/AM) → any free
  if (!pool.length) return -1;
  const key = (i: number) => side === 'R' ? slots[i].y : side === 'L' ? -slots[i].y : Math.abs(slots[i].y - 340);
  return pool.sort((a, b) => key(a) - key(b))[0];
}

// Greedy max-weight assignment of the remaining players to the remaining slots by
// role fit. n=11 so the O(n²·log) sort is trivial; good enough vs a full Hungarian.
function assign(sq: Squad, slots: Slot[], locked: Map<number, number>): number[] {
  const out = new Array(slots.length).fill(-1);
  const usedP = new Set<number>();
  for (const [si, pi] of locked) { out[si] = pi; usedP.add(pi); }
  const freeS = slots.map((_, i) => i).filter(i => out[i] < 0);
  // Auto-fill the unnamed slots from the designated XI only (slots 0-10): a pure shape change rearranges
  // your XI, it never auto-benches a starter for a squad player. Named bench players (already locked
  // above) come in over the top — so the bench is reached deliberately, not by surprise.
  const freeP = sq.players.map((_, i) => i).filter(i => i < 11 && !usedP.has(i));
  const pairs: { si: number; pi: number; fit: number }[] = [];
  for (const si of freeS) for (const pi of freeP)
    pairs.push({ si, pi, fit: roleFit(sq.players[pi].attrs, slots[si].role) });
  pairs.sort((a, b) => b.fit - a.fit);
  for (const p of pairs) if (out[p.si] < 0 && !usedP.has(p.pi)) { out[p.si] = p.pi; usedP.add(p.pi); }
  return out;
}

const cache = new Map<string, { formation: string; slots: SlotAssignment[]; note: string }>();

// Build the XI deterministically from the LLM's parse. Exported for unit tests
// (no network): given a parsed formation + overrides, produce the assignment.
export function buildLineup(sq: Squad, formationKey: string | null, overrides: { player: string; role: string; side: string }[]): { formation: string; slots: SlotAssignment[]; note: string } {
  const key = (formationKey && FORMATIONS[formationKey]) ? formationKey : DEFAULT_FORMATION;
  const slots = FORMATIONS[key];
  // Resolve names against the WHOLE squad so an override can name a bench player (slot 11+) to bring on.
  const names = sq.players.map(p => p.name.toLowerCase());
  const inits = sq.players.map(p => p.name.split(/\s+/).filter(Boolean).map(w => w[0]).join('').toLowerCase());
  const taken = new Set<number>();
  const locked = new Map<number, number>();
  const notes: string[] = [];
  // Pin slot 0 (always GK) to the natural keeper FIRST. Doing it before overrides
  // means an override can neither claim the GK slot nor drag the keeper outfield (he
  // is already locked), so the XI always has exactly one keeper and he is in goal.
  const gkIdx = sq.players.findIndex(p => (p.role ?? '').toUpperCase() === 'GK');
  if (gkIdx < 0) notes.push('No recognised goalkeeper in the squad — slot 0 is covered by an outfielder.');   // §1.9
  const gk = Math.max(0, gkIdx);
  locked.set(0, gk); taken.add(0);
  for (const ov of overrides) {
    const want = String(ov.player ?? '').toLowerCase().trim();
    if (!want) continue;
    let pi = names.indexOf(want);
    if (pi < 0) pi = inits.indexOf(want);                              // "AB" -> initials
    if (pi < 0 && want.length >= 3) pi = names.findIndex(n => n.includes(want));  // safe: want inside a name only
    if (pi < 0) { notes.push(`No "${ov.player}" in the squad.`); continue; }
    if ([...locked.values()].includes(pi)) {                          // already placed (incl. the keeper)
      notes.push(`${sq.players[pi].name} is already in the XI; ignored the duplicate.`); continue;
    }
    const role = (ROLES.has(ov.role as Role) ? ov.role : 'CM') as Role;
    const si = pickSlot(slots, role, String(ov.side ?? 'C').toUpperCase(), taken);
    if (si < 0) { notes.push(`Couldn't fit ${sq.players[pi].name} into ${key}.`); continue; }
    taken.add(si); locked.set(si, pi);
  }
  const a = assign(sq, slots, locked);
  const out: SlotAssignment[] = slots.map((s, i) => {
    const p = a[i] >= 0 ? sq.players[a[i]] : null;
    // §1.11: flag a player anchored materially out of position (a CM at CB in a back-heavy shape with
    // no real CBs) so the UI can warn — DM/CM/AM cover each other, GK is pinned, anything else is a misfit.
    const pRole = (p?.role ?? '').toUpperCase() as Role;
    const misfit = !!p && i > 0 && pRole !== s.role && !sameFamily(pRole, s.role);
    return { slot: i, role: s.role, homeX: s.x, homeY: s.y, playerName: p?.name ?? '', fromSlot: a[i], misfit };
  });
  const empty = out.filter(s => s.fromSlot < 0).length;
  if (empty) notes.push(`${empty} slot${empty > 1 ? 's' : ''} unfilled — fewer than 11 available players.`);   // §1.10
  const mis = out.filter(s => s.misfit).length;
  if (mis) notes.push(`${mis} player${mis > 1 ? 's' : ''} out of position for this shape.`);                  // §1.11
  return { formation: key, slots: out, note: notes.join(' ') };
}

// Compile free text -> a concrete XI. LLM parses intent; buildLineup assigns.
// Cached by (squad + text) so a given instruction compiles once (deterministic).
export async function compileLineup(text: string, sq: Squad): Promise<LineupResult> {
  const ctx = squadContext(sq);
  const cacheKey = `${ctx} ${text.trim()}`;
  const hit = cache.get(cacheKey);
  if (hit) return { ...hit, cached: true };
  const ready = llmReady();
  if (!ready.ok) return { formation: DEFAULT_FORMATION, slots: [], note: '', error: ready.error };
  let content: string;
  try {
    content = await chatComplete({ system: SYSTEM(ctx), user: text, temperature: 0, maxTokens: 512, timeoutMs: 12000 });
  } catch (e) {
    return { formation: DEFAULT_FORMATION, slots: [], note: '',
      error: e instanceof LlmError ? e.userMessage : 'the lineup model was unreachable' };
  }
  const p = extract(content);
  const fk = typeof p.formation === 'string' ? normalizeFormation(p.formation) : null;
  const ovs = (p.overrides as { player: string; role: string; side: string }[]).filter(o => o && typeof o === 'object');
  const built = buildLineup(sq, fk, ovs);
  // §1.12: the model named a shape we couldn't resolve — say so instead of silently defaulting.
  const unknown = typeof p.formation === 'string' && p.formation.trim() && !fk ? `Didn't recognise "${p.formation}" as a formation — using ${built.formation}.` : '';
  const note = [unknown, p.note, built.note].filter(Boolean).join(' ');
  const result = { formation: built.formation, slots: built.slots, note };
  cache.set(cacheKey, result);
  return { ...result, raw: content, cached: false };
}
