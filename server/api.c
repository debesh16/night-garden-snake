/*
 * api.c - optional online backend for Night Garden Snake, written as a C CGI
 * program for Apache (or any CGI web server) and MySQL / MariaDB.
 *
 * Anti-cheat: a submitted run is only a replay (seed + inputs). The server
 * re-simulates it with the very same core/ C code the browser runs and stores
 * the score it computes itself. The number the browser shows is never trusted.
 *
 * Actions (?action=...):
 *   GET  ping                                  -> {"ok":true}
 *   POST submit        nickname, replay, daily[, password]
 *   GET  daily_top     day
 *   GET  levels
 *   POST publish_level nickname, name, data[, password]
 *   POST like_level    id, nickname[, password]
 *
 * Configuration comes from environment variables (Apache: SetEnv):
 *   SNAKE_DB_HOST, SNAKE_DB_USER, SNAKE_DB_PASS, SNAKE_DB_NAME,
 *   SNAKE_ALLOWED_ORIGIN (CORS, e.g. https://you.github.io), SNAKE_IP_SALT
 *
 * Build (see README_SERVER.md):
 *   gcc -std=gnu99 -O2 -Wall -Wextra -I../core api.c ../core/snake_core.c ../core/rng.c
 *       ../core/board.c ../core/level.c ../core/replay.c ../core/modes/perks.c
 *       ../core/modes/rewind.c ../core/modes/daily.c
 *       $(mysql_config --cflags --libs) -lcrypt -o snake-api.cgi
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdarg.h>
#include <time.h>
#include <crypt.h>
#include <mysql.h>
#include "snake_core.h"

#define MAX_BODY      70000
#define MAX_REPLAY    32768
#define MAX_LEVEL_B64 2048

static MYSQL *db;
static char body[MAX_BODY + 1];
static const char *query;

/* ------------------------------------------------------------------------ */
/* output                                                                   */
/* ------------------------------------------------------------------------ */

static void headers(int status) {
    const char *origin = getenv("SNAKE_ALLOWED_ORIGIN");
    if (status != 200) printf("Status: %d\r\n", status);
    printf("Content-Type: application/json; charset=utf-8\r\n");
    printf("Cache-Control: no-store\r\n");
    printf("Access-Control-Allow-Origin: %s\r\n", origin && *origin ? origin : "*");
    printf("Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n");
    printf("Access-Control-Allow-Headers: Content-Type\r\n\r\n");
}

static void json_str(const char *s, size_t n) {
    putchar('"');
    for (size_t i = 0; i < n; i++) {
        unsigned char c = (unsigned char)s[i];
        if (c == '"' || c == '\\') printf("\\%c", c);
        else if (c < 0x20) printf("\\u%04x", c);
        else putchar(c);
    }
    putchar('"');
}

static void fail(int status, const char *msg) {
    headers(status);
    printf("{\"ok\":false,\"error\":");
    json_str(msg, strlen(msg));
    printf("}\n");
    if (db) mysql_close(db);
    exit(0);
}

/* ------------------------------------------------------------------------ */
/* request parsing                                                          */
/* ------------------------------------------------------------------------ */

static int hexval(int c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

/* Find key in an application/x-www-form-urlencoded string and URL-decode it. */
static int param(const char *src, const char *key, char *out, size_t cap) {
    size_t klen = strlen(key);
    const char *p = src;
    while (p && *p) {
        const char *amp = strchr(p, '&');
        size_t seg = amp ? (size_t)(amp - p) : strlen(p);
        if (seg > klen && strncmp(p, key, klen) == 0 && p[klen] == '=') {
            size_t o = 0;
            for (size_t i = klen + 1; i < seg && o + 1 < cap; i++) {
                if (p[i] == '+') out[o++] = ' ';
                else if (p[i] == '%' && i + 2 < seg && hexval(p[i + 1]) >= 0 && hexval(p[i + 2]) >= 0) {
                    out[o++] = (char)(hexval(p[i + 1]) * 16 + hexval(p[i + 2]));
                    i += 2;
                } else out[o++] = p[i];
            }
            out[o] = 0;
            return 1;
        }
        p = amp ? amp + 1 : NULL;
    }
    out[0] = 0;
    return 0;
}

static void read_body(void) {
    const char *cl = getenv("CONTENT_LENGTH");
    long n = cl ? strtol(cl, NULL, 10) : 0;
    if (n < 0 || n > MAX_BODY) fail(413, "request too large");
    size_t got = n > 0 ? fread(body, 1, (size_t)n, stdin) : 0;
    body[got] = 0;
}

/* base64url -> bytes. Returns length or -1. */
static int b64url_decode(const char *in, uint8_t *out, int cap) {
    int val = 0, bits = 0, n = 0;
    for (; *in; in++) {
        int c = *in, d;
        if (c >= 'A' && c <= 'Z') d = c - 'A';
        else if (c >= 'a' && c <= 'z') d = c - 'a' + 26;
        else if (c >= '0' && c <= '9') d = c - '0' + 52;
        else if (c == '-' || c == '+') d = 62;
        else if (c == '_' || c == '/') d = 63;
        else if (c == '=') break;
        else return -1;
        val = (val << 6) | d;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            if (n >= cap) return -1;
            out[n++] = (uint8_t)((val >> bits) & 0xFF);
        }
    }
    return n;
}

/* Valid nickname: 1-16 chars of letters, digits, space, _ - . */
static int nickname_ok(const char *s) {
    size_t n = strlen(s);
    if (n < 1 || n > 16) return 0;
    for (size_t i = 0; i < n; i++) {
        char c = s[i];
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
              c == ' ' || c == '_' || c == '-' || c == '.'))
            return 0;
    }
    return 1;
}

/* Short salted hash of the client IP, so raw addresses are never stored. */
static void ip_hash(char out[17]) {
    const char *ip = getenv("REMOTE_ADDR");
    const char *salt = getenv("SNAKE_IP_SALT");
    uint64_t h = 1469598103934665603ULL;
    for (const char *p = salt ? salt : ""; *p; p++) { h ^= (uint8_t)*p; h *= 1099511628211ULL; }
    for (const char *p = ip ? ip : "?"; *p; p++) { h ^= (uint8_t)*p; h *= 1099511628211ULL; }
    snprintf(out, 17, "%016llx", (unsigned long long)h);
}

/* ------------------------------------------------------------------------ */
/* prepared statements                                                      */
/* ------------------------------------------------------------------------ */

/* type: 'i' integer, 's' text, 'b' binary */
typedef struct {
    char type;
    long long i;
    const void *ptr;
    unsigned long len;
} Arg;

typedef struct {
    char type;               /* 'i' or 's' (text / binary into buf) */
    long long i;
    char *buf;
    unsigned long cap, len;
} Col;

#define ARG_I(v)       { 'i', (long long)(v), NULL, 0 }
#define ARG_S(s)       { 's', 0, (s), (unsigned long)strlen(s) }
#define ARG_B(p, n)    { 'b', 0, (p), (unsigned long)(n) }

/* Prepare, bind and execute. Every value goes through a placeholder, so no
   user input is ever pasted into SQL. Returns the statement (with results
   bound when cols != NULL) or NULL on error. */
static MYSQL_STMT *run(const char *sql, Arg *args, int nargs, Col *cols, int ncols) {
    MYSQL_STMT *st = mysql_stmt_init(db);
    if (!st) return NULL;
    if (mysql_stmt_prepare(st, sql, (unsigned long)strlen(sql))) { mysql_stmt_close(st); return NULL; }

    MYSQL_BIND in[8], out[8];
    memset(in, 0, sizeof in);
    memset(out, 0, sizeof out);
    for (int k = 0; k < nargs && k < 8; k++) {
        if (args[k].type == 'i') {
            in[k].buffer_type = MYSQL_TYPE_LONGLONG;
            in[k].buffer = &args[k].i;
        } else {
            in[k].buffer_type = args[k].type == 'b' ? MYSQL_TYPE_BLOB : MYSQL_TYPE_STRING;
            in[k].buffer = (void *)args[k].ptr;
            in[k].buffer_length = args[k].len;
            in[k].length = &args[k].len;
        }
    }
    if (nargs && mysql_stmt_bind_param(st, in)) { mysql_stmt_close(st); return NULL; }
    if (mysql_stmt_execute(st)) { mysql_stmt_close(st); return NULL; }

    if (cols) {
        for (int k = 0; k < ncols && k < 8; k++) {
            if (cols[k].type == 'i') {
                out[k].buffer_type = MYSQL_TYPE_LONGLONG;
                out[k].buffer = &cols[k].i;
            } else {
                out[k].buffer_type = MYSQL_TYPE_BLOB;
                out[k].buffer = cols[k].buf;
                out[k].buffer_length = cols[k].cap;
                out[k].length = &cols[k].len;
            }
        }
        if (mysql_stmt_bind_result(st, out) || mysql_stmt_store_result(st)) { mysql_stmt_close(st); return NULL; }
    }
    return st;
}

static long long scalar(const char *sql, Arg *args, int nargs) {
    Col c = { 'i', 0, NULL, 0, 0 };
    MYSQL_STMT *st = run(sql, args, nargs, &c, 1);
    if (!st) fail(500, "database error");
    long long v = mysql_stmt_fetch(st) == 0 ? c.i : 0;
    mysql_stmt_close(st);
    return v;
}

static long long exec_insert(const char *sql, Arg *args, int nargs) {
    MYSQL_STMT *st = run(sql, args, nargs, NULL, 0);
    if (!st) return -1;
    long long id = (long long)mysql_stmt_insert_id(st);
    long long rows = (long long)mysql_stmt_affected_rows(st);
    mysql_stmt_close(st);
    return rows > 0 ? (id ? id : rows) : 0;
}

/* ------------------------------------------------------------------------ */
/* users                                                                    */
/* ------------------------------------------------------------------------ */

static void make_salt(char *out) {   /* "$6$" + 16 salt chars + "$" */
    static const char abc[] = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    unsigned char rnd[16];
    FILE *f = fopen("/dev/urandom", "rb");
    if (!f || fread(rnd, 1, sizeof rnd, f) != sizeof rnd) fail(500, "no randomness");
    fclose(f);
    strcpy(out, "$6$");
    for (int i = 0; i < 16; i++) out[3 + i] = abc[rnd[i] % 64];
    out[19] = '$';
    out[20] = 0;
}

/* Find or create the player. Nickname-only by default; a password, once set
   for a nickname, is required from then on (stored as SHA-512 crypt). */
static long long user_id(const char *nickname, const char *password) {
    if (!nickname_ok(nickname)) fail(400, "nickname must be 1-16 letters, digits, space, _ - .");
    char hash[160];
    Col cols[2] = { { 'i', 0, NULL, 0, 0 }, { 's', 0, hash, sizeof hash - 1, 0 } };
    Arg a[1] = { ARG_S(nickname) };
    MYSQL_STMT *st = run("SELECT id, IFNULL(pass_hash, '') FROM users WHERE nickname = ?", a, 1, cols, 2);
    if (!st) fail(500, "database error");
    int found = mysql_stmt_fetch(st) == 0;
    mysql_stmt_close(st);

    if (found) {
        hash[cols[1].len < sizeof hash ? cols[1].len : sizeof hash - 1] = 0;
        if (hash[0]) {
            struct crypt_data cd;
            memset(&cd, 0, sizeof cd);
            const char *h = crypt_r(password, hash, &cd);
            if (!h || strcmp(h, hash) != 0) fail(403, "wrong password for this nickname");
        }
        return cols[0].i;
    }

    if (password[0]) {
        char salt[24];
        struct crypt_data cd;
        memset(&cd, 0, sizeof cd);
        make_salt(salt);
        const char *h = crypt_r(password, salt, &cd);
        if (!h) fail(500, "hash failed");
        Arg ins[2] = { ARG_S(nickname), ARG_S(h) };
        long long id = exec_insert("INSERT INTO users (nickname, pass_hash) VALUES (?, ?)", ins, 2);
        if (id <= 0) fail(500, "could not create user");
        return id;
    }
    Arg ins[1] = { ARG_S(nickname) };
    long long id = exec_insert("INSERT INTO users (nickname) VALUES (?)", ins, 1);
    if (id <= 0) fail(500, "could not create user");
    return id;
}

/* ------------------------------------------------------------------------ */
/* actions                                                                  */
/* ------------------------------------------------------------------------ */

static void today(int *y, int *m, int *d) {
    time_t t = time(NULL);
    struct tm g;
    gmtime_r(&t, &g);
    *y = g.tm_year + 1900;
    *m = g.tm_mon + 1;
    *d = g.tm_mday;
}

static void act_submit(void) {
    static char nick[64], pass[128], rep64[MAX_REPLAY * 2], daily[8];
    static uint8_t rep[MAX_REPLAY];
    char iph[17];
    param(body, "nickname", nick, sizeof nick);
    param(body, "password", pass, sizeof pass);
    param(body, "replay", rep64, sizeof rep64);
    param(body, "daily", daily, sizeof daily);
    ip_hash(iph);

    /* rate limit: 6 submissions per minute per address */
    Arg rl[1] = { ARG_S(iph) };
    if (scalar("SELECT COUNT(*) FROM scores WHERE ip_hash = ? AND created_at > NOW() - INTERVAL 1 MINUTE", rl, 1) >= 6)
        fail(429, "too many submissions, wait a minute");

    int len = b64url_decode(rep64, rep, sizeof rep);
    if (len < SC_REPLAY_HDR || len > SC_IO_CAP) fail(400, "bad replay");
    int mode = rep[3];
    if (mode == MODE_VERSUS || mode == MODE_CUSTOM || mode >= MODE_COUNT) fail(400, "this mode is not ranked");
    uint32_t seed = (uint32_t)rep[6] | (uint32_t)rep[7] << 8 | (uint32_t)rep[8] << 16 | (uint32_t)rep[9] << 24;

    /* re-simulate with the shared C core */
    game_select(0);
    memcpy(game_io_ptr(), rep, (size_t)len);
    if (!game_load_replay(len)) fail(400, "bad replay");
    long guard = 0;
    while (game_replay_advance() != -1)
        if (++guard > 2000000) fail(400, "replay too long");
    const int32_t *v = game_state_ptr();
    if (v[V_STATUS] != ST_OVER) fail(400, "run did not finish");
    int score = v[V_SCORE0], length = v[V_LEN0], shape = v[V_SHAPE];

    int day = 0;
    if (daily[0] == '1') {
        int y, m, d;
        today(&y, &m, &d);
        if (mode != MODE_DAILY || (uint32_t)game_daily_seed(y, m, d) != seed) fail(400, "not today's daily board");
        day = game_daily_number(y, m, d);
    }

    long long uid = user_id(nick, pass);
    Arg ins[7] = { ARG_I(uid), ARG_I(mode), ARG_I(shape), ARG_I(score), ARG_I(length), ARG_B(rep, len), ARG_S(iph) };
    long long sid = exec_insert("INSERT INTO scores (user_id, mode, shape, score, length, replay, ip_hash) "
                                "VALUES (?, ?, ?, ?, ?, ?, ?)", ins, 7);
    if (sid <= 0) fail(500, "could not save score");

    int daily_saved = 0;
    if (day) {
        Arg dr[4] = { ARG_I(day), ARG_I(uid), ARG_I(sid), ARG_I(score) };
        /* INSERT IGNORE keeps only the first attempt of the day */
        daily_saved = exec_insert("INSERT IGNORE INTO daily_runs (day, user_id, score_id, score) VALUES (?, ?, ?, ?)", dr, 4) > 0;
    }
    headers(200);
    printf("{\"ok\":true,\"score\":%d,\"length\":%d,\"daily_saved\":%s}\n", score, length, daily_saved ? "true" : "false");
}

static void act_daily_top(void) {
    char dbuf[16];
    param(query, "day", dbuf, sizeof dbuf);
    long long day = strtoll(dbuf, NULL, 10);
    static char nick[64], rep[MAX_REPLAY];
    Col cols[3] = { { 's', 0, nick, sizeof nick - 1, 0 }, { 'i', 0, NULL, 0, 0 }, { 's', 0, rep, sizeof rep, 0 } };
    Arg a[1] = { ARG_I(day) };
    MYSQL_STMT *st = run("SELECT u.nickname, d.score, s.replay FROM daily_runs d "
                         "JOIN scores s ON s.id = d.score_id JOIN users u ON u.id = d.user_id "
                         "WHERE d.day = ? ORDER BY d.score DESC, d.created_at ASC LIMIT 1", a, 1, cols, 3);
    if (!st) fail(500, "database error");
    headers(200);
    if (mysql_stmt_fetch(st) != 0) {
        printf("{\"ok\":true,\"replay\":null}\n");
    } else {
        static const char tbl[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        printf("{\"ok\":true,\"nickname\":");
        json_str(nick, cols[0].len);
        printf(",\"score\":%lld,\"replay\":\"", cols[1].i);
        const uint8_t *b = (const uint8_t *)rep;
        unsigned long n = cols[2].len;
        for (unsigned long i = 0; i < n; i += 3) {
            uint32_t x = (uint32_t)b[i] << 16 | (i + 1 < n ? (uint32_t)b[i + 1] << 8 : 0) | (i + 2 < n ? b[i + 2] : 0);
            putchar(tbl[(x >> 18) & 63]);
            putchar(tbl[(x >> 12) & 63]);
            if (i + 1 < n) putchar(tbl[(x >> 6) & 63]);
            if (i + 2 < n) putchar(tbl[x & 63]);
        }
        printf("\"}\n");
    }
    mysql_stmt_close(st);
}

static void act_levels(void) {
    static char name[64], nick[64], data[MAX_LEVEL_B64 + 1];
    Col cols[5] = {
        { 'i', 0, NULL, 0, 0 }, { 's', 0, name, sizeof name - 1, 0 }, { 's', 0, nick, sizeof nick - 1, 0 },
        { 's', 0, data, sizeof data - 1, 0 }, { 'i', 0, NULL, 0, 0 },
    };
    MYSQL_STMT *st = run("SELECT l.id, l.name, u.nickname, l.data, "
                         "(SELECT COUNT(*) FROM level_likes k WHERE k.level_id = l.id) AS likes "
                         "FROM levels l JOIN users u ON u.id = l.user_id "
                         "ORDER BY likes DESC, l.created_at DESC LIMIT 50", NULL, 0, cols, 5);
    if (!st) fail(500, "database error");
    headers(200);
    printf("{\"ok\":true,\"levels\":[");
    for (int n = 0; mysql_stmt_fetch(st) == 0; n++) {
        printf("%s{\"id\":%lld,\"name\":", n ? "," : "", cols[0].i);
        json_str(name, cols[1].len);
        printf(",\"nickname\":");
        json_str(nick, cols[2].len);
        printf(",\"data\":");
        json_str(data, cols[3].len);
        printf(",\"likes\":%lld}", cols[4].i);
    }
    printf("]}\n");
    mysql_stmt_close(st);
}

/* Same compact format as web/js/editor.js: 9 header bytes + (count, value) pairs */
static int level_from_share(const char *b64, uint8_t *out, int cap) {
    static uint8_t raw[MAX_LEVEL_B64];
    int n = b64url_decode(b64, raw, sizeof raw);
    if (n < SC_LEVEL_HDR) return 0;
    int w = raw[4], h = raw[5], size = SC_LEVEL_HDR + w * h;
    if (size > cap) return 0;
    memcpy(out, raw, SC_LEVEL_HDR);
    int k = SC_LEVEL_HDR;
    for (int i = SC_LEVEL_HDR; i + 1 < n; i += 2)
        for (int j = 0; j < raw[i] && k < size; j++) out[k++] = raw[i + 1];
    return k == size ? size : 0;
}

static void act_publish_level(void) {
    static char nick[64], pass[128], name[128], data[MAX_LEVEL_B64 + 8];
    static uint8_t lvl[SC_LEVEL_MAX];
    char iph[17];
    param(body, "nickname", nick, sizeof nick);
    param(body, "password", pass, sizeof pass);
    param(body, "name", name, sizeof name);
    param(body, "data", data, sizeof data);
    ip_hash(iph);
    if (strlen(data) > MAX_LEVEL_B64) fail(400, "level too large");
    if (strlen(name) < 1 || strlen(name) > 40) fail(400, "name must be 1-40 characters");

    Arg rl[1] = { ARG_S(iph) };
    if (scalar("SELECT COUNT(*) FROM levels WHERE ip_hash = ? AND created_at > NOW() - INTERVAL 10 MINUTE", rl, 1) >= 3)
        fail(429, "too many levels, wait a few minutes");

    int len = level_from_share(data, lvl, sizeof lvl);
    if (!len || !game_load_level(lvl, len)) fail(400, "level is not valid");

    long long uid = user_id(nick, pass);
    Arg ins[4] = { ARG_I(uid), ARG_S(name), ARG_S(data), ARG_S(iph) };
    long long id = exec_insert("INSERT INTO levels (user_id, name, data, ip_hash) VALUES (?, ?, ?, ?)", ins, 4);
    if (id <= 0) fail(500, "could not save level");
    headers(200);
    printf("{\"ok\":true,\"id\":%lld}\n", id);
}

static void act_like_level(void) {
    char idbuf[24], nick[64], pass[128];
    param(body, "id", idbuf, sizeof idbuf);
    param(body, "nickname", nick, sizeof nick);
    param(body, "password", pass, sizeof pass);
    long long lid = strtoll(idbuf, NULL, 10);
    long long uid = user_id(nick, pass);
    Arg a[2] = { ARG_I(lid), ARG_I(uid) };
    long long r = exec_insert("INSERT IGNORE INTO level_likes (level_id, user_id) VALUES (?, ?)", a, 2);
    headers(200);
    printf("{\"ok\":%s}\n", r > 0 ? "true" : "false");
}

/* ------------------------------------------------------------------------ */

int main(void) {
    const char *method = getenv("REQUEST_METHOD");
    query = getenv("QUERY_STRING");
    if (!query) query = "";
    if (method && strcmp(method, "OPTIONS") == 0) { headers(200); return 0; }

    char action[32];
    param(query, "action", action, sizeof action);
    int is_post = method && strcmp(method, "POST") == 0;
    if (is_post) read_body();

    if (strcmp(action, "ping") == 0) {
        headers(200);
        printf("{\"ok\":true,\"api\":%d}\n", game_api_version());
        return 0;
    }

    db = mysql_init(NULL);
    if (!db || !mysql_real_connect(db, getenv("SNAKE_DB_HOST"), getenv("SNAKE_DB_USER"),
                                   getenv("SNAKE_DB_PASS"), getenv("SNAKE_DB_NAME"), 0, NULL, 0))
        fail(500, "database unavailable");
    mysql_set_character_set(db, "utf8mb4");

    if (is_post && strcmp(action, "submit") == 0) act_submit();
    else if (is_post && strcmp(action, "publish_level") == 0) act_publish_level();
    else if (is_post && strcmp(action, "like_level") == 0) act_like_level();
    else if (strcmp(action, "daily_top") == 0) act_daily_top();
    else if (strcmp(action, "levels") == 0) act_levels();
    else fail(404, "unknown action");

    mysql_close(db);
    return 0;
}
