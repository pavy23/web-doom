import { Buffer } from 'node:buffer';

import { MAP_LUMP_ORDER, parseWad, writeWad } from './geometry.js';
import { createDeathmatchArenaPwad } from './deathmatch_design.js';

const THINGS_OFFSET = MAP_LUMP_ORDER.indexOf('THINGS');

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

export function addFairSpawnWeapons(bytes, mapName = 'E1M1', { inwardOffset = 96 } = {}) {
  const map = String(mapName || 'E1M1').toUpperCase();
  const doc = parseWad(bytes);
  const marker = doc.lumps.findIndex(lump => lump.name === map);
  if (marker < 0) throw new Error(`Map ${map} not found`);
  const lump = doc.lumps[marker + 1 + THINGS_OFFSET];
  if (!lump || lump.name !== 'THINGS') throw new Error(`Map ${map} has no canonical THINGS lump`);
  const things = decodeThings(lump.data);
  const starts = things.filter(thing => Number(thing.doomEdNum) === 11);
  if (starts.length < 4) throw new Error('Deathmatch seed needs at least four DoomEd 11 starts');

  for (const start of starts) {
    const radius = Math.hypot(start.x, start.y) || 1;
    const x = Math.round(start.x - (start.x / radius) * inwardOffset);
    const y = Math.round(start.y - (start.y / radius) * inwardOffset);
    things.push({ x, y, angle: 0, doomEdNum: 2001, flags: 7 });
    // A small shell pickup follows the same radial lane, slightly closer to center.
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

export function createBalancedDeathmatchArenaPwad(input = {}) {
  const generated = createDeathmatchArenaPwad(input);
  const bytes = addFairSpawnWeapons(generated.bytes, generated.map, input);
  return {
    ...generated,
    bytes,
    arena: {
      ...generated.arena,
      spawnWeaponPolicy: 'one shotgun + shells on each deathmatch spawn radial lane',
      addedSpawnWeapons: generated.arena.deathmatchStarts,
      addedSpawnAmmo: generated.arena.deathmatchStarts
    }
  };
}
