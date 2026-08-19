import assert from 'node:assert/strict';

import { GeometryWorkspace, inspectBuiltMap } from './geometry.js';
import { EpisodeWorkspace } from './episode_workspace.js';
import { installFullTopologyValidator } from './topology_validator.js';
import { installThingAuthoring } from './thing_authoring.js';
import { installSemanticGeometry } from './semantic_geometry.js';
import { diagnoseNavigation, installAutoRepair, planAutoRepairs } from './auto_repair.js';
import { applyRepairPlan } from './auto_repair_episode.js';
import { rebuildVanillaNodes } from './nodebuilder.js';
import { createEmptyMapPwad, createSeededBlankMapPwad, inspectCanonicalBlankMap, markWorkspaceAsGenerated } from './blank_map.js';

installFullTopologyValidator(GeometryWorkspace);
installThingAuthoring(GeometryWorkspace);
installSemanticGeometry(GeometryWorkspace);
installAutoRepair(GeometryWorkspace);

const empty = createEmptyMapPwad('MAP01');
const emptyInspection = inspectCanonicalBlankMap(empty, 'MAP01');
assert.equal(emptyInspection.canonical, true);
assert.deepEqual(emptyInspection.lumpOrder, [
  'THINGS', 'LINEDEFS', 'SIDEDEFS', 'VERTEXES', 'SEGS',
  'SSECTORS', 'NODES', 'SECTORS', 'REJECT', 'BLOCKMAP'
]);
assert.equal(emptyInspection.lumpBytes.THINGS, 0);
assert.equal(emptyInspection.lumpBytes.SECTORS, 0);

const generated = createSeededBlankMapPwad({ map: 'E1M1', width: 512, height: 384, exitWall: 'east' });
const episode = new EpisodeWorkspace(generated.bytes, ['E1M1'], 'p2-generated-test');
for (const workspace of episode.workspaces.values()) markWorkspaceAsGenerated(workspace);
for (const baseline of episode.baselines.values()) markWorkspaceAsGenerated(baseline);

const workspace = episode.workspaces.get('E1M1');
assert.ok(workspace);
assert.deepEqual(workspace.originalCounts, {
  vertices: 0,
  linedefs: 0,
  sidedefs: 0,
  sectors: 0,
  things: 0
});

const initial = workspace.validate();
assert.equal(initial.ok, true, JSON.stringify(initial.errors));
assert.equal(workspace.geometry.vertices.length, 4);
assert.equal(workspace.geometry.linedefs.length, 4);
assert.equal(workspace.geometry.sidedefs.length, 4);
assert.equal(workspace.geometry.sectors.length, 1);
const starts = workspace.listThings({ category: 'start' });
assert.equal(starts.length, 1);
assert.equal(starts[0].doomEdNum, 1);
assert.equal(workspace.geometry.linedefs[2].special, 11);

// Prove that the generated baseline can immediately use the P1.2 semantic layer.
episode.beginTransaction('P2 extend source-free seed');
const editResult = episode.applyEdits([{
  type: 'add_polygon_room',
  map: 'E1M1',
  line: 0,
  sides: 6,
  depth: 192,
  light: 160
}]);
const authored = editResult.results[0].result;
assert.ok(Number.isInteger(authored.sector));
let validation = episode.validate({ touchedOnly: true });
assert.equal(validation.ok, true, JSON.stringify(validation.maps));
assert.equal(episode.commitTransaction().committed, true);

// Deliberately re-break the authored portal. Because originalCounts is zero,
// P1.4 must treat even seed linedef 0 as authored and repairable by default.
workspace.geometry.linedefs[authored.portalLine].flags |= 0x0001;
let diagnosis = diagnoseNavigation(workspace, { targetSector: authored.sector });
assert.equal(diagnosis.healthy, false);
assert.ok(diagnosis.issues.some(issue => issue.code === 'BLOCKED_PORTAL_FLAG'), JSON.stringify(diagnosis.issues));

const plan = planAutoRepairs(workspace, diagnosis, {
  targetSector: authored.sector,
  allowLegacyGeometry: false,
  allowThingRepair: true,
  maxEdits: 4
});
assert.ok(plan.edits.some(edit => edit.type === 'repair_clear_blocking'), JSON.stringify(plan));

episode.beginTransaction('P2 repair generated portal');
applyRepairPlan(episode, plan.edits);
validation = episode.validate({ touchedOnly: true });
assert.equal(validation.ok, true, JSON.stringify(validation.maps));
assert.equal(episode.commitTransaction().committed, true);

diagnosis = diagnoseNavigation(workspace, { targetSector: authored.sector });
assert.equal(diagnosis.healthy, true, JSON.stringify(diagnosis));

const preNode = workspace.preNodeWad();
const rebuilt = await rebuildVanillaNodes(preNode, 'E1M1');
const inspected = inspectBuiltMap(rebuilt.bytes, 'E1M1');
assert.equal(inspected.ok, true, JSON.stringify(inspected));
assert.equal(inspected.counts.sectors, 2);
assert.ok(inspected.counts.nodeBytes > 0);
assert.ok(inspected.counts.blockmapBytes > 0);

console.log('P2.0 source-free blank map static regression passed:', JSON.stringify({
  empty: emptyInspection,
  seed: generated.seed,
  authoredSector: authored.sector,
  repairTypes: plan.edits.map(edit => edit.type),
  built: inspected.counts
}));
