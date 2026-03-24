# Authorisation

## Overview

The service has two layers of authorisation:

1. **Service-level**: controls access to routes (org membership, admin role)
2. **Record-level (FGA)**: fine-grained per-record permissions (owner, editor, viewer)

These layers are independent. Being an org admin does not automatically give elevated record access — record permissions must be granted explicitly (or via the automatic admin wildcard).

---

## Service-level authorisation

### Roles

There are two service roles, stored in `service_team_members.service_role`:

| Role | Who gets it | What they can do |
|---|---|---|
| `admin` | First user in an org; manually promoted | View records list, manage team, claim orphaned records |
| `member` | All other users | Standard access |

Roles are assigned and maintained by the service (not from JWT claims). They are not the same as DEFRA ID organisation roles, which are stored separately in `user_roles`.

### Role assignment

- The **first user** to sign in to an org is automatically made `admin` (bootstrap).
- Subsequent users are registered as `member`.
- If an org somehow ends up with no admins (e.g., data corruption), the next user to sign in is promoted to `admin` (self-healing).

### Route guards (pre-methods)

| Pre-method | Used on | Checks |
|---|---|---|
| `requireAuth` | All authenticated routes | Valid session tokens; triggers silent refresh if expired |
| `requireOrgMember` | All record routes | User registered in `service_team_members` for current org |
| `requireOrgAdmin` | `GET /team` | User has `service_role = 'admin'` in current org |

All pre-methods use `h.takeover()` to short-circuit the route handler on failure.

---

## Record-level authorisation (FGA)

### Permission levels

| Permission | Can view | Can edit | Can delete | Can manage sharing |
|---|---|---|---|---|
| `owner` | ✓ | ✓ | ✓ | ✓ |
| `editor` | ✓ | ✓ | ✗ | ✗ |
| `viewer` | ✓ | ✗ | ✗ | ✗ |

Permission rank (for comparison): `owner = 3`, `editor = 2`, `viewer = 1`.

### Grant types

Permissions are stored in `record_permissions(record_id, grantee, permission)`. The `grantee` field can be:

| Grantee value | Meaning |
|---|---|
| A user `sub` | Individual grant |
| `__org__` | All active org members get this permission |
| `__org_admin__` | All org admins get this permission (always viewer; automatic) |

### Permission resolution

`getUserPermission(recordId, sub, organisationId)` in `src/store/records.js`:

1. Check for a **direct grant** to `sub`
2. Check for an **`__org__` grant** — only if user is an active org member
3. Check for an **`__org_admin__` grant** — only if user has `service_role = 'admin'`
4. Return the highest-ranked permission, or `null` if none

```
direct permission = stmtDirectGrant(recordId, sub)
org permission    = isActiveMember ? stmtOrgGrant(recordId) : null
admin permission  = isAdmin        ? stmtAdminGrant(recordId) : null

result = highest(direct, highest(org, admin))  →  null if all are null
```

### Admin wildcard (`__org_admin__`)

All records have an `__org_admin__` grant with `viewer` permission, inserted automatically at record creation. This gives org admins read access to all records in their org without needing an explicit share.

Key properties:
- Created in the same transaction as the record itself
- Back-filled for records that existed before this feature was added
- Always `viewer` — admins need an explicit editor/owner grant to modify records
- Not editable through the sharing UI (shown as read-only)
- Not revocable — it is a system policy, not a user action

### Org wildcard (`__org__`)

An owner can optionally grant access to all org members at once. Unlike the admin wildcard:
- Not created automatically
- Can be set to `viewer` or `editor` (not `owner`)
- Can be revoked by the owner
- Only applies to users who are active org members at the time of the request

### Individual grants

Direct grants to specific users take precedence when higher than a wildcard grant. The sharing UI:
- Shows a "Covered by organisation access" hint when an individual grant is lower than the org-wide grant
- Still allows removing individual grants (in case the org grant is revoked later)
- Never shows a Remove option for the owner row

### Record access — who can see what

| User type | Records visible in list | Can view? | Can edit? | Can delete/share? |
|---|---|---|---|---|
| Creator (owner) | All records they created | ✓ | ✓ | ✓ |
| User with explicit grant | Granted records | ✓ | If editor+ | If owner |
| Active org member (with `__org__` grant) | Records with org grant | ✓ | If org grant is editor | ✗ |
| Org admin (via `__org_admin__`) | All org records | ✓ (viewer only) | ✗ | ✗ |

### Orphaned records

A record becomes orphaned when its owner is no longer an active member of the org (e.g., they left the organisation).

Resolution:
- Every time an admin signs in, `claimOrphanedRecords(orgId, adminSub)` runs
- It finds all records in the org where `owner_sub NOT IN active_members`
- Ownership is transferred to the signing-in admin
- A `owner_claimed` event is logged in `record_history`
- No-op if no orphaned records exist

This ensures records are always accessible and never permanently lost.

---

## Audit history

All permission changes are recorded in `record_history`:

| Event | When |
|---|---|
| `created` | Record created |
| `updated` | Record content edited |
| `deleted` | Record soft-deleted |
| `permission_granted` | Any grant added (individual, org, admin) |
| `permission_revoked` | Any grant removed |
| `owner_claimed` | Orphaned record claimed by admin |

History is append-only and never deleted, even after soft-deleting the record.

Two views of the history are available:
- **Full history** (`/records/{id}/history`): all event types, owner only
- **Permission history** (collapsible on `/records/{id}/share`): permission events only

---

## Soft deletion

Records are soft-deleted: `deleted_at` is set to a Unix timestamp rather than the row being removed. This means:

- `getRecord()` and all list queries filter `WHERE deleted_at IS NULL`
- Permission and history rows are preserved indefinitely
- The audit trail remains intact and accessible to admins if needed

---

## Summary of design decisions

**Why separate service roles from FGA?**
Service roles (admin/member) control access to service features like team management. Record permissions are independent — an admin isn't automatically an editor of all records. This keeps the permission model predictable: record access must be explicitly granted (or comes via the automatic admin wildcard).

**Why an admin wildcard at all?**
Admins need operational oversight — they should be able to see all records in their org without being individually added to each one. The `__org_admin__` grant provides this at viewer level, while keeping edit/delete rights behind explicit grants.

**Why soft-delete?**
Deleting records hard would make the history meaningless. By keeping records in the database, the full audit trail is preserved and ownership transfer remains meaningful even after deletion.

**Why claim orphaned records on every sign-in?**
It is simpler and more resilient than triggering on org membership changes (which may happen in DEFRA ID and not be immediately reflected here). The claim function is a no-op when nothing is orphaned, so there is no cost when running unnecessarily.
