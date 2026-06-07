with open('native/agent_positioning.cpp', 'r', encoding='utf-8') as f:
    content = f.read()

# Map of old -> new for replacements.
# For 'this' player (our own agent), use direct virtual calls.
# For other players, use agentFor(*other)->hook().
# Use agent references where the player is a local reference.

replacements = [
    # Line 13: iw = (p.role == Role::FB || p.role == Role::WM)
    ("p.role == Role::FB || p.role == Role::WM)", "isFullBack() || isWideMidfielder()"),

    # Line 46: p.role == Role::CB || p.role == Role::FB || p.role == Role::CM
    ("p.role == Role::CB || p.role == Role::FB || p.role == Role::CM)", "isDefenderLike()"),

    # Line 53: p.role == Role::CF
    ("!immediateDanger && p.role == Role::CF)", "!immediateDanger && isCenterForward()"),

    # Line 57: p.role == Role::WM && std::abs
    ("!immediateDanger && p.role == Role::WM && std::abs(p.homeY - b.y) > 190.0)", "!immediateDanger && isWideMidfielder() && std::abs(p.homeY - b.y) > 190.0"),

    # Line 65: p.role == Role::WM || p.role == Role::FB
    ("if (p.role == Role::WM || p.role == Role::FB)\n                c.push_back({ p.homeX + fd * 40.0 + pu, clamp(p.homeY + ((p.homeY < PITCH_H / 2.0) ? -50.0 : 50.0), 40.0, PITCH_H - 40.0), ActionPurpose::Space });",
     "if (isWideMidfielder() || isFullBack())\n                c.push_back({ p.homeX + fd * 40.0 + pu, clamp(p.homeY + ((p.homeY < PITCH_H / 2.0) ? -50.0 : 50.0), 40.0, PITCH_H - 40.0), ActionPurpose::Space });"),

    # Line 69: p.role == Role::CM || p.role == Role::CF
    ("if (p.role == Role::CM || p.role == Role::CF)\n                c.push_back({ lerp(p.homeX, b.x, 0.3), lerp(p.homeY, b.y, 0.2), ActionPurpose::Cover });",
     "if (isCentralMidfielder() || isCenterForward())\n                c.push_back({ lerp(p.homeX, b.x, 0.3), lerp(p.homeY, b.y, 0.2), ActionPurpose::Cover });"),

    # Line 90: if (p.role == Role::WM) { ... carrier->role != Role::WM
    # Need to handle two replacements in the WM block
    ("if (p.role == Role::WM) {\n                bool sameSide = std::abs(carrier->y - p.homeY) < 190.0;",
     "if (isWideMidfielder()) {\n                bool sameSide = std::abs(carrier->y - p.homeY) < 190.0;"),
    ("sameSide && carrier->role != Role::WM)", "sameSide && !engine.agentFor(*carrier)->isWideMidfielder()"),

    # Line 105: if (p.role == Role::CF) {
    ("if (p.role == Role::CF) {\n                double oppGoalX = goalXFor(p.team);\n                bool carrierWide",
     "if (isCenterForward()) {\n                double oppGoalX = goalXFor(p.team);\n                bool carrierWide"),

    # Lines 140/146: ba > 0.6 && p.role == Role::CF / carrier->role == Role::WM || carrier->role == Role::FB
    ("ba > 0.6 && p.role == Role::CF)", "ba > 0.6 && isCenterForward()"),
    ("carrier->role == Role::WM || carrier->role == Role::FB)",
     "engine.agentFor(*carrier)->isWideMidfielder() || engine.agentFor(*carrier)->isFullBack()"),

    # Line 154: ba > 0.6 && p.role == Role::WM
    ("ba > 0.6 && p.role == Role::WM)", "ba > 0.6 && isWideMidfielder()"),

    # Line 168: ba > 0.6 && p.role == Role::CM
    ("ba > 0.6 && p.role == Role::CM)", "ba > 0.6 && isCentralMidfielder()"),

    # Line 183: if (p.role == Role::CM) {
    ("if (p.role == Role::CM) {\n            double midSum = 0, defSum = 0;",
     "if (isCentralMidfielder()) {\n            double midSum = 0, defSum = 0;"),

    # Lines 188/189: o.role == Role::CM || o.role == Role::WM,  o.role == Role::CB || o.role == Role::FB
    ("o.role == Role::CM || o.role == Role::WM)", "engine.agentFor(o)->isCentralMidfielder() || engine.agentFor(o)->isWideMidfielder()"),
    ("o.role == Role::CB || o.role == Role::FB)", "engine.agentFor(o)->isDefenderRole()"),

    # Line 208: if (p.role == Role::WM) {  (second WM block with carrier role checks)
    # This is the block starting around line 208
    # We need to handle: carrier->role == Role::CM || carrier->role == Role::CB
    ("if (p.role == Role::WM) {\n            double flankY = (p.homeY < PITCH_H / 2.0) ? 18.0 : PITCH_H - 18.0;\n            ActionPurpose crossPur",
     "if (isWideMidfielder()) {\n            double flankY = (p.homeY < PITCH_H / 2.0) ? 18.0 : PITCH_H - 18.0;\n            ActionPurpose crossPur"),
    ("carrier->role == Role::CM || carrier->role == Role::CB)",
     "engine.agentFor(*carrier)->isCentralMidfielder() || engine.agentFor(*carrier)->isCenterBack()"),

    # Line 220: second occurrence of carrier->role == Role::CM || carrier->role == Role::CB (in the WM+carrier block)
    # Already handled above with the same pattern

    # Line 230: p.role == Role::CB || p.role == Role::FB  (push up into attack area)
    ("if (p.role == Role::CB || p.role == Role::FB)\n            c.push_back({ p.homeX + fd * 150.0 + pu, p.homeY, ActionPurpose::Cover });",
     "if (isDefenderRole())\n            c.push_back({ p.homeX + fd * 150.0 + pu, p.homeY, ActionPurpose::Cover });"),

    # Line 236: p.role == Role::WM || p.role == Role::FB  (space on flank)
    ("if (p.role == Role::WM || p.role == Role::FB)\n            c.push_back({ p.homeX + fd * 40.0 + pu, clamp(p.homeY + ((p.homeY < PITCH_H / 2.0) ? -80.0 : 80.0), 30.0, PITCH_H - 30.0), ActionPurpose::Space });",
     "if (isWideMidfielder() || isFullBack())\n            c.push_back({ p.homeX + fd * 40.0 + pu, clamp(p.homeY + ((p.homeY < PITCH_H / 2.0) ? -80.0 : 80.0), 30.0, PITCH_H - 30.0), ActionPurpose::Space });"),

    # Line 239: p.role == Role::FB && my  (FB overlap)
    ("if (p.role == Role::FB && my) {\n            Player* wmOnMySide = nullptr;",
     "if (isFullBack() && my) {\n            Player* wmOnMySide = nullptr;"),

    # Line 241: o.role == Role::WM && std::abs(o.homeY - p.homeY) < 100.0
    ("o.role == Role::WM && std::abs(o.homeY - p.homeY) < 100.0)",
     "engine.agentFor(o)->isWideMidfielder() && std::abs(o.homeY - p.homeY) < 100.0"),

    # Lines 251-253: supportCarrier->role == Role::CM || supportCarrier->role == Role::CB
    ("supportCarrier->role == Role::CM || supportCarrier->role == Role::CB)\n                       && std::abs(supportCarrier->y - p.homeY) < 185.0",
     "engine.agentFor(*supportCarrier)->isCentralMidfielder() || engine.agentFor(*supportCarrier)->isCenterBack())\n                       && std::abs(supportCarrier->y - p.homeY) < 185.0"),

    # Line 268: p.role == Role::CF
    ("if (p.role == Role::CF) {\n            double oppGoalX = goalXFor(p.team);\n            double ld = (fd == 1.0) ? -1e9 : 1e9;",
     "if (isCenterForward()) {\n            double oppGoalX = goalXFor(p.team);\n            double ld = (fd == 1.0) ? -1e9 : 1e9;"),

    # Line 272: o.role != Role::GK
    ("o.role != Role::GK)", "!engine.agentFor(o)->isCenterBack() && !engine.agentFor(o)->isFullBack() && !engine.agentFor(o)->isCentralMidfielder() && !engine.agentFor(o)->isWideMidfielder() && !engine.agentFor(o)->isCenterForward()"),

    # Line 297: p.role == Role::CB || p.role == Role::FB  (defensive line)
    ("!my && (p.role == Role::CB || p.role == Role::FB))",
     "!my && isDefenderRole())"),

    # Line 303: t.role == Role::CB || t.role == Role::FB (teammate role)
    ("t.role == Role::CB || t.role == Role::FB)",
     "engine.agentFor(t)->isDefenderRole()"),

    # Line 312: p.role == Role::FB
    ("if (p.role == Role::FB) {\n            double ownGx = ownGoalXFor(p.team);",
     "if (isFullBack()) {\n            double ownGx = ownGoalXFor(p.team);"),

    # Line 320: p.role == Role::FB ? 6.0 : 15.0 (in lineX offset)
    ("p.role == Role::FB ? 6.0 : 15.0)", "isFullBack() ? 6.0 : 15.0"),

    # Line 326: p.role == Role::FB ? 10.0 : 20.0 (drop amount)
    ("dropAmount = p.role == Role::FB ? 10.0 : 20.0;", "dropAmount = isFullBack() ? 10.0 : 20.0;"),

    # Line 329: p.role == Role::CB
    ("if (p.role == Role::CB) c.push_back({ dropX - fd * 20.0, p.homeY, ActionPurpose::Cover });",
     "if (isCenterBack()) c.push_back({ dropX - fd * 20.0, p.homeY, ActionPurpose::Cover });"),

    # Line 335: p.role != Role::FB && p.role != Role::CB
    ("p.role != Role::FB && p.role != Role::CB)", "!isFullBack() && !isCenterBack()"),

    # Line 342: p.role == Role::FB ? 4.0 : 30.0
    ("p.role == Role::FB ? 4.0 : 30.0)", "isFullBack() ? 4.0 : 30.0"),

    # Line 343: p.role == Role::FB && std::abs...
    ("if (p.role == Role::FB && std::abs(b.y - p.homeY) > 200.0)",
     "if (isFullBack() && std::abs(b.y - p.homeY) > 200.0)"),

    # Lines 361, 362, 364, 366: p.role == Role::WM in the scoring section
    ("(cn.pur == ActionPurpose::InsideRun && p.role == Role::WM && ba > 0.42) ? 0.20 :",
     "(cn.pur == ActionPurpose::InsideRun && isWideMidfielder() && ba > 0.42) ? 0.20 :"),
    ("(cn.pur == ActionPurpose::RunAhead && p.role == Role::WM) ? 0.14 :",
     "(cn.pur == ActionPurpose::RunAhead && isWideMidfielder() ? 0.14 :"),
    ("(cn.pur == ActionPurpose::HoldWidth && p.role == Role::WM && ba > 0.45) ? 0.10 :",
     "(cn.pur == ActionPurpose::HoldWidth && isWideMidfielder() && ba > 0.45) ? 0.10 :"),
    ("(cn.pur == ActionPurpose::Space && p.role == Role::WM && std::abs(cn.y - PITCH_H / 2.0) > 150.0 && ba > 0.4) ? 0.12 : 0.0;",
     "(cn.pur == ActionPurpose::Space && isWideMidfielder() && std::abs(cn.y - PITCH_H / 2.0) > 150.0 && ba > 0.4) ? 0.12 : 0.0;"),

    # Line 394-395: p.role == Role::CM || p.role == Role::FB || p.role == Role::CB  (roleCanStep)
    ("roleCanStep = p.role == Role::CM || p.role == Role::FB || p.role == Role::CB\n            || (p.role == Role::WM && std::abs(carrier->y - p.y) < 170.0);",
     "roleCanStep = isDefenderLike()\n            || (isWideMidfielder() && std::abs(carrier->y - p.y) < 170.0);"),
]

applied = 0
for old, new in replacements:
    if old in content:
        content = content.replace(old, new)
        applied += 1
        print(f'Applied: {old[:50]}...')
    else:
        print(f'WARNING: pattern not found: {old[:50]}...')

with open('native/agent_positioning.cpp', 'w', encoding='utf-8') as f:
    f.write(content)

print(f'\n{applied}/{len(replacements)} replacements applied')
