// LIVE→batch LLM fallback test. A local mock OpenAI-compatible server stands in for a WORKING
// provider; a dead port stands in for a DOWN one. Proves: an interactive (live) call whose live
// provider is down falls back to the batch provider; a batch call never falls back; a live call with
// no distinct live provider doesn't fall back; a healthy live provider is used directly.
//   npx tsx tools/_llm_fallback_test.ts
import http from 'node:http';

let pass = 0, fail = 0;
const check = (c: boolean, m: string): void => { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } };

const { chatComplete } = await import('../web/backend/llm.ts');

// a mock OpenAI-compatible /chat/completions that always returns a known completion
const server = http.createServer((_req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message: { content: '{"src":"from-mock"}' } }] }));
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;
const MOCK = `http://127.0.0.1:${port}/v1`;
const DEAD = 'http://127.0.0.1:1/v1';   // connection refused → provider "down"

const clearEnv = (): void => { for (const k of Object.keys(process.env)) if (k.startsWith('TACTICS_LLM_')) delete process.env[k]; };
const set = (o: Record<string, string>): void => { for (const [k, v] of Object.entries(o)) process.env[k] = v; };
const tryChat = async (live: boolean): Promise<string> => {
  try { return await chatComplete({ system: 's', user: 'u', live, timeoutMs: 2500 }); }
  catch (e: any) { return 'THREW:' + (e?.message ?? e); }
};

// 1. LIVE fallback fires: live provider dead, batch=mock works → the live call lands on the mock
clearEnv();
set({ TACTICS_LLM_PROVIDER: 'http', TACTICS_LLM_BASE_URL: MOCK, TACTICS_LLM_API_KEY: 'x', TACTICS_LLM_MODEL: 'batch',
  TACTICS_LLM_LIVE_PROVIDER: 'http', TACTICS_LLM_LIVE_BASE_URL: DEAD, TACTICS_LLM_LIVE_API_KEY: 'x', TACTICS_LLM_LIVE_MODEL: 'live' });
const r1 = await tryChat(true);
check(r1.includes('from-mock'), `a live call falls back to the batch provider when the live one is down (got: ${r1})`);

// 2. BATCH never falls back: dead default, no live provider → throws
clearEnv();
set({ TACTICS_LLM_PROVIDER: 'http', TACTICS_LLM_BASE_URL: DEAD, TACTICS_LLM_API_KEY: 'x' });
check((await tryChat(false)).startsWith('THREW'), 'a batch call to a dead provider throws (no fallback — determinism)');

// 3. LIVE with no DISTINCT live provider → no fallback (uses the default; dead → throws)
clearEnv();
set({ TACTICS_LLM_PROVIDER: 'http', TACTICS_LLM_BASE_URL: DEAD, TACTICS_LLM_API_KEY: 'x' });
check((await tryChat(true)).startsWith('THREW'), 'a live call with no distinct live provider does not fall back');

// 4. healthy live provider is used directly (batch dead, but never consulted)
clearEnv();
set({ TACTICS_LLM_PROVIDER: 'http', TACTICS_LLM_BASE_URL: DEAD, TACTICS_LLM_API_KEY: 'x', TACTICS_LLM_MODEL: 'batch',
  TACTICS_LLM_LIVE_PROVIDER: 'http', TACTICS_LLM_LIVE_BASE_URL: MOCK, TACTICS_LLM_LIVE_API_KEY: 'x', TACTICS_LLM_LIVE_MODEL: 'live' });
const r4 = await tryChat(true);
check(r4.includes('from-mock'), `a healthy live provider is used directly (got: ${r4})`);

// Close the mock server (dropping fetch's keep-alive sockets) and let the event loop drain instead of
// calling process.exit(): a hard exit here trips libuv's "UV_HANDLE_CLOSING" assertion on Windows,
// which turned a clean PASS into exit code 127.
server.closeAllConnections();
await new Promise<void>(r => server.close(() => r()));
console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
