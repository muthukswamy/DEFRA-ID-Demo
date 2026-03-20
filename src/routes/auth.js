'use strict'

const express = require('express')
const { generators } = require('openid-client')
const { getOidcClient, config } = require('../config')
const { parseTokenClaims } = require('../middleware/auth')

const router = express.Router()

// ---------------------------------------------------------------------------
// Server-side PKCE store — keyed by state value, auto-expires after 10 minutes.
// This avoids SameSite cookie issues: B2C uses response_mode=form_post which
// is a cross-site POST, so browsers strip SameSite=Lax cookies. The state
// parameter is always returned by B2C in the POST body (OIDC spec), so we
// can use it as a lookup key without needing any cookies.
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

/**
 * GET /login
 * Generates PKCE verifier + challenge, stores in server-side Map,
 * then redirects to DEFRA ID (B2C) /authorize endpoint.
 */
router.get('/login', async (_req, res, next) => {
  try {
    const client = await getOidcClient()

    const code_verifier = generators.codeVerifier()
    const code_challenge = generators.codeChallenge(code_verifier) // S256 by default
    const state = generators.state()
    const nonce = generators.nonce()

    storePkce(state, { code_verifier, nonce })

    const extraParams = {
      serviceId: config.oidc.serviceId,
      response_mode: 'form_post'
    }
    if (config.oidc.aal) extraParams.aal = config.oidc.aal
    if (config.oidc.forceMFA) extraParams.forceMFA = config.oidc.forceMFA
    if (config.oidc.forceReselection) extraParams.forceReselection = config.oidc.forceReselection
    if (config.oidc.relationshipId) extraParams.relationshipId = config.oidc.relationshipId

    const authUrl = client.authorizationUrl({
      scope: config.oidc.scope,
      code_challenge,
      code_challenge_method: 'S256',
      state,
      nonce,
      ...extraParams
    })

    res.redirect(authUrl)
  } catch (err) {
    next(err)
  }
})

/**
 * GET /login/switch-org
 * Re-initiates the OIDC flow with forceReselection=true, prompting the user
 * to pick a different organisation from their DEFRA ID account.
 */
router.get('/login/switch-org', async (_req, res, next) => {
  try {
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
      forceReselection: 'true'
    })

    res.redirect(authUrl)
  } catch (err) {
    next(err)
  }
})

/**
 * POST /login/return
 * B2C posts back the authorization code via form_post.
 * State is returned in the POST body — use it to retrieve the PKCE verifier.
 */
router.post('/login/return', async (req, res, next) => {
  try {
    const client = await getOidcClient()

    // openid-client reads req.body when req.method === 'POST' (form_post mode)
    const params = client.callbackParams(req)

    // If B2C returned an OIDC error, log it and show a generic error page
    if (params.error) {
      console.error('[auth/callback] OIDC error:', params.error, params.error_description)
      return res.render('errors/auth-error.njk')
    }

    // Retrieve and consume the PKCE entry using the state from the POST body
    const pkce = retrievePkce(params.state)
    if (!pkce) {
      console.warn('[auth/callback] PKCE entry not found for state — expired or replayed')
      return res.status(400).render('errors/auth-error.njk')
    }

    const tokenSet = await client.callback(
      config.oidc.redirectUri,
      params,
      {
        code_verifier: pkce.code_verifier,
        state: params.state,
        nonce: pkce.nonce
      }
    )

    // Store raw tokens server-side in session (never sent to browser)
    req.session.tokens = {
      id_token: tokenSet.id_token,
      access_token: tokenSet.access_token,
      refresh_token: tokenSet.refresh_token,
      expires_at: tokenSet.expires_at
    }

    // Parse and store structured user claims
    req.session.user = parseTokenClaims(tokenSet)

    const returnTo = req.session.returnTo || '/dashboard'
    delete req.session.returnTo

    req.session.save((err) => {
      if (err) return next(err)
      res.redirect(returnTo)
    })
  } catch (err) {
    console.error('[auth/callback] Token exchange failed:', err.message)
    res.render('errors/auth-error.njk')
  }
})

/**
 * GET /logout
 * Destroys the local session and redirects to the signed-out confirmation page.
 */
router.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error('[auth/logout] Session destroy error:', err.message)
    res.redirect('/signed-out')
  })
})

/**
 * GET /signed-out
 * Post sign-out confirmation page (public).
 */
router.get('/signed-out', (_req, res) => {
  res.render('signed-out.njk')
})

module.exports = router
