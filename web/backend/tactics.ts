// Plain-English tactics compiler (P3). Turns a manager's free text into the
// engine's directive JSON, resolving player names to engine ids. Provider-
// agnostic: any OpenAI-compatible /chat/completions endpoint (defaults to
// Xiaomi MiMo's budget model). Configure via env — the key lives in
// web/backend/.env, never in code:
//   TACTICS_LLM_BASE_URL  (default https://api.xiaomimimo.com/v1)
//   TACTICS_LLM_MODEL     (default mimo-v2-flash)
//   TACTICS_LLM_API_KEY   (required to call the model)

const BASE = (process.env.TACTICS_LLM_BASE_URL ?? 'https://api.xiaomimimo.com/v1').replace(/\/$/, '');
const MODEL = process.env.TACTICS_LLM_MODEL ?? 'mimo-v2-flash';
const KEY = process.env.TACTICS_LLM_API_KEY ?? '';

// Engine slot -> role (the 11 fixed formation slots; home ids 0..10, away 11..21).
const ROLE_SLOTS = ['GK', 'FB', 'CB', 'CB', 'FB', 'CM', 'CM', 'CM', 'WM', 'CF', 'WM'];
const VALID_KINDS = new Set(['man_mark', 'shoot_on_sight', 'get_forward', 'sit_deep', 'target_player']);
const VALID_SCORE = new Set(['winning', 'drawing', 'losing', 'any']);

export interface Directive {
  playerId: number;
  kind: string;
  targetId?: number;
  intensity?: number;
  when?: { fromMin?: number; toMin?: number; scoreState?: string; scoreBy?: number };
}

export interface CompileResult { directives: Directive[]; raw: string; cached: boolean; error?: string; }

interface TeamSpec { players: { name: string }[] }
interface MatchSpec { home: TeamSpec; away: TeamSpec }

const cache = new Map<string, Directive[]>();
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function rosterContext(spec: MatchSpec): string {
  const line = (t: TeamSpec, off: number) =>
    t.players.slice(0, 11).map((p, i) => `id${off + i} ${p.name}(${ROLE_SLOTS[i]})`).join(', ');
  return `HOME: ${line(spec.home, 0)}\nAWAY: ${line(spec.away, 11)}`;
}

const SYSTEM = (ctx: string) => `You convert a football manager's plain-English tactics into a JSON array of directives. Output ONLY the JSON array — no prose, no markdown.

Each directive: {"playerId":<int 0-21>, "kind":<man_mark|shoot_on_sight|get_forward|sit_deep|target_player>, "targetId":<int 0-21, only for man_mark and target_player>, "intensity":<0..1>, "when":{"fromMin":<int,default 0>,"toMin":<int,default 1000>,"scoreState":<winning|drawing|losing|any>,"scoreBy":<int,default 0>}}.

Rules:
- Resolve player NAMES (tolerate typos/slang) to their engine id from the rosters below.
- TIME WINDOW via when.fromMin/toMin (match minutes, default whole match): "first half"=>toMin 45; "second half"=>fromMin 45; "last 20 minutes"=>fromMin 70; "from/after the 60th minute"=>fromMin 60; "first 15 minutes"=>toMin 15.
- man_mark = a defender shadows an opponent (targetId). target_player = feed passes to a team-mate (targetId). get_forward/sit_deep = push a player up / drop them deep. shoot_on_sight = a player shoots from range.
- Omit "when" fields that aren't specified (defaults apply). Use scoreState only when the manager ties it to the scoreline.
- IGNORE anything impossible, contradictory, or not expressible as the kinds above (e.g. "teleport", "play like Barca") — just leave it out. If nothing maps, output [].

Rosters (ids are fixed):
${ctx}`;

function extractArray(content: string): unknown[] {
  const s = content.indexOf('[');
  const e = content.lastIndexOf(']');
  if (s < 0 || e < s) return [];
  try { const v = JSON.parse(content.slice(s, e + 1)); return Array.isArray(v) ? v : []; } catch { return []; }
}

// Keep only well-formed, in-range directives; coerce the rest. Impossible /
// malformed entries are dropped so the engine only ever sees valid input.
function validate(raw: unknown[]): Directive[] {
  const out: Directive[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const d = r as Record<string, unknown>;
    const kind = String(d.kind ?? '');
    const playerId = num(d.playerId, -1);
    if (!VALID_KINDS.has(kind) || playerId < 0 || playerId > 21) continue;
    const dir: Directive = { playerId, kind, intensity: Math.max(0, Math.min(1, num(d.intensity, 1))) };
    if (kind === 'man_mark' || kind === 'target_player') {
      const t = num(d.targetId, -1);
      if (t < 0 || t > 21) continue;           // these kinds need a valid target
      dir.targetId = t;
    }
    const w = (d.when ?? {}) as Record<string, unknown>;
    const when: Directive['when'] = {};
    when.fromMin = Math.max(0, Math.round(num(w.fromMin, 0)));
    when.toMin = Math.round(num(w.toMin, 1000));
    const ss = String(w.scoreState ?? 'any');
    when.scoreState = VALID_SCORE.has(ss) ? ss : 'any';
    when.scoreBy = Math.round(num(w.scoreBy, 0));
    dir.when = when;
    out.push(dir);
  }
  return out;
}

// ── Rules fast-path ── common, explicit orders compile instantly + offline,
// no LLM. Conservative: a clause matches only if it has exactly ONE directive
// family and resolvable player(s); fuzzy/compound/ambiguous -> fullyParsed=false
// so the LLM takes over.
interface NameRef { token: string; id: number }
function nameIndex(spec: MatchSpec): NameRef[] {
  const idx: NameRef[] = [];
  const add = (t: TeamSpec, off: number) => t.players.slice(0, 11).forEach((p, i) => {
    const name = (p.name ?? '').toLowerCase().trim();
    if (name) idx.push({ token: name, id: off + i });
    for (const tok of name.split(/\s+/)) if (tok.length >= 3) idx.push({ token: tok, id: off + i });
  });
  add(spec.home, 0); add(spec.away, 11);
  return idx.sort((a, b) => b.token.length - a.token.length);   // full names beat surnames
}
// Levenshtein, capped: returns >2 fast when the names can't be within edit
// distance 2 (all we care about for typo tolerance).
function lev(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const m = a.length; const dp = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    let prev = dp[0]; dp[0] = j;
    for (let i = 1; i <= m; i++) {
      const tmp = dp[i];
      dp[i] = Math.min(dp[i] + 1, dp[i - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[m];
}
function playersIn(clause: string, idx: NameRef[]): number[] {
  const lc = clause.toLowerCase();
  const words = lc.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length >= 3);
  const wordSet = new Set(words);
  const hits: { id: number; pos: number }[] = [];
  const take = (id: number, pos: number) => { if (!hits.some(h => h.id === id)) hits.push({ id, pos }); };
  // exact (incl. multi-word full names)
  for (const { token, id } of idx) {
    const ok = token.includes(' ') ? lc.includes(token) : wordSet.has(token);
    if (ok) take(id, lc.indexOf(token.split(' ')[0]));
  }
  // fuzzy: typo-tolerant single-token match (edit distance <= 2 on 4+ char names)
  for (const w of words) {
    if (w.length < 4 || wordSet.has(w) && idx.some(r => r.token === w)) continue;
    let best: { id: number; pos: number } | null = null, bestD = 3;
    for (const { token, id } of idx) {
      if (token.includes(' ') || token.length < 4) continue;
      const d = lev(w, token);
      if (d < bestD) { bestD = d; best = { id, pos: lc.indexOf(w) }; }
    }
    if (best && bestD <= 2) take(best.id, best.pos);
  }
  return hits.sort((a, b) => a.pos - b.pos).map(h => h.id);
}
const FAMILIES: [string, RegExp][] = [
  ['man_mark', /\b(man.?marks?|marks?|stick (?:to|with|tight)|pick up|tracks?|tight on|shadow|stay with)\b/],
  ['target_player', /\b(feeds?|passes? to|give it to|finds?|look for|play it to|supply|service)\b/],
  ['shoot_on_sight', /\b(shoot on sight|shoots? more|shoots? from (?:range|distance|outside)|let fly|have a (?:go|crack|pop)|pull the trigger|test the keeper)\b/],
  ['get_forward', /\b(gets? forward|push(?:es)? up|bombs? on|get up the pitch|join the attack|attacks? more|overlap)\b/],
  ['sit_deep', /\b(sit deep|drops? back|stay back|hold position|sit back|stay deep|sits? in|don.?t go forward)\b/],
];
function parseConditions(lc: string): Directive['when'] {
  const when: Directive['when'] = {};
  let m: RegExpMatchArray | null;
  if (/\bfirst half\b/.test(lc)) when.toMin = 45;
  else if (/\bsecond half\b/.test(lc)) when.fromMin = 45;
  if ((m = lc.match(/last (\d+)\s*min/))) when.fromMin = Math.max(0, 90 - parseInt(m[1], 10));
  if ((m = lc.match(/(?:from|after)(?: the)?\s*(\d+)(?:st|nd|rd|th)?\b/))) when.fromMin = parseInt(m[1], 10);
  if ((m = lc.match(/first (\d+)\s*min/))) when.toMin = parseInt(m[1], 10);
  if (/\b(losing|behind|chasing|trailing)\b/.test(lc)) when.scoreState = 'losing';
  else if (/\b(winning|ahead|in front|protect.{0,8}lead|hold.{0,8}lead)\b/.test(lc)) when.scoreState = 'winning';
  else if (/\b(drawing|level|tied|all square)\b/.test(lc)) when.scoreState = 'drawing';
  return when;
}
function parseClause(clause: string, idx: NameRef[]): Directive | null {
  const lc = clause.toLowerCase();
  const fams = FAMILIES.filter(([, re]) => re.test(lc));
  if (fams.length !== 1) return null;                 // none or compound -> defer to LLM
  const kind = fams[0][0];
  const players = playersIn(clause, idx);
  const when = parseConditions(lc);
  if (kind === 'man_mark' || kind === 'target_player') {
    if (players.length < 2) return null;
    return { playerId: players[0], kind, targetId: players[1], when };
  }
  if (players.length < 1) return null;
  return { playerId: players[0], kind, when };
}
export function rulesParse(text: string, spec: MatchSpec): { directives: Directive[]; fullyParsed: boolean } {
  const idx = nameIndex(spec);
  const clauses = text.split(/[,.;\n]+|\bthen\b/i).map(c => c.trim()).filter(c => c.length > 2);
  if (!clauses.length) return { directives: [], fullyParsed: false };
  const directives: Directive[] = [];
  let allParsed = true;
  for (const c of clauses) {
    const d = parseClause(c, idx);
    if (d) directives.push(d); else allParsed = false;
  }
  return { directives, fullyParsed: allParsed && directives.length > 0 };
}

// Compile free text -> directives. The rules fast-path handles common orders
// instantly (no LLM); anything fuzzy falls back to the model. Cached by
// (roster + text) so a given instruction compiles once and replays are stable.
export async function compileTactics(text: string, spec: MatchSpec): Promise<CompileResult> {
  const ctx = rosterContext(spec);
  const cacheKey = `${ctx} ${text.trim()}`;
  const hit = cache.get(cacheKey);
  if (hit) return { directives: hit, raw: '', cached: true };
  // Fast-path: instant, offline, deterministic for clear orders.
  const rp = rulesParse(text, spec);
  if (rp.fullyParsed) {
    const directives = validate(rp.directives as unknown[]);
    cache.set(cacheKey, directives);
    return { directives, raw: 'rules', cached: false };
  }
  // No key: best-effort with whatever the rules parser did manage.
  if (!KEY) return { directives: validate(rp.directives as unknown[]), raw: 'rules', cached: false, error: 'TACTICS_LLM_API_KEY not set (see web/backend/.env)' };
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, temperature: 0, max_tokens: 512, messages: [
        { role: 'system', content: SYSTEM(ctx) }, { role: 'user', content: text },
      ] }),
      // Budget MiMo flash can queue under load (seconds normally, occasionally
      // much longer). The watch flow compiles while paused, so a generous cap is
      // fine; swap to a local model (Ollama) for instant + free if needed.
      signal: AbortSignal.timeout(60000),
    });
    const j = await res.json() as { choices?: { message?: { content?: string } }[]; error?: unknown };
    if (!res.ok) return { directives: [], raw: JSON.stringify(j).slice(0, 300), cached: false, error: `LLM ${res.status}` };
    const content = j.choices?.[0]?.message?.content ?? '[]';
    const directives = validate(extractArray(content));
    cache.set(cacheKey, directives);
    return { directives, raw: content, cached: false };
  } catch (e) {
    return { directives: [], raw: '', cached: false, error: e instanceof Error ? e.message : String(e) };
  }
}
