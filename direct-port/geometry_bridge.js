// Browser bridge for DOOM MCP v2 structural geometry authoring.
// It deliberately exposes only whole-map snapshot/reload helpers. Geometry mutation,
// validation and BSP/node rebuilding happen in the local Node MCP process.
(function () {
  function requireGeometryRuntime() {
    if (!window.DoomControl) throw new Error('DOOM control runtime is not ready');
  }

  function combinedChangeset() {
    requireGeometryRuntime();
    const base = window.DoomControl.getChangeSet ? window.DoomControl.getChangeSet() : { ready: false };
    const linedefs = window.DoomControl.getLinedefChanges ? window.DoomControl.getLinedefChanges() : { count: 0, linedefs: [] };
    const visuals = window.DoomControl.getVisualChanges ? window.DoomControl.getVisualChanges() : { sidedefCount: 0, sectorFlatCount: 0, sidedefs: [], sectorFlats: [] };
    return {
      ...base,
      linedefCount: Number(linedefs?.count || 0),
      sidedefCount: Number(visuals?.sidedefCount || 0),
      sectorFlatCount: Number(visuals?.sectorFlatCount || 0),
      linedefs: Array.isArray(linedefs?.linedefs) ? linedefs.linedefs : [],
      sidedefs: Array.isArray(visuals?.sidedefs) ? visuals.sidedefs : [],
      sectorFlats: Array.isArray(visuals?.sectorFlats) ? visuals.sectorFlats : []
    };
  }

  function pendingCount(changes) {
    return Number(changes?.sectorLightCount || 0)
      + Number(changes?.spawnCount || 0)
      + Number(changes?.removalCount || 0)
      + Number(changes?.linedefCount || 0)
      + Number(changes?.sidedefCount || 0)
      + Number(changes?.sectorFlatCount || 0);
  }

  window.DoomControl.geometrySnapshot = function geometrySnapshot(filename = 'geometry-baseline.wad') {
    requireGeometryRuntime();
    const state = window.DoomControl.getState();
    const changes = combinedChangeset();
    const artifact = window.DoomControl.exportPwad(filename);
    return { state, changes, pendingCount: pendingCount(changes), artifact };
  };

  window.DoomControl.geometryLoad = function geometryLoad(filename, base64) {
    requireGeometryRuntime();
    return window.DoomControl.loadPwad(filename, base64);
  };

  let socket = null;
  let reconnectTimer = null;

  function bridgeUrl() {
    const local = location.hostname === '127.0.0.1' || location.hostname === 'localhost';
    if (!local) return null;
    return 'ws://127.0.0.1:3781/geometry';
  }

  function reply(socketRef, id, payload) {
    Promise.resolve(payload).then(result => {
      if (socketRef?.readyState === WebSocket.OPEN) socketRef.send(JSON.stringify({ id, ok: true, result }));
    }).catch(error => {
      if (socketRef?.readyState === WebSocket.OPEN) socketRef.send(JSON.stringify({ id, ok: false, error: String(error?.message || error) }));
    });
  }

  function dispatch(method, params = {}) {
    switch (method) {
      case 'geometry_snapshot': return window.DoomControl.geometrySnapshot(params.filename);
      case 'geometry_load': return window.DoomControl.geometryLoad(params.filename, params.base64);
      case 'geometry_state': return { state: window.DoomControl.getState(), changes: combinedChangeset() };
      default: throw new Error(`Unknown geometry bridge method: ${method}`);
    }
  }

  function connect() {
    const url = bridgeUrl();
    if (!url || socket) return;
    try { socket = new WebSocket(url); } catch { socket = null; return; }
    socket.addEventListener('open', () => socket.send(JSON.stringify({ event: 'geometry_hello' })));
    socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!message?.id || !message?.method) return;
      try { reply(socket, message.id, dispatch(message.method, message.params || {})); }
      catch (error) { reply(socket, message.id, Promise.reject(error)); }
    });
    socket.addEventListener('close', () => {
      socket = null;
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 1200);
    });
  }

  connect();
})();
