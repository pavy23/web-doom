// Runtime PWAD import/reload adapter for the direct LinuxDOOM browser port.
//
// This deliberately uses LinuxDOOM's own WAD override semantics: append a
// validated PWAD after the IWAD, then restart the current map through G_InitNew.
// Later lumps therefore override earlier lumps exactly as the original engine
// expects. The authoring ChangeSet is reset after the new map becomes baseline.

#include "doomdef.h"
#include "doomstat.h"
#include "g_game.h"
#include "w_wad.h"

#include <emscripten/emscripten.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define DOOMCTL_RELOAD_BUFSIZE 1024
#define DOOMCTL_MAX_IMPORTS 32

extern void W_AddFile(char *filename);
extern int doomctl_reset_changeset(void);

static char doomctl_reload_buffer[DOOMCTL_RELOAD_BUFSIZE];
static int doomctl_import_count = 0;

static unsigned int doomctl_read_u32(const unsigned char *p)
{
    return (unsigned int) p[0]
        | ((unsigned int) p[1] << 8)
        | ((unsigned int) p[2] << 16)
        | ((unsigned int) p[3] << 24);
}

static int doomctl_name_equals(const unsigned char *raw, const char *name)
{
    char value[9];
    int i;

    memset(value, 0, sizeof(value));
    for (i = 0; i < 8; ++i)
    {
        if (raw[i] == 0)
            break;
        value[i] = (char) raw[i];
    }
    return !strcmp(value, name);
}

static int doomctl_validate_current_map_pwad(const char *path,
                                             int *out_lump_count)
{
    static const char *expected[] = {
        "THINGS", "LINEDEFS", "SIDEDEFS", "VERTEXES", "SEGS",
        "SSECTORS", "NODES", "SECTORS", "REJECT", "BLOCKMAP"
    };
    FILE *fp;
    unsigned char header[12];
    unsigned char entry[16];
    char mapname[9];
    long file_size;
    unsigned int lump_count;
    unsigned int directory_offset;
    unsigned int i;
    int marker_index;

    fp = fopen(path, "rb");
    if (fp == NULL)
        return -10;

    if (fseek(fp, 0, SEEK_END) != 0)
    {
        fclose(fp);
        return -11;
    }
    file_size = ftell(fp);
    if (file_size < 12 || file_size > 16 * 1024 * 1024L)
    {
        fclose(fp);
        return -12;
    }
    if (fseek(fp, 0, SEEK_SET) != 0
     || fread(header, 1, sizeof(header), fp) != sizeof(header))
    {
        fclose(fp);
        return -11;
    }

    if (memcmp(header, "PWAD", 4) != 0)
    {
        fclose(fp);
        return -13;
    }

    lump_count = doomctl_read_u32(header + 4);
    directory_offset = doomctl_read_u32(header + 8);
    if (lump_count == 0 || lump_count > 4096
     || directory_offset > (unsigned long) file_size
     || (unsigned long) directory_offset + (unsigned long) lump_count * 16UL
        > (unsigned long) file_size)
    {
        fclose(fp);
        return -14;
    }

    snprintf(mapname, sizeof(mapname), "E%dM%d", gameepisode, gamemap);
    marker_index = -1;

    for (i = 0; i < lump_count; ++i)
    {
        unsigned int position;
        unsigned int size;

        if (fseek(fp, (long) directory_offset + (long) i * 16L, SEEK_SET) != 0
         || fread(entry, 1, sizeof(entry), fp) != sizeof(entry))
        {
            fclose(fp);
            return -15;
        }

        position = doomctl_read_u32(entry + 0);
        size = doomctl_read_u32(entry + 4);
        if ((unsigned long) position + (unsigned long) size
            > (unsigned long) file_size)
        {
            fclose(fp);
            return -16;
        }

        if (doomctl_name_equals(entry + 8, mapname))
            marker_index = (int) i;
    }

    if (marker_index < 0 || marker_index + 10 >= (int) lump_count)
    {
        fclose(fp);
        return -17;
    }

    for (i = 0; i < 10; ++i)
    {
        if (fseek(fp,
                  (long) directory_offset + (long) (marker_index + 1 + (int) i) * 16L,
                  SEEK_SET) != 0
         || fread(entry, 1, sizeof(entry), fp) != sizeof(entry))
        {
            fclose(fp);
            return -15;
        }
        if (!doomctl_name_equals(entry + 8, expected[i]))
        {
            fclose(fp);
            return -18;
        }
    }

    fclose(fp);
    if (out_lump_count != NULL)
        *out_lump_count = (int) lump_count;
    return 1;
}

EMSCRIPTEN_KEEPALIVE
const char *doomctl_load_pwad_json(const char *path)
{
    int validation;
    int imported_lumps;
    int before;
    int expected_total;
    int reset_result;
    void **newcache;

    doomctl_reload_buffer[0] = '\0';

    if (gamestate != GS_LEVEL)
    {
        snprintf(doomctl_reload_buffer, DOOMCTL_RELOAD_BUFSIZE,
                 "{\"loaded\":false,\"error\":\"game_not_ready\"}");
        return doomctl_reload_buffer;
    }
    if (path == NULL || path[0] == '\0')
    {
        snprintf(doomctl_reload_buffer, DOOMCTL_RELOAD_BUFSIZE,
                 "{\"loaded\":false,\"error\":\"invalid_path\"}");
        return doomctl_reload_buffer;
    }
    if (doomctl_import_count >= DOOMCTL_MAX_IMPORTS)
    {
        snprintf(doomctl_reload_buffer, DOOMCTL_RELOAD_BUFSIZE,
                 "{\"loaded\":false,\"error\":\"import_limit_reached\"}");
        return doomctl_reload_buffer;
    }

    validation = doomctl_validate_current_map_pwad(path, &imported_lumps);
    if (validation <= 0)
    {
        snprintf(doomctl_reload_buffer, DOOMCTL_RELOAD_BUFSIZE,
                 "{\"loaded\":false,\"error\":\"invalid_pwad\",\"code\":%d}",
                 validation);
        return doomctl_reload_buffer;
    }

    before = numlumps;
    expected_total = before + imported_lumps;

    // W_AddFile() can append lumpinfo at runtime, but vanilla W_InitMultipleFiles()
    // allocates lumpcache only once at startup. Grow it before the append so any
    // newly overridden map lump can safely use W_CacheLumpNum/Name afterward.
    newcache = (void **) realloc(lumpcache,
                                (size_t) expected_total * sizeof(*lumpcache));
    if (newcache == NULL)
    {
        snprintf(doomctl_reload_buffer, DOOMCTL_RELOAD_BUFSIZE,
                 "{\"loaded\":false,\"error\":\"lumpcache_realloc_failed\"}");
        return doomctl_reload_buffer;
    }
    lumpcache = newcache;
    memset(lumpcache + before, 0,
           (size_t) imported_lumps * sizeof(*lumpcache));

    W_AddFile((char *) path);
    if (numlumps != expected_total)
    {
        snprintf(doomctl_reload_buffer, DOOMCTL_RELOAD_BUFSIZE,
                 "{\"loaded\":false,\"error\":\"wad_append_failed\","
                 "\"expectedLumps\":%d,\"actualLumps\":%d}",
                 expected_total, numlumps);
        return doomctl_reload_buffer;
    }

    ++doomctl_import_count;
    G_InitNew(gameskill, gameepisode, gamemap);
    reset_result = doomctl_reset_changeset();

    snprintf(doomctl_reload_buffer, DOOMCTL_RELOAD_BUFSIZE,
             "{\"loaded\":true,\"episode\":%d,\"map\":%d,"
             "\"importedLumps\":%d,\"totalLumps\":%d,\"importsThisSession\":%d,"
             "\"changeSetReset\":%s}",
             gameepisode, gamemap, imported_lumps, numlumps,
             doomctl_import_count, reset_result > 0 ? "true" : "false");
    return doomctl_reload_buffer;
}

EMSCRIPTEN_KEEPALIVE
const char *doomctl_reload_current_map_json(void)
{
    int reset_result;

    doomctl_reload_buffer[0] = '\0';
    if (gamestate != GS_LEVEL)
    {
        snprintf(doomctl_reload_buffer, DOOMCTL_RELOAD_BUFSIZE,
                 "{\"reloaded\":false,\"error\":\"game_not_ready\"}");
        return doomctl_reload_buffer;
    }

    G_InitNew(gameskill, gameepisode, gamemap);
    reset_result = doomctl_reset_changeset();

    snprintf(doomctl_reload_buffer, DOOMCTL_RELOAD_BUFSIZE,
             "{\"reloaded\":true,\"episode\":%d,\"map\":%d,"
             "\"changeSetReset\":%s}",
             gameepisode, gamemap, reset_result > 0 ? "true" : "false");
    return doomctl_reload_buffer;
}
