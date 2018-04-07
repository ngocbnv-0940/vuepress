module.exports = async function build (sourceDir, cliOptions = {}) {
  process.env.NODE_ENV = 'production'

  const fs = require('fs')
  const path = require('path')
  const chalk = require('chalk')
  const webpack = require('webpack')
  const { promisify } = require('util')
  const rimraf = promisify(require('rimraf'))
  const mkdirp = promisify(require('mkdirp'))
  const readFile = promisify(fs.readFile)
  const writeFile = promisify(fs.writeFile)

  const prepare = require('./prepare')
  const createClientConfig = require('./webpack/clientConfig')
  const createServerConfig = require('./webpack/serverConfig')
  const { createBundleRenderer } = require('vue-server-renderer')

  const options = await prepare(sourceDir)
  if (cliOptions.outDir) {
    options.outDir = cliOptions.outDir
  }

  const { outDir } = options
  await rimraf(outDir)

  const clientConfig = createClientConfig(options, cliOptions).toConfig()
  const serverConfig = createServerConfig(options, cliOptions).toConfig()

  // compile!
  const stats = await compile([clientConfig, serverConfig])

  const serverBundle = require(path.resolve(outDir, 'manifest/server.json'))
  const clientManifest = require(path.resolve(outDir, 'manifest/client.json'))

  // remove manifests after loading them.
  await rimraf(path.resolve(outDir, 'manifest'))

  // find and remove empty style chunk caused by
  // https://github.com/webpack-contrib/mini-css-extract-plugin/issues/85
  // TODO remove when it's fixed
  await workaroundEmptyStyleChunk()

  // create server renderer using built manifests
  const renderer = createBundleRenderer(serverBundle, {
    clientManifest,
    runInNewContext: false,
    shouldPrefetch: () => false,
    inject: false,
    template: fs.readFileSync(path.resolve(__dirname, 'app/index.ssr.html'), 'utf-8')
  })

  // pre-render head tags from user config
  const userHeadTags = (options.siteConfig.head || [])
    .map(renderHeadTag)
    .join('\n  ')

  // render pages
  await Promise.all(options.siteData.pages.map(renderPage))

  // if the user does not have a custom 404.md, generate the theme's default
  if (!options.siteData.pages.some(p => p.path === '/404.html')) {
    await renderPage({ path: '/404.html' })
  }

  // DONE.
  const relativeDir = path.relative(process.cwd(), outDir)
  console.log(`\n${chalk.green('Success!')} Generated static files in ${chalk.cyan(relativeDir)}.`)

  // --- helpers ---

  function compile (config) {
    return new Promise((resolve, reject) => {
      webpack(config, (err, stats) => {
        if (err) {
          return reject(err)
        }
        if (stats.hasErrors()) {
          stats.toJson().errors.forEach(err => {
            console.error(err)
          })
          reject(new Error(`Failed to compile with errors.`))
          return
        }
        resolve(stats.toJson({ modules: false }))
      })
    })
  }

  function renderHeadTag (t) {
    return `<${t.tag}${renderAttrs(t.attrs)}>${
      t.innerHTML || ''
    }${needsClosing(t.tag) ? `</${t.tag}>` : ``}`
  }

  function needsClosing (tag) {
    return !(tag === 'link' || tag === 'meta')
  }

  function renderAttrs (attrs = {}) {
    const keys = Object.keys(attrs)
    if (keys.length) {
      return ' ' + keys.map(name => `${name}="${attrs[name]}"`).join(' ')
    } else {
      return ''
    }
  }

  async function renderPage (page) {
    const pagePath = page.path
    const pageMeta = renderPageMeta(page.frontmatter && page.frontmatter.meta)

    const context = {
      url: pagePath,
      userHeadTags,
      pageMeta,
      title: 'VuePress',
      lang: 'en'
    }

    let html
    try {
      html = await renderer.renderToString(context)
    } catch (e) {
      console.error(chalk.red(`Error rendering ${pagePath}:`))
      console.error(e.stack)
      return
    }
    const filename = pagePath === '/' ? 'index.html' : pagePath.replace(/^\//, '')
    const filePath = path.resolve(outDir, filename)
    await mkdirp(path.dirname(filePath))
    await writeFile(filePath, html)
  }

  function renderPageMeta (meta) {
    if (!meta) return ''
    return meta.map(m => {
      let res = `<meta`
      Object.keys(m).forEach(key => {
        res += ` ${key}="${m[key]}"`
      })
      return res + `>`
    }).join('')
  }

  async function workaroundEmptyStyleChunk () {
    const styleChunk = stats.children[0].assets.find(a => {
      return /styles\.\w{8}\.js$/.test(a.name)
    })
    const styleChunkPath = path.resolve(outDir, styleChunk.name)
    const styleChunkContent = await readFile(styleChunkPath, 'utf-8')
    await rimraf(styleChunkPath)
    // prepend it to app.js.
    // this is necessary for the webpack runtime to work properly.
    const appChunk = stats.children[0].assets.find(a => {
      return /app\.\w{8}\.js$/.test(a.name)
    })
    const appChunkPath = path.resolve(outDir, appChunk.name)
    const appChunkContent = await readFile(appChunkPath, 'utf-8')
    await writeFile(appChunkPath, styleChunkContent + appChunkContent)
  }
}