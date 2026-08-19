#!/usr/bin/env python3
"""Upgrade the existing P1 console-agent runtime to P2.2 local multiplayer bots.

Run after direct-port/patch_agent_input.py. It keeps the same point in G_Ticker
(after net/demo command selection and before gameplay consumption) but applies
an independent local ticcmd override to every playeringame[] slot.

For the P2.2-only temporary LinuxDOOM build this patch also wires the optional
browser launcher hooks and local_bot_live.js pre-js scheduler. Normal P0-P2.1
builds are unaffected because this script is only run by the P2.2 build path.
"""

from pathlib import Path
import sys


def patch_g_ticker(root: Path) -> None:
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


def patch_shell(root: Path) -> None:
    path = root / "shell.html"
    text = path.read_text(encoding="utf-8")

    old = """      try {\n        const result = Module.callMain([]);\n        resumeAudioContext();\n        hideLauncher();\n"""
    new = """      try {\n        const p22BootArgs = (window.DoomLocalBots && typeof window.DoomLocalBots.bootArgs === 'function')\n          ? window.DoomLocalBots.bootArgs()\n          : [];\n        const result = Module.callMain(p22BootArgs);\n        if (window.DoomLocalBots && typeof window.DoomLocalBots.onGameStarted === 'function') {\n          window.DoomLocalBots.onGameStarted(Module);\n        }\n        resumeAudioContext();\n        hideLauncher();\n"""
    if new not in text:
        if old not in text:
            raise SystemExit("shell start/callMain block not found")
        text = text.replace(old, new, 1)

    path.write_text(text, encoding="utf-8")


def patch_makefile(root: Path) -> None:
    path = root / "Makefile.web"
    text = path.read_text(encoding="utf-8")

    line_continuation = "\\" + "\n"
    live_flag = "  --pre-js $(GITHUB_WORKSPACE)/direct-port/local_bot_live.js " + line_continuation
    if live_flag not in text:
        anchor = "  --pre-js $(AGENT_PRE_JS) " + line_continuation
        if anchor not in text:
            raise SystemExit("AGENT_PRE_JS anchor not found in Makefile.web")
        text = text.replace(anchor, anchor + live_flag, 1)

    path.write_text(text, encoding="utf-8")


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: patch_multi_agent.py <linuxdoom-source-dir>")

    root = Path(sys.argv[1])
    patch_g_ticker(root)
    patch_shell(root)
    patch_makefile(root)
    print("Patched P2.2 per-player ticcmds + live human/bot browser runtime")


if __name__ == "__main__":
    main()
