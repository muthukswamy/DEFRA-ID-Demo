'use strict'

require('dotenv').config()

const Hapi = require('@hapi/hapi')
const Inert = require('@hapi/inert')
const Vision = require('@hapi/vision')
const Yar = require('@hapi/yar')
const { config, getOidcClient } = require('./config')
const { configureViews } = require('./plugins/nunjucks')
const CatboxSqlite = require('./store/session')
const { db: localDb } = require('./store/relationships')

const init = async () => {
  const server = Hapi.server({
    port: config.port,
    host: '0.0.0.0',
    routes: {
      security: {
        hsts: { maxAge: 31536000, includeSubDomains: true },
        xss: 'enabled',
        noOpen: true,
        noSniff: true,
        referrer: false
      }
    }
  })

  // ---------------------------------------------------------------------------
  // Session cache — SQLite (swap provider for @hapi/catbox-redis in production)
  // ---------------------------------------------------------------------------
  await server.cache.provision({
    provider: {
      constructor: CatboxSqlite,
      options: { db: localDb }
    },
    name: 'sqlite-sessions'
  })

  // ---------------------------------------------------------------------------
  // Plugins
  // ---------------------------------------------------------------------------
  await server.register([
    Inert,
    Vision,
    {
      plugin: Yar,
      options: {
        storeBlank: false,
        maxCookieSize: 0, // always server-side; cookie holds session ID only
        cache: {
          cache: 'sqlite-sessions',
          expiresIn: config.session.maxAge
        },
        cookieOptions: {
          password: config.session.secret,
          isSecure: config.isProduction,
          isHttpOnly: true,
          isSameSite: 'Lax'
        }
      }
    }
  ])

  configureViews(server)

  // ---------------------------------------------------------------------------
  // Static assets — govuk-frontend and local public folder
  // ---------------------------------------------------------------------------
  server.route([
    {
      method: 'GET',
      path: '/assets/{param*}',
      handler: {
        directory: { path: 'node_modules/govuk-frontend/dist/govuk/assets' }
      }
    },
    {
      method: 'GET',
      path: '/govuk/{param*}',
      handler: {
        directory: { path: 'node_modules/govuk-frontend/dist/govuk' }
      }
    },
    {
      method: 'GET',
      path: '/public/{param*}',
      handler: {
        directory: { path: 'public' }
      }
    }
  ])

  // ---------------------------------------------------------------------------
  // Routes
  // ---------------------------------------------------------------------------
  server.route([
    ...require('./routes/index'),
    ...require('./routes/auth'),
    ...require('./routes/dashboard')
  ])

  // ---------------------------------------------------------------------------
  // Global response extension — inject template locals and handle errors
  // ---------------------------------------------------------------------------
  server.ext('onPreResponse', (request, h) => {
    const { response } = request

    if (response.isBoom) {
      const statusCode = response.output.statusCode
      const ctx = {
        isAuthenticated: !!request.yar.get('tokens'),
        user: request.yar.get('user')
      }
      if (statusCode === 404) {
        return h.view('errors/404.njk', ctx).code(404)
      }
      console.error('[server] Unhandled error:', response)
      return h.view('errors/500.njk', ctx).code(500)
    }

    // Inject isAuthenticated + user into every view context
    if (response.variety === 'view') {
      const tokens = request.yar.get('tokens')
      const isAuthenticated = !!tokens
      let sessionExpiringSoon = false
      if (isAuthenticated && tokens.expires_at && !tokens.refresh_token) {
        const secsRemaining = tokens.expires_at - Math.floor(Date.now() / 1000)
        sessionExpiringSoon = secsRemaining > 0 && secsRemaining < 600 // within 10 min
      }
      response.source.context = Object.assign(
        { isAuthenticated, user: request.yar.get('user'), sessionExpiringSoon },
        response.source.context
      )
    }

    return h.continue
  })

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------
  await getOidcClient() // pre-warm OIDC discovery before accepting traffic
  await server.start()
  console.log(`Server running on ${server.info.uri}`)
}

init().catch((err) => {
  console.error(err)
  process.exit(1)
})
