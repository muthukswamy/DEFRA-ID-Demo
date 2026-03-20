'use strict'

require('dotenv').config()

// Normalise scopes: DEFRA config uses comma-separated, OIDC spec uses space-separated
function normaliseScopes (raw) {
  if (!raw) return ''
  return raw.split(',').map((s) => s.trim()).join(' ')
}

const config = Object.freeze({
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',

  enableAuth: process.env.ENABLE_DEFRA_ID !== 'false',

  session: {
    secret: process.env.SESSION_SECRET || 'dev-session-secret-change-in-production',
    maxAge: 60 * 60 * 1000 // 1 hour in milliseconds (used by Yar cookieOptions.ttl)
  },

  oidc: {
    clientId: process.env.DEFRA_ID_CLIENT_ID,
    clientSecret: process.env.DEFRA_ID_CLIENT_SECRET,
    discoveryUrl: process.env.DEFRA_ID_WELL_KNOWN_URL,
    redirectUri: process.env.DEFRA_ID_REDIRECT_URL || 'http://localhost:3000/login/return',
    postLogoutRedirectUri: process.env.DEFRA_ID_POST_LOGOUT_URL || 'http://localhost:3000/signed-out',
    serviceId: process.env.DEFRA_ID_SERVICE_ID,
    scope: normaliseScopes(process.env.DEFRA_ID_SCOPES) || (() => {
      const id = process.env.DEFRA_ID_CLIENT_ID
      return id ? `openid offline_access ${id}` : 'openid offline_access'
    })(),
    refreshTokens: process.env.DEFRA_ID_REFRESH_TOKENS !== 'false',
    aal: process.env.DEFRA_ID_AAL || undefined,
    forceMFA: process.env.DEFRA_ID_FORCE_MFA || undefined,
    forceReselection: process.env.DEFRA_ID_FORCE_RESELECTION || undefined,
    relationshipId: process.env.DEFRA_ID_RELATIONSHIP_ID || undefined
  },

  service: {
    name: 'DEFRA Mock Service',
    phase: 'BETA',
    accountUrl: process.env.DEFRA_ACCOUNT_URL || '#',
    enrollOrgUrl: process.env.DEFRA_ENROL_ORG_URL ||
      (process.env.DEFRA_ACCOUNT_URL || '').replace(
        /\/management\/.*$/,
        '/management/journey/add-sibling-account/start'
      ) || '#'
  }
})

// Cached OIDC client promise — initialised once on first call
let _oidcClientPromise = null

async function getOidcClient () {
  if (!_oidcClientPromise) {
    _oidcClientPromise = (async () => {
      const { Issuer } = require('openid-client')

      if (!config.oidc.discoveryUrl) {
        throw new Error('DEFRA_ID_WELL_KNOWN_URL is not set')
      }
      if (!config.oidc.clientId) {
        throw new Error('DEFRA_ID_CLIENT_ID is not set')
      }

      const issuer = await Issuer.discover(config.oidc.discoveryUrl)

      return new issuer.Client({
        client_id: config.oidc.clientId,
        client_secret: config.oidc.clientSecret,
        redirect_uris: [config.oidc.redirectUri],
        post_logout_redirect_uris: [config.oidc.postLogoutRedirectUri],
        response_types: ['code'],
        // Azure AD B2C expects credentials in POST body, not Basic auth header
        token_endpoint_auth_method: 'client_secret_post'
      })
    })()
  }
  return _oidcClientPromise
}

// ---------------------------------------------------------------------------
// Startup validation
// ---------------------------------------------------------------------------
if (!config.oidc.clientSecret) {
  throw new Error('DEFRA_ID_CLIENT_SECRET is not set')
}
if (config.isProduction && config.session.secret === 'dev-session-secret-change-in-production') {
  throw new Error('SESSION_SECRET must be changed from the default value in production')
}

module.exports = { config, getOidcClient }
