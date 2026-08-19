#!/usr/bin/env python3
"""Upgrade LinuxDOOM for P2.2 independent local-player bot control.

Run after direct-port/patch_agent_input.py. It preserves the proven P1 hook
location while applying an independent ticcmd override to every playeringame[]
slot. It also keeps Vanilla deathmatch respawn semantics for P2.2 local
multi-player sessions even though they deliberately keep netgame=false and use
only one network node.
"""

from pathlib import Path
import sys


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: patch_multi_agent.py <linuxdoom-source-dir>")

    root = Path(sys.argv[1])
    path = root / "g_game.c"
    text = path.read_text(encoding="utf-8")

    old_decl = "    extern void doomctl_apply_agent_ticcmd(ticcmd_t *cmd);\n"
    new_decl = "    extern void doomctl_apply_player_agent_ticcmd(int player, ticcmd_t *cmd);\n"
    if new_decl not in text:
        if old_decl not in text:
            raise SystemExit("existing P1 agent declaration not found in g_game.c")
        text = text.replace(old_decl, new_decl, 1)

    old_call = (
        "\t    // MCP autonomous playtest input overrides only the local command\n"
        "\t    // that is about to be consumed by gameplay.\n"
        "\t    if (i == consoleplayer)\n"
        "\t\tdoomctl_apply_agent_ticcmd(cmd);\n"
    )
    new_call = (
        "\t    // P2.2 local bot arena: every local player slot may own an\n"
        "\t    // independent deterministic ticcmd override.\n"
        "\t    doomctl_apply_player_agent_ticcmd(i, cmd);\n"
    )
    if new_call not in text:
        if old_call not in text:
            raise SystemExit("existing P1 console-agent call block not found in g_game.c")
        text = text.replace(old_call, new_call, 1)

    old_reborn = (
        "void G_DoReborn (int playernum) \n"
        "{ \n"
        "    int                             i; \n"
        "\t \n"
        "    if (!netgame)\n"
    )
    new_reborn = (
        "extern int doomctl_is_local_multiplayer(void);\n\n"
        "void G_DoReborn (int playernum) \n"
        "{ \n"
        "    int                             i; \n"
        "\t \n"
        "    if (!netgame && !doomctl_is_local_multiplayer())\n"
    )
    if new_reborn not in text:
        if old_reborn not in text:
            raise SystemExit("Vanilla G_DoReborn single-player branch not found in g_game.c")
        text = text.replace(old_reborn, new_reborn, 1)

    path.write_text(text, encoding="utf-8")
    print("Patched G_Ticker for P2.2 per-player ticcmds and local deathmatch rebirth")


if __name__ == "__main__":
    main()
