/* level.c - custom levels made in the web editor.
   Format: 'S','L', version, shape, w, h, start_x, start_y, start_dir, tiles */
#include "internal.h"

int level_validate(const uint8_t *b, int len) {
    if (len < SC_LEVEL_HDR || b[0] != 'S' || b[1] != 'L' || b[2] != 1) return 0;
    int shape = b[3], w = b[4], h = b[5];
    if (shape >= SHAPE_COUNT) return 0;
    if (w < 8 || h < 8 || w > SC_MAX_W || h > SC_MAX_H) return 0;
    if (len != SC_LEVEL_HDR + w * h) return 0;
    if (b[6] >= w || b[7] >= h) return 0;
    if (b[8] >= (shape == SHAPE_HEX ? 6 : 4)) return 0;
    for (int i = 0; i < w * h; i++) {
        int t = b[SC_LEVEL_HDR + i];
        if (t > T_CONV_LEFT && !TILE_IS_PORTAL(t)) return 0;
    }
    /* portals must come in pairs */
    for (int p = 0; p < T_PORTAL_PAIRS; p++) {
        int n = 0;
        for (int i = 0; i < w * h; i++)
            if (b[SC_LEVEL_HDR + i] == T_PORTAL0 + p) n++;
        if (n != 0 && n != 2) return 0;
    }
    if (b[SC_LEVEL_HDR + b[7] * w + b[6]] != T_EMPTY) return 0;
    return 1;
}

void level_apply(Sim *s, const uint8_t *b) {
    s->shape = b[3];
    s->w = b[4];
    s->h = b[5];
    memcpy(s->tiles, b + SC_LEVEL_HDR, (size_t)(s->w * s->h));

    /* Body trails behind the head while there is free floor, otherwise the
       remaining segments stack on the last free cell and unfold as you move. */
    Snake *k = &s->s[0];
    int dir = b[8], back = dir_opposite(s, dir);
    int cell = b[7] * s->w + b[6];
    k->len = 3;
    k->dir = dir;
    k->alive = 1;
    k->cell[0] = (uint16_t)cell;
    for (int i = 1; i < k->len; i++) {
        int fl, c = board_move(s, cell, back, 0, &fl);
        if (c >= 0 && !fl && s->tiles[c] == T_EMPTY) cell = c;
        k->cell[i] = (uint16_t)cell;
    }
}
