// Formation registry (A1). A formation is 11 slots in the engine's HOME frame:
//   x = depth  (own goal at x≈0, attacking toward +x; pitch length 1050)
//   y = width  (touchlines at y≈0 and y≈680; centre 340)
// Slot 0 is always the keeper (the engine pins slot 0 to GK regardless). The
// engine mirrors x for the away side (away_x = 1050 - home_x), so the registry
// stores HOME coordinates only; the spec assembler flips them for the away team.
//
// '4-3-3' MUST reproduce the engine defaults (DEF_ROLES / DEF_HX_HOME / DEF_HY in
// engine.cpp) verbatim, so a team on the default formation stays byte-identical
// to today's behaviour. The other shapes are hand-placed in the same frame.
import type { Role } from './game.ts';

export interface Slot { role: Role; x: number; y: number }

// Engine pitch length (goal-to-goal). The away side is the mirror: away_x = PITCH_W
// - home_x (matches the engine's DEF_HX_AWAY = 1050 - DEF_HX_HOME). Width (y) is the
// same in both frames, so only x flips.
export const PITCH_W = 1050;

// Touchline / channel y-anchors reused across shapes for consistency.
const yR = 81.6, yRC = 226.6667, yC = 340, yLC = 453.3333, yL = 598.4;

export const FORMATIONS: Record<string, Slot[]> = {
  // === default — identical to the engine's hardcoded 4-3-3 ===
  '4-3-3': [
    { role: 'GK', x: 31.5, y: yC },
    { role: 'FB', x: 157.5, y: yR }, { role: 'CB', x: 189, y: yRC },
    { role: 'CB', x: 189, y: yLC }, { role: 'FB', x: 157.5, y: yL },
    { role: 'CM', x: 420, y: 170 }, { role: 'CM', x: 420, y: yC }, { role: 'CM', x: 420, y: 510 },
    { role: 'WM', x: 441, y: yR }, { role: 'CF', x: 756, y: yC }, { role: 'WM', x: 441, y: yL },
  ],
  // === flat 4-4-2 — two banks of four, a strike pair ===
  '4-4-2': [
    { role: 'GK', x: 31.5, y: yC },
    { role: 'FB', x: 170, y: yR }, { role: 'CB', x: 185, y: 250 },
    { role: 'CB', x: 185, y: 430 }, { role: 'FB', x: 170, y: yL },
    { role: 'WM', x: 430, y: 90 }, { role: 'CM', x: 400, y: 275 },
    { role: 'CM', x: 400, y: 405 }, { role: 'WM', x: 430, y: 590 },
    { role: 'CF', x: 720, y: 285 }, { role: 'CF', x: 720, y: 395 },
  ],
  // === 4-2-3-1 — double pivot, band of three behind a lone striker ===
  '4-2-3-1': [
    { role: 'GK', x: 31.5, y: yC },
    { role: 'FB', x: 170, y: yR }, { role: 'CB', x: 185, y: 250 },
    { role: 'CB', x: 185, y: 430 }, { role: 'FB', x: 170, y: yL },
    { role: 'CM', x: 365, y: 280 }, { role: 'CM', x: 365, y: 400 },
    { role: 'WM', x: 560, y: 95 }, { role: 'CM', x: 575, y: yC }, { role: 'WM', x: 560, y: 585 },
    { role: 'CF', x: 760, y: yC },
  ],
  // === 3-5-2 — back three, wing-backs high, strike pair ===
  '3-5-2': [
    { role: 'GK', x: 31.5, y: yC },
    { role: 'CB', x: 185, y: 205 }, { role: 'CB', x: 190, y: yC }, { role: 'CB', x: 185, y: 475 },
    { role: 'FB', x: 440, y: 70 },
    { role: 'CM', x: 400, y: 250 }, { role: 'CM', x: 380, y: yC }, { role: 'CM', x: 400, y: 430 },
    { role: 'FB', x: 440, y: 610 },
    { role: 'CF', x: 720, y: 285 }, { role: 'CF', x: 720, y: 395 },
  ],
  // === 5-3-2 — back five (wing-backs deep), midfield three, strike pair ===
  '5-3-2': [
    { role: 'GK', x: 31.5, y: yC },
    { role: 'FB', x: 175, y: 70 }, { role: 'CB', x: 185, y: 210 }, { role: 'CB', x: 190, y: yC },
    { role: 'CB', x: 185, y: 470 }, { role: 'FB', x: 175, y: 610 },
    { role: 'CM', x: 410, y: 230 }, { role: 'CM', x: 400, y: yC }, { role: 'CM', x: 410, y: 450 },
    { role: 'CF', x: 700, y: 290 }, { role: 'CF', x: 700, y: 390 },
  ],
  // === 4-5-1 — packed midfield five behind a lone striker ===
  '4-5-1': [
    { role: 'GK', x: 31.5, y: yC },
    { role: 'FB', x: 170, y: yR }, { role: 'CB', x: 185, y: 250 },
    { role: 'CB', x: 185, y: 430 }, { role: 'FB', x: 170, y: yL },
    { role: 'WM', x: 450, y: 80 }, { role: 'CM', x: 400, y: 250 },
    { role: 'CM', x: 380, y: yC }, { role: 'CM', x: 400, y: 430 }, { role: 'WM', x: 450, y: 600 },
    { role: 'CF', x: 740, y: yC },
  ],
  // === 3-4-3 — back three, midfield four, front three ===
  '3-4-3': [
    { role: 'GK', x: 31.5, y: yC },
    { role: 'CB', x: 185, y: 205 }, { role: 'CB', x: 190, y: yC }, { role: 'CB', x: 185, y: 475 },
    { role: 'WM', x: 440, y: 75 }, { role: 'CM', x: 400, y: 275 },
    { role: 'CM', x: 400, y: 405 }, { role: 'WM', x: 440, y: 605 },
    { role: 'WM', x: 660, y: 105 }, { role: 'CF', x: 760, y: yC }, { role: 'WM', x: 660, y: 575 },
  ],
  // === 4-1-2-1-2 — narrow midfield diamond, strike pair ===
  '4-1-2-1-2': [
    { role: 'GK', x: 31.5, y: yC },
    { role: 'FB', x: 170, y: yR }, { role: 'CB', x: 185, y: 250 },
    { role: 'CB', x: 185, y: 430 }, { role: 'FB', x: 170, y: yL },
    { role: 'CM', x: 330, y: yC }, { role: 'CM', x: 440, y: 215 }, { role: 'CM', x: 440, y: 465 },
    { role: 'CM', x: 575, y: yC }, { role: 'CF', x: 745, y: 285 }, { role: 'CF', x: 745, y: 395 },
  ],
  // === 4-3-2-1 — the "christmas tree", two behind a lone striker ===
  '4-3-2-1': [
    { role: 'GK', x: 31.5, y: yC },
    { role: 'FB', x: 170, y: yR }, { role: 'CB', x: 185, y: 250 },
    { role: 'CB', x: 185, y: 430 }, { role: 'FB', x: 170, y: yL },
    { role: 'CM', x: 400, y: 235 }, { role: 'CM', x: 380, y: yC }, { role: 'CM', x: 400, y: 445 },
    { role: 'CF', x: 615, y: 270 }, { role: 'CF', x: 615, y: 410 }, { role: 'CF', x: 770, y: yC },
  ],
  // === 5-4-1 — back five, packed midfield four, lone striker (deep block) ===
  '5-4-1': [
    { role: 'GK', x: 31.5, y: yC },
    { role: 'FB', x: 175, y: 70 }, { role: 'CB', x: 185, y: 210 }, { role: 'CB', x: 190, y: yC },
    { role: 'CB', x: 185, y: 470 }, { role: 'FB', x: 175, y: 610 },
    { role: 'WM', x: 430, y: 90 }, { role: 'CM', x: 400, y: 270 },
    { role: 'CM', x: 400, y: 410 }, { role: 'WM', x: 430, y: 590 }, { role: 'CF', x: 730, y: yC },
  ],
  // === 4-4-1-1 — bank of four, a second striker dropping off the line ===
  '4-4-1-1': [
    { role: 'GK', x: 31.5, y: yC },
    { role: 'FB', x: 170, y: yR }, { role: 'CB', x: 185, y: 250 },
    { role: 'CB', x: 185, y: 430 }, { role: 'FB', x: 170, y: yL },
    { role: 'WM', x: 420, y: 90 }, { role: 'CM', x: 400, y: 270 },
    { role: 'CM', x: 400, y: 410 }, { role: 'WM', x: 420, y: 590 },
    { role: 'CF', x: 600, y: yC }, { role: 'CF', x: 765, y: yC },
  ],
  // === 4-2-2-2 — Brazilian box midfield: a double pivot, two narrow 10s, a strike pair ===
  '4-2-2-2': [
    { role: 'GK', x: 31.5, y: yC },
    { role: 'FB', x: 170, y: yR }, { role: 'CB', x: 185, y: 250 },
    { role: 'CB', x: 185, y: 430 }, { role: 'FB', x: 170, y: yL },
    { role: 'CM', x: 335, y: 280 }, { role: 'CM', x: 335, y: 400 },
    { role: 'CM', x: 545, y: 245 }, { role: 'CM', x: 545, y: 435 },
    { role: 'CF', x: 748, y: 285 }, { role: 'CF', x: 748, y: 395 },
  ],
  // === 3-4-2-1 — back three, wing-backs + double pivot, two free 10s behind a lone CF ===
  '3-4-2-1': [
    { role: 'GK', x: 31.5, y: yC },
    { role: 'CB', x: 185, y: 205 }, { role: 'CB', x: 190, y: yC }, { role: 'CB', x: 185, y: 475 },
    { role: 'FB', x: 440, y: 70 }, { role: 'CM', x: 400, y: 275 },
    { role: 'CM', x: 400, y: 405 }, { role: 'FB', x: 440, y: 610 },
    { role: 'CM', x: 600, y: 260 }, { role: 'CM', x: 600, y: 420 }, { role: 'CF', x: 770, y: yC },
  ],
  // === wide 4-2-3-1 — wider band of three + a deeper pivot than the narrow 4-2-3-1 ===
  'wide 4-2-3-1': [
    { role: 'GK', x: 31.5, y: yC },
    { role: 'FB', x: 175, y: yR }, { role: 'CB', x: 185, y: 250 },
    { role: 'CB', x: 185, y: 430 }, { role: 'FB', x: 175, y: yL },
    { role: 'CM', x: 340, y: 280 }, { role: 'CM', x: 340, y: 400 },
    { role: 'WM', x: 545, y: 60 }, { role: 'CM', x: 575, y: yC }, { role: 'WM', x: 545, y: 620 },
    { role: 'CF', x: 760, y: yC },
  ],
  // === wide diamond — a wide counterpart to the narrow 4-1-2-1-2 (the sides are out-and-out wide) ===
  'wide diamond': [
    { role: 'GK', x: 31.5, y: yC },
    { role: 'FB', x: 170, y: yR }, { role: 'CB', x: 185, y: 250 },
    { role: 'CB', x: 185, y: 430 }, { role: 'FB', x: 170, y: yL },
    { role: 'CM', x: 330, y: yC },
    { role: 'WM', x: 450, y: 105 }, { role: 'WM', x: 450, y: 575 },
    { role: 'CM', x: 575, y: yC }, { role: 'CF', x: 745, y: 285 }, { role: 'CF', x: 745, y: 395 },
  ],
};

export const DEFAULT_FORMATION = '4-3-3';

// Role-fit: how well a player's attributes suit a slot's role (0..~100). The
// assignment maximises total fit, so the best tackler lands at CB, the quickest
// at WM, the sharpest finisher up top, etc. Weights are deliberate but rough —
// a sane default, not a tuned model (note in lineup.ts).
const FIT: Record<Role, Partial<Record<string, number>>> = {
  GK: { handling: 0.5, positioning: 0.3, height: 0.2 },
  CB: { tackling: 0.4, positioning: 0.3, height: 0.2, speed: 0.1 },
  FB: { speed: 0.3, stamina: 0.25, tackling: 0.25, creativity: 0.2 },
  CM: { passing: 0.3, positioning: 0.25, creativity: 0.25, stamina: 0.2 },
  WM: { speed: 0.35, creativity: 0.3, shooting: 0.2, stamina: 0.15 },
  CF: { shooting: 0.4, speed: 0.25, creativity: 0.15, height: 0.1, positioning: 0.1 },
};

export function roleFit(attrs: Record<string, number>, role: Role): number {
  const w = FIT[role];
  let s = 0;
  for (const k in w) s += (attrs[k] ?? attrs.positioning ?? 50) * (w[k] as number);
  return s;
}

// Normalise a free-text / digit formation name to a registry key, or null if it
// isn't a recognised shape. The LLM does the heavy parsing; this is the code-side
// safety net for plain "442" / "4-4-2" / "4 4 2".
export function normalizeFormation(s: string): string | null {
  // exact registry key FIRST — otherwise the digit path below strips e.g. "wide 4-2-3-1" to
  // "4231" and returns the NARROW "4-2-3-1", making the named wide shapes unreachable.
  const exact = s.trim();
  if (FORMATIONS[exact]) return exact;
  const digits = s.replace(/[^0-9]/g, '');
  if (digits.length >= 3 && digits.length <= 5) {     // "433","442","4231","41212","4411"…
    const key = digits.split('').join('-');
    if (FORMATIONS[key]) return key;
  }
  const lower = s.toLowerCase();
  for (const key of Object.keys(FORMATIONS)) {
    if (lower.includes(key)) return key;
    if (lower.includes(key.replace(/-/g, ' '))) return key;
  }
  return null;
}
