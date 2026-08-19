#!/usr/bin/env python3
"""Upgrade LinuxDOOM for P2.2 independent local-player bot control.

Run after direct-port/patch_agent_input.py. It preserves the proven P1 hook
location while applying an independent ticcmd override to every playeringame[]
slot. It also keeps Vanilla deathmatch respawn semantics for P2.2 local
multi-player sessions even though they deliberately keep netgame=false and use
only one network node.

P2.2 also enforces one shared death presentation rule for every local player:
P1 human and P2-P4 bots must remain in PST_DEAD for 45 tics (~1.29 seconds)
before an automated BT_USE respawn command is allowed through.
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

    # The P2.2 build copies direct-port/doom_multi_agent.c to this source file
    # immediately before invoking this patcher. Gate automated respawn input in
    # the engine bridge itself so human and bot slots obey exactly the same
    # minimum death animation window regardless of scheduler reaction speed.
    agent_path = root / "doom_agent_input.c"
    if agent_path.exists():
        agent = agent_path.read_text(encoding="utf-8")

        delay_anchor = "#define DOOMCTL_PLAYERS_BUFSIZE 16384\n"
        delay_block = (
            "#define DOOMCTL_PLAYERS_BUFSIZE 16384\n"
            "#define DOOMCTL_RESPAWN_DELAY_TICS 45\n\n"
            "static int doomctl_death_tic[MAXPLAYERS] = { -1, -1, -1, -1 };\n"
        )
        if "DOOMCTL_RESPAWN_DELAY_TICS" not in agent:
            if delay_anchor not in agent:
                raise SystemExit("doom_agent_input.c delay anchor not found")
            agent = agent.replace(delay_anchor, delay_block, 1)

        state_anchor = "    // Preserve the original LinuxDOOM movement envelope.\n"
        state_block = (
            "    // All local deathmatch slots share the same death presentation window.\n"
            "    // Automated USE is suppressed until the corpse has remained dead for\n"
            "    // 45 tics (~1.29 s at DOOM's 35 Hz simulation rate).\n"
            "    if (players[player].playerstate == PST_LIVE)\n"
            "        doomctl_death_tic[player] = -1;\n"
            "    else if (players[player].playerstate == PST_DEAD && doomctl_death_tic[player] < 0)\n"
            "        doomctl_death_tic[player] = gametic;\n\n"
            "    // Preserve the original LinuxDOOM movement envelope.\n"
        )
        if "doomctl_death_tic[player] = gametic" not in agent:
            if state_anchor not in agent:
                raise SystemExit("doom_agent_input.c state anchor not found")
            agent = agent.replace(state_anchor, state_block, 1)

        old_buttons = (
            "    buttons = 0;\n"
            "    if (agent->attack)\n"
            "        buttons |= BT_ATTACK;\n"
            "    if (agent->use)\n"
            "        buttons |= BT_USE;\n"
            "    cmd->buttons = (byte)buttons;\n"
        )
        new_buttons = (
            "    buttons = 0;\n"
            "    if (agent->attack && players[player].playerstate == PST_LIVE)\n"
            "        buttons |= BT_ATTACK;\n"
            "    if (agent->use)\n"
            "    {\n"
            "        if (players[player].playerstate != PST_DEAD ||\n"
            "            (doomctl_death_tic[player] >= 0 &&\n"
            "             gametic - doomctl_death_tic[player] >= DOOMCTL_RESPAWN_DELAY_TICS))\n"
            "            buttons |= BT_USE;\n"
            "    }\n"
            "    cmd->buttons = (byte)buttons;\n"
        )
        if "gametic - doomctl_death_tic[player] >= DOOMCTL_RESPAWN_DELAY_TICS" not in agent:
            if old_buttons not in agent:
                raise SystemExit("doom_agent_input.c button block not found")
            agent = agent.replace(old_buttons, new_buttons, 1)

        agent_path.write_text(agent, encoding="utf-8")

    path.write_text(text, encoding="utf-8")
    print("Patched G_Ticker for P2.2 per-player ticcmds, local deathmatch rebirth, and 45-tic shared respawn delay")


if __name__ == "__main__":
    main()
