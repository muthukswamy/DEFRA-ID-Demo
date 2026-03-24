# Records

## Overview

Records are documents stored within an organisation. They demonstrate fine-grained authorisation (FGA) — each record has its own permission grants independent of service roles.

---

## Creating a record

Any org member can create a record (`POST /records`). On creation:

1. A UUID is generated for the record
2. The creator is automatically granted `owner` permission
3. An `__org_admin__` grant with `viewer` permission is inserted (gives all org admins read access)
4. A `created` event is logged in `record_history`

All three operations happen in a single SQLite transaction.

---

## Permission model

Each record has a list of grants in `record_permissions`. The `grantee` column holds either a user `sub` or a sentinel value.

### Permission levels

| Level | View | Edit | Delete | Manage sharing |
|---|---|---|---|---|
| `owner` | ✓ | ✓ | ✓ | ✓ |
| `editor` | ✓ | ✓ | ✗ | ✗ |
| `viewer` | ✓ | ✗ | ✗ | ✗ |

### Grant types

| Grantee | Who it applies to |
|---|---|
| User sub | One specific user |
| `__org__` | All active org members |
| `__org_admin__` | All org admins (automatic; always viewer) |

### Precedence

When a user has multiple applicable grants (e.g., direct editor + org viewer), the highest-ranked permission wins.

---

## Accessing records

`getUserPermission(recordId, sub, organisationId)` checks all three grant sources and returns the highest, or `null` if the user has no access.

`getRecordsForUser(organisationId, sub)` uses a three-branch SQL UNION:

1. Records with a direct grant to `sub`
2. Records with an `__org__` grant (requires active org membership)
3. Records with an `__org_admin__` grant (requires admin status)

Duplicates are deduplicated in JS, keeping the highest permission per record.

---

## Sharing a record

Only the owner can manage sharing (`GET /records/{id}/share`, `POST /records/{id}/share`).

### What the owner can do

- Grant org-wide access at `viewer` or `editor` level (`__org__` grant)
- Revoke org-wide access
- Grant individual access to specific org members
- Revoke individual grants (never the owner row)

### What the owner cannot do

- Grant `owner` permission to another user (ownership is not transferable via UI)
- Revoke the `__org_admin__` grant (it is automatic and read-only)
- Grant access to users outside the org

### Redundant grants

When an org-wide grant exists, individual grants at the same or lower level are flagged as "redundant" on the share page. They are shown with a "Covered by organisation access" hint. The grant is not removed — if the org grant is later revoked, the individual grant would become relevant again.

The "Who has access" sidebar on the view page suppresses redundant individual grants entirely (only shows grants with higher permission than the org grant).

---

## Editing a record

Users with `editor` or `owner` permission can edit a record's title, description, and body (`POST /records/{id}/edit`). Each edit logs an `updated` event in `record_history`.

---

## Deleting a record

Only the owner can delete a record. The delete flow uses a confirmation page (`GET /records/{id}/delete`) rather than a JavaScript `confirm()` dialog — this is the GOV.UK Design System standard pattern and is accessible to screen readers and keyboard users.

On confirmation (`POST /records/{id}/delete`):
1. `deleted_at` is set to the current timestamp (soft delete)
2. A `deleted` event is logged in `record_history`
3. User is redirected to the records list with a `deleted=1` query parameter

The record row, all permission grants, and all history rows are preserved in the database.

---

## Record history

Every significant change to a record is logged in `record_history`.

### Event types

| Event | Trigger | Logged by |
|---|---|---|
| `created` | Record created | `txCreateRecord` |
| `updated` | Content edited | `updateRecord` |
| `deleted` | Soft-deleted | `txDeleteRecord` |
| `permission_granted` | Any grant added | `setPermission` |
| `permission_revoked` | Any grant removed | `revokePermission` |
| `owner_claimed` | Orphaned record claimed | `claimOrphanedRecords` |

### Viewing history

- **Full history** (`GET /records/{id}/history`): all event types, owner only. Shows date, event type (tagged as Content/Access/Ownership), and a human-readable description.
- **Permission history** (collapsible on `/records/{id}/share`): permission events only (`permission_granted`, `permission_revoked`, `owner_claimed`).

Both views are ordered latest-first.

---

## Admin access to all records

Org admins have implicit `viewer` access to every record via the `__org_admin__` grant:

- They see all org records in the records list, including ones not explicitly shared
- Those records show a "Viewer" permission tag
- They can view the record but cannot edit, delete, or manage sharing
- To get edit or owner access, the record owner must grant it explicitly

This is separate from the `owner` they receive when claiming an orphaned record.

---

## Routes summary

| Method | Path | Min permission | Description |
|---|---|---|---|
| GET | `/records` | org member | List accessible records |
| GET | `/records/new` | org member | Create form |
| POST | `/records` | org member | Create record |
| GET | `/records/{id}` | viewer | View record |
| GET | `/records/{id}/edit` | editor | Edit form |
| POST | `/records/{id}/edit` | editor | Save edits |
| GET | `/records/{id}/share` | owner | Sharing management |
| POST | `/records/{id}/share` | owner | Update grants |
| GET | `/records/{id}/delete` | owner | Delete confirmation |
| POST | `/records/{id}/delete` | owner | Confirm delete |
| GET | `/records/{id}/history` | owner | Full audit history |

All routes require `requireAuth` and `requireOrgMember`. Permission is checked by `resolveRecord()`, which returns a 403 if the user's permission is below the required minimum.
