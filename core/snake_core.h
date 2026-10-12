/*
 * snake_core.h - platform independent Snake game core.
 *
 * No conio.h / windows.h / browser code lives here. The same files are used by
 *   - snake.c        (Windows console front end, compiled with gcc)
 *   - web/wasm/       (WebAssembly build, compiled with emcc)
 *   - server/api.c   (re-simulates submitted replays to verify scores)
 *
 * All rules (movement, collisions, food, scoring, modes, perks, rewind, RNG,
 * replays) are decided here. A front end only feeds inputs and draws the
 * flat "view" array described below.
 */
#ifndef SNAKE_CORE_H
#define SNAKE_CORE_H

#include <stdint.h>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define SC_EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define SC_EXPORT
#endif

#define SC_API_VERSION 1

/* ---- Board sizes -------------------------------------------------------- */
#define SC_MAX_W      32
#define SC_MAX_H      24
#define SC_MAX_CELLS  (SC_MAX_W * SC_MAX_H)
#define SC_STD_W      30          /* same 30x20 board as the console game */
#define SC_STD_H      20
#define SC_HEX_W      22
#define SC_HEX_H      16
#define SC_MAX_FOOD   4
#define SC_MAX_PLAYERS 2
#define SC_SLOTS      3           /* independent game instances (main, ghost, spare) */
#define SC_IO_CAP     65536       /* shared byte buffer for levels / replays */
#define SC_LEVEL_HDR  9
#define SC_LEVEL_MAX  (SC_LEVEL_HDR + SC_MAX_CELLS)
#define SC_REPLAY_HDR 10

/* ---- Modes --------------------------------------------------------------- */
enum {
    MODE_CLASSIC = 0,   /* original rules, speed rises per fruit           */
    MODE_REWIND,        /* Braid style rewind, limited uses                */
    MODE_PERKS,         /* roguelike cards every 10 fruit                  */
    MODE_WEIRD,         /* weird board shapes (shape argument is used)     */
    MODE_RHYTHM,        /* moves on the music, on-beat bonus               */
    MODE_DARKNESS,      /* small light radius                              */
    MODE_ICE,           /* ice and conveyor tiles                          */
    MODE_DAILY,         /* daily seed challenge                            */
    MODE_VERSUS,        /* local two player                                */
    MODE_CUSTOM,        /* level from the editor                           */
    MODE_COUNT
};

/* ---- Board shapes -------------------------------------------------------- */
enum {
    SHAPE_SQUARE = 0,   /* walls on every side                             */
    SHAPE_TORUS,        /* wrap around every edge                          */
    SHAPE_MOBIUS,       /* left/right edge wraps and flips vertically      */
    SHAPE_PORTALS,      /* walls + coloured portal pairs                   */
    SHAPE_HEX,          /* hexagonal grid ("odd-r" offset rows), 6 dirs    */
    SHAPE_COUNT
};

/* ---- Directions ---------------------------------------------------------- */
/* Square boards */
enum { DIR_UP = 0, DIR_RIGHT, DIR_DOWN, DIR_LEFT };
/* Hex board (counter clockwise, opposite = (d + 3) % 6) */
enum { HEX_E = 0, HEX_NE, HEX_NW, HEX_W, HEX_SW, HEX_SE };

/* ---- Tiles --------------------------------------------------------------- */
enum {
    T_EMPTY = 0,
    T_WALL  = 1,
    T_ICE   = 2,
    T_CONV_UP = 3, T_CONV_RIGHT = 4, T_CONV_DOWN = 5, T_CONV_LEFT = 6,
    T_PORTAL0 = 8              /* 8..11 : portal pair 0..3 (two cells each) */
};
#define T_PORTAL_PAIRS 4
#define TILE_IS_CONV(t)   ((t) >= T_CONV_UP && (t) <= T_CONV_LEFT)
#define TILE_IS_PORTAL(t) ((t) >= T_PORTAL0 && (t) < T_PORTAL0 + T_PORTAL_PAIRS)

/* ---- Status -------------------------------------------------------------- */
enum { ST_RUNNING = 0, ST_PERK = 1, ST_OVER = 2 };

/* ---- Fruit types (cycle apple -> banana -> grapes -> apple ...) ---------- */
enum { FRUIT_APPLE = 0, FRUIT_BANANA, FRUIT_GRAPES };

/* ---- Perk cards ---------------------------------------------------------- */
enum {
    PERK_PASS_SELF = 0,   /* pass through yourself once                    */
    PERK_SLOW,            /* slow time for ~10 s (80 ticks)                */
    PERK_TWIN,            /* food spawns in pairs                          */
    PERK_MAGNET,          /* food drifts toward your head                  */
    PERK_SHRINK,          /* lose 4 tail segments                          */
    PERK_BOOST,           /* score x1.5                                    */
    PERK_WALLPASS,        /* wrap through the border twice                 */
    PERK_NORMAL_COUNT,
    CURSE_CLOSING = PERK_NORMAL_COUNT, /* x3 score, walls move inward      */
    CURSE_FEVER,          /* x2 score, permanent max speed                 */
    PERK_COUNT
};

/* ---- Event bit flags returned by game_step() ----------------------------- */
#define EV_MOVED        0x0001
#define EV_ATE          0x0002
#define EV_DIED         0x0004
#define EV_PERK_READY   0x0008
#define EV_BEAT_HIT     0x0010   /* ate exactly on the beat ("PERFECT")     */
#define EV_PORTAL       0x0020
#define EV_WON          0x0040
#define EV_PASSED_SELF  0x0080
#define EV_WRAPPED      0x0100
#define EV_WALLS_CLOSED 0x0200
#define EV_ICE          0x0400
#define EV_CONVEYOR     0x0800
#define EV_COMBO        0x1000
#define EV_GAME_OVER    0x2000
#define EV_REWOUND      0x4000
#define EV_FOOD_MOVED   0x8000

/* ---- The view: a flat int32 array JS reads straight from HEAP32 ----------
 *
 * game_state_ptr() returns a pointer to SC_VIEW_SIZE int32 values.
 * A "cell" is an index y * W + x (x = cell % W, y = cell / W).
 * This layout is mirrored in web/js/main.js (const V = {...}).
 */
#define V_API        0   /* SC_API_VERSION                                 */
#define V_W          1
#define V_H          2
#define V_SHAPE      3
#define V_MODE       4
#define V_TICK       5   /* steps taken (rewinding moves it back)          */
#define V_STATUS     6   /* ST_*                                           */
#define V_DELAY      7   /* ms per step the core wants (speed)             */
#define V_SCORE0     8
#define V_SCORE1     9
#define V_LEN0      10
#define V_LEN1      11
#define V_ALIVE0    12
#define V_ALIVE1    13
#define V_DIR0      14
#define V_DIR1      15
#define V_FRUITS    16   /* fruit eaten this run (both players)            */
#define V_COMBO     17
#define V_MULT      18   /* score multiplier in percent (100 = x1)         */
#define V_REWINDS   19   /* rewinds left                                   */
#define V_RW_FILL   20   /* stored rewind snapshots (0..SC_RING)           */
#define V_REWINDING 21
#define V_PERK0     22   /* 3 offered perk ids when status == ST_PERK      */
#define V_PERK1     23
#define V_PERK2     24
#define V_PASS_SELF 25   /* charges                                        */
#define V_SLOW      26   /* ticks left                                     */
#define V_MAGNET    27   /* ticks left                                     */
#define V_TWIN      28
#define V_CLOSING   29   /* cursed: walls closing in                       */
#define V_WALLPASS  30   /* charges                                        */
#define V_FEVER     31   /* cursed: fever                                  */
#define V_FOOD_N    32
#define V_FOOD      33   /* SC_MAX_FOOD x (cell, type)  -> 33..40          */
#define V_EAT_TYPE  45   /* last eaten fruit type                          */
#define V_EAT_CELL  46
#define V_EAT_PTS   47   /* points of last eat                             */
#define V_EAT_PLAYER 48
#define V_EVENTS    49   /* events of the last step                        */
#define V_WINNER    50   /* versus: 0 / 1, -1 draw or none                 */
#define V_LIGHT     51   /* darkness light radius in cells                 */
#define V_PLAYERS   52
#define V_SEED      53
#define V_DEATH_CELL 54
#define V_SHRINK    55   /* closing walls ring count                       */
#define V_BEAT_STREAK 56
#define V_WON       57
#define V_REC_OK    58   /* replay recording still valid                   */
#define V_REPLAYING 59
#define V_FLAGS     60
#define V_HEADER    64
#define V_SNAKE0    V_HEADER                        /* SC_MAX_CELLS cells  */
#define V_SNAKE1    (V_SNAKE0 + SC_MAX_CELLS)
#define V_TILES     (V_SNAKE1 + SC_MAX_CELLS)       /* W*H tile codes      */
#define SC_VIEW_SIZE (V_TILES + SC_MAX_CELLS)

#define SC_RING 50   /* rewind history: 50 steps (~5 s at normal speed)     */

/* ---- Replay format -------------------------------------------------------
 * header: 'S','R', version(1), mode, shape, flags, seed (uint32 LE)
 * ops   : 0x00..0x0F  input  (player << 3 | dir)
 *         0x10        beat (next step is on the beat)
 *         0x20..0x22  choose perk card 0..2
 *         0x30 / 0x31 / 0x32  rewind begin / one rewind step / rewind end
 *         0x33        bonus rewind (granted after a rewarded ad)
 *         0x80 | n    n game steps (1..127)
 *
 * ---- Level format (editor) ----------------------------------------------
 * 'S','L', version(1), shape, w, h, start_x, start_y, start_dir, w*h tiles
 */

/* ---- API (all exported to JS with EMSCRIPTEN_KEEPALIVE) ------------------ */
SC_EXPORT int      game_api_version(void);
SC_EXPORT int      game_select(int slot);
SC_EXPORT int      game_new(int mode, int shape, int seed, int flags);
SC_EXPORT int      game_reset(void);
SC_EXPORT int      game_input(int player, int dir);
SC_EXPORT void     game_beat(void);
SC_EXPORT int      game_step(void);
SC_EXPORT int32_t *game_state_ptr(void);
SC_EXPORT int      game_view_size(void);
SC_EXPORT int      game_rewind_begin(void);
SC_EXPORT int      game_rewind(int steps);
SC_EXPORT int      game_rewind_end(void);
SC_EXPORT int      game_grant_rewind(void);      /* +1 rewind (rewind mode) */
SC_EXPORT int      game_choose_perk(int i);
SC_EXPORT uint8_t *game_io_ptr(void);
SC_EXPORT int      game_load_level(const uint8_t *ptr, int len);
SC_EXPORT int      game_export_replay(void);       /* -> bytes in io buffer */
SC_EXPORT int      game_load_replay(int len);      /* <- bytes in io buffer */
SC_EXPORT int      game_replay_advance(void);      /* events, -1 when done  */
SC_EXPORT int      game_daily_seed(int y, int m, int d);
SC_EXPORT int      game_daily_number(int y, int m, int d);

#endif
