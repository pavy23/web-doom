import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { WebSocket, WebSocketServer } from 'ws';
import * as z from 'zod/v4';

import { createMcpServer as createAuthoringServer, startBridge as startAuthoringBridge } from './server.js';

const HOST = '127.0.0.1';
const PLAYTEST_PORT = 3778;
const VERSION = '0.7.0';

let playtestHttpServer = null;
let playtestWss = null;
let browserSocket = null;
let nextRequestId = 1;
const pending = new Map();

function jsonResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function toolError(error) {
  return { isError: true, content: [{ type: 'text', text: String(error?.message || error) }] };
}

function imageResult(frame) {
  const metadata = {
    captured: true,
    mimeType: frame.mimeType,
    width: frame.width,
    height: frame.height,
    telemetry: frame.telemetry
  };
  return {
    content: [
      { type: 'text', text: JSON.stringify(metadata, null, 2) },
      { type: 'image', data: frame.base64, mimeType: frame.mimeType || 'image/png' }
    ]
  };
}

function connected() {
  return browserSocket && browserSocket.readyState === WebSocket.OPEN;
}

function playtestCall(method, params = {}, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (!connected()) {
      reject(new Error(
        'No DOOM playtest bridge is connected. Open http://127.0.0.1:3777/, click CLICK TO START, then retry.'
      ));
      return;
    }

    const id = `playtest-${Date.now()}-${nextRequestId++}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`DOOM playtest bridge timed out while calling ${method}`));
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
  else entry.reject(new Error(message.error || 'Unknown playtest bridge error'));
  return true;
}

function rejectAll(reason) {
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
    pending.delete(id);
  }
}

export function startPlaytestBridge() {
  if (playtestHttpServer) return playtestHttpServer;

  playtestHttpServer = http.createServer((req, res) => {
    if (req.url === '/health') {
      const body = JSON.stringify({ ok: true, version: VERSION, browserConnected: Boolean(connected()) });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('DOOM playtest bridge');
  });

  playtestWss = new WebSocketServer({ noServer: true });
  playtestHttpServer.on('upgrade', (req, socket, head) => {
    let pathname;
    try { pathname = new URL(req.url || '/', `http://${HOST}:${PLAYTEST_PORT}`).pathname; }
    catch { socket.destroy(); return; }
    if (pathname !== '/playtest') { socket.destroy(); return; }
    playtestWss.handleUpgrade(req, socket, head, ws => playtestWss.emit('connection', ws, req));
  });

  playtestWss.on('connection', ws => {
    if (browserSocket && browserSocket !== ws) {
      try { browserSocket.close(1012, 'Replaced by newer playtest browser'); } catch {}
    }
    browserSocket = ws;
    console.error('DOOM MCP: playtest/vision bridge connected');

    ws.on('message', raw => {
      try {
        const message = JSON.parse(String(raw));
        if (settle(message)) return;
        if (message?.event) console.error(`DOOM MCP: ${message.event}`);
      } catch (error) {
        console.error(`DOOM MCP: bad playtest message: ${error?.message || error}`);
      }
    });

    ws.on('close', () => {
      if (browserSocket === ws) browserSocket = null;
      rejectAll('DOOM playtest browser disconnected');
      console.error('DOOM MCP: playtest/vision bridge disconnected');
    });
  });

  playtestHttpServer.listen(PLAYTEST_PORT, HOST, () => {
    console.error(`DOOM MCP: playtest/vision bridge at ws://${HOST}:${PLAYTEST_PORT}/playtest`);
  });
  return playtestHttpServer;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForSteps(beforeWorldTics, count) {
  const target = Number(beforeWorldTics || 0) + count;
  const deadline = Date.now() + Math.max(5000, Math.ceil(count / 35 * 1000) + 4000);
  let telemetry = null;

  while (Date.now() < deadline) {
    await sleep(20);
    telemetry = await playtestCall('get_playtest_telemetry');
    if (Number(telemetry?.worldTics || 0) >= target && Number(telemetry?.stepBudget || 0) === 0) {
      return telemetry;
    }
  }
  throw new Error(`Timed out waiting for ${count} exact world tics`);
}

export function createMcpServer() {
  const server = createAuthoringServer();

  server.registerTool('doom_playtest_status', {
    title: 'DOOM AI playtest status',
    description: 'Check the v0.7 playtest/vision bridge used for screenshots, telemetry and exact world-tic stepping.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true }
  }, async () => jsonResult({ version: VERSION, connected: Boolean(connected()), playtestPort: PLAYTEST_PORT }));

  server.registerTool('doom_pause_playtest', {
    title: 'Pause DOOM world simulation',
    description: 'Pause P_Ticker world simulation while keeping browser rendering, input processing and MCP connectivity alive.',
    inputSchema: z.object({}),
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async () => {
    try {
      await playtestCall('set_playtest_paused', { paused: true });
      return jsonResult(await playtestCall('get_playtest_telemetry'));
    } catch (error) { return toolError(error); }
  });

  server.registerTool('doom_resume_playtest', {
    title: 'Resume DOOM world simulation',
    description: 'Resume normal real-time DOOM world simulation and clear any pending exact-step budget.',
    inputSchema: z.object({}),
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async () => {
    try {
      await playtestCall('set_playtest_paused', { paused: false });
      return jsonResult(await playtestCall('get_playtest_telemetry'));
    } catch (error) { return toolError(error); }
  });

  server.registerTool('doom_step_tics', {
    title: 'Advance exact DOOM world tics',
    description: 'While paused, advance exactly N P_Ticker world tics (35 tics = about one second of DOOM simulation), then return updated telemetry.',
    inputSchema: z.object({ count: z.number().int().min(1).max(350) }),
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ count }) => {
    try {
      const before = await playtestCall('get_playtest_telemetry');
      if (!before?.paused) throw new Error('Playtest must be paused before exact tic stepping');
      await playtestCall('step_playtest_tics', { count });
      const after = await waitForSteps(before.worldTics, count);
      return jsonResult({ requestedTics: count, before, after });
    } catch (error) { return toolError(error); }
  });

  server.registerTool('doom_get_playtest_telemetry', {
    title: 'Read DOOM playtest telemetry',
    description: 'Read elapsed world tics/time, sectors visited, approximate travel distance, health/damage, deaths, kills/items/secrets and ammunition since the current metric baseline.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true }
  }, async () => {
    try { return jsonResult(await playtestCall('get_playtest_telemetry')); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('doom_reset_playtest_metrics', {
    title: 'Reset DOOM playtest telemetry baseline',
    description: 'Start a fresh playtest measurement baseline without changing level content.',
    inputSchema: z.object({}),
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async () => {
    try { return jsonResult(await playtestCall('reset_playtest_metrics')); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('doom_capture_frame', {
    title: 'Capture current DOOM frame for vision',
    description: 'Capture the final browser canvas as PNG plus matching playtest telemetry. Pause first when a stable deterministic observation is needed.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true }
  }, async () => {
    try {
      const frame = await playtestCall('capture_frame', {}, 10000);
      if (!frame?.base64) throw new Error('Browser did not return a PNG frame');
      return imageResult(frame);
    } catch (error) { return toolError(error); }
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
  void serveStdio(createMcpServer);
  console.error(`DOOM MCP ${VERSION}: authoring + playtest/vision stdio server ready`);
}
