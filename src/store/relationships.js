'use strict'

const path = require('path')
const Database = require('better-sqlite3')

const db = new Database(path.join(__dirname, '../../data/local.db'))

// Role status labels — authoritative mapping used when reading roles from DB.
// Exported so auth.js can use the same values without duplicating the map.
const ROLE_STATUS_LABELS = {
  1: 'Incomplete',
  2: 'Pending',
  3: 'Active',
  4: 'Rejected',
  5: 'Blocked',
  6: 'Access Removed',
  7: 'Offboarded'
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    sub              TEXT    NOT NULL PRIMARY KEY,
    email            TEXT,
    first_name       TEXT,
    last_name        TEXT,
    display_name     TEXT,
    unique_reference TEXT,
    contact_id       TEXT,
    service_id       TEXT,
    aal              TEXT,
    loa              TEXT,
    first_seen_at    INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS organisations (
    organisation_id   TEXT    NOT NULL PRIMARY KEY,
    organisation_name TEXT,
    organisation_loa  TEXT,
    updated_at        INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_relationships (
    sub              TEXT    NOT NULL,
    relationship_id  TEXT    NOT NULL,
    organisation_id  TEXT,
    relationship     TEXT,
    relationship_loa TEXT,
    updated_at       INTEGER NOT NULL,
    PRIMARY KEY (sub, relationship_id)
  );

  CREATE TABLE IF NOT EXISTS user_roles (
    sub             TEXT    NOT NULL,
    relationship_id TEXT    NOT NULL,
    role_name       TEXT    NOT NULL,
    status          TEXT,
    updated_at      INTEGER NOT NULL,
    PRIMARY KEY (sub, relationship_id, role_name)
  );

  -- "Which users belong to org X?" — used for access control lookups.
  -- Partial index excludes individual/personal accounts (NULL organisation_id).
  CREATE INDEX IF NOT EXISTS idx_user_relationships_org
    ON user_relationships(organisation_id)
    WHERE organisation_id IS NOT NULL;

  -- "All roles for a given relationship" — used for permission checks.
  CREATE INDEX IF NOT EXISTS idx_user_roles_relationship
    ON user_roles(relationship_id);

  CREATE TABLE IF NOT EXISTS sessions (
    segment    TEXT    NOT NULL,
    id         TEXT    NOT NULL,
    value      TEXT    NOT NULL,
    stored_at  INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (segment, id)
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_expires
    ON sessions(expires_at);

  CREATE TABLE IF NOT EXISTS service_team_members (
    organisation_id  TEXT    NOT NULL,
    sub              TEXT    NOT NULL,
    service_role     TEXT    NOT NULL DEFAULT 'member',
    added_by         TEXT    NOT NULL,
    added_at         INTEGER NOT NULL,
    last_seen_at     INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    deleted_at       INTEGER,
    PRIMARY KEY (organisation_id, sub)
  );

  CREATE INDEX IF NOT EXISTS idx_service_team_org
    ON service_team_members(organisation_id);
`)

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------

const upsertUser = db.prepare(`
  INSERT INTO users
    (sub, email, first_name, last_name, display_name, unique_reference,
     contact_id, service_id, aal, loa, first_seen_at, updated_at)
  VALUES
    (@sub, @email, @first_name, @last_name, @display_name, @unique_reference,
     @contact_id, @service_id, @aal, @loa, @now, @now)
  ON CONFLICT(sub) DO UPDATE SET
    email            = excluded.email,
    first_name       = excluded.first_name,
    last_name        = excluded.last_name,
    display_name     = excluded.display_name,
    unique_reference = excluded.unique_reference,
    contact_id       = excluded.contact_id,
    service_id       = excluded.service_id,
    aal              = excluded.aal,
    loa              = excluded.loa,
    updated_at       = excluded.updated_at
`)

const upsertOrg = db.prepare(`
  INSERT INTO organisations (organisation_id, organisation_name, organisation_loa, updated_at)
  VALUES (@organisation_id, @organisation_name, @organisation_loa, @updated_at)
  ON CONFLICT(organisation_id) DO UPDATE SET
    organisation_name = excluded.organisation_name,
    organisation_loa  = excluded.organisation_loa,
    updated_at        = excluded.updated_at
`)

const upsertRel = db.prepare(`
  INSERT INTO user_relationships
    (sub, relationship_id, organisation_id, relationship, relationship_loa, updated_at)
  VALUES
    (@sub, @relationship_id, @organisation_id, @relationship, @relationship_loa, @updated_at)
  ON CONFLICT(sub, relationship_id) DO UPDATE SET
    organisation_id  = excluded.organisation_id,
    relationship     = excluded.relationship,
    relationship_loa = excluded.relationship_loa,
    updated_at       = excluded.updated_at
`)

const upsertRole = db.prepare(`
  INSERT INTO user_roles
    (sub, relationship_id, role_name, status, updated_at)
  VALUES
    (@sub, @relationship_id, @role_name, @status, @updated_at)
  ON CONFLICT(sub, relationship_id, role_name) DO UPDATE SET
    status     = excluded.status,
    updated_at = excluded.updated_at
`)

// JOIN to organisations so callers get org name/loa without storing it twice
const getRels = db.prepare(`
  SELECT
    ur.sub, ur.relationship_id, ur.organisation_id,
    ur.relationship, ur.relationship_loa, ur.updated_at,
    o.organisation_name, o.organisation_loa
  FROM user_relationships ur
  LEFT JOIN organisations o ON o.organisation_id = ur.organisation_id
  WHERE ur.sub = ?
  ORDER BY ur.updated_at DESC
`)

const getRoles = db.prepare(
  'SELECT * FROM user_roles WHERE sub = ? ORDER BY updated_at DESC'
)

// ---------------------------------------------------------------------------
// Transaction
// ---------------------------------------------------------------------------

const mergeAll = db.transaction((user, relationships, roles) => {
  const now = Math.floor(Date.now() / 1000)
  const { sub } = user

  upsertUser.run({
    sub,
    email: user.email || null,
    first_name: user.firstName || null,
    last_name: user.lastName || null,
    display_name: user.displayName || null,
    unique_reference: user.uniqueReference || null,
    contact_id: user.contactId || null,
    service_id: user.serviceId || null,
    aal: user.aal || null,
    loa: user.loa || null,
    now
  })

  for (const r of relationships) {
    // Only upsert into organisations when an org ID is present.
    // Individual/personal accounts have no organisation_id.
    if (r.organisationId) {
      upsertOrg.run({
        organisation_id: r.organisationId,
        organisation_name: r.organisationName,
        organisation_loa: r.organisationLoa,
        updated_at: now
      })
    }

    upsertRel.run({
      sub,
      relationship_id: r.relationshipId,
      organisation_id: r.organisationId || null, // NULL for individual accounts
      relationship: r.relationship,
      relationship_loa: r.relationshipLoa,
      updated_at: now
    })
  }

  for (const r of roles) {
    upsertRole.run({
      sub,
      relationship_id: r.relationshipId,
      role_name: r.roleName,
      status: r.status,
      updated_at: now
    })
  }
})

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Upsert user metadata, relationships, roles, and organisations into the store.
 * Existing rows are updated; new rows are inserted. Nothing is deleted.
 * @param {object} user - Parsed user object from parseTokenClaims()
 */
function merge (user) {
  mergeAll(user, user.relationships || [], user.roles || [])
}

/**
 * Retrieve the full accumulated relationships and roles for a user.
 * Org name/loa are resolved via JOIN so the return shape is identical to
 * what parseTokenClaims() produces, keeping callers unchanged.
 * @param {string} sub
 * @returns {{ relationships: object[], roles: object[] }}
 */
function get (sub) {
  const relationships = getRels.all(sub).map((row) => ({
    relationshipId: row.relationship_id,
    organisationId: row.organisation_id || '',
    organisationName: row.organisation_name || '',
    organisationLoa: row.organisation_loa || '',
    relationship: row.relationship,
    relationshipLoa: row.relationship_loa
  }))
  const roles = getRoles.all(sub).map((row) => ({
    relationshipId: row.relationship_id,
    roleName: row.role_name,
    status: row.status,
    statusLabel: ROLE_STATUS_LABELS[parseInt(row.status, 10)] || row.status
  }))
  return { relationships, roles }
}

// ---------------------------------------------------------------------------
// Service team members
// ---------------------------------------------------------------------------

const insertTeamMember = db.prepare(`
  INSERT INTO service_team_members
    (organisation_id, sub, service_role, added_by, added_at, last_seen_at, updated_at)
  VALUES
    (@organisation_id, @sub, @service_role, @added_by, @now, @now, @now)
  ON CONFLICT(organisation_id, sub) DO UPDATE SET
    last_seen_at = excluded.last_seen_at,
    deleted_at   = NULL,
    updated_at   = excluded.updated_at
`)

const countTeamMembers = db.prepare(
  'SELECT COUNT(*) AS cnt FROM service_team_members WHERE organisation_id = ? AND deleted_at IS NULL'
)

const countAdmins = db.prepare(
  "SELECT COUNT(*) AS cnt FROM service_team_members WHERE organisation_id = ? AND service_role = 'admin' AND deleted_at IS NULL"
)

const promoteToAdmin = db.prepare(`
  UPDATE service_team_members
  SET service_role = 'admin', updated_at = ?
  WHERE organisation_id = ? AND sub = ? AND deleted_at IS NULL
`)

// JOIN users (email/display_name) and user_relationships (account relationship type).
// Excludes soft-deleted members.
const selectTeamMembers = db.prepare(`
  SELECT stm.sub, stm.service_role, stm.added_at, stm.last_seen_at,
         u.email, u.display_name, u.contact_id,
         ur.relationship
  FROM service_team_members stm
  JOIN users u ON u.sub = stm.sub
  LEFT JOIN user_relationships ur
    ON ur.sub = stm.sub AND ur.organisation_id = stm.organisation_id
  WHERE stm.organisation_id = ? AND stm.deleted_at IS NULL
  ORDER BY stm.added_at ASC
`)

const getTeamMemberRole = db.prepare(`
  SELECT service_role FROM service_team_members
  WHERE organisation_id = @organisation_id AND sub = @sub AND deleted_at IS NULL
`)

// Active org memberships for a user — used to detect stale rows during sign-in.
const getActiveTeamMemberOrgs = db.prepare(
  'SELECT organisation_id FROM service_team_members WHERE sub = ? AND deleted_at IS NULL'
)

const softDeleteFromOrg = db.prepare(`
  UPDATE service_team_members
  SET deleted_at = @now, updated_at = @now
  WHERE sub = @sub AND organisation_id = @organisation_id AND deleted_at IS NULL
`)

/**
 * Register a user into service_team_members.
 * - New member: inserted as 'admin' (first in org) or 'member'.
 * - Returning member: last_seen_at updated, deleted_at cleared (re-activation).
 * - service_role is preserved on conflict — manually-set roles are never overwritten.
 */
function registerMember (organisationId, user) {
  const now = Math.floor(Date.now() / 1000)
  const { cnt } = countTeamMembers.get(organisationId)
  const serviceRole = cnt === 0 ? 'admin' : 'member'
  insertTeamMember.run({
    organisation_id: organisationId,
    sub: user.sub,
    service_role: serviceRole,
    added_by: user.sub,
    now
  })
  // Self-heal: if the org has no admin after the insert, promote this user.
  // Covers rows inserted as 'member' before bootstrap logic existed.
  const { cnt: adminCnt } = countAdmins.get(organisationId)
  if (adminCnt === 0) {
    promoteToAdmin.run(now, organisationId, user.sub)
  }
}

/**
 * Soft-delete service_team_members rows for orgs no longer in the user's JWT.
 * Only runs when the JWT is complete (currentOrgIds.length >= enrolmentCount).
 * If the token is partial we cannot determine what was removed, so we skip.
 * @param {string} sub
 * @param {string[]} currentOrgIds - non-personal org IDs from the current JWT
 * @param {number} enrolmentCount  - total enrolled org count from the JWT claim
 */
function softDeleteStaleOrgMemberships (sub, currentOrgIds, enrolmentCount) {
  if (currentOrgIds.length < enrolmentCount) return
  const currentSet = new Set(currentOrgIds)
  const now = Math.floor(Date.now() / 1000)
  const rows = getActiveTeamMemberOrgs.all(sub)
  for (const row of rows) {
    if (!currentSet.has(row.organisation_id)) {
      softDeleteFromOrg.run({ sub, organisation_id: row.organisation_id, now })
    }
  }
}

/**
 * Get all active (non-deleted) team members for an org.
 * Email/display name come from the users table (always current);
 * account relationship type comes from user_relationships.
 * @returns {{ sub, email, displayName, contactId, relationship, serviceRole, addedAt, lastSeenAt }[]}
 */
function getTeamMembers (organisationId) {
  return selectTeamMembers.all(organisationId).map((row) => ({
    sub: row.sub,
    email: row.email,
    displayName: row.display_name,
    contactId: row.contact_id || null,
    relationship: row.relationship || '',
    serviceRole: row.service_role,
    addedAt: row.added_at,
    lastSeenAt: row.last_seen_at
  }))
}

/**
 * Get the service role for a single active user in an org, or null if not registered.
 */
function getServiceRole (organisationId, sub) {
  const row = getTeamMemberRole.get({ organisation_id: organisationId, sub })
  return row ? row.service_role : null
}

/**
 * Returns true if the user holds the 'admin' service role for their current org.
 * Checks service_team_members (DB) rather than JWT roles[] since no service-specific
 * roles are registered with DEFRA ID — the roles[] claim is always empty.
 */
function isOrgAdmin (user) {
  if (!user || !user.currentRelationshipId) return false
  const currentRel = (user.relationships || []).find(
    (r) => r.relationshipId === user.currentRelationshipId
  )
  if (!currentRel || !currentRel.organisationId) return false
  return getServiceRole(currentRel.organisationId, user.sub) === 'admin'
}

module.exports = { merge, get, db, registerMember, getTeamMembers, getServiceRole, isOrgAdmin, softDeleteStaleOrgMemberships, ROLE_STATUS_LABELS }
