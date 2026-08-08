import './styles.css';
import { api } from './api';
import { parseRouteId } from './util';
// ── extracted subsystems (Round: appts-audit) ── app.ts used to be one 5,500-line module. The layers below
// go bottom-up (dom → format/shell → states/modal → nav/pitch → screens) and none of them imports app.ts, so
// the graph is acyclic. Screens that need to re-dispatch the current route call shell.rerender(), which boot
// wires to route() — that indirection is what keeps a screen module from importing the router.
import { h, clickable } from './ui/dom.ts';
import { mount, screenGuard, bumpRouteGen, noteRouteHash, getUser, setUser, setOnboarding, setTacticsPlanFlash, setRerender } from './ui/shell.ts';
import { isOffline, errMessage, errorState, offlineState } from './ui/states.ts';
import { header, setupBottomNav, syncNav, closeNavSheet } from './ui/nav.ts';
import { loadNations } from './ui/nations.ts';
import { screenWatch, teardownWatch } from './screens/watch.ts';
import { screenCreateTeam } from './screens/create-team.ts';
import { screenDashboard } from './screens/dashboard.ts';
import { screenSquad } from './screens/squad.ts';
import { screenPlayer } from './screens/player.ts';
import { screenTactics, teardownTactics } from './screens/tactics.ts';
import { screenAuth } from './screens/auth.ts';
import { screenWorlds } from './screens/worlds.ts';
import { screenInternationals } from './screens/internationals.ts';
import { screenMarket } from './screens/market.ts';
import { screenScouting } from './screens/scouting.ts';
import { screenTraining } from './screens/training.ts';
import { screenTeamTalk } from './screens/team-talk.ts';
import { screenAcademy } from './screens/academy.ts';
import { screenNews } from './screens/news.ts';
import { screenInbox } from './screens/inbox.ts';
import { screenLeaders } from './screens/leaders.ts';
import { screenCup } from './screens/cup.ts';
import { screenReport } from './screens/report.ts';
import { screenFinances } from './screens/finances.ts';
import { screenStaff } from './screens/staff.ts';
import { screenScout } from './screens/scout.ts';
import { screenCareer, screenHistory } from './screens/history.ts';
import { screenMyMatches, screenLeagueMatches } from './screens/matches.ts';

// A screen-level error mount used by the router async error boundary + malformed-route not-found.
function mountError(title: string, detail: string, onRetry?: () => void): void {
  mount(header(), h('div', { class: 'wrap' }, errorState({ title, detail, onRetry, back: 'dashboard' })));
}

// ── router ──
// Pass 3 of the split moved the last eighteen screens into screens/*.ts, so what remains here is the router
// and boot: hash → screen dispatch, the teardown hooks the two stateful screens export (watch, tactics), the
// async error boundary, and the one-time page wiring at the bottom. No screen markup lives in this file.
function route() {
  const hash = location.hash;
  bumpRouteGen();      // invalidate any in-flight screen's pending mount (see screenGuard) — the new route owns the DOM now
  noteRouteHash(hash); // remember where we came from (for goBack)
  setOnboarding(false);// a real route is dispatching → leaving the club-creation screen
  closeNavSheet();     // close the More sheet if a navigation happened while it was open
  syncNav();           // active-tab indication on the persistent mobile bottom bar (hides on auth / Watch / onboarding)
  if (hash !== '#/tactics') teardownTactics();   // leaving the screen drops its gate listeners (see screens/tactics.ts)
  if (!getUser()) { teardownWatch(); screenAuth(); return; }
  if (!hash.startsWith('#/watch/')) teardownWatch();
  const alive = screenGuard();
  // Router async error boundary — an async screen that rejects OUTSIDE its own try/catch (a synchronous render
  // throw, an unhandled path) would otherwise leave a permanent half-mounted spinner. Catch it and show a
  // recoverable error instead. Fires only if this route is still current (a later navigation supersedes it).
  const run = (p: void | Promise<void>): void => { void Promise.resolve(p).catch(err => { if (alive()) mountError('Something went wrong', errMessage(err), () => route()); }); };
  // Validate numeric route params (parseRouteId, see util.ts) so a garbage hash (#/report/abc, #/player/NaN)
  // shows a recoverable not-found state instead of firing NaN at the API.
  const idArg = parseRouteId;
  const notFound = () => mount(header(), h('div', { class: 'wrap' }, errorState({ title: 'Page not found', detail: 'That link doesn’t point to a valid page.', back: 'dashboard' })));

  if (hash.startsWith('#/watch/')) { const id = idArg(hash.split('/')[2] ?? ''); if (id == null) return notFound(); run(screenWatch(id, /[?&]shouts=1\b/.test(hash), /[?&]live=1\b/.test(hash), Number(hash.match(/[?&]t=(\d+)/)?.[1] ?? 0), /[?&]cup=1\b/.test(hash))); }
  else if (hash === '#/worlds') run(screenWorlds());
  else if (hash === '#/internationals') run(screenInternationals());
  else if (hash === '#/matches') run(screenMyMatches());
  else if (hash === '#/league') run(screenLeagueMatches());
  else if (hash === '#/tactics') run(screenTactics());
  else if (hash === '#/market') run(screenMarket());
  else if (hash === '#/scouting') run(screenScouting());
  else if (hash === '#/training') run(screenTraining());
  else if (hash === '#/academy') run(screenAcademy());
  else if (hash.startsWith('#/teamtalk/')) { const id = idArg(hash.split('/')[2] ?? ''); if (id == null) return notFound(); run(screenTeamTalk(id)); }
  else if (hash === '#/news') run(screenNews());
  else if (hash === '#/inbox') run(screenInbox());
  else if (hash === '#/leaders') run(screenLeaders());
  else if (hash === '#/squad') run(screenSquad());
  else if (hash === '#/staff') run(screenStaff());
  else if (hash === '#/finances') run(screenFinances());
  else if (hash === '#/cup') run(screenCup());
  else if (hash === '#/history') run(screenHistory());
  else if (hash === '#/career') run(screenCareer());
  else if (hash.startsWith('#/report/')) { const id = idArg(hash.split('/')[2] ?? ''); if (id == null) return notFound(); run(screenReport(id, /[?&]cup=1\b/.test(hash))); }
  else if (hash.startsWith('#/scout/')) { const id = idArg(hash.split('/')[2] ?? ''); if (id == null) return notFound(); run(screenScout(id)); }
  else if (hash.startsWith('#/player/')) { const slot = idArg(hash.split('/')[2] ?? ''); if (slot == null) return notFound(); run(screenPlayer(slot)); }
  else run(screenDashboard());
}
// Last-resort net: log any unhandled rejection the router boundary didn't wrap (kept console-only to avoid
// toasting the app's intentional fire-and-forget `void promise` paths). The boundary above is the user-facing net.
window.addEventListener('unhandledrejection', (e) => { console.error('[unhandled]', e.reason); });

// a11y: a "skip to content" link as the first focusable element lets keyboard users jump past the header nav.
// It focuses the #main-content landmark directly (NOT via an href hash, which would clobber the SPA route).
const skipLink = h('a', { href: '#main-content', class: 'skip-link' }, 'Skip to content');
skipLink.addEventListener('click', (e: Event) => { e.preventDefault(); document.getElementById('main-content')?.focus(); });
document.body.insertBefore(skipLink, document.body.firstChild);
setupBottomNav();   // the persistent mobile bottom nav (hidden on desktop via CSS; syncNav toggles per-route)

window.addEventListener('hashchange', route);
// Session expired (any api call got a 401): drop the stale user and fall back to the login screen instead of
// leaving a raw "not logged in" under a live URL. teardownWatch() stops any running watch first.
window.addEventListener('footy:auth-expired', () => { if (!getUser()) return; setUser(null); setTacticsPlanFlash(null); teardownWatch(); route(); });

// ── stale-tab guard ── the SPA ships as one content-hashed bundle with no HMR for the watch screen, so an
// open tab keeps running the OLD code after a deploy — which is exactly why the user saw "still choppy" on a
// tab opened before the P0 renderer rewrite. Poll the served index.html for a changed asset hash and offer a
// one-click reload. No-ops in dev (vite serves modules directly, no hashed index-*.js) — only the built :4000.
// boot() re-enters itself (the offline screen's Retry calls boot() again) and this runs in its tail, so make
// the init idempotent: the 90s poll + visibilitychange listener it installs are never removed. Measured
// 2026-08 with the /api/me request aborted then retried: exactly ONE install per page load, because the
// offline branch returns before the tail — so this latch is a guard on the invariant, not a fix for an
// observed double-install. Keep it if the boot flow ever grows another path into this tail.
let versionWatchStarted = false;
function watchForNewVersion(): void {
  if (versionWatchStarted) return;
  const mine = [...document.querySelectorAll('script[src]')].map(s => s.getAttribute('src') || '').find(s => /assets\/index-[\w-]+\.js/.test(s));
  if (!mine) return;
  versionWatchStarted = true;
  let bannerShown = false;
  const check = async (): Promise<void> => {
    if (bannerShown) return;
    try {
      const html = await (await fetch('/?_v=' + Date.now(), { cache: 'no-store' })).text();
      const m = html.match(/assets\/index-[\w-]+\.js/);
      if (m && !mine.includes(m[0])) {
        bannerShown = true;
        document.body.appendChild(h('div', {
          ...clickable(() => location.reload()), title: 'Reload to get the latest version',
          style: 'position:fixed;top:0;left:0;right:0;z-index:99999;background:var(--accent,#1b9af7);color:#fff;font:600 13px/1.5 system-ui,monospace;padding:9px 14px;text-align:center;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3)',
        }, '↻ A new version of the match viewer is available — click to reload'));
      }
    } catch { /* offline / transient — retry next tick */ }
  };
  setInterval(() => void check(), 90000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void check(); });
}

setRerender(route);   // screens call shell.rerender() instead of importing the router (see ui/shell.ts)
mount(h('div', { class: 'center' }, h('div', { class: 'spin' }, 'Loading Footy Manager…')));
(async function boot() {
  try {
    const me = await api.me();
    setUser(me.user);
    void loadNations();   // fire-and-forget; screens re-render on navigation so flags fill in
    // A manager without a club may still browse shared worlds and claim one. The old tactics exception was a
    // typo: it forced a direct #/worlds visit back to club creation, then left that link on an unchanged hash.
    if (getUser() && me.teamId == null && location.hash !== '#/worlds') { screenCreateTeam(); return; }
  } catch (e) {
    // A NETWORK failure (server down / offline) is NOT the same as being logged out — don't dump the user on
    // the login screen. Show a recoverable offline state; a real not-logged-in /me RESOLVES (user:null) rather
    // than throwing, so it still falls through to route() → Auth as before.
    if (isOffline(e)) {
      mount(h('div', { class: 'center' }, offlineState(() => { mount(h('div', { class: 'center' }, h('div', { class: 'spin' }, 'Reconnecting…'))); void boot(); })));
      syncNav();   // no user → hide the bottom bar on the offline screen (boot bypasses route())
      return;
    }
  }
  route();
  watchForNewVersion();
  registerServiceWorker();
})();

// PWA: register the shell service worker so the app is installable ("Add to Home Screen" →
// standalone, own icon) and launches offline-tolerant. Only in secure contexts (https or
// localhost); a failed registration is non-fatal — the app runs fine without it.
function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  // Register directly — NOT gated on the `load` event: boot() awaits a network call first, so by
  // the time we get here `load` has usually already fired and a load-listener would never run.
  navigator.serviceWorker.register('/sw.js').catch(() => { /* SW unavailable — no-op */ });
}
