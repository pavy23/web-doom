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

export async function waitForClassicLaunchReady(page, timeout = 60000) {
  await page.waitForFunction(() => {
    // Temporary deployed P2.2 wrapper. Its #classic button launches an iframe,
    // but legacy QA requires Module/DoomControl on the top-level page. The click
    // helper below therefore navigates directly to game.html instead.
    if (document.getElementById('classic') && document.getElementById('game')) return true;

    const classic = document.getElementById('playClassic');
    if (classic) return classic.disabled === false;
    const legacy = document.getElementById('start');
    return Boolean(legacy?.classList?.contains('ready')) && legacy.disabled === false;
  }, null, { timeout });
}

export async function clickClassicLaunch(page, timeout = 60000) {
  await waitForClassicLaunchReady(page, timeout);

  const wrapper = await page.evaluate(() => Boolean(
    document.getElementById('classic') && document.getElementById('game')
  ));
  if (wrapper) {
    await page.goto(runtimeGameUrl(page.url()), { waitUntil: 'domcontentloaded', timeout });
    await waitForClassicLaunchReady(page, timeout);
  }

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
