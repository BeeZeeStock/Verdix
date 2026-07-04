# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

```bash
npm run dev      # start dev server (Turbopack, localhost:3000)
npm run build    # production build (Turbopack)
npm run start    # serve production build
npm run lint     # run ESLint directly (NOT next lint — that was removed in v16)
```

No test runner is configured.

## Architecture

Next.js **16** App Router. This is a breaking-change release — read `node_modules/next/dist/docs/` before editing. Key differences from earlier versions:

**Turbopack is the default** for both `next dev` and `next build`. Custom `webpack` config in `next.config.ts` will break the build. Use `--webpack` flag to opt out, or migrate to Turbopack-compatible options.

**`params` and `searchParams` are Promises.** Page props are now async:
```tsx
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
}
```

**`next lint` is removed.** Run `eslint` directly (`npm run lint`). `next build` no longer runs linting. The `eslint` option in `next.config.ts` is also removed.

**Runtime config removed.** `serverRuntimeConfig` / `publicRuntimeConfig` and `next/config` are gone. Use `process.env` in Server Components directly, or `NEXT_PUBLIC_` prefix for client-accessible values.

**Caching model.** `fetch` requests are **not cached by default**. To opt into the new Cache Components model, set `cacheComponents: true` in `next.config.ts` and use the `'use cache'` directive. Without this, use `export const dynamic = 'force-static'` on Route Handlers to cache GET responses.

**Instant navigations.** If client-side navigations feel slow, `Suspense` alone is not enough — export `unstable_instant` from the route. See `node_modules/next/dist/docs/01-app/02-guides/instant-navigation.md`.

**AMP is removed.** All `next/amp` imports and `amp` config options are gone.

## Key conventions

- Path alias `@/*` resolves to the repo root (configured in `tsconfig.json`).
- All layouts and pages are Server Components by default. Add `'use client'` only when you need state, event handlers, lifecycle hooks, or browser APIs.
- API endpoints go in `app/api/**/route.ts` — cannot coexist with a `page.ts` in the same segment.
- Colocate non-routable files (components, lib) under `_` prefixed folders (e.g. `app/_components/`) or outside `app/` entirely to keep them out of the routing system.
- Tailwind v4 via `@tailwindcss/postcss` — configuration is CSS-first, not `tailwind.config.js`.
