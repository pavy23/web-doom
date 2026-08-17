#!/usr/bin/env python3
"""Minimal source compatibility edits for the direct LinuxDOOM browser build.

The upstream 1997 gameplay/rendering code remains intact. Browser platform files are
installed explicitly by CI; this script only resolves narrow modern-toolchain source
collisions and restores DOS-era audio scaling that the Linux music-disabled port had
commented out. Music adaptation is handled separately by import_vanilla_opl.py.
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

# LinuxDOOM disabled music on the Unix target and commented out the DOS
# 0..15 menu-volume -> 0..120 internal-volume scaling. Our imported DMX/OPL
# backend expects the internal 0..127 scale, just like modern Vanilla-accurate
# source ports do, so restore the original *8 handoff at startup and in the
# sound menu. This also puts SFX volume on the same historical internal scale.
p = root / "d_main.c"
s = p.read_text()
old = "S_Init (snd_SfxVolume /* *8 */, snd_MusicVolume /* *8*/ );"
new = "S_Init (snd_SfxVolume * 8, snd_MusicVolume * 8);"
if old not in s:
    raise SystemExit(f"expected DOS audio scaling anchor not found in {p}: {old!r}")
s = s.replace(old, new, 1)
p.write_text(s)

p = root / "m_menu.c"
s = p.read_text()
menu_replacements = [
    ("S_SetSfxVolume(snd_SfxVolume /* *8 */);",
     "S_SetSfxVolume(snd_SfxVolume * 8);"),
    ("S_SetMusicVolume(snd_MusicVolume /* *8 */);",
     "S_SetMusicVolume(snd_MusicVolume * 8);"),
]
for old, new in menu_replacements:
    if old not in s:
        raise SystemExit(f"expected DOS audio scaling anchor not found in {p}: {old!r}")
    s = s.replace(old, new, 1)
p.write_text(s)

print("Applied LinuxDOOM/Emscripten compatibility edits:")
print(" - w_wad.c: private strupr helper renamed to doom_strupr")
print(" - d_main.c/m_menu.c: restored DOS 0..15 -> internal *8 audio scaling")
print(" - music compatibility is prepared separately by import_vanilla_opl.py")