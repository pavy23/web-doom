#!/usr/bin/env python3
"""Patch the P2.2 LinuxDOOM shell with public Classic/AI Deathmatch launch choices.

This runs only for the public P2.2 direct build. The generic checked-in shell
remains compatible with local MCP workflows. AI Deathmatch fetches the bundled
p22-demo.wad, writes it into the fresh Emscripten FS, stages it as the boot PWAD,
then starts four local LinuxDOOM player slots with Players 2-4 controlled by the
P2.2 live bot scheduler.

The Classic button deliberately keeps the legacy DOM id/class contract
`#start.ready:not([disabled])`. Existing P0/P1/P2 browser QA therefore continues
to select Classic mode without knowing about the new public dual launcher.
"""

from pathlib import Path
import sys


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: patch_public_p22_launcher.py <linuxdoom-source-dir>")

    path = Path(sys.argv[1]) / "shell.html"
    text = path.read_text(encoding="utf-8")

    old_button = '<button id="start" type="button" disabled>CLICK TO START</button>'
    new_buttons = '''<div id="launchChoices" aria-label="Game mode">
              <button id="start" class="launchChoice" type="button" disabled>PLAY CLASSIC DOOM</button>
              <button id="playAi" class="launchChoice" type="button" disabled>PLAY AI DEATHMATCH</button>
            </div>'''
    if new_buttons not in text:
        if old_button not in text:
            raise SystemExit("launcher button anchor not found")
        text = text.replace(old_button, new_buttons, 1)

    css = '''
    #launchChoices { display: none; margin: 18px auto 0; gap: 10px; justify-content: center; flex-wrap: wrap; }
    #launchChoices.ready { display: flex; }
    .launchChoice { min-width: 190px; padding: 13px 18px; font-size: 12px; font-weight: 900; letter-spacing: .08em; border-color: rgba(255,255,255,.45); background: #171717; }
    .launchChoice:disabled { opacity: .45; cursor: default; }
    #playAi { border-color: rgba(255,126,76,.72); }
'''
    if "#launchChoices {" not in text:
        marker = "  </style>"
        if marker not in text:
            raise SystemExit("style closing tag not found")
        text = text.replace(marker, css + marker, 1)

    old_ref = "    const startButton = document.getElementById('start');\n"
    new_ref = (
        "    const launchChoices = document.getElementById('launchChoices');\n"
        "    const playClassicButton = document.getElementById('start');\n"
        "    const playAiButton = document.getElementById('playAi');\n"
    )
    if new_ref not in text:
        if old_ref not in text:
            raise SystemExit("start button JS reference not found")
        text = text.replace(old_ref, new_ref, 1)

    old_ready = '''      startButton.disabled = false;\n      startButton.classList.add('ready');\n      audioNote.classList.add('ready');'''
    new_ready = '''      playClassicButton.disabled = false;\n      playClassicButton.classList.add('ready');\n      playAiButton.disabled = false;\n      launchChoices.classList.add('ready');\n      audioNote.textContent = 'Classic runs the original shareware campaign. AI Deathmatch loads the generated P2.2 arena with three local AI players.';\n      audioNote.classList.add('ready');'''
    if new_ready not in text:
        if old_ready not in text:
            raise SystemExit("showReady block not found")
        text = text.replace(old_ready, new_ready, 1)

    start_anchor = "    startButton.addEventListener('click', () => {"
    end_anchor = "\n\n    for (const eventName of ['pointerdown', 'keydown', 'touchstart'])"
    if start_anchor in text:
        start = text.index(start_anchor)
        end = text.index(end_anchor, start)
        replacement = r'''    const PUBLIC_P22_DEMO_WAD = 'p22-demo.wad';
    const PUBLIC_P22_BOTS = ['easy', 'normal', 'hard'];

    function setLaunchBusy(busy) {
      playClassicButton.disabled = Boolean(busy);
      playAiButton.disabled = Boolean(busy);
    }

    async function stagePublicDeathmatchWad() {
      if (!Module.FS || typeof Module.FS.writeFile !== 'function') {
        throw new Error('Emscripten filesystem is unavailable');
      }
      statusEl.textContent = 'Loading AI deathmatch arena…';
      const response = await fetch(PUBLIC_P22_DEMO_WAD, { cache: 'no-store' });
      if (!response.ok) throw new Error(`Failed to load ${PUBLIC_P22_DEMO_WAD}: HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length < 12 || bytes[0] !== 0x50 || bytes[1] !== 0x57 || bytes[2] !== 0x41 || bytes[3] !== 0x44) {
        throw new Error(`${PUBLIC_P22_DEMO_WAD} is not a PWAD`);
      }
      const virtualPath = `/${PUBLIC_P22_DEMO_WAD}`;
      try { Module.FS.unlink(virtualPath); } catch {}
      Module.FS.writeFile(virtualPath, bytes);
      const staged = Module.ccall('doomctl_set_boot_pwad_path', 'number', ['string'], [virtualPath]);
      if (Number(staged) <= 0) throw new Error(`Failed to stage ${PUBLIC_P22_DEMO_WAD}: ${staged}`);
      return bytes.length;
    }

    function configurePublicBots() {
      if (!window.DoomLocalBots || typeof window.DoomLocalBots.setSkill !== 'function') {
        throw new Error('P2.2 local bot runtime is unavailable');
      }
      PUBLIC_P22_BOTS.forEach((skill, index) => window.DoomLocalBots.setSkill(index + 1, skill));
      return window.DoomLocalBots.bootArgs();
    }

    async function startSelectedMode(mode) {
      if (!runtimeReady || gameStarted) return;
      gameStarted = true;
      setLaunchBusy(true);

      try {
        let args = [];
        if (mode === 'ai') {
          const bytes = await stagePublicDeathmatchWad();
          args = configurePublicBots();
          statusEl.textContent = `Starting AI Deathmatch · ${bytes} byte arena · EASY / NORMAL / HARD…`;
        } else {
          statusEl.textContent = 'Starting Classic DOOM + hardware-style OPL audio…';
        }

        const result = Module.callMain(args);
        if (mode === 'ai' && window.DoomLocalBots && typeof window.DoomLocalBots.onGameStarted === 'function') {
          window.DoomLocalBots.onGameStarted(Module);
        }
        window.DoomPublicLauncher = {
          mode,
          demoWad: mode === 'ai' ? PUBLIC_P22_DEMO_WAD : null,
          bots: mode === 'ai' ? [...PUBLIC_P22_BOTS] : [],
          startedAt: new Date().toISOString()
        };
        resumeAudioContext();
        hideLauncher();
        if (mcpSocket && mcpSocket.readyState === WebSocket.OPEN) {
          mcpSocket.send(JSON.stringify({ event: 'game_started', mode }));
        }
        if (result && typeof result.catch === 'function') {
          result.catch(err => {
            console.error(err);
            loading.classList.remove('hidden');
            statusEl.textContent = 'Startup failed — see browser console.';
          });
        }
      } catch (err) {
        console.error(err);
        gameStarted = false;
        setLaunchBusy(false);
        loading.classList.remove('hidden');
        statusEl.textContent = 'Startup failed — see browser console.';
      }
    }

    playClassicButton.addEventListener('click', () => { void startSelectedMode('classic'); });
    playAiButton.addEventListener('click', () => { void startSelectedMode('ai'); });'''
        text = text[:start] + replacement + text[end:]

    required = [
        "PLAY CLASSIC DOOM",
        "PLAY AI DEATHMATCH",
        'id="start" class="launchChoice"',
        "playClassicButton.classList.add('ready')",
        "stagePublicDeathmatchWad",
        "doomctl_set_boot_pwad_path",
        "PUBLIC_P22_BOTS = ['easy', 'normal', 'hard']",
        "DoomPublicLauncher",
    ]
    missing = [item for item in required if item not in text]
    if missing:
        raise SystemExit(f"public P2.2 launcher patch incomplete: {missing}")

    path.write_text(text, encoding="utf-8")
    print("Patched shell.html with PLAY CLASSIC DOOM / PLAY AI DEATHMATCH public launcher + legacy #start compatibility")


if __name__ == "__main__":
    main()
