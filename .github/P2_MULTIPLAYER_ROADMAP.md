# Online Multiplayer Roadmap

Online multiplayer is feasible on top of the direct LinuxDOOM browser port, but it is intentionally separated from P2.0 blank-map generation.

## Current state

`direct-port/i_net_web.c` is a deliberate single-player platform shim. It allocates `doomcom`, sets `netgame = false`, and leaves `I_NetCmd()` without a real transport. The original LinuxDOOM game/network loop above that platform boundary remains available.

## Proposed order

1. P2.0 — source-free playable map generation
2. P2.1 — game-design evaluation
3. P2.2 — deathmatch map generation, spawn/item/fairness analysis
4. P3.0 — online multiplayer transport

## P3.0 transport concept

Recommended first implementation:

```text
LinuxDOOM D_Net / doomcom
        ↓
I_NetCmd browser adapter
        ↓
JS/WASM bridge
        ↓
WebSocket relay
        ↓
2-4 browser clients
```

A WebSocket relay is preferred for the first deterministic prototype because it is easier to instrument and reproduce than peer-to-peer networking. WebRTC DataChannel can be evaluated later for lower-latency peer paths.

The first multiplayer acceptance target should be two browser clients running the same generated deathmatch PWAD, exchanging tic packets through a relay and remaining synchronized for a bounded match interval.
