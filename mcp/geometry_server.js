import http from 'node:http';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { WebSocket, WebSocketServer } from 'ws';
import * as z from 'zod/v4';

import { startBridge as startAuthoringBridge } from './server.js';
import { bindHttp } from './http_bind.js';
import { startPlaytestBridge } from './playtest_server.js';
import { startOrchestrationBridge } from './v1_server.js';
import { createMcpServer as createV11Server, startCheatBridge } from './cheat_server.js';
import { GeometryWorkspace, GEOMETRY_VERSION, inspectBuiltMap } from './geometry.js';
import { nodeBuilderStatus, prepareNodeBuilder, rebuildVanillaNodes } from './nodebuilder.js';

const HOST = '127.0.0.1';
const PORT = Number(process.env.DOOM_GEOMETRY_PORT || 3781);
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_DIR = path.resolve(process.env.DOOM_MCP_EXPORT_DIR || path.join(MODULE_DIR, 'exports'));
const VERSION = '2.0.0';
const MAX_SESSIONS = 8;
const MAX_CANDIDATES = 12;

let httpServer = null;
let wss = null;
let browserSocket = null;
let requestCounter = 1;
let sessionCounter = 1;
const pending = new Map();
const sessions = new Map();

function jsonResult(value) { return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }; }
function toolError(error) { return { isError: true, content: [{ type: 'text', text: String(error?.message || error) }] }; }
function connected() { return browserSocket?.readyState === WebSocket.OPEN; }

function geometryCall(method, params = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (!connected()) return reject(new Error('No DOOM geometry browser bridge is connected. Open http://127.0.0.1:3777/, click CLICK TO START, then retry.'));
    const id = `geometry-${Date.now()}-${requestCounter++}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Geometry browser bridge timed out while calling ${method}`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    browserSocket.send(JSON.stringify({ id, method, params }));
  });
}

function settle(message) {
  const entry = message?.id && pending.get(message.id);
  if (!entry) return false;
  pending.delete(message.id); clearTimeout(entry.timer);
  if (message.ok) entry.resolve(message.result); else entry.reject(new Error(message.error || 'Unknown geometry bridge error'));
  return true;
}

function rejectAll(reason) {
  for (const [id, entry] of pending) { clearTimeout(entry.timer); entry.reject(new Error(reason)); pending.delete(id); }
}

export function startGeometryBridge() {
  if (httpServer) return httpServer;
  httpServer = http.createServer((req, res) => {
    if (req.url === '/health') {
      const body = JSON.stringify({ ok: true, version: VERSION, browserConnected: Boolean(connected()), sessions: sessions.size });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(body); return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('DOOM geometry bridge');
  });
  wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    let pathname;
    try { pathname = new URL(req.url || '/', `http://${HOST}:${PORT}`).pathname; } catch { socket.destroy(); return; }
    if (pathname !== '/geometry') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', ws => {
    if (browserSocket && browserSocket !== ws) { try { browserSocket.close(1012, 'Replaced by newer geometry browser'); } catch {} }
    browserSocket = ws;
    console.error('DOOM MCP: geometry bridge connected');
    ws.on('message', raw => { try { const msg = JSON.parse(String(raw)); if (!settle(msg) && msg?.event) console.error(`DOOM MCP: ${msg.event}`); } catch {} });
    ws.on('close', () => { if (browserSocket === ws) browserSocket = null; rejectAll('DOOM geometry browser disconnected'); });
  });
  bindHttp(httpServer, {
    host: HOST,
    port: PORT,
    label: `geometry bridge at ws://${HOST}:${PORT}/geometry`
  });
  return httpServer;
}

function safeFilename(requested, fallback) {
  const raw = String(requested || fallback).trim() || fallback;
  const base = raw.toLowerCase().endsWith('.wad') ? raw : `${raw}.wad`;
  const safe = base.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '');
  if (!safe) throw new Error('Invalid WAD filename');
  return safe;
}

function exportPath(filename) {
  const resolved = path.resolve(EXPORT_DIR, filename);
  if (path.dirname(resolved) !== EXPORT_DIR) throw new Error('Geometry artifact path escapes export directory');
  return resolved;
}

function getSession(id) {
  const session = sessions.get(String(id));
  if (!session) throw new Error(`Unknown geometry session ${id}`);
  return session;
}

function sessionView(session) {
  return {
    id: session.id, map: session.mapName, baselineFilename: session.baselineFilename,
    activeCandidate: session.activeCandidate,
    workspace: session.workspace.summary(),
    candidates: session.candidates.map(c => ({ index: c.index, filename: c.filename, bytes: c.bytes.length, validation: c.validation, built: c.built }))
  };
}

async function beginSession({ adoptPendingChanges = false } = {}) {
  if (sessions.size >= MAX_SESSIONS) throw new Error(`Geometry session limit ${MAX_SESSIONS} reached; restart the MCP process to clear old sessions`);
  const id = `geometry-${String(sessionCounter++).padStart(4, '0')}`;
  const snapshot = await geometryCall('geometry_snapshot', { filename: `${id}-baseline.wad` }, 20000);
  if (!snapshot?.state?.ready) throw new Error('DOOM game is not in a playable map');
  if (Number(snapshot.pendingCount || 0) > 0 && !adoptPendingChanges) {
    throw new Error(`There are ${snapshot.pendingCount} pending non-geometry authoring changes. Export/reload them first or pass adoptPendingChanges=true to make them part of the geometry baseline.`);
  }
  const mapName = `E${snapshot.state.episode}M${snapshot.state.map}`;
  const bytes = Buffer.from(snapshot.artifact.base64, 'base64');
  const baselineFilename = `${id}-baseline.wad`;
  await mkdir(EXPORT_DIR, { recursive: true }); await writeFile(exportPath(baselineFilename), bytes);
  const session = {
    id, mapName, baselineFilename, baselineBytes: bytes, workspace: new GeometryWorkspace(bytes, mapName),
    candidates: [], activeCandidate: null, createdAt: new Date().toISOString()
  };
  sessions.set(id, session);
  return sessionView(session);
}

async function buildCandidate(session, { filename, apply = true } = {}) {
  if (session.candidates.length >= MAX_CANDIDATES) throw new Error(`Geometry candidate limit ${MAX_CANDIDATES} reached`);
  const validation = session.workspace.validate();
  if (!validation.ok) throw new Error(`Geometry validation failed: ${validation.errors.join('; ')}`);
  const preNode = session.workspace.preNodeWad();
  const rebuilt = await rebuildVanillaNodes(preNode, session.mapName);
  const built = inspectBuiltMap(rebuilt.bytes, session.mapName);
  if (!built.ok) throw new Error(`Built PWAD failed derived-lump verification: ${JSON.stringify(built)}`);
  const index = session.candidates.length + 1;
  const outName = safeFilename(filename, `${session.id}-candidate-${String(index).padStart(2, '0')}.wad`);
  await mkdir(EXPORT_DIR, { recursive: true }); await writeFile(exportPath(outName), rebuilt.bytes);
  const candidate = { index, filename: outName, bytes: rebuilt.bytes, validation, built, builder: rebuilt.builder, log: rebuilt.log, warnings: rebuilt.warnings, createdAt: new Date().toISOString() };
  session.candidates.push(candidate);
  if (apply) {
    const load = await geometryCall('geometry_load', { filename: outName, base64: rebuilt.bytes.toString('base64') }, 30000);
    candidate.load = load; session.activeCandidate = index;
    // A successful loaded candidate is now the structural baseline for further edits.
    session.workspace = new GeometryWorkspace(rebuilt.bytes, session.mapName);
  }
  return { session: sessionView(session), candidate: { ...candidate, bytes: candidate.bytes.length } };
}

async function restoreBytes(session, bytes, filename, candidateIndex = null) {
  const load = await geometryCall('geometry_load', { filename, base64: Buffer.from(bytes).toString('base64') }, 30000);
  session.workspace = new GeometryWorkspace(bytes, session.mapName); session.activeCandidate = candidateIndex;
  return { load, session: sessionView(session) };
}

const wadName = z.string().min(1).max(80).optional();
const indexNumber = z.number().int().min(0).max(65534);
const coord = z.number().int().min(-32768).max(32767);

export function createMcpServer() {
  const server = createV11Server();

  server.registerTool('doom_geometry_status', {
    title: 'Read DOOM structural geometry status',
    description: 'Read v2 geometry bridge, node-builder cache and active geometry-session status.',
    inputSchema: z.object({}), annotations: { readOnlyHint: true }
  }, async () => jsonResult({ version: VERSION, geometryVersion: GEOMETRY_VERSION, browserConnected: Boolean(connected()), nodeBuilder: await nodeBuilderStatus(), sessions: [...sessions.values()].map(sessionView) }));

  server.registerTool('doom_geometry_prepare_nodebuilder', {
    title: 'Prepare pinned ZDBSP WASM',
    description: 'Download and Git-blob-verify the immutable pinned ZDBSP WASM wrapper artifacts into the local MCP cache. Needed once per machine/cache.',
    inputSchema: z.object({}), annotations: { idempotentHint: true, openWorldHint: true }
  }, async () => { try { return jsonResult(await prepareNodeBuilder()); } catch (e) { return toolError(e); } });

  server.registerTool('doom_begin_geometry_session', {
    title: 'Begin structural DOOM geometry session',
    description: 'Snapshot the current playable map as a baseline PWAD and parse VERTEXES/LINEDEFS/SIDEDEFS/SECTORS into a bounded geometry workspace.',
    inputSchema: z.object({ adoptPendingChanges: z.boolean().optional() }), annotations: { destructiveHint: false, idempotentHint: false }
  }, async (args) => { try { return jsonResult(await beginSession(args)); } catch (e) { return toolError(e); } });

  server.registerTool('doom_get_geometry', {
    title: 'Inspect DOOM geometry workspace',
    description: 'Inspect structural vertices, linedefs and sectors in a geometry session.',
    inputSchema: z.object({ sessionId: z.string(), vertexLimit: z.number().int().min(1).max(4096).optional(), lineLimit: z.number().int().min(1).max(4096).optional(), sectorLimit: z.number().int().min(1).max(1024).optional() }), annotations: { readOnlyHint: true }
  }, async ({ sessionId, ...limits }) => { try { return jsonResult(getSession(sessionId).workspace.inspect(limits)); } catch (e) { return toolError(e); } });

  server.registerTool('doom_geometry_validate', {
    title: 'Validate DOOM geometry workspace',
    description: 'Validate index ranges, zero-length lines, side/sector references, new-sector boundary closure and new-line crossings before node rebuild.',
    inputSchema: z.object({ sessionId: z.string() }), annotations: { readOnlyHint: true }
  }, async ({ sessionId }) => { try { return jsonResult(getSession(sessionId).workspace.validate()); } catch (e) { return toolError(e); } });

  server.registerTool('doom_geometry_set_sector_heights', {
    title: 'Set structural sector floor/ceiling heights',
    description: 'Change floor and/or ceiling height in the geometry workspace. This is persistent structural metadata and is rebuilt into a PWAD on apply.',
    inputSchema: z.object({ sessionId: z.string(), sector: indexNumber, floor: coord.optional(), ceiling: coord.optional() }), annotations: { destructiveHint: true }
  }, async ({ sessionId, ...args }) => { try { return jsonResult(getSession(sessionId).workspace.setSectorHeights(args)); } catch (e) { return toolError(e); } });

  server.registerTool('doom_geometry_move_vertex', {
    title: 'Move a DOOM map vertex',
    description: 'Move an existing VERTEXES entry inside the in-memory workspace. Apply/rebuild is required before LinuxDOOM sees it.',
    inputSchema: z.object({ sessionId: z.string(), vertex: indexNumber, x: coord, y: coord }), annotations: { destructiveHint: true }
  }, async ({ sessionId, ...args }) => { try { return jsonResult(getSession(sessionId).workspace.moveVertex(args)); } catch (e) { return toolError(e); } });

  server.registerTool('doom_geometry_add_vertex', {
    title: 'Add a DOOM map vertex', description: 'Add a low-level VERTEXES primitive to the geometry workspace.',
    inputSchema: z.object({ sessionId: z.string(), x: coord, y: coord }), annotations: { destructiveHint: true }
  }, async ({ sessionId, ...args }) => { try { return jsonResult(getSession(sessionId).workspace.addVertex(args)); } catch (e) { return toolError(e); } });

  server.registerTool('doom_geometry_add_sector', {
    title: 'Add a DOOM sector primitive', description: 'Add a low-level SECTORS primitive. Prefer semantic room/corridor tools unless precise topology control is required.',
    inputSchema: z.object({ sessionId: z.string(), copyFrom: indexNumber.optional(), floor: coord.optional(), ceiling: coord.optional(), floorFlat: z.string().max(8).optional(), ceilingFlat: z.string().max(8).optional(), light: z.number().int().min(0).max(255).optional(), special: z.number().int().min(0).max(65534).optional(), tag: z.number().int().min(0).max(65534).optional() }), annotations: { destructiveHint: true }
  }, async ({ sessionId, ...args }) => { try { return jsonResult(getSession(sessionId).workspace.addSector(args)); } catch (e) { return toolError(e); } });

  server.registerTool('doom_geometry_add_sidedef', {
    title: 'Add a DOOM sidedef primitive', description: 'Add a low-level SIDEDEFS primitive referencing an existing sector.',
    inputSchema: z.object({ sessionId: z.string(), sector: indexNumber, xOffset: coord.optional(), yOffset: coord.optional(), upper: z.string().max(8).optional(), lower: z.string().max(8).optional(), middle: z.string().max(8).optional() }), annotations: { destructiveHint: true }
  }, async ({ sessionId, ...args }) => { try { return jsonResult(getSession(sessionId).workspace.addSidedef(args)); } catch (e) { return toolError(e); } });

  server.registerTool('doom_geometry_add_linedef', {
    title: 'Add a DOOM linedef primitive', description: 'Add a low-level LINEDEFS primitive referencing existing vertices/sidedefs.',
    inputSchema: z.object({ sessionId: z.string(), v1: indexNumber, v2: indexNumber, right: indexNumber.optional(), left: indexNumber.optional(), flags: z.number().int().min(0).max(65535).optional(), special: z.number().int().min(0).max(65534).optional(), tag: z.number().int().min(0).max(65534).optional() }), annotations: { destructiveHint: true }
  }, async ({ sessionId, ...args }) => { try { return jsonResult(getSession(sessionId).workspace.addLinedef(args)); } catch (e) { return toolError(e); } });

  server.registerTool('doom_geometry_add_room', {
    title: 'Extrude a new DOOM room from a wall',
    description: 'Convert a one-sided wall into an open two-sided portal and extrude a rectangular room outward from its left/outside side. Uses the existing wall span and copies valid source-sector materials.',
    inputSchema: z.object({ sessionId: z.string(), line: indexNumber, depth: z.number().int().min(32).max(2048), floor: coord.optional(), ceiling: coord.optional(), light: z.number().int().min(0).max(255).optional() }), annotations: { destructiveHint: true }
  }, async ({ sessionId, ...args }) => { try { return jsonResult(getSession(sessionId).workspace.addRoomFromWall(args)); } catch (e) { return toolError(e); } });

  server.registerTool('doom_geometry_resize_room', {
    title: 'Resize a newly extruded room depth',
    description: 'Resize the depth of a room created in the current unapplied geometry workspace.',
    inputSchema: z.object({ sessionId: z.string(), roomId: z.string(), depth: z.number().int().min(32).max(2048) }), annotations: { destructiveHint: true }
  }, async ({ sessionId, ...args }) => { try { return jsonResult(getSession(sessionId).workspace.resizeCreatedRoom(args)); } catch (e) { return toolError(e); } });

  server.registerTool('doom_geometry_delete_room', {
    title: 'Delete the latest generated room',
    description: 'Undo a generated room while it is still the latest geometry edit in the current workspace.',
    inputSchema: z.object({ sessionId: z.string(), roomId: z.string() }), annotations: { destructiveHint: true }
  }, async ({ sessionId, ...args }) => { try { return jsonResult(getSession(sessionId).workspace.deleteCreatedRoom(args)); } catch (e) { return toolError(e); } });

  server.registerTool('doom_geometry_add_corridor', {
    title: 'Connect two sectors with a corridor',
    description: 'Connect two facing, one-sided, parallel walls of approximately equal length. The two walls become portals and a new corridor sector plus side walls is created between them.',
    inputSchema: z.object({ sessionId: z.string(), lineA: indexNumber, lineB: indexNumber, light: z.number().int().min(0).max(255).optional() }), annotations: { destructiveHint: true }
  }, async ({ sessionId, ...args }) => { try { return jsonResult(getSession(sessionId).workspace.addCorridorBetweenWalls(args)); } catch (e) { return toolError(e); } });

  server.registerTool('doom_geometry_undo', {
    title: 'Undo last geometry edit', description: 'Undo exactly one in-memory geometry edit before rebuild/apply.',
    inputSchema: z.object({ sessionId: z.string() }), annotations: { destructiveHint: true }
  }, async ({ sessionId }) => { try { return jsonResult(getSession(sessionId).workspace.undo()); } catch (e) { return toolError(e); } });

  server.registerTool('doom_geometry_build', {
    title: 'Build and optionally apply structural DOOM geometry',
    description: 'Validate the geometry IR, write structural map lumps, rebuild vanilla-compatible SEGS/SSECTORS/NODES/BLOCKMAP and full zero REJECT through pinned ZDBSP WASM, verify the result, save a candidate PWAD, and optionally reload it in LinuxDOOM.',
    inputSchema: z.object({ sessionId: z.string(), filename: wadName, apply: z.boolean().optional() }), annotations: { destructiveHint: true, openWorldHint: true }
  }, async ({ sessionId, filename, apply = true }) => { try { return jsonResult(await buildCandidate(getSession(sessionId), { filename, apply })); } catch (e) { return toolError(e); } });

  server.registerTool('doom_geometry_restore_baseline', {
    title: 'Restore geometry-session baseline', description: 'Reload the baseline PWAD and reset the geometry workspace to it.',
    inputSchema: z.object({ sessionId: z.string() }), annotations: { destructiveHint: true }
  }, async ({ sessionId }) => { try { const s = getSession(sessionId); return jsonResult(await restoreBytes(s, s.baselineBytes, s.baselineFilename, null)); } catch (e) { return toolError(e); } });

  server.registerTool('doom_geometry_restore_candidate', {
    title: 'Restore a structural geometry candidate', description: 'Reload a previously built structural candidate and reset the workspace to that candidate.',
    inputSchema: z.object({ sessionId: z.string(), candidate: z.number().int().min(1).max(MAX_CANDIDATES) }), annotations: { destructiveHint: true }
  }, async ({ sessionId, candidate }) => { try { const s = getSession(sessionId); const c = s.candidates.find(x => x.index === candidate); if (!c) throw new Error(`Unknown candidate ${candidate}`); return jsonResult(await restoreBytes(s, c.bytes, c.filename, c.index)); } catch (e) { return toolError(e); } });

  server.registerTool('doom_geometry_finalize', {
    title: 'Finalize a geometry candidate PWAD',
    description: 'Copy a selected built/verified candidate to a final ordinary PWAD filename and load that same candidate in LinuxDOOM.',
    inputSchema: z.object({ sessionId: z.string(), candidate: z.number().int().min(1).max(MAX_CANDIDATES), filename: z.string().min(1).max(80) }), annotations: { destructiveHint: true }
  }, async ({ sessionId, candidate, filename }) => {
    try {
      const s = getSession(sessionId); const c = s.candidates.find(x => x.index === candidate); if (!c) throw new Error(`Unknown candidate ${candidate}`);
      const finalName = safeFilename(filename, `${s.id}-final.wad`); await mkdir(EXPORT_DIR, { recursive: true });
      await copyFile(exportPath(c.filename), exportPath(finalName));
      const restored = await restoreBytes(s, c.bytes, finalName, c.index);
      return jsonResult({ filename: finalName, candidate: c.index, bytes: c.bytes.length, built: c.built, restored });
    } catch (e) { return toolError(e); }
  });

  return server;
}

function isDirectExecution() { return process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url; }

if (isDirectExecution()) {
  startAuthoringBridge(); startPlaytestBridge(); startOrchestrationBridge(); startCheatBridge(); startGeometryBridge();
  void serveStdio(createMcpServer);
  console.error(`DOOM MCP ${VERSION}: closed-loop authoring + cheats + structural geometry ready`);
}
