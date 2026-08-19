import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { GeometryWorkspace } from './geometry.js';
import { EpisodeWorkspace } from './episode_workspace.js';
import { installFullTopologyValidator } from './topology_validator.js';
import { installThingAuthoring } from './thing_authoring.js';
import { installSemanticGeometry } from './semantic_geometry.js';
import { installAutoRepair } from './auto_repair.js';
import { markWorkspaceAsGenerated } from './blank_map.js';
import { createBalancedDeathmatchArenaPwad } from './deathmatch_factory.js';
import { humanBotLaunchUrl } from './p2_human_bot_server.js';

installFullTopologyValidator(GeometryWorkspace);
installThingAuthoring(GeometryWorkspace);
installSemanticGeometry(GeometryWorkspace);
installAutoRepair(GeometryWorkspace);

function markGenerated(episode) {
  for (const workspace of episode.workspaces.values()) markWorkspaceAsGenerated(workspace);
  for (const workspace of episode.baselines.values()) markWorkspaceAsGenerated(workspace);
  return episode;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const exportDir = path.resolve(process.env.DOOM_MCP_EXPORT_DIR || path.join(here, 'exports'));
await mkdir(exportDir, { recursive: true });

const generated = createBalancedDeathmatchArenaPwad({ map: 'E1M1', outerRadius: 640, innerRadius: 224 });
const episode = markGenerated(new EpisodeWorkspace(generated.bytes, ['E1M1'], 'p2.2-live-human-bots'));
assert.equal(episode.validate().ok, true);
const candidate = await episode.build({ filename: 'p2-human-three-bots.wad' });
const filename = 'p2-human-three-bots.wad';
await writeFile(path.join(exportDir, filename), candidate.bytes);

const { startBridge } = await import('./server.js');
const bridge = startBridge();
const launchUrl = humanBotLaunchUrl({
  filename,
  map: 'E1M1',
  botSkills: ['easy', 'hard', 'nightmare'],
  port: Number(process.env.DOOM_MCP_PORT || 3777)
});

let browser;
try {
  browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const diagnostics = [];
  page.on('pageerror', error => diagnostics.push(`pageerror:${error?.message || error}`));
  page.on('console', message => { if (message.type() === 'error') diagnostics.push(`console:${message.text()}`); });

  await page.goto(launchUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(expected => window.DoomColdBoot?.prepared === true
    && window.DoomColdBoot?.candidate === expected
    && typeof window.DoomLocalBots?.status === 'function', filename, { timeout: 180000 });
  await page.waitForSelector('#start.ready:not([disabled])', { timeout: 30000 });

  const preStart = await page.evaluate(() => window.DoomLocalBots.status());
  assert.equal(preStart.enabled, true, JSON.stringify(preStart));
  assert.deepEqual(preStart.botPlayers.map(row => row.skill), ['easy', 'hard', 'nightmare']);

  await page.click('#start');
  await page.waitForFunction(() => {
    try {
      const bots = window.DoomLocalBots?.status?.();
      return bots?.running === true && bots?.players?.ready === true && bots.players.players?.length === 4;
    } catch { return false; }
  }, null, { timeout: 30000 });

  const initial = await page.evaluate(() => ({
    bots: window.DoomLocalBots.status(),
    humanInput: JSON.parse(Module.ccall('doomctl_get_player_input_status_json', 'string', ['number'], [0]))
  }));
  assert.equal(initial.humanInput.active, false, JSON.stringify(initial));
  assert.equal(initial.bots.players.players.length, 4, JSON.stringify(initial));

  // Simulate a real Player 1 keyboard input while the live scheduler controls
  // only slots 1..3. This proves the human input path is not replaced by bots.
  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(700);
  await page.keyboard.up('ArrowUp');
  await page.waitForTimeout(3500);

  const final = await page.evaluate(() => ({
    bots: window.DoomLocalBots.status(),
    humanInput: JSON.parse(Module.ccall('doomctl_get_player_input_status_json', 'string', ['number'], [0]))
  }));
  assert.equal(final.humanInput.active, false, JSON.stringify(final));
  assert.equal(final.bots.players.players.length, 4, JSON.stringify(final));
  for (const player of [1, 2, 3]) assert.ok(Number(final.bots.decisions[player]) > 0, JSON.stringify(final.bots));
  assert.equal(Number(final.bots.decisions[0]), 0, JSON.stringify(final.bots));
  assert.equal(final.bots.lastError, null, JSON.stringify({ final, diagnostics }));

  console.error('P2.2 interactive Player1 + three live bots browser acceptance passed:', JSON.stringify({
    launchUrl,
    botPlayers: final.bots.botPlayers,
    decisions: final.bots.decisions,
    attacks: final.bots.attacks,
    players: final.bots.players.players.map(row => ({ player: row.player, x: row.x, y: row.y, health: row.health, frags: row.frags })),
    humanInputOverrideActive: final.humanInput.active,
    diagnostics
  }));
} finally {
  if (browser) await browser.close();
  if (bridge?.close) await bridge.close();
}
