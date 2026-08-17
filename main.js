'use strict';

var memory = new WebAssembly.Memory({ initial: 108 });
const output = document.getElementById('output');
const boot = document.getElementById('boot');
const bootStatus = document.getElementById('bootStatus');
const bootError = document.getElementById('bootError');

function readWasmString(offset, length) {
  const bytes = new Uint8Array(memory.buffer, offset, length);
  return new TextDecoder('utf8').decode(bytes);
}

function appendOutput(style) {
  return function(offset, length) {
    const lines = readWasmString(offset, length).split('\n');
    for (let i = 0; i < lines.length; ++i) {
      if (!lines[i].length) continue;
      const t = document.createElement('span');
      t.classList.add(style);
      t.appendChild(document.createTextNode(lines[i]));
      output.appendChild(t);
      output.appendChild(document.createElement('br'));
    }
  };
}

let getmsCallsTotal = 0;
let getmsCalls = 0;
setInterval(function() {
  getmsCallsTotal += getmsCalls;
  document.getElementById('getmsps_stats').innerText = getmsCalls / 1000 + 'k';
  document.getElementById('getms_stats').innerText = getmsCallsTotal;
  getmsCalls = 0;
}, 1000);

function getMilliseconds() {
  ++getmsCalls;
  return performance.now();
}

const canvas = document.getElementById('screen');
const doomScreenWidth = 640;
const doomScreenHeight = 400;
const ctx = canvas.getContext('2d', { alpha: false });
ctx.imageSmoothingEnabled = false;

let numberOfDrawsTotal = 0;
let numberOfDraws = 0;
setInterval(function() {
  numberOfDrawsTotal += numberOfDraws;
  document.getElementById('drawframes_stats').innerText = numberOfDrawsTotal;
  document.getElementById('fps_stats').innerText = numberOfDraws;
  numberOfDraws = 0;
}, 1000);

function drawCanvas(ptr) {
  const doomScreen = new Uint8ClampedArray(memory.buffer, ptr, doomScreenWidth * doomScreenHeight * 4);
  const renderScreen = new ImageData(doomScreen, doomScreenWidth, doomScreenHeight);
  ctx.putImageData(renderScreen, 0, 0);
  ++numberOfDraws;
}

const importObject = {
  js: {
    js_console_log: appendOutput('log'),
    js_stdout: appendOutput('stdout'),
    js_stderr: appendOutput('stderr'),
    js_milliseconds_since_start: getMilliseconds,
    js_draw_screen: drawCanvas,
  },
  env: { memory }
};

async function instantiateDoom() {
  bootStatus.textContent = 'LOADING DOOM.WASM…';
  try {
    return await WebAssembly.instantiateStreaming(fetch('doom.wasm'), importObject);
  } catch (streamError) {
    console.warn('instantiateStreaming failed, falling back to ArrayBuffer:', streamError);
    bootStatus.textContent = 'LOADING DOOM.WASM (FALLBACK)…';
    const response = await fetch('doom.wasm');
    if (!response.ok) throw new Error('doom.wasm HTTP ' + response.status);
    const bytes = await response.arrayBuffer();
    return await WebAssembly.instantiate(bytes, importObject);
  }
}

instantiateDoom().then(obj => {
  bootStatus.textContent = 'STARTING DOOM…';
  obj.instance.exports.main();

  function doomKeyCode(keyCode) {
    switch (keyCode) {
      case 8: return 127;
      case 17: return 0x80 + 0x1d;
      case 18: return 0x80 + 0x38;
      case 37: return 0xac;
      case 38: return 0xad;
      case 39: return 0xae;
      case 40: return 0xaf;
      default:
        if (keyCode >= 65 && keyCode <= 90) return keyCode + 32;
        if (keyCode >= 112 && keyCode <= 123) return keyCode + 75;
        return keyCode;
    }
  }

  const keyDown = keyCode => obj.instance.exports.add_browser_event(0, keyCode);
  const keyUp = keyCode => obj.instance.exports.add_browser_event(1, keyCode);

  canvas.addEventListener('keydown', function(event) {
    keyDown(doomKeyCode(event.keyCode));
    event.preventDefault();
  }, false);

  canvas.addEventListener('keyup', function(event) {
    keyUp(doomKeyCode(event.keyCode));
    event.preventDefault();
  }, false);

  [
    ['enterButton', 13],
    ['leftButton', 0xac],
    ['rightButton', 0xae],
    ['upButton', 0xad],
    ['downButton', 0xaf],
    ['ctrlButton', 0x80 + 0x1d],
    ['spaceButton', 32],
    ['altButton', 0x80 + 0x38]
  ].forEach(([elementID, keyCode]) => {
    const button = document.getElementById(elementID);
    const press = e => { e.preventDefault(); keyDown(keyCode); };
    const release = e => { e.preventDefault(); keyUp(keyCode); };
    button.addEventListener('touchstart', press, { passive: false });
    button.addEventListener('touchend', release, { passive: false });
    button.addEventListener('touchcancel', release, { passive: false });
    button.addEventListener('mousedown', press);
    button.addEventListener('mouseup', release);
    button.addEventListener('mouseleave', release);
  });

  const focusHint = document.getElementById('focushint');
  function focused() {
    focusHint.innerText = 'Keyboard captured · Arrow keys move/turn · Ctrl fire · Space use · Shift run';
    focusHint.style.fontWeight = 'normal';
  }
  canvas.addEventListener('focusin', focused, false);
  canvas.addEventListener('focusout', function() {
    focusHint.innerText = 'Click the DOOM canvas to capture keyboard input.';
    focusHint.style.fontWeight = 'bold';
  }, false);
  canvas.addEventListener('click', () => canvas.focus());

  canvas.focus();
  focused();
  boot.classList.add('hidden');

  let animationFrames = 0;
  setInterval(function() {
    document.getElementById('animationfps_stats').innerText = animationFrames;
    animationFrames = 0;
  }, 1000);

  function step() {
    ++animationFrames;
    obj.instance.exports.doom_loop_step();
    window.requestAnimationFrame(step);
  }
  window.requestAnimationFrame(step);
}).catch(err => {
  console.error(err);
  bootStatus.textContent = 'FAILED TO START';
  bootError.textContent = String(err && (err.stack || err.message) || err);
});
