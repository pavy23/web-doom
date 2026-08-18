import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

import { findSectorPath } from './navigation_graph.js';

const DEFAULT_PLAY_URL = 'http://127.0.0.1:3777/';
const MAP_RE = /^(?:E([1-9])M([1-9])|MAP(\d\d))$/;

function mapWarpArgs(mapName) {
  const match = MAP_RE.exec(String(mapName || '').toUpperCase());
  if (!match) throw new Error(`Unsupported map name: ${mapName}`);
  if (match[1]) return { episode: Number(match[1]), map: Number(match[2]) };
  return { episode: 1, map: Number(match[3]) };
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
function crossingPoint(edge, targetCenter) {
  const dx = Number(targetCenter.x) - Number(edge.midpoint.x);
  const dy = Number(targetCenter.y) - Number(edge.midpoint.y);
  const length = Math.hypot(dx, dy) || 1;
  return { x: Number(edge.midpoint.x) + dx / length * 28, y: Number(edge.midpoint.y) + dy / length * 28 };
}
async function launchChromium() {
  const args = ['--autoplay-policy=no-user-gesture-required'];
  try { return await chromium.launch({ headless: true, args }); }
  catch (firstError) {
    try { return await chromium.launch({ headless: true, channel: 'chrome', args }); }
    catch { throw new Error(`Unable to launch Chromium: ${firstError?.message || firstError}`); }
  }
}
async function waitForRuntime(page, timeout = 120000) {
  await page.waitForFunction(() => typeof Module !== 'undefined'
    && typeof Module.ccall === 'function'
    && typeof window.DoomControl?.getState === 'function'
    && typeof window.DoomControl?.geometryLoad === 'function'
    && typeof window.DoomControl?.queueAgentInput === 'function'
    && typeof window.DoomControl?.stepPlaytestTics === 'function', null, { timeout });
}
async function waitForPlayable(page, expected, timeout = 30000) {
  await page.waitForFunction(({ episode, map }) => {
    try {
      const state = window.DoomControl.getState();
      return Boolean(state?.ready) && Number(state.episode) === episode && Number(state.map) === map;
    } catch { return false; }
  }, expected, { timeout });
  return page.evaluate(() => window.DoomControl.getState());
}
async function warp(page, mapName) {
  const expected = mapWarpArgs(mapName);
  const result = await page.evaluate(({ episode, map }) => Module.ccall(
    'doomctl_warp', 'number', ['number', 'number'], [episode, map]
  ), expected);
  if (result !== 1) throw new Error(`LinuxDOOM rejected warp to ${mapName}`);
  return waitForPlayable(page, expected);
}
async function coldBoot(page, config, wadBase64) {
  await page.goto(config.playUrl || DEFAULT_PLAY_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await waitForRuntime(page);
  const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 120000 });
  const staging = await page.evaluate(({ filename, base64 }) => window.DoomControl.geometryLoad(filename, base64), {
    filename: config.filename, base64: wadBase64
  });
  assert.equal(staging?.scheduled, true, JSON.stringify(staging));
  await navigation;
  await waitForRuntime(page);
  await page.waitForFunction(filename => window.DoomColdBoot?.prepared === true
    && window.DoomColdBoot?.candidate === filename, config.filename, { timeout: 60000 });
  await page.waitForSelector('#start.ready:not([disabled])', { timeout: 60000 });
  await page.click('#start');
  return warp(page, config.map);
}
async function exactInput(page, command) {
  const tics = Math.max(1, Math.min(12, Math.trunc(command.tics || 1)));
  const before = await page.evaluate(() => window.DoomControl.getPlaytestTelemetry());
  const status = await page.evaluate(() => window.DoomControl.getAgentInputStatus());
  if (status?.active) await page.evaluate(() => window.DoomControl.cancelAgentInput());
  await page.evaluate(cmd => window.DoomControl.queueAgentInput(cmd), { ...command, tics });
  await page.evaluate(count => window.DoomControl.stepPlaytestTics(count), tics);
  const targetTics = Number(before.worldTics || 0) + tics;
  await page.waitForFunction(target => {
    const telemetry = window.DoomControl.getPlaytestTelemetry();
    return Number(telemetry?.worldTics || 0) >= target && Number(telemetry?.stepBudget || 0) === 0;
  }, targetTics, { timeout: 8000 });
  return {
    state: await page.evaluate(() => window.DoomControl.getState()),
    telemetry: await page.evaluate(() => window.DoomControl.getPlaytestTelemetry()),
    tics
  };
}
async function navigateEdge(page, graph, edge, options = {}) {
  const maxTics = Number(options.maxTicsPerEdge || 210);
  const targetNode = graph.nodes[edge.to];
  const cross = crossingPoint(edge, targetNode.center);
  const trace = [];
  let usedTics = 0;
  let lastDistance = Infinity;
  let stalled = 0;
  let recoverySide = 1;

  while (usedTics < maxTics) {
    const state = await page.evaluate(() => window.DoomControl.getState());
    if (!state?.ready || !state.player) throw new Error('Navigation runtime lost player state');
    if (Number(state.currentSector) === Number(edge.to)) {
      return { passed: true, edge, usedTics, trace, finalState: state };
    }
    if (Number(state.player.health || 0) <= 0) return { passed: false, edge, usedTics, trace, failure: 'player_dead', finalState: state };

    const position = { x: Number(state.player.x), y: Number(state.player.y) };
    const portalDistance = distance(position, edge.midpoint);
    const target = portalDistance < 44 ? cross : edge.midpoint;
    const targetDistance = distance(position, target);
    const desired = headingDegrees(position, target);
    const delta = angleDelta(Number(state.player.angle), desired);
    let command;

    if (targetDistance >= lastDistance - 0.75) stalled++;
    else stalled = Math.max(0, stalled - 1);
    lastDistance = targetDistance;

    if (stalled >= 7) {
      command = { forward: 0.25, strafe: 0.55 * recoverySide, turn: -0.18 * recoverySide, use: edge.action === 'use', tics: 3 };
      recoverySide *= -1;
      stalled = 0;
    } else if (Math.abs(delta) > 10) {
      // Agent +turn means intuitive right; positive geometric delta is CCW/left.
      const magnitude = Math.min(0.7, Math.max(0.16, Math.abs(delta) / 90 * 0.55));
      command = { turn: delta > 0 ? -magnitude : magnitude, use: false, tics: Math.abs(delta) > 50 ? 3 : 2 };
    } else {
      const nearPortal = portalDistance < 56;
      command = {
        forward: nearPortal ? 0.72 : 0.62,
        turn: delta > 3 ? -0.08 : delta < -3 ? 0.08 : 0,
        use: edge.action === 'use' && nearPortal,
        tics: nearPortal ? 3 : 4
      };
    }

    const result = await exactInput(page, command);
    usedTics += result.tics;
    if (trace.length < 80) trace.push({
      tics: usedTics,
      sector: result.state.currentSector,
      x: result.state.player?.x,
      y: result.state.player?.y,
      angle: result.state.player?.angle,
      portalDistance,
      targetDistance,
      delta,
      command
    });
  }
  const finalState = await page.evaluate(() => window.DoomControl.getState());
  return { passed: Number(finalState?.currentSector) === Number(edge.to), edge, usedTics, trace, failure: 'edge_tic_budget_exhausted', finalState };
}

export async function runNavigationBrowserTrial(input) {
  const config = {
    playUrl: DEFAULT_PLAY_URL,
    maxTicsPerEdge: 210,
    captureFrame: true,
    keys: [],
    ...input
  };
  if (!config.wadPath || !config.filename || !config.map || !config.graph || config.targetSector == null || !config.reportDir) {
    throw new Error('wadPath, filename, map, graph, targetSector and reportDir are required');
  }
  await mkdir(config.reportDir, { recursive: true });
  const wadBase64 = (await readFile(config.wadPath)).toString('base64');
  const report = {
    version: '2.4.0-p1.3',
    map: config.map,
    targetSector: Number(config.targetSector),
    startedAt: new Date().toISOString(),
    passed: false,
    startSector: null,
    plan: null,
    edgeResults: [],
    diagnostics: []
  };
  const browser = await launchChromium();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', error => report.diagnostics.push({ type: 'pageerror', message: String(error?.message || error) }));
  page.on('console', message => { if (message.type() === 'error') report.diagnostics.push({ type: 'console', message: message.text() }); });

  try {
    const initial = await coldBoot(page, config, wadBase64);
    await page.evaluate(() => window.DoomControl.setPlaytestPaused(true));
    await page.evaluate(() => window.DoomControl.cancelAgentInput());
    await page.evaluate(() => window.DoomControl.resetPlaytestMetrics());
    report.startSector = Number(initial.currentSector);
    report.plan = findSectorPath(config.graph, report.startSector, Number(config.targetSector), { keys: config.keys || [] });
    if (!report.plan.found) {
      report.failure = 'no_static_path';
    } else {
      for (const edge of report.plan.edges) {
        const result = await navigateEdge(page, config.graph, edge, config);
        report.edgeResults.push(result);
        if (!result.passed) { report.failure = result.failure || 'edge_failed'; break; }
      }
      const finalState = await page.evaluate(() => window.DoomControl.getState());
      report.finalState = finalState;
      report.telemetry = await page.evaluate(() => window.DoomControl.getPlaytestTelemetry());
      report.passed = Number(finalState?.currentSector) === Number(config.targetSector)
        && report.edgeResults.every(result => result.passed);
      if (config.captureFrame !== false) {
        const frame = await page.evaluate(() => window.DoomControl.captureFrame());
        if (frame?.base64) {
          const screenshot = path.join(config.reportDir, `${config.map}-navigation.png`);
          await writeFile(screenshot, Buffer.from(frame.base64, 'base64'));
          report.screenshot = screenshot;
        }
      }
    }
  } finally {
    await browser.close();
  }
  report.completedAt = new Date().toISOString();
  report.reportPath = path.join(config.reportDir, 'report.json');
  await writeFile(report.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
