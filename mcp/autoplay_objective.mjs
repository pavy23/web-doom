// Autoplay objective: what "a better run" means.
//
// One definition shared by the report (ranking, baseline deltas) and the Jev
// policy (the priorities the model is briefed with), so the numbers a trial is
// judged on and the goal the model is asked to serve never drift apart.
//
// Lexicographic order, most important first:
//   1. deaths        (0 is a hard requirement; a run that did not clear ranks last)
//   2. damageTaken   (fewer health points lost)
//   3. totalTics     (faster clear; 35 tics = 1 s of game time)
// Kills, ammo and items are reported but do not rank runs: killing is only
// worth it when it reduces expected damage or unblocks the route.

export const OBJECTIVE_VERSION = '0.1.0-objective';
export const OBJECTIVE_ORDER = ['deaths', 'damageTaken', 'totalTics'];

export const OBJECTIVE_BRIEF =
  'Priorities, most important first: 1) stay alive, 2) take as little damage as possible, '
  + '3) reach the exit quickly. Killing an enemy is only worth the time when it lowers the damage '
  + 'the player would otherwise take; ammo has no value of its own.';

export function runMetrics(run) {
  const telemetry = run?.telemetry || {};
  return {
    cleared: Boolean(run?.passed),
    deaths: numberOrNull(telemetry.deaths),
    damageTaken: numberOrNull(telemetry.damageTaken),
    minHealth: numberOrNull(telemetry.minHealth),
    totalTics: numberOrNull(run?.totalTics),
    seconds: run?.totalTics == null ? null : Math.round(Number(run.totalTics) / 35 * 10) / 10,
    kills: numberOrNull(telemetry.kills),
    ammoLeft: telemetry.ammo ? { ...telemetry.ammo } : null
  };
}

// Negative when a ranks better than b. Uncleared runs sort after cleared ones;
// missing metrics sort after known ones so a broken telemetry never wins.
export function compareRuns(a, b) {
  const ma = runMetrics(a);
  const mb = runMetrics(b);
  if (ma.cleared !== mb.cleared) return ma.cleared ? -1 : 1;
  for (const key of OBJECTIVE_ORDER) {
    const va = ma[key];
    const vb = mb[key];
    if (va === vb) continue;
    if (va == null) return 1;
    if (vb == null) return -1;
    return va - vb;
  }
  return 0;
}

export function rankRuns(runs) {
  return runs
    .map((run, index) => ({ index, run }))
    .sort((x, y) => compareRuns(x.run, y.run) || x.index - y.index)
    .map(entry => entry.index);
}

// Per-metric deltas of this trial's best run against a baseline report's best
// run. Negative deltas are improvements for every ranked metric.
export function compareToBaseline(runs, baselineReport) {
  const baselineRuns = Array.isArray(baselineReport?.runs) ? baselineReport.runs : [];
  if (!runs.length || !baselineRuns.length) return null;
  const best = runMetrics(runs[rankRuns(runs)[0]]);
  const baseline = runMetrics(baselineRuns[rankRuns(baselineRuns)[0]]);
  const delta = {};
  for (const key of [...OBJECTIVE_ORDER, 'minHealth', 'kills']) {
    delta[key] = best[key] == null || baseline[key] == null ? null : best[key] - baseline[key];
  }
  return {
    baselinePolicy: baselineReport.policy || 'none',
    baseline,
    best,
    delta,
    better: compareMetrics(best, baseline) < 0,
    verdict: verdict(best, baseline)
  };
}

function compareMetrics(a, b) {
  if (a.cleared !== b.cleared) return a.cleared ? -1 : 1;
  for (const key of OBJECTIVE_ORDER) {
    if (a[key] === b[key]) continue;
    if (a[key] == null) return 1;
    if (b[key] == null) return -1;
    return a[key] - b[key];
  }
  return 0;
}

function verdict(best, baseline) {
  if (!best.cleared) return 'worse: did not clear';
  if (!baseline.cleared) return 'better: cleared where the baseline did not';
  for (const key of OBJECTIVE_ORDER) {
    if (best[key] == null || baseline[key] == null || best[key] === baseline[key]) continue;
    return `${best[key] < baseline[key] ? 'better' : 'worse'}: ${key} ${baseline[key]} -> ${best[key]}`;
  }
  return 'equal on every ranked metric';
}

function numberOrNull(value) {
  return value == null || Number.isNaN(Number(value)) ? null : Number(value);
}
