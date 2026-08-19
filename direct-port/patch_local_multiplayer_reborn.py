#!/usr/bin/env python3
"""Keep Vanilla per-player deathmatch respawn for P2.2 local multiplayer.

Original LinuxDOOM reloads the entire level from G_DoReborn when netgame=false.
P2.2 deliberately keeps netgame=false (one local network node), so generated
local deathmatch arenas need a narrow exception when i_net_localbots reports
more than one local player.
"""

from pathlib import Path
import sys


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: patch_local_multiplayer_reborn.py <linuxdoom-source-dir>")

    path = Path(sys.argv[1]) / "g_game.c"
    text = path.read_text(encoding="utf-8")

    old = """void G_DoReborn (int playernum) \n{ \n    int                             i; \n\t \n    if (!netgame)\n"""
    new = """extern int doomctl_is_local_multiplayer(void);\n\nvoid G_DoReborn (int playernum) \n{ \n    int                             i; \n\t \n    if (!netgame && !doomctl_is_local_multiplayer())\n"""

    if new not in text:
        if old not in text:
            raise SystemExit("Vanilla G_DoReborn single-player branch not found")
        text = text.replace(old, new, 1)

    path.write_text(text, encoding="utf-8")
    print("Patched G_DoReborn for P2.2 local deathmatch respawn semantics")


if __name__ == "__main__":
    main()
