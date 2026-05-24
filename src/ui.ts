import type { GameEngine } from './engine';
import type { ManagerConfig } from './types';
import { FORMATIONS } from './types';

let engine: GameEngine | null = null;
let debugUploadTimer: number | null = null;
let debugLastUploadedSeq = 0;
let debugUploadPending = false;
let debugUploadStatusEl: HTMLElement | null = null;

function setDebugUploadStatus(text: string): void {
  if (debugUploadStatusEl) debugUploadStatusEl.textContent = text;
}

function startDebugUpload(): void {
  debugLastUploadedSeq = 0;
  if (debugUploadTimer !== null) window.clearInterval(debugUploadTimer);
  setDebugUploadStatus('log: starting');
  void flushDebugLog();
  debugUploadTimer = window.setInterval(() => { void flushDebugLog(); }, 1500);
}

async function flushDebugLog(useBeacon = false): Promise<void> {
  if (!engine) return;
  if (debugUploadPending && !useBeacon) return;

  const batch = engine.getDebugLogBatch(debugLastUploadedSeq);
  if (batch.entries.length === 0) return;

  const nextSeq = batch.lastSeq;
  const body = JSON.stringify(batch);
  if (useBeacon && navigator.sendBeacon) {
    const blob = new Blob([body], { type: 'application/json' });
    if (navigator.sendBeacon('/__footy_debug_log', blob)) {
      debugLastUploadedSeq = nextSeq;
      setDebugUploadStatus(`log: ${nextSeq}`);
      return;
    }
  }

  debugUploadPending = true;
  try {
    const response = await fetch('/__footy_debug_log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    });
    if (!response.ok) throw new Error(`debug upload ${response.status}`);
    debugLastUploadedSeq = nextSeq;
    setDebugUploadStatus(`log: ${nextSeq}`);
  } catch {
    setDebugUploadStatus('log: off');
  } finally {
    debugUploadPending = false;
  }
}

export function showSetup(homeConfig: ManagerConfig, awayConfig: ManagerConfig): Promise<{ home: ManagerConfig; away: ManagerConfig }> {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.id = 'setup-screen';
    Object.assign(el.style, {
      position: 'fixed', inset: '0',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.9)', color: '#fff', fontFamily: 'monospace', zIndex: '100',
      gap: '16px',
    });

    el.innerHTML = `
      <h1 style="font-size:24px;margin:0">Football Manager Sim</h1>
      <div style="display:flex;gap:40px">
        <div id="home-setup" style="text-align:center">
          <h2 style="color:#e63946;margin:0 0 8px">HOME</h2>
          ${controlsHtml('home')}
        </div>
        <div style="font-size:32px;align-self:center">vs</div>
        <div id="away-setup" style="text-align:center">
          <h2 style="color:#457b9d;margin:0 0 8px">AWAY</h2>
          ${controlsHtml('away')}
        </div>
      </div>
      <button id="btn-start-match" style="padding:12px 40px;font-size:18px;cursor:pointer;margin-top:16px;font-family:monospace">Start Match</button>
    `;
    document.body.appendChild(el);

    const getConfig = (team: 'home' | 'away'): ManagerConfig => {
      const c = team === 'home' ? homeConfig : awayConfig;
      const formationIdx = parseInt((document.getElementById(`${team}-formation`) as HTMLSelectElement).value);
      c.formation = FORMATIONS[formationIdx];
      c.isHuman = (document.getElementById(`${team}-manager`) as HTMLSelectElement).value === 'human';
      if (!c.isHuman) {
        c.aggression = parseInt((document.getElementById(`${team}-aggression`) as HTMLInputElement).value);
        c.passingDirectness = parseInt((document.getElementById(`${team}-directness`) as HTMLInputElement).value);
        c.overlapFrequency = parseInt((document.getElementById(`${team}-overlap`) as HTMLInputElement).value);
        c.midfieldFreedom = parseInt((document.getElementById(`${team}-midfield`) as HTMLInputElement).value);
        c.defensiveLineHeight = parseInt((document.getElementById(`${team}-line`) as HTMLInputElement).value);
      }
      return c;
    };

    document.getElementById('btn-start-match')!.addEventListener('click', () => {
      const result = { home: getConfig('home'), away: getConfig('away') };
      el.remove();
      resolve(result);
    });
  });
}

function controlsHtml(team: string): string {
  const formOptions = FORMATIONS.map((f, i) => `<option value="${i}"${i === 0 ? ' selected' : ''}>${f.name}</option>`).join('');
  return `
    <label>Formation: <select id="${team}-formation">${formOptions}</select></label><br><br>
    <label>Manager: <select id="${team}-manager">
      <option value="ai">AI</option>
      <option value="human">Human</option>
    </select></label>
    <div id="${team}-ai-opts">
      <br><label>Aggression: <input id="${team}-aggression" type="range" min="0" max="100" value="60" style="width:120px" /> <span id="${team}-agg-val">60</span></label>
      <br><label>Directness: <input id="${team}-directness" type="range" min="0" max="100" value="50" style="width:120px" /> <span id="${team}-dir-val">50</span></label>
      <br><label>Overlap: <input id="${team}-overlap" type="range" min="0" max="100" value="50" style="width:120px" /></label>
      <br><label>Midfield freedom: <input id="${team}-midfield" type="range" min="0" max="100" value="50" style="width:120px" /></label>
      <br><label>Line height: <input id="${team}-line" type="range" min="0" max="100" value="50" style="width:120px" /></label>
    </div>
  `;
}

export function showResult(homeScore: number, awayScore: number): void {
  const el = document.createElement('div');
  el.id = 'result-screen';
  Object.assign(el.style, {
    position: 'fixed', inset: '0',
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(0,0,0,0.85)', color: '#fff', fontFamily: 'monospace', zIndex: '200', gap: '16px',
  });
  const winner = homeScore > awayScore ? 'HOME WINS' : awayScore > homeScore ? 'AWAY WINS' : 'DRAW';
  el.innerHTML = `
    <h1 style="font-size:32px;margin:0">${winner}</h1>
    <h2 style="font-size:48px;margin:0"><span style="color:#e63946">${homeScore}</span> - <span style="color:#457b9d">${awayScore}</span></h2>
    <button id="btn-play-again" style="padding:12px 40px;font-size:18px;cursor:pointer;font-family:monospace">Play Again</button>
  `;
  document.body.appendChild(el);
  document.getElementById('btn-play-again')!.addEventListener('click', () => {
    el.remove();
    location.reload();
  });
}

export function setupUI(eng: GameEngine): void {
  engine = eng;

  const div = document.createElement('div');
  div.id = 'hud';
  Object.assign(div.style, {
    position: 'fixed', bottom: '12px', left: '50%', transform: 'translateX(-50%)',
    display: 'flex', gap: '12px', alignItems: 'center',
    background: 'rgba(0,0,0,0.75)', padding: '8px 16px', borderRadius: '8px',
    color: '#fff', fontFamily: 'monospace', fontSize: '13px', zIndex: '10',
  });
  div.innerHTML = `
    <button id="btn-start">Play</button>
    <button id="btn-pause">Pause</button>
    <button id="btn-copy-debug">Copy Debug Log</button>
    <span id="debug-upload-status" style="opacity:0.75">log: idle</span>
    <label style="display:flex;align-items:center;gap:4px">
      Speed: <span id="speed-label">0.75x</span>
      <input id="speed-slider" type="range" min="1" max="6" value="3" style="width:80px" />
    </label>
  `;
  document.body.appendChild(div);

  const speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5];
  const slider = div.querySelector('#speed-slider') as HTMLInputElement;
  const speedLabel = div.querySelector('#speed-label')!;
  const btnStart = div.querySelector('#btn-start')!;
  const btnPause = div.querySelector('#btn-pause')!;
  const btnCopyDebug = div.querySelector('#btn-copy-debug') as HTMLButtonElement;
  debugUploadStatusEl = div.querySelector('#debug-upload-status') as HTMLElement;

  engine.speed = speeds[parseInt(slider.value) - 1];

  slider.addEventListener('input', () => {
    const idx = parseInt(slider.value) - 1;
    engine!.speed = speeds[idx];
    speedLabel.textContent = `${engine!.speed}x`;
  });

  const startNewMatch = (): void => {
    engine!.startMatch();
    startDebugUpload();
    btnPause.textContent = 'Pause';
  };

  btnStart.addEventListener('click', startNewMatch);
  btnPause.addEventListener('click', () => {
    engine!.togglePause();
    btnPause.textContent = engine!.matchState === 'paused' ? 'Resume' : 'Pause';
    if (engine!.matchState === 'paused') void flushDebugLog();
  });

  btnCopyDebug.addEventListener('click', async () => {
    void flushDebugLog();
    const log = engine!.getDebugLogText();
    const text = log || '{"kind":"debug_empty"}';
    try {
      await navigator.clipboard.writeText(text);
      btnCopyDebug.textContent = `Copied ${text.split('\n').length}`;
      setTimeout(() => { btnCopyDebug.textContent = 'Copy Debug Log'; }, 1500);
    } catch {
      showCopyFallback(text);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      e.preventDefault();
      if (engine!.matchState === 'not_started' || engine!.matchState === 'finished') startNewMatch();
      else {
        engine!.togglePause();
        btnPause.textContent = engine!.matchState === 'paused' ? 'Resume' : 'Pause';
        if (engine!.matchState === 'paused') void flushDebugLog();
      }
    }
  });

  window.addEventListener('beforeunload', () => { void flushDebugLog(true); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushDebugLog(true);
  });
}

function showCopyFallback(text: string): void {
  let box = document.getElementById('debug-copy-box') as HTMLTextAreaElement | null;
  if (!box) {
    box = document.createElement('textarea');
    box.id = 'debug-copy-box';
    Object.assign(box.style, {
      position: 'fixed', right: '12px', bottom: '58px',
      width: '420px', height: '220px', zIndex: '50',
      background: '#111', color: '#fff', fontFamily: 'monospace', fontSize: '11px',
      border: '1px solid #555', padding: '8px',
    });
    document.body.appendChild(box);
  }
  box.value = text;
  box.focus();
  box.select();
}
