/**
 * Photon Context — extends the Ream request context with page rendering.
 *
 * @implements FR91
 */

import type { PhotonRenderer, RenderResult } from './PhotonRenderer.js'

export interface PhotonContext {
  /**
   * Render a page component with props.
   *
   * Usage in a route handler:
   *   ctx.photon.render('Dashboard', { user, stats })
   */
  render(component: string, props?: Record<string, unknown>): Promise<RenderResult>
}

/**
 * Create a Photon context bound to a renderer.
 * Attached to ctx.photon in the middleware.
 */
export function createPhotonContext(renderer: PhotonRenderer, url: string): PhotonContext {
  return {
    async render(component: string, props: Record<string, unknown> = {}): Promise<RenderResult> {
      return renderer.render(component, props, url)
    },
  }
}
