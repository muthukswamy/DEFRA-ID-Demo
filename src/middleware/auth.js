'use strict'

const { getOidcClient } = require('../config')

/**
 * Decode a JWT payload without verification (claims already validated by openid-client).
 * Used only to read exp for expiry checking.
 */
function decodeJwtPayload (token) {
  try {
    const [, payload] = token.split('.')
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

function isAccessTokenExpired (accessToken) {
  const payload = decodeJwtPayload(accessToken)
  if (!payload || !payload.exp) return true
  // Add a 30-second buffer
  return payload.exp < Math.floor(Date.now() / 1000) + 30
}

/**
 * Parse the relationships[] claim.
 * Format: "relationshipId:organisationId:organisationName:organisationLoa:relationship:relationshipLoa"
 */
function parseRelationships (raw) {
  if (!raw) return []
  const list = Array.isArray(raw) ? raw : [raw]
  return list.map((str) => {
    // Split on ':' but limit to 6 parts to handle org names that may contain colons
    const parts = str.split(':')
    return {
      relationshipId: parts[0] || '',
      organisationId: parts[1] || '',
      organisationName: parts[2] || '',
      organisationLoa: parts[3] || '',
      relationship: parts[4] || '',
      relationshipLoa: parts[5] || ''
    }
  })
}

/**
 * Parse the roles[] claim.
 * Format: "relationshipId:roleName:status"
 */
function parseRoles (raw) {
  if (!raw) return []
  const list = Array.isArray(raw) ? raw : [raw]
  return list.map((str) => {
    const parts = str.split(':')
    return {
      relationshipId: parts[0] || '',
      roleName: parts[1] || '',
      status: parts[2] || ''
    }
  })
}

const ROLE_STATUS_LABELS = {
  1: 'Incomplete',
  2: 'Pending',
  3: 'Active',
  4: 'Rejected',
  5: 'Blocked',
  6: 'Access Removed',
  7: 'Offboarded'
}

const AMR_LABELS = {
  one: 'GOV.UK One Login',
  scp: 'Government Gateway',
  cap: 'RPA via CAP API',
  ttp: 'Trusted Third Party'
}

/**
 * Extract and structure all claims from the tokenSet.
 * openid-client's tokenSet.claims() returns verified id_token claims.
 */
function parseTokenClaims (tokenSet) {
  const claims = tokenSet.claims()

  const relationships = parseRelationships(claims.relationships)
  const roles = parseRoles(claims.roles)

  // Enrich roles with human-readable status label
  const enrichedRoles = roles.map((r) => ({
    ...r,
    statusLabel: ROLE_STATUS_LABELS[parseInt(r.status, 10)] || r.status
  }))

  // Map amr to human-readable labels
  const rawAmr = claims.amr
  const amrList = Array.isArray(rawAmr) ? rawAmr : (rawAmr ? [rawAmr] : [])
  const amrLabels = amrList.map((m) => AMR_LABELS[m] || m)

  return {
    sub: claims.sub,
    email: claims.email,
    firstName: claims.firstName,
    lastName: claims.lastName,
    displayName: `${claims.firstName || ''} ${claims.lastName || ''}`.trim(),
    uniqueReference: claims.uniqueReference,
    contactId: claims.contactId,
    serviceId: claims.serviceId,
    sessionId: claims.sessionId,
    correlationId: claims.correlationId,
    aal: claims.aal,
    loa: claims.loa,
    amr: amrLabels,
    enrolmentCount: claims.enrolmentCount ?? 0,
    enrolmentRequestCount: claims.enrolmentRequestCount ?? 0,
    currentRelationshipId: claims.currentRelationshipId,
    relationships,
    roles: enrichedRoles
  }
}

/**
 * Middleware: require an authenticated session.
 * Silently refreshes the access token if expired and a refresh token is available.
 */
async function requireAuth (req, res, next) {
  if (!req.session.tokens) {
    req.session.returnTo = req.originalUrl
    return req.session.save(() => res.redirect('/login'))
  }

  const { access_token, refresh_token } = req.session.tokens

  if (access_token && isAccessTokenExpired(access_token) && refresh_token) {
    try {
      const client = await getOidcClient()
      const refreshed = await client.refresh(refresh_token)

      req.session.tokens = {
        id_token: refreshed.id_token || req.session.tokens.id_token,
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token || refresh_token,
        expires_at: refreshed.expires_at
      }
      req.session.user = parseTokenClaims(refreshed)

      return req.session.save(() => next())
    } catch (err) {
      console.error('[auth] Token refresh failed:', err.message)
      req.session.destroy(() => {
        res.redirect('/auth/login')
      })
      return
    }
  }

  next()
}

module.exports = { requireAuth, parseTokenClaims, parseRelationships, parseRoles }
