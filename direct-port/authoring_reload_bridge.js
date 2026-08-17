// Pre-JS extension loaded by the generated Emscripten runtime after shell.html
// has defined window.DoomControl and the localhost MCP dispatcher.
//
// PWAD bytes arrive from the local MCP server as base64, are written into the
// in-memory Emscripten filesystem, and are then handed to LinuxDOOM's own WAD
// append + G_InitNew reload adapter. Imported files intentionally remain in FS
// because W_AddFile keeps an open file handle for their lumps.

(function () {
  function requireAuthoringRuntime() {
    if (!window.DoomControl || typeof Module === 'undefined'
        || typeof Module.ccall !== 'function'
        || !Module.FS || typeof Module.FS.writeFile !== 'function') {
      throw new Error('DOOM authoring runtime is not ready');
    }
  }

  function decodeBase64(base64) {
    const binary = atob(String(base64 || ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; ++i) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function safeImportName(filename) {
    const raw = String(filename || 'import.wad');
    const safe = raw.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '');
    const name = safe.toLowerCase().endsWith('.wad') ? safe : `${safe || 'import'}.wad`;
    return name;
  }

  window.DoomControl.loadPwad = function loadPwad(filename, base64) {
    requireAuthoringRuntime();
    const bytes = decodeBase64(base64);
    if (bytes.length < 12) throw new Error('PWAD payload is too small');
    if (bytes.length > 16 * 1024 * 1024) throw new Error('PWAD payload exceeds 16 MiB import limit');

    const safeName = safeImportName(filename);
    const virtualPath = `/mcp_import_${Date.now()}_${safeName}`;
    Module.FS.writeFile(virtualPath, bytes);

    const json = Module.ccall('doomctl_load_pwad_json', 'string', ['string'], [virtualPath]);
    const result = JSON.parse(json);
    if (!result.loaded) throw new Error(result.error || `PWAD load failed (${result.code || 'unknown'})`);
    return { ...result, filename: safeName, virtualPath, bytes: bytes.length };
  };

  window.DoomControl.reloadCurrentMap = function reloadCurrentMap() {
    requireAuthoringRuntime();
    const json = Module.ccall('doomctl_reload_current_map_json', 'string', [], []);
    const result = JSON.parse(json);
    if (!result.reloaded) throw new Error(result.error || 'Map reload failed');
    return result;
  };

  if (typeof handleMcpRequest !== 'function' || typeof replyMcp !== 'function') {
    console.error('DOOM MCP reload bridge could not find shell dispatcher');
    return;
  }

  const previousHandleMcpRequest = handleMcpRequest;
  handleMcpRequest = function extendedHandleMcpRequest(message) {
    const { id, method, params = {} } = message || {};
    if (!id || !method) return previousHandleMcpRequest(message);

    if (method !== 'load_pwad' && method !== 'reload_current_map') {
      return previousHandleMcpRequest(message);
    }

    try {
      const result = method === 'load_pwad'
        ? window.DoomControl.loadPwad(params.filename, params.base64)
        : window.DoomControl.reloadCurrentMap();
      replyMcp(id, true, result);
    } catch (error) {
      replyMcp(id, false, error);
    }
  };
})();
