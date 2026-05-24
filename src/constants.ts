import type { PlayerAttributes } from './types';

export const PITCH_W = 1050;
export const PITCH_H = 680;
export const GOAL_W = 73;
export const GOAL_H = 24;
export const GOAL_DEPTH = 20;
export const PLAYER_R = 12;
export const BALL_R = 4.5;
export const PENALTY_AREA_W = 403;
export const PENALTY_AREA_H = 165;
export const CENTER_CIRCLE_R = 91;
export const GOAL_AREA_W = 183;
export const GOAL_AREA_H = 55;
export const CORNER_ARC_R = 10;

export const HOME_COLOR = 0xe63946;
export const AWAY_COLOR = 0x457b9d;
export const PITCH_GREEN = 0x2d8a1e;
export const LINE_COLOR = 0xffffff;
export const GOAL_COLOR = 0xffffff;

export const HOME_GOAL_X = 0;
export const AWAY_GOAL_X = PITCH_W;
export const HALF_X = PITCH_W / 2;
export const MATCH_DURATION_MS = 90 * 60 * 1000;

export const MAX_PLAYER_SPEED = 50;
export const SPEED_WALK = 28;
export const SPEED_JOG = 48;
export const SPEED_DRIBBLE = 52;
export const SPEED_RUN = 52;
export const SPEED_SPRINT = 68;
export const STAMINA_DRAIN_SPRINT = 0.028;
export const STAMINA_RECOVER = 0.015;
export const STAMINA_SLOW_THRESHOLD = 0.35;
export const CLOSE_DIST = 30;
export const TACKLE_RANGE = 24;
export const CHASE_DIST = 150;
export const SHOOT_MIN_DIST = 120;
export const SHOOT_MAX_DIST = 400;
export const SEPARATION_DIST = 38;
export const SEPARATION_FORCE = 140;

export const GK_RUSH_DIST = 200;
export const DRIBBLE_MAX = 52;
export const CONTROL_DIST = 12;
export const COLLECT_DIST = 28;
export const COLLECT_SPEED_MAX = 80;
export const INTENDED_COLLECT_BONUS = 1.8;
export const BALL_FRICTION = 0.70;
export const PASS_SPEED_BASE = 150;
export const PASS_SPEED_DIST = 0.12;
export const FOV_ANGLE = Math.PI * 0.6;
export const FOV_RANGE = 250;
export const PLAYER_AWARE_RANGE = 120;
export const CHASE_RANGE = 180;
export const SHOT_SPEED_BASE = 380;
export const TACKLE_KICK_SPEED = 120;

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function attrFactor(attrs: PlayerAttributes, key: keyof PlayerAttributes): number {
  return attrs[key] / 100;
}

export function closestPointOnSegment(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): { x: number; y: number; t: number } {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 0.001) return { x: ax, y: ay, t: 0 };
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = clamp(t, 0, 1);
  return { x: ax + t * dx, y: ay + t * dy, t };
}
