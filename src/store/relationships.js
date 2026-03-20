'use strict'

const path = require('path')
const Database = require('better-sqlite3')

const db = new Database(path.join(__dirname, '../../data/local.db'))

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
    status_label    TEXT,
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
    (sub, relationship_id, role_name, status, status_label, updated_at)
  VALUES
    (@sub, @relationship_id, @role_name, @status, @status_label, @updated_at)
  ON CONFLICT(sub, relationship_id, role_name) DO UPDATE SET
    status       = excluded.status,
    status_label = excluded.status_label,
    updated_at   = excluded.updated_at
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
      status_label: r.statusLabel,
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
    statusLabel: row.status_label
  }))
  return { relationships, roles }
}

module.exports = { merge, get, db }
