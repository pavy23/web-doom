import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const DEFAULT_PLAY_URL = 'http://127.0.0.1:3777/';
const MAP_RE = /^(?:E([1-9])M([1-9])|MAP(\d\d))$/;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function normalizeMapName(value) {
  const map = String(value || '').trim().toUpperCase();
  if (!MAP_RE.test(map)) throw new Error(`Unsupported experiment map name: ${value}`);
  return map;
}

function mapWarpArgs(mapName) {
  const match = MAP_RE.exec(normalizeMapName(mapName));
  if (match[1]) return { episode: Number(match[1]), map: Number(match[2]) };
  // LinuxDOOM commercial mode still routes MAP## through gameepisode=1/gamemap=N.
  return { episode: 1, map: Number(match[3]) };
}

function normalizeAction(action = {}) {
  const tics = Math.trunc(Number(action.tics || 0));
  if (tics < 1 || tics > 350) throw new Error(`Experiment action tics must be 1..350, got ${action.tics}`);
  const bounded = (value, name) => {
    const number = Number(value || 0);
    if (!Number.isFinite(number) || number < -1 || number > 1) throw new Error(`${name} must be -1..1`);
    return number;
  };
  return {
    forward: bounded(action.forward, 'forward'),
    strafe: bounded(action.strafe, 'strafe'),
    turn: bounded(action.turn, 'turn'),
    attack: Boolean(action.attack),
    use: Boolean(action.use),
    tics
  };
}

function normalizeActions(actions, smokeTics) {
  const list = Array.isArray(actions) && actions.length
    ? actions.map(normalizeAction)
    : [normalizeAction({ tics: smokeTics })];
  if (list.length > 16) throw new Error('Experiment action plan is limited to 16 actions per map');
  const totalTics = list.reduce((sum, action) => sum + action.tics, 0);
  if (totalTics > 700) throw new Error(`Experiment action plan is ${totalTics} tics; maximum is 700`);
  return { list, totalTics };
}

async function launchChromium() {
  const args = ['--autoplay-policy=no-user-gesture-required'];
  try {
    return await chromium.launch({ headless: true, args });
  } catch (firstError) {
    // Local developer convenience: use installed Chrome when Playwright's managed
    // Chromium has not been installed yet. CI installs managed Chromium explicitly.
    try {
      return await chromium.launch({ headless: true, channel: 'chrome', args });
    } catch {
      throw new Error(
        `Unable to launch an experiment browser. Run "npx playwright install chromium" once. Original error: ${firstError?.message || firstError}`
      );
    }
  }
}

async function waitForRuntime(page, timeout = 120000) {
  await page.waitForFunction(() =>
    typeof Module !== 'undefined'
      && typeof Module.ccall === 'function'
      && window.DoomControl
      && typeof window.DoomControl.getState === 'function',
  null, { timeout });
}

async function waitForPlayableState(page, expected, timeout = 30000) {
  await page.waitForFunction(({ episode, map }) => {
    try {
      const state = window.DoomControl?.getState?.();
      return Boolean(state?.ready) && Number(state.episode) === episode && Number(state.map) === map;
    } catch {
      return false;
    }
  }, expected, { timeout });
  return page.evaluate(() => window.DoomControl.getState());
}

async function coldBootCandidate(page, config, wadBase64) {
  await page.goto(config.playUrl || DEFAULT_PLAY_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await waitForRuntime(page);
  await page.waitForFunction(() => typeof window.DoomControl?.geometryLoad === 'function', null, { timeout: 30000 });

  const navigationPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 120000 });
  const staging = await page.evaluate(({ filename, base64 }) =>
    window.DoomControl.geometryLoad(filename, base64),
  { filename: config.filename, base64: wadBase64 });
  assert.equal(staging?.scheduled, true, `geometryLoad did not schedule cold boot: ${JSON.stringify(staging)}`);
  await navigationPromise;

  await waitForRuntime(page);
  await page.waitForFunction(filename =>
    window.DoomColdBoot?.prepared === true && window.DoomColdBoot?.candidate === filename,
  config.filename, { timeout: 60000 });
  await page.waitForSelector('#start.ready:not([disabled])', { timeout: 60000 });
  await page.click('#start');

  const firstMap = mapWarpArgs(config.maps[0]);
  const state = await waitForPlayableState(page, firstMap, 60000);
  return { staging, state, coldBoot: await page.evaluate(() => window.DoomColdBoot || null) };
}

async function warpTo(page, mapName) {
  const expected = mapWarpArgs(mapName);
  const result = await page.evaluate(({ episode, map }) => Module.ccall(
    'doomctl_warp', 'number', ['number', 'number'], [episode, map]
  ), expected);
  if (result !== 1) throw new Error(`LinuxDOOM rejected warp to ${mapName}`);
  return waitForPlayableState(page, expected, 30000);
}

async function runExactAction(page, action) {
  const before = await page.evaluate(() => window.DoomControl.getPlaytestTelemetry());
  const agent = await page.evaluate(() => window.DoomControl.getAgentInputStatus());
  if (agent?.active) await page.evaluate(() => window.DoomControl.cancelAgentInput());

  await page.evaluate(command => window.DoomControl.queueAgentInput(command), action);
  await page.evaluate(count => window.DoomControl.stepPlaytestTics(count), action.tics);
  const target = Number(before.worldTics || 0) + action.tics;
  const timeout = Math.max(6000, Math.ceil(action.tics / 35 * 1000) + 5000);
  await page.waitForFunction(targetWorldTics => {
    const telemetry = window.DoomControl.getPlaytestTelemetry();
    return Number(telemetry?.worldTics || 0) >= targetWorldTics && Number(telemetry?.stepBudget || 0) === 0;
  }, target, { timeout });

  const after = await page.evaluate(() => window.DoomControl.getPlaytestTelemetry());
  const finalAgent = await page.evaluate(() => window.DoomControl.getAgentInputStatus());
  if (finalAgent?.active || Number(finalAgent?.remainingTics || 0) !== 0) {
    throw new Error('Experiment agent input did not drain after exact tic stepping');
  }
  return { action, before, after };
}

function evaluateMap({ map, state, baseline, final, frame, totalTics, expectations = {} }) {
  const failures = [];
  const warp = mapWarpArgs(map);
  const advanced = Number(final?.worldTics || 0) - Number(baseline?.worldTics || 0);
  const maxDeaths = Number(expectations.maxDeaths ?? 0);
  const minHealth = Number(expectations.minHealth ?? 1);
  const minDistanceUnits = Number(expectations.minDistanceUnits ?? 0);
  const minVisitedSectors = Number(expectations.minVisitedSectors ?? 1);

  if (!state?.ready) failures.push('runtime_not_ready');
  if (Number(state?.episode) !== warp.episode || Number(state?.map) !== warp.map) failures.push('wrong_map');
  if (advanced !== totalTics) failures.push(`tic_mismatch:${advanced}/${totalTics}`);
  if (Number(final?.deaths || 0) > maxDeaths) failures.push(`deaths:${final.deaths}>${maxDeaths}`);
  if (Number(final?.health || 0) < minHealth) failures.push(`health:${final?.health || 0}<${minHealth}`);
  if (Number(final?.distanceUnits || 0) < minDistanceUnits) failures.push(`distance:${final?.distanceUnits || 0}<${minDistanceUnits}`);
  if (Number(final?.visitedSectors || 0) < minVisitedSectors) failures.push(`visited:${final?.visitedSectors || 0}<${minVisitedSectors}`);
  if (!frame?.base64 || Number(frame.width || 0) <= 0 || Number(frame.height || 0) <= 0) failures.push('frame_capture_failed');

  return { passed: failures.length === 0, failures, advancedTics: advanced };
}

async function runMapExperiment(page, mapName, config) {
  const startedAt = new Date().toISOString();
  const state = await warpTo(page, mapName);
  await page.evaluate(() => window.DoomControl.setPlaytestPaused(true));
  await page.evaluate(() => window.DoomControl.cancelAgentInput());
  const baseline = await page.evaluate(() => window.DoomControl.resetPlaytestMetrics());

  const { list: actions, totalTics } = normalizeActions(config.actionsByMap?.[mapName], config.smokeTics);
  const actionResults = [];
  for (const action of actions) {
    actionResults.push(await runExactAction(page, action));
    const latest = actionResults.at(-1)?.after;
    if (Number(latest?.deaths || 0) > 0 || Number(latest?.health || 0) <= 0) break;
  }

  const final = await page.evaluate(() => window.DoomControl.getPlaytestTelemetry());
  const finalState = await page.evaluate(() => window.DoomControl.getState());
  const frame = await page.evaluate(() => window.DoomControl.captureFrame());
  let screenshot = null;
  if (config.captureFrames !== false && frame?.base64) {
    screenshot = path.join(config.reportDir, `${mapName}.png`);
    await writeFile(screenshot, Buffer.from(frame.base64, 'base64'));
  }

  const expectedTics = actionResults.reduce((sum, row) => sum + row.action.tics, 0);
  const evaluation = evaluateMap({
    map: mapName,
    state: finalState,
    baseline,
    final,
    frame,
    totalTics: expectedTics,
    expectations: config.expectationsByMap?.[mapName]
  });

  return {
    map: mapName,
    passed: evaluation.passed,
    failures: evaluation.failures,
    startedAt,
    completedAt: new Date().toISOString(),
    requestedTics: totalTics,
    executedTics: evaluation.advancedTics,
    actionsRequested: actions.length,
    actionsExecuted: actionResults.length,
    state: {
      ready: Boolean(finalState?.ready),
      episode: finalState?.episode,
      map: finalState?.map,
      currentSector: finalState?.currentSector,
      enemyCount: finalState?.enemyCount
    },
    telemetry: {
      elapsedSeconds: final?.elapsedSeconds,
      worldTics: final?.worldTics,
      health: final?.health,
      minHealth: final?.minHealth,
      deaths: final?.deaths,
      damageTaken: final?.damageTaken,
      distanceUnits: final?.distanceUnits,
      visitedSectors: final?.visitedSectors,
      killDelta: final?.killDelta,
      itemDelta: final?.itemDelta,
      secretDelta: final?.secretDelta
    },
    frame: { width: frame?.width, height: frame?.height, screenshot },
    actionResults
  };
}

export async function runBrowserEpisodeExperiment(inputConfig) {
  const config = {
    playUrl: DEFAULT_PLAY_URL,
    smokeTics: 35,
    captureFrames: true,
    stopOnFailure: false,
    actionsByMap: {},
    expectationsByMap: {},
    ...inputConfig
  };
  config.maps = (config.maps || []).map(normalizeMapName);
  if (!config.maps.length) throw new Error('Experiment requires at least one map');
  if (config.smokeTics < 1 || config.smokeTics > 350) throw new Error('smokeTics must be 1..350');
  if (!config.wadPath || !config.filename || !config.reportDir) throw new Error('wadPath, filename and reportDir are required');
  await mkdir(config.reportDir, { recursive: true });

  const wadBytes = await readFile(config.wadPath);
  const wadBase64 = wadBytes.toString('base64');
  const report = {
    version: '1.0.0-p0',
    experimentId: config.experimentId || `experiment-${Date.now()}`,
    filename: config.filename,
    wadPath: config.wadPath,
    wadBytes: wadBytes.length,
    maps: config.maps,
    startedAt: new Date().toISOString(),
    completedAt: null,
    passed: false,
    coldBoot: null,
    results: [],
    browserDiagnostics: []
  };

  const browser = await launchChromium();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', error => report.browserDiagnostics.push({ type: 'pageerror', message: String(error?.message || error) }));
  page.on('console', message => {
    if (message.type() === 'error') report.browserDiagnostics.push({ type: 'console', message: message.text() });
  });

  try {
    report.coldBoot = await coldBootCandidate(page, config, wadBase64);
    for (const map of config.maps) {
      try {
        const result = await runMapExperiment(page, map, config);
        report.results.push(result);
        if (!result.passed && config.stopOnFailure) break;
      } catch (error) {
        report.results.push({
          map,
          passed: false,
          failures: ['runner_exception'],
          error: String(error?.message || error),
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString()
        });
        if (config.stopOnFailure) break;
      }
    }
  } finally {
    await browser.close();
  }

  report.completedAt = new Date().toISOString();
  report.passed = report.results.length === config.maps.length && report.results.every(result => result.passed);
  report.summary = {
    requestedMaps: config.maps.length,
    testedMaps: report.results.length,
    passedMaps: report.results.filter(result => result.passed).length,
    failedMaps: report.results.filter(result => !result.passed).length
  };
  const reportPath = path.join(config.reportDir, 'report.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return { ...report, reportPath };
}

async function main() {
  const configPath = process.argv[2];
  if (!configPath) throw new Error('Usage: node episode_experiment_browser.mjs <config.json>');
  const config = JSON.parse(await readFile(path.resolve(configPath), 'utf8'));
  const report = await runBrowserEpisodeExperiment(config);
  process.stdout.write(`${JSON.stringify({
    passed: report.passed,
    experimentId: report.experimentId,
    reportPath: report.reportPath,
    summary: report.summary
  })}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => {
    console.error(error?.stack || error?.message || error);
    process.exitCode = 1;
  });
}
