// What kind of level is this? A profile computed from the map itself, so the
// policy's thresholds and the model's brief fit the level instead of being
// tuned for one of them.
//
// E1M1 at Hurt Me Plenty is six monsters and two stimpacks over a short
// route; E1M3 is forty on the route, three quarters of them hitscan, behind
// a key detour. The same "walk to a medikit below 50 hp" rule is timid on
// one and reckless on the other. Everything here is derived from the WAD and
// the navigation graph, never from the map's name, so a generated map gets a
// profile too.

import { loadMapItems, skillBit } from './autoplay_items.mjs';
import { locatePointSector } from './navigation_graph.js';

export const MAP_PROFILE_VERSION = '0.1.0-map-profile';

// doomednum -> monster, with what the policy cares about: how it attacks and
// how much of a problem it is. Hitscan enemies cannot be dodged, which is
// what drives the cover and strafe rules.
const MONSTERS = {
  3004: { name: 'zombieman', attack: 'hitscan', health: 20 },
  9: { name: 'shotgun_guy', attack: 'hitscan', health: 30 },
  3001: { name: 'imp', attack: 'projectile', health: 60 },
  3002: { name: 'demon', attack: 'melee', health: 150 },
  58: { name: 'spectre', attack: 'melee', health: 150 },
  3006: { name: 'lost_soul', attack: 'melee', health: 100 },
  3005: { name: 'cacodemon', attack: 'projectile', health: 400 },
  3003: { name: 'baron_of_hell', attack: 'projectile', health: 1000 },
  16: { name: 'cyberdemon', attack: 'projectile', health: 4000 },
  7: { name: 'spider_mastermind', attack: 'hitscan', health: 3000 }
};
const TOUGH = new Set(['demon', 'spectre', 'cacodemon', 'baron_of_hell', 'cyberdemon', 'spider_mastermind']);

function distance(a, b) { return Math.hypot(Number(b.x) - Number(a.x), Number(b.y) - Number(a.y)); }

// Monsters of a map at one skill, located in sectors.
export function loadMapMonsters(workspace, { skill = 0, locate } = {}) {
  const bit = skillBit(skill);
  const things = workspace.geometry?.things || [];
  const out = [];
  for (const thing of things) {
    const spec = MONSTERS[Number(thing.doomEdNum ?? thing.type)];
    if (!spec || !(Number(thing.flags) & bit)) continue;
    const point = { x: Number(thing.x), y: Number(thing.y) };
    out.push({ ...spec, ...point, sector: locate ? locate(point) : null });
  }
  return out;
}

// Rough route length: the walk from each transition's portal to the next.
function routeLength(graph, progression) {
  let total = 0;
  let previous = graph.nodes[progression.startSector]?.center;
  for (const transition of progression.transitions) {
    const point = transition.edge.midpoint;
    if (previous && point) total += distance(previous, point);
    previous = point;
  }
  return Math.round(total);
}

function share(part, whole) { return whole > 0 ? Math.round((part / whole) * 100) / 100 : 0; }

export async function buildMapProfile({ workspace, graph, progression, iwadPath, map, skill = 0 }) {
  const locate = point => locatePointSector(workspace, point);
  const monsters = loadMapMonsters(workspace, { skill, locate });
  const items = (await loadMapItems(iwadPath, map, { skill })).map(item => ({ ...item, sector: locate({ x: item.x, y: item.y }) }));
  const onRoute = new Set(progression.sectors);

  const routeMonsters = monsters.filter(m => m.sector != null && onRoute.has(m.sector));
  const byName = {};
  for (const m of routeMonsters) byName[m.name] = (byName[m.name] || 0) + 1;
  const hitscan = routeMonsters.filter(m => m.attack === 'hitscan').length;
  const tough = routeMonsters.filter(m => TOUGH.has(m.name)).length;

  const routeItems = items.filter(i => i.sector != null && onRoute.has(i.sector));
  const kinds = { health: 0, shells: 0, armor: 0, weapon: 0 };
  let healthUnits = 0;
  for (const item of routeItems) {
    if (kinds[item.kind] != null) kinds[item.kind]++;
    if (item.kind === 'health') healthUnits += Number(item.amount || 0);
  }

  const length = routeLength(graph, progression);
  const profile = {
    version: MAP_PROFILE_VERSION,
    map,
    skill,
    route: {
      sectors: progression.sectors.length,
      transitions: progression.transitions.length,
      keys: progression.keys || [],
      lengthUnits: length
    },
    monsters: {
      total: monsters.length,
      onRoute: routeMonsters.length,
      hitscan,
      hitscanShare: share(hitscan, routeMonsters.length),
      tough,
      byName
    },
    items: { onRoute: kinds, healthUnits },
    density: {
      monstersPer1000Units: length > 0 ? Math.round((routeMonsters.length / length) * 1000 * 10) / 10 : 0,
      healthUnitsPerMonster: routeMonsters.length > 0 ? Math.round(healthUnits / routeMonsters.length) : 0
    }
  };
  profile.config = deriveConfig(profile);
  profile.brief = briefOf(profile);
  return profile;
}

// The thresholds a level's shape justifies. Every rule here is one sentence
// of reasoning, and the CLI's --jev-opt still overrides all of it.
export function deriveConfig(profile) {
  const { monsters, items, route, density } = profile;
  const config = {};

  // Health: detour early where the level is dangerous AND there is health to
  // pick up. Counting pickups alone was wrong: E1M2's seven reads as
  // "moderate" next to E1M3's ten, but E1M2 is 145 health for 14 monsters
  // against E1M3's 160 for 40. The danger sets the threshold, the supply only
  // decides whether detouring is possible at all. Measured on E1M2: 70 gave
  // 8/10 clears where 60 gave 1/10.
  config.healthLootBelow = items.onRoute.health < 3 ? 45 : monsters.onRoute >= 10 ? 70 : 60;
  // Shells: a shotgun blast is one shell, so keep a margin wherever the route
  // carries shells at all. E1M2 at 6 ran the map on the pistol.
  config.shellsLootBelow = items.onRoute.shells >= 3 ? 12 : 6;
  config.lootArmor = items.onRoute.armor > 0;

  // Never walk into a shooter below this. Holding position costs damage on a
  // level where running past is viable, so the floor only rises on a crowded
  // one (E1M2 at 50 dropped to 1/10; at 40 it clears 8/10).
  config.lowHealth = monsters.onRoute >= 30 || monsters.tough > 0 ? 50 : 40;

  // Cover costs time and only pays against hitscan groups.
  config.coverSeek = monsters.hitscan >= 8;

  // A long route needs more consultations; a short one must not be allowed
  // to burn the budget standing still.
  config.maxCalls = Math.max(300, Math.min(900, 200 + route.transitions * 10));

  // Crowded levels leave less room to sidestep between enemies.
  if (density.monstersPer1000Units >= 3) config.strafeRoom = 96;
  return config;
}

function briefOf(profile) {
  const { monsters, items, route } = profile;
  const density = monsters.onRoute >= 30 ? 'crowded' : monsters.onRoute >= 12 ? 'moderate' : 'light';
  const health = items.onRoute.health >= 15 ? 'plentiful' : items.onRoute.health >= 5 ? 'some' : 'scarce';
  const keys = route.keys.length ? `${route.keys.join(' and ')} key needed` : 'no keys needed';
  return `${density} level: ${monsters.onRoute} monsters on the route (${Math.round(monsters.hitscanShare * 100)}% hitscan`
    + `${monsters.tough ? `, ${monsters.tough} tough` : ''}), health pickups ${health}, ${keys}.`;
}

// A compact block for the model's state: what the level is like and how far
// through it the player is. Kept to a few fields; the state is billed by token.
export function profileStateBlock(profile, state) {
  if (!profile) return null;
  const killed = Number(state?.player?.kills ?? 0);
  return {
    kind: profile.brief,
    monstersOnRoute: profile.monsters.onRoute,
    killedSoFar: killed,
    healthPickupsOnRoute: profile.items.onRoute.health
  };
}
