// ── player sprites ── extracted from renderer.ts (Round: renderer-split). The two draws that make a
// player: the BODY (its pose — diving keeper, latched tackle, plain disc with speed lines), redrawn from
// sync() only when the dirty-check says a pose input moved, and the boot/head ARROW, redrawn from
// renderFrame EVERY tick at the lerped facing. Both draw in LOCAL coordinates; renderFrame owns where the
// Graphics sit, so nothing here may read or write a tweened position.
import { BALL_R } from '../constants';
import { DISC_R } from './constants';
import type { PlayerEntry } from './types';
import type { EngineState } from '../types';

// Redraw a player's body sprite. Called from sync() inside its needsRedraw guard, so every branch here
// starts from a cleared Graphics and repaints the whole pose; `o` carries the pose inputs sync computed
// (they are latched/dirty-checked there, not re-derived here) plus the drawn position vp the grounded-slide
// verify hook reports.
export function drawPlayerBody(entry: PlayerEntry, p: EngineState['players'][number], o: {
  color: number; diving: boolean; sliding: boolean; knockDribble: boolean; sprinting: boolean;
  hasBall: boolean; speed: number; vp: { x: number; y: number };
}): void {
  const { color, diving, sliding, knockDribble, sprinting, hasBall, speed, vp } = o;
  const r = DISC_R;
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

// F7: draw the player's boot/head arrow at a given facing — called PER TICK from renderFrame (was drawn at
// keyframe rate in sync → boots lagged a turn by up to ~250ms). Local coords; the arrow Graphics is
// positioned at the tweened player pos by renderFrame. vp/vb are the interpolated player + ball positions.
export function drawPlayerArrow(entry: PlayerEntry, p: EngineState['players'][number], angle: number,
                                vpx: number, vpy: number, vbx: number, vby: number, state: EngineState | null): void {
  const r = DISC_R;
  const hasBall = state?.ball.controllerId === p.id;
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
