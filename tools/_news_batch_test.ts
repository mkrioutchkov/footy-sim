// Batched story-evolution test (news.ts aftermath). Proves the GAYLORD_BATCHING P0 win directly on
// the batched primitive: (1) ONE LLM call for N events (was 2N, sequential) — verified with a stub
// HTTP server that counts requests; (2) the no-key path still evolves EVERY event deterministically,
// in order. news.ts calls evolveSquadStories exactly once (single call site, no loop), so this is
// the whole-aftermath call budget.
//
//   npx tsx tools/_news_batch_test.ts
import { createServer } from 'node:http';

process.env.TACTICS_LLM_PROVIDER = 'http';

let pass = 0, fail = 0;
function check(c: boolean, m: string): void { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } }

const { evolveSquadStories } = await import('../web/backend/personality.ts');

const inputs = [
  { name: 'A', role: 'CF', backstory: 'A clinical striker.', tagline: 'Cold finisher', dev: 'Fresh off a match-ball hat-trick — box office now, and rises to the big occasion.' },
  { name: 'B', role: 'CB', backstory: 'A rugged defender.', tagline: 'No nonsense', dev: 'A rash sending-off laid bare the short fuse and fiery temper once again.' },
  { name: 'C', role: 'CM', backstory: 'A tidy passer.', tagline: 'Plays it simple', dev: 'A long lay-off has left him fragile, and he needs encouragement to rebuild.' },
];

// ── no key: every event evolves deterministically, in order ──────────────────────────────────
process.env.TACTICS_LLM_API_KEY = '';
const det = await evolveSquadStories(inputs);
check(det.length === 3, 'returns exactly one evolution per input');
check(det[0].backstory.startsWith(inputs[0].dev), 'no-key: the cue-rich development is prepended to the backstory');
check(det[0].tagline === 'Cold finisher', 'no-key: tagline preserved when not regenerated');
check(det[0].traits.ego > 50 && det[0].traits.bigGame > 50, 'no-key: hat-trick cues lift ego + bigGame');
check(det[1].traits.temperament > 50, 'no-key: red-card cues lift temperament');
check(det[2].traits.consistency < 50, 'no-key: long-injury cue dents consistency');

// ── with a provider: EXACTLY ONE request for N inputs, mapped in order ────────────────────────
let requestCount = 0;
const body = JSON.stringify([
  { backstory: 'EVO-0', tagline: 'tag0', traits: { temperament: 10, criticismResponse: 20, praiseResponse: 30, bigGame: 40, consistency: 50, leadership: 60, professionalism: 70, ego: 80 } },
  { backstory: 'EVO-1', tagline: 'tag1', traits: { temperament: 11, criticismResponse: 21, praiseResponse: 31, bigGame: 41, consistency: 51, leadership: 61, professionalism: 71, ego: 81 } },
  { backstory: 'EVO-2', tagline: 'tag2', traits: { temperament: 12, criticismResponse: 22, praiseResponse: 32, bigGame: 42, consistency: 52, leadership: 62, professionalism: 72, ego: 82 } },
]);
const server = createServer((_req, res) => { requestCount++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: body } }] })); });
await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
const port = (server.address() as { port: number }).port;
process.env.TACTICS_LLM_BASE_URL = `http://127.0.0.1:${port}`;
process.env.TACTICS_LLM_API_KEY = 'test-key';
const got = await evolveSquadStories(inputs);
check(requestCount === 1, `ONE LLM call for ${inputs.length} events (was 2N) — got ${requestCount}`);
check(got.length === 3 && got[0].backstory === 'EVO-0' && got[2].backstory === 'EVO-2', 'maps the batched response to inputs in order');
check(got[0].traits.ego === 80 && got[2].traits.ego === 82, 'per-entry traits parsed from the batched response');
server.close();

console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
