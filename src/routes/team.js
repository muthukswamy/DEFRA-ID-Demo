'use strict'

const { requireAuth } = require('../middleware/auth')
const { getTeamMembers, isOrgAdmin } = require('../store/relationships')
const { config } = require('../config')

const ROLE_LABELS = {
  admin: 'Admin',
  member: 'Member'
}

// ---------------------------------------------------------------------------
// Helper: build a DEFRA ID deep-link for a team member (Employee or Agent)
// ---------------------------------------------------------------------------
function memberManageUrl (member, organisationId) {
  const base = config.service.accountManagementBaseUrl
  if (!base || !member.contactId) return null
  const rel = (member.relationship || '').toLowerCase()
  if (rel === 'employee') return `${base}/accounts/${organisationId}/team/${member.contactId}`
  if (rel === 'agent') return `${base}/accounts/${organisationId}/intermediaries/${member.contactId}`
  return null
}

// ---------------------------------------------------------------------------
// Pre-method: require the user to be an org admin
// ---------------------------------------------------------------------------
async function requireOrgAdmin (request, h) {
  const user = request.yar.get('user')
  if (!isOrgAdmin(user)) {
    return h.view('errors/403.njk', {
      isAuthenticated: true,
      user,
      message: 'You must be an account admin to view team access.'
    }).code(403).takeover()
  }
  return h.continue
}

// ---------------------------------------------------------------------------
// Helper: current org for the session user
// ---------------------------------------------------------------------------
function getCurrentOrg (user) {
  if (!user || !user.currentRelationshipId) return null
  return (user.relationships || []).find(
    (r) => r.relationshipId === user.currentRelationshipId
  ) || null
}

module.exports = [
  /**
   * GET /team
   * Read-only list of team members for the current org. Admin only.
   */
  {
    method: 'GET',
    path: '/team',
    options: {
      pre: [{ method: requireAuth }, { method: requireOrgAdmin }]
    },
    handler (request, h) {
      const user = request.yar.get('user')
      const currentOrg = getCurrentOrg(user)
      if (!currentOrg || !currentOrg.organisationId) {
        return h.redirect('/account')
      }

      const members = getTeamMembers(currentOrg.organisationId)

      const memberRows = members.map((m) => {
        const manageUrl = memberManageUrl(m, currentOrg.organisationId)
        const lastSeen = m.lastSeenAt
          ? new Date(m.lastSeenAt * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
          : '—'
        return [
          { text: m.displayName || '—' },
          { text: m.email || '—' },
          { text: m.relationship || '—' },
          { text: ROLE_LABELS[m.serviceRole] || m.serviceRole },
          { text: lastSeen },
          manageUrl
            ? { html: `<a href="${manageUrl}" class="govuk-link" target="_blank" rel="noopener noreferrer">Manage<span class="govuk-visually-hidden"> ${m.displayName || m.email} in DEFRA account management (opens in new tab)</span></a>` }
            : { text: '—' }
        ]
      })

      const base = config.service.accountManagementBaseUrl
      const orgBase = base ? `${base}/accounts/${currentOrg.organisationId}` : null

      return h.view('team.njk', {
        activePage: 'team',
        currentOrg,
        memberRows,
        memberCount: members.length,
        orgTeamUrl: orgBase ? `${orgBase}/team` : null,
        orgIntermediariesUrl: orgBase ? `${orgBase}/intermediaries` : null
      })
    }
  }
]
