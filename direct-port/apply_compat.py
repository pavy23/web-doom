#!/usr/bin/env python3
"""Minimal source compatibility/platform edits for the direct LinuxDOOM browser build.

The upstream 1997 gameplay/rendering code remains intact. These edits only resolve
modern-toolchain collisions and separate our browser music bridge from i_sound.c.
Every replacement fails closed if the expected source text is not present.
"""
from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit("usage: apply_compat.py /path/to/linuxdoom-1.10")

root = Path(sys.argv[1])

# Emscripten's compat/string.h already declares `char *strupr(char *)`, while
# LinuxDOOM 1.10 contains a local `void strupr(char *)`. Rename only Doom's
# private helper and its single call site.
p = root / "w_wad.c"
s = p.read_text()
replacements = [
    ("void strupr (char* s)", "static void doom_strupr (char* s)"),
    ("    strupr (name8.s);", "    doom_strupr (name8.s);"),
]
for old, new in replacements:
    if old not in s:
        raise SystemExit(f"expected source text not found in {p}: {old!r}")
    s = s.replace(old, new, 1)
p.write_text(s)

# direct-port/i_sound_web.c originally carried the browser music synthesizer
# inline as a large EM_JS block. Keep the DOOM-facing i_sound implementation
# unchanged, but replace only that implementation block with declarations for
# direct-port/i_music_opl_bridge.c. This isolates music-engine iteration from
# the SFX backend and the original LinuxDOOM sound API.
p = root / "i_sound.c"
s = p.read_text()
start_marker = "EM_JS(void, web_music_js_start,"
end_marker = "void I_InitSound(void)"
start = s.find(start_marker)
end = s.find(end_marker, start)
if start < 0 or end < 0 or end <= start:
    raise SystemExit(f"expected browser music bridge markers not found in {p}")

bridge_decls = """void web_music_js_start(const unsigned char *ptr, int len, int looping, int volume);\nvoid web_music_js_stop(void);\nvoid web_music_js_pause(void);\nvoid web_music_js_resume(void);\nvoid web_music_js_set_volume(int volume);\n\n"""
s = s[:start] + bridge_decls + s[end:]
p.write_text(s)

print("Applied LinuxDOOM/Emscripten compatibility/platform edits:")
print(" - w_wad.c: private strupr helper renamed to doom_strupr")
print(" - i_sound.c: inline WebAudio music block replaced by external OPL bridge declarations")
