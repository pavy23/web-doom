import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseUrl = process.env.DOOM_P22_PUBLIC_URL || 'http://127.0.0.1:8000/';
const browser = await chromium.launch({ headless: true });
const diagnostics = [];

function attachDiagnostics(page, label) {
  page.on('console', message => {
    const text = `${label}:${message.type()}:${message.text()}`;
    diagnostics.push(text);
  });
  page.on('pageerror', error => diagnostics.push(`${label}:pageerror:${error.message}`));
}

async function waitRuntime(page) {
  await page.waitForFunction(() => {
    return typeof Module !== 'undefined'
      && typeof Module.ccall === 'function'
      && document.getElementById('playClassic')?.disabled === false
      && document.getElementById('playAi')?.disabled === false;
  }, null, { timeout: 120_000 });
}

try {
  const classic = await browser.newPage();
  attachDiagnostics(classic, 'classic');
  await classic.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await waitRuntime(classic);
  assert.equal(await classic.locator('#playClassic').textContent(), 'PLAY CLASSIC DOOM');
  assert.equal(await classic.locator('#playAi').textContent(), 'PLAY AI DEATHMATCH');
  await classic.locator('#playClassic').click();
  await classic.waitForFunction(() => window.DoomPublicLauncher?.mode === 'classic', null, { timeout: 30_000 });
  const classicState = await classic.evaluate(() => ({
    launcher: window.DoomPublicLauncher,
    capacity: Module.ccall('doomctl_get_local_player_capacity', 'number', [], []),
    botStatus: window.DoomLocalBots?.status?.() || null
  }));
  assert.equal(classicState.capacity, 1, JSON.stringify(classicState));
  assert.equal(classicState.launcher.mode, 'classic');
  assert.equal(classicState.launcher.demoWad, null);
  await classic.close();

  const ai = await browser.newPage();
  attachDiagnostics(ai, 'ai');
  await ai.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await waitRuntime(ai);

  const wadResponse = await ai.request.get(new URL('p22-demo.wad', baseUrl).href);
  assert.equal(wadResponse.ok(), true);
  const wadBytes = await wadResponse.body();
  assert.equal(wadBytes.subarray(0, 4).toString('ascii'), 'PWAD');

  await ai.locator('#playAi').click();
  await ai.waitForFunction(() => {
    const status = window.DoomLocalBots?.status?.();
    return window.DoomPublicLauncher?.mode === 'ai'
      && status?.running
      && status?.players?.ready
      && Array.isArray(status.players.players)
      && status.players.players.length >= 4;
  }, null, { timeout: 60_000 });

  await ai.waitForFunction(() => {
    const status = window.DoomLocalBots?.status?.();
    return Array.isArray(status?.decisions)
      && status.decisions.slice(1, 4).every(value => Number(value) > 0);
  }, null, { timeout: 30_000 });

  // Public/live acceptance must prove more than movement. Every AI slot must
  // acquire a visible opponent and emit a real BT_ATTACK command. This catches
  // regressions where bots orbit forever without engaging.
  await ai.waitForFunction(() => {
    const status = window.DoomLocalBots?.status?.();
    return Array.isArray(status?.visibleDecisions)
      && Array.isArray(status?.attacks)
      && status.visibleDecisions.slice(1, 4).every(value => Number(value) > 0)
      && status.attacks.slice(1, 4).every(value => Number(value) > 0);
  }, null, { timeout: 30_000 });

  // A visible attack command is necessary but not sufficient. Require the live
  // unpaused match to produce real gameplay consequences under LinuxDOOM rules:
  // at least one damaged player or a non-zero frag count.
  await ai.waitForFunction(() => {
    const status = window.DoomLocalBots?.status?.();
    const players = status?.players?.players;
    return Array.isArray(players) && players.some(row => Number(row.health) < 100 || Number(row.frags) !== 0);
  }, null, { timeout: 30_000 });

  const aiState = await ai.evaluate(() => {
    const status = window.DoomLocalBots.status();
    return {
      launcher: window.DoomPublicLauncher,
      capacity: Module.ccall('doomctl_get_local_player_capacity', 'number', [], []),
      humanOverride: JSON.parse(Module.ccall('doomctl_get_player_input_status_json', 'string', ['number'], [0])),
      status
    };
  });

  assert.equal(aiState.capacity, 4, JSON.stringify(aiState));
  assert.deepEqual(aiState.launcher.bots, ['easy', 'normal', 'hard']);
  assert.equal(aiState.launcher.demoWad, 'p22-demo.wad');
  assert.equal(Boolean(aiState.humanOverride.active), false, JSON.stringify(aiState.humanOverride));
  assert.deepEqual(aiState.status.botPlayers.map(row => row.skill), ['easy', 'normal', 'hard']);
  assert.ok(aiState.status.decisions.slice(1, 4).every(value => Number(value) > 0), JSON.stringify(aiState.status));
  assert.ok(aiState.status.visibleDecisions.slice(1, 4).every(value => Number(value) > 0), JSON.stringify(aiState.status));
  assert.ok(aiState.status.attacks.slice(1, 4).every(value => Number(value) > 0), JSON.stringify(aiState.status));
  assert.ok(aiState.status.players.players.length >= 4, JSON.stringify(aiState.status.players));
  assert.ok(aiState.status.players.players.some(row => Number(row.health) < 100 || Number(row.frags) !== 0), JSON.stringify(aiState.status.players));

  console.error('P2.2 public /direct/ launcher acceptance passed:', JSON.stringify({
    classic: { capacity: classicState.capacity, mode: classicState.launcher.mode },
    ai: {
      capacity: aiState.capacity,
      mode: aiState.launcher.mode,
      demoWad: aiState.launcher.demoWad,
      botSkills: aiState.status.botPlayers.map(row => row.skill),
      decisions: aiState.status.decisions,
      visibleDecisions: aiState.status.visibleDecisions,
      attacks: aiState.status.attacks,
      players: aiState.status.players.players.map(row => ({ player: row.player, health: row.health, frags: row.frags, x: row.x, y: row.y }))
    }
  }));
  await ai.close();
} catch (error) {
  console.error('P2.2 public /direct/ launcher acceptance failed:', error);
  console.error('Diagnostics:', diagnostics.slice(-80));
  throw error;
} finally {
  await browser.close();
}
