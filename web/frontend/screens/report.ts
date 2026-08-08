// ── match report ── extracted from app.ts (Round: appts-audit, pass 3): the post-match report and the
// shout-review card. Both of shoutReviewCard's call sites are in this module (the full report and the
// "no recording" fallback), so it stays private here rather than becoming another shared helper.

import { api, type ReportT, type TacticsReviewT, type ShoutReviewT, type TimelineEventT } from '../api.ts';
import { h } from '../ui/dom.ts';
import { mount, screenGuard } from '../ui/shell.ts';
import { header } from '../ui/nav.ts';

// ── post-match report + player ratings (generated from the recording) ──
// The persisted shout log for a watched match — minute · what you said · what it changed.
// Independent of the frame recording (a shout-driven match may have no replay), so it can ride
// either the full report or the "no recording" fallback. '' when there were no shouts.
function shoutReviewCard(tac: TacticsReviewT, fixtureId: number): HTMLElement | string {
  if (!tac.shouts.length) return '';
  const changed = (s: ShoutReviewT): string => {
    const bits = [`${s.directives} instruction${s.directives === 1 ? '' : 's'}`];
    if (s.formationChange) bits.push('formation change');
    if (s.morale) bits.push(`${s.morale} player${s.morale === 1 ? '' : 's'} rallied`);
    return bits.join(' · ');
  };
  return h('div', { class: 'card', style: 'margin-top:10px' },
    h('div', { class: 'between', style: 'margin-bottom:2px' },
      h('div', { class: 'section-title', style: 'margin:0' }, '📣 Your shouts this match'),
      // Re-sim the match from this command log (deterministic) and watch it play back, paced.
      h('button', { class: 'ghost small', title: 'Re-simulate the match from these shouts and watch it back', onclick: () => (location.hash = `#/watch/${fixtureId}?shouts=1`) }, '▶ Replay from shouts')),
    ...tac.shouts.map(s => h('div', { style: 'padding:5px 0;border-top:1px solid var(--line)' },
      h('div', { style: 'font-size:13px' }, h('span', { class: 'muted', style: 'font-variant-numeric:tabular-nums' }, `${s.minute}' `), `“${s.text}”`),
      h('div', { class: 'muted', style: 'font-size:11px;margin-top:2px' }, changed(s)))));
}

export async function screenReport(fixtureId: number, cup = false) {
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Reading the match…')));
  // A cup tie's replay is spectator-only (no shout log / tactics endpoint keyed by tie id), so the
  // shout review is a league-fixture concept — skip it (and its fetch) for cup reports.
  const watchSuffix = cup ? '?cup=1' : '';
  const tacP = cup ? Promise.resolve<TacticsReviewT>({ shouts: [] })
    : api.tactics(fixtureId).catch((): TacticsReviewT => ({ shouts: [] }));
  let rep: ReportT;
  try { rep = await api.report(fixtureId, cup); }
  catch (e: any) {
    const tac = await tacP;
    const msg = String(e.message).includes('no recording')
      ? "No report yet — this match wasn't recorded (play or watch it first)."
      // a past-season fixture is purged at rollover, so an old inbox 'report' deep-link 404s here
      : String(e.message).includes('not found')
        ? "This report is no longer available — matches from past seasons are cleared when the season rolls over."
        : e.message;
    if (!alive()) return;
    return mount(header(), h('div', { class: 'wrap grid' },
      h('div', { class: 'between' }, h('h2', {}, 'Match report'), h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, '← Back')),
      h('div', { class: 'card muted' }, msg),
      cup ? '' : shoutReviewCard(tac, fixtureId)));
  }
  const tac = await tacP;

  const icon = (t: string) => t === 'goal' ? '⚽' : t === 'red' ? '🟥' : t === 'penalty' ? '🎯' : t === 'woodwork' ? '🪵' : '🟨';
  const evClock = (e: TimelineEventT): number => typeof e.clockMs === 'number' ? e.clockMs : Math.max(0, ((e.minute ?? 1) - 1) * 60000);
  const HOME_C = '#ff8a8a', AWAY_C = '#9ecbff';   // the renderer's banner colours — home/away read the same everywhere

  // ── scoreboard: the result at a glance, scorers + reds under each side (the prose stays below) ──
  const sideEvents = (team: 'home' | 'away') => rep.facts.timeline
    .filter(e => e.team === team && (e.type === 'goal' || e.type === 'red'))
    .map(e => h('div', { class: 'muted', style: 'font-size:12px;padding:1px 0' }, `${icon(e.type)} ${e.name} ${e.minute}'`));
  const shootoutLine = rep.shootout ? (() => {
    const winnerName = rep.shootout.winner === 'home' ? rep.homeName : rep.awayName;
    const winnerPens = rep.shootout.winner === 'home' ? rep.shootout.home : rep.shootout.away;
    const loserPens = rep.shootout.winner === 'home' ? rep.shootout.away : rep.shootout.home;
    return h('div', { style: 'text-align:center;font-size:13px;font-weight:700;margin-top:4px;color:var(--gold,#e8b53a)' }, `${winnerName} won ${winnerPens}–${loserPens} on penalties`);
  })() : '';
  const scoreboard = h('div', { class: 'card' },
    h('div', { style: 'display:flex;align-items:baseline;justify-content:center;gap:18px;flex-wrap:wrap' },
      h('div', { style: `flex:1;min-width:120px;text-align:right;font-weight:700;color:${HOME_C}` }, rep.homeName),
      h('div', { style: 'font-size:34px;font-weight:800;font-variant-numeric:tabular-nums;letter-spacing:1px' }, `${rep.facts.homeScore} — ${rep.facts.awayScore}`),
      h('div', { style: `flex:1;min-width:120px;font-weight:700;color:${AWAY_C}` }, rep.awayName)),
    shootoutLine,
    h('div', { style: 'display:flex;gap:18px;margin-top:6px' },
      h('div', { style: 'flex:1;text-align:right' }, ...sideEvents('home')),
      h('div', { style: 'width:60px' }),
      h('div', { style: 'flex:1' }, ...sideEvents('away'))));

  // ── the match on one strip: every moment positioned at its REAL clock, home above / away below the
  //    spine. Click any marker → the replay AT that moment (#/watch/id?t=). ──
  const lastClock = rep.facts.timeline.reduce((m, e) => Math.max(m, evClock(e)), 0);
  const stripDur = Math.max(90 * 60000, lastClock + 90000);
  const stripMark = (e: TimelineEventT) => {
    const pct = Math.min(99, Math.max(1, (evClock(e) / stripDur) * 100));
    return h('button', {
      class: 'ghost', title: `${e.minute}' ${e.name} — watch this moment`,
      style: `position:absolute;left:${pct}%;${e.team === 'home' ? 'bottom:52%' : 'top:52%'};transform:translateX(-50%);border:none;background:none;padding:1px 2px;font-size:15px;line-height:1;cursor:pointer`,
      onclick: () => (location.hash = `#/watch/${fixtureId}?t=${Math.max(0, evClock(e) - 5000)}${cup ? '&cup=1' : ''}`),
    }, icon(e.type));
  };
  const stripTick = (pct: number, lab: string) => [
    h('span', { style: `position:absolute;left:${pct}%;top:46%;bottom:46%;width:1px;background:var(--line)` }),
    h('span', { class: 'muted', style: `position:absolute;left:${pct}%;top:100%;transform:translate(-50%,-14px);font-size:10px` }, lab)];
  const timeline = rep.facts.timeline.length
    ? h('div', { class: 'card', style: 'margin-top:10px' },
        h('div', { class: 'between', style: 'margin-bottom:2px' },
          h('div', { class: 'section-title', style: 'margin:0' }, 'Timeline'),
          h('span', { class: 'muted', style: 'font-size:11px' }, `${rep.homeName} above · ${rep.awayName} below · click a moment to watch it`)),
        h('div', { style: 'position:relative;height:64px' },
          h('div', { style: 'position:absolute;left:0;right:0;top:50%;height:2px;background:var(--line)' }),
          ...stripTick(0.5, "0'"), ...stripTick((45 * 60000 / stripDur) * 100, 'HT'), ...stripTick((90 * 60000 / stripDur) * 100, 'FT'),
          ...rep.facts.timeline.map(stripMark)))
    : '';

  // ── head-to-head bars: the split stats, mirrored around the centre ──
  const statBar = (label: string, hv: number, av: number, fmt = (n: number) => String(n)) => {
    const total = Math.max(1, hv + av);
    return h('div', { style: 'margin:7px 0' },
      h('div', { style: 'display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px' },
        h('span', { style: 'font-variant-numeric:tabular-nums;font-weight:600' }, fmt(hv)), h('span', { class: 'muted' }, label), h('span', { style: 'font-variant-numeric:tabular-nums;font-weight:600' }, fmt(av))),
      h('div', { style: 'display:flex;height:6px;border-radius:3px;overflow:hidden;background:var(--line)' },
        h('div', { style: `width:${(hv / total) * 100}%;background:${HOME_C}` }),
        h('div', { style: `width:${(av / total) * 100}%;background:${AWAY_C}` })));
  };

  // ratings, one column per side, best first
  const ratingsCol = (team: 'home' | 'away', label: string) => {
    const cleanSheet = (team === 'home' ? rep.facts.awayScore : rep.facts.homeScore) === 0;   // this side conceded nothing
    return h('div', { style: 'flex:1;min-width:200px' },
      h('div', { class: 'section-title', style: 'margin-top:0' }, label),
      ...rep.ratings.filter(r => r.team === team).sort((a, b) => b.rating - a.rating).map(r => {
        const tag = (n: number, s: string, title: string) => n > 0 ? h('span', { class: 'pill', title, style: 'margin-left:4px' }, `${n}${s}`) : '';
        // heat: 4.0 red → 9.0 green (same hsl ramp as the squad attribute heat) — the whole column reads at a glance
        const hue = Math.max(0, Math.min(120, Math.round(((r.rating - 4) / 5) * 120)));
        const cs = (cleanSheet && r.role === 'GK') ? h('span', { class: 'pill', title: 'Clean sheet', style: 'margin-left:4px' }, '🧤') : '';
        return h('div', { class: 'between', style: 'font-size:13px;padding:2px 0' },
          h('span', {}, `${r.name} `, h('span', { class: 'muted', style: 'font-size:11px' }, r.role),
            tag(r.goals, '⚽', 'Goals'), tag(r.assists, '🅰', 'Assists'), tag(r.shots, '🎯', 'Shots'), tag(r.tackles, '🛡', 'Tackles'), cs),
          h('span', { style: `font-weight:700;font-variant-numeric:tabular-nums;color:hsl(${hue},70%,62%)` }, r.rating.toFixed(1)));
      }));
  };

  const f = rep.facts;
  // Man of the Match — the highest match rating across both sides (a staple report headline).
  const motm = [...rep.ratings].sort((a, b) => b.rating - a.rating)[0];
  if (!alive()) return;
  mount(header(), h('div', { class: 'wrap grid' },
    h('div', { class: 'between' }, h('h2', {}, rep.headline),
      // From the report you can jump straight into the replay (now with rewind/scrub) — no hunting for
      // the fixture back on the dashboard.
      h('div', { class: 'row' },
        h('button', { class: 'ghost', title: 'Watch this match back — rewind and scrub to any moment', onclick: () => (location.hash = `#/watch/${fixtureId}${watchSuffix}`) }, '▶ Watch replay'),
        h('button', { class: 'ghost', onclick: () => (location.hash = cup ? '#/cup' : '#/') }, '← Back'))),
    scoreboard,
    timeline,
    h('div', { class: 'grid cols-2', style: 'align-items:start;margin-top:10px' },
      h('div', { class: 'card' },
        h('div', { style: 'white-space:pre-wrap;line-height:1.5' }, rep.body)),
      h('div', { class: 'card' },
        h('div', { class: 'section-title', style: 'margin-top:0' }, 'Head to head'),
        statBar('Possession', f.possessionHome, 100 - f.possessionHome, n => `${n}%`),
        statBar('Shots', f.shots.home, f.shots.away),
        h('div', { class: 'muted', style: 'margin-top:8px;font-size:12px' },
          `${f.shotsOnTarget} on target · ${f.saves} saves · ${f.corners} corners`))),
    h('div', { class: 'card', style: 'margin-top:10px' },
      h('div', { class: 'between', style: 'align-items:center;flex-wrap:wrap;gap:8px' },
        h('div', { class: 'section-title', style: 'margin-top:0' }, 'Player ratings'),
        motm ? h('span', { class: 'pill', title: 'Highest match rating', style: 'background:var(--gold,#e8b53a);color:#1a1205;font-weight:700' }, `⭐ Man of the Match — ${motm.name} (${motm.team === 'home' ? rep.homeName : rep.awayName}) ${motm.rating.toFixed(1)}`) : ''),
      h('div', { style: 'display:flex;gap:24px;flex-wrap:wrap' }, ratingsCol('home', rep.homeName), ratingsCol('away', rep.awayName))),
    cup ? '' : shoutReviewCard(tac, fixtureId),
  ));
}
