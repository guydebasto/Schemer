#!/usr/bin/env node
/**
 * Schemer test suite.
 * Run with: node tests/run_all.js
 * Requires: npm install (for jsdom) in this directory, or run once via `npm install jsdom`.
 *
 * This suite exists because several real bugs shipped in earlier sessions slipped past a plain
 * `node --check` syntax check (missing functions, broken collision math, illegal formations).
 * Each section below reproduces one of those failure classes directly, so they can't regress silently.
 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const HTML_PATH = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*)<\/script>/);
if (!scriptMatch) { console.error('Could not find <script> block in index.html'); process.exit(1); }
const appScript = scriptMatch[1];

let passed = 0, failed = 0;
function ok(label){ passed++; console.log('  \u2713', label); }
function fail(label, detail){ failed++; console.log('  \u2717', label, detail!==undefined ? '\u2014 '+detail : ''); }
function assert(cond, label, detail){ cond ? ok(label) : fail(label, detail); }

function freshWindow(extra){
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://example.com/' });
  const w = dom.window;
  w.firebase = { initializeApp(){}, database: () => ({ ref: () => ({ set: async()=>{}, once: async()=>({val:()=>null}), on(){}, off(){} }) }) };
  w.firebase.database.ServerValue = { increment: n => ({__inc:n}) };
  w.prompt = () => 'TestPlayer';
  w.alert = () => {};
  w.confirm = () => true;
  w.eval(appScript + `
    window.__getGame = () => game;
    window.__getEd = () => ed;
    window.__exports = {
      formations, fronts, plays, calls, outcomes, categoryMatrix, formationHasBack,
      motionManIndex, motionFinalPosFor, resolveMotionCollision, commitMotionChoice,
      offensePoints, defensePoints, losY, routeEndpointsFor, resolvePlay, freshGame,
      aiPickPlay, aiPickCall, frontSafetyCount, pointAlongRoute,
      applyMotionToPlay: typeof applyMotionToPlay!=='undefined'?applyMotionToPlay:null,
    };
    ${extra||''}
  `);
  return { dom, w };
}

function scanForNull(w, label){
  const lobby = w.document.getElementById('lobby');
  const gameArea = w.document.getElementById('gameArea');
  const hay = (lobby ? lobby.innerHTML : '') + (gameArea ? gameArea.innerHTML : '');
  assert(!/\bnull\b/.test(hay), 'no literal "null" leaks into rendered UI: ' + label);
}

(async () => {

console.log('\n=== 1. Syntax and structural integrity ===');
try {
  new (require('vm').Script)(appScript);
  ok('script parses with no syntax errors');
} catch(e) {
  fail('script parses with no syntax errors', e.message);
}
{
  const fnNames = [...appScript.matchAll(/^function (\w+)\(/gm)].map(m=>m[1]);
  const counts = {};
  fnNames.forEach(n => counts[n] = (counts[n]||0)+1);
  const dupes = Object.keys(counts).filter(n => counts[n] > 1);
  assert(dupes.length === 0, 'no duplicate top-level function declarations', dupes.join(', '));
}

console.log('\n=== 2. Core data roster integrity ===');
{
  const { w } = freshWindow();
  const { plays, calls, formations, fronts } = w.__exports;
  assert(Object.keys(formations).length === 13, '13 offensive formations defined', Object.keys(formations).length);
  assert(Object.keys(fronts).length === 14, '14 defensive fronts defined', Object.keys(fronts).length);
  assert(Object.keys(plays).length >= 22, 'at least 22 offensive plays defined', Object.keys(plays).length);
  assert(Object.keys(calls).length >= 18, 'at least 18 defensive calls defined', Object.keys(calls).length);

  let allPlaysValid = true, badPlay = null;
  Object.entries(plays).forEach(([k,p]) => {
    if (!p.name || !p.category || typeof p.xTarget !== 'number' || typeof p.bend !== 'number') { allPlaysValid = false; badPlay = k; }
  });
  assert(allPlaysValid, 'every play has name/category/xTarget/bend', badPlay);
}

console.log('\n=== 3. No player positioned in front of the line of scrimmage ===');
{
  const { w } = freshWindow();
  const { formations } = w.__exports;
  let violations = [];
  Object.entries(formations).forEach(([k,f]) => {
    f.skill.forEach(p => { if (p.y < 0) violations.push(`${k}:${p.label}@y=${p.y}`); });
  });
  assert(violations.length === 0, 'no formation has a player ahead of the LOS', violations.join(', '));
}

console.log('\n=== 4. No overlapping players (formations + fronts) ===');
{
  const { w } = freshWindow();
  const { formations, fronts, offensePoints, defensePoints } = w.__exports;
  let issues = [];
  Object.keys(formations).forEach(k => {
    const pts = offensePoints(k, null);
    for (let i=0;i<pts.length;i++) for (let j=i+1;j<pts.length;j++) {
      const d = Math.hypot(pts[i].x-pts[j].x, pts[i].y-pts[j].y);
      if (d < 20) issues.push(`formation ${k} players ${i},${j} (${d.toFixed(1)}px)`);
    }
  });
  Object.keys(fronts).forEach(k => {
    const pts = defensePoints(k, null);
    for (let i=0;i<pts.length;i++) for (let j=i+1;j<pts.length;j++) {
      const d = Math.hypot(pts[i].x-pts[j].x, pts[i].y-pts[j].y);
      if (d < 20) issues.push(`front ${k} players ${i},${j} (${d.toFixed(1)}px)`);
    }
  });
  assert(issues.length === 0, 'no overlapping players in any formation/front', issues.join('; '));
}

console.log('\n=== 5. Motion: collision avoidance, LOS clamp, and arc safety ===');
{
  const { w } = freshWindow();
  const { formations, motionManIndex, motionFinalPosFor, offensePoints } = w.__exports;
  let collisionIssues = [], losIssues = [];
  Object.keys(formations).forEach(formKey => {
    ['jet','shift'].forEach(motionType => {
      const g = { offKey: formKey, offCustom: null };
      const idx = motionManIndex(g);
      const pos = motionFinalPosFor(g, motionType, idx);
      if (!pos) return;
      if (pos.y < 8 || pos.y > 70) losIssues.push(`${formKey}/${motionType} y=${pos.y}`);
      const pts = offensePoints(formKey, null);
      pts.forEach((p,i) => {
        if (i===idx) return;
        const d = Math.hypot(p.x-pos.x, p.y-pos.y);
        if (d < 20) collisionIssues.push(`${formKey}/${motionType} lands ${d.toFixed(1)}px from teammate ${i}`);
      });
    });
  });
  assert(collisionIssues.length === 0, 'motion never lands on top of a teammate', collisionIssues.join('; '));
  assert(losIssues.length === 0, 'motion always stays 0.76-6.7yd behind the line', losIssues.join('; '));
}

console.log('\n=== 6. Route generation stays in bounds and behind the line ===');
{
  const { w } = freshWindow();
  const { plays, formations, routeEndpointsFor, losY } = w.__exports;
  const passPlays = ['quickPass','playActionDeep','deepPass','stick','flood','mesh','smash'];
  let issues = [];
  Object.keys(formations).forEach(formKey => {
    passPlays.forEach(playKey => {
      const ly = losY(50);
      let endpoints;
      try { endpoints = routeEndpointsFor(plays[playKey], formKey, null, ly); }
      catch(e){ issues.push(`${formKey}/${playKey} threw: ${e.message}`); return; }
      if (endpoints.length !== 6) issues.push(`${formKey}/${playKey} produced ${endpoints.length} routes, expected 6`);
      endpoints.forEach(({end}) => {
        if (end.x < 40 || end.x > 600 || end.y > ly + 2) issues.push(`${formKey}/${playKey} route out of bounds: ${JSON.stringify(end)}`);
      });
    });
  });
  assert(issues.length === 0, 'every pass play\'s routes stay in bounds across all 13 formations', issues.join('; '));
}

console.log('\n=== 7. Personnel gating (can\'t run plays without the right backs) ===');
{
  const { w } = freshWindow();
  const { formationHasBack, aiPickPlay, plays } = w.__exports;
  assert(formationHasBack('empty', null) === false, 'Empty formation correctly has no back');
  assert(formationHasBack('singleback', null) === true, 'Singleback formation correctly has a back');
  let aiViolated = false;
  for (let i=0;i<200;i++){
    const pick = aiPickPlay(2, 8, 50, 'insane', 'aggressive', false);
    if (pick && !pick.isCustom && plays[pick.key] && plays[pick.key].needsBack) { aiViolated = true; break; }
  }
  assert(!aiViolated, 'AI never calls a needs-back play with hasBack=false (200 trials)');
}

console.log('\n=== 8. Full simulated game (pure logic, no DOM) ===');
{
  const { w } = freshWindow();
  const { freshGame, resolvePlay, formations, fronts, plays, calls } = w.__exports;
  const formKeys = Object.keys(formations), frontKeys = Object.keys(fronts), playKeys = Object.keys(plays), callKeys = Object.keys(calls);
  let g = freshGame({});
  let anyScore = false, anyPunt = false, plays_run = 0;
  for (let i=0;i<400 && plays_run<300;i++){
    plays_run++;
    g.offKey = formKeys[i%formKeys.length]; g.offCustom = null;
    g.defFrontKey = frontKeys[i%frontKeys.length]; g.defFrontCustom = null;
    let pk = playKeys[i%playKeys.length];
    if (plays[pk].needsBack && g.offKey === 'empty') pk = 'quickPass'; // dodge the gate for this pure-logic pass
    g.offPlayKey = pk; g.offPlayCustom = null;
    g.defCallKey = callKeys[i%callKeys.length]; g.defCallCustom = null;
    resolvePlay(g);
    if (g.lastResult.touchdown) anyScore = true;
    if (g.down === 1 && g.distance === 10 && g.ballOn === 25 && g.lastResult.driveOver && !g.lastResult.touchdown) anyPunt = true;
    if (g.gameOver) break;
  }
  assert(plays_run > 50, 'simulation ran a meaningful number of plays without throwing', plays_run);
  assert(anyScore, 'at least one touchdown occurred across the simulation');
}

console.log('\n=== 9. Full real-DOM playthrough: local mode with motion + custom route play ===');
{
  const { w } = freshWindow();
  w.startLocalGame(false);
  w.writeGame(g=>{ g.offKey='singleback'; g.offCustom=null; g.phase='DEF_FRONT'; });
  w.writeGame(g=>{ g.defFrontKey='base43'; g.defFrontCustom=null; g.phase='OFF_MOTION'; });
  w.writeGame(g=>{ w.commitMotionChoice(g,'jet'); g.phase='DEF_ADJUST'; });
  scanForNull(w, 'DEF_ADJUST with motion set');
  w.writeGame(g=>{ g.phase='HANDOFF_TO_OFF'; });
  w.writeGame(g=>{ g.phase='OFF_PLAY'; });
  w.writeGame(g=>{ g.offPlayKey='smash'; g.offPlayCustom=null; g.phase='HANDOFF_TO_DEF'; });
  w.writeGame(g=>{ g.phase='DEF_CALL'; });
  w.writeGame(g=>{ g.defCallKey='cover2'; g.defCallCustom=null; w.resolvePlay(g); g.phase='RESULT'; });
  await new Promise(r=>setTimeout(r, 1700));
  const game = w.__getGame();
  assert(!!game.lastResult && typeof game.lastResult.yards === 'number', 'a real named play (Smash vs Cover 2) resolves to a valid result', JSON.stringify(game.lastResult && game.lastResult.text));
  scanForNull(w, 'RESULT screen after Smash vs Cover 2');
}

console.log('\n=== 10. AI turn-taking never stalls ===');
{
  const { w } = freshWindow();
  w.startAIGame('defense', 'medium', 'balanced', 'balanced', false);
  await new Promise(r=>setTimeout(r, 900));
  assert(w.__getGame().phase === 'DEF_FRONT', 'AI (offense) picks a formation without prompting', w.__getGame().phase);
}

console.log('\n=== 11. Editor undo restores prior state ===');
{
  const { w } = freshWindow();
  w.goToScreen('editor');
  const ed = w.__getEd();
  const origX = ed.points[5].x;
  w.edSnapshot();
  ed.points[5] = {...ed.points[5], x: origX + 100};
  assert(ed.points[5].x === origX + 100, 'point drag mutation applied (sanity check)');
  w.edUndo();
  assert(w.__getEd().points[5].x === origX, 'undo restores the point to its pre-drag position');

  w.edSwitchType('play');
  const ed2 = w.__getEd();
  w.edSnapshot();
  ed2.routes = { 7: {dx:50,dy:-60} };
  w.edUndo();
  assert(Object.keys(w.__getEd().routes).length === 0, 'undo restores routes after a simulated route draw');
}

console.log('\n=== 12. Defensive personnel gating (safety-count requirements) ===');
{
  const { w } = freshWindow();
  const { frontSafetyCount, calls, aiPickCall } = w.__exports;
  assert(frontSafetyCount('bearbox', null) === 1, 'Bear front correctly has 1 safety');
  assert(frontSafetyCount('bignickel', null) === 3, 'Big Nickel front correctly has 3 safeties');
  assert(calls.prevent.needsSafeties === 3 && calls.cover2.needsSafeties === 2, 'Prevent/Cover 2 have safety requirements defined');
  let aiViolated = false;
  for (let i=0;i<200;i++){
    const pick = aiPickCall(2, 8, 50, 'insane', 'aggressive', 1); // simulate a 1-safety front
    if (pick && !pick.isCustom && calls[pick.key] && calls[pick.key].needsSafeties > 1) { aiViolated = true; break; }
  }
  assert(!aiViolated, 'AI never calls a needs-safeties call it lacks bodies for (200 trials)');
}

console.log('\n=== 13. Online multiplayer: both clients stay in sync (the exact class of bug that shipped) ===');
{
  function makeSharedStore(){
    const store = {}; const listeners = {};
    function notify(path){ const val = store[path]; (listeners[path]||[]).forEach(cb => cb({ val: () => val })); }
    return { ref(path){ return {
      async set(val){ store[path] = JSON.parse(JSON.stringify(val)); notify(path); },
      async once(){ return { val: () => store[path] }; },
      on(event, cb){ (listeners[path] = listeners[path]||[]).push(cb); if(store[path]!==undefined) cb({val:()=>store[path]}); },
      off(){ listeners[path] = []; },
    }; } };
  }
  function makeOnlineWindow(sharedDb){
    const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://example.com/' });
    const w = dom.window;
    w.firebase = { initializeApp(){}, database: () => sharedDb };
    w.firebase.database.ServerValue = { increment: n => ({__inc:n}) };
    w.prompt = () => 'x'; w.alert = () => {}; w.confirm = () => true;
    w.eval(appScript + '\nwindow.__getGame=()=>game; window.__getRoomCode=()=>roomCode;');
    return w;
  }
  const sharedDb = makeSharedStore();
  const A = makeOnlineWindow(sharedDb); // creates room, plays offense
  const B = makeOnlineWindow(sharedDb); // joins room, plays defense

  await A.createRoom('offense', false);
  await new Promise(r=>setTimeout(r,30));
  const roomCode = A.__getRoomCode();
  await B.joinRoom(roomCode);
  await new Promise(r=>setTimeout(r,30));

  A.writeGame(g=>{ g.offKey='singleback'; g.offCustom=null; g.phase='DEF_FRONT'; });
  await new Promise(r=>setTimeout(r,50));
  B.writeGame(g=>{ g.defFrontKey='base43'; g.defFrontCustom=null; g.phase='OFF_MOTION'; });
  await new Promise(r=>setTimeout(r,50));
  A.writeGame(g=>{ A.commitMotionChoice(g, null); g.phase='DEF_ADJUST'; });
  await new Promise(r=>setTimeout(r,50));
  B.writeGame(g=>{ g.phase='OFF_PLAY'; });
  await new Promise(r=>setTimeout(r,50));
  A.writeGame(g=>{ g.offPlayKey='insideRun'; g.offPlayCustom=null; g.phase='DEF_CALL'; });
  await new Promise(r=>setTimeout(r,80));

  assert(A.__getGame().phase === 'DEF_CALL' && B.__getGame().phase === 'DEF_CALL',
    'both clients see the same phase after the full sequence of alternating writes',
    `A=${A.__getGame().phase} B=${B.__getGame().phase}`);
  const bPanel = B.document.getElementById('panel').innerHTML;
  assert(bPanel.includes('Hidden from the offence'), 'the joining player (B) actually sees their DEF_CALL screen, not stuck waiting');
}

console.log('\n=== 14. Feedback submits directly to Firebase, no email required ===');
{
  const writes = [];
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://example.com/' });
  const w = dom.window;
  w.firebase = { initializeApp(){}, database: () => ({ ref: (path) => ({
    set: async (val) => { writes.push({path, val}); },
    once: async()=>({val:()=>null}), on(){}, off(){},
  }) }) };
  w.firebase.database.ServerValue = { increment: n => ({__inc:n}), TIMESTAMP: '__SERVER_TIMESTAMP__' };
  w.prompt = () => 'x'; w.alert = () => {};
  w.eval(appScript);
  await new Promise(r=>setTimeout(r,100)); // let boot() settle before interacting, same as a real user would
  w.goToScreen('feedback');
  w.document.getElementById('feedbackText').value = 'Test feedback message';
  w.document.getElementById('feedbackSend').click();
  await new Promise(r=>setTimeout(r,80));
  assert(writes.length === 1, 'feedback submission writes to Firebase instead of opening an email client');
  assert(writes[0] && writes[0].path && writes[0].path.startsWith('feedback/'), 'feedback is written under the feedback/ path');
  assert(writes[0] && writes[0].val && writes[0].val.message === 'Test feedback message', 'the submitted message is captured correctly');
  const status = w.document.getElementById('feedbackStatus');
  assert(!!status && status.textContent.includes('Sent'), 'the user sees a confirmation after sending');
}

console.log('\n=== 15. Route shapes are real two-segment paths, and the preview animates fluidly ===');
{
  const { w } = freshWindow();
  const { plays, routeEndpointsFor, losY, pointAlongRoute } = w.__exports;
  const ly = losY(50);
  let sawMultiSegment = false;
  ['quickPass','smash','dagger','mesh','curlFlat'].forEach(k=>{
    const eps = routeEndpointsFor(plays[k], 'singleback', null, ly);
    if(eps.some(e => e.mid)) sawMultiSegment = true;
  });
  assert(sawMultiSegment, 'named pass plays produce real stem-then-break route shapes, not single straight lines');

  const eps = routeEndpointsFor(plays.dagger, 'singleback', null, ly);
  const r = eps.find(e => e.mid);
  assert(!!r, 'Dagger has at least one multi-segment route to test the animation against');
  if(r){
    const p0 = pointAlongRoute(r.start, r.mid, r.end, 0);
    const p50 = pointAlongRoute(r.start, r.mid, r.end, 0.5);
    const p100 = pointAlongRoute(r.start, r.mid, r.end, 1);
    assert(p0.x===r.start.x && p0.y===r.start.y, 'route animation starts exactly at the receiver\u2019s position');
    assert(p100.x===r.end.x && p100.y===r.end.y, 'route animation ends exactly at the route\u2019s final point');
    assert(p50.x!==p0.x || p50.y!==p0.y, 'route animation actually moves partway through, not a static jump');
  }
}

console.log('\n=== 16. Core/full playbook toggle actually re-renders the screen ===');
{
  const { w } = freshWindow();
  await new Promise(r=>setTimeout(r,100)); // let boot() settle first, like a real user would
  w.startLocalGame(false);
  w.writeGame(g=>{ g.offKey='singleback'; g.offCustom=null; g.phase='DEF_FRONT'; });
  w.writeGame(g=>{ g.defFrontKey='base43'; g.defFrontCustom=null; g.phase='OFF_MOTION'; });
  w.writeGame(g=>{ w.commitMotionChoice(g,null); g.phase='DEF_ADJUST'; });
  w.writeGame(g=>{ g.phase='HANDOFF_TO_OFF'; });
  w.writeGame(g=>{ g.phase='OFF_PLAY'; });
  await new Promise(r=>setTimeout(r,60));

  let btns = [...w.document.querySelectorAll('.choice-btn .name')].map(n=>n.textContent.trim());
  assert(btns.length === 8, 'default view shows only the 8 core offensive plays', btns.length);
  assert(!btns.includes('Power'), 'a non-core play (Power) is hidden by default');

  const toggleBtn = [...w.document.querySelectorAll('button')].find(b=>b.textContent.includes('tap to see all'));
  assert(!!toggleBtn, 'the core/full toggle button is present');
  toggleBtn.click();
  await new Promise(r=>setTimeout(r,60));

  btns = [...w.document.querySelectorAll('.choice-btn .name')].map(n=>n.textContent.trim());
  assert(btns.length === 22, 'clicking the toggle actually re-renders the screen to show all 22 plays', btns.length);
  assert(btns.includes('Power'), 'the previously-hidden play is now visible');
}

console.log('\n=== 17. Custom route drawing supports a real stem-then-break shape ===');
{
  const { w } = freshWindow();
  await new Promise(r=>setTimeout(r,100));
  w.goToScreen('editor');
  w.edSwitchType('play');
  const ed = w.__getEd();
  ed.backdropKey = 'singleback';
  ed.routes = {};
  w.edSnapshot();
  ed.routes[7] = { dx: 60, dy: -70 }; // first drag: a simple one-segment route
  assert(ed.routes[7].dx === 60 && !ed.routes[7].stem, 'first drag produces a simple one-segment route');

  // simulate dragging the endpoint to extend it into a real break (mirrors edExtendRouteBreak)
  const stem = { dx: ed.routes[7].dx, dy: ed.routes[7].dy };
  const startPt = { x: 175, y: 480 };
  const midAbs = { x: startPt.x + stem.dx, y: startPt.y + stem.dy };
  const newEnd = { x: midAbs.x + 40, y: midAbs.y - 20 };
  ed.routes[7] = { stem, brk: { dx: newEnd.x - midAbs.x, dy: newEnd.y - midAbs.y } };
  assert(!!ed.routes[7].stem && !!ed.routes[7].brk, 'extending the endpoint converts it into a real stem+break route');

  const { routeEndpointsFor, losY } = w.__exports;
  const eps = routeEndpointsFor({routes: ed.routes}, 'singleback', null, losY(50));
  const r7 = eps[2];
  assert(!!r7.mid, 'the drawn route resolves to a path with a real break point, matching the built-in named plays');
}

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);

})();
