import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.resolve(process.env.DOOM_ZDBSP_CACHE || path.join(MODULE_DIR, '.cache', 'zdbsp'));
const MODULE_PATH = path.join(CACHE_DIR, 'Zdbsp.mjs');
const WASM_PATH = path.join(CACHE_DIR, 'zdbsp.wasm');

// Immutable upstream wrapper commit. Its demo artifacts are small enough to cache locally.
// Each download is verified with the exact Git blob SHA before execution.
export const ZDBSP_WASM_WRAPPER_COMMIT = 'acc45bf6b2232a75bdbb0b6295822e72e13dfeec';
const FILES = [
  {
    path: MODULE_PATH,
    url: `https://raw.githubusercontent.com/seanmorris/zdbsp-wasm/${ZDBSP_WASM_WRAPPER_COMMIT}/docs/Zdbsp.mjs`,
    gitBlob: '80aa83b4da1a38d3e01458b7660974cb8ce3cb87'
  },
  {
    path: WASM_PATH,
    url: `https://raw.githubusercontent.com/seanmorris/zdbsp-wasm/${ZDBSP_WASM_WRAPPER_COMMIT}/docs/zdbsp.wasm`,
    gitBlob: 'ba4c8f15c6a594d6618af73cebe3691184bd8b0b'
  }
];

function gitBlobSha(bytes) {
  const data = Buffer.from(bytes);
  return createHash('sha1').update(Buffer.from(`blob ${data.length}\0`)).update(data).digest('hex');
}

async function verified(pathname, expected) {
  try {
    const bytes = await readFile(pathname);
    return gitBlobSha(bytes) === expected;
  } catch {
    return false;
  }
}

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchVerifiedArtifact(item) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetch(item.url, { redirect: 'follow', cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const actual = gitBlobSha(bytes);
      if (actual !== item.gitBlob) {
        throw new Error(`Git blob hash mismatch: expected ${item.gitBlob}, got ${actual}`);
      }
      await writeFile(item.path, bytes);
      if (!(await verified(item.path, item.gitBlob))) throw new Error('cache verification failed after write');
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 4) await sleep(attempt * 1200);
    }
  }
  throw new Error(`Failed to fetch pinned ZDBSP WASM artifact ${path.basename(item.path)} after retries: ${lastError?.message || lastError}`);
}

export async function nodeBuilderStatus() {
  const files = [];
  for (const item of FILES) {
    let exists = false;
    try { await access(item.path); exists = true; } catch {}
    files.push({ name: path.basename(item.path), exists, verified: exists ? await verified(item.path, item.gitBlob) : false, gitBlob: item.gitBlob });
  }
  return {
    ready: files.every(file => file.verified),
    cacheDir: CACHE_DIR,
    wrapperCommit: ZDBSP_WASM_WRAPPER_COMMIT,
    files
  };
}

export async function prepareNodeBuilder() {
  await mkdir(CACHE_DIR, { recursive: true });
  for (const item of FILES) {
    if (await verified(item.path, item.gitBlob)) continue;
    await fetchVerifiedArtifact(item);
  }
  const status = await nodeBuilderStatus();
  if (!status.ready) throw new Error('ZDBSP WASM cache could not be verified');
  return status;
}

async function allocArgv(module, args) {
  const ptrs = args.map(text => {
    const value = String(text);
    const len = module.lengthBytesUTF8(value) + 1;
    const ptr = module._malloc(len);
    module.stringToUTF8(value, ptr, len);
    return ptr;
  });
  const argv = module._malloc(ptrs.length * 4);
  ptrs.forEach((ptr, i) => module.setValue(argv + i * 4, ptr, '*'));
  return { ptrs, argv };
}

export async function rebuildVanillaNodes(inputBytes, mapName) {
  await prepareNodeBuilder();
  // A fresh ES-module instance avoids stale getopt/static state between builds.
  const factoryModule = await import(`${pathToFileURL(MODULE_PATH).href}?run=${Date.now()}-${Math.random()}`);
  const Zdbsp = factoryModule.default;
  const output = [];
  const errors = [];
  const zdbsp = await Zdbsp({
    locateFile(name) { return name.endsWith('.wasm') ? pathToFileURL(WASM_PATH).href : name; },
    print(line) { output.push(String(line)); },
    printErr(line) { errors.push(String(line)); }
  });
  const source = '/geometry-source.wad';
  const target = '/geometry-built.wad';
  zdbsp.FS.writeFile(source, new Uint8Array(Buffer.from(inputBytes)));

  // Match the upstream wrapper demo: -o output syntax plus async ccall. Long
  // options select the vanilla-compatible derived-data policy we need.
  const args = [
    'zdbsp',
    '--zero-reject',
    '--no-prune',
    `--map=${String(mapName).toUpperCase()}`,
    source,
    '-o',
    target
  ];
  const { ptrs, argv } = await allocArgv(zdbsp, args);
  let exitCode = 0;
  try {
    const result = await zdbsp.ccall(
      'main',
      'number',
      ['number', 'number'],
      [args.length, argv],
      { async: true }
    );
    if (Number.isFinite(result)) exitCode = Number(result);
  } catch (error) {
    // Emscripten main may report a normal process exit as ExitStatus(0).
    if (typeof error?.status === 'number' && error.status === 0) exitCode = 0;
    else throw new Error(`ZDBSP failed: ${error?.message || error}\n${errors.join('\n')}`);
  } finally {
    ptrs.forEach(ptr => zdbsp._free(ptr));
    zdbsp._free(argv);
  }
  if (exitCode !== 0) throw new Error(`ZDBSP exited with code ${exitCode}: ${errors.join('\n')}`);
  let built;
  try { built = Buffer.from(zdbsp.FS.readFile(target)); }
  catch { throw new Error(`ZDBSP did not produce ${target}: ${errors.join('\n') || output.join('\n')}`); }
  if (built.length < 12 || built.subarray(0, 4).toString('ascii') !== 'PWAD') throw new Error('ZDBSP output is not a PWAD');
  return {
    bytes: built,
    log: output.slice(-40),
    warnings: errors.slice(-40),
    builder: { wrapperCommit: ZDBSP_WASM_WRAPPER_COMMIT, mode: 'WASM', flags: ['--zero-reject', '--no-prune', `--map=${String(mapName).toUpperCase()}`] }
  };
}
