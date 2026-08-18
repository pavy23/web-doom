# P1.2 Semantic Geometry Authoring

P1.2 raises the DOOM MCP geometry surface from low-level vertices/linedefs/sectors to bounded semantic level-design operations while preserving the P0 reliability gates.

Version: `2.3.0-p1.2`

## Safety pipeline

```text
semantic request
  -> active episode transaction
  -> deterministic geometry construction
  -> P0 full topology validation
  -> atomic commit / whole-map-set rollback
  -> pinned ZDBSP rebuild
  -> candidate PWAD
  -> LinuxDOOM cold boot
  -> exact-tic browser experiment
```

Semantic tools never write BSP-derived lumps directly.

## Read sector boundary

`doom_get_sector_boundary` returns an ordered edge/vertex cycle for a simple single-cycle sector. It is useful before a split and is intended to become an input to P1.3 navigation analysis.

Example:

```json
{
  "sessionId": "episode-0001",
  "map": "E1M1",
  "sector": 12
}
```

A sector with branching/open/disconnected boundary topology is rejected by this high-level helper rather than guessed.

## Polygon room

`doom_add_polygon_room` extrudes a convex 3-12 sided room from the outside of a one-sided wall.

```json
{
  "sessionId": "episode-0001",
  "map": "E1M1",
  "line": 123,
  "sides": 6,
  "depth": 192,
  "wallTexture": "STARTAN3"
}
```

The selected wall becomes the portal edge. Arbitrary concave polygons are intentionally not supported by this primitive.

## Staircase

`doom_add_staircase` creates 2-24 static step sectors and an optional landing.

```json
{
  "sessionId": "episode-0001",
  "map": "E1M2",
  "line": 88,
  "steps": 8,
  "stepDepth": 32,
  "stepHeight": 8,
  "direction": "up",
  "landingDepth": 96
}
```

`stepHeight` is limited to 1-24 map units so each individual rise stays within ordinary Doom player step-up capability.

## Functional door + room

`doom_add_door_room` creates a narrow closed door sector and a playable room behind it.

```json
{
  "sessionId": "episode-0001",
  "map": "E1M3",
  "line": 64,
  "key": "blue",
  "behavior": "raise",
  "doorDepth": 24,
  "roomDepth": 192,
  "doorTexture": "STARTAN3"
}
```

Supported manual door mappings:

- no key: raise `1`, stay-open `31`
- blue: raise `26`, stay-open `32`
- yellow: raise `27`, stay-open `34`
- red: raise `28`, stay-open `33`

The door sector starts at zero height (`ceiling == floor`), which is a valid Vanilla DOOM closed-door structure and is preserved by the P0 validator as a compatibility warning rather than an error.

## Functional lift + upper room

`doom_add_lift_room` creates a tagged high platform sector and an upper destination room.

```json
{
  "sessionId": "episode-0001",
  "map": "E1M4",
  "line": 210,
  "rise": 64,
  "liftDepth": 64,
  "roomDepth": 192
}
```

The builder allocates an unused map tag unless one is supplied.

- lower call line: reusable USE/button `PlatDownWaitUpStay`, special `62`
- upper return trigger: retrigger WALK `PlatDownWaitUpStay`, special `88`

## Safe simple-sector split

`doom_split_sector` cuts a simple single-cycle sector between two existing non-adjacent boundary vertices.

First inspect the boundary:

```json
{
  "sessionId": "episode-0001",
  "map": "E1M5",
  "sector": 20
}
```

Then split using two returned vertex IDs:

```json
{
  "sessionId": "episode-0001",
  "map": "E1M5",
  "sector": 20,
  "vertexA": 301,
  "vertexB": 318,
  "floor": 16,
  "light": 144
}
```

The operation clones the sector, reassigns one existing boundary chain to the new sector, and inserts one two-sided chord. It does not invent arbitrary cut coordinates.

## Atomic multi-map composition

All P1.2 operations also work through `doom_apply_transaction_edits`.

```json
{
  "sessionId": "episode-0001",
  "edits": [
    {
      "type": "add_staircase",
      "map": "E1M1",
      "line": 120,
      "steps": 6,
      "stepHeight": 8
    },
    {
      "type": "add_door_room",
      "map": "E1M3",
      "line": 42,
      "key": "red",
      "roomDepth": 160
    },
    {
      "type": "add_lift_room",
      "map": "E1M7",
      "line": 90,
      "rise": 64
    }
  ]
}
```

If the E1M7 lift is invalid, the earlier E1M1 and E1M3 changes are restored to the transaction snapshot too.

## Current boundary

P1.2 deliberately does not attempt:

- arbitrary concave/free-form polygon generation
- arbitrary-coordinate sector slicing
- automatic obstacle-routing corridors
- general legacy-sector merging
- navigation/reachability proof
- key/door progression planning

Those last two are P1.3 territory. The P1.2 goal is to provide deterministic, composable geometry primitives that P1.3 can reason over and autonomously test.
