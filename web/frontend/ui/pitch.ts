// ── top-down pitch SVG ── extracted from app.ts (Round: appts-audit). Shared by the dashboard's
// formation card and the tactics board's shape preview.
import { svgEl } from './dom.ts';
import { shortName } from './format.ts';

// A top-down pitch with 11 positioned tokens (engine HOME frame: x = depth own-goal-left, y = width).
export function pitchSvg(tokens: { x: number; y: number; role: string; name: string; injured?: boolean; misfit?: boolean }[], pitchW: number, pitchH: number): SVGElement {
  const W = pitchW, H = pitchH, m = 8;
  const stroke = (extra: Record<string, string | number> = {}) => ({ fill: 'none', stroke: '#ffffff', 'stroke-opacity': 0.22, 'stroke-width': 3, ...extra });
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', style: 'max-height:520px;display:block;background:linear-gradient(180deg,#1c4a2c,#16331f);border-radius:10px' });
  svg.append(
    svgEl('rect', { x: m, y: m, width: W - 2 * m, height: H - 2 * m, ...stroke() }),
    svgEl('line', { x1: W / 2, y1: m, x2: W / 2, y2: H - m, ...stroke() }),
    svgEl('circle', { cx: W / 2, cy: H / 2, r: 80, ...stroke() }),
    svgEl('rect', { x: m, y: H / 2 - 160, width: 150, height: 320, ...stroke({ 'stroke-opacity': 0.18 }) }),
    svgEl('rect', { x: W - m - 150, y: H / 2 - 160, width: 150, height: 320, ...stroke({ 'stroke-opacity': 0.18 }) }),
  );
  for (const t of tokens) {
    // GK gold; a holding mid (DM) reads cooler/deeper, a #10 (AM) warmer/higher; outfield default green.
    const color = t.role === 'GK' ? '#ffd24d' : t.role === 'DM' ? '#4db8ff' : t.role === 'AM' ? '#ff9d5c' : '#43d39e';
    const g = svgEl('g', { transform: `translate(${t.x},${t.y})` });
    // Injured (red ring + 🤕) — auto-subbed at kickoff (§1.3). Out-of-position (amber ring + ⚠) —
    // a player anchored off his role for this shape (§1.11). Injured takes visual priority.
    const ring = t.injured ? '#ff5d5d' : t.misfit ? '#ffb84d' : '#0b1018';
    g.append(
      svgEl('circle', { r: 30, fill: color, 'fill-opacity': t.injured ? 0.35 : 0.92, stroke: ring, 'stroke-width': t.injured || t.misfit ? 3 : 2 }),
      svgEl('text', { 'text-anchor': 'middle', y: 6, 'font-size': 21, 'font-weight': 700, fill: '#0b1018' }, t.role),
      svgEl('text', { 'text-anchor': 'middle', y: 56, 'font-size': 22, fill: '#eef3f8', 'paint-order': 'stroke', stroke: '#0b1018', 'stroke-width': 4 }, shortName(t.name)),
    );
    if (t.injured) g.append(svgEl('text', { 'text-anchor': 'middle', y: -22, 'font-size': 26 }, '🤕'));
    else if (t.misfit) g.append(svgEl('text', { 'text-anchor': 'middle', y: -20, 'font-size': 22 }, '⚠'));
    svg.append(g);
  }
  return svg;
}
