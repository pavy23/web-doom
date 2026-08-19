import { locatePointSector } from './navigation_graph.js';

export const THING_PLACEMENT_VERSION = '2.5.1-p1.4-placement';

const NO_SIDE = 0xffff;
const ML_BLOCKING = 0x0001;
const ML_BLOCKMONSTERS = 0x0002;

// Vanilla mobjinfo radii/heights for actors that must be able to exist and move.
const ACTORS = new Map([
  [1, { radius: 16, height: 56, role: 'start', label: 'Player 1 Start' }],
  [2, { radius: 16, height: 56, role: 'start', label: 'Player 2 Start' }],
  [3, { radius: 16, height: 56, role: 'start', label: 'Player 3 Start' }],
  [4, { radius: 16, height: 56, role: 'start', label: 'Player 4 Start' }],
  [11, { radius: 16, height: 56, role: 'start', label: 'Deathmatch Start' }],
  [9, { radius: 20, height: 56, role: 'monster', label: 'Shotgun Guy' }],
  [3004, { radius: 20, height: 56, role: 'monster', label: 'Zombieman' }],
  [3001, { radius: 20, height: 56, role: 'monster', label: 'Imp' }],
  [3002, { radius: 30, height: 56, role: 'monster', label: 'Demon' }],
  [58, { radius: 30, height: 56, role: 'monster', label: 'Spectre' }],
  [3003, { radius: 24, height: 64, role: 'monster', label: 'Baron of Hell' }],
  [3005, { radius: 31, height: 56, role: 'monster', label: 'Cacodemon' }],
  [3006, { radius: 16, height: 56, role: 'monster', label: 'Lost Soul' }],
  [16, { radius: 40, height: 110, role: 'monster', label: 'Cyberdemon' }],
  [7, { radius: 128, height: 100, role: 'monster', label: 'Spider Mastermind' }],
  [2035, { radius: 10, height: 42, role: 'barrel', label: 'Explosive Barrel' }]
]);

// Common Vanilla solid decorations. Used as obstacles, not as "stuck" subjects.
const SOLID_PROPS = new Map([
  [30, 16], [31, 16], [32, 16], [33, 16], [35, 16], [36, 16], [37, 16],
  [41, 16], [43, 16], [47, 16], [48, 16], [54, 32], [2028, 16]
]);

function actorSpec(doomEdNum) {
  return ACTORS.get(Math.trunc(Number(doomEdNum))) || null;
}
function solidRadius(doomEdNum) {
  const n = Math.trunc(Number(doomEdNum));
  if (ACTORS.has(n)) return ACTORS.get(n).radius;
  if (SOLID_PROPS.has(n)) return SOLID_PROPS.get(n);
  return null;
}
function distToSegment(point, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  let t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}
function isSolidLinedef(line) {
  if (line.left === NO_SIDE || line.right === NO_SIDE) return true;
  return Boolean(Number(line.flags) & (ML_BLOCKING | ML_BLOCKMONSTERS));
}
function solidSegments(g) {
  const out = [];
  for (let index = 0; index < g.linedefs.length; index++) {
    const line = g.linedefs[index];
    if (!isSolidLinedef(line)) continue;
    const a = g.vertices[line.v1], b = g.vertices[line.v2];
    if (a && b) out.push({ line: index, a, b });
  }
  return out;
}
function thingList(workspace) {
  if (typeof workspace.listThings === 'function') return workspace.listThings({ limit: 65535 });
  return Array.isArray(workspace.geometry.things)
    ? workspace.geometry.things.map((thing, index) => ({ index, ...thing }))
    : [];
}

export function diagnoseThingPlacement(workspace) {
  const g = workspace.geometry;
  const things = thingList(workspace);
  const segments = solidSegments(g);
  const originalCount = Number(workspace.originalCounts?.things ?? 0);
  const issues = [];

  const solids = things.map(thing => {
    const radius = solidRadius(thing.doomEdNum);
    if (radius == null) return null;
    return { thing: thing.index, doomEdNum: Number(thing.doomEdNum), x: Number(thing.x), y: Number(thing.y), radius };
  }).filter(Boolean);

  for (const thing of things) {
    const spec = actorSpec(thing.doomEdNum);
    if (!spec) continue;
    const authored = thing.index >= originalCount;
    const point = { x: Number(thing.x), y: Number(thing.y) };
    const sector = locatePointSector(workspace, point);
    const base = {
      thing: thing.index,
      doomEdNum: Number(thing.doomEdNum),
      label: spec.label,
      role: spec.role,
      radius: spec.radius,
      height: spec.height,
      x: point.x,
      y: point.y,
      sector,
      authored
    };

    if (sector == null) {
      issues.push({
        ...base,
        code: 'THING_UNLOCATABLE',
        severity: authored ? 'error' : 'warning',
        message: `${spec.label} ${thing.index} at (${point.x},${point.y}) is not inside any sector (void or solid interior)`
      });
      continue;
    }

    const sectorDef = g.sectors[sector];
    const opening = Number(sectorDef.ceiling) - Number(sectorDef.floor);
    if (opening < spec.height) {
      issues.push({
        ...base,
        code: 'THING_HEIGHT_BLOCKED',
        severity: authored ? 'error' : 'warning',
        opening,
        message: `${spec.label} ${thing.index} is in sector ${sector} with only ${opening} units of height; needs ${spec.height}`
      });
    }

    let minWall = Infinity;
    let wallLine = null;
    for (const segment of segments) {
      const distance = distToSegment(point, segment.a, segment.b);
      if (distance < minWall) {
        minWall = distance;
        wallLine = segment.line;
      }
    }
    if (minWall < spec.radius) {
      issues.push({
        ...base,
        code: 'THING_OVERLAPS_WALL',
        severity: authored ? 'error' : 'warning',
        line: wallLine,
        clearance: minWall,
        message: `${spec.label} ${thing.index} overlaps solid linedef ${wallLine} (clearance ${minWall.toFixed(1)} < radius ${spec.radius})`
      });
    }

    for (const other of solids) {
      if (other.thing === thing.index) continue;
      const gap = Math.hypot(point.x - other.x, point.y - other.y);
      const needed = spec.radius + other.radius;
      if (gap < needed) {
        issues.push({
          ...base,
          code: 'THING_OVERLAPS_SOLID',
          severity: authored ? 'error' : 'warning',
          otherThing: other.thing,
          otherDoomEdNum: other.doomEdNum,
          gap,
          needed,
          message: `${spec.label} ${thing.index} overlaps solid thing ${other.thing} (DoomEd ${other.doomEdNum}) at gap ${gap.toFixed(1)} < ${needed}`
        });
      }
    }
  }

  return {
    version: THING_PLACEMENT_VERSION,
    map: workspace.mapName,
    healthy: issues.filter(row => row.severity === 'error').length === 0,
    issueCount: issues.length,
    authoredStuck: issues.filter(row => row.authored).length,
    issues
  };
}
