// Browser-side AI playtest bridge for MCP v0.7.
//
// Frame capture uses the final SDL/Emscripten canvas, so the image returned to
// the MCP client is the same composed frame a human sees (3D view, status bar,
// automap/menu overlays when present). Pause/tic control itself lives in C.

(function () {
  function requirePlaytestRuntime() {
    if (!window.DoomControl || typeof Module === 'undefined'
        || typeof Module.ccall !== 'function') {
      throw new Error('DOOM playtest runtime is not ready');
    }
  }

  function parseEngineJson(name) {
    const json = Module.ccall(name, 'string', [], []);
    return JSON.parse(json);
  }

  window.DoomControl.setPlaytestPaused = function setPlaytestPaused(paused) {
    requirePlaytestRuntime();
    const state = Module.ccall('doomctl_set_playtest_paused', 'number', ['number'], [paused ? 1 : 0]);
    if (state < 0) throw new Error(`Playtest pause failed with engine code ${state}`);
    return { paused: Boolean(state) };
  };

  window.DoomControl.stepPlaytestTics = function stepPlaytestTics(count) {
    requirePlaytestRuntime();
    const budget = Module.ccall('doomctl_step_playtest_tics', 'number', ['number'], [Math.trunc(count)]);
    if (budget < 0) throw new Error(`Playtest step failed with engine code ${budget}`);
    return { queued: Math.trunc(count), stepBudget: budget };
  };

  window.DoomControl.getPlaytestTelemetry = function getPlaytestTelemetry() {
    requirePlaytestRuntime();
    return parseEngineJson('doomctl_get_playtest_telemetry_json');
  };

  window.DoomControl.resetPlaytestMetrics = function resetPlaytestMetrics() {
    requirePlaytestRuntime();
    const reset = Module.ccall('doomctl_reset_playtest_metrics', 'number', [], []);
    if (reset < 0) throw new Error(`Playtest metric reset failed with engine code ${reset}`);
    return window.DoomControl.getPlaytestTelemetry();
  };

  window.DoomControl.captureFrame = function captureFrame() {
    requirePlaytestRuntime();
    const canvas = Module.canvas || document.getElementById('canvas');
    if (!canvas || typeof canvas.toDataURL !== 'function') {
      throw new Error('DOOM render canvas is unavailable');
    }

    const url = canvas.toDataURL('image/png');
    const marker = 'data:image/png;base64,';
    if (!url.startsWith(marker)) throw new Error('Canvas PNG capture failed');
    return {
      mimeType: 'image/png',
      width: canvas.width,
      height: canvas.height,
      base64: url.slice(marker.length),
      telemetry: window.DoomControl.getPlaytestTelemetry()
    };
  };

  if (typeof handleMcpRequest !== 'function' || typeof replyMcp !== 'function') {
    console.error('DOOM MCP playtest bridge could not find shell dispatcher');
    return;
  }

  const previousHandleMcpRequest = handleMcpRequest;
  handleMcpRequest = function playtestHandleMcpRequest(message) {
    const { id, method, params = {} } = message || {};
    if (!id || !method) return previousHandleMcpRequest(message);

    if (!['set_playtest_paused', 'step_playtest_tics', 'get_playtest_telemetry',
          'reset_playtest_metrics', 'capture_frame'].includes(method)) {
      return previousHandleMcpRequest(message);
    }

    try {
      let result;
      switch (method) {
        case 'set_playtest_paused':
          result = window.DoomControl.setPlaytestPaused(Boolean(params.paused));
          break;
        case 'step_playtest_tics':
          result = window.DoomControl.stepPlaytestTics(params.count);
          break;
        case 'get_playtest_telemetry':
          result = window.DoomControl.getPlaytestTelemetry();
          break;
        case 'reset_playtest_metrics':
          result = window.DoomControl.resetPlaytestMetrics();
          break;
        case 'capture_frame':
          result = window.DoomControl.captureFrame();
          break;
        default:
          throw new Error(`Unknown playtest method: ${method}`);
      }
      replyMcp(id, true, result);
    } catch (error) {
      replyMcp(id, false, error);
    }
  };
})();
