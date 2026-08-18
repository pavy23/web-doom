import { pathToFileURL } from 'node:url';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import { GeometryWorkspace } from './geometry.js';
import { installThingAuthoring, listThingCatalog, THING_AUTHORING_VERSION } from './thing_authoring.js';

// P0 composition installs topology validation. Install THINGS after importing P0
// so the P1 validator can preserve P0 issue metadata while extending it.
const p0ExperimentModule = await import('./p0_experiment_server.js');
const p0Module = await import('./p0_server.js');
installThingAuthoring(GeometryWorkspace);

const { startBridge: startAuthoringBridge } = await import('./server.js');
const { startPlaytestBridge } = await import('./playtest_server.js');
const { startOrchestrationBridge } = await import('./v1_server.js');
const { startCheatBridge } = await import('./cheat_server.js');
const geometryModule = await import('./geometry_server.js');

const VERSION = '2.2.0-p1.1';
const mapName = z.string().regex(/^(?:E[1-9]M[1-9]|MAP\d\d)$/i);
const category = z.enum(['start', 'monster', 'weapon', 'ammo', 'health', 'armor', 'key', 'powerup', 'prop']);

function jsonResult(value) { return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }; }
function toolError(error) { return { isError: true, content: [{ type: 'text', text: String(error?.message || error) }] }; }

function workspaceFor(sessionId, map) {
  const session = p0Module.getEpisodeSession(sessionId);
  const key = String(map || '').toUpperCase();
  const workspace = session.workspace.workspaces.get(key);
  if (!workspace) throw new Error(`Map ${key} is not part of episode session ${sessionId}`);
  return { session, workspace, map: key };
}

function requireTransaction(session) {
  if (!session.workspace.transaction) throw new Error('Begin an atomic episode transaction before changing THINGS');
}

function applyThingEdit(sessionId, map, edit) {
  const { session, map: normalized } = workspaceFor(sessionId, map);
  requireTransaction(session);
  return session.workspace.applyEdits([{ ...edit, map: normalized }]);
}

const thingOptions = {
  skillEasy: z.boolean().optional(),
  skillMedium: z.boolean().optional(),
  skillHard: z.boolean().optional(),
  ambush: z.boolean().optional(),
  multiplayerOnly: z.boolean().optional()
};

const typeFields = {
  key: z.string().min(1).max(64).optional(),
  doomEdNum: z.number().int().min(1).max(32767).optional()
};

export function createMcpServer() {
  const server = p0ExperimentModule.createMcpServer();

  server.registerTool('doom_p1_status', {
    title: 'Read DOOM P1 authoring status',
    description: 'Read P1.1 general THINGS authoring capability layered on top of the complete P0 episode/experiment pipeline.',
    inputSchema: z.object({}), annotations: { readOnlyHint: true }
  }, async () => jsonResult({
    version: VERSION,
    thingAuthoringVersion: THING_AUTHORING_VERSION,
    capabilities: ['thing_catalog', 'thing_list', 'thing_add', 'thing_move', 'thing_update', 'thing_delete', 'atomic_episode_transactions']
  }));

  server.registerTool('doom_list_thing_types', {
    title: 'List authorable DOOM thing types',
    description: 'List the built-in Vanilla Doom THINGS catalog. Numeric doomEdNum remains available for valid uncatalogued/custom things.',
    inputSchema: z.object({ category: category.optional(), query: z.string().max(64).optional() }),
    annotations: { readOnlyHint: true }
  }, async args => jsonResult({ version: THING_AUTHORING_VERSION, types: listThingCatalog(args) }));

  server.registerTool('doom_list_things', {
    title: 'List THINGS in an episode map',
    description: 'Inspect authored and baseline THINGS in one map, including DoomEd number, semantic category and decoded Vanilla option flags.',
    inputSchema: z.object({
      sessionId: z.string(), map: mapName,
      category: category.optional(), query: z.string().max(64).optional(),
      limit: z.number().int().min(1).max(4096).optional()
    }), annotations: { readOnlyHint: true }
  }, async ({ sessionId, map, ...filters }) => {
    try {
      const { workspace, map: normalized } = workspaceFor(sessionId, map);
      return jsonResult({ sessionId, map: normalized, things: workspace.listThings(filters) });
    } catch (error) { return toolError(error); }
  });

  server.registerTool('doom_spawn_thing', {
    title: 'Add a persistent DOOM thing',
    description: 'Add a player/deathmatch start, monster, weapon, ammo, health, armor, key, powerup, barrel or numeric DoomEd thing inside the active atomic transaction.',
    inputSchema: z.object({
      sessionId: z.string(), map: mapName,
      ...typeFields,
      x: z.number().int().min(-32768).max(32767),
      y: z.number().int().min(-32768).max(32767),
      angle: z.number().int().optional(),
      flags: z.number().int().min(0).max(32767).optional(),
      ...thingOptions
    }).refine(value => value.key != null || value.doomEdNum != null, { message: 'Provide key or doomEdNum' }),
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ sessionId, map, ...thing }) => {
    try { return jsonResult(applyThingEdit(sessionId, map, { type: 'thing_add', ...thing })); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('doom_move_thing', {
    title: 'Move a persistent DOOM thing',
    description: 'Move an existing THINGS entry and optionally rotate it inside the active atomic transaction.',
    inputSchema: z.object({
      sessionId: z.string(), map: mapName,
      thing: z.number().int().min(0).max(65534),
      x: z.number().int().min(-32768).max(32767).optional(),
      y: z.number().int().min(-32768).max(32767).optional(),
      angle: z.number().int().optional()
    }).refine(value => value.x != null || value.y != null || value.angle != null, { message: 'Provide x, y or angle' }),
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ sessionId, map, ...edit }) => {
    try { return jsonResult(applyThingEdit(sessionId, map, { type: 'thing_move', ...edit })); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('doom_update_thing', {
    title: 'Update a persistent DOOM thing',
    description: 'Change thing type, angle or Vanilla skill/ambush/multiplayer flags inside the active atomic transaction.',
    inputSchema: z.object({
      sessionId: z.string(), map: mapName,
      thing: z.number().int().min(0).max(65534),
      ...typeFields,
      angle: z.number().int().optional(),
      flags: z.number().int().min(0).max(32767).optional(),
      ...thingOptions
    }),
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ sessionId, map, ...edit }) => {
    try { return jsonResult(applyThingEdit(sessionId, map, { type: 'thing_update', ...edit })); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('doom_delete_thing', {
    title: 'Delete a persistent DOOM thing',
    description: 'Delete one THINGS entry inside the active atomic transaction. Indices after the deleted item shift down by one.',
    inputSchema: z.object({ sessionId: z.string(), map: mapName, thing: z.number().int().min(0).max(65534) }),
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ sessionId, map, thing }) => {
    try { return jsonResult(applyThingEdit(sessionId, map, { type: 'thing_delete', thing })); }
    catch (error) { return toolError(error); }
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
  console.error(`DOOM MCP ${VERSION}: P1.1 general THINGS authoring ready`);
}
