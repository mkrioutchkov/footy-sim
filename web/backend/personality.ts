// Player personality generation (item 4.2). At squad creation each player gets an
// LLM-generated personality: 0-100 trait dials (so both the LLM and a future engine
// morale hook can read them) + nationality, backstory, tagline. Generated ONCE and
// persisted (players.personality). Same provider/env as tactics.ts / lineup.ts.
// The motivation loop (shout -> morale via these traits) is a later, separate step.
import { chatComplete, llmReady } from './llm.ts';

const cap = (s: string, n = 380): string => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

export interface Traits {
  temperament: number; criticismResponse: number; praiseResponse: number; bigGame: number;
  consistency: number; leadership: number; professionalism: number; ego: number;
}
export interface Personality { traits: Traits; nationality: string; backstory: string; tagline: string; }

const TRAIT_KEYS: (keyof Traits)[] = ['temperament', 'criticismResponse', 'praiseResponse', 'bigGame', 'consistency', 'leadership', 'professionalism', 'ego'];
const clamp = (v: unknown) => Math.max(0, Math.min(100, Math.round(Number.isFinite(+(v as number)) ? +(v as number) : 50)));

// A neutral fallback so the game never blocks on the model — every player still
// gets a usable (if bland) personality if the LLM is unreachable or off-format.
export function defaultPersonality(_name: string, role: string): Personality {
  return {
    traits: { temperament: 50, criticismResponse: 50, praiseResponse: 50, bigGame: 50, consistency: 50, leadership: role === 'GK' || role === 'CB' ? 60 : 50, professionalism: 50, ego: 50 },
    nationality: '', backstory: '', tagline: '',
  };
}

// ── Text → dials (the canonical coupling) ────────────────────────────────────
// The trait dials are the machine-readable PROJECTION of a player's backstory. The
// engine-facing weights (training rate in training.ts, transfer value in game.ts) read
// ONLY the dials, so they stay deterministic — but they must re-derive whenever the
// story changes. deriveTraits() is that re-derivation: the LLM is the rich primary, and
// deriveTraitsFromText() is a deterministic keyword projection that never blocks. See the
// project memory on the text↔dial coupling.
const TRAIT_CUES: Record<keyof Traits, { up: string[]; down: string[] }> = {
  professionalism: { up: ['professional', 'dedicat', 'model pro', 'disciplin', 'hard work', 'grafter', 'diligent', 'meticulous', 'first to train', 'studious'], down: ['lazy', 'party', 'unprofessional', 'trouble', 'turns up late', 'nightlife', 'wayward', 'undisciplined', 'casual'] },
  temperament: { up: ['fiery', 'hothead', 'hot-head', 'temper', 'volatile', 'rash', 'short fuse', 'aggressive', 'combust', 'wind-up'], down: ['ice-cool', 'ice cool', 'calm', 'composed', 'cool head', 'unflappable', 'serene', 'level-headed'] },
  consistency: { up: ['consistent', 'reliable', 'metronom', 'dependable', 'ever-present', 'machine', 'rock', 'week in week out'], down: ['inconsistent', 'erratic', 'streaky', 'flaky', 'fragile', 'mercurial', 'maddening', 'on his day'] },
  leadership: { up: ['captain', 'leader', 'commands', 'organis', 'organiz', 'vocal', 'talisman', 'general', 'drives the', 'inspires'], down: ['quiet', 'follower', 'timid', 'shy', 'keeps to himself', 'leads by example only'] },
  bigGame: { up: ['big-game', 'big game', 'clutch', 'rises to', 'big occasion', 'cup specialist', 'when it matters', 'thrives under pressure', 'finals'], down: ['bottler', 'shrinks', 'freezes', 'goes missing', 'flat-track', 'fades on the big'] },
  ego: { up: ['ego', 'arrogant', 'self-important', 'diva', 'prima donna', 'entitled', 'me-first', 'box office', 'showman'], down: ['humble', 'selfless', 'team-first', 'modest', 'grounded', 'unassuming', 'no fuss'] },
  criticismResponse: { up: ['thrives on criticism', 'responds to a rocket', 'needs the hairdryer', 'channels criticism', 'point to prove'], down: ['wilts', 'sensitive to criticism', 'crumbles', 'sulks', 'thin-skinned'] },
  praiseResponse: { up: ['loves praise', 'needs encouragement', 'confidence player', 'feeds off', 'flourishes when backed', 'arm round'], down: ['unmoved by praise', 'takes praise in stride', 'praise rolls off'] },
};
const CUE_STEP = 18;
export function deriveTraitsFromText(backstory: string, tagline: string, role: string): Traits {
  const text = `${backstory} ${tagline}`.toLowerCase();
  const base = defaultPersonality('', role).traits;     // role baseline (GK/CB lean leaderly)
  const out = {} as Traits;
  for (const k of TRAIT_KEYS) {
    let v = base[k];
    for (const cue of TRAIT_CUES[k].up) if (text.includes(cue)) v += CUE_STEP;
    for (const cue of TRAIT_CUES[k].down) if (text.includes(cue)) v -= CUE_STEP;
    out[k] = Math.max(0, Math.min(100, Math.round(v)));
  }
  return out;
}

function extractObject(content: string): Record<string, unknown> | null {
  const body = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { const v = JSON.parse(body); if (v && typeof v === 'object') return v as Record<string, unknown>; } catch { /* salvage */ }
  const s = content.indexOf('{'), e = content.lastIndexOf('}');
  if (s >= 0 && e > s) { try { const v = JSON.parse(content.slice(s, e + 1)); if (v && typeof v === 'object') return v as Record<string, unknown>; } catch { /* noop */ } }
  return null;
}

const DERIVE_SYSTEM = `You convert one football player's backstory into 8 personality trait dials (0-100) that FAITHFULLY match the text. Output ONLY a JSON object: {"traits":{"temperament":0-100,"criticismResponse":0-100,"praiseResponse":0-100,"bigGame":0-100,"consistency":0-100,"leadership":0-100,"professionalism":0-100,"ego":0-100}}
Meanings (0=low,100=high): temperament=fiery vs ice-cool; criticismResponse=HIGH thrives on a rocket / LOW wilts; praiseResponse=how much praise lifts them; bigGame=steps up on the big occasion; consistency=match-to-match reliability; leadership=drives team-mates; professionalism=training/lifestyle; ego=self-importance. Reflect the backstory exactly — a "model professional" scores high professionalism, a "hothead" high temperament, etc.`;

// Re-derive a player's trait dials from their (possibly just-edited or evolved) story.
// LLM primary, deterministic keyword projection as the always-available fallback.
export async function deriveTraits(name: string, role: string, backstory: string, tagline: string): Promise<Traits> {
  const fallback = () => deriveTraitsFromText(backstory, tagline, role);
  if (!llmReady().ok || !backstory.trim()) return fallback();
  try {
    const text = await chatComplete({
      system: DERIVE_SYSTEM,
      user: `${name} — ${role}.\nBackstory: ${backstory}\nTagline: ${tagline}`,
      temperature: 0.3, maxTokens: 300, timeoutMs: 20000,
    });
    const o = extractObject(text);
    const t = (o?.traits ?? o) as Record<string, unknown> | null;
    if (t) { const out = {} as Traits; for (const k of TRAIT_KEYS) out[k] = clamp(t[k]); return out; }
  } catch { /* unreachable / no-key / bad output — fall through */ }
  return fallback();
}

function coerce(raw: unknown, name: string, role: string): Personality {
  const d = defaultPersonality(name, role);
  if (!raw || typeof raw !== 'object') return d;
  const o = raw as Record<string, unknown>;
  const t = (o.traits ?? {}) as Record<string, unknown>;
  const traits = {} as Traits;
  for (const k of TRAIT_KEYS) traits[k] = clamp(t[k]);
  return {
    traits,
    nationality: typeof o.nationality === 'string' ? o.nationality.slice(0, 40) : '',
    backstory: typeof o.backstory === 'string' ? o.backstory.slice(0, 400) : '',
    tagline: typeof o.tagline === 'string' ? o.tagline.slice(0, 80) : '',
  };
}

const SYSTEM = `You generate football player personalities for a management sim. Given a squad, return ONE personality per player, VARIED across the squad — mix hotheads, model pros, fragile talents, grizzled leaders, quiet grafters, big egos. Output ONLY a JSON array, one object per input player IN ORDER:
[{"traits":{"temperament":0-100,"criticismResponse":0-100,"praiseResponse":0-100,"bigGame":0-100,"consistency":0-100,"leadership":0-100,"professionalism":0-100,"ego":0-100},"nationality":"<a country>","backstory":"2-3 sentences","tagline":"<=6 words, in character"}]
Trait meanings (0=low,100=high): temperament=fiery vs ice-cool; criticismResponse=HIGH thrives on a rocket / LOW wilts at it; praiseResponse=how much praise lifts them; bigGame=steps up on the big occasion; consistency=match-to-match reliability; leadership=drives team-mates; professionalism=training/lifestyle; ego=self-importance (high ego risks complacency on praise). Make the dials match the backstory. Keepers and centre-backs lean a bit higher on leadership. Keep backstories grounded and distinct. Return EXACTLY one entry per player, in the given order.`;

function buildPrompt(players: { name: string; role: string; attrs: Record<string, number> }[]): string {
  const ovr = (a: Record<string, number>) => Math.round(Object.values(a).reduce((s, v) => s + v, 0) / Math.max(1, Object.keys(a).length));
  const lines = players.slice(0, 11).map((p, i) => `${i + 1}. ${p.name} — ${p.role}, OVR ${ovr(p.attrs)}`).join('\n');
  return `Generate personalities for these ${Math.min(11, players.length)} players:\n${lines}`;
}

function extractArray(content: string): unknown[] {
  const body = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { const v = JSON.parse(body); if (Array.isArray(v)) return v; if (v && Array.isArray((v as any).players)) return (v as any).players; } catch { /* salvage */ }
  const s = content.indexOf('['), e = content.lastIndexOf(']');
  if (s >= 0 && e > s) { try { const v = JSON.parse(content.slice(s, e + 1)); if (Array.isArray(v)) return v; } catch { /* noop */ } }
  return [];
}

// Generate a personality per player (LLM, one batched call). Always returns exactly
// players.length entries — any the model omits or mangles fall back to neutral.
export async function generateSquadPersonalities(players: { name: string; role: string; attrs: Record<string, number> }[]): Promise<Personality[]> {
  const fallback = () => players.map(p => defaultPersonality(p.name, p.role));
  if (!llmReady().ok || !players.length) return fallback();
  try {
    // chatComplete handles the 429/5xx retry-once on the http path; needs ~2400 tokens for the batch.
    const text = await chatComplete({ system: SYSTEM, user: buildPrompt(players), temperature: 0.9, maxTokens: 2400, timeoutMs: 25000 });
    const arr = extractArray(text);
    return players.map((p, i) => coerce(arr[i], p.name, p.role));
  } catch { return fallback(); }
}

// ── Batched story evolution (news.ts aftermath) ──────────────────────────────
// One LLM call evolves a whole matchday's standout/injured players AND re-derives their dials in
// the SAME response — collapsing the old per-event rewrite→derive chain (2 calls × N events,
// sequential) into ONE call. The dominant matchday latency on the per-call cold-start transports
// (claude-code spawns a fresh process per chatComplete). Routes through llm.ts so it uses the
// configured provider; deterministic per-event fallback (dev prepended so its cue phrases survive
// the cap, then the keyword projection) keeps it non-blocking with no key. Always returns exactly
// inputs.length entries IN ORDER.
export interface EvolveInput { name: string; role: string; backstory: string; tagline: string; dev: string }
export interface StoryEvolution { backstory: string; tagline: string; traits: Traits }

const EVOLVE_SYSTEM = `You evolve football players' backstories after a development in each one's career, and convert each evolved story into 8 trait dials. Keep each player's established character but weave the new development in. Output ONLY a JSON array, one object per input player IN ORDER:
[{"backstory":"2-3 sentences","tagline":"<=6 words, in character","traits":{"temperament":0-100,"criticismResponse":0-100,"praiseResponse":0-100,"bigGame":0-100,"consistency":0-100,"leadership":0-100,"professionalism":0-100,"ego":0-100}}]
Trait meanings (0=low,100=high): temperament=fiery vs ice-cool; criticismResponse=HIGH thrives on a rocket / LOW wilts; praiseResponse=how much praise lifts them; bigGame=steps up on the big occasion; consistency=match-to-match reliability; leadership=drives team-mates; professionalism=training/lifestyle; ego=self-importance. Make the dials match the EVOLVED backstory. Return EXACTLY one entry per input, in the given order.`;

function buildEvolvePrompt(inputs: EvolveInput[]): string {
  const lines = inputs.map((it, i) => `${i + 1}. ${it.name} — ${it.role}.\n   Current backstory: ${it.backstory || '(none yet)'}\n   Development: ${it.dev}`).join('\n');
  return `Evolve these ${inputs.length} players' stories around each development:\n${lines}`;
}

export async function evolveSquadStories(inputs: EvolveInput[]): Promise<StoryEvolution[]> {
  // Deterministic per-event evolution: prepend the cue-rich development (so its phrases survive the
  // length cap and the keyword re-derive even on a season-grown backstory), keep the tagline.
  const fallback = (): StoryEvolution[] => inputs.map(it => {
    const backstory = cap(it.backstory ? `${it.dev} ${it.backstory}` : it.dev);
    return { backstory, tagline: it.tagline, traits: deriveTraitsFromText(backstory, it.tagline, it.role) };
  });
  const ready = llmReady();
  if (!ready.ok || !inputs.length) return fallback();
  let content: string;
  try {
    content = await chatComplete({
      system: EVOLVE_SYSTEM, user: buildEvolvePrompt(inputs),
      temperature: 0.7, maxTokens: Math.min(2400, 220 * inputs.length + 200), timeoutMs: 25000,
    });
  } catch { return fallback(); }
  const arr = extractArray(content);
  const fb = fallback();
  return inputs.map((it, i) => {
    const o = arr[i] as Record<string, unknown> | undefined;
    if (!o || typeof o !== 'object') return fb[i];                            // model omitted/mangled this one
    const backstory = typeof o.backstory === 'string' && o.backstory.trim() ? cap(o.backstory.trim()) : fb[i].backstory;
    const tagline = typeof o.tagline === 'string' && o.tagline.trim() ? o.tagline.trim().slice(0, 80) : it.tagline;
    const t = (o.traits ?? o) as Record<string, unknown> | null;
    const traits = {} as Traits;
    if (t && typeof t === 'object') for (const k of TRAIT_KEYS) traits[k] = clamp(t[k]);
    else return { backstory, tagline, traits: deriveTraitsFromText(backstory, tagline, it.role) };
    return { backstory, tagline, traits };
  });
}
