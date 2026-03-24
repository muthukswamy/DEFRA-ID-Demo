# Architecture overview

## Summary

DEFRA Mock Service is a GOV.UK-styled Hapi.js application that demonstrates OIDC integration with DEFRA Customer Identity (DEFRA ID), an Azure AD B2C-based identity provider. It manages organisation relationships, service roles, and fine-grained record access control.

## Stack

| Layer | Technology | Notes |
|---|---|---|
| Web framework | Hapi.js v21 | Plugin-based, pre-methods for route guards |
| Templates | Nunjucks + GOV.UK Frontend v6 | Server-side rendering only |
| Auth | openid-client v5 | PKCE Authorization Code flow |
| Sessions | @hapi/yar + SQLite | Server-side; cookie holds session ID only |
| Database | better-sqlite3 | Synchronous SQLite; single file |
| Runtime | Node.js ≥ 20 | |

## Key design decisions

### Server-side rendering only
No client-side JavaScript framework. All state lives in the server session or SQLite. GOV.UK Design System components are rendered server-side via Nunjucks macros.

### Synchronous SQLite
`better-sqlite3` is synchronous, which simplifies control flow in a single-process Node.js app. All queries are prepared statements, created once at module load. There is no connection pool — SQLite handles concurrent reads natively.

### Single database file
All tables (users, relationships, sessions, records, permissions, history) live in one SQLite file. This makes local development simple: inspect the database with any SQLite browser, or delete the file to reset state.

### Hapi pre-methods for auth
Route guards are implemented as Hapi pre-methods (`requireAuth`, `requireOrgMember`, `requireOrgAdmin`) rather than middleware. This keeps auth logic co-located with routes and allows route-specific permission checks without global middleware.

### Token-first, store-second
User data flows in two layers:
1. The OIDC JWT is the source of truth for current relationships and claims.
2. SQLite accumulates historical data across sign-ins (orgs seen, roles, service membership).

Both are merged on every sign-in. Routes read from the enriched session user object, which combines JWT claims with stored state.

## Request lifecycle

```
Browser → Hapi router
         ↓
  [requireAuth pre-method]
    - Check session has tokens
    - If access token expired → silent refresh via OIDC
    - If no tokens → redirect to /login
         ↓
  [requireOrgMember or requireOrgAdmin pre-method]  (on protected routes)
    - Check user has active org membership in service_team_members
    - Check admin status if needed
         ↓
  Route handler
    - Read from SQLite stores
    - Build view context
    - Render Nunjucks template
         ↓
  [onPreResponse extension]
    - Inject isAuthenticated, user, sessionExpiringSoon into every view
    - Apply security headers (HSTS, CSP, XSS, noSniff)
    - Handle 404/500 errors
```

## Module map

```
src/
├── config.js              — Environment config, OIDC client (singleton, lazy-loaded)
├── server.js              — Hapi setup, plugins, routes, response lifecycle
│
├── middleware/
│   └── auth.js            — JWT parsing, token refresh, session enrichment
│
├── routes/
│   ├── auth.js            — /login, /login/return, /logout, /refresh
│   ├── dashboard.js       — /dashboard, /account, /add-organisation
│   ├── team.js            — /team (admin only)
│   └── records.js         — /records and all sub-routes
│
├── store/
│   ├── relationships.js   — Users, orgs, relationships, service_team_members tables
│   ├── records.js         — Records, permissions, history tables
│   └── session.js         — Catbox-compatible SQLite session adapter
│
└── views/
    ├── layouts/base.njk   — Shell with nav, phase banner, session warning
    ├── records/           — List, view, edit, share, history, delete-confirm
    ├── errors/            — 403, 404, 500
    └── *.njk              — Dashboard, account, team, signed-out
```

## Security posture

| Concern | Approach |
|---|---|
| Auth code interception | PKCE (S256 challenge) |
| CSRF on auth callback | Server-side PKCE state store (not cookie) |
| Session fixation | `yar.reset()` on logout |
| XSS | Nunjucks auto-escaping; Content Security Policy |
| Clickjacking | `frame-ancestors 'none'` in CSP |
| Cookie theft | HttpOnly + SameSite=Lax; Secure in production |
| Stale sessions | 1-hour TTL; auto-purge of expired session rows |
| Secret exposure | Production startup throws if SESSION_SECRET is default |

## Production considerations

| Item | Current (dev) | Production recommendation |
|---|---|---|
| Session store | SQLite | Replace `CatboxSqlite` with `@hapi/catbox-redis` |
| Database | SQLite file | PostgreSQL or managed RDS |
| HTTPS | Optional | Required (`isSecure: true` on cookies) |
| Logging | Pino to stdout | Ship to centralised log aggregator |
| Secret management | `.env` file | Secrets Manager / Key Vault |
