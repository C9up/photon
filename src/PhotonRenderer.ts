/**
 * Photon Renderer — SSR + client hydration for React/Vue/Svelte.
 *
 * @implements FR89, FR90, FR91, FR93
 */

import * as path from 'node:path'
import { PhotonError } from './errors.js'

export type Framework = 'react' | 'vue' | 'svelte'

export interface PhotonConfig {
  /** Frontend framework. */
  framework: Framework
  /** Path to the frontend entry point (e.g., 'resources/app.tsx'). */
  entryClient: string
  /** Path to the SSR entry point (e.g., 'resources/ssr.tsx'). */
  entryServer: string
  /** Build output directory (default: 'public/build'). */
  buildDir?: string
  /** Vite dev server URL (default: 'http://localhost:5173'). */
  viteDevUrl?: string
}

export interface PageProps {
  component: string
  props: Record<string, unknown>
  url: string
}

export interface RenderResult {
  /** The full HTML string to send as response. */
  html: string
  /** HTTP status code (default: 200). */
  status: number
  /** HTTP headers to set. */
  headers: Record<string, string>
}

/**
 * Photon Renderer — handles SSR and page data serialization.
 */
export class PhotonRenderer {
  private config: PhotonConfig
  private ssrModule?: { render: (page: PageProps) => Promise<string> | string }
  private manifest?: Record<string, string[]>
  private isDev: boolean

  constructor(config: PhotonConfig) {
    this.config = config
    this.isDev = process.env.NODE_ENV !== 'production'
  }

  /**
   * Initialize the renderer — load SSR module and manifest.
   */
  async boot(): Promise<void> {
    if (this.isDev) {
      // In dev mode, SSR module is loaded via Vite's ssrLoadModule
      // This is handled by the middleware proxying to Vite
      return
    }

    // Production: load the built SSR module and manifest
    try {
      const buildDir = this.config.buildDir ?? 'public/build'
      // Validate buildDir is within project root
      const absBuildDir = path.resolve(process.cwd(), buildDir)
      if (!absBuildDir.startsWith(process.cwd() + path.sep)) {
        throw new PhotonError('INVALID_CONFIG', 'buildDir must be a subdirectory of the project root')
      }
      this.ssrModule = await import(`${absBuildDir}/ssr/ssr.js`)
      try {
        const manifestRaw = await import(`${process.cwd()}/${buildDir}/manifest.json`, { with: { type: 'json' } })
        this.manifest = manifestRaw.default
      } catch {
        // Manifest is optional — only needed for asset preloading
      }
    } catch (err) {
      throw new PhotonError('SSR_LOAD_FAILED', `Failed to load SSR module: ${err instanceof Error ? err.message : String(err)}`, {
        hint: 'Run `ream build` first to generate the SSR bundle.',
      })
    }
  }

  /**
   * Render a page with SSR.
   *
   * First request: returns full HTML (SSR + hydration script).
   * Subsequent navigation (X-Photon header): returns JSON props only.
   */
  async render(component: string, props: Record<string, unknown> = {}, url: string): Promise<RenderResult> {
    const pageData: PageProps = { component, props, url }

    // SPA-mode: return JSON props for client-side navigation
    // (detected by X-Photon request header, set by the client-side router)

    // SSR mode: render full HTML
    let ssrHtml = ''
    if (this.ssrModule) {
      try {
        ssrHtml = await this.ssrModule.render(pageData)
      } catch (err) {
        // Log the real error internally, give generic message to callers
        throw new PhotonError('SSR_RENDER_FAILED', 'Server-side rendering failed', {
          hint: err instanceof Error ? err.message : String(err),
        })
      }
      // Validate SSR output
      if (typeof ssrHtml !== 'string') {
        throw new PhotonError('SSR_RENDER_FAILED', 'SSR module returned non-string output')
      }
    }

    const pageDataJson = JSON.stringify(pageData)
    const assets = this.getAssets()

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${assets.css.map((href) => `<link rel="stylesheet" href="${escapeAttr(href)}">`).join('\n  ')}
</head>
<body>
  <div id="app">${ssrHtml}</div>
  <script type="application/json" id="photon-data">${escapeScriptJson(pageDataJson)}</script>
  ${assets.js.map((src) => `<script type="module" src="${escapeAttr(src)}"></script>`).join('\n  ')}
</body>
</html>`

    return {
      html,
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'self'; script-src 'self'; object-src 'none'",
      },
    }
  }

  /**
   * Render props-only response for SPA navigation.
   */
  renderProps(component: string, props: Record<string, unknown>, url: string): RenderResult {
    return {
      html: JSON.stringify({ component, props, url }),
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-photon': 'true',
      },
    }
  }

  /**
   * Get the framework adapter name.
   */
  getFramework(): Framework {
    return this.config.framework
  }

  private getAssets(): { css: string[]; js: string[] } {
    if (this.isDev) {
      const viteUrl = this.config.viteDevUrl ?? 'http://localhost:5173'
      return {
        css: [],
        js: [
          `${viteUrl}/@vite/client`,
          `${viteUrl}/${this.config.entryClient}`,
        ],
      }
    }

    // Production: read from manifest
    const buildDir = this.config.buildDir ?? 'public/build'
    if (!this.manifest) {
      return { css: [], js: [`/${buildDir}/client.js`] }
    }

    const css = Object.entries(this.manifest)
      .filter(([key]) => key.endsWith('.css'))
      .map(([, files]) => files)
      .flat()
      .map((f) => `/${buildDir}/${f}`)

    const js = Object.entries(this.manifest)
      .filter(([key]) => key.endsWith('.js') || key.endsWith('.tsx') || key.endsWith('.vue'))
      .map(([, files]) => files)
      .flat()
      .map((f) => `/${buildDir}/${f}`)

    return { css, js }
  }
}

/**
 * Escape JSON for safe embedding in a <script type="application/json"> block.
 * Uses Unicode escapes so JSON.parse() on the client still works.
 */
function escapeScriptJson(json: string): string {
  return json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/** Escape a string for safe use in an HTML attribute. */
function escapeAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
