import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';

import {
  GeometryWorkspace,
  MAP_LUMP_ORDER,
  inspectBuiltMap,
  parseWad,
  writeWad
} from './geometry.js';
import { rebuildVanillaNodes } from './nodebuilder.js';

export const EPISODE_WORKSPACE_VERSION = '2.3.0-p1.2';
export const DEFAULT_EPISODE_MAPS = Object.freeze([
  'E1M1', 'E1M2', 'E1M3', 'E1M4', 'E1M5', 'E1M6', 'E1M7', 'E1M8'
]);

const MAX_MAPS = 32;
const MAX_CANDIDATES = 12;
const MAP_NAME = /^(?:E[1-9]M[1-9]|MAP\d\d)$/;

function normalizeMapName(value) {
  const name = String(value || '').trim().toUpperCase();
  if (!MAP_NAME.test(name)) throw new Error(`Unsupported Doom map name: ${value}`);
  return name;
}

function cloneWorkspace(source) {
  const copy = new GeometryWorkspace(Buffer.from(source.baseBytes), source.mapName);
  copy.geometry = structuredClone(source.geometry);
  copy.originalCounts = structuredClone(source.originalCounts);
  copy.history = structuredClone(source.history || []);
  copy.createdRooms = new Map(structuredClone([...(source.createdRooms || new Map()).entries()]));
  copy.nextRoomId = Number(source.nextRoomId || 1);
  return copy;
}

function mapMarkerIndex(doc, mapName) {
  const marker = doc.lumps.findIndex(lump => lump.name === mapName);
  if (marker < 0) throw new Error(`Map marker ${mapName} not found in source WAD`);
  for (let i = 0; i < MAP_LUMP_ORDER.length; i++) {
    const actual = doc.lumps[marker + 1 + i]?.name;
    if (actual !== MAP_LUMP_ORDER[i]) {
      throw new Error(`${mapName} has non-canonical map lump order at ${i}: expected ${MAP_LUMP_ORDER[i]}, got ${actual || '<missing>'}`);
    }
  }
  return marker;
}

export function extractMapPwad(sourceBytes, requestedMap) {
  const mapName = normalizeMapName(requestedMap);
  const doc = parseWad(sourceBytes);
  const marker = mapMarkerIndex(doc, mapName);
  const lumps = doc.lumps.slice(marker, marker + 1 + MAP_LUMP_ORDER.length)
    .map(lump => ({ name: lump.name, data: Buffer.from(lump.data) }));
  return writeWad({ lumps }, 'PWAD');
}

export function combineMapPwads(mapEntries) {
  const lumps = [];
  for (const entry of mapEntries) {
    const mapName = normalizeMapName(entry.map);
    const doc = parseWad(entry.bytes);
    const marker = mapMarkerIndex(doc, mapName);
    for (const lump of doc.lumps.slice(marker, marker + 1 + MAP_LUMP_ORDER.length)) {
      lumps.push({ name: lump.name, data: Buffer.from(lump.data) });
    }
  }
  return writeWad({ lumps }, 'PWAD');
}

function validationView(validation) {
  return {
    ok: Boolean(validation?.ok),
    errors: validation?.errors || [],
    warnings: validation?.warnings || [],
    issues: validation?.issues || null,
    topology: validation?.topology || null,
    summary: validation?.summary || null
  };
}

function requireMethod(workspace, name, layer) {
  if (typeof workspace[name] !== 'function') throw new Error(`${layer} authoring layer is not installed`);
  return workspace[name].bind(workspace);
}

function applyEditToWorkspace(workspace, edit) {
  switch (edit.type) {
    case 'add_room':
      return workspace.addRoomFromWall({
        line: edit.line,
        depth: edit.depth,
        floor: edit.floor,
        ceiling: edit.ceiling,
        floorFlat: edit.floorFlat,
        ceilingFlat: edit.ceilingFlat,
        light: edit.light
      });
    case 'resize_room':
      return workspace.resizeCreatedRoom({ roomId: edit.roomId, depth: edit.depth });
    case 'delete_room':
      return workspace.deleteCreatedRoom({ roomId: edit.roomId });
    case 'add_corridor':
      return workspace.addCorridorBetweenWalls({
        lineA: edit.lineA,
        lineB: edit.lineB,
        floor: edit.floor,
        ceiling: edit.ceiling,
        floorFlat: edit.floorFlat,
        ceilingFlat: edit.ceilingFlat,
        light: edit.light
      });
    case 'set_sector_heights':
      return workspace.setSectorHeights({ sector: edit.sector, floor: edit.floor, ceiling: edit.ceiling });
    case 'move_vertex':
      return workspace.moveVertex({ vertex: edit.vertex, x: edit.x, y: edit.y });
    case 'add_vertex':
      return workspace.addVertex({ x: edit.x, y: edit.y });
    case 'add_sector':
      return workspace.addSector(edit);
    case 'add_sidedef':
      return workspace.addSidedef(edit);
    case 'add_linedef':
      return workspace.addLinedef(edit);
    case 'add_polygon_room':
      return requireMethod(workspace, 'addPolygonRoomFromWall', 'P1.2 semantic geometry')(edit);
    case 'add_staircase':
      return requireMethod(workspace, 'addStaircaseFromWall', 'P1.2 semantic geometry')(edit);
    case 'add_door_room':
      return requireMethod(workspace, 'addDoorRoomFromWall', 'P1.2 semantic geometry')(edit);
    case 'add_lift_room':
      return requireMethod(workspace, 'addLiftRoomFromWall', 'P1.2 semantic geometry')(edit);
    case 'split_sector':
      return requireMethod(workspace, 'splitSectorBetweenVertices', 'P1.2 semantic geometry')(edit);
    case 'thing_add':
      return requireMethod(workspace, 'addThing', 'P1 THINGS')(edit);
    case 'thing_move':
      return requireMethod(workspace, 'moveThing', 'P1 THINGS')(edit);
    case 'thing_update':
      return requireMethod(workspace, 'updateThing', 'P1 THINGS')(edit);
    case 'thing_delete':
      return requireMethod(workspace, 'deleteThing', 'P1 THINGS')(edit);
    case 'undo':
      return workspace.undo();
    default:
      throw new Error(`Unsupported episode transaction edit: ${edit.type}`);
  }
}

export class EpisodeWorkspace {
  constructor(sourceBytes, mapNames = DEFAULT_EPISODE_MAPS, sourceLabel = 'doom1.wad') {
    const names = [...new Set((mapNames || DEFAULT_EPISODE_MAPS).map(normalizeMapName))];
    if (!names.length || names.length > MAX_MAPS) throw new Error(`Map set must contain 1..${MAX_MAPS} maps`);

    this.version = EPISODE_WORKSPACE_VERSION;
    this.sourceLabel = String(sourceLabel || 'source.wad');
    this.sourceSha256 = createHash('sha256').update(Buffer.from(sourceBytes)).digest('hex');
    this.mapNames = names;
    this.workspaces = new Map();
    this.baselines = new Map();
    this.transaction = null;
    this.transactionCounter = 1;
    this.revision = 0;
    this.candidates = [];

    for (const mapName of names) {
      const workspace = new GeometryWorkspace(extractMapPwad(sourceBytes, mapName), mapName);
      this.workspaces.set(mapName, workspace);
      this.baselines.set(mapName, cloneWorkspace(workspace));
    }
  }

  summary() {
    return {
      version: this.version,
      source: this.sourceLabel,
      sourceSha256: this.sourceSha256,
      revision: this.revision,
      maps: this.mapNames.map(map => ({ map, ...this.workspaces.get(map).summary() })),
      transaction: this.transaction ? {
        id: this.transaction.id,
        label: this.transaction.label,
        startedAt: this.transaction.startedAt,
        touchedMaps: [...this.transaction.touchedMaps]
      } : null,
      candidates: this.candidates.map(candidate => ({
        index: candidate.index,
        filename: candidate.filename,
        bytes: candidate.bytes.length,
        maps: candidate.maps,
        createdAt: candidate.createdAt
      }))
    };
  }

  inspectMap(requestedMap, limits = {}) {
    const map = normalizeMapName(requestedMap);
    const workspace = this.workspaces.get(map);
    if (!workspace) throw new Error(`Map ${map} is not part of this episode workspace`);
    return workspace.inspect(limits);
  }

  beginTransaction(label = 'episode edit') {
    if (this.transaction) throw new Error(`Transaction ${this.transaction.id} is already active`);
    const snapshots = new Map();
    for (const [map, workspace] of this.workspaces) snapshots.set(map, cloneWorkspace(workspace));
    const id = `episode-tx-${String(this.transactionCounter++).padStart(4, '0')}`;
    this.transaction = {
      id,
      label: String(label || 'episode edit').slice(0, 160),
      startedAt: new Date().toISOString(),
      snapshots,
      touchedMaps: new Set(),
      edits: []
    };
    return this.summary().transaction;
  }

  applyEdits(edits = []) {
    if (!this.transaction) throw new Error('Begin an episode transaction before applying edits');
    if (!Array.isArray(edits) || !edits.length) throw new Error('At least one edit is required');
    if (edits.length > 128) throw new Error('A single episode transaction is limited to 128 edits');

    const results = [];
    try {
      for (let index = 0; index < edits.length; index++) {
        const edit = { ...edits[index], map: normalizeMapName(edits[index]?.map) };
        const workspace = this.workspaces.get(edit.map);
        if (!workspace) throw new Error(`Map ${edit.map} is not part of this episode workspace`);
        const result = applyEditToWorkspace(workspace, edit);
        this.transaction.touchedMaps.add(edit.map);
        this.transaction.edits.push(structuredClone(edit));
        results.push({ index, edit, result });
      }
      return { transaction: this.summary().transaction, results };
    } catch (error) {
      const transactionId = this.transaction.id;
      this.rollbackTransaction();
      throw new Error(`Episode transaction ${transactionId} rolled back after edit failure: ${error?.message || error}`);
    }
  }

  validate({ touchedOnly = false } = {}) {
    const maps = touchedOnly && this.transaction
      ? [...this.transaction.touchedMaps]
      : this.mapNames;
    const results = [];
    let ok = true;
    for (const map of maps) {
      const validation = this.workspaces.get(map).validate();
      if (!validation.ok) ok = false;
      results.push({ map, ...validationView(validation) });
    }
    return { ok, revision: this.revision, maps: results };
  }

  commitTransaction() {
    if (!this.transaction) throw new Error('No active episode transaction');
    const validation = this.validate({ touchedOnly: true });
    if (!validation.ok) {
      return { committed: false, transaction: this.summary().transaction, validation };
    }
    const committed = {
      id: this.transaction.id,
      label: this.transaction.label,
      editCount: this.transaction.edits.length,
      touchedMaps: [...this.transaction.touchedMaps],
      startedAt: this.transaction.startedAt,
      committedAt: new Date().toISOString()
    };
    this.transaction = null;
    this.revision++;
    return { committed: true, revision: this.revision, transaction: committed, validation };
  }

  rollbackTransaction() {
    if (!this.transaction) throw new Error('No active episode transaction');
    const rolledBack = {
      id: this.transaction.id,
      label: this.transaction.label,
      editCount: this.transaction.edits.length,
      touchedMaps: [...this.transaction.touchedMaps]
    };
    this.workspaces = new Map([...this.transaction.snapshots].map(([map, workspace]) => [map, cloneWorkspace(workspace)]));
    this.transaction = null;
    return { rolledBack: true, revision: this.revision, transaction: rolledBack };
  }

  restoreBaseline() {
    if (this.transaction) throw new Error('Rollback or commit the active transaction before restoring baseline');
    this.workspaces = new Map([...this.baselines].map(([map, workspace]) => [map, cloneWorkspace(workspace)]));
    this.revision++;
    return { restored: 'baseline', revision: this.revision, summary: this.summary() };
  }

  restoreCandidate(index) {
    if (this.transaction) throw new Error('Rollback or commit the active transaction before restoring a candidate');
    const candidate = this.candidates.find(item => item.index === Number(index));
    if (!candidate) throw new Error(`Unknown episode candidate ${index}`);
    const next = new Map();
    for (const map of this.mapNames) {
      next.set(map, new GeometryWorkspace(extractMapPwad(candidate.bytes, map), map));
    }
    this.workspaces = next;
    this.revision++;
    return { restored: 'candidate', candidate: candidate.index, filename: candidate.filename, revision: this.revision };
  }

  async build({ filename = 'episode1-ai.wad' } = {}) {
    if (this.transaction) throw new Error('Commit or rollback the active transaction before building the episode');
    if (this.candidates.length >= MAX_CANDIDATES) throw new Error(`Episode candidate limit ${MAX_CANDIDATES} reached`);
    const validation = this.validate();
    if (!validation.ok) throw new Error('Episode validation failed; inspect per-map errors before building');

    const builtMaps = [];
    for (const map of this.mapNames) {
      const workspace = this.workspaces.get(map);
      const preNode = workspace.preNodeWad();
      const rebuilt = await rebuildVanillaNodes(preNode, map);
      const inspected = inspectBuiltMap(rebuilt.bytes, map);
      if (!inspected.ok) throw new Error(`${map} failed post-nodebuild verification: ${JSON.stringify(inspected)}`);
      builtMaps.push({ map, bytes: rebuilt.bytes, inspected, builder: rebuilt.builder });
    }

    const bytes = combineMapPwads(builtMaps);
    const candidate = {
      index: this.candidates.length + 1,
      filename: String(filename || 'episode1-ai.wad'),
      bytes,
      maps: builtMaps.map(item => ({ map: item.map, inspected: item.inspected, builder: item.builder })),
      revision: this.revision,
      createdAt: new Date().toISOString()
    };
    this.candidates.push(candidate);
    return candidate;
  }
}
