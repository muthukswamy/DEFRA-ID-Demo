'use strict'

const nunjucks = require('nunjucks')
const path = require('path')
const { config } = require('../config')

function configureViews (server) {
  const searchPaths = [
    path.join(process.cwd(), 'src/views'),
    path.join(process.cwd(), 'node_modules/govuk-frontend/dist')
  ]

  const env = new nunjucks.Environment(
    new nunjucks.FileSystemLoader(searchPaths, { watch: !config.isProduction }),
    { autoescape: true, throwOnUndefined: false }
  )

  env.addGlobal('serviceName', config.service.name)
  env.addGlobal('serviceUrl', '/')
  env.addGlobal('phaseBannerTag', config.service.phase)
  env.addGlobal('phaseBannerHtml', 'This is a new service – <a class="govuk-link" href="#">give your feedback</a> (opens in new tab).')
  env.addGlobal('defraAccountUrl', config.service.accountUrl)
  env.addGlobal('enrollOrgUrl', config.service.enrollOrgUrl)
  env.addGlobal('govukRebrand', true) // govuk-frontend v6 rebrand

  server.views({
    engines: {
      njk: {
        compile: (src, options) => {
          const template = nunjucks.compile(src, options.environment)
          return (context) => template.render(context)
        }
      }
    },
    relativeTo: process.cwd(),
    path: 'src/views',
    isCached: config.isProduction,
    compileOptions: { environment: env }
  })
}

module.exports = { configureViews }
