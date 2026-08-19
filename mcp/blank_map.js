import { Buffer } from 'node:buffer';

import { GeometryWorkspace, MAP_LUMP_ORDER, parseWad, writeWad } from './geometry.js';

export const BLANK_MAP_VERSION = '2.6.0-p2.0';

const MAP_NAME = /^(?:E[1-9]M[1-9]|MAP\d\d)$/;
const NO_SIDE = 0xffff;
const ML_BLOCKING = 0x0001;
const ML_TWOSIDED = 0x0004;

function normalizeMapName(value = 'E1M1') {
  const name = String(value || 'E1M1').trim().toUpperCase();
  if (!MAP_NAME.test(name)) throw new Error(`Unsupported Doom map name: ${value}`);
  return name;
}

function boundedInt(value, label, min, max) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${label} must be ${min}..${max}`);
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
  items.forEach((thing, index) => {
    const at = index * 10;
    out.writeInt16LE(boundedInt(thing.x, `thing ${index}.x`, -32768, 32767), at);
    out.writeInt16LE(boundedInt(thing.y, `thing ${index}.y`, -32768, 32767), at + 2);
    out.writeInt16LE(boundedInt(thing.angle, `thing ${index}.angle`, 0, 359), at + 4);
    out.writeInt16LE(boundedInt(thing.doomEdNum, `thing ${index}.doomEdNum`, 1, 32767), at + 6);
    out.writeInt16LE(boundedInt(thing.flags, `thing ${index}.flags`, 0, 32767), at + 8);
  });
  return out;
}

function encodeVertices(items) {
  const out = Buffer.alloc(items.length * 4);
  items.forEach((vertex, index) => {
    const at = index * 4;
    out.writeInt16LE(boundedInt(vertex.x, `vertex ${index}.x`, -32768, 32767), at);
    out.writeInt16LE(boundedInt(vertex.y, `vertex ${index}.y`, -32768, 32767), at + 2);
  });
  return out;
}

function encodeLinedefs(items) {
  const out = Buffer.alloc(items.length * 14);
  items.forEach((line, index) => {
    const at = index * 14;
    out.writeUInt16LE(boundedInt(line.v1, `linedef ${index}.v1`, 0, 65534), at);
    out.writeUInt16LE(boundedInt(line.v2, `linedef ${index}.v2`, 0, 65534), at + 2);
    out.writeUInt16LE(boundedInt(line.flags, `linedef ${index}.flags`, 0, 65535), at + 4);
    out.writeUInt16LE(boundedInt(line.special, `linedef ${index}.special`, 0, 65535), at + 6);
    out.writeUInt16LE(boundedInt(line.tag, `linedef ${index}.tag`, 0, 65535), at + 8);
    out.writeUInt16LE(boundedInt(line.right, `linedef ${index}.right`, 0, 65535), at + 10);
    out.writeUInt16LE(line.left === NO_SIDE ? NO_SIDE : boundedInt(line.left, `linedef ${index}.left`, 0, 65534), at + 12);
  });
  return out;
}

function encodeSidedefs(items) {
  const out = Buffer.alloc(items.length * 30);
  items.forEach((side, index) => {
    const at = index * 30;
    out.writeInt16LE(boundedInt(side.xOffset || 0, `sidedef ${index}.xOffset`, -32768, 32767), at);
    out.writeInt16LE(boundedInt(side.yOffset || 0, `sidedef ${index}.yOffset`, -32768, 32767), at + 2);
    writeName8(out, at + 4, side.upper || '-');
    writeName8(out, at + 12, side.lower || '-');
    writeName8(out, at + 20, side.middle || 'STARTAN3');
    out.writeUInt16LE(boundedInt(side.sector, `sidedef ${index}.sector`, 0, 65534), at + 28);
  });
  return out;
}

function encodeSectors(items) {
  const out = Buffer.alloc(items.length * 26);
  items.forEach((sector, index) => {
    const at = index * 26;
    out.writeInt16LE(boundedInt(sector.floor, `sector ${index}.floor`, -32768, 32767), at);
    out.writeInt16LE(boundedInt(sector.ceiling, `sector ${index}.ceiling`, -32768, 32767), at + 2);
    writeName8(out, at + 4, sector.floorFlat || 'FLOOR4_8');
    writeName8(out, at + 12, sector.ceilingFlat || 'CEIL3_5');
    out.writeInt16LE(boundedInt(sector.light, `sector ${index}.light`, -32768, 32767), at + 20);
    out.writeUInt16LE(boundedInt(sector.special || 0, `sector ${index}.special`, 0, 65535), at + 22);
    out.writeUInt16LE(boundedInt(sector.tag || 0, `sector ${index}.tag`, 0, 65535), at + 24);
  });
  return out;
}

function canonicalLumps(map, replacements = {}) {
  return [
    { name: map, data: Buffer.alloc(0) },
    ...MAP_LUMP_ORDER.map(name => ({ name, data: Buffer.from(replacements[name] || Buffer.alloc(0)) }))
  ];
}

export function createEmptyMapPwad(mapName = 'E1M1') {
  const map = normalizeMapName(mapName);
  return writeWad({ lumps: canonicalLumps(map) }, 'PWAD');
}

export function createSeededBlankMapPwad(input = {}) {
  const map = normalizeMapName(input.map || 'E1M1');
  const width = boundedInt(input.width ?? 512, 'width', 128, 4096);
  const height = boundedInt(input.height ?? 384, 'height', 128, 4096);
  const floor = boundedInt(input.floor ?? 0, 'floor', -4096, 4096);
  const ceiling = boundedInt(input.ceiling ?? 128, 'ceiling', -4096, 8192);
  if (ceiling - floor < 64) throw new Error('Blank start room needs at least 64 map units of vertical clearance');
  const light = boundedInt(input.light ?? 176, 'light', 0, 255);
  const wallTexture = String(input.wallTexture || 'STARTAN3').trim().toUpperCase();
  // These defaults are present in shareware E1M1 and therefore guaranteed by
  // the repository's supported doom1.wad runtime baseline.
  const floorFlat = String(input.floorFlat || 'FLOOR4_8').trim().toUpperCase();
  const ceilingFlat = String(input.ceilingFlat || 'CEIL3_5').trim().toUpperCase();
  const includeExit = input.includeExit !== false;
  const exitWall = String(input.exitWall || 'east').trim().toLowerCase();
  const exitLine = { west: 0, north: 2, east: 3, south: 4 }[exitWall];
  if (exitLine == null) throw new Error('exitWall must be west, north, east or south');

  const halfW = Math.floor(width / 2);
  const halfH = Math.floor(height / 2);
  const playerX = -Math.max(24, Math.floor(width / 4));

  // Two connected sectors are deliberate. Vanilla LinuxDOOM's BSP point lookup
  // expects at least one NODES entry; a single convex sector lets ZDBSP emit a
  // zero-node tree, which is not a safe Vanilla runtime baseline.
  // Outer boundary lines are clockwise so the interior stays on the right/front.
  const vertices = [
    { x: -halfW, y: -halfH }, // 0 left-bottom
    { x: -halfW, y: halfH },  // 1 left-top
    { x: 0, y: halfH },       // 2 mid-top
    { x: halfW, y: halfH },   // 3 right-top
    { x: halfW, y: -halfH },  // 4 right-bottom
    { x: 0, y: -halfH }       // 5 mid-bottom
  ];
  const sectors = [0, 1].map(() => ({
    floor, ceiling, floorFlat, ceilingFlat, light, special: 0, tag: 0
  }));
  const sidedefs = [
    { middle: wallTexture, sector: 0 }, // 0 west
    { middle: wallTexture, sector: 0 }, // 1 north-left
    { middle: wallTexture, sector: 1 }, // 2 north-right
    { middle: wallTexture, sector: 1 }, // 3 east
    { middle: wallTexture, sector: 1 }, // 4 south-right
    { middle: wallTexture, sector: 0 }, // 5 south-left
    { middle: '-', sector: 0 },         // 6 portal front/right
    { middle: '-', sector: 1 }          // 7 portal back/left
  ].map(side => ({ xOffset: 0, yOffset: 0, upper: '-', lower: '-', ...side }));

  const outerPairs = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0]];
  const linedefs = outerPairs.map(([v1, v2], index) => ({
    v1,
    v2,
    flags: ML_BLOCKING,
    special: includeExit && index === exitLine ? 11 : 0,
    tag: 0,
    right: index,
    left: NO_SIDE
  }));
  // Downward center divider: west/left room is right/front sector 0, east/right
  // room is left/back sector 1.
  linedefs.push({ v1: 2, v2: 5, flags: ML_TWOSIDED, special: 0, tag: 0, right: 6, left: 7 });

  const things = [{ x: playerX, y: 0, angle: 0, doomEdNum: 1, flags: 7 }];

  const bytes = writeWad({
    lumps: canonicalLumps(map, {
      THINGS: encodeThings(things),
      LINEDEFS: encodeLinedefs(linedefs),
      SIDEDEFS: encodeSidedefs(sidedefs),
      VERTEXES: encodeVertices(vertices),
      SECTORS: encodeSectors(sectors)
    })
  }, 'PWAD');

  return {
    version: BLANK_MAP_VERSION,
    map,
    bytes,
    seed: {
      width,
      height,
      floor,
      ceiling,
      light,
      wallTexture,
      floorFlat,
      ceilingFlat,
      includeExit,
      exitWall,
      exitLine: includeExit ? exitLine : null,
      portalLine: 6,
      player1Start: { x: playerX, y: 0, angle: 0, sector: 0 },
      counts: { things: 1, vertices: 6, linedefs: 7, sidedefs: 8, sectors: 2 }
    }
  };
}

export function markWorkspaceAsGenerated(workspace) {
  if (!(workspace instanceof GeometryWorkspace)) throw new Error('Expected GeometryWorkspace');
  // Force lazy THINGS parsing before zeroing the legacy boundary. In a generated
  // map every seed primitive is AI-authored and therefore repairable by P1.4.
  if (typeof workspace.listThings === 'function') workspace.listThings({ limit: 1 });
  workspace.originalCounts = {
    ...workspace.originalCounts,
    vertices: 0,
    linedefs: 0,
    sidedefs: 0,
    sectors: 0,
    things: 0
  };
  return workspace;
}

export function inspectCanonicalBlankMap(input, mapName) {
  const map = normalizeMapName(mapName);
  const doc = parseWad(input);
  const marker = doc.lumps.findIndex(lump => lump.name === map);
  if (marker < 0) throw new Error(`Map marker ${map} missing`);
  const actualOrder = doc.lumps.slice(marker + 1, marker + 1 + MAP_LUMP_ORDER.length).map(lump => lump.name);
  return {
    map,
    canonical: actualOrder.length === MAP_LUMP_ORDER.length && actualOrder.every((name, index) => name === MAP_LUMP_ORDER[index]),
    lumpOrder: actualOrder,
    bytes: Buffer.byteLength(input),
    lumpBytes: Object.fromEntries(actualOrder.map((name, index) => [name, doc.lumps[marker + 1 + index].data.length]))
  };
}
