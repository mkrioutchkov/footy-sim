// ── reusable screen states + structural primitives ── extracted from app.ts (Round: appts-audit).
import { ApiError } from '../api.ts';
import { isLatest } from '../util.ts';
import { h, type Attrs } from './dom.ts';
import { goBack, toast } from './shell.ts';

// ── reusable screen states (loading / empty / error / offline / partial) ─────────────────────────
// One consistent look + a11y for the async lifecycle, replacing the bare `.spin` / red-string patterns.
// A network/offline failure (fetch rejected → ApiError status 0) is distinct from a real HTTP/app error.
export function isOffline(e: unknown): boolean { return e instanceof ApiError && e.status === 0; }
export function errMessage(e: unknown): string { return e instanceof Error ? e.message : String(e ?? 'Unknown error'); }
export function loadingState(msg = 'Loading…'): HTMLElement {
  return h('div', { class: 'state-box', role: 'status', 'aria-live': 'polite' }, h('div', { class: 'spin' }, msg));
}
export function emptyState(opts: { icon?: string; title: string; hint?: string; action?: HTMLElement | string }): HTMLElement {
  return h('div', { class: 'state-box empty-state' },
    opts.icon ? h('div', { class: 'state-ico', 'aria-hidden': 'true' }, opts.icon) : '',
    h('div', { class: 'state-title' }, opts.title),
    opts.hint ? h('div', { class: 'state-hint muted' }, opts.hint) : '',
    opts.action ?? '');
}
// A recoverable error: title + explanation + Retry + Back/Dashboard. role=alert → announced once.
export function errorState(opts: { title?: string; detail?: string; onRetry?: () => void; back?: (() => void) | 'dashboard' }): HTMLElement {
  const actions: HTMLElement[] = [];
  if (opts.onRetry) actions.push(h('button', { class: 'primary small', onclick: opts.onRetry }, '↻ Retry'));
  if (opts.back) actions.push(h('button', { class: 'ghost small', onclick: () => { if (opts.back === 'dashboard') location.hash = '#/'; else (opts.back as () => void)(); } }, opts.back === 'dashboard' ? '← Dashboard' : '← Back'));
  return h('div', { class: 'state-box error-state', role: 'alert' },
    h('div', { class: 'state-ico', 'aria-hidden': 'true' }, '⚠'),
    h('div', { class: 'state-title' }, opts.title || 'Something went wrong'),
    h('div', { class: 'state-hint muted' }, opts.detail || 'The request failed. Please try again.'),
    actions.length ? h('div', { class: 'state-actions row' }, ...actions) : '');
}
export function offlineState(onRetry: () => void): HTMLElement {
  return errorState({ title: 'Can’t reach the server', detail: 'You appear to be offline, or the server is unavailable. Your session is safe — retry once you’re back online.', onRetry });
}
// Inline "this optional section failed to load" banner with a retry — distinct from an empty section.
export function partialFailure(label: string, onRetry: () => void): HTMLElement {
  return h('div', { class: 'status-banner warn', role: 'alert' },
    h('span', {}, `⚠ Couldn’t load ${label}.`),
    h('button', { class: 'ghost small', onclick: onRetry }, 'Retry'));
}

// Serialized, rollback-safe mutation for a <select> (Training / player-development / any optimistic control).
// - snapshots the last-saved value; disables the control while the request is in flight (blocks racing);
// - a per-control token means a superseded request's late resolution is ignored (latest-intent wins);
// - applies the server-normalized value only when still current AND the route is still live;
// - on failure rolls the <select> back to the last-saved value and shows the error inline (toast).
// `save` performs the request + any success side-effect and returns the server-normalized value (or void → use
// the sent value). `alive` (optional) is the screen's screenGuard so a resolution after navigation is dropped.
export function guardSelect(sel: HTMLSelectElement, save: (value: string) => Promise<string | void>, alive?: () => boolean): void {
  let token = 0;
  let saved = sel.value;
  sel.addEventListener('change', async () => {
    const mine = ++token;
    const next = sel.value;
    sel.disabled = true;
    try {
      const norm = await save(next);
      if (!isLatest(mine, token, alive)) return;   // superseded, or navigated away (latest-intent wins — see util.ts)
      saved = typeof norm === 'string' ? norm : next;
      sel.value = saved;
    } catch (e) {
      if (mine !== token) return;
      sel.value = saved;                                           // roll back to the last persisted value
      toast(errMessage(e));
    } finally {
      if (mine === token) sel.disabled = false;                    // only the newest request re-enables
    }
  });
}

// ── extracted structural primitives (reduce the repeated inline-style clusters + add table a11y) ──────────
// A horizontally-scrollable region a keyboard user can focus + arrow-scroll, announced to AT. Wrap wide tables
// / brackets. `sticky` opts the child table's <thead> into a sticky header (pairs with a maxH scroll).
export function scrollRegion(label: string, child: HTMLElement, opts: { sticky?: boolean; maxH?: string; dataScroll?: string } = {}): HTMLElement {
  if (opts.sticky) child.querySelector('thead')?.classList.add('sticky');
  const attrs: Attrs = { class: 'scroll-x', tabindex: '0', role: 'region', 'aria-label': label };
  if (opts.maxH) attrs.style = `max-height:${opts.maxH};overflow:auto`;
  if (opts.dataScroll) attrs['data-scroll'] = opts.dataScroll;
  return h('div', attrs, child);
}
// The standard screen header: h2 title + optional subtitle + a Back button (history-aware by default). Replaces
// the ~30 hand-built `between + h2 + muted subtitle + ← Back` clusters.
export function pageHead(title: string, opts: { subtitle?: string | HTMLElement; onBack?: () => void; actions?: (HTMLElement | string)[] } = {}): HTMLElement {
  const left = h('div', {}, h('h2', {}, title), opts.subtitle ? (typeof opts.subtitle === 'string' ? h('div', { class: 'muted', style: 'font-size:13px' }, opts.subtitle) : opts.subtitle) : '');
  const right = h('div', { class: 'row', style: 'gap:8px' }, ...(opts.actions ?? []), h('button', { class: 'ghost', onclick: opts.onBack ?? (() => goBack()) }, '← Back'));
  return h('div', { class: 'page-head between' }, left, right);
}
// A card whose first section-title has no top margin (the ×59 pattern) — now via the .subcard-title class + CSS.
export function subcard(title: string, ...kids: (Node | string)[]): HTMLElement {
  return h('div', { class: 'card' }, h('div', { class: 'section-title subcard-title' }, title), ...kids);
}
// responsiveTable — builds the <table class="resp-table"> and stamps every body cell with a `data-label` pulled
// from the matching header <th>, so the mobile stylesheet can reflow each row into a compact labelled card
// (each td renders "LABEL  value") instead of forcing a horizontal scroll. Zero per-cell churn at the call
// sites: the labels come from the thead the screen already built. Rows whose cells span columns (colspan — the
// "no data" empty-state rows) are skipped so their single cell isn't mislabelled. Header sort-arrows (▲/▼) are
// stripped from the label. Returns the <table>; wrap it in scrollRegion() for the desktop scroll/sticky path.
export function responsiveTable(thead: HTMLElement, tbody: HTMLElement, extraClass = ''): HTMLElement {
  const table = h('table', { class: 'resp-table' + (extraClass ? ' ' + extraClass : '') }, thead, tbody);
  const labels = Array.from(thead.querySelectorAll('th')).map(th => (th.textContent ?? '').replace(/[▲▼]/g, '').trim());
  for (const row of Array.from(tbody.children)) {
    const cells = Array.from(row.children) as HTMLTableCellElement[];
    if (cells.some(c => c.colSpan > 1)) continue;   // full-width empty-state row — nothing to label
    cells.forEach((cell, i) => { if (labels[i] && !cell.hasAttribute('data-label')) cell.setAttribute('data-label', labels[i]); });
  }
  return table;
}
