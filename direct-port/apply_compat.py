#!/usr/bin/env python3
"""Minimal source compatibility edits for the direct LinuxDOOM browser build.

The upstream 1997 gameplay/rendering code remains intact. Browser platform files are
installed explicitly by CI; this script only resolves narrow modern-toolchain source
collisions in the pristine LinuxDOOM tree. Music adaptation is handled separately by
import_vanilla_opl.py.
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

print("Applied LinuxDOOM/Emscripten compatibility edits:")
print(" - w_wad.c: private strupr helper renamed to doom_strupr")
print(" - music compatibility is prepared separately by import_vanilla_opl.py")
