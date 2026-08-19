# P1.1 THINGS usage examples

## Single-map item placement

```text
doom_begin_episode_session maps=["E1M3"]
doom_begin_transaction label="E1M3 item pass"
doom_list_things sessionId=... map="E1M3" category="start"
doom_spawn_thing sessionId=... map="E1M3" key="rocket_launcher" x=... y=... angle=90 skillEasy=false skillMedium=false skillHard=true
doom_spawn_thing sessionId=... map="E1M3" key="medikit" x=... y=...
doom_validate_transaction sessionId=...
doom_commit_transaction sessionId=...
doom_build_episode sessionId=... filename="e1m3-things.wad"
```

## Multiplayer-oriented placement

```text
doom_begin_episode_session maps=["E1M1"]
doom_begin_transaction label="deathmatch starts"
doom_spawn_thing sessionId=... map="E1M1" key="deathmatch_start" x=... y=... angle=0
doom_spawn_thing sessionId=... map="E1M1" key="deathmatch_start" x=... y=... angle=90
doom_spawn_thing sessionId=... map="E1M1" key="deathmatch_start" x=... y=... angle=180
doom_spawn_thing sessionId=... map="E1M1" key="deathmatch_start" x=... y=... angle=270
doom_spawn_thing sessionId=... map="E1M1" key="shotgun" x=... y=... multiplayerOnly=true
doom_commit_transaction sessionId=...
```

## Raw DoomEd number

Named catalog entries are conveniences, not a whitelist:

```text
doom_spawn_thing sessionId=... map="E1M1" doomEdNum=2035 x=... y=...
```

P1.1 persists all edits into the real 10-byte Vanilla `THINGS` records and keeps them inside P0 atomic transaction/build semantics.
