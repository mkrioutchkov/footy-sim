with open('native/agent_positioning.cpp', 'r', encoding='utf-8') as f:
    content = f.read()

fixes = [
    # Line 13: missing closing paren
    ('bool iw = (isFullBack() || isWideMidfielder();',
     'bool iw = (isFullBack() || isWideMidfielder());'),

    # Line 47: extra opening paren before isDefenderLike
    ('if (ballPastUs && (isDefenderLike()) {',
     'if (ballPastUs && isDefenderLike()) {'),

    # Line 53: missing ) before {
    ('if (!immediateDanger && isCenterForward() {',
     'if (!immediateDanger && isCenterForward()) {'),

    # Line 57: missing ) before {
    ('if (!immediateDanger && isWideMidfielder() && std::abs(p.homeY - b.y) > 190.0 {',
     'if (!immediateDanger && isWideMidfielder() && std::abs(p.homeY - b.y) > 190.0) {'),

    # Line 92: missing ) before {
    ('if (sameSide && !engine.agentFor(*carrier)->isWideMidfielder() {',
     'if (sameSide && !engine.agentFor(*carrier)->isWideMidfielder()) {'),

    # Line 140: missing ) before {
    ('if (ba > 0.6 && isCenterForward() {',
     'if (ba > 0.6 && isCenterForward()) {'),

    # Lines 146-147, 158-160, 162-164, 187: carrier isWideMidfielder/isFullBack missing ) 
    # Pattern: (engine.agentFor(*carrier)->isWideMidfielder() || engine.agentFor(*carrier)->isFullBack()\n
    ('(engine.agentFor(*carrier)->isWideMidfielder() || engine.agentFor(*carrier)->isFullBack()\n',
     '(engine.agentFor(*carrier)->isWideMidfielder() || engine.agentFor(*carrier)->isFullBack())\n'),

    # Line 154: missing ) before {
    ('if (ba > 0.6 && isWideMidfielder() {',
     'if (ba > 0.6 && isWideMidfielder()) {'),

    # Line 168: missing ) before {
    ('if (ba > 0.6 && isCentralMidfielder() {',
     'if (ba > 0.6 && isCentralMidfielder()) {'),

    # Line 188: missing ) before {
    ('if (engine.agentFor(o)->isCentralMidfielder() || engine.agentFor(o)->isWideMidfielder() {',
     'if (engine.agentFor(o)->isCentralMidfielder() || engine.agentFor(o)->isWideMidfielder()) {'),

    # Line 189: missing ) before {
    ('if (engine.agentFor(o)->isDefenderRole() {',
     'if (engine.agentFor(o)->isDefenderRole()) {'),

    # Line 220: carrier isCentralMidfielder/isCenterBack missing )
    ('(engine.agentFor(*carrier)->isCentralMidfielder() || engine.agentFor(*carrier)->isCenterBack()\n',
     '(engine.agentFor(*carrier)->isCentralMidfielder() || engine.agentFor(*carrier)->isCenterBack())\n'),

    # Line 241: missing ) before {
    ('if (o.team == p.team && engine.agentFor(o)->isWideMidfielder() && std::abs(o.homeY - p.homeY) < 100.0 {',
     'if (o.team == p.team && engine.agentFor(o)->isWideMidfielder() && std::abs(o.homeY - p.homeY) < 100.0) {'),

    # Line 272: INVERTED LOGIC BUG + missing paren. Revert to raw o.role != Role::GK
    ('if (o.team != p.team && !engine.agentFor(o)->isCenterBack() && !engine.agentFor(o)->isFullBack() && !engine.agentFor(o)->isCentralMidfielder() && !engine.agentFor(o)->isWideMidfielder() && !engine.agentFor(o)->isCenterForward() {',
     'if (o.team != p.team && o.role != Role::GK) {'),

    # Line 303: missing ) before {
    ('if (engine.agentFor(t)->isDefenderRole() {',
     'if (engine.agentFor(t)->isDefenderRole()) {'),

    # Line 320: missing ) before comma
    ('lineX - fd * (isFullBack() ? 6.0 : 15.0, p.homeY',
     'lineX - fd * (isFullBack() ? 6.0 : 15.0), p.homeY'),

    # Line 335: missing ) before {
    ('if (!isFullBack() && !isCenterBack() {',
     'if (!isFullBack() && !isCenterBack()) {'),

    # Line 342: missing ) before comma
    ('p.homeX - fd * (isFullBack() ? 4.0 : 30.0, 40.0',
     'p.homeX - fd * (isFullBack() ? 4.0 : 30.0), 40.0'),

    # Line 362: missing ) in ternary
    ('(cn.pur == ActionPurpose::RunAhead && isWideMidfielder() ? 0.14 :',
     '(cn.pur == ActionPurpose::RunAhead && isWideMidfielder()) ? 0.14 :'),
]

applied = 0
for old, new in fixes:
    if old in content:
        content = content.replace(old, new)
        applied += 1
        print(f'Fixed: {old[:50]}...')
    else:
        print(f'WARNING: not found: {old[:50]}...')

with open('native/agent_positioning.cpp', 'w', encoding='utf-8') as f:
    f.write(content)

print(f'\n{applied}/{len(fixes)} fixes applied')
