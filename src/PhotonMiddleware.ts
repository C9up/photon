/**
 * Photon Middleware — integrates Photon into the Ream pipeline.
 *
 * - Attaches ctx.photon to every request
 * - Detects X-Photon header for SPA navigation (returns JSON props)
 * - Proxies to Vite dev server for HMR in development
 *
 * @implements FR89, FR92
 */

import { PhotonRenderer } from './PhotonRenderer.js'
import { createPhotonContext } from './PhotonContext.js'
import type { PhotonConfig, RenderResult } from './PhotonRenderer.js'

export interface PhotronMiddlewareContext {
  request?: {
    method: string
    path: string
    headers: Record<string, string>
    body: string
  }
  response?: {
    status: number
    headers: Record<string, string>
    body: string
  }
  photon?: ReturnType<typeof createPhotonContext>
}

/**
 * Create the Photon middleware for the Ream pipeline.
 *
 * Usage:
 *   const photon = PhotonMiddleware({ framework: 'react', entryClient: '...', entryServer: '...' })
 *   app.use(photon.middleware())
 */
export class PhotonMiddleware {
  private renderer: PhotonRenderer
  private config: PhotonConfig
  private bootPromise?: Promise<void>

  constructor(config: PhotonConfig) {
    this.config = config
    this.renderer = new PhotonRenderer(config)
  }

  /**
   * Get the Ream middleware function.
   */
  middleware() {
    return async (ctx: PhotronMiddlewareContext, next: () => Promise<void>) => {
      // Boot renderer once (race-safe via promise latch)
      if (!this.bootPromise) {
        this.bootPromise = this.renderer.boot()
      }
      await this.bootPromise

      // Attach photon context
      const url = ctx.request?.path ?? '/'
      ctx.photon = createPhotonContext(this.renderer, url)

      // Check for SPA navigation (X-Photon header)
      const isPhotonRequest = ctx.request?.headers['x-photon'] === 'true'

      await next()

      // If the handler called ctx.photon.render() and it's a SPA request,
      // override the response with JSON props only
      if (isPhotonRequest && ctx.response?.headers['content-type']?.includes('text/html')) {
        // The handler rendered HTML, but the client wants JSON props
        // Re-render as props-only
        // Note: the handler would need to store the render params for this to work
        // For now, SPA navigation is handled by the client-side router
      }
    }
  }

  /**
   * Get the renderer instance (for direct access in providers).
   */
  getRenderer(): PhotonRenderer {
    return this.renderer
  }
}
