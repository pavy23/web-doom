// Browser-launch compatibility for old single-button shells, the generated
// P2.2 dual-mode launcher, and the temporary public wrapper shell. Generic
// P0/P1/P2 QA is single-player, so every public variant intentionally chooses
// PLAY CLASSIC DOOM while preserving top-level Module/DoomControl access.

function runtimeGameUrl(currentUrl) {
  const url = new URL(currentUrl);
  url.pathname = url.pathname.replace(/[^/]*$/, 'game.html');
  url.search = '';
  url.hash = '';
  return url.href;
}

async function waitForLauncherShape(page, timeout) {
  await page.waitForFunction(() => Boolean(
    (document.getElementById('classic') && document.getElementById('game'))
      || document.getElementById('playClassic')
      || document.getElementById('start')
  ), null, { timeout });
}

// Enter the actual runtime shell without clicking PLAY. This is needed by cold-
// boot authoring tests that must call DoomControl.geometryLoad before main().
export async function enterClassicRuntimeShell(page, timeout = 60000) {
  await waitForLauncherShape(page, timeout);
  const wrapper = await page.evaluate(() => Boolean(
    document.getElementById('classic') && document.getElementById('game')
  ));
  if (wrapper) {
    await page.goto(runtimeGameUrl(page.url()), { waitUntil: 'domcontentloaded', timeout });
  }
  return wrapper;
}

export async function waitForClassicLaunchReady(page, timeout = 60000) {
  await page.waitForFunction(() => {
    const classic = document.getElementById('playClassic');
    if (classic) return classic.disabled === false;
    const legacy = document.getElementById('start');
    return Boolean(legacy?.classList?.contains('ready')) && legacy.disabled === false;
  }, null, { timeout });
}

export async function clickClassicLaunch(page, timeout = 60000) {
  const wrapper = await enterClassicRuntimeShell(page, timeout);
  await waitForClassicLaunchReady(page, timeout);

  const selector = await page.evaluate(() => {
    if (document.getElementById('playClassic')) return '#playClassic';
    return '#start';
  });
  await page.click(selector);
  return wrapper ? `game.html -> ${selector}` : selector;
}

export async function launcherSnapshot(page) {
  return page.evaluate(() => ({
    wrapperLauncher: Boolean(document.getElementById('classic') && document.getElementById('game')),
    dualLauncher: Boolean(document.getElementById('playClassic')),
    classicReady: Boolean(document.getElementById('playClassic')) && document.getElementById('playClassic').disabled === false,
    aiReady: Boolean(document.getElementById('playAi')) && document.getElementById('playAi').disabled === false,
    legacyReady: Boolean(document.querySelector('#start.ready:not([disabled])')),
    status: document.getElementById('status')?.textContent || null
  }));
}
