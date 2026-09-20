// Runtime self-test for the agent weapon-change input (doomctl_queue_agent_weapon).
//
//   node autoplay_weapon_selftest.mjs [--map E1M1]
//
// Boots the level paused, then asks for a weapon the player always owns (the
// fists) and steps the world: the ready weapon must change. Proves the
// BT_CHANGE path end to end (bridge -> engine -> P_PlayerThink) without
// depending on a level's pickups. Exits non-zero when the switch does not
// happen, so CI can run it.

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { coldBoot, exactInput, launchChromium } from './navigation_browser_agent.mjs';
import { prepareStagePwad } from './autoplay_stage_runner.mjs';

const { values } = parseArgs({ options: { map: { type: 'string', default: 'E1M1' } } });
const map = String(values.map).toUpperCase();
const playUrl = `http://127.0.0.1:${Number(process.env.DOOM_MCP_PORT || 3777)}/`;

const { startBridge } = await import('./server.js');
const bridge = startBridge();
const browser = await launchChromium({});
const results = [];
try {
  const stage = await prepareStagePwad({ map });
  const wadBase64 = (await readFile(stage.wadPath)).toString('base64');
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await coldBoot(page, { playUrl, filename: stage.filename, map, pauseOnReady: true }, wadBase64);
  const weaponOf = async () => Number((await page.evaluate(() => window.DoomControl.getState()))?.player?.weapon);

  const start = await weaponOf();
  results.push({ step: 'start', weapon: start });
  if (start !== 1) throw new Error(`expected the pistol (1) at level start, got ${start}`);

  // Fists: owned by every player and needing no ammo, so only the input path
  // can explain a change.
  await exactInput(page, { forward: 0, tics: 2, weapon: 0 });
  for (let i = 0; i < 4; i++) await exactInput(page, { forward: 0, tics: 10 }); // lower+raise is ~32 tics
  const afterFist = await weaponOf();
  results.push({ step: 'request fists', weapon: afterFist, ok: afterFist === 0 });

  await exactInput(page, { forward: 0, tics: 2, weapon: 1 });
  for (let i = 0; i < 4; i++) await exactInput(page, { forward: 0, tics: 10 });
  const afterPistol = await weaponOf();
  results.push({ step: 'request pistol', weapon: afterPistol, ok: afterPistol === 1 });

  // A weapon the player does not own must be ignored, not crash or switch.
  await exactInput(page, { forward: 0, tics: 2, weapon: 6 });
  for (let i = 0; i < 4; i++) await exactInput(page, { forward: 0, tics: 10 });
  const afterBfg = await weaponOf();
  results.push({ step: 'request BFG (not owned)', weapon: afterBfg, ok: afterBfg === 1 });

  const passed = results.filter(r => r.ok !== undefined).every(r => r.ok);
  console.log(`weapon selftest ${passed ? 'PASSED' : 'FAILED'}: ${JSON.stringify(results)}`);
  process.exitCode = passed ? 0 : 1;
} catch (error) {
  console.error(`weapon selftest ERROR: ${error?.stack || error}`);
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  bridge.close();
  process.exit();
}
