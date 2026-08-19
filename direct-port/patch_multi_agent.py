#!/usr/bin/env python3
"""Upgrade the existing P1 console-agent G_Ticker hook to P2.2 per-player input.

Run after direct-port/patch_agent_input.py. It keeps the same point in G_Ticker
(after net/demo command selection and before gameplay consumption) but applies
an independent local ticcmd override to every playeringame[] slot.

Browser launcher patching and the live local-bot pre-js scheduler are wired by
the dedicated P2.2 build path, not by this source patch.
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

    path.write_text(text, encoding="utf-8")
    print("Patched G_Ticker for P2.2 independent local-player bot ticcmds")


if __name__ == "__main__":
    main()
