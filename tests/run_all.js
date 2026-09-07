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
    window.__exports = {
      formations, fronts, plays, calls, outcomes, categoryMatrix, formationHasBack,
      motionManIndex, motionFinalPosFor, resolveMotionCollision, commitMotionChoice,
      offensePoints, defensePoints, losY, routeEndpointsFor, resolvePlay, freshGame,
      aiPickPlay, applyMotionToPlay: typeof applyMotionToPlay!=='undefined'?applyMotionToPlay:null,
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
  assert(Object.keys(plays).length >= 12, 'at least 12 offensive plays defined', Object.keys(plays).length);
  assert(Object.keys(calls).length >= 11, 'at least 11 defensive calls defined', Object.keys(calls).length);

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

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);

})();
