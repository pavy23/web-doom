// Bridge between LinuxDOOM's i_sound music calls and the repository-owned
// browser OPL2-style music engine in direct-port/opl_music.js.

#include <emscripten.h>

EM_JS(void, web_music_js_start,
      (const unsigned char *ptr, int len, int looping, int volume),
{
    if (!globalThis.DoomOPL2Music || !globalThis.DoomOPL2Music.start) {
        console.error('DOOM music: opl_music.js is not loaded');
        return;
    }

    const mus = HEAPU8.slice(ptr, ptr + len);
    globalThis.DoomOPL2Music.start(mus, !!looping, volume);
});

EM_JS(void, web_music_js_stop, (), {
    if (globalThis.DoomOPL2Music && globalThis.DoomOPL2Music.stop)
        globalThis.DoomOPL2Music.stop();
});

EM_JS(void, web_music_js_pause, (), {
    if (globalThis.DoomOPL2Music && globalThis.DoomOPL2Music.pause)
        globalThis.DoomOPL2Music.pause();
});

EM_JS(void, web_music_js_resume, (), {
    if (globalThis.DoomOPL2Music && globalThis.DoomOPL2Music.resume)
        globalThis.DoomOPL2Music.resume();
});

EM_JS(void, web_music_js_set_volume, (int volume), {
    if (globalThis.DoomOPL2Music && globalThis.DoomOPL2Music.setVolume)
        globalThis.DoomOPL2Music.setVolume(volume);
});
