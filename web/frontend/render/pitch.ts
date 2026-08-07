// ── pitch geometry ── extracted from renderer.ts (Round: renderer-split). The static markings, painted
// once into the reused pitch Graphics that MatchRenderer.drawPitch owns and places at the bottom of the
// container z-order. Pure geometry off the shared constants: no renderer state, no sprites, no z-order.
import type { Graphics } from 'pixi.js';
import {
  PITCH_W, PITCH_H,
  LINE_COLOR, PITCH_GREEN, GOAL_COLOR,
  GOAL_W, GOAL_DEPTH,
  PENALTY_AREA_W, PENALTY_AREA_H,
  GOAL_AREA_W, GOAL_AREA_H,
  CENTER_CIRCLE_R, CORNER_ARC_R,
} from '../constants';

// Turf + mowing stripes + lines + goals + boxes + spots + corner arcs, drawn into `g`. The caller clears
// nothing and adds nothing: g.clear() is the first thing here, and drawPitch keeps ownership of where g
// sits in the container (addChildAt(g, 0), immediately after this returns).
export function drawPitchMarkings(g: Graphics): void {
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
  drawGoal(g, 0, PITCH_H / 2, 1);
  drawGoal(g, PITCH_W, PITCH_H / 2, -1);
  drawPenaltyArea(g, 0); drawPenaltyArea(g, PITCH_W);
  drawGoalArea(g, 0); drawGoalArea(g, PITCH_W);
  drawPenaltyDetail(g, 0); drawPenaltyDetail(g, PITCH_W);   // penalty spots + the "D" arcs
  drawMarkingArc(g, 0, 0, CORNER_ARC_R, 0, Math.PI / 2);
  drawMarkingArc(g, PITCH_W, 0, CORNER_ARC_R, Math.PI / 2, Math.PI);
  drawMarkingArc(g, 0, PITCH_H, CORNER_ARC_R, -Math.PI / 2, 0);
  drawMarkingArc(g, PITCH_W, PITCH_H, CORNER_ARC_R, Math.PI, -Math.PI / 2);
}

function drawGoal(g: Graphics, x: number, y: number, dir: number): void {
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
function drawGoalArea(g: Graphics, x: number): void {
  const l = x === 0 ? 0 : PITCH_W - GOAL_AREA_W;
  const t = (PITCH_H - GOAL_AREA_H) / 2;
  g.rect(l, t, GOAL_AREA_W, GOAL_AREA_H); g.stroke({ width: 2, color: LINE_COLOR });
}

function drawPenaltyArea(g: Graphics, x: number): void {
  const l = x === 0 ? 0 : PITCH_W - PENALTY_AREA_W;
  const t = (PITCH_H - PENALTY_AREA_H) / 2;
  g.rect(l, t, PENALTY_AREA_W, PENALTY_AREA_H); g.stroke({ width: 2, color: LINE_COLOR });
}

// The penalty spot + the "D" (the arc of centre-circle radius around the spot that falls OUTSIDE the box).
// Standard pitch markings the renderer was missing — pure geometry off the existing constants.
function drawPenaltyDetail(g: Graphics, x: number): void {
  const side = x === 0 ? 1 : -1;
  const spotX = x + side * PENALTY_AREA_W * 0.66;     // ~11m from the goal line (16.5m box)
  const cy = PITCH_H / 2;
  g.circle(spotX, cy, 2.5); g.fill(LINE_COLOR);       // penalty spot
  const dx = Math.abs((x + side * PENALTY_AREA_W) - spotX);   // spot → front edge of the box
  if (dx < CENTER_CIRCLE_R) {
    const half = Math.acos(dx / CENTER_CIRCLE_R);
    const base = x === 0 ? 0 : Math.PI;               // the D bulges toward midfield
    drawMarkingArc(g, spotX, cy, CENTER_CIRCLE_R, base - half, base + half);
  }
}

function drawMarkingArc(g: Graphics, x: number, y: number, radius: number, start: number, end: number): void {
  g.moveTo(x + Math.cos(start) * radius, y + Math.sin(start) * radius);
  g.arc(x, y, radius, start, end);
  g.stroke({ width: 2, color: LINE_COLOR });
}
