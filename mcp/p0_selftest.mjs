import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';

import { GeometryWorkspace, MAP_LUMP_ORDER, parseWad, writeWad } from './geometry.js';
import { DEFAULT_EPISODE_MAPS, EpisodeWorkspace } from './episode_workspace.js';
import { installFullTopologyValidator } from './topology_validator.js';

installFullTopologyValidator(GeometryWorkspace);

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, '..', 'doom1.wad');
const source = await readFile(sourcePath);

function name8(value) {
  const out = Buffer.alloc(8); out.write(String(value), 0, 8, 'ascii'); return out;
}

function makeSyntheticCrossingWad() {
  const vertices = Buffer.alloc(4 * 4);
  [[0, 0], [100, 0], [50, -50], [50, -10]].forEach(([x, y], i) => {
    vertices.writeInt16LE(x, i * 4); vertices.writeInt16LE(y, i * 4 + 2);
  });

  const sidedefs = Buffer.alloc(2 * 30);
  for (let i = 0; i < 2; i++) {
    const at = i * 30;
    name8('-').copy(sidedefs, at + 4);
    name8('-').copy(sidedefs, at + 12);
    name8('STARTAN3').copy(sidedefs, at + 20);
    sidedefs.writeUInt16LE(0, at + 28);
  }

  const linedefs = Buffer.alloc(2 * 14);
  [[0, 1], [2, 3]].forEach(([v1, v2], i) => {
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

  return writeWad({ lumps: [
    { name: 'E1M1', data: Buffer.alloc(0) },
    { name: 'THINGS', data: Buffer.alloc(0) },
    { name: 'LINEDEFS', data: linedefs },
    { name: 'SIDEDEFS', data: sidedefs },
    { name: 'VERTEXES', data: vertices },
    { name: 'SEGS', data: Buffer.alloc(0) },
    { name: 'SSECTORS', data: Buffer.alloc(0) },
    { name: 'NODES', data: Buffer.alloc(0) },
    { name: 'SECTORS', data: sectors },
    { name: 'REJECT', data: Buffer.alloc(0) },
    { name: 'BLOCKMAP', data: Buffer.alloc(0) }
  ] });
}

// 1) Regression: moving an original vertex must trigger full crossing detection.
const synthetic = new GeometryWorkspace(makeSyntheticCrossingWad(), 'E1M1');
assert.equal(synthetic.validate().ok, true);
synthetic.moveVertex({ vertex: 3, x: 50, y: 50 });
const crossingValidation = synthetic.validate();
assert.equal(crossingValidation.ok, false);
assert.ok(crossingValidation.issues.errors.some(issue => issue.code === 'LINEDEF_CROSSING'), JSON.stringify(crossingValidation));
console.error('P0 validator regression passed: moved legacy linedef crossing detected');

// 2) Load all E1M1..E1M8 into one map-set workspace.
const episode = new EpisodeWorkspace(source, DEFAULT_EPISODE_MAPS, 'doom1.wad');
assert.deepEqual(episode.mapNames, DEFAULT_EPISODE_MAPS);
const baselineValidation = episode.validate();
assert.equal(baselineValidation.ok, true, JSON.stringify(baselineValidation));
console.error('P0 episode baseline validation passed for:', episode.mapNames.join(', '));

// 3) Atomicity: a late edit failure must roll back earlier edits on another map.
const beforeE1M1 = episode.inspectMap('E1M1', { sectorLimit: 1 }).sectors[0];
episode.beginTransaction('atomic rollback regression');
let rolledBack = false;
try {
  episode.applyEdits([
    { type: 'set_sector_heights', map: 'E1M1', sector: 0, ceiling: beforeE1M1.ceiling + 8 },
    { type: 'move_vertex', map: 'E1M2', vertex: 0, x: 50000, y: 0 }
  ]);
} catch (error) {
  rolledBack = /rolled back/i.test(String(error?.message || error));
}
assert.equal(rolledBack, true);
assert.equal(episode.transaction, null);
const restoredE1M1 = episode.inspectMap('E1M1', { sectorLimit: 1 }).sectors[0];
assert.equal(restoredE1M1.ceiling, beforeE1M1.ceiling);
console.error('P0 atomic map-set rollback passed');

// 4) A valid transaction may touch distant maps in the same episode and commit once.
const e1m1Sector = episode.inspectMap('E1M1', { sectorLimit: 1 }).sectors[0];
const e1m8Sector = episode.inspectMap('E1M8', { sectorLimit: 1 }).sectors[0];
episode.beginTransaction('cross-episode structural transaction');
episode.applyEdits([
  { type: 'set_sector_heights', map: 'E1M1', sector: 0, ceiling: e1m1Sector.ceiling + 8 },
  { type: 'set_sector_heights', map: 'E1M8', sector: 0, ceiling: e1m8Sector.ceiling + 8 }
]);
const txValidation = episode.validate({ touchedOnly: true });
assert.equal(txValidation.ok, true, JSON.stringify(txValidation));
const commit = episode.commitTransaction();
assert.equal(commit.committed, true, JSON.stringify(commit));
assert.deepEqual(new Set(commit.transaction.touchedMaps), new Set(['E1M1', 'E1M8']));
console.error('P0 cross-map transaction commit passed');

// 5) Rebuild every map, verify derived lumps, then combine into one episode PWAD.
const candidate = await episode.build({ filename: 'p0-e1m1-e1m8-selftest.wad' });
assert.equal(candidate.maps.length, 8);
for (const entry of candidate.maps) {
  assert.equal(entry.inspected.ok, true, JSON.stringify(entry.inspected));
  assert.ok(entry.inspected.counts.nodeBytes > 0, `${entry.map} has no NODES`);
  assert.ok(entry.inspected.counts.blockmapBytes > 0, `${entry.map} has no BLOCKMAP`);
}

const combined = parseWad(candidate.bytes);
const markers = combined.lumps.map(lump => lump.name).filter(name => DEFAULT_EPISODE_MAPS.includes(name));
assert.deepEqual(markers, DEFAULT_EPISODE_MAPS);
assert.equal(combined.lumps.length, DEFAULT_EPISODE_MAPS.length * (1 + MAP_LUMP_ORDER.length));
console.error('P0 E1M1-E1M8 ZDBSP build/combine passed:', candidate.bytes.length, 'bytes');
