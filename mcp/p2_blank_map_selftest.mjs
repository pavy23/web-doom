import assert from 'node:assert/strict';

import { GeometryWorkspace, MAP_LUMP_ORDER, inspectBuiltMap, parseWad } from './geometry.js';
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

function derivedLumps(bytes, mapName) {
  const doc = parseWad(bytes);
  const marker = doc.lumps.findIndex(lump => lump.name === mapName);
  assert.ok(marker >= 0, `Missing ${mapName}`);
  return Object.fromEntries(MAP_LUMP_ORDER.map((name, index) => [name, doc.lumps[marker + 1 + index].data]));
}

function inspectVanillaDerivedReferences(bytes, mapName, geometry) {
  const lumps = derivedLumps(bytes, mapName);
  assert.equal(lumps.SEGS.length % 12, 0);
  assert.equal(lumps.SSECTORS.length % 4, 0);
  assert.equal(lumps.NODES.length % 28, 0);
  assert.ok(lumps.NODES.length >= 28, 'Generated runtime map must contain at least one Vanilla BSP node');
  assert.ok(lumps.BLOCKMAP.length >= 8);

  const segs = [];
  for (let at = 0; at < lumps.SEGS.length; at += 12) {
    const seg = {
      v1: lumps.SEGS.readUInt16LE(at),
      v2: lumps.SEGS.readUInt16LE(at + 2),
      linedef: lumps.SEGS.readUInt16LE(at + 6),
      side: lumps.SEGS.readUInt16LE(at + 8)
    };
    assert.ok(seg.v1 < geometry.vertices.length, `SEG v1 ${seg.v1} outside VERTEXES`);
    assert.ok(seg.v2 < geometry.vertices.length, `SEG v2 ${seg.v2} outside VERTEXES`);
    assert.ok(seg.linedef < geometry.linedefs.length, `SEG linedef ${seg.linedef} outside LINEDEFS`);
    assert.ok(seg.side === 0 || seg.side === 1, `SEG side ${seg.side} must be 0/1`);
    const line = geometry.linedefs[seg.linedef];
    const sideIndex = seg.side === 0 ? line.right : line.left;
    assert.notEqual(sideIndex, 0xffff, `SEG references missing sidedef: line=${seg.linedef} side=${seg.side}`);
    assert.ok(sideIndex < geometry.sidedefs.length, `SEG sidedef ${sideIndex} outside SIDEDEFS`);
    segs.push(seg);
  }

  const subsectors = [];
  for (let at = 0; at < lumps.SSECTORS.length; at += 4) {
    const subsector = { count: lumps.SSECTORS.readUInt16LE(at), first: lumps.SSECTORS.readUInt16LE(at + 2) };
    assert.ok(subsector.count > 0, 'Vanilla subsector must contain at least one SEG');
    assert.ok(subsector.first + subsector.count <= segs.length, `SSECTOR SEG range exceeds SEGS: ${JSON.stringify(subsector)}`);
    subsectors.push(subsector);
  }

  const nodeCount = lumps.NODES.length / 28;
  for (let at = 0; at < lumps.NODES.length; at += 28) {
    for (const childOffset of [24, 26]) {
      const child = lumps.NODES.readUInt16LE(at + childOffset);
      if (child & 0x8000) assert.ok((child & 0x7fff) < subsectors.length, `NODE subsector child ${child & 0x7fff} outside SSECTORS`);
      else assert.ok(child < nodeCount, `NODE child ${child} outside NODES`);
    }
  }

  const blockmap = {
    originX: lumps.BLOCKMAP.readInt16LE(0),
    originY: lumps.BLOCKMAP.readInt16LE(2),
    width: lumps.BLOCKMAP.readUInt16LE(4),
    height: lumps.BLOCKMAP.readUInt16LE(6)
  };
  assert.ok(blockmap.width > 0 && blockmap.height > 0, `Invalid BLOCKMAP dimensions: ${JSON.stringify(blockmap)}`);
  assert.ok(8 + blockmap.width * blockmap.height * 2 <= lumps.BLOCKMAP.length, `BLOCKMAP offset table exceeds lump: ${JSON.stringify(blockmap)}`);

  return { segs, subsectors, nodeCount, blockmap };
}

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
assert.equal(workspace.geometry.vertices.length, 6);
assert.equal(workspace.geometry.linedefs.length, 7);
assert.equal(workspace.geometry.sidedefs.length, 8);
assert.equal(workspace.geometry.sectors.length, 2);
const starts = workspace.listThings({ category: 'start' });
assert.equal(starts.length, 1);
assert.equal(starts[0].doomEdNum, 1);
assert.equal(starts[0].x, -128);
assert.equal(workspace.geometry.linedefs[3].special, 11);
assert.equal(generated.seed.portalLine, 6);

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
assert.equal(inspected.counts.sectors, 3);
assert.ok(inspected.counts.nodeBytes > 0);
assert.ok(inspected.counts.blockmapBytes > 0);
const vanillaReferences = inspectVanillaDerivedReferences(rebuilt.bytes, 'E1M1', workspace.geometry);

console.log('P2.0 source-free blank map static regression passed:', JSON.stringify({
  empty: emptyInspection,
  seed: generated.seed,
  authoredSector: authored.sector,
  repairTypes: plan.edits.map(edit => edit.type),
  built: inspected.counts,
  vanillaReferences
}));
