# P1.4 Auto-Repair Closed Loop

P1.4 adds a conservative `diagnose -> repair -> validate -> rebuild -> replay` layer on top of P1.3 navigation.

## New MCP tools

- `doom_p1_auto_repair_status`
- `doom_diagnose_navigation`
- `doom_plan_auto_repair`
- `doom_run_auto_repair_loop`

## Repair classes

P1.4 currently repairs four deterministic navigation failure classes:

1. missing or inaccessible blue/yellow/red key required by a manual keyed door;
2. `ML_BLOCKING` accidentally left on an authored two-sided portal;
3. authored target-sector floor/ceiling values that violate Doom's conservative 24-unit step-up / 56-unit clearance envelope;
4. missing exit when a safe reachable authored one-sided wall can receive Vanilla USE exit special 11.

Unsupported or ambiguous failures are returned as `manual_repair_required`; the system does not invent a high-risk geometry rewrite.

## Safety policy

- Legacy Vanilla geometry is protected by default.
- A linedef is repair-eligible when it is newly created or demonstrably modified by the authored history.
- A sector is repair-eligible when newly created or modified by the authored history.
- Gameplay key placement can be repaired unless `allowThingRepair=false`.
- `allowLegacyGeometry=true` explicitly opts into repair of pre-existing geometry.
- Repair batches are bounded to 8 edits and 4 iterations.
- Every batch runs inside the existing P0 episode transaction snapshot and validator.
- Runtime verification uses a rebuilt PWAD in real LinuxDOOM/Chromium.
- Failed runtime verification restores the pre-repair map state by default.

## Closed loop

`doom_run_auto_repair_loop` performs:

1. build the P1.3 navigation diagnosis;
2. detect the reachable frontier and the blocking failure;
3. create a conservative repair plan;
4. begin a P0 atomic transaction;
5. apply the repair plan;
6. run P0/P1 validation and commit only if valid;
7. diagnose again;
8. when healthy, rebuild with pinned ZDBSP;
9. cold-boot the candidate in Chromium;
10. autonomously replay to the requested target sector (or the reachable exit sector for exit-oriented diagnosis);
11. retain the repair only on success, otherwise restore the pre-repair state by default.

## Runtime regression

The P1.4 runtime test uses real `doom1.wad` E1M1:

1. locate a P0-safe wall in the Player 1 start sector;
2. author a polygon room;
3. deliberately re-enable `ML_BLOCKING` on its portal;
4. confirm P1.4 diagnoses `BLOCKED_PORTAL_FLAG`;
5. generate and atomically apply `repair_clear_blocking`;
6. validate and rebuild the PWAD;
7. cold-boot LinuxDOOM;
8. require the autonomous P1.3 agent to cross the repaired portal into the authored sector.

This is the first full self-healing authoring loop in the project. It is intentionally conservative before later expansion into combat/balance repair and blank-map generation.
