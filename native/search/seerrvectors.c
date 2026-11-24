#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sqlite3ext.h>
#if defined(__ARM_FEATURE_DOTPROD)
#include <arm_neon.h>
#endif

SQLITE_EXTENSION_INIT1

typedef struct {
    sqlite3_int64 id;
    double score;
    double rank;
} Hit;

typedef struct {
    int length;
    int capacity;
    int count;
    int norm;
    int8_t *query;
    Hit *hits;
} Search;

static void products(const int8_t *a, const int8_t *b, int length,
                     int *dot, int *norm) {
    int i = 0;
    *dot = 0;
    *norm = 0;
#if defined(__ARM_FEATURE_DOTPROD)
    int32x4_t dots = vdupq_n_s32(0);
    int32x4_t norms = vdupq_n_s32(0);
    for (; i + 16 <= length; i += 16) {
        int8x16_t x = vld1q_s8(a + i);
        int8x16_t y = vld1q_s8(b + i);
        dots = vdotq_s32(dots, x, y);
        norms = vdotq_s32(norms, y, y);
    }
    *dot = vaddvq_s32(dots);
    *norm = vaddvq_s32(norms);
#endif
    for (; i < length; i++) {
        *dot += a[i] * b[i];
        *norm += b[i] * b[i];
    }
}

/* The worst retained hit is at the root. Break ties by original row ID. */
static int worse(Hit a, Hit b) {
    return a.rank < b.rank || (a.rank == b.rank && a.id > b.id);
}

static void collect(Search *s, Hit hit) {
    int i;
    if (s->count < s->capacity) {
        i = s->count++;
        while (i > 0 && worse(hit, s->hits[(i - 1) / 2])) {
            s->hits[i] = s->hits[(i - 1) / 2];
            i = (i - 1) / 2;
        }
    } else {
        if (!worse(s->hits[0], hit)) return;
        i = 0;
        while (2 * i + 1 < s->count) {
            int child = 2 * i + 1;
            if (child + 1 < s->count && worse(s->hits[child + 1], s->hits[child]))
                child++;
            if (!worse(s->hits[child], hit)) break;
            s->hits[i] = s->hits[child];
            i = child;
        }
    }
    s->hits[i] = hit;
}

static void top_step(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
    (void)argc;
    Search *s = sqlite3_aggregate_context(ctx, sizeof(*s));
    if (!s) { sqlite3_result_error_nomem(ctx); return; }
    if (!s->query) {
        s->length = sqlite3_value_bytes(argv[0]);
        s->capacity = sqlite3_value_int(argv[1]);
        if (s->length < 1 || s->length > 4096 || s->capacity < 1 || s->capacity > 1024) {
            sqlite3_result_error(ctx, "Invalid search dimensions or limit", -1);
            return;
        }
        const void *query = sqlite3_value_blob(argv[0]);
        if (!query) { sqlite3_result_error_nomem(ctx); return; }
        s->hits = sqlite3_malloc64((sqlite3_uint64)s->capacity * sizeof(Hit));
        s->query = sqlite3_malloc(s->length);
        if (!s->hits || !s->query) {
            sqlite3_free(s->hits);
            sqlite3_free(s->query);
            s->hits = NULL;
            s->query = NULL;
            sqlite3_result_error_nomem(ctx);
            return;
        }
        memcpy(s->query, query, s->length);
        int ignored;
        products(s->query, s->query, s->length, &ignored, &s->norm);
    }
    double score = 0;
    if (s->norm && sqlite3_value_bytes(argv[2]) == s->length) {
        const int8_t *candidate = sqlite3_value_blob(argv[2]);
        if (!candidate) { sqlite3_result_error_nomem(ctx); return; }
        int dot, norm;
        products(s->query, candidate, s->length, &dot, &norm);
        if (norm) score = dot / sqrt((double)s->norm * norm);
    }
    /* Vote bonus supplied by the caller uses the same arithmetic as JS. */
    collect(s, (Hit){sqlite3_value_int64(argv[4]), score,
                     score + sqlite3_value_double(argv[3])});
}

static int compare_hits(const void *a, const void *b) {
    Hit x = *(const Hit *)a, y = *(const Hit *)b;
    return worse(x, y) ? 1 : worse(y, x) ? -1 : 0;
}

static void top_final(sqlite3_context *ctx) {
    Search *s = sqlite3_aggregate_context(ctx, 0);
    int count = s ? s->count : 0;
    int size = count * (int)(sizeof(sqlite3_int64) + sizeof(double));
    char *result = size ? sqlite3_malloc(size) : NULL;
    if (count && result) {
        qsort(s->hits, count, sizeof(Hit), compare_hits);
        char *out = result;
        for (int i = 0; i < count; i++) {
            memcpy(out, &s->hits[i].id, sizeof(sqlite3_int64));
            out += sizeof(sqlite3_int64);
            memcpy(out, &s->hits[i].score, sizeof(double));
            out += sizeof(double);
        }
    }
    if (s) {
        sqlite3_free(s->query);
        sqlite3_free(s->hits);
    }
    if (size && !result) sqlite3_result_error_nomem(ctx);
    else sqlite3_result_blob(ctx, result, size, sqlite3_free);

}

static void vote_bonus(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
    (void)argc;
    double votes = fmax(0, sqlite3_value_double(argv[1]));
    double bonus;
    int bytes = sqlite3_value_bytes(argv[0]);
    if (votes <= 1000 && floor(votes) == votes && bytes == 1001 * sizeof(double)) {
        const char *values = sqlite3_value_blob(argv[0]);
        if (!values) { sqlite3_result_error_nomem(ctx); return; }
        memcpy(&bonus, values + (int)votes * sizeof(double), sizeof(double));
    } else {
        bonus = 0.015 * fmin(1, log1p(votes) / log(1001));
    }
    sqlite3_result_double(ctx, bonus);
}

int sqlite3_seerrvectors_init(sqlite3 *db, char **error,
                            const sqlite3_api_routines *api) {
    (void)error;
    SQLITE_EXTENSION_INIT2(api);
    int rc = sqlite3_create_function_v2(db, "seerr_votes", 2,
        SQLITE_UTF8 | SQLITE_DETERMINISTIC | SQLITE_DIRECTONLY, NULL,
        vote_bonus, NULL, NULL, NULL);
    if (rc != SQLITE_OK) return rc;
    return sqlite3_create_function_v2(db, "seerr_top", 5,
        SQLITE_UTF8 | SQLITE_DIRECTONLY, NULL, NULL,
        top_step, top_final, NULL);
}
