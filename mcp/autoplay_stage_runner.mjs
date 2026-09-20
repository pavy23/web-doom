// Autonomous single-player stage-clear runner.
//
// Layer 1 of the autoplay stack: deterministic code plans a route from the
// Player 1 start to the map exit (P1.3 navigation graph), follows it with the
// exact-tic browser controller, presses the exit switch and confirms that
// LinuxDOOM left GS_LEVEL. No AI is involved by default. A `decide` hook lets a
// tactical policy (for example a TypeSafe System One judgment layer) override
// individual steps without changing the planning or verification code.
//
// CLI:
//   node autoplay_stage_runner.mjs --map E1M1 --runs 3 [--no-god] [--max-edge-tics 280]
//                                  [--policy jev] [--jev-dry-run] [--jev-max-calls 600]
//                                  [--report-dir DIR] [--baseline other/report.json]
//                                  [--skill 1-5|uv|nightmare] [--headed] [--no-overlay]
//                                  [--max-combat-tics 600]   (fight/retreat steps per edge, separate from --max-edge-tics)
//                                  [--record] [--record-every tic|step] [--record-quality 80] [--record-bitrate 1000k]
//
// --record writes <reportDir>/run-N.webm: one frame per world tic at 35 fps
// (game time, never wall-clock), captured as page screenshots so the overlay
// is in the picture. Recording drives the engine tic by tic; the simulation
// stays identical to an unrecorded run (see setTicHook in the browser agent).
//
// Every step is appended to <reportDir>/steps.jsonl and a summary is written to
// <reportDir>/report.json so later policy layers can be compared tic-for-tic.
// Runs are ranked by the objective in autoplay_objective.mjs (deaths, then
// damage taken, then world tics); --baseline adds the deltas against another
// trial's best run, typically the deterministic follower on the same map.

import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { GeometryWorkspace, parseWad, writeWad } from './geometry.js';
import { EpisodeWorkspace } from './episode_workspace.js';
import { installFullTopologyValidator } from './topology_validator.js';
import { installThingAuthoring } from './thing_authoring.js';
import { installSemanticGeometry } from './semantic_geometry.js';
import { buildNavigationGraph, findExitProgression, locatePointSector, planLocalPath } from './navigation_graph.js';
import {
  coldBoot, exactInput, isCombatCommand, launchChromium, liveSectorFloor, liveSectorOpening, navigateEdge, remainingPathDistance, setTicHook
} from './navigation_browser_agent.mjs';
import { OBJECTIVE_ORDER, OBJECTIVE_VERSION, compareToBaseline, rankRuns, runMetrics } from './autoplay_objective.mjs';
import { installOverlay, updateOverlay } from './autoplay_overlay.mjs';
import { loadMapItems } from './autoplay_items.mjs';
import { createRecorder, findFfmpeg } from './autoplay_recorder.mjs';

// LinuxDOOM skill_t: 0 ITYTD, 1 HNTR, 2 HMP, 3 UV, 4 Nightmare. The CLI takes
// the vanilla 1-5 number or a name; the engine receives "-skill <1-5>".
export const SKILL_NAMES = ['itytd', 'hntr', 'hmp', 'uv', 'nightmare'];
export function parseSkill(value) {
  if (value == null || value === '') return null;
  const text = String(value).trim().toLowerCase();
  const byName = SKILL_NAMES.indexOf(text);
  if (byName >= 0) return byName;
  const number = Number(text);
  if (Number.isInteger(number) && number >= 1 && number <= 5) return number - 1;
  throw new Error(`Unknown skill ${value}: use 1-5 or ${SKILL_NAMES.join('/')}`);
}

export const AUTOPLAY_VERSION = '0.3.0-autoplay';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_IWAD = path.join(here, '..', 'doom1.wad');
const DEFAULT_EXPORT_DIR = path.join(here, 'exports');
const GS_LEVEL = 0;
const GS_INTERMISSION = 1;
// Every trial starts its control loop at this level tic. warpAndPause freezes
// the world within one frame of the level becoming playable, which still
// leaves a 0-2 tic race; stepping up to a fixed reference tic removes it.
const START_LEVEL_TIC = 3;

let authoringInstalled = false;
function ensureAuthoring() {
  if (authoringInstalled) return;
  installFullTopologyValidator(GeometryWorkspace);
  installThingAuthoring(GeometryWorkspace);
  installSemanticGeometry(GeometryWorkspace);
  authoringInstalled = true;
}

function headingDegrees(from, to) {
  let angle = Math.atan2(Number(to.y) - Number(from.y), Number(to.x) - Number(from.x)) * 180 / Math.PI;
  if (angle < 0) angle += 360;
  return angle;
}
function angleDelta(current, desired) {
  let delta = Number(desired) - Number(current);
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;
  return delta;
}
function distance(a, b) { return Math.hypot(Number(b.x) - Number(a.x), Number(b.y) - Number(a.y)); }

// Extract the requested IWAD map as a rebuilt single-map PWAD. The browser
// cold-boot path only accepts PWAD candidates, so the original level is passed
// through the same pinned node-builder pipeline the authoring tools use.
// A 1x1 fully transparent patch (one column, no posts). Placed in the stage
// PWAD under the name M_PAUSE it replaces the IWAD's "Pause" banner, which
// D_Display draws whenever the world is paused: every captured frame of a
// recording is taken in that state, so without this the video would carry the
// banner throughout. Rendering only; the simulation never reads the lump.
export function transparentPatchLump(name = 'M_PAUSE') {
  const data = Buffer.alloc(13);
  data.writeInt16LE(1, 0);   // width
  data.writeInt16LE(1, 2);   // height
  data.writeInt16LE(0, 4);   // leftoffset
  data.writeInt16LE(0, 6);   // topoffset
  data.writeUInt32LE(12, 8); // columnofs[0]
  data[12] = 0xff;           // column terminator: no posts
  return { name, data };
}

export async function prepareStagePwad({ iwadPath = DEFAULT_IWAD, map = 'E1M1', exportDir = DEFAULT_EXPORT_DIR, hidePauseGraphic = false } = {}) {
  ensureAuthoring();
  const source = await readFile(iwadPath);
  const episode = new EpisodeWorkspace(source, [map], path.basename(iwadPath));
  const workspace = episode.workspaces.get(map);
  const graph = buildNavigationGraph(workspace);
  const start = graph.things.starts.find(item => item.doomEdNum === 1 && item.sector != null);
  if (!start) throw new Error(`${map} has no Player 1 start mapped to a sector`);
  // The normal exit is the stage clear; a secret exit (E1M3 -> E1M9) only
  // when no route to the normal one is known.
  let progression = findExitProgression(graph, start.sector, { includeSecret: false });
  if (!progression.found) progression = findExitProgression(graph, start.sector);
  if (!progression.found) throw new Error(`${map}: ${progression.reason}`);

  const filename = `autoplay-${map.toLowerCase()}.wad`;
  const candidate = await episode.build({ filename });
  await mkdir(exportDir, { recursive: true });
  const wadPath = path.join(exportDir, candidate.filename);
  let bytes = candidate.bytes;
  if (hidePauseGraphic) {
    const doc = parseWad(bytes);
    doc.lumps.push(transparentPatchLump('M_PAUSE'));
    bytes = writeWad(doc, 'PWAD');
  }
  await writeFile(wadPath, bytes);
  return { map, filename: candidate.filename, wadPath, graph, start, progression, workspace, hidePauseGraphic: Boolean(hidePauseGraphic) };
}

async function engineState(page) { return page.evaluate(() => window.DoomControl.getState()); }
async function telemetry(page) { return page.evaluate(() => window.DoomControl.getPlaytestTelemetry()); }

// Level completion is observable without a dedicated engine flag: once the
// exit special fires, G_Ticker moves gamestate out of GS_LEVEL and the state
// JSON reports ready=false with the raw gamestate value.
export async function waitForLevelExit(page, timeout = 6000) {
  await page.waitForFunction(level => {
    try {
      const state = window.DoomControl.getState();
      return state && state.ready === false && Number(state.gameState) !== level;
    } catch { return false; }
  }, GS_LEVEL, { timeout });
  return engineState(page);
}

// Walk from the final route sector to the exit line and press it. The exit
// switch (special 11 / 51) needs USE while facing the line; walk-over exits
// (52 / 124) only need the crossing.
export async function approachAndUseExit(page, exit, options = {}) {
  const maxTics = Number(options.maxTics || 350);
  const maxCombatTics = Number(options.maxCombatTicsPerEdge ?? 600);
  let routeTics = 0;
  let combatTics = 0;
  let bestDistance = Infinity;   // progress-based budget, as in navigateEdge
  let ticsSinceProgress = 0;
  const finalTarget = exit.midpoint;
  let waypoints = null;
  const trace = [];
  let usedTics = 0;
  let lastDistance = Infinity;
  let stalled = 0;
  let recoverySide = 1;

  while (ticsSinceProgress < maxTics && combatTics < maxCombatTics) {
    const state = await engineState(page);
    if (state?.ready === false && Number(state.gameState) !== GS_LEVEL) {
      return { passed: true, usedTics, trace, finalState: state };
    }
    if (!state?.ready || !state.player) throw new Error('Exit approach lost player state');
    if (Number(state.player.health || 0) <= 0) return { passed: false, usedTics, trace, failure: 'player_dead', finalState: state };

    const position = { x: Number(state.player.x), y: Number(state.player.y) };
    // Local routing around walls, as in navigateEdge, when a graph is given.
    if (options.graph && (waypoints == null || stalled >= 7)) {
      waypoints = planLocalPath(options.graph, Number(state.currentSector), position, exit.midpoint, { ignoreLines: exit.line != null ? [exit.line] : [] });
    }
    while (waypoints && waypoints.length && distance(position, waypoints[0]) < 24) waypoints.shift();
    const target = waypoints && waypoints.length ? waypoints[0] : finalTarget;
    const targetDistance = distance(position, target);
    const desired = headingDegrees(position, target);
    const delta = angleDelta(Number(state.player.angle), desired);
    let command;

    if (targetDistance >= lastDistance - 0.75) stalled++;
    else stalled = Math.max(0, stalled - 1);
    lastDistance = targetDistance;

    if (stalled >= 7) {
      command = { forward: 0.25, strafe: 0.55 * recoverySide, turn: -0.18 * recoverySide, use: exit.trigger === 'use', tics: 3 };
      recoverySide *= -1;
      stalled = 0;
    } else if (Math.abs(delta) > 8) {
      const magnitude = Math.min(0.7, Math.max(0.16, Math.abs(delta) / 90 * 0.55));
      command = { turn: delta > 0 ? -magnitude : magnitude, use: false, tics: Math.abs(delta) > 50 ? 3 : 2 };
    } else if (targetDistance < 40) {
      // Vanilla USE reach is 64 units; keep pushing gently into the line while
      // holding USE so switch and walk-over exits both trigger.
      command = { forward: 0.35, turn: 0, use: exit.trigger === 'use', tics: 3 };
    } else {
      command = { forward: 0.62, turn: delta > 3 ? -0.08 : delta < -3 ? 0.08 : 0, use: false, tics: 4 };
    }

    if (typeof options.decide === 'function') {
      const override = await options.decide({ state, edge: null, exit, proposal: command, targetDistance, delta, usedTics });
      if (override) command = override;
    }

    let result;
    try {
      result = await exactInput(page, command);
    } catch (error) {
      // queueAgentInput rejects with -1 once gamestate leaves GS_LEVEL. That is
      // the success path when USE fired on the previous step.
      const state = await engineState(page).catch(() => null);
      if (state?.ready === false && Number(state.gameState) !== GS_LEVEL) {
        return { passed: true, usedTics, trace, finalState: state };
      }
      throw error;
    }
    usedTics += result.tics;
    if (isCombatCommand(command)) combatTics += result.tics; else routeTics += result.tics;
    const remaining = remainingPathDistance(position, waypoints, finalTarget);
    if (remaining < bestDistance - 4) { bestDistance = remaining; ticsSinceProgress = 0; }
    else if (!isCombatCommand(command)) ticsSinceProgress += result.tics;
    if (typeof options.onStep === 'function') {
      await options.onStep({ edge: null, exit, state, command, result, usedTics, routeTics, combatTics, ticsSinceProgress, targetDistance, delta });
    }
    if (trace.length < 80) trace.push({ tics: usedTics, x: position.x, y: position.y, targetDistance, delta, command });

    if (command.use || exit.trigger === 'walk') {
      if (typeof options.success === 'function') {
        // Generic line activation (a tagged switch): the caller decides
        // what "it worked" means, for example the door sector opening.
        if (await options.success()) return { passed: true, usedTics, routeTics, combatTics, trace, finalState: await engineState(page) };
      } else {
        try {
          const after = await waitForLevelExit(page, 1500);
          return { passed: true, usedTics, trace, finalState: after };
        } catch { /* not yet; keep approaching */ }
      }
    }
  }
  const finalState = await engineState(page);
  const label = options.failureLabel || 'exit';
  return { passed: false, usedTics, routeTics, combatTics, trace, failure: combatTics >= maxCombatTics ? `${label}_combat_budget_exhausted` : `${label}_no_progress`, finalState };
}

// Fire a tagged trigger edge of the progression: walk to the switch (or the
// walk-over line), use it, and wait for the door sector it opens to have
// room for the player. Vanilla doors rise 2 units per tic, so a 128-unit
// door needs ~64 tics after the switch; idle exact-tic steps cover that.
export async function activateTrigger(page, edge, options = {}) {
  const doorSector = edge.doorSectors?.[0];
  // Floor movers: wait until every affected sector's floor reached the
  // height the graph predicted (stairs at 0.25 units/tic can take ~9 s for
  // the top step, hence the long idle budget). The gate is the first
  // sector that moved at all, so an unfired trigger keeps the approach going.
  const floors = edge.floors ? Object.entries(edge.floors).map(([sector, floor]) => [Number(sector), Number(floor)]) : [];
  const startFloors = new Map();
  if (floors.length) for (const [sector] of floors) startFloors.set(sector, await liveSectorFloor(page, sector));
  const floorsDone = async () => {
    for (const [sector, target] of floors) {
      const floor = await liveSectorFloor(page, sector);
      if (floor == null || Math.abs(floor - target) > 2) return false;
    }
    return true;
  };
  const success = async () => {
    if (floors.length) {
      let moved = false;
      for (const [sector] of floors) {
        const floor = await liveSectorFloor(page, sector);
        if (floor != null && startFloors.get(sector) != null && Math.abs(floor - startFloors.get(sector)) >= 1) { moved = true; break; }
      }
      if (!moved) return false;
      for (let i = 0; i < 120 && !(await floorsDone()); i++) await exactInput(page, { tics: 4 });
      return floorsDone();
    }
    if (doorSector == null) return true;
    let opening = await liveSectorOpening(page, doorSector);
    if (opening == null || opening < 8) return false; // not started opening yet
    for (let i = 0; i < 30 && opening < PLAYER_HEIGHT_UNITS; i++) {
      await exactInput(page, { tics: 4 });
      opening = await liveSectorOpening(page, doorSector);
    }
    return opening >= PLAYER_HEIGHT_UNITS;
  };
  return approachAndUseExit(page, { midpoint: edge.midpoint, trigger: edge.action }, { ...options, success, failureLabel: 'trigger', maxTics: options.maxTicsPerEdge });
}
const PLAYER_HEIGHT_UNITS = 56;

// Walk over a key thing. The engine state does not report keycards, so
// arrival within pickup reach is the success condition (pickup radius is
// the player's 16-unit radius plus the item's; 28 units is inside it).
export async function collectKey(page, key, options = {}) {
  const target = { x: Number(key.x), y: Number(key.y) };
  const success = async () => {
    const state = await engineState(page);
    return distance({ x: Number(state.player.x), y: Number(state.player.y) }, target) < 28;
  };
  return approachAndUseExit(page, { midpoint: target, trigger: 'walk' }, { ...options, success, failureLabel: 'key', maxTics: options.maxTics || 350 });
}

// One full stage attempt on an already-open page.
export async function runStageAttempt(page, stage, options = {}) {
  const config = { maxTicsPerEdge: 280, godMode: true, ...options };
  const { graph, progression } = stage;
  const attempt = {
    version: AUTOPLAY_VERSION,
    map: stage.map,
    godMode: Boolean(config.godMode),
    startedAt: new Date().toISOString(),
    passed: false,
    plannedSectors: progression.sectors,
    exit: progression.exit,
    edgeResults: [],
    steps: 0,
    totalTics: 0
  };
  const stepLog = config.stepLog;
  let stepIndex = 0;
  let lastTelemetry = null;
  const onStep = async (event) => {
    stepIndex++;
    attempt.steps = stepIndex;
    if (event.result?.telemetry?.ready) lastTelemetry = event.result.telemetry;
    const player = event.result.state?.player || {};
    if (config.overlay !== false) {
      await updateOverlay(page, { step: {
        tic: event.result.telemetry?.worldTics ?? null, health: player.health, armor: player.armor,
        sector: event.result.state?.currentSector ?? null, edge: event.edge ? event.edge.id : 'exit',
        source: event.command?.source || 'geometric'
      } }).catch(() => {});
    }
    if (!stepLog) return;
    await appendFile(stepLog, `${JSON.stringify({
      run: config.runIndex ?? 0,
      step: stepIndex,
      worldTics: event.result.telemetry?.worldTics ?? null,
      edge: event.edge ? event.edge.id : 'exit',
      sector: event.result.state?.currentSector ?? null,
      x: player.x, y: player.y, angle: player.angle,
      health: player.health, armor: player.armor,
      visibleEnemies: event.result.state?.visibleEnemyCount ?? null,
      doorOpening: event.doorOpening ?? null,
      command: event.command,
      source: event.command?.source || 'geometric'
    })}\n`);
  };

  let initial = await engineState(page);
  attempt.startSector = Number(initial.currentSector);
  attempt.skill = initial.skill ?? null; // LinuxDOOM gameskill: 0 ITYTD .. 4 Nightmare
  if (attempt.startSector !== progression.startSector) {
    throw new Error(`Runtime start sector ${attempt.startSector} differs from static plan ${progression.startSector}`);
  }

  await page.evaluate(() => window.DoomControl.setPlaytestPaused(true));
  await page.evaluate(() => window.DoomControl.cancelAgentInput());
  await page.evaluate(() => window.DoomControl.resetPlaytestMetrics());

  // Level tics that ran before the world was frozen; 0-2 is the boot race.
  // Idle exact-tic steps bring every trial to the same reference tic.
  attempt.levelTimeAtPause = Number(initial.levelTime ?? -1);
  if (attempt.levelTimeAtPause >= 0 && attempt.levelTimeAtPause < START_LEVEL_TIC) {
    let guard = 0;
    while (Number(initial.levelTime) < START_LEVEL_TIC && guard++ < 4) {
      const missing = START_LEVEL_TIC - Number(initial.levelTime);
      const idle = await exactInput(page, { forward: 0, strafe: 0, turn: 0, attack: false, use: false, tics: missing });
      initial = idle.state;
    }
  }
  attempt.startLevelTic = Number(initial.levelTime ?? -1);
  if (attempt.startLevelTic !== START_LEVEL_TIC) {
    throw new Error(`Could not normalise start tic: level tic ${attempt.startLevelTic}, expected ${START_LEVEL_TIC}`);
  }

  if (config.godMode) attempt.cheat = await page.evaluate(() => window.DoomControl.setGodMode(true));

  const transitions = progression.transitions;
  // Skipping ahead (landing in a later route sector) must never jump past a
  // key pickup or a trigger, and on a route that loops back through earlier
  // sectors it must only look at the stretch before the next such step.
  const skipLimit = (from) => {
    for (let j = from + 1; j < transitions.length; j++) {
      if (transitions[j].acquiredKeys?.length || transitions[j].firedTag != null || transitions[j].edge.kind === 'trigger') return j;
    }
    return transitions.length - 1;
  };
  const keyThings = graph.things?.keys || [];
  let recoveries = 0;
  let index = 0;
  while (index < transitions.length) {
    const edge = transitions[index].edge;
    const next = transitions[index + 1]?.edge || null;
    const limit = skipLimit(index);
    // route position k holds transitions[k-1].edge.to; allow positions index+2 .. limit+1
    const laterSectors = new Set(progression.sectors.slice(index + 2, limit + 2));
    const result = edge.kind === 'trigger'
      ? await activateTrigger(page, edge, { graph, maxTicsPerEdge: config.maxTicsPerEdge, maxCombatTicsPerEdge: config.maxCombatTicsPerEdge, decide: config.decide, onStep })
      : await navigateEdge(page, graph, edge, {
        maxTicsPerEdge: config.maxTicsPerEdge,
        maxCombatTicsPerEdge: config.maxCombatTicsPerEdge,
        decide: config.decide,
        onStep,
        acceptSectors: laterSectors,
        useNearPortal: Boolean(next && next.action === 'use'),
        doorSector: edge.action === 'use' ? Number(edge.to) : (next && next.action === 'use' ? Number(next.to) : null)
      });
    attempt.totalTics += result.usedTics;
    attempt.edgeResults.push({
      edge: edge.id, kind: edge.kind, action: edge.action,
      passed: result.passed, usedTics: result.usedTics, routeTics: result.routeTics ?? null, combatTics: result.combatTics ?? null,
      failure: result.failure || null,
      endSector: result.finalState?.currentSector ?? null,
      health: result.finalState?.player?.health ?? null
    });
    if (!result.passed) {
      // Route-position recovery: a fight can push the player back into an
      // earlier route sector (back onto a lift that then rises). If the
      // player stands somewhere the route already covered, resume there
      // instead of failing, a few times per run.
      const here = Number(result.finalState?.currentSector);
      let back = -1;
      for (let k = index; k >= 0; k--) if (progression.sectors[k] === here) { back = k; break; }
      if (result.failure === 'edge_no_progress' && back >= 0 && back < index && recoveries < 3) {
        recoveries++;
        attempt.recoveries = recoveries;
        index = back;
        continue;
      }
      attempt.failure = result.failure || 'edge_failed';
      attempt.failedEdge = edge.id;
      break;
    }
    // Continue from wherever the player actually landed on the planned route
    // (first occurrence after the current position, within the skip window).
    let landed = -1;
    for (let k = index + 1; k <= limit + 1 && k < progression.sectors.length; k++) {
      if (progression.sectors[k] === Number(result.reachedSector)) { landed = k; break; }
    }
    const nextIndex = landed > index ? landed : index + 1;
    // Keys: entering a key's sector is not picking it up. Walk to every key
    // the crossed transitions expect to have collected.
    for (let j = index; j < nextIndex && j < transitions.length; j++) {
      for (const keyName of transitions[j].acquiredKeys || []) {
        const key = keyThings.find(item => item.key === keyName && item.sector === Number(transitions[j].edge.to));
        if (!key) continue;
        const keyResult = await collectKey(page, key, { graph, decide: config.decide, onStep, maxCombatTicsPerEdge: config.maxCombatTicsPerEdge });
        attempt.totalTics += keyResult.usedTics;
        attempt.edgeResults.push({
          edge: `key:${keyName}:${key.sector}`, kind: 'key', action: 'walk',
          passed: keyResult.passed, usedTics: keyResult.usedTics, routeTics: keyResult.routeTics ?? null, combatTics: keyResult.combatTics ?? null,
          failure: keyResult.failure || null,
          endSector: keyResult.finalState?.currentSector ?? null,
          health: keyResult.finalState?.player?.health ?? null
        });
        if (!keyResult.passed) { attempt.failure = keyResult.failure || 'key_failed'; attempt.failedEdge = `key:${keyName}`; }
      }
    }
    if (attempt.failure) break;
    index = nextIndex;
  }

  if (!attempt.failure) {
    const exitResult = await approachAndUseExit(page, progression.exit, { graph, decide: config.decide, onStep, maxCombatTicsPerEdge: config.maxCombatTicsPerEdge });
    attempt.totalTics += exitResult.usedTics;
    attempt.exitResult = {
      passed: exitResult.passed, usedTics: exitResult.usedTics, failure: exitResult.failure || null,
      finalGameState: exitResult.finalState?.gameState ?? null
    };
    attempt.passed = exitResult.passed;
    if (!exitResult.passed) attempt.failure = exitResult.failure || 'exit_failed';
    else attempt.levelExitedTo = { episode: exitResult.finalState?.episode, map: exitResult.finalState?.map };
  }

  // After the exit fires the engine is in intermission and reports no player,
  // so the last in-level telemetry sample is the run's final measurement.
  const live = await telemetry(page).catch(() => null);
  attempt.telemetry = live?.ready ? live : lastTelemetry;
  attempt.completedAt = new Date().toISOString();
  return attempt;
}

// Objective block of the summary: the ranked order of this trial's runs, the
// best run's metrics and, when a baseline report was given, the deltas.
function summariseObjective(runs, baselineReport) {
  const ranking = rankRuns(runs);
  return {
    version: OBJECTIVE_VERSION,
    order: OBJECTIVE_ORDER,
    ranking,
    best: ranking.length ? { runIndex: ranking[0], ...runMetrics(runs[ranking[0]]) } : null,
    perRun: runs.map(run => runMetrics(run)),
    ...(baselineReport ? { baseline: compareToBaseline(runs, baselineReport) } : {})
  };
}

export async function loadBaselineReport(file) {
  if (!file) return null;
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    console.error(`autoplay: baseline ${file} not found, ranking without a comparison`);
    return null;
  }
  const report = JSON.parse(text);
  if (!Array.isArray(report.runs)) throw new Error(`Baseline ${file} is not an autoplay report`);
  return { ...report, reportPath: file };
}

export async function runStageClearTrial(input = {}) {
  const config = {
    map: 'E1M1',
    runs: 1,
    godMode: true,
    maxTicsPerEdge: 280,
    iwadPath: DEFAULT_IWAD,
    exportDir: DEFAULT_EXPORT_DIR,
    reportDir: path.join(DEFAULT_EXPORT_DIR, 'autoplay', String(input.map || 'E1M1').toLowerCase()),
    playUrl: `http://127.0.0.1:${Number(process.env.DOOM_MCP_PORT || 3777)}/`,
    ...input
  };
  await mkdir(config.reportDir, { recursive: true });
  const stepLog = path.join(config.reportDir, 'steps.jsonl');
  await writeFile(stepLog, '');

  // Recording hides the engine's "Pause" banner (see transparentPatchLump);
  // --hide-pause / --no-hide-pause overrides that default either way.
  const stage = await prepareStagePwad({ ...config, hidePauseGraphic: config.hidePause ?? Boolean(config.record) });
  const wadBase64 = (await readFile(stage.wadPath)).toString('base64');
  const policyLog = path.join(config.reportDir, 'jev.jsonl');
  const usesPolicy = config.policy === 'jev' || config.policy === 'rules';
  if (usesPolicy) await writeFile(policyLog, '');
  // Static pickups for the policy's item loot, filtered by the trial's skill
  // and tagged with the sector they lie in, so the policy can restrict a
  // detour to items in the player's own sector (no wall in between).
  const mapItems = usesPolicy
    ? (await loadMapItems(config.iwadPath, config.map, { skill: config.skill ?? 0 }))
      .map(item => ({ ...item, sector: locatePointSector(stage.workspace, { x: item.x, y: item.y }) }))
    : [];
  const report = {
    version: AUTOPLAY_VERSION,
    map: config.map,
    godMode: Boolean(config.godMode),
    skill: config.skill ?? null,
    policy: config.policy || 'none',
    baseline: config.baselineReport ? { reportPath: config.baselineReport.reportPath, policy: config.baselineReport.policy || 'none', map: config.baselineReport.map } : null,
    runs: [],
    plan: {
      startSector: stage.progression.startSector,
      sectors: stage.progression.sectors,
      transitions: stage.progression.transitions.map(t => ({ edge: t.edge.id, kind: t.edge.kind, action: t.edge.action })),
      exit: stage.progression.exit,
      keys: stage.progression.keys
    },
    startedAt: new Date().toISOString(),
    stepLog
  };

  const recording = config.record
    ? { ffmpegPath: await findFfmpeg(), every: config.recordEvery === 'step' ? 'step' : 'tic', quality: Number(config.recordQuality ?? 80), bitrate: config.recordBitrate || '1000k' }
    : null;
  if (recording && !recording.ffmpegPath) throw new Error('--record needs ffmpeg: set DOOM_MCP_FFMPEG, install ffmpeg, or run `npx playwright install ffmpeg`');
  if (recording) report.recording = { every: recording.every, quality: recording.quality, bitrate: recording.bitrate, ffmpeg: recording.ffmpegPath };

  const browser = await launchChromium({ headed: Boolean(config.headed) });
  try {
    for (let runIndex = 0; runIndex < Number(config.runs); runIndex++) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      const diagnostics = [];
      page.on('pageerror', error => diagnostics.push({ type: 'pageerror', message: String(error?.message || error) }));
      page.on('console', message => { if (message.type() === 'error') diagnostics.push({ type: 'console', message: message.text() }); });
      let attempt;
      let policy = null;
      let recorder = null;
      let recordError = null;
      if (recording) {
        recorder = await createRecorder({ outputPath: path.join(config.reportDir, `run-${runIndex}.webm`), ffmpegPath: recording.ffmpegPath, bitrate: recording.bitrate });
        // One JPEG page screenshot per world tic (or per command with
        // `every: 'step'`, held for the command's tics). A capture failure is
        // recorded and the trial goes on: the video is a by-product, the
        // outcome must not depend on it.
        setTicHook(page, async ({ tic, tics }) => {
          if (recording.every === 'step' && tic !== tics) return;
          try {
            const jpeg = await page.screenshot({ type: 'jpeg', quality: recording.quality });
            await recorder.frame(jpeg, recording.every === 'step' ? tics : 1);
          } catch (error) {
            if (!recordError) recordError = String(error?.message || error);
          }
        });
      }
      try {
        if (config.policy === 'jev' || config.policy === 'rules') {
          const { createJevPolicy } = await import('./autoplay_jev_policy.mjs');
          policy = await createJevPolicy({
            ...(config.jev || {}), rulesOnly: config.policy === 'rules', log: policyLog, runIndex, items: mapItems, graph: stage.graph,
            onDecision: config.overlay === false ? null : entry => updateOverlay(page, { jev: entry })
          });
        }
        await coldBoot(page, {
          playUrl: config.playUrl, filename: stage.filename, map: config.map,
          coldBootTimeoutMs: config.coldBootTimeoutMs, pauseOnReady: true,
          bootArgs: config.skill == null ? [] : ['-skill', String(Number(config.skill) + 1)]
        }, wadBase64);
        if (config.overlay !== false) {
          await installOverlay(page, { title: `AUTOPLAY ${config.map} · ${config.policy || 'none'} · run ${runIndex}` });
        }
        attempt = await runStageAttempt(page, stage, {
          ...config, runIndex, stepLog, decide: policy ? policy.decide : config.decide
        });
        if (policy) attempt.policy = policy.summary();
      } catch (error) {
        attempt = { passed: false, failure: 'browser_trial_error', error: String(error?.stack || error?.message || error) };
      } finally {
        if (recorder) {
          setTicHook(page, null);
          try {
            // Hold the end state (exit screen, death) for a second.
            await recorder.hold(35);
            const video = await recorder.finish();
            if (attempt) attempt.video = { ...video, every: recording.every, ...(recordError ? { captureError: recordError } : {}) };
          } catch (error) {
            await recorder.abort();
            if (attempt) attempt.video = { path: null, error: String(error?.message || error) };
          }
        }
        if (config.captureFrame !== false) {
          // A page screenshot keeps the overlay and works after the level has
          // been left; the canvas capture (toDataURL) comes back black then.
          const shot = path.join(config.reportDir, `run-${runIndex}.png`);
          try {
            await page.screenshot({ path: shot });
            if (attempt) attempt.screenshot = shot;
          } catch {
            try {
              const frame = await page.evaluate(() => window.DoomControl.captureFrame());
              if (frame?.base64) {
                await writeFile(shot, Buffer.from(frame.base64, 'base64'));
                if (attempt) attempt.screenshot = shot;
              }
            } catch {}
          }
        }
        await page.close().catch(() => {});
      }
      attempt.runIndex = runIndex;
      attempt.diagnostics = diagnostics;
      report.runs.push(attempt);
      if (policy && !attempt.policy) attempt.policy = policy.summary();
      console.error(`autoplay ${config.map} run ${runIndex}: ${attempt.passed ? 'CLEARED' : 'FAILED'} ${JSON.stringify({
        skill: attempt.skill ?? null,
        totalTics: attempt.totalTics, steps: attempt.steps, failure: attempt.failure || null, failedEdge: attempt.failedEdge || null,
        deaths: attempt.telemetry?.deaths ?? null, damageTaken: attempt.telemetry?.damageTaken ?? null, kills: attempt.telemetry?.kills ?? null,
        ...(attempt.policy ? { jevCalls: attempt.policy.calls, jevOverrides: attempt.policy.overrides, jevInputTokens: attempt.policy.inputTokens, jevCostUsd: attempt.policy.estimatedInputCostUsd } : {}),
        ...(attempt.video ? { video: attempt.video.path, videoSeconds: attempt.video.seconds, videoBytes: attempt.video.bytes, videoError: attempt.video.error || attempt.video.captureError || null } : {})
      })}`);
    }
  } finally {
    await browser.close();
  }

  const passedRuns = report.runs.filter(run => run.passed);
  report.summary = {
    runs: report.runs.length,
    cleared: passedRuns.length,
    clearRate: report.runs.length ? passedRuns.length / report.runs.length : 0,
    totalTics: report.runs.map(run => run.totalTics ?? null),
    levelTimeAtPause: report.runs.map(run => run.levelTimeAtPause ?? null),
    startLevelTic: report.runs.map(run => run.startLevelTic ?? null),
    deterministic: passedRuns.length > 1 && passedRuns.every(run => run.totalTics === passedRuns[0].totalTics
      && run.startLevelTic === passedRuns[0].startLevelTic),
    deaths: report.runs.map(run => run.telemetry?.deaths ?? null),
    minHealth: report.runs.map(run => run.telemetry?.minHealth ?? null),
    damageTaken: report.runs.map(run => run.telemetry?.damageTaken ?? null),
    kills: report.runs.map(run => run.telemetry?.kills ?? null),
    objective: summariseObjective(report.runs, config.baselineReport),
    ...(config.policy === 'jev' || config.policy === 'rules' ? {
      jevCalls: report.runs.map(run => run.policy?.calls ?? null),
      jevOverrides: report.runs.map(run => run.policy?.overrides ?? null),
      jevInputTokens: report.runs.reduce((sum, run) => sum + Number(run.policy?.inputTokens || 0), 0),
      jevEstimatedCostUsd: report.runs.reduce((sum, run) => sum + Number(run.policy?.estimatedInputCostUsd || 0), 0)
    } : {})
  };
  report.passed = report.runs.length > 0 && passedRuns.length === report.runs.length;
  report.completedAt = new Date().toISOString();
  report.reportPath = path.join(config.reportDir, 'report.json');
  await writeFile(report.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { values } = parseArgs({
    options: {
      map: { type: 'string', default: 'E1M1' },
      runs: { type: 'string', default: '1' },
      god: { type: 'boolean', default: true },
      'max-edge-tics': { type: 'string', default: '280' },
      'max-combat-tics': { type: 'string', default: '600' },
      'report-dir': { type: 'string' },
      policy: { type: 'string', default: 'none' },
      'jev-dry-run': { type: 'boolean', default: false },
      'jev-max-calls': { type: 'string', default: '600' },
      'jev-model': { type: 'string' },
      'jev-pipeline': { type: 'string' },      // lag in tics; answers apply this long after their state
      'jev-min-steps': { type: 'string', default: '1' },
      baseline: { type: 'string' },
      skill: { type: 'string' },
      headed: { type: 'boolean', default: false },
      overlay: { type: 'boolean', default: true },
      record: { type: 'boolean', default: false },
      'record-every': { type: 'string', default: 'tic' },   // tic: one frame per world tic; step: one per command
      'record-quality': { type: 'string', default: '80' }, // JPEG quality of the captured frames
      'record-bitrate': { type: 'string', default: '1000k' },
      'hide-pause': { type: 'boolean' }                    // default: hidden while recording, shown otherwise
    },
    allowNegative: true
  });
  const { startBridge } = await import('./server.js');
  const bridge = startBridge();
  try {
    const baselineReport = values.baseline ? await loadBaselineReport(path.resolve(values.baseline)) : null;
    const report = await runStageClearTrial({
      baselineReport,
      skill: parseSkill(values.skill),
      headed: Boolean(values.headed),
      overlay: Boolean(values.overlay),
      record: Boolean(values.record),
      recordEvery: String(values['record-every']),
      recordQuality: Number(values['record-quality']),
      recordBitrate: String(values['record-bitrate']),
      ...(values['hide-pause'] == null ? {} : { hidePause: Boolean(values['hide-pause']) }),
      map: String(values.map).toUpperCase(),
      runs: Number(values.runs),
      godMode: Boolean(values.god),
      maxTicsPerEdge: Number(values['max-edge-tics']),
      maxCombatTicsPerEdge: Number(values['max-combat-tics']),
      policy: String(values.policy),
      jev: {
        dryRun: Boolean(values['jev-dry-run']), maxCalls: Number(values['jev-max-calls']), model: values['jev-model'],
        pipelineLagTics: values['jev-pipeline'] ? Number(values['jev-pipeline']) : 0,
        minStepsBetweenCalls: Number(values['jev-min-steps'])
      },
      ...(values['report-dir'] ? { reportDir: path.resolve(values['report-dir']) } : {})
    });
    const { objective, ...rest } = report.summary;
    console.error(`autoplay summary: ${JSON.stringify(rest)} (report: ${report.reportPath})`);
    console.error(`autoplay objective (${objective.order.join(' > ')}): best run ${JSON.stringify(objective.best)}`);
    if (objective.baseline) console.error(`autoplay vs baseline ${objective.baseline.baselinePolicy}: ${objective.baseline.verdict} ${JSON.stringify(objective.baseline.delta)}`);
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  } finally {
    bridge.close();
    process.exit();
  }
}
