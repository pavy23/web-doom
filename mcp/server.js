import http from 'node:http';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { WebSocket, WebSocketServer } from 'ws';
import * as z from 'zod/v4';

const HOST = '127.0.0.1';
const PORT = Number(process.env.DOOM_MCP_PORT || 3777);
const UPSTREAM = new URL(
  process.env.DOOM_MCP_UPSTREAM || 'https://pavy23.github.io/web-doom/direct/'
);

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
        upstream: UPSTREAM.href
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
      headers: { 'user-agent': 'web-doom-mcp/0.2' }
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

export function createMcpServer() {
  const server = new McpServer(
    { name: 'web-doom-control', version: '0.2.0' },
    {
      instructions:
        'Use doom_get_state or doom_get_enemies before mutating the game. The browser must be open through the local bridge URL and the game must be started.'
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
      upstream: UPSTREAM.href
    })
  );

  server.registerTool(
    'doom_get_state',
    {
      title: 'Get live DOOM state',
      description: 'Read the current map, player stats and live enemies from the running LinuxDOOM simulation.',
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
    'doom_heal',
    {
      title: 'Heal DOOM player',
      description: 'Add health to the current player, capped at 200.',
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
      description: 'Give bullets, shells, cells or rockets to the current player, respecting the current max-ammo limit.',
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
      description: 'Move the current player to integer map coordinates using Doom\'s own collision-aware P_TeleportMove logic.',
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
      description: 'Spawn one to eight Episode-1-safe monsters in a fan in front of the player. Doom collision checks reject blocked spawn positions.',
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
          distance
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
      description: 'Remove the nearest matching live enemy using Doom actor removal. Optionally limit the operation to enemies currently visible in the forward view.',
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
