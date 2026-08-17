// Minimal engine-control surface for the direct LinuxDOOM browser port.
//
// This file deliberately exposes a small, explicit API instead of making raw
// WASM memory writable from JavaScript.  The first MCP milestone can inspect
// the live player/world state and perform a few bounded actions while the
// original LinuxDOOM simulation remains authoritative.

#include "doomdef.h"
#include "doomstat.h"
#include "d_player.h"
#include "p_local.h"
#include "p_mobj.h"

// Include Emscripten after Doom's historical boolean definitions.
#include <emscripten/emscripten.h>

#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#define DOOMCTL_STATE_BUFSIZE 16384
#define DOOMCTL_MAX_ENEMIES   96

static char doomctl_state_buffer[DOOMCTL_STATE_BUFSIZE];

static player_t *doomctl_player(void)
{
    if (consoleplayer < 0 || consoleplayer >= MAXPLAYERS)
        return NULL;
    if (!playeringame[consoleplayer])
        return NULL;
    if (gamestate != GS_LEVEL)
        return NULL;
    if (players[consoleplayer].mo == NULL)
        return NULL;
    return &players[consoleplayer];
}

static void doomctl_append(size_t *used, const char *fmt, ...)
{
    va_list args;
    int wrote;

    if (*used >= DOOMCTL_STATE_BUFSIZE - 1)
        return;

    va_start(args, fmt);
    wrote = vsnprintf(doomctl_state_buffer + *used,
                      DOOMCTL_STATE_BUFSIZE - *used,
                      fmt, args);
    va_end(args);

    if (wrote <= 0)
        return;

    if ((size_t) wrote >= DOOMCTL_STATE_BUFSIZE - *used)
        *used = DOOMCTL_STATE_BUFSIZE - 1;
    else
        *used += (size_t) wrote;
}

static double doomctl_units(fixed_t value)
{
    return (double) value / (double) FRACUNIT;
}

static double doomctl_angle_degrees(angle_t angle)
{
    return ((double) angle * 360.0) / 4294967296.0;
}

EMSCRIPTEN_KEEPALIVE
const char *doomctl_get_state_json(void)
{
    player_t *player;
    mobj_t *mo;
    thinker_t *thinker;
    int enemy_count;
    int emitted;
    size_t used;

    used = 0;
    doomctl_state_buffer[0] = '\0';
    player = doomctl_player();

    if (player == NULL)
    {
        snprintf(doomctl_state_buffer, DOOMCTL_STATE_BUFSIZE,
                 "{\"ready\":false,\"gameState\":%d,\"episode\":%d,\"map\":%d,\"tic\":%d}",
                 (int) gamestate, gameepisode, gamemap, gametic);
        return doomctl_state_buffer;
    }

    mo = player->mo;
    enemy_count = 0;

    for (thinker = thinkercap.next;
         thinker != &thinkercap;
         thinker = thinker->next)
    {
        mobj_t *thing;

        if (thinker->function.acp1 != (actionf_p1) P_MobjThinker)
            continue;

        thing = (mobj_t *) thinker;
        if ((thing->flags & MF_COUNTKILL) && thing->health > 0)
            ++enemy_count;
    }

    doomctl_append(&used,
        "{\"ready\":true,\"episode\":%d,\"map\":%d,\"skill\":%d,\"tic\":%d,"
        "\"levelTime\":%d,\"player\":{"
        "\"health\":%d,\"armor\":%d,\"armorType\":%d,\"weapon\":%d,"
        "\"x\":%.3f,\"y\":%.3f,\"z\":%.3f,\"angle\":%.3f,"
        "\"ammo\":{\"bullets\":%d,\"shells\":%d,\"cells\":%d,\"rockets\":%d},"
        "\"maxAmmo\":{\"bullets\":%d,\"shells\":%d,\"cells\":%d,\"rockets\":%d},"
        "\"kills\":%d,\"items\":%d,\"secrets\":%d},"
        "\"totals\":{\"kills\":%d,\"items\":%d,\"secrets\":%d},"
        "\"enemyCount\":%d,\"enemies\":[",
        gameepisode, gamemap, (int) gameskill, gametic, leveltime,
        player->health, player->armorpoints, player->armortype,
        (int) player->readyweapon,
        doomctl_units(mo->x), doomctl_units(mo->y), doomctl_units(mo->z),
        doomctl_angle_degrees(mo->angle),
        player->ammo[am_clip], player->ammo[am_shell],
        player->ammo[am_cell], player->ammo[am_misl],
        player->maxammo[am_clip], player->maxammo[am_shell],
        player->maxammo[am_cell], player->maxammo[am_misl],
        player->killcount, player->itemcount, player->secretcount,
        totalkills, totalitems, totalsecret, enemy_count);

    emitted = 0;
    for (thinker = thinkercap.next;
         thinker != &thinkercap && emitted < DOOMCTL_MAX_ENEMIES;
         thinker = thinker->next)
    {
        mobj_t *thing;

        if (thinker->function.acp1 != (actionf_p1) P_MobjThinker)
            continue;

        thing = (mobj_t *) thinker;
        if (!(thing->flags & MF_COUNTKILL) || thing->health <= 0)
            continue;

        doomctl_append(&used,
            "%s{\"type\":%d,\"health\":%d,\"x\":%.3f,\"y\":%.3f,\"z\":%.3f}",
            emitted ? "," : "",
            (int) thing->type, thing->health,
            doomctl_units(thing->x), doomctl_units(thing->y),
            doomctl_units(thing->z));
        ++emitted;
    }

    doomctl_append(&used, "]}");
    return doomctl_state_buffer;
}

EMSCRIPTEN_KEEPALIVE
int doomctl_heal(int amount)
{
    player_t *player = doomctl_player();
    int health;

    if (player == NULL)
        return -1;
    if (amount < 0)
        return -2;

    health = player->health + amount;
    if (health > 200)
        health = 200;

    player->health = health;
    player->mo->health = health;
    return health;
}

EMSCRIPTEN_KEEPALIVE
int doomctl_give_ammo(int ammo_type, int amount)
{
    player_t *player = doomctl_player();
    int value;

    if (player == NULL)
        return -1;
    if (ammo_type < 0 || ammo_type >= NUMAMMO || amount < 0)
        return -2;

    value = player->ammo[ammo_type] + amount;
    if (value > player->maxammo[ammo_type])
        value = player->maxammo[ammo_type];

    player->ammo[ammo_type] = value;
    return value;
}

EMSCRIPTEN_KEEPALIVE
int doomctl_teleport(int x_units, int y_units)
{
    player_t *player = doomctl_player();
    mobj_t *mo;
    fixed_t x;
    fixed_t y;

    if (player == NULL)
        return -1;

    // 16.16 fixed point cannot represent arbitrary integers safely.
    if (x_units < -32768 || x_units > 32767
     || y_units < -32768 || y_units > 32767)
        return -2;

    mo = player->mo;
    x = (fixed_t) (x_units * FRACUNIT);
    y = (fixed_t) (y_units * FRACUNIT);

    if (!P_TeleportMove(mo, x, y))
        return 0;

    // Mirror the vanilla teleporter's post-move player housekeeping, without
    // spawning fog or changing facing direction.
    mo->z = mo->floorz;
    player->viewz = mo->z + player->viewheight;
    mo->momx = 0;
    mo->momy = 0;
    mo->momz = 0;

    return 1;
}
