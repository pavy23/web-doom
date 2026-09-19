// Layer 2 of the autoplay stack: a TypeSafe System One (Jev) tactical policy.
//
// Code still owns the route, the exit and every safety rule. Jev is asked a
// handful of typed questions only at decision points the code chooses
// (enemies in view, low health), over a compact state built from
// DoomControl.getState(). Its answers are mapped onto the same bounded ticcmd
// vocabulary the deterministic follower uses. The world is paused between
// steps, so judgment latency never touches gameplay.
//
// dryRun mode records exactly what would be sent without calling the API, so
// the wiring can be validated (and costed) with no key or network access.

import { appendFile } from 'node:fs/promises';

import { OBJECTIVE_BRIEF } from './autoplay_objective.mjs';

export const JEV_POLICY_VERSION = '0.3.0-jev-policy';

// Safety rules the code owns regardless of what the model answers. They were
// added after the first live E1M1 trial, where the player was pinned in a
// corridor by an Imp in melee range, strafed left and right without net
// progress, never crossed the fire threshold and died.
//
//   stall       no net progress over the last `stallWindow` consultations while
//               an enemy is inside `meleeRange`  -> force `fight` and fire
//   dodgeHold   a dodge keeps its strafe side for `dodgeHoldCalls` consecutive
//               dodge answers instead of flipping every call
//   pointBlank  a target inside `pointBlankDistance` that the player is aligned
//               with is fired at whatever the `fire` noul says; the noul
//               threshold itself is 0.4 (it hovered at 0.45 in the stall)
export const SAFETY_RULES = ['stall', 'dodgeHold', 'pointBlank'];
export const INPUT_TOKEN_PRICE_USD_PER_MILLION = 0.042; // published launch price; verify in console

const WEAPON_NAMES = ['fist', 'pistol', 'shotgun', 'chaingun', 'rocket launcher', 'plasma rifle', 'BFG', 'chainsaw', 'super shotgun'];
const AMMO_FOR_WEAPON = { 1: 'bullets', 2: 'shells', 3: 'bullets', 4: 'rockets', 5: 'cells', 6: 'cells', 8: 'shells' };

function round(value, digits = 0) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

// Compact, named-field state for the model. Only what the questions need.
export function compactState(state, context = {}) {
  const player = state?.player || {};
  const weaponIndex = Number(player.weapon ?? 1);
  const ammoKind = AMMO_FOR_WEAPON[weaponIndex] || null;
  const enemies = (state?.enemies || [])
    .filter(enemy => enemy.visible || enemy.lineOfSight)
    .sort((a, b) => Number(a.distance) - Number(b.distance))
    .slice(0, Number(context.maxEnemies || 5))
    .map((enemy, index) => ({
      id: `enemy_${index}`,
      name: enemy.name,
      health: Number(enemy.health),
      distance: round(enemy.distance),
      bearing: round(enemy.relativeAngle),
      bearingNote: 'degrees, positive = to the left, 0 = straight ahead',
      inView: Boolean(enemy.visible),
      lineOfSight: Boolean(enemy.lineOfSight)
    }));
  return {
    game: 'DOOM (1993) single player. The player must reach the level exit alive.',
    objective: OBJECTIVE_BRIEF,
    player: {
      health: Number(player.health),
      armor: Number(player.armor),
      weapon: WEAPON_NAMES[weaponIndex] || `weapon ${weaponIndex}`,
      ammoForWeapon: ammoKind ? Number(player.ammo?.[ammoKind]) : null
    },
    route: {
      phase: context.edge ? `moving to route sector ${context.edge.to} via a ${context.edge.kind}` : 'approaching the exit switch',
      distanceToWaypoint: round(context.targetDistance ?? 0),
      waypointBearing: round(context.delta ?? 0)
    },
    visibleEnemies: enemies,
    enemyCountTotal: Number(state?.enemyCount ?? 0)
  };
}

// The judgments. All questions share one state and run in parallel.
export function buildQuestions(compact, primitives) {
  const { choice, noul, score } = primitives;
  const targetLabels = Object.fromEntries(compact.visibleEnemies.map(enemy => [
    enemy.id, `${enemy.name} at ${enemy.distance} units, bearing ${enemy.bearing}, health ${enemy.health}`
  ]));
  targetLabels.none = 'no enemy is worth shooting right now';
  return {
    mode: choice({
      question: 'What should the player do for the next fraction of a second?',
      context: `${OBJECTIVE_BRIEF} The player is following a known route to the exit. Enemies in DOOM approach and shoot; a Zombieman or Imp dies to a few pistol shots, a Demon must be shot many times and is fast, a Baron of Hell should be avoided with a weak weapon. Stopping to fight costs time and exposes the player to every enemy in view; running past costs nothing when the enemies are far or behind.`
    }, {
      advance: 'keep moving along the route toward the exit and ignore the enemies',
      fight: 'stop moving, face the chosen enemy and shoot until it dies',
      retreat: 'move backwards away from the enemies while facing them',
      dodge: 'keep advancing but strafe sideways to avoid projectiles'
    }),
    target: choice('If the player shoots, which enemy is the best target?', targetLabels),
    fire: noul('Should the player pull the trigger right now with the current weapon and ammo?'),
    danger: score('How much damage is the player likely to take in the next few seconds if nothing changes?', [
      'safe: no enemy can hurt the player soon',
      'caution: an enemy may deal minor damage',
      'critical: the player may die within seconds without acting'
    ])
  };
}

function turnToward(bearing, max = 0.7) {
  // relativeAngle > 0 is to the left (geometric CCW); agent +turn is right.
  const magnitude = Math.min(max, Math.max(0.12, Math.abs(bearing) / 90 * 0.6));
  return bearing > 0 ? -magnitude : magnitude;
}

// Map typed answers onto a bounded ticcmd. Returns null to keep the proposal.
export function answersToCommand(answers, compact, proposal, options = {}) {
  const aimTolerance = Number(options.aimTolerance ?? 8);
  const enemyById = new Map(compact.visibleEnemies.map(enemy => [enemy.id, enemy]));
  const rules = [];
  // A forced fight (stall rule) always aims at the nearest enemy, which is the
  // one blocking the player; otherwise the model's target, falling back to nearest.
  const target = options.forceMode === 'fight'
    ? (compact.visibleEnemies[0] || null)
    : (enemyById.get(answers.target?.choice) || compact.visibleEnemies[0] || null);
  const pointBlank = Boolean(target) && Number(target.distance) <= Number(options.pointBlankDistance ?? 96);
  let fire = Number(answers.fire?.noul ?? 0) >= Number(options.fireThreshold ?? 0.4);
  if (pointBlank && !fire) { fire = true; rules.push('pointBlank'); }
  let mode = answers.mode?.choice;
  if (options.forceMode && options.forceMode !== mode) { mode = options.forceMode; rules.push('stall'); }
  else if (options.forceMode) { rules.push('stall'); }
  if (options.forceMode === 'fight') fire = true;
  const meta = { source: 'jev', mode, target: target?.id || 'none', fire, danger: round(answers.danger?.score ?? 0, 2), ...(rules.length ? { rules } : {}) };

  if (!target || mode === 'advance') {
    if (fire && target && Math.abs(target.bearing) <= aimTolerance) return { ...proposal, attack: true, ...meta };
    // A point-blank target the player is not aligned with is still worth a
    // shot: keep advancing, but turn toward it so the next step can fire.
    if (pointBlank && target && !(options.forceMode)) return { ...proposal, turn: turnToward(target.bearing, 0.4), ...meta };
    return null;
  }
  const aligned = Math.abs(target.bearing) <= aimTolerance;
  if (mode === 'fight') {
    if (!aligned) return { forward: 0, strafe: 0, turn: turnToward(target.bearing), attack: false, use: false, tics: 2, ...meta };
    return { forward: 0, strafe: 0, turn: 0, attack: fire, use: false, tics: 3, ...meta };
  }
  if (mode === 'retreat') {
    return { forward: -0.6, strafe: 0, turn: aligned ? 0 : turnToward(target.bearing, 0.4), attack: fire && aligned, use: false, tics: 4, ...meta };
  }
  if (mode === 'dodge') {
    const side = options.dodgeSide ?? 1;
    return { ...proposal, forward: Number(proposal.forward ?? 0.5), strafe: 0.6 * side, attack: fire && aligned, tics: 3, ...meta };
  }
  return null;
}

// Decide when a judgment is worth paying for.
export function shouldConsult(state, options = {}) {
  const visible = Number(state?.visibleEnemyCount ?? 0);
  const health = Number(state?.player?.health ?? 100);
  return visible > 0 || health < Number(options.lowHealth ?? 40);
}

export async function createJevPolicy(options = {}) {
  const config = {
    dryRun: false,
    maxCalls: 600,             // hard cost cap per trial
    minStepsBetweenCalls: 1,   // 1 = every eligible step
    maxEnemies: 5,
    aimTolerance: 8,
    fireThreshold: 0.4,
    lowHealth: 40,
    // safety rules (see SAFETY_RULES)
    stallWindow: 6,            // consultations without net progress ...
    stallDistance: 32,         // ... of at least this many map units ...
    meleeRange: 96,            // ... with an enemy this close -> forced fight
    dodgeHoldCalls: 4,         // dodge answers per strafe side before flipping
    pointBlankDistance: 96,    // aligned target this close is always fired at
    model: undefined,
    log: null,                 // JSONL path
    ...options
  };
  const sdk = await import('@typesafe-ai/sdk');
  const client = config.dryRun ? null : (config.client || new sdk.TypeSafeClient(config.model ? { defaultModel: config.model } : {}));
  const stats = {
    version: JEV_POLICY_VERSION, dryRun: config.dryRun, eligibleSteps: 0, calls: 0, overrides: 0,
    capped: false, errors: 0, inputTokens: 0, outputTokens: 0, latencyMsTotal: 0, modes: {},
    rules: { stall: 0, dodgeHold: 0, pointBlank: 0 }
  };
  let stepsSinceCall = Infinity;
  let dodgeSide = 1;
  let dodgeRun = 0;            // consecutive dodge answers on the current side
  let lastDecision = null;
  const positions = [];        // player position at each consultation, newest last

  // Stall rule: the player has not made net progress across the last
  // `stallWindow` consultations and the nearest visible enemy is in melee range.
  function detectStall(state, compact) {
    const player = state?.player || {};
    positions.push({ x: Number(player.x), y: Number(player.y), tic: Number(state?.levelTime) });
    if (positions.length > config.stallWindow) positions.shift();
    if (positions.length < config.stallWindow) return false;
    const first = positions[0];
    const last = positions[positions.length - 1];
    const moved = Math.hypot(last.x - first.x, last.y - first.y);
    const nearest = compact.visibleEnemies[0];
    return Boolean(nearest) && moved < config.stallDistance && Number(nearest.distance) <= config.meleeRange;
  }

  function ruleOptions(compact, state) {
    const stalled = detectStall(state, compact);
    return { ...config, dodgeSide, ...(stalled ? { forceMode: 'fight' } : {}) };
  }

  async function record(entry) {
    if (!config.log) return;
    await appendFile(config.log, `${JSON.stringify(entry)}\n`);
  }

  async function decide(context) {
    const { state, proposal } = context;
    stepsSinceCall++;
    if (!shouldConsult(state, config)) return null;
    stats.eligibleSteps++;
    if (stepsSinceCall < config.minStepsBetweenCalls) {
      // Reuse the last judgment for a short hold without paying again.
      return lastDecision ? answersToCommand(lastDecision.answers, lastDecision.compact, proposal, ruleOptions(lastDecision.compact, state)) : null;
    }
    if (stats.calls >= config.maxCalls) { stats.capped = true; return null; }

    const compact = compactState(state, { ...context, maxEnemies: config.maxEnemies });
    const questions = buildQuestions(compact, sdk);
    const request = { state: compact, questions, ...(config.model ? { model: config.model } : {}) };
    stepsSinceCall = 0;

    if (config.dryRun) {
      stats.calls++;
      const approxTokens = Math.ceil(JSON.stringify(request).length / 4);
      stats.inputTokens += approxTokens;
      await record({ kind: 'jev_dry_run', tic: state.levelTime, approxInputTokens: approxTokens, state: compact });
      return null;
    }

    const started = Date.now();
    let result;
    try {
      result = await client.systemOne(request);
    } catch (error) {
      stats.errors++;
      await record({ kind: 'jev_error', tic: state.levelTime, message: String(error?.message || error) });
      if (config.stopOnError) throw error;
      return null;
    }
    const latency = Date.now() - started;
    stats.calls++;
    stats.latencyMsTotal += latency;
    stats.inputTokens += Number(result.usage?.input_tokens || 0);
    stats.outputTokens += Number(result.usage?.output_tokens || 0);
    const mode = result.answers.mode?.choice;
    stats.modes[mode] = (stats.modes[mode] || 0) + 1;
    // dodgeHold rule: keep the strafe side for a run of dodge answers.
    if (mode === 'dodge') {
      dodgeRun++;
      if (dodgeRun > config.dodgeHoldCalls) { dodgeSide *= -1; dodgeRun = 1; } else if (dodgeRun > 1) { stats.rules.dodgeHold++; }
    } else {
      dodgeRun = 0;
    }
    lastDecision = { answers: result.answers, compact };
    const options = ruleOptions(compact, state);
    const command = answersToCommand(result.answers, compact, proposal, options);
    if (command) stats.overrides++;
    for (const rule of command?.rules || []) stats.rules[rule] = (stats.rules[rule] || 0) + 1;
    await record({
      kind: 'jev_decision', tic: state.levelTime, latencyMs: latency, model: result.model, usage: result.usage,
      state: compact, answers: result.answers, proposal, command, ...(options.forceMode ? { forced: options.forceMode } : {})
    });
    return command;
  }

  function summary() {
    return {
      ...stats,
      avgLatencyMs: stats.calls && !config.dryRun ? round(stats.latencyMsTotal / stats.calls) : null,
      estimatedInputCostUsd: round(stats.inputTokens / 1e6 * INPUT_TOKEN_PRICE_USD_PER_MILLION, 4)
    };
  }

  return { decide, summary, config };
}
