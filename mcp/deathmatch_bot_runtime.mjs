import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

import { resolveBotSkill } from './deathmatch_design.js';

const DEFAULT_PLAY_URL = 'http://127.0.0.1:3777/';

function clamp(value, min = -1, max = 1) { return Math.max(min, Math.min(max, Number(value))); }
function distance(a, b) { return Math.hypot(Number(b.x) - Number(a.x), Number(b.y) - Number(a.y)); }
function mapWarpArgs(mapName) {
  const match = /^(?:E([1-9])M([1-9])|MAP(\d\d))$/i.exec(String(mapName || 'E1M1'));
  if (!match) throw new Error(`Unsupported map name ${mapName}`);
  if (match[1]) return ['-warp', String(Number(match[1])), String(Number(match[2]))];
  return ['-warp', String(Number(match[3]))];
}
async function launchBrowser() {
  const args = ['--autoplay-policy=no-user-gesture-required'];
  try { return await chromium.launch({ headless: true, args }); }
  catch (first) {
    try { return await chromium.launch({ headless: true, channel: 'chrome', args }); }
    catch { throw first; }
  }
}
async function waitForRuntime(page, timeout = 120000) {
  await page.waitForFunction(() => typeof Module !== 'undefined'
    && typeof Module.ccall === 'function'
    && typeof window.DoomControl?.geometryLoad === 'function'
    && typeof window.DoomControl?.setPlaytestPaused === 'function'
    && typeof window.DoomControl?.stepPlaytestTics === 'function', null, { timeout });
}
async function readPlayers(page) {
  return page.evaluate(() => JSON.parse(Module.ccall('doomctl_get_players_json', 'string', [], [])));
}
async function readPerceptions(page, players) {
  return page.evaluate(ids => ids.map(player => JSON.parse(Module.ccall(
    'doomctl_get_player_perception_json', 'string', ['number'], [player]
  ))), players);
}
async function queueCommands(page, commands) {
  return page.evaluate(rows => rows.map(row => ({
    player: row.player,
    result: Module.ccall('doomctl_queue_player_input', 'number',
      ['number', 'number', 'number', 'number', 'number', 'number', 'number'],
      [row.player, row.forward, row.strafe, row.turn, row.attack ? 1 : 0, row.use ? 1 : 0, row.tics])
  })), commands);
}
async function localBootSnapshot(page, expectedPlayers, bootArgs) {
  return page.evaluate(({ expected, args }) => {
    let capacity = null;
    let capacityError = null;
    let players = null;
    let playersRaw = null;
    let playersError = null;
    let doomState = null;
    let doomStateError = null;
    try { capacity = Module.ccall('doomctl_get_local_player_capacity', 'number', [], []); }
    catch (error) { capacityError = String(error?.message || error); }
    try {
      playersRaw = Module.ccall('doomctl_get_players_json', 'string', [], []);
      players = JSON.parse(playersRaw);
    } catch (error) { playersError = String(error?.message || error); }
    try { doomState = window.DoomControl?.getState?.() || null; }
    catch (error) { doomStateError = String(error?.message || error); }
    return {
      expectedPlayers: expected,
      requestedBootArgs: args,
      url: location.href,
      status: document.getElementById('status')?.textContent || null,
      startDisabled: Boolean(document.getElementById('start')?.disabled),
      runtimeReady: typeof Module !== 'undefined' && typeof Module.ccall === 'function',
      moduleCallMainPresent: typeof Module?.callMain === 'function',
      capacity,
      capacityError,
      players,
      playersRaw,
      playersError,
      doomState,
      doomStateError,
      coldBoot: window.DoomColdBoot ? {
        candidate: window.DoomColdBoot.candidate || null,
        prepared: Boolean(window.DoomColdBoot.prepared),
        bytes: Number(window.DoomColdBoot.bytes || 0),
        virtualPath: window.DoomColdBoot.virtualPath || null
      } : null
    };
  }, { expected: expectedPlayers, args: bootArgs });
}
function attackGate(skill, worldTic, player) {
  const period = Math.max(2, Math.round(12 - skill.aggression * 9));
  return ((Math.floor(worldTic / Math.max(1, skill.reactionTics)) + player * 3) % period) <= Math.max(0, Math.round(skill.aggression * 2));
}
function commandFor(perception, skill, worldTic) {
  const player = Number(perception.player);
  const tics = Math.max(1, Math.min(35, Number(skill.reactionTics)));
  if (!perception.live) return { player, forward: 0, strafe: 0, turn: 0, attack: true, use: true, tics };
  if (!perception.target) {
    const sign = ((Math.floor(worldTic / 40) + player) % 2) ? 1 : -1;
    return { player, forward: Math.round(skill.forward * 55), strafe: Math.round(sign * skill.strafe * 25), turn: Math.round(sign * 18), attack: false, use: false, tics };
  }

  const delta = Number(perception.angleDelta || 0);
  const absDelta = Math.abs(delta);
  const turn = Math.round(clamp(-(delta / 75) * skill.turnGain) * 100);
  const aligned = absDelta <= Number(skill.aimToleranceDeg);
  const visible = Boolean(perception.visible);
  const close = Number(perception.distance || 9999) < 160;
  const forwardScale = absDelta < 65 ? skill.forward : 0.15;
  const dodgeSign = ((Math.floor(worldTic / 28) + player) % 2) ? 1 : -1;
  const strafeScale = visible ? skill.strafe * skill.dodge : skill.strafe * 0.25;
  const attack = visible && (aligned || (close && absDelta <= skill.aimToleranceDeg * 2.2)) && attackGate(skill, worldTic, player);

  return {
    player,
    forward: Math.round(forwardScale * 100),
    strafe: Math.round(dodgeSign * strafeScale * 100),
    turn,
    attack,
    use: false,
    tics
  };
}
async function coldBootArena(page, { playUrl, filename, wadBase64, map, localPlayers }) {
  await page.goto(playUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await waitForRuntime(page);
  const nav = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 120000 });
  const staged = await page.evaluate(({ filename: name, base64 }) => window.DoomControl.geometryLoad(name, base64), { filename, base64: wadBase64 });
  if (!staged?.scheduled) throw new Error(`Bot arena cold-boot staging failed: ${JSON.stringify(staged)}`);
  await nav;
  await waitForRuntime(page);
  await page.waitForFunction(expected => window.DoomColdBoot?.prepared === true && window.DoomColdBoot?.candidate === expected, filename, { timeout: 180000 });
  await page.waitForSelector('#start.ready:not([disabled])', { timeout: 30000 });

  const args = ['-deathmatch', ...mapWarpArgs(map), '-localplayers', String(localPlayers)];
  await page.evaluate(bootArgs => {
    const original = Module.callMain.bind(Module);
    Module.callMain = () => original(bootArgs);
    window.DoomP22RequestedBootArgs = [...bootArgs];
  }, args);
  await page.click('#start');
  try {
    await page.waitForFunction(expectedPlayers => {
      try {
        const state = JSON.parse(Module.ccall('doomctl_get_players_json', 'string', [], []));
        return state.ready === true && Array.isArray(state.players) && state.players.length === expectedPlayers;
      } catch { return false; }
    }, localPlayers, { timeout: 10000 });
  } catch (error) {
    const snapshot = await localBootSnapshot(page, localPlayers, args).catch(snapshotError => ({ snapshotError: String(snapshotError?.message || snapshotError) }));
    throw new Error(`P2.2 local-player startup did not reach ${localPlayers} ready players: ${JSON.stringify(snapshot)}; ${error?.message || error}`);
  }
  const capacity = await page.evaluate(() => Module.ccall('doomctl_get_local_player_capacity', 'number', [], []));
  if (Number(capacity) !== Number(localPlayers)) {
    const snapshot = await localBootSnapshot(page, localPlayers, args);
    throw new Error(`Expected ${localPlayers} local players, runtime reported ${capacity}: ${JSON.stringify(snapshot)}`);
  }
  await page.evaluate(() => window.DoomControl.setPlaytestPaused(true));
  await page.evaluate(() => window.DoomControl.cancelAgentInput());
  await page.evaluate(() => window.DoomControl.resetPlaytestMetrics());
  return readPlayers(page);
}

export async function runLocalBotDeathmatch(input) {
  const config = {
    playUrl: DEFAULT_PLAY_URL,
    map: 'E1M1',
    localPlayers: 4,
    totalTics: 700,
    botSkills: ['normal', 'normal', 'normal', 'normal'],
    controlPlayers: [0, 1, 2, 3],
    captureFrame: true,
    ...input
  };
  if (!config.wadPath || !config.filename || !config.reportDir) throw new Error('wadPath, filename and reportDir are required');
  if (config.localPlayers < 2 || config.localPlayers > 4) throw new Error('localPlayers must be 2..4 for a deathmatch bot trial');
  const controlPlayers = [...new Set((config.controlPlayers || []).map(Number))].filter(player => player >= 0 && player < config.localPlayers);
  const skills = Array.from({ length: config.localPlayers }, (_, player) => resolveBotSkill(config.botSkills[player] || 'normal'));
  const wadBase64 = (await readFile(config.wadPath)).toString('base64');
  await mkdir(config.reportDir, { recursive: true });

  const report = {
    version: '2.8.0-p2.2', map: config.map, localPlayers: config.localPlayers,
    botSkills: skills.map(skill => skill.name), controlPlayers,
    requestedTics: Number(config.totalTics), startedAt: new Date().toISOString(),
    passed: false, decisions: Object.fromEntries(controlPlayers.map(player => [player, 0])),
    attacks: Object.fromEntries(controlPlayers.map(player => [player, 0])), diagnostics: []
  };
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', error => report.diagnostics.push({ type: 'pageerror', message: String(error?.message || error) }));
  page.on('console', msg => { if (msg.type() === 'error') report.diagnostics.push({ type: 'console', message: msg.text() }); });

  let fatal = null;
  try {
    const initial = await coldBootArena(page, { ...config, wadBase64 });
    report.initial = initial;
    const initialByPlayer = new Map(initial.players.map(row => [Number(row.player), { ...row }]));
    const lastPositions = new Map(initial.players.map(row => [Number(row.player), { x: row.x, y: row.y }]));
    const travel = Object.fromEntries(initial.players.map(row => [Number(row.player), 0]));
    let advanced = 0;
    let damageObserved = false;
    let fragObserved = false;

    while (advanced < Number(config.totalTics)) {
      const state = await readPlayers(page);
      const stateByPlayer = new Map(state.players.map(row => [Number(row.player), row]));
      for (const row of state.players) {
        const id = Number(row.player);
        const last = lastPositions.get(id);
        if (last) travel[id] += distance(last, row);
        lastPositions.set(id, { x: row.x, y: row.y });
        const original = initialByPlayer.get(id);
        if (original && Number(row.health) < Number(original.health)) damageObserved = true;
        if (Number(row.frags) !== Number(original?.frags || 0)) fragObserved = true;
      }

      const due = controlPlayers.filter(player => Number(stateByPlayer.get(player)?.inputRemaining || 0) <= 0);
      if (due.length) {
        const perceptions = await readPerceptions(page, due);
        const commands = perceptions.map(perception => commandFor(perception, skills[Number(perception.player)], advanced));
        const queued = await queueCommands(page, commands);
        for (let i = 0; i < commands.length; i++) {
          if (Number(queued[i]?.result) < 1) throw new Error(`Player ${commands[i].player} input queue failed: ${JSON.stringify(queued[i])}`);
          report.decisions[commands[i].player]++;
          if (commands[i].attack) report.attacks[commands[i].player]++;
        }
      }

      const remaining = Math.max(1, Math.min(4, Number(config.totalTics) - advanced));
      const before = await page.evaluate(() => window.DoomControl.getPlaytestTelemetry());
      await page.evaluate(count => window.DoomControl.stepPlaytestTics(count), remaining);
      const target = Number(before.worldTics || 0) + remaining;
      await page.waitForFunction(targetTics => Number(window.DoomControl.getPlaytestTelemetry()?.worldTics || 0) >= targetTics, target, { timeout: 10000 });
      advanced += remaining;
    }

    const final = await readPlayers(page);
    report.final = final;
    report.advancedTics = advanced;
    report.travelDistance = Object.fromEntries(Object.entries(travel).map(([player, value]) => [player, Math.round(value)]));
    report.damageObserved = damageObserved || final.players.some(row => Number(row.health) < 100);
    report.fragObserved = fragObserved || final.players.some(row => Number(row.frags) !== 0);
    report.totalAttacks = Object.values(report.attacks).reduce((sum, value) => sum + value, 0);
    report.allPlayersMoved = final.players.every(row => Number(report.travelDistance[row.player] || 0) > 40);
    report.passed = final.players.length === config.localPlayers
      && report.allPlayersMoved
      && report.totalAttacks >= 4
      && (report.damageObserved || report.fragObserved);
    if (!report.passed) report.failure = 'local_bot_match_acceptance_failed';

    if (config.captureFrame !== false) {
      const frame = await page.evaluate(() => window.DoomControl.captureFrame());
      if (frame?.base64) {
        const screenshot = path.join(config.reportDir, `${config.map}-local-bots.png`);
        await writeFile(screenshot, Buffer.from(frame.base64, 'base64'));
        report.screenshot = screenshot;
      }
    }
  } catch (error) {
    fatal = error;
    report.failure = 'bot_runtime_error';
    report.error = String(error?.stack || error?.message || error);
    try { report.browserSnapshot = await localBootSnapshot(page, config.localPlayers, ['-deathmatch', ...mapWarpArgs(config.map), '-localplayers', String(config.localPlayers)]); }
    catch (snapshotError) { report.browserSnapshot = { error: String(snapshotError?.message || snapshotError) }; }
  } finally {
    await browser.close();
  }
  report.completedAt = new Date().toISOString();
  report.reportPath = path.join(config.reportDir, 'report.json');
  await writeFile(report.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (fatal) {
    const wrapped = new Error(`${fatal?.message || fatal} (bot report: ${report.reportPath})`);
    wrapped.cause = fatal;
    throw wrapped;
  }
  return report;
}
