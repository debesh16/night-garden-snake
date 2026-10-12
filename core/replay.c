/* replay.c - records every state changing call so seed + ops reproduce a run.
   Used for ghosts, share links and server side score verification. */
#include "internal.h"

void rec_begin(Game *g) {
    const Sim *s = &g->sim;
    g->rec_len = 0;
    g->rec_run = -1;
    g->rec_ok = 1;
    g->rec[g->rec_len++] = 'S';
    g->rec[g->rec_len++] = 'R';
    g->rec[g->rec_len++] = 1;
    g->rec[g->rec_len++] = (uint8_t)s->mode;
    g->rec[g->rec_len++] = (uint8_t)s->shape;
    g->rec[g->rec_len++] = (uint8_t)s->flags;
    for (int i = 0; i < 4; i++)
        g->rec[g->rec_len++] = (uint8_t)(s->seed >> (8 * i));
}

void rec_byte(Game *g, uint8_t b) {
    if (!g->recording) return;
    if (g->rec_len >= REC_CAP) { g->rec_ok = 0; return; }
    g->rec[g->rec_len++] = b;
    g->rec_run = -1;
}

/* Steps are run-length encoded: 0x80 | n */
void rec_step(Game *g) {
    if (!g->recording) return;
    if (g->rec_run >= 0 && (g->rec[g->rec_run] & 0x7F) < 127) {
        g->rec[g->rec_run]++;
        return;
    }
    if (g->rec_len >= REC_CAP) { g->rec_ok = 0; return; }
    g->rec_run = g->rec_len;
    g->rec[g->rec_len++] = 0x81;
}
