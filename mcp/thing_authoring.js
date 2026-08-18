import { Buffer } from 'node:buffer';
import { MAP_LUMP_ORDER, parseWad, writeWad } from './geometry.js';

export const THING_AUTHORING_VERSION = '2.2.0-p1.1';
const PATCH_MARK = Symbol.for('web-doom.p1.general-things');
const THINGS_LUMP_INDEX = MAP_LUMP_ORDER.indexOf('THINGS');

// DoomEd numbers are intentionally a practical Vanilla Doom catalog, not a
// closed whitelist. Callers may use any valid numeric DoomEd number through
// doomEdNum so custom/less-common vanilla things are still authorable.
export const DOOM_THING_CATALOG = Object.freeze([
  { key: 'player1_start', doomEdNum: 1, category: 'start', label: 'Player 1 Start' },
  { key: 'player2_start', doomEdNum: 2, category: 'start', label: 'Player 2 Start' },
  { key: 'player3_start', doomEdNum: 3, category: 'start', label: 'Player 3 Start' },
  { key: 'player4_start', doomEdNum: 4, category: 'start', label: 'Player 4 Start' },
  { key: 'deathmatch_start', doomEdNum: 11, category: 'start', label: 'Deathmatch Start' },

  { key: 'zombieman', doomEdNum: 3004, category: 'monster', label: 'Zombieman' },
  { key: 'shotgun_guy', doomEdNum: 9, category: 'monster', label: 'Shotgun Guy' },
  { key: 'imp', doomEdNum: 3001, category: 'monster', label: 'Imp' },
  { key: 'demon', doomEdNum: 3002, category: 'monster', label: 'Demon' },
  { key: 'spectre', doomEdNum: 58, category: 'monster', label: 'Spectre' },
  { key: 'cacodemon', doomEdNum: 3005, category: 'monster', label: 'Cacodemon' },
  { key: 'lost_soul', doomEdNum: 3006, category: 'monster', label: 'Lost Soul' },
  { key: 'baron_of_hell', doomEdNum: 3003, category: 'monster', label: 'Baron of Hell' },
  { key: 'cyberdemon', doomEdNum: 16, category: 'monster', label: 'Cyberdemon' },
  { key: 'spider_mastermind', doomEdNum: 7, category: 'monster', label: 'Spider Mastermind' },

  { key: 'shotgun', doomEdNum: 2001, category: 'weapon', label: 'Shotgun' },
  { key: 'chaingun', doomEdNum: 2002, category: 'weapon', label: 'Chaingun' },
  { key: 'rocket_launcher', doomEdNum: 2003, category: 'weapon', label: 'Rocket Launcher' },
  { key: 'plasma_rifle', doomEdNum: 2004, category: 'weapon', label: 'Plasma Rifle' },
  { key: 'chainsaw', doomEdNum: 2005, category: 'weapon', label: 'Chainsaw' },
  { key: 'bfg9000', doomEdNum: 2006, category: 'weapon', label: 'BFG9000' },

  { key: 'ammo_clip', doomEdNum: 2007, category: 'ammo', label: 'Ammo Clip' },
  { key: 'shotgun_shells', doomEdNum: 2008, category: 'ammo', label: 'Shotgun Shells' },
  { key: 'rocket', doomEdNum: 2010, category: 'ammo', label: 'Rocket' },
  { key: 'box_of_rockets', doomEdNum: 2046, category: 'ammo', label: 'Box of Rockets' },
  { key: 'energy_cell', doomEdNum: 2047, category: 'ammo', label: 'Energy Cell' },
  { key: 'ammo_box', doomEdNum: 2048, category: 'ammo', label: 'Ammo Box' },
  { key: 'box_of_shells', doomEdNum: 2049, category: 'ammo', label: 'Box of Shells' },
  { key: 'cell_pack', doomEdNum: 17, category: 'ammo', label: 'Energy Cell Pack' },

  { key: 'stimpack', doomEdNum: 2011, category: 'health', label: 'Stimpack' },
  { key: 'medikit', doomEdNum: 2012, category: 'health', label: 'Medikit' },
  { key: 'soulsphere', doomEdNum: 2013, category: 'health', label: 'Soul Sphere' },
  { key: 'health_bonus', doomEdNum: 2014, category: 'health', label: 'Health Bonus' },
  { key: 'armor_bonus', doomEdNum: 2015, category: 'armor', label: 'Armor Bonus' },
  { key: 'green_armor', doomEdNum: 2018, category: 'armor', label: 'Green Armor' },
  { key: 'blue_armor', doomEdNum: 2019, category: 'armor', label: 'Blue Armor' },

  { key: 'blue_keycard', doomEdNum: 5, category: 'key', label: 'Blue Keycard' },
  { key: 'yellow_keycard', doomEdNum: 6, category: 'key', label: 'Yellow Keycard' },
  { key: 'red_keycard', doomEdNum: 13, category: 'key', label: 'Red Keycard' },

  { key: 'invulnerability', doomEdNum: 2022, category: 'powerup', label: 'Invulnerability' },
  { key: 'berserk', doomEdNum: 2023, category: 'powerup', label: 'Berserk' },
  { key: 'partial_invisibility', doomEdNum: 2024, category: 'powerup', label: 'Partial Invisibility' },
  { key: 'radiation_suit', doomEdNum: 2025, category: 'powerup', label: 'Radiation Suit' },
  { key: 'computer_map', doomEdNum: 2026, category: 'powerup', label: 'Computer Area Map' },
  { key: 'light_amplification', doomEdNum: 2045, category: 'powerup', label: 'Light Amplification Visor' },
  { key: 'barrel', doomEdNum: 2035, category: 'prop', label: 'Explosive Barrel' }
]);

const BY_KEY = new Map(DOOM_THING_CATALOG.map(item => [item.key, item]));
const BY_NUM = new Map(DOOM_THING_CATALOG.map(item => [item.doomEdNum, item]));

export const THING_FLAGS = Object.freeze({
  skillEasy: 0x0001,
  skillMedium: 0x0002,
  skillHard: 0x0004,
  ambush: 0x0008,
  multiplayerOnly: 0x0010
});

function int16(value, label) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < -32768 || n > 32767) throw new Error(`${label} must fit signed 16-bit`);
  return n;
}

function thingType(input = {}) {
  if (input.key != null) {
    const entry = BY_KEY.get(String(input.key).trim().toLowerCase());
    if (!entry) throw new Error(`Unknown catalog thing key: ${input.key}`);
    return entry.doomEdNum;
  }
  const n = Math.trunc(Number(input.doomEdNum ?? input.type));
  if (!Number.isFinite(n) || n < 1 || n > 32767) throw new Error('doomEdNum must be 1..32767');
  return n;
}

function normalizeAngle(value = 0) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) throw new Error('angle must be numeric');
  return ((n % 360) + 360) % 360;
}

export function encodeThingFlags(input = {}) {
  if (input.flags != null) {
    const flags = Math.trunc(Number(input.flags));
    if (!Number.isFinite(flags) || flags < 0 || flags > 32767) throw new Error('thing flags must be 0..32767');
    return flags;
  }
  const options = input.options || input;
  let flags = 0;
  if (options.skillEasy !== false) flags |= THING_FLAGS.skillEasy;
  if (options.skillMedium !== false) flags |= THING_FLAGS.skillMedium;
  if (options.skillHard !== false) flags |= THING_FLAGS.skillHard;
  if (options.ambush) flags |= THING_FLAGS.ambush;
  if (options.multiplayerOnly) flags |= THING_FLAGS.multiplayerOnly;
  return flags;
}

export function decodeThingFlags(flags) {
  const value = Math.trunc(Number(flags || 0));
  return {
    skillEasy: Boolean(value & THING_FLAGS.skillEasy),
    skillMedium: Boolean(value & THING_FLAGS.skillMedium),
    skillHard: Boolean(value & THING_FLAGS.skillHard),
    ambush: Boolean(value & THING_FLAGS.ambush),
    multiplayerOnly: Boolean(value & THING_FLAGS.multiplayerOnly)
  };
}

function parseThings(data) {
  if (data.length % 10) throw new Error('THINGS size is not divisible by 10');
  const out = [];
  for (let at = 0; at < data.length; at += 10) {
    out.push({
      x: data.readInt16LE(at),
      y: data.readInt16LE(at + 2),
      angle: data.readInt16LE(at + 4),
      doomEdNum: data.readInt16LE(at + 6),
      flags: data.readInt16LE(at + 8)
    });
  }
  return out;
}

function encodeThings(items) {
  const out = Buffer.alloc(items.length * 10);
  items.forEach((thing, index) => {
    const at = index * 10;
    out.writeInt16LE(int16(thing.x, `thing ${index}.x`), at);
    out.writeInt16LE(int16(thing.y, `thing ${index}.y`), at + 2);
    out.writeInt16LE(int16(normalizeAngle(thing.angle), `thing ${index}.angle`), at + 4);
    out.writeInt16LE(int16(thing.doomEdNum, `thing ${index}.doomEdNum`), at + 6);
    out.writeInt16LE(int16(thing.flags, `thing ${index}.flags`), at + 8);
  });
  return out;
}

function ensureThings(workspace) {
  if (Array.isArray(workspace.geometry.things)) return workspace.geometry.things;
  const lump = workspace.doc.lumps[workspace.marker + 1 + THINGS_LUMP_INDEX];
  if (!lump || lump.name !== 'THINGS') throw new Error(`${workspace.mapName} has no canonical THINGS lump`);
  workspace.geometry.things = parseThings(lump.data);
  workspace.originalCounts.things = workspace.geometry.things.length;
  return workspace.geometry.things;
}

function viewThing(thing, index) {
  const catalog = BY_NUM.get(thing.doomEdNum) || null;
  return {
    index,
    ...thing,
    key: catalog?.key || null,
    category: catalog?.category || 'unknown',
    label: catalog?.label || `DoomEd ${thing.doomEdNum}`,
    options: decodeThingFlags(thing.flags)
  };
}

function normalizedThing(input = {}, existing = null) {
  const doomEdNum = input.key != null || input.doomEdNum != null || input.type != null
    ? thingType(input)
    : existing?.doomEdNum;
  if (!doomEdNum) throw new Error('Thing type is required');
  return {
    x: int16(input.x ?? existing?.x ?? 0, 'thing.x'),
    y: int16(input.y ?? existing?.y ?? 0, 'thing.y'),
    angle: normalizeAngle(input.angle ?? existing?.angle ?? 0),
    doomEdNum,
    flags: input.flags != null || input.options != null || input.skillEasy != null || input.skillMedium != null || input.skillHard != null || input.ambush != null || input.multiplayerOnly != null
      ? encodeThingFlags(input)
      : (existing?.flags ?? 7)
  };
}

function validateThings(workspace, base) {
  const things = ensureThings(workspace);
  const errors = [...(base.errors || [])];
  const warnings = [...(base.warnings || [])];
  const errorIssues = [...(base.issues?.errors || [])];
  const warningIssues = [...(base.issues?.warnings || [])];
  const addError = (code, message, details = {}) => { errors.push(message); errorIssues.push({ code, message, ...details }); };
  const addWarning = (code, message, details = {}) => { warnings.push(message); warningIssues.push({ code, message, ...details }); };

  const startCounts = new Map();
  things.forEach((thing, index) => {
    try { int16(thing.x, `thing ${index}.x`); int16(thing.y, `thing ${index}.y`); } catch (error) { addError('THING_COORDINATE', error.message, { thing: index }); }
    if (!Number.isInteger(thing.doomEdNum) || thing.doomEdNum < 1 || thing.doomEdNum > 32767) addError('THING_TYPE', `Thing ${index} has invalid DoomEd number ${thing.doomEdNum}`, { thing: index });
    if (!Number.isInteger(thing.flags) || thing.flags < 0 || thing.flags > 32767) addError('THING_FLAGS', `Thing ${index} has invalid flags ${thing.flags}`, { thing: index });
    if ((thing.flags & 7) === 0 && ![1, 2, 3, 4, 11].includes(thing.doomEdNum)) addWarning('THING_NO_SKILL', `Thing ${index} is disabled on every single-player skill`, { thing: index });
    if (!BY_NUM.has(thing.doomEdNum)) addWarning('THING_UNKNOWN_TYPE', `Thing ${index} uses uncatalogued DoomEd number ${thing.doomEdNum}`, { thing: index, doomEdNum: thing.doomEdNum });
    if ([1, 2, 3, 4, 11].includes(thing.doomEdNum)) startCounts.set(thing.doomEdNum, (startCounts.get(thing.doomEdNum) || 0) + 1);
  });

  for (const type of [1, 2, 3, 4]) {
    const count = startCounts.get(type) || 0;
    if (count > 1) addWarning('DUPLICATE_PLAYER_START', `Map has ${count} Player ${type} starts`, { doomEdNum: type, count });
  }
  if (!(startCounts.get(1) || 0)) addWarning('PLAYER1_START_MISSING', 'Map has no Player 1 start; single-player launch may be unusable');

  return { ...base, ok: errors.length === 0, errors, warnings, issues: { errors: errorIssues, warnings: warningIssues } };
}

export function listThingCatalog({ category = null, query = '' } = {}) {
  const q = String(query || '').trim().toLowerCase();
  return DOOM_THING_CATALOG.filter(item => (!category || item.category === category)
    && (!q || item.key.includes(q) || item.label.toLowerCase().includes(q) || String(item.doomEdNum) === q));
}

export function installThingAuthoring(GeometryWorkspace) {
  if (GeometryWorkspace.prototype[PATCH_MARK]) return;
  Object.defineProperty(GeometryWorkspace.prototype, PATCH_MARK, { value: true });

  const originalSummary = GeometryWorkspace.prototype.summary;
  GeometryWorkspace.prototype.summary = function thingSummary() {
    const things = ensureThings(this);
    return { ...originalSummary.call(this), thingCount: things.length };
  };

  const originalInspect = GeometryWorkspace.prototype.inspect;
  GeometryWorkspace.prototype.inspect = function thingInspect(options = {}) {
    const base = originalInspect.call(this, options);
    const limit = Math.max(1, Math.min(4096, Number(options.thingLimit ?? 128)));
    return { ...base, things: ensureThings(this).slice(0, limit).map(viewThing) };
  };

  const originalValidate = GeometryWorkspace.prototype.validate;
  GeometryWorkspace.prototype.validate = function thingValidate() {
    return validateThings(this, originalValidate.call(this));
  };

  const originalPreNodeWad = GeometryWorkspace.prototype.preNodeWad;
  GeometryWorkspace.prototype.preNodeWad = function thingPreNodeWad() {
    const bytes = originalPreNodeWad.call(this);
    const doc = parseWad(bytes);
    const marker = doc.lumps.findIndex(lump => lump.name === this.mapName);
    if (marker < 0) throw new Error(`Map marker ${this.mapName} missing after geometry serialization`);
    doc.lumps[marker + 1 + THINGS_LUMP_INDEX].data = encodeThings(ensureThings(this));
    return writeWad(doc, 'PWAD');
  };

  GeometryWorkspace.prototype.listThings = function listThings({ category = null, query = '', limit = 256 } = {}) {
    const q = String(query || '').trim().toLowerCase();
    return ensureThings(this).map(viewThing).filter(item => (!category || item.category === category)
      && (!q || item.key?.includes(q) || item.label.toLowerCase().includes(q) || String(item.doomEdNum) === q)).slice(0, limit);
  };

  GeometryWorkspace.prototype.addThing = function addThing(input = {}) {
    const things = ensureThings(this);
    this.checkpoint('thing_add');
    const thing = normalizedThing(input);
    const index = things.push(thing) - 1;
    return viewThing(thing, index);
  };

  GeometryWorkspace.prototype.moveThing = function moveThing({ thing, x, y, angle } = {}) {
    const things = ensureThings(this);
    const index = Math.trunc(Number(thing));
    if (!things[index]) throw new Error(`Unknown thing ${thing}`);
    this.checkpoint(`thing_move:${index}`);
    things[index] = normalizedThing({ x, y, angle }, things[index]);
    return viewThing(things[index], index);
  };

  GeometryWorkspace.prototype.updateThing = function updateThing({ thing, ...changes } = {}) {
    const things = ensureThings(this);
    const index = Math.trunc(Number(thing));
    if (!things[index]) throw new Error(`Unknown thing ${thing}`);
    this.checkpoint(`thing_update:${index}`);
    things[index] = normalizedThing(changes, things[index]);
    return viewThing(things[index], index);
  };

  GeometryWorkspace.prototype.deleteThing = function deleteThing({ thing } = {}) {
    const things = ensureThings(this);
    const index = Math.trunc(Number(thing));
    if (!things[index]) throw new Error(`Unknown thing ${thing}`);
    this.checkpoint(`thing_delete:${index}`);
    const [removed] = things.splice(index, 1);
    return { deleted: true, removed: viewThing(removed, index), remaining: things.length };
  };
}
