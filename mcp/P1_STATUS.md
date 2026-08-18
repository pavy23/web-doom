# P1 status

## P1.1 — General THINGS authoring

Implementation target: complete the first P1 slice before richer semantic geometry and navigation work.

Implemented on `p1-richer-authoring-nav`:

- named Vanilla Doom THINGS catalog plus numeric DoomEd fallback
- Player 1–4 and deathmatch starts
- Doom 1 monsters, weapons, ammo, health, armor, keycards, powerups and barrel conveniences
- classic skill / ambush / multiplayer-only flags
- list / add / move / update / delete operations
- integration with P0 atomic selected-map/multi-map transactions
- real THINGS lump serialization before ZDBSP rebuild
- P1-specific self-test and authored-WAD browser cold-boot regression

Next after the P1.1 gate is green: P1.2 richer semantic geometry (stairs, lifts, doors, polygon rooms, safer split/merge), followed by P1.3 navigation graph + autonomous QA.
