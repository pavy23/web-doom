'use strict';

(() => {
  const canvas = document.getElementById('canvas');
  const game = document.getElementById('game');
  const launcher = document.getElementById('launcher');
  const playShareware = document.getElementById('playShareware');
  const playWad = document.getElementById('playWad');
  const wadFile = document.getElementById('wadFile');
  const selected = document.getElementById('selected');
  const bootStatus = document.getElementById('bootStatus');
  const bootError = document.getElementById('bootError');
  const restart = document.getElementById('restart');
  const fullscreen = document.getElementById('fullscreen');
  const focusHint = document.getElementById('focushint');

  let Module = null;
  let selectedWad = null;
  let selectedWadName = null;
  let starting = false;
  let started = false;

  function status(text) {
    bootStatus.textContent = text;
  }

  function showError(err) {
    console.error(err);
    bootError.textContent = String(err && (err.stack || err.message) || err);
    status('FAILED TO START');
  }

  function humanSize(bytes) {
    const mb = bytes / 1024 / 1024;
    return `${mb.toFixed(mb >= 10 ? 1 : 2)} MB`;
  }

  async function resumeAudio() {
    // Emscripten's SDL layers create the AudioContext when the game starts.
    // Because startWithWad() is invoked directly from a click, browsers allow
    // us to resume it here if the context was created in a suspended state.
    const candidates = [];

    if (globalThis.SDL && globalThis.SDL.audioContext) {
      candidates.push(globalThis.SDL.audioContext);
    }
    if (globalThis.SDL2 && globalThis.SDL2.audioContext) {
      candidates.push(globalThis.SDL2.audioContext);
    }
    if (Module && Module.SDL && Module.SDL.audioContext) {
      candidates.push(Module.SDL.audioContext);
    }

    for (const ctx of candidates) {
      try {
        if (ctx && ctx.state === 'suspended') {
          await ctx.resume();
        }
      } catch (err) {
        console.warn('Could not resume an audio context:', err);
      }
    }
  }

  async function createEngine() {
    if (typeof createDoomModule !== 'function') {
      throw new Error('engine.js loaded, but createDoomModule() was not found.');
    }

    status('INITIALIZING SOUND ENGINE…');

    Module = await createDoomModule({
      canvas,
      noInitialRun: true,
      locateFile(path) {
        if (path.endsWith('.wasm')) return './engine.wasm';
        return path;
      },
      print(text) {
        console.log('[DOOM]', text);
      },
      printErr(text) {
        console.error('[DOOM]', text);
      }
    });

    status('ENGINE READY · CLICK PLAY TO ENABLE AUDIO');
    playShareware.disabled = false;
    playWad.disabled = !selectedWad;
  }

  async function loadBuiltInShareware() {
    status('LOADING SHAREWARE EPISODE 1…');
    const response = await fetch('./doom1.wad', { cache: 'force-cache' });
    if (!response.ok) {
      throw new Error(`doom1.wad HTTP ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async function startWithWad(bytes, label) {
    if (!Module || starting || started) return;

    starting = true;
    playShareware.disabled = true;
    playWad.disabled = true;
    wadFile.disabled = true;
    bootError.textContent = '';

    try {
      status(`MOUNTING ${label.toUpperCase()}…`);

      try {
        Module.FS.unlink('/game.wad');
      } catch (_) {
        // First launch: file does not exist yet.
      }

      Module.FS.writeFile('/game.wad', bytes);

      // callMain happens as part of the user's click gesture, which is
      // important for browser audio autoplay policies.
      status('STARTING DOOM + AUDIO…');
      Module.callMain(['-iwad', '/game.wad']);
      await resumeAudio();

      started = true;
      launcher.classList.add('hidden');
      canvas.focus();
      focusHint.textContent = `${label} · Sound enabled · WASD/Arrows move · Ctrl/J fire · Space/E use`;
    } catch (err) {
      // Some Emscripten main-loop configurations use an internal unwind
      // sentinel. Only ignore the known non-error unwind form.
      const text = String(err && (err.message || err) || err);
      if (text === 'unwind' || text.includes('unwind')) {
        started = true;
        launcher.classList.add('hidden');
        canvas.focus();
        await resumeAudio();
      } else {
        showError(err);
        wadFile.disabled = false;
        playShareware.disabled = false;
        playWad.disabled = !selectedWad;
      }
    } finally {
      starting = false;
    }
  }

  playShareware.addEventListener('click', async () => {
    if (!Module || starting || started) return;
    try {
      const wad = await loadBuiltInShareware();
      await startWithWad(wad, 'DOOM Shareware Episode 1');
    } catch (err) {
      showError(err);
      playShareware.disabled = false;
      playWad.disabled = !selectedWad;
      wadFile.disabled = false;
    }
  });

  wadFile.addEventListener('change', async () => {
    const file = wadFile.files && wadFile.files[0];
    if (!file) return;

    if (!file.name.toLowerCase().endsWith('.wad')) {
      selectedWad = null;
      selectedWadName = null;
      selected.textContent = 'Please select a .wad file.';
      playWad.disabled = true;
      return;
    }

    try {
      selected.textContent = `Reading ${file.name} locally…`;
      selectedWad = new Uint8Array(await file.arrayBuffer());
      selectedWadName = file.name;
      selected.textContent = `${file.name} · ${humanSize(file.size)} · stays in browser memory`;
      playWad.disabled = !Module;
    } catch (err) {
      selectedWad = null;
      selectedWadName = null;
      playWad.disabled = true;
      showError(err);
    }
  });

  playWad.addEventListener('click', async () => {
    if (!Module || !selectedWad || starting || started) return;
    await startWithWad(selectedWad, selectedWadName || 'Local WAD');
  });

  restart.addEventListener('click', () => location.reload());

  fullscreen.addEventListener('click', async () => {
    try {
      if (!document.fullscreenElement) {
        await game.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
      canvas.focus();
    } catch (err) {
      console.warn('Fullscreen failed:', err);
    }
  });

  canvas.addEventListener('click', async () => {
    canvas.focus();
    if (started) await resumeAudio();
  });

  createEngine().catch(showError);
})();
