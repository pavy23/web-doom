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

export const JEV_POLICY_VERSION = '0.4.1-jev-policy';

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
// Distance inside which each monster actually lands damage on a moving
// player. Vanilla hitscan accuracy falls off with range and the shotgun's
// pellet spread makes it harmless past ~300 units; imp fireballs are slow
// enough to sidestep beyond ~450. A single 640 cut-off made the model treat
// a shotgun guy at 630 units as a shooter and retreat from it.
const EFFECTIVE_RANGE = { zombieman: 480, shotgun_guy: 320, imp: 450, demon: 80, spectre: 80, lost_soul: 400, cacodemon: 500 };
const DEFAULT_EFFECTIVE_RANGE = 400;
function effectiveRange(name) {
  const key = String(name || '').toLowerCase().replace(/\s+/g, '_');
  return EFFECTIVE_RANGE[key] ?? DEFAULT_EFFECTIVE_RANGE;
}

// What each monster does to the player, in the model's terms. Vanilla damage
// figures (Doom wiki): zombieman 3-15 per shot, shotgun guy 3 pellets x 3-15,
// imp fireball 3-24 / claw 3-24, demon bite 4-40. Names as doom_control.c emits them.
const THREAT_NOTES = {
  zombieman: 'hitscan pistol, 3-15 damage per shot, dies to 4 pistol shots',
  shotgun_guy: 'hitscan shotgun, up to 45 damage per blast, the deadliest thing on E1M1 inside 200 units; dies to 3 pistol shots',
  imp: 'throws slow fireballs (3-24, can be dodged), claws in melee (3-24); dies to 6 pistol shots',
  demon: 'fast melee only, 4-40 per bite, takes 15 pistol shots; keep away',
  spectre: 'invisible demon, fast melee only; keep away',
  lost_soul: 'flying charger, 3-24 per hit',
  cacodemon: 'flying, slow fireballs 5-40; very tough',
  baron_of_hell: 'very tough, avoid with a weak weapon'
};
function threatNote(name) {
  const key = String(name || '').toLowerCase().replace(/\s+/g, '_');
  return THREAT_NOTES[key] || 'unknown monster';
}

function round(value, digits = 0) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

// Compact, named-field state for the model. Only what the questions need.
export function compactState(state, context = {}) {
  const player = state?.player || {};
  const weaponIndex = Number(player.weapon ?? 1);
  const ammoKind = AMMO_FOR_WEAPON[weaponIndex] || null;
  // In view or in line of sight, plus anything inside melee range whatever the
  // view cone says: a monster clawing from the side is the one that matters.
  const meleeRange = Number(context.meleeRange ?? 96);
  const enemies = (state?.enemies || [])
    .filter(enemy => enemy.visible || enemy.lineOfSight || Number(enemy.distance) <= meleeRange)
    .sort((a, b) => Number(a.distance) - Number(b.distance))
    .slice(0, Number(context.maxEnemies || 5))
    .map((enemy, index) => ({
      id: `enemy_${index}`,
      name: enemy.name,
      threat: threatNote(enemy.name),
      health: Number(enemy.health),
      distance: round(enemy.distance),
      bearing: round(enemy.relativeAngle),
      bearingNote: 'degrees, positive = to the left, 0 = straight ahead',
      inView: Boolean(enemy.visible),
      lineOfSight: Boolean(enemy.lineOfSight),
      canHitPlayerNow: Boolean(enemy.lineOfSight) && Number(enemy.distance) <= effectiveRange(enemy.name)
    }));
  const shooters = enemies.filter(enemy => enemy.canHitPlayerNow).length;
  const recentDamage = Number(context.recentDamage ?? 0);
  return {
    game: 'DOOM (1993) single player. The player must reach the level exit alive.',
    objective: OBJECTIVE_BRIEF,
    player: {
      health: Number(player.health),
      armor: Number(player.armor),
      healthLostInLast2s: recentDamage,
      healthNote: recentDamage > 0 ? 'the player is being hit right now' : 'not taking damage at the moment',
      weapon: WEAPON_NAMES[weaponIndex] || `weapon ${weaponIndex}`,
      shotsLeft: ammoKind ? Number(player.ammo?.[ammoKind]) : null
    },
    threat: {
      enemiesThatCanHitPlayerNow: shooters,
      note: shooters === 0 ? 'no enemy is close enough to hurt the player at the moment'
        : `${shooters} enem${shooters === 1 ? 'y is' : 'ies are'} close enough to land hits (canHitPlayerNow); hitscan enemies inside their effective range hit a running player too`
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
  // Two-stage mode: a gate ("keep running?") and, for the no case, the
  // response. A single 4-way argmax sat at advance 0.73 for 658 UV
  // consultations in a row while the player died; the 0.27 on "not advance"
  // is the signal, so it gets its own question and its own threshold.
  return {
    safeToRun: noul({
      question: 'Is it safe for the player to keep running along the route right now, without stopping to deal with these enemies?',
      context: `${OBJECTIVE_BRIEF} The player is following a known route to the exit. Judge from the threat block, each enemy's threat note, distance and line of sight, and the health lost in the last two seconds.`
    }),
    response: choice({
      question: 'If the player should NOT keep running, what is the best response for the next fraction of a second?',
      context: 'Fighting stops the player and exposes it to every enemy with a clear shot, but kills the threat. Retreating opens distance while keeping the target in front. Dodging keeps route progress but only helps against projectiles, not hitscan weapons.'
    }, {
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

// Fold the two-stage answers into the `mode` shape the mapper, the log, the
// dashboard and the overlay already read: advance when the gate says running
// is safe (noul >= runThreshold), otherwise the chosen response. The
// probabilities are the joint distribution so the 4-way view stays honest.
export function resolveMode(answers, options = {}) {
  if (answers.mode?.choice) return answers; // already 4-way (older logs, tests)
  const safe = Number(answers.safeToRun?.noul ?? 1);
  const response = answers.response?.choice || 'fight';
  const responseProbs = answers.response?.probabilities || { [response]: 1 };
  // Hysteresis: leaving `advance` needs the gate below threshold - band,
  // returning to it needs threshold + band. Without it the gate flipped
  // 0.85 <-> 0.2 on consecutive steps and the player oscillated in place.
  const threshold = Number(options.runThreshold ?? 0.5);
  const band = Number(options.runHysteresis ?? 0.1);
  const wasAdvancing = options.lastMode == null || options.lastMode === 'advance';
  const advance = wasAdvancing ? safe >= threshold - band : safe >= threshold + band;
  const mode = advance ? 'advance' : response;
  const probabilities = { advance: round(safe, 3) };
  for (const key of ['fight', 'retreat', 'dodge']) probabilities[key] = round((1 - safe) * Number(responseProbs[key] ?? 0), 3);
  return { ...answers, mode: { type: 'choice', choice: mode, confidence: round(Math.abs(safe - 0.5) * 2, 2), probabilities, derivedFrom: 'safeToRun+response' } };
}

function turnToward(bearing, max = 0.7) {
  // relativeAngle > 0 is to the left (geometric CCW); agent +turn is right.
  // The floor of 0.2 keeps a forced fight from spending 50 tics aligning.
  const magnitude = Math.min(max, Math.max(0.2, Math.abs(bearing) / 90 * 0.7));
  return bearing > 0 ? -magnitude : magnitude;
}

// Map typed answers onto a bounded ticcmd. Returns null to keep the proposal.
export function answersToCommand(rawAnswers, compact, proposal, options = {}) {
  const answers = resolveMode(rawAnswers, options);
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
    // Not aligned: keep the route command untouched. Turning toward a
    // point-blank enemy while advancing was tried and it stalled the follower
    // on monsters behind the player, which the stall rule then fought.
    return null;
  }
  const aligned = Math.abs(target.bearing) <= aimTolerance;
  if (mode === 'fight') {
    if (!aligned) return { forward: 0, strafe: 0, turn: turnToward(target.bearing), attack: false, use: false, tics: 2, ...meta };
    return { forward: 0, strafe: 0, turn: 0, attack: fire, use: false, tics: 3, ...meta };
  }
  if (mode === 'retreat') {
    // Backing away from an enemy that is already out of its effective range
    // gives up route progress for nothing: keep the route command instead
    // (and shoot if aligned). The model asked to retreat from a shotgun guy
    // at 600 units for 280 tics before this guard existed.
    if (Number(target.distance) > Number(options.retreatMaxDistance ?? 320)) {
      rules.push('noRetreatFar');
      meta.rules = rules;
      meta.mode = 'advance';
      return fire && aligned ? { ...proposal, attack: true, ...meta } : null;
    }
    return { forward: -0.6, strafe: 0, turn: aligned ? 0 : turnToward(target.bearing, 0.4), attack: fire && aligned, use: false, tics: 4, ...meta };
  }
  if (mode === 'dodge') {
    const side = options.dodgeSide ?? 1;
    return { ...proposal, forward: Number(proposal.forward ?? 0.5), strafe: 0.6 * side, attack: fire && aligned, tics: 3, ...meta };
  }
  return null;
}

// Decide when a judgment is worth paying for: an enemy in view, low health,
// an enemy inside melee range even outside the view cone, or health that just
// dropped (something unseen is hitting the player). The last two came from a
// run where an Imp clawed the player from the side for 250 tics while the
// "visible enemy" gate stayed shut and no rule could fire.
export function shouldConsult(state, options = {}, memory = {}) {
  const visible = Number(state?.visibleEnemyCount ?? 0);
  const health = Number(state?.player?.health ?? 100);
  const meleeRange = Number(options.meleeRange ?? 96);
  const inReach = (state?.enemies || []).some(enemy => Number(enemy.distance) <= meleeRange && Number(enemy.health) > 0);
  const hurt = memory.lastHealth != null && health < Number(memory.lastHealth);
  return visible > 0 || health < Number(options.lowHealth ?? 40) || inReach || hurt;
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
    runThreshold: 0.5,         // safeToRun noul at or above this keeps advancing
    runHysteresis: 0.1,        // band around runThreshold before the mode flips
    retreatMaxDistance: 320,   // retreat only from enemies inside this distance
    recentWindowTics: 70,      // "health lost in the last 2 s" window
    model: undefined,
    log: null,                 // JSONL path
    onDecision: null,          // async (entry) => void, called after every consultation (overlay, live views)
    ...options
  };
  const sdk = await import('@typesafe-ai/sdk');
  const client = config.dryRun ? null : (config.client || new sdk.TypeSafeClient(config.model ? { defaultModel: config.model } : {}));
  const stats = {
    version: JEV_POLICY_VERSION, dryRun: config.dryRun, eligibleSteps: 0, calls: 0, overrides: 0,
    capped: false, errors: 0, inputTokens: 0, outputTokens: 0, latencyMsTotal: 0, modes: {},
    rules: { stall: 0, dodgeHold: 0, pointBlank: 0, noRetreatFar: 0 }
  };
  let lastMode = null;
  let stepsSinceCall = Infinity;
  let dodgeSide = 1;
  let dodgeRun = 0;            // consecutive dodge answers on the current side
  let lastDecision = null;
  const positions = [];        // player position at each consultation, newest last

  // Stall rule: no net progress across the last `stallWindow` consultations
  // with the nearest enemy in melee range, and that enemy is either in the
  // front half (it can block the corridor) or the player lost health during
  // the window (it is hitting from wherever it is). A monster behind a
  // moving player never qualifies: fighting it would only stop the run.
  function detectStall(state, compact) {
    const player = state?.player || {};
    positions.push({ x: Number(player.x), y: Number(player.y), tic: Number(state?.levelTime), health: Number(player.health) });
    if (positions.length > config.stallWindow) positions.shift();
    if (positions.length < config.stallWindow) return false;
    const first = positions[0];
    const last = positions[positions.length - 1];
    const moved = Math.hypot(last.x - first.x, last.y - first.y);
    const nearest = compact.visibleEnemies[0];
    if (!nearest || moved >= config.stallDistance || Number(nearest.distance) > config.meleeRange) return false;
    const hurt = first.health - last.health > 0;
    const inFront = Math.abs(Number(nearest.bearing)) <= 90;
    return hurt || inFront;
  }

  function ruleOptions(compact, state) {
    const stalled = detectStall(state, compact);
    return { ...config, dodgeSide, ...(stalled ? { forceMode: 'fight' } : {}) };
  }

  async function record(entry) {
    if (config.log) await appendFile(config.log, `${JSON.stringify({ run: config.runIndex ?? 0, ...entry })}\n`);
    if (typeof config.onDecision === 'function') {
      try { await config.onDecision({ ...entry, stats: summary() }); } catch { /* a viewer must never break a trial */ }
    }
  }

  let lastHealth = null;
  const healthHistory = [];   // { tic, health } per step, for the recent-damage window
  function recentDamage(state) {
    const tic = Number(state?.levelTime ?? 0);
    const health = Number(state?.player?.health ?? 0);
    healthHistory.push({ tic, health });
    while (healthHistory.length && healthHistory[0].tic < tic - config.recentWindowTics) healthHistory.shift();
    const peak = Math.max(...healthHistory.map(h => h.health));
    return Math.max(0, peak - health);
  }
  async function decide(context) {
    const { state, proposal } = context;
    stepsSinceCall++;
    const consult = shouldConsult(state, config, { lastHealth });
    lastHealth = Number(state?.player?.health ?? lastHealth);
    const lost = recentDamage(state);
    if (!consult) return null;
    stats.eligibleSteps++;
    if (stepsSinceCall < config.minStepsBetweenCalls) {
      // Reuse the last judgment for a short hold without paying again.
      return lastDecision ? answersToCommand(lastDecision.answers, lastDecision.compact, proposal, ruleOptions(lastDecision.compact, state)) : null;
    }
    if (stats.calls >= config.maxCalls) { stats.capped = true; return null; }

    const compact = compactState(state, { ...context, maxEnemies: config.maxEnemies, meleeRange: config.meleeRange, recentDamage: lost });
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
    result.answers = resolveMode(result.answers, { ...config, lastMode });
    const mode = result.answers.mode?.choice;
    lastMode = mode;
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
