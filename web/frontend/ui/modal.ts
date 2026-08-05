// ── in-app modals ── extracted from app.ts (Round: appts-audit). Depends only on dom + the shell's root.
// ── in-app modals (replace native confirm()/prompt(), which are ugly + block the event loop) ──
import { h } from './dom.ts';
import { root } from './shell.ts';

// Both resolve a promise: cancel → false/null, confirm → true/the input value. ESC and a backdrop click
// cancel; native focused controls own Enter. Destructive dialogs focus Cancel by default.
// a11y: keep Tab inside the open dialog (a modal must not let keyboard/SR users tab into the inert page behind).
export function trapTab(e: KeyboardEvent, card: HTMLElement): void {
  const f = card.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])');
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1], active = document.activeElement;
  if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
}
let modalDepth = 0, modalWasInert = false, modalId = 0;
export function lockPageForModal(): () => void {
  if (modalDepth++ === 0) { modalWasInert = root.inert; root.inert = true; document.body.classList.add('modal-open'); }
  let released = false;
  return () => {
    if (released) return; released = true;
    if (--modalDepth === 0) { root.inert = modalWasInert; document.body.classList.remove('modal-open'); }
  };
}
export function confirmModal(title: string, message: string, okLabel = 'Confirm', tone: 'default' | 'danger' = 'default', focusTarget?: HTMLElement | null): Promise<boolean> {
  return new Promise(resolve => {
    let done = false;
    const opener = focusTarget ?? document.activeElement as HTMLElement | null;   // a11y: restore focus to the trigger on close
    const unlock = lockPageForModal();
    const titleId = `modal-title-${++modalId}`;
    // Enter is intentionally left to the focused native button. A document-level Enter handler used to
    // confirm even while Cancel had focus—the worst possible keyboard outcome for destructive actions.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') finish(false); else if (e.key === 'Tab') trapTab(e, card); };
    const onHash = () => finish(false);   // navigating away closes the modal (it lives on body, not root)
    const finish = (v: boolean) => { if (done) return; done = true; document.removeEventListener('keydown', onKey); window.removeEventListener('hashchange', onHash); backdrop.remove(); unlock(); resolve(v); window.setTimeout(() => { try { if (opener?.isConnected) opener.focus(); } catch { /* opener gone */ } }, 0); };
    const cancel = h('button', { class: 'ghost', onclick: () => finish(false) }, 'Cancel');
    const ok = h('button', { class: tone === 'danger' ? 'danger-action' : 'primary', onclick: () => finish(true) }, okLabel);
    const card = h('div', { class: 'modal-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      h('h3', { id: titleId, style: 'margin-bottom:10px' }, title),
      h('div', { class: 'muted', style: 'margin-bottom:18px;line-height:1.5;white-space:pre-wrap' }, message),
      h('div', { class: 'row', style: 'justify-content:flex-end' }, cancel, ok));
    const backdrop = h('div', { class: 'modal-backdrop', onmousedown: (e: MouseEvent) => { if (e.target === backdrop) finish(false); } }, card);
    document.addEventListener('keydown', onKey);
    window.addEventListener('hashchange', onHash);
    document.body.appendChild(backdrop);
    (tone === 'danger' ? cancel : ok).focus();
  });
}
export function promptModal(title: string, message: string, value = '', okLabel = 'Submit'): Promise<string | null> {
  return new Promise(resolve => {
    let done = false;
    const opener = document.activeElement as HTMLElement | null;   // a11y: restore focus to the trigger on close
    const unlock = lockPageForModal();
    const titleId = `modal-title-${++modalId}`;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') finish(null); else if (e.key === 'Tab') trapTab(e, card); };
    const onHash = () => finish(null);   // navigating away closes the modal (it lives on body, not root)
    const finish = (v: string | null) => { if (done) return; done = true; document.removeEventListener('keydown', onKey); window.removeEventListener('hashchange', onHash); backdrop.remove(); unlock(); resolve(v); window.setTimeout(() => { try { if (opener?.isConnected) opener.focus(); } catch { /* opener gone */ } }, 0); };
    const input = h('input', { type: 'text', value, 'aria-label': title }) as HTMLInputElement;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(input.value); } });
    const card = h('div', { class: 'modal-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      h('h3', { id: titleId, style: 'margin-bottom:10px' }, title),
      message ? h('div', { class: 'muted', style: 'margin-bottom:12px;line-height:1.5;white-space:pre-wrap' }, message) : '',
      h('div', { style: 'margin-bottom:16px' }, input),
      h('div', { class: 'row', style: 'justify-content:flex-end' },
        h('button', { class: 'ghost', onclick: () => finish(null) }, 'Cancel'),
        h('button', { class: 'primary', onclick: () => finish(input.value) }, okLabel)));
    const backdrop = h('div', { class: 'modal-backdrop', onmousedown: (e: MouseEvent) => { if (e.target === backdrop) finish(null); } }, card);
    document.addEventListener('keydown', onKey);
    window.addEventListener('hashchange', onHash);
    document.body.appendChild(backdrop);
    input.focus(); input.select();
  });
}
