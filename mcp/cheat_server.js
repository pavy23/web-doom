import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { WebSocket, WebSocketServer } from 'ws';
import * as z from 'zod/v4';

import { startBridge as startAuthoringBridge } from './server.js';
import { startPlaytestBridge } from './playtest_server.js';
import { createMcpServer as createV1Server, startOrchestrationBridge } from './v1_server.js';

const HOST = '127.0.0.1';
const PORT = 3780;
const VERSION = '1.1.0';

let httpServer = null;
let wss = null;
let browserSocket = null;
let nextRequestId = 1;
const pending = new Map();

function jsonResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function toolError(error) {
  return { isError: true, content: [{ type: 'text', text: String(error?.message || error) }] };
}

function connected() {
  return browserSocket && browserSocket.readyState === WebSocket.OPEN;
}

function cheatCall(method, params = {}, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (!connected()) {
      reject(new Error('No DOOM cheat/audio bridge is connected. Open http://127.0.0.1:3777/, click CLICK TO START, then retry.'));
      return;
    }
    const id = `cheat-${Date.now()}-${nextRequestId++}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`DOOM cheat bridge timed out while calling ${method}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    browserSocket.send(JSON.stringify({ id, method, params }));
  });
}

function settle(message) {
  if (!message?.id || !pending.has(message.id)) return false;
  const entry = pending.get(message.id);
  pending.delete(message.id);
  clearTimeout(entry.timer);
  if (message.ok) entry.resolve(message.result);
  else entry.reject(new Error(message.error || 'Unknown cheat bridge error'));
  return true;
}

function rejectAll(reason) {
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
    pending.delete(id);
  }
}

export function startCheatBridge() {
  if (httpServer) return httpServer;

  httpServer = http.createServer((req, res) => {
    if (req.url === '/health') {
      const body = JSON.stringify({ ok: true, version: VERSION, browserConnected: Boolean(connected()) });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('DOOM cheat/audio bridge');
  });

  wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    let pathname;
    try { pathname = new URL(req.url || '/', `http://${HOST}:${PORT}`).pathname; }
    catch { socket.destroy(); return; }
    if (pathname !== '/cheats') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });

  wss.on('connection', ws => {
    if (browserSocket && browserSocket !== ws) {
      try { browserSocket.close(1012, 'Replaced by newer cheat browser'); } catch {}
    }
    browserSocket = ws;
    console.error('DOOM MCP: cheat/audio bridge connected');

    ws.on('message', raw => {
      try {
        const message = JSON.parse(String(raw));
        if (settle(message)) return;
        if (message?.event) console.error(`DOOM MCP: ${message.event}`);
      } catch (error) {
        console.error(`DOOM MCP: bad cheat message: ${error?.message || error}`);
      }
    });

    ws.on('close', () => {
      if (browserSocket === ws) browserSocket = null;
      rejectAll('DOOM cheat/audio browser disconnected');
      console.error('DOOM MCP: cheat/audio bridge disconnected');
    });
  });

  httpServer.listen(PORT, HOST, () => {
    console.error(`DOOM MCP: cheat/audio bridge at ws://${HOST}:${PORT}/cheats`);
  });
  return httpServer;
}

export function createMcpServer() {
  const server = createV1Server();

  server.registerTool('doom_cheat_status', {
    title: 'Read live DOOM cheat status',
    description: 'Read live-only god/noclip, health, armor, keys, weapons, ammo and power-up state. Nothing here is serialized into PWAD content.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true }
  }, async () => {
    try { return jsonResult(await cheatCall('cheat_status')); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('doom_set_god_mode', {
    title: 'Set DOOM god mode',
    description: 'Enable or disable original CF_GODMODE-style no-damage cheat for the live player. Playtest-only.',
    inputSchema: z.object({ enabled: z.boolean() }),
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ enabled }) => {
    try { return jsonResult(await cheatCall('set_god_mode', { enabled })); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('doom_set_noclip', {
    title: 'Set DOOM noclip',
    description: 'Enable or disable original CF_NOCLIP-style collision bypass for the live player. Playtest-only.',
    inputSchema: z.object({ enabled: z.boolean() }),
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ enabled }) => {
    try { return jsonResult(await cheatCall('set_noclip', { enabled })); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('doom_give_arsenal', {
    title: 'Give full DOOM arsenal and ammo',
    description: 'Mirror the classic IDFA/IDKFA-style live cheat: 200 armor, all weapons, max ammo, and optionally all keys. Playtest-only.',
    inputSchema: z.object({ includeKeys: z.boolean().optional() }),
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ includeKeys = true } = {}) => {
    try { return jsonResult(await cheatCall('give_arsenal', { includeKeys })); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('doom_give_keys', {
    title: 'Give all DOOM keys',
    description: 'Give all card/skull keys to the live player. Playtest-only.',
    inputSchema: z.object({}),
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => {
    try { return jsonResult(await cheatCall('give_keys')); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('doom_set_health_armor', {
    title: 'Set DOOM health and armor',
    description: 'Set live player health (1..200), armor (0..200) and armor type (0..2). Playtest-only.',
    inputSchema: z.object({
      health: z.number().int().min(1).max(200),
      armor: z.number().int().min(0).max(200),
      armorType: z.number().int().min(0).max(2).optional()
    }),
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ health, armor, armorType = armor > 100 ? 2 : (armor > 0 ? 1 : 0) }) => {
    try { return jsonResult(await cheatCall('set_health_armor', { health, armor, armorType })); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('doom_give_powerup', {
    title: 'Give a DOOM power-up',
    description: 'Give/reset one live power-up through original DOOM power state: invulnerability, berserk, invisibility, radiation, allmap, or lightamp.',
    inputSchema: z.object({
      power: z.enum(['invulnerability', 'berserk', 'invisibility', 'radiation', 'allmap', 'lightamp'])
    }),
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ power }) => {
    try { return jsonResult(await cheatCall('give_powerup', { name: power })); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('doom_warp', {
    title: 'Warp to a DOOM map',
    description: 'Immediately start another valid map using LinuxDOOM G_InitNew at the current skill. Shareware build supports E1M1 through E1M9. Playtest-only and may invalidate assumptions of an active authoring session.',
    inputSchema: z.object({
      episode: z.number().int().min(1).max(4).optional(),
      map: z.number().int().min(1).max(34)
    }),
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ episode = 1, map }) => {
    try { return jsonResult(await cheatCall('warp', { episode, map }, 15000)); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('doom_audio_status', {
    title: 'Read browser/SDL audio status',
    description: 'Diagnose the browser AudioContext and SDL_mixer state, useful when desktop browser audio is silent.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true }
  }, async () => {
    try { return jsonResult(await cheatCall('audio_status')); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('doom_audio_resume', {
    title: 'Attempt to resume DOOM audio',
    description: 'Retry browser AudioContext resume and SDL audio-device unpause. A browser may still require the user to click the on-screen AUDIO button for a fresh user gesture.',
    inputSchema: z.object({}),
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async () => {
    try { return jsonResult(await cheatCall('audio_resume')); }
    catch (error) { return toolError(error); }
  });

  return server;
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return pathToFileURL(process.argv[1]).href === import.meta.url;
}

if (isDirectExecution()) {
  startAuthoringBridge();
  startPlaytestBridge();
  startOrchestrationBridge();
  startCheatBridge();
  void serveStdio(createMcpServer);
  console.error(`DOOM MCP ${VERSION}: v1 authoring + live cheats + audio diagnostics ready`);
}
