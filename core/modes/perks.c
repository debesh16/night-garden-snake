/* perks.c - roguelike perk cards: offering, applying and their timers. */
#include "../internal.h"

static int perk_active(const Sim *s, int id) {
    return (id == CURSE_CLOSING && s->closing) || (id == CURSE_FEVER && s->fever);
}

void perks_offer(Sim *s) {
    int pool[PERK_NORMAL_COUNT];
    for (int i = 0; i < PERK_NORMAL_COUNT; i++) pool[i] = i;
    /* partial Fisher-Yates: first three entries become random normal cards */
    for (int i = 0; i < 3; i++) {
        int j = i + rng_range(&s->rng, PERK_NORMAL_COUNT - i);
        int t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }
    s->perk_opts[0] = pool[0];
    s->perk_opts[1] = pool[1];
    s->perk_opts[2] = pool[2];

    /* 40% of the time one slot becomes a cursed card (high risk, high reward) */
    if (rng_range(&s->rng, 100) < 40) {
        int curse = CURSE_CLOSING + rng_range(&s->rng, 2);
        if (perk_active(s, curse)) curse = curse == CURSE_CLOSING ? CURSE_FEVER : CURSE_CLOSING;
        if (!perk_active(s, curse))
            s->perk_opts[rng_range(&s->rng, 3)] = curse;
    }
}

void perks_apply(Sim *s, int perk) {
    Snake *k = &s->s[0];
    switch (perk) {
    case PERK_PASS_SELF: k->pass_self++;                break;
    case PERK_SLOW:      s->slow_ticks += 80;           break;
    case PERK_TWIN:      s->twin = 1; s->food_target = 2; break;
    case PERK_MAGNET:    s->magnet_ticks += 120;        break;
    case PERK_SHRINK:    k->len = k->len - 4 < 3 ? 3 : k->len - 4; break;
    case PERK_BOOST:     s->mult = s->mult * 3 / 2;     break;
    case PERK_WALLPASS:  k->wallpass += 2;              break;
    case CURSE_CLOSING:  s->closing = 1; s->mult *= 3;  break;
    case CURSE_FEVER:    s->fever = 1;   s->mult *= 2;  break;
    }
    while (s->food_n < s->food_target && sim_spawn_food(s)) {}
}

static int food_cell_ok(const Sim *s, int c) {
    int t = s->tiles[c];
    if (t != T_EMPTY && t != T_ICE) return 0;
    return !sim_on_snake(s, c) && sim_food_at(s, c) < 0;
}

/* Magnet: every food moves one cell toward the head. */
static int magnet_drift(Sim *s) {
    int moved = 0;
    int head = s->s[0].cell[0];
    int hx = head % s->w, hy = head / s->w;
    for (int i = 0; i < s->food_n; i++) {
        int c = s->food_cell[i];
        int x = c % s->w, y = c / s->w;
        int dx = hx - x, dy = hy - y;
        int adx = dx < 0 ? -dx : dx, ady = dy < 0 ? -dy : dy;
        if (adx + ady <= 1) continue;               /* let the player take it */
        int nx = x, ny = y;
        if (adx >= ady) nx += dx > 0 ? 1 : -1;
        else            ny += dy > 0 ? 1 : -1;
        int nc = ny * s->w + nx;
        if (food_cell_ok(s, nc)) { s->food_cell[i] = nc; moved = 1; }
    }
    return moved ? EV_FOOD_MOVED : 0;
}

/* Cursed: walls creep inward one ring at a time. */
static void apply_closing(Sim *s) {
    for (int c = 0; c < s->w * s->h; c++) {
        if (board_ring(s, c) >= s->shrink || s->tiles[c] == T_WALL) continue;
        if (sim_on_snake(s, c)) continue;           /* closes once you leave */
        s->tiles[c] = T_WALL;
        int f = sim_food_at(s, c);
        if (f >= 0) {
            s->food_n--;
            s->food_cell[f] = s->food_cell[s->food_n];
            s->food_type[f] = s->food_type[s->food_n];
            sim_spawn_food(s);
        }
    }
}

int perks_tick(Sim *s) {
    int ev = 0;
    if (s->slow_ticks > 0) s->slow_ticks--;
    if (s->magnet_ticks > 0) {
        s->magnet_ticks--;
        if (s->tick % 2 == 0) ev |= magnet_drift(s);
    }
    if (s->closing) {
        if (++s->closing_timer >= 60 && s->shrink < 4) {
            s->shrink++;
            s->closing_timer = 0;
            ev |= EV_WALLS_CLOSED;
        }
        if (s->shrink > 0) apply_closing(s);
    }
    return ev;
}
