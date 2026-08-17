#!/usr/bin/env python3
"""Minimal source compatibility edits for building 1997 LinuxDOOM with modern Emscripten.

These edits do not replace game logic. They only resolve names/types that collide with
modern libc/toolchain declarations. Every replacement is exact and fails closed if the
expected upstream text is not present.
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
