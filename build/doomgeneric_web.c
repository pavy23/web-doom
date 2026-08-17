/*
 * Browser platform layer for doomgeneric.
 * GPL-2.0-or-later, matching the upstream doomgeneric project.
 *
 * Game/render/AI/WAD logic remains upstream DOOM-derived code. This file only
 * handles SDL2 video/input and hands the main loop to the browser.
 */

#include "doomkeys.h"
#include "m_argv.h"
#include "doomgeneric.h"

#include <ctype.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <SDL.h>
#include <emscripten.h>

static SDL_Window *window = NULL;
static SDL_Renderer *renderer = NULL;
static SDL_Texture *texture = NULL;

#define KEYQUEUE_SIZE 64
static unsigned short key_queue[KEYQUEUE_SIZE];
static unsigned int key_write = 0;
static unsigned int key_read = 0;

static unsigned char to_doom_key(unsigned int key)
{
    switch (key)
    {
        case SDLK_RETURN: return KEY_ENTER;
        case SDLK_ESCAPE: return KEY_ESCAPE;

        case SDLK_LEFT:
        case SDLK_a: return KEY_LEFTARROW;

        case SDLK_RIGHT:
        case SDLK_d: return KEY_RIGHTARROW;

        case SDLK_UP:
        case SDLK_w: return KEY_UPARROW;

        case SDLK_DOWN:
        case SDLK_s: return KEY_DOWNARROW;

        case SDLK_LCTRL:
        case SDLK_RCTRL:
        case SDLK_j: return KEY_FIRE;

        case SDLK_SPACE:
        case SDLK_e: return KEY_USE;

        case SDLK_LSHIFT:
        case SDLK_RSHIFT: return KEY_RSHIFT;

        case SDLK_LALT:
        case SDLK_RALT: return KEY_LALT;

        case SDLK_F1: return KEY_F1;
        case SDLK_F2: return KEY_F2;
        case SDLK_F3: return KEY_F3;
        case SDLK_F4: return KEY_F4;
        case SDLK_F5: return KEY_F5;
        case SDLK_F6: return KEY_F6;
        case SDLK_F7: return KEY_F7;
        case SDLK_F8: return KEY_F8;
        case SDLK_F9: return KEY_F9;
        case SDLK_F10: return KEY_F10;
        case SDLK_F11: return KEY_F11;

        case SDLK_EQUALS:
        case SDLK_PLUS: return KEY_EQUALS;
        case SDLK_MINUS: return KEY_MINUS;

        default:
            if (key <= 0x7f)
                return (unsigned char)tolower((unsigned char)key);
            return 0;
    }
}

static void queue_key(int pressed, unsigned int keycode)
{
    const unsigned char doom_key = to_doom_key(keycode);
    const unsigned int next = (key_write + 1) % KEYQUEUE_SIZE;

    if (doom_key == 0 || next == key_read)
        return;

    key_queue[key_write] = (unsigned short)(((pressed ? 1 : 0) << 8) | doom_key);
    key_write = next;
}

static void poll_events(void)
{
    SDL_Event e;
    while (SDL_PollEvent(&e))
    {
        switch (e.type)
        {
            case SDL_QUIT:
                emscripten_cancel_main_loop();
                break;
            case SDL_KEYDOWN:
                if (!e.key.repeat)
                    queue_key(1, e.key.keysym.sym);
                break;
            case SDL_KEYUP:
                queue_key(0, e.key.keysym.sym);
                break;
            default:
                break;
        }
    }
}

void DG_Init(void)
{
    if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_EVENTS) != 0)
    {
        fprintf(stderr, "SDL_Init failed: %s\n", SDL_GetError());
        return;
    }

    SDL_SetHint(SDL_HINT_RENDER_SCALE_QUALITY, "0");

    window = SDL_CreateWindow(
        "DOOM",
        SDL_WINDOWPOS_CENTERED,
        SDL_WINDOWPOS_CENTERED,
        DOOMGENERIC_RESX * 2,
        DOOMGENERIC_RESY * 2,
        SDL_WINDOW_SHOWN | SDL_WINDOW_RESIZABLE
    );

    if (!window)
    {
        fprintf(stderr, "SDL_CreateWindow failed: %s\n", SDL_GetError());
        return;
    }

    renderer = SDL_CreateRenderer(window, -1, SDL_RENDERER_ACCELERATED);
    if (!renderer)
        renderer = SDL_CreateRenderer(window, -1, SDL_RENDERER_SOFTWARE);

    if (!renderer)
    {
        fprintf(stderr, "SDL_CreateRenderer failed: %s\n", SDL_GetError());
        return;
    }

    SDL_RenderSetLogicalSize(renderer, DOOMGENERIC_RESX, DOOMGENERIC_RESY);

    texture = SDL_CreateTexture(
        renderer,
        SDL_PIXELFORMAT_RGB888,
        SDL_TEXTUREACCESS_STREAMING,
        DOOMGENERIC_RESX,
        DOOMGENERIC_RESY
    );

    if (!texture)
        fprintf(stderr, "SDL_CreateTexture failed: %s\n", SDL_GetError());
}

void DG_DrawFrame(void)
{
    if (!renderer || !texture)
        return;

    SDL_UpdateTexture(
        texture,
        NULL,
        DG_ScreenBuffer,
        DOOMGENERIC_RESX * (int)sizeof(uint32_t)
    );

    SDL_RenderClear(renderer);
    SDL_RenderCopy(renderer, texture, NULL, NULL);
    SDL_RenderPresent(renderer);
    poll_events();
}

void DG_SleepMs(uint32_t ms)
{
    SDL_Delay(ms);
}

uint32_t DG_GetTicksMs(void)
{
    return SDL_GetTicks();
}

int DG_GetKey(int *pressed, unsigned char *doom_key)
{
    unsigned short data;

    if (key_read == key_write)
        return 0;

    data = key_queue[key_read];
    key_read = (key_read + 1) % KEYQUEUE_SIZE;

    *pressed = data >> 8;
    *doom_key = data & 0xff;
    return 1;
}

void DG_SetWindowTitle(const char *title)
{
    if (window)
        SDL_SetWindowTitle(window, title);
}

int main(int argc, char **argv)
{
    doomgeneric_Create(argc, argv);

    /* Do not simulate an infinite loop: JavaScript calls main after the WAD
       is mounted, and the browser owns the continuing animation loop. */
    emscripten_set_main_loop(doomgeneric_Tick, 0, 0);
    return 0;
}
