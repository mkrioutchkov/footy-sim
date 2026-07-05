#pragma once
#include "types.h"

// ══════════════════════════════════════════════════════════════════════════════
// Role taxonomy — the single source of truth for "what kind of player is this?"
//
// The engine keys a lot of behaviour on role. That knowledge used to live in two
// disconnected places: the PlayerAI virtual hooks (isAttackerRole()/isWidePlayer()
// /…, reachable only from an agent) and ~145 inline `role == Role::X` branches
// scattered across the engine (reachable from the Player/Role-based physics,
// defense and pass code that never touches a PlayerAI). These free functions are
// the one taxonomy both worlds share: the hooks delegate here, and the inline
// branches fold into here wherever the branch is exactly one of these sets.
//
// The truth-table below is IDENTICAL to the current PlayerAI hook returns, so the
// delegation is byte-identical:
//
//        attacker  defenderRole  defenderLike  wide   centralMid  GK
//   GK       ·          ·             ·          ·        ·        ✓
//   CB       ·          ✓             ✓          ·        ·        ·
//   FB       ·          ✓             ✓          ✓        ·        ·
//   CM       ·          ·             ✓          ·        ✓        ·
//   WM       ✓          ·             ·          ✓        ·        ·
//   CF       ✓          ·             ·          ·        ·        ·
//
// These are a taxonomy, not a straitjacket: a site that tests a genuinely one-off
// role set (e.g. CF|CM|WM in one specific pass rule) stays spelled out — only fold
// a branch whose set is exactly one of these.
//
// Wrapped in `namespace roles` so the free functions don't collide with the
// same-named PlayerAI member hooks (isCenterBack() etc.) that delegate to them.
// ══════════════════════════════════════════════════════════════════════════════

namespace roles {

// ── Attacking / defending disposition ──
constexpr bool isAttacker(Role r)     { return r == Role::CF || r == Role::WM; }
constexpr bool isDefenderRole(Role r) { return r == Role::CB || r == Role::FB; }
// CM is not a "defender" but defends like one (screens, tracks runners) — matches
// the CMPlayerAI::isDefenderLike() override.
constexpr bool isDefenderLike(Role r) { return r == Role::CB || r == Role::FB || r == Role::CM; }

// ── Channel: does this role live in a wide channel (winger / full-back)? ──
constexpr bool isWide(Role r)         { return r == Role::WM || r == Role::FB; }

// ── Exact-role predicates (mirror the per-role isXxx() hooks) ──
constexpr bool isGoalkeeper(Role r)      { return r == Role::GK; }
constexpr bool isCenterBack(Role r)      { return r == Role::CB; }
constexpr bool isFullBack(Role r)        { return r == Role::FB; }
constexpr bool isCentralMidfielder(Role r) { return r == Role::CM; }
constexpr bool isWideMidfielder(Role r)  { return r == Role::WM; }
constexpr bool isCenterForward(Role r)   { return r == Role::CF; }

} // namespace roles
