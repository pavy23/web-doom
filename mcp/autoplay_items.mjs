// Static pickups of a map from its THINGS lump, for the policy's item loot.
//
// The engine state has no item positions, so the policy learns them from the
// WAD once and tracks pickups through player.items / health / ammo changes.

import { readFile } from 'node:fs/promises';

// doomednum -> what the policy cares about
export const ITEM_TYPES = {
  2011: { name: 'stimpack', kind: 'health', amount: 10 },
  2012: { name: 'medikit', kind: 'health', amount: 25 },
  2008: { name: 'shells', kind: 'shells', amount: 4 },
  2049: { name: 'shellbox', kind: 'shells', amount: 20 },
  2001: { name: 'shotgun', kind: 'weapon', amount: 8 },
  2018: { name: 'green armor', kind: 'armor', amount: 100 },
  2019: { name: 'blue armor', kind: 'armor', amount: 200 }
};

// THINGS option bits: 1 easy (skill 0-1), 2 medium (2), 4 hard (3-4).
export function skillBit(skill) {
  const s = Number(skill ?? 0);
  return s <= 1 ? 1 : s === 2 ? 2 : 4;
}

function readDirectory(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const count = view.getInt32(4, true);
  const offset = view.getInt32(8, true);
  const lumps = [];
  for (let i = 0; i < count; i++) {
    const entry = offset + i * 16;
    lumps.push({
      pos: view.getInt32(entry, true),
      size: view.getInt32(entry + 4, true),
      name: buffer.toString('ascii', entry + 8, entry + 16).replace(/\0.*$/, '')
    });
  }
  return { view, lumps };
}

export async function loadMapItems(wadPath, mapName, { skill = 0 } = {}) {
  const buffer = await readFile(wadPath);
  const { view, lumps } = readDirectory(buffer);
  const marker = lumps.findIndex(lump => lump.name === String(mapName).toUpperCase());
  if (marker < 0) throw new Error(`${wadPath} has no map ${mapName}`);
  const things = lumps[marker + 1];
  if (!things || things.name !== 'THINGS') throw new Error(`${mapName} has no THINGS lump after its marker`);
  const bit = skillBit(skill);
  const items = [];
  for (let i = 0; i < Math.floor(things.size / 10); i++) {
    const o = things.pos + i * 10;
    const type = view.getInt16(o + 6, true);
    const flags = view.getInt16(o + 8, true);
    const spec = ITEM_TYPES[type];
    if (!spec || !(flags & bit)) continue;
    items.push({ id: `item_${i}`, x: view.getInt16(o, true), y: view.getInt16(o + 2, true), type, ...spec });
  }
  return items;
}
