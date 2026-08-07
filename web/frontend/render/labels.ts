// ── display strings + palette ── extracted from renderer.ts (Round: renderer-split). Every pure mapping
// the match view puts in front of the user: HUD/banner name clipping, the toast zone tag, the restart and
// event captions, the rotating broadcast commentary, and the event/rating colours. No renderer state.
import { PITCH_W, PITCH_H } from '../constants';

// commentary()'s rotation counter, owned by MatchRenderer (one per match view). It advances only when a
// line actually rotates — the `pick` calls below — so an unrotated event never shifts the next phrasing.
export type CommentaryCounter = { n: number };

// Clip a team name to the HUD width, falling back to a default — shared by the HUD + the
// goal banner + the HT/FT panel so big moments show the real club names, not 'HOME'/'AWAY'.
export function clipName(s: string | undefined, fallback: string): string {
  const n = s ?? fallback;
  return (n.length > 16 ? n.slice(0, 16) : n).toUpperCase();
}

// brief spatial tag for an event popup ("who, what, WHERE") — thirds + penalty boxes, engine coords.
export function zoneLabel(x: number, y: number): string {
  const cy = PITCH_H / 2, inBox = Math.abs(y - cy) <= 201.5;
  if (x <= 165 && inBox) return 'left box';
  if (x >= PITCH_W - 165 && inBox) return 'right box';
  if (x < PITCH_W / 3) return 'left third';
  if (x > PITCH_W * 2 / 3) return 'right third';
  return 'midfield';
}

// Compact display name for a toast: prefer the parenthetical short name the frame carries
// ("Firstname Lastname (Lastname)"), else strip a leading squad-number/team prefix.
export function shortName(raw: string): string {
  if (!raw) return '';
  const paren = raw.match(/\(([^)]+)\)/);
  return (paren ? paren[1] : raw.replace(/^[HA]?\d+\s*/, '')).trim();
}

export function restartLabel(type: string): string {
  switch (type) {
    case 'offside': return 'OFFSIDE';
    case 'free_kick': return 'FREE KICK';
    case 'penalty': return 'PENALTY';
    case 'throw_in': return 'THROW IN';
    case 'corner': return 'CORNER';
    case 'goal_kick': return 'GOAL KICK';
    default: return type.replace(/_/g, ' ').toUpperCase();
  }
}

export function eventLabel(type: string): string {
  switch (type) {
    case 'offside': return 'OFFSIDE';
    case 'foul': return 'FOUL';
    case 'intercept': return 'INTERCEPTION';
    case 'tackle_won': return 'TACKLE WON';
    case 'tackle_loose': return 'TACKLE LOOSE';
    case 'tackle': return 'TACKLE';
    case 'save': return 'SAVE';
    case 'claim': return 'CLAIMED';
    case 'penalty': return 'PENALTY!';
    case 'yellow': return 'YELLOW';
    case 'red': return 'RED CARD';
    case 'assist': return 'ASSIST';
    case 'advantage': return 'ADVANTAGE';
    case 'sub': return 'SUB';
    case 'injury': return 'INJURY';
    case 'goal': return 'GOAL';
    case 'shot': return 'SHOT';
    case 'header': return 'HEADER';
    case 'punch': return 'PUNCH';
    case 'woodwork': return 'WOODWORK';
    case 'dragback': return 'DRAG-BACK';
    case 'nutmeg': return 'NUTMEG!';
    case 'stepover': return 'STEP-OVER';
    case 'roulette': return 'ROULETTE';
    case 'gk_punch': return 'PUNCH!';
    case 'tip': return 'TIP OVER';
    default: return type.replace(/_/g, ' ').toUpperCase();
  }
}

// Turn a raw event into a line of broadcast-style commentary for the feed.
// `who` is the actor; `target` the player acted upon (nutmeg victim, fouled man).
// A few high-frequency events rotate through phrasings (keyed on the match minute,
// so it's deterministic) so a run of saves/shots doesn't read identically.
export function commentary(type: string, who: string, target: string, clockMs: number, counter: CommentaryCounter): string {
  const w = who || 'someone';
  // rotate by minute AND a per-line counter so a run of saves/shots in one minute doesn't read identically
  // (still deterministic for a given replay: same event sequence → same counter sequence; display-only)
  const pick = (arr: string[]): string => arr[Math.abs(Math.floor(clockMs / 60000) + counter.n++) % arr.length];
  switch (type) {
    case 'goal':       return pick([`⚽ GOAL! ${w} buries it!`, `⚽ GOAL! ${w} finds the net!`, `⚽ GOAL!! ${w} scores!`]);
    case 'shot':       return pick([`${w} has a crack`, `${w} lets fly`, `${w} tries his luck`]);
    case 'save':       return pick([`🧤 SAVE! ${w} denies it`, `🧤 Big stop from ${w}`, `🧤 ${w} keeps it out!`]);
    case 'tip':        return `🧤 ${w} tips it over the bar!`;
    case 'claim':      return `🧤 ${w} claims it confidently`;
    case 'punch':      return `🧤 ${w} punches clear`;
    case 'header':     return `${w} gets his head on it`;
    case 'nutmeg':     return target ? `😱 Nutmeg! ${w} slips it through ${target}` : `😱 Nutmeg by ${w}!`;
    case 'dragback':   return `${w} with a slick drag-back`;
    case 'skill':      return `${w} shows a bit of skill`;
    case 'stepover':   return `${w} dances past with a step-over`;
    case 'roulette':   return `${w} spins away — Zidane roulette!`;
    case 'gk_punch':   return `🧤 ${w} punches it clear`;
    case 'block':      return `🧱 Blocked! ${w} throws a body in the way`;
    case 'tackle_won': return `${w} wins the tackle`;
    case 'intercept':  return `${w} reads it — intercepted`;
    case 'foul':       return target ? `Foul by ${w} on ${target}` : `Foul by ${w}`;
    case 'yellow':     return `🟨 Booked — ${w}`;
    case 'red':        return `🟥 RED CARD! ${w} is off!`;
    case 'penalty':    return `❗ PENALTY!`;
    case 'offside':    return `🚩 Offside against ${w}`;
    case 'handball':   return `✋ Handball! ${w}`;
    case 'woodwork':   return `😬 Off the woodwork! ${w}`;
    // Round-31: `target` carries the OUTGOING man for a sub (the event's single id
    // is the slot, which resolves to the arriving player — see maybeToast).
    case 'sub':        return target ? `🔁 Sub — ${target} off, ${w} on` : `🔁 Sub — ${w} comes on`;
    case 'injury':     return `🤕 ${w} is down injured`;
    case 'assist':     return `🅰 Assist — ${w}`;
    case 'advantage':  return `Referee waves play on — advantage`;
    default:           return `${eventLabel(type)} ${w}`.trim();
  }
}

// Tint a player label by its rating band — green for a strong game, amber for a poor one.
export function ratingTint(r: number): number {
  return r >= 7.5 ? 0x57e08a : r >= 6.5 ? 0xffffff : r >= 5.5 ? 0xcdd6df : 0xf3b06b;
}

export function eventColor(type: string): number {
  switch (type) {
    case 'goal': return 0xffdd44;
    case 'save': return 0x44ddff;
    case 'tip': return 0x8fe3ff;     // keeper tip over the bar — bright reflex-save cyan
    case 'claim': return 0x66e0a0;   // confident catch — distinct from the reflex-save cyan
    case 'woodwork': return 0xffa033;
    case 'foul': return 0xff4444;
    case 'yellow': return 0xffd900;
    case 'red': return 0xff3030;
    case 'sub': return 0x66dd66;
    case 'injury': return 0xff8844;
    case 'offside': return 0xfff1a8;
    case 'intercept': return 0xffb347;
    case 'tackle_won': return 0x66ff99;
    case 'tackle_loose':
    case 'tackle': return 0xff6644;
    case 'shot': return 0xffffff;
    case 'header': return 0xfff1a8;
    case 'punch': return 0xff9944;
    case 'skill': return 0x7df9ff;
    case 'nutmeg': return 0xffd24d;
    case 'dragback': return 0xc9a0ff;
    case 'stepover': return 0x5cf2c0;   // teal shimmy — a cousin of the cyan skill swirl
    case 'roulette': return 0xb98cff;   // spin purple — flair, like the drag-back
    case 'gk_punch': return 0xff9944;   // keeper orange — matches the plain 'punch'
    case 'block': return 0x9aff9a;
    default: return 0xffffff;
  }
}
