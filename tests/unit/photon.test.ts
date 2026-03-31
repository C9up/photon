import { describe, expect, it } from 'vitest'
import { PhotonRenderer } from '../../src/PhotonRenderer.js'
import { PhotonMiddleware } from '../../src/PhotonMiddleware.js'
import { createPhotonContext } from '../../src/PhotonContext.js'
import { PhotonError } from '../../src/errors.js'

describe('photon > PhotonRenderer', () => {
  it('renders HTML with page data', async () => {
    const renderer = new PhotonRenderer({
      framework: 'react',
      entryClient: 'resources/app.tsx',
      entryServer: 'resources/ssr.tsx',
    })

    const result = await renderer.render('Dashboard', { user: 'Kaen' }, '/dashboard')
    expect(result.status).toBe(200)
    expect(result.headers['content-type']).toContain('text/html')
    expect(result.html).toContain('<!DOCTYPE html>')
    expect(result.html).toContain('<div id="app">')
    expect(result.html).toContain('photon-data')
    expect(result.html).toContain('Dashboard')
    expect(result.headers['content-security-policy']).toBeDefined()
  })

  it('escapes HTML entities in page data', async () => {
    const renderer = new PhotonRenderer({
      framework: 'react',
      entryClient: 'app.tsx',
      entryServer: 'ssr.tsx',
    })

    const result = await renderer.render('Page', { html: '<script>alert(1)</script>' }, '/')
    // Page data uses Unicode escapes (not HTML entities) for safe JSON embedding in <script>
    expect(result.html).not.toContain('<script>alert(1)</script>')
    expect(result.html).toContain('\\u003cscript\\u003e')
  })

  it('includes Vite dev server scripts in dev mode', async () => {
    const renderer = new PhotonRenderer({
      framework: 'react',
      entryClient: 'resources/app.tsx',
      entryServer: 'resources/ssr.tsx',
      viteDevUrl: 'http://localhost:5173',
    })

    const result = await renderer.render('Home', {}, '/')
    expect(result.html).toContain('http://localhost:5173/@vite/client')
    expect(result.html).toContain('http://localhost:5173/resources/app.tsx')
  })

  it('renderProps returns JSON for SPA navigation', () => {
    const renderer = new PhotonRenderer({
      framework: 'vue',
      entryClient: 'app.ts',
      entryServer: 'ssr.ts',
    })

    const result = renderer.renderProps('Users', { list: [1, 2, 3] }, '/users')
    expect(result.status).toBe(200)
    expect(result.headers['content-type']).toBe('application/json')
    expect(result.headers['x-photon']).toBe('true')
    const data = JSON.parse(result.html)
    expect(data.component).toBe('Users')
    expect(data.props.list).toEqual([1, 2, 3])
  })

  it('reports framework', () => {
    const renderer = new PhotonRenderer({
      framework: 'svelte',
      entryClient: 'app.ts',
      entryServer: 'ssr.ts',
    })
    expect(renderer.getFramework()).toBe('svelte')
  })
})

describe('photon > PhotonContext', () => {
  it('creates context bound to renderer', async () => {
    const renderer = new PhotonRenderer({
      framework: 'react',
      entryClient: 'app.tsx',
      entryServer: 'ssr.tsx',
    })

    const ctx = createPhotonContext(renderer, '/test')
    const result = await ctx.render('TestPage', { foo: 'bar' })
    expect(result.html).toContain('TestPage')
    expect(result.html).toContain('foo')
  })
})

describe('photon > PhotonMiddleware', () => {
  it('attaches photon context to request', async () => {
    const mw = new PhotonMiddleware({
      framework: 'react',
      entryClient: 'app.tsx',
      entryServer: 'ssr.tsx',
    })

    const ctx: Record<string, unknown> = {
      request: { method: 'GET', path: '/dashboard', headers: {}, body: '' },
      response: { status: 200, headers: {}, body: '' },
    }

    const middleware = mw.middleware()
    await middleware(ctx as any, async () => {
      // After middleware runs, ctx.photon should be available
      expect(ctx.photon).toBeDefined()
    })
  })

  it('detects X-Photon header', async () => {
    const mw = new PhotonMiddleware({
      framework: 'react',
      entryClient: 'app.tsx',
      entryServer: 'ssr.tsx',
    })

    const ctx: Record<string, unknown> = {
      request: { method: 'GET', path: '/', headers: { 'x-photon': 'true' }, body: '' },
      response: { status: 200, headers: {}, body: '' },
    }

    const middleware = mw.middleware()
    await middleware(ctx as any, async () => {})
    // Middleware completes without error
  })
})

describe('photon > PhotonError', () => {
  it('creates error with PHOTON_ prefix', () => {
    const err = new PhotonError('SSR_FAILED', 'Render failed')
    expect(err.code).toBe('PHOTON_SSR_FAILED')
    expect(err.name).toBe('PhotonError')
    expect(err.message).toBe('Render failed')
  })
})
