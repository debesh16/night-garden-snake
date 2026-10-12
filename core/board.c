/* board.c - board shapes (square, torus, Mobius, portals, hex) and the
   random tile generators used by the modes. */
#include "internal.h"

static const int SQ_D[4][2] = { {0, -1}, {1, 0}, {0, 1}, {-1, 0} };
/* odd-r hex offsets: E, NE, NW, W, SW, SE */
static const int HEX_EVEN[6][2] = { {1, 0}, {0, -1}, {-1, -1}, {-1, 0}, {-1, 1}, {0, 1} };
static const int HEX_ODD[6][2]  = { {1, 0}, {1, -1}, {0, -1},  {-1, 0}, {0, 1},  {1, 1} };

int dir_count(const Sim *s) { return s->shape == SHAPE_HEX ? 6 : 4; }

int dir_opposite(const Sim *s, int d) {
    return s->shape == SHAPE_HEX ? (d + 3) % 6 : (d + 2) % 4;
}

int board_portal_partner(const Sim *s, int cell) {
    int t = s->tiles[cell];
    for (int c = 0; c < s->w * s->h; c++)
        if (c != cell && s->tiles[c] == t)
            return c;
    return cell;
}

/* Move one step from cell in dir. Returns the new cell or -1 when the move
   leaves the board through a solid edge. force_wrap wraps like a torus
   (used by the wall-pass perk). */
int board_move(const Sim *s, int cell, int dir, int force_wrap, int *flags) {
    int x = cell % s->w, y = cell / s->w;
    int nx, ny;
    *flags = 0;
    if (s->shape == SHAPE_HEX) {
        const int (*t)[2] = (y & 1) ? HEX_ODD : HEX_EVEN;
        nx = x + t[dir][0];
        ny = y + t[dir][1];
    } else {
        nx = x + SQ_D[dir][0];
        ny = y + SQ_D[dir][1];
    }

    int outx = nx < 0 || nx >= s->w;
    int outy = ny < 0 || ny >= s->h;
    if (outx || outy) {
        if (force_wrap || s->shape == SHAPE_TORUS) {
            nx = (nx + s->w) % s->w;
            ny = (ny + s->h) % s->h;
        } else if (s->shape == SHAPE_MOBIUS && outx && !outy) {
            nx = (nx + s->w) % s->w;
            ny = s->h - 1 - ny;          /* the strip flips you over */
        } else {
            return -1;
        }
        *flags |= MOVE_WRAP;
    }

    int c = ny * s->w + nx;
    if (TILE_IS_PORTAL(s->tiles[c])) {
        *flags |= MOVE_PORTAL;
        c = board_portal_partner(s, c);
    }
    return c;
}

/* Distance (in rings) from the outer edge. 0 = border cells. */
int board_ring(const Sim *s, int cell) {
    int x = cell % s->w, y = cell / s->w;
    int r = x;
    if (y < r) r = y;
    if (s->w - 1 - x < r) r = s->w - 1 - x;
    if (s->h - 1 - y < r) r = s->h - 1 - y;
    return r;
}

/* Keep generated tiles away from the rows the snakes start on. */
int board_reserved(const Sim *s, int x, int y) {
    for (int p = 0; p < s->players; p++) {
        int hy = s->s[p].cell[0] / s->w;
        if (y >= hy - 1 && y <= hy + 1) return 1;
    }
    (void)x;
    return 0;
}

static int free_for_gen(const Sim *s, int x, int y) {
    if (x < 1 || y < 1 || x >= s->w - 1 || y >= s->h - 1) return 0;
    if (board_reserved(s, x, y)) return 0;
    return s->tiles[y * s->w + x] == T_EMPTY;
}

void board_gen_obstacles(Sim *s, int count) {
    for (int n = 0, tries = 0; n < count && tries < 200; tries++) {
        int horiz = rng_range(&s->rng, 2);
        int len = 3 + rng_range(&s->rng, 3);
        int x = 2 + rng_range(&s->rng, s->w - 4);
        int y = 2 + rng_range(&s->rng, s->h - 4);
        int ok = 1;
        for (int i = 0; i < len && ok; i++)
            ok = free_for_gen(s, horiz ? x + i : x, horiz ? y : y + i);
        if (!ok) continue;
        for (int i = 0; i < len; i++)
            s->tiles[(horiz ? y : y + i) * s->w + (horiz ? x + i : x)] = T_WALL;
        n++;
    }
}

void board_gen_portals(Sim *s, int pairs) {
    if (pairs > T_PORTAL_PAIRS) pairs = T_PORTAL_PAIRS;
    for (int p = 0; p < pairs; p++) {
        for (int k = 0; k < 2; k++) {
            for (int tries = 0; tries < 500; tries++) {
                int x = 2 + rng_range(&s->rng, s->w - 4);
                int y = 2 + rng_range(&s->rng, s->h - 4);
                /* keep a free ring around portals so you can exit them */
                int ok = 1;
                for (int dy = -1; dy <= 1 && ok; dy++)
                    for (int dx = -1; dx <= 1 && ok; dx++)
                        ok = free_for_gen(s, x + dx, y + dy);
                if (!ok) continue;
                s->tiles[y * s->w + x] = (uint8_t)(T_PORTAL0 + p);
                break;
            }
        }
    }
}

void board_gen_ice(Sim *s) {
    /* ice patches */
    for (int n = 0, tries = 0; n < 5 && tries < 300; tries++) {
        int pw = 3 + rng_range(&s->rng, 4), ph = 2 + rng_range(&s->rng, 3);
        int x = 1 + rng_range(&s->rng, s->w - pw - 1);
        int y = 1 + rng_range(&s->rng, s->h - ph - 1);
        int ok = 1;
        for (int j = 0; j < ph && ok; j++)
            for (int i = 0; i < pw && ok; i++)
                ok = free_for_gen(s, x + i, y + j);
        if (!ok) continue;
        for (int j = 0; j < ph; j++)
            for (int i = 0; i < pw; i++)
                s->tiles[(y + j) * s->w + x + i] = T_ICE;
        n++;
    }
    /* conveyor strips that push along their own length */
    for (int n = 0, tries = 0; n < 6 && tries < 300; tries++) {
        int horiz = rng_range(&s->rng, 2);
        int len = 4 + rng_range(&s->rng, 4);
        int x = 1 + rng_range(&s->rng, s->w - 2);
        int y = 1 + rng_range(&s->rng, s->h - 2);
        int d = horiz ? (rng_range(&s->rng, 2) ? DIR_RIGHT : DIR_LEFT)
                      : (rng_range(&s->rng, 2) ? DIR_DOWN : DIR_UP);
        int ok = 1;
        for (int i = 0; i < len && ok; i++)
            ok = free_for_gen(s, horiz ? x + i : x, horiz ? y : y + i);
        if (!ok) continue;
        for (int i = 0; i < len; i++)
            s->tiles[(horiz ? y : y + i) * s->w + (horiz ? x + i : x)] = (uint8_t)(T_CONV_UP + d);
        n++;
    }
}
