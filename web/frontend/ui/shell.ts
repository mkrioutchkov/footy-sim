// ── app shell + shared session context ── extracted from app.ts (Round: appts-audit).
// This is the ONE shared mutable-state module. Screen modules import from here; nothing here imports a
// screen, so the module graph stays acyclic. State that only one screen reads stays with that screen.
//
// Why accessors rather than exported `let`s: an ES module's exported binding is read-only at the import
// site, so `user = …` from a screen module would not compile. get/set keeps the single source of truth.
import { h } from './dom.ts';

export const root = document.getElementById('app')!;

let user: { id: number; username: string; isAdmin?: boolean } | null = null;
export function getUser(): { id: number; username: string; isAdmin?: boolean } | null { return user; }
export function setUser(u: { id: number; username: string; isAdmin?: boolean } | null): void { user = u; }

// ── re-render indirection ── screens call rerender() where they used to call route() directly ("re-dispatch
// the current hash after a mutation"). app.ts wires the real router in with setRerender(route) at boot, which
// is what keeps screen modules from having to import the router (and the router from importing them back).
let rerenderFn: () => void = () => { /* wired at boot */ };
export function setRerender(fn: () => void): void { rerenderFn = fn; }
export function rerender(): void { rerenderFn(); }

let lastFocusHash = 'init';
let navFocusTimer = 0;   // sentinel — guarantees the focus move happens on the first render too
// ── route-generation guard ── bumped on every route() dispatch. An async screen captures `const alive =
// screenGuard();` at entry and calls `if (!alive()) return;` after each await before it touches the DOM, so a
// slow fetch can't mount() stale content over a screen the user has since navigated to — and can't orphan the
// watch's body-attached controls/socket by wiping its canvas. Mirrors screenWatch's watchEpoch, generalised.
let routeGen = 0;
export function screenGuard(): () => boolean { const g = routeGen; return () => g === routeGen; }
// route() bumps the generation on every dispatch; screens only read it through screenGuard().
export function bumpRouteGen(): void { routeGen++; }
export function mount(...nodes: Node[]) {
  root.replaceChildren(...nodes);
  // a11y: tag the content as the <main> landmark, and on a ROUTE CHANGE move focus into it so screen-reader +
  // keyboard users land on the new content's heading instead of re-traversing the header nav every navigation.
  // Hash-guarded so an in-screen re-render (same route, e.g. after an action) doesn't steal focus from the user.
  const main = nodes[nodes.length - 1];
  if (main instanceof HTMLElement) {
    main.id = 'main-content'; main.setAttribute('role', 'main'); main.setAttribute('tabindex', '-1');
    const pageHeading = main.querySelector('h1, h2') as HTMLElement | null;
    if (pageHeading?.textContent?.trim()) document.title = `${pageHeading.textContent.trim()} · Footy Manager`;
    if (location.hash !== lastFocusHash) {
      // debounced + re-queried at fire time so a screen that mounts twice (skeleton then content) focuses its FINAL
      // content; hash-guarded so an in-screen re-render of the SAME route never yanks focus from what the user is doing.
      clearTimeout(navFocusTimer);
      navFocusTimer = window.setTimeout(() => {
        const m = document.getElementById('main-content'); if (!m) return;
        const heading = m.querySelector('h1, h2') as HTMLElement | null;
        // A slow request can leave the loading skeleton mounted past this debounce. Do not mark the route
        // focused yet: the final mount will schedule another pass and focus its real heading.
        if (!heading && m.querySelector('.spin')) return;
        lastFocusHash = location.hash;
        const target = heading ?? m;
        target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
      }, 90);
    }
  }
}
export function toast(msg: string) {
  // Toasts stack in a fixed bottom-centre column so concurrent toasts (many actions fire 2+) queue upward
  // instead of rendering exactly on top of each other. The container is created lazily and auto-cleans.
  let stack = document.getElementById('toast-stack');
  if (!stack) { stack = h('div', { id: 'toast-stack' }); document.body.appendChild(stack); }
  let timer: ReturnType<typeof setTimeout> | null = null;
  let t: HTMLElement;
  const duration = Math.min(7000, Math.max(3200, 2400 + msg.length * 28));
  const pause = () => { if (timer) clearTimeout(timer); timer = null; };
  const remove = () => { pause(); t.remove(); if (stack && !stack.childElementCount) stack.remove(); };
  const schedule = () => { pause(); timer = setTimeout(remove, duration); };
  const resume = () => { if (t.isConnected && !t.matches(':hover') && !t.contains(document.activeElement)) schedule(); };
  t = h('div', { class: 'toast' },
    h('span', {}, msg),
    h('button', { class: 'toast-close', 'aria-label': 'Dismiss notification', title: 'Dismiss', onclick: remove }, '×'));
  t.addEventListener('mouseenter', pause);
  t.addEventListener('mouseleave', resume);
  t.addEventListener('focusin', pause);
  t.addEventListener('focusout', () => setTimeout(resume, 0));
  stack.appendChild(t);
  // mirror into a persistent polite live-region so screen readers announce transient toasts
  let live = document.getElementById('live-region');
  if (!live) { live = h('div', { id: 'live-region', class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' }); document.body.appendChild(live); }
  live.textContent = msg;
  schedule();
}

// History-aware Back for deep detail screens: navBackHash is the route we ARRIVED FROM this navigation, so a
// player/scout/team-talk opened from Squad or Scouting returns to that list instead of always the Dashboard.
let navBackHash = '#/';
let prevRouteHash = '#/';
export function goBack(fallback = '#/'): void { location.hash = (navBackHash && navBackHash !== location.hash) ? navBackHash : fallback; }
// route() owns the back-hash bookkeeping; it is the only writer.
export function noteRouteHash(hash: string): void {
  navBackHash = prevRouteHash && prevRouteHash !== hash ? prevRouteHash : '#/';   // where we came from (for goBack)
  prevRouteHash = hash;
}

// true while the club-creation screen is up (reached via boot's early return, bypassing route()) — the bottom
// bar's section links are team-gated, so hide it there. Cleared when route() dispatches a real screen.
let onboarding = false;
export function isOnboarding(): boolean { return onboarding; }
export function setOnboarding(v: boolean): void { onboarding = v; }

// The tactics screen's one-shot compiler feedback (note/error) survives the navigation that re-renders the
// screen. It lives here rather than with the tactics code because header()'s Log out and the auth-expired
// handler both clear it, and header() must not depend on a screen module.
export type TacticsPlanFlash = { note?: string; error?: string | null };
let tacticsPlanFlash: TacticsPlanFlash | null = null;
export function getTacticsPlanFlash(): TacticsPlanFlash | null { return tacticsPlanFlash; }
export function setTacticsPlanFlash(f: TacticsPlanFlash | null): void { tacticsPlanFlash = f; }
