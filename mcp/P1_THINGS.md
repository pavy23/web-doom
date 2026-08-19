# P1.1 — General DOOM THINGS Authoring

P1.1 extends the P0 selected-map / multi-map transaction layer so AI can edit the real Doom `THINGS` lump rather than relying on enemy-only runtime convenience commands.

## MCP tools

- `doom_list_thing_types`
- `doom_list_things`
- `doom_spawn_thing`
- `doom_move_thing`
- `doom_update_thing`
- `doom_delete_thing`

All persistent mutations require an active `doom_begin_transaction` transaction and therefore inherit P0 rollback/validation semantics.

## Supported semantics

The built-in catalog covers common Vanilla Doom:

- Player 1–4 starts
- deathmatch starts
- Doom 1 monsters
- weapons
- ammo
- health / armor
- keycards
- major powerups
- explosive barrels

The catalog is intentionally not a closed whitelist. `doomEdNum` accepts any valid positive signed-16-bit DoomEd number so uncatalogued Vanilla/custom things can still be represented. Uncatalogued newly-authored types produce a validation warning rather than being rejected.

## Vanilla option flags

P1.1 exposes the five classic map-thing option bits:

- `skillEasy`
- `skillMedium`
- `skillHard`
- `ambush`
- `multiplayerOnly`

Raw `flags` may also be supplied when precise compatibility is required.

## Example

```text
E1M3만 episode session으로 열어.
transaction을 시작해.
현재 Player 1 start와 무기 배치를 조사해.
Rocket Launcher를 플레이어 시작점에서 256 units 정도 떨어진 안전한 위치에 추가하고,
Hard 난이도와 multiplayer에서만 나타나게 설정해.
Medikit 두 개와 Imp 세 마리를 추가해.
THINGS validation을 실행하고 commit해.
PWAD로 build한 뒤 automated browser experiment를 실행해.
```

## P1 continuation

P1.1 provides the object-placement foundation required for later multiplayer generation. Next P1 layers will add richer semantic geometry (stairs/lifts/doors/polygon rooms) and navigation/autonomous QA so the system can evaluate reachability, key-door progression, spawn fairness and item/weapon distribution.
