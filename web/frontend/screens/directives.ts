// ── directive readback (P4) ── extracted from app.ts (Round: appts-audit). Turns a compiled directive
// into English. Shared by the live watch panel and the tactics board, so it lives below both of them.

// ── live tactics panel helpers (P4) ──
let watchPlayers: { id: number; name: string }[] = [];
export function setDirectiveNames(players: { id: number; name: string }[]): void { watchPlayers = players; }
export function pname(id: number): string {
  return watchPlayers.find(p => p.id === id)?.name ?? `#${id}`;
}
const TEAM_LABEL: Record<string, string> = {
  all_out_attack: 'All-out attack', park_the_bus: 'Park the bus', high_press: 'High press',
  drop_off: 'Drop off / contain', play_it_long: 'Play it long', keep_it_on_ground: 'Keep it on the ground',
  get_it_wide: 'Get it wide', play_narrow: 'Play narrow', push_up: 'Push the line up', slow_it_down: 'Slow it down',
  counter_attack: 'Counter-attack', offside_trap: 'Offside trap',
  shoot_from_distance: 'Shoot from distance', work_it_into_box: 'Work it into the box',  // GAP 3: both are engine-run team kinds
};
// the gradated FM dials — [low, mid, high] readback bands keyed off the directive's intensity
const GRADATED: Record<string, [string, string, string]> = {
  press_intensity: ['pressing: sit off & contain', 'pressing: measured mid-block', 'pressing: aggressive high press'],
  mentality: ['mentality: defensive — see it out', 'mentality: balanced', 'mentality: all-out attack'],
  line_height: ['defensive line: deep block', 'defensive line: mid', 'defensive line: high & squeeze'],
  // set-piece keeper: only 0.5 (band 1) and 1 (band 2) are ever emitted; band 0 is the off state (no directive).
  gk_up_for_corners: ['set pieces: keeper back', 'set pieces: keeper up on late corners when behind', 'set pieces: keeper up for every late corner'],
};
const PLAYER_VERB: Record<string, string> = {
  shoot_on_sight: 'shoots on sight', get_forward: 'gets forward', sit_deep: 'sits deep',
  stay_wide: 'stays wide', come_inside: 'comes inside', stay_central: 'stays central',
  cross_early: 'crosses early', switch_play: 'switches the play', play_simple: 'keeps it simple',
  run_in_behind: 'runs in behind', make_runs: 'makes runs', dribble_more: 'takes them on',
  press_hard: 'presses hard', tackle_hard: 'gets stuck in', stay_on_feet: 'stays on his feet',
  cutback: 'cuts it back from the byline', contain: 'sits off and contains', stay_back: 'holds his position',
  // WAVE movement primitives — readback prose so a compiled directive reads as English, not "player: come_short"
  come_short: 'comes short to feet', check_to_feet: 'comes short to feet',
  drift_into_pocket: 'drifts into the pockets', play_between_lines: 'plays between the lines',
  between_the_lines: 'plays between the lines', drop_into_the_ten: 'drops into the ten',
  target_man_holdup: 'holds it up as the target man', hold_it_up: 'holds it up', target_man: 'holds it up',
  cut_inside: 'cuts inside to shoot', cut_in: 'cuts inside', cut_inside_to_shoot: 'cuts inside to shoot',
  overlap: 'gets on the overlap', overlap_runs: 'overlaps', get_on_the_overlap: 'gets on the overlap',
  ball_playing: 'steps out and plays it out from the back', step_out: 'steps out from the back', carry_out: 'carries it out from the back',
};
function condText(w: any): string {
  let c = '';
  if (w?.fromMin > 0 && w?.toMin < 1000) c += ` (min ${w.fromMin}–${w.toMin})`;
  else if (w?.fromMin > 0) c += ` (from ${w.fromMin}')`;
  else if (w?.toMin < 1000) c += ` (first ${w.toMin}')`;
  if (w?.scoreState && w.scoreState !== 'any') c += ` when ${w.scoreState}`;
  return c;
}
export function describeDirective(d: any): string {
  const cond = condText(d.when);
  if (GRADATED[d.kind]) {   // the FM dials — describe by where the intensity sits (0-1)
    const i = typeof d.intensity === 'number' ? d.intensity : 1;
    const band = i <= 0.3 ? 0 : i <= 0.6 ? 1 : 2;
    return `Whole team — ${GRADATED[d.kind][band]}${cond}`;
  }
  if (d.teamScope != null && TEAM_LABEL[d.kind]) return `Whole team — ${TEAM_LABEL[d.kind]}${cond}`;
  const who = pname(d.playerId);
  if (d.kind === 'man_mark') return `${who} man-marks ${pname(d.targetId)}${cond}`;
  if (d.kind === 'target_player') return `${who} feeds ${pname(d.targetId)}${cond}`;
  if (PLAYER_VERB[d.kind]) return `${who} ${PLAYER_VERB[d.kind]}${cond}`;
  return `${who}: ${d.kind}${cond}`;
}
