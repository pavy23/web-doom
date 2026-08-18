import { pathToFileURL } from 'node:url';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import { GeometryWorkspace } from './geometry.js';
import { installThingAuthoring, listThingCatalog, THING_AUTHORING_VERSION } from './thing_authoring.js';
import { installSemanticGeometry, SEMANTIC_GEOMETRY_VERSION } from './semantic_geometry.js';

// P0 composition installs topology validation. P1 patches extend the same
// GeometryWorkspace prototype so atomic episode transactions, builds and the
// automated experiment runner all see the richer authoring surface.
const p0ExperimentModule = await import('./p0_experiment_server.js');
const p0Module = await import('./p0_server.js');
installThingAuthoring(GeometryWorkspace);
installSemanticGeometry(GeometryWorkspace);

const { startBridge: startAuthoringBridge } = await import('./server.js');
const { startPlaytestBridge } = await import('./playtest_server.js');
const { startOrchestrationBridge } = await import('./v1_server.js');
const { startCheatBridge } = await import('./cheat_server.js');
const geometryModule = await import('./geometry_server.js');

const VERSION = '2.3.0-p1.2';
const mapName = z.string().regex(/^(?:E[1-9]M[1-9]|MAP\d\d)$/i);
const category = z.enum(['start', 'monster', 'weapon', 'ammo', 'health', 'armor', 'key', 'powerup', 'prop']);
const textureName = z.string().regex(/^[A-Za-z0-9_-]{1,8}$/);

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
  if (!session.workspace.transaction) throw new Error('Begin an atomic episode transaction before persistent P1 authoring');
}

function applyEpisodeEdit(sessionId, map, edit) {
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

const roomAppearance = {
  floorFlat: textureName.optional(),
  ceilingFlat: textureName.optional(),
  light: z.number().int().min(-32768).max(32767).optional()
};

export function createMcpServer() {
  const server = p0ExperimentModule.createMcpServer();

  server.registerTool('doom_p1_status', {
    title: 'Read DOOM P1 authoring status',
    description: 'Read P1 general THINGS plus P1.2 semantic geometry capability layered on the complete P0 episode/experiment pipeline.',
    inputSchema: z.object({}), annotations: { readOnlyHint: true }
  }, async () => jsonResult({
    version: VERSION,
    thingAuthoringVersion: THING_AUTHORING_VERSION,
    semanticGeometryVersion: SEMANTIC_GEOMETRY_VERSION,
    capabilities: [
      'thing_catalog', 'thing_list', 'thing_add', 'thing_move', 'thing_update', 'thing_delete',
      'polygon_room', 'staircase', 'door_room', 'lift_room', 'sector_boundary', 'sector_split',
      'atomic_episode_transactions', 'verified_zdbsp_builds', 'browser_experiment_runner'
    ]
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
    try { return jsonResult(applyEpisodeEdit(sessionId, map, { type: 'thing_add', ...thing })); }
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
    try { return jsonResult(applyEpisodeEdit(sessionId, map, { type: 'thing_move', ...edit })); }
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
    try { return jsonResult(applyEpisodeEdit(sessionId, map, { type: 'thing_update', ...edit })); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('doom_delete_thing', {
    title: 'Delete a persistent DOOM thing',
    description: 'Delete one THINGS entry inside the active atomic transaction. Indices after the deleted item shift down by one.',
    inputSchema: z.object({ sessionId: z.string(), map: mapName, thing: z.number().int().min(0).max(65534) }),
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ sessionId, map, thing }) => {
    try { return jsonResult(applyEpisodeEdit(sessionId, map, { type: 'thing_delete', thing })); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('doom_get_sector_boundary', {
    title: 'Inspect an ordered DOOM sector boundary',
    description: 'Return one simple sector boundary as an ordered clockwise edge/vertex cycle. This is the safe input surface for sector splitting and future navigation analysis.',
    inputSchema: z.object({ sessionId: z.string(), map: mapName, sector: z.number().int().min(0).max(65534) }),
    annotations: { readOnlyHint: true }
  }, async ({ sessionId, map, sector }) => {
    try {
      const { workspace, map: normalized } = workspaceFor(sessionId, map);
      return jsonResult({ sessionId, map: normalized, boundary: workspace.getSectorBoundary({ sector }) });
    } catch (error) { return toolError(error); }
  });

  server.registerTool('doom_add_polygon_room', {
    title: 'Extrude a convex polygon DOOM room',
    description: 'Extrude a safe convex 3-12 sided room from the outside of a one-sided wall. The selected wall becomes the portal edge and P0 validates all new topology.',
    inputSchema: z.object({
      sessionId: z.string(), map: mapName,
      line: z.number().int().min(0).max(65534),
      sides: z.number().int().min(3).max(12).optional(),
      depth: z.number().int().min(32).max(2048).optional(),
      floor: z.number().int().min(-32768).max(32767).optional(),
      ceiling: z.number().int().min(-32768).max(32767).optional(),
      wallTexture: textureName.optional(),
      special: z.number().int().min(0).max(65535).optional(),
      tag: z.number().int().min(0).max(65535).optional(),
      ...roomAppearance
    }),
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ sessionId, map, ...edit }) => {
    try { return jsonResult(applyEpisodeEdit(sessionId, map, { type: 'add_polygon_room', ...edit })); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('doom_add_staircase', {
    title: 'Build a semantic DOOM staircase',
    description: 'Extrude 2-24 traversable step sectors plus an optional landing from a one-sided wall. Step height is capped at 24 Doom units for ordinary player traversal.',
    inputSchema: z.object({
      sessionId: z.string(), map: mapName,
      line: z.number().int().min(0).max(65534),
      steps: z.number().int().min(2).max(24).optional(),
      stepDepth: z.number().int().min(16).max(128).optional(),
      stepHeight: z.number().int().min(1).max(24).optional(),
      direction: z.enum(['up', 'down']).optional(),
      landingDepth: z.number().int().min(0).max(512).optional(),
      ceiling: z.number().int().min(-32768).max(32767).optional(),
      wallTexture: textureName.optional(),
      riserTexture: textureName.optional(),
      ...roomAppearance
    }),
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ sessionId, map, ...edit }) => {
    try { return jsonResult(applyEpisodeEdit(sessionId, map, { type: 'add_staircase', ...edit })); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('doom_add_door_room', {
    title: 'Build a functional DOOM door and destination room',
    description: 'Create a narrow closed door sector and a playable room behind it. Supports normal/blue/yellow/red manual doors and raise or stay-open behavior.',
    inputSchema: z.object({
      sessionId: z.string(), map: mapName,
      line: z.number().int().min(0).max(65534),
      doorDepth: z.number().int().min(8).max(64).optional(),
      roomDepth: z.number().int().min(48).max(1024).optional(),
      key: z.enum(['none', 'blue', 'yellow', 'red']).optional(),
      behavior: z.enum(['raise', 'open']).optional(),
      doorTexture: textureName.optional(),
      trackTexture: textureName.optional(),
      roomWallTexture: textureName.optional(),
      roomFloor: z.number().int().min(-32768).max(32767).optional(),
      roomCeiling: z.number().int().min(-32768).max(32767).optional(),
      ...roomAppearance
    }),
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ sessionId, map, ...edit }) => {
    try { return jsonResult(applyEpisodeEdit(sessionId, map, { type: 'add_door_room', ...edit })); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('doom_add_lift_room', {
    title: 'Build a functional DOOM lift and upper room',
    description: 'Create a tagged platform sector and an upper destination room. The lower side uses reusable USE special 62 to call the lift; the upper portal uses reusable WALK special 88 for return travel.',
    inputSchema: z.object({
      sessionId: z.string(), map: mapName,
      line: z.number().int().min(0).max(65534),
      liftDepth: z.number().int().min(24).max(128).optional(),
      roomDepth: z.number().int().min(48).max(1024).optional(),
      rise: z.number().int().min(25).max(256).optional(),
      clearance: z.number().int().min(64).max(256).optional(),
      ceiling: z.number().int().min(-32768).max(32767).optional(),
      tag: z.number().int().min(1).max(32767).optional(),
      wallTexture: textureName.optional(),
      ...roomAppearance
    }),
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ sessionId, map, ...edit }) => {
    try { return jsonResult(applyEpisodeEdit(sessionId, map, { type: 'add_lift_room', ...edit })); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('doom_split_sector', {
    title: 'Split a simple DOOM sector between boundary vertices',
    description: 'Split a simple single-cycle sector along a chord between two existing non-adjacent boundary vertices. One boundary chain is reassigned to a cloned sector and P0 validates the result.',
    inputSchema: z.object({
      sessionId: z.string(), map: mapName,
      sector: z.number().int().min(0).max(65534),
      vertexA: z.number().int().min(0).max(65534),
      vertexB: z.number().int().min(0).max(65534),
      floor: z.number().int().min(-32768).max(32767).optional(),
      ceiling: z.number().int().min(-32768).max(32767).optional(),
      floorFlat: textureName.optional(),
      ceilingFlat: textureName.optional(),
      light: z.number().int().min(-32768).max(32767).optional(),
      special: z.number().int().min(0).max(65535).optional(),
      tag: z.number().int().min(0).max(65535).optional()
    }),
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ sessionId, map, ...edit }) => {
    try { return jsonResult(applyEpisodeEdit(sessionId, map, { type: 'split_sector', ...edit })); }
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
  console.error(`DOOM MCP ${VERSION}: P1.1 THINGS + P1.2 semantic geometry ready`);
}
