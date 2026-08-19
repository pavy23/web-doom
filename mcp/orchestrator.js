import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ORCHESTRATOR_VERSION = '1.0.0';
export const MAX_SESSION_ITERATIONS = 8;
export const MAX_EDITS_PER_ITERATION = 12;
export const MAX_ACTIONS_PER_TRIAL = 16;
export const MAX_TICS_PER_TRIAL = 700;

export const SPAWNABLE_ENEMIES = Object.freeze([
  'zombieman', 'shotgun_guy', 'imp', 'demon', 'spectre', 'baron_of_hell'
]);

export const LINEDEF_PRESETS = Object.freeze([
  'none',
  'manual_raise', 'manual_open',
  'switch_raise_once', 'switch_open_once', 'switch_close_once',
  'button_raise', 'button_open', 'button_close',
  'manual_blazing_raise', 'manual_blazing_open',
  'switch_blazing_raise_once', 'switch_blazing_open_once', 'switch_blazing_close_once',
  'button_blazing_raise', 'button_blazing_open', 'button_blazing_close'
]);

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const EXPORT_DIR = path.resolve(
  process.env.DOOM_MCP_EXPORT_DIR || path.join(MODULE_DIR, 'exports')
);

export function safeWadFilename(requested, fallback = 'ai_final.wad') {
  const raw = String(requested || fallback).trim() || fallback;
  const withExt = raw.toLowerCase().endsWith('.wad') ? raw : `${raw}.wad`;
  const safe = withExt.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '');
  if (!safe) throw new Error('PWAD filename is empty after sanitization');
  return safe;
}

export function sessionArtifactName(sessionId, kind, iteration = 0) {
  const safeSession = String(sessionId).replace(/[^a-zA-Z0-9_-]+/g, '_');
  if (kind === 'baseline') return `${safeSession}-baseline.wad`;
  if (kind === 'iteration') return `${safeSession}-iter-${String(iteration).padStart(2, '0')}.wad`;
  throw new Error(`Unknown session artifact kind: ${kind}`);
}

function exportPath(filename) {
  const safe = safeWadFilename(filename);
  const resolved = path.resolve(EXPORT_DIR, safe);
  if (path.dirname(resolved) !== EXPORT_DIR) throw new Error('PWAD path escapes export directory');
  return resolved;
}

export function inspectPwad(bytes) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length < 12) throw new Error('PWAD is smaller than its 12-byte header');
  if (bytes.subarray(0, 4).toString('ascii') !== 'PWAD') throw new Error('File is not a PWAD');
  const lumpCount = bytes.readUInt32LE(4);
  const directoryOffset = bytes.readUInt32LE(8);
  if (lumpCount < 1 || lumpCount > 4096) throw new Error(`Unreasonable PWAD lump count: ${lumpCount}`);
  if (directoryOffset > bytes.length || directoryOffset + lumpCount * 16 > bytes.length) {
    throw new Error('PWAD directory lies outside the file');
  }
  const lumps = [];
  for (let i = 0; i < lumpCount; ++i) {
    const offset = directoryOffset + i * 16;
    const position = bytes.readUInt32LE(offset);
    const size = bytes.readUInt32LE(offset + 4);
    const name = bytes.subarray(offset + 8, offset + 16).toString('ascii').replace(/\0.*$/, '');
    if (position > bytes.length || position + size > bytes.length) {
      throw new Error(`PWAD lump ${i} (${name}) lies outside the file`);
    }
    lumps.push({ index: i, name, position, size });
  }
  return {
    bytes: bytes.length,
    lumpCount,
    directoryOffset,
    mapMarkers: lumps.map(lump => lump.name).filter(name => /^E[1-9]M[1-9]$/.test(name)),
    lumps
  };
}

export async function saveBrowserPwad(filename, exported) {
  const safe = safeWadFilename(filename);
  if (!exported?.base64 || Number(exported?.size || 0) <= 0) {
    throw new Error('Browser did not return PWAD bytes');
  }
  const bytes = Buffer.from(exported.base64, 'base64');
  if (bytes.length !== Number(exported.size)) {
    throw new Error(`PWAD size mismatch: browser=${exported.size}, decoded=${bytes.length}`);
  }
  const inspection = inspectPwad(bytes);
  await mkdir(EXPORT_DIR, { recursive: true });
  const outputPath = exportPath(safe);
  await writeFile(outputPath, bytes);
  return { filename: safe, path: outputPath, bytes: bytes.length, inspection };
}

export async function readSavedPwad(filename) {
  const safe = safeWadFilename(filename);
  const inputPath = exportPath(safe);
  const bytes = await readFile(inputPath);
  const inspection = inspectPwad(bytes);
  return { filename: safe, path: inputPath, bytes, inspection };
}

export async function copySavedPwad(sourceFilename, destinationFilename) {
  const source = await readSavedPwad(sourceFilename);
  const destination = safeWadFilename(destinationFilename);
  await mkdir(EXPORT_DIR, { recursive: true });
  const destinationPath = exportPath(destination);
  await copyFile(source.path, destinationPath);
  const info = await stat(destinationPath);
  return {
    filename: destination,
    path: destinationPath,
    bytes: info.size,
    source: source.filename,
    inspection: source.inspection
  };
}

export function hasAuthoringChanges(changeset) {
  return Boolean(changeset?.ready) && (
    Number(changeset.sectorLightCount || 0) > 0
    || Number(changeset.spawnCount || 0) > 0
    || Number(changeset.removeCount || 0) > 0
    || Number(changeset.linedefCount || 0) > 0
    || Number(changeset.sidedefCount || 0) > 0
    || Number(changeset.sectorFlatCount || 0) > 0
  );
}

export function compactChangeset(changeset) {
  return {
    sectorLights: Number(changeset?.sectorLightCount || 0),
    spawnedThings: Number(changeset?.spawnCount || 0),
    removedThings: Number(changeset?.removeCount || 0),
    linedefs: Number(changeset?.linedefCount || 0),
    sidedefs: Number(changeset?.sidedefCount || 0),
    sectorFlats: Number(changeset?.sectorFlatCount || 0)
  };
}

export function revisionHints(evaluation = {}) {
  const hints = [];
  const dimensions = evaluation.dimensions || {};
  const visualFailures = evaluation.visual?.failures || [];

  if (Number(dimensions.survivability ?? 1) < 0.75
      || (evaluation.hardFailures || []).some(item => /death|health/i.test(item))) {
    hints.push({ priority: 'high', problem: 'survivability', allowedEdits: ['remove_nearest_enemy', 'sector_light', 'wall_texture'], note: 'Reduce immediate enemy pressure or improve visibility before adding more combat complexity.' });
  }
  if (Number(dimensions.traversal ?? 1) < 0.75 || (evaluation.stuckActions || []).length) {
    hints.push({ priority: 'high', problem: 'traversal', allowedEdits: ['linedef_action', 'sector_light', 'wall_texture', 'sector_flat'], note: 'Clarify the route, make the intended door behavior obvious, or increase local visual contrast.' });
  }
  if (Number(dimensions.combat ?? 1) < 0.75) {
    hints.push({ priority: 'medium', problem: 'combat_goal', allowedEdits: ['spawn_enemy', 'remove_nearest_enemy', 'sector_light'], note: 'Adjust encounter density or placement while keeping the survivability constraints intact.' });
  }
  if (Number(dimensions.pacing ?? 1) < 0.75) {
    hints.push({ priority: 'medium', problem: 'pacing', allowedEdits: ['linedef_action', 'remove_nearest_enemy', 'spawn_enemy'], note: 'Reduce blocking friction for an overlong trial or add pressure if the trial is too empty/short.' });
  }
  if (visualFailures.length || Number(dimensions.visual ?? 1) < 0.75) {
    hints.push({ priority: 'medium', problem: 'visual_rubric', allowedEdits: ['sector_light', 'wall_texture', 'sector_flat'], note: 'Use only loaded IWAD assets and revise lighting/material contrast against the failed visual rubric.' });
  }
  return hints;
}
