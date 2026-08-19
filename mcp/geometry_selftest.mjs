import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { GeometryWorkspace, inspectBuiltMap, writeWad } from './geometry.js';
import { rebuildVanillaNodes } from './nodebuilder.js';

function name8(value) {
  const out = Buffer.alloc(8); out.write(String(value), 0, 8, 'ascii'); return out;
}

function makeThings() {
  const out = Buffer.alloc(10);
  out.writeInt16LE(64, 0); out.writeInt16LE(64, 2); out.writeInt16LE(0, 4);
  out.writeInt16LE(1, 6); out.writeInt16LE(7, 8); // Player 1 start
  return out;
}

function makeVertices() {
  const points = [[0, 0], [0, 128], [128, 128], [128, 0]];
  const out = Buffer.alloc(points.length * 4);
  points.forEach(([x, y], i) => { out.writeInt16LE(x, i * 4); out.writeInt16LE(y, i * 4 + 2); });
  return out;
}

function makeSidedefs() {
  const out = Buffer.alloc(4 * 30);
  for (let i = 0; i < 4; i++) {
    const at = i * 30;
    name8('-').copy(out, at + 4); name8('-').copy(out, at + 12); name8('STARTAN3').copy(out, at + 20);
    out.writeUInt16LE(0, at + 28);
  }
  return out;
}

function makeLinedefs() {
  const edges = [[0, 1], [1, 2], [2, 3], [3, 0]];
  const out = Buffer.alloc(edges.length * 14);
  edges.forEach(([v1, v2], i) => {
    const at = i * 14; out.writeUInt16LE(v1, at); out.writeUInt16LE(v2, at + 2);
    out.writeUInt16LE(1, at + 4); out.writeUInt16LE(i, at + 10); out.writeUInt16LE(0xffff, at + 12);
  });
  return out;
}

function makeSectors() {
  const out = Buffer.alloc(26);
  out.writeInt16LE(0, 0); out.writeInt16LE(128, 2); name8('FLOOR0_1').copy(out, 4); name8('CEIL1_1').copy(out, 12);
  out.writeInt16LE(160, 20); return out;
}

const base = writeWad({ lumps: [
  { name: 'E1M1', data: Buffer.alloc(0) },
  { name: 'THINGS', data: makeThings() },
  { name: 'LINEDEFS', data: makeLinedefs() },
  { name: 'SIDEDEFS', data: makeSidedefs() },
  { name: 'VERTEXES', data: makeVertices() },
  { name: 'SEGS', data: Buffer.alloc(0) },
  { name: 'SSECTORS', data: Buffer.alloc(0) },
  { name: 'NODES', data: Buffer.alloc(0) },
  { name: 'SECTORS', data: makeSectors() },
  { name: 'REJECT', data: Buffer.alloc(0) },
  { name: 'BLOCKMAP', data: Buffer.alloc(0) }
] });

const workspace = new GeometryWorkspace(base, 'E1M1');
assert.equal(workspace.validate().ok, true);
const room = workspace.addRoomFromWall({ line: 2, depth: 128 });
assert.equal(room.sector, 1);
assert.equal(workspace.validate().ok, true, JSON.stringify(workspace.validate()));
workspace.resizeCreatedRoom({ roomId: room.roomId, depth: 192 });
assert.equal(workspace.validate().ok, true);
const preNode = workspace.preNodeWad();
const rebuilt = await rebuildVanillaNodes(preNode, 'E1M1');
const built = inspectBuiltMap(rebuilt.bytes, 'E1M1');
assert.equal(built.ok, true, JSON.stringify(built));
assert.equal(built.counts.sectors, 2);
assert.ok(built.counts.nodeBytes > 0);
assert.ok(built.counts.blockmapBytes > 0);
console.error('DOOM MCP v2 geometry self-test passed:', JSON.stringify(built));
