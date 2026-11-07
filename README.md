# B3D Studio

A browser-based 3D creation app with a professional desktop-style workflow, built with React, TypeScript and Babylon.js.
Runs on desktop browsers and on iPad / iPhone / Android (touch-first controls).

> Independent project. Inspired by professional desktop 3D tools; not affiliated with or endorsed by the Blender Foundation.

## V0.1 features

- Interactive 3D viewport: perspective camera, ground grid, coloured X/Y axes, default cube
- Add cube, sphere, cylinder, plane (Blender default sizes, metres, Z up)
- Select by click/tap, in the Outliner, or via context menu — always in sync
- Move / rotate / scale gizmos, plus exact values in the Properties editor (drag a field to scrub, tap to type, simple maths like `2*1.5`)
- Duplicate, delete, hide/reveal, rename, parenting (hierarchy shown in the Outliner)
- Undo / redo (200 steps; a whole field-scrub or gizmo drag is one step)
- Orbit / pan / zoom with mouse, trackpad or touch; preset views (front/right/top…) and frame selected/all
- Context menu (right-click or long-press), Blender-style keyboard shortcuts (press `?` in the app)
- Autosave in the browser, plus export / import of `.b3d.json` project files
- Collapsible, resizable panels on tablet/desktop; bottom-sheet panels on phones
- Timeline with playhead and playback (keyframes arrive with the animation milestone)

## Commands

```bash
npm install
npm run dev          # local dev server
npm run typecheck    # TypeScript
npm test             # unit tests (Vitest)
npm run build        # typecheck + production build -> dist/
node tests/e2e/smoke.mjs http://localhost:4173/ test-results   # browser tests (after `npx vite preview`)
```

## Deploying to Cloudflare Pages (free tier)

`wrangler.toml` is configured for a static Pages project serving `dist/`. Two ways:

1. **Git integration (recommended):** in the Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git, pick this repo, build command `npm run build`, output directory `dist`. Every push to `main` deploys; every PR gets a preview URL.
2. **CLI:** `npx wrangler pages deploy dist --project-name b3d-studio` (needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`).

V0.1 has no server code and makes no paid API calls, so it fits Cloudflare's free tier at $0/month.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and roadmap.
