'use strict'

const express = require('express')
const session = require('express-session')
const helmet = require('helmet')
const morgan = require('morgan')
const path = require('path')

const { config, getOidcClient } = require('./config')
const { configureNunjucks } = require('./middleware/nunjucks')

const app = express()

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------

// Allow form POSTs to the B2C end_session_endpoint (same origin as discovery URL)
const b2cOrigin = config.oidc.discoveryUrl
  ? new URL(config.oidc.discoveryUrl).origin
  : null

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // govuk-frontend requires inline scripts for progressive enhancement
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        // Allow the signout form to POST to the B2C end_session_endpoint
        formAction: ["'self'", ...(b2cOrigin ? [b2cOrigin] : [])]
      }
    },
    // Allow GOV.UK branding in iframes (e.g. within Azure AD B2C flows)
    frameguard: { action: 'deny' }
  })
)

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
if (!config.isProduction) {
  app.use(morgan('dev'))
} else {
  app.use(morgan('combined'))
}

// ---------------------------------------------------------------------------
// Static assets
// Paths are relative to project root (where npm start is run from), not src/
// ---------------------------------------------------------------------------
app.use(
  '/assets',
  express.static(
    path.join(__dirname, '../node_modules/govuk-frontend/dist/govuk/assets')
  )
)
app.use(
  '/govuk',
  express.static(
    path.join(__dirname, '../node_modules/govuk-frontend/dist/govuk')
  )
)
app.use('/public', express.static(path.join(__dirname, '../public')))

// ---------------------------------------------------------------------------
// Body parsers — express.urlencoded MUST be before auth routes
// because B2C posts the auth code as application/x-www-form-urlencoded
// ---------------------------------------------------------------------------
app.use(express.urlencoded({ extended: false }))
app.use(express.json())

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------
app.use(
  session({
    secret: config.session.secret,
    resave: false,
    saveUninitialized: false,
    name: 'defra.sid',
    cookie: {
      secure: config.isProduction,
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 60 * 60 * 1000 // 1 hour
    }
  })
)

// ---------------------------------------------------------------------------
// Nunjucks templating
// ---------------------------------------------------------------------------
configureNunjucks(app)

// ---------------------------------------------------------------------------
// Global template locals
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  res.locals.isAuthenticated = !!(req.session && req.session.tokens)
  res.locals.user = (req.session && req.session.user) || null
  next()
})

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.use('/', require('./routes/index'))
app.use('/', require('./routes/auth'))
app.use('/', require('./routes/dashboard'))

// ---------------------------------------------------------------------------
// 404 handler
// ---------------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).render('errors/404.njk')
})

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err.message, err.stack)
  res.status(500).render('errors/500.njk')
})

// ---------------------------------------------------------------------------
// Start server — pre-warm OIDC discovery before accepting connections
// ---------------------------------------------------------------------------
getOidcClient()
  .then(() => {
    console.log('[oidc] Discovery completed successfully')
    app.listen(config.port, () => {
      console.log(`[server] Listening on http://localhost:${config.port}`)
    })
  })
  .catch((err) => {
    console.error('[oidc] Failed to initialise OIDC client:', err.message)
    console.error('Check OIDC_DISCOVERY_URL and OIDC_CLIENT_ID in your .env file')
    process.exit(1)
  })

module.exports = app
