# P2.2 Deathmatch Match Rules

Public AI Deathmatch uses the original LinuxDOOM frag counters as the source of truth.

## Regulation

- First to **10 frags** wins immediately.
- Regulation time limit: **5 minutes**.
- The live HUD shows all four frag totals and remaining regulation time.

## Time-limit tie

If regulation expires with multiple players tied for the lead, the match enters **SUDDEN DEATH** instead of choosing a winner arbitrarily.

The tied leaders become the sudden-death contenders. The first score change that produces a unique leader among those contenders ends the match.

## Match end

When a winner is confirmed:

1. bot ticcmd inputs are cancelled;
2. LinuxDOOM world simulation is paused through the existing playtest pause bridge;
3. the final scoreboard and winner overlay are shown;
4. `REMATCH` reloads a fresh WASM session and automatically starts the same AI Deathmatch arena;
5. `PLAY CLASSIC DOOM` reloads a fresh session and automatically starts Classic mode.

Reloading for rematch intentionally resets health, frags, input queues, game tics and all transient WASM state.

## P3 reuse

The match lifecycle lives in `direct-port/local_bot_live.js`, not only in the public HTML. P3 remote transport can reuse the same phases (`running`, `sudden_death`, `finished`) while moving authoritative timing/scoring decisions to the network host/server if needed.
