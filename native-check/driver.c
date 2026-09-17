/* WP-242 — the REAL-ENGINE gate for the converter's 5.9.5 target.
 *
 * A headless libqsp host: it loads a compiled `.qsp` and one `.sav` from
 * memory, prints whether the engine ACCEPTED the save, and then prints a fixed
 * list of variables read back OUT OF THE ENGINE. A converter can only claim a
 * save "loads" if the engine that will open it says so, and it can only claim
 * the save is FAITHFUL if the values the engine hands back are the ones the
 * classic file held.
 *
 * Build: ./build.sh (see it for the libqsp source/build paths). The binary is
 * never committed.
 *
 * Usage: qsp595-check <game.qsp> <save.sav> [VARSPEC ...]
 *   VARSPEC is `name` | `name[key]` — a plain name reads slot 0.
 *   With no VARSPEC the default list is used (see DEFAULT_SPECS).
 *
 * Output is one `key=value` line per fact, so a test script can diff it:
 *   open=ok | open=refused
 *   error=<num> <desc>            (only when the engine set one)
 *   loc=<$CURLOC>
 *   pre:<spec>=<type>|<value>     read BEFORE the game's own ONGLOAD runs
 *   var:<spec>=<type>|<value>     read after it; type is the engine's OWN code
 *
 * The `pre:` pass exists because `qspOpenGameStatus` ends by executing the
 * game's ONGLOAD (5.9.5 game.c:656), and Girl Life's ONGLOAD calls
 * `saveupdater`, which rewrites some variables on purpose. Measuring the
 * LAYOUT means reading the restored state before the game gets to touch it,
 * and the INITGAME callback (game.c:653) is the last moment that is true.
 *
 * The VERSION callback is registered on purpose: a host that leaves it out can
 * silently stall an engine that asks for $QSPVER (notes/… WP-129), and Girl
 * Life's third statement is a $QSPVER guard.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#ifndef _UNICODE
#define _UNICODE
#endif
#include "qsp_default.h"

/* ---------- tiny string helpers (QSP_CHAR is wchar_t here) ---------- */

static void put_utf8(unsigned int cp)
{
    if (cp < 0x80) putchar((int)cp);
    else if (cp < 0x800) { putchar(0xC0 | (cp >> 6)); putchar(0x80 | (cp & 0x3F)); }
    else if (cp < 0x10000) { putchar(0xE0 | (cp >> 12)); putchar(0x80 | ((cp >> 6) & 0x3F)); putchar(0x80 | (cp & 0x3F)); }
    else { putchar(0xF0 | (cp >> 18)); putchar(0x80 | ((cp >> 12) & 0x3F)); putchar(0x80 | ((cp >> 6) & 0x3F)); putchar(0x80 | (cp & 0x3F)); }
}

static void print_qsp(QSPString s)
{
    QSP_CHAR *p;
    for (p = s.Str; p && p < s.End; ++p)
    {
        if (*p == '\n' || *p == '\r') { putchar(' '); continue; }
        put_utf8((unsigned int)*p);
    }
}

/* ASCII -> QSP_CHAR; every name we look up is ASCII. */
static QSPString from_ascii(const char *text, QSP_CHAR *buf, int cap)
{
    int i = 0;
    while (text[i] && i < cap - 1) { buf[i] = (QSP_CHAR)(unsigned char)text[i]; ++i; }
    buf[i] = 0;
    return QSPStringFromLen(buf, i);
}

/* Same, UPPERCASED. qspVarReference compares a name verbatim (variables.c:376-393
 * -> qspGetVar); the engine only ever hands it names its own parser already
 * uppercased, so a host that asks for `money` finds nothing at all. */
static QSPString from_ascii_upper(const char *text, QSP_CHAR *buf, int cap)
{
    int i = 0;
    while (text[i] && i < cap - 1)
    {
        char c = text[i];
        if (c >= 'a' && c <= 'z') c = (char)(c - 'a' + 'A');
        buf[i] = (QSP_CHAR)(unsigned char)c;
        ++i;
    }
    buf[i] = 0;
    return QSPStringFromLen(buf, i);
}

static void *read_file(const char *path, int *size)
{
    FILE *f = fopen(path, "rb");
    void *data;
    long len;
    if (!f) return 0;
    fseek(f, 0, SEEK_END);
    len = ftell(f);
    fseek(f, 0, SEEK_SET);
    data = malloc((size_t)len);
    if (!data) { fclose(f); return 0; }
    if (fread(data, 1, (size_t)len, f) != (size_t)len) { free(data); fclose(f); return 0; }
    fclose(f);
    *size = (int)len;
    return data;
}

/* ---------- callbacks: every one is a no-op but VERSION ---------- */

static void cb_void(void) {}
static int cb_zero(void) { return 0; }

/* The spec list, shared with the pre-ONGLOAD pass. */
static char **g_specs = 0;
static int g_specsCount = 0;
static void print_var_prefixed(const char *prefix, const char *spec);

static void cb_initgame(QSP_BOOL isNewGame)
{
    int i;
    (void)isNewGame;
    for (i = 0; i < g_specsCount; ++i) print_var_prefixed("pre", g_specs[i]);
}

static void cb_version(QSPString param, QSP_CHAR *buffer, int maxLen)
{
    /* Answer only the engine-version question; an unknown parameter gets the
     * empty string, which makes the engine fall back to its own answer. */
    (void)param;
    (void)maxLen;
    buffer[0] = 0;
}

static char *DEFAULT_SPECS[] = {
    "money",
    "$pcs_nickname",
    "hour",
    "day",
    "$accessible_property[parents_home-name]",
    "npc_fidelity[c0]",
    "$start_type[loc]",
    0
};

static void print_var_prefixed(const char *prefix, const char *spec)
{
    char name[256], key[256];
    const char *open = strchr(spec, '[');
    QSP_CHAR nbuf[256], kbuf[256], sbuf[1024];
    QSPString qname, qkey;
    QSPVariant val;
    int ind = 0;

    key[0] = 0;
    if (open)
    {
        size_t nlen = (size_t)(open - spec);
        const char *close = strrchr(spec, ']');
        size_t klen = close && close > open + 1 ? (size_t)(close - open - 1) : 0;
        if (nlen >= sizeof(name)) nlen = sizeof(name) - 1;
        memcpy(name, spec, nlen); name[nlen] = 0;
        if (klen >= sizeof(key)) klen = sizeof(key) - 1;
        memcpy(key, open + 1, klen); key[klen] = 0;
    }
    else
    {
        strncpy(name, spec, sizeof(name) - 1);
        name[sizeof(name) - 1] = 0;
    }

    qname = from_ascii_upper(name, nbuf, 256);
    printf("%s:%s=", prefix, spec);
    if (key[0])
    {
        qkey = from_ascii(key, kbuf, 256);
        if (!QSPGetVarIndexByString(qname, qkey, &ind))
        {
            printf("MISSING-KEY\n");
            return;
        }
    }
    if (!QSPGetVarValue(qname, ind, &val))
    {
        printf("MISSING\n");
        return;
    }
    printf("%d|", (int)val.Type);
    QSPConvertValueToString(val, sbuf, 1024);
    print_qsp(QSPStringFromC(sbuf));
    printf("\n");
}

static void print_var(const char *spec) { print_var_prefixed("var", spec); }

int main(int argc, char **argv)
{
    void *game, *save;
    int gameSize = 0, saveSize = 0, i;
    QSP_CHAR ebuf[64], obuf[256];
    QSPErrorInfo err;
    QSP_BOOL opened;

    if (argc < 3)
    {
        fprintf(stderr, "usage: %s <game.qsp> <save.sav> [name|name[key] ...]\n", argv[0]);
        return 2;
    }
    game = read_file(argv[1], &gameSize);
    if (!game) { printf("open=refused\nerror=-1 cannot read %s\n", argv[1]); return 1; }
    save = read_file(argv[2], &saveSize);
    if (!save) { printf("open=refused\nerror=-1 cannot read %s\n", argv[2]); return 1; }

    QSPInit();
    for (i = 0; i < QSP_CALL_DUMMY; ++i) QSPSetCallback(i, (QSP_CALLBACK)cb_void);
    QSPSetCallback(QSP_CALL_ISPLAYINGFILE, (QSP_CALLBACK)cb_zero);
    QSPSetCallback(QSP_CALL_SHOWMENU, (QSP_CALLBACK)cb_zero);
    QSPSetCallback(QSP_CALL_GETMSCOUNT, (QSP_CALLBACK)cb_zero);
    QSPSetCallback(QSP_CALL_VERSION, (QSP_CALLBACK)cb_version);
    QSPSetCallback(QSP_CALL_INITGAME, (QSP_CALLBACK)cb_initgame);

    if (argc > 3) { g_specs = argv + 3; g_specsCount = argc - 3; }
    else
    {
        for (g_specsCount = 0; DEFAULT_SPECS[g_specsCount]; ++g_specsCount) {}
        g_specs = (char **)DEFAULT_SPECS;
    }

    printf("engine=");
    print_qsp(QSPGetVersion());
    printf("\n");

    if (!QSPLoadGameWorldFromData(game, gameSize, QSP_TRUE))
    {
        err = QSPGetLastErrorData();
        printf("open=refused\nerror=%d ", err.ErrorNum);
        print_qsp(QSPGetErrorDesc(err.ErrorNum));
        printf(" (game world)\n");
        return 1;
    }

    opened = QSPOpenSavedGameFromData(save, saveSize, QSP_FALSE);
    err = QSPGetLastErrorData();
    if (!opened && err.ErrorNum == QSP_ERR_CANTLOADFILE)
    {
        /* The engine's own acceptance gate said no — this is the refusal the
         * 5.9.0-vs-5.9.5 premise of WP-242 rests on. */
        printf("open=refused\nerror=%d ", err.ErrorNum);
        print_qsp(QSPGetErrorDesc(err.ErrorNum));
        printf("\n");
        return 1;
    }
    printf("open=ok\n");
    if (err.ErrorNum)
    {
        /* The file WAS accepted; the game's own ONGLOAD code then raised
         * something. Reported, not fatal: it is a fact about the game, not
         * about the layout. */
        printf("ongload-error=%d ", err.ErrorNum);
        print_qsp(QSPGetErrorDesc(err.ErrorNum));
        printf(" @ ");
        print_qsp(err.LocName);
        printf("\n");
    }

    if (QSPCalculateStrExpression(from_ascii("$CURLOC", ebuf, 64), obuf, 256, QSP_FALSE))
    {
        printf("loc=");
        print_qsp(QSPStringFromC(obuf));
        printf("\n");
    }
    else
    {
        printf("loc=?\n");
    }

    if (argc > 3)
        for (i = 3; i < argc; ++i) print_var(argv[i]);
    else
        for (i = 0; DEFAULT_SPECS[i]; ++i) print_var(DEFAULT_SPECS[i]);

    QSPTerminate();
    free(game);
    free(save);
    return 0;
}
