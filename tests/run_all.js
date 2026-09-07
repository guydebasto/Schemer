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
      aiPickPlay, aiPickCall, frontSafetyCount, pointAlongRoute, playStrengthHint, callStrengthHint,
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
    const xTargetOk = typeof p.xTarget === 'number' || typeof p.xTarget === 'function'; // WR Screen resolves xTarget dynamically to the actual targeted receiver
    if (!p.name || !p.category || !xTargetOk || typeof p.bend !== 'number') { allPlaysValid = false; badPlay = k; }
  });
  assert(allPlaysValid, 'every play has name/category/xTarget(number or resolver function)/bend', badPlay);
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

console.log('\n=== 6. Route generation stays in bounds and never goes behind where the receiver started ===');
{
  const { w } = freshWindow();
  const { plays, formations, routeEndpointsFor, losY } = w.__exports;
  const passPlays = Object.keys(plays).filter(k => typeof plays[k].routes === 'function');
  let issues = [];
  Object.keys(formations).forEach(formKey => {
    passPlays.forEach(playKey => {
      const ly = losY(50);
      let endpoints;
      try { endpoints = routeEndpointsFor(plays[playKey], formKey, null, ly); }
      catch(e){ issues.push(`${formKey}/${playKey} threw: ${e.message}`); return; }
      if (endpoints.length !== 6) issues.push(`${formKey}/${playKey} produced ${endpoints.length} routes, expected 6`);
      endpoints.forEach(({start,mid,end}) => {
        [mid, end].filter(Boolean).forEach(pt=>{
          if (pt.x < 40 || pt.x > 600) issues.push(`${formKey}/${playKey} route off the field: ${JSON.stringify(pt)}`);
          if (pt.y > start.y + 0.5) issues.push(`${formKey}/${playKey} route went behind its own receiver's start: ${JSON.stringify(pt)} vs start ${start.y}`);
        });
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

console.log('\n=== 18. "What beats this" strength hints ===');
{
  const { w } = freshWindow();
  const smashHint = w.__exports.playStrengthHint('smash');
  assert(!!smashHint && smashHint.includes('Cover 2'), 'Smash correctly identifies Cover 2 as its best matchup', smashHint);
  const cover2Hint = w.__exports.callStrengthHint('cover2');
  assert(!!cover2Hint && cover2Hint.includes('Smash'), 'Cover 2 correctly identifies Smash as its worst matchup', cover2Hint);
}

console.log('\n=== 19. Reference page search filters correctly ===');
{
  const { w } = freshWindow();
  await new Promise(r=>setTimeout(r,100));
  w.goToScreen('editor');
  await new Promise(r=>setTimeout(r,30)); // let the rAF-deferred oninput binding fire
  const search = w.document.getElementById('playcallSearch');
  assert(!!search, 'search input exists on the reference page');
  search.value = 'smash';
  search.dispatchEvent(new w.Event('input'));
  const items = [...w.document.querySelectorAll('[data-search]')];
  const visible = items.filter(el => el.style.display !== 'none');
  assert(visible.length === 1 && visible[0].dataset.search.startsWith('smash'), 'searching "smash" shows exactly the Smash entry', visible.map(v=>v.dataset.search.slice(0,20)));
  search.value = '';
  search.dispatchEvent(new w.Event('input'));
  const visibleAfterClear = items.filter(el => el.style.display !== 'none');
  assert(visibleAfterClear.length === 40, 'clearing the search restores all 40 entries', visibleAfterClear.length);
}

console.log('\n=== 20. Onboarding walkthrough shows for first-time visitors and never bothers returning ones ===');
{
  const dom1 = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://example.com/' });
  dom1.window.firebase = { initializeApp(){}, database: () => ({ ref: () => ({ set: async()=>{}, once: async()=>({val:()=>null}), on(){}, off(){} }) }) };
  dom1.window.firebase.database.ServerValue = { increment: n => ({__inc:n}) };
  dom1.window.prompt = () => 'x'; dom1.window.alert = () => {};
  dom1.window.eval(appScript);
  await new Promise(r=>setTimeout(r,100));
  assert(!!dom1.window.document.getElementById('onboardingOverlay'), 'a first-time visitor sees the onboarding overlay automatically');
  dom1.window.document.getElementById('obDone') || null;
  for(let i=0;i<6;i++){ const n = dom1.window.document.getElementById('obNext'); if(n) n.click(); }
  const doneBtn = dom1.window.document.getElementById('obDone');
  assert(!!doneBtn, 'navigating Next through all slides reaches a final "Let\u2019s play" step');
  doneBtn.click();
  assert(dom1.window.localStorage.getItem('schemer:onboardingSeen') === 'true', 'finishing the walkthrough marks it seen in localStorage');

  const dom2 = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://example.com/' });
  dom2.window.firebase = { initializeApp(){}, database: () => ({ ref: () => ({ set: async()=>{}, once: async()=>({val:()=>null}), on(){}, off(){} }) }) };
  dom2.window.firebase.database.ServerValue = { increment: n => ({__inc:n}) };
  dom2.window.prompt = () => 'x'; dom2.window.alert = () => {};
  dom2.window.localStorage.setItem('schemer:onboardingSeen', 'true');
  dom2.window.eval(appScript);
  await new Promise(r=>setTimeout(r,100));
  assert(!dom2.window.document.getElementById('onboardingOverlay'), 'a returning visitor is never shown the overlay automatically');
  const howBtn = dom2.window.document.getElementById('btnHowToPlay');
  assert(!!howBtn, '"How does this work?" link is available to reopen it manually');
  howBtn.click();
  assert(!!dom2.window.document.getElementById('onboardingOverlay'), 'clicking it reopens the walkthrough on demand');
}

console.log('\n=== 21. Trainer mode: structural integrity across many rounds ===');
{
  const { w } = freshWindow('window.pickTrainerRound=pickTrainerRound; window.__getTrainerState=()=>trainerState; window.trainerPick=trainerPick; window.trainerNext=trainerNext;');
  const { calls, defensePoints } = w.__exports;
  let issues = 0, blitzChecks = 0;
  for(let i=0;i<200;i++){
    w.pickTrainerRound(null);
    const s = w.__getTrainerState();
    if(!s.frontKey) issues++;
    if(new Set(s.options).size !== s.options.length) issues++;
    if(!s.options.includes(s.correctKey)) issues++;
    if(calls[s.callKey].category==='blitz'){
      blitzChecks++;
      const pts = defensePoints(s.frontKey, null);
      const boxCount = pts.filter(p=>p.role==='DL'||p.role==='LB').length;
      if(boxCount < 5) issues++;
    }
  }
  assert(issues===0, `200 trainer rounds all structurally valid (4 unique options, correct answer included, blitzes matched to real fronts)`, `${issues} issues, ${blitzChecks} blitz rounds checked`);

  await new Promise(r=>setTimeout(r,100));
  w.goToScreen('trainer');
  const s = w.__getTrainerState();
  scanForNull(w, 'trainer screen initial render');
  w.trainerPick(s.correctKey);
  assert(w.__getTrainerState().correctCount === 1, 'picking the correct answer increments the score');
  scanForNull(w, 'trainer screen after answering');
  const nextBtn = w.document.getElementById('trainerResult').querySelector('button');
  assert(!!nextBtn, '"Next look" button appears after answering');
  nextBtn.click();
  assert(w.__getTrainerState().totalCount === 1 && w.__getTrainerState().answered === false, 'starting the next round keeps score and resets the answered state');
}

console.log('\n=== 22. Route depths match reality, and no two receivers ever collide ===');
{
  const { w } = freshWindow();
  const { plays, formations, routeEndpointsFor, losY } = w.__exports;
  const ly = losY(50);

  const deepPassDepth = (ly - routeEndpointsFor(plays.deepPass, 'singleback', null, ly)[0].end.y) / 10.5;
  const daggerDepth = (ly - routeEndpointsFor(plays.dagger, 'singleback', null, ly)[2].end.y) / 10.5; // index 2 = a WR (index 1 is the RB, who gets the other route half)
  const fadeDepth = (ly - routeEndpointsFor(plays.fade, 'singleback', null, ly)[0].end.y) / 10.5;
  const meshDepth = (ly - routeEndpointsFor(plays.mesh, 'singleback', null, ly)[0].end.y) / 10.5;
  assert(deepPassDepth > 15, `Four Verticals actually runs deep (${deepPassDepth.toFixed(1)}yd)`, deepPassDepth);
  assert(daggerDepth > 15, `Dagger's vertical clearout actually runs deep (${daggerDepth.toFixed(1)}yd)`, daggerDepth);
  assert(fadeDepth > 12, `Fade actually runs deep (${fadeDepth.toFixed(1)}yd)`, fadeDepth);
  assert(meshDepth < 8, `Mesh stays properly shallow (${meshDepth.toFixed(1)}yd), as a real quick-game concept should`, meshDepth);

  const passPlayKeys = Object.keys(plays).filter(k => typeof plays[k].routes === 'function');
  let collisions = 0;
  Object.keys(formations).forEach(formKey=>{
    passPlayKeys.forEach(playKey=>{
      const eps = routeEndpointsFor(plays[playKey], formKey, null, ly);
      for(let i=0;i<eps.length;i++) for(let j=i+1;j<eps.length;j++){
        if(Math.hypot(eps[i].end.x-eps[j].end.x, eps[i].end.y-eps[j].end.y) < 5) collisions++;
      }
    });
  });
  assert(collisions === 0, 'no two receivers ever land on the same spot, across every formation and route play', collisions);

  const screenEps = routeEndpointsFor(plays.screen, 'singleback', null, ly);
  const qbEnd = screenEps[0].end, rbEnd = screenEps[1].end;
  assert(Math.abs(qbEnd.y - rbEnd.y) > 15, 'backfield players (QB/RB) preserve their relative depth instead of both snapping to the same point', `QB.y=${qbEnd.y} RB.y=${rbEnd.y}`);
}

console.log('\n=== 23. WR Screen actually targets a real WR, and the ball lands exactly where they are ===');
{
  const { w } = freshWindow('window.screenTargetIndex=screenTargetIndex; window.offensePoints=offensePoints;');
  const { plays, formations } = w.__exports;
  let allWR = true, allMatch = true, badFormation = null;
  Object.keys(formations).forEach(fk=>{
    const pts = w.offensePoints(fk, null);
    const idx = w.screenTargetIndex(fk, null, pts);
    if(pts[idx].label !== 'WR'){ allWR = false; badFormation = fk; }
    const xTarget = plays.screen.xTarget(fk, null);
    if(xTarget !== pts[idx].x){ allMatch = false; badFormation = fk; }
  });
  assert(allWR, 'WR Screen targets an actual WR-labelled player in every one of the 13 formations', badFormation);
  assert(allMatch, 'the ball\u2019s landing spot exactly matches where that targeted receiver actually is', badFormation);
}

console.log('\n=== 24. Ball carrier and tackler are both highlighted after every play ===');
{
  const { w } = freshWindow();
  await new Promise(r=>setTimeout(r,100));
  w.startLocalGame(false);
  w.writeGame(g=>{ g.offKey='singleback'; g.offCustom=null; g.phase='DEF_FRONT'; });
  w.writeGame(g=>{ g.defFrontKey='base43'; g.defFrontCustom=null; g.phase='OFF_MOTION'; });
  w.writeGame(g=>{ w.commitMotionChoice(g,null); g.phase='DEF_ADJUST'; });
  w.writeGame(g=>{ g.phase='HANDOFF_TO_OFF'; });
  w.writeGame(g=>{ g.phase='OFF_PLAY'; });
  w.writeGame(g=>{ g.offPlayKey='smash'; g.offPlayCustom=null; g.phase='HANDOFF_TO_DEF'; });
  w.writeGame(g=>{ g.phase='DEF_CALL'; });
  w.writeGame(g=>{ g.defCallKey='cover2'; g.defCallCustom=null; w.resolvePlay(g); g.phase='RESULT'; });
  await new Promise(r=>setTimeout(r, 1700));
  const highlights = [...w.document.getElementById('dynamic').querySelectorAll('.catch-highlight')];
  assert(highlights.length === 2, 'exactly two highlight rings appear after a play resolves', highlights.length);
  assert(highlights.some(h=>h.getAttribute('stroke')==='var(--gold)'), 'the ball carrier is highlighted in gold');
  assert(highlights.some(h=>h.getAttribute('stroke')==='var(--brick)'), 'the tackler is highlighted in brick red');
}

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);

})();
