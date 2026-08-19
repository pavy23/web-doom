export const NAVIGATION_VERSION = '2.4.0-p1.3';

const NO_SIDE = 0xffff;
const ML_BLOCKING = 0x0001;
const PLAYER_HEIGHT = 56;
const MAX_STEP_UP = 24;
const MIN_PORTAL_WIDTH = 32;

const DOOR_SPECIALS = Object.freeze({
  1: { action: 'use', behavior: 'raise', key: null },
  26: { action: 'use', behavior: 'raise', key: 'blue' },
  27: { action: 'use', behavior: 'raise', key: 'yellow' },
  28: { action: 'use', behavior: 'raise', key: 'red' },
  31: { action: 'use', behavior: 'open', key: null },
  32: { action: 'use', behavior: 'open', key: 'blue' },
  33: { action: 'use', behavior: 'open', key: 'red' },
  34: { action: 'use', behavior: 'open', key: 'yellow' }
});
const LIFT_SPECIALS = new Set([62, 88]);
const EXIT_SPECIALS = Object.freeze({
  11: { trigger: 'use', secret: false },
  51: { trigger: 'use', secret: true },
  52: { trigger: 'walk', secret: false },
  124: { trigger: 'walk', secret: true }
});
const KEY_TYPES = Object.freeze({ 5: 'blue', 6: 'yellow', 13: 'red' });
const START_TYPES = new Set([1, 2, 3, 4, 11]);

function sideSector(g, sideIndex) {
  if (sideIndex === NO_SIDE) return null;
  return g.sidedefs[sideIndex]?.sector ?? null;
}
function unique(values) { return [...new Set(values)]; }
function dist(a, b) { return Math.hypot(Number(b.x) - Number(a.x), Number(b.y) - Number(a.y)); }
function lineMidpoint(g, line) {
  const a = g.vertices[line.v1], b = g.vertices[line.v2];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
function lineWidth(g, line) {
  const a = g.vertices[line.v1], b = g.vertices[line.v2];
  return Math.hypot(b.x - a.x, b.y - a.y);
}
function sectorBoundarySegments(g, sector) {
  const out = [];
  for (let lineIndex = 0; lineIndex < g.linedefs.length; lineIndex++) {
    const line = g.linedefs[lineIndex];
    const right = sideSector(g, line.right);
    const left = sideSector(g, line.left);
    if (right === sector && left === sector) continue;
    if (right === sector || left === sector) {
      const a = g.vertices[line.v1], b = g.vertices[line.v2];
      if (a && b) out.push({ line: lineIndex, a, b });
    }
  }
  return out;
}
function pointOnSegment(point, a, b, epsilon = 0.0001) {
  const cross = (point.x - a.x) * (b.y - a.y) - (point.y - a.y) * (b.x - a.x);
  if (Math.abs(cross) > epsilon) return false;
  const dot = (point.x - a.x) * (point.x - b.x) + (point.y - a.y) * (point.y - b.y);
  return dot <= epsilon;
}
export function pointInSector(workspace, sector, point) {
  const g = workspace.geometry;
  if (!g.sectors[sector]) return false;
  const segments = sectorBoundarySegments(g, sector);
  if (!segments.length) return false;
  for (const { a, b } of segments) if (pointOnSegment(point, a, b)) return true;
  let inside = false;
  for (const { a, b } of segments) {
    const crosses = (a.y > point.y) !== (b.y > point.y);
    if (!crosses) continue;
    const xAtY = a.x + ((point.y - a.y) * (b.x - a.x)) / (b.y - a.y);
    if (xAtY > point.x) inside = !inside;
  }
  return inside;
}
export function locatePointSector(workspace, point) {
  const g = workspace.geometry;
  for (let sector = 0; sector < g.sectors.length; sector++) {
    if (pointInSector(workspace, sector, point)) return sector;
  }
  return null;
}
function sectorCenter(g, sector) {
  const vertices = [];
  const seen = new Set();
  for (const { a, b, line } of sectorBoundarySegments(g, sector)) {
    const linedef = g.linedefs[line];
    for (const [id, point] of [[linedef.v1, a], [linedef.v2, b]]) {
      if (!seen.has(id)) { seen.add(id); vertices.push(point); }
    }
  }
  if (!vertices.length) return { x: 0, y: 0 };
  return {
    x: vertices.reduce((sum, p) => sum + p.x, 0) / vertices.length,
    y: vertices.reduce((sum, p) => sum + p.y, 0) / vertices.length
  };
}
function doorSpec(line) { return DOOR_SPECIALS[Number(line.special)] || null; }
function classifyPortal(g, lineIndex, fromSector, toSector) {
  const line = g.linedefs[lineIndex];
  const from = g.sectors[fromSector], to = g.sectors[toSector];
  const midpoint = lineMidpoint(g, line);
  const width = lineWidth(g, line);
  const floorDelta = Number(to.floor) - Number(from.floor);
  const opening = Math.min(Number(from.ceiling), Number(to.ceiling)) - Math.max(Number(from.floor), Number(to.floor));
  const blocking = Boolean(Number(line.flags) & ML_BLOCKING);
  const door = doorSpec(line);
  const lift = LIFT_SPECIALS.has(Number(line.special));

  let kind = 'blocked';
  let passable = false;
  let action = null;
  let requiredKey = null;
  let reason = null;

  if (blocking) {
    reason = 'linedef_blocking_flag';
  } else if (door) {
    kind = 'door';
    passable = true;
    action = door.action;
    requiredKey = door.key;
  } else if (lift) {
    kind = 'lift';
    passable = true;
    action = Number(line.special) === 62 ? 'use' : 'walk';
  } else if (width < MIN_PORTAL_WIDTH) {
    reason = `portal_too_narrow:${width.toFixed(1)}`;
  } else if (opening < PLAYER_HEIGHT) {
    reason = `insufficient_vertical_opening:${opening}`;
  } else if (floorDelta > MAX_STEP_UP) {
    reason = `step_up_too_high:${floorDelta}`;
  } else {
    kind = floorDelta < -MAX_STEP_UP ? 'drop' : 'walk';
    passable = true;
  }

  return {
    id: `${fromSector}:${toSector}:${lineIndex}`,
    line: lineIndex,
    from: fromSector,
    to: toSector,
    kind,
    passable,
    action,
    requiredKey,
    reason,
    special: Number(line.special || 0),
    tag: Number(line.tag || 0),
    midpoint,
    width,
    opening,
    floorDelta,
    fromFloor: Number(from.floor),
    toFloor: Number(to.floor)
  };
}
function keyMask(keys = []) {
  let mask = 0;
  const list = Array.isArray(keys) ? keys : [keys];
  for (const key of list) {
    if (key === 'blue') mask |= 1;
    else if (key === 'yellow') mask |= 2;
    else if (key === 'red') mask |= 4;
  }
  return mask;
}
function maskHas(mask, key) {
  if (!key) return true;
  const bit = key === 'blue' ? 1 : key === 'yellow' ? 2 : key === 'red' ? 4 : 0;
  return Boolean(mask & bit);
}
function maskKeys(mask) {
  return ['blue', 'yellow', 'red'].filter(key => maskHas(mask, key));
}
function thingList(workspace) {
  if (typeof workspace.listThings === 'function') return workspace.listThings({ limit: 65535 });
  return Array.isArray(workspace.geometry.things)
    ? workspace.geometry.things.map((thing, index) => ({ index, ...thing }))
    : [];
}

export function buildNavigationGraph(workspace) {
  const g = workspace.geometry;
  const nodes = g.sectors.map((sector, index) => ({
    sector: index,
    center: sectorCenter(g, index),
    floor: Number(sector.floor),
    ceiling: Number(sector.ceiling),
    light: Number(sector.light),
    special: Number(sector.special || 0),
    tag: Number(sector.tag || 0)
  }));
  const edges = [];
  for (let lineIndex = 0; lineIndex < g.linedefs.length; lineIndex++) {
    const line = g.linedefs[lineIndex];
    const right = sideSector(g, line.right);
    const left = sideSector(g, line.left);
    if (right == null || left == null || right === left) continue;
    edges.push(classifyPortal(g, lineIndex, right, left));
    edges.push(classifyPortal(g, lineIndex, left, right));
  }

  const things = thingList(workspace).map(thing => ({
    ...thing,
    sector: locatePointSector(workspace, { x: Number(thing.x), y: Number(thing.y) })
  }));
  const keys = things.filter(thing => KEY_TYPES[Number(thing.doomEdNum)]).map(thing => ({
    thing: thing.index,
    key: KEY_TYPES[Number(thing.doomEdNum)],
    sector: thing.sector,
    x: Number(thing.x), y: Number(thing.y)
  })).filter(item => item.sector != null);
  const starts = things.filter(thing => START_TYPES.has(Number(thing.doomEdNum))).map(thing => ({
    thing: thing.index,
    doomEdNum: Number(thing.doomEdNum),
    sector: thing.sector,
    x: Number(thing.x), y: Number(thing.y), angle: Number(thing.angle || 0)
  })).filter(item => item.sector != null);

  const exits = [];
  g.linedefs.forEach((line, lineIndex) => {
    const spec = EXIT_SPECIALS[Number(line.special)];
    if (!spec) return;
    const sectors = unique([sideSector(g, line.right), sideSector(g, line.left)].filter(value => value != null));
    exits.push({ line: lineIndex, special: Number(line.special), ...spec, sectors, midpoint: lineMidpoint(g, line) });
  });

  const outgoing = Object.fromEntries(nodes.map(node => [node.sector, []]));
  for (const edge of edges) outgoing[edge.from].push(edge.id);
  const passableEdges = edges.filter(edge => edge.passable).length;
  return {
    version: NAVIGATION_VERSION,
    map: workspace.mapName,
    constraints: { playerHeight: PLAYER_HEIGHT, maxStepUp: MAX_STEP_UP, minPortalWidth: MIN_PORTAL_WIDTH },
    nodes,
    edges,
    outgoing,
    things: { starts, keys },
    exits,
    summary: {
      sectors: nodes.length,
      directedEdges: edges.length,
      passableEdges,
      blockedEdges: edges.length - passableEdges,
      starts: starts.length,
      keys: keys.length,
      exits: exits.length
    }
  };
}

function usableEdge(edge, mask, { allowDrops = true } = {}) {
  if (!edge.passable) return false;
  if (edge.kind === 'drop' && !allowDrops) return false;
  if (!maskHas(mask, edge.requiredKey)) return false;
  return true;
}
function edgeCost(graph, edge) {
  const a = graph.nodes[edge.from]?.center || edge.midpoint;
  const b = graph.nodes[edge.to]?.center || edge.midpoint;
  const base = Math.max(1, dist(a, edge.midpoint) + dist(edge.midpoint, b));
  return base + (edge.kind === 'door' ? 24 : edge.kind === 'lift' ? 48 : edge.kind === 'drop' ? 8 : 0);
}

export function findSectorPath(graph, fromSector, toSector, options = {}) {
  const start = Math.trunc(Number(fromSector)), target = Math.trunc(Number(toSector));
  if (!graph.nodes[start] || !graph.nodes[target]) throw new Error('Navigation path endpoints must be valid sector indices');
  const mask = keyMask(options.keys || []);
  const distMap = new Map([[start, 0]]);
  const prev = new Map();
  const open = new Set([start]);

  while (open.size) {
    let current = null, best = Infinity;
    for (const sector of open) {
      const score = distMap.get(sector) ?? Infinity;
      if (score < best) { best = score; current = sector; }
    }
    open.delete(current);
    if (current === target) break;
    for (const edge of graph.edges) {
      if (edge.from !== current || !usableEdge(edge, mask, options)) continue;
      const nextScore = best + edgeCost(graph, edge);
      if (nextScore < (distMap.get(edge.to) ?? Infinity)) {
        distMap.set(edge.to, nextScore);
        prev.set(edge.to, edge);
        open.add(edge.to);
      }
    }
  }
  if (!distMap.has(target)) return { found: false, fromSector: start, toSector: target, keys: maskKeys(mask), reason: 'unreachable' };

  const edges = [];
  let cursor = target;
  while (cursor !== start) {
    const edge = prev.get(cursor);
    if (!edge) throw new Error('Navigation path reconstruction failed');
    edges.push(edge);
    cursor = edge.from;
  }
  edges.reverse();
  return {
    found: true,
    fromSector: start,
    toSector: target,
    keys: maskKeys(mask),
    cost: distMap.get(target),
    sectors: [start, ...edges.map(edge => edge.to)],
    edges
  };
}

export function reachableSectors(graph, startSector, options = {}) {
  const start = Math.trunc(Number(startSector));
  if (!graph.nodes[start]) throw new Error(`Unknown start sector ${startSector}`);
  const mask = keyMask(options.keys || []);
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const current = queue.shift();
    for (const edge of graph.edges) {
      if (edge.from !== current || !usableEdge(edge, mask, options) || seen.has(edge.to)) continue;
      seen.add(edge.to); queue.push(edge.to);
    }
  }
  return [...seen].sort((a, b) => a - b);
}

export function findExitProgression(graph, startSector, options = {}) {
  const start = Math.trunc(Number(startSector));
  if (!graph.nodes[start]) throw new Error(`Unknown start sector ${startSector}`);
  const keysBySector = new Map();
  for (const item of graph.things.keys || []) {
    if (!keysBySector.has(item.sector)) keysBySector.set(item.sector, []);
    keysBySector.get(item.sector).push(item.key);
  }
  const exitBySector = new Map();
  for (const exit of graph.exits || []) for (const sector of exit.sectors) {
    if (!exitBySector.has(sector)) exitBySector.set(sector, []);
    exitBySector.get(sector).push(exit);
  }

  const initialMask = keyMask(options.keys || []) | keyMask(keysBySector.get(start) || []);
  const startId = `${start}:${initialMask}`;
  const queue = [{ sector: start, mask: initialMask, id: startId }];
  const seen = new Set([startId]);
  const prev = new Map();
  let goal = null;

  while (queue.length) {
    const state = queue.shift();
    const exits = exitBySector.get(state.sector) || [];
    const allowedExit = exits.find(exit => options.includeSecret !== false || !exit.secret);
    if (allowedExit) { goal = { ...state, exit: allowedExit }; break; }
    for (const edge of graph.edges) {
      if (edge.from !== state.sector || !usableEdge(edge, state.mask, options)) continue;
      const nextMask = state.mask | keyMask(keysBySector.get(edge.to) || []);
      const id = `${edge.to}:${nextMask}`;
      if (seen.has(id)) continue;
      seen.add(id);
      prev.set(id, { previous: state.id, edge, acquiredKeys: maskKeys(nextMask & ~state.mask) });
      queue.push({ sector: edge.to, mask: nextMask, id });
    }
  }
  if (!goal) return { found: false, startSector: start, reason: 'no_reachable_exit', exploredStates: seen.size };

  const transitions = [];
  let cursor = goal.id;
  while (cursor !== startId) {
    const row = prev.get(cursor);
    if (!row) throw new Error('Exit progression reconstruction failed');
    transitions.push({ edge: row.edge, acquiredKeys: row.acquiredKeys });
    cursor = row.previous;
  }
  transitions.reverse();
  return {
    found: true,
    startSector: start,
    finalSector: goal.sector,
    keys: maskKeys(goal.mask),
    sectors: [start, ...transitions.map(item => item.edge.to)],
    transitions,
    exit: goal.exit,
    exploredStates: seen.size,
    note: 'Sector-level progression assumes a key located in an entered sector can be collected before leaving that sector.'
  };
}
