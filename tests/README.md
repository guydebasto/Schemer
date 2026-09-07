# Schemer test suite

`node tests/run_all.js` (or `npm test`) runs a full regression pass against `index.html`
using a real DOM (jsdom), not a mock. Install `jsdom` first: `npm install`.

Each section reproduces a real bug that shipped in an earlier session, so it can't regress
silently behind a plain syntax check:

1. Syntax/structural integrity, no duplicate function declarations
2. Data roster shape (formations, fronts, plays, calls all present and well-formed)
3. No player positioned in front of the line of scrimmage in any formation
4. No overlapping players in any formation or front
5. Motion: collision avoidance, LOS clamp, arc-safety (the bezier curve can't swing in front of the line)
6. Route generation stays in bounds across every formation/play combination
7. Personnel gating (plays needing a back can't be called or AI-picked without one)
8. A pure-logic simulated game runs to completion without throwing
9. A full real-DOM playthrough (local mode, motion, a named play) renders with no literal "null"
10. AI turn-taking never stalls on any phase

Add a new section here whenever a new bug is found and fixed \u2014 the fix isn't done until
there's a test that would have caught it.
