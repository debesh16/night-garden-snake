/* test_core.c - native tests for the core (gcc). Plays many bot games in
   every mode/shape, exports the replay, re-simulates it in another slot and
   checks the results are identical.
   Build: see the "test" target in the Makefile. */
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "snake_core.h"

static int failures = 0;
#define CHECK(c, ...) do { if (!(c)) { failures++; printf("FAIL: " __VA_ARGS__); printf("\n"); } } while (0)

static uint32_t bot_rng = 12345;
static int bot_rand(int n) {
    bot_rng ^= bot_rng << 13; bot_rng ^= bot_rng >> 17; bot_rng ^= bot_rng << 5;
    return (int)(bot_rng % (uint32_t)n);
}

/* Greedy square-board bot: prefer safe moves toward the first fruit. */
static int bot_dir(const int32_t *v, int p) {
    int w = v[V_W], h = v[V_H], shape = v[V_SHAPE];
    if (shape == SHAPE_HEX) return bot_rand(6);
    const int32_t *sn = v + (p ? V_SNAKE1 : V_SNAKE0);
    int head = sn[0], hx = head % w, hy = head / w;
    int fx = v[V_FOOD] % w, fy = v[V_FOOD] / w;
    static const int dx[4] = { 0, 1, 0, -1 }, dy[4] = { -1, 0, 1, 0 };
    int best = -1, bestScore = -100000;
    for (int d = 0; d < 4; d++) {
        int nx = hx + dx[d], ny = hy + dy[d];
        if (shape == SHAPE_TORUS || shape == SHAPE_MOBIUS) {
            if (nx < 0 || nx >= w) { nx = (nx + w) % w; if (shape == SHAPE_MOBIUS) ny = h - 1 - ny; }
            if (shape == SHAPE_TORUS) ny = (ny + h) % h;
        }
        int sc = 0;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) sc -= 10000;
        else {
            int c = ny * w + nx;
            if (v[V_TILES + c] == T_WALL) sc -= 10000;
            for (int q = 0; q < v[V_PLAYERS]; q++) {
                const int32_t *o = v + (q ? V_SNAKE1 : V_SNAKE0);
                for (int i = 0; i < v[V_LEN0 + q] - 1; i++)
                    if (o[i] == c) sc -= 10000;
            }
            sc -= abs(nx - fx) + abs(ny - fy);
        }
        sc += bot_rand(3);
        if (sc > bestScore) { bestScore = sc; best = d; }
    }
    return best;
}

typedef struct { int score0, score1, len0, tick, status, fruits, events; int32_t snake[64]; } Summary;

static void summarize(Summary *s) {
    const int32_t *v = game_state_ptr();
    memset(s, 0, sizeof *s);
    s->score0 = v[V_SCORE0]; s->score1 = v[V_SCORE1]; s->len0 = v[V_LEN0];
    s->tick = v[V_TICK]; s->status = v[V_STATUS]; s->fruits = v[V_FRUITS]; s->events = v[V_EVENTS];
    /* only the live cells: entries past the length are left over from older games */
    for (int i = 0; i < 64 && i < s->len0; i++) s->snake[i] = v[V_SNAKE0 + i];
}

static uint8_t replay_buf[SC_IO_CAP];

static int play_one(int mode, int shape, int seed, int smart, Summary *out, int *replay_len) {
    game_select(0);
    game_new(mode, shape, seed, 0);
    int rewinds_used = 0;
    for (int t = 0; t < 4000; t++) {
        const int32_t *v = game_state_ptr();
        if (v[V_STATUS] == ST_PERK) { game_choose_perk(bot_rand(3)); continue; }
        if (v[V_STATUS] == ST_OVER) {
            if (mode == MODE_REWIND && v[V_REWINDS] > 0 && game_rewind_begin()) {
                game_rewind(5 + bot_rand(10));
                game_rewind_end();
                rewinds_used++;
                continue;
            }
            break;
        }
        for (int p = 0; p < v[V_PLAYERS]; p++)
            if (bot_rand(smart ? 1 : 4) == 0)
                game_input(p, smart ? bot_dir(v, p) : bot_rand(v[V_SHAPE] == SHAPE_HEX ? 6 : 4));
        if (mode == MODE_RHYTHM && t % 2 == 0) game_beat();
        game_step();
    }
    summarize(out);
    int n = game_export_replay();
    memcpy(replay_buf, game_io_ptr(), (size_t)n);
    *replay_len = n;
    return rewinds_used;
}

static void resimulate(int len, Summary *out) {
    game_select(1);
    memcpy(game_io_ptr(), replay_buf, (size_t)len);
    CHECK(game_load_replay(len), "load replay");
    int guard = 0;
    while (game_replay_advance() != -1 && guard++ < 100000) {}
    summarize(out);
    game_select(0);
}

int main(void) {
    int games = 0, max_fruits = 0, perk_screens = 0, total_rewinds = 0;
    CHECK(game_daily_number(2026, 1, 1) == 1, "daily #1");
    CHECK(game_daily_number(2026, 10, 8) == 281, "daily number Oct 8 = %d", game_daily_number(2026, 10, 8));
    CHECK(game_daily_seed(2026, 10, 8) == game_daily_seed(2026, 10, 8), "daily seed stable");
    CHECK(game_daily_seed(2026, 10, 8) != game_daily_seed(2026, 10, 9), "daily seed differs");

    for (int mode = 0; mode < MODE_CUSTOM; mode++) {
        int shapes = mode == MODE_WEIRD ? SHAPE_COUNT : 1;
        for (int shape = 0; shape < shapes; shape++) {
            for (int seed = 1; seed <= 12; seed++) {
                Summary a, b;
                int len;
                total_rewinds += play_one(mode, shape, seed * 7919, seed % 3 != 0, &a, &len);
                CHECK(len > 0, "mode %d shape %d: replay export", mode, shape);
                resimulate(len, &b);
                CHECK(memcmp(&a, &b, sizeof a) == 0,
                      "mode %d shape %d seed %d: replay mismatch score %d/%d tick %d/%d len %d/%d",
                      mode, shape, seed, a.score0, b.score0, a.tick, b.tick, a.len0, b.len0);
                if (a.fruits > max_fruits) max_fruits = a.fruits;
                if (mode == MODE_PERKS && a.fruits >= 10) perk_screens++;
                games++;
            }
        }
    }

    /* same seed + same inputs twice -> identical run */
    {
        Summary a, b; int la, lb;
        bot_rng = 99; play_one(MODE_PERKS, 0, 4242, 1, &a, &la);
        uint8_t first[SC_IO_CAP]; memcpy(first, replay_buf, (size_t)la);
        bot_rng = 99; play_one(MODE_PERKS, 0, 4242, 1, &b, &lb);
        CHECK(la == lb && memcmp(first, replay_buf, (size_t)la) == 0 && memcmp(&a, &b, sizeof a) == 0,
              "same seed + inputs differ");
    }

    /* level loading */
    {
        uint8_t lvl[SC_LEVEL_HDR + 20 * 12];
        memset(lvl, 0, sizeof lvl);
        lvl[0] = 'S'; lvl[1] = 'L'; lvl[2] = 1; lvl[3] = SHAPE_SQUARE; lvl[4] = 20; lvl[5] = 12;
        lvl[6] = 10; lvl[7] = 6; lvl[8] = DIR_RIGHT;
        lvl[SC_LEVEL_HDR + 2 * 20 + 4] = T_WALL;
        lvl[SC_LEVEL_HDR + 3 * 20 + 4] = T_PORTAL0;
        CHECK(!game_load_level(lvl, sizeof lvl), "unpaired portal must be rejected");
        lvl[SC_LEVEL_HDR + 9 * 20 + 15] = T_PORTAL0;
        CHECK(game_load_level(lvl, sizeof lvl), "valid level accepted");
        game_new(MODE_CUSTOM, 0, 5, 0);
        const int32_t *v = game_state_ptr();
        CHECK(v[V_W] == 20 && v[V_H] == 12 && v[V_SNAKE0] == 6 * 20 + 10, "custom level applied");
        CHECK(v[V_TILES + 2 * 20 + 4] == T_WALL, "custom wall");
    }

    /* fruit cycle apple -> banana -> grapes */
    {
        game_new(MODE_CLASSIC, 0, 77, 0);
        CHECK(game_state_ptr()[V_FOOD + 1] == FRUIT_APPLE, "first fruit apple");
    }

    printf("%d games, best %d fruit, %d perk runs, %d rewinds used, %d failures\n",
           games, max_fruits, perk_screens, total_rewinds, failures);
    return failures ? 1 : 0;
}
