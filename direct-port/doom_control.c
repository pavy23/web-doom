// Explicit engine-control surface for the direct LinuxDOOM browser port.
//
// MCP and JavaScript only receive the functions exported here. Raw WASM memory
// is intentionally not exposed. The original LinuxDOOM simulation remains
// authoritative for actor state, sight, collision, spawning and removal.

#include "doomdef.h"
#include "doomstat.h"
#include "d_player.h"
#include "p_local.h"
#include "p_mobj.h"

// Include Emscripten after Doom's historical boolean definitions.
#include <emscripten/emscripten.h>

#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#define DOOMCTL_STATE_BUFSIZE 32768
#define DOOMCTL_MAX_ENEMIES   96
#define DOOMCTL_VISIBLE_HALF_FOV 45.0

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

static const char *doomctl_mobj_name(mobjtype_t type)
{
    switch (type)
    {
        case MT_POSSESSED: return "zombieman";
        case MT_SHOTGUY:   return "shotgun_guy";
        case MT_VILE:      return "arch_vile";
        case MT_UNDEAD:    return "revenant";
        case MT_FATSO:     return "mancubus";
        case MT_CHAINGUY:  return "chaingunner";
        case MT_TROOP:     return "imp";
        case MT_SERGEANT:  return "demon";
        case MT_SHADOWS:   return "spectre";
        case MT_HEAD:      return "cacodemon";
        case MT_BRUISER:   return "baron_of_hell";
        case MT_KNIGHT:    return "hell_knight";
        case MT_SKULL:     return "lost_soul";
        case MT_SPIDER:    return "spider_mastermind";
        case MT_BABY:      return "arachnotron";
        case MT_CYBORG:    return "cyberdemon";
        case MT_PAIN:      return "pain_elemental";
        case MT_WOLFSS:    return "wolf_ss";
        case MT_KEEN:      return "commander_keen";
        case MT_BOSSBRAIN: return "icon_of_sin";
        default:           return "unknown";
    }
}

// The public demo uses the shareware IWAD, so mutation tools only spawn enemy
// types whose sprites/states are guaranteed by Episode 1 data.
static int doomctl_spawnable_type(const char *name, mobjtype_t *type)
{
    if (name == NULL || type == NULL)
        return 0;

    if (!strcmp(name, "zombieman"))
        *type = MT_POSSESSED;
    else if (!strcmp(name, "shotgun_guy"))
        *type = MT_SHOTGUY;
    else if (!strcmp(name, "imp"))
        *type = MT_TROOP;
    else if (!strcmp(name, "demon"))
        *type = MT_SERGEANT;
    else if (!strcmp(name, "spectre"))
        *type = MT_SHADOWS;
    else if (!strcmp(name, "baron_of_hell"))
        *type = MT_BRUISER;
    else
        return 0;

    return 1;
}

static int doomctl_live_enemy(mobj_t *thing)
{
    return thing != NULL
        && (thing->flags & MF_COUNTKILL)
        && thing->health > 0;
}

static double doomctl_enemy_distance(player_t *player, mobj_t *thing)
{
    fixed_t dx;
    fixed_t dy;

    dx = thing->x - player->mo->x;
    dy = thing->y - player->mo->y;
    return doomctl_units(P_AproxDistance(dx, dy));
}

static double doomctl_relative_angle(player_t *player, mobj_t *thing)
{
    double target_angle;
    double player_angle;
    double relative;
    double dx;
    double dy;

    dx = doomctl_units(thing->x - player->mo->x);
    dy = doomctl_units(thing->y - player->mo->y);
    target_angle = atan2(dy, dx) * 57.2957795130823208768;
    if (target_angle < 0.0)
        target_angle += 360.0;

    player_angle = doomctl_angle_degrees(player->mo->angle);
    relative = target_angle - player_angle;

    while (relative > 180.0)
        relative -= 360.0;
    while (relative < -180.0)
        relative += 360.0;

    return relative;
}

static int doomctl_line_of_sight(player_t *player, mobj_t *thing)
{
    return P_CheckSight(player->mo, thing) ? 1 : 0;
}

static int doomctl_visible_enemy(player_t *player, mobj_t *thing,
                                 int *line_of_sight, double *relative_angle)
{
    int los;
    double angle;

    los = doomctl_line_of_sight(player, thing);
    angle = doomctl_relative_angle(player, thing);

    if (line_of_sight != NULL)
        *line_of_sight = los;
    if (relative_angle != NULL)
        *relative_angle = angle;

    return los && fabs(angle) <= DOOMCTL_VISIBLE_HALF_FOV;
}

EMSCRIPTEN_KEEPALIVE
const char *doomctl_get_state_json(void)
{
    player_t *player;
    mobj_t *mo;
    thinker_t *thinker;
    int enemy_count;
    int visible_count;
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
    visible_count = 0;

    for (thinker = thinkercap.next;
         thinker != &thinkercap;
         thinker = thinker->next)
    {
        mobj_t *thing;

        if (thinker->function.acp1 != (actionf_p1) P_MobjThinker)
            continue;

        thing = (mobj_t *) thinker;
        if (!doomctl_live_enemy(thing))
            continue;

        ++enemy_count;
        if (doomctl_visible_enemy(player, thing, NULL, NULL))
            ++visible_count;
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
        "\"enemyCount\":%d,\"visibleEnemyCount\":%d,\"enemies\":[",
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
        totalkills, totalitems, totalsecret, enemy_count, visible_count);

    emitted = 0;
    for (thinker = thinkercap.next;
         thinker != &thinkercap && emitted < DOOMCTL_MAX_ENEMIES;
         thinker = thinker->next)
    {
        mobj_t *thing;
        double distance;
        double relative_angle;
        int line_of_sight;
        int visible;

        if (thinker->function.acp1 != (actionf_p1) P_MobjThinker)
            continue;

        thing = (mobj_t *) thinker;
        if (!doomctl_live_enemy(thing))
            continue;

        distance = doomctl_enemy_distance(player, thing);
        visible = doomctl_visible_enemy(player, thing,
                                        &line_of_sight, &relative_angle);

        doomctl_append(&used,
            "%s{\"type\":%d,\"name\":\"%s\",\"health\":%d,"
            "\"x\":%.3f,\"y\":%.3f,\"z\":%.3f,"
            "\"distance\":%.3f,\"relativeAngle\":%.3f,"
            "\"lineOfSight\":%s,\"visible\":%s}",
            emitted ? "," : "",
            (int) thing->type, doomctl_mobj_name(thing->type), thing->health,
            doomctl_units(thing->x), doomctl_units(thing->y),
            doomctl_units(thing->z), distance, relative_angle,
            line_of_sight ? "true" : "false",
            visible ? "true" : "false");
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

EMSCRIPTEN_KEEPALIVE
int doomctl_spawn_enemy(const char *name, int count, int distance_units)
{
    player_t *player;
    mobjtype_t type;
    mobj_t *player_mo;
    unsigned angle_index;
    fixed_t forward;
    int spawned;
    int i;

    player = doomctl_player();
    if (player == NULL)
        return -1;
    if (!doomctl_spawnable_type(name, &type))
        return -2;
    if (count < 1 || count > 8 || distance_units < 64 || distance_units > 1024)
        return -3;

    player_mo = player->mo;
    angle_index = player_mo->angle >> ANGLETOFINESHIFT;
    forward = (fixed_t) (distance_units * FRACUNIT);
    spawned = 0;

    for (i = 0; i < count; ++i)
    {
        int side_units;
        fixed_t side;
        fixed_t x;
        fixed_t y;
        mobj_t *thing;

        // Fan multiple enemies across the player's view at 48-unit spacing.
        side_units = (i * 2 - (count - 1)) * 24;
        side = (fixed_t) (side_units * FRACUNIT);

        x = player_mo->x
          + FixedMul(forward, finecosine[angle_index])
          - FixedMul(side, finesine[angle_index]);
        y = player_mo->y
          + FixedMul(forward, finesine[angle_index])
          + FixedMul(side, finecosine[angle_index]);

        thing = P_SpawnMobj(x, y, ONFLOORZ, type);
        if (thing == NULL)
            continue;

        // P_CheckPosition uses Doom's own line/blockmap/thing collision rules.
        if (!P_CheckPosition(thing, x, y))
        {
            P_RemoveMobj(thing);
            continue;
        }

        thing->angle = player_mo->angle + ANG180;
        thing->target = player_mo;
        if (thing->info->seestate != S_NULL)
            P_SetMobjState(thing, thing->info->seestate);

        if (thing->flags & MF_COUNTKILL)
            ++totalkills;
        ++spawned;
    }

    return spawned;
}

EMSCRIPTEN_KEEPALIVE
const char *doomctl_remove_nearest_enemy_json(int visible_only,
                                               int max_distance_units)
{
    player_t *player;
    thinker_t *thinker;
    mobj_t *nearest;
    double nearest_distance;
    double nearest_angle;
    int nearest_los;
    int nearest_visible;
    mobjtype_t nearest_type;
    const char *nearest_name;

    player = doomctl_player();
    doomctl_state_buffer[0] = '\0';

    if (player == NULL)
    {
        snprintf(doomctl_state_buffer, DOOMCTL_STATE_BUFSIZE,
                 "{\"removed\":false,\"error\":\"game_not_ready\"}");
        return doomctl_state_buffer;
    }

    if (max_distance_units < 0 || max_distance_units > 8192)
    {
        snprintf(doomctl_state_buffer, DOOMCTL_STATE_BUFSIZE,
                 "{\"removed\":false,\"error\":\"invalid_distance\"}");
        return doomctl_state_buffer;
    }

    nearest = NULL;
    nearest_distance = 0.0;
    nearest_angle = 0.0;
    nearest_los = 0;
    nearest_visible = 0;

    for (thinker = thinkercap.next;
         thinker != &thinkercap;
         thinker = thinker->next)
    {
        mobj_t *thing;
        double distance;
        double relative_angle;
        int line_of_sight;
        int visible;

        if (thinker->function.acp1 != (actionf_p1) P_MobjThinker)
            continue;

        thing = (mobj_t *) thinker;
        if (!doomctl_live_enemy(thing))
            continue;

        distance = doomctl_enemy_distance(player, thing);
        if (max_distance_units > 0 && distance > (double) max_distance_units)
            continue;

        visible = doomctl_visible_enemy(player, thing,
                                        &line_of_sight, &relative_angle);
        if (visible_only && !visible)
            continue;

        if (nearest == NULL || distance < nearest_distance)
        {
            nearest = thing;
            nearest_distance = distance;
            nearest_angle = relative_angle;
            nearest_los = line_of_sight;
            nearest_visible = visible;
        }
    }

    if (nearest == NULL)
    {
        snprintf(doomctl_state_buffer, DOOMCTL_STATE_BUFSIZE,
                 "{\"removed\":false,\"reason\":\"no_matching_enemy\"}");
        return doomctl_state_buffer;
    }

    nearest_type = nearest->type;
    nearest_name = doomctl_mobj_name(nearest_type);

    if ((nearest->flags & MF_COUNTKILL) && totalkills > 0)
        --totalkills;
    P_RemoveMobj(nearest);

    snprintf(doomctl_state_buffer, DOOMCTL_STATE_BUFSIZE,
             "{\"removed\":true,\"type\":%d,\"name\":\"%s\","
             "\"distance\":%.3f,\"relativeAngle\":%.3f,"
             "\"lineOfSight\":%s,\"visible\":%s}",
             (int) nearest_type, nearest_name, nearest_distance, nearest_angle,
             nearest_los ? "true" : "false",
             nearest_visible ? "true" : "false");
    return doomctl_state_buffer;
}
