import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

/** Must match the URI registered for the bundled public Gongfeng application. */
export const OAUTH_REDIRECT_URI = 'http://127.0.0.1:3080/oauth/gongfeng/callback'
const LOGIN_LIFETIME_MS = 10 * 60 * 1000

/** Own the fixed callback port only while a login is pending on a different Host port. */
export class OAuthCallbackListener {
  private server: Server | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private starting: Promise<void> | undefined
  private disposed = false

  constructor(private readonly callback: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>,
    private readonly redirectUri = OAUTH_REDIRECT_URI) {}

  async start(): Promise<void> {
    if (this.disposed) throw new Error('OAuth callback listener has stopped')
    if (this.starting) return await this.starting
    if (this.server?.listening) { this.expire(); return }
    const target = new URL(this.redirectUri)
    const server = createServer((req, res) => {
      if (req.headers.host !== target.host || req.url?.split('?')[0] !== target.pathname) {
        res.writeHead(404); res.end(); return
      }
      void this.callback(req, res).then(async complete => {
        if (complete) await this.close()
      }).catch(() => { if (!res.writableEnded) { res.writeHead(500); res.end() } })
    })
    server.requestTimeout = 30_000
    server.headersTimeout = 10_000
    this.server = server
    this.starting = new Promise<void>((resolve, reject) => {
      server.once('error', error => {
        if (this.server === server) this.server = undefined
        reject(new Error((error as NodeJS.ErrnoException).code === 'EADDRINUSE'
          ? 'OAuth needs callback port 3080. Close the application using that port and try again.'
          : 'Could not start the local OAuth callback listener'))
      })
      server.listen(Number(target.port), '127.0.0.1', () => { this.expire(); resolve() })
    })
    try { await this.starting } finally { this.starting = undefined }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.starting?.catch(() => undefined)
    await this.close(true)
  }

  private expire(): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { void this.close(true) }, LOGIN_LIFETIME_MS)
    this.timer.unref()
  }

  private async close(force = false): Promise<void> {
    clearTimeout(this.timer)
    this.timer = undefined
    const server = this.server
    this.server = undefined
    if (server?.listening) {
      const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      if (force) server.closeAllConnections()
      else server.closeIdleConnections()
      await closed
    }
  }
}
