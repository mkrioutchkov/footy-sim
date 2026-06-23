// Press conferences (LLM stream). The manager addresses the media; the statement's tone is
// judged against each player's personality dials to move their morale — a praise-hungry player
// lifts when you back him, a criticism-responsive one responds to a rocket while a sensitive or
// hot-headed one wilts. LLM-primary (same provider as personality.ts/tactics.ts) with a
// deterministic keyword fallback, so it never blocks. Reads the dials (the text↔dial coupling).
import { db } from './db.ts';
import { chatComplete, llmReady } from './llm.ts';

interface Dials { criticismResponse: number; praiseResponse: number; ego: number; temperament: number }
interface SquadMember { slot: number; name: string; traits: Dials }
export interface PressReaction { slot: number; name: string; delta: number; quote?: string }

const clampDelta = (v: number) => Math.max(-15, Math.min(15, Math.round(v)));

// Deterministic tone read of the statement: +1 praising/confident .. -1 critical.
const PRAISE = ['proud', 'brilliant', 'best', 'confident in', 'back the', 'great', 'delighted', 'fantastic', 'believe in', 'top', 'quality', 'magnificent', 'buzzing'];
const CRIT = ['not good enough', 'disappointed', 'must do better', 'unacceptable', 'angry', 'poor', 'embarrassing', 'sloppy', 'wake up', 'demand more', 'not happy', 'no excuses'];
const CONFIDENT = ['calm', 'focused', 'process', 'one game at a time', 'take each', 'no pressure', 'quietly confident', 'prepared', 'ready'];
function toneOf(text: string): number {
  const t = text.toLowerCase();
  const score = PRAISE.filter(k => t.includes(k)).length + CONFIDENT.filter(k => t.includes(k)).length * 0.5 - CRIT.filter(k => t.includes(k)).length;
  return Math.max(-1, Math.min(1, score / 2));
}
// A player's morale shift from a tone, via their dials.
function deterministicDelta(tone: number, d: Dials): number {
  const pr = d.praiseResponse / 100, cr = d.criticismResponse / 100, ego = d.ego / 100, temp = d.temperament / 100;
  if (tone >= 0) return clampDelta(tone * (5 + pr * 10 + ego * 3));          // praise lifts the praise-hungry + egos
  return clampDelta((-tone) * (cr * 14 - (1 - cr) * 9 - temp * 4));          // criticism: lifts the responsive, dents the sensitive + hotheads
}

function extractArray(content: string): unknown[] {
  const body = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { const v = JSON.parse(body); if (Array.isArray(v)) return v; if (v && Array.isArray((v as any).reactions)) return (v as any).reactions; } catch { /* salvage */ }
  const s = content.indexOf('['), e = content.lastIndexOf(']');
  if (s >= 0 && e > s) { try { const v = JSON.parse(content.slice(s, e + 1)); if (Array.isArray(v)) return v; } catch { /* noop */ } }
  return [];
}

const SYSTEM = `You judge how a football manager's press-conference statement lands with each of his players, returning ONE reaction per player IN ORDER. Output ONLY a JSON array of objects [{"delta":-15..15,"quote":"..."}]. Use each player's dials (0-100): praiseResponse = how much praise lifts them; criticismResponse = HIGH thrives on a public rocket / LOW wilts under it; ego = self-importance (loves praise, bristles at criticism); temperament = HIGH is fiery (reacts badly to criticism). A warm/backing statement lifts most players (most the praise-hungry + big egos); a critical statement lifts the criticism-responsive but dents the sensitive and the hot-heads. Keep deltas modest (most within ±10). "quote" is a SHORT first-person in-character line (max ~12 words) showing how it landed for that player given his dials — terse and natural, no name prefix. Return EXACTLY one object per player, in order.`;

// LLM-primary morale reactions; deterministic keyword judge as the always-available fallback.
export async function judgePressConference(text: string, squad: SquadMember[]): Promise<PressReaction[]> {
  const tone = toneOf(text);
  const fallback = () => squad.map(m => ({ slot: m.slot, name: m.name, delta: deterministicDelta(tone, m.traits) }));
  if (!llmReady().ok || !text.trim() || !squad.length) return fallback();
  try {
    const lines = squad.map((m, i) => `${i + 1}. ${m.name} — praiseResponse ${m.traits.praiseResponse}, criticismResponse ${m.traits.criticismResponse}, ego ${m.traits.ego}, temperament ${m.traits.temperament}`).join('\n');
    const arr = extractArray(await chatComplete({
      system: SYSTEM,
      user: `Statement: "${text}"\n\nPlayers:\n${lines}`,
      temperature: 0.4, maxTokens: 1600, timeoutMs: 20000,
    }));
    if (arr.length) return squad.map((m, i) => {
      const obj = arr[i] as { delta?: unknown; quote?: unknown } | undefined;
      const raw = obj?.delta;
      // accept only a real number or a non-empty numeric string; null/""/[]/false etc. fall
      // back to the deterministic per-player delta (unary + coerces those to a finite 0).
      const n = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN);
      const quote = typeof obj?.quote === 'string' && obj.quote.trim() ? obj.quote.trim().slice(0, 140) : undefined;
      return { slot: m.slot, name: m.name, delta: Number.isFinite(n) ? clampDelta(n) : deterministicDelta(tone, m.traits), quote };
    });
  } catch { /* unreachable / no-key / bad output — fall through */ }
  return fallback();
}

const parseJSON = (s: string | null): unknown => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

// Hold a press conference for a club: judge the statement + apply the morale changes.
export async function applyPressConference(teamId: number, text: string): Promise<{ reactions: PressReaction[]; lifted: number; unsettled: number }> {
  const rows = db.prepare('SELECT slot, name, personality FROM players WHERE team_id = ? ORDER BY slot').all(teamId) as
    { slot: number; name: string; personality: string | null }[];
  const squad: SquadMember[] = rows.map(r => {
    const tr = ((parseJSON(r.personality) as { traits?: Partial<Dials> } | null)?.traits) ?? {};
    return { slot: r.slot, name: r.name, traits: { criticismResponse: tr.criticismResponse ?? 50, praiseResponse: tr.praiseResponse ?? 50, ego: tr.ego ?? 50, temperament: tr.temperament ?? 50 } };
  });
  const reactions = await judgePressConference(text, squad);
  // Apply each delta to the player's CURRENT morale IN SQL (clamped), not a pre-await snapshot
  // + delta — so it composes atomically with a concurrent matchday morale tick instead of
  // clobbering it (the read-modify-write must not span the multi-second LLM await).
  const upd = db.prepare('UPDATE players SET morale = MAX(0, MIN(100, morale + ?)) WHERE team_id = ? AND slot = ?');
  for (const r of reactions) upd.run(r.delta, teamId, r.slot);
  return { reactions, lifted: reactions.filter(r => r.delta > 0).length, unsettled: reactions.filter(r => r.delta < 0).length };
}
