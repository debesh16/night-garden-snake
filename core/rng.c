/* rng.c - deterministic xorshift32 PRNG. Never use rand(): a seed plus the
   list of inputs must always reproduce exactly the same game. */
#include "internal.h"

uint32_t rng_hash(uint32_t x) {
    x ^= x >> 16; x *= 0x7feb352dU;
    x ^= x >> 15; x *= 0x846ca68bU;
    x ^= x >> 16;
    return x;
}

uint32_t rng_seed(uint32_t seed) {
    uint32_t s = rng_hash(seed ^ 0x9E3779B9U);
    return s ? s : 0xA5A5A5A5U;           /* xorshift must never be 0 */
}

uint32_t rng_next(uint32_t *state) {
    uint32_t x = *state;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    return *state = x;
}

int rng_range(uint32_t *state, int n) {
    if (n <= 0) return 0;
    return (int)(rng_next(state) % (uint32_t)n);
}
