'use strict'

require('dotenv').config()

const Hapi = require('@hapi/hapi')
const Inert = require('@hapi/inert')
const Vision = require('@hapi/vision')
const Yar = require('@hapi/yar')
const { config, getOidcClient } = require('./config')
const { configureViews } = require('./plugins/nunjucks')

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
  // Plugins
  // ---------------------------------------------------------------------------
  await server.register([
    Inert,
    Vision,
    {
      plugin: Yar,
      options: {
        storeBlank: false,
        cookieOptions: {
          password: config.session.secret,
          isSecure: config.isProduction,
          isHttpOnly: true,
          isSameSite: 'Lax',
          ttl: config.session.maxAge
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
      response.source.context = Object.assign(
        { isAuthenticated: !!request.yar.get('tokens'), user: request.yar.get('user') },
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
