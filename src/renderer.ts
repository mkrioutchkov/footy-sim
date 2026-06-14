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

type PlayerEntry = {
  body: Graphics;
  arrow: Graphics;
  label: Text;
  drawn: boolean;
  wasSliding: boolean;
  hadBall: boolean;
  slideAngle: number;
  lastDribbleType: number;
  wasSprinting: boolean;
};

export class MatchRenderer {
  app: Application;
  pitchContainer: Container;
  private playerLayer: Container;
  private trailPool: Graphics[] = [];
  private shotTrailGfx: Graphics;
  private shotTrailBuffer: { x: number; y: number }[] = [];
  private playerEntries: Map<number, PlayerEntry> = new Map();
  private ringGfx: Graphics;
  private ballBody: Graphics;
  private ballGlow: Graphics;
  private hudText: Text;
  private hudBg: Graphics;
  private tickerEl: HTMLDivElement | null = null;
  private tickerLines: string[] = [];
  private seenEventKeys: Set<string> = new Set();
  private bannerEl: HTMLDivElement | null = null;
  private bannerHideAt = 0;
  private panelEl: HTMLDivElement | null = null;
  private panelHideAt = 0;
  private prevHomeScore = 0;
  private prevAwayScore = 0;
  private prevHalf = 1;
  private shownFullTime = false;
  private versionText: Text = null!;
  private uiVersion = '';
  private eventGfx: Graphics;
  private eventLabels: Text[] = [];
  private setPieceGfx: Graphics;
  private setPieceText: Text;
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;
  private trailBuffer: { x: number; y: number }[] = [];
  private visualPlayers: Map<number, { x: number; y: number }> = new Map();
  private visualBall: { x: number; y: number; z: number } | null = null;
  private lastControllerId: number | null = null;
  private prevControllerId: number | null = null;
  private animTime = 0;
  private facingAngles: Map<number, number> = new Map();
  private prevFacingAngles: Map<number, number> = new Map();

  constructor() {
    this.app = new Application();
    this.pitchContainer = new Container();
    this.playerLayer = new Container();
    this.ringGfx = new Graphics();
    this.ballBody = new Graphics();
    this.ballGlow = new Graphics();
    this.eventGfx = new Graphics();
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

    for (let i = 0; i < 10; i++) {
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
    await this.app.init({
      resizeTo: window, backgroundColor: 0x1a1a2e,
      antialias: true, resolution: window.devicePixelRatio || 1, autoDensity: true,
    });

    document.getElementById('app')!.appendChild(this.app.canvas);
    this.app.stage.addChild(this.pitchContainer);
    this.pitchContainer.addChild(this.playerLayer);
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
      borderRadius: '6px', pointerEvents: 'none', whiteSpace: 'pre',
      minWidth: '210px', maxWidth: '340px',
    } as Partial<CSSStyleDeclaration>);
    this.tickerEl.textContent = '— match feed —';
    document.body.appendChild(this.tickerEl);
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
    // Recalculate the pitch transform whenever the canvas actually changes
    // size. Window 'resize' alone misses canvas-size changes (and Pixi v8's
    // renderer emits no resize event), leaving the pitch at a stale scale.
    new ResizeObserver(() => this.calcTransform()).observe(this.app.canvas);
    window.addEventListener('resize', () => this.calcTransform());
    // Dev convenience: expose the app for console/screenshot tooling.
    (window as unknown as { __app: Application }).__app = this.app;
  }

  // Tear down for SPA navigation: remove the body-level overlays and the
  // Pixi app (which detaches the canvas). Safe to call once.
  destroy(): void {
    try { this.tickerEl?.remove(); } catch { /* */ }
    try { this.bannerEl?.remove(); } catch { /* */ }
    try { this.panelEl?.remove(); } catch { /* */ }
    try { this.app.destroy(true, { children: true, texture: true }); } catch { /* */ }
  }

  private calcTransform(): void {
    const sw = this.app.screen.width;
    const sh = this.app.screen.height;
    this.scale = Math.min(sw / (PITCH_W + GOAL_DEPTH * 2), sh / (PITCH_H + 40)) * 0.92;
    this.offsetX = (sw - PITCH_W * this.scale) / 2;
    this.offsetY = (sh - PITCH_H * this.scale) / 2 + 10;
    this.pitchContainer.scale.set(this.scale);
    this.pitchContainer.position.set(this.offsetX, this.offsetY);
    this.hudText.position.set(sw / 2, 6);
    this.hudText.anchor.set(0.5, 0);
    this.drawPitch();
  }

  private drawPitch(): void {
    this.pitchContainer.removeChildren();
    this.pitchContainer.addChild(this.playerLayer);
    this.pitchContainer.addChild(this.ringGfx);
    this.pitchContainer.addChild(this.ballBody);
    this.pitchContainer.addChild(this.ballGlow);
    this.pitchContainer.addChild(this.eventGfx);
    for (const label of this.eventLabels) this.pitchContainer.addChild(label);
    this.pitchContainer.addChild(this.setPieceGfx);
    this.pitchContainer.addChild(this.setPieceText);

    const g = new Graphics();
    g.rect(-GOAL_DEPTH, 0, PITCH_W + GOAL_DEPTH * 2, PITCH_H); g.fill(PITCH_GREEN);
    // mowing stripes
    const stripeCount = 14;
    const stripeW = PITCH_W / stripeCount;
    for (let i = 0; i < stripeCount; i += 2) {
      g.rect(i * stripeW, 0, stripeW, PITCH_H);
      g.fill({ color: 0xffffff, alpha: 0.05 });
    }
    g.rect(0, 0, PITCH_W, PITCH_H); g.stroke({ width: 3, color: LINE_COLOR });
    g.moveTo(PITCH_W / 2, 0); g.lineTo(PITCH_W / 2, PITCH_H); g.stroke({ width: 2, color: LINE_COLOR });
    g.circle(PITCH_W / 2, PITCH_H / 2, CENTER_CIRCLE_R); g.stroke({ width: 2, color: LINE_COLOR });
    g.circle(PITCH_W / 2, PITCH_H / 2, 3); g.fill(LINE_COLOR);
    this.drawGoal(g, 0, PITCH_H / 2, 1);
    this.drawGoal(g, PITCH_W, PITCH_H / 2, -1);
    this.drawPenaltyArea(g, 0); this.drawPenaltyArea(g, PITCH_W);
    this.drawGoalArea(g, 0); this.drawGoalArea(g, PITCH_W);
    this.drawMarkingArc(g, 0, 0, CORNER_ARC_R, 0, Math.PI / 2);
    this.drawMarkingArc(g, PITCH_W, 0, CORNER_ARC_R, Math.PI / 2, Math.PI);
    this.drawMarkingArc(g, 0, PITCH_H, CORNER_ARC_R, -Math.PI / 2, 0);
    this.drawMarkingArc(g, PITCH_W, PITCH_H, CORNER_ARC_R, Math.PI, -Math.PI / 2);
    this.pitchContainer.addChildAt(g, 0);
    for (const child of this.playerLayer.removeChildren()) child.destroy();
    this.playerEntries.clear();
    this.visualPlayers.clear();
    this.visualBall = null;
    this.lastControllerId = null;
    this.prevControllerId = null;
    this.trailBuffer = [];
  }

  sync(state: EngineState): void {
    if (this.animTime === 0) console.log('[HUD] first sync, state keys:', Object.keys(state).filter(k => ['homeScore','homeShots','possessionPct','clockMs','matchState'].includes(k)).map(k => `${k}=${(state as any)[k]}`).join(', '));
    this.animTime++;
    if (state.version) {
      const seedText = typeof state.seed === 'number' ? `seed:${state.seed} ` : '';
      this.versionText.text = `${seedText}eng:${state.version} ${this.uiVersion}`;
    }
    const b = state.ball;
    const ballSpeed = Math.sqrt(b.vx ** 2 + b.vy ** 2);
    if (b.controllerId !== this.lastControllerId) {
      this.prevControllerId = this.lastControllerId;
      this.visualBall = null;
      this.trailBuffer = [];
      this.lastControllerId = b.controllerId;
    }
    const vb = this.smoothBall(b.x, b.y, b.z ?? 0);

    // ── trail ──
    if (b.controllerId === null && ballSpeed > 20) {
      this.trailBuffer.push({ x: vb.x, y: vb.y });
    } else {
      this.trailBuffer = [];
    }
    while (this.trailBuffer.length > TRAIL_LENGTH) this.trailBuffer.shift();

    for (let i = 0; i < TRAIL_LENGTH; i++) {
      const t = this.trailPool[i];
      const idx = this.trailBuffer.length - 1 - i;
      if (idx >= 0) {
        const pt = this.trailBuffer[idx];
        t.visible = true;
        t.position.set(pt.x, pt.y);
        t.clear();
        const alpha = (i / TRAIL_LENGTH) * 0.48;
        const r = BALL_R * (0.4 + (1 - i / TRAIL_LENGTH) * 0.75);
        t.circle(0, 0, r);
        t.fill({ color: 0xffdd44, alpha });
      } else {
        t.visible = false;
      }
    }

    // ── shot trail ──
    const SHOT_SPEED_THRESHOLD = 350;
    const SHOT_TRAIL_LENGTH = 24;
    if (b.controllerId === null && ballSpeed > SHOT_SPEED_THRESHOLD) {
      this.shotTrailBuffer.push({ x: vb.x, y: vb.y });
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
        const width = BALL_R * 0.4 + progress * BALL_R * 1.2;
        this.shotTrailGfx.moveTo(a.x, a.y);
        this.shotTrailGfx.lineTo(b2.x, b2.y);
        this.shotTrailGfx.stroke({ width, color: 0xff4422, alpha });
      }
    }

    // ── players ──
    for (const p of state.players) {
      let entry = this.playerEntries.get(p.id);
      if (!entry) {
        const body = new Graphics();
        const arrow = new Graphics();
        const label = new Text({
          text: p.name.split('(')[1]?.replace(')', '') ?? p.name,
          style: new TextStyle({ fill: 0xffffff, fontSize: 8, fontFamily: 'monospace' }),
        });
        label.anchor.set(0.5, 0);
        this.playerLayer.addChild(body);
        this.playerLayer.addChild(arrow);
        this.playerLayer.addChild(label);
        entry = {
          body,
          arrow,
          label,
          drawn: false,
          wasSliding: false,
          hadBall: false,
          slideAngle: p.team === 'home' ? 0 : Math.PI,
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
      const vp = this.smoothPlayer(p.id, p.x, p.y);
      const sliding = (p.tackleAnim ?? 0) > 0;
      const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
      const knockDribble = p.dribbleType === 3;
      const sprinting = knockDribble || speed > 39;
      if (sliding && !entry.wasSliding) {
        entry.slideAngle = Math.hypot(p.vx, p.vy) > 1 ? Math.atan2(p.vy, p.vx) : (p.team === 'home' ? 0 : Math.PI);
      }
      const needsRedraw = !entry.drawn || sliding || entry.wasSliding || hasBall !== entry.hadBall
        || p.dribbleType !== entry.lastDribbleType || sprinting !== entry.wasSprinting;
      entry.wasSliding = sliding;
      entry.hadBall = hasBall;
      entry.lastDribbleType = p.dribbleType;
      entry.wasSprinting = sprinting;

      entry.body.position.set(vp.x, vp.y);
      entry.body.alpha = hasBall ? 1 : 0.82; // consistent alpha: carriers pop, others uniform
      if (needsRedraw) {
        entry.body.clear();
        if (sliding) {
          // slide tackle: elongated oval + dust trail
          const angle = entry.slideAngle;
          entry.body.rotation = angle;
          entry.body.ellipse(0, 0, r * 1.8, r * 0.6);
          entry.body.fill({ color, alpha: 0.7 });
          entry.body.ellipse(0, 0, r * 1.8, r * 0.6);
          entry.body.stroke({ width: 1, color: 0x000000 });
          // dust puffs behind the slide
          entry.body.circle(-r * 0.8, 0, r * 0.4);
          entry.body.fill({ color: 0xcccccc, alpha: 0.5 });
          entry.body.circle(-r * 1.3, 0, r * 0.25);
          entry.body.fill({ color: 0xdddddd, alpha: 0.3 });
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
        if (!sliding) entry.drawn = true;
      }

      // arrow — redraw at relative coords
      entry.arrow.position.set(vp.x, vp.y);
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
      // Diagnose unexpected facing jumps even though ordinary turns are capped.
      const prevA = this.prevFacingAngles.get(p.id);
      if (prevA !== undefined) {
        const aDiff = Math.abs(angle - prevA);
        const na = aDiff > Math.PI ? 2*Math.PI - aDiff : aDiff;
        if (na > Math.PI * 0.7) console.warn(`[facing_flicker] player ${p.id} (${p.role}) angle jumped ${Math.round(na * 180 / Math.PI)} deg - speed=${Math.round(speed)}`);
      }
      this.prevFacingAngles.set(p.id, angle);
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

      entry.label.position.set(vp.x, vp.y + r + 3);
    }

    // ── carrier ring ──
    this.ringGfx.clear();
    if (b.controllerId !== null) {
      const ctrl = state.players.find(p => p.id === b.controllerId);
      if (ctrl) {
        const vc = this.visualPlayers.get(ctrl.id) ?? { x: ctrl.x, y: ctrl.y };
        const pulse = 0.25 + 0.35 * Math.sin(this.animTime * 0.08);
        const rc = ctrl.team === 'home' ? HOME_COLOR : AWAY_COLOR;
        this.ringGfx.circle(vc.x, vc.y, PLAYER_R + (ctrl.dribbleType === 3 ? 10 : 7));
        this.ringGfx.stroke({ width: ctrl.dribbleType === 3 ? 4 : 3, color: rc, alpha: ctrl.dribbleType === 3 ? Math.min(0.85, pulse + 0.25) : pulse });
      }
    }

    // ── ball ──
    const arcOffset = vb.z * 0.7;
    const shadowAlpha = clamp(vb.z / 120, 0.05, 0.55); // stronger shadow for elevation clarity
    // dribble touches: while a moving carrier controls the ball on the ground,
    // nudge it ahead and between the feet in a stride rhythm so dribbling reads
    // as touches rather than the ball being glued to the player
    let touchX = 0, touchY = 0;
    if (b.controllerId !== null && vb.z < 2) {
      const ctrl = state.players.find(p => p.id === b.controllerId);
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
    // ball position with Z lift
    this.ballBody.position.set(vb.x + touchX, vb.y + touchY - arcOffset);
    const heightRatio = clamp(vb.z / 250, 0, 1);
    this.ballBody.scale.set(1 - heightRatio * 0.3); // smaller when high up
    // ball shadow on ground
    this.ballGlow.position.set(vb.x, vb.y);
    this.ballGlow.clear();
    if (vb.z > 5) {
      this.ballGlow.ellipse(0, 0, BALL_R * (1 + heightRatio * 0.8), BALL_R * 0.5);
      this.ballGlow.fill({ color: 0x000000, alpha: shadowAlpha });
    }
    this.ballGlow.visible = vb.z > 5;

    // ── events ──
    this.eventGfx.clear();
    for (const label of this.eventLabels) label.visible = false;
    let labelIdx = 0;
    for (const ev of (state.events ?? [])) {
      const skillLike = ev.type === 'skill' || ev.type === 'nutmeg' || ev.type === 'dragback';
      const lifetime = ev.type === 'pass' ? 700 : ev.type === 'header' ? 600 : skillLike ? 650 : 2200;
      const alpha = clamp(1 - ev.age / lifetime, 0, 1) * 0.8;
      if (alpha <= 0) continue;
      if (ev.type === 'pass') {
        const target = state.players.find(p => p.id === ev.targetId);
        if (target) {
          this.eventGfx.moveTo(ev.x, ev.y);
          this.eventGfx.lineTo(target.x, target.y);
          this.eventGfx.stroke({ width: 2, color: 0x9ed7ff, alpha: alpha * 0.75 });
        }
        continue;
      }
      if (skillLike) {
        // Swirl around the trickster: two counter-rotating arcs that expand and fade
        const mover = state.players.find(p => p.id === ev.playerId);
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
      this.setPieceGfx.circle(restart.spotX, restart.spotY, 18);
      this.setPieceGfx.stroke({ width: 3, color: restart.team === 'home' ? HOME_COLOR : AWAY_COLOR, alpha: 0.95 });
      this.setPieceGfx.circle(restart.spotX, restart.spotY, 4);
      this.setPieceGfx.fill({ color: 0xffffff, alpha: 0.95 });
      this.setPieceText.text = `${label} ${teamLabel}`;
      this.setPieceText.position.set(restart.spotX, Math.max(22, restart.spotY - 30));
      this.setPieceText.anchor.set(0.5, 0.5);
      this.setPieceText.visible = true;
    }

    // ── HUD ──
    const halfMs = (state.half ?? 1) === 1 ? state.clockMs : state.clockMs - 45 * 60 * 1000;
    const min = String(Math.floor(halfMs / 60000)).padStart(2, '0');
    const sec = String(Math.floor((halfMs % 60000) / 1000)).padStart(2, '0');
    const sl = (state.speed ?? 1) >= 1 ? `${state.speed ?? 1}x` : `${(state.speed ?? 1).toFixed(1)}x`;
    const pct = (state.possessionPct ?? 50).toFixed(0);
    const restartHud = state.setPieceState
      ? `    ${this.restartLabel(state.setPieceState.reason ?? state.setPieceState.type)} ${(state.setPieceState.team ?? '').toUpperCase()}`
      : '';
    const addedTag = state.addedTime ? ` +${state.addedTimeAnnouncedMin ?? ''}` : '';
    const clip = (s: string) => (s.length > 16 ? s.slice(0, 16) : s).toUpperCase();
    const hn = clip(String((state as any).homeName ?? 'HOME'));
    const an = clip(String((state as any).awayName ?? 'AWAY'));
    this.hudText.text = `${hn} ${state.homeScore ?? 0}-${state.awayScore ?? 0} ${an}    H${state.half ?? 1} ${min}:${sec}${addedTag} [${sl}]    Shots ${state.homeShots ?? 0}-${state.awayShots ?? 0}    Poss ${pct}%    ${state.matchState ?? ''}${restartHud}`;
    this.hudText.visible = true;
    this.hudBg.clear();
    const hudW = this.hudText.width;
    this.hudBg.roundRect(this.hudText.position.x - hudW / 2 - 14, 2, hudW + 28, this.hudText.height + 10, 8);
    this.hudBg.fill({ color: 0x0a0f17, alpha: 0.78 });

    this.updateTicker(state);
    this.updateMoments(state);
  }

  private updateMoments(state: EngineState): void {
    if (!this.bannerEl || !this.panelEl) return;
    const now = performance.now();
    const hs = state.homeScore ?? 0, as = state.awayScore ?? 0;
    if (state.clockMs < 1500 && hs === 0 && as === 0) {
      // fresh match/restart
      this.prevHomeScore = 0; this.prevAwayScore = 0; this.prevHalf = 1; this.shownFullTime = false;
      this.panelEl.style.display = 'none';
    }
    // goal banner on score change
    if (hs !== this.prevHomeScore || as !== this.prevAwayScore) {
      const homeScored = hs > this.prevHomeScore;
      const scorerLine = this.tickerLines.find(l => l.includes('GOAL'));
      const who = scorerLine ? scorerLine.split(/GOAL\s+/)[1] ?? '' : '';
      this.bannerEl.textContent = `GOAL!  ${who}\nHOME ${hs} — ${as} AWAY`;
      this.bannerEl.style.whiteSpace = 'pre';
      this.bannerEl.style.color = homeScored ? '#ff8a8a' : '#9ecbff';
      this.bannerEl.style.borderColor = homeScored ? '#ff8a8a' : '#9ecbff';
      this.bannerEl.style.display = 'block';
      this.bannerHideAt = now + 4500;
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
        `${title}\n\nHOME ${hs} — ${as} AWAY\nShots  ${state.homeShots ?? 0} - ${state.awayShots ?? 0}\nPossession  ${pct}% - ${100 - Number(pct)}%${scorerBlock}${assistBlock}`;
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
    }
    this.lastClockMs = state.clockMs;
    const notable = new Set(['goal', 'shot', 'save', 'foul', 'offside', 'skill', 'nutmeg', 'dragback', 'header', 'block', 'penalty', 'punch', 'yellow', 'sub', 'injury', 'assist', 'advantage', 'red']);
    for (const ev of (state.events ?? [])) {
      if (!notable.has(ev.type)) continue;
      const evClock = state.clockMs - (ev.age ?? 0);
      const key = `${ev.type}:${ev.playerId}:${Math.round(evClock / 400)}`;
      if (this.seenEventKeys.has(key)) continue;
      this.seenEventKeys.add(key);
      const half = state.half ?? 1;
      const halfMs = half === 1 ? evClock : evClock - 45 * 60 * 1000;
      const minute = Math.max(0, Math.floor(halfMs / 60000)) + (half === 2 ? 45 : 0);
      const who = state.players.find(p => p.id === ev.playerId)?.name ?? '';
      this.tickerLines.unshift(`${String(minute).padStart(2)}' ${this.eventLabel(ev.type).padEnd(8)} ${who}`);
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
      case 'dragback': return 'DRAG-BACK';
      default: return type.replace(/_/g, ' ').toUpperCase();
    }
  }

  private eventColor(type: string): number {
    switch (type) {
      case 'goal': return 0xffdd44;
      case 'save': return 0x44ddff;
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

  private smoothPlayer(id: number, x: number, y: number): { x: number; y: number } {
    let v = this.visualPlayers.get(id);
    if (!v) {
      v = { x, y };
      this.visualPlayers.set(id, v);
      return v;
    }
    const jump = Math.hypot(x - v.x, y - v.y) > 120;
    v.x = jump ? x : lerp(v.x, x, 0.45);
    v.y = jump ? y : lerp(v.y, y, 0.45);
    return v;
  }

  private smoothBall(x: number, y: number, z: number): { x: number; y: number; z: number } {
    if (!this.visualBall) {
      this.visualBall = { x, y, z };
      return this.visualBall;
    }
    const jump = Math.hypot(x - this.visualBall.x, y - this.visualBall.y) > 160;
    this.visualBall.x = jump ? x : lerp(this.visualBall.x, x, 0.58);
    this.visualBall.y = jump ? y : lerp(this.visualBall.y, y, 0.58);
    this.visualBall.z = jump ? z : lerp(this.visualBall.z, z, 0.58);
    return this.visualBall;
  }

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
