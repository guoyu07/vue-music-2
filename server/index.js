import fs from 'fs'
import path from 'path'

import Koa from 'koa'
import compress from 'koa-compress'
import onerror from 'koa-onerror'
import logger from 'koa-logger'
import lruCache from 'lru-cache'
import mkdirp from 'mkdirp'
import pug from 'pug'
import re from 'path-to-regexp'
import _debug from 'debug'

import router from './router'
import intercept from './intercept'

import config, {globals, paths} from '../build/config'

const {__DEV__} = globals

const debug = _debug('hi:server')

const template = pug.renderFile(paths.src('index.pug'), {
  pretty: !config.minimize,
  polyfill: !__DEV__
})

const app = new Koa()

onerror(app)

app.use(compress()).use(logger())

router(app)

let renderer
let readyPromise
let mfs

const koaVersion = require('koa/package.json').version
const vueVersion = require('vue-server-renderer/package.json').version

const DEFAULT_HEADERS = {
  'Content-Type': 'text/html',
  Server: `koa/${koaVersion}; vue-server-renderer/${vueVersion}`
}

const STATIC_PATTERN = ['/', '/all']

app.use(async (ctx, next) => {
  await readyPromise

  if (intercept(ctx, {logger: __DEV__ && debug})) {
    await next()
    return
  }

  const {url} = ctx

  ctx.set(DEFAULT_HEADERS)

  let generateStatic, distPath

  if (STATIC_PATTERN.find(pattern => re(pattern).exec(url))) {
    const staticFile = url.split('?')[0].replace(/^\//, '') || 'home'
    const staticPath = `static/${staticFile}.html`
    distPath = paths.dist(staticPath)

    if (mfs.existsSync(distPath)) {
      if (__DEV__) {
        ctx.body = mfs.createReadStream(distPath)
      } else {
        ctx.url = staticPath
        await next()
      }
      return
    }

    generateStatic = true
  }

  const start = Date.now()

  const context = {url, title: 'Vue Music'}

  let html = ''

  const stream = ctx.body = renderer.renderToStream(context)
    .on('error', e => ctx.onerror(e))
    .on('end', () => {
      if (html) {
        try {
          mkdirp.sync(path.dirname(distPath), {fs: mfs})
          mfs.writeFileSync(distPath, html)
          debug(`static html file "${distPath}" is generated!`)
        } catch (e) {
          console.error(e)
        }
      }
      debug(`whole request: ${Date.now() - start}ms`)
    })

  generateStatic && stream.on('data', data => (html += data))
})

// https://github.com/vuejs/vue/blob/dev/packages/vue-server-renderer/README.md#why-use-bundlerenderer
const createRenderer = (bundle, options) => require('vue-server-renderer').createBundleRenderer(bundle, {
  ...options,
  template,
  inject: false,
  cache: lruCache({
    max: 1000,
    maxAge: 1000 * 60 * 15
  }),
  basedir: paths.dist(),
  runInNewContext: false
})

if (__DEV__) {
  readyPromise = require('./dev-tools').default(app, (bundle, {clientManifest, fs}) => {
    mfs = fs
    renderer = createRenderer(bundle, {clientManifest})
  })
} else {
  mfs = fs
  renderer = createRenderer(require(paths.dist('vue-ssr-server-bundle.json')), {
    clientManifest: require(paths.dist('vue-ssr-client-manifest.json'))
  })
  app.use(require('koa-static')('dist'))
}

const {serverHost, serverPort} = config

const args = [serverPort, serverHost]

export default app.listen(...args, err =>
  debug(...err ? [err] : ['Server is now running at %s:%s.', ...args.reverse()]))
