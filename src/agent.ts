import type { Player, PlayerRole, TeamAssignmentRole } from './types';
import {
  PITCH_W, PITCH_H, HOME_GOAL_X, AWAY_GOAL_X,
  SHOOT_MIN_DIST, SHOOT_MAX_DIST,
  COLLECT_DIST, INTENDED_COLLECT_DIST, COLLECT_SPEED_MAX, INTENDED_COLLECT_BONUS,
  TACKLE_RANGE, PLAYER_AWARE_RANGE,
  STAMINA_DRAIN_SPRINT, STAMINA_RECOVER, STAMINA_SLOW_THRESHOLD,
  SPEED_RUN, SPEED_SPRINT,
  clamp, dist, lerp, attrFactor,
} from './constants';
import type { GameEngine, PassSelectionAudit, ShotSelectionAudit } from './engine';
import { random } from './random';

// Former chase collection envelope; retained only to count now-rejected steals.
const PRE_CONTACT_CHASE_REACH = 36.4;

interface ActionAudit {
  distance?: number;
  forwardProgress?: number;
  expectedCompletion?: number;
  blockers?: number;
  receiverPressure?: number;
  angleDeg?: number;
  pressureCount?: number;
}
interface A { type: string; score: number; target?: Player; posX?: number; posY?: number; purpose?: string; audit?: ActionAudit; }
interface GC { scoreDiff: number; timeLeft: number; half: number; urgency: number; }
interface P { ballDist: number; ballIsLoose: boolean; ballControllerTeam: string | null; ballControllerId: number | null;
  nearbyTeammates: Player[]; nearbyOpponents: Player[]; nearestOpponentDist: number; iAmController: boolean;
  amClosestToBall: boolean; chasingTeammatesCount: number; anyOpponentCloserToBall: boolean;
  pressureCount: number; intendedId: number | null; }

export class PlayerAgent {
  player: Player; private e: GameEngine;
  private sl = 0; private sc = 0;   private pa = 0; private ch: P | null = null;
  private ht = 0; private lx = 0; private ly = 0;
  private la = ''; private lastPurpose = ''; private lt: number | null = null; private lp: number | null = null;
  private facing = 0;
  private recentPassTarget: number | null = null; private recentPassTime = 0;
  private ballMemX = 0; private ballMemY = 0; private ballMemAge = 0;

  constructor(player: Player, engine: GameEngine) {
    this.player = player; this.e = engine;
    this.facing = player.team === 'home' ? 0 : Math.PI;
    // ball memory initialized on first tick (engine.ball not ready in constructor)
  }

  tick(sdt: number): void {
    if (this.player.role === 'GK') return;
    this.sl = Math.max(0, this.sl - 1); this.sc = Math.max(0, this.sc - 1);
    // lazy-init ball memory on first tick
    if (this.ballMemAge === 0 && this.ballMemX === 0 && this.ballMemY === 0) {
      this.ballMemX = this.e.ball.x; this.ballMemY = this.e.ball.y;
    }
    const ic = this.e.ball.controllerId === this.player.id;
    if (ic) this.ht++; else this.ht = 0;
    if (ic && this.e.isPreparingPass(this.player.id)) {
      this.player.targetX = this.player.x;
      this.player.targetY = this.player.y;
      this.lx = this.player.x;
      this.ly = this.player.y;
      return;
    }
    if (this.ch && this.ch.ballControllerId !== this.e.ball.controllerId) {
      if (this.ch.ballIsLoose && this.e.ball.controllerId !== null && dist(this.player, this.e.ball) <= PRE_CONTACT_CHASE_REACH) {
        this.e.notePreventedStaleGrab(this.player);
      }
      this.ch = null;
    }
    // Intended receivers must react to the current flight, not a cached pre-pass view.
    if (this.e.ball.intendedReceiverId === this.player.id) this.ch = null;
    const per = this.gp(); if (!per) { this.am(sdt); return; }
    const ctx = this.ctx();     const aff = this.ev(per, ic, ctx);
    const ch = this.rc(aff);
    this.auditDefensiveMovement(ch);
    this.ex(ch, sdt, aff);
    // per-player decision log
    if (this.e.clockMs % 500 < 20) { // log roughly every 500ms to avoid spam
      this.e.logPlayerDecision(this.player.id, ch.type, ch.score,
        aff.sort((x, y) => y.score - x.score).slice(0, 5).map(x => ({ type: x.type, score: x.score })),
        this.player.x, this.player.y, ch.purpose);
    }
    // "why no shoot" alert: carrier near goal, unpressured, didn't shoot
    if (ic && per.pressureCount === 0 && ch.type !== 'shoot' && ch.type !== 'hold' && this.e.clockMs % 500 < 20) {
      const gx = this.player.team === 'home' ? AWAY_GOAL_X : HOME_GOAL_X;
      if (Math.abs(this.player.x - gx) < 120) {
        const shootOpt = aff.find(x => x.type === 'shoot');
        if (shootOpt && shootOpt.score > 0.20) {
          const distance = shootOpt.audit?.distance ?? Math.hypot(this.player.x - gx, this.player.y - PITCH_H / 2);
          const angleDeg = shootOpt.audit?.angleDeg ?? this.e.goalOpeningAngleDeg(this.player.x, this.player.y, gx);
          this.e.logQualityFlag('why_no_shoot', { player: this.player.id, role: this.player.role, distance: Math.round(distance), angleDeg: Math.round(angleDeg * 10) / 10, shootScore: Math.round(shootOpt.score*1000)/1000, chose: ch.type, choseScore: Math.round(ch.score*1000)/1000 });
          this.e.captureDecisionMoment('why_no_shoot', this.player, {
            chose: ch.type,
            choseScore: Math.round(ch.score * 1000) / 1000,
            shootScore: Math.round(shootOpt.score * 1000) / 1000,
            distance: Math.round(distance),
            angleDeg: Math.round(angleDeg * 10) / 10,
            pressureCount: per.pressureCount,
          }, 8000, `why_no_shoot:${this.player.team}`);
        }
      }
    }
    this.lx = this.player.x; this.ly = this.player.y;
  }

  private ctx(): GC {
    const ms = this.e.homeScore, os = this.e.awayScore;
    const my = this.player.team === 'home' ? ms : os, op = this.player.team === 'home' ? os : ms;
    const d = my - op, tl = Math.max(0, 90 * 60 * 1000 - this.e.clockMs);
    const u = tl < 5 * 60 * 1000 ? (d < 0 ? 1 : d === 0 ? 0.7 : 0.3) : (d < 0 ? 0.6 : d === 0 ? 0.3 : 0);
    return { scoreDiff: d, timeLeft: tl, half: this.e.clockMs < 45 * 60 * 1000 ? 1 : 2, urgency: u };
  }

  private ev(per: P, ic: boolean, ctx: GC): A[] {
    let a: A[];
    if (ic) {
      if (this.sl > 0) return [{ type: 'hold', score: 1 }];
      if (this.sc > 0) {
        // near goal: bypass stuck-carrier, evaluate shoot immediately
        const gx = this.player.team === 'home' ? AWAY_GOAL_X : HOME_GOAL_X;
        if (Math.abs(this.player.x - gx) < 150) { a = [...this.cp(per, ctx), this.cs(per, ctx), this.cd(per, ctx)]; }
        else { const d = this.cd(per, ctx); d.score = 0.6; return [d]; }
      }
      a = [...this.cp(per, ctx), this.cs(per, ctx), this.cd(per, ctx)];
      const pc = per.pressureCount;
      for (const x of a) {
        if (x.type === 'pass') x.score += pc * 0.04;
        if (x.type === 'shoot') x.score += pc * 0.03;
        if (x.type === 'dribble' && pc === 1) x.score += 0.10;
        if (x.type === 'dribble' && pc >= 3) x.score -= 0.10;
      }
      // carriers prefer passing over shooting (real pass:shot ratio is ~15:1)
      const bestPass = a.filter(x => x.type === 'pass').sort((x, y) => y.score - x.score)[0];
      if (bestPass && bestPass.score > 0.20) bestPass.score += 0.06;
      // CM: primary distributor — always look to progress the ball
      if (this.player.role === 'CM' && bestPass && bestPass.score > 0.15) bestPass.score += 0.14;
      // CM: drive into space when no passing option is obvious
      if (this.player.role === 'CM') {
        const bestDribble = a.filter(x => x.type === 'dribble').sort((x, y) => y.score - x.score)[0];
        if (bestDribble && bestDribble.score > 0.25) bestDribble.score += 0.08;
      }
      // hold ball longer when unpressured — no need to force action
      if (pc === 0) {
        for (const x of a) { if (x.type === 'dribble') x.score += 0.10; }
        // CM with space: carry into it rather than hold
        if (this.player.role === 'CM') { for (const x of a) { if (x.type === 'dribble') x.score += 0.08; if (x.type === 'pass') x.score += 0.02; } }
        // WM unchecked: attack the flank, beat your man
        if (this.player.role === 'WM') { for (const x of a) { if (x.type === 'dribble') x.score += 0.12; if (x.type === 'pass') x.score += 0.04; } }
      }
    } else {
      a = [this.ct(per, ctx), this.cm(per, ctx), this.cc(per), ...this.bp(per, ctx)];
    }
    for (const x of a) { if (x.type === this.la && x.target?.id === this.lt) x.score += ic ? 0.12 : 0.05;
      // position stickiness: prefer targets near current heading to reduce oscillation
      if (x.type === 'position' && x.posX !== undefined && x.posY !== undefined) {
        const td = Math.sqrt((x.posX - this.player.targetX) ** 2 + (x.posY - this.player.targetY) ** 2);
        if (td < 50) x.score += 0.07;
      }
      x.score += (random() - 0.5) * 0.03; } // small randomness for human-like variability
    return a;
  }

  // ── canPass
  private cp(_per: P, ctx: GC): A[] {
    const p = this.player; const fd = p.team === 'home' ? 1 : -1; const r: A[] = [];
    for (const t of this.e.players) {
      if (t.team !== p.team || t.id === p.id || t.role === 'GK') continue;
      const d = dist(p, t); if (d < 30 || d > 550) continue;
      if (this.e.isOffsideTarget(p, t)) continue;
      // vision cone: only pass to teammates in forward 120° arc (unless very close)
      if (d > 40) {
        const angleTo = Math.atan2(t.y - p.y, t.x - p.x);
        const aDiff = Math.abs(angleTo - this.facing);
        const na = aDiff > Math.PI ? 2 * Math.PI - aDiff : aDiff;
        if (na > Math.PI / 3) continue; // outside vision cone
      }
      let bl = 0; const dx = t.x - p.x, dy = t.y - p.y, ls = dx * dx + dy * dy; if (ls < 1) continue;
      for (const o of this.e.players) { if (o.team === p.team || o.role === 'GK') continue;
        const t2 = clamp(((o.x - p.x) * dx + (o.y - p.y) * dy) / ls, 0, 1);
        if (Math.sqrt((o.x - p.x - t2 * dx) ** 2 + (o.y - p.y - t2 * dy) ** 2) < 30) bl++; }
      const fp = (t.x - p.x) * fd, rs = attrFactor(p.attrs, 'passing'), rr = attrFactor(t.attrs, 'positioning');
      const receiverPressure = this.e.players.filter(o => o.team !== p.team && o.role !== 'GK' && dist(o, t) < 45).length;
      if (receiverPressure >= 3) continue;
      const completion = clamp(
        0.89 + rs * 0.10 + rr * 0.06 - d / 850 * 0.28 - bl * 0.21 - receiverPressure * 0.12 - (fp > 130 ? 0.05 : 0),
        0.08, 0.98,
      );
      if (completion < 0.09) continue;
      const progression = clamp(fp / 240, -0.5, 1);
      const turnoverCost = (p.team === 'home' ? p.x < PITCH_W * 0.38 : p.x > PITCH_W * 0.62) ? 0.42 : 0.25;
      let sc = completion * (0.38 + Math.max(0, progression) * 0.34) - (1 - completion) * turnoverCost;
      if (t.id === this.lp) sc -= 0.18;
      // recent pass pair memory: penalize passes within a short window to same partner
      if (this.recentPassTarget === t.id && this.e.clockMs - this.recentPassTime < 3000) sc -= 0.10;
      if (bl === 0 && fp > 80) sc += 0.08;
      if (fp < -30) sc -= 0.16; if (fp < -90) sc -= 0.18;
      const dg2 = Math.abs(p.x - (p.team === 'home' ? AWAY_GOAL_X : HOME_GOAL_X));
      if (dg2 < 200 && fp > 0 && d < 150) sc += 0.10;       // WM crossing: near byline, target CF in box
      const dgW = Math.abs(p.x - (p.team === 'home' ? AWAY_GOAL_X : HOME_GOAL_X));
      const isCutback = (p.role === 'WM' || p.role === 'FB')
        && dgW < 315
        && Math.abs(p.y - PITCH_H / 2) > 90
        && Math.abs(t.x - (p.team === 'home' ? AWAY_GOAL_X : HOME_GOAL_X)) < 235
        && Math.abs(t.y - PITCH_H / 2) < 135
        && fp > -80;
      if (p.role === 'WM' && dgW < 250 && t.role === 'CF' && Math.abs(t.y - PITCH_H/2) < 150) sc += 0.22;
      // WM: cross early from deep — reward forward passes from wide areas
      if (p.role === 'WM' && fp > 100 && Math.abs(p.y - PITCH_H / 2) > 140 && bl <= 1) sc += 0.16;
      // FB overlap cross: reward wide passes into box
      if (p.role === 'FB' && fp > 80 && Math.abs(p.y - PITCH_H / 2) > 120 && dgW < 300) sc += 0.12;
      sc -= bl * 0.06; if (fp > 0) sc += 0.08 + (ctx.urgency > 0.5 ? 0.10 : 0) + (this.e.configFor(p.team).passingDirectness - 50) / 100 * 0.2;
      else sc -= (this.e.configFor(p.team).passingDirectness - 50) / 100 * 0.15;
      let pur = 'keep'; if (fp > 120 && bl === 0) pur = 'build'; else if (fp > 40 && bl <= 1) pur = 'build';
      else if (Math.abs(t.y - p.y) > 150) pur = 'switch'; else if (bl >= 2 && fp < -30) pur = 'clear';
      if (isCutback) pur = 'cutback';
      // switching play: boost cross-field passes when near flank is congested, far flank open
      if (pur === 'switch') {
        const carrierSide = p.y < PITCH_H / 2 ? 'top' : 'bottom';
        const targetSide = t.y < PITCH_H / 2 ? 'top' : 'bottom';
        if (carrierSide !== targetSide) {
          const oppsNearCarrier = this.e.players.filter(o => o.team !== p.team && o.role !== 'GK' && ((carrierSide === 'top') ? o.y < PITCH_H / 2 : o.y >= PITCH_H / 2) && dist(p, o) < 250).length;
          const oppsNearTarget = this.e.players.filter(o => o.team !== p.team && o.role !== 'GK' && ((targetSide === 'top') ? o.y < PITCH_H / 2 : o.y >= PITCH_H / 2) && dist(o, t) < 200).length;
          if (oppsNearCarrier >= 3 && oppsNearTarget <= 1) sc += 0.18; // clear switch opportunity
          else if (oppsNearCarrier >= 2 && oppsNearTarget <= 2) sc += 0.10;
        }
      }
      if (ctx.urgency > 0.6) { if (pur === 'build') sc += 0.20; if (pur === 'switch') sc += 0.15; if (pur === 'keep') sc -= 0.05; }
      else if (ctx.urgency < 0.3) { if (pur === 'keep') sc += 0.15; if (pur === 'switch') sc += 0.12; }
      else { if (pur === 'switch') sc += 0.10; }
      const cr = attrFactor(p.attrs, 'creativity'); if (pur === 'build' && bl > 0) sc += cr * 0.12; if (pur === 'clear') sc -= cr * 0.10;
      const rc: Record<PlayerRole, PlayerRole[]> = { 'GK': [], 'CB': ['CM', 'FB', 'WM', 'CF'], 'FB': ['CM', 'WM', 'CB'],
        'CM': ['CF', 'WM', 'FB'], 'WM': ['CF', 'CM'], 'CF': ['CM', 'WM'] };
      const pref = rc[p.role] || []; const ri = pref.indexOf(t.role);
      if (ri === 0) sc += 0.12; else if (ri === 1) sc += 0.06;       if (t.role === p.role) sc -= (p.role === 'CB' || p.role === 'FB') ? 0.30 : 0.20;
      // defenders: strongly prefer progressive passes to midfielders
      if ((p.role === 'CB' || p.role === 'FB') && (t.role === 'CM' || t.role === 'WM') && fp > 0) sc += 0.08;
      const targetTask = this.e.assignmentFor(t.id)?.role;
      if (targetTask === 'run_ahead') sc += 0.12;
      if (targetTask === 'overlap' && p.role !== 'CB') sc += 0.11;
      if (targetTask === 'advance_midfield') sc += 0.09;
      if (targetTask === 'hold_width' && Math.abs(t.y - p.y) > 120) sc += 0.08;
      const offsideLine = this.e.offsideLineFor(p.team);
      const onsideGap = offsideLine === null ? Infinity : (offsideLine - t.x) * fd;
      const releasedRunner = targetTask === 'run_ahead' || targetTask === 'overlap'
        || (p.role === 'CM' && (t.role === 'CF' || t.role === 'WM'));
      if (!isCutback && releasedRunner && fp > 40 && onsideGap > -15 && onsideGap < 140 && bl <= 1) {
        pur = 'through';
        sc += 0.14 + attrFactor(p.attrs, 'creativity') * 0.10;
        // slight timing uncertainty: occasionally runners go fractionally offside
        if (onsideGap < 8) sc += random() * 0.04; // borderline — sometimes still go
      }
      sc += Math.min(this.ht / 200, 0.35);
      if (receiverPressure >= 2) sc -= 0.25; if (_per.pressureCount >= 2 && bl === 0) sc += 0.10; if (_per.pressureCount >= 2 && bl >= 2) sc -= 0.15;
      // CM→CF through-ball creativity
      if (p.role === 'CM' && t.role === 'CF' && receiverPressure >= 1 && bl <= 1) sc += attrFactor(p.attrs, 'creativity') * 0.10;
      // one-two return: heavy bonus to pass back to a teammate who just passed to me
      const bb = this.e.teamBlackboards.get(p.team)!;
      if (bb.oneTwo && bb.oneTwo.from === t.id && bb.oneTwo.to === p.id && this.e.clockMs < bb.oneTwo.expires) sc += 0.25;
      if (sc > 0) r.push({
        type: 'pass',
        score: clamp(sc, 0, 1),
        target: t,
        purpose: pur,
        audit: {
          distance: d,
          forwardProgress: fp,
          expectedCompletion: completion,
          blockers: bl,
          receiverPressure,
        },
      });
    }
    return r;
  }

  private cs(per: P, ctx: GC): A {
    const p = this.player; const gx = p.team === 'home' ? AWAY_GOAL_X : HOME_GOAL_X;
    const depthToGoal = Math.abs(p.x - gx);
    const shotDistance = Math.hypot(p.x - gx, p.y - PITCH_H / 2);
    const angleDeg = this.e.goalOpeningAngleDeg(p.x, p.y, gx);
    const audit: ActionAudit = { distance: shotDistance, angleDeg, pressureCount: per.pressureCount };
    // Preserve normal chance-taking while rejecting the diagnosed near-byline geometry.
    const roleMax: Record<string, number> = { 'CF': 260, 'CM': 220, 'WM': 180, 'FB': 150, 'CB': 140 };
    const hardMax = roleMax[p.role] ?? 220;
    if (depthToGoal > hardMax) return { type: 'shoot', score: 0, audit };
    const mr = SHOOT_MIN_DIST + attrFactor(p.attrs, 'shooting') * (SHOOT_MAX_DIST - SHOOT_MIN_DIST);
    if (depthToGoal > Math.min(mr, hardMax)) return { type: 'shoot', score: 0, audit };
    let sc = attrFactor(p.attrs, 'shooting') * (1 - depthToGoal / mr) * 0.35;
    const gk = this.e.players.find(o => o.team !== p.team && o.role === 'GK');
    if (gk) {
      const gkOffCenter = Math.abs(p.y - gk.y);
      if (gkOffCenter > 60) sc += 0.12; // keeper badly positioned
      else if (gkOffCenter < 25) sc -= 0.08; // keeper well positioned
      if (Math.abs(gk.x - gx) > 50) sc += 0.08; // keeper off line
    }
    if (depthToGoal < 100) sc += 0.12;
    if (depthToGoal < 60) sc += 0.10;
    if (p.role === 'CF') sc += 0.11;
    if (p.role === 'CM') sc -= 0.05;
    if (Math.abs(p.y - PITCH_H / 2) > 100) sc -= 0.08;
    if (angleDeg < 7.5 && shotDistance > 150) sc -= 0.08;
    sc -= Math.min(0.24, per.pressureCount * 0.09);
    if (ctx.urgency > 0.6 && depthToGoal < 350) sc += 0.08;
    const credibleOpening = angleDeg >= 7.5 || shotDistance < 115;
    if (depthToGoal < 120 && credibleOpening) sc += 0.35;
    if (depthToGoal < 70 && credibleOpening) sc += 0.25;
    // cross→shot: just received from wide player → shoot first time in box
    if (depthToGoal < 190 && angleDeg > 8 && this.e.isRecentFinishingDeliveryReceiver(p.id)) sc += 0.46;
    return { type: 'shoot', score: clamp(sc, 0, 1), audit };
  }

  private cd(per: P, _ctx: GC): A {
    const p = this.player; const gx = p.team === 'home' ? AWAY_GOAL_X : HOME_GOAL_X; let tx = gx, ty = p.y;
    if (per.nearestOpponentDist < 50) { const n = per.nearbyOpponents.sort((a, b) => dist(p, a) - dist(p, b))[0];
      if (n) { const ax = p.x - n.x, ay = p.y - n.y, ad = Math.sqrt(ax * ax + ay * ay); if (ad > 1) { tx = p.x + (ax / ad) * 70; ty = p.y + (ay / ad) * 70; } } }
    if (p.y < 60) ty = Math.max(ty, p.y + 40); if (p.y > PITCH_H - 60) ty = Math.min(ty, p.y - 40);
    if (p.x < 60) tx = Math.max(tx, p.x + 40); if (p.x > PITCH_W - 60) tx = Math.min(tx, p.x - 40);
    tx = lerp(tx, gx, 0.3); let sc = 0.30;
    if (per.nearestOpponentDist > 80) sc += 0.10; if (per.nearestOpponentDist < 40) sc -= 0.10; if (Math.abs(p.x - gx) < 200) sc += 0.10;
    const m = Math.sqrt((p.x - this.lx) ** 2 + (p.y - this.ly) ** 2); if (this.ht > 60 && m < 3) sc -= 0.20; if (this.ht > 180) sc -= 0.30;
    const nd = per.nearbyOpponents.filter(o => dist(p, o) < 80).length; if (nd >= 3) sc -= 0.15; if (nd >= 5) sc -= 0.20;
    // WM: take on defenders in wide areas
    if (p.role === 'WM' && Math.abs(p.y - PITCH_H/2) > 120) sc += 0.08;
    // WM: dribble at opponent fullback when 1v1
    if (p.role === 'WM') {
      const inWide = Math.abs(p.y - PITCH_H / 2) > 140;
      const nearOppBox = Math.abs(p.x - gx) < 350;
      if (inWide) {
        sc += 0.15; // stay wide, attack the flank
        if (per.nearestOpponentDist < 60) sc += 0.08; // take on the defender
      }
      if (nearOppBox && per.nearestOpponentDist > 50) sc += 0.10; // space near box
      // cut inside toward goal when in final third
      if (inWide && nearOppBox) {
        tx = lerp(tx, gx, 0.5);
        ty = lerp(ty, PITCH_H / 2, 0.3); // cut inside
      }
    }
    // CM: drive forward when there's space ahead — box-to-box engine
    if (p.role === 'CM' && per.nearestOpponentDist > 60) sc += 0.12;
    if (p.role === 'CM' && Math.abs(p.x - gx) < 250) sc += 0.06; // near box, keep going
    return { type: 'dribble', score: clamp(sc, 0, 1), posX: clamp(tx, 35, PITCH_W - 35), posY: clamp(ty, 35, PITCH_H - 35) };
  }

  private ct(per: P, _ctx: GC): A {
    if (per.ballIsLoose || per.ballControllerTeam === this.player.team || !per.ballControllerTeam) return { type: 'tackle', score: 0 };
    const ctrl = this.e.playerById(per.ballControllerId); if (!ctrl) return { type: 'tackle', score: 0 };
    const d = dist(this.player, ctrl); if (d > TACKLE_RANGE + 30) return { type: 'tackle', score: 0 };
    const isDef = this.player.role === 'CB' || this.player.role === 'FB';
    if (isDef) {
      if (this.player.role === 'CB') {
        const fd = this.player.team === 'home' ? 1 : -1;
        if (!(fd === 1 ? ctrl.x < PITCH_W * 0.5 : ctrl.x > PITCH_W * 0.5)) return { type: 'tackle', score: 0 };
      }
      // FB: tackle wide/attacking players on their flank anywhere on pitch
      if (this.player.role === 'FB') {
        const onMyFlank = Math.abs(ctrl.y - this.player.homeY) < 250;
        const isAttacker = ctrl.role === 'WM' || ctrl.role === 'CF' || ctrl.role === 'CM';
        if (!onMyFlank || !isAttacker) return { type: 'tackle', score: 0 };
      }
    }
    let sc = this.player.role === 'FB' ? 0.50 - (d / 60) * 0.35 + attrFactor(this.player.attrs, 'tackling') * 0.18 : this.player.role === 'CB' ? 0.68 - (d / 60) * 0.35 + attrFactor(this.player.attrs, 'tackling') * 0.22 : 0.6 - (d / 60) * 0.4 + attrFactor(this.player.attrs, 'tackling') * 0.20;
    if (this.player.role === 'CM') sc += 0.06; // midfield ball-winner
    if (this.player.role === 'CF') sc -= 0.15; // strikers press less
    if (this.player.role === 'WM') sc -= 0.04; // wingers press moderately
    if (d < TACKLE_RANGE + 10) sc += 0.15;
    const defensiveTask = this.e.assignmentFor(this.player.id);
    if (defensiveTask?.opponentId === ctrl.id && defensiveTask.role === 'primary_press') sc += 0.20;
    if (defensiveTask?.opponentId === ctrl.id && defensiveTask.role === 'secondary_press') sc += 0.10;
    if (defensiveTask && defensiveTask.role !== 'primary_press' && defensiveTask.role !== 'secondary_press'
      && Math.abs(ctrl.x - (this.player.team === 'home' ? HOME_GOAL_X : AWAY_GOAL_X)) > 170) sc -= 0.20;
    // first-touch shield: can't immediately tackle a receiver
    if (this.e.isCarrierShielded(ctrl.id)) sc -= 0.20;
    // carrier near our goal? must engage — tackle urgency
    const ownGoalX = this.player.team === 'home' ? HOME_GOAL_X : AWAY_GOAL_X;
    if (Math.abs(ctrl.x - ownGoalX) < 220) sc += 0.18; // in/around our box
    if (Math.abs(ctrl.x - ownGoalX) < 120) sc += 0.12; // deep in our box
    // pressing trigger: carrier unpressured in dangerous area — must close down
    if (Math.abs(ctrl.x - ownGoalX) < 300 && per.nearbyOpponents.filter(o => dist(o, ctrl) < 60).length < 2) sc += 0.08;
    // intelligent pressing: opponent facing wrong way = easier to tackle
    const oppFacingAway = ctrl.team === 'home' ? ctrl.vx < 0 : ctrl.vx > 0;
    if (oppFacingAway && d < TACKLE_RANGE + 20) sc += 0.10;
    sc += (this.e.configFor(this.player.team).aggression / 100) * 0.10;
    return { type: 'tackle', score: clamp(sc, 0, 1), target: ctrl };
  }

  private cm(per: P, _ctx: GC): A {
    if (this.player.role !== 'CB' && this.player.role !== 'FB') return { type: 'mark', score: 0 };
    if (per.ballControllerTeam === this.player.team && !per.ballIsLoose) return { type: 'mark', score: 0 };
    if (per.ballIsLoose && per.intendedId !== null) { const t = this.e.playerById(per.intendedId);
      if (t && t.team !== this.player.team && (t.role === 'CF' || t.role === 'WM')) { const d = dist(this.player, t); if (d < 300) return { type: 'mark', score: clamp(0.65 - (d / 300) * 0.3, 0, 1), target: t }; } }
    let best: Player | null = null, bd = Infinity;
    const ownGx = this.player.team === 'home' ? HOME_GOAL_X : AWAY_GOAL_X;
    const isFb = this.player.role === 'FB';
    for (const o of this.e.players) { if (o.team === this.player.team || o.role === 'GK') continue;
      // FB: only mark wide players (WM) and close midfielders on their flank
      if (isFb && o.role !== 'WM' && (o.role !== 'CM' || Math.abs(o.y - this.player.homeY) > 200)) continue;
      // CB: only mark central threats (CF, CM) — leave wide players to FBs
      if (!isFb && o.role !== 'CF' && o.role !== 'CM') continue;
      const d = dist(this.player, o); const danger = Math.abs(o.x - ownGx);
      let score = d * 0.6 + danger * 0.4;
      // FB: heavily prefer WM on their flank
      if (isFb) {
        const onFlank = Math.abs(o.y - this.player.homeY) < 220;
        if (onFlank && o.role === 'WM') score -= 80;
        else if (!onFlank && o.role === 'WM') score += 20;
        else if (o.role === 'CM') score -= 15;
      }
      // CB: strongly prefer CF (direct threat), then CM
      if (!isFb) {
        if (o.role === 'CF') score -= 60;
        else if (o.role === 'CM') score -= 20;
      }
      if (score < bd && d < 300) { bd = score; best = o; } }
    if (!best) return { type: 'mark', score: 0 };
    const dangerDist = dist(this.player, best);
    const baseScore = isFb ? 0.60 : 0.50;
    return { type: 'mark', score: clamp(baseScore + attrFactor(this.player.attrs, 'positioning') * 0.25 - (dangerDist / 300) * 0.25, 0, 1), target: best };
  }

  private cc(per: P): A {
    const b = this.e.ball;
    const isIntendedReceiver = this.player.id === b.intendedReceiverId;
    const ballSpeed = Math.sqrt(b.vx ** 2 + b.vy ** 2);
    const needsRecovery = b.z <= 20 && ballSpeed < 30 && per.amClosestToBall;
    if (!per.ballIsLoose || !this.e.canContestBall(this.player) || (!isIntendedReceiver && per.ballDist > 180 && !needsRecovery)) return { type: 'chase', score: 0 };
    if (isIntendedReceiver) {
      const lead = ballSpeed > 30 ? 0.3 + Math.min(ballSpeed / 200, 0.8) : 0;
      return {
        type: 'chase',
        score: 1,
        posX: clamp(b.x + b.vx * lead, 10, PITCH_W - 10),
        posY: clamp(b.y + b.vy * lead, 10, PITCH_H - 10),
        purpose: 'receive_ball',
      };
    }
    if (needsRecovery) {
      return { type: 'chase', score: 1, posX: clamp(b.x, 10, PITCH_W - 10), posY: clamp(b.y, 10, PITCH_H - 10), purpose: 'recover_loose_ball' };
    }
    const isDef = this.player.role === 'CB' || this.player.role === 'FB';
    if (isDef) {
      if (this.player.role === 'FB') {
        const onMyFlank = this.player.homeY < PITCH_H / 2 ? this.e.ball.y < PITCH_H * 0.55 : this.e.ball.y > PITCH_H * 0.45;
        if (per.ballDist > 100 && !onMyFlank) return { type: 'chase', score: 0 };
      }
      if (this.player.role === 'CB') {
        const ballInOwnHalf = this.player.team === 'home' ? this.e.ball.x < PITCH_W * 0.6 : this.e.ball.x > PITCH_W * 0.4;
        if (per.ballDist > 120 && !ballInOwnHalf) return { type: 'chase', score: 0 };
      }
    }
    // CM: chase balls in middle third, not full-pitch — conserve energy for passing lanes
    if (this.player.role === 'CM' && per.ballDist > 100) {
      const ballInMiddle = this.e.ball.x > PITCH_W * 0.25 && this.e.ball.x < PITCH_W * 0.75;
      if (!ballInMiddle) return { type: 'chase', score: 0 };
    }
    // WM: chase balls on their flank only — don't chase across the pitch
    if (this.player.role === 'WM' && per.ballDist > 80) {
      const onMyFlank = this.player.homeY < PITCH_H / 2 ? this.e.ball.y < PITCH_H * 0.55 : this.e.ball.y > PITCH_H * 0.45;
      if (!onMyFlank) return { type: 'chase', score: 0 };
    }
    // CF: chase in attacking third and loose balls near the box — stay high, don't track back
    if (this.player.role === 'CF' && per.ballDist > 80) {
      const oppGx = this.player.team === 'home' ? AWAY_GOAL_X : HOME_GOAL_X;
      const ballNearOppGoal = Math.abs(this.e.ball.x - oppGx) < 200;
      if (!ballNearOppGoal) return { type: 'chase', score: 0 };
    }
    let sc = per.ballDist < 50 ? 0.90 : per.ballDist < 100 ? 0.75 : 0.55; sc -= per.ballDist / 180 * 0.3;
    if (per.amClosestToBall) sc += 0.12;
    if (per.anyOpponentCloserToBall) { const ms = attrFactor(this.player.attrs, 'speed') * SPEED_SPRINT; if (per.ballDist / Math.max(ms, 1) < 1.5) sc += 0.10; }
    const bs = ballSpeed;
    // ball trajectory anticipation: lead the ball further for fast balls
    const la = bs > 30 ? 0.3 + Math.min(bs / 200, 0.8) : 0;
    // ball heading toward me? boost chase score — I'm the natural interceptor
    if (bs > 15 && per.ballDist > 20) {
      const toMeX = this.player.x - b.x, toMeY = this.player.y - b.y;
      const toMeDist = Math.sqrt(toMeX * toMeX + toMeY * toMeY);
      if (toMeDist > 1) {
        const dot = (b.vx * toMeX + b.vy * toMeY) / (bs * toMeDist);
        if (dot > 0.4) sc += 0.12; // ball moving roughly toward me
        if (dot > 0.7) sc += 0.10; // ball coming straight at me
      }
    }
    // danger zone: ball near our goal — must chase regardless of other options
    if (isDef) {
      const ownGoalX = this.player.team === 'home' ? HOME_GOAL_X : AWAY_GOAL_X;
      if (Math.abs(b.x - ownGoalX) < 250) sc += 0.20;
      if (Math.abs(b.x - ownGoalX) < 150) sc += 0.15;
    }
    return { type: 'chase', score: clamp(sc, 0, 1), posX: clamp(b.x + b.vx * la, 10, PITCH_W - 10), posY: clamp(b.y + b.vy * la, 10, PITCH_H - 10) };
  }

  private bp(per: P, ctx: GC): A[] {
    const p = this.player, b = this.e.ball, fd = p.team === 'home' ? 1 : -1, ip = this.e.teamInPossession(), my = per.ballControllerTeam === p.team;
    const committedRun = this.e.committedRunFor(p.id);
    if (committedRun) {
      return [{ type: 'position', score: 1, posX: committedRun.targetX, posY: committedRun.targetY, purpose: 'timed_run' }];
    }
    const phase = this.e.teamPhaseFor(p.team);
    const ba = fd === 1 ? b.x / PITCH_W : 1 - b.x / PITCH_W, pu = my ? ba * 180 : 0;
    const iw = p.role === 'FB' || p.role === 'WM', wp = (iw && my) ? ba * 60 : 0;
    const c: { x: number; y: number; pur: string }[] = [
      { x: p.homeX + pu + wp, y: p.homeY, pur: 'cover' }, { x: p.homeX + fd * 30 + pu + wp, y: p.homeY, pur: 'cover' },
      { x: p.homeX - fd * 20 + pu + wp, y: p.homeY, pur: 'cover' }, { x: p.homeX + pu + wp, y: p.homeY - 25, pur: 'cover' },
      { x: p.homeX + pu + wp, y: p.homeY + 25, pur: 'cover' }, { x: lerp(p.homeX, b.x, 0.15) + pu, y: lerp(p.homeY, b.y, 0.10), pur: 'cover' },
    ];
    // space utilization: shift toward less congested flank
    const topCount = this.e.players.filter(o => o.y < PITCH_H / 2 && dist(p, o) < 200).length;
    const botCount = this.e.players.filter(o => o.y >= PITCH_H / 2 && dist(p, o) < 200).length;
    const openFlank = topCount < botCount ? -1 : 1;
    c.push({ x: p.homeX + pu, y: clamp(p.homeY + openFlank * 50, 40, PITCH_H - 40), pur: 'cover' });
    if (!my && !per.ballIsLoose && per.ballControllerTeam !== null) {
      const og = p.team === 'home' ? HOME_GOAL_X : AWAY_GOAL_X, rx = clamp(lerp(p.x, og, 0.5), og, p.x);
      c.push({ x: rx, y: p.homeY, pur: 'cover' }, { x: rx, y: p.homeY - 30, pur: 'cover' }, { x: rx, y: p.homeY + 30, pur: 'cover' });
      // through-ball reaction: ball behind us? sprint back harder
      const ballPastUs = fd === 1 ? b.x > p.x + 20 : b.x < p.x - 20;
      if (ballPastUs && (p.role === 'CB' || p.role === 'FB' || p.role === 'CM')) {
        c.push({ x: rx - fd * 30, y: p.homeY, pur: 'cover' }, { x: rx - fd * 30, y: p.homeY - 25, pur: 'cover' });
      }
    }
    if (per.ballDist > 150) {
      if (my && ip === p.team) { c.push({ x: p.homeX + fd * 60 + pu, y: clamp(p.homeY + (p.homeY < PITCH_H / 2 ? 40 : -40), 50, PITCH_H - 50), pur: 'offer' });
        if (p.role === 'WM' || p.role === 'FB') c.push({ x: p.homeX + fd * 40 + pu, y: clamp(p.homeY + (p.homeY < PITCH_H / 2 ? -50 : 50), 40, PITCH_H - 40), pur: 'space' }); }
      else if (!my) { c.push({ x: p.homeX - fd * 40, y: p.homeY, pur: 'cover' });
        if (p.role === 'CM' || p.role === 'CF') c.push({ x: lerp(p.homeX, b.x, 0.3), y: lerp(p.homeY, b.y, 0.2), pur: 'cover' }); }
    }
    // observe: walk toward play when far from ball — stay engaged but conserve energy
    if (per.ballDist > 250 && !per.iAmController) {
      c.push({ x: lerp(p.x, b.x, 0.15), y: lerp(p.y, b.y, 0.12), pur: 'observe' });
      c.push({ x: lerp(p.x, b.x, 0.10), y: clamp(lerp(p.y, b.y, 0.08), 40, PITCH_H - 40), pur: 'observe' });
    }
    // press resistance: when teammate carrier is pressured, move closer to offer support
    if (my && !per.iAmController) {
      const carrier = this.e.playerById(this.e.ball.controllerId);
      if (carrier && carrier.team === p.team) {
        const carrierPressure = this.e.players.filter(o => o.team !== p.team && o.role !== 'GK' && dist(o, carrier) < 60).length;
        if (carrierPressure >= 2) {
          c.push({ x: lerp(p.x, carrier.x, 0.3), y: lerp(p.y, carrier.y, 0.25), pur: 'offer' });
          c.push({ x: lerp(p.x, carrier.x, 0.2), y: clamp(lerp(p.y, carrier.y, 0.15), 40, PITCH_H - 40), pur: 'offer' });
        }
      }
    }
    if (my && ip === p.team) {
      c.push({ x: p.homeX + fd * 80 + pu, y: p.homeY, pur: 'offer' }, { x: p.homeX + fd * 50 + pu, y: p.homeY - 35, pur: 'space' }, { x: p.homeX + fd * 50 + pu, y: p.homeY + 35, pur: 'space' });
      // one-two: I just passed — sprint forward to receive the return
      const bb2 = this.e.teamBlackboards.get(p.team)!;
      if (bb2.oneTwo && bb2.oneTwo.from === p.id && this.e.clockMs < bb2.oneTwo.expires) {
        const oppGoalX = p.team === 'home' ? AWAY_GOAL_X : HOME_GOAL_X;
        c.push({ x: clamp(p.x + fd * 80, p.homeX + fd * 40, oppGoalX), y: p.y, pur: 'space' });
        c.push({ x: clamp(p.x + fd * 120, p.homeX + fd * 60, oppGoalX), y: clamp(p.y - 30, 40, PITCH_H - 40), pur: 'space' });
        c.push({ x: clamp(p.x + fd * 120, p.homeX + fd * 60, oppGoalX), y: clamp(p.y + 30, 40, PITCH_H - 40), pur: 'space' });
      }
      // counter-attack: sprint forward aggressively
      if (phase === 'attacking_transition' && (p.role === 'CF' || p.role === 'WM' || p.role === 'CM')) {
        const oppGoalX = p.team === 'home' ? AWAY_GOAL_X : HOME_GOAL_X;
        c.push({ x: clamp(lerp(p.x, oppGoalX, 0.6), p.x + fd * 50, oppGoalX), y: p.homeY, pur: 'space' });
        c.push({ x: clamp(lerp(p.x, oppGoalX, 0.5), p.x + fd * 40, oppGoalX), y: p.homeY - 30, pur: 'space' });
      }
      // box runs: crash the area when teammate advancing in final third
      if (ba > 0.6 && (p.role === 'CF' || p.role === 'CM' || p.role === 'WM')) {
        const bGoalX = p.team === 'home' ? AWAY_GOAL_X : HOME_GOAL_X;
        c.push({ x: bGoalX - fd * (30 + random() * 70), y: clamp(PITCH_H / 2 + (p.homeY - PITCH_H / 2) * 0.4, PITCH_H * 0.25, PITCH_H * 0.75), pur: 'space' });
        c.push({ x: bGoalX - fd * (50 + random() * 50), y: clamp(PITCH_H / 2 + (random() - 0.5) * 80, PITCH_H * 0.20, PITCH_H * 0.80), pur: 'space' });
      }
      // CM: find gaps between opponent lines
      if (p.role === 'CM') {
        const oppMids = this.e.players.filter(o => o.team !== p.team && (o.role === 'CM' || o.role === 'WM'));
        const oppDefs = this.e.players.filter(o => o.team !== p.team && (o.role === 'CB' || o.role === 'FB'));
        if (oppMids.length > 0 && oppDefs.length > 0) {
          const midLine = oppMids.reduce((s, o) => s + o.x, 0) / oppMids.length;
          const defLine = oppDefs.reduce((s, o) => s + o.x, 0) / oppDefs.length;
          const gapX = (midLine + defLine) / 2;
          c.push({ x: clamp(gapX, p.homeX - 40, p.homeX + 120), y: p.homeY, pur: 'offer' });
          c.push({ x: clamp(gapX, p.homeX - 40, p.homeX + 120), y: clamp(p.homeY - 40, 40, PITCH_H - 40), pur: 'space' });
        }
        // drop deep to receive from defence when team is building up
        if (ba < 0.35 && my) {
          c.push({ x: clamp(p.homeX - fd * 30, 60, PITCH_W - 60), y: p.homeY, pur: 'offer' });
          c.push({ x: clamp(p.homeX - fd * 20, 60, PITCH_W - 60), y: clamp(p.homeY + 35, 40, PITCH_H - 40), pur: 'offer' });
        }
        // support wingers: shift toward active flank
        const bSide = b.y < PITCH_H / 2 ? -1 : 1;
        c.push({ x: clamp(p.homeX + fd * 30 + pu, 60, PITCH_W - 60), y: clamp(p.homeY + bSide * 50, 40, PITCH_H - 40), pur: 'space' });
      }
      // WM: attack the flank — stay wide, run behind, cut inside
      if (p.role === 'WM') {
        // hug the touchline when team advances
        const flankY = p.homeY < PITCH_H / 2 ? 35 : PITCH_H - 35;
        c.push({ x: clamp(p.homeX + fd * 80 + pu, 60, PITCH_W - 60), y: flankY, pur: 'space' });
        // diagonal run behind the fullback
        const runBehindY = p.homeY < PITCH_H / 2 ? PITCH_H * 0.3 : PITCH_H * 0.7;
        c.push({ x: clamp(p.homeX + fd * 140 + pu, 60, AWAY_GOAL_X - fd * 20), y: runBehindY, pur: 'space' });
        // cut inside when ball is on opposite flank — arrive at far post
        if (Math.abs(b.y - p.homeY) > 200) {
          c.push({ x: clamp(p.homeX + fd * 100 + pu, 60, PITCH_W - 60), y: clamp(lerp(p.y, PITCH_H / 2, 0.3), 40, PITCH_H - 40), pur: 'space' });
          c.push({ x: clamp(p.homeX + fd * 80 + pu, 60, PITCH_W - 60), y: clamp(PITCH_H / 2 + (p.homeY < PITCH_H / 2 ? 80 : -80), 40, PITCH_H - 40), pur: 'space' });
        }
      }
      if (p.role === 'CB' || p.role === 'FB') c.push({ x: p.homeX + fd * 150 + pu, y: p.homeY, pur: 'cover' });
      const fld = b.y < PITCH_H / 2 ? -1 : 1;
      c.push({ x: p.homeX + fd * 55 + pu, y: clamp(p.homeY + fld * 50, 40, PITCH_H - 40), pur: 'space' });
      c.push({ x: p.homeX + fd * 40 + pu, y: clamp(p.homeY - fld * 70, 40, PITCH_H - 40), pur: 'switch' });
      if (p.role === 'WM' || p.role === 'FB') c.push({ x: p.homeX + fd * 40 + pu, y: clamp(p.homeY + (p.homeY < PITCH_H / 2 ? -80 : 80), 30, PITCH_H - 30), pur: 'space' });
      // FB overlap: when WM on my side has ball, bomb past them into crossing position
      if (p.role === 'FB' && my) {
        const wmOnMySide = this.e.players.find(o => o.team === p.team && o.role === 'WM' && Math.abs(o.homeY - p.homeY) < 100);
        const wmHasBall = wmOnMySide && this.e.ball.controllerId === wmOnMySide.id;
        if (wmHasBall) {
          c.push({ x: clamp(wmOnMySide.x + fd * 80, p.homeX + fd * 80, AWAY_GOAL_X - fd * 20), y: clamp(p.homeY < PITCH_H / 2 ? 35 : PITCH_H - 35, 35, PITCH_H - 35), pur: 'space' });
          c.push({ x: clamp(wmOnMySide.x + fd * 50, p.homeX + fd * 50, AWAY_GOAL_X), y: clamp(p.homeY < PITCH_H / 2 ? 55 : PITCH_H - 55, 40, PITCH_H - 40), pur: 'space' });
        } else {
          const wmHomeY = p.homeY < PITCH_H / 2 ? PITCH_H * 0.12 : PITCH_H * 0.88;
          c.push({ x: p.homeX + fd * 120 + pu, y: clamp(wmHomeY, 40, PITCH_H - 40), pur: 'space' });
        }
      }
      if (p.role === 'CF') { const oo = this.e.players.filter(o => o.team !== p.team && o.role !== 'GK');
        const oppGoalX = p.team === 'home' ? AWAY_GOAL_X : HOME_GOAL_X;
        if (oo.length > 0) { const ld = fd === 1 ? Math.max(...oo.map(o => o.x)) : Math.min(...oo.map(o => o.x));
          const defLine = clamp(ld, p.homeX - 40, oppGoalX + fd * 20);
          c.push({ x: fd === 1 ? Math.min(p.homeX + fd * 100, ld - 15) : Math.max(p.homeX + fd * 100, ld + 15), y: p.homeY, pur: 'offer' });
          // Attack the defensive line while remaining eligible at selection time.
          const runY = clamp(p.homeY + (random() > 0.5 ? 40 : -40), PITCH_H * 0.2, PITCH_H * 0.8);
          c.push({ x: clamp(defLine - fd * 10, p.homeX + fd * 40, oppGoalX), y: runY, pur: 'space' });
        }
        // hold-up: drop slightly to receive ball to feet
        if (ba < 0.5 && my) {
          c.push({ x: clamp(p.homeX - fd * 20, p.homeX - 60, PITCH_W - 60), y: p.homeY, pur: 'offer' });
        }
        // near/far post when ball is wide and in final third
        if (ba > 0.5 && my) {
          const nearPost = p.y < PITCH_H / 2 ? PITCH_H * 0.35 : PITCH_H * 0.65;
          const farPost = p.y < PITCH_H / 2 ? PITCH_H * 0.65 : PITCH_H * 0.35;
          c.push({ x: clamp(oppGoalX - fd * 20, 60, PITCH_W - 60), y: nearPost, pur: 'space' });
          c.push({ x: clamp(oppGoalX - fd * 30, 60, PITCH_W - 60), y: farPost, pur: 'space' });
        }
      }
    }
    // defensive line — move as a unit
    if (!my && (p.role === 'CB' || p.role === 'FB')) {
      // compute mean defensive line position from all CBs + FBs on our team
      let sumX = 0, count = 0;
      let deepestX = p.team === 'home' ? 0 : PITCH_W;
      for (const t of this.e.players) {
        if (t.team !== p.team || t.role === 'GK') continue;
        if (t.role === 'CB' || t.role === 'FB') {
          sumX += t.x; count++;
          const tx = p.team === 'home' ? t.x : PITCH_W - t.x;
          if (tx < (p.team === 'home' ? deepestX : PITCH_W - deepestX)) deepestX = t.x;
        }
      }
      const meanLine = count > 0 ? sumX / count : p.homeX;
      const lineX = clamp(meanLine, p.homeX - 70, p.homeX + 70);
      // primary: hold the defensive line
      c.push({ x: lineX, y: p.homeY, pur: 'cover' });
      c.push({ x: lineX - fd * 15, y: p.homeY, pur: 'cover' });
      // step up together toward halfway when opponent is deep
      if (ba < 0.35) c.push({ x: clamp(p.homeX + fd * 180, lineX + fd * 40, PITCH_W - 50), y: p.homeY, pur: 'cover' });
      // drop together when ball is past us
      const ballPastUs = fd === 1 ? b.x > lineX + 20 : b.x < lineX - 20;
      if (ballPastUs) {
        const dropX = clamp(lerp(lineX, p.team === 'home' ? HOME_GOAL_X : AWAY_GOAL_X, 0.3), p.homeX - 80, p.homeX);
        c.push({ x: dropX, y: p.homeY, pur: 'cover' });
        c.push({ x: dropX - fd * 20, y: p.homeY, pur: 'cover' });
      }
      // shift toward ball side as a unit
      const bSide = b.y < PITCH_H / 2 ? -1 : 1;
      c.push({ x: lineX - fd * 10, y: clamp(p.homeY + bSide * 25, 40, PITCH_H - 40), pur: 'cover' });
      // HIGH LINE: push to halfway when opponent is deep
      if (ba < 0.4) c.push({ x: clamp(p.homeX + fd * 220, p.homeX + 50, PITCH_W - 50), y: p.homeY, pur: 'cover' });
    }
    if (!my) { c.push({ x: clamp((b.x + (p.team === 'home' ? HOME_GOAL_X : AWAY_GOAL_X)) / 2, p.homeX - 80, p.homeX + 20), y: p.homeY, pur: 'cover' });
      const bf2 = b.y < PITCH_H / 2 ? -1 : 1; c.push({ x: clamp(p.homeX - fd * 30, 40, PITCH_W - 40), y: clamp(p.homeY + bf2 * 25, 40, PITCH_H - 40), pur: 'cover' });
      // FB tuck in when ball on opposite flank
      if (p.role === 'FB' && Math.abs(b.y - p.homeY) > 200) {
        c.push({ x: clamp(p.homeX - fd * 20, 40, PITCH_W - 40), y: clamp(lerp(p.homeY, PITCH_H / 2, 0.5), 40, PITCH_H - 40), pur: 'cover' });
      } }
    if (ctx.urgency > 0.6 && my) { c.push({ x: p.homeX + fd * 120 + pu, y: p.homeY, pur: 'offer' }, { x: p.homeX + fd * 90 + pu, y: p.homeY - 40, pur: 'space' }); }
    const options: A[] = c.map(cn => {
      let sf = 0; for (const o of per.nearbyOpponents) { const d = Math.sqrt((cn.x - o.x) ** 2 + (cn.y - o.y) ** 2); if (d < 50) sf -= (50 - d) / 50; }
      const tac = my ? (cn.x - p.homeX) * fd / PITCH_W * 0.5 : -(cn.x - p.homeX) * fd / PITCH_W * 0.25;
      const og2 = p.team === 'home' ? HOME_GOAL_X : AWAY_GOAL_X, db = !my ? clamp(((b.x - cn.x) * fd) / (Math.abs(b.x - og2) + 1), 0, 0.30) : 0;
      const bp = Math.sqrt((cn.x - b.x) ** 2 + (cn.y - b.y) ** 2) / 600 * 0.08;
      const ob = cn.pur === 'observe' ? 0.10 : 0;
      return { type: 'position', score: clamp(0.15 + sf * 0.3 + tac - bp + db + ob, 0, 1), posX: clamp(cn.x, 40, PITCH_W - 40), posY: clamp(cn.y, 40, PITCH_H - 40), purpose: cn.pur };
    });
    const task = this.e.assignmentFor(p.id);
    if (task) {
      const taskScores: Record<TeamAssignmentRole, number> = {
        primary_press: 0.90, secondary_press: 0.78, cover: 0.80, lane_block: 0.76,
        defensive_line: 0.80, wide_cover: 0.80, midfield_screen: 0.80,
        support_outlet: 0.77, advance_midfield: 0.82, run_ahead: 0.85,
        inside_run: 0.84, hold_width: 0.80, overlap: 0.88, rest_defence: 0.76,
      };
      options.push({ type: 'position', score: taskScores[task.role], posX: task.targetX, posY: task.targetY, purpose: `task:${task.role}` });
    }
    return options;
  }

  private rc(a: A[]): A {
    a.sort((x, y) => y.score - x.score); if (a.length === 0) return { type: 'hold', score: 1 };
    const best = a[0];
    // press resistance: carrier holds if no clearly good option exists
    const ic = this.e.ball.controllerId === this.player.id;
    // near goal: don't hold — shoot or pass
    const gx = this.player.team === 'home' ? AWAY_GOAL_X : HOME_GOAL_X;
    const nearGoal = Math.abs(this.player.x - gx) < 180;
    if (ic && best.score < (nearGoal ? 0.15 : 0.25)) return { type: 'hold', score: 1 };
    if (best.score < 0.10) return { type: 'hold', score: 1 };
    const bb = this.e.teamBlackboards.get(this.player.team)!;
    if (best.type === 'tackle' && best.target) {
      const isSelf = bb.pressingPlayerId === this.player.id || bb.pressingPlayerId2 === this.player.id;
      const slot1Free = bb.pressingPlayerId === null;
      const slot2Free = bb.pressingPlayerId2 === null;
      if (!isSelf && !slot1Free && !slot2Free) {
        for (const x of a) if (x.type !== 'tackle' && x.score > 0.15) return x;
        return { type: 'hold', score: 1 };
      }
      if (isSelf) { /* keep pressing */ }
      else if (slot1Free) bb.pressingPlayerId = this.player.id;
      else bb.pressingPlayerId2 = this.player.id;
    }
    if (best.type === 'mark' && best.target) { const al = bb.markedOpponents.get(best.target.id); if (al && al !== this.player.id) { for (const x of a) if (x.type !== 'mark' && x.type !== 'tackle' && x.score > 0.15) return x; return { type: 'hold', score: 1 }; } bb.markedOpponents.set(best.target.id, this.player.id); }
    return best;
  }

  private passSelectionAudit(choice: A, actions: A[]): PassSelectionAudit | undefined {
    const chosen = choice.audit;
    if (!choice.target || chosen?.distance === undefined || chosen.forwardProgress === undefined
      || chosen.expectedCompletion === undefined || chosen.blockers === undefined || chosen.receiverPressure === undefined) return undefined;
    const safer = actions
      .filter(a => a.type === 'pass' && a.target?.id !== choice.target!.id
        && a.audit?.expectedCompletion !== undefined && a.audit.forwardProgress !== undefined
        && a.audit.expectedCompletion >= chosen.expectedCompletion! + 0.12
        && a.audit.forwardProgress >= chosen.forwardProgress! - 35
        && a.score >= choice.score - 0.04)
      .sort((a, b) => (b.audit?.expectedCompletion ?? 0) - (a.audit?.expectedCompletion ?? 0))[0];
    return {
      score: choice.score,
      distance: chosen.distance,
      forwardProgress: chosen.forwardProgress,
      expectedCompletion: chosen.expectedCompletion,
      blockers: chosen.blockers,
      receiverPressure: chosen.receiverPressure,
      purpose: choice.purpose ?? 'keep',
      saferOptionTargetId: safer?.target?.id ?? null,
      saferOptionScore: safer?.score ?? null,
      saferOptionCompletion: safer?.audit?.expectedCompletion ?? null,
      saferOptionProgress: safer?.audit?.forwardProgress ?? null,
    };
  }

  private shotSelectionAudit(choice: A, actions: A[]): ShotSelectionAudit | undefined {
    const shot = choice.audit;
    if (shot?.distance === undefined || shot.angleDeg === undefined || shot.pressureCount === undefined) return undefined;
    const bestPass = actions.filter(a => a.type === 'pass' && a.target).sort((a, b) => b.score - a.score)[0];
    return {
      score: choice.score,
      distance: shot.distance,
      angleDeg: shot.angleDeg,
      pressureCount: shot.pressureCount,
      bestPassTargetId: bestPass?.target?.id ?? null,
      bestPassScore: bestPass?.score ?? null,
      bestPassCompletion: bestPass?.audit?.expectedCompletion ?? null,
    };
  }

  private auditDefensiveMovement(choice: A): void {
    const task = this.e.assignmentFor(this.player.id);
    const controller = this.e.playerById(this.e.ball.controllerId);
    if (!task || !controller || controller.team === this.player.team) return;
    if (task.role !== 'primary_press' && task.role !== 'secondary_press') return;
    if (choice.type === 'tackle' || choice.type === 'chase' || choice.purpose === `task:${task.role}`) return;
    const targetX = choice.target?.x ?? choice.posX ?? this.player.targetX;
    const targetY = choice.target?.y ?? choice.posY ?? this.player.targetY;
    const currentDistance = dist(this.player, controller);
    const targetDistance = Math.hypot(targetX - controller.x, targetY - controller.y);
    const ownGoalX = this.player.team === 'home' ? HOME_GOAL_X : AWAY_GOAL_X;
    const danger = Math.abs(controller.x - ownGoalX) < 240;
    if (!danger && targetDistance <= currentDistance + 12) return;
    this.e.logQualityFlag('why_player_running_direction', {
      player: this.player.id,
      task: task.role,
      controller: controller.id,
      chose: choice.type,
      purpose: choice.purpose ?? null,
      currentDistance: Math.round(currentDistance),
      targetDistance: Math.round(targetDistance),
      danger,
    }, 8000, `why_player_running_direction:${this.player.team}`);
    this.e.captureDecisionMoment('why_player_running_direction', this.player, {
      task: task.role,
      controller: controller.id,
      chose: choice.type,
      purpose: choice.purpose ?? null,
      currentDistance: Math.round(currentDistance),
      targetDistance: Math.round(targetDistance),
      danger,
    }, 8000, `why_player_running_direction:${this.player.team}`);
  }

  private ex(a: A, sdt: number, actions: A[]): void {
    const p = this.player, b = this.e.ball;
    this.la = a.type; this.lastPurpose = a.purpose ?? ''; this.lt = a.target?.id ?? null;
    switch (a.type) {
      case 'pass': if (a.target) {
        const selectionAudit = this.passSelectionAudit(a, actions);
        const released = a.purpose === 'clear'
          ? (this.e.forcePassTo(p, a.target, selectionAudit), true)
          : this.e.passBallTo(p, a.target, a.purpose === 'through', false, selectionAudit);
        if (released) {
          this.lp = a.target.id;
          this.recentPassTarget = a.target.id; this.recentPassTime = this.e.clockMs;
          this.e.emitEvent('pass', p.x, p.y);
          // Trigger one-two only when the ball has actually been released.
          const bb = this.e.teamBlackboards.get(p.team)!;
          bb.oneTwo = { from: p.id, to: a.target.id, expires: this.e.clockMs + 2000 };
          this.sl = 20;
        } else {
          this.sl = 4;
        }
      } break;
      case 'shoot': this.e.shootBall(p, this.shotSelectionAudit(a, actions)); this.e.emitEvent('shot', p.x, p.y); this.sl = 20; break;
      case 'dribble': p.targetX = a.posX ?? (p.team === 'home' ? AWAY_GOAL_X : HOME_GOAL_X); p.targetY = a.posY ?? p.y;
        // backward dribble alert
        const oppGoalX = p.team === 'home' ? AWAY_GOAL_X : HOME_GOAL_X;
        const fd = p.team === 'home' ? 1 : -1;
        if ((fd === 1 && p.targetX < p.x - 10) || (fd === -1 && p.targetX > p.x + 10)) {
          if (Math.abs(p.x - oppGoalX) < 300 && this.e.players.filter(o => o.team !== p.team && o.role !== 'GK' && dist(o, p) < 60).length === 0) {
            this.e.logQualityFlag('backward_dribble', { player: p.id, role: p.role, fromX: Math.round(p.x), toX: Math.round(p.targetX) });
          }
        }
        break;
      case 'tackle': if (a.target && dist(p, a.target) <= TACKLE_RANGE && this.e.attemptTackle(p, a.target)) { this.e.emitEvent('tackle', (p.x + a.target.x) / 2, (p.y + a.target.y) / 2); p.tackleAnim = 300; } else { p.targetX = a.target?.x ?? p.x; p.targetY = a.target?.y ?? p.y; } break;
      case 'mark': if (a.target) { p.targetX = a.target.x; p.targetY = a.target.y; } break;
      case 'chase': { const tx = a.posX ?? b.x, ty = a.posY ?? b.y; p.targetX = tx; p.targetY = ty;
        const ms = attrFactor(p.attrs, 'speed') * SPEED_SPRINT; const cdx = tx - p.x, cdy = ty - p.y, cd = Math.sqrt(cdx * cdx + cdy * cdy);
        if (cd > 1) { p.vx = lerp(p.vx, (cdx / cd) * ms, 0.15); p.vy = lerp(p.vy, (cdy / cd) * ms, 0.15); }
        break; }
      case 'position': p.targetX = a.posX ?? p.homeX; p.targetY = a.posY ?? p.homeY;
        if (a.purpose?.startsWith('task:')) this.e.noteTaskSelection(p, a.purpose.slice(5) as TeamAssignmentRole);
        break;
      case 'hold': if (b.controllerId === p.id) {
        // first touch: shield away from nearest opponent
        const opp = this.e.nearPlayers(p, 60).filter(o => o.team !== p.team).sort((a, b) => dist(p, a) - dist(p, b))[0];
        if (opp) {
          p.targetX = clamp(p.x + (p.x - opp.x) * 0.5, 35, PITCH_W - 35);
          p.targetY = clamp(p.y + (p.y - opp.y) * 0.5, 35, PITCH_H - 35);
        }
        else { p.targetX = clamp(p.team === 'home' ? AWAY_GOAL_X : HOME_GOAL_X, 40, PITCH_W - 40); p.targetY = clamp(p.y + (random() - 0.5) * 20, 40, PITCH_H - 40); }
      } break;
    }
    if (this.e.ball.controllerId !== p.id) {
      this.am(sdt);
      if (a.type === 'chase') this.tryCollectAfterChase();
    }
  }

  private tryCollectAfterChase(): void {
    const p = this.player;
    const b = this.e.ball;
    const distance = dist(p, b);
    if (b.controllerId !== null) return;
    const intended = p.id === b.intendedReceiverId;
    const reach = intended ? INTENDED_COLLECT_DIST : COLLECT_DIST;
    if (b.z >= 20 || distance > reach) return;
    const speed = Math.hypot(b.vx, b.vy);
    const speedLimit = intended ? COLLECT_SPEED_MAX * INTENDED_COLLECT_BONUS : COLLECT_SPEED_MAX;
    if (speed >= speedLimit || !this.e.collectBall(p, intended ? 'intended_chase_reception' : 'chase_collection', reach)) return;
    const firstTimeChance = this.e.isRecentFinishingDeliveryReceiver(p.id);
    this.sl = firstTimeChance ? 0 : 45;
    this.sc = firstTimeChance ? 0 : 15;
  }

  private gp(): P | null { this.pa++; if (this.ch && this.pa < 3) return this.ch; this.ch = this.pr(); this.pa = 0; return this.ch; }
  private pr(): P {
    const p = this.player, b = this.e.ball; const dx = b.x - p.x, dy = b.y - p.y, bd = Math.sqrt(dx * dx + dy * dy);
    const nt: Player[] = [], no: Player[] = []; let nd = Infinity, pc = 0;
    for (const o of this.e.players) { if (o.id === p.id) continue; const d = dist(p, o); if (d > PLAYER_AWARE_RANGE) continue;
      // vision cone: 120° normally, 180° for defenders in own defensive third
      const inCone = (() => {
        if (d < 40) return true; // very close — can hear/feel them
        const angleTo = Math.atan2(o.y - p.y, o.x - p.x);
        const diff = Math.abs(angleTo - this.facing);
        const nd = diff > Math.PI ? 2 * Math.PI - diff : diff;
        // defenders in own third get near-full awareness (180°)
        const isOwnThird = p.team === 'home' ? b.x < PITCH_W / 3 : b.x > PITCH_W * 2 / 3;
        const defenderWide = (p.role === 'CB' || p.role === 'FB') && isOwnThird;
        return nd < (defenderWide ? Math.PI / 2 : Math.PI / 3); // 90° or 60° half-angle
      })();
      if (!inCone) continue;
      if (o.team === p.team) nt.push(o); else { no.push(o); if (d < nd) nd = d; if (d < 60) pc++; } }
    const ctrl = this.e.playerById(b.controllerId);
    const possessionTeam = ctrl?.team ?? this.e.teamInPossession() ?? null;
    let ac = true, ao = false, cc = 0, ctd = Infinity;
    for (const o of this.e.players) { if (o.id === p.id || o.role === 'GK') continue; const d = dist(o, b);
      // ball-relative checks ignore vision cone — you know where the ball and nearby players are
      if (o.team === p.team && d < bd) { cc++; if (d < ctd) ctd = d; } if (o.team !== p.team && d < bd) ao = true; }
    if (cc > 0 && ctd < bd - 30) ac = false;
    return { ballDist: bd, ballIsLoose: b.controllerId === null, ballControllerTeam: possessionTeam, ballControllerId: b.controllerId, nearbyTeammates: nt, nearbyOpponents: no, nearestOpponentDist: nd, iAmController: b.controllerId === p.id, amClosestToBall: ac, chasingTeammatesCount: cc, anyOpponentCloserToBall: ao, pressureCount: pc, intendedId: b.intendedReceiverId };
  }

  private am(sdt: number): void {
    const p = this.player; if (p.role === 'GK') return; const secs = sdt / 1000;
    const spd = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
    if (spd > SPEED_SPRINT * 0.5) p.stamina = Math.max(0, p.stamina - STAMINA_DRAIN_SPRINT);
    else if (spd < 15) p.stamina = Math.min(100, p.stamina + STAMINA_RECOVER);
    const sf = p.stamina < STAMINA_SLOW_THRESHOLD * 100 ? p.stamina / 100 : 1;
    const dx = p.targetX - p.x, dy = p.targetY - p.y, d = Math.sqrt(dx * dx + dy * dy);
    const committedRun = this.e.committedRunFor(p.id) !== undefined;
    const pressTask = this.lastPurpose === 'task:primary_press';
    const committedChase = this.la === 'chase' && this.e.ball.controllerId === null
      && (this.lastPurpose === 'receive_ball' || this.lastPurpose === 'recover_loose_ball');
    // Called-for runs, loose-ball chases and an urgent primary press must actually engage at sprint pace.
    const bdx = this.e.ball.x - p.x, bdy = this.e.ball.y - p.y, bd = Math.sqrt(bdx * bdx + bdy * bdy);
    const ownGoalX = p.team === 'home' ? HOME_GOAL_X : AWAY_GOAL_X;
    const committedPress = pressTask && bd > 45 && (bd < 145 || Math.abs(this.e.ball.x - ownGoalX) < 240);
    const isObserving = !committedRun && !committedChase && !committedPress && bd > 300 && bd > PLAYER_AWARE_RANGE * 0.5;
    const cruiseMul = isObserving ? (p.role === 'CF' ? 0.45 : p.role === 'CB' || p.role === 'FB' ? 0.65 : p.role === 'WM' ? 0.55 : 0.50) : 1;
    const baseSpeed = this.la === 'chase' || committedRun || committedPress ? SPEED_SPRINT : SPEED_RUN;
    const df = committedRun || committedChase || committedPress ? 1 : Math.min(d / 120, 1.5), ms = attrFactor(p.attrs, 'speed') * baseSpeed * sf * df * cruiseMul;
    const px = p.x, py = p.y; if (d > 1) { const sp = Math.min(ms * secs, d); p.x += (dx / d) * sp; p.y += (dy / d) * sp; }
    if (secs > 0.001) { p.vx = (p.x - px) / secs; p.vy = (p.y - py) / secs; }
    // ball tracking: update memory when ball is in vision cone, otherwise age it
    const bAngle = Math.atan2(this.e.ball.y - p.y, this.e.ball.x - p.x);
    const bDiff = Math.abs(bAngle - this.facing);
    const bNorm = bDiff > Math.PI ? 2 * Math.PI - bDiff : bDiff;
    if (bNorm < Math.PI / 3) {
      // ball visible: update memory
      this.ballMemX = this.e.ball.x; this.ballMemY = this.e.ball.y; this.ballMemAge = 0;
    } else {
      this.ballMemAge++;
    }
    // update facing: carriers face opponent goal, movers face travel direction, stationary glance
    const spdAfter = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
    const ic = this.e.ball.controllerId === p.id;
    if (ic) {
      // carrier: face opponent's goal — prevents spinning
      const oppGoalX = p.team === 'home' ? AWAY_GOAL_X : HOME_GOAL_X;
      const goalAngle = Math.atan2(PITCH_H / 2 - p.y, oppGoalX - p.x);
      this.facing = this.facing + Math.atan2(Math.sin(goalAngle - this.facing), Math.cos(goalAngle - this.facing)) * 0.25;
    } else if (spdAfter > 5) {
      const moveAngle = Math.atan2(p.vy, p.vx);
      this.facing = this.facing + Math.atan2(Math.sin(moveAngle - this.facing), Math.cos(moveAngle - this.facing)) * 0.3;
    } else if (this.ballMemAge > 30) {
      // glance at last known ball position every ~500ms when unsure
      const memAngle = Math.atan2(this.ballMemY - p.y, this.ballMemX - p.x);
      this.facing = this.facing + Math.atan2(Math.sin(memAngle - this.facing), Math.cos(memAngle - this.facing)) * 0.08;
    }
    p.facing = this.facing;
  }
}
