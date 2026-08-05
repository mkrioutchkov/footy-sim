// ── shared pure formatters + attribute helpers ── extracted from app.ts (Round: appts-audit).
// Pure functions and lookup tables only: no DOM, no module state, no imports beyond the PlayerT shape.
import type { PlayerT } from '../api';

export function fmtMoney(n: number): string {
  if (n < 0) return `-${fmtMoney(-n)}`;   // a deficit renders as -£1.2M, not £-1200000 (raw, hyphen glued to £)
  if (n >= 1e6) return `£${(n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1)}M`;
  if (n >= 1e3) {
    const k = Math.round(n / 1e3);
    if (k >= 1000) return `£${(k / 1000).toFixed(1)}M`;   // 999,500+ rounds to 1000K → roll up to £1.0M, not £1000K
    return `£${k}K`;
  }
  return `£${Math.round(n)}`;
}
// Strict, shared money parser for bids, wages and search filters. Accepts the same values the UI displays
// ("£50K", "1.5m", "1,500,000") so copying a formatted wage can never silently turn £50K into £50.
export function parseMoneyInput(value: string): number | null {
  const text = value.trim().toLowerCase().replace(/[£$, \s]/g, '');
  if (!/^\d*\.?\d+[mk]?$/.test(text)) return null;
  const multiplier = text.endsWith('m') ? 1e6 : text.endsWith('k') ? 1e3 : 1;
  const amount = Math.round(Number.parseFloat(text) * multiplier);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}
// OVR = mean of the core skills (excludes height). Handling counts ONLY for a keeper (role==='GK') —
// mirrors the backend's overall(attrs, role), so a GK's OVR reads the same everywhere and his potential
// headroom (a skill-based ceiling) compares against the right number. Omit role → the 7-attr mean.
export const SKILL_KEYS = ['speed', 'passing', 'creativity', 'shooting', 'tackling', 'positioning', 'stamina'];
export function skillOvr(attrs: Record<string, number>, role?: string): number {
  const keys = role === 'GK' ? [...SKILL_KEYS, 'handling'] : SKILL_KEYS;
  return Math.round(keys.reduce((s, k) => s + (attrs[k] ?? 0), 0) / keys.length);
}
// per-cell attribute heat: red (low) → green (high), used across the squad table + compare.
// 'POSN' (not 'POS') for the positioning ATTRIBUTE so it never reads the same as the role/Position column.
export const SQUAD_ATTRS: [string, string][] = [['speed', 'SPD'], ['passing', 'PAS'], ['creativity', 'CRE'], ['shooting', 'SHO'], ['tackling', 'TAC'], ['positioning', 'POSN'], ['stamina', 'STA']];
// A player's key attributes as "ABBR value" tokens — the single source of truth so every screen shows
// the SAME set (the dashboard squad card used to hand-write 6 and silently dropped stamina).
export const attrTokens = (attrs: Record<string, number>): string[] => SQUAD_ATTRS.map(([k, abbr]) => `${abbr} ${Math.round(attrs[k] ?? 0)}`);
// §2.10 fitness-band colours: red exhausted/injured, amber tired, green fresh, neutral ok.
export const BAND_COLOR: Record<string, string> = { injured: 'var(--danger)', exhausted: 'var(--danger)', tired: '#ffb84d', ok: '', fresh: 'var(--accent)' };
export function attrHeat(v: number): string {
  const hue = Math.max(0, Math.min(120, Math.round(((v - 35) / (95 - 35)) * 120)));
  return `color:hsl(${hue},70%,64%);font-weight:600`;
}
// per-attribute tier colour for the player-profile bars: green ≥75, gold ≥50, red below.
export const attrTierColor = (v: number): string => v >= 75 ? 'var(--accent,#43d39e)' : v >= 50 ? 'var(--gold,#ffe97a)' : 'var(--danger,#ff6b6b)';
// Truncate a name so it fits a pitch token / a narrow table cell.
export function shortName(n: string): string { return n.length > 13 ? n.slice(0, 12) + '…' : n; }
// §2.3: a player "seeking a move" — running down his deal (≤1y) AND unsettled (low morale, or a big
// ego stuck on the bench). Derived (no persisted flag), so it's always current. contractYears/morale/
// ego/slot all ride on PlayerT.
export const seekingMove = (p: PlayerT): boolean =>
  (p.contractYears ?? 9) <= 1 && ((p.morale ?? 100) < 40 || ((p.personality?.traits?.ego ?? 0) >= 70 && p.slot >= 11));
// Contract-years cell style: red at ≤1y (walks next summer), amber at ≤2y.
export const contractStyle = (yrs: number | undefined): string =>
  (yrs ?? 9) <= 1 ? 'color:var(--danger);font-weight:600' : (yrs ?? 9) <= 2 ? 'color:#ffb84d' : '';
export const capWord = (s: string): string => s ? s[0].toUpperCase() + s.slice(1) : s;
// §footedness: a player's stronger foot (backend: -1 left, 1 right, 0 two-footed; undefined ⇒ the engine's
// right-footed default). footLabel = the profile phrasing; footTag = the compact (L)/(R)/(LR) squad-list badge.
export const footLabel = (foot: number | undefined): string => foot === -1 ? 'Left footed' : foot === 0 ? 'Two-footed' : 'Right footed';
export const footTag = (foot: number | undefined): string => foot === -1 ? 'L' : foot === 0 ? 'LR' : 'R';
// 1 → 1st, 2 → 2nd … (league positions, cup rounds).
export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

// ── training / development labels ── shared by the Training screen and the player profile.
// 'position' = role-matched drills (§2.7); the rest push one attribute club-wide or per-player.
export const TRAINING_FOCI = ['balanced', 'position', 'speed', 'passing', 'creativity', 'shooting', 'tackling', 'positioning', 'stamina', 'handling'];
const FOCUS_LABEL: Record<string, string> = {
  balanced: 'Balanced', position: 'Position-specific',
  speed: 'Speed', passing: 'Passing', creativity: 'Creativity', shooting: 'Shooting',
  tackling: 'Tackling', positioning: 'Positioning', stamina: 'Stamina', handling: 'Handling (GK)',
};
export const ATTR_SHORT: Record<string, string> = Object.fromEntries(SQUAD_ATTRS.map(([k, s]) => [k, s]));
export const focusLabel = (f: string) => FOCUS_LABEL[f] ?? (f ? f[0].toUpperCase() + f.slice(1) : f);
export const fmtDelta = (d: number) => `${d > 0 ? '+' : ''}${d}`;
