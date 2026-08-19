// Deterministic design-goal evaluation for DOOM MCP v0.9.
//
// This module intentionally does not call an LLM. It combines measurable
// LinuxDOOM playtest telemetry with optional vision rubric scores supplied by
// the MCP client after inspecting captured frames.

export const DEFAULT_GOAL = Object.freeze({
  name: 'balanced_playtest',
  hard: {
    maxDeaths: 0,
    minFinalHealth: 1
  },
  targets: {
    maxDamageTaken: 60,
    minVisitedSectors: 1,
    minDistanceUnits: 64,
    maxStuckActions: 1
  },
  weights: {
    survivability: 0.35,
    traversal: 0.30,
    combat: 0.15,
    pacing: 0.10,
    visual: 0.10
  }
});

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function ratioAtMost(value, target) {
  if (target == null || target <= 0) return 1;
  if (value <= target) return 1;
  return clamp(target / Math.max(value, 1));
}

function ratioAtLeast(value, target) {
  if (target == null || target <= 0) return 1;
  return clamp(value / target);
}

function mergeObject(base, incoming) {
  return { ...base, ...(incoming && typeof incoming === 'object' ? incoming : {}) };
}

export function normalizeGoal(input = {}) {
  return {
    name: String(input.name || DEFAULT_GOAL.name).slice(0, 96),
    description: String(input.description || '').slice(0, 1000),
    hard: mergeObject(DEFAULT_GOAL.hard, input.hard),
    targets: mergeObject(DEFAULT_GOAL.targets, input.targets),
    weights: mergeObject(DEFAULT_GOAL.weights, input.weights),
    visualRubric: Array.isArray(input.visualRubric)
      ? input.visualRubric.slice(0, 8).map(item => ({
          id: String(item?.id || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48),
          label: String(item?.label || item?.id || 'visual criterion').slice(0, 120),
          minScore: clamp(finite(item?.minScore) ?? 0.5),
          weight: Math.max(0, finite(item?.weight) ?? 1)
        })).filter(item => item.id)
      : []
  };
}

export function summarizeTrial({ baseline = {}, final = {}, actions = [] } = {}) {
  const actionSummaries = actions.map((entry, index) => {
    const before = entry?.before || {};
    const after = entry?.after || {};
    const command = entry?.command || entry || {};
    const distanceDelta = Math.max(0, Number(after.distanceUnits || 0) - Number(before.distanceUnits || 0));
    const movementIntent = Math.abs(Number(command.forward || 0)) + Math.abs(Number(command.strafe || 0));
    return {
      index,
      command,
      distanceDelta,
      damageDelta: Math.max(0, Number(after.damageTaken || 0) - Number(before.damageTaken || 0)),
      killDelta: Number(after.killDelta || 0) - Number(before.killDelta || 0),
      deathDelta: Math.max(0, Number(after.deaths || 0) - Number(before.deaths || 0)),
      movementIntent
    };
  });

  return {
    baseline,
    final,
    actionCount: actionSummaries.length,
    actions: actionSummaries,
    elapsedSeconds: Math.max(0, Number(final.elapsedSeconds || 0) - Number(baseline.elapsedSeconds || 0)),
    worldTics: Math.max(0, Number(final.worldTics || 0) - Number(baseline.worldTics || 0)),
    distanceUnits: Math.max(0, Number(final.distanceUnits || 0) - Number(baseline.distanceUnits || 0)),
    damageTaken: Math.max(0, Number(final.damageTaken || 0) - Number(baseline.damageTaken || 0)),
    deaths: Math.max(0, Number(final.deaths || 0) - Number(baseline.deaths || 0)),
    killDelta: Number(final.killDelta || 0) - Number(baseline.killDelta || 0),
    itemDelta: Number(final.itemDelta || 0) - Number(baseline.itemDelta || 0),
    secretDelta: Number(final.secretDelta || 0) - Number(baseline.secretDelta || 0),
    visitedSectors: Number(final.visitedSectors || 0),
    finalHealth: Number(final.health || 0),
    minHealth: Number(final.minHealth || 0)
  };
}

function normalizedWeights(weights) {
  const entries = Object.entries(weights || {}).map(([key, value]) => [key, Math.max(0, finite(value) ?? 0)]);
  const total = entries.reduce((sum, [, value]) => sum + value, 0) || 1;
  return Object.fromEntries(entries.map(([key, value]) => [key, value / total]));
}

function visualEvaluation(goal, visualAssessment = {}) {
  const criteria = goal.visualRubric || [];
  if (!criteria.length) return { score: 1, applicable: false, criteria: [], failures: [] };

  let weighted = 0;
  let totalWeight = 0;
  const failures = [];
  const results = [];

  for (const criterion of criteria) {
    const supplied = visualAssessment?.[criterion.id];
    const score = clamp(finite(typeof supplied === 'object' ? supplied?.score : supplied) ?? 0);
    const reason = typeof supplied === 'object' ? String(supplied?.reason || '').slice(0, 300) : '';
    const weight = Math.max(0, criterion.weight || 1);
    weighted += score * weight;
    totalWeight += weight;
    const passed = score >= criterion.minScore;
    if (!passed) failures.push(`${criterion.label} ${score.toFixed(2)} < ${criterion.minScore.toFixed(2)}`);
    results.push({ ...criterion, score, reason, passed });
  }

  return {
    score: totalWeight ? weighted / totalWeight : 1,
    applicable: true,
    criteria: results,
    failures
  };
}

export function evaluateTrial({ goal: inputGoal = {}, trial = {}, visualAssessment = {} } = {}) {
  const goal = normalizeGoal(inputGoal);
  const summary = trial.actions && trial.final ? summarizeTrial(trial) : trial;
  const hardFailures = [];
  const targetFailures = [];
  const suggestions = [];
  const hard = goal.hard;
  const targets = goal.targets;

  const deaths = Number(summary.deaths || 0);
  const finalHealth = Number(summary.finalHealth ?? summary.final?.health ?? 0);
  const damage = Number(summary.damageTaken || 0);
  const visited = Number(summary.visitedSectors ?? summary.final?.visitedSectors ?? 0);
  const distance = Number(summary.distanceUnits || 0);
  const kills = Number(summary.killDelta || 0);
  const elapsed = Number(summary.elapsedSeconds || 0);

  if (finite(hard.maxDeaths) != null && deaths > Number(hard.maxDeaths)) {
    hardFailures.push(`deaths ${deaths} > ${hard.maxDeaths}`);
    suggestions.push('Reduce encounter pressure, improve cover/visibility, or provide earlier health/ammo support.');
  }
  if (finite(hard.minFinalHealth) != null && finalHealth < Number(hard.minFinalHealth)) {
    hardFailures.push(`final health ${finalHealth} < ${hard.minFinalHealth}`);
    suggestions.push('Lower incoming damage or improve resource placement before the failing encounter.');
  }
  if (finite(hard.maxElapsedSeconds) != null && elapsed > Number(hard.maxElapsedSeconds)) {
    hardFailures.push(`elapsed ${elapsed.toFixed(2)}s > ${hard.maxElapsedSeconds}s`);
    suggestions.push('Shorten traversal or reduce time spent in blocked/ambiguous navigation.');
  }
  if (finite(hard.minVisitedSectors) != null && visited < Number(hard.minVisitedSectors)) {
    hardFailures.push(`visited sectors ${visited} < ${hard.minVisitedSectors}`);
  }

  if (finite(targets.maxDamageTaken) != null && damage > Number(targets.maxDamageTaken)) {
    targetFailures.push(`damage ${damage} > target ${targets.maxDamageTaken}`);
    suggestions.push('Reduce enemy count/placement pressure, improve lighting, or add safer approach angles.');
  }
  if (finite(targets.minVisitedSectors) != null && visited < Number(targets.minVisitedSectors)) {
    targetFailures.push(`visited sectors ${visited} < target ${targets.minVisitedSectors}`);
    suggestions.push('Improve navigation cues or ensure the planned route actually crosses the intended sectors.');
  }
  if (finite(targets.minDistanceUnits) != null && distance < Number(targets.minDistanceUnits)) {
    targetFailures.push(`distance ${distance} < target ${targets.minDistanceUnits}`);
  }
  if (finite(targets.minKills) != null && kills < Number(targets.minKills)) {
    targetFailures.push(`kills ${kills} < target ${targets.minKills}`);
  }
  if (finite(targets.maxElapsedSeconds) != null && elapsed > Number(targets.maxElapsedSeconds)) {
    targetFailures.push(`elapsed ${elapsed.toFixed(2)}s > target ${targets.maxElapsedSeconds}s`);
  }
  if (finite(targets.minElapsedSeconds) != null && elapsed < Number(targets.minElapsedSeconds)) {
    targetFailures.push(`elapsed ${elapsed.toFixed(2)}s < target ${targets.minElapsedSeconds}s`);
  }

  const stuckThreshold = Math.max(0, finite(targets.stuckDistanceThreshold) ?? 8);
  const movementThreshold = Math.max(0, finite(targets.movementIntentThreshold) ?? 0.25);
  const stuckActions = Array.isArray(summary.actions)
    ? summary.actions.filter(action => Number(action.movementIntent || 0) >= movementThreshold
        && Number(action.distanceDelta || 0) < stuckThreshold)
    : [];
  if (finite(targets.maxStuckActions) != null && stuckActions.length > Number(targets.maxStuckActions)) {
    targetFailures.push(`stuck actions ${stuckActions.length} > target ${targets.maxStuckActions}`);
    suggestions.push('The action plan is colliding or navigation cues are insufficient; reorient, use the nearby door, or revise the route.');
  }

  const survivability = 0.55 * ratioAtMost(deaths, Math.max(1, Number(hard.maxDeaths ?? 0) + 1))
    + 0.45 * ratioAtMost(damage, Number(targets.maxDamageTaken ?? 100));
  const traversal = 0.45 * ratioAtLeast(distance, Number(targets.minDistanceUnits ?? 1))
    + 0.35 * ratioAtLeast(visited, Number(targets.minVisitedSectors ?? 1))
    + 0.20 * ratioAtMost(stuckActions.length, Math.max(1, Number(targets.maxStuckActions ?? 1)));
  const combat = finite(targets.minKills) != null ? ratioAtLeast(kills, Number(targets.minKills)) : 1;
  let pacing = 1;
  if (finite(targets.maxElapsedSeconds) != null) pacing *= ratioAtMost(elapsed, Number(targets.maxElapsedSeconds));
  if (finite(targets.minElapsedSeconds) != null) pacing *= ratioAtLeast(elapsed, Number(targets.minElapsedSeconds));
  const visual = visualEvaluation(goal, visualAssessment);

  const dimensions = {
    survivability: clamp(survivability),
    traversal: clamp(traversal),
    combat: clamp(combat),
    pacing: clamp(pacing),
    visual: clamp(visual.score)
  };
  const weights = normalizedWeights(goal.weights);
  const weightedScore = Object.entries(dimensions)
    .reduce((sum, [key, score]) => sum + score * (weights[key] || 0), 0);
  const score = Math.round(weightedScore * 1000) / 10;
  const hardPassed = hardFailures.length === 0;
  const visualPassed = visual.failures.length === 0;
  const targetPassScore = clamp(finite(targets.minScore) ?? 0.7);
  const passed = hardPassed && visualPassed && weightedScore >= targetPassScore;

  if (!passed && weightedScore < targetPassScore) {
    suggestions.push(`Raise weighted evaluation score from ${(weightedScore * 100).toFixed(1)} to at least ${(targetPassScore * 100).toFixed(1)}.`);
  }

  return {
    version: '0.9.0',
    goal,
    passed,
    hardPassed,
    visualPassed,
    score,
    minimumScore: Math.round(targetPassScore * 1000) / 10,
    dimensions,
    weights,
    hardFailures,
    targetFailures,
    visual: visual,
    stuckActions: stuckActions.map(action => ({ index: action.index, distanceDelta: action.distanceDelta, command: action.command })),
    suggestions: [...new Set(suggestions)],
    summary
  };
}
