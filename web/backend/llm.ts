// Provider-agnostic LLM transport shared by the tactics / plan / lineup compilers.
// Two backends, chosen by TACTICS_LLM_PROVIDER:
//
//   'http' (default) — any OpenAI-compatible /chat/completions endpoint (Groq,
//       Anthropic's OpenAI-compat layer, a local Ollama, …). Config:
//         TACTICS_LLM_BASE_URL  (default https://api.groq.com/openai/v1)
//         TACTICS_LLM_MODEL     (default llama-3.3-70b-versatile)
//         TACTICS_LLM_API_KEY   (required to call)
//
//   'claude-code' — spawn the local Claude Code CLI in headless mode. This runs on
//       your Max/Pro SUBSCRIPTION (the CLI's OAuth login), NOT pay-as-you-go API
//       credits — provided ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN are not set
//       (we scrub them from the child env so the subscription credential wins).
//       Needs a ONE-TIME `claude /login` (or `claude setup-token`) on the standalone
//       CLI — the desktop app's session is package-scoped and not shared. Config:
//         TACTICS_LLM_MODEL       the --model alias/id (e.g. 'haiku', 'claude-haiku-4-5')
//         TACTICS_LLM_CLAUDE_BIN  optional explicit path to claude(.exe); else it is
//                                 auto-discovered (newest %APPDATA%\Claude\claude-code\*
//                                 on Windows, else `claude` on PATH).
//
// chatComplete() returns the assistant's message TEXT; each caller runs its own
// JSON extract/validate on it (the prompts ask for JSON; neither backend guarantees
// schema-valid output, so the salvage parsers stay). It THROWS on failure: an
// LlmError carries a user-facing `userMessage` callers surface verbatim (e.g. the
// not-logged-in hint); any other error maps to the caller's generic note.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type LlmProvider = 'http' | 'claude-code';
export function llmProvider(): LlmProvider {
  return process.env.TACTICS_LLM_PROVIDER === 'claude-code' ? 'claude-code' : 'http';
}

// Failure carrying a message meant for the manager (shown in the tactics receipt).
// (Explicit field + assignment, not a constructor parameter property — the backend's
// erasableSyntaxOnly gate forbids parameter properties.)
export class LlmError extends Error {
  readonly userMessage: string;
  constructor(message: string, userMessage: string) {
    super(message);
    this.name = 'LlmError';
    this.userMessage = userMessage;
  }
}

export interface ChatRequest {
  system: string;
  user: string;
  temperature?: number;   // http only (the claude-code CLI has no temperature flag)
  maxTokens?: number;     // http only
  timeoutMs?: number;     // http: exact; claude-code: floored to leave CLI cold-start headroom
}

// Pre-flight readiness — mirrors the old `if (!KEY)` early guard so a caller returns
// the same note without attempting a call.
export function llmReady(): { ok: true } | { ok: false; error: string } {
  if (llmProvider() === 'claude-code') {
    return resolveClaudeBin()
      ? { ok: true }
      : { ok: false, error: 'Claude Code CLI not found — set TACTICS_LLM_CLAUDE_BIN or add `claude` to PATH.' };
  }
  return (process.env.TACTICS_LLM_API_KEY ?? '')
    ? { ok: true }
    : { ok: false, error: 'TACTICS_LLM_API_KEY not set (see web/backend/.env)' };
}

export async function chatComplete(req: ChatRequest): Promise<string> {
  return llmProvider() === 'claude-code' ? claudeCodeChat(req) : httpChat(req);
}

// ── HTTP (OpenAI-compatible) ─────────────────────────────────────────────────
async function httpChat(req: ChatRequest): Promise<string> {
  const BASE = (process.env.TACTICS_LLM_BASE_URL ?? 'https://api.groq.com/openai/v1').replace(/\/$/, '');
  const MODEL = process.env.TACTICS_LLM_MODEL ?? 'llama-3.3-70b-versatile';
  const KEY = process.env.TACTICS_LLM_API_KEY ?? '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, temperature: req.temperature ?? 0, max_tokens: req.maxTokens ?? 512, messages: [
        { role: 'system', content: req.system }, { role: 'user', content: req.user },
      ] }),
      signal: AbortSignal.timeout(req.timeoutMs ?? 12000),
    });
    // Rate-limited (429) or transient 5xx: wait the suggested time and retry once.
    if ((res.status === 429 || res.status >= 500) && attempt === 0) {
      const ra = Number(res.headers.get('retry-after'));
      await new Promise(r => setTimeout(r, Math.min(Number.isFinite(ra) && ra > 0 ? ra : 1.2, 4) * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
    const j = await res.json() as { choices?: { message?: { content?: string } }[] };
    return j.choices?.[0]?.message?.content ?? '';
  }
  throw new Error('LLM retries exhausted');
}

// ── Claude Code CLI (subscription, headless) ─────────────────────────────────
// Tools the compiler must never reach for — it is a pure text→JSON transform. We
// also replace the default agent system prompt (--system-prompt) so it gets ONLY
// our compiler instructions, and run in a throwaway cwd.
const TOOLS_OFF = ['Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite'];

function cmpVersionDesc(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0), pb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pb[i] ?? 0) - (pa[i] ?? 0); if (d) return d; }
  return 0;
}

function resolveClaudeBin(): string | null {
  const override = process.env.TACTICS_LLM_CLAUDE_BIN;
  if (override) return existsSync(override) ? override : null;
  if (process.platform === 'win32') {
    // The desktop app bundles the CLI here; pick the newest version so app updates
    // don't strand a hardcoded path.
    const root = path.join(process.env.APPDATA ?? '', 'Claude', 'claude-code');
    if (existsSync(root)) {
      const versions = readdirSync(root)
        .filter(d => existsSync(path.join(root, d, 'claude.exe')))
        .sort(cmpVersionDesc);
      if (versions.length) return path.join(root, versions[0], 'claude.exe');
    }
  }
  return 'claude';   // assume on PATH (unix, or user-added)
}

async function claudeCodeChat(req: ChatRequest): Promise<string> {
  const bin = resolveClaudeBin();
  if (!bin) throw new LlmError('claude binary not found', 'Claude Code CLI not found — set TACTICS_LLM_CLAUDE_BIN or add `claude` to PATH.');
  const model = process.env.TACTICS_LLM_MODEL || 'haiku';
  // --print + piped stdin = the user prompt; --system-prompt replaces the default;
  // --disallowed-tools is variadic so it goes LAST (it would otherwise swallow flags).
  const args = ['--print', '--model', model, '--output-format', 'json', '--system-prompt', req.system, '--disallowed-tools', ...TOOLS_OFF];
  // Force subscription auth: an API key/token in the env would silently switch to API billing.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  const timeoutMs = Math.max(req.timeoutMs ?? 12000, 60000);   // CLI boot + model needs headroom
  const raw = await runProcess(bin, args, req.user, env, timeoutMs);
  let env_;   // the Claude Code result envelope: { type, subtype, is_error, result, ... }
  try { env_ = JSON.parse(raw) as { result?: string; is_error?: boolean }; }
  catch { throw new Error(`claude: unparseable output: ${raw.slice(0, 200)}`); }
  const text = typeof env_.result === 'string' ? env_.result : '';
  if (env_.is_error) {
    if (/not logged in|\/login|setup-token|authenticat/i.test(text))
      throw new LlmError(`claude not logged in: ${text}`, 'Claude Code CLI not logged in — run `claude /login` (or `claude setup-token`) once in a terminal.');
    throw new Error(`claude error: ${text.slice(0, 200)}`);
  }
  return text;
}

function runProcess(bin: string, args: string[], stdin: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, windowsHide: true, cwd: os.tmpdir() });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('claude timed out')); }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(new LlmError(`spawn failed: ${e.message}`, 'Claude Code CLI not found — set TACTICS_LLM_CLAUDE_BIN or add `claude` to PATH.')); });
    child.on('close', code => {
      clearTimeout(timer);
      // The envelope is emitted on stdout even when is_error is true — hand it back
      // and let claudeCodeChat classify; only a truly empty stdout is a hard failure.
      if (out.trim()) resolve(out);
      else reject(new Error(`claude exited ${code}: ${err.slice(0, 200)}`));
    });
    child.stdin.write(stdin);
    child.stdin.end();
  });
}
