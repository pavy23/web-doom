import { buildNavigationGraph, findExitProgression, findSectorPath, reachableSectors } from './navigation_graph.js';

export const AUTO_REPAIR_VERSION = '2.5.0-p1.4';

const NO_SIDE = 0xffff;
const ML_BLOCKING = 0x0001;
const ML_TWOSIDED = 0x0004;
const KEY_TYPES = Object.freeze({ blue: 5, yellow: 6, red: 13 });
const PLAYER_HEIGHT = 56;
const MAX_STEP_UP = 24;
const PATCH_MARK = Symbol.for('web-doom.p1.4-auto-repair-installed');

function unique(values) { return [...new Set(values)]; }
function sideSector(g, sideIndex) {
  if (sideIndex === NO_SIDE) return null;
  return g.sidedefs[sideIndex]?.sector ?? null;
}
function lineSectors(g, line) {
  return unique([sideSector(g, line.right), sideSector(g, line.left)].filter(value => value != null));
}
function sameJson(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function firstBaselineGeometry(workspace) {
  return workspace.history?.[0]?.geometry || null;
}
export function isAuthoredLine(workspace, lineIndex) {
  const index = Math.trunc(Number(lineIndex));
  if (index >= Number(workspace.originalCounts?.linedefs ?? Infinity)) return true;
  const baseline = firstBaselineGeometry(workspace)?.linedefs?.[index];
  const current = workspace.geometry.linedefs[index];
  return Boolean(baseline && current && !sameJson(baseline, current));
}
export function isAuthoredSector(workspace, sectorIndex) {
  const index = Math.trunc(Number(sectorIndex));
  if (index >= Number(workspace.originalCounts?.sectors ?? Infinity)) return true;
  const baseline = firstBaselineGeometry(workspace)?.sectors?.[index];
  const current = workspace.geometry.sectors[index];
  return Boolean(baseline && current && !sameJson(baseline, current));
}
function playerStart(graph) {
  return graph.things.starts.find(item => item.doomEdNum === 1 && item.sector != null) || null;
}
function normalizeKeys(keys = []) {
  return unique((Array.isArray(keys) ? keys : [keys]).map(value => String(value).toLowerCase())
    .filter(value => ['blue', 'yellow', 'red'].includes(value)));
}
function collectReachability(graph, startSector, initialKeys = [], allowDrops = true) {
  let keys = normalizeKeys(initialKeys);
  let reachable = [];
  let changed = true;
  let rounds = 0;
  while (changed && rounds < 8) {
    rounds++;
    reachable = reachableSectors(graph, startSector, { keys, allowDrops });
    const set = new Set(reachable);
    const found = graph.things.keys.filter(item => set.has(item.sector)).map(item => item.key);
    const next = normalizeKeys([...keys, ...found]);
    changed = next.length !== keys.length;
    keys = next;
  }
  reachable = reachableSectors(graph, startSector, { keys, allowDrops });
  return { reachable, reachableSet: new Set(reachable), keys, rounds };
}
function issue(code, severity, message, data = {}) {
  return { code, severity, message, ...data };
}
function frontierIssues(workspace, graph, reach) {
  const issues = [];
  const seen = new Set();
  for (const edge of graph.edges) {
    if (!reach.reachableSet.has(edge.from) || reach.reachableSet.has(edge.to)) continue;
    let row = null;
    if (!edge.passable) {
      if (String(edge.reason || '').startsWith('linedef_blocking_flag')) {
        row = issue('BLOCKED_PORTAL_FLAG', 'error', `Portal linedef ${edge.line} is blocking sector ${edge.from} -> ${edge.to}`, { edge });
      } else if (String(edge.reason || '').startsWith('step_up_too_high')) {
        row = issue('PORTAL_STEP_TOO_HIGH', 'error', `Sector ${edge.to} is too high to step into from sector ${edge.from}`, { edge });
      } else if (String(edge.reason || '').startsWith('insufficient_vertical_opening')) {
        row = issue('PORTAL_CLEARANCE_TOO_LOW', 'error', `Portal ${edge.line} has insufficient vertical clearance`, { edge });
      } else if (String(edge.reason || '').startsWith('portal_too_narrow')) {
        row = issue('PORTAL_TOO_NARROW', 'error', `Portal ${edge.line} is too narrow for conservative autonomous traversal`, { edge });
      } else {
        row = issue('BLOCKED_PORTAL', 'error', `Portal ${edge.line} is statically blocked: ${edge.reason || 'unknown'}`, { edge });
      }
    } else if (edge.requiredKey && !reach.keys.includes(edge.requiredKey)) {
      const keyItems = graph.things.keys.filter(item => item.key === edge.requiredKey);
      row = issue(keyItems.length ? 'KEY_INACCESSIBLE' : 'KEY_MISSING', 'error',
        keyItems.length
          ? `${edge.requiredKey} key exists but is not reachable before locked door ${edge.line}`
          : `${edge.requiredKey} key is required by door ${edge.line} but does not exist`,
        { edge, key: edge.requiredKey, keyItems });
    }
    if (row) {
      const id = `${row.code}:${edge.line}:${edge.from}:${edge.to}`;
      if (!seen.has(id)) { seen.add(id); issues.push(row); }
    }
  }
  return issues;
}

export function diagnoseNavigation(workspace, options = {}) {
  const graph = buildNavigationGraph(workspace);
  const startThing = playerStart(graph);
  const goal = options.targetSector == null ? 'exit' : 'target';
  const diagnosis = {
    version: AUTO_REPAIR_VERSION,
    map: workspace.mapName,
    goal,
    targetSector: options.targetSector == null ? null : Math.trunc(Number(options.targetSector)),
    healthy: false,
    startSector: startThing?.sector ?? null,
    startThing,
    graphSummary: graph.summary,
    issues: [],
    progression: null,
    path: null,
    reachability: null
  };
  if (!startThing) {
    diagnosis.issues.push(issue('PLAYER1_START_MISSING_OR_UNLOCATABLE', 'fatal', 'Player 1 start is missing or cannot be located in a sector'));
    return diagnosis;
  }
  if (goal === 'target' && !graph.nodes[diagnosis.targetSector]) {
    diagnosis.issues.push(issue('TARGET_SECTOR_INVALID', 'fatal', `Unknown target sector ${diagnosis.targetSector}`));
    return diagnosis;
  }

  const reach = collectReachability(graph, startThing.sector, options.keys || [], options.allowDrops !== false);
  diagnosis.reachability = { sectors: reach.reachable, count: reach.reachable.length, keys: reach.keys, rounds: reach.rounds };

  if (goal === 'target') {
    if (reach.reachableSet.has(diagnosis.targetSector)) {
      diagnosis.path = findSectorPath(graph, startThing.sector, diagnosis.targetSector, { keys: reach.keys, allowDrops: options.allowDrops !== false });
      diagnosis.healthy = Boolean(diagnosis.path.found);
      if (diagnosis.healthy) return diagnosis;
    }
  } else {
    diagnosis.progression = findExitProgression(graph, startThing.sector, {
      keys: options.keys || [], includeSecret: options.includeSecret !== false, allowDrops: options.allowDrops !== false
    });
    if (diagnosis.progression.found) {
      diagnosis.healthy = true;
      return diagnosis;
    }
    if (!graph.exits.length) diagnosis.issues.push(issue('EXIT_MISSING', 'error', 'Map has no recognized Vanilla exit linedef'));
  }

  diagnosis.issues.push(...frontierIssues(workspace, graph, reach));
  if (!diagnosis.issues.length) {
    diagnosis.issues.push(issue('DISCONNECTED_GOAL', 'error', goal === 'target'
      ? `Target sector ${diagnosis.targetSector} is disconnected from the reachable component`
      : 'Exit exists but is disconnected from the reachable component'));
  }
  return diagnosis;
}

function chooseReachableExitLine(workspace, diagnosis, allowLegacyGeometry) {
  const g = workspace.geometry;
  const reachable = new Set(diagnosis.reachability?.sectors || []);
  const candidates = [];
  g.linedefs.forEach((line, index) => {
    if (line.left !== NO_SIDE || line.right === NO_SIDE) return;
    const sector = sideSector(g, line.right);
    if (!reachable.has(sector)) return;
    const authored = isAuthoredLine(workspace, index) || isAuthoredSector(workspace, sector);
    if (!authored && !allowLegacyGeometry) return;
    const a = g.vertices[line.v1], b = g.vertices[line.v2];
    const length = a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0;
    candidates.push({ line: index, sector, authored, length });
  });
  candidates.sort((a, b) => Number(b.authored) - Number(a.authored) || b.length - a.length || a.line - b.line);
  return candidates[0] || null;
}
function repairForIssue(workspace, diagnosis, row, options) {
  const allowLegacyGeometry = Boolean(options.allowLegacyGeometry);
  const allowThingRepair = options.allowThingRepair !== false;
  const map = workspace.mapName;
  const g = workspace.geometry;
  if (row.code === 'KEY_MISSING' || row.code === 'KEY_INACCESSIBLE') {
    if (!allowThingRepair || !diagnosis.startThing || !KEY_TYPES[row.key]) return { rejected: 'thing_repair_disabled' };
    const existing = row.keyItems?.[0];
    if (existing) {
      return { edit: { type: 'thing_move', map, thing: existing.thing, x: diagnosis.startThing.x, y: diagnosis.startThing.y, angle: 0 }, rationale: `Move inaccessible ${row.key} key to Player 1 start sector` };
    }
    return { edit: { type: 'thing_add', map, doomEdNum: KEY_TYPES[row.key], x: diagnosis.startThing.x, y: diagnosis.startThing.y, angle: 0, flags: 7 }, rationale: `Add missing ${row.key} key at Player 1 start` };
  }
  if (row.code === 'BLOCKED_PORTAL_FLAG') {
    if (!isAuthoredLine(workspace, row.edge.line) && !allowLegacyGeometry) return { rejected: 'legacy_linedef_protected' };
    return { edit: { type: 'repair_clear_blocking', map, line: row.edge.line }, rationale: `Clear ML_BLOCKING on authored portal ${row.edge.line}` };
  }
  if (row.code === 'PORTAL_STEP_TOO_HIGH' || row.code === 'PORTAL_CLEARANCE_TOO_LOW') {
    const to = g.sectors[row.edge.to], from = g.sectors[row.edge.from];
    if (!to || !from) return { rejected: 'missing_sector' };
    if (!isAuthoredSector(workspace, row.edge.to) && !allowLegacyGeometry) return { rejected: 'legacy_sector_protected' };
    let floor = Number(to.floor);
    let ceiling = Number(to.ceiling);
    if (floor - Number(from.floor) > MAX_STEP_UP) floor = Number(from.floor) + MAX_STEP_UP;
    const neededTop = Math.max(Number(from.floor), floor) + PLAYER_HEIGHT;
    if (Number(from.ceiling) < neededTop) return { rejected: 'source_sector_clearance_too_low' };
    if (ceiling < neededTop) ceiling = neededTop;
    if (ceiling <= floor) return { rejected: 'invalid_height_repair' };
    return { edit: { type: 'set_sector_heights', map, sector: row.edge.to, floor, ceiling }, rationale: `Normalize authored sector ${row.edge.to} to Doom step/clearance limits` };
  }
  if (row.code === 'EXIT_MISSING') {
    const candidate = chooseReachableExitLine(workspace, diagnosis, allowLegacyGeometry);
    if (!candidate) return { rejected: 'no_safe_reachable_exit_linedef' };
    return { edit: { type: 'repair_set_linedef_special', map, line: candidate.line, special: 11, tag: 0 }, rationale: `Assign reusable Vanilla USE exit special 11 to reachable authored wall ${candidate.line}` };
  }
  return { rejected: 'no_conservative_repair' };
}

export function planAutoRepairs(workspace, diagnosis = null, options = {}) {
  const current = diagnosis || diagnoseNavigation(workspace, options);
  const maxEdits = Math.max(1, Math.min(8, Math.trunc(Number(options.maxEdits ?? 4))));
  if (current.healthy) return { version: AUTO_REPAIR_VERSION, map: workspace.mapName, healthy: true, edits: [], rejected: [] };
  const edits = [];
  const rejected = [];
  const dedupe = new Set();
  for (const row of current.issues) {
    if (edits.length >= maxEdits) break;
    const planned = repairForIssue(workspace, current, row, options);
    if (!planned.edit) { rejected.push({ issue: row.code, reason: planned.rejected || 'unknown' }); continue; }
    const key = JSON.stringify(planned.edit);
    if (dedupe.has(key)) continue;
    dedupe.add(key);
    edits.push({ ...planned.edit, rationale: planned.rationale, sourceIssue: row.code });
  }
  return {
    version: AUTO_REPAIR_VERSION,
    map: workspace.mapName,
    healthy: false,
    diagnosis: current,
    edits,
    rejected,
    manualRequired: edits.length === 0
  };
}

export function installAutoRepair(GeometryWorkspace) {
  if (GeometryWorkspace.prototype[PATCH_MARK]) return;
  Object.defineProperty(GeometryWorkspace.prototype, PATCH_MARK, { value: true });

  GeometryWorkspace.prototype.repairClearBlocking = function repairClearBlocking({ line, linedef } = {}) {
    const index = Math.trunc(Number(line ?? linedef));
    const target = this.geometry.linedefs[index];
    if (!target) throw new Error(`Unknown linedef ${index}`);
    if (target.left === NO_SIDE) throw new Error(`Linedef ${index} is one-sided; clearing blocking would open void`);
    this.checkpoint(`auto_repair_clear_blocking:${index}`);
    target.flags = (Number(target.flags) | ML_TWOSIDED) & ~ML_BLOCKING;
    return { linedef: index, flags: target.flags, rightSector: sideSector(this.geometry, target.right), leftSector: sideSector(this.geometry, target.left) };
  };

  GeometryWorkspace.prototype.repairSetLinedefSpecial = function repairSetLinedefSpecial({ line, linedef, special, tag = 0 } = {}) {
    const index = Math.trunc(Number(line ?? linedef));
    const target = this.geometry.linedefs[index];
    if (!target) throw new Error(`Unknown linedef ${index}`);
    const nextSpecial = Math.trunc(Number(special));
    const nextTag = Math.trunc(Number(tag));
    if (!Number.isInteger(nextSpecial) || nextSpecial < 0 || nextSpecial > 65535) throw new Error('Linedef special must be 0..65535');
    if (!Number.isInteger(nextTag) || nextTag < 0 || nextTag > 65535) throw new Error('Linedef tag must be 0..65535');
    this.checkpoint(`auto_repair_linedef_special:${index}`);
    target.special = nextSpecial;
    target.tag = nextTag;
    return { linedef: index, special: target.special, tag: target.tag, sectors: lineSectors(this.geometry, target) };
  };
}
