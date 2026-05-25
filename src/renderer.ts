import { Application, Graphics, Container, Text, TextStyle } from 'pixi.js';
import {
  PITCH_W, PITCH_H, PLAYER_R, BALL_R,
  LINE_COLOR, PITCH_GREEN, HOME_COLOR, AWAY_COLOR, GOAL_COLOR,
  GOAL_W, GOAL_DEPTH,
  PENALTY_AREA_W, PENALTY_AREA_H,
  GOAL_AREA_W, GOAL_AREA_H,
  CENTER_CIRCLE_R, CORNER_ARC_R, PENALTY_SPOT_DIST,
  clamp, lerp,
} from './constants';
import type { EngineState } from './types';

const TRAIL_LENGTH = 12;

export class MatchRenderer {
  app: Application;
  pitchContainer: Container;
  private playerLayer: Container;
  private trailPool: Graphics[] = [];
  private playerEntries: Map<number, { body: Graphics; arrow: Graphics; label: Text; drawn: boolean; wasSliding: boolean; hadBall: boolean; slideAngle: number }> = new Map();
  private ringGfx: Graphics;
  private ballBody: Graphics;
  private ballGlow: Graphics;
  private hudText: Text;
  private versionText: Text;
  private uiVersion = '';
  private eventGfx: Graphics;
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;
  private trailBuffer: { x: number; y: number }[] = [];
  private visualPlayers: Map<number, { x: number; y: number }> = new Map();
  private visualBall: { x: number; y: number; z: number } | null = null;
  private lastControllerId: number | null = null;
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
    this.hudText = new Text({ text: '', style: new TextStyle({ fill: 0xffffff, fontSize: 16, fontFamily: 'monospace' }) });

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
    this.app.stage.addChild(this.hudText);
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
    window.addEventListener('resize', () => this.calcTransform());
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
    for (const t of this.trailPool) this.pitchContainer.addChild(t);

    const g = new Graphics();
    g.rect(0, 0, PITCH_W, PITCH_H); g.fill(PITCH_GREEN);
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
    this.playerEntries.clear();
    this.visualPlayers.clear();
    this.visualBall = null;
    this.lastControllerId = null;
    this.trailBuffer = [];
  }

  sync(state: EngineState): void {
    this.animTime++;
    if (state.version) this.versionText.text = `eng:${state.version} ${this.uiVersion}`;
    const b = state.ball;
    const ballSpeed = Math.sqrt(b.vx ** 2 + b.vy ** 2);
    if (b.controllerId !== this.lastControllerId) {
      this.visualBall = null;
      this.trailBuffer = [];
      this.lastControllerId = b.controllerId;
    }
    const vb = this.smoothBall(b.x, b.y, b.z ?? 0);

    // ── trail ──
    if (b.controllerId === null && ballSpeed > 30) {
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
        const alpha = (i / TRAIL_LENGTH) * 0.35;
        const r = BALL_R * (0.3 + (1 - i / TRAIL_LENGTH) * 0.5);
        t.circle(0, 0, r);
        t.fill({ color: 0xffdd44, alpha });
      } else {
        t.visible = false;
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
        entry = { body, arrow, label, drawn: false, wasSliding: false, hadBall: false, slideAngle: p.team === 'home' ? 0 : Math.PI };
        this.playerEntries.set(p.id, entry);
      }

      const color = p.team === 'home' ? HOME_COLOR : AWAY_COLOR;
      const hasBall = b.controllerId === p.id;
      const r = PLAYER_R;
      const vp = this.smoothPlayer(p.id, p.x, p.y);
      const sliding = (p.tackleAnim ?? 0) > 0;
      if (sliding && !entry.wasSliding) {
        entry.slideAngle = Math.hypot(p.vx, p.vy) > 1 ? Math.atan2(p.vy, p.vx) : (p.team === 'home' ? 0 : Math.PI);
      }
      const needsRedraw = !entry.drawn || sliding || entry.wasSliding || hasBall !== entry.hadBall;
      entry.wasSliding = sliding;
      entry.hadBall = hasBall;

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
          entry.body.stroke({ width: hasBall ? 2.5 : 1.5, color: 0x000000 });
        }
        if (!sliding) entry.drawn = true;
      }

      // arrow — redraw at relative coords
      entry.arrow.position.set(vp.x, vp.y);
      entry.arrow.clear();
      const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
      // smooth facing: update angle when moving fast enough, otherwise scan toward ball
      const MIN_SPEED = 8;
      let angle = this.facingAngles.get(p.id);
      if (angle === undefined) {
        angle = p.team === 'home' ? 0 : Math.PI;
      }
      if (p.facing !== undefined) {
        angle = this.turnTowards(angle, p.facing, Math.PI / 18);
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
        this.ringGfx.circle(vc.x, vc.y, PLAYER_R + 7);
        this.ringGfx.stroke({ width: 3, color: rc, alpha: pulse });
      }
    }

    // ── ball ──
    const arcOffset = vb.z * 0.7;
    const shadowAlpha = clamp(vb.z / 120, 0.05, 0.55); // stronger shadow for elevation clarity
    // ball position with Z lift
    this.ballBody.position.set(vb.x, vb.y - arcOffset);
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
    for (const ev of state.events) {
      if (ev.type === 'pass') continue;
      const lifetime = ev.type === 'header' ? 600 : 2000;
      const alpha = clamp(1 - ev.age / lifetime, 0, 1) * 0.8;
      if (alpha <= 0) continue;
      const er = 14 + (ev.age / lifetime) * (ev.type === 'header' ? 15 : 30);
      const ec = ev.type === 'goal' ? 0xffdd44 : ev.type === 'save' ? 0x44ddff : ev.type === 'tackle' ? 0xff6644 : ev.type === 'intercept' ? 0xffb347 : ev.type === 'header' ? 0xfff1a8 : 0xffffff;
      this.eventGfx.circle(ev.x, ev.y, er);
      this.eventGfx.stroke({ width: ev.type === 'header' ? 3 : 2, color: ec, alpha });
    }

    // ── HUD ──
    const halfMs = state.half === 1 ? state.clockMs : state.clockMs - 45 * 60 * 1000;
    const min = String(Math.floor(halfMs / 60000)).padStart(2, '0');
    const sec = String(Math.floor((halfMs % 60000) / 1000)).padStart(2, '0');
    const sl = state.speed >= 1 ? `${state.speed}x` : `${state.speed.toFixed(1)}x`;
    const pos = state.possessionPct.toFixed(0);
    this.hudText.text = `HOME ${state.homeScore}-${state.awayScore} AWAY    H${state.half} ${min}:${sec} [${sl}]    Shots ${state.homeShots}-${state.awayShots}    Poss ${pos}%    ${state.matchState}`;
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
    g.rect(x - dir * GOAL_DEPTH, y - hw, dir * GOAL_DEPTH, GOAL_W); g.fill({ color: GOAL_COLOR, alpha: 0.08 });
    g.rect(x - dir * GOAL_DEPTH, y - hw, dir * GOAL_DEPTH, GOAL_W); g.stroke({ width: 2, color: 0xcccccc });
    const netX = x - dir * 3;
    for (let ny = y - hw + 4; ny <= y + hw - 4; ny += 6) {
      g.moveTo(netX, ny); g.lineTo(netX - dir * (GOAL_DEPTH - 6), ny); g.stroke({ width: 0.5, color: 0xcccccc, alpha: 0.55 });
    }
    for (let nx = netX; dir > 0 ? nx >= x - GOAL_DEPTH + 2 : nx <= x + GOAL_DEPTH - 2; nx -= dir * 6) {
      g.moveTo(nx, y - hw + 2); g.lineTo(nx, y + hw - 2); g.stroke({ width: 0.5, color: 0xcccccc, alpha: 0.55 });
    }
    g.circle(x, y - hw, 2.5); g.fill(GOAL_COLOR);
    g.circle(x, y + hw, 2.5); g.fill(GOAL_COLOR);
  }

  private drawPenaltyArea(g: Graphics, x: number): void {
    const l = x === 0 ? 0 : PITCH_W - PENALTY_AREA_W;
    const t = (PITCH_H - PENALTY_AREA_H) / 2;
    g.rect(l, t, PENALTY_AREA_W, PENALTY_AREA_H); g.stroke({ width: 2, color: LINE_COLOR });
    const spotX = x === 0 ? PENALTY_SPOT_DIST : PITCH_W - PENALTY_SPOT_DIST;
    g.circle(spotX, PITCH_H / 2, 3); g.fill(LINE_COLOR);
    const arcAngle = Math.acos((PENALTY_AREA_W - PENALTY_SPOT_DIST) / CENTER_CIRCLE_R);
    if (x === 0) this.drawMarkingArc(g, spotX, PITCH_H / 2, CENTER_CIRCLE_R, -arcAngle, arcAngle);
    else this.drawMarkingArc(g, spotX, PITCH_H / 2, CENTER_CIRCLE_R, Math.PI - arcAngle, Math.PI + arcAngle);
  }

  private drawGoalArea(g: Graphics, x: number): void {
    const l = x === 0 ? 0 : PITCH_W - GOAL_AREA_W;
    const t = (PITCH_H - GOAL_AREA_H) / 2;
    g.rect(l, t, GOAL_AREA_W, GOAL_AREA_H); g.stroke({ width: 2, color: LINE_COLOR });
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
