// Browser-launch compatibility for old single-button shells and the public
// P2.2 dual-mode launcher. Generic P0/P1/P2 QA is single-player, so when the
// public launcher is present it intentionally chooses PLAY CLASSIC DOOM.

export async function waitForClassicLaunchReady(page, timeout = 60000) {
  await page.waitForFunction(() => {
    const classic = document.getElementById('playClassic');
    if (classic) return classic.disabled === false;
    const legacy = document.getElementById('start');
    return Boolean(legacy?.classList?.contains('ready')) && legacy.disabled === false;
  }, null, { timeout });
}

export async function clickClassicLaunch(page, timeout = 60000) {
  await waitForClassicLaunchReady(page, timeout);
  const selector = await page.evaluate(() => document.getElementById('playClassic') ? '#playClassic' : '#start');
  await page.click(selector);
  return selector;
}

export async function launcherSnapshot(page) {
  return page.evaluate(() => ({
    dualLauncher: Boolean(document.getElementById('playClassic')),
    classicReady: Boolean(document.getElementById('playClassic')) && document.getElementById('playClassic').disabled === false,
    aiReady: Boolean(document.getElementById('playAi')) && document.getElementById('playAi').disabled === false,
    legacyReady: Boolean(document.querySelector('#start.ready:not([disabled])')),
    status: document.getElementById('status')?.textContent || null
  }));
}
