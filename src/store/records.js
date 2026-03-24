'use strict'

const { randomUUID } = require('crypto')
const { db } = require('./relationships')

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS records (
    id              TEXT    NOT NULL PRIMARY KEY,
    organisation_id TEXT    NOT NULL,
    title           TEXT    NOT NULL,
    description     TEXT,
    body            TEXT,
    created_by      TEXT    NOT NULL,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_records_org ON records(organisation_id);

  CREATE TABLE IF NOT EXISTS record_permissions (
    record_id    TEXT    NOT NULL,
    grantee      TEXT    NOT NULL,
    permission   TEXT    NOT NULL,
    granted_by   TEXT    NOT NULL,
    granted_at   INTEGER NOT NULL,
    PRIMARY KEY (record_id, grantee)
  );

  CREATE INDEX IF NOT EXISTS idx_record_permissions_grantee
    ON record_permissions(grantee);

  CREATE TABLE IF NOT EXISTS record_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    record_id   TEXT    NOT NULL,
    event       TEXT    NOT NULL,
    actor       TEXT,
    target      TEXT,
    detail      TEXT,
    occurred_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_record_history_record
    ON record_history(record_id, occurred_at);
`)

// Migrate any existing __team__ sentinel rows from previous naming
db.exec(`
  UPDATE record_permissions SET grantee = '__org__' WHERE grantee = '__team__';
  UPDATE record_history SET target = '__org__' WHERE target = '__team__';
`)

// Add soft-delete column if not already present
try { db.exec('ALTER TABLE records ADD COLUMN deleted_at INTEGER') } catch (_) {}

// Back-fill __org_admin__ viewer grant for records created before this feature
db.prepare(`
  INSERT OR IGNORE INTO record_permissions (record_id, grantee, permission, granted_by, granted_at)
  SELECT r.id, '__org_admin__', 'viewer', r.created_by, r.created_at
  FROM records r
  WHERE NOT EXISTS (
    SELECT 1 FROM record_permissions rp
    WHERE rp.record_id = r.id AND rp.grantee = '__org_admin__'
  )
`).run()

// ---------------------------------------------------------------------------
// Permission hierarchy
// ---------------------------------------------------------------------------

const PERMISSION_RANK = { owner: 3, editor: 2, viewer: 1 }

function higherPermission (a, b) {
  if (!b) return a
  if (!a) return b
  return PERMISSION_RANK[a] >= PERMISSION_RANK[b] ? a : b
}

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------

const stmtInsertRecord = db.prepare(`
  INSERT INTO records (id, organisation_id, title, description, body, created_by, created_at, updated_at)
  VALUES (@id, @organisation_id, @title, @description, @body, @created_by, @now, @now)
`)

const stmtInsertOwner = db.prepare(`
  INSERT INTO record_permissions (record_id, grantee, permission, granted_by, granted_at)
  VALUES (@record_id, @grantee, 'owner', @granted_by, @now)
`)

const stmtGetRecord = db.prepare('SELECT * FROM records WHERE id = ? AND deleted_at IS NULL')

const stmtGetUserName = db.prepare('SELECT display_name, email FROM users WHERE sub = ?')

const stmtUpdateRecord = db.prepare(`
  UPDATE records SET title = @title, description = @description, body = @body, updated_at = @now
  WHERE id = @id
`)

const stmtSoftDeleteRecord = db.prepare('UPDATE records SET deleted_at = ? WHERE id = ?')

const stmtDirectGrant = db.prepare(
  'SELECT permission FROM record_permissions WHERE record_id = ? AND grantee = ?'
)

const stmtOrgGrant = db.prepare(
  "SELECT permission FROM record_permissions WHERE record_id = ? AND grantee = '__org__'"
)

const stmtAdminGrant = db.prepare(
  "SELECT permission FROM record_permissions WHERE record_id = ? AND grantee = '__org_admin__'"
)

const stmtIsAdminMember = db.prepare(
  "SELECT 1 FROM service_team_members WHERE organisation_id = ? AND sub = ? AND service_role = 'admin' AND deleted_at IS NULL"
)

const stmtInsertAdminGrant = db.prepare(`
  INSERT INTO record_permissions (record_id, grantee, permission, granted_by, granted_at)
  VALUES (@record_id, '__org_admin__', 'viewer', @granted_by, @now)
`)

const stmtActiveMember = db.prepare(
  'SELECT 1 FROM service_team_members WHERE organisation_id = ? AND sub = ? AND deleted_at IS NULL'
)

// UNION: records accessible via direct grant, org grant, or org_admin grant
const stmtRecordsForUser = db.prepare(`
  SELECT r.id, r.title, r.description, r.created_by, r.created_at, r.updated_at,
         rp.permission AS user_permission,
         u.display_name AS owner_name, u.email AS owner_email
  FROM records r
  JOIN record_permissions rp ON rp.record_id = r.id AND rp.grantee = ?
  LEFT JOIN users u ON u.sub = r.created_by
  WHERE r.organisation_id = ?
    AND r.deleted_at IS NULL
  UNION
  SELECT r.id, r.title, r.description, r.created_by, r.created_at, r.updated_at,
         rp.permission AS user_permission,
         u.display_name AS owner_name, u.email AS owner_email
  FROM records r
  JOIN record_permissions rp ON rp.record_id = r.id AND rp.grantee = '__org__'
  LEFT JOIN users u ON u.sub = r.created_by
  WHERE r.organisation_id = ?
    AND r.deleted_at IS NULL
    AND EXISTS (
      SELECT 1 FROM service_team_members
      WHERE organisation_id = ? AND sub = ? AND deleted_at IS NULL
    )
  UNION
  SELECT r.id, r.title, r.description, r.created_by, r.created_at, r.updated_at,
         rp.permission AS user_permission,
         u.display_name AS owner_name, u.email AS owner_email
  FROM records r
  JOIN record_permissions rp ON rp.record_id = r.id AND rp.grantee = '__org_admin__'
  LEFT JOIN users u ON u.sub = r.created_by
  WHERE r.organisation_id = ?
    AND r.deleted_at IS NULL
    AND EXISTS (
      SELECT 1 FROM service_team_members
      WHERE organisation_id = ? AND sub = ? AND deleted_at IS NULL AND service_role = 'admin'
    )
`)

const stmtGetPermissions = db.prepare(`
  SELECT rp.record_id, rp.grantee, rp.permission, rp.granted_by, rp.granted_at,
         u.display_name, u.email
  FROM record_permissions rp
  LEFT JOIN users u ON u.sub = rp.grantee
  WHERE rp.record_id = ?
  ORDER BY rp.granted_at ASC
`)

const stmtUpsertPermission = db.prepare(`
  INSERT INTO record_permissions (record_id, grantee, permission, granted_by, granted_at)
  VALUES (@record_id, @grantee, @permission, @granted_by, @now)
  ON CONFLICT(record_id, grantee) DO UPDATE SET
    permission  = excluded.permission,
    granted_by  = excluded.granted_by,
    granted_at  = excluded.granted_at
`)

const stmtDeletePermission = db.prepare(
  'DELETE FROM record_permissions WHERE record_id = ? AND grantee = ?'
)

// ---------------------------------------------------------------------------
// Audit history
// ---------------------------------------------------------------------------

const stmtInsertHistory = db.prepare(`
  INSERT INTO record_history (record_id, event, actor, target, detail, occurred_at)
  VALUES (@recordId, @event, @actor, @target, @detail, @occurredAt)
`)

function logHistory (recordId, event, actor, target, detail) {
  stmtInsertHistory.run({
    recordId,
    event,
    actor: actor || null,
    target: target || null,
    detail: detail || null,
    occurredAt: Math.floor(Date.now() / 1000)
  })
}

const stmtGetHistory = db.prepare(`
  SELECT h.id, h.event, h.actor, h.target, h.detail, h.occurred_at,
         ua.display_name AS actor_name, ua.email AS actor_email,
         ut.display_name AS target_name, ut.email AS target_email
  FROM record_history h
  LEFT JOIN users ua ON ua.sub = h.actor
  LEFT JOIN users ut ON ut.sub = h.target
  WHERE h.record_id = ?
  ORDER BY h.occurred_at DESC
`)

const stmtGetPermissionHistory = db.prepare(`
  SELECT h.id, h.event, h.actor, h.target, h.detail, h.occurred_at,
         ua.display_name AS actor_name, ua.email AS actor_email,
         ut.display_name AS target_name, ut.email AS target_email
  FROM record_history h
  LEFT JOIN users ua ON ua.sub = h.actor
  LEFT JOIN users ut ON ut.sub = h.target
  WHERE h.record_id = ?
    AND h.event IN ('permission_granted', 'permission_revoked', 'owner_claimed')
  ORDER BY h.occurred_at DESC
`)

// ---------------------------------------------------------------------------
// Orphan claim
// ---------------------------------------------------------------------------

const stmtOrphanedRecords = db.prepare(`
  SELECT rp.record_id, rp.grantee AS former_owner
  FROM record_permissions rp
  JOIN records r ON r.id = rp.record_id
  LEFT JOIN service_team_members stm
    ON stm.sub = rp.grantee
    AND stm.organisation_id = r.organisation_id
    AND stm.deleted_at IS NULL
  WHERE r.organisation_id = ?
    AND r.deleted_at IS NULL
    AND rp.permission = 'owner'
    AND stm.sub IS NULL
`)

const stmtTransferOwner = db.prepare(`
  UPDATE record_permissions
  SET grantee = @newOwner, granted_by = @newOwner, granted_at = @now
  WHERE record_id = @recordId AND grantee = @formerOwner AND permission = 'owner'
`)

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

const txCreateRecord = db.transaction((id, orgId, sub, title, description, body) => {
  const now = Math.floor(Date.now() / 1000)
  stmtInsertRecord.run({ id, organisation_id: orgId, title, description: description || null, body: body || null, created_by: sub, now })
  stmtInsertOwner.run({ record_id: id, grantee: sub, granted_by: sub, now })
  stmtInsertAdminGrant.run({ record_id: id, granted_by: sub, now })
  logHistory(id, 'created', sub, null, null)
})

const txDeleteRecord = db.transaction((id, actorSub) => {
  logHistory(id, 'deleted', actorSub, null, null)
  stmtSoftDeleteRecord.run(Math.floor(Date.now() / 1000), id)
})

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new record. Creator automatically becomes owner.
 * @returns {string} The new record ID.
 */
function createRecord (organisationId, sub, { title, description, body }) {
  const id = randomUUID()
  txCreateRecord(id, organisationId, sub, title, description, body)
  return id
}

/**
 * Get a single record by ID, or null if not found.
 */
function getRecord (id) {
  return stmtGetRecord.get(id) || null
}

/**
 * Get a user's display name by sub, falling back to email then sub.
 */
function getUserName (sub) {
  const row = stmtGetUserName.get(sub)
  return row ? (row.display_name || row.email || sub) : sub
}

/**
 * Update a record's mutable fields.
 */
function updateRecord (id, { title, description, body }, actorSub) {
  const now = Math.floor(Date.now() / 1000)
  stmtUpdateRecord.run({ id, title, description: description || null, body: body || null, now })
  logHistory(id, 'updated', actorSub, null, null)
}

/**
 * Permanently delete a record and all its permissions.
 */
function deleteRecord (id, actorSub) {
  txDeleteRecord(id, actorSub)
}

/**
 * Returns the highest permission the user holds on a record,
 * or null if they have no access.
 * Checks direct grant and team grant (team grant requires active org membership).
 */
function getUserPermission (recordId, sub, organisationId) {
  const direct = stmtDirectGrant.get(recordId, sub)?.permission ?? null
  const isActiveMember = !!stmtActiveMember.get(organisationId, sub)
  const org = isActiveMember ? (stmtOrgGrant.get(recordId)?.permission ?? null) : null
  const isAdmin = !!stmtIsAdminMember.get(organisationId, sub)
  const adminWildcard = isAdmin ? (stmtAdminGrant.get(recordId)?.permission ?? null) : null
  return higherPermission(direct, higherPermission(org, adminWildcard))
}

/**
 * Get all records accessible to a user in an org.
 * Deduplicates (direct + team grants), keeping the highest permission.
 * @returns {Array<{id, title, description, createdBy, createdAt, updatedAt, userPermission}>}
 */
function getRecordsForUser (organisationId, sub) {
  const rows = stmtRecordsForUser.all(sub, organisationId, organisationId, organisationId, sub, organisationId, organisationId, sub)
  const seen = new Map()
  for (const row of rows) {
    const existing = seen.get(row.id)
    if (!existing || PERMISSION_RANK[row.user_permission] > PERMISSION_RANK[existing.user_permission]) {
      seen.set(row.id, row)
    }
  }
  return [...seen.values()]
    .sort((a, b) => b.created_at - a.created_at)
    .map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description || '',
      createdBy: row.created_by,
      ownerName: row.owner_name || row.owner_email || row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      userPermission: row.user_permission
    }))
}

/**
 * Get all permission rows for a record, enriched with user display name/email.
 * The '__team__' grantee row will have null displayName and email.
 */
function getRecordPermissions (recordId) {
  return stmtGetPermissions.all(recordId).map((row) => ({
    grantee: row.grantee,
    permission: row.permission,
    grantedBy: row.granted_by,
    grantedAt: row.granted_at,
    displayName: row.display_name || null,
    email: row.email || null
  }))
}

/**
 * Set (upsert) a permission. Never call with permission = 'owner'.
 */
function setPermission (recordId, grantee, permission, grantedBy) {
  const now = Math.floor(Date.now() / 1000)
  stmtUpsertPermission.run({ record_id: recordId, grantee, permission, granted_by: grantedBy, now })
  logHistory(recordId, 'permission_granted', grantedBy, grantee, permission)
}

/**
 * Revoke a permission. Route layer must guard against revoking the owner row.
 */
function revokePermission (recordId, grantee, actorSub) {
  const current = stmtDirectGrant.get(recordId, grantee)
  stmtDeletePermission.run(recordId, grantee)
  logHistory(recordId, 'permission_revoked', actorSub, grantee, current ? current.permission : null)
}

/**
 * Transfer ownership of all orphaned records in an org to the signing-in admin.
 * A record is orphaned when its owner is no longer an active member of the org.
 * Called every time an admin signs in — no-op when nothing is orphaned.
 */
function claimOrphanedRecords (orgId, adminSub) {
  const orphaned = stmtOrphanedRecords.all(orgId)
  if (!orphaned.length) return
  const now = Math.floor(Date.now() / 1000)
  for (const row of orphaned) {
    stmtTransferOwner.run({
      recordId: row.record_id,
      formerOwner: row.former_owner,
      newOwner: adminSub,
      now
    })
    logHistory(row.record_id, 'owner_claimed', adminSub, row.former_owner, 'orphan_claim')
  }
}

function mapHistoryRow (row) {
  return {
    event: row.event,
    actorName: row.actor_name || row.actor_email || row.actor || '—',
    target: row.target,
    targetName: row.target === '__org__' ? 'Whole organisation'
      : row.target === '__org_admin__' ? 'All org admins'
      : (row.target_name || row.target_email || row.target || '—'),
    detail: row.detail,
    occurredAtFormatted: new Date(row.occurred_at * 1000).toLocaleString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    })
  }
}

/**
 * Get the full audit history for a record (all event types), enriched with display names.
 */
function getRecordHistory (recordId) {
  return stmtGetHistory.all(recordId).map(mapHistoryRow)
}

/**
 * Get permission-related history for a record (granted/revoked/owner_claimed only).
 */
function getPermissionHistory (recordId) {
  return stmtGetPermissionHistory.all(recordId).map(mapHistoryRow)
}

module.exports = {
  PERMISSION_RANK,
  createRecord,
  getRecord,
  getUserName,
  updateRecord,
  deleteRecord,
  getUserPermission,
  getRecordsForUser,
  getRecordPermissions,
  setPermission,
  revokePermission,
  claimOrphanedRecords,
  getRecordHistory,
  getPermissionHistory
}
