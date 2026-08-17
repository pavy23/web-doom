# Web DOOM

Actual DOOM-derived C engine running in the browser through WebAssembly, now with SDL2 sound support.

Live site:

`https://pavy23.github.io/web-doom/`

## Play modes

### Built-in shareware

The site includes the official shareware DOOM IWAD from SDL's DOOM project page.
It contains **Episode 1: Knee-Deep in the Dead**, including E1M1–E1M9.

### Load your own IWAD

Use **SELECT WAD** to load a WAD that you legally own from your computer.
The selected file is read into browser memory and is not uploaded to a server by this app.

Typical DOOM-family IWADs supported by the DOOM engine can be supplied this way, such as a user's own DOOM / DOOM II data.
Commercial IWADs are not hosted by this repository.

## Audio

The browser engine is built from `ozkl/doomgeneric` with:

- `FEATURE_SOUND`
- SDL2
- SDL2_mixer
- MIDI support in the Emscripten SDL_mixer port

Browsers require a user gesture before audio playback, so the game starts from a PLAY button rather than autoplaying.

## Controls

- WASD or Arrow keys: move / turn
- Ctrl or J: fire
- Space or E: use / open
- Shift: run
- 1–7: weapon selection
- Esc: menu

## Build / provenance

- Original id Software DOOM source release: https://github.com/id-Software/DOOM
- Browser source port: https://github.com/ozkl/doomgeneric
- Pinned doomgeneric commit: `dcb7a8dbc7a16ce3dda29382ac9aae9d77d21284`
- Toolchain: Emscripten 6.0.5
- Shareware IWAD source: https://www.libsdl.org/projects/doom/data/doom1.wad.zip
- Shareware IWAD version used by the build: v1.8, MD5 `5f4eb849b1af12887dec04a2a12e5e62`

Generated browser engine files:

- `engine.js`
- `engine.wasm`
- `doom1.wad`

Build glue lives in:

- `build/Makefile.web`
- `build/doomgeneric_web.c`
- `.github/workflows/pages.yml`

## License

doomgeneric and its DOOM-derived code are GPL licensed; the corresponding license is included as `DOOMGENERIC-LICENSE`.

The DOOM engine/source license is separate from commercial DOOM game data. This repository does not bundle commercial DOOM / DOOM II IWADs.
