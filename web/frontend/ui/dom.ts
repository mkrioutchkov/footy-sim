// ── tiny DOM helpers ── extracted from app.ts (Round: appts-audit). Zero dependencies: the leaf of the
// frontend module graph, so every screen module can import it without risking a cycle.
export type Attrs = Record<string, any>;
export function h(tag: string, attrs: Attrs = {}, ...kids: (Node | string)[]): HTMLElement {
  const e = document.createElement(tag);
  // No `innerHTML` escape hatch on purpose — every value goes in as text or an attribute, so
  // user-supplied strings (team/player names, plans) can never inject markup. Build structure
  // with child nodes instead.
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, String(v));
  }
  for (const kid of kids) e.append(kid instanceof Node ? kid : document.createTextNode(kid));
  return e;
}
// a11y: keyboard-accessible props for a clickable NON-button element (a card/row div). role+tabindex make it
// focusable; Enter/Space activate it like a real button. Spread into h()'s attrs in place of a bare onclick.
export function clickable(handler: () => void): Attrs {
  return { role: 'button', tabindex: '0', onclick: handler, onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); } } };
}
// Global shortcuts must yield to anything the browser already treats as interactive. In particular,
// Space on a focused button should click that button—not bubble into the match viewer's pause shortcut.
export function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('button, input, textarea, select, a, [role="button"], [contenteditable]');
}
// SVG sibling of h() — createElementNS so <svg> children render; values go in as attributes and
// text as text nodes (so player names can't inject markup), same XSS-safe posture as h().
export function svgEl(tag: string, attrs: Record<string, string | number | undefined> = {}, ...kids: (Node | string)[]): SVGElement {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) e.setAttribute(k, String(v));
  for (const kid of kids) e.append(kid instanceof Node ? kid : document.createTextNode(kid));
  return e;
}
