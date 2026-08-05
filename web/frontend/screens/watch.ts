// ── live match viewer ── extracted from app.ts (Round: appts-audit): the whole watch subsystem — its
// module-level handles (socket, renderer, floating panels, timers, listeners), the teardown that owns them,
// and screenWatch itself. It was ~1,000 of app.ts's 5,500 lines and, apart from the shared directive
// readback, touched nothing else in the app: the 16 `let`s below are read by screenWatch/teardownWatch only.
import { api } from '../api.ts';
import type { MatchRenderer as MatchRendererInstance } from '../renderer.ts';
import type { DirectiveT, PlanT } from '../api.ts';
import type { EngineState } from '../types.ts';
import { PITCH_W, PITCH_H } from '../constants.ts';
import { h, isInteractiveTarget, svgEl } from '../ui/dom.ts';
import { shortName } from '../ui/format.ts';
import { root } from '../ui/shell.ts';
import { describeDirective, pname, setDirectiveNames } from './directives.ts';

// ── live-watch socket envelope ── the web backend wraps each engine frame with team names +
// a replay flag, and pushes a tacticsReceipt message in reply to a shout. Typed here (not in
// types.ts) because it's the web transport layer, not the engine contract.
interface MotivationReaction { playerId: number; moraleDelta: number; reaction?: string; }
interface TacticsReceipt {
  error?: string; formation?: string; note?: string; changed?: string;
  motivation?: MotivationReaction[]; plan?: PlanT | null; directives?: DirectiveT[];
}
type WatchMessage = EngineState & { homeName?: string; awayName?: string; weather?: 'clear' | 'rain' | 'wind'; replay?: boolean; durationMs?: number; tacticsReceipt?: TacticsReceipt; error?: string };

// ── watch ──
let activeRenderer: MatchRendererInstance | null = null;
let activeWs: WebSocket | null = null;
// The control bar (Pause, speed, seek) is interactive BEFORE the socket opens and stays in the DOM after it
// closes at full-time; a bare activeWs.send() then throws an uncaught InvalidStateError (CONNECTING/CLOSING/
// CLOSED). Route every control-bar command through this OPEN guard so a mistimed click is a silent no-op.
function wsSend(msg: unknown): void {
  if (activeWs?.readyState === WebSocket.OPEN) activeWs.send(JSON.stringify(msg));
}
let watchBar: HTMLElement | null = null;
let watchPanel: HTMLElement | null = null;
let watchStatus: HTMLElement | null = null;   // connecting / connection-lost overlay
let watchPanelObs: ResizeObserver | null = null;   // keeps the pitch sized to the space the panel leaves
let watchKeyHandler: ((e: KeyboardEvent) => void) | null = null;   // P3 viewer keyboard shortcuts (space/←/→/,/.)
let watchVisHandler: (() => void) | null = null;   // background-tab handling (skip draw work while hidden; snap current on return)
let watchMoreOutside: ((e: Event) => void) | null = null;   // outside-click dismissal for the ⋯ (More) popover
let activeReplayTimer: ReturnType<typeof setInterval> | null = null;   // live goal-replay playback loop
let activeHighlightTimer: ReturnType<typeof setTimeout> | null = null;   // 🎞 highlights-reel tour step (survives teardown otherwise)
let watchStatsPanel: HTMLElement | null = null;   // 📊 on-demand match-analysis overlay (ratings + shot map + xG)
let watchStatsTimer: ReturnType<typeof setInterval> | null = null;   // refreshes the stats overlay while it's open
let watchLineupsPanel: HTMLElement | null = null;   // 👥 on-demand line-ups overlay (home/away columns)
let watchEpoch = 0;   // bumped on every teardown so an in-flight screenWatch can detect it was superseded
export function teardownWatch() {
  watchEpoch++;
  if (activeReplayTimer) { clearTimeout(activeReplayTimer); clearInterval(activeReplayTimer); activeReplayTimer = null; }   // a live-rewind timer is a setTimeout — clear BOTH kinds
  if (activeHighlightTimer) { clearTimeout(activeHighlightTimer); activeHighlightTimer = null; }   // stop a highlights tour scheduled but not yet fired
  if (watchStatsTimer) { clearInterval(watchStatsTimer); watchStatsTimer = null; }   // stop the 📊 stats refresh loop
  watchStatsPanel?.remove(); watchStatsPanel = null;
  watchLineupsPanel?.remove(); watchLineupsPanel = null;
  try { watchPanelObs?.disconnect(); } catch { /* */ } watchPanelObs = null;
  if (watchKeyHandler) { window.removeEventListener('keydown', watchKeyHandler); watchKeyHandler = null; }
  if (watchMoreOutside) { document.removeEventListener('pointerdown', watchMoreOutside); watchMoreOutside = null; }
  if (watchVisHandler) { document.removeEventListener('visibilitychange', watchVisHandler); watchVisHandler = null; }
  try { activeWs?.close(); } catch { /* */ } activeWs = null;
  try { activeRenderer?.setReplay(false); } catch { /* */ }   // dismiss any GOAL-REPLAY banner before tearing down (no stuck overlay across watches)
  try { activeRenderer?.destroy(); } catch { /* */ } activeRenderer = null;
  watchBar?.remove(); watchBar = null;     // teardown owns the floating control bar + tactics panel,
  watchPanel?.remove(); watchPanel = null; // so navigation (incl. watch→watch) never leaves them stacked
  watchStatus?.remove(); watchStatus = null;
}

export async function screenWatch(fixtureId: number, shouts = false, live = false, startMs = 0, cup = false) {
  teardownWatch();
  document.title = 'Match viewer · Footy Manager';
  const myEpoch = watchEpoch;   // if another teardown/navigation bumps this during init, we bail below
  // Clear the previous management screen before the first fetch. Otherwise a slow/offline team request leaves
  // stale dashboard controls live under a URL that already says Watch.
  root.replaceChildren(h('div', { class: 'center' }, h('div', { class: 'spin' }, 'Preparing match viewer…')));
  // A cup tie is a recorded, spectator-only replay (no coordinator, no shout log keyed by tie id), so
  // its watch is always plain playback — force off the live/shout paths regardless of the hash.
  if (cup) { live = false; shouts = false; }
  // Ensure the result is recorded (idempotent, deterministic, same as the stream). NOT for a LIVE
  // match — that must reach full-time UNPLAYED so the coordinator persists the live (shout-driven)
  // result; a pre-sim here would mark it played and the live persist would (correctly) skip. NOT for a
  // cup tie either — it's already played (only played ties have a recording) and there's no playFixture
  // for cup ties (the engine plays them at draw/advance time).
  if (!live && !cup) api.playFixture(fixtureId).catch(() => { /* may already be played */ });
  // Felt-tactics overlay (BACKLOG2 #1): surface the ACTIVE composite plan persistently in the viewer, seeded
  // from the team's standing plan so it's visible from kickoff (not just after a shout) — shouts update it live.
  const myTeam = await api.team().catch(() => null);
  if (myEpoch !== watchEpoch) return;   // navigated away during the fetch
  if (myTeam) setDirectiveNames(myTeam.players.slice(0, 11).map((p, i) => ({ id: i, name: p.name })));
  let activeDirectives: DirectiveT[] = (myTeam?.plan?.directives as DirectiveT[] | undefined) ?? [];
  // Directive overlay ("type it → see it work"): a short per-player label, mapped slot→engine-id, for the renderer toggle.
  const DIR_LABEL: Record<string, string> = {
    drift_into_pocket: 'pocket', play_between_lines: 'pocket', between_the_lines: 'pocket', drop_into_the_ten: 'pocket',
    come_short: 'come short', check_to_feet: 'come short', target_man_holdup: 'hold up', hold_it_up: 'hold up', target_man: 'hold up',
    cut_inside: 'cut in', cut_in: 'cut in', cut_inside_to_shoot: 'cut in', overlap: 'overlap', overlap_runs: 'overlap', get_on_the_overlap: 'overlap',
    run_in_behind: 'in behind', make_runs: 'make runs', get_forward: 'get fwd', stay_wide: 'stay wide', come_inside: 'invert',
    stay_central: 'central', sit_deep: 'sit deep', press_hard: 'press', contain: 'contain', tackle_hard: 'tackle hard',
    stay_on_feet: 'stay up', stay_back: 'hold', dribble_more: 'dribble', play_simple: 'keep simple', shoot_on_sight: 'shoot',
  };
  const dirShort = (k: string): string => DIR_LABEL[k] ?? k.replace(/_/g, ' ');
  const buildDirMap = (isHome: boolean): Map<number, string> => {
    const off = isHome ? 0 : 11, m = new Map<number, string>();
    for (const d of activeDirectives) {
      if (typeof d.playerId !== 'number' || d.playerId < 0 || d.playerId > 10) continue;   // per-player only (skip team-wide)
      if (!m.has(d.playerId + off)) m.set(d.playerId + off, dirShort(d.kind));   // first directive wins per player
    }
    return m;
  };
  let watchIsHome = false;   // resolved on the first frame (engine ids 0–10 home / 11–21 away)
  const refreshDirOverlay = (): void => { activeRenderer?.setDirectives(buildDirMap(watchIsHome)); };

  root.replaceChildren();
  // ── control strip ── one full-width rounded bar directly UNDER the DOM scoreboard (the renderer
  // owns that): Back · Pause · speed · ⏪10s · 10s⏩ · slider (flexes to fill, markers on top) ·
  // time/duration · ● LIVE · ⋯ · weather/recorded chips. Nothing floats over anything any more.
  // Everything secondary (tactics overlay, highlights tour, goal replay) lives behind one ⋯ menu.
  // ● LIVE — shown only while rewound; jumps back to the live edge (▶ Resume on a re-sim).
  const goLiveBtn = h('button', { class: 'primary small', style: 'display:none', 'aria-label': 'Resume live', title: 'Jump back to the live edge', onclick: () => resumeLive() }, '● LIVE') as HTMLButtonElement;
  // The slider is THE navigation control: drag to any moment (recorded = backend random access; live/re-sim =
  // the client buffer). It spans the REAL match length once known (durationMs from a recording) — not a fixed
  // 96' with a dead tail; markers recompute when the range tightens.
  const SCRUB_MAX_MS = 96 * 60 * 1000;    // fallback until the real duration is known (live: the match is still growing)
  let scrubMaxMs = SCRUB_MAX_MS;
  let scrubMinMs = 0;                     // live watches raise this to the oldest BUFFERED frame (the rewind window)
  let scrubbing = false;
  let currentMs = 0;                      // the live playhead (each frame's clockMs) — drives ⏪/⏩
  let knownDurationMs: number | null = null;   // a recording's real length → the label reads "cur / total"
  const fmtClock = (ms: number): string => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const scrubLabel = h('span', { class: 'muted', style: "display:none;font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap" }, '0:00');
  const paintScrubLabel = (ms: number): void => {
    scrubLabel.textContent = knownDurationMs !== null ? `${fmtClock(ms)} / ${fmtClock(knownDurationMs)}` : fmtClock(ms);
  };
  const scrubEl = h('input', { type: 'range', min: '0', max: String(SCRUB_MAX_MS), step: '1000', value: '0',
    style: 'width:100%;accent-color:var(--accent)', 'aria-label': 'Scrub through the match — drag to jump to any point' }) as HTMLInputElement;
  // ⚽ moment markers float over the scrub track (report timeline upfront on recorded; indexed live otherwise).
  const goalMarkers = h('div', { style: 'position:absolute;left:0;right:0;top:0;bottom:0;pointer-events:none' });
  const scrubWrap = h('div', { class: 'scrub-wrap', style: 'display:none;position:relative;align-items:center;flex:1 1 240px;min-width:150px;height:22px' }, scrubEl, goalMarkers) as HTMLElement;
  scrubEl.addEventListener('input', () => { scrubbing = true; paintScrubLabel(+scrubEl.value); });
  scrubEl.addEventListener('change', () => { seekTo(+scrubEl.value); scrubbing = false; });
  // A drag released back at its STARTING value fires no 'change' → `scrubbing` stuck true → the playhead
  // stopped tracking forever. Commit on release too (deferred a tick so a real 'change' wins; idempotent).
  const commitScrub = (): void => { setTimeout(() => { if (scrubbing) { scrubbing = false; seekTo(+scrubEl.value); } }, 0); };
  scrubEl.addEventListener('pointerup', commitScrub);
  scrubEl.addEventListener('keyup', commitScrub);
  // ⏪ / ⏩ compact jump stepper — REWIND −10/−5/−3/−2/−1s · FAST-FORWARD +1/+2/+3/+5/+10s. Each rides the
  // unified seekTo (recorded → backend random access; live → the client rewind buffer), so a rewind lands in
  // buffered history and a forward jump catches back up to the live edge. Revealed with the scrub.
  const STEP_BACK = [10, 5, 3, 2, 1];   // seconds (rewind)
  const STEP_FWD = [1, 2, 3, 5, 10];    // seconds (fast-forward)
  const mkStep = (sec: number, dir: -1 | 1): HTMLButtonElement => h('button', {
    class: 'ghost small step-btn' + (sec === 10 ? ' step-major' : ''), 'aria-label': `${dir < 0 ? 'Rewind' : 'Forward'} ${sec} seconds`,
    title: `${dir < 0 ? '−' : '+'}${sec}s`, onclick: () => seekTo(Math.max(0, currentMs + dir * sec * 1000)),
  }, `${dir < 0 ? '−' : '+'}${sec}s`) as HTMLButtonElement;
  const stepGroup = h('div', { class: 'step-group', style: 'display:none', role: 'group', 'aria-label': 'Rewind and fast-forward' },
    ...STEP_BACK.map(s => mkStep(s, -1)),
    h('span', { class: 'step-sep', 'aria-hidden': 'true' }),
    ...STEP_FWD.map(s => mkStep(s, 1)),
  ) as HTMLElement;
  // The moments the 🎞 reel + the , / . keys tour: the drama — goals, red cards, penalties, woodwork. A
  // goalless-but-eventful match (a sending-off, a saved penalty, a 0-0 that rattled the bar) now gets a
  // highlights tour, not nothing. Yellows stay as clickable scrub markers only (a 5-yellow game shouldn't
  // turn the reel into a card show). Recorded matches get these from the report timeline (analyzeRecording
  // now surfaces penalty/woodwork); a live watch indexes them from the frame events as they happen.
  let highlightIndex: { clockMs: number; name: string; kind: string }[] = [];
  let hasReportMarkers = false;   // the report timeline (full, upfront) was loaded → don't let the incremental live-marks clobber it
  let lastMarkerEvents: { clockMs: number; name: string; kind: string }[] | null = null;   // rebuilt when the scrub range tightens
  const MARKER_ICON: Record<string, string> = { goal: '⚽', yellow: '🟨', red: '🟥', penalty: '🎯', woodwork: '🪵' };
  const HIGHLIGHT_KINDS = new Set(['goal', 'red', 'penalty', 'woodwork']);
  const buildMarkers = (events: { clockMs: number; name: string; kind: string }[]): void => {
    lastMarkerEvents = events;
    highlightIndex = events.filter(e => HIGHLIGHT_KINDS.has(e.kind)).map(e => ({ clockMs: e.clockMs, name: e.name, kind: e.kind })).sort((a, b) => a.clockMs - b.clockMs);
    goalMarkers.replaceChildren();
    for (const e of events) {   // goals + cards on the timeline; click any to jump to it
      // position within the CURRENT range (live: the rewind window; recorded: 0..duration) — a moment older
      // than the window pins to the left edge (clicking it seeks the oldest buffered frame).
      const pct = Math.min(99.5, Math.max(0, ((e.clockMs - scrubMinMs) / Math.max(1, scrubMaxMs - scrubMinMs)) * 100));
      const min = Math.floor(e.clockMs / 60000);
      // a11y: a real <button> (not a bare <span onclick>) so the marker is focusable and keyboard-operable —
      // the ,/. shortcuts scrub, but the markers themselves must also be reachable (matches screenReport's strip).
      goalMarkers.append(h('button', {
        type: 'button', 'aria-label': `${e.kind} at ${min} minutes — ${e.name}. Jump to it`,
        title: `${min}' — ${e.name} · click to jump`,
        style: `position:absolute;left:${pct}%;top:-2px;transform:translateX(-50%);font-size:13px;line-height:1;cursor:pointer;pointer-events:auto;background:none;border:0;padding:0;box-shadow:none`,
        onclick: () => seekTo(Math.max(0, e.clockMs - 4000)),
      }, MARKER_ICON[e.kind] ?? '•'));
    }
    highlightBtn.style.display = highlightIndex.length ? '' : 'none';   // a moments-tour needs at least one goal/red
  };
  // The slider spans what you can actually REACH. Recorded: 0 → the real match length (durationMs — the old
  // fixed 96' left a dead ~6% tail + compressed markers). LIVE: the buffered rewind WINDOW (oldest buffered
  // frame → the live edge), so the whole track is real instead of 0–96' with only ~12 min of it seekable.
  // Markers recompute on a range change; the range never moves under an in-progress drag (scrubbing).
  const setScrubRange = (minMs: number, maxMs: number): void => {
    if (scrubbing || !(maxMs > minMs)) return;
    if (Math.abs(maxMs - scrubMaxMs) < 1500 && Math.abs(minMs - scrubMinMs) < 1500) return;   // dirty-check (live updates arrive ~10/s)
    scrubMinMs = Math.max(0, minMs);
    scrubMaxMs = maxMs;
    scrubEl.min = String(scrubMinMs);
    scrubEl.max = String(maxMs);
    if (lastMarkerEvents) buildMarkers(lastMarkerEvents);
  };
  const setScrubMax = (ms: number): void => setScrubRange(0, ms);
  // ⚽ Replay — appears after the first live goal; plays back the buffered run-up (instant action replay).
  const replayBtn = h('button', { class: 'primary small', style: 'display:none', 'aria-label': 'Action replay of the last goal', title: 'Action replay of the last goal' }, '⚽ Replay goal') as HTMLButtonElement;
  // 🎞 Highlights — tours every goal + red card (jumps to ~5s before each, ~11s apart). Shown once the
  // moment index is known (recorded from the report timeline; live from the indexed events). Reuses seekTo.
  const highlightBtn = h('button', { class: 'ghost small', style: 'display:none', 'aria-label': 'Play the highlights', title: 'Tour the highlights — goals, red cards, penalties, woodwork' }, '🎞 Highlights') as HTMLButtonElement;
  // §weather: the match's actual condition, set from the first frame that carries it (clear → hidden).
  const weatherEl = h('span', { class: 'chip', style: 'display:none' });
  // 📹 Recorded vs ⚙ Re-simulated: a recorded replay is faithful to the stored result; a non-recorded
  // fixture falls back to a fresh engine re-sim whose scoreline can differ from the league table. Set on
  // the first frame so the divergence is honest (this is the 4-1-here-vs-0-2-in-the-table confusion).
  const recBadge = h('span', { class: 'chip', style: 'display:none' });
  // speed — a pill GROUP (was a select) where EVERY preset actually bites: a click sends the rate to the
  // backend AND applies it locally at once (curSpeed), so it re-paces the client-side buffer playback the
  // instant you change it even while rewound (the old select only mailed the backend → invisible mid-rewind).
  // The active pill also tracks each frame's real state.speed via paintBar → paintSpeed, so it never lies.
  const SPEEDS = [0.5, 1, 2, 4, 8];   // 0.5× slow-mo for detail (backend clamps [0.25,60]); 8× to skip ahead
  let paused = false;
  let curSpeed = 1;                   // last speed reported by a frame — the one true playback rate
  const speedPills = SPEEDS.map(v => h('button', {
    class: 'spd-pill small' + (v === 1 ? ' on' : ''), 'data-s': String(v),
    'aria-label': `${v}× speed`, 'aria-pressed': String(v === 1), title: `${v}× playback`,
  }, `${v}×`) as HTMLButtonElement);
  const paintSpeed = (v: number): void => {
    speedPills.forEach((btn, i) => { const on = SPEEDS[i] === v; btn.classList.toggle('on', on); btn.setAttribute('aria-pressed', String(on)); });
  };
  const setSpeed = (v: number): void => {
    curSpeed = v;   // apply immediately — re-paces the buffer playback even while rewound (replaying)
    wsSend({ type: 'speed', value: v });
    paintSpeed(v);
  };
  speedPills.forEach((btn, i) => btn.addEventListener('click', () => setSpeed(SPEEDS[i])));
  const speedGroup = h('div', { class: 'spd-pills', role: 'group', 'aria-label': 'Playback speed' }, ...speedPills);
  // Pause ↔ Resume — distinct pause/resume commands (every stream handles 'resume' now, so no more
  // per-mode toggle protocol). Pausing also freezes the client-side buffer playback when rewound
  // (step() holds while paused). The local state is RECONCILED from each frame's matchState (below),
  // so a refused command (spectator seat) or another manager's pause can't leave the button lying.
  let pauseClickedAt = 0;   // grace window: in-flight pre-click frames must not flap the just-clicked state back
  const pauseBtn = h('button', { class: 'ghost small', 'aria-label': 'Pause or resume playback', 'aria-pressed': 'false', onclick: () => {
    paused = !paused;
    pauseClickedAt = performance.now();
    wsSend({ type: paused ? 'pause' : 'resume' });
    pauseBtn.textContent = paused ? '▶ Resume' : '⏸ Pause';
    paintBar();
  } }, '⏸ Pause') as HTMLButtonElement;
  const paintBar = (s?: number): void => {
    if (typeof s === 'number' && SPEEDS.includes(s)) {
      curSpeed = s;
      paintSpeed(s);   // reflect the frame's real playback rate on the pills (don't churn if already matching)
    }
    pauseBtn.classList.toggle('primary', paused); pauseBtn.classList.toggle('ghost', !paused); pauseBtn.setAttribute('aria-pressed', String(paused));
  };
  // 🎯 directive overlay toggle — surface each player's active tactical instruction on the pitch ("see it work")
  let dirOn = false;
  const dirBtn = h('button', { class: 'ghost small', 'aria-label': 'Toggle the on-pitch tactics overlay', 'aria-pressed': 'false', title: 'Show each player’s active tactical instruction on the pitch' },
    '\u{1F3AF} Tactics') as HTMLButtonElement;
  dirBtn.addEventListener('click', () => {
    dirOn = !dirOn;
    activeRenderer?.setShowDirectives(dirOn);
    dirBtn.classList.toggle('primary', dirOn);
    dirBtn.classList.toggle('ghost', !dirOn);
    dirBtn.setAttribute('aria-pressed', String(dirOn));
  });
  // 📊 Match-stats overlay — FM-style live analysis (sorted player ratings + a shot map + an xG race),
  // on-demand from ⋯, refreshed ~1.5s while open, body-appended + torn down centrally (teardownWatch).
  const statsBtn = h('button', { class: 'ghost small', 'aria-label': 'Toggle match stats', 'aria-pressed': 'false', title: 'Live player ratings, shot map & xG race' }, '📊 Stats') as HTMLButtonElement;
  let statsContent: HTMLElement | null = null;
  let closeLineups: () => void = () => {};
  let restoreOverlayFocus = (trigger: HTMLButtonElement): void => trigger.focus();
  const closeStats = (): void => {
    const restoreFocus = !!watchStatsPanel?.contains(document.activeElement);
    if (watchStatsTimer) { clearInterval(watchStatsTimer); watchStatsTimer = null; }
    watchStatsPanel?.remove(); watchStatsPanel = null; statsContent = null;
    statsBtn.classList.remove('primary'); statsBtn.classList.add('ghost'); statsBtn.setAttribute('aria-pressed', 'false');
    if (restoreFocus) restoreOverlayFocus(statsBtn);
  };
  const ratTint = (r: number): string => r >= 7.5 ? '#57e08a' : r >= 6.5 ? '#e8edf2' : r >= 5.5 ? '#cdd6df' : '#f3b06b';
  const renderStatsPanel = (): void => {
    if (!statsContent || !activeRenderer) return;
    const names = activeRenderer.getTeamNames();
    const ratings = activeRenderer.getRatings();
    const shots = activeRenderer.getShots();
    const series = activeRenderer.getXgSeries();
    // ── live ratings, two columns, best first ──
    const ratCol = (name: string, list: typeof ratings, col: string) => h('div', { style: 'flex:1;min-width:0' },
      h('div', { style: `font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:${col};margin-bottom:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap` }, name),
      ...[...list].sort((a, b) => b.rating - a.rating).map(r => h('div', { class: 'between', style: 'font-size:11px;padding:1px 0;gap:6px' },
        h('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0' }, h('span', { class: 'muted', style: 'font-size:9px;margin-right:3px' }, r.role), shortName(r.name)),
        h('span', { style: `font-weight:700;flex:0 0 auto;color:${ratTint(r.rating)}` }, r.rating.toFixed(1)))));
    const ratingsBlock = h('div', { class: 'row', style: 'gap:12px;align-items:start;margin-bottom:8px' },
      ratCol(names.home, ratings.filter(r => r.team === 'home'), '#e77'),
      ratCol(names.away, ratings.filter(r => r.team === 'away'), '#8ab6d9'));
    // ── shot map: dots on a mini pitch, radius ∝ xG, filled = goal ──
    const sm = svgEl('svg', { viewBox: `0 0 ${PITCH_W} ${PITCH_H}`, width: '100%', style: 'display:block;background:#16331f;border-radius:6px' });
    const smStroke = { fill: 'none', stroke: '#ffffff', 'stroke-opacity': 0.18, 'stroke-width': 3 };
    sm.append(
      svgEl('rect', { x: 3, y: 3, width: PITCH_W - 6, height: PITCH_H - 6, ...smStroke }),
      svgEl('line', { x1: PITCH_W / 2, y1: 3, x2: PITCH_W / 2, y2: PITCH_H - 3, ...smStroke }),
      svgEl('circle', { cx: PITCH_W / 2, cy: PITCH_H / 2, r: 80, ...smStroke }));
    for (const sh of shots) {
      const col = sh.side > 0 ? '#e63946' : '#457b9d';
      sm.append(svgEl('circle', { cx: sh.x, cy: sh.y, r: 7 + sh.xg * 26, fill: sh.goal ? col : 'none', 'fill-opacity': sh.goal ? 0.85 : 0, stroke: col, 'stroke-width': 3.5, 'stroke-opacity': 0.9 }));
    }
    const shotBlock = h('div', {},
      h('div', { class: 'muted', style: 'font-size:10px;text-transform:uppercase;letter-spacing:.4px;margin:4px 0 3px' }, `Shot map · ${shots.length} shot${shots.length === 1 ? '' : 's'} (○ shot · ● goal · size = xG)`),
      shots.length ? sm : h('div', { class: 'muted', style: 'font-size:11px' }, 'No shots yet.'));
    // ── xG race line (cumulative per side) ──
    const lastS = series[series.length - 1];
    const xgMax = Math.max(0.5, lastS?.h ?? 0, lastS?.a ?? 0);
    const tMax = Math.max(60000, lastS?.t ?? 0);
    const CW = 300, CH = 60, pad = 4;
    const px = (t: number) => pad + (t / tMax) * (CW - 2 * pad);
    const py = (v: number) => (CH - pad) - (v / xgMax) * (CH - 2 * pad);
    const xgLine = (key: 'h' | 'a', col: string) => {
      if (!series.length) return svgEl('g', {});
      // step line: cumulative xG holds flat between shots, then jumps — the honest shape
      const pts: string[] = [`${px(0).toFixed(1)},${py(0).toFixed(1)}`];
      let prev = 0;
      for (const s of series) { pts.push(`${px(s.t).toFixed(1)},${py(prev).toFixed(1)}`, `${px(s.t).toFixed(1)},${py(s[key]).toFixed(1)}`); prev = s[key]; }
      pts.push(`${px(tMax).toFixed(1)},${py(prev).toFixed(1)}`);
      return svgEl('polyline', { points: pts.join(' '), fill: 'none', stroke: col, 'stroke-width': 2 });
    };
    const xgSvg = svgEl('svg', { viewBox: `0 0 ${CW} ${CH}`, width: '100%', style: 'display:block' },
      svgEl('line', { x1: pad, y1: CH - pad, x2: CW - pad, y2: CH - pad, stroke: '#ffffff', 'stroke-opacity': 0.15, 'stroke-width': 1 }),
      xgLine('a', '#457b9d'), xgLine('h', '#e63946'));
    const xgBlock = h('div', {},
      h('div', { class: 'muted', style: 'font-size:10px;text-transform:uppercase;letter-spacing:.4px;margin:6px 0 3px' },
        `xG race · ${(lastS?.h ?? 0).toFixed(2)} `, h('span', { style: 'color:#e77' }, names.home), ' – ', h('span', { style: 'color:#8ab6d9' }, names.away), ` ${(lastS?.a ?? 0).toFixed(2)}`),
      series.length ? xgSvg : h('div', { class: 'muted', style: 'font-size:11px' }, 'No shots yet.'));
    statsContent.replaceChildren(ratingsBlock, shotBlock, xgBlock);
  };
  statsBtn.addEventListener('click', () => {
    if (watchStatsPanel) { closeStats(); return; }
    closeLineups();
    statsBtn.classList.add('primary'); statsBtn.classList.remove('ghost'); statsBtn.setAttribute('aria-pressed', 'true');
    statsContent = h('div', {});
    watchStatsPanel = h('div', { role: 'region', 'aria-label': 'Match statistics',
      style: 'position:fixed;left:12px;bottom:74px;width:min(330px,54vw);max-height:62vh;overflow:auto;z-index:40;background:rgba(12,19,32,.97);border:1px solid var(--line);border-radius:10px;padding:10px;box-shadow:0 6px 24px rgba(0,0,0,.45)' },
      h('div', { class: 'between', style: 'margin-bottom:6px' },
        h('span', { style: 'font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted)' }, '📊 Match stats'),
        h('button', { class: 'ghost small', 'aria-label': 'Close match stats', onclick: closeStats }, '×')),
      statsContent);
    document.body.appendChild(watchStatsPanel);
    renderStatsPanel();
    watchStatsTimer = setInterval(() => { if (myEpoch !== watchEpoch) { closeStats(); return; } renderStatsPanel(); }, 1500);
  });
  // 👥 Line-ups — a two-column (home/away) roster overlay: shirt number, short name, role tag, team dot.
  // Sourced from the renderer's per-frame roster (getRatings gives id/name/team/role; shirt = id%11+1 to
  // match the on-pitch labels). Built on open (rosters are stable within a match); torn down centrally.
  const lineupsBtn = h('button', { class: 'ghost small', 'aria-label': 'Toggle line-ups', 'aria-pressed': 'false', title: 'Match line-ups (both teams)' }, '👥 Line-ups') as HTMLButtonElement;
  closeLineups = (): void => {
    const restoreFocus = !!watchLineupsPanel?.contains(document.activeElement);
    watchLineupsPanel?.remove(); watchLineupsPanel = null;
    lineupsBtn.classList.remove('primary'); lineupsBtn.classList.add('ghost'); lineupsBtn.setAttribute('aria-pressed', 'false');
    if (restoreFocus) restoreOverlayFocus(lineupsBtn);
  };
  const openLineups = (): void => {
    if (!activeRenderer) return;
    closeStats();
    const names = activeRenderer.getTeamNames();
    const roster = activeRenderer.getRatings();
    const sideCol = (teamName: string, side: 'home' | 'away', dot: string) => {
      const list = roster.filter(r => r.team === side).sort((a, b) => (a.id % 11) - (b.id % 11));
      return h('div', { class: 'lu-side' },
        h('div', { class: 'lu-head' }, h('span', { class: 'lu-dot', style: `background:${dot}` }), h('span', { class: 'lu-team' }, teamName || (side === 'home' ? 'Home' : 'Away'))),
        ...(list.length ? list.map(r => h('div', { class: 'lu-row' },
          h('span', { class: 'lu-no' }, String((r.id % 11) + 1)),
          h('span', { class: 'lu-nm' }, shortName(r.name)),
          h('span', { class: 'lu-rl' }, r.role))) : [h('div', { class: 'muted', style: 'font-size:11px' }, 'Awaiting kick-off…')]));
    };
    const panel = h('div', { role: 'region', 'aria-label': 'Line-ups', class: 'watch-lineups' },
      h('div', { class: 'between', style: 'margin-bottom:8px' },
        h('span', { style: 'font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted)' }, '👥 Line-ups'),
        h('button', { class: 'ghost small', 'aria-label': 'Close line-ups', onclick: closeLineups }, '×')),
      h('div', { class: 'lu-cols' }, sideCol(names.home, 'home', '#e63946'), sideCol(names.away, 'away', '#4b93c9')));
    document.body.appendChild(panel);
    watchLineupsPanel = panel;
  };
  lineupsBtn.addEventListener('click', () => {
    if (watchLineupsPanel) { closeLineups(); return; }
    openLineups();
    if (!watchLineupsPanel) return;
    lineupsBtn.classList.add('primary'); lineupsBtn.classList.remove('ghost'); lineupsBtn.setAttribute('aria-pressed', 'true');
  });
  // ⋯ — everything secondary in ONE place (tactics overlay, match stats, line-ups, highlights tour, live goal
  // replay), so the bar itself stays: pause · speed · ⏪/⏩ · slider · ● LIVE. Items keep their own show/hide logic.
  const morePop = h('div', { style: 'display:none;position:absolute;top:100%;right:0;margin-top:6px;z-index:41;background:rgba(12,19,32,.96);border:1px solid var(--line);border-radius:8px;padding:6px;flex-direction:column;gap:6px;min-width:160px' },
    dirBtn, statsBtn, lineupsBtn, highlightBtn, replayBtn) as HTMLElement;
  const moreBtn = h('button', { class: 'ghost small', 'aria-label': 'More controls', 'aria-haspopup': 'true', 'aria-expanded': 'false', title: 'More — tactics overlay, highlights, goal replay' }, '⋯') as HTMLButtonElement;
  const setMoreOpen = (open: boolean): void => {
    morePop.style.display = open ? 'flex' : 'none';
    moreBtn.setAttribute('aria-expanded', String(open));
    moreBtn.classList.toggle('primary', open); moreBtn.classList.toggle('ghost', !open);
  };
  const closeMore = (returnFocus = false): void => { if (morePop.style.display === 'none') return; setMoreOpen(false); if (returnFocus) moreBtn.focus(); };
  moreBtn.addEventListener('click', () => setMoreOpen(morePop.style.display === 'none'));
  // Close after choosing any action, so the popover doesn't linger over the pitch (map: close-on-select).
  morePop.addEventListener('click', e => { if ((e.target as HTMLElement).closest('button')) closeMore(); });
  const moreWrap = h('div', { style: 'position:relative' }, moreBtn, morePop);
  // Outside-click dismissal (module-level so teardownWatch removes it alongside the other body-attached listeners).
  watchMoreOutside = (e: Event) => { if (morePop.style.display !== 'none' && !moreWrap.contains(e.target as Node)) closeMore(); };
  document.addEventListener('pointerdown', watchMoreOutside);
  restoreOverlayFocus = trigger => (morePop.style.display === 'none' ? moreBtn : trigger).focus();
  const rendererReadyControls = [dirBtn, statsBtn, lineupsBtn, moreBtn];
  const streamControls = [pauseBtn, ...speedPills];
  [...rendererReadyControls, ...streamControls].forEach(control => { control.disabled = true; });
  // status chips (weather + recorded/live) pinned to the bar's right edge even while the slider is hidden
  const chipGroup = h('div', { style: 'margin-left:auto;display:flex;gap:8px;align-items:center' }, weatherEl, recBadge);
  const bar = h('div', { class: 'watch-bar' },
    h('button', { class: 'ghost small', onclick: () => { location.hash = '#/'; } }, '← Back'),
    pauseBtn,
    speedGroup,
    stepGroup,
    scrubWrap,
    scrubLabel,
    goLiveBtn,
    moreWrap,
    chipGroup,
  );
  document.body.appendChild(bar);
  watchBar = bar;
  // P3 viewer keyboard shortcuts: space = pause/resume, ←/→ = seek ∓10s (Shift+←/→ = fine ∓2s),
  // , / . = prev/next moment (goal or red card). Seek-keys are no-ops on a live match (the coordinator
  // ignores seek) + before a moment index is loaded. Removed in teardownWatch. Ignored while typing a shout.
  watchKeyHandler = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && morePop.style.display !== 'none') { e.preventDefault(); closeMore(true); return; }   // Escape closes the ⋯ popover + restores focus to it
    if (isInteractiveTarget(e.target)) return;
    const step = e.shiftKey ? 2000 : 10000;   // Shift = a fine 2s nudge for landing on a specific touch
    if (e.key === ' ') { e.preventDefault(); pauseBtn.click(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); seekTo(Math.max(0, currentMs - step)); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); seekTo(currentMs + step); }
    else if (e.key === ',' || e.key === '.') {
      if (!highlightIndex.length) return;
      const target = e.key === '.'
        ? highlightIndex.find(g => g.clockMs > currentMs + 1500)
        : [...highlightIndex].reverse().find(g => g.clockMs < currentMs - 1500);
      if (target) { e.preventDefault(); seekTo(Math.max(0, target.clockMs - 4000)); }
    }
  };
  window.addEventListener('keydown', watchKeyHandler);

  // ── live tactics panel: type a plan, see what was understood, apply it ──
  const receiptEl = h('div', { class: 'tactics-receipt' });
  const ta = h('textarea', { class: 'tactics-input', rows: '2',
    placeholder: 'Shout at your team — "AB mark their striker, everyone push up", or rev them up: "come on Lange, sort it out". Each shout edits your standing plan.' }) as HTMLTextAreaElement;
  ta.disabled = true;
  const applyPlan = () => {
    const text = ta.value.trim();
    if (!text || activeWs?.readyState !== WebSocket.OPEN) return;
    receiptEl.replaceChildren(h('div', { class: 'muted' }, 'Applying…'));
    wsSend({ type: 'tactics', text });
  };
  // Ctrl/Cmd+Enter applies the shout (same as the Apply button) — keep your hands on the keyboard mid-match.
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); applyPlan(); }
  });
  const showReceipt = (r: TacticsReceipt) => {
    receiptEl.replaceChildren();
    if (r.error) { receiptEl.appendChild(h('div', { class: 'warn' }, '⚠ ' + r.error)); return; }
    if (r.formation) receiptEl.appendChild(h('div', { class: 'ok' }, `✓ Shape → ${r.formation}`));
    const note = (r.note ?? '').trim();
    const changed = (r.changed ?? '').trim();
    const motivation: MotivationReaction[] = Array.isArray(r.motivation) ? r.motivation : [];
    const dirs: DirectiveT[] = r.plan?.directives ?? r.directives ?? [];
    // The persistent "Active tactics" strip owns the full directive list — update it from this shout's plan.
    if (r.plan?.directives) { activeDirectives = r.plan.directives; renderActivePlan(); refreshDirOverlay(); }
    // The receipt now shows only what THIS shout DID (the live plan lives in the strip above).
    if (changed) receiptEl.appendChild(h('div', { class: 'ok' }, '✓ ' + changed));
    // Motivational reactions (personality-driven morale swings) — the team responding to the shout.
    for (const m of motivation) {
      receiptEl.appendChild(h('div', { class: 'receipt-line ' + (m.moraleDelta > 0 ? 'up' : 'down') },
        `${m.moraleDelta > 0 ? '▲' : '▼'} ${pname(m.playerId)} ${m.moraleDelta > 0 ? '+' : ''}${m.moraleDelta} morale${m.reaction ? ` — “${m.reaction}”` : ''}`));
    }
    // Manager-voice readback: the whole standing plan in prose (FM never narrates your tactic back).
    const summary = (r.plan?.summary ?? '').trim();
    if (summary) receiptEl.appendChild(h('div', { style: 'font-style:italic;color:var(--accent);margin:6px 0 2px;line-height:1.4' }, '“' + summary + '”'));
    if (!dirs.length && !motivation.length && !changed && !note && !r?.formation) {
      receiptEl.appendChild(h('div', { class: 'muted' }, "Couldn't read that as an order or a word to the players.")); return;
    }
    if (note) receiptEl.appendChild(h('div', { class: 'muted' }, '• ' + note));
  };
  // The persistent ACTIVE-PLAN strip: what the team is doing right now (updates on shouts) + a live
  // possession read so the tactic reads as a felt change, not an invisible directive.
  const possEl = h('span', { class: 'muted', style: 'font-size:11px' });
  const planEl = h('div', { class: 'tactics-receipt', style: 'border-bottom:1px solid var(--line);padding-bottom:7px;margin-bottom:7px;flex:0 0 auto;max-height:none' });
  const renderActivePlan = () => {
    planEl.replaceChildren(
      h('div', { class: 'between', style: 'font-size:12px;margin-bottom:3px' },
        h('span', { class: 'muted', style: 'text-transform:uppercase;letter-spacing:.4px' }, '📋 Active tactics'), possEl),
      ...(activeDirectives.length
        ? activeDirectives.map(d => h('div', { class: 'receipt-line', style: 'font-size:12px' }, '• ' + describeDirective(d)))
        : [h('div', { class: 'muted', style: 'font-size:12px' }, 'No standing instructions — shout to set the plan.')]));
  };
  renderActivePlan();
  // Shouts apply ON THE TICK — only a LIVE match (⚡ Play LIVE / the resident coordinator) honours them.
  // A replay, a re-sim (?shouts=1) or a quick-watch is finished/deterministic playback, so an editable
  // shout box there is meaningless (and misleading). Live → the full interactive panel; otherwise a
  // compact column holding the match stats + a dismissible one-line tip (G2 — was editable on past matches).
  // The right column's top slot hosts the renderer's stats block (ON-TGT/xG/BIG-CH/CORNERS + PRESSURE) —
  // it used to float over the scoreboard and the timeline at top-left.
  const statsHost = h('div', { class: 'watch-stats' });
  const TIP_KEY = 'footy:watch-tip-dismissed';
  let tipDismissed = false;
  try { tipDismissed = localStorage.getItem(TIP_KEY) === '1'; } catch { /* storage unavailable → just show it */ }
  const tipRow = h('div', { class: 'watch-tip' },
    h('span', { style: 'flex:1 1 auto;min-width:0' }, '💡 Shouts are live-only — use ⚡ Play LIVE to steer a match in real time.'),
    h('button', { class: 'ghost small', 'aria-label': 'Dismiss this tip', title: 'Dismiss',
      onclick: () => { tipRow.remove(); try { localStorage.setItem(TIP_KEY, '1'); } catch { /* */ } } }, '×'));
  const applyBtn = h('button', { class: 'primary small', title: 'Apply your shout (Ctrl+Enter)', onclick: applyPlan }, 'Apply') as HTMLButtonElement;
  applyBtn.disabled = true;
  // Quick structured set-piece shout: send the keeper up for late corners (rides the live inject channel as a
  // 'gk_up' command — no LLM). One tap = "up for every late corner"; the pre-match board sets the subtler mode.
  const gkUpBtn = h('button', { class: 'ghost small', title: 'Send your keeper up for late corners',
    onclick: () => { if (activeWs?.readyState === WebSocket.OPEN) { receiptEl.replaceChildren(h('div', { class: 'muted' }, 'Sending keeper up…')); wsSend({ type: 'gk_up', value: 1 }); } } }, '⬆ Keeper up') as HTMLButtonElement;
  gkUpBtn.disabled = true;
  const panelBody = h('div', { class: 'tactics-body' }, statsHost, planEl,
    h('div', { class: 'tactics-row' }, ta, applyBtn),
    h('div', { class: 'row', style: 'gap:6px;margin-top:6px;flex-wrap:wrap' }, gkUpBtn),
    receiptEl);
  // Mobile: the live shout panel docks over the pitch + commentary. A collapse toggle folds it to a slim header
  // so the match can be watched unobstructed, then reopened to shout. Default-collapsed on a phone (matchMedia),
  // and the choice is remembered. Desktop keeps it expanded in the right rail unless the user folds it.
  const SHOUT_KEY = 'footy:watch-shout-collapsed';
  let shoutCollapsed = false;
  try { const s = localStorage.getItem(SHOUT_KEY); shoutCollapsed = s === null ? window.matchMedia('(max-width:700px)').matches : s === '1'; } catch { /* storage unavailable → stay expanded */ }
  const collapseBtn = h('button', { class: 'ghost small', 'aria-label': 'Collapse or expand the shout panel', 'aria-expanded': String(!shoutCollapsed) }, '▾') as HTMLButtonElement;
  const panelHead = h('div', { class: 'tactics-head' }, h('span', { class: 'th-lbl' }, '📣 Shouts'), collapseBtn);
  const panel = live
    ? h('div', { class: 'tactics-panel' }, panelHead, panelBody)
    : h('div', { class: 'tactics-panel compact' }, statsHost, ...(tipDismissed ? [] : [tipRow]));
  if (live) {
    const applyCollapse = (): void => {
      panel.classList.toggle('collapsed', shoutCollapsed);
      panelBody.hidden = shoutCollapsed;
      collapseBtn.textContent = shoutCollapsed ? '▸' : '▾';
      collapseBtn.setAttribute('aria-expanded', String(!shoutCollapsed));
    };
    collapseBtn.addEventListener('click', () => {
      shoutCollapsed = !shoutCollapsed;
      try { localStorage.setItem(SHOUT_KEY, shoutCollapsed ? '1' : '0'); } catch { /* ignore */ }
      applyCollapse();
    });
    applyCollapse();
  }
  document.body.appendChild(panel);
  watchPanel = panel;

  // ⚽ goal markers (replays only): pull the report timeline so every goal is known upfront — you can
  // jump to one before playback reaches it. Best-effort: another club's match has no report → no markers,
  // the scrub still works. The markers only show once the scrub is revealed (a recorded replay).
  if (!live) {
    api.report(fixtureId, cup).then(rep => {
      if (myEpoch !== watchEpoch) return;
      const events = (rep.facts?.timeline ?? [])
        .filter(e => e.type === 'goal' || e.type === 'yellow' || e.type === 'red' || e.type === 'penalty' || e.type === 'woodwork')
        // EXACT event clock when the report carries it. The display minute is floor(ms/60000)+1, so the old
        // minute*60000 mapping overshot by up to 60s — every recorded jump-to-goal landed AFTER the goal
        // (you saw the celebration, never the shot). Old cached reports (no clockMs) fall back to the START
        // of the display minute, so the −4s pre-roll can never land past the moment.
        .map(e => ({ clockMs: typeof e.clockMs === 'number' ? e.clockMs : Math.max(0, ((e.minute ?? 1) - 1) * 60000), name: e.name, kind: e.type }));
      if (events.length) { buildMarkers(events); hasReportMarkers = true; }   // full upfront set → suppress the incremental live-marks (which reassign wholesale)
    }).catch(() => { /* no report (re-sim / another club) → scrub without markers (falls back to live-marks) */ });
  }

  // Pixi is by far the largest frontend dependency. Load it only when a match is actually watched so every
  // management screen reaches first paint without downloading/parsing the renderer bundle.
  const rendererStatus = h('div', { class: 'watch-status', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' }, h('div', { class: 'spin' }, 'Loading match viewer…'));
  document.body.appendChild(rendererStatus);
  watchStatus = rendererStatus;
  const showRendererLoadError = () => {
    const retry = h('button', { class: 'primary small', onclick: () => void screenWatch(fixtureId, shouts, live, startMs, cup) }, 'Retry') as HTMLButtonElement;
    rendererStatus.setAttribute('role', 'alert');
    rendererStatus.setAttribute('aria-live', 'assertive');
    rendererStatus.replaceChildren(
      h('div', { class: 'err' }, 'The match viewer could not be loaded.'),
      h('div', { class: 'row', style: 'justify-content:center' },
        retry,
        h('button', { class: 'ghost small', onclick: () => location.reload() }, 'Reload app'),
        h('button', { class: 'ghost small', onclick: () => { location.hash = '#/'; } }, '← Back')));
    retry.focus();
  };
  let rendererModule: typeof import('../renderer');
  try { rendererModule = await import('../renderer'); }
  catch {
    if (myEpoch !== watchEpoch) return;
    showRendererLoadError();
    return;
  }
  if (myEpoch !== watchEpoch) return;
  let renderer: MatchRendererInstance | null = null;
  try {
    renderer = new rendererModule.MatchRenderer();
    activeRenderer = renderer;
    await renderer.init();
  } catch {
    try { renderer?.destroy(); } catch { /* partially initialised renderer */ }
    if (activeRenderer === renderer) activeRenderer = null;
    if (myEpoch !== watchEpoch) return;
    showRendererLoadError();
    return;
  }
  // If the user navigated away (or to another match) during the async init, this screen is stale:
  // teardownWatch already ran — destroy this orphan renderer and stop before opening a socket.
  if (myEpoch !== watchEpoch) { renderer.destroy(); return; }
  rendererStatus.remove(); watchStatus = null;
  // Dock the renderer's live-stats block into the right column's top slot (it renders detached until then).
  renderer.dockStats(statsHost);
  renderer.setShowDirectives(dirOn);
  rendererReadyControls.forEach(control => { control.disabled = false; });

  // Keep the pitch clear of every panel: reserve the TOP for the scoreboard + control bar (measured —
  // the bar wraps on narrow viewports), and the panel's height/width at bottom/right. Wide screens dock
  // the panel RIGHT (reserve width → the pitch keeps full height); narrow screens (≤860px, matching the
  // CSS media query that bottom-docks it) reserve its height. Hidden (replay) → free both. The pitch
  // always claims the remaining space, so it can no longer collapse to a thumbnail behind full-size panels.
  const syncReserve = () => {
    const hudBottom = renderer.hudElement?.getBoundingClientRect().bottom ?? 0;
    const barBottom = bar.getBoundingClientRect().bottom;
    renderer.setReservedTop(Math.max(hudBottom, barBottom) + 6);
    const visible = panel.style.display !== 'none' && panel.offsetWidth > 0;
    if (!visible) { renderer.setReservedRight(0); renderer.setReservedBottom(8); panel.style.top = ''; return; }
    if (window.innerWidth > 860) {
      panel.style.top = `${Math.round(barBottom) + 8}px`;   // the right column starts under the control bar
      renderer.setReservedRight(panel.offsetWidth + 24);
      renderer.setReservedBottom(8);
    } else {
      panel.style.top = '';                                  // CSS bottom-docks it ≤860px
      renderer.setReservedRight(0);
      renderer.setReservedBottom(panel.offsetHeight + 24);
    }
  };
  watchPanelObs = new ResizeObserver(syncReserve);
  watchPanelObs.observe(panel);
  watchPanelObs.observe(bar);   // the bar wraps/unwraps with viewport width → re-measure the top reserve
  syncReserve();

  // Connecting overlay — the canvas is otherwise a blank dark void until the first frame
  // arrives (and silently stays one if the match never starts). Cleared on the first frame.
  const status = h('div', { class: 'watch-status', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' }, h('div', { class: 'spin' }, 'Connecting to match…'));
  document.body.appendChild(status);
  watchStatus = status;
  const showStatusError = (msg: string) => {
    if (myEpoch !== watchEpoch) return;   // superseded — don't resurrect an overlay teardown removed
    // Once the first frame arrived, `status` was removed from the DOM (see `status.remove()`). A later
    // mid-stream error (e.g. a failed re-sim) must re-attach it, or the message is written to a detached
    // node and the user sees nothing while the pitch freezes.
    if (!status.isConnected) { document.body.appendChild(status); watchStatus = status; }
    const retry = h('button', { class: 'primary small', onclick: () => void screenWatch(fixtureId, shouts, live, startMs, cup) }, 'Retry') as HTMLButtonElement;
    status.setAttribute('role', 'alert');
    status.setAttribute('aria-live', 'assertive');
    status.replaceChildren(
      h('div', { class: 'err' }, msg),
      h('div', { class: 'row', style: 'justify-content:center' },
        retry,
        h('button', { class: 'ghost small', onclick: () => { location.hash = '#/'; } }, '← Back')),
    );
    status.style.display = '';
    retry.focus();
  };

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const wsQuery = cup ? `cup=${fixtureId}` : `fixture=${fixtureId}${shouts ? '&shouts=1' : ''}${live ? '&live=1' : ''}`;
  const ws = new WebSocket(`${proto}://${location.host}/ws/match?${wsQuery}`);
  activeWs = ws;
  const setStreamReady = (ready: boolean): void => {
    streamControls.forEach(control => { control.disabled = !ready; });
    if (live) { ta.disabled = !ready; applyBtn.disabled = !ready; gkUpBtn.disabled = !ready; }
  };
  ws.onopen = () => { if (myEpoch === watchEpoch) setStreamReady(true); };
  let replayUiApplied = false;
  let gotFrame = false;
  let lastMatchState: EngineState['matchState'] | null = null;
  let connectionErrorShown = false;
  // ── live goal replay: buffer recent frames; on a goal, snapshot the run-up + offer an instant replay ──
  const GOAL_CLIP = 130;                       // frames of run-up to keep (~several seconds before the goal)
  const LIVE_BUFFER_MAX = 7200;                // ~12 min of rewind at the ~10fps thinned rate (bounds memory ~35MB)
  const liveBuffer: WatchMessage[] = [];
  const liveMarks: { clockMs: number; name: string; kind: string }[] = [];   // goal/card markers indexed live (no report)
  const seenMarkKeys = new Set<string>();   // dedup live markers per EVENT (events linger ~78 frames), not per frame
  let goalClip: WatchMessage[] | null = null;
  let replaying = false;
  let hiddenLatest: WatchMessage | null = null;   // newest frame skipped while the tab was hidden — synced once on return
  // ── live rewind (viewer #1) ── a live watch (re-sim or coordinator) has NO backend seek — frames are
  // generated on the fly. So buffer them client-side + let the scrub / ⏪ / ⏮ play BACK through the buffer
  // (real-time paced) and catch up to live; ● LIVE resumes. Additive: a live watch with no rewind action is
  // untouched. A RECORDED replay keeps using the backend seek (full random access). `replaying` gates the
  // live-frame render in onmessage (frames keep buffering while you're rewound).
  let liveSeek = false;   // a live watch has buffered enough → route the scrub/rewind to the buffer
  let playbackGen = 0;    // bumped per buffer-playback start → invalidates any prior step() chain (re-entrant safety)
  // A goal clip's ⚽ button reset used to live ONLY in the clip's own completion branch — any seek/resume that
  // cleared the shared timer externally stranded it disabled on "⏵ Replaying…" forever. Idempotent, so every
  // supersession path (seek → startBufferPlayback, ● LIVE → resumeLive) just calls it.
  const resetClipButton = (): void => { replayBtn.disabled = false; replayBtn.textContent = '⚽ Replay goal'; };
  const resumeLive = (): void => {
    if (myEpoch !== watchEpoch) return;   // a stale callback must not touch the new watch's renderer/controls
    replaying = false;
    if (activeReplayTimer) { clearTimeout(activeReplayTimer); clearInterval(activeReplayTimer); activeReplayTimer = null; }
    resetClipButton();
    activeRenderer?.setReplay(false);
    goLiveBtn.style.display = 'none';
    if (activeRenderer && liveBuffer.length) {
      const f = liveBuffer[liveBuffer.length - 1];
      activeRenderer.sync(f);
      if (typeof f.clockMs === 'number') { currentMs = f.clockMs; if (!scrubbing) { scrubEl.value = String(f.clockMs); paintScrubLabel(f.clockMs); } }
    }
  };
  const startBufferPlayback = (startIdx: number): void => {
    if (!activeRenderer || !liveBuffer.length) return;
    const myGen = ++playbackGen;            // a fresh re-scrub invalidates any in-flight step() chain
    replaying = true;                       // gate the live-frame render (onmessage keeps buffering)
    resetClipButton();                      // a seek supersedes a goal clip — never leave ⚽ stuck on "⏵ Replaying…"
    // Suppress the live GOAL / HALF-TIME banner while replaying buffered frames FORWARD across a rewind —
    // else crossing a goal during the rewind re-pops "GOAL!" though none was scored. setReplay only sets the
    // suppression flag; the "⚽ GOAL REPLAY" overlay is playClip's separate doing, so a PLAIN rewind still
    // shows no overlay (that stays playClip's job). resumeLive() clears the flag.
    activeRenderer.setReplay(true);
    // The resume button reads ● LIVE only on a TRUE live match; on a re-sim it's "▶ Resume" (no live edge).
    // The button's presence is the rewound indicator.
    goLiveBtn.textContent = live ? '● LIVE' : '▶ Resume';
    goLiveBtn.title = live ? 'Jump back to the live edge' : 'Resume to the latest point';
    goLiveBtn.style.display = '';
    // SNAPSHOT the playback range. onmessage keeps push+shift()ing liveBuffer while we play (at the 7200-frame
    // cap — i.e. past ~12 buffered minutes — every arriving frame evicts the head), so indexing the LIVE array
    // slid frames under the cursor: rewound playback ran ~2× with every other frame skipped and slammed back
    // into the live edge early. The slice shares frame references (no copy of the frames themselves); when it's
    // exhausted, resumeLive() syncs to the TRUE current live edge anyway.
    const clip = liveBuffer.slice(Math.max(0, Math.min(startIdx, liveBuffer.length - 1)));
    let i = 0;
    if (activeReplayTimer) { clearTimeout(activeReplayTimer); clearInterval(activeReplayTimer); activeReplayTimer = null; }
    const step = (): void => {
      if (myEpoch !== watchEpoch || !activeRenderer || !replaying || myGen !== playbackGen) return;   // navigated / torn down / resumed / superseded
      if (paused) { activeReplayTimer = setTimeout(step, 150); return; }   // ⏸ freezes the buffer playback too (was: button said paused, pitch kept moving)
      if (i >= clip.length - 1) { resumeLive(); return; }  // played the snapshot out → follow live from the current edge
      const f = clip[i];
      activeRenderer.sync(f);
      if (typeof f.clockMs === 'number' && !scrubbing) { currentMs = f.clockMs; scrubEl.value = String(f.clockMs); paintScrubLabel(f.clockMs); }
      const cur = f.clockMs ?? 0, nxt = clip[i + 1]?.clockMs ?? cur + 250;
      i++;
      // paced by the frame deltas SCALED by the chosen speed (was: real-time only — the speed control
      // silently did nothing while rewound). curSpeed tracks the last frame's actual state.speed.
      activeReplayTimer = setTimeout(step, Math.max(16, Math.min((nxt - cur) / Math.max(0.25, curSpeed), 1000)));
    };
    step();
  };
  const seekLiveBuffer = (targetMs: number): void => {
    if (!liveBuffer.length) return;
    const lastMs = liveBuffer[liveBuffer.length - 1].clockMs ?? 0;
    if (targetMs >= lastMs - 300) { resumeLive(); return; }     // at/after the live edge → just follow live
    let idx = liveBuffer.findIndex(f => (f.clockMs ?? 0) >= targetMs);
    if (idx < 0) idx = 0;
    startBufferPlayback(idx);
  };
  // unified seek: a recorded replay seeks the backend (full random access); a live watch seeks the buffer.
  let pendingSeekMs: number | null = null;   // a backend seek is in flight — drop pre-seek frames so the pitch/thumb don't flick back first
  let pendingSeekAt = 0;
  const seekTo = (targetMs: number): void => {
    if (liveSeek) { seekLiveBuffer(targetMs); return; }
    if (!replayUiApplied) return;   // a live re-sim before its buffer is ready / a non-seekable stream: nothing to backend-seek (avoid a dead send)
    pendingSeekMs = Math.max(0, targetMs); pendingSeekAt = performance.now();
    wsSend({ type: 'seek', value: Math.max(0, targetMs) });
    // ReplayStream.seekTo() force-resumes the backend, so re-sync the local pause label — else the Pause
    // button inverts (reads "▶ Resume" while the match visibly plays, and needs two clicks to recover).
    if (paused) { paused = false; pauseBtn.textContent = '⏸ Pause'; paintBar(); }
  };
  // 🎞 highlights reel: tour every goal + red card — seek to ~5s before each, ~11s apart. Reuses seekTo (so
  // it rides the recorded backend-seek, or the live buffer). Stops on click, at the end, or on navigation
  // (epoch). The timer is module-level (activeHighlightTimer) so teardownWatch can cancel a pending tour step.
  const stopHighlights = (): void => {
    if (activeHighlightTimer) { clearTimeout(activeHighlightTimer); activeHighlightTimer = null; }
    highlightBtn.textContent = '🎞 Highlights'; highlightBtn.classList.add('ghost'); highlightBtn.classList.remove('primary');
  };
  const playHighlights = (): void => {
    if (!highlightIndex.length) return;
    let gi = 0;
    highlightBtn.textContent = '⏹ Stop'; highlightBtn.classList.add('primary'); highlightBtn.classList.remove('ghost');
    const next = (): void => {
      if (myEpoch !== watchEpoch || gi >= highlightIndex.length) { stopHighlights(); return; }
      seekTo(Math.max(0, highlightIndex[gi].clockMs - 5000));
      gi++;
      activeHighlightTimer = setTimeout(next, 11000);
    };
    next();
  };
  highlightBtn.onclick = () => { if (activeHighlightTimer) stopHighlights(); else playHighlights(); };
  const playClip = () => {
    if (myEpoch !== watchEpoch || replaying || !goalClip || !goalClip.length || !activeRenderer) return;
    stopHighlights();   // the tour and a goal clip are mutually exclusive — don't let an 11s tour-step seek mid-clip
    replaying = true;
    activeRenderer.setReplay(true);   // GOAL-REPLAY banner — ONLY here (an actual goal replay), not plain rewind
    replayBtn.disabled = true; replayBtn.textContent = '⏵ Replaying…';
    const clip = goalClip;
    let i = 0;
    playbackGen++;   // supersede any live-rewind step() chain (shared activeReplayTimer)
    if (activeReplayTimer) { clearTimeout(activeReplayTimer); clearInterval(activeReplayTimer); activeReplayTimer = null; }   // a live-rewind timer is a setTimeout — clear BOTH
    activeReplayTimer = setInterval(() => {
      if (myEpoch !== watchEpoch || !activeRenderer || i >= clip.length) {          // navigated / torn down / clip done
        if (activeReplayTimer) { clearInterval(activeReplayTimer); activeReplayTimer = null; }
        replaying = false;
        activeRenderer?.setReplay(false);   // drop the overlay + resume live goal banners
        resetClipButton();
        if (activeRenderer && liveBuffer.length) { const lf = liveBuffer[liveBuffer.length - 1]; activeRenderer.sync(lf); if (typeof lf.clockMs === 'number' && !scrubbing) { currentMs = lf.clockMs; scrubEl.value = String(lf.clockMs); paintScrubLabel(lf.clockMs); } }   // snap back to live
        return;
      }
      const cf = clip[i];
      activeRenderer.sync(cf);   // the score/clock rewinds through the clip, then snaps forward to live
      if (typeof cf.clockMs === 'number' && !scrubbing) { currentMs = cf.clockMs; scrubEl.value = String(cf.clockMs); paintScrubLabel(cf.clockMs); }   // keep the scrub tracking during the clip
      i++;
    }, 45);
  };
  replayBtn.addEventListener('click', playClip);
  // Background-tab policy: while hidden, a throttled (≥1s) replay timer would crawl a rewind/goal-clip at
  // ~1fps AND hold `replaying` so nothing live draws on return — jump back to live instead. On return,
  // sync the newest frame we skipped so the pitch is current the instant the tab is visible again.
  watchVisHandler = (): void => {
    if (myEpoch !== watchEpoch) return;
    if (document.hidden) { if (replaying) resumeLive(); return; }
    if (hiddenLatest && activeRenderer) { const f = hiddenLatest; hiddenLatest = null; renderer.sync(f); paintBar(f.speed); }
  };
  document.addEventListener('visibilitychange', watchVisHandler);
  ws.onmessage = (ev) => {
    if (myEpoch !== watchEpoch) return;   // navigated away — a queued frame must not sync() the now-destroyed renderer or touch detached DOM (matches the guards at the api callsites)
    try {
      const msg = JSON.parse(ev.data) as WatchMessage;
      if (msg.error) { connectionErrorShown = true; setStreamReady(false); showStatusError(msg.error); try { ws.close(); } catch { /* */ } return; }   // re-sim failed (e.g. replay-from-shouts)
      if (typeof msg.matchState === 'string') lastMatchState = msg.matchState;
      // A backend seek is in flight: frames sent BEFORE the backend processed it would flick the pitch +
      // thumb back to the pre-seek position for a beat. Drop them until a frame lands near the target
      // (or the gate times out — accept whatever streams then, e.g. a seek past the end re-sends the tail).
      if (pendingSeekMs !== null && typeof msg.clockMs === 'number') {
        if (Math.abs(msg.clockMs - pendingSeekMs) <= 2500 || performance.now() - pendingSeekAt > 2000) pendingSeekMs = null;
        else return;
      }
      // Reconcile pause from the stream's own state: a refused command (spectator seat on a live match),
      // another manager pausing, or a backend force-resume can all desync the local flag — the frame is
      // the truth. Grace window after a local click so in-flight pre-click frames don't flap it back.
      // NOT while rewound (`replaying`): there the local pause governs the BUFFER playback, and the live
      // feed's 'running' state must not resume it out from under the viewer.
      if (typeof msg.matchState === 'string' && !replaying && performance.now() - pauseClickedAt > 1200) {
        const srvPaused = msg.matchState === 'paused';
        if (srvPaused !== paused) { paused = srvPaused; pauseBtn.textContent = paused ? '▶ Resume' : '⏸ Pause'; paintBar(msg.speed); }
      }
      // A replayed recording is finished playback: reveal the rewind/scrub/back-10s controls. The shout
      // box is already gone (the panel is the read-only live-only note when !live), so keep the note visible.
      if (msg.replay && !replayUiApplied) {
        replayUiApplied = true; stepGroup.style.display = 'flex'; scrubWrap.style.display = 'inline-flex'; scrubLabel.style.display = ''; syncReserve();
        // deep-link (#/watch/id?t=ms — e.g. a report-timeline click): jump straight to the moment once seekable
        if (startMs > 0) { seekTo(Math.max(0, startMs)); startMs = 0; }
      }
      // a recording knows its real length → the slider spans the actual match, not a fixed 96',
      // and the time label can read "current / total"
      if (typeof msg.durationMs === 'number') { knownDurationMs = msg.durationMs; setScrubMax(msg.durationMs + 1000); }
      // Track the playhead while FOLLOWING (a recorded replay, or a live watch at the edge) — but not while
      // dragging, and not while rewound (`replaying`: the buffer-playback loop owns the playhead then).
      if ((replayUiApplied || liveSeek) && !replaying && typeof msg.clockMs === 'number') {
        currentMs = msg.clockMs;
        if (!scrubbing) { scrubEl.value = String(msg.clockMs); paintScrubLabel(msg.clockMs); }
      }
      if (msg.tacticsReceipt) { showReceipt(msg.tacticsReceipt); return; }
      if (Array.isArray(msg.players)) setDirectiveNames(msg.players.map(p => ({ id: p.id, name: p.name })));
      if (!gotFrame) {
        gotFrame = true; status.remove(); watchStatus = null; watchIsHome = msg.homeName === myTeam?.name; refreshDirOverlay();
        if (msg.homeName && msg.awayName) document.title = `${msg.homeName} v ${msg.awayName} · Footy Manager`;
        if (live) { recBadge.textContent = '🔴 LIVE'; recBadge.title = 'Live match — the result counts.'; }
        else if (shouts) { recBadge.textContent = '⚙ Re-sim'; recBadge.title = 'Re-simulated from your shouts.'; }
        else if (msg.replay) { recBadge.textContent = '📹 Recorded'; recBadge.title = 'A faithful recording of how this match was played.'; }
        else { recBadge.textContent = '⚙ Re-simulated'; recBadge.title = 'Not recorded — re-simulated on the latest engine, so the scoreline may differ from the league table.'; }
        recBadge.style.display = '';   // hidden until it has something to say (an empty chip renders as a stray pill)
      }
      // §weather: show the match's condition once (clear stays hidden — only the notable conditions show)
      if (msg.weather && msg.weather !== 'clear' && !weatherEl.textContent) {
        weatherEl.textContent = msg.weather === 'rain' ? '🌧 Rain' : '🌬 Wind';
        weatherEl.title = msg.weather === 'rain' ? 'Wet pitch — the ball skids further' : 'Windy — long balls and crosses drift';
        weatherEl.style.display = '';
      }
      // felt-tactics: live possession in the active-plan strip (YOUR share — flip it when you're the away side)
      if (typeof msg.possessionPct === 'number' && myTeam && msg.homeName) {
        const mine = msg.homeName === myTeam.name ? msg.possessionPct : 100 - msg.possessionPct;
        possEl.textContent = `Possession ${Math.round(mine)}%`;
      }
      // buffer live frames (a recorded replay has its own backend rewind/seek). The buffer powers BOTH the
      // goal replay AND the live rewind (viewer #1) — keep ~a full match so you can rewind to any of it.
      if (!msg.replay && Array.isArray(msg.players)) {
        // Thin the rewind buffer to ~10fps (the renderer interpolates, so playback stays smooth) — this bounds
        // memory AND gives a predictable ~12-min rewind window regardless of the raw live frame rate (~37fps).
        // Always keep a goal frame (for the run-up + marker). The LIVE render below is unthinned (full fps).
        const lastBuf = liveBuffer[liveBuffer.length - 1];
        const goalFrame = !!(msg.events && msg.events.some(e => e.type === 'goal'));
        const dueByTime = !lastBuf || typeof msg.clockMs !== 'number' || typeof lastBuf.clockMs !== 'number' || Math.abs(msg.clockMs - lastBuf.clockMs) >= 100;
        if (goalFrame || dueByTime) {
          liveBuffer.push(msg);
          if (liveBuffer.length > LIVE_BUFFER_MAX) liveBuffer.shift();
        }
        // ⚽ Replay-goal (with its GOAL-REPLAY banner) is a TRUE-live-only control — on a re-sim it'd raise
        // the banner inappropriately; re-sim users jump to goals via the markers instead. (P0 bug-fix #6.)
        if (goalFrame) {
          goalClip = liveBuffer.slice(-GOAL_CLIP);
          // the ⚽ Replay item lives in the ⋯ menu now — light the ⋯ up so a fresh goal replay is discoverable
          if (live) { replayBtn.style.display = ''; if (morePop.style.display === 'none') { moreBtn.classList.add('primary'); moreBtn.classList.remove('ghost'); } }
        }
        // live goal/card markers — a stream with NO upfront report (a true live match; a re-sim of a
        // report-less fixture) indexes events as they happen so the scrub shows ⚽/🟨/🟥 + jump + , / . +
        // highlights mid-game. SKIP when the report already supplied the full timeline (recorded, and now the
        // buffered shouts-replay) — else buildMarkers(liveMarks) reassigns wholesale and clobbers the full set.
        const marks = hasReportMarkers ? [] : (msg.events ?? []).filter(e => e.type === 'goal' || e.type === 'yellow' || e.type === 'red' || e.type === 'penalty' || e.type === 'woodwork');
        if (marks.length && typeof msg.clockMs === 'number') {
          let added = false;
          for (const e of marks) {
            // An engine event lingers ~2600ms in the feed (~78 frames at 30fps), so pushing per-frame stacks
            // ~78 duplicate markers per goal (breaking highlights + ,/. nav). Dedup per EVENT with the same key
            // the renderer's ticker uses (type:player:evClock/400 — evClock = frameClock − age).
            const evClock = msg.clockMs - (e.age ?? 0);
            const key = `${e.type}:${e.playerId}:${Math.round(evClock / 400)}`;
            if (seenMarkKeys.has(key)) continue;
            seenMarkKeys.add(key);
            liveMarks.push({ clockMs: evClock, name: e.playerId != null ? pname(e.playerId) : (e.type === 'goal' ? 'Goal' : e.type === 'red' ? 'Red card' : e.type === 'penalty' ? 'Penalty' : e.type === 'woodwork' ? 'Woodwork' : 'Booking'), kind: e.type });
            added = true;
          }
          if (added) buildMarkers(liveMarks);
        }
        // reveal the rewind/scrub controls for a LIVE watch once there's enough buffered to seek within
        if (!liveSeek && liveBuffer.length >= 8) { liveSeek = true; stepGroup.style.display = 'flex'; scrubWrap.style.display = 'inline-flex'; scrubLabel.style.display = ''; syncReserve(); }
        // the live slider spans the actual rewind WINDOW (oldest buffered → the live edge) — the whole track
        // is reachable, instead of a fixed 96' where only the last ~12 buffered minutes meant anything.
        // setScrubRange dirty-checks (1.5s) + never moves the range mid-drag, so this is cheap per push.
        if (liveSeek) {
          const oldest = liveBuffer[0]?.clockMs, newest = liveBuffer[liveBuffer.length - 1]?.clockMs;
          if (typeof oldest === 'number' && typeof newest === 'number') setScrubRange(oldest, Math.max(newest, oldest + 30000));
        }
      }
      if (replaying) return;   // a goal clip OR a live rewind is driving the renderer — keep buffering, don't draw live
      // Background tab: rAF is paused so nothing renders anyway — skip the full sync (trail/event/DOM work at
      // 30-37Hz for the whole match) and just remember the newest frame; visibilitychange snaps it current.
      if (document.hidden) { hiddenLatest = msg; return; }
      hiddenLatest = null;
      renderer.sync(msg);
      paintBar(msg.speed);   // highlight the active speed off the frame

    } catch (e) { console.warn('[watch] dropped a malformed frame', e); }   // one bad frame shouldn't kill the watch (the next frame redraws) — but surface it for debugging rather than swallowing silently
  };
  const connectionFailed = (message: string): void => {
    if (connectionErrorShown || myEpoch !== watchEpoch) return;
    connectionErrorShown = true;
    showStatusError(message);
  };
  ws.onerror = () => { setStreamReady(false); connectionFailed(gotFrame ? 'Connection lost before full-time.' : 'Could not connect to the match.'); };
  // A normal full-time close needs no overlay. Any other close—including one after frames began—used to leave
  // a frozen pitch with no explanation; surface it and offer an in-place retry.
  ws.onclose = () => {
    setStreamReady(false);
    if (myEpoch !== watchEpoch || lastMatchState === 'finished') return;
    connectionFailed(gotFrame ? 'Connection lost before full-time.' : 'The match could not be started.');
  };
  // Teardown is owned centrally by route() (it calls teardownWatch() on leaving '#/watch/') and by
  // the next screenWatch() (which calls teardownWatch() up front) — so no per-screen hashchange
  // listener is needed here. Adding one per visit used to leak a listener on every watch→watch.
}
