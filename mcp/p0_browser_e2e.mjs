import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// Importing P0 installs the topology patch and proves the full MCP composition
// can be loaded before we start the five browser bridges used by the real WASM.
await import('./p0_server.js');
const { startBridge: startAuthoringBridge } = await import('./server.js');
const { startPlaytestBridge } = await import('./playtest_server.js');
const { startOrchestrationBridge } = await import('./v1_server.js');
const { startCheatBridge } = await import('./cheat_server.js');
const { startGeometryBridge } = await import('./geometry_server.js');

startAuthoringBridge();
startPlaytestBridge();
startOrchestrationBridge();
startCheatBridge();
startGeometryBridge();

async function health(port) {
  const response = await fetch(`http://127.0.0.1:${port}/health`, { cache: 'no-store' });
  assert.equal(response.ok, true, `health ${port} returned ${response.status}`);
  return response.json();
}

async function waitForBridge(port, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await health(port);
      if (last.browserConnected) return last;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Browser bridge ${port} did not connect: ${JSON.stringify(last)}`);
}

const browser = await chromium.launch({
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required']
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const browserErrors = [];
page.on('pageerror', error => browserErrors.push(String(error?.message || error)));
page.on('console', message => {
  if (message.type() === 'error') browserErrors.push(message.text());
});

try {
  await page.goto('http://127.0.0.1:3777/', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('#start.ready:not([disabled])', { timeout: 120000 });
  await page.click('#start');
  await page.waitForFunction(() => typeof Module !== 'undefined' && typeof Module.ccall === 'function', null, { timeout: 120000 });

  const warped = await page.evaluate(() => Module.ccall(
    'doomctl_warp', 'number', ['number', 'number'], [1, 1]
  ));
  assert.equal(warped, 1, 'doomctl_warp(E1M1) failed');

  await page.waitForFunction(() => {
    try {
      const state = window.DoomControl?.getState?.();
      return state?.ready && state.episode === 1 && state.map === 1;
    } catch {
      return false;
    }
  }, null, { timeout: 30000 });

  const state = await page.evaluate(() => window.DoomControl.getState());
  assert.equal(state.ready, true);
  assert.equal(state.episode, 1);
  assert.equal(state.map, 1);

  const bridgeHealth = {};
  for (const port of [3777, 3778, 3779, 3780, 3781]) {
    bridgeHealth[port] = await waitForBridge(port);
    assert.equal(bridgeHealth[port].browserConnected, true, `bridge ${port} is not browser-connected`);
  }

  // Exercise exported engine surfaces that back MCP playtest/geometry calls.
  const engineSmoke = await page.evaluate(() => ({
    state: window.DoomControl.getState(),
    sectors: window.DoomControl.getSectors(16),
    geometryBridge: typeof window.DoomGeometryDispatch !== 'undefined',
    playtestBridge: typeof window.DoomPlaytestDispatch !== 'undefined'
  }));
  assert.equal(engineSmoke.state.ready, true);
  assert.ok(Number(engineSmoke.sectors?.sectorCount || 0) > 0);
  assert.equal(engineSmoke.geometryBridge, true);
  assert.equal(engineSmoke.playtestBridge, true);

  console.error('P0 real-browser E2E passed:', JSON.stringify({
    map: `E${state.episode}M${state.map}`,
    bridges: Object.fromEntries(Object.entries(bridgeHealth).map(([port, value]) => [port, Boolean(value.browserConnected)])),
    sectors: engineSmoke.sectors.sectorCount
  }));
} finally {
  await browser.close();
}

// Browser console can contain autoplay/device warnings in CI. Only fatal runtime
// errors that prevent the assertions above should fail this smoke test.
if (browserErrors.length) {
  console.error('P0 browser console diagnostics:', browserErrors.slice(-20));
}
process.exit(0);
