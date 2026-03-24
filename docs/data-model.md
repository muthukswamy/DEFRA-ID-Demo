# Data model

All data is stored in a single SQLite file created automatically in `data/` on first run. Tables are created with `CREATE TABLE IF NOT EXISTS` so there are no separate migration files — the application manages its own schema.

---

## Tables

### `users`

Stores user identity data from JWT claims. Updated on every sign-in.

| Column | Type | Notes |
|---|---|---|
| `sub` | TEXT PK | Stable OIDC subject identifier |
| `email` | TEXT | |
| `first_name` | TEXT | |
| `last_name` | TEXT | |
| `display_name` | TEXT | `first_name + last_name` |
| `unique_reference` | TEXT | Government ID reference |
| `contact_id` | TEXT | DEFRA internal contact ID |
| `service_id` | TEXT | Which service authenticated |
| `aal` | TEXT | Authentication Assurance Level |
| `loa` | TEXT | Level of Assurance |
| `first_seen_at` | INTEGER | Unix timestamp; set on first insert only |
| `updated_at` | INTEGER | Unix timestamp; updated on every sign-in |

---

### `organisations`

Stores organisation data from JWT relationship claims.

| Column | Type | Notes |
|---|---|---|
| `organisation_id` | TEXT PK | |
| `organisation_name` | TEXT | |
| `organisation_loa` | TEXT | Level of Assurance |
| `updated_at` | INTEGER | |

---

### `user_relationships`

Maps users to organisations based on JWT relationship claims. One row per user-org pair.

| Column | Type | Notes |
|---|---|---|
| `sub` | TEXT | FK → users |
| `relationship_id` | TEXT | DEFRA relationship identifier |
| `organisation_id` | TEXT | Can be NULL for personal (non-org) accounts |
| `relationship` | TEXT | Type: Employee, Agent, etc |
| `relationship_loa` | TEXT | |
| `updated_at` | INTEGER | |
| PK | (`sub`, `relationship_id`) | |

Index on `organisation_id WHERE organisation_id IS NOT NULL`.

---

### `user_roles`

Stores DEFRA ID org-level roles from JWT role claims. These are roles within the DEFRA identity system, not service roles.

| Column | Type | Notes |
|---|---|---|
| `sub` | TEXT | FK → users |
| `relationship_id` | TEXT | Links to a specific org relationship |
| `role_name` | TEXT | Role identifier from DEFRA ID |
| `status` | INTEGER | 1=Incomplete, 2=Pending, 3=Active, 4=Rejected, 5=Blocked, 6=Access Removed, 7=Offboarded |
| `updated_at` | INTEGER | |
| PK | (`sub`, `relationship_id`, `role_name`) | |

Index on `relationship_id`.

---

### `service_team_members`

Application-managed membership table. Tracks which users are active members of each org within this service. This is separate from DEFRA ID org membership — a user must sign in to be registered here.

| Column | Type | Notes |
|---|---|---|
| `organisation_id` | TEXT | |
| `sub` | TEXT | FK → users |
| `service_role` | TEXT | `'admin'` or `'member'` |
| `added_by` | TEXT | sub of who added them (usually themselves) |
| `added_at` | INTEGER | |
| `last_seen_at` | INTEGER | Updated on every sign-in |
| `deleted_at` | INTEGER | NULL = active; timestamp = soft-deleted |
| `updated_at` | INTEGER | |
| PK | (`organisation_id`, `sub`) | |

Index on `organisation_id`.

**Soft deletion**: When a user's org is no longer in their JWT (and the JWT is complete), their `deleted_at` is set. They no longer appear as active members but their record is preserved.

---

### `sessions`

Catbox-compatible server-side session storage. Each row is one Hapi/yar session.

| Column | Type | Notes |
|---|---|---|
| `segment` | TEXT | Cache segment name (from Catbox) |
| `id` | TEXT | Session identifier (cookie value) |
| `value` | TEXT | JSON-encoded session data (tokens, user object) |
| `stored_at` | INTEGER | Millisecond timestamp |
| `expires_at` | INTEGER | Millisecond timestamp; used for TTL enforcement |
| PK | (`segment`, `id`) | |

Index on `expires_at` (for efficient cleanup queries).

Rows are auto-purged every 5 minutes when `expires_at < now`.

---

### `records`

The main content table.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `organisation_id` | TEXT | Which org this record belongs to |
| `title` | TEXT NOT NULL | |
| `description` | TEXT | Optional short summary |
| `body` | TEXT | Optional main content |
| `created_by` | TEXT | sub of creator |
| `created_at` | INTEGER | Unix timestamp |
| `updated_at` | INTEGER | Unix timestamp |
| `deleted_at` | INTEGER | NULL = active; timestamp = soft-deleted |

Index on `organisation_id`.

**Soft deletion**: `deleted_at` is set instead of deleting the row. All queries include `AND deleted_at IS NULL`. Permission and history rows are preserved.

---

### `record_permissions`

Fine-grained access grants for records. One row per record-grantee pair.

| Column | Type | Notes |
|---|---|---|
| `record_id` | TEXT | FK → records |
| `grantee` | TEXT | User sub, `'__org__'`, or `'__org_admin__'` |
| `permission` | TEXT | `'owner'`, `'editor'`, or `'viewer'` |
| `granted_by` | TEXT | sub of who set this grant |
| `granted_at` | INTEGER | Unix timestamp |
| PK | (`record_id`, `grantee`) | |

Index on `grantee`.

**Special grantees**:
- `__org__`: applies to all active org members
- `__org_admin__`: applies to all users with `service_role = 'admin'`; always `viewer`; auto-created at record creation

---

### `record_history`

Append-only audit log for all record lifecycle events.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | Autoincrement |
| `record_id` | TEXT | FK → records |
| `event` | TEXT | See event types below |
| `actor` | TEXT | sub of who triggered the event |
| `target` | TEXT | sub of affected user (or `__org__`, `__org_admin__`) |
| `detail` | TEXT | Additional context (e.g., permission level) |
| `occurred_at` | INTEGER | Unix timestamp |

Index on `(record_id, occurred_at)`.

**Event types**:

| Event | When | Actor | Target | Detail |
|---|---|---|---|---|
| `created` | Record created | Creator | — | — |
| `updated` | Content edited | Editor | — | — |
| `deleted` | Soft-deleted | Deleter | — | — |
| `permission_granted` | Grant added | Granter | Grantee | Permission level |
| `permission_revoked` | Grant removed | Revoker | Former grantee | Previous permission |
| `owner_claimed` | Orphan claimed | New owner | Former owner | `'orphan_claim'` |

---

## Relationships between tables

```
users (sub)
  ├── user_relationships (sub → organisation_id)
  │     └── organisations (organisation_id)
  ├── user_roles (sub, relationship_id)
  ├── service_team_members (sub, organisation_id)
  ├── records.created_by
  ├── record_permissions.grantee
  └── record_history.actor / record_history.target

records (id)
  ├── record_permissions (record_id)
  └── record_history (record_id)
```

---

## Schema evolution

There are no migration files. Schema changes are handled inline:

- New tables: `CREATE TABLE IF NOT EXISTS` at module load
- New columns: `ALTER TABLE ... ADD COLUMN` wrapped in try/catch (SQLite returns an error if the column already exists, which is safe to ignore)
- Data migrations (e.g., renaming sentinel values): idempotent `UPDATE ... WHERE` statements run at startup

Example from `src/store/records.js`:
```js
// Add soft-delete column if not already present
try { db.exec('ALTER TABLE records ADD COLUMN deleted_at INTEGER') } catch (_) {}

// Back-fill __org_admin__ grant for pre-existing records
db.prepare(`INSERT OR IGNORE INTO record_permissions ...`).run()
```

This approach keeps the application self-contained but is not suitable for production databases with concurrent migrations.
