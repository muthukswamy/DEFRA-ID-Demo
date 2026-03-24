'use strict'

const { getOidcClient } = require('../config')
const relStore = require('../store/relationships')

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

const AMR_LABELS = {
  one: 'GOV.UK One Login',
  scp: 'Government Gateway',
  cap: 'RPA via CAP API',
  ttp: 'Trusted Third Party'
}

/**
 * Merge token relationships/roles into the SQLite store, then return a user object
 * enriched with the full accumulated set (all orgs seen across sign-ins, not just
 * the current token's scope). Sets `relationshipsFromStore: true` when the stored
 * set is larger than what the current token delivered.
 */
function enrichUserFromStore (user) {
  relStore.merge(user)
  const stored = relStore.get(user.sub)

  // Soft-delete service_team_members rows for orgs no longer in the JWT.
  // Only runs when the JWT is complete (relationships.length >= enrolmentCount).
  const currentOrgIds = (user.relationships || []).map((r) => r.organisationId).filter(Boolean)
  relStore.softDeleteStaleOrgMemberships(user.sub, currentOrgIds, user.enrolmentCount || 0)

  // Register (or re-activate) the user for their current org.
  const currentRel = (stored.relationships || []).find(
    (r) => r.relationshipId === user.currentRelationshipId
  )
  if (currentRel && currentRel.organisationId) {
    relStore.registerMember(currentRel.organisationId, { ...user, ...stored })
  }

  return {
    ...user,
    relationships: stored.relationships,
    roles: stored.roles,
    relationshipsFromStore: stored.relationships.length > user.relationships.length
  }
}

/**
 * Extract and structure all claims from the tokenSet.
 * openid-client's tokenSet.claims() returns verified id_token claims.
 */
function parseTokenClaims (tokenSet) {
  const claims = tokenSet.claims()

  const relationships = parseRelationships(claims.relationships)
  const roles = parseRoles(claims.roles)

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
    roles
  }
}

/**
 * Hapi pre-method: require an authenticated session.
 * Silently refreshes the access token if expired and a refresh token is available.
 * Return h.continue to proceed, or h.redirect('/login').takeover() to redirect.
 */
async function requireAuth (request, h) {
  if (!request.yar.get('tokens')) {
    request.yar.set('returnTo', request.path)
    return h.redirect('/login').takeover()
  }

  const tokens = request.yar.get('tokens')
  const { access_token, refresh_token } = tokens

  if (access_token && isAccessTokenExpired(access_token) && refresh_token) {
    try {
      const client = await getOidcClient()
      const refreshed = await client.refresh(refresh_token)

      request.yar.set('tokens', {
        id_token: refreshed.id_token || tokens.id_token,
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token || refresh_token,
        expires_at: refreshed.expires_at
      })
      request.yar.set('user', enrichUserFromStore(parseTokenClaims(refreshed)))
    } catch (err) {
      console.error('[auth] Token refresh failed:', err.message)
      request.yar.reset()
      return h.redirect('/login').takeover()
    }
  }

  return h.continue
}

module.exports = { requireAuth, parseTokenClaims, enrichUserFromStore, parseRelationships, parseRoles }
