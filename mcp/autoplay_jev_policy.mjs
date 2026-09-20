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
import { coverPoint, lineOfWalk, movementHazard } from './navigation_graph.js';

export const JEV_POLICY_VERSION = '1.4.0-jev-policy';

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
    // What kind of level this is (autoplay_map_profile.mjs). Without it every
    // level reads the same to the model: six monsters with two stimpacks and
    // forty-five with ten look identical from one consultation.
    ...(context.profile ? {
      level: {
        kind: context.profile.brief,
        monstersOnRoute: context.profile.monsters.onRoute,
        killedSoFar: Number(player.kills ?? 0),
        healthPickupsOnRoute: context.profile.items.onRoute.health
      }
    } : {}),
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
// Monsters whose ranged attack is a projectile: sidestepping works, standing
// still (or backing straight away) does not.
const PROJECTILE = new Set(['imp', 'cacodemon', 'baron_of_hell', 'hell_knight', 'revenant', 'mancubus', 'arachnotron', 'cyberdemon']);
// How far each weapon is worth standing still for. The shotgun's pellets
// spread past ~300 units and the fists reach 64; holding position to fire
// beyond these is time spent being shot for almost no damage dealt.
// Indexed by weapontype_t.
const WEAPON_RANGE = [64, 700, 320, 700, 900, 900, 900, 64, 240];
export function weaponRange(weapon) {
  const index = Number(weapon);
  return Number.isFinite(index) && WEAPON_RANGE[index] != null ? WEAPON_RANGE[index] : 700;
}
export function isProjectile(name) { return PROJECTILE.has(String(name || '').toLowerCase()); }
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
  // barrelBlock: a barrel stands in the line of fire, close enough that its
  // blast reaches the shooter. One shot into a barrel 44 units away is 97
  // damage, which is how all ten E1M3 runs at Hey Not Too Rough died at the
  // same tic. Hold fire whatever the model and the other fire rules say, and
  // step out of the line rather than stand in it.
  const barrel = options.barrelInAim || null;
  if (barrel) { fire = false; rules.push('barrelBlock'); }
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
  // projectileStrafe: against a projectile monster (imp) beyond point-blank
  // range, fighting and retreating both keep the player moving sideways.
  // Every E1M3 run took the same two fireballs at tics 699 and 731, once
  // backing straight away and once standing still; a fireball at 220 units
  // is 20 tics away and a sidestep of 60 units clears it.
  // coverFight: holding a cover spot, every mode fights from where the
  // player stands (no strafe, no backpedal, no dodge out of the corner).
  if (options.holdPosition && mode !== 'advance') { mode = 'fight'; meta.mode = 'fight'; rules.push('coverFight'); meta.rules = rules; }
  const strafeVs = options.projectileStrafe !== false && options.strafeRoomClear !== false && !options.holdPosition && isProjectile(target.name) && !pointBlank
    ? 0.5 * Number(options.dodgeSide ?? 1) : 0;
  if (strafeVs) { rules.push('projectileStrafe'); meta.rules = rules; }
  // noFightFar: standing still to shoot a target the weapon cannot reach is
  // time spent being shot for nothing. Seven tic-identical E1M3 runs died
  // holding position with a shotgun against an imp 348 units away. Keep the
  // route command and fire only when it comes into range. Melee range
  // overrides: something that close is dealt with wherever it stands.
  if (mode === 'fight' && !options.holdPosition && !pointBlank
      && Number(target.distance) > weaponRange(options.playerWeapon) * Number(options.weaponRangeSlack ?? 1.1)) {
    rules.push('noFightFar');
    meta.rules = rules;
    meta.mode = 'advance';
    if (fire && aligned) return { ...proposal, attack: true, ...meta };
    // Null hands the step back to the route follower, which loses the rule
    // names with the command, so the counter is bumped here instead.
    if (typeof options.onRule === 'function') options.onRule('noFightFar');
    return null;
  }
  if (mode === 'fight') {
    if (!aligned) return { forward: 0, strafe: strafeVs, turn: turnToward(target.bearing), attack: false, use: false, tics: aimTics(target.bearing), ...meta };
    // fightFires: having chosen to stand and fight, an aligned shot at an
    // enemy that can hit back is never withheld. With one shell left the
    // model answered fire 0.2 and the player stood still, aimed, unhurt and
    // silent, for 130 tics while a zombieman walked up to it.
    if (barrel) {
      // Aligned on the target and a barrel is in the way: sidestep so the
      // barrel falls off the line, keeping the facing. Agent +strafe is
      // right, so step away from the side the barrel sits on.
      const away = Number(barrel.bearing) > 0 ? 1 : -1;
      return { forward: 0, strafe: 0.6 * away, turn: 0, attack: false, use: false, tics: 3, ...meta };
    }
    let attack = fire;
    if (!attack && target.canHitPlayerNow) { attack = true; rules.push('fightFires'); meta.rules = rules; meta.fire = true; }
    return { forward: 0, strafe: strafeVs, turn: 0, attack, use: false, tics: 3, ...meta };
  }
  if (mode === 'retreat' && Number(options.targetDrift ?? 0) > Number(options.retreatDriftLimit ?? 192)) {
    // Already this far off the route target: stand and fight rather than give
    // up more ground.
    mode = 'fight';
    meta.mode = 'fight';
    rules.push('retreatDrift');
    meta.rules = rules;
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
    return { forward: strafeVs ? -0.4 : -0.6, strafe: strafeVs, turn: aligned ? 0 : turnToward(target.bearing, 0.4), attack: fire && aligned, use: false, tics: 4, ...meta };
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
  // An enemy with a clear shot from outside the view cone (behind, at the
  // side) is a reason as good as one in view: E1M3 runs stood at a door for
  // 130 tics while a zombieman behind them shot 33 hp off, the policy turning
  // toward it on the hurt steps and the follower turning back on the others.
  const canHit = options.consultOnCanHit !== false && (state?.enemies || []).some(enemy => enemy.lineOfSight && Number(enemy.health) > 0 && Number(enemy.distance) <= effectiveRange(enemy.name));
  // ... and once engaged, stay engaged for a while (engageHoldTics), so the
  // follower and the policy stop alternating on the heading.
  const engaged = memory.engagedUntilTic != null && Number(state?.levelTime ?? 0) < Number(memory.engagedUntilTic);
  return visible > 0 || health < Number(options.lowHealth ?? 40) || inReach || hurt || canHit || engaged;
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
    // Geometric cover (policy 0.8.0): with two or more hitscan enemies able to
    // hit the player (one below coverLowHealth), walk to the nearest corner of
    // the current sector that no hitscan shooter can see, then hold there and
    // fight what comes around the wall. Every E1M3 key-room death was a
    // pistol duel with two or three shotgun guys in the open.
    coverSeek: true,
    coverShooters: 2,
    coverLowHealth: 50,
    coverSeekMaxDistance: 256,
    coverHoldTics: 70,         // fight from the spot this long before re-evaluating
    coverTimeoutTics: 105,     // give up walking to it after this
    coverMaxPerEdge: 2,        // never more than this many cover moves on one route edge
    // Weapon selection (policy 0.9.0, needs an engine build with
    // doomctl_queue_agent_weapon): the engine switches to a picked-up weapon
    // and back to the pistol when its ammo runs out, but never back again
    // when ammo is picked up later. Every E1M3 fight past the first area was
    // a pistol fight with shells in the pocket. A code rule, no model call:
    // shotgun when shells are in and the pistol is out, chaingun likewise.
    weaponSelect: true,
    weaponSelectHoldTics: 35,  // one request per this many tics (a switch takes ~1 s)
    lootShotgun: true,         // after killing a shotgun guy with the pistol, walk over its dropped shotgun
    lootTimeoutTics: 140,      // give a detour at most 4 s
    items: [],                 // static map pickups (autoplay_items.mjs) for health / shells loot
    // Explosive barrels. A barrel's blast is 128 units at its centre and
    // falls off linearly, so one shot into a barrel 44 units away is 97
    // damage to the shooter: that killed all ten E1M3 runs at Hey Not Too
    // Rough, at the same tic, while the player aimed at a zombieman standing
    // behind it. Nothing in the policy knew barrels existed.
    barrels: [],
    barrelBlast: 128,          // never fire through a barrel closer than this
    barrelAimRadius: 24,       // half-width of the shot cone a barrel blocks
    graph: null,               // navigation graph (with geometry) for the terrain guard and walkable loot
    terrainGuard: true,        // never send a combat/loot step that walks into a wall, a drop or a damaging floor
    guardSidestep: true,       // ... and when the blocked step was a fight or a retreat, sidestep rather than stand still
    guardSidestepStrafe: 0.6,
    projectileStrafe: true,    // strafe while fighting / retreating from projectile monsters ...
    strafeRoom: 64,            // ... only where both sides have this much free floor. The E1M1 HMP ablation
                               // went from 87-89 damage to 18 without the strafe (in the 64-wide exit corridor
                               // it bounced between the guard's flips and the shots stopped landing), while
                               // E1M3 without it took the same two fireballs in every run again
    itemLootSameSectorOnly: true, // only items in the player's current sector: 12 of 16 straight-line
                                  // detours in the 0.6.0 trial ended at a wall ...
    itemLootWalkable: true,       // ... unless the graph shows a clear straight walk to the item (any sector)
    lootShells: true,          // shells detours: 7 of 9 blocked in 0.6.0 (straight-line targeting); on with the walkability test
    healthLootBelow: 70,       // walk to a health item below this (was 50: E1M3 has 29 health items on the route and the runs still ran dry) ...
    lootArmor: true,           // walk to an armor item when the player has less than armorLootBelow armor and nothing is shooting
    armorLootBelow: 50,
    healthLootDesperate: 30,   // ... even under fire below this
    shellsLootBelow: 12,       // walk to shells when the shotgun has fewer than this (a shotgun blast is one shell)
    itemLootRadius: 256,       // only items this close (straight line; walls end it via the stall check)
    threatPriority: true,      // retarget to the most dangerous enemy in reach when not locked on
    pipelineLagTics: 0,        // > 0: pipelined consultation, answers applied this many tics after their state
    pipelineMaxAgeTics: 35,    // re-apply the latest decision for at most this long without a new one
    runThreshold: 0.5,         // safeToRun noul at or above this keeps advancing
    runHysteresis: 0.1,        // band around runThreshold before the mode flips
    retreatMaxDistance: 320,   // retreat only from enemies inside this distance
    // How far a fight may drag the player away from the route target before
    // retreating stops. Without it an E1M2 fight backed the player out of the
    // switch's room, up a lift into another sector, and the trigger approach
    // (which routes inside one sector) could never walk back.
    retreatDriftLimit: 192,
    // How far past a weapon's useful range a fight is still worth standing
    // still for (see WEAPON_RANGE and the noFightFar rule). Seven tic-identical
    // E1M3 runs died holding a shotgun on an imp 348 units away, which is past
    // the range where the pellet spread still lands.
    weaponRangeSlack: 1.1,
    // The terrain brake (see brakeCommand). Measured on E1M2: 10/10 clears at
    // damage 98 with these values, 4/10 to 7/10 with the 1.1.0 pair
    // (minSpeed 4, no consecutive brakes) that was meant to stop an E1M3
    // oscillation and did not improve E1M3's clear rate either.
    brakeMinSpeed: 0.5,
    brakeConsecutive: true,    // false forbids two brakes in a row (the 1.1.0 rule)
    brakeFullSpeed: 8,         // full counter-thrust at and above this speed, scaled below it
    recentWindowTics: 70,      // "health lost in the last 2 s" window
    engageHoldTics: 35,        // keep consulting this long after a consultation that saw an enemy
    model: undefined,
    log: null,                 // JSONL path
    onDecision: null,          // async (entry) => void, called after every consultation (overlay, live views)
    profile: null,             // autoplay_map_profile.mjs: thresholds the level's shape justifies
    // Order: these defaults, then the map profile, then what the caller asked
    // for explicitly (the runner's --jev-opt), so a profile never overrides a
    // deliberate setting and a deliberate setting never has to repeat one.
    ...(options.profile?.config || {}),
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
    rules: { stall: 0, dodgeHold: 0, pointBlank: 0, noRetreatFar: 0, hitscanFight: 0, lowHealthHold: 0, cover: 0, threatTarget: 0, fightFires: 0, projectileStrafe: 0, terrainGuard: 0, terrainBrake: 0, coverStarts: 0, coverArrived: 0, coverMove: 0, coverFight: 0, retreatDrift: 0, noFightFar: 0, guardSidestep: 0, barrelBlock: 0, weaponSelect: 0, lootSteps: 0, lootPicked: 0, lootGivenUp: 0 },
    loot: { shotgun: 0, health: 0, shells: 0, armor: 0 },
    pipeline: { lagTics: options.pipelineLagTics || 0, inflightLaunched: 0, applied: 0, reused: 0, stalls: 0, stallMsTotal: 0, lagTicsTotal: 0 }
  };
  const takenItems = new Set();
  let lastItemCount = null;
  // Enemies that can hit the player right now, from the raw state (cheap,
  // used before any consultation to decide whether a detour is safe).
  function shootersNow(state) {
    return (state?.enemies || []).filter(enemy => enemy.lineOfSight && Number(enemy.health) > 0 && Number(enemy.distance) <= effectiveRange(enemy.name)).length;
  }
  const geometry = config.graph?.geometry || null;
  function nearestItem(state, kind) {
    const player = state.player || {};
    const here = { x: Number(player.x), y: Number(player.y) };
    let best = null;
    const sector = Number(state.currentSector);
    for (const item of config.items || []) {
      if (item.kind !== kind || takenItems.has(item.id)) continue;
      const distance = Math.hypot(item.x - here.x, item.y - here.y);
      if (distance > config.itemLootRadius || (best && distance >= best.distance)) continue;
      if (config.itemLootSameSectorOnly && item.sector != null && Number(item.sector) !== sector) {
        // Another sector: only with a clear straight walk (no wall, drop or
        // nukage shore in between), which the geometry can tell.
        if (!(config.itemLootWalkable && geometry && lineOfWalk(geometry, here, { x: item.x, y: item.y }))) continue;
      } else if (geometry && !lineOfWalk(geometry, here, { x: item.x, y: item.y })) {
        continue; // same sector but a wall/pit between (non-convex room)
      }
      best = { ...item, distance };
    }
    return best;
  }
  // Terrain guard: predict where a movement command takes the player over
  // its tics and refuse it when the straight move crosses a wall, a drop or
  // the shore of a damaging sector. Two E1M3 runs died in the nukage pit of
  // sector 48 after a retreat/loot step backed into it. The forward vector
  // is the player's angle; +strafe is to the right (angle - 90).
  const UNITS_PER_TIC = 10; // deliberately above the engine's top speed
  const MOMENTUM_TICS = 10; // vanilla friction 0.90625/tic: a stopped player slides ~10x its last per-tic speed
  let lastPose = null;      // { x, y, tic } from the previous decide() step, for the velocity estimate
  let velocity = { x: 0, y: 0 };
  function trackVelocity(state) {
    const player = state?.player || {};
    const tic = Number(state?.levelTime ?? 0);
    if (lastPose && tic > lastPose.tic && tic - lastPose.tic <= 12) {
      velocity = { x: (Number(player.x) - lastPose.x) / (tic - lastPose.tic), y: (Number(player.y) - lastPose.y) / (tic - lastPose.tic) };
    } else velocity = { x: 0, y: 0 };
    lastPose = { x: Number(player.x), y: Number(player.y), tic };
  }
  function movePreview(state, command) {
    const player = state?.player || {};
    const forward = Number(command?.forward || 0), strafe = Number(command?.strafe || 0);
    const from = { x: Number(player.x), y: Number(player.y) };
    // Where momentum alone takes the player, then the command on top of it.
    const slide = { x: from.x + velocity.x * MOMENTUM_TICS, y: from.y + velocity.y * MOMENTUM_TICS };
    if (!forward && !strafe) return { from, to: slide, slide };
    const angle = Number(player.angle) * Math.PI / 180;
    const fx = Math.cos(angle), fy = Math.sin(angle);
    const rx = Math.cos(angle - Math.PI / 2), ry = Math.sin(angle - Math.PI / 2);
    const magnitude = Math.hypot(forward, strafe);
    const length = 16 + UNITS_PER_TIC * Number(command.tics || 3) * magnitude;
    const dx = (forward * fx + strafe * rx) / magnitude, dy = (forward * fy + strafe * ry) / magnitude;
    return { from, to: { x: slide.x + dx * length, y: slide.y + dy * length }, slide };
  }
  let guardIgnoreLines = [];   // the portal line of the edge being walked (a route may drop off a ledge on purpose)
  // Did the previous step brake? Braking on consecutive steps is what made
  // the oscillation: the brake reverses the velocity, the reversed velocity
  // reads as a fresh slide toward the same edge, and the next brake reverses
  // it back. Seven E1M3 runs spent their last twenty tics alternating f0.7
  // and f-0.7. Braking at most every other step lets friction settle it.
  let braking = false;
  function movementUnsafe(state, command) {
    if (!config.terrainGuard || !geometry || !command) return null;
    const preview = movePreview(state, command);
    if (!preview) return null;
    return movementHazard(geometry, preview.from, preview.to, { ignoreLines: guardIgnoreLines });
  }
  // Momentum alone heading over an edge: the only useful command is the
  // brake, a thrust against the current velocity (expressed in the
  // player's forward/right frame).
  function brakeCommand(state, command) {
    const player = state?.player || {};
    const speed = Math.hypot(velocity.x, velocity.y);
    if (speed < Number(config.brakeMinSpeed ?? 0.5)) return null;
    // Scale the counter-thrust to the speed. A full thrust against a slow
    // slide reverses it instead of stopping it, and the reversed slide reads
    // as a fresh hazard: seven E1M3 runs spent their last twenty tics
    // alternating full forward and full back. Raising the threshold to 4 and
    // forbidding two brakes in a row stopped that, and cost E1M2 its clear
    // rate: the brake between 0.5 and 4 is also what keeps a loot detour on
    // its feet, and suppressing it took health pickups from 30 per ten runs
    // to 2. Scaling is never stronger than the brake that measured 10/10 and
    // damps instead of flipping below brakeFullSpeed.
    const scale = Math.min(1, speed / Number(config.brakeFullSpeed ?? 8));
    const angle = Number(player.angle) * Math.PI / 180;
    const fx = Math.cos(angle), fy = Math.sin(angle);
    const rx = Math.cos(angle - Math.PI / 2), ry = Math.sin(angle - Math.PI / 2);
    const forward = -(velocity.x * fx + velocity.y * fy) / speed;
    const strafe = -(velocity.x * rx + velocity.y * ry) / speed;
    return { ...command, forward: round(0.7 * scale * forward, 2), strafe: round(0.7 * scale * strafe, 2), tics: 2 };
  }
  async function guardCommand(state, command) {
    if (!config.terrainGuard || !geometry) return command;
    // Momentum check first, on every step (the follower's own steps too):
    // sliding toward a pit is braked whatever the command was.
    const slide = movePreview(state, { forward: 0, strafe: 0 });
    const brakedLastStep = braking && config.brakeConsecutive !== true;
    braking = false;
    if (!brakedLastStep && slide && movementHazard(geometry, slide.from, slide.to, { ignoreLines: guardIgnoreLines })) {
      const brake = brakeCommand(state, command || { source: 'jev', mode: 'brake', target: 'none', fire: false, danger: 0, attack: false, use: false });
      if (brake) {
        braking = true;
        stats.rules.terrainBrake++;
        return { ...brake, rules: [...(brake.rules || []), 'terrainBrake'] };
      }
    }
    if (!command) return command;
    const hazard = movementUnsafe(state, command);
    if (!hazard) return command;
    stats.rules.terrainGuard++;
    const rules = [...(command.rules || []), 'terrainGuard'];
    if (command.mode === 'loot' && loot) {
      // The detour would cross a hazard: give the item up for good.
      stats.rules.lootGivenUp++;
      if (loot.itemId) takenItems.add(loot.itemId);
      await record({ kind: 'loot_end', tic: Number(state.levelTime), lootKind: loot.kind, picked: false, reason: `hazard_${hazard.kind}` });
      loot = null;
      return null;
    }
    // A sideways component can flip sides.
    if (Number(command.strafe || 0)) {
      const flipped = { ...command, strafe: -Number(command.strafe), rules };
      if (!movementUnsafe(state, flipped)) { dodgeSide *= -1; return flipped; }
    } else if (config.guardSidestep !== false && command.target && command.target !== 'none') {
      // guardSidestep: a backpedal into a wall becomes standing still in the
      // open, which is the worst answer to a fireball. Most of E1M2's damage
      // is one such chain in the exit rooms, starting with a blocked retreat
      // that cost 21 hp, and E1M3 lost 51 hp in two steps the same way.
      // Sidestep instead, keeping the aim and the shot: moving does not
      // affect the player's own accuracy in vanilla DOOM.
      const reach = Number(config.guardSidestepStrafe ?? 0.6);
      for (const side of [dodgeSide, -dodgeSide]) {
        const step = { ...command, forward: 0, strafe: reach * side, rules: [...rules, 'guardSidestep'] };
        if (!movementUnsafe(state, step)) {
          dodgeSide = side;
          stats.rules.guardSidestep++;
          return step;
        }
      }
    }
    return { ...command, forward: 0, strafe: 0, rules, hazard: hazard.kind };
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
  const heldWeapons = new Set([1]);   // weapons seen in the player's hands (the state has no owned set)
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
    if (loot.kind === 'armor') return Number(player.armor ?? 0) > loot.base.armor;
    return Number(player.items ?? 0) > loot.base.items;
  }
  async function lootStep(state) {
    const player = state.player || {};
    const tic = Number(state.levelTime);
    const picked = lootPicked(state);
    const dist = Math.hypot(loot.x - Number(player.x), loot.y - Number(player.y));
    // Something got a clear shot meanwhile: stop the detour (the item stays
    // eligible) unless the player is desperate for health. Ten identical
    // E1M3 runs walked 240 units toward a medikit with an imp at 52 units.
    // A dropped shotgun is worth the shots taken walking to it (the whole
    // rest of the level is fought with it), so only desperate health ends
    // that detour; the same for a medikit the player is desperate for.
    const worthTheRisk = (loot.kind === 'shotgun' && Number(player.health) >= config.healthLootDesperate)
      || (loot.kind === 'health' && Number(player.health) < config.healthLootDesperate);
    if (!picked && shootersNow(state) > 0 && !worthTheRisk) {
      stats.rules.lootGivenUp++;
      await record({ kind: 'loot_end', tic, lootKind: loot.kind, picked: false, distance: round(dist), tics: tic - loot.sinceTic, reason: 'interrupted' });
      loot = null;
      return null;
    }
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
      base: { shells: Number(player.ammo?.shells ?? 0), health: Number(player.health), armor: Number(player.armor ?? 0), items: Number(player.items ?? 0) }
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
    if (config.lootArmor && Number(player.armor ?? 0) < config.armorLootBelow && shooters === 0) {
      const item = nearestItem(state, 'armor');
      if (item) return startLoot(state, 'armor', item.x, item.y, item.id);
    }
    // Shells are worth collecting whenever the player owns a shotgun, not
    // only while holding one: the engine drops back to the pistol when the
    // shells run out, and a rule keyed on the weapon in hand then never
    // refills (E1M3 ran the whole level on the pistol with shells lying about).
    if (config.lootShells && heldWeapons.has(2) && Number(player.ammo?.shells ?? 0) < config.shellsLootBelow && shooters === 0) {
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

  // A rule that hands the step back to the follower (returning null) has no
  // command to carry its name on, so it reports itself here.
  const onRule = rule => { stats.rules[rule] = (stats.rules[rule] || 0) + 1; };

  // Is a barrel standing in the line of fire, close enough that its blast
  // would reach the player? Hitscan shots travel along the player's facing,
  // so the test is the barrel's bearing off that facing against the angle it
  // subtends. Returns the nearest offender, which the fire rules then refuse
  // to shoot through.
  function barrelInAim(state) {
    const barrels = config.barrels || [];
    if (!barrels.length) return null;
    const player = state?.player || {};
    const px = Number(player.x), py = Number(player.y), facing = Number(player.angle);
    if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(facing)) return null;
    const blast = Number(config.barrelBlast ?? 128);
    let nearest = null;
    for (const barrel of barrels) {
      const dx = barrel.x - px, dy = barrel.y - py;
      const distance = Math.hypot(dx, dy);
      if (distance > blast || distance < 1) continue;
      let bearing = Math.atan2(dy, dx) * 180 / Math.PI - facing;
      while (bearing > 180) bearing -= 360;
      while (bearing < -180) bearing += 360;
      const halfWidth = Math.atan2(Number(config.barrelAimRadius ?? 24), distance) * 180 / Math.PI;
      if (Math.abs(bearing) > halfWidth) continue;
      if (!nearest || distance < nearest.distance) nearest = { ...barrel, distance: round(distance, 1), bearing: round(bearing, 1) };
    }
    return nearest;
  }
  function ruleOptions(compact, state, context) {
    const stalled = detectStall(state, compact);
    const holding = Boolean(coverSpot?.arrived) && Number(state?.levelTime ?? 0) < Number(coverSpot?.holdUntil ?? 0);
    return { ...config, dodgeSide, lastTarget, cover: context ? coverInfo(context) : null, holdPosition: holding, strafeRoomClear: strafeRoomClear(state), targetDrift: targetDrift(context), playerWeapon: Number(state?.player?.weapon), barrelInAim: barrelInAim(state), onRule, ...(stalled ? { forceMode: 'fight' } : {}) };
  }
  // Is there room to strafe? Both sides of the player must have
  // config.strafeRoom units of floor with no wall, drop or nukage shore.
  function strafeRoomClear(state) {
    if (!geometry || !config.strafeRoom) return true;
    const player = state?.player || {};
    const angle = Number(player.angle) * Math.PI / 180;
    const rx = Math.cos(angle - Math.PI / 2), ry = Math.sin(angle - Math.PI / 2);
    const from = { x: Number(player.x), y: Number(player.y) };
    for (const side of [1, -1]) {
      const to = { x: from.x + side * rx * config.strafeRoom, y: from.y + side * ry * config.strafeRoom };
      if (movementHazard(geometry, from, to, { ignoreLines: guardIgnoreLines })) return false;
    }
    return true;
  }

  // How far the player has drifted from the best approach it managed on this
  // route step: the measure of ground given up to a fight.
  let driftEdge = null;
  let bestTargetDistance = Infinity;
  function targetDrift(context) {
    const edgeId = context?.edge?.id || 'exit';
    const distance = Number(context?.targetDistance);
    if (driftEdge !== edgeId) { driftEdge = edgeId; bestTargetDistance = Infinity; }
    if (!Number.isFinite(distance)) return 0;
    if (distance < bestTargetDistance) bestTargetDistance = distance;
    return distance - bestTargetDistance;
  }

  // Geometric cover: see config.coverSeek. `coverSpot` is the spot being
  // walked to or held; coverEdge/coverCount bound the moves per route edge.
  let coverSpot = null;
  let coverEdge = null;
  let coverCount = 0;
  function hitscanShooters(state) {
    const player = state?.player || {};
    return (state?.enemies || [])
      .filter(enemy => isHitscan(enemy.name) && enemy.lineOfSight && Number(enemy.health) > 0 && Number(enemy.distance) <= effectiveRange(enemy.name))
      .map(enemy => enemyWorldPosition(player, { bearing: enemy.relativeAngle, distance: enemy.distance }));
  }
  async function coverCheck(state, context) {
    if (!config.coverSeek || !geometry || loot) return null;
    const tic = Number(state.levelTime);
    const player = state.player || {};
    const edgeId = context?.edge?.id || 'exit';
    if (coverEdge !== edgeId) { coverEdge = edgeId; coverCount = 0; }
    if (coverSpot) {
      const here = { x: Number(player.x), y: Number(player.y) };
      const d = Math.hypot(coverSpot.x - here.x, coverSpot.y - here.y);
      if (!coverSpot.arrived) {
        if (d < 24) {
          coverSpot.arrived = true; coverSpot.holdUntil = tic + config.coverHoldTics; stats.rules.coverArrived++;
          await record({ kind: 'cover_arrived', tic, x: round(coverSpot.x), y: round(coverSpot.y), tics: tic - coverSpot.sinceTic });
          return null;
        }
        if (tic - coverSpot.sinceTic > config.coverTimeoutTics || hitscanShooters(state).length === 0) {
          await record({ kind: 'cover_end', tic, reason: hitscanShooters(state).length === 0 ? 'clear' : 'timeout', distance: round(d) });
          coverSpot = null;
          return null;
        }
        // Walk the spot's local path (the terrain guard previews this step too).
        while (coverSpot.waypoints.length > 1 && Math.hypot(coverSpot.waypoints[0].x - here.x, coverSpot.waypoints[0].y - here.y) < 24) coverSpot.waypoints.shift();
        const next = coverSpot.waypoints[0] || coverSpot;
        let desired = Math.atan2(next.y - here.y, next.x - here.x) * 180 / Math.PI - Number(player.angle);
        while (desired > 180) desired -= 360;
        while (desired < -180) desired += 360;
        stats.rules.coverMove++;
        const meta = { source: 'jev', mode: 'cover', target: 'none', fire: false, danger: 0, rules: ['coverMove'] };
        if (Math.abs(desired) > 12) { const aim = aimStep(desired); return { forward: 0, strafe: 0, turn: aim.turn, attack: false, use: false, tics: aim.tics, ...meta }; }
        return { forward: 0.62, strafe: 0, turn: aimStep(desired).turn, attack: false, use: false, tics: 3, ...meta };
      }
      if (tic >= coverSpot.holdUntil) {
        await record({ kind: 'cover_end', tic, reason: 'hold_over' });
        coverSpot = null;
      }
      return null;
    }
    // Cover walks away from the route too, so the same drift limit applies to
    // starting a new one.
    if (coverCount >= config.coverMaxPerEdge || targetDrift(context) > config.retreatDriftLimit) return null;
    const threats = hitscanShooters(state);
    const health = Number(player.health);
    if (threats.length < config.coverShooters && !(threats.length >= 1 && health < config.coverLowHealth)) return null;
    const here = { x: Number(player.x), y: Number(player.y) };
    const spot = coverPoint(geometry, Number(state.currentSector), here, threats, { maxDistance: config.coverSeekMaxDistance });
    if (!spot) return null;
    coverSpot = { x: spot.x, y: spot.y, waypoints: [...spot.waypoints], sinceTic: tic, arrived: false, holdUntil: 0 };
    coverCount++;
    stats.rules.coverStarts++;
    await record({ kind: 'cover_start', tic, x: round(spot.x), y: round(spot.y), distance: round(spot.distance), shooters: threats.length, health, from: { x: round(here.x), y: round(here.y) } });
    return coverCheck(state, context);
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
  let engagedUntilTic = null; // consultations continue until this tic after one that saw an enemy
  const healthHistory = [];   // { tic, health } per step, for the recent-damage window
  function recentDamage(state) {
    const tic = Number(state?.levelTime ?? 0);
    const health = Number(state?.player?.health ?? 0);
    healthHistory.push({ tic, health });
    while (healthHistory.length && healthHistory[0].tic < tic - config.recentWindowTics) healthHistory.shift();
    const peak = Math.max(...healthHistory.map(h => h.health));
    return Math.max(0, peak - health);
  }
  // Which weapon to hold. The engine state reports the ready weapon and the
  // ammo, not the owned set, and asking for a weapon the player does not own
  // is a no-op: vanilla P_PlayerThink applies BT_CHANGE only when
  // weaponowned[newweapon] and its ammo are there. So the rule asks and lets
  // the engine decide. (An earlier version gated on weapons seen in hand and
  // never fired once: the run that never picked a shotgun up could never ask
  // for one either.)
  let lastWeaponRequestTic = -Infinity;
  let pendingWeapon = null;      // { weapon, tic } of the last request, to learn what the player does not own
  const deniedWeapons = new Set();
  function weaponWanted(state) {
    if (!config.weaponSelect) return null;
    const player = state?.player || {};
    const weapon = Number(player.weapon);
    const tic = Number(state?.levelTime ?? 0);
    if (Number.isFinite(weapon)) { heldWeapons.add(weapon); deniedWeapons.delete(weapon); }
    // A request that did not take within a switch's worth of tics means the
    // player does not own that weapon (the engine ignores BT_CHANGE then):
    // stop asking, until it turns up in hand.
    if (pendingWeapon && tic - pendingWeapon.tic >= config.weaponSelectHoldTics) {
      if (weapon !== pendingWeapon.weapon) deniedWeapons.add(pendingWeapon.weapon);
      pendingWeapon = null;
    }
    if (tic - lastWeaponRequestTic < config.weaponSelectHoldTics) return null;
    const shells = Number(player.ammo?.shells ?? 0), bullets = Number(player.ammo?.bullets ?? 0);
    const want = candidate => candidate !== weapon && !deniedWeapons.has(candidate);
    let wanted = null;
    if (weapon <= 1 && shells > 0 && want(2)) wanted = 2;        // the shotgun beats the pistol at every range that matters
    else if (weapon <= 1 && bullets > 0 && want(3)) wanted = 3;  // a chaingun if there is one
    else if (weapon === 0 && bullets > 0 && want(1)) wanted = 1; // fists with bullets in the pocket
    if (wanted == null) return null;
    lastWeaponRequestTic = tic;
    pendingWeapon = { weapon: wanted, tic };
    stats.rules.weaponSelect++;
    return wanted;
  }
  async function decide(context) {
    trackVelocity(context.state);
    guardIgnoreLines = context.edge?.line != null ? [Number(context.edge.line)] : context.exit?.line != null ? [Number(context.exit.line)] : [];
    let command = await guardCommand(context.state, await decideUnguarded(context));
    const weapon = weaponWanted(context.state);
    if (weapon != null) {
      // Ride the switch on this step's command, the policy's or the follower's.
      command = command
        ? { ...command, weapon, rules: [...(command.rules || []), 'weaponSelect'] }
        : { ...context.proposal, weapon, source: 'jev', mode: 'weapon', target: 'none', fire: false, danger: 0, rules: ['weaponSelect'] };
      await record({ kind: 'weapon_select', tic: Number(context.state?.levelTime), weapon, from: Number(context.state?.player?.weapon), ammo: context.state?.player?.ammo });
    }
    return command;
  }
  async function decideUnguarded(context) {
    const { state, proposal } = context;
    stepsSinceCall++;
    const consult = shouldConsult(state, config, { lastHealth, engagedUntilTic });
    lastHealth = Number(state?.player?.health ?? lastHealth);
    const lost = recentDamage(state);
    coverInfo(context); // keep the edge entry point current even on steps that are not consulted
    await lootCheck(state);
    if (loot) {
      const lootCommand = await lootStep(state);
      if (lootCommand) { stats.overrides++; return lootCommand; }
    }
    const coverCommand = await coverCheck(state, context);
    if (coverCommand) { stats.overrides++; return coverCommand; }
    if (!consult) return null;
    stats.eligibleSteps++;
    if (stepsSinceCall < config.minStepsBetweenCalls) {
      // Reuse the last judgment for a short hold without paying again.
      return lastDecision ? answersToCommand(lastDecision.answers, lastDecision.compact, proposal, ruleOptions(lastDecision.compact, state, context)) : null;
    }
    if (stats.calls >= config.maxCalls) { stats.capped = true; return null; }

    const compact = compactState(state, { ...context, maxEnemies: config.maxEnemies, meleeRange: config.meleeRange, recentDamage: lost, profile: config.profile });
    if (compact.visibleEnemies.length) engagedUntilTic = Number(state.levelTime) + config.engageHoldTics;
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

    if (config.pipelineLagTics > 0) return pipelinedDecide(request, compact, state, proposal, context);

    const result = await ask(request, state);
    if (!result) return null;
    return applyResult(result, compact, state, proposal, context, { requestTic: state.levelTime });
  }

  // One systemOne call with bookkeeping; null on error.
  async function ask(request, state) {
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
    result.latencyMs = Date.now() - started;
    stats.calls++;
    stats.latencyMsTotal += result.latencyMs;
    stats.inputTokens += Number(result.usage?.input_tokens || 0);
    stats.outputTokens += Number(result.usage?.output_tokens || 0);
    return result;
  }

  // Turn a resolved answer into the command for the step it is applied on.
  // `compact` is the state of that step (in pipeline mode: newer than the
  // state the answer was computed for).
  async function applyResult(result, compact, state, proposal, context, meta = {}) {
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
    lastDecision = { answers: result.answers, compact, tic: Number(state.levelTime) };
    const options = ruleOptions(compact, state, context);
    const command = answersToCommand(result.answers, compact, proposal, options);
    rememberTarget(command, compact, state);
    if (command) stats.overrides++;
    for (const rule of command?.rules || []) stats.rules[rule] = (stats.rules[rule] || 0) + 1;
    await record({
      kind: 'jev_decision', tic: state.levelTime, latencyMs: result.latencyMs, model: result.model, usage: result.usage,
      state: compact, answers: result.answers, proposal, command, ...(options.forceMode ? { forced: options.forceMode } : {}), ...meta
    });
    return command;
  }

  // Pipelined consultation: the request for this step's state is sent
  // without waiting; the world keeps stepping and the answer is applied
  // `pipelineLagTics` later (waiting only if it has not arrived by then, so
  // the trial stays a function of the answers, not of the network). Between
  // arrivals the latest decision is re-applied to the current state.
  let inflight = null;   // { tic, compact, promise }
  async function pipelinedDecide(request, compact, state, proposal, context) {
    const tic = Number(state.levelTime);
    let command = null;
    let applied = false;
    if (inflight && tic >= inflight.tic + config.pipelineLagTics) {
      const waitStart = Date.now();
      const result = await inflight.promise;
      const stallMs = Date.now() - waitStart;
      stats.pipeline.applied++;
      if (stallMs > 5) { stats.pipeline.stalls++; stats.pipeline.stallMsTotal += stallMs; }
      stats.pipeline.lagTicsTotal += tic - inflight.tic;
      const requestTic = inflight.tic;
      inflight = null;
      if (result) { command = await applyResult(result, compact, state, proposal, context, { requestTic, appliedTic: tic, stallMs }); applied = true; }
    }
    if (!inflight && stats.calls + stats.pipeline.inflightLaunched < config.maxCalls + stats.pipeline.applied) {
      // Launch the next request on the current state (in flight while the
      // world advances; the in-flight slot itself spaces the calls out).
      const launchState = state;
      inflight = { tic, compact, promise: ask(request, launchState) };
      stats.pipeline.inflightLaunched++;
      stepsSinceCall = 0;
    }
    if (applied) return command;
    // No new answer this step: re-apply the latest one to the current state
    // unless it is older than a second of game time.
    if (lastDecision && tic - lastDecision.tic <= config.pipelineMaxAgeTics) {
      const options = ruleOptions(compact, state, context);
      const reused = answersToCommand(lastDecision.answers, compact, proposal, options);
      rememberTarget(reused, compact, state);
      if (reused) { stats.overrides++; stats.pipeline.reused++; }
      for (const rule of reused?.rules || []) stats.rules[rule] = (stats.rules[rule] || 0) + 1;
      return reused;
    }
    return null;
  }

  function summary() {
    return {
      ...stats,
      pipeline: { ...stats.pipeline, avgStallMs: stats.pipeline.stalls ? round(stats.pipeline.stallMsTotal / stats.pipeline.stalls) : 0, avgLagTics: stats.pipeline.applied ? round(stats.pipeline.lagTicsTotal / stats.pipeline.applied, 1) : null },
      avgLatencyMs: stats.calls && !config.dryRun ? round(stats.latencyMsTotal / stats.calls) : null,
      estimatedInputCostUsd: round(stats.inputTokens / 1e6 * INPUT_TOKEN_PRICE_USD_PER_MILLION, 4)
    };
  }

  return { decide, summary, config };
}
