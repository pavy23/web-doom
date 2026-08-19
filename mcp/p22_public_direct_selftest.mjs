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
      && document.getElementById('start')?.disabled === false
      && document.getElementById('start')?.classList?.contains('ready')
      && document.getElementById('playAi')?.disabled === false;
  }, null, { timeout: 120_000 });
}

async function waitAiReady(page) {
  await page.waitForFunction(() => {
    const status = window.DoomLocalBots?.status?.();
    return window.DoomPublicLauncher?.mode === 'ai'
      && status?.running
      && status?.players?.ready
      && Array.isArray(status.players.players)
      && status.players.players.length >= 4
      && status?.match?.phase !== 'idle';
  }, null, { timeout: 60_000 });
}

async function setNightmareBots(page) {
  await page.evaluate(() => {
    window.DoomLocalBots.setSkill(1, 'nightmare');
    window.DoomLocalBots.setSkill(2, 'nightmare');
    window.DoomLocalBots.setSkill(3, 'nightmare');
  });
}

try {
  const classic = await browser.newPage();
  attachDiagnostics(classic, 'classic');
  await classic.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await waitRuntime(classic);
  assert.equal(await classic.locator('#start').textContent(), 'PLAY CLASSIC DOOM');
  assert.equal(await classic.locator('#playAi').textContent(), 'PLAY AI DEATHMATCH');
  await classic.locator('#start').click();
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

  // Time-limit ties must not pick an arbitrary winner. Force a one-second
  // regulation window with an unreachable frag limit, then verify the public
  // controller enters sudden death while the match remains live. The engine
  // state and HUD update on separate timers, so wait for both explicitly.
  const sudden = await browser.newPage();
  attachDiagnostics(sudden, 'sudden');
  await sudden.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await waitRuntime(sudden);
  await sudden.evaluate(() => window.DoomLocalBots.configureMatch({ fragLimit: 99, timeLimitSeconds: 1 }));
  await sudden.locator('#playAi').click();
  await waitAiReady(sudden);
  await sudden.waitForFunction(() => window.DoomLocalBots?.status?.().match?.phase === 'sudden_death', null, { timeout: 15_000 });
  await sudden.waitForFunction(() => /SUDDEN DEATH/.test(String(document.getElementById('matchRule')?.textContent || '')), null, { timeout: 5_000 });
  const suddenState = await sudden.evaluate(() => ({
    match: window.DoomLocalBots.status().match,
    rule: document.getElementById('matchRule')?.textContent,
    endVisible: document.getElementById('matchEnd')?.classList.contains('visible')
  }));
  assert.equal(suddenState.match.phase, 'sudden_death');
  assert.match(String(suddenState.rule), /SUDDEN DEATH/);
  assert.equal(Boolean(suddenState.endVisible), false);
  await sudden.close();

  // Respawn presentation acceptance: keep the match alive, let nightmare bots
  // produce a real frag, catch the dead player while PST_DEAD is observable,
  // then verify that the slot remains down for roughly the engine-enforced
  // 45-tic window before returning to PST_LIVE. RAF sampling may observe the
  // death a couple of tics after the exact transition, so >=42 is the runtime
  // lower bound while the compiled bridge itself is pinned to 45.
  const respawn = await browser.newPage();
  attachDiagnostics(respawn, 'respawn');
  await respawn.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await waitRuntime(respawn);
  await respawn.evaluate(() => window.DoomLocalBots.configureMatch({ fragLimit: 99, timeLimitSeconds: 120 }));
  await respawn.locator('#playAi').click();
  await waitAiReady(respawn);
  await setNightmareBots(respawn);
  await respawn.waitForFunction(() => {
    const status = window.DoomLocalBots?.status?.();
    return Array.isArray(status?.attacks) && status.attacks.slice(1, 4).every(value => Number(value) > 0);
  }, null, { timeout: 30_000 });
  await respawn.waitForFunction(() => {
    const players = window.DoomLocalBots?.status?.().players?.players;
    return Array.isArray(players) && players.some(row => Number(row.state) === 1 && !Boolean(row.live));
  }, null, { timeout: 90_000, polling: 'raf' });
  const deathSample = await respawn.evaluate(() => {
    const state = window.DoomLocalBots.status().players;
    const victim = state.players.find(row => Number(row.state) === 1 && !Boolean(row.live));
    return { player: Number(victim.player), gametic: Number(state.gametic), health: Number(victim.health), frags: Number(victim.frags) };
  });
  await respawn.waitForFunction(player => {
    const state = window.DoomLocalBots?.status?.().players;
    const victim = state?.players?.find(row => Number(row.player) === Number(player));
    return Boolean(victim?.live);
  }, deathSample.player, { timeout: 10_000, polling: 'raf' });
  const reviveSample = await respawn.evaluate(player => {
    const state = window.DoomLocalBots.status().players;
    const victim = state.players.find(row => Number(row.player) === Number(player));
    return { player: Number(player), gametic: Number(state.gametic), health: Number(victim.health), live: Boolean(victim.live) };
  }, deathSample.player);
  const observedDeadTics = reviveSample.gametic - deathSample.gametic;
  assert.ok(observedDeadTics >= 42, JSON.stringify({ deathSample, reviveSample, observedDeadTics }));
  assert.equal(reviveSample.live, true);
  assert.ok(reviveSample.health > 0, JSON.stringify(reviveSample));
  await respawn.close();

  const ai = await browser.newPage();
  attachDiagnostics(ai, 'ai');
  await ai.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await waitRuntime(ai);

  const wadResponse = await ai.request.get(new URL('p22-demo.wad', baseUrl).href);
  assert.equal(wadResponse.ok(), true);
  const wadBytes = await wadResponse.body();
  assert.equal(wadBytes.subarray(0, 4).toString('ascii'), 'PWAD');

  // A one-frag test match exercises the real winner/freeze/result flow without
  // making CI play a full public first-to-ten round.
  await ai.evaluate(() => window.DoomLocalBots.configureMatch({ fragLimit: 1, timeLimitSeconds: 120 }));
  await ai.locator('#playAi').click();
  await waitAiReady(ai);

  // Speed up the acceptance fight while preserving Player 1 as human-only.
  await setNightmareBots(ai);

  await ai.waitForFunction(() => {
    const status = window.DoomLocalBots?.status?.();
    return Array.isArray(status?.decisions)
      && status.decisions.slice(1, 4).every(value => Number(value) > 0);
  }, null, { timeout: 30_000 });

  await ai.waitForFunction(() => {
    const status = window.DoomLocalBots?.status?.();
    return Array.isArray(status?.visibleDecisions)
      && Array.isArray(status?.attacks)
      && status.visibleDecisions.slice(1, 4).every(value => Number(value) > 0)
      && status.attacks.slice(1, 4).every(value => Number(value) > 0);
  }, null, { timeout: 30_000 });

  await ai.waitForFunction(() => {
    const status = window.DoomLocalBots?.status?.();
    const players = status?.players?.players;
    return Array.isArray(players) && players.some(row => Number(row.health) < 100 || Number(row.frags) !== 0);
  }, null, { timeout: 30_000 });

  await ai.waitForFunction(() => window.DoomLocalBots?.status?.().match?.phase === 'finished', null, { timeout: 90_000 });
  await ai.waitForFunction(() => document.getElementById('matchEnd')?.classList.contains('visible'), null, { timeout: 5_000 });

  const aiState = await ai.evaluate(() => {
    const status = window.DoomLocalBots.status();
    return {
      launcher: window.DoomPublicLauncher,
      capacity: Module.ccall('doomctl_get_local_player_capacity', 'number', [], []),
      humanOverride: JSON.parse(Module.ccall('doomctl_get_player_input_status_json', 'string', ['number'], [0])),
      status,
      resultUi: {
        winner: document.getElementById('matchWinner')?.textContent,
        reason: document.getElementById('matchEndReason')?.textContent,
        rematch: document.getElementById('matchRematch')?.textContent,
        classic: document.getElementById('matchClassic')?.textContent
      }
    };
  });

  assert.equal(aiState.capacity, 4, JSON.stringify(aiState));
  assert.equal(aiState.launcher.demoWad, 'p22-demo.wad');
  assert.equal(Boolean(aiState.humanOverride.active), false, JSON.stringify(aiState.humanOverride));
  assert.deepEqual(aiState.status.botPlayers.map(row => row.skill), ['nightmare', 'nightmare', 'nightmare']);
  assert.ok(aiState.status.decisions.slice(1, 4).every(value => Number(value) > 0), JSON.stringify(aiState.status));
  assert.ok(aiState.status.visibleDecisions.slice(1, 4).every(value => Number(value) > 0), JSON.stringify(aiState.status));
  assert.ok(aiState.status.attacks.slice(1, 4).every(value => Number(value) > 0), JSON.stringify(aiState.status));
  assert.ok(aiState.status.players.players.length >= 4, JSON.stringify(aiState.status.players));
  assert.equal(aiState.status.match.phase, 'finished', JSON.stringify(aiState.status.match));
  assert.equal(aiState.status.match.reason, 'frag_limit', JSON.stringify(aiState.status.match));
  assert.ok(Number.isInteger(aiState.status.match.winner), JSON.stringify(aiState.status.match));
  assert.match(String(aiState.resultUi.winner), /^PLAYER [1-4] WINS$/);
  assert.equal(aiState.resultUi.reason, '1 FRAGS');
  assert.equal(aiState.resultUi.rematch, 'REMATCH');
  assert.equal(aiState.resultUi.classic, 'PLAY CLASSIC DOOM');

  // REMATCH intentionally reloads the whole WASM runtime, giving the new round
  // clean health/frags/tics, then auto-enters AI mode from sessionStorage.
  await ai.locator('#matchRematch').click();
  await ai.waitForLoadState('domcontentloaded', { timeout: 120_000 });
  await ai.waitForFunction(() => window.DoomPublicLauncher?.mode === 'ai', null, { timeout: 120_000 });
  await waitAiReady(ai);
  const rematchState = await ai.evaluate(() => ({
    launcher: window.DoomPublicLauncher,
    status: window.DoomLocalBots.status()
  }));
  assert.equal(rematchState.launcher.mode, 'ai');
  assert.equal(rematchState.status.match.phase, 'running');
  assert.deepEqual(rematchState.status.match.scores, [0, 0, 0, 0]);

  console.error('P2.2 public /direct/ launcher + match-rules acceptance passed:', JSON.stringify({
    classic: { capacity: classicState.capacity, mode: classicState.launcher.mode },
    suddenDeath: suddenState.match,
    respawn: { deathSample, reviveSample, observedDeadTics },
    ai: {
      capacity: aiState.capacity,
      winner: aiState.status.match.winner,
      reason: aiState.status.match.reason,
      finalScores: aiState.status.match.scores,
      botSkills: aiState.status.botPlayers.map(row => row.skill),
      decisions: aiState.status.decisions,
      visibleDecisions: aiState.status.visibleDecisions,
      attacks: aiState.status.attacks
    },
    rematch: {
      mode: rematchState.launcher.mode,
      phase: rematchState.status.match.phase,
      scores: rematchState.status.match.scores
    }
  }));
  await ai.close();
} catch (error) {
  console.error('P2.2 public /direct/ launcher acceptance failed:', error);
  console.error('Diagnostics:', diagnostics.slice(-120));
  throw error;
} finally {
  await browser.close();
}