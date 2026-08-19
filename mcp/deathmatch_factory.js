import { Buffer } from 'node:buffer';

import { MAP_LUMP_ORDER, parseWad, writeWad } from './geometry.js';
import { createDeathmatchArenaPwad } from './deathmatch_design.js';

const THINGS_OFFSET = MAP_LUMP_ORDER.indexOf('THINGS');
const LINEDEFS_OFFSET = MAP_LUMP_ORDER.indexOf('LINEDEFS');
const SIDEDEFS_OFFSET = MAP_LUMP_ORDER.indexOf('SIDEDEFS');
const VERTEXES_OFFSET = MAP_LUMP_ORDER.indexOf('VERTEXES');
const BASIC_RING_WEAPONS = new Set([2001, 2002]); // shotgun / chaingun from the raw arena seed
const NO_SIDE = 0xffff;
const ML_BLOCKING = 0x0001;

function decodeThings(data) {
  if (data.length % 10) throw new Error('THINGS size must be divisible by 10');
  const things = [];
  for (let at = 0; at < data.length; at += 10) things.push({
    x: data.readInt16LE(at),
    y: data.readInt16LE(at + 2),
    angle: data.readInt16LE(at + 4),
    doomEdNum: data.readInt16LE(at + 6),
    flags: data.readInt16LE(at + 8)
  });
  return things;
}
function encodeThings(things) {
  const out = Buffer.alloc(things.length * 10);
  things.forEach((thing, index) => {
    const at = index * 10;
    out.writeInt16LE(Math.trunc(thing.x), at);
    out.writeInt16LE(Math.trunc(thing.y), at + 2);
    out.writeInt16LE(Math.trunc(thing.angle || 0), at + 4);
    out.writeInt16LE(Math.trunc(thing.doomEdNum), at + 6);
    out.writeInt16LE(Math.trunc(thing.flags ?? 7), at + 8);
  });
  return out;
}
function writeName8(buffer, offset, value) {
  const text = String(value || '-').trim().toUpperCase();
  if (!text || text.length > 8 || !/^[A-Z0-9_\-]+$/.test(text)) throw new Error(`Invalid Doom texture name ${value}`);
  buffer.fill(0, offset, offset + 8);
  buffer.write(text, offset, Math.min(text.length, 8), 'ascii');
}
function mapLump(doc, marker, offset, name) {
  const lump = doc.lumps[marker + 1 + offset];
  if (!lump || lump.name !== name) throw new Error(`Map lump ${name} is missing or non-canonical`);
  return lump;
}

export function addFairSpawnWeapons(bytes, mapName = 'E1M1', { inwardOffset = 96 } = {}) {
  const map = String(mapName || 'E1M1').toUpperCase();
  const doc = parseWad(bytes);
  const marker = doc.lumps.findIndex(lump => lump.name === map);
  if (marker < 0) throw new Error(`Map ${map} not found`);
  const lump = doc.lumps[marker + 1 + THINGS_OFFSET];
  if (!lump || lump.name !== 'THINGS') throw new Error(`Map ${map} has no canonical THINGS lump`);
  const decoded = decodeThings(lump.data);
  const starts = decoded.filter(thing => Number(thing.doomEdNum) === 11);
  if (starts.length < 4) throw new Error('Deathmatch seed needs at least four DoomEd 11 starts');

  // The raw arena deliberately demonstrates distributed weapon placement, but
  // those four shotgun/chaingun pickups make half of the eight spawns closer to
  // a weapon than the others. For the accepted P2.2 seed we first remove those
  // asymmetric nearest-weapon candidates, then give every spawn the same radial
  // shotgun/shell package. The central rocket remains the contested power item.
  const things = decoded.filter(thing => !BASIC_RING_WEAPONS.has(Number(thing.doomEdNum)));

  for (const start of starts) {
    const radius = Math.hypot(start.x, start.y) || 1;
    const x = Math.round(start.x - (start.x / radius) * inwardOffset);
    const y = Math.round(start.y - (start.y / radius) * inwardOffset);
    things.push({ x, y, angle: 0, doomEdNum: 2001, flags: 7 });

    const shellOffset = inwardOffset + 42;
    things.push({
      x: Math.round(start.x - (start.x / radius) * shellOffset),
      y: Math.round(start.y - (start.y / radius) * shellOffset),
      angle: 0,
      doomEdNum: 2008,
      flags: 7
    });
  }

  lump.data = encodeThings(things);
  return writeWad(doc, 'PWAD');
}

// Add real one-sided wall loops inside the center sector. These are not sprite
// decorations: LinuxDOOM collision, hitscan traces and P_CheckSight all see the
// columns as solid cover. The loops are counter-clockwise so the playable center
// sector remains on the right/front side of each one-sided linedef.
export function addCenterCoverPillars(bytes, mapName = 'E1M1', {
  centers = [
    { x: 96, y: 96 }, { x: -96, y: 96 },
    { x: -96, y: -96 }, { x: 96, y: -96 }
  ],
  halfSize = 28,
  centerSector = 8,
  wallTexture = 'STARTAN3'
} = {}) {
  const map = String(mapName || 'E1M1').toUpperCase();
  const doc = parseWad(bytes);
  const marker = doc.lumps.findIndex(lump => lump.name === map);
  if (marker < 0) throw new Error(`Map ${map} not found`);

  const verticesLump = mapLump(doc, marker, VERTEXES_OFFSET, 'VERTEXES');
  const sidedefsLump = mapLump(doc, marker, SIDEDEFS_OFFSET, 'SIDEDEFS');
  const linedefsLump = mapLump(doc, marker, LINEDEFS_OFFSET, 'LINEDEFS');
  if (verticesLump.data.length % 4) throw new Error('VERTEXES size must be divisible by 4');
  if (sidedefsLump.data.length % 30) throw new Error('SIDEDEFS size must be divisible by 30');
  if (linedefsLump.data.length % 14) throw new Error('LINEDEFS size must be divisible by 14');

  let vertexBase = verticesLump.data.length / 4;
  let sideBase = sidedefsLump.data.length / 30;
  const newVertices = [];
  const newSides = [];
  const newLines = [];
  const h = Math.max(16, Math.min(48, Math.trunc(Number(halfSize) || 28)));

  for (const center of centers) {
    const cx = Math.trunc(Number(center.x));
    const cy = Math.trunc(Number(center.y));
    const points = [
      { x: cx - h, y: cy - h },
      { x: cx + h, y: cy - h },
      { x: cx + h, y: cy + h },
      { x: cx - h, y: cy + h }
    ];
    const vertexStart = vertexBase;
    const sideStart = sideBase;

    for (const point of points) {
      const row = Buffer.alloc(4);
      row.writeInt16LE(point.x, 0);
      row.writeInt16LE(point.y, 2);
      newVertices.push(row);
      vertexBase++;
    }
    for (let i = 0; i < 4; i++) {
      const side = Buffer.alloc(30);
      writeName8(side, 4, '-');
      writeName8(side, 12, '-');
      writeName8(side, 20, wallTexture);
      side.writeUInt16LE(Math.trunc(centerSector), 28);
      newSides.push(side);
      sideBase++;

      const line = Buffer.alloc(14);
      line.writeUInt16LE(vertexStart + i, 0);
      line.writeUInt16LE(vertexStart + ((i + 1) % 4), 2);
      line.writeUInt16LE(ML_BLOCKING, 4);
      line.writeUInt16LE(0, 6);
      line.writeUInt16LE(0, 8);
      line.writeUInt16LE(sideStart + i, 10);
      line.writeUInt16LE(NO_SIDE, 12);
      newLines.push(line);
    }
  }

  verticesLump.data = Buffer.concat([verticesLump.data, ...newVertices]);
  sidedefsLump.data = Buffer.concat([sidedefsLump.data, ...newSides]);
  linedefsLump.data = Buffer.concat([linedefsLump.data, ...newLines]);
  return writeWad(doc, 'PWAD');
}

export function createBalancedDeathmatchArenaPwad(input = {}) {
  const generated = createDeathmatchArenaPwad(input);
  const armed = addFairSpawnWeapons(generated.bytes, generated.map, input);
  const bytes = addCenterCoverPillars(armed, generated.map, input);
  return {
    ...generated,
    bytes,
    arena: {
      ...generated.arena,
      spawnWeaponPolicy: 'equal radial shotgun + shells for every deathmatch spawn; central rocket remains contested',
      removedAsymmetricBasicWeapons: 4,
      addedSpawnWeapons: generated.arena.deathmatchStarts,
      addedSpawnAmmo: generated.arena.deathmatchStarts,
      solidCoverPillars: 4,
      pillarHalfSize: Math.max(16, Math.min(48, Math.trunc(Number(input.halfSize) || 28))),
      pillarPolicy: 'four solid STARTAN3 center columns break long sightlines while preserving multiple routes to the contested rocket'
    }
  };
}
