// Lightweight unit tests for the pure frontend helpers. Run with `npm run test:fe` (tsx — no framework, no
// new deps). Covers route-param validation, renderer resolution selection, and the guardSelect latest-intent
// rule. Exits non-zero on any failure so it can gate a build.
import { parseRouteId, cappedResolution, isLatest } from './util';

let failed = 0;
function eq(actual: unknown, expected: unknown, msg: string): void {
  const ok = Object.is(actual, expected);
  console.log(`${ok ? '✓' : '✗'} ${msg}${ok ? '' : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
  if (!ok) failed++;
}

// parseRouteId — numeric route-param validation (a garbage id must never reach the API)
eq(parseRouteId('7'), 7, 'parseRouteId: plain integer');
eq(parseRouteId('7?cup=1'), 7, 'parseRouteId: strips a trailing query string');
eq(parseRouteId('0'), 0, 'parseRouteId: zero is valid');
eq(parseRouteId('abc'), null, 'parseRouteId: non-numeric → null');
eq(parseRouteId(''), null, 'parseRouteId: empty → null');
eq(parseRouteId('-3'), null, 'parseRouteId: negative → null');
eq(parseRouteId('1.5'), null, 'parseRouteId: non-integer → null');
eq(parseRouteId('NaN'), null, 'parseRouteId: literal NaN → null');

// cappedResolution — DPR clamp for the Pixi backing store
eq(cappedResolution(3), 2, 'cappedResolution: caps 3 → 2');
eq(cappedResolution(1), 1, 'cappedResolution: 1 unchanged');
eq(cappedResolution(1.5), 1.5, 'cappedResolution: under cap unchanged');
eq(cappedResolution(0), 1, 'cappedResolution: 0 → 1 (guard)');
eq(cappedResolution(NaN), 1, 'cappedResolution: NaN → 1 (guard)');
eq(cappedResolution(2.5, 2), 2, 'cappedResolution: honours the cap');

// isLatest — guardSelect "latest-intent wins" + liveness (a superseded or navigated-away request is dropped)
eq(isLatest(3, 3), true, 'isLatest: same token, default-alive → apply');
eq(isLatest(2, 3), false, 'isLatest: superseded token → drop');
eq(isLatest(3, 3, () => false), false, 'isLatest: navigated away (not alive) → drop');
eq(isLatest(3, 3, () => true), true, 'isLatest: current + alive → apply');

if (failed) { console.error(`\n${failed} test(s) FAILED`); process.exit(1); }
console.log('\nAll util tests passed.');
