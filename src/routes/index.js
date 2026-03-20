'use strict'

const { getOidcClient } = require('../config')

module.exports = [
  {
    method: 'GET',
    path: '/',
    handler: (_request, h) => h.view('index.njk', { activePage: 'home' })
  },
  {
    method: 'GET',
    path: '/health',
    handler: async (_request, h) => {
      let oidcReady = false
      try { await getOidcClient(); oidcReady = true } catch (_) {}
      return h.response({ status: 'ok', oidcReady, uptime: Math.floor(process.uptime()) })
        .type('application/json')
    }
  }
]
