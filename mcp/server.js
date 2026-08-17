import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { WebSocket, WebSocketServer } from 'ws';
import * as z from 'zod/v4';

const HOST = '127.0.0.1';
const PORT = Number(process.env.DOOM_MCP_PORT || 3777);
const UPSTREAM = new URL(
  process.env.DOOM_MCP_UPSTREAM || 'https://pavy23.github.io/web-doom/direct/'
);
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_DIR = path.resolve(process.env.DOOM_MCP_EXPORT_DIR || path.join(MODULE_DIR, 'exports'));

let browserSocket = null;
let nextRequestId = 1;
const pending = new Map();
let httpServer = null;
let wss = null;

function jsonResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  };
}

function toolError(error) {
  return {
    isError: true,
    content: [{ type: 'text', text: String(error?.message || error) }]
  };
}

function bridgeConnected() {
  return browserSocket && browserSocket.readyState === WebSocket.OPEN;
}

function bridgeCall(method, params = {}, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (!bridgeConnected()) {
      reject(new Error(
        `No DOOM browser is connected. Open http://${HOST}:${PORT}/, click CLICK TO START, then retry.`
      ));
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
        browserConnected: Boolean(bridgeConnected()),
        playUrl: `http://${HOST}:${PORT}/`,
        upstream: UPSTREAM.href,
        exportDir: EXPORT_DIR
      });
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
      });
      res.end(body);
      return;
    }

    const relative = requestUrl.pathname === '/'
      ? ''
      : requestUrl.pathname.replace(/^\//, '');
    const upstreamUrl = new URL(relative, UPSTREAM);
    upstreamUrl.search = requestUrl.search;

    const upstreamResponse = await fetch(upstreamUrl, {
      redirect: 'follow',
      cache: 'no-store',
      headers: { 'user-agent': 'web-doom-mcp/0.3' }
    });

    res.statusCode = upstreamResponse.status;
    const contentType = upstreamResponse.headers.get('content-type');
    if (contentType) res.setHeader('content-type', contentType);
    res.setHeader('cache-control', 'no-store');

    if (!upstreamResponse.body) {
      res.end();
      return;
    }

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
    try {
      pathname = new URL(req.url || '/', `http://${HOST}:${PORT}`).pathname;
    } catch {
      socket.destroy();
      return;
    }

    if (pathname !== '/control') {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit('connection', ws, req);
    });
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
        if (message?.event) {
          console.error(`DOOM MCP: browser event ${message.event}`);
        }
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
    console.error(`DOOM MCP: PWAD exports will be written to ${EXPORT_DIR}`);
  });

  return httpServer;
}

const ammoTypes = {
  bullets: 0,
  shells: 1,
  cells: 2,
  rockets: 3
};

const spawnableEnemyTypes = [
  'zombieman',
  'shotgun_guy',
  'imp',
  'demon',
  'spectre',
  'baron_of_hell'
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
    .sort((a, b) => {
      if (a.current !== b.current) return a.current ? -1 : 1;
      return a.distance - b.distance;
    })
    .slice(0, limit);
}

function safeExportFilename(requested, episode, mapNumber) {
  const fallback = `ai_E${episode}M${mapNumber}.wad`;
  const raw = String(requested || fallback).trim() || fallback;
  const base = raw.toLowerCase().endsWith('.wad') ? raw : `${raw}.wad`;
  const safe = base.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '');
  return safe || fallback;
}

export function createMcpServer() {
  const server = new McpServer(
    { name: 'web-doom-control', version: '0.3.0' },
    {
      instructions:
        'Use read tools before mutating the game. Authoring mutations are journaled and can be exported with doom_export_pwad. The browser must be open through the local bridge URL and the game must be started.'
    }
  );

  server.registerTool(
    'doom_bridge_status',
    {
      title: 'DOOM bridge status',
      description: 'Check whether the local DOOM browser is connected to this MCP server.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true }
    },
    async () => jsonResult({
      connected: Boolean(bridgeConnected()),
      playUrl: `http://${HOST}:${PORT}/`,
      upstream: UPSTREAM.href,
      exportDir: EXPORT_DIR
    })
  );

  server.registerTool(
    'doom_get_state',
    {
      title: 'Get live DOOM state',
      description: 'Read the current map, current sector, player stats and live enemies from the running LinuxDOOM simulation.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true }
    },
    async () => {
      try {
        return jsonResult(await bridgeCall('get_state'));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    'doom_get_enemies',
    {
      title: 'Query nearby DOOM enemies',
      description: 'Return live enemies sorted nearest-first. visibleOnly requires both Doom line-of-sight and the enemy to be within the forward 90-degree view cone.',
      inputSchema: z.object({
        visibleOnly: z.boolean().optional(),
        maxDistance: z.number().min(0).max(8192).optional(),
        limit: z.number().int().min(1).max(96).optional()
      }),
      annotations: { readOnlyHint: true }
    },
    async ({ visibleOnly = false, maxDistance, limit = 32 }) => {
      try {
        const state = await bridgeCall('get_state');
        const enemies = filteredEnemies(state, { visibleOnly, maxDistance, limit });
        return jsonResult({
          ready: Boolean(state?.ready),
          episode: state?.episode,
          map: state?.map,
          filters: { visibleOnly, maxDistance: maxDistance ?? null, limit },
          count: enemies.length,
          enemies
        });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    'doom_get_sectors',
    {
      title: 'Inspect DOOM sectors',
      description: 'Read runtime sectors with floor/ceiling heights, light level, special, tag, approximate sector origin and distance from the player. Current sector is returned first.',
      inputSchema: z.object({
        maxDistance: z.number().min(0).max(32768).optional(),
        limit: z.number().int().min(1).max(256).optional()
      }),
      annotations: { readOnlyHint: true }
    },
    async ({ maxDistance, limit = 64 }) => {
      try {
        const state = await bridgeCall('get_sectors', { limit: 256 });
        const sectors = filteredSectors(state, { maxDistance, limit });
        return jsonResult({
          ready: Boolean(state?.ready),
          sectorCount: state?.sectorCount,
          currentSector: state?.currentSector,
          filters: { maxDistance: maxDistance ?? null, limit },
          count: sectors.length,
          sectors
        });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    'doom_set_sector_light',
    {
      title: 'Set DOOM sector light',
      description: 'Set a sector light level from 0 to 255. The live change is also recorded in the authoring ChangeSet for later PWAD export.',
      inputSchema: z.object({
        sector: z.number().int().min(0).max(4095),
        light: z.number().int().min(0).max(255)
      }),
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false }
    },
    async ({ sector, light }) => {
      try {
        const result = await bridgeCall('set_sector_light', { sector, light });
        if (result.light < 0) throw new Error(`Engine rejected sector light edit with code ${result.light}`);
        return jsonResult({ sector, light: result.light, journaled: true });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    'doom_heal',
    {
      title: 'Heal DOOM player',
      description: 'Add health to the current player, capped at 200. This is a play/debug mutation and is not part of PWAD authoring export.',
      inputSchema: z.object({
        amount: z.number().int().min(1).max(200)
      })
    },
    async ({ amount }) => {
      try {
        const result = await bridgeCall('heal', { amount });
        if (result.health < 0) throw new Error(`Engine rejected heal with code ${result.health}`);
        return jsonResult(result);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    'doom_give_ammo',
    {
      title: 'Give DOOM ammunition',
      description: 'Give bullets, shells, cells or rockets to the current player, respecting max ammo. This is not exported to PWAD.',
      inputSchema: z.object({
        type: z.enum(['bullets', 'shells', 'cells', 'rockets']),
        amount: z.number().int().min(1).max(1000)
      })
    },
    async ({ type, amount }) => {
      try {
        const result = await bridgeCall('give_ammo', {
          ammoType: ammoTypes[type],
          amount
        });
        if (result.ammo < 0) throw new Error(`Engine rejected ammo change with code ${result.ammo}`);
        return jsonResult({ type, ...result });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    'doom_teleport',
    {
      title: 'Teleport DOOM player',
      description: 'Move the current player to integer map coordinates using Doom collision-aware P_TeleportMove logic. Player movement is not exported to PWAD.',
      inputSchema: z.object({
        x: z.number().int().min(-32768).max(32767),
        y: z.number().int().min(-32768).max(32767)
      })
    },
    async ({ x, y }) => {
      try {
        const result = await bridgeCall('teleport', { x, y });
        if (result.moved < 0) throw new Error(`Engine rejected teleport with code ${result.moved}`);
        if (result.moved === 0) throw new Error('Teleport destination was blocked by the Doom simulation');
        return jsonResult({ x, y, moved: true });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    'doom_spawn_enemy',
    {
      title: 'Spawn enemies in front of the DOOM player',
      description: 'Spawn one to eight Episode-1-safe monsters in front of the player. Successful spawns are journaled as THINGS edits for PWAD export.',
      inputSchema: z.object({
        type: z.enum(spawnableEnemyTypes),
        count: z.number().int().min(1).max(8).optional(),
        distance: z.number().int().min(64).max(1024).optional()
      }),
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    async ({ type, count = 1, distance = 160 }) => {
      try {
        const result = await bridgeCall('spawn_enemy', {
          name: type,
          count,
          distance
        });
        if (result.spawned < 0) {
          throw new Error(`Engine rejected spawn with code ${result.spawned}`);
        }
        return jsonResult({
          type,
          requested: count,
          spawned: result.spawned,
          rejectedByCollision: count - result.spawned,
          distance,
          journaled: result.spawned > 0
        });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    'doom_remove_nearest_enemy',
    {
      title: 'Remove nearest DOOM enemy',
      description: 'Remove the nearest matching live enemy. Original map enemies are journaled as THINGS removals; removing an AI-spawned enemy cancels that pending spawn.',
      inputSchema: z.object({
        visibleOnly: z.boolean().optional(),
        maxDistance: z.number().int().min(0).max(8192).optional()
      }),
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    async ({ visibleOnly = false, maxDistance = 2048 }) => {
      try {
        const result = await bridgeCall('remove_nearest_enemy', {
          visibleOnly,
          maxDistance
        });
        if (result.error) throw new Error(result.error);
        return jsonResult(result);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    'doom_get_changeset',
    {
      title: 'Inspect DOOM authoring ChangeSet',
      description: 'Read the persistent authoring edits accumulated for the current map: sector light changes plus spawned and removed map things.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true }
    },
    async () => {
      try {
        return jsonResult(await bridgeCall('get_changeset'));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    'doom_export_pwad',
    {
      title: 'Export current AI-authored DOOM map as PWAD',
      description: 'Build a PWAD override for the current ExMy map from the original map lumps plus the authoring ChangeSet, then save the .wad file to the local MCP exports directory.',
      inputSchema: z.object({
        filename: z.string().min(1).max(120).optional()
      }),
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async ({ filename } = {}) => {
      try {
        const changeset = await bridgeCall('get_changeset');
        if (!changeset?.ready) throw new Error('DOOM map is not ready for export');

        const safeName = safeExportFilename(filename, changeset.episode, changeset.map);
        const exported = await bridgeCall('export_pwad', { filename: safeName }, 15000);
        if (!exported?.base64 || exported.size <= 0) {
          throw new Error(exported?.error || 'Browser did not return PWAD bytes');
        }

        const bytes = Buffer.from(exported.base64, 'base64');
        if (bytes.length !== exported.size) {
          throw new Error(`PWAD size mismatch: browser=${exported.size}, decoded=${bytes.length}`);
        }

        await mkdir(EXPORT_DIR, { recursive: true });
        const outputPath = path.join(EXPORT_DIR, safeName);
        await writeFile(outputPath, bytes);

        return jsonResult({
          exported: true,
          filename: safeName,
          path: outputPath,
          bytes: bytes.length,
          episode: changeset.episode,
          map: changeset.map,
          changes: {
            sectorLights: changeset.sectorLightCount,
            spawnedThings: changeset.spawnCount,
            removedThings: changeset.removeCount
          }
        });
      } catch (error) {
        return toolError(error);
      }
    }
  );

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
