const webpack = require('webpack')

// Set the environment in Node so the command also works in Windows shells.
process.env.NODE_ENV = process.argv[2] || 'demo'
webpack(require('../webpack.config.js'), (error, stats) => {
  if (error) {
    console.error(error)
    process.exitCode = 1
    return
  }
  console.log(stats.toString({ colors: process.stdout.isTTY, modules: false, assets: true }))
  if (stats.hasErrors()) process.exitCode = 1
})
