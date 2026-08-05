// ── site chrome: header + navigation model + persistent mobile bottom bar ── extracted from app.ts
// (Round: appts-audit). Imports the shell/modal layers only, never a screen, so every screen can use header().
import { api } from '../api.ts';
import { h } from './dom.ts';
import { lockPageForModal, trapTab } from './modal.ts';
import { getUser, isOnboarding, rerender, setTacticsPlanFlash, setUser } from './shell.ts';

export function header(): HTMLElement {
  return h('header', { class: 'top' },
    h('div', { class: 'wrap' },
      h('a', { class: 'brand brand-link', href: '#/', 'aria-label': 'Footy Manager dashboard' }, 'FOOTY ', h('span', { class: 'a' }, 'MANAGER')),
      h('div', { class: 'row' },
        h('span', { class: 'muted' }, getUser()?.username ?? ''),
        h('button', { class: 'ghost small', onclick: async () => { await api.logout(); setUser(null); setTacticsPlanFlash(null); rerender(); } }, 'Log out'),
      ),
    ),
  );
}

// ── navigation model + persistent mobile bottom bar ──────────────────────────────────────────────
// One source of truth for every section route, used by the dashboard grid, the mobile bottom bar, and the
// "More" sheet. Deep detail routes (#/player/… etc.) belong to no section.
export const NAV: { hash: string; icon: string; label: string }[] = [
  { hash: '#/', icon: '🏠', label: 'Home' },
  { hash: '#/inbox', icon: '📨', label: 'Inbox' },
  { hash: '#/matches', icon: '📅', label: 'My Matches' },
  { hash: '#/league', icon: '⚽', label: 'Results' },
  { hash: '#/leaders', icon: '📊', label: 'Stat leaders' },
  { hash: '#/squad', icon: '👥', label: 'Squad' },
  { hash: '#/tactics', icon: '♟️', label: 'Tactics' },
  { hash: '#/market', icon: '💸', label: 'Market' },
  { hash: '#/scouting', icon: '🔎', label: 'Scouting' },
  { hash: '#/training', icon: '🏃', label: 'Training' },
  { hash: '#/academy', icon: '🎓', label: 'Academy' },
  { hash: '#/staff', icon: '🧑‍🏫', label: 'Staff' },
  { hash: '#/finances', icon: '💰', label: 'Finances' },
  { hash: '#/cup', icon: '🏆', label: 'Cup' },
  { hash: '#/internationals', icon: '🌍', label: 'Internationals' },
  { hash: '#/history', icon: '📜', label: 'History' },
  { hash: '#/career', icon: '📋', label: 'Career' },
];
// A dashboard-grid tile — a REAL anchor now (native new-tab / middle-click / right-click / copy-link).
export function navItem(icon: string, label: string, hash: string): HTMLElement {
  return h('a', { class: 'nav-item', href: hash }, h('span', { class: 'ico' }, icon), h('span', { class: 'lab' }, label));
}

// The mobile bottom bar: four primary destinations + a More sheet. Persistent — appended to <body> ONCE (outside
// #app, so a per-screen mount() never destroys it). Hidden on desktop + on the immersive Watch screen via CSS/JS.
const BOTTOM_PRIMARY = ['#/', '#/squad', '#/tactics', '#/matches'];
let bottomNav: HTMLElement | null = null;
let navSheetClose: (() => void) | null = null;
// route() calls this on every dispatch: close the More sheet if a navigation happened while it was open.
// (The `onboarding` flag that also gates the bar now lives in shell.ts — header/nav and route both read it.)
export function closeNavSheet(): void { navSheetClose?.(); }
export function setupBottomNav(): void {
  if (bottomNav) return;
  const items = BOTTOM_PRIMARY.map(hash => { const e = NAV.find(n => n.hash === hash)!; return h('a', { class: 'bn-item', href: hash, 'data-nav': hash }, h('span', { class: 'bn-ico', 'aria-hidden': 'true' }, e.icon), h('span', { class: 'bn-lab' }, e.label)); });
  const moreBtn = h('button', { class: 'bn-item bn-more', type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-label': 'More sections' }, h('span', { class: 'bn-ico', 'aria-hidden': 'true' }, '☰'), h('span', { class: 'bn-lab' }, 'More'));
  moreBtn.addEventListener('click', () => openNavSheet(moreBtn));
  bottomNav = h('nav', { class: 'bottom-nav', 'aria-label': 'Primary' }, ...items, moreBtn);
  document.body.appendChild(bottomNav);
}
// Sync the active-tab indication + hide the bar when logged out or on the immersive Watch screen.
export function syncNav(): void {
  if (!bottomNav) return;
  const hash = location.hash || '#/';
  const show = !!getUser() && !isOnboarding() && !hash.startsWith('#/watch/');
  bottomNav.style.display = show ? '' : 'none';
  document.body.classList.toggle('has-bottomnav', show);   // gates the content-clearing padding (mobile CSS)
  if (!show) return;
  bottomNav.querySelectorAll<HTMLElement>('.bn-item[data-nav]').forEach(a => {
    const active = a.dataset.nav === hash;
    if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    a.classList.toggle('on', active);
  });
}
// The "More" sheet: a focus-trapped dialog listing every section. Escape / backdrop close it; picking one
// navigates (hashchange re-routes) and closes. Mirrors the confirm-modal focus semantics.
function openNavSheet(trigger: HTMLElement): void {
  if (navSheetClose) return;
  const unlock = lockPageForModal();   // inert #app + scroll-lock the background while the sheet is open
  const prevFocus = document.activeElement as HTMLElement | null;
  const list = h('div', { class: 'nav-sheet-list' }, ...NAV.map(e =>
    h('a', { class: 'nav-sheet-item', href: e.hash }, h('span', { 'aria-hidden': 'true' }, e.icon), h('span', {}, e.label))));
  const card = h('div', { class: 'nav-sheet-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'All sections' },
    h('div', { class: 'nav-sheet-head' }, h('strong', {}, 'Go to…'), h('button', { class: 'icon-btn', 'aria-label': 'Close', style: 'font-size:22px', onclick: () => close() }, '×')),
    list);
  const backdrop = h('div', { class: 'modal-backdrop', onclick: (e: Event) => { if (e.target === backdrop) close(); } }, card);
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); } else if (e.key === 'Tab') trapTab(e, card); };
  function close(): void { if (!navSheetClose) return; navSheetClose = null; unlock(); document.removeEventListener('keydown', onKey); backdrop.remove(); trigger.setAttribute('aria-expanded', 'false'); (prevFocus ?? trigger).focus({ preventScroll: true }); }
  navSheetClose = close;
  list.addEventListener('click', () => close());   // a pick navigates via the anchor href + closes the sheet
  document.addEventListener('keydown', onKey);
  document.body.appendChild(backdrop);
  trigger.setAttribute('aria-expanded', 'true');
  (list.querySelector('a') as HTMLElement | null)?.focus({ preventScroll: true });
}
