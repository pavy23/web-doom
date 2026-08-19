import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

import { GeometryWorkspace, MAP_LUMP_ORDER, parseWad, writeWad } from './geometry.js';
import { EpisodeWorkspace } from './episode_workspace.js';
import { installFullTopologyValidator } from './topology_validator.js';
import { installThingAuthoring } from './thing_authoring.js';
import { installSemanticGeometry } from './semantic_geometry.js';

installFullTopologyValidator(GeometryWorkspace);
installThingAuthoring(GeometryWorkspace);
installSemanticGeometry(GeometryWorkspace);

function name8(value) {
  const out = Buffer.alloc(8); out.write(String(value), 0, 8, 'ascii'); return out;
}
function makeMapLumps(mapName) {
  const vertices = Buffer.alloc(4 * 4);
  [[0, 0], [0, 256], [256, 256], [256, 0]].forEach(([x, y], i) => {
    vertices.writeInt16LE(x, i * 4); vertices.writeInt16LE(y, i * 4 + 2);
  });
  const sidedefs = Buffer.alloc(4 * 30);
  for (let i = 0; i < 4; i++) {
    const at = i * 30;
    name8('-').copy(sidedefs, at + 4);
    name8('-').copy(sidedefs, at + 12);
    name8('STARTAN3').copy(sidedefs, at + 20);
    sidedefs.writeUInt16LE(0, at + 28);
  }
  const linedefs = Buffer.alloc(4 * 14);
  [[0, 1], [1, 2], [2, 3], [3, 0]].forEach(([v1, v2], i) => {
    const at = i * 14;
    linedefs.writeUInt16LE(v1, at);
    linedefs.writeUInt16LE(v2, at + 2);
    linedefs.writeUInt16LE(1, at + 4);
    linedefs.writeUInt16LE(i, at + 10);
    linedefs.writeUInt16LE(0xffff, at + 12);
  });
  const sectors = Buffer.alloc(26);
  sectors.writeInt16LE(0, 0); sectors.writeInt16LE(128, 2);
  name8('FLOOR0_1').copy(sectors, 4); name8('CEIL1_1').copy(sectors, 12);
  sectors.writeInt16LE(160, 20);
  const things = Buffer.alloc(10);
  things.writeInt16LE(128, 0); things.writeInt16LE(128, 2); things.writeInt16LE(90, 4);
  things.writeInt16LE(1, 6); things.writeInt16LE(7, 8);
  return [
    { name: mapName, data: Buffer.alloc(0) },
    { name: 'THINGS', data: things },
    { name: 'LINEDEFS', data: linedefs },
    { name: 'SIDEDEFS', data: sidedefs },
    { name: 'VERTEXES', data: vertices },
    { name: 'SEGS', data: Buffer.alloc(0) },
    { name: 'SSECTORS', data: Buffer.alloc(0) },
    { name: 'NODES', data: Buffer.alloc(0) },
    { name: 'SECTORS', data: sectors },
    { name: 'REJECT', data: Buffer.alloc(0) },
    { name: 'BLOCKMAP', data: Buffer.alloc(0) }
  ];
}
function sourceFor(maps = ['E1M1']) {
  return writeWad({ lumps: maps.flatMap(makeMapLumps) }, 'PWAD');
}
async function buildOne(edit, assertion) {
  const episode = new EpisodeWorkspace(sourceFor(), ['E1M1'], 'p1-semantic-synthetic.wad');
  episode.beginTransaction(`semantic ${edit.type}`);
  const applied = episode.applyEdits([{ map: 'E1M1', ...edit }]);
  const result = applied.results[0].result;
  assertion?.(episode.workspaces.get('E1M1'), result);
  const validation = episode.validate({ touchedOnly: true });
  assert.equal(validation.ok, true, JSON.stringify(validation));
  const commit = episode.commitTransaction();
  assert.equal(commit.committed, true, JSON.stringify(commit));
  const candidate = await episode.build({ filename: `${edit.type}.wad` });
  assert.equal(candidate.maps[0].inspected.ok, true, JSON.stringify(candidate.maps[0].inspected));
  return { episode, candidate, result };
}

await buildOne({ type: 'add_polygon_room', line: 1, sides: 6, depth: 160 }, (workspace, result) => {
  assert.equal(result.sides, 6);
  assert.equal(result.createdVertices.length, 4);
  assert.equal(result.createdLines.length, 5);
  assert.equal(workspace.getSectorBoundary({ sector: result.sector }).edgeCount, 6);
});
console.error('P1.2 polygon room validation/build passed');

await buildOne({ type: 'add_staircase', line: 2, steps: 4, stepDepth: 32, stepHeight: 8, landingDepth: 64 }, (workspace, result) => {
  assert.equal(result.stepSectors.length, 4);
  assert.deepEqual(result.stepSectors.map(index => workspace.geometry.sectors[index].floor), [8, 16, 24, 32]);
  assert.equal(result.finalFloor, 32);
  assert.ok(result.landingSector != null);
});
console.error('P1.2 staircase validation/build passed');

await buildOne({ type: 'add_door_room', line: 3, key: 'blue', behavior: 'raise', doorDepth: 24, roomDepth: 128, doorTexture: 'STARTAN3' }, (workspace, result) => {
  const g = workspace.geometry;
  assert.equal(result.special, 26);
  assert.equal(g.sectors[result.doorSector].floor, g.sectors[result.doorSector].ceiling);
  assert.equal(g.linedefs[result.sourcePortalLine].special, 26);
  assert.equal(g.linedefs[result.destinationPortalLine].special, 26);
  assert.equal(g.sidedefs[g.linedefs[result.destinationPortalLine].right].sector, result.destinationSector);
  assert.equal(g.sidedefs[g.linedefs[result.destinationPortalLine].left].sector, result.doorSector);
});
console.error('P1.2 keyed door room validation/build passed');

await buildOne({ type: 'add_lift_room', line: 0, rise: 64, liftDepth: 64, roomDepth: 128 }, (workspace, result) => {
  const g = workspace.geometry;
  assert.equal(g.sectors[result.liftSector].tag, result.tag);
  assert.equal(g.linedefs[result.callLine].special, 62);
  assert.equal(g.linedefs[result.callLine].tag, result.tag);
  assert.equal(g.linedefs[result.upperTriggerLine].special, 88);
  assert.equal(g.linedefs[result.upperTriggerLine].tag, result.tag);
});
console.error('P1.2 lift room validation/build passed');

await buildOne({ type: 'split_sector', sector: 0, vertexA: 0, vertexB: 2 }, (workspace, result) => {
  assert.equal(workspace.getSectorBoundary({ sector: result.sourceSector }).edgeCount, 3);
  assert.equal(workspace.getSectorBoundary({ sector: result.newSector }).edgeCount, 3);
  assert.equal(workspace.geometry.linedefs[result.splitLine].flags & 4, 4);
});
console.error('P1.2 simple sector split validation/build passed');

const multi = new EpisodeWorkspace(sourceFor(['E1M1', 'E1M2']), ['E1M1', 'E1M2'], 'semantic-atomic.wad');
const before = multi.inspectMap('E1M1', { lineLimit: 16, sectorLimit: 16 });
multi.beginTransaction('semantic cross-map rollback');
let rolledBack = false;
try {
  multi.applyEdits([
    { type: 'add_polygon_room', map: 'E1M1', line: 1, sides: 5, depth: 128 },
    { type: 'add_staircase', map: 'E1M2', line: 999, steps: 4 }
  ]);
} catch (error) {
  rolledBack = /rolled back/i.test(String(error?.message || error));
}
assert.equal(rolledBack, true);
assert.equal(multi.transaction, null);
const after = multi.inspectMap('E1M1', { lineLimit: 16, sectorLimit: 16 });
assert.equal(after.counts.vertices, before.counts.vertices);
assert.equal(after.counts.linedefs, before.counts.linedefs);
assert.equal(after.counts.sectors, before.counts.sectors);
console.error('P1.2 cross-map semantic atomic rollback passed');

const stress = new EpisodeWorkspace(sourceFor(), ['E1M1'], 'semantic-stress.wad');
stress.beginTransaction('all P1.2 semantic primitives');
stress.applyEdits([
  { type: 'add_polygon_room', map: 'E1M1', line: 1, sides: 6, depth: 128 },
  { type: 'add_staircase', map: 'E1M1', line: 2, steps: 4, stepDepth: 32, stepHeight: 8, landingDepth: 64 },
  { type: 'add_door_room', map: 'E1M1', line: 3, doorDepth: 24, roomDepth: 96, doorTexture: 'STARTAN3' },
  { type: 'add_lift_room', map: 'E1M1', line: 0, rise: 64, liftDepth: 48, roomDepth: 96 },
  { type: 'split_sector', map: 'E1M1', sector: 0, vertexA: 0, vertexB: 2 }
]);
const stressValidation = stress.validate({ touchedOnly: true });
assert.equal(stressValidation.ok, true, JSON.stringify(stressValidation));
assert.equal(stress.commitTransaction().committed, true);
const stressCandidate = await stress.build({ filename: 'p1-semantic-stress.wad' });
assert.equal(stressCandidate.maps[0].inspected.ok, true, JSON.stringify(stressCandidate.maps[0].inspected));
const doc = parseWad(stressCandidate.bytes);
assert.equal(doc.lumps.length, 1 + MAP_LUMP_ORDER.length);
console.error('P1.2 combined semantic transaction + ZDBSP build passed:', stressCandidate.bytes.length, 'bytes');
