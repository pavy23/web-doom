import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GeometryWorkspace } from './geometry.js';
import { EpisodeWorkspace } from './episode_workspace.js';
import { installFullTopologyValidator } from './topology_validator.js';
import { installThingAuthoring } from './thing_authoring.js';
import { installSemanticGeometry } from './semantic_geometry.js';
import { buildNavigationGraph } from './navigation_graph.js';
import { diagnoseNavigation, installAutoRepair, planAutoRepairs } from './auto_repair.js';
import { applyRepairPlan } from './auto_repair_episode.js';

installFullTopologyValidator(GeometryWorkspace);
installThingAuthoring(GeometryWorkspace);
installSemanticGeometry(GeometryWorkspace);
installAutoRepair(GeometryWorkspace);

const NO_SIDE = 0xffff;
const ML_BLOCKING = 0x0001;

function missingKeyWorkspace() {
  const vertices = [
    { x: 0, y: 0 }, { x: 0, y: 128 }, { x: 128, y: 128 }, { x: 128, y: 0 },
    { x: 256, y: 128 }, { x: 256, y: 0 }, { x: 384, y: 128 }, { x: 384, y: 0 }
  ];
  const sectors = [0, 1, 2].map(() => ({ floor: 0, ceiling: 128, light: 160, special: 0, tag: 0 }));
  const sidedefs = [];
  const side = sector => sidedefs.push({ sector }) - 1;
  const linedefs = [];
  const one = (v1, v2, sector, special = 0) => linedefs.push({ v1, v2, flags: 1, special, tag: 0, right: side(sector), left: NO_SIDE });
  const two = (v1, v2, rightSector, leftSector, special = 0, flags = 4) => linedefs.push({ v1, v2, flags, special, tag: 0, right: side(rightSector), left: side(leftSector) });
  one(0, 1, 0); one(1, 2, 0); two(2, 3, 0, 1); one(3, 0, 0);
  one(2, 4, 1); two(4, 5, 1, 2, 26); one(5, 3, 1);
  one(4, 6, 2); one(6, 7, 2, 11); one(7, 5, 2);
  const things = [{ index: 0, doomEdNum: 1, x: 64, y: 64, angle: 0, flags: 7 }];
  return {
    mapName: 'E1M1',
    geometry: { vertices, linedefs, sidedefs, sectors, things },
    originalCounts: { vertices: vertices.length, linedefs: linedefs.length, sidedefs: sidedefs.length, sectors: sectors.length, things: things.length },
    history: [],
    listThings() { return things; }
  };
}

const missingKey = missingKeyWorkspace();
const keyDiagnosis = diagnoseNavigation(missingKey);
assert.equal(keyDiagnosis.healthy, false);
assert.ok(keyDiagnosis.issues.some(row => row.code === 'KEY_MISSING'), JSON.stringify(keyDiagnosis));
const keyPlan = planAutoRepairs(missingKey, keyDiagnosis);
assert.ok(keyPlan.edits.some(edit => edit.type === 'thing_add' && edit.doomEdNum === 5), JSON.stringify(keyPlan));
console.error('P1.4 missing-key diagnosis/repair planning passed');

const here = path.dirname(fileURLToPath(import.meta.url));
const source = await readFile(path.join(here, '..', 'doom1.wad'));
function midpoint(g, line) {
  const a = g.vertices[line.v1], b = g.vertices[line.v2];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
function lineLength(g, line) {
  const a = g.vertices[line.v1], b = g.vertices[line.v2];
  return Math.hypot(b.x - a.x, b.y - a.y);
}
function frontSector(g, line) {
  if (line.right === NO_SIDE) return null;
  return g.sidedefs[line.right]?.sector ?? null;
}
function chooseSafeWall(sourceBytes) {
  const baseline = new EpisodeWorkspace(sourceBytes, ['E1M1'], 'doom1.wad');
  const workspace = baseline.workspaces.get('E1M1');
  const graph = buildNavigationGraph(workspace);
  const start = graph.things.starts.find(item => item.doomEdNum === 1 && item.sector != null);
  assert.ok(start);
  const candidates = workspace.geometry.linedefs.map((line, index) => ({ line, index }))
    .filter(({ line }) => line.left === NO_SIDE && frontSector(workspace.geometry, line) === start.sector && lineLength(workspace.geometry, line) >= 64)
    .sort((a, b) => {
      const pa = midpoint(workspace.geometry, a.line), pb = midpoint(workspace.geometry, b.line);
      return Math.hypot(pa.x - start.x, pa.y - start.y) - Math.hypot(pb.x - start.x, pb.y - start.y);
    });
  for (const candidate of candidates) {
    const probe = new EpisodeWorkspace(sourceBytes, ['E1M1'], 'doom1.wad');
    try {
      probe.beginTransaction(`P1.4 probe ${candidate.index}`);
      const applied = probe.applyEdits([{ type: 'add_polygon_room', map: 'E1M1', line: candidate.index, sides: 4, depth: 80, wallTexture: 'STARTAN3' }]);
      const validation = probe.validate({ touchedOnly: true });
      const targetSector = applied.results[0].result.sector;
      if (validation.ok) {
        probe.rollbackTransaction();
        return { line: candidate.index, targetSector, startSector: start.sector };
      }
      probe.rollbackTransaction();
    } catch {
      if (probe.transaction) probe.rollbackTransaction();
    }
  }
  throw new Error(`No safe wall found in E1M1 Player 1 sector ${start.sector}`);
}

const chosen = chooseSafeWall(source);
const episode = new EpisodeWorkspace(source, ['E1M1'], 'doom1.wad');
episode.beginTransaction('P1.4 author target room');
const authored = episode.applyEdits([{ type: 'add_polygon_room', map: 'E1M1', line: chosen.line, sides: 4, depth: 80, wallTexture: 'STARTAN3' }]);
const targetSector = authored.results[0].result.sector;
assert.equal(targetSector, chosen.targetSector);
assert.equal(episode.validate({ touchedOnly: true }).ok, true);
assert.equal(episode.commitTransaction().committed, true);

const workspace = episode.workspaces.get('E1M1');
workspace.geometry.linedefs[chosen.line].flags |= ML_BLOCKING;
let diagnosis = diagnoseNavigation(workspace, { targetSector });
assert.equal(diagnosis.healthy, false);
assert.ok(diagnosis.issues.some(row => row.code === 'BLOCKED_PORTAL_FLAG'), JSON.stringify(diagnosis));
const repairPlan = planAutoRepairs(workspace, diagnosis);
assert.ok(repairPlan.edits.some(edit => edit.type === 'repair_clear_blocking' && edit.line === chosen.line), JSON.stringify(repairPlan));

episode.beginTransaction('P1.4 repair blocked authored portal');
const repaired = applyRepairPlan(episode, repairPlan.edits);
assert.ok(repaired.results.length > 0);
const validation = episode.validate({ touchedOnly: true });
assert.equal(validation.ok, true, JSON.stringify(validation));
assert.equal(episode.commitTransaction().committed, true);
diagnosis = diagnoseNavigation(workspace, { targetSector });
assert.equal(diagnosis.healthy, true, JSON.stringify(diagnosis));
assert.ok(diagnosis.path?.found, JSON.stringify(diagnosis));
assert.equal(Boolean(workspace.geometry.linedefs[chosen.line].flags & ML_BLOCKING), false);
console.error('P1.4 authored-portal diagnosis -> atomic repair -> healthy path passed:', JSON.stringify({
  line: chosen.line, startSector: chosen.startSector, targetSector, revision: episode.revision
}));
