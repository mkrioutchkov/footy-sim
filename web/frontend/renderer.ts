import { Application, Graphics, Container, Text, TextStyle } from 'pixi.js';
import { cappedResolution } from './util';
import {
  PITCH_W, PITCH_H, PLAYER_R, BALL_R,
  LINE_COLOR, PITCH_GREEN, HOME_COLOR, AWAY_COLOR, HOME_GK_COLOR, AWAY_GK_COLOR, GOAL_COLOR,
  GOAL_W, GOAL_DEPTH,
  PENALTY_AREA_W, PENALTY_AREA_H,
  GOAL_AREA_W, GOAL_AREA_H,
  CENTER_CIRCLE_R, CORNER_ARC_R,
  clamp, lerp,
} from './constants';
import type { EngineState } from './types';

const TRAIL_LENGTH = 16;
// Render-only player disc radius. Smaller than the physics PLAYER_R (12) so the pitch reads less
// crowded, the ball stays legible against a pack, and there's room for the facing chevron drawn at
// the disc edge. Every player-owned graphic (body, shadow, boots/head, chevron, carrier ring, label
// offset) scales off this; transient effect rings (events, set-piece) stay on the physics PLAYER_R.
const DISC_R = PLAYER_R * 0.78;
// Gate the per-frame diagnostic logging (first-sync dump + facing-flicker warnings). Off in
// normal play so the hot path doesn't do per-player bookkeeping or spam the console.
const RENDER_DEBUG = false;

type PlayerEntry = {
  shadow: Graphics;      // a soft drop-shadow under the body → reads as a lit 3D figure, not a flat disc
  body: Graphics;
  arrow: Graphics;
  label: Text;
  dirTag: Text;          // the player's ACTIVE tactical directive (shown when the overlay is on; "type it → see it work")
  dirShown: string;      // last directive text written (dirty-check)
  drawn: boolean;
  wasSliding: boolean;
  wasDiving: boolean;
  hadBall: boolean;
  slideAngle: number;
  diveAngle: number;
  // ── R28 C9 duel legibility (render-only) ──
  wasRawSliding: boolean;   // raw engine tackleAnim>0 last keyframe (latch onset detector)
  slideLatchUntil: number;  // match-clock ms: keep displaying the tackle pose until then (min ~450ms —
                            // a 220ms standing win is ~2.6 keyframes at 12fps, sub-perceptual without it)
  latchSlideKind: boolean;  // latched pose: true = grounded slide, false = standing poke
  pokeAngle: number;        // locked at onset — the poked leg aims at the BALL contact point, not the run direction
  lastDribbleType: number;
  wasSprinting: boolean;
  name: string;          // the label's base (short) name — the live rating is appended to it
  ratingShown: number;   // last rating written to the label (dirty-check; -1 = none yet)
  statusShown: string;   // last condition marker (🟥/🤕/🟨) written to the label (dirty-check)
  // ── boot-arrow dirty-check (the arrow redraws in the 60fps ticker; skip it when its inputs are unchanged) ──
  armDrawn: boolean;     // has the arrow been drawn at least once
  armAngle: number;      // last facing angle drawn
  armCtrlX: number;      // last ball-relative control vector drawn (a carrier aims his boots at the ball)
  armCtrlY: number;
  armHasBall: boolean;
  armHeading: boolean;   // last header-pose state
  armKnock: boolean;     // last knock-dribble state
  armDive: boolean;      // last GK dive-pose state (gates the ready-glove draw so it redraws when a dive starts/ends)
};

export class MatchRenderer {
  app: Application;
  pitchContainer: Container;
  private playerLayer: Container;
  private trailPool: Graphics[] = [];
  private shotTrailGfx: Graphics;
  private shotTrailBuffer: { x: number; y: number; z: number }[] = [];
  private playerEntries: Map<number, PlayerEntry> = new Map();
  private ringGfx: Graphics;
  // Round-27 COMMIT 8a: cross-fade the possession ring over ~150ms on a change
  // instead of snapping it in one keyframe. ringCurController tracks the live
  // controller for change detection; ringFadeFrom holds the one fading out.
  private ringCurController: number | null = null;
  private ringFadeFrom: number | null = null;
  private ringChangeAtMs = 0;
  private ballBody: Graphics;
  private ballGlow: Graphics;
  private ballHighlight: Graphics;   // faint elevation halo hugging a lofted ball → reads as lit/floating
  // ── scoreboard (DOM) ── one clean full-width strip: teams + score + a BIG clock + shots/poss.
  // DOM (not canvas Text) so it's crisp, styleable from styles.css, and can never be occluded by
  // the floating controls (the old canvas HUD sat under the top-left button pile).
  private hudEl: HTMLDivElement | null = null;
  private hudRefs: { home: HTMLElement; score: HTMLElement; away: HTMLElement; half: HTMLElement; time: HTMLElement;
    added: HTMLElement; shots: HTMLElement; poss: HTMLElement; state: HTMLElement; possHome: HTMLElement } | null = null;
  private prevHud: Record<string, string> = {};   // dirty-check — don't rewrite scoreboard text nodes every sync
  private tickerEl: HTMLDivElement | null = null;
  private feedRowsEl: HTMLDivElement | null = null;
  // Structured match-feed rows (newest first): minute stamp, actor's team (→ coloured dot), commentary
  // text, and a goal flag (amber-highlighted). Replaces the old plain-text last-5 blob.
  private feedEntries: { minute: number; team: 'home' | 'away' | null; text: string; goal: boolean }[] = [];
  private prevFeedKey = '';   // dirty-check — don't rebuild the feed rows on every sync
  private seenEventKeys: Set<string> = new Set();
  private lastGoalScorer = '';   // most recent goal-event scorer name — fed to the goal banner
  private lastGoalScorerId: number | null = null;   // most recent goal-event scorer id — fed to the celebration (dot flash)
  private commentaryNth = 0;     // advances per rotated commentary line so same-minute events don't repeat phrasing
  // ── live stats + momentum ("PRESSURE" panel) ── per-team tallies accumulated off the SAME
  // de-duped event loop as the feed (so a goal counts once), plus a signed momentum scalar.
  private statPanelEl: HTMLDivElement | null = null;
  private statCells: Record<'ot' | 'xg' | 'big' | 'cor' | 'foul' | 'off', HTMLSpanElement | null> = { ot: null, xg: null, big: null, cor: null, foul: null, off: null };
  private statBarHome: HTMLDivElement | null = null;   // grows right from centre (home leading)
  private statBarAway: HTMLDivElement | null = null;   // grows left from centre (away leading)
  private statBarWrap: HTMLDivElement | null = null;    // pulsed on a goal
  private prevStatStr: Record<string, string> = {};     // dirty-check so textContent isn't rewritten 60fps
  private otH = 0; private otA = 0;       // shots on target
  private xgH = 0; private xgA = 0;       // expected-goals proxy
  private bigH = 0; private bigA = 0;     // big chances (xg >= .30)
  private corH = 0; private corA = 0;     // corners (from set-piece transitions)
  private foulH = 0; private foulA = 0;   // fouls committed
  private offH = 0; private offA = 0;     // offsides called
  // Shot map + xG timeline data (for the 📊 Stats panel). Each shot: pitch xy + its xG + side + goal flag;
  // the series samples cumulative xG per side at each shot's clock. Bounded naturally (~30 shots/match).
  private shots: { x: number; y: number; xg: number; side: number; goal: boolean }[] = [];
  private xgSeries: { t: number; h: number; a: number }[] = [];
  private momentum = 0;                   // signed pressure, [-100 home .. +0 .. neutral], +home
  private displayMomentum = 0;            // eased toward `momentum` for a gliding bar
  private ballXEma = PITCH_W / 2;         // smoothed ball x for the territory term
  private momPrevClock = 0;               // own dt source (the ticker overwrites lastClockMs first)
  private homeAttacksX: number | null = null;   // 0 or PITCH_W — derived from the home keeper's side
  private goalFlashUntil = 0;             // performance.now() deadline for the bar pulse
  private lastSetPieceType: string | null = null;   // corner edge-detection
  private bannerEl: HTMLDivElement | null = null;
  private bannerHideAt = 0;
  // ── goal celebration (canvas FX) ── a time-based sequence painted in renderFrame (non-blocking): a
  // radiating ring burst at the scored-on goal mouth + a slow flash on the scorer's disc + a score-bug
  // pulse. Purely deadline-driven off performance.now(), so a rapid seek/replay just lets it lapse
  // (startGoalCelebration is never called under replayMode, and updateMoments zeroes goalCelebStart on a seek).
  private goalFxGfx: Graphics;
  private goalCelebStart = 0;             // performance.now() the celebration began (0 = idle)
  private goalCelebDur = 2500;            // the FX runs ~2.5s
  private goalCelebScorerId: number | null = null;
  private goalCelebGoalX = 0;             // goal-mouth centre the ring burst radiates from
  private goalCelebGoalY = 0;
  private goalCelebHome = true;           // scoring side → burst colour
  // ── event popups (toast stack) ── a small top-right stack of transient "very temporary" reporting
  // toasts (goal / card / penalty / own-goal / sub). Deadline-pruned in renderFrame (which is paused
  // while the tab is hidden, so nothing piles up; on return the resumed ticker flushes any stale ones
  // in one pass) — no per-toast setTimeout, so long sessions can't leak timers. Capped at 3, newest on top.
  private toastEl: HTMLDivElement | null = null;
  private toasts: { el: HTMLDivElement; deadline: number }[] = [];
  private static readonly TOAST_MS = 4000;
  private static readonly TOAST_MAX = 3;
  private replayMode = false;            // a goal replay is driving sync() — show a REPLAY overlay, suppress the live goal banner
  private atBoardEl: HTMLDivElement | null = null;   // 4th-official "+N" added-time board (pops on announcement)
  private atBoardHideAt = 0;
  private prevAddedMin = 0;
  private panelEl: HTMLDivElement | null = null;
  private panelHideAt = 0;
  private prevHomeScore = 0;
  private prevAwayScore = 0;
  private prevHalf = 1;
  private shownFullTime = false;
  private momentsClock = 0;   // last clock seen by updateMoments — a big jump = a seek (suppress/clear banners)
  private versionText: Text = null!;
  private uiVersion = '';
  private eventGfx: Graphics;
  private jockeyGfx: Graphics;
  private eventLabels: Text[] = [];
  private setPieceGfx: Graphics;
  private setPieceText: Text;
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;
  private trailBuffer: { x: number; y: number; z: number }[] = [];
  private visualPlayers: Map<number, { x: number; y: number }> = new Map();
  private visualBall: { x: number; y: number; z: number } | null = null;
  // ── P0 smooth playback ── recordings keep only ~4fps keyframes, so drawing them raw makes positions
  // jump every ~250ms ("2fps" feel). sync() now INGESTS a frame (events + shapes + stores each entity's
  // prev→target + the segment timing), and a 60fps ticker (renderFrame) TWEENS positions between frames.
  // t = elapsed/segment, LINEAR (the entities move at ~constant velocity between real samples); a big jump
  // (kickoff/seek/out-of-bounds) snaps instead of sliding across the pitch. Pause needs no special-case:
  // no new frame ⇒ t clamps to 1 and motion holds. The choppy per-frame draw is gone.
  private playerTargets: Map<number, { id: number; px: number; py: number; tx: number; ty: number }> = new Map();
  private ballPrev = { x: 0, y: 0, z: 0 };
  private ballTarget = { x: 0, y: 0, z: 0 };
  // ── curve-following ball tween ── the engine samples ball positions per frame, so a bent/curling flight
  // is already curved in the DATA; but tweening prev→target LINEARLY draws the CHORD between two samples,
  // shaving the bow off a strong curl over a long (~250ms) segment. When the ball is in free flight we
  // instead cubic-Hermite the position using the engine's own ball velocity at each endpoint as the
  // tangents, so the interpolated path follows the arc, not the chord. Off (linear) for carried balls,
  // snapped segments and near-stationary balls — a straight pass reduces to a line either way.
  private ballPrevVx = 0; private ballPrevVy = 0;    // ball velocity reported at the segment START (prev frame)
  private ballTargetVx = 0; private ballTargetVy = 0; // ball velocity reported at the segment END (this frame)
  private ballCurveActive = false;                    // use the Hermite path this segment (in-flight, not snapped)
  // Ball velocity heading of the previous ingested frame — a sharp (>45°) swing between consecutive
  // in-flight frames snaps the tween (prev=target) instead of smoothing through the corner, so a
  // first-time pass / deflection reads as a crisp change of direction, not a fake orbiting arc.
  private prevBallDir = 0;
  private prevBallSpeedSq = 0;
  // HUD-occlusion fade: cached scoreboard rect + current faded state, so the ball can never be hidden
  // under the fixed DOM scorebug — when the ball's screen position enters the strip, it dims out of the way.
  private hudRect: DOMRect | null = null;
  private hudFaded = false;
  private segStart = 0;        // performance.now() when the latest frame was ingested
  private segDur = 250;        // measured ms between the last two frames (the tween window)
  private lastIngest = 0;      // performance.now() of the previous ingest (to measure segDur)
  private lastTickMs = 0;      // performance.now() of the previous renderFrame tick (for animTime dt)
  private interpReady = false; // a frame has been ingested → renderFrame may tween/draw
  private syncNeedsImmediateDraw = false; // this sync created shapes (first frame / new player) → paint now, not next tick
  private lastState: EngineState | null = null;   // latest frame — renderFrame reads it for ball/ring/jockey
  private lastControllerId: number | null = null;
  private prevControllerId: number | null = null;
  private animTime = 0;
  private facingAngles: Map<number, number> = new Map();   // F7: the TARGET facing (advanced per keyframe in sync)
  private facingPrev: Map<number, number> = new Map();     // F7: facing at the segment start → tween from here
  private prevFacingAngles: Map<number, number> = new Map();
  // Per-frame id→player index, rebuilt each sync() — replaces O(n) state.players.find() lookups
  // (carrier ring, dribble touches, pass/skill events, ticker) that ran several times a frame.
  private playerById: Map<number, EngineState['players'][number]> = new Map();
  // lifecycle + resize wiring (kept so destroy() can unhook — see the frontend audit)
  private inited = false;
  private destroyed = false;
  private resizeObs: ResizeObserver | null = null;
  private readonly onResize = () => { if (!this.destroyed) this.calcTransform(); };
  private pitchGfx = new Graphics();   // reused across redraws (not re-allocated per resize)
  private weatherGfx = new Graphics();   // a wet-pitch overlay when it's raining (weather reaches the watch but never the pitch)
  private weatherShown = '';             // last weather drawn into weatherGfx (dirty-check)
  // Bottom strip (px) kept clear for the live tactics panel that floats over the canvas.
  // screenWatch drives this from the panel's real height so the pitch never sits under it
  // and grows back when the panel is short or hidden (e.g. a replay drops the shout box).
  private reservedBottom = 180;
  // A right-side strip for the live tactics panel (wide screens dock it right so the pitch keeps
  // full HEIGHT instead of being squeezed by a bottom bar). 0 = no right dock (panel bottom/hidden).
  private reservedRight = 0;
  // Top strip kept clear for the DOM scoreboard + the control bar. screenWatch refines this from
  // the bar's real bottom edge (it wraps on narrow screens); 110 ≈ scoreboard + one bar row.
  private reservedTop = 110;
  private directiveMap: Map<number, string> = new Map();   // engine playerId → short active-directive label
  private showDirectives = false;

  constructor() {
    this.app = new Application();
    this.pitchContainer = new Container();
    this.playerLayer = new Container();
    this.ringGfx = new Graphics();
    this.ballBody = new Graphics();
    this.ballGlow = new Graphics();
    this.ballHighlight = new Graphics();
    this.eventGfx = new Graphics();
    this.goalFxGfx = new Graphics();
    this.jockeyGfx = new Graphics();
    this.setPieceGfx = new Graphics();
    this.setPieceText = new Text({ text: '', style: new TextStyle({ fill: 0xffffff, fontSize: 15, fontFamily: 'monospace', fontWeight: 'bold' }) });

    // pre-draw football (white with black pentagon pattern)
    const r = BALL_R;
    this.ballBody.circle(0, 0, r);
    this.ballBody.fill({ color: 0xffffff, alpha: 0.95 });
    this.ballBody.circle(0, 0, r);
    this.ballBody.stroke({ width: 1, color: 0x333333 });
    // pentagon pattern — 5 small dark dots
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
      this.ballBody.circle(Math.cos(a) * r * 0.5, Math.sin(a) * r * 0.5, r * 0.22);
      this.ballBody.fill({ color: 0x222222 });
    }
    // center dot
    this.ballBody.circle(0, 0, r * 0.18);
    this.ballBody.fill({ color: 0x222222 });

    this.ballGlow.circle(0, 0, r + 2);
    this.ballGlow.stroke({ width: 1, color: 0xffffff, alpha: 0.3 });

    // pre-create trail pool — each dot is drawn ONCE as a white unit circle; per sync only position/
    // scale/alpha/tint change (a clear()+circle()+fill() per visible dot re-tessellated ~500-600
    // Graphics/sec during ball flight — pure waste, the geometry is a function of the pool index).
    for (let i = 0; i < TRAIL_LENGTH; i++) {
      const t = new Graphics();
      t.circle(0, 0, 1);
      t.fill({ color: 0xffffff });
      t.visible = false;
      this.pitchContainer.addChild(t);
      this.trailPool.push(t);
    }

    for (let i = 0; i < 20; i++) {   // pool ≥ the busiest frame's event count, else callouts silently drop
      const label = new Text({ text: '', style: new TextStyle({ fill: 0xffffff, fontSize: 13, fontFamily: 'monospace', fontWeight: 'bold' }) });
      label.anchor.set(0.5, 0.5);
      label.visible = false;
      this.eventLabels.push(label);
    }

    // shot trail
    this.shotTrailGfx = new Graphics();
    this.pitchContainer.addChild(this.shotTrailGfx);
  }

  async init(): Promise<void> {
    if (this.inited) return;                 // one init per renderer
    this.inited = true;
    await this.app.init({
      resizeTo: window, backgroundColor: 0x1a1a2e,
      // Cap the backing-store multiplier (cappedResolution, see util.ts): high-DPR phones (2.5–3×) would
      // otherwise allocate a huge full-window canvas — the heaviest GPU/memory load on exactly the devices
      // least able to sustain a live match. 2× is visually indistinguishable. autoDensity stays on.
      antialias: true, resolution: cappedResolution(window.devicePixelRatio), autoDensity: true,
    });
    if (this.destroyed) { try { this.app.destroy(true, { children: true, texture: true }); } catch { /* */ } return; }   // destroy() raced init — bail before touching the stage

    document.getElementById('app')!.appendChild(this.app.canvas);
    this.app.stage.addChild(this.pitchContainer);
    this.pitchContainer.addChild(this.playerLayer);
    this.pitchContainer.addChild(this.jockeyGfx);   // jockey/shield arcs sit just above the players
    this.pitchContainer.addChild(this.ringGfx);
    this.pitchContainer.addChild(this.ballBody);
    this.pitchContainer.addChild(this.ballGlow);
    this.pitchContainer.addChild(this.ballHighlight);
    this.pitchContainer.addChild(this.eventGfx);
    for (const label of this.eventLabels) this.pitchContainer.addChild(label);
    this.pitchContainer.addChild(this.setPieceGfx);
    this.pitchContainer.addChild(this.setPieceText);
    this.app.stage.sortableChildren = true;
    // scoreboard — full-width DOM strip along the top (teams + score + BIG clock + shots/poss);
    // styled from styles.css (.watch-hud). Replaces the old in-canvas hudText/hudBg.
    this.buildHud();
    // commentary ticker (DOM — crisp text, fixed bottom-left; styled from styles.css like the other panels)
    this.tickerEl = document.createElement('div');
    this.tickerEl.className = 'watch-feed';
    const feedHead = document.createElement('div'); feedHead.className = 'wf-head'; feedHead.textContent = 'Match Feed';
    const feedRows = document.createElement('div'); feedRows.className = 'wf-rows';
    feedRows.innerHTML = '<div class="wf-empty">— kick-off awaited —</div>';
    this.tickerEl.appendChild(feedHead); this.tickerEl.appendChild(feedRows);
    document.body.appendChild(this.tickerEl);
    this.feedRowsEl = feedRows;
    // ── PRESSURE panel ── built detached; screenWatch docks it into the right column via dockStats()
    // (it used to float top-left over the scoreboard + timeline).
    this.buildStatPanel();
    // goal banner (center) and half/full-time stats panel
    this.bannerEl = document.createElement('div');
    Object.assign(this.bannerEl.style, {
      position: 'fixed', top: '18%', left: '50%', transform: 'translateX(-50%) scale(1)',
      zIndex: '30', fontFamily: 'monospace', fontWeight: 'bold', fontSize: '34px',
      color: '#ffe97a', background: 'rgba(8,12,20,0.85)', padding: '14px 34px',
      borderRadius: '10px', border: '2px solid #ffe97a', pointerEvents: 'none',
      display: 'none', textAlign: 'center', letterSpacing: '2px',
    } as Partial<CSSStyleDeclaration>);
    document.body.appendChild(this.bannerEl);
    // a one-time celebratory "pop" keyframe for the GOAL banner (goals are the watch highlight) — injected
    // once, re-triggered per goal by resetting the animation. CSS-only, no per-frame cost.
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
    // ── event-popup toast stack ── renderer-owned (like the HUD/feed/banner), fixed top-right of the pitch.
    // setReservedTop/Right keep it clear of the scoreboard/control bar and the docked tactics panel.
    this.toastEl = document.createElement('div');
    this.toastEl.className = 'watch-toasts';
    document.body.appendChild(this.toastEl);
    this.positionToasts();
    this.panelEl = document.createElement('div');
    Object.assign(this.panelEl.style, {
      position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
      zIndex: '29', fontFamily: 'monospace', fontSize: '15px', lineHeight: '1.8',
      color: '#e8edf2', background: 'rgba(8,12,20,0.92)', padding: '20px 34px',
      borderRadius: '10px', border: '1px solid #3a4a5f', pointerEvents: 'none',
      display: 'none', whiteSpace: 'pre', textAlign: 'center',
    } as Partial<CSSStyleDeclaration>);
    document.body.appendChild(this.panelEl);
    // ── added-time board ── a 4th-official "+N" board that pops when the stoppage minutes are
    // announced at a half-end (mirrors the replay-viewer board). The persistent HUD "+N" (wh-added)
    // remains the ongoing ADDED-TIME indicator while the clock runs past 45'/90'. Dormant until the
    // engine sets state.addedTime — coded defensively so a frame without it still type-checks.
    this.atBoardEl = document.createElement('div');
    Object.assign(this.atBoardEl.style, {
      position: 'fixed', top: '46%', left: '50%', transform: 'translate(-50%,-50%)',
      zIndex: '31', fontFamily: 'monospace', fontWeight: 'bold', color: '#ffe97a',
      background: 'rgba(8,12,20,0.9)', padding: '14px 30px', borderRadius: '10px',
      border: '2px solid #ffcf5c', pointerEvents: 'none', display: 'none', textAlign: 'center',
    } as Partial<CSSStyleDeclaration>);
    document.body.appendChild(this.atBoardEl);
    // version display — engine + UI
    const versionText = new Text({ text: '...', style: new TextStyle({ fill: 0xffffff, fontSize: 8, fontFamily: 'monospace' }) });
    versionText.position.set(this.app.screen.width - 6, this.app.screen.height - 12);
    versionText.anchor.set(1, 1);
    versionText.zIndex = 1000;
    this.app.stage.addChild(versionText);
    this.versionText = versionText;
    // UI version is static
    this.uiVersion = 'ui:2';

    this.drawPitch();
    this.calcTransform();
    // P0: drive 60fps position tweening between the ~4fps keyframes. Pixi's shared ticker already
    // renders the stage each rAF; renderFrame advances the interpolation so positions glide.
    this.app.ticker.add(this.renderFrame);
    // Recalculate the pitch transform whenever the canvas actually changes
    // size. Window 'resize' alone misses canvas-size changes (and Pixi v8's
    // renderer emits no resize event), leaving the pitch at a stale scale.
    this.resizeObs = new ResizeObserver(this.onResize);
    this.resizeObs.observe(this.app.canvas);
    window.addEventListener('resize', this.onResize);
    // Dev convenience: expose the app for console/screenshot tooling.
    (window as unknown as { __app: Application }).__app = this.app;
  }

  // Tear down for SPA navigation: unhook the resize observer/listener, remove the
  // body-level overlays, and destroy the Pixi app (detaching the canvas). Idempotent —
  // screenWatch may bail-destroy a renderer that route() already tore down.
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    try { this.app.ticker?.remove(this.renderFrame); } catch { /* */ }   // stop the tween loop before tearing down
    try { this.resizeObs?.disconnect(); } catch { /* */ } this.resizeObs = null;
    try { window.removeEventListener('resize', this.onResize); } catch { /* */ }
    try { delete (window as unknown as { __app?: Application }).__app; } catch { /* */ }
    try { this.hudEl?.remove(); } catch { /* */ }
    try { this.tickerEl?.remove(); } catch { /* */ }
    try { this.statPanelEl?.remove(); } catch { /* */ }   // may be docked inside the tactics panel — remove() is safe either way
    try { this.bannerEl?.remove(); } catch { /* */ }
    try { this.panelEl?.remove(); } catch { /* */ }
    // toasts hold no timers (deadline-pruned in renderFrame), so tearing down is just detaching the nodes
    try { this.toastEl?.remove(); } catch { /* */ } this.toasts = [];
    // Free the WebGL context. Browsers cap live contexts (~16) and Pixi's destroy() leaves it for the
    // GC, so opening/closing many watches in one SPA session leaks contexts — eventually a later
    // renderer.init() silently fails and the watch shows a blank pitch (until a reload). A LIVE match
    // is itself a long session, so this hardens the headline feature. Capture the context, let Pixi
    // clean up its GPU resources, then explicitly lose it so watch sessions stay bounded.
    const gl = (this.app.renderer as unknown as { gl?: WebGL2RenderingContext }).gl;
    try { this.app.destroy(true, { children: true, texture: true }); } catch { /* */ }
    try { gl?.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* not WebGL / already gone */ }
  }

  // Resize the reserved bottom strip (the live tactics panel floats over the canvas, so
  // the pitch must stay above it). Recomputes the transform immediately; no-op if unchanged
  // or before the renderer is ready / after it's torn down.
  setReservedBottom(px: number): void {
    const v = Math.max(0, Math.round(px));
    // Float the commentary feed just above the reserved bottom strip (the live-tactics panel)
    // so it sits over the pitch as a broadcast lower-third instead of hiding behind the panel.
    if (this.tickerEl) this.tickerEl.style.bottom = `${v + 14}px`;
    if (v === this.reservedBottom) return;
    this.reservedBottom = v;
    if (!this.destroyed && this.app.renderer) this.calcTransform();
  }

  // Resize the reserved right-side strip (the live tactics panel docked right on wide screens). The
  // pitch then centres in the remaining left region and keeps full height. 0 frees it.
  setReservedRight(px: number): void {
    const v = Math.max(0, Math.round(px));
    if (v === this.reservedRight) return;
    this.reservedRight = v;
    this.positionToasts();   // keep the toast stack left of the docked tactics panel
    if (!this.destroyed && this.app.renderer) this.calcTransform();
  }

  // Resize the reserved top strip (scoreboard + control bar). screenWatch drives this from the
  // bar's measured bottom edge so a wrapped bar (narrow viewport) never overlaps the pitch.
  setReservedTop(px: number): void {
    const v = Math.max(0, Math.round(px));
    if (v === this.reservedTop) return;
    this.reservedTop = v;
    this.positionToasts();   // keep the toast stack below the scoreboard + control bar
    if (!this.destroyed && this.app.renderer) this.calcTransform();
  }

  // Anchor the toast stack top-right of the pitch view: below the scoreboard/control bar (reservedTop)
  // and left of the docked tactics panel (reservedRight). Called on init + whenever a reserve changes.
  private positionToasts(): void {
    if (!this.toastEl) return;
    this.toastEl.style.top = `${this.reservedTop + 6}px`;
    this.toastEl.style.right = `${this.reservedRight + 12}px`;
  }

  // Push a transient reporting toast (newest on top, capped, deadline-pruned in renderFrame). Suppressed
  // while a replay/rewind drives the renderer so a rewound goal/card doesn't re-pop. No timers held.
  private pushToast(icon: string, text: string, kind: 'goal' | 'card' | 'pen' | 'sub' | 'og' | 'foul' | 'adv' | 'offside' | 'inj'): void {
    if (!this.toastEl || this.replayMode) return;
    const el = document.createElement('div');
    el.className = `watch-toast wt-${kind}`;
    el.style.animation = 'footyToastIn .22s ease-out';
    const ic = document.createElement('span'); ic.className = 'wt-ic'; ic.textContent = icon;
    const tx = document.createElement('span'); tx.className = 'wt-tx'; tx.textContent = text;
    el.appendChild(ic); el.appendChild(tx);
    this.toastEl.prepend(el);   // newest on top
    this.toasts.unshift({ el, deadline: performance.now() + MatchRenderer.TOAST_MS });
    while (this.toasts.length > MatchRenderer.TOAST_MAX) {
      const old = this.toasts.pop();   // drop the oldest (bottom of the stack)
      if (old) old.el.remove();
    }
    (window as unknown as { __toasts?: number }).__toasts = this.toasts.length;   // verify hook
  }

  // Remove toasts whose deadline has passed. Runs from renderFrame (paused while the tab is hidden),
  // so on a background→foreground return every stale toast is flushed in one pass instead of lingering.
  private pruneToasts(now: number): void {
    if (!this.toasts.length) return;
    for (let i = this.toasts.length - 1; i >= 0; i--) {
      if (now >= this.toasts[i].deadline) { this.toasts[i].el.remove(); this.toasts.splice(i, 1); }
    }
  }

  // Clear the whole stack (match restart / rewind detected in updateTicker).
  private clearToasts(): void {
    for (const t of this.toasts) t.el.remove();
    this.toasts = [];
  }

  // The DOM scoreboard strip — screenWatch measures it (together with its own control bar) to
  // reserve the top of the canvas. Null until init().
  get hudElement(): HTMLElement | null { return this.hudEl; }

  // Dock the live-stats block (ON-TGT/xG/BIG-CH/CORNERS + PRESSURE) into a host container —
  // screenWatch puts it at the top of the right column instead of floating it over the timeline.
  dockStats(host: HTMLElement): void {
    if (this.statPanelEl && !this.destroyed) host.appendChild(this.statPanelEl);
  }

  // Enter/leave goal-replay mode. While on, a persistent "⚽ GOAL REPLAY" overlay marks the rewound
  // clip as a replay (so the score winding back to 0-0 doesn't read as the LIVE match resetting), and
  // the live goal banner is suppressed (updateMoments) so the rewind/replay doesn't mis-fire "GOAL!".
  // directive overlay (the user's "type it → see it work"): a map of engine playerId → short directive label,
  // and a toggle. The per-player tags update on the next sync().
  setDirectives(m: Map<number, string>): void { this.directiveMap = m; }
  setShowDirectives(on: boolean): void { this.showDirectives = on; }

  setReplay(on: boolean): void {
    this.replayMode = on;
    if (!this.bannerEl) return;
    if (on) {
      this.bannerEl.textContent = '⚽  GOAL REPLAY';
      this.bannerEl.style.whiteSpace = 'nowrap';
      this.bannerEl.style.color = '#ffe97a';
      this.bannerEl.style.borderColor = '#ffe97a';
      this.bannerEl.style.display = 'block';
      this.bannerHideAt = Number.MAX_SAFE_INTEGER;   // stays up for the whole clip
    } else {
      this.bannerEl.style.display = 'none';
      this.bannerHideAt = 0;
    }
  }

  private calcTransform(): void {
    if (this.destroyed) return;
    // Reserve a strip on the right (the docked tactics panel) so the pitch uses the left region at
    // FULL height; the bottom strip stays small (just ticker clearance) when the panel is docked right.
    const sw = this.app.screen.width - this.reservedRight;
    const reserveTop = this.reservedTop;   // scoreboard + control bar own the top of the screen
    const reserveBottom = this.reservedBottom;
    const sh = this.app.screen.height - reserveTop - reserveBottom;
    // clamp to a small positive min: on a very short viewport (tall panel) sh can go <=0, which would
    // flip/vanish the pitch — keep it drawable.
    this.scale = Math.max(0.05, Math.min(sw / (PITCH_W + GOAL_DEPTH * 2), sh / (PITCH_H + 40)) * 0.92);
    this.offsetX = (sw - PITCH_W * this.scale) / 2;
    this.offsetY = reserveTop + (sh - PITCH_H * this.scale) / 2;
    this.pitchContainer.scale.set(this.scale);
    this.pitchContainer.position.set(this.offsetX, this.offsetY);
    // Cache the scoreboard's screen rect for the per-frame ball-occlusion fade (recomputed here so it
    // tracks the CSS media-query height changes that fire on resize). Read once per layout, not per frame.
    this.hudRect = this.hudEl ? this.hudEl.getBoundingClientRect() : null;
    // NB: do NOT call drawPitch() here. The pitch geometry is drawn in pitch-space and scaled/positioned by
    // pitchContainer (set above), so a transform recompute needs no redraw. drawPitch() ALSO tears down every
    // live entity (players/ball/trails, interpReady, lastState) — and calcTransform is driven by a
    // ResizeObserver, so calling it here blanked the pitch on any mid-match panel/bar resize (applying a shout
    // that grew the receipt, the replay UI appearing, a window resize) and left it blank while paused (renderFrame
    // early-returns on !lastState). Geometry + entities are built once in the constructor's drawPitch().
  }

  // Build the DOM scoreboard: [teams + score] · [BIG clock, centred — the visual anchor] · [shots/poss]
  // with a thin possession split strip along the bottom edge. Values update per sync (dirty-checked).
  private buildHud(): void {
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
    this.hudEl = el;
    this.hudRefs = { home, score, away, half, time, added, shots, poss, state, possHome: ph };
  }

  private drawPitch(): void {
    this.pitchContainer.removeChildren();
    this.pitchContainer.addChild(this.weatherGfx);   // wet-pitch overlay: above the pitch g (index 0), below everything else
    // restore the ball-motion trail + shot trail (created in the constructor) — removeChildren() above
    // orphaned them and they were NOT re-added, so the trails silently never rendered (the eval-hooks
    // only test the trail BUFFER, and the WebGL canvas can't be screenshotted, so it went unnoticed).
    // Added first → they sit just above the pitch, below the players/ball, matching the original z-order.
    for (const t of this.trailPool) this.pitchContainer.addChild(t);
    this.pitchContainer.addChild(this.shotTrailGfx);
    this.pitchContainer.addChild(this.playerLayer);
    this.pitchContainer.addChild(this.jockeyGfx);
    this.pitchContainer.addChild(this.ringGfx);
    this.pitchContainer.addChild(this.ballGlow);   // the ball's ground shadow sits below the effect layers
    this.pitchContainer.addChild(this.eventGfx);
    for (const label of this.eventLabels) this.pitchContainer.addChild(label);
    this.pitchContainer.addChild(this.setPieceGfx);
    this.pitchContainer.addChild(this.setPieceText);
    // goal celebration FX (ring burst + scorer flash) ride above events/set-piece but still below the ball
    this.pitchContainer.addChild(this.goalFxGfx);
    // BALL ALWAYS ON TOP — added LAST so no player, event effect, set-piece marker or overlay sprite can
    // ever occlude it (owner bug: the ball vanished under other chrome). The HUD DOM strip is faded
    // separately in renderFrame when the ball's screen position would slide under it. The elevation halo
    // rides just below the sprite so it reads as a rim of light around the lofted ball, never over it.
    this.pitchContainer.addChild(this.ballHighlight);
    this.pitchContainer.addChild(this.ballBody);

    const g = this.pitchGfx;   // reused (clear + redraw) so a resize/recalc doesn't leak a Graphics each time
    g.clear();
    g.rect(-GOAL_DEPTH, 0, PITCH_W + GOAL_DEPTH * 2, PITCH_H); g.fill(PITCH_GREEN);
    // mowing stripes — alternating subtle light/dark bands (a real mown-pitch look; the old single
    // white-at-0.05 overlay was nearly invisible). Conservative alphas so it reads as texture, not garish.
    const stripeCount = 14;
    const stripeW = PITCH_W / stripeCount;
    for (let i = 0; i < stripeCount; i++) {
      g.rect(i * stripeW, 0, stripeW, PITCH_H);
      g.fill(i % 2 === 0 ? { color: 0xffffff, alpha: 0.055 } : { color: 0x000000, alpha: 0.05 });
    }
    g.rect(0, 0, PITCH_W, PITCH_H); g.stroke({ width: 3, color: LINE_COLOR });
    g.moveTo(PITCH_W / 2, 0); g.lineTo(PITCH_W / 2, PITCH_H); g.stroke({ width: 2, color: LINE_COLOR });
    g.circle(PITCH_W / 2, PITCH_H / 2, CENTER_CIRCLE_R); g.stroke({ width: 2, color: LINE_COLOR });
    g.circle(PITCH_W / 2, PITCH_H / 2, 3); g.fill(LINE_COLOR);
    this.drawGoal(g, 0, PITCH_H / 2, 1);
    this.drawGoal(g, PITCH_W, PITCH_H / 2, -1);
    this.drawPenaltyArea(g, 0); this.drawPenaltyArea(g, PITCH_W);
    this.drawGoalArea(g, 0); this.drawGoalArea(g, PITCH_W);
    this.drawPenaltyDetail(g, 0); this.drawPenaltyDetail(g, PITCH_W);   // penalty spots + the "D" arcs
    this.drawMarkingArc(g, 0, 0, CORNER_ARC_R, 0, Math.PI / 2);
    this.drawMarkingArc(g, PITCH_W, 0, CORNER_ARC_R, Math.PI / 2, Math.PI);
    this.drawMarkingArc(g, 0, PITCH_H, CORNER_ARC_R, -Math.PI / 2, 0);
    this.drawMarkingArc(g, PITCH_W, PITCH_H, CORNER_ARC_R, Math.PI, -Math.PI / 2);
    this.pitchContainer.addChildAt(g, 0);
    for (const child of this.playerLayer.removeChildren()) child.destroy();
    this.playerEntries.clear();
    this.visualPlayers.clear();
    this.visualBall = null;
    this.playerTargets.clear();   // P0: drop stale tween targets so a fresh watch snaps to the first frame
    this.facingPrev.clear(); this.facingAngles.clear();   // F7: re-snap facing with positions after a reset
    this.interpReady = false;
    this.lastState = null;
    this.lastIngest = 0;
    this.lastControllerId = null;
    this.prevControllerId = null;
    this.trailBuffer = [];
  }

  // ── P0: 60fps position tween between the ~4fps keyframes ── runs every rAF (Pixi's shared ticker).
  // sync() ingested the frame (events/shapes + each entity's prev→target + the segment window); here we
  // LERP positions by t = elapsed/segment and draw the POSITIONAL layer (players, ball, carrier ring,
  // jockey arcs) so motion glides instead of jumping. Linear = constant velocity between real samples (a
  // teleport already snapped to prev=target in sync). No new frame ⇒ t holds at 1 ⇒ motion freezes — which
  // is exactly right for pause and for waiting on a seek's frames.
  private renderFrame = (): void => {
    if (this.destroyed || !this.inited || !this.interpReady || !this.lastState) return;
    const now = performance.now();
    // animTime drives the ring-pulse / dribble-stride / skill-spin sines. Advance it by dt/segDur so it
    // gains ~1 unit PER FRAME-SEGMENT — i.e. the SAME rate as the old once-per-sync increment (preserving
    // every tuned multiplier), but smoothly across the rAF ticks instead of stepping 4×/sec. (A naive
    // per-tick ++ ran the animations ~15× too fast — caught in adversarial review.) dt clamped for stalls.
    const dtMs = this.lastTickMs ? Math.min(now - this.lastTickMs, 100) : 16;
    this.lastTickMs = now;
    this.animTime += dtMs / this.segDur;
    const t = this.segDur > 0 ? clamp((now - this.segStart) / this.segDur, 0, 1) : 1;
    const state = this.lastState;
    const b = state.ball;
    const byId = this.playerById;

    // ball — tween its position FIRST (renderFrame owns visualBall) so the player loop aims boots at the
    // CURRENT-tick ball (F7 review: it was reading the previous tick's visualBall → a ~16ms boot-aim lag).
    // Curve-following: in free flight, cubic-Hermite through the engine's ball velocity at each endpoint
    // so a curling flight follows its arc instead of the straight chord between the two samples; a straight
    // pass, a carried ball or a snapped segment falls back to a plain linear lerp (see ballCurveActive).
    let ibx: number, iby: number;
    if (this.ballCurveActive) {
      const dtSec = this.segDur / 1000;
      const p0x = this.ballPrev.x, p0y = this.ballPrev.y, p1x = this.ballTarget.x, p1y = this.ballTarget.y;
      // tangents = velocity·dt, but capped to ~1.25× the chord so a decelerating (friction) or fast-sampled
      // ball can't overshoot p1 and wobble back — the DIRECTION of each tangent (which carries the curl) is
      // what matters, not its raw length.
      const chord = Math.hypot(p1x - p0x, p1y - p0y) || 1;
      const cap = chord * 1.25;
      const capTan = (vx: number, vy: number): [number, number] => {
        let mx = vx * dtSec, my = vy * dtSec; const mag = Math.hypot(mx, my);
        if (mag > cap) { const k = cap / mag; mx *= k; my *= k; } return [mx, my];
      };
      const [m0x, m0y] = capTan(this.ballPrevVx, this.ballPrevVy);
      const [m1x, m1y] = capTan(this.ballTargetVx, this.ballTargetVy);
      const t2 = t * t, t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
      ibx = h00 * p0x + h10 * m0x + h01 * p1x + h11 * m1x;
      iby = h00 * p0y + h10 * m0y + h01 * p1y + h11 * m1y;
    } else {
      ibx = lerp(this.ballPrev.x, this.ballTarget.x, t);
      iby = lerp(this.ballPrev.y, this.ballTarget.y, t);
    }
    const ibz = lerp(this.ballPrev.z, this.ballTarget.z, t);
    if (!this.visualBall) this.visualBall = { x: ibx, y: iby, z: ibz };
    else { this.visualBall.x = ibx; this.visualBall.y = iby; this.visualBall.z = ibz; }

    // players — tween then position body/shadow/arrow/label/dirTag (shapes were drawn in sync).
    // Iterate .values() (id lives on the record) so the Map iterator doesn't allocate a [k,v] tuple per rAF.
    for (const tg of this.playerTargets.values()) {
      const id = tg.id;
      const entry = this.playerEntries.get(id);
      if (!entry) continue;
      const ix = lerp(tg.px, tg.tx, t);
      const iy = lerp(tg.py, tg.ty, t);
      let v = this.visualPlayers.get(id);
      // Round-27 COMMIT 8b: a light EMA pass over the interpolated position (like
      // the renderFacing damping) so residual telemetry wobble reads as a smooth
      // curve, not per-keyframe kinks. A big step (teleport/seek/restart) snaps
      // through instead of gliding, mirroring the ball's jump handling.
      if (!v) { v = { x: ix, y: iy }; this.visualPlayers.set(id, v); }
      else if (Math.abs(ix - v.x) > 40 || Math.abs(iy - v.y) > 40) { v.x = ix; v.y = iy; }
      else { v.x += (ix - v.x) * 0.4; v.y += (iy - v.y) * 0.4; }
      const sx = v.x, sy = v.y;
      entry.shadow.position.set(sx, sy);
      entry.body.position.set(sx, sy);
      entry.arrow.position.set(sx, sy);
      // F7: redraw the boot/head arrow at the LERPED facing every tick (was keyframe-rate → boots lagged turns).
      const pp = byId.get(id);
      if (pp) this.drawPlayerArrow(entry, pp, this.lerpedFacing(id, t, pp.team), sx, sy, ibx, iby);
      entry.label.position.set(sx, sy + DISC_R + 3);
      if (entry.dirTag.visible) entry.dirTag.position.set(sx, sy + DISC_R + 16);
    }

    // ── carrier ring (rides the carrier's tweened pos + pulses on animTime) ──
    this.ringGfx.clear();
    let bylineRun = false;
    // COMMIT 8a: on a possession change, start a 150ms cross-fade — the old
    // controller's ring fades out while the new one's fades in.
    if (b.controllerId !== this.ringCurController) {
      this.ringFadeFrom = this.ringCurController;
      this.ringChangeAtMs = now;
      this.ringCurController = b.controllerId;
    }
    const ringFade = clamp((now - this.ringChangeAtMs) / 150, 0, 1);
    const pulseNow = 0.25 + 0.35 * Math.sin(this.animTime * 0.08);
    if (ringFade < 1 && this.ringFadeFrom !== null && this.ringFadeFrom !== b.controllerId) {
      const old = byId.get(this.ringFadeFrom);
      if (old) {
        const vo = this.visualPlayers.get(old.id) ?? { x: old.x, y: old.y };
        const oc = old.team === 'home' ? HOME_COLOR : AWAY_COLOR;
        const oa = (old.dribbleType === 3 ? Math.min(0.85, pulseNow + 0.25) : pulseNow) * (1 - ringFade);
        this.ringGfx.circle(vo.x, vo.y, DISC_R + (old.dribbleType === 3 ? 9 : 6));
        this.ringGfx.stroke({ width: old.dribbleType === 3 ? 4 : 3, color: oc, alpha: oa });
      }
    }
    if (b.controllerId !== null) {
      const ctrl = byId.get(b.controllerId);
      if (ctrl) {
        const vc = this.visualPlayers.get(ctrl.id) ?? { x: ctrl.x, y: ctrl.y };
        const pulse = pulseNow;
        const rc = ctrl.team === 'home' ? HOME_COLOR : AWAY_COLOR;
        this.ringGfx.circle(vc.x, vc.y, DISC_R + (ctrl.dribbleType === 3 ? 9 : 6));
        this.ringGfx.stroke({ width: ctrl.dribbleType === 3 ? 4 : 3, color: rc, alpha: (ctrl.dribbleType === 3 ? Math.min(0.85, pulse + 0.25) : pulse) * ringFade });
        // ── GK ball-held cue ── a keeper holding the ball for distribution (he's the controller, the ball
        // is dead at his feet: not thrown/rolled/kicked yet) gets a distinct glove-clasp marker so the hold
        // reads clearly (owner ask: a GK-holding animation). Two glove pads cup the ball + a bright pulsing
        // ring in the keeper's colour — visually separate from the ordinary carrier ring above.
        if (ctrl.role === 'GK' && Math.hypot(b.vx, b.vy) < 8 && (b.z ?? 0) < 6) {
          const gp = 0.5 + 0.5 * Math.sin(this.animTime * 0.11);   // slow clasp pulse
          this.ringGfx.circle(vc.x, vc.y, DISC_R + 11 + gp * 2);
          this.ringGfx.stroke({ width: 2.5, color: 0xffe27a, alpha: 0.55 + gp * 0.35 });
          // glove pads cupping the held ball — flanking it PERPENDICULAR to the keeper's facing and nudged
          // slightly FORWARD along it, so the two pads form a cup around the front of the ball he's looking
          // at. Uses the same LERPED facing as his body/boots/chevron (not the raw target) → the clasp never
          // leads or lags the turn and never sits on a world axis while he tracks the ball.
          const ga = this.lerpedFacing(ctrl.id, t, ctrl.team);
          const px = -Math.sin(ga), py = Math.cos(ga);            // perpendicular to facing (side-to-side)
          const fx = Math.cos(ga), fy = Math.sin(ga);             // along facing (forward)
          const bx = this.visualBall?.x ?? vc.x, by = this.visualBall?.y ?? vc.y;
          for (const s of [1, -1]) {
            const gx = bx + px * s * (BALL_R + 2.6) + fx * (BALL_R * 0.5);
            const gy = by + py * s * (BALL_R + 2.6) + fy * (BALL_R * 0.5);
            this.ringGfx.circle(gx, gy, 2.9);
            this.ringGfx.fill({ color: 0xffe27a, alpha: 0.9 });
            this.ringGfx.circle(gx, gy, 2.9);
            this.ringGfx.stroke({ width: 1, color: 0x33261c, alpha: 0.85 });
          }
          (window as unknown as { __gkHold?: unknown }).__gkHold = { id: ctrl.id, atMs: this.lastState?.clockMs };   // verify hook
        }
        // byline-run cue: a WIDE carrier driving onto the ATTACKING byline gets a lime glow (the box-finish
        // build-up reads from the approach). Geometric (attacking goal-line + a wide channel).
        if (this.homeAttacksX !== null) {
          const attackX = ctrl.team === 'home' ? this.homeAttacksX : (this.homeAttacksX === 0 ? PITCH_W : 0);
          // use the TWEENED carrier pos (vc) so the lime byline glow stays glued to the ring, not the
          // ~4fps-stale raw ctrl.x/ctrl.y (caught in adversarial review).
          if (Math.abs(vc.x - attackX) < 60 && (vc.y < PITCH_H * 0.22 || vc.y > PITCH_H * 0.78)) {
            bylineRun = true;
            this.ringGfx.circle(vc.x, vc.y, PLAYER_R + 14);
            this.ringGfx.stroke({ width: 3, color: 0x66ff99, alpha: Math.min(0.8, pulse + 0.4) });
          }
        }
      }
    }
    const __bw = window as unknown as { __bylineActive?: boolean; __bylineSeen?: boolean };
    __bw.__bylineActive = bylineRun;
    if (bylineRun) __bw.__bylineSeen = true;

    // ── ball draw (interpolated pos + Z lift + dribble stride) ──
    // 3D height read: the sprite lifts off its ground shadow (arcOffset), GROWS as it climbs (nearer the
    // camera), and the shadow it casts on the turf spreads WIDER + fades SOFTER the higher it goes. The
    // gap between the lifted sprite and the pinned shadow is the cue that sells "up in the air".
    // Two fixes so height reads WITHOUT the ball detaching from its carrier:
    //  • when a player CONTROLS the ball it's at their feet, so collapse the lift
    //    /size — a collected ball sits ON the player, never floating above him;
    //  • ease the sprite down onto its shadow through the last units of the drop
    //    (smoothstep on z) so a landing settles instead of snapping to the deck.
    const controlled = b.controllerId !== null;
    const settle = ((u) => u * u * (3 - 2 * u))(clamp(ibz / 8, 0, 1));
    const damp = controlled ? 0.12 : 1;
    const arcOffset = ibz * 0.6 * settle * damp;   // NOTE: the motion/shot trails mirror this 0.6 base lift — keep them in step.
    // Map height 0→1 over the realistic lofted range (~50u apex for crosses/corners/goal-kicks); balls
    // above that clamp, so the effect saturates gracefully instead of ballooning on a freak clearance.
    // Damped/eased alongside the lift so a carried or just-landed ball doesn't stay grown or cast a wide shadow.
    const heightRatio = clamp(ibz / 50, 0, 1) * settle * damp;
    let touchX = 0, touchY = 0;
    if (b.controllerId !== null && ibz < 2) {
      const ctrl = byId.get(b.controllerId);
      const cspd = ctrl ? Math.hypot(ctrl.vx, ctrl.vy) : 0;
      if (ctrl && cspd > 12) {
        const ma = Math.atan2(ctrl.vy, ctrl.vx);
        const stride = Math.sin(this.animTime * (0.30 + Math.min(cspd, 70) * 0.004) + ctrl.id);
        const push = Math.max(0, stride) * 3.0;
        const sway = stride * 2.0;
        touchX = Math.cos(ma) * push - Math.sin(ma) * sway;
        touchY = Math.sin(ma) * push + Math.cos(ma) * sway;
      }
    }
    const bx = ibx + touchX, by = iby + touchY - arcOffset;
    this.ballBody.position.set(bx, by);
    this.ballBody.scale.set(1 + heightRatio * 0.55);   // grows up to ~1.55× at apex — nearer the camera

    // ground shadow (ballGlow) — pinned at the ball's x,y on the turf while the sprite floats above it.
    // It widens and softens with height (a diffuse pool for a high ball, a tight dark disc for a low one).
    this.ballGlow.position.set(ibx, iby);
    this.ballGlow.clear();
    if (ibz > 5) {
      const shadowAlpha = clamp(0.34 - heightRatio * 0.20, 0.1, 0.34);
      this.ballGlow.ellipse(0, 0, BALL_R * (1 + heightRatio * 1.7), BALL_R * (0.5 + heightRatio * 0.35));
      this.ballGlow.fill({ color: 0x000000, alpha: shadowAlpha });
    }
    this.ballGlow.visible = ibz > 5;

    // elevation halo — a faint bright rim tracking the lifted sprite, brightening with height so a high
    // ball reads as lit and floating rather than a flat disc. Matches the grown ball radius + a thin ring.
    this.ballHighlight.position.set(bx, by);
    this.ballHighlight.clear();
    if (ibz > 5) {
      this.ballHighlight.circle(0, 0, BALL_R * (1 + heightRatio * 0.55) + 2.5);
      this.ballHighlight.fill({ color: 0xffffff, alpha: 0.05 + heightRatio * 0.12 });
    }
    this.ballHighlight.visible = ibz > 5;

    // ── ball-under-scorebug fade ── the ball is z-topmost on the canvas, but the fixed DOM scoreboard
    // strip lives above the canvas and could still cover a ball near the top touchline. When the ball's
    // screen position slides under the strip, dim it (CSS transitions the opacity) so the ball is never
    // hidden; restore it the instant the ball clears the strip. Rect is cached (calcTransform), cheap.
    if (this.hudEl && this.hudRect) {
      const sx = this.offsetX + (ibx + touchX) * this.scale;
      const sy = this.offsetY + (iby + touchY - arcOffset) * this.scale;
      const rad = (BALL_R + 5) * this.scale;
      const hr = this.hudRect;
      const over = sy - rad < hr.bottom && sy + rad > hr.top && sx + rad > hr.left && sx - rad < hr.right;
      if (over !== this.hudFaded) { this.hudFaded = over; this.hudEl.style.opacity = over ? '0.2' : ''; }
    }

    // ── jockey / containing posture: shield arcs on the closest 1-2 pressers glued to the carrier ──
    this.jockeyGfx.clear();
    if (b.controllerId != null) {
      const carrier = byId.get(b.controllerId);
      const vc = this.visualPlayers.get(b.controllerId);
      if (carrier && vc) {
        // nearest two pressers, tracked in scalars — no per-rAF array/sort/slice allocation (hot 60fps path).
        let b1x = 0, b1y = 0, b1d = Infinity, b2x = 0, b2y = 0, b2d = Infinity;
        for (const p of state.players) {
          if (p.team === carrier.team || p.id === carrier.id) continue;
          const vp = this.visualPlayers.get(p.id);
          if (!vp) continue;
          const d = Math.hypot(vc.x - vp.x, vc.y - vp.y);
          if (d < 1 || d > PLAYER_R * 2.5) continue;
          if (d < b1d) { b2x = b1x; b2y = b1y; b2d = b1d; b1x = vp.x; b1y = vp.y; b1d = d; }
          else if (d < b2d) { b2x = vp.x; b2y = vp.y; b2d = d; }
        }
        for (let k = 0; k < 2; k++) {
          const cx = k === 0 ? b1x : b2x, cy = k === 0 ? b1y : b2y;
          if ((k === 0 ? b1d : b2d) === Infinity) continue;
          const ang = Math.atan2(vc.y - cy, vc.x - cx);
          this.jockeyGfx.arc(cx, cy, DISC_R + 3, ang - 0.6, ang + 0.6);
          this.jockeyGfx.stroke({ width: 2.5, color: 0xf2c14e, alpha: 0.75 });
          this.jockeyGfx.moveTo(cx + Math.cos(ang) * (DISC_R + 1), cy + Math.sin(ang) * (DISC_R + 1));
          this.jockeyGfx.lineTo(cx + Math.cos(ang) * (DISC_R + 5), cy + Math.sin(ang) * (DISC_R + 5));
          this.jockeyGfx.stroke({ width: 1.5, color: 0xf2c14e, alpha: 0.55 });
        }
      }
    }

    // ── goal celebration FX (time-based, non-blocking) ── redrawn every tick off performance.now(); it
    // simply lapses when its window elapses. Suppressed under replayMode so a rewind/replay never re-fires it.
    this.drawGoalCelebration(now);
    // ── event toasts ── deadline-pruned here (not via setTimeout) so a hidden→visible return flushes any
    // stale toasts in one pass and no per-toast timer can leak across a long watch session.
    this.pruneToasts(now);
  };

  // Draw the goal celebration onto goalFxGfx: a radiating ring burst at the scored-on goal mouth + a
  // slow flash hugging the scorer's disc. All keyed on elapsed time since startGoalCelebration; a rapid
  // seek/replay just lets the window lapse (goalCelebStart is zeroed on a seek and never set under replay).
  private drawGoalCelebration(now: number): void {
    const g = this.goalFxGfx;
    const elapsed = this.goalCelebStart ? now - this.goalCelebStart : Infinity;
    if (this.replayMode || elapsed >= this.goalCelebDur) {
      if (this.goalCelebStart) { this.goalCelebStart = 0; g.clear(); }   // clear once when the window closes
      return;
    }
    g.clear();
    const t = clamp(elapsed / this.goalCelebDur, 0, 1);        // 0..1 over the whole sequence
    const fade = 1 - t;
    const col = this.goalCelebHome ? 0xff8a8a : 0x9ecbff;      // scoring side's colour
    // radiating ring burst at the goal mouth — three staggered rings expanding + fading outward.
    const gx = this.goalCelebGoalX, gy = this.goalCelebGoalY;
    for (let k = 0; k < 3; k++) {
      const rt = clamp(t * 1.35 - k * 0.18, 0, 1);             // each ring launches slightly later
      if (rt <= 0 || rt >= 1) continue;
      const rr = 12 + rt * 120;
      g.circle(gx, gy, rr);
      g.stroke({ width: 3.5 * (1 - rt), color: k === 1 ? 0xffe97a : col, alpha: (1 - rt) * 0.85 });
    }
    // a bright spark core at the goal mouth for the first third
    if (t < 0.34) {
      g.circle(gx, gy, 6 + t * 26);
      g.fill({ color: 0xffe97a, alpha: (0.34 - t) * 1.6 });
    }
    // scorer disc slow-flash — a soft glow + ring pulsing ~2×/sec that hugs the scorer's tweened position.
    if (this.goalCelebScorerId != null) {
      const v = this.visualPlayers.get(this.goalCelebScorerId);
      if (v) {
        const flash = 0.5 + 0.5 * Math.sin(elapsed * 0.012);   // slow flash
        g.circle(v.x, v.y, DISC_R + 3 + flash * 4);
        g.stroke({ width: 3, color: 0xffe97a, alpha: fade * (0.35 + flash * 0.5) });
        g.circle(v.x, v.y, DISC_R + 1);
        g.fill({ color: 0xffffff, alpha: fade * flash * 0.28 });
      }
    }
  }

  // Arm the goal celebration: record the start time, scoring side, scorer id (for the disc flash) and the
  // goal-mouth the burst radiates from. homeAttacksX is set by updateMomentum (which runs earlier in sync);
  // if it isn't known yet we aim the burst at the goal nearer the scorer, or the centre spot as a last resort.
  private startGoalCelebration(homeScored: boolean, now: number): void {
    this.goalCelebStart = now;
    this.goalCelebHome = homeScored;
    this.goalCelebScorerId = this.lastGoalScorerId;
    let gx: number;
    if (this.homeAttacksX !== null) {
      const homeGoalMouth = this.homeAttacksX;   // the goal HOME attacks toward = where a home goal is scored
      gx = homeScored ? homeGoalMouth : (homeGoalMouth === 0 ? PITCH_W : 0);
    } else {
      const v = this.goalCelebScorerId != null ? this.visualPlayers.get(this.goalCelebScorerId) : undefined;
      gx = v ? (v.x < PITCH_W / 2 ? 0 : PITCH_W) : PITCH_W / 2;
    }
    this.goalCelebGoalX = gx; this.goalCelebGoalY = PITCH_H / 2;
    (window as unknown as { __goalCeleb?: unknown }).__goalCeleb = { at: Math.round(now), home: homeScored, gx, scorer: this.goalCelebScorerId };   // verify hook
  }

  // A quick scale/glow pulse on the DOM score value — the "score-bug pulse" of the celebration. CSS keyframe
  // re-triggered by resetting the animation (a reflow between). Cheap, one-shot, no per-frame cost.
  private pulseScoreBug(): void {
    const el = this.hudRefs?.score;
    if (!el) return;
    el.style.display = 'inline-block';   // a span won't take transform:scale while inline
    el.style.transformOrigin = 'center';
    el.style.animation = 'none'; void el.offsetWidth;
    el.style.animation = 'footyScorePulse .6s ease-out';
  }

  sync(state: EngineState): void {
    if (RENDER_DEBUG && this.animTime === 0) console.log('[HUD] first sync, state keys:', Object.keys(state).filter(k => ['homeScore','homeShots','possessionPct','clockMs','matchState'].includes(k)).map(k => `${k}=${(state as any)[k]}`).join(', '));
    // ── P0 ingest: measure the frame interval (the tween window) + arm renderFrame. animTime now advances
    // in renderFrame (per rAF) so stride/pulse/phase animations age smoothly, not in ~4fps steps.
    const nowMs = performance.now();
    // Tween window = the measured inter-frame interval. Floor at 16ms (one display frame), NOT 60ms: at high
    // playback speed frames arrive fast (8× ≈ 31ms apart), and a 60ms floor paced each segment slower than
    // frames re-targeted it → the motion covered only ~half each delta → FF looked laggy/half-speed (user
    // report). 16ms lets high-speed frames interpolate at the right pace; normal speed is unaffected (>16ms).
    this.segDur = clamp(this.lastIngest ? nowMs - this.lastIngest : 250, 16, 600);
    this.lastIngest = nowMs;
    this.segStart = nowMs;
    this.lastState = state;
    if (!this.interpReady) this.syncNeedsImmediateDraw = true;   // first ingest → paint now, don't wait a tick
    this.interpReady = true;
    // Headless self-verify hook (SysArch later21): expose the latest frame so match-view render data
    // (setPieceState, ball, players) is eval-inspectable under any box load — no screenshot needed.
    (window as unknown as { __lastFrame?: EngineState }).__lastFrame = state;
    // §weather: a wet-pitch overlay on rain (the condition reaches the watch badge but the pitch never
    // showed it). Redrawn only on change (dirty-checked). Wind stays badge-only (no clear pitch cue).
    const weather = (state as { weather?: string }).weather ?? 'clear';
    if (weather !== this.weatherShown) {
      this.weatherShown = weather;
      this.weatherGfx.clear();
      if (weather === 'rain') {
        this.weatherGfx.rect(-GOAL_DEPTH, 0, PITCH_W + GOAL_DEPTH * 2, PITCH_H);
        this.weatherGfx.fill({ color: 0x2b4a66, alpha: 0.16 });   // a cool blue-grey wet sheen
      }
      (window as unknown as { __weather?: string }).__weather = weather;   // eval-verify hook
    }
    const byId = this.playerById;
    byId.clear();
    for (const p of state.players) byId.set(p.id, p);
    if (state.version) {
      const seedText = typeof state.seed === 'number' ? `seed:${state.seed} ` : '';
      this.versionText.text = `${seedText}eng:${state.version} ${this.uiVersion}`;
    }
    const b = state.ball;
    const ballSpeed = Math.sqrt(b.vx ** 2 + b.vy ** 2);
    if (b.controllerId !== this.lastControllerId) {
      this.prevControllerId = this.lastControllerId;
      this.trailBuffer = [];
      this.lastControllerId = b.controllerId;
      // NOTE: do NOT null visualBall here — the prev→target tween + the >160px snap below already handle a
      // possession change cleanly. Nulling it made ballPrev===ballTarget for that segment, freezing the ball
      // for ~250ms after every receipt (caught in adversarial review).
    }
    // P0: store the ball's prev→target for the 60fps tween (snap a big jump: kickoff/seek/out-of-bounds).
    // vb = the CURRENT interpolated ball (renderFrame owns the actual draw); used here only for trail/arrow refs.
    const vb = this.visualBall ?? { x: b.x, y: b.y, z: b.z ?? 0 };
    this.ballPrev = { x: vb.x, y: vb.y, z: vb.z };
    this.ballTarget = { x: b.x, y: b.y, z: b.z ?? 0 };
    // Curve tween tangents: the previous frame's END velocity is this segment's START tangent; this frame's
    // is the END tangent (renderFrame Hermites between them). Carry BEFORE overwriting the target velocity.
    this.ballPrevVx = this.ballTargetVx; this.ballPrevVy = this.ballTargetVy;
    this.ballTargetVx = b.vx; this.ballTargetVy = b.vy;
    let snapped = false;
    if (Math.hypot(b.x - vb.x, b.y - vb.y) > 160) { this.ballPrev = { ...this.ballTarget }; snapped = true; }
    // ── sharp-direction snap ── a first-time pass, deflection or ricochet swings the ball's heading hard
    // between two consecutive frames. Linear-tweening from the OLD trajectory's tail into the new one bows
    // the path into a fake orbiting arc across the segment. If the ball is in flight and its velocity
    // heading changed >45° (both frames moving meaningfully), snap to the new sample so the redirect reads
    // as an instant, crisp change of direction. Uses the engine's own ball velocity (no positional guess).
    const bSpeedSq = b.vx * b.vx + b.vy * b.vy;
    if (b.controllerId === null && bSpeedSq > 400 && this.prevBallSpeedSq > 400) {
      const dir = Math.atan2(b.vy, b.vx);
      const dd = Math.abs(Math.atan2(Math.sin(dir - this.prevBallDir), Math.cos(dir - this.prevBallDir)));
      if (dd > Math.PI / 4) { this.ballPrev = { ...this.ballTarget }; snapped = true; }
    }
    if (bSpeedSq > 400) { this.prevBallDir = Math.atan2(b.vy, b.vx); this.prevBallSpeedSq = bSpeedSq; }
    else this.prevBallSpeedSq = bSpeedSq;
    // Curve-follow the tween only for a free-flight ball with real speed and no snap this segment. A carried
    // ball, a stationary/slow ball or a snapped redirect uses the plain linear lerp (a straight pass reduces
    // to a line under Hermite anyway — the endpoint tangents lie along the chord — so this is purely a guard).
    this.ballCurveActive = b.controllerId === null && bSpeedSq > 400 && !snapped;
    (window as unknown as { __ballCurve?: boolean }).__ballCurve = this.ballCurveActive;   // verify hook

    // ── trail ──
    if (b.controllerId === null && ballSpeed > 20) {
      this.trailBuffer.push({ x: vb.x, y: vb.y, z: vb.z });   // carry z so the trail can follow a lofted arc
    } else {
      this.trailBuffer = [];
    }
    while (this.trailBuffer.length > TRAIL_LENGTH) this.trailBuffer.shift();
    // verify hook: the ball-path trail (traces the curl). __maxTrail accumulates so one eval confirms it populated;
    // __maxTrailZ confirms lofted balls carry height into the trail (so it arcs instead of lying flat).
    const __w = window as unknown as { __trailLen?: number; __maxTrail?: number; __maxTrailZ?: number };
    __w.__trailLen = this.trailBuffer.length;
    __w.__maxTrail = Math.max(__w.__maxTrail ?? 0, this.trailBuffer.length);
    let __mz = __w.__maxTrailZ ?? 0;                      // allocation-free (was trailBuffer.map()+spread each ingest)
    for (const tp of this.trailBuffer) if (tp.z > __mz) __mz = tp.z;
    __w.__maxTrailZ = __mz;

    // ── curl emphasis: a curling ball (engine's ball.curl, |curl|~0..0.36) tints its trail toward violet
    //    + thickens it, so the Beckham bend READS (the trail already traces the bent path; this flags it). ──
    const curlMag = Math.min(Math.abs((b as { curl?: number }).curl ?? 0) / 0.3, 1);
    (__w as { __maxCurl?: number }).__maxCurl = Math.max((__w as { __maxCurl?: number }).__maxCurl ?? 0, curlMag);
    const CURL_COLOR = 0xc060ff;
    const curlTint = (base: number): number => {
      const t = curlMag * 0.85; if (t < 0.02) return base;
      const ar = (base >> 16) & 255, ag = (base >> 8) & 255, ab = base & 255;
      const dr = ((CURL_COLOR >> 16) & 255) - ar, dg = ((CURL_COLOR >> 8) & 255) - ag, db = (CURL_COLOR & 255) - ab;
      return ((ar + Math.round(dr * t)) << 16) | ((ag + Math.round(dg * t)) << 8) | (ab + Math.round(db * t));
    };

    // ── cutback emphasis: a "pull-back into the box" (Boris's box-finish play) tints its trail LIME + thickens it,
    //    so the chance-creating cutback READS distinctly from an ordinary pass. Consumes a ball.cutback render-hint
    //    (build-ahead — goes live the moment Boris serialises it on the DK::Cutback pass, like ball.curl). ──
    const cutbackActive = !!(b as { cutback?: boolean }).cutback;
    const CUTBACK_COLOR = 0x66ff99;
    (__w as { __cutbackActive?: boolean; __cutbackSeen?: boolean }).__cutbackActive = cutbackActive;
    if (cutbackActive) (__w as { __cutbackSeen?: boolean }).__cutbackSeen = true;

    for (let i = 0; i < TRAIL_LENGTH; i++) {
      const t = this.trailPool[i];
      const idx = this.trailBuffer.length - 1 - i;
      if (idx >= 0) {
        const pt = this.trailBuffer[idx];
        t.visible = true;
        t.position.set(pt.x, pt.y - pt.z * 0.6);   // lift by the same base arcOffset the ball uses → trail follows the arc
        // the dot is a pre-drawn white unit circle — scale it to the radius, tint it the colour (no
        // clear()+re-tessellate per dot per sync; see the pool construction)
        const alpha = (i / TRAIL_LENGTH) * 0.48;
        const r = BALL_R * (0.4 + (1 - i / TRAIL_LENGTH) * 0.75) * (cutbackActive ? 1.3 : 1);   // a cutback trail reads thicker
        t.scale.set(r);
        t.alpha = cutbackActive ? Math.min(alpha * 1.8, 0.8) : alpha;
        t.tint = cutbackActive ? CUTBACK_COLOR : curlTint(0xffdd44);
      } else {
        t.visible = false;
      }
    }

    // ── shot trail ──
    const SHOT_SPEED_THRESHOLD = 350;
    const SHOT_TRAIL_LENGTH = 24;
    if (b.controllerId === null && ballSpeed > SHOT_SPEED_THRESHOLD) {
      this.shotTrailBuffer.push({ x: vb.x, y: vb.y, z: vb.z });
    } else if (ballSpeed < SHOT_SPEED_THRESHOLD * 0.5) {
      this.shotTrailBuffer = [];
    }
    while (this.shotTrailBuffer.length > SHOT_TRAIL_LENGTH) this.shotTrailBuffer.shift();

    this.shotTrailGfx.clear();
    if (this.shotTrailBuffer.length >= 2) {
      for (let i = 0; i < this.shotTrailBuffer.length - 1; i++) {
        const a = this.shotTrailBuffer[i];
        const b2 = this.shotTrailBuffer[i + 1];
        const progress = (i + 1) / this.shotTrailBuffer.length;
        const alpha = progress * 0.85;
        const width = (BALL_R * 0.4 + progress * BALL_R * 1.2) * (1 + curlMag * 0.5);   // a curling shot's trail thickens
        this.shotTrailGfx.moveTo(a.x, a.y - a.z * 0.6);
        this.shotTrailGfx.lineTo(b2.x, b2.y - b2.z * 0.6);   // lofted shots (chips/dippers) arc with the ball
        this.shotTrailGfx.stroke({ width, color: curlTint(0xff4422), alpha });
      }
    }

    // ── players ──
    for (const p of state.players) {
      // A sent-off player is NOT on the pitch — skip his sprite entirely. The
      // engine always emits all 22 rows (the id is the array index) and parks
      // the ejected ones outside the touchline, so without this a red card
      // leaves a body loitering off the byline, and an arena match (where 16-18
      // slots are parked at once) draws a whole rank of them.
      if (p.sentOff) {
        const gone = this.playerEntries.get(p.id);
        if (gone) {
          gone.shadow.visible = false;
          gone.body.visible = false;
          gone.arrow.visible = false;
          gone.label.visible = false;
          gone.dirTag.visible = false;
        }
        this.playerTargets.delete(p.id);   // and stop the 60fps tween from chasing him
        continue;
      }
      let entry = this.playerEntries.get(p.id);
      if (!entry) {
        const shortName = p.name.split('(')[1]?.replace(')', '') ?? p.name;
        // squad number (jersey-style: GK=1 … ; engine ids 0-10 home / 11-21 away) prefixed to the label
        // for legibility — "10 Messi" reads at a glance (user feedback #4: player+number legibility).
        const labelName = `${(p.id % 11) + 1} ${shortName}`;
        // a soft drop-shadow, drawn once (static) and only repositioned each frame: a squashed dark
        // ellipse offset down-right, so every player reads as a lit figure casting a shadow on the turf.
        const shadow = new Graphics();
        shadow.ellipse(DISC_R * 0.28, DISC_R * 0.42, DISC_R * 1.02, DISC_R * 0.62);
        shadow.fill({ color: 0x000000, alpha: 0.22 });
        const body = new Graphics();
        const arrow = new Graphics();
        const label = new Text({
          text: labelName,
          // a thin dark outline so the name stays legible against the grass / mowing stripes
          style: new TextStyle({ fill: 0xffffff, fontSize: 11, fontFamily: 'monospace', stroke: { color: 0x081019, width: 2.5 } }),
        });
        label.anchor.set(0.5, 0);
        const dirTag = new Text({
          text: '',
          style: new TextStyle({ fill: 0x5cd6ff, fontSize: 9, fontFamily: 'monospace', fontWeight: 'bold', stroke: { color: 0x081019, width: 2 } }),
        });
        dirTag.anchor.set(0.5, 0);
        dirTag.visible = false;
        this.playerLayer.addChild(shadow);   // BEHIND the body (added first within the layer)
        this.playerLayer.addChild(body);
        this.playerLayer.addChild(arrow);
        this.playerLayer.addChild(label);
        this.playerLayer.addChild(dirTag);
        entry = {
          shadow,
          body,
          arrow,
          label,
          dirTag,
          dirShown: '',
          name: labelName,
          ratingShown: -1,
          statusShown: '',
          drawn: false,
          wasSliding: false,
          wasDiving: false,
          hadBall: false,
          slideAngle: p.team === 'home' ? 0 : Math.PI,
          diveAngle: p.team === 'home' ? Math.PI : 0,
          wasRawSliding: false,
          slideLatchUntil: -1,
          latchSlideKind: false,
          pokeAngle: p.team === 'home' ? 0 : Math.PI,
          lastDribbleType: p.dribbleType,
          wasSprinting: false,
          armDrawn: false, armAngle: 0, armCtrlX: 0, armCtrlY: 0, armHasBall: false, armHeading: false, armKnock: false, armDive: false,
        };
        this.playerEntries.set(p.id, entry);
        this.syncNeedsImmediateDraw = true;   // position the just-created shapes this sync (else they'd flash at the origin)
      }
      // Back on the pitch (a scrub/replay stepping back before the red card):
      // undo the hide above. dirTag keeps its own per-frame visibility rule.
      entry.shadow.visible = true;
      entry.body.visible = true;
      entry.arrow.visible = true;
      entry.label.visible = true;

      const color = p.role === 'GK'
        ? (p.team === 'home' ? HOME_GK_COLOR : AWAY_GK_COLOR)
        : (p.team === 'home' ? HOME_COLOR : AWAY_COLOR);
      const hasBall = b.controllerId === p.id;
      const r = DISC_R;
      // P0: store this player's prev→target for the 60fps tween (snap a teleport so we don't slide across
      // the pitch). vp = the CURRENT interpolated pos — renderFrame owns the actual position.set; vp is used
      // here only for shape references (dive reach, boot-toward-ball direction).
      const vp = this.visualPlayers.get(p.id) ?? { x: p.x, y: p.y };
      if (!this.visualPlayers.has(p.id)) this.visualPlayers.set(p.id, { x: p.x, y: p.y });
      let tg = this.playerTargets.get(p.id);
      if (!tg) { tg = { id: p.id, px: p.x, py: p.y, tx: p.x, ty: p.y }; this.playerTargets.set(p.id, tg); }
      else { tg.px = vp.x; tg.py = vp.y; tg.tx = p.x; tg.ty = p.y; if (Math.hypot(p.x - vp.x, p.y - vp.y) > 120) { tg.px = p.x; tg.py = p.y; } }
      const diving = p.role === 'GK' && (p.diveAnim ?? 0) > 0;
      // R28 C9 (duel legibility, render-only): latch the tackle POSE for a minimum
      // ~450ms of match clock from tackleAnim ONSET. The engine's 220ms standing win
      // is ~2.6 keyframes at 12fps — sub-perceptual — but the ENGINE value must not
      // change (tackleAnim feeds trace bytes + the scan_anomalies overlap-flag
      // exemption), so the extension lives entirely here. A backwards clock jump
      // (scrub/replay) resets the latch.
      const rawSliding = !diving && (p.tackleAnim ?? 0) > 0;
      if (entry.slideLatchUntil > state.clockMs + 450) entry.slideLatchUntil = -1;
      if (rawSliding && !entry.wasRawSliding) {
        entry.slideLatchUntil = state.clockMs + 450;
        entry.latchSlideKind = p.slide === true;
        // C9: aim the poked leg at the BALL — the contact point of the duel (C3
        // amortizes the ball-close across the gather, so leg and ball now visually
        // meet). Locked at onset like the GK diveAngle so the pose doesn't swing.
        entry.pokeAngle = Math.atan2(b.y - vp.y, b.x - vp.x);
      }
      if (rawSliding && p.slide) entry.latchSlideKind = true;   // escalated to a grounded slide mid-anim
      entry.wasRawSliding = rawSliding;
      const sliding = rawSliding || (!diving && entry.slideLatchUntil > state.clockMs);
      const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
      const knockDribble = p.dribbleType === 3;
      const sprinting = knockDribble || speed > 39;
      if (sliding && !entry.wasSliding) {
        entry.slideAngle = Math.hypot(p.vx, p.vy) > 1 ? Math.atan2(p.vy, p.vx) : (p.team === 'home' ? 0 : Math.PI);
      }
      if (diving && !entry.wasDiving) {
        // the keeper stretches toward the ball; locked in at dive onset so the
        // reach direction doesn't swing once he's parried/punched it away.
        entry.diveAngle = Math.atan2(b.y - vp.y, b.x - vp.x);
      }
      const needsRedraw = !entry.drawn || sliding || entry.wasSliding || diving || entry.wasDiving
        || hasBall !== entry.hadBall
        || p.dribbleType !== entry.lastDribbleType || sprinting !== entry.wasSprinting;
      entry.wasSliding = sliding;
      entry.wasDiving = diving;
      entry.hadBall = hasBall;
      entry.lastDribbleType = p.dribbleType;
      entry.wasSprinting = sprinting;

      entry.shadow.visible = !diving;          // a diving keeper is airborne — no ground shadow (positioned in renderFrame)
      entry.body.alpha = hasBall ? 1 : 0.82; // consistent alpha: carriers pop, others uniform (positioned in renderFrame)
      if (needsRedraw) {
        entry.body.clear();
        if (diving) {
          // diving save: full-length body stretched toward the ball with bright
          // gloves outstretched at the reach tip + a motion smear behind. The
          // stretch grows with dive intensity (p.diveAnim, peaks at the save).
          const t = Math.min((p.diveAnim ?? 0) / 480, 1);
          const reach = r * (1.45 + t * 0.95);
          entry.body.rotation = entry.diveAngle;
          // body — elongated oval offset toward the ball
          entry.body.ellipse(r * 0.35, 0, reach, r * 0.55);
          entry.body.fill({ color, alpha: 0.92 });
          entry.body.ellipse(r * 0.35, 0, reach, r * 0.55);
          entry.body.stroke({ width: 1.5, color: 0x000000 });
          // outstretched gloves at the reach tip
          const tipX = r * 0.35 + reach;
          entry.body.circle(tipX, 0, r * 0.5);
          entry.body.fill({ color: 0xffe27a });
          entry.body.circle(tipX, 0, r * 0.5);
          entry.body.stroke({ width: 1, color: 0x000000 });
          // motion smear trailing the dive
          entry.body.moveTo(-reach * 0.7, -r * 0.3);
          entry.body.lineTo(-reach * 1.15, -r * 0.3);
          entry.body.moveTo(-reach * 0.7, r * 0.3);
          entry.body.lineTo(-reach * 1.15, r * 0.3);
          entry.body.stroke({ width: 2, color: 0xffffff, alpha: 0.4 });
        } else if (sliding) {
          // C9: pose kind is LATCHED (p.slide drops with tackleAnim before the
          // display latch expires); the grounded slide keeps the movement-locked
          // slideAngle (dust trails the run), the standing poke aims at the ball.
          const slideKind = entry.latchSlideKind || p.slide === true;
          entry.body.rotation = slideKind ? entry.slideAngle : entry.pokeAngle;
          if (slideKind) {
            // committed GROUNDED slide (engine flags p.slide = tackleAnim>400): long flat body + a dust trail
            entry.body.ellipse(0, 0, r * 1.8, r * 0.6);
            entry.body.fill({ color, alpha: 0.7 });
            entry.body.ellipse(0, 0, r * 1.8, r * 0.6);
            entry.body.stroke({ width: 1, color: 0x000000 });
            entry.body.circle(-r * 0.8, 0, r * 0.4);
            entry.body.fill({ color: 0xcccccc, alpha: 0.5 });
            entry.body.circle(-r * 1.3, 0, r * 0.25);
            entry.body.fill({ color: 0xdddddd, alpha: 0.3 });
            (window as unknown as { __lastSlide?: unknown }).__lastSlide = { id: p.id, x: Math.round(vp.x), y: Math.round(vp.y) };   // verify hook
          } else {
            // standing POKE (a lesser tackle, tackleAnim 1-400): a slight upright lunge + an outstretched
            // leg toward the ball — NOT a grounded slide, no dust.
            entry.body.ellipse(0, 0, r * 1.25, r * 0.85);
            entry.body.fill({ color, alpha: 0.85 });
            entry.body.ellipse(0, 0, r * 1.25, r * 0.85);
            entry.body.stroke({ width: 1.5, color: 0x000000 });
            entry.body.circle(r * 1.15, 0, r * 0.28);   // the poked leg/foot reaching for the ball
            entry.body.fill({ color, alpha: 0.85 });
          }
        } else {
          entry.body.rotation = 0;
          entry.body.circle(0, 0, r);
          entry.body.fill({ color });
          entry.body.circle(0, 0, r);
          entry.body.stroke({ width: knockDribble ? 3 : hasBall ? 2.5 : 1.5, color: knockDribble ? 0xfff1a8 : 0x000000 });
          if (sprinting) {
            const runAngle = speed > 1 ? Math.atan2(p.vy, p.vx) : (p.team === 'home' ? 0 : Math.PI);
            const backX = -Math.cos(runAngle);
            const backY = -Math.sin(runAngle);
            const sideX = -backY;
            const sideY = backX;
            for (let i = 0; i < 3; i++) {
              const offset = (i - 1) * r * 0.55;
              const startX = backX * (r * 0.95 + i * 2.6) + sideX * offset;
              const startY = backY * (r * 0.95 + i * 2.6) + sideY * offset;
              entry.body.moveTo(startX, startY);
              entry.body.lineTo(startX + backX * (knockDribble ? 11 : 7), startY + backY * (knockDribble ? 11 : 7));
            }
            entry.body.stroke({ width: knockDribble ? 2 : 1.5, color: knockDribble ? 0xfff1a8 : 0xffffff, alpha: knockDribble ? 0.78 : 0.45 });
          }
        }
        if (!sliding && !diving) entry.drawn = true;
      }

      // F7: advance the TARGET facing here (per keyframe); the boot/head arrow is now redrawn PER TICK at a
      // LERPED facing in renderFrame (drawPlayerArrow) — it used to draw here at keyframe rate, so the boots
      // lagged a turn by up to ~250ms. Store the segment-start facing to tween from (snap ⇒ no tween).
      const MIN_SPEED = 8;
      let angle = this.facingAngles.get(p.id);
      if (angle === undefined) angle = p.team === 'home' ? 0 : Math.PI;
      const prevAngle = angle;
      let snappedFacing = false;
      if (p.facing !== undefined) {
        if (b.controllerId === p.id && this.prevControllerId !== p.id) { angle = p.facing; snappedFacing = true; }   // snap on receive
        else angle = this.turnTowards(angle, p.facing, Math.PI / 18);
      } else if (speed > MIN_SPEED) {
        angle = this.turnTowards(angle, Math.atan2(p.vy, p.vx), Math.PI / 24);
      } else {
        angle = this.turnTowards(angle, Math.atan2(state.ball.y - p.y, state.ball.x - p.x), Math.PI / 60);
      }
      this.facingPrev.set(p.id, snappedFacing ? angle : prevAngle);
      this.facingAngles.set(p.id, angle);
      // Diagnose unexpected facing jumps even though ordinary turns are capped (debug-only).
      if (RENDER_DEBUG) {
        const prevA = this.prevFacingAngles.get(p.id);
        if (prevA !== undefined) {
          const aDiff = Math.abs(angle - prevA);
          const na = aDiff > Math.PI ? 2*Math.PI - aDiff : aDiff;
          if (na > Math.PI * 0.7) console.warn(`[facing_flicker] player ${p.id} (${p.role}) angle jumped ${Math.round(na * 180 / Math.PI)} deg - speed=${Math.round(speed)}`);
        }
        this.prevFacingAngles.set(p.id, angle);
      }

      // live rating ticks beside the name (dirty-checked — the value only moves on a stat/score change).
      // label + dirTag are positioned in renderFrame (they ride the tweened player position).
      const rt = this.liveRating(p, state.homeScore ?? 0, state.awayScore ?? 0);
      // Condition marker on the name label — sent-off / injured / booked. All three ride on the frame
      // (types.ts Player) but were previously invisible on the pitch (they only nudged the rating). A
      // sent-off man's label also reds. Priority red > injury > yellow; folded into the label dirty-check.
      const status = p.sentOff ? '🟥 ' : p.injured ? '🤕 ' : (p.yellow ?? 0) > 0 ? '🟨 ' : '';
      if (rt !== entry.ratingShown || status !== entry.statusShown) {
        entry.ratingShown = rt; entry.statusShown = status;
        entry.label.text = `${status}${entry.name} ${rt.toFixed(1)}`;
        entry.label.tint = p.sentOff ? 0xff6b6b : this.ratingTint(rt);
      }
      // directive overlay: the player's active tactical instruction below his name (toggleable)
      const dir = this.showDirectives ? (this.directiveMap.get(p.id) ?? '') : '';
      if (dir !== entry.dirShown) { entry.dirShown = dir; entry.dirTag.text = dir; entry.dirTag.visible = dir !== ''; }
    }

    // eval-hook (verification): the active directive tags currently drawn on the pitch
    (window as unknown as { __dirOverlay?: unknown }).__dirOverlay = this.showDirectives
      ? [...this.playerEntries].filter(([, e]) => e.dirTag.visible).map(([id, e]) => ({ id, t: e.dirTag.text }))
      : [];

    // Defensive: drop markers for ids no longer in the frame. The fixed-22 roster makes this a
    // no-op in normal play (only fires when the player set actually shrinks), so it costs nothing
    // per frame — but it stops a removed player being left drawn at a stale position.
    if (this.playerEntries.size > state.players.length) {
      for (const [id, e] of this.playerEntries) {
        if (!byId.has(id)) { e.shadow.destroy(); e.body.destroy(); e.arrow.destroy(); e.label.destroy(); e.dirTag.destroy(); this.playerEntries.delete(id); this.playerTargets.delete(id); this.visualPlayers.delete(id); }
      }
    }

    // ── carrier ring + ball + jockey arcs are POSITIONAL → drawn in renderFrame (per rAF) so they ride
    //    the tweened positions instead of jumping at ~4fps with the keyframes. ──

    // ── events ──
    this.eventGfx.clear();
    for (const label of this.eventLabels) label.visible = false;
    let labelIdx = 0;
    for (const ev of (state.events ?? [])) {
      const skillLike = ev.type === 'skill' || ev.type === 'dragback';
      const lifetime = ev.type === 'pass' ? 700 : ev.type === 'header' ? 600 : ev.type === 'nutmeg' ? 1000
        : ev.type === 'tip' ? 1600 : ev.type === 'stepover' ? 450 : ev.type === 'roulette' ? 520 : ev.type === 'gk_punch' ? 460
        : ev.type === 'takeon_lost' ? 900 : ev.type === 'chop' ? 700
        : skillLike ? 650 : 2200;
      const alpha = clamp(1 - ev.age / lifetime, 0, 1) * 0.8;
      if (alpha <= 0) continue;
      if (ev.type === 'pass') {
        const target = ev.targetId != null ? byId.get(ev.targetId) : undefined;
        if (target) {
          // draw to the receiver's SMOOTHED position (matches the gliding player graphic; the raw engine
          // position steps per-frame, so the line snapped while the player lerped — same pattern as below)
          const toV = (ev.targetId != null ? this.visualPlayers.get(ev.targetId) : undefined) ?? { x: target.x, y: target.y };
          this.eventGfx.moveTo(ev.x, ev.y);
          this.eventGfx.lineTo(toV.x, toV.y);
          this.eventGfx.stroke({ width: 2, color: 0x9ed7ff, alpha: alpha * 0.75 });
        }
        continue;
      }
      if (ev.type === 'nutmeg') {
        // A dedicated nutmeg: the ball punches THROUGH the beaten opponent (targetId) — a gold streak in
        // the trickster→victim direction, two red "leg" ticks marking the gap it went through, an
        // embarrassed pulse ring on the victim, and a "NUTMEG!" call. Robust to the payload: falls back to
        // the event spot + a horizontal streak if Boris omits playerId/targetId.
        const t = ev.age / lifetime;
        const victim = ev.targetId != null ? byId.get(ev.targetId) : undefined;
        const cx = victim ? (this.visualPlayers.get(victim.id)?.x ?? victim.x) : ev.x;
        const cy = victim ? (this.visualPlayers.get(victim.id)?.y ?? victim.y) : ev.y;
        let dx = 1, dy = 0;
        const tm = ev.playerId != null ? byId.get(ev.playerId) : undefined;
        if (tm) {
          const mx = this.visualPlayers.get(tm.id)?.x ?? tm.x, my = this.visualPlayers.get(tm.id)?.y ?? tm.y;
          const a = Math.atan2(cy - my, cx - mx); dx = Math.cos(a); dy = Math.sin(a);
        }
        const reach = PLAYER_R + 10 + t * 16;
        this.eventGfx.moveTo(cx - dx * reach * 0.5, cy - dy * reach * 0.5);
        this.eventGfx.lineTo(cx + dx * reach, cy + dy * reach);
        this.eventGfx.stroke({ width: 3, color: 0xffd24d, alpha });
        const px = -dy, py = dx;   // perpendicular = the two "legs" the ball threaded
        for (const s of [1, -1]) {
          this.eventGfx.moveTo(cx + px * s * (PLAYER_R - 1) - dx * 2, cy + py * s * (PLAYER_R - 1) - dy * 2);
          this.eventGfx.lineTo(cx + px * s * (PLAYER_R - 1) + dx * 3, cy + py * s * (PLAYER_R - 1) + dy * 3);
          this.eventGfx.stroke({ width: 2, color: 0xff6b6b, alpha: alpha * 0.85 });
        }
        this.eventGfx.circle(cx, cy, PLAYER_R + 2 + t * 9);
        this.eventGfx.stroke({ width: 2, color: 0xff6b6b, alpha: alpha * 0.7 });
        // a bright flash ON the beaten defender for the first third — the ball went THROUGH him.
        if (t < 0.33) {
          this.eventGfx.circle(cx, cy, PLAYER_R + 1);
          this.eventGfx.fill({ color: 0xffffff, alpha: (0.33 - t) * 1.9 });
        }
        if (labelIdx < this.eventLabels.length) {
          const label = this.eventLabels[labelIdx++];
          label.text = 'NUTMEG!';
          label.position.set(cx, Math.max(18, cy - reach - 12));
          label.style.fill = 0xffd24d;
          label.alpha = clamp(1 - t, 0, 1);
          label.visible = true;
        }
        continue;
      }
      if (skillLike) {
        // Swirl around the trickster: two counter-rotating arcs that expand and fade
        const mover = ev.playerId != null ? byId.get(ev.playerId) : undefined;
        const cx = mover ? (this.visualPlayers.get(mover.id)?.x ?? mover.x) : ev.x;
        const cy = mover ? (this.visualPlayers.get(mover.id)?.y ?? mover.y) : ev.y;
        const t = ev.age / lifetime;
        const sr = PLAYER_R + 4 + t * 10;
        const spin = this.animTime * 0.25;
        const swirlColor = this.eventColor(ev.type);
        for (const dir of [1, -1]) {
          const a0 = spin * dir + (dir > 0 ? 0 : Math.PI);
          this.eventGfx.arc(cx, cy, sr, a0, a0 + Math.PI * 0.85);
          this.eventGfx.stroke({ width: 2.5, color: swirlColor, alpha: alpha * 0.9 });
        }
        continue;
      }
      if (ev.type === 'stepover') {
        // Quick left-right feint: two small ellipses sweeping to either side of the carrier's feet (the
        // shimmy), plus a light foot-flick tick trailing the current swing side. Anchored to the carrier's
        // smoothed position (playerId), falling back to the event spot. ~450ms, subtle (no callout).
        const mover = ev.playerId != null ? byId.get(ev.playerId) : undefined;
        const cx = mover ? (this.visualPlayers.get(mover.id)?.x ?? mover.x) : ev.x;
        const cy = mover ? (this.visualPlayers.get(mover.id)?.y ?? mover.y) : ev.y;
        const t = ev.age / lifetime;
        const col = this.eventColor('stepover');
        const swing = Math.sin(t * Math.PI * 3);          // ~1.5 left-right cycles across the move
        for (const s of [1, -1]) {
          const ox = s * swing * (PLAYER_R + 5);
          this.eventGfx.ellipse(cx + ox, cy + PLAYER_R * 0.35, 6.5, 3.4);
          this.eventGfx.stroke({ width: 2, color: col, alpha: alpha * (0.9 - t * 0.35) });
        }
        this.eventGfx.moveTo(cx, cy + PLAYER_R * 0.35);
        this.eventGfx.lineTo(cx + swing * (PLAYER_R + 9), cy + PLAYER_R * 0.35);
        this.eventGfx.stroke({ width: 1.5, color: col, alpha: alpha * 0.5 });
        continue;
      }
      if (ev.type === 'roulette') {
        // Zidane roulette: a comet arc whose leading edge sweeps a full 360° around the carrier over the
        // move, with a bright spin-dot (the ball dragged round on the sole) riding the leading edge. ~520ms.
        const mover = ev.playerId != null ? byId.get(ev.playerId) : undefined;
        const cx = mover ? (this.visualPlayers.get(mover.id)?.x ?? mover.x) : ev.x;
        const cy = mover ? (this.visualPlayers.get(mover.id)?.y ?? mover.y) : ev.y;
        const t = ev.age / lifetime;
        const col = this.eventColor('roulette');
        const rr = PLAYER_R + 5 + t * 6;
        const head = -Math.PI / 2 + t * Math.PI * 2;      // leading edge → one full turn
        this.eventGfx.arc(cx, cy, rr, head - Math.PI * 1.25, head);
        this.eventGfx.stroke({ width: 3, color: col, alpha });
        this.eventGfx.circle(cx + Math.cos(head) * rr, cy + Math.sin(head) * rr, 2.6);
        this.eventGfx.fill({ color: 0xffffff, alpha });
        continue;
      }
      if (ev.type === 'takeon_lost') {
        // R28 C9: a LOST take-on — the defender READ the feint and was granted the
        // ball (engine C3). The possession-ring cross-fade (COMMIT 8a, renderFrame)
        // already animates the ring swap on the controller change, so this cue is
        // deliberately event-scoped and ring-free (no double-firing): a closing
        // pincer on the winner (playerId) — "he clamped it" — plus stumble skid
        // ticks trailing off the beaten carrier (targetId).
        const winner = ev.playerId != null ? byId.get(ev.playerId) : undefined;
        const wx = winner ? (this.visualPlayers.get(winner.id)?.x ?? winner.x) : ev.x;
        const wy = winner ? (this.visualPlayers.get(winner.id)?.y ?? winner.y) : ev.y;
        const t = ev.age / lifetime;
        const rr = PLAYER_R + 11 - Math.min(t * 2, 1) * 7;   // pincer closes over the first half
        for (const s of [1, -1]) {
          const a0 = (s > 0 ? 0 : Math.PI) - 0.55;
          this.eventGfx.arc(wx, wy, rr, a0, a0 + 1.1);
          this.eventGfx.stroke({ width: 2.5, color: 0x7fe08a, alpha: alpha * 0.9 });
        }
        const loser = ev.targetId != null ? byId.get(ev.targetId) : undefined;
        if (loser) {
          const lx = this.visualPlayers.get(loser.id)?.x ?? loser.x;
          const ly = this.visualPlayers.get(loser.id)?.y ?? loser.y;
          const aa = Math.atan2(ly - wy, lx - wx);   // stumble trails away from the duel
          for (let i = 0; i < 3; i++) {
            const d0 = PLAYER_R + 2 + i * 4.5;
            this.eventGfx.moveTo(lx + Math.cos(aa) * d0, ly + Math.sin(aa) * d0);
            this.eventGfx.lineTo(lx + Math.cos(aa) * (d0 + 4), ly + Math.sin(aa) * (d0 + 4));
          }
          this.eventGfx.stroke({ width: 2, color: 0xff9d6b, alpha: alpha * 0.6 });
        }
        if (t < 0.55 && labelIdx < this.eventLabels.length) {
          const label = this.eventLabels[labelIdx++];
          label.text = 'READ!';
          label.position.set(wx, Math.max(18, wy - rr - 14));
          label.style.fill = 0x7fe08a;
          label.alpha = clamp(1 - t / 0.55, 0, 1);
          label.visible = true;
        }
        continue;
      }
      if (ev.type === 'chop') {
        // R28 C9: the two-stage beat cut (engine C8 emits 'chop' at the dash's
        // switch point). Anchored to the CUT POINT — the event spot, deliberately
        // not the moving carrier — so the kink in the run stays marked while the
        // carrier explodes away: a chevron across the new heading + a short flare
        // along it + a fading scuff at the spot.
        const t = ev.age / lifetime;
        const mover = ev.playerId != null ? byId.get(ev.playerId) : undefined;
        let ha = 0;
        if (mover && Math.hypot(mover.vx, mover.vy) > 5) ha = Math.atan2(mover.vy, mover.vx);
        else if (mover) { const mx = this.visualPlayers.get(mover.id)?.x ?? mover.x, my = this.visualPlayers.get(mover.id)?.y ?? mover.y; ha = Math.atan2(my - ev.y, mx - ev.x); }
        const col = 0xffd24d;
        const hx = Math.cos(ha), hy = Math.sin(ha), px = -hy, py = hx;
        // chevron (the cut) across the exit heading
        for (const s of [1, -1]) {
          this.eventGfx.moveTo(ev.x + px * s * 7 - hx * 4, ev.y + py * s * 7 - hy * 4);
          this.eventGfx.lineTo(ev.x, ev.y);
        }
        this.eventGfx.stroke({ width: 3, color: col, alpha });
        // flare along the new heading (grows then fades — the explode-away)
        const reach = 8 + t * 18;
        this.eventGfx.moveTo(ev.x + hx * 4, ev.y + hy * 4);
        this.eventGfx.lineTo(ev.x + hx * reach, ev.y + hy * reach);
        this.eventGfx.stroke({ width: 2.5, color: 0xffffff, alpha: alpha * 0.7 });
        // scuff at the cut point
        this.eventGfx.circle(ev.x, ev.y, 2.4 + t * 2.5);
        this.eventGfx.fill({ color: col, alpha: alpha * 0.5 });
        continue;
      }
      if (ev.type === 'gk_punch') {
        // Keeper punch: a short radial burst of spokes from the fists + a bright deflection streak sending
        // the ball away along its heading (or clearing toward midfield if it's momentarily slow), with a
        // ball-glint at the streak tip and a "PUNCH!" call. Anchored to the keeper (playerId). ~460ms.
        const gk = ev.playerId != null ? byId.get(ev.playerId) : undefined;
        const cx = gk ? (this.visualPlayers.get(gk.id)?.x ?? gk.x) : ev.x;
        const cy = gk ? (this.visualPlayers.get(gk.id)?.y ?? gk.y) : ev.y;
        const t = ev.age / lifetime;
        const col = this.eventColor('gk_punch');
        const r0 = PLAYER_R + 2, r1 = PLAYER_R + 6 + t * 16;
        for (let s = 0; s < 8; s++) {
          const a = (s / 8) * Math.PI * 2;
          this.eventGfx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
          this.eventGfx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
        }
        this.eventGfx.stroke({ width: 2, color: col, alpha });
        let da = Math.atan2(b.vy, b.vx);
        if (b.vx * b.vx + b.vy * b.vy < 400) da = cx < PITCH_W / 2 ? 0 : Math.PI;   // slow ball → clear to midfield
        const dfx = Math.cos(da), dfy = Math.sin(da), reach = 20 + t * 34;
        this.eventGfx.moveTo(cx + dfx * r0, cy + dfy * r0);
        this.eventGfx.lineTo(cx + dfx * reach, cy + dfy * reach);
        this.eventGfx.stroke({ width: 3, color: col, alpha });
        this.eventGfx.circle(cx + dfx * reach, cy + dfy * reach, 3);
        this.eventGfx.fill({ color: 0xffffff, alpha });
        if (labelIdx < this.eventLabels.length) {
          const label = this.eventLabels[labelIdx++];
          label.text = 'PUNCH!';
          label.position.set(cx, Math.max(18, cy - r1 - 12));
          label.style.fill = col;
          label.alpha = clamp(1 - t, 0, 1);
          label.visible = true;
        }
        continue;
      }
      if (ev.type === 'tip') {
        // Keeper (playerId) tips a shot over/around the bar for a corner. A top-down pitch can't show
        // HEIGHT, so the iconic save reads as: a reflex-save pulse on the keeper + a fingertip reach +
        // a bright deflection streak arcing out past the goal-line toward the post (a ball-glint at its
        // leading edge), plus a "TIPPED OVER!" call. Robust to the payload (falls back to the event spot).
        const t = ev.age / lifetime;
        const gk = ev.playerId != null ? byId.get(ev.playerId) : undefined;
        const cx = gk ? (this.visualPlayers.get(gk.id)?.x ?? gk.x) : ev.x;
        const cy = gk ? (this.visualPlayers.get(gk.id)?.y ?? gk.y) : ev.y;
        const toGoal = cx < PITCH_W / 2 ? -1 : 1;          // toward the keeper's own goal-line
        const cornerDir = cy < PITCH_H / 2 ? -1 : 1;        // toward the nearer post / corner
        const COL = 0x8fe3ff;
        const reach = 26 + t * 34;
        const ex = cx + toGoal * reach, ey = cy + cornerDir * (8 + t * 18);
        // the deflected ball — a curved streak that bows "up & over" before dropping out near the post
        this.eventGfx.moveTo(cx, cy);
        this.eventGfx.quadraticCurveTo(cx + toGoal * reach * 0.4, cy - cornerDir * 12, ex, ey);
        this.eventGfx.stroke({ width: 3, color: COL, alpha });
        this.eventGfx.circle(ex, ey, 3.5); this.eventGfx.fill({ color: 0xffffff, alpha });   // ball glint
        for (const s of [0.6, 1.0, 1.4]) {                  // fingertip reach off the keeper
          this.eventGfx.moveTo(cx, cy);
          this.eventGfx.lineTo(cx + toGoal * 9 * s, cy - cornerDir * 4 * s);
        }
        this.eventGfx.stroke({ width: 1.5, color: COL, alpha: alpha * 0.8 });
        this.eventGfx.circle(cx, cy, PLAYER_R + 2 + t * 10);   // reflex-save pulse
        this.eventGfx.stroke({ width: 2, color: COL, alpha: alpha * 0.7 });
        if (labelIdx < this.eventLabels.length) {
          const label = this.eventLabels[labelIdx++];
          label.text = 'TIPPED OVER!';
          label.position.set(cx, Math.max(18, cy - reach - 12));
          label.style.fill = COL;
          label.alpha = clamp(1 - t, 0, 1);
          label.visible = true;
        }
        continue;
      }
      const er = 14 + (ev.age / lifetime) * (ev.type === 'header' ? 15 : 30);
      const ec = this.eventColor(ev.type);
      this.eventGfx.circle(ev.x, ev.y, er);
      this.eventGfx.stroke({ width: ev.type === 'header' ? 3 : 2, color: ec, alpha });
      if (labelIdx < this.eventLabels.length) {
        const label = this.eventLabels[labelIdx++];
        label.text = this.eventLabel(ev.type);
        label.position.set(ev.x, Math.max(18, ev.y - er - 12));
        label.style.fill = ec;
        label.alpha = clamp(1 - ev.age / lifetime, 0, 1);
        label.visible = true;
      }
    }

    this.setPieceGfx.clear();
    this.setPieceText.visible = false;
    const restart = state.setPieceState;
    if (restart) {
      const label = this.restartLabel(restart.reason ?? restart.type);
      const teamLabel = restart.team === 'home' ? 'HOME' : 'AWAY';
      // At a free kick, mark the 9.15m (~91px in pitch coords, per the engine) legal distance — the
      // defensive WALL lines up on this ring, so the wall formation reads on screen (user ask: SEE walls).
      if (restart.type === 'free_kick') {
        this.setPieceGfx.circle(restart.spotX, restart.spotY, 91);
        this.setPieceGfx.stroke({ width: 1.5, color: 0xffffff, alpha: 0.26 });
        // highlight the defensive WALL — the players Boris flags with p.wall, lined up on the 9.15m ring
        // (the user's core "SEE wall formations" want). Cyan rings, distinct from the gold taker ring.
        // No-ops until the engine serialises `wall` into the frame (p.wall undefined → empty).
        const wall = state.players.filter(p => p.wall);
        if (wall.length) {
          for (const wp of wall) {
            this.setPieceGfx.circle(wp.x, wp.y, 12);
            this.setPieceGfx.stroke({ width: 2.5, color: 0x5cd6ff, alpha: 0.95 });
          }
          (window as unknown as { __lastWall?: unknown }).__lastWall = { n: wall.length, ids: wall.map(p => p.id), atMs: state.clockMs };   // verify hook
        }
      }
      this.setPieceGfx.circle(restart.spotX, restart.spotY, 18);
      this.setPieceGfx.stroke({ width: 3, color: restart.team === 'home' ? HOME_COLOR : AWAY_COLOR, alpha: 0.95 });
      this.setPieceGfx.circle(restart.spotX, restart.spotY, 4);
      this.setPieceGfx.fill({ color: 0xffffff, alpha: 0.95 });
      // mark the designated TAKER (who's taking the set piece) with a gold ring — completes the FK setup read
      const taker = restart.takerId != null ? byId.get(restart.takerId) : undefined;
      if (taker) {
        this.setPieceGfx.circle(taker.x, taker.y, 13);
        this.setPieceGfx.stroke({ width: 2, color: 0xffe066, alpha: 0.85 });
        (window as unknown as { __lastTaker?: unknown }).__lastTaker = { id: restart.takerId, x: Math.round(taker.x), y: Math.round(taker.y), type: restart.type };   // verify hook
      }
      this.setPieceText.text = `${label} ${teamLabel}`;
      this.setPieceText.position.set(restart.spotX, Math.max(22, restart.spotY - 30));
      this.setPieceText.anchor.set(0.5, 0.5);
      this.setPieceText.visible = true;
    }
    // headless verify hook: confirm the FK 9.15m wall ring drew with the right centre/radius (eval, no screenshot)
    (window as unknown as { __spDraw?: unknown }).__spDraw = restart
      ? { type: restart.type, wallRingDrawn: restart.type === 'free_kick', cx: restart.spotX, cy: restart.spotY, r: restart.type === 'free_kick' ? 91 : 0 }
      : null;
    // accumulate the last free kick's ring draw so a single later eval can confirm it fired (FKs are sporadic)
    if (restart?.type === 'free_kick') (window as unknown as { __lastFK?: unknown }).__lastFK = { cx: restart.spotX, cy: restart.spotY, r: 91, atMs: state.clockMs };

    // ── HUD (DOM scoreboard) ── all writes dirty-checked so nothing re-lays-out at 30-37Hz.
    if (this.hudRefs) {
      const r = this.hudRefs;
      const put = (key: string, node: HTMLElement, txt: string): void => {
        if (this.prevHud[key] !== txt) { this.prevHud[key] = txt; node.textContent = txt; }
      };
      const halfMs = (state.half ?? 1) === 1 ? state.clockMs : state.clockMs - 45 * 60 * 1000;
      const min = String(Math.floor(halfMs / 60000)).padStart(2, '0');
      const sec = String(Math.floor((halfMs % 60000) / 1000)).padStart(2, '0');
      put('home', r.home, state.homeName ?? 'HOME');
      put('away', r.away, state.awayName ?? 'AWAY');
      put('score', r.score, `${state.homeScore ?? 0} – ${state.awayScore ?? 0}`);
      put('half', r.half, `H${state.half ?? 1}`);
      put('time', r.time, `${min}:${sec}`);
      const added = state.addedTime && state.addedTimeAnnouncedMin ? `+${state.addedTimeAnnouncedMin}` : '';
      if (this.prevHud.added !== added) { this.prevHud.added = added; r.added.textContent = added; r.added.style.display = added ? '' : 'none'; }
      // 4th-official board — pop once when the added minutes are announced (not while a replay drives sync)
      const annMin = state.addedTime ? (state.addedTimeAnnouncedMin ?? 0) : 0;
      if (this.atBoardEl) {
        if (annMin > 0 && annMin !== this.prevAddedMin && !this.replayMode) {
          this.atBoardEl.innerHTML =
            '<div style="font-size:11px;letter-spacing:3px;color:#9fb3a7">ADDED TIME</div>'
            + `<div style="font-size:44px;line-height:1.1;color:#ffcf5c">+${annMin}</div>`;
          this.atBoardEl.style.display = '';
          this.atBoardHideAt = performance.now() + 4000;
        }
        this.prevAddedMin = annMin;
        if (this.atBoardEl.style.display !== 'none' && performance.now() > this.atBoardHideAt) {
          this.atBoardEl.style.display = 'none';
        }
      }
      const pct = Math.round(state.possessionPct ?? 50);
      put('shots', r.shots, `Shots ${state.homeShots ?? 0}–${state.awayShots ?? 0}`);
      put('poss', r.poss, `Poss ${pct}%`);
      // matchState is suppressed while simply "running"; the meaningful transitions (kick-off /
      // half-time / full-time) + the current restart (FREE KICK HOME…) show as a gold tag.
      const stateTag = state.matchState && state.matchState !== 'running' ? String(state.matchState).replace(/_/g, ' ').toUpperCase() : '';
      const restartTag = state.setPieceState
        ? `${this.restartLabel(state.setPieceState.reason ?? state.setPieceState.type)} ${(state.setPieceState.team ?? '').toUpperCase()}`
        : '';
      const tag = [stateTag, restartTag].filter(Boolean).join(' · ');
      if (this.prevHud.tag !== tag) { this.prevHud.tag = tag; r.state.textContent = tag; r.state.style.display = tag ? '' : 'none'; }
      // possession split — the thin strip along the scoreboard's bottom edge (home left, away right)
      const pw = `${pct}%`;
      if (this.prevHud.possW !== pw) { this.prevHud.possW = pw; r.possHome.style.width = pw; }
    }

    this.updateTicker(state);
    this.updateMomentum(state);   // PRESSURE: integrate after the ticker folds in event impulses
    this.renderStatPanel();
    this.updateMoments(state);
    // Draw the positional layer immediately ONLY when something new exists (first ingest / a just-created
    // player shape would sit at the origin for a frame otherwise). Every other sync leaves the draw to the
    // 60fps ticker (≤16ms away) — the unconditional call ran the full positional pass an extra ~35×/sec on
    // a live watch, on top of the ticker's 60.
    if (this.syncNeedsImmediateDraw) { this.syncNeedsImmediateDraw = false; this.renderFrame(); }
  }

  // Clip a team name to the HUD width, falling back to a default — shared by the HUD + the
  // goal banner + the HT/FT panel so big moments show the real club names, not 'HOME'/'AWAY'.
  private clipName(s: string | undefined, fallback: string): string {
    const n = s ?? fallback;
    return (n.length > 16 ? n.slice(0, 16) : n).toUpperCase();
  }

  private updateMoments(state: EngineState): void {
    if (!this.bannerEl || !this.panelEl) return;
    const now = performance.now();
    const hs = state.homeScore ?? 0, as = state.awayScore ?? 0;
    const hn = this.clipName(state.homeName, 'HOME'), an = this.clipName(state.awayName, 'AWAY');
    if (state.clockMs < 1500 && hs === 0 && as === 0) {
      // fresh match/restart
      this.prevHomeScore = 0; this.prevAwayScore = 0; this.prevHalf = 1; this.shownFullTime = false;
      this.panelEl.style.display = 'none';
    }
    // A seek / scrub / rewind jumps the clock (back, or far forward). Clear any showing banner/panel so nothing
    // sticks from before the jump — a "GOAL" / "HALF TIME" / "FULL TIME" now in the future or well in the past.
    const seeked = !this.replayMode && (state.clockMs < this.momentsClock - 500 || state.clockMs > this.momentsClock + 4000);
    this.momentsClock = state.clockMs;
    if (seeked) {
      if (this.bannerEl.style.display === 'block') { this.bannerEl.style.display = 'none'; this.bannerHideAt = 0; }
      if (this.panelEl.style.display === 'block') { this.panelEl.style.display = 'none'; this.panelHideAt = 0; }
      this.goalCelebStart = 0;   // let any running celebration lapse instantly on a seek (renderFrame clears the FX)
    }
    // goal banner on score change — but during a goal replay the score rewinds then plays forward;
    // track it silently (the "⚽ GOAL REPLAY" overlay is up) so we don't mis-fire "GOAL!" on the rewind.
    if (hs !== this.prevHomeScore || as !== this.prevAwayScore) {
      // Only celebrate a REAL goal: a single FORWARD increment during normal play. A seek / scrub / rewind
      // jumps the score (down on a rewind, or up by >1 when you jump across goals) — never fire "GOAL!" then,
      // and DROP any showing banner so it can't stick ("GOAL" for a goal now in the future or well in the past).
      // A goal-replay rewinds the score silently (the "⚽ GOAL REPLAY" overlay is up instead).
      const delta = (hs - this.prevHomeScore) + (as - this.prevAwayScore);
      if (!this.replayMode && delta === 1) {
        const homeScored = hs > this.prevHomeScore;
        const who = this.lastGoalScorer;   // set by updateTicker when it logs the goal event
        this.bannerEl.textContent = `GOAL!  ${who}\n${hn} ${hs} — ${as} ${an}`;
        this.bannerEl.style.whiteSpace = 'pre';
        this.bannerEl.style.color = homeScored ? '#ff8a8a' : '#9ecbff';
        this.bannerEl.style.borderColor = homeScored ? '#ff8a8a' : '#9ecbff';
        this.bannerEl.style.display = 'block';
        // re-trigger the celebratory pop (reset → reflow → re-apply so it fires on every goal)
        this.bannerEl.style.animation = 'none'; void this.bannerEl.offsetWidth;
        this.bannerEl.style.animation = 'footyGoalPop .45s cubic-bezier(.2,1.5,.45,1)';
        this.bannerHideAt = now + 4500;
        // canvas celebration (ring burst + scorer flash) + the score-bug pulse. Both here so they fire on
        // exactly the same REAL-goal condition as the banner (single forward increment, not under replay).
        this.startGoalCelebration(homeScored, now);
        this.pulseScoreBug();
      } else if (!this.replayMode && this.bannerEl.style.display === 'block') {
        this.bannerEl.style.display = 'none'; this.bannerHideAt = 0;   // a seek/rewind changed the score → clear any stale GOAL banner now
      }
      this.prevHomeScore = hs; this.prevAwayScore = as;
    }
    if (this.bannerEl.style.display === 'block' && now > this.bannerHideAt) {
      this.bannerEl.style.display = 'none';
    }
    // half-time / full-time panel
    const half = state.half ?? 1;
    const finished = state.matchState === 'finished';
    const showPanel = (title: string, sticky: boolean) => {
      const pct = (state.possessionPct ?? 50).toFixed(0);
      // Scorer list with assists, built from per-player tallies.
      const scorers = (state.players ?? [])
        .filter(p => (p.goals ?? 0) > 0)
        .sort((a, b) => (b.goals ?? 0) - (a.goals ?? 0))
        .map(p => {
          const nm = (p.name ?? '').replace(/^[HA]\d+\s*/, '');
          const g = (p.goals ?? 0) > 1 ? ` ×${p.goals}` : '';
          return `  ⚽ ${nm}${g}`;
        });
      const assists = (state.players ?? [])
        .filter(p => (p.assists ?? 0) > 0)
        .sort((a, b) => (b.assists ?? 0) - (a.assists ?? 0))
        .map(p => `  ◇ ${(p.name ?? '').replace(/^[HA]\d+\s*/, '')}${(p.assists ?? 0) > 1 ? ` ×${p.assists}` : ''}`);
      const scorerBlock = scorers.length ? `\n\nScorers\n${scorers.join('\n')}` : '';
      const assistBlock = assists.length ? `\nAssists\n${assists.join('\n')}` : '';
      this.panelEl!.textContent =
        `${title}\n\n${hn} ${hs} — ${as} ${an}\nShots  ${state.homeShots ?? 0} - ${state.awayShots ?? 0}\nPossession  ${pct}% - ${100 - Number(pct)}%${scorerBlock}${assistBlock}`;
      this.panelEl!.style.display = 'block';
      this.panelHideAt = sticky ? Infinity : now + 9000;
    };
    if (half === 2 && this.prevHalf === 1) {
      this.prevHalf = 2;
      // A forward seek into the 2nd half — OR a live-buffer rewind replaying forward across the interval
      // (replayMode) — shouldn't re-pop "HALF TIME". replayMode forces `seeked` false (line ~1137), so the
      // GOAL banner's `!this.replayMode` guard is mirrored here for the panels.
      if (!seeked && !this.replayMode) showPanel('HALF TIME', false);
    } else if (half === 1 && this.prevHalf === 2) {
      this.prevHalf = 1;   // rewound back into the 1st half → let HALF TIME fire again on forward LIVE play
    }
    if (finished && !this.shownFullTime && !this.replayMode) {
      this.shownFullTime = true;   // guarded: a rewind replaying forward to the finished edge mustn't re-pop it (fires on resumeLive)
      showPanel('FULL TIME', true);
    } else if (!finished && this.shownFullTime) {
      this.shownFullTime = false; this.panelEl.style.display = 'none'; this.panelHideAt = 0;   // rewound out of full-time → drop the sticky panel
    }
    if (this.panelEl.style.display === 'block' && now > this.panelHideAt) {
      this.panelEl.style.display = 'none';
    }
  }

  private lastClockMs = 0;
  private updateTicker(state: EngineState): void {
    if (!this.feedRowsEl) return;
    if (state.clockMs < this.lastClockMs - 1000) {
      // match restarted / rewound past the start — wipe the feed, dedup memory, scorer + the toast stack
      this.feedEntries = [];
      this.seenEventKeys.clear();
      this.lastGoalScorer = '';
      this.lastGoalScorerId = null;
      this.clearToasts();
      this.resetMatchStats(state.clockMs);
    }
    this.lastClockMs = state.clockMs;
    const notable = new Set(['goal', 'shot', 'save', 'claim', 'tip', 'foul', 'offside', 'skill', 'nutmeg', 'dragback', 'stepover', 'roulette', 'gk_punch', 'header', 'block', 'penalty', 'punch', 'yellow', 'sub', 'injury', 'assist', 'advantage', 'red', 'woodwork', 'handball']);
    for (const ev of (state.events ?? [])) {
      if (!notable.has(ev.type)) continue;
      const evClock = state.clockMs - (ev.age ?? 0);
      const key = `${ev.type}:${ev.playerId}:${Math.round(evClock / 400)}`;
      if (this.seenEventKeys.has(key)) continue;
      this.seenEventKeys.add(key);
      this.accStatEvent(ev, evClock);   // PRESSURE panel: same de-dup → counts match the feed exactly
      const half = state.half ?? 1;
      const halfMs = half === 1 ? evClock : evClock - 45 * 60 * 1000;
      const minute = Math.max(0, Math.floor(halfMs / 60000)) + (half === 2 ? 45 : 0);
      const actor = ev.playerId != null ? this.playerById.get(ev.playerId) : undefined;
      const who = actor?.name ?? '';
      const target = (ev.targetId != null ? this.playerById.get(ev.targetId) : undefined)?.name ?? '';
      if (ev.type === 'goal') { this.lastGoalScorer = who; this.lastGoalScorerId = ev.playerId ?? null; }   // banner + celebration read these
      // newest on top — a chronological feed row: minute stamp · team-coloured dot · commentary
      this.feedEntries.unshift({ minute, team: actor?.team ?? null, text: this.commentary(ev.type, who, target), goal: ev.type === 'goal' });
      // ── reporting toast (top-right) ── fires off the SAME de-duped event stream as the feed, so a toast
      // shows exactly once per event. Only the "big moment" subset gets one; pushToast no-ops under replay.
      this.maybeToast(ev, who, minute, target);
    }
    if (this.feedEntries.length > 8) this.feedEntries.length = 8;
    if (this.seenEventKeys.size > 400) this.seenEventKeys.clear();
    // dirty-checked (rebuilding the rows is a DOM replace + layout) — only when the newest event set moves.
    const key = this.feedEntries.length ? this.feedEntries.map(e => e.minute + '|' + e.text).join('¦') : '';
    if (key === this.prevFeedKey) return;
    this.prevFeedKey = key;
    if (!this.feedEntries.length) { this.feedRowsEl.innerHTML = '<div class="wf-empty">— kick-off awaited —</div>'; return; }
    const esc = (s: string): string => s.replace(/[&<>]/g, c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
    this.feedRowsEl.innerHTML = this.feedEntries.map(e => {
      const col = e.goal ? '#ffcf5c' : e.team === 'home' ? '#e63946' : e.team === 'away' ? '#4b93c9' : '#8aa0bd';
      return `<div class="wf-ev${e.goal ? ' wf-goal' : ''}"><span class="wf-t">${e.minute}'</span><span class="wf-dot" style="background:${col}"></span><span class="wf-tx">${esc(e.text)}</span></div>`;
    }).join('');
  }

  // Map a de-duped notable event to a reporting toast (the "big moments" only): goal (own-goal distinguished
  // when the engine flags it), yellow/red card, penalty awarded, substitution. 'sub' is wired ahead of the
  // engine emitting it — harmless if never fired. pushToast itself no-ops under replay.
  private maybeToast(ev: EngineState['events'][number], who: string, minute: number, target = ''): void {
    const nm = this.shortName(who);
    const m = `${minute}'`;
    const where = (ev.x != null && ev.y != null) ? ` · ${this.zoneLabel(ev.x, ev.y)}` : '';
    switch (ev.type) {
      case 'goal':    this.pushToast('⚽', ev.ownGoal ? `${m}  ${nm || 'Own goal'} (O.G.)` : `${m}  ${nm || 'Goal'}`, ev.ownGoal ? 'og' : 'goal'); break;
      case 'yellow':  this.pushToast('🟨', `${m}  ${nm}`, 'card'); break;
      case 'red':     this.pushToast('🟥', `${m}  ${nm}`, 'card'); break;
      case 'penalty': this.pushToast('❗', `${m}  Penalty awarded`, 'pen'); break;
      case 'sub':     this.pushToast('🔁', `${m}  ${nm || 'Substitution'} off`, 'sub'); break;
      // event-communication (owner: "not clear what happened — off-ball foul? advantage?"): brief
      // who/what/where popups. 'foul' names the offender + the fouled player (ev.targetId) when known;
      // an 'advantage' event reads "play on"; offside/injury name the player.
      case 'foul': {
        const vic = this.shortName(target);
        this.pushToast('⚑', `${m}  Foul — ${nm}${vic ? ' on ' + vic : ''}${where}`, 'foul'); break;
      }
      case 'advantage': this.pushToast('▶', `${m}  Advantage — ${nm ? nm + ' plays on' : 'play on'}${where}`, 'adv'); break;
      case 'offside':   this.pushToast('🚩', `${m}  Offside — ${nm}${where}`, 'offside'); break;
      case 'injury':    this.pushToast('✚', `${m}  Injury — ${nm || 'stoppage'}`, 'inj'); break;
      default: break;
    }
  }

  // brief spatial tag for an event popup ("who, what, WHERE") — thirds + penalty boxes, engine coords.
  private zoneLabel(x: number, y: number): string {
    const cy = PITCH_H / 2, inBox = Math.abs(y - cy) <= 201.5;
    if (x <= 165 && inBox) return 'left box';
    if (x >= PITCH_W - 165 && inBox) return 'right box';
    if (x < PITCH_W / 3) return 'left third';
    if (x > PITCH_W * 2 / 3) return 'right third';
    return 'midfield';
  }

  // Compact display name for a toast: prefer the parenthetical short name the frame carries
  // ("Firstname Lastname (Lastname)"), else strip a leading squad-number/team prefix.
  private shortName(raw: string): string {
    if (!raw) return '';
    const paren = raw.match(/\(([^)]+)\)/);
    return (paren ? paren[1] : raw.replace(/^[HA]?\d+\s*/, '')).trim();
  }

  private restartLabel(type: string): string {
    switch (type) {
      case 'offside': return 'OFFSIDE';
      case 'free_kick': return 'FREE KICK';
      case 'penalty': return 'PENALTY';
      case 'throw_in': return 'THROW IN';
      case 'corner': return 'CORNER';
      case 'goal_kick': return 'GOAL KICK';
      default: return type.replace(/_/g, ' ').toUpperCase();
    }
  }

  private eventLabel(type: string): string {
    switch (type) {
      case 'offside': return 'OFFSIDE';
      case 'foul': return 'FOUL';
      case 'intercept': return 'INTERCEPTION';
      case 'tackle_won': return 'TACKLE WON';
      case 'tackle_loose': return 'TACKLE LOOSE';
      case 'tackle': return 'TACKLE';
      case 'save': return 'SAVE';
      case 'claim': return 'CLAIMED';
      case 'penalty': return 'PENALTY!';
      case 'yellow': return 'YELLOW';
      case 'red': return 'RED CARD';
      case 'assist': return 'ASSIST';
      case 'advantage': return 'ADVANTAGE';
      case 'sub': return 'SUB';
      case 'injury': return 'INJURY';
      case 'goal': return 'GOAL';
      case 'shot': return 'SHOT';
      case 'header': return 'HEADER';
      case 'punch': return 'PUNCH';
      case 'woodwork': return 'WOODWORK';
      case 'dragback': return 'DRAG-BACK';
      case 'nutmeg': return 'NUTMEG!';
      case 'stepover': return 'STEP-OVER';
      case 'roulette': return 'ROULETTE';
      case 'gk_punch': return 'PUNCH!';
      case 'tip': return 'TIP OVER';
      default: return type.replace(/_/g, ' ').toUpperCase();
    }
  }

  // Turn a raw event into a line of broadcast-style commentary for the feed.
  // `who` is the actor; `target` the player acted upon (nutmeg victim, fouled man).
  // A few high-frequency events rotate through phrasings (keyed on the match minute,
  // so it's deterministic) so a run of saves/shots doesn't read identically.
  private commentary(type: string, who: string, target: string): string {
    const w = who || 'someone';
    // rotate by minute AND a per-line counter so a run of saves/shots in one minute doesn't read identically
    // (still deterministic for a given replay: same event sequence → same counter sequence; display-only)
    const pick = (arr: string[]): string => arr[Math.abs(Math.floor(this.lastClockMs / 60000) + this.commentaryNth++) % arr.length];
    switch (type) {
      case 'goal':       return pick([`⚽ GOAL! ${w} buries it!`, `⚽ GOAL! ${w} finds the net!`, `⚽ GOAL!! ${w} scores!`]);
      case 'shot':       return pick([`${w} has a crack`, `${w} lets fly`, `${w} tries his luck`]);
      case 'save':       return pick([`🧤 SAVE! ${w} denies it`, `🧤 Big stop from ${w}`, `🧤 ${w} keeps it out!`]);
      case 'tip':        return `🧤 ${w} tips it over the bar!`;
      case 'claim':      return `🧤 ${w} claims it confidently`;
      case 'punch':      return `🧤 ${w} punches clear`;
      case 'header':     return `${w} gets his head on it`;
      case 'nutmeg':     return target ? `😱 Nutmeg! ${w} slips it through ${target}` : `😱 Nutmeg by ${w}!`;
      case 'dragback':   return `${w} with a slick drag-back`;
      case 'skill':      return `${w} shows a bit of skill`;
      case 'stepover':   return `${w} dances past with a step-over`;
      case 'roulette':   return `${w} spins away — Zidane roulette!`;
      case 'gk_punch':   return `🧤 ${w} punches it clear`;
      case 'block':      return `🧱 Blocked! ${w} throws a body in the way`;
      case 'tackle_won': return `${w} wins the tackle`;
      case 'intercept':  return `${w} reads it — intercepted`;
      case 'foul':       return target ? `Foul by ${w} on ${target}` : `Foul by ${w}`;
      case 'yellow':     return `🟨 Booked — ${w}`;
      case 'red':        return `🟥 RED CARD! ${w} is off!`;
      case 'penalty':    return `❗ PENALTY!`;
      case 'offside':    return `🚩 Offside against ${w}`;
      case 'handball':   return `✋ Handball! ${w}`;
      case 'woodwork':   return `😬 Off the woodwork! ${w}`;
      case 'sub':        return `🔁 Sub — ${w} comes on`;
      case 'injury':     return `🤕 ${w} is down injured`;
      case 'assist':     return `🅰 Assist — ${w}`;
      case 'advantage':  return `Referee waves play on — advantage`;
      default:           return `${this.eventLabel(type)} ${w}`.trim();
    }
  }

  // ── PRESSURE panel: build, accumulate, animate ──────────────────────────────
  // Built DETACHED and docked into the right column by screenWatch (dockStats) — it used to float
  // fixed at top-left, where it overlapped the scoreboard and the timeline slider.
  private buildStatPanel(): void {
    const HOME_CSS = '#e63946', AWAY_CSS = '#457b9d';   // = HOME_COLOR / AWAY_COLOR
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
      this.statCells[key] = v;
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
    this.statBarHome = home; this.statBarAway = away; this.statBarWrap = wrap;
    this.statPanelEl = panel;
    // NOT appended here — screenWatch docks it (dockStats) into the right column after init.
  }

  // Tally one NEW (de-duped) notable event into the stat counters + momentum. Called from
  // updateTicker inside the seenEventKeys guard, so each event lands exactly once.
  private accStatEvent(ev: EngineState['events'][number], evClock = 0): void {
    const sideOf = (id: number | null | undefined): number => {
      const t = id != null ? this.playerById.get(id)?.team : undefined;
      return t === 'home' ? 1 : t === 'away' ? -1 : 0;
    };
    const type = ev.type;
    // xG proxy (direction-agnostic: distance to the NEAREST goal, since shots go toward a goal)
    if (type === 'shot' || type === 'goal') {
      const dy = ev.y - PITCH_H / 2;
      const d = Math.min(Math.hypot(ev.x - 0, dy), Math.hypot(ev.x - PITCH_W, dy));
      const ang = 1 - Math.min(1, Math.abs(dy) / (GOAL_W * 1.6));
      const xg = Math.max(0.01, Math.min(0.95, 1.05 * Math.exp(-d / 95) * (0.32 + 0.68 * ang)));
      const s = sideOf(ev.playerId);   // shot/goal playerId = the shooter
      if (s > 0) { this.xgH += xg; if (xg >= 0.30) this.bigH++; }
      else if (s < 0) { this.xgA += xg; if (xg >= 0.30) this.bigA++; }
      // record the shot (shot map) + a cumulative-xG timeline sample (after the tallies update)
      if (s !== 0) { this.shots.push({ x: ev.x, y: ev.y, xg, side: s, goal: type === 'goal' }); this.xgSeries.push({ t: evClock, h: this.xgH, a: this.xgA }); }
    }
    // on-target: goal → scorer side; save/tip/punch/claim → keeper side, so credit the OTHER team
    if (type === 'goal') { const s = sideOf(ev.playerId); if (s > 0) this.otH++; else if (s < 0) this.otA++; }
    else if (type === 'save' || type === 'tip' || type === 'punch' || type === 'gk_punch' || type === 'claim') {
      const k = sideOf(ev.playerId); if (k > 0) this.otA++; else if (k < 0) this.otH++;
    }
    // momentum impulse — favours the team named in the comment; skip if the side can't be resolved
    const s = sideOf(ev.playerId);
    const add = (sign: number, w: number): void => { if (sign !== 0) this.momentum += sign * w; };
    switch (type) {
      case 'goal':     add(s, 55); this.goalFlashUntil = performance.now() + 600; break;
      case 'shot':     add(s, 10); break;                                  // shooter
      case 'woodwork': add(s, 20); break;                                  // shooter (unlucky but dominant)
      case 'save': case 'tip': case 'punch': case 'gk_punch': case 'claim': add(s, 6); break; // s = keeper/defending side
      case 'block':    add(s, 6); break;                                   // blocker (defending)
      case 'penalty':  add(s, 20); break;                                  // taker/attacker
      case 'nutmeg': case 'skill': case 'dragback': case 'stepover': case 'roulette': add(s, 4); break;   // attacker flair
      case 'yellow':   add(-s, 7); break;                                  // toward the carded player's opponent
      case 'red':      add(-s, 22); break;
      case 'foul':     add(-s, 4); if (s > 0) this.foulH++; else if (s < 0) this.foulA++; break;   // playerId = fouler → favour the fouled side
      case 'handball': add(-s, 4); if (s > 0) this.foulH++; else if (s < 0) this.foulA++; break;   // offender penalised → favours the other side
      case 'offside':  add(-s, 5); if (s > 0) this.offH++; else if (s < 0) this.offA++; break;     // against the offside attacker
      default:         break;                                              // header/assist/sub/injury/advantage → neutral
    }
  }

  // Per-frame momentum integration (decay + possession/territory pull + corner detection + ease).
  // Impulses were already folded into `momentum` by accStatEvent during updateTicker.
  private updateMomentum(state: EngineState): void {
    if (this.homeAttacksX === null) {                 // derive attacking direction from the home keeper
      const gk = state.players.find(p => p.team === 'home' && p.role === 'GK');
      if (gk) this.homeAttacksX = gk.x < PITCH_W / 2 ? PITCH_W : 0;
    }
    const sp = state.setPieceState;                   // corners via set-piece transitions (clean)
    const spType = sp ? (sp.reason ?? sp.type) : null;
    if (spType === 'corner' && this.lastSetPieceType !== 'corner' && sp) {
      if (sp.team === 'home') { this.corH++; this.momentum += 9; }
      else if (sp.team === 'away') { this.corA++; this.momentum -= 9; }
    }
    this.lastSetPieceType = spType;
    const dt = Math.max(0, Math.min(100, state.clockMs - this.momPrevClock));   // own dt source
    this.momPrevClock = state.clockMs;
    this.momentum *= Math.pow(0.5, dt / 9000);        // decay toward 0 (~9s half-life)
    const poss = ((state.possessionPct ?? 50) - 50) / 50;                       // [-1,1], +home
    this.ballXEma += 0.02 * (state.ball.x - this.ballXEma);
    let terr = 0;
    if (this.homeAttacksX !== null) {
      const raw = Math.max(-1, Math.min(1, (this.ballXEma - PITCH_W / 2) / (PITCH_W / 2)));
      terr = raw * (this.homeAttacksX === PITCH_W ? 1 : -1);                    // + = home's attacking half
    }
    const target = 100 * (0.6 * poss + 0.4 * terr);
    this.momentum += 0.0008 * dt * (target - this.momentum);
    this.momentum = Math.max(-100, Math.min(100, this.momentum));
    this.displayMomentum += 0.15 * (this.momentum - this.displayMomentum);      // glide, not jitter
  }

  // Paint the stat grid (dirty-checked) + the momentum bar (width/flash only — no reflow).
  private renderStatPanel(): void {
    if (!this.statPanelEl) return;
    const set = (key: string, el: HTMLSpanElement | null, txt: string): void => {
      if (el && this.prevStatStr[key] !== txt) { el.textContent = txt; this.prevStatStr[key] = txt; }
    };
    set('ot', this.statCells.ot, `${this.otH}-${this.otA}`);
    set('xg', this.statCells.xg, `${this.xgH.toFixed(1)}-${this.xgA.toFixed(1)}`);
    set('big', this.statCells.big, `${this.bigH}-${this.bigA}`);
    set('cor', this.statCells.cor, `${this.corH}-${this.corA}`);
    set('foul', this.statCells.foul, `${this.foulH}-${this.foulA}`);
    set('off', this.statCells.off, `${this.offH}-${this.offA}`);
    const m = Math.max(-100, Math.min(100, this.displayMomentum));
    // % of the wrap (the panel is container-width now that it docks into the right column)
    const w = `${(Math.abs(m) / 100 * 50).toFixed(1)}%`;
    if (this.statBarHome) this.statBarHome.style.width = m > 0 ? w : '0%';
    if (this.statBarAway) this.statBarAway.style.width = m < 0 ? w : '0%';
    if (this.statBarWrap) {
      const flash = performance.now() < this.goalFlashUntil;
      this.statBarWrap.style.height = flash ? '16px' : '12px';
      this.statBarWrap.style.filter = flash ? 'brightness(1.7)' : 'none';
    }
  }

  // Zero everything on a match restart / replay so a fresh match starts clean.
  private resetMatchStats(clockMs: number): void {
    this.otH = this.otA = this.xgH = this.xgA = this.bigH = this.bigA = this.corH = this.corA = 0;
    this.foulH = this.foulA = this.offH = this.offA = 0;
    this.shots = []; this.xgSeries = [];
    this.momentum = 0; this.displayMomentum = 0; this.ballXEma = PITCH_W / 2;
    this.momPrevClock = clockMs; this.homeAttacksX = null; this.goalFlashUntil = 0;
    this.lastSetPieceType = null; this.prevStatStr = {};
  }

  // FM-style live player rating, ticking off the SAME model as the post-match report
  // (report.ts ratePlayer) but from the frame's running per-player stats: base 6.5, lifted by
  // attacking returns + tackles, with clean-sheet / GK-concession / result / card adjustments.
  // The frame carries no per-player passes, so the (bounded ±0.5) distribution term is dropped;
  // win/lose/conceded read the LIVE scoreline, so a rating shifts the moment the score does.
  private liveRating(p: EngineState['players'][number], homeScore: number, awayScore: number): number {
    let r = 6.5;
    r += (p.goals ?? 0) * 1.2 + (p.assists ?? 0) * 0.8 + (p.shots ?? 0) * 0.08 + (p.tackles ?? 0) * 0.06;
    const conceded = p.team === 'home' ? awayScore : homeScore;
    const ahead = p.team === 'home' ? homeScore > awayScore : awayScore > homeScore;
    const behind = p.team === 'home' ? homeScore < awayScore : awayScore < homeScore;
    const defensive = p.role === 'GK' || p.role === 'CB' || p.role === 'FB';
    if (defensive && conceded === 0) r += 0.8;
    if (p.role === 'GK') r -= conceded * 0.25;
    r += ahead ? 0.3 : (behind ? -0.3 : 0);
    r -= (p.yellow ?? 0) > 0 ? 0.3 : 0;
    r -= p.sentOff ? 2.0 : 0;
    return Math.max(1, Math.min(10, Math.round(r * 10) / 10));
  }

  // Tint a player label by its rating band — green for a strong game, amber for a poor one.
  private ratingTint(r: number): number {
    return r >= 7.5 ? 0x57e08a : r >= 6.5 ? 0xffffff : r >= 5.5 ? 0xcdd6df : 0xf3b06b;
  }

  // ── Live analysis getters (read by the app's 📊 Stats panel) ──────────────────────────
  // Every-player live rating off the latest ingested frame (same model as the on-pitch tags).
  getRatings(): { id: number; name: string; team: 'home' | 'away'; role: string; rating: number }[] {
    const s = this.lastState;
    if (!s) return [];
    return s.players.map(p => ({ id: p.id, name: p.name, team: p.team, role: p.role, rating: this.liveRating(p, s.homeScore ?? 0, s.awayScore ?? 0) }));
  }
  // The accumulated shot list (pitch xy + xG + side + goal) and the cumulative-xG timeline. Read-only
  // views — the panel renders a shot map + an xG race line from them; both reset with the match.
  getShots(): ReadonlyArray<{ x: number; y: number; xg: number; side: number; goal: boolean }> { return this.shots; }
  getXgSeries(): ReadonlyArray<{ t: number; h: number; a: number }> { return this.xgSeries; }
  // Latest team names (for the panel's home/away column headers) — off the frame, blank until known.
  getTeamNames(): { home: string; away: string } {
    const s = this.lastState as (EngineState & { homeName?: string; awayName?: string }) | null;
    return { home: s?.homeName ?? 'Home', away: s?.awayName ?? 'Away' };
  }

  private eventColor(type: string): number {
    switch (type) {
      case 'goal': return 0xffdd44;
      case 'save': return 0x44ddff;
      case 'tip': return 0x8fe3ff;     // keeper tip over the bar — bright reflex-save cyan
      case 'claim': return 0x66e0a0;   // confident catch — distinct from the reflex-save cyan
      case 'woodwork': return 0xffa033;
      case 'foul': return 0xff4444;
      case 'yellow': return 0xffd900;
      case 'red': return 0xff3030;
      case 'sub': return 0x66dd66;
      case 'injury': return 0xff8844;
      case 'offside': return 0xfff1a8;
      case 'intercept': return 0xffb347;
      case 'tackle_won': return 0x66ff99;
      case 'tackle_loose':
      case 'tackle': return 0xff6644;
      case 'shot': return 0xffffff;
      case 'header': return 0xfff1a8;
      case 'punch': return 0xff9944;
      case 'skill': return 0x7df9ff;
      case 'nutmeg': return 0xffd24d;
      case 'dragback': return 0xc9a0ff;
      case 'stepover': return 0x5cf2c0;   // teal shimmy — a cousin of the cyan skill swirl
      case 'roulette': return 0xb98cff;   // spin purple — flair, like the drag-back
      case 'gk_punch': return 0xff9944;   // keeper orange — matches the plain 'punch'
      case 'block': return 0x9aff9a;
      default: return 0xffffff;
    }
  }

  // (smoothPlayer/smoothBall removed — the per-frame exponential chase was replaced by the 60fps
  // prev→target tween in renderFrame, which gives true inter-frame motion instead of a 4fps step.)

  private drawGoal(g: Graphics, x: number, y: number, dir: number): void {
    const hw = GOAL_W / 2;
    const d = GOAL_DEPTH;
    // goal box fill — behind the goal line
    const rx = dir > 0 ? x - d : x;
    g.rect(rx, y - hw, d, GOAL_W); g.fill({ color: GOAL_COLOR, alpha: 0.08 });
    // 3 perimeter lines behind goal
    g.moveTo(x, y - hw); g.lineTo(x - dir * d, y - hw); g.stroke({ width: 2, color: 0xcccccc });
    g.moveTo(x, y + hw); g.lineTo(x - dir * d, y + hw); g.stroke({ width: 2, color: 0xcccccc });
    g.moveTo(x - dir * d, y - hw); g.lineTo(x - dir * d, y + hw); g.stroke({ width: 2, color: 0xcccccc });
    // net lines
    const netX = x - dir * 3;
    for (let ny = y - hw + 4; ny <= y + hw - 4; ny += 6) {
      g.moveTo(netX, ny); g.lineTo(netX - dir * (d - 6), ny); g.stroke({ width: 0.5, color: 0xcccccc, alpha: 0.55 });
    }
    for (let nx = netX; dir > 0 ? nx <= x - d + 2 : nx >= x + d - 2; nx -= dir * 6) {
      g.moveTo(nx, y - hw + 2); g.lineTo(nx, y + hw - 2); g.stroke({ width: 0.5, color: 0xcccccc, alpha: 0.55 });
    }
    g.circle(x, y - hw, 3.5); g.fill(GOAL_COLOR);
    g.circle(x, y + hw, 3.5); g.fill(GOAL_COLOR);
    g.circle(x, y - hw, 4); g.stroke({ width: 1, color: 0x333333 });
    g.circle(x, y + hw, 4); g.stroke({ width: 1, color: 0x333333 });
  }
  private drawGoalArea(g: Graphics, x: number): void {
    const l = x === 0 ? 0 : PITCH_W - GOAL_AREA_W;
    const t = (PITCH_H - GOAL_AREA_H) / 2;
    g.rect(l, t, GOAL_AREA_W, GOAL_AREA_H); g.stroke({ width: 2, color: LINE_COLOR });
  }

  private drawPenaltyArea(g: Graphics, x: number): void {
    const l = x === 0 ? 0 : PITCH_W - PENALTY_AREA_W;
    const t = (PITCH_H - PENALTY_AREA_H) / 2;
    g.rect(l, t, PENALTY_AREA_W, PENALTY_AREA_H); g.stroke({ width: 2, color: LINE_COLOR });
  }

  // The penalty spot + the "D" (the arc of centre-circle radius around the spot that falls OUTSIDE the box).
  // Standard pitch markings the renderer was missing — pure geometry off the existing constants.
  private drawPenaltyDetail(g: Graphics, x: number): void {
    const side = x === 0 ? 1 : -1;
    const spotX = x + side * PENALTY_AREA_W * 0.66;     // ~11m from the goal line (16.5m box)
    const cy = PITCH_H / 2;
    g.circle(spotX, cy, 2.5); g.fill(LINE_COLOR);       // penalty spot
    const dx = Math.abs((x + side * PENALTY_AREA_W) - spotX);   // spot → front edge of the box
    if (dx < CENTER_CIRCLE_R) {
      const half = Math.acos(dx / CENTER_CIRCLE_R);
      const base = x === 0 ? 0 : Math.PI;               // the D bulges toward midfield
      this.drawMarkingArc(g, spotX, cy, CENTER_CIRCLE_R, base - half, base + half);
    }
  }

  private drawMarkingArc(g: Graphics, x: number, y: number, radius: number, start: number, end: number): void {
    g.moveTo(x + Math.cos(start) * radius, y + Math.sin(start) * radius);
    g.arc(x, y, radius, start, end);
    g.stroke({ width: 2, color: LINE_COLOR });
  }

  private turnTowards(current: number, target: number, maxStep: number): number {
    const delta = Math.atan2(Math.sin(target - current), Math.cos(target - current));
    return current + clamp(delta, -maxStep, maxStep);
  }

  // F7: shortest-path angle interpolation (handles the ±π wrap) for the per-tick facing tween.
  private lerpAngle(a: number, b: number, t: number): number {
    return a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;
  }

  // The player's LERPED facing at tween fraction t — the exact angle the boot/head arrow is drawn at
  // (facingPrev → facingAngles). Single source of truth so any facing-relative decoration (the boots,
  // the chevron, the GK ready-gloves, the GK ball-held clasp) rides the SAME smoothed heading and can
  // never point backward/sideways relative to the body while the keeper tracks the ball.
  private lerpedFacing(id: number, t: number, team: 'home' | 'away'): number {
    const target = this.facingAngles.get(id) ?? (team === 'home' ? 0 : Math.PI);
    const prev = this.facingPrev.get(id) ?? target;
    return this.lerpAngle(prev, target, t);
  }

  // F7: draw the player's boot/head arrow at a given facing — called PER TICK from renderFrame (was drawn at
  // keyframe rate in sync → boots lagged a turn by up to ~250ms). Local coords; the arrow Graphics is
  // positioned at the tweened player pos by renderFrame. vp/vb are the interpolated player + ball positions.
  private drawPlayerArrow(entry: PlayerEntry, p: EngineState['players'][number], angle: number, vpx: number, vpy: number, vbx: number, vby: number): void {
    const r = DISC_R;
    const hasBall = this.lastState?.ball.controllerId === p.id;
    const heading = (p.headingAnim ?? 0) > 0;
    const knockDribble = p.dribbleType === 3;
    const diving = p.role === 'GK' && (p.diveAnim ?? 0) > 0;   // gates the GK ready-gloves (the dive body draws its own reach glove)
    const controlDx = hasBall ? vbx - vpx : 0;
    const controlDy = hasBall ? vby - vpy : 0;
    // Dirty-check: the arrow's local geometry is a pure function of (facing angle, hasBall, the ball-relative
    // control vector while carrying, header pose, knock-dribble). renderFrame still repositions arrow.position
    // every tick, so skipping the clear()+re-tessellate here when nothing changed is invisible — it just spares
    // ~22 Graphics rebuilds/rAF for a still, same-facing pitch (e.g. any pause/stoppage). Carrier + turning
    // players still redraw (their angle / ball-vector move each tick).
    if (entry.armDrawn
      && Math.abs(angle - entry.armAngle) < 0.035   // ~2° — sub-pixel at PLAYER_R scale; 0.01 was below the per-tick lerp delta, so the skip never engaged during play
      && hasBall === entry.armHasBall && heading === entry.armHeading && knockDribble === entry.armKnock && diving === entry.armDive
      && Math.abs(controlDx - entry.armCtrlX) < 0.5 && Math.abs(controlDy - entry.armCtrlY) < 0.5) return;
    entry.armDrawn = true; entry.armAngle = angle; entry.armHasBall = hasBall; entry.armDive = diving;
    entry.armHeading = heading; entry.armKnock = knockDribble; entry.armCtrlX = controlDx; entry.armCtrlY = controlDy;
    const a = entry.arrow;
    a.clear();
    const forwardX = Math.cos(angle);
    const forwardY = Math.sin(angle);
    const controlDist = Math.hypot(controlDx, controlDy);
    const feetX = hasBall && controlDist > 2 ? controlDx / controlDist : forwardX;
    const feetY = hasBall && controlDist > 2 ? controlDy / controlDist : forwardY;
    const feetSideX = -feetY;
    const feetSideY = feetX;
    const bootForward = hasBall ? Math.max(r * 0.62, Math.min(r * 0.94, controlDist - BALL_R * 0.5)) : r * 0.74;
    const bootSpread = hasBall ? BALL_R + 2.3 : r * 0.37;
    const leftBootX = feetX * bootForward + feetSideX * bootSpread;
    const leftBootY = feetY * bootForward + feetSideY * bootSpread;
    const rightBootX = feetX * bootForward - feetSideX * bootSpread;
    const rightBootY = feetY * bootForward - feetSideY * bootSpread;
    a.moveTo(feetSideX * r * 0.22, feetSideY * r * 0.22);
    a.lineTo(leftBootX, leftBootY);
    a.moveTo(-feetSideX * r * 0.22, -feetSideY * r * 0.22);
    a.lineTo(rightBootX, rightBootY);
    a.stroke({ width: 2, color: 0xffffff, alpha: 0.9 });
    a.circle(leftBootX, leftBootY, hasBall ? 2.8 : 2.4);
    a.circle(rightBootX, rightBootY, hasBall ? 2.8 : 2.4);
    a.fill({ color: 0x171717 });
    a.circle(0, 0, heading ? r * 0.47 : r * 0.41);
    a.fill({ color: 0xffdfbb });
    a.circle(0, 0, heading ? r * 0.47 : r * 0.41);
    a.stroke({ width: 1, color: 0x33261c });
    // ── facing chevron ── a small filled arrowhead at the disc edge pointing along `facing`. Augments the
    // boots/head so orientation stays legible at the smaller disc size (owner ask). Points along the facing
    // angle (forwardX/Y), NOT the boot-aim (which swings toward the ball while carrying), so it always reads
    // as "where the player is looking". Bright with a thin dark outline to pop against any shirt/turf.
    {
      const tipR = r + 3.6, baseR = r + 0.6, spread = 0.44;
      const tX = forwardX * tipR, tY = forwardY * tipR;
      const blX = Math.cos(angle + spread) * baseR, blY = Math.sin(angle + spread) * baseR;
      const brX = Math.cos(angle - spread) * baseR, brY = Math.sin(angle - spread) * baseR;
      a.moveTo(tX, tY); a.lineTo(blX, blY); a.lineTo(brX, brY); a.closePath();
      a.fill({ color: 0xffffff, alpha: 0.95 });
      a.moveTo(tX, tY); a.lineTo(blX, blY); a.lineTo(brX, brY); a.closePath();
      a.stroke({ width: 0.8, color: 0x1a1a1a, alpha: 0.85 });
    }
    // ── keeper ready-gloves ── a standing keeper (not carrying, not diving, not heading) holds two bright
    // glove pads out IN FRONT along his facing, one to each side of the chevron, with a short wrist line back
    // to the shoulders. They are built from the SAME lerped `angle` as the boots/chevron, so as the engine
    // turns the GK to track the ball the gloves rotate with him and always sit at his front — never detached,
    // never pointing backward/sideways. (When he holds the ball, the ball-held clasp cue draws the hands on
    // the ball instead, so this is suppressed via !hasBall.)
    if (p.role === 'GK' && !hasBall && !heading && !diving) {
      const gloveFwd = r * 0.98, gloveSpread = r * 0.6;
      const sideX = -forwardY, sideY = forwardX;          // facing-perpendicular (keeper's left/right)
      for (const s of [1, -1]) {
        const gx = forwardX * gloveFwd + sideX * s * gloveSpread;
        const gy = forwardY * gloveFwd + sideY * s * gloveSpread;
        // wrist/arm from the shoulder out to the glove
        a.moveTo(forwardX * r * 0.34 + sideX * s * r * 0.42, forwardY * r * 0.34 + sideY * s * r * 0.42);
        a.lineTo(gx, gy);
        a.stroke({ width: 2, color: 0xffe27a, alpha: 0.55 });
        // glove pad — matches the dive/held-ball glove palette
        a.circle(gx, gy, 2.9);
        a.fill({ color: 0xffe27a, alpha: 0.95 });
        a.circle(gx, gy, 2.9);
        a.stroke({ width: 1, color: 0x33261c, alpha: 0.85 });
      }
    }
    if (heading) {
      a.circle(forwardX * r * 1.65, forwardY * r * 1.65, r * 0.82);
      a.stroke({ width: 2, color: 0xfff1a8, alpha: 0.75 });
    }
    if (knockDribble) {
      a.moveTo(forwardX * r * 1.18 + feetSideX * r * 0.56, forwardY * r * 1.18 + feetSideY * r * 0.56);
      a.lineTo(forwardX * r * 2.0 + feetSideX * r * 0.56, forwardY * r * 2.0 + feetSideY * r * 0.56);
      a.moveTo(forwardX * r * 1.18 - feetSideX * r * 0.56, forwardY * r * 1.18 - feetSideY * r * 0.56);
      a.lineTo(forwardX * r * 2.0 - feetSideX * r * 0.56, forwardY * r * 2.0 - feetSideY * r * 0.56);
      a.stroke({ width: 2, color: 0xfff1a8, alpha: 0.8 });
    }
  }
}
