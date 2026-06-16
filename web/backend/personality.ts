// Player personality generation (item 4.2). At squad creation each player gets an
// LLM-generated personality: 0-100 trait dials (so both the LLM and a future engine
// morale hook can read them) + nationality, backstory, tagline. Generated ONCE and
// persisted (players.personality). Same provider/env as tactics.ts / lineup.ts.
// The motivation loop (shout -> morale via these traits) is a later, separate step.
const BASE = (process.env.TACTICS_LLM_BASE_URL ?? 'https://api.groq.com/openai/v1').replace(/\/$/, '');
const MODEL = process.env.TACTICS_LLM_MODEL ?? 'llama-3.3-70b-versatile';
const KEY = process.env.TACTICS_LLM_API_KEY ?? '';

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
  if (!KEY || !players.length) return fallback();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: MODEL, temperature: 0.9, max_tokens: 2400, messages: [
          { role: 'system', content: SYSTEM }, { role: 'user', content: buildPrompt(players) },
        ] }),
        signal: AbortSignal.timeout(25000),
      });
      if ((res.status === 429 || res.status >= 500) && attempt === 0) {
        const ra = Number(res.headers.get('retry-after'));
        await new Promise(r => setTimeout(r, Math.min(Number.isFinite(ra) && ra > 0 ? ra : 1.5, 5) * 1000));
        continue;
      }
      const j = await res.json() as { choices?: { message?: { content?: string } }[] };
      if (res.ok) {
        const arr = extractArray(j.choices?.[0]?.message?.content ?? '');
        return players.map((p, i) => coerce(arr[i], p.name, p.role));
      }
      break;
    } catch { break; }
  }
  return fallback();
}
