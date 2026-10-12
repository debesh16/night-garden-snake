/* internal.h - structures shared by the core .c files (not part of the API). */
#ifndef SNAKE_INTERNAL_H
#define SNAKE_INTERNAL_H

#include "snake_core.h"
#include <string.h>

#define REC_CAP 32768

typedef struct {
    uint16_t cell[SC_MAX_CELLS];   /* index 0 = head */
    int len, dir, alive, score;
    int queue[2], queued;          /* 2-step direction queue from snake.c */
    int pass_self, wallpass;
} Snake;

/* Everything that defines one moment of a game. Copied whole for rewind. */
typedef struct {
    int mode, shape, w, h, players, flags;
    uint32_t seed, rng;
    uint8_t tiles[SC_MAX_CELLS];
    Snake s[SC_MAX_PLAYERS];
    int food_n, food_target;
    int food_cell[SC_MAX_FOOD], food_type[SC_MAX_FOOD];
    int fruit_cycle, fruits, tick, status, won, winner;
    int combo, last_eat_tick, mult;
    int last_points, last_eat_type, last_eat_cell, last_eat_player;
    int perk_opts[3];
    int slow_ticks, magnet_ticks, twin, closing, fever, shrink, closing_timer;
    int rewinds_left, beat_pending, beat_streak, death_cell, events, light;
} Sim;

typedef struct {
    Sim sim;
    Sim ring[SC_RING];
    int ring_head, ring_count, rewinding;
    uint8_t rec[REC_CAP];
    int rec_len, rec_run, rec_ok, recording;
    uint8_t rp[REC_CAP];
    int rp_len, rp_pos, rp_steps, replaying;
    uint8_t level[SC_LEVEL_MAX];
    int level_len;
    int32_t view[SC_VIEW_SIZE];
} Game;

/* rng.c */
uint32_t rng_hash(uint32_t x);
uint32_t rng_seed(uint32_t seed);
uint32_t rng_next(uint32_t *state);
int      rng_range(uint32_t *state, int n);

/* board.c */
#define MOVE_WRAP   1
#define MOVE_PORTAL 2
int  dir_count(const Sim *s);
int  dir_opposite(const Sim *s, int d);
int  board_move(const Sim *s, int cell, int dir, int force_wrap, int *flags);
int  board_ring(const Sim *s, int cell);
int  board_reserved(const Sim *s, int x, int y);
void board_gen_obstacles(Sim *s, int count);
void board_gen_portals(Sim *s, int pairs);
void board_gen_ice(Sim *s);
int  board_portal_partner(const Sim *s, int cell);

/* snake_core.c */
int  sim_on_snake(const Sim *s, int cell);
int  sim_food_at(const Sim *s, int cell);
int  sim_spawn_food(Sim *s);
void sim_place_snake(Sim *s, int p, int x, int y, int dir, int len);

/* modes/perks.c */
void perks_offer(Sim *s);
void perks_apply(Sim *s, int perk);
int  perks_tick(Sim *s);

/* modes/rewind.c */
void rewind_clear(Game *g);
void rewind_push(Game *g);
int  rewind_pop(Game *g);

/* modes/daily.c */
uint32_t daily_seed(int y, int m, int d);
int      daily_number(int y, int m, int d);
void     daily_setup(Sim *s);

/* level.c */
int  level_validate(const uint8_t *buf, int len);
void level_apply(Sim *s, const uint8_t *buf);

/* replay.c */
void rec_begin(Game *g);
void rec_byte(Game *g, uint8_t b);
void rec_step(Game *g);

#endif
