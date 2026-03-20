'use strict'

/**
 * Catbox-compatible SQLite session store.
 *
 * Implements the Catbox client interface so it can be plugged into Hapi's
 * server cache and used by @hapi/yar for server-side session storage.
 *
 * Redis migration: replace this adapter with @hapi/catbox-redis in server.js.
 * The Catbox interface (start/stop/isReady/get/set/drop) maps directly to
 * Redis commands (GET, SET EX, DEL). No other files need to change.
 */
class CatboxSqlite {
  constructor ({ db }) {
    this._db = db
    this._ready = false
    this._timer = null
  }

  async start () {
    this._get = this._db.prepare(
      'SELECT value, stored_at, expires_at FROM sessions WHERE segment = ? AND id = ?'
    )
    this._set = this._db.prepare(`
      INSERT INTO sessions (segment, id, value, stored_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(segment, id) DO UPDATE SET
        value      = excluded.value,
        stored_at  = excluded.stored_at,
        expires_at = excluded.expires_at
    `)
    this._drop = this._db.prepare(
      'DELETE FROM sessions WHERE segment = ? AND id = ?'
    )
    this._purge = this._db.prepare(
      'DELETE FROM sessions WHERE expires_at < ?'
    )

    // Sweep expired sessions every 5 minutes
    this._timer = setInterval(() => {
      this._purge.run(Date.now())
    }, 5 * 60 * 1000).unref()

    this._ready = true
  }

  async stop () {
    clearInterval(this._timer)
    this._ready = false
  }

  isReady () {
    return this._ready
  }

  validateSegmentName (name) {
    if (!name || name.indexOf('\0') !== -1) {
      return new Error('Invalid segment name')
    }
    return null
  }

  async get (key) {
    const row = this._get.get(key.segment, key.id)
    if (!row) return null
    const now = Date.now()
    if (now >= row.expires_at) {
      this._drop.run(key.segment, key.id)
      return null
    }
    return {
      item: JSON.parse(row.value),
      stored: row.stored_at,
      ttl: row.expires_at - now
    }
  }

  async set (key, value, ttl) {
    const now = Date.now()
    this._set.run(key.segment, key.id, JSON.stringify(value), now, now + ttl)
  }

  async drop (key) {
    this._drop.run(key.segment, key.id)
  }
}

module.exports = CatboxSqlite
