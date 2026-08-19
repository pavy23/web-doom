# P1 status

## P1.1 — General THINGS authoring ✅

- named Vanilla Doom THINGS catalog plus numeric DoomEd fallback
- Player 1–4 and deathmatch starts
- monsters, weapons, ammo, health, armor, keys, powerups and props
- list / add / move / update / delete
- P0 atomic selected-map / multi-map transaction integration
- real THINGS serialization and LinuxDOOM runtime regression

## P1.2 — Semantic geometry ✅

- convex polygon room extrusion
- static staircases
- manual / keyed doors with playable destination rooms
- tagged lifts with destination rooms
- ordered sector-boundary inspection
- safe simple-sector split
- P0 topology validation + pinned ZDBSP + real E1M1–E1M5 runtime regression

## P1.3 — Navigation graph + autonomous QA ✅

- sector/portal navigation graph
- walk / drop / door / lift / blocked transition classification
- keyed path planning
- exit progression analysis
- deterministic exact-tic browser movement agent
- real authored-space autonomous navigation regression

## P1.4 — Auto-repair closed loop ✅

- deterministic navigation failure diagnosis
- conservative repair planning
- missing/inaccessible key repair
- authored portal `ML_BLOCKING` repair
- authored sector step/clearance repair
- safe authored exit insertion
- P0 atomic transaction integration
- bounded repair iterations
- pre-repair snapshot restoration on failed runtime verification
- rebuild with pinned ZDBSP
- real LinuxDOOM/Chromium replay verification

Final P1.4 CI proves the full loop on real E1M1:

`author room -> deliberately break portal -> diagnose -> repair -> validate -> ZDBSP -> cold boot -> autonomous replay -> enter repaired authored sector`.

All stacked P0, P1.1, P1.2, P1.3 and P1.4 CI gates are green.

## Next recommended phase

P2.0 — blank-map generation: create a valid new `MAP01` / `E1M1` from no legacy map baseline, then feed it through the same P0–P1.4 validation, navigation, repair and runtime QA pipeline.
