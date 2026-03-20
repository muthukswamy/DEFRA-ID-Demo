'use strict'

const express = require('express')
const { requireAuth } = require('../middleware/auth')
const { config } = require('../config')

const router = express.Router()

router.get('/dashboard', requireAuth, (req, res) => {
  const user = req.session.user

  // Resolve the currently selected organisation
  const currentOrg = user.currentRelationshipId && user.relationships
    ? user.relationships.find((r) => r.relationshipId === user.currentRelationshipId) || null
    : null

  // Build relationship rows for GDS table macro (pre-processed for Nunjucks)
  const relationshipRows = (user.relationships || []).map((r) => [
    { text: r.organisationName },
    { text: r.organisationId, classes: 'govuk-!-font-size-16' },
    { text: r.relationship },
    { text: r.organisationLoa }
  ])

  // Build role rows
  const roleRows = (user.roles || []).map((r) => [
    { text: r.roleName },
    { text: r.statusLabel },
    { text: r.relationshipId, classes: 'govuk-!-font-size-16' }
  ])

  res.render('dashboard.njk', {
    activePage: 'dashboard',
    user,
    currentOrg,
    relationshipRows,
    roleRows,
    defraAccountUrl: config.service.accountUrl
  })
})

router.get('/add-organisation', requireAuth, (_req, res) => {
  res.render('add-organisation.njk', { activePage: 'dashboard' })
})

module.exports = router
