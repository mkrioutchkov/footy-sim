// cpp-server.ts — spawns C++ engine, broadcasts state via WebSocket
import { WebSocketServer, WebSocket } from 'ws';
import { spawn } from 'child_process';

const PORT = 3001; // different port from JS engine
const CPP_ENGINE = '../.scratch/cpp-engine/main.exe';
const SEED = process.env.CPP_SEED ? parseInt(process.env.CPP_SEED) : 101;
const MINUTES = 90;

const wss = new WebSocketServer({ port: PORT });
console.log(`C++ engine WS on ws://localhost:${PORT}`);

// Spawn C++ engine — it outputs JSON every tick
const engine = spawn(CPP_ENGINE, [String(SEED), String(MINUTES)], {
    stdio: ['ignore', 'pipe', 'pipe']
});

let buffer = '';
engine.stdout.on('data', (data: Buffer) => {
    buffer += data.toString();
    // The C++ engine outputs one JSON per tick. We broadcast latest.
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
        try {
            const state = JSON.parse(line);
            const msg = JSON.stringify(state);
            for (const client of wss.clients) {
                if (client.readyState === WebSocket.OPEN) client.send(msg);
            }
        } catch { /* skip partial JSON */ }
    }
});

engine.stderr.on('data', (d: Buffer) => process.stderr.write(d));
engine.on('close', (code) => console.log(`C++ engine exited: ${code}`));

wss.on('connection', (ws: WebSocket) => {
    console.log('Client connected to C++ engine');
    ws.on('message', (data: Buffer) => {
        try {
            const cmd = JSON.parse(data.toString());
            // Forward pause/speed commands to engine via stdin
            engine.stdin.write(JSON.stringify(cmd) + '\n');
        } catch { /* ignore */ }
    });
});
