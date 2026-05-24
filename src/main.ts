import { MatchRenderer } from './renderer';
import { showSetup } from './ui';
import { createManager } from './manager';

const WS_URL = 'ws://localhost:3000';

async function main() {
  const homeConfig = createManager('home', false);
  const awayConfig = createManager('away', false);

  const setup = await showSetup(homeConfig, awayConfig);

  const renderer = new MatchRenderer();
  await renderer.init();

  let ws: WebSocket | null = null;
  let submittedSetup = false;

  // HUD controls — create before WebSocket so handler can access them
  const hud = document.createElement('div');
  hud.id = 'hud';
  Object.assign(hud.style, {
    position: 'fixed', bottom: '12px', left: '50%', transform: 'translateX(-50%)',
    display: 'flex', gap: '12px', alignItems: 'center',
    background: 'rgba(0,0,0,0.75)', padding: '8px 16px', borderRadius: '8px',
    color: '#fff', fontFamily: 'monospace', fontSize: '13px', zIndex: '10',
  });
  hud.innerHTML = `
    <button id="btn-pause">Pause</button>
    <label style="display:flex;align-items:center;gap:4px">
      Speed: <span id="speed-label">1x</span>
      <input id="speed-slider" type="range" min="1" max="7" value="2" style="width:80px" />
    </label>
  `;
  document.body.appendChild(hud);

  const speeds = [0.5, 1, 2, 5, 10, 20, 60];
  const slider = hud.querySelector('#speed-slider') as HTMLInputElement;
  const speedLabel = hud.querySelector('#speed-label')!;
  const btnPause = hud.querySelector('#btn-pause')!;

  slider.addEventListener('input', () => {
    const idx = parseInt(slider.value) - 1;
    const v = speeds[idx];
    speedLabel.textContent = `${v}x`;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'speed', value: v }));
  });

  btnPause.addEventListener('click', () => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'pause' }));
  });

  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      e.preventDefault();
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'pause' }));
    }
  });

  function connect() {
    ws = new WebSocket(WS_URL);

    ws.onmessage = (event) => {
      try {
        const state = JSON.parse(event.data as string);
        renderer.sync(state);
        btnPause.textContent = state.matchState === 'paused' ? 'Resume' : 'Pause';
        // sync slider to server speed
        if (typeof state.speed === 'number') {
          let bestIdx = 1;
          let bestDiff = Infinity;
          for (let i = 0; i < speeds.length; i++) {
            const diff = Math.abs(speeds[i] - state.speed);
            if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
          }
          slider.value = String(bestIdx + 1);
          speedLabel.textContent = `${speeds[bestIdx]}x`;
        }
      } catch { /* ignore */ }
    };

    ws.onclose = () => {
      console.log('Disconnected, reconnecting...');
      setTimeout(connect, 1000);
    };

    ws.onopen = () => {
      console.log('Connected to engine');
      if (!submittedSetup) {
        ws!.send(JSON.stringify({ type: 'restart', homeConfig: setup.home, awayConfig: setup.away }));
        submittedSetup = true;
      }
    };
  }

  connect();
}

main();
