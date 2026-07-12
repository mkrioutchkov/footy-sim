#pragma once
#include "types.h"
#include "constants.h"
#include <algorithm>
#include <cmath>

// ══════════════════════════════════════════════════════════════
// Ball-flight primitives
//
// The velocity / loft / curl MUTATIONS that shape a struck ball's flight used
// to be open-coded at every delivery site (crosses, chips, whipped balls, free
// kicks, keeper clearances, dead-ball retrieval). They are collected here as
// named, side-effect-only helpers so the arithmetic lives in one place.
//
// HARD RULE: these reproduce each call site's formula BYTE-FOR-BYTE. Operand
// order is preserved exactly (no reassociation under -O2/IEEE-754), so routing
// a site through a helper is a pure refactor — the golden fingerprint must not
// move. Decision logic (WHEN to loft, HOW hard) stays at the call site; only
// the mutation itself moves here.
// ══════════════════════════════════════════════════════════════

// Rotate the ball's horizontal velocity vector by `angle` radians in-plane.
// Shared by the per-tick curl integration and the whip pre-rotation.
inline void rotateBallVelocity(Ball& b, double angle) {
    double cs = std::cos(angle), sn = std::sin(angle);
    double nvx = b.vx * cs - b.vy * sn;
    b.vy = b.vx * sn + b.vy * cs;
    b.vx = nvx;
}

// Whip pre-rotation: bend the launch direction OPPOSITE the curl before flight
// so the curling arc still finishes on the intended line (matches the whip
// delivery's `preRot = -curl * flightT * 0.45`).
inline void applyCurlPreRotation(Ball& b, double curl, double flightT) {
    rotateBallVelocity(b, -curl * flightT * 0.45);
}

// Signed curl magnitude: the goalward cross-product's sign times a magnitude.
// (crossProduct >= 0 bends one way, < 0 the other.)
inline double signedCurl(double crossProduct, double magnitude) {
    return (crossProduct >= 0 ? 1.0 : -1.0) * magnitude;
}

// vz that lands a ball launched NOW at height `targetZ` after `denomT` seconds,
// sizing the gravity drop from `numerT` seconds of flight. Sites with a matched
// flight time pass numerT == denomT; sites that guard the denominator against a
// tiny flight time pass a floored denomT.
inline double landOnTargetVz(double numerT, double denomT, double targetZ) {
    return (targetZ + 0.5 * GRAVITY * numerT * numerT) / denomT;
}

// vz for a dipping parabola that peaks around 0.5*g*t and returns to the deck
// near flight time `flightT`; `k` tunes how far past the target it crests.
inline double apexDipVz(double flightT, double k) {
    return 0.5 * GRAVITY * flightT * k;
}

// Clamp the climb so the launch is never steeper than `ratio` of the current
// horizontal pace (keeps lofted deliveries off a mortar trajectory).
inline void capSteepness(Ball& b, double ratio) {
    b.vz = std::min(b.vz, std::hypot(b.vx, b.vy) * ratio);
}

// Scale the horizontal launch speed (both components) by `f`.
inline void scaleBallSpeed(Ball& b, double f) {
    b.vx *= f;
    b.vy *= f;
}

// Drive the ball along direction (dirX,dirY) of length `dirLen` at `speed`.
// Sets the horizontal velocity only; vz/z/curl stay under the caller's control.
inline void driveBall(Ball& b, double dirX, double dirY, double dirLen, double speed) {
    b.vx = dirX / dirLen * speed;
    b.vy = dirY / dirLen * speed;
}
