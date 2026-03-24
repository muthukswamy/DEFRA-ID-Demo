# DEFRA Mock Service

A GOV.UK-styled mock service demonstrating integration with [DEFRA Customer Identity (DEFRA ID)](https://github.com/DEFRA), an Azure AD B2C-based identity provider. It shows how to handle OIDC authentication, organisation relationships, and fine-grained access control using GOV.UK Design System components.

## Features

- **OIDC authentication** via DEFRA ID (Azure AD B2C) with PKCE
- **Organisation relationships** — employees and intermediaries, multi-org support
- **Service roles** — admin and member, with admin bootstrap and orphan record transfer
- **Records with fine-grained authorisation (FGA)** — per-record owner/editor/viewer permissions
- **Org-wide and admin-wide wildcard grants** (`__org__`, `__org_admin__`)
- **Full audit history** for record lifecycle and permission changes
- **Soft delete** with audit trail preservation
- **Session management** — server-side SQLite sessions (drop-in Redis for production)
- **Automatic token refresh** using refresh tokens

## Tech stack

| Component | Technology |
|---|---|
| Framework | [Hapi.js](https://hapi.dev) v21 |
| Templates | Nunjucks + [GOV.UK Frontend](https://frontend.design-system.service.gov.uk) v6 |
| Auth | OpenID Connect via [openid-client](https://github.com/panva/node-openid-client) |
| Sessions | [@hapi/yar](https://github.com/hapijs/yar) backed by SQLite |
| Database | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) |
| Runtime | Node.js ≥ 20 |

## Prerequisites

- Node.js 20 or later ([`.nvmrc`](.nvmrc) pins the version — run `nvm use` if you use nvm)
- A DEFRA ID client registration (client ID, client secret, service ID)

## Local setup

### 1. Clone and install dependencies

```bash
git clone <repo-url>
cd defra_service
npm install
```

### 2. Configure environment variables

Copy the example file and fill in your DEFRA ID credentials:

```bash
cp .env.example .env
```

Open `.env` and set at minimum:

| Variable | Description |
|---|---|
| `DEFRA_ID_WELL_KNOWN_URL` | OIDC discovery endpoint for your B2C tenant |
| `DEFRA_ID_CLIENT_ID` | OAuth2 client ID |
| `DEFRA_ID_CLIENT_SECRET` | OAuth2 client secret |
| `DEFRA_ID_SERVICE_ID` | Service identifier provided during DEFRA ID onboarding |
| `DEFRA_ID_SCOPES` | Comma-separated scopes, e.g. `openid,offline_access,<client-id>` |
| `DEFRA_ACCOUNT_URL` | Base URL for DEFRA account management |
| `SESSION_SECRET` | Random string ≥ 32 characters for cookie encryption |

All other variables have sensible defaults for local development. See [`.env.example`](.env.example) for the full list with comments.

### 3. Start the server

```bash
# Development (auto-restarts on file changes)
npm run dev

# Production
npm start
```

The service will be available at **http://localhost:3000** (or the port set in `PORT`).

The SQLite database files are created automatically in `data/` on first run — no migrations needed.

## Environment variables reference

| Variable | Default | Required | Description |
|---|---|---|---|
| `PORT` | `3000` | No | Port to listen on |
| `NODE_ENV` | `development` | No | `development` or `production` |
| `SESSION_SECRET` | *(dev default)* | **Yes (prod)** | Cookie encryption secret |
| `ENABLE_DEFRA_ID` | `true` | No | Set to `false` to bypass auth in development |
| `DEFRA_ID_WELL_KNOWN_URL` | — | **Yes** | OIDC discovery document URL |
| `DEFRA_ID_CLIENT_ID` | — | **Yes** | OAuth2 client ID |
| `DEFRA_ID_CLIENT_SECRET` | — | **Yes** | OAuth2 client secret |
| `DEFRA_ID_SERVICE_ID` | — | **Yes** | DEFRA ID service identifier |
| `DEFRA_ID_SCOPES` | — | **Yes** | Comma-separated OIDC scopes |
| `DEFRA_ID_REDIRECT_URL` | `http://localhost:3000/login/return` | No | OAuth2 callback URL |
| `DEFRA_ID_POST_LOGOUT_URL` | `http://localhost:3000/signed-out` | No | Post-logout redirect |
| `DEFRA_ID_REFRESH_TOKENS` | `true` | No | Enable refresh token rotation |
| `DEFRA_ID_AAL` | — | No | Assurance level (`1` = password, `2` = MFA) |
| `DEFRA_ID_FORCE_MFA` | — | No | Force MFA on every sign-in |
| `DEFRA_ID_FORCE_RESELECTION` | — | No | Prompt org reselection for multi-org users |
| `DEFRA_ACCOUNT_URL` | — | **Yes** | DEFRA account management base URL |
| `DEFRA_ENROL_ORG_URL` | *(derived)* | No | Override org enrolment journey URL |

## Project structure

```
src/
├── config.js           — Environment config and OIDC client initialisation
├── server.js           — Hapi server, plugins, routes, and response lifecycle
├── middleware/
│   └── auth.js         — requireAuth pre-method, token refresh, session enrichment
├── plugins/
│   └── nunjucks.js     — Nunjucks environment setup and GOV.UK macro registration
├── routes/
│   ├── auth.js         — /login, /login/return, /signed-out
│   ├── dashboard.js    — /dashboard
│   ├── records.js      — /records and FGA sub-routes
│   └── team.js         — /team (admin only)
├── store/
│   ├── relationships.js — SQLite store for users, orgs, team members, sessions
│   ├── records.js       — SQLite store for records, permissions, and audit history
│   └── session.js       — Catbox-compatible SQLite session cache adapter
└── views/
    ├── layouts/         — Base layout template
    ├── records/         — Record list, view, edit, share, history, delete confirm
    ├── errors/          — 403, 404, 500 error pages
    └── *.njk            — Dashboard, account, team, signed-out pages
```

## Sessions

Sessions are stored server-side in SQLite (`data/sessions.db`). The browser cookie holds only an encrypted session ID. To switch to Redis in production, replace the `CatboxSqlite` cache provider in `src/server.js` with [`@hapi/catbox-redis`](https://github.com/hapijs/catbox-redis).

Session TTL is **1 hour**, configurable via `config.session.maxAge`.

## Records and permissions

Records use a fine-grained authorisation model stored in the `record_permissions` table:

| Grantee | Meaning |
|---|---|
| `<user sub>` | Individual grant (owner / editor / viewer) |
| `__org__` | All active org members get the specified permission |
| `__org_admin__` | All org admins get viewer access (automatic, set on record creation) |

Permission precedence (highest wins): **owner > editor > viewer**.
