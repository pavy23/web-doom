export const SEMANTIC_GEOMETRY_VERSION = '2.3.0-p1.2';

const NO_SIDE = 0xffff;
const ML_BLOCKING = 0x0001;
const ML_TWOSIDED = 0x0004;
const PATCH_MARK = Symbol.for('web-doom.p1.semantic-geometry');

const DOOR_SPECIALS = Object.freeze({
  raise: Object.freeze({ none: 1, blue: 26, yellow: 27, red: 28 }),
  open: Object.freeze({ none: 31, blue: 32, red: 33, yellow: 34 })
});

function clone(value) { return structuredClone(value); }
function int16(value, label) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < -32768 || n > 32767) throw new Error(`${label} must fit signed 16-bit`);
  return n;
}
function boundedInt(value, label, min, max) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${label} must be ${min}..${max}`);
  return n;
}
function sideSector(g, side) {
  if (side === NO_SIDE) return null;
  return g.sidedefs[side]?.sector ?? null;
}
function sourceForWall(workspace, lineIndex) {
  const g = workspace.geometry;
  const index = Math.trunc(Number(lineIndex));
  const line = g.linedefs[index];
  if (!line) throw new Error(`Unknown linedef ${lineIndex}`);
  if (line.left !== NO_SIDE || line.right === NO_SIDE) throw new Error('Semantic extrusion requires a one-sided wall with a right/front sidedef');
  const side = g.sidedefs[line.right];
  const sector = g.sectors[side?.sector];
  if (!side || !sector) throw new Error(`Linedef ${index} has an invalid front sector`);
  const a = g.vertices[line.v1], b = g.vertices[line.v2];
  if (!a || !b) throw new Error(`Linedef ${index} references missing vertices`);
  const dx = b.x - a.x, dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length < 16) throw new Error('Semantic extrusion wall must be at least 16 map units long');
  return { g, index, line, side, sector, a, b, dx, dy, length, nx: -dy / length, ny: dx / length };
}
function chooseWallTexture(side, fallback = 'STARTAN3') {
  return [side.middle, side.lower, side.upper].find(value => value && value !== '-') || fallback;
}
function applyPortalStepTextures(g, line, frontSide, backSide, frontSector, backSector, texture) {
  if (frontSector.floor !== backSector.floor) {
    g.sidedefs[frontSide].lower = texture;
    g.sidedefs[backSide].lower = texture;
  }
  if (frontSector.ceiling !== backSector.ceiling) {
    g.sidedefs[frontSide].upper = texture;
    g.sidedefs[backSide].upper = texture;
  }
  line.flags = (line.flags | ML_TWOSIDED) & ~ML_BLOCKING;
}
function extrudeRect(workspace, lineIndex, input = {}) {
  const { g, index, line, side, sector: sourceSector, a, b, length, nx, ny } = sourceForWall(workspace, lineIndex);
  const depth = boundedInt(input.depth ?? 64, 'depth', 8, 2048);
  const p1 = { x: int16(a.x + nx * depth, 'extrusion.x1'), y: int16(a.y + ny * depth, 'extrusion.y1') };
  const p2 = { x: int16(b.x + nx * depth, 'extrusion.x2'), y: int16(b.y + ny * depth, 'extrusion.y2') };
  const wallTexture = String(input.wallTexture || chooseWallTexture(side));
  const transitionTexture = String(input.transitionTexture || wallTexture);
  const nextSector = {
    ...clone(sourceSector),
    floor: int16(input.floor ?? sourceSector.floor, 'sector.floor'),
    ceiling: int16(input.ceiling ?? sourceSector.ceiling, 'sector.ceiling'),
    floorFlat: input.floorFlat || sourceSector.floorFlat,
    ceilingFlat: input.ceilingFlat || sourceSector.ceilingFlat,
    light: int16(input.light ?? sourceSector.light, 'sector.light'),
    special: boundedInt(input.special ?? 0, 'sector.special', 0, 65535),
    tag: boundedInt(input.tag ?? 0, 'sector.tag', 0, 65535)
  };
  if (nextSector.ceiling <= nextSector.floor) throw new Error('Extruded sector ceiling must be above floor during construction');
  const sector = g.sectors.push(nextSector) - 1;
  const pv1 = g.vertices.push(p1) - 1;
  const pv2 = g.vertices.push(p2) - 1;
  const portalBack = g.sidedefs.push({ xOffset: 0, yOffset: 0, upper: '-', lower: '-', middle: '-', sector }) - 1;
  const originalMiddle = side.middle;
  side.middle = '-';
  line.left = portalBack;
  applyPortalStepTextures(g, line, line.right, portalBack, sourceSector, nextSector, transitionTexture);

  const outerSides = [0, 1, 2].map(() => g.sidedefs.push({
    xOffset: 0, yOffset: 0, upper: '-', lower: '-', middle: wallTexture, sector
  }) - 1);
  const firstLine = g.linedefs.length;
  g.linedefs.push(
    { v1: line.v1, v2: pv1, flags: ML_BLOCKING, special: 0, tag: 0, right: outerSides[0], left: NO_SIDE },
    { v1: pv1, v2: pv2, flags: ML_BLOCKING, special: 0, tag: 0, right: outerSides[1], left: NO_SIDE },
    { v1: pv2, v2: line.v2, flags: ML_BLOCKING, special: 0, tag: 0, right: outerSides[2], left: NO_SIDE }
  );
  return {
    sector,
    sourceSector: side.sector,
    portalLine: index,
    portalSides: [line.right, portalBack],
    outerVertices: [pv1, pv2],
    outerLines: [firstLine, firstLine + 1, firstLine + 2],
    farLine: firstLine + 1,
    sideLines: [firstLine, firstLine + 2],
    depth,
    width: Math.round(length),
    wallTexture,
    originalMiddle
  };
}
function reverseLine(g, lineIndex) {
  const line = g.linedefs[lineIndex];
  if (!line) throw new Error(`Unknown linedef ${lineIndex}`);
  [line.v1, line.v2] = [line.v2, line.v1];
  [line.right, line.left] = [line.left, line.right];
  return line;
}
function nextFreeTag(g) {
  const used = new Set();
  for (const sector of g.sectors) if (sector.tag > 0) used.add(Number(sector.tag));
  for (const line of g.linedefs) if (line.tag > 0) used.add(Number(line.tag));
  for (let tag = 1; tag <= 32767; tag++) if (!used.has(tag)) return tag;
  throw new Error('No free Doom sector tag remains');
}
function sectorBoundaryCycle(workspace, sectorIndex) {
  const g = workspace.geometry;
  const sector = Math.trunc(Number(sectorIndex));
  if (!g.sectors[sector]) throw new Error(`Unknown sector ${sectorIndex}`);
  const edges = [];
  g.linedefs.forEach((line, lineIndex) => {
    const right = sideSector(g, line.right);
    const left = sideSector(g, line.left);
    if (right === sector && left === sector) return;
    if (right === sector) edges.push({ line: lineIndex, from: line.v1, to: line.v2, side: 'right' });
    else if (left === sector) edges.push({ line: lineIndex, from: line.v2, to: line.v1, side: 'left' });
  });
  if (edges.length < 3) throw new Error(`Sector ${sector} has fewer than three boundary edges`);

  const outgoing = new Map();
  const incoming = new Map();
  for (const edge of edges) {
    if (outgoing.has(edge.from)) throw new Error(`Sector ${sector} boundary branches at vertex ${edge.from}`);
    if (incoming.has(edge.to)) throw new Error(`Sector ${sector} boundary merges at vertex ${edge.to}`);
    outgoing.set(edge.from, edge);
    incoming.set(edge.to, edge);
  }
  for (const edge of edges) {
    if (!incoming.has(edge.from) || !outgoing.has(edge.to)) throw new Error(`Sector ${sector} boundary is open at vertex ${edge.from}`);
  }

  const ordered = [];
  const start = edges[0];
  let edge = start;
  const seen = new Set();
  while (!seen.has(edge.line)) {
    seen.add(edge.line);
    ordered.push(edge);
    edge = outgoing.get(edge.to);
    if (!edge) throw new Error(`Sector ${sector} boundary walk terminated unexpectedly`);
  }
  if (edge.line !== start.line || seen.size !== edges.length) throw new Error(`Sector ${sector} has multiple/disconnected boundary cycles`);
  const vertices = ordered.map(item => item.from);
  return {
    sector,
    simple: true,
    edgeCount: ordered.length,
    vertices,
    points: vertices.map(vertex => ({ vertex, ...g.vertices[vertex] })),
    edges: ordered.map(item => ({ ...item, a: g.vertices[item.from], b: g.vertices[item.to] }))
  };
}
function replaceBoundarySideSector(g, edge, sector) {
  const line = g.linedefs[edge.line];
  const sideIndex = edge.side === 'right' ? line.right : line.left;
  if (sideIndex === NO_SIDE || !g.sidedefs[sideIndex]) throw new Error(`Boundary linedef ${edge.line} has no ${edge.side} sidedef`);
  g.sidedefs[sideIndex].sector = sector;
}

export function installSemanticGeometry(GeometryWorkspace) {
  if (GeometryWorkspace.prototype[PATCH_MARK]) return;
  Object.defineProperty(GeometryWorkspace.prototype, PATCH_MARK, { value: true });

  GeometryWorkspace.prototype.getSectorBoundary = function getSectorBoundary({ sector } = {}) {
    return sectorBoundaryCycle(this, sector);
  };

  GeometryWorkspace.prototype.addPolygonRoomFromWall = function addPolygonRoomFromWall(input = {}) {
    const source = sourceForWall(this, input.line);
    const sides = boundedInt(input.sides ?? 6, 'sides', 3, 12);
    const depth = boundedInt(input.depth ?? 192, 'depth', 32, 2048);
    this.checkpoint(`semantic_polygon_room:${source.index}`);
    const g = this.geometry;
    const sectorData = {
      ...clone(source.sector),
      floor: int16(input.floor ?? source.sector.floor, 'polygon.floor'),
      ceiling: int16(input.ceiling ?? source.sector.ceiling, 'polygon.ceiling'),
      floorFlat: input.floorFlat || source.sector.floorFlat,
      ceilingFlat: input.ceilingFlat || source.sector.ceilingFlat,
      light: int16(input.light ?? source.sector.light, 'polygon.light'),
      special: boundedInt(input.special ?? 0, 'polygon.special', 0, 65535),
      tag: boundedInt(input.tag ?? 0, 'polygon.tag', 0, 65535)
    };
    if (sectorData.ceiling <= sectorData.floor) throw new Error('Polygon room ceiling must be above floor');
    const sector = g.sectors.push(sectorData) - 1;
    const portalBack = g.sidedefs.push({ xOffset: 0, yOffset: 0, upper: '-', lower: '-', middle: '-', sector }) - 1;
    const wallTexture = String(input.wallTexture || chooseWallTexture(source.side));
    source.side.middle = '-';
    source.line.left = portalBack;
    applyPortalStepTextures(g, source.line, source.line.right, portalBack, source.sector, sectorData, wallTexture);

    const chain = [source.line.v1];
    const createdVertices = [];
    for (let k = 1; k <= sides - 2; k++) {
      const t = k / (sides - 1);
      const along = source.length * t;
      const outward = depth * Math.sin(Math.PI * t);
      const vertex = g.vertices.push({
        x: int16(source.a.x + (source.dx / source.length) * along + source.nx * outward, `polygon.x${k}`),
        y: int16(source.a.y + (source.dy / source.length) * along + source.ny * outward, `polygon.y${k}`)
      }) - 1;
      chain.push(vertex);
      createdVertices.push(vertex);
    }
    chain.push(source.line.v2);

    const createdLines = [];
    for (let i = 0; i < chain.length - 1; i++) {
      const side = g.sidedefs.push({ xOffset: 0, yOffset: 0, upper: '-', lower: '-', middle: wallTexture, sector }) - 1;
      const lineIndex = g.linedefs.push({ v1: chain[i], v2: chain[i + 1], flags: ML_BLOCKING, special: 0, tag: 0, right: side, left: NO_SIDE }) - 1;
      createdLines.push(lineIndex);
    }
    return { sector, portalLine: source.index, sides, depth, createdVertices, createdLines, farthestPoint: createdVertices[Math.floor((createdVertices.length - 1) / 2)] ?? null };
  };

  GeometryWorkspace.prototype.addStaircaseFromWall = function addStaircaseFromWall(input = {}) {
    const source = sourceForWall(this, input.line);
    const steps = boundedInt(input.steps ?? 6, 'steps', 2, 24);
    const stepDepth = boundedInt(input.stepDepth ?? 40, 'stepDepth', 16, 128);
    const stepHeight = boundedInt(input.stepHeight ?? 8, 'stepHeight', 1, 24);
    const direction = String(input.direction || 'up').toLowerCase();
    if (!['up', 'down'].includes(direction)) throw new Error('direction must be up or down');
    const delta = direction === 'up' ? stepHeight : -stepHeight;
    const finalFloor = int16(source.sector.floor + delta * steps, 'stairs.finalFloor');
    const targetCeiling = int16(input.ceiling ?? Math.max(source.sector.ceiling, finalFloor + 64), 'stairs.ceiling');
    if (targetCeiling <= Math.max(source.sector.floor, finalFloor)) throw new Error('Staircase ceiling leaves insufficient clearance');
    const landingDepth = boundedInt(input.landingDepth ?? 96, 'landingDepth', 0, 512);
    const wallTexture = String(input.wallTexture || chooseWallTexture(source.side));
    const riserTexture = String(input.riserTexture || wallTexture);
    this.checkpoint(`semantic_staircase:${source.index}`);

    let currentLine = source.index;
    const stepSectors = [];
    const portalLines = [];
    let last = null;
    for (let i = 0; i < steps; i++) {
      const floor = int16(source.sector.floor + delta * (i + 1), `stairs.floor${i + 1}`);
      last = extrudeRect(this, currentLine, {
        depth: stepDepth,
        floor,
        ceiling: targetCeiling,
        floorFlat: input.floorFlat || source.sector.floorFlat,
        ceilingFlat: input.ceilingFlat || source.sector.ceilingFlat,
        light: input.light ?? source.sector.light,
        wallTexture,
        transitionTexture: riserTexture
      });
      stepSectors.push(last.sector);
      portalLines.push(last.portalLine);
      currentLine = last.farLine;
    }
    let landing = null;
    if (landingDepth > 0) {
      landing = extrudeRect(this, currentLine, {
        depth: landingDepth,
        floor: finalFloor,
        ceiling: targetCeiling,
        floorFlat: input.floorFlat || source.sector.floorFlat,
        ceilingFlat: input.ceilingFlat || source.sector.ceilingFlat,
        light: input.light ?? source.sector.light,
        wallTexture,
        transitionTexture: riserTexture
      });
      portalLines.push(landing.portalLine);
      currentLine = landing.farLine;
    }
    return { direction, steps, stepDepth, stepHeight, finalFloor, ceiling: targetCeiling, stepSectors, landingSector: landing?.sector ?? null, portalLines, farLine: currentLine };
  };

  GeometryWorkspace.prototype.addDoorRoomFromWall = function addDoorRoomFromWall(input = {}) {
    const source = sourceForWall(this, input.line);
    const doorDepth = boundedInt(input.doorDepth ?? 24, 'doorDepth', 8, 64);
    const roomDepth = boundedInt(input.roomDepth ?? 192, 'roomDepth', 48, 1024);
    const key = String(input.key || 'none').toLowerCase();
    const behavior = String(input.behavior || 'raise').toLowerCase();
    if (!DOOR_SPECIALS[behavior] || DOOR_SPECIALS[behavior][key] == null) throw new Error('Door behavior/key must be raise|open and none|blue|yellow|red');
    const doorTexture = String(input.doorTexture || 'BIGDOOR2');
    const trackTexture = String(input.trackTexture || 'DOORTRAK');
    const roomWallTexture = String(input.roomWallTexture || chooseWallTexture(source.side));
    this.checkpoint(`semantic_door_room:${source.index}`);

    const door = extrudeRect(this, source.index, {
      depth: doorDepth,
      floor: source.sector.floor,
      ceiling: source.sector.ceiling,
      wallTexture: trackTexture,
      transitionTexture: doorTexture,
      floorFlat: input.floorFlat || source.sector.floorFlat,
      ceilingFlat: input.ceilingFlat || source.sector.ceilingFlat,
      light: input.light ?? source.sector.light
    });
    const room = extrudeRect(this, door.farLine, {
      depth: roomDepth,
      floor: int16(input.roomFloor ?? source.sector.floor, 'doorRoom.floor'),
      ceiling: int16(input.roomCeiling ?? source.sector.ceiling, 'doorRoom.ceiling'),
      wallTexture: roomWallTexture,
      transitionTexture: doorTexture,
      floorFlat: input.floorFlat || source.sector.floorFlat,
      ceilingFlat: input.ceilingFlat || source.sector.ceilingFlat,
      light: input.light ?? source.sector.light
    });

    const g = this.geometry;
    const doorSector = g.sectors[door.sector];
    doorSector.ceiling = doorSector.floor;
    const special = DOOR_SPECIALS[behavior][key];
    const sourcePortal = g.linedefs[door.portalLine];
    sourcePortal.special = special;
    sourcePortal.tag = 0;
    for (const sideIndex of [sourcePortal.right, sourcePortal.left]) if (sideIndex !== NO_SIDE) g.sidedefs[sideIndex].upper = doorTexture;

    const farPortal = reverseLine(g, door.farLine);
    farPortal.special = special;
    farPortal.tag = 0;
    for (const sideIndex of [farPortal.right, farPortal.left]) if (sideIndex !== NO_SIDE) g.sidedefs[sideIndex].upper = doorTexture;
    for (const lineIndex of door.sideLines) {
      const sideIndex = g.linedefs[lineIndex].right;
      if (sideIndex !== NO_SIDE) g.sidedefs[sideIndex].middle = trackTexture;
    }
    return {
      key,
      behavior,
      special,
      doorSector: door.sector,
      destinationSector: room.sector,
      sourcePortalLine: door.portalLine,
      destinationPortalLine: door.farLine,
      destinationFarLine: room.farLine,
      doorDepth,
      roomDepth
    };
  };

  GeometryWorkspace.prototype.addLiftRoomFromWall = function addLiftRoomFromWall(input = {}) {
    const source = sourceForWall(this, input.line);
    const liftDepth = boundedInt(input.liftDepth ?? 64, 'liftDepth', 24, 128);
    const roomDepth = boundedInt(input.roomDepth ?? 192, 'roomDepth', 48, 1024);
    const rise = boundedInt(input.rise ?? 64, 'rise', 25, 256);
    const highFloor = int16(source.sector.floor + rise, 'lift.highFloor');
    const clearance = boundedInt(input.clearance ?? 128, 'clearance', 64, 256);
    const ceiling = int16(input.ceiling ?? Math.max(source.sector.ceiling, highFloor + clearance), 'lift.ceiling');
    if (ceiling <= highFloor) throw new Error('Lift ceiling must be above its high floor');
    const wallTexture = String(input.wallTexture || chooseWallTexture(source.side));
    const tag = input.tag == null ? nextFreeTag(this.geometry) : boundedInt(input.tag, 'lift.tag', 1, 32767);
    this.checkpoint(`semantic_lift_room:${source.index}`);

    const lift = extrudeRect(this, source.index, {
      depth: liftDepth,
      floor: highFloor,
      ceiling,
      wallTexture,
      transitionTexture: wallTexture,
      floorFlat: input.floorFlat || source.sector.floorFlat,
      ceilingFlat: input.ceilingFlat || source.sector.ceilingFlat,
      light: input.light ?? source.sector.light,
      tag
    });
    const room = extrudeRect(this, lift.farLine, {
      depth: roomDepth,
      floor: highFloor,
      ceiling,
      wallTexture,
      transitionTexture: wallTexture,
      floorFlat: input.floorFlat || source.sector.floorFlat,
      ceilingFlat: input.ceilingFlat || source.sector.ceilingFlat,
      light: input.light ?? source.sector.light
    });
    const g = this.geometry;
    g.sectors[lift.sector].tag = tag;
    const callLine = g.linedefs[lift.portalLine];
    callLine.special = 62;
    callLine.tag = tag;
    const upperLine = g.linedefs[lift.farLine];
    upperLine.special = 88;
    upperLine.tag = tag;
    for (const sideIndex of [callLine.right, callLine.left, upperLine.right, upperLine.left]) {
      if (sideIndex !== NO_SIDE && g.sidedefs[sideIndex]) g.sidedefs[sideIndex].lower = wallTexture;
    }
    return {
      liftSector: lift.sector,
      destinationSector: room.sector,
      callLine: lift.portalLine,
      upperTriggerLine: lift.farLine,
      destinationFarLine: room.farLine,
      tag,
      rise,
      lowFloor: source.sector.floor,
      highFloor,
      ceiling,
      liftDepth,
      roomDepth
    };
  };

  GeometryWorkspace.prototype.splitSectorBetweenVertices = function splitSectorBetweenVertices(input = {}) {
    const sector = Math.trunc(Number(input.sector));
    const boundary = sectorBoundaryCycle(this, sector);
    const vertexA = Math.trunc(Number(input.vertexA));
    const vertexB = Math.trunc(Number(input.vertexB));
    const ia = boundary.vertices.indexOf(vertexA);
    const ib = boundary.vertices.indexOf(vertexB);
    if (ia < 0 || ib < 0) throw new Error('Split vertices must both lie on the selected sector boundary');
    if (ia === ib) throw new Error('Split vertices must be different');
    const count = boundary.vertices.length;
    const distance = (ib - ia + count) % count;
    if (distance <= 1 || distance >= count - 1) throw new Error('Split vertices must be non-adjacent boundary vertices');

    this.checkpoint(`semantic_split_sector:${sector}:${vertexA}:${vertexB}`);
    const g = this.geometry;
    const source = g.sectors[sector];
    const next = {
      ...clone(source),
      floor: int16(input.floor ?? source.floor, 'split.floor'),
      ceiling: int16(input.ceiling ?? source.ceiling, 'split.ceiling'),
      floorFlat: input.floorFlat || source.floorFlat,
      ceilingFlat: input.ceilingFlat || source.ceilingFlat,
      light: int16(input.light ?? source.light, 'split.light'),
      special: boundedInt(input.special ?? source.special, 'split.special', 0, 65535),
      tag: boundedInt(input.tag ?? source.tag, 'split.tag', 0, 65535)
    };
    if (next.ceiling <= next.floor) throw new Error('Split sector ceiling must be above floor');
    const newSector = g.sectors.push(next) - 1;

    const reassignedLines = [];
    let cursor = ia;
    while (cursor !== ib) {
      const edge = boundary.edges[cursor];
      replaceBoundarySideSector(g, edge, newSector);
      reassignedLines.push(edge.line);
      cursor = (cursor + 1) % count;
    }
    const newSide = g.sidedefs.push({ xOffset: 0, yOffset: 0, upper: '-', lower: '-', middle: '-', sector: newSector }) - 1;
    const oldSide = g.sidedefs.push({ xOffset: 0, yOffset: 0, upper: '-', lower: '-', middle: '-', sector }) - 1;
    const splitLine = g.linedefs.push({ v1: vertexB, v2: vertexA, flags: ML_TWOSIDED, special: 0, tag: 0, right: newSide, left: oldSide }) - 1;
    return { sourceSector: sector, newSector, splitLine, vertices: [vertexA, vertexB], reassignedLines };
  };
}
