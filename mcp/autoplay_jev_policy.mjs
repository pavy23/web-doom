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

export const JEV_POLICY_VERSION = '0.6.2-jev-policy';

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
      context: 'Fighting stops the player and exposes it to every enemy with a clear shot, but kills the threat. Retreating opens distance while keeping the target in front; it helps against melee monsters and slow projectiles, but hitscan enemies (zombieman, shotgun guy) hit just as often at range, so against them it only prolongs the exposure. Dodging keeps route progress but only helps against projectiles.'
    }, {
      fight: 'stop moving, face the chosen enemy and shoot until it dies',
      retreat: 'move backwards away from the enemies while facing them',
      dodge: 'keep advancing but strafe sideways to avoid projectiles'
    }),
    target: choice({
      question: 'If the player shoots, which enemy is the best target?',
      context: 'Prefer the enemy that can hurt the player most in the next second: a shotgun guy or a melee monster in reach before an imp at range, an imp before a zombieman. Among equals, the closest.'
    }, targetLabels),
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

// Measured from step logs (angle delta over pure-turn steps, n=191):
// one turn unit for one tic rotates 7.0 degrees (median; p10-p90 6.1-7.0).
export const DEGREES_PER_TURN_TIC = 7;
const MAX_TURN = 0.7;

// Exact aim: the turn and tic count that put the bearing at zero in one
// step, capped at 4 tics (~20 degrees); larger bearings take another step.
// relativeAngle > 0 is to the left (geometric CCW); agent +turn is right.
export function aimStep(bearing) {
  const degrees = Math.abs(Number(bearing) || 0);
  const tics = Math.max(1, Math.min(4, Math.ceil(degrees / (DEGREES_PER_TURN_TIC * MAX_TURN))));
  const magnitude = Math.min(MAX_TURN, degrees / (DEGREES_PER_TURN_TIC * tics));
  return { turn: bearing > 0 ? -magnitude : magnitude, tics };
}
function turnToward(bearing, max = MAX_TURN) {
  return Math.max(-max, Math.min(max, aimStep(bearing).turn));
}
function aimTics(bearing) {
  return aimStep(bearing).tics;
}

// Monsters whose attack is hitscan: distance and backing away do not reduce
// their hit chance, only killing them or breaking line of sight does.
const HITSCAN = new Set(['zombieman', 'shotgun_guy', 'chaingun_guy', 'heavy_weapon_dude', 'spider_mastermind']);
function isHitscan(name) {
  return HITSCAN.has(String(name || '').toLowerCase().replace(/\s+/g, '_'));
}

// Sticky target: once fighting an enemy, keep it while a same-named enemy is
// still near where it was (bearing / distance continuity). Enemy ids are
// nearest-first indices and re-sort every step, so two shotgun guys at
// similar range swapped id every consultation and the aim thrashed.
export function pickTarget(compact, wanted, last) {
  return pickTargetInfo(compact, wanted, last).enemy;
}
export function pickTargetInfo(compact, wanted, last) {
  const enemies = compact.visibleEnemies;
  if (last) {
    const same = enemies.filter(enemy => enemy.name === last.name && Number(enemy.health) > 0
      && Math.abs(Number(enemy.bearing) - Number(last.bearing)) <= 30 && Math.abs(Number(enemy.distance) - Number(last.distance)) <= 90);
    if (same.length) return { enemy: same.sort((a, b) => Math.abs(a.bearing - last.bearing) - Math.abs(b.bearing - last.bearing))[0], sticky: true };
  }
  return { enemy: enemies.find(enemy => enemy.id === wanted) || enemies[0] || null, sticky: false };
}

// How much an enemy can hurt the player right now. Shotgun guys and melee
// monsters in reach outrank everything; imps only matter up close (their
// fireballs are slow); zombiemen are the least of it.
export function threatRank(enemy) {
  const name = String(enemy.name || '').toLowerCase().replace(/\s+/g, '_');
  const distance = Number(enemy.distance);
  if (name === 'shotgun_guy') return 3;
  if ((name === 'demon' || name === 'spectre') && distance <= 160) return 4;
  if (name === 'imp') return distance <= 128 ? 3 : 1;
  if (name === 'zombieman') return 2;
  return 1;
}
export function topThreat(compact) {
  const able = compact.visibleEnemies.filter(enemy => enemy.canHitPlayerNow && Number(enemy.health) > 0);
  if (!able.length) return null;
  return able.sort((a, b) => threatRank(b) - threatRank(a) || Number(a.distance) - Number(b.distance))[0];
}

// Map typed answers onto a bounded ticcmd. Returns null to keep the proposal.
export function answersToCommand(rawAnswers, compact, proposal, options = {}) {
  const answers = resolveMode(rawAnswers, options);
  const aimTolerance = Number(options.aimTolerance ?? 8);
  const enemyById = new Map(compact.visibleEnemies.map(enemy => [enemy.id, enemy]));
  const rules = [];
  // A forced fight (stall rule) always aims at the nearest enemy, which is the
  // one blocking the player; otherwise the model's target, falling back to nearest.
  const picked = options.forceMode === 'fight'
    ? pickTargetInfo(compact, null, options.lastTarget)
    : pickTargetInfo(compact, answers.target?.choice, options.lastTarget);
  let target = picked.enemy;
  void enemyById;
  // threatTarget: when not already locked on a target, shoot what can hurt
  // the player most right now (a shotgun guy before a zombieman at the same
  // range). The hangar's 27-72 hp spread came largely from the order enemies
  // were shot in.
  if (options.threatPriority !== false && !picked.sticky && target) {
    const threat = topThreat(compact);
    if (threat && threat.id !== target.id && threatRank(threat) > threatRank(target)) { target = threat; rules.push('threatTarget'); }
  }
  const pointBlank = Boolean(target) && Number(target.distance) <= Number(options.pointBlankDistance ?? 96);
  let fire = Number(answers.fire?.noul ?? 0) >= Number(options.fireThreshold ?? 0.4);
  if (pointBlank && !fire) { fire = true; rules.push('pointBlank'); }
  let mode = answers.mode?.choice;
  if (options.forceMode && options.forceMode !== mode) { mode = options.forceMode; rules.push('stall'); }
  else if (options.forceMode) { rules.push('stall'); }
  if (options.forceMode === 'fight') fire = true;
  // Retreating from a hitscan enemy that can already hit the player only
  // prolongs the exposure (its hit chance does not fall with distance):
  // shoot it instead. Retreat stays for projectile and melee monsters.
  if (mode === 'retreat' && target && isHitscan(target.name) && target.canHitPlayerNow) {
    mode = 'fight'; fire = true; rules.push('hitscanFight');
  }
  // lowHealthHold: under `lowHealth` with something able to hit the player,
  // never advance into it; every UV death came from walking into the
  // courtyard at ~44 hp. Fight from where the player stands instead.
  const shooters = Number(compact.threat?.enemiesThatCanHitPlayerNow ?? 0);
  if (mode === 'advance' && target && shooters > 0 && Number(compact.player?.health) < Number(options.lowHealth ?? 40)) {
    mode = 'fight'; fire = true; rules.push('lowHealthHold');
  }
  // cover: fighting two or more shooters in the open, close to the point
  // where the player entered this edge (the doorway it came through), back
  // up to that point while keeping the target in front. In a doorway the
  // enemies arrive one or two at a time instead of all at once.
  const cover = options.cover;
  const takeCover = mode === 'fight' && target && shooters >= 2 && cover
    && cover.distance > Number(options.coverArrive ?? 40) && cover.distance <= Number(options.coverMaxDistance ?? 300);
  if (takeCover) { mode = 'cover'; rules.push('cover'); }
  const meta = { source: 'jev', mode, target: target?.id || 'none', fire, danger: round(answers.danger?.score ?? 0, 2), ...(rules.length ? { rules } : {}) };

  if (takeCover) {
    const aligned = Math.abs(target.bearing) <= aimTolerance;
    const aim = aligned ? 0 : turnToward(target.bearing, 0.4);
    if (Math.abs(cover.bearing) > 135) {
      // entry point roughly behind: backpedal while aiming
      return { forward: -0.6, strafe: 0, turn: aim, attack: fire && aligned, use: false, tics: 3, ...meta };
    }
    // entry point to the side: strafe toward it while facing the target
    const side = cover.bearing > 0 ? -1 : 1; // positive bearing = left; agent -strafe = left
    return { forward: Math.abs(cover.bearing) > 90 ? -0.3 : 0.3, strafe: 0.6 * side, turn: aim, attack: fire && aligned, use: false, tics: 3, ...meta };
  }

  if (!target || mode === 'advance') {
    if (fire && target && Math.abs(target.bearing) <= aimTolerance) return { ...proposal, attack: true, ...meta };
    // Not aligned: keep the route command untouched. Turning toward a
    // point-blank enemy while advancing was tried and it stalled the follower
    // on monsters behind the player, which the stall rule then fought.
    return null;
  }
  const aligned = Math.abs(target.bearing) <= aimTolerance;
  if (mode === 'fight') {
    if (!aligned) return { forward: 0, strafe: 0, turn: turnToward(target.bearing), attack: false, use: false, tics: aimTics(target.bearing), ...meta };
    // fightFires: having chosen to stand and fight, an aligned shot at an
    // enemy that can hit back is never withheld. With one shell left the
    // model answered fire 0.2 and the player stood still, aimed, unhurt and
    // silent, for 130 tics while a zombieman walked up to it.
    let attack = fire;
    if (!attack && target.canHitPlayerNow) { attack = true; rules.push('fightFires'); meta.rules = rules; meta.fire = true; }
    return { forward: 0, strafe: 0, turn: 0, attack, use: false, tics: 3, ...meta };
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
    rulesOnly: false,          // control: never ask the model; the safety rules and loot still run
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
    coverHold: false,          // back up to the edge entry point when fighting 2+ shooters near it.
                               // Off: the entry point is not a doorway in the LOS sense, and the
                               // UV trial with it on went 1/3 (from 3/3) with the player shot
                               // while backing up in the open. Needs map LOS geometry to be real.
    coverMaxDistance: 300,     // only when the entry point is this close
    coverArrive: 40,           // ... and stop backing up inside this distance of it
    lootShotgun: true,         // after killing a shotgun guy with the pistol, walk over its dropped shotgun
    lootTimeoutTics: 140,      // give a detour at most 4 s
    items: [],                 // static map pickups (autoplay_items.mjs) for health / shells loot
    itemLootSameSectorOnly: true, // only items in the player's current sector: 12 of 16 straight-line
                                  // detours in the 0.6.0 trial ended at a wall
    lootShells: false,         // shells detours: 7 of 9 blocked in 0.6.0, low value with 4-shell drops around
    healthLootBelow: 50,       // walk to a health item below this ...
    healthLootDesperate: 30,   // ... even under fire below this
    shellsLootBelow: 6,        // walk to shells when the shotgun has fewer than this
    itemLootRadius: 256,       // only items this close (straight line; walls end it via the stall check)
    threatPriority: true,      // retarget to the most dangerous enemy in reach when not locked on
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
  const client = (config.dryRun || config.rulesOnly) ? null : (config.client || new sdk.TypeSafeClient(config.model ? { defaultModel: config.model } : {}));
  // Answers the rules-only control substitutes for the model: always safe
  // to run, no target preference, no fire. Every override then comes from
  // a code rule (pointBlank, stall, loot, ...), which is the point.
  const RULES_ONLY_ANSWERS = {
    safeToRun: { type: 'noul', noul: 1 }, response: { type: 'choice', choice: 'fight', probabilities: { fight: 1 } },
    target: { type: 'choice', choice: 'enemy_0' }, fire: { type: 'noul', noul: 0 }, danger: { type: 'score', score: 0 }
  };
  const stats = {
    version: JEV_POLICY_VERSION, dryRun: config.dryRun, rulesOnly: config.rulesOnly, eligibleSteps: 0, calls: 0, overrides: 0,
    capped: false, errors: 0, inputTokens: 0, outputTokens: 0, latencyMsTotal: 0, modes: {},
    rules: { stall: 0, dodgeHold: 0, pointBlank: 0, noRetreatFar: 0, hitscanFight: 0, lowHealthHold: 0, cover: 0, threatTarget: 0, fightFires: 0, lootSteps: 0, lootPicked: 0, lootGivenUp: 0 },
    loot: { shotgun: 0, health: 0, shells: 0 }
  };
  const takenItems = new Set();
  let lastItemCount = null;
  // Enemies that can hit the player right now, from the raw state (cheap,
  // used before any consultation to decide whether a detour is safe).
  function shootersNow(state) {
    return (state?.enemies || []).filter(enemy => enemy.lineOfSight && Number(enemy.health) > 0 && Number(enemy.distance) <= effectiveRange(enemy.name)).length;
  }
  function nearestItem(state, kind) {
    const player = state.player || {};
    let best = null;
    const sector = Number(state.currentSector);
    for (const item of config.items || []) {
      if (item.kind !== kind || takenItems.has(item.id)) continue;
      if (config.itemLootSameSectorOnly && item.sector != null && Number(item.sector) !== sector) continue;
      const distance = Math.hypot(item.x - Number(player.x), item.y - Number(player.y));
      if (distance <= config.itemLootRadius && (!best || distance < best.distance)) best = { ...item, distance };
    }
    return best;
  }
  let edgeEntry = null;        // { edgeId, x, y }: where the player entered the current edge (its doorway)
  function coverInfo(context) {
    const edgeId = context.edge?.id || 'exit';
    const player = context.state?.player || {};
    if (!edgeEntry || edgeEntry.edgeId !== edgeId) edgeEntry = { edgeId, x: Number(player.x), y: Number(player.y) };
    if (!config.coverHold) return null;
    const dx = edgeEntry.x - Number(player.x);
    const dy = edgeEntry.y - Number(player.y);
    const distance = Math.hypot(dx, dy);
    let bearing = Math.atan2(dy, dx) * 180 / Math.PI - Number(player.angle);
    while (bearing > 180) bearing -= 360;
    while (bearing < -180) bearing += 360;
    return { distance: round(distance), bearing: round(bearing) };
  }
  let lastMode = null;
  let lastTarget = null;       // the enemy fought at the previous consultation (sticky target)
  let lastKills = null;
  let loot = null;             // { x, y, sinceTic, shells } dropped shotgun to walk over

  // World position of an enemy from the player's pose and the enemy's polar
  // coordinates (relativeAngle > 0 = left = CCW, matching the follower).
  function enemyWorldPosition(player, enemy) {
    const heading = (Number(player.angle) + Number(enemy.bearing)) * Math.PI / 180;
    return { x: Number(player.x) + Number(enemy.distance) * Math.cos(heading), y: Number(player.y) + Number(enemy.distance) * Math.sin(heading) };
  }

  // Loot rule: a kill while the pistol is out and the last fight target was a
  // shotgun guy means a shotgun lies where it stood; walk over it. No API
  // call is spent on these steps. Ends on pickup (shells rise or the weapon
  // switches), on arrival with nothing there, or on the timeout.
  function lootPicked(state) {
    const player = state.player || {};
    const shells = Number(player.ammo?.shells ?? 0);
    if (loot.kind === 'shotgun') return Number(player.weapon) === 2 || shells > loot.base.shells;
    if (loot.kind === 'health') return Number(player.health) > loot.base.health;
    if (loot.kind === 'shells') return shells > loot.base.shells;
    return Number(player.items ?? 0) > loot.base.items;
  }
  async function lootStep(state) {
    const player = state.player || {};
    const tic = Number(state.levelTime);
    const picked = lootPicked(state);
    const dist = Math.hypot(loot.x - Number(player.x), loot.y - Number(player.y));
    // No progress toward the item for several steps means a wall is in the
    // way (items are targeted in a straight line): give it up.
    loot.noProgress = dist >= loot.lastDist - 1 ? loot.noProgress + 1 : 0;
    loot.lastDist = dist;
    if (picked || dist < 20 || tic - loot.sinceTic > config.lootTimeoutTics || loot.noProgress >= 8) {
      if (picked) { stats.rules.lootPicked++; stats.loot[loot.kind] = (stats.loot[loot.kind] || 0) + 1; } else stats.rules.lootGivenUp++;
      if (loot.itemId) takenItems.add(loot.itemId); // picked, or not there / unreachable: do not try again
      await record({ kind: 'loot_end', tic, lootKind: loot.kind, picked, distance: round(dist), tics: tic - loot.sinceTic, reason: picked ? 'picked' : dist < 20 ? 'arrived_empty' : loot.noProgress >= 8 ? 'blocked' : 'timeout' });
      loot = null;
      return null;
    }
    let desired = Math.atan2(loot.y - Number(player.y), loot.x - Number(player.x)) * 180 / Math.PI;
    let delta = desired - Number(player.angle);
    while (delta > 180) delta -= 360;
    while (delta < -180) delta += 360;
    stats.rules.lootSteps++;
    const meta = { source: 'jev', mode: 'loot', target: 'none', fire: false, danger: 0, rules: ['loot'] };
    if (Math.abs(delta) > 12) { const aim = aimStep(delta); return { forward: 0, strafe: 0, turn: aim.turn, attack: false, use: false, tics: aim.tics, ...meta }; }
    return { forward: 0.62, strafe: 0, turn: aimStep(delta).turn, attack: false, use: false, tics: 3, ...meta };
  }

  async function startLoot(state, kind, x, y, itemId = null) {
    const player = state.player || {};
    loot = {
      kind, x, y, itemId, sinceTic: Number(state.levelTime), lastDist: Infinity, noProgress: 0,
      base: { shells: Number(player.ammo?.shells ?? 0), health: Number(player.health), items: Number(player.items ?? 0) }
    };
    await record({ kind: 'loot_start', tic: loot.sinceTic, lootKind: kind, itemId, x: round(x), y: round(y), from: { x: round(player.x), y: round(player.y) }, health: player.health, shells: loot.base.shells });
  }

  async function lootCheck(state) {
    const player = state?.player || {};
    const kills = Number(player.kills ?? 0);
    const killedNow = lastKills != null && kills > lastKills;
    lastKills = kills;
    // Items the route walked over by itself: mark the nearest one taken so
    // it is never targeted later.
    const itemCount = Number(player.items ?? 0);
    if (lastItemCount != null && itemCount > lastItemCount && !loot) {
      let nearest = null;
      for (const item of config.items || []) {
        if (takenItems.has(item.id)) continue;
        const d = Math.hypot(item.x - Number(player.x), item.y - Number(player.y));
        if (d <= 64 && (!nearest || d < nearest.d)) nearest = { id: item.id, d };
      }
      if (nearest) takenItems.add(nearest.id);
    }
    lastItemCount = itemCount;
    if (loot) return;
    if (config.lootShotgun && killedNow && lastTarget?.name === 'shotgun_guy' && lastTarget.world && Number(player.weapon) === 1) {
      return startLoot(state, 'shotgun', lastTarget.world.x, lastTarget.world.y);
    }
    if (!(config.items || []).length) return;
    const health = Number(player.health);
    const shooters = shootersNow(state);
    if (health < config.healthLootBelow && (shooters === 0 || health < config.healthLootDesperate)) {
      const item = nearestItem(state, 'health');
      if (item) return startLoot(state, 'health', item.x, item.y, item.id);
    }
    if (config.lootShells && Number(player.weapon) === 2 && Number(player.ammo?.shells ?? 0) < config.shellsLootBelow && shooters === 0) {
      const item = nearestItem(state, 'shells');
      if (item) return startLoot(state, 'shells', item.x, item.y, item.id);
    }
  }
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

  function ruleOptions(compact, state, context) {
    const stalled = detectStall(state, compact);
    return { ...config, dodgeSide, lastTarget, cover: context ? coverInfo(context) : null, ...(stalled ? { forceMode: 'fight' } : {}) };
  }
  function rememberTarget(command, compact, state) {
    if (!command || !['fight', 'retreat', 'advance', 'cover'].includes(command.mode) || !command.attack) {
      if (!command || !['fight', 'retreat', 'cover'].includes(command.mode)) { lastTarget = null; return; }
    }
    const enemy = compact.visibleEnemies.find(item => item.id === command.target) || null;
    lastTarget = enemy ? { ...enemy, world: enemyWorldPosition(state.player || {}, enemy) } : null;
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
    coverInfo(context); // keep the edge entry point current even on steps that are not consulted
    await lootCheck(state);
    if (loot) {
      const lootCommand = await lootStep(state);
      if (lootCommand) { stats.overrides++; return lootCommand; }
    }
    if (!consult) return null;
    stats.eligibleSteps++;
    if (stepsSinceCall < config.minStepsBetweenCalls) {
      // Reuse the last judgment for a short hold without paying again.
      return lastDecision ? answersToCommand(lastDecision.answers, lastDecision.compact, proposal, ruleOptions(lastDecision.compact, state, context)) : null;
    }
    if (stats.calls >= config.maxCalls) { stats.capped = true; return null; }

    const compact = compactState(state, { ...context, maxEnemies: config.maxEnemies, meleeRange: config.meleeRange, recentDamage: lost });
    const questions = buildQuestions(compact, sdk);
    const request = { state: compact, questions, ...(config.model ? { model: config.model } : {}) };
    stepsSinceCall = 0;

    if (config.rulesOnly) {
      const answers = resolveMode(RULES_ONLY_ANSWERS, { ...config, lastMode });
      lastMode = answers.mode.choice;
      const options = ruleOptions(compact, state, context);
      const command = answersToCommand(answers, compact, proposal, options);
      rememberTarget(command, compact, state);
      if (command) stats.overrides++;
      for (const rule of command?.rules || []) stats.rules[rule] = (stats.rules[rule] || 0) + 1;
      if (command) await record({ kind: 'rules_decision', tic: state.levelTime, state: compact, answers, proposal, command, ...(options.forceMode ? { forced: options.forceMode } : {}) });
      return command;
    }
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
    const options = ruleOptions(compact, state, context);
    const command = answersToCommand(result.answers, compact, proposal, options);
    rememberTarget(command, compact, state);
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
