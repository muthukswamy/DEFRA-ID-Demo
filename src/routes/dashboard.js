'use strict'

const { requireAuth } = require('../middleware/auth')
const { config } = require('../config')

module.exports = [
  {
    method: 'GET',
    path: '/dashboard',
    options: {
      pre: [{ method: requireAuth }],
      handler: (request, h) => {
        const user = request.yar.get('user')
        const currentOrg = user.currentRelationshipId && user.relationships
          ? user.relationships.find((r) => r.relationshipId === user.currentRelationshipId) || null
          : null
        return h.view('dashboard.njk', { activePage: 'dashboard', user, currentOrg })
      }
    }
  },

  {
    method: 'GET',
    path: '/account',
    options: {
      pre: [{ method: requireAuth }],
      handler: (request, h) => {
        const user = request.yar.get('user')
        const tokens = request.yar.get('tokens') || {}

        const currentOrg = user.currentRelationshipId && user.relationships
          ? user.relationships.find((r) => r.relationshipId === user.currentRelationshipId) || null
          : null

        const relationshipRows = (user.relationships || []).map((r) => [
          { text: r.organisationName || 'Personal account' },
          { text: r.organisationId || '—', classes: 'govuk-!-font-size-16' },
          { text: r.relationship },
          { text: r.organisationLoa || '—' }
        ])

        const simpleRelationshipRows = (user.relationships || []).map((r) => {
          const isCurrent = r.relationshipId === user.currentRelationshipId
          const name = r.organisationName || 'Personal account'
          return [
            isCurrent
              ? { html: name + ' <strong class="govuk-tag govuk-tag--green govuk-!-margin-left-1">Current</strong>' }
              : { text: name },
            { text: r.relationship }
          ]
        })

        const relMap = Object.fromEntries(
          (user.relationships || []).map((r) => [r.relationshipId, r.organisationName || 'Personal account'])
        )

        const roleRows = (user.roles || []).map((r) => [
          { text: r.roleName },
          { text: r.statusLabel },
          { text: relMap[r.relationshipId] || r.relationshipId }
        ])

        return h.view('account.njk', {
          activePage: 'account',
          user,
          currentOrg,
          relationshipRows,
          simpleRelationshipRows,
          roleRows,
          rawClaims: JSON.stringify(user, null, 2),
          tokenExpiresAt: tokens.expires_at || null,
          hasRefreshToken: !!tokens.refresh_token,
          refreshed: request.query.refreshed || null,
          sessionMaxAge: (() => {
            const h = config.session.maxAge / 3600000
            return h === 1 ? '1 hour' : h % 1 === 0 ? h + ' hours' : (config.session.maxAge / 60000) + ' minutes'
          })()
        })
      }
    }
  },

  {
    method: 'GET',
    path: '/add-organisation',
    options: {
      pre: [{ method: requireAuth }],
      handler: (_request, h) => h.view('add-organisation.njk', { activePage: 'account' })
    }
  }
]
