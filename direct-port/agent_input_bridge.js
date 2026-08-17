// Browser-side MCP v0.8 autonomous input bridge.
//
// Uses the existing dedicated playtest WebSocket from playtest_bridge.js.
// The C controller owns input lifetime in actual world tics.

(function () {
  function requireAgentRuntime() {
    if (!window.DoomControl || typeof Module === 'undefined'
        || typeof Module.ccall !== 'function') {
      throw new Error('DOOM agent-input runtime is not ready');
    }
  }

  window.DoomControl.queueAgentInput = function queueAgentInput(params = {}) {
    requireAgentRuntime();
    const forward = Math.round(Number(params.forward || 0) * 100);
    const strafe = Math.round(Number(params.strafe || 0) * 100);
    const turn = Math.round(Number(params.turn || 0) * 100);
    const tics = Math.trunc(params.tics || 0);
    const remaining = Module.ccall(
      'doomctl_queue_agent_input', 'number',
      ['number', 'number', 'number', 'number', 'number', 'number'],
      [forward, strafe, turn, params.attack ? 1 : 0, params.use ? 1 : 0, tics]
    );
    if (remaining < 0) throw new Error(`Agent input rejected with engine code ${remaining}`);
    return window.DoomControl.getAgentInputStatus();
  };

  window.DoomControl.cancelAgentInput = function cancelAgentInput() {
    requireAgentRuntime();
    const cancelled = Module.ccall('doomctl_cancel_agent_input', 'number', [], []);
    return { cancelled: Boolean(cancelled), status: window.DoomControl.getAgentInputStatus() };
  };

  window.DoomControl.getAgentInputStatus = function getAgentInputStatus() {
    requireAgentRuntime();
    const json = Module.ccall('doomctl_get_agent_input_status_json', 'string', [], []);
    return JSON.parse(json);
  };

  if (typeof handlePlaytestRequest !== 'function' || typeof replyPlaytest !== 'function') {
    console.error('DOOM MCP agent bridge could not find playtest dispatcher');
    return;
  }

  const previousHandlePlaytestRequest = handlePlaytestRequest;
  handlePlaytestRequest = function agentHandlePlaytestRequest(message) {
    const { id, method, params = {} } = message || {};
    if (!id || !method) return previousHandlePlaytestRequest(message);

    if (!['queue_agent_input', 'cancel_agent_input', 'get_agent_input_status'].includes(method)) {
      return previousHandlePlaytestRequest(message);
    }

    try {
      let result;
      switch (method) {
        case 'queue_agent_input':
          result = window.DoomControl.queueAgentInput(params);
          break;
        case 'cancel_agent_input':
          result = window.DoomControl.cancelAgentInput();
          break;
        case 'get_agent_input_status':
          result = window.DoomControl.getAgentInputStatus();
          break;
        default:
          throw new Error(`Unknown agent-input method: ${method}`);
      }
      replyPlaytest(id, true, result);
    } catch (error) {
      replyPlaytest(id, false, error);
    }
  };
})();
