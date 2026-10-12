/* rewind.c - Braid style rewind: a ring buffer of the last SC_RING states. */
#include "../internal.h"

void rewind_clear(Game *g) {
    g->ring_head = 0;
    g->ring_count = 0;
    g->rewinding = 0;
}

void rewind_push(Game *g) {
    g->ring[g->ring_head] = g->sim;
    g->ring_head = (g->ring_head + 1) % SC_RING;
    if (g->ring_count < SC_RING) g->ring_count++;
}

/* Restore the newest stored state. The number of rewinds left is not part
   of history: rewinding never gives a rewind back. */
int rewind_pop(Game *g) {
    if (g->ring_count == 0) return 0;
    g->ring_head = (g->ring_head + SC_RING - 1) % SC_RING;
    g->ring_count--;
    int left = g->sim.rewinds_left;
    g->sim = g->ring[g->ring_head];
    g->sim.rewinds_left = left;
    return 1;
}
