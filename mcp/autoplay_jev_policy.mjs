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

export const JEV_POLICY_VERSION = '0.1.0-jev-policy';
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
      context: 'The player is following a known route to the exit. Enemies in DOOM approach and shoot; a Zombieman or Imp dies to a few pistol shots, a Demon must be shot many times and is fast, a Baron of Hell should be avoided with a weak weapon.'
    }, {
      advance: 'keep moving along the route toward the exit and ignore the enemies',
      fight: 'stop moving, face the chosen enemy and shoot until it dies',
      retreat: 'move backwards away from the enemies while facing them',
      dodge: 'keep advancing but strafe sideways to avoid projectiles'
    }),
    target: choice('If the player shoots, which enemy is the best target?', targetLabels),
    fire: noul('Should the player pull the trigger right now with the current weapon and ammo?'),
    danger: score('How dangerous is the situation for the player?', [
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
  const target = enemyById.get(answers.target?.choice) || compact.visibleEnemies[0] || null;
  const fire = Number(answers.fire?.noul ?? 0) >= Number(options.fireThreshold ?? 0.5);
  const mode = answers.mode?.choice;
  const meta = { source: 'jev', mode, target: target?.id || 'none', fire, danger: round(answers.danger?.score ?? 0, 2) };

  if (!target || mode === 'advance') {
    if (fire && target && Math.abs(target.bearing) <= aimTolerance) return { ...proposal, attack: true, ...meta };
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
    fireThreshold: 0.5,
    lowHealth: 40,
    model: undefined,
    log: null,                 // JSONL path
    ...options
  };
  const sdk = await import('@typesafe-ai/sdk');
  const client = config.dryRun ? null : (config.client || new sdk.TypeSafeClient(config.model ? { defaultModel: config.model } : {}));
  const stats = {
    version: JEV_POLICY_VERSION, dryRun: config.dryRun, eligibleSteps: 0, calls: 0, overrides: 0,
    capped: false, errors: 0, inputTokens: 0, outputTokens: 0, latencyMsTotal: 0, modes: {}
  };
  let stepsSinceCall = Infinity;
  let dodgeSide = 1;
  let lastDecision = null;

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
      return lastDecision ? answersToCommand(lastDecision.answers, lastDecision.compact, proposal, { ...config, dodgeSide }) : null;
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
    if (mode === 'dodge') dodgeSide *= -1;
    lastDecision = { answers: result.answers, compact };
    const command = answersToCommand(result.answers, compact, proposal, { ...config, dodgeSide });
    if (command) stats.overrides++;
    await record({
      kind: 'jev_decision', tic: state.levelTime, latencyMs: latency, model: result.model, usage: result.usage,
      state: compact, answers: result.answers, proposal, command
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
