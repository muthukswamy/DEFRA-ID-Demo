'use strict'

module.exports = [
  {
    method: 'GET',
    path: '/',
    handler: (_request, h) => h.view('index.njk', { activePage: 'home' })
  }
]
