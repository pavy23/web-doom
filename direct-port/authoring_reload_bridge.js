// Pre-JS extension loaded by the generated Emscripten runtime after shell.html
// has defined window.DoomControl and the localhost MCP dispatcher.
//
// PWAD bytes arrive from the local MCP server as base64, are written into the
// in-memory Emscripten filesystem, and are then handed to LinuxDOOM's own WAD
// append + deferred map-restart adapter. Imported files intentionally remain in
// FS because W_AddFile keeps an open file handle for their lumps.

(function () {
  const RELOAD_TIMEOUT_MS = 10000;
  const RELOAD_POLL_MS = 25;

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

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Emscripten SDL2's default assertion UI and its default stdin fallback both
  // use window.prompt(). A modal prompt is unsafe while an MCP reload is in
  // progress. Keep suppression scoped to the whole asynchronous reload window,
  // log the exact message for diagnosis, and restore the original prompt when
  // the deferred gameaction has completed or timed out.
  async function withoutInteractivePrompt(operation) {
    const originalPrompt = window.prompt;
    window.prompt = function doomMcpReloadPrompt(message) {
      const text = String(message || '');
      console.warn('DOOM MCP suppressed interactive prompt during PWAD reload:', text);

      if (/Abort\/Retry\/Ignore\/AlwaysIgnore\?/i.test(text)) return 'i';
      return null;
    };

    try {
      return await operation();
    } finally {
      window.prompt = originalPrompt;
    }
  }

  async function waitForReloadCompletion(timeoutMs = RELOAD_TIMEOUT_MS) {
    const deadline = performance.now() + timeoutMs;
    let last = null;

    // Always yield once so the browser can return to LinuxDOOM's main loop and
    // let G_Ticker consume the ga_newgame scheduled by G_DeferedInitNew().
    await delay(RELOAD_POLL_MS);

    while (performance.now() < deadline) {
      const json = Module.ccall('doomctl_reload_status_json', 'string', [], []);
      last = JSON.parse(json);

      if (last.completed && !last.pending) return last;
      await delay(RELOAD_POLL_MS);
    }

    throw new Error(`PWAD reload timed out after ${timeoutMs} ms${last ? `: ${JSON.stringify(last)}` : ''}`);
  }

  window.DoomControl.loadPwad = async function loadPwad(filename, base64) {
    requireAuthoringRuntime();
    const bytes = decodeBase64(base64);
    if (bytes.length < 12) throw new Error('PWAD payload is too small');
    if (bytes.length > 16 * 1024 * 1024) throw new Error('PWAD payload exceeds 16 MiB import limit');

    const safeName = safeImportName(filename);
    const virtualPath = `/mcp_import_${Date.now()}_${safeName}`;
    Module.FS.writeFile(virtualPath, bytes);

    return withoutInteractivePrompt(async () => {
      const json = Module.ccall('doomctl_load_pwad_json', 'string', ['string'], [virtualPath]);
      const scheduled = JSON.parse(json);
      if (!scheduled.loaded) {
        throw new Error(scheduled.error || `PWAD load failed (${scheduled.code || 'unknown'})`);
      }

      const completion = await waitForReloadCompletion();
      return {
        ...scheduled,
        ...completion,
        loaded: true,
        filename: safeName,
        virtualPath,
        bytes: bytes.length
      };
    });
  };

  window.DoomControl.reloadCurrentMap = async function reloadCurrentMap() {
    requireAuthoringRuntime();

    return withoutInteractivePrompt(async () => {
      const json = Module.ccall('doomctl_reload_current_map_json', 'string', [], []);
      const scheduled = JSON.parse(json);
      if (!scheduled.reloaded) throw new Error(scheduled.error || 'Map reload failed');

      const completion = await waitForReloadCompletion();
      return { ...scheduled, ...completion, reloaded: true };
    });
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

    const operation = method === 'load_pwad'
      ? window.DoomControl.loadPwad(params.filename, params.base64)
      : window.DoomControl.reloadCurrentMap();

    Promise.resolve(operation)
      .then(result => replyMcp(id, true, result))
      .catch(error => replyMcp(id, false, error));
  };
})();
