// Load a PWAD from the start URL before webdoom.js runs.
// Supports: ?mcpCold=1&mcpCandidate=file.wad  or  ?wad=file.wad
(function () {
  const COLD_BOOT_STORAGE_KEY = 'doom.mcp.coldBoot.v21';
  const params = new URLSearchParams(location.search);
  const raw = String(params.get('mcpCandidate') || params.get('wad') || '').trim();
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '');
  const name = !cleaned ? '' : (cleaned.toLowerCase().endsWith('.wad') ? cleaned : `${cleaned}.wad`);

  function loadEngine() {
    const script = document.createElement('script');
    script.src = 'webdoom.js';
    script.async = true;
    document.body.appendChild(script);
  }

  function bytesToBase64(bytes) {
    let out = '';
    for (let offset = 0; offset < bytes.length; offset += 32768) {
      out += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    }
    return btoa(out);
  }

  function setStatus(text) {
    const statusEl = document.getElementById('status');
    if (statusEl) statusEl.textContent = text;
  }

  async function fetchCandidate(filename) {
    const urls = [`/exports/${encodeURIComponent(filename)}`, `/${encodeURIComponent(filename)}`];
    let lastError = `Candidate ${filename} was not found`;
    for (const url of urls) {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) {
        lastError = `HTTP ${response.status} fetching ${url}`;
        continue;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length < 12 || bytes[0] !== 0x50 || bytes[1] !== 0x57 || bytes[2] !== 0x41 || bytes[3] !== 0x44) {
        throw new Error(`Fetched ${url} is not a PWAD`);
      }
      return bytes;
    }
    throw new Error(lastError);
  }

  async function stageFromUrl() {
    setStatus(`Fetching candidate ${name}…`);
    const bytes = await fetchCandidate(name);
    sessionStorage.setItem(COLD_BOOT_STORAGE_KEY, JSON.stringify({
      filename: name,
      base64: bytesToBase64(bytes),
      stagedAt: new Date().toISOString()
    }));
    if (params.get('mcpCold') !== '1' || params.get('mcpCandidate') !== name) {
      const next = new URL(location.href);
      next.searchParams.delete('wad');
      next.searchParams.set('mcpCold', '1');
      next.searchParams.set('mcpCandidate', name);
      location.replace(next.href);
      return;
    }
    setStatus(`Candidate staged: ${name}`);
    loadEngine();
  }

  if (!name) {
    loadEngine();
    return;
  }

  stageFromUrl().catch(error => {
    const audioNote = document.getElementById('audioNote');
    setStatus('Candidate fetch failed.');
    if (audioNote) {
      audioNote.textContent = String(error?.message || error);
      audioNote.classList.add('ready');
    }
    console.error('DOOM URL WAD bootstrap failed:', error);
  });
})();
