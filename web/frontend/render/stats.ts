// ── live stats + momentum (the PRESSURE panel) ── extracted from renderer.ts (Round: renderer-split).
// MatchRenderer owns exactly one of these and drives it from sync(): accStatEvent() is called from inside
// updateTicker's seenEventKeys guard (so the tallies and the match feed count the same event exactly
// once), updateMomentum() integrates the per-frame terms straight after, and renderStatPanel() paints.
// The renderer reads three things back — statPanelEl (to dock and to tear down), homeAttacksX (the byline
// cue and the goal celebration both need the attacking direction) and shots/xgSeries (the 📊 panel).
import { PITCH_W, PITCH_H, GOAL_W } from '../constants';
import { buildStatPanel } from './hud';
import type { StatCells } from './hud';
import type { EngineState } from '../types';

// FM-style live player rating, ticking off the SAME model as the post-match report
// (report.ts ratePlayer) but from the frame's running per-player stats: base 6.5, lifted by
// attacking returns + tackles, with clean-sheet / GK-concession / result / card adjustments.
// The frame carries no per-player passes, so the (bounded ±0.5) distribution term is dropped;
// win/lose/conceded read the LIVE scoreline, so a rating shifts the moment the score does.
export function liveRating(p: EngineState['players'][number], homeScore: number, awayScore: number): number {
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

export class MatchStats {
  // ── live stats + momentum ("PRESSURE" panel) ── per-team tallies accumulated off the SAME
  // de-duped event loop as the feed (so a goal counts once), plus a signed momentum scalar.
  statPanelEl: HTMLDivElement | null = null;
  private statCells: StatCells = { ot: null, xg: null, big: null, cor: null, foul: null, off: null };
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
  shots: { x: number; y: number; xg: number; side: number; goal: boolean }[] = [];
  xgSeries: { t: number; h: number; a: number }[] = [];
  private momentum = 0;                   // signed pressure, [-100 home .. +0 .. neutral], +home
  private displayMomentum = 0;            // eased toward `momentum` for a gliding bar
  private ballXEma = PITCH_W / 2;         // smoothed ball x for the territory term
  private momPrevClock = 0;               // own dt source (the ticker overwrites lastClockMs first)
  homeAttacksX: number | null = null;   // 0 or PITCH_W — derived from the home keeper's side
  private goalFlashUntil = 0;             // performance.now() deadline for the bar pulse
  private lastSetPieceType: string | null = null;   // corner edge-detection

  // ── PRESSURE panel: build, accumulate, animate ──────────────────────────────
  // Build the panel (detached — screenWatch docks it via MatchRenderer.dockStats). Called from
  // MatchRenderer.init() at exactly the point the old private buildStatPanel() was.
  buildPanel(): void {
    const built = buildStatPanel();
    this.statPanelEl = built.panel; this.statCells = built.cells;
    this.statBarHome = built.barHome; this.statBarAway = built.barAway; this.statBarWrap = built.barWrap;
  }

  // Tally one NEW (de-duped) notable event into the stat counters + momentum. Called from
  // updateTicker inside the seenEventKeys guard, so each event lands exactly once.
  accStatEvent(ev: EngineState['events'][number], byId: Map<number, EngineState['players'][number]>,
               evClock = 0): void {
    const sideOf = (id: number | null | undefined): number => {
      const t = id != null ? byId.get(id)?.team : undefined;
      return t === 'home' ? 1 : t === 'away' ? -1 : 0;
    };
    const type = ev.type;
    // Round-30: on an OWN goal the event's playerId is a defender of the side that
    // CONCEDED, so the raw side credits xG, the shot-map dot and shots-on-target to
    // the wrong team. Flip it for that one case; every other event is unaffected.
    const scoringSideOf = (id: number | null | undefined): number => {
      const s = sideOf(id);
      return ev.ownGoal ? -s : s;
    };
    // xG proxy (direction-agnostic: distance to the NEAREST goal, since shots go toward a goal)
    if (type === 'shot' || type === 'goal') {
      const dy = ev.y - PITCH_H / 2;
      const d = Math.min(Math.hypot(ev.x - 0, dy), Math.hypot(ev.x - PITCH_W, dy));
      const ang = 1 - Math.min(1, Math.abs(dy) / (GOAL_W * 1.6));
      const xg = Math.max(0.01, Math.min(0.95, 1.05 * Math.exp(-d / 95) * (0.32 + 0.68 * ang)));
      const s = scoringSideOf(ev.playerId);   // shot/goal playerId = the shooter (own goal: the other side)
      if (s > 0) { this.xgH += xg; if (xg >= 0.30) this.bigH++; }
      else if (s < 0) { this.xgA += xg; if (xg >= 0.30) this.bigA++; }
      // record the shot (shot map) + a cumulative-xG timeline sample (after the tallies update)
      if (s !== 0) { this.shots.push({ x: ev.x, y: ev.y, xg, side: s, goal: type === 'goal' }); this.xgSeries.push({ t: evClock, h: this.xgH, a: this.xgA }); }
    }
    // on-target: goal → scorer side; save/tip/punch/claim → keeper side, so credit the OTHER team
    if (type === 'goal') { const s = scoringSideOf(ev.playerId); if (s > 0) this.otH++; else if (s < 0) this.otA++; }
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
  updateMomentum(state: EngineState): void {
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
  renderStatPanel(): void {
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
  resetMatchStats(clockMs: number): void {
    this.otH = this.otA = this.xgH = this.xgA = this.bigH = this.bigA = this.corH = this.corA = 0;
    this.foulH = this.foulA = this.offH = this.offA = 0;
    this.shots = []; this.xgSeries = [];
    this.momentum = 0; this.displayMomentum = 0; this.ballXEma = PITCH_W / 2;
    this.momPrevClock = clockMs; this.homeAttacksX = null; this.goalFlashUntil = 0;
    this.lastSetPieceType = null; this.prevStatStr = {};
  }
}
