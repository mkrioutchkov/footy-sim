// ── match hubs ── extracted from app.ts (Round: appts-audit, pass 3): My Matches and the league's full
// results list, plus the fixture row and standings-rank helpers both screens build on.

import { api, type LeagueT, type FixtureT } from '../api.ts';
import { h } from '../ui/dom.ts';
import { ordinal } from '../ui/format.ts';
import { mount, screenGuard } from '../ui/shell.ts';
import { header } from '../ui/nav.ts';
import { screenCreateTeam } from './create-team.ts';

// ── match hubs: watch any game (viewer P1 #1/#2) ── the dashboard only surfaces next/last; these list
// the full history. Data is already served by /api/league (every fixture in the division); screenWatch
// handles any id (a recorded replay, else a live re-sim fallback).
function matchRow(f: FixtureT, withReport: boolean, rankOf?: (name: string) => number | undefined): HTMLElement {
  const wx = f.weather && f.weather !== 'clear'
    ? h('span', { class: 'pill', title: f.weather === 'rain' ? 'Wet pitch' : 'Windy', style: 'background:rgba(127,178,255,.14);color:#9ec5ff' }, f.weather === 'rain' ? '🌧' : '🌬')
    : '';
  // current league position next to each club (FM-style context for the result) — from the live standings
  const rank = (name: string): HTMLElement | string => { const r = rankOf?.(name); return r ? h('span', { class: 'muted', title: `League position ${r}`, style: 'font-size:10px;margin-left:4px' }, `#${r}`) : ''; };
  // Only a PLAYED fixture is watchable — opening an unplayed one would mark it played + live-re-sim it with
  // the (live-only) controls (P0 bug-fix #5). Unplayed shows "vs ⏳ scheduled", not a misleading 0–0 + Watch.
  const actions = f.played
    ? h('span', { class: 'fx-actions', style: 'display:flex;gap:6px;align-items:center' }, wx,
        h('button', { class: 'ghost small', title: 'Watch this match', onclick: () => (location.hash = `#/watch/${f.id}`) }, '▶ Watch'),
        withReport ? h('button', { class: 'ghost small', onclick: () => (location.hash = `#/report/${f.id}`) }, 'Report') : '')
    : h('span', { class: 'fx-actions', style: 'display:flex;gap:6px;align-items:center' }, wx, h('span', { class: 'muted', style: 'font-size:12px' }, '⏳ scheduled'));
  return h('div', { class: 'fx' + (f.involvesMe ? ' me' : '') },
    h('div', { class: 'h' }, f.home, rank(f.home)),
    f.played ? h('span', { class: 'sc' }, `${f.homeScore ?? 0}–${f.awayScore ?? 0}`) : h('span', { class: 'sc muted' }, 'vs'),
    h('div', {}, f.away, rank(f.away)),
    actions);
}

// teamName → current league position (1-based), from the position-ordered standings
function rankLookup(league: LeagueT): (name: string) => number | undefined {
  const byName = new Map(league.standings.map((s, i) => [s.name, i + 1]));
  return (name: string) => byName.get(name);
}

async function loadLeagueOr(fallback: (e: any) => void): Promise<LeagueT | null> {
  try { return await api.league(); }
  catch (e: any) { fallback(e); return null; }
}

export async function screenMyMatches() {
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading…')));
  const league = await loadLeagueOr(e => {
    if (!alive()) return;
    if (String(e.message).includes('no team')) screenCreateTeam();
    else mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message)));
  });
  if (!alive()) return;
  if (!league) return;
  const mine = league.fixtures.filter(f => f.involvesMe && f.played).sort((a, b) => b.round - a.round);
  const rankOf = rankLookup(league);
  // ── upcoming fixtures with an opponent-difficulty read (from the live table) — FM's fixture planner ──
  const myId = league.myTeamId;
  const posById = new Map(league.standings.map((s, i) => [s.teamId, i + 1]));
  const nStand = Math.max(1, league.standings.length);
  const upcoming = league.fixtures.filter(f => f.involvesMe && !f.played).sort((a, b) => a.round - b.round).slice(0, 6);
  const diffPill = (oppPos?: number) => {
    if (!oppPos) return h('span', { class: 'muted', style: 'font-size:11px' }, '—');
    const frac = (oppPos - 1) / Math.max(1, nStand - 1);   // 0 = top of the table, 1 = bottom
    const [label, col] = frac < 0.25 ? ['Very tough', 'var(--danger)'] : frac < 0.45 ? ['Tough', '#ffb84d'] : frac < 0.7 ? ['Even', '#7fb2ff'] : ['Winnable', 'var(--accent)'];
    return h('span', { class: 'pill', title: `Opponent is ${ordinal(oppPos)} in the table`, style: `background:transparent;border:1px solid ${col};color:${col};font-size:10px` }, label);
  };
  const upcomingCard = upcoming.length ? h('div', { class: 'card' },
    h('div', { class: 'section-title', style: 'margin-top:0' }, 'Upcoming fixtures'),
    ...upcoming.map(f => {
      const home = f.homeTeamId === myId;
      const opp = home ? f.away : f.home;
      const oppPos = posById.get(home ? f.awayTeamId : f.homeTeamId);
      return h('div', { class: 'between', style: 'font-size:13px;padding:5px 0;border-top:1px solid var(--line)' },
        h('span', {}, h('span', { class: 'muted', style: 'font-size:11px;margin-right:6px' }, `R${f.round}`),
          h('span', { style: 'font-weight:600' }, home ? 'vs ' : '@ ', opp), oppPos ? h('span', { class: 'muted', style: 'font-size:10px;margin-left:4px' }, `#${oppPos}`) : ''),
        h('span', { class: 'row', style: 'gap:8px;align-items:center' },
          f.weather && f.weather !== 'clear' ? h('span', { class: 'muted', style: 'font-size:11px', title: f.weather === 'rain' ? 'Wet pitch' : 'Windy' }, f.weather === 'rain' ? '🌧' : '🌬') : '',
          diffPill(oppPos),
          h('button', { class: 'ghost small', title: 'Scout this opponent', onclick: () => (location.hash = `#/scout/${f.id}`) }, '🔍')));
    })) : '';
  if (!alive()) return;
  mount(header(), h('div', { class: 'wrap grid' },
    h('div', { class: 'between' }, h('h2', {}, '📅 My Matches'), h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, '← Back')),
    upcomingCard,
    mine.length
      ? h('div', { class: 'card' }, h('div', { class: 'section-title', style: 'margin-top:0' }, 'Played'), ...mine.map(f => matchRow(f, true, rankOf)))
      : h('div', { class: 'card muted' }, 'No matches played yet — play or advance a matchday, then watch them back here.')));
}

export async function screenLeagueMatches() {
  const alive = screenGuard();
  mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'spin' }, 'Loading…')));
  const league = await loadLeagueOr(e => {
    if (!alive()) return;
    if (String(e.message).includes('no team')) screenCreateTeam();
    else mount(header(), h('div', { class: 'wrap' }, h('div', { class: 'err' }, e.message)));
  });
  if (!alive()) return;
  if (!league) return;
  const played = league.fixtures.filter(f => f.played);
  const rounds = [...new Set(played.map(f => f.round))].sort((a, b) => b - a);
  const rankOf = rankLookup(league);
  if (!alive()) return;
  mount(header(), h('div', { class: 'wrap grid' },
    h('div', { class: 'between' }, h('h2', {}, '⚽ League — all results'), h('button', { class: 'ghost', onclick: () => (location.hash = '#/') }, '← Back')),
    played.length
      ? h('div', {}, ...rounds.map(rd => h('div', { class: 'card', style: 'margin-bottom:10px' },
          h('div', { class: 'section-title', style: 'margin-top:0' }, `Round ${rd}`),
          ...played.filter(f => f.round === rd).map(f => matchRow(f, f.involvesMe, rankOf)))))
      : h('div', { class: 'card muted' }, 'No results played yet this season — advance a matchday.')));
}
