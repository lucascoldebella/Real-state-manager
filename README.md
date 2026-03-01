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
cd /home/lucas/oliveira-costa-real-estate
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
cd /home/lucas/oliveira-costa-real-estate
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
- Health: `GET /health`
- Admin login: `admin@imobiliaria.local` / `ChangeThisNow123!`

### 2) Frontend
```bash
cd frontend
npm install
cp .env.example .env.local
npm run dev
```

Frontend default:
- URL: `http://127.0.0.1:5173`

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

## Scalability notes
- Data model is property-first (`properties` + `units`) and not hardcoded to 25 units.
- Role field is persisted in users for future authorization expansion.
- Financial and automation workflows are server-side and reusable for multi-property evolution.
