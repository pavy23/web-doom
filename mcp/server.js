import http from 'node:http';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { WebSocket, WebSocketServer } from 'ws';
import * as z from 'zod/v4';

const HOST = '127.0.0.1';
const PORT = Number(process.env.DOOM_MCP_PORT || 3777);
const UPSTREAM = new URL(process.env.DOOM_MCP_UPSTREAM || 'https://pavy23.github.io/web-doom/direct/');
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_DIR = path.resolve(process.env.DOOM_MCP_EXPORT_DIR || path.join(MODULE_DIR, 'exports'));
const VERSION = '0.5.0';

let browserSocket = null;
let nextRequestId = 1;
const pending = new Map();
let httpServer = null;
let wss = null;

function jsonResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function toolError(error) {
  return { isError: true, content: [{ type: 'text', text: String(error?.message || error) }] };
}

function bridgeConnected() {
  return browserSocket && browserSocket.readyState === WebSocket.OPEN;
}

function bridgeCall(method, params = {}, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (!bridgeConnected()) {
      reject(new Error(`No DOOM browser is connected. Open http://${HOST}:${PORT}/, click CLICK TO START, then retry.`));
      return;
    }
    const id = `mcp-${Date.now()}-${nextRequestId++}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`DOOM bridge timed out while calling ${method}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    browserSocket.send(JSON.stringify({ id, method, params }));
  });
}

function settlePending(message) {
  if (!message || !message.id || !pending.has(message.id)) return false;
  const entry = pending.get(message.id);
  pending.delete(message.id);
  clearTimeout(entry.timer);
  if (message.ok) entry.resolve(message.result);
  else entry.reject(new Error(message.error || 'Unknown DOOM bridge error'));
  return true;
}

function rejectAllPending(reason) {
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
    pending.delete(id);
  }
}

async function proxyPublishedGame(req, res) {
  try {
    const requestUrl = new URL(req.url || '/', `http://${HOST}:${PORT}`);
    if (requestUrl.pathname === '/health') {
      const body = JSON.stringify({
        ok: true,
        version: VERSION,
        browserConnected: Boolean(bridgeConnected()),
        playUrl: `http://${HOST}:${PORT}/`,
        upstream: UPSTREAM.href,
        exportDir: EXPORT_DIR
      });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
      return;
    }

    const relative = requestUrl.pathname === '/' ? '' : requestUrl.pathname.replace(/^\//, '');
    const upstreamUrl = new URL(relative, UPSTREAM);
    upstreamUrl.search = requestUrl.search;
    const upstreamResponse = await fetch(upstreamUrl, {
      redirect: 'follow', cache: 'no-store', headers: { 'user-agent': `web-doom-mcp/${VERSION}` }
    });
    res.statusCode = upstreamResponse.status;
    const contentType = upstreamResponse.headers.get('content-type');
    if (contentType) res.setHeader('content-type', contentType);
    res.setHeader('cache-control', 'no-store');
    if (!upstreamResponse.body) { res.end(); return; }
    Readable.fromWeb(upstreamResponse.body).pipe(res);
  } catch (error) {
    res.statusCode = 502;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end(`DOOM MCP proxy error: ${error?.message || error}`);
  }
}

export function startBridge() {
  if (httpServer) return httpServer;
  httpServer = http.createServer(proxyPublishedGame);
  wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    let pathname = '/';
    try { pathname = new URL(req.url || '/', `http://${HOST}:${PORT}`).pathname; }
    catch { socket.destroy(); return; }
    if (pathname !== '/control') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', ws => {
    if (browserSocket && browserSocket !== ws) {
      try { browserSocket.close(1012, 'Replaced by a newer DOOM browser'); } catch {}
    }
    browserSocket = ws;
    console.error('DOOM MCP: browser bridge connected');
    ws.on('message', raw => {
      try {
        const message = JSON.parse(String(raw));
        if (settlePending(message)) return;
        if (message?.event) console.error(`DOOM MCP: browser event ${message.event}`);
      } catch (error) {
        console.error(`DOOM MCP: bad browser message: ${error?.message || error}`);
      }
    });
    ws.on('close', () => {
      if (browserSocket === ws) browserSocket = null;
      rejectAllPending('DOOM browser bridge disconnected');
      console.error('DOOM MCP: browser bridge disconnected');
    });
  });
  httpServer.listen(PORT, HOST, () => {
    console.error(`DOOM MCP: local game bridge at http://${HOST}:${PORT}/`);
    console.error(`DOOM MCP: PWAD exports at ${EXPORT_DIR}`);
  });
  return httpServer;
}

const ammoTypes = { bullets: 0, shells: 1, cells: 2, rockets: 3 };
const spawnableEnemyTypes = ['zombieman', 'shotgun_guy', 'imp', 'demon', 'spectre', 'baron_of_hell'];
const linedefPresets = [
  'none',
  'manual_raise', 'manual_open',
  'switch_raise_once', 'switch_open_once', 'switch_close_once',
  'button_raise', 'button_open', 'button_close',
  'manual_blazing_raise', 'manual_blazing_open',
  'switch_blazing_raise_once', 'switch_blazing_open_once', 'switch_blazing_close_once',
  'button_blazing_raise', 'button_blazing_open', 'button_blazing_close'
];

function filteredEnemies(state, { visibleOnly = false, maxDistance, limit = 32 } = {}) {
  if (!state?.ready || !Array.isArray(state.enemies)) return [];
  return state.enemies
    .filter(enemy => !visibleOnly || enemy.visible)
    .filter(enemy => maxDistance == null || enemy.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit);
}

function filteredSectors(state, { maxDistance, limit = 64 } = {}) {
  if (!state?.ready || !Array.isArray(state.sectors)) return [];
  return state.sectors
    .filter(sector => maxDistance == null || sector.distance <= maxDistance)
    .sort((a, b) => a.current !== b.current ? (a.current ? -1 : 1) : a.distance - b.distance)
    .slice(0, limit);
}

function filteredLinedefs(state, { doorsOnly = false, specialsOnly = false, limit = 64 } = {}) {
  if (!state?.ready || !Array.isArray(state.lines)) return [];
  return state.lines
    .filter(line => !doorsOnly || line.doorLike)
    .filter(line => !specialsOnly || Number(line.special) !== 0)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit);
}

function safeExportFilename(requested, episode, mapNumber) {
  const fallback = `ai_E${episode}M${mapNumber}.wad`;
  const raw = String(requested || fallback).trim() || fallback;
  const base = raw.toLowerCase().endsWith('.wad') ? raw : `${raw}.wad`;
  const safe = base.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '');
  return safe || fallback;
}

function safeExistingWadFilename(requested) {
  const raw = String(requested || '').trim();
  if (!raw) throw new Error('A PWAD filename is required');
  if (raw !== path.basename(raw)) throw new Error('PWAD filename must not contain a path');
  if (!raw.toLowerCase().endsWith('.wad')) throw new Error('PWAD filename must end in .wad');
  const safe = raw.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '');
  if (!safe || safe !== raw) throw new Error('PWAD filename contains unsupported characters');
  return safe;
}

function localExportPath(filename) {
  const resolved = path.resolve(EXPORT_DIR, filename);
  if (path.dirname(resolved) !== EXPORT_DIR) throw new Error('PWAD path escapes the export directory');
  return resolved;
}

function inspectPwad(bytes) {
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
    bytes: bytes.length, lumpCount, directoryOffset, lumps,
    mapMarkers: lumps.map(lump => lump.name).filter(name => /^E[1-9]M[1-9]$/.test(name))
  };
}

async function getCombinedChangeset() {
  const [base, linedefs] = await Promise.all([
    bridgeCall('get_changeset'),
    bridgeCall('get_linedef_changes')
  ]);
  if (!base?.ready) return base;
  return {
    ...base,
    linedefCount: Number(linedefs?.count || 0),
    linedefs: Array.isArray(linedefs?.linedefs) ? linedefs.linedefs : []
  };
}

function hasAuthoringChanges(changeset) {
  return Boolean(changeset?.ready) && (
    Number(changeset.sectorLightCount || 0) > 0
    || Number(changeset.spawnCount || 0) > 0
    || Number(changeset.removeCount || 0) > 0
    || Number(changeset.linedefCount || 0) > 0
  );
}

async function listLocalExports() {
  await mkdir(EXPORT_DIR, { recursive: true });
  const entries = await readdir(EXPORT_DIR, { withFileTypes: true });
  const rows = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.wad')) continue;
    const info = await stat(localExportPath(entry.name));
    rows.push({ filename: entry.name, bytes: info.size, modified: info.mtime.toISOString() });
  }
  rows.sort((a, b) => b.modified.localeCompare(a.modified));
  return rows;
}

export function createMcpServer() {
  const server = new McpServer(
    { name: 'web-doom-control', version: VERSION },
    { instructions: 'Use inspection tools before mutation. Actor, sector-light and supported linedef special/tag edits are persistent authoring changes. Export them as PWAD, load the result back as the new baseline, then continue iterating. Linedef activation itself is playtest-only.' }
  );

  server.registerTool('doom_bridge_status', {
    title: 'DOOM bridge status', description: 'Check whether the local DOOM browser is connected.',
    inputSchema: z.object({}), annotations: { readOnlyHint: true }
  }, async () => jsonResult({ version: VERSION, connected: Boolean(bridgeConnected()), playUrl: `http://${HOST}:${PORT}/`, upstream: UPSTREAM.href, exportDir: EXPORT_DIR }));

  server.registerTool('doom_get_state', {
    title: 'Get live DOOM state', description: 'Read current map, player, sector and enemy state.',
    inputSchema: z.object({}), annotations: { readOnlyHint: true }
  }, async () => { try { return jsonResult(await bridgeCall('get_state')); } catch (error) { return toolError(error); } });

  server.registerTool('doom_get_enemies', {
    title: 'Query nearby DOOM enemies', description: 'Return live enemies nearest-first.',
    inputSchema: z.object({ visibleOnly: z.boolean().optional(), maxDistance: z.number().min(0).max(8192).optional(), limit: z.number().int().min(1).max(96).optional() }),
    annotations: { readOnlyHint: true }
  }, async ({ visibleOnly = false, maxDistance, limit = 32 }) => {
    try {
      const state = await bridgeCall('get_state');
      const enemies = filteredEnemies(state, { visibleOnly, maxDistance, limit });
      return jsonResult({ ready: Boolean(state?.ready), episode: state?.episode, map: state?.map, filters: { visibleOnly, maxDistance: maxDistance ?? null, limit }, count: enemies.length, enemies });
    } catch (error) { return toolError(error); }
  });

  server.registerTool('doom_get_sectors', {
    title: 'Inspect DOOM sectors', description: 'Read runtime sector floor/ceiling/light/special/tag metadata.',
    inputSchema: z.object({ maxDistance: z.number().min(0).max(32768).optional(), limit: z.number().int().min(1).max(256).optional() }),
    annotations: { readOnlyHint: true }
  }, async ({ maxDistance, limit = 64 }) => {
    try {
      const state = await bridgeCall('get_sectors', { limit: 256 });
      const sectors = filteredSectors(state, { maxDistance, limit });
      return jsonResult({ ready: Boolean(state?.ready), sectorCount: state?.sectorCount, currentSector: state?.currentSector, filters: { maxDistance: maxDistance ?? null, limit }, count: sectors.length, sectors });
    } catch (error) { return toolError(error); }
  });

  server.registerTool('doom_get_linedefs', {
    title: 'Inspect nearby DOOM linedefs and doors',
    description: 'Read nearby linedefs with vertices, sectors, flags, special/action, tag and distance. doorsOnly filters to recognized Vanilla door specials.',
    inputSchema: z.object({
      maxDistance: z.number().int().min(0).max(32768).optional(),
      doorsOnly: z.boolean().optional(),
      specialsOnly: z.boolean().optional(),
      limit: z.number().int().min(1).max(512).optional()
    }),
    annotations: { readOnlyHint: true }
  }, async ({ maxDistance = 1024, doorsOnly = false, specialsOnly = false, limit = 64 }) => {
    try {
      const state = await bridgeCall('get_linedefs', { limit: 512, maxDistance });
      const lines = filteredLinedefs(state, { doorsOnly, specialsOnly, limit });
      return jsonResult({ ready: Boolean(state?.ready), lineCount: state?.lineCount, pendingChanges: state?.changeCount, filters: { maxDistance, doorsOnly, specialsOnly, limit }, count: lines.length, lines });
    } catch (error) { return toolError(error); }
  });

  server.registerTool('doom_set_sector_light', {
    title: 'Set DOOM sector light', description: 'Set light 0..255 and persist it in SECTORS on PWAD export.',
    inputSchema: z.object({ sector: z.number().int().min(0).max(4095), light: z.number().int().min(0).max(255) }),
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ sector, light }) => {
    try {
      const result = await bridgeCall('set_sector_light', { sector, light });
      if (result.light < 0) throw new Error(`Engine rejected sector light edit with code ${result.light}`);
      return jsonResult({ sector, light: result.light, journaled: true });
    } catch (error) { return toolError(error); }
  });

  server.registerTool('doom_set_linedef_action', {
    title: 'Persist a safe DOOM linedef/door action',
    description: 'Change a linedef special using a bounded Vanilla door preset and optionally its sector tag. The edit is journaled and written into LINEDEFS on PWAD export.',
    inputSchema: z.object({
      index: z.number().int().min(0).max(65535),
      preset: z.enum(linedefPresets),
      tag: z.number().int().min(0).max(32767).optional()
    }),
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ index, preset, tag }) => {
    try {
      const result = await bridgeCall('set_linedef_action', { index, preset, tag: tag ?? -1 });
      if (!result?.updated) throw new Error(result?.error || 'Engine rejected linedef authoring edit');
      return jsonResult(result);
    } catch (error) { return toolError(error); }
  });

  server.registerTool('doom_activate_linedef', {
    title: 'Playtest a DOOM linedef action now',
    description: 'Invoke the selected linedef through original P_UseSpecialLine using the current player. This is a playtest action and is not itself persisted; persist behavior separately with doom_set_linedef_action.',
    inputSchema: z.object({ index: z.number().int().min(0).max(65535) }),
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ index }) => {
    try { return jsonResult(await bridgeCall('activate_linedef', { index })); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('doom_heal', {
    title: 'Heal DOOM player', description: 'Heal player up to 200. Debug-only.',
    inputSchema: z.object({ amount: z.number().int().min(1).max(200) })
  }, async ({ amount }) => {
    try { const r = await bridgeCall('heal', { amount }); if (r.health < 0) throw new Error(`Engine rejected heal with code ${r.health}`); return jsonResult(r); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('doom_give_ammo', {
    title: 'Give DOOM ammunition', description: 'Give ammunition within max limits. Debug-only.',
    inputSchema: z.object({ type: z.enum(['bullets', 'shells', 'cells', 'rockets']), amount: z.number().int().min(1).max(1000) })
  }, async ({ type, amount }) => {
    try { const r = await bridgeCall('give_ammo', { ammoType: ammoTypes[type], amount }); if (r.ammo < 0) throw new Error(`Engine rejected ammo with code ${r.ammo}`); return jsonResult({ type, ...r }); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('doom_teleport', {
    title: 'Teleport DOOM player', description: 'Collision-aware player teleport. Debug-only.',
    inputSchema: z.object({ x: z.number().int().min(-32768).max(32767), y: z.number().int().min(-32768).max(32767) })
  }, async ({ x, y }) => {
    try { const r = await bridgeCall('teleport', { x, y }); if (r.moved < 0) throw new Error(`Engine rejected teleport with code ${r.moved}`); if (!r.moved) throw new Error('Teleport destination was blocked'); return jsonResult({ x, y, moved: true }); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('doom_spawn_enemy', {
    title: 'Spawn enemies in front of player', description: 'Spawn Episode-1-safe monsters and persist successful spawns as THINGS edits.',
    inputSchema: z.object({ type: z.enum(spawnableEnemyTypes), count: z.number().int().min(1).max(8).optional(), distance: z.number().int().min(64).max(1024).optional() }),
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ type, count = 1, distance = 160 }) => {
    try {
      const r = await bridgeCall('spawn_enemy', { name: type, count, distance });
      if (r.spawned < 0) throw new Error(`Engine rejected spawn with code ${r.spawned}`);
      return jsonResult({ type, requested: count, spawned: r.spawned, rejectedByCollision: count - r.spawned, distance, journaled: r.spawned > 0 });
    } catch (error) { return toolError(error); }
  });

  server.registerTool('doom_remove_nearest_enemy', {
    title: 'Remove nearest DOOM enemy', description: 'Remove nearest live enemy and persist/cancel the corresponding THINGS edit.',
    inputSchema: z.object({ visibleOnly: z.boolean().optional(), maxDistance: z.number().int().min(0).max(8192).optional() }),
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ visibleOnly = false, maxDistance = 2048 }) => {
    try { const r = await bridgeCall('remove_nearest_enemy', { visibleOnly, maxDistance }); if (r.error) throw new Error(r.error); return jsonResult(r); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('doom_get_changeset', {
    title: 'Inspect DOOM authoring ChangeSet',
    description: 'Read persistent sector-light, actor and linedef special/tag edits accumulated since the current PWAD/IWAD baseline.',
    inputSchema: z.object({}), annotations: { readOnlyHint: true }
  }, async () => { try { return jsonResult(await getCombinedChangeset()); } catch (error) { return toolError(error); } });

  server.registerTool('doom_export_pwad', {
    title: 'Export current AI-authored map as PWAD',
    description: 'Build a current-map PWAD from baseline lumps plus persistent THINGS, SECTORS and LINEDEFS edits.',
    inputSchema: z.object({ filename: z.string().min(1).max(120).optional() }),
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ filename } = {}) => {
    try {
      const changeset = await getCombinedChangeset();
      if (!changeset?.ready) throw new Error('DOOM map is not ready for export');
      const safeName = safeExportFilename(filename, changeset.episode, changeset.map);
      const exported = await bridgeCall('export_pwad', { filename: safeName }, 15000);
      if (!exported?.base64 || exported.size <= 0) throw new Error(exported?.error || 'Browser did not return PWAD bytes');
      const bytes = Buffer.from(exported.base64, 'base64');
      if (bytes.length !== exported.size) throw new Error(`PWAD size mismatch: browser=${exported.size}, decoded=${bytes.length}`);
      inspectPwad(bytes);
      await mkdir(EXPORT_DIR, { recursive: true });
      const outputPath = localExportPath(safeName);
      await writeFile(outputPath, bytes);
      return jsonResult({
        exported: true, filename: safeName, path: outputPath, bytes: bytes.length,
        episode: changeset.episode, map: changeset.map,
        changes: { sectorLights: changeset.sectorLightCount, spawnedThings: changeset.spawnCount, removedThings: changeset.removeCount, linedefs: changeset.linedefCount }
      });
    } catch (error) { return toolError(error); }
  });

  server.registerTool('doom_list_exports', {
    title: 'List locally exported DOOM PWADs', description: 'List .wad iterations available in the local export directory.',
    inputSchema: z.object({}), annotations: { readOnlyHint: true }
  }, async () => { try { const files = await listLocalExports(); return jsonResult({ exportDir: EXPORT_DIR, count: files.length, files }); } catch (error) { return toolError(error); } });

  server.registerTool('doom_load_pwad', {
    title: 'Load an exported PWAD into live DOOM',
    description: 'Validate and append a local PWAD with LinuxDOOM WAD override semantics, restart the map, and make it the new authoring baseline.',
    inputSchema: z.object({ filename: z.string().min(1).max(120), discardChanges: z.boolean().optional() }),
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ filename, discardChanges = false }) => {
    try {
      const changeset = await getCombinedChangeset();
      if (hasAuthoringChanges(changeset) && !discardChanges) throw new Error('Unexported authoring changes are pending. Export them first, or retry with discardChanges=true.');
      const safeName = safeExistingWadFilename(filename);
      const inputPath = localExportPath(safeName);
      const bytes = await readFile(inputPath);
      const inspection = inspectPwad(bytes);
      const state = await bridgeCall('get_state');
      if (!state?.ready) throw new Error('DOOM map is not ready');
      const expectedMarker = `E${state.episode}M${state.map}`;
      if (!inspection.mapMarkers.includes(expectedMarker)) throw new Error(`PWAD does not contain current map marker ${expectedMarker}`);
      const loaded = await bridgeCall('load_pwad', { filename: safeName, base64: bytes.toString('base64') }, 20000);
      const after = await bridgeCall('get_state', {}, 10000);
      const resetChanges = await getCombinedChangeset();
      return jsonResult({
        ...loaded,
        sourcePath: inputPath,
        pwad: { filename: safeName, bytes: bytes.length, lumpCount: inspection.lumpCount, mapMarkers: inspection.mapMarkers },
        liveState: { ready: after?.ready, episode: after?.episode, map: after?.map, currentSector: after?.currentSector, enemyCount: after?.enemyCount },
        changeSet: { sectorLights: resetChanges?.sectorLightCount, spawnedThings: resetChanges?.spawnCount, removedThings: resetChanges?.removeCount, linedefs: resetChanges?.linedefCount }
      });
    } catch (error) { return toolError(error); }
  });

  server.registerTool('doom_reload_current_map', {
    title: 'Reload current DOOM authoring baseline',
    description: 'Restart the current map from the latest loaded IWAD/PWAD baseline, discarding live authoring edits only when explicitly allowed.',
    inputSchema: z.object({ discardChanges: z.boolean().optional() }),
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ discardChanges = false } = {}) => {
    try {
      const changeset = await getCombinedChangeset();
      if (hasAuthoringChanges(changeset) && !discardChanges) throw new Error('Unexported authoring changes are pending. Export them first, or retry with discardChanges=true.');
      const result = await bridgeCall('reload_current_map', {}, 15000);
      const after = await bridgeCall('get_state');
      return jsonResult({ ...result, state: after, changeSet: await getCombinedChangeset() });
    } catch (error) { return toolError(error); }
  });

  return server;
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return pathToFileURL(process.argv[1]).href === import.meta.url;
}

if (isDirectExecution()) {
  startBridge();
  void serveStdio(createMcpServer);
  console.error('DOOM MCP: stdio server ready');
}
