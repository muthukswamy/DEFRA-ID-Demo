'use strict'

const { requireAuth } = require('../middleware/auth')

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

        const relationshipRows = (user.relationships || []).map((r) => [
          { text: r.organisationName },
          { text: r.organisationId, classes: 'govuk-!-font-size-16' },
          { text: r.relationship },
          { text: r.organisationLoa }
        ])

        const roleRows = (user.roles || []).map((r) => [
          { text: r.roleName },
          { text: r.statusLabel },
          { text: r.relationshipId, classes: 'govuk-!-font-size-16' }
        ])

        return h.view('dashboard.njk', {
          activePage: 'dashboard',
          user,
          currentOrg,
          relationshipRows,
          roleRows
        })
      }
    }
  },

  {
    method: 'GET',
    path: '/add-organisation',
    options: {
      pre: [{ method: requireAuth }],
      handler: (_request, h) => h.view('add-organisation.njk', { activePage: 'dashboard' })
    }
  }
]
