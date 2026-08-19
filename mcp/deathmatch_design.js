import { Buffer } from 'node:buffer';

import { GeometryWorkspace, MAP_LUMP_ORDER, parseWad, writeWad } from './geometry.js';
import { buildNavigationGraph, findSectorPath, locatePointSector } from './navigation_graph.js';

export const DEATHMATCH_DESIGN_VERSION = '2.8.0-p2.2';
export const DEATHMATCH_POLICY_VERSION = '2026-08-19.1';

const NO_SIDE = 0xffff;
const ML_BLOCKING = 0x0001;
const ML_TWOSIDED = 0x0004;
const MAP_NAME = /^(?:E[1-9]M[1-9]|MAP\d\d)$/;

const WEAPONS = new Map([
  [2001, { key: 'shotgun', value: 1.0 }],
  [2002, { key: 'chaingun', value: 1.15 }],
  [2003, { key: 'rocket_launcher', value: 1.8 }],
  [2004, { key: 'plasma_rifle', value: 2.0 }],
  [2005, { key: 'chainsaw', value: 0.8 }],
  [2006, { key: 'bfg9000', value: 2.5 }]
]);
const HIGH_VALUE_WEAPONS = new Set([2003, 2004, 2006]);

export const BOT_SKILL_PRESETS = Object.freeze({
  easy: Object.freeze({ reactionTics: 10, aimToleranceDeg: 20, turnGain: 0.32, forward: 0.46, strafe: 0.18, aggression: 0.40, itemBias: 0.72, dodge: 0.18 }),
  normal: Object.freeze({ reactionTics: 5, aimToleranceDeg: 11, turnGain: 0.48, forward: 0.62, strafe: 0.30, aggression: 0.62, itemBias: 0.58, dodge: 0.30 }),
  hard: Object.freeze({ reactionTics: 3, aimToleranceDeg: 6, turnGain: 0.64, forward: 0.78, strafe: 0.42, aggression: 0.80, itemBias: 0.44, dodge: 0.44 }),
  nightmare: Object.freeze({ reactionTics: 1, aimToleranceDeg: 2.5, turnGain: 0.86, forward: 0.96, strafe: 0.58, aggression: 0.96, itemBias: 0.30, dodge: 0.60 })
});

function clamp(value, min = 0, max = 100) { return Math.max(min, Math.min(max, Number(value))); }
function round(value, digits = 2) { const p = 10 ** digits; return Math.round(Number(value) * p) / p; }
function mean(values) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0; }
function stdev(values) { if (!values.length) return 0; const m = mean(values); return Math.sqrt(mean(values.map(v => (v - m) ** 2))); }
function cv(values) { const m = mean(values); return m > 0 ? stdev(values) / m : 0; }
function dist(a, b) { return Math.hypot(Number(b.x) - Number(a.x), Number(b.y) - Number(a.y)); }

function normalizeMapName(value = 'E1M1') {
  const name = String(value || 'E1M1').trim().toUpperCase();
  if (!MAP_NAME.test(name)) throw new Error(`Unsupported Doom map name: ${value}`);
  return name;
}
function int16(value, label) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < -32768 || n > 32767) throw new Error(`${label} must fit signed 16-bit`);
  return n;
}
function uint16(value, label) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < 0 || n > 65535) throw new Error(`${label} must fit unsigned 16-bit`);
  return n;
}
function writeName8(buffer, offset, value, fallback = '-') {
  const text = String(value ?? fallback).trim().toUpperCase() || fallback;
  if (text.length > 8 || !/^[A-Z0-9_\-]+$/.test(text)) throw new Error(`Invalid Doom texture/flat name: ${text}`);
  buffer.fill(0, offset, offset + 8);
  buffer.write(text, offset, Math.min(8, text.length), 'ascii');
}
function encodeThings(items) {
  const out = Buffer.alloc(items.length * 10);
  items.forEach((thing, i) => {
    const at = i * 10;
    out.writeInt16LE(int16(thing.x, `thing ${i}.x`), at);
    out.writeInt16LE(int16(thing.y, `thing ${i}.y`), at + 2);
    out.writeInt16LE(int16(((Number(thing.angle || 0) % 360) + 360) % 360, `thing ${i}.angle`), at + 4);
    out.writeInt16LE(int16(thing.doomEdNum, `thing ${i}.doomEdNum`), at + 6);
    out.writeInt16LE(int16(thing.flags ?? 7, `thing ${i}.flags`), at + 8);
  });
  return out;
}
function encodeVertices(items) {
  const out = Buffer.alloc(items.length * 4);
  items.forEach((v, i) => { const at = i * 4; out.writeInt16LE(int16(v.x, `vertex ${i}.x`), at); out.writeInt16LE(int16(v.y, `vertex ${i}.y`), at + 2); });
  return out;
}
function encodeLinedefs(items) {
  const out = Buffer.alloc(items.length * 14);
  items.forEach((line, i) => {
    const at = i * 14;
    out.writeUInt16LE(uint16(line.v1, `linedef ${i}.v1`), at);
    out.writeUInt16LE(uint16(line.v2, `linedef ${i}.v2`), at + 2);
    out.writeUInt16LE(uint16(line.flags || 0, `linedef ${i}.flags`), at + 4);
    out.writeUInt16LE(uint16(line.special || 0, `linedef ${i}.special`), at + 6);
    out.writeUInt16LE(uint16(line.tag || 0, `linedef ${i}.tag`), at + 8);
    out.writeUInt16LE(uint16(line.right, `linedef ${i}.right`), at + 10);
    out.writeUInt16LE(line.left === NO_SIDE ? NO_SIDE : uint16(line.left, `linedef ${i}.left`), at + 12);
  });
  return out;
}
function encodeSidedefs(items) {
  const out = Buffer.alloc(items.length * 30);
  items.forEach((side, i) => {
    const at = i * 30;
    out.writeInt16LE(int16(side.xOffset || 0, `sidedef ${i}.xOffset`), at);
    out.writeInt16LE(int16(side.yOffset || 0, `sidedef ${i}.yOffset`), at + 2);
    writeName8(out, at + 4, side.upper || '-');
    writeName8(out, at + 12, side.lower || '-');
    writeName8(out, at + 20, side.middle || '-');
    out.writeUInt16LE(uint16(side.sector, `sidedef ${i}.sector`), at + 28);
  });
  return out;
}
function encodeSectors(items) {
  const out = Buffer.alloc(items.length * 26);
  items.forEach((sector, i) => {
    const at = i * 26;
    out.writeInt16LE(int16(sector.floor, `sector ${i}.floor`), at);
    out.writeInt16LE(int16(sector.ceiling, `sector ${i}.ceiling`), at + 2);
    writeName8(out, at + 4, sector.floorFlat || 'FLOOR4_8');
    writeName8(out, at + 12, sector.ceilingFlat || 'CEIL3_5');
    out.writeInt16LE(int16(sector.light ?? 176, `sector ${i}.light`), at + 20);
    out.writeUInt16LE(uint16(sector.special || 0, `sector ${i}.special`), at + 22);
    out.writeUInt16LE(uint16(sector.tag || 0, `sector ${i}.tag`), at + 24);
  });
  return out;
}
function canonicalLumps(map, replacements = {}) {
  return [{ name: map, data: Buffer.alloc(0) }, ...MAP_LUMP_ORDER.map(name => ({ name, data: Buffer.from(replacements[name] || Buffer.alloc(0)) }))];
}
function polygonArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}
function buildPolygonGeometry(polygons, materials) {
  const vertices = [];
  const vertexMap = new Map();
  const sidedefs = [];
  const linedefs = [];
  const edgeMap = new Map();
  const sectors = polygons.map((polygon, sector) => ({
    floor: polygon.floor ?? materials.floor,
    ceiling: polygon.ceiling ?? materials.ceiling,
    floorFlat: materials.floorFlat,
    ceilingFlat: materials.ceilingFlat,
    light: polygon.light ?? materials.light,
    special: 0,
    tag: 0,
    sector
  }));
  const vertexId = point => {
    const key = `${Math.trunc(point.x)},${Math.trunc(point.y)}`;
    if (!vertexMap.has(key)) { vertexMap.set(key, vertices.length); vertices.push({ x: Math.trunc(point.x), y: Math.trunc(point.y) }); }
    return vertexMap.get(key);
  };
  const side = (sector, middle) => {
    const id = sidedefs.length;
    sidedefs.push({ xOffset: 0, yOffset: 0, upper: '-', lower: '-', middle, sector });
    return id;
  };

  polygons.forEach((source, sector) => {
    let points = source.points.map(point => ({ x: Math.trunc(point.x), y: Math.trunc(point.y) }));
    if (polygonArea(points) > 0) points = [...points].reverse(); // Doom front/right interior convention.
    for (let i = 0; i < points.length; i++) {
      const v1 = vertexId(points[i]), v2 = vertexId(points[(i + 1) % points.length]);
      const key = v1 < v2 ? `${v1}:${v2}` : `${v2}:${v1}`;
      const existing = edgeMap.get(key);
      if (!existing) {
        const right = side(sector, materials.wallTexture);
        const line = { v1, v2, flags: ML_BLOCKING, special: 0, tag: 0, right, left: NO_SIDE };
        edgeMap.set(key, { line: linedefs.length, v1, v2 });
        linedefs.push(line);
      } else {
        const line = linedefs[existing.line];
        if (line.left !== NO_SIDE) throw new Error(`Non-manifold polygon edge ${key}`);
        if (!(line.v1 === v2 && line.v2 === v1)) throw new Error(`Adjacent sectors do not traverse shared edge in opposite directions: ${key}`);
        const left = side(sector, '-');
        line.left = left;
        line.flags = ML_TWOSIDED;
        sidedefs[line.right].middle = '-';
      }
    }
  });

  return { vertices, sidedefs, linedefs, sectors };
}

function octagon(radius) {
  const r = Math.trunc(radius);
  const d = Math.round(r / Math.sqrt(2));
  return [
    { x: r, y: 0 }, { x: d, y: d }, { x: 0, y: r }, { x: -d, y: d },
    { x: -r, y: 0 }, { x: -d, y: -d }, { x: 0, y: -r }, { x: d, y: -d }
  ];
}
function radialPoint(angleIndex, radius) {
  const points = octagon(radius);
  return points[((angleIndex % 8) + 8) % 8];
}
function angleTowardCenter(point) {
  let angle = Math.atan2(-point.y, -point.x) * 180 / Math.PI;
  if (angle < 0) angle += 360;
  return Math.round(angle) % 360;
}

export function createDeathmatchArenaPwad(input = {}) {
  const map = normalizeMapName(input.map || 'E1M1');
  const outerRadius = Math.max(384, Math.min(1400, Math.trunc(Number(input.outerRadius ?? 640))));
  const innerRadius = Math.max(128, Math.min(outerRadius - 160, Math.trunc(Number(input.innerRadius ?? 224))));
  const floor = Math.trunc(Number(input.floor ?? 0));
  const ceiling = Math.trunc(Number(input.ceiling ?? 128));
  if (ceiling - floor < 64) throw new Error('Deathmatch arena needs at least 64 map units of vertical clearance');
  const materials = {
    floor,
    ceiling,
    light: Math.max(0, Math.min(255, Math.trunc(Number(input.light ?? 192)))),
    wallTexture: String(input.wallTexture || 'STARTAN3').trim().toUpperCase(),
    floorFlat: String(input.floorFlat || 'FLOOR4_8').trim().toUpperCase(),
    ceilingFlat: String(input.ceilingFlat || 'CEIL3_5').trim().toUpperCase()
  };
  const outer = octagon(outerRadius), inner = octagon(innerRadius);
  const polygons = [];
  for (let i = 0; i < 8; i++) {
    polygons.push({ points: [outer[i], outer[(i + 1) % 8], inner[(i + 1) % 8], inner[i]], floor, ceiling, light: materials.light });
  }
  polygons.push({ points: inner, floor: floor + 8, ceiling, light: Math.min(255, materials.light + 24) });
  const geometry = buildPolygonGeometry(polygons, materials);

  const things = [];
  const spawnRadius = Math.round((outerRadius + innerRadius) / 2);
  const dmStarts = [];
  for (let i = 0; i < 8; i++) {
    const p = radialPoint(i, spawnRadius);
    const start = { x: p.x, y: p.y, angle: angleTowardCenter(p), doomEdNum: 11, flags: 7 };
    dmStarts.push({ ...start, sector: i });
    things.push(start);
  }
  [0, 2, 4, 6].forEach((ringIndex, playerIndex) => {
    const p = radialPoint(ringIndex, spawnRadius - 48);
    things.push({ x: p.x, y: p.y, angle: angleTowardCenter(p), doomEdNum: playerIndex + 1, flags: 7 });
  });

  // Symmetric low/mid-tier weapon support around the ring.
  [1, 5].forEach(i => { const p = radialPoint(i, spawnRadius - 24); things.push({ ...p, angle: 0, doomEdNum: 2001, flags: 7 }); });
  [3, 7].forEach(i => { const p = radialPoint(i, spawnRadius - 24); things.push({ ...p, angle: 0, doomEdNum: 2002, flags: 7 }); });
  [1, 5].forEach(i => { const p = radialPoint(i, spawnRadius + 36); things.push({ ...p, angle: 0, doomEdNum: 2008, flags: 7 }); });
  [3, 7].forEach(i => { const p = radialPoint(i, spawnRadius + 36); things.push({ ...p, angle: 0, doomEdNum: 2048, flags: 7 }); });
  // High-value center pickup: equal path opportunity, higher exposure/risk.
  things.push({ x: 0, y: 0, angle: 0, doomEdNum: 2003, flags: 7 });
  things.push({ x: 48, y: 0, angle: 0, doomEdNum: 2046, flags: 7 });
  things.push({ x: -48, y: 0, angle: 0, doomEdNum: 2018, flags: 7 });
  [0, 2, 4, 6].forEach(i => { const p = radialPoint(i, innerRadius + 64); things.push({ ...p, angle: 0, doomEdNum: 2012, flags: 7 }); });

  const bytes = writeWad({ lumps: canonicalLumps(map, {
    THINGS: encodeThings(things),
    LINEDEFS: encodeLinedefs(geometry.linedefs),
    SIDEDEFS: encodeSidedefs(geometry.sidedefs),
    VERTEXES: encodeVertices(geometry.vertices),
    SECTORS: encodeSectors(geometry.sectors)
  }) }, 'PWAD');

  return {
    version: DEATHMATCH_DESIGN_VERSION,
    map,
    bytes,
    arena: {
      kind: 'octagonal_ring_center', outerRadius, innerRadius,
      sectors: geometry.sectors.length,
      vertices: geometry.vertices.length,
      linedefs: geometry.linedefs.length,
      sidedefs: geometry.sidedefs.length,
      deathmatchStarts: dmStarts.length,
      playerStarts: 4,
      centerSector: 8,
      materials
    }
  };
}

function thingList(workspace) {
  return typeof workspace.listThings === 'function'
    ? workspace.listThings({ limit: 65535 })
    : (workspace.geometry.things || []).map((thing, index) => ({ index, ...thing }));
}
function pointSector(workspace, thing) {
  return locatePointSector(workspace, { x: Number(thing.x), y: Number(thing.y) });
}
function pathCostBetween(graph, workspace, from, to) {
  const fromSector = pointSector(workspace, from), toSector = pointSector(workspace, to);
  if (fromSector == null || toSector == null) return Infinity;
  if (fromSector === toSector) return dist(from, to);
  const path = findSectorPath(graph, fromSector, toSector, { allowDrops: true, keys: ['blue', 'yellow', 'red'] });
  if (!path.found) return Infinity;
  const fromCenter = graph.nodes[fromSector]?.center || from;
  const toCenter = graph.nodes[toSector]?.center || to;
  return dist(from, fromCenter) + Number(path.cost || 0) + dist(toCenter, to);
}
function orientation(a, b, c) { return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); }
function properIntersect(a, b, c, d) {
  const o1 = orientation(a, b, c), o2 = orientation(a, b, d), o3 = orientation(c, d, a), o4 = orientation(c, d, b);
  return ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0));
}
function sideSector(g, side) { return side === NO_SIDE ? null : g.sidedefs[side]?.sector ?? null; }
function hasDirectSight(workspace, a, b) {
  const g = workspace.geometry;
  for (const line of g.linedefs) {
    const p = g.vertices[line.v1], q = g.vertices[line.v2];
    if (!p || !q || !properIntersect(a, b, p, q)) continue;
    const right = sideSector(g, line.right), left = sideSector(g, line.left);
    if (right == null || left == null) return false;
    const rs = g.sectors[right], ls = g.sectors[left];
    if (!rs || !ls) return false;
    const opening = Math.min(Number(rs.ceiling), Number(ls.ceiling)) - Math.max(Number(rs.floor), Number(ls.floor));
    if (opening <= 0) return false;
  }
  return true;
}
function scoreVariation(values, scale = 180) {
  if (!values.length || values.some(value => !Number.isFinite(value))) return 0;
  return clamp(100 - cv(values) * scale);
}
function degreeBySector(graph) {
  const sets = new Map(graph.nodes.map(node => [node.sector, new Set()]));
  for (const edge of graph.edges) if (edge.passable) sets.get(edge.from)?.add(edge.to);
  return new Map([...sets].map(([sector, set]) => [sector, set.size]));
}
function issue(code, severity, message, recommendation, details = {}) { return { code, severity, message, recommendation, ...details }; }

export function getDeathmatchPolicy() {
  return {
    version: DEATHMATCH_POLICY_VERSION,
    scoreWeights: { spawnDistance: 0.19, weaponAccess: 0.22, routeChoice: 0.17, initialExposure: 0.12, highValueEquity: 0.18, topology: 0.12 },
    targets: {
      minDeathmatchStarts: 4,
      preferredDeathmatchStarts: 8,
      minPairwiseSpawnDistance: 280,
      preferredSpawnRoutes: 2,
      preferredImmediateLosExposure: [0.2, 0.55],
      strongWeaponEquityCvMax: 0.20,
      highValueEquityCvMax: 0.18
    },
    botSkills: BOT_SKILL_PRESETS,
    note: 'P2.2 fairness scores are deterministic map-design proxies. Live bot results and later human network play remain separate acceptance evidence.'
  };
}

export function evaluateDeathmatchFairness(workspace, options = {}) {
  if (!(workspace instanceof GeometryWorkspace)) throw new Error('evaluateDeathmatchFairness expects a GeometryWorkspace');
  const graph = buildNavigationGraph(workspace);
  const things = thingList(workspace);
  const starts = things.filter(thing => Number(thing.doomEdNum) === 11).map(thing => ({ ...thing, sector: pointSector(workspace, thing) })).filter(thing => thing.sector != null);
  const weapons = things.filter(thing => WEAPONS.has(Number(thing.doomEdNum))).map(thing => ({ ...thing, ...WEAPONS.get(Number(thing.doomEdNum)), sector: pointSector(workspace, thing) })).filter(thing => thing.sector != null);
  const highValue = weapons.filter(thing => HIGH_VALUE_WEAPONS.has(Number(thing.doomEdNum)));
  const issues = [];
  const policy = getDeathmatchPolicy();

  if (starts.length < 4) issues.push(issue('DM_STARTS_INSUFFICIENT', 'error', `Only ${starts.length} deathmatch starts are valid; Vanilla four-player deathmatch needs at least four.`, 'Add at least four valid DoomEd 11 deathmatch starts.'));
  if (!weapons.length) issues.push(issue('DM_WEAPONS_MISSING', 'error', 'No weapon pickups are reachable from deathmatch starts.', 'Add distributed weapons before running a deathmatch trial.'));

  const pairwise = [];
  let visiblePairs = 0;
  for (let i = 0; i < starts.length; i++) for (let j = i + 1; j < starts.length; j++) {
    const cost = pathCostBetween(graph, workspace, starts[i], starts[j]);
    const visible = hasDirectSight(workspace, starts[i], starts[j]);
    if (visible) visiblePairs++;
    pairwise.push({ a: starts[i].index, b: starts[j].index, cost: round(cost), visible });
  }
  const pairCosts = pairwise.map(row => row.cost).filter(Number.isFinite);
  const minPair = pairCosts.length ? Math.min(...pairCosts) : 0;
  const exposure = pairwise.length ? visiblePairs / pairwise.length : 1;

  const perSpawn = starts.map(start => {
    const weaponCosts = weapons.map(weapon => ({ weapon: weapon.key, doomEdNum: weapon.doomEdNum, thing: weapon.index, cost: pathCostBetween(graph, workspace, start, weapon), value: weapon.value }));
    weaponCosts.sort((a, b) => a.cost - b.cost || b.value - a.value);
    const highCosts = highValue.map(weapon => pathCostBetween(graph, workspace, start, weapon)).filter(Number.isFinite).sort((a, b) => a - b);
    const degree = degreeBySector(graph).get(start.sector) || 0;
    return {
      thing: start.index, sector: start.sector, x: Number(start.x), y: Number(start.y),
      nearestWeapon: weaponCosts[0] || null,
      nearestHighValueCost: highCosts[0] ?? null,
      routeChoices: degree
    };
  });

  const nearestWeaponCosts = perSpawn.map(row => Number(row.nearestWeapon?.cost)).filter(Number.isFinite);
  const highValueCosts = perSpawn.map(row => Number(row.nearestHighValueCost)).filter(Number.isFinite);
  const routeChoices = perSpawn.map(row => Number(row.routeChoices || 0));
  const undirectedEdges = new Set(graph.edges.filter(edge => edge.passable).map(edge => edge.from < edge.to ? `${edge.from}:${edge.to}` : `${edge.to}:${edge.from}`));
  const loops = Math.max(0, undirectedEdges.size - graph.nodes.length + (graph.nodes.length ? 1 : 0));

  const spawnDistanceScore = pairCosts.length
    ? round(0.55 * scoreVariation(pairCosts, 165) + 0.45 * clamp(minPair / policy.targets.minPairwiseSpawnDistance * 100))
    : 0;
  const weaponAccessScore = nearestWeaponCosts.length === starts.length ? round(scoreVariation(nearestWeaponCosts, 210)) : 0;
  const routeChoiceScore = round(clamp(mean(routeChoices) / policy.targets.preferredSpawnRoutes * 100));
  const targetExposure = mean(policy.targets.preferredImmediateLosExposure);
  const exposureScore = round(clamp(100 - Math.abs(exposure - targetExposure) * 150));
  const highValueEquityScore = highValueCosts.length === starts.length ? round(scoreVariation(highValueCosts, 230)) : (highValue.length ? 25 : 0);
  const topologyScore = round(clamp(45 + loops * 14 + Math.max(0, mean([...degreeBySector(graph).values()]) - 2) * 10));

  if (minPair && minPair < policy.targets.minPairwiseSpawnDistance) issues.push(issue('SPAWN_TOO_CLOSE', 'warning', `Closest spawn pair path cost is ${round(minPair)}, below the ${policy.targets.minPairwiseSpawnDistance} target.`, 'Move or shield the closest deathmatch starts.', { minPairwiseCost: round(minPair) }));
  if (cv(nearestWeaponCosts) > policy.targets.strongWeaponEquityCvMax) issues.push(issue('WEAPON_ACCESS_IMBALANCE', 'warning', `Spawn-to-nearest-weapon cost CV is ${round(cv(nearestWeaponCosts), 3)}.`, 'Redistribute weapons or spawn locations to reduce access variance.'));
  if (highValue.length && cv(highValueCosts) > policy.targets.highValueEquityCvMax) issues.push(issue('HIGH_VALUE_ITEM_BIAS', 'warning', `Spawn-to-high-value weapon cost CV is ${round(cv(highValueCosts), 3)}.`, 'Move the high-value pickup or adjust routes so all spawns contest it comparably.'));
  if (mean(routeChoices) < policy.targets.preferredSpawnRoutes) issues.push(issue('SPAWN_ROUTE_STARVATION', 'warning', `Average immediate route choices from spawn sectors is ${round(mean(routeChoices))}.`, 'Add alternate exits or loop connections near disadvantaged spawn sectors.'));
  if (exposure > policy.targets.preferredImmediateLosExposure[1]) issues.push(issue('SPAWN_EXPOSURE_HIGH', 'warning', `${round(exposure * 100, 1)}% of spawn pairs have direct initial line of sight.`, 'Add occlusion, stagger spawn facing, or increase separation.'));
  if (exposure < policy.targets.preferredImmediateLosExposure[0]) issues.push(issue('SPAWN_ISOLATION_HIGH', 'info', `Only ${round(exposure * 100, 1)}% of spawn pairs have direct initial line of sight.`, 'Consider whether the opening phase is too isolated for the intended pace.'));
  if (loops < 2) issues.push(issue('DM_LOOP_COUNT_LOW', 'warning', `Navigation graph has only ${loops} independent loop(s).`, 'Add loop connections to reduce camping and dead-end pressure.'));

  const componentScores = { spawnDistance: spawnDistanceScore, weaponAccess: weaponAccessScore, routeChoice: routeChoiceScore, initialExposure: exposureScore, highValueEquity: highValueEquityScore, topology: topologyScore };
  const weights = policy.scoreWeights;
  const overallScore = round(Object.entries(componentScores).reduce((sum, [key, score]) => sum + score * weights[key], 0));
  const grade = overallScore >= 90 ? 'A' : overallScore >= 80 ? 'B' : overallScore >= 70 ? 'C' : overallScore >= 60 ? 'D' : 'F';

  return {
    version: DEATHMATCH_DESIGN_VERSION,
    policyVersion: DEATHMATCH_POLICY_VERSION,
    map: workspace.mapName,
    overallScore,
    grade,
    componentScores,
    metrics: {
      sectors: graph.nodes.length,
      passableDirectedEdges: graph.edges.filter(edge => edge.passable).length,
      loops,
      deathmatchStarts: starts.length,
      weapons: weapons.length,
      highValueWeapons: highValue.length,
      minPairwiseSpawnCost: round(minPair),
      pairwiseSpawnCostCv: round(cv(pairCosts), 3),
      nearestWeaponCostCv: round(cv(nearestWeaponCosts), 3),
      highValueCostCv: round(cv(highValueCosts), 3),
      immediateLosExposure: round(exposure, 3),
      averageSpawnRouteChoices: round(mean(routeChoices), 2)
    },
    perSpawn,
    pairwise,
    issues,
    policy
  };
}

export function compareDeathmatchReports(before, after) {
  if (!before || !after) throw new Error('Both before and after deathmatch reports are required');
  if (before.policyVersion !== after.policyVersion) throw new Error('Deathmatch reports use different policy versions');
  const beforeIssues = new Set((before.issues || []).map(row => row.code));
  const afterIssues = new Set((after.issues || []).map(row => row.code));
  return {
    policyVersion: before.policyVersion,
    beforeScore: before.overallScore,
    afterScore: after.overallScore,
    delta: round(after.overallScore - before.overallScore),
    componentDelta: Object.fromEntries(Object.keys(after.componentScores || {}).map(key => [key, round(Number(after.componentScores[key] || 0) - Number(before.componentScores?.[key] || 0))])),
    resolvedIssues: [...beforeIssues].filter(code => !afterIssues.has(code)),
    newIssues: [...afterIssues].filter(code => !beforeIssues.has(code)),
    unchangedIssues: [...afterIssues].filter(code => beforeIssues.has(code))
  };
}

export function resolveBotSkill(input = 'normal') {
  if (typeof input === 'string') {
    const key = input.trim().toLowerCase();
    if (!BOT_SKILL_PRESETS[key]) throw new Error(`Unknown bot skill ${input}; expected ${Object.keys(BOT_SKILL_PRESETS).join(', ')}`);
    return { name: key, ...BOT_SKILL_PRESETS[key] };
  }
  const baseName = String(input.base || input.name || 'normal').toLowerCase();
  const base = BOT_SKILL_PRESETS[baseName];
  if (!base) throw new Error(`Unknown bot base skill ${baseName}`);
  const out = { name: input.name || `custom:${baseName}`, ...base };
  for (const key of ['reactionTics', 'aimToleranceDeg', 'turnGain', 'forward', 'strafe', 'aggression', 'itemBias', 'dodge']) {
    if (input[key] != null) out[key] = Number(input[key]);
  }
  out.reactionTics = Math.max(1, Math.min(35, Math.trunc(out.reactionTics)));
  out.aimToleranceDeg = clamp(out.aimToleranceDeg, 1, 45);
  for (const key of ['turnGain', 'forward', 'strafe', 'aggression', 'itemBias', 'dodge']) out[key] = clamp(out[key], 0, 1);
  return out;
}

export function inspectDeathmatchPwad(bytes, map = 'E1M1') {
  const workspace = new GeometryWorkspace(bytes, normalizeMapName(map));
  return evaluateDeathmatchFairness(workspace);
}

export function canonicalDeathmatchLumpOrder(bytes, map = 'E1M1') {
  const doc = parseWad(bytes);
  const marker = doc.lumps.findIndex(lump => lump.name === normalizeMapName(map));
  if (marker < 0) return false;
  return MAP_LUMP_ORDER.every((name, i) => doc.lumps[marker + 1 + i]?.name === name);
}
