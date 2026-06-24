// Plain-English tactics compiler (P3). Turns a manager's free text into the
// engine's directive JSON, resolving player names to engine ids. LLM-ONLY — the
// model is the sole compiler (the old offline rules fast-path was removed; its
// fuzzy name-matcher mis-resolved orders). The provider/transport lives in
// llm.ts (OpenAI-compatible HTTP, or the Claude Code CLI on your subscription);
// configured via env in web/backend/.env, never in code.
import { chatComplete, llmReady, LlmError } from './llm.ts';

// Engine slot -> role (the 11 fixed formation slots; home ids 0..10, away 11..21).
const ROLE_SLOTS = ['GK', 'FB', 'CB', 'CB', 'FB', 'CM', 'CM', 'CM', 'WM', 'CF', 'WM'];
// Per-player kinds need a playerId; team-wide kinds need a teamScope (0/1).
const PLAYER_KINDS = ['man_mark', 'shoot_on_sight', 'get_forward', 'sit_deep', 'target_player',
  'stay_wide', 'come_inside', 'stay_central', 'cross_early', 'cutback', 'switch_play', 'play_simple',
  'run_in_behind', 'make_runs', 'come_short', 'check_to_feet', 'target_man_holdup', 'hold_it_up', 'dribble_more', 'press_hard', 'contain', 'tackle_hard', 'stay_on_feet', 'stay_back'];   // come_short/check_to_feet → DK::ComeShort; target_man_holdup/hold_it_up → DK::TargetManHoldup (WAVE-0/1 receive primitives, engine main.cpp)
const TEAM_KINDS = ['all_out_attack', 'park_the_bus', 'high_press', 'drop_off', 'play_it_long',
  'keep_it_on_ground', 'get_it_wide', 'play_narrow', 'push_up', 'slow_it_down',
  'counter_attack', 'offside_trap',
  'shoot_from_distance', 'work_it_into_box',   // opposing shot-selection pair → DK::ShootFromDistance/WorkItIntoBox (engine main.cpp; team shoot-range bias)
  // tactical-depth dials (FM team-instruction trio) — gradated, engine reads intensity 0-1 (0.5 = neutral):
  'press_intensity',   // 0=contain/no-chase … 1=high press
  'mentality',         // 0=ultra-defensive … 1=all-out attack (commits bodies forward, higher line, overlaps)
  'line_height'];      // 0=deep block … 1=aggressive high line + offside trap
export const VALID_KINDS = new Set([...PLAYER_KINDS, ...TEAM_KINDS]);
export const TEAM_KIND_SET = new Set(TEAM_KINDS);
const VALID_SCORE = new Set(['winning', 'drawing', 'losing', 'any']);
export type Side = 'home' | 'away';

export interface Directive {
  playerId: number;
  teamScope?: number;       // 0=home, 1=away (team-wide kinds); omitted for player-scoped
  kind: string;
  targetId?: number;
  intensity?: number;
  when?: { fromMin?: number; toMin?: number; scoreState?: string; scoreBy?: number; phase?: string };   // phase: in_possession/out_of_possession/transition (engine main.cpp CondPhase)
}

export interface CompileResult { directives: Directive[]; raw: string; cached: boolean; error?: string; note?: string; }

interface TeamSpec { players: { name: string }[] }
interface MatchSpec { home: TeamSpec; away: TeamSpec }

const cache = new Map<string, { directives: Directive[]; note: string }>();
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// Initials precomputed into the roster so the model matches "AB"/"DT" by lookup
// rather than (unreliably) computing them itself.
const initialsOf = (name: string) => name.split(/\s+/).filter(Boolean).map(w => w[0]).join('').toUpperCase();
function rosterContext(spec: MatchSpec, myTeam: Side): string {
  // Use the spec's per-slot role when present (a team on a non-default formation
  // emits it); fall back to the default 4-3-3 slot roles otherwise. Otherwise the
  // LLM would see e.g. a 3-5-2 wing-back labelled "CM" and misread the order.
  const line = (t: TeamSpec, off: number) =>
    t.players.slice(0, 11).map((p, i) => `id${off + i} ${p.name} [${initialsOf(p.name)}](${(p as any).role ?? ROLE_SLOTS[i]})`).join(', ');
  const tag = (s: Side) => (s === myTeam ? 'YOUR TEAM' : 'OPPONENT');
  return `${tag('home')} (HOME): ${line(spec.home, 0)}\n${tag('away')} (AWAY): ${line(spec.away, 11)}`;
}

const SYSTEM = (ctx: string, myTeam: Side) => {
  const myIds = myTeam === 'home' ? '0-10' : '11-21';
  const oppIds = myTeam === 'home' ? '11-21' : '0-10';
  const myScope = myTeam === 'home' ? 0 : 1;
  return `You are a football tactics compiler. Convert the manager's touchline shout into directives. Output ONLY a JSON object — no prose, no markdown, no comments:
{"directives":[ ...zero or more directive objects... ], "note":""}
- "directives": every order you can confidently map (may be []).
- "note": a SHORT, plain message to the manager, used ONLY to flag a problem — an order you couldn't map, a name that isn't in the squad, or an ambiguous / contradictory / nonsensical instruction. Leave it "" when everything mapped cleanly. Always MAP WHAT YOU CAN and note only the rest; never refuse with prose, and never invent a directive just to avoid an empty list.

YOU manage ${myTeam.toUpperCase()} (player ids ${myIds}); the opponent is ids ${oppIds}.
- "we/us/our/I/my/the lads/the team/everyone/all/the whole side" => YOUR players (${myIds}).
- "they/them/their/the opposition/the other lot" => the OPPONENT (${oppIds}).

DIRECTIVE: {"playerId":<your id, per-player kinds only>, "kind":<below>, "targetId":<id, only man_mark & target_player>, "intensity":<0.1-1>, "teamScope":${myScope} <team-wide kinds only>, "when":{"fromMin":<int>,"toMin":<int>,"scoreState":<winning|losing|drawing>,"scoreBy":<int>}}

PER-PLAYER kinds (need playerId; omit teamScope):
- man_mark (targetId=opponent): stick tight to / shadow / pick up / mark a specific opponent.
- target_player (targetId=team-mate): feed / supply / look for / give it to a team-mate.
- shoot_on_sight: shoot more / from range / let fly / test the keeper / pull the trigger.
- get_forward: push higher / join the attack / bomb on / get up the pitch / further forward / play striker / play up top / play as a striker / play up front / play further forward / lead the line / get him up there.
- sit_deep: drop back / sit deep / hold a deep position / play deeper / play as a holding mid / sit in front of the back four / anchor the midfield (take up a DEEP position).
- stay_back: don't bomb forward / don't overlap / hold your position / stay home / don't join the attack — keep his normal spot but DAMP his forward runs (distinct from sit_deep, which actually drops him deep).
- stay_wide: hug the touchline / stay wide / hold the width / stretch the play (winger/full-back).
- come_inside: tuck in / drift inside / cut inside.
- stay_central: stay central / hold the middle / don't drift wide.
- cross_early: whip it in / get your crosses in early / get it in the box / don't overdribble out wide.
- cutback: pull it back / cut it back / cut-backs / lay it across the box / square it from the byline — a LOW ball pulled back from near the goal line (distinct from cross_early's earlier, higher cross).
- switch_play: switch the play / spread it / change the angle / hit the far side.
- play_simple: keep it simple / one-twos / don't force it / safe passes / recycle it.
- run_in_behind: run in behind / get in behind / stretch them / make runs off the last man / go beyond.
- make_runs: make runs / keep moving / get on the move / offer the runs.
- come_short: come short to feet / check to feet / drop to link / receive between the lines / show for it / don't always run in behind — the per-player INVERSE of run_in_behind (drops toward the carrier to link play).
- target_man_holdup: play him as a target man / hold it up / hold-up play / lay it off / feet not runs / be an out-ball — a forward who holds the ball up with his back to goal and brings others in (NOT make_runs/run_in_behind).
- dribble_more: take them on / run at them / dribble more / beat your man / be direct 1v1.
- press_hard: press him / get after him / close him down / hound the ball / don't let him settle.
- contain: contain him / sit off him / jockey / show him inside / shepherd him — ease off a specific opponent rather than diving in (the per-player opposite of press_hard).
- tackle_hard: get stuck in / put a foot in / be aggressive in the challenge / win the ball back.
- stay_on_feet: stay on your feet / time the tackle / don't dive in / no rash challenges / don't get sent off — tackling DISCIPLINE (for "jockey/contain him", prefer the contain kind).

TEAM-WIDE kinds (set "teamScope":${myScope}, NO playerId) — for the whole side's shape/tempo:
- all_out_attack: throw everyone forward / gung-ho / chase the game / go for it.
- park_the_bus: shut up shop / defend the lead / everyone behind the ball / see it out.
- high_press: press high / hunt them down / win it back fast / get in their faces.
- drop_off: sit back as a team / drop deeper / give them nothing in behind (WHOLE-TEAM sit-off; for ONE player easing off an opponent use the per-player contain).
- play_it_long: go direct / hit it long / launch it / bypass the midfield / route one.
- keep_it_on_ground: pass it out / play through the lines / keep it on the deck / no hoofball.
- get_it_wide: use the wings / spread it / attack the flanks / get it out wide.
- play_narrow: stay compact / play through the middle / narrow.
- push_up: squeeze up / higher line / step up / push the line up.
- slow_it_down: keep the ball / game management / take the sting out / kill the tempo / waste time.
- counter_attack: break fast / hit them on the counter / catch them on the break / get out quick when we win it / spring the counter.
- offside_trap: play an offside trap / step up / catch them offside / squeeze and spring the line / hold a high line.
- shoot_from_distance: shoot from range / let fly from outside / pepper them / have a go / efforts from distance — extends the team's shot range.
- work_it_into_box: work it into the box / walk it in / no shots from distance / get a better chance — holds for a closer shot (opposite of shoot_from_distance).

TARGETING:
- Resolve names to ids from the rosters, tolerating typos/slang/phonetic spelling (e.g. "tanaka"=>Tanaka, "linqvist"=>Lindqvist, "rodri"=>Rodriguez).
- INITIALS / ABBREVIATIONS: a 2-letter token (or dotted, "a.b.") is the player's first+last initials — match it to the roster player with those initials (e.g. "AB"=>Aron Bauer, "DT"=>Diego Tanaka, "tl"=>Tomas Lindqvist). A single capital or nickname ("Bau", "Lindy") matches by prefix. If two players share initials, pick the more attacking/prominent one.
- "their striker"=>opponent CF; "their keeper"=>opponent GK; "their winger(s)"=>opponent WM; "their best player/playmaker"=>their most advanced central id. For man_mark the target is ALWAYS an OPPONENT — if a surname matches BOTH a team-mate and an opponent, pick the OPPONENT.
- A positional / role order maps to the nearest kind: "play striker/up top/up front/lead the line"=>get_forward; "play deeper/holding/anchor/sit in"=>sit_deep; "play wide/out wide/hug the line"=>stay_wide; "tuck in/play narrow/inside"=>come_inside. NEVER drop such an order as unreadable — pick the closest kind.
- CRITICAL: if a named player is NOT in either roster (no confident match — same person, allowing only typos/initials), DO NOT guess or substitute a different player. OMIT that directive (or output [] if it was the only order). A wrong target is worse than none — never map a name to an unrelated roster player just to produce output.
- COMPOUND orders: one message may hold SEVERAL instructions (split on commas, "and", "then", or new lines, and on switching to a new player). Emit ONE directive per instruction — e.g. "AB mark their 10 and tanaka get forward, kovac press" => three directives.
- Whole-team per-player intent ("all my midfielders get forward"): prefer a TEAM-WIDE kind if one fits; otherwise emit one per-player directive for each relevant id of YOUR team (midfielders=CM, defenders=CB/FB, forwards=CF/WM).

CONDITIONS ("when", almost always OMITTED):
- OMIT the "when" object ENTIRELY unless the order EXPLICITLY states a time window or the scoreline. A plain order ("stick to him", "play striker", "press high") has NO "when" — do NOT invent toMin/scoreState placeholders. Slang like "like a fly to shit" or "all game" is NOT a condition.
- Time (only if stated): "first half"=>toMin 45; "second half"=>fromMin 45; "last 20 min"=>fromMin 70; "after the 60th"/"from 60"=>fromMin 60; "first 15 min"=>toMin 15.
- Score (only if the order ties to the scoreline): scoreState + scoreBy.
- SEQUENCED orders ("press high for the first 20 then drop off", "go for it early then see it out"): emit TWO directives with complementary time windows — the first with toMin N, the second with fromMin N (e.g. high_press toMin 20, then drop_off fromMin 20).

WHEN TO WRITE A "note" (and emit fewer/no directives):
- Unknown player: a named player isn't in either squad => directives for the rest, note e.g. "There's no 'Zlatan' in the squad." Never substitute a different player.
- Ambiguous: the order is missing who or what (e.g. "stick to Lindqvist" with no marker named, "press" with no one named) => note e.g. "Who should mark Lindqvist?" Do NOT guess a player.
- Nonsense / not a tactic: gibberish, abuse, off-topic, or impossible ("asdf", insults, "make me a sandwich", "teleport", "play like Barcelona", "sub him off" — subs aren't directives) => directives [], note e.g. "That's not a tactical instruction I can apply." Keep it brief and neutral; do not refuse with a lecture.
- Contradictory: e.g. "sit deep but get forward" => map the clearer half (or neither) and note the conflict.
- Partial: map the valid parts; note the part you dropped (e.g. "Ignored 'do a barrel roll'.").
Prefer the most specific kind; keep intensity 1 unless the order implies more/less. A clean, fully-understood order has note "".

Rosters (ids fixed):
${ctx}`;
};

// Parse the model's reply into { directives, note }. Accepts the object form
// {"directives":[...],"note":"..."} and tolerates a bare [...] array (no note)
// for robustness against an off-format reply.
function extractResult(content: string): { directives: unknown[]; note: string } {
  const body = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    const v = JSON.parse(body);
    if (Array.isArray(v)) return { directives: v, note: '' };
    if (v && typeof v === 'object') return {
      directives: Array.isArray((v as any).directives) ? (v as any).directives : [],
      note: typeof (v as any).note === 'string' ? (v as any).note.trim() : '',
    };
  } catch { /* fall through to salvage */ }
  // Salvage: pull the first [...] array out of a malformed reply.
  const s = content.indexOf('['); const e = content.lastIndexOf(']');
  if (s >= 0 && e > s) {
    try { const v = JSON.parse(content.slice(s, e + 1)); if (Array.isArray(v)) return { directives: v, note: '' }; } catch { /* noop */ }
  }
  return { directives: [], note: '' };
}

// A "when" condition is only honoured if the manager's TEXT actually mentions a
// time window or the scoreline. The model otherwise stuffs placeholder
// conditions onto plain orders (e.g. toMin:90 + scoreState:"drawing" on "stick
// to him") which the UI then renders as "(first 90') when drawing". This guard
// strips any condition the words don't justify — independent of the model.
const TIME_WORDS = /\b(\d{1,3}\s*(?:'|min|mins|minute|minutes)|half|first|second|opening|closing|last|from the|after the|until|before|kick.?off|whistle|early on|late on)\b/i;
const SCORE_WORDS = /\b(winning|losing|drawing|level|tied|all square|ahead|behind|trailing|chasing|in front|leading|protect|see it out|goal up|goal down|a man (?:up|down)|nil|equaliser|equalizer)\b/i;

// Keep only well-formed, in-range directives; coerce the rest. Impossible /
// malformed entries are dropped so the engine only ever sees valid input.
function validate(raw: unknown[], myTeam: Side, text: string): Directive[] {
  const out: Directive[] = [];
  const myScope = myTeam === 'home' ? 0 : 1;
  const timeOK = TIME_WORDS.test(text);
  const scoreOK = SCORE_WORDS.test(text);
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const d = r as Record<string, unknown>;
    const kind = String(d.kind ?? '');
    if (!VALID_KINDS.has(kind)) continue;
    const intensity = Math.max(0, Math.min(1, num(d.intensity, 1)));
    let dir: Directive;
    if (TEAM_KIND_SET.has(kind)) {
      // Team-wide dial command: default to the manager's side; honour an explicit
      // valid teamScope (0/1) if the model set one (e.g. ordering the opponent).
      const ts = num(d.teamScope, myScope);
      dir = { playerId: -1, teamScope: ts === 0 || ts === 1 ? ts : myScope, kind, intensity };
    } else {
      const playerId = num(d.playerId, -1);
      if (playerId < 0 || playerId > 21) continue;
      dir = { playerId, kind, intensity };
      if (kind === 'man_mark' || kind === 'target_player') {
        const t = num(d.targetId, -1);
        if (t < 0 || t > 21) continue;          // these kinds need a valid target
        dir.targetId = t;
      }
    }
    const w = (d.when ?? {}) as Record<string, unknown>;
    const when: Directive['when'] = {};
    // Time window: only if the words mention time; a whole-match span (>=90) is
    // no real bound, so normalize it away (kills the spurious "(first 90')").
    const fromMin = Math.max(0, Math.round(num(w.fromMin, 0)));
    let toMin = Math.round(num(w.toMin, 1000));
    if (toMin >= 90) toMin = 1000;
    when.fromMin = timeOK ? fromMin : 0;
    when.toMin = timeOK ? toMin : 1000;
    // Scoreline: only if the words mention the score (else drop the placeholder).
    const ss = String(w.scoreState ?? 'any');
    when.scoreState = (scoreOK && VALID_SCORE.has(ss)) ? ss : 'any';
    when.scoreBy = scoreOK ? Math.round(num(w.scoreBy, 0)) : 0;
    dir.when = when;
    out.push(dir);
  }
  return out;
}

// Compile free text -> directives. LLM-ONLY: the model is the sole compiler.
// The old offline rules fast-path was REMOVED — its fuzzy name-matcher
// mis-resolved orders (a stray word like "cunt"/"stick", or an unknown name,
// matched to the wrong player). If the model is unreachable we degrade to NO
// directives + an error, rather than guess. Cached by (roster + text) so a
// given instruction compiles once and replays stay deterministic.
export async function compileTactics(text: string, spec: MatchSpec, myTeam: Side = 'home'): Promise<CompileResult> {
  const ctx = rosterContext(spec, myTeam);
  const cacheKey = `${ctx} ${text.trim()}`;
  const hit = cache.get(cacheKey);
  if (hit) return { directives: hit.directives, note: hit.note, raw: '', cached: true };
  const ready = llmReady();
  if (!ready.ok) return { directives: [], raw: '', cached: false, error: ready.error };
  let content: string;
  try {
    content = await chatComplete({ system: SYSTEM(ctx, myTeam), user: text, temperature: 0, maxTokens: 512, timeoutMs: 12000 });
  } catch (e) {
    return { directives: [], raw: '', cached: false,
      error: e instanceof LlmError ? e.userMessage : 'the tactics model was unreachable' };
  }
  const parsed = extractResult(content);
  const directives = validate(parsed.directives, myTeam, text);
  // Trust the model's note (it's told to leave it "" when all clean). Only
  // synthesize a generic nudge if it went silent — no directives AND no note.
  let note = parsed.note;
  if (!directives.length && !note) note = "I couldn't read that as a tactical order — name a player and what they should do.";
  cache.set(cacheKey, { directives, note });
  return { directives, note, raw: content, cached: false };
}
