'use strict'

const express = require('express')
const router = express.Router()

router.get('/', (req, res) => {
  res.render('index.njk', {
    activePage: 'home'
  })
})

module.exports = router
