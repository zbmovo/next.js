/**
 * 开发环境的启动脚本
 * 该脚本文件使用 fork 启动
 *
 * 具体位置在 /workspaces/next.js/packages/next/src/cli/next-dev.ts:274:7
 */

if (performance.getEntriesByName('next-start').length === 0) {
  performance.mark('next-start')
}
import '../next'
import '../require-hook'

import type { IncomingMessage, ServerResponse } from 'http'
import type { SelfSignedCertificate } from '../../lib/mkcert'
import type { WorkerRequestHandler, WorkerUpgradeHandler } from './types'

import fs from 'fs'
import v8 from 'v8'
import path from 'path'
import http from 'http'
import https from 'https'
import os from 'os'
import Watchpack from 'watchpack'
import * as Log from '../../build/output/log'
import setupDebug from 'next/dist/compiled/debug'
import { RESTART_EXIT_CODE, checkNodeDebugType, getDebugPort } from './utils'
import { formatHostname } from './format-hostname'
import { initialize } from './router-server'
import { CONFIG_FILES } from '../../shared/lib/constants'
import { getStartServerInfo, logStartInfo } from './app-info-log'
import { validateTurboNextConfig } from '../../lib/turbopack-warning'
import { type Span, trace, flushAllTraces } from '../../trace'
import { isPostpone } from './router-utils/is-postpone'

const debug = setupDebug('next:start-server')
let startServerSpan: Span | undefined

export interface StartServerOptions {
  dir: string
  port: number
  isDev: boolean
  hostname: string
  allowRetry?: boolean
  customServer?: boolean
  minimalMode?: boolean
  keepAliveTimeout?: number
  // this is dev-server only
  selfSignedCertificate?: SelfSignedCertificate
  isExperimentalTestProxy?: boolean
}

export async function getRequestHandlers({
  dir,
  port,
  isDev,
  server,
  hostname,
  minimalMode,
  isNodeDebugging,
  keepAliveTimeout,
  experimentalTestProxy,
  experimentalHttpsServer,
}: {
  dir: string
  port: number
  isDev: boolean
  server?: import('http').Server
  hostname: string
  minimalMode?: boolean
  isNodeDebugging?: boolean
  keepAliveTimeout?: number
  experimentalTestProxy?: boolean
  experimentalHttpsServer?: boolean
}): ReturnType<typeof initialize> {
  return initialize({
    dir,
    port,
    hostname,
    dev: isDev,
    minimalMode,
    server,
    isNodeDebugging: isNodeDebugging || false,
    keepAliveTimeout,
    experimentalTestProxy,
    experimentalHttpsServer,
    startServerSpan,
  })
}
/**
 * 启动服务
 * 本质上就是用Node做一个简易服务器
 */
export async function startServer(
  serverOptions: StartServerOptions
): Promise<void> {
  const {
    dir,
    isDev,
    hostname,
    minimalMode,
    allowRetry,
    keepAliveTimeout,
    isExperimentalTestProxy,
    selfSignedCertificate,
  } = serverOptions
  let { port } = serverOptions

  process.title = 'next-server'
  let handlersReady = () => {}
  let handlersError = () => {}

  let handlersPromise: Promise<void> | undefined = new Promise<void>(
    (resolve, reject) => {
      handlersReady = resolve
      handlersError = reject
    }
  )

  /**
   * 下边引用了这个处理函数
   * 但是别被这个函数迷惑了、这个函数只是一个保底
   * 当服务启动后、会监听 listening 事件、该函数会在该事件中被重新赋值
   *
   * 具体请跳转到 FLAG = 1702387016039
   */
  let requestHandler: WorkerRequestHandler = async (
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> => {
    if (handlersPromise) {
      await handlersPromise
      return requestHandler(req, res)
    }
    throw new Error('Invariant request handler was not setup')
  }
  let upgradeHandler: WorkerUpgradeHandler = async (
    req,
    socket,
    head
  ): Promise<void> => {
    if (handlersPromise) {
      await handlersPromise
      return upgradeHandler(req, socket, head)
    }
    throw new Error('Invariant upgrade handler was not setup')
  }

  // setup server listener as fast as possible
  if (selfSignedCertificate && !isDev) {
    throw new Error(
      'Using a self signed certificate is only supported with `next dev`.'
    )
  }

  /**
   * FLAG 1702387120212
   * http?s 服务器的回调
   */
  async function requestListener(req: IncomingMessage, res: ServerResponse) {
    try {
      if (handlersPromise) {
        await handlersPromise
        handlersPromise = undefined
      }
      await requestHandler(req, res)
    } catch (err) {
      res.statusCode = 500
      res.end('Internal Server Error')
      Log.error(`Failed to handle request for ${req.url}`)
      console.error(err)
    } finally {
      if (isDev) {
        if (
          v8.getHeapStatistics().used_heap_size >
          0.8 * v8.getHeapStatistics().heap_size_limit
        ) {
          Log.warn(
            `Server is approaching the used memory threshold, restarting...`
          )
          trace('server-restart-close-to-memory-threshold', undefined, {
            'memory.heapSizeLimit': String(
              v8.getHeapStatistics().heap_size_limit
            ),
            'memory.heapUsed': String(v8.getHeapStatistics().used_heap_size),
          }).stop()
          await flushAllTraces()
          process.exit(RESTART_EXIT_CODE)
        }
      }
    }
  }

  /**
   * 创建一个服务器
   * 具体创建使用https还是http取决于是否具有证数
   * 不过如果是线上项目、还是推荐启用https访问、Chrome现在默认拦截未包含证书的网站
   *
   * 回调位置 FLAG = 1702387120212
   */
  const server = selfSignedCertificate
    ? https.createServer(
        {
          key: fs.readFileSync(selfSignedCertificate.key),
          cert: fs.readFileSync(selfSignedCertificate.cert),
        },
        requestListener
      )
    : http.createServer(requestListener)

  if (keepAliveTimeout) {
    server.keepAliveTimeout = keepAliveTimeout
  }
  server.on('upgrade', async (req, socket, head) => {
    try {
      await upgradeHandler(req, socket, head)
    } catch (err) {
      socket.destroy()
      Log.error(`Failed to handle request for ${req.url}`)
      console.error(err)
    }
  })

  let portRetryCount = 0

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (
      allowRetry &&
      port &&
      isDev &&
      err.code === 'EADDRINUSE' &&
      portRetryCount < 10
    ) {
      Log.warn(`Port ${port} is in use, trying ${port + 1} instead.`)
      port += 1
      portRetryCount += 1
      server.listen(port, hostname)
    } else {
      Log.error(`Failed to start server`)
      console.error(err)
      process.exit(1)
    }
  })

  const nodeDebugType = checkNodeDebugType()

  /**
   * 服务器在这里启动
   */
  await new Promise<void>((resolve) => {
    server.on('listening', async () => {
      /**
       * 格式化ip地址
       */
      const addr = server.address()
      const actualHostname = formatHostname(
        typeof addr === 'object'
          ? addr?.address || hostname || 'localhost'
          : addr
      )
      const formattedHostname =
        !hostname || actualHostname === '0.0.0.0'
          ? 'localhost'
          : actualHostname === '[::]'
          ? '[::1]'
          : formatHostname(hostname)

      port = typeof addr === 'object' ? addr?.port || port : port

      const networkUrl = hostname ? `http://${actualHostname}:${port}` : null
      const appUrl = `${
        selfSignedCertificate ? 'https' : 'http'
      }://${formattedHostname}:${port}`

      if (nodeDebugType) {
        const debugPort = getDebugPort()
        Log.info(
          `the --${nodeDebugType} option was detected, the Next.js router server should be inspected at port ${debugPort}.`
        )
      }

      // expose the main port to render workers
      process.env.PORT = port + ''

      // Only load env and config in dev to for logging purposes
      let envInfo: string[] | undefined
      let expFeatureInfo: string[] | undefined
      if (isDev) {
        const startServerInfo = await getStartServerInfo(dir)
        envInfo = startServerInfo.envInfo
        expFeatureInfo = startServerInfo.expFeatureInfo
      }
      logStartInfo({
        networkUrl,
        appUrl,
        envInfo,
        expFeatureInfo,
        maxExperimentalFeatures: 3,
      })

      try {
        const cleanup = (code: number | null) => {
          debug('start-server process cleanup')
          server.close()
          process.exit(code ?? 0)
        }
        const exception = (err: Error) => {
          if (isPostpone(err)) {
            // React postpones that are unhandled might end up logged here but they're
            // not really errors. They're just part of rendering.
            return
          }

          // This is the render worker, we keep the process alive
          console.error(err)
        }
        process.on('exit', (code) => cleanup(code))
        if (!process.env.NEXT_MANUAL_SIG_HANDLE) {
          // callback value is signal string, exit with 0
          process.on('SIGINT', () => cleanup(0))
          process.on('SIGTERM', () => cleanup(0))
        }
        process.on('rejectionHandled', () => {
          // It is ok to await a Promise late in Next.js as it allows for better
          // prefetching patterns to avoid waterfalls. We ignore loggining these.
          // We should've already errored in anyway unhandledRejection.
        })
        process.on('uncaughtException', exception)
        process.on('unhandledRejection', exception)

        /**
         * FLAG: 1702387016039
         * 获取处理函数（server的回调函数）
         */
        const initResult = await getRequestHandlers({
          dir,
          port,
          isDev,
          server,
          hostname,
          minimalMode,
          isNodeDebugging: Boolean(nodeDebugType),
          keepAliveTimeout,
          experimentalTestProxy: !!isExperimentalTestProxy,
          experimentalHttpsServer: !!selfSignedCertificate,
        })
        requestHandler = initResult[0]
        upgradeHandler = initResult[1]

        const startServerProcessDuration =
          performance.mark('next-start-end') &&
          performance.measure(
            'next-start-duration',
            'next-start',
            'next-start-end'
          ).duration

        handlersReady()
        const formatDurationText =
          startServerProcessDuration > 2000
            ? `${Math.round(startServerProcessDuration / 100) / 10}s`
            : `${Math.round(startServerProcessDuration)}ms`

        Log.event(`Ready in ${formatDurationText}`)

        if (process.env.TURBOPACK) {
          await validateTurboNextConfig({
            ...serverOptions,
            isDev: true,
          })
        }
      } catch (err) {
        // fatal error if we can't setup
        handlersError()
        console.error(err)
        process.exit(1)
      }

      resolve()
    })

    /**
     * 监听端口
     */
    server.listen(port, hostname)
  })

  if (isDev) {
    function watchConfigFiles(
      dirToWatch: string,
      onChange: (filename: string) => void
    ) {
      const wp = new Watchpack()
      wp.watch({
        files: CONFIG_FILES.map((file) => path.join(dirToWatch, file)),
      })
      wp.on('change', onChange)
    }
    watchConfigFiles(dir, async (filename) => {
      if (process.env.__NEXT_DISABLE_MEMORY_WATCHER) {
        Log.info(
          `Detected change, manual restart required due to '__NEXT_DISABLE_MEMORY_WATCHER' usage`
        )
        return
      }

      Log.warn(
        `Found a change in ${path.basename(
          filename
        )}. Restarting the server to apply the changes...`
      )
      process.exit(RESTART_EXIT_CODE)
    })
  }
}

if (process.env.NEXT_PRIVATE_WORKER && process.send) {
  /**
   * 由于是 fork 启动
   * 在此处使用 process 对象进行进程消息互通
   */
  process.addListener('message', async (msg: any) => {
    if (msg && typeof msg && msg.nextWorkerOptions && process.send) {
      /**
       * 做信息收集，埋点
       */
      startServerSpan = trace('start-dev-server', undefined, {
        cpus: String(os.cpus().length),
        platform: os.platform(),
        'memory.freeMem': String(os.freemem()),
        'memory.totalMem': String(os.totalmem()),
        'memory.heapSizeLimit': String(v8.getHeapStatistics().heap_size_limit),
      })

      await startServerSpan.traceAsyncFn(() =>
        /**
         * 启动脚本
         * 跳转至 91:1
         */
        startServer(msg.nextWorkerOptions)
      )
      const memoryUsage = process.memoryUsage()
      startServerSpan.setAttribute('memory.rss', String(memoryUsage.rss))
      startServerSpan.setAttribute(
        'memory.heapTotal',
        String(memoryUsage.heapTotal)
      )
      startServerSpan.setAttribute(
        'memory.heapUsed',
        String(memoryUsage.heapUsed)
      )
      process.send({ nextServerReady: true })
    }
  })
  process.send({ nextWorkerReady: true })
}
