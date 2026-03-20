'use strict'

const { generators } = require('openid-client')
const { getOidcClient, config } = require('../config')
const { parseTokenClaims } = require('../middleware/auth')

// ---------------------------------------------------------------------------
// Server-side PKCE store — keyed by state value, auto-expires after 10 minutes.
// Avoids SameSite cookie issues: B2C uses response_mode=form_post (cross-site POST)
// which strips SameSite=Lax cookies. State is always in the POST body per OIDC spec.
// ---------------------------------------------------------------------------
const pkceStore = new Map()

function storePkce (state, data) {
  pkceStore.set(state, { ...data, expiresAt: Date.now() + 10 * 60 * 1000 })
}

function retrievePkce (state) {
  const entry = pkceStore.get(state)
  pkceStore.delete(state) // one-time use — prevent replay
  if (!entry || Date.now() > entry.expiresAt) return null
  return entry
}

async function buildAuthUrl (extraParams = {}) {
  const client = await getOidcClient()
  const code_verifier = generators.codeVerifier()
  const code_challenge = generators.codeChallenge(code_verifier)
  const state = generators.state()
  const nonce = generators.nonce()

  storePkce(state, { code_verifier, nonce })

  const authUrl = client.authorizationUrl({
    scope: config.oidc.scope,
    code_challenge,
    code_challenge_method: 'S256',
    state,
    nonce,
    serviceId: config.oidc.serviceId,
    response_mode: 'form_post',
    ...extraParams
  })

  return authUrl
}

module.exports = [
  /**
   * GET /login
   * Generates PKCE verifier + challenge, stores in server-side Map,
   * then redirects to DEFRA ID (B2C) /authorize endpoint.
   */
  {
    method: 'GET',
    path: '/login',
    handler: async (_request, h) => {
      const extra = {}
      if (config.oidc.aal) extra.aal = config.oidc.aal
      if (config.oidc.forceMFA) extra.forceMFA = config.oidc.forceMFA
      if (config.oidc.forceReselection) extra.forceReselection = config.oidc.forceReselection
      if (config.oidc.relationshipId) extra.relationshipId = config.oidc.relationshipId
      return h.redirect(await buildAuthUrl(extra))
    }
  },

  /**
   * GET /login/switch-org
   * Re-initiates the OIDC flow with forceReselection=true.
   */
  {
    method: 'GET',
    path: '/login/switch-org',
    handler: async (_request, h) => {
      return h.redirect(await buildAuthUrl({ forceReselection: 'true' }))
    }
  },

  /**
   * POST /login/return
   * B2C posts back the authorization code via form_post.
   * request.payload contains the form fields including state and code.
   */
  {
    method: 'POST',
    path: '/login/return',
    options: {
      payload: { parse: true, allow: 'application/x-www-form-urlencoded' }
    },
    handler: async (request, h) => {
      try {
        const client = await getOidcClient()
        const params = request.payload || {}

        if (params.error) {
          console.error('[auth/callback] OIDC error:', params.error, params.error_description)
          return h.view('errors/auth-error.njk')
        }

        const pkce = retrievePkce(params.state)
        if (!pkce) {
          console.warn('[auth/callback] PKCE entry not found for state — expired or replayed')
          return h.view('errors/auth-error.njk').code(400)
        }

        const tokenSet = await client.callback(
          config.oidc.redirectUri,
          params,
          { code_verifier: pkce.code_verifier, state: params.state, nonce: pkce.nonce }
        )

        request.yar.set('tokens', {
          id_token: tokenSet.id_token,
          access_token: tokenSet.access_token,
          refresh_token: tokenSet.refresh_token,
          expires_at: tokenSet.expires_at
        })
        request.yar.set('user', parseTokenClaims(tokenSet))

        const returnTo = request.yar.get('returnTo') || '/dashboard'
        request.yar.clear('returnTo')

        return h.redirect(returnTo)
      } catch (err) {
        console.error('[auth/callback] Token exchange failed:', err.message)
        return h.view('errors/auth-error.njk')
      }
    }
  },

  /**
   * GET /logout
   * Destroys the local session and redirects to the signed-out confirmation page.
   */
  {
    method: 'GET',
    path: '/logout',
    handler: (request, h) => {
      request.yar.reset()
      return h.redirect('/signed-out')
    }
  },

  /**
   * GET /signed-out
   * Post sign-out confirmation page (public).
   */
  {
    method: 'GET',
    path: '/signed-out',
    handler: (_request, h) => h.view('signed-out.njk')
  }
]
