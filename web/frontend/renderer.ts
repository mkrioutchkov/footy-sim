import { Application, Graphics, Container, Text, TextStyle } from 'pixi.js';
import { cappedResolution } from './util';
import {
  PITCH_W, PITCH_H, PLAYER_R, BALL_R,
  HOME_COLOR, AWAY_COLOR, HOME_GK_COLOR, AWAY_GK_COLOR,
  GOAL_DEPTH,
  clamp, lerp,
} from './constants';
import type { EngineState } from './types';
import {
  TRAIL_LENGTH, DISC_R, PLAYER_SNAP_DIST,
  CARRY_MAGNET_MAX_OFFSET, CARRY_MAGNET_CHASE_RATE, CARRY_MAGNET_MAX_CHASE_MS,
  RENDER_DEBUG,
} from './render/constants';
import type { PlayerEntry } from './render/types';
import { drawPitchMarkings } from './render/pitch';
import { drawPlayerBody, drawPlayerArrow } from './render/players';
import { drawEventOverlays, drawSetPiece } from './render/events';
import { MatchStats, liveRating } from './render/stats';
import type { HudRefs } from './render/hud';
import {
  buildHud, buildFeed, buildGoalBanner, injectOverlayKeyframes,
  buildToastStack, buildMomentPanel, buildAddedTimeBoard,
} from './render/hud';
import type { CommentaryCounter } from './render/labels';
import { clipName, zoneLabel, shortName, restartLabel, commentary, ratingTint } from './render/labels';

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
  private hudRefs: HudRefs | null = null;
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
  private lastGoalOwn = false;   // most recent goal-event ownGoal flag — the banner must not celebrate the defender
  private commentaryCounter: CommentaryCounter = { n: 0 };   // advances per rotated commentary line so same-minute events don't repeat phrasing
  // ── live stats + momentum ("PRESSURE" panel) ── the whole subsystem (tallies, xG/shot series, the
  // momentum integrator and its panel) lives in render/stats.ts. The renderer owns one instance, feeds it
  // the SAME de-duped event stream as the match feed, and reads back the panel node, the attacking
  // direction and the shot/xG series.
  private stats = new MatchStats();
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
  // ── carried-ball magnetization ── (Round-35; ported from the standalone replay viewer, commit 4513d5e,
  // whose forensics are written up in tools/replay/README.md). The engine's carry glue is a rate-capped
  // follower, not a rigid attachment: it closes each knock-touch over 2-4 ticks (~65ms — see the maxStep
  // cap in engine/engine_physics.cpp), so a whole 0.25-0.5m dart can land INSIDE one broadcast interval,
  // and every interval above 1x speed is longer than the dart. World-tweening the ball toward that sample
  // while the CARRIER is drawn through the EMA-smoothed player tween beside it renders the dart as a pop
  // at the feet (owner, on the template: "the ball seems to teleport a tiny amount while at the feet of
  // the player"). When both ends of a segment agree on the controller, the ball is instead drawn relative
  // to the carrier's SMOOTHED body with the foot OFFSET lerped: the dart spreads across the segment and
  // the ball stays glued to the moving man. magnetCtrl is the carrier this segment is magnetized to, or
  // null for the plain world tween (ball in flight, control CHANGING this segment, or a snapped segment).
  private magnetCtrl: number | null = null;
  private magnetPrevOffX = 0; private magnetPrevOffY = 0;      // ball-minus-carrier as DRAWN at the segment start
  private magnetTargetOffX = 0; private magnetTargetOffY = 0;  // ball-minus-carrier the engine reports at the segment end
  private magnetClockMs = 0;                                   // previous frame's match clock (the chase budget is MATCH time, not wall time)
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
    const hud = buildHud();
    this.hudEl = hud.el; this.hudRefs = hud.refs;
    // commentary ticker (DOM — crisp text, fixed bottom-left; styled from styles.css like the other panels)
    const feed = buildFeed();
    this.tickerEl = feed.el;
    this.feedRowsEl = feed.rows;
    // ── PRESSURE panel ── built detached; screenWatch docks it into the right column via dockStats()
    // (it used to float top-left over the scoreboard + timeline).
    this.stats.buildPanel();
    // goal banner (center) and half/full-time stats panel
    this.bannerEl = buildGoalBanner();
    injectOverlayKeyframes();
    this.toastEl = buildToastStack();
    this.positionToasts();
    this.panelEl = buildMomentPanel();
    this.atBoardEl = buildAddedTimeBoard();
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
    try { this.stats.statPanelEl?.remove(); } catch { /* */ }   // may be docked inside the tactics panel — remove() is safe either way
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
    if (this.stats.statPanelEl && !this.destroyed) host.appendChild(this.stats.statPanelEl);
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
    drawPitchMarkings(g);
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
    this.magnetCtrl = null;   // no previous frame to agree with → the first ingest after a reset world-tweens
    this.magnetClockMs = 0;
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

    // ── players, pass 1: advance each smoothed visual position ──
    // Round-35: split out of the draw pass below so the CARRIER's smoothed body exists before the ball is
    // tweened — a magnetized ball is drawn relative to it. The two passes preserve both of the orderings
    // this loop already owed: the EMA is stepped exactly ONCE per tick (here), and the boot-aim redraw
    // still sees the CURRENT tick's ball (pass 2, after the ball tween — the F7 fix).
    // Iterate .values() (id lives on the record) so the Map iterator doesn't allocate a [k,v] tuple per rAF.
    for (const tg of this.playerTargets.values()) {
      if (!this.playerEntries.has(tg.id)) continue;
      const ix = lerp(tg.px, tg.tx, t);
      const iy = lerp(tg.py, tg.ty, t);
      let v = this.visualPlayers.get(tg.id);
      // Round-27 COMMIT 8b: a light EMA pass over the interpolated position (like
      // the renderFacing damping) so residual telemetry wobble reads as a smooth
      // curve, not per-keyframe kinks. A big step (teleport/seek/restart) snaps
      // through instead of gliding, mirroring the ball's jump handling.
      if (!v) { v = { x: ix, y: iy }; this.visualPlayers.set(tg.id, v); }
      else if (Math.abs(ix - v.x) > 40 || Math.abs(iy - v.y) > 40) { v.x = ix; v.y = iy; }
      else { v.x += (ix - v.x) * 0.4; v.y += (iy - v.y) * 0.4; }
    }

    // ball — tween its position BEFORE the sprite/boot pass (renderFrame owns visualBall) so the player
    // loop aims boots at the CURRENT-tick ball (F7 review: it was reading the previous tick's visualBall
    // → a ~16ms boot-aim lag).
    // Three paths, in priority order:
    //  • MAGNETIZED (Round-35): both ends of the segment agree on the controller, so the ball rides the
    //    carrier's smoothed body and only the foot OFFSET is lerped — the engine's rate-capped knock dart
    //    spreads across the segment instead of popping at the feet inside it. sync() owns the gate.
    //  • curve-following: in free flight, cubic-Hermite through the engine's ball velocity at each endpoint
    //    so a curling flight follows its arc instead of the straight chord between the two samples;
    //  • plain linear lerp: a straight pass, a released/loose ball or a snapped segment.
    // A magnetized segment can never also be a curve segment (ballCurveActive requires no controller), so
    // the ordering is a readability choice, not a tie-break.
    let ibx: number, iby: number;
    const magnetVis = this.magnetCtrl !== null ? this.visualPlayers.get(this.magnetCtrl) : undefined;
    if (magnetVis) {
      ibx = magnetVis.x + lerp(this.magnetPrevOffX, this.magnetTargetOffX, t);
      iby = magnetVis.y + lerp(this.magnetPrevOffY, this.magnetTargetOffY, t);
    } else if (this.ballCurveActive) {
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

    // ── players, pass 2: position body/shadow/arrow/label/dirTag (shapes were drawn in sync) ──
    // Reads only the positions pass 1 advanced — never steps the EMA again (double-stepping it would
    // change every player's rendered path, not just the ball's).
    for (const tg of this.playerTargets.values()) {
      const id = tg.id;
      const entry = this.playerEntries.get(id);
      const v = this.visualPlayers.get(id);
      if (!entry || !v) continue;
      const sx = v.x, sy = v.y;
      entry.shadow.position.set(sx, sy);
      entry.body.position.set(sx, sy);
      entry.arrow.position.set(sx, sy);
      // F7: redraw the boot/head arrow at the LERPED facing every tick (was keyframe-rate → boots lagged turns).
      const pp = byId.get(id);
      if (pp) drawPlayerArrow(entry, pp, this.lerpedFacing(id, t, pp.team), sx, sy, ibx, iby, this.lastState);
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
        if (this.stats.homeAttacksX !== null) {
          const attackX = ctrl.team === 'home' ? this.stats.homeAttacksX : (this.stats.homeAttacksX === 0 ? PITCH_W : 0);
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
    if (this.stats.homeAttacksX !== null) {
      const homeGoalMouth = this.stats.homeAttacksX;   // the goal HOME attacks toward = where a home goal is scored
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
    // The controller the PREVIOUS ingested frame reported — read before the change-detect below overwrites
    // it. The magnetization gate needs BOTH ends of this segment to name the same carrier.
    const prevFrameCtrl = this.lastControllerId;
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
    // ── carried-ball magnetization gate (Round-35) ── decide here, apply in renderFrame (see magnetCtrl).
    // Magnetize ONLY a segment that is unambiguously one man carrying the ball across both samples:
    //  • a controller at BOTH ends, and the SAME one — the segment where control changes (a receipt, a
    //    release, a tackle) must still slide in world space, which is what sells the change of ownership;
    //  • no ball snap this segment — a kickoff / restart / seek / sharp redirect is a CUT, and gluing the
    //    ball onto a body through one would drag it across the pitch instead of cutting;
    //  • the carrier is actually being tweened and drawn (a sent-off man is dropped from playerTargets and
    //    parked off the touchline — the template's "carrier is on the pitch" guard), and he did not
    //    teleport himself this segment, or the offset we anchor on is meaningless;
    //  • the ball reads as AT HIS FEET at both ends. Past the engine's own carry/reset distance this is a
    //    release the controller flag has not caught up with, and the honest path is the world tween.
    // The anchor is deliberately the ball as DRAWN (visualBall) against the carrier as DRAWN, so t=0 is
    // exactly where the previous tick left the ball: magnetization can never introduce a seam of its own.
    this.magnetCtrl = null;
    const magCarrier = b.controllerId !== null && b.controllerId === prevFrameCtrl && !snapped
      ? byId.get(b.controllerId) : undefined;
    const magVis = magCarrier && !magCarrier.sentOff && this.playerTargets.has(magCarrier.id)
      ? this.visualPlayers.get(magCarrier.id) : undefined;
    if (magCarrier && magVis && Math.hypot(magCarrier.x - magVis.x, magCarrier.y - magVis.y) <= PLAYER_SNAP_DIST) {
      const pOffX = vb.x - magVis.x, pOffY = vb.y - magVis.y;          // where the ball is DRAWN, off the drawn carrier
      let tOffX = b.x - magCarrier.x, tOffY = b.y - magCarrier.y;      // where the engine puts it, off the real carrier
      if (Math.hypot(pOffX, pOffY) <= CARRY_MAGNET_MAX_OFFSET && Math.hypot(tOffX, tOffY) <= CARRY_MAGNET_MAX_OFFSET) {
        // Rate-cap the chase (CARRY_MAGNET_CHASE_RATE): whatever the segment cannot legitimately close
        // is left for the next one, which re-anchors on the drawn ball again — a follower, like the
        // engine's own glue, rather than a one-segment ramp that renders this renderer's anchoring lag.
        const dOffX = tOffX - pOffX, dOffY = tOffY - pOffY;
        const dOff = Math.hypot(dOffX, dOffY);
        const budget = CARRY_MAGNET_CHASE_RATE * clamp(state.clockMs - this.magnetClockMs, 0, CARRY_MAGNET_MAX_CHASE_MS) / 1000;
        if (dOff > budget) { const k = budget / dOff; tOffX = pOffX + dOffX * k; tOffY = pOffY + dOffY * k; }
        this.magnetCtrl = magCarrier.id;
        this.magnetPrevOffX = pOffX; this.magnetPrevOffY = pOffY;
        this.magnetTargetOffX = tOffX; this.magnetTargetOffY = tOffY;
      }
    }
    this.magnetClockMs = state.clockMs;
    (window as unknown as { __ballMagnet?: number | null }).__ballMagnet = this.magnetCtrl;   // verify hook

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
          armDrawn: false, armAngle: 0, armCtrlX: 0, armCtrlY: 0, armHasBall: false, armHeading: false, armKnock: false, armDive: false, armGk: false,
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
      // P0: store this player's prev→target for the 60fps tween (snap a teleport so we don't slide across
      // the pitch). vp = the CURRENT interpolated pos — renderFrame owns the actual position.set; vp is used
      // here only for shape references (dive reach, boot-toward-ball direction).
      const vp = this.visualPlayers.get(p.id) ?? { x: p.x, y: p.y };
      if (!this.visualPlayers.has(p.id)) this.visualPlayers.set(p.id, { x: p.x, y: p.y });
      let tg = this.playerTargets.get(p.id);
      if (!tg) { tg = { id: p.id, px: p.x, py: p.y, tx: p.x, ty: p.y }; this.playerTargets.set(p.id, tg); }
      else { tg.px = vp.x; tg.py = vp.y; tg.tx = p.x; tg.ty = p.y; if (Math.hypot(p.x - vp.x, p.y - vp.y) > PLAYER_SNAP_DIST) { tg.px = p.x; tg.py = p.y; } }
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
        drawPlayerBody(entry, p, { color, diving, sliding, knockDribble, sprinting, hasBall, speed, vp });
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
      const rt = liveRating(p, state.homeScore ?? 0, state.awayScore ?? 0);
      // Condition marker on the name label — sent-off / injured / booked. All three ride on the frame
      // (types.ts Player) but were previously invisible on the pitch (they only nudged the rating). A
      // sent-off man's label also reds. Priority red > injury > yellow; folded into the label dirty-check.
      const status = p.sentOff ? '🟥 ' : p.injured ? '🤕 ' : (p.yellow ?? 0) > 0 ? '🟨 ' : '';
      if (rt !== entry.ratingShown || status !== entry.statusShown) {
        entry.ratingShown = rt; entry.statusShown = status;
        entry.label.text = `${status}${entry.name} ${rt.toFixed(1)}`;
        entry.label.tint = p.sentOff ? 0xff6b6b : ratingTint(rt);
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
    drawEventOverlays({ gfx: this.eventGfx, labels: this.eventLabels, events: state.events,
      byId, visual: this.visualPlayers, b, animTime: this.animTime });

    drawSetPiece(this.setPieceGfx, this.setPieceText, state, byId);

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
        ? `${restartLabel(state.setPieceState.reason ?? state.setPieceState.type)} ${(state.setPieceState.team ?? '').toUpperCase()}`
        : '';
      const tag = [stateTag, restartTag].filter(Boolean).join(' · ');
      if (this.prevHud.tag !== tag) { this.prevHud.tag = tag; r.state.textContent = tag; r.state.style.display = tag ? '' : 'none'; }
      // possession split — the thin strip along the scoreboard's bottom edge (home left, away right)
      const pw = `${pct}%`;
      if (this.prevHud.possW !== pw) { this.prevHud.possW = pw; r.possHome.style.width = pw; }
    }

    this.updateTicker(state);
    this.stats.updateMomentum(state);   // PRESSURE: integrate after the ticker folds in event impulses
    this.stats.renderStatPanel();
    this.updateMoments(state);
    // Draw the positional layer immediately ONLY when something new exists (first ingest / a just-created
    // player shape would sit at the origin for a frame otherwise). Every other sync leaves the draw to the
    // 60fps ticker (≤16ms away) — the unconditional call ran the full positional pass an extra ~35×/sec on
    // a live watch, on top of the ticker's 60.
    if (this.syncNeedsImmediateDraw) { this.syncNeedsImmediateDraw = false; this.renderFrame(); }
  }

  private updateMoments(state: EngineState): void {
    if (!this.bannerEl || !this.panelEl) return;
    const now = performance.now();
    const hs = state.homeScore ?? 0, as = state.awayScore ?? 0;
    const hn = clipName(state.homeName, 'HOME'), an = clipName(state.awayName, 'AWAY');
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
        // Round-30: an own goal is not the scorer's moment — name it as one instead
        // of shouting "GOAL! <defender>" at the man who put it in his own net.
        this.bannerEl.textContent = this.lastGoalOwn
          ? `OWN GOAL — ${who}\n${hn} ${hs} — ${as} ${an}`
          : `GOAL!  ${who}\n${hn} ${hs} — ${as} ${an}`;
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
      this.lastGoalOwn = false;
      this.clearToasts();
      this.stats.resetMatchStats(state.clockMs);
    }
    this.lastClockMs = state.clockMs;
    const notable = new Set(['goal', 'shot', 'save', 'claim', 'tip', 'foul', 'offside', 'skill', 'nutmeg', 'dragback', 'stepover', 'roulette', 'gk_punch', 'header', 'block', 'penalty', 'punch', 'yellow', 'sub', 'injury', 'assist', 'advantage', 'red', 'woodwork', 'handball']);
    for (const ev of (state.events ?? [])) {
      if (!notable.has(ev.type)) continue;
      const evClock = state.clockMs - (ev.age ?? 0);
      const key = `${ev.type}:${ev.playerId}:${Math.round(evClock / 400)}`;
      if (this.seenEventKeys.has(key)) continue;
      this.seenEventKeys.add(key);
      this.stats.accStatEvent(ev, this.playerById, evClock);   // PRESSURE panel: same de-dup → counts match the feed exactly
      const half = state.half ?? 1;
      const halfMs = half === 1 ? evClock : evClock - 45 * 60 * 1000;
      const minute = Math.max(0, Math.floor(halfMs / 60000)) + (half === 2 ? 45 : 0);
      const actor = ev.playerId != null ? this.playerById.get(ev.playerId) : undefined;
      let who = actor?.name ?? '';
      let target = (ev.targetId != null ? this.playerById.get(ev.targetId) : undefined)?.name ?? '';
      // A sub has TWO men and one slot id (which resolves to the arriving player, since
      // the engine renames the slot in the same tick). Feed the pair through the
      // existing who/target channel so the ticker line can name both.
      if (ev.type === 'sub' && (ev.inName || ev.outName)) { who = ev.inName ?? who; target = ev.outName ?? ''; }
      if (ev.type === 'goal') { this.lastGoalScorer = who; this.lastGoalScorerId = ev.playerId ?? null; this.lastGoalOwn = !!ev.ownGoal; }   // banner + celebration read these
      // newest on top — a chronological feed row: minute stamp · team-coloured dot · commentary
      this.feedEntries.unshift({ minute, team: actor?.team ?? null, text: commentary(ev.type, who, target, this.lastClockMs, this.commentaryCounter), goal: ev.type === 'goal' });
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
    const nm = shortName(who);
    const m = `${minute}'`;
    const where = (ev.x != null && ev.y != null) ? ` · ${zoneLabel(ev.x, ev.y)}` : '';
    switch (ev.type) {
      case 'goal':    this.pushToast('⚽', ev.ownGoal ? `${m}  ${nm || 'Own goal'} (O.G.)` : `${m}  ${nm || 'Goal'}`, ev.ownGoal ? 'og' : 'goal'); break;
      case 'yellow':  this.pushToast('🟨', `${m}  ${nm}`, 'card'); break;
      case 'red':     this.pushToast('🟥', `${m}  ${nm}`, 'card'); break;
      case 'penalty': this.pushToast('❗', `${m}  Penalty awarded`, 'pen'); break;
      // The sub event carries ONE id — the pitch SLOT — and substituteSlot renames that slot to the
      // incoming man in the same tick, so `nm` is always the player coming ON, never the one going
      // off. Round-31: the engine now ships both names on the event (outName/inName), so name both;
      // fall back to the id-derived name (= the arriving man) if an old payload lacks them.
      case 'sub': {
        const off = shortName(ev.outName ?? ''), on = shortName(ev.inName ?? '') || nm;
        this.pushToast('🔁', off && on ? `${m}  ${off} off, ${on} on` : `${m}  ${on ? on + ' comes on' : 'Substitution'}`, 'sub');
        break;
      }
      // event-communication (owner: "not clear what happened — off-ball foul? advantage?"): brief
      // who/what/where popups. 'foul' names the offender + the fouled player (ev.targetId) when known;
      // an 'advantage' event reads "play on"; offside/injury name the player.
      case 'foul': {
        const vic = shortName(target);
        this.pushToast('⚑', `${m}  Foul — ${nm}${vic ? ' on ' + vic : ''}${where}`, 'foul'); break;
      }
      case 'advantage': this.pushToast('▶', `${m}  Advantage — ${nm ? nm + ' plays on' : 'play on'}${where}`, 'adv'); break;
      case 'offside':   this.pushToast('🚩', `${m}  Offside — ${nm}${where}`, 'offside'); break;
      case 'injury':    this.pushToast('✚', `${m}  Injury — ${nm || 'stoppage'}`, 'inj'); break;
      default: break;
    }
  }

  // ── Live analysis getters (read by the app's 📊 Stats panel) ──────────────────────────
  // Every-player live rating off the latest ingested frame (same model as the on-pitch tags).
  getRatings(): { id: number; name: string; team: 'home' | 'away'; role: string; rating: number }[] {
    const s = this.lastState;
    if (!s) return [];
    return s.players.map(p => ({ id: p.id, name: p.name, team: p.team, role: p.role, rating: liveRating(p, s.homeScore ?? 0, s.awayScore ?? 0) }));
  }
  // The accumulated shot list (pitch xy + xG + side + goal) and the cumulative-xG timeline. Read-only
  // views — the panel renders a shot map + an xG race line from them; both reset with the match.
  getShots(): ReadonlyArray<{ x: number; y: number; xg: number; side: number; goal: boolean }> { return this.stats.shots; }
  getXgSeries(): ReadonlyArray<{ t: number; h: number; a: number }> { return this.stats.xgSeries; }
  // Latest team names (for the panel's home/away column headers) — off the frame, blank until known.
  getTeamNames(): { home: string; away: string } {
    const s = this.lastState as (EngineState & { homeName?: string; awayName?: string }) | null;
    return { home: s?.homeName ?? 'Home', away: s?.awayName ?? 'Away' };
  }

  // (smoothPlayer/smoothBall removed — the per-frame exponential chase was replaced by the 60fps
  // prev→target tween in renderFrame, which gives true inter-frame motion instead of a 4fps step.)

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
}
