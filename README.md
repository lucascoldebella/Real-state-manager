# Oliveira Costa Real Estate Management Dashboard

Production-style condominium management system with:
- **Backend**: C (`libmicrohttpd` + `sqlite3` + `cJSON`)
- **Frontend**: Next.js 15 + TypeScript + Recharts
- **Target**: Linux

## Features implemented
- Secure login + bearer token auth (admin role, role-ready data model)
- Main dashboard with financial summary + 25-unit status control grid
- Tenant lifecycle management (list/create/edit/delete + unit association)
- Unit management with payment and maintenance history
- Finance module (payments, expenses, monthly overview, analytics, intelligence)
- Document templates with placeholder replacement and PDF generation
- Maintenance tickets with lifecycle status and image-path field
- Notification center (due soon, overdue, contracts expiring, open maintenance)
- Exports: monthly financial CSV, monthly PDF report, tax-ready yearly CSV
- Responsive SaaS UI (desktop + mobile drawer + modal-based create flows)

## Run locally

### Fast start (recommended)
```bash
cd /home/lucas/Documents/Development/oliveira-costa-real-estate
./build-local.sh
./run-local.sh
```

`run-local.sh` now defaults to stable production mode (`next start`).
If you need hot reload for development:
```bash
RUN_MODE=dev ./run-local.sh
```

### Full restart (kills services, clears cache, rebuilds, starts again)
```bash
cd /home/lucas/Documents/Development/oliveira-costa-real-estate
./restart-all.sh
```

### 1) Backend
```bash
cd backend
make
cp .env.example .env
export $(grep -v '^#' .env | xargs)
./realstate_api
```

Backend default:
- URL: `http://127.0.0.1:8090`
- Also reachable as: `http://localhost:8090`
- Health: `GET /health`

### 2) Frontend
```bash
cd frontend
npm install
cp .env.example .env.local
npm run dev
```

Frontend default:
- URL: `http://127.0.0.1:5173`
- Also reachable as: `http://localhost:5173`

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8090` | HTTP listen port |
| `DB_PATH` | `./data/realstate.db` | Path to SQLite database file, relative to the backend working directory |
| `BIND_ADDRESS` | `127.0.0.1` | Address to bind the HTTP server to. **Never set to `0.0.0.0` in production** |
| `CORS_ORIGIN` | `http://localhost:5173` | Allowed CORS origin (single origin, no wildcards) |
| `TRUST_PROXY` | `0` | Set to `1` when behind Nginx to read client IP from `X-Real-IP` header |

## Deploy workflow

The intended workflow is:
- code and test locally
- deploy code to the VPS with `./scripts/deploy.sh`
- treat the VPS SQLite database as the source of truth
- pull the VPS database back locally with `./scripts/db-sync.sh pull`

### Safe deploy behavior

`./scripts/deploy.sh` keeps the one-command flow, but it does **not** auto-commit local-only runtime files:
- `backend/.env`
- `frontend/.env.local`
- `backend/data/`
- `backend/generated/`
- root `data/`
- root `dumps/`
- root `generated/`

That keeps local database copies and machine-specific config out of production commits.

### Database sync

```bash
./scripts/db-sync.sh pull
```

Pull mode:
- downloads the VPS database
- stores a timestamped backup in `dumps/`
- verifies SQLite integrity
- overwrites the local dev database only after confirmation

```bash
./scripts/db-sync.sh push
```

Push mode is intentionally manual and should be rare:
- verifies the local SQLite database before upload
- creates a timestamped backup of the VPS database first
- uploads to a temporary file on the VPS
- verifies integrity again on the VPS
- replaces the production DB and restarts `realstate-backend`

## API highlights
- `POST /api/auth/login`
- `GET /api/dashboard/summary`
- `GET|POST|PUT|DELETE /api/tenants`
- `GET|PUT /api/units`
- `GET /api/finance/overview`
- `GET /api/finance/analytics`
- `GET /api/finance/intelligence`
- `GET|POST /api/payments`
- `GET|POST /api/expenses`
- `GET|POST|PUT /api/maintenance`
- `GET|POST /api/document-templates`
- `GET|POST /api/documents`
- `GET /api/documents/download/:id`
- `GET /api/notifications`
- `GET /api/exports/financial.csv`
- `GET /api/exports/monthly-report.pdf`
- `GET /api/exports/tax-summary.csv`

## Security

### Architecture

The backend **must not** be exposed directly to the internet. The production architecture is:

```
Internet -> Nginx (TLS + rate limiting) -> 127.0.0.1:8090 (C backend)
```

Current production URL:
- `https://oc.coldnb.com`

Deployment files are in `deploy/`:
- `realstate.service` — systemd unit with full sandboxing
- `nginx-realstate.conf` — Nginx reverse proxy with TLS, rate limiting, and bot blocking

### Hardening applied (2026-03-02)

**Network isolation**
- The HTTP server binds to `127.0.0.1` only (`BIND_ADDRESS` env var). It is unreachable from external networks without a reverse proxy.
- CORS is restricted to a single explicit origin (`CORS_ORIGIN` env var). Wildcard `*` is not used.

**Rate limiting**
- Global: 60 requests/minute per IP (token bucket). Returns `429 Too Many Requests` with `Retry-After` header.
- Auth endpoint (`/api/auth/login`): 5 requests/minute per IP.
- Pre-registration: 10 requests per 10-minute window per IP (unchanged).
- Nginx adds a second layer: connection limits per IP + request rate zones.

**Request validation**
- Unknown HTTP methods are rejected with `405 Method Not Allowed`.
- Paths longer than 2048 characters, containing `..`, or containing control characters are rejected with `400 Bad Request`.

**Authorization**
- Unrecognized routes return `403 Forbidden` by default (deny-by-default). Only explicitly listed route prefixes are authorized per role.

**Response headers**
Every response includes:
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Cache-Control: no-store`
- `Content-Security-Policy: default-src 'none'`

**Binary hardening (compiler/linker)**
- `-fstack-protector-strong` — stack canaries
- `-D_FORTIFY_SOURCE=2` — buffer overflow detection in libc functions
- `-fPIE -pie` — position-independent executable (ASLR)
- `-Wl,-z,relro,-z,now` — full RELRO (GOT protection)
- `-Werror` — warnings treated as errors

**Token generation**
- Tokens are generated from `/dev/urandom` exclusively. If `/dev/urandom` is unavailable, the server aborts rather than falling back to a predictable PRNG.

**systemd sandboxing** (`deploy/realstate.service`)
- `ProtectSystem=strict`, `ProtectHome=true`, `PrivateTmp=true`, `PrivateDevices=true`
- `MemoryDenyWriteExecute=true` — blocks runtime code generation (JIT shellcode)
- `NoNewPrivileges=true` — prevents privilege escalation via setuid
- `SystemCallFilter=~@mount @swap @reboot @raw-io @module @debug` — blocks dangerous syscalls
- `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX` — no raw sockets
- Resource limits: `LimitNPROC=64`, `MemoryMax=256M`, `TasksMax=32`
- Only `data/` and `generated/` are writable

**Nginx layer** (`deploy/nginx-realstate.conf`)
- TLS termination (TLSv1.2+)
- Scanner/bot user-agent blocking (nmap, nikto, sqlmap, masscan, etc.)
- Per-IP connection limits
- `server_tokens off` — hides Nginx version
- `X-Real-IP` / `X-Forwarded-For` forwarded to backend

### Security practices for future patches

When modifying the backend, follow these rules:

1. **Never bind to `0.0.0.0`**. All services must bind to `127.0.0.1` and sit behind the Nginx reverse proxy. This is non-negotiable — the VPS was previously compromised through an exposed port.

2. **Never print credentials to stdout/logs**. Secrets belong in environment variables or files with restricted permissions, not in startup banners or log output.

3. **Deny by default**. New routes must be explicitly added to `has_route_access()` with the appropriate permission check. The function returns `0` (deny) for any route it does not recognize.

4. **Compile with full hardening flags**. The Makefile includes `-Werror`, stack protectors, FORTIFY_SOURCE, PIE, and full RELRO. Never remove these flags. A build that produces warnings must be fixed, not silenced.

5. **Use `/dev/urandom` for all randomness**. Never fall back to `rand()`/`srand()`. If the entropy source is unavailable, the server must refuse to start.

6. **Validate all input at the boundary**. Paths are validated before routing. Request bodies are size-limited. SQL parameters use SQLite's `%q` escaping. Any new endpoint that accepts user input must validate it before processing.

7. **Rate limit sensitive endpoints**. Authentication, registration, and any endpoint that performs expensive operations or reveals information must have per-IP rate limiting.

8. **Keep security headers on every response**. The `add_cors_headers()` function adds both CORS and security headers to every response. New response paths must go through `send_response()` or `send_json()` to inherit these headers automatically.

9. **Test hardening after every build**. After `make`:
   - `file realstate_api` must show `pie executable`
   - `readelf -l realstate_api | grep GNU_RELRO` must show a RELRO segment
   - The server must print `127.0.0.1:<port>` on startup, not `0.0.0.0`
   - `curl -D- http://127.0.0.1:8090/health` must show all security headers

10. **Keep the systemd sandbox tight**. New filesystem paths needed by the backend must be added to `ReadWritePaths=` explicitly. Never relax `ProtectSystem`, `MemoryDenyWriteExecute`, or `NoNewPrivileges`.

### Known limitations (not yet addressed)

- **Password hashing uses SHA-256 with a hardcoded salt**. Migrating to bcrypt/argon2 requires a database migration to re-hash all passwords. This is a future improvement, not a patch-level fix.
- **Frontend stores tokens in localStorage**. This is a frontend concern; the backend validates tokens correctly.

## Scalability notes
- Data model is property-first (`properties` + `units`) and not hardcoded to 25 units.
- Role field is persisted in users for future authorization expansion.
- Financial and automation workflows are server-side and reusable for multi-property evolution.
