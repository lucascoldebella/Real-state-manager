#define _XOPEN_SOURCE 700

#include <ctype.h>
#include <errno.h>
#include <limits.h>
#include <microhttpd.h>
#include <openssl/sha.h>
#include <pthread.h>
#include <sqlite3.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#include <stdarg.h>

#include <cjson/cJSON.h>

#define DEFAULT_PORT 8090
#define TOKEN_TTL_HOURS 24
#define MAX_BODY_BYTES (12 * 1024 * 1024)
#define TOKEN_LEN 64
#define ROLE_LEN 32
#define DATE_LEN 16
#define MONTH_LEN 16
#define USER_NAME_LEN 128
#define EMAIL_LEN 192
#define CLIENT_IP_LEN 64
#define PRE_REGISTER_RATE_LIMIT 10
#define PRE_REGISTER_RATE_WINDOW_SEC 600
#define RATE_LIMIT_SLOTS 256

#define RATE_LIMIT_GLOBAL_RPM 60
#define RATE_LIMIT_AUTH_RPM 5
#define RATE_BUCKET_COUNT 1024
#define MAX_PATH_LEN 2048

typedef struct {
    char *data;
    size_t size;
} ConnectionInfo;

typedef struct {
    sqlite3 *db;
    pthread_mutex_t db_lock;
    char db_path[512];
    char generated_dir[512];
} AppState;

typedef struct {
    int id;
    char full_name[USER_NAME_LEN];
    char email[EMAIL_LEN];
    char role[ROLE_LEN];
    int is_root;
    int is_active;
    int can_dashboard;
    int can_properties;
    int can_tenants;
    int can_finance;
    int can_documents;
    int can_settings;
} AuthUser;

typedef struct {
    char ip[CLIENT_IP_LEN];
    time_t window_start;
    int count;
} RateLimitEntry;

typedef struct {
    char ip[CLIENT_IP_LEN];
    double tokens;
    time_t last_refill;
} RateBucket;

static AppState g_app;
static RateLimitEntry g_pre_register_limits[RATE_LIMIT_SLOTS];
static RateBucket g_global_buckets[RATE_BUCKET_COUNT];
static RateBucket g_auth_buckets[RATE_BUCKET_COUNT];
static char g_cors_origin[256] = "http://localhost:5173";
static int g_trust_proxy = 0;

static void add_cors_headers(struct MHD_Response *response) {
    MHD_add_response_header(response, "Access-Control-Allow-Origin", g_cors_origin);
    MHD_add_response_header(response, "Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    MHD_add_response_header(response, "Access-Control-Allow-Headers", "Authorization, Content-Type");
    MHD_add_response_header(response, "Access-Control-Max-Age", "86400");
    MHD_add_response_header(response, "X-Content-Type-Options", "nosniff");
    MHD_add_response_header(response, "X-Frame-Options", "DENY");
    MHD_add_response_header(response, "Cache-Control", "no-store");
    MHD_add_response_header(response, "Content-Security-Policy", "default-src 'none'");
}

static int send_response(struct MHD_Connection *connection, int status, const char *content_type, const char *data,
                         size_t data_len) {
    struct MHD_Response *response = MHD_create_response_from_buffer(data_len, (void *) data, MHD_RESPMEM_MUST_COPY);
    if (!response) {
        return MHD_NO;
    }
    MHD_add_response_header(response, "Content-Type", content_type);
    add_cors_headers(response);
    int ret = MHD_queue_response(connection, status, response);
    MHD_destroy_response(response);
    return ret;
}

static int send_json(struct MHD_Connection *connection, int status, cJSON *json) {
    char *body = cJSON_PrintUnformatted(json);
    if (!body) {
        return send_response(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "application/json",
                             "{\"error\":\"serialization_failed\"}", 32);
    }
    int ret = send_response(connection, status, "application/json", body, strlen(body));
    free(body);
    return ret;
}

static int send_error(struct MHD_Connection *connection, int status, const char *message) {
    cJSON *json = cJSON_CreateObject();
    cJSON_AddStringToObject(json, "error", message);
    int ret = send_json(connection, status, json);
    cJSON_Delete(json);
    return ret;
}

static int starts_with(const char *s, const char *prefix) {
    return strncmp(s, prefix, strlen(prefix)) == 0;
}

static int parse_id_path(const char *url, const char *prefix, int *out_id) {
    size_t n = strlen(prefix);
    if (strncmp(url, prefix, n) != 0) {
        return 0;
    }
    const char *p = url + n;
    if (*p == '\0') {
        return 0;
    }
    char *end = NULL;
    long value = strtol(p, &end, 10);
    if (*end != '\0' || value <= 0 || value > INT_MAX) {
        return 0;
    }
    *out_id = (int) value;
    return 1;
}

static void now_iso_datetime(char out[20]) {
    time_t now = time(NULL);
    struct tm tm_now;
    localtime_r(&now, &tm_now);
    strftime(out, 20, "%Y-%m-%d %H:%M:%S", &tm_now);
}

static void current_month(char out[MONTH_LEN]) {
    time_t now = time(NULL);
    struct tm tm_now;
    localtime_r(&now, &tm_now);
    strftime(out, MONTH_LEN, "%Y-%m", &tm_now);
}

static void previous_month(const char *month, char out[MONTH_LEN]) {
    int year = 0;
    int mon = 0;
    if (sscanf(month, "%4d-%2d", &year, &mon) != 2) {
        current_month(out);
        return;
    }
    if (year < 1970 || year > 9999 || mon < 1 || mon > 12) {
        current_month(out);
        return;
    }
    mon -= 1;
    if (mon == 0) {
        year -= 1;
        mon = 12;
    }
    snprintf(out, MONTH_LEN, "%04d-%02d", year, mon);
}

static int days_until_date(const char *date_str) {
    struct tm tm_due = {0};
    if (!strptime(date_str, "%Y-%m-%d", &tm_due)) {
        return 9999;
    }
    time_t due = mktime(&tm_due);
    time_t now = time(NULL);

    struct tm tm_now;
    localtime_r(&now, &tm_now);
    tm_now.tm_hour = 0;
    tm_now.tm_min = 0;
    tm_now.tm_sec = 0;
    time_t today = mktime(&tm_now);

    double diff = difftime(due, today);
    return (int) (diff / 86400.0);
}

static void sha256_hex(const char *input, char output[65]) {
    unsigned char hash[SHA256_DIGEST_LENGTH];
    SHA256((const unsigned char *) input, strlen(input), hash);
    for (int i = 0; i < SHA256_DIGEST_LENGTH; ++i) {
        snprintf(output + (i * 2), 3, "%02x", hash[i]);
    }
    output[64] = '\0';
}

static void hash_password(const char *password, char output[65]) {
    const char *salt = "oliveira-costa-v1";
    size_t n = strlen(password) + strlen(salt) + 2;
    char *buf = calloc(n, 1);
    snprintf(buf, n, "%s|%s", password, salt);
    sha256_hex(buf, output);
    free(buf);
}

static int secure_random_bytes(unsigned char *buf, size_t len) {
    FILE *fp = fopen("/dev/urandom", "rb");
    if (!fp) {
        return 0;
    }
    size_t got = fread(buf, 1, len, fp);
    fclose(fp);
    return got == len;
}

static void generate_token(char token[TOKEN_LEN + 1]) {
    unsigned char bytes[TOKEN_LEN / 2];
    if (!secure_random_bytes(bytes, sizeof(bytes))) {
        fprintf(stderr, "FATAL: /dev/urandom unavailable — cannot generate secure tokens\n");
        abort();
    }
    for (size_t i = 0; i < sizeof(bytes); i++) {
        snprintf(token + (i * 2), 3, "%02x", bytes[i]);
    }
    token[TOKEN_LEN] = '\0';
}

static void auth_user_clear(AuthUser *user) {
    if (!user) {
        return;
    }
    memset(user, 0, sizeof(AuthUser));
}

static void add_auth_user_json(cJSON *parent, const AuthUser *user) {
    cJSON *u = cJSON_AddObjectToObject(parent, "user");
    cJSON_AddNumberToObject(u, "id", user->id);
    cJSON_AddStringToObject(u, "full_name", user->full_name);
    cJSON_AddStringToObject(u, "email", user->email);
    cJSON_AddStringToObject(u, "role", user->role);
    cJSON_AddBoolToObject(u, "is_root", user->is_root == 1);
    cJSON_AddBoolToObject(u, "is_active", user->is_active == 1);

    cJSON *permissions = cJSON_AddObjectToObject(u, "permissions");
    cJSON_AddBoolToObject(permissions, "dashboard", user->can_dashboard == 1);
    cJSON_AddBoolToObject(permissions, "properties", user->can_properties == 1);
    cJSON_AddBoolToObject(permissions, "tenants", user->can_tenants == 1);
    cJSON_AddBoolToObject(permissions, "finance", user->can_finance == 1);
    cJSON_AddBoolToObject(permissions, "documents", user->can_documents == 1);
    cJSON_AddBoolToObject(permissions, "settings", user->can_settings == 1);
}

static void get_client_ip(struct MHD_Connection *connection, char out[CLIENT_IP_LEN]) {
    snprintf(out, CLIENT_IP_LEN, "unknown");
    const union MHD_ConnectionInfo *info =
        MHD_get_connection_info(connection, MHD_CONNECTION_INFO_CLIENT_ADDRESS);
    if (!info || !info->client_addr) {
        return;
    }

    const struct sockaddr *addr = info->client_addr;
    if (addr->sa_family == AF_INET) {
        const struct sockaddr_in *in = (const struct sockaddr_in *) addr;
        if (inet_ntop(AF_INET, &in->sin_addr, out, CLIENT_IP_LEN) == NULL) {
            snprintf(out, CLIENT_IP_LEN, "unknown");
        }
    } else if (addr->sa_family == AF_INET6) {
        const struct sockaddr_in6 *in6 = (const struct sockaddr_in6 *) addr;
        if (inet_ntop(AF_INET6, &in6->sin6_addr, out, CLIENT_IP_LEN) == NULL) {
            snprintf(out, CLIENT_IP_LEN, "unknown");
        }
    }

    if (g_trust_proxy) {
        const char *real_ip = MHD_lookup_connection_value(connection, MHD_HEADER_KIND, "X-Real-IP");
        if (real_ip && real_ip[0] != '\0' && strlen(real_ip) < CLIENT_IP_LEN) {
            snprintf(out, CLIENT_IP_LEN, "%s", real_ip);
        }
    }
}

static int pre_register_rate_allow(struct MHD_Connection *connection, char out_ip[CLIENT_IP_LEN]) {
    get_client_ip(connection, out_ip);
    time_t now = time(NULL);

    int free_idx = -1;
    int oldest_idx = 0;
    for (int i = 0; i < RATE_LIMIT_SLOTS; i++) {
        if (g_pre_register_limits[i].ip[0] == '\0') {
            if (free_idx == -1) {
                free_idx = i;
            }
            continue;
        }
        if (g_pre_register_limits[i].window_start < g_pre_register_limits[oldest_idx].window_start) {
            oldest_idx = i;
        }
        if (strcmp(g_pre_register_limits[i].ip, out_ip) == 0) {
            if (now - g_pre_register_limits[i].window_start > PRE_REGISTER_RATE_WINDOW_SEC) {
                g_pre_register_limits[i].window_start = now;
                g_pre_register_limits[i].count = 0;
            }
            if (g_pre_register_limits[i].count >= PRE_REGISTER_RATE_LIMIT) {
                return 0;
            }
            g_pre_register_limits[i].count += 1;
            return 1;
        }
    }

    int idx = free_idx >= 0 ? free_idx : oldest_idx;
    snprintf(g_pre_register_limits[idx].ip, CLIENT_IP_LEN, "%s", out_ip);
    g_pre_register_limits[idx].window_start = now;
    g_pre_register_limits[idx].count = 1;
    return 1;
}

static int rate_limit_check(RateBucket *buckets, const char *ip, int rpm) {
    time_t now = time(NULL);
    double refill_rate = (double)rpm / 60.0;
    unsigned int hash = 5381;
    for (const char *p = ip; *p; p++) {
        hash = ((hash << 5) + hash) + (unsigned char)*p;
    }
    int start = (int)(hash % RATE_BUCKET_COUNT);

    for (int i = 0; i < RATE_BUCKET_COUNT; i++) {
        int idx = (start + i) % RATE_BUCKET_COUNT;
        if (buckets[idx].ip[0] == '\0') {
            snprintf(buckets[idx].ip, CLIENT_IP_LEN, "%s", ip);
            buckets[idx].tokens = (double)rpm - 1.0;
            buckets[idx].last_refill = now;
            return 1;
        }
        if (strcmp(buckets[idx].ip, ip) == 0) {
            double elapsed = difftime(now, buckets[idx].last_refill);
            buckets[idx].tokens += elapsed * refill_rate;
            if (buckets[idx].tokens > (double)rpm) {
                buckets[idx].tokens = (double)rpm;
            }
            buckets[idx].last_refill = now;
            if (buckets[idx].tokens < 1.0) {
                return 0;
            }
            buckets[idx].tokens -= 1.0;
            return 1;
        }
    }
    return 1;
}

static int is_valid_path(const char *path) {
    if (!path) return 0;
    size_t len = strlen(path);
    if (len == 0 || len > MAX_PATH_LEN) return 0;
    if (strstr(path, "..") != NULL) return 0;
    for (size_t i = 0; i < len; i++) {
        unsigned char c = (unsigned char)path[i];
        if (c < 0x20 || c == 0x7F) return 0;
    }
    return 1;
}

static char *dup_string(const char *src) {
    size_t len = strlen(src) + 1;
    char *dst = malloc(len);
    if (!dst) {
        return NULL;
    }
    memcpy(dst, src, len);
    return dst;
}

static int db_exec(const char *sql) {
    char *err = NULL;
    int rc = sqlite3_exec(g_app.db, sql, NULL, NULL, &err);
    if (rc != SQLITE_OK) {
        fprintf(stderr, "[DB] exec failed: %s\nSQL: %s\n", err ? err : "unknown", sql);
        sqlite3_free(err);
        return 0;
    }
    return 1;
}

static int db_exec_fmt(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    char *sql = sqlite3_vmprintf(fmt, ap);
    va_end(ap);
    if (!sql) {
        return 0;
    }
    int ok = db_exec(sql);
    sqlite3_free(sql);
    return ok;
}

static int ensure_directories(void) {
    struct stat st = {0};
    if (stat("data", &st) != 0) {
        if (mkdir("data", 0755) != 0 && errno != EEXIST) {
            perror("mkdir data");
            return 0;
        }
    }
    if (stat(g_app.generated_dir, &st) != 0) {
        if (mkdir(g_app.generated_dir, 0755) != 0 && errno != EEXIST) {
            perror("mkdir generated");
            return 0;
        }
    }
    return 1;
}

static int init_schema(void) {
    const char *sql =
        "PRAGMA foreign_keys = ON;"
        "CREATE TABLE IF NOT EXISTS users ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "full_name TEXT NOT NULL DEFAULT '',"
        "email TEXT UNIQUE NOT NULL,"
        "password_hash TEXT NOT NULL,"
        "role TEXT NOT NULL DEFAULT 'admin',"
        "is_root INTEGER NOT NULL DEFAULT 0,"
        "is_active INTEGER NOT NULL DEFAULT 1,"
        "can_dashboard INTEGER NOT NULL DEFAULT 1,"
        "can_properties INTEGER NOT NULL DEFAULT 1,"
        "can_tenants INTEGER NOT NULL DEFAULT 1,"
        "can_finance INTEGER NOT NULL DEFAULT 1,"
        "can_documents INTEGER NOT NULL DEFAULT 1,"
        "can_settings INTEGER NOT NULL DEFAULT 0,"
        "created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP"
        ");"
        "CREATE TABLE IF NOT EXISTS sessions ("
        "token TEXT PRIMARY KEY,"
        "user_id INTEGER NOT NULL,"
        "expires_at TEXT NOT NULL,"
        "created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,"
        "FOREIGN KEY(user_id) REFERENCES users(id)"
        ");"
        "CREATE TABLE IF NOT EXISTS properties ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "name TEXT NOT NULL,"
        "address TEXT,"
        "total_units INTEGER NOT NULL DEFAULT 0"
        ");"
        "CREATE TABLE IF NOT EXISTS units ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "property_id INTEGER NOT NULL,"
        "unit_number TEXT NOT NULL,"
        "status TEXT NOT NULL DEFAULT 'vacant',"
        "is_active INTEGER NOT NULL DEFAULT 1,"
        "inactive_reason TEXT NOT NULL DEFAULT '',"
        "available_from TEXT,"
        "base_rent REAL NOT NULL DEFAULT 0,"
        "current_tenant_id INTEGER,"
        "UNIQUE(property_id, unit_number),"
        "FOREIGN KEY(property_id) REFERENCES properties(id),"
        "FOREIGN KEY(current_tenant_id) REFERENCES tenants(id)"
        ");"
        "CREATE TABLE IF NOT EXISTS tenants ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "full_name TEXT NOT NULL,"
        "cpf TEXT NOT NULL UNIQUE,"
        "rg TEXT,"
        "civil_state TEXT,"
        "occupation TEXT,"
        "reference_address TEXT,"
        "phone TEXT,"
        "email TEXT,"
        "unit_id INTEGER,"
        "rent_amount REAL NOT NULL,"
        "due_day INTEGER NOT NULL,"
        "contract_start TEXT,"
        "contract_end TEXT,"
        "notes TEXT,"
        "profile_photo TEXT NOT NULL DEFAULT '',"
        "document_front_image TEXT NOT NULL DEFAULT '',"
        "document_back_image TEXT NOT NULL DEFAULT '',"
        "active INTEGER NOT NULL DEFAULT 1,"
        "created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,"
        "FOREIGN KEY(unit_id) REFERENCES units(id)"
        ");"
        "CREATE TABLE IF NOT EXISTS pre_registrations ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "full_name TEXT NOT NULL,"
        "cpf TEXT NOT NULL,"
        "rg TEXT NOT NULL,"
        "civil_state TEXT NOT NULL,"
        "occupation TEXT NOT NULL,"
        "reference_address TEXT NOT NULL,"
        "phone TEXT NOT NULL,"
        "email TEXT NOT NULL,"
        "due_day INTEGER NOT NULL,"
        "contract_months INTEGER NOT NULL,"
        "doc_front_image TEXT NOT NULL DEFAULT '',"
        "doc_back_image TEXT NOT NULL DEFAULT '',"
        "created_ip TEXT NOT NULL DEFAULT '',"
        "status TEXT NOT NULL DEFAULT 'pending',"
        "created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP"
        ");"
        "CREATE TABLE IF NOT EXISTS rent_charges ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "tenant_id INTEGER NOT NULL,"
        "unit_id INTEGER NOT NULL,"
        "month TEXT NOT NULL,"
        "amount REAL NOT NULL,"
        "due_date TEXT NOT NULL,"
        "status TEXT NOT NULL DEFAULT 'unpaid',"
        "paid_at TEXT,"
        "late_fee REAL NOT NULL DEFAULT 0,"
        "payment_method TEXT,"
        "notes TEXT,"
        "UNIQUE(tenant_id, month),"
        "FOREIGN KEY(tenant_id) REFERENCES tenants(id),"
        "FOREIGN KEY(unit_id) REFERENCES units(id)"
        ");"
        "CREATE TABLE IF NOT EXISTS maintenance_tickets ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "unit_id INTEGER NOT NULL,"
        "description TEXT NOT NULL,"
        "ticket_date TEXT NOT NULL,"
        "cost REAL NOT NULL DEFAULT 0,"
        "status TEXT NOT NULL DEFAULT 'open',"
        "image_path TEXT,"
        "created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,"
        "FOREIGN KEY(unit_id) REFERENCES units(id)"
        ");"
        "CREATE TABLE IF NOT EXISTS expenses ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "category TEXT NOT NULL,"
        "description TEXT NOT NULL,"
        "amount REAL NOT NULL,"
        "expense_date TEXT NOT NULL,"
        "unit_id INTEGER,"
        "created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,"
        "FOREIGN KEY(unit_id) REFERENCES units(id)"
        ");"
        "CREATE TABLE IF NOT EXISTS document_templates ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "name TEXT NOT NULL,"
        "document_type TEXT NOT NULL,"
        "template_body TEXT NOT NULL,"
        "created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP"
        ");"
        "CREATE TABLE IF NOT EXISTS documents ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "template_id INTEGER NOT NULL,"
        "tenant_id INTEGER NOT NULL,"
        "document_type TEXT NOT NULL,"
        "file_path TEXT NOT NULL,"
        "generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,"
        "FOREIGN KEY(template_id) REFERENCES document_templates(id),"
        "FOREIGN KEY(tenant_id) REFERENCES tenants(id)"
        ");"
        "CREATE TABLE IF NOT EXISTS notifications ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "type TEXT NOT NULL,"
        "title TEXT NOT NULL,"
        "message TEXT NOT NULL,"
        "related_id INTEGER,"
        "read_status INTEGER NOT NULL DEFAULT 0,"
        "created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP"
        ");"
        "CREATE INDEX IF NOT EXISTS idx_rent_month ON rent_charges(month);"
        "CREATE INDEX IF NOT EXISTS idx_rent_status ON rent_charges(status);"
        "CREATE INDEX IF NOT EXISTS idx_tenant_unit ON tenants(unit_id);"
        "CREATE INDEX IF NOT EXISTS idx_expense_date ON expenses(expense_date);";

    return db_exec(sql);
}

static int table_count(const char *table) {
    sqlite3_stmt *stmt = NULL;
    int count = 0;
    char *sql = sqlite3_mprintf("SELECT COUNT(*) FROM %q", table);
    if (!sql) {
        return 0;
    }
    if (sqlite3_prepare_v2(g_app.db, sql, -1, &stmt, NULL) == SQLITE_OK) {
        if (sqlite3_step(stmt) == SQLITE_ROW) {
            count = sqlite3_column_int(stmt, 0);
        }
    }
    sqlite3_finalize(stmt);
    sqlite3_free(sql);
    return count;
}

static int count_query_int(const char *sql) {
    sqlite3_stmt *stmt = NULL;
    int count = 0;
    if (sqlite3_prepare_v2(g_app.db, sql, -1, &stmt, NULL) == SQLITE_OK) {
        if (sqlite3_step(stmt) == SQLITE_ROW) {
            count = sqlite3_column_int(stmt, 0);
        }
    }
    sqlite3_finalize(stmt);
    return count;
}

static int table_has_column(const char *table, const char *column) {
    sqlite3_stmt *stmt = NULL;
    char *sql = sqlite3_mprintf("PRAGMA table_info(%q)", table);
    if (!sql) {
        return 0;
    }
    if (sqlite3_prepare_v2(g_app.db, sql, -1, &stmt, NULL) != SQLITE_OK) {
        sqlite3_free(sql);
        return 0;
    }
    sqlite3_free(sql);

    int found = 0;
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        const unsigned char *name = sqlite3_column_text(stmt, 1);
        if (name && strcmp((const char *) name, column) == 0) {
            found = 1;
            break;
        }
    }

    sqlite3_finalize(stmt);
    return found;
}

static int run_schema_migrations(void) {
    if (!table_has_column("users", "full_name")) {
        if (!db_exec("ALTER TABLE users ADD COLUMN full_name TEXT NOT NULL DEFAULT ''")) {
            return 0;
        }
    }
    if (!table_has_column("users", "is_root")) {
        if (!db_exec("ALTER TABLE users ADD COLUMN is_root INTEGER NOT NULL DEFAULT 0")) {
            return 0;
        }
    }
    if (!table_has_column("users", "is_active")) {
        if (!db_exec("ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1")) {
            return 0;
        }
    }
    if (!table_has_column("users", "can_dashboard")) {
        if (!db_exec("ALTER TABLE users ADD COLUMN can_dashboard INTEGER NOT NULL DEFAULT 1")) {
            return 0;
        }
    }
    if (!table_has_column("users", "can_properties")) {
        if (!db_exec("ALTER TABLE users ADD COLUMN can_properties INTEGER NOT NULL DEFAULT 1")) {
            return 0;
        }
    }
    if (!table_has_column("users", "can_tenants")) {
        if (!db_exec("ALTER TABLE users ADD COLUMN can_tenants INTEGER NOT NULL DEFAULT 1")) {
            return 0;
        }
    }
    if (!table_has_column("users", "can_finance")) {
        if (!db_exec("ALTER TABLE users ADD COLUMN can_finance INTEGER NOT NULL DEFAULT 1")) {
            return 0;
        }
    }
    if (!table_has_column("users", "can_documents")) {
        if (!db_exec("ALTER TABLE users ADD COLUMN can_documents INTEGER NOT NULL DEFAULT 1")) {
            return 0;
        }
    }
    if (!table_has_column("users", "can_settings")) {
        if (!db_exec("ALTER TABLE users ADD COLUMN can_settings INTEGER NOT NULL DEFAULT 0")) {
            return 0;
        }
    }

    if (!table_has_column("units", "is_active")) {
        if (!db_exec("ALTER TABLE units ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1")) {
            return 0;
        }
    }
    if (!table_has_column("units", "inactive_reason")) {
        if (!db_exec("ALTER TABLE units ADD COLUMN inactive_reason TEXT NOT NULL DEFAULT ''")) {
            return 0;
        }
    }
    if (!table_has_column("units", "available_from")) {
        if (!db_exec("ALTER TABLE units ADD COLUMN available_from TEXT")) {
            return 0;
        }
    }

    if (!table_has_column("tenants", "profile_photo")) {
        if (!db_exec("ALTER TABLE tenants ADD COLUMN profile_photo TEXT NOT NULL DEFAULT ''")) {
            return 0;
        }
    }
    if (!table_has_column("tenants", "document_front_image")) {
        if (!db_exec("ALTER TABLE tenants ADD COLUMN document_front_image TEXT NOT NULL DEFAULT ''")) {
            return 0;
        }
    }
    if (!table_has_column("tenants", "document_back_image")) {
        if (!db_exec("ALTER TABLE tenants ADD COLUMN document_back_image TEXT NOT NULL DEFAULT ''")) {
            return 0;
        }
    }

    if (!db_exec(
            "CREATE TABLE IF NOT EXISTS pre_registrations ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT,"
            "full_name TEXT NOT NULL,"
            "cpf TEXT NOT NULL,"
            "rg TEXT NOT NULL,"
            "civil_state TEXT NOT NULL,"
            "occupation TEXT NOT NULL,"
            "reference_address TEXT NOT NULL,"
            "phone TEXT NOT NULL,"
            "email TEXT NOT NULL,"
            "due_day INTEGER NOT NULL,"
            "contract_months INTEGER NOT NULL,"
            "doc_front_image TEXT NOT NULL DEFAULT '',"
            "doc_back_image TEXT NOT NULL DEFAULT '',"
            "created_ip TEXT NOT NULL DEFAULT '',"
            "status TEXT NOT NULL DEFAULT 'pending',"
            "created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP"
            ")")) {
        return 0;
    }

    db_exec("UPDATE users SET full_name='Root User' WHERE full_name=''");
    db_exec("UPDATE users SET is_active=1 WHERE is_active IS NULL");
    db_exec("UPDATE users SET can_dashboard=1, can_properties=1, can_tenants=1, can_finance=1, can_documents=1 "
            "WHERE can_dashboard IS NULL OR can_properties IS NULL OR can_tenants IS NULL OR can_finance IS NULL OR "
            "can_documents IS NULL");
    db_exec("UPDATE users SET can_settings=1 WHERE role='admin' AND can_settings=0");
    if (table_count("users") > 0 && count_query_int("SELECT COUNT(*) FROM users WHERE is_root=1") == 0) {
        db_exec("UPDATE users SET is_root=1, can_settings=1 WHERE id=(SELECT id FROM users ORDER BY id ASC LIMIT 1)");
    }

    db_exec("UPDATE properties SET total_units=(SELECT COUNT(*) FROM units WHERE property_id=properties.id)");
    return 1;
}

static int seed_units(void) {
    int property_id = 1;
    for (int i = 1; i <= 25; i++) {
        int number = 100 + i;
        if (!db_exec_fmt("INSERT OR IGNORE INTO units(property_id, unit_number, status, base_rent) VALUES(%d, '%d', 'vacant', 1800.0)",
                         property_id, number)) {
            return 0;
        }
    }
    return 1;
}

static int seed_data(void) {
    if (table_count("users") == 0) {
        char hash[65];
        hash_password("ChangeThisNow123!", hash);
        if (!db_exec_fmt(
                "INSERT INTO users(full_name, email, password_hash, role, is_root, is_active, can_dashboard, "
                "can_properties, can_tenants, can_finance, can_documents, can_settings) "
                "VALUES('Root Admin', 'admin@imobiliaria.local', '%q', 'admin', 1, 1, 1, 1, 1, 1, 1, 1)",
                hash)) {
            return 0;
        }
    }

    if (table_count("properties") == 0) {
        if (!db_exec("INSERT INTO properties(name, address, total_units) VALUES('Oliveira Costa Condominium', 'Downtown', 25)")) {
            return 0;
        }
    }

    if (!seed_units()) {
        return 0;
    }

    if (table_count("document_templates") == 0) {
        db_exec(
            "INSERT INTO document_templates(name, document_type, template_body) VALUES"
            "('Default Rental Contract', 'rental_contract', 'Contract between {{tenant_name}} (CPF {{cpf}}) and Oliveira Costa for unit {{unit_number}}. Monthly rent: {{rent_value}}. Due date: {{due_date}}.'),"
            "('Default Receipt', 'payment_receipt', 'Receipt: {{tenant_name}} (CPF {{cpf}}) paid {{rent_value}} for unit {{unit_number}}. Due date reference: {{due_date}}.')");
    }
    db_exec("INSERT INTO document_templates(name, document_type, template_body) "
            "SELECT 'Due Date Reminder', 'due_note', "
            "'Hello {{tenant_name}}, this is a reminder that rent for unit {{unit_number}} is due on {{due_date}}. Amount: {{rent_value}}.' "
            "WHERE NOT EXISTS(SELECT 1 FROM document_templates WHERE document_type='due_note')");
    db_exec("INSERT INTO document_templates(name, document_type, template_body) "
            "SELECT 'Overdue Notification', 'overdue_note', "
            "'Hello {{tenant_name}}, rent for unit {{unit_number}} is overdue since {{due_date}}. Outstanding amount: {{rent_value}}. Please contact us.' "
            "WHERE NOT EXISTS(SELECT 1 FROM document_templates WHERE document_type='overdue_note')");
    db_exec("INSERT INTO document_templates(name, document_type, template_body) "
            "SELECT 'Eviction Notice Template', 'eviction_notice', "
            "'{{tenant_name}} - Unit {{unit_number}}\\n\\n[Edit this eviction template in Document Center.]' "
            "WHERE NOT EXISTS(SELECT 1 FROM document_templates WHERE document_type='eviction_notice')");

    if (table_count("tenants") == 0) {
        db_exec(
            "INSERT INTO tenants(full_name, cpf, rg, civil_state, occupation, reference_address, phone, email, unit_id, rent_amount, due_day, contract_start, contract_end, notes, active) VALUES"
            "('Marina Souza', '11122233344', 'MG123456', 'single', 'Designer', 'Rua A, 120', '+55 31 99999-1111', 'marina@example.com', 1, 2200, 5, '2025-06-01', '2026-06-01', 'Pays early', 1),"
            "('Rafael Lima', '55566677788', 'SP998877', 'married', 'Engineer', 'Rua B, 331', '+55 11 98888-2222', 'rafael@example.com', 2, 2400, 10, '2025-08-01', '2026-08-01', '', 1),"
            "('Clara Mendes', '99900011122', 'RJ001122', 'single', 'Doctor', 'Rua C, 40', '+55 21 97777-3333', 'clara@example.com', 3, 2600, 15, '2025-07-15', '2026-07-15', '', 1)");
        db_exec("UPDATE units SET status='occupied', current_tenant_id=1, base_rent=2200 WHERE id=1");
        db_exec("UPDATE units SET status='occupied', current_tenant_id=2, base_rent=2400 WHERE id=2");
        db_exec("UPDATE units SET status='occupied', current_tenant_id=3, base_rent=2600 WHERE id=3");
    }

    if (table_count("maintenance_tickets") == 0) {
        db_exec(
            "INSERT INTO maintenance_tickets(unit_id, description, ticket_date, cost, status, image_path) VALUES"
            "(1, 'Air conditioning maintenance', date('now', '-4 days'), 180, 'completed', ''),"
            "(2, 'Kitchen sink leakage', date('now', '-1 days'), 0, 'open', '')");
    }

    if (table_count("expenses") == 0) {
        db_exec(
            "INSERT INTO expenses(category, description, amount, expense_date, unit_id) VALUES"
            "('maintenance', 'AC maintenance', 180, date('now', '-4 days'), 1),"
            "('taxes', 'Municipal fee', 520, date('now', '-2 days'), NULL)");
    }

    return 1;
}

static int ensure_charge_for_tenant(int tenant_id, int unit_id, double amount, int due_day, const char *month) {
    char due_date[DATE_LEN];
    snprintf(due_date, DATE_LEN, "%.*s-%02d", 7, month, due_day < 1 ? 1 : (due_day > 28 ? 28 : due_day));

    sqlite3_stmt *stmt = NULL;
    const char *sql =
        "INSERT INTO rent_charges(tenant_id, unit_id, month, amount, due_date, status) "
        "VALUES(?, ?, ?, ?, ?, 'unpaid') "
        "ON CONFLICT(tenant_id, month) DO UPDATE SET "
        "unit_id=excluded.unit_id, amount=excluded.amount, due_date=excluded.due_date";

    if (sqlite3_prepare_v2(g_app.db, sql, -1, &stmt, NULL) != SQLITE_OK) {
        return 0;
    }
    sqlite3_bind_int(stmt, 1, tenant_id);
    sqlite3_bind_int(stmt, 2, unit_id);
    sqlite3_bind_text(stmt, 3, month, -1, SQLITE_TRANSIENT);
    sqlite3_bind_double(stmt, 4, amount);
    sqlite3_bind_text(stmt, 5, due_date, -1, SQLITE_TRANSIENT);

    int ok = sqlite3_step(stmt) == SQLITE_DONE;
    sqlite3_finalize(stmt);
    return ok;
}

static int run_monthly_rent_generation(void) {
    char month[MONTH_LEN];
    current_month(month);

    sqlite3_stmt *stmt = NULL;
    const char *sql =
        "SELECT t.id, IFNULL(t.unit_id, 0), t.rent_amount, t.due_day "
        "FROM tenants t "
        "LEFT JOIN units u ON u.id=t.unit_id "
        "WHERE t.active = 1 AND IFNULL(u.is_active, 1) = 1";
    if (sqlite3_prepare_v2(g_app.db, sql, -1, &stmt, NULL) != SQLITE_OK) {
        return 0;
    }

    int ok = 1;
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        int tenant_id = sqlite3_column_int(stmt, 0);
        int unit_id = sqlite3_column_int(stmt, 1);
        double amount = sqlite3_column_double(stmt, 2);
        int due_day = sqlite3_column_int(stmt, 3);
        if (unit_id > 0 && !ensure_charge_for_tenant(tenant_id, unit_id, amount, due_day, month)) {
            ok = 0;
            break;
        }
    }

    sqlite3_finalize(stmt);
    return ok;
}

static int mark_overdue_charges(void) {
    return db_exec("UPDATE rent_charges SET status='overdue' WHERE status!='paid' AND due_date < date('now')");
}

static int refresh_notifications(void) {
    if (!db_exec("DELETE FROM notifications")) {
        return 0;
    }

    db_exec(
        "INSERT INTO notifications(type, title, message, related_id) "
        "SELECT 'due_soon', 'Payment due soon', "
        "'Unit ' || u.unit_number || ' / ' || t.full_name || ' due on ' || rc.due_date, rc.id "
        "FROM rent_charges rc "
        "JOIN units u ON u.id = rc.unit_id "
        "JOIN tenants t ON t.id = rc.tenant_id "
        "WHERE u.is_active=1 AND rc.status != 'paid' AND rc.due_date >= date('now') AND rc.due_date <= date('now', '+4 day')");

    db_exec(
        "INSERT INTO notifications(type, title, message, related_id) "
        "SELECT 'overdue', 'Overdue payment', "
        "'Unit ' || u.unit_number || ' / ' || t.full_name || ' overdue since ' || rc.due_date, rc.id "
        "FROM rent_charges rc "
        "JOIN units u ON u.id = rc.unit_id "
        "JOIN tenants t ON t.id = rc.tenant_id "
        "WHERE u.is_active=1 AND rc.status = 'overdue'");

    db_exec(
        "INSERT INTO notifications(type, title, message, related_id) "
        "SELECT 'contract_expiring', 'Contract expiring soon', "
        "t.full_name || ' contract ends on ' || t.contract_end, t.id "
        "FROM tenants t "
        "WHERE t.active = 1 AND t.contract_end IS NOT NULL "
        "AND t.contract_end >= date('now') AND t.contract_end <= date('now', '+30 day')");

    db_exec(
        "INSERT INTO notifications(type, title, message, related_id) "
        "SELECT 'maintenance_open', 'Open maintenance ticket', "
        "'Unit ' || u.unit_number || ': ' || m.description, m.id "
        "FROM maintenance_tickets m "
        "JOIN units u ON u.id = m.unit_id "
        "WHERE u.is_active=1 AND m.status IN ('open','in_progress')");

    return 1;
}

static int run_automation_cycle(void) {
    return run_monthly_rent_generation() && mark_overdue_charges() && refresh_notifications();
}

static int db_init(void) {
    if (sqlite3_open(g_app.db_path, &g_app.db) != SQLITE_OK) {
        fprintf(stderr, "Failed to open database: %s\n", sqlite3_errmsg(g_app.db));
        return 0;
    }
    if (!init_schema()) {
        return 0;
    }
    if (!run_schema_migrations()) {
        return 0;
    }
    if (!seed_data()) {
        return 0;
    }
    if (!run_automation_cycle()) {
        return 0;
    }
    return 1;
}

static const char *json_string(cJSON *obj, const char *key) {
    cJSON *item = cJSON_GetObjectItemCaseSensitive(obj, key);
    return cJSON_IsString(item) ? item->valuestring : NULL;
}

static int json_int(cJSON *obj, const char *key, int def) {
    cJSON *item = cJSON_GetObjectItemCaseSensitive(obj, key);
    return cJSON_IsNumber(item) ? item->valueint : def;
}

static int json_bool_int(cJSON *obj, const char *key, int def) {
    cJSON *item = cJSON_GetObjectItemCaseSensitive(obj, key);
    if (cJSON_IsBool(item)) {
        return cJSON_IsTrue(item) ? 1 : 0;
    }
    if (cJSON_IsNumber(item)) {
        return item->valueint != 0 ? 1 : 0;
    }
    return def;
}

static double json_double(cJSON *obj, const char *key, double def) {
    cJSON *item = cJSON_GetObjectItemCaseSensitive(obj, key);
    return cJSON_IsNumber(item) ? item->valuedouble : def;
}

static int validate_token(const char *token, AuthUser *user) {
    sqlite3_stmt *stmt = NULL;
    const char *sql =
        "SELECT u.id, IFNULL(u.full_name,''), u.email, u.role, u.is_root, u.is_active, "
        "u.can_dashboard, u.can_properties, u.can_tenants, u.can_finance, u.can_documents, u.can_settings "
        "FROM sessions s "
        "JOIN users u ON u.id = s.user_id "
        "WHERE s.token = ? AND s.expires_at > datetime('now')";

    if (sqlite3_prepare_v2(g_app.db, sql, -1, &stmt, NULL) != SQLITE_OK) {
        return 0;
    }
    sqlite3_bind_text(stmt, 1, token, -1, SQLITE_TRANSIENT);

    int ok = 0;
    auth_user_clear(user);
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        user->id = sqlite3_column_int(stmt, 0);
        snprintf(user->full_name, USER_NAME_LEN, "%s", (const char *) sqlite3_column_text(stmt, 1));
        snprintf(user->email, EMAIL_LEN, "%s", (const char *) sqlite3_column_text(stmt, 2));
        snprintf(user->role, ROLE_LEN, "%s", (const char *) sqlite3_column_text(stmt, 3));
        user->is_root = sqlite3_column_int(stmt, 4);
        user->is_active = sqlite3_column_int(stmt, 5);
        user->can_dashboard = sqlite3_column_int(stmt, 6);
        user->can_properties = sqlite3_column_int(stmt, 7);
        user->can_tenants = sqlite3_column_int(stmt, 8);
        user->can_finance = sqlite3_column_int(stmt, 9);
        user->can_documents = sqlite3_column_int(stmt, 10);
        user->can_settings = sqlite3_column_int(stmt, 11);
        ok = user->is_active == 1;
    }
    sqlite3_finalize(stmt);
    return ok;
}

static int authenticate_request(struct MHD_Connection *connection, AuthUser *user) {
    const char *auth = MHD_lookup_connection_value(connection, MHD_HEADER_KIND, "Authorization");
    if (!auth || !starts_with(auth, "Bearer ")) {
        return 0;
    }
    const char *token = auth + 7;
    if (strlen(token) < 16) {
        return 0;
    }
    return validate_token(token, user);
}

static int has_route_access(const AuthUser *user, const char *url) {
    if (!user || user->id <= 0 || user->is_active != 1) {
        return 0;
    }
    if (user->is_root == 1) {
        return 1;
    }

    if (strcmp(url, "/api/auth/me") == 0 || strcmp(url, "/api/auth/logout") == 0) {
        return 1;
    }
    if (starts_with(url, "/api/users")) {
        return user->can_settings == 1;
    }
    if (starts_with(url, "/api/dashboard") || starts_with(url, "/api/notifications")) {
        return user->can_dashboard == 1;
    }
    if (starts_with(url, "/api/units") || starts_with(url, "/api/maintenance")) {
        return user->can_properties == 1;
    }
    if (starts_with(url, "/api/tenants") || starts_with(url, "/api/pre-registrations")) {
        return user->can_tenants == 1;
    }
    if (starts_with(url, "/api/finance") || starts_with(url, "/api/payments") || starts_with(url, "/api/expenses") ||
        starts_with(url, "/api/exports")) {
        return user->can_finance == 1;
    }
    if (starts_with(url, "/api/documents") || starts_with(url, "/api/document-templates")) {
        return user->can_documents == 1;
    }
    return 0;
}

static int handle_health(struct MHD_Connection *connection) {
    cJSON *json = cJSON_CreateObject();
    char ts[20];
    now_iso_datetime(ts);
    cJSON_AddStringToObject(json, "status", "ok");
    cJSON_AddStringToObject(json, "service", "oliveira-costa-real-estate-api");
    cJSON_AddStringToObject(json, "timestamp", ts);
    int ret = send_json(connection, MHD_HTTP_OK, json);
    cJSON_Delete(json);
    return ret;
}

static int handle_login(struct MHD_Connection *connection, const char *body) {
    if (!body || body[0] == '\0') {
        return send_error(connection, MHD_HTTP_BAD_REQUEST, "missing_request_body");
    }

    cJSON *input = cJSON_Parse(body);
    if (!input) {
        return send_error(connection, MHD_HTTP_BAD_REQUEST, "invalid_json");
    }

    const char *email = json_string(input, "email");
    const char *password = json_string(input, "password");
    if (!email || !password) {
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_BAD_REQUEST, "email_and_password_required");
    }

    sqlite3_stmt *stmt = NULL;
    const char *sql =
        "SELECT id, IFNULL(full_name,''), email, password_hash, role, is_root, is_active, "
        "can_dashboard, can_properties, can_tenants, can_finance, can_documents, can_settings "
        "FROM users WHERE email = ?";
    if (sqlite3_prepare_v2(g_app.db, sql, -1, &stmt, NULL) != SQLITE_OK) {
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "db_prepare_failed");
    }

    sqlite3_bind_text(stmt, 1, email, -1, SQLITE_TRANSIENT);
    AuthUser user;
    auth_user_clear(&user);
    char stored_hash[65] = {0};

    if (sqlite3_step(stmt) == SQLITE_ROW) {
        user.id = sqlite3_column_int(stmt, 0);
        snprintf(user.full_name, USER_NAME_LEN, "%s", (const char *) sqlite3_column_text(stmt, 1));
        snprintf(user.email, EMAIL_LEN, "%s", (const char *) sqlite3_column_text(stmt, 2));
        const unsigned char *hash_txt = sqlite3_column_text(stmt, 3);
        snprintf(stored_hash, sizeof(stored_hash), "%s", hash_txt ? (const char *) hash_txt : "");
        snprintf(user.role, ROLE_LEN, "%s", (const char *) sqlite3_column_text(stmt, 4));
        user.is_root = sqlite3_column_int(stmt, 5);
        user.is_active = sqlite3_column_int(stmt, 6);
        user.can_dashboard = sqlite3_column_int(stmt, 7);
        user.can_properties = sqlite3_column_int(stmt, 8);
        user.can_tenants = sqlite3_column_int(stmt, 9);
        user.can_finance = sqlite3_column_int(stmt, 10);
        user.can_documents = sqlite3_column_int(stmt, 11);
        user.can_settings = sqlite3_column_int(stmt, 12);
    }
    sqlite3_finalize(stmt);

    char provided_hash[65];
    hash_password(password, provided_hash);
    if (user.id == 0 || strcmp(stored_hash, provided_hash) != 0) {
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_UNAUTHORIZED, "invalid_credentials");
    }
    if (user.is_active != 1) {
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_FORBIDDEN, "user_inactive");
    }

    char token[TOKEN_LEN + 1];
    generate_token(token);
    if (!db_exec_fmt("DELETE FROM sessions WHERE user_id=%d", user.id)) {
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "session_cleanup_failed");
    }
    if (!db_exec_fmt("INSERT INTO sessions(token, user_id, expires_at) VALUES('%q', %d, datetime('now', '+%d hours'))", token,
                     user.id, TOKEN_TTL_HOURS)) {
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "session_create_failed");
    }

    cJSON *out = cJSON_CreateObject();
    cJSON_AddStringToObject(out, "token", token);
    cJSON_AddStringToObject(out, "token_type", "Bearer");
    cJSON_AddNumberToObject(out, "expires_in_hours", TOKEN_TTL_HOURS);
    add_auth_user_json(out, &user);

    int ret = send_json(connection, MHD_HTTP_OK, out);
    cJSON_Delete(out);
    cJSON_Delete(input);
    return ret;
}

static int handle_auth_me(struct MHD_Connection *connection, const AuthUser *auth_user) {
    cJSON *out = cJSON_CreateObject();
    add_auth_user_json(out, auth_user);
    int ret = send_json(connection, MHD_HTTP_OK, out);
    cJSON_Delete(out);
    return ret;
}

static int handle_logout(struct MHD_Connection *connection, int user_id) {
    if (!db_exec_fmt("DELETE FROM sessions WHERE user_id=%d", user_id)) {
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "logout_failed");
    }
    cJSON *out = cJSON_CreateObject();
    cJSON_AddStringToObject(out, "message", "logged_out");
    int ret = send_json(connection, MHD_HTTP_OK, out);
    cJSON_Delete(out);
    return ret;
}

static int json_bool_from_obj(cJSON *obj, const char *key, int def) {
    if (!obj) {
        return def;
    }
    cJSON *item = cJSON_GetObjectItemCaseSensitive(obj, key);
    if (cJSON_IsBool(item)) {
        return cJSON_IsTrue(item) ? 1 : 0;
    }
    if (cJSON_IsNumber(item)) {
        return item->valueint != 0 ? 1 : 0;
    }
    return def;
}

static int active_root_count(void) {
    return count_query_int("SELECT COUNT(*) FROM users WHERE is_root=1 AND is_active=1");
}

static int handle_get_users(struct MHD_Connection *connection) {
    sqlite3_stmt *stmt = NULL;
    const char *sql =
        "SELECT id, IFNULL(full_name,''), email, role, is_root, is_active, can_dashboard, can_properties, can_tenants, "
        "can_finance, can_documents, can_settings, created_at "
        "FROM users ORDER BY is_root DESC, created_at ASC";
    if (sqlite3_prepare_v2(g_app.db, sql, -1, &stmt, NULL) != SQLITE_OK) {
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "db_prepare_failed");
    }

    cJSON *root = cJSON_CreateObject();
    cJSON *items = cJSON_AddArrayToObject(root, "items");
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        cJSON *item = cJSON_CreateObject();
        cJSON_AddNumberToObject(item, "id", sqlite3_column_int(stmt, 0));
        cJSON_AddStringToObject(item, "full_name", (const char *) sqlite3_column_text(stmt, 1));
        cJSON_AddStringToObject(item, "email", (const char *) sqlite3_column_text(stmt, 2));
        cJSON_AddStringToObject(item, "role", (const char *) sqlite3_column_text(stmt, 3));
        cJSON_AddBoolToObject(item, "is_root", sqlite3_column_int(stmt, 4) == 1);
        cJSON_AddBoolToObject(item, "is_active", sqlite3_column_int(stmt, 5) == 1);
        cJSON_AddStringToObject(item, "created_at", (const char *) sqlite3_column_text(stmt, 12));

        cJSON *permissions = cJSON_AddObjectToObject(item, "permissions");
        cJSON_AddBoolToObject(permissions, "dashboard", sqlite3_column_int(stmt, 6) == 1);
        cJSON_AddBoolToObject(permissions, "properties", sqlite3_column_int(stmt, 7) == 1);
        cJSON_AddBoolToObject(permissions, "tenants", sqlite3_column_int(stmt, 8) == 1);
        cJSON_AddBoolToObject(permissions, "finance", sqlite3_column_int(stmt, 9) == 1);
        cJSON_AddBoolToObject(permissions, "documents", sqlite3_column_int(stmt, 10) == 1);
        cJSON_AddBoolToObject(permissions, "settings", sqlite3_column_int(stmt, 11) == 1);
        cJSON_AddItemToArray(items, item);
    }
    sqlite3_finalize(stmt);

    int ret = send_json(connection, MHD_HTTP_OK, root);
    cJSON_Delete(root);
    return ret;
}

static int handle_create_user(struct MHD_Connection *connection, const char *body, const AuthUser *auth_user) {
    if (!auth_user || auth_user->is_root != 1) {
        return send_error(connection, MHD_HTTP_FORBIDDEN, "root_required");
    }

    cJSON *input = cJSON_Parse(body ? body : "");
    if (!input) {
        return send_error(connection, MHD_HTTP_BAD_REQUEST, "invalid_json");
    }

    const char *full_name = json_string(input, "full_name");
    const char *email = json_string(input, "email");
    const char *password = json_string(input, "password");
    const char *role = json_string(input, "role");
    if (!full_name || !email || !password || strlen(password) < 8) {
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_BAD_REQUEST, "full_name_email_password_required");
    }

    int is_root = json_bool_int(input, "is_root", 0);
    int is_active = json_bool_int(input, "is_active", 1);
    cJSON *permissions = cJSON_GetObjectItemCaseSensitive(input, "permissions");
    int can_dashboard = json_bool_from_obj(permissions, "dashboard", 0);
    int can_properties = json_bool_from_obj(permissions, "properties", 0);
    int can_tenants = json_bool_from_obj(permissions, "tenants", 0);
    int can_finance = json_bool_from_obj(permissions, "finance", 0);
    int can_documents = json_bool_from_obj(permissions, "documents", 0);
    int can_settings = json_bool_from_obj(permissions, "settings", 0);

    if (is_root == 1) {
        can_dashboard = 1;
        can_properties = 1;
        can_tenants = 1;
        can_finance = 1;
        can_documents = 1;
        can_settings = 1;
    }

    char hash[65];
    hash_password(password, hash);

    sqlite3_stmt *stmt = NULL;
    const char *sql =
        "INSERT INTO users(full_name, email, password_hash, role, is_root, is_active, can_dashboard, can_properties, "
        "can_tenants, can_finance, can_documents, can_settings) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)";
    if (sqlite3_prepare_v2(g_app.db, sql, -1, &stmt, NULL) != SQLITE_OK) {
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "db_prepare_failed");
    }
    sqlite3_bind_text(stmt, 1, full_name, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 2, email, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 3, hash, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 4, role ? role : "staff", -1, SQLITE_TRANSIENT);
    sqlite3_bind_int(stmt, 5, is_root ? 1 : 0);
    sqlite3_bind_int(stmt, 6, is_active ? 1 : 0);
    sqlite3_bind_int(stmt, 7, can_dashboard ? 1 : 0);
    sqlite3_bind_int(stmt, 8, can_properties ? 1 : 0);
    sqlite3_bind_int(stmt, 9, can_tenants ? 1 : 0);
    sqlite3_bind_int(stmt, 10, can_finance ? 1 : 0);
    sqlite3_bind_int(stmt, 11, can_documents ? 1 : 0);
    sqlite3_bind_int(stmt, 12, can_settings ? 1 : 0);

    if (sqlite3_step(stmt) != SQLITE_DONE) {
        const char *err = sqlite3_errmsg(g_app.db);
        sqlite3_finalize(stmt);
        cJSON_Delete(input);
        if (strstr(err, "UNIQUE")) {
            return send_error(connection, MHD_HTTP_CONFLICT, "email_already_exists");
        }
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "user_create_failed");
    }
    sqlite3_finalize(stmt);
    cJSON_Delete(input);

    cJSON *out = cJSON_CreateObject();
    cJSON_AddNumberToObject(out, "id", sqlite3_last_insert_rowid(g_app.db));
    cJSON_AddStringToObject(out, "message", "user_created");
    int ret = send_json(connection, MHD_HTTP_CREATED, out);
    cJSON_Delete(out);
    return ret;
}

static int handle_update_user(struct MHD_Connection *connection, int target_user_id, const char *body,
                              const AuthUser *auth_user) {
    if (!auth_user || auth_user->is_root != 1) {
        return send_error(connection, MHD_HTTP_FORBIDDEN, "root_required");
    }

    cJSON *input = cJSON_Parse(body ? body : "");
    if (!input) {
        return send_error(connection, MHD_HTTP_BAD_REQUEST, "invalid_json");
    }

    sqlite3_stmt *stmt = NULL;
    const char *sql =
        "SELECT IFNULL(full_name,''), email, IFNULL(role,'staff'), IFNULL(password_hash,''), is_root, is_active, "
        "can_dashboard, can_properties, can_tenants, can_finance, can_documents, can_settings "
        "FROM users WHERE id=?";
    if (sqlite3_prepare_v2(g_app.db, sql, -1, &stmt, NULL) != SQLITE_OK) {
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "db_prepare_failed");
    }
    sqlite3_bind_int(stmt, 1, target_user_id);

    char full_name[USER_NAME_LEN] = {0};
    char email[EMAIL_LEN] = {0};
    char role[ROLE_LEN] = {0};
    char password_hash[65] = {0};
    int is_root = 0;
    int is_active = 1;
    int can_dashboard = 0;
    int can_properties = 0;
    int can_tenants = 0;
    int can_finance = 0;
    int can_documents = 0;
    int can_settings = 0;

    if (sqlite3_step(stmt) == SQLITE_ROW) {
        snprintf(full_name, sizeof(full_name), "%s", (const char *) sqlite3_column_text(stmt, 0));
        snprintf(email, sizeof(email), "%s", (const char *) sqlite3_column_text(stmt, 1));
        snprintf(role, sizeof(role), "%s", (const char *) sqlite3_column_text(stmt, 2));
        snprintf(password_hash, sizeof(password_hash), "%s", (const char *) sqlite3_column_text(stmt, 3));
        is_root = sqlite3_column_int(stmt, 4);
        is_active = sqlite3_column_int(stmt, 5);
        can_dashboard = sqlite3_column_int(stmt, 6);
        can_properties = sqlite3_column_int(stmt, 7);
        can_tenants = sqlite3_column_int(stmt, 8);
        can_finance = sqlite3_column_int(stmt, 9);
        can_documents = sqlite3_column_int(stmt, 10);
        can_settings = sqlite3_column_int(stmt, 11);
    } else {
        sqlite3_finalize(stmt);
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_NOT_FOUND, "user_not_found");
    }
    sqlite3_finalize(stmt);

    const char *full_name_in = json_string(input, "full_name");
    const char *email_in = json_string(input, "email");
    const char *role_in = json_string(input, "role");
    const char *password_in = json_string(input, "password");
    if (full_name_in) {
        snprintf(full_name, sizeof(full_name), "%s", full_name_in);
    }
    if (email_in) {
        snprintf(email, sizeof(email), "%s", email_in);
    }
    if (role_in) {
        snprintf(role, sizeof(role), "%s", role_in);
    }
    if (password_in && password_in[0] != '\0') {
        if (strlen(password_in) < 8) {
            cJSON_Delete(input);
            return send_error(connection, MHD_HTTP_BAD_REQUEST, "password_too_short");
        }
        hash_password(password_in, password_hash);
    }

    int requested_is_root = json_bool_int(input, "is_root", is_root);
    int requested_is_active = json_bool_int(input, "is_active", is_active);
    cJSON *permissions = cJSON_GetObjectItemCaseSensitive(input, "permissions");
    can_dashboard = json_bool_from_obj(permissions, "dashboard", can_dashboard);
    can_properties = json_bool_from_obj(permissions, "properties", can_properties);
    can_tenants = json_bool_from_obj(permissions, "tenants", can_tenants);
    can_finance = json_bool_from_obj(permissions, "finance", can_finance);
    can_documents = json_bool_from_obj(permissions, "documents", can_documents);
    can_settings = json_bool_from_obj(permissions, "settings", can_settings);

    if (requested_is_root == 1) {
        can_dashboard = 1;
        can_properties = 1;
        can_tenants = 1;
        can_finance = 1;
        can_documents = 1;
        can_settings = 1;
    }

    if (target_user_id == auth_user->id && requested_is_active != 1) {
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_BAD_REQUEST, "cannot_deactivate_current_user");
    }

    if (is_root == 1 && requested_is_root == 0 && active_root_count() <= 1) {
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_BAD_REQUEST, "at_least_one_root_required");
    }
    if (is_root == 1 && requested_is_active == 0 && active_root_count() <= 1) {
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_BAD_REQUEST, "at_least_one_root_required");
    }

    const char *sql_update =
        "UPDATE users SET full_name=?, email=?, role=?, password_hash=?, is_root=?, is_active=?, can_dashboard=?, "
        "can_properties=?, can_tenants=?, can_finance=?, can_documents=?, can_settings=? WHERE id=?";
    if (sqlite3_prepare_v2(g_app.db, sql_update, -1, &stmt, NULL) != SQLITE_OK) {
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "db_prepare_failed");
    }

    sqlite3_bind_text(stmt, 1, full_name, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 2, email, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 3, role, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 4, password_hash, -1, SQLITE_TRANSIENT);
    sqlite3_bind_int(stmt, 5, requested_is_root ? 1 : 0);
    sqlite3_bind_int(stmt, 6, requested_is_active ? 1 : 0);
    sqlite3_bind_int(stmt, 7, can_dashboard ? 1 : 0);
    sqlite3_bind_int(stmt, 8, can_properties ? 1 : 0);
    sqlite3_bind_int(stmt, 9, can_tenants ? 1 : 0);
    sqlite3_bind_int(stmt, 10, can_finance ? 1 : 0);
    sqlite3_bind_int(stmt, 11, can_documents ? 1 : 0);
    sqlite3_bind_int(stmt, 12, can_settings ? 1 : 0);
    sqlite3_bind_int(stmt, 13, target_user_id);

    if (sqlite3_step(stmt) != SQLITE_DONE) {
        const char *err = sqlite3_errmsg(g_app.db);
        sqlite3_finalize(stmt);
        cJSON_Delete(input);
        if (strstr(err, "UNIQUE")) {
            return send_error(connection, MHD_HTTP_CONFLICT, "email_already_exists");
        }
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "user_update_failed");
    }
    sqlite3_finalize(stmt);

    if (!requested_is_active) {
        db_exec_fmt("DELETE FROM sessions WHERE user_id=%d", target_user_id);
    }

    cJSON_Delete(input);
    cJSON *out = cJSON_CreateObject();
    cJSON_AddStringToObject(out, "message", "user_updated");
    int ret = send_json(connection, MHD_HTTP_OK, out);
    cJSON_Delete(out);
    return ret;
}

static int handle_delete_user(struct MHD_Connection *connection, int target_user_id, const AuthUser *auth_user) {
    if (!auth_user || auth_user->is_root != 1) {
        return send_error(connection, MHD_HTTP_FORBIDDEN, "root_required");
    }
    if (target_user_id == auth_user->id) {
        return send_error(connection, MHD_HTTP_BAD_REQUEST, "cannot_delete_current_user");
    }

    sqlite3_stmt *stmt = NULL;
    int exists = 0;
    int is_root = 0;
    if (sqlite3_prepare_v2(g_app.db, "SELECT is_root FROM users WHERE id=?", -1, &stmt, NULL) == SQLITE_OK) {
        sqlite3_bind_int(stmt, 1, target_user_id);
        if (sqlite3_step(stmt) == SQLITE_ROW) {
            exists = 1;
            is_root = sqlite3_column_int(stmt, 0);
        }
    }
    sqlite3_finalize(stmt);

    if (!exists) {
        return send_error(connection, MHD_HTTP_NOT_FOUND, "user_not_found");
    }
    if (is_root == 1 && active_root_count() <= 1) {
        return send_error(connection, MHD_HTTP_BAD_REQUEST, "at_least_one_root_required");
    }

    if (!db_exec_fmt("UPDATE users SET is_active=0 WHERE id=%d", target_user_id) ||
        !db_exec_fmt("DELETE FROM sessions WHERE user_id=%d", target_user_id)) {
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "user_delete_failed");
    }

    cJSON *out = cJSON_CreateObject();
    cJSON_AddStringToObject(out, "message", "user_deactivated");
    int ret = send_json(connection, MHD_HTTP_OK, out);
    cJSON_Delete(out);
    return ret;
}

static int handle_create_pre_register(struct MHD_Connection *connection, const char *body) {
    char ip[CLIENT_IP_LEN];
    if (!pre_register_rate_allow(connection, ip)) {
        return send_error(connection, 429, "rate_limited");
    }

    cJSON *input = cJSON_Parse(body ? body : "");
    if (!input) {
        return send_error(connection, MHD_HTTP_BAD_REQUEST, "invalid_json");
    }

    const char *full_name = json_string(input, "full_name");
    const char *cpf = json_string(input, "cpf");
    const char *rg = json_string(input, "rg");
    const char *civil_state = json_string(input, "civil_state");
    const char *occupation = json_string(input, "occupation");
    const char *reference_address = json_string(input, "reference_address");
    const char *phone = json_string(input, "phone");
    const char *email = json_string(input, "email");
    int due_day = json_int(input, "due_day", 0);
    int contract_months = json_int(input, "contract_months", 0);
    const char *doc_front_image = json_string(input, "doc_front_image");
    const char *doc_back_image = json_string(input, "doc_back_image");

    if (!full_name || !cpf || !rg || !civil_state || !occupation || !reference_address || !phone || !email ||
        !doc_front_image || !doc_back_image) {
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_BAD_REQUEST, "missing_required_fields");
    }
    if (!(due_day == 5 || due_day == 10 || due_day == 15 || due_day == 20)) {
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_BAD_REQUEST, "invalid_due_day");
    }
    if (contract_months < 1 || contract_months > 12) {
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_BAD_REQUEST, "invalid_contract_months");
    }

    sqlite3_stmt *stmt = NULL;
    const char *sql =
        "INSERT INTO pre_registrations(full_name, cpf, rg, civil_state, occupation, reference_address, phone, email, "
        "due_day, contract_months, doc_front_image, doc_back_image, created_ip, status) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')";
    if (sqlite3_prepare_v2(g_app.db, sql, -1, &stmt, NULL) != SQLITE_OK) {
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "db_prepare_failed");
    }

    sqlite3_bind_text(stmt, 1, full_name, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 2, cpf, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 3, rg, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 4, civil_state, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 5, occupation, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 6, reference_address, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 7, phone, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 8, email, -1, SQLITE_TRANSIENT);
    sqlite3_bind_int(stmt, 9, due_day);
    sqlite3_bind_int(stmt, 10, contract_months);
    sqlite3_bind_text(stmt, 11, doc_front_image, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 12, doc_back_image, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 13, ip, -1, SQLITE_TRANSIENT);

    if (sqlite3_step(stmt) != SQLITE_DONE) {
        sqlite3_finalize(stmt);
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "pre_register_failed");
    }
    sqlite3_finalize(stmt);
    cJSON_Delete(input);

    cJSON *out = cJSON_CreateObject();
    cJSON_AddNumberToObject(out, "id", sqlite3_last_insert_rowid(g_app.db));
    cJSON_AddStringToObject(out, "message", "pre_registered");
    int ret = send_json(connection, MHD_HTTP_CREATED, out);
    cJSON_Delete(out);
    return ret;
}

static int handle_get_pre_registrations(struct MHD_Connection *connection) {
    sqlite3_stmt *stmt = NULL;
    const char *sql =
        "SELECT id, full_name, cpf, rg, civil_state, occupation, reference_address, phone, email, due_day, "
        "contract_months, doc_front_image, doc_back_image, status, created_at "
        "FROM pre_registrations WHERE status='pending' ORDER BY created_at DESC";
    if (sqlite3_prepare_v2(g_app.db, sql, -1, &stmt, NULL) != SQLITE_OK) {
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "db_prepare_failed");
    }

    cJSON *root = cJSON_CreateObject();
    cJSON *items = cJSON_AddArrayToObject(root, "items");
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        cJSON *item = cJSON_CreateObject();
        cJSON_AddNumberToObject(item, "id", sqlite3_column_int(stmt, 0));
        cJSON_AddStringToObject(item, "full_name", (const char *) sqlite3_column_text(stmt, 1));
        cJSON_AddStringToObject(item, "cpf", (const char *) sqlite3_column_text(stmt, 2));
        cJSON_AddStringToObject(item, "rg", (const char *) sqlite3_column_text(stmt, 3));
        cJSON_AddStringToObject(item, "civil_state", (const char *) sqlite3_column_text(stmt, 4));
        cJSON_AddStringToObject(item, "occupation", (const char *) sqlite3_column_text(stmt, 5));
        cJSON_AddStringToObject(item, "reference_address", (const char *) sqlite3_column_text(stmt, 6));
        cJSON_AddStringToObject(item, "phone", (const char *) sqlite3_column_text(stmt, 7));
        cJSON_AddStringToObject(item, "email", (const char *) sqlite3_column_text(stmt, 8));
        cJSON_AddNumberToObject(item, "due_day", sqlite3_column_int(stmt, 9));
        cJSON_AddNumberToObject(item, "contract_months", sqlite3_column_int(stmt, 10));
        cJSON_AddStringToObject(item, "doc_front_image", (const char *) sqlite3_column_text(stmt, 11));
        cJSON_AddStringToObject(item, "doc_back_image", (const char *) sqlite3_column_text(stmt, 12));
        cJSON_AddStringToObject(item, "status", (const char *) sqlite3_column_text(stmt, 13));
        cJSON_AddStringToObject(item, "created_at", (const char *) sqlite3_column_text(stmt, 14));
        cJSON_AddItemToArray(items, item);
    }
    sqlite3_finalize(stmt);

    int ret = send_json(connection, MHD_HTTP_OK, root);
    cJSON_Delete(root);
    return ret;
}

static int handle_delete_pre_registration(struct MHD_Connection *connection, int pre_id) {
    if (!db_exec_fmt("DELETE FROM pre_registrations WHERE id=%d", pre_id)) {
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "pre_register_delete_failed");
    }
    if (sqlite3_changes(g_app.db) == 0) {
        return send_error(connection, MHD_HTTP_NOT_FOUND, "pre_register_not_found");
    }
    cJSON *out = cJSON_CreateObject();
    cJSON_AddStringToObject(out, "message", "pre_register_deleted");
    int ret = send_json(connection, MHD_HTTP_OK, out);
    cJSON_Delete(out);
    return ret;
}

static int validate_unit_assignment(int unit_id, int tenant_id_to_ignore, int require_active, const char **error_code) {
    sqlite3_stmt *stmt = NULL;
    const char *sql = "SELECT is_active, IFNULL(current_tenant_id,0) FROM units WHERE id=?";
    if (sqlite3_prepare_v2(g_app.db, sql, -1, &stmt, NULL) != SQLITE_OK) {
        *error_code = "db_prepare_failed";
        return 0;
    }

    sqlite3_bind_int(stmt, 1, unit_id);
    if (sqlite3_step(stmt) != SQLITE_ROW) {
        sqlite3_finalize(stmt);
        *error_code = "unit_not_found";
        return 0;
    }

    int is_active = sqlite3_column_int(stmt, 0);
    int current_tenant_id = sqlite3_column_int(stmt, 1);
    sqlite3_finalize(stmt);

    if (require_active && !is_active) {
        *error_code = "unit_disabled";
        return 0;
    }
    if (current_tenant_id > 0 && current_tenant_id != tenant_id_to_ignore) {
        *error_code = "unit_already_assigned";
        return 0;
    }
    return 1;
}

static int handle_get_tenants(struct MHD_Connection *connection) {
    const char *sql =
        "SELECT t.id, t.full_name, t.cpf, IFNULL(t.rg,''), IFNULL(t.civil_state,''), IFNULL(t.occupation,''), "
        "IFNULL(t.reference_address,''), IFNULL(t.phone,''), IFNULL(t.email,''), IFNULL(t.unit_id,0), "
        "t.rent_amount, t.due_day, IFNULL(t.contract_start,''), IFNULL(t.contract_end,''), IFNULL(t.notes,''), "
        "t.active, IFNULL(u.unit_number,''), IFNULL(t.profile_photo,''), IFNULL(t.document_front_image,''), "
        "IFNULL(t.document_back_image,'') "
        "FROM tenants t "
        "LEFT JOIN units u ON u.id=t.unit_id "
        "ORDER BY t.active DESC, t.full_name ASC";

    sqlite3_stmt *stmt = NULL;
    if (sqlite3_prepare_v2(g_app.db, sql, -1, &stmt, NULL) != SQLITE_OK) {
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "db_prepare_failed");
    }

    cJSON *root = cJSON_CreateObject();
    cJSON *items = cJSON_AddArrayToObject(root, "items");

    while (sqlite3_step(stmt) == SQLITE_ROW) {
        cJSON *item = cJSON_CreateObject();
        cJSON_AddNumberToObject(item, "id", sqlite3_column_int(stmt, 0));
        cJSON_AddStringToObject(item, "full_name", (const char *) sqlite3_column_text(stmt, 1));
        cJSON_AddStringToObject(item, "cpf", (const char *) sqlite3_column_text(stmt, 2));
        cJSON_AddStringToObject(item, "rg", (const char *) sqlite3_column_text(stmt, 3));
        cJSON_AddStringToObject(item, "civil_state", (const char *) sqlite3_column_text(stmt, 4));
        cJSON_AddStringToObject(item, "occupation", (const char *) sqlite3_column_text(stmt, 5));
        cJSON_AddStringToObject(item, "reference_address", (const char *) sqlite3_column_text(stmt, 6));
        cJSON_AddStringToObject(item, "phone", (const char *) sqlite3_column_text(stmt, 7));
        cJSON_AddStringToObject(item, "email", (const char *) sqlite3_column_text(stmt, 8));
        cJSON_AddNumberToObject(item, "unit_id", sqlite3_column_int(stmt, 9));
        cJSON_AddNumberToObject(item, "rent_amount", sqlite3_column_double(stmt, 10));
        cJSON_AddNumberToObject(item, "due_day", sqlite3_column_int(stmt, 11));
        cJSON_AddStringToObject(item, "contract_start", (const char *) sqlite3_column_text(stmt, 12));
        cJSON_AddStringToObject(item, "contract_end", (const char *) sqlite3_column_text(stmt, 13));
        cJSON_AddStringToObject(item, "notes", (const char *) sqlite3_column_text(stmt, 14));
        cJSON_AddBoolToObject(item, "active", sqlite3_column_int(stmt, 15) == 1);
        cJSON_AddStringToObject(item, "unit_number", (const char *) sqlite3_column_text(stmt, 16));
        cJSON_AddStringToObject(item, "profile_photo", (const char *) sqlite3_column_text(stmt, 17));
        cJSON_AddStringToObject(item, "document_front_image", (const char *) sqlite3_column_text(stmt, 18));
        cJSON_AddStringToObject(item, "document_back_image", (const char *) sqlite3_column_text(stmt, 19));
        cJSON_AddItemToArray(items, item);
    }

    sqlite3_finalize(stmt);
    int ret = send_json(connection, MHD_HTTP_OK, root);
    cJSON_Delete(root);
    return ret;
}

static int handle_create_tenant(struct MHD_Connection *connection, const char *body) {
    cJSON *input = cJSON_Parse(body ? body : "");
    if (!input) {
        return send_error(connection, MHD_HTTP_BAD_REQUEST, "invalid_json");
    }

    const char *full_name = json_string(input, "full_name");
    const char *cpf = json_string(input, "cpf");
    double rent_amount = json_double(input, "rent_amount", -1);
    int due_day = json_int(input, "due_day", -1);
    if (!full_name || !cpf || rent_amount <= 0 || due_day <= 0) {
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_BAD_REQUEST, "full_name_cpf_rent_amount_due_day_required");
    }

    const char *rg = json_string(input, "rg");
    const char *civil_state = json_string(input, "civil_state");
    const char *occupation = json_string(input, "occupation");
    const char *reference_address = json_string(input, "reference_address");
    const char *phone = json_string(input, "phone");
    const char *email = json_string(input, "email");
    int unit_id = json_int(input, "unit_id", 0);
    const char *contract_start = json_string(input, "contract_start");
    const char *contract_end = json_string(input, "contract_end");
    const char *notes = json_string(input, "notes");
    const char *profile_photo = json_string(input, "profile_photo");
    const char *document_front_image = json_string(input, "document_front_image");
    const char *document_back_image = json_string(input, "document_back_image");

    if (unit_id > 0) {
        const char *error_code = NULL;
        if (!validate_unit_assignment(unit_id, 0, 1, &error_code)) {
            cJSON_Delete(input);
            if (error_code && strcmp(error_code, "db_prepare_failed") == 0) {
                return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, error_code);
            }
            if (error_code && strcmp(error_code, "unit_already_assigned") == 0) {
                return send_error(connection, MHD_HTTP_CONFLICT, error_code);
            }
            return send_error(connection, MHD_HTTP_BAD_REQUEST, error_code ? error_code : "unit_invalid");
        }
    }

    sqlite3_stmt *stmt = NULL;
    const char *sql =
        "INSERT INTO tenants(full_name, cpf, rg, civil_state, occupation, reference_address, phone, email, unit_id, "
        "rent_amount, due_day, contract_start, contract_end, notes, profile_photo, document_front_image, "
        "document_back_image, active) "
        "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)";

    if (sqlite3_prepare_v2(g_app.db, sql, -1, &stmt, NULL) != SQLITE_OK) {
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "db_prepare_failed");
    }

    sqlite3_bind_text(stmt, 1, full_name, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 2, cpf, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 3, rg ? rg : "", -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 4, civil_state ? civil_state : "", -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 5, occupation ? occupation : "", -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 6, reference_address ? reference_address : "", -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 7, phone ? phone : "", -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 8, email ? email : "", -1, SQLITE_TRANSIENT);
    if (unit_id > 0) {
        sqlite3_bind_int(stmt, 9, unit_id);
    } else {
        sqlite3_bind_null(stmt, 9);
    }
    sqlite3_bind_double(stmt, 10, rent_amount);
    sqlite3_bind_int(stmt, 11, due_day);
    sqlite3_bind_text(stmt, 12, contract_start ? contract_start : "", -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 13, contract_end ? contract_end : "", -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 14, notes ? notes : "", -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 15, profile_photo ? profile_photo : "", -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 16, document_front_image ? document_front_image : "", -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 17, document_back_image ? document_back_image : "", -1, SQLITE_TRANSIENT);

    if (sqlite3_step(stmt) != SQLITE_DONE) {
        const char *err = sqlite3_errmsg(g_app.db);
        sqlite3_finalize(stmt);
        cJSON_Delete(input);
        if (strstr(err, "UNIQUE")) {
            return send_error(connection, MHD_HTTP_CONFLICT, "cpf_already_exists");
        }
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "tenant_insert_failed");
    }
    sqlite3_finalize(stmt);

    int tenant_id = (int) sqlite3_last_insert_rowid(g_app.db);
    if (unit_id > 0) {
        db_exec_fmt("UPDATE units SET status='occupied', current_tenant_id=%d, base_rent=%.2f WHERE id=%d", tenant_id,
                    rent_amount, unit_id);
        char month[MONTH_LEN];
        current_month(month);
        ensure_charge_for_tenant(tenant_id, unit_id, rent_amount, due_day, month);
    }

    cJSON *out = cJSON_CreateObject();
    cJSON_AddNumberToObject(out, "id", tenant_id);
    cJSON_AddStringToObject(out, "message", "tenant_created");
    int ret = send_json(connection, MHD_HTTP_CREATED, out);
    cJSON_Delete(out);
    cJSON_Delete(input);
    return ret;
}

static int fetch_tenant(int tenant_id, cJSON **tenant_out) {
    const char *sql =
        "SELECT id, full_name, cpf, IFNULL(rg,''), IFNULL(civil_state,''), IFNULL(occupation,''), IFNULL(reference_address,''), "
        "IFNULL(phone,''), IFNULL(email,''), IFNULL(unit_id,0), rent_amount, due_day, IFNULL(contract_start,''), "
        "IFNULL(contract_end,''), IFNULL(notes,''), active, IFNULL(profile_photo,''), IFNULL(document_front_image,''), "
        "IFNULL(document_back_image,'') FROM tenants WHERE id=?";
    sqlite3_stmt *stmt = NULL;
    if (sqlite3_prepare_v2(g_app.db, sql, -1, &stmt, NULL) != SQLITE_OK) {
        return 0;
    }
    sqlite3_bind_int(stmt, 1, tenant_id);

    int ok = 0;
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        cJSON *t = cJSON_CreateObject();
        cJSON_AddNumberToObject(t, "id", sqlite3_column_int(stmt, 0));
        cJSON_AddStringToObject(t, "full_name", (const char *) sqlite3_column_text(stmt, 1));
        cJSON_AddStringToObject(t, "cpf", (const char *) sqlite3_column_text(stmt, 2));
        cJSON_AddStringToObject(t, "rg", (const char *) sqlite3_column_text(stmt, 3));
        cJSON_AddStringToObject(t, "civil_state", (const char *) sqlite3_column_text(stmt, 4));
        cJSON_AddStringToObject(t, "occupation", (const char *) sqlite3_column_text(stmt, 5));
        cJSON_AddStringToObject(t, "reference_address", (const char *) sqlite3_column_text(stmt, 6));
        cJSON_AddStringToObject(t, "phone", (const char *) sqlite3_column_text(stmt, 7));
        cJSON_AddStringToObject(t, "email", (const char *) sqlite3_column_text(stmt, 8));
        cJSON_AddNumberToObject(t, "unit_id", sqlite3_column_int(stmt, 9));
        cJSON_AddNumberToObject(t, "rent_amount", sqlite3_column_double(stmt, 10));
        cJSON_AddNumberToObject(t, "due_day", sqlite3_column_int(stmt, 11));
        cJSON_AddStringToObject(t, "contract_start", (const char *) sqlite3_column_text(stmt, 12));
        cJSON_AddStringToObject(t, "contract_end", (const char *) sqlite3_column_text(stmt, 13));
        cJSON_AddStringToObject(t, "notes", (const char *) sqlite3_column_text(stmt, 14));
        cJSON_AddBoolToObject(t, "active", sqlite3_column_int(stmt, 15) == 1);
        cJSON_AddStringToObject(t, "profile_photo", (const char *) sqlite3_column_text(stmt, 16));
        cJSON_AddStringToObject(t, "document_front_image", (const char *) sqlite3_column_text(stmt, 17));
        cJSON_AddStringToObject(t, "document_back_image", (const char *) sqlite3_column_text(stmt, 18));
        *tenant_out = t;
        ok = 1;
    }
    sqlite3_finalize(stmt);
    return ok;
}

static int handle_update_tenant(struct MHD_Connection *connection, int tenant_id, const char *body) {
    cJSON *input = cJSON_Parse(body ? body : "");
    if (!input) {
        return send_error(connection, MHD_HTTP_BAD_REQUEST, "invalid_json");
    }

    cJSON *tenant = NULL;
    if (!fetch_tenant(tenant_id, &tenant)) {
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_NOT_FOUND, "tenant_not_found");
    }

    const char *full_name = json_string(input, "full_name");
    const char *cpf = json_string(input, "cpf");
    const char *rg = json_string(input, "rg");
    const char *civil_state = json_string(input, "civil_state");
    const char *occupation = json_string(input, "occupation");
    const char *reference_address = json_string(input, "reference_address");
    const char *phone = json_string(input, "phone");
    const char *email = json_string(input, "email");
    int unit_id = json_int(input, "unit_id", -99999);
    double rent_amount = json_double(input, "rent_amount", -99999);
    int due_day = json_int(input, "due_day", -99999);
    const char *contract_start = json_string(input, "contract_start");
    const char *contract_end = json_string(input, "contract_end");
    const char *notes = json_string(input, "notes");
    const char *profile_photo = json_string(input, "profile_photo");
    const char *document_front_image = json_string(input, "document_front_image");
    const char *document_back_image = json_string(input, "document_back_image");
    int active = json_int(input, "active", -99999);

    const char *curr_full_name = cJSON_GetObjectItem(tenant, "full_name")->valuestring;
    const char *curr_cpf = cJSON_GetObjectItem(tenant, "cpf")->valuestring;
    const char *curr_rg = cJSON_GetObjectItem(tenant, "rg")->valuestring;
    const char *curr_civil = cJSON_GetObjectItem(tenant, "civil_state")->valuestring;
    const char *curr_occ = cJSON_GetObjectItem(tenant, "occupation")->valuestring;
    const char *curr_ref = cJSON_GetObjectItem(tenant, "reference_address")->valuestring;
    const char *curr_phone = cJSON_GetObjectItem(tenant, "phone")->valuestring;
    const char *curr_email = cJSON_GetObjectItem(tenant, "email")->valuestring;
    int curr_unit = cJSON_GetObjectItem(tenant, "unit_id")->valueint;
    double curr_rent = cJSON_GetObjectItem(tenant, "rent_amount")->valuedouble;
    int curr_due = cJSON_GetObjectItem(tenant, "due_day")->valueint;
    const char *curr_start = cJSON_GetObjectItem(tenant, "contract_start")->valuestring;
    const char *curr_end = cJSON_GetObjectItem(tenant, "contract_end")->valuestring;
    const char *curr_notes = cJSON_GetObjectItem(tenant, "notes")->valuestring;
    const char *curr_profile_photo = cJSON_GetObjectItem(tenant, "profile_photo")->valuestring;
    const char *curr_document_front_image = cJSON_GetObjectItem(tenant, "document_front_image")->valuestring;
    const char *curr_document_back_image = cJSON_GetObjectItem(tenant, "document_back_image")->valuestring;
    int curr_active = cJSON_IsTrue(cJSON_GetObjectItem(tenant, "active")) ? 1 : 0;

    int new_unit = unit_id == -99999 ? curr_unit : unit_id;
    double new_rent = rent_amount == -99999 ? curr_rent : rent_amount;
    int new_due = due_day == -99999 ? curr_due : due_day;
    int new_active = active == -99999 ? curr_active : (active ? 1 : 0);
    if (!new_active) {
        new_unit = 0;
    }

    if (new_unit > 0) {
        const char *error_code = NULL;
        if (!validate_unit_assignment(new_unit, tenant_id, 1, &error_code)) {
            cJSON_Delete(tenant);
            cJSON_Delete(input);
            if (error_code && strcmp(error_code, "db_prepare_failed") == 0) {
                return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, error_code);
            }
            if (error_code && strcmp(error_code, "unit_already_assigned") == 0) {
                return send_error(connection, MHD_HTTP_CONFLICT, error_code);
            }
            return send_error(connection, MHD_HTTP_BAD_REQUEST, error_code ? error_code : "unit_invalid");
        }
    }

    sqlite3_stmt *stmt = NULL;
    const char *sql =
        "UPDATE tenants SET full_name=?, cpf=?, rg=?, civil_state=?, occupation=?, reference_address=?, phone=?, email=?, "
        "unit_id=?, rent_amount=?, due_day=?, contract_start=?, contract_end=?, notes=?, profile_photo=?, "
        "document_front_image=?, document_back_image=?, active=? WHERE id=?";

    if (sqlite3_prepare_v2(g_app.db, sql, -1, &stmt, NULL) != SQLITE_OK) {
        cJSON_Delete(tenant);
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "db_prepare_failed");
    }

    sqlite3_bind_text(stmt, 1, full_name ? full_name : curr_full_name, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 2, cpf ? cpf : curr_cpf, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 3, rg ? rg : curr_rg, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 4, civil_state ? civil_state : curr_civil, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 5, occupation ? occupation : curr_occ, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 6, reference_address ? reference_address : curr_ref, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 7, phone ? phone : curr_phone, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 8, email ? email : curr_email, -1, SQLITE_TRANSIENT);
    if (new_unit > 0) {
        sqlite3_bind_int(stmt, 9, new_unit);
    } else {
        sqlite3_bind_null(stmt, 9);
    }
    sqlite3_bind_double(stmt, 10, new_rent);
    sqlite3_bind_int(stmt, 11, new_due);
    sqlite3_bind_text(stmt, 12, contract_start ? contract_start : curr_start, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 13, contract_end ? contract_end : curr_end, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 14, notes ? notes : curr_notes, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 15, profile_photo ? profile_photo : curr_profile_photo, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 16, document_front_image ? document_front_image : curr_document_front_image, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 17, document_back_image ? document_back_image : curr_document_back_image, -1, SQLITE_TRANSIENT);
    sqlite3_bind_int(stmt, 18, new_active);
    sqlite3_bind_int(stmt, 19, tenant_id);

    int ok = sqlite3_step(stmt) == SQLITE_DONE;
    sqlite3_finalize(stmt);
    cJSON_Delete(tenant);
    cJSON_Delete(input);

    if (!ok) {
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "tenant_update_failed");
    }

    if (curr_unit > 0 && curr_unit != new_unit) {
        db_exec_fmt("UPDATE units SET status='vacant', current_tenant_id=NULL WHERE id=%d", curr_unit);
    }
    if (new_unit > 0) {
        db_exec_fmt("UPDATE units SET status='occupied', current_tenant_id=%d, base_rent=%.2f WHERE id=%d", tenant_id, new_rent,
                    new_unit);
        char month[MONTH_LEN];
        current_month(month);
        ensure_charge_for_tenant(tenant_id, new_unit, new_rent, new_due, month);
    }

    cJSON *out = cJSON_CreateObject();
    cJSON_AddStringToObject(out, "message", "tenant_updated");
    int ret = send_json(connection, MHD_HTTP_OK, out);
    cJSON_Delete(out);
    return ret;
}

static int is_truthy(const char *value) {
    if (!value) {
        return 0;
    }
    if (strcmp(value, "1") == 0 || strcmp(value, "true") == 0 || strcmp(value, "TRUE") == 0 ||
        strcmp(value, "yes") == 0 || strcmp(value, "YES") == 0) {
        return 1;
    }
    return 0;
}

static int handle_delete_tenant(struct MHD_Connection *connection, int tenant_id, int permanent) {
    sqlite3_stmt *stmt = NULL;
    int unit_id = 0;
    int exists = 0;

    if (sqlite3_prepare_v2(g_app.db, "SELECT IFNULL(unit_id,0) FROM tenants WHERE id=?", -1, &stmt, NULL) != SQLITE_OK) {
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "db_prepare_failed");
    }
    sqlite3_bind_int(stmt, 1, tenant_id);
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        unit_id = sqlite3_column_int(stmt, 0);
        exists = 1;
    } else {
        sqlite3_finalize(stmt);
        return send_error(connection, MHD_HTTP_NOT_FOUND, "tenant_not_found");
    }
    sqlite3_finalize(stmt);
    if (!exists) {
        return send_error(connection, MHD_HTTP_NOT_FOUND, "tenant_not_found");
    }

    if (!permanent) {
        if (!db_exec_fmt("UPDATE tenants SET active=0, unit_id=NULL WHERE id=%d", tenant_id)) {
            return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "tenant_delete_failed");
        }
        if (unit_id > 0) {
            db_exec_fmt("UPDATE units SET status='vacant', current_tenant_id=NULL WHERE id=%d", unit_id);
        }

        cJSON *out = cJSON_CreateObject();
        cJSON_AddStringToObject(out, "message", "tenant_moved_to_inactive");
        int ret = send_json(connection, MHD_HTTP_OK, out);
        cJSON_Delete(out);
        return ret;
    }

    if (!db_exec("BEGIN TRANSACTION")) {
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "tenant_delete_failed");
    }

    if (sqlite3_prepare_v2(g_app.db, "SELECT file_path FROM documents WHERE tenant_id=?", -1, &stmt, NULL) != SQLITE_OK) {
        db_exec("ROLLBACK");
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "db_prepare_failed");
    }
    sqlite3_bind_int(stmt, 1, tenant_id);
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        const unsigned char *path = sqlite3_column_text(stmt, 0);
        if (path && path[0] != '\0') {
            remove((const char *) path);
        }
    }
    sqlite3_finalize(stmt);

    if (!db_exec_fmt("DELETE FROM documents WHERE tenant_id=%d", tenant_id) ||
        !db_exec_fmt("DELETE FROM rent_charges WHERE tenant_id=%d", tenant_id) ||
        !db_exec_fmt("DELETE FROM notifications WHERE type='contract_expiring' AND related_id=%d", tenant_id) ||
        !db_exec_fmt("UPDATE units SET status='vacant', current_tenant_id=NULL WHERE current_tenant_id=%d", tenant_id) ||
        !db_exec_fmt("DELETE FROM tenants WHERE id=%d", tenant_id)) {
        db_exec("ROLLBACK");
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "tenant_permanent_delete_failed");
    }

    if (!db_exec("COMMIT")) {
        db_exec("ROLLBACK");
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "tenant_permanent_delete_failed");
    }

    if (unit_id > 0) {
        db_exec_fmt("UPDATE units SET status='vacant', current_tenant_id=NULL WHERE id=%d", unit_id);
    }

    cJSON *out = cJSON_CreateObject();
    cJSON_AddStringToObject(out, "message", "tenant_permanently_deleted");
    int ret = send_json(connection, MHD_HTTP_OK, out);
    cJSON_Delete(out);
    return ret;
}

static const char *payment_status_for_unit(int is_active, const char *unit_status, int has_tenant, const char *charge_status,
                                           const char *due_date) {
    if (!is_active) {
        return "disabled";
    }
    if (!has_tenant || strcmp(unit_status, "vacant") == 0) {
        return "vacant";
    }
    if (!charge_status || charge_status[0] == '\0') {
        return "unpaid";
    }
    if (strcmp(charge_status, "paid") == 0) {
        return "paid";
    }
    if (strcmp(charge_status, "overdue") == 0) {
        return "overdue";
    }
    if (due_date && due_date[0] != '\0') {
        int days = days_until_date(due_date);
        if (days >= 0 && days <= 4) {
            return "due_soon";
        }
    }
    return "unpaid";
}

static int handle_get_units(struct MHD_Connection *connection, const char *month) {
    const char *selected_month = month;
    char generated_month[MONTH_LEN];
    if (!selected_month || strlen(selected_month) != 7) {
        current_month(generated_month);
        selected_month = generated_month;
    }

    const char *sql =
        "SELECT u.id, u.unit_number, u.status, u.is_active, IFNULL(u.inactive_reason,''), IFNULL(u.available_from,''), "
        "u.base_rent, IFNULL(t.id,0), IFNULL(t.full_name,''), IFNULL(rc.status,''), IFNULL(rc.amount,0), IFNULL(rc.due_date,'') "
        "FROM units u "
        "LEFT JOIN tenants t ON t.id=u.current_tenant_id AND t.active=1 "
        "LEFT JOIN rent_charges rc ON rc.tenant_id=t.id AND rc.month=? "
        "ORDER BY CAST(u.unit_number AS INTEGER) ASC, u.unit_number ASC";

    sqlite3_stmt *stmt = NULL;
    if (sqlite3_prepare_v2(g_app.db, sql, -1, &stmt, NULL) != SQLITE_OK) {
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "db_prepare_failed");
    }
    sqlite3_bind_text(stmt, 1, selected_month, -1, SQLITE_TRANSIENT);

    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "month", selected_month);
    cJSON *items = cJSON_AddArrayToObject(root, "items");

    while (sqlite3_step(stmt) == SQLITE_ROW) {
        const char *unit_status = (const char *) sqlite3_column_text(stmt, 2);
        int is_active = sqlite3_column_int(stmt, 3);
        int tenant_id = sqlite3_column_int(stmt, 7);
        const char *charge_status = (const char *) sqlite3_column_text(stmt, 9);
        const char *due_date = (const char *) sqlite3_column_text(stmt, 11);
        const char *payment_status = payment_status_for_unit(is_active, unit_status, tenant_id > 0, charge_status, due_date);

        cJSON *item = cJSON_CreateObject();
        cJSON_AddNumberToObject(item, "id", sqlite3_column_int(stmt, 0));
        cJSON_AddStringToObject(item, "unit_number", (const char *) sqlite3_column_text(stmt, 1));
        cJSON_AddStringToObject(item, "status", unit_status);
        cJSON_AddBoolToObject(item, "is_active", is_active == 1);
        cJSON_AddStringToObject(item, "inactive_reason", (const char *) sqlite3_column_text(stmt, 4));
        cJSON_AddStringToObject(item, "available_from", (const char *) sqlite3_column_text(stmt, 5));
        cJSON_AddNumberToObject(item, "base_rent", sqlite3_column_double(stmt, 6));
        cJSON_AddNumberToObject(item, "tenant_id", tenant_id);
        cJSON_AddStringToObject(item, "tenant_name", (const char *) sqlite3_column_text(stmt, 8));
        cJSON_AddStringToObject(item, "payment_status", payment_status);
        cJSON_AddNumberToObject(item, "month_amount", sqlite3_column_double(stmt, 10));
        cJSON_AddStringToObject(item, "due_date", due_date);
        cJSON_AddItemToArray(items, item);
    }
    sqlite3_finalize(stmt);

    int ret = send_json(connection, MHD_HTTP_OK, root);
    cJSON_Delete(root);
    return ret;
}

static int handle_get_unit_detail(struct MHD_Connection *connection, int unit_id) {
    sqlite3_stmt *stmt = NULL;

    const char *sql_unit =
        "SELECT u.id, u.unit_number, u.status, u.is_active, IFNULL(u.inactive_reason,''), IFNULL(u.available_from,''), "
        "u.base_rent, IFNULL(t.id,0), IFNULL(t.full_name,''), IFNULL(t.rent_amount,0), IFNULL(t.due_day,5), IFNULL(t.cpf,'') "
        "FROM units u "
        "LEFT JOIN tenants t ON t.id=u.current_tenant_id "
        "WHERE u.id=?";
    if (sqlite3_prepare_v2(g_app.db, sql_unit, -1, &stmt, NULL) != SQLITE_OK) {
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "db_prepare_failed");
    }
    sqlite3_bind_int(stmt, 1, unit_id);

    if (sqlite3_step(stmt) != SQLITE_ROW) {
        sqlite3_finalize(stmt);
        return send_error(connection, MHD_HTTP_NOT_FOUND, "unit_not_found");
    }

    int tenant_id = sqlite3_column_int(stmt, 7);
    cJSON *root = cJSON_CreateObject();
    cJSON_AddNumberToObject(root, "id", sqlite3_column_int(stmt, 0));
    cJSON_AddStringToObject(root, "unit_number", (const char *) sqlite3_column_text(stmt, 1));
    cJSON_AddStringToObject(root, "status", (const char *) sqlite3_column_text(stmt, 2));
    cJSON_AddBoolToObject(root, "is_active", sqlite3_column_int(stmt, 3) == 1);
    cJSON_AddStringToObject(root, "inactive_reason", (const char *) sqlite3_column_text(stmt, 4));
    cJSON_AddStringToObject(root, "available_from", (const char *) sqlite3_column_text(stmt, 5));
    cJSON_AddNumberToObject(root, "base_rent", sqlite3_column_double(stmt, 6));
    cJSON_AddNumberToObject(root, "tenant_id", tenant_id);
    cJSON_AddStringToObject(root, "tenant_name", (const char *) sqlite3_column_text(stmt, 8));
    cJSON_AddNumberToObject(root, "tenant_rent", sqlite3_column_double(stmt, 9));
    cJSON_AddNumberToObject(root, "due_day", sqlite3_column_int(stmt, 10));
    cJSON_AddStringToObject(root, "tenant_cpf", (const char *) sqlite3_column_text(stmt, 11));
    sqlite3_finalize(stmt);

    cJSON *payments = cJSON_AddArrayToObject(root, "payment_history");
    if (unit_id > 0) {
        const char *sql_pay =
            "SELECT rc.month, rc.amount, rc.status, rc.due_date, IFNULL(rc.paid_at,''), rc.late_fee, rc.tenant_id, "
            "IFNULL(t.full_name,'') "
            "FROM rent_charges rc "
            "LEFT JOIN tenants t ON t.id=rc.tenant_id "
            "WHERE rc.unit_id=? ORDER BY rc.month DESC LIMIT 12";
        if (sqlite3_prepare_v2(g_app.db, sql_pay, -1, &stmt, NULL) == SQLITE_OK) {
            sqlite3_bind_int(stmt, 1, unit_id);
            while (sqlite3_step(stmt) == SQLITE_ROW) {
                cJSON *row = cJSON_CreateObject();
                cJSON_AddStringToObject(row, "month", (const char *) sqlite3_column_text(stmt, 0));
                cJSON_AddNumberToObject(row, "amount", sqlite3_column_double(stmt, 1));
                cJSON_AddStringToObject(row, "status", (const char *) sqlite3_column_text(stmt, 2));
                cJSON_AddStringToObject(row, "due_date", (const char *) sqlite3_column_text(stmt, 3));
                cJSON_AddStringToObject(row, "paid_at", (const char *) sqlite3_column_text(stmt, 4));
                cJSON_AddNumberToObject(row, "late_fee", sqlite3_column_double(stmt, 5));
                cJSON_AddNumberToObject(row, "tenant_id", sqlite3_column_int(stmt, 6));
                cJSON_AddStringToObject(row, "tenant_name", (const char *) sqlite3_column_text(stmt, 7));
                cJSON_AddItemToArray(payments, row);
            }
        }
        sqlite3_finalize(stmt);
    }

    cJSON *maintenance = cJSON_AddArrayToObject(root, "maintenance_history");
    const char *sql_mt =
        "SELECT id, description, ticket_date, cost, status, IFNULL(image_path,'') FROM maintenance_tickets "
        "WHERE unit_id=? ORDER BY ticket_date DESC";
    if (sqlite3_prepare_v2(g_app.db, sql_mt, -1, &stmt, NULL) == SQLITE_OK) {
        sqlite3_bind_int(stmt, 1, unit_id);
        while (sqlite3_step(stmt) == SQLITE_ROW) {
            cJSON *row = cJSON_CreateObject();
            cJSON_AddNumberToObject(row, "id", sqlite3_column_int(stmt, 0));
            cJSON_AddStringToObject(row, "description", (const char *) sqlite3_column_text(stmt, 1));
            cJSON_AddStringToObject(row, "ticket_date", (const char *) sqlite3_column_text(stmt, 2));
            cJSON_AddNumberToObject(row, "cost", sqlite3_column_double(stmt, 3));
            cJSON_AddStringToObject(row, "status", (const char *) sqlite3_column_text(stmt, 4));
            cJSON_AddStringToObject(row, "image_path", (const char *) sqlite3_column_text(stmt, 5));
            cJSON_AddItemToArray(maintenance, row);
        }
    }
    sqlite3_finalize(stmt);

    int ret = send_json(connection, MHD_HTTP_OK, root);
    cJSON_Delete(root);
    return ret;
}

static int handle_create_unit(struct MHD_Connection *connection, const char *body) {
    cJSON *input = cJSON_Parse(body ? body : "");
    if (!input) {
        return send_error(connection, MHD_HTTP_BAD_REQUEST, "invalid_json");
    }

    const char *unit_number = json_string(input, "unit_number");
    if (!unit_number || unit_number[0] == '\0') {
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_BAD_REQUEST, "unit_number_required");
    }

    int property_id = json_int(input, "property_id", 1);
    double base_rent = json_double(input, "base_rent", 0);
    const char *status = json_string(input, "status");
    if (!status || status[0] == '\0') {
        status = "vacant";
    }
    int is_active = json_bool_int(input, "is_active", 1);
    const char *inactive_reason = json_string(input, "inactive_reason");
    const char *available_from = json_string(input, "available_from");

    if (property_id <= 0) {
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_BAD_REQUEST, "invalid_property_id");
    }

    if (!is_active) {
        status = "vacant";
    }

    sqlite3_stmt *stmt = NULL;
    const char *sql =
        "INSERT INTO units(property_id, unit_number, status, is_active, inactive_reason, available_from, base_rent) "
        "VALUES(?,?,?,?,?,?,?)";

    if (sqlite3_prepare_v2(g_app.db, sql, -1, &stmt, NULL) != SQLITE_OK) {
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "db_prepare_failed");
    }

    sqlite3_bind_int(stmt, 1, property_id);
    sqlite3_bind_text(stmt, 2, unit_number, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 3, status, -1, SQLITE_TRANSIENT);
    sqlite3_bind_int(stmt, 4, is_active ? 1 : 0);
    sqlite3_bind_text(stmt, 5, inactive_reason ? inactive_reason : "", -1, SQLITE_TRANSIENT);
    if (available_from && available_from[0] != '\0') {
        sqlite3_bind_text(stmt, 6, available_from, -1, SQLITE_TRANSIENT);
    } else {
        sqlite3_bind_null(stmt, 6);
    }
    sqlite3_bind_double(stmt, 7, base_rent < 0 ? 0 : base_rent);

    if (sqlite3_step(stmt) != SQLITE_DONE) {
        const char *err = sqlite3_errmsg(g_app.db);
        sqlite3_finalize(stmt);
        cJSON_Delete(input);
        if (strstr(err, "UNIQUE")) {
            return send_error(connection, MHD_HTTP_CONFLICT, "unit_number_already_exists");
        }
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "unit_create_failed");
    }
    sqlite3_finalize(stmt);

    db_exec_fmt("UPDATE properties SET total_units=(SELECT COUNT(*) FROM units WHERE property_id=%d) WHERE id=%d", property_id,
                property_id);

    cJSON *out = cJSON_CreateObject();
    cJSON_AddNumberToObject(out, "id", sqlite3_last_insert_rowid(g_app.db));
    cJSON_AddStringToObject(out, "message", "unit_created");
    int ret = send_json(connection, MHD_HTTP_CREATED, out);
    cJSON_Delete(out);
    cJSON_Delete(input);
    return ret;
}

static int handle_update_unit(struct MHD_Connection *connection, int unit_id, const char *body) {
    cJSON *input = cJSON_Parse(body ? body : "");
    if (!input) {
        return send_error(connection, MHD_HTTP_BAD_REQUEST, "invalid_json");
    }

    sqlite3_stmt *stmt = NULL;
    int current_tenant_id = 0;
    int current_is_active = 1;
    if (sqlite3_prepare_v2(g_app.db, "SELECT IFNULL(current_tenant_id,0), is_active FROM units WHERE id=?", -1, &stmt, NULL) !=
        SQLITE_OK) {
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "db_prepare_failed");
    }
    sqlite3_bind_int(stmt, 1, unit_id);
    if (sqlite3_step(stmt) != SQLITE_ROW) {
        sqlite3_finalize(stmt);
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_NOT_FOUND, "unit_not_found");
    }
    current_tenant_id = sqlite3_column_int(stmt, 0);
    current_is_active = sqlite3_column_int(stmt, 1);
    sqlite3_finalize(stmt);

    const char *unit_number = json_string(input, "unit_number");
    const char *status = json_string(input, "status");
    const char *inactive_reason = json_string(input, "inactive_reason");
    const char *available_from = json_string(input, "available_from");
    double base_rent = json_double(input, "base_rent", -1);
    int tenant_id = json_int(input, "tenant_id", -99999);
    int requested_is_active = json_bool_int(input, "is_active", -1);
    int effective_is_active = requested_is_active >= 0 ? requested_is_active : current_is_active;

    if (unit_number && unit_number[0] != '\0') {
        if (!db_exec_fmt("UPDATE units SET unit_number='%q' WHERE id=%d", unit_number, unit_id)) {
            cJSON_Delete(input);
            return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "unit_update_failed");
        }
    }

    if (status) {
        if (!db_exec_fmt("UPDATE units SET status='%q' WHERE id=%d", status, unit_id)) {
            cJSON_Delete(input);
            return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "unit_update_failed");
        }
    }
    if (requested_is_active >= 0) {
        if (!db_exec_fmt("UPDATE units SET is_active=%d WHERE id=%d", effective_is_active ? 1 : 0, unit_id)) {
            cJSON_Delete(input);
            return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "unit_update_failed");
        }
    }
    if (inactive_reason) {
        if (!db_exec_fmt("UPDATE units SET inactive_reason='%q' WHERE id=%d", inactive_reason, unit_id)) {
            cJSON_Delete(input);
            return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "unit_update_failed");
        }
    }
    if (available_from) {
        if (available_from[0] == '\0') {
            if (!db_exec_fmt("UPDATE units SET available_from=NULL WHERE id=%d", unit_id)) {
                cJSON_Delete(input);
                return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "unit_update_failed");
            }
        } else {
            if (!db_exec_fmt("UPDATE units SET available_from='%q' WHERE id=%d", available_from, unit_id)) {
                cJSON_Delete(input);
                return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "unit_update_failed");
            }
        }
    }
    if (base_rent >= 0) {
        if (!db_exec_fmt("UPDATE units SET base_rent=%.2f WHERE id=%d", base_rent, unit_id)) {
            cJSON_Delete(input);
            return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "unit_update_failed");
        }
    }

    if (!effective_is_active) {
        tenant_id = 0;
        if (!db_exec_fmt("UPDATE units SET status='vacant' WHERE id=%d", unit_id)) {
            cJSON_Delete(input);
            return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "unit_update_failed");
        }
    }

    if (status && strcmp(status, "vacant") == 0) {
        tenant_id = 0;
    }

    if (tenant_id >= 0 && tenant_id != -99999) {
        if (tenant_id == 0) {
            if (!db_exec_fmt("UPDATE units SET current_tenant_id=NULL, status='vacant' WHERE id=%d", unit_id) ||
                !db_exec_fmt("UPDATE tenants SET unit_id=NULL WHERE unit_id=%d", unit_id)) {
                cJSON_Delete(input);
                return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "unit_update_failed");
            }
        } else {
            if (!effective_is_active) {
                cJSON_Delete(input);
                return send_error(connection, MHD_HTTP_BAD_REQUEST, "unit_disabled");
            }

            if (sqlite3_prepare_v2(g_app.db, "SELECT id FROM tenants WHERE id=? AND active=1", -1, &stmt, NULL) != SQLITE_OK) {
                cJSON_Delete(input);
                return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "db_prepare_failed");
            }
            sqlite3_bind_int(stmt, 1, tenant_id);
            if (sqlite3_step(stmt) != SQLITE_ROW) {
                sqlite3_finalize(stmt);
                cJSON_Delete(input);
                return send_error(connection, MHD_HTTP_BAD_REQUEST, "tenant_not_found_or_inactive");
            }
            sqlite3_finalize(stmt);

            if (!db_exec_fmt("UPDATE units SET current_tenant_id=NULL, status='vacant' WHERE current_tenant_id=%d", tenant_id) ||
                !db_exec_fmt("UPDATE tenants SET unit_id=NULL WHERE unit_id=%d", unit_id) ||
                !db_exec_fmt("UPDATE units SET current_tenant_id=%d, status='occupied' WHERE id=%d", tenant_id, unit_id) ||
                !db_exec_fmt("UPDATE tenants SET unit_id=%d WHERE id=%d", unit_id, tenant_id)) {
                cJSON_Delete(input);
                return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "unit_update_failed");
            }
        }
    } else if (!effective_is_active && current_tenant_id > 0) {
        if (!db_exec_fmt("UPDATE units SET current_tenant_id=NULL, status='vacant' WHERE id=%d", unit_id) ||
            !db_exec_fmt("UPDATE tenants SET unit_id=NULL WHERE unit_id=%d", unit_id)) {
            cJSON_Delete(input);
            return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "unit_update_failed");
        }
    }

    if (effective_is_active && (!inactive_reason || inactive_reason[0] == '\0')) {
        db_exec_fmt("UPDATE units SET inactive_reason='' WHERE id=%d", unit_id);
    }

    if (effective_is_active && status && strcmp(status, "occupied") != 0 && strcmp(status, "vacant") != 0) {
        db_exec_fmt("UPDATE units SET status='%q' WHERE id=%d", status, unit_id);
    }

    cJSON_Delete(input);
    cJSON *out = cJSON_CreateObject();
    cJSON_AddStringToObject(out, "message", "unit_updated");
    int ret = send_json(connection, MHD_HTTP_OK, out);
    cJSON_Delete(out);
    return ret;
}

static void add_financial_overview_fields(cJSON *obj, const char *month) {
    sqlite3_stmt *stmt = NULL;

    double expected = 0;
    double collected = 0;
    double overdue = 0;
    int paid_tenants = 0;
    int overdue_tenants = 0;

    const char *sql =
        "SELECT "
        "IFNULL(SUM(rc.amount),0),"
        "IFNULL(SUM(CASE WHEN rc.status='paid' THEN rc.amount + rc.late_fee ELSE 0 END),0),"
        "IFNULL(SUM(CASE WHEN rc.status='overdue' THEN rc.amount + rc.late_fee ELSE 0 END),0),"
        "COUNT(DISTINCT CASE WHEN rc.status='paid' THEN rc.tenant_id END),"
        "COUNT(DISTINCT CASE WHEN rc.status='overdue' THEN rc.tenant_id END)"
        "FROM rent_charges rc "
        "JOIN units u ON u.id=rc.unit_id "
        "WHERE rc.month=? AND u.is_active=1";

    if (sqlite3_prepare_v2(g_app.db, sql, -1, &stmt, NULL) == SQLITE_OK) {
        sqlite3_bind_text(stmt, 1, month, -1, SQLITE_TRANSIENT);
        if (sqlite3_step(stmt) == SQLITE_ROW) {
            expected = sqlite3_column_double(stmt, 0);
            collected = sqlite3_column_double(stmt, 1);
            overdue = sqlite3_column_double(stmt, 2);
            paid_tenants = sqlite3_column_int(stmt, 3);
            overdue_tenants = sqlite3_column_int(stmt, 4);
        }
    }
    sqlite3_finalize(stmt);

    int total_tenants = 0;
    int vacant_units = 0;
    int disabled_units = 0;
    int expiring_contracts = 0;

    if (sqlite3_prepare_v2(g_app.db, "SELECT COUNT(*) FROM tenants WHERE active=1", -1, &stmt, NULL) == SQLITE_OK) {
        if (sqlite3_step(stmt) == SQLITE_ROW) {
            total_tenants = sqlite3_column_int(stmt, 0);
        }
    }
    sqlite3_finalize(stmt);

    if (sqlite3_prepare_v2(g_app.db, "SELECT COUNT(*) FROM units WHERE status='vacant' AND is_active=1", -1, &stmt, NULL) ==
        SQLITE_OK) {
        if (sqlite3_step(stmt) == SQLITE_ROW) {
            vacant_units = sqlite3_column_int(stmt, 0);
        }
    }
    sqlite3_finalize(stmt);

    if (sqlite3_prepare_v2(g_app.db, "SELECT COUNT(*) FROM units WHERE is_active=0", -1, &stmt, NULL) == SQLITE_OK) {
        if (sqlite3_step(stmt) == SQLITE_ROW) {
            disabled_units = sqlite3_column_int(stmt, 0);
        }
    }
    sqlite3_finalize(stmt);

    if (sqlite3_prepare_v2(g_app.db,
                           "SELECT COUNT(*) FROM tenants WHERE active=1 AND contract_end >= date('now') AND contract_end <= date('now','+30 day')",
                           -1, &stmt, NULL) == SQLITE_OK) {
        if (sqlite3_step(stmt) == SQLITE_ROW) {
            expiring_contracts = sqlite3_column_int(stmt, 0);
        }
    }
    sqlite3_finalize(stmt);

    char prev[MONTH_LEN];
    previous_month(month, prev);

    double prev_collected = 0;
    if (sqlite3_prepare_v2(g_app.db,
                           "SELECT IFNULL(SUM(rc.amount + rc.late_fee),0) "
                           "FROM rent_charges rc JOIN units u ON u.id=rc.unit_id "
                           "WHERE rc.month=? AND rc.status='paid' AND u.is_active=1",
                           -1, &stmt, NULL) == SQLITE_OK) {
        sqlite3_bind_text(stmt, 1, prev, -1, SQLITE_TRANSIENT);
        if (sqlite3_step(stmt) == SQLITE_ROW) {
            prev_collected = sqlite3_column_double(stmt, 0);
        }
    }
    sqlite3_finalize(stmt);

    double collection_pct = expected > 0 ? (collected / expected) * 100.0 : 0;
    double rev_change_pct = prev_collected > 0 ? ((collected - prev_collected) / prev_collected) * 100.0 : 0;

    cJSON_AddNumberToObject(obj, "expected_rent", expected);
    cJSON_AddNumberToObject(obj, "collected", collected);
    cJSON_AddNumberToObject(obj, "overdue", overdue);
    cJSON_AddNumberToObject(obj, "collection_percentage", collection_pct);
    cJSON_AddNumberToObject(obj, "paid_tenants", paid_tenants);
    cJSON_AddNumberToObject(obj, "overdue_tenants", overdue_tenants);
    cJSON_AddNumberToObject(obj, "total_tenants", total_tenants);
    cJSON_AddNumberToObject(obj, "vacant_units", vacant_units);
    cJSON_AddNumberToObject(obj, "disabled_units", disabled_units);
    cJSON_AddNumberToObject(obj, "contracts_expiring_soon", expiring_contracts);
    cJSON_AddNumberToObject(obj, "revenue_vs_previous_month_pct", rev_change_pct);
}

static int handle_dashboard_summary(struct MHD_Connection *connection, const char *month) {
    char current[MONTH_LEN];
    if (!month || strlen(month) != 7) {
        current_month(current);
        month = current;
    }

    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "month", month);
    cJSON *summary = cJSON_AddObjectToObject(root, "summary");
    add_financial_overview_fields(summary, month);

    sqlite3_stmt *stmt = NULL;
    const char *sql =
        "SELECT u.id, u.unit_number, u.status, u.is_active, IFNULL(u.inactive_reason,''), IFNULL(u.available_from,''), "
        "IFNULL(t.full_name,''), IFNULL(rc.status,''), IFNULL(rc.due_date,'') "
        "FROM units u "
        "LEFT JOIN tenants t ON t.id=u.current_tenant_id AND t.active=1 "
        "LEFT JOIN rent_charges rc ON rc.tenant_id=t.id AND rc.month=? "
        "ORDER BY CAST(u.unit_number AS INTEGER), u.unit_number";

    cJSON *grid = cJSON_AddArrayToObject(root, "unit_grid");
    if (sqlite3_prepare_v2(g_app.db, sql, -1, &stmt, NULL) == SQLITE_OK) {
        sqlite3_bind_text(stmt, 1, month, -1, SQLITE_TRANSIENT);
        while (sqlite3_step(stmt) == SQLITE_ROW) {
            const char *unit_status = (const char *) sqlite3_column_text(stmt, 2);
            int is_active = sqlite3_column_int(stmt, 3);
            const char *tenant_name = (const char *) sqlite3_column_text(stmt, 6);
            const char *charge_status = (const char *) sqlite3_column_text(stmt, 7);
            const char *due_date = (const char *) sqlite3_column_text(stmt, 8);
            const char *visual_status = payment_status_for_unit(is_active, unit_status, tenant_name[0] != '\0', charge_status,
                                                                due_date);

            cJSON *item = cJSON_CreateObject();
            cJSON_AddNumberToObject(item, "id", sqlite3_column_int(stmt, 0));
            cJSON_AddStringToObject(item, "unit_number", (const char *) sqlite3_column_text(stmt, 1));
            cJSON_AddStringToObject(item, "tenant_name", tenant_name);
            cJSON_AddBoolToObject(item, "is_active", is_active == 1);
            cJSON_AddStringToObject(item, "inactive_reason", (const char *) sqlite3_column_text(stmt, 4));
            cJSON_AddStringToObject(item, "available_from", (const char *) sqlite3_column_text(stmt, 5));
            cJSON_AddStringToObject(item, "status", visual_status);
            cJSON_AddItemToArray(grid, item);
        }
    }
    sqlite3_finalize(stmt);

    int ret = send_json(connection, MHD_HTTP_OK, root);
    cJSON_Delete(root);
    return ret;
}

static int handle_finance_overview(struct MHD_Connection *connection, const char *month) {
    char current[MONTH_LEN];
    if (!month || strlen(month) != 7) {
        current_month(current);
        month = current;
    }

    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "month", month);
    add_financial_overview_fields(root, month);

    int ret = send_json(connection, MHD_HTTP_OK, root);
    cJSON_Delete(root);
    return ret;
}

static int handle_finance_analytics(struct MHD_Connection *connection, const char *year) {
    char year_buf[16] = {0};
    if (!year || strlen(year) != 4) {
        time_t now = time(NULL);
        struct tm tm_now;
        localtime_r(&now, &tm_now);
        snprintf(year_buf, sizeof(year_buf), "%04d", tm_now.tm_year + 1900);
        year = year_buf;
    }

    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "year", year);

    cJSON *trend = cJSON_AddArrayToObject(root, "monthly_trend");

    sqlite3_stmt *stmt = NULL;
    const char *sql =
        "SELECT substr(rc.month,1,7), "
        "IFNULL(SUM(rc.amount),0), "
        "IFNULL(SUM(CASE WHEN rc.status='paid' THEN rc.amount + rc.late_fee ELSE 0 END),0), "
        "IFNULL(SUM(CASE WHEN rc.status='overdue' THEN rc.amount + rc.late_fee ELSE 0 END),0) "
        "FROM rent_charges rc JOIN units u ON u.id=rc.unit_id WHERE rc.month LIKE ? || '-%' AND u.is_active=1 "
        "GROUP BY substr(rc.month,1,7) ORDER BY substr(rc.month,1,7)";
    if (sqlite3_prepare_v2(g_app.db, sql, -1, &stmt, NULL) == SQLITE_OK) {
        sqlite3_bind_text(stmt, 1, year, -1, SQLITE_TRANSIENT);
        while (sqlite3_step(stmt) == SQLITE_ROW) {
            cJSON *row = cJSON_CreateObject();
            cJSON_AddStringToObject(row, "month", (const char *) sqlite3_column_text(stmt, 0));
            cJSON_AddNumberToObject(row, "expected", sqlite3_column_double(stmt, 1));
            cJSON_AddNumberToObject(row, "collected", sqlite3_column_double(stmt, 2));
            cJSON_AddNumberToObject(row, "overdue", sqlite3_column_double(stmt, 3));
            cJSON_AddItemToArray(trend, row);
        }
    }
    sqlite3_finalize(stmt);

    double paid = 0;
    double unpaid = 0;
    const char *sql_ratio =
        "SELECT "
        "IFNULL(SUM(CASE WHEN rc.status='paid' THEN rc.amount + rc.late_fee ELSE 0 END),0),"
        "IFNULL(SUM(CASE WHEN rc.status!='paid' THEN rc.amount + rc.late_fee ELSE 0 END),0)"
        "FROM rent_charges rc JOIN units u ON u.id=rc.unit_id WHERE rc.month LIKE ? || '-%' AND u.is_active=1";
    if (sqlite3_prepare_v2(g_app.db, sql_ratio, -1, &stmt, NULL) == SQLITE_OK) {
        sqlite3_bind_text(stmt, 1, year, -1, SQLITE_TRANSIENT);
        if (sqlite3_step(stmt) == SQLITE_ROW) {
            paid = sqlite3_column_double(stmt, 0);
            unpaid = sqlite3_column_double(stmt, 1);
        }
    }
    sqlite3_finalize(stmt);

    cJSON *ratio = cJSON_AddObjectToObject(root, "paid_unpaid_ratio");
    cJSON_AddNumberToObject(ratio, "paid", paid);
    cJSON_AddNumberToObject(ratio, "unpaid", unpaid);

    int ret = send_json(connection, MHD_HTTP_OK, root);
    cJSON_Delete(root);
    return ret;
}

static int handle_finance_intelligence(struct MHD_Connection *connection, const char *month) {
    char current[MONTH_LEN];
    if (!month || strlen(month) != 7) {
        current_month(current);
        month = current;
    }

    sqlite3_stmt *stmt = NULL;
    double revenue = 0;
    double expenses = 0;

    if (sqlite3_prepare_v2(g_app.db,
                           "SELECT IFNULL(SUM(rc.amount + rc.late_fee),0) "
                           "FROM rent_charges rc JOIN units u ON u.id=rc.unit_id "
                           "WHERE rc.month=? AND rc.status='paid' AND u.is_active=1",
                           -1, &stmt, NULL) == SQLITE_OK) {
        sqlite3_bind_text(stmt, 1, month, -1, SQLITE_TRANSIENT);
        if (sqlite3_step(stmt) == SQLITE_ROW) {
            revenue = sqlite3_column_double(stmt, 0);
        }
    }
    sqlite3_finalize(stmt);

    if (sqlite3_prepare_v2(g_app.db,
                           "SELECT IFNULL(SUM(e.amount),0) "
                           "FROM expenses e LEFT JOIN units u ON u.id=e.unit_id "
                           "WHERE substr(e.expense_date,1,7)=? AND (e.unit_id IS NULL OR IFNULL(u.is_active,1)=1)",
                           -1, &stmt, NULL) == SQLITE_OK) {
        sqlite3_bind_text(stmt, 1, month, -1, SQLITE_TRANSIENT);
        if (sqlite3_step(stmt) == SQLITE_ROW) {
            expenses = sqlite3_column_double(stmt, 0);
        }
    }
    sqlite3_finalize(stmt);

    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "month", month);
    cJSON_AddNumberToObject(root, "revenue", revenue);
    cJSON_AddNumberToObject(root, "expenses", expenses);
    cJSON_AddNumberToObject(root, "net_income", revenue - expenses);

    cJSON *ranking = cJSON_AddArrayToObject(root, "unit_profitability_ranking");
    const char *sql =
        "SELECT u.id, u.unit_number, "
        "IFNULL(SUM(CASE WHEN rc.status='paid' THEN rc.amount + rc.late_fee ELSE 0 END),0) - "
        "IFNULL((SELECT SUM(e.amount) FROM expenses e WHERE e.unit_id=u.id AND substr(e.expense_date,1,7)=?),0) as net "
        "FROM units u "
        "LEFT JOIN rent_charges rc ON rc.unit_id=u.id AND rc.month=? "
        "WHERE u.is_active=1 "
        "GROUP BY u.id, u.unit_number "
        "ORDER BY net DESC";

    if (sqlite3_prepare_v2(g_app.db, sql, -1, &stmt, NULL) == SQLITE_OK) {
        sqlite3_bind_text(stmt, 1, month, -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(stmt, 2, month, -1, SQLITE_TRANSIENT);
        while (sqlite3_step(stmt) == SQLITE_ROW) {
            cJSON *item = cJSON_CreateObject();
            cJSON_AddNumberToObject(item, "unit_id", sqlite3_column_int(stmt, 0));
            cJSON_AddStringToObject(item, "unit_number", (const char *) sqlite3_column_text(stmt, 1));
            cJSON_AddNumberToObject(item, "net_income", sqlite3_column_double(stmt, 2));
            cJSON_AddItemToArray(ranking, item);
        }
    }
    sqlite3_finalize(stmt);

    int ret = send_json(connection, MHD_HTTP_OK, root);
    cJSON_Delete(root);
    return ret;
}

static int handle_create_payment(struct MHD_Connection *connection, const char *body) {
    cJSON *input = cJSON_Parse(body ? body : "");
    if (!input) {
        return send_error(connection, MHD_HTTP_BAD_REQUEST, "invalid_json");
    }

    int tenant_id = json_int(input, "tenant_id", 0);
    const char *month = json_string(input, "month");
    double amount = json_double(input, "amount", 0);
    double late_fee = json_double(input, "late_fee", 0);
    const char *payment_method = json_string(input, "payment_method");
    const char *notes = json_string(input, "notes");
    const char *payment_date = json_string(input, "payment_date");

    if (tenant_id <= 0 || !month || strlen(month) != 7 || amount <= 0) {
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_BAD_REQUEST, "tenant_id_month_amount_required");
    }

    sqlite3_stmt *stmt = NULL;
    int unit_id = 0;
    int due_day = 5;
    if (sqlite3_prepare_v2(g_app.db, "SELECT IFNULL(unit_id,0), due_day FROM tenants WHERE id=?", -1, &stmt, NULL) !=
        SQLITE_OK) {
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "db_prepare_failed");
    }
    sqlite3_bind_int(stmt, 1, tenant_id);
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        unit_id = sqlite3_column_int(stmt, 0);
        due_day = sqlite3_column_int(stmt, 1);
    }
    sqlite3_finalize(stmt);

    if (unit_id <= 0) {
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_BAD_REQUEST, "tenant_without_assigned_unit");
    }

    char due_date[DATE_LEN];
    int safe_due_day = due_day;
    if (safe_due_day < 1) {
        safe_due_day = 1;
    }
    if (safe_due_day > 28) {
        safe_due_day = 28;
    }
    snprintf(due_date, DATE_LEN, "%.*s-%02d", 7, month, safe_due_day);
    char paid_at[20];
    if (payment_date && strlen(payment_date) >= 10) {
        snprintf(paid_at, sizeof(paid_at), "%s 12:00:00", payment_date);
    } else {
        now_iso_datetime(paid_at);
    }

    const char *sql =
        "INSERT INTO rent_charges(tenant_id, unit_id, month, amount, due_date, status, paid_at, late_fee, payment_method, notes) "
        "VALUES(?, ?, ?, ?, ?, 'paid', ?, ?, ?, ?) "
        "ON CONFLICT(tenant_id, month) DO UPDATE SET "
        "amount=excluded.amount, status='paid', paid_at=excluded.paid_at, late_fee=excluded.late_fee, payment_method=excluded.payment_method, notes=excluded.notes";
    if (sqlite3_prepare_v2(g_app.db, sql, -1, &stmt, NULL) != SQLITE_OK) {
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "db_prepare_failed");
    }

    sqlite3_bind_int(stmt, 1, tenant_id);
    sqlite3_bind_int(stmt, 2, unit_id);
    sqlite3_bind_text(stmt, 3, month, -1, SQLITE_TRANSIENT);
    sqlite3_bind_double(stmt, 4, amount);
    sqlite3_bind_text(stmt, 5, due_date, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 6, paid_at, -1, SQLITE_TRANSIENT);
    sqlite3_bind_double(stmt, 7, late_fee);
    sqlite3_bind_text(stmt, 8, payment_method ? payment_method : "manual", -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 9, notes ? notes : "", -1, SQLITE_TRANSIENT);

    int ok = sqlite3_step(stmt) == SQLITE_DONE;
    sqlite3_finalize(stmt);
    cJSON_Delete(input);

    if (!ok) {
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "payment_register_failed");
    }

    cJSON *out = cJSON_CreateObject();
    cJSON_AddStringToObject(out, "message", "payment_registered");
    int ret = send_json(connection, MHD_HTTP_OK, out);
    cJSON_Delete(out);
    return ret;
}

static int handle_get_payments(struct MHD_Connection *connection, const char *tenant_id_q, const char *month_q) {
    int tenant_id = tenant_id_q ? atoi(tenant_id_q) : 0;

    sqlite3_stmt *stmt = NULL;
    const char *sql =
        "SELECT rc.id, rc.tenant_id, t.full_name, rc.month, rc.amount, rc.status, rc.due_date, IFNULL(rc.paid_at,''), rc.late_fee, IFNULL(rc.payment_method,''), IFNULL(rc.notes,'') "
        "FROM rent_charges rc JOIN tenants t ON t.id=rc.tenant_id "
        "WHERE (? = 0 OR rc.tenant_id = ?) AND (? = '' OR rc.month = ?) "
        "ORDER BY rc.month DESC, t.full_name ASC";

    if (sqlite3_prepare_v2(g_app.db, sql, -1, &stmt, NULL) != SQLITE_OK) {
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "db_prepare_failed");
    }

    sqlite3_bind_int(stmt, 1, tenant_id);
    sqlite3_bind_int(stmt, 2, tenant_id);
    sqlite3_bind_text(stmt, 3, month_q ? month_q : "", -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 4, month_q ? month_q : "", -1, SQLITE_TRANSIENT);

    cJSON *root = cJSON_CreateObject();
    cJSON *items = cJSON_AddArrayToObject(root, "items");

    while (sqlite3_step(stmt) == SQLITE_ROW) {
        cJSON *item = cJSON_CreateObject();
        cJSON_AddNumberToObject(item, "id", sqlite3_column_int(stmt, 0));
        cJSON_AddNumberToObject(item, "tenant_id", sqlite3_column_int(stmt, 1));
        cJSON_AddStringToObject(item, "tenant_name", (const char *) sqlite3_column_text(stmt, 2));
        cJSON_AddStringToObject(item, "month", (const char *) sqlite3_column_text(stmt, 3));
        cJSON_AddNumberToObject(item, "amount", sqlite3_column_double(stmt, 4));
        cJSON_AddStringToObject(item, "status", (const char *) sqlite3_column_text(stmt, 5));
        cJSON_AddStringToObject(item, "due_date", (const char *) sqlite3_column_text(stmt, 6));
        cJSON_AddStringToObject(item, "paid_at", (const char *) sqlite3_column_text(stmt, 7));
        cJSON_AddNumberToObject(item, "late_fee", sqlite3_column_double(stmt, 8));
        cJSON_AddStringToObject(item, "payment_method", (const char *) sqlite3_column_text(stmt, 9));
        cJSON_AddStringToObject(item, "notes", (const char *) sqlite3_column_text(stmt, 10));
        cJSON_AddItemToArray(items, item);
    }

    sqlite3_finalize(stmt);
    int ret = send_json(connection, MHD_HTTP_OK, root);
    cJSON_Delete(root);
    return ret;
}

static int handle_get_expenses(struct MHD_Connection *connection, const char *month) {
    sqlite3_stmt *stmt = NULL;
    const char *sql =
        "SELECT id, category, description, amount, expense_date, IFNULL(unit_id,0) FROM expenses "
        "WHERE (? = '' OR substr(expense_date,1,7)=?) ORDER BY expense_date DESC";

    if (sqlite3_prepare_v2(g_app.db, sql, -1, &stmt, NULL) != SQLITE_OK) {
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "db_prepare_failed");
    }
    sqlite3_bind_text(stmt, 1, month ? month : "", -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 2, month ? month : "", -1, SQLITE_TRANSIENT);

    cJSON *root = cJSON_CreateObject();
    cJSON *items = cJSON_AddArrayToObject(root, "items");
    double total = 0;

    while (sqlite3_step(stmt) == SQLITE_ROW) {
        cJSON *item = cJSON_CreateObject();
        cJSON_AddNumberToObject(item, "id", sqlite3_column_int(stmt, 0));
        cJSON_AddStringToObject(item, "category", (const char *) sqlite3_column_text(stmt, 1));
        cJSON_AddStringToObject(item, "description", (const char *) sqlite3_column_text(stmt, 2));
        double amount = sqlite3_column_double(stmt, 3);
        cJSON_AddNumberToObject(item, "amount", amount);
        cJSON_AddStringToObject(item, "expense_date", (const char *) sqlite3_column_text(stmt, 4));
        cJSON_AddNumberToObject(item, "unit_id", sqlite3_column_int(stmt, 5));
        cJSON_AddItemToArray(items, item);
        total += amount;
    }
    sqlite3_finalize(stmt);
    cJSON_AddNumberToObject(root, "total", total);

    int ret = send_json(connection, MHD_HTTP_OK, root);
    cJSON_Delete(root);
    return ret;
}

static int handle_create_expense(struct MHD_Connection *connection, const char *body) {
    cJSON *input = cJSON_Parse(body ? body : "");
    if (!input) {
        return send_error(connection, MHD_HTTP_BAD_REQUEST, "invalid_json");
    }

    const char *category = json_string(input, "category");
    const char *description = json_string(input, "description");
    double amount = json_double(input, "amount", 0);
    const char *expense_date = json_string(input, "expense_date");
    int unit_id = json_int(input, "unit_id", 0);

    if (!category || !description || amount <= 0 || !expense_date) {
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_BAD_REQUEST, "category_description_amount_expense_date_required");
    }

    sqlite3_stmt *stmt = NULL;
    const char *sql = "INSERT INTO expenses(category, description, amount, expense_date, unit_id) VALUES(?,?,?,?,?)";
    if (sqlite3_prepare_v2(g_app.db, sql, -1, &stmt, NULL) != SQLITE_OK) {
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "db_prepare_failed");
    }

    sqlite3_bind_text(stmt, 1, category, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 2, description, -1, SQLITE_TRANSIENT);
    sqlite3_bind_double(stmt, 3, amount);
    sqlite3_bind_text(stmt, 4, expense_date, -1, SQLITE_TRANSIENT);
    if (unit_id > 0) {
        sqlite3_bind_int(stmt, 5, unit_id);
    } else {
        sqlite3_bind_null(stmt, 5);
    }

    int ok = sqlite3_step(stmt) == SQLITE_DONE;
    sqlite3_finalize(stmt);
    cJSON_Delete(input);

    if (!ok) {
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "expense_create_failed");
    }

    cJSON *out = cJSON_CreateObject();
    cJSON_AddStringToObject(out, "message", "expense_created");
    int ret = send_json(connection, MHD_HTTP_CREATED, out);
    cJSON_Delete(out);
    return ret;
}

static int handle_get_maintenance(struct MHD_Connection *connection, const char *status) {
    sqlite3_stmt *stmt = NULL;
    const char *sql =
        "SELECT m.id, m.unit_id, u.unit_number, m.description, m.ticket_date, m.cost, m.status, IFNULL(m.image_path,'') "
        "FROM maintenance_tickets m JOIN units u ON u.id=m.unit_id "
        "WHERE (? = '' OR m.status = ?) ORDER BY m.ticket_date DESC";

    if (sqlite3_prepare_v2(g_app.db, sql, -1, &stmt, NULL) != SQLITE_OK) {
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "db_prepare_failed");
    }
    sqlite3_bind_text(stmt, 1, status ? status : "", -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 2, status ? status : "", -1, SQLITE_TRANSIENT);

    cJSON *root = cJSON_CreateObject();
    cJSON *items = cJSON_AddArrayToObject(root, "items");
    double total_cost = 0;

    while (sqlite3_step(stmt) == SQLITE_ROW) {
        cJSON *item = cJSON_CreateObject();
        cJSON_AddNumberToObject(item, "id", sqlite3_column_int(stmt, 0));
        cJSON_AddNumberToObject(item, "unit_id", sqlite3_column_int(stmt, 1));
        cJSON_AddStringToObject(item, "unit_number", (const char *) sqlite3_column_text(stmt, 2));
        cJSON_AddStringToObject(item, "description", (const char *) sqlite3_column_text(stmt, 3));
        cJSON_AddStringToObject(item, "ticket_date", (const char *) sqlite3_column_text(stmt, 4));
        double cost = sqlite3_column_double(stmt, 5);
        cJSON_AddNumberToObject(item, "cost", cost);
        cJSON_AddStringToObject(item, "status", (const char *) sqlite3_column_text(stmt, 6));
        cJSON_AddStringToObject(item, "image_path", (const char *) sqlite3_column_text(stmt, 7));
        cJSON_AddItemToArray(items, item);
        total_cost += cost;
    }

    sqlite3_finalize(stmt);
    cJSON_AddNumberToObject(root, "total_cost", total_cost);

    int ret = send_json(connection, MHD_HTTP_OK, root);
    cJSON_Delete(root);
    return ret;
}

static int handle_create_maintenance(struct MHD_Connection *connection, const char *body) {
    cJSON *input = cJSON_Parse(body ? body : "");
    if (!input) {
        return send_error(connection, MHD_HTTP_BAD_REQUEST, "invalid_json");
    }

    int unit_id = json_int(input, "unit_id", 0);
    const char *description = json_string(input, "description");
    const char *ticket_date = json_string(input, "date");
    double cost = json_double(input, "cost", 0);
    const char *status = json_string(input, "status");
    const char *image_path = json_string(input, "image_path");

    if (unit_id <= 0 || !description || !ticket_date) {
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_BAD_REQUEST, "unit_id_description_date_required");
    }

    sqlite3_stmt *stmt = NULL;
    const char *sql = "INSERT INTO maintenance_tickets(unit_id, description, ticket_date, cost, status, image_path) VALUES(?,?,?,?,?,?)";
    if (sqlite3_prepare_v2(g_app.db, sql, -1, &stmt, NULL) != SQLITE_OK) {
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "db_prepare_failed");
    }

    sqlite3_bind_int(stmt, 1, unit_id);
    sqlite3_bind_text(stmt, 2, description, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 3, ticket_date, -1, SQLITE_TRANSIENT);
    sqlite3_bind_double(stmt, 4, cost);
    sqlite3_bind_text(stmt, 5, status ? status : "open", -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 6, image_path ? image_path : "", -1, SQLITE_TRANSIENT);

    int ok = sqlite3_step(stmt) == SQLITE_DONE;
    sqlite3_finalize(stmt);
    cJSON_Delete(input);

    if (!ok) {
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "maintenance_create_failed");
    }

    cJSON *out = cJSON_CreateObject();
    cJSON_AddStringToObject(out, "message", "maintenance_created");
    int ret = send_json(connection, MHD_HTTP_CREATED, out);
    cJSON_Delete(out);
    return ret;
}

static int handle_update_maintenance(struct MHD_Connection *connection, int ticket_id, const char *body) {
    cJSON *input = cJSON_Parse(body ? body : "");
    if (!input) {
        return send_error(connection, MHD_HTTP_BAD_REQUEST, "invalid_json");
    }

    const char *description = json_string(input, "description");
    const char *date = json_string(input, "date");
    double cost = json_double(input, "cost", -1);
    const char *status = json_string(input, "status");
    const char *image_path = json_string(input, "image_path");

    if (description) {
        db_exec_fmt("UPDATE maintenance_tickets SET description='%q' WHERE id=%d", description, ticket_id);
    }
    if (date) {
        db_exec_fmt("UPDATE maintenance_tickets SET ticket_date='%q' WHERE id=%d", date, ticket_id);
    }
    if (cost >= 0) {
        db_exec_fmt("UPDATE maintenance_tickets SET cost=%.2f WHERE id=%d", cost, ticket_id);
    }
    if (status) {
        db_exec_fmt("UPDATE maintenance_tickets SET status='%q' WHERE id=%d", status, ticket_id);
    }
    if (image_path) {
        db_exec_fmt("UPDATE maintenance_tickets SET image_path='%q' WHERE id=%d", image_path, ticket_id);
    }

    cJSON_Delete(input);
    cJSON *out = cJSON_CreateObject();
    cJSON_AddStringToObject(out, "message", "maintenance_updated");
    int ret = send_json(connection, MHD_HTTP_OK, out);
    cJSON_Delete(out);
    return ret;
}

static char *replace_placeholder(const char *input, const char *placeholder, const char *value) {
    const char *val = value ? value : "";
    size_t input_len = strlen(input);
    size_t ph_len = strlen(placeholder);
    size_t val_len = strlen(val);

    size_t count = 0;
    const char *p = input;
    while ((p = strstr(p, placeholder)) != NULL) {
        count++;
        p += ph_len;
    }

    size_t out_len = input_len + count * (val_len - ph_len) + 1;
    char *out = malloc(out_len);
    if (!out) {
        return NULL;
    }

    const char *src = input;
    char *dst = out;
    while ((p = strstr(src, placeholder)) != NULL) {
        size_t segment_len = (size_t) (p - src);
        memcpy(dst, src, segment_len);
        dst += segment_len;
        memcpy(dst, val, val_len);
        dst += val_len;
        src = p + ph_len;
    }
    strcpy(dst, src);

    return out;
}

static char *escape_pdf_text(const char *text) {
    size_t n = strlen(text);
    char *out = calloc(n * 2 + 1, 1);
    if (!out) {
        return NULL;
    }

    size_t j = 0;
    for (size_t i = 0; i < n; i++) {
        char c = text[i];
        if (c == '(' || c == ')' || c == '\\') {
            out[j++] = '\\';
        }
        if (c == '\n' || c == '\r') {
            out[j++] = ' ';
        } else {
            out[j++] = c;
        }
    }
    out[j] = '\0';
    return out;
}

static int generate_simple_pdf(const char *path, const char *title, const char *body) {
    char *esc_title = escape_pdf_text(title ? title : "Document");
    char *esc_body = escape_pdf_text(body ? body : "");
    if (!esc_title || !esc_body) {
        free(esc_title);
        free(esc_body);
        return 0;
    }

    char content[8192];
    snprintf(content, sizeof(content), "BT /F1 18 Tf 50 780 Td (%s) Tj /F1 12 Tf 0 -30 Td (%s) Tj ET", esc_title,
             esc_body);

    free(esc_title);
    free(esc_body);

    FILE *fp = fopen(path, "wb");
    if (!fp) {
        return 0;
    }

    long xref[6] = {0};
    fprintf(fp, "%%PDF-1.4\n");

    xref[1] = ftell(fp);
    fprintf(fp, "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

    xref[2] = ftell(fp);
    fprintf(fp, "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");

    xref[3] = ftell(fp);
    fprintf(fp,
            "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> "
            "/Contents 5 0 R >>\nendobj\n");

    xref[4] = ftell(fp);
    fprintf(fp, "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n");

    xref[5] = ftell(fp);
    fprintf(fp, "5 0 obj\n<< /Length %zu >>\nstream\n%s\nendstream\nendobj\n", strlen(content), content);

    long xref_pos = ftell(fp);
    fprintf(fp, "xref\n0 6\n");
    fprintf(fp, "0000000000 65535 f \n");
    for (int i = 1; i <= 5; i++) {
        fprintf(fp, "%010ld 00000 n \n", xref[i]);
    }
    fprintf(fp, "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n%ld\n%%%%EOF\n", xref_pos);

    fclose(fp);
    return 1;
}

static int handle_get_document_templates(struct MHD_Connection *connection) {
    sqlite3_stmt *stmt = NULL;
    const char *sql = "SELECT id, name, document_type, template_body, created_at FROM document_templates ORDER BY id DESC";

    if (sqlite3_prepare_v2(g_app.db, sql, -1, &stmt, NULL) != SQLITE_OK) {
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "db_prepare_failed");
    }

    cJSON *root = cJSON_CreateObject();
    cJSON *items = cJSON_AddArrayToObject(root, "items");

    while (sqlite3_step(stmt) == SQLITE_ROW) {
        cJSON *item = cJSON_CreateObject();
        cJSON_AddNumberToObject(item, "id", sqlite3_column_int(stmt, 0));
        cJSON_AddStringToObject(item, "name", (const char *) sqlite3_column_text(stmt, 1));
        cJSON_AddStringToObject(item, "document_type", (const char *) sqlite3_column_text(stmt, 2));
        cJSON_AddStringToObject(item, "template_body", (const char *) sqlite3_column_text(stmt, 3));
        cJSON_AddStringToObject(item, "created_at", (const char *) sqlite3_column_text(stmt, 4));
        cJSON_AddItemToArray(items, item);
    }
    sqlite3_finalize(stmt);

    int ret = send_json(connection, MHD_HTTP_OK, root);
    cJSON_Delete(root);
    return ret;
}

static int handle_create_document_template(struct MHD_Connection *connection, const char *body) {
    cJSON *input = cJSON_Parse(body ? body : "");
    if (!input) {
        return send_error(connection, MHD_HTTP_BAD_REQUEST, "invalid_json");
    }

    const char *name = json_string(input, "name");
    const char *document_type = json_string(input, "document_type");
    const char *template_body = json_string(input, "template_body");
    if (!name || !document_type || !template_body) {
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_BAD_REQUEST, "name_document_type_template_body_required");
    }

    sqlite3_stmt *stmt = NULL;
    const char *sql = "INSERT INTO document_templates(name, document_type, template_body) VALUES(?,?,?)";
    if (sqlite3_prepare_v2(g_app.db, sql, -1, &stmt, NULL) != SQLITE_OK) {
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "db_prepare_failed");
    }

    sqlite3_bind_text(stmt, 1, name, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 2, document_type, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 3, template_body, -1, SQLITE_TRANSIENT);

    int ok = sqlite3_step(stmt) == SQLITE_DONE;
    sqlite3_finalize(stmt);
    cJSON_Delete(input);

    if (!ok) {
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "template_create_failed");
    }

    cJSON *out = cJSON_CreateObject();
    cJSON_AddStringToObject(out, "message", "template_created");
    cJSON_AddNumberToObject(out, "id", sqlite3_last_insert_rowid(g_app.db));
    int ret = send_json(connection, MHD_HTTP_CREATED, out);
    cJSON_Delete(out);
    return ret;
}

static int handle_update_document_template(struct MHD_Connection *connection, int template_id, const char *body) {
    cJSON *input = cJSON_Parse(body ? body : "");
    if (!input) {
        return send_error(connection, MHD_HTTP_BAD_REQUEST, "invalid_json");
    }

    cJSON *name_item = cJSON_GetObjectItemCaseSensitive(input, "name");
    cJSON *document_type_item = cJSON_GetObjectItemCaseSensitive(input, "document_type");
    cJSON *template_body_item = cJSON_GetObjectItemCaseSensitive(input, "template_body");

    int has_name = cJSON_IsString(name_item);
    int has_document_type = cJSON_IsString(document_type_item);
    int has_template_body = cJSON_IsString(template_body_item);
    if (!has_name && !has_document_type && !has_template_body) {
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_BAD_REQUEST, "no_update_fields");
    }

    const char *name = has_name ? name_item->valuestring : NULL;
    const char *document_type = has_document_type ? document_type_item->valuestring : NULL;
    const char *template_body = has_template_body ? template_body_item->valuestring : NULL;

    if ((has_name && (!name || name[0] == '\0')) || (has_document_type && (!document_type || document_type[0] == '\0'))) {
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_BAD_REQUEST, "name_and_document_type_must_be_non_empty");
    }

    sqlite3_stmt *stmt = NULL;
    char current_name[128] = {0};
    char current_document_type[64] = {0};
    char *current_template_body = NULL;

    if (sqlite3_prepare_v2(g_app.db, "SELECT name, document_type, template_body FROM document_templates WHERE id=?", -1, &stmt,
                           NULL) != SQLITE_OK) {
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "db_prepare_failed");
    }
    sqlite3_bind_int(stmt, 1, template_id);
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        snprintf(current_name, sizeof(current_name), "%s", (const char *) sqlite3_column_text(stmt, 0));
        snprintf(current_document_type, sizeof(current_document_type), "%s", (const char *) sqlite3_column_text(stmt, 1));
        const char *body_txt = (const char *) sqlite3_column_text(stmt, 2);
        current_template_body = dup_string(body_txt ? body_txt : "");
    }
    sqlite3_finalize(stmt);

    if (!current_template_body) {
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_NOT_FOUND, "template_not_found");
    }

    const char *effective_name = has_name ? name : current_name;
    const char *effective_document_type = has_document_type ? document_type : current_document_type;
    const char *effective_template_body = has_template_body ? template_body : current_template_body;

    const char *sql = "UPDATE document_templates SET name=?, document_type=?, template_body=? WHERE id=?";
    if (sqlite3_prepare_v2(g_app.db, sql, -1, &stmt, NULL) != SQLITE_OK) {
        free(current_template_body);
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "db_prepare_failed");
    }
    sqlite3_bind_text(stmt, 1, effective_name, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 2, effective_document_type, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 3, effective_template_body, -1, SQLITE_TRANSIENT);
    sqlite3_bind_int(stmt, 4, template_id);
    int ok = sqlite3_step(stmt) == SQLITE_DONE;
    sqlite3_finalize(stmt);
    free(current_template_body);
    cJSON_Delete(input);

    if (!ok) {
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "template_update_failed");
    }

    cJSON *out = cJSON_CreateObject();
    cJSON_AddStringToObject(out, "message", "template_updated");
    int ret = send_json(connection, MHD_HTTP_OK, out);
    cJSON_Delete(out);
    return ret;
}

static int handle_generate_document(struct MHD_Connection *connection, const char *body) {
    cJSON *input = cJSON_Parse(body ? body : "");
    if (!input) {
        return send_error(connection, MHD_HTTP_BAD_REQUEST, "invalid_json");
    }

    int template_id = json_int(input, "template_id", 0);
    int tenant_id = json_int(input, "tenant_id", 0);
    if (template_id <= 0 || tenant_id <= 0) {
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_BAD_REQUEST, "template_id_and_tenant_id_required");
    }

    sqlite3_stmt *stmt = NULL;

    char template_name[128] = {0};
    char document_type[64] = {0};
    char *template_body = NULL;

    if (sqlite3_prepare_v2(g_app.db, "SELECT name, document_type, template_body FROM document_templates WHERE id=?", -1,
                           &stmt, NULL) != SQLITE_OK) {
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "db_prepare_failed");
    }
    sqlite3_bind_int(stmt, 1, template_id);
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        snprintf(template_name, sizeof(template_name), "%s", (const char *) sqlite3_column_text(stmt, 0));
        snprintf(document_type, sizeof(document_type), "%s", (const char *) sqlite3_column_text(stmt, 1));
        const char *tmp = (const char *) sqlite3_column_text(stmt, 2);
        template_body = dup_string(tmp ? tmp : "");
    }
    sqlite3_finalize(stmt);

    if (!template_body) {
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_NOT_FOUND, "template_not_found");
    }

    char tenant_name[128] = {0};
    char cpf[32] = {0};
    char unit_number[32] = {0};
    double rent_value = 0;
    int due_day = 0;

    const char *sql_tenant =
        "SELECT t.full_name, t.cpf, t.rent_amount, t.due_day, IFNULL(u.unit_number,'N/A') "
        "FROM tenants t LEFT JOIN units u ON u.id=t.unit_id WHERE t.id=?";
    if (sqlite3_prepare_v2(g_app.db, sql_tenant, -1, &stmt, NULL) == SQLITE_OK) {
        sqlite3_bind_int(stmt, 1, tenant_id);
        if (sqlite3_step(stmt) == SQLITE_ROW) {
            snprintf(tenant_name, sizeof(tenant_name), "%s", (const char *) sqlite3_column_text(stmt, 0));
            snprintf(cpf, sizeof(cpf), "%s", (const char *) sqlite3_column_text(stmt, 1));
            rent_value = sqlite3_column_double(stmt, 2);
            due_day = sqlite3_column_int(stmt, 3);
            snprintf(unit_number, sizeof(unit_number), "%s", (const char *) sqlite3_column_text(stmt, 4));
        }
    }
    sqlite3_finalize(stmt);

    if (tenant_name[0] == '\0') {
        free(template_body);
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_NOT_FOUND, "tenant_not_found");
    }

    char month[MONTH_LEN];
    current_month(month);
    char due_date[DATE_LEN];
    int safe_due_day = due_day;
    if (safe_due_day < 1) {
        safe_due_day = 1;
    }
    if (safe_due_day > 28) {
        safe_due_day = 28;
    }
    snprintf(due_date, DATE_LEN, "%.*s-%02d", 7, month, safe_due_day);

    char rent_buf[32];
    snprintf(rent_buf, sizeof(rent_buf), "%.2f", rent_value);

    char *tmp1 = replace_placeholder(template_body, "{{tenant_name}}", tenant_name);
    char *tmp2 = replace_placeholder(tmp1 ? tmp1 : template_body, "{{cpf}}", cpf);
    char *tmp3 = replace_placeholder(tmp2 ? tmp2 : template_body, "{{rent_value}}", rent_buf);
    char *tmp4 = replace_placeholder(tmp3 ? tmp3 : template_body, "{{due_date}}", due_date);
    char *final_body = replace_placeholder(tmp4 ? tmp4 : template_body, "{{unit_number}}", unit_number);

    free(template_body);
    free(tmp1);
    free(tmp2);
    free(tmp3);
    free(tmp4);

    if (!final_body) {
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "placeholder_replacement_failed");
    }

    char ts[20];
    now_iso_datetime(ts);
    for (size_t i = 0; i < strlen(ts); i++) {
        if (ts[i] == ' ' || ts[i] == ':') {
            ts[i] = '_';
        }
    }

    char file_path[768];
    snprintf(file_path, sizeof(file_path), "%s/doc_%d_%s.pdf", g_app.generated_dir, tenant_id, ts);

    if (!generate_simple_pdf(file_path, template_name, final_body)) {
        free(final_body);
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "pdf_generation_failed");
    }

    free(final_body);

    sqlite3_stmt *insert_stmt = NULL;
    const char *sql_insert = "INSERT INTO documents(template_id, tenant_id, document_type, file_path) VALUES(?,?,?,?)";
    if (sqlite3_prepare_v2(g_app.db, sql_insert, -1, &insert_stmt, NULL) != SQLITE_OK) {
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "db_prepare_failed");
    }
    sqlite3_bind_int(insert_stmt, 1, template_id);
    sqlite3_bind_int(insert_stmt, 2, tenant_id);
    sqlite3_bind_text(insert_stmt, 3, document_type, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(insert_stmt, 4, file_path, -1, SQLITE_TRANSIENT);

    int ok = sqlite3_step(insert_stmt) == SQLITE_DONE;
    sqlite3_finalize(insert_stmt);
    if (!ok) {
        cJSON_Delete(input);
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "document_persist_failed");
    }

    int doc_id = sqlite3_last_insert_rowid(g_app.db);

    cJSON *out = cJSON_CreateObject();
    cJSON_AddNumberToObject(out, "document_id", doc_id);
    cJSON_AddStringToObject(out, "message", "document_generated");

    char download_url[128];
    snprintf(download_url, sizeof(download_url), "/api/documents/download/%d", doc_id);
    cJSON_AddStringToObject(out, "download_url", download_url);

    int ret = send_json(connection, MHD_HTTP_CREATED, out);
    cJSON_Delete(out);
    cJSON_Delete(input);
    return ret;
}

static int handle_get_documents(struct MHD_Connection *connection, const char *tenant_id_q) {
    int tenant_id = tenant_id_q ? atoi(tenant_id_q) : 0;

    sqlite3_stmt *stmt = NULL;
    const char *sql =
        "SELECT d.id, d.template_id, d.tenant_id, t.full_name, d.document_type, d.file_path, d.generated_at "
        "FROM documents d JOIN tenants t ON t.id=d.tenant_id "
        "WHERE (? = 0 OR d.tenant_id = ?) ORDER BY d.generated_at DESC";

    if (sqlite3_prepare_v2(g_app.db, sql, -1, &stmt, NULL) != SQLITE_OK) {
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "db_prepare_failed");
    }
    sqlite3_bind_int(stmt, 1, tenant_id);
    sqlite3_bind_int(stmt, 2, tenant_id);

    cJSON *root = cJSON_CreateObject();
    cJSON *items = cJSON_AddArrayToObject(root, "items");

    while (sqlite3_step(stmt) == SQLITE_ROW) {
        cJSON *item = cJSON_CreateObject();
        int doc_id = sqlite3_column_int(stmt, 0);
        cJSON_AddNumberToObject(item, "id", doc_id);
        cJSON_AddNumberToObject(item, "template_id", sqlite3_column_int(stmt, 1));
        cJSON_AddNumberToObject(item, "tenant_id", sqlite3_column_int(stmt, 2));
        cJSON_AddStringToObject(item, "tenant_name", (const char *) sqlite3_column_text(stmt, 3));
        cJSON_AddStringToObject(item, "document_type", (const char *) sqlite3_column_text(stmt, 4));
        cJSON_AddStringToObject(item, "file_path", (const char *) sqlite3_column_text(stmt, 5));
        cJSON_AddStringToObject(item, "generated_at", (const char *) sqlite3_column_text(stmt, 6));

        char download_url[128];
        snprintf(download_url, sizeof(download_url), "/api/documents/download/%d", doc_id);
        cJSON_AddStringToObject(item, "download_url", download_url);
        cJSON_AddItemToArray(items, item);
    }
    sqlite3_finalize(stmt);

    int ret = send_json(connection, MHD_HTTP_OK, root);
    cJSON_Delete(root);
    return ret;
}

static int send_pdf_file(struct MHD_Connection *connection, const char *file_path) {
    FILE *fp = fopen(file_path, "rb");
    if (!fp) {
        return send_error(connection, MHD_HTTP_NOT_FOUND, "file_not_found");
    }

    fseek(fp, 0, SEEK_END);
    long size = ftell(fp);
    fseek(fp, 0, SEEK_SET);
    if (size <= 0 || size > 20 * 1024 * 1024) {
        fclose(fp);
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "invalid_file_size");
    }

    char *buffer = malloc((size_t) size);
    if (!buffer) {
        fclose(fp);
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "memory_allocation_failed");
    }

    size_t read_count = fread(buffer, 1, (size_t) size, fp);
    fclose(fp);
    if (read_count != (size_t) size) {
        free(buffer);
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "file_read_failed");
    }

    struct MHD_Response *response = MHD_create_response_from_buffer((size_t) size, buffer, MHD_RESPMEM_MUST_FREE);
    if (!response) {
        free(buffer);
        return MHD_NO;
    }
    MHD_add_response_header(response, "Content-Type", "application/pdf");
    MHD_add_response_header(response, "Content-Disposition", "attachment; filename=generated.pdf");
    add_cors_headers(response);
    int ret = MHD_queue_response(connection, MHD_HTTP_OK, response);
    MHD_destroy_response(response);
    return ret;
}

static int handle_download_document(struct MHD_Connection *connection, int doc_id) {
    sqlite3_stmt *stmt = NULL;
    const char *file_path = NULL;

    if (sqlite3_prepare_v2(g_app.db, "SELECT file_path FROM documents WHERE id=?", -1, &stmt, NULL) != SQLITE_OK) {
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "db_prepare_failed");
    }
    sqlite3_bind_int(stmt, 1, doc_id);

    char path_buf[768] = {0};
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        const unsigned char *txt = sqlite3_column_text(stmt, 0);
        snprintf(path_buf, sizeof(path_buf), "%s", txt ? (const char *) txt : "");
        file_path = path_buf;
    }
    sqlite3_finalize(stmt);

    if (!file_path || file_path[0] == '\0') {
        return send_error(connection, MHD_HTTP_NOT_FOUND, "document_not_found");
    }

    return send_pdf_file(connection, file_path);
}

static int handle_get_notifications(struct MHD_Connection *connection) {
    sqlite3_stmt *stmt = NULL;
    const char *sql =
        "SELECT id, type, title, message, IFNULL(related_id,0), created_at, read_status FROM notifications "
        "ORDER BY created_at DESC LIMIT 50";

    if (sqlite3_prepare_v2(g_app.db, sql, -1, &stmt, NULL) != SQLITE_OK) {
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "db_prepare_failed");
    }

    cJSON *root = cJSON_CreateObject();
    cJSON *items = cJSON_AddArrayToObject(root, "items");

    while (sqlite3_step(stmt) == SQLITE_ROW) {
        cJSON *item = cJSON_CreateObject();
        cJSON_AddNumberToObject(item, "id", sqlite3_column_int(stmt, 0));
        cJSON_AddStringToObject(item, "type", (const char *) sqlite3_column_text(stmt, 1));
        cJSON_AddStringToObject(item, "title", (const char *) sqlite3_column_text(stmt, 2));
        cJSON_AddStringToObject(item, "message", (const char *) sqlite3_column_text(stmt, 3));
        cJSON_AddNumberToObject(item, "related_id", sqlite3_column_int(stmt, 4));
        cJSON_AddStringToObject(item, "created_at", (const char *) sqlite3_column_text(stmt, 5));
        cJSON_AddBoolToObject(item, "read", sqlite3_column_int(stmt, 6) == 1);
        cJSON_AddItemToArray(items, item);
    }
    sqlite3_finalize(stmt);

    int ret = send_json(connection, MHD_HTTP_OK, root);
    cJSON_Delete(root);
    return ret;
}

static int handle_export_financial_csv(struct MHD_Connection *connection, const char *month) {
    char current[MONTH_LEN];
    if (!month || strlen(month) != 7) {
        current_month(current);
        month = current;
    }

    sqlite3_stmt *stmt = NULL;
    double expected = 0;
    double collected = 0;
    double overdue = 0;
    double expenses = 0;

    const char *sql =
        "SELECT IFNULL(SUM(amount),0), "
        "IFNULL(SUM(CASE WHEN status='paid' THEN amount + late_fee ELSE 0 END),0),"
        "IFNULL(SUM(CASE WHEN status='overdue' THEN amount + late_fee ELSE 0 END),0)"
        "FROM rent_charges WHERE month=?";
    if (sqlite3_prepare_v2(g_app.db, sql, -1, &stmt, NULL) == SQLITE_OK) {
        sqlite3_bind_text(stmt, 1, month, -1, SQLITE_TRANSIENT);
        if (sqlite3_step(stmt) == SQLITE_ROW) {
            expected = sqlite3_column_double(stmt, 0);
            collected = sqlite3_column_double(stmt, 1);
            overdue = sqlite3_column_double(stmt, 2);
        }
    }
    sqlite3_finalize(stmt);

    if (sqlite3_prepare_v2(g_app.db, "SELECT IFNULL(SUM(amount),0) FROM expenses WHERE substr(expense_date,1,7)=?", -1,
                           &stmt, NULL) == SQLITE_OK) {
        sqlite3_bind_text(stmt, 1, month, -1, SQLITE_TRANSIENT);
        if (sqlite3_step(stmt) == SQLITE_ROW) {
            expenses = sqlite3_column_double(stmt, 0);
        }
    }
    sqlite3_finalize(stmt);

    char *csv = calloc(4096, 1);
    if (!csv) {
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "memory_allocation_failed");
    }

    snprintf(csv, 4095,
             "month,expected,collected,overdue,expenses,net_income\n"
             "%s,%.2f,%.2f,%.2f,%.2f,%.2f\n",
             month, expected, collected, overdue, expenses, collected - expenses);

    struct MHD_Response *response = MHD_create_response_from_buffer(strlen(csv), csv, MHD_RESPMEM_MUST_FREE);
    if (!response) {
        free(csv);
        return MHD_NO;
    }
    MHD_add_response_header(response, "Content-Type", "text/csv");
    MHD_add_response_header(response, "Content-Disposition", "attachment; filename=financial_export.csv");
    add_cors_headers(response);
    int ret = MHD_queue_response(connection, MHD_HTTP_OK, response);
    MHD_destroy_response(response);
    return ret;
}

static int handle_export_tax_csv(struct MHD_Connection *connection, const char *year) {
    char year_buf[16] = {0};
    if (!year || strlen(year) != 4) {
        time_t now = time(NULL);
        struct tm tm_now;
        localtime_r(&now, &tm_now);
        snprintf(year_buf, sizeof(year_buf), "%04d", tm_now.tm_year + 1900);
        year = year_buf;
    }

    sqlite3_stmt *stmt = NULL;
    const char *sql =
        "SELECT substr(month,1,7), "
        "IFNULL(SUM(CASE WHEN status='paid' THEN amount + late_fee ELSE 0 END),0),"
        "IFNULL((SELECT SUM(e.amount) FROM expenses e WHERE substr(e.expense_date,1,7)=substr(rc.month,1,7)),0)"
        "FROM rent_charges rc WHERE month LIKE ? || '-%' "
        "GROUP BY substr(month,1,7) ORDER BY substr(month,1,7)";

    if (sqlite3_prepare_v2(g_app.db, sql, -1, &stmt, NULL) != SQLITE_OK) {
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "db_prepare_failed");
    }
    sqlite3_bind_text(stmt, 1, year, -1, SQLITE_TRANSIENT);

    char *csv = calloc(16384, 1);
    if (!csv) {
        sqlite3_finalize(stmt);
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "memory_allocation_failed");
    }

    strcat(csv, "month,revenue,expenses,net_income\n");
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        char line[256];
        const char *month = (const char *) sqlite3_column_text(stmt, 0);
        double rev = sqlite3_column_double(stmt, 1);
        double exp = sqlite3_column_double(stmt, 2);
        snprintf(line, sizeof(line), "%s,%.2f,%.2f,%.2f\n", month, rev, exp, rev - exp);
        if (strlen(csv) + strlen(line) < 16380) {
            strcat(csv, line);
        }
    }
    sqlite3_finalize(stmt);

    struct MHD_Response *response = MHD_create_response_from_buffer(strlen(csv), csv, MHD_RESPMEM_MUST_FREE);
    if (!response) {
        free(csv);
        return MHD_NO;
    }
    MHD_add_response_header(response, "Content-Type", "text/csv");
    MHD_add_response_header(response, "Content-Disposition", "attachment; filename=tax_summary.csv");
    add_cors_headers(response);
    int ret = MHD_queue_response(connection, MHD_HTTP_OK, response);
    MHD_destroy_response(response);
    return ret;
}

static int handle_export_monthly_pdf(struct MHD_Connection *connection, const char *month) {
    char current[MONTH_LEN];
    if (!month || strlen(month) != 7) {
        current_month(current);
        month = current;
    }

    cJSON *overview = cJSON_CreateObject();
    add_financial_overview_fields(overview, month);

    char body[2048];
    snprintf(body, sizeof(body),
             "Month %s | Expected %.2f | Collected %.2f | Overdue %.2f | Collection %.2f%% | Tenants %.0f | Vacant %.0f",
             month, cJSON_GetObjectItem(overview, "expected_rent")->valuedouble,
             cJSON_GetObjectItem(overview, "collected")->valuedouble,
             cJSON_GetObjectItem(overview, "overdue")->valuedouble,
             cJSON_GetObjectItem(overview, "collection_percentage")->valuedouble,
             cJSON_GetObjectItem(overview, "total_tenants")->valuedouble,
             cJSON_GetObjectItem(overview, "vacant_units")->valuedouble);
    cJSON_Delete(overview);

    char path[768];
    snprintf(path, sizeof(path), "%s/monthly_report_%s.pdf", g_app.generated_dir, month);

    if (!generate_simple_pdf(path, "Monthly Financial Report", body)) {
        return send_error(connection, MHD_HTTP_INTERNAL_SERVER_ERROR, "pdf_generation_failed");
    }

    return send_pdf_file(connection, path);
}

static int route_request(struct MHD_Connection *connection, const char *url, const char *method, const char *body) {
    if (strcmp(method, "OPTIONS") == 0) {
        return send_response(connection, MHD_HTTP_NO_CONTENT, "text/plain", "", 0);
    }

    if (strcmp(url, "/health") == 0 && strcmp(method, "GET") == 0) {
        return handle_health(connection);
    }

    pthread_mutex_lock(&g_app.db_lock);

    int ret = MHD_NO;
    AuthUser auth_user;
    auth_user_clear(&auth_user);

    int needs_auth = starts_with(url, "/api/") && strcmp(url, "/api/auth/login") != 0 && strcmp(url, "/api/pre-register") != 0;

    if (needs_auth && !authenticate_request(connection, &auth_user)) {
        pthread_mutex_unlock(&g_app.db_lock);
        return send_error(connection, MHD_HTTP_UNAUTHORIZED, "unauthorized");
    }
    if (needs_auth && !has_route_access(&auth_user, url)) {
        pthread_mutex_unlock(&g_app.db_lock);
        return send_error(connection, MHD_HTTP_FORBIDDEN, "forbidden");
    }

    run_automation_cycle();

    if (strcmp(url, "/api/auth/login") == 0 && strcmp(method, "POST") == 0) {
        char auth_ip[CLIENT_IP_LEN];
        get_client_ip(connection, auth_ip);
        if (!rate_limit_check(g_auth_buckets, auth_ip, RATE_LIMIT_AUTH_RPM)) {
            pthread_mutex_unlock(&g_app.db_lock);
            struct MHD_Response *r = MHD_create_response_from_buffer(
                29, (void *)"{\"error\":\"too_many_requests\"}", MHD_RESPMEM_PERSISTENT);
            add_cors_headers(r);
            MHD_add_response_header(r, "Retry-After", "60");
            int rv = MHD_queue_response(connection, MHD_HTTP_TOO_MANY_REQUESTS, r);
            MHD_destroy_response(r);
            return rv;
        }
        ret = handle_login(connection, body);
        goto done;
    }
    if (strcmp(url, "/api/auth/me") == 0 && strcmp(method, "GET") == 0) {
        ret = handle_auth_me(connection, &auth_user);
        goto done;
    }
    if (strcmp(url, "/api/auth/logout") == 0 && strcmp(method, "POST") == 0) {
        ret = handle_logout(connection, auth_user.id);
        goto done;
    }
    if (strcmp(url, "/api/pre-register") == 0 && strcmp(method, "POST") == 0) {
        ret = handle_create_pre_register(connection, body);
        goto done;
    }

    if (strcmp(url, "/api/dashboard/summary") == 0 && strcmp(method, "GET") == 0) {
        ret = handle_dashboard_summary(connection, MHD_lookup_connection_value(connection, MHD_GET_ARGUMENT_KIND, "month"));
        goto done;
    }

    if (strcmp(url, "/api/tenants") == 0 && strcmp(method, "GET") == 0) {
        ret = handle_get_tenants(connection);
        goto done;
    }
    if (strcmp(url, "/api/tenants") == 0 && strcmp(method, "POST") == 0) {
        ret = handle_create_tenant(connection, body);
        goto done;
    }
    if (strcmp(url, "/api/pre-registrations") == 0 && strcmp(method, "GET") == 0) {
        ret = handle_get_pre_registrations(connection);
        goto done;
    }
    if (strcmp(url, "/api/users") == 0) {
        if (strcmp(method, "GET") == 0) {
            ret = handle_get_users(connection);
            goto done;
        }
        if (strcmp(method, "POST") == 0) {
            ret = handle_create_user(connection, body, &auth_user);
            goto done;
        }
    }

    int tenant_id = 0;
    if (parse_id_path(url, "/api/tenants/", &tenant_id)) {
        if (strcmp(method, "PUT") == 0) {
            ret = handle_update_tenant(connection, tenant_id, body);
            goto done;
        }
        if (strcmp(method, "DELETE") == 0) {
            const char *permanent_q = MHD_lookup_connection_value(connection, MHD_GET_ARGUMENT_KIND, "permanent");
            ret = handle_delete_tenant(connection, tenant_id, is_truthy(permanent_q));
            goto done;
        }
    }

    int pre_register_id = 0;
    if (parse_id_path(url, "/api/pre-registrations/", &pre_register_id) && strcmp(method, "DELETE") == 0) {
        ret = handle_delete_pre_registration(connection, pre_register_id);
        goto done;
    }

    int target_user_id = 0;
    if (parse_id_path(url, "/api/users/", &target_user_id)) {
        if (strcmp(method, "PUT") == 0) {
            ret = handle_update_user(connection, target_user_id, body, &auth_user);
            goto done;
        }
        if (strcmp(method, "DELETE") == 0) {
            ret = handle_delete_user(connection, target_user_id, &auth_user);
            goto done;
        }
    }

    if (strcmp(url, "/api/units") == 0 && strcmp(method, "GET") == 0) {
        ret = handle_get_units(connection, MHD_lookup_connection_value(connection, MHD_GET_ARGUMENT_KIND, "month"));
        goto done;
    }
    if (strcmp(url, "/api/units") == 0 && strcmp(method, "POST") == 0) {
        ret = handle_create_unit(connection, body);
        goto done;
    }

    int unit_id = 0;
    if (parse_id_path(url, "/api/units/", &unit_id)) {
        if (strcmp(method, "GET") == 0) {
            ret = handle_get_unit_detail(connection, unit_id);
            goto done;
        }
        if (strcmp(method, "PUT") == 0) {
            ret = handle_update_unit(connection, unit_id, body);
            goto done;
        }
    }

    if (strcmp(url, "/api/finance/overview") == 0 && strcmp(method, "GET") == 0) {
        ret = handle_finance_overview(connection, MHD_lookup_connection_value(connection, MHD_GET_ARGUMENT_KIND, "month"));
        goto done;
    }

    if (strcmp(url, "/api/finance/analytics") == 0 && strcmp(method, "GET") == 0) {
        ret = handle_finance_analytics(connection, MHD_lookup_connection_value(connection, MHD_GET_ARGUMENT_KIND, "year"));
        goto done;
    }

    if (strcmp(url, "/api/finance/intelligence") == 0 && strcmp(method, "GET") == 0) {
        ret = handle_finance_intelligence(connection,
                                          MHD_lookup_connection_value(connection, MHD_GET_ARGUMENT_KIND, "month"));
        goto done;
    }

    if (strcmp(url, "/api/payments") == 0) {
        if (strcmp(method, "POST") == 0) {
            ret = handle_create_payment(connection, body);
            goto done;
        }
        if (strcmp(method, "GET") == 0) {
            ret = handle_get_payments(connection,
                                      MHD_lookup_connection_value(connection, MHD_GET_ARGUMENT_KIND, "tenant_id"),
                                      MHD_lookup_connection_value(connection, MHD_GET_ARGUMENT_KIND, "month"));
            goto done;
        }
    }

    if (strcmp(url, "/api/expenses") == 0) {
        if (strcmp(method, "POST") == 0) {
            ret = handle_create_expense(connection, body);
            goto done;
        }
        if (strcmp(method, "GET") == 0) {
            ret = handle_get_expenses(connection, MHD_lookup_connection_value(connection, MHD_GET_ARGUMENT_KIND, "month"));
            goto done;
        }
    }

    if (strcmp(url, "/api/maintenance") == 0) {
        if (strcmp(method, "POST") == 0) {
            ret = handle_create_maintenance(connection, body);
            goto done;
        }
        if (strcmp(method, "GET") == 0) {
            ret = handle_get_maintenance(connection,
                                         MHD_lookup_connection_value(connection, MHD_GET_ARGUMENT_KIND, "status"));
            goto done;
        }
    }

    int ticket_id = 0;
    if (parse_id_path(url, "/api/maintenance/", &ticket_id) && strcmp(method, "PUT") == 0) {
        ret = handle_update_maintenance(connection, ticket_id, body);
        goto done;
    }

    if (strcmp(url, "/api/document-templates") == 0) {
        if (strcmp(method, "GET") == 0) {
            ret = handle_get_document_templates(connection);
            goto done;
        }
        if (strcmp(method, "POST") == 0) {
            ret = handle_create_document_template(connection, body);
            goto done;
        }
    }
    int template_id = 0;
    if (parse_id_path(url, "/api/document-templates/", &template_id) && strcmp(method, "PUT") == 0) {
        ret = handle_update_document_template(connection, template_id, body);
        goto done;
    }

    if (strcmp(url, "/api/documents/generate") == 0 && strcmp(method, "POST") == 0) {
        ret = handle_generate_document(connection, body);
        goto done;
    }

    if (strcmp(url, "/api/documents") == 0 && strcmp(method, "GET") == 0) {
        ret = handle_get_documents(connection, MHD_lookup_connection_value(connection, MHD_GET_ARGUMENT_KIND, "tenant_id"));
        goto done;
    }

    int doc_id = 0;
    if (parse_id_path(url, "/api/documents/download/", &doc_id) && strcmp(method, "GET") == 0) {
        ret = handle_download_document(connection, doc_id);
        goto done;
    }

    if (strcmp(url, "/api/notifications") == 0 && strcmp(method, "GET") == 0) {
        ret = handle_get_notifications(connection);
        goto done;
    }

    if (strcmp(url, "/api/exports/financial.csv") == 0 && strcmp(method, "GET") == 0) {
        ret = handle_export_financial_csv(connection, MHD_lookup_connection_value(connection, MHD_GET_ARGUMENT_KIND, "month"));
        goto done;
    }

    if (strcmp(url, "/api/exports/monthly-report.pdf") == 0 && strcmp(method, "GET") == 0) {
        ret = handle_export_monthly_pdf(connection,
                                        MHD_lookup_connection_value(connection, MHD_GET_ARGUMENT_KIND, "month"));
        goto done;
    }

    if (strcmp(url, "/api/exports/tax-summary.csv") == 0 && strcmp(method, "GET") == 0) {
        ret = handle_export_tax_csv(connection, MHD_lookup_connection_value(connection, MHD_GET_ARGUMENT_KIND, "year"));
        goto done;
    }

    ret = send_error(connection, MHD_HTTP_NOT_FOUND, "route_not_found");

done:
    pthread_mutex_unlock(&g_app.db_lock);
    return ret;
}

static enum MHD_Result request_handler(void *cls, struct MHD_Connection *connection, const char *url, const char *method,
                                       const char *version, const char *upload_data, size_t *upload_data_size,
                                       void **con_cls) {
    (void) cls;
    (void) version;

    ConnectionInfo *info = *con_cls;
    if (!info) {
        if (strcmp(method, "GET") != 0 && strcmp(method, "POST") != 0 &&
            strcmp(method, "PUT") != 0 && strcmp(method, "DELETE") != 0 &&
            strcmp(method, "PATCH") != 0 && strcmp(method, "OPTIONS") != 0 &&
            strcmp(method, "HEAD") != 0) {
            return send_error(connection, MHD_HTTP_METHOD_NOT_ALLOWED, "method_not_allowed");
        }
        if (!is_valid_path(url)) {
            return send_error(connection, MHD_HTTP_BAD_REQUEST, "invalid_path");
        }
        char client_ip[CLIENT_IP_LEN];
        get_client_ip(connection, client_ip);
        if (!rate_limit_check(g_global_buckets, client_ip, RATE_LIMIT_GLOBAL_RPM)) {
            struct MHD_Response *r = MHD_create_response_from_buffer(
                29, (void *)"{\"error\":\"too_many_requests\"}", MHD_RESPMEM_PERSISTENT);
            add_cors_headers(r);
            MHD_add_response_header(r, "Retry-After", "60");
            int rv = MHD_queue_response(connection, MHD_HTTP_TOO_MANY_REQUESTS, r);
            MHD_destroy_response(r);
            return rv;
        }
        info = calloc(1, sizeof(ConnectionInfo));
        if (!info) {
            return MHD_NO;
        }
        *con_cls = info;
        return MHD_YES;
    }

    if ((strcmp(method, "POST") == 0 || strcmp(method, "PUT") == 0 || strcmp(method, "PATCH") == 0) &&
        *upload_data_size > 0) {
        if (info->size + *upload_data_size > MAX_BODY_BYTES) {
            return MHD_NO;
        }
        char *new_data = realloc(info->data, info->size + *upload_data_size + 1);
        if (!new_data) {
            return MHD_NO;
        }
        info->data = new_data;
        memcpy(info->data + info->size, upload_data, *upload_data_size);
        info->size += *upload_data_size;
        info->data[info->size] = '\0';

        *upload_data_size = 0;
        return MHD_YES;
    }

    return route_request(connection, url, method, info->data ? info->data : "");
}

static void request_completed(void *cls, struct MHD_Connection *connection, void **con_cls,
                              enum MHD_RequestTerminationCode toe) {
    (void) cls;
    (void) connection;
    (void) toe;
    ConnectionInfo *info = *con_cls;
    if (info) {
        free(info->data);
        free(info);
        *con_cls = NULL;
    }
}

int main(void) {
    memset(&g_app, 0, sizeof(g_app));
    pthread_mutex_init(&g_app.db_lock, NULL);

    const char *db_path_env = getenv("DB_PATH");
    const char *port_env = getenv("PORT");
    const char *bind_env = getenv("BIND_ADDRESS");
    const char *cors_env = getenv("CORS_ORIGIN");
    const char *proxy_env = getenv("TRUST_PROXY");

    const char *addr_str = bind_env ? bind_env : "127.0.0.1";
    if (cors_env && cors_env[0] != '\0') {
        snprintf(g_cors_origin, sizeof(g_cors_origin), "%s", cors_env);
    }
    if (proxy_env && strcmp(proxy_env, "1") == 0) {
        g_trust_proxy = 1;
    }

    snprintf(g_app.db_path, sizeof(g_app.db_path), "%s", db_path_env ? db_path_env : "./data/realstate.db");
    snprintf(g_app.generated_dir, sizeof(g_app.generated_dir), "%s", "./generated");

    if (!ensure_directories()) {
        return 1;
    }

    if (!db_init()) {
        return 1;
    }

    unsigned short port = (unsigned short) (port_env ? atoi(port_env) : DEFAULT_PORT);
    if (port == 0) {
        port = DEFAULT_PORT;
    }

    struct sockaddr_in bind_addr;
    memset(&bind_addr, 0, sizeof(bind_addr));
    bind_addr.sin_family = AF_INET;
    bind_addr.sin_port = htons(port);
    if (inet_pton(AF_INET, addr_str, &bind_addr.sin_addr) != 1) {
        fprintf(stderr, "Invalid BIND_ADDRESS: %s\n", addr_str);
        sqlite3_close(g_app.db);
        pthread_mutex_destroy(&g_app.db_lock);
        return 1;
    }

    struct MHD_Daemon *daemon =
        MHD_start_daemon(MHD_USE_INTERNAL_POLLING_THREAD, port, NULL, NULL, &request_handler, NULL,
                         MHD_OPTION_CONNECTION_TIMEOUT, (unsigned int) 120, MHD_OPTION_NOTIFY_COMPLETED,
                         request_completed, NULL, MHD_OPTION_SOCK_ADDR, (struct sockaddr *)&bind_addr,
                         MHD_OPTION_END);

    if (!daemon) {
        fprintf(stderr, "Failed to start HTTP server on %s:%hu\n", addr_str, port);
        sqlite3_close(g_app.db);
        pthread_mutex_destroy(&g_app.db_lock);
        return 1;
    }

    printf("Oliveira Costa Real Estate API running on %s:%hu\n", addr_str, port);

    while (1) {
        sleep(1);
    }

    MHD_stop_daemon(daemon);
    sqlite3_close(g_app.db);
    pthread_mutex_destroy(&g_app.db_lock);
    return 0;
}
