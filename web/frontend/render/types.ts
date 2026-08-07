// ── per-player sprite record ── extracted from renderer.ts (Round: renderer-split). One of these per
// engine player id: the Pixi display objects plus the render-only latches and dirty-check fields that
// let sync()/renderFrame() skip redrawing what has not changed.
import type { Graphics, Text } from 'pixi.js';

export type PlayerEntry = {
  shadow: Graphics;      // a soft drop-shadow under the body → reads as a lit 3D figure, not a flat disc
  body: Graphics;
  arrow: Graphics;
  label: Text;
  dirTag: Text;          // the player's ACTIVE tactical directive (shown when the overlay is on; "type it → see it work")
  dirShown: string;      // last directive text written (dirty-check)
  drawn: boolean;
  wasSliding: boolean;
  wasDiving: boolean;
  hadBall: boolean;
  slideAngle: number;
  diveAngle: number;
  // ── R28 C9 duel legibility (render-only) ──
  wasRawSliding: boolean;   // raw engine tackleAnim>0 last keyframe (latch onset detector)
  slideLatchUntil: number;  // match-clock ms: keep displaying the tackle pose until then (min ~450ms —
                            // a 220ms standing win is ~2.6 keyframes at 12fps, sub-perceptual without it)
  latchSlideKind: boolean;  // latched pose: true = grounded slide, false = standing poke
  pokeAngle: number;        // locked at onset — the poked leg aims at the BALL contact point, not the run direction
  lastDribbleType: number;
  wasSprinting: boolean;
  name: string;          // the label's base (short) name — the live rating is appended to it
  ratingShown: number;   // last rating written to the label (dirty-check; -1 = none yet)
  statusShown: string;   // last condition marker (🟥/🤕/🟨) written to the label (dirty-check)
  // ── boot-arrow dirty-check (the arrow redraws in the 60fps ticker; skip it when its inputs are unchanged) ──
  armDrawn: boolean;     // has the arrow been drawn at least once
  armAngle: number;      // last facing angle drawn
  armCtrlX: number;      // last ball-relative control vector drawn (a carrier aims his boots at the ball)
  armCtrlY: number;
  armHasBall: boolean;
  armHeading: boolean;   // last header-pose state
  armKnock: boolean;     // last knock-dribble state
  armDive: boolean;      // last GK dive-pose state (gates the ready-glove draw so it redraws when a dive starts/ends)
  armGk: boolean;        // last role==='GK' state — paintArrow gates the ready-gloves on it, and a slot's role
                         // is not immutable in principle (a layout directive rewrites roles), so it must
                         // invalidate the cached template or the gloves stick on the wrong man
};
