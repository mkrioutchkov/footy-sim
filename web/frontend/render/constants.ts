// ── renderer tuning constants ── extracted from renderer.ts (Round: renderer-split). These are the
// RENDERER's own knobs (tween/magnetization/debug), each with a measured justification in its comment;
// the pitch geometry and palette shared with the rest of the frontend stay in ../constants.
import { PLAYER_R } from '../constants';

export const TRAIL_LENGTH = 16;
// Render-only player disc radius. Smaller than the physics PLAYER_R (12) so the pitch reads less
// crowded, the ball stays legible against a pack, and there's room for the facing chevron drawn at
// the disc edge. Every player-owned graphic (body, shadow, boots/head, chevron, carrier ring, label
// offset) scales off this; transient effect rings (events, set-piece) stay on the physics PLAYER_R.
export const DISC_R = PLAYER_R * 0.78;
// A per-player step this big between two ingested frames is a TELEPORT (seek, kickoff, restart, a
// sent-off body being parked off the touchline), not motion — the tween snaps to the new sample
// instead of sliding the man across the pitch. Shared by the player tween and by the carried-ball
// magnetization gate so the two can never disagree about what counts as a teleport.
export const PLAYER_SNAP_DIST = 120;
// Largest ball-to-carrier separation that still reads as a ball AT THE FEET (carried-ball
// magnetization gate). This is the engine's own carry/reset line, not a renderer guess: the glue holds
// a carried ball at CONTROL_DIST (12) plus a knock extension that peaks at 17, and treats a controlled
// ball more than 60 from that control offset as a deliberate reset it writes OUTRIGHT rather than a
// carry it steps (engine/engine_physics.cpp, the `md < 60.0` branch). Past it, magnetizing would glue
// the ball to a man who is no longer really carrying it.
export const CARRY_MAGNET_MAX_OFFSET = 60;
// …and the magnet's chase toward that offset is itself rate-capped, for the same reason the ENGINE's
// carry glue is one. A demanded offset change faster than the glue can move a carried ball is not carry
// motion at all: it is this renderer's own anchoring lag. The drawn carrier trails the engine carrier
// through the player EMA, and on the FIRST magnetized segment of a carry that whole lag lands on the
// offset at once — measured p99 5.2, worst 33.7 units of pitch. Uncapped, that one segment renders a
// bigger pop than the jag being fixed (worst single-frame step 10.0 -> 16.3 at 1x on seed 151), which
// is why the standalone template's stateless version does not port over as-is.
// 220 units/sec is the engine's own steady-state glue allowance (engine_physics.cpp `maxStep`, trimmed
// to +220 in Round-23), and over seed 151's 110 719 carried frame-pairs the p99 of the ball's TRUE
// offset rate is 214 units/sec — so the cap sits at the very top of the real distribution: it can
// barely touch engine truth, and whatever it does clip is carried into the next segment's re-anchor
// rather than dropped.
export const CARRY_MAGNET_CHASE_RATE = 220;   // units of pitch per second of MATCH time
// Ceiling on the match-time window the chase is allowed to bank, matching the tween window's own 600ms
// clamp: a longer gap between frames is a seek, not a segment. A zero/backwards gap (a pause, a
// duplicate frame, a rewind) yields a zero budget, which correctly freezes the offset — no match time
// passed, so the ball has no business moving on its carrier.
export const CARRY_MAGNET_MAX_CHASE_MS = 600;
// Gate the per-frame diagnostic logging (first-sync dump + facing-flicker warnings). Off in
// normal play so the hot path doesn't do per-player bookkeeping or spam the console.
export const RENDER_DEBUG = false;
