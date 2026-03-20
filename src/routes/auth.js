'use strict'

const { generators } = require('openid-client')
const { getOidcClient, config } = require('../config')
const { parseTokenClaims, enrichUserFromStore, requireAuth } = require('../middleware/auth')

// ---------------------------------------------------------------------------
// Server-side PKCE store — keyed by state value, auto-expires after 10 minutes.
// Avoids SameSite cookie issues: B2C uses response_mode=form_post (cross-site POST)
// which strips SameSite=Lax cookies. State is always in the POST body per OIDC spec.
// ---------------------------------------------------------------------------
const pkceStore = new Map()

// Sweep expired PKCE entries every 5 minutes to prevent memory accumulation
// from abandoned auth flows (user closes B2C window without completing sign-in).
setInterval(() => {
  const now = Date.now()
  for (const [key, value] of pkceStore) {
    if (now > value.expiresAt) pkceStore.delete(key)
  }
}, 5 * 60 * 1000).unref()

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
    handler: async (request, h) => {
      // If already have a valid session, skip OIDC and go straight to dashboard
      const tokens = request.yar.get('tokens')
      if (tokens && tokens.expires_at > Math.floor(Date.now() / 1000)) {
        return h.redirect('/dashboard')
      }

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
          return h.view('errors/auth-error.njk', {
            errorCode: params.error,
            errorDescription: params.error_description
          })
        }

        const pkce = retrievePkce(params.state)
        if (!pkce) {
          console.warn('[auth/callback] PKCE entry not found for state — expired or replayed')
          return h.view('errors/auth-error.njk', {
            errorCode: 'invalid_state',
            errorDescription: 'The sign-in session expired or was already used. Please try again.'
          }).code(400)
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
        request.yar.set('user', enrichUserFromStore(parseTokenClaims(tokenSet)))

        const returnTo = request.yar.get('returnTo') || '/dashboard'
        request.yar.clear('returnTo')

        return h.redirect(returnTo)
      } catch (err) {
        console.error('[auth/callback] Token exchange failed:', err.message)
        return h.view('errors/auth-error.njk', {
          errorCode: 'token_exchange_failed',
          errorDescription: err.message
        })
      }
    }
  },

  /**
   * POST /logout
   * Destroys the local session and renders the signed-out page directly,
   * passing the id_token so the page can offer a "sign out of DEFRA ID" option.
   * POST prevents CSRF — a third-party link cannot trigger sign-out.
   */
  {
    method: 'POST',
    path: '/logout',
    handler: async (request, h) => {
      const tokens = request.yar.get('tokens') || {}
      const idToken = tokens.id_token || null

      let endSessionUrl = null
      try {
        const client = await getOidcClient()
        endSessionUrl = client.issuer.metadata.end_session_endpoint || null
      } catch (_) {}

      request.yar.reset()

      return h.view('signed-out.njk', {
        idToken,
        endSessionUrl,
        postLogoutRedirectUri: config.oidc.postLogoutRedirectUri
      })
    }
  },

  /**
   * GET /signed-out
   * Post sign-out confirmation page (public). Also the B2C post_logout_redirect_uri target.
   */
  {
    method: 'GET',
    path: '/signed-out',
    handler: (_request, h) => h.view('signed-out.njk')
  },

  /**
   * POST /refresh
   * Manually forces a token refresh. Useful for developers testing the silent-refresh flow.
   */
  {
    method: 'POST',
    path: '/refresh',
    options: {
      pre: [{ method: requireAuth }],
      handler: async (request, h) => {
        try {
          const client = await getOidcClient()
          const tokens = request.yar.get('tokens') || {}
          const returnTo = (request.payload && request.payload.returnTo) || '/account'
          if (!tokens.refresh_token) {
            return h.redirect(returnTo + (returnTo.includes('?') ? '&' : '?') + 'refreshed=no-token')
          }
          const tokenSet = await client.refresh(tokens.refresh_token)
          request.yar.set('tokens', {
            id_token: tokenSet.id_token || tokens.id_token,
            access_token: tokenSet.access_token,
            refresh_token: tokenSet.refresh_token || tokens.refresh_token,
            expires_at: tokenSet.expires_at
          })
          request.yar.set('user', enrichUserFromStore(parseTokenClaims(tokenSet)))
          return h.redirect(returnTo + (returnTo.includes('?') ? '&' : '?') + 'refreshed=1')
        } catch (err) {
          console.error('[auth/refresh] Manual refresh failed:', err.message)
          const returnTo = (request.payload && request.payload.returnTo) || '/account'
          return h.redirect(returnTo + (returnTo.includes('?') ? '&' : '?') + 'refreshed=error')
        }
      }
    }
  }
]
