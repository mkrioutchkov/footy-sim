import { MatchRenderer } from './renderer';

const WS_URL = 'ws://localhost:3000';

class HudController {
  private element: HTMLDivElement;
  private speedLabel: HTMLElement;
  private btnPause: HTMLButtonElement;
  private slider: HTMLInputElement;
  private speeds: number[];

  constructor(speeds: number[], onSpeedChange: (v: number) => void, onPause: () => void) {
    this.speeds = speeds;
    this.element = document.createElement('div');
    this.element.id = 'hud';
    Object.assign(this.element.style, {
      position: 'fixed', bottom: '12px', left: '50%', transform: 'translateX(-50%)',
      display: 'flex', gap: '12px', alignItems: 'center',
      background: 'rgba(0,0,0,0.75)', padding: '8px 16px', borderRadius: '8px',
      color: '#fff', fontFamily: 'monospace', fontSize: '13px', zIndex: '10',
    });

    this.btnPause = document.createElement('button');
    this.btnPause.id = 'btn-pause';
    this.btnPause.textContent = 'Pause';
    this.btnPause.onclick = onPause;
    this.element.appendChild(this.btnPause);

    const speedContainer = document.createElement('label');
    Object.assign(speedContainer.style, { display: 'flex', alignItems: 'center', gap: '4px' });
    speedContainer.appendChild(document.createTextNode('Speed: '));
    this.speedLabel = document.createElement('span');
    this.speedLabel.id = 'speed-label';
    this.speedLabel.textContent = '1x';
    speedContainer.appendChild(this.speedLabel);

    this.slider = document.createElement('input');
    this.slider.id = 'speed-slider';
    this.slider.type = 'range';
    this.slider.min = '1';
    this.slider.max = String(speeds.length);
    this.slider.value = '2';
    Object.assign(this.slider.style, { width: '80px' });
    this.slider.oninput = () => {
      const idx = parseInt(this.slider.value) - 1;
      const v = speeds[idx];
      this.speedLabel.textContent = `${v}x`;
      onSpeedChange(v);
    };
    speedContainer.appendChild(this.slider);

    this.element.appendChild(speedContainer);
    document.body.appendChild(this.element);
  }

  update(state: { matchState: string; speed?: number }) {
    this.btnPause.textContent = state.matchState === 'paused' ? 'Resume' : 'Pause';
    if (typeof state.speed === 'number') {
      let bestIdx = 1;
      let bestDiff = Infinity;
      for (let i = 0; i < this.speeds.length; i++) {
        const diff = Math.abs(this.speeds[i] - state.speed);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestIdx = i;
        }
      }
      this.slider.value = String(bestIdx + 1);
      this.speedLabel.textContent = `${this.speeds[bestIdx]}x`;
    }
  }
}

async function main() {
  const renderer = new MatchRenderer();
  await renderer.init();

  const speeds = [0.5, 1, 2, 5, 10, 20, 60];
  let ws: WebSocket | null = null;
  let submittedSetup = false;

  const send = (msg: any) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  const hud = new HudController(
    speeds,
    (v) => send({ type: 'speed', value: v }),
    () => send({ type: 'pause' })
  );

  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      e.preventDefault();
      send({ type: 'pause' });
    }
  });

  function connect() {
    ws = new WebSocket(WS_URL);
    ws.onmessage = (event) => {
      try {
        const state = JSON.parse(event.data as string);
        renderer.sync(state);
        hud.update(state);
      } catch (e) {
        console.error('[WS] sync error:', e);
      }
    };
    ws.onclose = () => {
      console.log('Disconnected, reconnecting...');
      setTimeout(connect, 1000);
    };
    ws.onopen = () => {
      console.log('Connected to engine');
      if (!submittedSetup) {
        send({ type: 'restart' });
        submittedSetup = true;
      }
    };
  }

  connect();
}

main();
