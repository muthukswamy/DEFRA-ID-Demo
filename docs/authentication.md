# Authentication

## Overview

Authentication is handled via OpenID Connect (OIDC) Authorization Code flow with PKCE, using DEFRA Customer Identity (DEFRA ID) as the identity provider — an Azure AD B2C tenant.

## Sign-in flow

```
1. User visits /login
   ↓
2. Server generates PKCE pair (code_verifier + code_challenge)
   + generates state + nonce
   + stores { code_verifier, nonce, expiresAt } in server-side PKCE store (keyed by state)
   ↓
3. Server redirects browser to B2C /authorize with:
   - response_type=code
   - response_mode=form_post
   - code_challenge + code_challenge_method=S256
   - state, nonce
   - scope (openid offline_access <clientId>)
   - serviceId (DEFRA-specific routing)
   - optional: aal, forceMFA, forceReselection, relationshipId
   ↓
4. User authenticates at B2C (username/password, MFA if required)
   ↓
5. B2C POSTs authorization code + state to /login/return (form_post)
   ↓
6. Server retrieves PKCE entry for state (one-time use — entry deleted immediately)
   ↓
7. Server exchanges code for tokens via openid-client:
   - Validates nonce, state, code_challenge
   - openid-client verifies token signatures
   ↓
8. Tokens stored in session: id_token, access_token, refresh_token, expires_at
   ↓
9. JWT claims parsed → user enriched from SQLite store
   ↓
10. Redirect to returnTo (saved before login) or /dashboard
```

## Why server-side PKCE store (not cookie)?

B2C uses `response_mode=form_post`, which means B2C POSTs the authorization code to `/login/return` as a cross-site request. `SameSite=Lax` cookies are not sent on cross-site POST requests, so any cookie-based state would be missing at the callback. The PKCE state is therefore stored in a server-side Map, keyed by the `state` parameter that B2C echoes back in the POST body (per OIDC spec).

## PKCE state store

- In-memory `Map` in `src/routes/auth.js`
- Entries expire after **10 minutes** (covers typical sign-in flows)
- Swept every **5 minutes** to remove abandoned entries
- **One-time use**: entry is deleted immediately on retrieval to prevent replay attacks

## Token lifecycle

```
Access token (JWT)
  ├─ Decoded on every request (decodeJwtPayload — no re-verification needed)
  ├─ Checked for expiry with 30-second buffer (isAccessTokenExpired)
  └─ If expired + refresh token exists → silent refresh (see below)

Refresh token
  ├─ Stored in session alongside access token
  ├─ Used automatically by requireAuth middleware when access token expires
  └─ Rotated on use (new refresh token stored, old discarded)

ID token
  ├─ Stored in session
  ├─ Used at logout to construct B2C end_session_endpoint URL (sign-out iframe)
  └─ Re-used if OIDC provider doesn't issue a new one on refresh
```

## Silent token refresh

Handled inside `requireAuth` (pre-method in `src/middleware/auth.js`):

1. `isAccessTokenExpired()` checks `exp` claim with 30-second buffer
2. If expired and `refresh_token` present, calls OIDC token endpoint
3. New tokens stored in session
4. User re-enriched from store with new claims
5. Request continues transparently — the route handler is unaware of the refresh
6. On refresh failure: session is reset, user redirected to `/login`

The 30-second buffer prevents a race where the token is valid when checked but expires before the downstream API call completes.

## JWT claim parsing

`parseTokenClaims()` in `src/middleware/auth.js` extracts standard OIDC and DEFRA-specific claims:

| Claim | Field | Notes |
|---|---|---|
| `sub` | `sub` | Stable user identifier |
| `email` | `email` | |
| `given_name` | `firstName` | |
| `family_name` | `lastName` | |
| `contactId` | `contactId` | DEFRA internal contact ID |
| `serviceId` | `serviceId` | Which service the user authenticated for |
| `sessionId` | `sessionId` | B2C session identifier (for tracing) |
| `correlationId` | `correlationId` | Request correlation ID |
| `uniqueReference` | `uniqueReference` | Government ID reference |
| `aal` | `aal` | Authentication Assurance Level |
| `loa` | `loa` | Level of Assurance |
| `enrolmentCount` | `enrolmentCount` | Number of orgs enrolled |
| `enrolmentRequestCount` | `enrolmentRequestCount` | Pending enrolment requests |
| `currentRelationshipId` | `currentRelationshipId` | Active org context |
| `amr` | `authMethod` | Authentication method (see below) |
| `relationships` (colon-delimited) | `relationships[]` | Org memberships |
| `roles` (colon-delimited) | `roles[]` | Org-level roles |

### Authentication methods (`amr`)

| Value | Label |
|---|---|
| `one` | GOV.UK One Login |
| `scp` | Government Gateway |
| `cap` | RPA via CAP API |
| `ttp` | Trusted Third Party |

### Relationship claim format

Each relationship is a colon-delimited string:
```
{relationshipId}:{orgId}:{orgName}:{orgLoa}:{relationshipType}:{relationshipLoa}
```
Example: `rel-123:org-456:ACME Corp:Level2:employee:Level2`

### Role claim format

Each role is a colon-delimited string:
```
{relationshipId}:{roleName}:{status}
```
Status codes: `1=Incomplete`, `2=Pending`, `3=Active`, `4=Rejected`, `5=Blocked`, `6=Access Removed`, `7=Offboarded`

## Session enrichment

After parsing JWT claims, `enrichUserFromStore()` in `src/middleware/auth.js`:

1. Merges all claims into SQLite (`relStore.merge()`) — accumulates historical org/role data
2. Retrieves the full stored set (may include more orgs than current JWT if partial token)
3. Soft-deletes org memberships no longer in JWT — **only when JWT is "complete"** (see below)
4. Registers user in `service_team_members` for current org
5. If user is admin, claims any orphaned records in current org
6. Returns enriched user combining JWT claims + stored state

### Partial JWT handling

DEFRA ID JWTs may not always contain all enrolled orgs (e.g., if a user belongs to many orgs). The `enrolmentCount` claim indicates how many orgs the user is enrolled in. If the JWT contains fewer relationships than `enrolmentCount`, it's treated as partial — soft-deletions are skipped to avoid incorrectly removing valid memberships.

## Sign-out flow

```
1. User submits POST /logout
   ↓
2. Server reads id_token from session
   ↓
3. Session destroyed (request.yar.reset())
   ↓
4. signed-out.njk rendered with:
   - idToken (for B2C sign-out iframe)
   - endSessionUrl (B2C end_session_endpoint, if configured)
   - postLogoutRedirectUri
   ↓
5. (Client-side) Page can optionally load B2C end_session endpoint in iframe
   to sign the user out of B2C as well
   ↓
6. B2C redirects to /signed-out (GET, public, no auth required)
```

POST is used for logout (not GET) to prevent cross-site logout via a link.

## Optional OIDC parameters

These can be passed when building the auth URL (either from config or `GET /login` query params):

| Parameter | Purpose |
|---|---|
| `aal` | Require a minimum authentication assurance level (1=password, 2=MFA) |
| `forceMFA` | Force MFA even if user already has an active session |
| `forceReselection` | Force user to pick an org at sign-in (`/login/switch-org` uses this) |
| `relationshipId` | Pre-select a specific org relationship (runtime parameter — not config) |

`relationshipId` is passed as a query parameter to `/login?relationshipId=...` at runtime because it is request-specific data, not a service-wide configuration value.

## B2C-specific choices

- **`token_endpoint_auth_method: 'client_secret_post'`**: Azure B2C requires the client secret to be sent in the POST body, not as a Basic auth header (which is the OIDC default).
- **`response_mode=form_post`**: B2C returns the authorization code via an HTML form POST, not a URL redirect. This avoids the authorization code appearing in browser history or referrer headers.
