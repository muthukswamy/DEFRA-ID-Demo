'use strict'

const nunjucks = require('nunjucks')
const path = require('path')
const { config } = require('../config')

function configureNunjucks (app) {
  const env = nunjucks.configure(
    [
      path.join(__dirname, '../views'),
      // govuk-frontend macros resolve from this root, e.g. "govuk/components/button/macro.njk"
      path.join(__dirname, '../../node_modules/govuk-frontend/dist')
    ],
    {
      autoescape: true,
      express: app,
      watch: !config.isProduction,
      noCache: !config.isProduction
    }
  )

  // Global template variables
  env.addGlobal('serviceName', config.service.name)
  env.addGlobal('serviceUrl', '/')
  env.addGlobal('phaseBannerTag', config.service.phase)
  env.addGlobal('phaseBannerHtml',
    'This is a new service – your <a class="govuk-link" href="#">feedback</a> will help us to improve it.'
  )
  env.addGlobal('defraAccountUrl', config.service.accountUrl)
  env.addGlobal('enrollOrgUrl', config.service.enrollOrgUrl)

  app.set('view engine', 'njk')

  return env
}

module.exports = { configureNunjucks }
