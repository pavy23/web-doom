import { buildNavigationGraph, findExitProgression, locatePointSector, reachableSectors } from './navigation_graph.js';

export const GAME_DESIGN_EVALUATOR_VERSION = '2.7.0-p2.1';
export const GAME_DESIGN_POLICY_VERSION = '2026-08-p2.1';

const THREAT = Object.freeze({
  zombieman: 1,
  shotgun_guy: 1.5,
  imp: 2,
  lost_soul: 2.5,
  demon: 3.5,
  spectre: 4,
  cacodemon: 6,
  baron_of_hell: 12,
  spider_mastermind: 35,
  cyberdemon: 40
});

const SUPPORT = Object.freeze({
  ammo_clip: 1,
  shotgun_shells: 1.5,
  rocket: 1.5,
  energy_cell: 1.5,
  ammo_box: 5,
  box_of_shells: 6,
  box_of_rockets: 7,
  cell_pack: 7,
  shotgun: 4,
  chaingun: 5,
  chainsaw: 3,
  rocket_launcher: 6,
  plasma_rifle: 8,
  bfg9000: 10,
  stimpack: 1,
  medikit: 2.5,
  soulsphere: 8,
  health_bonus: 0.1,
  armor_bonus: 0.1,
  green_armor: 4,
  blue_armor: 8,
  invulnerability: 10,
  berserk: 4,
  partial_invisibility: 3,
  radiation_suit: 1,
  computer_map: 0.5,
  light_amplification: 0.5
});

const PROFILES = Object.freeze({
  balanced: Object.freeze({
    weights: { reachability: 20, progression: 20, topology: 15, combat: 15, resources: 15, pacing: 15 },
    pathSectors: [4, 12], threatDensity: [1, 5], threatCoverage: [0.25, 0.75], supportRatio: [0.55, 2.4], startThreatMax: 3
  }),
  combat: Object.freeze({
    weights: { reachability: 15, progression: 15, topology: 10, combat: 25, resources: 20, pacing: 15 },
    pathSectors: [3, 10], threatDensity: [2, 8], threatCoverage: [0.4, 0.9], supportRatio: [0.6, 2.8], startThreatMax: 5
  }),
  exploration: Object.freeze({
    weights: { reachability: 20, progression: 20, topology: 25, combat: 10, resources: 10, pacing: 15 },
    pathSectors: [5, 16], threatDensity: [0.2, 3], threatCoverage: [0.1, 0.6], supportRatio: [0.45, 3.5], startThreatMax: 2
  })
});

const SKILL_FLAG = Object.freeze({ easy: 'skillEasy', medium: 'skillMedium', hard: 'skillHard' });

function clamp(value, min = 0, max = 100) { return Math.max(min, Math.min(max, Number(value))); }
function round(value, digits = 2) {
  const p = 10 ** digits;
  return Math.round(Number(value) * p) / p;
}
function mean(values) { return values.length ? values.reduce((sum, value) => sum + Number(value), 0) / values.length : 0; }
function rangeScore(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n >= min && n <= max) return 100;
  if (n < min) return min <= 0 ? 100 : clamp((n / min) * 100);
  const excess = (n - max) / Math.max(0.0001, max);
  return clamp(100 - excess * 70);
}
function maxThresholdScore(value, max) {
  if (Number(value) <= max) return 100;
  return clamp(100 - ((Number(value) - max) / Math.max(1, max)) * 70);
}
function grade(score) {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}
function activeOnSkill(thing, skill) {
  if (thing.options?.multiplayerOnly) return false;
  const flag = SKILL_FLAG[skill];
  if (!flag) return true;
  return thing.options?.[flag] !== false;
}
function uniquePortals(graph, sectors) {
  const allowed = new Set(sectors);
  const byLine = new Map();
  for (const edge of graph.edges) {
    if (!edge.passable || !allowed.has(edge.from) || !allowed.has(edge.to)) continue;
    const existing = byLine.get(edge.line);
    if (!existing) byLine.set(edge.line, edge);
  }
  return [...byLine.values()];
}
function issue(code, severity, message, recommendation, details = {}) {
  return { code, severity, message, recommendation, ...details };
}
function supportBucket(thing) {
  if (thing.category === 'ammo') return 'ammo';
  if (thing.category === 'weapon') return 'weapon';
  if (thing.category === 'health') return 'health';
  if (thing.category === 'armor') return 'armor';
  if (thing.category === 'powerup') return 'powerup';
  return null;
}

export function getGameDesignPolicy() {
  return {
    version: GAME_DESIGN_POLICY_VERSION,
    profiles: PROFILES,
    notes: [
      'Scores are deterministic design proxies, not an objective measurement of fun.',
      'Combat and resource weights are intentionally normalized heuristics used for relative comparison.',
      'The strongest use is before/after evaluation of maps built by the same pipeline and profile.'
    ]
  };
}

export function evaluateGameDesign(workspace, options = {}) {
  const profileName = String(options.profile || 'balanced').toLowerCase();
  const profile = PROFILES[profileName];
  if (!profile) throw new Error(`Unknown game-design profile: ${options.profile}`);
  const skill = String(options.skill || 'medium').toLowerCase();
  if (!SKILL_FLAG[skill]) throw new Error(`Unknown skill: ${options.skill}`);

  const graph = buildNavigationGraph(workspace);
  const allThings = typeof workspace.listThings === 'function' ? workspace.listThings({ limit: 65535 }) : [];
  const things = allThings.filter(thing => activeOnSkill(thing, skill)).map(thing => ({
    ...thing,
    sector: locatePointSector(workspace, { x: Number(thing.x), y: Number(thing.y) })
  }));

  const player1 = things.find(thing => Number(thing.doomEdNum) === 1 && thing.sector != null) || null;
  const startSector = player1?.sector ?? null;
  const availableKeys = [...new Set((graph.things.keys || []).map(item => item.key))];
  let progression = null;
  let reachable = [];
  if (startSector != null) {
    progression = findExitProgression(graph, startSector, {
      includeSecret: options.includeSecret !== false,
      allowDrops: options.allowDrops !== false
    });
    reachable = reachableSectors(graph, startSector, {
      keys: availableKeys,
      allowDrops: options.allowDrops !== false
    });
  }

  const reachableSet = new Set(reachable);
  const reachabilityRatio = graph.nodes.length ? reachable.length / graph.nodes.length : 0;
  const portals = uniquePortals(graph, reachable);
  const degree = new Map(reachable.map(sector => [sector, 0]));
  for (const edge of portals) {
    degree.set(edge.from, (degree.get(edge.from) || 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) || 0) + 1);
  }
  const exitSectors = new Set((graph.exits || []).flatMap(item => item.sectors || []));
  const deadEnds = reachable.filter(sector => sector !== startSector && !exitSectors.has(sector) && (degree.get(sector) || 0) <= 1);
  const branchSectors = reachable.filter(sector => (degree.get(sector) || 0) >= 3);
  const loopCount = reachable.length ? Math.max(0, portals.length - reachable.length + 1) : 0;
  const deadEndRatio = reachable.length ? deadEnds.length / reachable.length : 0;
  const branchRatio = reachable.length ? branchSectors.length / reachable.length : 0;
  const averageDegree = reachable.length ? mean(reachable.map(sector => degree.get(sector) || 0)) : 0;

  const sectorThreat = new Map();
  const sectorSupport = new Map();
  const supportByBucket = { ammo: 0, weapon: 0, health: 0, armor: 0, powerup: 0 };
  let totalThreat = 0;
  let totalSupport = 0;
  let monsterCount = 0;
  let resourceCount = 0;
  let weaponCount = 0;

  for (const thing of things) {
    if (thing.sector == null || !reachableSet.has(thing.sector)) continue;
    const threat = THREAT[thing.key] || 0;
    if (thing.category === 'monster') {
      monsterCount++;
      totalThreat += threat || 1;
      sectorThreat.set(thing.sector, (sectorThreat.get(thing.sector) || 0) + (threat || 1));
    }
    const support = SUPPORT[thing.key] || 0;
    const bucket = supportBucket(thing);
    if (bucket && support > 0) {
      resourceCount++;
      totalSupport += support;
      supportByBucket[bucket] += support;
      sectorSupport.set(thing.sector, (sectorSupport.get(thing.sector) || 0) + support);
      if (bucket === 'weapon') weaponCount++;
    }
  }

  const threatSectors = [...sectorThreat.keys()];
  const resourceSectors = [...sectorSupport.keys()];
  const threatDensity = reachable.length ? totalThreat / reachable.length : 0;
  const threatCoverage = reachable.length ? threatSectors.length / reachable.length : 0;
  const resourceCoverage = reachable.length ? resourceSectors.length / reachable.length : 0;
  const supportRatio = totalThreat > 0 ? totalSupport / totalThreat : null;
  const maxSectorThreat = threatSectors.length ? Math.max(...threatSectors.map(sector => sectorThreat.get(sector) || 0)) : 0;
  const peakThreatShare = totalThreat > 0 ? maxSectorThreat / totalThreat : 0;

  const pathSectors = progression?.found ? progression.sectors : [];
  const pathThreat = pathSectors.map(sector => sectorThreat.get(sector) || 0);
  const pathSupport = pathSectors.map(sector => sectorSupport.get(sector) || 0);
  const pathSectorCount = pathSectors.length;
  const startThreat = startSector == null ? 0 : (sectorThreat.get(startSector) || 0);
  const earlyCount = Math.max(1, Math.ceil(pathSectorCount / 3));
  const lateStart = Math.max(0, pathSectorCount - earlyCount);
  const earlyThreat = pathThreat.slice(0, earlyCount).reduce((a, b) => a + b, 0);
  const lateThreat = pathThreat.slice(lateStart).reduce((a, b) => a + b, 0);
  const adjacentThreatChanges = pathThreat.slice(1).map((value, index) => Math.abs(value - pathThreat[index]));
  const pathMeanThreat = mean(pathThreat);
  const threatVolatility = adjacentThreatChanges.length ? mean(adjacentThreatChanges) / Math.max(1, pathMeanThreat) : 0;
  const earlyWeapon = pathSectors.slice(0, Math.min(2, pathSectors.length)).some(sector => things.some(thing => thing.sector === sector && thing.category === 'weapon'));

  const componentScores = {};
  componentScores.reachability = round(startSector == null ? 0 : reachabilityRatio * 100);

  const exitPresence = graph.exits.length ? 100 : 0;
  const exitReachable = progression?.found ? 100 : 0;
  const progressionDepth = progression?.found ? rangeScore(pathSectorCount, profile.pathSectors[0], profile.pathSectors[1]) : 0;
  componentScores.progression = round(exitPresence * 0.25 + exitReachable * 0.5 + progressionDepth * 0.25);

  let loopScore = reachable.length < 4 ? 70 : clamp(loopCount * 50);
  let branchScore = reachable.length < 4 ? 70 : rangeScore(branchRatio, 0.1, 0.5);
  const deadEndScore = deadEndRatio <= 0.3 ? 100 : maxThresholdScore(deadEndRatio, 0.3);
  const degreeScore = reachable.length < 3 ? 70 : rangeScore(averageDegree, 1.5, 3.5);
  componentScores.topology = round(loopScore * 0.3 + branchScore * 0.25 + deadEndScore * 0.25 + degreeScore * 0.2);

  if (totalThreat <= 0) {
    componentScores.combat = profileName === 'exploration' ? 70 : profileName === 'balanced' ? 15 : 5;
  } else {
    const densityScore = rangeScore(threatDensity, profile.threatDensity[0], profile.threatDensity[1]);
    const coverageScore = rangeScore(threatCoverage, profile.threatCoverage[0], profile.threatCoverage[1]);
    const concentrationScore = maxThresholdScore(peakThreatShare, 0.6);
    const volatilityScore = maxThresholdScore(threatVolatility, 1.5);
    componentScores.combat = round(densityScore * 0.35 + coverageScore * 0.3 + concentrationScore * 0.2 + volatilityScore * 0.15);
  }

  if (totalThreat <= 0) {
    componentScores.resources = round(totalSupport <= 8 ? 80 : 65);
  } else {
    const ratioScore = rangeScore(supportRatio, profile.supportRatio[0], profile.supportRatio[1]);
    const weaponScore = earlyWeapon || totalThreat < 4 ? 100 : weaponCount ? 65 : 35;
    const healthScore = supportByBucket.health > 0 || totalThreat < 6 ? 100 : 35;
    const coverageScore = rangeScore(resourceCoverage, 0.15, 0.7);
    componentScores.resources = round(ratioScore * 0.45 + weaponScore * 0.2 + healthScore * 0.15 + coverageScore * 0.2);
  }

  if (!progression?.found) {
    componentScores.pacing = 0;
  } else {
    const pathScore = rangeScore(pathSectorCount, profile.pathSectors[0], profile.pathSectors[1]);
    const startSafety = maxThresholdScore(startThreat, profile.startThreatMax);
    const concentration = totalThreat > 0 ? maxThresholdScore(peakThreatShare, 0.55) : (profileName === 'exploration' ? 100 : 60);
    let escalation = 80;
    if (totalThreat <= 0) escalation = profileName === 'exploration' ? 90 : 45;
    else if (pathSectorCount >= 3 && lateThreat < earlyThreat * 0.6) escalation = 55;
    else if (pathSectorCount >= 3 && lateThreat >= earlyThreat * 0.8) escalation = 100;
    componentScores.pacing = round(pathScore * 0.3 + startSafety * 0.25 + concentration * 0.25 + escalation * 0.2);
  }

  const overallScore = round(Object.entries(profile.weights).reduce((sum, [name, weight]) => sum + componentScores[name] * weight / 100, 0), 1);
  const issues = [];
  if (startSector == null) issues.push(issue('NO_PLAYER1_START', 'error', 'No valid Player 1 start is located inside a sector.', 'Add or move a Player 1 start into valid generated geometry.'));
  if (!graph.exits.length) issues.push(issue('NO_EXIT', 'error', 'The map has no recognized exit linedef.', 'Add a normal exit special (11 or 52) to a reachable boundary.'));
  else if (!progression?.found) issues.push(issue('EXIT_UNREACHABLE', 'error', 'No valid key/progression path reaches an exit.', 'Run P1.4 navigation diagnosis before tuning gameplay balance.'));
  if (startSector != null && reachabilityRatio < 0.999) issues.push(issue('UNREACHABLE_SECTORS', 'warning', `${graph.nodes.length - reachable.length} sector(s) remain unreachable even with placed keys.`, 'Connect or intentionally remove isolated sectors before judging pacing.', { reachable: reachable.length, sectors: graph.nodes.length }));
  if (reachable.length >= 4 && loopCount === 0) issues.push(issue('TOPOLOGY_TOO_LINEAR', 'warning', 'Reachable topology has no alternate loop.', 'Consider one alternate route or reconnecting branch if the design brief allows it.'));
  if (reachable.length >= 5 && deadEndRatio > 0.4) issues.push(issue('TOO_MANY_DEAD_ENDS', 'warning', 'A large share of reachable sectors terminate as dead ends.', 'Convert some dead ends into loops, rewards, or meaningful encounter spaces.', { deadEndRatio: round(deadEndRatio) }));
  if (totalThreat <= 0 && profileName !== 'exploration') issues.push(issue('COMBAT_EMPTY', 'warning', 'No active single-player monsters were found for the selected skill.', 'Add a small threat curve or use the exploration profile if combat is intentionally absent.'));
  if (totalThreat > 0 && peakThreatShare > 0.72) issues.push(issue('THREAT_OVERCONCENTRATED', 'warning', 'Most combat threat is concentrated in one sector.', 'Spread pressure across multiple encounter spaces or deliberately mark the peak as a boss arena.', { peakThreatShare: round(peakThreatShare) }));
  if (totalThreat > 5 && supportRatio != null && supportRatio < profile.supportRatio[0] * 0.7) issues.push(issue('RESOURCE_STARVATION', 'warning', 'Combat support is low relative to normalized threat.', 'Add ammo/health/weapon support before or near the high-pressure sectors.', { supportRatio: round(supportRatio) }));
  if (totalThreat > 5 && supportRatio != null && supportRatio > profile.supportRatio[1] * 1.5) issues.push(issue('RESOURCE_OVERSUPPLY', 'info', 'Combat support is very high relative to normalized threat.', 'Reduce redundant pickups if resource tension is part of the brief.', { supportRatio: round(supportRatio) }));
  if (totalThreat > 8 && !earlyWeapon) issues.push(issue('NO_EARLY_WEAPON', 'warning', 'Meaningful threat appears without an authored weapon in the first two progression sectors.', 'Place an appropriate weapon early or lower the opening threat.'));
  if (startThreat > profile.startThreatMax * 1.5) issues.push(issue('START_ROOM_OVERPRESSURED', 'warning', 'The Player 1 start sector carries unusually high immediate threat.', 'Move some monsters deeper into the main path or provide explicit opening support.', { startThreat: round(startThreat) }));
  if (progression?.found && pathSectorCount < Math.max(3, profile.pathSectors[0] - 1)) issues.push(issue('MAIN_PATH_TOO_SHORT', 'info', 'The reachable exit path is very short for this profile.', 'Add one or more meaningful encounter/exploration beats before the exit.', { pathSectorCount }));

  const recommendations = issues.map(row => ({ code: row.code, action: row.recommendation }));
  return {
    version: GAME_DESIGN_EVALUATOR_VERSION,
    policyVersion: GAME_DESIGN_POLICY_VERSION,
    map: workspace.mapName,
    profile: profileName,
    skill,
    overallScore,
    grade: grade(overallScore),
    componentScores,
    metrics: {
      sectors: graph.nodes.length,
      reachableSectors: reachable.length,
      reachabilityRatio: round(reachabilityRatio),
      passablePortals: portals.length,
      loopCount,
      branchSectors: branchSectors.length,
      branchRatio: round(branchRatio),
      deadEnds: deadEnds.length,
      deadEndRatio: round(deadEndRatio),
      averageDegree: round(averageDegree),
      exits: graph.exits.length,
      exitReachable: Boolean(progression?.found),
      mainPathSectors: pathSectorCount,
      acquiredKeys: progression?.found ? progression.keys : [],
      monsterCount,
      totalThreat: round(totalThreat),
      threatDensity: round(threatDensity),
      threatCoverage: round(threatCoverage),
      peakThreatShare: round(peakThreatShare),
      threatVolatility: round(threatVolatility),
      resourceCount,
      totalSupport: round(totalSupport),
      supportRatio: supportRatio == null ? null : round(supportRatio),
      resourceCoverage: round(resourceCoverage),
      supportByBucket: Object.fromEntries(Object.entries(supportByBucket).map(([key, value]) => [key, round(value)])),
      earlyWeapon,
      startThreat: round(startThreat),
      earlyThreat: round(earlyThreat),
      lateThreat: round(lateThreat)
    },
    mainPath: progression?.found ? {
      sectors: pathSectors,
      threatBySector: pathThreat.map(roundValue => round(roundValue)),
      supportBySector: pathSupport.map(roundValue => round(roundValue)),
      exit: progression.exit
    } : null,
    issues,
    recommendations,
    note: 'Heuristic design-quality proxy. Use runtime QA and human/agent playtesting before treating a score increase as a better game.'
  };
}

export function compareGameDesignReports(before, after) {
  if (!before || !after) throw new Error('Both before and after reports are required');
  const components = {};
  for (const key of Object.keys(after.componentScores || {})) {
    components[key] = {
      before: Number(before.componentScores?.[key] || 0),
      after: Number(after.componentScores?.[key] || 0),
      delta: round(Number(after.componentScores?.[key] || 0) - Number(before.componentScores?.[key] || 0), 1)
    };
  }
  return {
    policyVersion: after.policyVersion,
    profile: after.profile,
    skill: after.skill,
    overall: {
      before: before.overallScore,
      after: after.overallScore,
      delta: round(Number(after.overallScore) - Number(before.overallScore), 1)
    },
    components,
    resolvedIssues: (before.issues || []).filter(item => !(after.issues || []).some(next => next.code === item.code)).map(item => item.code),
    newIssues: (after.issues || []).filter(item => !(before.issues || []).some(previous => previous.code === item.code)).map(item => item.code)
  };
}
