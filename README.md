# @c9up/photon

Frontend rendering engine for the Ream framework. SSR + client hydration for React, Vue, and Svelte.

## Usage

```typescript
import { Ignitor } from '@c9up/ream'
import { PhotonMiddleware } from '@c9up/photon'

const photon = new PhotonMiddleware({
  framework: 'react',
  entryClient: 'resources/app.tsx',
  entryServer: 'resources/ssr.tsx',
})

const app = new Ignitor({ port: 3000 })
  .httpServer()
  .use(photon.middleware())
  .routes((router) => {
    router.get('/dashboard', async (ctx) => {
      const user = await getUser(ctx)
      const result = await ctx.photon.render('Dashboard', { user })
      ctx.response!.status = result.status
      ctx.response!.headers = result.headers
      ctx.response!.body = result.html
    })
  })
```

## Features

- Server-side rendering (SSR) with client hydration
- SPA navigation via `X-Photon` header (JSON props only)
- Vite dev server integration with HMR
- React, Vue, Svelte framework support
- Page data safely escaped in HTML
- Production build with manifest-based asset loading

## License

MIT
