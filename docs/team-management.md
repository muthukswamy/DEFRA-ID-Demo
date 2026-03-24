# Team management

## Overview

Team management covers how users become members of an organisation within the service, how roles are assigned, and how the service stays in sync with DEFRA ID when memberships change.

The service maintains its own membership table (`service_team_members`) separate from DEFRA ID's organisation membership. A user must sign in to be registered — there is no bulk import.

---

## How users join an org

Membership is not pre-provisioned. It is created automatically when a user signs in:

1. User authenticates via DEFRA ID and the JWT is verified
2. `enrichUserFromStore()` in `src/middleware/auth.js` runs
3. If the user has an active org relationship in their JWT, `registerMember()` is called
4. The user is inserted into `service_team_members` (or their record is updated if they already exist)

This means a user does not appear in the team list until after their first sign-in to the service.

The team page (`/team`) shows this explicitly in the inset text: *"Members appear here after their first sign-in to this service."*

---

## Service roles

There are two service roles:

| Role | Description |
|---|---|
| `admin` | Can view the team page and manage team members; claims orphaned records |
| `member` | Standard access; cannot access team management |

### Role assignment

**First user = admin (bootstrap)**

When the first user signs in to an org, they are given the `admin` role. This ensures every org always has at least one admin without requiring manual setup.

**Subsequent users = member**

All users after the first are registered as `member`. Role changes must be made directly in the database (there is no in-service role management UI — that is handled in DEFRA account management).

**Self-healing admin promotion**

After every `registerMember()` call, the store checks if the org has any admins. If not (due to data corruption or manual edits), the newly signing-in user is promoted to `admin`. This is a safety net, not the primary mechanism.

---

## How memberships go stale

A user's org membership may become stale if they are removed from an organisation in DEFRA ID. The service detects this via the JWT on the user's next sign-in.

### Soft-deletion on stale JWT data

`softDeleteStaleOrgMemberships()` in `src/store/relationships.js` runs after every sign-in:

1. Collects the list of `organisation_id` values in the user's current JWT
2. Compares against their active memberships in `service_team_members`
3. Sets `deleted_at = now` on any memberships no longer in the JWT

**Guard: only runs when JWT is complete**

The JWT includes an `enrolmentCount` claim indicating how many orgs the user is enrolled in. If the number of orgs in the JWT is less than `enrolmentCount`, the JWT is treated as partial (some orgs may have been omitted for token size reasons). Soft-deletion is skipped in this case to avoid incorrectly removing valid memberships.

### Effect of soft-deletion on record access

When a user's org membership is soft-deleted:
- They no longer appear in `getTeamMembers()` results
- `getServiceRole()` returns null (they have no active role)
- `requireOrgMember` will reject their requests (they can no longer access records)
- The `__org__` grant no longer applies to them (active member check fails)
- Their individual record grants are preserved but inaccessible until re-activated

If the user signs in again and the org is back in their JWT, `registerMember()` re-activates them: `deleted_at` is cleared and `last_seen_at` is updated.

---

## Orphaned records

When a record's owner leaves an org (their membership is soft-deleted), the record becomes orphaned — no one has `owner` permission on it.

**Claim on admin sign-in**

`claimOrphanedRecords(orgId, adminSub)` is called every time an admin signs in:

1. Queries `record_permissions` for records in the org where the owner's sub is no longer in `service_team_members` (active)
2. Transfers the `owner` grant to the signing-in admin
3. Logs an `owner_claimed` event in `record_history` with the former owner's sub

This is a no-op if there are no orphaned records. The claim is triggered on every admin sign-in (not just after detected membership changes) to handle cases where changes in DEFRA ID are not immediately reflected.

**Why transfer to the signing-in admin rather than all admins?**

Only one owner per record is meaningful. Transferring to the first admin to sign in avoids contention. Other admins still have viewer access via the `__org_admin__` wildcard grant.

---

## Viewing the team

The team page (`GET /team`) is accessible only to org admins. It shows:

- All active members of the current org (non-deleted rows in `service_team_members`)
- Their display name, email, account relationship type, service role, and last-seen date
- A "Manage" link to the relevant page in DEFRA account management (employee or intermediary)
- An inset text link to the DEFRA account management team and intermediaries pages for adding/removing members

There is no add or remove functionality within the mock service itself. Org membership is managed in DEFRA account management; the service reflects those changes on the user's next sign-in.

---

## DEFRA ID account management links

The team page and inset text link to DEFRA account management pages, constructed from `DEFRA_ACCOUNT_URL`:

| Link | URL pattern |
|---|---|
| Employee team management | `{base}/accounts/{orgId}/team` |
| Intermediary management | `{base}/accounts/{orgId}/intermediaries` |
| Individual employee | `{base}/accounts/{orgId}/team/{contactId}` |
| Individual intermediary | `{base}/accounts/{orgId}/intermediaries/{contactId}` |

`base` is derived from `DEFRA_ACCOUNT_URL` by stripping the `/me` suffix (`accountManagementBaseUrl` in config).

These links open in a new tab.

---

## Sequence: new user onboarding

```
1. Admin invites user via DEFRA account management (outside this service)
   ↓
2. User signs in to DEFRA ID and selects the org
   ↓
3. DEFRA ID JWT includes the org in the relationships claim
   ↓
4. Service registers user as 'member' in service_team_members
   ↓
5. User appears in the team list for admins
   ↓
6. User can create records and be granted access to shared records
```

## Sequence: user offboarding

```
1. Admin removes user from org in DEFRA account management
   ↓
2. (If user is currently signed in)
   Next request → token refresh → new JWT without the org
   → softDeleteStaleOrgMemberships() soft-deletes membership
   → requireOrgMember fails on next request → redirect
   ↓
3. (On next sign-in attempt)
   JWT does not include the org → membership stays soft-deleted → access denied
   ↓
4. Next admin sign-in
   → claimOrphanedRecords() transfers ownership of user's records to admin
```
