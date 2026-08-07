// ── match-view DOM chrome ── extracted from renderer.ts (Round: renderer-split). Every panel the watch
// screen puts OVER the canvas is plain DOM (crisp text, styleable from styles.css, never occluded by the
// floating controls), and every one of them is built exactly once from here during MatchRenderer.init().
// These are pure builders: they create (and, for the body-level overlays, append) the nodes and hand back
// the refs the renderer dirty-checks against. init() calls them in the original order, so the body child
// order — feed, banner, keyframe <style>, toast stack, moment panel, added-time board — is unchanged.

// The scoreboard's live text nodes, kept so sync() can rewrite them without re-querying the DOM.
export type HudRefs = { home: HTMLElement; score: HTMLElement; away: HTMLElement; half: HTMLElement; time: HTMLElement;
  added: HTMLElement; shots: HTMLElement; poss: HTMLElement; state: HTMLElement; possHome: HTMLElement };
// The PRESSURE panel's six value spans (null until the panel is built) and the pieces renderStatPanel drives.
export type StatCells = Record<'ot' | 'xg' | 'big' | 'cor' | 'foul' | 'off', HTMLSpanElement | null>;
export type StatPanel = { panel: HTMLDivElement; cells: StatCells;
  barHome: HTMLDivElement; barAway: HTMLDivElement; barWrap: HTMLDivElement };

// Build the DOM scoreboard: [teams + score] · [BIG clock, centred — the visual anchor] · [shots/poss]
// with a thin possession split strip along the bottom edge. Values update per sync (dirty-checked).
export function buildHud(): { el: HTMLDivElement; refs: HudRefs } {
  const el = document.createElement('div');
  el.className = 'watch-hud';
  const mk = (cls: string, parent: HTMLElement, text = ''): HTMLElement => {
    const s = document.createElement('span'); s.className = cls; s.textContent = text; parent.appendChild(s); return s;
  };
  const teams = document.createElement('div'); teams.className = 'wh-teams';
  const home = mk('wh-name home', teams, 'HOME');
  const score = mk('wh-score', teams, '0–0');
  const away = mk('wh-name away', teams, 'AWAY');
  const clock = document.createElement('div'); clock.className = 'wh-clock';
  const half = mk('wh-half', clock, 'H1');
  const time = mk('wh-time', clock, '00:00');
  const added = mk('wh-added', clock); added.style.display = 'none';
  const meta = document.createElement('div'); meta.className = 'wh-meta';
  const shots = mk('wh-shots', meta, 'Shots 0–0');
  const poss = mk('wh-poss', meta, 'Poss 50%');
  const state = mk('wh-state', meta); state.style.display = 'none';
  const possbar = document.createElement('div'); possbar.className = 'wh-possbar';
  const ph = document.createElement('div'); ph.className = 'ph'; ph.style.width = '50%';
  const pa = document.createElement('div'); pa.className = 'pa';
  possbar.appendChild(ph); possbar.appendChild(pa);
  el.appendChild(teams); el.appendChild(clock); el.appendChild(meta); el.appendChild(possbar);
  document.body.appendChild(el);
  return { el, refs: { home, score, away, half, time, added, shots, poss, state, possHome: ph } };
}

// The commentary feed panel (fixed bottom-left, styled from styles.css). `rows` is the live row
// container updateTicker rewrites; setReservedBottom floats the whole panel above the tactics panel.
export function buildFeed(): { el: HTMLDivElement; rows: HTMLDivElement } {
  const el = document.createElement('div');
  el.className = 'watch-feed';
  const feedHead = document.createElement('div'); feedHead.className = 'wf-head'; feedHead.textContent = 'Match Feed';
  const feedRows = document.createElement('div'); feedRows.className = 'wf-rows';
  feedRows.innerHTML = '<div class="wf-empty">— kick-off awaited —</div>';
  el.appendChild(feedHead); el.appendChild(feedRows);
  document.body.appendChild(el);
  return { el, rows: feedRows };
}

// Built DETACHED and docked into the right column by screenWatch (dockStats) — it used to float
// fixed at top-left, where it overlapped the scoreboard and the timeline slider.
export function buildStatPanel(): StatPanel {
  const HOME_CSS = '#e63946', AWAY_CSS = '#457b9d';   // = HOME_COLOR / AWAY_COLOR
  const cells: StatCells = { ot: null, xg: null, big: null, cor: null, foul: null, off: null };
  const panel = document.createElement('div');
  Object.assign(panel.style, {
    width: '100%', padding: '8px 10px', boxSizing: 'border-box', fontFamily: 'monospace', fontSize: '12px',
    lineHeight: '1.5', color: '#e8edf2', background: 'rgba(255,255,255,0.035)', borderRadius: '8px',
    border: '1px solid rgba(255,255,255,0.06)', pointerEvents: 'none',
  } as Partial<CSSStyleDeclaration>);
  const grid = document.createElement('div');
  Object.assign(grid.style, { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1px 10px', marginBottom: '6px' } as Partial<CSSStyleDeclaration>);
  const cell = (label: string, key: 'ot' | 'xg' | 'big' | 'cor' | 'foul' | 'off'): HTMLDivElement => {
    const c = document.createElement('div');
    const l = document.createElement('span');
    l.textContent = label;
    Object.assign(l.style, { color: '#8b97a6', fontSize: '9px', letterSpacing: '.5px' } as Partial<CSSStyleDeclaration>);
    const v = document.createElement('span');
    v.textContent = '0-0';
    Object.assign(v.style, { fontSize: '13px', marginLeft: '5px' } as Partial<CSSStyleDeclaration>);
    c.appendChild(l); c.appendChild(v);
    cells[key] = v;
    return c;
  };
  grid.appendChild(cell('ON-TGT', 'ot')); grid.appendChild(cell('xG', 'xg'));
  grid.appendChild(cell('BIG-CH', 'big')); grid.appendChild(cell('CORNERS', 'cor'));
  grid.appendChild(cell('FOULS', 'foul')); grid.appendChild(cell('OFFSIDE', 'off'));
  panel.appendChild(grid);
  const cap = document.createElement('div');
  cap.textContent = 'PRESSURE';
  Object.assign(cap.style, { color: '#8b97a6', fontSize: '9px', letterSpacing: '1px', textAlign: 'center', marginBottom: '2px' } as Partial<CSSStyleDeclaration>);
  panel.appendChild(cap);
  const wrap = document.createElement('div');
  Object.assign(wrap.style, { position: 'relative', height: '12px', borderRadius: '3px', background: 'rgba(255,255,255,0.06)', overflow: 'hidden', transition: 'height .12s' } as Partial<CSSStyleDeclaration>);
  const away = document.createElement('div');   // left half — away leading (blue)
  Object.assign(away.style, { position: 'absolute', right: '50%', top: '0', height: '100%', width: '0px', background: AWAY_CSS } as Partial<CSSStyleDeclaration>);
  const home = document.createElement('div');   // right half — home leading (red)
  Object.assign(home.style, { position: 'absolute', left: '50%', top: '0', height: '100%', width: '0px', background: HOME_CSS } as Partial<CSSStyleDeclaration>);
  const tick = document.createElement('div');   // centre hairline
  Object.assign(tick.style, { position: 'absolute', left: '50%', top: '-1px', width: '1px', height: '14px', background: 'rgba(232,237,242,0.4)' } as Partial<CSSStyleDeclaration>);
  wrap.appendChild(away); wrap.appendChild(home); wrap.appendChild(tick);
  panel.appendChild(wrap);
  // NOT appended here — screenWatch docks it (dockStats) into the right column after init.
  return { panel, cells, barHome: home, barAway: away, barWrap: wrap };
}

// The centred big-moment banner: the GOAL / OWN GOAL shout, and the persistent "⚽ GOAL REPLAY"
// marker setReplay() puts up for the whole rewound clip. Hidden until updateMoments/setReplay show it.
export function buildGoalBanner(): HTMLDivElement {
  const el = document.createElement('div');
  Object.assign(el.style, {
    position: 'fixed', top: '18%', left: '50%', transform: 'translateX(-50%) scale(1)',
    zIndex: '30', fontFamily: 'monospace', fontWeight: 'bold', fontSize: '34px',
    color: '#ffe97a', background: 'rgba(8,12,20,0.85)', padding: '14px 34px',
    borderRadius: '10px', border: '2px solid #ffe97a', pointerEvents: 'none',
    display: 'none', textAlign: 'center', letterSpacing: '2px',
  } as Partial<CSSStyleDeclaration>);
  document.body.appendChild(el);
  return el;
}

// a one-time celebratory "pop" keyframe for the GOAL banner (goals are the watch highlight) — injected
// once, re-triggered per goal by resetting the animation. CSS-only, no per-frame cost.
export function injectOverlayKeyframes(): void {
  if (!document.getElementById('footy-goalpop-kf')) {
    const st = document.createElement('style');
    st.id = 'footy-goalpop-kf';
    // goal-banner pop + the score-bug pulse (a quick scale/glow on the DOM scoreboard) + the toast
    // slide-in — CSS keyframes so they cost nothing per frame and re-trigger by resetting the animation.
    st.textContent =
      '@keyframes footyGoalPop{0%{transform:translateX(-50%) scale(.5);opacity:0}55%{transform:translateX(-50%) scale(1.12);opacity:1}100%{transform:translateX(-50%) scale(1);opacity:1}}'
      + '@keyframes footyScorePulse{0%{transform:scale(1)}30%{transform:scale(1.35)}100%{transform:scale(1)}}'
      + '@keyframes footyToastIn{0%{transform:translateX(18px);opacity:0}100%{transform:translateX(0);opacity:1}}';
    document.head.appendChild(st);
  }
}

// ── event-popup toast stack ── renderer-owned (like the HUD/feed/banner), fixed top-right of the pitch.
// setReservedTop/Right keep it clear of the scoreboard/control bar and the docked tactics panel.
export function buildToastStack(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'watch-toasts';
  document.body.appendChild(el);
  return el;
}

// The centred HALF TIME / FULL TIME summary panel (score, shots, possession, scorers, assists).
// updateMoments fills and shows it; whiteSpace:pre is why that text is composed as one block.
export function buildMomentPanel(): HTMLDivElement {
  const el = document.createElement('div');
  Object.assign(el.style, {
    position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
    zIndex: '29', fontFamily: 'monospace', fontSize: '15px', lineHeight: '1.8',
    color: '#e8edf2', background: 'rgba(8,12,20,0.92)', padding: '20px 34px',
    borderRadius: '10px', border: '1px solid #3a4a5f', pointerEvents: 'none',
    display: 'none', whiteSpace: 'pre', textAlign: 'center',
  } as Partial<CSSStyleDeclaration>);
  document.body.appendChild(el);
  return el;
}

// ── added-time board ── a 4th-official "+N" board that pops when the stoppage minutes are
// announced at a half-end (mirrors the replay-viewer board). The persistent HUD "+N" (wh-added)
// remains the ongoing ADDED-TIME indicator while the clock runs past 45'/90'. Dormant until the
// engine sets state.addedTime — coded defensively so a frame without it still type-checks.
export function buildAddedTimeBoard(): HTMLDivElement {
  const el = document.createElement('div');
  Object.assign(el.style, {
    position: 'fixed', top: '46%', left: '50%', transform: 'translate(-50%,-50%)',
    zIndex: '31', fontFamily: 'monospace', fontWeight: 'bold', color: '#ffe97a',
    background: 'rgba(8,12,20,0.9)', padding: '14px 30px', borderRadius: '10px',
    border: '2px solid #ffcf5c', pointerEvents: 'none', display: 'none', textAlign: 'center',
  } as Partial<CSSStyleDeclaration>);
  document.body.appendChild(el);
  return el;
}
