// Video recording for autoplay trials.
//
// The runner drives the engine one tic at a time while recording and hands the
// recorder a JPEG page screenshot per tic (game canvas plus the in-game
// overlay). Frames are piped into ffmpeg as an MJPEG stream at the engine's
// 35 Hz tic rate and encoded to VP8/WebM, so the video runs at game time: one
// frame per world tic, whatever the wall-clock pace of the trial was (Jev
// latency, screenshot cost and CPU load never appear as stutter).
//
// ffmpeg: the DOOM_MCP_FFMPEG path, else the build Playwright ships for its own
// video recording (ffmpeg-*/ffmpeg-linux under PLAYWRIGHT_BROWSERS_PATH or the
// default cache), else `ffmpeg` on PATH. The Playwright build is minimal but
// has exactly what this needs: image2pipe + mjpeg in, libvpx VP8 + webm out.

import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const TIC_RATE = 35;

function browsersPaths() {
  const paths = [];
  if (process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== '0') paths.push(process.env.PLAYWRIGHT_BROWSERS_PATH);
  paths.push(path.join(os.homedir(), '.cache', 'ms-playwright'));
  paths.push(path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'));
  if (process.env.LOCALAPPDATA) paths.push(path.join(process.env.LOCALAPPDATA, 'ms-playwright'));
  return paths;
}

async function bundledFfmpegCandidates() {
  const binary = process.platform === 'win32' ? 'ffmpeg-win64.exe' : process.platform === 'darwin' ? 'ffmpeg-mac' : 'ffmpeg-linux';
  const found = [];
  for (const base of browsersPaths()) {
    let entries = [];
    try { entries = await readdir(base); } catch { continue; }
    for (const entry of entries.filter(name => name.startsWith('ffmpeg')).sort().reverse()) {
      found.push(path.join(base, entry, binary));
    }
  }
  return found;
}

function probe(binary) {
  return new Promise(resolve => {
    let child;
    try { child = spawn(binary, ['-version'], { stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { resolve(false); return; }
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('error', () => resolve(false));
    child.on('close', code => resolve(code === 0 && /ffmpeg version/.test(out)));
  });
}

export async function findFfmpeg() {
  const candidates = [];
  if (process.env.DOOM_MCP_FFMPEG) candidates.push(process.env.DOOM_MCP_FFMPEG);
  candidates.push(...await bundledFfmpegCandidates());
  candidates.push('ffmpeg');
  for (const candidate of candidates) {
    if (candidate !== 'ffmpeg') {
      try { await stat(candidate); } catch { continue; }
    }
    if (await probe(candidate)) return candidate;
  }
  return null;
}

// One recorder per run. frame() takes the JPEG bytes of one captured frame and
// how many tics it stays on screen; the frame is written that many times so
// the output stays at a constant TIC_RATE frames per second.
export async function createRecorder({ outputPath, ffmpegPath, fps = TIC_RATE, bitrate = '1500k' }) {
  const binary = ffmpegPath || await findFfmpeg();
  if (!binary) throw new Error('ffmpeg not found (set DOOM_MCP_FFMPEG, install ffmpeg, or run `npx playwright install ffmpeg`)');
  const args = [
    '-loglevel', 'error', '-y',
    '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(fps), '-i', 'pipe:0',
    '-an',
    // VP8 needs even dimensions; the scale filter is one of the few the
    // Playwright build carries.
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v', 'libvpx', '-b:v', bitrate, '-qmin', '4', '-qmax', '40', '-crf', '10',
    '-deadline', 'realtime', '-speed', '6', '-threads', '2',
    '-pix_fmt', 'yuv420p',
    '-r', String(fps),
    outputPath
  ];
  const child = spawn(binary, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim()}`))));
  });
  exit.catch(() => {});
  child.stdin.on('error', () => {}); // surfaces through `exit`

  let queue = Promise.resolve();
  let frames = 0;
  let lastFrame = null;
  let failed = null;
  child.on('close', code => { if (code !== 0 && !failed) failed = new Error(`ffmpeg exited with code ${code}: ${stderr.trim()}`); });

  const write = buffer => new Promise(resolve => {
    if (child.stdin.destroyed || child.stdin.writableEnded) { resolve(); return; }
    if (!child.stdin.write(buffer)) child.stdin.once('drain', resolve);
    else resolve();
  });

  return {
    binary,
    outputPath,
    fps,
    get frames() { return frames; },
    get seconds() { return frames / fps; },
    frame(buffer, holdTics = 1) {
      if (failed) return Promise.reject(failed);
      const copies = Math.max(1, Math.trunc(holdTics));
      lastFrame = buffer;
      queue = queue.then(async () => {
        for (let i = 0; i < copies; i++) await write(buffer);
        frames += copies;
      });
      return queue;
    },
    // Keep the last frame on screen a little longer (end of run).
    hold(tics) {
      if (!lastFrame) return Promise.resolve();
      return this.frame(lastFrame, tics);
    },
    async finish() {
      await queue.catch(() => {});
      if (!child.stdin.writableEnded) child.stdin.end();
      await exit;
      let bytes = null;
      try { bytes = (await stat(outputPath)).size; } catch {}
      return { path: outputPath, frames, seconds: frames / fps, fps, bytes };
    },
    async abort() {
      try { child.kill('SIGKILL'); } catch {}
      await exit.catch(() => {});
    }
  };
}
