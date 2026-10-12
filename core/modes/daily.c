/* daily.c - daily seed challenge. Everyone gets the same board on the same
   UTC date. Day #1 is 2026-01-01. */
#include "../internal.h"

static int days_from_civil(int y, int m, int d) {
    /* Howard Hinnant's algorithm, days since 1970-01-01 */
    y -= m <= 2;
    int era = (y >= 0 ? y : y - 399) / 400;
    int yoe = y - era * 400;
    int doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    int doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + doe - 719468;
}

int daily_number(int y, int m, int d) {
    return days_from_civil(y, m, d) - days_from_civil(2026, 1, 1) + 1;
}

uint32_t daily_seed(int y, int m, int d) {
    return rng_hash((uint32_t)(y * 10000 + m * 100 + d) ^ 0x5EEDDA11U);
}

/* Each day gets a twist picked from its seed. Shape must already be set by
   sim setup; this adds the tiles. */
void daily_setup(Sim *s) {
    switch (s->seed % 4) {
    case 0: board_gen_obstacles(s, 6);                         break;
    case 1: board_gen_obstacles(s, 3);                         break; /* torus */
    case 2: board_gen_portals(s, 2); board_gen_obstacles(s, 3); break;
    case 3: board_gen_ice(s); board_gen_obstacles(s, 2);       break;
    }
}
