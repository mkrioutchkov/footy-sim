import { Application, Graphics, Container, Text, TextStyle } from 'pixi.js';
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
  lastDribbleType: number;
  wasSprinting: boolean;
  name: string;          // the label's base (short) name — the live rating is appended to it
  ratingShown: number;   // last rating written to the label (dirty-check; -1 = none yet)
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
  private ballBody: Graphics;
  private ballGlow: Graphics;
  private hudText: Text;
  private hudBg: Graphics;
  private tickerEl: HTMLDivElement | null = null;
  private tickerLines: string[] = [];
  private seenEventKeys: Set<string> = new Set();
  private lastGoalScorer = '';   // most recent goal-event scorer name — fed to the goal banner
  private commentaryNth = 0;     // advances per rotated commentary line so same-minute events don't repeat phrasing
  // ── live stats + momentum ("PRESSURE" panel) ── per-team tallies accumulated off the SAME
  // de-duped event loop as the feed (so a goal counts once), plus a signed momentum scalar.
  private statPanelEl: HTMLDivElement | null = null;
  private statCells: Record<'ot' | 'xg' | 'big' | 'cor', HTMLSpanElement | null> = { ot: null, xg: null, big: null, cor: null };
  private statBarHome: HTMLDivElement | null = null;   // grows right from centre (home leading)
  private statBarAway: HTMLDivElement | null = null;   // grows left from centre (away leading)
  private statBarWrap: HTMLDivElement | null = null;    // pulsed on a goal
  private prevStatStr: Record<string, string> = {};     // dirty-check so textContent isn't rewritten 60fps
  private otH = 0; private otA = 0;       // shots on target
  private xgH = 0; private xgA = 0;       // expected-goals proxy
  private bigH = 0; private bigA = 0;     // big chances (xg >= .30)
  private corH = 0; private corA = 0;     // corners (from set-piece transitions)
  private momentum = 0;                   // signed pressure, [-100 home .. +0 .. neutral], +home
  private displayMomentum = 0;            // eased toward `momentum` for a gliding bar
  private ballXEma = PITCH_W / 2;         // smoothed ball x for the territory term
  private momPrevClock = 0;               // own dt source (the ticker overwrites lastClockMs first)
  private homeAttacksX: number | null = null;   // 0 or PITCH_W — derived from the home keeper's side
  private goalFlashUntil = 0;             // performance.now() deadline for the bar pulse
  private lastSetPieceType: string | null = null;   // corner edge-detection
  private bannerEl: HTMLDivElement | null = null;
  private bannerHideAt = 0;
  private replayMode = false;            // a goal replay is driving sync() — show a REPLAY overlay, suppress the live goal banner
  private panelEl: HTMLDivElement | null = null;
  private panelHideAt = 0;
  private prevHomeScore = 0;
  private prevAwayScore = 0;
  private prevHalf = 1;
  private shownFullTime = false;
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
  private playerTargets: Map<number, { px: number; py: number; tx: number; ty: number }> = new Map();
  private ballPrev = { x: 0, y: 0, z: 0 };
  private ballTarget = { x: 0, y: 0, z: 0 };
  private segStart = 0;        // performance.now() when the latest frame was ingested
  private segDur = 250;        // measured ms between the last two frames (the tween window)
  private lastIngest = 0;      // performance.now() of the previous ingest (to measure segDur)
  private lastTickMs = 0;      // performance.now() of the previous renderFrame tick (for animTime dt)
  private interpReady = false; // a frame has been ingested → renderFrame may tween/draw
  private lastState: EngineState | null = null;   // latest frame — renderFrame reads it for ball/ring/jockey
  private lastControllerId: number | null = null;
  private prevControllerId: number | null = null;
  private animTime = 0;
  private facingAngles: Map<number, number> = new Map();
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
  private directiveMap: Map<number, string> = new Map();   // engine playerId → short active-directive label
  private showDirectives = false;

  constructor() {
    this.app = new Application();
    this.pitchContainer = new Container();
    this.playerLayer = new Container();
    this.ringGfx = new Graphics();
    this.ballBody = new Graphics();
    this.ballGlow = new Graphics();
    this.eventGfx = new Graphics();
    this.jockeyGfx = new Graphics();
    this.setPieceGfx = new Graphics();
    this.setPieceText = new Text({ text: '', style: new TextStyle({ fill: 0xffffff, fontSize: 15, fontFamily: 'monospace', fontWeight: 'bold' }) });
    this.hudText = new Text({ text: '', style: new TextStyle({ fill: 0xf2f5f7, fontSize: 17, fontFamily: 'monospace', fontWeight: 'bold' }) });
    this.hudBg = new Graphics();

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

    // pre-create trail pool
    for (let i = 0; i < TRAIL_LENGTH; i++) {
      const t = new Graphics();
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
      antialias: true, resolution: window.devicePixelRatio || 1, autoDensity: true,
    });
    if (this.destroyed) { try { this.app.destroy(true, { children: true, texture: true }); } catch { /* */ } return; }   // destroy() raced init — bail before touching the stage

    document.getElementById('app')!.appendChild(this.app.canvas);
    this.app.stage.addChild(this.pitchContainer);
    this.pitchContainer.addChild(this.playerLayer);
    this.pitchContainer.addChild(this.jockeyGfx);   // jockey/shield arcs sit just above the players
    this.pitchContainer.addChild(this.ringGfx);
    this.pitchContainer.addChild(this.ballBody);
    this.pitchContainer.addChild(this.ballGlow);
    this.pitchContainer.addChild(this.eventGfx);
    for (const label of this.eventLabels) this.pitchContainer.addChild(label);
    this.pitchContainer.addChild(this.setPieceGfx);
    this.pitchContainer.addChild(this.setPieceText);
     this.app.stage.sortableChildren = true;
    this.app.stage.addChild(this.hudBg);
    this.hudBg.zIndex = 9998;
    this.app.stage.addChild(this.hudText);
    this.hudText.zIndex = 9999;
    // commentary ticker (DOM — crisp text, fixed bottom-left)
    this.tickerEl = document.createElement('div');
    Object.assign(this.tickerEl.style, {
      position: 'fixed', left: '14px', bottom: '14px', zIndex: '20',
      fontFamily: 'monospace', fontSize: '12px', lineHeight: '1.55',
      color: '#e8edf2', background: 'rgba(8,12,20,0.72)', padding: '8px 12px',
      borderRadius: '6px', pointerEvents: 'none', whiteSpace: 'pre-wrap',
      minWidth: '210px', maxWidth: '360px',
    } as Partial<CSSStyleDeclaration>);
    this.tickerEl.textContent = '— match feed —';
    document.body.appendChild(this.tickerEl);
    // ── PRESSURE panel ── top-left gutter (the one free quadrant: HUD owns top-centre, tactics
    // owns bottom-centre, the feed owns bottom-left). A 2×2 stat micro-grid over a momentum bar.
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
      st.textContent = '@keyframes footyGoalPop{0%{transform:translateX(-50%) scale(.5);opacity:0}55%{transform:translateX(-50%) scale(1.12);opacity:1}100%{transform:translateX(-50%) scale(1);opacity:1}}';
      document.head.appendChild(st);
    }
    this.panelEl = document.createElement('div');
    Object.assign(this.panelEl.style, {
      position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
      zIndex: '29', fontFamily: 'monospace', fontSize: '15px', lineHeight: '1.8',
      color: '#e8edf2', background: 'rgba(8,12,20,0.92)', padding: '20px 34px',
      borderRadius: '10px', border: '1px solid #3a4a5f', pointerEvents: 'none',
      display: 'none', whiteSpace: 'pre', textAlign: 'center',
    } as Partial<CSSStyleDeclaration>);
    document.body.appendChild(this.panelEl);
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
    try { this.tickerEl?.remove(); } catch { /* */ }
    try { this.statPanelEl?.remove(); } catch { /* */ }
    try { this.bannerEl?.remove(); } catch { /* */ }
    try { this.panelEl?.remove(); } catch { /* */ }
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
    if (!this.destroyed && this.app.renderer) this.calcTransform();
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
    const reserveTop = 8;
    const reserveBottom = this.reservedBottom;
    const sh = this.app.screen.height - reserveTop - reserveBottom;
    // clamp to a small positive min: on a very short viewport (tall panel) sh can go <=0, which would
    // flip/vanish the pitch — keep it drawable.
    this.scale = Math.max(0.05, Math.min(sw / (PITCH_W + GOAL_DEPTH * 2), sh / (PITCH_H + 40)) * 0.92);
    this.offsetX = (sw - PITCH_W * this.scale) / 2;
    this.offsetY = reserveTop + (sh - PITCH_H * this.scale) / 2 + 10;
    this.pitchContainer.scale.set(this.scale);
    this.pitchContainer.position.set(this.offsetX, this.offsetY);
    this.hudText.position.set(sw / 2, 52);   // below the top-left controls (Back/speed/Pause) so the scoreboard isn't occluded
    this.hudText.anchor.set(0.5, 0);
    this.drawPitch();
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
    this.pitchContainer.addChild(this.ballBody);
    this.pitchContainer.addChild(this.ballGlow);
    this.pitchContainer.addChild(this.eventGfx);
    for (const label of this.eventLabels) this.pitchContainer.addChild(label);
    this.pitchContainer.addChild(this.setPieceGfx);
    this.pitchContainer.addChild(this.setPieceText);

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

    // players — tween then position body/shadow/arrow/label/dirTag (shapes were drawn in sync)
    for (const [id, tg] of this.playerTargets) {
      const entry = this.playerEntries.get(id);
      if (!entry) continue;
      const ix = lerp(tg.px, tg.tx, t);
      const iy = lerp(tg.py, tg.ty, t);
      let v = this.visualPlayers.get(id);
      if (!v) { v = { x: ix, y: iy }; this.visualPlayers.set(id, v); } else { v.x = ix; v.y = iy; }
      entry.shadow.position.set(ix, iy);
      entry.body.position.set(ix, iy);
      entry.arrow.position.set(ix, iy);
      entry.label.position.set(ix, iy + PLAYER_R + 3);
      if (entry.dirTag.visible) entry.dirTag.position.set(ix, iy + PLAYER_R + 17);
    }

    // ball — tween its position (renderFrame owns visualBall now)
    const ibx = lerp(this.ballPrev.x, this.ballTarget.x, t);
    const iby = lerp(this.ballPrev.y, this.ballTarget.y, t);
    const ibz = lerp(this.ballPrev.z, this.ballTarget.z, t);
    if (!this.visualBall) this.visualBall = { x: ibx, y: iby, z: ibz };
    else { this.visualBall.x = ibx; this.visualBall.y = iby; this.visualBall.z = ibz; }

    // ── carrier ring (rides the carrier's tweened pos + pulses on animTime) ──
    this.ringGfx.clear();
    let bylineRun = false;
    if (b.controllerId !== null) {
      const ctrl = byId.get(b.controllerId);
      if (ctrl) {
        const vc = this.visualPlayers.get(ctrl.id) ?? { x: ctrl.x, y: ctrl.y };
        const pulse = 0.25 + 0.35 * Math.sin(this.animTime * 0.08);
        const rc = ctrl.team === 'home' ? HOME_COLOR : AWAY_COLOR;
        this.ringGfx.circle(vc.x, vc.y, PLAYER_R + (ctrl.dribbleType === 3 ? 10 : 7));
        this.ringGfx.stroke({ width: ctrl.dribbleType === 3 ? 4 : 3, color: rc, alpha: ctrl.dribbleType === 3 ? Math.min(0.85, pulse + 0.25) : pulse });
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
    const arcOffset = ibz * 0.7;
    const shadowAlpha = clamp(ibz / 120, 0.05, 0.55);
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
    this.ballBody.position.set(ibx + touchX, iby + touchY - arcOffset);
    const heightRatio = clamp(ibz / 250, 0, 1);
    this.ballBody.scale.set(1 - heightRatio * 0.3);
    this.ballGlow.position.set(ibx, iby);
    this.ballGlow.clear();
    if (ibz > 5) {
      this.ballGlow.ellipse(0, 0, BALL_R * (1 + heightRatio * 0.8), BALL_R * 0.5);
      this.ballGlow.fill({ color: 0x000000, alpha: shadowAlpha });
    }
    this.ballGlow.visible = ibz > 5;

    // ── jockey / containing posture: shield arcs on the closest 1-2 pressers glued to the carrier ──
    this.jockeyGfx.clear();
    if (b.controllerId != null) {
      const carrier = byId.get(b.controllerId);
      const vc = this.visualPlayers.get(b.controllerId);
      if (carrier && vc) {
        const contenders: { x: number; y: number; d: number }[] = [];
        for (const p of state.players) {
          if (p.team === carrier.team || p.id === carrier.id) continue;
          const vp = this.visualPlayers.get(p.id);
          if (!vp) continue;
          const d = Math.hypot(vc.x - vp.x, vc.y - vp.y);
          if (d >= 1 && d <= PLAYER_R * 2.5) contenders.push({ x: vp.x, y: vp.y, d });
        }
        contenders.sort((a, c) => a.d - c.d);
        for (const c of contenders.slice(0, 2)) {
          const ang = Math.atan2(vc.y - c.y, vc.x - c.x);
          this.jockeyGfx.arc(c.x, c.y, PLAYER_R + 3, ang - 0.6, ang + 0.6);
          this.jockeyGfx.stroke({ width: 2.5, color: 0xf2c14e, alpha: 0.75 });
          this.jockeyGfx.moveTo(c.x + Math.cos(ang) * (PLAYER_R + 1), c.y + Math.sin(ang) * (PLAYER_R + 1));
          this.jockeyGfx.lineTo(c.x + Math.cos(ang) * (PLAYER_R + 5), c.y + Math.sin(ang) * (PLAYER_R + 5));
          this.jockeyGfx.stroke({ width: 1.5, color: 0xf2c14e, alpha: 0.55 });
        }
      }
    }
  };

  sync(state: EngineState): void {
    if (RENDER_DEBUG && this.animTime === 0) console.log('[HUD] first sync, state keys:', Object.keys(state).filter(k => ['homeScore','homeShots','possessionPct','clockMs','matchState'].includes(k)).map(k => `${k}=${(state as any)[k]}`).join(', '));
    // ── P0 ingest: measure the frame interval (the tween window) + arm renderFrame. animTime now advances
    // in renderFrame (per rAF) so stride/pulse/phase animations age smoothly, not in ~4fps steps.
    const nowMs = performance.now();
    this.segDur = clamp(this.lastIngest ? nowMs - this.lastIngest : 250, 60, 600);
    this.lastIngest = nowMs;
    this.segStart = nowMs;
    this.lastState = state;
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
    if (Math.hypot(b.x - vb.x, b.y - vb.y) > 160) this.ballPrev = { ...this.ballTarget };

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
    __w.__maxTrailZ = Math.max(__w.__maxTrailZ ?? 0, ...this.trailBuffer.map(p => p.z), 0);

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
        t.position.set(pt.x, pt.y - pt.z * 0.7);   // lift by the same arcOffset the ball uses → trail follows the arc
        t.clear();
        const alpha = (i / TRAIL_LENGTH) * 0.48;
        const r = BALL_R * (0.4 + (1 - i / TRAIL_LENGTH) * 0.75) * (cutbackActive ? 1.3 : 1);   // a cutback trail reads thicker
        t.circle(0, 0, r);
        t.fill({ color: cutbackActive ? CUTBACK_COLOR : curlTint(0xffdd44), alpha: cutbackActive ? Math.min(alpha * 1.8, 0.8) : alpha });
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
        this.shotTrailGfx.moveTo(a.x, a.y - a.z * 0.7);
        this.shotTrailGfx.lineTo(b2.x, b2.y - b2.z * 0.7);   // lofted shots (chips/dippers) arc with the ball
        this.shotTrailGfx.stroke({ width, color: curlTint(0xff4422), alpha });
      }
    }

    // ── players ──
    for (const p of state.players) {
      let entry = this.playerEntries.get(p.id);
      if (!entry) {
        const shortName = p.name.split('(')[1]?.replace(')', '') ?? p.name;
        // squad number (jersey-style: GK=1 … ; engine ids 0-10 home / 11-21 away) prefixed to the label
        // for legibility — "10 Messi" reads at a glance (user feedback #4: player+number legibility).
        const labelName = `${(p.id % 11) + 1} ${shortName}`;
        // a soft drop-shadow, drawn once (static) and only repositioned each frame: a squashed dark
        // ellipse offset down-right, so every player reads as a lit figure casting a shadow on the turf.
        const shadow = new Graphics();
        shadow.ellipse(PLAYER_R * 0.28, PLAYER_R * 0.42, PLAYER_R * 1.02, PLAYER_R * 0.62);
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
          drawn: false,
          wasSliding: false,
          wasDiving: false,
          hadBall: false,
          slideAngle: p.team === 'home' ? 0 : Math.PI,
          diveAngle: p.team === 'home' ? Math.PI : 0,
          lastDribbleType: p.dribbleType,
          wasSprinting: false,
        };
        this.playerEntries.set(p.id, entry);
      }

      const color = p.role === 'GK'
        ? (p.team === 'home' ? HOME_GK_COLOR : AWAY_GK_COLOR)
        : (p.team === 'home' ? HOME_COLOR : AWAY_COLOR);
      const hasBall = b.controllerId === p.id;
      const r = PLAYER_R;
      // P0: store this player's prev→target for the 60fps tween (snap a teleport so we don't slide across
      // the pitch). vp = the CURRENT interpolated pos — renderFrame owns the actual position.set; vp is used
      // here only for shape references (dive reach, boot-toward-ball direction).
      const vp = this.visualPlayers.get(p.id) ?? { x: p.x, y: p.y };
      if (!this.visualPlayers.has(p.id)) this.visualPlayers.set(p.id, { x: p.x, y: p.y });
      let tg = this.playerTargets.get(p.id);
      if (!tg) { tg = { px: p.x, py: p.y, tx: p.x, ty: p.y }; this.playerTargets.set(p.id, tg); }
      else { tg.px = vp.x; tg.py = vp.y; tg.tx = p.x; tg.ty = p.y; if (Math.hypot(p.x - vp.x, p.y - vp.y) > 120) { tg.px = p.x; tg.py = p.y; } }
      const diving = p.role === 'GK' && (p.diveAnim ?? 0) > 0;
      const sliding = !diving && (p.tackleAnim ?? 0) > 0;
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
          const angle = entry.slideAngle;
          entry.body.rotation = angle;
          if (p.slide) {
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

      // arrow — redraw at relative coords (positioned in renderFrame)
      entry.arrow.clear();
      // smooth facing: update angle when moving fast enough, otherwise scan toward ball
      const MIN_SPEED = 8;
      let angle = this.facingAngles.get(p.id);
      if (angle === undefined) {
        angle = p.team === 'home' ? 0 : Math.PI;
      }
      if (p.facing !== undefined) {
        if (b.controllerId === p.id && this.prevControllerId !== p.id) {
          // snap facing when player just received the ball
          angle = p.facing;
        } else {
          angle = this.turnTowards(angle, p.facing, Math.PI / 18);
        }
      } else if (speed > MIN_SPEED) {
        const newAngle = Math.atan2(p.vy, p.vx);
        angle = this.turnTowards(angle, newAngle, Math.PI / 24);
      } else {
        const lookAngle = Math.atan2(state.ball.y - p.y, state.ball.x - p.x);
        angle = this.turnTowards(angle, lookAngle, Math.PI / 60);
      }
      this.facingAngles.set(p.id, angle);
      // Diagnose unexpected facing jumps even though ordinary turns are capped (debug-only —
      // skips a per-player map get/set every frame in normal play).
      if (RENDER_DEBUG) {
        const prevA = this.prevFacingAngles.get(p.id);
        if (prevA !== undefined) {
          const aDiff = Math.abs(angle - prevA);
          const na = aDiff > Math.PI ? 2*Math.PI - aDiff : aDiff;
          if (na > Math.PI * 0.7) console.warn(`[facing_flicker] player ${p.id} (${p.role}) angle jumped ${Math.round(na * 180 / Math.PI)} deg - speed=${Math.round(speed)}`);
        }
        this.prevFacingAngles.set(p.id, angle);
      }
      const heading = (p.headingAnim ?? 0) > 0;
      const forwardX = Math.cos(angle);
      const forwardY = Math.sin(angle);
      const controlDx = hasBall ? vb.x - vp.x : 0;
      const controlDy = hasBall ? vb.y - vp.y : 0;
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
      entry.arrow.moveTo(feetSideX * r * 0.22, feetSideY * r * 0.22);
      entry.arrow.lineTo(leftBootX, leftBootY);
      entry.arrow.moveTo(-feetSideX * r * 0.22, -feetSideY * r * 0.22);
      entry.arrow.lineTo(rightBootX, rightBootY);
      entry.arrow.stroke({ width: 2, color: 0xffffff, alpha: 0.9 });
      entry.arrow.circle(leftBootX, leftBootY, hasBall ? 2.8 : 2.4);
      entry.arrow.circle(rightBootX, rightBootY, hasBall ? 2.8 : 2.4);
      entry.arrow.fill({ color: 0x171717 });
      // Top-down head stays centered inside the team marker; boots indicate possession.
      entry.arrow.circle(0, 0, heading ? r * 0.47 : r * 0.41);
      entry.arrow.fill({ color: 0xffdfbb });
      entry.arrow.circle(0, 0, heading ? r * 0.47 : r * 0.41);
      entry.arrow.stroke({ width: 1, color: 0x33261c });
      if (heading) {
        entry.arrow.circle(forwardX * r * 1.65, forwardY * r * 1.65, r * 0.82);
        entry.arrow.stroke({ width: 2, color: 0xfff1a8, alpha: 0.75 });
      }
      if (knockDribble) {
        entry.arrow.moveTo(forwardX * r * 1.18 + feetSideX * r * 0.56, forwardY * r * 1.18 + feetSideY * r * 0.56);
        entry.arrow.lineTo(forwardX * r * 2.0 + feetSideX * r * 0.56, forwardY * r * 2.0 + feetSideY * r * 0.56);
        entry.arrow.moveTo(forwardX * r * 1.18 - feetSideX * r * 0.56, forwardY * r * 1.18 - feetSideY * r * 0.56);
        entry.arrow.lineTo(forwardX * r * 2.0 - feetSideX * r * 0.56, forwardY * r * 2.0 - feetSideY * r * 0.56);
        entry.arrow.stroke({ width: 2, color: 0xfff1a8, alpha: 0.8 });
      }

      // live rating ticks beside the name (dirty-checked — the value only moves on a stat/score change).
      // label + dirTag are positioned in renderFrame (they ride the tweened player position).
      const rt = this.liveRating(p, state.homeScore ?? 0, state.awayScore ?? 0);
      if (rt !== entry.ratingShown) {
        entry.ratingShown = rt;
        entry.label.text = `${entry.name} ${rt.toFixed(1)}`;
        entry.label.tint = this.ratingTint(rt);
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
      const lifetime = ev.type === 'pass' ? 700 : ev.type === 'header' ? 600 : ev.type === 'nutmeg' ? 1000 : ev.type === 'tip' ? 1600 : skillLike ? 650 : 2200;
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

    // ── HUD ──
    const halfMs = (state.half ?? 1) === 1 ? state.clockMs : state.clockMs - 45 * 60 * 1000;
    const min = String(Math.floor(halfMs / 60000)).padStart(2, '0');
    const sec = String(Math.floor((halfMs % 60000) / 1000)).padStart(2, '0');
    const sl = (state.speed ?? 1) >= 1 ? `${state.speed ?? 1}x` : `${(state.speed ?? 1).toFixed(1)}x`;
    const pct = (state.possessionPct ?? 50).toFixed(0);
    const restartHud = state.setPieceState
      ? `    ${this.restartLabel(state.setPieceState.reason ?? state.setPieceState.type)} ${(state.setPieceState.team ?? '').toUpperCase()}`
      : '';
    const addedTag = state.addedTime && state.addedTimeAnnouncedMin ? ` +${state.addedTimeAnnouncedMin}` : '';
    const hn = this.clipName(state.homeName, 'HOME');
    const an = this.clipName(state.awayName, 'AWAY');
    // matchState is suppressed while simply "running" (redundant + widened the line off-screen); the
    // meaningful transitions (kick-off / half-time / full-time …) still show.
    const stateTag = state.matchState && state.matchState !== 'running' ? `    ${state.matchState}` : '';
    this.hudText.text = `${hn} ${state.homeScore ?? 0}-${state.awayScore ?? 0} ${an}    H${state.half ?? 1} ${min}:${sec}${addedTag} [${sl}]    Shots ${state.homeShots ?? 0}-${state.awayShots ?? 0}    Poss ${pct}%${stateTag}${restartHud}`;
    this.hudText.visible = true;
    this.hudBg.clear();
    const hudW = this.hudText.width;
    this.hudBg.roundRect(this.hudText.position.x - hudW / 2 - 14, this.hudText.position.y - 4, hudW + 28, this.hudText.height + 10, 8);
    this.hudBg.fill({ color: 0x0a0f17, alpha: 0.78 });
    // possession bar — a thin top-edge strip splitting home (left) vs away (right) by possession share
    const sw = this.app.screen.width;
    const homeW = Math.max(0, Math.min(1, (state.possessionPct ?? 50) / 100)) * sw;
    this.hudBg.rect(0, 0, homeW, 5); this.hudBg.fill({ color: HOME_COLOR, alpha: 0.92 });
    this.hudBg.rect(homeW, 0, sw - homeW, 5); this.hudBg.fill({ color: AWAY_COLOR, alpha: 0.92 });

    this.updateTicker(state);
    this.updateMomentum(state);   // PRESSURE: integrate after the ticker folds in event impulses
    this.renderStatPanel();
    this.updateMoments(state);
    // Draw the positional layer once immediately (at t≈0) so the just-created shapes don't sit at the
    // origin for a frame before the ticker's first renderFrame — then the 60fps ticker takes over.
    this.renderFrame();
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
    // goal banner on score change — but during a goal replay the score rewinds then plays forward;
    // track it silently (the "⚽ GOAL REPLAY" overlay is up) so we don't mis-fire "GOAL!" on the rewind.
    if (hs !== this.prevHomeScore || as !== this.prevAwayScore) {
      if (this.replayMode) {
        this.prevHomeScore = hs; this.prevAwayScore = as;
      } else {
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
        this.prevHomeScore = hs; this.prevAwayScore = as;
      }
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
      showPanel('HALF TIME', false);
    }
    if (finished && !this.shownFullTime) {
      this.shownFullTime = true;
      showPanel('FULL TIME', true);
    }
    if (this.panelEl.style.display === 'block' && now > this.panelHideAt) {
      this.panelEl.style.display = 'none';
    }
  }

  private lastClockMs = 0;
  private updateTicker(state: EngineState): void {
    if (!this.tickerEl) return;
    if (state.clockMs < this.lastClockMs - 1000) {
      // match restarted
      this.tickerLines = [];
      this.seenEventKeys.clear();
      this.lastGoalScorer = '';
      this.resetMatchStats(state.clockMs);
    }
    this.lastClockMs = state.clockMs;
    const notable = new Set(['goal', 'shot', 'save', 'claim', 'tip', 'foul', 'offside', 'skill', 'nutmeg', 'dragback', 'header', 'block', 'penalty', 'punch', 'yellow', 'sub', 'injury', 'assist', 'advantage', 'red', 'woodwork', 'handball']);
    for (const ev of (state.events ?? [])) {
      if (!notable.has(ev.type)) continue;
      const evClock = state.clockMs - (ev.age ?? 0);
      const key = `${ev.type}:${ev.playerId}:${Math.round(evClock / 400)}`;
      if (this.seenEventKeys.has(key)) continue;
      this.seenEventKeys.add(key);
      this.accStatEvent(ev);   // PRESSURE panel: same de-dup → counts match the feed exactly
      const half = state.half ?? 1;
      const halfMs = half === 1 ? evClock : evClock - 45 * 60 * 1000;
      const minute = Math.max(0, Math.floor(halfMs / 60000)) + (half === 2 ? 45 : 0);
      const who = (ev.playerId != null ? this.playerById.get(ev.playerId) : undefined)?.name ?? '';
      const target = (ev.targetId != null ? this.playerById.get(ev.targetId) : undefined)?.name ?? '';
      if (ev.type === 'goal') this.lastGoalScorer = who;   // banner reads this (no fragile line-parsing)
      this.tickerLines.unshift(`${String(minute).padStart(2)}' ${this.commentary(ev.type, who, target)}`);
    }
    if (this.tickerLines.length > 5) this.tickerLines.length = 5;
    if (this.seenEventKeys.size > 400) this.seenEventKeys.clear();
    this.tickerEl.textContent = this.tickerLines.length ? this.tickerLines.join('\n') : '— match feed —';
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
  private buildStatPanel(): void {
    const HOME_CSS = '#e63946', AWAY_CSS = '#457b9d';   // = HOME_COLOR / AWAY_COLOR
    const panel = document.createElement('div');
    Object.assign(panel.style, {
      position: 'fixed', top: '72px', left: '14px', zIndex: '20', width: '230px',
      padding: '8px 10px', boxSizing: 'border-box', fontFamily: 'monospace', fontSize: '12px',
      lineHeight: '1.5', color: '#e8edf2', background: 'rgba(8,12,20,0.72)', borderRadius: '6px',
      pointerEvents: 'none',
    } as Partial<CSSStyleDeclaration>);
    const grid = document.createElement('div');
    Object.assign(grid.style, { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1px 10px', marginBottom: '6px' } as Partial<CSSStyleDeclaration>);
    const cell = (label: string, key: 'ot' | 'xg' | 'big' | 'cor'): HTMLDivElement => {
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
    document.body.appendChild(panel);
  }

  // Tally one NEW (de-duped) notable event into the stat counters + momentum. Called from
  // updateTicker inside the seenEventKeys guard, so each event lands exactly once.
  private accStatEvent(ev: EngineState['events'][number]): void {
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
    }
    // on-target: goal → scorer side; save/tip/punch/claim → keeper side, so credit the OTHER team
    if (type === 'goal') { const s = sideOf(ev.playerId); if (s > 0) this.otH++; else if (s < 0) this.otA++; }
    else if (type === 'save' || type === 'tip' || type === 'punch' || type === 'claim') {
      const k = sideOf(ev.playerId); if (k > 0) this.otA++; else if (k < 0) this.otH++;
    }
    // momentum impulse — favours the team named in the comment; skip if the side can't be resolved
    const s = sideOf(ev.playerId);
    const add = (sign: number, w: number): void => { if (sign !== 0) this.momentum += sign * w; };
    switch (type) {
      case 'goal':     add(s, 55); this.goalFlashUntil = performance.now() + 600; break;
      case 'shot':     add(s, 10); break;                                  // shooter
      case 'woodwork': add(s, 20); break;                                  // shooter (unlucky but dominant)
      case 'save': case 'tip': case 'punch': case 'claim': add(s, 6); break; // s = keeper/defending side
      case 'block':    add(s, 6); break;                                   // blocker (defending)
      case 'penalty':  add(s, 20); break;                                  // taker/attacker
      case 'nutmeg': case 'skill': case 'dragback': add(s, 4); break;      // attacker flair
      case 'yellow':   add(-s, 7); break;                                  // toward the carded player's opponent
      case 'red':      add(-s, 22); break;
      case 'foul':     add(-s, 4); break;                                  // playerId = fouler → favour the fouled side
      case 'handball': add(-s, 4); break;                                  // offender penalised → favours the other side
      case 'offside':  add(-s, 5); break;                                  // against the offside attacker
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
    const HALF = 105;                                  // panel inner width 210 → half 105
    const m = Math.max(-100, Math.min(100, this.displayMomentum));
    const w = Math.abs(m) / 100 * HALF;
    if (this.statBarHome) this.statBarHome.style.width = `${m > 0 ? w : 0}px`;
    if (this.statBarAway) this.statBarAway.style.width = `${m < 0 ? w : 0}px`;
    if (this.statBarWrap) {
      const flash = performance.now() < this.goalFlashUntil;
      this.statBarWrap.style.height = flash ? '16px' : '12px';
      this.statBarWrap.style.filter = flash ? 'brightness(1.7)' : 'none';
    }
  }

  // Zero everything on a match restart / replay so a fresh match starts clean.
  private resetMatchStats(clockMs: number): void {
    this.otH = this.otA = this.xgH = this.xgA = this.bigH = this.bigA = this.corH = this.corA = 0;
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
}
