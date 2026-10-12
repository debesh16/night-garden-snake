/* snake_core.c - game rules and the exported API.
   Rules follow the original console snake.c: 2-step direction queue, the
   tail moves out of the way unless you grow, 10 points per fruit, and the
   delay drops 5 ms per fruit from 200 ms to 60 ms. */
#include "internal.h"

static Game    g_games[SC_SLOTS];
static int     g_cur;
static uint8_t g_io[SC_IO_CAP];

#define CUR (&g_games[g_cur])

/* ------------------------------------------------------------------------ */
/* helpers                                                                  */
/* ------------------------------------------------------------------------ */

int sim_on_snake(const Sim *s, int cell) {
    for (int p = 0; p < s->players; p++) {
        const Snake *k = &s->s[p];
        for (int i = 0; i < k->len; i++)
            if (k->cell[i] == cell) return 1;
    }
    return 0;
}

int sim_food_at(const Sim *s, int cell) {
    for (int i = 0; i < s->food_n; i++)
        if (s->food_cell[i] == cell) return i;
    return -1;
}

/* Place one fruit on a random free floor cell. Returns 0 if the board is full. */
int sim_spawn_food(Sim *s) {
    if (s->food_n >= SC_MAX_FOOD) return 0;
    static uint8_t blocked[SC_MAX_CELLS];
    int n = s->w * s->h, free_cells = 0;
    for (int c = 0; c < n; c++) {
        int t = s->tiles[c];
        blocked[c] = (uint8_t)(t != T_EMPTY && t != T_ICE);
    }
    for (int p = 0; p < s->players; p++)
        for (int i = 0; i < s->s[p].len; i++)
            blocked[s->s[p].cell[i]] = 1;
    for (int i = 0; i < s->food_n; i++)
        blocked[s->food_cell[i]] = 1;
    for (int c = 0; c < n; c++)
        free_cells += !blocked[c];
    if (free_cells == 0) return 0;

    int pick = rng_range(&s->rng, free_cells);
    for (int c = 0; c < n; c++) {
        if (blocked[c]) continue;
        if (pick-- == 0) {
            s->food_cell[s->food_n] = c;
            s->food_type[s->food_n] = s->fruit_cycle % 3;   /* apple, banana, grapes */
            s->fruit_cycle++;
            s->food_n++;
            return 1;
        }
    }
    return 0;
}

void sim_place_snake(Sim *s, int p, int x, int y, int dir, int len) {
    Snake *k = &s->s[p];
    int back = dir_opposite(s, dir);
    int cell = y * s->w + x;
    k->len = len;
    k->dir = dir;
    k->alive = 1;
    k->cell[0] = (uint16_t)cell;
    for (int i = 1; i < len; i++) {
        int fl;
        cell = board_move(s, cell, back, 0, &fl);
        k->cell[i] = (uint16_t)cell;
    }
}

static int sim_delay(const Sim *s) {
    int fruits = s->players == 2 ? s->fruits / 2 : s->fruits;
    int start = 200, min = 60, step = 5;
    if (s->mode == MODE_DARKNESS) start = 220;
    if (s->mode == MODE_ICE) start = 210;
    int d = start - fruits * step;
    if (d < min) d = min;
    if (s->fever) d = 55;
    if (s->slow_ticks > 0) d = d * 3 / 2;
    return d;
}

static void sim_update_light(Sim *s) {
    s->light = 5 - s->fruits / 8;
    if (s->light < 3) s->light = 3;
}

/* ------------------------------------------------------------------------ */
/* setup                                                                    */
/* ------------------------------------------------------------------------ */

static void sim_new(Sim *s, const Game *g, int mode, int shape, uint32_t seed, int flags) {
    memset(s, 0, sizeof *s);
    if (mode < 0 || mode >= MODE_COUNT) mode = MODE_CLASSIC;
    s->mode = mode;
    s->seed = seed;
    s->rng = rng_seed(seed);
    s->flags = flags;
    s->players = mode == MODE_VERSUS ? 2 : 1;
    s->status = ST_RUNNING;
    s->mult = 100;
    s->winner = -1;
    s->death_cell = -1;
    s->last_eat_cell = -1;
    s->last_eat_tick = -100;
    s->rewinds_left = mode == MODE_REWIND ? 3 : 0;
    s->food_target = mode == MODE_VERSUS ? 2 : 1;

    if (mode == MODE_WEIRD)
        s->shape = (shape >= 0 && shape < SHAPE_COUNT) ? shape : SHAPE_TORUS;
    else if (mode == MODE_DAILY)
        s->shape = seed % 4 == 1 ? SHAPE_TORUS : SHAPE_SQUARE;
    else
        s->shape = SHAPE_SQUARE;
    s->w = s->shape == SHAPE_HEX ? SC_HEX_W : SC_STD_W;
    s->h = s->shape == SHAPE_HEX ? SC_HEX_H : SC_STD_H;

    if (mode == MODE_CUSTOM && g->level_len > 0) {
        level_apply(s, g->level);
    } else if (mode == MODE_VERSUS) {
        sim_place_snake(s, 0, s->w / 4 + 2, s->h / 3, DIR_RIGHT, 3);
        sim_place_snake(s, 1, 3 * s->w / 4 - 3, 2 * s->h / 3, DIR_LEFT, 3);
    } else {
        /* same start as the console game: middle, facing right, length 3 */
        sim_place_snake(s, 0, s->w / 2, s->h / 2, s->shape == SHAPE_HEX ? HEX_E : DIR_RIGHT, 3);
    }

    if (mode == MODE_WEIRD && s->shape == SHAPE_PORTALS) board_gen_portals(s, 3);
    if (mode == MODE_ICE) board_gen_ice(s);
    if (mode == MODE_DAILY) daily_setup(s);

    sim_update_light(s);
    while (s->food_n < s->food_target && sim_spawn_food(s)) {}
}

/* ------------------------------------------------------------------------ */
/* one tick                                                                 */
/* ------------------------------------------------------------------------ */

static void choose_direction(Sim *s, Snake *k, int *ev) {
    int t = s->tiles[k->cell[0]];
    if (TILE_IS_CONV(t) && s->shape != SHAPE_HEX) {
        int cd = t - T_CONV_UP;
        if (cd != dir_opposite(s, k->dir)) {     /* conveyor pushes you */
            k->dir = cd;
            *ev |= EV_CONVEYOR;
            return;
        }
    } else if (t == T_ICE || TILE_IS_CONV(t)) {  /* ice: keep sliding */
        *ev |= EV_ICE;
        return;
    }
    while (k->queued) {
        int d = k->queue[0];
        k->queue[0] = k->queue[1];
        k->queued--;
        if (d != k->dir && d != dir_opposite(s, k->dir)) {
            k->dir = d;
            break;
        }
    }
}

static int score_fruit(Sim *s, Snake *k, int on_beat, int *ev) {
    int pts = 10;
    if (s->tick - s->last_eat_tick <= 20) s->combo++;
    else s->combo = 1;
    if (s->combo >= 2) *ev |= EV_COMBO;

    if (s->mode != MODE_CLASSIC && s->mode != MODE_VERSUS && s->mode != MODE_DAILY) {
        pts = 10 * s->mult / 100 + (s->combo - 1) * 2;
        if (s->mode == MODE_DARKNESS) pts += 5;
        if (s->mode == MODE_RHYTHM) {
            if (on_beat) {
                pts += 15 + 5 * s->beat_streak;
                s->beat_streak++;
                *ev |= EV_BEAT_HIT;
            } else {
                s->beat_streak = 0;
            }
        }
    }
    k->score += pts;
    return pts;
}

static int sim_step(Sim *s) {
    if (s->status != ST_RUNNING) return 0;
    int ev = EV_MOVED;
    int target[SC_MAX_PLAYERS] = { -1, -1 };
    int dies[SC_MAX_PLAYERS] = { 0, 0 };
    int food[SC_MAX_PLAYERS] = { -1, -1 };
    int on_beat = s->beat_pending;
    s->beat_pending = 0;
    s->tick++;

    /* 1. where does every head want to go? */
    for (int p = 0; p < s->players; p++) {
        Snake *k = &s->s[p];
        if (!k->alive) continue;
        choose_direction(s, k, &ev);
        int fl, head = k->cell[0];
        int c = board_move(s, head, k->dir, 0, &fl);
        if (c < 0 && k->wallpass > 0) {
            k->wallpass--;
            c = board_move(s, head, k->dir, 1, &fl);
        }
        if (fl & MOVE_WRAP) ev |= EV_WRAPPED;
        if (fl & MOVE_PORTAL) ev |= EV_PORTAL;
        if (c < 0 || s->tiles[c] == T_WALL) {
            dies[p] = 1;
            s->death_cell = head;
            continue;
        }
        target[p] = c;
        food[p] = sim_food_at(s, c);
    }

    /* 2. collisions. A tail moves away this tick unless that snake grows
          (or is dying and therefore stays put). */
    for (int p = 0; p < s->players; p++) {
        Snake *k = &s->s[p];
        if (!k->alive || dies[p]) continue;
        for (int q = 0; q < s->players && !dies[p]; q++) {
            const Snake *o = &s->s[q];
            if (!o->alive) continue;
            int n = (food[q] >= 0 || dies[q]) ? o->len : o->len - 1;
            int hit = 0;
            for (int i = 0; i < n && !hit; i++)
                hit = o->cell[i] == target[p];
            if (!hit) continue;
            if (q == p && k->pass_self > 0) {
                k->pass_self--;
                ev |= EV_PASSED_SELF;
            } else {
                dies[p] = 1;
                s->death_cell = target[p];
            }
        }
    }
    if (s->players == 2 && s->s[0].alive && s->s[1].alive && !dies[0] && !dies[1]
        && target[0] == target[1]) {
        dies[0] = dies[1] = 1;                  /* head to head */
        s->death_cell = target[0];
    }

    /* 3. move the survivors */
    for (int p = 0; p < s->players; p++) {
        Snake *k = &s->s[p];
        if (!k->alive || dies[p]) continue;
        if (food[p] >= 0 && k->len < SC_MAX_CELLS) k->len++;
        memmove(&k->cell[1], &k->cell[0], (size_t)(k->len - 1) * sizeof k->cell[0]);
        k->cell[0] = (uint16_t)target[p];
    }

    /* 4. eat */
    for (int p = 0; p < s->players; p++) {
        Snake *k = &s->s[p];
        if (!k->alive || dies[p] || food[p] < 0) continue;
        int f = sim_food_at(s, target[p]);
        if (f < 0) continue;
        s->last_eat_type = s->food_type[f];
        s->last_eat_cell = target[p];
        s->last_eat_player = p;
        s->food_n--;
        s->food_cell[f] = s->food_cell[s->food_n];
        s->food_type[f] = s->food_type[s->food_n];
        s->last_points = score_fruit(s, k, on_beat, &ev);
        s->last_eat_tick = s->tick;
        s->fruits++;
        ev |= EV_ATE;
        sim_update_light(s);
        if (s->mode == MODE_PERKS && s->fruits % 10 == 0) {
            perks_offer(s);
            s->status = ST_PERK;
            ev |= EV_PERK_READY;
        }
    }

    /* 5. deaths and the end of the round */
    for (int p = 0; p < s->players; p++)
        if (dies[p]) { s->s[p].alive = 0; ev |= EV_DIED; }
    if (s->players == 1) {
        if (!s->s[0].alive) s->status = ST_OVER;
    } else if (!s->s[0].alive || !s->s[1].alive) {
        s->status = ST_OVER;
        s->winner = s->s[0].alive ? 0 : s->s[1].alive ? 1 : -1;
    }

    /* 6. refill food; a full board is a win */
    while (s->food_n < s->food_target && sim_spawn_food(s)) {}
    if (s->food_n == 0 && s->status != ST_OVER) {
        s->won = 1;
        s->status = ST_OVER;
        ev |= EV_WON;
    }

    if (s->status != ST_OVER) ev |= perks_tick(s);
    if (s->status == ST_OVER) ev |= EV_GAME_OVER;
    s->events = ev;
    return ev;
}

/* ------------------------------------------------------------------------ */
/* view                                                                     */
/* ------------------------------------------------------------------------ */

static void fill_view(Game *g) {
    const Sim *s = &g->sim;
    int32_t *v = g->view;
    v[V_API] = SC_API_VERSION;
    v[V_W] = s->w;            v[V_H] = s->h;
    v[V_SHAPE] = s->shape;    v[V_MODE] = s->mode;
    v[V_TICK] = s->tick;      v[V_STATUS] = s->status;
    v[V_DELAY] = sim_delay(s);
    for (int p = 0; p < SC_MAX_PLAYERS; p++) {
        const Snake *k = &s->s[p];
        int on = p < s->players;
        v[V_SCORE0 + p] = on ? k->score : 0;
        v[V_LEN0 + p]   = on ? k->len : 0;
        v[V_ALIVE0 + p] = on ? k->alive : 0;
        v[V_DIR0 + p]   = on ? k->dir : 0;
        int32_t *dst = v + (p ? V_SNAKE1 : V_SNAKE0);
        for (int i = 0; i < (on ? k->len : 0); i++) dst[i] = k->cell[i];
    }
    v[V_FRUITS] = s->fruits;  v[V_COMBO] = s->combo;   v[V_MULT] = s->mult;
    v[V_REWINDS] = s->rewinds_left;
    v[V_RW_FILL] = g->ring_count;
    v[V_REWINDING] = g->rewinding;
    v[V_PERK0] = s->perk_opts[0]; v[V_PERK1] = s->perk_opts[1]; v[V_PERK2] = s->perk_opts[2];
    v[V_PASS_SELF] = s->s[0].pass_self;
    v[V_SLOW] = s->slow_ticks;  v[V_MAGNET] = s->magnet_ticks;
    v[V_TWIN] = s->twin;        v[V_CLOSING] = s->closing;
    v[V_WALLPASS] = s->s[0].wallpass;
    v[V_FEVER] = s->fever;
    v[V_FOOD_N] = s->food_n;
    for (int i = 0; i < SC_MAX_FOOD; i++) {
        v[V_FOOD + i * 2]     = i < s->food_n ? s->food_cell[i] : -1;
        v[V_FOOD + i * 2 + 1] = i < s->food_n ? s->food_type[i] : -1;
    }
    v[V_EAT_TYPE] = s->last_eat_type;  v[V_EAT_CELL] = s->last_eat_cell;
    v[V_EAT_PTS] = s->last_points;     v[V_EAT_PLAYER] = s->last_eat_player;
    v[V_EVENTS] = s->events;           v[V_WINNER] = s->winner;
    v[V_LIGHT] = s->light;             v[V_PLAYERS] = s->players;
    v[V_SEED] = (int32_t)s->seed;      v[V_DEATH_CELL] = s->death_cell;
    v[V_SHRINK] = s->shrink;           v[V_BEAT_STREAK] = s->beat_streak;
    v[V_WON] = s->won;                 v[V_REC_OK] = g->rec_ok;
    v[V_REPLAYING] = g->replaying;     v[V_FLAGS] = s->flags;
    for (int c = 0; c < s->w * s->h; c++) v[V_TILES + c] = s->tiles[c];
}

/* ------------------------------------------------------------------------ */
/* internal actions (shared by the API and replay playback)                 */
/* ------------------------------------------------------------------------ */

static void start_game(Game *g, int mode, int shape, uint32_t seed, int flags, int record) {
    sim_new(&g->sim, g, mode, shape, seed, flags);
    rewind_clear(g);
    g->recording = record;
    g->replaying = 0;
    rec_begin(g);
}

static int do_input(Game *g, int player, int dir) {
    Sim *s = &g->sim;
    if (s->status != ST_RUNNING || g->rewinding) return 0;
    if (player < 0 || player >= s->players || dir < 0 || dir >= dir_count(s)) return 0;
    Snake *k = &s->s[player];
    if (!k->alive) return 0;
    int last = k->queued ? k->queue[k->queued - 1] : k->dir;
    /* ignore same direction, reversing into yourself, or a full queue */
    if (dir == last || dir == dir_opposite(s, last) || k->queued == 2) return 0;
    k->queue[k->queued++] = dir;
    rec_byte(g, (uint8_t)((player << 3) | dir));
    return 1;
}

static void do_beat(Game *g) {
    if (g->sim.status != ST_RUNNING) return;
    g->sim.beat_pending = 1;
    rec_byte(g, 0x10);
}

static int do_step(Game *g) {
    if (g->sim.status != ST_RUNNING || g->rewinding) return 0;
    if (g->sim.mode == MODE_REWIND) rewind_push(g);
    int ev = sim_step(&g->sim);
    rec_step(g);
    return ev;
}

static int do_choose(Game *g, int i) {
    Sim *s = &g->sim;
    if (s->status != ST_PERK || i < 0 || i > 2) return 0;
    perks_apply(s, s->perk_opts[i]);
    s->status = ST_RUNNING;
    rec_byte(g, (uint8_t)(0x20 + i));
    return 1;
}

static int do_rewind_begin(Game *g) {
    Sim *s = &g->sim;
    if (s->mode != MODE_REWIND || g->rewinding || s->rewinds_left <= 0 || g->ring_count == 0)
        return 0;
    s->rewinds_left--;
    g->rewinding = 1;
    rec_byte(g, 0x30);
    return 1;
}

static int do_rewind(Game *g, int steps) {
    int done = 0;
    if (!g->rewinding) return 0;
    while (done < steps && rewind_pop(g)) {
        done++;
        rec_byte(g, 0x31);
    }
    g->sim.events = done ? EV_REWOUND : 0;
    return done;
}

static int do_rewind_end(Game *g) {
    if (!g->rewinding) return 0;
    g->rewinding = 0;
    g->sim.s[0].queued = 0;
    rec_byte(g, 0x32);
    return 1;
}

/* ------------------------------------------------------------------------ */
/* exported API                                                             */
/* ------------------------------------------------------------------------ */

SC_EXPORT int game_api_version(void) { return SC_API_VERSION; }

SC_EXPORT int game_select(int slot) {
    if (slot < 0 || slot >= SC_SLOTS) return 0;
    g_cur = slot;
    return 1;
}

SC_EXPORT int game_new(int mode, int shape, int seed, int flags) {
    Game *g = CUR;
    start_game(g, mode, shape, (uint32_t)seed, flags, 1);
    fill_view(g);
    return 1;
}

SC_EXPORT int game_reset(void) {
    Game *g = CUR;
    Sim *s = &g->sim;
    return game_new(s->mode, s->shape, (int)s->seed, s->flags);
}

SC_EXPORT int game_input(int player, int dir) {
    Game *g = CUR;
    if (g->replaying) return 0;
    int ok = do_input(g, player, dir);
    return ok;
}

SC_EXPORT void game_beat(void) {
    Game *g = CUR;
    if (!g->replaying) do_beat(g);
}

SC_EXPORT int game_step(void) {
    Game *g = CUR;
    if (g->replaying) return 0;
    int ev = do_step(g);
    fill_view(g);
    return ev;
}

SC_EXPORT int32_t *game_state_ptr(void) { return CUR->view; }
SC_EXPORT int game_view_size(void) { return SC_VIEW_SIZE; }

SC_EXPORT int game_rewind_begin(void) {
    Game *g = CUR;
    int ok = g->replaying ? 0 : do_rewind_begin(g);
    fill_view(g);
    return ok;
}

SC_EXPORT int game_rewind(int steps) {
    Game *g = CUR;
    int n = g->replaying ? 0 : do_rewind(g, steps);
    fill_view(g);
    return n;
}

SC_EXPORT int game_rewind_end(void) {
    Game *g = CUR;
    int ok = g->replaying ? 0 : do_rewind_end(g);
    fill_view(g);
    return ok;
}

SC_EXPORT int game_choose_perk(int i) {
    Game *g = CUR;
    int ok = g->replaying ? 0 : do_choose(g, i);
    fill_view(g);
    return ok;
}

SC_EXPORT uint8_t *game_io_ptr(void) { return g_io; }

SC_EXPORT int game_load_level(const uint8_t *ptr, int len) {
    Game *g = CUR;
    if (!ptr || !level_validate(ptr, len)) return 0;
    memcpy(g->level, ptr, (size_t)len);
    g->level_len = len;
    return 1;
}

SC_EXPORT int game_export_replay(void) {
    Game *g = CUR;
    if (!g->rec_ok || g->rec_len > SC_IO_CAP) return 0;
    memcpy(g_io, g->rec, (size_t)g->rec_len);
    return g->rec_len;
}

SC_EXPORT int game_load_replay(int len) {
    Game *g = CUR;
    if (len < SC_REPLAY_HDR || len > REC_CAP) return 0;
    if (g_io[0] != 'S' || g_io[1] != 'R' || g_io[2] != 1) return 0;
    uint32_t seed = (uint32_t)g_io[6] | (uint32_t)g_io[7] << 8 |
                    (uint32_t)g_io[8] << 16 | (uint32_t)g_io[9] << 24;
    start_game(g, g_io[3], g_io[4], seed, g_io[5], 0);
    memcpy(g->rp, g_io + SC_REPLAY_HDR, (size_t)(len - SC_REPLAY_HDR));
    g->rp_len = len - SC_REPLAY_HDR;
    g->rp_pos = 0;
    g->rp_steps = 0;
    g->replaying = 1;
    fill_view(g);
    return 1;
}

/* Run replay ops until one tick (a step or a rewind step) happened.
   Returns that tick's events, or -1 when the replay is finished. */
SC_EXPORT int game_replay_advance(void) {
    Game *g = CUR;
    int ev = -1;
    while (g->replaying) {
        if (g->rp_steps > 0) {
            g->rp_steps--;
            ev = do_step(g);
            break;
        }
        if (g->rp_pos >= g->rp_len) { g->replaying = 0; break; }
        uint8_t op = g->rp[g->rp_pos++];
        if (op & 0x80)                  g->rp_steps = op & 0x7F;
        else if (op < 0x10)             do_input(g, op >> 3, op & 7);
        else if (op == 0x10)            do_beat(g);
        else if (op >= 0x20 && op <= 0x22) do_choose(g, op - 0x20);
        else if (op == 0x30)            do_rewind_begin(g);
        else if (op == 0x31)            { do_rewind(g, 1); ev = EV_REWOUND; break; }
        else if (op == 0x32)            do_rewind_end(g);
    }
    fill_view(g);
    return ev;
}

SC_EXPORT int game_daily_seed(int y, int m, int d) { return (int)daily_seed(y, m, d); }
SC_EXPORT int game_daily_number(int y, int m, int d) { return daily_number(y, m, d); }
