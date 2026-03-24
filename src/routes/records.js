'use strict'

const { requireAuth } = require('../middleware/auth')
const { getServiceRole, getTeamMembers } = require('../store/relationships')
const {
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
  getRecordHistory,
  getPermissionHistory
} = require('../store/records')

function escapeHtml (str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const PERMISSION_TAG_COLOUR = {
  owner: 'purple',
  editor: 'blue',
  viewer: 'grey'
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getCurrentOrg (user) {
  if (!user || !user.currentRelationshipId) return null
  return (user.relationships || []).find(
    (r) => r.relationshipId === user.currentRelationshipId
  ) || null
}

function formatDate (unixSecs) {
  if (!unixSecs) return '—'
  return new Date(unixSecs * 1000).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric'
  })
}

// ---------------------------------------------------------------------------
// Pre-methods
// ---------------------------------------------------------------------------

async function requireOrgMember (request, h) {
  const user = request.yar.get('user')
  const currentOrg = getCurrentOrg(user)
  if (!currentOrg || !currentOrg.organisationId) {
    return h.view('errors/403.njk', {
      isAuthenticated: true,
      user,
      message: 'You must be a member of an organisation to access records.'
    }).code(403).takeover()
  }
  const role = getServiceRole(currentOrg.organisationId, user.sub)
  if (!role) {
    return h.view('errors/403.njk', {
      isAuthenticated: true,
      user,
      message: 'You are not a member of this organisation.'
    }).code(403).takeover()
  }
  return h.continue
}

// ---------------------------------------------------------------------------
// Shared: resolve record + org + permission for {id} routes
// Returns null and handles response if anything fails.
// ---------------------------------------------------------------------------

// Returns { error: response } on failure, or { user, currentOrg, record, permission } on success.
// Callers: `const resolved = resolveRecord(...); if (resolved.error) return resolved.error`
function resolveRecord (request, h, minPermission) {
  const user = request.yar.get('user')
  const currentOrg = getCurrentOrg(user)
  const record = getRecord(request.params.id)

  if (!record || record.organisation_id !== currentOrg.organisationId) {
    return { error: h.view('errors/404.njk', { isAuthenticated: true, user }).code(404) }
  }

  const permission = getUserPermission(record.id, user.sub, currentOrg.organisationId)
  if (!permission || (minPermission && PERMISSION_RANK[permission] < PERMISSION_RANK[minPermission])) {
    return {
      error: h.view('errors/403.njk', {
        isAuthenticated: true, user,
        message: 'You do not have permission to access this record.'
      }).code(403)
    }
  }

  return { user, currentOrg, record, permission }
}

// ---------------------------------------------------------------------------
// Share page view builder (used by GET and POST /share to avoid duplication)
// ---------------------------------------------------------------------------

function buildShareView (h, record, currentOrg, user, errorMessage) {
  const allPerms = getRecordPermissions(record.id)
  const teamMembers = getTeamMembers(currentOrg.organisationId)

  const orgGrant = allPerms.find((g) => g.grantee === '__org__') || null
  const adminGrant = allPerms.find((g) => g.grantee === '__org_admin__') || null

  const individualGrants = allPerms
    .filter((g) => g.grantee !== '__org__' && g.grantee !== '__org_admin__')
    .map((g) => ({
      ...g,
      redundant: orgGrant
        ? PERMISSION_RANK[orgGrant.permission] >= PERMISSION_RANK[g.permission]
        : false
    }))

  const directGrantees = new Set(individualGrants.map((g) => g.grantee))
  const shareableMembers = teamMembers.filter(
    (m) => m.sub !== user.sub && !directGrantees.has(m.sub)
  )

  return h.view('records/share.njk', {
    activePage: 'records',
    currentOrg,
    record,
    individualGrants,
    orgGrant,
    adminGrant,
    shareableMembers,
    permissionHistory: getPermissionHistory(record.id),
    errorMessage: errorMessage || null
  })
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

module.exports = [

  /**
   * GET /records — list accessible records for current org
   */
  {
    method: 'GET',
    path: '/records',
    options: { pre: [{ method: requireAuth }, { method: requireOrgMember }] },
    handler (request, h) {
      const user = request.yar.get('user')
      const currentOrg = getCurrentOrg(user)
      const deleted = request.query.deleted === '1'

      const records = getRecordsForUser(currentOrg.organisationId, user.sub)
      const recordRows = records.map((r) => [
        { html: `<a href="/records/${r.id}" class="govuk-link">${escapeHtml(r.title)}</a>` },
        { text: r.description ? r.description.substring(0, 80) + (r.description.length > 80 ? '…' : '') : '—' },
        { text: r.ownerName },
        { html: `<strong class="govuk-tag govuk-tag--${PERMISSION_TAG_COLOUR[r.userPermission] || 'grey'}">${r.userPermission}</strong>` },
        { text: formatDate(r.createdAt) },
        {
          html: `<a href="/records/${r.id}" class="govuk-link">View</a>` +
            (PERMISSION_RANK[r.userPermission] >= PERMISSION_RANK.editor
              ? ` &nbsp;<a href="/records/${r.id}/edit" class="govuk-link">Edit</a>`
              : '')
        }
      ])

      return h.view('records/list.njk', {
        activePage: 'records',
        currentOrg,
        recordRows,
        hasRecords: records.length > 0,
        deleted
      })
    }
  },

  /**
   * GET /records/new — create form
   */
  {
    method: 'GET',
    path: '/records/new',
    options: { pre: [{ method: requireAuth }, { method: requireOrgMember }] },
    handler (request, h) {
      const user = request.yar.get('user')
      const currentOrg = getCurrentOrg(user)
      return h.view('records/new.njk', { activePage: 'records', currentOrg })
    }
  },

  /**
   * POST /records — create record
   */
  {
    method: 'POST',
    path: '/records',
    options: {
      pre: [{ method: requireAuth }, { method: requireOrgMember }],
      payload: { parse: true, allow: 'application/x-www-form-urlencoded' }
    },
    handler (request, h) {
      const user = request.yar.get('user')
      const currentOrg = getCurrentOrg(user)
      const { title, description, body } = request.payload

      if (!title || !title.trim()) {
        return h.view('records/new.njk', {
          activePage: 'records',
          currentOrg,
          values: { title, description, body },
          errors: { title: { text: 'Enter a title' } }
        })
      }

      const id = createRecord(currentOrg.organisationId, user.sub, {
        title: title.trim(),
        description: (description || '').trim() || null,
        body: (body || '').trim() || null
      })

      return h.redirect(`/records/${id}`)
    }
  },

  /**
   * GET /records/{id} — view a record
   */
  {
    method: 'GET',
    path: '/records/{id}',
    options: { pre: [{ method: requireAuth }, { method: requireOrgMember }] },
    handler (request, h) {
      const resolved = resolveRecord(request, h, 'viewer')
      if (resolved.error) return resolved.error

      const { user, currentOrg, record, permission } = resolved

      let allPerms = null
      if (permission === 'owner') {
        allPerms = getRecordPermissions(record.id)
      }

      const adminGrant = allPerms ? allPerms.find((g) => g.grantee === '__org_admin__') || null : null
      const sidebarOrgGrant = allPerms ? allPerms.find((g) => g.grantee === '__org__') : null
      const sidebarGrants = allPerms
        ? (sidebarOrgGrant
            ? allPerms.filter((g) =>
                g.grantee === '__org__' ||
                (g.grantee !== '__org_admin__' && PERMISSION_RANK[g.permission] > PERMISSION_RANK[sidebarOrgGrant.permission])
              )
            : allPerms.filter((g) => g.grantee !== '__org_admin__'))
        : null

      return h.view('records/view.njk', {
        activePage: 'records',
        currentOrg,
        record: {
          ...record,
          ownerName: getUserName(record.created_by),
          createdAtFormatted: formatDate(record.created_at),
          updatedAtFormatted: formatDate(record.updated_at)
        },
        userPermission: permission,
        userPermissionColour: PERMISSION_TAG_COLOUR[permission] || 'grey',
        grants: sidebarGrants,
        adminGrant,
        canEdit: PERMISSION_RANK[permission] >= PERMISSION_RANK.editor
      })
    }
  },

  /**
   * GET /records/{id}/edit — edit form
   */
  {
    method: 'GET',
    path: '/records/{id}/edit',
    options: { pre: [{ method: requireAuth }, { method: requireOrgMember }] },
    handler (request, h) {
      const resolved = resolveRecord(request, h, 'editor')
      if (resolved.error) return resolved.error

      const { currentOrg, record, permission } = resolved

      return h.view('records/edit.njk', {
        activePage: 'records',
        currentOrg,
        record,
        userPermission: permission
      })
    }
  },

  /**
   * POST /records/{id}/edit — update record
   */
  {
    method: 'POST',
    path: '/records/{id}/edit',
    options: {
      pre: [{ method: requireAuth }, { method: requireOrgMember }],
      payload: { parse: true, allow: 'application/x-www-form-urlencoded' }
    },
    handler (request, h) {
      const resolved = resolveRecord(request, h, 'editor')
      if (resolved.error) return resolved.error

      const { user, currentOrg, record } = resolved
      const { title, description, body } = request.payload

      if (!title || !title.trim()) {
        return h.view('records/edit.njk', {
          activePage: 'records',
          currentOrg,
          record: { ...record, title, description, body },
          errors: { title: { text: 'Enter a title' } }
        })
      }

      updateRecord(record.id, {
        title: title.trim(),
        description: (description || '').trim() || null,
        body: (body || '').trim() || null
      }, user.sub)

      return h.redirect(`/records/${record.id}`)
    }
  },

  /**
   * GET /records/{id}/share — sharing management (owner only)
   */
  {
    method: 'GET',
    path: '/records/{id}/share',
    options: { pre: [{ method: requireAuth }, { method: requireOrgMember }] },
    handler (request, h) {
      const resolved = resolveRecord(request, h, 'owner')
      if (resolved.error) return resolved.error
      const { user, currentOrg, record } = resolved
      return buildShareView(h, record, currentOrg, user, null)
    }
  },

  /**
   * POST /records/{id}/share — update grants
   */
  {
    method: 'POST',
    path: '/records/{id}/share',
    options: {
      pre: [{ method: requireAuth }, { method: requireOrgMember }],
      payload: { parse: true, allow: 'application/x-www-form-urlencoded' }
    },
    handler (request, h) {
      const resolved = resolveRecord(request, h, 'owner')
      if (resolved.error) return resolved.error

      const { user, currentOrg, record } = resolved
      const { _action, grantee, permission, orgPermission } = request.payload

      if (_action === 'grant' && grantee && permission && permission !== 'owner') {
        // Validate grantee is an active org member
        if (getServiceRole(currentOrg.organisationId, grantee)) {
          setPermission(record.id, grantee, permission, user.sub)
        } else {
          return buildShareView(h, record, currentOrg, user,
            'The selected person is not an active member of this organisation.')
        }
      } else if (_action === 'revoke' && grantee) {
        // Guard: never revoke the owner
        const grants = getRecordPermissions(record.id)
        const target = grants.find((g) => g.grantee === grantee)
        if (target && target.permission !== 'owner') {
          revokePermission(record.id, grantee, user.sub)
        }
      } else if (_action === 'org-grant' && orgPermission && orgPermission !== 'owner') {
        setPermission(record.id, '__org__', orgPermission, user.sub)
      } else if (_action === 'org-revoke') {
        revokePermission(record.id, '__org__', user.sub)
      }

      return h.redirect(`/records/${record.id}/share`)
    }
  },

  /**
   * GET /records/{id}/delete — delete confirmation page (owner only)
   */
  {
    method: 'GET',
    path: '/records/{id}/delete',
    options: { pre: [{ method: requireAuth }, { method: requireOrgMember }] },
    handler (request, h) {
      const resolved = resolveRecord(request, h, 'owner')
      if (resolved.error) return resolved.error
      const { currentOrg, record } = resolved
      return h.view('records/delete-confirm.njk', { activePage: 'records', currentOrg, record })
    }
  },

  /**
   * POST /records/{id}/delete — delete record (owner only)
   */
  {
    method: 'POST',
    path: '/records/{id}/delete',
    options: {
      pre: [{ method: requireAuth }, { method: requireOrgMember }],
      payload: { parse: true, allow: 'application/x-www-form-urlencoded' }
    },
    handler (request, h) {
      const resolved = resolveRecord(request, h, 'owner')
      if (resolved.error) return resolved.error

      const { user, record } = resolved
      deleteRecord(record.id, user.sub)
      return h.redirect('/records?deleted=1')
    }
  },

  /**
   * GET /records/{id}/history — full audit history (owner only)
   */
  {
    method: 'GET',
    path: '/records/{id}/history',
    options: { pre: [{ method: requireAuth }, { method: requireOrgMember }] },
    handler (request, h) {
      const resolved = resolveRecord(request, h, 'owner')
      if (resolved.error) return resolved.error

      const { currentOrg, record } = resolved

      return h.view('records/history.njk', {
        activePage: 'records',
        currentOrg,
        record,
        history: getRecordHistory(record.id)
      })
    }
  }
]
