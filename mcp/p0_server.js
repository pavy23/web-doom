import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import { GeometryWorkspace } from './geometry.js';
import { DEFAULT_EPISODE_MAPS, EpisodeWorkspace, EPISODE_WORKSPACE_VERSION } from './episode_workspace.js';
import { installFullTopologyValidator } from './topology_validator.js';
import { startBridge as startAuthoringBridge } from './server.js';
import { startPlaytestBridge } from './playtest_server.js';
import { startOrchestrationBridge } from './v1_server.js';
import { startCheatBridge } from './cheat_server.js';

installFullTopologyValidator(GeometryWorkspace);
const geometryModule = await import('./geometry_server.js');

const VERSION = '2.1.0-p0';
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_DIR = path.resolve(process.env.DOOM_MCP_EXPORT_DIR || path.join(MODULE_DIR, 'exports'));
const SOURCE_PATH = path.resolve(process.env.DOOM_EPISODE_SOURCE || path.join(MODULE_DIR, '..', 'doom1.wad'));
const MAX_EPISODE_SESSIONS = 4;

let nextSessionId = 1;
const sessions = new Map();

function jsonResult(value) { return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }; }
function toolError(error) { return { isError: true, content: [{ type: 'text', text: String(error?.message || error) }] }; }

function safeFilename(requested, fallback = 'episode1-ai.wad') {
  const raw = String(requested || fallback).trim() || fallback;
  const withExt = raw.toLowerCase().endsWith('.wad') ? raw : `${raw}.wad`;
  const safe = withExt.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '');
  if (!safe) throw new Error('Invalid episode WAD filename');
  return safe;
}

function exportPath(filename) {
  const resolved = path.resolve(EXPORT_DIR, filename);
  if (path.dirname(resolved) !== EXPORT_DIR) throw new Error('Episode artifact path escapes export directory');
  return resolved;
}

function getSession(id) {
  const session = sessions.get(String(id));
  if (!session) throw new Error(`Unknown episode session ${id}`);
  return session;
}

// P1+ layers compose the P0 server and extend the exact same map-set sessions.
// Keep this accessor narrow instead of exposing the registry itself.
export function getEpisodeSession(id) {
  return getSession(id);
}

async function beginEpisodeSession({ maps } = {}) {
  if (sessions.size >= MAX_EPISODE_SESSIONS) throw new Error(`Episode session limit ${MAX_EPISODE_SESSIONS} reached; restart the MCP process to clear old sessions`);
  const bytes = await readFile(SOURCE_PATH);
  const id = `episode-${String(nextSessionId++).padStart(4, '0')}`;
  const workspace = new EpisodeWorkspace(bytes, maps?.length ? maps : DEFAULT_EPISODE_MAPS, path.basename(SOURCE_PATH));
  const session = { id, workspace, createdAt: new Date().toISOString() };
  sessions.set(id, session);
  return { id, createdAt: session.createdAt, ...workspace.summary() };
}

function sessionView(session) {
  return { id: session.id, createdAt: session.createdAt, ...session.workspace.summary() };
}

const mapName = z.string().regex(/^(?:E[1-9]M[1-9]|MAP\d\d)$/i);
const genericEdit = z.record(z.string(), z.unknown());

export function createMcpServer() {
  const server = geometryModule.createMcpServer();

  server.registerTool('doom_p0_status', {
    title: 'Read DOOM P0 authoring status',
    description: 'Read P0 full-topology validation, atomic episode authoring and multi-map session status.',
    inputSchema: z.object({}), annotations: { readOnlyHint: true }
  }, async () => jsonResult({
    version: VERSION,
    episodeWorkspaceVersion: EPISODE_WORKSPACE_VERSION,
    sourcePath: SOURCE_PATH,
    defaultMaps: DEFAULT_EPISODE_MAPS,
    sessions: [...sessions.values()].map(sessionView)
  }));

  server.registerTool('doom_begin_episode_session', {
    title: 'Begin multi-map DOOM episode authoring session',
    description: 'Load a map set from the configured IWAD/PWAD source. Defaults to E1M1 through E1M8 and keeps all maps in one transactional authoring workspace.',
    inputSchema: z.object({ maps: z.array(mapName).min(1).max(32).optional() }),
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async args => { try { return jsonResult(await beginEpisodeSession(args)); } catch (error) { return toolError(error); } });

  server.registerTool('doom_get_episode_session', {
    title: 'Inspect DOOM episode authoring session',
    description: 'Read map-set revision, transaction state and per-map geometry/THINGS summaries.',
    inputSchema: z.object({ sessionId: z.string() }), annotations: { readOnlyHint: true }
  }, async ({ sessionId }) => { try { return jsonResult(sessionView(getSession(sessionId))); } catch (error) { return toolError(error); } });

  server.registerTool('doom_get_episode_map', {
    title: 'Inspect one map in an episode session',
    description: 'Read vertices, linedefs, sectors and installed P1 THINGS data for one map in a multi-map episode workspace.',
    inputSchema: z.object({
      sessionId: z.string(), map: mapName,
      vertexLimit: z.number().int().min(1).max(4096).optional(),
      lineLimit: z.number().int().min(1).max(4096).optional(),
      sectorLimit: z.number().int().min(1).max(1024).optional(),
      thingLimit: z.number().int().min(1).max(4096).optional()
    }), annotations: { readOnlyHint: true }
  }, async ({ sessionId, map, ...limits }) => {
    try { return jsonResult(getSession(sessionId).workspace.inspectMap(map, limits)); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('doom_validate_episode', {
    title: 'Validate every map in a DOOM episode workspace',
    description: 'Run installed deterministic validators across the full map set, including P0 topology and P1 THINGS validation when enabled.',
    inputSchema: z.object({ sessionId: z.string() }), annotations: { readOnlyHint: true }
  }, async ({ sessionId }) => {
    try { return jsonResult(getSession(sessionId).workspace.validate()); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('doom_begin_transaction', {
    title: 'Begin atomic multi-map DOOM transaction',
    description: 'Snapshot the entire episode workspace before a batch of edits. Any edit failure rolls the whole map set back automatically.',
    inputSchema: z.object({ sessionId: z.string(), label: z.string().max(160).optional() }),
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ sessionId, label }) => {
    try { return jsonResult(getSession(sessionId).workspace.beginTransaction(label)); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('doom_apply_transaction_edits', {
    title: 'Apply atomic DOOM episode edits',
    description: 'Apply up to 128 edits across maps in the active transaction. P0 structural edit types remain supported; P1 adds thing_add, thing_move, thing_update and thing_delete when the THINGS authoring layer is installed.',
    inputSchema: z.object({ sessionId: z.string(), edits: z.array(genericEdit).min(1).max(128) }),
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ sessionId, edits }) => {
    try { return jsonResult(getSession(sessionId).workspace.applyEdits(edits)); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('doom_validate_transaction', {
    title: 'Validate active DOOM episode transaction',
    description: 'Validate only maps touched by the active transaction before commit.',
    inputSchema: z.object({ sessionId: z.string() }), annotations: { readOnlyHint: true }
  }, async ({ sessionId }) => {
    try { return jsonResult(getSession(sessionId).workspace.validate({ touchedOnly: true })); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('doom_commit_transaction', {
    title: 'Commit atomic DOOM episode transaction',
    description: 'Commit the active transaction only if every touched map passes installed deterministic validation. Invalid transactions stay open for inspection or rollback.',
    inputSchema: z.object({ sessionId: z.string() }), annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ sessionId }) => {
    try { return jsonResult(getSession(sessionId).workspace.commitTransaction()); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('doom_rollback_transaction', {
    title: 'Rollback atomic DOOM episode transaction',
    description: 'Restore every map to the exact snapshot taken at transaction start.',
    inputSchema: z.object({ sessionId: z.string() }), annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ sessionId }) => {
    try { return jsonResult(getSession(sessionId).workspace.rollbackTransaction()); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('doom_build_episode', {
    title: 'Build a verified multi-map DOOM episode PWAD',
    description: 'Validate and rebuild every map in the session with pinned ZDBSP WASM, combine them into one PWAD and save it in the shared MCP exports directory.',
    inputSchema: z.object({ sessionId: z.string(), filename: z.string().min(1).max(80).optional() }),
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, async ({ sessionId, filename }) => {
    try {
      const session = getSession(sessionId);
      const safe = safeFilename(filename, `${session.id}-episode.wad`);
      const candidate = await session.workspace.build({ filename: safe });
      await mkdir(EXPORT_DIR, { recursive: true });
      await writeFile(exportPath(safe), candidate.bytes);
      return jsonResult({
        sessionId: session.id,
        candidate: candidate.index,
        filename: safe,
        bytes: candidate.bytes.length,
        revision: candidate.revision,
        maps: candidate.maps,
        next: `Use doom_load_pwad with ${safe}, then doom_warp to requested maps for runtime playtest.`
      });
    } catch (error) { return toolError(error); }
  });

  server.registerTool('doom_restore_episode_baseline', {
    title: 'Restore episode authoring baseline',
    description: 'Discard committed workspace edits and restore all maps to the source WAD baseline.',
    inputSchema: z.object({ sessionId: z.string() }), annotations: { destructiveHint: true, idempotentHint: false }
  }, async ({ sessionId }) => {
    try { return jsonResult(getSession(sessionId).workspace.restoreBaseline()); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('doom_restore_episode_candidate', {
    title: 'Restore a built episode candidate',
    description: 'Restore the editable map set from one previously built multi-map candidate.',
    inputSchema: z.object({ sessionId: z.string(), candidate: z.number().int().min(1).max(12) }), annotations: { destructiveHint: true }
  }, async ({ sessionId, candidate }) => {
    try { return jsonResult(getSession(sessionId).workspace.restoreCandidate(candidate)); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('doom_finalize_episode', {
    title: 'Finalize a built DOOM episode candidate',
    description: 'Copy a verified built episode candidate to a stable final PWAD filename without rebuilding it.',
    inputSchema: z.object({ sessionId: z.string(), candidate: z.number().int().min(1).max(12), filename: z.string().min(1).max(80).optional() }),
    annotations: { destructiveHint: true, idempotentHint: false }
  }, async ({ sessionId, candidate, filename }) => {
    try {
      const session = getSession(sessionId);
      const item = session.workspace.candidates.find(entry => entry.index === candidate);
      if (!item) throw new Error(`Unknown episode candidate ${candidate}`);
      const source = exportPath(safeFilename(item.filename));
      const finalName = safeFilename(filename, `${session.id}-final.wad`);
      await mkdir(EXPORT_DIR, { recursive: true });
      await copyFile(source, exportPath(finalName));
      return jsonResult({ sessionId: session.id, candidate, filename: finalName, bytes: item.bytes.length, maps: item.maps.map(entry => entry.map) });
    } catch (error) { return toolError(error); }
  });

  return server;
}

function isDirectExecution() {
  return process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
}

if (isDirectExecution()) {
  startAuthoringBridge();
  startPlaytestBridge();
  startOrchestrationBridge();
  startCheatBridge();
  geometryModule.startGeometryBridge();
  void serveStdio(createMcpServer);
  console.error(`DOOM MCP ${VERSION}: P0 full topology + atomic episode authoring ready`);
}
