import { Buffer } from 'node:buffer';

export const GEOMETRY_VERSION = '2.0.0';
export const MAP_LUMP_ORDER = [
  'THINGS', 'LINEDEFS', 'SIDEDEFS', 'VERTEXES', 'SEGS',
  'SSECTORS', 'NODES', 'SECTORS', 'REJECT', 'BLOCKMAP'
];

const ML_BLOCKING = 1;
const ML_TWOSIDED = 4;
const NO_SIDE = 0xffff;

function clampInt16(value, label) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < -32768 || n > 32767) {
    throw new Error(`${label} must fit a signed 16-bit DOOM map coordinate`);
  }
  return n;
}

function clampUInt16(value, label, allowNoSide = false) {
  const n = Math.trunc(Number(value));
  const max = allowNoSide ? 0xffff : 0xfffe;
  if (!Number.isFinite(n) || n < 0 || n > max) {
    throw new Error(`${label} must fit an unsigned 16-bit DOOM index`);
  }
  return n;
}

function name8(bytes, offset) {
  return bytes.subarray(offset, offset + 8).toString('ascii').replace(/\0.*$/, '').toUpperCase();
}

function writeName8(buffer, offset, value, fallback = '-') {
  const text = String(value ?? fallback).trim().toUpperCase() || fallback;
  if (text.length > 8 || !/^[A-Z0-9_\-]+$/.test(text)) {
    throw new Error(`Invalid DOOM lump/texture name: ${text}`);
  }
  buffer.fill(0, offset, offset + 8);
  buffer.write(text, offset, Math.min(8, text.length), 'ascii');
}

export function parseWad(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.length < 12) throw new Error('WAD is smaller than its header');
  const magic = bytes.subarray(0, 4).toString('ascii');
  if (magic !== 'PWAD' && magic !== 'IWAD') throw new Error(`Unsupported WAD magic: ${magic}`);
  const count = bytes.readUInt32LE(4);
  const dir = bytes.readUInt32LE(8);
  if (count < 1 || count > 65535 || dir + count * 16 > bytes.length) {
    throw new Error('Invalid WAD directory');
  }
  const lumps = [];
  for (let i = 0; i < count; i++) {
    const at = dir + i * 16;
    const position = bytes.readUInt32LE(at);
    const size = bytes.readUInt32LE(at + 4);
    const name = name8(bytes, at + 8);
    if (position + size > bytes.length) throw new Error(`Lump ${name || i} lies outside WAD`);
    lumps.push({ name, data: Buffer.from(bytes.subarray(position, position + size)) });
  }
  return { magic, lumps };
}

export function writeWad(doc, magic = 'PWAD') {
  const lumps = doc.lumps || [];
  const dataSize = lumps.reduce((sum, lump) => sum + lump.data.length, 0);
  const dirOffset = 12 + dataSize;
  const out = Buffer.alloc(dirOffset + lumps.length * 16);
  out.write(magic, 0, 4, 'ascii');
  out.writeUInt32LE(lumps.length, 4);
  out.writeUInt32LE(dirOffset, 8);
  let cursor = 12;
  for (let i = 0; i < lumps.length; i++) {
    const lump = lumps[i];
    const data = Buffer.from(lump.data || []);
    data.copy(out, cursor);
    const de = dirOffset + i * 16;
    out.writeUInt32LE(cursor, de);
    out.writeUInt32LE(data.length, de + 4);
    writeName8(out, de + 8, lump.name || '');
    cursor += data.length;
  }
  return out;
}

function locateMap(doc, mapName) {
  const wanted = String(mapName || '').toUpperCase();
  const marker = doc.lumps.findIndex(l => l.name === wanted);
  if (marker < 0) throw new Error(`Map marker ${wanted} not found in PWAD`);
  for (let i = 0; i < MAP_LUMP_ORDER.length; i++) {
    if (doc.lumps[marker + 1 + i]?.name !== MAP_LUMP_ORDER[i]) {
      throw new Error(`${wanted} does not have the canonical Doom map lump sequence`);
    }
  }
  return marker;
}

function parseVertices(data) {
  if (data.length % 4) throw new Error('VERTEXES size is not divisible by 4');
  const out = [];
  for (let at = 0; at < data.length; at += 4) out.push({ x: data.readInt16LE(at), y: data.readInt16LE(at + 2) });
  return out;
}

function parseLinedefs(data) {
  if (data.length % 14) throw new Error('LINEDEFS size is not divisible by 14');
  const out = [];
  for (let at = 0; at < data.length; at += 14) {
    out.push({
      v1: data.readUInt16LE(at), v2: data.readUInt16LE(at + 2),
      flags: data.readUInt16LE(at + 4), special: data.readUInt16LE(at + 6), tag: data.readUInt16LE(at + 8),
      right: data.readUInt16LE(at + 10), left: data.readUInt16LE(at + 12)
    });
  }
  return out;
}

function parseSidedefs(data) {
  if (data.length % 30) throw new Error('SIDEDEFS size is not divisible by 30');
  const out = [];
  for (let at = 0; at < data.length; at += 30) {
    out.push({
      xOffset: data.readInt16LE(at), yOffset: data.readInt16LE(at + 2),
      upper: name8(data, at + 4), lower: name8(data, at + 12), middle: name8(data, at + 20),
      sector: data.readUInt16LE(at + 28)
    });
  }
  return out;
}

function parseSectors(data) {
  if (data.length % 26) throw new Error('SECTORS size is not divisible by 26');
  const out = [];
  for (let at = 0; at < data.length; at += 26) {
    out.push({
      floor: data.readInt16LE(at), ceiling: data.readInt16LE(at + 2),
      floorFlat: name8(data, at + 4), ceilingFlat: name8(data, at + 12),
      light: data.readInt16LE(at + 20), special: data.readUInt16LE(at + 22), tag: data.readUInt16LE(at + 24)
    });
  }
  return out;
}

function encodeVertices(items) {
  const out = Buffer.alloc(items.length * 4);
  items.forEach((v, i) => { out.writeInt16LE(clampInt16(v.x, 'vertex.x'), i * 4); out.writeInt16LE(clampInt16(v.y, 'vertex.y'), i * 4 + 2); });
  return out;
}

function encodeLinedefs(items) {
  const out = Buffer.alloc(items.length * 14);
  items.forEach((l, i) => {
    const at = i * 14;
    out.writeUInt16LE(clampUInt16(l.v1, 'linedef.v1'), at);
    out.writeUInt16LE(clampUInt16(l.v2, 'linedef.v2'), at + 2);
    out.writeUInt16LE(clampUInt16(l.flags, 'linedef.flags'), at + 4);
    out.writeUInt16LE(clampUInt16(l.special, 'linedef.special'), at + 6);
    out.writeUInt16LE(clampUInt16(l.tag, 'linedef.tag'), at + 8);
    out.writeUInt16LE(clampUInt16(l.right, 'linedef.right', true), at + 10);
    out.writeUInt16LE(clampUInt16(l.left, 'linedef.left', true), at + 12);
  });
  return out;
}

function encodeSidedefs(items) {
  const out = Buffer.alloc(items.length * 30);
  items.forEach((s, i) => {
    const at = i * 30;
    out.writeInt16LE(clampInt16(s.xOffset || 0, 'sidedef.xOffset'), at);
    out.writeInt16LE(clampInt16(s.yOffset || 0, 'sidedef.yOffset'), at + 2);
    writeName8(out, at + 4, s.upper || '-'); writeName8(out, at + 12, s.lower || '-'); writeName8(out, at + 20, s.middle || '-');
    out.writeUInt16LE(clampUInt16(s.sector, 'sidedef.sector'), at + 28);
  });
  return out;
}

function encodeSectors(items) {
  const out = Buffer.alloc(items.length * 26);
  items.forEach((s, i) => {
    const at = i * 26;
    out.writeInt16LE(clampInt16(s.floor, 'sector.floor'), at);
    out.writeInt16LE(clampInt16(s.ceiling, 'sector.ceiling'), at + 2);
    writeName8(out, at + 4, s.floorFlat || 'FLOOR0_1'); writeName8(out, at + 12, s.ceilingFlat || 'CEIL1_1');
    out.writeInt16LE(clampInt16(s.light ?? 160, 'sector.light'), at + 20);
    out.writeUInt16LE(clampUInt16(s.special || 0, 'sector.special'), at + 22);
    out.writeUInt16LE(clampUInt16(s.tag || 0, 'sector.tag'), at + 24);
  });
  return out;
}

function clone(value) { return structuredClone(value); }
function point(v) { return { x: v.x, y: v.y }; }
function midpoint(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
function cross(ax, ay, bx, by) { return ax * by - ay * bx; }
function dot(ax, ay, bx, by) { return ax * bx + ay * by; }

function properIntersection(a, b, c, d) {
  const abx = b.x - a.x, aby = b.y - a.y, acx = c.x - a.x, acy = c.y - a.y, adx = d.x - a.x, ady = d.y - a.y;
  const cdx = d.x - c.x, cdy = d.y - c.y, cax = a.x - c.x, cay = a.y - c.y, cbx = b.x - c.x, cby = b.y - c.y;
  const s1 = cross(abx, aby, acx, acy), s2 = cross(abx, aby, adx, ady);
  const s3 = cross(cdx, cdy, cax, cay), s4 = cross(cdx, cdy, cbx, cby);
  return ((s1 > 0 && s2 < 0) || (s1 < 0 && s2 > 0)) && ((s3 > 0 && s4 < 0) || (s3 < 0 && s4 > 0));
}

function sectorForSide(geometry, sideIndex) {
  if (sideIndex === NO_SIDE) return null;
  return geometry.sidedefs[sideIndex]?.sector ?? null;
}

export class GeometryWorkspace {
  constructor(baseBytes, mapName) {
    this.mapName = String(mapName).toUpperCase();
    this.baseBytes = Buffer.from(baseBytes);
    this.doc = parseWad(this.baseBytes);
    this.marker = locateMap(this.doc, this.mapName);
    const lump = name => this.doc.lumps[this.marker + 1 + MAP_LUMP_ORDER.indexOf(name)].data;
    this.geometry = {
      vertices: parseVertices(lump('VERTEXES')),
      linedefs: parseLinedefs(lump('LINEDEFS')),
      sidedefs: parseSidedefs(lump('SIDEDEFS')),
      sectors: parseSectors(lump('SECTORS'))
    };
    this.originalCounts = {
      vertices: this.geometry.vertices.length, linedefs: this.geometry.linedefs.length,
      sidedefs: this.geometry.sidedefs.length, sectors: this.geometry.sectors.length
    };
    this.history = [];
    this.createdRooms = new Map();
    this.nextRoomId = 1;
  }

  summary() {
    return {
      version: GEOMETRY_VERSION, map: this.mapName,
      counts: Object.fromEntries(Object.entries(this.geometry).map(([k, v]) => [k, v.length])),
      originalCounts: this.originalCounts,
      edits: this.history.map((h, index) => ({ index: index + 1, label: h.label })),
      createdRooms: [...this.createdRooms.values()].map(r => ({ roomId: r.roomId, sector: r.sector, portalLine: r.portalLine, depth: r.depth }))
    };
  }

  inspect({ vertexLimit = 128, lineLimit = 128, sectorLimit = 128 } = {}) {
    const lineView = this.geometry.linedefs.slice(0, lineLimit).map((l, index) => {
      const a = this.geometry.vertices[l.v1], b = this.geometry.vertices[l.v2];
      return { index, ...l, a, b, rightSector: sectorForSide(this.geometry, l.right), leftSector: sectorForSide(this.geometry, l.left) };
    });
    return {
      ...this.summary(),
      vertices: this.geometry.vertices.slice(0, vertexLimit).map((v, index) => ({ index, ...v })),
      linedefs: lineView,
      sectors: this.geometry.sectors.slice(0, sectorLimit).map((s, index) => ({ index, ...s }))
    };
  }

  checkpoint(label) {
    this.history.push({ label, geometry: clone(this.geometry), createdRooms: clone([...this.createdRooms.entries()]), nextRoomId: this.nextRoomId });
  }

  undo() {
    const snap = this.history.pop();
    if (!snap) throw new Error('Geometry history is empty');
    this.geometry = snap.geometry;
    this.createdRooms = new Map(snap.createdRooms);
    this.nextRoomId = snap.nextRoomId;
    return this.summary();
  }

  addVertex({ x, y }) {
    this.checkpoint('add_vertex');
    const index = this.geometry.vertices.push({ x: clampInt16(x, 'x'), y: clampInt16(y, 'y') }) - 1;
    return { vertex: index, ...this.geometry.vertices[index] };
  }

  moveVertex({ vertex, x, y }) {
    const index = Math.trunc(vertex);
    if (!this.geometry.vertices[index]) throw new Error(`Unknown vertex ${index}`);
    this.checkpoint(`move_vertex:${index}`);
    this.geometry.vertices[index] = { x: clampInt16(x, 'x'), y: clampInt16(y, 'y') };
    return { vertex: index, ...this.geometry.vertices[index] };
  }

  addSector(input = {}) {
    this.checkpoint('add_sector');
    const source = input.copyFrom != null ? this.geometry.sectors[Math.trunc(input.copyFrom)] : null;
    if (input.copyFrom != null && !source) throw new Error(`Unknown source sector ${input.copyFrom}`);
    const sector = {
      floor: clampInt16(input.floor ?? source?.floor ?? 0, 'floor'),
      ceiling: clampInt16(input.ceiling ?? source?.ceiling ?? 128, 'ceiling'),
      floorFlat: input.floorFlat ?? source?.floorFlat ?? 'FLOOR0_1',
      ceilingFlat: input.ceilingFlat ?? source?.ceilingFlat ?? 'CEIL1_1',
      light: clampInt16(input.light ?? source?.light ?? 160, 'light'),
      special: Math.trunc(input.special ?? source?.special ?? 0), tag: Math.trunc(input.tag ?? source?.tag ?? 0)
    };
    if (sector.ceiling <= sector.floor) throw new Error('Sector ceiling must be above floor');
    const index = this.geometry.sectors.push(sector) - 1;
    return { sector: index, ...sector };
  }

  setSectorHeights({ sector, floor, ceiling }) {
    const index = Math.trunc(sector); const current = this.geometry.sectors[index];
    if (!current) throw new Error(`Unknown sector ${index}`);
    this.checkpoint(`sector_heights:${index}`);
    const nextFloor = floor == null ? current.floor : clampInt16(floor, 'floor');
    const nextCeiling = ceiling == null ? current.ceiling : clampInt16(ceiling, 'ceiling');
    if (nextCeiling <= nextFloor) throw new Error('Sector ceiling must be above floor');
    current.floor = nextFloor; current.ceiling = nextCeiling;
    return { sector: index, floor: current.floor, ceiling: current.ceiling };
  }

  addSidedef(input = {}) {
    const sector = Math.trunc(input.sector);
    if (!this.geometry.sectors[sector]) throw new Error(`Unknown sector ${sector}`);
    this.checkpoint('add_sidedef');
    const side = { xOffset: Math.trunc(input.xOffset || 0), yOffset: Math.trunc(input.yOffset || 0), upper: input.upper || '-', lower: input.lower || '-', middle: input.middle || '-', sector };
    const index = this.geometry.sidedefs.push(side) - 1;
    return { sidedef: index, ...side };
  }

  addLinedef(input = {}) {
    const v1 = Math.trunc(input.v1), v2 = Math.trunc(input.v2);
    if (!this.geometry.vertices[v1] || !this.geometry.vertices[v2]) throw new Error('Linedef references an unknown vertex');
    const right = input.right == null ? NO_SIDE : Math.trunc(input.right), left = input.left == null ? NO_SIDE : Math.trunc(input.left);
    if (right !== NO_SIDE && !this.geometry.sidedefs[right]) throw new Error(`Unknown right sidedef ${right}`);
    if (left !== NO_SIDE && !this.geometry.sidedefs[left]) throw new Error(`Unknown left sidedef ${left}`);
    this.checkpoint('add_linedef');
    let flags = Math.trunc(input.flags ?? (left === NO_SIDE ? ML_BLOCKING : ML_TWOSIDED));
    if (left !== NO_SIDE) flags |= ML_TWOSIDED;
    const line = { v1, v2, flags, special: Math.trunc(input.special || 0), tag: Math.trunc(input.tag || 0), right, left };
    const index = this.geometry.linedefs.push(line) - 1;
    return { linedef: index, ...line };
  }

  addRoomFromWall(input = {}) {
    const lineIndex = Math.trunc(input.line); const line = this.geometry.linedefs[lineIndex];
    if (!line) throw new Error(`Unknown linedef ${lineIndex}`);
    if (line.left !== NO_SIDE || line.right === NO_SIDE) throw new Error('add_room requires a one-sided wall with a right/front sidedef');
    const sourceSide = this.geometry.sidedefs[line.right]; const sourceSector = this.geometry.sectors[sourceSide.sector];
    if (!sourceSector) throw new Error('Wall front sector is invalid');
    const a = this.geometry.vertices[line.v1], b = this.geometry.vertices[line.v2];
    const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
    const depth = Math.round(Number(input.depth ?? 192));
    if (!Number.isFinite(depth) || depth < 32 || depth > 2048 || length < 32) throw new Error('Room depth/portal wall is outside safe bounds');
    const nx = -dy / length, ny = dx / length;
    const p1 = { x: clampInt16(a.x + nx * depth, 'room.x1'), y: clampInt16(a.y + ny * depth, 'room.y1') };
    const p2 = { x: clampInt16(b.x + nx * depth, 'room.x2'), y: clampInt16(b.y + ny * depth, 'room.y2') };
    const wallTexture = input.wallTexture || sourceSide.middle || sourceSide.lower || sourceSide.upper || 'STARTAN3';
    this.checkpoint(`add_room_from_wall:${lineIndex}`);

    const sector = this.geometry.sectors.push({
      ...clone(sourceSector),
      floor: input.floor == null ? sourceSector.floor : clampInt16(input.floor, 'room.floor'),
      ceiling: input.ceiling == null ? sourceSector.ceiling : clampInt16(input.ceiling, 'room.ceiling'),
      light: input.light == null ? sourceSector.light : clampInt16(input.light, 'room.light'),
      floorFlat: input.floorFlat || sourceSector.floorFlat,
      ceilingFlat: input.ceilingFlat || sourceSector.ceilingFlat,
      special: Math.trunc(input.special ?? 0), tag: Math.trunc(input.tag ?? 0)
    }) - 1;
    if (this.geometry.sectors[sector].ceiling <= this.geometry.sectors[sector].floor) throw new Error('New room ceiling must be above floor');
    const pv1 = this.geometry.vertices.push(p1) - 1, pv2 = this.geometry.vertices.push(p2) - 1;
    const portalBack = this.geometry.sidedefs.push({ xOffset: 0, yOffset: 0, upper: '-', lower: '-', middle: '-', sector }) - 1;
    sourceSide.middle = '-'; line.left = portalBack; line.flags = (line.flags | ML_TWOSIDED) & ~ML_BLOCKING;
    const outerSides = [0, 1, 2].map(() => this.geometry.sidedefs.push({ xOffset: 0, yOffset: 0, upper: '-', lower: '-', middle: wallTexture, sector }) - 1);
    const newLines = [
      { v1: line.v1, v2: pv1, flags: ML_BLOCKING, special: 0, tag: 0, right: outerSides[0], left: NO_SIDE },
      { v1: pv1, v2: pv2, flags: ML_BLOCKING, special: 0, tag: 0, right: outerSides[1], left: NO_SIDE },
      { v1: pv2, v2: line.v2, flags: ML_BLOCKING, special: 0, tag: 0, right: outerSides[2], left: NO_SIDE }
    ];
    const firstLine = this.geometry.linedefs.length; this.geometry.linedefs.push(...newLines);
    const roomId = `room-${String(this.nextRoomId++).padStart(3, '0')}`;
    const meta = { roomId, sector, portalLine: lineIndex, outerVertices: [pv1, pv2], outerLines: [firstLine, firstLine + 1, firstLine + 2], depth, historyDepth: this.history.length };
    this.createdRooms.set(roomId, meta);
    return { ...meta, portalLength: Math.round(length), newVertexes: [pv1, pv2] };
  }

  resizeCreatedRoom({ roomId, depth }) {
    const room = this.createdRooms.get(String(roomId));
    if (!room) throw new Error(`Unknown generated room ${roomId}`);
    const line = this.geometry.linedefs[room.portalLine]; const a = this.geometry.vertices[line.v1], b = this.geometry.vertices[line.v2];
    const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy); const d = Math.round(Number(depth));
    if (!Number.isFinite(d) || d < 32 || d > 2048) throw new Error('Room depth must be 32..2048');
    this.checkpoint(`resize_room:${roomId}`);
    const nx = -dy / length, ny = dx / length;
    this.geometry.vertices[room.outerVertices[0]] = { x: clampInt16(a.x + nx * d, 'room.x1'), y: clampInt16(a.y + ny * d, 'room.y1') };
    this.geometry.vertices[room.outerVertices[1]] = { x: clampInt16(b.x + nx * d, 'room.x2'), y: clampInt16(b.y + ny * d, 'room.y2') };
    room.depth = d;
    return { ...room };
  }

  deleteCreatedRoom({ roomId }) {
    const room = this.createdRooms.get(String(roomId));
    if (!room) throw new Error(`Unknown generated room ${roomId}`);
    if (this.history.length !== room.historyDepth) throw new Error('Generated room can only be deleted while it is the latest geometry edit; use doom_geometry_undo for later edits');
    return this.undo();
  }

  addCorridorBetweenWalls(input = {}) {
    const aIndex = Math.trunc(input.lineA), bIndex = Math.trunc(input.lineB);
    const la = this.geometry.linedefs[aIndex], lb = this.geometry.linedefs[bIndex];
    if (!la || !lb || aIndex === bIndex) throw new Error('Corridor requires two different valid linedefs');
    if (la.left !== NO_SIDE || lb.left !== NO_SIDE || la.right === NO_SIDE || lb.right === NO_SIDE) throw new Error('Corridor endpoints must be one-sided walls');
    const a1 = this.geometry.vertices[la.v1], a2 = this.geometry.vertices[la.v2], b1 = this.geometry.vertices[lb.v1], b2 = this.geometry.vertices[lb.v2];
    const adx = a2.x - a1.x, ady = a2.y - a1.y, bdx = b2.x - b1.x, bdy = b2.y - b1.y;
    const alen = Math.hypot(adx, ady), blen = Math.hypot(bdx, bdy);
    if (alen < 32 || Math.abs(alen - blen) > 4 || Math.abs(cross(adx, ady, bdx, bdy)) > alen * blen * 0.01) throw new Error('Corridor walls must be parallel and approximately equal length');
    const am = midpoint(a1, a2), bm = midpoint(b1, b2);
    const anx = -ady / alen, any = adx / alen, bnx = -bdy / blen, bny = bdx / blen;
    if (dot(anx, any, bm.x - am.x, bm.y - am.y) <= 0 || dot(bnx, bny, am.x - bm.x, am.y - bm.y) <= 0) throw new Error('The outside/left sides of the selected walls do not face each other');
    this.checkpoint(`add_corridor:${aIndex}:${bIndex}`);
    const sourceSector = this.geometry.sectors[this.geometry.sidedefs[la.right].sector];
    const sector = this.geometry.sectors.push({ ...clone(sourceSector), special: Math.trunc(input.special ?? 0), tag: Math.trunc(input.tag ?? 0), light: input.light == null ? sourceSector.light : clampInt16(input.light, 'corridor.light') }) - 1;
    const backA = this.geometry.sidedefs.push({ xOffset: 0, yOffset: 0, upper: '-', lower: '-', middle: '-', sector }) - 1;
    const backB = this.geometry.sidedefs.push({ xOffset: 0, yOffset: 0, upper: '-', lower: '-', middle: '-', sector }) - 1;
    this.geometry.sidedefs[la.right].middle = '-'; this.geometry.sidedefs[lb.right].middle = '-';
    la.left = backA; lb.left = backB; la.flags = (la.flags | ML_TWOSIDED) & ~ML_BLOCKING; lb.flags = (lb.flags | ML_TWOSIDED) & ~ML_BLOCKING;
    const wallTexture = input.wallTexture || this.geometry.sidedefs[la.right].lower || this.geometry.sidedefs[la.right].upper || 'STARTAN3';
    const s1 = this.geometry.sidedefs.push({ xOffset: 0, yOffset: 0, upper: '-', lower: '-', middle: wallTexture, sector }) - 1;
    const s2 = this.geometry.sidedefs.push({ xOffset: 0, yOffset: 0, upper: '-', lower: '-', middle: wallTexture, sector }) - 1;
    const firstLine = this.geometry.linedefs.length;
    this.geometry.linedefs.push(
      { v1: la.v1, v2: lb.v2, flags: ML_BLOCKING, special: 0, tag: 0, right: s1, left: NO_SIDE },
      { v1: lb.v1, v2: la.v2, flags: ML_BLOCKING, special: 0, tag: 0, right: s2, left: NO_SIDE }
    );
    return { sector, portalLines: [aIndex, bIndex], sideLines: [firstLine, firstLine + 1], length: Math.round(Math.hypot(bm.x - am.x, bm.y - am.y)), width: Math.round(alen) };
  }

  validate() {
    const errors = [], warnings = [];
    const g = this.geometry;
    g.vertices.forEach((v, i) => { try { clampInt16(v.x, `vertex ${i}.x`); clampInt16(v.y, `vertex ${i}.y`); } catch (e) { errors.push(e.message); } });
    g.sectors.forEach((s, i) => {
      // Vanilla closed doors are stored with ceiling == floor. Only new sectors
      // must have a walkable height; original inverted sectors are still errors.
      if (i >= this.originalCounts.sectors) {
        if (s.ceiling <= s.floor) errors.push(`Sector ${i} ceiling ${s.ceiling} is not above floor ${s.floor}`);
      } else if (s.ceiling < s.floor) {
        errors.push(`Sector ${i} ceiling ${s.ceiling} is below floor ${s.floor}`);
      }
    });
    g.sidedefs.forEach((s, i) => { if (!g.sectors[s.sector]) errors.push(`Sidedef ${i} references missing sector ${s.sector}`); });
    g.linedefs.forEach((l, i) => {
      if (!g.vertices[l.v1] || !g.vertices[l.v2]) errors.push(`Linedef ${i} references missing vertex`);
      else if (l.v1 === l.v2 || (g.vertices[l.v1].x === g.vertices[l.v2].x && g.vertices[l.v1].y === g.vertices[l.v2].y)) errors.push(`Linedef ${i} has zero length`);
      if (l.right === NO_SIDE || !g.sidedefs[l.right]) errors.push(`Linedef ${i} has no valid right/front sidedef`);
      if (l.left !== NO_SIDE && !g.sidedefs[l.left]) errors.push(`Linedef ${i} has invalid left/back sidedef ${l.left}`);
      if (l.left !== NO_SIDE && !(l.flags & ML_TWOSIDED)) warnings.push(`Linedef ${i} has two sides but ML_TWOSIDED is not set`);
    });

    for (let i = this.originalCounts.linedefs; i < g.linedefs.length; i++) {
      const li = g.linedefs[i], a = g.vertices[li.v1], b = g.vertices[li.v2];
      for (let j = 0; j < i; j++) {
        const lj = g.linedefs[j];
        if ([li.v1, li.v2].includes(lj.v1) || [li.v1, li.v2].includes(lj.v2)) continue;
        if (properIntersection(a, b, g.vertices[lj.v1], g.vertices[lj.v2])) errors.push(`New linedef ${i} crosses linedef ${j}`);
      }
    }

    for (let sector = this.originalCounts.sectors; sector < g.sectors.length; sector++) {
      const degrees = new Map(); let edgeCount = 0;
      const bump = v => degrees.set(v, (degrees.get(v) || 0) + 1);
      g.linedefs.forEach(l => {
        if (sectorForSide(g, l.right) === sector) { bump(l.v1); bump(l.v2); edgeCount++; }
        if (sectorForSide(g, l.left) === sector) { bump(l.v1); bump(l.v2); edgeCount++; }
      });
      if (edgeCount < 3) errors.push(`New sector ${sector} has fewer than three boundary edges`);
      for (const [vertex, degree] of degrees) if (degree !== 2) errors.push(`New sector ${sector} boundary vertex ${vertex} has degree ${degree}, expected 2`);
    }

    return { ok: errors.length === 0, errors, warnings, summary: this.summary() };
  }

  preNodeWad() {
    const validation = this.validate();
    if (!validation.ok) throw new Error(`Geometry validation failed: ${validation.errors.join('; ')}`);
    const replacements = {
      LINEDEFS: encodeLinedefs(this.geometry.linedefs), SIDEDEFS: encodeSidedefs(this.geometry.sidedefs),
      VERTEXES: encodeVertices(this.geometry.vertices), SECTORS: encodeSectors(this.geometry.sectors),
      SEGS: Buffer.alloc(0), SSECTORS: Buffer.alloc(0), NODES: Buffer.alloc(0), REJECT: Buffer.alloc(0), BLOCKMAP: Buffer.alloc(0)
    };
    const doc = { magic: 'PWAD', lumps: this.doc.lumps.map(l => ({ name: l.name, data: Buffer.from(l.data) })) };
    for (let i = 0; i < MAP_LUMP_ORDER.length; i++) {
      const name = MAP_LUMP_ORDER[i];
      if (replacements[name]) doc.lumps[this.marker + 1 + i].data = replacements[name];
    }
    return writeWad(doc, 'PWAD');
  }
}

export function inspectBuiltMap(input, mapName) {
  const doc = parseWad(input); const marker = locateMap(doc, String(mapName).toUpperCase());
  const byName = Object.fromEntries(MAP_LUMP_ORDER.map((name, i) => [name, doc.lumps[marker + 1 + i].data]));
  const sectors = parseSectors(byName.SECTORS).length;
  const expectedReject = Math.ceil((sectors * sectors) / 8);
  const required = ['SEGS', 'SSECTORS', 'NODES', 'BLOCKMAP'];
  const missing = required.filter(name => !byName[name]?.length);
  return {
    ok: missing.length === 0 && byName.REJECT.length === expectedReject,
    map: String(mapName).toUpperCase(),
    bytes: Buffer.byteLength(input),
    counts: {
      vertices: parseVertices(byName.VERTEXES).length,
      linedefs: parseLinedefs(byName.LINEDEFS).length,
      sidedefs: parseSidedefs(byName.SIDEDEFS).length,
      sectors,
      segBytes: byName.SEGS.length, subsectorBytes: byName.SSECTORS.length, nodeBytes: byName.NODES.length,
      rejectBytes: byName.REJECT.length, expectedRejectBytes: expectedReject, blockmapBytes: byName.BLOCKMAP.length
    },
    missingDerivedLumps: missing
  };
}
