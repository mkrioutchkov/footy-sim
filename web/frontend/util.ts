// Pure, side-effect-free helpers extracted from app.ts / renderer.ts so they can be unit-tested without a DOM
// (app.ts runs mount()/listeners at import time, so it can't be imported in Node). Keep this module import-safe.

// Validate a numeric route param (report/scout/player/watch/teamtalk id). A garbage hash (#/report/abc,
// #/player/NaN, a negative id) must not reach the API — returns null so the router shows a not-found state.
// Accepts an optional trailing query string (?cup=1 etc.), which is stripped before parsing.
export function parseRouteId(raw: string): number | null {
  const s = (raw ?? '').split('?')[0];
  if (!s.trim()) return null;   // Number('') is 0 — an empty segment (#/report/) must be null, not fixture 0
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// Cap the Pixi backing-store multiplier: high-DPR phones (2.5–3×) would otherwise allocate a huge full-window
// canvas. 2× is visually indistinguishable and far cheaper. Guards NaN/0 → 1.
export function cappedResolution(dpr: number, cap = 2): number {
  const d = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return Math.min(d, cap);
}

// The "latest-intent wins" predicate used by guardSelect: a request should apply its result only if it is
// still the newest one issued for that control (its token matches the current token) AND the screen is still
// live. Extracted so the sequencing rule is unit-testable without a real <select>/DOM.
export function isLatest(mine: number, current: number, alive: () => boolean = () => true): boolean {
  return mine === current && alive();
}
