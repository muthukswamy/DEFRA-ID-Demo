# Sessions

## Overview

Sessions are managed server-side using [@hapi/yar](https://github.com/hapijs/yar) with a custom SQLite-backed cache. The browser cookie holds only an encrypted session ID — no session data is stored client-side.

---

## Storage

Sessions are stored in the `sessions` table in the SQLite database, via a custom Catbox-compatible adapter (`src/store/session.js`).

Each row holds:
- `segment` + `id`: composite key (Catbox convention; segment is the cache name, id is the session identifier)
- `value`: JSON-encoded session data (tokens, user object)
- `stored_at`: when the row was written (milliseconds)
- `expires_at`: when the row expires (milliseconds)

### Auto-purge

A timer runs every 5 minutes to delete rows where `expires_at < now`. The timer uses `.unref()` so it does not prevent the Node.js process from exiting.

Expired rows are also caught lazily on read: if a `get()` call finds a row with `expires_at < now`, it deletes the row and returns `null`.

---

## Session TTL

The session lasts **1 hour**, configured in `src/config.js`:

```js
session: {
  maxAge: 60 * 60 * 1000  // 1 hour in milliseconds
}
```

This is applied as `expiresIn` on the Yar store configuration in `src/server.js`.

---

## Cookie configuration

| Setting | Value | Reason |
|---|---|---|
| `maxCookieSize: 0` | Forces server-side storage | Cookie contains session ID only |
| `isHttpOnly: true` | Cookie not accessible from JavaScript | Prevents XSS token theft |
| `isSameSite: 'Lax'` | Sent on top-level navigations, not cross-site POSTs | Balances CSRF protection with OIDC compatibility |
| `isSecure: true` | Production only | HTTPS-only cookie |
| `password` | `SESSION_SECRET` env var | Encrypts the session ID in the cookie |

### Why SameSite=Lax and not Strict?

`Strict` would block the cookie on any cross-site navigation, including clicking a link from another site to this service. `Lax` allows the cookie on top-level GET navigations (e.g., clicking a link) but blocks it on cross-site POST requests.

DEFRA ID's `response_mode=form_post` callback is a cross-site POST, which would strip the cookie with either setting. This is handled separately via the server-side PKCE state store (see [authentication.md](authentication.md)).

---

## What is stored in the session

```js
{
  tokens: {
    id_token: "...",
    access_token: "...",
    refresh_token: "...",
    expires_at: 1234567890   // Unix timestamp (seconds)
  },
  user: {
    sub: "...",
    email: "...",
    displayName: "...",
    firstName: "...",
    lastName: "...",
    currentRelationshipId: "...",
    relationships: [...],
    roles: [...],
    // ... all parsed JWT claims
  },
  returnTo: "/records/abc"   // Saved before redirecting to /login
}
```

The `user` object is re-enriched from the SQLite store on every sign-in. It combines JWT claims with accumulated historical data (all orgs ever seen).

---

## Token refresh and session update

When `requireAuth` detects an expired access token:

1. OIDC token endpoint called with `refresh_token`
2. New tokens stored in session (`tokens` key updated)
3. New JWT claims parsed and user re-enriched
4. Session updated with new `user` object
5. Request continues

If refresh fails (e.g., refresh token expired or revoked):
1. Session is destroyed (`request.yar.reset()`)
2. User redirected to `/login`

---

## Session warning banner

The base template (`src/views/layouts/base.njk`) shows a warning banner when the access token is within 10 minutes of expiry. This is injected into every view response by the `onPreResponse` extension in `src/server.js`:

```js
const secsRemaining = tokens.expires_at - Math.floor(Date.now() / 1000)
sessionExpiringSoon = secsRemaining > 0 && secsRemaining < 600  // 10 minutes
```

The banner prompts the user to save their work. The token will be automatically refreshed on the next request if a refresh token is available.

---

## Swapping to Redis (production)

The SQLite session adapter implements the [Catbox](https://github.com/hapijs/catbox) client interface. To switch to Redis:

1. Install `@hapi/catbox-redis`
2. In `src/server.js`, replace:
   ```js
   const CatboxSqlite = require('./store/session')
   // ...
   { name: 'sqlite-sessions', provider: { constructor: CatboxSqlite, options: { db } } }
   ```
   With:
   ```js
   const CatboxRedis = require('@hapi/catbox-redis')
   // ...
   { name: 'redis-sessions', provider: { constructor: CatboxRedis, options: { host: '...', port: 6379 } } }
   ```
3. Update the `cache` reference in the Yar store config from `'sqlite-sessions'` to `'redis-sessions'`

No other changes are needed — the Catbox interface is identical across providers.
