// ── event + set-piece overlays ── extracted from renderer.ts (Round: renderer-split). The transient cues
// painted over the pitch from each ingested frame: one bespoke effect per notable event type (a nutmeg
// streak, a roulette comet, a keeper's tip-over arc …) plus the restart markers (spot, 9.15m wall ring,
// wall highlights, taker ring, caption). Both draw against the SMOOTHED player positions renderFrame keeps
// (`visual`), never the raw ~4fps engine samples — a cue anchored to a raw position snaps while the man it
// belongs to glides. Neither function owns state: sync() clears, draws and moves on within one frame.
import type { Graphics, Text } from 'pixi.js';
import { PITCH_W, PITCH_H, PLAYER_R, HOME_COLOR, AWAY_COLOR, clamp } from '../constants';
import { eventColor, eventLabel, restartLabel } from './labels';
import type { EngineState } from '../types';

// The frame slice the overlays read: the id→player index sync() rebuilds, the smoothed positions, the ball
// (for the punch's deflection heading) and animTime (for the skill swirl's spin).
export type OverlayFrame = {
  gfx: Graphics;
  labels: Text[];
  events: EngineState['events'] | undefined;
  byId: Map<number, EngineState['players'][number]>;
  visual: Map<number, { x: number; y: number }>;
  b: EngineState['ball'];
  animTime: number;
};

export function drawEventOverlays({ gfx, labels, events, byId, visual, b, animTime }: OverlayFrame): void {
  gfx.clear();
  for (const label of labels) label.visible = false;
  let labelIdx = 0;
  for (const ev of (events ?? [])) {
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
        const toV = (ev.targetId != null ? visual.get(ev.targetId) : undefined) ?? { x: target.x, y: target.y };
        gfx.moveTo(ev.x, ev.y);
        gfx.lineTo(toV.x, toV.y);
        gfx.stroke({ width: 2, color: 0x9ed7ff, alpha: alpha * 0.75 });
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
      const cx = victim ? (visual.get(victim.id)?.x ?? victim.x) : ev.x;
      const cy = victim ? (visual.get(victim.id)?.y ?? victim.y) : ev.y;
      let dx = 1, dy = 0;
      const tm = ev.playerId != null ? byId.get(ev.playerId) : undefined;
      if (tm) {
        const mx = visual.get(tm.id)?.x ?? tm.x, my = visual.get(tm.id)?.y ?? tm.y;
        const a = Math.atan2(cy - my, cx - mx); dx = Math.cos(a); dy = Math.sin(a);
      }
      const reach = PLAYER_R + 10 + t * 16;
      gfx.moveTo(cx - dx * reach * 0.5, cy - dy * reach * 0.5);
      gfx.lineTo(cx + dx * reach, cy + dy * reach);
      gfx.stroke({ width: 3, color: 0xffd24d, alpha });
      const px = -dy, py = dx;   // perpendicular = the two "legs" the ball threaded
      for (const s of [1, -1]) {
        gfx.moveTo(cx + px * s * (PLAYER_R - 1) - dx * 2, cy + py * s * (PLAYER_R - 1) - dy * 2);
        gfx.lineTo(cx + px * s * (PLAYER_R - 1) + dx * 3, cy + py * s * (PLAYER_R - 1) + dy * 3);
        gfx.stroke({ width: 2, color: 0xff6b6b, alpha: alpha * 0.85 });
      }
      gfx.circle(cx, cy, PLAYER_R + 2 + t * 9);
      gfx.stroke({ width: 2, color: 0xff6b6b, alpha: alpha * 0.7 });
      // a bright flash ON the beaten defender for the first third — the ball went THROUGH him.
      if (t < 0.33) {
        gfx.circle(cx, cy, PLAYER_R + 1);
        gfx.fill({ color: 0xffffff, alpha: (0.33 - t) * 1.9 });
      }
      if (labelIdx < labels.length) {
        const label = labels[labelIdx++];
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
      const cx = mover ? (visual.get(mover.id)?.x ?? mover.x) : ev.x;
      const cy = mover ? (visual.get(mover.id)?.y ?? mover.y) : ev.y;
      const t = ev.age / lifetime;
      const sr = PLAYER_R + 4 + t * 10;
      const spin = animTime * 0.25;
      const swirlColor = eventColor(ev.type);
      for (const dir of [1, -1]) {
        const a0 = spin * dir + (dir > 0 ? 0 : Math.PI);
        gfx.arc(cx, cy, sr, a0, a0 + Math.PI * 0.85);
        gfx.stroke({ width: 2.5, color: swirlColor, alpha: alpha * 0.9 });
      }
      continue;
    }
    if (ev.type === 'stepover') {
      // Quick left-right feint: two small ellipses sweeping to either side of the carrier's feet (the
      // shimmy), plus a light foot-flick tick trailing the current swing side. Anchored to the carrier's
      // smoothed position (playerId), falling back to the event spot. ~450ms, subtle (no callout).
      const mover = ev.playerId != null ? byId.get(ev.playerId) : undefined;
      const cx = mover ? (visual.get(mover.id)?.x ?? mover.x) : ev.x;
      const cy = mover ? (visual.get(mover.id)?.y ?? mover.y) : ev.y;
      const t = ev.age / lifetime;
      const col = eventColor('stepover');
      const swing = Math.sin(t * Math.PI * 3);          // ~1.5 left-right cycles across the move
      for (const s of [1, -1]) {
        const ox = s * swing * (PLAYER_R + 5);
        gfx.ellipse(cx + ox, cy + PLAYER_R * 0.35, 6.5, 3.4);
        gfx.stroke({ width: 2, color: col, alpha: alpha * (0.9 - t * 0.35) });
      }
      gfx.moveTo(cx, cy + PLAYER_R * 0.35);
      gfx.lineTo(cx + swing * (PLAYER_R + 9), cy + PLAYER_R * 0.35);
      gfx.stroke({ width: 1.5, color: col, alpha: alpha * 0.5 });
      continue;
    }
    if (ev.type === 'roulette') {
      // Zidane roulette: a comet arc whose leading edge sweeps a full 360° around the carrier over the
      // move, with a bright spin-dot (the ball dragged round on the sole) riding the leading edge. ~520ms.
      const mover = ev.playerId != null ? byId.get(ev.playerId) : undefined;
      const cx = mover ? (visual.get(mover.id)?.x ?? mover.x) : ev.x;
      const cy = mover ? (visual.get(mover.id)?.y ?? mover.y) : ev.y;
      const t = ev.age / lifetime;
      const col = eventColor('roulette');
      const rr = PLAYER_R + 5 + t * 6;
      const head = -Math.PI / 2 + t * Math.PI * 2;      // leading edge → one full turn
      gfx.arc(cx, cy, rr, head - Math.PI * 1.25, head);
      gfx.stroke({ width: 3, color: col, alpha });
      gfx.circle(cx + Math.cos(head) * rr, cy + Math.sin(head) * rr, 2.6);
      gfx.fill({ color: 0xffffff, alpha });
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
      const wx = winner ? (visual.get(winner.id)?.x ?? winner.x) : ev.x;
      const wy = winner ? (visual.get(winner.id)?.y ?? winner.y) : ev.y;
      const t = ev.age / lifetime;
      const rr = PLAYER_R + 11 - Math.min(t * 2, 1) * 7;   // pincer closes over the first half
      for (const s of [1, -1]) {
        const a0 = (s > 0 ? 0 : Math.PI) - 0.55;
        gfx.arc(wx, wy, rr, a0, a0 + 1.1);
        gfx.stroke({ width: 2.5, color: 0x7fe08a, alpha: alpha * 0.9 });
      }
      const loser = ev.targetId != null ? byId.get(ev.targetId) : undefined;
      if (loser) {
        const lx = visual.get(loser.id)?.x ?? loser.x;
        const ly = visual.get(loser.id)?.y ?? loser.y;
        const aa = Math.atan2(ly - wy, lx - wx);   // stumble trails away from the duel
        for (let i = 0; i < 3; i++) {
          const d0 = PLAYER_R + 2 + i * 4.5;
          gfx.moveTo(lx + Math.cos(aa) * d0, ly + Math.sin(aa) * d0);
          gfx.lineTo(lx + Math.cos(aa) * (d0 + 4), ly + Math.sin(aa) * (d0 + 4));
        }
        gfx.stroke({ width: 2, color: 0xff9d6b, alpha: alpha * 0.6 });
      }
      if (t < 0.55 && labelIdx < labels.length) {
        const label = labels[labelIdx++];
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
      else if (mover) { const mx = visual.get(mover.id)?.x ?? mover.x, my = visual.get(mover.id)?.y ?? mover.y; ha = Math.atan2(my - ev.y, mx - ev.x); }
      const col = 0xffd24d;
      const hx = Math.cos(ha), hy = Math.sin(ha), px = -hy, py = hx;
      // chevron (the cut) across the exit heading
      for (const s of [1, -1]) {
        gfx.moveTo(ev.x + px * s * 7 - hx * 4, ev.y + py * s * 7 - hy * 4);
        gfx.lineTo(ev.x, ev.y);
      }
      gfx.stroke({ width: 3, color: col, alpha });
      // flare along the new heading (grows then fades — the explode-away)
      const reach = 8 + t * 18;
      gfx.moveTo(ev.x + hx * 4, ev.y + hy * 4);
      gfx.lineTo(ev.x + hx * reach, ev.y + hy * reach);
      gfx.stroke({ width: 2.5, color: 0xffffff, alpha: alpha * 0.7 });
      // scuff at the cut point
      gfx.circle(ev.x, ev.y, 2.4 + t * 2.5);
      gfx.fill({ color: col, alpha: alpha * 0.5 });
      continue;
    }
    if (ev.type === 'gk_punch') {
      // Keeper punch: a short radial burst of spokes from the fists + a bright deflection streak sending
      // the ball away along its heading (or clearing toward midfield if it's momentarily slow), with a
      // ball-glint at the streak tip and a "PUNCH!" call. Anchored to the keeper (playerId). ~460ms.
      const gk = ev.playerId != null ? byId.get(ev.playerId) : undefined;
      const cx = gk ? (visual.get(gk.id)?.x ?? gk.x) : ev.x;
      const cy = gk ? (visual.get(gk.id)?.y ?? gk.y) : ev.y;
      const t = ev.age / lifetime;
      const col = eventColor('gk_punch');
      const r0 = PLAYER_R + 2, r1 = PLAYER_R + 6 + t * 16;
      for (let s = 0; s < 8; s++) {
        const a = (s / 8) * Math.PI * 2;
        gfx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
        gfx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      }
      gfx.stroke({ width: 2, color: col, alpha });
      let da = Math.atan2(b.vy, b.vx);
      if (b.vx * b.vx + b.vy * b.vy < 400) da = cx < PITCH_W / 2 ? 0 : Math.PI;   // slow ball → clear to midfield
      const dfx = Math.cos(da), dfy = Math.sin(da), reach = 20 + t * 34;
      gfx.moveTo(cx + dfx * r0, cy + dfy * r0);
      gfx.lineTo(cx + dfx * reach, cy + dfy * reach);
      gfx.stroke({ width: 3, color: col, alpha });
      gfx.circle(cx + dfx * reach, cy + dfy * reach, 3);
      gfx.fill({ color: 0xffffff, alpha });
      if (labelIdx < labels.length) {
        const label = labels[labelIdx++];
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
      const cx = gk ? (visual.get(gk.id)?.x ?? gk.x) : ev.x;
      const cy = gk ? (visual.get(gk.id)?.y ?? gk.y) : ev.y;
      const toGoal = cx < PITCH_W / 2 ? -1 : 1;          // toward the keeper's own goal-line
      const cornerDir = cy < PITCH_H / 2 ? -1 : 1;        // toward the nearer post / corner
      const COL = 0x8fe3ff;
      const reach = 26 + t * 34;
      const ex = cx + toGoal * reach, ey = cy + cornerDir * (8 + t * 18);
      // the deflected ball — a curved streak that bows "up & over" before dropping out near the post
      gfx.moveTo(cx, cy);
      gfx.quadraticCurveTo(cx + toGoal * reach * 0.4, cy - cornerDir * 12, ex, ey);
      gfx.stroke({ width: 3, color: COL, alpha });
      gfx.circle(ex, ey, 3.5); gfx.fill({ color: 0xffffff, alpha });   // ball glint
      for (const s of [0.6, 1.0, 1.4]) {                  // fingertip reach off the keeper
        gfx.moveTo(cx, cy);
        gfx.lineTo(cx + toGoal * 9 * s, cy - cornerDir * 4 * s);
      }
      gfx.stroke({ width: 1.5, color: COL, alpha: alpha * 0.8 });
      gfx.circle(cx, cy, PLAYER_R + 2 + t * 10);   // reflex-save pulse
      gfx.stroke({ width: 2, color: COL, alpha: alpha * 0.7 });
      if (labelIdx < labels.length) {
        const label = labels[labelIdx++];
        label.text = 'TIPPED OVER!';
        label.position.set(cx, Math.max(18, cy - reach - 12));
        label.style.fill = COL;
        label.alpha = clamp(1 - t, 0, 1);
        label.visible = true;
      }
      continue;
    }
    const er = 14 + (ev.age / lifetime) * (ev.type === 'header' ? 15 : 30);
    const ec = eventColor(ev.type);
    gfx.circle(ev.x, ev.y, er);
    gfx.stroke({ width: ev.type === 'header' ? 3 : 2, color: ec, alpha });
    if (labelIdx < labels.length) {
      const label = labels[labelIdx++];
      label.text = eventLabel(ev.type);
      label.position.set(ev.x, Math.max(18, ev.y - er - 12));
      label.style.fill = ec;
      label.alpha = clamp(1 - ev.age / lifetime, 0, 1);
      label.visible = true;
    }
  }
}

// The restart markers: the spot, the free kick's 9.15m legal-distance ring and the wall it lines up on, the
// designated taker's gold ring, and the caption. `text` is the shared set-piece Text, hidden again each
// frame that carries no restart.
export function drawSetPiece(gfx: Graphics, text: Text, state: EngineState,
                             byId: Map<number, EngineState['players'][number]>): void {
  gfx.clear();
  text.visible = false;
  const restart = state.setPieceState;
  if (restart) {
    const label = restartLabel(restart.reason ?? restart.type);
    const teamLabel = restart.team === 'home' ? 'HOME' : 'AWAY';
    // At a free kick, mark the 9.15m (~91px in pitch coords, per the engine) legal distance — the
    // defensive WALL lines up on this ring, so the wall formation reads on screen (user ask: SEE walls).
    if (restart.type === 'free_kick') {
      gfx.circle(restart.spotX, restart.spotY, 91);
      gfx.stroke({ width: 1.5, color: 0xffffff, alpha: 0.26 });
      // highlight the defensive WALL — the players Boris flags with p.wall, lined up on the 9.15m ring
      // (the user's core "SEE wall formations" want). Cyan rings, distinct from the gold taker ring.
      // No-ops until the engine serialises `wall` into the frame (p.wall undefined → empty).
      const wall = state.players.filter(p => p.wall);
      if (wall.length) {
        for (const wp of wall) {
          gfx.circle(wp.x, wp.y, 12);
          gfx.stroke({ width: 2.5, color: 0x5cd6ff, alpha: 0.95 });
        }
        (window as unknown as { __lastWall?: unknown }).__lastWall = { n: wall.length, ids: wall.map(p => p.id), atMs: state.clockMs };   // verify hook
      }
    }
    gfx.circle(restart.spotX, restart.spotY, 18);
    gfx.stroke({ width: 3, color: restart.team === 'home' ? HOME_COLOR : AWAY_COLOR, alpha: 0.95 });
    gfx.circle(restart.spotX, restart.spotY, 4);
    gfx.fill({ color: 0xffffff, alpha: 0.95 });
    // mark the designated TAKER (who's taking the set piece) with a gold ring — completes the FK setup read
    const taker = restart.takerId != null ? byId.get(restart.takerId) : undefined;
    if (taker) {
      gfx.circle(taker.x, taker.y, 13);
      gfx.stroke({ width: 2, color: 0xffe066, alpha: 0.85 });
      (window as unknown as { __lastTaker?: unknown }).__lastTaker = { id: restart.takerId, x: Math.round(taker.x), y: Math.round(taker.y), type: restart.type };   // verify hook
    }
    text.text = `${label} ${teamLabel}`;
    text.position.set(restart.spotX, Math.max(22, restart.spotY - 30));
    text.anchor.set(0.5, 0.5);
    text.visible = true;
  }
  // headless verify hook: confirm the FK 9.15m wall ring drew with the right centre/radius (eval, no screenshot)
  (window as unknown as { __spDraw?: unknown }).__spDraw = restart
    ? { type: restart.type, wallRingDrawn: restart.type === 'free_kick', cx: restart.spotX, cy: restart.spotY, r: restart.type === 'free_kick' ? 91 : 0 }
    : null;
  // accumulate the last free kick's ring draw so a single later eval can confirm it fired (FKs are sporadic)
  if (restart?.type === 'free_kick') (window as unknown as { __lastFK?: unknown }).__lastFK = { cx: restart.spotX, cy: restart.spotY, r: 91, atMs: state.clockMs };
}
