import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logDir = path.resolve(__dirname, '..', '.scratch', 'footy-sim-logs');
const maxBodyBytes = 2_000_000;

function safeSessionId(raw) {
  const value = String(raw ?? '').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 96);
  return value.length > 0 ? value : null;
}

function writeDebugBatch(payload) {
  const sessionId = safeSessionId(payload.sessionId);
  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  if (!sessionId || entries.length === 0) return { sessionId, entriesReceived: 0 };

  fs.mkdirSync(logDir, { recursive: true });
  const receivedAt = new Date().toISOString();
  const logPath = path.join(logDir, `${sessionId}.jsonl`);
  const metaPath = path.join(logDir, `${sessionId}.meta.json`);
  const lines = entries
    .map(entry => JSON.stringify({ receivedAt, sessionId, ...entry }))
    .join('\n');
  fs.appendFileSync(logPath, `${lines}\n`, 'utf8');

  let previousCount = 0;
  if (fs.existsSync(metaPath)) {
    try {
      previousCount = JSON.parse(fs.readFileSync(metaPath, 'utf8')).entriesReceived ?? 0;
    } catch {
      previousCount = 0;
    }
  }

  const meta = {
    sessionId,
    startedAt: payload.startedAt ?? null,
    latestAt: receivedAt,
    entriesReceived: previousCount + entries.length,
    lastSeq: payload.lastSeq ?? entries.at(-1)?.seq ?? null,
    logPath,
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
  fs.writeFileSync(path.join(logDir, 'latest-session.json'), JSON.stringify(meta, null, 2), 'utf8');
  return { sessionId, entriesReceived: entries.length };
}

function localDebugLogPlugin() {
  return {
    name: 'footy-local-debug-log',
    configureServer(server) {
      server.middlewares.use('/__footy_debug_log', (req, res, next) => {
        if (req.method !== 'POST') {
          next();
          return;
        }

        let body = '';
        let rejected = false;
        req.setEncoding('utf8');
        req.on('data', chunk => {
          body += chunk;
          if (body.length > maxBodyBytes) {
            rejected = true;
            res.statusCode = 413;
            res.end('debug log batch too large');
            req.destroy();
          }
        });
        req.on('error', () => {
          if (!res.writableEnded) {
            res.statusCode = 400;
            res.end('could not read debug log batch');
          }
        });
        req.on('end', () => {
          if (rejected || res.writableEnded) return;
          try {
            writeDebugBatch(JSON.parse(body || '{}'));
            res.statusCode = 204;
            res.end();
          } catch (error) {
            server.config.logger.warn(`[footy-debug] ${error instanceof Error ? error.message : String(error)}`);
            res.statusCode = 400;
            res.end('invalid debug log batch');
          }
        });
      });
    },
  };
}

const GAME_API = process.env.FOOTY_API ?? 'http://localhost:4000';

export default defineConfig({
  root: 'web/frontend',
  plugins: [localDebugLogPlugin()],
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
  },
  server: {
    watch: {
      ignored: ['**/engine/**'],
    },
    proxy: {
      // Regex (anchored, trailing slash) so the prefix matches API calls
      // (/api/me, …) but NOT the frontend's own module at /api.ts — a plain
      // '/api' prefix proxied /api.ts to the backend and broke the SPA load.
      '^/api/': { target: GAME_API, changeOrigin: true },
      '^/ws/': { target: GAME_API.replace('http', 'ws'), ws: true },
    },
  },
});
